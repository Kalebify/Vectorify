namespace Vectorify.Api.Security;

/// <summary>
/// Cabeceras de seguridad de TODAS las respuestas de la API (M3.1-S09; también las de error, 403 de CSRF y 429, porque va el primero del pipeline). Se añaden al empezar la respuesta
/// (<c>OnStarting</c>) y nunca pisan una cabecera que un endpoint ya fijó. La API devuelve JSON, imágenes y descargas, nunca HTML, así que su CSP es la más cerrada posible:
/// <list type="bullet">
/// <item><c>X-Content-Type-Options: nosniff</c>: el navegador respeta el <c>Content-Type</c> (un PNG no se interpreta como HTML/script).</item>
/// <item><c>Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; sandbox</c>: si alguien abre un SVG
/// o una descarga directamente en una pestaña, no ejecuta scripts ni comparte origen con la API (el <c>sandbox</c> sin <c>allow-same-origin</c> le da un origen opaco: no puede usar la cookie de sesión).
/// <c>style-src 'unsafe-inline'</c> solo permite que un SVG mostrado en su propia pestaña conserve sus estilos <c>style=""</c>; sin <c>img-src</c>/<c>font-src</c> ningún estilo puede cargar nada externo.
/// Un <c>&lt;img src&gt;</c> de la SPA no se ve afectado (la CSP de un recurso solo gobierna al documento que él mismo sería).</item>
/// <item><c>X-Frame-Options: DENY</c> (equivalente histórico de <c>frame-ancestors 'none'</c>).</item>
/// <item><c>Referrer-Policy: no-referrer</c>: las respuestas de la API nunca son un documento desde el que se pidan más recursos con enlace saliente; es distinto de la SPA, que usa
/// <c>strict-origin-when-cross-origin</c> (un <c>no-referrer</c> global en la SPA haría que sus peticiones del mismo origen salgan con <c>Origin: null</c> y el CsrfGuard respondería 403).</item>
/// <item><c>Permissions-Policy</c> mínima: ninguna capacidad del navegador queda delegada.</item>
/// <item><c>Cache-Control: private, no-cache</c> por defecto en <c>/api/*</c> si el endpoint no fijó otra (las respuestas dependen de la cookie: ninguna caché compartida debe guardarlas); <c>no-store</c> en <c>/api/v1/auth/*</c>.</item>
/// </list>
/// Swagger UI (solo Development) necesita scripts y estilos en línea: se exceptúa de la CSP y de <c>X-Frame-Options</c>.
/// </summary>
public sealed class SecurityHeadersMiddleware
{
    public const string ApiContentSecurityPolicy =
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; sandbox";

    public const string PermissionsPolicy =
        "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()";

    private readonly RequestDelegate _next;

    public SecurityHeadersMiddleware(RequestDelegate next)
    {
        _next = next;
    }

    public Task InvokeAsync(HttpContext context)
    {
        context.Response.OnStarting(static state =>
        {
            var http = (HttpContext)state;
            var headers = http.Response.Headers;
            var isSwagger = http.Request.Path.StartsWithSegments("/swagger");

            headers.TryAdd("X-Content-Type-Options", "nosniff");
            headers.TryAdd("Referrer-Policy", "no-referrer");
            headers.TryAdd("Permissions-Policy", PermissionsPolicy);
            if (!isSwagger)
            {
                headers.TryAdd("Content-Security-Policy", ApiContentSecurityPolicy);
                headers.TryAdd("X-Frame-Options", "DENY");
            }

            if (http.Request.Path.StartsWithSegments("/api") && !headers.ContainsKey("Cache-Control"))
            {
                // Auth: nunca se guarda (ni el 401/403/429 que genera el framework sin pasar por el endpoint); el resto: privado y a revalidar.
                headers["Cache-Control"] = http.Request.Path.StartsWithSegments("/api/v1/auth") ? "no-store" : "private, no-cache";
            }

            return Task.CompletedTask;
        }, context);

        return _next(context);
    }
}
