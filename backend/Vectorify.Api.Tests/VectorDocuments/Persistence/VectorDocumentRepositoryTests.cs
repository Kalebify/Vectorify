using Microsoft.EntityFrameworkCore;
using Testcontainers.PostgreSql;
using Vectorify.Api.Data;
using Vectorify.Api.ManufacturingOperations;
using Vectorify.Api.Projects.Persistence;
using Vectorify.Api.VectorDocuments;
using Vectorify.Api.VectorDocuments.Persistence;

namespace Vectorify.Api.Tests.VectorDocuments.Persistence;

/// <summary>
/// Tests de integración de <see cref="VectorDocumentRepository"/> (M2.2-S05/S06) directamente
/// contra PostgreSQL real (Testcontainers, NUNCA UseInMemoryDatabase -- mismo criterio que el
/// resto de MVP2.2): round-trip del grafo completo, la inmutabilidad real de versiones
/// históricas (M2.2-S06, ver el conflicto #1 de spec.md M2.2-S06), restore, listado de
/// versiones, ownership y concurrencia. Ejercita el repositorio sin pasar por
/// VectorDocumentService ni por HTTP -- eso lo cubre
/// Vectorify.Api.Tests.EndToEnd.VectorDocumentEndpointsTests.
/// </summary>
public sealed class VectorDocumentRepositoryTests : IAsyncLifetime
{
    private readonly PostgreSqlContainer _postgres = new PostgreSqlBuilder("postgres:17-alpine").Build();

    public Task InitializeAsync() => _postgres.StartAsync();

    public Task DisposeAsync() => _postgres.DisposeAsync().AsTask();

    [Fact]
    public async Task SaveAsync_NewProject_CreatesDocumentVersionLayersAndPaletteColors()
    {
        await using var dbContext = await CreateMigratedDbContextAsync();
        var ownerId = await SeedUserAsync(dbContext);
        var project = await new ProjectRepository(dbContext).CreateAsync(ownerId, "Proyecto de prueba", null, CancellationToken.None);
        var repository = new VectorDocumentRepository(dbContext);

        var groupId = Guid.NewGuid();
        var assetId = await SeedAssetAsync(dbContext, project.Id, "layer-svg");
        var snapshot = new DocumentSnapshot(
            WidthMm: 100,
            HeightMm: 50,
            ViewBox: "0 0 1000 500",
            SchemaVersion: 1,
            Origin: DocumentVersionOrigin.ManualEdit,
            MetadataJson: "{}",
            Layers: [new LayerSnapshot(groupId, "Capa 1", 0, true, false, ManufacturingOperationKind.Cut, assetId, new PaletteColorSnapshot("#112233", 80.0, false, 0), PathCount: 7)]);

        var outcome = await repository.SaveAsync(project.Id, ownerId, snapshot, CancellationToken.None);

        Assert.NotNull(outcome);
        Assert.Equal(project.Id, outcome!.ProjectId);
        Assert.Equal(1, outcome.VersionNumber);

        await using var readContext = CreateDbContext();
        var reloadedProject = await readContext.Projects
            .Include(p => p.VectorDocuments).ThenInclude(d => d.Versions).ThenInclude(v => v.Layers)
            .Include(p => p.VectorDocuments).ThenInclude(d => d.Versions).ThenInclude(v => v.PaletteColors)
            .FirstAsync(p => p.Id == project.Id);

        var document = Assert.Single(reloadedProject.VectorDocuments);
        var version = Assert.Single(document.Versions);
        Assert.Equal(100, version.WidthMm); // M2.2-S06: WidthMm/ViewBox/SchemaVersion viven en DocumentVersion
        Assert.Equal("0 0 1000 500", version.ViewBox);
        Assert.Equal(1, version.SchemaVersion);
        Assert.Equal(reloadedProject.CurrentVersionId, version.Id);

        var layer = Assert.Single(version.Layers);
        Assert.Equal(groupId, layer.GroupId); // groupId clásico reutilizado verbatim (ya NO es la PK)
        Assert.NotEqual(Guid.Empty, layer.Id);
        Assert.Equal("Capa 1", layer.Name);
        Assert.Equal(ManufacturingOperationKind.Cut, layer.ManufacturingOperation);
        Assert.Equal(assetId, layer.SvgAssetId);
        Assert.Equal(7, layer.PathCount); // bug real encontrado en revisión: ver Data.Layer.PathCount

        var color = Assert.Single(version.PaletteColors);
        Assert.Equal(layer.ColorId, color.Id);
        Assert.Equal("#112233", color.Hex);
    }

