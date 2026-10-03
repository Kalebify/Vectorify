using Microsoft.EntityFrameworkCore;
using Vectorify.Api.Data;

namespace Vectorify.Api.VectorDocuments.Persistence;

/// <summary>Implementación EF Core de <see cref="IVectorDocumentRepository"/> (M2.2-S05/S06). Ver la interfaz para el rol en la arquitectura.</summary>
public sealed class VectorDocumentRepository : IVectorDocumentRepository
{
    private readonly VectorizationDbContext _dbContext;

    public VectorDocumentRepository(VectorizationDbContext dbContext)
    {
        _dbContext = dbContext;
    }

    public async Task<VectorDocumentSaveOutcome?> SaveAsync(
        Guid projectId, Guid ownerId, DocumentSnapshot snapshot, CancellationToken cancellationToken)
    {
        var project = await _dbContext.Projects
            .Include(p => p.VectorDocuments).ThenInclude(d => d.Versions)
            .FirstOrDefaultAsync(p => p.Id == projectId && p.OwnerId == ownerId, cancellationToken);

        if (project is null)
        {
            return null;
        }

        // Transacción EXPLÍCITA (no el default de UN SaveChangesAsync implícito): el ciclo real
        // Project <-> VectorDocument <-> DocumentVersion (Project.CurrentVersionId -> DocumentVersion
        // nueva, DocumentVersion.VectorDocumentId -> VectorDocument, VectorDocument.ProjectId ->
        // Project) obliga a partir la escritura en DOS SaveChangesAsync -- mismo patrón exacto que
        // ProjectRepository.DuplicateAsync: primero se insertan VectorDocument/DocumentVersion/
        // Layer/PaletteColor con Project.CurrentVersionId todavía intacto (grafo sin ciclo), y
        // recién en un segundo SaveChangesAsync se repunta Project.CurrentVersionId a la versión ya
        // persistida. Sin una transacción EXPLÍCITA envolviendo ambos, un fallo entre el primer y
        // el segundo SaveChangesAsync dejaría el primero ya comprometido -- justo lo que
        // spec.md M2.2-S05 ("Tests": "sin filas a medias") prohíbe. Se hace rollback automático al
        // Dispose si nunca se llama a CommitAsync (p. ej. si el segundo SaveChangesAsync lanza
        // DbUpdateConcurrencyException).
        await using var transaction = await _dbContext.Database.BeginTransactionAsync(cancellationToken);

        // Un Project v2 tiene, en esta tarjeta, a lo sumo UN VectorDocument (el "documento" del
        // proyecto) -- si todavía no existe (primer Save de este Project), se crea acá.
        var document = project.VectorDocuments.FirstOrDefault();
        if (document is null)
        {
            document = new VectorDocument { Id = Guid.NewGuid(), ProjectId = project.Id };
            project.VectorDocuments.Add(document);

            // Explícito a propósito: VectorDocument llega al change tracker vía fixup de la
            // colección de navegación de un Project NO nuevo (Unchanged) -- sin este Add
            // explícito, EF Core asume (por tener ya un Id de Guid NO default, asignado por la
            // aplicación) que la fila YA EXISTE y genera un UPDATE en vez de un INSERT, que
            // afecta 0 filas y dispara DbUpdateConcurrencyException. Mismo gotcha aplica a
            // DocumentVersion/PaletteColor/Layer más abajo -- ver el reporte del sprint.
            _dbContext.Add(document);
        }

        var nextVersionNumber = document.Versions.Count == 0
            ? 1
            : document.Versions.Max(v => v.VersionNumber) + 1;

        var now = DateTimeOffset.UtcNow;
        var version = new DocumentVersion
        {
            Id = Guid.NewGuid(),
            VectorDocumentId = document.Id,
            VersionNumber = nextVersionNumber,
            WidthMm = snapshot.WidthMm,
            HeightMm = snapshot.HeightMm,
            ViewBox = snapshot.ViewBox,
            SchemaVersion = snapshot.SchemaVersion,
            Origin = snapshot.Origin,
            MetadataJson = snapshot.MetadataJson,
            CreatedAt = now,
        };
        document.Versions.Add(version);
        _dbContext.Add(version); // siempre nuevo -- ver comentario de arriba sobre VectorDocument.

        // M2.2-S06: cada checkpoint vuelve a insertar TODOS los Layers/PaletteColors vigentes
        // como filas 100% NUEVAS (Guid.NewGuid() propio por fila, nunca reutiliza/actualiza una
        // fila de una versión anterior) -- ya NO hace falta la rama upsert-vs-insert de M2.2-S05
        // (ver el conflicto #1 de spec.md M2.2-S06: ese upsert "robaba" la fila de la versión
        // anterior, dejándola con huecos -- violaba la inmutabilidad que esta tarjeta exige).
        // Layer.GroupId preserva la correlación "mismo layer conceptual" entre versiones sin
        // comprometer la PK global de "layers" (Layer.Id).
        foreach (var layerSnapshot in snapshot.Layers)
        {
            var color = new PaletteColor
            {
                Id = Guid.NewGuid(),
                VersionId = version.Id,
                Hex = layerSnapshot.Color.Hex,
                Coverage = layerSnapshot.Color.Coverage,
                IsBackground = layerSnapshot.Color.IsBackground,
                Order = layerSnapshot.Color.Order,
            };
            version.PaletteColors.Add(color);
            _dbContext.Add(color); // siempre nuevo -- ver comentario sobre VectorDocument más arriba.

            var layer = new Layer
            {
                Id = Guid.NewGuid(),
                GroupId = layerSnapshot.LayerId,
                VersionId = version.Id,
                ColorId = color.Id,
                Name = layerSnapshot.Name,
                Order = layerSnapshot.Order,
                Visible = layerSnapshot.Visible,
                Locked = layerSnapshot.Locked,
                ManufacturingOperation = layerSnapshot.ManufacturingOperation,
                SvgAssetId = layerSnapshot.SvgAssetId,
                PathCount = layerSnapshot.PathCount,
            };
            version.Layers.Add(layer);
            _dbContext.Add(layer); // siempre nuevo -- ver comentario sobre VectorDocument más arriba.
        }

        // Fase 1: inserta VectorDocument/DocumentVersion/Layer/PaletteColor -- Project.CurrentVersionId
        // todavía no se tocó, así que este grafo no tiene ciclos (ver comentario de arriba).
        await _dbContext.SaveChangesAsync(cancellationToken);

        project.CurrentVersionId = version.Id;
        project.UpdatedAt = now;

        // Fase 2: repunta Project a la versión recién persistida. Acá es donde EF Core emite el
        // UPDATE real sobre "projects" (con xmin en el WHERE) -- si hubo un Save concurrente entre
        // el FirstOrDefaultAsync de arriba y este punto, lanza DbUpdateConcurrencyException
        // (VectorDocumentService la traduce a VectorDocumentResult.Conflict, 409).
        await _dbContext.SaveChangesAsync(cancellationToken);

        await transaction.CommitAsync(cancellationToken);

        return new VectorDocumentSaveOutcome(project.Id, version.VersionNumber, project.UpdatedAt);
    }

