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
/// M3.1-S09 extiende el MISMO mecanismo a <c>login</c> y <c>register</c> (políticas <see cref="LoginIpPolicyName"/>/<see cref="RegisterIpPolicyName"/> y contadores por dirección
/// <see cref="TryAcquireLogin"/>/<see cref="TryAcquireRegister"/>). Allí el excedente por dirección da 429 + <c>Retry-After</c> (no una respuesta «simulada»): el contador cuenta TODA petición
/// para esa dirección —exista o no la cuenta, acierte o falle la contraseña— y se consulta ANTES de tocar la base, así que el 429 no depende de la cuenta y no la revela.
/// Ventana fija, en memoria, por instancia (varias instancias del backend dividen el contador: límite conocido, ver docs/AUTH_SECURITY_REVIEW.md).
/// La IP es <c>RemoteIpAddress</c>: detrás de un proxy hay que configurar <c>Auth:ForwardedHeaders</c> (si no, todas las peticiones comparten la IP del proxy y el límite por IP actúa como global).
/// </summary>
public sealed class AuthRecoveryLimiter : IDisposable
{
    public const string IpPolicyName = "auth-recovery-ip";

    /// <summary>Política por IP de <c>POST /api/v1/auth/login</c> (M3.1-S09).</summary>
    public const string LoginIpPolicyName = "auth-login-ip";

    /// <summary>Política por IP de <c>POST /api/v1/auth/register</c> (M3.1-S09).</summary>
    public const string RegisterIpPolicyName = "auth-register-ip";

    public const string RateLimitedCode = "rate_limited";

    public const string RateLimitedMessage = "Hiciste demasiados pedidos seguidos. Esperá unos minutos antes de volver a probar.";

    private readonly byte[] _key = RandomNumberGenerator.GetBytes(32);
    private readonly PartitionedRateLimiter<string> _send;
    private readonly PartitionedRateLimiter<string> _verify;
    private readonly PartitionedRateLimiter<string> _login;
    private readonly PartitionedRateLimiter<string> _register;
    private readonly TimeSpan _loginWindow;
    private readonly TimeSpan _registerWindow;

    public AuthRecoveryLimiter(IOptions<AuthOptions> options)
    {
        var limits = options.Value.RateLimit;
        _send = Create(limits.AddressSendPermitLimit, limits.AddressWindow);
        _verify = Create(limits.AddressVerifyPermitLimit, limits.AddressWindow);
        _login = Create(limits.LoginAddressPermitLimit, limits.LoginAddressWindow);
        _register = Create(limits.RegisterAddressPermitLimit, limits.RegisterAddressWindow);
        _loginWindow = limits.LoginAddressWindow;
        _registerWindow = limits.RegisterAddressWindow;
    }

    /// <summary>
    /// true si esta dirección aún puede intentar un login (M3.1-S09). Cuenta TODO intento, exista o no la cuenta. Si no, <paramref name="retryAfter"/> es la espera sugerida.
    /// </summary>
    public bool TryAcquireLogin(string address, out TimeSpan retryAfter) => Acquire(_login, address, _loginWindow, out retryAfter);

    /// <summary>true si esta dirección aún puede registrarse (M3.1-S09); mismas reglas que <see cref="TryAcquireLogin"/>.</summary>
    public bool TryAcquireRegister(string address, out TimeSpan retryAfter) => Acquire(_register, address, _registerWindow, out retryAfter);

    /// <summary>true si esta dirección aún puede pedir un correo (forgot/resend comparten el mismo contador).</summary>
    public bool TryAcquireSend(string address) => Acquire(_send, address);

    /// <summary>true si esta dirección (o id de cuenta) aún puede intentar un reset/confirm (comparten el mismo contador).</summary>
    public bool TryAcquireVerify(string address) => Acquire(_verify, address);

    public void Dispose()
    {
        _send.Dispose();
        _verify.Dispose();
        _login.Dispose();
        _register.Dispose();
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

    private bool Acquire(PartitionedRateLimiter<string> limiter, string address) => Acquire(limiter, address, TimeSpan.Zero, out _);

    private bool Acquire(PartitionedRateLimiter<string> limiter, string address, TimeSpan fallbackWindow, out TimeSpan retryAfter)
    {
        var hash = Convert.ToHexString(HMACSHA256.HashData(_key, Encoding.UTF8.GetBytes(address.Trim().ToLowerInvariant())));
        using var lease = limiter.AttemptAcquire(hash);
        retryAfter = lease.IsAcquired
            ? TimeSpan.Zero
            : lease.TryGetMetadata(MetadataName.RetryAfter, out var suggested) ? suggested : fallbackWindow;
        return lease.IsAcquired;
    }

    /// <summary>Escribe el 429 de un límite por dirección (login/register): mismo cuerpo, <c>Retry-After</c> y <c>no-store</c> que el de la IP, exista o no la cuenta.</summary>
    public static IResult TooManyRequests(HttpContext http, TimeSpan retryAfter)
    {
        var seconds = Math.Max(1, (int)Math.Ceiling(retryAfter.TotalSeconds));
        http.Response.Headers.RetryAfter = seconds.ToString(CultureInfo.InvariantCulture);
        http.Response.Headers.CacheControl = "no-store";
        return Results.Json(
            new ApiErrorResponse(RateLimitedCode, RateLimitedMessage),
            statusCode: StatusCodes.Status429TooManyRequests);
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

            // Login y registro (S09): cupos propios (y distintos entre sí), por IP.
            limiter.AddPolicy(LoginIpPolicyName, http =>
            {
                var limits = auth.Value.RateLimit;
                var ip = http.Connection.RemoteIpAddress?.ToString() ?? "unknown";
                return RateLimitPartition.GetFixedWindowLimiter($"{ip}|login", _ => new FixedWindowRateLimiterOptions
                {
                    PermitLimit = limits.LoginIpPermitLimit,
                    Window = limits.LoginIpWindow,
                    QueueLimit = 0,
                    AutoReplenishment = true,
                });
            });
            limiter.AddPolicy(RegisterIpPolicyName, http =>
            {
                var limits = auth.Value.RateLimit;
                var ip = http.Connection.RemoteIpAddress?.ToString() ?? "unknown";
                return RateLimitPartition.GetFixedWindowLimiter($"{ip}|register", _ => new FixedWindowRateLimiterOptions
                {
                    PermitLimit = limits.RegisterIpPermitLimit,
                    Window = limits.RegisterIpWindow,
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
                await response.WriteAsJsonAsync(new ApiErrorResponse(RateLimitedCode, RateLimitedMessage), cancellationToken);
            };
        });
        return services;
    }
}
