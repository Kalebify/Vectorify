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
/// Pruebas de integración HTTP de POST /api/v2/geometry/split (M3-S10): levantan la Web API real (WebApplicationFactory) contra un
/// motor Python simulado (FakePythonGeometryServer, sin cálculo geométrico real: eso lo cubre services/python-engine/tests con Shapely).
/// Cubren el contrato completo, que una petición inválida NUNCA llega a Python (el servidor falso cuenta las llamadas), que la petición
/// llega a la ruta de corte con el cuerpo documentado y el mapeo de cada falla de Python a un ApiErrorResponse.
/// </summary>
public sealed class GeometrySplitEndpointTests : IDisposable
{
    private const string Url = "/api/v2/geometry/split";

    private readonly string _storageRoot = Path.Combine(Path.GetTempPath(), "vectorify-split-tests-" + Guid.NewGuid().ToString("n"));
    private readonly string _projectRegistryRoot = Path.Combine(Path.GetTempPath(), "vectorify-split-tests-registry-" + Guid.NewGuid().ToString("n"));

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

    /// <summary>Python simulado que hace eco del modo, el ancho y la extensión pedidos (la validación defensiva del cliente exige que coincidan).</summary>
    private static Task<FakePythonGeometryServer> StartEchoingPython() =>
        FakePythonGeometryServer.StartAsync(requestBody =>
        {
            using var request = JsonDocument.Parse(requestBody);
            var root = request.RootElement;
            return (200, GeometryPayloads.SplitResponse(
                GeometryPayloads.SplitResult(0, $"[{GeometryPayloads.LeftHalf},{GeometryPayloads.RightHalf}]"),
                2,
                root.GetProperty("mode").GetString()!,
                root.GetProperty("slot_width").GetDouble(),
                root.GetProperty("extend").GetBoolean()));
        });

    private static Task<FakePythonGeometryServer> StartPython(int status = 200, string? body = null, TimeSpan? delay = null) =>
        FakePythonGeometryServer.StartAsync(_ => (status, body ?? GeometryPayloads.HalvesSplitResponse()), delay);

    [Fact]
    public async Task Post_WhenRequestIsValid_ReturnsThePiecesAndTheExplanationInCamelCase()
    {
        await using var python = await StartPython();
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();

        var response = await client.PostAsync(Url, Json(GeometryPayloads.SplitRequest()));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<GeometrySplitResponse>();
        Assert.NotNull(body);
        Assert.Equal(("split", 0.0, false, 0.01), (body!.Mode, body.SlotWidth, body.Extend, body.Tolerance));
        Assert.Equal(2, body.PieceCount);
        var item = Assert.Single(body.Results);
        Assert.Equal((0, true, true, 2, 0), (item.SubjectIndex, item.Changed, item.Touched, item.PieceCount, item.Discarded));
        Assert.Equal(2, item.Pieces.Count);
        Assert.Equal(20, item.Pieces[0].Coordinates[0][1][0].GetDouble());
        Assert.Equal(1, python.RequestCount);
        Assert.Equal("/api/v1/geometry/split", Assert.Single(python.Paths));

        using var raw = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Assert.True(raw.RootElement.TryGetProperty("pieceCount", out _));
        Assert.True(raw.RootElement.TryGetProperty("slotWidth", out _));
        var first = raw.RootElement.GetProperty("results")[0];
        foreach (var name in new[] { "subjectIndex", "changed", "touched", "pieces", "pieceCount", "discarded" })
        {
            Assert.True(first.TryGetProperty(name, out _), name);
        }
    }

