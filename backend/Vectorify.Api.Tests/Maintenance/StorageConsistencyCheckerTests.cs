using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Testcontainers.PostgreSql;
using Vectorify.Api.Contracts;
using Vectorify.Api.Data;
using Vectorify.Api.Maintenance;
using Vectorify.Api.Tests.TestSupport;

namespace Vectorify.Api.Tests.Maintenance;

/// <summary>
/// Verificador de consistencia DB&lt;-&gt;storage (M2.2-S10) contra la Web API real: PostgreSQL real
/// (Testcontainers, una base distinta por test dentro del mismo container) y storage real en disco. Cubre el
/// "archivo huérfano" de la spec §2: fila sin archivo, archivo sin fila, solo lectura por defecto y borrado solo
/// con flag explícito, y el comando de línea de comandos (<c>--check-consistency</c>) que lo envuelve.
/// </summary>
public sealed class StorageConsistencyCheckerTests : IClassFixture<StorageConsistencyCheckerTests.PostgresFixture>, IAsyncLifetime
{
    private readonly PostgresFixture _fixture;
    private readonly PersistenceDataRoot _dataRoot = new("consistency");
    private FakePythonPreprocessServer _python = null!;
    private WebApplicationFactory<Program> _factory = null!;
    private HttpClient _client = null!;

    public StorageConsistencyCheckerTests(PostgresFixture fixture)
    {
        _fixture = fixture;
    }

    public async Task InitializeAsync()
    {
        _python = await FakePythonPreprocessServer.StartAsync(
            _ => (200, "{}"),
            respondColorPalette: _ => (200, ColorPalettePayloads.MultiGroupSuccessBody(1, 1, "#ff0000", "#00ff00")));
        _factory = PersistenceHosts.Create(_fixture.NewDatabaseConnectionString(), _python.BaseUrl, _dataRoot);
        _client = _factory.CreateClient();
    }

    public async Task DisposeAsync()
    {
        _client.Dispose();
        await _factory.DisposeAsync();
        await _python.DisposeAsync();
        _dataRoot.Dispose();
    }

    [Fact]
    public async Task Check_OnAFreshlySavedProject_IsConsistent_AndIgnoresClassicPipelineFiles()
    {
        await SaveProjectAsync("Consistente");

        var report = await CheckAsync(new ConsistencyCheckOptions(VerifyChecksums: true));

        Assert.True(report.IsConsistent);
        Assert.Equal(3, report.AssetRows); // 2 SVG de capa + 1 thumbnail
        Assert.Equal(3, report.AssetFilesInStorage);
        Assert.True(report.InventorySupported);
        Assert.True(report.ChecksumsVerified);

        // El original y los SVG del pipeline clásico viven en el mismo storage pero SIN fila de Asset por diseño:
        // no cuentan como huérfanos.
        var allFiles = Directory.EnumerateFiles(_dataRoot.StoragePath, "*", SearchOption.AllDirectories).Count();
        Assert.True(allFiles > report.AssetFilesInStorage);
    }

    [Fact]
    public async Task Check_WhenAnAssetFileIsMissing_ReportsItWithoutDeletingAnything()
    {
        var projectId = await SaveProjectAsync("Archivo perdido");
        var asset = await FirstLayerAssetAsync(projectId);
        File.Delete(FilePathOf(asset));

        var report = await CheckAsync(new ConsistencyCheckOptions());

        Assert.False(report.IsConsistent);
        var missing = Assert.Single(report.AssetsWithoutFile);
        Assert.Equal(asset.Id, missing.AssetId);
        Assert.Equal(projectId, missing.ProjectId);
        Assert.Equal(asset.StorageKey, missing.StorageKey);
        Assert.False(missing.ProjectDeleted);
        Assert.Empty(report.FilesWithoutAsset);
        await AssertAssetRowCountAsync(3); // solo lectura: la fila sigue
    }

    [Fact]
    public async Task Check_WhenThereAreOrphanFiles_ReportsThem_AndByDefaultDeletesNothing()
    {
        await SaveProjectAsync("Con huérfanos");
        var orphan = PlantFile($"projects/{Guid.NewGuid():N}/layer-svg/{Guid.NewGuid():N}.svg", "<svg/>");
        var abandonedTemp = PlantFile($"projects/{Guid.NewGuid():N}/thumbnail/{Guid.NewGuid():N}.png.tmp", "parcial");

        var report = await CheckAsync(new ConsistencyCheckOptions());

        Assert.False(report.IsConsistent);
        Assert.Equal(2, report.FilesWithoutAsset.Count);
        Assert.Contains(report.FilesWithoutAsset, f => f.Key.EndsWith(".svg", StringComparison.Ordinal) && f.SizeBytes == 6);
        Assert.Contains(report.FilesWithoutAsset, f => f.Key.EndsWith(".tmp", StringComparison.Ordinal));
        Assert.All(report.FilesWithoutAsset, f => Assert.False(f.Deleted));
        Assert.Empty(report.AssetsWithoutFile);
        Assert.True(File.Exists(orphan)); // solo lectura por defecto
        Assert.True(File.Exists(abandonedTemp));
    }

