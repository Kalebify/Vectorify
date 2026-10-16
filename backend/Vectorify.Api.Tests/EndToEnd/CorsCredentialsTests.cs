using System.Net;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;

namespace Vectorify.Api.Tests.EndToEnd;

/// <summary>
/// CORS con credenciales (M3.1-S02, T8 del ADR): la sesión es una cookie, así que la política exige orígenes explícitos, permite
/// credenciales SOLO a ellos y enumera cabeceras y métodos (ya no AllowAnyHeader/AllowAnyMethod). Sin base de datos.
/// </summary>
public sealed class CorsCredentialsTests : IDisposable
{
    private const string AllowedOrigin = "http://localhost:5173";

    private readonly WebApplicationFactory<Program> _factory = new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
        builder.ConfigureAppConfiguration((_, config) => config.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Cors:AllowedOrigins"] = AllowedOrigin,
            ["PythonEngine:BaseUrl"] = "http://127.0.0.1:1",
        })));

    public void Dispose() => _factory.Dispose();

    [Fact]
    public async Task AllowedOrigin_GetsAllowCredentials_AndTheExactOriginNeverAWildcard()
    {
        using var client = _factory.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Get, "/health");
        request.Headers.Add("Origin", AllowedOrigin);

        var response = await client.SendAsync(request);

        Assert.Equal(AllowedOrigin, Assert.Single(response.Headers.GetValues("Access-Control-Allow-Origin")));
        Assert.Equal("true", Assert.Single(response.Headers.GetValues("Access-Control-Allow-Credentials")));
    }

    [Fact]
    public async Task UnknownOrigin_GetsNoCorsHeaders_NotEvenCredentials()
    {
        using var client = _factory.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Get, "/health");
        request.Headers.Add("Origin", "http://evil.example");

        var response = await client.SendAsync(request);

        Assert.False(response.Headers.Contains("Access-Control-Allow-Origin"));
        Assert.False(response.Headers.Contains("Access-Control-Allow-Credentials"));
    }

    [Theory]
    [InlineData("POST", "content-type")]
    [InlineData("POST", "content-type,idempotency-key")]
    [InlineData("PATCH", "content-type,x-correlation-id")]
    [InlineData("DELETE", "x-correlation-id")]
    [InlineData("POST", "content-type,x-vectorify-request")]
    [InlineData("PATCH", "content-type,x-vectorify-request,idempotency-key")]
    [InlineData("DELETE", "x-vectorify-request")]
    public async Task Preflight_ForWhatTheFrontendSendsToday_IsAccepted(string method, string headers)
    {
        using var client = _factory.CreateClient();

        var response = await client.SendAsync(Preflight("/api/v1/auth/register", method, headers));

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal(AllowedOrigin, Assert.Single(response.Headers.GetValues("Access-Control-Allow-Origin")));
        Assert.Equal("true", Assert.Single(response.Headers.GetValues("Access-Control-Allow-Credentials")));
        Assert.Contains(method, string.Join(",", response.Headers.GetValues("Access-Control-Allow-Methods")));
        var allowedHeaders = string.Join(",", response.Headers.GetValues("Access-Control-Allow-Headers"));
        Assert.All(headers.Split(','), h => Assert.Contains(h, allowedHeaders, StringComparison.OrdinalIgnoreCase));
    }

    [Theory]
    [InlineData("POST", "authorization")]
    [InlineData("POST", "x-evil")]
    [InlineData("POST", "content-type,x-evil")]
    public async Task Preflight_ForAnUnlistedHeader_IsNotGrantedTheHeaders(string method, string headers)
    {
        using var client = _factory.CreateClient();

        var response = await client.SendAsync(Preflight("/api/v1/auth/register", method, headers));

        // ASP.NET responde con la lista ENUMERADA de la política; el navegador bloquea la petición real si la cabecera pedida no figura.
        var allowed = response.Headers.Contains("Access-Control-Allow-Headers")
            ? string.Join(",", response.Headers.GetValues("Access-Control-Allow-Headers"))
            : string.Empty;
        var requestedUnlisted = headers.Split(',').Single(h => h is "authorization" or "x-evil");
        Assert.DoesNotContain(requestedUnlisted, allowed, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("*", allowed);
    }

    [Theory]
    [InlineData("PUT")]
    [InlineData("TRACE")]
    public async Task Preflight_ForAnUnlistedMethod_IsNotGrantedTheMethod(string method)
    {
        using var client = _factory.CreateClient();

        var response = await client.SendAsync(Preflight("/api/v1/auth/register", method, "content-type"));

        var allowed = response.Headers.Contains("Access-Control-Allow-Methods")
            ? string.Join(",", response.Headers.GetValues("Access-Control-Allow-Methods"))
            : string.Empty;
        Assert.DoesNotContain(method, allowed, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("*", allowed);
    }

    [Fact]
    public async Task Preflight_ForTheCsrfHeader_IsAccepted_AndCachedByTheBrowser_ForLoginAndLogout()
    {
        using var client = _factory.CreateClient();

        foreach (var path in new[] { "/api/v1/auth/login", "/api/v1/auth/logout", "/api/v1/auth/me", "/api/v2/projects" })
        {
            var response = await client.SendAsync(Preflight(path, "POST", "content-type,x-vectorify-request"));

            Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
            Assert.Contains("x-vectorify-request", string.Join(",", response.Headers.GetValues("Access-Control-Allow-Headers")), StringComparison.OrdinalIgnoreCase);
            Assert.Equal("true", Assert.Single(response.Headers.GetValues("Access-Control-Allow-Credentials")));
            // El cliente envía la cabecera en TODO fetch: el preflight se cachea para no duplicar cada GET cross-origin.
            Assert.Equal("600", Assert.Single(response.Headers.GetValues("Access-Control-Max-Age")));
        }
    }

    [Fact]
    public async Task Preflight_FromAnUnknownOrigin_IsNotGrantedAnything()
    {
        using var client = _factory.CreateClient();
        var request = Preflight("/api/v1/auth/register", "POST", "content-type");
        request.Headers.Remove("Origin");
        request.Headers.Add("Origin", "http://evil.example");

        var response = await client.SendAsync(request);

        Assert.False(response.Headers.Contains("Access-Control-Allow-Origin"));
        Assert.False(response.Headers.Contains("Access-Control-Allow-Credentials"));
    }

    private static HttpRequestMessage Preflight(string path, string method, string headers)
    {
        var request = new HttpRequestMessage(HttpMethod.Options, path);
        request.Headers.Add("Origin", AllowedOrigin);
        request.Headers.Add("Access-Control-Request-Method", method);
        request.Headers.Add("Access-Control-Request-Headers", headers);
        return request;
    }
}
