using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Vectorify.Api.Contracts;
using Vectorify.Api.Endpoints;
using Vectorify.Api.Authorization;
using Vectorify.Api.Middleware;
using Vectorify.Api.Options;
using Vectorify.Api.Tests.TestSupport;
using Vectorify.Api.Users;

namespace Vectorify.Api.Tests.EndToEnd;

/// <summary>
/// Login, logout y <c>GET /api/v1/auth/me</c> (M3.1-S03) contra la Web API REAL y PostgreSQL real (Testcontainers). Todas las cookies de
/// sesión de estos tests las emite el SERVIDOR en <c>POST /api/v1/auth/login</c> (ninguna se fabrica). Corre en modo Authenticated con la
/// revalidación del SecurityStamp en 0 (determinista: cada request revalida, como indica el ADR para los tests).
/// </summary>
public sealed class AuthLoginLogoutTests : IClassFixture<AuthApiFixture>, IAsyncLifetime
{
    private const string Password = "una-contrasena-larga-1";
    private const string WrongPassword = "otra-contrasena-erronea-9";

    private readonly AuthApiFixture _fixture;
    private readonly CapturingLoggerProvider _logs = new();
    private string _connectionString = string.Empty;
    private WebApplicationFactory<Program> _factory = null!;
    private HttpClient _client = null!;

    public AuthLoginLogoutTests(AuthApiFixture fixture)
    {
        _fixture = fixture;
    }

    /// <summary>
    /// Sin cookie jar automático: el cliente de pruebas guardaría y reenviaría solo las cookies de sesión, y cada test debe decidir
    /// EXPLÍCITAMENTE qué cookie presenta (dos pestañas, copia robada, sin sesión).
    /// </summary>
    private static readonly WebApplicationFactoryClientOptions NoCookieJar = new() { HandleCookies = false };

    private static IDictionary<string, string?> ImmediateRevalidation => new Dictionary<string, string?>
    {
        ["Auth:Session:RevalidationInterval"] = "00:00:00",
    };

    public async Task InitializeAsync()
    {
        _connectionString = await _fixture.CreateDatabaseAsync();
        _factory = _fixture.CreateFactory(_connectionString, authenticated: true, logProvider: _logs, settings: ImmediateRevalidation);
        _client = _factory.CreateClient(NoCookieJar).WithCsrf();
    }

    public async Task DisposeAsync()
    {
        _client.Dispose();
        await _factory.DisposeAsync();
    }

    // ------------------------------------------------------------------------------------------------ login correcto

    [Fact]
    public async Task Login_WithValidCredentials_Returns200WithTheCurrentUser_AndOpensASessionCookie()
    {
        var email = await RegisterAsync();

        var response = await LoginAsync(email, Password);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var user = (await response.Content.ReadFromJsonAsync<CurrentUserResponse>())!;
        Assert.Equal(email, user.Email);
        Assert.NotEqual(Guid.Empty, user.Id);
        Assert.NotEmpty(user.DisplayName);
        // El id devuelto es el Users.Id interno vinculado a la cuenta (no el id de Identity).
        Assert.Equal(1, await _fixture.ScalarAsync<long>(
            _connectionString,
            """
            SELECT count(*) FROM user_identities i JOIN auth."AspNetUsers" a ON i."Subject" = a."Id"::text
            WHERE a."NormalizedEmail" = @e AND i."UserId" = @u AND i."Provider" = 'aspnet-identity'
            """,
            ("e", email.ToUpperInvariant()), ("u", user.Id)));
        Assert.StartsWith("no-store", response.Headers.CacheControl?.ToString() ?? string.Empty, StringComparison.Ordinal);
        Assert.NotEmpty(SessionCookieHeaders(response));
    }

    [Fact]
    public async Task Login_Cookie_IsHttpOnlySameSiteLax_PathRoot_WithoutDomain_AndNotSecureOverPlainHttpWithTheDevelopmentOptions()
    {
        var email = await RegisterAsync();

        var response = await LoginAsync(email, Password);

        var setCookie = Assert.Single(SessionCookieHeaders(response));
        var attributes = CookieAttributes(setCookie);
        Assert.StartsWith("vectorify.session=", setCookie, StringComparison.Ordinal); // nombre de appsettings.Development.json
        Assert.Contains("httponly", attributes);
        Assert.Contains("samesite=lax", attributes);
        Assert.Contains("path=/", attributes);
        Assert.DoesNotContain(attributes, a => a.StartsWith("domain", StringComparison.Ordinal));
        Assert.DoesNotContain("secure", attributes); // SecurePolicy=SameAsRequest sobre http
        Assert.DoesNotContain(email, setCookie, StringComparison.OrdinalIgnoreCase); // el ticket va cifrado
    }

    [Fact]
    public async Task Login_Cookie_WithProductionStyleOptions_IsSecureAndHostPrefixed()
    {
        await using var factory = _fixture.CreateFactory(
            _connectionString,
            authenticated: true,
            settings: new Dictionary<string, string?>
            {
                ["Auth:Cookie:Name"] = "__Host-vectorify.session",
                ["Auth:Cookie:SecurePolicy"] = "Always",
            });
        using var client = factory.CreateClient(NoCookieJar).WithCsrf();
        var email = NewEmail();
        await client.PostAsJsonAsync(AuthEndpoints.RegisterPath, new RegisterRequest(email, Password));

        var response = await client.PostAsJsonAsync(AuthEndpoints.LoginPath, new LoginRequest(email, Password));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var setCookie = Assert.Single(SessionCookieHeaders(response, "__Host-vectorify.session"));
        var attributes = CookieAttributes(setCookie);
        Assert.Contains("secure", attributes);
        Assert.Contains("httponly", attributes);
        Assert.Contains("samesite=lax", attributes);
        Assert.Contains("path=/", attributes);
        Assert.DoesNotContain(attributes, a => a.StartsWith("domain", StringComparison.Ordinal)); // requisito del prefijo __Host-
    }

