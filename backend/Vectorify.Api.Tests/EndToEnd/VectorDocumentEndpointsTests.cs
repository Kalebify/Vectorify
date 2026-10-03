using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Testcontainers.PostgreSql;
using Vectorify.Api.Contracts;
using Vectorify.Api.Data;
using Vectorify.Api.Storage;
using Vectorify.Api.Tests.TestSupport;
using Vectorify.Api.VectorDocuments;
using Vectorify.Api.VectorDocuments.Persistence;

namespace Vectorify.Api.Tests.EndToEnd;

/// <summary>
/// Pruebas de integración HTTP de la persistencia completa del VectorDocument (M2.2-S05):
/// levantan la Web API real (WebApplicationFactory) contra PostgreSQL real (Testcontainers,
/// NUNCA InMemory), storage real (filesystem) y un motor Python simulado
/// (FakePythonPreprocessServer) para recorrer el flujo clásico completo (upload -&gt;
/// color-palette/detect -&gt; confirm -&gt; layers) antes de ejercitar
/// <c>POST /api/v2/workspaces/save</c>/<c>GET .../document</c>/<c>PATCH .../layers/{layerId}</c>.
/// Cubre explícitamente los escenarios pedidos por spec.md ("Tests"): round-trip, documento
/// multicolor, reload, fallo de DB/Storage simulados, documento incompleto (422) y
/// SchemaVersion no soportado (422). El reinicio REAL de containers (`docker compose down &amp;&amp;
/// up`) es verificación MANUAL -- ver el comentario al final de este archivo para el
/// procedimiento, no es automatizable con Testcontainers (cada test ya levanta/destruye su
/// propio container Postgres desde cero, que es el equivalente más cercano automatizable).
/// </summary>
public sealed class VectorDocumentEndpointsTests : IAsyncLifetime
{
    private readonly PostgreSqlContainer _postgres = new PostgreSqlBuilder("postgres:17-alpine").Build();
    private readonly string _storageRoot = Path.Combine(Path.GetTempPath(), "vectorify-vectordocument-tests-" + Guid.NewGuid().ToString("n"));
    private readonly string _projectRegistryRoot = Path.Combine(Path.GetTempPath(), "vectorify-vectordocument-tests-registry-" + Guid.NewGuid().ToString("n"));

    public Task InitializeAsync() => _postgres.StartAsync();

    public async Task DisposeAsync()
    {
        if (Directory.Exists(_storageRoot))
        {
            Directory.Delete(_storageRoot, recursive: true);
        }

        if (Directory.Exists(_projectRegistryRoot))
        {
            Directory.Delete(_projectRegistryRoot, recursive: true);
        }

        await _postgres.DisposeAsync();
    }

    [Fact]
    public async Task Save_ThenGetDocument_RoundTripsTheSameLayersIdsPaletteAndDimensions()
    {
        await using var pythonServer = await FakePythonPreprocessServer.StartAsync(
            _ => (200, "{}"), respondColorPalette: _ => (200, ColorPalettePayloads.SuccessBody()));
        await using var factory = CreateFactory(pythonServer.BaseUrl);
        var client = factory.CreateClient();

        var classic = await DetectConfirmAndGenerateLayersAsync(client);

        var saveResponse = await client.PostAsJsonAsync("/api/v2/workspaces/save", new VectorDocumentSaveRequest(
            ProjectId: null, Name: "Mi proyecto guardado", ClassicProjectId: classic.ProjectId, ImageId: classic.ImageId,
            PaletteId: classic.PaletteId, PaletteVersion: classic.PaletteVersion, DimensionId: null));

        Assert.Equal(HttpStatusCode.Created, saveResponse.StatusCode);
        var saveBody = await saveResponse.Content.ReadFromJsonAsync<VectorDocumentSaveResponse>();
        Assert.NotNull(saveBody);
        Assert.Equal(1, saveBody!.VersionNumber);
        Assert.NotEqual(Guid.Empty, saveBody.ProjectId);

        var getResponse = await client.GetAsync($"/api/v2/projects/{saveBody.ProjectId}/document");
        Assert.Equal(HttpStatusCode.OK, getResponse.StatusCode);
        var document = await getResponse.Content.ReadFromJsonAsync<VectorDocumentResponse>();
        Assert.NotNull(document);
        Assert.Equal(1, document!.SchemaVersion);
        Assert.Equal(1, document.VersionNumber);
        // Default 1px = 1mm (nunca se aplicaron dimensiones físicas en esta sesión).
        Assert.Equal(1, document.WidthMm);
        Assert.Equal(1, document.HeightMm);
        Assert.Equal("0 0 1 1", document.ViewBox);

        var layer = Assert.Single(document.Layers);
        Assert.Equal(classic.Layers[0].GroupId, layer.Id); // groupId clásico reutilizado verbatim
        Assert.Equal(classic.Layers[0].ColorHex, layer.ColorHex);
        Assert.True(layer.Visible);
        Assert.False(layer.Locked);
        Assert.Equal("unassigned", layer.ManufacturingOperation);
        Assert.NotNull(layer.SvgAssetId);
        Assert.NotNull(layer.SvgUrl);
        // Bug real encontrado en revisión: sin persistir esto (Data.Layer.PathCount, migración
        // AddLayerPathCount), un documento reabierto mostraba "0" en el Inspector (en vez del
        // valor real) y rompía silenciosamente "Seleccionar todo en la capa".
        Assert.True(layer.PathCount > 0);

        // La URL del asset reusa el endpoint de descarga YA EXISTENTE de M2.2-S04 -- el SVG debe
        // poder descargarse de verdad desde ahí.
        var assetResponse = await client.GetAsync(layer.SvgUrl);
        Assert.Equal(HttpStatusCode.OK, assetResponse.StatusCode);
        var svgText = await assetResponse.Content.ReadAsStringAsync();
        Assert.Contains("<svg", svgText);
    }

