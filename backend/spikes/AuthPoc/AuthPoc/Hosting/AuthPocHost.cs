using AuthPoc.Persistence;
using AuthPoc.Users;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;
using Vectorify.Api.Data;
using Vectorify.Api.Endpoints;
using Vectorify.Api.ProjectManagement;
using Vectorify.Api.Projects.Persistence;
using Vectorify.Api.Users;

namespace AuthPoc.Hosting;

/// <summary>
/// Host minimo del PoC: reutiliza SIN modificar los tipos reales del producto (<see cref="IProjectService"/>/<c>ProjectService</c>,
/// <see cref="IProjectRepository"/>/<c>ProjectRepository</c>, <c>VectorizationDbContext</c> y <c>MapProjectV2Endpoints</c>) y cambia
/// UNICAMENTE el registro de <see cref="IUserContext"/> (aqui <see cref="AuthenticatedUserContext"/>) y la tuberia de
/// autenticacion. Es exactamente lo que M3.1-S02..S06 haria sobre el <c>Program.cs</c> del producto.
/// </summary>
public static class AuthPocHost
{
    /// <summary>
    /// Construye (sin arrancar) un host para <paramref name="options"/>. <paramref name="configureBuilder"/> permite a los tests
    /// elegir el servidor (TestServer) sin que la libreria dependa de el.
    /// </summary>
    public static WebApplication Build(AuthPocHostOptions options, Action<WebApplicationBuilder>? configureBuilder = null)
    {
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Testing" });
        builder.Logging.ClearProviders();
        configureBuilder?.Invoke(builder);

        ConfigureServices(builder.Services, options);

        var app = builder.Build();
        Configure(app, options);
        return app;
    }

    private static void ConfigureServices(IServiceCollection services, AuthPocHostOptions options)
    {
        // --- Dominio del producto, tal cual: nada de esto se toca ---
        services.AddDbContext<VectorizationDbContext>(o => o.UseNpgsql(options.ConnectionString));
        services.AddScoped<IProjectRepository, ProjectRepository>();
        services.AddScoped<IProjectService, ProjectService>();

        // --- La unica sustitucion: quien responde "quien es el usuario de esta request" ---
        services.AddHttpContextAccessor();
        services.AddScoped<IUserContext, AuthenticatedUserContext>();
        services.AddSingleton(TimeProvider.System);
        services.AddDbContext<AuthPocDbContext>(o => o.UseNpgsql(options.ConnectionString));
        services.AddScoped<IUserProvisioner, UserProvisioner>();

        services.AddAuthorization();

        switch (options.Source)
        {
            case IdentitySource.OidcJwt:
                ConfigureOidc(services, options);
                break;
            case IdentitySource.AspNetIdentityCookie:
                ConfigureIdentityCookie(services, options);
                break;
            default:
                throw new ArgumentOutOfRangeException(nameof(options));
        }

        services.AddCors(cors => cors.AddPolicy("frontend", policy => policy
            .WithOrigins(options.AllowedOrigins)
            .WithHeaders("Content-Type", "Authorization", AuthPocHostOptions.CsrfHeaderName)
            .WithMethods("GET", "POST", "PATCH", "DELETE")
            .AllowCredentials()));
    }

    private static void ConfigureOidc(IServiceCollection services, AuthPocHostOptions options)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(options.OidcAuthority);
        ArgumentException.ThrowIfNullOrWhiteSpace(options.OidcAudience);

