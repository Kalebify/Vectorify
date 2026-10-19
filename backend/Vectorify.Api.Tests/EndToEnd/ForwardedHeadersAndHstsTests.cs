using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Options;
using Vectorify.Api.Contracts;
using Vectorify.Api.Endpoints;
using Vectorify.Api.Tests.TestSupport;

namespace Vectorify.Api.Tests.EndToEnd;

/// <summary>
/// Proxy de confianza, IP real, esquema y HSTS (M3.1-S09, T10). Sin <c>Auth:ForwardedHeaders:Enabled</c> las cabeceras <c>X-Forwarded-*</c> de un cliente se IGNORAN: no puede falsificar su IP
/// (para esquivar el límite por IP o para gastar el cupo de otra persona) ni hacerse pasar por https. Con <c>Enabled</c> solo se atienden las de una conexión que venga de un proxy configurado.
/// La «IP del socket» se fija en los tests con <c>X-Test-Remote-Ip</c> (TestServer no tiene IP remota).
/// </summary>
[Collection(AuthRecoveryCollection.Name)]
public sealed class ForwardedHeadersAndHstsTests : IAsyncLifetime
{
    private const string Proxy = "10.20.0.5";

    private readonly AuthApiFixture _fixture;
    private readonly List<RecoveryHost> _hosts = [];
    private string _connectionString = string.Empty;

    public ForwardedHeadersAndHstsTests(AuthApiFixture fixture)
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

    private static Dictionary<string, string?> LoginLimit(int perIp) => new()
    {
        ["Auth:RateLimit:LoginIpPermitLimit"] = perIp.ToString(System.Globalization.CultureInfo.InvariantCulture),
        ["Auth:RateLimit:LoginIpWindow"] = "00:10:00",
    };

    private RecoveryHost CreateHost(IDictionary<string, string?> settings, string? environment = null)
    {
        var values = new Dictionary<string, string?>(settings);
        if (environment == "Production")
        {
            // Lo mínimo que exige Production: key ring persistente (volumen) y correo sin modo Log; la cookie sin __Host- para que RecoveryHost la reconozca.
            values.TryAdd("Auth:Email:Mode", "Disabled");
            values.TryAdd("Auth:DataProtection:KeysPath", Path.Combine(Path.GetTempPath(), "vectorify-s09-keys-" + Guid.NewGuid().ToString("N")));
            values.TryAdd("Auth:Cookie:Name", RecoveryHost.CookieName);
        }

        var host = RecoveryHost.Create(_fixture, _connectionString, values, environment: environment);
        _hosts.Add(host);
        return host;
    }

    private static Task<HttpResponseMessage> LoginFrom(RecoveryHost host, string remoteIp, string? forwardedFor = null, string? forwardedProto = null) =>
        host.PostAsync(
            AuthEndpoints.LoginPath,
            new LoginRequest(RecoveryHost.NewEmail(), "una-contrasena-erronea-9"),
            ip: remoteIp,
            configure: request =>
            {
                if (forwardedFor is not null)
                {
                    request.Headers.TryAddWithoutValidation("X-Forwarded-For", forwardedFor);
                }

                if (forwardedProto is not null)
                {
                    request.Headers.TryAddWithoutValidation("X-Forwarded-Proto", forwardedProto);
                }
            });

    private static HttpClient ClientFor(RecoveryHost host, string baseAddress)
    {
        var client = host.Factory.CreateClient(new WebApplicationFactoryClientOptions { HandleCookies = false, BaseAddress = new Uri(baseAddress) });
        return client.WithCsrf();
    }

    private static async Task<HttpResponseMessage> GetHealth(HttpClient client, string? remoteIp = null, string? forwardedProto = null)
    {
        var request = new HttpRequestMessage(HttpMethod.Get, "/health");
        if (remoteIp is not null)
        {
            request.Headers.Add(TestRemoteIpMiddleware.HeaderName, remoteIp);
        }

        if (forwardedProto is not null)
        {
            request.Headers.Add("X-Forwarded-Proto", forwardedProto);
        }

        return await client.SendAsync(request);
    }

    // ------------------------------------------------------------------------------------- sin proxy de confianza (default)

    [Fact]
    public async Task ByDefault_AClientCannotRotateItsIpWithXForwardedFor_ToEvadeTheLoginLimit()
    {
        var host = CreateHost(LoginLimit(perIp: 2));

        Assert.Equal(HttpStatusCode.Unauthorized, (await LoginFrom(host, "198.51.100.10", forwardedFor: "203.0.113.1")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await LoginFrom(host, "198.51.100.10", forwardedFor: "203.0.113.2")).StatusCode);

        // Una IP «nueva» en cada intento no cambia el cupo: cuenta la IP del socket.
        Assert.Equal(HttpStatusCode.TooManyRequests, (await LoginFrom(host, "198.51.100.10", forwardedFor: "203.0.113.3")).StatusCode);
        Assert.Equal(HttpStatusCode.TooManyRequests, (await LoginFrom(host, "198.51.100.10", forwardedFor: "203.0.113.4, 203.0.113.5")).StatusCode);
    }

