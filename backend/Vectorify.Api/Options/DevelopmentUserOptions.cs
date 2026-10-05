namespace Vectorify.Api.Options;

/// <summary>
/// Identidad del usuario de desarrollo (M2.2-S09): la que devuelve
/// <see cref="Vectorify.Api.Users.DevelopmentUserContext"/> y la que siembra
/// <see cref="Vectorify.Api.Users.DevelopmentUserSeeder"/> al arrancar. Se enlaza desde la
/// sección "DevelopmentUser" de appsettings/variables de entorno (por ejemplo,
/// DevelopmentUser__UserId). Los defaults reproducen el usuario fijo de M2.2-S03, así que sin
/// configuración nada cambia. Solo se usa cuando el entorno es Development/Testing (ver
/// <see cref="Vectorify.Api.Users.UserContextRegistration"/>).
/// </summary>
public sealed class DevelopmentUserOptions
{
    public const string SectionName = "DevelopmentUser";

    /// <summary>Id fijo y determinístico del usuario "dev" original (M2.2-S03).</summary>
    public static readonly Guid DefaultUserId = Guid.Parse("00000000-0000-0000-0000-000000000001");

    /// <summary>Id del usuario de desarrollo. No puede ser <see cref="Guid.Empty"/>.</summary>
    public Guid UserId { get; set; } = DefaultUserId;

    /// <summary>Email del usuario de desarrollo.</summary>
    public string? Email { get; set; } = "dev@vectorify.local";

    /// <summary>Nombre visible del usuario de desarrollo.</summary>
    public string DisplayName { get; set; } = "Dev User";
}
