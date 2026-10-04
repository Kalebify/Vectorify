using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Vectorify.Api.Options;
using Vectorify.Api.Projects;

namespace Vectorify.Api.Tests.Projects;

/// <summary>
/// Pruebas de PersistentProjectRegistry: guardar, encontrar por id/idempotency-key
/// (mismo contrato que la InMemoryProjectRegistry original) y, sobre todo, que un
/// registro sobrevive a "reiniciar el proceso" -- acá simulado recreando la instancia
/// apuntando al mismo directorio en disco (Defecto 4 de QA sobre M1-S02).
/// </summary>
public sealed class PersistentProjectRegistryTests : IDisposable
{
    private readonly string _rootPath = Path.Combine(Path.GetTempPath(), "vectorify-registry-tests-" + Guid.NewGuid().ToString("n"));

    private PersistentProjectRegistry CreateRegistry()
    {
        var environment = new FakeHostEnvironment { ContentRootPath = _rootPath };
        var options = Microsoft.Extensions.Options.Options.Create(new ProjectRegistryOptions { RootPath = "projects" });
        return new PersistentProjectRegistry(options, environment, NullLogger<PersistentProjectRegistry>.Instance);
    }

    private static ProjectRecord SampleRecord(string? idempotencyKey = null) => new(
        ProjectId: Guid.NewGuid(),
        ImageId: Guid.NewGuid(),
        FileName: "logo.png",
        MimeType: "image/png",
        Bytes: 4,
        Width: 1,
        Height: 1,
        Status: "uploaded",
        StorageKey: "proj/img/original.png",
        IdempotencyKey: idempotencyKey,
        CreatedAt: DateTimeOffset.UtcNow);

    [Fact]
    public void Save_ThenFind_ReturnsTheSameRecordFromMemory()
    {
        var registry = CreateRegistry();
        var record = SampleRecord();

        registry.Save(record);

        var found = registry.Find(record.ProjectId, record.ImageId);
        Assert.NotNull(found);
        Assert.Equal(record.FileName, found!.FileName);
    }

    [Fact]
    public void Save_WritesASidecarJsonFileToDisk()
    {
        var registry = CreateRegistry();
        var record = SampleRecord();

        registry.Save(record);

        var expectedPath = Path.Combine(_rootPath, "projects", record.ProjectId.ToString("N"), $"{record.ImageId:N}.json");
        Assert.True(File.Exists(expectedPath));
        Assert.False(File.Exists(expectedPath + ".tmp"));
    }

    [Fact]
    public void Save_ThenRecreatingTheRegistryOnTheSameDirectory_StillFindsTheRecord()
    {
        var record = SampleRecord(idempotencyKey: "retry-abc");
        var firstRegistry = CreateRegistry();
        firstRegistry.Save(record);

        // Simula un reinicio del proceso: nueva instancia, mismo directorio en disco.
        var secondRegistry = CreateRegistry();

        var foundById = secondRegistry.Find(record.ProjectId, record.ImageId);
        Assert.NotNull(foundById);
        Assert.Equal(record.FileName, foundById!.FileName);
        Assert.Equal(record.Bytes, foundById.Bytes);
        Assert.Equal(record.StorageKey, foundById.StorageKey);

        var foundByKey = secondRegistry.FindByIdempotencyKey("retry-abc");
        Assert.NotNull(foundByKey);
        Assert.Equal(record.ProjectId, foundByKey!.ProjectId);
    }

    [Fact]
    public void Find_WhenRecordWasNeverSaved_ReturnsNull()
    {
        var registry = CreateRegistry();

        Assert.Null(registry.Find(Guid.NewGuid(), Guid.NewGuid()));
    }

    [Fact]
    public void FindByIdempotencyKey_WhenKeyIsNullOrWhitespace_ReturnsNull()
    {
        var registry = CreateRegistry();

        Assert.Null(registry.FindByIdempotencyKey(""));
        Assert.Null(registry.FindByIdempotencyKey("   "));
    }

    [Fact]
    public void LoadFromDisk_WhenTheSidecarJsonPredatesOwnerId_LoadsItWithoutOwner_AndItStaysAccessibleToAnyone()
    {
        // JSON tal como lo escribía el registry ANTES de M2.2-S09 (sin la propiedad OwnerId).
        var projectId = Guid.NewGuid();
        var imageId = Guid.NewGuid();
        var projectDir = Path.Combine(_rootPath, "projects", projectId.ToString("N"));
        Directory.CreateDirectory(projectDir);
        File.WriteAllText(Path.Combine(projectDir, $"{imageId:N}.json"), $$"""
            {
              "ProjectId": "{{projectId}}",
              "ImageId": "{{imageId}}",
              "FileName": "viejo.png",
              "MimeType": "image/png",
              "Bytes": 4,
              "Width": 1,
              "Height": 1,
              "Status": "uploaded",
              "StorageKey": "proj/img/original.png",
              "IdempotencyKey": null,
              "CreatedAt": "2026-01-01T00:00:00+00:00"
            }
            """);

        var record = CreateRegistry().Find(projectId, imageId);

        Assert.NotNull(record);
        Assert.Null(record!.OwnerId);
        Assert.True(record.IsAccessibleBy(Guid.NewGuid()));
    }

    [Fact]
    public void Save_WithOwner_PersistsItAcrossRestarts_AndOnlyTheOwnerCanAccessIt()
    {
        var ownerId = Guid.NewGuid();
        var record = SampleRecord() with { OwnerId = ownerId };
        CreateRegistry().Save(record);

        var reloaded = CreateRegistry().Find(record.ProjectId, record.ImageId);

        Assert.Equal(ownerId, reloaded!.OwnerId);
        Assert.True(reloaded.IsAccessibleBy(ownerId));
        Assert.False(reloaded.IsAccessibleBy(Guid.NewGuid()));
    }

    public void Dispose()
    {
        if (Directory.Exists(_rootPath))
        {
            Directory.Delete(_rootPath, recursive: true);
        }
    }

    private sealed class FakeHostEnvironment : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Test";
        public string ApplicationName { get; set; } = "Vectorify.Api.Tests";
        public string ContentRootPath { get; set; } = "";
        public Microsoft.Extensions.FileProviders.IFileProvider ContentRootFileProvider { get; set; } = null!;
    }
}