    [Fact]
    public async Task Check_WithDeleteFlag_DeletesOnlyOrphanFilesOlderThanTheMinimumAge_NeverRows()
    {
        await SaveProjectAsync("Limpieza");
        var oldOrphan = PlantFile($"projects/{Guid.NewGuid():N}/layer-svg/{Guid.NewGuid():N}.svg", "viejo");
        File.SetLastWriteTimeUtc(oldOrphan, DateTime.UtcNow.AddHours(-2));
        var freshOrphan = PlantFile($"projects/{Guid.NewGuid():N}/layer-svg/{Guid.NewGuid():N}.svg", "recien-subido");

        // Edad mínima por defecto (10 min): el recién subido podría ser un upload en curso -> no se toca.
        var report = await CheckAsync(new ConsistencyCheckOptions(DeleteOrphanFiles: true));

        Assert.False(File.Exists(oldOrphan));
        Assert.True(File.Exists(freshOrphan));
        Assert.Contains(report.FilesWithoutAsset, f => f.Deleted);
        Assert.Contains(report.FilesWithoutAsset, f => !f.Deleted);
        Assert.False(report.IsConsistent); // el reciente sigue pendiente
        await AssertAssetRowCountAsync(3); // nunca borra filas

        // Con edad mínima 0 también se lleva el reciente y el storage queda consistente.
        var second = await CheckAsync(new ConsistencyCheckOptions(DeleteOrphanFiles: true, OrphanMinAge: TimeSpan.Zero));
        Assert.False(File.Exists(freshOrphan));
        Assert.True(second.IsConsistent);
        Assert.True((await CheckAsync(new ConsistencyCheckOptions())).IsConsistent);
    }

    [Fact]
    public async Task Check_WithVerifyChecksums_DetectsCorruptedAssetBytes_ButNotWithoutTheFlag()
    {
        var projectId = await SaveProjectAsync("Bytes alterados");
        var asset = await FirstLayerAssetAsync(projectId);
        await File.WriteAllTextAsync(FilePathOf(asset), "contenido alterado");

        Assert.True((await CheckAsync(new ConsistencyCheckOptions())).IsConsistent); // sin el flag no lee los archivos

        var report = await CheckAsync(new ConsistencyCheckOptions(VerifyChecksums: true));
        Assert.False(report.IsConsistent);
        var mismatch = Assert.Single(report.ChecksumMismatches);
        Assert.Equal(asset.Id, mismatch.AssetId);
        Assert.NotEqual(mismatch.ExpectedChecksum, mismatch.ActualChecksum);
    }

    [Fact]
    public async Task Check_AfterSoftDeletingAProject_StillCountsItsAssetsAsReferenced()
    {
        var projectId = await SaveProjectAsync("Eliminado");
        Assert.Equal(HttpStatusCode.NoContent, (await _client.DeleteAsync($"/api/v2/projects/{projectId}")).StatusCode);

        // El soft-delete conserva filas y archivos (S03): ni "sin archivo" ni "huérfanos" aunque el proyecto ya no se vea.
        var report = await CheckAsync(new ConsistencyCheckOptions(VerifyChecksums: true));
        Assert.True(report.IsConsistent);
        Assert.Equal(3, report.AssetRows);
    }

    [Fact]
    public async Task Command_PrintsAReadableReportAndReturnsTheExitCode()
    {
        var projectId = await SaveProjectAsync("Por comando");

        var okOutput = new StringWriter();
        var okExit = await ConsistencyCheckCommand.RunAsync(_factory.Services, ["--check-consistency", "--verify-checksums"], okOutput);
        Assert.Equal(0, okExit);
        Assert.Contains("RESULTADO: consistente.", okOutput.ToString());
        Assert.Contains("Filas de assets en la base      : 3", okOutput.ToString());

        File.Delete(FilePathOf(await FirstLayerAssetAsync(projectId)));
        var orphan = PlantFile($"projects/{Guid.NewGuid():N}/layer-svg/{Guid.NewGuid():N}.svg", "x");
        var badOutput = new StringWriter();
        var badExit = await ConsistencyCheckCommand.RunAsync(_factory.Services, ["--check-consistency"], badOutput);
        Assert.Equal(1, badExit);
        var text = badOutput.ToString();
        Assert.Contains("RESULTADO: INCONSISTENTE.", text);
        Assert.Contains("Assets SIN archivo en el storage: 1", text);
        Assert.Contains("Archivos SIN asset en la base (huérfanos): 1", text);
        Assert.Contains("Modo solo lectura: no se borró nada", text);
        Assert.True(File.Exists(orphan));
    }

