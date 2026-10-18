using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Vectorify.Api.Contracts;
using Vectorify.Api.Endpoints;
using Vectorify.Api.Tests.TestSupport;
using Vectorify.Api.Users;

namespace Vectorify.Api.Tests.EndToEnd;

/// <summary>
/// <c>GET/PATCH /api/v1/me</c> (M3.1-S07) contra la Web API REAL en <c>Auth:Mode=Authenticated</c> y PostgreSQL real (Testcontainers): cuentas reales
/// por <c>/register</c> + <c>/login</c>, cookies emitidas por el servidor, CSRF real. Decisión declarada: los campos del cuerpo que no son
/// <c>displayName</c> se IGNORAN (no se rechazan con 400) y los tests lo demuestran contra la base.
/// </summary>
public sealed class ProfileEndpointsTests : IClassFixture<AuthApiFixture>, IAsyncLifetime
{
    private readonly AuthApiFixture _fixture;
    private readonly CapturingLoggerProvider _logs = new();
    private string _connectionString = string.Empty;
    private WebApplicationFactory<Program> _factory = null!;
    private HttpClient _anonymous = null!;
    private TestUser _a = null!;
    private TestUser _b = null!;

    public ProfileEndpointsTests(AuthApiFixture fixture)
    {
        _fixture = fixture;
    }

    public async Task InitializeAsync()
    {
        _connectionString = await _fixture.CreateDatabaseAsync();
        _factory = IsolationWorldFixture.CreateAuthenticatedFactory(
            _fixture, _connectionString, "http://127.0.0.1:1", logProvider: _logs);
        _anonymous = _factory.CreateClient().WithCsrf();
        _a = await IsolationWorldFixture.SignInAsync(_factory);
        _b = await IsolationWorldFixture.SignInAsync(_factory);
    }

    public async Task DisposeAsync()
    {
        _anonymous.Dispose();
        _a.Client.Dispose();
        _b.Client.Dispose();
        await _factory.DisposeAsync();
    }

    // ------------------------------------------------------------------------------------------------ GET

    [Fact]
    public async Task Get_ReturnsTheOwnProfile_WithReadOnlyEmailAndTheManagedFieldsIndicator_AndNoStore()
    {
        var response = await _a.Client.GetAsync(ProfileEndpoints.ProfilePath);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Contains("no-store", response.Headers.CacheControl!.ToString(), StringComparison.Ordinal);
        var profile = (await response.Content.ReadFromJsonAsync<ProfileResponse>())!;
        Assert.Equal(_a.Id, profile.Id);
        Assert.Equal(_a.Email, profile.Email);
        Assert.Equal(_a.Email.Split('@')[0], profile.DisplayName); // nombre inicial = parte local del correo (UserProvisioner)
        Assert.True(profile.CreatedAt > DateTimeOffset.UtcNow.AddMinutes(-30) && profile.CreatedAt <= DateTimeOffset.UtcNow.AddMinutes(1));
        Assert.Equal(["email"], profile.ManagedFields);
    }

    [Fact]
    public async Task Get_ExposesExactlyTheDocumentedFields_NeverProviderSubjectHashOrStamp()
    {
        var raw = await (await _a.Client.GetAsync(ProfileEndpoints.ProfilePath)).Content.ReadAsStringAsync();

        using var document = JsonDocument.Parse(raw);
        Assert.Equal(
            ["createdAt", "displayName", "email", "id", "managedFields"],
            document.RootElement.EnumerateObject().Select(p => p.Name).Order(StringComparer.Ordinal).ToArray());
        foreach (var forbidden in new[] { "provider", "subject", "hash", "stamp", "password", "aspnet-identity" })
        {
            Assert.DoesNotContain(forbidden, raw, StringComparison.OrdinalIgnoreCase);
        }
    }

    [Fact]
    public async Task Get_WithoutASession_Returns401WithTheStandardBody()
    {
        var response = await _anonymous.GetAsync(ProfileEndpoints.ProfilePath);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Equal("unauthenticated", (await response.Content.ReadFromJsonAsync<ApiErrorResponse>())!.Code);
    }

