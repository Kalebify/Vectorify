using System.Collections.Concurrent;
using System.Text;
using Vectorify.Api.Clients;
using Vectorify.Api.ColorPalette;
using Vectorify.Api.Storage;
using Vectorify.Api.Vectorization;

namespace Vectorify.Api.VectorLayers;

/// <summary>
/// Implementación de <see cref="IVectorLayerService"/>: valida la
/// precondición (paleta existente y confirmada), busca un conjunto de capas
/// cacheado para esa paleta+versión confirmada y, si no existe, abre las
/// máscaras YA persistidas de cada <see cref="ColorGroup"/> (M2-S01) y hace
/// UNA sola llamada al motor Python que vectoriza las N máscaras de forma
/// independiente server-side (ver <see cref="IPythonVectorLayerClient"/>,
/// "Ambigüedades detectadas" de spec.md). Cada SVG resultante se persiste y
/// se registra como una <see cref="VectorVersion"/> normal en el MISMO
/// <see cref="IVectorVersionRegistry"/> que usa M1-S05 -- reutilizando el
/// tipo ya existente, no un tipo paralelo -- así el resto del pipeline
/// (Simplification/Check/Dimension/Export) puede operar sobre una capa
/// individual exactamente igual que sobre cualquier otro vector, sin saber
/// que "vino de una capa de color". Mismo patrón de cache+lock+versionado
/// que ColorPaletteService/VectorizationService: cache-hit crea una versión
/// NUEVA del conjunto (reutilizando el mismo LayerSetId y los mismos
/// VectorId ya generados) sin retroceder ni volver a llamar a Python; lock
/// por sesión de paleta para que requests concurrentes con la misma paleta
/// no dupliquen la llamada.
/// </summary>
public sealed class VectorLayerService : IVectorLayerService
{
    private readonly IColorPaletteService _colorPaletteService;
    private readonly IVectorLayerSetRegistry _layerSetRegistry;
    private readonly IVectorVersionRegistry _vectorRegistry;
    private readonly IPythonVectorLayerClient _pythonClient;
    private readonly IFileStorage _fileStorage;
    private readonly ILogger<VectorLayerService> _logger;

    private static readonly ConcurrentDictionary<string, SemaphoreSlim> _sessionLocks = new();

    public VectorLayerService(
        IColorPaletteService colorPaletteService,
        IVectorLayerSetRegistry layerSetRegistry,
        IVectorVersionRegistry vectorRegistry,
        IPythonVectorLayerClient pythonClient,
        IFileStorage fileStorage,
        ILogger<VectorLayerService> logger)
    {
        _colorPaletteService = colorPaletteService;
        _layerSetRegistry = layerSetRegistry;
        _vectorRegistry = vectorRegistry;
        _pythonClient = pythonClient;
        _fileStorage = fileStorage;
        _logger = logger;
    }