    [Fact]
    public async Task Login_EmailIsCaseInsensitiveAndTrimmed()
    {
        var email = await RegisterAsync();

        var response = await LoginAsync("  " + email.ToUpperInvariant() + "  ", Password);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    // ------------------------------------------------------------------------- T5/T6: 401 idéntico y bloqueo

    [Fact]
    public async Task Login_WrongPassword_UnknownAccountAndLockedAccount_ReturnTheExactSame401()
    {
        var existing = await RegisterAsync();
        var locked = await RegisterAsync();
        for (var i = 0; i < 5; i++)
        {
            await LoginAsync(locked, WrongPassword);
        }

        var wrongPassword = await Snapshot(await LoginAsync(existing, WrongPassword));
        var unknownAccount = await Snapshot(await LoginAsync(NewEmail(), Password));
        var lockedWithRightPassword = await Snapshot(await LoginAsync(locked, Password));
        var lockedWithWrongPassword = await Snapshot(await LoginAsync(locked, WrongPassword));
        var emptyPassword = await Snapshot(await LoginAsync(existing, string.Empty));

        Assert.Equal(HttpStatusCode.Unauthorized, wrongPassword.Status);
        Assert.Contains(AuthEndpoints.InvalidCredentialsCode, wrongPassword.Body);
        Assert.Equal(wrongPassword, unknownAccount);
        Assert.Equal(wrongPassword, lockedWithRightPassword);
        Assert.Equal(wrongPassword, lockedWithWrongPassword);
        Assert.Equal(wrongPassword, emptyPassword);
        Assert.DoesNotContain("locked", wrongPassword.Body, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("bloquead", wrongPassword.Body, StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData(null, null)]
    [InlineData("", Password)]
    [InlineData("   ", Password)]
    [InlineData("alguien@vectorify.test", null)]
    public async Task Login_MissingOrEmptyFields_ReturnTheSame401AsBadCredentials(string? email, string? password)
    {
        var reference = await Snapshot(await LoginAsync(NewEmail(), WrongPassword));

        var response = await _client.PostAsJsonAsync(AuthEndpoints.LoginPath, new LoginRequest(email, password));

        Assert.Equal(reference, await Snapshot(response));
    }

    [Fact]
    public async Task Login_OversizedPassword_Returns401WithoutHashingIt()
    {
        var existing = await RegisterAsync();
        var reference = await Snapshot(await LoginAsync(existing, WrongPassword));

        var response = await LoginAsync(existing, new string('x', AuthPasswordOptions.MaxLength + 1));

        Assert.Equal(reference, await Snapshot(response));
    }

    [Fact]
    public async Task Login_LocksTheAccountAfterFiveFailures_ForFifteenMinutes_EvenWithTheRightPassword()
    {
        var email = await RegisterAsync();

        for (var i = 1; i <= 4; i++)
        {
            Assert.Equal(HttpStatusCode.Unauthorized, (await LoginAsync(email, WrongPassword)).StatusCode);
        }

        // Cuatro fallos NO bloquean: la contraseña correcta entra y reinicia el contador.
        Assert.Equal(HttpStatusCode.OK, (await LoginAsync(email, Password)).StatusCode);
        Assert.Equal(0, await FailedCountAsync(email));

        for (var i = 1; i <= 5; i++)
        {
            Assert.Equal(HttpStatusCode.Unauthorized, (await LoginAsync(email, WrongPassword)).StatusCode);
        }

        Assert.True(await _fixture.ScalarAsync<bool>(
            _connectionString,
            """
            SELECT "LockoutEnd" > now() + interval '14 minutes' AND "LockoutEnd" <= now() + interval '15 minutes 5 seconds'
            FROM auth."AspNetUsers" WHERE "NormalizedEmail" = @e
            """,
            ("e", email.ToUpperInvariant())));
        var locked = await LoginAsync(email, Password);
        Assert.Equal(HttpStatusCode.Unauthorized, locked.StatusCode);
        Assert.Empty(SessionCookieHeaders(locked)); // sin cookie
    }

    [Fact]
    public async Task Login_ForAnUnknownAccount_NeverCreatesAnythingNorLocksAnything()
    {
        var accountsBefore = await _fixture.ScalarAsync<long>(_connectionString, "SELECT count(*) FROM auth.\"AspNetUsers\"");
        var usersBefore = await _fixture.ScalarAsync<long>(_connectionString, "SELECT count(*) FROM users");

        for (var i = 0; i < 7; i++)
        {
            Assert.Equal(HttpStatusCode.Unauthorized, (await LoginAsync(NewEmail(), Password)).StatusCode);
        }

        Assert.Equal(accountsBefore, await _fixture.ScalarAsync<long>(_connectionString, "SELECT count(*) FROM auth.\"AspNetUsers\""));
        Assert.Equal(usersBefore, await _fixture.ScalarAsync<long>(_connectionString, "SELECT count(*) FROM users"));
    }

    [Fact]
    public async Task Login_NeverLogsTheEmailNorThePassword_InAnyOutcome()
    {
        var existing = await RegisterAsync();
        var locked = await RegisterAsync();
        var unknown = NewEmail();
        const string distinctivePassword = "contrasena-distintiva-zzq-77";
        const string distinctiveWrong = "erronea-distintiva-kkw-55";

        await LoginAsync(existing, distinctivePassword); // contraseña errónea
        await LoginAsync(existing, Password); // ok
        await LoginAsync(unknown, distinctivePassword); // inexistente
        for (var i = 0; i < 6; i++)
        {
            await LoginAsync(locked, distinctiveWrong); // fallos y bloqueada
        }

        var all = string.Join('\n', _logs.Entries);
        Assert.NotEmpty(_logs.Entries);
        foreach (var secret in new[] { existing, locked, unknown, distinctivePassword, distinctiveWrong, Password })
        {
            Assert.DoesNotContain(secret, all, StringComparison.OrdinalIgnoreCase);
        }
    }

    // --------------------------------------------------------------------------------------------------------- me

    [Fact]
    public async Task Me_WithoutSession_Returns401()
    {
        var response = await _client.GetAsync(AuthEndpoints.MePath);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Empty(SessionCookieHeaders(response));
    }

    [Fact]
    public async Task Me_WithTheServerIssuedCookie_ReturnsInternalIdEmailAndName_AndNothingSecret()
    {
        var email = await RegisterAsync();
        var login = await LoginAsync(email, Password);
        var loggedIn = (await login.Content.ReadFromJsonAsync<CurrentUserResponse>())!;

        var response = await SendAsync(HttpMethod.Get, AuthEndpoints.MePath, CookieOf(login));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(loggedIn, await response.Content.ReadFromJsonAsync<CurrentUserResponse>());
        Assert.Equal("Authenticated", loggedIn.AuthMode); // M3.1-S05: el indicador de modo viaja en login y en me
        var raw = await response.Content.ReadAsStringAsync();
        Assert.DoesNotContain("passwordHash", raw, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("securityStamp", raw, StringComparison.OrdinalIgnoreCase);
        Assert.StartsWith("no-store", response.Headers.CacheControl?.ToString() ?? string.Empty, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Me_WithATamperedOrGarbageCookie_Returns401()
    {
        var email = await RegisterAsync();
        var cookie = CookieOf(await LoginAsync(email, Password));
        var separator = cookie.IndexOf('=');
        var name = cookie[..separator];
        var value = cookie[(separator + 1)..];
        var middle = value.Length / 2;
        var flipped = value[..middle] + (value[middle] == 'A' ? 'B' : 'A') + value[(middle + 1)..];

        Assert.Equal(HttpStatusCode.Unauthorized, (await SendAsync(HttpMethod.Get, AuthEndpoints.MePath, $"{name}={flipped}")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await SendAsync(HttpMethod.Get, AuthEndpoints.MePath, $"{name}={value[..^12]}")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await SendAsync(HttpMethod.Get, AuthEndpoints.MePath, $"{name}=basura-que-no-es-un-ticket")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await SendAsync(HttpMethod.Get, AuthEndpoints.MePath, $"{name}=")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await SendAsync(HttpMethod.Get, AuthEndpoints.MePath, cookie)).StatusCode); // la original sigue valiendo
    }

    [Fact]
    public async Task Me_NothingTheClientSends_DecidesWhoTheUserIs()
    {
        var alice = await SignInAsync();
        var bob = await SignInAsync();

        using var request = new HttpRequestMessage(HttpMethod.Get, $"{AuthEndpoints.MePath}?userId={bob.User.Id}&id={bob.User.Id}&ownerId={bob.User.Id}");
        request.Headers.Add("Cookie", alice.Cookie);
        request.Headers.Add("X-User-Id", bob.User.Id.ToString());
        request.Headers.Add("X-Vectorify-User", bob.User.Id.ToString());
        request.Headers.Add("X-Vectorify-Uid", bob.User.Id.ToString());
        request.Headers.Add("X-Test-Sub", bob.User.Id.ToString()); // el esquema de pruebas NO existe en este host
        var response = await _client.SendAsync(request);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(alice.User.Id, (await response.Content.ReadFromJsonAsync<CurrentUserResponse>())!.Id);
    }

    [Fact]
    public async Task Me_AClaimNamedLikeTheInternalOne_InsideTheProviderIdentity_CannotImpersonateAnotherUser()
    {
        await using var factory = _fixture.CreateFactory(_connectionString, authenticated: true, testScheme: true);
        using var client = factory.CreateClient(NoCookieJar).WithCsrf();
        var victim = await SignInAsync(); // cuenta real con su User interno

        using var request = new HttpRequestMessage(HttpMethod.Get, AuthEndpoints.MePath);
        request.Headers.Add("X-Test-Sub", Guid.NewGuid().ToString());
        request.Headers.Add("X-Test-Email", NewEmail());
        request.Headers.Add("X-Test-Forged-Uid", victim.User.Id.ToString());
        var response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.NotEqual(victim.User.Id, (await response.Content.ReadFromJsonAsync<CurrentUserResponse>())!.Id);
    }

    // ------------------------------------------------------------------------------------------------ logout

    [Fact]
    public async Task Logout_DeletesTheCookie_AndTheSameCookieIsRejectedAfterwards_OnMeAndOnProtectedEndpoints()
    {
        var session = await SignInAsync();
        var created = await SendAsync(HttpMethod.Post, "/api/v2/projects", session.Cookie, new CreateProjectRequest("Antes del logout", null));
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await SendAsync(HttpMethod.Get, AuthEndpoints.MePath, session.Cookie)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await SendAsync(HttpMethod.Get, "/api/v2/projects", session.Cookie)).StatusCode);
        var stampBefore = await StampAsync(session.Email);

        var logout = await SendAsync(HttpMethod.Post, AuthEndpoints.LogoutPath, session.Cookie);

        Assert.Equal(HttpStatusCode.NoContent, logout.StatusCode);
        var cleared = Assert.Single(SessionCookieHeaders(logout));
        Assert.Contains("expires=Thu, 01 Jan 1970", cleared, StringComparison.OrdinalIgnoreCase);
        Assert.NotEqual(stampBefore, await StampAsync(session.Email)); // el SecurityStamp rotó
        // DoD: con LA MISMA cookie (copia robada incluida) ya no se puede consumir nada protegido.
        var me = await SendAsync(HttpMethod.Get, AuthEndpoints.MePath, session.Cookie);
        var projects = await SendAsync(HttpMethod.Get, "/api/v2/projects", session.Cookie);
        var create = await SendAsync(HttpMethod.Post, "/api/v2/projects", session.Cookie, new CreateProjectRequest("Después del logout", null));
        Assert.Equal(HttpStatusCode.Unauthorized, me.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, projects.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, create.StatusCode);
        Assert.Equal(0, await _fixture.ScalarAsync<long>(_connectionString, "SELECT count(*) FROM projects WHERE \"Name\" = 'Después del logout'"));
    }

    [Fact]
    public async Task Logout_IsIdempotent_WithoutSessionWithAnOldCookieOrTwice()
    {
        var session = await SignInAsync();

        var anonymous = await _client.PostAsync(AuthEndpoints.LogoutPath, content: null);
        var first = await SendAsync(HttpMethod.Post, AuthEndpoints.LogoutPath, session.Cookie);
        var second = await SendAsync(HttpMethod.Post, AuthEndpoints.LogoutPath, session.Cookie); // la cookie ya no vale
        var garbage = await SendAsync(HttpMethod.Post, AuthEndpoints.LogoutPath, "vectorify.session=basura");

        Assert.Equal(HttpStatusCode.NoContent, anonymous.StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, first.StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, second.StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, garbage.StatusCode);
    }

    [Fact]
    public async Task Logout_ByAnAnonymousRequest_DoesNotRotateAnyStamp()
    {
        var session = await SignInAsync();
        var stampBefore = await StampAsync(session.Email);

        await _client.PostAsync(AuthEndpoints.LogoutPath, content: null);
        await SendAsync(HttpMethod.Post, AuthEndpoints.LogoutPath, "vectorify.session=basura");

        Assert.Equal(stampBefore, await StampAsync(session.Email));
        Assert.Equal(HttpStatusCode.OK, (await SendAsync(HttpMethod.Get, AuthEndpoints.MePath, session.Cookie)).StatusCode);
    }

    [Fact]
    public async Task AfterLogout_TheSameAccountCanLogInAgain_WithAFreshSession()
    {
        var session = await SignInAsync();
        await SendAsync(HttpMethod.Post, AuthEndpoints.LogoutPath, session.Cookie);

        var again = await LoginAsync(session.Email, Password);

        Assert.Equal(HttpStatusCode.OK, again.StatusCode);
        var fresh = CookieOf(again);
        Assert.NotEqual(session.Cookie, fresh);
        Assert.Equal(HttpStatusCode.OK, (await SendAsync(HttpMethod.Get, AuthEndpoints.MePath, fresh)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await SendAsync(HttpMethod.Get, AuthEndpoints.MePath, session.Cookie)).StatusCode);
    }

    // ----------------------------------------------------------------------------- dos pestañas / dos cookies

    [Fact]
    public async Task TwoTabs_TwoCookiesOfTheSameUser_AreBothValidAtTheSameTime_AndShareTheUsersProjects()
    {
        var email = await RegisterAsync();
        var tabA = CookieOf(await LoginAsync(email, Password));
        var tabB = CookieOf(await LoginAsync(email, Password));
        Assert.NotEqual(tabA, tabB);

        var created = await SendAsync(HttpMethod.Post, "/api/v2/projects", tabA, new CreateProjectRequest("Creado en la pestaña A", null));
        var listFromB = await SendAsync(HttpMethod.Get, "/api/v2/projects", tabB);

        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        var meA = (await (await SendAsync(HttpMethod.Get, AuthEndpoints.MePath, tabA)).Content.ReadFromJsonAsync<CurrentUserResponse>())!;
        var meB = (await (await SendAsync(HttpMethod.Get, AuthEndpoints.MePath, tabB)).Content.ReadFromJsonAsync<CurrentUserResponse>())!;
        Assert.Equal(meA, meB);
        var list = (await listFromB.Content.ReadFromJsonAsync<ProjectListResponse>())!;
        Assert.Equal(1, list.TotalCount);
        Assert.Equal(meA.Id, (await created.Content.ReadFromJsonAsync<ProjectResponse>())!.OwnerId);
        Assert.Equal(1, await _fixture.ScalarAsync<long>(_connectionString, "SELECT count(*) FROM users WHERE \"Email\" = @e", ("e", email)));
    }

    [Fact]
    public async Task TwoTabs_LoggingOutInOne_EndsTheSessionInTheOtherToo_BecauseLogoutRotatesTheSecurityStamp()
    {
        var email = await RegisterAsync();
        var tabA = CookieOf(await LoginAsync(email, Password));
        var tabB = CookieOf(await LoginAsync(email, Password));

        await SendAsync(HttpMethod.Post, AuthEndpoints.LogoutPath, tabA);

        Assert.Equal(HttpStatusCode.Unauthorized, (await SendAsync(HttpMethod.Get, AuthEndpoints.MePath, tabA)).StatusCode);
        // Decisión declarada: «cerrar sesión» es en todos lados; la otra pestaña recibe 401 y la SPA la llevará a login (S05).
        Assert.Equal(HttpStatusCode.Unauthorized, (await SendAsync(HttpMethod.Get, AuthEndpoints.MePath, tabB)).StatusCode);
    }

    [Fact]
    public async Task TwoDifferentUsers_AtTheSameTime_NeverSeeEachOthersSession()
    {
        var alice = await SignInAsync();
        var bob = await SignInAsync();

        var meAlice = await (await SendAsync(HttpMethod.Get, AuthEndpoints.MePath, alice.Cookie)).Content.ReadFromJsonAsync<CurrentUserResponse>();
        var meBob = await (await SendAsync(HttpMethod.Get, AuthEndpoints.MePath, bob.Cookie)).Content.ReadFromJsonAsync<CurrentUserResponse>();

        Assert.Equal(alice.Email, meAlice!.Email);
        Assert.Equal(bob.Email, meBob!.Email);
        Assert.NotEqual(meAlice.Id, meBob.Id);
    }

    // ------------------------------------------------------------------------ flujo completo register -> login -> proyectos

    [Fact]
    public async Task FullFlow_Register_Login_ListProjects_ShowsOnlyTheUsersOwnProjects()
    {
        var aliceEmail = NewEmail();
        var bobEmail = NewEmail();
        Assert.Equal(HttpStatusCode.Accepted, (await _client.PostAsJsonAsync(AuthEndpoints.RegisterPath, new RegisterRequest(aliceEmail, Password))).StatusCode);
        Assert.Equal(HttpStatusCode.Accepted, (await _client.PostAsJsonAsync(AuthEndpoints.RegisterPath, new RegisterRequest(bobEmail, Password))).StatusCode);
        var aliceCookie = CookieOf(await LoginAsync(aliceEmail, Password));
        var bobCookie = CookieOf(await LoginAsync(bobEmail, Password));

        var aliceProject = await SendAsync(HttpMethod.Post, "/api/v2/projects", aliceCookie, new CreateProjectRequest("Proyecto de Alice", null));
        await SendAsync(HttpMethod.Post, "/api/v2/projects", bobCookie, new CreateProjectRequest("Proyecto de Bob", null));
        await SendAsync(HttpMethod.Post, "/api/v2/projects", bobCookie, new CreateProjectRequest("Otro de Bob", null));
        var aliceList = (await (await SendAsync(HttpMethod.Get, "/api/v2/projects", aliceCookie)).Content.ReadFromJsonAsync<ProjectListResponse>())!;
        var bobList = (await (await SendAsync(HttpMethod.Get, "/api/v2/projects", bobCookie)).Content.ReadFromJsonAsync<ProjectListResponse>())!;

        Assert.Equal(1, aliceList.TotalCount);
        Assert.Equal("Proyecto de Alice", Assert.Single(aliceList.Items).Name);
        Assert.Equal(2, bobList.TotalCount);
        Assert.DoesNotContain(bobList.Items, p => p.Name == "Proyecto de Alice");
        // El proyecto ajeno responde 404 uniforme con la cookie de Bob.
        var aliceId = (await aliceProject.Content.ReadFromJsonAsync<ProjectResponse>())!.Id;
        Assert.Equal(HttpStatusCode.NotFound, (await SendAsync(HttpMethod.Get, $"/api/v2/projects/{aliceId}", bobCookie)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await SendAsync(HttpMethod.Get, $"/api/v2/projects/{aliceId}", aliceCookie)).StatusCode);
    }

    [Fact]
    public async Task ProtectedEndpoints_WithoutASession_Return401_NotA500()
    {
        var response = await _client.GetAsync("/api/v2/projects");

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        var body = (await response.Content.ReadFromJsonAsync<ApiErrorResponse>())!;
        Assert.Equal(UnauthenticatedJsonResultHandler.Code, body.Code);
        Assert.Equal(HttpStatusCode.Unauthorized, (await _client.PostAsJsonAsync("/api/v2/projects", new CreateProjectRequest("X", null))).StatusCode);
    }

    [Fact]
    public async Task HealthRegisterAndLogin_StayAnonymous()
    {
        var email = NewEmail();

        var health = await _client.GetAsync("/health");
        var systemHealth = await _client.GetAsync("/api/v1/system/health");
        var register = await _client.PostAsJsonAsync(AuthEndpoints.RegisterPath, new RegisterRequest(email, Password));
        var login = await _client.PostAsJsonAsync(AuthEndpoints.LoginPath, new LoginRequest(email, Password));

        Assert.Equal(HttpStatusCode.OK, health.StatusCode);
        Assert.Equal(HttpStatusCode.OK, systemHealth.StatusCode);
        Assert.Equal(HttpStatusCode.Accepted, register.StatusCode);
        Assert.Equal(HttpStatusCode.OK, login.StatusCode);
    }

    // ---------------------------------------------------------------------------------- CSRF (solo Authenticated)

    [Fact]
    public async Task Csrf_UnsafeMethodWithoutTheHeader_Returns403_AndNothingRuns()
    {
        using var raw = _factory.CreateClient(NoCookieJar);
        var email = await RegisterAsync();

        using var request = new HttpRequestMessage(HttpMethod.Post, AuthEndpoints.LoginPath) { Content = JsonContent.Create(new LoginRequest(email, Password)) };
        request.Headers.Add("Origin", CsrfTestExtensions.AllowedOrigin); // Origin válido, pero falta X-Vectorify-Request
        var response = await raw.SendAsync(request);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Equal(CsrfGuardMiddleware.RejectedCode, (await response.Content.ReadFromJsonAsync<ApiErrorResponse>())!.Code);
        Assert.Empty(SessionCookieHeaders(response));
        Assert.Equal(0, await FailedCountAsync(email));
    }

    [Fact]
    public async Task Csrf_UnsafeMethodWithAForeignOrigin_Returns403_EvenWithTheHeader()
    {
        using var raw = _factory.CreateClient(NoCookieJar);
        var email = await RegisterAsync();

        foreach (var origin in new[] { "http://evil.example", "http://localhost:5174", "https://localhost:5173", "null", "http://localhost:5173.evil.example" })
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, AuthEndpoints.LoginPath) { Content = JsonContent.Create(new LoginRequest(email, Password)) };
            request.Headers.Add(CsrfTestExtensions.HeaderName, "1");
            request.Headers.Add("Origin", origin);
            var response = await raw.SendAsync(request);

            Assert.True(HttpStatusCode.Forbidden == response.StatusCode, $"Origin '{origin}' debía dar 403 y dio {(int)response.StatusCode}");
            Assert.Empty(SessionCookieHeaders(response));
        }
    }

    [Fact]
    public async Task Csrf_UnsafeMethodWithTheHeaderButNoOrigin_Returns403()
    {
        using var raw = _factory.CreateClient(NoCookieJar);
        using var request = new HttpRequestMessage(HttpMethod.Post, AuthEndpoints.RegisterPath) { Content = JsonContent.Create(new RegisterRequest(NewEmail(), Password)) };
        request.Headers.Add(CsrfTestExtensions.HeaderName, "1");

        Assert.Equal(HttpStatusCode.Forbidden, (await raw.SendAsync(request)).StatusCode);
    }

    [Fact]
    public async Task Csrf_UnsafeMethodWithAnEmptyHeaderValue_Returns403()
    {
        using var raw = _factory.CreateClient(NoCookieJar);
        using var request = new HttpRequestMessage(HttpMethod.Post, AuthEndpoints.RegisterPath) { Content = JsonContent.Create(new RegisterRequest(NewEmail(), Password)) };
        request.Headers.Add(CsrfTestExtensions.HeaderName, string.Empty);
        request.Headers.Add("Origin", CsrfTestExtensions.AllowedOrigin);

        Assert.Equal(HttpStatusCode.Forbidden, (await raw.SendAsync(request)).StatusCode);
    }

    [Fact]
    public async Task Csrf_WithTheHeaderAndAnAllowedOrigin_Passes_ForEveryUnsafeMethod()
    {
        var session = await SignInAsync();

        var login = await _client.PostAsJsonAsync(AuthEndpoints.LoginPath, new LoginRequest(session.Email, Password));
        var created = await SendAsync(HttpMethod.Post, "/api/v2/projects", session.Cookie, new CreateProjectRequest("Con CSRF", null));
        var projectId = (await created.Content.ReadFromJsonAsync<ProjectResponse>())!.Id;
        var patched = await SendAsync(HttpMethod.Patch, $"/api/v2/projects/{projectId}", session.Cookie, new UpdateProjectRequest("Renombrado", null));
        var deleted = await SendAsync(HttpMethod.Delete, $"/api/v2/projects/{projectId}", session.Cookie);

        Assert.Equal(HttpStatusCode.OK, login.StatusCode);
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        Assert.Equal(HttpStatusCode.OK, patched.StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, deleted.StatusCode);
    }

    [Fact]
    public async Task Csrf_PatchAndDeleteWithoutTheHeader_Return403_AndTheProjectIsUntouched()
    {
        var session = await SignInAsync();
        var created = await SendAsync(HttpMethod.Post, "/api/v2/projects", session.Cookie, new CreateProjectRequest("Intacto", null));
        var projectId = (await created.Content.ReadFromJsonAsync<ProjectResponse>())!.Id;
        using var raw = _factory.CreateClient(NoCookieJar);

        using var patch = new HttpRequestMessage(HttpMethod.Patch, $"/api/v2/projects/{projectId}") { Content = JsonContent.Create(new UpdateProjectRequest("Hackeado", null)) };
        patch.Headers.Add("Cookie", session.Cookie);
        patch.Headers.Add("Origin", CsrfTestExtensions.AllowedOrigin);
        using var delete = new HttpRequestMessage(HttpMethod.Delete, $"/api/v2/projects/{projectId}");
        delete.Headers.Add("Cookie", session.Cookie);
        delete.Headers.Add("Origin", "http://evil.example");
        delete.Headers.Add(CsrfTestExtensions.HeaderName, "1");

        Assert.Equal(HttpStatusCode.Forbidden, (await raw.SendAsync(patch)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await raw.SendAsync(delete)).StatusCode);
        var project = (await (await SendAsync(HttpMethod.Get, $"/api/v2/projects/{projectId}", session.Cookie)).Content.ReadFromJsonAsync<ProjectResponse>())!;
        Assert.Equal("Intacto", project.Name);
    }

    [Fact]
    public async Task Csrf_LogoutCannotBeForcedCrossSite_AndTheSessionSurvives()
    {
        var session = await SignInAsync();
        using var raw = _factory.CreateClient(NoCookieJar);

        using var forged = new HttpRequestMessage(HttpMethod.Post, AuthEndpoints.LogoutPath);
        forged.Headers.Add("Cookie", session.Cookie);
        forged.Headers.Add("Origin", "http://evil.example");
        var response = await raw.SendAsync(forged);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await SendAsync(HttpMethod.Get, AuthEndpoints.MePath, session.Cookie)).StatusCode);
    }

