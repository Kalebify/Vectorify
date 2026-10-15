using System.Security.Claims;

namespace Vectorify.Api.Users;

/// <summary>Claims propios de VECTORiZE (nunca vienen del proveedor).</summary>
public static class VectorifyClaimTypes
{
    /// <summary>Id interno (<c>Users.Id</c>) del usuario. Lo agrega SOLO el servidor, en una identidad propia.</summary>
    public const string InternalUserId = "vectorify:uid";

    /// <summary>
    /// <see cref="ClaimsIdentity.AuthenticationType"/> de la identidad que lleva <see cref="InternalUserId"/>.
    /// <see cref="AuthenticatedUserContext"/> SOLO lee el claim de esa identidad: una cookie o un token del proveedor que
    /// traiga un claim con el mismo nombre no puede suplantar a otro usuario (T13 del ADR).
    /// </summary>
    public const string InternalAuthenticationType = "Vectorify.Internal";

    /// <summary>Valor de <c>Provider</c> de las cuentas propias de ASP.NET Core Identity.</summary>
    public const string AspNetIdentityProvider = "aspnet-identity";
}
