using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Vectorify.Api.Clients;
using Vectorify.Api.Geometry;
using Vectorify.Api.Tests.TestSupport;

namespace Vectorify.Api.Tests.Clients;

/// <summary>
/// Pruebas unitarias de PythonGeometryClient.OffsetAsync (M3-S09) contra un HttpMessageHandler stub (sin red real): forma EXACTA del
/// cuerpo que se le manda a Python, todos los estados de error, y la validación defensiva sobre respuestas 200 sospechosas
/// (parámetros distintos de los pedidos, NaN, anillo abierto, colapso que no coincide con las piezas, conteo de huecos inventado,
/// offset interior máximo en una línea...): ninguna excepción escapa y la geometría dudosa NUNCA se devuelve.
/// </summary>
public sealed class PythonGeometryOffsetClientTests
{
    private const string GrownSquare = """[{"type":"polygon","coordinates":[[[-3,-3],[43,-3],[43,43],[-3,43],[-3,-3]]]}]""";

    private static PythonGeometryClient CreateClient(
        Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> handlerFunc, TimeSpan? timeout = null)
    {
        var httpClient = new HttpClient(new StubHttpMessageHandler(handlerFunc))
        {
            BaseAddress = new Uri("http://python-engine.test"),
            Timeout = timeout ?? TimeSpan.FromSeconds(5),
        };

        return new PythonGeometryClient(httpClient, NullLogger<PythonGeometryClient>.Instance);
    }

    private static GeometryOffsetParameters Parameters(string? json = null)
    {
        var validator = new GeometryRequestValidator(Microsoft.Extensions.Options.Options.Create(new Options.GeometryOptions()));
        return validator.ValidateOffset(GeometryPayloads.ParseOffset(json ?? GeometryPayloads.OffsetRequest())).OffsetParameters!;
    }

    private static Task<PythonGeometryOffsetResult> Invoke(PythonGeometryClient client, GeometryOffsetParameters? parameters = null) =>
        client.OffsetAsync(parameters ?? Parameters());

    private static PythonGeometryClient Responding(string body, HttpStatusCode status = HttpStatusCode.OK) =>
        CreateClient((_, _) => Task.FromResult(JsonResponse(status, body)));

    private static string Single(string geometries = GrownSquare, int pieceCount = 1, bool? collapsed = null, int piecesBefore = 1, int? splitCount = null,
        int lostPieces = 0, int holesBefore = 0, int holesAfter = 0, string maxInward = "20", double distance = 3) =>
        GeometryPayloads.OffsetResponse(
            GeometryPayloads.OffsetResult(0, geometries, collapsed, piecesBefore, splitCount, lostPieces, holesBefore, holesAfter, maxInward), pieceCount, distance);

    [Fact]
    public async Task OffsetAsync_WhenResponseIsValid_ReturnsSuccessWithEveryField()
    {
        var client = Responding(Single(holesBefore: 0, holesAfter: 0));

        var result = await Invoke(client);

        Assert.Equal(PythonGeometryState.Success, result.State);
        var response = result.Response!;
        Assert.Equal(3, response.Distance);
        Assert.Equal("mitre", response.JoinStyle);
        Assert.Equal(2, response.MitreLimit);
        Assert.Equal("round", response.CapStyle);
        Assert.Equal(0.01, response.Tolerance);
        Assert.Equal(1, response.PieceCount);
        var item = Assert.Single(response.Results);
        Assert.Equal(0, item.SubjectIndex);
        Assert.False(item.Collapsed);
        Assert.Equal((1, 1, 0, 0, 0), (item.PiecesBefore, item.SplitCount, item.LostPieces, item.HolesBefore, item.HolesAfter));
        Assert.Equal(20, item.MaxInwardOffset);
        var piece = Assert.Single(item.Geometries);
        Assert.Equal("polygon", piece.Type);
        Assert.Equal(-3, piece.Coordinates[0][0][0].GetDouble());
    }

