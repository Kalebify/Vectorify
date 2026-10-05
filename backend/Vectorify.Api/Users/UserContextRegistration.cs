using Vectorify.Api.Options;

namespace Vectorify.Api.Users;

/// <summary>
/// ÚNICO punto de registro de <see cref="IUserContext"/> (M2.2-S09) y guardrail anti-Production:
/// <see cref="DevelopmentUserContext"/> (identidad fija, sin login) solo puede activarse en
/// Development/Testing/Test -- en cualquier otro entorno (Production, Staging, ...) el arranque
/// falla con <see cref="InvalidOperationException"/>, porque todavía no existe un
/// <see cref="IUserContext"/> autenticado (lo provee MVP 3.1). Deliberadamente SIN flag ni
/// variable de entorno para saltearlo: si hace falta otro entorno, se agrega acá a propósito.
/// Extraído de Program.cs para poder testearlo sin levantar el host.
/// </summary>
public static class UserContextRegistration
{
    private static readonly string[] DevelopmentUserEnvironments = ["Development", "Testing", "Test"];

    /// <summary>true si <paramref name="environment"/> permite registrar <see cref="DevelopmentUserContext"/>.</summary>
    public static bool IsDevelopmentUserAllowed(IHostEnvironment environment) =>
        DevelopmentUserEnvironments.Any(name => environment.IsEnvironment(name));

    public static IServiceCollection Register(
        IServiceCollection services, IHostEnvironment environment, IConfiguration configuration)
    {
        if (!IsDevelopmentUserAllowed(environment))
        {
            throw new InvalidOperationException(
                $"No existe un IUserContext autenticado para el entorno '{environment.EnvironmentName}': " +
                "DevelopmentUserContext (identidad fija, sin login) solo puede activarse en los entornos " +
                $"{string.Join(", ", DevelopmentUserEnvironments)}. La autenticación real llega con MVP 3.1.");
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
}
