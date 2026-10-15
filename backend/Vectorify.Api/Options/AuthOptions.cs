using Microsoft.AspNetCore.Http;

namespace Vectorify.Api.Options;

/// <summary>Quién responde «quién es el usuario de esta request» (M3.1-S02, ADR D2 y «Variables y configuración»).</summary>
public enum AuthMode
{
    /// <summary>
    /// Default y único modo válido en Production: <c>AuthenticatedUserContext</c> sobre la cookie de ASP.NET Core Identity.
    /// </summary>
    Authenticated,

    /// <summary>
    /// Usuario de desarrollo fijo (<c>DevelopmentUserContext</c>), sin login. SOLO Development/Testing/Test: en cualquier otro
    /// entorno el arranque falla (ver <see cref="Vectorify.Api.Users.UserContextRegistration"/>).
    /// </summary>
    Development,
}

/// <summary>
/// Sección <c>Auth</c> de la configuración (M3.1-S02). Solo valores NO secretos en appsettings; todo secreto por variable de
/// entorno (<c>Auth__...</c>). Los defaults son los del ADR. Login/logout y la sesión (S03/S04) reutilizan estas mismas opciones.
/// </summary>
public sealed class AuthOptions
{
    public const string SectionName = "Auth";

    /// <summary>Auth__Mode: <see cref="AuthMode.Authenticated"/> (default) o <see cref="AuthMode.Development"/> (solo entornos de desarrollo).</summary>
    public AuthMode Mode { get; set; } = AuthMode.Authenticated;

    public AuthCookieOptions Cookie { get; set; } = new();

    public AuthSessionOptions Session { get; set; } = new();

    public AuthPasswordOptions Password { get; set; } = new();

    public AuthLockoutOptions Lockout { get; set; } = new();
}

public sealed class AuthCookieOptions
{
    /// <summary>Auth__Cookie__Name. <c>__Host-</c> exige <c>Secure</c>, <c>Path=/</c> y ningún <c>Domain</c>; en desarrollo sobre http usar un nombre sin prefijo.</summary>
    public string Name { get; set; } = "__Host-vectorify.session";

    /// <summary>Auth__Cookie__SecurePolicy: <c>Always</c> (default) o <c>SameAsRequest</c> (solo entornos de desarrollo).</summary>
    public CookieSecurePolicy SecurePolicy { get; set; } = CookieSecurePolicy.Always;

    /// <summary>Auth__Cookie__Lifetime: vida de la sesión (deslizante). Referencia para S04.</summary>
    public TimeSpan Lifetime { get; set; } = TimeSpan.FromHours(8);
}

public sealed class AuthSessionOptions
{
    /// <summary>Auth__Session__RevalidationInterval: cada cuánto se revalida el <c>SecurityStamp</c> contra la base. Referencia para S04.</summary>
    public TimeSpan RevalidationInterval { get; set; } = TimeSpan.FromMinutes(5);
}

public sealed class AuthPasswordOptions
{
    /// <summary>Largo mínimo permitido por la política (suelo no configurable hacia abajo).</summary>
    public const int MinimumAllowedLength = 12;

    /// <summary>Largo máximo aceptado: acota el coste del hash y evita contraseñas-DoS.</summary>
    public const int MaxLength = 128;

    /// <summary>Auth__Password__MinLength (≥ <see cref="MinimumAllowedLength"/>).</summary>
    public int MinLength { get; set; } = MinimumAllowedLength;
}

public sealed class AuthLockoutOptions
{
    /// <summary>Auth__Lockout__MaxAttempts. Lo usa el login (S03).</summary>
    public int MaxAttempts { get; set; } = 5;

    /// <summary>Auth__Lockout__Duration. Lo usa el login (S03).</summary>
    public TimeSpan Duration { get; set; } = TimeSpan.FromMinutes(15);
}