    [Fact]
    public async Task Post_ForwardsTheValidatedRequestToPythonWithTheSnakeCaseBody()
    {
        await using var python = await StartEchoingPython();
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();

        var response = await client.PostAsync(Url, Json(GeometryPayloads.SplitRequest(mode: "SLOT", slotWidth: "0.4", extend: "true", tolerance: "0.02")));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using var forwarded = JsonDocument.Parse(Assert.Single(python.Bodies));
        var root = forwarded.RootElement;
        Assert.Equal("slot", root.GetProperty("mode").GetString());
        Assert.Equal(0.4, root.GetProperty("slot_width").GetDouble());
        Assert.True(root.GetProperty("extend").GetBoolean());
        Assert.Equal(0.02, root.GetProperty("tolerance").GetDouble());
        Assert.Equal(2, root.GetProperty("cutter").GetProperty("points").GetArrayLength());
        Assert.Equal("polygon", root.GetProperty("subjects")[0].GetProperty("type").GetString());
    }

    [Fact]
    public async Task Post_IsDeterministic_SameBytesAcrossRepeatedRequests_AndAlwaysCallsPythonAgain()
    {
        await using var python = await StartPython();
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();

        var first = await (await client.PostAsync(Url, Json(GeometryPayloads.SplitRequest()))).Content.ReadAsStringAsync();
        var second = await (await client.PostAsync(Url, Json(GeometryPayloads.SplitRequest()))).Content.ReadAsStringAsync();

        Assert.Equal(first, second);
        Assert.Equal(2, python.RequestCount);
    }

    [Fact]
    public async Task Post_PassesAnUnchangedResultThroughAsAnExplicitFlag()
    {
        var unchanged = GeometryPayloads.SplitResponse(GeometryPayloads.SplitResult(0, $"[{GeometryPayloads.WholeSquare}]", changed: false, touched: true), 1);
        await using var python = await StartPython(200, unchanged);
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();

        var response = await client.PostAsync(Url, Json(GeometryPayloads.SplitRequest()));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var item = Assert.Single((await response.Content.ReadFromJsonAsync<GeometrySplitResponse>())!.Results);
        Assert.False(item.Changed);
        Assert.True(item.Touched);
        Assert.Single(item.Pieces);
    }

