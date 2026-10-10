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
/// Pruebas de integración HTTP de POST /api/v2/geometry/offset (M3-S09): levantan la Web API real (WebApplicationFactory) contra un
/// motor Python simulado (FakePythonGeometryServer, sin cálculo geométrico real: eso lo cubre services/python-engine/tests con Shapely).
/// Cubren el contrato completo, que una petición inválida NUNCA llega a Python (el servidor falso cuenta las llamadas), que la petición
/// llega a la ruta de offset con el cuerpo documentado y el mapeo de cada falla de Python a un ApiErrorResponse.
/// </summary>
public sealed class GeometryOffsetEndpointTests : IDisposable
{
    private const string Url = "/api/v2/geometry/offset";

    private readonly string _storageRoot = Path.Combine(Path.GetTempPath(), "vectorify-offset-tests-" + Guid.NewGuid().ToString("n"));
    private readonly string _projectRegistryRoot = Path.Combine(Path.GetTempPath(), "vectorify-offset-tests-registry-" + Guid.NewGuid().ToString("n"));

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

    /// <summary>Python simulado que hace eco de la distancia pedida (la validación defensiva del cliente exige que coincida).</summary>
    private static Task<FakePythonGeometryServer> StartEchoingPython() =>
        FakePythonGeometryServer.StartAsync(requestBody =>
        {
            using var request = JsonDocument.Parse(requestBody);
            var distance = request.RootElement.GetProperty("distance").GetDouble();
            return (200, GeometryPayloads.OffsetResponse(GeometryPayloads.OffsetResult(0, """[{"type":"polygon","coordinates":[[[0,0],[1,0],[1,1],[0,0]]]}]"""), 1, distance));
        });

    private static Task<FakePythonGeometryServer> StartPython(int status = 200, string? body = null, TimeSpan? delay = null) =>
        FakePythonGeometryServer.StartAsync(_ => (status, body ?? GeometryPayloads.GrownSquareOffsetResponse()), delay);

    [Fact]
    public async Task Post_WhenRequestIsValid_ReturnsThePiecesAndTheExplanationInCamelCase()
    {
        await using var python = await StartPython();
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();

        var response = await client.PostAsync(Url, Json(GeometryPayloads.OffsetRequest()));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<GeometryOffsetResponse>();
        Assert.NotNull(body);
        Assert.Equal((3.0, "mitre", 2.0, "round", 0.01), (body!.Distance, body.JoinStyle, body.MitreLimit, body.CapStyle, body.Tolerance));
        Assert.Equal(1, body.PieceCount);
        var item = Assert.Single(body.Results);
        Assert.Equal(0, item.SubjectIndex);
        Assert.False(item.Collapsed);
        Assert.Equal((1, 1, 0, 0, 0), (item.PiecesBefore, item.SplitCount, item.LostPieces, item.HolesBefore, item.HolesAfter));
        Assert.Equal(20, item.MaxInwardOffset);
        Assert.Equal(-3, Assert.Single(item.Geometries).Coordinates[0][0][0].GetDouble());
        Assert.Equal(1, python.RequestCount);
        Assert.Equal("/api/v1/geometry/offset", Assert.Single(python.Paths));

        using var raw = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Assert.True(raw.RootElement.TryGetProperty("pieceCount", out _));
        Assert.True(raw.RootElement.TryGetProperty("joinStyle", out _));
        var first = raw.RootElement.GetProperty("results")[0];
        foreach (var name in new[] { "subjectIndex", "splitCount", "piecesBefore", "lostPieces", "holesBefore", "holesAfter", "maxInwardOffset" })
        {
            Assert.True(first.TryGetProperty(name, out _), name);
        }
    }

    [Fact]
    public async Task Post_ForwardsTheValidatedRequestToPythonWithTheSnakeCaseBody()
    {
        await using var python = await StartPython();
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();

        await client.PostAsync(Url, Json(GeometryPayloads.OffsetRequest(distance: "-2.5", joinStyle: "Bevel", mitreLimit: "4", capStyle: "FLAT", tolerance: "0.02")));

        using var forwarded = JsonDocument.Parse(Assert.Single(python.Bodies));
        var root = forwarded.RootElement;
        Assert.Equal(-2.5, root.GetProperty("distance").GetDouble());
        Assert.Equal("bevel", root.GetProperty("join_style").GetString());
        Assert.Equal(4, root.GetProperty("mitre_limit").GetDouble());
        Assert.Equal("flat", root.GetProperty("cap_style").GetString());
        Assert.Equal(0.02, root.GetProperty("tolerance").GetDouble());
        Assert.Equal("polygon", root.GetProperty("subjects")[0].GetProperty("type").GetString());
    }