    [Fact]
    public async Task SaveAsync_ThreeConsecutiveSaves_EachVersionKeepsItsOwnLayerRowsIntactEvenForAnUnchangedLayer()
    {
        // Prueba directa del fix del conflicto #1 de spec.md M2.2-S06: el upsert-por-Id de
        // M2.2-S05 "robaba" la fila de un layer sin cambios en cuanto una versión posterior
        // se guardaba -- V1 quedaba con huecos. Acá "stableGroupId" NUNCA cambia entre los 3
        // saves, pero debe seguir teniendo su PROPIA fila de Layer (su propio Id de PK) en
        // CADA una de las 3 versiones donde estuvo presente.
        await using var dbContext = await CreateMigratedDbContextAsync();
        var ownerId = await SeedUserAsync(dbContext);
        var project = await new ProjectRepository(dbContext).CreateAsync(ownerId, "Proyecto versionado", null, CancellationToken.None);
        var repository = new VectorDocumentRepository(dbContext);

        var stableGroupId = Guid.NewGuid();
        var changingGroupId = Guid.NewGuid();

        var asset1 = await SeedAssetAsync(dbContext, project.Id, "layer-svg");
        var asset2 = await SeedAssetAsync(dbContext, project.Id, "layer-svg");
        var v1 = await repository.SaveAsync(
            project.Id, ownerId,
            new DocumentSnapshot(10, 10, "0 0 100 100", 1, DocumentVersionOrigin.ManualEdit, "{}",
            [
                new LayerSnapshot(stableGroupId, "Capa estable", 0, true, false, null, asset1, new PaletteColorSnapshot("#111111", 50, false, 0), PathCount: 3),
                new LayerSnapshot(changingGroupId, "Capa v1", 1, true, false, null, asset2, new PaletteColorSnapshot("#222222", 50, false, 1), PathCount: 1),
            ]),
            CancellationToken.None);
        Assert.Equal(1, v1!.VersionNumber);

        var asset3 = await SeedAssetAsync(dbContext, project.Id, "layer-svg");
        var asset4 = await SeedAssetAsync(dbContext, project.Id, "layer-svg");
        var v2 = await repository.SaveAsync(
            project.Id, ownerId,
            // "stableGroupId" se vuelve a guardar SIN cambios (mismo Name/Order/Visible/etc, un
            // Asset nuevo porque un Save real siempre re-sube el SVG vigente) -- "changingGroupId"
            // cambia de nombre.
            new DocumentSnapshot(10, 10, "0 0 100 100", 1, DocumentVersionOrigin.ManualEdit, "{}",
            [
                new LayerSnapshot(stableGroupId, "Capa estable", 0, true, false, null, asset3, new PaletteColorSnapshot("#111111", 50, false, 0), PathCount: 3),
                new LayerSnapshot(changingGroupId, "Capa v2", 1, true, false, null, asset4, new PaletteColorSnapshot("#222222", 50, false, 1), PathCount: 1),
            ]),
            CancellationToken.None);
        Assert.Equal(2, v2!.VersionNumber);

        var asset5 = await SeedAssetAsync(dbContext, project.Id, "layer-svg");
        var v3 = await repository.SaveAsync(
            project.Id, ownerId,
            // Tercer save: SOLO "stableGroupId" sigue presente -- "changingGroupId" se quitó.
            new DocumentSnapshot(10, 10, "0 0 100 100", 1, DocumentVersionOrigin.ManualEdit, "{}",
            [
                new LayerSnapshot(stableGroupId, "Capa estable", 0, true, false, null, asset5, new PaletteColorSnapshot("#111111", 50, false, 0), PathCount: 3),
            ]),
            CancellationToken.None);
        Assert.Equal(3, v3!.VersionNumber);

        await using var readContext = CreateDbContext();
        var document = await readContext.VectorDocuments
            .Include(d => d.Versions).ThenInclude(v => v.Layers)
            .FirstAsync(d => d.ProjectId == project.Id);

        var versionsByNumber = document.Versions.ToDictionary(v => v.VersionNumber);
        Assert.Equal(3, versionsByNumber.Count);

        // V1 sigue teniendo AMBOS layers -- "stableGroupId" NO fue "robado" por V2/V3.
        var v1Layers = versionsByNumber[1].Layers;
        Assert.Equal(2, v1Layers.Count);
        var v1StableLayer = Assert.Single(v1Layers, l => l.GroupId == stableGroupId);

        // V2 también tiene su PROPIA fila para "stableGroupId" -- Id de PK distinto al de V1,
        // mismo GroupId.
        var v2Layers = versionsByNumber[2].Layers;
        Assert.Equal(2, v2Layers.Count);
        var v2StableLayer = Assert.Single(v2Layers, l => l.GroupId == stableGroupId);
        Assert.NotEqual(v1StableLayer.Id, v2StableLayer.Id);

        // V3 tiene su PROPIA tercera fila para "stableGroupId".
        var v3Layers = versionsByNumber[3].Layers;
        var v3StableLayer = Assert.Single(v3Layers);
        Assert.Equal(stableGroupId, v3StableLayer.GroupId);
        Assert.NotEqual(v1StableLayer.Id, v3StableLayer.Id);
        Assert.NotEqual(v2StableLayer.Id, v3StableLayer.Id);

        // Tres filas DISTINTAS en toda la tabla "layers" para el mismo GroupId -- nunca una
        // sola fila reutilizada/repuntada (el upsert-por-Id de M2.2-S05 hubiera dejado UNA sola).
        var allRowsForStableGroup = await readContext.Layers.Where(l => l.GroupId == stableGroupId).ToListAsync();
        Assert.Equal(3, allRowsForStableGroup.Count);
    }

    [Fact]
    public async Task SaveAsync_NonexistentOrWrongOwner_ReturnsNull()
    {
        await using var dbContext = await CreateMigratedDbContextAsync();
        var ownerId = await SeedUserAsync(dbContext);
        var repository = new VectorDocumentRepository(dbContext);

        var snapshot = new DocumentSnapshot(1, 1, "0 0 1 1", 1, DocumentVersionOrigin.ManualEdit, "{}", []);
        var outcome = await repository.SaveAsync(Guid.NewGuid(), ownerId, snapshot, CancellationToken.None);

        Assert.Null(outcome);
    }

