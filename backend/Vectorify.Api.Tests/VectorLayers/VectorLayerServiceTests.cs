using System.Text;
using System.Xml.Linq;
using Microsoft.Extensions.Logging.Abstractions;
using Vectorify.Api.Clients;
using Vectorify.Api.ColorPalette;
using Vectorify.Api.Contracts;
using Vectorify.Api.Options;
using Vectorify.Api.Projects;
using Vectorify.Api.Tests.ColorPalette;
using Vectorify.Api.Tests.Projects;
using Vectorify.Api.Tests.TestSupport;
using Vectorify.Api.VectorLayers;
using Vectorify.Api.Vectorization;

namespace Vectorify.Api.Tests.VectorLayers;

/// <summary>
/// Pruebas unitarias de VectorLayerService: precondición (paleta debe existir
/// y estar confirmada, sin llamar a Python si no), ciclo cache/lock/versionado
/// (mismo criterio que ColorPaletteService/VectorizationService) y que cada
/// capa generada queda registrada como una VectorVersion normal, reutilizable
/// por el resto del pipeline. Ver spec.md M2-S02, criterios de aceptación.
/// </summary>
public sealed class VectorLayerServiceTests
{
    private static readonly Guid ProjectId = Guid.NewGuid();
    private static readonly Guid ImageId = Guid.NewGuid();
    private const string SourceStorageKey = "project/image/original.png";

    private static (
        VectorLayerService Service,
        ColorPaletteService PaletteService,
        FakeFileStorage Storage,
        InMemoryVectorLayerSetRegistry LayerSetRegistry,
        InMemoryVectorVersionRegistry VectorRegistry,
        FakePythonVectorLayerClient PythonClient) CreateService(FakePythonColorPaletteClient? paletteClientOverride = null)
    {
        var projectRegistry = new InMemoryProjectRegistry();
        projectRegistry.Save(new ProjectRecord(
            ProjectId, ImageId, "original.png", "image/png", 1024, 4, 4, "ready", SourceStorageKey, null, DateTimeOffset.UtcNow));

        var storage = new FakeFileStorage();
        storage.Saved[SourceStorageKey] = System.Text.Encoding.UTF8.GetBytes("fake-original-bytes");

        var paletteRegistry = new InMemoryColorPaletteVersionRegistry();
        var paletteValidator = new ColorPaletteParameterValidator(Microsoft.Extensions.Options.Options.Create(new ColorPaletteOptions()));
        var paletteClient = paletteClientOverride ?? new FakePythonColorPaletteClient();
        var paletteService = new ColorPaletteService(
            projectRegistry, paletteRegistry, paletteValidator, paletteClient, storage, NullLogger<ColorPaletteService>.Instance);

        var layerSetRegistry = new InMemoryVectorLayerSetRegistry();
        var vectorRegistry = new InMemoryVectorVersionRegistry();
        var pythonLayerClient = new FakePythonVectorLayerClient();

        var service = new VectorLayerService(
            paletteService, layerSetRegistry, vectorRegistry, pythonLayerClient, storage, NullLogger<VectorLayerService>.Instance);

        return (service, paletteService, storage, layerSetRegistry, vectorRegistry, pythonLayerClient);
    }

    private static async Task<ColorPaletteVersion> DetectPaletteAsync(ColorPaletteService paletteService) =>
        Assert.IsType<ColorPaletteResult.Ready>(
            await paletteService.DetectAsync(ProjectId, ImageId, new ColorPaletteDetectRequest(null, null, null), CancellationToken.None)
        ).Record;

    private static async Task<ColorPaletteVersion> DetectAndConfirmPaletteAsync(ColorPaletteService paletteService)
    {
        var detected = await DetectPaletteAsync(paletteService);
        var confirmed = await paletteService.ConfirmAsync(ProjectId, ImageId, detected.PaletteId, CancellationToken.None);
        return Assert.IsType<ColorPaletteResult.Ready>(confirmed).Record;
    }

    // ---- Precondición ----