    public async Task<VectorLayerSetResult> GenerateLayersAsync(
        Guid projectId, Guid imageId, Guid paletteId, CancellationToken cancellationToken)
    {
        var palette = _colorPaletteService.FindLatest(projectId, imageId, paletteId);
        if (palette is null)
        {
            return new VectorLayerSetResult.NotFound(
                "not_found", "No existe una sesión de paleta de colores con ese ID para esta imagen.");
        }

        if (!palette.IsConfirmed)
        {
            return new VectorLayerSetResult.Conflict(
                "palette_not_confirmed", "La paleta debe estar confirmada antes de generar las capas vectoriales.");
        }

        var gate = SessionGate(projectId, imageId, paletteId);
        await gate.WaitAsync(cancellationToken);
        try
        {
            // Cache: la misma paleta, en exactamente la misma versión CONFIRMADA,
            // ya generó un conjunto de capas antes -> se reutilizan los VectorId
            // ya generados (no se vuelve a llamar a Python), pero igual se
            // registra como una versión NUEVA del historial -- mismo criterio que
            // VectorizationService/ColorPaletteService.
            var cached = _layerSetRegistry.FindByParams(projectId, imageId, paletteId, palette.Version);
            if (cached is not null)
            {
                var cachedVersion = _layerSetRegistry.NextVersion(projectId, imageId, paletteId);
                var cachedRecord = cached with { Version = cachedVersion, CreatedAt = DateTimeOffset.UtcNow };
                _layerSetRegistry.Save(cachedRecord);

                _logger.LogInformation(
                    "Conjunto de capas {LayerSetId} (v{Version}) reutilizado desde caché para paleta {PaletteId} (v{PaletteVersion}) de {ProjectId}/{ImageId}",
                    cachedRecord.LayerSetId, cachedVersion, paletteId, palette.Version, projectId, imageId);

                return new VectorLayerSetResult.Ready(cachedRecord, FromCache: true);
            }

            var openedStreams = new List<Stream>();
            List<(Guid GroupId, Stream Content, string ContentType)> masks;
            try
            {
                masks = new List<(Guid, Stream, string)>(palette.Groups.Count);
                foreach (var group in palette.Groups)
                {
                    var stream = await _fileStorage.OpenReadAsync(group.MaskStorageKey, cancellationToken);
                    openedStreams.Add(stream);
                    masks.Add((group.GroupId, stream, "image/png"));
                }
            }
            catch (FileNotFoundException ex)
            {
                await DisposeAllAsync(openedStreams);
                _logger.LogError(
                    ex, "Una máscara de la paleta {PaletteId} de {ProjectId}/{ImageId} ya no está disponible en el storage",
                    paletteId, projectId, imageId);
                return new VectorLayerSetResult.UpstreamError(
                    "storage_failure", "Una máscara de la paleta ya no está disponible en el storage.");
            }

            PythonVectorLayerBatchResult pythonResult;
            try
            {
                // Una paleta por familias es una partición exacta de píxeles: sus capas se trazan juntas, con
                // fronteras compartidas (sin solapes ni rendijas entre familias vecinas).
                var sharedBoundaries = palette.DetectionParameters.GroupingStyle == ColorPaletteAlgorithm.BaseColors;
                pythonResult = await _pythonClient.VectorizeLayersAsync(masks, sharedBoundaries, cancellationToken);
            }
            finally
            {
                await DisposeAllAsync(openedStreams);
            }

            if (pythonResult.State != PythonVectorLayerState.Success)
            {
                return new VectorLayerSetResult.UpstreamError(
                    MapErrorCode(pythonResult.State),
                    pythonResult.Message ?? "No se pudo generar el conjunto de capas.");
            }

            var pythonLayersByGroup = pythonResult.Layers!.ToDictionary(layer => layer.GroupId);

            var layers = new List<VectorLayer>(palette.Groups.Count);
            foreach (var group in palette.Groups)
            {
                if (!pythonLayersByGroup.TryGetValue(group.GroupId, out var layerResult))
                {
                    _logger.LogError(
                        "El motor Python no devolvió una capa para el grupo {GroupId} de la paleta {PaletteId} de {ProjectId}/{ImageId}",
                        group.GroupId, paletteId, projectId, imageId);
                    return new VectorLayerSetResult.UpstreamError(
                        "invalid_response", "El motor Python no devolvió una capa para uno de los grupos de la paleta.");
                }

                var vectorId = Guid.NewGuid();
                var storageKey = $"{projectId:N}/{imageId:N}/vector-layers/{paletteId:N}/{vectorId:N}.svg";

                // Causa raíz confirmada de M2.1-S01: VtracerEngine.trace (colormode="binary",
                // compartido con el pipeline B/N) siempre devuelve fill="#000000" -- el color
                // real del grupo nunca se aplicaba a la geometría SVG, solo sobrevivía en la
                // metadata JSON. Se pinta acá, justo antes de persistir, con el ColorHex real
                // del ColorGroup -- ver SvgFillWriter para el detalle de por qué en .NET y no
                // en Python/VtracerEngine.
                string filledSvg;
                try
                {
                    filledSvg = SvgFillWriter.Apply(layerResult.Svg, group.ColorHex);
                }
                catch (InvalidLayerSvgException ex)
                {
                    _logger.LogError(
                        ex, "El SVG devuelto por Python para el grupo {GroupId} de {ProjectId}/{ImageId} no se pudo pintar con su color real",
                        group.GroupId, projectId, imageId);
                    return new VectorLayerSetResult.UpstreamError(
                        "invalid_response", "El SVG devuelto por el motor Python para una de las capas no es válido.");
                }

                _logger.LogInformation(
                    "Capa {GroupId} pintada con fill {ColorHex} para paleta {PaletteId} de {ProjectId}/{ImageId}",
                    group.GroupId, group.ColorHex, paletteId, projectId, imageId);

                try
                {
                    var svgBytes = Encoding.UTF8.GetBytes(filledSvg);
                    await using var svgContent = new MemoryStream(svgBytes);
                    await _fileStorage.SaveAsync(storageKey, svgContent, layerResult.ContentType, cancellationToken);
                }
                catch (FileStorageException ex)
                {
                    _logger.LogError(
                        ex, "Fallo de storage al guardar el SVG de la capa del grupo {GroupId} de {ProjectId}/{ImageId}",
                        group.GroupId, projectId, imageId);
                    return new VectorLayerSetResult.UpstreamError(
                        "storage_failure", "No se pudo guardar el SVG de una de las capas generadas.");
                }

                var vectorVersion = new VectorVersion(
                    ProjectId: projectId,
                    ImageId: imageId,
                    Version: _vectorRegistry.NextVersion(projectId, imageId),
                    VectorId: vectorId,
                    SourceMaskId: group.GroupId,
                    Parameters: new VectorParameters(),
                    SvgStorageKey: storageKey,
                    ContentType: layerResult.ContentType,
                    Width: layerResult.Width,
                    Height: layerResult.Height,
                    Metrics: layerResult.Metrics,
                    CreatedAt: DateTimeOffset.UtcNow);
                _vectorRegistry.Save(vectorVersion);

                // M2.1-S03: la validación raster-vs-vector YA la calculó el
                // motor Python (ver PythonVectorLayerClient/raster_validation.py)
                // -- acá solo se surfacea como advertencia si corresponde,
                // sin recalcular nada. Nunca bloquea la generación de la capa
                // (decisión documentada: "advertir, no bloquear").
                if (!layerResult.RasterValidation.IsWithinTolerance)
                {
                    _logger.LogWarning(
                        "Validación raster-vs-vector fuera de tolerancia para la capa {GroupId} ({ColorHex}) de la paleta {PaletteId} de {ProjectId}/{ImageId}: {Warnings}",
                        group.GroupId, group.ColorHex, paletteId, projectId, imageId, string.Join(" ", layerResult.RasterValidation.Warnings));
                }

                layers.Add(new VectorLayer(
                    group.GroupId, group.Name, group.ColorHex, group.AreaPercent, group.HasPartialAlpha, vectorId, layerResult.RasterValidation));
            }

            var version = _layerSetRegistry.NextVersion(projectId, imageId, paletteId);
            var record = new VectorLayerSetVersion(
                projectId,
                imageId,
                version,
                Guid.NewGuid(),
                paletteId,
                palette.Version,
                layers,
                palette.SourceWidthPx,
                palette.SourceHeightPx,
                DateTimeOffset.UtcNow);
            _layerSetRegistry.Save(record);

            _logger.LogInformation(
                "Conjunto de capas {LayerSetId} (v{Version}) generado para paleta {PaletteId} (v{PaletteVersion}) de {ProjectId}/{ImageId} ({LayerCount} capas)",
                record.LayerSetId, version, paletteId, palette.Version, projectId, imageId, layers.Count);

            return new VectorLayerSetResult.Ready(record, FromCache: false);
        }
        finally
        {
            gate.Release();
        }
    }

