using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Testcontainers.PostgreSql;
using Vectorify.Api.Contracts;
using Vectorify.Api.Tests.TestSupport;

namespace Vectorify.Api.Tests.EndToEnd;

/// <summary>
/// Verifica GET /api/v1/system/health con PostgreSQL REALMENTE arriba (Testcontainers,
/// no un mock): confirma que Program.cs migra automáticamente al arrancar la API
/// (Database.Migrate(), nunca EnsureCreated()) y que el health check compuesto refleja
/// "online" para Postgres una vez que la migración se aplicó correctamente -- el caso
/// contrario (Postgres no configurado/inalcanzable) ya lo cubre HealthEndpointsTests.
/// </summary>
public sealed class DatabaseHealthEndpointTests : IAsyncLifetime
{
    private readonly TestPostgres _postgres = new();

    public Task InitializeAsync() => _postgres.StartAsync();

    public Task DisposeAsync() => _postgres.DisposeAsync().AsTask();

    [Fact]
    public async Task GetSystemHealth_WhenPostgresIsUpAndMigrated_ReturnsOnlineOverallAndDatabaseStatus()
    {
        await using var python = await FakePythonServer.StartAsync(
            """{"status":"ok","service":"vectorify-python-engine","version":"0.1.0"}""");

        await using var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
        {
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["PythonEngine:BaseUrl"] = python.BaseUrl,
                    ["Postgres:ConnectionString"] = _postgres.GetConnectionString(),
                    ["Cors:AllowedOrigins"] = "http://localhost:5173",
                });
            });
        });
        var client = factory.CreateClient();

        var response = await client.GetAsync("/api/v1/system/health");
        var body = await response.Content.ReadFromJsonAsync<SystemHealthResponse>();

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.NotNull(body);
        Assert.Equal("online", body!.Status);
        Assert.Equal("online", body.Database.Status);
        Assert.Null(body.Database.Message);
    }
}
