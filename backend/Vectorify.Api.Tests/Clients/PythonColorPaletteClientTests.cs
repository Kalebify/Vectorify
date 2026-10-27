using System.Net;
using System.Text;
using Microsoft.Extensions.Logging.Abstractions;
using Vectorify.Api.ColorPalette;
using Vectorify.Api.Clients;
using Vectorify.Api.Tests.TestSupport;

namespace Vectorify.Api.Tests.Clients;

/// <summary>
/// Pruebas unitarias de PythonColorPaletteClient contra un HttpMessageHandler
/// stub (sin red real, sin motor Python): cubren los estados exigidos por el
/// contrato y, sobre todo, la validación defensiva adicional (Defecto 3 de
/// la ronda de QA sobre M1-S05/M1-S06, mismo criterio en toda la etapa) que
/// Vectorify.Api aplica antes de confiar en la respuesta de Python -- color_hex
/// mal formado, porcentajes fuera de rango, Content-Type inesperado,
/// metrics.color_count inconsistente con la cantidad de grupos. Mismo
/// criterio que PythonThresholdClientTests/PythonSimplifyClientTests.
/// </summary>
public sealed class PythonColorPaletteClientTests
{
    private static readonly ColorPaletteParameters SampleParameters = new(12.0, 8, 0.001);

    private static PythonColorPaletteClient CreateClient(
        Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> handlerFunc,
        TimeSpan? timeout = null)
    {
        var httpClient = new HttpClient(new StubHttpMessageHandler(handlerFunc))
        {
            BaseAddress = new Uri("http://python-engine.test"),
            Timeout = timeout ?? TimeSpan.FromSeconds(5),
        };

        return new PythonColorPaletteClient(httpClient, NullLogger<PythonColorPaletteClient>.Instance);
    }

    private static Task<PythonColorPaletteResult> InvokeAsync(PythonColorPaletteClient client) =>
        client.DetectAsync(new MemoryStream([1, 2, 3]), "image/png", "original.png", SampleParameters);

    [Fact]
    public async Task DetectAsync_WhenResponseIsValid_ReturnsSuccessWithDecodedGroups()
    {
        var client = CreateClient((_, _) => Task.FromResult(JsonResponse(
            HttpStatusCode.OK, ColorPalettePayloads.SuccessBody(width: 32, height: 16, transparentPercent: 5.0))));

        var result = await InvokeAsync(client);

        Assert.Equal(PythonColorPaletteState.Success, result.State);
        Assert.Equal(32, result.Width);
        Assert.Equal(16, result.Height);
        Assert.Equal("image/png", result.ContentType);
        Assert.Equal(5.0, result.TransparentPercent);
        Assert.NotNull(result.Groups);
        Assert.Single(result.Groups!);
        Assert.Equal("#3a6ea5", result.Groups![0].ColorHex);
        Assert.NotEmpty(result.Groups![0].MaskBytes);
        Assert.NotNull(result.QuantizedPreviewBytes);
        Assert.NotEmpty(result.QuantizedPreviewBytes!);
    }

    [Fact]
    public async Task DetectAsync_WhenResponseHasTouchesBorderTrue_PropagatesItOnTheGroup()
    {
        var client = CreateClient((_, _) => Task.FromResult(JsonResponse(
            HttpStatusCode.OK, ColorPalettePayloads.SuccessBody(touchesBorder: true))));

        var result = await InvokeAsync(client);

        Assert.Equal(PythonColorPaletteState.Success, result.State);
        Assert.True(result.Groups![0].TouchesBorder);
    }

    [Fact]
    public async Task DetectAsync_SendsTinyAreaRatioAsPartOfTheParamsField()
    {
        string? capturedBody = null;
        var client = CreateClient(async (request, _) =>
        {
            capturedBody = await request.Content!.ReadAsStringAsync();
            return JsonResponse(HttpStatusCode.OK, ColorPalettePayloads.SuccessBody());
        });

        await client.DetectAsync(
            new MemoryStream([1, 2, 3]), "image/png", "original.png", new ColorPaletteParameters(12.0, 8, 0.0025));

        Assert.NotNull(capturedBody);
        Assert.Contains("\"tiny_area_ratio\":0.0025", capturedBody, StringComparison.Ordinal);
    }

