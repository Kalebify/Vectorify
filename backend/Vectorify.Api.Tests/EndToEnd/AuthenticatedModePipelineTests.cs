using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Vectorify.Api.Contracts;
using Vectorify.Api.Data.Auth;
using Vectorify.Api.Endpoints;
using Vectorify.Api.Options;
using Vectorify.Api.Tests.TestSupport;
using Vectorify.Api.Users;

namespace Vectorify.Api.Tests.EndToEnd;

/// <summary>
/// Tubería de identidad de M3.1-S02 con la Web API REAL y PostgreSQL real: cookie de Identity -&gt; <c>UseAuthentication</c> -&gt;
/// <c>UserProvisioningMiddleware</c> ((Provider, Subject) -&gt; <c>User.Id</c>) -&gt; <see cref="AuthenticatedUserContext"/> -&gt;
/// los servicios de dominio SIN CAMBIOS (<c>/api/v2/projects</c> filtra por <c>OwnerId</c>). Cubre también la RESTRICCIÓN de no romper el
/// producto: con <c>Auth:Mode=Development</c> (lo que fija el entorno de desarrollo) todo sigue siendo el usuario de desarrollo.
/// Aquí la cookie se fabrica en el test (ticket protegido con el formato de Identity); el login real de S03 y las cookies emitidas por el servidor se prueban en <see cref="AuthLoginLogoutTests"/>. Desde S03 el cliente envía la cabecera anti-CSRF y un Origin permitido (CsrfGuard).
/// </summary>
public sealed class AuthenticatedModePipelineTests : IClassFixture<AuthApiFixture>
{
    private const string Password = "una-contrasena-larga-1";

    private readonly AuthApiFixture _fixture;

    public AuthenticatedModePipelineTests(AuthApiFixture fixture)
    {
        _fixture = fixture;
    }

    [Fact]
    public async Task SessionCookie_OfAnAccountRegisteredOverHttp_ResolvesTheAlreadyLinkedUser_AndOwnsItsProjects()
    {
        var connectionString = await _fixture.CreateDatabaseAsync();
        await using var factory = _fixture.CreateFactory(connectionString, authenticated: true);
        using var client = factory.CreateClient().WithCsrf();
        var alice = await RegisterAndSignInAsync(factory, client, NewEmail());
        var bob = await RegisterAndSignInAsync(factory, client, NewEmail());

        var created = await SendAsync(client, HttpMethod.Post, "/api/v2/projects", alice.Cookie, new CreateProjectRequest("De Alice", null));
        var aliceList = await SendAsync(client, HttpMethod.Get, "/api/v2/projects", alice.Cookie);
        var bobList = await SendAsync(client, HttpMethod.Get, "/api/v2/projects", bob.Cookie);

        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        var project = (await created.Content.ReadFromJsonAsync<ProjectResponse>())!;
        Assert.Equal(await LinkedUserIdAsync(connectionString, alice.AccountId), project.OwnerId); // OwnerId lo pone el servidor
        Assert.NotEqual(await LinkedUserIdAsync(connectionString, bob.AccountId), project.OwnerId);
        Assert.Equal(1, (await aliceList.Content.ReadFromJsonAsync<ProjectListResponse>())!.TotalCount);
        Assert.Equal(0, (await bobList.Content.ReadFromJsonAsync<ProjectListResponse>())!.TotalCount);

        // El middleware reutilizó el vínculo creado al registrarse: ni duplicó Users ni creó vínculos nuevos.
        Assert.Equal(1, await _fixture.ScalarAsync<long>(connectionString, "SELECT count(*) FROM users WHERE \"Email\" = @e", ("e", alice.Email)));
        Assert.Equal(2, await _fixture.ScalarAsync<long>(connectionString, "SELECT count(*) FROM user_identities"));
    }

    [Fact]
    public async Task AnAuthenticatedRequest_ForAnAccountWithoutLocalUser_CreatesItOnce_AndRepeatedRequestsKeepTheSameUser()
    {
        var connectionString = await _fixture.CreateDatabaseAsync();
        await using var factory = _fixture.CreateFactory(connectionString, authenticated: true, testScheme: true);
        using var client = factory.CreateClient().WithCsrf();
        var subject = Guid.NewGuid().ToString();
        var email = NewEmail();

        var owners = new List<Guid>();
        for (var i = 0; i < 3; i++)
        {
            var response = await SendWithTestIdentityAsync(client, HttpMethod.Post, "/api/v2/projects", subject, email, new CreateProjectRequest($"P{i}", null));
            Assert.Equal(HttpStatusCode.Created, response.StatusCode);
            owners.Add((await response.Content.ReadFromJsonAsync<ProjectResponse>())!.OwnerId);
        }

        Assert.Single(owners.Distinct());
        Assert.Equal(1, await _fixture.ScalarAsync<long>(connectionString, "SELECT count(*) FROM users WHERE \"Email\" = @e", ("e", email)));
        Assert.Equal(1, await _fixture.ScalarAsync<long>(
            connectionString, "SELECT count(*) FROM user_identities WHERE \"Provider\" = 'aspnet-identity' AND \"Subject\" = @s", ("s", subject)));
    }

