using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Vectorify.Api.Clients;
using Vectorify.Api.Geometry;
using Vectorify.Api.Tests.TestSupport;

namespace Vectorify.Api.Tests.Clients;

/// <summary>
/// Pruebas unitarias de PythonGeometryClient contra un HttpMessageHandler stub (sin red real): forma EXACTA del cuerpo
/// que se le manda a Python, todos los estados de error (422/413/504/500/timeout/no disponible/JSON inválido) y la
/// validación defensiva sobre respuestas 200 sospechosas (NaN, anillo abierto, operación o conteos que no corresponden,
/// pieza del tipo equivocado): ninguna excepción escapa y la geometría dudosa NUNCA se devuelve.
/// </summary>
public sealed class PythonGeometryClientTests
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

    private static GeometryBooleanParameters Parameters(string? json = null)
    {
        var validator = new GeometryRequestValidator(Microsoft.Extensions.Options.Options.Create(new Options.GeometryOptions()));
        return validator.Validate(GeometryPayloads.Parse(json ?? GeometryPayloads.Request())).Parameters!;
    }

    private static Task<PythonGeometryResult> Invoke(PythonGeometryClient client, GeometryBooleanParameters? parameters = null) =>
        client.BooleanAsync(parameters ?? Parameters());

    [Fact]
    public async Task BooleanAsync_WhenResponseIsValid_ReturnsSuccessWithTheTypedPieces()
    {
        var client = CreateClient((_, _) => Task.FromResult(JsonResponse(HttpStatusCode.OK, GeometryPayloads.SplitSquareResponse())));

        var result = await Invoke(client);

        Assert.Equal(PythonGeometryState.Success, result.State);
        var response = result.Response!;
        Assert.Equal("difference", response.Operation);
        Assert.Equal("per_subject", response.Scope);
        Assert.Equal(2, response.PieceCount);
        var item = Assert.Single(response.Results);
        Assert.Equal(0, item.SubjectIndex);
        Assert.True(item.Changed);
        Assert.Equal(2, item.Geometries.Count);
        Assert.All(item.Geometries, piece => Assert.Equal("polygon", piece.Type));
        Assert.Equal(15, item.Geometries[0].Coordinates[0][2][1].GetDouble());
    }

    [Fact]
    public async Task BooleanAsync_SendsThePostToTheGeometryRouteWithTheExactSnakeCaseBody()
    {
        HttpRequestMessage? captured = null;
        string? body = null;
        var client = CreateClient(async (request, _) =>
        {
            captured = request;
            body = await request.Content!.ReadAsStringAsync();
            return JsonResponse(HttpStatusCode.OK, GeometryPayloads.SplitSquareResponse());
        });

        await Invoke(client);

        Assert.Equal(HttpMethod.Post, captured!.Method);
        Assert.Equal("/api/v1/geometry/boolean", captured.RequestUri!.AbsolutePath);
        Assert.Equal("application/json", captured.Content!.Headers.ContentType!.MediaType);
        using var document = JsonDocument.Parse(body!);
        var root = document.RootElement;
        Assert.Equal("difference", root.GetProperty("operation").GetString());
        Assert.Equal(0.01, root.GetProperty("tolerance").GetDouble());
        var subject = root.GetProperty("subjects")[0];
        Assert.Equal("polygon", subject.GetProperty("type").GetString());
        Assert.Equal(40, subject.GetProperty("coordinates")[0][1][0].GetDouble());
        Assert.False(subject.TryGetProperty("points", out _)); // los campos que no aplican no viajan
        Assert.False(subject.TryGetProperty("radius", out _));
        var brush = root.GetProperty("operands")[0];
        Assert.Equal("bufferedLine", brush.GetProperty("type").GetString());
        Assert.Equal(5, brush.GetProperty("radius").GetDouble());
        Assert.Equal(-10, brush.GetProperty("points")[0][0].GetDouble());
        Assert.False(brush.TryGetProperty("coordinates", out _));
    }

    [Fact]
    public async Task BooleanAsync_SendsLinesAsPolylines()
    {
        string? body = null;
        var client = CreateClient(async (request, _) =>
        {
            body = await request.Content!.ReadAsStringAsync();
            return JsonResponse(HttpStatusCode.OK, GeometryPayloads.Response(
                "difference", "per_subject", """[{"subject_index":0,"changed":false,"geometries":[{"type":"line","coordinates":[[0,20],[40,20]]}]}]""", 1));
        });

        var result = await Invoke(client, Parameters(GeometryPayloads.Request(subjects: GeometryPayloads.Line)));

        Assert.Equal(PythonGeometryState.Success, result.State);
        // `changed: false` (el pincel no tocó el subject) viaja intacto: el editor conserva así el objeto original, con sus curvas.
        Assert.False(Assert.Single(result.Response!.Results).Changed);
        using var document = JsonDocument.Parse(body!);
        Assert.Equal("line", document.RootElement.GetProperty("subjects")[0].GetProperty("type").GetString());
        Assert.Equal(2, document.RootElement.GetProperty("subjects")[0].GetProperty("coordinates").GetArrayLength());
    }

    [Theory]
    [InlineData(HttpStatusCode.UnprocessableEntity, "invalid_parameters", PythonGeometryState.InvalidParameters)]
    [InlineData(HttpStatusCode.UnprocessableEntity, "too_many_geometry_subjects", PythonGeometryState.InvalidParameters)]
    [InlineData(HttpStatusCode.UnprocessableEntity, "too_many_geometry_vertices", PythonGeometryState.InvalidParameters)]
    [InlineData(HttpStatusCode.RequestEntityTooLarge, "geometry_request_too_large", PythonGeometryState.TooLarge)]
    [InlineData(HttpStatusCode.GatewayTimeout, "geometry_timeout", PythonGeometryState.Timeout)]
    [InlineData(HttpStatusCode.InternalServerError, "geometry_result_invalid", PythonGeometryState.EngineError)]
    [InlineData(HttpStatusCode.InternalServerError, "processing_error", PythonGeometryState.EngineError)]
    [InlineData(HttpStatusCode.UnprocessableEntity, "algo_nuevo", PythonGeometryState.InvalidParameters)]
    [InlineData(HttpStatusCode.RequestEntityTooLarge, "algo_nuevo", PythonGeometryState.TooLarge)]
    [InlineData(HttpStatusCode.GatewayTimeout, "algo_nuevo", PythonGeometryState.Timeout)]
    [InlineData(HttpStatusCode.BadGateway, "algo_nuevo", PythonGeometryState.EngineError)]
    public async Task BooleanAsync_MapsPythonErrorsToTypedStatesWithoutReturningGeometry(HttpStatusCode status, string code, PythonGeometryState expected)
    {
        var client = CreateClient((_, _) => Task.FromResult(JsonResponse(status, GeometryPayloads.ErrorBody(code, "detalle"))));

        var result = await Invoke(client);

        Assert.Equal(expected, result.State);
        Assert.Null(result.Response);
        Assert.Equal("detalle", result.Message);
    }

    [Fact]
    public async Task BooleanAsync_WhenPythonErrorHasNoJsonBody_StillMapsByStatusCode()
    {
        var client = CreateClient((_, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.GatewayTimeout) { Content = new StringContent("<html>") }));

        var result = await Invoke(client);

        Assert.Equal(PythonGeometryState.Timeout, result.State);
        Assert.Contains("504", result.Message);
    }

    [Fact]
    public async Task BooleanAsync_WhenThePythonCallTimesOut_ReturnsTimeout()
    {
        var client = CreateClient(
            async (_, cancellationToken) =>
            {
                await Task.Delay(TimeSpan.FromSeconds(5), cancellationToken);
                return JsonResponse(HttpStatusCode.OK, GeometryPayloads.SplitSquareResponse());
            },
            timeout: TimeSpan.FromMilliseconds(50));

        var result = await Invoke(client);

        Assert.Equal(PythonGeometryState.Timeout, result.State);
        Assert.Null(result.Response);
    }

    [Fact]
    public async Task BooleanAsync_WhenTheCallerCancels_PropagatesTheCancellationInsteadOfReportingATimeout()
    {
        using var cts = new CancellationTokenSource();
        var client = CreateClient(async (_, cancellationToken) =>
        {
            await cts.CancelAsync();
            await Task.Delay(TimeSpan.FromSeconds(5), cancellationToken);
            return JsonResponse(HttpStatusCode.OK, GeometryPayloads.SplitSquareResponse());
        });

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => client.BooleanAsync(Parameters(), cts.Token));
    }

    [Fact]
    public async Task BooleanAsync_WhenPythonIsUnavailable_ReturnsUnavailable()
    {
        var client = CreateClient((_, _) => throw new HttpRequestException("connection refused"));

        var result = await Invoke(client);

        Assert.Equal(PythonGeometryState.Unavailable, result.State);
        Assert.Null(result.Response);
    }

    [Theory]
    [InlineData("esto no es JSON")]
    [InlineData("")]
    [InlineData("""{"operation":"difference","scope":"per_subject","tolerance":0.01,"results":[{"subject_index":0,"changed":true,"geometries":[{"type":"line","coordinates":[[0,0],[NaN,1]]}]}],"piece_count":1}""")]
    public async Task BooleanAsync_WhenTheBodyIsNotValidJson_ReturnsInvalidResponse(string body)
    {
        var client = CreateClient((_, _) => Task.FromResult(JsonResponse(HttpStatusCode.OK, body)));

        var result = await Invoke(client, Parameters(GeometryPayloads.Request(subjects: GeometryPayloads.Line)));

        Assert.Equal(PythonGeometryState.InvalidResponse, result.State);
        Assert.Null(result.Response);
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("""{"operation":"difference","scope":"per_subject"}""")]
    [InlineData("null")]
    public async Task BooleanAsync_WhenFieldsAreMissing_ReturnsInvalidResponse(string body)
    {
        var client = CreateClient((_, _) => Task.FromResult(JsonResponse(HttpStatusCode.OK, body)));

        var result = await Invoke(client);

        Assert.Equal(PythonGeometryState.InvalidResponse, result.State);
    }

    [Fact]
    public async Task BooleanAsync_WhenTheOperationDoesNotMatchTheRequest_ReturnsInvalidResponse()
    {
        var client = CreateClient((_, _) => Task.FromResult(JsonResponse(HttpStatusCode.OK, GeometryPayloads.SplitSquareResponse(operation: "union"))));

        Assert.Equal(PythonGeometryState.InvalidResponse, (await Invoke(client)).State);
    }

    [Fact]
    public async Task BooleanAsync_WhenTheScopeDoesNotMatchTheOperation_ReturnsInvalidResponse()
    {
        var client = CreateClient((_, _) => Task.FromResult(JsonResponse(HttpStatusCode.OK, GeometryPayloads.SplitSquareResponse(scope: "combined"))));

        Assert.Equal(PythonGeometryState.InvalidResponse, (await Invoke(client)).State);
    }

    [Fact]
    public async Task BooleanAsync_WhenThePieceCountDoesNotMatch_ReturnsInvalidResponse()
    {
        var client = CreateClient((_, _) => Task.FromResult(JsonResponse(HttpStatusCode.OK, GeometryPayloads.SplitSquareResponse(pieceCount: 3))));

        Assert.Equal(PythonGeometryState.InvalidResponse, (await Invoke(client)).State);
    }

    [Fact]
    public async Task BooleanAsync_WhenThereIsNotOneResultPerSubject_ReturnsInvalidResponse()
    {
        var client = CreateClient((_, _) => Task.FromResult(JsonResponse(
            HttpStatusCode.OK, GeometryPayloads.Response("difference", "per_subject", "[]", 0))));

        Assert.Equal(PythonGeometryState.InvalidResponse, (await Invoke(client)).State);
    }

    [Fact]
    public async Task BooleanAsync_WhenTheSubjectIndexDoesNotMatchThePosition_ReturnsInvalidResponse()
    {
        var client = CreateClient((_, _) => Task.FromResult(JsonResponse(
            HttpStatusCode.OK, GeometryPayloads.Response("difference", "per_subject", """[{"subject_index":3,"changed":true,"geometries":[]}]""", 0))));

        Assert.Equal(PythonGeometryState.InvalidResponse, (await Invoke(client)).State);
    }

    [Fact]
    public async Task BooleanAsync_WhenACombinedResultCarriesASubjectIndex_ReturnsInvalidResponse()
    {
        var client = CreateClient((_, _) => Task.FromResult(JsonResponse(
            HttpStatusCode.OK, GeometryPayloads.Response("union", "combined", """[{"subject_index":0,"changed":true,"geometries":[]}]""", 0))));

        var result = await Invoke(client, Parameters(GeometryPayloads.Request(operation: "union")));

        Assert.Equal(PythonGeometryState.InvalidResponse, result.State);
    }

    [Fact]
    public async Task BooleanAsync_WhenUnionIsCombined_ReturnsASingleResultWithoutSubjectIndex()
    {
        var client = CreateClient((_, _) => Task.FromResult(JsonResponse(
            HttpStatusCode.OK,
            GeometryPayloads.Response(
                "union", "combined", """[{"subject_index":null,"changed":true,"geometries":[{"type":"polygon","coordinates":[[[0,0],[1,0],[1,1],[0,0]]]}]}]""", 1))));

        var result = await Invoke(client, Parameters(GeometryPayloads.Request(operation: "union")));

        Assert.Equal(PythonGeometryState.Success, result.State);
        Assert.Null(Assert.Single(result.Response!.Results).SubjectIndex);
    }

    [Theory]
    [InlineData("""{"type":"polygon","coordinates":[[[0,0],[40,0],[40,15],[0,15]]]}""")] // anillo sin cerrar
    [InlineData("""{"type":"polygon","coordinates":[[[0,0],[40,0],[0,0]]]}""")] // anillo de menos de 4 vértices
    [InlineData("""{"type":"polygon","coordinates":[]}""")] // sin anillos
    [InlineData("""{"type":"polygon","coordinates":[[[0,0],[40,0],[40,"x"],[0,0]]]}""")] // vértice no numérico
    [InlineData("""{"type":"polygon","coordinates":[[[0,0],[40,0],[40,null],[0,0]]]}""")] // vértice null
    [InlineData("""{"type":"polygon","coordinates":[[[0,0],[40,0,9],[40,15],[0,0]]]}""")] // vértice de 3 componentes
    [InlineData("""{"type":"line","coordinates":[[0,0],[1,1]]}""")] // línea para un subject-polígono
    [InlineData("""{"type":"circle","coordinates":[[0,0],[1,1]]}""")]
    [InlineData("""{"type":"polygon"}""")]
    public async Task BooleanAsync_WhenAPieceIsMalformed_ReturnsInvalidResponseAndNeverTheGeometry(string piece)
    {
        var client = CreateClient((_, _) => Task.FromResult(JsonResponse(
            HttpStatusCode.OK,
            GeometryPayloads.Response("difference", "per_subject", $$"""[{"subject_index":0,"changed":true,"geometries":[{{piece}}]}]""", 1))));

        var result = await Invoke(client);

        Assert.Equal(PythonGeometryState.InvalidResponse, result.State);
        Assert.Null(result.Response);
    }

    [Theory]
    [InlineData("""{"type":"polygon","coordinates":[[[0,0],[1,0],[1,1],[0,0]]]}""")] // polígono para un subject-línea
    [InlineData("""{"type":"line","coordinates":[[0,0]]}""")] // línea de 1 vértice
    public async Task BooleanAsync_WhenALinePieceIsWrong_ReturnsInvalidResponse(string piece)
    {
        var client = CreateClient((_, _) => Task.FromResult(JsonResponse(
            HttpStatusCode.OK,
            GeometryPayloads.Response("difference", "per_subject", $$"""[{"subject_index":0,"changed":true,"geometries":[{{piece}}]}]""", 1))));

        var result = await Invoke(client, Parameters(GeometryPayloads.Request(subjects: GeometryPayloads.Line)));

        Assert.Equal(PythonGeometryState.InvalidResponse, result.State);
    }

    [Fact]
    public async Task BooleanAsync_AcceptsAnEmptyResultForASubject()
    {
        var client = CreateClient((_, _) => Task.FromResult(JsonResponse(
            HttpStatusCode.OK, GeometryPayloads.Response("difference", "per_subject", """[{"subject_index":0,"changed":true,"geometries":[]}]""", 0))));

        var result = await Invoke(client);

        Assert.Equal(PythonGeometryState.Success, result.State);
        Assert.Empty(Assert.Single(result.Response!.Results).Geometries);
    }

    [Fact]
    public async Task BooleanAsync_WhenTheToleranceIsNotPositive_ReturnsInvalidResponse()
    {
        var client = CreateClient((_, _) => Task.FromResult(JsonResponse(
            HttpStatusCode.OK,
            GeometryPayloads.Response("difference", "per_subject", """[{"subject_index":0,"changed":true,"geometries":[]}]""", 0, tolerance: 0))));

        Assert.Equal(PythonGeometryState.InvalidResponse, (await Invoke(client)).State);
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
