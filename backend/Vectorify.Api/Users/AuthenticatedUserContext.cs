using System.Security.Claims;

namespace Vectorify.Api.Users;

/// <summary>
/// Implementación autenticada de <see cref="IUserContext"/> (M3.1-S02; ADR D2): lee un <see cref="ClaimsPrincipal"/> y NO
/// sabe qué proveedor lo autenticó. El principal debe traer una identidad interna
/// (<see cref="VectorifyClaimTypes.InternalAuthenticationType"/>) con el claim <see cref="VectorifyClaimTypes.InternalUserId"/>
/// = <c>Users.Id</c>, que agrega el servidor DESPUÉS de mapear (Provider, Subject) -&gt; <c>User.Id</c>
/// (<see cref="UserProvisioningMiddleware"/>). Es síncrona y sin DB a propósito, igual que la interfaz: la resolución
/// contra la base ocurre una vez por request, antes, en el middleware.
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
                "Los endpoints deben exigir autorización (401) antes de llegar acá.");

    private bool TryGetUserId(out Guid userId) => InternalIdentityReader.TryGetUserId(_principal(), out userId);
}

/// <summary>Se pidió el usuario efectivo sin identidad resuelta: es un error de cableado (faltó exigir autorización), nunca un caso de uso.</summary>
public sealed class UnauthenticatedUserException : InvalidOperationException
{
    public UnauthenticatedUserException(string message)
        : base(message)
    {
    }
}