    [Fact]
    public async Task SaveAsync_WithIdempotencyKey_PersistsItOnTheNewDocumentVersion()
    {
        await using var dbContext = await CreateMigratedDbContextAsync();
        var ownerId = await SeedUserAsync(dbContext);
        var project = await new ProjectRepository(dbContext).CreateAsync(ownerId, "Proyecto idempotente", null, CancellationToken.None);
        var repository = new VectorDocumentRepository(dbContext);
        var idempotencyKey = Guid.NewGuid().ToString("n");

        var outcome = await repository.SaveAsync(
            project.Id, ownerId,
            new DocumentSnapshot(1, 1, "0 0 1 1", 1, DocumentVersionOrigin.ManualEdit, "{}", [], IdempotencyKey: idempotencyKey),
            CancellationToken.None);

        await using var readContext = CreateDbContext();
        var version = await readContext.DocumentVersions
            .FirstAsync(v => v.VectorDocument!.ProjectId == outcome!.ProjectId && v.VersionNumber == outcome!.VersionNumber);
        Assert.Equal(idempotencyKey, version.IdempotencyKey);
    }

    [Fact]
    public async Task FindByIdempotencyKeyAsync_UnknownKey_ReturnsNull()
    {
        await using var dbContext = await CreateMigratedDbContextAsync();
        var ownerId = await SeedUserAsync(dbContext);
        var repository = new VectorDocumentRepository(dbContext);

        var found = await repository.FindByIdempotencyKeyAsync(ownerId, Guid.NewGuid().ToString("n"), CancellationToken.None);

        Assert.Null(found);
    }

    [Fact]
    public async Task FindByIdempotencyKeyAsync_KnownKeyOfTheRequestingOwner_ReturnsTheExistingOutcome()
    {
        await using var dbContext = await CreateMigratedDbContextAsync();
        var ownerId = await SeedUserAsync(dbContext);
        var project = await new ProjectRepository(dbContext).CreateAsync(ownerId, "Proyecto replay", null, CancellationToken.None);
        var repository = new VectorDocumentRepository(dbContext);
        var idempotencyKey = Guid.NewGuid().ToString("n");

        var originalOutcome = await repository.SaveAsync(
            project.Id, ownerId,
            new DocumentSnapshot(1, 1, "0 0 1 1", 1, DocumentVersionOrigin.ManualEdit, "{}", [], IdempotencyKey: idempotencyKey),
            CancellationToken.None);

        var replay = await repository.FindByIdempotencyKeyAsync(ownerId, idempotencyKey, CancellationToken.None);

        Assert.NotNull(replay);
        Assert.Equal(originalOutcome!.ProjectId, replay!.ProjectId);
        Assert.Equal(originalOutcome.VersionNumber, replay.VersionNumber);
        // Tolerancia submilisegundo: originalOutcome.SavedAt es el valor EN MEMORIA (precisión de
        // tick de .NET) devuelto por el propio SaveAsync, mientras que replay.SavedAt se releyó
        // de Postgres (precisión de microsegundo, trunca por debajo de eso) -- la MISMA fila,
        // diferencia de redondeo nunca relevante para idempotencia real.
        Assert.True(Math.Abs((originalOutcome.SavedAt - replay.SavedAt).TotalMilliseconds) < 1);
    }

    [Fact]
    public async Task FindByIdempotencyKeyAsync_KeyBelongsToAnotherOwner_ReturnsNull()
    {
        // Un replay nunca debe filtrar EXISTENCIA de una key ajena -- mismo criterio de
        // ownership (404 uniforme) que el resto del módulo.
        await using var dbContext = await CreateMigratedDbContextAsync();
        var ownerId = await SeedUserAsync(dbContext);
        var strangerId = await SeedUserAsync(dbContext);
        var project = await new ProjectRepository(dbContext).CreateAsync(ownerId, "Proyecto de otro dueño", null, CancellationToken.None);
        var repository = new VectorDocumentRepository(dbContext);
        var idempotencyKey = Guid.NewGuid().ToString("n");

        await repository.SaveAsync(
            project.Id, ownerId,
            new DocumentSnapshot(1, 1, "0 0 1 1", 1, DocumentVersionOrigin.ManualEdit, "{}", [], IdempotencyKey: idempotencyKey),
            CancellationToken.None);

        var found = await repository.FindByIdempotencyKeyAsync(strangerId, idempotencyKey, CancellationToken.None);

        Assert.Null(found);
    }

    [Fact]
    public async Task SaveAsync_WithIdempotencyKey_UnderConcurrentSave_StillThrowsConcurrencyException()
    {
        // spec.md M2.2-S07, "Backend: validar Project/Owner/Version": confirma que el camino de
        // autosave (idempotencyKey incluido) sigue pasando por las MISMAS validaciones de
        // concurrencia optimista (xmin) que cualquier otro Save -- la idempotencia no reemplaza
        // ni bypasea ese mecanismo.
        await using var seedContext = await CreateMigratedDbContextAsync();
        var ownerId = await SeedUserAsync(seedContext);
        var project = await new ProjectRepository(seedContext).CreateAsync(ownerId, "Proyecto concurrente idempotente", null, CancellationToken.None);

        await using var contextA = CreateDbContext();
        await using var contextB = CreateDbContext();
        await contextA.Projects.FirstAsync(p => p.Id == project.Id);
        await contextB.Projects.FirstAsync(p => p.Id == project.Id);
        var repositoryA = new VectorDocumentRepository(contextA);
        var repositoryB = new VectorDocumentRepository(contextB);

        var snapshotA = new DocumentSnapshot(1, 1, "0 0 1 1", 1, DocumentVersionOrigin.ManualEdit, "{}", [], IdempotencyKey: Guid.NewGuid().ToString("n"));
        var snapshotB = new DocumentSnapshot(2, 2, "0 0 2 2", 1, DocumentVersionOrigin.ManualEdit, "{}", [], IdempotencyKey: Guid.NewGuid().ToString("n"));

        var outcomeA = await repositoryA.SaveAsync(project.Id, ownerId, snapshotA, CancellationToken.None);
        Assert.NotNull(outcomeA);

        await Assert.ThrowsAsync<DbUpdateConcurrencyException>(
            () => repositoryB.SaveAsync(project.Id, ownerId, snapshotB, CancellationToken.None));
    }

