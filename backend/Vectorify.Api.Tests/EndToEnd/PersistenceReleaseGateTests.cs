using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using SixLabors.ImageSharp.PixelFormats;
using Testcontainers.PostgreSql;
using Vectorify.Api.Contracts;
using Vectorify.Api.Data;
using Vectorify.Api.Maintenance;
using Vectorify.Api.Tests.TestSupport;
using Xunit.Sdk;

namespace Vectorify.Api.Tests.EndToEnd;

/// <summary>
/// Release gate de la persistencia de MVP 2.2 (M2.2-S10): recorre por HTTP, con la Web API real contra PostgreSQL
/// real (Testcontainers, nunca InMemory) y storage/registros reales en disco, el criterio de Notion
/// "Create -&gt; Upload -&gt; Vectorize -&gt; Colors/Layers -&gt; Save -&gt; restart -&gt; Open -&gt; Edit -&gt; Autosave -&gt;
/// Version -&gt; Restore sin pérdida de datos".
///
/// El "reinicio" es REAL en lo que importa: se DISPONE el host (factory) y se levanta uno NUEVO sobre la MISMA base
/// y la MISMA raíz de datos en disco (<see cref="PersistenceDataRoot"/>, la disposición de <c>App_Data/</c>) -- los
/// singletons (registries, storage, caches) arrancan vacíos y releen todo del disco/la base, igual que tras un
/// <c>docker compose down</c>/<c>up</c> que conserva los volúmenes. El motor Python NO se levanta después del
/// reinicio (la URL apunta a un puerto cerrado): abrir/editar/autoguardar/restaurar no pueden depender de él.
///
/// Todo se compara contra lo capturado ANTES del reinicio, a nivel de BYTES para el original, el thumbnail y el SVG
/// de cada capa, y de valores para paleta/capas/IDs/dimensiones mm/operaciones/versión actual. Cualquier diferencia
/// falla con un mensaje legible ("cero pérdida silenciosa"). Un test de sensibilidad
/// (<see cref="ReleaseGate_FailsWhenTheRestartedHostLosesItsStorageOrItsDatabase"/>) demuestra que el gate SÍ se pone
/// rojo si la segunda factory apunta a otra carpeta de storage o a otra base: no pasa "por construcción".
/// </summary>
public sealed class PersistenceReleaseGateTests : IAsyncLifetime
{
    private const int ImageWidth = 64;
    private const int ImageHeight = 48;
    private const string DeadPythonUrl = "http://127.0.0.1:1"; // puerto cerrado: tras el reinicio no hay motor

    private static readonly string[] PaletteHexes = ["#ff0000", "#00c800", "#0000ff"];
    private static readonly string[] Operations = ["cut", "engrave", "ignore"];

    private readonly PostgreSqlContainer _postgres = new PostgreSqlBuilder("postgres:17-alpine").Build();
    private readonly List<PersistenceDataRoot> _dataRoots = [];

    public Task InitializeAsync() => _postgres.StartAsync();

    public async Task DisposeAsync()
    {
        foreach (var root in _dataRoots)
        {
            root.Dispose();
        }

        await _postgres.DisposeAsync();
    }

    [Fact]
    public async Task ReleaseGate_FullCycleSurvivesRestartsWithoutSilentDataLoss()
    {
        await RunReleaseGateAsync(sabotage: null);
    }

    [Theory]
    [InlineData("storage")]
    [InlineData("database")]
    public async Task ReleaseGate_FailsWhenTheRestartedHostLosesItsStorageOrItsDatabase(string lost)
    {
        // Si el gate pasara también con un host que perdió el storage o la base, no probaría nada. Acá el
        // segundo host apunta a OTRA raíz de datos ("storage") o a OTRA base ("database"): el gate tiene que
        // ponerse rojo en la comparación posterior al reinicio, con un mensaje que lo diga.
        var failure = await Assert.ThrowsAnyAsync<XunitException>(() => RunReleaseGateAsync(sabotage: lost));
        Assert.Contains("Open tras el reinicio", failure.Message);
        Assert.Contains("PÉRDIDA O CAMBIO SILENCIOSO", failure.Message);
    }

