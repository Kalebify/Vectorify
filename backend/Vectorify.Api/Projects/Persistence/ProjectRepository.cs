using Microsoft.EntityFrameworkCore;
using Vectorify.Api.Data;

namespace Vectorify.Api.Projects.Persistence;

/// <summary>
/// Implementación EF Core de <see cref="IProjectRepository"/> (M2.2-S03) contra
/// <see cref="VectorizationDbContext"/>. Único punto del código que emite queries EF
/// directas sobre <c>DbSet&lt;Project&gt;</c> para este caso de uso -- ver
/// IProjectRepository para por qué vive en este namespace.
/// </summary>
public sealed class ProjectRepository : IProjectRepository
{
    private readonly VectorizationDbContext _dbContext;

    public ProjectRepository(VectorizationDbContext dbContext)
    {
        _dbContext = dbContext;
    }

    public async Task<Project> CreateAsync(
        Guid ownerId, string name, string? description, CancellationToken cancellationToken,
        ClassicProjectLink? classicLink = null)
    {
        var now = DateTimeOffset.UtcNow;
        var project = new Project
        {
            Id = Guid.NewGuid(),
            OwnerId = ownerId,
            Name = name,
            Description = description,
            ClassicProjectId = classicLink?.ClassicProjectId,
            ClassicImageId = classicLink?.ClassicImageId,
            ClassicPaletteId = classicLink?.ClassicPaletteId,
            CreatedAt = now,
            UpdatedAt = now,
        };

        _dbContext.Projects.Add(project);
        await _dbContext.SaveChangesAsync(cancellationToken);

        return project;
    }

    public Task<Project?> FindByIdAsync(Guid id, Guid ownerId, CancellationToken cancellationToken) =>
        _dbContext.Projects.FirstOrDefaultAsync(p => p.Id == id && p.OwnerId == ownerId, cancellationToken);

    public async Task<(IReadOnlyList<ProjectListItem> Items, int TotalCount)> ListAsync(
        Guid ownerId, ProjectListQuery query, CancellationToken cancellationToken)
    {
        var baseQuery = _dbContext.Projects.Where(p => p.OwnerId == ownerId);

        if (!string.IsNullOrWhiteSpace(query.Search))
        {
            // ILIKE: búsqueda case-insensitive nativa de PostgreSQL (EF.Functions.ILike,
            // provisto por Npgsql.EntityFrameworkCore.PostgreSQL) -- se traduce a SQL, no
            // trae todas las filas a memoria para filtrar client-side.
            var pattern = $"%{query.Search.Trim()}%";
            baseQuery = baseQuery.Where(p => EF.Functions.ILike(p.Name, pattern));
        }

        var totalCount = await baseQuery.CountAsync(cancellationToken);

        baseQuery = query.SortBy switch
        {
            ProjectSortBy.Name => baseQuery.OrderBy(p => p.Name),
            ProjectSortBy.Created => baseQuery.OrderByDescending(p => p.CreatedAt),
            _ => baseQuery.OrderByDescending(p => p.UpdatedAt),
        };

        // LayerCount (M2.2-S08) se resuelve en ESTA misma query como subquery correlacionada de SQL
        // (COUNT sobre layers) -- una sola ida a la base para toda la página, sin N+1 y sin
        // materializar Layers/DocumentVersions.
        var items = await baseQuery
            .Skip((query.Page - 1) * query.PageSize)
            .Take(query.PageSize)
            .Select(p => new ProjectListItem(
                p,
                p.CurrentVersion == null ? 0 : p.CurrentVersion.Layers.Count))
            .ToListAsync(cancellationToken);

        return (items, totalCount);
    }

    public async Task<bool> SetThumbnailAsync(Guid id, Guid ownerId, Guid thumbnailAssetId, CancellationToken cancellationToken)
    {
        var project = await _dbContext.Projects.FirstOrDefaultAsync(p => p.Id == id && p.OwnerId == ownerId, cancellationToken);
        if (project is null)
        {
            return false;
        }

        // Deliberadamente NO toca UpdatedAt: generar el thumbnail no es una edición del usuario
        // (cambiaría el orden "última modificación" del listado).
        project.ThumbnailAssetId = thumbnailAssetId;
        await _dbContext.SaveChangesAsync(cancellationToken);

        return true;
    }

