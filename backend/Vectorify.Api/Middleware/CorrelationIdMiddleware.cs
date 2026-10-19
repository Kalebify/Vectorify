namespace Vectorify.Api.Middleware;

/// <summary>
/// Asegura que toda request tenga un correlation/request ID: reutiliza el header
/// entrante X-Correlation-Id si viene del cliente, o genera uno nuevo. Lo agrega
/// a la respuesta y lo mete en el scope del logger para que todo log estructurado
/// emitido durante la request quede correlacionado.
/// </summary>
public sealed class CorrelationIdMiddleware
{
    public const string HeaderName = "X-Correlation-Id";

    /// <summary>Largo máximo de un correlation ID entrante (M3.1-S09): acota lo que un cliente puede hacer escribir en cada línea de log.</summary>
    public const int MaxLength = 64;

    /// <summary>
    /// Un ID entrante solo se reutiliza si es un identificador opaco (letras, dígitos, <c>.</c> <c>_</c> <c>-</c>; hasta <see cref="MaxLength"/>). Cualquier otra cosa —saltos de línea (inyección de log),
    /// espacios, correos, JWT/tokens pegados por error, valores enormes— se descarta y se genera uno nuevo: el correlation ID nunca es un canal de PII ni de datos del cliente hacia el log.
    /// </summary>
    public static bool IsAcceptable(string? value)
    {
        if (string.IsNullOrEmpty(value) || value.Length > MaxLength)
        {
            return false;
        }

        foreach (var c in value)
        {
            if (!(char.IsAsciiLetterOrDigit(c) || c is '-' or '_' or '.'))
            {
                return false;
            }
        }

        return true;
    }

    private readonly RequestDelegate _next;

    public CorrelationIdMiddleware(RequestDelegate next)
    {
        _next = next;
    }

    public async Task InvokeAsync(HttpContext context, ILogger<CorrelationIdMiddleware> logger)
    {
        var correlationId = context.Request.Headers.TryGetValue(HeaderName, out var incoming)
            && IsAcceptable(incoming.ToString())
                ? incoming.ToString()
                : Guid.NewGuid().ToString("n");

        context.Items[HeaderName] = correlationId;

        context.Response.OnStarting(() =>
        {
            context.Response.Headers[HeaderName] = correlationId;
            return Task.CompletedTask;
        });

        using (logger.BeginScope(new Dictionary<string, object> { ["CorrelationId"] = correlationId }))
        {
            logger.LogInformation(
                "Request iniciada {Method} {Path}",
                context.Request.Method,
                context.Request.Path);

            await _next(context);

            logger.LogInformation(
                "Request finalizada {Method} {Path} -> {StatusCode}",
                context.Request.Method,
                context.Request.Path,
                context.Response.StatusCode);
        }
    }
}