    [Fact]
    public async Task GenerateLayersAsync_WhenPaletteDoesNotExist_ReturnsNotFoundWithoutCallingPython()
    {
        var (service, _, _, _, _, pythonClient) = CreateService();

        var result = await service.GenerateLayersAsync(ProjectId, ImageId, Guid.NewGuid(), CancellationToken.None);

        Assert.IsType<VectorLayerSetResult.NotFound>(result);
        Assert.Equal(0, pythonClient.CallCount);
    }

    [Fact]
    public async Task GenerateLayersAsync_WhenPaletteIsNotConfirmed_ReturnsConflictWithoutCallingPython()
    {
        var (service, paletteService, _, _, _, pythonClient) = CreateService();
        var detected = await DetectPaletteAsync(paletteService);

        var result = await service.GenerateLayersAsync(ProjectId, ImageId, detected.PaletteId, CancellationToken.None);

        var conflict = Assert.IsType<VectorLayerSetResult.Conflict>(result);
        Assert.Equal("palette_not_confirmed", conflict.Code);
        Assert.Equal(0, pythonClient.CallCount);
    }

    // ---- Generación exitosa ----

    [Fact]
    public async Task GenerateLayersAsync_WhenSuccessful_CreatesFirstVersionWithOneLayerPerGroup()
    {
        var (service, paletteService, storage, layerSetRegistry, _, pythonClient) = CreateService();
        var confirmed = await DetectAndConfirmPaletteAsync(paletteService);

        var result = await service.GenerateLayersAsync(ProjectId, ImageId, confirmed.PaletteId, CancellationToken.None);

        var ready = Assert.IsType<VectorLayerSetResult.Ready>(result);
        Assert.False(ready.FromCache);
        Assert.Equal(1, ready.Record.Version);
        Assert.Equal(confirmed.Groups.Count, ready.Record.Layers.Count);
        Assert.Equal(1, pythonClient.CallCount);
        Assert.NotNull(layerSetRegistry.FindLatest(ProjectId, ImageId, confirmed.PaletteId));

        foreach (var layer in ready.Record.Layers)
        {
            var sourceGroup = confirmed.Groups.Single(g => g.GroupId == layer.GroupId);
            Assert.Equal(sourceGroup.Name, layer.Name);
            Assert.Equal(sourceGroup.ColorHex, layer.ColorHex);
            Assert.NotEqual(Guid.Empty, layer.VectorId);
        }

        // Cada capa persistió su propio SVG bajo una clave distinta.
        var svgKeys = storage.Saved.Keys.Where(k => k.Contains("/vector-layers/")).ToList();
        Assert.Equal(confirmed.Groups.Count, svgKeys.Count);
    }

    // ---- Fronteras compartidas: una paleta por familias es una partición exacta de píxeles ----

    [Fact]
    public async Task GenerateLayersAsync_WhenPaletteIsBaseColors_AsksPythonToTraceTheLayersWithSharedBoundaries()
    {
        var paletteClient = new FakePythonColorPaletteClient { Respond = () => FamiliesPaletteResult() };
        var (service, paletteService, _, _, _, pythonClient) = CreateService(paletteClient);
        var detected = Assert.IsType<ColorPaletteResult.Ready>(await paletteService.DetectAsync(
            ProjectId, ImageId, new ColorPaletteDetectRequest(null, null, null, GroupingStyle: ColorPaletteAlgorithm.BaseColors), CancellationToken.None)).Record;
        var confirmed = Assert.IsType<ColorPaletteResult.Ready>(
            await paletteService.ConfirmAsync(ProjectId, ImageId, detected.PaletteId, CancellationToken.None)).Record;

        var result = await service.GenerateLayersAsync(ProjectId, ImageId, confirmed.PaletteId, CancellationToken.None);

        Assert.IsType<VectorLayerSetResult.Ready>(result);
        Assert.True(pythonClient.LastSharedBoundaries);
    }

    [Fact]
    public async Task GenerateLayersAsync_WhenPaletteIsDetailed_KeepsTracingEachMaskIndependently()
    {
        var (service, paletteService, _, _, _, pythonClient) = CreateService();
        var confirmed = await DetectAndConfirmPaletteAsync(paletteService);

        await service.GenerateLayersAsync(ProjectId, ImageId, confirmed.PaletteId, CancellationToken.None);

        Assert.False(pythonClient.LastSharedBoundaries);
    }