    public async Task<Project?> UpdateAsync(Guid id, Guid ownerId, string? name, string? description, CancellationToken cancellationToken)
    {
        var project = await _dbContext.Projects.FirstOrDefaultAsync(p => p.Id == id && p.OwnerId == ownerId, cancellationToken);
        if (project is null)
        {
            return null;
        }

        if (name is not null)
        {
            project.Name = name;
        }

        if (description is not null)
        {
            project.Description = description;
        }

        project.UpdatedAt = DateTimeOffset.UtcNow;

        // Si otra request actualizó esta misma fila entre el FirstOrDefaultAsync de arriba
        // y este SaveChangesAsync, el valor de "xmin" que EF Core envía en el WHERE del
        // UPDATE ya no coincide con el de la fila real -> 0 filas afectadas -> EF Core
        // lanza DbUpdateConcurrencyException (concurrencia optimista real, no simulada).
        await _dbContext.SaveChangesAsync(cancellationToken);

        return project;
    }

    public async Task<bool> SoftDeleteAsync(Guid id, Guid ownerId, CancellationToken cancellationToken)
    {
        var project = await _dbContext.Projects.FirstOrDefaultAsync(p => p.Id == id && p.OwnerId == ownerId, cancellationToken);
        if (project is null)
        {
            return false;
        }

        // Política de Assets (ver IMPL.md): los Assets de este proyecto NO se tocan acá --
        // ni se borran ni se desvinculan. Siguen existiendo en la tabla, simplemente
        // inalcanzables a través de este Project mientras el global query filter
        // (DeletedAt == null) lo excluya.
        var now = DateTimeOffset.UtcNow;
        project.DeletedAt = now;
        project.UpdatedAt = now;

        await _dbContext.SaveChangesAsync(cancellationToken);

        return true;
    }

