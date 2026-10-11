using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Vectorify.Api.Clients;
using Vectorify.Api.Geometry;
using Vectorify.Api.Tests.TestSupport;

namespace Vectorify.Api.Tests.Clients;

/// <summary>
/// Pruebas unitarias de PythonGeometryClient.SplitAsync (M3-S10) contra un HttpMessageHandler stub (sin red real): forma EXACTA del
/// cuerpo que se le manda a Python, todos los estados de error, y la validación defensiva sobre respuestas 200 sospechosas
/// (parámetros distintos de los pedidos, NaN, anillo abierto, "separado" con una sola pieza, "cambió" sin tocar, piece_count inventado,
/// líneas para un polígono...): ninguna excepción escapa y la geometría dudosa NUNCA se devuelve.
/// </summary>
public sealed class PythonGeometrySplitClientTests
{
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

    private static GeometrySplitParameters Parameters(string? json = null)
    {
        var validator = new GeometryRequestValidator(Microsoft.Extensions.Options.Options.Create(new Options.GeometryOptions()));
        return validator.ValidateSplit(GeometryPayloads.ParseSplit(json ?? GeometryPayloads.SplitRequest())).SplitParameters!;
    }

    private static Task<PythonGeometrySplitResult> Invoke(PythonGeometryClient client, GeometrySplitParameters? parameters = null) =>
        client.SplitAsync(parameters ?? Parameters());

    private static PythonGeometryClient Responding(string body, HttpStatusCode status = HttpStatusCode.OK) =>
        CreateClient((_, _) => Task.FromResult(JsonResponse(status, body)));

    private static string Halves(bool? changed = null, bool? touched = null, int? pieceCount = null, int discarded = 0, int total = 2) =>
        GeometryPayloads.SplitResponse(
            GeometryPayloads.SplitResult(0, $"[{GeometryPayloads.LeftHalf},{GeometryPayloads.RightHalf}]", changed, touched, pieceCount, discarded), total);

    [Fact]
    public async Task SplitAsync_WhenResponseIsValid_ReturnsSuccessWithEveryField()
    {
        var result = await Invoke(Responding(GeometryPayloads.HalvesSplitResponse()));

        Assert.Equal(PythonGeometryState.Success, result.State);
        var response = result.Response!;
        Assert.Equal(("split", 0.0, false, 0.01), (response.Mode, response.SlotWidth, response.Extend, response.Tolerance));
        Assert.Equal(2, response.PieceCount);
        var item = Assert.Single(response.Results);
        Assert.Equal((0, true, true, 2, 0), (item.SubjectIndex, item.Changed, item.Touched, item.PieceCount, item.Discarded));
        Assert.Equal(["polygon", "polygon"], item.Pieces.Select(piece => piece.Type));
        Assert.Equal(20, item.Pieces[0].Coordinates[0][1][0].GetDouble());
    }

    [Fact]
    public async Task SplitAsync_SendsThePostToTheSplitRouteWithTheExactSnakeCaseBody()
    {
        HttpRequestMessage? captured = null;
        string? body = null;
        var client = CreateClient(async (request, _) =>
        {
            captured = request;
            body = await request.Content!.ReadAsStringAsync();
            return JsonResponse(HttpStatusCode.OK, GeometryPayloads.SplitResponse(
                GeometryPayloads.SplitResult(0, $"[{GeometryPayloads.LeftHalf},{GeometryPayloads.RightHalf}]"), 2, "slot", 0.4, true, 0.02));
        });

        var result = await Invoke(client, Parameters(GeometryPayloads.SplitRequest(mode: "slot", slotWidth: "0.4", extend: "true", tolerance: "0.02")));

        Assert.Equal(PythonGeometryState.Success, result.State);
        Assert.Equal(HttpMethod.Post, captured!.Method);
        Assert.Equal("/api/v1/geometry/split", captured.RequestUri!.AbsolutePath);
        Assert.Equal("application/json", captured.Content!.Headers.ContentType!.MediaType);
        using var document = JsonDocument.Parse(body!);
        var root = document.RootElement;
        Assert.Equal("slot", root.GetProperty("mode").GetString());
        Assert.Equal(0.4, root.GetProperty("slot_width").GetDouble());
        Assert.True(root.GetProperty("extend").GetBoolean());
        Assert.Equal(0.02, root.GetProperty("tolerance").GetDouble());
        var points = root.GetProperty("cutter").GetProperty("points");
        Assert.Equal(2, points.GetArrayLength());
        Assert.Equal([20.0, -5.0], points[0].EnumerateArray().Select(value => value.GetDouble()));
        Assert.Equal([20.0, 45.0], points[1].EnumerateArray().Select(value => value.GetDouble()));
        var subject = root.GetProperty("subjects")[0];
        Assert.Equal("polygon", subject.GetProperty("type").GetString());
        Assert.Equal(40, subject.GetProperty("coordinates")[0][1][0].GetDouble());
        Assert.False(root.TryGetProperty("operation", out _));
        Assert.False(root.TryGetProperty("distance", out _));
    }

