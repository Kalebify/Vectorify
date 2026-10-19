using System.Security.Cryptography;
using Microsoft.EntityFrameworkCore;
using Testcontainers.PostgreSql;
using Vectorify.Api.Assets.Persistence;
using Vectorify.Api.Data;

namespace Vectorify.Api.Tests.Assets.Persistence;

/// <summary>
/// Tests de integración de <see cref="AssetRepository"/> (M2.2-S04) directamente contra
/// PostgreSQL real (Testcontainers, nunca UseInMemoryDatabase -- mismo criterio que
/// S01-S03). Ejercita el repositorio sin pasar por AssetService ni por HTTP -- el round-trip
/// completo con storage real lo cubre Vectorify.Api.Tests.EndToEnd.AssetEndpointsTests.
/// </summary>
public sealed class AssetRepositoryTests : IAsyncLifetime
{
    private readonly TestPostgres _postgres = new();

    public Task InitializeAsync() => _postgres.StartAsync();

    public Task DisposeAsync() => _postgres.DisposeAsync().AsTask();

    [Fact]
    public async Task CreateAsync_PersistsAsset_ReadableAfterwards()
    {
        await using var dbContext = await CreateMigratedDbContextAsync();
        var project = await SeedProjectAsync(dbContext);
        var repository = new AssetRepository(dbContext);
        var asset = BuildAsset(project.Id);

        var created = await repository.CreateAsync(asset, CancellationToken.None);

        Assert.Equal(asset.Id, created.Id);

        var found = await repository.FindByIdAsync(project.Id, asset.Id, CancellationToken.None);
        Assert.NotNull(found);
        Assert.Equal(asset.StorageKey, found!.StorageKey);
        Assert.Equal(asset.Checksum, found.Checksum);
    }

    [Fact]
    public async Task FindByIdAsync_WhenAssetBelongsToAnotherProject_ReturnsNull()
    {
        await using var dbContext = await CreateMigratedDbContextAsync();
        var project = await SeedProjectAsync(dbContext);
        var otherProject = await SeedProjectAsync(dbContext);
        var repository = new AssetRepository(dbContext);
        var asset = await repository.CreateAsync(BuildAsset(project.Id), CancellationToken.None);

        var found = await repository.FindByIdAsync(otherProject.Id, asset.Id, CancellationToken.None);

        Assert.Null(found);
    }

    [Fact]
    public async Task FindByIdAsync_NonexistentId_ReturnsNull()
    {
        await using var dbContext = await CreateMigratedDbContextAsync();
        var project = await SeedProjectAsync(dbContext);
        var repository = new AssetRepository(dbContext);

        var found = await repository.FindByIdAsync(project.Id, Guid.NewGuid(), CancellationToken.None);

        Assert.Null(found);
    }

    [Fact]
    public async Task DeleteRowAsync_WhenAssetExists_RemovesItAndReturnsTrue()
    {
        await using var dbContext = await CreateMigratedDbContextAsync();
        var project = await SeedProjectAsync(dbContext);
        var repository = new AssetRepository(dbContext);
        var asset = await repository.CreateAsync(BuildAsset(project.Id), CancellationToken.None);

        var deleted = await repository.DeleteRowAsync(project.Id, asset.Id, CancellationToken.None);

        Assert.True(deleted);
        Assert.Null(await repository.FindByIdAsync(project.Id, asset.Id, CancellationToken.None));
    }

    [Fact]
    public async Task DeleteRowAsync_NonexistentOrWrongProject_ReturnsFalse()
    {
        await using var dbContext = await CreateMigratedDbContextAsync();
        var project = await SeedProjectAsync(dbContext);
        var repository = new AssetRepository(dbContext);

        var deleted = await repository.DeleteRowAsync(project.Id, Guid.NewGuid(), CancellationToken.None);

        Assert.False(deleted);
    }

    private static Asset BuildAsset(Guid projectId)
    {
        var assetId = Guid.NewGuid();
        var content = new byte[] { 1, 2, 3, 4, 5 };
        return new Asset
        {
            Id = assetId,
            ProjectId = projectId,
            Type = "original",
            StorageKey = $"projects/{projectId:N}/original/{assetId:N}.png",
            MimeType = "image/png",
            FileName = "original.png",
            Size = content.Length,
            Checksum = Convert.ToHexStringLower(SHA256.HashData(content)),
            CreatedAt = DateTimeOffset.UtcNow,
        };
    }

    private static async Task<Project> SeedProjectAsync(VectorizationDbContext dbContext)
    {
        var user = new User
        {
            Id = Guid.NewGuid(),
            DisplayName = "Usuario de prueba",
            CreatedAt = DateTimeOffset.UtcNow,
        };
        var project = new Project
        {
            Id = Guid.NewGuid(),
            OwnerId = user.Id,
            Name = "Proyecto de prueba",
            CreatedAt = DateTimeOffset.UtcNow,
            UpdatedAt = DateTimeOffset.UtcNow,
        };

        dbContext.Users.Add(user);
        dbContext.Projects.Add(project);
        await dbContext.SaveChangesAsync();

        return project;
    }

    private async Task<VectorizationDbContext> CreateMigratedDbContextAsync()
    {
        var dbContext = CreateDbContext();
        await dbContext.Database.MigrateAsync();
        return dbContext;
    }

    private VectorizationDbContext CreateDbContext()
    {
        var options = new DbContextOptionsBuilder<VectorizationDbContext>()
            .UseNpgsql(_postgres.GetConnectionString())
            .Options;
        return new VectorizationDbContext(options);
    }
}
