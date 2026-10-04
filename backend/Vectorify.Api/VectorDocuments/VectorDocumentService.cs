using Microsoft.EntityFrameworkCore;
using Vectorify.Api.Assets;
using Vectorify.Api.ColorPalette;
using Vectorify.Api.Contracts;
using Vectorify.Api.Data;
using Vectorify.Api.Dimensioning;
using Vectorify.Api.Imaging;
using Vectorify.Api.LayerLayout;
using Vectorify.Api.ManufacturingOperations;
using Vectorify.Api.ProjectManagement;
using Vectorify.Api.Projects;
using Vectorify.Api.Projects.Persistence;
using Vectorify.Api.Storage;
using Vectorify.Api.Users;
using Vectorify.Api.VectorDocuments.Persistence;
using Vectorify.Api.VectorLayers;
using Vectorify.Api.Vectorization;

namespace Vectorify.Api.VectorDocuments;

/// <summary>Implementación de <see cref="IVectorDocumentService"/> (M2.2-S05). Ver la interfaz para el rol en la arquitectura.</summary>
public sealed class VectorDocumentService : IVectorDocumentService
{
    /// <summary>
    /// Versión de esquema que ESTA tarjeta escribe/entiende (spec.md M2.2-S05: "esta tarjeta
    /// fija su valor inicial (1)"). <see cref="GetDocumentAsync"/> rechaza con
    /// <see cref="VectorDocumentResult.UpstreamError"/> (422) cualquier
    /// <see cref="Vectorify.Api.Data.VectorDocument.SchemaVersion"/> mayor a este valor, en vez
    /// de intentar leerla igual.
    /// </summary>
    public const int CurrentSchemaVersion = 1;

    private readonly IVectorDocumentRepository _repository;
    private readonly IProjectRepository _projectRepository;
    private readonly IProjectService _projectService;
    private readonly IVectorLayerService _vectorLayerService;
    private readonly IColorPaletteService _colorPaletteService;
    private readonly ILayerLayoutService _layerLayoutService;
    private readonly IManufacturingOperationService _manufacturingOperationService;
    private readonly IDimensionService _dimensionService;
    private readonly IVectorVersionRegistry _vectorVersionRegistry;
    private readonly IFileStorage _fileStorage;
    private readonly IProjectRegistry _projectRegistry;
    private readonly IAssetService _assetService;
    private readonly IUserContext _userContext;
    private readonly ILogger<VectorDocumentService> _logger;

    public VectorDocumentService(
        IVectorDocumentRepository repository,
        IProjectRepository projectRepository,
        IProjectService projectService,
        IVectorLayerService vectorLayerService,
        IColorPaletteService colorPaletteService,
        ILayerLayoutService layerLayoutService,
        IManufacturingOperationService manufacturingOperationService,
        IDimensionService dimensionService,
        IVectorVersionRegistry vectorVersionRegistry,
        IFileStorage fileStorage,
        IProjectRegistry projectRegistry,
        IAssetService assetService,
        IUserContext userContext,
        ILogger<VectorDocumentService> logger)
    {
        _repository = repository;
        _projectRepository = projectRepository;
        _projectService = projectService;
        _vectorLayerService = vectorLayerService;
        _colorPaletteService = colorPaletteService;
        _layerLayoutService = layerLayoutService;
        _manufacturingOperationService = manufacturingOperationService;
        _dimensionService = dimensionService;
        _vectorVersionRegistry = vectorVersionRegistry;
        _fileStorage = fileStorage;
        _projectRegistry = projectRegistry;
        _assetService = assetService;
        _userContext = userContext;
        _logger = logger;
    }