    [Fact]
    public async Task DetectAsync_SendsTheGroupingParametersAsPartOfTheParamsField()
    {
        string? capturedBody = null;
        var client = CreateClient(async (request, _) =>
        {
            capturedBody = await request.Content!.ReadAsStringAsync();
            return JsonResponse(HttpStatusCode.OK, ColorPalettePayloads.FamiliesBody());
        });

        await client.DetectAsync(
            new MemoryStream([1, 2, 3]), "image/png", "original.png",
            new ColorPaletteParameters(12.0, null, 0.001, "base_colors", 5, 0.4, ColorPaletteAlgorithm.CurrentVersion));

        Assert.Contains("\"grouping_style\":\"base_colors\"", capturedBody, StringComparison.Ordinal);
        Assert.Contains("\"target_families\":5", capturedBody, StringComparison.Ordinal);
        Assert.Contains("\"grouping_strength\":0.4", capturedBody, StringComparison.Ordinal);
    }

    [Fact]
    public async Task DetectAsync_WhenResponseHasFamilies_DecodesBackgroundPiecesAndAlgorithmVersion()
    {
        var client = CreateClient((_, _) => Task.FromResult(JsonResponse(HttpStatusCode.OK, ColorPalettePayloads.FamiliesBody())));

        var result = await InvokeAsync(client);

        Assert.Equal(PythonColorPaletteState.Success, result.State);
        Assert.Equal(new[] { false, false, true }, result.Groups!.Select(g => g.IsBackground));
        Assert.Equal(new[] { 3, 1, 1 }, result.Groups!.Select(g => g.PieceCount));
        Assert.Equal(new[] { 11, 9, 1 }, result.Groups!.Select(g => g.SourceGroupCount));
        Assert.Equal(new BackgroundInfo(60.0, 0.0, 20.0, true), result.Background);
        Assert.Equal(1, result.AlgorithmVersion);
    }

    [Fact]
    public async Task DetectAsync_WhenAnEngineWithoutFamilySupportAnswers_KeepsTheLegacyShapeAndVersionZero()
    {
        var client = CreateClient((_, _) => Task.FromResult(JsonResponse(HttpStatusCode.OK, ColorPalettePayloads.SuccessBody())));

        var result = await InvokeAsync(client);

        Assert.Equal(PythonColorPaletteState.Success, result.State);
        Assert.False(result.Groups![0].IsBackground);
        Assert.Equal(1, result.Groups![0].SourceGroupCount);
        Assert.Null(result.Background);
        Assert.Equal(0, result.AlgorithmVersion);
    }

    [Fact]
    public async Task DetectAsync_WhenTheEngineReturnsTwoBackgroundGroups_RejectsTheResponse()
    {
        var body = ColorPalettePayloads.FamiliesBody().Replace(
            "\"is_background\": false, \"source_group_count\": 9", "\"is_background\": true, \"source_group_count\": 9");
        var client = CreateClient((_, _) => Task.FromResult(JsonResponse(HttpStatusCode.OK, body)));

        var result = await InvokeAsync(client);

        Assert.Equal(PythonColorPaletteState.InvalidPaletteResponse, result.State);
    }

    [Fact]
    public async Task DetectAsync_WhenPythonReturnsCorruptImage_ReturnsCorruptImageState()
    {
        var client = CreateClient((_, _) => Task.FromResult(JsonResponse(
            HttpStatusCode.BadRequest, ColorPalettePayloads.ErrorBody("corrupt_image", "no se pudo decodificar"))));

        var result = await InvokeAsync(client);

        Assert.Equal(PythonColorPaletteState.CorruptImage, result.State);
    }

    [Fact]
    public async Task DetectAsync_WhenPythonReturnsDimensionsExceeded_ReturnsDimensionsExceededState()
    {
        var client = CreateClient((_, _) => Task.FromResult(JsonResponse(
            (HttpStatusCode)413, ColorPalettePayloads.ErrorBody("dimensions_exceeded", "demasiado grande"))));

        var result = await InvokeAsync(client);

        Assert.Equal(PythonColorPaletteState.DimensionsExceeded, result.State);
    }

    [Fact]
    public async Task DetectAsync_WhenPythonReturnsInvalidParameters_ReturnsInvalidParametersState()
    {
        var client = CreateClient((_, _) => Task.FromResult(JsonResponse(
            (HttpStatusCode)422, ColorPalettePayloads.ErrorBody("invalid_parameters", "fuera de rango"))));

        var result = await InvokeAsync(client);

        Assert.Equal(PythonColorPaletteState.InvalidParameters, result.State);
    }

