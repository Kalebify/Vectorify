namespace Vectorify.Api.Data;

/// <summary>
/// Vínculo (Provider, Subject) -&gt; <see cref="User"/> (M3.1-S02, ADR docs/ADR_AUTH_MVP31.md, «Modelo definitivo del
/// vínculo de identidad»). Una persona de un proveedor = UN <see cref="User"/>: el par es único (índice único) y es lo
/// que hace idempotente y correcta bajo concurrencia la resolución de identidad (<c>IUserProvisioner</c>).
/// El email NO es identidad (T14 del ADR): dos proveedores con el mismo email no se funden solos.
/// </summary>
public sealed class UserIdentity
{
    /// <summary>Máximo de <see cref="Provider"/> (columna y validación del claim de entrada).</summary>
    public const int MaxProviderLength = 512;

    /// <summary>Máximo de <see cref="Subject"/> (columna y validación del claim de entrada).</summary>
    public const int MaxSubjectLength = 255;

    public Guid Id { get; set; }

    public Guid UserId { get; set; }

    public User? User { get; set; }

    /// <summary>Emisor: claim <c>iss</c> (OIDC) o <c>aspnet-identity</c> (cuentas propias). Máx. <see cref="MaxProviderLength"/>.</summary>
    public string Provider { get; set; } = string.Empty;

    /// <summary>Identificador estable de la persona dentro del proveedor (<c>sub</c> / <c>AspNetUsers.Id</c>). Nunca el email. Máx. <see cref="MaxSubjectLength"/>.</summary>
    public string Subject { get; set; } = string.Empty;

    public DateTimeOffset CreatedAt { get; set; }
}