    [Fact]
    public async Task OffsetAsync_SendsThePostToTheOffsetRouteWithTheExactSnakeCaseBody()
    {
        HttpRequestMessage? captured = null;
        string? body = null;
        var client = CreateClient(async (request, _) =>
        {
            captured = request;
            body = await request.Content!.ReadAsStringAsync();
            return JsonResponse(HttpStatusCode.OK, Single());
        });

        await Invoke(client, Parameters(GeometryPayloads.OffsetRequest(distance: "-1.5", joinStyle: "bevel", mitreLimit: "4", capStyle: "flat", tolerance: "0.02")));

        Assert.Equal(HttpMethod.Post, captured!.Method);
        Assert.Equal("/api/v1/geometry/offset", captured.RequestUri!.AbsolutePath);
        Assert.Equal("application/json", captured.Content!.Headers.ContentType!.MediaType);
        using var document = JsonDocument.Parse(body!);
        var root = document.RootElement;
        Assert.Equal(-1.5, root.GetProperty("distance").GetDouble());
        Assert.Equal("bevel", root.GetProperty("join_style").GetString());
        Assert.Equal(4, root.GetProperty("mitre_limit").GetDouble());
        Assert.Equal("flat", root.GetProperty("cap_style").GetString());
        Assert.Equal(0.02, root.GetProperty("tolerance").GetDouble());
        var subject = root.GetProperty("subjects")[0];
        Assert.Equal("polygon", subject.GetProperty("type").GetString());
        Assert.Equal(40, subject.GetProperty("coordinates")[0][1][0].GetDouble());
        Assert.False(subject.TryGetProperty("points", out _));
        Assert.False(root.TryGetProperty("operation", out _));
        Assert.False(root.TryGetProperty("operands", out _));
    }

    [Fact]
    public async Task OffsetAsync_ForALine_SendsAPolylineAndAcceptsANullMaxInwardOffset()
    {
        string? body = null;
        var client = CreateClient(async (request, _) =>
        {
            body = await request.Content!.ReadAsStringAsync();
            return JsonResponse(HttpStatusCode.OK, Single(maxInward: "null", distance: 1));
        });

        var result = await Invoke(client, Parameters(GeometryPayloads.OffsetRequest(subjects: GeometryPayloads.Line, distance: "1")));

        Assert.Equal(PythonGeometryState.Success, result.State);
        Assert.Null(Assert.Single(result.Response!.Results).MaxInwardOffset);
        using var document = JsonDocument.Parse(body!);
        Assert.Equal("line", document.RootElement.GetProperty("subjects")[0].GetProperty("type").GetString());
    }

    [Fact]
    public async Task OffsetAsync_AcceptsACollapsedResultWithItsExplanation()
    {
        var client = Responding(GeometryPayloads.OffsetResponse(GeometryPayloads.OffsetResult(0, "[]", lostPieces: 1), pieceCount: 0, distance: 3));

        var result = await Invoke(client);

        Assert.Equal(PythonGeometryState.Success, result.State);
        var item = Assert.Single(result.Response!.Results);
        Assert.True(item.Collapsed);
        Assert.Empty(item.Geometries);
        Assert.Equal(1, item.LostPieces);
        Assert.Equal(0, item.SplitCount);
        Assert.Equal(20, item.MaxInwardOffset);
    }

    [Fact]
    public async Task OffsetAsync_ReportsAHoleThatGotClosedAndASplit()
    {
        const string twoPieces =
            """[{"type":"polygon","coordinates":[[[3,3],[17,3],[17,17],[3,17],[3,3]]]},{"type":"polygon","coordinates":[[[33,3],[47,3],[47,17],[33,17],[33,3]],[[36,6],[38,6],[38,8],[36,6]]]}]""";
        var client = Responding(Single(twoPieces, pieceCount: 2, holesBefore: 2, holesAfter: 1));

        var result = await Invoke(client);

        var item = Assert.Single(result.Response!.Results);
        Assert.Equal(PythonGeometryState.Success, result.State);
        Assert.Equal(2, item.SplitCount);
        Assert.Equal((2, 1), (item.HolesBefore, item.HolesAfter));
    }

