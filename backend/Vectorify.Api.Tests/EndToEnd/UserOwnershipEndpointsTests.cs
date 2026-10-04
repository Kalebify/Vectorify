using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Vectorify.Api.Contracts;
using Vectorify.Api.Data;
using Vectorify.Api.Projects;
using Vectorify.Api.Tests.TestSupport;
using Vectorify.Api.Users;

namespace Vectorify.Api.Tests.EndToEnd;

/// <summary>
/// Matriz de ownership "Usuario A vs Usuario B" de M2.2-S09 contra la Web API real, PostgreSQL
/// real (Testcontainers) y storage real: ver <see cref="OwnershipTestFixture"/> para los dos
/// mecanismos de identidad (IUserContext intercambiable, o una factory por
/// <c>DevelopmentUser:UserId</c>). Cada prueba compara la respuesta que recibe B ante un recurso
/// de A con la que recibe ante un recurso INEXISTENTE (mismo status, mismo code, mismo body) y
/// luego verifica que el recurso de A quedó intacto.
/// </summary>
public sealed class UserOwnershipEndpointsTests : IClassFixture<OwnershipTestFixture>
{
    private readonly OwnershipTestFixture _fixture;

    public UserOwnershipEndpointsTests(OwnershipTestFixture fixture)
    {
        _fixture = fixture;
    }

    private static readonly System.Text.Json.JsonSerializerOptions WebJson = new(System.Text.Json.JsonSerializerDefaults.Web);

    private sealed record World(Guid ProjectId, Guid AssetId, Guid LayerId, ClassicWorkspaceSession Classic, string IdempotencyKey, string Name);

    private delegate Task<HttpResponseMessage> RouteCall(HttpClient client, Guid projectId, Guid assetId, Guid layerId);

    private static readonly (string Name, RouteCall Send)[] V2Routes =
    [
        ("GET /api/v2/projects/{id}", (c, p, a, l) => c.GetAsync($"/api/v2/projects/{p}")),
        ("PATCH /api/v2/projects/{id}", (c, p, a, l) => c.PatchAsJsonAsync($"/api/v2/projects/{p}", new UpdateProjectRequest("Renombrado por B", "Descripción de B"))),
        ("DELETE /api/v2/projects/{id}", (c, p, a, l) => c.DeleteAsync($"/api/v2/projects/{p}")),
        ("POST /api/v2/projects/{id}/duplicate", (c, p, a, l) => c.PostAsync($"/api/v2/projects/{p}/duplicate", content: null)),
        ("POST /api/v2/projects/{id}/assets", (c, p, a, l) => UploadAssetAsync(c, p)),
        ("GET /api/v2/projects/{id}/assets/{assetId}", (c, p, a, l) => c.GetAsync($"/api/v2/projects/{p}/assets/{a}")),
        ("DELETE /api/v2/projects/{id}/assets/{assetId}", (c, p, a, l) => c.DeleteAsync($"/api/v2/projects/{p}/assets/{a}")),
        ("GET /api/v2/projects/{id}/document", (c, p, a, l) => c.GetAsync($"/api/v2/projects/{p}/document")),
        ("GET /api/v2/projects/{id}/versions", (c, p, a, l) => c.GetAsync($"/api/v2/projects/{p}/versions")),
        ("GET /api/v2/projects/{id}/versions/1", (c, p, a, l) => c.GetAsync($"/api/v2/projects/{p}/versions/1")),
        ("POST /api/v2/projects/{id}/versions/1/restore", (c, p, a, l) => c.PostAsync($"/api/v2/projects/{p}/versions/1/restore", content: null)),
        ("PATCH /api/v2/projects/{id}/layers/{layerId}", (c, p, a, l) => c.PatchAsJsonAsync(
            $"/api/v2/projects/{p}/layers/{l}", new UpdateLayerRequest("Capa de B", 99, false, true, "cut"))),
    ];

