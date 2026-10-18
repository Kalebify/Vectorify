using Vectorify.Api.Contracts;
using Vectorify.Api.Projects;

namespace Vectorify.Api.Authorization;

/// <summary>
/// Comprobación de dueño CENTRAL del flujo clásico (M3.1-S06, T11 del ADR). Para toda ruta marcada con
/// <see cref="ClassicProjectScopeMetadata"/> (el grupo <c>/api/v1/projects/{projectId}/images/{imageId}</c>) resuelve el registro
/// UNA vez por request y, si no existe o no es del usuario efectivo, responde un 404 con el MISMO cuerpo y cabeceras en ambos casos
/// (no se filtra la existencia de recursos ajenos); el handler nunca se ejecuta. Va DESPUÉS de <c>UseAuthorization</c> (un anónimo ya
/// recibió 401) y antes del endpoint, así que ni se leen cuerpos ni se llama al motor Python para un recurso ajeno.
/// </summary>
public sealed class ClassicProjectOwnerMiddleware
{
    public const string NotFoundCode = "not_found";
    public const string NotFoundMessage = "No existe un proyecto/imagen con esos IDs.";

    private readonly RequestDelegate _next;

    public ClassicProjectOwnerMiddleware(RequestDelegate next)
    {
        _next = next;
    }

    public async Task InvokeAsync(HttpContext context, IClassicProjectAccess access)
    {
        var endpoint = context.GetEndpoint();
        if (endpoint?.Metadata.GetMetadata<ClassicProjectScopeMetadata>() is null)
        {
            await _next(context);
            return;
        }

        var routeValues = context.Request.RouteValues;
        if (TryGetGuid(routeValues, ClassicProjectScopeExtensions.ProjectIdRouteKey, out var projectId)
            && TryGetGuid(routeValues, ClassicProjectScopeExtensions.ImageIdRouteKey, out var imageId)
            && access.FindAccessible(projectId, imageId) is not null)
        {
            await _next(context);
            return;
        }

        // Sin Response.Clear(): conserva las cabeceras CORS y el correlation ID ya añadidas. Falla cerrado también si faltara un parámetro.
        context.Response.StatusCode = StatusCodes.Status404NotFound;
        await context.Response.WriteAsJsonAsync(new ApiErrorResponse(NotFoundCode, NotFoundMessage), context.RequestAborted);
    }

    private static bool TryGetGuid(RouteValueDictionary values, string key, out Guid value)
    {
        value = Guid.Empty;
        return values.TryGetValue(key, out var raw) && Guid.TryParse(raw?.ToString(), out value);
    }
}
