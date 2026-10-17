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

    /// <summary>Auth__DataProtection__*: dónde vive el key ring que cifra la cookie de sesión (M3.1-S04).</summary>
    public AuthDataProtectionOptions DataProtection { get; set; } = new();
}

public sealed class AuthCookieOptions
{
    /// <summary>Auth__Cookie__Name. <c>__Host-</c> exige <c>Secure</c>, <c>Path=/</c> y ningún <c>Domain</c>; en desarrollo sobre http usar un nombre sin prefijo.</summary>
    public string Name { get; set; } = "__Host-vectorify.session";

    /// <summary>Auth__Cookie__SecurePolicy: <c>Always</c> (default) o <c>SameAsRequest</c> (solo entornos de desarrollo).</summary>
    public CookieSecurePolicy SecurePolicy { get; set; } = CookieSecurePolicy.Always;

    /// <summary>
    /// Tope que el navegador aplica a <c>Expires</c>/<c>Max-Age</c> (Chrome limita a 400 días): una cookie persistente no puede
    /// prometer más, así que <see cref="RememberMeLifetime"/> no puede superarlo.
    /// </summary>
    public static readonly TimeSpan MaxPersistentLifetime = TimeSpan.FromDays(400);

    /// <summary>
    /// Auth__Cookie__Lifetime: ventana de INACTIVIDAD de la sesión normal (cookie de sesión del navegador). Es deslizante: cada
    /// vez que el servidor revalida o pasa de la mitad de la ventana, reemite el ticket con otras <c>Lifetime</c> desde ese momento.
    /// </summary>
    public TimeSpan Lifetime { get; set; } = TimeSpan.FromHours(8);

    /// <summary>
    /// Auth__Cookie__RememberMeLifetime: con «recordarme» (<c>rememberMe: true</c> en el login) la cookie es PERSISTENTE y su
    /// vida es un TOPE ABSOLUTO contado desde el login: ni la actividad ni la revalidación del SecurityStamp lo prolongan.
    /// </summary>
    public TimeSpan RememberMeLifetime { get; set; } = TimeSpan.FromDays(30);
}

public sealed class AuthSessionOptions
{
    /// <summary>Tolerancia máxima aceptada para <see cref="ClockSkew"/>.</summary>
    public static readonly TimeSpan MaxClockSkew = TimeSpan.FromMinutes(5);

    /// <summary>
    /// Auth__Session__RevalidationInterval: cada cuánto se revalida el <c>SecurityStamp</c> contra la base (5 min por defecto; 0 =
    /// en cada request). Es la VENTANA MÁXIMA en la que una cookie revocada (logout, «cerrar sesión en todos lados») sigue
    /// funcionando en otro navegador: ver docs/AUTH_SESSION_LIFECYCLE.md.
    /// </summary>
    public TimeSpan RevalidationInterval { get; set; } = TimeSpan.FromMinutes(5);

    /// <summary>
    /// Auth__Session__ClockSkew: desfase de reloj tolerado entre quien emitió el ticket y quien lo valida (varias instancias, NTP
    /// mal ajustado). Un ticket «emitido en el futuro» más allá de esta tolerancia se revalida contra la base de inmediato en vez
    /// de esperar a que el reloj local lo alcance, de modo que el desfase no alarga la ventana de revocación.
    /// </summary>
    public TimeSpan ClockSkew { get; set; } = TimeSpan.FromSeconds(30);
}

public sealed class AuthDataProtectionOptions
{
    /// <summary>
    /// Auth__DataProtection__KeysPath: directorio (ruta absoluta) del key ring de Data Protection. Es un SECRETO: quien lo lee puede
    /// forjar cookies de sesión. Debe estar en un volumen persistente y fuera del repositorio y de la imagen. Vacío = el default de
    /// ASP.NET (perfil del usuario del SO), aceptado SOLO en Development/Testing/Test; en cualquier otro entorno el arranque falla.
    /// </summary>
    public string? KeysPath { get; set; }
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