    public VectorLayerSetVersion? FindLatest(Guid projectId, Guid imageId, Guid paletteId) =>
        _layerSetRegistry.FindLatest(projectId, imageId, paletteId);

    private static async Task DisposeAllAsync(IReadOnlyList<Stream> streams)
    {
        foreach (var stream in streams)
        {
            await stream.DisposeAsync();
        }
    }

    private static SemaphoreSlim SessionGate(Guid projectId, Guid imageId, Guid paletteId) =>
        _sessionLocks.GetOrAdd($"{projectId:N}/{imageId:N}/{paletteId:N}", _ => new SemaphoreSlim(1, 1));

    private static string MapErrorCode(PythonVectorLayerState state) => state switch
    {
        PythonVectorLayerState.CorruptImage => "corrupt_file",
        PythonVectorLayerState.DimensionsExceeded => "dimensions_exceeded",
        PythonVectorLayerState.EmptyMask => "empty_mask",
        PythonVectorLayerState.InvalidParameters => "invalid_parameters",
        PythonVectorLayerState.Timeout => "timeout",
        PythonVectorLayerState.EngineError => "processing_error",
        PythonVectorLayerState.Unavailable => "engine_unavailable",
        PythonVectorLayerState.InvalidResponse => "invalid_response",
        PythonVectorLayerState.InvalidSvg => "invalid_response",
        _ => "processing_error",
    };
}