    // 4x4: dos familias (mitades) y un fondo técnico; las máscaras de la prueba no se envían a Python real.
    private static PythonColorPaletteResult FamiliesPaletteResult() => new(
        PythonColorPaletteState.Success,
        Width: 4,
        Height: 4,
        ContentType: "image/png",
        Groups: new[]
        {
            new PythonColorGroupResult(0, "#c8551f", 8, 50.0, false, false, ColorPalettePngs.LeftHalfMask(4, 4), PieceCount: 1, SourceGroupCount: 3),
            new PythonColorGroupResult(1, "#bea90e", 8, 50.0, false, false, ColorPalettePngs.RightHalfMask(4, 4), PieceCount: 1, SourceGroupCount: 2),
        },
        TransparentPercent: 0,
        QuantizedPreviewBytes: ColorPalettePngs.TransparentPreview(4, 4),
        Message: null,
        AlgorithmVersion: ColorPaletteAlgorithm.CurrentVersion);

    // ---- Regresión M2.1-S01: el SVG persistido de cada capa tiene el color REAL, no negro ----

    /// <summary>
    /// Paleta de EXACTAMENTE 4 colores no solapados (cuadrantes 2x2) -- replica
    /// el fixture RGBY usado en la reproducción manual de spec.md M2.1-S01 y
    /// el "Definition of Done verificable": "un fixture de 4 colores (ej.
    /// RGBY) debe devolver AL MENOS 4 grupos/capas coherentes, cada una con
    /// su color real aplicado al SVG (no solo en la metadata JSON)".
    /// </summary>
    private static readonly (string ColorHex, int Quadrant)[] FourColorPalette =
    {
        ("#ff0000", 0), // rojo, top-left
        ("#00c800", 1), // verde, top-right
        ("#0000ff", 2), // azul, bottom-left
        ("#ffdc00", 3), // amarillo, bottom-right
    };

    private static FakePythonColorPaletteClient CreateFourColorPaletteClient()
    {
        const int size = 8;
        return new FakePythonColorPaletteClient
        {
            Respond = () => new PythonColorPaletteResult(
                PythonColorPaletteState.Success,
                Width: size,
                Height: size,
                ContentType: "image/png",
                Groups: FourColorPalette
                    .Select((entry, index) => new PythonColorGroupResult(
                        index, entry.ColorHex, 16, 25.0, false, TouchesBorder: false, MaskBytes: ColorPalettePngs.QuadrantMask(size, size, entry.Quadrant)))
                    .ToArray(),
                TransparentPercent: 0.0,
                QuantizedPreviewBytes: ColorPalettePngs.TransparentPreview(size, size),
                Message: null),
        };
    }

    [Fact]
    public async Task GenerateLayersAsync_WhenPaletteHasFourColors_ReturnsAtLeastFourLayersEachWithItsRealColorAppliedToTheSvg()
    {
        var (service, paletteService, storage, _, _, _) = CreateService(CreateFourColorPaletteClient());
        var confirmed = await DetectAndConfirmPaletteAsync(paletteService);

        // Precondición del propio DoD: el fixture de 4 colores debe haber
        // producido efectivamente 4 grupos coherentes en la paleta.
        Assert.Equal(4, confirmed.Groups.Count);

        var result = await service.GenerateLayersAsync(ProjectId, ImageId, confirmed.PaletteId, CancellationToken.None);
        var ready = Assert.IsType<VectorLayerSetResult.Ready>(result);

        Assert.True(ready.Record.Layers.Count >= 4);

        foreach (var layer in ready.Record.Layers)
        {
            var svgKey = storage.Saved.Keys.Single(k => k.Contains("/vector-layers/") && k.Contains(layer.VectorId.ToString("N")));
            var persistedSvg = Encoding.UTF8.GetString(storage.Saved[svgKey]);
            var paths = XDocument.Parse(persistedSvg).Descendants().Where(el => el.Name.LocalName == "path").ToList();

            Assert.NotEmpty(paths);
            foreach (var path in paths)
            {
                // El corazón de la regresión: el fill real del ColorGroup, NUNCA
                // el fill fijo negro que devuelve VtracerEngine.trace en
                // colormode="binary" (causa raíz confirmada de M2.1-S01).
                Assert.Equal(layer.ColorHex, path.Attribute("fill")?.Value);
                Assert.NotEqual("#000000", path.Attribute("fill")?.Value);
            }
        }

        // Cada capa tiene un fill DISTINTO entre sí (4 colores distintos, no
        // los 4 colapsados al mismo negro).
        var distinctFills = ready.Record.Layers.Select(l => l.ColorHex).Distinct().Count();
        Assert.Equal(ready.Record.Layers.Count, distinctFills);
    }

