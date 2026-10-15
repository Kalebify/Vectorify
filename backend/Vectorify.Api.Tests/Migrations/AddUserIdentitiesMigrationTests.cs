using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql;
using Vectorify.Api.Data;
using Vectorify.Api.Data.Auth;
using Vectorify.Api.Tests.TestSupport;

namespace Vectorify.Api.Tests.Migrations;

/// <summary>
/// Migraciones de M3.1-S02 contra PostgreSQL real (Testcontainers): <c>AddUserIdentities</c> (dominio) y <c>InitialIdentity</c>
/// (esquema <c>auth</c>, historial propio). Ambas son reversibles: Up crea lo esperado (índice único (Provider, Subject), FK con
/// cascada), Down lo retira sin tocar el resto y volver a subir funciona.
/// </summary>
public sealed class AddUserIdentitiesMigrationTests : IClassFixture<AuthApiFixture>
{
    private const string Migration = "20261015221543_AddUserIdentities";
    private const string Previous = "20261004100837_AddProjectClassicTriple";
    private const string IdentityMigration = "20261015221638_InitialIdentity";

    private readonly AuthApiFixture _fixture;

    public AddUserIdentitiesMigrationTests(AuthApiFixture fixture)
    {
        _fixture = fixture;
    }

    [Fact]
    public async Task Up_CreatesTheTableWithTheUniqueProviderSubjectIndex_AndACascadingForeignKey()
    {
        var connectionString = await _fixture.CreateDatabaseAsync();
        await using var db = AuthApiFixture.CreateDomainContext(connectionString);
        var migrator = db.GetService<IMigrator>();
        await migrator.MigrateAsync(Previous);
        Assert.False(await TableExistsAsync(connectionString, "public", "user_identities"));

        await migrator.MigrateAsync(Migration);

        Assert.Equal(Migration, (await db.Database.GetAppliedMigrationsAsync()).Last());
        Assert.True(await TableExistsAsync(connectionString, "public", "user_identities"));
        var uniqueIndex = await _fixture.ScalarAsync<string>(
            connectionString,
            "SELECT indexdef FROM pg_indexes WHERE tablename = 'user_identities' AND indexname = 'IX_user_identities_Provider_Subject'");
        Assert.Contains("UNIQUE", uniqueIndex);
        Assert.Contains("(\"Provider\", \"Subject\")", uniqueIndex);
        Assert.Equal(1, await _fixture.ScalarAsync<long>(
            connectionString, "SELECT count(*) FROM pg_indexes WHERE tablename = 'user_identities' AND indexname = 'IX_user_identities_UserId'"));
        Assert.Equal("c", await _fixture.ScalarAsync<string>(
            connectionString, "SELECT confdeltype::text FROM pg_constraint WHERE conname = 'FK_user_identities_users_UserId'")); // c = CASCADE
        Assert.Equal(512, await _fixture.ScalarAsync<int>(
            connectionString, "SELECT character_maximum_length FROM information_schema.columns WHERE table_name = 'user_identities' AND column_name = 'Provider'"));
        Assert.Equal(255, await _fixture.ScalarAsync<int>(
            connectionString, "SELECT character_maximum_length FROM information_schema.columns WHERE table_name = 'user_identities' AND column_name = 'Subject'"));
    }

    [Fact]
    public async Task TheUniqueIndex_RejectsADuplicateProviderSubject_AtTheDatabaseLevel()
    {
        var connectionString = await _fixture.CreateDatabaseAsync();
        await using var db = AuthApiFixture.CreateDomainContext(connectionString);
        await db.Database.MigrateAsync();
        var first = Guid.NewGuid();
        var second = Guid.NewGuid();
        await db.Database.ExecuteSqlInterpolatedAsync(
            $"""INSERT INTO "users" ("Id", "DisplayName", "CreatedAt") VALUES ({first}, 'A', now()), ({second}, 'B', now())""");
        await db.Database.ExecuteSqlInterpolatedAsync(
            $"""INSERT INTO "user_identities" ("Id", "UserId", "Provider", "Subject", "CreatedAt") VALUES ({Guid.NewGuid()}, {first}, 'aspnet-identity', 's1', now())""");

        var duplicate = await Record.ExceptionAsync(() => db.Database.ExecuteSqlInterpolatedAsync(
            $"""INSERT INTO "user_identities" ("Id", "UserId", "Provider", "Subject", "CreatedAt") VALUES ({Guid.NewGuid()}, {second}, 'aspnet-identity', 's1', now())"""));
        var otherProvider = await Record.ExceptionAsync(() => db.Database.ExecuteSqlInterpolatedAsync(
            $"""INSERT INTO "user_identities" ("Id", "UserId", "Provider", "Subject", "CreatedAt") VALUES ({Guid.NewGuid()}, {second}, 'https://idp.test', 's1', now())"""));

        Assert.Equal("23505", Assert.IsType<PostgresException>(duplicate).SqlState);
        Assert.Null(otherProvider); // el mismo subject en OTRO proveedor es otra persona
    }

