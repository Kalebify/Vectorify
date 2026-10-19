using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Vectorify.Api.Data;
using Vectorify.Api.Middleware;
using Vectorify.Api.Tests.TestSupport;

namespace Vectorify.Api.Tests.EndToEnd;

/// <summary>
/// Higiene de errores (M3.1-S09): fuera de Development una excepción no controlada devuelve un cuerpo GENÉRICO (sin stack, sin mensaje interno, sin nombres de tipos ni rutas) con el
/// correlation ID para localizar el detalle en el log; y el correlation ID entrante no es un canal para meter datos arbitrarios en el log.
/// </summary>
[Collection(AuthRecoveryCollection.Name)]
public sealed class ErrorHygieneTests : IAsyncLifetime
{
    private const string InternalDetail = "Host=10.1.2.3;Username=vectorify;Password=hunter2-super-secret falló en C:\\src\\Vectorify.Api\\Secret.cs:line 42";

    private readonly AuthApiFixture _fixture;
    private readonly List<RecoveryHost> _hosts = [];
    private string _connectionString = string.Empty;

    public ErrorHygieneTests(AuthApiFixture fixture)
    {
        _fixture = fixture;
    }

    public async Task InitializeAsync() => _connectionString = await _fixture.CreateDatabaseAsync();

    public async Task DisposeAsync()
    {
        foreach (var host in _hosts)
        {
            await host.DisposeAsync();
        }
    }

    private sealed class ExplodingDatabaseHealthChecker : IDatabaseHealthChecker
    {
        public Task<DatabaseHealthCheckResult> CheckHealthAsync(CancellationToken cancellationToken = default) =>
            throw new InvalidOperationException(InternalDetail, new NullReferenceException("inner stack detail"));
    }

    private RecoveryHost CreateProductionHost(CapturingLoggerProvider? logs = null)
    {
        var host = RecoveryHost.Create(
            _fixture,
            _connectionString,
            new Dictionary<string, string?>
            {
                ["Auth:Email:Mode"] = "Disabled",
                ["Auth:DataProtection:KeysPath"] = Path.Combine(Path.GetTempPath(), "vectorify-s09-keys-" + Guid.NewGuid().ToString("N")),
                ["Auth:Cookie:Name"] = RecoveryHost.CookieName,
            },
            logProvider: logs,
            configureServices: services =>
            {
                services.RemoveAll<IDatabaseHealthChecker>();
                services.AddScoped<IDatabaseHealthChecker, ExplodingDatabaseHealthChecker>();
            },
            environment: "Production");
        _hosts.Add(host);
        return host;
    }

    [Fact]
    public async Task InProduction_AnUnhandledException_Returns500WithAGenericBody_NoStackNoInternalMessage()
    {
        var logs = new CapturingLoggerProvider();
        var host = CreateProductionHost(logs);

        var response = await host.Client.GetAsync("/api/v1/system/health");
        var body = await response.Content.ReadAsStringAsync();

        Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
        Assert.Equal("application/json", response.Content.Headers.ContentType?.MediaType);
        using var json = JsonDocument.Parse(body);
        Assert.Equal("internal_error", json.RootElement.GetProperty("code").GetString());
        foreach (var forbidden in new[] { "hunter2", "Password", "10.1.2.3", "InvalidOperationException", "NullReferenceException", "inner stack", "Secret.cs", "line 42", "   at ", "Exception" })
        {
            Assert.DoesNotContain(forbidden, body, StringComparison.Ordinal);
        }

        Assert.DoesNotContain("<html", body, StringComparison.OrdinalIgnoreCase); // no es la página de excepciones del framework
        var correlationId = Assert.Single(response.Headers.GetValues(CorrelationIdMiddleware.HeaderName));
        Assert.Matches("^[0-9a-f]{32}$", correlationId);
        Assert.False(response.Headers.Contains("Server-Timing"));

        // El detalle SÍ queda en el log (con el scope del correlation ID), que es donde debe estar.
        Assert.Contains(logs.Entries, entry => entry.Contains("InvalidOperationException", StringComparison.Ordinal));
    }

    [Fact]
    public async Task InProduction_TheErrorResponseKeepsTheSecurityHeaders_AndIsNeverCached()
    {
        var host = CreateProductionHost();

        var response = await host.Client.GetAsync("/api/v1/system/health");

        Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
        Assert.Equal("nosniff", Assert.Single(response.Headers.GetValues("X-Content-Type-Options")));
        Assert.Contains("sandbox", Assert.Single(response.Headers.GetValues("Content-Security-Policy")));
        Assert.True(response.Headers.CacheControl?.NoStore == true || response.Headers.CacheControl?.NoCache == true);
    }

    // ------------------------------------------------------------------------------------------------------ correlation ID

    [Theory]
    [InlineData("abc-123", true)]
    [InlineData("0f8fad5bd9cb469fa16570867728950e", true)]
    [InlineData("req_2026.10.19-A", true)]
    [InlineData("", false)]
    [InlineData("a b", false)]
    [InlineData("persona@vectorify.test", false)]
    [InlineData("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.firma/con/barras", false)]
    [InlineData("line1\nline2", false)]
    [InlineData("\u00e1\u00e9", false)]
    [InlineData("a;b", false)]
    public void IncomingCorrelationIds_AreOnlyReusedWhenTheyAreOpaqueIdentifiers(string value, bool accepted)
    {
        Assert.Equal(accepted, CorrelationIdMiddleware.IsAcceptable(value));
    }

    [Fact]
    public void IncomingCorrelationIds_AreBoundedInLength()
    {
        Assert.True(CorrelationIdMiddleware.IsAcceptable(new string('a', CorrelationIdMiddleware.MaxLength)));
        Assert.False(CorrelationIdMiddleware.IsAcceptable(new string('a', CorrelationIdMiddleware.MaxLength + 1)));
        Assert.False(CorrelationIdMiddleware.IsAcceptable(null));
    }

    [Fact]
    public async Task TheApi_EchoesAnAcceptableCorrelationId_AndReplacesAHostileOne_WithoutLoggingIt()
    {
        var logs = new CapturingLoggerProvider();
        var host = RecoveryHost.Create(_fixture, _connectionString, logProvider: logs);
        _hosts.Add(host);
        const string hostile = "persona@vectorify.test token=abc123";

        var good = new HttpRequestMessage(HttpMethod.Get, "/health");
        good.Headers.Add(CorrelationIdMiddleware.HeaderName, "mi-id-123");
        var bad = new HttpRequestMessage(HttpMethod.Get, "/health");
        bad.Headers.TryAddWithoutValidation(CorrelationIdMiddleware.HeaderName, hostile);

        var goodResponse = await host.Client.SendAsync(good);
        var badResponse = await host.Client.SendAsync(bad);

        Assert.Equal("mi-id-123", Assert.Single(goodResponse.Headers.GetValues(CorrelationIdMiddleware.HeaderName)));
        var replaced = Assert.Single(badResponse.Headers.GetValues(CorrelationIdMiddleware.HeaderName));
        Assert.Matches("^[0-9a-f]{32}$", replaced);
        Assert.DoesNotContain(logs.Entries, entry => entry.Contains("persona@vectorify.test", StringComparison.Ordinal) || entry.Contains("abc123", StringComparison.Ordinal));
        Assert.False(new Regex("[\r\n]").IsMatch(replaced));
    }
}
