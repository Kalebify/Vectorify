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
/// M3-S08: POST /api/v2/geometry/boolean con las operaciones n-arias del editor (union / xor / intersection_all de 3+
/// formas y diferencia A - (B, C, D)) contra el motor Python simulado. Comprueban lo que le toca a ASP.NET Core: que el
/// orden y la cantidad de formas llegan intactos a Python, que el alcance combinado/por subject vuelve bien, que la
/// geometría vacía es una respuesta válida (el editor la informa) y que una petición inválida NUNCA llega al motor.
/// </summary>
public sealed class GeometryBooleanNaryEndpointTests : IDisposable
{
    private const string Url = "/api/v2/geometry/boolean";

    private readonly string _storageRoot = Path.Combine(Path.GetTempPath(), "vectorify-geometry-nary-" + Guid.NewGuid().ToString("n"));
    private readonly string _projectRegistryRoot = Path.Combine(Path.GetTempPath(), "vectorify-geometry-nary-registry-" + Guid.NewGuid().ToString("n"));

    private static string Rect(int x0, int x1) =>
        $$"""{"type":"polygon","coordinates":[[[{{x0}},0],[{{x1}},0],[{{x1}},20],[{{x0}},20]]]}""";

    private static string Body(string operation, string subjects, string operands = "") =>
        $$"""{"operation":"{{operation}}","subjects":[{{subjects}}],"operands":[{{operands}}],"tolerance":0.01}""";

    private static StringContent Json(string body) => new(body, Encoding.UTF8, "application/json");

    private WebApplicationFactory<Program> CreateFactory(string pythonBaseUrl) =>
        new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
            builder.ConfigureAppConfiguration((_, config) => config.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["PythonEngine:BaseUrl"] = pythonBaseUrl,
                ["Cors:AllowedOrigins"] = "http://localhost:5173",
                ["Storage:RootPath"] = _storageRoot,
                ["ProjectRegistry:RootPath"] = _projectRegistryRoot,
            })));

    private const string CommonPiece =
        """[{"subject_index":null,"changed":true,"geometries":[{"type":"polygon","coordinates":[[[15,0],[20,0],[20,20],[15,20],[15,0]]]}]}]""";

    [Theory]
    [InlineData("union")]
    [InlineData("xor")]
    [InlineData("intersection_all")]
    public async Task Post_NaryCombinedOperations_ForwardEveryShapeInOrderAndReturnASingleCombinedResult(string operation)
    {
        await using var python = await FakePythonGeometryServer.StartAsync(_ => (200, GeometryPayloads.Response(operation, "combined", CommonPiece, 1)));
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();

        var response = await client.PostAsync(Url, Json(Body(operation, $"{Rect(0, 20)},{Rect(10, 30)}", Rect(15, 35))));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<GeometryBooleanResponse>();
        Assert.Equal(operation, body!.Operation);
        Assert.Equal("combined", body.Scope);
        Assert.Null(Assert.Single(body.Results).SubjectIndex);
        using var forwarded = JsonDocument.Parse(Assert.Single(python.Bodies));
        Assert.Equal(operation, forwarded.RootElement.GetProperty("operation").GetString());
        var xs = forwarded.RootElement.GetProperty("subjects").EnumerateArray()
            .Concat(forwarded.RootElement.GetProperty("operands").EnumerateArray())
            .Select(shape => shape.GetProperty("coordinates")[0][0][0].GetDouble())
            .ToArray();
        Assert.Equal([0.0, 10.0, 15.0], xs); // el orden A, B, C sale tal cual
    }

    [Fact]
    public async Task Post_IntersectionAll_WithAnEmptyResult_Returns200WithNoPieces()
    {
        var empty = """[{"subject_index":null,"changed":true,"geometries":[]}]""";
        await using var python = await FakePythonGeometryServer.StartAsync(_ => (200, GeometryPayloads.Response("intersection_all", "combined", empty, 0)));
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();

        var response = await client.PostAsync(Url, Json(Body("intersection_all", $"{Rect(0, 10)},{Rect(50, 60)}")));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<GeometryBooleanResponse>();
        Assert.Equal(0, body!.PieceCount);
        Assert.Empty(Assert.Single(body.Results).Geometries);
    }

    [Fact]
    public async Task Post_NaryDifference_ForwardsTheBaseAsSubjectAndTheRestAsOperandsInOrder()
    {
        var response200 = GeometryPayloads.Response(
            "difference", "per_subject", """[{"subject_index":0,"changed":true,"geometries":[{"type":"polygon","coordinates":[[[0,0],[10,0],[10,20],[0,20],[0,0]]]}]}]""", 1);
        await using var python = await FakePythonGeometryServer.StartAsync(_ => (200, response200));
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();

        var response = await client.PostAsync(Url, Json(Body("difference", Rect(0, 20), $"{Rect(10, 30)},{Rect(15, 35)}")));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("per_subject", (await response.Content.ReadFromJsonAsync<GeometryBooleanResponse>())!.Scope);
        using var forwarded = JsonDocument.Parse(Assert.Single(python.Bodies));
        Assert.Equal(1, forwarded.RootElement.GetProperty("subjects").GetArrayLength());
        Assert.Equal(2, forwarded.RootElement.GetProperty("operands").GetArrayLength());
        Assert.Equal(10, forwarded.RootElement.GetProperty("operands")[0].GetProperty("coordinates")[0][0][0].GetDouble());
        Assert.Equal(15, forwarded.RootElement.GetProperty("operands")[1].GetProperty("coordinates")[0][0][0].GetDouble());
    }

    [Theory]
    [InlineData("intersection_all", "single", "invalid_parameters")]
    [InlineData("intersect_all", "pair", "unknown_operation")]
    public async Task Post_WhenTheNaryRequestIsInvalid_Returns400AndNeverCallsPython(string operation, string shape, string expectedCode)
    {
        await using var python = await FakePythonGeometryServer.StartAsync(_ => (200, GeometryPayloads.Response("intersection_all", "combined", CommonPiece, 1)));
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();
        var subjects = shape == "single" ? Rect(0, 20) : $"{Rect(0, 20)},{Rect(10, 30)}";

        var response = await client.PostAsync(Url, Json(Body(operation, subjects)));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var error = await response.Content.ReadFromJsonAsync<ApiErrorResponse>();
        Assert.Equal(expectedCode, error!.Code);
        Assert.Equal(0, python.RequestCount);
    }

    [Fact]
    public async Task Post_WhenPythonAnswersIntersectionAllWithTheWrongScope_Returns502()
    {
        var wrong = """[{"subject_index":0,"changed":true,"geometries":[]},{"subject_index":1,"changed":true,"geometries":[]}]""";
        await using var python = await FakePythonGeometryServer.StartAsync(_ => (200, GeometryPayloads.Response("intersection_all", "per_subject", wrong, 0)));
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();

        var response = await client.PostAsync(Url, Json(Body("intersection_all", $"{Rect(0, 20)},{Rect(10, 30)}")));

        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
        Assert.Equal("invalid_response", (await response.Content.ReadFromJsonAsync<ApiErrorResponse>())!.Code);
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
