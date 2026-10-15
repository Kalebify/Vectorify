using System.Security.Claims;

namespace Vectorify.Api.Users;

/// <summary>
/// Una vez por request, DESPUÉS de autenticar y autorizar: identidad externa -&gt; <c>User.Id</c> interno (creando el User la
/// primera vez) y agrega la identidad interna que lee <see cref="AuthenticatedUserContext"/>. Un principal autenticado sin
/// subject utilizable (p. ej. un token válido sin <c>sub</c>) no puede mapearse y se rechaza con 401. Las requests anónimas
/// pasan sin tocar la base.
/// </summary>
public sealed class UserProvisioningMiddleware
{
    private readonly RequestDelegate _next;

    public UserProvisioningMiddleware(RequestDelegate next)
    {
        _next = next;
    }

    public async Task InvokeAsync(HttpContext context, IUserProvisioner provisioner)
    {
        if (context.User.Identity?.IsAuthenticated == true)
        {
            if (!ClaimsIdentityReader.TryRead(context.User, VectorifyClaimTypes.AspNetIdentityProvider, out var identity))
            {
                context.Response.StatusCode = StatusCodes.Status401Unauthorized;
                return;
            }

            var provisioned = await provisioner.EnsureUserAsync(identity, context.RequestAborted);
            context.User.AddIdentity(new ClaimsIdentity(
                [new Claim(VectorifyClaimTypes.InternalUserId, provisioned.UserId.ToString())],
                VectorifyClaimTypes.InternalAuthenticationType));
        }

        await _next(context);
    }
}
