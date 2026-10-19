using Microsoft.EntityFrameworkCore;
using Testcontainers.PostgreSql;
using Vectorify.Api.Data;
using Vectorify.Api.ManufacturingOperations;
using Vectorify.Api.VectorDocuments;

namespace Vectorify.Api.Tests.Data;

/// <summary>
/// Tests de integración del modelo REAL de dominio introducido por M2.2-S02 (User,
/// Project, Asset, VectorDocument, DocumentVersion, Layer, PaletteColor) -- mismo
/// criterio que <see cref="VectorizationDbContextTests"/> de M2.2-S01: PostgreSQL REAL
/// vía Testcontainers, NUNCA UseInMemoryDatabase (no prueba FKs/constraints/query
/// filters reales). Requiere Docker disponible en el entorno donde corren los tests.
/// Esta tarjeta no conecta nada de esto a la aplicación real -- estos tests ejercitan
/// el modelo EF directamente, sin pasar por ningún repositorio/endpoint (eso es
/// M2.2-S03).
/// </summary>
public sealed class DomainEntitiesTests : IAsyncLifetime
{
    private readonly TestPostgres _postgres = new();

    public Task InitializeAsync() => _postgres.StartAsync();

    public Task DisposeAsync() => _postgres.DisposeAsync().AsTask();

    [Fact]
    public async Task MigrateAsync_AppliesAddDomainEntities_FromScratch()
    {
        await using var dbContext = CreateDbContext();

        await dbContext.Database.MigrateAsync();

        var applied = await dbContext.Database.GetAppliedMigrationsAsync();
        Assert.Contains(applied, m => m.Contains("AddDomainEntities"));
    }

    [Fact]
    public async Task FullChain_UserProjectDocumentVersionLayerPaletteColor_PersistsCorrectly()
    {
        Guid userId, projectId, documentId, versionId, colorId, layerId;

        await using (var writeContext = CreateDbContext())
        {
            await writeContext.Database.MigrateAsync();

            var user = new User
            {
                Id = Guid.NewGuid(),
                DisplayName = "Ada Lovelace",
                Email = "ada@example.com",
                CreatedAt = DateTimeOffset.UtcNow,
            };

            var project = new Project
            {
                Id = Guid.NewGuid(),
                OwnerId = user.Id,
                Name = "Placa grabada",
                Description = "Proyecto de prueba de integración",
                CreatedAt = DateTimeOffset.UtcNow,
                UpdatedAt = DateTimeOffset.UtcNow,
            };

            var document = new VectorDocument
            {
                Id = Guid.NewGuid(),
                ProjectId = project.Id,
            };

            var version = new DocumentVersion
            {
                Id = Guid.NewGuid(),
                VectorDocumentId = document.Id,
                VersionNumber = 1,
                WidthMm = 100,
                HeightMm = 50,
                ViewBox = "0 0 1000 500",
                SchemaVersion = 1,
                Origin = DocumentVersionOrigin.Vectorize,
                MetadataJson = "{\"engine\":\"test\"}",
                CreatedAt = DateTimeOffset.UtcNow,
            };

            var color = new PaletteColor
            {
                Id = Guid.NewGuid(),
                VersionId = version.Id,
                Hex = "#112233",
                Coverage = 42.5,
                IsBackground = false,
                Order = 0,
            };

            var layer = new Layer
            {
                Id = Guid.NewGuid(),
                VersionId = version.Id,
                ColorId = color.Id,
                Name = "Capa 1",
                Order = 0,
                Visible = true,
                Locked = false,
                ManufacturingOperation = ManufacturingOperationKind.Cut,
            };

            writeContext.Users.Add(user);
            writeContext.Projects.Add(project);
            writeContext.VectorDocuments.Add(document);
            writeContext.DocumentVersions.Add(version);
            writeContext.PaletteColors.Add(color);
            writeContext.Layers.Add(layer);

            await writeContext.SaveChangesAsync();

            userId = user.Id;
            projectId = project.Id;
            documentId = document.Id;
            versionId = version.Id;
            colorId = color.Id;
            layerId = layer.Id;
        }

        // Un DbContext nuevo (misma connection string) para confirmar que la cadena
        // completa sobrevive más allá del DbContext que la escribió.
        await using var readContext = CreateDbContext();

        Assert.NotNull(await readContext.Users.FindAsync(userId));
        Assert.NotNull(await readContext.Projects.FindAsync(projectId));
        Assert.NotNull(await readContext.VectorDocuments.FindAsync(documentId));
        Assert.NotNull(await readContext.DocumentVersions.FindAsync(versionId));
        Assert.NotNull(await readContext.PaletteColors.FindAsync(colorId));

        var reloadedLayer = await readContext.Layers.FindAsync(layerId);
        Assert.NotNull(reloadedLayer);
        Assert.Equal(colorId, reloadedLayer!.ColorId);
        Assert.Equal(versionId, reloadedLayer.VersionId);
        Assert.Equal(ManufacturingOperationKind.Cut, reloadedLayer.ManufacturingOperation);
    }

