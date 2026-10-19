using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Vectorify.Api.Contracts;
using Vectorify.Api.Endpoints;
using Vectorify.Api.Tests.TestSupport;

namespace Vectorify.Api.Tests.EndToEnd;

/// <summary>
/// Límites de frecuencia de LOGIN y REGISTRO (M3.1-S09), con el limitador nativo de S08 como base: por IP (política de la ruta) y por dirección hasheada (contador en memoria con HMAC).
/// Al excederse: 429 + <c>Retry-After</c>; el contador por dirección cuenta TODO intento exista o no la cuenta, así que el 429 es indistinguible entre cuentas existentes e inexistentes
/// (T5), y NO reemplaza ni suma al bloqueo de cuenta de S03 (T6).
/// </summary>
[Collection(AuthRecoveryCollection.Name)]
public sealed class AuthLoginRegisterRateLimitTests : IAsyncLifetime
{
    private const string Wrong = "una-contrasena-erronea-9";

    private readonly AuthApiFixture _fixture;
    private readonly List<RecoveryHost> _hosts = [];
    private string _connectionString = string.Empty;

    public AuthLoginRegisterRateLimitTests(AuthApiFixture fixture)
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

    private RecoveryHost CreateHost(IDictionary<string, string?> settings)
    {
        var host = RecoveryHost.Create(_fixture, _connectionString, settings);
        _hosts.Add(host);
        return host;
    }

    private static Dictionary<string, string?> Limits(
        int loginIp = 100000, int loginAddress = 100000, int registerIp = 100000, int registerAddress = 100000) => new()
    {
        ["Auth:RateLimit:LoginIpPermitLimit"] = loginIp.ToString(CultureInfo.InvariantCulture),
        ["Auth:RateLimit:LoginAddressPermitLimit"] = loginAddress.ToString(CultureInfo.InvariantCulture),
        ["Auth:RateLimit:RegisterIpPermitLimit"] = registerIp.ToString(CultureInfo.InvariantCulture),
        ["Auth:RateLimit:RegisterAddressPermitLimit"] = registerAddress.ToString(CultureInfo.InvariantCulture),
    };

    private static Task<HttpResponseMessage> Register(RecoveryHost host, string email, string password = RecoveryHost.Password, string? ip = null) =>
        host.PostAsync(AuthEndpoints.RegisterPath, new RegisterRequest(email, password), ip: ip);

    private static Task<HttpResponseMessage> Login(RecoveryHost host, string email, string password, string? ip = null) =>
        host.PostAsync(AuthEndpoints.LoginPath, new LoginRequest(email, password), ip: ip);

    private static async Task<string> CodeOf(HttpResponseMessage response)
    {
        using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        return body.RootElement.GetProperty("code").GetString()!;
    }

    private static void AssertRateLimited(HttpResponseMessage response, int maxSeconds)
    {
        Assert.Equal(HttpStatusCode.TooManyRequests, response.StatusCode);
        var retryAfter = Assert.Single(response.Headers.GetValues("Retry-After"));
        Assert.InRange(int.Parse(retryAfter, CultureInfo.InvariantCulture), 1, maxSeconds);
        Assert.Equal("no-store", response.Headers.CacheControl?.ToString());
        Assert.Equal(RecoveryHost.PublicBaseUrl, Assert.Single(response.Headers.GetValues("Access-Control-Allow-Origin")));
        Assert.Contains("Retry-After", string.Join(",", response.Headers.GetValues("Access-Control-Expose-Headers")), StringComparison.OrdinalIgnoreCase);
    }

    // ------------------------------------------------------------------------------------------------------ login por IP

    [Fact]
    public async Task Login_PerIp_TheRequestOverTheLimitGets429WithRetryAfter_AndAnotherIpIsUnaffected()
    {
        var settings = Limits(loginIp: 3);
        settings["Auth:RateLimit:LoginIpWindow"] = "00:10:00";
        var host = CreateHost(settings);

        for (var i = 0; i < 3; i++)
        {
            // Correos distintos: el límite por dirección no interviene, solo el de la IP.
            Assert.Equal(HttpStatusCode.Unauthorized, (await Login(host, RecoveryHost.NewEmail(), Wrong, ip: "10.9.0.1")).StatusCode);
        }

        var limited = await Login(host, RecoveryHost.NewEmail(), Wrong, ip: "10.9.0.1");

        AssertRateLimited(limited, 600);
        Assert.Equal("rate_limited", await CodeOf(limited));
        Assert.Equal(HttpStatusCode.Unauthorized, (await Login(host, RecoveryHost.NewEmail(), Wrong, ip: "10.9.0.2")).StatusCode);
    }

