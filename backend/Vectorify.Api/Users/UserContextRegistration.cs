using Vectorify.Api.Options;

namespace Vectorify.Api.Users;

/// <summary>
/// ÚNICO punto de registro de <see cref="IUserContext"/> (M2.2-S09, ampliado en M3.1-S02) y guardrail anti-Production.
/// Según <c>Auth:Mode</c> (ver <see cref="AuthMode"/>):
/// <list type="bullet">
/// <item><see cref="AuthMode.Authenticated"/> (DEFAULT, y el único modo válido fuera de desarrollo): registra
/// <see cref="AuthenticatedUserContext"/>, que lee el principal de la cookie de ASP.NET Core Identity ya mapeado a
/// <c>User.Id</c> por <see cref="UserProvisioningMiddleware"/>.</item>
/// <item><see cref="AuthMode.Development"/>: registra <see cref="DevelopmentUserContext"/> (identidad fija, sin login) SOLO
/// si <see cref="IsDevelopmentUserAllowed"/> (Development/Testing/Test); en cualquier otro entorno (Production, Staging, ...)
/// el arranque falla con <see cref="InvalidOperationException"/>. Deliberadamente SIN otro flag ni variable de entorno para
/// saltearlo: si hace falta otro entorno, se agrega acá a propósito.</item>
/// </list>
/// El entorno de desarrollo (appsettings.Development.json y docker-compose) fija <c>Auth:Mode=Development</c> de forma
/// EXPLÍCITA hasta que existan login y UI (S03/S05): sin esa línea, el default seguro sería Authenticated. Las opciones
/// <see cref="AuthOptions"/> se vuelven a validar al arrancar con la configuración final (<see cref="AuthOptionsValidator"/>).
/// Extraído de Program.cs para poder testearlo sin levantar el host.
/// </summary>
public static class UserContextRegistration
{
    /// <summary>Entornos en los que <see cref="AuthMode.Development"/> está permitido.</summary>
    public static readonly string[] DevelopmentUserEnvironments = ["Development", "Testing", "Test"];

    /// <summary>true si <paramref name="environment"/> permite registrar <see cref="DevelopmentUserContext"/>.</summary>
    public static bool IsDevelopmentUserAllowed(IHostEnvironment environment) =>
        DevelopmentUserEnvironments.Any(name => environment.IsEnvironment(name));

    /// <summary>Lee <c>Auth:Mode</c> (default <see cref="AuthMode.Authenticated"/>); un valor inválido tumba el arranque.</summary>
    public static AuthMode ReadMode(IConfiguration configuration)
    {
        var raw = configuration[$"{AuthOptions.SectionName}:{nameof(AuthOptions.Mode)}"];
        if (string.IsNullOrWhiteSpace(raw))
        {
            return AuthMode.Authenticated;
        }

        // Solo por nombre: Enum.TryParse aceptaría también un número ("1") y eso no es una configuración deliberada.
        var name = Enum.GetNames<AuthMode>().FirstOrDefault(n => string.Equals(n, raw.Trim(), StringComparison.OrdinalIgnoreCase));
        if (name is not null)
        {
            return Enum.Parse<AuthMode>(name);
        }

        throw new InvalidOperationException(
            $"Auth:Mode '{raw}' no es válido: use {nameof(AuthMode.Authenticated)} o {nameof(AuthMode.Development)}.");
    }

    public static IServiceCollection Register(
        IServiceCollection services, IHostEnvironment environment, IConfiguration configuration)
    {
        var mode = ReadMode(configuration);

        if (mode == AuthMode.Development)
        {
            if (!IsDevelopmentUserAllowed(environment))
            {
                throw new InvalidOperationException(
                    $"Auth:Mode=Development no está permitido en el entorno '{environment.EnvironmentName}': " +
                    "DevelopmentUserContext (identidad fija, sin login) solo puede activarse en los entornos " +
                    $"{string.Join(", ", DevelopmentUserEnvironments)}. Fuera de ellos use Auth:Mode=Authenticated (default).");
            }

            // Enlace diferido (misma razón que el resto de las opciones de Program.cs): respeta los
            // overrides de entorno y de WebApplicationFactory. ValidateOnStart => UserId vacío
            // tumba el arranque en vez de fallar recién en el primer request.
            services
                .AddOptions<DevelopmentUserOptions>()
                .Bind(configuration.GetSection(DevelopmentUserOptions.SectionName))
                .Validate(o => o.UserId != Guid.Empty, "DevelopmentUser:UserId no puede ser Guid.Empty.")
                .ValidateOnStart();

            services.AddScoped<IUserContext, DevelopmentUserContext>();
            return services;
        }

        services.AddHttpContextAccessor();
        services.AddScoped<IUserContext, AuthenticatedUserContext>();
        return services;
    }
}
