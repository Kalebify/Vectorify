using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Vectorify.Api.Contracts;
using Vectorify.Api.Endpoints;
using Vectorify.Api.Middleware;
using Vectorify.Api.Options;
using Vectorify.Api.Tests.TestSupport;

namespace Vectorify.Api.Tests.EndToEnd;

/// <summary>
/// Ciclo de vida de la sesión (M3.1-S04) contra la Web API REAL y PostgreSQL real (Testcontainers): cookie con y sin «recordarme»,
/// caducidad deslizante, tope absoluto, cookie caducada/manipulada, ventana de revalidación del SecurityStamp, desfase de reloj,
/// «cerrar sesión en todos lados» y key ring persistente. El tiempo lo gobierna <see cref="ControllableTimeProvider"/> (nada duerme);
/// todas las cookies las emite el SERVIDOR en <c>POST /api/v1/auth/login</c>.
/// </summary>
public sealed class AuthSessionLifecycleTests : IClassFixture<AuthApiFixture>, IAsyncLifetime
{
    private const string Password = "una-contrasena-larga-1";
    private const string CookieName = "vectorify.session"; // appsettings.Development.json

    private static readonly WebApplicationFactoryClientOptions NoCookieJar = new() { HandleCookies = false };

    private readonly AuthApiFixture _fixture;
    private readonly ControllableTimeProvider _clock = new();
    private readonly List<IAsyncDisposable> _disposables = [];
    private readonly List<string> _directories = [];
    private string _connectionString = string.Empty;

    public AuthSessionLifecycleTests(AuthApiFixture fixture)
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

        foreach (var directory in _directories.Where(Directory.Exists))
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    // ------------------------------------------------------------------------------------------- opciones por defecto

    [Fact]
    public async Task Defaults_AreTheAdrValues_EightHoursSliding_ThirtyDaysRemembered_FiveMinuteRevalidation()
    {
        var host = CreateHost(interval: null);

        await host.Client.GetAsync("/health"); // fuerza la construcción del host
        var options = host.Factory.Services.GetRequiredService<Microsoft.Extensions.Options.IOptions<AuthOptions>>().Value;

        Assert.Equal(TimeSpan.FromHours(8), options.Cookie.Lifetime);
        Assert.Equal(TimeSpan.FromDays(30), options.Cookie.RememberMeLifetime);
        Assert.Equal(TimeSpan.FromMinutes(5), options.Session.RevalidationInterval);
        Assert.Equal(TimeSpan.FromSeconds(30), options.Session.ClockSkew);
    }

    // ------------------------------------------------------------------------------------------- atributos de la cookie

    [Fact]
    public async Task Login_WithoutRememberMe_IssuesABrowserSessionCookie_WithoutExpiresNorMaxAge()
    {
        var host = CreateHost();
        var email = await RegisterAsync(host);

        foreach (var body in new object[]
                 {
                     new { email, password = Password },                       // campo ausente
                     new { email, password = Password, rememberMe = false },
                     new { email, password = Password, rememberMe = (bool?)null },
                 })
        {
            var response = await host.Client.PostAsJsonAsync(AuthEndpoints.LoginPath, body);

            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            var setCookie = Assert.Single(SessionSetCookies(response));
            var attributes = Attributes(setCookie);
            Assert.DoesNotContain(attributes, a => a.StartsWith("expires=", StringComparison.Ordinal));
            Assert.DoesNotContain(attributes, a => a.StartsWith("max-age=", StringComparison.Ordinal));
            Assert.Contains("httponly", attributes);
            Assert.Contains("samesite=lax", attributes);
            Assert.Contains("path=/", attributes);
        }
    }

    [Fact]
    public async Task Login_WithRememberMe_IssuesAPersistentCookie_ExpiringAtTheAbsoluteCap()
    {
        var host = CreateHost();
        var email = await RegisterAsync(host);

        var response = await LoginAsync(host, email, rememberMe: true);

        var setCookie = Assert.Single(SessionSetCookies(response));
        var attributes = Attributes(setCookie);
        Assert.Contains("httponly", attributes);
        Assert.Contains("samesite=lax", attributes);
        Assert.Contains("path=/", attributes);
        Assert.DoesNotContain(attributes, a => a.StartsWith("domain", StringComparison.Ordinal));
        Assert.Equal(_clock.Now + TimeSpan.FromDays(30), ExpiresOf(setCookie), TimeSpan.FromSeconds(1));
        Assert.Contains($"max-age={(long)TimeSpan.FromDays(30).TotalSeconds}", attributes);
    }

