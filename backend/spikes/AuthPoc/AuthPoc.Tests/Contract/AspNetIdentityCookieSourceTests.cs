using System.Net;
using System.Net.Http.Json;
using AuthPoc.Hosting;
using AuthPoc.Tests.Support;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.DependencyInjection;

namespace AuthPoc.Tests.Contract;

/// <summary>Fuente (B): ASP.NET Core Identity + cookie. Hereda todo el contrato y suma las comprobaciones propias de una sesion en cookie.</summary>
[Collection(PostgresCollection.Name)]
public sealed class AspNetIdentityCookieSourceTests : IdentityBoundaryContract
{
    private CookieHarness? _harness;

    public AspNetIdentityCookieSourceTests(PostgresFixture postgres)
        : base(postgres)
    {
    }

    protected override AuthSourceHarness Harness => _harness ?? throw new InvalidOperationException("Harness no inicializado.");

    private CookieHarness Cookies => (CookieHarness)Harness;

    public override Task InitializeAsync()
    {
        _harness = CookieHarness.Create(Postgres.ConnectionString);
        return Task.CompletedTask;
    }

    [Fact]
    public async Task TamperedCookie_Is401()
    {
        var (email, password) = await Cookies.RegisterAsync();
        var (_, cookie) = await Cookies.LoginAsync(email, password);
        Assert.NotNull(cookie);

        var separator = cookie.IndexOf('=');
        var name = cookie[..separator];
        var value = cookie[(separator + 1)..];
        var middle = value.Length / 2;
        var flipped = value[middle] == 'A' ? 'B' : 'A';
        var tampered = $"{name}={value[..middle]}{flipped}{value[(middle + 1)..]}";

        foreach (var candidate in new[] { tampered, $"{name}={value[..^8]}", $"{name}=garbage", $"{name}=" })
        {
            using var client = Cookies.CreateClientWithCookie(candidate);
            Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/v2/projects")).StatusCode);
        }

        // Control: la cookie original SI funciona (si no, el test no demostraria nada).
        using var original = Cookies.CreateClientWithCookie(cookie);
        Assert.Equal(HttpStatusCode.OK, (await original.GetAsync("/api/v2/projects")).StatusCode);
    }