    [Fact]
    public async Task SplitAsync_ForALine_SendsAPolylineAndAcceptsLinePieces()
    {
        string? body = null;
        var client = CreateClient(async (request, _) =>
        {
            body = await request.Content!.ReadAsStringAsync();
            return JsonResponse(HttpStatusCode.OK, GeometryPayloads.SplitResponse(
                GeometryPayloads.SplitResult(0, """[{"type":"line","coordinates":[[0,20],[20,20]]},{"type":"line","coordinates":[[20,20],[40,20]]}]"""), 2));
        });

        var result = await Invoke(client, Parameters(GeometryPayloads.SplitRequest(subjects: GeometryPayloads.Line)));

        Assert.Equal(PythonGeometryState.Success, result.State);
        Assert.Equal(["line", "line"], result.Response!.Results[0].Pieces.Select(piece => piece.Type));
        using var document = JsonDocument.Parse(body!);
        Assert.Equal("line", document.RootElement.GetProperty("subjects")[0].GetProperty("type").GetString());
    }

    [Fact]
    public async Task SplitAsync_AcceptsAnUnchangedResultThatKeepsTheSubjectAsItIs()
    {
        // Un corte que toca pero no atraviesa: changed=false, touched=true y la pieza es el subject tal cual.
        var body = GeometryPayloads.SplitResponse(GeometryPayloads.SplitResult(0, $"[{GeometryPayloads.WholeSquare}]", changed: false, touched: true), 1);

        var result = await Invoke(Responding(body));

        var item = Assert.Single(result.Response!.Results);
        Assert.Equal(PythonGeometryState.Success, result.State);
        Assert.Equal((false, true, 1), (item.Changed, item.Touched, item.PieceCount));
    }

    [Fact]
    public async Task SplitAsync_AcceptsAnUntouchedSubjectAndADegenerateOneWithNoPieces()
    {
        var results = string.Join(
            ",",
            GeometryPayloads.SplitResult(0, $"[{GeometryPayloads.WholeSquare}]", changed: false, touched: false),
            GeometryPayloads.SplitResult(1, "[]", changed: false, touched: false));
        var subjects = $"{GeometryPayloads.Square40},{GeometryPayloads.Square40}";

        var result = await Invoke(Responding(GeometryPayloads.SplitResponse(results, 1)), Parameters(GeometryPayloads.SplitRequest(subjects: subjects)));

        Assert.Equal(PythonGeometryState.Success, result.State);
        Assert.Equal([0, 1], result.Response!.Results.Select(item => item.SubjectIndex));
        Assert.Equal([false, false], result.Response.Results.Select(item => item.Touched));
    }

    [Fact]
    public async Task SplitAsync_ReportsDiscardedSliversOfAChangedResult()
    {
        var result = await Invoke(Responding(Halves(discarded: 2)));

        Assert.Equal(PythonGeometryState.Success, result.State);
        Assert.Equal(2, result.Response!.Results[0].Discarded);
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
    public async Task SplitAsync_MapsPythonErrorsToTypedStatesWithoutReturningGeometry(HttpStatusCode status, string code, PythonGeometryState expected)
    {
        var client = Responding(GeometryPayloads.ErrorBody(code, "detalle"), status);

        var result = await Invoke(client);

        Assert.Equal(expected, result.State);
        Assert.Null(result.Response);
        Assert.Equal("detalle", result.Message);
    }

    [Fact]
    public async Task SplitAsync_WhenThePythonCallTimesOut_ReturnsTimeout()
    {
        var client = CreateClient(
            async (_, cancellationToken) =>
            {
                await Task.Delay(TimeSpan.FromSeconds(5), cancellationToken);
                return JsonResponse(HttpStatusCode.OK, GeometryPayloads.HalvesSplitResponse());
            },
            timeout: TimeSpan.FromMilliseconds(50));

        var result = await Invoke(client);

        Assert.Equal(PythonGeometryState.Timeout, result.State);
        Assert.Null(result.Response);
        Assert.Contains("el corte de geometría", result.Message);
    }

    [Fact]
    public async Task SplitAsync_WhenTheCallerCancels_PropagatesTheCancellationInsteadOfReportingATimeout()
    {
        using var cts = new CancellationTokenSource();
        var client = CreateClient(async (_, cancellationToken) =>
        {
            await cts.CancelAsync();
            await Task.Delay(TimeSpan.FromSeconds(5), cancellationToken);
            return JsonResponse(HttpStatusCode.OK, GeometryPayloads.HalvesSplitResponse());
        });

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => client.SplitAsync(Parameters(), cts.Token));
    }