    [Fact]
    public async Task Login_WithRememberMe_UsingProductionStyleOptions_IsSecureHostPrefixedAndPersistent()
    {
        var host = CreateHost(extra: new Dictionary<string, string?>
        {
            ["Auth:Cookie:Name"] = "__Host-vectorify.session",
            ["Auth:Cookie:SecurePolicy"] = "Always",
        });
        var email = await RegisterAsync(host);

        var response = await LoginAsync(host, email, rememberMe: true);

        var setCookie = Assert.Single(SessionSetCookies(response, "__Host-vectorify.session"));
        var attributes = Attributes(setCookie);
        Assert.Contains("secure", attributes);
        Assert.Contains("httponly", attributes);
        Assert.Contains("samesite=lax", attributes);
        Assert.Contains("path=/", attributes);
        Assert.DoesNotContain(attributes, a => a.StartsWith("domain", StringComparison.Ordinal));
        Assert.Contains(attributes, a => a.StartsWith("expires=", StringComparison.Ordinal));
        Assert.Contains(attributes, a => a.StartsWith("max-age=", StringComparison.Ordinal));
    }

    [Fact]
    public async Task RememberMeLifetime_IsConfigurable()
    {
        var host = CreateHost(extra: new Dictionary<string, string?> { ["Auth:Cookie:RememberMeLifetime"] = "7.00:00:00" });
        var email = await RegisterAsync(host);

        var response = await LoginAsync(host, email, rememberMe: true);

        Assert.Equal(_clock.Now + TimeSpan.FromDays(7), ExpiresOf(Assert.Single(SessionSetCookies(response))), TimeSpan.FromSeconds(1));
    }

    [Fact]
    public async Task Login_RememberMeWithANonBooleanValue_IsRejectedWith400_AndOpensNoSession()
    {
        var host = CreateHost();
        var email = await RegisterAsync(host);

        var response = await host.Client.PostAsJsonAsync(
            AuthEndpoints.LoginPath, new { email, password = Password, rememberMe = "siempre" });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Empty(SessionSetCookies(response));
    }

    // ------------------------------------------------------------------------------------ expiración deslizante (8 h)

    [Fact]
    public async Task SessionCookie_SlidesWhileUsed_AndExpiresAfterEightHoursOfInactivity()
    {
        var host = CreateHost(interval: "00:05:00");
        var email = await RegisterAsync(host);
        var first = CookieOf(await LoginAsync(host, email));

        // +7 h: sigue válida y el servidor la renueva (deslizante).
        _clock.Advance(TimeSpan.FromHours(7));
        var usedAtSevenHours = await MeAsync(host, first);
        Assert.Equal(HttpStatusCode.OK, usedAtSevenHours.StatusCode);
        var renewed = CookieOf(usedAtSevenHours);

        // +14 h (la original ya pasó sus 8 h; la renovada vence a las 15 h): la renovada vive, la original no.
        _clock.Advance(TimeSpan.FromHours(7));
        Assert.Equal(HttpStatusCode.Unauthorized, (await MeAsync(host, first)).StatusCode);
        var usedAtFourteenHours = await MeAsync(host, renewed);
        Assert.Equal(HttpStatusCode.OK, usedAtFourteenHours.StatusCode);
        var renewedAgain = CookieOf(usedAtFourteenHours);

        // 8 h y 1 min sin usarla: caduca por inactividad.
        _clock.Advance(TimeSpan.FromHours(8) + TimeSpan.FromMinutes(1));
        Assert.Equal(HttpStatusCode.Unauthorized, (await MeAsync(host, renewedAgain)).StatusCode);
    }

