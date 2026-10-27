using System.Text.Json;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Vectorify.Api.Clients;
using Vectorify.Api.ColorPalette;
using Vectorify.Api.Contracts;
using Vectorify.Api.Options;
using Vectorify.Api.Projects;
using Vectorify.Api.Tests.Projects;
using Vectorify.Api.Tests.TestSupport;

namespace Vectorify.Api.Tests.ColorPalette;

/// <summary>
/// Agrupación por familias de color base (tarjeta "Agrupar sombras y variantes en
/// colores base antes de vectorizar"): validación de los parámetros nuevos, clave
/// de caché con estilo/parámetros/versión de algoritmo, compatibilidad con
/// sidecars anteriores (CA-10) y orquestación del grupo técnico de fondo.
/// </summary>
public sealed class ColorFamilyGroupingTests : IDisposable
{
    private static readonly Guid ProjectId = Guid.NewGuid();
    private static readonly Guid ImageId = Guid.NewGuid();
    private const string SourceStorageKey = "project/image/original.png";
    private readonly string _rootPath = Path.Combine(Path.GetTempPath(), "vectorify-families-tests-" + Guid.NewGuid().ToString("n"));

    public void Dispose()
    {
        if (Directory.Exists(_rootPath))
        {
            Directory.Delete(_rootPath, recursive: true);
        }
    }

    private static ColorPaletteParameterValidator CreateValidator() =>
        new(Microsoft.Extensions.Options.Options.Create(new ColorPaletteOptions()));

    private static ColorPaletteDetectRequest BaseColors(int? target = null, double? strength = null, int? maxColors = null) =>
        new(null, null, maxColors, null, "base_colors", target, strength);

    // ---- Validación ----

    [Fact]
    public void Validate_WhenStyleIsOmitted_DefaultsToDetailedAndStampsTheCurrentAlgorithmVersion()
    {
        var result = CreateValidator().Validate(new ColorPaletteDetectRequest(null, null, null));

        Assert.True(result.IsValid);
        Assert.Equal("detailed", result.Parameters!.GroupingStyle);
        Assert.Null(result.Parameters.TargetFamilies);
        Assert.Equal(ColorPaletteAlgorithm.CurrentVersion, result.Parameters.AlgorithmVersion);
    }

    [Fact]
    public void Validate_BaseColors_RecordsTargetAndStrengthAndIgnoresMaxColors()
    {
        var result = CreateValidator().Validate(BaseColors(target: 5, strength: 0.3, maxColors: 9));

        Assert.True(result.IsValid);
        Assert.Equal("base_colors", result.Parameters!.GroupingStyle);
        Assert.Equal(5, result.Parameters.TargetFamilies);
        Assert.Equal(0.3, result.Parameters.GroupingStrength);
        Assert.Null(result.Parameters.MaxColors);
    }

    [Fact]
    public void Validate_BaseColors_WithoutStrength_UsesTheConfiguredDefault()
    {
        var result = CreateValidator().Validate(BaseColors());

        Assert.True(result.IsValid);
        Assert.Equal(new ColorPaletteOptions().DefaultGroupingStrength, result.Parameters!.GroupingStrength);
        Assert.Null(result.Parameters.TargetFamilies);
    }

    [Fact]
    public void Validate_Detailed_NormalizesTheIgnoredFamilyParameters()
    {
        var result = CreateValidator().Validate(new ColorPaletteDetectRequest(null, 12, 8, null, "detailed", 3, 0.9));

        Assert.True(result.IsValid);
        Assert.Null(result.Parameters!.TargetFamilies);
        Assert.Equal(0.5, result.Parameters.GroupingStrength);
        Assert.Equal(8, result.Parameters.MaxColors);
    }

    [Theory]
    [InlineData("other", null, null)]
    [InlineData("base_colors", 0, null)]
    [InlineData("base_colors", 17, null)]
    [InlineData("base_colors", null, -0.1)]
    [InlineData("base_colors", null, 1.1)]
    [InlineData("base_colors", null, double.NaN)]
    public void Validate_WithInvalidGroupingParameters_ReturnsInvalidParameters(string style, int? target, double? strength)
    {
        var result = CreateValidator().Validate(new ColorPaletteDetectRequest(null, null, null, null, style, target, strength));

        Assert.False(result.IsValid);
        Assert.Equal("invalid_parameters", result.ErrorCode);
    }