    [Fact]
    public async Task TwelveParallelFirstRequests_CreateASingleUser_WithoutOrphans()
    {
        var connectionString = await _fixture.CreateDatabaseAsync();
        await using var factory = _fixture.CreateFactory(connectionString, authenticated: true, testScheme: true);
        using var client = factory.CreateClient().WithCsrf();
        var subject = Guid.NewGuid().ToString();
        var email = NewEmail();
        using var gate = new ManualResetEventSlim(false);

        var tasks = Enumerable.Range(0, 12).Select(i => Task.Run(async () =>
        {
            gate.Wait();
            return await SendWithTestIdentityAsync(client, HttpMethod.Post, "/api/v2/projects", subject, email, new CreateProjectRequest($"P{i}", null));
        })).ToArray();
        gate.Set();
        var responses = await Task.WhenAll(tasks);

        Assert.All(responses, r => Assert.Equal(HttpStatusCode.Created, r.StatusCode));
        var owners = await Task.WhenAll(responses.Select(async r => (await r.Content.ReadFromJsonAsync<ProjectResponse>())!.OwnerId));
        Assert.Single(owners.Distinct());
        Assert.Equal(1, await _fixture.ScalarAsync<long>(connectionString, "SELECT count(*) FROM users WHERE \"Email\" = @e", ("e", email)));
        Assert.Equal(1, await _fixture.ScalarAsync<long>(connectionString, "SELECT count(*) FROM user_identities WHERE \"Subject\" = @s", ("s", subject)));
        Assert.Equal(0, await _fixture.ScalarAsync<long>(
            connectionString,
            "SELECT count(*) FROM users u WHERE u.\"Email\" = @e AND NOT EXISTS (SELECT 1 FROM user_identities i WHERE i.\"UserId\" = u.\"Id\")",
            ("e", email)));
        Assert.Equal(12, await _fixture.ScalarAsync<long>(connectionString, "SELECT count(*) FROM projects WHERE \"OwnerId\" = @o", ("o", owners[0])));
    }