    [Fact]
    public async Task GenerateLayersAsync_WhenSuccessful_TheDefaultTwoColorPaletteAlsoGetsItsRealFillNotTheEnginesFixedBlack()
    {
        // Mismo caso "feliz" default (2 colores: #ff0000/#00ff00) que el resto
        // de esta clase, pero verificando explícitamente el contenido del SVG
        // persistido -- FakePythonVectorLayerClient.DefaultSuccess devuelve
        // fill="#000000" hardcodeado (igual que el VtracerEngine real), así
        // que esta prueba falla si VectorLayerService alguna vez deja de
        // sobreescribirlo.
        var (service, paletteService, storage, _, _, _) = CreateService();
        var confirmed = await DetectAndConfirmPaletteAsync(paletteService);

        var result = await service.GenerateLayersAsync(ProjectId, ImageId, confirmed.PaletteId, CancellationToken.None);
        var ready = Assert.IsType<VectorLayerSetResult.Ready>(result);

        foreach (var layer in ready.Record.Layers)
        {
            var svgKey = storage.Saved.Keys.Single(k => k.Contains("/vector-layers/") && k.Contains(layer.VectorId.ToString("N")));
            var persistedSvg = Encoding.UTF8.GetString(storage.Saved[svgKey]);
            var path = XDocument.Parse(persistedSvg).Descendants().Single(el => el.Name.LocalName == "path");

            Assert.Equal(layer.ColorHex, path.Attribute("fill")?.Value);
        }
    }

    [Fact]
    public async Task GenerateLayersAsync_NeverMutatesThePathsDCommand()
    {
        // El fix pinta SOLO el atributo `fill` -- la geometría (`d`) del SVG
        // devuelto por Python debe llegar a storage BYTE A BYTE igual, sin
        // ninguna transformación de coordenadas/comandos.
        var (service, paletteService, storage, _, _, _) = CreateService();
        var confirmed = await DetectAndConfirmPaletteAsync(paletteService);

        var result = await service.GenerateLayersAsync(ProjectId, ImageId, confirmed.PaletteId, CancellationToken.None);
        var ready = Assert.IsType<VectorLayerSetResult.Ready>(result);

        foreach (var layer in ready.Record.Layers)
        {
            var svgKey = storage.Saved.Keys.Single(k => k.Contains("/vector-layers/") && k.Contains(layer.VectorId.ToString("N")));
            var persistedSvg = Encoding.UTF8.GetString(storage.Saved[svgKey]);
            var path = XDocument.Parse(persistedSvg).Descendants().Single(el => el.Name.LocalName == "path");

            Assert.Equal("M2,2 L8,2 L8,8 L2,8 Z", path.Attribute("d")?.Value);
        }
    }

    [Fact]
    public async Task GenerateLayersAsync_WhenSuccessful_EachLayerLogsWhichFillWasApplied()
    {
        // Telemetría pedida por spec.md M2.1-S01: "capa {GroupId} pintada
        // con fill {ColorHex}", sin loggear contenido de imágenes.
        var recordingLogger = new RecordingLogger<VectorLayerService>();
        var projectRegistry = new InMemoryProjectRegistry();
        projectRegistry.Save(new ProjectRecord(
            ProjectId, ImageId, "original.png", "image/png", 1024, 4, 4, "ready", SourceStorageKey, null, DateTimeOffset.UtcNow));
        var storage = new FakeFileStorage();
        storage.Saved[SourceStorageKey] = Encoding.UTF8.GetBytes("fake-original-bytes");
        var paletteRegistry = new InMemoryColorPaletteVersionRegistry();
        var paletteValidator = new ColorPaletteParameterValidator(Microsoft.Extensions.Options.Options.Create(new ColorPaletteOptions()));
        var paletteClient = new FakePythonColorPaletteClient();
        var paletteService = new ColorPaletteService(
            projectRegistry, paletteRegistry, paletteValidator, paletteClient, storage, NullLogger<ColorPaletteService>.Instance);
        var layerSetRegistry = new InMemoryVectorLayerSetRegistry();
        var vectorRegistry = new InMemoryVectorVersionRegistry();
        var pythonLayerClient = new FakePythonVectorLayerClient();
        var service = new VectorLayerService(
            paletteService, layerSetRegistry, vectorRegistry, pythonLayerClient, storage, recordingLogger);

        var confirmed = await DetectAndConfirmPaletteAsync(paletteService);
        await service.GenerateLayersAsync(ProjectId, ImageId, confirmed.PaletteId, CancellationToken.None);

        foreach (var group in confirmed.Groups)
        {
            Assert.Contains(recordingLogger.Messages, m => m.Contains(group.GroupId.ToString()) && m.Contains(group.ColorHex));
        }
    }

