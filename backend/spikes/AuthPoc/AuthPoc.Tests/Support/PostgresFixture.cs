using AuthPoc.Persistence;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using Testcontainers.PostgreSql;
using Vectorify.Api.Data;

namespace AuthPoc.Tests.Support;

[CollectionDefinition(Name)]
public sealed class PostgresCollection : ICollectionFixture<PostgresFixture>
{
    public const string Name = "AuthPoc postgres";
}

/// <summary>
/// UN Postgres real y efimero (Testcontainers, nunca InMemory: igual que los tests del producto) para todo el spike: migraciones
/// reales del producto + esquema <c>poc_auth</c> del spike. Los tests aislan sus datos con subjects/correos aleatorios.
/// </summary>
public sealed class PostgresFixture : IAsyncLifetime
{
    private readonly PostgreSqlContainer _postgres = new PostgreSqlBuilder("postgres:17-alpine").Build();

    public string ConnectionString => _postgres.GetConnectionString();

    public async Task InitializeAsync()
    {
        await _postgres.StartAsync();

        var options = new DbContextOptionsBuilder<VectorizationDbContext>().UseNpgsql(ConnectionString).Options;
        await using (var db = new VectorizationDbContext(options))
        {
            await db.Database.MigrateAsync();
        }

        await AuthPocSchema.EnsureCreatedAsync(ConnectionString);
    }

    public Task DisposeAsync() => _postgres.DisposeAsync().AsTask();

    public async Task<T> ScalarAsync<T>(string sql, params (string Name, object Value)[] parameters)
    {
        await using var connection = new NpgsqlConnection(ConnectionString);
        await connection.OpenAsync();
        await using var command = new NpgsqlCommand(sql, connection);
        foreach (var (name, value) in parameters)
        {
            command.Parameters.AddWithValue(name, value);
        }

        return (T)Convert.ChangeType((await command.ExecuteScalarAsync())!, typeof(T));
    }
}