    [Fact]
    public async Task FindCurrentDocumentAsync_ProjectWithoutAnySavedVersion_ReturnsNull()
    {
        await using var dbContext = await CreateMigratedDbContextAsync();
        var ownerId = await SeedUserAsync(dbContext);
        var project = await new ProjectRepository(dbContext).CreateAsync(ownerId, "Proyecto sin guardar", null, CancellationToken.None);
        var repository = new VectorDocumentRepository(dbContext);

        var found = await repository.FindCurrentDocumentAsync(project.Id, ownerId, CancellationToken.None);

        Assert.Null(found);
    }

    [Fact]
    public async Task FindVersionAsync_NonexistentVersionNumber_ReturnsNull()
    {
        await using var dbContext = await CreateMigratedDbContextAsync();
        var ownerId = await SeedUserAsync(dbContext);
        var project = await new ProjectRepository(dbContext).CreateAsync(ownerId, "Proyecto con una versión", null, CancellationToken.None);
        var repository = new VectorDocumentRepository(dbContext);

        await repository.SaveAsync(
            project.Id, ownerId,
            new DocumentSnapshot(1, 1, "0 0 1 1", 1, DocumentVersionOrigin.ManualEdit, "{}", []),
            CancellationToken.None);

        var found = await repository.FindVersionAsync(project.Id, ownerId, versionNumber: 99, CancellationToken.None);

        Assert.Null(found);
    }

    [Fact]
    public async Task FindVersionAsync_HistoricalVersion_ReturnsItCompleteEvenWhenNoLongerCurrent()
    {
        await using var dbContext = await CreateMigratedDbContextAsync();
        var ownerId = await SeedUserAsync(dbContext);
        var project = await new ProjectRepository(dbContext).CreateAsync(ownerId, "Proyecto con historial", null, CancellationToken.None);
        var repository = new VectorDocumentRepository(dbContext);

        var groupId = Guid.NewGuid();
        var asset1 = await SeedAssetAsync(dbContext, project.Id, "layer-svg");
        await repository.SaveAsync(
            project.Id, ownerId,
            new DocumentSnapshot(10, 10, "0 0 10 10", 1, DocumentVersionOrigin.ManualEdit, "{}",
                [new LayerSnapshot(groupId, "V1", 0, true, false, null, asset1, new PaletteColorSnapshot("#000000", 100, false, 0), PathCount: 1)]),
            CancellationToken.None);

        var asset2 = await SeedAssetAsync(dbContext, project.Id, "layer-svg");
        await repository.SaveAsync(
            project.Id, ownerId,
            new DocumentSnapshot(20, 20, "0 0 20 20", 1, DocumentVersionOrigin.ManualEdit, "{}",
                [new LayerSnapshot(groupId, "V2", 0, true, false, null, asset2, new PaletteColorSnapshot("#ffffff", 100, false, 0), PathCount: 2)]),
            CancellationToken.None);

        // V1 ya no es la actual (V2 lo es), pero FindVersionAsync la trae completa, con sus
        // PROPIAS dimensiones/layer -- GET .../versions/{n} puede leer CUALQUIER versión.
        var found = await repository.FindVersionAsync(project.Id, ownerId, versionNumber: 1, CancellationToken.None);

        Assert.NotNull(found);
        var (_, version) = found!.Value;
        Assert.Equal(1, version.VersionNumber);
        Assert.Equal(10, version.WidthMm);
        Assert.Equal("0 0 10 10", version.ViewBox);
        var layer = Assert.Single(version.Layers);
        Assert.Equal("V1", layer.Name);
        Assert.Equal(groupId, layer.GroupId);
    }

    [Fact]
    public async Task ListVersionsAsync_ReturnsAllVersionsMetadataOnly_OrderedByVersionNumberDescending()
    {
        await using var dbContext = await CreateMigratedDbContextAsync();
        var ownerId = await SeedUserAsync(dbContext);
        var project = await new ProjectRepository(dbContext).CreateAsync(ownerId, "Proyecto con 3 versiones", null, CancellationToken.None);
        var repository = new VectorDocumentRepository(dbContext);

        for (var i = 0; i < 3; i++)
        {
            await repository.SaveAsync(
                project.Id, ownerId,
                new DocumentSnapshot(1, 1, "0 0 1 1", 1, DocumentVersionOrigin.ManualEdit, "{}", []),
                CancellationToken.None);
        }

        var versions = await repository.ListVersionsAsync(project.Id, ownerId, CancellationToken.None);

        Assert.NotNull(versions);
        Assert.Equal([3, 2, 1], versions!.Select(v => v.VersionNumber));
    }