    [Fact]
    public async Task Csrf_SafeMethodsAndPreflight_DoNotRequireTheHeader()
    {
        using var raw = _factory.CreateClient(NoCookieJar);

        var health = await raw.GetAsync("/health");
        using var preflight = new HttpRequestMessage(HttpMethod.Options, AuthEndpoints.LoginPath);
        preflight.Headers.Add("Origin", CsrfTestExtensions.AllowedOrigin);
        preflight.Headers.Add("Access-Control-Request-Method", "POST");
        preflight.Headers.Add("Access-Control-Request-Headers", "content-type,x-vectorify-request");
        var preflightResponse = await raw.SendAsync(preflight);

        Assert.Equal(HttpStatusCode.OK, health.StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, preflightResponse.StatusCode);
    }

    [Fact]
    public async Task Csrf_RejectionFromAnAllowedOrigin_StillCarriesTheCorsHeaders_SoTheSpaCanReadIt()
    {
        using var raw = _factory.CreateClient(NoCookieJar);
        using var request = new HttpRequestMessage(HttpMethod.Post, AuthEndpoints.LoginPath) { Content = JsonContent.Create(new LoginRequest("a@b.co", Password)) };
        request.Headers.Add("Origin", CsrfTestExtensions.AllowedOrigin);

        var response = await raw.SendAsync(request);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Equal(CsrfTestExtensions.AllowedOrigin, Assert.Single(response.Headers.GetValues("Access-Control-Allow-Origin")));
        Assert.Equal("true", Assert.Single(response.Headers.GetValues("Access-Control-Allow-Credentials")));
    }