    [Fact]
    public async Task EveryV2Route_UserBGetsTheSame404AsForANonexistentResource_AndUserAResourceStaysIntact()
    {
        await using var pythonServer = await StartPythonAsync();
        await using var factory = _fixture.CreateFactory(pythonServer.BaseUrl);
        var (userAId, clientA) = await OwnershipTestFixture.CreateUserWithClientAsync(factory);
        var (userBId, clientB) = await OwnershipTestFixture.CreateUserWithClientAsync(factory);
        var world = await CreateWorldAsync(clientA, "Proyecto secreto de A");

        var documentBefore = await clientA.GetStringAsync($"/api/v2/projects/{world.ProjectId}/document");
        var assetBytesBefore = await clientA.GetByteArrayAsync($"/api/v2/projects/{world.ProjectId}/assets/{world.AssetId}");
        var assetRowsBefore = await CountAssetsAsync(factory, world.ProjectId);

        foreach (var (name, send) in V2Routes)
        {
            var foreign = await send(clientB, world.ProjectId, world.AssetId, world.LayerId);
            var missing = await send(clientB, Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid());

            Assert.True(
                foreign.StatusCode == HttpStatusCode.NotFound && missing.StatusCode == HttpStatusCode.NotFound,
                $"{name}: se esperaba 404 para recurso ajeno ({(int)foreign.StatusCode}) e inexistente ({(int)missing.StatusCode}).");

            var foreignBody = await foreign.Content.ReadAsStringAsync();
            var missingBody = await missing.Content.ReadAsStringAsync();
            var foreignError = System.Text.Json.JsonSerializer.Deserialize<ApiErrorResponse>(foreignBody, WebJson);
            var missingError = System.Text.Json.JsonSerializer.Deserialize<ApiErrorResponse>(missingBody, WebJson);
            Assert.True(foreignError!.Code == missingError!.Code, $"{name}: code distinto ('{foreignError.Code}' vs '{missingError.Code}').");
            Assert.True(foreignBody == missingBody, $"{name}: el body del 404 ajeno difiere del inexistente ({foreignBody} vs {missingBody}).");
        }

        // El recurso de A quedó intacto: nada se renombró, borró, duplicó, restauró ni patcheó.
        var project = await clientA.GetFromJsonAsync<ProjectResponse>($"/api/v2/projects/{world.ProjectId}");
        Assert.Equal(world.Name, project!.Name);
        Assert.Null(project.Description);
        Assert.Equal(userAId, project.OwnerId);

        var listA = await clientA.GetFromJsonAsync<ProjectListResponse>("/api/v2/projects");
        Assert.Equal([world.ProjectId], listA!.Items.Select(i => i.Id));

        var listB = await clientB.GetFromJsonAsync<ProjectListResponse>("/api/v2/projects");
        Assert.Empty(listB!.Items);

        Assert.Equal(documentBefore, await clientA.GetStringAsync($"/api/v2/projects/{world.ProjectId}/document"));
        var versions = await clientA.GetFromJsonAsync<List<VectorDocumentVersionSummaryResponse>>($"/api/v2/projects/{world.ProjectId}/versions");
        Assert.Single(versions!);
        Assert.Equal(assetBytesBefore, await clientA.GetByteArrayAsync($"/api/v2/projects/{world.ProjectId}/assets/{world.AssetId}"));
        Assert.Equal(assetRowsBefore, await CountAssetsAsync(factory, world.ProjectId));
        Assert.Equal(0, await CountProjectsOfOwnerAsync(factory, userBId));
    }

    [Fact]
    public async Task Assets_OfAnotherUsersProject_AreNotReachableThroughOneOwnProject()
    {
        await using var pythonServer = await StartPythonAsync();
        await using var factory = _fixture.CreateFactory(pythonServer.BaseUrl);
        var (_, clientA) = await OwnershipTestFixture.CreateUserWithClientAsync(factory);
        var (_, clientB) = await OwnershipTestFixture.CreateUserWithClientAsync(factory);
        var world = await CreateWorldAsync(clientA, "Assets de A");

        var projectOfB = (await (await clientB.PostAsJsonAsync("/api/v2/projects", new CreateProjectRequest("Mío", null)))
            .Content.ReadFromJsonAsync<ProjectResponse>())!;

        // El assetId de A pedido a través del proyecto PROPIO de B: la fila existe pero en otro
        // proyecto, así que el 404 es el mismo de un asset inexistente.
        var viaOwnProject = await clientB.GetAsync($"/api/v2/projects/{projectOfB.Id}/assets/{world.AssetId}");
        var unknownAsset = await clientB.GetAsync($"/api/v2/projects/{projectOfB.Id}/assets/{Guid.NewGuid()}");
        await AssertSameNotFoundAsync(viaOwnProject, unknownAsset);

        var deleteViaOwnProject = await clientB.DeleteAsync($"/api/v2/projects/{projectOfB.Id}/assets/{world.AssetId}");
        Assert.Equal(HttpStatusCode.NotFound, deleteViaOwnProject.StatusCode);

        Assert.Equal(HttpStatusCode.OK, (await clientA.GetAsync($"/api/v2/projects/{world.ProjectId}/assets/{world.AssetId}")).StatusCode);
    }

