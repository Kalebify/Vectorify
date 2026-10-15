using Microsoft.EntityFrameworkCore;
using Npgsql;
using Vectorify.Api.Data;
using Vectorify.Api.Tests.TestSupport;
using Vectorify.Api.Users;

namespace Vectorify.Api.Tests.Users;

/// <summary>
/// <see cref="UserProvisioner"/> (M3.1-S02) contra PostgreSQL real: resolución (Provider, Subject) -&gt; <c>User</c> idempotente,
/// transaccional y correcta con peticiones concurrentes; el índice único como invariante; y que el email NO es identidad (T14).
/// </summary>
public sealed class UserProvisionerTests : IClassFixture<AuthApiFixture>, IAsyncLifetime
{
    private readonly AuthApiFixture _fixture;
    private string _connectionString = string.Empty;

    public UserProvisionerTests(AuthApiFixture fixture)
    {
        _fixture = fixture;
    }

    public async Task InitializeAsync()
    {
        _connectionString = await _fixture.CreateDatabaseAsync();
        await using var db = AuthApiFixture.CreateDomainContext(_connectionString);
        await db.Database.MigrateAsync();
    }

    public Task DisposeAsync() => Task.CompletedTask;

    [Fact]
    public async Task NewIdentity_CreatesTheUserAndTheLinkTogether_CopyingEmailAndNameFromTheIdentity()
    {
        var identity = NewIdentity(email: "ana.perez@vectorify.test");

        var result = await EnsureAsync(identity);

        Assert.True(result.Created);
        await using var db = AuthApiFixture.CreateDomainContext(_connectionString);
        var user = await db.Users.Include(u => u.Identities).SingleAsync(u => u.Id == result.UserId);
        Assert.Equal("ana.perez@vectorify.test", user.Email);
        Assert.Equal("ana.perez", user.DisplayName);
        Assert.True(user.CreatedAt > DateTimeOffset.UtcNow.AddMinutes(-1));
        var link = Assert.Single(user.Identities);
        Assert.Equal((identity.Provider, identity.Subject), (link.Provider, link.Subject));
        Assert.True(link.CreatedAt > DateTimeOffset.UtcNow.AddMinutes(-1));
    }

    [Fact]
    public async Task ProvidedDisplayName_WinsOverTheEmailLocalPart_AndMissingBothFallsBackToAGenericName()
    {
        var named = await EnsureAsync(NewIdentity(email: "x@vectorify.test", name: "  Ana Pérez  "));
        var anonymous = await EnsureAsync(NewIdentity(email: null));

        await using var db = AuthApiFixture.CreateDomainContext(_connectionString);
        Assert.Equal("Ana Pérez", (await db.Users.SingleAsync(u => u.Id == named.UserId)).DisplayName);
        var generic = await db.Users.SingleAsync(u => u.Id == anonymous.UserId);
        Assert.Equal("Usuario", generic.DisplayName);
        Assert.Null(generic.Email);
    }

    [Fact]
    public async Task RepeatedResolution_IsIdempotent_ReturnsTheSameUser_AndDoesNotCreateRows()
    {
        var identity = NewIdentity();
        var first = await EnsureAsync(identity);

        var again = new List<ProvisionedUser>();
        for (var i = 0; i < 3; i++)
        {
            again.Add(await EnsureAsync(identity));
        }

        Assert.True(first.Created);
        Assert.All(again, r =>
        {
            Assert.False(r.Created);
            Assert.Equal(first.UserId, r.UserId);
        });
        Assert.Equal(1, await CountLinksAsync(identity));
        Assert.Equal(1, await CountUsersByEmailAsync(identity.Email!));
    }