    // ------------------------------------------------------------------- modo Development: nada cambia

    [Fact]
    public async Task DevelopmentMode_DoesNotApplyTheCsrfGuard_AndTheAnonymousFlowKeepsWorking()
    {
        await using var factory = _fixture.CreateFactory(_connectionString, settings: ImmediateRevalidation);
        using var client = factory.CreateClient(NoCookieJar); // SIN cabecera ni Origin, como los E2E anónimos de tests/e2e
        var email = NewEmail();

        var created = await client.PostAsJsonAsync("/api/v2/projects", new CreateProjectRequest("Sin sesión ni CSRF", null));
        var register = await client.PostAsJsonAsync(AuthEndpoints.RegisterPath, new RegisterRequest(email, Password));
        var login = await client.PostAsJsonAsync(AuthEndpoints.LoginPath, new LoginRequest(email, Password));
        var logout = await client.PostAsync(AuthEndpoints.LogoutPath, content: null);

        Assert.Equal(AuthMode.Development, ReadMode(factory).Mode);
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        Assert.Equal(DevelopmentUserOptions.DefaultUserId, (await created.Content.ReadFromJsonAsync<ProjectResponse>())!.OwnerId);
        Assert.Equal(HttpStatusCode.Accepted, register.StatusCode);
        Assert.Equal(HttpStatusCode.OK, login.StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, logout.StatusCode);
    }

