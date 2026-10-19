using System.Security.Claims;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.Options;
using Vectorify.Api.Contracts;
using Vectorify.Api.Data.Auth;
using Vectorify.Api.Email;
using Vectorify.Api.Options;
using Vectorify.Api.Users;

namespace Vectorify.Api.Endpoints;

/// <summary>
/// Recuperación de acceso y verificación de correo (M3.1-S08) bajo <c>/api/v1/auth</c>, con los tokens NATIVOS de ASP.NET Core Identity (nada de tokens propios):
/// <c>forgot-password</c>, <c>reset-password</c>, <c>confirm-email</c>, <c>resend-confirmation</c> (anónimos: nadie tiene sesión cuando olvidó la contraseña) y
/// <c>change-password</c> (sesión obligatoria). Todas responden <c>Cache-Control: no-store</c>; el CSRF de los métodos no seguros lo aplica el middleware global; las cuatro
/// anónimas llevan además el límite por IP (429 + Retry-After) y el límite por dirección hasheada (<see cref="AuthRecoveryLimiter"/>). Ningún log incluye correos, tokens ni contraseñas.
/// </summary>
public static class AuthRecoveryEndpoints
{
    public const string ForgotPasswordPath = "/api/v1/auth/forgot-password";
    public const string ResetPasswordPath = "/api/v1/auth/reset-password";
    public const string ConfirmEmailPath = "/api/v1/auth/confirm-email";
    public const string ResendConfirmationPath = "/api/v1/auth/resend-confirmation";
    public const string ChangePasswordPath = "/api/v1/auth/change-password";

    /// <summary>400 ÚNICO de reset/confirm: token inválido, caducado, reusado, malformado, de otra cuenta o cuenta inexistente (y también «límite por dirección»).</summary>
    public const string InvalidTokenCode = "invalid_token";

    public const string InvalidTokenMessage = "El enlace no es válido o ya venció. Pedí uno nuevo.";

    /// <summary>400 de change-password con la contraseña actual incorrecta. NUNCA 401: un 401 sacaría al usuario de su sesión en el cliente.</summary>
    public const string InvalidCurrentPasswordCode = "invalid_current_password";

    private const int MaxTokenLength = 1024;
    private const int MaxIdentifierLength = 64;

    public static void MapAuthRecoveryEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost(ForgotPasswordPath, ForgotPasswordAsync)
            .AllowAnonymous()
            .RequireRateLimiting(AuthRecoveryLimiter.IpPolicyName)
            .WithName("ForgotPassword")
            .WithTags("Auth")
            .Produces<RegisterResponse>(StatusCodes.Status202Accepted)
            .Produces<ApiErrorResponse>(StatusCodes.Status400BadRequest)
            .Produces<ApiErrorResponse>(StatusCodes.Status429TooManyRequests)
            .WithSummary("Pide el enlace para elegir una contraseña nueva. Respuesta 202 UNIFORME exista o no la cuenta.")
            .WithDescription(
                "Mismo estado, cabeceras y cuerpo exista o no la cuenta, esté o no bloqueada, y también cuando el límite por dirección impide el envío. " +
                "El correo (token NATIVO de Identity, vida Auth:Tokens:PasswordResetLifetime) se genera y envía en segundo plano; el enlace usa Auth:Email:PublicBaseUrl y lleva el token en el fragmento. " +
                "Solo un correo mal formado da 400 invalid_email (no depende de la cuenta). Por IP: 429 + Retry-After.");

        app.MapPost(ResetPasswordPath, ResetPasswordAsync)
            .AllowAnonymous()
            .RequireRateLimiting(AuthRecoveryLimiter.IpPolicyName)
            .WithName("ResetPassword")
            .WithTags("Auth")
            .Produces(StatusCodes.Status204NoContent)
            .Produces<ApiErrorResponse>(StatusCodes.Status400BadRequest)
            .Produces<ApiErrorResponse>(StatusCodes.Status429TooManyRequests)
            .WithSummary("Elige una contraseña nueva con el token recibido por correo.")
            .WithDescription(
                "204 si el token NATIVO es válido: cambia la contraseña, ROTA el SecurityStamp (todas las sesiones previas dejan de valer al revalidarse; el token y los demás pendientes también) y limpia el bloqueo de la cuenta. " +
                "Token inválido, caducado, reusado, malformado, de otra cuenta o cuenta inexistente: el MISMO 400 invalid_token. Contraseña < Auth:Password:MinLength: 400 weak_password.");