    [Fact]
    public async Task ListVersionsAsync_ProjectWithoutAnySavedVersion_ReturnsNull()
    {
        await using var dbContext = await CreateMigratedDbContextAsync();
        var ownerId = await SeedUserAsync(dbContext);
        var project = await new ProjectRepository(dbContext).CreateAsync(ownerId, "Proyecto sin guardar", null, CancellationToken.None);
        var repository = new VectorDocumentRepository(dbContext);

        var versions = await repository.ListVersionsAsync(project.Id, ownerId, CancellationToken.None);

        Assert.Null(versions);
    }

    [Fact]
    public async Task RestoreAsync_RestoringAnOldVersion_CreatesANewVersionWithoutTouchingTheIntermediateOnes()
    {
        await using var dbContext = await CreateMigratedDbContextAsync();
        var ownerId = await SeedUserAsync(dbContext);
        var project = await new ProjectRepository(dbContext).CreateAsync(ownerId, "Proyecto a restaurar", null, CancellationToken.None);
        var repository = new VectorDocumentRepository(dbContext);

        var groupId = Guid.NewGuid();

        // 8 saves consecutivos -- V3 es la que se va a restaurar más adelante, V8 queda como
        // la actual antes de restaurar.
        VectorDocumentSaveOutcome? lastOutcome = null;
        var v3LayerName = string.Empty;
        for (var i = 1; i <= 8; i++)
        {
            var asset = await SeedAssetAsync(dbContext, project.Id, "layer-svg");
            var name = $"Capa v{i}";
            if (i == 3)
            {
                v3LayerName = name;
            }

            lastOutcome = await repository.SaveAsync(
                project.Id, ownerId,
                new DocumentSnapshot(i, i, $"0 0 {i} {i}", 1, DocumentVersionOrigin.ManualEdit, "{}",
                    [new LayerSnapshot(groupId, name, 0, true, false, null, asset, new PaletteColorSnapshot("#abcdef", 100, false, 0), PathCount: i)]),
                CancellationToken.None);
        }

        Assert.Equal(8, lastOutcome!.VersionNumber);

        var restoreOutcome = await repository.RestoreAsync(project.Id, ownerId, versionNumber: 3, CancellationToken.None);

        Assert.NotNull(restoreOutcome);
        Assert.Equal(9, restoreOutcome!.VersionNumber); // siguiente número secuencial, nunca reescribe V3-V8

        await using var readContext = CreateDbContext();
        var document = await readContext.VectorDocuments
            .Include(d => d.Versions).ThenInclude(v => v.Layers)
            .FirstAsync(d => d.ProjectId == project.Id);

        Assert.Equal(9, document.Versions.Count); // V1..V8 + V9, ninguna se perdió

        var versionsByNumber = document.Versions.ToDictionary(v => v.VersionNumber);

        // V4..V8 totalmente intactas (mismo criterio que el test de secuencia de arriba).
        for (var i = 4; i <= 8; i++)
        {
            Assert.True(versionsByNumber.ContainsKey(i));
        }

        var v9 = versionsByNumber[9];
        Assert.Equal(DocumentVersionOrigin.Restore, v9.Origin);
        // PostgreSQL normaliza el whitespace de jsonb al guardar (agrega un espacio después de
        // ":") -- mismo criterio que ProjectRepositoryTests, la igualdad que importa es la del
        // CONTENIDO, no el string crudo byte-a-byte.
        Assert.Equal("{\"restoredFromVersion\": 3}", v9.MetadataJson);
        Assert.Equal(3, v9.WidthMm); // mismas dimensiones que V3, no las de V8
        Assert.Equal("0 0 3 3", v9.ViewBox);

        var v9Layer = Assert.Single(v9.Layers);
        Assert.Equal(v3LayerName, v9Layer.Name); // mismo contenido que V3
        Assert.Equal(groupId, v9Layer.GroupId);
        Assert.NotEqual(versionsByNumber[3].Layers.Single().Id, v9Layer.Id); // fila NUEVA, no reutilizada

        var reloadedProject = await readContext.Projects.FirstAsync(p => p.Id == project.Id);
        Assert.Equal(v9.Id, reloadedProject.CurrentVersionId);
    }

    [Fact]
    public async Task RestoreAsync_NonexistentVersionNumber_ReturnsNull()
    {
        await using var dbContext = await CreateMigratedDbContextAsync();
        var ownerId = await SeedUserAsync(dbContext);
        var project = await new ProjectRepository(dbContext).CreateAsync(ownerId, "Proyecto con una versión", null, CancellationToken.None);
        var repository = new VectorDocumentRepository(dbContext);

        await repository.SaveAsync(
            project.Id, ownerId,
            new DocumentSnapshot(1, 1, "0 0 1 1", 1, DocumentVersionOrigin.ManualEdit, "{}", []),
            CancellationToken.None);

        var outcome = await repository.RestoreAsync(project.Id, ownerId, versionNumber: 42, CancellationToken.None);

        Assert.Null(outcome);
    }

    [Fact]
    public async Task RestoreAsync_ProjectWithoutAnySavedVersion_ReturnsNull()
    {
        await using var dbContext = await CreateMigratedDbContextAsync();
        var ownerId = await SeedUserAsync(dbContext);
        var project = await new ProjectRepository(dbContext).CreateAsync(ownerId, "Proyecto sin guardar", null, CancellationToken.None);
        var repository = new VectorDocumentRepository(dbContext);

        var outcome = await repository.RestoreAsync(project.Id, ownerId, versionNumber: 1, CancellationToken.None);

        Assert.Null(outcome);
    }

