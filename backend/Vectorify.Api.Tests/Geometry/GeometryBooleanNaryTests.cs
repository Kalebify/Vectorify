using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Vectorify.Api.Clients;
using Vectorify.Api.Geometry;
using Vectorify.Api.Options;
using Vectorify.Api.Tests.TestSupport;

namespace Vectorify.Api.Tests.Geometry;

/// <summary>
/// M3-S08: contrato N-ARIO de las booleanas del editor sobre el endpoint de S04 (sin endpoint nuevo). Valida la operación
/// nueva <c>intersection_all</c> (región común a TODAS las formas: necesita >= 2 entre subjects y operands, resultado
/// combinado), que el ORDEN de subjects/operands llega intacto a Python (A es la base de la diferencia: [A] - [B, C, D]) y
/// que el cliente rechaza respuestas con el alcance o la operación equivocados. El cálculo geométrico real (áreas) se
/// prueba en services/python-engine/tests/test_geometry_boolean_nary.py con Shapely.
/// </summary>
public sealed class GeometryBooleanNaryTests
{
    private static string Rect(int x0, int y0, int x1, int y1) =>
        $$"""{"type":"polygon","coordinates":[[[{{x0}},{{y0}}],[{{x1}},{{y0}}],[{{x1}},{{y1}}],[{{x0}},{{y1}}]]]}""";

    private static readonly string A = Rect(0, 0, 20, 20);
    private static readonly string B = Rect(10, 0, 30, 20);
    private static readonly string C = Rect(15, 0, 35, 20);

    private static GeometryRequestValidator CreateValidator(GeometryOptions? options = null) =>
        new(Microsoft.Extensions.Options.Options.Create(options ?? new GeometryOptions()));

    private static string NaryRequest(string operation, string subjects, string operands = "") =>
        $$"""{"operation":"{{operation}}","subjects":[{{subjects}}],"operands":[{{operands}}],"tolerance":0.01}""";

    private static GeometryValidationResult Validate(string json, GeometryOptions? options = null) =>
        CreateValidator(options).Validate(GeometryPayloads.Parse(json));

    private static GeometryBooleanParameters Parameters(string json) => Validate(json).Parameters!;

    // ---- validación ----

    [Theory]
    [InlineData("intersection_all")]
    [InlineData("Intersection_All")]
    [InlineData("  INTERSECTION_ALL ")]
    public void Validate_AcceptsIntersectionAllCaseInsensitively_AndMapsItToItsOwnOperation(string operation)
    {
        var result = Validate(NaryRequest(operation, $"{A},{B}"));

        Assert.True(result.IsValid);
        Assert.Equal(GeometryOperation.IntersectionAll, result.Parameters!.Operation);
        Assert.Equal("intersection_all", result.Parameters.Operation.ToWireName());
        Assert.NotEqual(GeometryOperation.Intersection, result.Parameters.Operation); // la intersección de S04 no se reinterpreta
    }

    [Fact]
    public void Validate_IntersectionAll_AcceptsTwoShapesSplitBetweenSubjectsAndOperandsInAnyWay()
    {
        Assert.True(Validate(NaryRequest("intersection_all", $"{A},{B}")).IsValid); // 2 subjects, 0 operands
        Assert.True(Validate(NaryRequest("intersection_all", A, B)).IsValid); // 1 subject, 1 operand
        Assert.True(Validate(NaryRequest("intersection_all", $"{A},{B},{C}")).IsValid);
        Assert.True(Validate(NaryRequest("intersection_all", A, $"{B},{C}")).IsValid);
    }

    [Fact]
    public void Validate_IntersectionAll_WithASingleShape_ReturnsInvalidParameters()
    {
        // Un solo subject y ningún operando: no hay "región común" que calcular.
        var failed = Validate(NaryRequest("intersection_all", A));

        Assert.False(failed.IsValid);
        Assert.Equal("invalid_parameters", failed.ErrorCode);
        Assert.Null(failed.Parameters);
    }

    [Theory]
    [InlineData("intersect_all")]
    [InlineData("intersection-all")]
    [InlineData("intersectionall")]
    public void Validate_WhenTheOperationIsAMisspelledIntersectionAll_ReturnsUnknownOperation(string operation)
    {
        Assert.Equal("unknown_operation", Validate(NaryRequest(operation, $"{A},{B}")).ErrorCode);
    }

