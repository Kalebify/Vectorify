using AuthPoc.Identity;
using AuthPoc.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Npgsql;
using Vectorify.Api.Data;

namespace AuthPoc.Users;

/// <summary>Resultado de <see cref="IUserProvisioner.EnsureUserAsync"/>.</summary>
public sealed record ProvisionedUser(Guid UserId, bool Created);

/// <summary>Mapea una identidad externa a un <c>User</c> local, creandolo la primera vez (JIT provisioning).</summary>
public interface IUserProvisioner
{
    /// <summary>Idempotente: la misma (Provider, Subject) siempre devuelve el mismo <c>User.Id</c>, aunque se repita o llegue en paralelo.</summary>
    Task<ProvisionedUser> EnsureUserAsync(ExternalIdentity identity, CancellationToken cancellationToken);
}

/// <summary>
/// Implementacion del PoC. Camino rapido: una lectura por el indice unico (Provider, Subject). Camino lento (primera vez): crea
/// <c>User</c> + <c>UserIdentity</c> en UNA transaccion; si dos requests simultaneas compiten, el indice unico hace perder a una,
/// que revierte su User y relee el de la ganadora (sin duplicados ni usuarios huerfanos).
/// </summary>
public sealed class UserProvisioner : IUserProvisioner
{
    private const string UniqueViolation = "23505";

    private static long _collisionsResolved;

    /// <summary>Cuantas veces una request perdio la carrera de creacion y uso el User de la ganadora (observabilidad; los tests lo leen).</summary>
    public static long CollisionsResolved => Interlocked.Read(ref _collisionsResolved);

    private readonly VectorizationDbContext _users;
    private readonly AuthPocDbContext _identities;
    private readonly TimeProvider _time;

    public UserProvisioner(VectorizationDbContext users, AuthPocDbContext identities, TimeProvider time)
    {
        _users = users;
        _identities = identities;
        _time = time;
    }

    public async Task<ProvisionedUser> EnsureUserAsync(ExternalIdentity identity, CancellationToken cancellationToken)
    {
        var existing = await FindUserIdAsync(_identities, identity, cancellationToken);
        if (existing is { } known)
        {
            return new ProvisionedUser(known, Created: false);
        }

        var now = _time.GetUtcNow();
        var user = new User
        {
            Id = Guid.NewGuid(),
            Email = identity.Email,
            DisplayName = ResolveDisplayName(identity),
            CreatedAt = now,
        };

        // Un solo DbConnection/transaccion para los dos contextos: o existen User y vinculo, o ninguno.
        var connection = _users.Database.GetDbConnection();
        await _users.Database.OpenConnectionAsync(cancellationToken);
        try
        {
            await using var transaction = await _users.Database.BeginTransactionAsync(cancellationToken);
            await using var linkContext = new AuthPocDbContext(
                new DbContextOptionsBuilder<AuthPocDbContext>().UseNpgsql(connection).Options);
            await linkContext.Database.UseTransactionAsync(transaction.GetDbTransaction(), cancellationToken);

            try
            {
                _users.Users.Add(user);
                await _users.SaveChangesAsync(cancellationToken);

                linkContext.UserIdentities.Add(new UserIdentity
                {
                    Id = Guid.NewGuid(),
                    Provider = identity.Provider,
                    Subject = identity.Subject,
                    UserId = user.Id,
                    CreatedAt = now,
                });
                await linkContext.SaveChangesAsync(cancellationToken);
                await transaction.CommitAsync(cancellationToken);
                return new ProvisionedUser(user.Id, Created: true);
            }
            catch (DbUpdateException ex) when (ex.InnerException is PostgresException { SqlState: UniqueViolation })
            {
                // Perdimos la carrera: otra request creo el vinculo primero. Se descarta lo nuestro y se usa lo suyo.
                await transaction.RollbackAsync(cancellationToken);
                _users.ChangeTracker.Clear();
                Interlocked.Increment(ref _collisionsResolved);
            }
        }
        finally
        {
            await _users.Database.CloseConnectionAsync();
        }

        var winner = await FindUserIdAsync(_identities, identity, cancellationToken)
            ?? throw new InvalidOperationException("El vinculo de identidad desaparecio tras una colision de indice unico.");
        return new ProvisionedUser(winner, Created: false);
    }

    private static Task<Guid?> FindUserIdAsync(AuthPocDbContext db, ExternalIdentity identity, CancellationToken cancellationToken) =>
        db.UserIdentities
            .AsNoTracking()
            .Where(x => x.Provider == identity.Provider && x.Subject == identity.Subject)
            .Select(x => (Guid?)x.UserId)
            .FirstOrDefaultAsync(cancellationToken);

    private static string ResolveDisplayName(ExternalIdentity identity)
    {
        if (!string.IsNullOrWhiteSpace(identity.DisplayName))
        {
            return identity.DisplayName.Trim();
        }

        var local = identity.Email?.Split('@')[0];
        return string.IsNullOrWhiteSpace(local) ? "Usuario" : local;
    }
}