    private async Task RunReleaseGateAsync(string? sabotage)
    {
        var dataRoot = NewDataRoot("release-gate");
        var originalBytes = PersistenceHosts.StripedPng(
            ImageWidth, ImageHeight, new Rgba32(255, 0, 0), new Rgba32(0, 200, 0), new Rgba32(0, 0, 255));

        // ===== Host 1: Create -> Upload -> Vectorize -> Colors/Layers -> mm -> operaciones -> Save =====
        ClassicIds ids;
        Snapshot before;
        await using (var python = await StartPythonAsync())
        await using (var host1 = PersistenceHosts.Create(_postgres.GetConnectionString(), python.BaseUrl, dataRoot))
        {
            var client = host1.CreateClient();
            ids = await RunClassicFlowAsync(client, originalBytes);

            var save = await client.PostAsJsonAsync("/api/v2/workspaces/save", SaveRequest(ids, null, "Release gate", idempotencyKey: "gate-first"));
            Assert.Equal(HttpStatusCode.Created, save.StatusCode); // el primer Save crea el Project
            var saved = (await save.Content.ReadFromJsonAsync<VectorDocumentSaveResponse>())!;
            ids = ids with { ProjectId = saved.ProjectId };
            Assert.Equal(1, saved.VersionNumber);

            before = await CaptureAsync("antes del reinicio", host1, client, ids);
            AssertSnapshotIsCompleteAndSelfConsistent(before, originalBytes);
        }

        // ===== Host 2 ("docker compose down" + "up" conservando volúmenes): Open -> Edit -> Autosave -> Versions -> Restore =====
        var secondRoot = sabotage == "storage" ? NewDataRoot("release-gate-lost-storage") : dataRoot;
        var secondConnection = sabotage == "database" ? ConnectionStringFor("vectorify_lost_" + Guid.NewGuid().ToString("n")) : _postgres.GetConnectionString();

        Snapshot expectedAfterRestore;
        await using (var host2 = PersistenceHosts.Create(secondConnection, DeadPythonUrl, secondRoot))
        {
            var client = host2.CreateClient();

            // Open: el documento, cada SVG, el original, el thumbnail y el listado son los mismos bytes/valores.
            var reopened = await CaptureAsync("después del reinicio", host2, client, ids);
            AssertEquivalent("Open tras el reinicio", before, reopened, sameAssetIds: true);

            // La paleta del flujo clásico (sidecar JSON en disco) también sobrevive: sin ella no se puede autoguardar.
            var classicPalette = await GetClassicPaletteAsync(client, ids);
            Assert.Equal(PaletteHexes, classicPalette.Groups.Select(g => g.ColorHex).ToArray());
            Assert.True(classicPalette.IsConfirmed, "La paleta confirmada dejó de estar confirmada tras el reinicio");

            // Edit: PATCH de capa (rename/visible/lock/operación/orden). Cada PATCH es un checkpoint (versión nueva).
            var layers = reopened.Layers;
            var patch1 = await client.PatchAsJsonAsync(
                $"/api/v2/projects/{ids.ProjectId}/layers/{layers[0].Id}",
                new UpdateLayerRequest("Contorno exterior", 5, false, true, "engrave"));
            Assert.Equal(HttpStatusCode.OK, patch1.StatusCode);
            var patch2 = await client.PatchAsJsonAsync(
                $"/api/v2/projects/{ids.ProjectId}/layers/{layers[1].Id}",
                new UpdateLayerRequest(null, null, null, null, "ignore"));
            Assert.Equal(HttpStatusCode.OK, patch2.StatusCode);

            var expectedAfterEdits = before with
            {
                VersionNumber = 3,
                CurrentVersionNumber = 3,
                Layers =
                [
                    before.Layers[1] with { Operation = "ignore" },
                    before.Layers[2],
                    before.Layers[0] with { Name = "Contorno exterior", Order = 5, Visible = false, Locked = true, Operation = "engrave" },
                ],
                VersionNumbers = [3, 2, 1],
            };
            var afterEdits = await CaptureAsync("tras editar", host2, client, ids);
            AssertEquivalent("Edit (PATCH de capas)", expectedAfterEdits, afterEdits, sameAssetIds: true);

            // Autosave: Save con idempotencyKey sobre el mismo proyecto -> versión nueva con las ediciones; el replay no duplica.
            var autosaveRequest = SaveRequest(ids, ids.ProjectId, null, idempotencyKey: "gate-autosave");
            var autosave = await client.PostAsJsonAsync("/api/v2/workspaces/save", autosaveRequest);
            Assert.Equal(HttpStatusCode.OK, autosave.StatusCode);
            var autosaved = (await autosave.Content.ReadFromJsonAsync<VectorDocumentSaveResponse>())!;
            Assert.Equal(4, autosaved.VersionNumber);

            var replay = await client.PostAsJsonAsync("/api/v2/workspaces/save", autosaveRequest);
            Assert.Equal(HttpStatusCode.OK, replay.StatusCode);
            var replayed = (await replay.Content.ReadFromJsonAsync<VectorDocumentSaveResponse>())!;
            Assert.Equal(autosaved.VersionNumber, replayed.VersionNumber); // el replay devuelve el mismo resultado
            Assert.Equal(autosaved.ProjectId, replayed.ProjectId);

            // Comportamiento (no es pérdida): PaletteColor.Order refleja el orden de las capas EN EL MOMENTO DE UN SAVE
            // (VectorDocumentService numera los colores al recorrer las capas ordenadas); PATCH/Restore copian la
            // paleta tal cual. Tras reordenar una capa, el autosave renumera Order -- mismos colores y coberturas.
            var expectedAfterAutosave = expectedAfterEdits with
            {
                VersionNumber = 4,
                CurrentVersionNumber = 4,
                VersionNumbers = [4, 3, 2, 1],
                Palette = expectedAfterEdits.Layers
                    .Select((layer, order) => before.Palette.Single(color => color.Hex == layer.ColorHex) with { Order = order })
                    .ToList(),
            };
            var afterAutosave = await CaptureAsync("tras el autosave", host2, client, ids);
            // El Save sube los SVG como Assets NUEVOS (ids distintos, mismos bytes): se compara contenido, no ids de asset.
            AssertEquivalent("Autosave (Save con idempotencyKey + replay)", expectedAfterAutosave, afterAutosave, sameAssetIds: false);

            // Lista de versiones: todas, la más nueva primero, con su origen.
            var versions = (await client.GetFromJsonAsync<List<VectorDocumentVersionSummaryResponse>>($"/api/v2/projects/{ids.ProjectId}/versions"))!;
            Assert.Equal([4, 3, 2, 1], versions.Select(v => v.VersionNumber).ToArray());
            Assert.All(versions, v => Assert.Equal("MANUAL_EDIT", v.Origin));

            // Restore de V1: crea una versión NUEVA (V5) con el contenido de V1; no borra la historia.
            var restore = await client.PostAsync($"/api/v2/projects/{ids.ProjectId}/versions/1/restore", null);
            Assert.Equal(HttpStatusCode.OK, restore.StatusCode);
            var restored = (await restore.Content.ReadFromJsonAsync<VectorDocumentSaveResponse>())!;
            Assert.Equal(5, restored.VersionNumber);

            expectedAfterRestore = before with { VersionNumber = 5, CurrentVersionNumber = 5, VersionNumbers = [5, 4, 3, 2, 1] };
            var afterRestore = await CaptureAsync("tras el restore", host2, client, ids);
            AssertEquivalent("Restore de V1", expectedAfterRestore, afterRestore, sameAssetIds: true);

            // La historia sigue intacta: V1 (la original, sin ediciones) y V3 (con ediciones) se pueden abrir tal cual eran.
            var v1 = await CaptureAsync("V1 histórica", host2, client, ids, version: 1);
            AssertEquivalent("V1 histórica tras el restore", before with { VersionNumbers = expectedAfterRestore.VersionNumbers }, v1, sameAssetIds: true, comparePointerToCurrent: false);
            var v3 = await CaptureAsync("V3 histórica", host2, client, ids, version: 3);
            AssertEquivalent("V3 histórica tras el restore", expectedAfterEdits with { VersionNumbers = expectedAfterRestore.VersionNumbers }, v3, sameAssetIds: true, comparePointerToCurrent: false);

            var versionsAfterRestore = (await client.GetFromJsonAsync<List<VectorDocumentVersionSummaryResponse>>($"/api/v2/projects/{ids.ProjectId}/versions"))!;
            Assert.Equal([5, 4, 3, 2, 1], versionsAfterRestore.Select(v => v.VersionNumber).ToArray());
            Assert.Equal("RESTORE", versionsAfterRestore[0].Origin);
        }

        // ===== Host 3: segundo reinicio -> reabrir de nuevo =====
        await using (var host3 = PersistenceHosts.Create(secondConnection, DeadPythonUrl, secondRoot))
        {
            var client = host3.CreateClient();
            var reopenedAgain = await CaptureAsync("tras el segundo reinicio", host3, client, ids);
            AssertEquivalent("Reabrir tras restore + segundo reinicio", expectedAfterRestore, reopenedAgain, sameAssetIds: true);

            // Y el verificador de consistencia DB<->storage (solo lectura, con checksums) no encuentra nada raro.
            await using var scope = host3.Services.CreateAsyncScope();
            var checker = ActivatorUtilities.CreateInstance<StorageConsistencyChecker>(scope.ServiceProvider);
            var (report, _) = await checker.CheckAsync(new ConsistencyCheckOptions(VerifyChecksums: true), CancellationToken.None);
            Assert.True(
                report.IsConsistent,
                $"El verificador de consistencia encontró problemas: sin archivo={report.AssetsWithoutFile.Count}, huérfanos={report.FilesWithoutAsset.Count}, checksum={report.ChecksumMismatches.Count}");
            Assert.Equal(report.AssetRows, report.AssetFilesInStorage);
        }
    }