    [Fact]
    public async Task Login_PerIp_ACorrectPasswordIsAlsoRefusedOnceTheIpIsOverTheLimit()
    {
        var host = CreateHost(Limits(loginIp: 2));
        var email = await host.RegisterAsync();

        Assert.Equal(HttpStatusCode.Unauthorized, (await Login(host, RecoveryHost.NewEmail(), Wrong, ip: "10.9.0.3")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await Login(host, email, RecoveryHost.Password, ip: "10.9.0.3")).StatusCode);

        var third = await Login(host, email, RecoveryHost.Password, ip: "10.9.0.3");

        Assert.Equal(HttpStatusCode.TooManyRequests, third.StatusCode);
        Assert.Empty(RecoveryHost.SessionSetCookies(third)); // el límite se aplica antes de abrir sesión
    }

    // -------------------------------------------------------------------------------------------------- login por dirección

    [Fact]
    public async Task Login_PerAddress_TheExcessIs429_ForAnExistingAndForAnUnknownAccount_WithTheSameBodyAndStatus()
    {
        var host = CreateHost(Limits(loginAddress: 2));
        var existing = await host.RegisterAsync();
        var unknown = RecoveryHost.NewEmail();

        foreach (var email in new[] { existing, unknown })
        {
            Assert.Equal(HttpStatusCode.Unauthorized, (await Login(host, email, Wrong)).StatusCode);
            Assert.Equal(HttpStatusCode.Unauthorized, (await Login(host, email, Wrong)).StatusCode);
        }

        var onExisting = await Login(host, existing, Wrong);
        var onUnknown = await Login(host, unknown, Wrong);

        AssertRateLimited(onExisting, 900);
        AssertRateLimited(onUnknown, 900);
        Assert.Equal(await onExisting.Content.ReadAsStringAsync(), await onUnknown.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Login_PerAddress_CountsEveryAttempt_EvenSuccessfulOnes_AndIgnoresCaseAndSpaces()
    {
        var host = CreateHost(Limits(loginAddress: 2));
        var email = await host.RegisterAsync();

        Assert.Equal(HttpStatusCode.OK, (await Login(host, email, RecoveryHost.Password)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await Login(host, "  " + email.ToUpperInvariant() + " ", RecoveryHost.Password)).StatusCode);

        var third = await Login(host, email, RecoveryHost.Password);

        Assert.Equal(HttpStatusCode.TooManyRequests, third.StatusCode);
        Assert.Empty(RecoveryHost.SessionSetCookies(third));
        // Otra dirección no se ve afectada.
        Assert.Equal(HttpStatusCode.OK, (await Login(host, await host.RegisterAsync(), RecoveryHost.Password)).StatusCode);
    }

    [Fact]
    public async Task Login_RateLimitedAttempts_DoNotCountTowardsTheAccountLockout()
    {
        var host = CreateHost(Limits(loginAddress: 2));
        var email = await host.RegisterAsync();

        for (var i = 0; i < 8; i++)
        {
            await Login(host, email, Wrong); // 2 llegan a comprobar la contraseña; el resto da 429 sin tocar la cuenta
        }

        var failures = await host.Fixture.ScalarAsync<int>(
            host.ConnectionString,
            "SELECT \"AccessFailedCount\" FROM auth.\"AspNetUsers\" WHERE \"NormalizedEmail\" = @e",
            ("e", email.ToUpperInvariant()));
        Assert.Equal(2, failures);
    }

    [Fact]
    public async Task Login_TheAccountLockoutOfS03StillApplies_WithTheRateLimitAtItsHeadroom()
    {
        var settings = Limits(loginAddress: 50, loginIp: 50);
        settings["Auth:Lockout:MaxAttempts"] = "3";
        var host = CreateHost(settings);
        var email = await host.RegisterAsync();

        for (var i = 0; i < 3; i++)
        {
            Assert.Equal(HttpStatusCode.Unauthorized, (await Login(host, email, Wrong)).StatusCode);
        }

        // Bloqueada: ni la contraseña correcta entra, y la respuesta es el MISMO 401 uniforme (no un 429, no un código distinto).
        var locked = await Login(host, email, RecoveryHost.Password);
        var wrongPassword = await Login(host, await host.RegisterAsync(), Wrong);

        Assert.Equal(HttpStatusCode.Unauthorized, locked.StatusCode);
        Assert.Equal(AuthEndpoints.InvalidCredentialsCode, await CodeOf(locked));
        Assert.Equal(await wrongPassword.Content.ReadAsStringAsync(), await locked.Content.ReadAsStringAsync());
    }

    // ------------------------------------------------------------------------------------------------------- registro

    [Fact]
    public async Task Register_PerIp_TheRequestOverTheLimitGets429WithRetryAfter_AndAnotherIpIsUnaffected()
    {
        var settings = Limits(registerIp: 2);
        settings["Auth:RateLimit:RegisterIpWindow"] = "00:30:00";
        var host = CreateHost(settings);

        Assert.Equal(HttpStatusCode.Accepted, (await Register(host, RecoveryHost.NewEmail(), ip: "10.9.1.1")).StatusCode);
        Assert.Equal(HttpStatusCode.Accepted, (await Register(host, RecoveryHost.NewEmail(), ip: "10.9.1.1")).StatusCode);

        var limited = await Register(host, RecoveryHost.NewEmail(), ip: "10.9.1.1");

        AssertRateLimited(limited, 1800);
        Assert.Equal(HttpStatusCode.Accepted, (await Register(host, RecoveryHost.NewEmail(), ip: "10.9.1.2")).StatusCode);
    }

    [Fact]
    public async Task Register_PerAddress_TheExcessIs429_ForAnExistingAndANewAddress_AndNothingIsCreatedWhenLimited()
    {
        var host = CreateHost(Limits(registerAddress: 2));
        var existing = await host.RegisterAsync(); // intento 1 del correo existente
        var fresh = RecoveryHost.NewEmail();

        // Intento 2 de cada uno: el del correo nuevo es una contraseña débil (400), que también cuenta (el límite va antes de validar la contraseña).
        Assert.Equal(HttpStatusCode.Accepted, (await Register(host, existing)).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await Register(host, fresh, "corta")).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await Register(host, fresh, "corta2")).StatusCode);

        var onExisting = await Register(host, existing);
        var onFresh = await Register(host, fresh); // contraseña válida, pero el cupo de la dirección ya se agotó

        AssertRateLimited(onExisting, 3600);
        AssertRateLimited(onFresh, 3600);
        Assert.Equal(await onExisting.Content.ReadAsStringAsync(), await onFresh.Content.ReadAsStringAsync());
        var created = await host.Fixture.ScalarAsync<long>(
            host.ConnectionString, "SELECT COUNT(*) FROM auth.\"AspNetUsers\" WHERE \"NormalizedEmail\" = @e", ("e", fresh.ToUpperInvariant()));
        Assert.Equal(0, created); // un intento limitado no crea cuenta (ni envía correo)
    }

