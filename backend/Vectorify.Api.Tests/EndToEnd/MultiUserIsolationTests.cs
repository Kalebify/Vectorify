using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Vectorify.Api.Authorization;
using Vectorify.Api.Contracts;
using Vectorify.Api.Data;
using Vectorify.Api.Endpoints;
using Vectorify.Api.Projects;
using Vectorify.Api.Tests.TestSupport;

namespace Vectorify.Api.Tests.EndToEnd;

/// <summary>
/// SUITE DE AISLAMIENTO multiusuario de M3.1-S06 (DoD de la tarjeta): UserA vs UserB contra la Web API REAL en <c>Auth:Mode=Authenticated</c>,
/// PostgreSQL real (Testcontainers) y dos (tres) cuentas reales creadas por <c>/register</c> + <c>/login</c>, con cookies emitidas por el servidor.
/// El recorrido de rutas sale del <c>EndpointDataSource</c> real (no de una lista escrita a mano): una ruta nueva del flujo clásico entra sola
/// en la matriz. Cada prueba compara lo que recibe B ante un recurso de A con lo que recibe ante un recurso INEXISTENTE (mismo estado, mismas
/// cabeceras, mismo cuerpo) y comprueba que el recurso de A quedó intacto.
/// </summary>
public sealed class MultiUserIsolationTests : IClassFixture<IsolationWorldFixture>
{
    // Volátiles por request, no por recurso: el id de correlación, la fecha y -- porque la sesión es deslizante y se renueva con cada
    // petición del PROPIO usuario -- la cookie reemitida y las cabeceras anti-caché que ASP.NET añade junto a ella.
    private static readonly string[] VolatileHeaders = ["X-Correlation-Id", "Date", "Server", "Set-Cookie", "Cache-Control", "Expires", "Pragma"];

    private readonly IsolationWorldFixture _f;

    public MultiUserIsolationTests(IsolationWorldFixture fixture)
    {
        _f = fixture;
    }

    // =========================================================================================== denegación por defecto

    [Fact]
    public async Task Anonymous_EveryProtectedApiRoute_Returns401WithTheStandardBody_AndNothingRuns()
    {
        var routes = RouteInventory.From(_f.Factory.Services)
            .Where(EndpointAuthorizationAudit.IsApiRoute)
            .Where(r => !r.AllowsAnonymous)
            .ToList();
        Assert.True(routes.Count >= 60, $"Se esperaban al menos 60 rutas protegidas y hay {routes.Count}.");

        var ids = KnownIds(_f.WorldA);
        foreach (var route in routes)
        {
            using var request = BuildRequest(route, ids);
            var response = await _f.Anonymous.SendAsync(request);

            Assert.True(response.StatusCode == HttpStatusCode.Unauthorized, $"{route.Key}: anónimo recibió {(int)response.StatusCode}, se esperaba 401.");
            var error = await response.Content.ReadFromJsonAsync<ApiErrorResponse>();
            Assert.Equal(UnauthenticatedJsonResultHandler.Code, error!.Code);
        }

        // Nada se ejecutó: el mundo de A sigue exactamente igual.
        Assert.Single((await _f.A.Client.GetFromJsonAsync<ProjectListResponse>("/api/v2/projects"))!.Items);
    }

