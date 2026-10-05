using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql;
using Testcontainers.PostgreSql;
using Vectorify.Api.Data;
using Vectorify.Api.ManufacturingOperations;

namespace Vectorify.Api.Tests.Migrations;

/// <summary>
/// Cadena completa de migraciones de EF Core (M2.2-S10) contra PostgreSQL real (Testcontainers, nunca InMemory):
/// <list type="bullet">
/// <item>Base VACÍA -&gt; cada migración, una por una y en orden, hasta la última: aplica limpio, el historial
/// crece exactamente en ese orden y el esquema resultante coincide con el modelo (sin "pending model changes",
/// mismas tablas, todas las consultas del modelo ejecutan).</item>
/// <item>UPGRADE desde la migración anterior a la última (N-1 -&gt; N) con datos representativos sembrados en el
/// esquema N-1 (usuarios, proyectos con varias versiones, capas, paleta, assets, thumbnail, idempotencyKey, un
/// proyecto eliminado y uno vacío): después de migrar, nada cambió y el esquema nuevo es utilizable.</item>
/// </list>
/// Generaliza los tests puntuales de S06 (<see cref="MoveDocumentDimensionsToVersionMigrationTests"/>) y S08
/// (<see cref="AddProjectClassicTripleMigrationTests"/>), que siguen cubriendo el detalle de SU migración.
/// </summary>
public sealed class MigrationChainTests : IAsyncLifetime
{
    // Fijan "la última" y "la anterior" a propósito: si alguien agrega una migración, ESTE test debe actualizarse
    // (sembrar con el esquema nuevo N-1 y verificar la migración nueva) en vez de seguir probando un upgrade viejo.
    private const string LatestMigration = "20261004100837_AddProjectClassicTriple";
    private const string PreviousMigration = "20261003230452_AddDocumentVersionIdempotencyKey";

    private readonly PostgreSqlContainer _postgres = new PostgreSqlBuilder("postgres:17-alpine").Build();

    public Task InitializeAsync() => _postgres.StartAsync();

    public Task DisposeAsync() => _postgres.DisposeAsync().AsTask();

    [Fact]
    public async Task EmptyDatabase_AppliesEveryMigrationInOrder_AndTheSchemaMatchesTheModel()
    {
        await using var dbContext = CreateDbContext();
        var migrator = dbContext.GetService<IMigrator>();
        var all = dbContext.Database.GetMigrations().ToList();

        Assert.True(all.Count >= 8, $"Se esperaban al menos 8 migraciones y hay {all.Count}");
        Assert.Equal(all.Order(StringComparer.Ordinal), all); // los ids llevan timestamp: el orden es cronológico
        Assert.Equal(LatestMigration, all[^1]); // ver el comentario de LatestMigration
        Assert.Empty(await dbContext.Database.GetAppliedMigrationsAsync()); // la base arranca realmente vacía

        for (var index = 0; index < all.Count; index++)
        {
            var exception = await Record.ExceptionAsync(() => migrator.MigrateAsync(all[index]));
            Assert.True(exception is null, $"La migración {all[index]} falló sobre una base vacía: {exception?.Message}");
            Assert.Equal(all.Take(index + 1), await dbContext.Database.GetAppliedMigrationsAsync());
        }

        Assert.Empty(await dbContext.Database.GetPendingMigrationsAsync());

        // El snapshot de migraciones coincide con el modelo actual: no falta generar ninguna migración.
        Assert.False(
            dbContext.Database.HasPendingModelChanges(),
            "El modelo de EF Core tiene cambios sin migración (generá una con `dotnet ef migrations add`).");

        // Mismas tablas que el modelo (más el historial de EF), ni una de más ni de menos.
        var modelTables = dbContext.Model.GetEntityTypes().Select(e => e.GetTableName()!).Append("__EFMigrationsHistory").Order().ToList();
        var databaseTables = await dbContext.Database
            .SqlQuery<string>($"""SELECT table_name AS "Value" FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'""")
            .ToListAsync();
        Assert.Equal(modelTables, databaseTables.Order().ToList());

        // Cada DbSet ejecuta su SELECT con TODAS las columnas del modelo: una columna que falte o sobre en el esquema real revienta acá.
        Assert.Empty(await dbContext.Users.ToListAsync());
        Assert.Empty(await dbContext.Projects.IgnoreQueryFilters().ToListAsync());
        Assert.Empty(await dbContext.Assets.ToListAsync());
        Assert.Empty(await dbContext.VectorDocuments.ToListAsync());
        Assert.Empty(await dbContext.DocumentVersions.ToListAsync());
        Assert.Empty(await dbContext.Layers.ToListAsync());
        Assert.Empty(await dbContext.PaletteColors.ToListAsync());
        Assert.Empty(await dbContext.SchemaProbes.ToListAsync());
    }