    [Fact]
    public void Validate_PreservesTheOrderOfSubjectsAndOperands()
    {
        // A es la base de la diferencia: el orden NO puede alterarse en ninguna capa (A - B != B - A).
        var parameters = Parameters(NaryRequest("difference", A, $"{B},{C}"));

        Assert.Equal(0.0, ((GeometryShape.Polygon)parameters.Subjects[0]).Rings[0][0][0]);
        Assert.Equal([10.0, 15.0], parameters.Operands.Select(o => ((GeometryShape.Polygon)o).Rings[0][0][0]).ToArray());
    }

    [Fact]
    public void Validate_NaryUnionXorAndIntersectionAllCountVerticesAcrossEveryShape()
    {
        // 3 cuadrados x 4 vértices = 12: el máximo pasa y uno menos del necesario no.
        foreach (var operation in new[] { "union", "xor", "intersection_all" })
        {
            Assert.True(Validate(NaryRequest(operation, $"{A},{B}", C), new GeometryOptions { MaxVertices = 12 }).IsValid, operation);
            Assert.Equal(
                "too_many_vertices",
                Validate(NaryRequest(operation, $"{A},{B}", C), new GeometryOptions { MaxVertices = 11 }).ErrorCode);
        }
    }

    [Fact]
    public void Validate_AllowsUpTo500ShapesInTheNaryOperationsAndRejectsOneMore()
    {
        string Many(int count) => string.Join(",", Enumerable.Repeat(A, count));

        Assert.True(Validate(NaryRequest("xor", Many(500))).IsValid);
        Assert.Equal("too_many_subjects", Validate(NaryRequest("xor", Many(501))).ErrorCode);
        Assert.True(Validate(NaryRequest("intersection_all", A, Many(500))).IsValid);
        Assert.Equal("too_many_operands", Validate(NaryRequest("intersection_all", A, Many(501))).ErrorCode);
    }

    // ---- servicio + cliente ----

    private static PythonGeometryClient CreateClient(Func<HttpRequestMessage, Task<HttpResponseMessage>> handler) =>
        new(
            new HttpClient(new StubHandler(handler)) { BaseAddress = new Uri("http://python-engine.test"), Timeout = TimeSpan.FromSeconds(5) },
            NullLogger<PythonGeometryClient>.Instance);

    private static HttpResponseMessage Json(string body) => new(HttpStatusCode.OK)
    {
        Content = new StringContent(body, Encoding.UTF8, "application/json"),
    };

    private const string CommonPiece = """[{"subject_index":null,"changed":true,"geometries":[{"type":"polygon","coordinates":[[[15,0],[20,0],[20,20],[15,20],[15,0]]]}]}]""";

    [Fact]
    public async Task Client_SendsIntersectionAllWithEveryShapeInOrder_AndAcceptsACombinedResult()
    {
        string? sent = null;
        var client = CreateClient(async request =>
        {
            sent = await request.Content!.ReadAsStringAsync();
            return Json(GeometryPayloads.Response("intersection_all", "combined", CommonPiece, 1));
        });

        var result = await client.BooleanAsync(Parameters(NaryRequest("intersection_all", $"{A},{B}", C)));

        Assert.Equal(PythonGeometryState.Success, result.State);
        var response = result.Response!;
        Assert.Equal("combined", response.Scope);
        Assert.Null(Assert.Single(response.Results).SubjectIndex);
        Assert.Equal(1, response.PieceCount);
        using var document = JsonDocument.Parse(sent!);
        var root = document.RootElement;
        Assert.Equal("intersection_all", root.GetProperty("operation").GetString());
        Assert.Equal(2, root.GetProperty("subjects").GetArrayLength());
        Assert.Equal(0, root.GetProperty("subjects")[0].GetProperty("coordinates")[0][0][0].GetDouble());
        Assert.Equal(10, root.GetProperty("subjects")[1].GetProperty("coordinates")[0][0][0].GetDouble());
        Assert.Equal(15, root.GetProperty("operands")[0].GetProperty("coordinates")[0][0][0].GetDouble());
    }

    [Fact]
    public async Task Client_WhenIntersectionAllComesBackPerSubject_ReturnsInvalidResponse()
    {
        var perSubject = """[{"subject_index":0,"changed":true,"geometries":[]},{"subject_index":1,"changed":true,"geometries":[]}]""";
        var client = CreateClient(_ => Task.FromResult(Json(GeometryPayloads.Response("intersection_all", "per_subject", perSubject, 0))));

        var result = await client.BooleanAsync(Parameters(NaryRequest("intersection_all", $"{A},{B}")));

        Assert.Equal(PythonGeometryState.InvalidResponse, result.State);
        Assert.Null(result.Response);
    }

