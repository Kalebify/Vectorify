using Microsoft.Extensions.Options;
using Vectorify.Api.Contracts;
using Vectorify.Api.Options;

namespace Vectorify.Api.Middleware;

/// <summary>
/// Defensa CSRF de la sesión en cookie (M3.1-S03, T3 del ADR; complementa a <c>SameSite=Lax</c>, no lo sustituye). Solo en
/// <see cref="AuthMode.Authenticated"/>: todo método NO seguro (cualquiera salvo GET/HEAD/OPTIONS/TRACE) debe llevar la cabecera
/// personalizada <see cref="HeaderName"/> (un formulario o una imagen de otro sitio no pueden añadirla, y un <c>fetch</c> cross-origin
/// con cabecera propia dispara un preflight que CORS rechaza para orígenes ajenos) Y una cabecera <c>Origin</c> que figure en
/// <c>Cors:AllowedOrigins</c>. Si falta cualquiera de las dos, o el origen es ajeno, responde 403 sin ejecutar nada más.
/// En modo <see cref="AuthMode.Development"/> (sin sesiones) NO se aplica, para no romper el flujo de desarrollo ni los E2E anónimos.
/// Va DESPUÉS de CORS (el 403 lleva las cabeceras CORS y el preflight OPTIONS ya se resolvió) y ANTES de autenticar.
/// </summary>
public sealed class CsrfGuardMiddleware
{
    /// <summary>Cabecera que la SPA envía en todo método no seguro (también la lista CORS permitida).</summary>
    public const string HeaderName = "X-Vectorify-Request";

    public const string RejectedCode = "csrf_rejected";

    private static readonly HashSet<string> SafeMethods = new(StringComparer.OrdinalIgnoreCase)
    {
        HttpMethods.Get, HttpMethods.Head, HttpMethods.Options, HttpMethods.Trace,
    };

    private readonly RequestDelegate _next;

    public CsrfGuardMiddleware(RequestDelegate next)
    {
        _next = next;
    }

    public async Task InvokeAsync(
        HttpContext context,
        IOptions<AuthOptions> authOptions,
        IOptions<FrontendCorsOptions> corsOptions,
        ILogger<CsrfGuardMiddleware> logger)
    {
        if (authOptions.Value.Mode != AuthMode.Authenticated || SafeMethods.Contains(context.Request.Method))
        {
            await _next(context);
            return;
        }

        var hasHeader = !string.IsNullOrWhiteSpace(context.Request.Headers[HeaderName].ToString());
        var origin = context.Request.Headers.Origin.ToString().Trim().TrimEnd('/');
        var originAllowed = origin.Length > 0
            && corsOptions.Value.GetOrigins().Contains(origin, StringComparer.OrdinalIgnoreCase);

        if (hasHeader && originAllowed)
        {
            await _next(context);
            return;
        }

        // Sin PII ni valores de cabeceras en el log: solo qué falló.
        logger.LogWarning(
            "CSRF: {Method} {Path} rechazada (cabecera {HasHeader}, origen permitido {OriginAllowed}).",
            context.Request.Method, context.Request.Path, hasHeader, originAllowed);

        context.Response.StatusCode = StatusCodes.Status403Forbidden;
        await context.Response.WriteAsJsonAsync(
            new ApiErrorResponse(RejectedCode, "La solicitud no es válida: falta la cabecera de seguridad o el origen no está permitido."),
            context.RequestAborted);
    }
}