    [Fact]
    public async Task AClaimNamedLikeTheInternalOne_InsideTheProviderIdentity_CannotImpersonateAnotherUser()
    {
        var connectionString = await _fixture.CreateDatabaseAsync();
        await using var factory = _fixture.CreateFactory(connectionString, authenticated: true, testScheme: true);
        using var client = factory.CreateClient().WithCsrf();
        var victim = await SendWithTestIdentityAsync(client, HttpMethod.Post, "/api/v2/projects", Guid.NewGuid().ToString(), NewEmail(), new CreateProjectRequest("Víctima", null));
        var victimId = (await victim.Content.ReadFromJsonAsync<ProjectResponse>())!.OwnerId;

        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v2/projects")
        {
            Content = JsonContent.Create(new CreateProjectRequest("Del atacante", null)),
        };
        request.Headers.Add("X-Test-Sub", Guid.NewGuid().ToString());
        request.Headers.Add("X-Test-Email", NewEmail());
        request.Headers.Add("X-Test-Forged-Uid", victimId.ToString());
        var attack = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.Created, attack.StatusCode);
        Assert.NotEqual(victimId, (await attack.Content.ReadFromJsonAsync<ProjectResponse>())!.OwnerId);
    }

    [Fact]
    public async Task AnAuthenticatedPrincipalWithoutAUsableSubject_IsRejectedWith401_AndNothingIsCreated()
    {
        var connectionString = await _fixture.CreateDatabaseAsync();
        await using var factory = _fixture.CreateFactory(connectionString, authenticated: true, testScheme: true);
        using var client = factory.CreateClient().WithCsrf();
        var usersBefore = await _fixture.ScalarAsync<long>(connectionString, "SELECT count(*) FROM users");

        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/v2/projects");
        request.Headers.Add("X-Test-NoSubject", "1");
        var response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Equal(usersBefore, await _fixture.ScalarAsync<long>(connectionString, "SELECT count(*) FROM users"));
    }

    [Fact]
    public async Task AuthenticatedMode_KeepsHealthAndRegistrationAnonymous_AndDoesNotSeedTheDevelopmentUser()
    {
        var connectionString = await _fixture.CreateDatabaseAsync();
        await using var factory = _fixture.CreateFactory(connectionString, authenticated: true);
        using var client = factory.CreateClient().WithCsrf();

        var health = await client.GetAsync("/health");
        var register = await client.PostAsJsonAsync(AuthEndpoints.RegisterPath, new RegisterRequest(NewEmail(), Password));

        Assert.Equal(HttpStatusCode.OK, health.StatusCode);
        Assert.Equal(HttpStatusCode.Accepted, register.StatusCode);
        Assert.Equal(AuthMode.Authenticated, factory.Services.GetRequiredService<IOptions<AuthOptions>>().Value.Mode);
        using var scope = factory.Services.CreateScope();
        Assert.IsType<AuthenticatedUserContext>(scope.ServiceProvider.GetRequiredService<IUserContext>());
        Assert.Equal(0, await _fixture.ScalarAsync<long>(
            connectionString, "SELECT count(*) FROM users WHERE \"Id\" = @d", ("d", DevelopmentUserOptions.DefaultUserId)));
    }

    // ------------------------------------------------------------------ RESTRICCIÓN: el producto existente no cambia

    [Fact]
    public async Task DevelopmentMode_IsWhatTheDevelopmentEnvironmentConfigures_AndTheApiKeepsServingWithoutASession()
    {
        var connectionString = await _fixture.CreateDatabaseAsync();
        await using var factory = _fixture.CreateFactory(connectionString);
        using var client = factory.CreateClient().WithCsrf();

        var created = await client.PostAsJsonAsync("/api/v2/projects", new CreateProjectRequest("Sin sesión", null));
        var list = await client.GetAsync("/api/v2/projects");

        Assert.Equal(AuthMode.Development, factory.Services.GetRequiredService<IOptions<AuthOptions>>().Value.Mode);
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        Assert.Equal(DevelopmentUserOptions.DefaultUserId, (await created.Content.ReadFromJsonAsync<ProjectResponse>())!.OwnerId);
        Assert.Equal(HttpStatusCode.OK, list.StatusCode);
        Assert.Equal(1, await _fixture.ScalarAsync<long>(
            connectionString, "SELECT count(*) FROM users WHERE \"Id\" = @d", ("d", DevelopmentUserOptions.DefaultUserId)));
        using var scope = factory.Services.CreateScope();
        Assert.IsType<DevelopmentUserContext>(scope.ServiceProvider.GetRequiredService<IUserContext>());
    }

    [Fact]
    public async Task DevelopmentMode_IgnoresAValidSessionCookie_TheEffectiveUserIsStillTheDevelopmentUser()
    {
        var connectionString = await _fixture.CreateDatabaseAsync();
        await using var factory = _fixture.CreateFactory(connectionString);
        using var client = factory.CreateClient().WithCsrf();
        var session = await RegisterAndSignInAsync(factory, client, NewEmail());

        var created = await SendAsync(client, HttpMethod.Post, "/api/v2/projects", session.Cookie, new CreateProjectRequest("Con cookie en modo dev", null));

        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        Assert.Equal(DevelopmentUserOptions.DefaultUserId, (await created.Content.ReadFromJsonAsync<ProjectResponse>())!.OwnerId);
    }

    // -------------------------------------------------------------------------------------------------------------

    private sealed record Session(Guid AccountId, string Email, string Cookie);

    private static string NewEmail() => $"user-{Guid.NewGuid():N}@vectorify.test";

    /// <summary>Registra por HTTP y emite la cookie de sesión de Identity con el mismo ticket protegido que emitirá el login de S03.</summary>
    private static async Task<Session> RegisterAndSignInAsync(WebApplicationFactory<Program> factory, HttpClient client, string email)
    {
        var register = await client.PostAsJsonAsync(AuthEndpoints.RegisterPath, new RegisterRequest(email, Password));
        Assert.Equal(HttpStatusCode.Accepted, register.StatusCode);

        using var scope = factory.Services.CreateScope();
        var account = (await scope.ServiceProvider.GetRequiredService<UserManager<ApplicationUser>>().FindByEmailAsync(email))!;
        var principal = await scope.ServiceProvider.GetRequiredService<SignInManager<ApplicationUser>>().CreateUserPrincipalAsync(account);

        var cookieOptions = scope.ServiceProvider.GetRequiredService<IOptionsMonitor<CookieAuthenticationOptions>>().Get(IdentityConstants.ApplicationScheme);
        var ticket = new AuthenticationTicket(
            principal,
            new AuthenticationProperties { IssuedUtc = DateTimeOffset.UtcNow, ExpiresUtc = DateTimeOffset.UtcNow.AddHours(1) },
            IdentityConstants.ApplicationScheme);
        return new Session(account.Id, email, $"{cookieOptions.Cookie.Name}={cookieOptions.TicketDataFormat.Protect(ticket)}");
    }

    private static Task<HttpResponseMessage> SendAsync(HttpClient client, HttpMethod method, string url, string cookie, object? body = null)
    {
        var request = new HttpRequestMessage(method, url);
        request.Headers.Add("Cookie", cookie);
        if (body is not null)
        {
            request.Content = JsonContent.Create(body);
        }

        return client.SendAsync(request);
    }

    private static Task<HttpResponseMessage> SendWithTestIdentityAsync(
        HttpClient client, HttpMethod method, string url, string subject, string email, object? body = null)
    {
        var request = new HttpRequestMessage(method, url);
        request.Headers.Add("X-Test-Sub", subject);
        request.Headers.Add("X-Test-Email", email);
        if (body is not null)
        {
            request.Content = JsonContent.Create(body);
        }

        return client.SendAsync(request);
    }

    private async Task<Guid> LinkedUserIdAsync(string connectionString, Guid accountId) =>
        await _fixture.ScalarAsync<Guid>(
            connectionString,
            "SELECT \"UserId\" FROM user_identities WHERE \"Provider\" = 'aspnet-identity' AND \"Subject\" = @s",
            ("s", accountId.ToString()));
}