    [Fact]
    public async Task SplitAsync_WhenPythonIsUnavailable_ReturnsUnavailable()
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
    [InlineData("""{"mode":"split","slot_width":0,"extend":false,"tolerance":0.01}""")]
    public async Task SplitAsync_WhenTheBodyIsNotValidOrIncomplete_ReturnsInvalidResponse(string body)
    {
        var result = await Invoke(Responding(body));

        Assert.Equal(PythonGeometryState.InvalidResponse, result.State);
        Assert.Null(result.Response);
    }

    [Theory]
    [InlineData("slot", 0.0, false)] // otro modo
    [InlineData("split", 1.5, false)] // otro ancho de ranura
    [InlineData("split", 0.0, true)] // otra extensión
    public async Task SplitAsync_WhenPythonEchoesDifferentParameters_ReturnsInvalidResponse(string mode, double slotWidth, bool extend)
    {
        var body = GeometryPayloads.SplitResponse(
            GeometryPayloads.SplitResult(0, $"[{GeometryPayloads.LeftHalf},{GeometryPayloads.RightHalf}]"), 2, mode, slotWidth, extend);

        Assert.Equal(PythonGeometryState.InvalidResponse, (await Invoke(Responding(body))).State);
    }

    [Fact]
    public async Task SplitAsync_WhenTheToleranceIsNotPositive_ReturnsInvalidResponse()
    {
        var body = GeometryPayloads.SplitResponse(GeometryPayloads.SplitResult(0, $"[{GeometryPayloads.LeftHalf},{GeometryPayloads.RightHalf}]"), 2, tolerance: 0);

        Assert.Equal(PythonGeometryState.InvalidResponse, (await Invoke(Responding(body))).State);
    }

    [Fact]
    public async Task SplitAsync_WhenTheTotalPieceCountDoesNotMatch_ReturnsInvalidResponse()
    {
        Assert.Equal(PythonGeometryState.InvalidResponse, (await Invoke(Responding(Halves(total: 3)))).State);
    }

    [Fact]
    public async Task SplitAsync_WhenAnItemPieceCountDoesNotMatchItsPieces_ReturnsInvalidResponse()
    {
        var result = await Invoke(Responding(Halves(pieceCount: 5)));

        Assert.Equal(PythonGeometryState.InvalidResponse, result.State);
        Assert.Contains("piece_count", result.Message);
    }

    [Fact]
    public async Task SplitAsync_WhenThereIsNotOneResultPerSubject_ReturnsInvalidResponse()
    {
        Assert.Equal(PythonGeometryState.InvalidResponse, (await Invoke(Responding(GeometryPayloads.SplitResponse(string.Empty, 0)))).State);
        var twoSubjects = Parameters(GeometryPayloads.SplitRequest(subjects: $"{GeometryPayloads.Square40},{GeometryPayloads.Square40}"));
        Assert.Equal(PythonGeometryState.InvalidResponse, (await Invoke(Responding(GeometryPayloads.HalvesSplitResponse()), twoSubjects)).State);
    }

    [Fact]
    public async Task SplitAsync_WhenTheSubjectIndexDoesNotMatchThePosition_ReturnsInvalidResponse()
    {
        var body = GeometryPayloads.SplitResponse(GeometryPayloads.SplitResult(3, $"[{GeometryPayloads.LeftHalf},{GeometryPayloads.RightHalf}]"), 2);

        Assert.Equal(PythonGeometryState.InvalidResponse, (await Invoke(Responding(body))).State);
    }

    [Fact]
    public async Task SplitAsync_WhenAChangedResultHasASinglePiece_ReturnsInvalidResponse()
    {
        // "Separó" con una sola pieza: el editor reemplazaría el objeto por una copia de sí mismo diciendo que lo cortó.
        var body = GeometryPayloads.SplitResponse(GeometryPayloads.SplitResult(0, $"[{GeometryPayloads.WholeSquare}]", changed: true, touched: true), 1);

        Assert.Equal(PythonGeometryState.InvalidResponse, (await Invoke(Responding(body))).State);
    }

    [Fact]
    public async Task SplitAsync_WhenAChangedResultWasNeverTouched_ReturnsInvalidResponse()
    {
        Assert.Equal(PythonGeometryState.InvalidResponse, (await Invoke(Responding(Halves(changed: true, touched: false)))).State);
    }