    // ---- Clave de caché ----

    [Fact]
    public void CacheKey_ChangesWithStyleTargetStrengthAndAlgorithmVersion()
    {
        var baseline = new ColorPaletteParameters(12, null, 0.001, "base_colors", 5, 0.5, 1);

        var keys = new[]
        {
            baseline.ToCacheKey(),
            (baseline with { GroupingStyle = "detailed" }).ToCacheKey(),
            (baseline with { TargetFamilies = 4 }).ToCacheKey(),
            (baseline with { TargetFamilies = null }).ToCacheKey(),
            (baseline with { GroupingStrength = 0.6 }).ToCacheKey(),
            (baseline with { AlgorithmVersion = 2 }).ToCacheKey(),
        };

        Assert.Equal(keys.Length, keys.Distinct().Count());
    }

    [Fact]
    public void CacheKey_IsStableForTheSameParameters()
    {
        Assert.Equal(
            new ColorPaletteParameters(12, null, 0.001, "base_colors", 5, 0.5, 1).ToCacheKey(),
            new ColorPaletteParameters(12, null, 0.001, "base_colors", 5, 0.5, 1).ToCacheKey());
    }

    // ---- Compatibilidad con sidecars anteriores (CA-10) ----

    private const string LegacySidecarJson = """
        {
          "ProjectId": "11111111-1111-1111-1111-111111111111",
          "ImageId": "22222222-2222-2222-2222-222222222222",
          "Version": 3,
          "PaletteId": "33333333-3333-3333-3333-333333333333",
          "DetectionParameters": { "Tolerance": 12, "MaxColors": null, "TinyAreaRatio": 0.001 },
          "Groups": [
            {
              "GroupId": "44444444-4444-4444-4444-444444444444",
              "Name": "Color 1",
              "ColorHex": "#ff0000",
              "PixelCount": 10,
              "AreaPercent": 100.0,
              "HasPartialAlpha": false,
              "IsExcluded": false,
              "RawGroupIds": [0],
              "MaskStorageKey": "p/i/color-palette/pal/masks/g.png",
              "MergedFrom": null
            }
          ],
          "TransparentPercent": 0,
          "SourceWidthPx": 4,
          "SourceHeightPx": 4,
          "QuantizedPreviewStorageKey": "p/i/color-palette/pal/preview/3.png",
          "IsConfirmed": true,
          "CreatedAt": "2026-10-01T00:00:00+00:00"
        }
        """;

    private PersistentColorPaletteVersionRegistry CreateRegistry()
    {
        var environment = new FakeHostEnvironment { ContentRootPath = _rootPath };
        var options = Microsoft.Extensions.Options.Options.Create(new ColorPaletteRegistryOptions { RootPath = "color-palettes" });
        return new PersistentColorPaletteVersionRegistry(options, environment, NullLogger<PersistentColorPaletteVersionRegistry>.Instance);
    }

    [Fact]
    public void LegacySidecar_WithoutFamilyFields_LoadsAsDetailedAndUnversioned_AndIsNeverReusedByNewRequests()
    {
        var sessionDir = Path.Combine(
            _rootPath, "color-palettes", "11111111111111111111111111111111", "22222222222222222222222222222222",
            "33333333333333333333333333333333");
        Directory.CreateDirectory(sessionDir);
        File.WriteAllText(Path.Combine(sessionDir, "3.json"), LegacySidecarJson);

        var registry = CreateRegistry();
        var latest = registry.FindLatest(
            Guid.Parse("11111111-1111-1111-1111-111111111111"),
            Guid.Parse("22222222-2222-2222-2222-222222222222"),
            Guid.Parse("33333333-3333-3333-3333-333333333333"));

        Assert.NotNull(latest);
        Assert.True(latest!.IsConfirmed);
        Assert.Equal("detailed", latest.DetectionParameters.GroupingStyle);
        Assert.Equal(0, latest.DetectionParameters.AlgorithmVersion);
        Assert.Null(latest.Background);
        var group = Assert.Single(latest.Groups);
        Assert.False(group.IsBackground);
        Assert.Equal("Color 1", group.Name);

        var current = CreateValidator().Validate(new ColorPaletteDetectRequest(null, null, null)).Parameters!;
        Assert.Null(registry.FindByParams(latest.ProjectId, latest.ImageId, latest.PaletteId, current));
    }