    [Fact]
    public async Task SaveAsync_TwoConcurrentSaves_SecondThrowsDbUpdateConcurrencyException()
    {
        await using var seedContext = await CreateMigratedDbContextAsync();
        var ownerId = await SeedUserAsync(seedContext);
        var project = await new ProjectRepository(seedContext).CreateAsync(ownerId, "Proyecto concurrente", null, CancellationToken.None);

        // Mismo patrón que ProjectRepositoryTests.UpdateAsync_TwoConcurrentUpdates_...: dos
        // DbContext INDEPENDIENTES, cada uno con su propio "warm up read" de Project para
        // anclarse al xmin vigente ANTES de que el otro escriba.
        await using var contextA = CreateDbContext();
        await using var contextB = CreateDbContext();
        await contextA.Projects.FirstAsync(p => p.Id == project.Id);
        await contextB.Projects.FirstAsync(p => p.Id == project.Id);
        var repositoryA = new VectorDocumentRepository(contextA);
        var repositoryB = new VectorDocumentRepository(contextB);

        var snapshotA = new DocumentSnapshot(1, 1, "0 0 1 1", 1, DocumentVersionOrigin.ManualEdit, "{}", []);
        var snapshotB = new DocumentSnapshot(2, 2, "0 0 2 2", 1, DocumentVersionOrigin.ManualEdit, "{}", []);

        var outcomeA = await repositoryA.SaveAsync(project.Id, ownerId, snapshotA, CancellationToken.None);
        Assert.NotNull(outcomeA);

        // repositoryB todavía tiene el xmin VIEJO del Project -> su segundo SaveChangesAsync
        // (el que repunta Project.CurrentVersionId) no afecta ninguna fila -> EF Core lo
        // traduce a DbUpdateConcurrencyException real (concurrencia optimista de PostgreSQL).
        await Assert.ThrowsAsync<DbUpdateConcurrencyException>(
            () => repositoryB.SaveAsync(project.Id, ownerId, snapshotB, CancellationToken.None));

        await using var readContext = CreateDbContext();
        var reloadedProject = await readContext.Projects
            .Include(p => p.VectorDocuments).ThenInclude(d => d.Versions)
            .FirstAsync(p => p.Id == project.Id);
        Assert.Single(reloadedProject.VectorDocuments.Single().Versions); // solo A persistió de punta a punta
    }

    [Fact]
    public async Task RestoreAsync_ConcurrentWithAnotherSave_ThrowsDbUpdateConcurrencyException()
    {
        await using var seedContext = await CreateMigratedDbContextAsync();
        var ownerId = await SeedUserAsync(seedContext);
        var project = await new ProjectRepository(seedContext).CreateAsync(ownerId, "Proyecto a restaurar concurrentemente", null, CancellationToken.None);
        await new VectorDocumentRepository(seedContext).SaveAsync(
            project.Id, ownerId,
            new DocumentSnapshot(1, 1, "0 0 1 1", 1, DocumentVersionOrigin.ManualEdit, "{}", []),
            CancellationToken.None);

        await using var contextA = CreateDbContext();
        await using var contextB = CreateDbContext();
        await contextA.Projects.FirstAsync(p => p.Id == project.Id);
        await contextB.Projects.FirstAsync(p => p.Id == project.Id);
        var repositoryA = new VectorDocumentRepository(contextA);
        var repositoryB = new VectorDocumentRepository(contextB);

        // A guarda una versión nueva (V2) -- esto repunta Project.CurrentVersionId y bump xmin.
        var outcomeA = await repositoryA.SaveAsync(
            project.Id, ownerId,
            new DocumentSnapshot(2, 2, "0 0 2 2", 1, DocumentVersionOrigin.ManualEdit, "{}", []),
            CancellationToken.None);
        Assert.NotNull(outcomeA);

        // B intenta restaurar V1 con el xmin VIEJO -> 409 (DbUpdateConcurrencyException).
        await Assert.ThrowsAsync<DbUpdateConcurrencyException>(
            () => repositoryB.RestoreAsync(project.Id, ownerId, versionNumber: 1, CancellationToken.None));
    }

    [Fact]
    public async Task UpdateLayerAsync_WithPartialFields_PatchesOnlyThoseFields()
    {
        await using var dbContext = await CreateMigratedDbContextAsync();
        var ownerId = await SeedUserAsync(dbContext);
        var project = await new ProjectRepository(dbContext).CreateAsync(ownerId, "Proyecto a patchear", null, CancellationToken.None);
        var repository = new VectorDocumentRepository(dbContext);

        var groupId = Guid.NewGuid();
        var assetId = await SeedAssetAsync(dbContext, project.Id, "layer-svg");
        await repository.SaveAsync(
            project.Id, ownerId,
            new DocumentSnapshot(1, 1, "0 0 1 1", 1, DocumentVersionOrigin.ManualEdit, "{}",
                [new LayerSnapshot(groupId, "Original", 0, true, false, null, assetId, new PaletteColorSnapshot("#000000", 100, false, 0), PathCount: 1)]),
            CancellationToken.None);

        var patched = await repository.UpdateLayerAsync(
            project.Id, ownerId, groupId, new LayerPatch(Name: null, Order: 5, Visible: false, Locked: null, TouchOperation: true, Operation: ManufacturingOperationKind.Ignore),
            CancellationToken.None);

        Assert.NotNull(patched);
        Assert.Equal("Original", patched!.Name); // null = sin cambios
        Assert.Equal(5, patched.Order);
        Assert.False(patched.Visible);
        Assert.False(patched.Locked); // no tocado, preserva el valor anterior
        Assert.Equal(ManufacturingOperationKind.Ignore, patched.ManufacturingOperation);
    }

