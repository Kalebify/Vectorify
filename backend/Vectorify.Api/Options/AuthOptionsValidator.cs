using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Options;
using Vectorify.Api.Users;

namespace Vectorify.Api.Options;

/// <summary>
/// Valida <see cref="AuthOptions"/> AL ARRANCAR (<c>ValidateOnStart</c>), con la configuración FINAL del host (no la que
/// había al registrar servicios): Production no puede arrancar en <see cref="AuthMode.Development"/> aunque el valor llegue
/// por una fuente tardía, ni con una cookie no <c>Secure</c>, ni con una política de contraseña más débil que 12 caracteres.
/// </summary>
public sealed class AuthOptionsValidator : IValidateOptions<AuthOptions>
{
    private readonly IHostEnvironment _environment;
    private readonly IOptions<FrontendCorsOptions>? _cors;

    /// <param name="environment">Entorno del host.</param>
    /// <param name="cors">Orígenes CORS finales (para comprobar que <c>Auth:Email:PublicBaseUrl</c> figura entre ellos); <c>null</c> = no se comprueba (tests unitarios).</param>
    public AuthOptionsValidator(IHostEnvironment environment, IOptions<FrontendCorsOptions>? cors = null)
    {
        _environment = environment;
        _cors = cors;
    }

    public ValidateOptionsResult Validate(string? name, AuthOptions options)
    {
        var failures = new List<string>();
        var developmentAllowed = UserContextRegistration.IsDevelopmentUserAllowed(_environment);

        if (!Enum.IsDefined(options.Mode))
        {
            failures.Add($"Auth:Mode '{options.Mode}' no es válido (Authenticated | Development).");
        }

        if (options.Mode == AuthMode.Development && !developmentAllowed)
        {
            failures.Add(
                $"Auth:Mode=Development no está permitido en el entorno '{_environment.EnvironmentName}': solo en " +
                $"{string.Join(", ", UserContextRegistration.DevelopmentUserEnvironments)}.");
        }

        if (string.IsNullOrWhiteSpace(options.Cookie.Name))
        {
            failures.Add("Auth:Cookie:Name es requerido.");
        }
        else if (options.Cookie.Name.StartsWith("__Host-", StringComparison.Ordinal)
                 && options.Cookie.SecurePolicy != CookieSecurePolicy.Always)
        {
            failures.Add("Auth:Cookie:Name con prefijo '__Host-' exige Auth:Cookie:SecurePolicy=Always.");
        }

        if (!developmentAllowed && options.Cookie.SecurePolicy != CookieSecurePolicy.Always)
        {
            failures.Add($"Auth:Cookie:SecurePolicy debe ser Always fuera de los entornos de desarrollo ('{_environment.EnvironmentName}').");
        }

        if (options.Cookie.Lifetime <= TimeSpan.Zero)
        {
            failures.Add("Auth:Cookie:Lifetime debe ser mayor a 0.");
        }

        if (options.Cookie.RememberMeLifetime <= TimeSpan.Zero)
        {
            failures.Add("Auth:Cookie:RememberMeLifetime debe ser mayor a 0.");
        }
        else if (options.Cookie.RememberMeLifetime > AuthCookieOptions.MaxPersistentLifetime)
        {
            failures.Add(
                $"Auth:Cookie:RememberMeLifetime no puede superar {AuthCookieOptions.MaxPersistentLifetime.TotalDays:0} días " +
                "(el navegador no respeta una cookie persistente más larga).");
        }
        else if (options.Cookie.Lifetime > TimeSpan.Zero && options.Cookie.RememberMeLifetime < options.Cookie.Lifetime)
        {
            failures.Add("Auth:Cookie:RememberMeLifetime no puede ser menor que Auth:Cookie:Lifetime («recordarme» no puede durar menos que una sesión normal).");
        }

        if (options.Session.RevalidationInterval < TimeSpan.Zero)
        {
            failures.Add("Auth:Session:RevalidationInterval no puede ser negativo.");
        }
        else if (options.Cookie.Lifetime > TimeSpan.Zero && options.Session.RevalidationInterval > options.Cookie.Lifetime)
        {
            failures.Add("Auth:Session:RevalidationInterval no puede superar Auth:Cookie:Lifetime (la sesión caducaría sin haberse revalidado nunca).");
        }

        if (options.Session.ClockSkew < TimeSpan.Zero || options.Session.ClockSkew > AuthSessionOptions.MaxClockSkew)
        {
            failures.Add($"Auth:Session:ClockSkew debe estar entre 0 y {AuthSessionOptions.MaxClockSkew}.");
        }

        ValidateKeysPath(options.DataProtection.KeysPath, developmentAllowed, failures);

        if (options.Password.MinLength < AuthPasswordOptions.MinimumAllowedLength
            || options.Password.MinLength > AuthPasswordOptions.MaxLength)
        {
            failures.Add(
                $"Auth:Password:MinLength debe estar entre {AuthPasswordOptions.MinimumAllowedLength} y {AuthPasswordOptions.MaxLength}.");
        }

        if (options.Lockout.MaxAttempts < 1)
        {
            failures.Add("Auth:Lockout:MaxAttempts debe ser al menos 1.");
        }

        if (options.Lockout.Duration <= TimeSpan.Zero)
        {
            failures.Add("Auth:Lockout:Duration debe ser mayor a 0.");
        }

        ValidateRecovery(options, developmentAllowed, failures);

        return failures.Count == 0 ? ValidateOptionsResult.Success : ValidateOptionsResult.Fail(failures);
    }

