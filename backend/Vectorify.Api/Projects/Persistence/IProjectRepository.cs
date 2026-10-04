using Vectorify.Api.Data;

namespace Vectorify.Api.Projects.Persistence;

/// <summary>
/// Acceso a datos de <see cref="Project"/> (M2.2-S03) contra PostgreSQL vía EF Core.
/// Deliberadamente en el namespace <c>Vectorify.Api.Projects.Persistence</c> -- un
/// sub-namespace NUEVO y distinto de <c>Vectorify.Api.Projects</c> (donde viven
/// <see cref="IProjectRegistry"/>/<see cref="ProjectRecord"/> del flujo clásico de upload,
/// MVP1) para que ningún nombre de acá se confunda con esos -- ver spec.md, "Conflicto
/// real detectado" e IMPL.md para el razonamiento completo. NO reemplaza ni toca
/// <see cref="IProjectRegistry"/>.
///
/// Todo método recibe <c>ownerId</c> EXPLÍCITO (resuelto más arriba, en
/// <see cref="Vectorify.Api.ProjectManagement.ProjectService"/>, desde
/// <see cref="Vectorify.Api.Users.IUserContext"/>) y SIEMPRE filtra por él -- nunca una
/// query sin ese filtro. Mantener el ownerId como parámetro explícito (en vez de que el
/// repositorio dependa de IUserContext directamente) simplifica los tests: pueden ejercitar
/// cualquier combinación de ownerId sin necesidad de un IUserContext real/mockeado.
/// </summary>
public interface IProjectRepository
{
    /// <summary>
    /// <paramref name="classicLink"/> (M2.2-S08): triple clásico que se persiste junto con el
    /// Project cuando lo crea el primer Save; null para <c>POST /api/v2/projects</c> "vacío".
    /// </summary>
    Task<Project> CreateAsync(
        Guid ownerId, string name, string? description, CancellationToken cancellationToken,
        ClassicProjectLink? classicLink = null);

    /// <summary>Null si no existe O si existe pero pertenece a otro OwnerId -- mismo resultado para ambos casos (ver spec.md, ownership).</summary>
    Task<Project?> FindByIdAsync(Guid id, Guid ownerId, CancellationToken cancellationToken);

    /// <summary>
    /// Cada item trae además <c>LayerCount</c> (Layers de la CurrentVersion) y el ProjectId dueño
    /// del thumbnail, resueltos en la misma query (M2.2-S08, sin N+1).
    /// </summary>
    Task<(IReadOnlyList<ProjectListItem> Items, int TotalCount)> ListAsync(
        Guid ownerId, ProjectListQuery query, CancellationToken cancellationToken);

    /// <summary>
    /// Apunta <c>ThumbnailAssetId</c> al Asset dado (M2.2-S08, primer Save). No toca UpdatedAt.
    /// False si el proyecto no existe/no pertenece al owner.
    /// </summary>
    Task<bool> SetThumbnailAsync(Guid id, Guid ownerId, Guid thumbnailAssetId, CancellationToken cancellationToken);

    /// <summary>
    /// Campos null = "sin cambios" (ver ProjectService para la validación de negocio previa).
    /// Null si no existe/no pertenece al owner. Puede lanzar
    /// <see cref="Microsoft.EntityFrameworkCore.DbUpdateConcurrencyException"/> si el
    /// concurrency token (xmin) cambió desde que se leyó la fila -- ProjectService la
    /// traduce a un ProjectResult.Conflict (409).
    /// </summary>
    Task<Project?> UpdateAsync(Guid id, Guid ownerId, string? name, string? description, CancellationToken cancellationToken);

    /// <summary>
    /// Soft-delete (setea DeletedAt/UpdatedAt). Los Assets del proyecto NO se tocan (ver
    /// IMPL.md, "Política de Assets al soft-deletear"). False si no existe/no pertenece al
    /// owner.
    /// </summary>
    Task<bool> SoftDeleteAsync(Guid id, Guid ownerId, CancellationToken cancellationToken);

    /// <summary>
    /// Nuevo Project.Id + nuevos Id de VectorDocument/DocumentVersion/Layer/PaletteColor
    /// asociados (si los hay) -- nunca reutiliza ningún Id del original. Los Assets NO se
    /// duplican (fuera de alcance, ver IMPL.md): las DocumentVersion duplicadas referencian
    /// el MISMO SvgAssetId que el original. Null si el proyecto origen no existe/no
    /// pertenece al owner. M2.2-S08: el duplicado SÍ copia el triple clásico y
    /// <c>ThumbnailAssetId</c> (mismo Asset, consistente con "los Assets no se duplican").
    /// </summary>
    Task<Project?> DuplicateAsync(Guid id, Guid ownerId, string newName, CancellationToken cancellationToken);
}
