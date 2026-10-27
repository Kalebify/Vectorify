using System.Collections.Concurrent;
using Vectorify.Api.Clients;
using Vectorify.Api.Contracts;
using Vectorify.Api.Imaging;
using Vectorify.Api.Projects;
using Vectorify.Api.Storage;

namespace Vectorify.Api.ColorPalette;

/// <summary>
/// Implementación de <see cref="IColorPaletteService"/>: arranca el flujo
/// multicapa (M2-S01) operando DIRECTAMENTE sobre la imagen original YA
/// subida (<see cref="IProjectRegistry"/>) -- a diferencia del resto del
/// pipeline de MVP1, esta es la tarjeta que INICIA una rama nueva de datos,
/// no una que consume una versión previa de otra etapa (sin discriminador
/// `sourceKind`, ver nota de orquestación de la tarjeta).
///
/// Cache+lock+versionado: SOLO <see cref="DetectAsync"/> llama a Python (la
/// única operación "costosa" que memoizar) -- mismo patrón exacto que
/// SimplificationService/ThresholdService (cache-hit crea una versión NUEVA
/// sin retroceder; lock por clave para que requests concurrentes con la
/// misma combinación no dupliquen la llamada a Python). Merge/Unmerge/
/// Rename/Confirm son ediciones de metadata puras sobre la ÚLTIMA versión de
/// una sesión (PaletteId): no hay ninguna llamada externa que memoizar, pero
/// SÍ se serializan con un lock por sesión (evitar que dos ediciones
/// concurrentes lean la misma "última versión" y una pise el avance de
/// versión de la otra) y SIEMPRE crean una fila nueva -- preservando el
/// mismo principio de "nunca mutar una versión existente" que el resto del
/// pipeline, documentado también en el reporte del sprint.
/// </summary>
public sealed class ColorPaletteService : IColorPaletteService
{
    private readonly IProjectRegistry _projectRegistry;
    private readonly IColorPaletteVersionRegistry _paletteRegistry;
    private readonly IColorPaletteParameterValidator _parameterValidator;
    private readonly IPythonColorPaletteClient _pythonClient;
    private readonly IFileStorage _fileStorage;
    private readonly ILogger<ColorPaletteService> _logger;

    private static readonly ConcurrentDictionary<string, SemaphoreSlim> _sessionLocks = new();

    public ColorPaletteService(
        IProjectRegistry projectRegistry,
        IColorPaletteVersionRegistry paletteRegistry,
        IColorPaletteParameterValidator parameterValidator,
        IPythonColorPaletteClient pythonClient,
        IFileStorage fileStorage,
        ILogger<ColorPaletteService> logger)
    {
        _projectRegistry = projectRegistry;
        _paletteRegistry = paletteRegistry;
        _parameterValidator = parameterValidator;
        _pythonClient = pythonClient;
        _fileStorage = fileStorage;
        _logger = logger;
    }

