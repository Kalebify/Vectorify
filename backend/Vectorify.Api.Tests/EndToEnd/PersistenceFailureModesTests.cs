using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Npgsql;
using Testcontainers.PostgreSql;
using Vectorify.Api.Contracts;
using Vectorify.Api.Data;
using Vectorify.Api.Storage;
using Vectorify.Api.Tests.TestSupport;

namespace Vectorify.Api.Tests.EndToEnd;

/// <summary>
/// Fallos recuperables de la persistencia (M2.2-S10, spec §2), con la Web API real contra PostgreSQL real
/// (Testcontainers) y storage real en disco -- deterministas, sin depender de tiempos:
/// <list type="bullet">
/// <item><b>DB no disponible</b>: un proxy TCP entre la API y Postgres (<see cref="TcpForwardingProxy"/>) corta y
/// restablece la conexión a voluntad. Los endpoints v2 deben responder 503 con <see cref="ApiErrorResponse"/>
/// (<c>database_unavailable</c>), nunca 500 con stack, el health debe reflejarlo y la API debe recuperarse sola.</item>
/// <item><b>Storage no disponible</b>: <see cref="SwitchableFailingFileStorage"/> lanza al leer/escribir. Save
/// devuelve un error controlado y no deja filas de documento a medias; un documento con un SVG faltante en disco se
/// abre igual.</item>
/// </list>
/// </summary>
public sealed class PersistenceFailureModesTests : IAsyncLifetime
{
    private readonly PostgreSqlContainer _postgres = new PostgreSqlBuilder("postgres:17-alpine").Build();
    private readonly PersistenceDataRoot _dataRoot = new("failure-modes");

    public Task InitializeAsync() => _postgres.StartAsync();

    public async Task DisposeAsync()
    {
        _dataRoot.Dispose();
        await _postgres.DisposeAsync();
    }

    // ---------- DB no disponible ----------

    [Fact]
    public async Task DatabaseDown_V2EndpointsReturnControlled503_HealthReflectsIt_AndTheApiRecoversWithoutRestart()
    {
        await using var proxy = new TcpForwardingProxy(_postgres.Hostname, _postgres.GetMappedPublicPort(5432));
        proxy.Start();
        await using var python = await FakePythonPreprocessServer.StartAsync(_ => (200, "{}"));
        await using var factory = PersistenceHosts.Create(ConnectionStringThrough(proxy), python.BaseUrl, _dataRoot);
        var client = factory.CreateClient();
        client.Timeout = TimeSpan.FromSeconds(30);

        var createResponse = await client.PostAsJsonAsync("/api/v2/projects", new CreateProjectRequest("Sobrevive a la caída", null));
        Assert.Equal(HttpStatusCode.Created, createResponse.StatusCode);
        var project = (await createResponse.Content.ReadFromJsonAsync<ProjectResponse>())!;

        proxy.Stop(); // "docker compose stop postgres"

        var stopwatch = Stopwatch.StartNew();
        await AssertControlledDatabaseOutageAsync(await client.GetAsync("/api/v2/projects"));
        await AssertControlledDatabaseOutageAsync(await client.GetAsync($"/api/v2/projects/{project.Id}"));
        await AssertControlledDatabaseOutageAsync(await client.GetAsync($"/api/v2/projects/{project.Id}/document"));
        await AssertControlledDatabaseOutageAsync(await client.GetAsync($"/api/v2/projects/{project.Id}/versions"));
        await AssertControlledDatabaseOutageAsync(await client.GetAsync($"/api/v2/projects/{project.Id}/assets/{Guid.NewGuid()}"));
        await AssertControlledDatabaseOutageAsync(
            await client.PostAsJsonAsync("/api/v2/projects", new CreateProjectRequest("Durante la caída", null)));
        await AssertControlledDatabaseOutageAsync(
            await client.PostAsJsonAsync("/api/v2/workspaces/save", new VectorDocumentSaveRequest(
                project.Id, null, Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), 1, null, IdempotencyKey: "k-" + Guid.NewGuid().ToString("n"))));
        Assert.True(stopwatch.Elapsed < TimeSpan.FromSeconds(25), $"Las respuestas durante la caída tardaron {stopwatch.Elapsed} (¿colgadas?)");

        // El health compuesto sigue respondiendo 200 y refleja la caída (ya lo hacía desde M2.2-S01).
        var healthResponse = await client.GetAsync("/api/v1/system/health");
        Assert.Equal(HttpStatusCode.OK, healthResponse.StatusCode);
        var health = (await healthResponse.Content.ReadFromJsonAsync<SystemHealthResponse>())!;
        Assert.Equal("degraded", health.Status);
        Assert.Equal("unavailable", health.Database.Status);

