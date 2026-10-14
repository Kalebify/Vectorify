namespace Vectorify.Api.Contracts;

/// <summary>
/// Respuesta de <c>POST /api/v2/workspaces/save</c> (M2.2-S05) y de
/// <c>POST /api/v2/projects/{projectId}/versions/{versionNumber}/restore</c> (M2.2-S06, mismo
/// shape -- "responde igual que ... /workspaces/save", spec.md M2.2-S06): confirmación MÍNIMA
/// de que el checkpoint se persistió -- el cliente ya tiene el resto del documento en memoria
/// (Save) o puede recargarlo vía <c>GET .../document</c> (Restore).
/// </summary>
public sealed record VectorDocumentSaveResponse(Guid ProjectId, int VersionNumber, DateTimeOffset SavedAt);

/// <summary>
/// Respuesta de <c>POST /api/v2/projects/{projectId}/document/editor-save</c> (M3-S13):
/// confirmación de que la versión de geometría del editor se persistió. Incluye
/// <see cref="VersionId"/> (el <see cref="Vectorify.Api.Data.DocumentVersion.Id"/>) para
/// que el frontend pueda referenciar la versión exacta, a diferencia de
/// <see cref="VectorDocumentSaveResponse"/> que solo expone el número secuencial.
/// </summary>
public sealed record EditorSaveResponse(Guid ProjectId, int VersionNumber, Guid VersionId, DateTimeOffset CreatedAt);

/// <summary>
/// Una entrada de <c>GET /api/v2/projects/{projectId}/versions</c> (M2.2-S06): metadata de UNA
/// <see cref="Vectorify.Api.Data.DocumentVersion"/>, SIN su array de layers (eso es carga
/// completa, ver <see cref="VectorDocumentResponse"/>).
/// </summary>
public sealed record VectorDocumentVersionSummaryResponse(
    int VersionNumber,
    string Origin,
    DateTimeOffset CreatedAt,
    double WidthMm,
    double HeightMm,
    string ViewBox,
    int SchemaVersion);

/// <summary>
/// DTO versionado (M2.2-S05) de una <c>DocumentVersion</c> completa de un proyecto -- NUNCA se
/// expone la entidad EF directamente (mismo patrón que <see cref="ProjectResponse"/>).
/// Respuesta de <c>GET /api/v2/projects/{projectId}/document</c> (la versión ACTUAL) Y de
/// <c>GET /api/v2/projects/{projectId}/versions/{versionNumber}</c> (M2.2-S06, cualquier
/// versión histórica -- MISMO shape, "no se duplica lógica entre ambos" spec.md M2.2-S06).
/// </summary>
public sealed record VectorDocumentResponse(
    Guid ProjectId,
    int SchemaVersion,
    double WidthMm,
    double HeightMm,
    string ViewBox,
    int VersionNumber,
    DateTimeOffset CreatedAt,
    IReadOnlyList<VectorDocumentLayerResponse> Layers);

/// <summary>
/// Una capa dentro de <see cref="VectorDocumentResponse"/> (o respuesta individual de
/// <c>PATCH .../layers/{layerId}</c>). <see cref="SvgUrl"/> es null si <see cref="SvgAssetId"/>
/// es null (defensivo -- en la práctica el flujo de Save siempre sube el SVG antes de escribir
/// la fila); cuando no es null, apunta al endpoint de descarga YA EXISTENTE de Assets
/// (<c>GET /api/v2/projects/{projectId}/assets/{assetId}</c>, M2.2-S04) -- no se reinventa un
/// endpoint de descarga paralelo.
/// </summary>
public sealed record VectorDocumentLayerResponse(
    Guid Id,
    string Name,
    int Order,
    bool Visible,
    bool Locked,
    string ManufacturingOperation,
    string ColorHex,
    double Coverage,
    bool IsBackground,
    Guid? SvgAssetId,
    string? SvgUrl,
    int PathCount);