    /// <summary>Correo, vida de los tokens y límites de frecuencia (M3.1-S08).</summary>
    private void ValidateRecovery(AuthOptions options, bool developmentAllowed, List<string> failures)
    {
        var email = options.Email;

        if (!Enum.IsDefined(email.Mode))
        {
            failures.Add($"Auth:Email:Mode {email.Mode} no es válido (Disabled | Log | Smtp).");
        }

        if (email.Mode == AuthEmailMode.Log && !developmentAllowed)
        {
            // El modo Log escribe el correo y el ENLACE (con el token) en el log: fuera de desarrollo eso sería una filtración de credenciales.
            failures.Add(
                $"Auth:Email:Mode=Log no está permitido en el entorno {_environment.EnvironmentName}: escribe enlaces de recuperación en el log; " +
                $"solo en {string.Join(", ", UserContextRegistration.DevelopmentUserEnvironments)}. Use Smtp.");
        }

        if (email.Mode is AuthEmailMode.Log or AuthEmailMode.Smtp)
        {
            ValidatePublicBaseUrl(email.PublicBaseUrl, developmentAllowed, failures);
        }

        if (email.Mode == AuthEmailMode.Smtp)
        {
            ValidateSmtp(email, developmentAllowed, failures);
        }

        if (options.Tokens.PasswordResetLifetime <= TimeSpan.Zero || options.Tokens.PasswordResetLifetime > AuthTokensOptions.MaxLifetime)
        {
            failures.Add($"Auth:Tokens:PasswordResetLifetime debe estar entre 0 (exclusivo) y {AuthTokensOptions.MaxLifetime}.");
        }

        if (options.Tokens.EmailConfirmationLifetime <= TimeSpan.Zero || options.Tokens.EmailConfirmationLifetime > AuthTokensOptions.MaxLifetime)
        {
            failures.Add($"Auth:Tokens:EmailConfirmationLifetime debe estar entre 0 (exclusivo) y {AuthTokensOptions.MaxLifetime}.");
        }

        var limits = options.RateLimit;
        if (limits.IpPermitLimit < 1 || limits.AddressSendPermitLimit < 1 || limits.AddressVerifyPermitLimit < 1)
        {
            failures.Add("Auth:RateLimit:IpPermitLimit, AddressSendPermitLimit y AddressVerifyPermitLimit deben ser al menos 1.");
        }

        if (limits.IpWindow <= TimeSpan.Zero || limits.AddressWindow <= TimeSpan.Zero)
        {
            failures.Add("Auth:RateLimit:IpWindow y AddressWindow deben ser mayores a 0.");
        }
    }