    [Fact]
    public async Task Down_DropsOnlyTheNewTable_KeepsTheUsers_AndUpCanBeReapplied()
    {
        var connectionString = await _fixture.CreateDatabaseAsync();
        await using var db = AuthApiFixture.CreateDomainContext(connectionString);
        var migrator = db.GetService<IMigrator>();
        await migrator.MigrateAsync(Migration);
        var userId = Guid.NewGuid();
        await db.Database.ExecuteSqlInterpolatedAsync($"""INSERT INTO "users" ("Id", "DisplayName", "CreatedAt") VALUES ({userId}, 'Persistente', now())""");
        await db.Database.ExecuteSqlInterpolatedAsync(
            $"""INSERT INTO "user_identities" ("Id", "UserId", "Provider", "Subject", "CreatedAt") VALUES ({Guid.NewGuid()}, {userId}, 'aspnet-identity', 'x', now())""");

        await migrator.MigrateAsync(Previous); // Down

        Assert.Equal(Previous, (await db.Database.GetAppliedMigrationsAsync()).Last());
        Assert.False(await TableExistsAsync(connectionString, "public", "user_identities"));
        Assert.Equal(1, await _fixture.ScalarAsync<long>(connectionString, "SELECT count(*) FROM users WHERE \"Id\" = @u", ("u", userId)));

        await migrator.MigrateAsync(Migration); // Up otra vez
        Assert.True(await TableExistsAsync(connectionString, "public", "user_identities"));
        Assert.False(db.Database.HasPendingModelChanges());
    }

    [Fact]
    public async Task AuthMigration_CreatesTheIdentityTablesInTheAuthSchema_WithItsOwnHistoryTable()
    {
        var connectionString = await _fixture.CreateDatabaseAsync();
        await using var domain = AuthApiFixture.CreateDomainContext(connectionString);
        await domain.Database.MigrateAsync();
        await using var auth = AuthApiFixture.CreateAuthContext(connectionString);

        await auth.Database.MigrateAsync();

        Assert.Equal([IdentityMigration], await auth.Database.GetAppliedMigrationsAsync());
        foreach (var table in new[] { "AspNetUsers", "AspNetRoles", "AspNetUserRoles", "AspNetUserClaims", "AspNetUserLogins", "AspNetUserTokens", "AspNetRoleClaims" })
        {
            Assert.True(await TableExistsAsync(connectionString, "auth", table), $"falta auth.{table}");
            Assert.False(await TableExistsAsync(connectionString, "public", table), $"public.{table} no debe existir");
        }

        // Historial propio: auth.__EFMigrationsHistory solo con la migración de Identity; el del dominio, intacto en public.
        Assert.True(await TableExistsAsync(connectionString, "auth", "__EFMigrationsHistory"));
        Assert.Equal(1, await _fixture.ScalarAsync<long>(connectionString, "SELECT count(*) FROM auth.\"__EFMigrationsHistory\""));
        Assert.Equal(0, await _fixture.ScalarAsync<long>(
            connectionString, "SELECT count(*) FROM public.\"__EFMigrationsHistory\" WHERE \"MigrationId\" = @m", ("m", IdentityMigration)));
        Assert.Equal(Migration, (await domain.Database.GetAppliedMigrationsAsync()).Last());

        // Índices únicos de Identity que sostienen "un correo = una cuenta".
        Assert.True(await _fixture.ScalarAsync<bool>(
            connectionString,
            "SELECT indexdef LIKE '%UNIQUE%' FROM pg_indexes WHERE schemaname = 'auth' AND indexname = 'UserNameIndex'"));
        Assert.False(auth.Database.HasPendingModelChanges());
    }

    [Fact]
    public async Task AuthMigration_Down_RemovesTheIdentityTables_AndUpCanBeReapplied()
    {
        var connectionString = await _fixture.CreateDatabaseAsync();
        await using var domain = AuthApiFixture.CreateDomainContext(connectionString);
        await domain.Database.MigrateAsync();
        await using var auth = AuthApiFixture.CreateAuthContext(connectionString);
        var migrator = auth.GetService<IMigrator>();
        await migrator.MigrateAsync(IdentityMigration);

        await migrator.MigrateAsync("0"); // Down completo

        Assert.Empty(await auth.Database.GetAppliedMigrationsAsync());
        Assert.False(await TableExistsAsync(connectionString, "auth", "AspNetUsers"));
        Assert.True(await TableExistsAsync(connectionString, "public", "users")); // el dominio no se toca

        await migrator.MigrateAsync(IdentityMigration);
        Assert.True(await TableExistsAsync(connectionString, "auth", "AspNetUsers"));
    }

    [Fact]
    public async Task BothContexts_MigratedOnTheSameDatabase_DoNotInterfereWithEachOther()
    {
        var connectionString = await _fixture.CreateDatabaseAsync();
        await using var auth = AuthApiFixture.CreateAuthContext(connectionString); // primero Identity (no depende del dominio)
        await using var domain = AuthApiFixture.CreateDomainContext(connectionString);

        await auth.Database.MigrateAsync();
        await domain.Database.MigrateAsync();

        Assert.Empty(await auth.Database.GetPendingMigrationsAsync());
        Assert.Empty(await domain.Database.GetPendingMigrationsAsync());
        Assert.DoesNotContain(IdentityMigration, await domain.Database.GetAppliedMigrationsAsync());
        Assert.DoesNotContain(Migration, await auth.Database.GetAppliedMigrationsAsync());
    }

    private Task<bool> TableExistsAsync(string connectionString, string schema, string table) =>
        _fixture.ScalarAsync<bool>(
            connectionString,
            "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = @s AND table_name = @t)",
            ("s", schema), ("t", table));
}