        proxy.Start(); // "docker compose start postgres": el MISMO proceso de la API, sin reiniciarlo

        var listResponse = await client.GetAsync("/api/v2/projects");
        Assert.Equal(HttpStatusCode.OK, listResponse.StatusCode);
        var list = (await listResponse.Content.ReadFromJsonAsync<ProjectListResponse>())!;
        Assert.Contains(list.Items, item => item.Id == project.Id);
        var recoveredHealth = (await client.GetFromJsonAsync<SystemHealthResponse>("/api/v1/system/health"))!;
        Assert.Equal("online", recoveredHealth.Database.Status);
    }

    [Fact]
    public async Task DatabaseBounce_WithNoRequestsDuringTheOutage_RecoversWithinAFewAttempts_NeverWithAnUncontrolledError()
    {
        // Variante del caso anterior: nadie toca la API mientras Postgres está caído, así que las conexiones
        // ociosas del pool de Npgsql quedan MUERTAS sin que la API lo sepa. La primera request tras la vuelta
        // puede toparse con una; tiene que ser un 503 controlado (no un 500) y la siguiente ya debe funcionar.
        await using var proxy = new TcpForwardingProxy(_postgres.Hostname, _postgres.GetMappedPublicPort(5432));
        proxy.Start();
        await using var python = await FakePythonPreprocessServer.StartAsync(_ => (200, "{}"));
        await using var factory = PersistenceHosts.Create(ConnectionStringThrough(proxy), python.BaseUrl, _dataRoot);
        var client = factory.CreateClient();
        client.Timeout = TimeSpan.FromSeconds(30);

        // Calienta el pool con varias conexiones concurrentes.
        await Task.WhenAll(Enumerable.Range(0, 4).Select(_ => client.GetAsync("/api/v2/projects")));

        proxy.Stop();
        proxy.Start();

        var statuses = new List<HttpStatusCode>();
        for (var attempt = 0; attempt < 6 && (statuses.Count == 0 || statuses[^1] != HttpStatusCode.OK); attempt++)
        {
            var response = await client.GetAsync("/api/v2/projects");
            statuses.Add(response.StatusCode);
            if (response.StatusCode != HttpStatusCode.OK)
            {
                await AssertControlledDatabaseOutageAsync(response);
            }
        }

        Assert.Equal(HttpStatusCode.OK, statuses[^1]);
        // Tras el primer 503 (pool limpiado), el siguiente intento ya es 200: nunca una racha de errores.
        Assert.True(statuses.Count <= 2, $"La API tardó {statuses.Count} intentos en recuperarse: {string.Join(", ", statuses)}");
    }

    // ---------- Storage no disponible ----------

    [Fact]
    public async Task Save_WhenStorageCannotBeRead_ReturnsControlled503_AndLeavesNoDocumentRowsNorAGhostProject()
    {
        await using var python = await StartMulticolorPythonAsync();
        await using var factory = CreateFactoryWithSwitchableStorage(python.BaseUrl);
        var client = factory.CreateClient();
        var classic = await ClassicWorkspaceFlow.RunAsync(client);

        var storage = (SwitchableFailingFileStorage)factory.Services.GetRequiredService<IFileStorage>();
        storage.FailReads = true; // el storage deja de responder justo antes del Save

        var response = await client.PostAsJsonAsync("/api/v2/workspaces/save", classic.ToSaveRequest(null, "Storage caído"));

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        var error = await response.Content.ReadFromJsonAsync<ApiErrorResponse>();
        Assert.Equal("storage_failure", error!.Code);
        Assert.DoesNotContain("FileStorageException", error.Message);

        await AssertNoDocumentRowsAsync(factory);
        var list = await client.GetFromJsonAsync<ProjectListResponse>("/api/v2/projects");
        Assert.Empty(list!.Items); // el proyecto creado por el primer Save se descarta, no queda fantasma en Mis Proyectos
    }

    [Fact]
    public async Task Save_WhenStorageFailsWritingTheSecondLayer_ReturnsControlledError_AndLeavesNoDocumentRows()
    {
        await using var python = await StartMulticolorPythonAsync();
        await using var factory = CreateFactoryWithSwitchableStorage(python.BaseUrl);
        var client = factory.CreateClient();
        var classic = await ClassicWorkspaceFlow.RunAsync(client);
        Assert.Equal(2, classic.LayerGroupIds.Count);

        // Deja pasar el SVG de la PRIMERA capa y falla en la segunda: el peor momento para caerse.
        var layerSvgWrites = 0;
        var storage = (SwitchableFailingFileStorage)factory.Services.GetRequiredService<IFileStorage>();
        storage.FailWriteWhen = key => key.Contains("/layer-svg/", StringComparison.Ordinal) && Interlocked.Increment(ref layerSvgWrites) == 2;

        var response = await client.PostAsJsonAsync("/api/v2/workspaces/save", classic.ToSaveRequest(null, "Se cae a la mitad"));

        Assert.Equal((HttpStatusCode)422, response.StatusCode);
        var error = await response.Content.ReadFromJsonAsync<ApiErrorResponse>();
        Assert.Equal("storage_failure", error!.Code);

        await AssertNoDocumentRowsAsync(factory);
        Assert.Empty((await client.GetFromJsonAsync<ProjectListResponse>("/api/v2/projects"))!.Items);

        // Trade-off documentado (AssetService): el SVG de la primera capa SÍ quedó subido (fila + archivo), pero
        // cuelga de un proyecto descartado (soft-delete) y ninguna capa lo referencia -- no es una inconsistencia
        // DB<->storage (el verificador no lo marca como huérfano) ni se ve desde la API.
        await using var scope = factory.Services.CreateAsyncScope();
        var dbContext = scope.ServiceProvider.GetRequiredService<VectorizationDbContext>();
        var leftoverAssets = await dbContext.Assets.IgnoreQueryFilters().Where(a => a.Type == "layer-svg").ToListAsync();
        Assert.Single(leftoverAssets);
        Assert.True(await factory.Services.GetRequiredService<IFileStorage>().ExistsAsync(leftoverAssets[0].StorageKey, CancellationToken.None));
        Assert.True(await dbContext.Projects.IgnoreQueryFilters().AllAsync(p => p.DeletedAt != null));
    }

    [Fact]
    public async Task GetDocument_WhenALayerSvgFileIsMissingFromStorage_StillOpens_AndOnlyThatAssetDownloadIsNotFound()
    {
        await using var python = await StartMulticolorPythonAsync();
        await using var factory = CreateFactoryWithSwitchableStorage(python.BaseUrl);
        var client = factory.CreateClient();
        var classic = await ClassicWorkspaceFlow.RunAsync(client);
        var saveBody = await SaveAsync(client, classic, "Con un SVG perdido");

        var before = (await client.GetFromJsonAsync<VectorDocumentResponse>($"/api/v2/projects/{saveBody.ProjectId}/document"))!;
        var lostLayer = before.Layers[0];

        // Alguien borró a mano el archivo del SVG de la primera capa (la fila de Asset sigue en la base).
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var dbContext = scope.ServiceProvider.GetRequiredService<VectorizationDbContext>();
            var asset = await dbContext.Assets.SingleAsync(a => a.Id == lostLayer.SvgAssetId);
            await factory.Services.GetRequiredService<IFileStorage>().DeleteAsync(asset.StorageKey, CancellationToken.None);
        }

        var response = await client.GetAsync($"/api/v2/projects/{saveBody.ProjectId}/document");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode); // el documento se abre igual
        var after = (await response.Content.ReadFromJsonAsync<VectorDocumentResponse>())!;
        Assert.Equal(before.Layers.Select(l => l.Id), after.Layers.Select(l => l.Id));
        Assert.Equal(before.Layers.Select(l => l.Name), after.Layers.Select(l => l.Name));

        // La capa perdida lo informa por su SvgUrl: descargarla da el 404 uniforme; las demás siguen bajando.
        var lostDownload = await client.GetAsync(after.Layers[0].SvgUrl);
        Assert.Equal(HttpStatusCode.NotFound, lostDownload.StatusCode);
        Assert.Equal("not_found", (await lostDownload.Content.ReadFromJsonAsync<ApiErrorResponse>())!.Code);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync(after.Layers[1].SvgUrl)).StatusCode);

        // El listado (Mis Proyectos) y el thumbnail tampoco dependen de ese archivo.
        var list = (await client.GetFromJsonAsync<ProjectListResponse>("/api/v2/projects"))!;
        Assert.Equal(2, Assert.Single(list.Items).LayerCount);
    }

    [Fact]
    public async Task AssetDownload_WhenStorageStopsResponding_ReturnsControlled503_WhileTheDocumentStillOpens()
    {
        await using var python = await StartMulticolorPythonAsync();
        await using var factory = CreateFactoryWithSwitchableStorage(python.BaseUrl);
        var client = factory.CreateClient();
        var classic = await ClassicWorkspaceFlow.RunAsync(client);
        var saveBody = await SaveAsync(client, classic, "Storage intermitente");
        var document = (await client.GetFromJsonAsync<VectorDocumentResponse>($"/api/v2/projects/{saveBody.ProjectId}/document"))!;

        var storage = (SwitchableFailingFileStorage)factory.Services.GetRequiredService<IFileStorage>();
        storage.FailReads = true;

        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync($"/api/v2/projects/{saveBody.ProjectId}/document")).StatusCode);
        var download = await client.GetAsync(document.Layers[0].SvgUrl);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, download.StatusCode);
        Assert.Equal("storage_failure", (await download.Content.ReadFromJsonAsync<ApiErrorResponse>())!.Code);

        storage.FailReads = false; // el storage vuelve: la misma API sirve el archivo
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync(document.Layers[0].SvgUrl)).StatusCode);
    }

    // ---------- helpers ----------

    private string ConnectionStringThrough(TcpForwardingProxy proxy)
    {
        var builder = new NpgsqlConnectionStringBuilder(_postgres.GetConnectionString())
        {
            Host = "127.0.0.1",
            Port = proxy.Port,
            Timeout = 5, // segundos para abrir conexión: acota cualquier espera durante la caída
            CommandTimeout = 10,
        };
        return builder.ConnectionString;
    }

    private static async Task AssertControlledDatabaseOutageAsync(HttpResponseMessage response)
    {
        var raw = await response.Content.ReadAsStringAsync();
        Assert.True(
            response.StatusCode == HttpStatusCode.ServiceUnavailable,
            $"Se esperaba 503 con la base caída y fue {(int)response.StatusCode}: {Truncate(raw)}");
        Assert.Equal("application/json", response.Content.Headers.ContentType?.MediaType);

        var error = System.Text.Json.JsonSerializer.Deserialize<ApiErrorResponse>(
            raw, new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web));
        Assert.Equal("database_unavailable", error!.Code);
        Assert.False(string.IsNullOrWhiteSpace(error.Message));

        // Nunca filtra detalles internos (stack, nombre de excepción, host/credenciales de la conexión).
        Assert.DoesNotContain("Npgsql", raw);
        Assert.DoesNotContain("   at ", raw);
        Assert.DoesNotContain("Exception", raw);
        Assert.DoesNotContain("127.0.0.1", raw);
    }

    private static string Truncate(string text) => text.Length <= 300 ? text : text[..300] + "…";

    private static async Task AssertNoDocumentRowsAsync(WebApplicationFactory<Program> factory)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var dbContext = scope.ServiceProvider.GetRequiredService<VectorizationDbContext>();
        Assert.False(await dbContext.VectorDocuments.AnyAsync(), "Quedó un VectorDocument a medias");
        Assert.False(await dbContext.DocumentVersions.AnyAsync(), "Quedó una DocumentVersion a medias");
        Assert.False(await dbContext.Layers.AnyAsync(), "Quedó una Layer a medias");
        Assert.False(await dbContext.PaletteColors.AnyAsync(), "Quedó un PaletteColor a medias");
    }

    private static async Task<VectorDocumentSaveResponse> SaveAsync(HttpClient client, ClassicWorkspaceSession classic, string name)
    {
        var response = await client.PostAsJsonAsync("/api/v2/workspaces/save", classic.ToSaveRequest(null, name));
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<VectorDocumentSaveResponse>())!;
    }

    private static Task<FakePythonPreprocessServer> StartMulticolorPythonAsync() =>
        FakePythonPreprocessServer.StartAsync(
            _ => (200, "{}"),
            respondColorPalette: _ => (200, ColorPalettePayloads.MultiGroupSuccessBody(1, 1, "#ff0000", "#00ff00")));

    private WebApplicationFactory<Program> CreateFactoryWithSwitchableStorage(string pythonBaseUrl) =>
        PersistenceHosts.Create(_postgres.GetConnectionString(), pythonBaseUrl, _dataRoot, services =>
        {
            services.RemoveAll<IFileStorage>();
            services.AddSingleton<IFileStorage>(sp =>
                new SwitchableFailingFileStorage(ActivatorUtilities.CreateInstance<LocalFileStorage>(sp)));
        });
}