    [Fact]
    public async Task GenerateLayersAsync_EachLayerIsRegisteredAsAReusableVectorVersion()
    {
        var (service, paletteService, _, _, vectorRegistry, _) = CreateService();
        var confirmed = await DetectAndConfirmPaletteAsync(paletteService);

        var result = await service.GenerateLayersAsync(ProjectId, ImageId, confirmed.PaletteId, CancellationToken.None);
        var ready = Assert.IsType<VectorLayerSetResult.Ready>(result);

        foreach (var layer in ready.Record.Layers)
        {
            // Reutiliza EXACTAMENTE el mismo IVectorVersionRegistry/VectorVersion
            // de M1-S05 -- el resto del pipeline (Simplification/Check/
            // Dimension/Export) puede resolver esta capa como cualquier otro
            // vector, por su VectorId, sin saber que vino de una capa de color.
            var vectorVersion = vectorRegistry.FindByVectorId(ProjectId, ImageId, layer.VectorId);
            Assert.NotNull(vectorVersion);
            Assert.Equal(layer.GroupId, vectorVersion!.SourceMaskId);
        }
    }

    [Fact]
    public async Task GenerateLayersAsync_LayersShareTheSameSourceCanvasDimensionsAsThePalette()
    {
        var (service, paletteService, _, _, _, _) = CreateService();
        var confirmed = await DetectAndConfirmPaletteAsync(paletteService);

        var result = await service.GenerateLayersAsync(ProjectId, ImageId, confirmed.PaletteId, CancellationToken.None);
        var ready = Assert.IsType<VectorLayerSetResult.Ready>(result);

        Assert.Equal(confirmed.SourceWidthPx, ready.Record.SourceWidthPx);
        Assert.Equal(confirmed.SourceHeightPx, ready.Record.SourceHeightPx);
    }

    // ---- Validación raster-vs-vector (M2.1-S03) ----

    [Fact]
    public async Task GenerateLayersAsync_WhenSuccessful_EachLayerCarriesTheRasterValidationComputedByPython()
    {
        // El CÁLCULO ya lo hizo Python (ver services/python-engine, app.core.raster_validation) --
        // VectorLayerService solo debe transportarlo tal cual a la capa persistida, sin recalcular nada.
        var (service, paletteService, _, _, _, pythonClient) = CreateService();
        var confirmed = await DetectAndConfirmPaletteAsync(paletteService);
        var customValidation = new LayerRasterValidation(
            OwnMismatchRatio: 0.02, OwnMismatchTolerance: 0.15, OwnMismatchWithinTolerance: true,
            ContaminationRatio: 0.0, ContaminationTolerance: 0.01, ContaminationWithinTolerance: true,
            Warnings: Array.Empty<string>());
        pythonClient.Respond = masks => new PythonVectorLayerBatchResult(
            PythonVectorLayerState.Success,
            masks.Select(mask => new PythonVectorLayerItemResult(
                mask.GroupId,
                "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"10\" height=\"10\"><path d=\"M2,2 L8,2 L8,8 L2,8 Z\"/></svg>",
                "image/svg+xml", 10, 10, new VectorMetrics(1, 4, new VectorBounds(2, 2, 8, 8, 6, 6)),
                customValidation)).ToList(),
            Message: null);

        var result = await service.GenerateLayersAsync(ProjectId, ImageId, confirmed.PaletteId, CancellationToken.None);
        var ready = Assert.IsType<VectorLayerSetResult.Ready>(result);

        foreach (var layer in ready.Record.Layers)
        {
            Assert.Equal(customValidation.OwnMismatchRatio, layer.RasterValidation.OwnMismatchRatio);
            Assert.Equal(customValidation.OwnMismatchTolerance, layer.RasterValidation.OwnMismatchTolerance);
            Assert.Equal(customValidation.OwnMismatchWithinTolerance, layer.RasterValidation.OwnMismatchWithinTolerance);
            Assert.Equal(customValidation.ContaminationRatio, layer.RasterValidation.ContaminationRatio);
            Assert.Equal(customValidation.ContaminationTolerance, layer.RasterValidation.ContaminationTolerance);
            Assert.Equal(customValidation.ContaminationWithinTolerance, layer.RasterValidation.ContaminationWithinTolerance);
            Assert.Empty(layer.RasterValidation.Warnings);
        }
    }

