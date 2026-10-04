using Microsoft.EntityFrameworkCore;
using Testcontainers.PostgreSql;
using Vectorify.Api.Data;
using Vectorify.Api.Options;
using Vectorify.Api.Users;

namespace Vectorify.Api.Tests.Users;

/// <summary>
/// <see cref="DevelopmentUserSeeder"/> (M2.2-S09) contra PostgreSQL real (Testcontainers, nunca
/// InMemory): seed reproducible con los defaults, idempotente, conservador con un usuario ya
/// existente y configurable por <see cref="DevelopmentUserOptions"/>.
/// </summary>
public sealed class DevelopmentUserSeederTests : IAsyncLifetime
{
    private readonly PostgreSqlContainer _postgres = new PostgreSqlBuilder("postgres:17-alpine").Build();

    public async Task InitializeAsync()
    {
        await _postgres.StartAsync();
        await using var dbContext = CreateDbContext();
        await dbContext.Database.MigrateAsync();
    }

    public Task DisposeAsync() => _postgres.DisposeAsync().AsTask();

    [Fact]
    public async Task EnsureSeededAsync_WithDefaults_CreatesTheOriginalFixedDevUser()
    {
        await using var dbContext = CreateDbContext();

        await DevelopmentUserSeeder.EnsureSeededAsync(dbContext, new DevelopmentUserOptions());

        var user = await dbContext.Users.SingleAsync();
        Assert.Equal(Guid.Parse("00000000-0000-0000-0000-000000000001"), user.Id);
        Assert.Equal("dev@vectorify.local", user.Email);
        Assert.Equal("Dev User", user.DisplayName);
    }

    [Fact]
    public async Task EnsureSeededAsync_CalledTwice_IsIdempotent()
    {
        await using var dbContext = CreateDbContext();
        var options = new DevelopmentUserOptions();

        await DevelopmentUserSeeder.EnsureSeededAsync(dbContext, options);
        await DevelopmentUserSeeder.EnsureSeededAsync(dbContext, options);

        Assert.Equal(1, await dbContext.Users.CountAsync());
    }

    [Fact]
    public async Task EnsureSeededAsync_WhenTheUserAlreadyExists_DoesNotOverwriteIt()
    {
        await using var dbContext = CreateDbContext();
        await DevelopmentUserSeeder.EnsureSeededAsync(dbContext, new DevelopmentUserOptions());
        var user = await dbContext.Users.SingleAsync();
        user.DisplayName = "Editado a mano";
        user.Email = "editado@vectorify.local";
        await dbContext.SaveChangesAsync();

        await using var otherContext = CreateDbContext();
        await DevelopmentUserSeeder.EnsureSeededAsync(otherContext, new DevelopmentUserOptions { DisplayName = "Otro nombre" });

        await using var readContext = CreateDbContext();
        var reloaded = await readContext.Users.SingleAsync();
        Assert.Equal("Editado a mano", reloaded.DisplayName);
        Assert.Equal("editado@vectorify.local", reloaded.Email);
    }

    [Fact]
    public async Task EnsureSeededAsync_WithAnotherConfiguredUserId_SeedsAnotherUser()
    {
        await using var dbContext = CreateDbContext();
        var otherUserId = Guid.NewGuid();

        await DevelopmentUserSeeder.EnsureSeededAsync(dbContext, new DevelopmentUserOptions());
        await DevelopmentUserSeeder.EnsureSeededAsync(
            dbContext, new DevelopmentUserOptions { UserId = otherUserId, Email = "b@vectorify.local", DisplayName = "Usuario B" });

        Assert.Equal(2, await dbContext.Users.CountAsync());
        var other = await dbContext.Users.SingleAsync(u => u.Id == otherUserId);
        Assert.Equal("b@vectorify.local", other.Email);
        Assert.Equal("Usuario B", other.DisplayName);
    }

    private VectorizationDbContext CreateDbContext()
    {
        var options = new DbContextOptionsBuilder<VectorizationDbContext>()
            .UseNpgsql(_postgres.GetConnectionString())
            .Options;
        return new VectorizationDbContext(options);
    }
}