    public async Task<VectorDocumentResult> SaveAsync(VectorDocumentSaveRequest request, CancellationToken cancellationToken)
    {
        // El Project de un PRIMER Save se crea ANTES de validar el estado clásico y subir los SVGs
        // (los Assets necesitan su ProjectId). Si ese Save no termina en un documento guardado, el
        // proyecto quedaría en Mis Proyectos sin documento ni capas (M2.2-S08, revisión): se
        // descarta (soft-delete) antes de devolver el error.
        Guid? createdProjectId = null;
        var succeeded = false;
        try
        {
            var result = await SaveCoreAsync(request, projectId => createdProjectId = projectId, cancellationToken);
            succeeded = result is VectorDocumentResult.Saved or VectorDocumentResult.Replayed;
            return result;
        }
        finally
        {
            if (createdProjectId is { } orphanId && !succeeded)
            {
                try
                {
                    await _projectRepository.SoftDeleteAsync(orphanId, _userContext.GetEffectiveUserId(), CancellationToken.None);
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "No se pudo descartar el proyecto {ProjectId} de un primer Save fallido", orphanId);
                }
            }
        }
    }

    private async Task<VectorDocumentResult> SaveCoreAsync(
        VectorDocumentSaveRequest request, Action<Guid> onProjectCreated, CancellationToken cancellationToken)
    {
        if (request.ClassicProjectId == Guid.Empty || request.ImageId == Guid.Empty || request.PaletteId == Guid.Empty)
        {
            return new VectorDocumentResult.ValidationFailed(
                "invalid_request", "classicProjectId, imageId y paletteId son requeridos.");
        }

        var ownerId = _userContext.GetEffectiveUserId();

        // Idempotencia real (M2.2-S07): un reintento (red lenta que hizo timeout del lado del
        // cliente pero el servidor sí terminó, o un segundo click mientras el primero seguía en
        // vuelo) reenvía la MISMA idempotencyKey -- si ya existe una DocumentVersion con esa key,
        // se devuelve ESE resultado tal cual, SIN crear nada nuevo, sin re-resolver el estado
        // clásico ni re-subir ningún SVG (ver spec.md M2.2-S07, "Backend: idempotencia real").
        //
        // M2.2-S09: la key se guarda/busca con el dueño como prefijo (ver ScopeIdempotencyKey): el
        // índice único de DocumentVersion.IdempotencyKey es GLOBAL, así que sin esto la key de A
        // hacía fallar con 500 el Save de B (y B podía deducir que la key de A existe).
        var scopedIdempotencyKey = string.IsNullOrWhiteSpace(request.IdempotencyKey)
            ? null
            : ScopeIdempotencyKey(ownerId, request.IdempotencyKey);
        if (scopedIdempotencyKey is not null)
        {
            var existing = await _repository.FindByIdempotencyKeyAsync(ownerId, scopedIdempotencyKey, cancellationToken);
            if (existing is not null)
            {
                _logger.LogInformation(
                    "Replay de idempotencyKey {IdempotencyKey}: devolviendo la versión {VersionNumber} del proyecto {ProjectId} sin crear una nueva",
                    request.IdempotencyKey, existing.VersionNumber, existing.ProjectId);
                return new VectorDocumentResult.Replayed(existing.ProjectId, existing.VersionNumber, existing.SavedAt);
            }
        }

        // M2.2-S09: puente clásico -> v2. Los uploads del flujo clásico (ProjectRecord) tienen dueño
        // desde esta tarjeta: si el original del triple es de OTRO usuario, el resultado es el mismo
        // NotFound que "no existe" -- y se corta ACÁ, antes de crear el Project, subir Assets o generar
        // el thumbnail, para no dejar nada huérfano. Un registro sin dueño (previo a la tarjeta) sigue
        // siendo accesible. Un registro inexistente no se rechaza acá: lo atrapan los chequeos de
        // paleta/capas de más abajo, como siempre.
        var classicRecord = _projectRegistry.Find(request.ClassicProjectId, request.ImageId);
        if (classicRecord is not null && !classicRecord.IsAccessibleBy(ownerId))
        {
            return new VectorDocumentResult.NotFound("not_found", "No existe un proyecto con ese Id.");
        }

        Guid projectId;
        var createdProjectInThisSave = request.ProjectId is null;
        if (request.ProjectId is null)
        {
            // Reusa IProjectService.CreateAsync (valida Name, resuelve ownerId vía el MISMO
            // IUserContext) en vez de duplicar esa validación acá -- ver spec.md, "no
            // reinventar". El Project queda persistido YA en este punto (sin VectorDocument
            // todavía), así que IVectorDocumentRepository.SaveAsync de más abajo nunca necesita
            // lidiar con un Project nuevo-y-sin-guardar: evita el problema de "dependencia
            // circular de inserts nuevos" que sí aplica en ProjectRepository.DuplicateAsync (acá
            // Project ya existe en la base para cuando se escribe el VectorDocument).
            //
            // M2.2-S08: el triple clásico se persiste ACÁ, junto con el Project, en el PRIMER Save
            // (nunca se modifica después) -- es lo que permite reabrir el Workspace desde Mis
            // Proyectos con el mismo resolveWorkspaceDeepLink del frontend.
            var createResult = await _projectService.CreateAsync(
                request.Name, description: null, cancellationToken,
                new ClassicProjectLink(request.ClassicProjectId, request.ImageId, request.PaletteId));
            switch (createResult)
            {
                case ProjectResult.ValidationFailed validationFailed:
                    return new VectorDocumentResult.ValidationFailed(validationFailed.Code, validationFailed.Message);
                case ProjectResult.Ready ready:
                    projectId = ready.Record.Id;
                    onProjectCreated(projectId);
                    break;
                default:
                    throw new InvalidOperationException(
                        $"Resultado inesperado de IProjectService.CreateAsync: {createResult.GetType().Name}");
            }
        }
        else
        {
            // Chequeo temprano de ownership: evita subir SVGs como Assets (I/O real) para un
            // Project que ni siquiera existe/no es del usuario efectivo.
            var existingProject = await _projectRepository.FindByIdAsync(request.ProjectId.Value, ownerId, cancellationToken);
            if (existingProject is null)
            {
                return new VectorDocumentResult.NotFound("not_found", "No existe un proyecto con ese Id.");
            }

            projectId = existingProject.Id;
        }

        // Resuelve el estado clásico VIGENTE del triple (projectId, imageId, paletteId) --
        // NUNCA confía en geometría/metadata mandada por el cliente más allá de esos
        // identificadores, mismo criterio que ConsolidatedVectorLayerEndpoints. Paleta ANTES que
        // layer set (aunque en la práctica un layer set nunca existe sin una paleta confirmada --
        // IVectorLayerService.GenerateLayersAsync lo exige -- este orden da el código de error
        // más específico/diagnosticable cuando la paleta nunca se confirmó, en vez del genérico
        // "layer_set_not_found" que también sería técnicamente cierto).
        var palette = _colorPaletteService.FindLatest(request.ClassicProjectId, request.ImageId, request.PaletteId);
        if (palette is null)
        {
            return new VectorDocumentResult.UpstreamError(
                "palette_not_found", "No existe una sesión de paleta de colores con ese ID.");
        }

        if (!palette.IsConfirmed)
        {
            return new VectorDocumentResult.UpstreamError(
                "palette_not_confirmed", "La paleta debe estar confirmada antes de guardar el documento.");
        }

        var layerSet = _vectorLayerService.FindLatest(request.ClassicProjectId, request.ImageId, request.PaletteId);
        if (layerSet is null)
        {
            return new VectorDocumentResult.UpstreamError(
                "layer_set_not_found", "No existe un conjunto de capas generado para esa paleta.");
        }

        var layoutCurrent = _layerLayoutService.FindCurrent(request.ClassicProjectId, request.ImageId, request.PaletteId);
        var layoutByGroupId = LayerLayoutDefaults.Resolve(layerSet, layoutCurrent?.Layout).ToDictionary(e => e.GroupId);

        var operationsCurrent = _manufacturingOperationService.FindCurrent(request.ClassicProjectId, request.ImageId, request.PaletteId);
        var operationByGroupId = (operationsCurrent?.Assignments?.Assignments ?? Array.Empty<ManufacturingOperationAssignment>())
            .ToDictionary(a => a.GroupId, a => a.Operation);

        // Bug real encontrado en revisión (M2.2-S05, ronda de fix 2): una vez que el frontend
        // hace el cutover post-Save (ronda de fix 1) y empieza a mandar PATCH v2 directo contra
        // Data.Layer, los sidecars clásicos (layoutCurrent/operationsCurrent de arriba) quedan
        // CONGELADOS desde el primer Save -- el frontend ya nunca vuelve a escribirles. Sin
        // esto, un segundo Save real leería esos valores congelados y "revertiría" en silencio
        // cualquier edición hecha vía PATCH desde el primer Save. La versión YA PERSISTIDA de
        // cada layer (si existe) es la fuente autoritativa real para
        // Name/Order/Visible/Locked/ManufacturingOperation en un Save subsiguiente -- los
        // sidecars clásicos solo se usan como fallback para un layer que todavía nunca se
        // guardó (primer Save del proyecto, o un layer nuevo que el layer set clásico generó
        // después del último Save).
        var currentLayersByGroupId = (await _repository.FindCurrentDocumentAsync(projectId, ownerId, cancellationToken))
            ?.Version.Layers.ToDictionary(l => l.GroupId)
            ?? new Dictionary<Guid, Layer>();

        double widthMm;
        double heightMm;
        if (request.DimensionId is not null)
        {
            var dimension = _dimensionService.FindDimension(request.ClassicProjectId, request.ImageId, request.DimensionId.Value);
            if (dimension is null)
            {
                return new VectorDocumentResult.UpstreamError(
                    "dimension_not_found", "No existen dimensiones físicas aplicadas con ese ID.");
            }

            widthMm = dimension.Parameters.WidthMm;
            heightMm = dimension.Parameters.HeightMm;
        }
        else
        {
            // Default 1px = 1mm cuando nunca se aplicaron dimensiones físicas (spec.md,
            // "Dimensiones físicas") -- nunca inferido de DPI/EXIF.
            widthMm = layerSet.SourceWidthPx;
            heightMm = layerSet.SourceHeightPx;
        }

        var viewBox = $"0 0 {layerSet.SourceWidthPx} {layerSet.SourceHeightPx}";
        var groupsById = palette.Groups.ToDictionary(g => g.GroupId);

        // Orden de layout vigente (order/visible/locked/name) resuelto de a uno -- mismo
        // criterio que ConsolidatedVectorLayerEndpoints -- usado acá además para fijar el orden
        // de iteración (y de Order/Order de paleta) de las capas a persistir. Preferí el Order
        // YA PERSISTIDO (ver comentario de arriba) sobre el del sidecar clásico cuando exista.
        var orderedLayers = layerSet.Layers
            .OrderBy(layer => currentLayersByGroupId.TryGetValue(layer.GroupId, out var currentLayer)
                ? currentLayer.Order
                : layoutByGroupId[layer.GroupId].Order)
            .ToList();

        var layerSnapshots = new List<LayerSnapshot>(orderedLayers.Count);
        var colorOrder = 0;
        foreach (var layer in orderedLayers)
        {
            var vectorVersion = _vectorVersionRegistry.FindByVectorId(request.ClassicProjectId, request.ImageId, layer.VectorId);
            if (vectorVersion is null)
            {
                return new VectorDocumentResult.UpstreamError(
                    "vector_not_found", "El SVG de una de las capas ya no está disponible.");
            }

            byte[] svgBytes;
            try
            {
                await using var stream = await _fileStorage.OpenReadAsync(vectorVersion.SvgStorageKey, cancellationToken);
                using var buffer = new MemoryStream();
                await stream.CopyToAsync(buffer, cancellationToken);
                svgBytes = buffer.ToArray();
            }
            catch (FileNotFoundException)
            {
                _logger.LogError(
                    "El SVG de la capa {GroupId} (VectorId {VectorId}) ya no está disponible en storage (clave {StorageKey})",
                    layer.GroupId, layer.VectorId, vectorVersion.SvgStorageKey);
                return new VectorDocumentResult.UpstreamError(
                    "storage_failure", "El SVG de una de las capas ya no está disponible en el storage.");
            }

            var assetResult = await _assetService.CreateFromBytesAsync(
                projectId, "layer-svg", $"{layer.GroupId:N}.svg", vectorVersion.ContentType, svgBytes, cancellationToken);

            if (assetResult is not AssetResult.Ready assetReady)
            {
                var (code, message) = assetResult switch
                {
                    AssetResult.ValidationFailed vf => (vf.Code, vf.Message),
                    AssetResult.StorageFailed sf => (sf.Code, sf.Message),
                    _ => ("asset_upload_failed", "No se pudo subir el SVG de una de las capas."),
                };

                // Mismo criterio de "sin Layer apuntando a un Asset inexistente" (spec.md,
                // "Tests"): se corta ACÁ, antes de escribir ninguna fila de Layer/DocumentVersion
                // -- ningún Asset subido hasta ahora en este loop queda referenciado por una
                // fila a medio escribir (quedan huérfanos en storage, mismo trade-off ya
                // documentado en AssetService).
                return new VectorDocumentResult.UpstreamError(code, message);
            }

            groupsById.TryGetValue(layer.GroupId, out var group);
            var isBackground = group?.IsExcluded ?? false;

            string name;
            int order;
            bool visible;
            bool locked;
            ManufacturingOperationKind? operation;
            if (currentLayersByGroupId.TryGetValue(layer.GroupId, out var persistedLayer))
            {
                // Ya existe una fila persistida para este layer -- fuente autoritativa real,
                // puede reflejar ediciones hechas vía PATCH v2 que los sidecars clásicos ya no
                // ven (ver comentario de arriba sobre currentLayersByGroupId).
                name = persistedLayer.Name;
                order = persistedLayer.Order;
                visible = persistedLayer.Visible;
                locked = persistedLayer.Locked;
                operation = persistedLayer.ManufacturingOperation;
            }
            else
            {
                // Layer nunca guardado antes -- usa el estado clásico vigente, mismo
                // comportamiento que esta tarjeta tenía antes de este fix.
                var layout = layoutByGroupId[layer.GroupId];
                name = layout.Name ?? layer.Name;
                order = layout.Order;
                visible = layout.Visible;
                locked = layout.Locked;
                operation = operationByGroupId.TryGetValue(layer.GroupId, out var kind)
                    ? (ManufacturingOperationKind?)kind
                    : null;
            }

            layerSnapshots.Add(new LayerSnapshot(
                LayerId: layer.GroupId,
                Name: name,
                Order: order,
                Visible: visible,
                Locked: locked,
                ManufacturingOperation: operation,
                SvgAssetId: assetReady.Record.Id,
                Color: new PaletteColorSnapshot(layer.ColorHex, layer.AreaPercent, isBackground, colorOrder),
                // Bug real encontrado en revisión: sin persistir esto, un documento reabierto no
                // tiene forma de recuperar el pathCount (Data.Layer no guarda geometría) -- el
                // Inspector mostraba "0" en vez del valor real, y "Seleccionar todo en la capa"
                // quedaba silenciosamente roto (loop 0..pathCount-1 de 0 iteraciones).
                PathCount: vectorVersion.Metrics.PathCount));

            colorOrder++;
        }

        var snapshot = new DocumentSnapshot(
            WidthMm: widthMm,
            HeightMm: heightMm,
            ViewBox: viewBox,
            SchemaVersion: CurrentSchemaVersion,
            // M2.2-S06: vocabulario cerrado DocumentVersionOrigin -- reemplaza el string libre
            // "workspace_save" que M2.2-S05 emitía (ver spec.md M2.2-S06, "Origin").
            Origin: DocumentVersionOrigin.ManualEdit,
            MetadataJson: "{}",
            Layers: layerSnapshots,
            IdempotencyKey: scopedIdempotencyKey);

        try
        {
            var outcome = await _repository.SaveAsync(projectId, ownerId, snapshot, cancellationToken);
            if (outcome is null)
            {
                // El Project existía en el chequeo de ownership de arriba pero ya no acá (p.
                // ej. se borró entre medio) -- mismo 404 que cualquier otro "no existe".
                return new VectorDocumentResult.NotFound("not_found", "No existe un proyecto con ese Id.");
            }

            _logger.LogInformation(
                "VectorDocument del proyecto {ProjectId} guardado (versión {VersionNumber}, {LayerCount} capas)",
                outcome.ProjectId, outcome.VersionNumber, layerSnapshots.Count);

            if (createdProjectInThisSave)
            {
                // Solo en el PRIMER Save (el que creó el Project) y DESPUÉS de que el documento ya
                // quedó confirmado en la base: así un Save que falló antes no deja Assets sueltos, y
                // un Save posterior / un replay de idempotencia nunca regenera nada.
                await TryAttachThumbnailAsync(outcome.ProjectId, ownerId, request, cancellationToken);
            }

            return new VectorDocumentResult.Saved(outcome.ProjectId, outcome.VersionNumber, outcome.SavedAt);
        }
        catch (DbUpdateConcurrencyException ex)
        {
            _logger.LogWarning(ex, "Conflicto de concurrencia guardando el VectorDocument del proyecto {ProjectId}", projectId);
            return new VectorDocumentResult.Conflict(
                "concurrency_conflict",
                "El proyecto fue modificado por otro Save concurrente mientras tanto. Volvé a cargarlo e intentá de nuevo.");
        }
    }

    /// <summary>
    /// Clave de idempotencia efectivamente persistida: la del cliente prefijada con el dueño
    /// (<c>{ownerId:N}:{key}</c>). Dos usuarios que manden la misma key no colisionan ni se ven.
    /// Las filas previas a M2.2-S09 (key sin prefijo) dejan de ser replayables -- aceptable: la
    /// ventana de un replay es el reintento inmediato de un Save, no días después.
    /// </summary>
    private static string ScopeIdempotencyKey(Guid ownerId, string idempotencyKey) => $"{ownerId:N}:{idempotencyKey}";

    /// <summary>
    /// Thumbnail best-effort (M2.2-S08): lee el original subido del flujo clásico, lo reduce a
    /// ≤ <see cref="ThumbnailGenerator.MaxSidePx"/> px, lo guarda como Asset v2 de tipo "thumbnail" y
    /// apunta <c>Project.ThumbnailAssetId</c> a él. Cualquier fallo (original ausente/ilegible/no
    /// decodificable, storage, DB) se loguea como warning y se traga: un thumbnail NUNCA hace
    /// fallar un Save que ya se confirmó. Limitación documentada: es la imagen original, no el
    /// render vectorial (no hay rasterizador de SVG en el backend).
    /// </summary>
    private async Task TryAttachThumbnailAsync(
        Guid projectId, Guid ownerId, VectorDocumentSaveRequest request, CancellationToken cancellationToken)
    {
        try
        {
            var original = _projectRegistry.Find(request.ClassicProjectId, request.ImageId);
            if (original is null)
            {
                _logger.LogWarning(
                    "Sin thumbnail para el proyecto {ProjectId}: no se encontró el original clásico (projectId {ClassicProjectId}, imageId {ImageId})",
                    projectId, request.ClassicProjectId, request.ImageId);
                return;
            }

            ThumbnailImage? thumbnail;
            await using (var stream = await _fileStorage.OpenReadAsync(original.StorageKey, cancellationToken))
            {
                // ImageSharp necesita un stream seekable para detectar el formato.
                using var buffer = new MemoryStream();
                await stream.CopyToAsync(buffer, cancellationToken);
                buffer.Position = 0;
                thumbnail = ThumbnailGenerator.TryCreate(buffer);
            }

            if (thumbnail is null)
            {
                _logger.LogWarning(
                    "Sin thumbnail para el proyecto {ProjectId}: el original ({MimeType}) no se pudo decodificar/reducir",
                    projectId, original.MimeType);
                return;
            }

            var extension = thumbnail.ContentType == "image/jpeg" ? "jpg" : "png";
            var assetResult = await _assetService.CreateFromBytesAsync(
                projectId, "thumbnail", $"thumbnail.{extension}", thumbnail.ContentType, thumbnail.Content, cancellationToken);

            if (assetResult is not AssetResult.Ready assetReady)
            {
                _logger.LogWarning("Sin thumbnail para el proyecto {ProjectId}: no se pudo guardar el Asset ({Result})",
                    projectId, assetResult.GetType().Name);
                return;
            }

            await _projectRepository.SetThumbnailAsync(projectId, ownerId, assetReady.Record.Id, cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex, "Sin thumbnail para el proyecto {ProjectId}: falló la generación (el Save no se ve afectado)", projectId);
        }
    }

    public async Task<VectorDocumentResult> GetDocumentAsync(Guid projectId, int? versionNumber, CancellationToken cancellationToken)
    {
        var ownerId = _userContext.GetEffectiveUserId();

        // MISMO método para "la versión actual" (GET .../document, versionNumber null) y "una
        // versión explícita" (GET .../versions/{n}, M2.2-S06) -- ver IVectorDocumentService.
        var found = versionNumber is null
            ? await _repository.FindCurrentDocumentAsync(projectId, ownerId, cancellationToken)
            : await _repository.FindVersionAsync(projectId, ownerId, versionNumber.Value, cancellationToken);

        if (found is null)
        {
            return new VectorDocumentResult.NotFound(
                "not_found", "No existe un proyecto con ese Id, o esa versión no existe para su documento.");
        }

        var (document, version) = found.Value;
        if (version.SchemaVersion > CurrentSchemaVersion)
        {
            return new VectorDocumentResult.UpstreamError(
                "unsupported_schema_version",
                $"Este documento usa una versión de esquema ({version.SchemaVersion}) que este backend todavía no soporta.");
        }

        return new VectorDocumentResult.DocumentReady(document, version);
    }

    public async Task<VectorDocumentResult> ListVersionsAsync(Guid projectId, CancellationToken cancellationToken)
    {
        var ownerId = _userContext.GetEffectiveUserId();
        var versions = await _repository.ListVersionsAsync(projectId, ownerId, cancellationToken);
        return versions is null
            ? new VectorDocumentResult.NotFound(
                "not_found", "No existe un proyecto con ese Id, o todavía no tiene ningún documento guardado.")
            : new VectorDocumentResult.VersionListReady(versions);
    }

    public async Task<VectorDocumentResult> RestoreAsync(Guid projectId, int versionNumber, CancellationToken cancellationToken)
    {
        var ownerId = _userContext.GetEffectiveUserId();

        try
        {
            var outcome = await _repository.RestoreAsync(projectId, ownerId, versionNumber, cancellationToken);
            if (outcome is null)
            {
                return new VectorDocumentResult.NotFound(
                    "not_found", "No existe un proyecto con ese Id, o esa versión no existe para su documento.");
            }

            _logger.LogInformation(
                "VectorDocument del proyecto {ProjectId} restaurado desde la versión {SourceVersionNumber} (nueva versión {VersionNumber})",
                outcome.ProjectId, versionNumber, outcome.VersionNumber);

            return new VectorDocumentResult.Saved(outcome.ProjectId, outcome.VersionNumber, outcome.SavedAt);
        }
        catch (DbUpdateConcurrencyException ex)
        {
            _logger.LogWarning(ex, "Conflicto de concurrencia restaurando el VectorDocument del proyecto {ProjectId}", projectId);
            return new VectorDocumentResult.Conflict(
                "concurrency_conflict",
                "El proyecto fue modificado por otro Save/Restore concurrente mientras tanto. Volvé a cargarlo e intentá de nuevo.");
        }
    }

    public async Task<VectorDocumentResult> UpdateLayerAsync(
        Guid projectId, Guid layerId, UpdateLayerRequest request, CancellationToken cancellationToken)
    {
        if (request.Name is not null && string.IsNullOrWhiteSpace(request.Name))
        {
            return new VectorDocumentResult.ValidationFailed("invalid_name", "El nombre de la capa no puede ser vacío.");
        }

        var touchOperation = false;
        ManufacturingOperationKind? operation = null;
        if (request.ManufacturingOperation is not null)
        {
            touchOperation = true;
            if (!string.Equals(request.ManufacturingOperation, ManufacturingOperationParser.UnassignedWireValue, StringComparison.OrdinalIgnoreCase))
            {
                var parsed = ManufacturingOperationParser.Parse(request.ManufacturingOperation);
                if (parsed is null)
                {
                    return new VectorDocumentResult.ValidationFailed(
                        "invalid_parameters",
                        $"manufacturingOperation '{request.ManufacturingOperation}' desconocido. Valores válidos: cut, engrave, ignore, unassigned.");
                }

                operation = parsed;
            }
        }

        var ownerId = _userContext.GetEffectiveUserId();
        var patch = new LayerPatch(request.Name?.Trim(), request.Order, request.Visible, request.Locked, touchOperation, operation);

        // Fix round 1 (QA post-merge): PATCH ahora crea una DocumentVersion nueva completa (ya
        // no muta la actual in-place, ver el comentario de VectorDocumentRepository.UpdateLayerAsync)
        // -- mismo checkpoint transaccional que Save/Restore, mismo manejo de concurrencia (xmin
        // -> 409).
        try
        {
            var layer = await _repository.UpdateLayerAsync(projectId, ownerId, layerId, patch, cancellationToken);
            return layer is null
                ? new VectorDocumentResult.NotFound("not_found", "No existe esa capa en la versión actual de ese proyecto.")
                : new VectorDocumentResult.LayerReady(layer);
        }
        catch (DbUpdateConcurrencyException ex)
        {
            _logger.LogWarning(ex, "Conflicto de concurrencia patcheando una capa del proyecto {ProjectId}", projectId);
            return new VectorDocumentResult.Conflict(
                "concurrency_conflict",
                "El proyecto fue modificado por otro Save/Restore/PATCH concurrente mientras tanto. Volvé a cargarlo e intentá de nuevo.");
        }
    }
}
