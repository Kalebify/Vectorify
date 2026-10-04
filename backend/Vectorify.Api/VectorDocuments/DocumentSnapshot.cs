using Vectorify.Api.ManufacturingOperations;

namespace Vectorify.Api.VectorDocuments;

/// <summary>
/// Snapshot PURO de datos (sin ninguna dependencia de EF Core) que
/// <see cref="VectorDocumentService"/> construye resolviendo el estado clásico vigente
/// (layer set + paleta + layout + operaciones, M2.2-S05) y pasa a
/// <see cref="Persistence.IVectorDocumentRepository.SaveAsync"/> para escribir en una sola
/// transacción. Separar la resolución (I/O: Python/storage/sidecars, puede fallar con
/// <see cref="VectorDocumentResult.UpstreamError"/>) de la escritura (EF Core, puede fallar con
/// <see cref="VectorDocumentResult.Conflict"/>) evita mezclar ambas responsabilidades en un
/// solo método gigante.
/// </summary>
/// <param name="IdempotencyKey">
/// M2.2-S07: viaja tal cual desde <see cref="Contracts.VectorDocumentSaveRequest.IdempotencyKey"/>
/// hasta la fila de <see cref="Data.DocumentVersion.IdempotencyKey"/> -- null para cualquier
/// llamador que no sea <see cref="VectorDocumentService.SaveAsync"/> (PATCH/Restore no
/// necesitan idempotencia nueva, ver spec.md M2.2-S07).
/// </param>
public sealed record DocumentSnapshot(
    double WidthMm,
    double HeightMm,
    string ViewBox,
    int SchemaVersion,
    DocumentVersionOrigin Origin,
    string MetadataJson,
    IReadOnlyList<LayerSnapshot> Layers,
    string? IdempotencyKey = null);

/// <summary>
/// Un color de paleta dentro de un <see cref="DocumentSnapshot"/> -- siempre 1:1 con un
/// <see cref="LayerSnapshot"/> en esta tarjeta (una capa por color, igual que el flujo clásico
/// genera "una capa por cada ColorGroup", ver <see cref="Vectorify.Api.VectorLayers.VectorLayerSetVersion"/>),
/// por eso vive anidado en vez de como una lista paralela a emparejar por índice.
/// </summary>
public sealed record PaletteColorSnapshot(string Hex, double Coverage, bool IsBackground, int Order);

/// <summary>
/// Una capa dentro de un <see cref="DocumentSnapshot"/>. <see cref="LayerId"/> es el
/// <c>groupId</c> clásico reutilizado VERBATIM -- desde M2.2-S06 se persiste como
/// <see cref="Data.Layer.GroupId"/> (columna normal, NO la PK) en una fila 100% NUEVA en
/// cada checkpoint (<see cref="Persistence.IVectorDocumentRepository.SaveAsync"/> ya no hace
/// upsert-por-Id, ver el conflicto #1 de spec.md M2.2-S06: el upsert de M2.2-S05 violaba la
/// inmutabilidad de versiones históricas).
/// </summary>
public sealed record LayerSnapshot(
    Guid LayerId,
    string Name,
    int Order,
    bool Visible,
    bool Locked,
    ManufacturingOperationKind? ManufacturingOperation,
    Guid SvgAssetId,
    PaletteColorSnapshot Color,
    int PathCount);

/// <summary>
/// Cambios parciales sobre un <see cref="Vectorify.Api.Data.Layer"/> ya persistido (PATCH
/// .../layers/{layerId}) -- mismo criterio PATCH que <see cref="Vectorify.Api.ProjectManagement.ProjectService.UpdateAsync"/>:
/// un campo <c>null</c> significa "sin cambios". <see cref="TouchOperation"/> distingue
/// "no tocar <see cref="Operation"/>" (false) de "tocar <see cref="Operation"/>, incluso para
/// vaciarlo a null/unassigned" (true) -- un simple <c>ManufacturingOperationKind?</c> no
/// alcanzaría para representar esa tercera posibilidad (vaciar explícitamente).
/// </summary>
public sealed record LayerPatch(
    string? Name,
    int? Order,
    bool? Visible,
    bool? Locked,
    bool TouchOperation,
    ManufacturingOperationKind? Operation);

/// <summary>Resultado de un Save exitoso contra la base (ver <see cref="Persistence.IVectorDocumentRepository.SaveAsync"/>).</summary>
public sealed record VectorDocumentSaveOutcome(Guid ProjectId, int VersionNumber, DateTimeOffset SavedAt);