    [Theory]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"cutter":{"points":[[0,0],[1,1]]},"mode":"chop","tolerance":0.01}""", "unknown_split_mode")]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"cutter":{"points":[[0,0],[1,1]]},"tolerance":0.01}""", "unknown_split_mode")]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"cutter":{"points":[[0,0],[1,1]]},"mode":"slot","tolerance":0.01}""", "invalid_slot_width")]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"cutter":{"points":[[0,0],[1,1]]},"mode":"slot","slotWidth":0,"tolerance":0.01}""", "invalid_slot_width")]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"cutter":{"points":[[0,0],[1,1]]},"mode":"slot","slotWidth":-1,"tolerance":0.01}""", "invalid_slot_width")]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"cutter":{"points":[[0,0],[1,1]]},"mode":"slot","slotWidth":2000000,"tolerance":0.01}""", "invalid_slot_width")]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"cutter":{"points":[[0,0],[1,1]]},"mode":"slot","slotWidth":"NaN","tolerance":0.01}""", "invalid_slot_width")]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"cutter":{"points":[[0,0],[1,1]]},"mode":"split","tolerance":0}""", "invalid_tolerance")]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"mode":"split","tolerance":0.01}""", "invalid_cutter")]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"cutter":{},"mode":"split","tolerance":0.01}""", "invalid_cutter")]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"cutter":{"points":[[0,0]]},"mode":"split","tolerance":0.01}""", "invalid_cutter")]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"cutter":{"points":[[5,5],[5,5]]},"mode":"split","tolerance":0.01}""", "invalid_cutter")]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"cutter":{"points":[[0,0],[null,1]]},"mode":"split","tolerance":0.01}""", "invalid_coordinates")]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"cutter":{"points":[[0,0],["NaN",1]]},"mode":"split","tolerance":0.01}""", "invalid_coordinates")]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"cutter":{"points":[[0,0],[1,1e999]]},"mode":"split","tolerance":0.01}""", "invalid_coordinates")]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[null,1]]}],"cutter":{"points":[[0,0],[1,1]]},"mode":"split","tolerance":0.01}""", "invalid_coordinates")]
    [InlineData("""{"subjects":[],"cutter":{"points":[[0,0],[1,1]]},"mode":"split","tolerance":0.01}""", "invalid_parameters")]
    [InlineData("""{"cutter":{"points":[[0,0],[1,1]]},"mode":"split","tolerance":0.01}""", "invalid_parameters")]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0]]}],"cutter":{"points":[[0,0],[1,1]]},"mode":"split","tolerance":0.01}""", "invalid_parameters")]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"cutter":{"points":[[0,0],[1,1]]},"mode":"split","extend":"yes","tolerance":0.01}""", "invalid_parameters")]
    [InlineData("null", "invalid_parameters")]
    [InlineData("{ esto no es json", "invalid_parameters")]
    [InlineData("", "invalid_parameters")]
    [InlineData("""{"subjects":"abc","cutter":{"points":[[0,0],[1,1]]},"mode":"split","tolerance":0.01}""", "invalid_parameters")]
    public async Task Post_WhenTheRequestIsInvalid_Returns400WithApiErrorAndNeverCallsPython(string body, string code)
    {
        await using var python = await StartPython();
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();

        var response = await client.PostAsync(Url, Json(body));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var error = await response.Content.ReadFromJsonAsync<ApiErrorResponse>();
        Assert.Equal(code, error!.Code);
        Assert.False(string.IsNullOrWhiteSpace(error.Message));
        Assert.Equal(0, python.RequestCount);
    }

    [Theory]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"cutter":{"points":[[0,0],[1,1]]},"mode":"slot","slotWidth":1e999,"tolerance":0.01}""")]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"cutter":{"points":[[0,0],[1,1]]},"mode":"split","tolerance":1e999}""")]
    public async Task Post_WhenANumberOverflowsToInfinity_Returns400AndNeverCallsPython(string body)
    {
        // Según cómo lea el número el deserializador, el desborde llega como JSON inválido o como Infinity al validador: en ambos casos es un 400.
        await using var python = await StartPython();
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();

        var response = await client.PostAsync(Url, Json(body));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Contains((await response.Content.ReadFromJsonAsync<ApiErrorResponse>())!.Code, new[] { "invalid_parameters", "invalid_slot_width", "invalid_tolerance" });
        Assert.Equal(0, python.RequestCount);
    }

    [Fact]
    public async Task Post_WhenSubjectsExceedTheConfiguredMaximum_Returns400AndNeverCallsPython()
    {
        await using var python = await StartPython();
        await using var factory = CreateFactory(python.BaseUrl, new() { ["Geometry:MaxSubjects"] = "2" });
        var client = factory.CreateClient();
        var subjects = string.Join(",", Enumerable.Repeat(GeometryPayloads.Square40, 3));

        var response = await client.PostAsync(Url, Json(GeometryPayloads.SplitRequest(subjects: subjects)));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("too_many_subjects", (await response.Content.ReadFromJsonAsync<ApiErrorResponse>())!.Code);
        Assert.Equal(0, python.RequestCount);
    }

    [Fact]
    public async Task Post_WhenVerticesExceedTheConfiguredMaximum_Returns400AndNeverCallsPython()
    {
        await using var python = await StartPython();
        await using var factory = CreateFactory(python.BaseUrl, new() { ["Geometry:MaxVertices"] = "5" });
        var client = factory.CreateClient();

        var response = await client.PostAsync(Url, Json(GeometryPayloads.SplitRequest()));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("too_many_vertices", (await response.Content.ReadFromJsonAsync<ApiErrorResponse>())!.Code);
        Assert.Equal(0, python.RequestCount);
    }

    [Fact]
    public async Task Post_WhenTheCutterHasMorePointsThanTheConfiguredMaximum_Returns400AndNeverCallsPython()
    {
        await using var python = await StartEchoingPython();
        await using var factory = CreateFactory(python.BaseUrl, new() { ["Geometry:MaxCutterPoints"] = "3" });
        var client = factory.CreateClient();

        var tooMany = await client.PostAsync(Url, Json(GeometryPayloads.SplitRequest(cutter: """{"points":[[0,0],[1,1],[2,0],[3,1]]}""")));
        var exactly = await client.PostAsync(Url, Json(GeometryPayloads.SplitRequest(cutter: """{"points":[[0,0],[1,1],[2,0]]}""")));

        Assert.Equal(HttpStatusCode.BadRequest, tooMany.StatusCode);
        Assert.Equal("too_many_cutter_points", (await tooMany.Content.ReadFromJsonAsync<ApiErrorResponse>())!.Code);
        Assert.Equal(HttpStatusCode.OK, exactly.StatusCode);
        Assert.Equal(1, python.RequestCount);
    }

    [Fact]
    public async Task Post_WhenTheSlotWidthExceedsTheConfiguredMaximum_Returns400AndNeverCallsPython()
    {
        await using var python = await StartEchoingPython();
        await using var factory = CreateFactory(python.BaseUrl, new() { ["Geometry:MaxOffsetDistance"] = "10" });
        var client = factory.CreateClient();

        var tooWide = await client.PostAsync(Url, Json(GeometryPayloads.SplitRequest(mode: "slot", slotWidth: "10.5")));
        var exactly = await client.PostAsync(Url, Json(GeometryPayloads.SplitRequest(mode: "slot", slotWidth: "10")));

        Assert.Equal(HttpStatusCode.BadRequest, tooWide.StatusCode);
        Assert.Equal("invalid_slot_width", (await tooWide.Content.ReadFromJsonAsync<ApiErrorResponse>())!.Code);
        Assert.Equal(HttpStatusCode.OK, exactly.StatusCode);
        Assert.Equal(1, python.RequestCount);
    }

    [Fact]
    public async Task Post_WhenTheBodyExceedsTheMaximumSize_Returns413AndNeverCallsPython()
    {
        await using var python = await StartPython();
        await using var factory = CreateFactory(python.BaseUrl, new() { ["Geometry:MaxRequestBodyBytes"] = "100" });
        var client = factory.CreateClient();

        var response = await client.PostAsync(Url, Json(GeometryPayloads.SplitRequest()));

        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, response.StatusCode);
        Assert.Equal("payload_too_large", (await response.Content.ReadFromJsonAsync<ApiErrorResponse>())!.Code);
        Assert.Equal(0, python.RequestCount);
    }

    [Fact]
    public async Task Post_WhenContentTypeIsNotJson_Returns415AndNeverCallsPython()
    {
        await using var python = await StartPython();
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();

        var response = await client.PostAsync(Url, new StringContent(GeometryPayloads.SplitRequest(), Encoding.UTF8, "text/plain"));

        Assert.Equal(HttpStatusCode.UnsupportedMediaType, response.StatusCode);
        Assert.Equal(0, python.RequestCount);
    }

    [Theory]
    [InlineData(422, "invalid_parameters", HttpStatusCode.UnprocessableEntity, "invalid_parameters")]
    [InlineData(422, "too_many_geometry_vertices", HttpStatusCode.UnprocessableEntity, "invalid_parameters")]
    [InlineData(413, "geometry_request_too_large", HttpStatusCode.RequestEntityTooLarge, "payload_too_large")]
    [InlineData(504, "geometry_timeout", HttpStatusCode.GatewayTimeout, "timeout")]
    [InlineData(500, "geometry_result_invalid", HttpStatusCode.InternalServerError, "processing_error")]
    public async Task Post_MapsPythonFailuresToApiErrors(int pythonStatus, string pythonCode, HttpStatusCode expectedStatus, string expectedCode)
    {
        await using var python = await StartPython(pythonStatus, GeometryPayloads.ErrorBody(pythonCode, "detalle de Python"));
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();

        var response = await client.PostAsync(Url, Json(GeometryPayloads.SplitRequest()));

        Assert.Equal(expectedStatus, response.StatusCode);
        var error = await response.Content.ReadFromJsonAsync<ApiErrorResponse>();
        Assert.Equal(expectedCode, error!.Code);
        Assert.Equal("detalle de Python", error.Message);
    }

    [Theory]
    [InlineData("""[{"type":"polygon","coordinates":[[[0,0],[20,0],[20,40],[0,40]]]},{"type":"polygon","coordinates":[[[20,0],[40,0],[40,40],[20,0]]]}]""")] // anillo sin cerrar
    [InlineData("""[{"type":"line","coordinates":[[0,0],[20,0]]},{"type":"line","coordinates":[[20,0],[40,0]]}]""")] // un polígono no se parte en líneas
    public async Task Post_WhenPythonReturnsAnInconsistentSuccess_Returns502AndNeverThatGeometry(string pieces)
    {
        var broken = GeometryPayloads.SplitResponse(GeometryPayloads.SplitResult(0, pieces), 2);
        await using var python = await StartPython(200, broken);
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();

        var response = await client.PostAsync(Url, Json(GeometryPayloads.SplitRequest()));

        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
        Assert.Equal("invalid_response", (await response.Content.ReadFromJsonAsync<ApiErrorResponse>())!.Code);
    }

    [Fact]
    public async Task Post_WhenPythonClaimsItSplitButReturnsOnePiece_Returns502()
    {
        // Dice `changed: true` pero devuelve el cuadrado entero: el editor no puede confiar en nada de esa respuesta.
        var lying = GeometryPayloads.SplitResponse(GeometryPayloads.SplitResult(0, $"[{GeometryPayloads.WholeSquare}]", changed: true, touched: true), 1);
        await using var python = await StartPython(200, lying);
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();

        var response = await client.PostAsync(Url, Json(GeometryPayloads.SplitRequest()));

        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
    }

    [Fact]
    public async Task Post_WhenPythonIsDown_Returns503EngineUnavailable()
    {
        string deadUrl;
        await using (var python = await StartPython())
        {
            deadUrl = python.BaseUrl;
        }

        await using var factory = CreateFactory(deadUrl);
        var client = factory.CreateClient();

        var response = await client.PostAsync(Url, Json(GeometryPayloads.SplitRequest()));

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        Assert.Equal("engine_unavailable", (await response.Content.ReadFromJsonAsync<ApiErrorResponse>())!.Code);
    }

    [Fact]
    public async Task Post_WhenPythonIsTooSlow_Returns504Timeout()
    {
        await using var python = await StartPython(delay: TimeSpan.FromSeconds(5));
        await using var factory = CreateFactory(python.BaseUrl, new() { ["Geometry:TimeoutSeconds"] = "1" });
        var client = factory.CreateClient();

        var response = await client.PostAsync(Url, Json(GeometryPayloads.SplitRequest()));

        Assert.Equal(HttpStatusCode.GatewayTimeout, response.StatusCode);
        Assert.Equal("timeout", (await response.Content.ReadFromJsonAsync<ApiErrorResponse>())!.Code);
    }

    [Fact]
    public async Task Post_DoesNotNeedADatabaseOrAnAuthenticatedUser()
    {
        // Operación sin estado ni datos del usuario (ADR D4): responde aunque Postgres no esté configurado (el factory no lo configura).
        await using var python = await StartPython();
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();

        var response = await client.PostAsync(Url, Json(GeometryPayloads.SplitRequest()));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task BooleanOffsetAndSplit_ReachTheirOwnPythonRoutes()
    {
        // Las tres operaciones comparten servidor y cliente: cada una llega a SU ruta de Python.
        await using var python = await StartPython();
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();

        await client.PostAsync(Url, Json(GeometryPayloads.SplitRequest()));
        await client.PostAsync("/api/v2/geometry/offset", Json(GeometryPayloads.OffsetRequest()));
        await client.PostAsync("/api/v2/geometry/boolean", Json(GeometryPayloads.Request()));

        Assert.Equal(["/api/v1/geometry/split", "/api/v1/geometry/offset", "/api/v1/geometry/boolean"], python.Paths);
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
