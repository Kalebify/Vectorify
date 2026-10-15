using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Vectorify.Api.Contracts;
using Vectorify.Api.Endpoints;
using Vectorify.Api.Tests.TestSupport;
using Vectorify.Api.Users;

namespace Vectorify.Api.Tests.EndToEnd;

/// <summary>
/// <c>POST /api/v1/auth/register</c> (M3.1-S02) contra la Web API REAL y PostgreSQL real (Testcontainers): registro correcto,
/// registro repetido (respuesta uniforme y sin duplicados), correo conflictivo, validación, concurrencia y que la contraseña
/// nunca se guarde en claro ni aparezca en respuestas o logs. Corre con el <c>Auth:Mode=Development</c> explícito del
/// entorno de desarrollo: el registro funciona igual en ambos modos (ver también <see cref="AuthenticatedModePipelineTests"/>).
/// </summary>
public sealed class AuthRegisterEndpointTests : IClassFixture<AuthApiFixture>, IAsyncLifetime
{
    private const string StrongPassword = "una-contrasena-larga-1";

    private readonly AuthApiFixture _fixture;
    private readonly CapturingLoggerProvider _logs = new();
    private string _connectionString = string.Empty;
    private WebApplicationFactory<Program> _factory = null!;
    private HttpClient _client = null!;

    public AuthRegisterEndpointTests(AuthApiFixture fixture)
    {
        _fixture = fixture;
    }

    public async Task InitializeAsync()
    {
        _connectionString = await _fixture.CreateDatabaseAsync();
        _factory = _fixture.CreateFactory(_connectionString, logProvider: _logs);
        _client = _factory.CreateClient();
    }

    public async Task DisposeAsync()
    {
        _client.Dispose();
        await _factory.DisposeAsync();
    }

    [Fact]
    public async Task Register_NewAccount_Returns202_AndCreatesTheAccountTheLocalUserAndTheLinkExactlyOnce()
    {
        var email = NewEmail();

        var response = await RegisterAsync(email, StrongPassword);

        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        Assert.Equal(new RegisterResponse(AuthEndpoints.RegisterAcceptedStatus), await response.Content.ReadFromJsonAsync<RegisterResponse>());

        Assert.Equal(1, await CountAccountsAsync(email));
        Assert.Equal(1, await CountUsersAsync(email));
        // Provider = aspnet-identity, Subject = AspNetUsers.Id, y el vínculo apunta al User con ese correo.
        Assert.Equal(1, await _fixture.ScalarAsync<long>(
            _connectionString,
            """
            SELECT count(*) FROM auth."AspNetUsers" a
            JOIN user_identities i ON i."Provider" = 'aspnet-identity' AND i."Subject" = a."Id"::text
            JOIN users u ON u."Id" = i."UserId"
            WHERE a."NormalizedEmail" = @e AND u."Email" = @plain
            """,
            ("e", email.ToUpperInvariant()), ("plain", email)));
        Assert.Equal(0, await CountOrphanUsersAsync(email));
    }

    [Fact]
    public async Task Register_NewAccount_StoresOnlyNecessaryDataAndTimestamps_AndTheAccountIsNotConfirmedYet()
    {
        var email = NewEmail();

        await RegisterAsync(email, StrongPassword);

        Assert.True(await _fixture.ScalarAsync<bool>(
            _connectionString,
            """
            SELECT a."CreatedAt" > now() - interval '1 minute' AND a."EmailConfirmed" = false AND a."LockoutEnabled" = true
                   AND a."PhoneNumber" IS NULL AND a."TwoFactorEnabled" = false
            FROM auth."AspNetUsers" a WHERE a."NormalizedEmail" = @e
            """,
            ("e", email.ToUpperInvariant())));
        Assert.True(await _fixture.ScalarAsync<bool>(
            _connectionString,
            """SELECT u."CreatedAt" > now() - interval '1 minute' AND u."ExternalIdentityId" IS NULL FROM users u WHERE u."Email" = @e""",
            ("e", email)));
    }

    [Fact]
    public async Task Register_SameEmailTwice_ReturnsAnIdenticalResponse_AndDoesNotDuplicateAnything()
    {
        var email = NewEmail();

        var first = await RegisterAsync(email, StrongPassword);
        var second = await RegisterAsync(email, StrongPassword);

        await AssertUniformAsync(first, second);
        Assert.Equal(1, await CountAccountsAsync(email));
        Assert.Equal(1, await CountUsersAsync(email));
        Assert.Equal(0, await CountOrphanUsersAsync(email));
    }