    [Fact]
    public async Task Upgrade_FromThePreviousMigrationWithRepresentativeData_KeepsEveryRowIntact()
    {
        await using var dbContext = CreateDbContext();
        var migrator = dbContext.GetService<IMigrator>();
        var all = dbContext.Database.GetMigrations().ToList();
        Assert.Equal(LatestMigration, all[^1]);
        Assert.Equal(PreviousMigration, all[^2]);

        await migrator.MigrateAsync(PreviousMigration);
        Assert.Equal(PreviousMigration, (await dbContext.Database.GetAppliedMigrationsAsync()).Last());

        var seed = await SeedRepresentativeDataAtPreviousSchemaAsync(dbContext);

        // El esquema "viejo" realmente no tiene lo que agrega la última migración.
        var projectColumnsBefore = await ProjectColumnsAsync(dbContext);
        Assert.DoesNotContain("ClassicProjectId", projectColumnsBefore);

        var exception = await Record.ExceptionAsync(() => dbContext.Database.MigrateAsync());
        Assert.True(exception is null, $"El upgrade a {LatestMigration} falló con datos reales: {exception?.Message}");
        Assert.Empty(await dbContext.Database.GetPendingMigrationsAsync());
        Assert.Contains("ClassicProjectId", await ProjectColumnsAsync(dbContext));

        await using var read = CreateDbContext();

        // Proyectos: mismos valores; el triple clásico queda null (no hay backfill: el dato nunca existió).
        var projects = await read.Projects.IgnoreQueryFilters().OrderBy(p => p.Name).ToListAsync();
        Assert.Equal(["Con historia", "Eliminado", "Vacío"], projects.Select(p => p.Name));
        Assert.All(projects, p =>
        {
            Assert.Null(p.ClassicProjectId);
            Assert.Null(p.ClassicImageId);
            Assert.Null(p.ClassicPaletteId);
        });
        var main = projects.Single(p => p.Id == seed.MainProjectId);
        Assert.Equal(seed.OwnerId, main.OwnerId);
        Assert.Equal(seed.ThumbnailAssetId, main.ThumbnailAssetId);
        Assert.Equal(seed.CurrentVersionId, main.CurrentVersionId);
        Assert.Null(main.DeletedAt);
        Assert.NotNull(projects.Single(p => p.Id == seed.DeletedProjectId).DeletedAt);
        Assert.Null(projects.Single(p => p.Id == seed.EmptyProjectId).CurrentVersionId);

        // Versiones: 3 de la principal + 1 del eliminado, con sus valores (dimensiones, origen, idempotencyKey, JSON).
        var versions = await read.DocumentVersions.Include(v => v.VectorDocument).OrderBy(v => v.VersionNumber).ToListAsync();
        var mainVersions = versions.Where(v => v.VectorDocument!.ProjectId == seed.MainProjectId).ToList();
        Assert.Equal([1, 2, 3], mainVersions.Select(v => v.VersionNumber));
        Assert.Equal([100.0, 110.0, 120.0], mainVersions.Select(v => v.WidthMm));
        Assert.Equal([50.5, 55.5, 60.5], mainVersions.Select(v => v.HeightMm));
        Assert.All(mainVersions, v => Assert.Equal("0 0 800 400", v.ViewBox));
        Assert.Equal(
            [DocumentVersionOriginForSeed(0), DocumentVersionOriginForSeed(1), DocumentVersionOriginForSeed(2)],
            mainVersions.Select(v => v.Origin.ToString()));
        Assert.Equal([null, null, "owner:key-3"], mainVersions.Select(v => v.IdempotencyKey));
        Assert.All(mainVersions, v => Assert.Equal("""{"seed":true}""", v.MetadataJson.Replace(" ", "")));
        Assert.Equal(4, versions.Count);

        // Capas: 2 por versión, mismos ids de grupo, orden, flags, operación y pathCount.
        var layers = await read.Layers.Include(l => l.Color).OrderBy(l => l.VersionId).ThenBy(l => l.Order).ToListAsync();
        Assert.Equal(6 + 1, layers.Count);
        foreach (var versionId in seed.VersionIds)
        {
            var versionLayers = layers.Where(l => l.VersionId == versionId).OrderBy(l => l.Order).ToList();
            Assert.Equal([seed.GroupIds[0], seed.GroupIds[1]], versionLayers.Select(l => l.GroupId));
            Assert.Equal(["Contorno", "Relleno"], versionLayers.Select(l => l.Name));
            Assert.Equal([ManufacturingOperationKind.Cut, ManufacturingOperationKind.Engrave], versionLayers.Select(l => l.ManufacturingOperation!.Value));
            Assert.Equal([true, false], versionLayers.Select(l => l.Visible));
            Assert.Equal([false, true], versionLayers.Select(l => l.Locked));
            Assert.Equal([12, 34], versionLayers.Select(l => l.PathCount));
            Assert.Equal(["#ff0000", "#00ff00"], versionLayers.Select(l => l.Color!.Hex));
            Assert.All(versionLayers, l => Assert.NotNull(l.SvgAssetId));
        }

        // Paleta, assets y su integridad referencial.
        Assert.Equal(7, await read.PaletteColors.CountAsync());
        var assets = await read.Assets.OrderBy(a => a.StorageKey).ToListAsync();
        Assert.Equal(8, assets.Count); // 6 SVG de la principal + 1 thumbnail + 1 SVG del eliminado
        Assert.Equal(seed.AssetChecksums.Order(), assets.Select(a => a.Checksum).Order());
        Assert.Equal("image/png", assets.Single(a => a.Id == seed.ThumbnailAssetId).MimeType);
        Assert.Equal(0, await read.Layers.CountAsync(l => l.SvgAssetId != null && !read.Assets.Any(a => a.Id == l.SvgAssetId)));

        // El esquema nuevo es utilizable: se puede escribir el triple clásico y la restricción única de idempotencyKey sigue viva.
        main.ClassicProjectId = Guid.NewGuid();
        main.ClassicImageId = Guid.NewGuid();
        main.ClassicPaletteId = Guid.NewGuid();
        await read.SaveChangesAsync();
        await using var verify = CreateDbContext();
        Assert.NotNull((await verify.Projects.FirstAsync(p => p.Id == seed.MainProjectId)).ClassicPaletteId);

        var duplicateKey = await Record.ExceptionAsync(() => verify.Database.ExecuteSqlInterpolatedAsync(
            $"""UPDATE "document_versions" SET "IdempotencyKey" = 'owner:key-3' WHERE "Id" = {seed.VersionIds[0]}"""));
        Assert.IsType<PostgresException>(duplicateKey);
        Assert.Equal("23505", ((PostgresException)duplicateKey).SqlState); // unique_violation
    }