    [Fact]
    public async Task Anonymous_TheAllowlistedRoutes_StayReachableWithoutASession()
    {
        Assert.Equal(HttpStatusCode.OK, (await _f.Anonymous.GetAsync("/health")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await _f.Anonymous.GetAsync("/api/v1/system/health")).StatusCode);

        var email = $"user-{Guid.NewGuid():N}@vectorify.test";
        Assert.Equal(HttpStatusCode.Accepted, (await _f.Anonymous.PostAsJsonAsync(
            AuthEndpoints.RegisterPath, new RegisterRequest(email, IsolationWorldFixture.Password))).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await _f.Anonymous.PostAsJsonAsync(
            AuthEndpoints.LoginPath, new LoginRequest(email, "otra-contrasena-erronea-9"))).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await _f.Anonymous.PostAsync(AuthEndpoints.LogoutPath, content: null)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await _f.Anonymous.GetAsync(AuthEndpoints.MePath)).StatusCode);
    }

    [Fact]
    public async Task AGarbageOrForgedCookie_IsTreatedAsAnonymous_On401()
    {
        using var client = _f.Factory.CreateClient().WithCsrf();
        client.DefaultRequestHeaders.Add("Cookie", "vectorify.session=CfDJ8-no-es-un-ticket-valido");

        var response = await client.GetAsync("/api/v2/projects");

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync(
            $"/api/v1/projects/{_f.WorldA.Classic.ProjectId}/images/{_f.WorldA.Classic.ImageId}")).StatusCode);
    }

    // =========================================================================================== flujo clásico (grupo central)

    [Fact]
    public async Task Classic_EveryRoute_ForeignAndNonexistentIds_AreIndistinguishable404_AndTheOwnersStateStaysIntact()
    {
        var routes = ClassicRoutes();
        Assert.True(routes.Count >= 40, $"Se esperaban al menos 40 rutas del flujo clásico y hay {routes.Count}.");

        var stateOfABefore = await ClassicStateAsync(_f.A.Client, _f.WorldA);
        var stateOfBBefore = await ClassicStateAsync(_f.B.Client, _f.WorldB);

        // B (y C) contra los ids REALES de A -- incluidos paleta, grupo y vector reales --, y contra ids inexistentes.
        foreach (var attacker in new[] { _f.B, _f.C })
        {
            foreach (var route in routes)
            {
                using var foreignRequest = BuildRequest(route, KnownIds(_f.WorldA));
                using var missingRequest = BuildRequest(route, MissingIds());
                var foreign = await attacker.Client.SendAsync(foreignRequest);
                var missing = await attacker.Client.SendAsync(missingRequest);

                Assert.True(
                    foreign.StatusCode == HttpStatusCode.NotFound && missing.StatusCode == HttpStatusCode.NotFound,
                    $"{route.Key}: se esperaba 404 para ajeno ({(int)foreign.StatusCode}) e inexistente ({(int)missing.StatusCode}).");
                var foreignSnapshot = await SnapshotAsync(foreign);
                var missingSnapshot = await SnapshotAsync(missing);
                Assert.True(foreignSnapshot == missingSnapshot, $"{route.Key}: ajeno e inexistente difieren:\n{foreignSnapshot}\n{missingSnapshot}");
            }
        }

        // Y a la inversa: A contra el mundo de B.
        foreach (var route in routes)
        {
            using var request = BuildRequest(route, KnownIds(_f.WorldB));
            var response = await _f.A.Client.SendAsync(request);
            Assert.True(response.StatusCode == HttpStatusCode.NotFound, $"{route.Key}: A sobre B recibió {(int)response.StatusCode}.");
        }

        // Nada de lo que B/C intentaron cambió el estado de A ni de B (paleta, capas, layout, operaciones, original, documento).
        Assert.Equal(stateOfABefore, await ClassicStateAsync(_f.A.Client, _f.WorldA));
        Assert.Equal(stateOfBBefore, await ClassicStateAsync(_f.B.Client, _f.WorldB));
    }

    [Fact]
    public async Task Classic_EveryRoute_ForTheOwner_PassesTheCentralCheck()
    {
        // C ejecuta sobre SU propio recurso: la comprobación central NO bloquea al dueño en ninguna ruta (si el handler responde 404 por
        // otra razón -- p. ej. un sub-recurso inexistente --, su cuerpo no es el del 404 central).
        var world = await IsolationWorld.CreateAsync(_f.C.Client, "Mundo de C");
        var central = JsonBody(new ApiErrorResponse(ClassicProjectOwnerMiddleware.NotFoundCode, ClassicProjectOwnerMiddleware.NotFoundMessage));

        foreach (var route in ClassicRoutes())
        {
            using var request = BuildRequest(route, KnownIds(world));
            var response = await _f.C.Client.SendAsync(request);
            var body = await response.Content.ReadAsStringAsync();

            Assert.False(
                response.StatusCode == HttpStatusCode.NotFound && body == central,
                $"{route.Key}: el DUEÑO recibió el 404 central ({body}).");
            Assert.NotEqual(HttpStatusCode.Unauthorized, response.StatusCode);
        }
    }

    [Fact]
    public async Task Classic_Downloads_ByDirectUrl_RespectTheSessionCookie()
    {
        var w = _f.WorldA;
        var layers = (await _f.A.Client.GetFromJsonAsync<VectorLayerSetResponse>(
            $"{w.ClassicBase}/color-palette/{w.Classic.PaletteId}/layers"))!;
        var urls = new[]
        {
            $"{w.ClassicBase}/original",
            $"{w.ClassicBase}/color-palette/{w.Classic.PaletteId}/preview",
            layers.Layers[0].SvgUrl,
            $"/api/v2/projects/{w.ProjectId}/assets/{w.AssetId}",
        };

        foreach (var url in urls)
        {
            var asOwner = await _f.A.Client.GetAsync(url);
            Assert.True(asOwner.StatusCode == HttpStatusCode.OK, $"{url}: el dueño recibió {(int)asOwner.StatusCode}.");
            Assert.NotEmpty(await asOwner.Content.ReadAsByteArrayAsync());

            var asOther = await _f.B.Client.GetAsync(url);
            Assert.True(asOther.StatusCode == HttpStatusCode.NotFound, $"{url}: otro usuario recibió {(int)asOther.StatusCode}.");

            var asAnonymous = await _f.Anonymous.GetAsync(url);
            Assert.True(asAnonymous.StatusCode == HttpStatusCode.Unauthorized, $"{url}: anónimo recibió {(int)asAnonymous.StatusCode}.");
        }
    }

    [Fact]
    public async Task Classic_SubResourcesOfAnotherProject_AreNotReachableThroughOneOwnProject()
    {
        // B pide, por SU propio proyecto/imagen, ids de sub-recursos de A (paleta, vector): existen pero en otro proyecto.
        var a = _f.WorldA;
        var b = _f.WorldB;
        var viaOwnProject = new[]
        {
            await _f.B.Client.GetAsync($"{b.ClassicBase}/color-palette/{a.Classic.PaletteId}"),
            await _f.B.Client.GetAsync($"{b.ClassicBase}/vectors/{a.VectorIds[0]}"),
        };
        var unknown = new[]
        {
            await _f.B.Client.GetAsync($"{b.ClassicBase}/color-palette/{Guid.NewGuid()}"),
            await _f.B.Client.GetAsync($"{b.ClassicBase}/vectors/{Guid.NewGuid()}"),
        };

        for (var i = 0; i < viaOwnProject.Length; i++)
        {
            Assert.Equal(HttpStatusCode.NotFound, viaOwnProject[i].StatusCode);
            Assert.Equal(await SnapshotAsync(unknown[i]), await SnapshotAsync(viaOwnProject[i]));
        }
    }

    [Fact]
    public async Task Classic_Upload_StampsTheServerUserAsOwner_AndAnotherUsersIdempotencyKeyIsNeverReplayed()
    {
        var key = Guid.NewGuid().ToString("n");
        var uploadOfA = await ClassicWorkspaceFlow.UploadAsync(_f.A.Client, key);
        var uploadOfB = await ClassicWorkspaceFlow.UploadAsync(_f.B.Client, key);

        Assert.NotEqual(uploadOfA.ProjectId, uploadOfB.ProjectId);
        var registry = _f.Factory.Services.GetRequiredService<IProjectRegistry>();
        Assert.Equal(_f.A.Id, registry.Find(uploadOfA.ProjectId, uploadOfA.ImageId)!.OwnerId);
        Assert.Equal(_f.B.Id, registry.Find(uploadOfB.ProjectId, uploadOfB.ImageId)!.OwnerId);
        Assert.Equal(uploadOfB.ProjectId, (await ClassicWorkspaceFlow.UploadAsync(_f.B.Client, key)).ProjectId); // el replay legítimo sigue
    }

    [Fact]
    public async Task Classic_LegacyRecordWithoutOwner_IsInaccessibleToEveryone_InAuthenticatedMode()
    {
        // Registro previo a M2.2-S09 (JSON viejo sin OwnerId): en modo Authenticated NO es de nadie -- tampoco del que lo subió.
        var registry = _f.Factory.Services.GetRequiredService<IProjectRegistry>();
        var upload = await ClassicWorkspaceFlow.UploadAsync(_f.C.Client);
        var record = registry.Find(upload.ProjectId, upload.ImageId)!;
        registry.Save(record with { OwnerId = null });

        var legacyUrls = new[]
        {
            $"/api/v1/projects/{upload.ProjectId}/images/{upload.ImageId}",
            $"/api/v1/projects/{upload.ProjectId}/images/{upload.ImageId}/original",
        };
        foreach (var url in legacyUrls)
        {
            var missingUrl = url.Replace(upload.ProjectId.ToString(), Guid.NewGuid().ToString()).Replace(upload.ImageId.ToString(), Guid.NewGuid().ToString());
            foreach (var user in new[] { _f.A, _f.B, _f.C })
            {
                var response = await user.Client.GetAsync(url);
                Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
                Assert.Equal(await SnapshotAsync(await user.Client.GetAsync(missingUrl)), await SnapshotAsync(response));
            }
        }

        var detect = await _f.C.Client.PostAsJsonAsync(
            $"/api/v1/projects/{upload.ProjectId}/images/{upload.ImageId}/color-palette/detect", new ColorPaletteDetectRequest(null, null, null));
        Assert.Equal(HttpStatusCode.NotFound, detect.StatusCode);

        // El puente clásico -> v2 tampoco lo adopta: Save con ese triple responde el MISMO 404 que con un triple inexistente.
        var triple = new VectorDocumentSaveRequest(null, "Intento sobre un registro legado", upload.ProjectId, upload.ImageId, Guid.NewGuid(), 1, null);
        var bridge = await _f.C.Client.PostAsJsonAsync("/api/v2/workspaces/save", triple);
        var bridgeMissing = await _f.C.Client.PostAsJsonAsync("/api/v2/workspaces/save", triple with { ClassicProjectId = Guid.NewGuid(), ImageId = Guid.NewGuid() });
        Assert.Equal(HttpStatusCode.NotFound, bridge.StatusCode);
        Assert.Equal(await SnapshotAsync(bridgeMissing), await SnapshotAsync(bridge));

        // Y la key de idempotencia de un registro sin dueño no se reproduce: es una carga nueva.
        var recordWithKey = registry.Find(upload.ProjectId, upload.ImageId)!;
        registry.Save(recordWithKey with { IdempotencyKey = "legacy-key-" + upload.ProjectId.ToString("n") });
        var other = await ClassicWorkspaceFlow.UploadAsync(_f.C.Client, "legacy-key-" + upload.ProjectId.ToString("n"));
        Assert.NotEqual(upload.ProjectId, other.ProjectId);
    }

    // =========================================================================================== /api/v2 (dueño en el repositorio)

    private delegate Task<HttpResponseMessage> V2Call(HttpClient client, IsolationWorld target, Guid projectId, Guid assetId, Guid layerId);

    private static readonly Dictionary<string, V2Call> V2Calls = new()
    {
        ["GET /api/v2/projects/{id:guid}"] = (c, _, p, a, l) => c.GetAsync($"/api/v2/projects/{p}"),
        ["PATCH /api/v2/projects/{id:guid}"] = (c, _, p, a, l) => c.PatchAsJsonAsync($"/api/v2/projects/{p}", new UpdateProjectRequest("Renombrado por B", "Descripción de B")),
        ["DELETE /api/v2/projects/{id:guid}"] = (c, _, p, a, l) => c.DeleteAsync($"/api/v2/projects/{p}"),
        ["POST /api/v2/projects/{id:guid}/duplicate"] = (c, _, p, a, l) => c.PostAsync($"/api/v2/projects/{p}/duplicate", content: null),
        ["POST /api/v2/projects/{projectId:guid}/assets"] = (c, _, p, a, l) => UploadAssetAsync(c, p),
        ["GET /api/v2/projects/{projectId:guid}/assets/{assetId:guid}"] = (c, _, p, a, l) => c.GetAsync($"/api/v2/projects/{p}/assets/{a}"),
        ["DELETE /api/v2/projects/{projectId:guid}/assets/{assetId:guid}"] = (c, _, p, a, l) => c.DeleteAsync($"/api/v2/projects/{p}/assets/{a}"),
        ["GET /api/v2/projects/{projectId:guid}/document"] = (c, _, p, a, l) => c.GetAsync($"/api/v2/projects/{p}/document"),
        ["GET /api/v2/projects/{projectId:guid}/versions"] = (c, _, p, a, l) => c.GetAsync($"/api/v2/projects/{p}/versions"),
        ["GET /api/v2/projects/{projectId:guid}/versions/{versionNumber:int}"] = (c, _, p, a, l) => c.GetAsync($"/api/v2/projects/{p}/versions/1"),
        ["POST /api/v2/projects/{projectId:guid}/versions/{versionNumber:int}/restore"] = (c, _, p, a, l) => c.PostAsync($"/api/v2/projects/{p}/versions/1/restore", content: null),
        ["POST /api/v2/projects/{projectId:guid}/document/editor-save"] = (c, _, p, a, l) => c.PostAsJsonAsync(
            $"/api/v2/projects/{p}/document/editor-save",
            new EditorSaveRequest(
                "MANUAL_EDIT", Guid.NewGuid().ToString("n"), "0 0 10 10", 10, 10, 1,
                [new EditorSaveLayerRequest(l, "<svg xmlns=\"http://www.w3.org/2000/svg\"/>", "Intrusa", 0, true, false, null, false, "#000000")])),
        ["PATCH /api/v2/projects/{projectId:guid}/layers/{layerId:guid}"] = (c, _, p, a, l) => c.PatchAsJsonAsync(
            $"/api/v2/projects/{p}/layers/{l}", new UpdateLayerRequest("Capa de B", 99, false, true, "cut")),
    };

    [Fact]
    public void V2Matrix_CoversEveryServiceEnforcedRoute_OfTheArchitectureAllowlist()
    {
        // Si alguien añade una ruta v2 a la lista blanca de la arquitectura, esta matriz DEBE ejercitarla.
        Assert.Equal(
            EndpointAuthorizationAudit.ServiceEnforcedOwnerAllowlist.Keys.Order(StringComparer.Ordinal),
            V2Calls.Keys.Order(StringComparer.Ordinal));
    }

    [Fact]
    public async Task V2_EveryRoute_UserBGetsTheSame404AsForANonexistentResource_AndUserAResourceStaysIntact()
    {
        var a = _f.WorldA;
        var documentBefore = await _f.A.Client.GetStringAsync($"/api/v2/projects/{a.ProjectId}/document");
        var assetBefore = await _f.A.Client.GetByteArrayAsync($"/api/v2/projects/{a.ProjectId}/assets/{a.AssetId}");
        var assetRowsBefore = await CountAssetsAsync(a.ProjectId);
        var projectsOfABefore = await CountProjectsOfOwnerAsync(_f.A.Id);
        var projectsOfBBefore = await CountProjectsOfOwnerAsync(_f.B.Id);

        foreach (var (name, send) in V2Calls)
        {
            var foreign = await send(_f.B.Client, a, a.ProjectId, a.AssetId, a.LayerGroupId);
            var missing = await send(_f.B.Client, a, Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid());

            Assert.True(
                foreign.StatusCode == HttpStatusCode.NotFound && missing.StatusCode == HttpStatusCode.NotFound,
                $"{name}: se esperaba 404 para ajeno ({(int)foreign.StatusCode}) e inexistente ({(int)missing.StatusCode}).");
            Assert.Equal(await SnapshotAsync(missing), await SnapshotAsync(foreign));
        }

        // El recurso de A quedó intacto: nada se renombró, borró, duplicó, restauró, subió ni patcheó.
        var project = await _f.A.Client.GetFromJsonAsync<ProjectResponse>($"/api/v2/projects/{a.ProjectId}");
        Assert.Equal(a.Name, project!.Name);
        Assert.Null(project.Description);
        Assert.Equal(_f.A.Id, project.OwnerId);
        Assert.Equal(documentBefore, await _f.A.Client.GetStringAsync($"/api/v2/projects/{a.ProjectId}/document"));
        Assert.Single((await _f.A.Client.GetFromJsonAsync<List<VectorDocumentVersionSummaryResponse>>($"/api/v2/projects/{a.ProjectId}/versions"))!);
        Assert.Equal(assetBefore, await _f.A.Client.GetByteArrayAsync($"/api/v2/projects/{a.ProjectId}/assets/{a.AssetId}"));
        Assert.Equal(assetRowsBefore, await CountAssetsAsync(a.ProjectId));
        Assert.Equal(projectsOfABefore, await CountProjectsOfOwnerAsync(_f.A.Id));
        Assert.Equal(projectsOfBBefore, await CountProjectsOfOwnerAsync(_f.B.Id)); // el duplicado de B no creó nada
    }

    [Fact]
    public async Task V2_Anonymous_EveryRoute_Returns401()
    {
        var a = _f.WorldA;
        foreach (var (name, send) in V2Calls)
        {
            var response = await send(_f.Anonymous, a, a.ProjectId, a.AssetId, a.LayerGroupId);
            Assert.True(response.StatusCode == HttpStatusCode.Unauthorized, $"{name}: anónimo recibió {(int)response.StatusCode}.");
        }
    }

    [Fact]
    public async Task V2_List_NeverMixesProjectsOfDifferentUsers_EvenWithSearchOrWildcards()
    {
        var listA = (await _f.A.Client.GetFromJsonAsync<ProjectListResponse>("/api/v2/projects"))!;
        var listB = (await _f.B.Client.GetFromJsonAsync<ProjectListResponse>("/api/v2/projects"))!;
        Assert.Equal([_f.WorldA.ProjectId], listA.Items.Select(i => i.Id));
        Assert.Equal([_f.WorldB.ProjectId], listB.Items.Select(i => i.Id));

        foreach (var search in new[] { "secreto", "Proyecto", "%", "_royecto", "%royecto%", "A' OR '1'='1" })
        {
            var asB = (await _f.B.Client.GetFromJsonAsync<ProjectListResponse>($"/api/v2/projects?search={Uri.EscapeDataString(search)}"))!;
            Assert.DoesNotContain(asB.Items, i => i.Id == _f.WorldA.ProjectId);
        }
    }

    [Fact]
    public async Task V2_Save_WithAProjectIdOrClassicTripleOfAnotherUser_IsTheSame404AsNonexistent_AndCreatesNothing()
    {
        var a = _f.WorldA;
        var classicOfB = _f.WorldB.Classic;
        var projectsOfBBefore = await CountProjectsOfOwnerAsync(_f.B.Id, includeSoftDeleted: true);
        var assetsOfBBefore = await CountAssetsOfOwnerAsync(_f.B.Id);

        // (1) projectId v2 ajeno con el triple clásico PROPIO de B.
        var foreignProject = await _f.B.Client.PostAsJsonAsync("/api/v2/workspaces/save", classicOfB.ToSaveRequest(a.ProjectId, null));
        var missingProject = await _f.B.Client.PostAsJsonAsync("/api/v2/workspaces/save", classicOfB.ToSaveRequest(Guid.NewGuid(), null));
        Assert.Equal(HttpStatusCode.NotFound, foreignProject.StatusCode);
        Assert.Equal(await SnapshotAsync(missingProject), await SnapshotAsync(foreignProject));

        // (2) triple clásico AJENO (el de A) vs triple clásico inexistente.
        var foreignTriple = await _f.B.Client.PostAsJsonAsync("/api/v2/workspaces/save", a.Classic.ToSaveRequest(null, "Robo del contenido de A"));
        var missingTriple = await _f.B.Client.PostAsJsonAsync(
            "/api/v2/workspaces/save",
            new VectorDocumentSaveRequest(null, "Robo del contenido de A", Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), 1, null));
        Assert.Equal(HttpStatusCode.NotFound, foreignTriple.StatusCode);
        Assert.Equal(await SnapshotAsync(missingTriple), await SnapshotAsync(foreignTriple));

        // (3) proyecto propio de B + triple clásico de A.
        var mixed = await _f.B.Client.PostAsJsonAsync("/api/v2/workspaces/save", a.Classic.ToSaveRequest(_f.WorldB.ProjectId, null));
        Assert.Equal(HttpStatusCode.NotFound, mixed.StatusCode);

        Assert.Single((await _f.A.Client.GetFromJsonAsync<List<VectorDocumentVersionSummaryResponse>>($"/api/v2/projects/{a.ProjectId}/versions"))!);
        Assert.Single((await _f.B.Client.GetFromJsonAsync<List<VectorDocumentVersionSummaryResponse>>($"/api/v2/projects/{_f.WorldB.ProjectId}/versions"))!);
        Assert.Equal(projectsOfBBefore, await CountProjectsOfOwnerAsync(_f.B.Id, includeSoftDeleted: true));
        Assert.Equal(assetsOfBBefore, await CountAssetsOfOwnerAsync(_f.B.Id));
    }

    [Fact]
    public async Task V2_OwnResourcesKeepWorking_ForEachUser_IncludingDuplicateAndVersionRestore()
    {
        // Lo que la autorización NO debe romper: el dueño duplica, restaura una versión, edita una capa y descarga lo suyo.
        var world = await IsolationWorld.CreateAsync(_f.C.Client, "Flujo completo de C");

        var duplicate = await _f.C.Client.PostAsync($"/api/v2/projects/{world.ProjectId}/duplicate", content: null);
        Assert.Equal(HttpStatusCode.Created, duplicate.StatusCode);
        var copy = (await duplicate.Content.ReadFromJsonAsync<ProjectResponse>())!;
        Assert.Equal(_f.C.Id, copy.OwnerId);
        Assert.Equal(HttpStatusCode.NotFound, (await _f.B.Client.GetAsync($"/api/v2/projects/{copy.Id}")).StatusCode); // la copia también es solo de C

        var patch = await _f.C.Client.PatchAsJsonAsync(
            $"/api/v2/projects/{world.ProjectId}/layers/{world.LayerGroupId}", new UpdateLayerRequest("Renombrada por C", null, null, null, null));
        Assert.Equal(HttpStatusCode.OK, patch.StatusCode);
        var restore = await _f.C.Client.PostAsync($"/api/v2/projects/{world.ProjectId}/versions/1/restore", content: null);
        Assert.Equal(HttpStatusCode.OK, restore.StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await _f.C.Client.GetAsync($"/api/v2/projects/{world.ProjectId}/assets/{world.AssetId}")).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await _f.C.Client.DeleteAsync($"/api/v2/projects/{copy.Id}")).StatusCode);
    }

    // =========================================================================================== el dueño lo pone el servidor (RS10)

    [Fact]
    public async Task Create_IgnoresAnyOwnerIdOrUserIdSentByTheClient_EverywhereTheServerCreatesResources()
    {
        // POST /api/v2/projects con ownerId/userId de B en el JSON: se ignoran.
        using var body = new StringContent(
            $$"""{"name":"Intento de robo","description":null,"ownerId":"{{_f.B.Id}}","userId":"{{_f.B.Id}}"}""", Encoding.UTF8, "application/json");
        var created = await _f.C.Client.PostAsync("/api/v2/projects", body);
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        var project = (await created.Content.ReadFromJsonAsync<ProjectResponse>())!;
        Assert.Equal(_f.C.Id, project.OwnerId);
        Assert.Equal(_f.C.Id, await OwnerOfProjectAsync(project.Id));

        // POST /api/v2/workspaces/save con ownerId de B: el Project nuevo es de quien tiene la sesión.
        var classic = await ClassicWorkspaceFlow.RunAsync(_f.C.Client);
        using var saveBody = new StringContent(
            $$"""{"name":"Guardado","classicProjectId":"{{classic.ProjectId}}","imageId":"{{classic.ImageId}}","paletteId":"{{classic.PaletteId}}","paletteVersion":{{classic.PaletteVersion}},"ownerId":"{{_f.B.Id}}"}""",
            Encoding.UTF8, "application/json");
        var saved = await _f.C.Client.PostAsync("/api/v2/workspaces/save", saveBody);
        Assert.Equal(HttpStatusCode.Created, saved.StatusCode);
        Assert.Equal(_f.C.Id, await OwnerOfProjectAsync((await saved.Content.ReadFromJsonAsync<VectorDocumentSaveResponse>())!.ProjectId));

        // Un duplicado hereda el dueño del servidor, no uno enviado.
        var duplicate = await _f.C.Client.PostAsync($"/api/v2/projects/{project.Id}/duplicate?ownerId={_f.B.Id}", content: null);
        Assert.Equal(_f.C.Id, (await duplicate.Content.ReadFromJsonAsync<ProjectResponse>())!.OwnerId);

        // Una cabecera X-User-Id / X-Test-User-Id no suplanta a nadie.
        using var spoof = new HttpRequestMessage(HttpMethod.Get, "/api/v2/projects");
        spoof.Headers.Add("X-User-Id", _f.A.Id.ToString());
        spoof.Headers.Add("X-Test-User-Id", _f.A.Id.ToString());
        var list = (await (await _f.B.Client.SendAsync(spoof)).Content.ReadFromJsonAsync<ProjectListResponse>())!;
        Assert.DoesNotContain(list.Items, i => i.Id == _f.WorldA.ProjectId);
    }

    // =========================================================================================== sesión

    [Fact]
    public async Task AfterLogout_TheSameClientLosesAccessToItsOwnResources()
    {
        var user = await IsolationWorldFixture.SignInAsync(_f.Factory);
        var created = await user.Client.PostAsJsonAsync("/api/v2/projects", new CreateProjectRequest("Mío", null));
        var project = (await created.Content.ReadFromJsonAsync<ProjectResponse>())!;
        Assert.Equal(HttpStatusCode.OK, (await user.Client.GetAsync($"/api/v2/projects/{project.Id}")).StatusCode);

        Assert.Equal(HttpStatusCode.NoContent, (await user.Client.PostAsync(AuthEndpoints.LogoutPath, content: null)).StatusCode);

        Assert.Equal(HttpStatusCode.Unauthorized, (await user.Client.GetAsync($"/api/v2/projects/{project.Id}")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await user.Client.GetAsync("/api/v2/projects")).StatusCode);
    }

    // =========================================================================================== rendimiento: una sola resolución de dueño

    [Fact]
    public async Task OwnerResolution_HappensOncePerRequest_WithoutExtraQueries()
    {
        var logs = new CapturingLoggerProvider();
        var counting = new CountingClassicProjectAccess();
        await using var factory = IsolationWorldFixture.CreateAuthenticatedFactory(
            _f.Database,
            _f.ConnectionString,
            "http://127.0.0.1:1",
            logs,
            services =>
            {
                services.RemoveAll<IClassicProjectAccess>();
                services.AddScoped<IClassicProjectAccess>(sp => new CountingClassicProjectAccess.Wrapper(
                    ActivatorUtilities.CreateInstance<ClassicProjectAccess>(sp), counting));
            });
        var user = await IsolationWorldFixture.SignInAsync(factory);
        var upload = await ClassicWorkspaceFlow.UploadAsync(user.Client);
        var project = (await (await user.Client.PostAsJsonAsync("/api/v2/projects", new CreateProjectRequest("Contado", null)))
            .Content.ReadFromJsonAsync<ProjectResponse>())!;

        // Flujo clásico: UNA resolución de dueño por request (en memoria, sin tocar la tabla de proyectos).
        var before = counting.Calls;
        var projectQueriesBefore = ProjectQueries(logs);
        Assert.Equal(HttpStatusCode.OK, (await user.Client.GetAsync($"/api/v1/projects/{upload.ProjectId}/images/{upload.ImageId}")).StatusCode);
        Assert.Equal(1, counting.Calls - before);
        Assert.Equal(projectQueriesBefore, ProjectQueries(logs));

        // /api/v2: UNA consulta con el filtro de dueño (sin comprobación previa adicional ni N+1) y ninguna resolución clásica.
        before = counting.Calls;
        projectQueriesBefore = ProjectQueries(logs);
        Assert.Equal(HttpStatusCode.OK, (await user.Client.GetAsync($"/api/v2/projects/{project.Id}")).StatusCode);
        Assert.Equal(0, counting.Calls - before);
        Assert.Equal(1, ProjectQueries(logs) - projectQueriesBefore);

        static int ProjectQueries(CapturingLoggerProvider provider) =>
            provider.Entries.Count(e => e.Contains("Executed DbCommand", StringComparison.Ordinal) && e.Contains("FROM projects", StringComparison.Ordinal));
    }

    // =========================================================================================== helpers

    private IReadOnlyList<ApiRoute> ClassicRoutes() =>
        RouteInventory.From(_f.Factory.Services).Where(r => r.IsInClassicProjectGroup).ToList();

    private static Dictionary<string, string> KnownIds(IsolationWorld world) => new()
    {
        ["projectId"] = world.Classic.ProjectId.ToString(),
        ["imageId"] = world.Classic.ImageId.ToString(),
        ["paletteId"] = world.Classic.PaletteId.ToString(),
        ["groupId"] = world.Classic.LayerGroupIds[0].ToString(),
        ["vectorId"] = world.VectorIds[0].ToString(),
    };

    private static Dictionary<string, string> MissingIds() => new()
    {
        ["projectId"] = Guid.NewGuid().ToString(),
        ["imageId"] = Guid.NewGuid().ToString(),
        ["paletteId"] = Guid.NewGuid().ToString(),
        ["groupId"] = Guid.NewGuid().ToString(),
        ["vectorId"] = Guid.NewGuid().ToString(),
    };

    private static HttpRequestMessage BuildRequest(ApiRoute route, IReadOnlyDictionary<string, string> ids)
    {
        var request = new HttpRequestMessage(route.HttpMethod, route.Url(ids));
        if (route.Method is "POST" or "PUT" or "PATCH")
        {
            request.Content = new StringContent("{}", Encoding.UTF8, "application/json");
        }

        return request;
    }

    private static string JsonBody(ApiErrorResponse error) => System.Text.Json.JsonSerializer.Serialize(error, new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web));

    /// <summary>Estado observable de un mundo clásico + v2 (lecturas): si algo cambió, la huella cambia.</summary>
    private static async Task<string> ClassicStateAsync(HttpClient owner, IsolationWorld w)
    {
        var parts = new List<string>();
        foreach (var url in new[]
                 {
                     w.ClassicBase,
                     $"{w.ClassicBase}/color-palette/{w.Classic.PaletteId}",
                     $"{w.ClassicBase}/color-palette/{w.Classic.PaletteId}/layers",
                     $"{w.ClassicBase}/color-palette/{w.Classic.PaletteId}/layers/layout",
                     $"{w.ClassicBase}/color-palette/{w.Classic.PaletteId}/layers/operations",
                     $"{w.ClassicBase}/vectors/{w.VectorIds[0]}/components",
                     $"{w.ClassicBase}/vectors/{w.VectorIds[0]}/components/groups",
                     $"{w.ClassicBase}/vectors/{w.VectorIds[0]}/physical-union",
                     $"/api/v2/projects/{w.ProjectId}",
                     $"/api/v2/projects/{w.ProjectId}/document",
                     $"/api/v2/projects/{w.ProjectId}/versions",
                 })
        {
            var response = await owner.GetAsync(url);
            parts.Add($"{url} -> {(int)response.StatusCode} {await response.Content.ReadAsStringAsync()}");
        }

        var original = await owner.GetByteArrayAsync($"{w.ClassicBase}/original");
        parts.Add($"original {original.Length} {Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(original))}");
        return string.Join("\n", parts);
    }

    private static async Task<string> SnapshotAsync(HttpResponseMessage response)
    {
        var headers = response.Headers.Concat(response.Content.Headers)
            .Where(h => !VolatileHeaders.Contains(h.Key, StringComparer.OrdinalIgnoreCase))
            .OrderBy(h => h.Key, StringComparer.OrdinalIgnoreCase)
            .Select(h => $"{h.Key}={string.Join(",", h.Value)}");
        return $"{(int)response.StatusCode}|{string.Join(";", headers)}|{await response.Content.ReadAsStringAsync()}";
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

    private async Task<int> CountAssetsAsync(Guid projectId)
    {
        await using var scope = _f.Factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<VectorizationDbContext>();
        return await db.Assets.IgnoreQueryFilters().CountAsync(a => a.ProjectId == projectId);
    }

    private async Task<int> CountProjectsOfOwnerAsync(Guid ownerId, bool includeSoftDeleted = false)
    {
        await using var scope = _f.Factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<VectorizationDbContext>();
        var query = includeSoftDeleted ? db.Projects.IgnoreQueryFilters() : db.Projects;
        return await query.CountAsync(p => p.OwnerId == ownerId);
    }

    private async Task<int> CountAssetsOfOwnerAsync(Guid ownerId)
    {
        await using var scope = _f.Factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<VectorizationDbContext>();
        return await db.Assets.IgnoreQueryFilters().CountAsync(a => a.Project!.OwnerId == ownerId);
    }

    private async Task<Guid> OwnerOfProjectAsync(Guid projectId)
    {
        await using var scope = _f.Factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<VectorizationDbContext>();
        return await db.Projects.IgnoreQueryFilters().Where(p => p.Id == projectId).Select(p => p.OwnerId).SingleAsync();
    }

    /// <summary>Cuenta cuántas veces se resuelve el dueño en una request (sustituye al servicio real envolviéndolo).</summary>
    private sealed class CountingClassicProjectAccess
    {
        private int _calls;

        public int Calls => Volatile.Read(ref _calls);

        public sealed class Wrapper : IClassicProjectAccess
        {
            private readonly IClassicProjectAccess _inner;
            private readonly CountingClassicProjectAccess _counter;

            public Wrapper(IClassicProjectAccess inner, CountingClassicProjectAccess counter)
            {
                _inner = inner;
                _counter = counter;
            }

            public bool IsAccessible(ProjectRecord record)
            {
                Interlocked.Increment(ref _counter._calls);
                return _inner.IsAccessible(record);
            }

            public ProjectRecord? FindAccessible(Guid projectId, Guid imageId)
            {
                Interlocked.Increment(ref _counter._calls);
                return _inner.FindAccessible(projectId, imageId);
            }
        }
    }
}