    [Fact]
    public async Task GenerateLayersAsync_WhenRasterValidationIsOutOfTolerance_LogsAWarningButStillGeneratesTheLayer()
    {
        // Decisión documentada (spec.md, "Ambigüedades detectadas"): advertir,
        // NUNCA bloquear -- una discrepancia fuera de tolerancia se loggea,
        // pero la capa se genera y persiste igual.
        var recordingLogger = new RecordingLogger<VectorLayerService>();
        var projectRegistry = new InMemoryProjectRegistry();
        projectRegistry.Save(new ProjectRecord(
            ProjectId, ImageId, "original.png", "image/png", 1024, 4, 4, "ready", SourceStorageKey, null, DateTimeOffset.UtcNow));
        var storage = new FakeFileStorage();
        storage.Saved[SourceStorageKey] = Encoding.UTF8.GetBytes("fake-original-bytes");
        var paletteRegistry = new InMemoryColorPaletteVersionRegistry();
        var paletteValidator = new ColorPaletteParameterValidator(Microsoft.Extensions.Options.Options.Create(new ColorPaletteOptions()));
        var paletteClient = new FakePythonColorPaletteClient();
        var paletteService = new ColorPaletteService(
            projectRegistry, paletteRegistry, paletteValidator, paletteClient, storage, NullLogger<ColorPaletteService>.Instance);
        var layerSetRegistry = new InMemoryVectorLayerSetRegistry();
        var vectorRegistry = new InMemoryVectorVersionRegistry();
        var pythonLayerClient = new FakePythonVectorLayerClient();
        var contaminatedValidation = new LayerRasterValidation(
            OwnMismatchRatio: 0.01, OwnMismatchTolerance: 0.15, OwnMismatchWithinTolerance: true,
            ContaminationRatio: 0.40, ContaminationTolerance: 0.01, ContaminationWithinTolerance: false,
            Warnings: new List<string> { "El área vectorizada de esta capa contiene 40.00% de píxeles de OTRO color -- posible contaminación cruzada." });
        pythonLayerClient.Respond = masks => new PythonVectorLayerBatchResult(
            PythonVectorLayerState.Success,
            masks.Select(mask => new PythonVectorLayerItemResult(
                mask.GroupId,
                "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"10\" height=\"10\"><path d=\"M2,2 L8,2 L8,8 L2,8 Z\"/></svg>",
                "image/svg+xml", 10, 10, new VectorMetrics(1, 4, new VectorBounds(2, 2, 8, 8, 6, 6)),
                contaminatedValidation)).ToList(),
            Message: null);
        var service = new VectorLayerService(
            paletteService, layerSetRegistry, vectorRegistry, pythonLayerClient, storage, recordingLogger);

        var confirmed = await DetectAndConfirmPaletteAsync(paletteService);
        var result = await service.GenerateLayersAsync(ProjectId, ImageId, confirmed.PaletteId, CancellationToken.None);

        // Nunca bloquea: la generación sigue siendo exitosa.
        var ready = Assert.IsType<VectorLayerSetResult.Ready>(result);
        Assert.Equal(confirmed.Groups.Count, ready.Record.Layers.Count);
        Assert.All(ready.Record.Layers, layer => Assert.False(layer.RasterValidation.ContaminationWithinTolerance));

        foreach (var group in confirmed.Groups)
        {
            Assert.Contains(
                recordingLogger.Messages,
                m => m.Contains(group.GroupId.ToString()) && m.Contains("contamina", StringComparison.OrdinalIgnoreCase));
        }
    }