    public async Task<ColorPaletteResult> DetectAsync(
        Guid projectId, Guid imageId, ColorPaletteDetectRequest request, CancellationToken cancellationToken)
    {
        var validation = _parameterValidator.Validate(request);
        if (!validation.IsValid)
        {
            return new ColorPaletteResult.ValidationFailed(validation.ErrorCode!, validation.ErrorMessage!);
        }

        var parameters = validation.Parameters!;

        var project = _projectRegistry.Find(projectId, imageId);
        if (project is null)
        {
            return new ColorPaletteResult.NotFound("not_found", "No existe un proyecto/imagen con esos IDs.");
        }

        Guid paletteId;
        if (request.PaletteId.HasValue)
        {
            var existing = _paletteRegistry.FindLatest(projectId, imageId, request.PaletteId.Value);
            if (existing is null)
            {
                return new ColorPaletteResult.NotFound("not_found", "No existe una sesión de paleta de colores con ese ID para esta imagen.");
            }

            if (existing.IsConfirmed)
            {
                return new ColorPaletteResult.Conflict(
                    "palette_confirmed", "La paleta ya está confirmada; no admite una nueva detección.");
            }

            paletteId = request.PaletteId.Value;
        }
        else
        {
            paletteId = Guid.NewGuid();
        }

        var gate = SessionGate(projectId, imageId, paletteId);
        await gate.WaitAsync(cancellationToken);
        try
        {
            var cached = _paletteRegistry.FindByParams(projectId, imageId, paletteId, parameters);
            if (cached is not null)
            {
                var cachedVersion = _paletteRegistry.NextVersion(projectId, imageId, paletteId);
                var cachedRecord = cached with { Version = cachedVersion, CreatedAt = DateTimeOffset.UtcNow };
                _paletteRegistry.Save(cachedRecord);

                _logger.LogInformation(
                    "Paleta {PaletteId} (v{Version}) reutilizada desde caché para {ProjectId}/{ImageId}",
                    cachedRecord.PaletteId, cachedVersion, projectId, imageId);

                return new ColorPaletteResult.Ready(cachedRecord, FromCache: true);
            }

            Stream sourceContent;
            try
            {
                sourceContent = await _fileStorage.OpenReadAsync(project.StorageKey, cancellationToken);
            }
            catch (FileNotFoundException ex)
            {
                _logger.LogError(
                    ex, "La imagen original {ProjectId}/{ImageId} ya no está disponible en el storage", projectId, imageId);
                return new ColorPaletteResult.UpstreamError(
                    "storage_failure", "La imagen original ya no está disponible en el storage.");
            }

            PythonColorPaletteResult pythonResult;
            await using (sourceContent)
            {
                pythonResult = await _pythonClient.DetectAsync(
                    sourceContent, project.MimeType, project.FileName, parameters, cancellationToken);
            }

            if (pythonResult.State != PythonColorPaletteState.Success)
            {
                return new ColorPaletteResult.UpstreamError(MapErrorCode(pythonResult.State), pythonResult.Message ?? "No se pudo detectar la paleta de colores.");
            }

            // Lo que REALMENTE ejecutó el motor manda: si reporta otra versión de algoritmo, el registro la
            // conserva (y por eso nunca se reutiliza como caché de la versión vigente).
            if (pythonResult.AlgorithmVersion != parameters.AlgorithmVersion)
            {
                _logger.LogWarning(
                    "El motor Python reportó la versión de algoritmo {Reported}; se esperaba {Expected}",
                    pythonResult.AlgorithmVersion, parameters.AlgorithmVersion);
                parameters = parameters with { AlgorithmVersion = pythonResult.AlgorithmVersion };
            }

            var isFamilyStyle = parameters.GroupingStyle == ColorPaletteAlgorithm.BaseColors;
            var familyNumber = 0;
            var groups = new List<ColorGroup>();
            foreach (var pythonGroup in pythonResult.Groups!)
            {
                var groupId = Guid.NewGuid();
                var maskStorageKey = $"{projectId:N}/{imageId:N}/color-palette/{paletteId:N}/masks/{groupId:N}.png";

                try
                {
                    await using var maskContent = new MemoryStream(pythonGroup.MaskBytes);
                    await _fileStorage.SaveAsync(maskStorageKey, maskContent, "image/png", cancellationToken);
                }
                catch (FileStorageException ex)
                {
                    _logger.LogError(ex, "Fallo de storage al guardar la máscara del grupo {GroupId} de {ProjectId}/{ImageId}", groupId, projectId, imageId);
                    return new ColorPaletteResult.UpstreamError("storage_failure", "No se pudo guardar la máscara de un grupo de color.");
                }

                if (isFamilyStyle && !pythonGroup.IsBackground)
                {
                    familyNumber++;
                }

                groups.Add(new ColorGroup(
                    groupId,
                    Name: isFamilyStyle
                        ? (pythonGroup.IsBackground ? "Fondo" : $"Familia {familyNumber}")
                        : $"Color {groups.Count + 1}",
                    ColorHex: pythonGroup.ColorHex,
                    PixelCount: pythonGroup.PixelCount,
                    AreaPercent: pythonGroup.AreaPercent,
                    HasPartialAlpha: pythonGroup.HasPartialAlpha,
                    // Heurística de fondo dominante (M2.1-S02, "el implementador decide y documenta"): SOLO el
                    // grupo de MAYOR área (índice 0 -- pythonResult.Groups ya viene ordenado por área
                    // descendente, ver app.core.color_palette_pipeline.detect_palette) se PRE-marca como
                    // excluido, y únicamente si además toca la mayoría de su perímetro (TouchesBorder, ver
                    // ColorGroup.cs). Es solo una sugerencia inicial: SetExclusionAsync permite cambiarla en
                    // cualquier momento sin afectar el GroupId ni ningún otro grupo.
                    // En base_colors el fondo es un grupo técnico explícito (IsBackground) y es el único pre-excluido;
                    // los blancos interiores viven en su familia y no se excluyen.
                    IsExcluded: isFamilyStyle ? pythonGroup.IsBackground : groups.Count == 0 && pythonGroup.TouchesBorder,
                    RawGroupIds: new[] { pythonGroup.Id },
                    MaskStorageKey: maskStorageKey,
                    MergedFrom: null,
                    IsBackground: pythonGroup.IsBackground,
                    PieceCount: pythonGroup.PieceCount,
                    SourceGroupCount: pythonGroup.SourceGroupCount));
            }

            var version = _paletteRegistry.NextVersion(projectId, imageId, paletteId);
            var previewStorageKey = $"{projectId:N}/{imageId:N}/color-palette/{paletteId:N}/preview/{version}.png";

            try
            {
                await using var previewContent = new MemoryStream(pythonResult.QuantizedPreviewBytes!);
                await _fileStorage.SaveAsync(previewStorageKey, previewContent, "image/png", cancellationToken);
            }
            catch (FileStorageException ex)
            {
                _logger.LogError(ex, "Fallo de storage al guardar el preview cuantizado de {ProjectId}/{ImageId}", projectId, imageId);
                return new ColorPaletteResult.UpstreamError("storage_failure", "No se pudo guardar el preview cuantizado.");
            }

            var record = new ColorPaletteVersion(
                projectId,
                imageId,
                version,
                paletteId,
                parameters,
                groups,
                pythonResult.TransparentPercent!.Value,
                pythonResult.Width!.Value,
                pythonResult.Height!.Value,
                previewStorageKey,
                IsConfirmed: false,
                DateTimeOffset.UtcNow,
                pythonResult.Background);

            _paletteRegistry.Save(record);

            _logger.LogInformation(
                "Paleta {PaletteId} (v{Version}) generada para {ProjectId}/{ImageId} ({ColorCount} colores)",
                paletteId, version, projectId, imageId, groups.Count);

            return new ColorPaletteResult.Ready(record, FromCache: false);
        }
        finally
        {
            gate.Release();
        }
    }