    [Fact]
    public async Task List_NeverMixesProjectsOfDifferentUsers_EvenWithSearchOrWildcards()
    {
        await using var pythonServer = await StartPythonAsync();
        await using var factory = _fixture.CreateFactory(pythonServer.BaseUrl);
        var (_, clientA) = await OwnershipTestFixture.CreateUserWithClientAsync(factory);
        var (_, clientB) = await OwnershipTestFixture.CreateUserWithClientAsync(factory);

        await clientA.PostAsJsonAsync("/api/v2/projects", new CreateProjectRequest("Alpha confidencial", null));
        await clientA.PostAsJsonAsync("/api/v2/projects", new CreateProjectRequest("Alpha segundo", null));
        await clientB.PostAsJsonAsync("/api/v2/projects", new CreateProjectRequest("Beta público", null));

        var listA = await ListAsync(clientA, "");
        var listB = await ListAsync(clientB, "");
        Assert.Equal(["Alpha confidencial", "Alpha segundo"], listA.Items.Select(i => i.Name).Order());
        Assert.Equal(["Beta público"], listB.Items.Select(i => i.Name));
        Assert.Equal(2, listA.TotalCount);
        Assert.Equal(1, listB.TotalCount);

        // search nunca sale del ámbito del usuario: ni por coincidencia exacta, ni por comodines
        // de ILIKE, ni por un patrón que "arregla" el filtro de owner.
        foreach (var search in new[] { "Alpha", "alpha", "confidencial", "%", "_lpha", "%lpha%", "Alpha' OR '1'='1" })
        {
            var asB = await ListAsync(clientB, $"?search={Uri.EscapeDataString(search)}");
            Assert.DoesNotContain(asB.Items, i => i.Name.StartsWith("Alpha", StringComparison.Ordinal));
        }

        var betaSearchAsA = await ListAsync(clientA, "?search=Beta");
        Assert.Empty(betaSearchAsA.Items);
        Assert.Equal(0, betaSearchAsA.TotalCount);

        var alphaSearchAsA = await ListAsync(clientA, "?search=alpha&sortBy=Name");
        Assert.Equal(2, alphaSearchAsA.TotalCount);

        // Paginar tampoco filtra: pageSize enorme sigue acotado al owner.
        var hugePage = await ListAsync(clientB, "?page=1&pageSize=100&sortBy=Created");
        Assert.Equal(1, hugePage.TotalCount);
    }

    [Fact]
    public async Task Create_IgnoresAnOwnerIdSentInTheBody_AndUsesTheEffectiveUser()
    {
        await using var pythonServer = await StartPythonAsync();
        await using var factory = _fixture.CreateFactory(pythonServer.BaseUrl);
        var (userAId, clientA) = await OwnershipTestFixture.CreateUserWithClientAsync(factory);
        var (userBId, _) = await OwnershipTestFixture.CreateUserWithClientAsync(factory);

        // El frontend NUNCA decide el dueño: un ownerId/userId extra en el JSON se ignora.
        using var body = new StringContent(
            $$"""{"name":"Intento de robo","description":null,"ownerId":"{{userBId}}","userId":"{{userBId}}"}""",
            System.Text.Encoding.UTF8, "application/json");
        var response = await clientA.PostAsync("/api/v2/projects", body);

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var created = await response.Content.ReadFromJsonAsync<ProjectResponse>();
        Assert.Equal(userAId, created!.OwnerId);
        Assert.Equal(userAId, await OwnerOfProjectAsync(factory, created.Id));
    }

