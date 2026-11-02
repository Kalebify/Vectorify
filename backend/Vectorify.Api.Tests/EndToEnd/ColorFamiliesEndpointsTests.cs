using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Vectorify.Api.ColorPalette;
using Vectorify.Api.Contracts;
using Vectorify.Api.Tests.TestSupport;

namespace Vectorify.Api.Tests.EndToEnd;

/// <summary>
/// HTTP de punta a punta de la agrupación por familias (Web API real + motor Python simulado):
/// detect con estilo base_colors -> reabrir (GET) -> confirmar -> capas. Verifica que el estilo, los
/// parámetros efectivos y la versión del algoritmo viajan y se conservan, que el fondo técnico no
/// genera capa salvo acción explícita y que el estilo detallado sigue siendo el valor por defecto de
/// la API (CA-01, CA-02, CA-10).
/// </summary>
public sealed class ColorFamiliesEndpointsTests : IDisposable
{
    private readonly string _storageRoot = Path.Combine(Path.GetTempPath(), "vectorify-families-e2e-" + Guid.NewGuid().ToString("n"));
    private readonly string _registryRoot = Path.Combine(Path.GetTempPath(), "vectorify-families-e2e-reg-" + Guid.NewGuid().ToString("n"));

    private static string Root(UploadImageResponse upload) => $"/api/v1/projects/{upload.ProjectId}/images/{upload.ImageId}/color-palette";

    private static async Task<UploadImageResponse> UploadAsync(HttpClient client)
    {
        using var content = new MultipartFormDataContent();
        var file = new ByteArrayContent(SampleImages.ValidPng1x1);
        file.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("image/png");
        content.Add(file, "file", "pato.png");
        var response = await client.PostAsync("/api/v1/projects", content);
        response.EnsureSuccessStatusCode();
        return (await response.Content.ReadFromJsonAsync<UploadImageResponse>())!;
    }

