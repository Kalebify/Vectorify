namespace AuthPoc.Hosting;

/// <summary>Quien autentica a la persona. Es lo UNICO que cambia entre las dos configuraciones del PoC.</summary>
public enum IdentitySource
{
    /// <summary>(A) Token JWT emitido por un servidor OIDC (stand-in de Auth0/Entra External ID/Clerk/Keycloak/OpenIddict).</summary>
    OidcJwt,

    /// <summary>(B) ASP.NET Core Identity autoalojado, sesion en cookie HttpOnly.</summary>
    AspNetIdentityCookie,
}

/// <summary>Configuracion del host del PoC. En el producto equivale a la seccion <c>Auth:*</c> descrita en el ADR.</summary>
public sealed class AuthPocHostOptions
{
    public required IdentitySource Source { get; init; }

    public required string ConnectionString { get; init; }

    // ---- Fuente A (OIDC) ----

    /// <summary>URL del emisor (<c>Auth:Oidc:Authority</c>). Debe ser https: el middleware descarga de ahi el discovery y las claves.</summary>
    public string? OidcAuthority { get; init; }

    /// <summary>Audiencia esperada (<c>Auth:Oidc:Audience</c>): el identificador de ESTA API en el proveedor.</summary>
    public string? OidcAudience { get; init; }

    /// <summary>Solo para tests: sustituye al HTTP real hacia el emisor (discovery + JWKS simulados).</summary>
    public HttpMessageHandler? OidcBackchannelHandler { get; init; }

    /// <summary>Tolerancia de reloj. El default de JwtBearer es 5 min; el ADR recomienda 30 s.</summary>
    public TimeSpan ClockSkew { get; init; } = TimeSpan.FromSeconds(30);

    // ---- Fuente B (cookie) ----

    /// <summary>Prefijo <c>__Host-</c>: el navegador exige Secure, Path=/ y ningun Domain (la cookie no se comparte con subdominios).</summary>
    public string CookieName { get; init; } = "__Host-vectorify.session";

    /// <summary>Duracion de la sesion (con renovacion deslizante). Referencia para S04.</summary>
    public TimeSpan CookieLifetime { get; init; } = TimeSpan.FromHours(8);

    /// <summary>
    /// Cada cuanto se revalida el <c>SecurityStamp</c> de la cuenta contra la base (<c>Auth:Session:RevalidationInterval</c>). Cambiar la
    /// contrasena o "cerrar sesion en todos lados" rota el stamp: las cookies emitidas antes dejan de valer en este plazo.
    /// </summary>
    public TimeSpan SessionRevalidationInterval { get; init; } = TimeSpan.FromMinutes(5);

    /// <summary>Valor de <c>Provider</c> para las cuentas de ASP.NET Core Identity.</summary>
    public string CookieProviderKey { get; init; } = "aspnet-identity";

    // ---- Comun ----

    /// <summary>Origenes del navegador autorizados (CORS con credenciales + comprobacion de <c>Origin</c>). Sin comodines.</summary>
    public string[] AllowedOrigins { get; init; } = ["http://localhost:5173"];

    /// <summary>Cabecera personalizada que debe acompañar a toda request que modifica estado cuando la sesion es una cookie (defensa CSRF).</summary>
    public const string CsrfHeaderName = "X-Vectorify-Request";
}