    [Fact]
    public async Task Save_WithAProjectIdOfAnotherUser_Returns404LikeANonexistentProject_AndNeverAddsAVersion()
    {
        await using var pythonServer = await StartPythonAsync();
        await using var factory = _fixture.CreateFactory(pythonServer.BaseUrl);
        var (_, clientA) = await OwnershipTestFixture.CreateUserWithClientAsync(factory);
        var (userBId, clientB) = await OwnershipTestFixture.CreateUserWithClientAsync(factory);
        var world = await CreateWorldAsync(clientA, "Proyecto de A");
        var classicOfB = await ClassicWorkspaceFlow.RunAsync(clientB); // B tiene su PROPIO triple clásico válido

        var foreign = await clientB.PostAsJsonAsync("/api/v2/workspaces/save", classicOfB.ToSaveRequest(world.ProjectId, null));
        var missing = await clientB.PostAsJsonAsync("/api/v2/workspaces/save", classicOfB.ToSaveRequest(Guid.NewGuid(), null));

        await AssertSameNotFoundAsync(foreign, missing);

        var versions = await clientA.GetFromJsonAsync<List<VectorDocumentVersionSummaryResponse>>($"/api/v2/projects/{world.ProjectId}/versions");
        Assert.Single(versions!);
        Assert.Equal(0, await CountProjectsOfOwnerAsync(factory, userBId));
    }

    [Fact]
    public async Task Save_WithTheClassicTripleOfAnotherUser_Returns404_AndLeavesNoProjectNorAssetsBehind()
    {
        await using var pythonServer = await StartPythonAsync();
        await using var factory = _fixture.CreateFactory(pythonServer.BaseUrl);
        var (_, clientA) = await OwnershipTestFixture.CreateUserWithClientAsync(factory);
        var (userBId, clientB) = await OwnershipTestFixture.CreateUserWithClientAsync(factory);
        var world = await CreateWorldAsync(clientA, "Proyecto de A");

        var response = await clientB.PostAsJsonAsync(
            "/api/v2/workspaces/save", world.Classic.ToSaveRequest(projectId: null, "Robo del contenido de A"));

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        var error = await response.Content.ReadFromJsonAsync<ApiErrorResponse>();
        Assert.Equal("not_found", error!.Code);

        // Ni siquiera un Project descartado (soft-delete) ni Assets huérfanos: el chequeo ocurre
        // ANTES de crear el Project.
        Assert.Equal(0, await CountProjectsOfOwnerAsync(factory, userBId, includeSoftDeleted: true));
        Assert.Equal(0, await CountAssetsOfOwnerAsync(factory, userBId));
        var listB = await clientB.GetFromJsonAsync<ProjectListResponse>("/api/v2/projects");
        Assert.Empty(listB!.Items);
    }

    [Fact]
    public async Task Save_WithOwnProjectIdButTheClassicTripleOfAnotherUser_Returns404_AndLeavesTheOwnProjectUntouched()
    {
        await using var pythonServer = await StartPythonAsync();
        await using var factory = _fixture.CreateFactory(pythonServer.BaseUrl);
        var (_, clientA) = await OwnershipTestFixture.CreateUserWithClientAsync(factory);
        var (userBId, clientB) = await OwnershipTestFixture.CreateUserWithClientAsync(factory);
        var worldOfA = await CreateWorldAsync(clientA, "Proyecto de A");
        var worldOfB = await CreateWorldAsync(clientB, "Proyecto de B");
        var assetsOfBBefore = await CountAssetsOfOwnerAsync(factory, userBId);

        var response = await clientB.PostAsJsonAsync(
            "/api/v2/workspaces/save", worldOfA.Classic.ToSaveRequest(worldOfB.ProjectId, null));

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        var versionsOfB = await clientB.GetFromJsonAsync<List<VectorDocumentVersionSummaryResponse>>($"/api/v2/projects/{worldOfB.ProjectId}/versions");
        Assert.Single(versionsOfB!);
        Assert.Equal(assetsOfBBefore, await CountAssetsOfOwnerAsync(factory, userBId));
    }

