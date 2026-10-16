using System.Security.Claims;
using AuthPoc.Identity;
using Vectorify.Api.Users;

// El producto (M3.1-S02) tiene un VectorifyClaimTypes homonimo: aqui manda el del PoC.
using VectorifyClaimTypes = AuthPoc.Identity.VectorifyClaimTypes;

namespace AuthPoc.Users;

/// <summary>
/// Implementacion autenticada de <see cref="IUserContext"/> (la que M3.1-S02 registraria en
/// <c>UserContextRegistration</c>): lee un <see cref="ClaimsPrincipal"/> y NO sabe que proveedor lo autentico. El principal debe
/// traer una identidad interna (<see cref="VectorifyClaimTypes.InternalAuthenticationType"/>) con el claim
/// <see cref="VectorifyClaimTypes.InternalUserId"/> = <c>Users.Id</c>, que agrega el servidor DESPUES de mapear
/// (Provider, Subject) -&gt; <c>User.Id</c> (<see cref="UserProvisioningMiddleware"/>). Es sincrona y sin DB a proposito, igual que la
/// interfaz del producto: la resolucion contra la base ocurre una vez por request, antes, en el middleware.
/// </summary>
public sealed class AuthenticatedUserContext : IUserContext
{
    private readonly Func<ClaimsPrincipal?> _principal;

    /// <summary>Constructor para DI: el principal es el de la request en curso.</summary>
    public AuthenticatedUserContext(IHttpContextAccessor httpContextAccessor)
        : this(() => httpContextAccessor.HttpContext?.User)
    {
    }

    private AuthenticatedUserContext(Func<ClaimsPrincipal?> principal)
    {
        _principal = principal;
    }

    /// <summary>Contexto sobre un principal fijo (tests unitarios, tareas en segundo plano).</summary>
    public static AuthenticatedUserContext ForPrincipal(ClaimsPrincipal principal) => new(() => principal);

    public bool IsAuthenticated => TryGetUserId(out _);

    public string? Email
    {
        get
        {
            var principal = _principal();
            return principal?.FindFirst(ClaimTypes.Email)?.Value
                ?? principal?.Identities.SelectMany(i => i.FindAll("email")).FirstOrDefault()?.Value;
        }
    }

    public Guid GetEffectiveUserId() =>
        TryGetUserId(out var userId)
            ? userId
            : throw new UnauthenticatedUserException(
                "La request no tiene un usuario autenticado y resuelto (falta la identidad interna). " +
                "Los endpoints deben exigir autorizacion (401) antes de llegar aca.");

    private bool TryGetUserId(out Guid userId)
    {
        userId = Guid.Empty;
        var principal = _principal();
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

/// <summary>Se pidio el usuario efectivo sin identidad resuelta: es un error de cableado (faltó exigir autorizacion), nunca un caso de uso.</summary>
public sealed class UnauthenticatedUserException : InvalidOperationException
{
    public UnauthenticatedUserException(string message)
        : base(message)
    {
    }
}
