namespace Vectorify.Api.Projects.Persistence;

/// <summary>
/// Triple clásico (projectId, imageId, paletteId) del flujo de staging del que nace un
/// <see cref="Vectorify.Api.Data.Project"/> v2 en su primer Save (M2.2-S08). Se persiste en
/// <c>Project.ClassicProjectId/ClassicImageId/ClassicPaletteId</c> para poder reabrir el
/// Workspace desde Mis Proyectos.
/// </summary>
public sealed record ClassicProjectLink(Guid ClassicProjectId, Guid ClassicImageId, Guid ClassicPaletteId);