    public async Task<ColorPaletteResult> MergeAsync(
        Guid projectId, Guid imageId, Guid paletteId, ColorPaletteMergeRequest request, CancellationToken cancellationToken)
    {
        var distinctIds = (request.GroupIds ?? Array.Empty<Guid>()).Distinct().ToList();
        if (distinctIds.Count < 2)
        {
            return new ColorPaletteResult.ValidationFailed(
                "invalid_parameters", "Seleccioná al menos 2 grupos distintos para fusionar.");
        }

        var gate = SessionGate(projectId, imageId, paletteId);
        await gate.WaitAsync(cancellationToken);
        try
        {
            var latest = _paletteRegistry.FindLatest(projectId, imageId, paletteId);
            if (latest is null)
            {
                return new ColorPaletteResult.NotFound("not_found", "No existe una sesión de paleta de colores con ese ID para esta imagen.");
            }

            if (latest.IsConfirmed)
            {
                return new ColorPaletteResult.Conflict("palette_confirmed", "La paleta ya está confirmada; no admite ediciones.");
            }

            var selected = latest.Groups.Where(g => distinctIds.Contains(g.GroupId)).ToList();
            if (selected.Count != distinctIds.Count)
            {
                return new ColorPaletteResult.NotFound("group_not_found", "Uno o más grupos indicados no existen en la última versión de la paleta.");
            }

            var newGroupId = Guid.NewGuid();
            var totalPixelCount = selected.Sum(g => g.PixelCount);
            var totalAreaPercent = selected.Sum(g => g.AreaPercent);
            var colorHex = MaskCompositor.WeightedAverageHexColor(
                selected.Select(g => (g.ColorHex, (double)g.PixelCount)).ToList());
            var mergedMaskKey = $"{projectId:N}/{imageId:N}/color-palette/{paletteId:N}/masks/{newGroupId:N}.png";

            byte[] combinedMaskBytes;
            try
            {
                combinedMaskBytes = await MaskCompositor.CombineMasksAsync(
                    _fileStorage, selected.Select(g => g.MaskStorageKey).ToList(), latest.SourceWidthPx, latest.SourceHeightPx, cancellationToken);
                await using var maskContent = new MemoryStream(combinedMaskBytes);
                await _fileStorage.SaveAsync(mergedMaskKey, maskContent, "image/png", cancellationToken);
            }
            catch (Exception ex) when (ex is FileStorageException or FileNotFoundException or InvalidOperationException)
            {
                _logger.LogError(ex, "Fallo al combinar máscaras al fusionar grupos de {ProjectId}/{ImageId}/{PaletteId}", projectId, imageId, paletteId);
                return new ColorPaletteResult.UpstreamError("storage_failure", "No se pudo combinar las máscaras de los grupos seleccionados.");
            }

            var mergedGroup = new ColorGroup(
                newGroupId,
                Name: string.IsNullOrWhiteSpace(request.Name) ? string.Join(" + ", selected.Select(g => g.Name)) : request.Name.Trim(),
                ColorHex: colorHex,
                PixelCount: totalPixelCount,
                AreaPercent: totalAreaPercent,
                HasPartialAlpha: selected.Any(g => g.HasPartialAlpha),
                // Un grupo fusionado solo hereda IsExcluded si TODOS los grupos que lo integran ya
                // estaban excluidos -- fusionar un fondo excluido con un color en primer plano no
                // debería "esconder" el resultado combinado sin que el usuario lo note explícitamente
                // (supuesto documentado, spec.md no lo cuantifica: "el implementador decide y documenta").
                IsExcluded: selected.All(g => g.IsExcluded),
                RawGroupIds: selected.SelectMany(g => g.RawGroupIds).ToList(),
                MaskStorageKey: mergedMaskKey,
                MergedFrom: selected,
                // Fusionar solo produce un grupo técnico de fondo si TODOS lo eran.
                IsBackground: selected.All(g => g.IsBackground),
                PieceCount: selected.Sum(g => g.PieceCount),
                SourceGroupCount: selected.Sum(g => g.SourceGroupCount));

            var newGroups = SortGroups(latest.Groups.Where(g => !distinctIds.Contains(g.GroupId)).Append(mergedGroup));

            var (version, record) = await SaveEditedVersionAsync(latest, newGroups, cancellationToken);
            _logger.LogInformation(
                "Grupos {GroupIds} fusionados en {NewGroupId} para paleta {PaletteId} (v{Version}) de {ProjectId}/{ImageId}",
                string.Join(",", distinctIds), newGroupId, paletteId, version, projectId, imageId);

            return new ColorPaletteResult.Ready(record, FromCache: false);
        }
        finally
        {
            gate.Release();
        }
    }