    [Fact]
    public async Task ByDefault_AClientCannotSpendAnotherPersonsQuotaBySpoofingTheirIp()
    {
        var host = CreateHost(LoginLimit(perIp: 2));
        const string victim = "198.51.100.20";

        for (var i = 0; i < 5; i++)
        {
            await LoginFrom(host, "198.51.100.66", forwardedFor: victim); // el atacante dice ser la víctima
        }

        Assert.Equal(HttpStatusCode.Unauthorized, (await LoginFrom(host, victim)).StatusCode); // la víctima sigue teniendo su cupo
    }

    [Fact]
    public async Task ByDefault_XForwardedProtoIsIgnored_SoHstsIsNotEmittedOverPlainHttp()
    {
        var host = CreateHost(new Dictionary<string, string?>(), environment: "Production");
        using var client = ClientFor(host, "http://app.vectorify.test");

        var response = await GetHealth(client, remoteIp: Proxy, forwardedProto: "https");

        Assert.True(response.IsSuccessStatusCode);
        Assert.False(response.Headers.Contains("Strict-Transport-Security"));
    }

    // ------------------------------------------------------------------------------------- con un proxy de confianza

    [Fact]
    public async Task WithATrustedProxy_TheClientIpComesFromXForwardedFor_ButOnlyWhenTheConnectionIsFromThatProxy()
    {
        var settings = LoginLimit(perIp: 2);
        settings["Auth:ForwardedHeaders:Enabled"] = "true";
        settings["Auth:ForwardedHeaders:KnownProxies"] = Proxy;
        var host = CreateHost(settings);

        // Desde el proxy: cada cliente real (X-Forwarded-For) tiene su propio cupo.
        Assert.Equal(HttpStatusCode.Unauthorized, (await LoginFrom(host, Proxy, forwardedFor: "203.0.113.7")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await LoginFrom(host, Proxy, forwardedFor: "203.0.113.7")).StatusCode);
        Assert.Equal(HttpStatusCode.TooManyRequests, (await LoginFrom(host, Proxy, forwardedFor: "203.0.113.7")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await LoginFrom(host, Proxy, forwardedFor: "203.0.113.8")).StatusCode); // otro cliente tras el mismo proxy

        // Desde un origen que NO es el proxy, X-Forwarded-For se ignora: no puede aparentar ser otra IP.
        for (var i = 0; i < 2; i++)
        {
            await LoginFrom(host, "198.51.100.99", forwardedFor: $"203.0.113.{100 + i}");
        }

        Assert.Equal(HttpStatusCode.TooManyRequests, (await LoginFrom(host, "198.51.100.99", forwardedFor: "203.0.113.200")).StatusCode);
    }

    [Fact]
    public async Task WithATrustedNetwork_TheProxiesInsideItAreTrusted_AndOutsiderAreNot()
    {
        var settings = LoginLimit(perIp: 1);
        settings["Auth:ForwardedHeaders:Enabled"] = "true";
        settings["Auth:ForwardedHeaders:KnownNetworks"] = "10.20.0.0/16";
        var host = CreateHost(settings);

        Assert.Equal(HttpStatusCode.Unauthorized, (await LoginFrom(host, "10.20.3.4", forwardedFor: "203.0.113.31")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await LoginFrom(host, "10.20.3.4", forwardedFor: "203.0.113.32")).StatusCode); // dentro de la red: se confía

        Assert.Equal(HttpStatusCode.Unauthorized, (await LoginFrom(host, "10.99.0.1", forwardedFor: "203.0.113.33")).StatusCode);
        Assert.Equal(HttpStatusCode.TooManyRequests, (await LoginFrom(host, "10.99.0.1", forwardedFor: "203.0.113.34")).StatusCode); // fuera: se ignora
    }

    [Fact]
    public async Task WithATrustedProxy_XForwardedProtoHttps_MakesTheApiSeeHttps_SoHstsIsEmittedOutsideDevelopment()
    {
        var host = CreateHost(
            new Dictionary<string, string?>
            {
                ["Auth:ForwardedHeaders:Enabled"] = "true",
                ["Auth:ForwardedHeaders:KnownProxies"] = Proxy,
            },
            environment: "Production");
        using var client = ClientFor(host, "http://app.vectorify.test");

        var fromProxy = await GetHealth(client, remoteIp: Proxy, forwardedProto: "https");
        var fromStranger = await GetHealth(client, remoteIp: "198.51.100.5", forwardedProto: "https");

        Assert.Equal("max-age=15552000", Assert.Single(fromProxy.Headers.GetValues("Strict-Transport-Security")));
        Assert.False(fromStranger.Headers.Contains("Strict-Transport-Security")); // nadie ajeno al proxy puede aparentar https
    }

