using System.Net.Mail;
using System.Security.Claims;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using Vectorify.Api.Contracts;
using Vectorify.Api.Data;
using Vectorify.Api.Data.Auth;
using Vectorify.Api.Options;
using Vectorify.Api.Users;

namespace Vectorify.Api.Endpoints;

/// <summary>
/// Endpoints de autenticación propios bajo <c>/api/v1/auth</c>: registro (M3.1-S02), login, logout y usuario actual (M3.1-S03).
/// Usan <c>UserManager</c>/<c>SignInManager</c> de ASP.NET Core Identity (NO <c>MapIdentityApi</c>, ADR D1). Register y login son
/// ANÓNIMOS (nadie tiene sesión antes de entrar); logout es idempotente y tolera la sesión ya caducada; <c>me</c> exige la cookie.
/// Ningún log de este archivo incluye el correo ni la contraseña.
/// </summary>
public static class AuthEndpoints
{
    public const string RegisterPath = "/api/v1/auth/register";
    public const string LoginPath = "/api/v1/auth/login";
    public const string LogoutPath = "/api/v1/auth/logout";

    /// <summary>«Cerrar sesión en todos lados» (M3.1-S04): requiere sesión y rota el SecurityStamp de la cuenta autenticada.</summary>
    public const string LogoutAllPath = "/api/v1/auth/logout-all";
    public const string MePath = "/api/v1/auth/me";

    /// <summary>Código del 401 de login: IDÉNTICO para cuenta inexistente, contraseña errónea y cuenta bloqueada (T5/T6).</summary>
    public const string InvalidCredentialsCode = "invalid_credentials";

    /// <summary>Mensaje del 401 de login: el MISMO en los tres casos, para que el cuerpo no delate si la cuenta existe o está bloqueada.</summary>
    public const string InvalidCredentialsMessage = "Correo o contraseña incorrectos.";

    public const string LogoutIncompleteCode = "logout_incomplete";

    /// <summary>Valor de <see cref="RegisterResponse.Status"/>: el MISMO para cuenta nueva y para correo ya registrado.</summary>
    public const string RegisterAcceptedStatus = "accepted";

    private const int MaxEmailLength = 254;

    public static void MapAuthEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost(RegisterPath, RegisterAsync)
            .AllowAnonymous()
            .WithName("RegisterAccount")
            .WithTags("Auth")
            .Produces<RegisterResponse>(StatusCodes.Status202Accepted)
            .Produces<ApiErrorResponse>(StatusCodes.Status400BadRequest)
            .WithSummary("Registra una cuenta (email + contraseña) y vincula su User interno de forma idempotente.")
            .WithDescription(
                "Respuesta UNIFORME (202 {status:'accepted'}) exista o no el correo: no revela si una cuenta ya existe. " +
                "Solo los errores de validación (email inválido, contraseña < 12 caracteres) son visibles y no dependen de " +
                "si el correo existe. La verificación por email llega en M3.1-S08.");

        app.MapPost(LoginPath, LoginAsync)
            .AllowAnonymous()
            .WithName("Login")
            .WithTags("Auth")
            .Produces<CurrentUserResponse>(StatusCodes.Status200OK)
            .Produces<ApiErrorResponse>(StatusCodes.Status401Unauthorized)
            .WithSummary("Inicia sesión (email + contraseña) y emite la cookie de sesión de Identity.")
            .WithDescription(
                "Cuenta inexistente, contraseña errónea y cuenta bloqueada devuelven EXACTAMENTE el mismo 401 (código, mensaje y cabeceras). " +
                "Bloqueo tras Auth:Lockout:MaxAttempts fallos durante Auth:Lockout:Duration. Responde 200 con el usuario actual.");

        app.MapPost(LogoutPath, LogoutAsync)
            .AllowAnonymous()
            .WithName("Logout")
            .WithTags("Auth")
            .Produces(StatusCodes.Status204NoContent)
            .WithSummary("Cierra la sesión: borra la cookie y rota el SecurityStamp de la cuenta (invalida también las copias de la cookie).")
            .WithDescription(
                "Idempotente: sin sesión (o con la sesión ya caducada) responde 204 igual. La invalidación de copias de la cookie se " +
                "aplica cuando cada copia se revalida (Auth:Session:RevalidationInterval, 5 min por defecto).");