    [Fact]
    public async Task Save_WithMultiColorDocument_PersistsEachLayerWithItsOwnColorAndOperation()
    {
        await using var pythonServer = await FakePythonPreprocessServer.StartAsync(
            _ => (200, "{}"),
            respondColorPalette: _ => (200, ColorPalettePayloads.MultiGroupSuccessBody(1, 1, "#ff0000", "#00ff00")));
        await using var factory = CreateFactory(pythonServer.BaseUrl);
        var client = factory.CreateClient();

        var classic = await DetectConfirmAndGenerateLayersAsync(client);
        Assert.Equal(2, classic.Layers.Count);
        var redGroupId = classic.Layers.Single(l => l.ColorHex == "#ff0000").GroupId;
        var greenGroupId = classic.Layers.Single(l => l.ColorHex == "#00ff00").GroupId;

        // Asigna operaciones DISTINTAS a cada capa antes de guardar, vía el sidecar clásico --
        // el Save debe snapshotearlas en la DocumentVersion.
        var cutResponse = await client.PostAsJsonAsync(
            $"/api/v1/projects/{classic.ProjectId}/images/{classic.ImageId}/color-palette/{classic.PaletteId}/layers/{redGroupId}/operation",
            new ManufacturingOperationRequest("cut"));
        cutResponse.EnsureSuccessStatusCode();
        var engraveResponse = await client.PostAsJsonAsync(
            $"/api/v1/projects/{classic.ProjectId}/images/{classic.ImageId}/color-palette/{classic.PaletteId}/layers/{greenGroupId}/operation",
            new ManufacturingOperationRequest("engrave"));
        engraveResponse.EnsureSuccessStatusCode();

        var saveResponse = await client.PostAsJsonAsync("/api/v2/workspaces/save", new VectorDocumentSaveRequest(
            null, "Documento multicolor", classic.ProjectId, classic.ImageId, classic.PaletteId, classic.PaletteVersion, null));
        Assert.Equal(HttpStatusCode.Created, saveResponse.StatusCode);
        var saveBody = await saveResponse.Content.ReadFromJsonAsync<VectorDocumentSaveResponse>();

        var document = await client.GetFromJsonAsync<VectorDocumentResponse>($"/api/v2/projects/{saveBody!.ProjectId}/document");

        Assert.Equal(2, document!.Layers.Count);
        Assert.Equal(2, document.Layers.Select(l => l.ColorHex).Distinct().Count());
        Assert.Contains(document.Layers, l => l.Id == redGroupId && l.ColorHex == "#ff0000" && l.ManufacturingOperation == "cut");
        Assert.Contains(document.Layers, l => l.Id == greenGroupId && l.ColorHex == "#00ff00" && l.ManufacturingOperation == "engrave");
    }

    [Fact]
    public async Task GetDocument_CalledTwiceInTheSameSession_ReturnsTheSameEquivalentDocument()
    {
        await using var pythonServer = await FakePythonPreprocessServer.StartAsync(
            _ => (200, "{}"), respondColorPalette: _ => (200, ColorPalettePayloads.SuccessBody()));
        await using var factory = CreateFactory(pythonServer.BaseUrl);
        var client = factory.CreateClient();

        var classic = await DetectConfirmAndGenerateLayersAsync(client);
        var saveResponse = await client.PostAsJsonAsync("/api/v2/workspaces/save", new VectorDocumentSaveRequest(
            null, "Reload", classic.ProjectId, classic.ImageId, classic.PaletteId, classic.PaletteVersion, null));
        var saveBody = await saveResponse.Content.ReadFromJsonAsync<VectorDocumentSaveResponse>();

        var first = await client.GetFromJsonAsync<VectorDocumentResponse>($"/api/v2/projects/{saveBody!.ProjectId}/document");
        var second = await client.GetFromJsonAsync<VectorDocumentResponse>($"/api/v2/projects/{saveBody.ProjectId}/document");

        Assert.Equal(first!.VersionNumber, second!.VersionNumber);
        Assert.Equal(first.Layers.Select(l => l.Id), second.Layers.Select(l => l.Id));
        Assert.Equal(first.Layers.Select(l => l.ColorHex), second.Layers.Select(l => l.ColorHex));
    }

    [Fact]
    public async Task Save_SecondSaveOnTheSameProject_AddsANewVersionReusingLayerIds()
    {
        await using var pythonServer = await FakePythonPreprocessServer.StartAsync(
            _ => (200, "{}"), respondColorPalette: _ => (200, ColorPalettePayloads.SuccessBody()));
        await using var factory = CreateFactory(pythonServer.BaseUrl);
        var client = factory.CreateClient();

        var classic = await DetectConfirmAndGenerateLayersAsync(client);
        var firstSave = await client.PostAsJsonAsync("/api/v2/workspaces/save", new VectorDocumentSaveRequest(
            null, "Proyecto reutilizado", classic.ProjectId, classic.ImageId, classic.PaletteId, classic.PaletteVersion, null));
        var firstBody = await firstSave.Content.ReadFromJsonAsync<VectorDocumentSaveResponse>();
        Assert.Equal(1, firstBody!.VersionNumber);

        // Segundo Save del MISMO Workspace: reutiliza projectId, mismo triple clásico (el
        // groupId del layer es estable mientras no se regenere la paleta).
        var secondSave = await client.PostAsJsonAsync("/api/v2/workspaces/save", new VectorDocumentSaveRequest(
            firstBody.ProjectId, null, classic.ProjectId, classic.ImageId, classic.PaletteId, classic.PaletteVersion, null));
        Assert.Equal(HttpStatusCode.OK, secondSave.StatusCode);
        var secondBody = await secondSave.Content.ReadFromJsonAsync<VectorDocumentSaveResponse>();
        Assert.Equal(2, secondBody!.VersionNumber);
        Assert.Equal(firstBody.ProjectId, secondBody.ProjectId);

        var document = await client.GetFromJsonAsync<VectorDocumentResponse>($"/api/v2/projects/{firstBody.ProjectId}/document");
        Assert.Equal(2, document!.VersionNumber);
        Assert.Equal(classic.Layers[0].GroupId, Assert.Single(document.Layers).Id);
    }

