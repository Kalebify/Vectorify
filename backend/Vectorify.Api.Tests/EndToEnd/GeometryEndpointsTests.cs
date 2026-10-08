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
/// Pruebas de integración HTTP de POST /api/v2/geometry/boolean (M3-S04): levantan la Web API real
/// (WebApplicationFactory) contra un motor Python simulado (FakePythonGeometryServer, sin cálculo geométrico real: eso
/// lo cubre services/python-engine/tests con Shapely). Cubren el contrato completo, que una petición inválida NUNCA
/// llega a Python (el servidor falso cuenta las llamadas) y el mapeo de cada falla de Python a un ApiErrorResponse.
/// </summary>
public sealed class GeometryEndpointsTests : IDisposable
{
    private const string Url = "/api/v2/geometry/boolean";

    private readonly string _storageRoot = Path.Combine(Path.GetTempPath(), "vectorify-geometry-tests-" + Guid.NewGuid().ToString("n"));
    private readonly string _projectRegistryRoot = Path.Combine(Path.GetTempPath(), "vectorify-geometry-tests-registry-" + Guid.NewGuid().ToString("n"));

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

    private static Task<FakePythonGeometryServer> StartPython(int status = 200, string? body = null, TimeSpan? delay = null) =>
        FakePythonGeometryServer.StartAsync(_ => (status, body ?? GeometryPayloads.SplitSquareResponse()), delay);

    [Fact]
    public async Task Post_WhenRequestIsValid_ReturnsThePiecesFromPythonInCamelCase()
    {
        await using var python = await StartPython();
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();

        var response = await client.PostAsync(Url, Json(GeometryPayloads.Request()));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<GeometryBooleanResponse>();
        Assert.NotNull(body);
        Assert.Equal("difference", body!.Operation);
        Assert.Equal("per_subject", body.Scope);
        Assert.Equal(0.01, body.Tolerance);
        Assert.Equal(2, body.PieceCount);
        var item = Assert.Single(body.Results);
        Assert.Equal(0, item.SubjectIndex);
        Assert.True(item.Changed);
        Assert.Equal(2, item.Geometries.Count);
        Assert.Equal(15, item.Geometries[0].Coordinates[0][2][1].GetDouble());
        Assert.Equal(1, python.RequestCount);

        using var raw = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Assert.True(raw.RootElement.TryGetProperty("pieceCount", out _));
        Assert.True(raw.RootElement.GetProperty("results")[0].TryGetProperty("subjectIndex", out _));
    }

    [Fact]
    public async Task Post_ForwardsTheValidatedRequestToPythonWithTheDocumentedBody()
    {
        await using var python = await StartPython();
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();

        await client.PostAsync(Url, Json(GeometryPayloads.Request(operation: "Difference")));

        using var forwarded = JsonDocument.Parse(Assert.Single(python.Bodies));
        Assert.Equal("difference", forwarded.RootElement.GetProperty("operation").GetString());
        Assert.Equal("bufferedLine", forwarded.RootElement.GetProperty("operands")[0].GetProperty("type").GetString());
        Assert.Equal(5, forwarded.RootElement.GetProperty("operands")[0].GetProperty("radius").GetDouble());
        Assert.Equal(0.01, forwarded.RootElement.GetProperty("tolerance").GetDouble());
    }

    [Fact]
    public async Task Post_IsDeterministic_SameBytesAcrossRepeatedRequests_AndAlwaysCallsPythonAgain()
    {
        await using var python = await StartPython();
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();

        var first = await (await client.PostAsync(Url, Json(GeometryPayloads.Request()))).Content.ReadAsStringAsync();
        var second = await (await client.PostAsync(Url, Json(GeometryPayloads.Request()))).Content.ReadAsStringAsync();

        Assert.Equal(first, second);
        Assert.Equal(2, python.RequestCount);
    }

    [Theory]
    [InlineData("""{"operation":"buffer","subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"tolerance":0.01}""", "unknown_operation")]
    [InlineData("""{"operation":"union","subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"tolerance":0}""", "invalid_tolerance")]
    [InlineData("""{"operation":"union","subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"tolerance":-1}""", "invalid_tolerance")]
    [InlineData("""{"operation":"union","subjects":[{"type":"line","coordinates":[[0,0],[null,1]]}],"tolerance":0.01}""", "invalid_coordinates")]
    [InlineData("""{"operation":"union","subjects":[{"type":"line","coordinates":[[0,0],["NaN",1]]}],"tolerance":0.01}""", "invalid_coordinates")]
    [InlineData("""{"operation":"union","subjects":[{"type":"line","coordinates":[[0,0],[1e999,1]]}],"tolerance":0.01}""", "invalid_coordinates")]
    [InlineData("""{"operation":"union","subjects":[],"tolerance":0.01}""", "invalid_parameters")]
    [InlineData("""{"operation":"union","tolerance":0.01}""", "invalid_parameters")]
    [InlineData("""{"operation":"intersection","subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"tolerance":0.01}""", "invalid_parameters")]
    [InlineData("""{"operation":"union","subjects":[{"type":"line","coordinates":[[0,0]]}],"tolerance":0.01}""", "invalid_parameters")]
    [InlineData("""{"operation":"difference","subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"operands":[{"type":"bufferedLine","points":[[0,0]],"radius":0}],"tolerance":0.01}""", "invalid_coordinates")]
    [InlineData("null", "invalid_parameters")]
    [InlineData("{ esto no es json", "invalid_parameters")]
    [InlineData("", "invalid_parameters")]
    [InlineData("""{"operation":"union","subjects":"abc","tolerance":0.01}""", "invalid_parameters")]
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

