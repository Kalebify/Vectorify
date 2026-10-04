using Vectorify.Api.VectorDocuments;

namespace Vectorify.Api.Data;

/// <summary>
/// Una versión de un <see cref="VectorDocument"/> (M2.2-S02). <see cref="VersionNumber"/>
/// es único POR <see cref="VectorDocumentId"/> (constraint compuesto configurado en
/// <see cref="VectorizationDbContext.OnModelCreating"/>) -- nunca un índice único global:
/// dos documentos distintos SÍ pueden tener ambos una versión "1". <see cref="SvgAssetId"/>
/// referencia el snapshot SVG real como asset (nullable: una versión puede existir sin
/// snapshot generado todavía). <see cref="MetadataJson"/> se persiste como JSONB real
/// (Npgsql lo soporta nativamente) para metadata heterogénea/evolutiva que no amerita
/// columnas propias todavía (ej. <c>{"restoredFromVersion": N}</c> que pone
/// <see cref="VectorDocumentService.RestoreAsync"/>) -- ver ADR en IMPL.md.
///
/// <see cref="WidthMm"/>/<see cref="HeightMm"/>/<see cref="ViewBox"/>/
/// <see cref="SchemaVersion"/> (M2.2-S06, migración <c>MoveDocumentDimensionsToVersion</c>):
/// movidos acá desde <see cref="VectorDocument"/> (donde vivían sin versionar desde
/// M2.2-S02) -- ver el conflicto #2 de spec.md M2.2-S06: sin esto, restaurar una versión
/// vieja no podía devolver las dimensiones que tenía esa versión si cambiaron en saves
/// posteriores, misma garantía de inmutabilidad/restauración que <see cref="Layer.GroupId"/>.
///
/// <see cref="Origin"/> (M2.2-S06): vocabulario cerrado
/// <see cref="DocumentVersionOrigin"/>, persistido como texto
/// (<c>HasConversion</c> vía <see cref="DocumentVersionOriginParser"/>) -- antes un
/// <c>string</c> libre sin restricción (M2.2-S02/S05).
/// </summary>
public sealed class DocumentVersion
{
    public Guid Id { get; set; }

    public Guid VectorDocumentId { get; set; }

    public VectorDocument? VectorDocument { get; set; }

    public int VersionNumber { get; set; }

    public double WidthMm { get; set; }

    public double HeightMm { get; set; }

    /// <summary>
    /// String plano (ej. "0 0 800 600"), no JSONB: se consulta poco y no amerita un tipo
    /// estructurado -- ver ADR en IMPL.md.
    /// </summary>
    public string ViewBox { get; set; } = string.Empty;

    public int SchemaVersion { get; set; }

    public Guid? SvgAssetId { get; set; }

    public Asset? SvgAsset { get; set; }

    public DocumentVersionOrigin Origin { get; set; }

    public string MetadataJson { get; set; } = "{}";

    /// <summary>
    /// GUID generado por el CLIENTE (M2.2-S07, idempotencia real de <c>POST /api/v2/workspaces/save</c>)
    /// -- el mismo valor se reenvía en cada reintento del MISMO intento lógico de guardar, nunca
    /// uno nuevo por reintento. Null para cualquier <see cref="DocumentVersion"/> que no vino de
    /// ese endpoint (PATCH de layer, Restore) o que nunca mandó uno (requests viejos, clientes
    /// pre-M2.2-S07) -- por eso el índice único de <see cref="VectorizationDbContext.OnModelCreating"/>
    /// es PARCIAL (solo sobre valores no nulos, <c>HasFilter</c>), igual criterio que
    /// <see cref="Vectorify.Api.Projects.ProjectRecord.IdempotencyKey"/>/
    /// <see cref="Vectorify.Api.Projects.ProjectUploadService.UploadAsync"/> -- reusado acá, no
    /// reinventado.
    /// </summary>
    public string? IdempotencyKey { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    public ICollection<Layer> Layers { get; set; } = new List<Layer>();

    public ICollection<PaletteColor> PaletteColors { get; set; } = new List<PaletteColor>();
}
