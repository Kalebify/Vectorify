using Microsoft.EntityFrameworkCore;
using Npgsql;
using Vectorify.Api.Data;

namespace Vectorify.Api.Users;

/// <summary>
/// Implementación de <see cref="IUserProvisioner"/> (del PoC de M3.1-S01, sobre el <see cref="VectorizationDbContext"/> del
/// producto). Camino rápido: una lectura por el índice único (Provider, Subject). Camino lento (primera vez): crea
/// <see cref="User"/> + <see cref="UserIdentity"/> en UNA sola <c>SaveChanges</c> (una transacción: o existen los dos o
/// ninguno); si dos requests simultáneas compiten, el índice único hace perder a una, que descarta lo suyo y relee el
/// <see cref="User"/> de la ganadora (sin duplicados ni usuarios huérfanos).
/// </summary>
public sealed class UserProvisioner : IUserProvisioner
{
    private const string UniqueViolation = "23505";
    private const string IdentityIndexName = "IX_user_identities_Provider_Subject";

    private static long _collisionsResolved;

    /// <summary>Cuántas veces una request perdió la carrera de creación y usó el User de la ganadora (observabilidad; los tests lo leen).</summary>
    public static long CollisionsResolved => Interlocked.Read(ref _collisionsResolved);

    private readonly VectorizationDbContext _db;
    private readonly TimeProvider _time;

    public UserProvisioner(VectorizationDbContext db, TimeProvider time)
    {
        _db = db;
        _time = time;
    }

    public async Task<ProvisionedUser> EnsureUserAsync(ExternalIdentity identity, CancellationToken cancellationToken)
    {
        var existing = await FindUserIdAsync(identity, cancellationToken);
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
        var link = new UserIdentity
        {
            Id = Guid.NewGuid(),
            Provider = identity.Provider,
            Subject = identity.Subject,
            UserId = user.Id,
            CreatedAt = now,
        };

        try
        {
            _db.Users.Add(user);
            _db.UserIdentities.Add(link);
            await _db.SaveChangesAsync(cancellationToken);
            return new ProvisionedUser(user.Id, Created: true);
        }
        catch (DbUpdateException ex) when (ex.InnerException is PostgresException { SqlState: UniqueViolation } pg
                                           && pg.ConstraintName == IdentityIndexName)
        {
            // Perdimos la carrera: otra request creó el vínculo primero. SaveChanges revirtió User y vínculo juntos;
            // solo se sueltan del tracker nuestros dos objetos (el contexto es scoped y puede tener otras entidades).
            _db.Entry(link).State = EntityState.Detached;
            _db.Entry(user).State = EntityState.Detached;
            Interlocked.Increment(ref _collisionsResolved);
        }

        var winner = await FindUserIdAsync(identity, cancellationToken)
            ?? throw new InvalidOperationException("El vínculo de identidad desapareció tras una colisión de índice único.");
        return new ProvisionedUser(winner, Created: false);
    }

    private Task<Guid?> FindUserIdAsync(ExternalIdentity identity, CancellationToken cancellationToken) =>
        _db.UserIdentities
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
