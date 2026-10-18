using Microsoft.EntityFrameworkCore;
using Vectorify.Api.Contracts;
using Vectorify.Api.Data;
using Vectorify.Api.Users;

namespace Vectorify.Api.Endpoints;

/// <summary>
/// Perfil del usuario actual (M3.1-S07): <c>GET /api/v1/me</c> y <c>PATCH /api/v1/me</c>. Distinto de <c>GET /api/v1/auth/me</c> (consulta de
/// sesión de S03/S05). Separa los datos de dominio de VECTORiZE (<c>Users.DisplayName</c>, editable) de la identidad (email, solo lectura).
/// El usuario sale SOLO de <see cref="IUserContext"/> (identidad verificada); la ruta no recibe ids y el cuerpo no puede nombrar a otro usuario.
/// Ambas rutas heredan la <c>FallbackPolicy</c> (401 sin sesión) y el CSRF global de los métodos no seguros; responden <c>Cache-Control: no-store</c>.
/// </summary>
public static class ProfileEndpoints
{
    public const string ProfilePath = "/api/v1/me";

    /// <summary>Campos del perfil que gestiona la cuenta/identidad y que este endpoint NO modifica.</summary>
    public static readonly IReadOnlyList<string> AccountManagedFields = ["email"];

    public static void MapProfileEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet(ProfilePath, GetProfileAsync)
            .WithName("GetProfile")
            .WithTags("Profile")
            .Produces<ProfileResponse>(StatusCodes.Status200OK)
            .Produces(StatusCodes.Status401Unauthorized)
            .WithSummary("Perfil del usuario actual (id interno, email de solo lectura, displayName, createdAt, campos gestionados por la cuenta).")
            .WithDescription(
                "Resuelto SOLO desde IUserContext. 401 sin sesión. Cache-Control: no-store. No expone proveedor, subject, hash ni stamp.");

        app.MapPatch(ProfilePath, UpdateProfileAsync)
            .WithName("UpdateProfile")
            .WithTags("Profile")
            .Produces<ProfileResponse>(StatusCodes.Status200OK)
            .Produces<ApiErrorResponse>(StatusCodes.Status400BadRequest)
            .Produces(StatusCodes.Status401Unauthorized)
            .WithSummary("Actualiza el nombre para mostrar del usuario actual.")
            .WithDescription(
                "Acepta SOLO displayName (recortado, 1-80 caracteres, sin caracteres de control): 400 invalid_display_name si no cumple. " +
                "Cualquier otro campo del cuerpo (id, userId, email, provider, subject, createdAt, authMode...) se IGNORA: no tiene efecto ni provoca error. " +
                "Exige sesión (401) y el mismo CSRF que el resto de métodos no seguros.");
    }

    private static async Task<IResult> GetProfileAsync(
        HttpContext http, IUserContext userContext, VectorizationDbContext db, CancellationToken cancellationToken)
    {
        http.Response.Headers.CacheControl = "no-store";

        var user = await db.Users.AsNoTracking()
            .SingleOrDefaultAsync(u => u.Id == userContext.GetEffectiveUserId(), cancellationToken);

        return user is null ? NotFound() : Results.Ok(ToResponse(user));
    }

    private static async Task<IResult> UpdateProfileAsync(
        UpdateProfileRequest? request,
        HttpContext http,
        IUserContext userContext,
        VectorizationDbContext db,
        ILoggerFactory loggerFactory,
        CancellationToken cancellationToken)
    {
        http.Response.Headers.CacheControl = "no-store";

        if (!DisplayNameRules.TryNormalize(request?.DisplayName, out var displayName, out var error))
        {
            return Results.BadRequest(new ApiErrorResponse(DisplayNameRules.InvalidCode, error));
        }

        // El usuario es SIEMPRE el efectivo de la request: nada del cuerpo, la query ni las cabeceras decide a quién se modifica.
        var userId = userContext.GetEffectiveUserId();
        var user = await db.Users.SingleOrDefaultAsync(u => u.Id == userId, cancellationToken);
        if (user is null)
        {
            return NotFound();
        }

        user.DisplayName = displayName;
        await db.SaveChangesAsync(cancellationToken);

        // Sin el nombre ni el correo en el log (datos personales).
        loggerFactory.CreateLogger("Vectorify.Api.Endpoints.ProfileEndpoints")
            .LogInformation("Perfil: nombre para mostrar actualizado del usuario {UserId}.", userId);

        return Results.Ok(ToResponse(user));
    }

    private static ProfileResponse ToResponse(User user) =>
        new(user.Id, user.Email, user.DisplayName, user.CreatedAt, AccountManagedFields);

    private static IResult NotFound() =>
        Results.NotFound(new ApiErrorResponse("not_found", "No encontramos tu perfil."));
}
