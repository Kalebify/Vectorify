using System.Net.Http.Json;
using Microsoft.AspNetCore.Builder;
using System.Security.Cryptography;
using AuthPoc.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;

namespace AuthPoc.Tests.Support;

/// <summary>Una persona ya autenticada ante el host: su cliente HTTP lleva la credencial (token o cookie).</summary>
public sealed record Actor(HttpClient Client, string Provider, string Subject, string Email);

/// <summary>Datos de prueba generados en el test: ningun secreto ni contrasena fija vive en el repositorio.</summary>
public static class TestSecrets
{
    public static string NewEmail() => $"{Guid.NewGuid():N}@poc.test";

    /// <summary>Cumple la politica del host (12+, mayuscula, minuscula, digito, simbolo) y es distinta en cada llamada.</summary>
    public static string NewPassword() => "Aa1!" + Convert.ToHexString(RandomNumberGenerator.GetBytes(12));
}

/// <summary>
/// Un host del PoC con UNA fuente de identidad. Los tests de contrato (<see cref="Contract.IdentityBoundaryContract"/>) solo conocen
/// esta clase: es la prueba de que el dominio no sabe quien autentica.
/// </summary>
public abstract class AuthSourceHarness : IAsyncDisposable
{
    protected AuthSourceHarness(WebApplication app)
    {
        App = app;
    }

    public WebApplication App { get; }

    public IServiceProvider Services => App.Services;

    /// <summary>Cliente sin credencial (con las cabeceras que cualquier SPA legitima enviaria, para llegar hasta la autenticacion).</summary>
    public abstract HttpClient CreateAnonymousClient();

    public abstract Task<Actor> SignUpAsync();

    public HttpClient CreateRawClient() => ((TestServer)App.Services.GetRequiredService<IServer>()).CreateClient();

    public async ValueTask DisposeAsync()
    {
        await App.StopAsync();
        await App.DisposeAsync();
        await OnDisposedAsync();
    }

    protected virtual ValueTask OnDisposedAsync() => ValueTask.CompletedTask;

    protected static WebApplication Start(AuthPocHostOptions options)
    {
        var app = AuthPocHost.Build(options, builder => builder.WebHost.UseTestServer());
        app.StartAsync().GetAwaiter().GetResult();
        return app;
    }
}

/// <summary>Fuente (A): emisor OIDC simulado + JwtBearer.</summary>
public sealed class OidcHarness : AuthSourceHarness
{
    public const string Audience = "api://vectorify-poc";

    private OidcHarness(WebApplication app, FakeOidcIssuer issuer)
        : base(app)
    {
        Issuer = issuer;
    }

    public FakeOidcIssuer Issuer { get; }

    public static OidcHarness Create(string connectionString, string issuerUrl = "https://issuer-a.poc.test")
    {
        var issuer = new FakeOidcIssuer(issuerUrl, Audience);
        var app = Start(new AuthPocHostOptions
        {
            Source = IdentitySource.OidcJwt,
            ConnectionString = connectionString,
            OidcAuthority = issuer.Issuer,
            OidcAudience = issuer.Audience,
            OidcBackchannelHandler = issuer.Handler,
        });
        return new OidcHarness(app, issuer);
    }

    public override HttpClient CreateAnonymousClient() => CreateRawClient();

    public HttpClient CreateClientWithToken(string token)
    {
        var client = CreateRawClient();
        client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        return client;
    }

    public override Task<Actor> SignUpAsync()
    {
        // "Registrarse" ocurre en el proveedor; para nosotros solo existe un subject estable y un token firmado.
        var subject = "idp|" + Guid.NewGuid().ToString("N");
        var email = TestSecrets.NewEmail();
        var token = Issuer.MintToken(subject, email);
        return Task.FromResult(new Actor(CreateClientWithToken(token), Issuer.Issuer, subject, email));
    }

    protected override ValueTask OnDisposedAsync()
    {
        Issuer.Dispose();
        return ValueTask.CompletedTask;
    }
}

/// <summary>Fuente (B): ASP.NET Core Identity autoalojado + cookie.</summary>
public sealed class CookieHarness : AuthSourceHarness
{
    public const string AllowedOrigin = "http://localhost:5173";

    private CookieHarness(WebApplication app, AuthPocHostOptions options)
        : base(app)
    {
        Options = options;
    }

    public AuthPocHostOptions Options { get; }

    public static CookieHarness Create(string connectionString)
    {
        var options = new AuthPocHostOptions
        {
            Source = IdentitySource.AspNetIdentityCookie,
            ConnectionString = connectionString,
            AllowedOrigins = [AllowedOrigin],
            SessionRevalidationInterval = TimeSpan.Zero,   // en los tests, cada request revalida el SecurityStamp (revocacion inmediata)
        };
        return new CookieHarness(Start(options), options);
    }

    /// <summary>Cliente de una SPA legitima: manda la cabecera anti-CSRF en cada request.</summary>
    public override HttpClient CreateAnonymousClient()
    {
        var client = CreateRawClient();
        client.DefaultRequestHeaders.Add(AuthPocHostOptions.CsrfHeaderName, "1");
        return client;
    }

    public async Task<(string Email, string Password)> RegisterAsync()
    {
        var email = TestSecrets.NewEmail();
        var password = TestSecrets.NewPassword();
        using var client = CreateAnonymousClient();
        var response = await client.PostAsJsonAsync("/poc/identity/register", new { email, password });
        response.EnsureSuccessStatusCode();
        return (email, password);
    }

    /// <summary>Inicia sesion y devuelve el valor <c>nombre=valor</c> de la cookie (cuando hay) junto con la respuesta completa.</summary>
    public async Task<(HttpResponseMessage Response, string? CookiePair)> LoginAsync(string email, string password)
    {
        using var client = CreateAnonymousClient();
        var response = await client.PostAsJsonAsync("/poc/identity/login", new { email, password });
        var setCookie = response.Headers.TryGetValues("Set-Cookie", out var values)
            ? values.FirstOrDefault(v => v.StartsWith(Options.CookieName + "=", StringComparison.Ordinal))
            : null;
        return (response, setCookie?.Split(';')[0]);
    }

    public HttpClient CreateClientWithCookie(string cookiePair, bool withCsrfHeader = true)
    {
        var client = withCsrfHeader ? CreateAnonymousClient() : CreateRawClient();
        client.DefaultRequestHeaders.Add("Cookie", cookiePair);
        return client;
    }

    public override async Task<Actor> SignUpAsync()
    {
        var (email, password) = await RegisterAsync();
        var (response, cookie) = await LoginAsync(email, password);
        response.EnsureSuccessStatusCode();

        using var scope = Services.CreateScope();
        var users = scope.ServiceProvider.GetRequiredService<UserManager<IdentityUser<Guid>>>();
        var identityUser = await users.FindByEmailAsync(email) ?? throw new InvalidOperationException("La cuenta recien registrada no existe.");

        return new Actor(
            CreateClientWithCookie(cookie ?? throw new InvalidOperationException("El login no devolvio cookie.")),
            Options.CookieProviderKey,
            identityUser.Id.ToString(),
            email);
    }
}
