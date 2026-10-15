namespace Vectorify.Api.Users;

/// <summary>Resultado de <see cref="IUserProvisioner.EnsureUserAsync"/>.</summary>
public sealed record ProvisionedUser(Guid UserId, bool Created);

/// <summary>Mapea una identidad externa a un <c>User</c> local, creándolo la primera vez (provisión JIT).</summary>
public interface IUserProvisioner
{
    /// <summary>
    /// Idempotente: la misma (Provider, Subject) siempre devuelve el mismo <c>User.Id</c>, aunque se repita o llegue en
    /// paralelo. Transaccional: o existen <c>User</c> y vínculo, o ninguno.
    /// </summary>
    Task<ProvisionedUser> EnsureUserAsync(ExternalIdentity identity, CancellationToken cancellationToken);
}