    [Fact]
    public async Task Register_ExistingEmailWithADifferentPassword_ReturnsTheSameResponse_AndNeverChangesTheStoredHash()
    {
        var email = NewEmail();
        var first = await RegisterAsync(email, StrongPassword);
        var hashBefore = await PasswordHashAsync(email);

        var second = await RegisterAsync(email, "otra-contrasena-distinta-9");

        await AssertUniformAsync(first, second);
        Assert.Equal(hashBefore, await PasswordHashAsync(email));
    }

    [Theory]
    [InlineData("MAYUSCULAS@Vectorify.Test")]
    [InlineData("  espacios@vectorify.test  ")]
    public async Task Register_ConflictingEmailInDifferentCaseOrWithSpaces_IsTheSameAccount_WithTheUniformResponse(string variant)
    {
        var unique = Guid.NewGuid().ToString("N")[..10];
        var canonical = variant.Trim().Replace("@", $"{unique}@", StringComparison.Ordinal).ToLowerInvariant();
        var variantWithSuffix = variant.Replace("@", $"{unique}@", StringComparison.Ordinal);
        var first = await RegisterAsync(canonical, StrongPassword);

        var second = await RegisterAsync(variantWithSuffix, StrongPassword);

        await AssertUniformAsync(first, second);
        Assert.Equal(1, await CountAccountsAsync(canonical));
        Assert.Equal(1, await CountUsersAsync(canonical));
    }

    [Fact]
    public async Task Register_ValidationErrors_DoNotDependOnWhetherTheEmailExists()
    {
        var existing = NewEmail();
        await RegisterAsync(existing, StrongPassword);

        var forExisting = await RegisterAsync(existing, "corta");
        var forNew = await RegisterAsync(NewEmail(), "corta");

        Assert.Equal(HttpStatusCode.BadRequest, forExisting.StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, forNew.StatusCode);
        Assert.Equal(await forNew.Content.ReadAsStringAsync(), await forExisting.Content.ReadAsStringAsync());
    }

    [Theory]
    [InlineData("")]
    [InlineData("1")]
    [InlineData("12345678901")] // 11 caracteres: justo por debajo del límite
    public async Task Register_PasswordShorterThan12_Returns400WeakPassword_AndCreatesNothing(string password)
    {
        Assert.True(password.Length < 12);
        var email = NewEmail();

        var response = await RegisterAsync(email, password);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var error = await response.Content.ReadFromJsonAsync<ApiErrorResponse>();
        Assert.Equal("weak_password", error!.Code);
        Assert.Contains("12", error.Message);
        Assert.Equal(0, await CountAccountsAsync(email));
        Assert.Equal(0, await CountUsersAsync(email));
    }

    [Fact]
    public async Task Register_PasswordOfExactly12Characters_IsAccepted_AndMoreThan128IsRejected()
    {
        var accepted = await RegisterAsync(NewEmail(), new string('a', 12));
        var rejected = await RegisterAsync(NewEmail(), new string('a', 129));

        Assert.Equal(HttpStatusCode.Accepted, accepted.StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, rejected.StatusCode);
        Assert.Equal("weak_password", (await rejected.Content.ReadFromJsonAsync<ApiErrorResponse>())!.Code);
    }

    [Fact]
    public async Task Register_PasswordPolicy_IsLengthOnly_NoCompositionRules()
    {
        // NIST 800-63B: una frase larga de solo minúsculas es válida.
        var response = await RegisterAsync(NewEmail(), "frase larga de solo minusculas");

        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("sin-arroba")]
    [InlineData("a@b")]
    [InlineData("dos@@vectorify.test")]
    [InlineData("Ana <ana@vectorify.test>")]
    [InlineData("con espacios@vectorify.test")]
    [InlineData("a@vectorify.test, b@vectorify.test")]
    public async Task Register_InvalidEmail_Returns400InvalidEmail_AndCreatesNothing(string? email)
    {
        var before = await _fixture.ScalarAsync<long>(_connectionString, "SELECT count(*) FROM auth.\"AspNetUsers\"");

        var response = await _client.PostAsJsonAsync(AuthEndpoints.RegisterPath, new RegisterRequest(email, StrongPassword));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("invalid_email", (await response.Content.ReadFromJsonAsync<ApiErrorResponse>())!.Code);
        Assert.Equal(before, await _fixture.ScalarAsync<long>(_connectionString, "SELECT count(*) FROM auth.\"AspNetUsers\""));
    }