        services
            .AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
            .AddJwtBearer(jwt =>
            {
                jwt.Authority = options.OidcAuthority;        // discovery: {authority}/.well-known/openid-configuration
                jwt.Audience = options.OidcAudience;
                jwt.RequireHttpsMetadata = true;
                jwt.MapInboundClaims = false;                  // "sub" sigue siendo "sub": el dominio no depende del mapeo de Microsoft
                jwt.BackchannelHttpHandler = options.OidcBackchannelHandler;
                jwt.TokenValidationParameters = new TokenValidationParameters
                {
                    ValidateIssuer = true,
                    ValidateAudience = true,
                    ValidateLifetime = true,
                    ValidateIssuerSigningKey = true,
                    RequireSignedTokens = true,
                    RequireExpirationTime = true,
                    ValidAlgorithms = [SecurityAlgorithms.RsaSha256],
                    ClockSkew = options.ClockSkew,
                };
            });
    }

    private static void ConfigureIdentityCookie(IServiceCollection services, AuthPocHostOptions options)
    {
        services.AddAuthentication(IdentityConstants.ApplicationScheme).AddIdentityCookies();

        services
            .AddIdentityCore<IdentityUser<Guid>>(identity =>
            {
                identity.User.RequireUniqueEmail = true;
                identity.Password.RequiredLength = 12;
                identity.Lockout.MaxFailedAccessAttempts = 5;
                identity.Lockout.DefaultLockoutTimeSpan = TimeSpan.FromMinutes(15);
                identity.Lockout.AllowedForNewUsers = true;
            })
            .AddEntityFrameworkStores<AuthPocDbContext>()
            .AddSignInManager();

        services.Configure<SecurityStampValidatorOptions>(stamp => stamp.ValidationInterval = options.SessionRevalidationInterval);

        services.ConfigureApplicationCookie(cookie =>
        {
            cookie.Cookie.Name = options.CookieName;
            cookie.Cookie.HttpOnly = true;                              // JavaScript (XSS) no puede leer la sesion
            cookie.Cookie.SecurePolicy = CookieSecurePolicy.Always;     // jamas por HTTP plano
            cookie.Cookie.SameSite = SameSiteMode.Lax;                  // no viaja en POST cross-site
            cookie.Cookie.Path = "/";
            cookie.ExpireTimeSpan = options.CookieLifetime;
            cookie.SlidingExpiration = true;

            // Una API no redirige a una pagina de login: responde 401/403 y que la SPA decida.
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
    }

    private static void Configure(WebApplication app, AuthPocHostOptions options)
    {
        var cookieMode = options.Source == IdentitySource.AspNetIdentityCookie;

        app.UseCors("frontend");
        if (cookieMode)
        {
            app.UseMiddleware<CsrfGuardMiddleware>((object)options.AllowedOrigins);
        }

        app.UseAuthentication();
        app.UseAuthorization();

        if (cookieMode)
        {
            MapIdentityEndpoints(app);
        }

        // Todo lo que cuelga de este grupo exige usuario autenticado (401 si no) y, ya autorizado, resuelve el User local.
        // Es el patron de S06: un solo punto, sin tocar los endpoints del producto.
        var api = app.MapGroup(string.Empty).RequireAuthorization();
        var fallbackProvider = cookieMode ? options.CookieProviderKey : "unknown";
        app.UseMiddleware<UserProvisioningMiddleware>(fallbackProvider);

        api.MapProjectV2Endpoints();   // los endpoints REALES del producto, sin modificar

        api.MapGet("/poc/me", (IUserContext user, HttpContext http) => Results.Ok(new
        {
            userId = user.GetEffectiveUserId(),
            email = user.Email,
            isAuthenticated = user.IsAuthenticated,
            principalIdentities = http.User.Identities.Select(i => i.AuthenticationType).ToArray(),
        }));
    }

    private static void MapIdentityEndpoints(WebApplication app)
    {
        // Registro. Respuesta UNIFORME exista o no el correo (no se enumeran cuentas); solo se informan errores de politica de contrasena.
        app.MapPost("/poc/identity/register", async (CredentialsRequest request, UserManager<IdentityUser<Guid>> users) =>
        {
            if (string.IsNullOrWhiteSpace(request.Email) || string.IsNullOrEmpty(request.Password))
            {
                return Results.BadRequest(new { error = "invalid_request" });
            }

            var user = new IdentityUser<Guid> { Id = Guid.NewGuid(), UserName = request.Email, Email = request.Email };
            var result = await users.CreateAsync(user, request.Password);

            var policyErrors = result.Errors
                .Where(e => e.Code is not ("DuplicateUserName" or "DuplicateEmail"))
                .Select(e => e.Code)
                .ToArray();

            return policyErrors.Length > 0
                ? Results.BadRequest(new { error = "weak_password", codes = policyErrors })
                : Results.Ok(new { status = "check_your_email" });
        }).AllowAnonymous();

        // Login. Mismo 401 y mismo cuerpo para correo inexistente, contrasena incorrecta y cuenta bloqueada.
        app.MapPost("/poc/identity/login", async (CredentialsRequest request, SignInManager<IdentityUser<Guid>> signIn) =>
        {
            var result = await signIn.PasswordSignInAsync(
                request.Email ?? string.Empty, request.Password ?? string.Empty, isPersistent: false, lockoutOnFailure: true);

            return result.Succeeded
                ? Results.Ok(new { status = "signed_in" })
                : Results.Json(new { error = "invalid_credentials" }, statusCode: StatusCodes.Status401Unauthorized);
        }).AllowAnonymous();

        app.MapPost("/poc/identity/logout", async (SignInManager<IdentityUser<Guid>> signIn) =>
        {
            await signIn.SignOutAsync();
            return Results.NoContent();
        }).RequireAuthorization();
    }

    private sealed record CredentialsRequest(string? Email, string? Password);
}