    [Fact]
    public void FamilyRecord_RoundTripsThroughThePersistentRegistry()
    {
        var parameters = new ColorPaletteParameters(12, null, 0.001, "base_colors", 5, 0.5, 1);
        var record = new ColorPaletteVersion(
            ProjectId, ImageId, 1, Guid.NewGuid(), parameters,
            new[]
            {
                new ColorGroup(Guid.NewGuid(), "Familia 1", "#112233", 10, 40, false, false, new[] { 0 }, "k/1.png", null, IsBackground: false, PieceCount: 3, SourceGroupCount: 4),
                new ColorGroup(Guid.NewGuid(), "Fondo", "#ffffff", 15, 60, false, true, new[] { 1 }, "k/2.png", null, IsBackground: true, PieceCount: 1, SourceGroupCount: 1),
            },
            0, 4, 4, "k/p.png", false, DateTimeOffset.UtcNow, new BackgroundInfo(60, 0.1, 5, true));

        var first = CreateRegistry();
        first.Save(record);
        var second = CreateRegistry();

        var found = second.FindByParams(ProjectId, ImageId, record.PaletteId, parameters);
        Assert.NotNull(found);
        Assert.Equal(parameters, found!.DetectionParameters);
        Assert.True(found.Groups[1].IsBackground);
        Assert.Equal(3, found.Groups[0].PieceCount);
        Assert.Equal(new BackgroundInfo(60, 0.1, 5, true), found.Background);
    }

    // ---- Orquestación ----

    private static (ColorPaletteService Service, InMemoryColorPaletteVersionRegistry Registry, FakePythonColorPaletteClient Python)
        CreateService()
    {
        var projectRegistry = new InMemoryProjectRegistry();
        projectRegistry.Save(new ProjectRecord(
            ProjectId, ImageId, "original.png", "image/png", 1024, 4, 4, "ready", SourceStorageKey, null, DateTimeOffset.UtcNow));
        var storage = new FakeFileStorage();
        storage.Saved[SourceStorageKey] = System.Text.Encoding.UTF8.GetBytes("fake-original-bytes");
        var registry = new InMemoryColorPaletteVersionRegistry();
        var python = new FakePythonColorPaletteClient { Respond = () => FamilyResult() };
        var service = new ColorPaletteService(
            projectRegistry, registry, CreateValidator(), python, storage, NullLogger<ColorPaletteService>.Instance);
        return (service, registry, python);
    }

    // 4x4: familia 0 = columna izquierda (2 px de ancho), familia 1 = centro, fondo = derecha (técnico).
    private static PythonColorPaletteResult FamilyResult(int algorithmVersion = ColorPaletteAlgorithm.CurrentVersion) => new(
        PythonColorPaletteState.Success,
        Width: 4,
        Height: 4,
        ContentType: "image/png",
        Groups: new[]
        {
            new PythonColorGroupResult(0, "#c8551f", 6, 37.5, false, false, ColorPalettePngs.LeftHalfMask(4, 4), PieceCount: 2, SourceGroupCount: 5),
            new PythonColorGroupResult(1, "#bea90e", 4, 25.0, false, false, ColorPalettePngs.RightHalfMask(4, 4), PieceCount: 1, SourceGroupCount: 3),
            new PythonColorGroupResult(2, "#ffffff", 6, 37.5, false, true, ColorPalettePngs.RightHalfMask(4, 4), IsBackground: true, PieceCount: 1),
        },
        TransparentPercent: 0,
        QuantizedPreviewBytes: ColorPalettePngs.TransparentPreview(4, 4),
        Message: null,
        Background: new BackgroundInfo(37.5, 0.5, 4.0, true),
        AlgorithmVersion: algorithmVersion);