    public async Task<(VectorDocument Document, DocumentVersion Version)?> FindCurrentDocumentAsync(
        Guid projectId, Guid ownerId, CancellationToken cancellationToken)
    {
        var project = await _dbContext.Projects
            .FirstOrDefaultAsync(p => p.Id == projectId && p.OwnerId == ownerId, cancellationToken);

        if (project?.CurrentVersionId is null)
        {
            return null;
        }

        // Resuelve el VersionNumber de la versión actual y delega a FindVersionAsync -- caso
        // particular de la lectura genérica por número (M2.2-S06), sin duplicar la carga del
        // grafo completo (Layers/PaletteColors).
        var currentVersionNumber = await _dbContext.DocumentVersions
            .Where(v => v.Id == project.CurrentVersionId)
            .Select(v => (int?)v.VersionNumber)
            .FirstOrDefaultAsync(cancellationToken);

        if (currentVersionNumber is null)
        {
            return null;
        }

        return await FindVersionAsync(projectId, ownerId, currentVersionNumber.Value, cancellationToken);
    }

    public async Task<(VectorDocument Document, DocumentVersion Version)?> FindVersionAsync(
        Guid projectId, Guid ownerId, int versionNumber, CancellationToken cancellationToken)
    {
        var project = await _dbContext.Projects
            .Include(p => p.VectorDocuments)
            .FirstOrDefaultAsync(p => p.Id == projectId && p.OwnerId == ownerId, cancellationToken);

        var document = project?.VectorDocuments.FirstOrDefault();
        if (document is null)
        {
            return null;
        }

        var version = await _dbContext.DocumentVersions
            .Include(v => v.Layers).ThenInclude(l => l.Color)
            .Include(v => v.PaletteColors)
            .FirstOrDefaultAsync(v => v.VectorDocumentId == document.Id && v.VersionNumber == versionNumber, cancellationToken);

        if (version is null)
        {
            return null;
        }

        return (document, version);
    }