    [Fact]
    public async Task Save_SecondSave_PreservesEditsMadeViaPatchSinceTheFirstSave_NeverRevertsToTheClassicSidecars()
    {
        // Bug real encontrado en revisión (M2.2-S05, ronda de fix 2): una vez que el frontend
        // hace el cutover post-Save, los sidecars clásicos quedan CONGELADOS desde el primer
        // Save -- el frontend ya nunca vuelve a escribirles. Antes de este fix, un segundo Save
        // real releía esos sidecars congelados y revertía en silencio cualquier edición hecha
        // vía PATCH v2. Este test reproduce exactamente ese escenario.
        await using var pythonServer = await FakePythonPreprocessServer.StartAsync(
            _ => (200, "{}"), respondColorPalette: _ => (200, ColorPalettePayloads.SuccessBody()));
        await using var factory = CreateFactory(pythonServer.BaseUrl);
        var client = factory.CreateClient();

        var classic = await DetectConfirmAndGenerateLayersAsync(client);
        var layerId = classic.Layers[0].GroupId;

        var firstSave = await client.PostAsJsonAsync("/api/v2/workspaces/save", new VectorDocumentSaveRequest(
            null, "Proyecto con PATCH entre saves", classic.ProjectId, classic.ImageId, classic.PaletteId, classic.PaletteVersion, null));
        var firstBody = await firstSave.Content.ReadFromJsonAsync<VectorDocumentSaveResponse>();

        // Edición post-Save vía PATCH v2 (cutover, ronda de fix 1) -- NUNCA toca los sidecars
        // clásicos (LayerLayout/ManufacturingOperation), que siguen reflejando el estado del
        // primer Save. Desde el fix round 1 de M2.2-S06, este PATCH crea su PROPIO checkpoint
        // (V2) -- la V1 original queda intacta.
        var patchResponse = await client.PatchAsJsonAsync(
            $"/api/v2/projects/{firstBody!.ProjectId}/layers/{layerId}",
            new UpdateLayerRequest("Renombrado vía PATCH", null, false, true, "engrave"));
        Assert.Equal(HttpStatusCode.OK, patchResponse.StatusCode);

        // Tercer checkpoint (Save) del MISMO Workspace -- antes del fix de M2.2-S05 (ronda de fix
        // 2), releía los sidecars clásicos (que nunca se tocaron) y la versión resultante hubiera
        // vuelto a mostrar el nombre/visible/locked/operación de ANTES del PATCH.
        var secondSave = await client.PostAsJsonAsync("/api/v2/workspaces/save", new VectorDocumentSaveRequest(
            firstBody.ProjectId, null, classic.ProjectId, classic.ImageId, classic.PaletteId, classic.PaletteVersion, null));
        Assert.Equal(HttpStatusCode.OK, secondSave.StatusCode);

        var document = await client.GetFromJsonAsync<VectorDocumentResponse>($"/api/v2/projects/{firstBody.ProjectId}/document");
        Assert.Equal(3, document!.VersionNumber); // V1 (Save) -> V2 (PATCH, checkpoint propio) -> V3 (Save)
        var layer = Assert.Single(document.Layers);
        Assert.Equal("Renombrado vía PATCH", layer.Name);
        Assert.False(layer.Visible);
        Assert.True(layer.Locked);
        Assert.Equal("engrave", layer.ManufacturingOperation);
    }

    [Fact]
    public async Task Save_WithDimensionId_UsesTheAppliedPhysicalDimensions()
    {
        await using var pythonServer = await FakePythonPreprocessServer.StartAsync(
            _ => (200, "{}"), respondColorPalette: _ => (200, ColorPalettePayloads.SuccessBody()));
        await using var factory = CreateFactory(pythonServer.BaseUrl);
        var client = factory.CreateClient();

        var classic = await DetectConfirmAndGenerateLayersAsync(client);
        var vectorId = classic.Layers[0].VectorId;

        var dimensionResponse = await client.PostAsJsonAsync(
            $"/api/v1/projects/{classic.ProjectId}/images/{classic.ImageId}/dimensions/apply",
            new DimensionRequest("vector", vectorId, 150, null, true));
        dimensionResponse.EnsureSuccessStatusCode();
        var dimension = await dimensionResponse.Content.ReadFromJsonAsync<DimensionResponse>();

        var saveResponse = await client.PostAsJsonAsync("/api/v2/workspaces/save", new VectorDocumentSaveRequest(
            null, "Con dimensiones", classic.ProjectId, classic.ImageId, classic.PaletteId, classic.PaletteVersion, dimension!.DimensionId));
        var saveBody = await saveResponse.Content.ReadFromJsonAsync<VectorDocumentSaveResponse>();

        var document = await client.GetFromJsonAsync<VectorDocumentResponse>($"/api/v2/projects/{saveBody!.ProjectId}/document");

        Assert.Equal(150, document!.WidthMm);
        Assert.Equal(dimension.HeightMm, document.HeightMm);
    }

    [Fact]
    public async Task Save_WhenPaletteIsNotConfirmed_ReturnsUnprocessableEntity()
    {
        await using var pythonServer = await FakePythonPreprocessServer.StartAsync(
            _ => (200, "{}"), respondColorPalette: _ => (200, ColorPalettePayloads.SuccessBody()));
        await using var factory = CreateFactory(pythonServer.BaseUrl);
        var client = factory.CreateClient();

        var uploadBody = await UploadAsync(client);
        var detectResponse = await client.PostAsJsonAsync(
            $"/api/v1/projects/{uploadBody.ProjectId}/images/{uploadBody.ImageId}/color-palette/detect",
            new ColorPaletteDetectRequest(null, null, null));
        var palette = await detectResponse.Content.ReadFromJsonAsync<ColorPaletteResponse>();

        var saveResponse = await client.PostAsJsonAsync("/api/v2/workspaces/save", new VectorDocumentSaveRequest(
            null, "Nunca confirmado", uploadBody.ProjectId, uploadBody.ImageId, palette!.PaletteId, palette.Version, null));

        Assert.Equal((HttpStatusCode)422, saveResponse.StatusCode);
        var error = await saveResponse.Content.ReadFromJsonAsync<ApiErrorResponse>();
        Assert.Equal("palette_not_confirmed", error!.Code);
    }

    [Fact]
    public async Task Save_WhenLayerSetWasNeverGenerated_ReturnsUnprocessableEntity()
    {
        await using var pythonServer = await FakePythonPreprocessServer.StartAsync(
            _ => (200, "{}"), respondColorPalette: _ => (200, ColorPalettePayloads.SuccessBody()));
        await using var factory = CreateFactory(pythonServer.BaseUrl);
        var client = factory.CreateClient();

        var uploadBody = await UploadAsync(client);
        var detectResponse = await client.PostAsJsonAsync(
            $"/api/v1/projects/{uploadBody.ProjectId}/images/{uploadBody.ImageId}/color-palette/detect",
            new ColorPaletteDetectRequest(null, null, null));
        var palette = await detectResponse.Content.ReadFromJsonAsync<ColorPaletteResponse>();
        var confirmResponse = await client.PostAsync(
            $"/api/v1/projects/{uploadBody.ProjectId}/images/{uploadBody.ImageId}/color-palette/{palette!.PaletteId}/confirm", null);
        confirmResponse.EnsureSuccessStatusCode();

        // Nunca se llamó a POST .../layers -- no existe ningún VectorLayerSetVersion.
        var saveResponse = await client.PostAsJsonAsync("/api/v2/workspaces/save", new VectorDocumentSaveRequest(
            null, "Sin capas", uploadBody.ProjectId, uploadBody.ImageId, palette.PaletteId, palette.Version, null));

        Assert.Equal((HttpStatusCode)422, saveResponse.StatusCode);
        var error = await saveResponse.Content.ReadFromJsonAsync<ApiErrorResponse>();
        Assert.Equal("layer_set_not_found", error!.Code);
    }

