namespace Vectorify.Api.Contracts;

/// <summary>
/// DTO versionado (M2.2-S03) de un <see cref="Vectorify.Api.Data.Project"/> completo --
/// NUNCA se expone la entidad EF directamente en una respuesta JSON (mismo patrón que
/// <see cref="LayerLayoutSetResponse"/>/<see cref="ApiErrorResponse"/>). Respuesta de
/// POST/GET/PATCH/duplicate de un único proyecto bajo <c>/api/v2/projects</c>.
/// M2.2-S08: gana el triple clásico (<c>ClassicProjectId/ClassicImageId/ClassicPaletteId</c>,
/// null en proyectos sin Save previo a esta tarjeta) con el que se reabre el Workspace.
/// </summary>
public sealed record ProjectResponse(
    Guid Id,
    Guid OwnerId,
    string Name,
    string? Description,
    Guid? ThumbnailAssetId,
    Guid? CurrentVersionId,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt,
    Guid? ClassicProjectId,
    Guid? ClassicImageId,
    Guid? ClassicPaletteId);

/// <summary>
/// DTO más liviano (M2.2-S03) para <c>GET /api/v2/projects</c> (listado): omite
/// OwnerId/CurrentVersionId, que el listado de un usuario no necesita (siempre es el suyo)
/// y que recargarían innecesariamente una respuesta con potencialmente 50+ proyectos (ver
/// spec.md, escala de referencia de M2.2-S08).
/// M2.2-S08: <see cref="LayerCount"/> = cantidad de Layers de la versión actual (0 si no hay
/// versión); <see cref="ThumbnailUrl"/> apunta al endpoint de assets existente
/// (<c>/api/v2/projects/{projectId}/assets/{assetId}</c>, relativo al origen de la API) o es
/// null sin thumbnail; el triple clásico permite reabrir el Workspace desde la pantalla Mis
/// Proyectos (null = "no se puede reabrir"). El listado nunca descarga SVG ni el original.
/// </summary>
public sealed record ProjectSummaryResponse(
    Guid Id,
    string Name,
    Guid? ThumbnailAssetId,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt,
    int LayerCount,
    string? ThumbnailUrl,
    Guid? ClassicProjectId,
    Guid? ClassicImageId,
    Guid? ClassicPaletteId);

/// <summary>Página de <see cref="ProjectSummaryResponse"/> -- TotalCount es el total ANTES de paginar, para que el cliente calcule cuántas páginas hay.</summary>
public sealed record ProjectListResponse(
    IReadOnlyList<ProjectSummaryResponse> Items,
    int Page,
    int PageSize,
    int TotalCount);