    [Theory]
    [InlineData(HttpStatusCode.UnprocessableEntity, "invalid_parameters", PythonGeometryState.InvalidParameters)]
    [InlineData(HttpStatusCode.UnprocessableEntity, "too_many_geometry_subjects", PythonGeometryState.InvalidParameters)]
    [InlineData(HttpStatusCode.UnprocessableEntity, "too_many_geometry_vertices", PythonGeometryState.InvalidParameters)]
    [InlineData(HttpStatusCode.RequestEntityTooLarge, "geometry_request_too_large", PythonGeometryState.TooLarge)]
    [InlineData(HttpStatusCode.GatewayTimeout, "geometry_timeout", PythonGeometryState.Timeout)]
    [InlineData(HttpStatusCode.InternalServerError, "geometry_result_invalid", PythonGeometryState.EngineError)]
    [InlineData(HttpStatusCode.UnprocessableEntity, "algo_nuevo", PythonGeometryState.InvalidParameters)]
    [InlineData(HttpStatusCode.BadGateway, "algo_nuevo", PythonGeometryState.EngineError)]
    public async Task OffsetAsync_MapsPythonErrorsToTypedStatesWithoutReturningGeometry(HttpStatusCode status, string code, PythonGeometryState expected)
    {
        var client = Responding(GeometryPayloads.ErrorBody(code, "detalle"), status);

        var result = await Invoke(client);

        Assert.Equal(expected, result.State);
        Assert.Null(result.Response);
        Assert.Equal("detalle", result.Message);
    }

    [Fact]
    public async Task OffsetAsync_WhenThePythonCallTimesOut_ReturnsTimeout()
    {
        var client = CreateClient(
            async (_, cancellationToken) =>
            {
                await Task.Delay(TimeSpan.FromSeconds(5), cancellationToken);
                return JsonResponse(HttpStatusCode.OK, Single());
            },
            timeout: TimeSpan.FromMilliseconds(50));

        var result = await Invoke(client);

        Assert.Equal(PythonGeometryState.Timeout, result.State);
        Assert.Null(result.Response);
        Assert.Contains("el offset de geometría", result.Message);
    }

