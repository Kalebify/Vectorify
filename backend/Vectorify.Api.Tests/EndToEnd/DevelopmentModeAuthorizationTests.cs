using System.Net;
using System.Net.Http.Json;
using Microsoft.Extensions.DependencyInjection;
using Vectorify.Api.Contracts;
using Vectorify.Api.Endpoints;
using Vectorify.Api.Options;
using Vectorify.Api.Projects;
using Vectorify.Api.Tests.TestSupport;

namespace Vectorify.Api.Tests.EndToEnd;

/// <summary>
/// M3.1-S06 en <c>Auth:Mode=Development</c> (usuario de desarrollo SIN login): la <c>FallbackPolicy</c> la satisface el usuario de desarrollo, así que el
/// flujo actual y los E2E anónimos (<c>tests/e2e</c>) siguen funcionando EXACTAMENTE igual -- sin cookie y sin cabecera anti-CSRF --, mientras los
/// registros de otro dueño siguen siendo inaccesibles y los legados sin dueño siguen accesibles solo para el usuario de desarrollo.
/// </summary>
public sealed class DevelopmentModeAuthorizationTests : IClassFixture<AuthApiFixture>
{
    private readonly AuthApiFixture _fixture;

    public DevelopmentModeAuthorizationTests(AuthApiFixture fixture)
    {
        _fixture = fixture;
    }

