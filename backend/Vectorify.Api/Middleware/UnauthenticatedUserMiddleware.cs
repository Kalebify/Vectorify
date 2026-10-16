using Vectorify.Api.Contracts;
using Vectorify.Api.Users;

namespace Vectorify.Api.Middleware;

/// <summary>
/// Traduce <see cref="UnauthenticatedUserException"/> (M3.1-S03) a <c>401</c>. En modo Authenticated los endpoints del flujo
/// existente todavía no exigen autorización de forma declarativa (la denegación por defecto es M3.1-S06): una request sin sesión
/// llega hasta <c>IUserContext.GetEffectiveUserId()</c>, que falla CERRADO lanzando esa excepción. Sin esta red, el cliente vería un
/// 500; con ella, tras un logout (o con una cookie caducada/manipulada) cualquier endpoint de usuario responde 401 y la SPA puede
/// llevar al login. Nunca se ejecutó trabajo para otro usuario: la excepción se lanza antes de leer o escribir datos. S06 la
/// reemplaza por la política de autorización y esta red queda como defensa en profundidad.
/// </summary>
public sealed class UnauthenticatedUserMiddleware
{
    public const string Code = "unauthenticated";

    private readonly RequestDelegate _next;

    public UnauthenticatedUserMiddleware(RequestDelegate next)
    {
        _next = next;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        try
        {
            await _next(context);
        }
        catch (UnauthenticatedUserException) when (!context.Response.HasStarted)
        {
            // Sin Response.Clear(): conserva las cabeceras CORS y el correlation ID ya añadidos por los middlewares anteriores.
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            await context.Response.WriteAsJsonAsync(
                new ApiErrorResponse(Code, "Necesitás iniciar sesión para usar este recurso."),
                context.RequestAborted);
        }
    }
}