        app.MapPost(LogoutAllPath, LogoutAllAsync)
            .RequireAuthorization()
            .WithName("LogoutAll")
            .WithTags("Auth")
            .Produces(StatusCodes.Status204NoContent)
            .Produces(StatusCodes.Status401Unauthorized)
            .Produces<ApiErrorResponse>(StatusCodes.Status503ServiceUnavailable)
            .WithSummary("Cierra la sesión en TODOS los navegadores: rota el SecurityStamp de la cuenta autenticada y borra la cookie de este.")
            .WithDescription(
                "Exige sesión válida (401 si no) y el mismo CSRF que el resto de métodos no seguros. Las demás cookies de la cuenta dejan de valer al revalidarse " +
                "(Auth:Session:RevalidationInterval, 5 min por defecto; 0 = en cada request). Si la rotación falla: cookie de este navegador borrada y 503 logout_incomplete.");

        // AllowAnonymous a propósito (M3.1-S05): en Auth:Mode=Development no hay login y la SPA necesita un 200 sin cookie; en modo
        // Authenticated MeAsync responde 401 por sí mismo cuando no hay identidad verificada (mismo resultado que antes).
        app.MapGet(MePath, MeAsync)
            .AllowAnonymous()
            .WithName("GetCurrentUser")
            .WithTags("Auth")
            .Produces<CurrentUserResponse>(StatusCodes.Status200OK)
            .Produces(StatusCodes.Status401Unauthorized)
            .WithSummary("Usuario actual, resuelto SOLO desde la identidad verificada de la cookie.")
            .WithDescription(
                "Auth:Mode=Authenticated: 401 sin sesión, con la cookie manipulada o tras cerrar sesión; nada que envíe el cliente decide quién es. " +
                "Auth:Mode=Development (solo entornos de desarrollo): 200 con el usuario de desarrollo (IUserContext) y authMode=Development, sin cookie.");
    }

    private static async Task<IResult> LoginAsync(
        LoginRequest request,
        HttpContext http,
        UserManager<ApplicationUser> users,
        SignInManager<ApplicationUser> signIn,
        IUserProvisioner provisioner,
        VectorizationDbContext db,
        Microsoft.Extensions.Options.IOptions<AuthOptions> authOptions,
        TimeProvider time,
        ILoggerFactory loggerFactory,
        CancellationToken cancellationToken)
    {
        var logger = loggerFactory.CreateLogger("Vectorify.Api.Endpoints.AuthEndpoints");
        http.Response.Headers.CacheControl = "no-store";

        var email = request.Email?.Trim();
        var password = request.Password;
        if (string.IsNullOrEmpty(email) || email.Length > MaxEmailLength
            || string.IsNullOrEmpty(password) || password.Length > AuthPasswordOptions.MaxLength)
        {
            // Entrada que no puede ser válida (vacía o desmesurada): mismo 401, sin tocar la base ni hashear contraseñas gigantes.
            return InvalidCredentials();
        }

        var account = await users.FindByEmailAsync(email);
        if (account is null)
        {
            // Misma carga de CPU que una verificación real (el hash adaptativo es lo caro), para que el tiempo no delate
            // que la cuenta no existe (T5). El resultado se descarta. Riesgo residual [N]: tiempo no medido.
            _ = users.PasswordHasher.HashPassword(new ApplicationUser(), password);
            logger.LogInformation("Login: credenciales rechazadas.");
            return InvalidCredentials();
        }

        // lockoutOnFailure: cada fallo suma al contador; al llegar a Auth:Lockout:MaxAttempts la cuenta queda bloqueada
        // Auth:Lockout:Duration. Una cuenta bloqueada NO comprueba la contraseña (ni siquiera la correcta entra).
        var result = await signIn.CheckPasswordSignInAsync(account, password, lockoutOnFailure: true);
        if (!result.Succeeded)
        {
            if (result.IsLockedOut)
            {
                logger.LogWarning("Login: cuenta {AccountId} bloqueada por intentos fallidos.", account.Id);
            }
            else
            {
                logger.LogInformation("Login: credenciales rechazadas.");
            }

            return InvalidCredentials();
        }

        // El User interno se resuelve (o se crea) ANTES de abrir la sesión: si Postgres falla acá, no queda cookie emitida.
        var provisioned = await provisioner.EnsureUserAsync(
            new ExternalIdentity(VectorifyClaimTypes.AspNetIdentityProvider, account.Id.ToString(), account.Email, DisplayName: null),
            cancellationToken);

        // Sin «recordarme»: cookie de sesión del navegador (caducidad deslizante por inactividad, Auth:Cookie:Lifetime). Con él: cookie
        // persistente con tope ABSOLUTO (Auth:Cookie:RememberMeLifetime). Atributos de Auth:Cookie (HttpOnly, SameSite=Lax, Secure según opciones).
        var rememberMe = request.RememberMe == true;
        await signIn.SignInAsync(account, SessionCookie.CreateProperties(rememberMe, time.GetUtcNow(), authOptions.Value.Cookie));
        logger.LogInformation("Login: sesión iniciada para la cuenta {AccountId} (persistente: {RememberMe}).", account.Id, rememberMe);

        return Results.Ok(await LoadCurrentUserAsync(
            db, provisioned.UserId, account.Email, authOptions.Value.Mode, cancellationToken));
    }

    private static async Task<IResult> LogoutAsync(
        ClaimsPrincipal principal,
        HttpContext http,
        UserManager<ApplicationUser> users,
        SignInManager<ApplicationUser> signIn,
        ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger("Vectorify.Api.Endpoints.AuthEndpoints");
        http.Response.Headers.CacheControl = "no-store";

        // Decisión de S03 (ADR D3.7): el logout ROTA el SecurityStamp de la cuenta, así que cualquier copia de la cookie anterior
        // (robada, o de otra pestaña/dispositivo) deja de valer en cuanto se revalida (SecurityStampValidator, cada
        // Auth:Session:RevalidationInterval). Es "cerrar sesión en todos lados". En el navegador que hace logout la cookie se borra abajo.
        var rotationFailed = await RotateSecurityStampAsync(principal, users, logger);

        // La cookie del navegador se borra SIEMPRE, incluso si la rotación falló.
        await signIn.SignOutAsync();

        return rotationFailed
            ? Results.Json(
                new ApiErrorResponse(LogoutIncompleteCode, "La sesión de este navegador se cerró, pero no se pudo invalidar el resto. Intentá de nuevo."),
                statusCode: StatusCodes.Status503ServiceUnavailable)
            : Results.NoContent();
    }

    private static async Task<IResult> LogoutAllAsync(
        ClaimsPrincipal principal,
        HttpContext http,
        UserManager<ApplicationUser> users,
        SignInManager<ApplicationUser> signIn,
        ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger("Vectorify.Api.Endpoints.AuthEndpoints");
        http.Response.Headers.CacheControl = "no-store";

        // Misma rotación que el logout (S03), pero como acción explícita y con sesión obligatoria (RequireAuthorization): quien llega acá
        // está autenticado, y es SU cuenta (identidad de la cookie verificada) la que se rota; nada del cliente decide cuál.
        var rotationFailed = await RotateSecurityStampAsync(principal, users, logger);
        await signIn.SignOutAsync();

        if (rotationFailed)
        {
            logger.LogWarning("Logout-all: no se pudo invalidar el resto de las sesiones.");
            return Results.Json(
                new ApiErrorResponse(LogoutIncompleteCode, "La sesión de este navegador se cerró, pero no se pudo invalidar el resto. Intentá de nuevo."),
                statusCode: StatusCodes.Status503ServiceUnavailable);
        }

        logger.LogInformation("Logout-all: sesiones de la cuenta invalidadas.");
        return Results.NoContent();
    }

    /// <summary>
    /// Rota el <c>SecurityStamp</c> de la cuenta del principal autenticado (invalida todas las cookies emitidas antes, al revalidarse).
    /// Devuelve true si FALLÓ; false si se rotó o no había cuenta autenticada que rotar. Nunca lanza salvo cancelación.
    /// </summary>
    private static async Task<bool> RotateSecurityStampAsync(
        ClaimsPrincipal principal, UserManager<ApplicationUser> users, ILogger logger)
    {
        if (principal.Identity?.IsAuthenticated != true
            || !ClaimsIdentityReader.TryRead(principal, VectorifyClaimTypes.AspNetIdentityProvider, out var identity))
        {
            return false;
        }

        try
        {
            var account = await users.FindByIdAsync(identity.Subject);
            if (account is null)
            {
                return false;
            }

            var rotated = await users.UpdateSecurityStampAsync(account);
            return !rotated.Succeeded;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogError(ex, "No se pudo rotar el SecurityStamp de la cuenta; la cookie se borra igualmente.");
            return true;
        }
    }

    private static async Task<IResult> MeAsync(
        ClaimsPrincipal principal,
        HttpContext http,
        VectorizationDbContext db,
        IUserContext userContext,
        Microsoft.Extensions.Options.IOptions<AuthOptions> authOptions,
        CancellationToken cancellationToken)
    {
        http.Response.Headers.CacheControl = "no-store";

        // Auth:Mode=Development (M3.1-S05): no hay login; quien responde IUserContext es el usuario de desarrollo fijo. Se devuelve ESE
        // usuario (el dueño real de los datos en este modo), con el indicador de modo para que la SPA oculte login/«Salir». Este modo
        // solo existe en Development/Testing/Test (guardrail de arranque), así que nunca se alcanza en Production.
        if (authOptions.Value.Mode == AuthMode.Development)
        {
            return Results.Ok(await LoadCurrentUserAsync(
                db, userContext.GetEffectiveUserId(), userContext.Email, AuthMode.Development, cancellationToken));
        }

        // El id sale SOLO de la identidad interna que agregó el servidor tras verificar la cookie (nunca de query, cuerpo ni cabeceras).
        if (!InternalIdentityReader.TryGetUserId(principal, out var userId))
        {
            return Results.Unauthorized();
        }

        var emailClaim = principal.FindFirst(ClaimTypes.Email)?.Value;
        return Results.Ok(await LoadCurrentUserAsync(db, userId, emailClaim, AuthMode.Authenticated, cancellationToken));
    }

    private static async Task<CurrentUserResponse> LoadCurrentUserAsync(
        VectorizationDbContext db, Guid userId, string? fallbackEmail, AuthMode mode, CancellationToken cancellationToken)
    {
        var user = await db.Users.AsNoTracking()
            .Where(u => u.Id == userId)
            .Select(u => new { u.Email, u.DisplayName })
            .SingleOrDefaultAsync(cancellationToken);

        return new CurrentUserResponse(userId, user?.Email ?? fallbackEmail, user?.DisplayName ?? string.Empty, mode.ToString());
    }

    private static IResult InvalidCredentials() =>
        Results.Json(
            new ApiErrorResponse(InvalidCredentialsCode, InvalidCredentialsMessage),
            statusCode: StatusCodes.Status401Unauthorized);

    private static async Task<IResult> RegisterAsync(
        RegisterRequest request,
        UserManager<ApplicationUser> users,
        IUserProvisioner provisioner,
        Microsoft.Extensions.Options.IOptions<AuthOptions> authOptions,
        TimeProvider time,
        ILoggerFactory loggerFactory,
        CancellationToken cancellationToken)
    {
        var logger = loggerFactory.CreateLogger("Vectorify.Api.Endpoints.AuthEndpoints");

        var email = request.Email?.Trim();
        if (!IsValidEmail(email))
        {
            return Results.BadRequest(new ApiErrorResponse("invalid_email", "Indicá un correo electrónico válido."));
        }

        var password = request.Password;
        if (string.IsNullOrEmpty(password))
        {
            return Results.BadRequest(new ApiErrorResponse("weak_password", PasswordMessage(authOptions.Value)));
        }

        if (password.Length > AuthPasswordOptions.MaxLength)
        {
            return Results.BadRequest(new ApiErrorResponse(
                "weak_password", $"La contraseña no puede superar los {AuthPasswordOptions.MaxLength} caracteres."));
        }

        var account = new ApplicationUser
        {
            Id = Guid.NewGuid(),
            UserName = email,
            Email = email,
            CreatedAt = time.GetUtcNow(),
        };

        IdentityResult result;
        try
        {
            // CreateAsync valida la contraseña y la hashea (hash adaptativo de Identity) ANTES de comprobar si el correo
            // existe, así que el trabajo y el tiempo son comparables en ambos casos (T5, riesgo residual [N] sin medir).
            result = await users.CreateAsync(account, password);
        }
        catch (DbUpdateException ex) when (ex.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
        {
            // Dos registros simultáneos del mismo correo: el índice único de Identity hizo perder a este. Es "ya existe".
            logger.LogInformation("Registro: el correo ya estaba registrado (colisión concurrente).");
            return Accepted();
        }

        if (result.Succeeded)
        {
            await ProvisionUserAsync(provisioner, account, email!, logger, cancellationToken);
            logger.LogInformation("Registro: cuenta nueva creada.");
            return Accepted();
        }

        if (result.Errors.Any(e => e.Code.StartsWith("Password", StringComparison.Ordinal)))
        {
            return Results.BadRequest(new ApiErrorResponse("weak_password", PasswordMessage(authOptions.Value)));
        }

        if (result.Errors.All(e => e.Code is nameof(IdentityErrorDescriber.DuplicateUserName) or nameof(IdentityErrorDescriber.DuplicateEmail)))
        {
            logger.LogInformation("Registro: el correo ya estaba registrado.");
            return Accepted();
        }

        // Cualquier otro rechazo de Identity (p. ej. nombre de usuario inválido): error de validación genérico, sin detalle.
        return Results.BadRequest(new ApiErrorResponse("invalid_request", "No se pudo procesar el registro con los datos indicados."));
    }

    /// <summary>
    /// Crea/vincula el <c>User</c> interno de la cuenta recién creada. Idempotente: si falla (p. ej. Postgres cae justo
    /// ahora) la cuenta ya existe y el middleware de provisión crea el User en la primera request autenticada, así que no
    /// se rompe el registro ni se delata nada; el fallo queda en el log (sin PII).
    /// </summary>
    private static async Task ProvisionUserAsync(
        IUserProvisioner provisioner, ApplicationUser account, string email, ILogger logger, CancellationToken cancellationToken)
    {
        try
        {
            await provisioner.EnsureUserAsync(
                new ExternalIdentity(VectorifyClaimTypes.AspNetIdentityProvider, account.Id.ToString(), email, DisplayName: null),
                cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(
                ex, "Registro: la cuenta {AccountId} se creó pero no se pudo crear su User interno; se reintentará en su primera request autenticada.",
                account.Id);
        }
    }

    private static IResult Accepted() =>
        Results.Json(new RegisterResponse(RegisterAcceptedStatus), statusCode: StatusCodes.Status202Accepted);

    private static string PasswordMessage(AuthOptions options) =>
        $"La contraseña debe tener al menos {options.Password.MinLength} caracteres.";

    private static bool IsValidEmail(string? email)
    {
        if (string.IsNullOrEmpty(email) || email.Length > MaxEmailLength)
        {
            return false;
        }

        // MailAddress acepta formas con nombre ("Ana <a@b.c>") y comentarios: solo vale la dirección pelada.
        if (!MailAddress.TryCreate(email, out var parsed) || !string.Equals(parsed.Address, email, StringComparison.Ordinal))
        {
            return false;
        }

        return email.Contains('@') && parsed.Host.Contains('.') && !email.Any(char.IsWhiteSpace);
    }
}