    [Fact]
    public async Task UpdateLayerAsync_CreatesANewVersion_NeverMutatesTheCheckpointItPatchedFrom()
    {
        // Prueba directa del fix de QA (fix round 1, M2.2-S06): UpdateLayerAsync mutaba la fila
        // de Layer de la versión actual IN-PLACE, violando la misma garantía de inmutabilidad
        // que el conflicto #1 de spec.md M2.2-S06 ya había resuelto para Save/Restore --
        // consultar esa versión como histórica DESPUÉS de un PATCH devolvía contenido distinto
        // del checkpoint original. Save (V1) -> PATCH un layer -> V1 debe seguir INTACTA
        // (FindVersionAsync con versionNumber=1 devuelve el contenido ORIGINAL, sin el patch),
        // una V2 nueva debe existir con el patch aplicado, y Project.CurrentVersionId debe
        // apuntar a V2.
        await using var dbContext = await CreateMigratedDbContextAsync();
        var ownerId = await SeedUserAsync(dbContext);
        var project = await new ProjectRepository(dbContext).CreateAsync(ownerId, "Proyecto a patchear sin mutar V1", null, CancellationToken.None);
        var repository = new VectorDocumentRepository(dbContext);

        var patchedGroupId = Guid.NewGuid();
        var otherGroupId = Guid.NewGuid();
        var assetId1 = await SeedAssetAsync(dbContext, project.Id, "layer-svg");
        var assetId2 = await SeedAssetAsync(dbContext, project.Id, "layer-svg");

        var v1 = await repository.SaveAsync(
            project.Id, ownerId,
            new DocumentSnapshot(10, 10, "0 0 10 10", 1, DocumentVersionOrigin.ManualEdit, "{}",
            [
                new LayerSnapshot(patchedGroupId, "Nombre original", 0, true, false, null, assetId1, new PaletteColorSnapshot("#111111", 50, false, 0), PathCount: 1),
                new LayerSnapshot(otherGroupId, "Otra capa", 1, true, false, null, assetId2, new PaletteColorSnapshot("#222222", 50, false, 1), PathCount: 2),
            ]),
            CancellationToken.None);
        Assert.Equal(1, v1!.VersionNumber);

        var patched = await repository.UpdateLayerAsync(
            project.Id, ownerId, patchedGroupId,
            new LayerPatch(Name: "Nombre patcheado", Order: null, Visible: null, Locked: null, TouchOperation: false, Operation: null),
            CancellationToken.None);

        Assert.NotNull(patched);
        Assert.Equal("Nombre patcheado", patched!.Name);

        // Lectura desde un DbContext NUEVO (misma rigurosidad que RestoreAsync_...: confirma lo
        // REALMENTE persistido en PostgreSQL, no un objeto todavía trackeado en memoria por el
        // dbContext que hizo el Save/PATCH).
        await using var readContext = CreateDbContext();
        var readRepository = new VectorDocumentRepository(readContext);

        // V1 (histórica) sigue devolviendo el contenido ORIGINAL -- el PATCH no la tocó.
        var v1Reloaded = await readRepository.FindVersionAsync(project.Id, ownerId, versionNumber: 1, CancellationToken.None);
        Assert.NotNull(v1Reloaded);
        var v1PatchedLayer = Assert.Single(v1Reloaded!.Value.Version.Layers, l => l.GroupId == patchedGroupId);
        Assert.Equal("Nombre original", v1PatchedLayer.Name);
        Assert.NotEqual(v1PatchedLayer.Id, patched.Id); // fila NUEVA, no la misma reutilizada

        // La versión ACTUAL (V2, creada por el PATCH) tiene el contenido patcheado Y preserva la
        // capa que no se tocó.
        var current = await readRepository.FindCurrentDocumentAsync(project.Id, ownerId, CancellationToken.None);
        Assert.NotNull(current);
        Assert.Equal(2, current!.Value.Version.VersionNumber);
        Assert.Equal(2, current.Value.Version.Layers.Count);
        var currentPatchedLayer = Assert.Single(current.Value.Version.Layers, l => l.GroupId == patchedGroupId);
        Assert.Equal("Nombre patcheado", currentPatchedLayer.Name);
        var currentOtherLayer = Assert.Single(current.Value.Version.Layers, l => l.GroupId == otherGroupId);
        Assert.Equal("Otra capa", currentOtherLayer.Name); // intacta, copiada tal cual

        var reloadedProject = await readContext.Projects.FirstAsync(p => p.Id == project.Id);
        Assert.Equal(current.Value.Version.Id, reloadedProject.CurrentVersionId);
    }

