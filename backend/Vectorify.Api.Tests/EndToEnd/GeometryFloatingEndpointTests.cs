using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Vectorify.Api.Contracts;
using Vectorify.Api.Tests.TestSupport;

namespace Vectorify.Api.Tests.EndToEnd;

/// <summary>
/// Pruebas de integración HTTP de POST /api/v2/geometry/floating y /api/v2/geometry/bridge (M3-S11): levantan la Web API real (WebApplicationFactory)
/// contra un motor Python simulado (FakePythonGeometryServer, sin cálculo geométrico real: eso lo cubre services/python-engine/tests con Shapely).
/// Cubren el contrato completo en camelCase, que una petición inválida NUNCA llega a Python (el servidor falso cuenta las llamadas), que la petición llega
/// a la ruta correcta con el cuerpo documentado y el mapeo de cada falla de Python a un ApiErrorResponse.
/// </summary>
public sealed class GeometryFloatingEndpointTests : IDisposable
{
    private const string FloatingUrl = "/api/v2/geometry/floating";
    private const string BridgeUrl = "/api/v2/geometry/bridge";

    private readonly string _storageRoot = Path.Combine(Path.GetTempPath(), "vectorify-floating-tests-" + Guid.NewGuid().ToString("n"));
    private readonly string _projectRegistryRoot = Path.Combine(Path.GetTempPath(), "vectorify-floating-tests-registry-" + Guid.NewGuid().ToString("n"));