    [Fact]
    public async Task Client_WhenIntersectionAllIsAnsweredAsPlainIntersection_ReturnsInvalidResponse()
    {
        // La operación que vuelve debe ser la que se pidió: "intersection" (por subject) NO es "intersection_all".
        var client = CreateClient(_ => Task.FromResult(Json(GeometryPayloads.Response("intersection", "combined", CommonPiece, 1))));

        Assert.Equal(PythonGeometryState.InvalidResponse, (await client.BooleanAsync(Parameters(NaryRequest("intersection_all", $"{A},{B}")))).State);
    }

    [Fact]
    public async Task Client_WhenACombinedIntersectionAllResultCarriesASubjectIndex_ReturnsInvalidResponse()
    {
        var withIndex = """[{"subject_index":0,"changed":true,"geometries":[]}]""";
        var client = CreateClient(_ => Task.FromResult(Json(GeometryPayloads.Response("intersection_all", "combined", withIndex, 0))));

        Assert.Equal(PythonGeometryState.InvalidResponse, (await client.BooleanAsync(Parameters(NaryRequest("intersection_all", $"{A},{B}")))).State);
    }

    [Fact]
    public async Task Client_AcceptsAnEmptyIntersectionAllResult_SoTheEditorCanReportAnEmptyResult()
    {
        var empty = """[{"subject_index":null,"changed":true,"geometries":[]}]""";
        var client = CreateClient(_ => Task.FromResult(Json(GeometryPayloads.Response("intersection_all", "combined", empty, 0))));

        var result = await client.BooleanAsync(Parameters(NaryRequest("intersection_all", $"{A},{B}")));

        Assert.Equal(PythonGeometryState.Success, result.State);
        Assert.Empty(Assert.Single(result.Response!.Results).Geometries);
    }

    [Fact]
    public async Task Client_NaryDifference_SendsTheBaseAsSubjectAndEveryOtherShapeAsOperandInOrder()
    {
        string? sent = null;
        var client = CreateClient(async request =>
        {
            sent = await request.Content!.ReadAsStringAsync();
            return Json(GeometryPayloads.Response(
                "difference", "per_subject", """[{"subject_index":0,"changed":false,"geometries":[{"type":"polygon","coordinates":[[[0,0],[20,0],[20,20],[0,20],[0,0]]]}]}]""", 1));
        });

        var result = await client.BooleanAsync(Parameters(NaryRequest("difference", A, $"{B},{C}")));

        Assert.Equal(PythonGeometryState.Success, result.State);
        Assert.False(Assert.Single(result.Response!.Results).Changed); // `changed: false` llega intacto (el editor conserva `d`)
        using var document = JsonDocument.Parse(sent!);
        Assert.Equal(1, document.RootElement.GetProperty("subjects").GetArrayLength());
        Assert.Equal(
            [10.0, 15.0],
            document.RootElement.GetProperty("operands").EnumerateArray().Select(o => o.GetProperty("coordinates")[0][0][0].GetDouble()).ToArray());
    }

    [Theory]
    [InlineData("union")]
    [InlineData("xor")]
    public async Task Client_NaryUnionAndXor_ReturnASingleCombinedResultForThreeShapes(string operation)
    {
        var client = CreateClient(_ => Task.FromResult(Json(GeometryPayloads.Response(operation, "combined", CommonPiece, 1))));

        var result = await client.BooleanAsync(Parameters(NaryRequest(operation, $"{A},{B}", C)));

        Assert.Equal(PythonGeometryState.Success, result.State);
        Assert.Single(result.Response!.Results);
    }

    [Fact]
    public async Task Service_IntersectionAllWithASingleShape_NeverReachesPython()
    {
        var calls = 0;
        var client = CreateClient(_ =>
        {
            calls++;
            return Task.FromResult(Json(GeometryPayloads.Response("intersection_all", "combined", CommonPiece, 1)));
        });
        var service = new GeometryService(CreateValidator(), client, NullLogger<GeometryService>.Instance);

        var rejected = await service.BooleanAsync(GeometryPayloads.Parse(NaryRequest("intersection_all", A)), CancellationToken.None);
        var accepted = await service.BooleanAsync(GeometryPayloads.Parse(NaryRequest("intersection_all", $"{A},{B}")), CancellationToken.None);

        Assert.Equal("invalid_parameters", Assert.IsType<GeometryBooleanResult.ValidationFailed>(rejected).Code);
        Assert.IsType<GeometryBooleanResult.Ready>(accepted);
        Assert.Equal(1, calls); // sólo la petición válida llegó al motor
    }

    private sealed class StubHandler(Func<HttpRequestMessage, Task<HttpResponseMessage>> handler) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) => handler(request);
    }
}