    [Fact]
    public async Task DevelopmentMode_MeReturnsTheDevelopmentUser_WithoutLoginOrCookie_AndIgnoresAnyCookie_WhileTheProjectsStayThoseOfTheDevelopmentUser()
    {
        await using var factory = _fixture.CreateFactory(_connectionString, settings: ImmediateRevalidation);
        using var client = factory.CreateClient(NoCookieJar);
        var email = NewEmail();
        await client.PostAsJsonAsync(AuthEndpoints.RegisterPath, new RegisterRequest(email, Password));
        var login = await client.PostAsJsonAsync(AuthEndpoints.LoginPath, new LoginRequest(email, Password));
        var cookie = CookieOf(login);

        // M3.1-S05: en Development /me NO depende de la cookie. Sin cookie y con cookie responde el MISMO usuario de desarrollo
        // (el dueño real de los datos en este modo), con authMode=Development.
        var meWithoutCookie = await client.GetAsync(AuthEndpoints.MePath);
        using var meRequest = new HttpRequestMessage(HttpMethod.Get, AuthEndpoints.MePath);
        meRequest.Headers.Add("Cookie", cookie);
        var me = await client.SendAsync(meRequest);
        using var createRequest = new HttpRequestMessage(HttpMethod.Post, "/api/v2/projects") { Content = JsonContent.Create(new CreateProjectRequest("En modo dev", null)) };
        createRequest.Headers.Add("Cookie", cookie);
        var created = await client.SendAsync(createRequest);

        Assert.Equal(HttpStatusCode.OK, meWithoutCookie.StatusCode);
        var devUser = (await meWithoutCookie.Content.ReadFromJsonAsync<CurrentUserResponse>())!;
        Assert.Equal(DevelopmentUserOptions.DefaultUserId, devUser.Id);
        Assert.Equal("Development", devUser.AuthMode);
        Assert.False(string.IsNullOrWhiteSpace(devUser.Email));
        Assert.NotEqual(email, devUser.Email);
        Assert.Empty(SessionCookieHeaders(meWithoutCookie));
        Assert.StartsWith("no-store", meWithoutCookie.Headers.CacheControl?.ToString() ?? string.Empty, StringComparison.Ordinal);

        Assert.Equal(HttpStatusCode.OK, me.StatusCode);
        Assert.Equal(devUser, await me.Content.ReadFromJsonAsync<CurrentUserResponse>());
        Assert.Equal(DevelopmentUserOptions.DefaultUserId, (await created.Content.ReadFromJsonAsync<ProjectResponse>())!.OwnerId);
    }