        app.MapPost(ConfirmEmailPath, ConfirmEmailAsync)
            .AllowAnonymous()
            .RequireRateLimiting(AuthRecoveryLimiter.IpPolicyName)
            .WithName("ConfirmEmail")
            .WithTags("Auth")
            .Produces(StatusCodes.Status204NoContent)
            .Produces<ApiErrorResponse>(StatusCodes.Status400BadRequest)
            .Produces<ApiErrorResponse>(StatusCodes.Status429TooManyRequests)
            .WithSummary("Confirma el correo de la cuenta con el token recibido por correo.")
            .WithDescription(
                "204 si el token NATIVO es válido. Token inválido, caducado, reusado (la cuenta ya está confirmada), malformado, de otra cuenta o cuenta inexistente: el MISMO 400 invalid_token. " +
                "Identifica la cuenta por userId (el enlace) o por email.");

        app.MapPost(ResendConfirmationPath, ResendConfirmationAsync)
            .AllowAnonymous()
            .RequireRateLimiting(AuthRecoveryLimiter.IpPolicyName)
            .WithName("ResendConfirmation")
            .WithTags("Auth")
            .Produces<RegisterResponse>(StatusCodes.Status202Accepted)
            .Produces<ApiErrorResponse>(StatusCodes.Status400BadRequest)
            .Produces<ApiErrorResponse>(StatusCodes.Status429TooManyRequests)
            .WithSummary("Pide otro correo de confirmación. Respuesta 202 UNIFORME exista o no la cuenta (o ya esté confirmada).")
            .WithDescription("Igual que forgot-password: el envío ocurre en segundo plano y solo si la cuenta existe y está sin confirmar.");