    [Fact]
    public async Task SessionCookie_RenewedCookie_StaysABrowserSessionCookie()
    {
        var host = CreateHost(interval: "00:05:00");
        var email = await RegisterAsync(host);
        var login = await LoginAsync(host, email);

        _clock.Advance(TimeSpan.FromHours(5));
        var renewal = await MeAsync(host, CookieOf(login));

        var setCookie = Assert.Single(SessionSetCookies(renewal));
        Assert.DoesNotContain(Attributes(setCookie), a => a.StartsWith("expires=", StringComparison.Ordinal));
    }

    [Fact]
    public async Task SessionCookie_ExactlyAtTheLifetime_IsStillOneSecondBeforeAndGoneAfter()
    {
        var host = CreateHost(interval: "08:00:00"); // sin revalidación en la ventana: aísla la caducidad del ticket
        var email = await RegisterAsync(host);
        var cookie = CookieOf(await LoginAsync(host, email));

        _clock.Advance(TimeSpan.FromHours(8) - TimeSpan.FromSeconds(1));
        Assert.Equal(HttpStatusCode.OK, (await MeAsync(host, cookie)).StatusCode);

        _clock.Advance(TimeSpan.FromSeconds(2));
        Assert.Equal(HttpStatusCode.Unauthorized, (await MeAsync(host, cookie)).StatusCode);
    }

    // ------------------------------------------------------------------------------- «recordarme»: tope ABSOLUTO (30 d)

    [Fact]
    public async Task RememberMe_IsAnAbsoluteCap_ActivityAndRevalidationNeverExtendIt()
    {
        var host = CreateHost(interval: "00:05:00");
        var email = await RegisterAsync(host);
        var loginResponse = await LoginAsync(host, email, rememberMe: true);
        var loggedInAt = _clock.Now;
        var absoluteCap = loggedInAt + TimeSpan.FromDays(30);
        var cookie = CookieOf(loginResponse);

        // Uso diario durante 29 días: cada request revalida (> 5 min) y el servidor reemite la cookie, pero SIEMPRE con el mismo tope.
        for (var day = 1; day <= 29; day++)
        {
            _clock.Advance(TimeSpan.FromDays(1));
            var response = await MeAsync(host, cookie);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            var renewal = Assert.Single(SessionSetCookies(response));
            Assert.Equal(absoluteCap, ExpiresOf(renewal), TimeSpan.FromSeconds(1));
            cookie = CookieOf(response);
        }

        // Pasado el tope absoluto, ni la cookie original ni la última renovada valen, aunque se usaran hace un minuto.
        _clock.Advance(TimeSpan.FromDays(1) + TimeSpan.FromMinutes(1));
        Assert.Equal(HttpStatusCode.Unauthorized, (await MeAsync(host, cookie)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await MeAsync(host, CookieOf(loginResponse))).StatusCode);
    }

    [Fact]
    public async Task RememberMe_CookieNeverUsed_ExpiresAtTheAbsoluteCap_NotBefore()
    {
        var host = CreateHost(interval: "00:05:00");
        var email = await RegisterAsync(host);
        var cookie = CookieOf(await LoginAsync(host, email, rememberMe: true));

        // Muy por encima de las 8 h de una sesión normal: «recordarme» no es deslizante por inactividad.
        _clock.Advance(TimeSpan.FromDays(20));
        Assert.Equal(HttpStatusCode.OK, (await MeAsync(host, cookie)).StatusCode);

        _clock.Advance(TimeSpan.FromDays(10) + TimeSpan.FromSeconds(1));
        Assert.Equal(HttpStatusCode.Unauthorized, (await MeAsync(host, cookie)).StatusCode);
    }

    // -------------------------------------------------------------------------- caducada / manipulada / sin cookie ⇒ 401

    [Fact]
    public async Task ExpiredCookie_Returns401_OnMe_AndOnALoggedEndpoint_WithoutReissuingACookie()
    {
        var host = CreateHost();
        var email = await RegisterAsync(host);
        var cookie = CookieOf(await LoginAsync(host, email));

        _clock.Advance(TimeSpan.FromHours(9));

        var me = await MeAsync(host, cookie);
        var logoutAll = await SendAsync(host, HttpMethod.Post, AuthEndpoints.LogoutAllPath, cookie);
        Assert.Equal(HttpStatusCode.Unauthorized, me.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, logoutAll.StatusCode);
    }