    [Fact]
    public async Task Register_WithinTheLimits_KeepsTheUniform202ForNewAndExistingEmails()
    {
        var host = CreateHost(Limits(registerAddress: 5, registerIp: 50));
        var existing = await host.RegisterAsync();

        var again = await Register(host, existing);
        var fresh = await Register(host, RecoveryHost.NewEmail());

        Assert.Equal(HttpStatusCode.Accepted, again.StatusCode);
        Assert.Equal(await again.Content.ReadAsStringAsync(), await fresh.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task LoginAndRegister_HaveIndependentCounters_AndDoNotConsumeTheRecoveryOnes()
    {
        var settings = Limits(loginIp: 1, registerIp: 1);
        settings["Auth:RateLimit:IpPermitLimit"] = "5";
        var host = CreateHost(settings);

        Assert.Equal(HttpStatusCode.Unauthorized, (await Login(host, RecoveryHost.NewEmail(), Wrong, ip: "10.9.2.1")).StatusCode);
        Assert.Equal(HttpStatusCode.TooManyRequests, (await Login(host, RecoveryHost.NewEmail(), Wrong, ip: "10.9.2.1")).StatusCode);
        Assert.Equal(HttpStatusCode.Accepted, (await Register(host, RecoveryHost.NewEmail(), ip: "10.9.2.1")).StatusCode);
        Assert.Equal(HttpStatusCode.TooManyRequests, (await Register(host, RecoveryHost.NewEmail(), ip: "10.9.2.1")).StatusCode);
        Assert.Equal(
            HttpStatusCode.Accepted,
            (await host.PostAsync(AuthRecoveryEndpoints.ForgotPasswordPath, new ForgotPasswordRequest(RecoveryHost.NewEmail()), ip: "10.9.2.1")).StatusCode);
    }

    [Fact]
    public async Task ARejectedCsrfRequest_DoesNotSpendTheLoginQuota()
    {
        var host = CreateHost(Limits(loginIp: 1));
        using var noCsrf = host.Factory.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { HandleCookies = false });
        noCsrf.DefaultRequestHeaders.Add(TestRemoteIpMiddleware.HeaderName, "10.9.3.1");

        for (var i = 0; i < 3; i++)
        {
            var rejected = await noCsrf.PostAsJsonAsync(AuthEndpoints.LoginPath, new LoginRequest(RecoveryHost.NewEmail(), Wrong));
            Assert.Equal(HttpStatusCode.Forbidden, rejected.StatusCode);
        }

        Assert.Equal(HttpStatusCode.Unauthorized, (await Login(host, RecoveryHost.NewEmail(), Wrong, ip: "10.9.3.1")).StatusCode);
    }
}