    [Fact]
    public async Task DetectAsync_BaseColors_NamesFamiliesExcludesTheTechnicalBackgroundAndKeepsReviewInfo()
    {
        var (service, _, python) = CreateService();

        var result = await service.DetectAsync(ProjectId, ImageId, BaseColors(target: 5), CancellationToken.None);

        var ready = Assert.IsType<ColorPaletteResult.Ready>(result);
        Assert.Equal("base_colors", ready.Record.DetectionParameters.GroupingStyle);
        Assert.Equal(ColorPaletteAlgorithm.CurrentVersion, ready.Record.DetectionParameters.AlgorithmVersion);
        Assert.Equal(new[] { "Familia 1", "Familia 2", "Fondo" }, ready.Record.Groups.Select(g => g.Name));
        Assert.Equal(new[] { false, false, true }, ready.Record.Groups.Select(g => g.IsBackground));
        Assert.Equal(new[] { false, false, true }, ready.Record.Groups.Select(g => g.IsExcluded));
        Assert.Equal(new[] { 2, 1, 1 }, ready.Record.Groups.Select(g => g.PieceCount));
        Assert.True(ready.Record.Background!.NeedsReview);
        Assert.Equal(1, python.CallCount);
    }

    [Fact]
    public async Task DetectAsync_DetailedStyle_KeepsTheLegacyHeuristicAndHasNoBackgroundGroup()
    {
        var (service, _, python) = CreateService();
        python.Respond = FakePythonColorPaletteClient.DefaultSuccess;

        var result = await service.DetectAsync(ProjectId, ImageId, new ColorPaletteDetectRequest(null, null, null), CancellationToken.None);

        var ready = Assert.IsType<ColorPaletteResult.Ready>(result);
        Assert.Equal(new[] { "Color 1", "Color 2" }, ready.Record.Groups.Select(g => g.Name));
        Assert.True(ready.Record.Groups[0].IsExcluded);
        Assert.All(ready.Record.Groups, g => Assert.False(g.IsBackground));
        Assert.Null(ready.Record.Background);
    }

    [Fact]
    public async Task DetectAsync_SwitchingStyleOnTheSameSession_CallsPythonAgainAndKeepsBothResultsCached()
    {
        var (service, _, python) = CreateService();
        python.Respond = FakePythonColorPaletteClient.DefaultSuccess;
        var detailed = Assert.IsType<ColorPaletteResult.Ready>(
            await service.DetectAsync(ProjectId, ImageId, new ColorPaletteDetectRequest(null, null, null), CancellationToken.None));
        var paletteId = detailed.Record.PaletteId;

        python.Respond = () => FamilyResult();
        var families = Assert.IsType<ColorPaletteResult.Ready>(await service.DetectAsync(
            ProjectId, ImageId, BaseColors(5) with { PaletteId = paletteId }, CancellationToken.None));
        var familiesAgain = Assert.IsType<ColorPaletteResult.Ready>(await service.DetectAsync(
            ProjectId, ImageId, BaseColors(5) with { PaletteId = paletteId }, CancellationToken.None));
        var detailedAgain = Assert.IsType<ColorPaletteResult.Ready>(await service.DetectAsync(
            ProjectId, ImageId, new ColorPaletteDetectRequest(paletteId, null, null), CancellationToken.None));

        Assert.False(families.FromCache);
        Assert.Equal("base_colors", families.Record.DetectionParameters.GroupingStyle);
        Assert.True(familiesAgain.FromCache);
        Assert.True(detailedAgain.FromCache);
        Assert.Equal("detailed", detailedAgain.Record.DetectionParameters.GroupingStyle);
        Assert.Equal(2, python.CallCount);
        Assert.Equal(new[] { 1, 2, 3, 4 }, new[] { detailed, families, familiesAgain, detailedAgain }.Select(r => r.Record.Version));
    }

    [Fact]
    public async Task DetectAsync_ChangingTargetOrStrength_DoesNotReuseTheCachedFamilies()
    {
        var (service, _, python) = CreateService();
        var first = Assert.IsType<ColorPaletteResult.Ready>(
            await service.DetectAsync(ProjectId, ImageId, BaseColors(5, 0.5), CancellationToken.None));
        var paletteId = first.Record.PaletteId;

        await service.DetectAsync(ProjectId, ImageId, BaseColors(3, 0.5) with { PaletteId = paletteId }, CancellationToken.None);
        await service.DetectAsync(ProjectId, ImageId, BaseColors(3, 0.8) with { PaletteId = paletteId }, CancellationToken.None);

        Assert.Equal(3, python.CallCount);
    }