    public async Task<ColorPaletteResult> UnmergeAsync(
        Guid projectId, Guid imageId, Guid paletteId, ColorPaletteUnmergeRequest request, CancellationToken cancellationToken)
    {
        var gate = SessionGate(projectId, imageId, paletteId);
        await gate.WaitAsync(cancellationToken);
        try
        {
            var latest = _paletteRegistry.FindLatest(projectId, imageId, paletteId);
            if (latest is null)
            {
                return new ColorPaletteResult.NotFound("not_found", "No existe una sesión de paleta de colores con ese ID para esta imagen.");
            }

            if (latest.IsConfirmed)
            {
                return new ColorPaletteResult.Conflict("palette_confirmed", "La paleta ya está confirmada; no admite ediciones.");
            }

            var target = latest.Groups.FirstOrDefault(g => g.GroupId == request.GroupId);
            if (target is null)
            {
                return new ColorPaletteResult.NotFound("group_not_found", "No existe ese grupo en la última versión de la paleta.");
            }

            if (target.MergedFrom is null || target.MergedFrom.Count == 0)
            {
                return new ColorPaletteResult.Conflict(
                    "not_merged", "Este grupo no proviene de una fusión; no hay nada que deshacer.");
            }

            var newGroups = SortGroups(latest.Groups.Where(g => g.GroupId != target.GroupId).Concat(target.MergedFrom));

            var (version, record) = await SaveEditedVersionAsync(latest, newGroups, cancellationToken);
            _logger.LogInformation(
                "Merge deshecho para el grupo {GroupId} de paleta {PaletteId} (v{Version}) de {ProjectId}/{ImageId}",
                request.GroupId, paletteId, version, projectId, imageId);

            return new ColorPaletteResult.Ready(record, FromCache: false);
        }
        finally
        {
            gate.Release();
        }
    }

