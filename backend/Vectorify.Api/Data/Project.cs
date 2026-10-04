namespace Vectorify.Api.Data;

/// <summary>
/// Un proyecto persistente (M2.2-S02) -- conceptualmente más rico que
/// <see cref="Vectorify.Api.Projects.ProjectRecord"/> (hoy solo
/// ProjectId+ImageId+metadata del archivo subido, vía
/// <see cref="Vectorify.Api.Projects.PersistentProjectRegistry"/>): agrega ownership
/// (<see cref="OwnerId"/>), nombre/descripción editables y punteros a
/// <see cref="ThumbnailAssetId"/>/<see cref="CurrentVersionId"/>. Mantiene el mismo
/// nombre de concepto ("ProjectId" como identificador estable, acá <see cref="Id"/>)
/// para que M2.2-S03 pueda razonar el mapeo sin ambigüedad -- NO reemplaza el registry
/// JSON existente todavía, esa migración es responsabilidad de esa tarjeta siguiente.
///
/// <see cref="DeletedAt"/> es soft delete: ver el global query filter
/// (<c>HasQueryFilter(p =&gt; p.DeletedAt == null)</c>) configurado en
/// <see cref="VectorizationDbContext.OnModelCreating"/>, que excluye por defecto
/// cualquier Project borrado de TODAS las queries futuras contra este DbSet. Los pocos
/// casos que sí necesiten ver proyectos borrados deben usar
/// <c>.IgnoreQueryFilters()</c> explícitamente.
/// </summary>
public sealed class Project
{
    public Guid Id { get; set; }

    public Guid OwnerId { get; set; }

    public User? Owner { get; set; }

    public string Name { get; set; } = string.Empty;

    /// <summary>
    /// Nullable: no todo proyecto tiene una descripción (la tarjeta no marca este campo
    /// como obligatorio en "Entidades mínimas").
    /// </summary>
    public string? Description { get; set; }

    public Guid? ThumbnailAssetId { get; set; }

    public Asset? ThumbnailAsset { get; set; }

    public Guid? CurrentVersionId { get; set; }

    public DocumentVersion? CurrentVersion { get; set; }

    /// <summary>
    /// Triple clásico (M2.2-S08) con el que se reabre el Workspace de este proyecto desde la
    /// pantalla Mis Proyectos: son los identificadores del flujo clásico (staging) vigentes en el
    /// PRIMER Save, que creó este Project v2. Se setean una sola vez y nunca se modifican después.
    /// Nullable: un proyecto creado antes de esta tarjeta, o vía <c>POST /api/v2/projects</c> sin
    /// Save, no los tiene (sin backfill, el dato no existe) -- la UI lo trata como "no se puede
    /// reabrir".
    /// </summary>
    public Guid? ClassicProjectId { get; set; }

    public Guid? ClassicImageId { get; set; }

    public Guid? ClassicPaletteId { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    public DateTimeOffset UpdatedAt { get; set; }

    public DateTimeOffset? DeletedAt { get; set; }

    public ICollection<Asset> Assets { get; set; } = new List<Asset>();

    public ICollection<VectorDocument> VectorDocuments { get; set; } = new List<VectorDocument>();
}