    public async Task<IReadOnlyList<DocumentVersion>?> ListVersionsAsync(
        Guid projectId, Guid ownerId, CancellationToken cancellationToken)
    {
        var project = await _dbContext.Projects
            .Include(p => p.VectorDocuments)
            .FirstOrDefaultAsync(p => p.Id == projectId && p.OwnerId == ownerId, cancellationToken);

        var document = project?.VectorDocuments.FirstOrDefault();
        if (document is null)
        {
            return null;
        }

        return await _dbContext.DocumentVersions
            .Where(v => v.VectorDocumentId == document.Id)
            .OrderByDescending(v => v.VersionNumber)
            .ToListAsync(cancellationToken);
    }

    public async Task<VectorDocumentSaveOutcome?> RestoreAsync(
        Guid projectId, Guid ownerId, int versionNumber, CancellationToken cancellationToken)
    {
        var project = await _dbContext.Projects
            .Include(p => p.VectorDocuments).ThenInclude(d => d.Versions)
            .FirstOrDefaultAsync(p => p.Id == projectId && p.OwnerId == ownerId, cancellationToken);

        var document = project?.VectorDocuments.FirstOrDefault();
        if (project is null || document is null)
        {
            return null;
        }

        var sourceVersionMeta = document.Versions.FirstOrDefault(v => v.VersionNumber == versionNumber);
        if (sourceVersionMeta is null)
        {
            return null;
        }

        // Carga el grafo completo (Layers/PaletteColors) de la versión origen -- document.Versions
        // (de arriba) solo trae metadata vía el Include plano, sin sus hijos.
        var sourceVersion = await _dbContext.DocumentVersions
            .Include(v => v.Layers)
            .Include(v => v.PaletteColors)
            .FirstAsync(v => v.Id == sourceVersionMeta.Id, cancellationToken);

        // Misma transacción EF explícita de dos fases que SaveAsync -- ver ese método para el
        // razonamiento completo del ciclo Project <-> VectorDocument <-> DocumentVersion.
        await using var transaction = await _dbContext.Database.BeginTransactionAsync(cancellationToken);

        var nextVersionNumber = document.Versions.Max(v => v.VersionNumber) + 1;
        var now = DateTimeOffset.UtcNow;

        var newVersion = new DocumentVersion
        {
            Id = Guid.NewGuid(),
            VectorDocumentId = document.Id,
            VersionNumber = nextVersionNumber,
            WidthMm = sourceVersion.WidthMm,
            HeightMm = sourceVersion.HeightMm,
            ViewBox = sourceVersion.ViewBox,
            SchemaVersion = sourceVersion.SchemaVersion,
            Origin = DocumentVersionOrigin.Restore,
            MetadataJson = $"{{\"restoredFromVersion\":{versionNumber}}}",
            CreatedAt = now,
        };
        document.Versions.Add(newVersion);
        _dbContext.Add(newVersion);

        // Copia fresca (ids nuevos) de cada PaletteColor de la versión origen -- se necesita el
        // mapeo viejo-Id -> nuevo-Id para poder repuntar Layer.ColorId más abajo sin reutilizar
        // ninguna fila de la versión origen (misma garantía de inmutabilidad que SaveAsync).
        var colorIdMap = new Dictionary<Guid, Guid>();
        foreach (var color in sourceVersion.PaletteColors)
        {
            var newColor = new PaletteColor
            {
                Id = Guid.NewGuid(),
                VersionId = newVersion.Id,
                Hex = color.Hex,
                Coverage = color.Coverage,
                IsBackground = color.IsBackground,
                Order = color.Order,
            };
            colorIdMap[color.Id] = newColor.Id;
            newVersion.PaletteColors.Add(newColor);
            _dbContext.Add(newColor);
        }

        // Copia fresca (ids nuevos) de cada Layer de la versión origen -- SvgAssetId se reusa
        // TAL CUAL (el Asset ya existe en storage, no hace falta volver a subir nada, más
        // rápido que un Save normal), GroupId también se reusa TAL CUAL (preserva la identidad
        // conceptual del layer a través de la restauración).
        foreach (var layer in sourceVersion.Layers)
        {
            var newLayer = new Layer
            {
                Id = Guid.NewGuid(),
                GroupId = layer.GroupId,
                VersionId = newVersion.Id,
                ColorId = colorIdMap[layer.ColorId],
                Name = layer.Name,
                Order = layer.Order,
                Visible = layer.Visible,
                Locked = layer.Locked,
                ManufacturingOperation = layer.ManufacturingOperation,
                SvgAssetId = layer.SvgAssetId,
                PathCount = layer.PathCount,
            };
            newVersion.Layers.Add(newLayer);
            _dbContext.Add(newLayer);
        }

        // Fase 1: inserta DocumentVersion/Layer/PaletteColor -- Project.CurrentVersionId todavía
        // no se tocó (grafo sin ciclos, ver SaveAsync).
        await _dbContext.SaveChangesAsync(cancellationToken);

        project!.CurrentVersionId = newVersion.Id;
        project.UpdatedAt = now;

        // Fase 2: repunta Project a la versión nueva. Mismo mecanismo de concurrencia optimista
        // (xmin) que SaveAsync -- un Save/Restore concurrente sobre el mismo Project entre medio
        // dispara DbUpdateConcurrencyException acá (VectorDocumentService la traduce a 409).
        await _dbContext.SaveChangesAsync(cancellationToken);

        await transaction.CommitAsync(cancellationToken);

        return new VectorDocumentSaveOutcome(project.Id, newVersion.VersionNumber, project.UpdatedAt);
    }