    [Fact]
    public async Task DevelopmentMode_Login_ReportsAuthModeDevelopment()
    {
        await using var factory = _fixture.CreateFactory(_connectionString, settings: ImmediateRevalidation);
        using var client = factory.CreateClient(NoCookieJar);
        var email = NewEmail();
        await client.PostAsJsonAsync(AuthEndpoints.RegisterPath, new RegisterRequest(email, Password));

        var login = await client.PostAsJsonAsync(AuthEndpoints.LoginPath, new LoginRequest(email, Password));

        Assert.Equal(HttpStatusCode.OK, login.StatusCode);
        Assert.Equal("Development", (await login.Content.ReadFromJsonAsync<CurrentUserResponse>())!.AuthMode);
    }

    // ------------------------------------------------------------------------------------------------ helpers

    private sealed record Session(string Email, string Cookie, CurrentUserResponse User);

    private sealed record ResponseSnapshot(HttpStatusCode Status, string? ContentType, string Body, string? CacheControl, bool SetsCookie, string? WwwAuthenticate, long? ContentLength);

    private static AuthOptions ReadMode(WebApplicationFactory<Program> factory) =>
        factory.Services.GetRequiredService<Microsoft.Extensions.Options.IOptions<AuthOptions>>().Value;

    private static string NewEmail() => $"user-{Guid.NewGuid():N}@vectorify.test";