    [Fact]
    public async Task AnAlreadyLinkedIdentity_ResolvesToItsExistingUser_WithoutCreatingAnother()
    {
        var existingUserId = Guid.NewGuid();
        var identity = NewIdentity();
        await using (var db = AuthApiFixture.CreateDomainContext(_connectionString))
        {
            db.Users.Add(new User { Id = existingUserId, Email = "previo@vectorify.test", DisplayName = "Previo", CreatedAt = DateTimeOffset.UtcNow });
            db.UserIdentities.Add(new UserIdentity
            {
                Id = Guid.NewGuid(), UserId = existingUserId, Provider = identity.Provider, Subject = identity.Subject, CreatedAt = DateTimeOffset.UtcNow,
            });
            await db.SaveChangesAsync();
        }

        var usersBefore = await CountAllUsersAsync();
        var result = await EnsureAsync(identity);

        Assert.False(result.Created);
        Assert.Equal(existingUserId, result.UserId);
        Assert.Equal(usersBefore, await CountAllUsersAsync());
    }

    [Fact]
    public async Task TwelveConcurrentRequestsForTheSameIdentity_CreateOneUser_AndLeaveNoOrphans()
    {
        var identity = NewIdentity();
        using var barrier = new Barrier(12);

        var results = await Task.WhenAll(Enumerable.Range(0, 12).Select(_ => Task.Run(async () =>
        {
            barrier.SignalAndWait();
            return await EnsureAsync(identity);
        })));

        Assert.Single(results.Select(r => r.UserId).Distinct());
        Assert.Equal(1, results.Count(r => r.Created)); // exactamente una ganó la carrera
        Assert.Equal(1, await CountLinksAsync(identity));
        Assert.Equal(1, await CountUsersByEmailAsync(identity.Email!));
        Assert.Equal(0, await CountOrphansByEmailAsync(identity.Email!));
    }

    [Fact]
    public async Task ManyIdentitiesInParallel_CreateOneUserEach_AndNoOrphans()
    {
        var identities = Enumerable.Range(0, 5).Select(_ => NewIdentity()).ToArray();
        using var barrier = new Barrier(identities.Length * 6);

        var results = await Task.WhenAll(identities.SelectMany(identity => Enumerable.Range(0, 6).Select(_ => Task.Run(async () =>
        {
            barrier.SignalAndWait();
            return (identity, result: await EnsureAsync(identity));
        }))));

        foreach (var identity in identities)
        {
            var mine = results.Where(r => r.identity == identity).ToArray();
            Assert.Single(mine.Select(r => r.result.UserId).Distinct());
            Assert.Equal(1, mine.Count(r => r.result.Created));
            Assert.Equal(1, await CountUsersByEmailAsync(identity.Email!));
            Assert.Equal(0, await CountOrphansByEmailAsync(identity.Email!));
        }

        Assert.Equal(identities.Length, results.Select(r => r.result.UserId).Distinct().Count());
    }

    [Fact]
    public async Task ARejectedWrite_LeavesNeitherUserNorLink_BecauseItIsOneTransaction()
    {
        // Subject de 256 caracteres: el vínculo no cabe en varchar(255), el INSERT falla DESPUÉS de que se agregara el User al lote.
        var identity = new ExternalIdentity("aspnet-identity", new string('s', UserIdentity.MaxSubjectLength + 1), "rollback@vectorify.test", null);

        await Assert.ThrowsAnyAsync<DbUpdateException>(() => EnsureAsync(identity));

        Assert.Equal(0, await CountUsersByEmailAsync("rollback@vectorify.test"));
    }

    [Fact]
    public async Task TheSameSubjectUnderADifferentProvider_IsADifferentPerson()
    {
        var subject = Guid.NewGuid().ToString();

        var local = await EnsureAsync(new ExternalIdentity("aspnet-identity", subject, "a@vectorify.test", null));
        var external = await EnsureAsync(new ExternalIdentity("https://idp.vectorify.test", subject, "b@vectorify.test", null));

        Assert.NotEqual(local.UserId, external.UserId);
    }

