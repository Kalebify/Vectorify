using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Authorization.Policy;
using Vectorify.Api.Contracts;

namespace Vectorify.Api.Authorization;

/// <summary>
/// Respuesta de la autorización cuando falla la <c>FallbackPolicy</c> (M3.1-S06): 401 con el cuerpo de error estándar de la API
/// (<c>{ code: "unauthenticated" }</c>) en lugar de un 401 vacío, para que la SPA (frontera 401 de S04) y los clientes distingan «sin
/// sesión» sin parsear cabeceras. Sin <c>Response.Clear()</c>: conserva las cabeceras CORS y el correlation ID. Cualquier otro resultado
/// (continuar, 403) lo resuelve el manejador por defecto de ASP.NET Core.
/// </summary>
public sealed class UnauthenticatedJsonResultHandler : IAuthorizationMiddlewareResultHandler
{
    public const string Code = "unauthenticated";
    public const string Message = "Necesitás iniciar sesión para usar este recurso.";

    private readonly AuthorizationMiddlewareResultHandler _default = new();

    public Task HandleAsync(RequestDelegate next, HttpContext context, AuthorizationPolicy policy, PolicyAuthorizationResult authorizeResult)
    {
        if (!authorizeResult.Challenged)
        {
            return _default.HandleAsync(next, context, policy, authorizeResult);
        }

        context.Response.StatusCode = StatusCodes.Status401Unauthorized;
        return context.Response.WriteAsJsonAsync(new ApiErrorResponse(Code, Message), context.RequestAborted);
    }
}