    // ---- Reordenar no debe alterar geometría (spec.md, "Requisitos") ----

    [Fact]
    public async Task GenerateLayersAsync_ReversingTheReportedLayersOrderNeverChangesAnyGroupsVectorIdOrPersistedSvg()
    {
        var (service, paletteService, storage, _, _, _) = CreateService();
        var confirmed = await DetectAndConfirmPaletteAsync(paletteService);

        var result = await service.GenerateLayersAsync(ProjectId, ImageId, confirmed.PaletteId, CancellationToken.None);
        var ready = Assert.IsType<VectorLayerSetResult.Ready>(result);

        // "Order" (M2.1-S03) se computa como la POSICIÓN en esta lista (ver
        // Vectorify.Api.Endpoints.ConsolidatedVectorLayerEndpoints) -- nunca
        // identifica una capa. Invertir el orden reportado no debe alterar
        // NINGÚN VectorId ni el SVG ya persistido: la geometría vive en su
        // propia VectorVersion, completamente independiente de la posición
        // en esta lista.
        var reversedLayers = ready.Record.Layers.Reverse().ToList();

        Assert.Equal(
            ready.Record.Layers.Select(l => l.GroupId).OrderBy(id => id),
            reversedLayers.Select(l => l.GroupId).OrderBy(id => id));

        foreach (var layer in ready.Record.Layers)
        {
            var reorderedLayer = reversedLayers.Single(l => l.GroupId == layer.GroupId);
            Assert.Equal(layer.VectorId, reorderedLayer.VectorId);

            var svgKey = storage.Saved.Keys.Single(k => k.Contains("/vector-layers/") && k.Contains(layer.VectorId.ToString("N")));
            var persistedSvg = Encoding.UTF8.GetString(storage.Saved[svgKey]);
            Assert.Contains("M2,2 L8,2 L8,8 L2,8 Z", persistedSvg);
        }
    }

    // ---- Ciclo cache/versión ----

    [Fact]
    public async Task GenerateLayersAsync_WhenCalledAgainForSamePaletteVersion_ReturnsCachedWithoutCallingPythonAgain()
    {
        var (service, paletteService, _, _, _, pythonClient) = CreateService();
        var confirmed = await DetectAndConfirmPaletteAsync(paletteService);

        var first = await service.GenerateLayersAsync(ProjectId, ImageId, confirmed.PaletteId, CancellationToken.None);
        var second = await service.GenerateLayersAsync(ProjectId, ImageId, confirmed.PaletteId, CancellationToken.None);

        var firstReady = Assert.IsType<VectorLayerSetResult.Ready>(first);
        var secondReady = Assert.IsType<VectorLayerSetResult.Ready>(second);

        Assert.False(firstReady.FromCache);
        Assert.True(secondReady.FromCache);
        Assert.Equal(1, pythonClient.CallCount);

        // Nunca retrocede ni "re-sirve" la misma versión: siempre avanza,
        // reutilizando el mismo LayerSetId y los mismos VectorId ya generados.
        Assert.Equal(firstReady.Record.Version + 1, secondReady.Record.Version);
        Assert.Equal(firstReady.Record.LayerSetId, secondReady.Record.LayerSetId);
        Assert.Equal(
            firstReady.Record.Layers.Select(l => l.VectorId).OrderBy(id => id),
            secondReady.Record.Layers.Select(l => l.VectorId).OrderBy(id => id));
    }