    // ---------------------------------------------------------------- flujo clásico (host 1)

    private sealed record ClassicIds(
        Guid ClassicProjectId, Guid ImageId, Guid PaletteId, int PaletteVersion, Guid DimensionId, Guid ProjectId);

    private static Task<FakePythonPreprocessServer> StartPythonAsync() =>
        FakePythonPreprocessServer.StartAsync(
            _ => (200, "{}"),
            respondColorPalette: _ => (200, ColorPalettePayloads.MultiGroupSuccessBody(ImageWidth, ImageHeight, PaletteHexes)),
            // Un SVG DISTINTO por capa: así la comparación byte a byte detecta mezclas/pérdidas de capa.
            respondVectorizeLayers: (_, groupIds) => (200,
                $$"""{"layers": [{{string.Join(",", groupIds.Select((id, index) => VectorizeLayersPayloads.LayerJson(
                    id, LayerSvg(id, index), ImageWidth, ImageHeight)))}}]}"""));

    private static string LayerSvg(string groupId, int index) =>
        $"""<svg xmlns="http://www.w3.org/2000/svg" width="{ImageWidth}" height="{ImageHeight}" viewBox="0 0 {ImageWidth} {ImageHeight}">""" +
        $"""<path d="M{index * 20},0 L{index * 20 + 20},0 L{index * 20 + 20},{ImageHeight} L{index * 20},{ImageHeight} Z" fill="{PaletteHexes[index % PaletteHexes.Length]}"/>""" +
        $"<!-- capa {index} {groupId} --></svg>";