    public async Task<ColorPaletteResult> RenameAsync(
        Guid projectId, Guid imageId, Guid paletteId, ColorPaletteRenameRequest request, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(request.Name))
        {
            return new ColorPaletteResult.ValidationFailed("invalid_parameters", "El nombre no puede estar vacío.");
        }

        var gate = SessionGate(projectId, imageId, paletteId);
        await gate.WaitAsync(cancellationToken);
        try
        {
            var latest = _paletteRegistry.FindLatest(projectId, imageId, paletteId);
            if (latest is null)
            {
                return new ColorPaletteResult.NotFound("not_found", "No existe una sesión de paleta de colores con ese ID para esta imagen.");
            }

            if (latest.IsConfirmed)
            {
                return new ColorPaletteResult.Conflict("palette_confirmed", "La paleta ya está confirmada; no admite ediciones.");
            }

            if (latest.Groups.All(g => g.GroupId != request.GroupId))
            {
                return new ColorPaletteResult.NotFound("group_not_found", "No existe ese grupo en la última versión de la paleta.");
            }

            var trimmedName = request.Name.Trim();
            var newGroups = SortGroups(latest.Groups.Select(g => g.GroupId == request.GroupId ? g with { Name = trimmedName } : g));

            var version = _paletteRegistry.NextVersion(projectId, imageId, paletteId);
            var record = latest with { Version = version, Groups = newGroups, CreatedAt = DateTimeOffset.UtcNow };
            _paletteRegistry.Save(record);

            return new ColorPaletteResult.Ready(record, FromCache: false);
        }
        finally
        {
            gate.Release();
        }
    }

    public async Task<ColorPaletteResult> SetExclusionAsync(
        Guid projectId, Guid imageId, Guid paletteId, ColorPaletteSetExclusionRequest request, CancellationToken cancellationToken)
    {
        var gate = SessionGate(projectId, imageId, paletteId);
        await gate.WaitAsync(cancellationToken);
        try
        {
            var latest = _paletteRegistry.FindLatest(projectId, imageId, paletteId);
            if (latest is null)
            {
                return new ColorPaletteResult.NotFound("not_found", "No existe una sesión de paleta de colores con ese ID para esta imagen.");
            }

            if (latest.IsConfirmed)
            {
                return new ColorPaletteResult.Conflict("palette_confirmed", "La paleta ya está confirmada; no admite ediciones.");
            }

            if (latest.Groups.All(g => g.GroupId != request.GroupId))
            {
                return new ColorPaletteResult.NotFound("group_not_found", "No existe ese grupo en la última versión de la paleta.");
            }

            // Edición de metadata pura (mismo criterio que RenameAsync): NUNCA toca el GroupId, la
            // máscara ni el preview de ningún grupo -- ni el propio ni los demás (ver spec.md,
            // "Estabilidad de IDs durante la edición").
            var newGroups = SortGroups(
                latest.Groups.Select(g => g.GroupId == request.GroupId ? g with { IsExcluded = request.IsExcluded } : g));

            var version = _paletteRegistry.NextVersion(projectId, imageId, paletteId);
            var record = latest with { Version = version, Groups = newGroups, CreatedAt = DateTimeOffset.UtcNow };
            _paletteRegistry.Save(record);

            _logger.LogInformation(
                "Grupo {GroupId} marcado IsExcluded={IsExcluded} para paleta {PaletteId} (v{Version}) de {ProjectId}/{ImageId}",
                request.GroupId, request.IsExcluded, paletteId, version, projectId, imageId);

            return new ColorPaletteResult.Ready(record, FromCache: false);
        }
        finally
        {
            gate.Release();
        }
    }

    public async Task<ColorPaletteResult> ConfirmAsync(Guid projectId, Guid imageId, Guid paletteId, CancellationToken cancellationToken)
    {
        var gate = SessionGate(projectId, imageId, paletteId);
        await gate.WaitAsync(cancellationToken);
        try
        {
            var latest = _paletteRegistry.FindLatest(projectId, imageId, paletteId);
            if (latest is null)
            {
                return new ColorPaletteResult.NotFound("not_found", "No existe una sesión de paleta de colores con ese ID para esta imagen.");
            }

            if (latest.Groups.Count == 0)
            {
                return new ColorPaletteResult.Conflict("empty_palette", "La paleta no tiene ningún color detectado; no se puede confirmar.");
            }

            var version = _paletteRegistry.NextVersion(projectId, imageId, paletteId);
            var record = latest with { Version = version, IsConfirmed = true, CreatedAt = DateTimeOffset.UtcNow };
            _paletteRegistry.Save(record);

            _logger.LogInformation(
                "Paleta {PaletteId} confirmada (v{Version}) para {ProjectId}/{ImageId} con {ColorCount} colores",
                paletteId, version, projectId, imageId, record.Groups.Count);

            return new ColorPaletteResult.Ready(record, FromCache: false);
        }
        finally
        {
            gate.Release();
        }
    }

    public ColorPaletteVersion? FindLatest(Guid projectId, Guid imageId, Guid paletteId) =>
        _paletteRegistry.FindLatest(projectId, imageId, paletteId);

    private async Task<(int Version, ColorPaletteVersion Record)> SaveEditedVersionAsync(
        ColorPaletteVersion latest, IReadOnlyList<ColorGroup> newGroups, CancellationToken cancellationToken)
    {
        var previewGroups = newGroups.Select(g => (g.MaskStorageKey, g.ColorHex)).ToList();
        var previewBytes = await MaskCompositor.BuildQuantizedPreviewAsync(
            _fileStorage, previewGroups, latest.SourceWidthPx, latest.SourceHeightPx, cancellationToken);

        var version = _paletteRegistry.NextVersion(latest.ProjectId, latest.ImageId, latest.PaletteId);
        var previewStorageKey = $"{latest.ProjectId:N}/{latest.ImageId:N}/color-palette/{latest.PaletteId:N}/preview/{version}.png";

        await using (var previewContent = new MemoryStream(previewBytes))
        {
            await _fileStorage.SaveAsync(previewStorageKey, previewContent, "image/png", cancellationToken);
        }

        var record = latest with
        {
            Version = version,
            Groups = newGroups,
            QuantizedPreviewStorageKey = previewStorageKey,
            CreatedAt = DateTimeOffset.UtcNow,
        };
        _paletteRegistry.Save(record);

        return (version, record);
    }

    /// <summary>
    /// Orden de presentación estable: área descendente, empate por nombre
    /// (determinista, sin depender del orden de inserción del diccionario
    /// interno del registro).
    /// </summary>
    private static IReadOnlyList<ColorGroup> SortGroups(IEnumerable<ColorGroup> groups) =>
        groups.OrderBy(g => g.IsBackground).ThenByDescending(g => g.AreaPercent).ThenBy(g => g.Name, StringComparer.Ordinal).ToList();

    private static SemaphoreSlim SessionGate(Guid projectId, Guid imageId, Guid paletteId) =>
        _sessionLocks.GetOrAdd($"{projectId:N}/{imageId:N}/{paletteId:N}", _ => new SemaphoreSlim(1, 1));

    private static string MapErrorCode(PythonColorPaletteState state) => state switch
    {
        PythonColorPaletteState.CorruptImage => "corrupt_image",
        PythonColorPaletteState.DimensionsExceeded => "dimensions_exceeded",
        PythonColorPaletteState.InvalidParameters => "invalid_parameters",
        PythonColorPaletteState.Timeout => "timeout",
        PythonColorPaletteState.EngineError => "processing_error",
        PythonColorPaletteState.Unavailable => "engine_unavailable",
        PythonColorPaletteState.InvalidResponse => "invalid_response",
        PythonColorPaletteState.InvalidPaletteResponse => "invalid_response",
        _ => "processing_error",
    };
}