    [Fact]
    public async Task Register_EmailLongerThan254_Returns400()
    {
        var response = await RegisterAsync(new string('a', 250) + "@x.test", StrongPassword);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Register_WithoutPassword_Returns400WeakPassword()
    {
        var response = await _client.PostAsJsonAsync(AuthEndpoints.RegisterPath, new RegisterRequest(NewEmail(), null));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("weak_password", (await response.Content.ReadFromJsonAsync<ApiErrorResponse>())!.Code);
    }

    [Fact]
    public async Task Register_PasswordIsNeverStoredInClear_NorReturned()
    {
        var email = NewEmail();
        var password = "contrasena-secreta-" + Guid.NewGuid().ToString("N");

        var response = await RegisterAsync(email, password);
        var duplicate = await RegisterAsync(email, password);

        var hash = await PasswordHashAsync(email);
        Assert.NotEmpty(hash);
        Assert.DoesNotContain(password, hash, StringComparison.Ordinal);
        Assert.StartsWith("AQAAAA", hash, StringComparison.Ordinal); // formato v3 de Identity: PBKDF2 con sal y número de iteraciones
        Assert.True(hash.Length > 60);

        // Ninguna columna de ninguna fila de las tablas de identidad/dominio contiene la contraseña en claro.
        foreach (var table in new[] { "auth.\"AspNetUsers\"", "auth.\"AspNetUserClaims\"", "auth.\"AspNetUserLogins\"", "auth.\"AspNetUserTokens\"", "users", "user_identities" })
        {
            Assert.Equal(0, await _fixture.ScalarAsync<long>(
                _connectionString, $"SELECT count(*) FROM {table} t WHERE t::text LIKE @p", ("p", $"%{password}%")));
        }

        foreach (var r in new[] { response, duplicate })
        {
            Assert.DoesNotContain(password, await r.Content.ReadAsStringAsync(), StringComparison.Ordinal);
            Assert.DoesNotContain(r.Headers.Concat(r.Content.Headers), h => h.Value.Any(v => v.Contains(password, StringComparison.Ordinal)));
        }
    }

    [Fact]
    public async Task Register_NeverWritesThePasswordNorTheEmailToTheLogs_InAnyOutcome()
    {
        var password = "no-debe-loguearse-" + Guid.NewGuid().ToString("N");
        var email = NewEmail();

        await RegisterAsync(email, password);        // alta
        await RegisterAsync(email, password);        // repetido
        await RegisterAsync(email, "corta");         // contraseña inválida
        await RegisterAsync("no-es-un-correo", password);

        Assert.NotEmpty(_logs.Entries); // el captor realmente recibe el log de la aplicación
        Assert.DoesNotContain(_logs.Entries, entry => entry.Contains(password, StringComparison.Ordinal));
        Assert.DoesNotContain(_logs.Entries, entry => entry.Contains(email, StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(_logs.Entries, entry => entry.Contains("no-es-un-correo", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task Register_TwelveConcurrentRequestsForTheSameEmail_CreateOneAccountOneUserAndNoOrphans()
    {
        var email = NewEmail();
        using var gate = new ManualResetEventSlim(false);

        var tasks = Enumerable.Range(0, 12).Select(_ => Task.Run(async () =>
        {
            gate.Wait();
            return await RegisterAsync(email, StrongPassword);
        })).ToArray();
        gate.Set();
        var responses = await Task.WhenAll(tasks);

        Assert.All(responses, r => Assert.Equal(HttpStatusCode.Accepted, r.StatusCode));
        Assert.Single((await Task.WhenAll(responses.Select(r => r.Content.ReadAsStringAsync()))).Distinct()); // cuerpo idéntico en las 12
        Assert.Equal(1, await CountAccountsAsync(email));
        Assert.Equal(1, await CountUsersAsync(email));
        Assert.Equal(0, await CountOrphanUsersAsync(email));
    }

    [Fact]
    public async Task Register_DifferentEmails_CreateDifferentLocalUsers()
    {
        var emails = Enumerable.Range(0, 5).Select(_ => NewEmail()).ToArray();

        var responses = await Task.WhenAll(emails.Select(e => RegisterAsync(e, StrongPassword)));

        Assert.All(responses, r => Assert.Equal(HttpStatusCode.Accepted, r.StatusCode));
        foreach (var email in emails)
        {
            Assert.Equal(1, await CountUsersAsync(email));
            Assert.Equal(0, await CountOrphanUsersAsync(email));
        }

        Assert.Equal(5, await _fixture.ScalarAsync<long>(
            _connectionString,
            "SELECT count(DISTINCT \"UserId\") FROM user_identities WHERE \"Subject\" IN (SELECT \"Id\"::text FROM auth.\"AspNetUsers\" WHERE \"NormalizedEmail\" = ANY(@e))",
            ("e", emails.Select(e => e.ToUpperInvariant()).ToArray())));
    }

    [Fact]
    public async Task Register_WhenTheLocalUserCannotBeProvisioned_StillReturnsTheUniformResponse_AndTheUserIsCreatedOnFirstAuthenticatedRequest()
    {
        var email = NewEmail();
        await using (var failing = _fixture.CreateFactory(
            _connectionString, configureServices: s => s.AddScoped<IUserProvisioner, ThrowingProvisioner>()))
        {
            using var client = failing.CreateClient();
            var response = await client.PostAsJsonAsync(AuthEndpoints.RegisterPath, new RegisterRequest(email, StrongPassword));
            Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        }

        Assert.Equal(1, await CountAccountsAsync(email));
        Assert.Equal(0, await CountUsersAsync(email)); // la provisión falló: todavía no hay User

        var accountId = await _fixture.ScalarAsync<Guid>(
            _connectionString, "SELECT \"Id\" FROM auth.\"AspNetUsers\" WHERE \"NormalizedEmail\" = @e", ("e", email.ToUpperInvariant()));
        await using var healthy = _fixture.CreateFactory(_connectionString, authenticated: true, testScheme: true);
        using var authenticated = healthy.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/v2/projects");
        request.Headers.Add("X-Test-Sub", accountId.ToString());
        request.Headers.Add("X-Test-Email", email);
        var projects = await authenticated.SendAsync(request);

        Assert.Equal(HttpStatusCode.OK, projects.StatusCode);
        Assert.Equal(1, await CountUsersAsync(email)); // autocorrección
        Assert.Equal(0, await CountOrphanUsersAsync(email));
    }

    [Fact]
    public async Task Register_ResponseHasNoSessionCookie_BecauseLoginIsAnotherCard()
    {
        var response = await RegisterAsync(NewEmail(), StrongPassword);

        Assert.False(response.Headers.Contains("Set-Cookie"));
    }

    // -------------------------------------------------------------------------------------------------------------

    private static string NewEmail() => $"user-{Guid.NewGuid():N}@vectorify.test";

    private Task<HttpResponseMessage> RegisterAsync(string email, string password) =>
        _client.PostAsJsonAsync(AuthEndpoints.RegisterPath, new RegisterRequest(email, password));

    private static async Task AssertUniformAsync(HttpResponseMessage expected, HttpResponseMessage actual)
    {
        Assert.Equal(expected.StatusCode, actual.StatusCode);
        Assert.Equal(await expected.Content.ReadAsStringAsync(), await actual.Content.ReadAsStringAsync());
        Assert.Equal(expected.Content.Headers.ContentType, actual.Content.Headers.ContentType);
        Assert.Equal(expected.Content.Headers.ContentLength, actual.Content.Headers.ContentLength);
        Assert.Equal(
            expected.Headers.Where(h => h.Key != "X-Correlation-Id" && h.Key != "Date").Select(h => h.Key).Order(),
            actual.Headers.Where(h => h.Key != "X-Correlation-Id" && h.Key != "Date").Select(h => h.Key).Order());
        Assert.Equal(
            JsonSerializer.Serialize(new RegisterResponse(AuthEndpoints.RegisterAcceptedStatus), new JsonSerializerOptions(JsonSerializerDefaults.Web)),
            await actual.Content.ReadAsStringAsync());
    }

    private Task<long> CountAccountsAsync(string email) =>
        _fixture.ScalarAsync<long>(
            _connectionString,
            "SELECT count(*) FROM auth.\"AspNetUsers\" WHERE \"NormalizedEmail\" = @e",
            ("e", email.Trim().ToUpperInvariant()));

    private Task<long> CountUsersAsync(string email) =>
        _fixture.ScalarAsync<long>(
            _connectionString, "SELECT count(*) FROM users WHERE lower(\"Email\") = lower(@e)", ("e", email.Trim()));

    private Task<long> CountOrphanUsersAsync(string email) =>
        _fixture.ScalarAsync<long>(
            _connectionString,
            "SELECT count(*) FROM users u WHERE lower(u.\"Email\") = lower(@e) AND NOT EXISTS (SELECT 1 FROM user_identities i WHERE i.\"UserId\" = u.\"Id\")",
            ("e", email.Trim()));

    private Task<string> PasswordHashAsync(string email) =>
        _fixture.ScalarAsync<string>(
            _connectionString,
            "SELECT \"PasswordHash\" FROM auth.\"AspNetUsers\" WHERE \"NormalizedEmail\" = @e",
            ("e", email.Trim().ToUpperInvariant()));

    private sealed class ThrowingProvisioner : IUserProvisioner
    {
        public Task<ProvisionedUser> EnsureUserAsync(ExternalIdentity identity, CancellationToken cancellationToken) =>
            throw new InvalidOperationException("provisión caída (simulada)");
    }
}