    [Fact]
    public async Task TamperedCookie_Returns401_WhateverPartIsAltered()
    {
        var host = CreateHost();
        var email = await RegisterAsync(host);
        var cookie = CookieOf(await LoginAsync(host, email));
        var value = cookie[(cookie.IndexOf('=') + 1)..];

        string[] tampered =
        [
            Flip(value, value.Length / 2),
            Flip(value, 0),
            Flip(value, value.Length - 3),             // (no el último carácter: en base64 sus bits sobrantes no cambian los bytes)
            value[..(value.Length / 2)],               // truncada
            value + "AAAA",                            // alargada
            new string('A', value.Length),             // basura del mismo largo
            "garbage",
        ];

        foreach (var altered in tampered)
        {
            var response = await MeAsync(host, $"{CookieName}={altered}");
            Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        }

        Assert.Equal(HttpStatusCode.OK, (await MeAsync(host, cookie)).StatusCode); // el control: la original sigue valiendo
    }

    // ------------------------------------------------------ revalidación del SecurityStamp: ventana y desfase de reloj

    [Fact]
    public async Task RevokedCookie_StopsWorking_OnlyAfterTheRevalidationWindow_FiveMinutesByDefault()
    {
        var host = CreateHost(interval: null); // default: 5 min
        var email = await RegisterAsync(host);
        var stolen = CookieOf(await LoginAsync(host, email));
        var legitimate = CookieOf(await LoginAsync(host, email));

        // La persona cierra sesión en todos lados con su cookie legítima: el stamp rota YA en la base.
        Assert.Equal(HttpStatusCode.NoContent, (await SendAsync(host, HttpMethod.Post, AuthEndpoints.LogoutAllPath, legitimate)).StatusCode);

        // La copia robada todavía no se revalidó: dentro de la ventana de 5 min sigue funcionando (límite documentado)...
        _clock.Advance(TimeSpan.FromMinutes(4));
        Assert.Equal(HttpStatusCode.OK, (await MeAsync(host, stolen)).StatusCode);

        // ...y en cuanto pasa el intervalo desde la emisión, se revalida contra la base y muere.
        _clock.Advance(TimeSpan.FromMinutes(2));
        Assert.Equal(HttpStatusCode.Unauthorized, (await MeAsync(host, stolen)).StatusCode);
    }

    [Fact]
    public async Task RevokedCookie_WithRevalidationAtZero_StopsWorkingOnTheNextRequest()
    {
        var host = CreateHost(); // 0 = en cada request
        var email = await RegisterAsync(host);
        var other = CookieOf(await LoginAsync(host, email));
        var mine = CookieOf(await LoginAsync(host, email));

        await SendAsync(host, HttpMethod.Post, AuthEndpoints.LogoutAllPath, mine);

        // El validador revalida cuando (ahora - IssuedUtc) SUPERA el intervalo: con el reloj congelado hay que dejar pasar un instante.
        _clock.Advance(TimeSpan.FromSeconds(1));
        Assert.Equal(HttpStatusCode.Unauthorized, (await MeAsync(host, other)).StatusCode);
    }

    [Fact]
    public async Task ClockSkew_ATicketIssuedInTheFuture_IsRevalidatedImmediately_SoDriftDoesNotExtendTheRevocationWindow()
    {
        var host = CreateHost(interval: "00:05:00");
        var email = await RegisterAsync(host);

        // Una instancia con el reloj 1 h ADELANTADO emite el ticket de la copia robada y el de la legítima.
        _clock.Advance(TimeSpan.FromHours(1));
        var stolen = CookieOf(await LoginAsync(host, email));
        var legitimate = CookieOf(await LoginAsync(host, email));

        // Esta instancia tiene el reloj en su hora real: el ticket está «emitido en el futuro» (+1 h > ClockSkew de 30 s).
        _clock.Advance(-TimeSpan.FromHours(1));
        await SendAsync(host, HttpMethod.Post, AuthEndpoints.LogoutAllPath, legitimate);

        // Sin la guarda, (ahora - IssuedUtc) sería negativo y no se revalidaría hasta ~65 min después.
        Assert.Equal(HttpStatusCode.Unauthorized, (await MeAsync(host, stolen)).StatusCode);
    }

