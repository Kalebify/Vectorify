namespace Vectorify.Api.Authorization;

/// <summary>
/// Marca (metadata de endpoint) de que una ruta cuelga del grupo del flujo clásico
/// <c>/api/v1/projects/{projectId}/images/{imageId}</c> y por lo tanto está protegida por <see cref="ClassicProjectOwnerMiddleware"/>.
/// La pone <see cref="ClassicProjectScopeExtensions.MapClassicProjectGroup"/> en UN solo sitio (el grupo), nunca cada ruta: añadir una
/// ruta nueva dentro del grupo la protege sin escribir nada; añadirla FUERA del grupo rompe el test de arquitectura.
/// </summary>
public sealed class ClassicProjectScopeMetadata
{
    public static readonly ClassicProjectScopeMetadata Instance = new();

    private ClassicProjectScopeMetadata()
    {
    }
}

public static class ClassicProjectScopeExtensions
{
    /// <summary>Prefijo de TODAS las rutas del flujo clásico con dueño (los nombres de los parámetros los lee el middleware).</summary>
    public const string RoutePrefix = "/api/v1/projects/{projectId:guid}/images/{imageId:guid}";

    public const string ProjectIdRouteKey = "projectId";
    public const string ImageIdRouteKey = "imageId";

    /// <summary>
    /// Grupo del flujo clásico con comprobación de dueño CENTRAL (M3.1-S06). Las rutas se mapean con paths RELATIVOS a
    /// <see cref="RoutePrefix"/>. La comprobación vive en <see cref="ClassicProjectOwnerMiddleware"/> (corre antes de enlazar parámetros y
    /// del handler) y se activa por la metadata que añade este grupo.
    /// </summary>
    public static RouteGroupBuilder MapClassicProjectGroup(this IEndpointRouteBuilder app) =>
        app.MapGroup(RoutePrefix).WithMetadata(ClassicProjectScopeMetadata.Instance);
}