    public async Task<Layer?> UpdateLayerAsync(
        Guid projectId, Guid ownerId, Guid layerId, LayerPatch patch, CancellationToken cancellationToken)
    {
        var project = await _dbContext.Projects
            .Include(p => p.VectorDocuments).ThenInclude(d => d.Versions)
            .FirstOrDefaultAsync(p => p.Id == projectId && p.OwnerId == ownerId, cancellationToken);

        var document = project?.VectorDocuments.FirstOrDefault();
        if (project?.CurrentVersionId is null || document is null)
        {
            return null;
        }

        // Fix round 1 (QA post-merge): esta operación mutaba la fila de Layer de la
        // DocumentVersion ACTUAL in-place, violando la misma garantía de inmutabilidad que el
        // conflicto #1 de spec.md M2.2-S06 ya había resuelto para Save/Restore -- consultar esa
        // versión como histórica DESPUÉS de un PATCH devolvía contenido distinto del checkpoint
        // original. Fix: PATCH es, igual que Save/Restore, un checkpoint -- crea una
        // DocumentVersion COMPLETA nueva (mismo patrón de copia fresca que RestoreAsync: TODOS
        // los Layer/PaletteColor de la versión actual, ids nuevos), con el patch aplicado SOLO
        // sobre la copia nueva del Layer identificado por GroupId, Origin: ManualEdit (es una
        // edición manual, no un restore), y repunta Project.CurrentVersionId a la versión nueva.
        // Misma transacción EF explícita de dos fases y mismo mecanismo de concurrencia (xmin)
        // que SaveAsync/RestoreAsync.
        var currentVersion = await _dbContext.DocumentVersions
            .Include(v => v.Layers)
            .Include(v => v.PaletteColors)
            .FirstOrDefaultAsync(v => v.Id == project.CurrentVersionId, cancellationToken);

        if (currentVersion is null)
        {
            return null;
        }

        // M2.2-S06: busca por GroupId (el groupId clásico, estable a través de versiones) -- ya
        // NO por Layer.Id (esa PK es una fila nueva en cada checkpoint, ver el conflicto #1 de
        // spec.md M2.2-S06). Si no está en la versión ACTUAL (p. ej. pertenece a una versión
        // histórica ya superada), no hay nada que patchear.
        if (currentVersion.Layers.All(l => l.GroupId != layerId))
        {
            return null;
        }

        await using var transaction = await _dbContext.Database.BeginTransactionAsync(cancellationToken);

        var nextVersionNumber = document.Versions.Max(v => v.VersionNumber) + 1;
        var now = DateTimeOffset.UtcNow;

        var newVersion = new DocumentVersion
        {
            Id = Guid.NewGuid(),
            VectorDocumentId = document.Id,
            VersionNumber = nextVersionNumber,
            WidthMm = currentVersion.WidthMm,
            HeightMm = currentVersion.HeightMm,
            ViewBox = currentVersion.ViewBox,
            SchemaVersion = currentVersion.SchemaVersion,
            Origin = DocumentVersionOrigin.ManualEdit,
            MetadataJson = "{}",
            CreatedAt = now,
        };
        document.Versions.Add(newVersion);
        _dbContext.Add(newVersion); // siempre nuevo -- ver comentario de SaveAsync sobre el fixup de EF Core.

        // Copia fresca (ids nuevos) de cada PaletteColor de la versión actual -- idéntico a
        // RestoreAsync, necesita el mapeo viejo-Id -> nuevo-Id para repuntar Layer.ColorId.
        var colorIdMap = new Dictionary<Guid, Guid>();
        foreach (var color in currentVersion.PaletteColors)
        {
            var newColor = new PaletteColor
            {
                Id = Guid.NewGuid(),
                VersionId = newVersion.Id,
                Hex = color.Hex,
                Coverage = color.Coverage,
                IsBackground = color.IsBackground,
                Order = color.Order,
            };
            colorIdMap[color.Id] = newColor.Id;
            newVersion.PaletteColors.Add(newColor);
            _dbContext.Add(newColor);
        }

        // Copia fresca (ids nuevos) de cada Layer de la versión actual -- el identificado por
        // GroupId == layerId recibe el patch aplicado sobre la copia NUEVA (nunca sobre la fila
        // vieja de currentVersion, que queda intacta como checkpoint histórico).
        Layer? patchedLayer = null;
        foreach (var layer in currentVersion.Layers)
        {
            var newLayer = new Layer
            {
                Id = Guid.NewGuid(),
                GroupId = layer.GroupId,
                VersionId = newVersion.Id,
                ColorId = colorIdMap[layer.ColorId],
                Name = layer.Name,
                Order = layer.Order,
                Visible = layer.Visible,
                Locked = layer.Locked,
                ManufacturingOperation = layer.ManufacturingOperation,
                SvgAssetId = layer.SvgAssetId,
                PathCount = layer.PathCount,
            };

            if (layer.GroupId == layerId)
            {
                if (patch.Name is not null)
                {
                    newLayer.Name = patch.Name;
                }

                if (patch.Order is not null)
                {
                    newLayer.Order = patch.Order.Value;
                }

                if (patch.Visible is not null)
                {
                    newLayer.Visible = patch.Visible.Value;
                }

                if (patch.Locked is not null)
                {
                    newLayer.Locked = patch.Locked.Value;
                }

                if (patch.TouchOperation)
                {
                    newLayer.ManufacturingOperation = patch.Operation;
                }

                patchedLayer = newLayer;
            }

            newVersion.Layers.Add(newLayer);
            _dbContext.Add(newLayer);
        }

        // Fase 1: inserta DocumentVersion/Layer/PaletteColor -- Project.CurrentVersionId todavía
        // no se tocó (grafo sin ciclos, ver SaveAsync).
        await _dbContext.SaveChangesAsync(cancellationToken);

        project.CurrentVersionId = newVersion.Id;
        project.UpdatedAt = now;

        // Fase 2: repunta Project a la versión nueva. Mismo mecanismo de concurrencia optimista
        // (xmin) que SaveAsync/RestoreAsync -- un Save/Restore/PATCH concurrente sobre el mismo
        // Project entre medio dispara DbUpdateConcurrencyException acá (VectorDocumentService.UpdateLayerAsync
        // la traduce a VectorDocumentResult.Conflict, 409).
        await _dbContext.SaveChangesAsync(cancellationToken);

        await transaction.CommitAsync(cancellationToken);

        return patchedLayer;
    }
}