    [Fact]
    public async Task Post_IsDeterministic_SameBytesAcrossRepeatedRequests_AndAlwaysCallsPythonAgain()
    {
        await using var python = await StartPython();
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();

        var first = await (await client.PostAsync(Url, Json(GeometryPayloads.OffsetRequest()))).Content.ReadAsStringAsync();
        var second = await (await client.PostAsync(Url, Json(GeometryPayloads.OffsetRequest()))).Content.ReadAsStringAsync();

        Assert.Equal(first, second);
        Assert.Equal(2, python.RequestCount);
    }

    [Fact]
    public async Task Post_PassesACollapsedResultThroughAsAnExplicitFlag()
    {
        var collapsed = GeometryPayloads.OffsetResponse(GeometryPayloads.OffsetResult(0, "[]", lostPieces: 1), 0, distance: -25);
        await using var python = await StartPython(200, collapsed);
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();

        var response = await client.PostAsync(Url, Json(GeometryPayloads.OffsetRequest(distance: "-25")));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var item = Assert.Single((await response.Content.ReadFromJsonAsync<GeometryOffsetResponse>())!.Results);
        Assert.True(item.Collapsed);
        Assert.Empty(item.Geometries);
        Assert.Equal(20, item.MaxInwardOffset);
    }

    [Theory]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"distance":0,"tolerance":0.01}""", "invalid_distance")]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"distance":-1,"tolerance":0.01}""", "invalid_distance")]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"distance":2000000,"tolerance":0.01}""", "invalid_distance")]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"tolerance":0.01}""", "invalid_distance")]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"distance":1,"joinStyle":"miter","tolerance":0.01}""", "unknown_join_style")]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"distance":1,"capStyle":"butt","tolerance":0.01}""", "unknown_cap_style")]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"distance":1,"mitreLimit":0,"tolerance":0.01}""", "invalid_mitre_limit")]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"distance":1,"mitreLimit":-3,"tolerance":0.01}""", "invalid_mitre_limit")]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"distance":1,"tolerance":0}""", "invalid_tolerance")]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[null,1]]}],"distance":1,"tolerance":0.01}""", "invalid_coordinates")]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],["NaN",1]]}],"distance":1,"tolerance":0.01}""", "invalid_coordinates")]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[1e999,1]]}],"distance":1,"tolerance":0.01}""", "invalid_coordinates")]
    [InlineData("""{"subjects":[],"distance":1,"tolerance":0.01}""", "invalid_parameters")]
    [InlineData("""{"distance":1,"tolerance":0.01}""", "invalid_parameters")]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0]]}],"distance":1,"tolerance":0.01}""", "invalid_parameters")]
    [InlineData("null", "invalid_parameters")]
    [InlineData("{ esto no es json", "invalid_parameters")]
    [InlineData("", "invalid_parameters")]
    [InlineData("""{"subjects":"abc","distance":1,"tolerance":0.01}""", "invalid_parameters")]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"distance":"NaN","tolerance":0.01}""", "invalid_distance")]
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
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"distance":1e999,"tolerance":0.01}""")]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"distance":1,"mitreLimit":1e999,"tolerance":0.01}""")]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"distance":1,"tolerance":1e999}""")]
    public async Task Post_WhenANumberOverflowsToInfinity_Returns400AndNeverCallsPython(string body)
    {
        // Según cómo lea el número el deserializador, el desborde llega como JSON inválido o como Infinity al validador: en ambos casos es un 400.
        await using var python = await StartPython();
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();

        var response = await client.PostAsync(Url, Json(body));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Contains((await response.Content.ReadFromJsonAsync<ApiErrorResponse>())!.Code, new[] { "invalid_parameters", "invalid_distance", "invalid_mitre_limit", "invalid_tolerance" });
        Assert.Equal(0, python.RequestCount);
    }

    [Fact]
    public async Task Post_WhenSubjectsExceedTheConfiguredMaximum_Returns400AndNeverCallsPython()
    {
        await using var python = await StartPython();
        await using var factory = CreateFactory(python.BaseUrl, new() { ["Geometry:MaxSubjects"] = "2" });
        var client = factory.CreateClient();
        var subjects = string.Join(",", Enumerable.Repeat(GeometryPayloads.Square40, 3));

        var response = await client.PostAsync(Url, Json(GeometryPayloads.OffsetRequest(subjects: subjects)));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("too_many_subjects", (await response.Content.ReadFromJsonAsync<ApiErrorResponse>())!.Code);
        Assert.Equal(0, python.RequestCount);
    }

    [Fact]
    public async Task Post_WhenVerticesExceedTheConfiguredMaximum_Returns400AndNeverCallsPython()
    {
        await using var python = await StartPython();
        await using var factory = CreateFactory(python.BaseUrl, new() { ["Geometry:MaxVertices"] = "3" });
        var client = factory.CreateClient();

        var response = await client.PostAsync(Url, Json(GeometryPayloads.OffsetRequest()));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("too_many_vertices", (await response.Content.ReadFromJsonAsync<ApiErrorResponse>())!.Code);
        Assert.Equal(0, python.RequestCount);
    }

    [Fact]
    public async Task Post_WhenTheDistanceExceedsTheConfiguredMaximum_Returns400AndNeverCallsPython()
    {
        await using var python = await StartEchoingPython();
        await using var factory = CreateFactory(python.BaseUrl, new() { ["Geometry:MaxOffsetDistance"] = "10" });
        var client = factory.CreateClient();

        var tooFar = await client.PostAsync(Url, Json(GeometryPayloads.OffsetRequest(distance: "10.5")));
        var exactly = await client.PostAsync(Url, Json(GeometryPayloads.OffsetRequest(distance: "10")));

        Assert.Equal(HttpStatusCode.BadRequest, tooFar.StatusCode);
        Assert.Equal("invalid_distance", (await tooFar.Content.ReadFromJsonAsync<ApiErrorResponse>())!.Code);
        Assert.Equal(HttpStatusCode.OK, exactly.StatusCode);
        Assert.Equal(1, python.RequestCount);
    }

    [Fact]
    public async Task Post_WhenTheBodyExceedsTheMaximumSize_Returns413AndNeverCallsPython()
    {
        await using var python = await StartPython();
        await using var factory = CreateFactory(python.BaseUrl, new() { ["Geometry:MaxRequestBodyBytes"] = "100" });
        var client = factory.CreateClient();

        var response = await client.PostAsync(Url, Json(GeometryPayloads.OffsetRequest()));

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

        var response = await client.PostAsync(Url, new StringContent(GeometryPayloads.OffsetRequest(), Encoding.UTF8, "text/plain"));

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

        var response = await client.PostAsync(Url, Json(GeometryPayloads.OffsetRequest()));

        Assert.Equal(expectedStatus, response.StatusCode);
        var error = await response.Content.ReadFromJsonAsync<ApiErrorResponse>();
        Assert.Equal(expectedCode, error!.Code);
        Assert.Equal("detalle de Python", error.Message);
    }

    [Theory]
    [InlineData("""{"type":"polygon","coordinates":[[[0,0],[40,0],[40,15],[0,15]]]}""")] // anillo sin cerrar
    [InlineData("""{"type":"line","coordinates":[[0,0],[40,0]]}""")] // el offset solo devuelve polígonos
    public async Task Post_WhenPythonReturnsAnInconsistentSuccess_Returns502AndNeverThatGeometry(string piece)
    {
        // holes_after = 1 hace que los conteos cuadren incluso con la polilínea de 2 vértices: el rechazo es por el TIPO de la pieza.
        var broken = GeometryPayloads.OffsetResponse(GeometryPayloads.OffsetResult(0, $"[{piece}]", holesAfter: piece.Contains("line") ? 1 : 0), 1);
        await using var python = await StartPython(200, broken);
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();

        var response = await client.PostAsync(Url, Json(GeometryPayloads.OffsetRequest()));

        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
        Assert.Equal("invalid_response", (await response.Content.ReadFromJsonAsync<ApiErrorResponse>())!.Code);
    }

    [Fact]
    public async Task Post_WhenPythonLiesAboutCollapse_Returns502()
    {
        // Dice `collapsed: true` pero trae una pieza: el editor no puede confiar en nada de esa respuesta.
        var lying = GeometryPayloads.OffsetResponse(
            GeometryPayloads.OffsetResult(0, """[{"type":"polygon","coordinates":[[[0,0],[1,0],[1,1],[0,0]]]}]""", collapsed: true), 1);
        await using var python = await StartPython(200, lying);
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();

        var response = await client.PostAsync(Url, Json(GeometryPayloads.OffsetRequest()));

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

        var response = await client.PostAsync(Url, Json(GeometryPayloads.OffsetRequest()));

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        Assert.Equal("engine_unavailable", (await response.Content.ReadFromJsonAsync<ApiErrorResponse>())!.Code);
    }

    [Fact]
    public async Task Post_WhenPythonIsTooSlow_Returns504Timeout()
    {
        await using var python = await StartPython(delay: TimeSpan.FromSeconds(5));
        await using var factory = CreateFactory(python.BaseUrl, new() { ["Geometry:TimeoutSeconds"] = "1" });
        var client = factory.CreateClient();

        var response = await client.PostAsync(Url, Json(GeometryPayloads.OffsetRequest()));

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

        var response = await client.PostAsync(Url, Json(GeometryPayloads.OffsetRequest()));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task BooleanAndOffset_ReachTheirOwnPythonRoutes()
    {
        // Las dos operaciones comparten servidor y cliente: cada una llega a SU ruta de Python.
        await using var python = await StartPython(200, GeometryPayloads.SplitSquareResponse());
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();

        await client.PostAsync("/api/v2/geometry/boolean", Json(GeometryPayloads.Request()));

        Assert.Equal("/api/v1/geometry/boolean", Assert.Single(python.Paths));
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