    [Fact]
    public async Task AnonymousClient_RunsTheWholeClassicAndV2Flow_ExactlyAsBefore()
    {
        await using var python = await IsolationWorldFixture.StartPythonAsync();
        await using var factory = _fixture.CreateFactory(
            await _fixture.CreateDatabaseAsync(), settings: new Dictionary<string, string?> { ["PythonEngine:BaseUrl"] = python.BaseUrl });
        using var client = factory.CreateClient(); // sin cookie, sin X-Vectorify-Request, sin Origin: como el frontend y los E2E de hoy

        var me = await client.GetFromJsonAsync<CurrentUserResponse>(AuthEndpoints.MePath);
        Assert.Equal("Development", me!.AuthMode);

        var world = await IsolationWorld.CreateAsync(client, "Flujo anónimo de desarrollo");
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync(world.ClassicBase)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync($"{world.ClassicBase}/original")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync($"/api/v2/projects/{world.ProjectId}/assets/{world.AssetId}")).StatusCode);
        var list = (await client.GetFromJsonAsync<ProjectListResponse>("/api/v2/projects"))!;
        Assert.Contains(list.Items, i => i.Id == world.ProjectId);
        Assert.Equal(me.Id, (await client.GetFromJsonAsync<ProjectResponse>($"/api/v2/projects/{world.ProjectId}"))!.OwnerId);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/health")).StatusCode);

        // Cada ruta protegida del flujo clásico deja pasar al usuario de desarrollo (ninguna responde 401 ni el 404 central).
        var central = System.Text.Json.JsonSerializer.Serialize(
            new ApiErrorResponse(Authorization.ClassicProjectOwnerMiddleware.NotFoundCode, Authorization.ClassicProjectOwnerMiddleware.NotFoundMessage),
            new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web));
        var ids = new Dictionary<string, string>
        {
            ["projectId"] = world.Classic.ProjectId.ToString(),
            ["imageId"] = world.Classic.ImageId.ToString(),
            ["paletteId"] = world.Classic.PaletteId.ToString(),
            ["groupId"] = world.Classic.LayerGroupIds[0].ToString(),
            ["vectorId"] = world.VectorIds[0].ToString(),
        };
        foreach (var route in RouteInventory.From(factory.Services).Where(r => r.IsInClassicProjectGroup))
        {
            using var request = new HttpRequestMessage(route.HttpMethod, route.Url(ids));
            if (route.Method == "POST")
            {
                request.Content = new StringContent("{}", System.Text.Encoding.UTF8, "application/json");
            }

            var response = await client.SendAsync(request);
            Assert.NotEqual(HttpStatusCode.Unauthorized, response.StatusCode);
            Assert.False(
                response.StatusCode == HttpStatusCode.NotFound && await response.Content.ReadAsStringAsync() == central,
                $"{route.Key}: el usuario de desarrollo recibió el 404 central.");
        }
    }

    [Fact]
    public async Task EveryProtectedRoute_IsSatisfiedByTheDevelopmentUser_NoneReturns401()
    {
        await using var factory = _fixture.CreateFactory(await _fixture.CreateDatabaseAsync());
        using var client = factory.CreateClient();

        foreach (var route in RouteInventory.From(factory.Services)
                     .Where(EndpointAuthorizationAudit.IsApiRoute)
                     .Where(r => !r.AllowsAnonymous && !r.HasOwnAuthorization))
        {
            using var request = new HttpRequestMessage(route.HttpMethod, route.Url(new Dictionary<string, string>()));
            if (route.Method is "POST" or "PATCH")
            {
                request.Content = new StringContent("{}", System.Text.Encoding.UTF8, "application/json");
            }

            var response = await client.SendAsync(request);
            Assert.True(response.StatusCode != HttpStatusCode.Unauthorized, $"{route.Key}: el usuario de desarrollo recibió 401.");
        }
    }

    [Fact]
    public async Task Records_OfAnotherOwner_StayInaccessible_AndLegacyOwnerlessOnesStayAccessible_ForTheDevelopmentUser()
    {
        await using var python = await IsolationWorldFixture.StartPythonAsync();
        await using var factory = _fixture.CreateFactory(
            await _fixture.CreateDatabaseAsync(), settings: new Dictionary<string, string?> { ["PythonEngine:BaseUrl"] = python.BaseUrl });
        using var client = factory.CreateClient();
        var registry = factory.Services.GetRequiredService<IProjectRegistry>();
        var upload = await ClassicWorkspaceFlow.UploadAsync(client);
        var record = registry.Find(upload.ProjectId, upload.ImageId)!;
        var url = $"/api/v1/projects/{upload.ProjectId}/images/{upload.ImageId}";

        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync(url)).StatusCode); // dueño = usuario de desarrollo

        registry.Save(record with { OwnerId = null }); // legado sin dueño
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync(url)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync(url + "/original")).StatusCode);

        registry.Save(record with { OwnerId = Guid.NewGuid() }); // de OTRA persona
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync(url)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync(url + "/original")).StatusCode);
    }

    [Fact]
    public async Task AccountsRegisteredInDevelopmentMode_DoNotChangeWhoTheRequestsBelongTo()
    {
        // En este modo la cookie se ignora: aunque exista una cuenta real con sesión, IUserContext sigue siendo el usuario de desarrollo.
        await using var python = await IsolationWorldFixture.StartPythonAsync();
        await using var factory = _fixture.CreateFactory(
            await _fixture.CreateDatabaseAsync(), settings: new Dictionary<string, string?> { ["PythonEngine:BaseUrl"] = python.BaseUrl });
        using var anonymous = factory.CreateClient();
        var devUser = (await anonymous.GetFromJsonAsync<CurrentUserResponse>(AuthEndpoints.MePath))!;
        using var withSession = factory.CreateClient();
        withSession.DefaultRequestHeaders.Add("X-Vectorify-Request", "1");
        var email = $"user-{Guid.NewGuid():N}@vectorify.test";
        await withSession.PostAsJsonAsync(AuthEndpoints.RegisterPath, new RegisterRequest(email, IsolationWorldFixture.Password));
        Assert.Equal(HttpStatusCode.OK, (await withSession.PostAsJsonAsync(AuthEndpoints.LoginPath, new LoginRequest(email, IsolationWorldFixture.Password))).StatusCode);

        var created = (await (await withSession.PostAsJsonAsync("/api/v2/projects", new CreateProjectRequest("Con cookie", null)))
            .Content.ReadFromJsonAsync<ProjectResponse>())!;

        Assert.Equal(devUser.Id, created.OwnerId);
        Assert.Equal(HttpStatusCode.OK, (await anonymous.GetAsync($"/api/v2/projects/{created.Id}")).StatusCode);
        Assert.Equal(AuthMode.Development.ToString(), devUser.AuthMode);
    }
}