    [Fact]
    public async Task UpdateLayerAsync_LayerBelongsToASupersededHistoricalVersion_ReturnsNull()
    {
        await using var dbContext = await CreateMigratedDbContextAsync();
        var ownerId = await SeedUserAsync(dbContext);
        var project = await new ProjectRepository(dbContext).CreateAsync(ownerId, "Proyecto con capa removida", null, CancellationToken.None);
        var repository = new VectorDocumentRepository(dbContext);

        var keptGroupId = Guid.NewGuid();
        var removedGroupId = Guid.NewGuid();
        var assetId1 = await SeedAssetAsync(dbContext, project.Id, "layer-svg");
        var assetId2 = await SeedAssetAsync(dbContext, project.Id, "layer-svg");

        await repository.SaveAsync(
            project.Id, ownerId,
            new DocumentSnapshot(1, 1, "0 0 1 1", 1, DocumentVersionOrigin.ManualEdit, "{}",
            [
                new LayerSnapshot(keptGroupId, "Se mantiene", 0, true, false, null, assetId1, new PaletteColorSnapshot("#111111", 50, false, 0), PathCount: 1),
                new LayerSnapshot(removedGroupId, "Se va a quitar", 1, true, false, null, assetId2, new PaletteColorSnapshot("#222222", 50, false, 1), PathCount: 1),
            ]),
            CancellationToken.None);

        var assetId3 = await SeedAssetAsync(dbContext, project.Id, "layer-svg");
        // Segundo Save: "removedGroupId" ya no está presente -- su fila queda atrás, colgada de
        // la DocumentVersion ANTERIOR (ya no la actual del proyecto).
        await repository.SaveAsync(
            project.Id, ownerId,
            new DocumentSnapshot(1, 1, "0 0 1 1", 1, DocumentVersionOrigin.ManualEdit, "{}",
            [
                new LayerSnapshot(keptGroupId, "Se mantiene", 0, true, false, null, assetId3, new PaletteColorSnapshot("#111111", 100, false, 0), PathCount: 1),
            ]),
            CancellationToken.None);

        var patched = await repository.UpdateLayerAsync(
            project.Id, ownerId, removedGroupId, new LayerPatch("Intento de editar", null, null, null, false, null), CancellationToken.None);

        Assert.Null(patched);
    }

    [Fact]
    public async Task UpdateLayerAsync_WrongProjectId_ReturnsNull()
    {
        await using var dbContext = await CreateMigratedDbContextAsync();
        var ownerId = await SeedUserAsync(dbContext);
        var project = await new ProjectRepository(dbContext).CreateAsync(ownerId, "Proyecto A", null, CancellationToken.None);
        var otherProject = await new ProjectRepository(dbContext).CreateAsync(ownerId, "Proyecto B", null, CancellationToken.None);
        var repository = new VectorDocumentRepository(dbContext);

        var groupId = Guid.NewGuid();
        var assetId = await SeedAssetAsync(dbContext, project.Id, "layer-svg");
        await repository.SaveAsync(
            project.Id, ownerId,
            new DocumentSnapshot(1, 1, "0 0 1 1", 1, DocumentVersionOrigin.ManualEdit, "{}",
                [new LayerSnapshot(groupId, "Capa", 0, true, false, null, assetId, new PaletteColorSnapshot("#000000", 100, false, 0), PathCount: 1)]),
            CancellationToken.None);

        var patched = await repository.UpdateLayerAsync(
            otherProject.Id, ownerId, groupId, new LayerPatch("Otro nombre", null, null, null, false, null), CancellationToken.None);

        Assert.Null(patched);
    }

    [Fact]
    public async Task AllVersionEndpoints_SoftDeletedProject_BehaveAsNonexistent()
    {
        // "Documento eliminado" (spec.md M2.2-S06, "Tests"): Project soft-eliminado (M2.2-S03)
        // -> todos los métodos de versión se comportan como si el proyecto no existiera, vía
        // el query filter global de Project (DeletedAt == null) -- confirmado acá a nivel de
        // repositorio.
        await using var dbContext = await CreateMigratedDbContextAsync();
        var ownerId = await SeedUserAsync(dbContext);
        var projectRepository = new ProjectRepository(dbContext);
        var project = await projectRepository.CreateAsync(ownerId, "Proyecto a borrar", null, CancellationToken.None);
        var repository = new VectorDocumentRepository(dbContext);

        await repository.SaveAsync(
            project.Id, ownerId,
            new DocumentSnapshot(1, 1, "0 0 1 1", 1, DocumentVersionOrigin.ManualEdit, "{}", []),
            CancellationToken.None);

        var deleted = await projectRepository.SoftDeleteAsync(project.Id, ownerId, CancellationToken.None);
        Assert.True(deleted);

        Assert.Null(await repository.FindCurrentDocumentAsync(project.Id, ownerId, CancellationToken.None));
        Assert.Null(await repository.FindVersionAsync(project.Id, ownerId, 1, CancellationToken.None));
        Assert.Null(await repository.ListVersionsAsync(project.Id, ownerId, CancellationToken.None));
        Assert.Null(await repository.RestoreAsync(project.Id, ownerId, 1, CancellationToken.None));
    }

    private static async Task<Guid> SeedUserAsync(VectorizationDbContext dbContext)
    {
        var user = new User { Id = Guid.NewGuid(), DisplayName = "Usuario de prueba", CreatedAt = DateTimeOffset.UtcNow };
        dbContext.Users.Add(user);
        await dbContext.SaveChangesAsync();
        return user.Id;
    }

    private static async Task<Guid> SeedAssetAsync(VectorizationDbContext dbContext, Guid projectId, string type)
    {
        var assetId = Guid.NewGuid();
        dbContext.Assets.Add(new Asset
        {
            Id = assetId,
            ProjectId = projectId,
            Type = type,
            StorageKey = $"projects/{projectId:N}/{type}/{assetId:N}.svg",
            MimeType = "image/svg+xml",
            FileName = $"{assetId:N}.svg",
            Size = 10,
            Checksum = "deadbeef",
            CreatedAt = DateTimeOffset.UtcNow,
        });
        await dbContext.SaveChangesAsync();
        return assetId;
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