    private static async Task<ClassicIds> RunClassicFlowAsync(HttpClient client, byte[] originalBytes)
    {
        using var content = new MultipartFormDataContent();
        var file = new ByteArrayContent(originalBytes);
        file.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("image/png");
        content.Add(file, "file", "tres-colores.png");
        var uploadResponse = await client.PostAsync("/api/v1/projects", content);
        Assert.Equal(HttpStatusCode.Created, uploadResponse.StatusCode);
        var upload = (await uploadResponse.Content.ReadFromJsonAsync<UploadImageResponse>())!;
        var root = $"/api/v1/projects/{upload.ProjectId}/images/{upload.ImageId}";

        var detect = await client.PostAsJsonAsync($"{root}/color-palette/detect", new ColorPaletteDetectRequest(null, null, null));
        detect.EnsureSuccessStatusCode();
        var palette = (await detect.Content.ReadFromJsonAsync<ColorPaletteResponse>())!;
        Assert.Equal(PaletteHexes.Length, palette.Groups.Count);

        (await client.PostAsync($"{root}/color-palette/{palette.PaletteId}/confirm", null)).EnsureSuccessStatusCode();

        var layersResponse = await client.PostAsync($"{root}/color-palette/{palette.PaletteId}/layers", null);
        layersResponse.EnsureSuccessStatusCode();
        var layerSet = (await layersResponse.Content.ReadFromJsonAsync<VectorLayerSetResponse>())!;
        Assert.Equal(PaletteHexes.Length, layerSet.Layers.Count);

        // Dimensiones físicas (mm) sobre la primera capa vectorizada.
        var dimensionResponse = await client.PostAsJsonAsync(
            $"{root}/dimensions/apply", new DimensionRequest("vector", layerSet.Layers[0].VectorId, 150, null, true));
        dimensionResponse.EnsureSuccessStatusCode();
        var dimension = (await dimensionResponse.Content.ReadFromJsonAsync<DimensionResponse>())!;

        // Operaciones: las TRES presentes (CUT, ENGRAVE, IGNORE), una por capa.
        for (var index = 0; index < layerSet.Layers.Count; index++)
        {
            var operation = await client.PostAsJsonAsync(
                $"{root}/color-palette/{palette.PaletteId}/layers/{layerSet.Layers[index].GroupId}/operation",
                new ManufacturingOperationRequest(Operations[index]));
            operation.EnsureSuccessStatusCode();
        }

        return new ClassicIds(upload.ProjectId, upload.ImageId, palette.PaletteId, palette.Version, dimension.DimensionId, Guid.Empty);
    }