    // ---------------------------------------------------------------- siembra en el esquema N-1

    private sealed record SeedIds(
        Guid OwnerId, Guid MainProjectId, Guid DeletedProjectId, Guid EmptyProjectId, Guid ThumbnailAssetId,
        Guid CurrentVersionId, IReadOnlyList<Guid> VersionIds, IReadOnlyList<Guid> GroupIds, IReadOnlyList<string> AssetChecksums);

    private static string DocumentVersionOriginForSeed(int index) => new[] { "ManualEdit", "ManualEdit", "Restore" }[index];

    private static async Task<SeedIds> SeedRepresentativeDataAtPreviousSchemaAsync(VectorizationDbContext db)
    {
        var now = DateTimeOffset.UtcNow;
        var ownerId = Guid.NewGuid();
        var otherOwnerId = Guid.NewGuid();
        var mainProjectId = Guid.NewGuid();
        var deletedProjectId = Guid.NewGuid();
        var emptyProjectId = Guid.NewGuid();
        var groupIds = new[] { Guid.NewGuid(), Guid.NewGuid() };
        var checksums = new List<string>();

        await db.Database.ExecuteSqlInterpolatedAsync(
            $"""INSERT INTO "users" ("Id", "DisplayName", "CreatedAt") VALUES ({ownerId}, 'Dueño', {now}), ({otherOwnerId}, 'Otro', {now})""");
        await db.Database.ExecuteSqlInterpolatedAsync(
            $"""
            INSERT INTO "projects" ("Id", "OwnerId", "Name", "CreatedAt", "UpdatedAt", "DeletedAt")
            VALUES ({mainProjectId}, {ownerId}, 'Con historia', {now}, {now}, NULL),
                   ({deletedProjectId}, {otherOwnerId}, 'Eliminado', {now}, {now}, {now}),
                   ({emptyProjectId}, {ownerId}, 'Vacío', {now}, {now}, NULL)
            """);

        var versionIds = new List<Guid>();
        var origins = new[] { "MANUAL_EDIT", "MANUAL_EDIT", "RESTORE" };
        var documentId = Guid.NewGuid();
        await db.Database.ExecuteSqlInterpolatedAsync(
            $"""INSERT INTO "vector_documents" ("Id", "ProjectId") VALUES ({documentId}, {mainProjectId})""");

        for (var v = 0; v < 3; v++)
        {
            var versionId = Guid.NewGuid();
            versionIds.Add(versionId);
            var width = 100.0 + 10 * v;
            var height = 50.5 + 5 * v;
            var versionNumber = v + 1;
            var origin = origins[v];
            var emptyJson = """{"seed": true}""";
            string? idempotencyKey = v == 2 ? "owner:key-3" : null;
            await db.Database.ExecuteSqlInterpolatedAsync(
                $"""
                INSERT INTO "document_versions" ("Id", "VectorDocumentId", "VersionNumber", "WidthMm", "HeightMm", "ViewBox", "SchemaVersion", "Origin", "MetadataJson", "IdempotencyKey", "CreatedAt")
                VALUES ({versionId}, {documentId}, {versionNumber}, {width}, {height}, '0 0 800 400', 1, {origin}, {emptyJson}::jsonb, {idempotencyKey}, {now.AddMinutes(v)})
                """);

            for (var l = 0; l < 2; l++)
            {
                var assetId = Guid.NewGuid();
                var colorId = Guid.NewGuid();
                var layerId = Guid.NewGuid();
                var checksum = $"{v}{l}".PadLeft(64, 'a');
                checksums.Add(checksum);
                var storageKey = $"projects/{mainProjectId:N}/layer-svg/{assetId:N}.svg";
                var hex = l == 0 ? "#ff0000" : "#00ff00";
                var operation = l == 0 ? "Cut" : "Engrave";
                var name = l == 0 ? "Contorno" : "Relleno";
                var pathCount = l == 0 ? 12 : 34;
                await db.Database.ExecuteSqlInterpolatedAsync(
                    $"""
                    INSERT INTO "assets" ("Id", "ProjectId", "Type", "StorageKey", "MimeType", "FileName", "Size", "Checksum", "CreatedAt")
                    VALUES ({assetId}, {mainProjectId}, 'layer-svg', {storageKey}, 'image/svg+xml', {$"{groupIds[l]:N}.svg"}, {1000 + v * 10 + l}, {checksum}, {now})
                    """);
                await db.Database.ExecuteSqlInterpolatedAsync(
                    $"""INSERT INTO "palette_colors" ("Id", "VersionId", "Hex", "Coverage", "IsBackground", "Order") VALUES ({colorId}, {versionId}, {hex}, 50.0, false, {l})""");
                await db.Database.ExecuteSqlInterpolatedAsync(
                    $"""
                    INSERT INTO "layers" ("Id", "VersionId", "ColorId", "GroupId", "Name", "Order", "Visible", "Locked", "ManufacturingOperation", "SvgAssetId", "PathCount")
                    VALUES ({layerId}, {versionId}, {colorId}, {groupIds[l]}, {name}, {l}, {l == 0}, {l == 1}, {operation}, {assetId}, {pathCount})
                    """);
            }
        }

        // Thumbnail del proyecto principal + proyecto "actual" apuntando a la V3.
        var thumbnailId = Guid.NewGuid();
        var thumbnailChecksum = new string('b', 64);
        checksums.Add(thumbnailChecksum);
        await db.Database.ExecuteSqlInterpolatedAsync(
            $"""
            INSERT INTO "assets" ("Id", "ProjectId", "Type", "StorageKey", "MimeType", "FileName", "Size", "Width", "Height", "Checksum", "CreatedAt")
            VALUES ({thumbnailId}, {mainProjectId}, 'thumbnail', {$"projects/{mainProjectId:N}/thumbnail/{thumbnailId:N}.png"}, 'image/png', 'thumbnail.png', 321, 320, 160, {thumbnailChecksum}, {now})
            """);
        await db.Database.ExecuteSqlInterpolatedAsync(
            $"""UPDATE "projects" SET "ThumbnailAssetId" = {thumbnailId}, "CurrentVersionId" = {versionIds[2]} WHERE "Id" = {mainProjectId}""");

        // Proyecto eliminado (soft-delete) con una versión, una capa y su asset.
        var deletedDocumentId = Guid.NewGuid();
        var deletedVersionId = Guid.NewGuid();
        var deletedAssetId = Guid.NewGuid();
        var deletedColorId = Guid.NewGuid();
        var deletedChecksum = new string('c', 64);
        checksums.Add(deletedChecksum);
        var deletedJson = "{}";
        await db.Database.ExecuteSqlInterpolatedAsync(
            $"""INSERT INTO "vector_documents" ("Id", "ProjectId") VALUES ({deletedDocumentId}, {deletedProjectId})""");
        await db.Database.ExecuteSqlInterpolatedAsync(
            $"""
            INSERT INTO "document_versions" ("Id", "VectorDocumentId", "VersionNumber", "WidthMm", "HeightMm", "ViewBox", "SchemaVersion", "Origin", "MetadataJson", "CreatedAt")
            VALUES ({deletedVersionId}, {deletedDocumentId}, 1, 10, 10, '0 0 10 10', 1, 'MANUAL_EDIT', {deletedJson}::jsonb, {now})
            """);
        await db.Database.ExecuteSqlInterpolatedAsync(
            $"""
            INSERT INTO "assets" ("Id", "ProjectId", "Type", "StorageKey", "MimeType", "FileName", "Size", "Checksum", "CreatedAt")
            VALUES ({deletedAssetId}, {deletedProjectId}, 'layer-svg', {$"projects/{deletedProjectId:N}/layer-svg/{deletedAssetId:N}.svg"}, 'image/svg+xml', 'x.svg', 10, {deletedChecksum}, {now})
            """);
        await db.Database.ExecuteSqlInterpolatedAsync(
            $"""INSERT INTO "palette_colors" ("Id", "VersionId", "Hex", "Coverage", "IsBackground", "Order") VALUES ({deletedColorId}, {deletedVersionId}, '#ff0000', 100.0, false, 0)""");
        await db.Database.ExecuteSqlInterpolatedAsync(
            $"""
            INSERT INTO "layers" ("Id", "VersionId", "ColorId", "GroupId", "Name", "Order", "Visible", "Locked", "SvgAssetId", "PathCount")
            VALUES ({Guid.NewGuid()}, {deletedVersionId}, {deletedColorId}, {Guid.NewGuid()}, 'Única', 0, true, false, {deletedAssetId}, 1)
            """);
        await db.Database.ExecuteSqlInterpolatedAsync(
            $"""UPDATE "projects" SET "CurrentVersionId" = {deletedVersionId} WHERE "Id" = {deletedProjectId}""");

        return new SeedIds(
            ownerId, mainProjectId, deletedProjectId, emptyProjectId, thumbnailId, versionIds[2], versionIds, groupIds, checksums);
    }

    private static Task<List<string>> ProjectColumnsAsync(VectorizationDbContext db) =>
        db.Database
            .SqlQuery<string>($"""SELECT column_name AS "Value" FROM information_schema.columns WHERE table_name = 'projects'""")
            .ToListAsync();

    private VectorizationDbContext CreateDbContext() =>
        new(new DbContextOptionsBuilder<VectorizationDbContext>().UseNpgsql(_postgres.GetConnectionString()).Options);
}