    [Fact]
    public async Task SessionCookie_IsHttpOnly_Secure_SameSiteLax_AndHostScoped()
    {
        var (email, password) = await Cookies.RegisterAsync();
        var (response, cookie) = await Cookies.LoginAsync(email, password);
        Assert.NotNull(cookie);

        var setCookie = response.Headers.GetValues("Set-Cookie").Single(v => v.StartsWith(Cookies.Options.CookieName + "=", StringComparison.Ordinal));

        Assert.StartsWith("__Host-", setCookie, StringComparison.Ordinal);
        Assert.Contains("httponly", setCookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("secure", setCookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("samesite=lax", setCookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("path=/", setCookie, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("domain=", setCookie, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(password, setCookie);   // la cookie no lleva ni la contrasena ni el correo en claro
        Assert.DoesNotContain(email, setCookie);
    }

    [Fact]
    public async Task Login_DoesNotRevealWhetherTheAccountExists_AndLocksOutAfterRepeatedFailures()
    {
        var (email, password) = await Cookies.RegisterAsync();

        var (unknown, unknownCookie) = await Cookies.LoginAsync(TestSecrets.NewEmail(), password);
        var (wrong, wrongCookie) = await Cookies.LoginAsync(email, TestSecrets.NewPassword());

        Assert.Equal(HttpStatusCode.Unauthorized, unknown.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, wrong.StatusCode);
        Assert.Null(unknownCookie);
        Assert.Null(wrongCookie);
        Assert.Equal(await unknown.Content.ReadAsStringAsync(), await wrong.Content.ReadAsStringAsync());

        // Fuerza bruta: tras 5 fallos la cuenta se bloquea y ni la contrasena correcta entra (sin cambiar la respuesta).
        for (var i = 0; i < 5; i++)
        {
            await Cookies.LoginAsync(email, TestSecrets.NewPassword());
        }

        var (locked, lockedCookie) = await Cookies.LoginAsync(email, password);
        Assert.Equal(HttpStatusCode.Unauthorized, locked.StatusCode);
        Assert.Null(lockedCookie);
        Assert.Equal(await unknown.Content.ReadAsStringAsync(), await locked.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Register_IsUniformForExistingAccounts_AndRejectsWeakPasswords()
    {
        var (email, password) = await Cookies.RegisterAsync();
        using var client = Cookies.CreateAnonymousClient();

        var again = await client.PostAsJsonAsync("/poc/identity/register", new { email, password });
        var fresh = await client.PostAsJsonAsync("/poc/identity/register", new { email = TestSecrets.NewEmail(), password });
        var weak = await client.PostAsJsonAsync("/poc/identity/register", new { email = TestSecrets.NewEmail(), password = "short" });

        Assert.Equal(HttpStatusCode.OK, again.StatusCode);
        Assert.Equal(HttpStatusCode.OK, fresh.StatusCode);
        Assert.Equal(await fresh.Content.ReadAsStringAsync(), await again.Content.ReadAsStringAsync());
        Assert.Equal(HttpStatusCode.BadRequest, weak.StatusCode);
    }

    [Fact]
    public async Task UnsafeRequestsWithTheCookie_NeedTheCustomHeader_AndAnAllowedOrigin()
    {
        var actor = await Cookies.SignUpAsync();
        var cookie = actor.Client.DefaultRequestHeaders.GetValues("Cookie").Single();

        // Un formulario/imagen de otro sitio viaja con la cookie (SameSite aparte) pero SIN la cabecera personalizada.
        using var forged = Cookies.CreateClientWithCookie(cookie, withCsrfHeader: false);
        Assert.Equal(HttpStatusCode.Forbidden, (await forged.PostAsJsonAsync("/api/v2/projects", new { name = "csrf" })).StatusCode);

        // Con la cabecera pero desde un origen no autorizado: tampoco.
        using var evilOrigin = Cookies.CreateClientWithCookie(cookie);
        evilOrigin.DefaultRequestHeaders.Add("Origin", "https://evil.poc.test");
        Assert.Equal(HttpStatusCode.Forbidden, (await evilOrigin.PostAsJsonAsync("/api/v2/projects", new { name = "csrf" })).StatusCode);

        // La SPA legitima (cabecera + origen permitido) si puede.
        using var legit = Cookies.CreateClientWithCookie(cookie);
        legit.DefaultRequestHeaders.Add("Origin", CookieHarness.AllowedOrigin);
        Assert.Equal(HttpStatusCode.Created, (await legit.PostAsJsonAsync("/api/v2/projects", new { name = "ok" })).StatusCode);

        // Las lecturas no exigen la cabecera (son seguras e idempotentes).
        using var read = Cookies.CreateClientWithCookie(cookie, withCsrfHeader: false);
        Assert.Equal(HttpStatusCode.OK, (await read.GetAsync("/api/v2/projects")).StatusCode);

        Assert.Equal(["ok"], await ListNamesAsync(actor.Client));
    }

    [Fact]
    public async Task Cors_AllowsCredentialsOnlyForTheConfiguredOrigin()
    {
        using var client = Cookies.CreateRawClient();

        using var allowed = new HttpRequestMessage(HttpMethod.Options, "/api/v2/projects");
        allowed.Headers.Add("Origin", CookieHarness.AllowedOrigin);
        allowed.Headers.Add("Access-Control-Request-Method", "POST");
        allowed.Headers.Add("Access-Control-Request-Headers", AuthPocHostOptions.CsrfHeaderName);
        var allowedResponse = await client.SendAsync(allowed);

        Assert.Equal(CookieHarness.AllowedOrigin, allowedResponse.Headers.GetValues("Access-Control-Allow-Origin").Single());
        Assert.Equal("true", allowedResponse.Headers.GetValues("Access-Control-Allow-Credentials").Single());

        using var evil = new HttpRequestMessage(HttpMethod.Options, "/api/v2/projects");
        evil.Headers.Add("Origin", "https://evil.poc.test");
        evil.Headers.Add("Access-Control-Request-Method", "POST");
        var evilResponse = await client.SendAsync(evil);

        Assert.False(evilResponse.Headers.Contains("Access-Control-Allow-Origin"));
    }

    [Fact]
    public async Task RotatingTheSecurityStamp_RevokesTheSessionsAlreadyIssued()
    {
        var actor = await Cookies.SignUpAsync();
        Assert.Equal(HttpStatusCode.OK, (await actor.Client.GetAsync("/api/v2/projects")).StatusCode);

        // Es lo que haria "cambiar contrasena" / "cerrar sesion en todos lados" (S04, S08, S09).
        using (var scope = Cookies.Services.CreateScope())
        {
            var users = scope.ServiceProvider.GetRequiredService<UserManager<IdentityUser<Guid>>>();
            var user = (await users.FindByEmailAsync(actor.Email))!;
            Assert.True((await users.UpdateSecurityStampAsync(user)).Succeeded);
        }

        Assert.Equal(HttpStatusCode.Unauthorized, (await actor.Client.GetAsync("/api/v2/projects")).StatusCode);
    }
}