    private static VectorDocumentSaveRequest SaveRequest(ClassicIds ids, Guid? projectId, string? name, string idempotencyKey) =>
        new(projectId, name, ids.ClassicProjectId, ids.ImageId, ids.PaletteId, ids.PaletteVersion, ids.DimensionId, idempotencyKey);

    private static async Task<ColorPaletteResponse> GetClassicPaletteAsync(HttpClient client, ClassicIds ids)
    {
        var response = await client.GetAsync(
            $"/api/v1/projects/{ids.ClassicProjectId}/images/{ids.ImageId}/color-palette/{ids.PaletteId}");
        Assert.True(
            response.StatusCode == HttpStatusCode.OK,
            $"PÉRDIDA O CAMBIO SILENCIOSO: la paleta clásica ya no se puede leer (HTTP {(int)response.StatusCode}) tras el reinicio");
        return (await response.Content.ReadFromJsonAsync<ColorPaletteResponse>())!;
    }

    // ---------------------------------------------------------------- captura y comparación

    private sealed record FileView(int Length, string Sha256)
    {
        public override string ToString() => $"{Length} bytes (sha256 {Sha256[..12]}…)";

        public static FileView Of(byte[] bytes) => new(bytes.Length, Convert.ToHexStringLower(SHA256.HashData(bytes)));
    }

    private sealed record LayerView(
        Guid Id, string Name, int Order, bool Visible, bool Locked, string Operation, string ColorHex,
        double Coverage, bool IsBackground, int PathCount, Guid? SvgAssetId);

    private sealed record PaletteView(string Hex, double Coverage, bool IsBackground, int Order);

    private sealed record Snapshot
    {
        public string Label { get; init; } = string.Empty;
        public bool DocumentFound { get; init; }
        public string Notes { get; init; } = string.Empty;
        public int VersionNumber { get; init; }
        public int? CurrentVersionNumber { get; init; }
        public double WidthMm { get; init; }
        public double HeightMm { get; init; }
        public string ViewBox { get; init; } = string.Empty;
        public int SchemaVersion { get; init; }
        public IReadOnlyList<LayerView> Layers { get; init; } = [];
        public IReadOnlyDictionary<Guid, FileView?> LayerSvgs { get; init; } = new Dictionary<Guid, FileView?>();
        public IReadOnlyList<PaletteView> Palette { get; init; } = [];
        public FileView? Original { get; init; }
        public FileView? Thumbnail { get; init; }
        public string? ListedName { get; init; }
        public int? ListedLayerCount { get; init; }
        public Guid? ListedThumbnailAssetId { get; init; }
        public IReadOnlyList<int> VersionNumbers { get; init; } = [];
        public IReadOnlyList<string> IntegrityProblems { get; init; } = [];
    }

