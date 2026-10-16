using System.Security.Claims;

namespace Vectorify.Api.Users;

/// <summary>
/// Lee el <c>Users.Id</c> interno de un <see cref="ClaimsPrincipal"/> (M3.1-S03). SOLO mira la identidad propia
/// (<see cref="VectorifyClaimTypes.InternalAuthenticationType"/>) que agrega <see cref="UserProvisioningMiddleware"/> después de
/// mapear (Provider, Subject): un claim con el mismo nombre dentro de la cookie o del token del proveedor se ignora (T13 del ADR).
/// </summary>
public static class InternalIdentityReader
{
    public static bool TryGetUserId(ClaimsPrincipal? principal, out Guid userId)
    {
        userId = Guid.Empty;
        if (principal?.Identity?.IsAuthenticated != true)
        {
            return false;
        }

        var raw = principal.Identities
            .Where(i => i.AuthenticationType == VectorifyClaimTypes.InternalAuthenticationType && i.IsAuthenticated)
            .Select(i => i.FindFirst(VectorifyClaimTypes.InternalUserId)?.Value)
            .FirstOrDefault(v => v is not null);

        return Guid.TryParse(raw, out userId) && userId != Guid.Empty;
    }
}