    private async Task<string> RegisterAsync()
    {
        var email = NewEmail();
        var response = await _client.PostAsJsonAsync(AuthEndpoints.RegisterPath, new RegisterRequest(email, Password));
        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        return email;
    }

    private Task<HttpResponseMessage> LoginAsync(string? email, string? password) =>
        _client.PostAsJsonAsync(AuthEndpoints.LoginPath, new LoginRequest(email, password));

    /// <summary>Registra y hace login por HTTP: la cookie es la que emitió el servidor.</summary>
    private async Task<Session> SignInAsync()
    {
        var email = await RegisterAsync();
        var login = await LoginAsync(email, Password);
        Assert.Equal(HttpStatusCode.OK, login.StatusCode);
        return new Session(email, CookieOf(login), (await login.Content.ReadFromJsonAsync<CurrentUserResponse>())!);
    }

    private Task<HttpResponseMessage> SendAsync(HttpMethod method, string url, string? cookie = null, object? body = null)
    {
        var request = new HttpRequestMessage(method, url);
        if (cookie is not null)
        {
            request.Headers.Add("Cookie", cookie);
        }

        if (body is not null)
        {
            request.Content = JsonContent.Create(body);
        }

        return _client.SendAsync(request);
    }

    private static IReadOnlyList<string> SessionCookieHeaders(HttpResponseMessage response, string name = "vectorify.session") =>
        response.Headers.TryGetValues("Set-Cookie", out var values)
            ? values.Where(v => v.StartsWith(name + "=", StringComparison.Ordinal)).ToList()
            : [];