    [Fact]
    public async Task Get_WithAForgedCookie_Returns401()
    {
        using var client = _factory.CreateClient().WithCsrf();
        client.DefaultRequestHeaders.Add("Cookie", "vectorify.session=CfDJ8-no-es-un-ticket-valido");

        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync(ProfileEndpoints.ProfilePath)).StatusCode);
    }

    [Fact]
    public async Task Get_IgnoresAUserIdInTheQueryOrHeaders_AndAlwaysReturnsTheSessionsUser()
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, $"{ProfileEndpoints.ProfilePath}?id={_b.Id}&userId={_b.Id}&ownerId={_b.Id}");
        request.Headers.Add("X-User-Id", _b.Id.ToString());

        var profile = (await (await _a.Client.SendAsync(request)).Content.ReadFromJsonAsync<ProfileResponse>())!;

        Assert.Equal(_a.Id, profile.Id);
        Assert.Equal(_a.Email, profile.Email);
    }

    // ------------------------------------------------------------------------------------------------ PATCH ok

    [Fact]
    public async Task Patch_UpdatesTheDisplayName_Trimmed_AndTheNewNameShowsInGetProfileAndInAuthMe()
    {
        var response = await Patch(_a, """{"displayName":"  Ana Gómez  "}""");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Contains("no-store", response.Headers.CacheControl!.ToString(), StringComparison.Ordinal);
        var updated = (await response.Content.ReadFromJsonAsync<ProfileResponse>())!;
        Assert.Equal("Ana Gómez", updated.DisplayName);
        Assert.Equal(_a.Id, updated.Id);

        var profile = (await _a.Client.GetFromJsonAsync<ProfileResponse>(ProfileEndpoints.ProfilePath))!;
        Assert.Equal("Ana Gómez", profile.DisplayName);
        var me = (await _a.Client.GetFromJsonAsync<CurrentUserResponse>(AuthEndpoints.MePath))!;
        Assert.Equal("Ana Gómez", me.DisplayName);
        Assert.Equal(_a.Id, me.Id);
        Assert.Equal("Ana Gómez", await DisplayNameInDatabaseAsync(_a.Id));
    }

    [Fact]
    public async Task Patch_TheEditedName_SurvivesANewLogin()
    {
        Assert.Equal(HttpStatusCode.OK, (await Patch(_a, """{"displayName":"Nombre nuevo"}""")).StatusCode);

        using var fresh = _factory.CreateClient().WithCsrf();
        var login = await fresh.PostAsJsonAsync(AuthEndpoints.LoginPath, new LoginRequest(_a.Email, IsolationWorldFixture.Password));

        Assert.Equal(HttpStatusCode.OK, login.StatusCode);
        Assert.Equal("Nombre nuevo", (await login.Content.ReadFromJsonAsync<CurrentUserResponse>())!.DisplayName);
    }

    [Theory]
    [InlineData("A")]
    [InlineData("José Ñandú 山田")]
    [InlineData("Ana 😀")]
    [InlineData("Ana-María O'Brien (la 2.ª)")]
    public async Task Patch_AcceptsLegitimateNames_IncludingUnicodeAndEmoji(string name)
    {
        var response = await Patch(_a, JsonSerializer.Serialize(new { displayName = name }));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(name, (await response.Content.ReadFromJsonAsync<ProfileResponse>())!.DisplayName);
        Assert.Equal(name, await DisplayNameInDatabaseAsync(_a.Id));
    }

    [Fact]
    public async Task Patch_AcceptsExactly80Characters_AndRejects81()
    {
        var eighty = new string('x', 80);
        Assert.Equal(HttpStatusCode.OK, (await Patch(_a, JsonSerializer.Serialize(new { displayName = eighty }))).StatusCode);
        Assert.Equal(eighty, await DisplayNameInDatabaseAsync(_a.Id));

        var response = await Patch(_a, JsonSerializer.Serialize(new { displayName = new string('x', 81) }));

        await AssertInvalidDisplayName(response, DisplayNameRules.LengthMessage);
        Assert.Equal(eighty, await DisplayNameInDatabaseAsync(_a.Id)); // el rechazo no tocó nada
    }

    [Fact]
    public async Task Patch_Counts80Utf16Units_TheSameMeasureAsTheClient()
    {
        var fortyEmoji = string.Concat(Enumerable.Repeat("😀", 40)); // 80 unidades UTF-16
        Assert.Equal(HttpStatusCode.OK, (await Patch(_a, JsonSerializer.Serialize(new { displayName = fortyEmoji }))).StatusCode);

        var response = await Patch(_a, JsonSerializer.Serialize(new { displayName = fortyEmoji + "a" }));

        await AssertInvalidDisplayName(response, DisplayNameRules.LengthMessage);
    }

    [Fact]
    public async Task Patch_IsIdempotent_TheSameNameTwiceKeepsReturning200()
    {
        Assert.Equal(HttpStatusCode.OK, (await Patch(_a, """{"displayName":"Igual"}""")).StatusCode);
        var again = await Patch(_a, """{"displayName":"Igual"}""");

        Assert.Equal(HttpStatusCode.OK, again.StatusCode);
        Assert.Equal("Igual", (await again.Content.ReadFromJsonAsync<ProfileResponse>())!.DisplayName);
    }

    // ------------------------------------------------------------------------------------------------ PATCH validación

    [Theory]
    [InlineData("""{"displayName":""}""", false)]
    [InlineData("""{"displayName":"     "}""", false)]
    [InlineData("""{"displayName":"     "}""", false)] // espacios Unicode
    [InlineData("""{"displayName":null}""", false)]
    [InlineData("""{}""", false)]
    [InlineData("""{"displayName":"Ana\tGómez"}""", true)]
    [InlineData("""{"displayName":"Ana\nGómez"}""", true)]
    [InlineData("""{"displayName":"Ana\r\nGómez"}""", true)]
    [InlineData("""{"displayName":"Ana\u0000Gómez"}""", true)]
    [InlineData("""{"displayName":"Ana\u007fGómez"}""", true)]
    [InlineData("""{"displayName":"Ana\u0085Gómez"}""", true)]
    [InlineData("""{"displayName":"Ana\u009fGómez"}""", true)]
    public async Task Patch_RejectsInvalidNames_With400InSpanish_AndChangesNothing(string body, bool controlCharacters)
    {
        var before = await DisplayNameInDatabaseAsync(_a.Id);

        var response = await Patch(_a, body);

        await AssertInvalidDisplayName(
            response, controlCharacters ? DisplayNameRules.ControlCharactersMessage : DisplayNameRules.LengthMessage);
        Assert.Equal(before, await DisplayNameInDatabaseAsync(_a.Id));
    }

    [Theory]
    [InlineData("{ esto no es json")]
    [InlineData("""{"displayName":5}""")]
    [InlineData("""{"displayName":["a"]}""")]
    [InlineData("""{"displayName":{"x":1}}""")]
    [InlineData("""[]""")]
    public async Task Patch_MalformedOrWronglyTypedBodies_Return400_AndChangeNothing(string body)
    {
        var before = await DisplayNameInDatabaseAsync(_a.Id);

        var response = await Patch(_a, body);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(before, await DisplayNameInDatabaseAsync(_a.Id));
    }

    [Fact]
    public async Task Patch_WithAJsonNullBody_OrWithoutABody_Returns400()
    {
        var before = await DisplayNameInDatabaseAsync(_a.Id);

        Assert.Equal(HttpStatusCode.BadRequest, (await Patch(_a, "null")).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await _a.Client.PatchAsync(ProfileEndpoints.ProfilePath, content: null)).StatusCode);
        Assert.Equal(before, await DisplayNameInDatabaseAsync(_a.Id));
    }

    [Fact]
    public async Task Patch_ValidationErrorResponses_AreNoStoreToo()
    {
        var response = await Patch(_a, """{"displayName":""}""");

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Contains("no-store", response.Headers.CacheControl!.ToString(), StringComparison.Ordinal);
    }

    // ------------------------------------------------------------------------------------------------ PATCH campos prohibidos

    [Fact]
    public async Task Patch_IgnoresEveryFieldThatIsNotDisplayName_AndKeepsIdentityAndEmailIntact()
    {
        var before = (await _a.Client.GetFromJsonAsync<ProfileResponse>(ProfileEndpoints.ProfilePath))!;
        var identityBefore = await IdentitySnapshotAsync(_a.Id);

        var body = $$"""
            {
              "displayName": "Solo cambia esto",
              "id": "{{_b.Id}}",
              "userId": "{{_b.Id}}",
              "ownerId": "{{_b.Id}}",
              "email": "intruso@vectorify.test",
              "provider": "google",
              "subject": "otro-subject",
              "externalIdentityId": "x",
              "createdAt": "2001-01-01T00:00:00Z",
              "authMode": "Development",
              "managedFields": [],
              "securityStamp": "x",
              "passwordHash": "x"
            }
            """;
        var response = await Patch(_a, body);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var after = (await response.Content.ReadFromJsonAsync<ProfileResponse>())!;
        Assert.Equal("Solo cambia esto", after.DisplayName);
        Assert.Equal(before.Id, after.Id);
        Assert.Equal(before.Email, after.Email);
        Assert.Equal(before.CreatedAt, after.CreatedAt);
        Assert.Equal(["email"], after.ManagedFields);
        Assert.Equal(identityBefore, await IdentitySnapshotAsync(_a.Id)); // User.Email/CreatedAt, vínculo y cuenta de Identity: idénticos
        Assert.Equal(_b.Email, (await _b.Client.GetFromJsonAsync<ProfileResponse>(ProfileEndpoints.ProfilePath))!.Email);

        // La sesión sigue siendo la misma persona.
        Assert.Equal(_a.Id, (await _a.Client.GetFromJsonAsync<CurrentUserResponse>(AuthEndpoints.MePath))!.Id);
    }

    [Fact]
    public async Task Patch_WithOnlyForbiddenFields_Returns400BecauseThereIsNoDisplayName_AndChangesNothing()
    {
        var identityBefore = await IdentitySnapshotAsync(_a.Id);

        var response = await Patch(_a, $$"""{"id":"{{_b.Id}}","email":"intruso@vectorify.test"}""");

        await AssertInvalidDisplayName(response, DisplayNameRules.LengthMessage);
        Assert.Equal(identityBefore, await IdentitySnapshotAsync(_a.Id));
    }

    [Fact]
    public async Task Patch_IgnoresAUserIdInTheQueryOrHeaders_AndNeverTouchesAnotherUser()
    {
        var bBefore = await DisplayNameInDatabaseAsync(_b.Id);

        using var request = new HttpRequestMessage(HttpMethod.Patch, $"{ProfileEndpoints.ProfilePath}?id={_b.Id}&userId={_b.Id}")
        {
            Content = new StringContent("""{"displayName":"Soy A"}""", Encoding.UTF8, "application/json"),
        };
        request.Headers.Add("X-User-Id", _b.Id.ToString());
        request.Headers.Add("X-Test-User-Id", _b.Id.ToString());
        var response = await _a.Client.SendAsync(request);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(_a.Id, (await response.Content.ReadFromJsonAsync<ProfileResponse>())!.Id);
        Assert.Equal("Soy A", await DisplayNameInDatabaseAsync(_a.Id));
        Assert.Equal(bBefore, await DisplayNameInDatabaseAsync(_b.Id));
    }

    // ------------------------------------------------------------------------------------------------ PATCH 401 / CSRF

    [Fact]
    public async Task Patch_WithoutASession_Returns401_AndChangesNothing()
    {
        var response = await _anonymous.PatchAsync(
            ProfileEndpoints.ProfilePath, new StringContent("""{"displayName":"Anónimo"}""", Encoding.UTF8, "application/json"));

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Equal("unauthenticated", (await response.Content.ReadFromJsonAsync<ApiErrorResponse>())!.Code);
    }

    [Fact]
    public async Task Patch_WithoutTheCsrfHeaderOrWithAForeignOrigin_Returns403_AndChangesNothing()
    {
        var before = await DisplayNameInDatabaseAsync(_a.Id);
        var cookie = await CookieHeaderOfAsync(_a);

        var cases = new (string Name, (string Header, string Value)[] Headers)[]
        {
            ("sin cabecera ni origen", []),
            ("sin cabecera", [("Origin", CsrfTestExtensions.AllowedOrigin)]),
            ("sin origen", [(CsrfTestExtensions.HeaderName, "1")]),
            ("origen ajeno", [(CsrfTestExtensions.HeaderName, "1"), ("Origin", "https://sitio-malicioso.example")]),
        };
        foreach (var (name, headers) in cases)
        {
            using var request = new HttpRequestMessage(HttpMethod.Patch, ProfileEndpoints.ProfilePath)
            {
                Content = new StringContent("""{"displayName":"Hackeado"}""", Encoding.UTF8, "application/json"),
            };
            request.Headers.Add("Cookie", cookie);
            foreach (var (header, value) in headers)
            {
                request.Headers.Add(header, value);
            }

            using var client = _factory.CreateClient(new WebApplicationFactoryClientOptions { HandleCookies = false });
            var response = await client.SendAsync(request);

            Assert.True(response.StatusCode == HttpStatusCode.Forbidden, $"{name}: se esperaba 403 y fue {(int)response.StatusCode}.");
            Assert.Equal("csrf_rejected", (await response.Content.ReadFromJsonAsync<ApiErrorResponse>())!.Code);
        }

        Assert.Equal(before, await DisplayNameInDatabaseAsync(_a.Id));
    }

    [Fact]
    public async Task Patch_AfterLogout_Returns401()
    {
        using var own = _factory.CreateClient().WithCsrf();
        await own.PostAsJsonAsync(AuthEndpoints.LoginPath, new LoginRequest(_a.Email, IsolationWorldFixture.Password));
        Assert.Equal(HttpStatusCode.NoContent, (await own.PostAsync(AuthEndpoints.LogoutPath, content: null)).StatusCode);

        var response = await own.PatchAsync(
            ProfileEndpoints.ProfilePath, new StringContent("""{"displayName":"Tras logout"}""", Encoding.UTF8, "application/json"));

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    // ------------------------------------------------------------------------------------------------ privacidad / aislamiento

    [Fact]
    public async Task Patch_DoesNotLogTheDisplayNameOrTheEmail()
    {
        Assert.Equal(HttpStatusCode.OK, (await Patch(_a, """{"displayName":"Nombre-secreto-xyz"}""")).StatusCode);

        var entries = _logs.Entries;
        Assert.DoesNotContain(entries, e => e.Contains("Nombre-secreto-xyz", StringComparison.Ordinal));
        Assert.DoesNotContain(entries, e => e.Contains(_a.Email, StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task EachUser_EditsOnlyTheirOwnProfile_AndSeesOnlyTheirOwn()
    {
        var bBefore = (await _b.Client.GetFromJsonAsync<ProfileResponse>(ProfileEndpoints.ProfilePath))!;

        Assert.Equal(HttpStatusCode.OK, (await Patch(_a, """{"displayName":"Solo de A"}""")).StatusCode);
        var bAfter = (await _b.Client.GetFromJsonAsync<ProfileResponse>(ProfileEndpoints.ProfilePath))!;
        Assert.Equal(bBefore.DisplayName, bAfter.DisplayName);
        Assert.Equal(bBefore.Email, bAfter.Email);
        Assert.Equal(_b.Id, bAfter.Id);

        Assert.Equal(HttpStatusCode.OK, (await Patch(_b, """{"displayName":"Solo de B"}""")).StatusCode);
        Assert.Equal("Solo de A", (await _a.Client.GetFromJsonAsync<ProfileResponse>(ProfileEndpoints.ProfilePath))!.DisplayName);
        Assert.Equal("Solo de B", (await _b.Client.GetFromJsonAsync<ProfileResponse>(ProfileEndpoints.ProfilePath))!.DisplayName);
    }

    // ------------------------------------------------------------------------------------------------ helpers

    private static Task<HttpResponseMessage> Patch(TestUser user, string json) =>
        user.Client.PatchAsync(ProfileEndpoints.ProfilePath, new StringContent(json, Encoding.UTF8, "application/json"));

    private static async Task AssertInvalidDisplayName(HttpResponseMessage response, string expectedMessage)
    {
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var error = (await response.Content.ReadFromJsonAsync<ApiErrorResponse>())!;
        Assert.Equal(DisplayNameRules.InvalidCode, error.Code);
        Assert.Equal(expectedMessage, error.Message);
    }

    private Task<string> DisplayNameInDatabaseAsync(Guid userId) =>
        _fixture.ScalarAsync<string>(_connectionString, """SELECT "DisplayName" FROM users WHERE "Id" = @id""", ("id", userId));

    /// <summary>Todo lo que S07 NO puede cambiar: email/fecha del User, su vínculo de identidad y la cuenta de Identity.</summary>
    private async Task<string> IdentitySnapshotAsync(Guid userId)
    {
        await using var connection = new Npgsql.NpgsqlConnection(_connectionString);
        await connection.OpenAsync();
        await using var command = new Npgsql.NpgsqlCommand(
            """
            SELECT u."Id"::text || '|' || coalesce(u."Email", '') || '|' || u."CreatedAt"::text || '|' ||
                   coalesce((SELECT string_agg(i."Provider" || ':' || i."Subject", ',' ORDER BY i."Provider") FROM user_identities i WHERE i."UserId" = u."Id"), '') || '|' ||
                   coalesce((SELECT a."Email" || ':' || a."SecurityStamp" || ':' || a."PasswordHash" FROM auth."AspNetUsers" a
                             JOIN user_identities i ON i."Subject" = a."Id"::text WHERE i."UserId" = u."Id" LIMIT 1), '')
            FROM users u WHERE u."Id" = @id
            """, connection);
        command.Parameters.AddWithValue("id", userId);
        return (string)(await command.ExecuteScalarAsync())!;
    }

    /// <summary>Cookie de sesión de <paramref name="user"/> (para reenviarla a mano sin cookie jar).</summary>
    private async Task<string> CookieHeaderOfAsync(TestUser user)
    {
        using var client = _factory.CreateClient(new WebApplicationFactoryClientOptions { HandleCookies = false }).WithCsrf();
        var login = await client.PostAsJsonAsync(AuthEndpoints.LoginPath, new LoginRequest(user.Email, IsolationWorldFixture.Password));
        Assert.Equal(HttpStatusCode.OK, login.StatusCode);
        return string.Join("; ", login.Headers.GetValues("Set-Cookie").Select(c => c.Split(';')[0]));
    }
}