        app.MapPost(ChangePasswordPath, ChangePasswordAsync)
            .RequireAuthorization()
            .WithName("ChangePassword")
            .WithTags("Auth")
            .Produces(StatusCodes.Status204NoContent)
            .Produces<ApiErrorResponse>(StatusCodes.Status400BadRequest)
            .Produces(StatusCodes.Status401Unauthorized)
            .WithSummary("Cambia la contraseña de la cuenta autenticada (exige la contraseña actual) y mantiene viva la sesión actual.")
            .WithDescription(
                "Exige sesión (401 SOLO si no hay sesión válida) y el CSRF global. Contraseña actual incorrecta: 400 invalid_current_password (NUNCA 401, que sacaría al usuario de su sesión en el cliente). " +
                "Nueva contraseña corta: 400 weak_password. Éxito: 204, ROTA el SecurityStamp (las demás sesiones dejan de valer al revalidarse) y re-emite la cookie de ESTA sesión con el stamp nuevo.");
    }

    // ----------------------------------------------------------------------------------------------------- forgot / resend

    private static IResult ForgotPasswordAsync(
        ForgotPasswordRequest? request, HttpContext http, AuthRecoveryLimiter limiter, IAuthEmailQueue queue, ILoggerFactory loggerFactory) =>
        RequestEmail(request?.Email, AuthEmailKind.PasswordReset, http, limiter, queue, loggerFactory);

    private static IResult ResendConfirmationAsync(
        ResendConfirmationRequest? request, HttpContext http, AuthRecoveryLimiter limiter, IAuthEmailQueue queue, ILoggerFactory loggerFactory) =>
        RequestEmail(request?.Email, AuthEmailKind.EmailConfirmation, http, limiter, queue, loggerFactory);

    /// <summary>
    /// Camino SÍNCRONO idéntico exista o no la cuenta: valida el formato, consulta el límite por dirección (memoria) y encola. No toca la base ni envía nada: el trabajador
    /// resuelve la cuenta después, así que ni el tiempo ni el cuerpo ni las cabeceras delatan nada.
    /// </summary>
    private static IResult RequestEmail(
        string? rawEmail, AuthEmailKind kind, HttpContext http, AuthRecoveryLimiter limiter, IAuthEmailQueue queue, ILoggerFactory loggerFactory)
    {
        http.Response.Headers.CacheControl = "no-store";

        var email = rawEmail?.Trim();
        if (!AuthEndpoints.IsValidEmail(email))
        {
            return Results.BadRequest(new ApiErrorResponse("invalid_email", "Indicá un correo electrónico válido."));
        }

        var logger = loggerFactory.CreateLogger("Vectorify.Api.Endpoints.AuthRecoveryEndpoints");
        if (!limiter.TryAcquireSend(email!))
        {
            // Mismo 202 de siempre, sin enviar: quien pide de más no se entera de que lo frenamos (ni de si la cuenta existe).
            logger.LogInformation("Recuperación ({Kind}): límite por dirección alcanzado; no se envía.", kind);
            return AuthEndpoints.Accepted();
        }

        if (!queue.TryEnqueue(new AuthEmailJob(kind, email!)))
        {
            logger.LogWarning("Recuperación ({Kind}): la cola de correo está llena; el pedido se descarta.", kind);
        }

        return AuthEndpoints.Accepted();
    }

    // ----------------------------------------------------------------------------------------------------------- reset

    private static async Task<IResult> ResetPasswordAsync(
        ResetPasswordRequest? request,
        HttpContext http,
        UserManager<ApplicationUser> users,
        AuthRecoveryLimiter limiter,
        IOptions<AuthOptions> authOptions,
        ILoggerFactory loggerFactory)
    {
        http.Response.Headers.CacheControl = "no-store";
        var logger = loggerFactory.CreateLogger("Vectorify.Api.Endpoints.AuthRecoveryEndpoints");

        var email = request?.Email?.Trim();
        var token = request?.Token;
        if (!AuthEndpoints.IsValidEmail(email) || string.IsNullOrWhiteSpace(token) || token.Length > MaxTokenLength)
        {
            return InvalidToken();
        }

        // La política de contraseña no depende de la cuenta: se comprueba antes y no revela nada.
        var weak = CheckNewPassword(request!.NewPassword, authOptions.Value);
        if (weak is not null)
        {
            return weak;
        }

        if (!limiter.TryAcquireVerify(email!))
        {
            logger.LogInformation("Restablecer contraseña: límite por dirección alcanzado.");
            return InvalidToken();
        }

        var account = await users.FindByEmailAsync(email!);
        if (account is null)
        {
            logger.LogInformation("Restablecer contraseña: pedido rechazado.");
            return InvalidToken();
        }

        // Token NATIVO: lo verifica ResetPasswordAsync (firma, propósito, caducidad y SecurityStamp). Al cambiar la contraseña Identity ROTA el stamp: este mismo token,
        // los demás pendientes y TODAS las cookies previas dejan de valer (T15).
        var result = await users.ResetPasswordAsync(account, token, request.NewPassword!);
        if (!result.Succeeded)
        {
            if (result.Errors.Any(e => e.Code.StartsWith("Password", StringComparison.Ordinal)))
            {
                return WeakPassword(authOptions.Value);
            }

            logger.LogInformation("Restablecer contraseña: pedido rechazado.");
            return InvalidToken();
        }

        // Quien demostró controlar el buzón recupera el acceso: se limpia el bloqueo por intentos fallidos.
        await users.SetLockoutEndDateAsync(account, null);
        await users.ResetAccessFailedCountAsync(account);

        logger.LogInformation("Restablecer contraseña: contraseña cambiada para la cuenta {AccountId}.", account.Id);
        return Results.NoContent();
    }

    // ------------------------------------------------------------------------------------------------------------ confirm

    private static async Task<IResult> ConfirmEmailAsync(
        ConfirmEmailRequest? request,
        HttpContext http,
        UserManager<ApplicationUser> users,
        AuthRecoveryLimiter limiter,
        ILoggerFactory loggerFactory)
    {
        http.Response.Headers.CacheControl = "no-store";
        var logger = loggerFactory.CreateLogger("Vectorify.Api.Endpoints.AuthRecoveryEndpoints");

        var token = request?.Token;
        if (string.IsNullOrWhiteSpace(token) || token.Length > MaxTokenLength)
        {
            return InvalidToken();
        }

        var userId = request!.AccountId?.Trim();
        var email = request.Email?.Trim();
        var byId = !string.IsNullOrEmpty(userId);
        if (byId ? userId!.Length > MaxIdentifierLength || !Guid.TryParse(userId, out _) : !AuthEndpoints.IsValidEmail(email))
        {
            return InvalidToken();
        }

        if (!limiter.TryAcquireVerify(byId ? userId! : email!))
        {
            logger.LogInformation("Confirmar correo: límite por dirección alcanzado.");
            return InvalidToken();
        }

        var account = byId ? await users.FindByIdAsync(userId!) : await users.FindByEmailAsync(email!);

        // Un solo uso: una cuenta ya confirmada rechaza el token aunque criptográficamente siga vigente (ConfirmEmailAsync no rota el stamp).
        if (account is null || account.EmailConfirmed)
        {
            logger.LogInformation("Confirmar correo: pedido rechazado.");
            return InvalidToken();
        }

        var result = await users.ConfirmEmailAsync(account, token);
        if (!result.Succeeded)
        {
            logger.LogInformation("Confirmar correo: pedido rechazado.");
            return InvalidToken();
        }

        logger.LogInformation("Confirmar correo: cuenta {AccountId} confirmada.", account.Id);
        return Results.NoContent();
    }

    // ---------------------------------------------------------------------------------------------------- change-password

    private static async Task<IResult> ChangePasswordAsync(
        ChangePasswordRequest? request,
        ClaimsPrincipal principal,
        HttpContext http,
        UserManager<ApplicationUser> users,
        SignInManager<ApplicationUser> signIn,
        IOptions<AuthOptions> authOptions,
        TimeProvider time,
        ILoggerFactory loggerFactory)
    {
        http.Response.Headers.CacheControl = "no-store";
        var logger = loggerFactory.CreateLogger("Vectorify.Api.Endpoints.AuthRecoveryEndpoints");

        // La cuenta sale SOLO de la identidad verificada de la cookie (nunca del cuerpo).
        if (!ClaimsIdentityReader.TryRead(principal, VectorifyClaimTypes.AspNetIdentityProvider, out var identity))
        {
            return Results.Unauthorized();
        }

        var account = await users.FindByIdAsync(identity.Subject);
        if (account is null)
        {
            return Results.Unauthorized();
        }

        var current = request?.CurrentPassword;
        if (string.IsNullOrEmpty(current) || current.Length > AuthPasswordOptions.MaxLength)
        {
            return InvalidCurrentPassword();
        }

        var weak = CheckNewPassword(request!.NewPassword, authOptions.Value);
        if (weak is not null)
        {
            return weak;
        }

        // Propiedades de la sesión ACTUAL, leídas ANTES de rotar el stamp (después la cookie vieja ya no revalidaría). Sirven para re-emitirla sin reiniciar el tope de «recordarme».
        var auth = await http.AuthenticateAsync(IdentityConstants.ApplicationScheme);
        var rememberedUntil = auth.Properties is not null && SessionCookie.TryGetAbsoluteExpiry(auth.Properties, out var absolute)
            ? (DateTimeOffset?)absolute
            : null;

        // Una cuenta bloqueada no permite probar contraseñas ni siquiera con sesión (quien tiene una cookie robada no puede adivinar la actual sin tope).
        if (await users.IsLockedOutAsync(account))
        {
            logger.LogWarning("Cambio de contraseña: cuenta {AccountId} bloqueada; pedido rechazado.", account.Id);
            return InvalidCurrentPassword();
        }

        var result = await users.ChangePasswordAsync(account, current, request.NewPassword!);
        if (!result.Succeeded)
        {
            if (result.Errors.Any(e => e.Code == nameof(IdentityErrorDescriber.PasswordMismatch)))
            {
                await users.AccessFailedAsync(account); // cuenta para el bloqueo: es un intento de adivinar la contraseña
                logger.LogInformation("Cambio de contraseña: contraseña actual incorrecta (cuenta {AccountId}).", account.Id);
                return InvalidCurrentPassword();
            }

            if (result.Errors.Any(e => e.Code.StartsWith("Password", StringComparison.Ordinal)))
            {
                return WeakPassword(authOptions.Value);
            }

            return Results.BadRequest(new ApiErrorResponse("invalid_request", "No se pudo cambiar la contraseña con los datos indicados."));
        }

        await users.ResetAccessFailedCountAsync(account);

        // ChangePasswordAsync ya ROTÓ el SecurityStamp: las demás cookies de la cuenta dejan de valer al revalidarse. Esta sesión sigue viva porque se re-emite su cookie con el stamp
        // nuevo; «recordarme» conserva su tope absoluto original, una sesión normal vuelve a empezar su ventana deslizante.
        var properties = rememberedUntil is { } until
            ? SessionCookie.CreatePersistentProperties(time.GetUtcNow(), until)
            : new AuthenticationProperties { IsPersistent = false };
        await signIn.SignInAsync(account, properties);

        logger.LogInformation("Cambio de contraseña: contraseña cambiada para la cuenta {AccountId}; sesión actual re-emitida.", account.Id);
        return Results.NoContent();
    }

    // ------------------------------------------------------------------------------------------------------------ helpers

    private static IResult InvalidToken() =>
        Results.BadRequest(new ApiErrorResponse(InvalidTokenCode, InvalidTokenMessage));

    private static IResult InvalidCurrentPassword() =>
        Results.BadRequest(new ApiErrorResponse(InvalidCurrentPasswordCode, "La contraseña actual no es correcta."));

    private static IResult WeakPassword(AuthOptions options) =>
        Results.BadRequest(new ApiErrorResponse("weak_password", $"La contraseña debe tener al menos {options.Password.MinLength} caracteres."));

    /// <summary>Largo de la contraseña nueva (mismas reglas y mensajes que el registro). null = pasa; el resto de reglas las aplica el validador de Identity.</summary>
    private static IResult? CheckNewPassword(string? password, AuthOptions options)
    {
        if (string.IsNullOrEmpty(password) || password.Length < options.Password.MinLength)
        {
            return WeakPassword(options);
        }

        if (password.Length > AuthPasswordOptions.MaxLength)
        {
            return Results.BadRequest(new ApiErrorResponse(
                "weak_password", $"La contraseña no puede superar los {AuthPasswordOptions.MaxLength} caracteres."));
        }

        return null;
    }
}
