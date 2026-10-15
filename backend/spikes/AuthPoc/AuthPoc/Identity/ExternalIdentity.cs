using System.Diagnostics.CodeAnalysis;
using System.Security.Claims;

namespace AuthPoc.Identity;

/// <summary>
/// Identidad EXTERNA ya autenticada, normalizada e independiente de quien la haya autenticado (un emisor OIDC gestionado,
/// ASP.NET Core Identity con cookie, ...). Es lo unico que el resto del PoC sabe del proveedor: el par
/// (<see cref="Provider"/>, <see cref="Subject"/>) identifica a la persona en el proveedor y se mapea a un
/// <c>User.Id</c> interno (ver <see cref="Users.IUserProvisioner"/>).
/// </summary>
public sealed record ExternalIdentity(string Provider, string Subject, string? Email, string? DisplayName);

/// <summary>Claims propios de VECTORiZE (nunca vienen del proveedor).</summary>
public static class VectorifyClaimTypes
{
    /// <summary>Id interno (<c>Users.Id</c>) del usuario. Lo agrega SOLO el servidor, en una identidad propia.</summary>
    public const string InternalUserId = "vectorify:uid";

    /// <summary>
    /// <see cref="ClaimsIdentity.AuthenticationType"/> de la identidad que lleva <see cref="InternalUserId"/>.
    /// <see cref="Users.AuthenticatedUserContext"/> SOLO lee el claim de esa identidad: un token emitido por el
    /// proveedor que traiga un claim con el mismo nombre no puede suplantar a otro usuario.
    /// </summary>
    public const string InternalAuthenticationType = "Vectorify.Internal";
}

/// <summary>Extrae una <see cref="ExternalIdentity"/> de un <see cref="ClaimsPrincipal"/> sin saber que proveedor la produjo.</summary>
public static class ClaimsIdentityReader
{
    /// <summary>Tope defensivo: el subject y el emisor son claves de una tabla, no texto libre.</summary>
    public const int MaxSubjectLength = 255;

    public const int MaxProviderLength = 512;

    /// <param name="principal">Principal ya autenticado por el middleware de ASP.NET Core.</param>
    /// <param name="fallbackProvider">
    /// Proveedor a usar cuando el principal no trae <c>iss</c> (p. ej. ASP.NET Core Identity con cookie: el emisor es esta
    /// propia aplicacion).
    /// </param>
    /// <param name="identity">Identidad normalizada, o null si el principal no es autenticado o no trae un subject utilizable.</param>
    public static bool TryRead(
        ClaimsPrincipal principal, string fallbackProvider, [NotNullWhen(true)] out ExternalIdentity? identity)
    {
        identity = null;

        if (principal.Identity?.IsAuthenticated != true)
        {
            return false;
        }

        // Se leen los claims de identidades NO internas: la identidad "Vectorify.Internal" la crea el servidor.
        var external = principal.Identities
            .Where(i => i.AuthenticationType != VectorifyClaimTypes.InternalAuthenticationType)
            .ToList();

        string? First(params string[] types) =>
            external
                .SelectMany(i => types.SelectMany(t => i.FindAll(t)))
                .Select(c => c.Value)
                .FirstOrDefault(v => !string.IsNullOrWhiteSpace(v));

        var subject = First("sub", ClaimTypes.NameIdentifier);
        var provider = First("iss") ?? fallbackProvider;

        if (string.IsNullOrWhiteSpace(subject) || subject.Length > MaxSubjectLength
            || string.IsNullOrWhiteSpace(provider) || provider.Length > MaxProviderLength)
        {
            return false;
        }

        var email = First("email", ClaimTypes.Email);
        var name = First("name", ClaimTypes.Name);
        identity = new ExternalIdentity(provider, subject, email, name);
        return true;
    }
}
