using Npgsql;
using Testcontainers.PostgreSql;

namespace Vectorify.Api.Tests;

/// <summary>
/// PostgreSQL REAL (nunca InMemory) para los tests de integración. Por defecto es un container efímero de Testcontainers (<c>postgres:17-alpine</c>), exactamente como antes.
/// Opcional (M3.1-S09): si la variable de entorno <c>VECTORIFY_TEST_POSTGRES</c> trae la cadena de conexión de un servidor PostgreSQL con permiso para crear bases, cada instancia usa
/// <b>una base nueva</b> en ese servidor (NO se borra: cada DROP DATABASE fuerza un checkpoint y, con decenas de clases en paralelo, saturaba el servidor; borre el servidor de pruebas al terminar) en vez de un container; sirve para máquinas sin Docker. Expone solo lo que los tests usan del container
/// (<c>StartAsync</c>, <c>GetConnectionString</c>, <c>Hostname</c>, <c>GetMappedPublicPort</c>, <c>DisposeAsync</c>).
/// </summary>
public sealed class TestPostgres : IAsyncDisposable
{
    public const string ExternalServerVariable = "VECTORIFY_TEST_POSTGRES";

    private static readonly string? ExternalServer =
        string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(ExternalServerVariable)) ? null : Environment.GetEnvironmentVariable(ExternalServerVariable);

    private readonly PostgreSqlContainer? _container = ExternalServer is null ? new PostgreSqlBuilder("postgres:17-alpine").Build() : null;
    private string? _externalDatabaseConnection;

    public Task StartAsync()
    {
        if (_container is not null)
        {
            return _container.StartAsync();
        }

        return CreateExternalDatabaseAsync();
    }

    public string GetConnectionString() => _container?.GetConnectionString() ?? _externalDatabaseConnection
        ?? throw new InvalidOperationException("TestPostgres.StartAsync debe completarse antes de pedir la cadena de conexión.");

    public string Hostname => _container?.Hostname ?? new NpgsqlConnectionStringBuilder(ExternalServer!).Host!;

    public ushort GetMappedPublicPort(int containerPort) =>
        _container?.GetMappedPublicPort(containerPort) ?? (ushort)new NpgsqlConnectionStringBuilder(ExternalServer!).Port;

    public async ValueTask DisposeAsync()
    {
        if (_container is not null)
        {
            await _container.DisposeAsync();
            return;
        }

        // Servidor externo: la base de esta instancia se deja (ver el comentario de la clase).
        await Task.CompletedTask;
    }

    private async Task CreateExternalDatabaseAsync()
    {
        var name = "t_" + Guid.NewGuid().ToString("N");
        await using (var admin = new NpgsqlConnection(ExternalServer))
        {
            await admin.OpenAsync();
            await using var create = new NpgsqlCommand($"CREATE DATABASE \"{name}\"", admin);
            await create.ExecuteNonQueryAsync();
        }

        _externalDatabaseConnection = new NpgsqlConnectionStringBuilder(ExternalServer!) { Database = name }.ConnectionString;
    }
}