    public async Task<Project?> DuplicateAsync(Guid id, Guid ownerId, string newName, CancellationToken cancellationToken)
    {
        var source = await _dbContext.Projects
            .Include(p => p.VectorDocuments).ThenInclude(d => d.Versions).ThenInclude(v => v.PaletteColors)
            .Include(p => p.VectorDocuments).ThenInclude(d => d.Versions).ThenInclude(v => v.Layers)
            .FirstOrDefaultAsync(p => p.Id == id && p.OwnerId == ownerId, cancellationToken);

        if (source is null)
        {
            return null;
        }

        var now = DateTimeOffset.UtcNow;
        var duplicate = new Project
        {
            Id = Guid.NewGuid(),
            OwnerId = ownerId,
            Name = newName,
            Description = source.Description,
            CreatedAt = now,
            UpdatedAt = now,

            // ThumbnailAssetId se asigna en la SEGUNDA fase de abajo, apuntando a la copia propia del
            // Asset (Project.ThumbnailAssetId -> Asset y Asset.ProjectId -> Project forman un ciclo
            // de inserts nuevos, mismo caso que CurrentVersionId).

            // M2.2-S08: el triple clásico se copia tal cual para que el duplicado también se pueda
            // reabrir desde Mis Proyectos.
            ClassicProjectId = source.ClassicProjectId,
            ClassicImageId = source.ClassicImageId,
            ClassicPaletteId = source.ClassicPaletteId,
        };

        // M2.2-S08: el duplicado necesita sus PROPIAS filas de Asset. La descarga
        // (GET /api/v2/projects/{projectId}/assets/{assetId}) filtra por (projectId, assetId), así
        // que reutilizar el Id de un Asset del original dejaba a todas las capas del duplicado sin
        // arte (404); y Layer.SvgAssetId/PathCount ni siquiera se copiaban. Las filas se copian con
        // Ids nuevos y la MISMA StorageKey: el binario es inmutable y no se re-copia en storage
        // (AssetService.DeleteAsync no borra el archivo mientras otra fila lo referencie). Solo se
        // copian los Assets realmente referenciados (SVG de capa, SVG de versión, thumbnail).
        var referencedAssetIds = new HashSet<Guid>();
        if (source.ThumbnailAssetId is { } sourceThumbnailId)
        {
            referencedAssetIds.Add(sourceThumbnailId);
        }

        foreach (var sourceVersion in source.VectorDocuments.SelectMany(d => d.Versions))
        {
            if (sourceVersion.SvgAssetId is { } versionAssetId)
            {
                referencedAssetIds.Add(versionAssetId);
            }

            foreach (var sourceLayer in sourceVersion.Layers)
            {
                if (sourceLayer.SvgAssetId is { } layerAssetId)
                {
                    referencedAssetIds.Add(layerAssetId);
                }
            }
        }

        var assetIdMap = new Dictionary<Guid, Guid>();
        if (referencedAssetIds.Count > 0)
        {
            var sourceAssets = await _dbContext.Assets
                .Where(a => a.ProjectId == source.Id && referencedAssetIds.Contains(a.Id))
                .ToListAsync(cancellationToken);

            foreach (var sourceAsset in sourceAssets)
            {
                var copy = new Asset
                {
                    Id = Guid.NewGuid(),
                    ProjectId = duplicate.Id,
                    Type = sourceAsset.Type,
                    StorageKey = sourceAsset.StorageKey,
                    MimeType = sourceAsset.MimeType,
                    FileName = sourceAsset.FileName,
                    Size = sourceAsset.Size,
                    Width = sourceAsset.Width,
                    Height = sourceAsset.Height,
                    Checksum = sourceAsset.Checksum,
                    CreatedAt = now,
                };
                assetIdMap[sourceAsset.Id] = copy.Id;
                duplicate.Assets.Add(copy);
            }
        }

        Guid? MapAsset(Guid? sourceAssetId) =>
            sourceAssetId is { } id && assetIdMap.TryGetValue(id, out var mapped) ? mapped : null;

        Guid? duplicateCurrentVersionId = null;

        foreach (var document in source.VectorDocuments)
        {
            var newDocument = new VectorDocument
            {
                Id = Guid.NewGuid(),
                ProjectId = duplicate.Id,
            };

            foreach (var version in document.Versions)
            {
                var newVersion = new DocumentVersion
                {
                    Id = Guid.NewGuid(),
                    VectorDocumentId = newDocument.Id,
                    VersionNumber = version.VersionNumber,
                    // M2.2-S06: WidthMm/HeightMm/ViewBox/SchemaVersion viven ahora POR versión
                    // (ver el conflicto #2 de spec.md M2.2-S06) -- se copian de la versión
                    // origen, no del VectorDocument (que ya no los tiene).
                    WidthMm = version.WidthMm,
                    HeightMm = version.HeightMm,
                    ViewBox = version.ViewBox,
                    SchemaVersion = version.SchemaVersion,
                    // Apunta a la copia propia del Asset (ver assetIdMap arriba).
                    SvgAssetId = MapAsset(version.SvgAssetId),
                    Origin = version.Origin,
                    MetadataJson = version.MetadataJson,
                    CreatedAt = now,
                };

                if (source.CurrentVersionId == version.Id)
                {
                    duplicateCurrentVersionId = newVersion.Id;
                }

                var colorIdMap = new Dictionary<Guid, Guid>();
                foreach (var color in version.PaletteColors)
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
                }

                foreach (var layer in version.Layers)
                {
                    newVersion.Layers.Add(new Layer
                    {
                        Id = Guid.NewGuid(),
                        // M2.2-S06: GroupId (el groupId clásico) se copia TAL CUAL -- preserva
                        // la correlación "mismo layer conceptual" entre la versión original y
                        // la duplicada. No es la PK (ver Layer.GroupId), así que repetir el
                        // mismo valor acá no colisiona con el índice único compuesto
                        // (VersionId, GroupId): VersionId ya es distinto (newVersion.Id nuevo).
                        GroupId = layer.GroupId,
                        VersionId = newVersion.Id,
                        ColorId = colorIdMap[layer.ColorId],
                        Name = layer.Name,
                        Order = layer.Order,
                        Visible = layer.Visible,
                        Locked = layer.Locked,
                        ManufacturingOperation = layer.ManufacturingOperation,
                        SvgAssetId = MapAsset(layer.SvgAssetId),
                        PathCount = layer.PathCount,
                    });
                }

                newDocument.Versions.Add(newVersion);
            }

            duplicate.VectorDocuments.Add(newDocument);
        }

        // CurrentVersionId se asigna en un SEGUNDO SaveChangesAsync, no en el primer
        // INSERT: Project.CurrentVersionId -> DocumentVersion, DocumentVersion.VectorDocumentId
        // -> VectorDocument y VectorDocument.ProjectId -> Project forman un ciclo real entre
        // tres filas NUEVAS insertadas en el mismo batch (EF Core no puede ordenar un INSERT
        // cíclico y lanza InvalidOperationException: "circular dependency"). Como
        // CurrentVersionId es nullable, se rompe el ciclo insertando primero con
        // CurrentVersionId=null (grafo restante sin ciclos) y recién después, con todas las
        // filas ya existentes, se completa el puntero.
        _dbContext.Projects.Add(duplicate);
        await _dbContext.SaveChangesAsync(cancellationToken);

        var duplicateThumbnailId = MapAsset(source.ThumbnailAssetId);
        if (duplicateCurrentVersionId is not null || duplicateThumbnailId is not null)
        {
            duplicate.CurrentVersionId = duplicateCurrentVersionId;
            duplicate.ThumbnailAssetId = duplicateThumbnailId;
            await _dbContext.SaveChangesAsync(cancellationToken);
        }

        return duplicate;
    }
}