    [Fact]
    public async Task Save_UserAOwnClassicTriple_StillWorks_FirstAndSecondSave()
    {
        await using var pythonServer = await StartPythonAsync();
        await using var factory = _fixture.CreateFactory(pythonServer.BaseUrl);
        var (userAId, clientA) = await OwnershipTestFixture.CreateUserWithClientAsync(factory);
        var world = await CreateWorldAsync(clientA, "Proyecto de A");

        var second = await clientA.PostAsJsonAsync("/api/v2/workspaces/save", world.Classic.ToSaveRequest(world.ProjectId, null));

        Assert.Equal(HttpStatusCode.OK, second.StatusCode);
        var body = await second.Content.ReadFromJsonAsync<VectorDocumentSaveResponse>();
        Assert.Equal(2, body!.VersionNumber);
        Assert.Equal(userAId, await OwnerOfProjectAsync(factory, world.ProjectId));
    }

    [Fact]
    public async Task Save_WithAClassicRecordWithoutOwner_LegacyUpload_StillWorksForAnyUser()
    {
        await using var pythonServer = await StartPythonAsync();
        await using var factory = _fixture.CreateFactory(pythonServer.BaseUrl);
        var (_, clientA) = await OwnershipTestFixture.CreateUserWithClientAsync(factory);
        var (userBId, clientB) = await OwnershipTestFixture.CreateUserWithClientAsync(factory);
        var classic = await ClassicWorkspaceFlow.RunAsync(clientA);

        // Simula un upload previo a M2.2-S09 (JSON viejo en disco, sin OwnerId): no se puede
        // inferir un dueño retroactivamente, así que sigue siendo accesible.
        var registry = factory.Services.GetRequiredService<IProjectRegistry>();
        var record = registry.Find(classic.ProjectId, classic.ImageId)!;
        registry.Save(record with { OwnerId = null });

        var response = await clientB.PostAsJsonAsync("/api/v2/workspaces/save", classic.ToSaveRequest(null, "Contenido heredado"));

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var saved = await response.Content.ReadFromJsonAsync<VectorDocumentSaveResponse>();
        Assert.Equal(userBId, await OwnerOfProjectAsync(factory, saved!.ProjectId));
        Assert.Equal(HttpStatusCode.OK, (await clientB.GetAsync(
            $"/api/v1/projects/{classic.ProjectId}/images/{classic.ImageId}")).StatusCode);
    }

    [Fact]
    public async Task ClassicImageEndpoints_UserBGets404LikeANonexistentImage_AndUserACanStillRead()
    {
        await using var pythonServer = await StartPythonAsync();
        await using var factory = _fixture.CreateFactory(pythonServer.BaseUrl);
        var (_, clientA) = await OwnershipTestFixture.CreateUserWithClientAsync(factory);
        var (_, clientB) = await OwnershipTestFixture.CreateUserWithClientAsync(factory);
        var upload = await ClassicWorkspaceFlow.UploadAsync(clientA);

        foreach (var suffix in new[] { "", "/original" })
        {
            var foreign = await clientB.GetAsync($"/api/v1/projects/{upload.ProjectId}/images/{upload.ImageId}{suffix}");
            var missing = await clientB.GetAsync($"/api/v1/projects/{Guid.NewGuid()}/images/{Guid.NewGuid()}{suffix}");
            await AssertSameNotFoundAsync(foreign, missing);

            var own = await clientA.GetAsync($"/api/v1/projects/{upload.ProjectId}/images/{upload.ImageId}{suffix}");
            Assert.Equal(HttpStatusCode.OK, own.StatusCode);
        }
    }

    [Fact]
    public async Task ClassicUpload_StampsTheEffectiveUserAsOwnerOfTheRecord()
    {
        await using var pythonServer = await StartPythonAsync();
        await using var factory = _fixture.CreateFactory(pythonServer.BaseUrl);
        var (userAId, clientA) = await OwnershipTestFixture.CreateUserWithClientAsync(factory);

        var upload = await ClassicWorkspaceFlow.UploadAsync(clientA);

        var record = factory.Services.GetRequiredService<IProjectRegistry>().Find(upload.ProjectId, upload.ImageId);
        Assert.Equal(userAId, record!.OwnerId);
    }