    // ------------------------------------------------------------------------------------------------------------- HSTS

    [Fact]
    public async Task Hsts_InProduction_IsEmittedOverHttps_WithoutPreloadNorSubdomainsByDefault_AndNeverOverHttp()
    {
        var host = CreateHost(new Dictionary<string, string?>(), environment: "Production");
        using var https = ClientFor(host, "https://app.vectorify.test");
        using var http = ClientFor(host, "http://app.vectorify.test");

        var secure = await GetHealth(https);
        var plain = await GetHealth(http);

        var hsts = Assert.Single(secure.Headers.GetValues("Strict-Transport-Security"));
        Assert.Equal("max-age=15552000", hsts); // 180 días; sin includeSubDomains ni preload
        Assert.False(plain.Headers.Contains("Strict-Transport-Security"));
    }

    [Fact]
    public async Task Hsts_IsConfigurable()
    {
        var host = CreateHost(
            new Dictionary<string, string?> { ["Auth:Hsts:MaxAge"] = "365.00:00:00", ["Auth:Hsts:IncludeSubDomains"] = "true" },
            environment: "Production");
        using var https = ClientFor(host, "https://app.vectorify.test");

        var response = await GetHealth(https);

        Assert.Equal("max-age=31536000; includeSubDomains", Assert.Single(response.Headers.GetValues("Strict-Transport-Security")));
    }

    [Fact]
    public async Task Hsts_IsNeverEmittedInDevelopment_EvenOverHttps()
    {
        var host = CreateHost(new Dictionary<string, string?>()); // entorno Development (el de WebApplicationFactory)
        using var https = ClientFor(host, "https://app.vectorify.test");

        var response = await GetHealth(https);

        Assert.True(response.IsSuccessStatusCode);
        Assert.False(response.Headers.Contains("Strict-Transport-Security"));
    }

    // ------------------------------------------------------------------------------------ configuración que NO debe arrancar

    private static Exception? StartWith(Action<IWebHostBuilder> configure)
    {
        using var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(configure);
        return Record.Exception(() => factory.CreateClient());
    }

    private static bool Contains<T>(Exception? exception, string text)
        where T : Exception
    {
        for (var current = exception; current is not null; current = current.InnerException)
        {
            if (current is T && current.Message.Contains(text, StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }

    [Fact]
    public void ForwardedHeaders_EnabledWithoutAnyTrustedProxyOrNetwork_FailsToStart()
    {
        var exception = StartWith(builder => builder.UseSetting("Auth:ForwardedHeaders:Enabled", "true"));

        Assert.True(Contains<OptionsValidationException>(exception, "confianza ciega"), exception?.ToString());
    }

    [Theory]
    [InlineData("0.0.0.0/0")]
    [InlineData("::/0")]
    [InlineData("10.0.0.0/7")]
    [InlineData("fd00::/8")]
    public void ForwardedHeaders_TooBroadNetworks_FailToStart(string network)
    {
        var exception = StartWith(builder =>
        {
            builder.UseSetting("Auth:ForwardedHeaders:Enabled", "true");
            builder.UseSetting("Auth:ForwardedHeaders:KnownNetworks", network);
        });

        Assert.True(Contains<OptionsValidationException>(exception, "demasiado amplia"), exception?.ToString());
    }

    [Theory]
    [InlineData("not-an-ip")]
    [InlineData("0.0.0.0")]
    [InlineData("::")]
    public void ForwardedHeaders_InvalidOrBlindProxies_FailToStart(string proxy)
    {
        var exception = StartWith(builder =>
        {
            builder.UseSetting("Auth:ForwardedHeaders:Enabled", "true");
            builder.UseSetting("Auth:ForwardedHeaders:KnownProxies", proxy);
        });

        Assert.NotNull(exception);
        Assert.True(Contains<OptionsValidationException>(exception, "Auth:ForwardedHeaders:KnownProxies"), exception?.ToString());
    }

    [Fact]
    public void TheFrameworkSwitch_AspNetCoreForwardedHeadersEnabled_IsRejected_BecauseItTrustsEveryOrigin()
    {
        var exception = StartWith(builder => builder.UseSetting("FORWARDEDHEADERS_ENABLED", "true"));

        Assert.True(Contains<InvalidOperationException>(exception, "ASPNETCORE_FORWARDEDHEADERS_ENABLED"), exception?.ToString());
    }

    [Fact]
    public async Task ForwardedHeaders_WithAValidProxyList_StartsAndServes()
    {
        using var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
        {
            builder.UseSetting("Auth:ForwardedHeaders:Enabled", "true");
            builder.UseSetting("Auth:ForwardedHeaders:KnownProxies", "10.0.0.5, 10.0.0.6");
            builder.UseSetting("Auth:ForwardedHeaders:KnownNetworks", "172.16.0.0/12");
        });
        using var client = factory.CreateClient();

        Assert.True((await client.GetAsync("/health")).IsSuccessStatusCode);
    }
}
