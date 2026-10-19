using Microsoft.EntityFrameworkCore;
using Testcontainers.PostgreSql;
using Vectorify.Api.Data;

namespace Vectorify.Api.Tests.Data;

/// <summary>
/// Verifica el pipeline completo de EF Core/PostgreSQL de M2.2-S01 de punta a punta
/// contra una instancia REAL y efímera de PostgreSQL (Testcontainers) -- migraciones,
/// connection pooling, escritura y lectura -- NUNCA UseInMemoryDatabase (prohibido
/// explícitamente por la tarjeta: no prueba comportamientos reales de PostgreSQL).
/// Requiere Docker disponible en el entorno donde corren los tests.
/// </summary>
public sealed class VectorizationDbContextTests : IAsyncLifetime
{
    private readonly TestPostgres _postgres = new();

    public Task InitializeAsync() => _postgres.StartAsync();

    public Task DisposeAsync() => _postgres.DisposeAsync().AsTask();

    [Fact]
    public async Task MigrateAsync_AppliesInitialMigration_FromScratch()
    {
        await using var dbContext = CreateDbContext();

        await dbContext.Database.MigrateAsync();

        var applied = await dbContext.Database.GetAppliedMigrationsAsync();
        Assert.Contains(applied, m => m.Contains("InitialCreate"));
    }

    [Fact]
    public async Task MigrateAsync_TwiceInARow_IsIdempotent()
    {
        await using var dbContext = CreateDbContext();

        await dbContext.Database.MigrateAsync();
        // Volver a migrar contra un esquema ya migrado no debe fallar ni duplicar nada
        // -- es exactamente lo que hace Program.cs cada vez que arranca la API.
        await dbContext.Database.MigrateAsync();

        var pending = await dbContext.Database.GetPendingMigrationsAsync();
        Assert.Empty(pending);
    }

    [Fact]
    public async Task SchemaProbe_RoundTrip_WriteThenReadBackWithANewDbContext()
    {
        await using (var writeContext = CreateDbContext())
        {
            await writeContext.Database.MigrateAsync();

            var probe = new SchemaProbe { CreatedAt = DateTimeOffset.UtcNow };
            writeContext.SchemaProbes.Add(probe);
            await writeContext.SaveChangesAsync();
        }

        // Un DbContext/conexión nueva (mismo connection string, mismo pool de Npgsql)
        // para confirmar que lo escrito sobrevive más allá del DbContext que lo creó --
        // no es un efecto del change tracker en memoria del mismo contexto.
        await using var readContext = CreateDbContext();
        var reloaded = await readContext.SchemaProbes.SingleAsync();

        Assert.True(reloaded.Id > 0);
        Assert.True(reloaded.CreatedAt > DateTimeOffset.MinValue);
    }

    private VectorizationDbContext CreateDbContext()
    {
        var options = new DbContextOptionsBuilder<VectorizationDbContext>()
            .UseNpgsql(_postgres.GetConnectionString())
            .Options;
        return new VectorizationDbContext(options);
    }
}