    [Fact]
    public async Task ClockSkew_AValidTicketWithinTheTolerance_IsNotForcedToRevalidate()
    {
        var host = CreateHost(interval: "00:05:00");
        var email = await RegisterAsync(host);
        _clock.Advance(TimeSpan.FromSeconds(20)); // desfase de 20 s < 30 s
        var cookie = CookieOf(await LoginAsync(host, email));
        var other = CookieOf(await LoginAsync(host, email));
        _clock.Advance(-TimeSpan.FromSeconds(20));
        await SendAsync(host, HttpMethod.Post, AuthEndpoints.LogoutAllPath, other);

        // Dentro de la tolerancia rige el intervalo normal: todavía no se revalidó.
        Assert.Equal(HttpStatusCode.OK, (await MeAsync(host, cookie)).StatusCode);
    }

    // ------------------------------------------------------------------------------- «cerrar sesión en todos lados»

    [Fact]
    public async Task LogoutAll_WithoutSession_Returns401_AndRotatesNothing()
    {
        var host = CreateHost();
        var email = await RegisterAsync(host);
        var stampBefore = await StampAsync(email);

        var response = await SendAsync(host, HttpMethod.Post, AuthEndpoints.LogoutAllPath, cookie: null);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Equal(stampBefore, await StampAsync(email));
    }

    [Fact]
    public async Task LogoutAll_RotatesTheStamp_ClearsThisBrowsersCookie_AndInvalidatesEverySession()
    {
        var host = CreateHost();
        var email = await RegisterAsync(host);
        var stampBefore = await StampAsync(email);
        var tabA = CookieOf(await LoginAsync(host, email));
        var tabB = CookieOf(await LoginAsync(host, email, rememberMe: true));

        var response = await SendAsync(host, HttpMethod.Post, AuthEndpoints.LogoutAllPath, tabA);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.NotEqual(stampBefore, await StampAsync(email));
        _clock.Advance(TimeSpan.FromSeconds(1)); // reloj congelado: (ahora - IssuedUtc) debe superar el intervalo de 0 para revalidar
        var cleared = Assert.Single(SessionSetCookies(response));
        Assert.StartsWith($"{CookieName}=;", cleared, StringComparison.Ordinal);
        Assert.Contains("expires=Thu, 01 Jan 1970", cleared, StringComparison.OrdinalIgnoreCase);
        Assert.StartsWith("no-store", response.Headers.CacheControl?.ToString() ?? string.Empty, StringComparison.Ordinal);
        Assert.Equal(HttpStatusCode.Unauthorized, (await MeAsync(host, tabA)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await MeAsync(host, tabB)).StatusCode);

        // Y se puede volver a entrar con la misma cuenta.
        Assert.Equal(HttpStatusCode.OK, (await MeAsync(host, CookieOf(await LoginAsync(host, email)))).StatusCode);
    }

    [Fact]
    public async Task LogoutAll_OnlyAffectsTheAuthenticatedAccount()
    {
        var host = CreateHost();
        var mine = await RegisterAsync(host);
        var theirs = await RegisterAsync(host);
        var myCookie = CookieOf(await LoginAsync(host, mine));
        var theirCookie = CookieOf(await LoginAsync(host, theirs));
        var theirStamp = await StampAsync(theirs);

        await SendAsync(host, HttpMethod.Post, AuthEndpoints.LogoutAllPath, myCookie);

        Assert.Equal(theirStamp, await StampAsync(theirs));
        Assert.Equal(HttpStatusCode.OK, (await MeAsync(host, theirCookie)).StatusCode);
    }

