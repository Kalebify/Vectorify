using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Options;
using Vectorify.Api.Data.Auth;
using Vectorify.Api.Options;

namespace Vectorify.Api.Users;

/// <summary>
/// Cableado de ASP.NET Core Identity con cookie (M3.1-S02, ADR D1/D2; NO se usa <c>MapIdentityApi</c>): autenticación por
/// cookie, <c>UserManager</c>/<c>SignInManager</c> sobre <see cref="AuthDbContext"/> (esquema <c>auth</c>) y la frontera
/// de identidad (<see cref="IUserProvisioner"/>). Se registra SIEMPRE, también con <c>Auth:Mode=Development</c>: el registro
/// de cuentas funciona en cualquier modo; lo que cambia con el modo es quién responde <see cref="IUserContext"/>
/// (ver <see cref="UserContextRegistration"/>). Todas las opciones se enlazan de forma diferida desde
/// <see cref="AuthOptions"/> (respeta overrides de entorno y de WebApplicationFactory).
/// </summary>
public static class AuthRegistration
{
    public static IServiceCollection AddVectorifyAuth(this IServiceCollection services, IConfiguration configuration)
    {
        services
            .AddOptions<AuthOptions>()
            .Bind(configuration.GetSection(AuthOptions.SectionName))
            .ValidateOnStart();
        services.AddSingleton<IValidateOptions<AuthOptions>, AuthOptionsValidator>();

        services.TryAddSingleton(TimeProvider.System);
        services.AddHttpContextAccessor();
        services.AddScoped<IUserProvisioner, UserProvisioner>();

        // Misma base que VectorizationDbContext; esquema "auth" e historial de migraciones propios.
        services.AddDbContext<AuthDbContext>((sp, options) =>
        {
            var postgres = sp.GetRequiredService<IOptions<PostgresOptions>>().Value;
            options.UseNpgsql(postgres.ConnectionString, AuthDbContext.ConfigureNpgsql);
        });

        services.AddAuthentication(IdentityConstants.ApplicationScheme).AddIdentityCookies();
        services.AddAuthorization();

        services
            .AddIdentityCore<ApplicationUser>()
            .AddEntityFrameworkStores<AuthDbContext>()
            .AddSignInManager();

        services.AddOptions<IdentityOptions>().Configure<IOptions<AuthOptions>>((identity, auth) =>
        {
            var options = auth.Value;
            identity.User.RequireUniqueEmail = true;

            // Política de contraseña: SOLO largo (≥ 12). Sin reglas de composición (NIST 800-63B).
            identity.Password.RequiredLength = options.Password.MinLength;
            identity.Password.RequireDigit = false;
            identity.Password.RequireLowercase = false;
            identity.Password.RequireUppercase = false;
            identity.Password.RequireNonAlphanumeric = false;
            identity.Password.RequiredUniqueChars = 1;

            identity.Lockout.AllowedForNewUsers = true;
            identity.Lockout.MaxFailedAccessAttempts = options.Lockout.MaxAttempts;
            identity.Lockout.DefaultLockoutTimeSpan = options.Lockout.Duration;
        });

        services.AddOptions<SecurityStampValidatorOptions>().Configure<IOptions<AuthOptions>>(
            (stamp, auth) => stamp.ValidationInterval = auth.Value.Session.RevalidationInterval);

        services.AddOptions<CookieAuthenticationOptions>(IdentityConstants.ApplicationScheme).Configure<IOptions<AuthOptions>>(
            (cookie, auth) =>
            {
                var options = auth.Value.Cookie;
                cookie.Cookie.Name = options.Name;
                cookie.Cookie.HttpOnly = true;               // JavaScript (XSS) no puede leer la sesión
                cookie.Cookie.SecurePolicy = options.SecurePolicy;
                cookie.Cookie.SameSite = SameSiteMode.Lax;   // no viaja en POST cross-site
                cookie.Cookie.Path = "/";
                cookie.ExpireTimeSpan = options.Lifetime;
                cookie.SlidingExpiration = true;

                // Una API no redirige a una página de login: responde 401/403 y que la SPA decida.
                cookie.Events.OnRedirectToLogin = context =>
                {
                    context.Response.StatusCode = StatusCodes.Status401Unauthorized;
                    return Task.CompletedTask;
                };
                cookie.Events.OnRedirectToAccessDenied = context =>
                {
                    context.Response.StatusCode = StatusCodes.Status403Forbidden;
                    return Task.CompletedTask;
                };
            });

        return services;
    }
}