    [Fact]
    public async Task Command_WhenTheDatabaseIsUnreachable_ReturnsExitCode2_WithoutLeakingConnectionDetails()
    {
        var unreachable = new NpgsqlConnectionStringBuilder(_fixture.NewDatabaseConnectionString())
        {
            Host = "127.0.0.1", Port = 1, Password = "super-secreta", Timeout = 2,
        }.ConnectionString;
        await using var broken = PersistenceHosts.Create(unreachable, _python.BaseUrl, _dataRoot);

        var output = new StringWriter();
        var exit = await ConsistencyCheckCommand.RunAsync(broken.Services, ["--check-consistency"], output);

        Assert.Equal(2, exit);
        Assert.Contains("ERROR: no se pudo completar la verificación", output.ToString());
        Assert.DoesNotContain("super-secreta", output.ToString());
    }

    [Fact]
    public void Command_ParsesFlags_AndOnlyReactsToTheExactCommandFlag()
    {
        Assert.True(ConsistencyCheckCommand.IsRequested(["--check-consistency"]));
        Assert.True(ConsistencyCheckCommand.IsRequested(["--urls=http://x", "--CHECK-CONSISTENCY"]));
        Assert.False(ConsistencyCheckCommand.IsRequested([]));
        Assert.False(ConsistencyCheckCommand.IsRequested(["--check-consistency-no"]));

        var defaults = ConsistencyCheckCommand.ParseOptions(["--check-consistency"]);
        Assert.False(defaults.VerifyChecksums);
        Assert.False(defaults.DeleteOrphanFiles); // solo lectura por defecto
        Assert.Equal(TimeSpan.FromMinutes(10), defaults.OrphanMinAge);

        var all = ConsistencyCheckCommand.ParseOptions(
            ["--check-consistency", "--verify-checksums", "--delete-orphan-files", "--orphan-min-age-minutes=0.5"]);
        Assert.True(all.VerifyChecksums);
        Assert.True(all.DeleteOrphanFiles);
        Assert.Equal(TimeSpan.FromSeconds(30), all.OrphanMinAge);
    }

    // ---------------------------------------------------------------- helpers

    private async Task<ConsistencyReport> CheckAsync(ConsistencyCheckOptions options)
    {
        await using var scope = _factory.Services.CreateAsyncScope();
        var checker = ActivatorUtilities.CreateInstance<StorageConsistencyChecker>(scope.ServiceProvider);
        return (await checker.CheckAsync(options, CancellationToken.None)).Report;
    }

    private async Task<Guid> SaveProjectAsync(string name)
    {
        var classic = await ClassicWorkspaceFlow.RunAsync(_client);
        var response = await _client.PostAsJsonAsync("/api/v2/workspaces/save", classic.ToSaveRequest(null, name));
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<VectorDocumentSaveResponse>())!.ProjectId;
    }

    private async Task<Asset> FirstLayerAssetAsync(Guid projectId)
    {
        await using var scope = _factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<VectorizationDbContext>();
        return await db.Assets.AsNoTracking().OrderBy(a => a.StorageKey)
            .FirstAsync(a => a.ProjectId == projectId && a.Type == "layer-svg");
    }

    private async Task AssertAssetRowCountAsync(int expected)
    {
        await using var scope = _factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<VectorizationDbContext>();
        Assert.Equal(expected, await db.Assets.CountAsync());
    }

    private string FilePathOf(Asset asset) => Path.Combine(_dataRoot.StoragePath, asset.StorageKey.Replace('/', Path.DirectorySeparatorChar));

    private string PlantFile(string key, string content)
    {
        var path = Path.Combine(_dataRoot.StoragePath, key.Replace('/', Path.DirectorySeparatorChar));
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, content);
        return path;
    }

    /// <summary>Un único container Postgres para toda la clase; cada test usa su propia base (así las filas de assets no se mezclan).</summary>
    public sealed class PostgresFixture : IAsyncLifetime
    {
        private readonly PostgreSqlContainer _postgres = new PostgreSqlBuilder("postgres:17-alpine").Build();

        public Task InitializeAsync() => _postgres.StartAsync();

        public Task DisposeAsync() => _postgres.DisposeAsync().AsTask();

        public string NewDatabaseConnectionString() =>
            new NpgsqlConnectionStringBuilder(_postgres.GetConnectionString())
            {
                Database = "consistency_" + Guid.NewGuid().ToString("n"),
            }.ConnectionString;
    }
}