    [Fact]
    public async Task LogoutAll_AppliesTheSameCsrfGuardAsTheRestOfUnsafeMethods()
    {
        var host = CreateHost();
        var email = await RegisterAsync(host);
        var cookie = CookieOf(await LoginAsync(host, email));
        var stampBefore = await StampAsync(email);
        using var bare = host.Factory.CreateClient(NoCookieJar); // sin cabecera ni Origin

        var noHeaders = new HttpRequestMessage(HttpMethod.Post, AuthEndpoints.LogoutAllPath);
        noHeaders.Headers.Add("Cookie", cookie);
        var withoutHeader = await bare.SendAsync(noHeaders);

        var foreignOrigin = new HttpRequestMessage(HttpMethod.Post, AuthEndpoints.LogoutAllPath);
        foreignOrigin.Headers.Add("Cookie", cookie);
        foreignOrigin.Headers.Add(CsrfGuardMiddleware.HeaderName, "1");
        foreignOrigin.Headers.Add("Origin", "https://evil.example");
        var withForeignOrigin = await bare.SendAsync(foreignOrigin);

        Assert.Equal(HttpStatusCode.Forbidden, withoutHeader.StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, withForeignOrigin.StatusCode);
        Assert.Equal(stampBefore, await StampAsync(email));
        Assert.Equal(HttpStatusCode.OK, (await MeAsync(host, cookie)).StatusCode);
    }

    [Fact]
    public async Task LogoutAll_WithATamperedCookie_Returns401_AndRotatesNothing()
    {
        var host = CreateHost();
        var email = await RegisterAsync(host);
        var cookie = CookieOf(await LoginAsync(host, email));
        var stampBefore = await StampAsync(email);
        var value = cookie[(cookie.IndexOf('=') + 1)..];

        var response = await SendAsync(host, HttpMethod.Post, AuthEndpoints.LogoutAllPath, $"{CookieName}={Flip(value, value.Length / 2)}");

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Equal(stampBefore, await StampAsync(email));
    }

    // ------------------------------------------------------------------------ key ring persistente (Data Protection)

    [Fact]
    public async Task KeyRing_Persisted_ASessionSurvivesABackendRestart_SecondHostOverTheSameKeysDirectory()
    {
        var keys = NewKeysDirectory();
        var first = CreateHost(extra: Keys(keys));
        var email = await RegisterAsync(first);
        var cookie = CookieOf(await LoginAsync(first, email, rememberMe: true));
        Assert.Equal(HttpStatusCode.OK, (await MeAsync(first, cookie)).StatusCode);

        // «Reinicio»: el primer host se apaga y arranca uno nuevo (otro proceso lógico, otro key ring en memoria) con el mismo directorio.
        await first.DisposeAsync();
        var restarted = CreateHost(extra: Keys(keys));

        var me = await MeAsync(restarted, cookie);
        Assert.Equal(HttpStatusCode.OK, me.StatusCode);
        Assert.Equal(email, (await me.Content.ReadFromJsonAsync<CurrentUserResponse>())!.Email);
        Assert.NotEmpty(Directory.GetFiles(keys, "key-*.xml")); // el key ring está donde se configuró
    }

    [Fact]
    public async Task KeyRing_TwoHostsRunningAtTheSameTime_ShareTheSessions()
    {
        var keys = NewKeysDirectory();
        var a = CreateHost(extra: Keys(keys));
        var email = await RegisterAsync(a);
        var cookie = CookieOf(await LoginAsync(a, email));
        var b = CreateHost(extra: Keys(keys));

        Assert.Equal(HttpStatusCode.OK, (await MeAsync(b, cookie)).StatusCode);
    }

    [Fact]
    public async Task KeyRing_NotShared_ARestartInvalidatesTheSession_ControlOfThePersistenceTests()
    {
        var first = CreateHost(extra: Keys(NewKeysDirectory()));
        var email = await RegisterAsync(first);
        var cookie = CookieOf(await LoginAsync(first, email));
        await first.DisposeAsync();

        var restartedWithAnotherKeyRing = CreateHost(extra: Keys(NewKeysDirectory()));

        Assert.Equal(HttpStatusCode.Unauthorized, (await MeAsync(restartedWithAnotherKeyRing, cookie)).StatusCode);
    }