    private static async Task<FileView?> FetchAsync(HttpClient client, string? url)
    {
        if (url is null)
        {
            return null;
        }

        var response = await client.GetAsync(url);
        return response.StatusCode == HttpStatusCode.OK ? FileView.Of(await response.Content.ReadAsByteArrayAsync()) : null;
    }

    private static async Task<Snapshot> CaptureAsync(
        string label, WebApplicationFactory<Program> factory, HttpClient client, ClassicIds ids, int? version = null)
    {
        var projectId = ids.ProjectId;
        var documentUrl = version is null ? $"/api/v2/projects/{projectId}/document" : $"/api/v2/projects/{projectId}/versions/{version}";
        var original = await FetchAsync(client, $"/api/v1/projects/{ids.ClassicProjectId}/images/{ids.ImageId}/original");

        // Listado de Mis Proyectos + thumbnail (best-effort pero descargable).
        var list = (await client.GetFromJsonAsync<ProjectListResponse>("/api/v2/projects"))!;
        var listed = list.Items.FirstOrDefault(item => item.Id == projectId);
        var thumbnail = await FetchAsync(client, listed?.ThumbnailUrl);

        var versionsResponse = await client.GetAsync($"/api/v2/projects/{projectId}/versions");
        var versionNumbers = versionsResponse.StatusCode == HttpStatusCode.OK
            ? (await versionsResponse.Content.ReadFromJsonAsync<List<VectorDocumentVersionSummaryResponse>>())!.Select(v => v.VersionNumber).ToList()
            : [];

        var documentResponse = await client.GetAsync(documentUrl);
        if (documentResponse.StatusCode != HttpStatusCode.OK)
        {
            return new Snapshot
            {
                Label = label, DocumentFound = false, Notes = $"GET {documentUrl} -> HTTP {(int)documentResponse.StatusCode}",
                Original = original, Thumbnail = thumbnail, ListedName = listed?.Name, ListedLayerCount = listed?.LayerCount,
                ListedThumbnailAssetId = listed?.ThumbnailAssetId, VersionNumbers = versionNumbers,
            };
        }

        var document = (await documentResponse.Content.ReadFromJsonAsync<VectorDocumentResponse>())!;
        var layers = document.Layers.Select(l => new LayerView(
            l.Id, l.Name, l.Order, l.Visible, l.Locked, l.ManufacturingOperation, l.ColorHex, l.Coverage,
            l.IsBackground, l.PathCount, l.SvgAssetId)).ToList();

        var svgs = new Dictionary<Guid, FileView?>();
        foreach (var layer in document.Layers)
        {
            svgs[layer.Id] = await FetchAsync(client, layer.SvgUrl);
        }

        // Valores que la API no expone (orden de la paleta, número de la versión "actual" apuntada por el Project)
        // se leen directo de la base; además se contrasta el checksum guardado de cada asset con los bytes servidos.
        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<VectorizationDbContext>();
        var project = await db.Projects.AsNoTracking().Include(p => p.CurrentVersion).FirstOrDefaultAsync(p => p.Id == projectId);
        var versionRow = await db.DocumentVersions.AsNoTracking()
            .Where(v => v.VectorDocument!.ProjectId == projectId && v.VersionNumber == document.VersionNumber)
            .FirstOrDefaultAsync();
        var palette = versionRow is null
            ? []
            : await db.PaletteColors.AsNoTracking().Where(c => c.VersionId == versionRow.Id).OrderBy(c => c.Order)
                .Select(c => new PaletteView(c.Hex, c.Coverage, c.IsBackground, c.Order)).ToListAsync();

        var integrity = new List<string>();
        foreach (var layer in document.Layers.Where(l => l.SvgAssetId is not null))
        {
            var asset = await db.Assets.AsNoTracking().FirstOrDefaultAsync(a => a.Id == layer.SvgAssetId);
            if (asset is not null && svgs[layer.Id] is { } served && !string.Equals(asset.Checksum, served.Sha256, StringComparison.OrdinalIgnoreCase))
            {
                integrity.Add($"el checksum guardado del SVG de «{layer.Name}» ({asset.Checksum[..12]}…) no coincide con los bytes servidos ({served.Sha256[..12]}…)");
            }
        }

        return new Snapshot
        {
            Label = label,
            DocumentFound = true,
            VersionNumber = document.VersionNumber,
            CurrentVersionNumber = project?.CurrentVersion?.VersionNumber,
            WidthMm = document.WidthMm,
            HeightMm = document.HeightMm,
            ViewBox = document.ViewBox,
            SchemaVersion = document.SchemaVersion,
            Layers = layers,
            LayerSvgs = svgs,
            Palette = palette,
            Original = original,
            Thumbnail = thumbnail,
            ListedName = listed?.Name,
            ListedLayerCount = listed?.LayerCount,
            ListedThumbnailAssetId = listed?.ThumbnailAssetId,
            VersionNumbers = versionNumbers,
            IntegrityProblems = integrity,
        };
    }

