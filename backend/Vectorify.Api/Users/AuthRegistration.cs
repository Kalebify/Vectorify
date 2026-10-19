using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.DataProtection.KeyManagement;
using Microsoft.AspNetCore.DataProtection.Repositories;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Options;
using Vectorify.Api.Authorization;
using Vectorify.Api.Data.Auth;
using Vectorify.Api.Email;
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
    /// <summary>
    /// Nombre de aplicación de Data Protection (aislamiento de propósito): FIJO, no el path del contenido (default), para que todas las
    /// instancias y reinicios que comparten el key ring descifren la misma cookie. Cambiarlo invalida todas las sesiones.
    /// </summary>
    public const string DataProtectionApplicationName = "Vectorify";

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
        services.AddVectorifyAuthorization();

        services
            .AddIdentityCore<ApplicationUser>()
            .AddEntityFrameworkStores<AuthDbContext>()
            .AddSignInManager()
            // Tokens NATIVOS de Identity para recuperar/confirmar (M3.1-S08), con vida propia cada uno (Auth:Tokens:*). Sin AddDefaultTokenProviders a propósito:
            // solo existen estos dos proveedores (nada de teléfono/2FA).
            .AddTokenProvider<PasswordResetTokenProvider>(PasswordResetTokenProvider.ProviderName)
            .AddTokenProvider<EmailConfirmationTokenProvider>(EmailConfirmationTokenProvider.ProviderName);

        services.AddOptions<PasswordResetTokenProviderOptions>().Configure<IOptions<AuthOptions>>((token, auth) =>
        {
            token.Name = PasswordResetTokenProvider.ProviderName; // propósito del protector: separa los tokens de cada uso
            token.TokenLifespan = auth.Value.Tokens.PasswordResetLifetime;
        });
        services.AddOptions<EmailConfirmationTokenProviderOptions>().Configure<IOptions<AuthOptions>>((token, auth) =>
        {
            token.Name = EmailConfirmationTokenProvider.ProviderName;
            token.TokenLifespan = auth.Value.Tokens.EmailConfirmationLifetime;
        });

        // Correo transaccional en segundo plano (M3.1-S08): cola + trabajador + IEmailSender elegido por Auth:Email:Mode (diferido, respeta overrides de tests).
        services.AddSingleton<AuthEmailQueue>();
        services.AddSingleton<IAuthEmailQueue>(sp => sp.GetRequiredService<AuthEmailQueue>());
        services.AddHostedService<AuthEmailWorker>();
        services.AddSingleton<IEmailSender>(sp => sp.GetRequiredService<IOptions<AuthOptions>>().Value.Email.Mode switch
        {
            AuthEmailMode.Smtp => ActivatorUtilities.CreateInstance<SmtpEmailSender>(sp),
            AuthEmailMode.Log => ActivatorUtilities.CreateInstance<LogEmailSender>(sp),
            _ => new DisabledEmailSender(),
        });
        AuthRecoveryLimiter.AddAuthRecoveryRateLimiting(services);

        services.AddOptions<IdentityOptions>().Configure<IOptions<AuthOptions>>((identity, auth) =>
        {
            var options = auth.Value;
            identity.User.RequireUniqueEmail = true;
            identity.Tokens.PasswordResetTokenProvider = PasswordResetTokenProvider.ProviderName;
            identity.Tokens.EmailConfirmationTokenProvider = EmailConfirmationTokenProvider.ProviderName;

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

        // Key ring PERSISTENTE (S04): sin él, cada reinicio de la API genera claves nuevas y TODAS las cookies de sesión dejan de
        // descifrarse. La ruta se lee de forma diferida (respeta overrides de entorno y de WebApplicationFactory); vacía = default de
        // ASP.NET (solo Development/Testing/Test, ver AuthOptionsValidator).
        services.AddDataProtection().SetApplicationName(DataProtectionApplicationName);
        services.AddOptions<KeyManagementOptions>().Configure<IOptions<AuthOptions>, ILoggerFactory>(
            (keys, auth, loggerFactory) =>
            {
                var path = auth.Value.DataProtection.KeysPath;
                if (!string.IsNullOrWhiteSpace(path))
                {
                    keys.XmlRepository = new FileSystemXmlRepository(new DirectoryInfo(path), loggerFactory);
                }
            });

        // El MISMO TimeProvider del host para el ticket de la cookie y para el validador del SecurityStamp: en producción es el reloj
        // del sistema; los tests inyectan uno controlable para probar expiración y renovación sin dormir.
        services.AddOptions<SecurityStampValidatorOptions>().Configure<IOptions<AuthOptions>, TimeProvider>(
            (stamp, auth, time) =>
            {
                stamp.ValidationInterval = auth.Value.Session.RevalidationInterval;
                stamp.TimeProvider = time;
            });

        services.AddOptions<CookieAuthenticationOptions>(IdentityConstants.ApplicationScheme).Configure<IOptions<AuthOptions>, TimeProvider>(
            (cookie, auth, time) =>
            {
                cookie.TimeProvider = time;
                var options = auth.Value.Cookie;
                cookie.Cookie.Name = options.Name;
                cookie.Cookie.HttpOnly = true;               // JavaScript (XSS) no puede leer la sesión
                cookie.Cookie.SecurePolicy = options.SecurePolicy;
                cookie.Cookie.SameSite = SameSiteMode.Lax;   // no viaja en POST cross-site
                cookie.Cookie.Path = "/";
                cookie.ExpireTimeSpan = options.Lifetime;
                cookie.SlidingExpiration = true;

                // Ciclo de vida de la sesión (S04): tope absoluto de «recordarme», revalidación acotada por el desfase de reloj y
                // Max-Age en la cookie persistente. AddIdentityCookies ya fijó OnValidatePrincipal = validador de SecurityStamp.
                var securityStampValidator = cookie.Events.OnValidatePrincipal;
                var sessionOptions = auth.Value.Session;
                cookie.Events.OnValidatePrincipal = context =>
                    SessionCookie.ValidatePrincipalAsync(context, securityStampValidator, sessionOptions, time);
                cookie.Events.OnSigningIn = context => SessionCookie.OnSigningIn(context, time);

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