    /// <summary>«nombre=valor» de la cookie de sesión emitida en una respuesta de login.</summary>
    private static string CookieOf(HttpResponseMessage login)
    {
        var header = Assert.Single(SessionCookieHeaders(login));
        return header[..header.IndexOf(';')];
    }

    private static HashSet<string> CookieAttributes(string setCookie) =>
        setCookie.Split(';').Skip(1).Select(a => a.Trim().ToLowerInvariant()).ToHashSet();

    private static async Task<ResponseSnapshot> Snapshot(HttpResponseMessage response) => new(
        response.StatusCode,
        response.Content.Headers.ContentType?.ToString(),
        await response.Content.ReadAsStringAsync(),
        response.Headers.CacheControl?.ToString(),
        response.Headers.Contains("Set-Cookie"),
        response.Headers.WwwAuthenticate.ToString() is { Length: > 0 } www ? www : null,
        response.Content.Headers.ContentLength);

    private Task<int> FailedCountAsync(string email) =>
        _fixture.ScalarAsync<int>(
            _connectionString, "SELECT \"AccessFailedCount\" FROM auth.\"AspNetUsers\" WHERE \"NormalizedEmail\" = @e", ("e", email.ToUpperInvariant()));

    private Task<string> StampAsync(string email) =>
        _fixture.ScalarAsync<string>(
            _connectionString, "SELECT \"SecurityStamp\" FROM auth.\"AspNetUsers\" WHERE \"NormalizedEmail\" = @e", ("e", email.ToUpperInvariant()));
}