    [Fact]
    public async Task KeyRing_Persisted_WritesTheKeysOnlyWhereConfigured_OutsideTheRepository()
    {
        var keys = NewKeysDirectory();
        var host = CreateHost(extra: Keys(keys));
        var email = await RegisterAsync(host);
        await LoginAsync(host, email);

        var files = Directory.GetFiles(keys, "*", SearchOption.AllDirectories);
        Assert.NotEmpty(files);
        Assert.All(files, f => Assert.StartsWith(Path.GetTempPath(), f, StringComparison.OrdinalIgnoreCase));
    }

    // ------------------------------------------------------------------------- opciones inválidas: el arranque falla

    [Theory]
    [InlineData("Auth:Cookie:RememberMeLifetime", "00:00:00", "RememberMeLifetime")]
    [InlineData("Auth:Cookie:RememberMeLifetime", "401.00:00:00", "RememberMeLifetime")]
    [InlineData("Auth:Cookie:RememberMeLifetime", "04:00:00", "RememberMeLifetime")]
    [InlineData("Auth:Cookie:Lifetime", "-01:00:00", "Auth:Cookie:Lifetime")]
    [InlineData("Auth:Session:RevalidationInterval", "-00:01:00", "RevalidationInterval")]
    [InlineData("Auth:Session:RevalidationInterval", "09:00:00", "RevalidationInterval")]
    [InlineData("Auth:Session:ClockSkew", "00:10:00", "ClockSkew")]
    [InlineData("Auth:Session:ClockSkew", "-00:00:01", "ClockSkew")]
    [InlineData("Auth:DataProtection:KeysPath", "relativa/ruta", "KeysPath")]
    public async Task Host_WithInvalidSessionOptions_FailsToStart(string key, string value, string expectedInMessage)
    {
        var host = CreateHost(extra: new Dictionary<string, string?> { [key] = value });

        var exception = await Record.ExceptionAsync(() => host.Client.GetAsync("/health"));

        Assert.NotNull(exception);
        var failure = FindInChain<Microsoft.Extensions.Options.OptionsValidationException>(exception!);
        Assert.NotNull(failure);
        Assert.Contains(expectedInMessage, failure!.Message);
    }

    [Fact]
    public async Task Host_WithAKeysPathThatIsAFile_FailsToStart()
    {
        var file = Path.Combine(Path.GetTempPath(), "vectorify-keys-file-" + Guid.NewGuid().ToString("N"));
        File.WriteAllText(file, "no soy un directorio");
        try
        {
            var host = CreateHost(extra: Keys(file));

            var exception = await Record.ExceptionAsync(() => host.Client.GetAsync("/health"));

            var failure = FindInChain<Microsoft.Extensions.Options.OptionsValidationException>(exception!);
            Assert.NotNull(failure);
            Assert.Contains("Auth:DataProtection:KeysPath", failure!.Message);
        }
        finally
        {
            File.Delete(file);
        }
    }

    [Fact]
    public async Task Host_InProduction_WithoutAPersistentKeyRing_FailsToStart_AndWithOne_Starts()
    {
        var without = CreateHost(production: true);
        var failure = await Record.ExceptionAsync(() => without.Client.GetAsync("/health"));
        var validation = FindInChain<Microsoft.Extensions.Options.OptionsValidationException>(failure!);
        Assert.NotNull(validation);
        Assert.Contains("Auth:DataProtection:KeysPath", validation!.Message);

        var with = CreateHost(production: true, extra: Keys(NewKeysDirectory()));
        var response = await with.Client.GetAsync("/health");
        Assert.True(response.IsSuccessStatusCode);
    }

    // -------------------------------------------------------------------------------------------------- helpers

    /// <summary>Host de pruebas. El cliente se crea en el primer uso: arrancar el host es lo que puede fallar (opciones inválidas).</summary>
    private sealed class Host : IAsyncDisposable
    {
        private HttpClient? _client;

        public Host(WebApplicationFactory<Program> factory)
        {
            Factory = factory;
        }

        public WebApplicationFactory<Program> Factory { get; }

        public HttpClient Client => _client ??= Factory.CreateClient(NoCookieJar).WithCsrf();

        public async ValueTask DisposeAsync()
        {
            _client?.Dispose();
            await Factory.DisposeAsync();
        }
    }