    [Theory]
    [InlineData(-1, true)]
    [InlineData(1, false)] // lo que no cambió no descartó nada
    public async Task SplitAsync_WhenDiscardedIsIncoherent_ReturnsInvalidResponse(int discarded, bool changed)
    {
        var pieces = changed ? $"[{GeometryPayloads.LeftHalf},{GeometryPayloads.RightHalf}]" : $"[{GeometryPayloads.WholeSquare}]";
        var body = GeometryPayloads.SplitResponse(GeometryPayloads.SplitResult(0, pieces, changed, changed, discarded: discarded), changed ? 2 : 1);

        Assert.Equal(PythonGeometryState.InvalidResponse, (await Invoke(Responding(body))).State);
    }

    [Theory]
    [InlineData("""[{"type":"polygon","coordinates":[[[0,0],[20,0],[20,40],[0,40]]]},{"type":"polygon","coordinates":[[[0,0],[1,0],[1,1],[0,0]]]}]""")] // anillo sin cerrar
    [InlineData("""[{"type":"polygon","coordinates":[]},{"type":"polygon","coordinates":[[[0,0],[1,0],[1,1],[0,0]]]}]""")] // polígono sin anillos
    [InlineData("""[{"type":"polygon","coordinates":[[[0,0],[1,0],[0,0]]]},{"type":"polygon","coordinates":[[[0,0],[1,0],[1,1],[0,0]]]}]""")] // anillo de menos de 4 vértices
    [InlineData("""[{"type":"circle","coordinates":[]},{"type":"polygon","coordinates":[[[0,0],[1,0],[1,1],[0,0]]]}]""")]
    [InlineData("""[{"type":"polygon","coordinates":[[[0,0],[1,0],[1,1],[0,0]]]},{"type":"polygon"}]""")]
    [InlineData("""[{"type":"polygon","coordinates":[[[0,0],["NaN",0],[1,1],[0,0]]]},{"type":"polygon","coordinates":[[[0,0],[1,0],[1,1],[0,0]]]}]""")]
    public async Task SplitAsync_WhenAPieceIsMalformed_ReturnsInvalidResponseAndNeverTheGeometry(string pieces)
    {
        var body = GeometryPayloads.SplitResponse(GeometryPayloads.SplitResult(0, pieces), 2);

        var result = await Invoke(Responding(body));

        Assert.Equal(PythonGeometryState.InvalidResponse, result.State);
        Assert.Null(result.Response);
    }

    [Fact]
    public async Task SplitAsync_WhenAPolygonSubjectGetsLinePieces_ReturnsInvalidResponse()
    {
        var body = GeometryPayloads.SplitResponse(
            GeometryPayloads.SplitResult(0, """[{"type":"line","coordinates":[[0,0],[1,1]]},{"type":"line","coordinates":[[1,1],[2,2]]}]"""), 2);

        var result = await Invoke(Responding(body));

        Assert.Equal(PythonGeometryState.InvalidResponse, result.State);
        Assert.Contains("solo admite 'polygon'", result.Message);
    }

    [Fact]
    public async Task SplitAsync_WhenALineSubjectGetsPolygonPieces_ReturnsInvalidResponse()
    {
        var result = await Invoke(Responding(Halves()), Parameters(GeometryPayloads.SplitRequest(subjects: GeometryPayloads.Line)));

        Assert.Equal(PythonGeometryState.InvalidResponse, result.State);
        Assert.Contains("solo admite 'line'", result.Message);
    }

    [Fact]
    public async Task SplitAsync_WhenALinePieceHasNonFiniteCoordinates_ReturnsInvalidResponse()
    {
        var body = GeometryPayloads.SplitResponse(
            GeometryPayloads.SplitResult(0, """[{"type":"line","coordinates":[[0,20],["Infinity",20]]},{"type":"line","coordinates":[[20,20],[40,20]]}]"""), 2);

        Assert.Equal(PythonGeometryState.InvalidResponse, (await Invoke(Responding(body), Parameters(GeometryPayloads.SplitRequest(subjects: GeometryPayloads.Line)))).State);
    }

    [Fact]
    public async Task SplitAsync_ResolvesSeveralSubjectsInOrder()
    {
        var subjects = $"{GeometryPayloads.Square40},{GeometryPayloads.Square40}";
        var results = string.Join(
            ",",
            GeometryPayloads.SplitResult(0, $"[{GeometryPayloads.LeftHalf},{GeometryPayloads.RightHalf}]"),
            GeometryPayloads.SplitResult(1, $"[{GeometryPayloads.WholeSquare}]", changed: false, touched: true));

        var result = await Invoke(Responding(GeometryPayloads.SplitResponse(results, 3)), Parameters(GeometryPayloads.SplitRequest(subjects: subjects)));

        Assert.Equal(PythonGeometryState.Success, result.State);
        Assert.Equal([0, 1], result.Response!.Results.Select(item => item.SubjectIndex));
        Assert.Equal([true, false], result.Response.Results.Select(item => item.Changed));
        Assert.Equal(3, result.Response.PieceCount);
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
