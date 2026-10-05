using Npgsql;
using Vectorify.Api.Contracts;
using Vectorify.Api.Storage;

namespace Vectorify.Api.Middleware;

/// <summary>
/// Red de seguridad de la persistencia (M2.2-S10): traduce a un error CONTROLADO las dos fallas de infraestructura
/// que los endpoints no atrapan uno por uno, en vez de dejar escapar una excepción (500 con stack en Development,
/// 500 vacío en Production):
/// <list type="bullet">
/// <item>PostgreSQL no disponible (conexión rechazada/cortada, timeout de conexión, servidor arrancando o
/// apagándose) -&gt; <c>503</c> <see cref="ApiErrorResponse"/> con <c>database_unavailable</c>.</item>
/// <item>El storage lanza <see cref="FileStorageException"/> en un punto donde ningún servicio la traduce a su
/// propio resultado (p. ej. leer un asset o el SVG de una capa) -&gt; <c>503</c> con <c>storage_failure</c>.</item>
/// </list>
/// Cualquier otra excepción se deja pasar intacta (un bug real sigue siendo un 500 visible, no se enmascara).
/// El cuerpo nunca incluye el mensaje/stack de la excepción ni datos de la conexión; el detalle va al log. No
/// hay estado entre requests: cuando Postgres vuelve, la siguiente request funciona sin reiniciar el proceso (al
/// detectar la caída se vacían los pools de Npgsql, así las conexiones ociosas muertas no producen una racha de
/// errores tras la recuperación).
/// </summary>
public sealed class DependencyFailureMiddleware
{
    public const string DatabaseUnavailableCode = "database_unavailable";
    public const string StorageFailureCode = "storage_failure";

    private readonly RequestDelegate _next;

    public DependencyFailureMiddleware(RequestDelegate next)
    {
        _next = next;
    }

    public async Task InvokeAsync(HttpContext context, ILogger<DependencyFailureMiddleware> logger)
    {
        try
        {
            await _next(context);
        }
        catch (Exception ex) when (!context.Response.HasStarted && !context.RequestAborted.IsCancellationRequested
                                   && IsDatabaseUnavailable(ex))
        {
            logger.LogWarning(ex, "PostgreSQL no disponible procesando {Method} {Path}", context.Request.Method, context.Request.Path);
            NpgsqlConnection.ClearAllPools();

            context.Response.Headers.RetryAfter = "5";
            await WriteErrorAsync(
                context,
                DatabaseUnavailableCode,
                "La base de datos no está disponible en este momento. Intentá de nuevo en unos segundos.");
        }
        catch (Exception ex) when (!context.Response.HasStarted && !context.RequestAborted.IsCancellationRequested
                                   && ContainsStorageFailure(ex))
        {
            logger.LogError(ex, "Fallo de storage procesando {Method} {Path}", context.Request.Method, context.Request.Path);

            await WriteErrorAsync(
                context,
                StorageFailureCode,
                "El almacenamiento de archivos no está disponible en este momento. Intentá de nuevo en unos minutos.");
        }
    }

    private static Task WriteErrorAsync(HttpContext context, string code, string message)
    {
        context.Response.Clear();
        context.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
        return context.Response.WriteAsJsonAsync(new ApiErrorResponse(code, message), context.RequestAborted);
    }

    /// <summary>
    /// ¿La falla es de conectividad con PostgreSQL (y no un error de datos/consulta)? Recorre la cadena de
    /// excepciones porque EF Core envuelve la de Npgsql (p. ej. <c>InvalidOperationException</c> "likely due to a
    /// transient failure" en consultas, <c>DbUpdateException</c> en SaveChanges). Un <see cref="PostgresException"/>
    /// solo cuenta si su SQLSTATE es de conexión/servidor no disponible: una violación de constraint (23xxx) o un
    /// error de sintaxis siguen siendo bugs y siguen siendo 500.
    /// </summary>
    public static bool IsDatabaseUnavailable(Exception exception)
    {
        for (var current = exception; current is not null; current = current.InnerException)
        {
            switch (current)
            {
                case PostgresException postgres:
                    return IsConnectivitySqlState(postgres.SqlState);
                case NpgsqlException:
                    // Sin código SQL de Postgres: falla de red/protocolo/timeout al hablar con el servidor.
                    return true;
            }
        }

        return false;
    }

    private static bool IsConnectivitySqlState(string sqlState) =>
        sqlState.StartsWith("08", StringComparison.Ordinal) // connection_exception
        || sqlState is "53300" // too_many_connections
            or "57P01" // admin_shutdown
            or "57P02" // crash_shutdown
            or "57P03"; // cannot_connect_now (arrancando / recuperándose)

    private static bool ContainsStorageFailure(Exception exception)
    {
        for (var current = exception; current is not null; current = current.InnerException)
        {
            if (current is FileStorageException)
            {
                return true;
            }
        }

        return false;
    }
}
