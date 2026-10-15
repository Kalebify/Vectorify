using System.Diagnostics.CodeAnalysis;
using System.Security.Claims;
using Vectorify.Api.Data;

namespace Vectorify.Api.Users;

/// <summary>Extrae una <see cref="ExternalIdentity"/> de un <see cref="ClaimsPrincipal"/> sin saber qué proveedor la produjo.</summary>
public static class ClaimsIdentityReader
{
    /// <param name="principal">Principal ya autenticado por el middleware de ASP.NET Core.</param>
    /// <param name="fallbackProvider">
    /// Proveedor a usar cuando el principal no trae <c>iss</c> (p. ej. ASP.NET Core Identity con cookie: el emisor es esta
    /// propia aplicación).
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

        // Tope defensivo: subject y emisor son claves de una tabla, no texto libre.
        if (string.IsNullOrWhiteSpace(subject) || subject.Length > UserIdentity.MaxSubjectLength
            || string.IsNullOrWhiteSpace(provider) || provider.Length > UserIdentity.MaxProviderLength)
        {
            return false;
        }

        var email = First("email", ClaimTypes.Email);
        var name = First("name", ClaimTypes.Name);
        identity = new ExternalIdentity(provider, subject, email, name);
        return true;
    }
}
