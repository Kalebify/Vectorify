using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Testcontainers.PostgreSql;
using Vectorify.Api.Data;

namespace Vectorify.Api.Tests.Migrations;

/// <summary>
/// Test de regresión de "upgrade" (QA, fix round 1 de M2.2-S06): la primera versión de
/// <c>MoveDocumentDimensionsToVersion</c> hacía <c>DropColumn</c> de
/// WidthMm/HeightMm/ViewBox/SchemaVersion en <c>vector_documents</c> ANTES de copiar esos
/// valores a <c>document_versions</c> (perdía los datos reales de cualquier proyecto ya guardado
/// por M2.2-S05) y agregaba <c>Layer.GroupId</c> con <c>Guid.Empty</c> para TODAS las filas
/// existentes antes de crear el índice único <c>(VersionId, GroupId)</c> -- un documento
/// multicolor (2+ layers en la MISMA versión) hacía fallar ese <c>CreateIndex</c> (dos filas
/// <c>Guid.Empty</c> en la misma versión chocan).
///
/// Este test arranca una base de datos en el esquema EXACTO anterior a esa migración (aplica
/// todas las migraciones EXCEPTO la última), inserta filas de prueba con el esquema VIEJO
/// (<c>vector_documents</c> con esas 4 columnas pobladas, <c>Layer</c> sin <c>GroupId</c> porque
/// esa columna no existe todavía en ese punto, y un documento con 2+ layers en la MISMA versión),
/// aplica la migración reescrita, y confirma que el backfill preservó los datos sin lanzar
/// ninguna excepción -- NUNCA <c>UseInMemoryDatabase</c> (Testcontainers real, mismo criterio que
/// el resto de MVP2.2).
/// </summary>
public sealed class MoveDocumentDimensionsToVersionMigrationTests : IAsyncLifetime
{
    private const string MigrationImmediatelyBeforeTheFix = "20261002170728_AddLayerPathCount";

    private readonly PostgreSqlContainer _postgres = new PostgreSqlBuilder("postgres:17-alpine").Build();

    public Task InitializeAsync() => _postgres.StartAsync();

    public Task DisposeAsync() => _postgres.DisposeAsync().AsTask();

