using System.Net.Mail;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using Vectorify.Api.Contracts;
using Vectorify.Api.Data.Auth;
using Vectorify.Api.Options;
using Vectorify.Api.Users;

namespace Vectorify.Api.Endpoints;

/// <summary>
/// Endpoints de autenticación propios (M3.1-S02: registro; login/logout/me llegan en S03), bajo <c>/api/v1/auth</c>. Usan
/// <c>UserManager</c> de ASP.NET Core Identity (NO <c>MapIdentityApi</c>, ADR D1). Son ANÓNIMOS: nadie tiene sesión antes de
/// registrarse. Ningún log de este archivo incluye el correo ni la contraseña.
/// </summary>
public static class AuthEndpoints
{
    public const string RegisterPath = "/api/v1/auth/register";

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
    }

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