    /// <summary>Precondiciones del propio snapshot "antes": si esto falla, el escenario no ejercitó lo que debía y comparar no tendría sentido.</summary>
    private static void AssertSnapshotIsCompleteAndSelfConsistent(Snapshot snapshot, byte[] originalBytes)
    {
        Assert.True(snapshot.DocumentFound, snapshot.Notes);
        Assert.Equal(PaletteHexes.Length, snapshot.Layers.Count);
        Assert.Equal(Operations, snapshot.Layers.Select(l => l.Operation).ToArray()); // CUT, ENGRAVE e IGNORE presentes
        Assert.Equal(PaletteHexes, snapshot.Layers.Select(l => l.ColorHex).ToArray());
        Assert.Equal(PaletteHexes, snapshot.Palette.Select(p => p.Hex).ToArray());
        Assert.Equal(150, snapshot.WidthMm); // dimensiones mm aplicadas, no el default 1 px = 1 mm
        Assert.Equal(112.5, snapshot.HeightMm);
        Assert.Equal($"0 0 {ImageWidth} {ImageHeight}", snapshot.ViewBox);
        Assert.Equal(1, snapshot.CurrentVersionNumber);
        Assert.All(snapshot.Layers, l => Assert.NotNull(l.SvgAssetId));
        Assert.All(snapshot.LayerSvgs.Values, svg => Assert.NotNull(svg));
        Assert.Equal(PaletteHexes.Length, snapshot.LayerSvgs.Values.Select(v => v!.Sha256).Distinct().Count()); // SVG distinto por capa
        Assert.Equal(FileView.Of(originalBytes), snapshot.Original); // el original descargable == lo subido
        Assert.NotNull(snapshot.Thumbnail);
        Assert.NotNull(snapshot.ListedThumbnailAssetId);
        Assert.Equal(PaletteHexes.Length, snapshot.ListedLayerCount);
        Assert.Empty(snapshot.IntegrityProblems);
    }