    [Fact]
    public async Task AddLayer_WithNonexistentVersionId_FailsByForeignKey()
    {
        await using var dbContext = CreateDbContext();
        await dbContext.Database.MigrateAsync();

        // Un PaletteColor VÁLIDO real (bajo una versión real) para aislar la FK que
        // debe fallar específicamente por VersionId -- no por ColorId.
        var (_, version) = await SeedMinimalDocumentVersionAsync(dbContext);
        var color = new PaletteColor
        {
            Id = Guid.NewGuid(),
            VersionId = version.Id,
            Hex = "#000000",
            Coverage = 10,
            IsBackground = true,
            Order = 0,
        };
        dbContext.PaletteColors.Add(color);
        await dbContext.SaveChangesAsync();

        var layer = new Layer
        {
            Id = Guid.NewGuid(),
            VersionId = Guid.NewGuid(), // no existe ningún DocumentVersion con este Id
            ColorId = color.Id,
            Name = "Capa huérfana",
            Order = 0,
            Visible = true,
            Locked = false,
        };
        dbContext.Layers.Add(layer);

        await Assert.ThrowsAsync<DbUpdateException>(() => dbContext.SaveChangesAsync());
    }

    [Fact]
    public async Task DocumentVersion_SameVersionNumber_SameDocument_Fails_ButDifferentDocuments_Succeeds()
    {
        await using var dbContext = CreateDbContext();
        await dbContext.Database.MigrateAsync();

        var (documentA, _) = await SeedMinimalDocumentVersionAsync(dbContext, versionNumber: 1);

        // Segunda versión con el MISMO VersionNumber (1) para el MISMO VectorDocumentId:
        // debe fallar por la constraint única compuesta.
        var duplicate = new DocumentVersion
        {
            Id = Guid.NewGuid(),
            VectorDocumentId = documentA.Id,
            VersionNumber = 1,
            ViewBox = "0 0 1 1",
            Origin = DocumentVersionOrigin.Vectorize,
            MetadataJson = "{}",
            CreatedAt = DateTimeOffset.UtcNow,
        };
        dbContext.DocumentVersions.Add(duplicate);
        await Assert.ThrowsAsync<DbUpdateException>(() => dbContext.SaveChangesAsync());

        // Destrackear la entidad rota para poder seguir usando el mismo DbContext.
        dbContext.Entry(duplicate).State = EntityState.Detached;

        // Un documento DISTINTO con el MISMO VersionNumber (1) sí debe estar permitido.
        var (_, versionB) = await SeedMinimalDocumentVersionAsync(dbContext, versionNumber: 1);
        Assert.Equal(1, versionB.VersionNumber);
    }

    [Fact]
    public async Task Project_SoftDeleted_IsExcludedByDefault_ButVisibleWithIgnoreQueryFilters()
    {
        Guid ownerId, deletedProjectId;

        await using (var writeContext = CreateDbContext())
        {
            await writeContext.Database.MigrateAsync();

            var user = new User
            {
                Id = Guid.NewGuid(),
                DisplayName = "Owner de prueba",
                CreatedAt = DateTimeOffset.UtcNow,
            };
            var project = new Project
            {
                Id = Guid.NewGuid(),
                OwnerId = user.Id,
                Name = "Proyecto borrado",
                CreatedAt = DateTimeOffset.UtcNow,
                UpdatedAt = DateTimeOffset.UtcNow,
                DeletedAt = DateTimeOffset.UtcNow,
            };

            writeContext.Users.Add(user);
            writeContext.Projects.Add(project);
            await writeContext.SaveChangesAsync();

            ownerId = user.Id;
            deletedProjectId = project.Id;
        }

        await using var readContext = CreateDbContext();

        var normalQuery = await readContext.Projects.Where(p => p.OwnerId == ownerId).ToListAsync();
        Assert.Empty(normalQuery);

        var withDeleted = await readContext.Projects
            .IgnoreQueryFilters()
            .Where(p => p.OwnerId == ownerId)
            .ToListAsync();
        Assert.Single(withDeleted);
        Assert.Equal(deletedProjectId, withDeleted[0].Id);
    }

    private static async Task<(VectorDocument Document, DocumentVersion Version)> SeedMinimalDocumentVersionAsync(
        VectorizationDbContext dbContext,
        int versionNumber = 1)
    {
        var user = new User
        {
            Id = Guid.NewGuid(),
            DisplayName = "Seed user",
            CreatedAt = DateTimeOffset.UtcNow,
        };
        var project = new Project
        {
            Id = Guid.NewGuid(),
            OwnerId = user.Id,
            Name = "Seed project",
            CreatedAt = DateTimeOffset.UtcNow,
            UpdatedAt = DateTimeOffset.UtcNow,
        };
        var document = new VectorDocument
        {
            Id = Guid.NewGuid(),
            ProjectId = project.Id,
        };
        var version = new DocumentVersion
        {
            Id = Guid.NewGuid(),
            VectorDocumentId = document.Id,
            VersionNumber = versionNumber,
            WidthMm = 10,
            HeightMm = 10,
            ViewBox = "0 0 100 100",
            SchemaVersion = 1,
            Origin = DocumentVersionOrigin.Vectorize,
            MetadataJson = "{}",
            CreatedAt = DateTimeOffset.UtcNow,
        };

        dbContext.Users.Add(user);
        dbContext.Projects.Add(project);
        dbContext.VectorDocuments.Add(document);
        dbContext.DocumentVersions.Add(version);
        await dbContext.SaveChangesAsync();

        return (document, version);
    }

    private VectorizationDbContext CreateDbContext()
    {
        var options = new DbContextOptionsBuilder<VectorizationDbContext>()
            .UseNpgsql(_postgres.GetConnectionString())
            .Options;
        return new VectorizationDbContext(options);
    }
}
