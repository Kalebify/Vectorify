using System.Net;
using System.Net.Http.Json;
using System.Text;
using Vectorify.Api.Contracts;
using Vectorify.Api.Endpoints;
using Vectorify.Api.Options;
using Vectorify.Api.Tests.TestSupport;
using Vectorify.Api.Users;

namespace Vectorify.Api.Tests.EndToEnd;

/// <summary>
/// <c>GET/PATCH /api/v1/me</c> en <c>Auth:Mode=Development</c> (M3.1-S07): el usuario de desarrollo (sin login, sin cookie ni cabecera anti-CSRF) edita su nombre
/// y <c>GET /api/v1/auth/me</c> lee <c>Users.DisplayName</c> (dominio), NO el valor de configuración <c>DevelopmentUser:DisplayName</c>, de modo que el nombre
/// editado sobrevive a una recarga y a un reinicio de la API (el sembrador no pisa una fila existente).
/// </summary>
public sealed class ProfileDevelopmentModeTests : IClassFixture<AuthApiFixture>
{
    private const string ConfiguredName = "Nombre de configuración";

    private readonly AuthApiFixture _fixture;

    public ProfileDevelopmentModeTests(AuthApiFixture fixture)
    {
        _fixture = fixture;
    }

    private static IDictionary<string, string?> DevSettings => new Dictionary<string, string?>
    {
        ["DevelopmentUser:DisplayName"] = ConfiguredName,
    };

    [Fact]
    public async Task TheDevelopmentUser_ReadsAndEditsTheirProfile_WithoutCookieOrCsrfHeader()
    {
        await using var factory = _fixture.CreateFactory(await _fixture.CreateDatabaseAsync(), settings: DevSettings);
        using var client = factory.CreateClient();

        var profile = (await client.GetFromJsonAsync<ProfileResponse>(ProfileEndpoints.ProfilePath))!;
        Assert.Equal(DevelopmentUserOptions.DefaultUserId, profile.Id);
        Assert.Equal("dev@vectorify.local", profile.Email);
        Assert.Equal(ConfiguredName, profile.DisplayName);
        Assert.Equal(["email"], profile.ManagedFields);

        var response = await client.PatchAsync(
            ProfileEndpoints.ProfilePath, new StringContent("""{"displayName":"  Dev editado  "}""", Encoding.UTF8, "application/json"));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("Dev editado", (await response.Content.ReadFromJsonAsync<ProfileResponse>())!.DisplayName);
    }

    [Fact]
    public async Task AuthMe_InDevelopmentMode_ReadsTheEditedUsersDisplayName_NotTheConfiguredOne()
    {
        await using var factory = _fixture.CreateFactory(await _fixture.CreateDatabaseAsync(), settings: DevSettings);
        using var client = factory.CreateClient();
        var before = (await client.GetFromJsonAsync<CurrentUserResponse>(AuthEndpoints.MePath))!;
        Assert.Equal(ConfiguredName, before.DisplayName);
        Assert.Equal("Development", before.AuthMode);

        await client.PatchAsync(
            ProfileEndpoints.ProfilePath, new StringContent("""{"displayName":"Editado en dev"}""", Encoding.UTF8, "application/json"));

        var after = (await client.GetFromJsonAsync<CurrentUserResponse>(AuthEndpoints.MePath))!;
        Assert.Equal("Editado en dev", after.DisplayName); // «recarga»: una consulta nueva
        Assert.Equal(before.Id, after.Id);
        Assert.Equal("Development", after.AuthMode);
    }

    [Fact]
    public async Task TheEditedName_SurvivesAnApiRestart_BecauseTheSeederNeverOverwritesAnExistingRow()
    {
        var connectionString = await _fixture.CreateDatabaseAsync();
        await using (var first = _fixture.CreateFactory(connectionString, settings: DevSettings))
        {
            using var client = first.CreateClient();
            Assert.Equal(HttpStatusCode.OK, (await client.PatchAsync(
                ProfileEndpoints.ProfilePath, new StringContent("""{"displayName":"Sobrevivo"}""", Encoding.UTF8, "application/json"))).StatusCode);
        }

        await using var second = _fixture.CreateFactory(connectionString, settings: DevSettings);
        using var restarted = second.CreateClient();

        Assert.Equal("Sobrevivo", (await restarted.GetFromJsonAsync<CurrentUserResponse>(AuthEndpoints.MePath))!.DisplayName);
        Assert.Equal("Sobrevivo", (await restarted.GetFromJsonAsync<ProfileResponse>(ProfileEndpoints.ProfilePath))!.DisplayName);
    }

    [Fact]
    public async Task Validation_AppliesInDevelopmentToo_AndForbiddenFieldsAreIgnored()
    {
        await using var factory = _fixture.CreateFactory(await _fixture.CreateDatabaseAsync(), settings: DevSettings);
        using var client = factory.CreateClient();

        var invalid = await client.PatchAsync(
            ProfileEndpoints.ProfilePath, new StringContent("""{"displayName":"   "}""", Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
        Assert.Equal(DisplayNameRules.InvalidCode, (await invalid.Content.ReadFromJsonAsync<ApiErrorResponse>())!.Code);

        var ok = await client.PatchAsync(
            ProfileEndpoints.ProfilePath,
            new StringContent($$"""{"displayName":"Dev 2","id":"{{Guid.NewGuid()}}","email":"otro@x.y"}""", Encoding.UTF8, "application/json"));
        var profile = (await ok.Content.ReadFromJsonAsync<ProfileResponse>())!;
        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
        Assert.Equal(DevelopmentUserOptions.DefaultUserId, profile.Id);
        Assert.Equal("dev@vectorify.local", profile.Email);
    }
}