    [Fact]
    public async Task DetectAsync_WhenTheEngineReportsAnOlderAlgorithm_TheRecordKeepsTheReportedVersionAndIsNotCachedAsCurrent()
    {
        var (service, _, python) = CreateService();
        python.Respond = () => FamilyResult(algorithmVersion: 0);
        var first = Assert.IsType<ColorPaletteResult.Ready>(
            await service.DetectAsync(ProjectId, ImageId, BaseColors(5), CancellationToken.None));

        python.Respond = () => FamilyResult();
        var second = Assert.IsType<ColorPaletteResult.Ready>(await service.DetectAsync(
            ProjectId, ImageId, BaseColors(5) with { PaletteId = first.Record.PaletteId }, CancellationToken.None));

        Assert.Equal(0, first.Record.DetectionParameters.AlgorithmVersion);
        Assert.False(second.FromCache);
        Assert.Equal(ColorPaletteAlgorithm.CurrentVersion, second.Record.DetectionParameters.AlgorithmVersion);
    }

    [Fact]
    public async Task EditingAFamilyPalette_KeepsTheBackgroundLastAndTheStyleParameters()
    {
        var (service, _, _) = CreateService();
        var ready = Assert.IsType<ColorPaletteResult.Ready>(
            await service.DetectAsync(ProjectId, ImageId, BaseColors(5), CancellationToken.None));
        var familyTwo = ready.Record.Groups[1].GroupId;

        var renamed = Assert.IsType<ColorPaletteResult.Ready>(await service.RenameAsync(
            ProjectId, ImageId, ready.Record.PaletteId, new ColorPaletteRenameRequest(familyTwo, "Amarillo"), CancellationToken.None));

        Assert.Equal("base_colors", renamed.Record.DetectionParameters.GroupingStyle);
        Assert.True(renamed.Record.Groups[^1].IsBackground);
        Assert.Contains(renamed.Record.Groups, g => g.Name == "Amarillo");
        Assert.NotNull(renamed.Record.Background);
    }

    [Fact]
    public async Task MergingFamilies_SumsPiecesAndNeverTurnsTheMergeIntoABackground()
    {
        var (service, _, _) = CreateService();
        var ready = Assert.IsType<ColorPaletteResult.Ready>(
            await service.DetectAsync(ProjectId, ImageId, BaseColors(5), CancellationToken.None));
        var ids = ready.Record.Groups.Take(2).Select(g => g.GroupId).ToArray();

        var merged = Assert.IsType<ColorPaletteResult.Ready>(await service.MergeAsync(
            ProjectId, ImageId, ready.Record.PaletteId, new ColorPaletteMergeRequest(ids, "Mezcla"), CancellationToken.None));

        var group = merged.Record.Groups.Single(g => g.Name == "Mezcla");
        Assert.False(group.IsBackground);
        Assert.Equal(3, group.PieceCount);
        Assert.Equal(8, group.SourceGroupCount);
        Assert.True(merged.Record.Groups[^1].IsBackground);
    }

    [Fact]
    public void ProjectionOfTheDetectRequestJson_DeserializesTheNewFieldsInCamelCase()
    {
        var request = JsonSerializer.Deserialize<ColorPaletteDetectRequest>(
            """{"groupingStyle":"base_colors","targetFamilies":5,"groupingStrength":0.4}""",
            new JsonSerializerOptions(JsonSerializerDefaults.Web));

        Assert.Equal("base_colors", request!.GroupingStyle);
        Assert.Equal(5, request.TargetFamilies);
        Assert.Equal(0.4, request.GroupingStrength);
    }

    private sealed class FakeHostEnvironment : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Test";
        public string ApplicationName { get; set; } = "Vectorify.Api.Tests";
        public string ContentRootPath { get; set; } = "";
        public Microsoft.Extensions.FileProviders.IFileProvider ContentRootFileProvider { get; set; } = null!;
    }
}