    [Fact]
    public async Task OffsetAsync_WhenTheCallerCancels_PropagatesTheCancellationInsteadOfReportingATimeout()
    {
        using var cts = new CancellationTokenSource();
        var client = CreateClient(async (_, cancellationToken) =>
        {
            await cts.CancelAsync();
            await Task.Delay(TimeSpan.FromSeconds(5), cancellationToken);
            return JsonResponse(HttpStatusCode.OK, Single());
        });

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => client.OffsetAsync(Parameters(), cts.Token));
    }

    [Fact]
    public async Task OffsetAsync_WhenPythonIsUnavailable_ReturnsUnavailable()
    {
        var client = CreateClient((_, _) => throw new HttpRequestException("connection refused"));

        var result = await Invoke(client);

        Assert.Equal(PythonGeometryState.Unavailable, result.State);
        Assert.Null(result.Response);
    }

    [Theory]
    [InlineData("esto no es JSON")]
    [InlineData("")]
    [InlineData("{}")]
    [InlineData("null")]
    [InlineData("""{"distance":3,"join_style":"mitre","mitre_limit":2,"cap_style":"round","tolerance":0.01}""")]
    public async Task OffsetAsync_WhenTheBodyIsNotValidOrIncomplete_ReturnsInvalidResponse(string body)
    {
        var result = await Invoke(Responding(body));

        Assert.Equal(PythonGeometryState.InvalidResponse, result.State);
        Assert.Null(result.Response);
    }

    [Theory]
    [InlineData(2.5, "mitre", 2.0, "round")] // otra distancia
    [InlineData(3.0, "round", 2.0, "round")] // otro join
    [InlineData(3.0, "mitre", 5.0, "round")] // otro límite de inglete
    [InlineData(3.0, "mitre", 2.0, "flat")] // otro cap
    public async Task OffsetAsync_WhenPythonEchoesDifferentParameters_ReturnsInvalidResponse(double distance, string join, double mitre, string cap)
    {
        var body = GeometryPayloads.OffsetResponse(GeometryPayloads.OffsetResult(0, GrownSquare), 1, distance, join, mitre, cap);

        Assert.Equal(PythonGeometryState.InvalidResponse, (await Invoke(Responding(body))).State);
    }

    [Fact]
    public async Task OffsetAsync_WhenThePieceCountDoesNotMatch_ReturnsInvalidResponse()
    {
        Assert.Equal(PythonGeometryState.InvalidResponse, (await Invoke(Responding(Single(pieceCount: 3)))).State);
    }

    [Fact]
    public async Task OffsetAsync_WhenThereIsNotOneResultPerSubject_ReturnsInvalidResponse()
    {
        var body = GeometryPayloads.OffsetResponse(string.Empty, 0);

        Assert.Equal(PythonGeometryState.InvalidResponse, (await Invoke(Responding(body))).State);
    }

    [Fact]
    public async Task OffsetAsync_WhenTheSubjectIndexDoesNotMatchThePosition_ReturnsInvalidResponse()
    {
        var body = GeometryPayloads.OffsetResponse(GeometryPayloads.OffsetResult(3, GrownSquare), 1);

        Assert.Equal(PythonGeometryState.InvalidResponse, (await Invoke(Responding(body))).State);
    }

    [Fact]
    public async Task OffsetAsync_WhenCollapsedDisagreesWithThePieces_ReturnsInvalidResponse()
    {
        // Dice que colapsó pero trae una pieza -- y al revés: no hay piezas pero dice que no colapsó.
        Assert.Equal(PythonGeometryState.InvalidResponse, (await Invoke(Responding(Single(collapsed: true)))).State);
        var empty = GeometryPayloads.OffsetResponse(GeometryPayloads.OffsetResult(0, "[]", collapsed: false), 0);
        Assert.Equal(PythonGeometryState.InvalidResponse, (await Invoke(Responding(empty))).State);
    }

    [Fact]
    public async Task OffsetAsync_WhenSplitCountDisagreesWithThePieces_ReturnsInvalidResponse()
    {
        Assert.Equal(PythonGeometryState.InvalidResponse, (await Invoke(Responding(Single(splitCount: 2)))).State);
    }

    [Fact]
    public async Task OffsetAsync_WhenHolesAfterDisagreesWithTheGeometry_ReturnsInvalidResponse()
    {
        Assert.Equal(PythonGeometryState.InvalidResponse, (await Invoke(Responding(Single(holesAfter: 1)))).State);
    }

    [Theory]
    [InlineData(-1, 0, 0)] // piezas previas negativas
    [InlineData(1, 2, 0)] // más piezas perdidas que piezas previas
    [InlineData(1, -1, 0)] // piezas perdidas negativas
    [InlineData(1, 0, -1)] // huecos previos negativos
    public async Task OffsetAsync_WhenTheCountsAreIncoherent_ReturnsInvalidResponse(int piecesBefore, int lostPieces, int holesBefore)
    {
        var body = Single(piecesBefore: piecesBefore, lostPieces: lostPieces, holesBefore: holesBefore);

        Assert.Equal(PythonGeometryState.InvalidResponse, (await Invoke(Responding(body))).State);
    }

    [Theory]
    [InlineData("null")] // un polígono siempre informa el offset interior máximo
    [InlineData("-1")]
    public async Task OffsetAsync_WhenAPolygonHasNoValidMaxInwardOffset_ReturnsInvalidResponse(string maxInward)
    {
        Assert.Equal(PythonGeometryState.InvalidResponse, (await Invoke(Responding(Single(maxInward: maxInward)))).State);
    }

    [Fact]
    public async Task OffsetAsync_WhenALineCarriesAMaxInwardOffset_ReturnsInvalidResponse()
    {
        var parameters = Parameters(GeometryPayloads.OffsetRequest(subjects: GeometryPayloads.Line, distance: "1"));

        Assert.Equal(PythonGeometryState.InvalidResponse, (await Invoke(Responding(Single(maxInward: "5", distance: 1)), parameters)).State);
    }

    [Theory]
    [InlineData("""{"type":"polygon","coordinates":[[[0,0],[40,0],[40,15],[0,15]]]}""")] // anillo sin cerrar
    [InlineData("""{"type":"polygon","coordinates":[[[0,0],[40,0],[0,0]]]}""")] // menos de 4 vértices
    [InlineData("""{"type":"polygon","coordinates":[]}""")] // sin anillos
    [InlineData("""{"type":"polygon","coordinates":[[[0,0],[40,0],[40,"x"],[0,0]]]}""")] // vértice no numérico
    [InlineData("""{"type":"circle","coordinates":[[0,0],[1,1]]}""")]
    [InlineData("""{"type":"polygon"}""")]
    public async Task OffsetAsync_WhenAPieceIsMalformed_ReturnsInvalidResponseAndNeverTheGeometry(string piece)
    {
        var result = await Invoke(Responding(Single($"[{piece}]")));

        Assert.Equal(PythonGeometryState.InvalidResponse, result.State);
        Assert.Null(result.Response);
    }

    [Fact]
    public async Task OffsetAsync_WhenPythonReturnsALinePiece_ReturnsInvalidResponse()
    {
        // El offset siempre devuelve polígonos. Los conteos cuadran a propósito (la polilínea de 2 vértices "tiene" 1 hueco) para que el rechazo sea por el tipo de la pieza.
        var body = Single("""[{"type":"line","coordinates":[[0,0],[1,1]]}]""", holesAfter: 1);

        var result = await Invoke(Responding(body));

        Assert.Equal(PythonGeometryState.InvalidResponse, result.State);
        Assert.Contains("solo admite 'polygon'", result.Message);
    }

    [Fact]
    public async Task OffsetAsync_WhenTheToleranceIsNotPositive_ReturnsInvalidResponse()
    {
        var body = GeometryPayloads.OffsetResponse(GeometryPayloads.OffsetResult(0, GrownSquare), 1, tolerance: 0);

        Assert.Equal(PythonGeometryState.InvalidResponse, (await Invoke(Responding(body))).State);
    }

    [Fact]
    public async Task OffsetAsync_ResolvesSeveralSubjectsInOrder()
    {
        var subjects = $"{GeometryPayloads.Square40},{GeometryPayloads.Square40}";
        var results = string.Join(",", GeometryPayloads.OffsetResult(0, GrownSquare), GeometryPayloads.OffsetResult(1, GrownSquare));
        var client = Responding(GeometryPayloads.OffsetResponse(results, 2));

        var result = await Invoke(client, Parameters(GeometryPayloads.OffsetRequest(subjects: subjects)));

        Assert.Equal(PythonGeometryState.Success, result.State);
        Assert.Equal([0, 1], result.Response!.Results.Select(item => item.SubjectIndex));
    }

    private static HttpResponseMessage JsonResponse(HttpStatusCode statusCode, string body) => new(statusCode)
    {
        Content = new StringContent(body, Encoding.UTF8, "application/json"),
    };

    private sealed class StubHttpMessageHandler(
        Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> handlerFunc) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken) => handlerFunc(request, cancellationToken);
    }
}