    [Fact]
    public async Task ClassicUpload_ReplayOfAnotherUsersIdempotencyKey_DoesNotReturnTheirProject()
    {
        await using var pythonServer = await StartPythonAsync();
        await using var factory = _fixture.CreateFactory(pythonServer.BaseUrl);
        var (_, clientA) = await OwnershipTestFixture.CreateUserWithClientAsync(factory);
        var (userBId, clientB) = await OwnershipTestFixture.CreateUserWithClientAsync(factory);
        var key = Guid.NewGuid().ToString("n");

        var uploadOfA = await ClassicWorkspaceFlow.UploadAsync(clientA, key);
        var uploadOfB = await ClassicWorkspaceFlow.UploadAsync(clientB, key);

        // B nunca recibe los ids de A: su upload es un upload NUEVO, de su propiedad.
        Assert.NotEqual(uploadOfA.ProjectId, uploadOfB.ProjectId);
        Assert.NotEqual(uploadOfA.ImageId, uploadOfB.ImageId);
        var record = factory.Services.GetRequiredService<IProjectRegistry>().Find(uploadOfB.ProjectId, uploadOfB.ImageId);
        Assert.Equal(userBId, record!.OwnerId);

        // Y el replay legítimo del MISMO usuario sigue funcionando.
        var replayOfB = await ClassicWorkspaceFlow.UploadAsync(clientB, key);
        Assert.Equal(uploadOfB.ProjectId, replayOfB.ProjectId);
    }

    [Fact]
    public async Task Save_ReplayOfAnotherUsersIdempotencyKey_NeverReturnsTheirVersion_AndTheirReplayStillWorks()
    {
        await using var pythonServer = await StartPythonAsync();
        await using var factory = _fixture.CreateFactory(pythonServer.BaseUrl);
        var (_, clientA) = await OwnershipTestFixture.CreateUserWithClientAsync(factory);
        var (userBId, clientB) = await OwnershipTestFixture.CreateUserWithClientAsync(factory);
        var worldOfA = await CreateWorldAsync(clientA, "Proyecto de A");
        var classicOfB = await ClassicWorkspaceFlow.RunAsync(clientB);

        // B reusa la key de A (p. ej. la adivinó/filtró): debe ser un Save normal de B, sin
        // enterarse de que la key existe (ni 500 por el índice único global, que sería un oráculo).
        var responseOfB = await clientB.PostAsJsonAsync(
            "/api/v2/workspaces/save", classicOfB.ToSaveRequest(null, "Proyecto de B", worldOfA.IdempotencyKey));

        Assert.Equal(HttpStatusCode.Created, responseOfB.StatusCode);
        var savedByB = await responseOfB.Content.ReadFromJsonAsync<VectorDocumentSaveResponse>();
        Assert.NotEqual(worldOfA.ProjectId, savedByB!.ProjectId);
        Assert.Equal(userBId, await OwnerOfProjectAsync(factory, savedByB.ProjectId));

        // El replay de A con SU key devuelve SU versión (no la de B), sin crear nada nuevo.
        var replayOfA = await clientA.PostAsJsonAsync(
            "/api/v2/workspaces/save", worldOfA.Classic.ToSaveRequest(null, worldOfA.Name, worldOfA.IdempotencyKey));
        Assert.Equal(HttpStatusCode.OK, replayOfA.StatusCode);
        var replayBody = await replayOfA.Content.ReadFromJsonAsync<VectorDocumentSaveResponse>();
        Assert.Equal(worldOfA.ProjectId, replayBody!.ProjectId);
        Assert.Equal(1, replayBody.VersionNumber);

        // Y el replay de B con la MISMA key también devuelve el suyo.
        var replayOfB = await clientB.PostAsJsonAsync(
            "/api/v2/workspaces/save", classicOfB.ToSaveRequest(null, "Proyecto de B", worldOfA.IdempotencyKey));
        Assert.Equal(HttpStatusCode.OK, replayOfB.StatusCode);
        Assert.Equal(savedByB.ProjectId, (await replayOfB.Content.ReadFromJsonAsync<VectorDocumentSaveResponse>())!.ProjectId);
    }