    /// <summary>Host real en modo Authenticated con el reloj controlable. <paramref name="interval"/>: intervalo de revalidación (<c>null</c> = default de 5 min).</summary>
    private Host CreateHost(
        string? interval = "00:00:00", IDictionary<string, string?>? extra = null, bool production = false)
    {
        var settings = new Dictionary<string, string?>();
        if (interval is not null)
        {
            settings["Auth:Session:RevalidationInterval"] = interval;
        }

        foreach (var pair in extra ?? new Dictionary<string, string?>())
        {
            settings[pair.Key] = pair.Value;
        }

        var factory = _fixture.CreateFactory(
            _connectionString,
            authenticated: true,
            configureServices: services =>
            {
                services.RemoveAll<TimeProvider>();
                services.AddSingleton<TimeProvider>(_clock);
            },
            settings: settings);
        if (production)
        {
            factory = factory.WithWebHostBuilder(builder => builder.UseEnvironment("Production"));
        }

        var host = new Host(factory);
        _disposables.Add(host);
        return host;
    }

    private string NewKeysDirectory()
    {
        var path = Path.Combine(Path.GetTempPath(), "vectorify-keys-" + Guid.NewGuid().ToString("N"));
        _directories.Add(path);
        return path;
    }

    private static Dictionary<string, string?> Keys(string path) => new() { ["Auth:DataProtection:KeysPath"] = path };

    private static string NewEmail() => $"user-{Guid.NewGuid():N}@vectorify.test";

    private static async Task<string> RegisterAsync(Host host)
    {
        var email = NewEmail();
        var response = await host.Client.PostAsJsonAsync(AuthEndpoints.RegisterPath, new RegisterRequest(email, Password));
        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        return email;
    }

    private static async Task<HttpResponseMessage> LoginAsync(Host host, string email, bool? rememberMe = null)
    {
        var response = await host.Client.PostAsJsonAsync(AuthEndpoints.LoginPath, new LoginRequest(email, Password, rememberMe));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return response;
    }

    private static Task<HttpResponseMessage> MeAsync(Host host, string cookie) =>
        SendAsync(host, HttpMethod.Get, AuthEndpoints.MePath, cookie);

    private static Task<HttpResponseMessage> SendAsync(Host host, HttpMethod method, string url, string? cookie)
    {
        var request = new HttpRequestMessage(method, url);
        if (cookie is not null)
        {
            request.Headers.Add("Cookie", cookie);
        }

        return host.Client.SendAsync(request);
    }

    private static IReadOnlyList<string> SessionSetCookies(HttpResponseMessage response, string name = CookieName) =>
        response.Headers.TryGetValues("Set-Cookie", out var values)
            ? values.Where(v => v.StartsWith(name + "=", StringComparison.Ordinal)).ToList()
            : [];

    /// <summary>«nombre=valor» de la cookie emitida/renovada en una respuesta.</summary>
    private static string CookieOf(HttpResponseMessage response)
    {
        var header = Assert.Single(SessionSetCookies(response));
        return header[..header.IndexOf(';')];
    }

    private static HashSet<string> Attributes(string setCookie) =>
        setCookie.Split(';').Skip(1).Select(a => a.Trim().ToLowerInvariant()).ToHashSet();

    private static DateTimeOffset ExpiresOf(string setCookie)
    {
        var expires = setCookie.Split(';').Select(a => a.Trim()).Single(a => a.StartsWith("expires=", StringComparison.OrdinalIgnoreCase))["expires=".Length..];
        return DateTimeOffset.Parse(expires, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal);
    }

    private static string Flip(string value, int index) =>
        value[..index] + (value[index] == 'A' ? 'B' : 'A') + value[(index + 1)..];

    private Task<string> StampAsync(string email) =>
        _fixture.ScalarAsync<string>(
            _connectionString, "SELECT \"SecurityStamp\" FROM auth.\"AspNetUsers\" WHERE \"NormalizedEmail\" = @e", ("e", email.ToUpperInvariant()));

    private static T? FindInChain<T>(Exception exception)
        where T : Exception
    {
        for (Exception? current = exception; current is not null; current = current.InnerException)
        {
            if (current is T match)
            {
                return match;
            }
        }

        return null;
    }
}