    [Fact]
    public async Task Post_WhenSubjectsExceedTheConfiguredMaximum_Returns400AndNeverCallsPython()
    {
        await using var python = await StartPython();
        await using var factory = CreateFactory(python.BaseUrl, new() { ["Geometry:MaxSubjects"] = "2" });
        var client = factory.CreateClient();
        var subjects = string.Join(",", Enumerable.Repeat(GeometryPayloads.Square40, 3));

        var response = await client.PostAsync(Url, Json($$"""{"operation":"normalize","subjects":[{{subjects}}],"tolerance":0.01}"""));

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

        var response = await client.PostAsync(Url, Json(GeometryPayloads.Request())); // 4 + 2 vértices

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("too_many_vertices", (await response.Content.ReadFromJsonAsync<ApiErrorResponse>())!.Code);
        Assert.Equal(0, python.RequestCount);
    }

    [Fact]
    public async Task Post_WhenTheBodyExceedsTheMaximumSize_Returns413AndNeverCallsPython()
    {
        await using var python = await StartPython();
        await using var factory = CreateFactory(python.BaseUrl, new() { ["Geometry:MaxRequestBodyBytes"] = "100" });
        var client = factory.CreateClient();

        var response = await client.PostAsync(Url, Json(GeometryPayloads.Request()));

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

        var response = await client.PostAsync(Url, new StringContent(GeometryPayloads.Request(), Encoding.UTF8, "text/plain"));

        // Lo rechaza el enrutado (Accepts: application/json), sin cuerpo.
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

        var response = await client.PostAsync(Url, Json(GeometryPayloads.Request()));

        Assert.Equal(expectedStatus, response.StatusCode);
        var error = await response.Content.ReadFromJsonAsync<ApiErrorResponse>();
        Assert.Equal(expectedCode, error!.Code);
        Assert.Equal("detalle de Python", error.Message);
    }

    [Fact]
    public async Task Post_WhenPythonReturnsAnInconsistentSuccess_Returns502AndNeverThatGeometry()
    {
        // Anillo sin cerrar: Python respondió 200 pero la geometría no es confiable.
        var broken = GeometryPayloads.Response(
            "difference", "per_subject",
            """[{"subject_index":0,"changed":true,"geometries":[{"type":"polygon","coordinates":[[[0,0],[40,0],[40,15],[0,15]]]}]}]""", 1);
        await using var python = await StartPython(200, broken);
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();

        var response = await client.PostAsync(Url, Json(GeometryPayloads.Request()));

        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
        Assert.Equal("invalid_response", (await response.Content.ReadFromJsonAsync<ApiErrorResponse>())!.Code);
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

        var response = await client.PostAsync(Url, Json(GeometryPayloads.Request()));

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        Assert.Equal("engine_unavailable", (await response.Content.ReadFromJsonAsync<ApiErrorResponse>())!.Code);
    }

    [Fact]
    public async Task Post_WhenPythonIsTooSlow_Returns504Timeout()
    {
        await using var python = await StartPython(delay: TimeSpan.FromSeconds(5));
        await using var factory = CreateFactory(python.BaseUrl, new() { ["Geometry:TimeoutSeconds"] = "1" });
        var client = factory.CreateClient();

        var response = await client.PostAsync(Url, Json(GeometryPayloads.Request()));

        Assert.Equal(HttpStatusCode.GatewayTimeout, response.StatusCode);
        Assert.Equal("timeout", (await response.Content.ReadFromJsonAsync<ApiErrorResponse>())!.Code);
    }

    [Fact]
    public async Task Post_DoesNotNeedADatabaseOrAnAuthenticatedUser()
    {
        // Operación sin estado ni datos del usuario (ADR D4): responde aunque Postgres no esté configurado (el factory no lo configura).
        await using var python = await StartPython(200, GeometryPayloads.SplitSquareResponse(operation: "normalize"));
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();

        var response = await client.PostAsync(Url, Json(GeometryPayloads.Request(operation: "normalize", operands: "")));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
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