    private void ValidatePublicBaseUrl(string? value, bool developmentAllowed, List<string> failures)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            failures.Add("Auth:Email:PublicBaseUrl es obligatorio con Auth:Email:Mode=Log|Smtp (URL pública de la SPA a la que apuntan los enlaces; nunca se deriva de la request).");
            return;
        }

        var origin = value.Trim().TrimEnd('/');
        if (!FrontendCorsOptions.IsExplicitOrigin(origin))
        {
            failures.Add("Auth:Email:PublicBaseUrl debe ser un origen explícito (http(s)://host[:puerto]), sin ruta, consulta ni fragmento.");
            return;
        }

        if (!developmentAllowed && !origin.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
        {
            failures.Add($"Auth:Email:PublicBaseUrl debe ser https fuera de los entornos de desarrollo ('{_environment.EnvironmentName}'): el enlace lleva el token de recuperación.");
        }

        if (_cors is not null && !_cors.Value.GetOrigins().Contains(origin, StringComparer.OrdinalIgnoreCase))
        {
            failures.Add("Auth:Email:PublicBaseUrl debe figurar en Cors:AllowedOrigins (es la misma SPA que llama a la API).");
        }
    }

    private static void ValidateSmtp(AuthEmailOptions email, bool developmentAllowed, List<string> failures)
    {
        var smtp = email.Smtp;

        if (string.IsNullOrWhiteSpace(smtp.Host))
        {
            failures.Add("Auth:Email:Smtp:Host es obligatorio con Auth:Email:Mode=Smtp.");
        }

        if (smtp.Port is < 1 or > 65535)
        {
            failures.Add("Auth:Email:Smtp:Port debe estar entre 1 y 65535.");
        }

        if (!Enum.IsDefined(smtp.Security))
        {
            failures.Add($"Auth:Email:Smtp:Security '{smtp.Security}' no es válido (StartTls | None).");
        }
        else if (smtp.Security == AuthSmtpSecurity.None && !developmentAllowed)
        {
            failures.Add("Auth:Email:Smtp:Security=None (sin cifrado) solo está permitido en los entornos de desarrollo: use StartTls.");
        }

        if (smtp.Timeout <= TimeSpan.Zero)
        {
            failures.Add("Auth:Email:Smtp:Timeout debe ser mayor a 0.");
        }

        if (string.IsNullOrWhiteSpace(email.FromAddress) || !EmailAddress.IsValid(email.FromAddress))
        {
            failures.Add("Auth:Email:FromAddress es obligatorio con Auth:Email:Mode=Smtp y debe ser un correo válido.");
        }

        if (!string.IsNullOrWhiteSpace(smtp.UserName) && string.IsNullOrEmpty(smtp.Password))
        {
            failures.Add("Auth:Email:Smtp:Password es obligatoria cuando hay Auth:Email:Smtp:UserName (solo por variable de entorno).");
        }
    }

    /// <summary>
    /// Key ring de Data Protection (M3.1-S04). Decisión: fuera de Development/Testing/Test, SIN ruta persistente el arranque FALLA
    /// (y no solo avisa): sin ella cada reinicio invalidaría todas las sesiones y, desde S08, los enlaces de recuperación; un aviso en
    /// el log se ignora hasta que ya hubo usuarios deslogueados. Con ruta, debe ser absoluta y escribible (se comprueba al arrancar).
    /// </summary>
    private static void ValidateKeysPath(string? path, bool developmentAllowed, List<string> failures)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            if (!developmentAllowed)
            {
                failures.Add(
                    "Auth:DataProtection:KeysPath es obligatorio fuera de los entornos de desarrollo: sin un key ring persistente " +
                    "(volumen) cada reinicio invalidaría todas las sesiones.");
            }

            return;
        }

        if (!Path.IsPathRooted(path))
        {
            failures.Add("Auth:DataProtection:KeysPath debe ser una ruta absoluta.");
            return;
        }

        try
        {
            Directory.CreateDirectory(path);
            var probe = Path.Combine(path, ".write-check-" + Guid.NewGuid().ToString("N"));
            File.WriteAllText(probe, string.Empty);
            File.Delete(probe);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or NotSupportedException or ArgumentException)
        {
            // Sin la ruta ni el detalle de la excepción: solo qué falló.
            failures.Add($"Auth:DataProtection:KeysPath no es un directorio escribible ({ex.GetType().Name}).");
        }
    }
}