    /// <summary>
    /// Compara punto por punto y, si algo difiere, falla UNA vez con TODAS las diferencias en un mensaje legible.
    /// <paramref name="sameAssetIds"/>: ¿deben coincidir también los ids de Asset? (sí tras reinicio/PATCH/restore, que
    /// reusan los assets; no tras un Save, que sube SVG nuevos con los mismos bytes.)
    /// <paramref name="comparePointerToCurrent"/>: ¿comparar el número de la versión apuntada por el Project? (no, al abrir una versión histórica).
    /// </summary>
    private static void AssertEquivalent(
        string stage, Snapshot expected, Snapshot actual, bool sameAssetIds, bool comparePointerToCurrent = true)
    {
        var diffs = new List<string>();

        void Check<T>(string what, T before, T after)
        {
            if (!EqualityComparer<T>.Default.Equals(before, after))
            {
                diffs.Add($"{what}: antes {Describe(before)}, ahora {Describe(after)}");
            }
        }

        if (!actual.DocumentFound)
        {
            diffs.Add($"el documento no se pudo abrir ({actual.Notes})");
        }
        else
        {
            Check("número de versión", expected.VersionNumber, actual.VersionNumber);
            if (comparePointerToCurrent)
            {
                Check("versión actual del proyecto (Project.CurrentVersionId)", expected.CurrentVersionNumber, actual.CurrentVersionNumber);
            }

            Check("ancho (mm)", expected.WidthMm, actual.WidthMm);
            Check("alto (mm)", expected.HeightMm, actual.HeightMm);
            Check("viewBox", expected.ViewBox, actual.ViewBox);
            Check("schemaVersion", expected.SchemaVersion, actual.SchemaVersion);
            Check("cantidad de capas", expected.Layers.Count, actual.Layers.Count);

            for (var index = 0; index < Math.Min(expected.Layers.Count, actual.Layers.Count); index++)
            {
                var (e, a) = (expected.Layers[index], actual.Layers[index]);
                var where = $"capa #{index} «{e.Name}»";
                Check($"{where} id (groupId)", e.Id, a.Id);
                Check($"{where} nombre", e.Name, a.Name);
                Check($"{where} orden", e.Order, a.Order);
                Check($"{where} visible", e.Visible, a.Visible);
                Check($"{where} bloqueada", e.Locked, a.Locked);
                Check($"{where} operación (CUT/ENGRAVE/IGNORE)", e.Operation, a.Operation);
                Check($"{where} color", e.ColorHex, a.ColorHex);
                Check($"{where} cobertura", e.Coverage, a.Coverage);
                Check($"{where} es fondo", e.IsBackground, a.IsBackground);
                Check($"{where} pathCount", e.PathCount, a.PathCount);
                if (sameAssetIds)
                {
                    Check($"{where} asset del SVG", e.SvgAssetId, a.SvgAssetId);
                }

                Check($"{where} bytes del SVG", expected.LayerSvgs.GetValueOrDefault(e.Id), actual.LayerSvgs.GetValueOrDefault(a.Id));
            }

            Check("paleta (hex/cobertura/fondo/orden)", DescribePalette(expected.Palette), DescribePalette(actual.Palette));
        }

        Check("original (bytes)", expected.Original, actual.Original);
        Check("thumbnail (bytes)", expected.Thumbnail, actual.Thumbnail);
        Check("listado «Mis Proyectos»: nombre", expected.ListedName, actual.ListedName);
        Check("listado «Mis Proyectos»: cantidad de capas", expected.ListedLayerCount, actual.ListedLayerCount);
        if (sameAssetIds)
        {
            Check("listado «Mis Proyectos»: asset del thumbnail", expected.ListedThumbnailAssetId, actual.ListedThumbnailAssetId);
        }

        Check("lista de versiones", string.Join(",", expected.VersionNumbers), string.Join(",", actual.VersionNumbers));
        diffs.AddRange(actual.IntegrityProblems);

        Assert.True(
            diffs.Count == 0,
            $"PÉRDIDA O CAMBIO SILENCIOSO DE DATOS en «{stage}» ({expected.Label} -> {actual.Label}):{Environment.NewLine}" +
            string.Join(Environment.NewLine, diffs.Select(d => " - " + d)));
    }

    private static string DescribePalette(IEnumerable<PaletteView> palette) =>
        string.Join(" | ", palette.Select(c => $"{c.Hex} {c.Coverage:R}% fondo={c.IsBackground} orden={c.Order}"));

    private static string Describe<T>(T value) => value switch
    {
        null => "AUSENTE",
        string text => $"«{text}»",
        _ => value.ToString() ?? "?",
    };

    // ---------------------------------------------------------------- infraestructura

    private PersistenceDataRoot NewDataRoot(string label)
    {
        var root = new PersistenceDataRoot(label);
        _dataRoots.Add(root);
        return root;
    }

    private string ConnectionStringFor(string database) =>
        new NpgsqlConnectionStringBuilder(_postgres.GetConnectionString()) { Database = database }.ConnectionString;
}
