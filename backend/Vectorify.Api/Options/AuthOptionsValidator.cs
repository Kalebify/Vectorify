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

    public AuthOptionsValidator(IHostEnvironment environment)
    {
        _environment = environment;
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

        if (options.Session.RevalidationInterval < TimeSpan.Zero)
        {
            failures.Add("Auth:Session:RevalidationInterval no puede ser negativo.");
        }

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

        return failures.Count == 0 ? ValidateOptionsResult.Success : ValidateOptionsResult.Fail(failures);
    }
}