    [Fact]
    public async Task Save_WhenStorageFailsUploadingALayerSvg_ReturnsErrorAndNeverCreatesALayerRow()
    {
        await using var pythonServer = await FakePythonPreprocessServer.StartAsync(
            _ => (200, "{}"), respondColorPalette: _ => (200, ColorPalettePayloads.SuccessBody()));
        // El storage selectivo deja pasar TODO el flujo clásico (lee/escribe con la convención de
        // claves clásica) y falla ÚNICAMENTE al guardar el Asset "layer-svg" nuevo que el Save
        // intenta subir -- mismo criterio que spec.md "Tests": "IFileStorage lanzando".
        await using var factory = CreateFactory(pythonServer.BaseUrl, failLayerSvgUploads: true);
        var client = factory.CreateClient();

        var classic = await DetectConfirmAndGenerateLayersAsync(client);

        var saveResponse = await client.PostAsJsonAsync("/api/v2/workspaces/save", new VectorDocumentSaveRequest(
            null, "Falla de storage", classic.ProjectId, classic.ImageId, classic.PaletteId, classic.PaletteVersion, null));

        Assert.Equal((HttpStatusCode)422, saveResponse.StatusCode);

        // Ningún Project nuevo quedó con Layers/DocumentVersion a medio escribir: si se llegó a
        // crear un Project (el primer Save siempre lo hace ANTES de resolver el estado clásico),
        // no debe tener NINGÚN VectorDocument asociado.
        await using var scope = factory.Services.CreateAsyncScope();
        var dbContext = scope.ServiceProvider.GetRequiredService<VectorizationDbContext>();
        Assert.False(await dbContext.VectorDocuments.AnyAsync());
        Assert.False(await dbContext.Layers.AnyAsync());
    }

    [Fact]
    public async Task Save_WhenTheRepositoryThrowsSimulatingADatabaseFailure_LeavesNoPartialRows()
    {
        await using var pythonServer = await FakePythonPreprocessServer.StartAsync(
            _ => (200, "{}"), respondColorPalette: _ => (200, ColorPalettePayloads.SuccessBody()));
        await using var factory = CreateFactory(pythonServer.BaseUrl, overrideRepositoryWithThrowingFake: true);
        var client = factory.CreateClient();

        var classic = await DetectConfirmAndGenerateLayersAsync(client);

        var saveResponse = await client.PostAsJsonAsync("/api/v2/workspaces/save", new VectorDocumentSaveRequest(
            null, "Falla de DB simulada", classic.ProjectId, classic.ImageId, classic.PaletteId, classic.PaletteVersion, null));

        Assert.Equal(HttpStatusCode.InternalServerError, saveResponse.StatusCode);

        await using var scope = factory.Services.CreateAsyncScope();
        var dbContext = scope.ServiceProvider.GetRequiredService<VectorizationDbContext>();
        Assert.False(await dbContext.VectorDocuments.AnyAsync());
        Assert.False(await dbContext.DocumentVersions.AnyAsync());
        Assert.False(await dbContext.Layers.AnyAsync());
    }

    [Fact]
    public async Task GetDocument_WhenSchemaVersionIsNewerThanSupported_ReturnsUnprocessableEntity()
    {
        await using var pythonServer = await FakePythonPreprocessServer.StartAsync(
            _ => (200, "{}"), respondColorPalette: _ => (200, ColorPalettePayloads.SuccessBody()));
        await using var factory = CreateFactory(pythonServer.BaseUrl);
        var client = factory.CreateClient();

        var classic = await DetectConfirmAndGenerateLayersAsync(client);
        var saveResponse = await client.PostAsJsonAsync("/api/v2/workspaces/save", new VectorDocumentSaveRequest(
            null, "Versión futura", classic.ProjectId, classic.ImageId, classic.PaletteId, classic.PaletteVersion, null));
        var saveBody = await saveResponse.Content.ReadFromJsonAsync<VectorDocumentSaveResponse>();

        // Bypass de la API: fuerza un SchemaVersion mayor al que este backend entiende.
        // M2.2-S06: SchemaVersion vive en DocumentVersion, no en VectorDocument.
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var dbContext = scope.ServiceProvider.GetRequiredService<VectorizationDbContext>();
            var project = await dbContext.Projects.FirstAsync(p => p.Id == saveBody!.ProjectId);
            var version = await dbContext.DocumentVersions.FirstAsync(v => v.Id == project.CurrentVersionId);
            version.SchemaVersion = 2;
            await dbContext.SaveChangesAsync();
        }

        var getResponse = await client.GetAsync($"/api/v2/projects/{saveBody!.ProjectId}/document");

