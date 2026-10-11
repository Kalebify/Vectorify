using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Vectorify.Api.Clients;
using Vectorify.Api.Geometry;
using Vectorify.Api.Tests.TestSupport;

namespace Vectorify.Api.Tests.Clients;

/// <summary>
/// Pruebas unitarias de PythonGeometryClient.FloatingAsync y BridgeAsync (M3-S11) contra un HttpMessageHandler stub (sin red real): forma EXACTA del
/// cuerpo que se le manda a Python, todos los estados de error, y la validación defensiva sobre respuestas 200 sospechosas (modo distinto del pedido,
/// ids fuera de posición, árbol de contención incoherente, recuentos inventados, bridge "válido" sin datos o que toca una forma bloqueada, resultados que
/// no coinciden con los bridges válidos, reanálisis con MÁS flotantes que antes...): ninguna excepción escapa y la geometría dudosa NUNCA se devuelve.
/// </summary>
public sealed class PythonGeometryFloatingClientTests
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

    private static GeometryRequestValidator Validator() => new(Microsoft.Extensions.Options.Options.Create(new Options.GeometryOptions()));

    private static GeometryFloatingParameters FloatingParameters(string? json = null) =>
        Validator().ValidateFloating(GeometryPayloads.ParseFloating(json ?? GeometryPayloads.FloatingRequest())).FloatingParameters!;

    private static GeometryBridgeParameters BridgeParameters(string? json = null) =>
        Validator().ValidateBridge(GeometryPayloads.ParseBridge(json ?? GeometryPayloads.BridgeRequest())).BridgeParameters!;

    private static PythonGeometryClient Responding(string body, HttpStatusCode status = HttpStatusCode.OK) =>
        CreateClient((_, _) => Task.FromResult(JsonResponse(status, body)));

    private static Task<PythonGeometryFloatingResult> Floating(PythonGeometryClient client, GeometryFloatingParameters? parameters = null) =>
        client.FloatingAsync(parameters ?? FloatingParameters());

    private static Task<PythonGeometryBridgeResult> Bridge(PythonGeometryClient client, GeometryBridgeParameters? parameters = null) =>
        client.BridgeAsync(parameters ?? BridgeParameters());

    /// <summary>Cambia un fragmento de una respuesta válida; falla si el fragmento no está (un test que muta "nada" no probaría nada).</summary>
    private static string Mutate(string json, string from, string to)
    {
        Assert.Contains(from, json);
        return json.Replace(from, to);
    }

    // ---- Análisis: éxito y cuerpo ----

    [Fact]
    public async Task FloatingAsync_WhenResponseIsValid_ReturnsSuccessWithEveryField()
    {
        var result = await Floating(Responding(GeometryPayloads.FloatingResponse()));

        Assert.Equal(PythonGeometryState.Success, result.State);
        var response = result.Response!;
        Assert.Equal(("stencil", 0.01, 1, 1, 0), (response.Mode, response.Tolerance, response.FloatingCount, response.MainCount, response.Discarded));
        var (sheet, island) = (response.Components[0], response.Components[1]);
        Assert.Equal((0, "principal", 0, (int?)null), (sheet.Id, sheet.Kind, sheet.Depth, sheet.Parent));
        Assert.Null(sheet.Polygon);
        Assert.Null(sheet.Area);
        Assert.Equal((1, "floating", 1, (int?)0, 100.0), (island.Id, island.Kind, island.Depth, island.Parent, island.Area));
        Assert.Equal([5.0, 5.0, 15.0, 15.0], island.Bounds);
        Assert.Equal([0], island.Subjects);
        Assert.Equal("polygon", island.Polygon!.Type);
        Assert.Equal(15, island.Polygon.Coordinates[0][1][0].GetDouble());
    }

    [Fact]
    public async Task FloatingAsync_SendsThePostToTheFloatingRouteWithTheExactSnakeCaseBody()
    {
        HttpRequestMessage? captured = null;
        string? body = null;
        var client = CreateClient(async (request, _) =>
        {
            captured = request;
            body = await request.Content!.ReadAsStringAsync();
            return JsonResponse(HttpStatusCode.OK, GeometryPayloads.PartsResponse());
        });
        var subjects = $$"""{"type":"polygon","coordinates":[[[0,0],[10,0],[10,10]]],"locked":true},{{GeometryPayloads.RingPolygon}}""";
        var json = GeometryPayloads.FloatingRequest(subjects: subjects, mode: "parts", tolerance: "0.02");

        var result = await Floating(client, FloatingParameters(json));

        Assert.Equal(HttpMethod.Post, captured!.Method);
        Assert.Equal("/api/v1/geometry/floating", captured.RequestUri!.AbsolutePath);
        Assert.Equal("application/json", captured.Content!.Headers.ContentType!.MediaType);
        using var document = JsonDocument.Parse(body!);
        var root = document.RootElement;
        Assert.Equal("parts", root.GetProperty("mode").GetString());
        Assert.Equal(0.02, root.GetProperty("tolerance").GetDouble());
        Assert.Equal(2, root.GetProperty("subjects").GetArrayLength());
        var first = root.GetProperty("subjects")[0];
        Assert.Equal("polygon", first.GetProperty("type").GetString());
        Assert.True(first.GetProperty("locked").GetBoolean());
        Assert.Equal(10, first.GetProperty("coordinates")[0][1][0].GetDouble());
        Assert.False(root.GetProperty("subjects")[1].GetProperty("locked").GetBoolean());
        Assert.False(root.TryGetProperty("bridges", out _));
        Assert.False(root.TryGetProperty("operation", out _));
        Assert.Equal(PythonGeometryState.Success, result.State);
    }

    [Fact]
    public async Task FloatingAsync_AcceptsAPartsResultWhereEveryComponentHasAPolygonAndDeepOnesHangFromTheirParent()
    {
        var body = GeometryPayloads.FloatingResponse(
            string.Join(
                ",",
                """{"id":0,"kind":"principal","depth":0,"parent":null,"polygon":{"type":"polygon","coordinates":[[[0,0],[20,0],[20,20],[0,0]]]},"area":200,"bounds":[0,0,20,20],"subjects":[0]}""",
                """{"id":1,"kind":"floating","depth":1,"parent":0,"polygon":{"type":"polygon","coordinates":[[[2,2],[4,2],[4,4],[2,2]]]},"area":2,"bounds":[2,2,4,4],"subjects":[1]}""",
                """{"id":2,"kind":"floating","depth":2,"parent":1,"polygon":{"type":"polygon","coordinates":[[[2,2],[3,2],[3,3],[2,2]]]},"area":0.5,"bounds":[2,2,3,3],"subjects":[0,1]}"""),
            floatingCount: 2,
            mainCount: 1,
            mode: "parts");
        var parameters = FloatingParameters(GeometryPayloads.FloatingRequest(subjects: $"{GeometryPayloads.RingPolygon},{GeometryPayloads.DotPolygon}", mode: "parts"));

        var result = await Floating(Responding(body), parameters);

        Assert.Equal(PythonGeometryState.Success, result.State);
        Assert.Equal([(int?)null, 0, 1], result.Response!.Components.Select(component => component.Parent));
        Assert.Equal([0, 1, 2], result.Response.Components.Select(component => component.Depth));
        Assert.All(result.Response.Components, component => Assert.NotNull(component.Polygon));
        Assert.Equal([0, 1], result.Response.Components[2].Subjects);
    }

    [Fact]
    public async Task FloatingAsync_AcceptsAnEmptyResult_WhenThereIsNothingToAnalyze()
    {
        var result = await Floating(Responding(GeometryPayloads.FloatingResponse(string.Empty, floatingCount: 0, mainCount: 0)));

        Assert.Equal(PythonGeometryState.Success, result.State);
        Assert.Empty(result.Response!.Components);
    }

    // ---- Análisis: errores de Python ----

    [Theory]
    [InlineData(HttpStatusCode.UnprocessableEntity, "invalid_parameters", PythonGeometryState.InvalidParameters)]
    [InlineData(HttpStatusCode.UnprocessableEntity, "too_many_geometry_subjects", PythonGeometryState.InvalidParameters)]
    [InlineData(HttpStatusCode.UnprocessableEntity, "too_many_geometry_vertices", PythonGeometryState.InvalidParameters)]
    [InlineData(HttpStatusCode.RequestEntityTooLarge, "geometry_request_too_large", PythonGeometryState.TooLarge)]
    [InlineData(HttpStatusCode.GatewayTimeout, "geometry_timeout", PythonGeometryState.Timeout)]
    [InlineData(HttpStatusCode.InternalServerError, "geometry_result_invalid", PythonGeometryState.EngineError)]
    [InlineData(HttpStatusCode.BadGateway, "algo_nuevo", PythonGeometryState.EngineError)]
    public async Task FloatingAndBridge_MapPythonErrorsToTypedStatesWithoutReturningGeometry(HttpStatusCode status, string code, PythonGeometryState expected)
    {
        var client = Responding(GeometryPayloads.ErrorBody(code, "detalle"), status);

        var floating = await Floating(client);
        var bridge = await Bridge(client);

        Assert.Equal((expected, expected), (floating.State, bridge.State));
        Assert.Null(floating.Response);
        Assert.Null(bridge.Response);
        Assert.Equal(("detalle", "detalle"), (floating.Message, bridge.Message));
    }

    [Fact]
    public async Task FloatingAndBridge_WhenThePythonCallTimesOut_ReturnTimeout()
    {
        var client = CreateClient(
            async (_, cancellationToken) =>
            {
                await Task.Delay(TimeSpan.FromSeconds(5), cancellationToken);
                return JsonResponse(HttpStatusCode.OK, GeometryPayloads.FloatingResponse());
            },
            timeout: TimeSpan.FromMilliseconds(50));

        var floating = await Floating(client);
        var bridge = await Bridge(client);

        Assert.Equal((PythonGeometryState.Timeout, PythonGeometryState.Timeout), (floating.State, bridge.State));
        Assert.Contains("el análisis de piezas flotantes", floating.Message);
        Assert.Contains("el cálculo de bridges", bridge.Message);
    }

    [Fact]
    public async Task FloatingAndBridge_WhenTheCallerCancels_PropagateTheCancellationInsteadOfReportingATimeout()
    {
        using var cts = new CancellationTokenSource();
        var client = CreateClient(async (_, cancellationToken) =>
        {
            await cts.CancelAsync();
            await Task.Delay(TimeSpan.FromSeconds(5), cancellationToken);
            return JsonResponse(HttpStatusCode.OK, GeometryPayloads.FloatingResponse());
        });

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => client.FloatingAsync(FloatingParameters(), cts.Token));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => client.BridgeAsync(BridgeParameters(), cts.Token));
    }

    [Fact]
    public async Task FloatingAndBridge_WhenPythonIsUnavailable_ReturnUnavailable()
    {
        var client = CreateClient((_, _) => throw new HttpRequestException("connection refused"));

        Assert.Equal(PythonGeometryState.Unavailable, (await Floating(client)).State);
        Assert.Equal(PythonGeometryState.Unavailable, (await Bridge(client)).State);
    }

    [Theory]
    [InlineData("esto no es JSON")]
    [InlineData("")]
    [InlineData("{}")]
    [InlineData("null")]
    [InlineData("""{"mode":"stencil","tolerance":0.01,"floating_count":1,"main_count":1,"discarded":0}""")]
    public async Task FloatingAsync_WhenTheBodyIsNotValidOrIncomplete_ReturnsInvalidResponse(string body)
    {
        var result = await Floating(Responding(body));

        Assert.Equal(PythonGeometryState.InvalidResponse, result.State);
        Assert.Null(result.Response);
    }

    // ---- Análisis: respuestas 200 sospechosas ----

    [Theory]
    [InlineData("\"mode\":\"stencil\"", "\"mode\":\"parts\"")] // otro modo
    [InlineData("\"tolerance\":0.01", "\"tolerance\":0")]
    [InlineData("\"id\":1,", "\"id\":4,")] // id fuera de posición
    [InlineData("\"kind\":\"floating\"", "\"kind\":\"rare\"")]
    [InlineData("\"kind\":\"floating\"", "\"kind\":\"principal\"")] // dos principales en plantilla (y con padre)
    [InlineData("\"depth\":1", "\"depth\":2")] // profundidad que no es la del padre + 1
    [InlineData("\"parent\":0", "\"parent\":null")] // flotante sin padre
    [InlineData("\"parent\":0", "\"parent\":1")] // padre que no es anterior (él mismo)
    [InlineData("\"parent\":0", "\"parent\":7")]
    [InlineData("\"area\":100", "\"area\":0")]
    [InlineData("\"area\":100", "\"area\":null")]
    [InlineData("\"polygon\":{\"type\":\"polygon\",\"coordinates\":[[[5,5],[15,5],[15,15],[5,15],[5,5]]]}", "\"polygon\":null")] // isla sin polígono
    [InlineData("[[5,5],[15,5],[15,15],[5,15],[5,5]]", "[[5,5],[15,5],[15,15],[5,15]]")] // anillo sin cerrar
    [InlineData("[[5,5],[15,5],[15,15],[5,15],[5,5]]", "[[5,5],[15,5],[5,5]]")] // anillo de menos de 4 vértices
    [InlineData("[[5,5],[15,5],[15,15],[5,15],[5,5]]", "[[5,5],[\"NaN\",5],[15,15],[5,15],[5,5]]")]
    [InlineData("\"bounds\":[5,5,15,15]", "\"bounds\":[5,5,15]")]
    [InlineData("\"bounds\":[5,5,15,15]", "\"bounds\":[15,5,5,15]")] // mínimo mayor que máximo
    [InlineData("\"bounds\":[5,5,15,15]", "\"bounds\":[5,5,\"Infinity\",15]")]
    [InlineData("\"subjects\":[0]}", "\"subjects\":[3]}")] // forma inexistente
    [InlineData("\"subjects\":[0]}", "\"subjects\":[-1]}")]
    [InlineData("\"subjects\":[0]}", "\"subjects\":null}")]
    [InlineData("\"floating_count\":1", "\"floating_count\":2")] // recuentos inventados
    [InlineData("\"floating_count\":1", "\"floating_count\":0")]
    [InlineData("\"main_count\":1", "\"main_count\":2")]
    [InlineData("\"discarded\":0", "\"discarded\":-1")]
    public async Task FloatingAsync_WhenPythonReturnsAnIncoherentSuccess_ReturnsInvalidResponseAndNeverTheGeometry(string from, string to)
    {
        var result = await Floating(Responding(Mutate(GeometryPayloads.FloatingResponse(), from, to)));

        Assert.Equal(PythonGeometryState.InvalidResponse, result.State);
        Assert.Null(result.Response);
        Assert.False(string.IsNullOrWhiteSpace(result.Message));
    }

    [Fact]
    public async Task FloatingAsync_WhenTheSheetOfAStencilCarriesAPolygon_ReturnsInvalidResponse()
    {
        var sheet = GeometryPayloads.SheetComponent.Replace("\"polygon\":null", "\"polygon\":{\"type\":\"polygon\",\"coordinates\":[[[0,0],[20,0],[20,20],[0,0]]]}");

        var result = await Floating(Responding(GeometryPayloads.FloatingResponse(sheet + "," + GeometryPayloads.IslandComponent)));

        Assert.Equal(PythonGeometryState.InvalidResponse, result.State);
    }

    [Fact]
    public async Task FloatingAsync_WhenTheBodyOfAPartsResultHasNoPolygon_ReturnsInvalidResponse()
    {
        // En `parts` el principal es un cuerpo real: sin polígono no hay nada que mostrar.
        var result = await Floating(Responding(GeometryPayloads.FloatingResponse(mode: "parts")), FloatingParameters(GeometryPayloads.FloatingRequest(mode: "parts")));

        Assert.Equal(PythonGeometryState.InvalidResponse, result.State);
    }

    [Fact]
    public async Task FloatingAsync_WhenSubjectsOfAComponentAreRepeatedOrUnsorted_ReturnsInvalidResponse()
    {
        var parameters = FloatingParameters(GeometryPayloads.FloatingRequest(subjects: $"{GeometryPayloads.RingPolygon},{GeometryPayloads.DotPolygon}"));

        Assert.Equal(PythonGeometryState.InvalidResponse, (await Floating(Responding(Mutate(GeometryPayloads.FloatingResponse(), "\"subjects\":[0]}", "\"subjects\":[1,0]}")), parameters)).State);
        Assert.Equal(PythonGeometryState.InvalidResponse, (await Floating(Responding(Mutate(GeometryPayloads.FloatingResponse(), "\"subjects\":[0]}", "\"subjects\":[0,0]}")), parameters)).State);
        Assert.Equal(PythonGeometryState.Success, (await Floating(Responding(Mutate(GeometryPayloads.FloatingResponse(), "\"subjects\":[0]}", "\"subjects\":[0,1]}")), parameters)).State);
    }

    // ---- Bridges: éxito y cuerpo ----

    [Fact]
    public async Task BridgeAsync_WhenResponseIsValid_ReturnsSuccessWithEveryField()
    {
        var result = await Bridge(Responding(GeometryPayloads.BridgeResponse()));

        Assert.Equal(PythonGeometryState.Success, result.State);
        var response = result.Response!;
        Assert.Equal(("stencil", 0.01, 1), (response.Mode, response.Tolerance, response.PieceCount));
        Assert.Equal((1, 0, 1), (response.Reanalysis.FloatingBefore, response.Reanalysis.FloatingAfter, response.Reanalysis.MainAfter));
        var bridge = Assert.Single(response.Bridges);
        Assert.Equal((0, false, true, (string?)null, (int?)1, 0.8, (double?)5, (double?)4, true), (bridge.Index, bridge.Suggested, bridge.Valid, bridge.Reason, bridge.Island, bridge.Width, bridge.Length, bridge.Area, bridge.Reduces));
        Assert.Equal([0], bridge.Affects);
        Assert.Equal((15.0, 10.0, 1.0, 0.0), (bridge.Anchor!.X, bridge.Anchor.Y, bridge.Direction!.X, bridge.Direction.Y));
        Assert.Equal("polygon", bridge.Polygon!.Type);
        var subject = Assert.Single(response.Results);
        Assert.Equal((0, true, 1), (subject.SubjectIndex, subject.Changed, subject.Geometries.Count));
    }

    [Fact]
    public async Task BridgeAsync_SendsThePostToTheBridgeRouteWithTheExactSnakeCaseBody()
    {
        HttpRequestMessage? captured = null;
        string? body = null;
        var client = CreateClient(async (request, _) =>
        {
            captured = request;
            body = await request.Content!.ReadAsStringAsync();
            return JsonResponse(HttpStatusCode.OK, GeometryPayloads.BridgeResponse(
                bridgesJson: GeometryPayloads.BridgeItem(width: 1.5) + "," + GeometryPayloads.BridgeItem(index: 1, suggested: true, width: 0.5),
                mode: "stencil"));
        });
        var bridges = """{"anchor":{"x":15,"y":7},"direction":{"x":0,"y":-3},"width":1.5,"length":6}""";
        var json = GeometryPayloads.BridgeRequest(bridges: bridges, suggest: "true", suggestWidth: "0.5", tolerance: "0.02");

        var result = await Bridge(client, BridgeParameters(json));

        Assert.Equal(PythonGeometryState.Success, result.State);
        Assert.Equal(HttpMethod.Post, captured!.Method);
        Assert.Equal("/api/v1/geometry/bridge", captured.RequestUri!.AbsolutePath);
        using var document = JsonDocument.Parse(body!);
        var root = document.RootElement;
        Assert.Equal("stencil", root.GetProperty("mode").GetString());
        Assert.True(root.GetProperty("suggest").GetBoolean());
        Assert.Equal(0.5, root.GetProperty("suggest_width").GetDouble());
        Assert.Equal(0.02, root.GetProperty("tolerance").GetDouble());
        var bridge = Assert.Single(root.GetProperty("bridges").EnumerateArray());
        Assert.Equal(1.5, bridge.GetProperty("width").GetDouble());
        Assert.Equal(6, bridge.GetProperty("length").GetDouble());
        Assert.Equal((15, 7), (bridge.GetProperty("anchor").GetProperty("x").GetDouble(), bridge.GetProperty("anchor").GetProperty("y").GetDouble()));
        Assert.Equal((0, -3), (bridge.GetProperty("direction").GetProperty("x").GetDouble(), bridge.GetProperty("direction").GetProperty("y").GetDouble()));
        Assert.False(bridge.TryGetProperty("island", out _));
        Assert.False(root.GetProperty("subjects")[0].GetProperty("locked").GetBoolean());
        Assert.Equal(2, result.Response!.Bridges.Count);
        Assert.True(result.Response.Bridges[1].Suggested);
    }

    [Fact]
    public async Task BridgeAsync_OmitsSuggestWidthAndOptionalFieldsWhenTheyWereNotRequested()
    {
        string? body = null;
        var client = CreateClient(async (request, _) =>
        {
            body = await request.Content!.ReadAsStringAsync();
            return JsonResponse(HttpStatusCode.OK, GeometryPayloads.BridgeResponse());
        });

        await Bridge(client);

        using var document = JsonDocument.Parse(body!);
        var root = document.RootElement;
        Assert.False(root.GetProperty("suggest").GetBoolean());
        Assert.False(root.TryGetProperty("suggest_width", out _));
        var bridge = root.GetProperty("bridges")[0];
        Assert.Equal(1, bridge.GetProperty("island").GetInt32());
        Assert.False(bridge.TryGetProperty("anchor", out _));
        Assert.False(bridge.TryGetProperty("direction", out _));
        Assert.False(bridge.TryGetProperty("length", out _));
    }

    [Fact]
    public async Task BridgeAsync_AcceptsAnInvalidBridgeWithItsReasonAndNoChanges()
    {
        var invalid = GeometryPayloads.BridgeItem(valid: false, reason: "too_short", reduces: false, affects: "[]");
        var body = GeometryPayloads.BridgeResponse(
            bridgesJson: invalid,
            resultsJson: GeometryPayloads.BridgeSubjectResult(0, false, "[]"),
            floatingAfter: 1,
            pieceCount: 0);

        var result = await Bridge(Responding(body));

        Assert.Equal(PythonGeometryState.Success, result.State);
        Assert.Equal("too_short", result.Response!.Bridges[0].Reason);
        Assert.False(result.Response.Results[0].Changed);
        Assert.Equal(1, result.Response.Reanalysis.FloatingAfter);
    }

    [Fact]
    public async Task BridgeAsync_AcceptsAnInvalidBridgeThatNeverResolvedItsAnchorOrRectangle()
    {
        var invalid = GeometryPayloads.BridgeItem(valid: false, reason: "anchor_outside", island: "null", anchor: "null", direction: "null", length: "null", area: "null", reduces: false, affects: "[]", polygon: "null");
        var body = GeometryPayloads.BridgeResponse(
            bridgesJson: invalid, resultsJson: GeometryPayloads.BridgeSubjectResult(0, false, "[]"), floatingAfter: 1, pieceCount: 0);

        var result = await Bridge(Responding(body));

        Assert.Equal(PythonGeometryState.Success, result.State);
        Assert.Null(result.Response!.Bridges[0].Anchor);
        Assert.Null(result.Response.Bridges[0].Polygon);
    }

    [Theory]
    [InlineData("unknown_island")]
    [InlineData("anchor_outside")]
    [InlineData("width_below_tolerance")]
    [InlineData("invalid_direction")]
    [InlineData("no_crossing")]
    [InlineData("too_short")]
    [InlineData("locked_subject")]
    [InlineData("no_connection")]
    public async Task BridgeAsync_AcceptsEveryDocumentedReasonOfAnInvalidBridge(string reason)
    {
        var invalid = GeometryPayloads.BridgeItem(valid: false, reason: reason, reduces: false, affects: "[]");
        var body = GeometryPayloads.BridgeResponse(
            bridgesJson: invalid, resultsJson: GeometryPayloads.BridgeSubjectResult(0, false, "[]"), floatingAfter: 1, pieceCount: 0);

        var result = await Bridge(Responding(body));

        Assert.Equal(PythonGeometryState.Success, result.State);
        Assert.Equal(reason, result.Response!.Bridges[0].Reason);
    }

    [Fact]
    public async Task BridgeAsync_AcceptsTheSuggestedBridgesAfterTheRequestedOnes()
    {
        var bridges = GeometryPayloads.BridgeItem() + "," + GeometryPayloads.BridgeItem(index: 1, suggested: true, width: 0.5, affects: "[1]");
        var subjects = $"{GeometryPayloads.RingPolygon},{GeometryPayloads.RingPolygon}";
        var results = GeometryPayloads.BridgeSubjectResult(0, true, $"[{GeometryPayloads.OpenedRing}]") + "," + GeometryPayloads.BridgeSubjectResult(1, true, $"[{GeometryPayloads.OpenedRing}]");
        var body = GeometryPayloads.BridgeResponse(bridgesJson: bridges, resultsJson: results, floatingBefore: 2, pieceCount: 2);
        var json = GeometryPayloads.BridgeRequest(subjects: subjects, suggest: "true", suggestWidth: "0.5");

        var result = await Bridge(Responding(body), BridgeParameters(json));

        Assert.Equal(PythonGeometryState.Success, result.State);
        Assert.Equal([false, true], result.Response!.Bridges.Select(bridge => bridge.Suggested));
    }

    // ---- Bridges: respuestas 200 sospechosas ----

    [Theory]
    [InlineData("{\"mode\":\"stencil\"", "{\"mode\":\"parts\"")]
    [InlineData("\"tolerance\":0.01", "\"tolerance\":-1")]
    [InlineData("\"index\":0,\"suggested\"", "\"index\":3,\"suggested\"")] // índice que no es su posición
    [InlineData("\"suggested\":false", "\"suggested\":true")] // un pedido figura como sugerido
    [InlineData("\"width\":0.8", "\"width\":1.2")] // ancho distinto del pedido
    [InlineData("\"reason\":null", "\"reason\":\"too_short\"")] // válido con motivo
    [InlineData("\"island\":1", "\"island\":null")] // válido sin isla
    [InlineData("\"island\":1", "\"island\":-2")]
    [InlineData("\"anchor\":{\"x\":15,\"y\":10}", "\"anchor\":null")]
    [InlineData("\"anchor\":{\"x\":15,\"y\":10}", "\"anchor\":{\"x\":\"NaN\",\"y\":10}")]
    [InlineData("\"direction\":{\"x\":1,\"y\":0}", "\"direction\":null")]
    [InlineData("\"direction\":{\"x\":1,\"y\":0}", "\"direction\":{\"x\":3,\"y\":0}")] // no unitaria
    [InlineData("\"direction\":{\"x\":1,\"y\":0}", "\"direction\":{\"x\":0,\"y\":0}")]
    [InlineData("\"length\":5", "\"length\":null")]
    [InlineData("\"length\":5", "\"length\":0")]
    [InlineData("\"length\":5", "\"length\":-1")]
    [InlineData("\"area\":4", "\"area\":null")]
    [InlineData("\"area\":4", "\"area\":0")]
    [InlineData("\"affects\":[0],\"polygon\"", "\"affects\":[],\"polygon\"")] // válido que no modifica nada
    [InlineData("\"affects\":[0],\"polygon\"", "\"affects\":[7],\"polygon\"")] // forma inexistente
    [InlineData("\"affects\":[0],\"polygon\"", "\"affects\":[-1],\"polygon\"")]
    [InlineData("\"polygon\":{\"type\":\"polygon\",\"coordinates\":[[[14.98,9.6],[20.02,9.6],[20.02,10.4],[14.98,10.4],[14.98,9.6]]]}", "\"polygon\":null")]
    [InlineData("[[14.98,9.6],[20.02,9.6],[20.02,10.4],[14.98,10.4],[14.98,9.6]]", "[[14.98,9.6],[20.02,9.6],[20.02,10.4],[14.98,10.4]]")] // anillo sin cerrar
    [InlineData("[[14.98,9.6],[20.02,9.6],[20.02,10.4],[14.98,10.4],[14.98,9.6]]]}", "[[14.98,9.6],[20.02,9.6],[20.02,10.4],[14.98,10.4],[14.98,9.6]],[[1,1],[2,1],[2,2],[1,1]]]}")] // dos anillos
    [InlineData("\"index\":0,\"suggested\":false,\"valid\":true", "\"index\":0,\"suggested\":false,\"valid\":false")] // inválido sin motivo (reason sigue null)
    public async Task BridgeAsync_WhenAValidBridgeIsIncoherent_ReturnsInvalidResponseAndNeverTheGeometry(string from, string to)
    {
        var result = await Bridge(Responding(Mutate(GeometryPayloads.BridgeResponse(), from, to)));

        Assert.Equal(PythonGeometryState.InvalidResponse, result.State);
        Assert.Null(result.Response);
        Assert.False(string.IsNullOrWhiteSpace(result.Message));
    }

    [Theory]
    [InlineData("\"reason\":\"fuera_de_catalogo\"")] // motivo desconocido
    [InlineData("\"reason\":null")] // inválido sin motivo
    public async Task BridgeAsync_WhenAnInvalidBridgeHasNoKnownReason_ReturnsInvalidResponse(string reason)
    {
        var invalid = GeometryPayloads.BridgeItem(valid: false, reason: "too_short", reduces: false, affects: "[]").Replace("\"reason\":\"too_short\"", reason);
        var body = GeometryPayloads.BridgeResponse(bridgesJson: invalid, resultsJson: GeometryPayloads.BridgeSubjectResult(0, false, "[]"), floatingAfter: 1, pieceCount: 0);

        Assert.Equal(PythonGeometryState.InvalidResponse, (await Bridge(Responding(body))).State);
    }

    [Fact]
    public async Task BridgeAsync_WhenAnInvalidBridgeClaimsToReduce_ReturnsInvalidResponse()
    {
        var invalid = GeometryPayloads.BridgeItem(valid: false, reason: "too_short", reduces: true, affects: "[]");
        var body = GeometryPayloads.BridgeResponse(bridgesJson: invalid, resultsJson: GeometryPayloads.BridgeSubjectResult(0, false, "[]"), floatingAfter: 1, pieceCount: 0);

        Assert.Equal(PythonGeometryState.InvalidResponse, (await Bridge(Responding(body))).State);
    }

    [Fact]
    public async Task BridgeAsync_WhenAValidBridgeTouchesALockedSubject_ReturnsInvalidResponse()
    {
        // La forma 0 está bloqueada: el servidor NUNCA debe modificarla, y el editor no puede aplicar un resultado que dice haberlo hecho.
        var locked = $$"""{"type":"polygon","coordinates":[[[0,0],[20,0],[20,20],[0,20]],[[5,5],[15,5],[15,15],[5,15]]],"locked":true}""";
        var parameters = BridgeParameters(GeometryPayloads.BridgeRequest(subjects: locked));

        var result = await Bridge(Responding(GeometryPayloads.BridgeResponse()), parameters);

        Assert.Equal(PythonGeometryState.InvalidResponse, result.State);
        Assert.Null(result.Response);
    }

    [Fact]
    public async Task BridgeAsync_WhenALockedSubjectIsReportedAsChanged_ReturnsInvalidResponse()
    {
        var locked = """{"type":"polygon","coordinates":[[[0,0],[20,0],[20,20],[0,20]],[[5,5],[15,5],[15,15],[5,15]]],"locked":true}""";
        var invalid = GeometryPayloads.BridgeItem(valid: false, reason: "locked_subject", reduces: false, affects: "[]");
        var body = GeometryPayloads.BridgeResponse(
            bridgesJson: invalid, resultsJson: GeometryPayloads.BridgeSubjectResult(0, true, $"[{GeometryPayloads.OpenedRing}]"), floatingAfter: 1, pieceCount: 1);

        var result = await Bridge(Responding(body), BridgeParameters(GeometryPayloads.BridgeRequest(subjects: locked)));

        Assert.Equal(PythonGeometryState.InvalidResponse, result.State);
    }

    [Fact]
    public async Task BridgeAsync_WhenThereAreFewerOrMoreBridgesThanRequested_ReturnsInvalidResponse()
    {
        var two = GeometryPayloads.BridgeItem() + "," + GeometryPayloads.BridgeItem(index: 1, suggested: true);

        // Sin `suggest`, ni de más ni de menos; con `suggest`, de menos tampoco.
        Assert.Equal(PythonGeometryState.InvalidResponse, (await Bridge(Responding(GeometryPayloads.BridgeResponse(bridgesJson: two)))).State);
        var bothRequested = GeometryPayloads.BridgeRequest(bridges: """{"island":1,"width":0.8},{"island":1,"width":0.8}""");
        Assert.Equal(PythonGeometryState.InvalidResponse, (await Bridge(Responding(GeometryPayloads.BridgeResponse()), BridgeParameters(bothRequested))).State);
    }

    [Fact]
    public async Task BridgeAsync_WhenASuggestedBridgeDoesNotUseTheSuggestedWidth_ReturnsInvalidResponse()
    {
        var bridges = GeometryPayloads.BridgeItem() + "," + GeometryPayloads.BridgeItem(index: 1, suggested: true, width: 0.9);
        var json = GeometryPayloads.BridgeRequest(suggest: "true", suggestWidth: "0.5");
        var body = GeometryPayloads.BridgeResponse(bridgesJson: bridges);

        Assert.Equal(PythonGeometryState.InvalidResponse, (await Bridge(Responding(body), BridgeParameters(json))).State);
    }

    [Fact]
    public async Task BridgeAsync_WhenThereIsNotOneResultPerSubject_ReturnsInvalidResponse()
    {
        var empty = GeometryPayloads.BridgeResponse(resultsJson: string.Empty, pieceCount: 0);
        var twoSubjects = BridgeParameters(GeometryPayloads.BridgeRequest(subjects: $"{GeometryPayloads.RingPolygon},{GeometryPayloads.RingPolygon}"));

        Assert.Equal(PythonGeometryState.InvalidResponse, (await Bridge(Responding(empty))).State);
        Assert.Equal(PythonGeometryState.InvalidResponse, (await Bridge(Responding(GeometryPayloads.BridgeResponse()), twoSubjects)).State);
    }

    [Fact]
    public async Task BridgeAsync_WhenTheSubjectIndexDoesNotMatchThePosition_ReturnsInvalidResponse()
    {
        var body = GeometryPayloads.BridgeResponse(resultsJson: GeometryPayloads.BridgeSubjectResult(2, true, $"[{GeometryPayloads.OpenedRing}]"));

        Assert.Equal(PythonGeometryState.InvalidResponse, (await Bridge(Responding(body))).State);
    }

    [Fact]
    public async Task BridgeAsync_WhenChangedDoesNotMatchTheValidBridgesThatTouchTheSubject_ReturnsInvalidResponse()
    {
        // El bridge válido modifica la forma 0, pero el resultado dice que no cambió (o al revés): el editor aplicaría algo que no pasó.
        var unchanged = GeometryPayloads.BridgeResponse(resultsJson: GeometryPayloads.BridgeSubjectResult(0, false, "[]"), pieceCount: 0);
        var noBridge = GeometryPayloads.BridgeResponse(
            bridgesJson: GeometryPayloads.BridgeItem(valid: false, reason: "too_short", reduces: false, affects: "[]"), floatingAfter: 1);

        Assert.Equal(PythonGeometryState.InvalidResponse, (await Bridge(Responding(unchanged))).State);
        Assert.Equal(PythonGeometryState.InvalidResponse, (await Bridge(Responding(noBridge))).State);
    }

    [Fact]
    public async Task BridgeAsync_WhenAnUnchangedSubjectCarriesGeometry_ReturnsInvalidResponse()
    {
        var invalid = GeometryPayloads.BridgeItem(valid: false, reason: "too_short", reduces: false, affects: "[]");
        var body = GeometryPayloads.BridgeResponse(
            bridgesJson: invalid, resultsJson: GeometryPayloads.BridgeSubjectResult(0, false, $"[{GeometryPayloads.OpenedRing}]"), floatingAfter: 1);

        Assert.Equal(PythonGeometryState.InvalidResponse, (await Bridge(Responding(body))).State);
    }

    [Theory]
    [InlineData("""[{"type":"polygon","coordinates":[[[0,0],[20,0],[20,20],[0,20]]]}]""")] // anillo sin cerrar
    [InlineData("""[{"type":"polygon","coordinates":[]}]""")]
    [InlineData("""[{"type":"line","coordinates":[[0,0],[1,1]]}]""")] // los bridges solo devuelven polígonos
    [InlineData("""[{"type":"polygon","coordinates":[[[0,0],["NaN",0],[1,1],[0,0]]]}]""")]
    [InlineData("""[{"type":"circle","coordinates":[]}]""")]
    public async Task BridgeAsync_WhenAResultingPieceIsMalformed_ReturnsInvalidResponse(string pieces)
    {
        var body = GeometryPayloads.BridgeResponse(resultsJson: GeometryPayloads.BridgeSubjectResult(0, true, pieces));

        var result = await Bridge(Responding(body));

        Assert.Equal(PythonGeometryState.InvalidResponse, result.State);
        Assert.Null(result.Response);
    }

    [Theory]
    [InlineData(1, 2, 1)] // más flotantes DESPUÉS de bridges que solo pueden reducir
    [InlineData(1, -1, 1)]
    [InlineData(-1, 0, 1)]
    [InlineData(1, 0, -1)]
    public async Task BridgeAsync_WhenTheReanalysisIsIncoherent_ReturnsInvalidResponse(int before, int after, int main)
    {
        var body = GeometryPayloads.BridgeResponse(floatingBefore: before, floatingAfter: after, mainAfter: main);

        Assert.Equal(PythonGeometryState.InvalidResponse, (await Bridge(Responding(body))).State);
    }

    [Fact]
    public async Task BridgeAsync_WhenNoBridgeIsValidButTheReanalysisChanges_ReturnsInvalidResponse()
    {
        var invalid = GeometryPayloads.BridgeItem(valid: false, reason: "too_short", reduces: false, affects: "[]");
        var body = GeometryPayloads.BridgeResponse(
            bridgesJson: invalid, resultsJson: GeometryPayloads.BridgeSubjectResult(0, false, "[]"), floatingBefore: 2, floatingAfter: 1, pieceCount: 0);

        Assert.Equal(PythonGeometryState.InvalidResponse, (await Bridge(Responding(body))).State);
    }

    [Fact]
    public async Task BridgeAsync_WhenThePieceCountDoesNotMatch_ReturnsInvalidResponse()
    {
        var result = await Bridge(Responding(GeometryPayloads.BridgeResponse(pieceCount: 4)));

        Assert.Equal(PythonGeometryState.InvalidResponse, result.State);
        Assert.Contains("piece_count", result.Message);
    }

    [Theory]
    [InlineData("esto no es JSON")]
    [InlineData("")]
    [InlineData("{}")]
    [InlineData("null")]
    [InlineData("""{"mode":"stencil","tolerance":0.01,"bridges":[],"results":[],"piece_count":0}""")]
    public async Task BridgeAsync_WhenTheBodyIsNotValidOrIncomplete_ReturnsInvalidResponse(string body)
    {
        var result = await Bridge(Responding(body));

        Assert.Equal(PythonGeometryState.InvalidResponse, result.State);
        Assert.Null(result.Response);
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