    private static async Task<ColorPaletteResponse> DetectFamiliesAsync(HttpClient client, UploadImageResponse upload)
    {
        var response = await client.PostAsJsonAsync(
            $"{Root(upload)}/detect", new ColorPaletteDetectRequest(null, null, null, null, "base_colors", 5, 0.5));
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<ColorPaletteResponse>())!;
    }

    [Fact]
    public async Task Detect_WithBaseColors_ReturnsFamiliesBackgroundAndEffectiveParameters_AndReopeningKeepsThem()
    {
        await using var python = await FakePythonPreprocessServer.StartAsync(
            _ => (200, "{}"), respondColorPalette: _ => (200, ColorPalettePayloads.FamiliesBody()));
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();
        var upload = await UploadAsync(client);

        var palette = await DetectFamiliesAsync(client, upload);

        Assert.Equal("base_colors", palette.GroupingStyle);
        Assert.Equal(5, palette.TargetFamilies);
        Assert.Equal(0.5, palette.GroupingStrength);
        Assert.Equal(ColorPaletteAlgorithm.CurrentVersion, palette.AlgorithmVersion);
        Assert.Equal(2, palette.FamilyCount);
        Assert.Equal(4, palette.PieceCount);
        Assert.True(palette.Background!.NeedsReview);
        Assert.Equal(new[] { "Familia 1", "Familia 2", "Fondo" }, palette.Groups.Select(g => g.Name));
        var background = palette.Groups[^1];
        Assert.True(background.IsBackground);
        Assert.True(background.IsExcluded);
        Assert.All(palette.Groups.Take(2), g => Assert.False(g.IsExcluded || g.IsBackground));

        var reopened = (await client.GetFromJsonAsync<ColorPaletteResponse>($"{Root(upload)}/{palette.PaletteId}"))!;
        Assert.Equal("base_colors", reopened.GroupingStyle);
        Assert.Equal(5, reopened.TargetFamilies);
        Assert.Equal(palette.Groups.Select(g => g.GroupId), reopened.Groups.Select(g => g.GroupId));
    }

    [Fact]
    public async Task Detect_WithMarkedZones_SendsThemToThePythonEngineAndTheEchoSurvivesReopening()
    {
        await using var python = await FakePythonPreprocessServer.StartAsync(
            _ => (200, "{}"), respondColorPalette: _ => (200, ColorPalettePayloads.FamiliesBody()));
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();
        var upload = await UploadAsync(client);
        var zone = new BackgroundCorrection([[1.0, 1.0], [8.0, 1.0], [8.0, 8.0]]);

        var response = await client.PostAsJsonAsync(
            $"{Root(upload)}/detect", new ColorPaletteDetectRequest(null, null, null, null, "base_colors", 5, 0.5, [zone]));
        var palette = (await response.Content.ReadFromJsonAsync<ColorPaletteResponse>())!;

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        Assert.Single(palette.BackgroundCorrections!);
        Assert.Equal(new[] { 1.0, 1.0 }, palette.BackgroundCorrections![0].Points[0]);
        Assert.Contains("\"background_corrections\":[{\"points\":[[1,1],[8,1],[8,8]]}]", python.LastColorPaletteParams, StringComparison.Ordinal);
        var reopened = (await client.GetFromJsonAsync<ColorPaletteResponse>($"{Root(upload)}/{palette.PaletteId}"))!;
        Assert.Equal(3, reopened.BackgroundCorrections![0].Points.Count);
    }

    [Fact]
    public async Task Detect_WithoutMarkedZones_ReportsNone()
    {
        await using var python = await FakePythonPreprocessServer.StartAsync(
            _ => (200, "{}"), respondColorPalette: _ => (200, ColorPalettePayloads.FamiliesBody()));
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();
        var upload = await UploadAsync(client);

        var palette = await DetectFamiliesAsync(client, upload);

        Assert.Null(palette.BackgroundCorrections);
    }

    [Fact]
    public async Task Detect_WithTooManyZones_ReturnsBadRequest()
    {
        await using var python = await FakePythonPreprocessServer.StartAsync(
            _ => (200, "{}"), respondColorPalette: _ => (200, ColorPalettePayloads.FamiliesBody()));
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();
        var upload = await UploadAsync(client);
        var zones = Enumerable.Repeat(new BackgroundCorrection([[0.0, 0.0], [1.0, 0.0], [1.0, 1.0]]), BackgroundCorrection.MaxRegions + 1).ToList();

        var response = await client.PostAsJsonAsync(
            $"{Root(upload)}/detect", new ColorPaletteDetectRequest(null, null, null, null, "base_colors", 5, 0.5, zones));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Detect_WithoutStyle_KeepsTheDetailedBehaviorAndReportsNoBackground()
    {
        await using var python = await FakePythonPreprocessServer.StartAsync(
            _ => (200, "{}"), respondColorPalette: _ => (200, ColorPalettePayloads.SuccessBody()));
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();
        var upload = await UploadAsync(client);

        var response = await client.PostAsJsonAsync($"{Root(upload)}/detect", new ColorPaletteDetectRequest(null, null, null));
        var palette = (await response.Content.ReadFromJsonAsync<ColorPaletteResponse>())!;

        Assert.Equal("detailed", palette.GroupingStyle);
        Assert.Null(palette.TargetFamilies);
        Assert.Null(palette.Background);
        Assert.All(palette.Groups, g => Assert.False(g.IsBackground));
    }

    [Theory]
    [InlineData("other", null, null)]
    [InlineData("base_colors", 0, null)]
    [InlineData("base_colors", null, 2.0)]
    public async Task Detect_WithInvalidGroupingParameters_ReturnsBadRequest(string style, int? target, double? strength)
    {
        await using var python = await FakePythonPreprocessServer.StartAsync(
            _ => (200, "{}"), respondColorPalette: _ => (200, ColorPalettePayloads.FamiliesBody()));
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();
        var upload = await UploadAsync(client);

        var response = await client.PostAsJsonAsync(
            $"{Root(upload)}/detect", new ColorPaletteDetectRequest(null, null, null, null, style, target, strength));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var error = await response.Content.ReadFromJsonAsync<ApiErrorResponse>();
        Assert.Equal("invalid_parameters", error!.Code);
    }

    [Fact]
    public async Task ConfirmedFamilyPalette_GeneratesOneLayerPerGroup_AndTheTechnicalBackgroundStaysExcluded()
    {
        await using var python = await FakePythonPreprocessServer.StartAsync(
            _ => (200, "{}"), respondColorPalette: _ => (200, ColorPalettePayloads.FamiliesBody()));
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();
        var upload = await UploadAsync(client);
        var palette = await DetectFamiliesAsync(client, upload);
        (await client.PostAsync($"{Root(upload)}/{palette.PaletteId}/confirm", null)).EnsureSuccessStatusCode();

        (await client.PostAsync($"{Root(upload)}/{palette.PaletteId}/layers", null)).EnsureSuccessStatusCode();
        var layers = (await client.GetFromJsonAsync<ConsolidatedVectorLayerSetResponse>(
            $"{Root(upload)}/{palette.PaletteId}/layers/consolidated"))!;
        var confirmed = (await client.GetFromJsonAsync<ColorPaletteResponse>($"{Root(upload)}/{palette.PaletteId}"))!;

        // Una capa por grupo: 2 familias + el fondo técnico (que sigue marcado como excluido).
        Assert.Equal(3, layers.Layers.Count);
        Assert.Equal(new[] { "#c8551f", "#bea90e", "#ffffff" }, layers.Layers.Select(l => l.ColorHex));
        Assert.True(confirmed.IsConfirmed);
        Assert.Equal(2, confirmed.FamilyCount);
        var excludedIds = confirmed.Groups.Where(g => g.IsExcluded).Select(g => g.GroupId).ToArray();
        Assert.Equal(new[] { palette.Groups.Single(g => g.IsBackground).GroupId }, excludedIds);
        Assert.Contains(layers.Layers, l => l.Id == excludedIds[0] && l.ColorHex == "#ffffff");
    }

    [Fact]
    public async Task IncludingTheTechnicalBackground_IsAnExplicitUserAction_AndSurvivesConfirmation()
    {
        await using var python = await FakePythonPreprocessServer.StartAsync(
            _ => (200, "{}"), respondColorPalette: _ => (200, ColorPalettePayloads.FamiliesBody()));
        await using var factory = CreateFactory(python.BaseUrl);
        var client = factory.CreateClient();
        var upload = await UploadAsync(client);
        var palette = await DetectFamiliesAsync(client, upload);
        var backgroundId = palette.Groups.Single(g => g.IsBackground).GroupId;

        var response = await client.PostAsJsonAsync(
            $"{Root(upload)}/{palette.PaletteId}/exclude", new ColorPaletteSetExclusionRequest(backgroundId, false));
        var included = (await response.Content.ReadFromJsonAsync<ColorPaletteResponse>())!;
        (await client.PostAsync($"{Root(upload)}/{palette.PaletteId}/confirm", null)).EnsureSuccessStatusCode();
        (await client.PostAsync($"{Root(upload)}/{palette.PaletteId}/layers", null)).EnsureSuccessStatusCode();
        var layers = (await client.GetFromJsonAsync<ConsolidatedVectorLayerSetResponse>(
            $"{Root(upload)}/{palette.PaletteId}/layers/consolidated"))!;

        var confirmed = (await client.GetFromJsonAsync<ColorPaletteResponse>($"{Root(upload)}/{palette.PaletteId}"))!;
        Assert.False(included.Groups.Single(g => g.IsBackground).IsExcluded);
        Assert.False(confirmed.Groups.Single(g => g.IsBackground).IsExcluded);
        Assert.Equal(3, layers.Layers.Count);
    }

    private WebApplicationFactory<Program> CreateFactory(string pythonBaseUrl) =>
        new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
        {
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["PythonEngine:BaseUrl"] = pythonBaseUrl,
                    ["Cors:AllowedOrigins"] = "http://localhost:5173",
                    ["Storage:RootPath"] = _storageRoot,
                    ["ProjectRegistry:RootPath"] = _registryRoot,
                });
            });
        });

    public void Dispose()
    {
        foreach (var path in new[] { _storageRoot, _registryRoot })
        {
            if (Directory.Exists(path))
            {
                Directory.Delete(path, recursive: true);
            }
        }
    }
}