    [Fact]
    public async Task Upgrade_FromPreS06SchemaWithMulticolorDocument_PreservesDimensionsAndBackfillsGroupIdWithoutThrowing()
    {
        await using var dbContext = CreateDbContext();

        // 1. Aplica TODAS las migraciones EXCEPTO MoveDocumentDimensionsToVersion -- deja la
        // base exactamente en el esquema que tenía cualquier proyecto real guardado por
        // M2.2-S05 (WidthMm/HeightMm/ViewBox/SchemaVersion en vector_documents, "layers" sin la
        // columna GroupId todavía).
        var migrator = dbContext.GetService<IMigrator>();
        await migrator.MigrateAsync(MigrationImmediatelyBeforeTheFix);

        var userId = Guid.NewGuid();
        var projectId = Guid.NewGuid();
        var vectorDocumentId = Guid.NewGuid();
        var versionId = Guid.NewGuid();
        var assetId1 = Guid.NewGuid();
        var assetId2 = Guid.NewGuid();
        var layerId1 = Guid.NewGuid();
        var layerId2 = Guid.NewGuid();
        var colorId1 = Guid.NewGuid();
        var colorId2 = Guid.NewGuid();
        var now = DateTimeOffset.UtcNow;

        // 2. Filas de prueba con el esquema VIEJO, vía SQL crudo (ExecuteSqlInterpolatedAsync no
        // depende del modelo EF Core en memoria -- ese modelo ya es el ACTUAL/post-fix, que ya
        // no conoce estas columnas de vector_documents -- solo manda el texto SQL tal cual).
        await dbContext.Database.ExecuteSqlInterpolatedAsync(
            $"""INSERT INTO "users" ("Id", "DisplayName", "CreatedAt") VALUES ({userId}, 'Usuario de prueba', {now})""");

        await dbContext.Database.ExecuteSqlInterpolatedAsync(
            $"""
            INSERT INTO "projects" ("Id", "OwnerId", "Name", "CreatedAt", "UpdatedAt")
            VALUES ({projectId}, {userId}, 'Proyecto pre-S06', {now}, {now})
            """);

        await dbContext.Database.ExecuteSqlInterpolatedAsync(
            $"""
            INSERT INTO "vector_documents" ("Id", "ProjectId", "WidthMm", "HeightMm", "ViewBox", "SchemaVersion")
            VALUES ({vectorDocumentId}, {projectId}, 123.5, 67.25, '0 0 800 600', 1)
            """);

        var emptyJsonObject = "{}";
        await dbContext.Database.ExecuteSqlInterpolatedAsync(
            $"""
            INSERT INTO "document_versions" ("Id", "VectorDocumentId", "VersionNumber", "Origin", "MetadataJson", "CreatedAt")
            VALUES ({versionId}, {vectorDocumentId}, 1, 'MANUAL_EDIT', {emptyJsonObject}::jsonb, {now})
            """);

        await dbContext.Database.ExecuteSqlInterpolatedAsync(
            $"""UPDATE "projects" SET "CurrentVersionId" = {versionId} WHERE "Id" = {projectId}""");

        foreach (var (assetId, key) in new[] { (assetId1, "roja"), (assetId2, "verde") })
        {
            await dbContext.Database.ExecuteSqlInterpolatedAsync(
                $"""
                INSERT INTO "assets" ("Id", "ProjectId", "Type", "StorageKey", "MimeType", "FileName", "Size", "Checksum", "CreatedAt")
                VALUES ({assetId}, {projectId}, 'layer-svg', {$"projects/{projectId:N}/layer-svg/{key}.svg"}, 'image/svg+xml', {$"{key}.svg"}, 10, 'deadbeef', {now})
                """);
        }

        await dbContext.Database.ExecuteSqlInterpolatedAsync(
            $"""
            INSERT INTO "palette_colors" ("Id", "VersionId", "Hex", "Coverage", "IsBackground", "Order")
            VALUES ({colorId1}, {versionId}, '#ff0000', 50.0, false, 0)
            """);
        await dbContext.Database.ExecuteSqlInterpolatedAsync(
            $"""
            INSERT INTO "palette_colors" ("Id", "VersionId", "Hex", "Coverage", "IsBackground", "Order")
            VALUES ({colorId2}, {versionId}, '#00ff00', 50.0, false, 1)
            """);

        // Documento MULTICOLOR: 2+ layers en la MISMA DocumentVersion -- el escenario explícito
        // que el bug original rompía (índice único (VersionId, GroupId) creado ANTES de
        // backfillear GroupId, con ambas filas en Guid.Empty, chocaba en esta versión).
        await dbContext.Database.ExecuteSqlInterpolatedAsync(
            $"""
            INSERT INTO "layers" ("Id", "VersionId", "ColorId", "Name", "Order", "Visible", "Locked", "SvgAssetId", "PathCount")
            VALUES ({layerId1}, {versionId}, {colorId1}, 'Capa roja', 0, true, false, {assetId1}, 3)
            """);
        await dbContext.Database.ExecuteSqlInterpolatedAsync(
            $"""
            INSERT INTO "layers" ("Id", "VersionId", "ColorId", "Name", "Order", "Visible", "Locked", "SvgAssetId", "PathCount")
            VALUES ({layerId2}, {versionId}, {colorId2}, 'Capa verde', 1, true, false, {assetId2}, 5)
            """);

        // 3. Aplica la migración reescrita (la última) -- acá es donde corría el bug original.
        var exception = await Record.ExceptionAsync(() => dbContext.Database.MigrateAsync());
        Assert.Null(exception); // (c) no lanzó ninguna excepción con 2+ layers en la misma versión

        await using var readContext = CreateDbContext();
        var version = await readContext.DocumentVersions.FirstAsync(v => v.Id == versionId);
        Assert.Equal(123.5, version.WidthMm); // (a) las dimensiones sobrevivieron en document_versions
        Assert.Equal(67.25, version.HeightMm);
        Assert.Equal("0 0 800 600", version.ViewBox);
        Assert.Equal(1, version.SchemaVersion);

        var layers = await readContext.Layers.Where(l => l.VersionId == versionId).ToListAsync();
        Assert.Equal(2, layers.Count);
        Assert.All(layers, l => Assert.Equal(l.Id, l.GroupId)); // (b) GroupId == Id original, para cada fila
    }

    private VectorizationDbContext CreateDbContext()
    {
        var options = new DbContextOptionsBuilder<VectorizationDbContext>()
            .UseNpgsql(_postgres.GetConnectionString())
            .Options;
        return new VectorizationDbContext(options);
    }
}
