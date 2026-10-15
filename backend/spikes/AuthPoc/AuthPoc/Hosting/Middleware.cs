using System.Security.Claims;
using AuthPoc.Identity;
using AuthPoc.Users;

namespace AuthPoc.Hosting;

/// <summary>
/// Una vez por request, DESPUES de autenticar y autorizar: identidad externa -&gt; <c>User.Id</c> interno (creando el User la primera
/// vez) y agrega la identidad interna que lee <see cref="AuthenticatedUserContext"/>. Un principal autenticado sin subject
/// utilizable (p. ej. un token valido sin <c>sub</c>) no puede mapearse y se rechaza con 401.
/// </summary>
public sealed class UserProvisioningMiddleware
{
    private readonly RequestDelegate _next;
    private readonly string _fallbackProvider;

    public UserProvisioningMiddleware(RequestDelegate next, string fallbackProvider)
    {
        _next = next;
        _fallbackProvider = fallbackProvider;
    }

    public async Task InvokeAsync(HttpContext context, IUserProvisioner provisioner)
    {
        if (context.User.Identity?.IsAuthenticated == true)
        {
            if (!ClaimsIdentityReader.TryRead(context.User, _fallbackProvider, out var identity))
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

/// <summary>
/// Defensa CSRF para la sesion en cookie (solo se monta en la fuente B): toda request que modifica estado debe llevar la cabecera
/// personalizada <see cref="AuthPocHostOptions.CsrfHeaderName"/> (un formulario o una imagen de otro sitio no pueden anadirla, y un
/// <c>fetch</c> cross-origin con cabecera personalizada dispara un preflight que CORS rechaza para origenes no autorizados) y, si
/// trae <c>Origin</c>, este debe estar en la lista permitida. Complementa a SameSite=Lax; no lo sustituye.
/// </summary>
public sealed class CsrfGuardMiddleware
{
    private static readonly HashSet<string> SafeMethods = new(StringComparer.OrdinalIgnoreCase) { "GET", "HEAD", "OPTIONS", "TRACE" };

    private readonly RequestDelegate _next;
    private readonly HashSet<string> _allowedOrigins;

    public CsrfGuardMiddleware(RequestDelegate next, IEnumerable<string> allowedOrigins)
    {
        _next = next;
        _allowedOrigins = new HashSet<string>(allowedOrigins, StringComparer.OrdinalIgnoreCase);
    }

    public Task InvokeAsync(HttpContext context)
    {
        if (SafeMethods.Contains(context.Request.Method))
        {
            return _next(context);
        }

        var origin = context.Request.Headers.Origin.ToString();
        var originAllowed = string.IsNullOrEmpty(origin) || _allowedOrigins.Contains(origin);
        var hasHeader = context.Request.Headers.ContainsKey(AuthPocHostOptions.CsrfHeaderName);

        if (!originAllowed || !hasHeader)
        {
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            return Task.CompletedTask;
        }

        return _next(context);
    }
}