    [Fact]
    public async Task TheEmailIsNotIdentity_TheSameEmailWithADifferentSubjectIsADifferentUser()
    {
        var email = $"mismo-{Guid.NewGuid():N}@vectorify.test";

        var first = await EnsureAsync(new ExternalIdentity("aspnet-identity", Guid.NewGuid().ToString(), email, null));
        var second = await EnsureAsync(new ExternalIdentity("aspnet-identity", Guid.NewGuid().ToString(), email, null));

        Assert.NotEqual(first.UserId, second.UserId);
        Assert.Equal(2, await CountUsersByEmailAsync(email));
    }

    [Fact]
    public async Task TheDatabase_EnforcesUniqueProviderAndSubject_EvenForDirectInserts()
    {
        var identity = NewIdentity();
        var owner = await EnsureAsync(identity);
        await using var db = AuthApiFixture.CreateDomainContext(_connectionString);
        var intruder = new User { Id = Guid.NewGuid(), DisplayName = "Intruso", CreatedAt = DateTimeOffset.UtcNow };
        db.Users.Add(intruder);
        db.UserIdentities.Add(new UserIdentity
        {
            Id = Guid.NewGuid(), UserId = intruder.Id, Provider = identity.Provider, Subject = identity.Subject, CreatedAt = DateTimeOffset.UtcNow,
        });

        var failure = await Assert.ThrowsAsync<DbUpdateException>(() => db.SaveChangesAsync());

        var pg = Assert.IsType<PostgresException>(failure.InnerException);
        Assert.Equal("23505", pg.SqlState);
        Assert.Equal("IX_user_identities_Provider_Subject", pg.ConstraintName);
        Assert.Equal(owner.UserId, (await EnsureAsync(identity)).UserId);
    }

    [Fact]
    public async Task DeletingAUser_RemovesItsIdentityLinks()
    {
        var identity = NewIdentity();
        var result = await EnsureAsync(identity);

        await using (var db = AuthApiFixture.CreateDomainContext(_connectionString))
        {
            db.Users.Remove(await db.Users.SingleAsync(u => u.Id == result.UserId));
            await db.SaveChangesAsync();
        }

        Assert.Equal(0, await CountLinksAsync(identity));
    }

    // -------------------------------------------------------------------------------------------------------------

    private static ExternalIdentity NewIdentity(string? email = "default", string? name = null) =>
        new("aspnet-identity", Guid.NewGuid().ToString(), email == "default" ? $"u-{Guid.NewGuid():N}@vectorify.test" : email, name);

    /// <summary>Cada llamada usa su propio DbContext (como cada request tiene su scope).</summary>
    private async Task<ProvisionedUser> EnsureAsync(ExternalIdentity identity)
    {
        await using var db = AuthApiFixture.CreateDomainContext(_connectionString);
        return await new UserProvisioner(db, TimeProvider.System).EnsureUserAsync(identity, CancellationToken.None);
    }

    private Task<long> CountLinksAsync(ExternalIdentity identity) =>
        _fixture.ScalarAsync<long>(
            _connectionString,
            "SELECT count(*) FROM user_identities WHERE \"Provider\" = @p AND \"Subject\" = @s",
            ("p", identity.Provider), ("s", identity.Subject));

    private Task<long> CountUsersByEmailAsync(string email) =>
        _fixture.ScalarAsync<long>(_connectionString, "SELECT count(*) FROM users WHERE \"Email\" = @e", ("e", email));

    private Task<long> CountOrphansByEmailAsync(string email) =>
        _fixture.ScalarAsync<long>(
            _connectionString,
            "SELECT count(*) FROM users u WHERE u.\"Email\" = @e AND NOT EXISTS (SELECT 1 FROM user_identities i WHERE i.\"UserId\" = u.\"Id\")",
            ("e", email));

    private Task<long> CountAllUsersAsync() => _fixture.ScalarAsync<long>(_connectionString, "SELECT count(*) FROM users");
}