    private WebApplicationFactory<Program> CreateFactory(string pythonBaseUrl, Dictionary<string, string?>? extra = null) =>
        new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
        {
            builder.ConfigureAppConfiguration((_, config) =>
            {
                var settings = new Dictionary<string, string?>
                {
                    ["PythonEngine:BaseUrl"] = pythonBaseUrl,
                    ["Cors:AllowedOrigins"] = "http://localhost:5173",
                    ["Storage:RootPath"] = _storageRoot,
                    ["ProjectRegistry:RootPath"] = _projectRegistryRoot,
                };
                foreach (var (key, value) in extra ?? [])
                {
                    settings[key] = value;
                }

                config.AddInMemoryCollection(settings);
            });
        });

    private static StringContent Json(string body) => new(body, Encoding.UTF8, "application/json");

    /// <summary>Python simulado que contesta SIEMPRE lo mismo, sea cual sea la ruta (cada test llama a una sola).</summary>
    private static Task<FakePythonGeometryServer> StartPython(int status = 200, string? body = null, TimeSpan? delay = null) =>
        FakePythonGeometryServer.StartAsync(_ => (status, body ?? GeometryPayloads.FloatingResponse()), delay);

    private static Task<FakePythonGeometryServer> StartBridgePython(int status = 200, string? body = null, TimeSpan? delay = null) =>
        FakePythonGeometryServer.StartAsync(_ => (status, body ?? GeometryPayloads.BridgeResponse()), delay);

    // ---- /floating ----

    [Fact]
    public async Task Floating_WhenRequestIsValid_ReturnsTheComponentsInCamelCase()
    {
        await using var python = await StartPython();
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();

        var response = await client.PostAsync(FloatingUrl, Json(GeometryPayloads.FloatingRequest()));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<GeometryFloatingResponse>();
        Assert.NotNull(body);
        Assert.Equal(("stencil", 0.01, 1, 1, 0), (body!.Mode, body.Tolerance, body.FloatingCount, body.MainCount, body.Discarded));
        Assert.Equal(["principal", "floating"], body.Components.Select(component => component.Kind));
        Assert.Equal(100.0, body.Components[1].Area);
        Assert.Equal(1, python.RequestCount);
        Assert.Equal("/api/v1/geometry/floating", Assert.Single(python.Paths));

        using var raw = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Assert.True(raw.RootElement.TryGetProperty("floatingCount", out _));
        Assert.True(raw.RootElement.TryGetProperty("mainCount", out _));
        var island = raw.RootElement.GetProperty("components")[1];
        foreach (var name in new[] { "id", "kind", "depth", "parent", "polygon", "area", "bounds", "subjects" })
        {
            Assert.True(island.TryGetProperty(name, out _), name);
        }
    }

    [Fact]
    public async Task Floating_ForwardsTheValidatedRequestToPythonWithTheSnakeCaseBody()
    {
        await using var python = await StartPython(body: GeometryPayloads.PartsResponse());
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();
        var subjects = $$"""{"type":"polygon","coordinates":[[[0,0],[10,0],[10,10]]],"locked":true}""";

        var response = await client.PostAsync(FloatingUrl, Json(GeometryPayloads.FloatingRequest(subjects: subjects, mode: "PARTS", tolerance: "0.02")));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using var forwarded = JsonDocument.Parse(Assert.Single(python.Bodies));
        var root = forwarded.RootElement;
        Assert.Equal("parts", root.GetProperty("mode").GetString());
        Assert.Equal(0.02, root.GetProperty("tolerance").GetDouble());
        Assert.True(root.GetProperty("subjects")[0].GetProperty("locked").GetBoolean());
    }

    [Fact]
    public async Task Floating_IsDeterministic_SameBytesAcrossRepeatedRequests_AndAlwaysCallsPythonAgain()
    {
        await using var python = await StartPython();
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();

        var first = await (await client.PostAsync(FloatingUrl, Json(GeometryPayloads.FloatingRequest()))).Content.ReadAsStringAsync();
        var second = await (await client.PostAsync(FloatingUrl, Json(GeometryPayloads.FloatingRequest()))).Content.ReadAsStringAsync();

        Assert.Equal(first, second);
        Assert.Equal(2, python.RequestCount);
    }

    [Theory]
    [InlineData("""{"subjects":[{"type":"polygon","coordinates":[[[0,0],[1,0],[1,1]]]}],"mode":"hueco","tolerance":0.01}""", "unknown_floating_mode")]
    [InlineData("""{"subjects":[{"type":"polygon","coordinates":[[[0,0],[1,0],[1,1]]]}],"tolerance":0.01}""", "unknown_floating_mode")]
    [InlineData("""{"subjects":[{"type":"polygon","coordinates":[[[0,0],[1,0],[1,1]]]}],"mode":"stencil","tolerance":0}""", "invalid_tolerance")]
    [InlineData("""{"subjects":[{"type":"polygon","coordinates":[[[0,0],[1,0],[1,1]]]}],"mode":"stencil"}""", "invalid_tolerance")]
    [InlineData("""{"subjects":[{"type":"polygon","coordinates":[[[0,0],[1,0],[1,1]]]}],"mode":"stencil","tolerance":"NaN"}""", "invalid_tolerance")]
    [InlineData("""{"subjects":[],"mode":"stencil","tolerance":0.01}""", "invalid_parameters")]
    [InlineData("""{"mode":"stencil","tolerance":0.01}""", "invalid_parameters")]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"mode":"stencil","tolerance":0.01}""", "invalid_parameters")]
    [InlineData("""{"subjects":[{"type":"polygon","coordinates":[[[0,0],[1,1]]]}],"mode":"stencil","tolerance":0.01}""", "invalid_parameters")]
    [InlineData("""{"subjects":[{"type":"polygon","coordinates":[[[0,0],[null,0],[1,1]]]}],"mode":"stencil","tolerance":0.01}""", "invalid_coordinates")]
    [InlineData("""{"subjects":[{"type":"polygon","coordinates":[[[0,0],["NaN",0],[1,1]]]}],"mode":"stencil","tolerance":0.01}""", "invalid_coordinates")]
    [InlineData("""{"subjects":[{"type":"polygon","coordinates":[[[0,0],[1e12,0],[1,1]]]}],"mode":"stencil","tolerance":0.01}""", "invalid_coordinates")]
    [InlineData("""{"subjects":[{"type":"polygon","coordinates":[[[0,0],[1,0],[1,1]]],"locked":"si"}],"mode":"stencil","tolerance":0.01}""", "invalid_parameters")]
    [InlineData("null", "invalid_parameters")]
    [InlineData("{ esto no es json", "invalid_parameters")]
    [InlineData("", "invalid_parameters")]
    [InlineData("""{"subjects":"abc","mode":"stencil","tolerance":0.01}""", "invalid_parameters")]
    public async Task Floating_WhenTheRequestIsInvalid_Returns400WithApiErrorAndNeverCallsPython(string body, string code)
    {
        await using var python = await StartPython();
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();

        var response = await client.PostAsync(FloatingUrl, Json(body));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var error = await response.Content.ReadFromJsonAsync<ApiErrorResponse>();
        Assert.Equal(code, error!.Code);
        Assert.False(string.IsNullOrWhiteSpace(error.Message));
        Assert.Equal(0, python.RequestCount);
    }

    [Fact]
    public async Task Floating_WhenSubjectsOrVerticesExceedTheConfiguredMaximum_Returns400AndNeverCallsPython()
    {
        await using var python = await StartPython();
        await using var factory = CreateFactory(python.BaseUrl, new() { ["Geometry:MaxSubjects"] = "2", ["Geometry:MaxVertices"] = "20" });
        var client = factory.CreateClient();
        var three = string.Join(",", Enumerable.Repeat(GeometryPayloads.RingPolygon, 3));
        var manyVertices = string.Join(",", Enumerable.Repeat(GeometryPayloads.RingPolygon, 2)) + "," + GeometryPayloads.DotPolygon;

        var subjects = await client.PostAsync(FloatingUrl, Json(GeometryPayloads.FloatingRequest(subjects: three)));
        var ok = await client.PostAsync(FloatingUrl, Json(GeometryPayloads.FloatingRequest(subjects: string.Join(",", Enumerable.Repeat(GeometryPayloads.RingPolygon, 2)))));
        var vertices = await client.PostAsync(FloatingUrl, Json(GeometryPayloads.FloatingRequest(subjects: manyVertices)));

        Assert.Equal("too_many_subjects", (await subjects.Content.ReadFromJsonAsync<ApiErrorResponse>())!.Code);
        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, vertices.StatusCode);
        Assert.Equal(1, python.RequestCount);
    }

    [Fact]
    public async Task Floating_WhenTheBodyExceedsTheMaximumSize_Returns413AndNeverCallsPython()
    {
        await using var python = await StartPython();
        await using var factory = CreateFactory(python.BaseUrl, new() { ["Geometry:MaxRequestBodyBytes"] = "100" });
        var client = factory.CreateClient();

        var response = await client.PostAsync(FloatingUrl, Json(GeometryPayloads.FloatingRequest()));

        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, response.StatusCode);
        Assert.Equal("payload_too_large", (await response.Content.ReadFromJsonAsync<ApiErrorResponse>())!.Code);
        Assert.Equal(0, python.RequestCount);
    }

    [Fact]
    public async Task Floating_WhenContentTypeIsNotJson_Returns415AndNeverCallsPython()
    {
        await using var python = await StartPython();
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();

        var response = await client.PostAsync(FloatingUrl, new StringContent(GeometryPayloads.FloatingRequest(), Encoding.UTF8, "text/plain"));

        Assert.Equal(HttpStatusCode.UnsupportedMediaType, response.StatusCode);
        Assert.Equal(0, python.RequestCount);
    }

    [Theory]
    [InlineData(422, "invalid_parameters", HttpStatusCode.UnprocessableEntity, "invalid_parameters")]
    [InlineData(413, "geometry_request_too_large", HttpStatusCode.RequestEntityTooLarge, "payload_too_large")]
    [InlineData(504, "geometry_timeout", HttpStatusCode.GatewayTimeout, "timeout")]
    [InlineData(500, "geometry_result_invalid", HttpStatusCode.InternalServerError, "processing_error")]
    public async Task Floating_MapsPythonFailuresToApiErrors(int pythonStatus, string pythonCode, HttpStatusCode expectedStatus, string expectedCode)
    {
        await using var python = await StartPython(pythonStatus, GeometryPayloads.ErrorBody(pythonCode, "detalle de Python"));
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();

        var response = await client.PostAsync(FloatingUrl, Json(GeometryPayloads.FloatingRequest()));

        Assert.Equal(expectedStatus, response.StatusCode);
        var error = await response.Content.ReadFromJsonAsync<ApiErrorResponse>();
        Assert.Equal(expectedCode, error!.Code);
        Assert.Equal("detalle de Python", error.Message);
    }

    [Fact]
    public async Task Floating_WhenPythonReturnsAnInconsistentSuccess_Returns502AndNeverThatGeometry()
    {
        // Dice 5 flotantes pero la lista trae 1: el editor no puede confiar en ese recuento.
        await using var python = await StartPython(body: GeometryPayloads.FloatingResponse(floatingCount: 5));
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();

        var response = await client.PostAsync(FloatingUrl, Json(GeometryPayloads.FloatingRequest()));

        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
        Assert.Equal("invalid_response", (await response.Content.ReadFromJsonAsync<ApiErrorResponse>())!.Code);
    }

    [Fact]
    public async Task Floating_WhenPythonIsDown_Returns503EngineUnavailable()
    {
        string deadUrl;
        await using (var python = await StartPython())
        {
            deadUrl = python.BaseUrl;
        }

        await using var factory = CreateFactory(deadUrl);
        var client = factory.CreateClient();

        var response = await client.PostAsync(FloatingUrl, Json(GeometryPayloads.FloatingRequest()));

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        Assert.Equal("engine_unavailable", (await response.Content.ReadFromJsonAsync<ApiErrorResponse>())!.Code);
    }

    [Fact]
    public async Task Floating_WhenPythonIsTooSlow_Returns504Timeout()
    {
        await using var python = await StartPython(delay: TimeSpan.FromSeconds(5));
        await using var factory = CreateFactory(python.BaseUrl, new() { ["Geometry:TimeoutSeconds"] = "1" });
        var client = factory.CreateClient();

        var response = await client.PostAsync(FloatingUrl, Json(GeometryPayloads.FloatingRequest()));

        Assert.Equal(HttpStatusCode.GatewayTimeout, response.StatusCode);
        Assert.Equal("timeout", (await response.Content.ReadFromJsonAsync<ApiErrorResponse>())!.Code);
    }

    // ---- /bridge ----

    [Fact]
    public async Task Bridge_WhenRequestIsValid_ReturnsTheResolvedBridgesTheResultingGeometryAndTheReanalysis()
    {
        await using var python = await StartBridgePython();
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();

        var response = await client.PostAsync(BridgeUrl, Json(GeometryPayloads.BridgeRequest()));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<GeometryBridgeResponse>();
        Assert.NotNull(body);
        Assert.Equal(("stencil", 0.01, 1), (body!.Mode, body.Tolerance, body.PieceCount));
        Assert.Equal((1, 0, 1), (body.Reanalysis.FloatingBefore, body.Reanalysis.FloatingAfter, body.Reanalysis.MainAfter));
        var bridge = Assert.Single(body.Bridges);
        Assert.True(bridge.Valid);
        Assert.Equal(1, bridge.Island);
        Assert.Equal(4.0, bridge.Area);
        Assert.Equal(1, python.RequestCount);
        Assert.Equal("/api/v1/geometry/bridge", Assert.Single(python.Paths));

        using var raw = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Assert.True(raw.RootElement.GetProperty("reanalysis").TryGetProperty("floatingAfter", out _));
        var first = raw.RootElement.GetProperty("bridges")[0];
        foreach (var name in new[] { "index", "suggested", "valid", "reason", "island", "anchor", "direction", "width", "length", "area", "reduces", "affects", "polygon" })
        {
            Assert.True(first.TryGetProperty(name, out _), name);
        }

        Assert.True(raw.RootElement.GetProperty("results")[0].TryGetProperty("subjectIndex", out _));
    }

    [Fact]
    public async Task Bridge_ForwardsTheValidatedRequestToPythonWithTheSnakeCaseBody()
    {
        await using var python = await StartBridgePython();
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();
        var bridges = """{"island":1,"anchor":{"x":15,"y":7},"direction":{"x":2,"y":0},"width":0.8,"length":6}""";

        var response = await client.PostAsync(BridgeUrl, Json(GeometryPayloads.BridgeRequest(bridges: bridges, mode: "STENCIL", suggest: "false", suggestWidth: "0.5", tolerance: "0.02")));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using var forwarded = JsonDocument.Parse(Assert.Single(python.Bodies));
        var root = forwarded.RootElement;
        Assert.Equal("stencil", root.GetProperty("mode").GetString());
        Assert.Equal(0.02, root.GetProperty("tolerance").GetDouble());
        Assert.False(root.GetProperty("suggest").GetBoolean());
        Assert.False(root.TryGetProperty("suggest_width", out _));
        var bridge = root.GetProperty("bridges")[0];
        Assert.Equal(1, bridge.GetProperty("island").GetInt32());
        Assert.Equal(0.8, bridge.GetProperty("width").GetDouble());
        Assert.Equal(6, bridge.GetProperty("length").GetDouble());
        Assert.Equal(2, bridge.GetProperty("direction").GetProperty("x").GetDouble());
    }

    [Fact]
    public async Task Bridge_WithSuggest_ReturnsTheSuggestedBridges()
    {
        var bridges = GeometryPayloads.BridgeItem(suggested: true, width: 0.5);
        await using var python = await StartBridgePython(body: GeometryPayloads.BridgeResponse(bridgesJson: bridges));
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();

        var response = await client.PostAsync(BridgeUrl, Json(GeometryPayloads.BridgeRequest(bridges: string.Empty, suggest: "true", suggestWidth: "0.5")));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<GeometryBridgeResponse>();
        Assert.True(Assert.Single(body!.Bridges).Suggested);
        using var forwarded = JsonDocument.Parse(Assert.Single(python.Bodies));
        Assert.True(forwarded.RootElement.GetProperty("suggest").GetBoolean());
        Assert.Equal(0.5, forwarded.RootElement.GetProperty("suggest_width").GetDouble());
        Assert.Equal(0, forwarded.RootElement.GetProperty("bridges").GetArrayLength());
    }

    [Fact]
    public async Task Bridge_IsDeterministic_SameBytesAcrossRepeatedRequests_AndAlwaysCallsPythonAgain()
    {
        await using var python = await StartBridgePython();
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();

        var first = await (await client.PostAsync(BridgeUrl, Json(GeometryPayloads.BridgeRequest()))).Content.ReadAsStringAsync();
        var second = await (await client.PostAsync(BridgeUrl, Json(GeometryPayloads.BridgeRequest()))).Content.ReadAsStringAsync();

        Assert.Equal(first, second);
        Assert.Equal(2, python.RequestCount);
    }

    [Theory]
    [InlineData("""{"subjects":[{"type":"polygon","coordinates":[[[0,0],[1,0],[1,1]]]}],"mode":"hueco","bridges":[],"tolerance":0.01}""", "unknown_floating_mode")]
    [InlineData("""{"subjects":[{"type":"polygon","coordinates":[[[0,0],[1,0],[1,1]]]}],"mode":"stencil","bridges":[],"tolerance":0}""", "invalid_tolerance")]
    [InlineData("""{"subjects":[{"type":"polygon","coordinates":[[[0,0],[1,0],[1,1]]]}],"mode":"stencil","bridges":[{"width":1}],"tolerance":0.01}""", "invalid_bridge")]
    [InlineData("""{"subjects":[{"type":"polygon","coordinates":[[[0,0],[1,0],[1,1]]]}],"mode":"stencil","bridges":[{"island":-3,"width":1}],"tolerance":0.01}""", "invalid_bridge")]
    [InlineData("""{"subjects":[{"type":"polygon","coordinates":[[[0,0],[1,0],[1,1]]]}],"mode":"stencil","bridges":[{"island":1,"direction":{"x":0,"y":0},"width":1}],"tolerance":0.01}""", "invalid_bridge")]
    [InlineData("""{"subjects":[{"type":"polygon","coordinates":[[[0,0],[1,0],[1,1]]]}],"mode":"stencil","bridges":[{"island":1}],"tolerance":0.01}""", "invalid_bridge_width")]
    [InlineData("""{"subjects":[{"type":"polygon","coordinates":[[[0,0],[1,0],[1,1]]]}],"mode":"stencil","bridges":[{"island":1,"width":-1}],"tolerance":0.01}""", "invalid_bridge_width")]
    [InlineData("""{"subjects":[{"type":"polygon","coordinates":[[[0,0],[1,0],[1,1]]]}],"mode":"stencil","bridges":[{"island":1,"width":"NaN"}],"tolerance":0.01}""", "invalid_bridge_width")]
    [InlineData("""{"subjects":[{"type":"polygon","coordinates":[[[0,0],[1,0],[1,1]]]}],"mode":"stencil","bridges":[{"island":1,"width":1,"length":0}],"tolerance":0.01}""", "invalid_bridge_width")]
    [InlineData("""{"subjects":[{"type":"polygon","coordinates":[[[0,0],[1,0],[1,1]]]}],"mode":"stencil","bridges":[],"suggest":true,"tolerance":0.01}""", "invalid_bridge_width")]
    [InlineData("""{"subjects":[{"type":"polygon","coordinates":[[[0,0],[1,0],[1,1]]]}],"mode":"stencil","bridges":[{"anchor":{"x":null,"y":1},"width":1}],"tolerance":0.01}""", "invalid_coordinates")]
    [InlineData("""{"subjects":[{"type":"polygon","coordinates":[[[0,0],[1,0],[1,1]]]}],"mode":"stencil","bridges":[{"anchor":{"x":1,"y":"Infinity"},"width":1}],"tolerance":0.01}""", "invalid_coordinates")]
    [InlineData("""{"subjects":[{"type":"polygon","coordinates":[[[0,0],[1,0],[1,1]]]}],"mode":"stencil","bridges":[{"island":1,"direction":{"x":"NaN","y":1},"width":1}],"tolerance":0.01}""", "invalid_coordinates")]
    [InlineData("""{"subjects":[],"mode":"stencil","bridges":[],"tolerance":0.01}""", "invalid_parameters")]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"mode":"stencil","bridges":[],"tolerance":0.01}""", "invalid_parameters")]
    [InlineData("""{"subjects":[{"type":"polygon","coordinates":[[[0,0],[1,0],[1,1]]]}],"mode":"stencil","bridges":"uno","tolerance":0.01}""", "invalid_parameters")]
    [InlineData("""{"subjects":[{"type":"polygon","coordinates":[[[0,0],[1,0],[1,1]]]}],"mode":"stencil","bridges":[],"suggest":"si","tolerance":0.01}""", "invalid_parameters")]
    [InlineData("null", "invalid_parameters")]
    [InlineData("{ esto no es json", "invalid_parameters")]
    public async Task Bridge_WhenTheRequestIsInvalid_Returns400WithApiErrorAndNeverCallsPython(string body, string code)
    {
        await using var python = await StartBridgePython();
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();

        var response = await client.PostAsync(BridgeUrl, Json(body));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var error = await response.Content.ReadFromJsonAsync<ApiErrorResponse>();
        Assert.Equal(code, error!.Code);
        Assert.False(string.IsNullOrWhiteSpace(error.Message));
        Assert.Equal(0, python.RequestCount);
    }

    [Fact]
    public async Task Bridge_WhenBridgesExceedTheConfiguredMaximum_Returns400AndNeverCallsPython()
    {
        var twoBridges = GeometryPayloads.BridgeItem() + "," + GeometryPayloads.BridgeItem(index: 1);
        await using var python = await StartBridgePython(body: GeometryPayloads.BridgeResponse(bridgesJson: twoBridges));
        await using var factory = CreateFactory(python.BaseUrl, new() { ["Geometry:MaxBridges"] = "2" });
        var client = factory.CreateClient();
        string Many(int count) => string.Join(",", Enumerable.Repeat(GeometryPayloads.DefaultBridge, count));

        var tooMany = await client.PostAsync(BridgeUrl, Json(GeometryPayloads.BridgeRequest(bridges: Many(3))));
        var exactly = await client.PostAsync(BridgeUrl, Json(GeometryPayloads.BridgeRequest(bridges: Many(2))));

        Assert.Equal(HttpStatusCode.BadRequest, tooMany.StatusCode);
        Assert.Equal("too_many_bridges", (await tooMany.Content.ReadFromJsonAsync<ApiErrorResponse>())!.Code);
        Assert.Equal(HttpStatusCode.OK, exactly.StatusCode);
        Assert.Equal(1, python.RequestCount);
    }

    [Fact]
    public async Task Bridge_WhenWidthExceedsTheConfiguredMaximum_Returns400AndNeverCallsPython()
    {
        await using var python = await StartBridgePython();
        await using var factory = CreateFactory(python.BaseUrl, new() { ["Geometry:MaxOffsetDistance"] = "10" });
        var client = factory.CreateClient();

        var tooWide = await client.PostAsync(BridgeUrl, Json(GeometryPayloads.BridgeRequest(bridges: """{"island":1,"width":10.5}""")));

        Assert.Equal(HttpStatusCode.BadRequest, tooWide.StatusCode);
        Assert.Equal("invalid_bridge_width", (await tooWide.Content.ReadFromJsonAsync<ApiErrorResponse>())!.Code);
        Assert.Equal(0, python.RequestCount);
    }

    [Fact]
    public async Task Bridge_WhenSubjectsOrVerticesExceedTheConfiguredMaximum_Returns400AndNeverCallsPython()
    {
        await using var python = await StartBridgePython();
        await using var factory = CreateFactory(python.BaseUrl, new() { ["Geometry:MaxSubjects"] = "1", ["Geometry:MaxVertices"] = "7" });
        var client = factory.CreateClient();
        var two = GeometryPayloads.RingPolygon + "," + GeometryPayloads.RingPolygon;

        var subjects = await client.PostAsync(BridgeUrl, Json(GeometryPayloads.BridgeRequest(subjects: two)));
        var vertices = await client.PostAsync(BridgeUrl, Json(GeometryPayloads.BridgeRequest()));

        Assert.Equal("too_many_subjects", (await subjects.Content.ReadFromJsonAsync<ApiErrorResponse>())!.Code);
        Assert.Equal("too_many_vertices", (await vertices.Content.ReadFromJsonAsync<ApiErrorResponse>())!.Code);
        Assert.Equal(0, python.RequestCount);
    }

    [Fact]
    public async Task Bridge_WhenTheBodyExceedsTheMaximumSize_Returns413AndNeverCallsPython()
    {
        await using var python = await StartBridgePython();
        await using var factory = CreateFactory(python.BaseUrl, new() { ["Geometry:MaxRequestBodyBytes"] = "100" });
        var client = factory.CreateClient();

        var response = await client.PostAsync(BridgeUrl, Json(GeometryPayloads.BridgeRequest()));

        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, response.StatusCode);
        Assert.Equal("payload_too_large", (await response.Content.ReadFromJsonAsync<ApiErrorResponse>())!.Code);
        Assert.Equal(0, python.RequestCount);
    }

    [Theory]
    [InlineData(422, "invalid_parameters", HttpStatusCode.UnprocessableEntity, "invalid_parameters")]
    [InlineData(422, "too_many_geometry_vertices", HttpStatusCode.UnprocessableEntity, "invalid_parameters")]
    [InlineData(413, "geometry_request_too_large", HttpStatusCode.RequestEntityTooLarge, "payload_too_large")]
    [InlineData(504, "geometry_timeout", HttpStatusCode.GatewayTimeout, "timeout")]
    [InlineData(500, "geometry_result_invalid", HttpStatusCode.InternalServerError, "processing_error")]
    public async Task Bridge_MapsPythonFailuresToApiErrors(int pythonStatus, string pythonCode, HttpStatusCode expectedStatus, string expectedCode)
    {
        await using var python = await StartBridgePython(pythonStatus, GeometryPayloads.ErrorBody(pythonCode, "detalle de Python"));
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();

        var response = await client.PostAsync(BridgeUrl, Json(GeometryPayloads.BridgeRequest()));

        Assert.Equal(expectedStatus, response.StatusCode);
        var error = await response.Content.ReadFromJsonAsync<ApiErrorResponse>();
        Assert.Equal(expectedCode, error!.Code);
        Assert.Equal("detalle de Python", error.Message);
    }

    [Fact]
    public async Task Bridge_WhenPythonClaimsAReductionItDidNotMake_Returns502()
    {
        // El único bridge es inválido y no modifica nada, pero el reanálisis dice 3 -> 0: el editor no puede confiar en esa respuesta.
        var invalid = GeometryPayloads.BridgeItem(valid: false, reason: "too_short", reduces: false, affects: "[]");
        var lying = GeometryPayloads.BridgeResponse(
            bridgesJson: invalid, resultsJson: GeometryPayloads.BridgeSubjectResult(0, false, "[]"), floatingBefore: 3, floatingAfter: 0, pieceCount: 0);
        await using var python = await StartBridgePython(body: lying);
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();

        var response = await client.PostAsync(BridgeUrl, Json(GeometryPayloads.BridgeRequest()));

        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
        Assert.Equal("invalid_response", (await response.Content.ReadFromJsonAsync<ApiErrorResponse>())!.Code);
    }

    [Fact]
    public async Task Bridge_WhenPythonIsDownOrTooSlow_Returns503Or504()
    {
        string deadUrl;
        await using (var python = await StartBridgePython())
        {
            deadUrl = python.BaseUrl;
        }

        await using (var factory = CreateFactory(deadUrl))
        {
            var down = await factory.CreateClient().PostAsync(BridgeUrl, Json(GeometryPayloads.BridgeRequest()));
            Assert.Equal(HttpStatusCode.ServiceUnavailable, down.StatusCode);
            Assert.Equal("engine_unavailable", (await down.Content.ReadFromJsonAsync<ApiErrorResponse>())!.Code);
        }

        await using var slow = await StartBridgePython(delay: TimeSpan.FromSeconds(5));
        await using var slowFactory = CreateFactory(slow.BaseUrl, new() { ["Geometry:TimeoutSeconds"] = "1" });
        var timeout = await slowFactory.CreateClient().PostAsync(BridgeUrl, Json(GeometryPayloads.BridgeRequest()));
        Assert.Equal(HttpStatusCode.GatewayTimeout, timeout.StatusCode);
        Assert.Equal("timeout", (await timeout.Content.ReadFromJsonAsync<ApiErrorResponse>())!.Code);
    }

    [Fact]
    public async Task FloatingAndBridge_DoNotNeedADatabaseOrAnAuthenticatedUser_AndReachTheirOwnPythonRoutes()
    {
        // Operaciones sin estado ni datos del usuario (ADR D4): responden aunque Postgres no esté configurado, y cada una llega a SU ruta de Python.
        await using var python = await FakePythonGeometryServer.StartAsync(body =>
            body.Contains("\"bridges\"") ? (200, GeometryPayloads.BridgeResponse()) : (200, GeometryPayloads.FloatingResponse()));
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();

        var floating = await client.PostAsync(FloatingUrl, Json(GeometryPayloads.FloatingRequest()));
        var bridge = await client.PostAsync(BridgeUrl, Json(GeometryPayloads.BridgeRequest()));
        await client.PostAsync("/api/v2/geometry/split", Json(GeometryPayloads.SplitRequest()));

        Assert.Equal(HttpStatusCode.OK, floating.StatusCode);
        Assert.Equal(HttpStatusCode.OK, bridge.StatusCode);
        Assert.Equal(["/api/v1/geometry/floating", "/api/v1/geometry/bridge", "/api/v1/geometry/split"], python.Paths);
    }

    public void Dispose()
    {
        if (Directory.Exists(_storageRoot))
        {
            Directory.Delete(_storageRoot, recursive: true);
        }

        if (Directory.Exists(_projectRegistryRoot))
        {
            Directory.Delete(_projectRegistryRoot, recursive: true);
        }
    }
}
