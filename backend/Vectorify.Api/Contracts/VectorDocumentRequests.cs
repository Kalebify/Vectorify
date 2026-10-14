namespace Vectorify.Api.Contracts;

/// <summary>
/// Body de <c>POST /api/v2/workspaces/save</c> (M2.2-S05). <see cref="ProjectId"/> null ->
/// crea un <see cref="Vectorify.Api.Data.Project"/> nuevo (<see cref="Name"/> requerido en ese
/// caso); no-null -> agrega una <see cref="Vectorify.Api.Data.DocumentVersion"/> nueva al
/// <see cref="Vectorify.Api.Data.VectorDocument"/> existente de ese proyecto.
/// <see cref="ClassicProjectId"/>/<see cref="ImageId"/>/<see cref="PaletteId"/> identifican el
/// triple clásico (staging) del que se resuelve el layer set/paleta/layout/operaciones
/// VIGENTES -- el servidor NUNCA confía en geometría/metadata mandada por el cliente más allá
/// de estos identificadores. <see cref="PaletteVersion"/> viaja informativamente (el servidor
/// siempre resuelve la versión vigente de la paleta vía
/// <see cref="Vectorify.Api.ColorPalette.IColorPaletteService.FindLatest"/>, nunca confía en
/// este valor para la escritura -- ver spec.md M2.2-S05). <see cref="DimensionId"/> opcional:
/// si se manda, resuelve esas dimensiones físicas ya aplicadas; si no, default 1px = 1mm.
/// </summary>
/// <param name="IdempotencyKey">
/// M2.2-S07: GUID generado por el CLIENTE, UNA vez por intento lógico de guardar -- el mismo
/// valor se reenvía en cada reintento automático/manual de ESE mismo intento, nunca uno nuevo
/// por reintento. Null/vacío = sin idempotencia (comportamiento anterior a esta tarjeta, nunca
/// deduplica). Mismo criterio ya existente en
/// <see cref="Vectorify.Api.Projects.ProjectRecord.IdempotencyKey"/>/
/// <see cref="Vectorify.Api.Projects.ProjectUploadService.UploadAsync"/> -- reusado acá, no
/// reinventado.
/// </param>
public sealed record VectorDocumentSaveRequest(
    Guid? ProjectId,
    string? Name,
    Guid ClassicProjectId,
    Guid ImageId,
    Guid PaletteId,
    int PaletteVersion,
    Guid? DimensionId,
    string? IdempotencyKey = null);

/// <summary>
/// Body de <c>PATCH /api/v2/projects/{projectId}/layers/{layerId}</c> (M2.2-S05): mismo
/// criterio PATCH que <see cref="UpdateProjectRequest"/> -- un campo <c>null</c> significa "sin
/// cambios". <see cref="ManufacturingOperation"/> acepta "cut"/"engrave"/"ignore" (asigna) o
/// "unassigned" (vacía explícitamente la asignación) -- a diferencia de
/// <see cref="ManufacturingOperationRequest"/> (que nunca acepta "unassigned" como entrada),
/// acá SÍ hace falta distinguir "no tocar" (null) de "vaciar" ("unassigned") porque este es un
/// PATCH parcial sobre una fila ya persistida, no una asignación siempre-reemplaza como la del
/// sidecar clásico.
/// </summary>
public sealed record UpdateLayerRequest(
    string? Name,
    int? Order,
    bool? Visible,
    bool? Locked,
    string? ManufacturingOperation);

/// <summary>
/// Una capa dentro de <see cref="EditorSaveRequest"/> (M3-S13): el SVG serializado de la
/// capa + su metadata. <see cref="ColorHex"/>/<see cref="ColorCoverage"/>/
/// <see cref="ColorIsBackground"/> son la info de paleta necesaria para reconstruir la fila
/// <see cref="Vectorify.Api.Data.PaletteColor"/> -- el cliente siempre los tiene (los leyó del
/// servidor para capas existentes; los generó al crear la capa para <see cref="IsNew"/>).
/// Supuesto documentado en IMPL.md: el spec no los listaba explícitamente pero son necesarios
/// para que el repositorio pueda escribir las filas PaletteColor requeridas por el esquema.
/// </summary>
public sealed record EditorSaveLayerRequest(
    Guid GroupId,
    string SvgContent,
    string Name,
    int Order,
    bool Visible,
    bool Locked,
    string? ManufacturingOperation,
    bool IsNew,
    string ColorHex,
    double ColorCoverage = 0,
    bool ColorIsBackground = false);

/// <summary>
/// Body de <c>POST /api/v2/projects/{projectId}/document/editor-save</c> (M3-S13): persiste
/// el estado completo de geometría del editor como una nueva <see cref="Vectorify.Api.Data.DocumentVersion"/>.
/// Difiere de <see cref="VectorDocumentSaveRequest"/> en que el cliente manda directamente el
/// SVG serializado de cada capa (resultado de <c>serializeEditableLayer</c>), sin resolver el
/// estado clásico en el servidor. <see cref="Origin"/> debe ser "MANUAL_EDIT" o "AUTOSAVE".
/// <see cref="IdempotencyKey"/>: mismo criterio que <see cref="VectorDocumentSaveRequest.IdempotencyKey"/>
/// -- se genera UNA vez por intento lógico y se reenvía en cada reintento de ESE mismo intento.
/// <see cref="RemovedLayerGroupIds"/>: capas que el usuario eliminó en el editor -- el servidor
/// simplemente omite esas capas del snapshot (no las incluye en la nueva versión).
/// </summary>
public sealed record EditorSaveRequest(
    string Origin,
    string IdempotencyKey,
    string ViewBox,
    double WidthMm,
    double HeightMm,
    int SchemaVersion,
    IReadOnlyList<EditorSaveLayerRequest> Layers,
    IReadOnlyList<string>? RemovedLayerGroupIds = null);
