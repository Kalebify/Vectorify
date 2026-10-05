using System.Net.Sockets;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using Vectorify.Api.Middleware;

namespace Vectorify.Api.Tests.Middleware;

/// <summary>
/// Clasificación de excepciones de <see cref="DependencyFailureMiddleware"/> (M2.2-S10): solo una falla de
/// CONECTIVIDAD con PostgreSQL se traduce a 503; un error de datos/consulta o un bug cualquiera siguen siendo 500
/// (no se enmascaran). El comportamiento HTTP end-to-end (503 con la base realmente caída) lo cubre
/// <c>PersistenceFailureModesTests</c>.
/// </summary>
public sealed class DependencyFailureMiddlewareTests
{
    [Fact]
    public void IsDatabaseUnavailable_ForConnectionLevelNpgsqlFailures_IsTrue()
    {
        var refused = new NpgsqlException("Failed to connect to 127.0.0.1:5432", new SocketException(10061));
        Assert.True(DependencyFailureMiddleware.IsDatabaseUnavailable(refused));

        // EF Core envuelve la falla transitoria de Npgsql en una InvalidOperationException ("likely due to a transient failure").
        var wrapped = new InvalidOperationException("transient", new NpgsqlException("Exception while reading from stream", new IOException()));
        Assert.True(DependencyFailureMiddleware.IsDatabaseUnavailable(wrapped));

        // Y en SaveChanges, en una DbUpdateException.
        var duringSave = new DbUpdateException("save", new NpgsqlException("conexión cortada", new IOException()));
        Assert.True(DependencyFailureMiddleware.IsDatabaseUnavailable(duringSave));
    }

    [Theory]
    [InlineData("08006")] // connection_failure
    [InlineData("08001")] // sqlclient_unable_to_establish_sqlconnection
    [InlineData("53300")] // too_many_connections
    [InlineData("57P01")] // admin_shutdown
    [InlineData("57P02")] // crash_shutdown
    [InlineData("57P03")] // cannot_connect_now
    public void IsDatabaseUnavailable_ForServerSideAvailabilitySqlStates_IsTrue(string sqlState)
    {
        var exception = new PostgresException("servidor no disponible", "FATAL", "FATAL", sqlState);

        Assert.True(DependencyFailureMiddleware.IsDatabaseUnavailable(exception));
        Assert.True(DependencyFailureMiddleware.IsDatabaseUnavailable(new DbUpdateException("save", exception)));
    }

    [Theory]
    [InlineData("23505")] // unique_violation: bug de datos, no caída
    [InlineData("23503")] // foreign_key_violation
    [InlineData("42P01")] // undefined_table
    [InlineData("40001")] // serialization_failure
    public void IsDatabaseUnavailable_ForDataOrQueryErrors_IsFalse(string sqlState)
    {
        var exception = new PostgresException("error de datos", "ERROR", "ERROR", sqlState);

        Assert.False(DependencyFailureMiddleware.IsDatabaseUnavailable(exception));
        Assert.False(DependencyFailureMiddleware.IsDatabaseUnavailable(new DbUpdateException("save", exception)));
    }

    [Fact]
    public void IsDatabaseUnavailable_ForUnrelatedExceptions_IsFalse()
    {
        Assert.False(DependencyFailureMiddleware.IsDatabaseUnavailable(new InvalidOperationException("bug cualquiera")));
        Assert.False(DependencyFailureMiddleware.IsDatabaseUnavailable(new IOException("disco")));
        Assert.False(DependencyFailureMiddleware.IsDatabaseUnavailable(new TimeoutException("python")));
        Assert.False(DependencyFailureMiddleware.IsDatabaseUnavailable(new InvalidOperationException("x", new ArgumentException("y"))));
    }
}