    [Fact]
    public async Task TwoFactories_WithDifferentDevelopmentUserId_ShareTheDatabaseButNeverTheProjects()
    {
        // Segundo mecanismo: DevelopmentUserContext REAL, una factory por DevelopmentUser:UserId,
        // ambas contra la misma base. Cada arranque siembra a SU usuario.
        await using var pythonServer = await StartPythonAsync();
        var userAId = Guid.NewGuid();
        var userBId = Guid.NewGuid();
        await using var factoryA = _fixture.CreateFactory(pythonServer.BaseUrl, simulatedAuthentication: false, developmentUserId: userAId);
        await using var factoryB = _fixture.CreateFactory(pythonServer.BaseUrl, simulatedAuthentication: false, developmentUserId: userBId);
        var clientA = factoryA.CreateClient();
        var clientB = factoryB.CreateClient();

        var createdByA = (await (await clientA.PostAsJsonAsync("/api/v2/projects", new CreateProjectRequest("De A", null)))
            .Content.ReadFromJsonAsync<ProjectResponse>())!;
        await clientB.PostAsJsonAsync("/api/v2/projects", new CreateProjectRequest("De B", null));

        Assert.Equal(userAId, createdByA.OwnerId);
        Assert.Equal(HttpStatusCode.NotFound, (await clientB.GetAsync($"/api/v2/projects/{createdByA.Id}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await clientB.DeleteAsync($"/api/v2/projects/{createdByA.Id}")).StatusCode);
        Assert.Equal(["De B"], (await ListAsync(clientB, "")).Items.Select(i => i.Name));
        Assert.Equal(["De A"], (await ListAsync(clientA, "")).Items.Select(i => i.Name));

        await using var scope = factoryA.Services.CreateAsyncScope();
        var dbContext = scope.ServiceProvider.GetRequiredService<VectorizationDbContext>();
        Assert.True(await dbContext.Users.AnyAsync(u => u.Id == userAId));
        Assert.True(await dbContext.Users.AnyAsync(u => u.Id == userBId));
    }

    [Fact]
    public async Task AuthenticatedUserContextDouble_RunsTheWholeProjectAssetVectorDocumentFlow_WithoutTouchingThoseModules()
    {
        // DoD de M2.2-S09: cambiar DevelopmentUserContext por un contexto autenticado no requiere
        // rediseñar Project/Asset/VectorDocument. Toda esta prueba corre con el doble (claims
        // simulados), sin que ningún servicio/repositorio sepa cuál implementación hay.
        await using var pythonServer = await StartPythonAsync();
        await using var factory = _fixture.CreateFactory(pythonServer.BaseUrl);
        var (userId, client) = await OwnershipTestFixture.CreateUserWithClientAsync(factory);

        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var httpContext = new Microsoft.AspNetCore.Http.DefaultHttpContext();
            httpContext.Request.Headers[SimulatedAuthenticatedUserContext.UserIdHeader] = userId.ToString();
            httpContext.Request.Headers[SimulatedAuthenticatedUserContext.EmailHeader] = "persona@vectorify.test";
            var accessor = scope.ServiceProvider.GetRequiredService<Microsoft.AspNetCore.Http.IHttpContextAccessor>();
            accessor.HttpContext = httpContext;
            try
            {
                var userContext = scope.ServiceProvider.GetRequiredService<IUserContext>();
                Assert.IsType<SimulatedAuthenticatedUserContext>(userContext);
                Assert.IsNotType<DevelopmentUserContext>(userContext);
                Assert.Equal(userId, userContext.GetEffectiveUserId());
                Assert.Equal("persona@vectorify.test", userContext.Email);
                Assert.True(userContext.IsAuthenticated);
            }
            finally
            {
                accessor.HttpContext = null;
            }
        }

        var project = (await (await client.PostAsJsonAsync("/api/v2/projects", new CreateProjectRequest("Con identidad real", null)))
            .Content.ReadFromJsonAsync<ProjectResponse>())!;
        Assert.Equal(userId, project.OwnerId);

        var uploadAsset = await UploadAssetAsync(client, project.Id);
        Assert.Equal(HttpStatusCode.Created, uploadAsset.StatusCode);

        var world = await CreateWorldAsync(client, "Documento con identidad real");
        var document = await client.GetFromJsonAsync<VectorDocumentResponse>($"/api/v2/projects/{world.ProjectId}/document");
        Assert.Single(document!.Layers);
        var patch = await client.PatchAsJsonAsync(
            $"/api/v2/projects/{world.ProjectId}/layers/{world.LayerId}", new UpdateLayerRequest("Renombrada", null, null, null, null));
        Assert.Equal(HttpStatusCode.OK, patch.StatusCode);
        Assert.Equal(userId, await OwnerOfProjectAsync(factory, world.ProjectId));
    }

    // ---- helpers ----

    private static Task<FakePythonPreprocessServer> StartPythonAsync() =>
        FakePythonPreprocessServer.StartAsync(_ => (200, "{}"), respondColorPalette: _ => (200, ColorPalettePayloads.SuccessBody()));

    /// <summary>Flujo clásico completo + primer Save con idempotencyKey, como el usuario del <paramref name="client"/>.</summary>
    private static async Task<World> CreateWorldAsync(HttpClient client, string name)
    {
        var classic = await ClassicWorkspaceFlow.RunAsync(client);
        var idempotencyKey = Guid.NewGuid().ToString("n");
        var saveResponse = await client.PostAsJsonAsync("/api/v2/workspaces/save", classic.ToSaveRequest(null, name, idempotencyKey));
        Assert.Equal(HttpStatusCode.Created, saveResponse.StatusCode);
        var saved = (await saveResponse.Content.ReadFromJsonAsync<VectorDocumentSaveResponse>())!;

        var document = (await client.GetFromJsonAsync<VectorDocumentResponse>($"/api/v2/projects/{saved.ProjectId}/document"))!;
        var layer = document.Layers.First();
        return new World(saved.ProjectId, layer.SvgAssetId!.Value, layer.Id, classic, idempotencyKey, name);
    }

    private static async Task<HttpResponseMessage> UploadAssetAsync(HttpClient client, Guid projectId)
    {
        using var form = new MultipartFormDataContent();
        var fileContent = new ByteArrayContent(SampleImages.ValidPng1x1);
        fileContent.Headers.ContentType = new MediaTypeHeaderValue("image/png");
        form.Add(fileContent, "file", "intruso.png");
        form.Add(new StringContent("original"), "type");
        return await client.PostAsync($"/api/v2/projects/{projectId}/assets", form);
    }

    private static async Task<ProjectListResponse> ListAsync(HttpClient client, string query) =>
        (await client.GetFromJsonAsync<ProjectListResponse>("/api/v2/projects" + query))!;

    private static async Task AssertSameNotFoundAsync(HttpResponseMessage foreign, HttpResponseMessage missing)
    {
        Assert.Equal(HttpStatusCode.NotFound, foreign.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);
        var foreignError = await foreign.Content.ReadFromJsonAsync<ApiErrorResponse>();
        var missingError = await missing.Content.ReadFromJsonAsync<ApiErrorResponse>();
        Assert.Equal(missingError!.Code, foreignError!.Code);
    }

    private static async Task<int> CountAssetsAsync(WebApplicationFactory<Program> factory, Guid projectId)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var dbContext = scope.ServiceProvider.GetRequiredService<VectorizationDbContext>();
        return await dbContext.Assets.IgnoreQueryFilters().CountAsync(a => a.ProjectId == projectId);
    }

    private static async Task<int> CountProjectsOfOwnerAsync(
        WebApplicationFactory<Program> factory, Guid ownerId, bool includeSoftDeleted = false)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var dbContext = scope.ServiceProvider.GetRequiredService<VectorizationDbContext>();
        var query = includeSoftDeleted ? dbContext.Projects.IgnoreQueryFilters() : dbContext.Projects;
        return await query.CountAsync(p => p.OwnerId == ownerId);
    }

    private static async Task<int> CountAssetsOfOwnerAsync(WebApplicationFactory<Program> factory, Guid ownerId)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var dbContext = scope.ServiceProvider.GetRequiredService<VectorizationDbContext>();
        return await dbContext.Assets.IgnoreQueryFilters().CountAsync(a => a.Project!.OwnerId == ownerId);
    }

    private static async Task<Guid> OwnerOfProjectAsync(WebApplicationFactory<Program> factory, Guid projectId)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var dbContext = scope.ServiceProvider.GetRequiredService<VectorizationDbContext>();
        return await dbContext.Projects.IgnoreQueryFilters().Where(p => p.Id == projectId).Select(p => p.OwnerId).SingleAsync();
    }
}
