using Vectorify.Api.Data;

namespace Vectorify.Api.Projects.Persistence;

/// <summary>
/// Una fila del listado de proyectos (M2.2-S08): el <see cref="Project"/> más los datos derivados
/// que la pantalla Mis Proyectos necesita y que se resuelven en la MISMA query de listado (subquery
/// correlacionada, sin N+1 y sin cargar Layers/DocumentVersions completos).
/// </summary>
public sealed record ProjectListItem(Project Project, int LayerCount);