    [Fact]
    public async Task DetectAsync_WhenConnectionRefused_ReturnsUnavailable()
    {
        var client = CreateClient((_, _) => throw new HttpRequestException("Connection refused"));

        var result = await InvokeAsync(client);

        Assert.Equal(PythonColorPaletteState.Unavailable, result.State);
    }

    [Fact]
    public async Task DetectAsync_WhenRequestExceedsTimeout_ReturnsTimeout()
    {
        var client = CreateClient(
            async (_, ct) =>
            {
                await Task.Delay(TimeSpan.FromSeconds(5), ct);
                return JsonResponse(HttpStatusCode.OK, ColorPalettePayloads.SuccessBody());
            },
            timeout: TimeSpan.FromMilliseconds(50));

        var result = await InvokeAsync(client);

        Assert.Equal(PythonColorPaletteState.Timeout, result.State);
    }

    [Fact]
    public async Task DetectAsync_WhenBodyIsNotJson_ReturnsInvalidResponse()
    {
        var client = CreateClient((_, _) => Task.FromResult(JsonResponse(HttpStatusCode.OK, "<html>not json</html>")));

        var result = await InvokeAsync(client);

        Assert.Equal(PythonColorPaletteState.InvalidResponse, result.State);
    }

    [Fact]
    public async Task DetectAsync_WhenRequiredFieldsAreMissing_ReturnsInvalidResponse()
    {
        var client = CreateClient((_, _) => Task.FromResult(JsonResponse(HttpStatusCode.OK, """{"width": 1}""")));

        var result = await InvokeAsync(client);

        Assert.Equal(PythonColorPaletteState.InvalidResponse, result.State);
    }

    [Fact]
    public async Task DetectAsync_WhenHttpStatusIsUnmappedError_ReturnsHttpError()
    {
        var client = CreateClient((_, _) => Task.FromResult(JsonResponse(HttpStatusCode.InternalServerError, "")));

        var result = await InvokeAsync(client);

        Assert.Equal(PythonColorPaletteState.HttpError, result.State);
    }

    [Fact]
    public async Task DetectAsync_WhenColorHexIsMalformed_ReturnsInvalidPaletteResponse()
    {
        var body = ColorPalettePayloads.SuccessBody().Replace("#3a6ea5", "not-a-color");
        var client = CreateClient((_, _) => Task.FromResult(JsonResponse(HttpStatusCode.OK, body)));

        var result = await InvokeAsync(client);

        Assert.Equal(PythonColorPaletteState.InvalidPaletteResponse, result.State);
    }

    [Fact]
    public async Task DetectAsync_WhenColorCountDoesNotMatchGroupCount_ReturnsInvalidPaletteResponse()
    {
        var body = ColorPalettePayloads.SuccessBody().Replace("\"color_count\": 1", "\"color_count\": 5");
        var client = CreateClient((_, _) => Task.FromResult(JsonResponse(HttpStatusCode.OK, body)));

        var result = await InvokeAsync(client);

        Assert.Equal(PythonColorPaletteState.InvalidPaletteResponse, result.State);
    }

    [Fact]
    public async Task DetectAsync_WhenTransparentPercentIsOutOfRange_ReturnsInvalidPaletteResponse()
    {
        var body = ColorPalettePayloads.SuccessBody(transparentPercent: 5.0).Replace("\"transparent_percent\": 5", "\"transparent_percent\": 250.0");
        var client = CreateClient((_, _) => Task.FromResult(JsonResponse(HttpStatusCode.OK, body)));

        var result = await InvokeAsync(client);

        Assert.Equal(PythonColorPaletteState.InvalidPaletteResponse, result.State);
    }

    [Fact]
    public async Task DetectAsync_WhenContentTypeIsUnexpected_ReturnsInvalidPaletteResponse()
    {
        var body = ColorPalettePayloads.SuccessBody().Replace("\"content_type\": \"image/png\"", "\"content_type\": \"image/jpeg\"");
        var client = CreateClient((_, _) => Task.FromResult(JsonResponse(HttpStatusCode.OK, body)));

        var result = await InvokeAsync(client);

        Assert.Equal(PythonColorPaletteState.InvalidPaletteResponse, result.State);
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