        Assert.Equal((HttpStatusCode)422, getResponse.StatusCode);
        var error = await getResponse.Content.ReadFromJsonAsync<ApiErrorResponse>();
        Assert.Equal("unsupported_schema_version", error!.Code);
    }

    [Fact]
    public async Task SaveAndGetAndPatch_WhenProjectBelongsToAnotherOwner_AllReturnNotFound()
    {
        await using var pythonServer = await FakePythonPreprocessServer.StartAsync(
            _ => (200, "{}"), respondColorPalette: _ => (200, ColorPalettePayloads.SuccessBody()));
        await using var factory = CreateFactory(pythonServer.BaseUrl);
        var client = factory.CreateClient();
        var classic = await DetectConfirmAndGenerateLayersAsync(client);

        Guid foreignProjectId;
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var dbContext = scope.ServiceProvider.GetRequiredService<VectorizationDbContext>();
            var stranger = new User { Id = Guid.NewGuid(), DisplayName = "Ajeno", CreatedAt = DateTimeOffset.UtcNow };
            var project = new Project
            {
                Id = Guid.NewGuid(), OwnerId = stranger.Id, Name = "Proyecto ajeno",
                CreatedAt = DateTimeOffset.UtcNow, UpdatedAt = DateTimeOffset.UtcNow,
            };
            dbContext.Users.Add(stranger);
            dbContext.Projects.Add(project);
            await dbContext.SaveChangesAsync();
            foreignProjectId = project.Id;
        }

        var saveResponse = await client.PostAsJsonAsync("/api/v2/workspaces/save", new VectorDocumentSaveRequest(
            foreignProjectId, null, classic.ProjectId, classic.ImageId, classic.PaletteId, classic.PaletteVersion, null));
        Assert.Equal(HttpStatusCode.NotFound, saveResponse.StatusCode);

        var getResponse = await client.GetAsync($"/api/v2/projects/{foreignProjectId}/document");
        Assert.Equal(HttpStatusCode.NotFound, getResponse.StatusCode);

        var patchResponse = await client.PatchAsJsonAsync(
            $"/api/v2/projects/{foreignProjectId}/layers/{Guid.NewGuid()}", new UpdateLayerRequest(null, null, null, null, null));
        Assert.Equal(HttpStatusCode.NotFound, patchResponse.StatusCode);
    }

    [Fact]
    public async Task PatchLayer_UpdatesVisibleLockedNameOrderAndOperation_ReflectedOnNextGet()
    {
        await using var pythonServer = await FakePythonPreprocessServer.StartAsync(
            _ => (200, "{}"), respondColorPalette: _ => (200, ColorPalettePayloads.SuccessBody()));
        await using var factory = CreateFactory(pythonServer.BaseUrl);
        var client = factory.CreateClient();

        var classic = await DetectConfirmAndGenerateLayersAsync(client);
        var saveResponse = await client.PostAsJsonAsync("/api/v2/workspaces/save", new VectorDocumentSaveRequest(
            null, "Para patchear", classic.ProjectId, classic.ImageId, classic.PaletteId, classic.PaletteVersion, null));
        var saveBody = await saveResponse.Content.ReadFromJsonAsync<VectorDocumentSaveResponse>();
        var layerId = classic.Layers[0].GroupId;

        var patchResponse = await client.PatchAsJsonAsync(
            $"/api/v2/projects/{saveBody!.ProjectId}/layers/{layerId}",
            new UpdateLayerRequest("Nombre nuevo", 7, false, true, "engrave"));

        Assert.Equal(HttpStatusCode.OK, patchResponse.StatusCode);
        var patched = await patchResponse.Content.ReadFromJsonAsync<VectorDocumentLayerResponse>();
        Assert.Equal("Nombre nuevo", patched!.Name);
        Assert.Equal(7, patched.Order);
        Assert.False(patched.Visible);
        Assert.True(patched.Locked);
        Assert.Equal("engrave", patched.ManufacturingOperation);

        var document = await client.GetFromJsonAsync<VectorDocumentResponse>($"/api/v2/projects/{saveBody.ProjectId}/document");
        var reloadedLayer = Assert.Single(document!.Layers);
        Assert.Equal("Nombre nuevo", reloadedLayer.Name);
        Assert.Equal("engrave", reloadedLayer.ManufacturingOperation);
    }

    [Fact]
    public async Task PatchLayer_CreatesANewVersion_HistoricalVersionOneKeepsItsOriginalContent()
    {
        // Test de regresión pedido explícitamente por QA (fix round 1, M2.2-S06): Save (V1) ->
        // PATCH un layer -> esto debe crear V2 (nunca mutar V1 in-place) -> GET .../versions/1
        // sigue devolviendo el contenido ORIGINAL (sin el patch) -> GET .../document (la
        // ACTUAL, V2) devuelve el contenido CON el patch aplicado.
        await using var pythonServer = await FakePythonPreprocessServer.StartAsync(
            _ => (200, "{}"), respondColorPalette: _ => (200, ColorPalettePayloads.SuccessBody()));
        await using var factory = CreateFactory(pythonServer.BaseUrl);
        var client = factory.CreateClient();

        var classic = await DetectConfirmAndGenerateLayersAsync(client);
        var saveResponse = await client.PostAsJsonAsync("/api/v2/workspaces/save", new VectorDocumentSaveRequest(
            null, "V1 antes del patch", classic.ProjectId, classic.ImageId, classic.PaletteId, classic.PaletteVersion, null));
        var saveBody = await saveResponse.Content.ReadFromJsonAsync<VectorDocumentSaveResponse>();
        Assert.Equal(1, saveBody!.VersionNumber);
        var layerId = classic.Layers[0].GroupId;

        var originalName = classic.Layers[0].Name;

        var patchResponse = await client.PatchAsJsonAsync(
            $"/api/v2/projects/{saveBody.ProjectId}/layers/{layerId}",
            new UpdateLayerRequest("Nombre patcheado", null, null, null, null));
        Assert.Equal(HttpStatusCode.OK, patchResponse.StatusCode);
        var patched = await patchResponse.Content.ReadFromJsonAsync<VectorDocumentLayerResponse>();
        Assert.Equal("Nombre patcheado", patched!.Name);

        // GET .../versions/1 (histórica): devuelve el contenido ORIGINAL, SIN el patch -- el
        // bug original lo mutaba, violando la inmutabilidad del checkpoint.
        var v1 = await client.GetFromJsonAsync<VectorDocumentResponse>($"/api/v2/projects/{saveBody.ProjectId}/versions/1");
        Assert.Equal(1, v1!.VersionNumber);
        Assert.Equal(originalName, Assert.Single(v1.Layers).Name);

        // GET .../versions (metadata): confirma que el PATCH creó su PROPIO checkpoint
        // (VersionNumber 2), no reutilizó/machacó la V1.
        var versions = await client.GetFromJsonAsync<List<VectorDocumentVersionSummaryResponse>>($"/api/v2/projects/{saveBody.ProjectId}/versions");
        Assert.Equal([2, 1], versions!.Select(v => v.VersionNumber));

        // GET .../document (la ACTUAL, V2): devuelve el contenido CON el patch aplicado.
        var current = await client.GetFromJsonAsync<VectorDocumentResponse>($"/api/v2/projects/{saveBody.ProjectId}/document");
        Assert.Equal(2, current!.VersionNumber);
        Assert.Equal("Nombre patcheado", Assert.Single(current.Layers).Name);
    }

    [Fact]
    public async Task PatchLayer_WithUnassignedOperation_ClearsIt()
    {
        await using var pythonServer = await FakePythonPreprocessServer.StartAsync(
            _ => (200, "{}"), respondColorPalette: _ => (200, ColorPalettePayloads.SuccessBody()));
        await using var factory = CreateFactory(pythonServer.BaseUrl);
        var client = factory.CreateClient();

        var classic = await DetectConfirmAndGenerateLayersAsync(client);
        var layerId = classic.Layers[0].GroupId;
        await client.PostAsJsonAsync(
            $"/api/v1/projects/{classic.ProjectId}/images/{classic.ImageId}/color-palette/{classic.PaletteId}/layers/{layerId}/operation",
            new ManufacturingOperationRequest("cut"));
        var saveResponse = await client.PostAsJsonAsync("/api/v2/workspaces/save", new VectorDocumentSaveRequest(
            null, "Para desasignar", classic.ProjectId, classic.ImageId, classic.PaletteId, classic.PaletteVersion, null));
        var saveBody = await saveResponse.Content.ReadFromJsonAsync<VectorDocumentSaveResponse>();

        var patchResponse = await client.PatchAsJsonAsync(
            $"/api/v2/projects/{saveBody!.ProjectId}/layers/{layerId}",
            new UpdateLayerRequest(null, null, null, null, "unassigned"));

        var patched = await patchResponse.Content.ReadFromJsonAsync<VectorDocumentLayerResponse>();
        Assert.Equal("unassigned", patched!.ManufacturingOperation);
    }

    [Fact]
    public async Task ListVersions_ReturnsAllVersionsNewestFirst_WithoutLayers()
    {
        await using var pythonServer = await FakePythonPreprocessServer.StartAsync(
            _ => (200, "{}"), respondColorPalette: _ => (200, ColorPalettePayloads.SuccessBody()));
        await using var factory = CreateFactory(pythonServer.BaseUrl);
        var client = factory.CreateClient();

        var classic = await DetectConfirmAndGenerateLayersAsync(client);
        var firstSave = await client.PostAsJsonAsync("/api/v2/workspaces/save", new VectorDocumentSaveRequest(
            null, "V1", classic.ProjectId, classic.ImageId, classic.PaletteId, classic.PaletteVersion, null));
        var firstBody = await firstSave.Content.ReadFromJsonAsync<VectorDocumentSaveResponse>();
        await client.PostAsJsonAsync("/api/v2/workspaces/save", new VectorDocumentSaveRequest(
            firstBody!.ProjectId, null, classic.ProjectId, classic.ImageId, classic.PaletteId, classic.PaletteVersion, null));

        var listResponse = await client.GetAsync($"/api/v2/projects/{firstBody.ProjectId}/versions");

        Assert.Equal(HttpStatusCode.OK, listResponse.StatusCode);
        var versions = await listResponse.Content.ReadFromJsonAsync<List<VectorDocumentVersionSummaryResponse>>();
        Assert.NotNull(versions);
        Assert.Equal([2, 1], versions!.Select(v => v.VersionNumber));
        Assert.All(versions, v => Assert.Equal("MANUAL_EDIT", v.Origin));
    }

    [Fact]
    public async Task ListVersions_NonexistentProject_ReturnsNotFound()
    {
        await using var pythonServer = await FakePythonPreprocessServer.StartAsync(
            _ => (200, "{}"), respondColorPalette: _ => (200, ColorPalettePayloads.SuccessBody()));
        await using var factory = CreateFactory(pythonServer.BaseUrl);
        var client = factory.CreateClient();

        var response = await client.GetAsync($"/api/v2/projects/{Guid.NewGuid()}/versions");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task GetVersion_HistoricalVersionNumber_ReturnsItEvenWhenNoLongerCurrent()
    {
        await using var pythonServer = await FakePythonPreprocessServer.StartAsync(
            _ => (200, "{}"), respondColorPalette: _ => (200, ColorPalettePayloads.SuccessBody()));
        await using var factory = CreateFactory(pythonServer.BaseUrl);
        var client = factory.CreateClient();

        var classic = await DetectConfirmAndGenerateLayersAsync(client);
        var firstSave = await client.PostAsJsonAsync("/api/v2/workspaces/save", new VectorDocumentSaveRequest(
            null, "V1", classic.ProjectId, classic.ImageId, classic.PaletteId, classic.PaletteVersion, null));
        var firstBody = await firstSave.Content.ReadFromJsonAsync<VectorDocumentSaveResponse>();
        await client.PostAsJsonAsync("/api/v2/workspaces/save", new VectorDocumentSaveRequest(
            firstBody!.ProjectId, null, classic.ProjectId, classic.ImageId, classic.PaletteId, classic.PaletteVersion, null));

        var versionResponse = await client.GetAsync($"/api/v2/projects/{firstBody.ProjectId}/versions/1");

        Assert.Equal(HttpStatusCode.OK, versionResponse.StatusCode);
        var version = await versionResponse.Content.ReadFromJsonAsync<VectorDocumentResponse>();
        Assert.Equal(1, version!.VersionNumber);
    }

    [Fact]
    public async Task GetVersion_NonexistentVersionNumber_ReturnsNotFound()
    {
        await using var pythonServer = await FakePythonPreprocessServer.StartAsync(
            _ => (200, "{}"), respondColorPalette: _ => (200, ColorPalettePayloads.SuccessBody()));
        await using var factory = CreateFactory(pythonServer.BaseUrl);
        var client = factory.CreateClient();

        var classic = await DetectConfirmAndGenerateLayersAsync(client);
        var saveResponse = await client.PostAsJsonAsync("/api/v2/workspaces/save", new VectorDocumentSaveRequest(
            null, "Única versión", classic.ProjectId, classic.ImageId, classic.PaletteId, classic.PaletteVersion, null));
        var saveBody = await saveResponse.Content.ReadFromJsonAsync<VectorDocumentSaveResponse>();

        var response = await client.GetAsync($"/api/v2/projects/{saveBody!.ProjectId}/versions/99");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task RestoreVersion_CreatesANewVersionWithTheSourceContent_AndRepointsCurrentVersion()
    {
        await using var pythonServer = await FakePythonPreprocessServer.StartAsync(
            _ => (200, "{}"), respondColorPalette: _ => (200, ColorPalettePayloads.SuccessBody()));
        await using var factory = CreateFactory(pythonServer.BaseUrl);
        var client = factory.CreateClient();

        var classic = await DetectConfirmAndGenerateLayersAsync(client);
        var firstSave = await client.PostAsJsonAsync("/api/v2/workspaces/save", new VectorDocumentSaveRequest(
            null, "V1", classic.ProjectId, classic.ImageId, classic.PaletteId, classic.PaletteVersion, null));
        var firstBody = await firstSave.Content.ReadFromJsonAsync<VectorDocumentSaveResponse>();

        var v1Document = await client.GetFromJsonAsync<VectorDocumentResponse>($"/api/v2/projects/{firstBody!.ProjectId}/versions/1");

        // Segundo Save (mismo contenido clásico): V2 pasa a ser la actual -- V1 queda atrás,
        // intacta.
        var secondSave = await client.PostAsJsonAsync("/api/v2/workspaces/save", new VectorDocumentSaveRequest(
            firstBody.ProjectId, null, classic.ProjectId, classic.ImageId, classic.PaletteId, classic.PaletteVersion, null));
        secondSave.EnsureSuccessStatusCode();

        // PATCH es, igual que Save/Restore, un checkpoint (fix round 1 de M2.2-S06): crea una
        // V3 nueva con el patch aplicado -- V2 (de donde partió) nunca se toca.
        var patchResponse = await client.PatchAsJsonAsync(
            $"/api/v2/projects/{firstBody.ProjectId}/layers/{classic.Layers[0].GroupId}",
            new UpdateLayerRequest("Nombre cambiado antes de restaurar", null, null, null, null));
        patchResponse.EnsureSuccessStatusCode();

        var restoreResponse = await client.PostAsync($"/api/v2/projects/{firstBody.ProjectId}/versions/1/restore", null);

        Assert.Equal(HttpStatusCode.OK, restoreResponse.StatusCode);
        var restoreBody = await restoreResponse.Content.ReadFromJsonAsync<VectorDocumentSaveResponse>();
        Assert.Equal(4, restoreBody!.VersionNumber); // siguiente número secuencial (V1 Save, V2 Save, V3 PATCH, V4 Restore)
        Assert.Equal(firstBody.ProjectId, restoreBody.ProjectId);

        var currentDocument = await client.GetFromJsonAsync<VectorDocumentResponse>($"/api/v2/projects/{firstBody.ProjectId}/document");
        Assert.Equal(4, currentDocument!.VersionNumber);
        // Contenido de V1 restaurado -- el nombre vuelve a ser el original de V1, no el
        // patcheado sobre V3.
        Assert.Equal(v1Document!.Layers[0].Name, currentDocument.Layers[0].Name);

        var versions = await client.GetFromJsonAsync<List<VectorDocumentVersionSummaryResponse>>($"/api/v2/projects/{firstBody.ProjectId}/versions");
        Assert.Contains(versions!, v => v.VersionNumber == 4 && v.Origin == "RESTORE");
        Assert.Contains(versions!, v => v.VersionNumber == 3 && v.Origin == "MANUAL_EDIT"); // el PATCH quedó registrado como su propio checkpoint
    }

    [Fact]
    public async Task RestoreVersion_NonexistentVersionNumber_ReturnsNotFound()
    {
        await using var pythonServer = await FakePythonPreprocessServer.StartAsync(
            _ => (200, "{}"), respondColorPalette: _ => (200, ColorPalettePayloads.SuccessBody()));
        await using var factory = CreateFactory(pythonServer.BaseUrl);
        var client = factory.CreateClient();

        var classic = await DetectConfirmAndGenerateLayersAsync(client);
        var saveResponse = await client.PostAsJsonAsync("/api/v2/workspaces/save", new VectorDocumentSaveRequest(
            null, "Única versión", classic.ProjectId, classic.ImageId, classic.PaletteId, classic.PaletteVersion, null));
        var saveBody = await saveResponse.Content.ReadFromJsonAsync<VectorDocumentSaveResponse>();

        var response = await client.PostAsync($"/api/v2/projects/{saveBody!.ProjectId}/versions/99/restore", null);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task VersionEndpoints_SoftDeletedProject_AllReturnNotFound()
    {
        // "Documento eliminado" (spec.md M2.2-S06, "Tests"): Project soft-eliminado (M2.2-S03)
        // -> todos los endpoints de versión 404, vía el query filter global de Project.
        await using var pythonServer = await FakePythonPreprocessServer.StartAsync(
            _ => (200, "{}"), respondColorPalette: _ => (200, ColorPalettePayloads.SuccessBody()));
        await using var factory = CreateFactory(pythonServer.BaseUrl);
        var client = factory.CreateClient();

        var classic = await DetectConfirmAndGenerateLayersAsync(client);
        var saveResponse = await client.PostAsJsonAsync("/api/v2/workspaces/save", new VectorDocumentSaveRequest(
            null, "A borrar", classic.ProjectId, classic.ImageId, classic.PaletteId, classic.PaletteVersion, null));
        var saveBody = await saveResponse.Content.ReadFromJsonAsync<VectorDocumentSaveResponse>();

        var deleteResponse = await client.DeleteAsync($"/api/v2/projects/{saveBody!.ProjectId}");
        Assert.Equal(HttpStatusCode.NoContent, deleteResponse.StatusCode);

        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync($"/api/v2/projects/{saveBody.ProjectId}/document")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync($"/api/v2/projects/{saveBody.ProjectId}/versions")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync($"/api/v2/projects/{saveBody.ProjectId}/versions/1")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.PostAsync($"/api/v2/projects/{saveBody.ProjectId}/versions/1/restore", null)).StatusCode);
    }

    private static async Task<UploadImageResponse> UploadAsync(HttpClient client)
    {
        using var content = new MultipartFormDataContent();
        var fileContent = new ByteArrayContent(SampleImages.ValidPng1x1);
        fileContent.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("image/png");
        content.Add(fileContent, "file", "logo.png");

        var uploadResponse = await client.PostAsync("/api/v1/projects", content);
        uploadResponse.EnsureSuccessStatusCode();
        return (await uploadResponse.Content.ReadFromJsonAsync<UploadImageResponse>())!;
    }

    private sealed record ClassicSessionInfo(
        Guid ProjectId, Guid ImageId, Guid PaletteId, int PaletteVersion, IReadOnlyList<VectorLayerPayload> Layers);

    /// <summary>
    /// Recorre upload -&gt; detect -&gt; confirm -&gt; layers contra la Web API real. El número/color
    /// de los grupos depende enteramente de cómo se haya configurado <c>respondColorPalette</c>
    /// al crear el <see cref="FakePythonPreprocessServer"/> del test (1 grupo por defecto vía
    /// <see cref="ColorPalettePayloads.SuccessBody"/>, o varios vía
    /// <see cref="ColorPalettePayloads.MultiGroupSuccessBody"/>) -- este helper no asume nada
    /// sobre esa cantidad, solo expone lo que la API realmente devolvió.
    /// </summary>
    private static async Task<ClassicSessionInfo> DetectConfirmAndGenerateLayersAsync(HttpClient client)
    {
        var uploadBody = await UploadAsync(client);

        var detectResponse = await client.PostAsJsonAsync(
            $"/api/v1/projects/{uploadBody.ProjectId}/images/{uploadBody.ImageId}/color-palette/detect",
            new ColorPaletteDetectRequest(null, null, null));
        detectResponse.EnsureSuccessStatusCode();
        var paletteBody = await detectResponse.Content.ReadFromJsonAsync<ColorPaletteResponse>();

        var confirmResponse = await client.PostAsync(
            $"/api/v1/projects/{uploadBody.ProjectId}/images/{uploadBody.ImageId}/color-palette/{paletteBody!.PaletteId}/confirm", null);
        confirmResponse.EnsureSuccessStatusCode();

        var layersResponse = await client.PostAsync(
            $"/api/v1/projects/{uploadBody.ProjectId}/images/{uploadBody.ImageId}/color-palette/{paletteBody.PaletteId}/layers", null);
        layersResponse.EnsureSuccessStatusCode();
        var layerSet = await layersResponse.Content.ReadFromJsonAsync<VectorLayerSetResponse>();

        return new ClassicSessionInfo(uploadBody.ProjectId, uploadBody.ImageId, paletteBody.PaletteId, paletteBody.Version, layerSet!.Layers);
    }

    private WebApplicationFactory<Program> CreateFactory(
        string pythonBaseUrl, bool failLayerSvgUploads = false, bool overrideRepositoryWithThrowingFake = false) =>
        new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
        {
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["Postgres:ConnectionString"] = _postgres.GetConnectionString(),
                    ["PythonEngine:BaseUrl"] = pythonBaseUrl,
                    ["Cors:AllowedOrigins"] = "http://localhost:5173",
                    ["Storage:RootPath"] = _storageRoot,
                    ["ProjectRegistry:RootPath"] = _projectRegistryRoot,
                });
            });

            builder.ConfigureServices(services =>
            {
                if (failLayerSvgUploads)
                {
                    services.RemoveAll<IFileStorage>();
                    services.AddSingleton<IFileStorage>(sp =>
                        new SelectivelyFailingFileStorage(ActivatorUtilities.CreateInstance<LocalFileStorage>(sp)));
                }

                if (overrideRepositoryWithThrowingFake)
                {
                    services.RemoveAll<IVectorDocumentRepository>();
                    services.AddScoped<IVectorDocumentRepository, ThrowingVectorDocumentRepository>();
                }
            });
        });

    /// <summary>
    /// <see cref="IFileStorage"/> real (delega todo a <see cref="LocalFileStorage"/>) EXCEPTO al
    /// guardar una clave bajo el tipo "layer-svg" (la convención de
    /// <see cref="Vectorify.Api.Assets.AssetKeyFactory"/> para Assets nuevos, M2.2-S04) -- ahí
    /// lanza <see cref="FileStorageException"/> a propósito. Deja pasar TODO el flujo clásico
    /// (preprocess/threshold/vectorize/color-palette/layers), que usa su propia convención de
    /// claves (sin "/layer-svg/"), para poder llegar hasta el Save real y fallar ÚNICAMENTE ahí
    /// -- ver spec.md "Tests": "IFileStorage lanzando".
    /// </summary>
    private sealed class SelectivelyFailingFileStorage : IFileStorage
    {
        private readonly IFileStorage _inner;

        public SelectivelyFailingFileStorage(IFileStorage inner)
        {
            _inner = inner;
        }

        public Task<StoredFile> SaveAsync(string key, Stream content, string contentType, CancellationToken cancellationToken) =>
            key.Contains("/layer-svg/", StringComparison.Ordinal)
                ? throw new FileStorageException("fallo simulado de storage al subir el SVG de una capa")
                : _inner.SaveAsync(key, content, contentType, cancellationToken);

        public Task<Stream> OpenReadAsync(string key, CancellationToken cancellationToken) => _inner.OpenReadAsync(key, cancellationToken);

        public Task<bool> ExistsAsync(string key, CancellationToken cancellationToken) => _inner.ExistsAsync(key, cancellationToken);

        public Task DeleteAsync(string key, CancellationToken cancellationToken) => _inner.DeleteAsync(key, cancellationToken);
    }

    /// <summary>
    /// Simula un fallo real de base de datos durante el Save (spec.md "Tests": "Fallo de DB
    /// durante Save (simulado)"): lanza siempre al intentar persistir el grafo completo, DESPUÉS
    /// de que el estado clásico ya se resolvió y los Assets de cada capa ya se subieron (I/O real,
    /// no simulado) -- el punto relevante del test es que ninguna fila de
    /// VectorDocument/DocumentVersion/Layer quede escrita a medias.
    /// </summary>
    private sealed class ThrowingVectorDocumentRepository : IVectorDocumentRepository
    {
        public Task<VectorDocumentSaveOutcome?> SaveAsync(Guid projectId, Guid ownerId, DocumentSnapshot snapshot, CancellationToken cancellationToken) =>
            throw new InvalidOperationException("fallo de base de datos simulado");

        public Task<(VectorDocument Document, DocumentVersion Version)?> FindCurrentDocumentAsync(Guid projectId, Guid ownerId, CancellationToken cancellationToken) =>
            throw new InvalidOperationException("fallo de base de datos simulado");

        public Task<(VectorDocument Document, DocumentVersion Version)?> FindVersionAsync(Guid projectId, Guid ownerId, int versionNumber, CancellationToken cancellationToken) =>
            throw new InvalidOperationException("fallo de base de datos simulado");

        public Task<IReadOnlyList<DocumentVersion>?> ListVersionsAsync(Guid projectId, Guid ownerId, CancellationToken cancellationToken) =>
            throw new InvalidOperationException("fallo de base de datos simulado");

        public Task<VectorDocumentSaveOutcome?> RestoreAsync(Guid projectId, Guid ownerId, int versionNumber, CancellationToken cancellationToken) =>
            throw new InvalidOperationException("fallo de base de datos simulado");

        public Task<Layer?> UpdateLayerAsync(Guid projectId, Guid ownerId, Guid layerId, LayerPatch patch, CancellationToken cancellationToken) =>
            throw new InvalidOperationException("fallo de base de datos simulado");
    }
}

/*
 * Verificación MANUAL de reinicio real de containers (spec.md "Tests", no automatizable con
 * Testcontainers porque cada test ya levanta/destruye su propio Postgres efímero):
 *
 * 1. docker compose up -d (Postgres + Web API + frontend reales, ver docker-compose.yml).
 * 2. Abrir el Workspace en el navegador, guardar un documento (botón "Guardar"), anotar la URL
 *    resultante (incluye savedProjectId).
 * 3. docker compose down && docker compose up -d (reinicio REAL: Postgres pierde su estado de
 *    proceso en memoria, el volumen de datos persiste).
 * 4. Recargar el navegador pegando la URL anotada en el paso 2 (frontend recargado desde cero).
 * 5. Verificar que el documento reaparece completo y equivalente (mismos layers/colores/
 *    dimensiones) vía GET /api/v2/projects/{projectId}/document -- sin volver a pasar por el
 *    flujo clásico de vectorización.
 */
