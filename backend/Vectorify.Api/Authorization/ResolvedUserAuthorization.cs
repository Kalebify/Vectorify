using Microsoft.AspNetCore.Authorization;
using Vectorify.Api.Users;

namespace Vectorify.Api.Authorization;

/// <summary>
/// Requisito de la <c>FallbackPolicy</c> (M3.1-S06, DENEGAR POR DEFECTO): la request tiene un usuario efectivo RESUELTO
/// (<see cref="IUserContext.IsAuthenticated"/>). Se evalúa sobre <see cref="IUserContext"/> y no sobre <c>User.Identity</c> a propósito:
/// <list type="bullet">
/// <item><c>Auth:Mode=Authenticated</c>: <see cref="AuthenticatedUserContext"/> solo es "autenticado" si hay cookie de sesión válida
/// Y <c>UserProvisioningMiddleware</c> la mapeó a <c>Users.Id</c> (la identidad interna que el cliente no puede fabricar).</item>
/// <item><c>Auth:Mode=Development</c> (solo Development/Testing/Test): el usuario de desarrollo fijo satisface la política sin login,
/// de modo que el flujo actual y los E2E anónimos siguen funcionando.</item>
/// </list>
/// </summary>
public sealed class ResolvedUserRequirement : IAuthorizationRequirement
{
}

public sealed class ResolvedUserHandler : AuthorizationHandler<ResolvedUserRequirement>
{
    private readonly IUserContext _userContext;

    public ResolvedUserHandler(IUserContext userContext)
    {
        _userContext = userContext;
    }

    protected override Task HandleRequirementAsync(AuthorizationHandlerContext context, ResolvedUserRequirement requirement)
    {
        if (_userContext.IsAuthenticated)
        {
            context.Succeed(requirement);
        }

        return Task.CompletedTask;
    }
}

/// <summary>
/// Configuración de la autorización de la API: <c>FallbackPolicy</c> = usuario resuelto. Todo endpoint sin <c>AllowAnonymous</c>
/// ni política propia la hereda; los anónimos son una lista blanca mínima y explícita (<c>.AllowAnonymous()</c> en cada ruta; el test de arquitectura la fija).
/// </summary>
public static class ApiAuthorization
{
    public static IServiceCollection AddVectorifyAuthorization(this IServiceCollection services)
    {
        services.AddAuthorization(options =>
        {
            options.FallbackPolicy = new AuthorizationPolicyBuilder()
                .AddRequirements(new ResolvedUserRequirement())
                .Build();
        });
        services.AddScoped<IAuthorizationHandler, ResolvedUserHandler>();
        services.AddSingleton<IAuthorizationMiddlewareResultHandler, UnauthenticatedJsonResultHandler>();
        return services;
    }
}