    [Fact]
    public async Task GenerateLayersAsync_WhenConcurrentRequestsForSamePalette_CallsPythonOnlyOnce()
    {
        var (service, paletteService, _, layerSetRegistry, _, pythonClient) = CreateService();
        var confirmed = await DetectAndConfirmPaletteAsync(paletteService);
        pythonClient.Delay = TimeSpan.FromMilliseconds(50);

        var task1 = service.GenerateLayersAsync(ProjectId, ImageId, confirmed.PaletteId, CancellationToken.None);
        var task2 = service.GenerateLayersAsync(ProjectId, ImageId, confirmed.PaletteId, CancellationToken.None);
        await Task.WhenAll(task1, task2);

        Assert.Equal(1, pythonClient.CallCount);
        Assert.NotNull(layerSetRegistry.FindLatest(ProjectId, ImageId, confirmed.PaletteId));
    }

    // ---- Errores upstream ----

    [Fact]
    public async Task GenerateLayersAsync_WhenPythonTimesOut_ReturnsUpstreamErrorWithTimeoutCode()
    {
        var (service, paletteService, _, _, _, pythonClient) = CreateService();
        var confirmed = await DetectAndConfirmPaletteAsync(paletteService);
        pythonClient.Respond = _ => new PythonVectorLayerBatchResult(PythonVectorLayerState.Timeout, null, "tardó demasiado");

        var result = await service.GenerateLayersAsync(ProjectId, ImageId, confirmed.PaletteId, CancellationToken.None);

        var error = Assert.IsType<VectorLayerSetResult.UpstreamError>(result);
        Assert.Equal("timeout", error.Code);
    }

    [Fact]
    public async Task GenerateLayersAsync_WhenPythonIsUnavailable_ReturnsUpstreamErrorWithEngineUnavailableCode()
    {
        var (service, paletteService, _, _, _, pythonClient) = CreateService();
        var confirmed = await DetectAndConfirmPaletteAsync(paletteService);
        pythonClient.Respond = _ => new PythonVectorLayerBatchResult(PythonVectorLayerState.Unavailable, null, "sin conexión");

        var result = await service.GenerateLayersAsync(ProjectId, ImageId, confirmed.PaletteId, CancellationToken.None);

        var error = Assert.IsType<VectorLayerSetResult.UpstreamError>(result);
        Assert.Equal("engine_unavailable", error.Code);
    }

    [Fact]
    public async Task GenerateLayersAsync_WhenPythonOmitsALayerForAGroup_ReturnsUpstreamErrorWithInvalidResponseCode()
    {
        var (service, paletteService, _, _, _, pythonClient) = CreateService();
        var confirmed = await DetectAndConfirmPaletteAsync(paletteService);
        pythonClient.Respond = masks => new PythonVectorLayerBatchResult(
            PythonVectorLayerState.Success,
            masks.Take(masks.Count - 1).Select(mask => new PythonVectorLayerItemResult(
                mask.GroupId,
                "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"10\" height=\"10\"><path d=\"M2,2 L8,2 L8,8 L2,8 Z\"/></svg>",
                "image/svg+xml", 10, 10, new VectorMetrics(1, 4, new VectorBounds(2, 2, 8, 8, 6, 6)),
                FakePythonVectorLayerClient.DefaultRasterValidation())).ToList(),
            Message: null);

        var result = await service.GenerateLayersAsync(ProjectId, ImageId, confirmed.PaletteId, CancellationToken.None);

        var error = Assert.IsType<VectorLayerSetResult.UpstreamError>(result);
        Assert.Equal("invalid_response", error.Code);
    }

    // ---- FindLatest ----

    [Fact]
    public async Task FindLatest_AfterGenerating_ReturnsTheRecord()
    {
        var (service, paletteService, _, _, _, _) = CreateService();
        var confirmed = await DetectAndConfirmPaletteAsync(paletteService);
        var generated = await service.GenerateLayersAsync(ProjectId, ImageId, confirmed.PaletteId, CancellationToken.None);
        var ready = Assert.IsType<VectorLayerSetResult.Ready>(generated);

        var found = service.FindLatest(ProjectId, ImageId, confirmed.PaletteId);

        Assert.NotNull(found);
        Assert.Equal(ready.Record.LayerSetId, found!.LayerSetId);
    }

    [Fact]
    public void FindLatest_WhenNeverGenerated_ReturnsNull()
    {
        var (service, _, _, _, _, _) = CreateService();

        var found = service.FindLatest(ProjectId, ImageId, Guid.NewGuid());

        Assert.Null(found);
    }
}
