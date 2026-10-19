using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.Options;
using Vectorify.Api.Contracts;
using Vectorify.Api.Options;

namespace Vectorify.Api.Users;

/// <summary>
/// Límites de frecuencia de la recuperación (M3.1-S08) con el limitador NATIVO (<c>Microsoft.AspNetCore.RateLimiting</c> / <c>System.Threading.RateLimiting</c>), en dos ejes:
/// <list type="bullet">
/// <item><b>Por IP</b> (política <see cref="IpPolicyName"/>, por ruta): al excederse, <c>429</c> + <c>Retry-After</c> (la IP ya es conocida por quien escribe; no revela cuentas).</item>
/// <item><b>Por dirección</b> (esta clase): clave = HMAC-SHA256 del correo (o id) con una clave aleatoria de PROCESO, así que ni el limitador ni un volcado de memoria guardan el
/// correo en claro. Al excederse, forgot/resend responden el 202 uniforme SIN enviar (para no revelar nada) y reset/confirm el mismo error genérico que un token inválido.</item>
/// </list>
/// Ventana fija, en memoria, por instancia (varias instancias del backend dividen el contador: límite conocido; S09 puede moverlo a un almacén común).
/// Detrás de un proxy sin <c>ForwardedHeaders</c> (S09) todas las peticiones comparten la IP del proxy: el límite por IP actuaría como global.
/// </summary>
public sealed class AuthRecoveryLimiter : IDisposable
{
    public const string IpPolicyName = "auth-recovery-ip";

    private readonly byte[] _key = RandomNumberGenerator.GetBytes(32);
    private readonly PartitionedRateLimiter<string> _send;
    private readonly PartitionedRateLimiter<string> _verify;

    public AuthRecoveryLimiter(IOptions<AuthOptions> options)
    {
        var limits = options.Value.RateLimit;
        _send = Create(limits.AddressSendPermitLimit, limits.AddressWindow);
        _verify = Create(limits.AddressVerifyPermitLimit, limits.AddressWindow);
    }

    /// <summary>true si esta dirección aún puede pedir un correo (forgot/resend comparten el mismo contador).</summary>
    public bool TryAcquireSend(string address) => Acquire(_send, address);

    /// <summary>true si esta dirección (o id de cuenta) aún puede intentar un reset/confirm (comparten el mismo contador).</summary>
    public bool TryAcquireVerify(string address) => Acquire(_verify, address);

    public void Dispose()
    {
        _send.Dispose();
        _verify.Dispose();
    }

    private static PartitionedRateLimiter<string> Create(int permitLimit, TimeSpan window) =>
        PartitionedRateLimiter.Create<string, string>(key =>
            RateLimitPartition.GetFixedWindowLimiter(key, _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = permitLimit,
                Window = window,
                QueueLimit = 0,
                AutoReplenishment = true,
            }));

    private bool Acquire(PartitionedRateLimiter<string> limiter, string address)
    {
        var hash = Convert.ToHexString(HMACSHA256.HashData(_key, Encoding.UTF8.GetBytes(address.Trim().ToLowerInvariant())));
        using var lease = limiter.AttemptAcquire(hash);
        return lease.IsAcquired;
    }

    /// <summary>Registra la política por IP y la respuesta 429 (con <c>Retry-After</c>) en el limitador nativo.</summary>
    public static IServiceCollection AddAuthRecoveryRateLimiting(IServiceCollection services)
    {
        services.AddSingleton<AuthRecoveryLimiter>();
        services.AddRateLimiter(_ => { });
        services.AddOptions<RateLimiterOptions>().Configure<IOptions<AuthOptions>>((limiter, auth) =>
        {
            limiter.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
            limiter.AddPolicy(IpPolicyName, http =>
            {
                var limits = auth.Value.RateLimit;

                // Una cuenta de contador por IP y por ruta: pedir un enlace no gasta el cupo de confirmar.
                var ip = http.Connection.RemoteIpAddress?.ToString() ?? "unknown";
                return RateLimitPartition.GetFixedWindowLimiter($"{ip}|{http.Request.Path}", _ => new FixedWindowRateLimiterOptions
                {
                    PermitLimit = limits.IpPermitLimit,
                    Window = limits.IpWindow,
                    QueueLimit = 0,
                    AutoReplenishment = true,
                });
            });

            limiter.OnRejected = async (context, cancellationToken) =>
            {
                var response = context.HttpContext.Response;
                var window = auth.Value.RateLimit.IpWindow;
                var retryAfter = context.Lease.TryGetMetadata(MetadataName.RetryAfter, out var suggested) ? suggested : window;
                var seconds = Math.Max(1, (int)Math.Ceiling(retryAfter.TotalSeconds));

                response.StatusCode = StatusCodes.Status429TooManyRequests;
                response.Headers.RetryAfter = seconds.ToString(CultureInfo.InvariantCulture);
                response.Headers.CacheControl = "no-store";
                await response.WriteAsJsonAsync(
                    new ApiErrorResponse("rate_limited", "Hiciste demasiados pedidos seguidos. Esperá unos minutos antes de volver a probar."),
                    cancellationToken);
            };
        });
        return services;
    }
}
