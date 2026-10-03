using Microsoft.EntityFrameworkCore;
using Vectorify.Api.VectorDocuments;

namespace Vectorify.Api.Data;

/// <summary>
/// DbContext de EF Core/PostgreSQL introducido por M2.2-S01 (primera tarjeta de
/// MVP2.2), con el DbSet marcador <see cref="SchemaProbe"/>. M2.2-S02 (esta tarjeta)
/// agrega acá el modelo REAL de dominio persistente -- <see cref="User"/>,
/// <see cref="Project"/>, <see cref="Asset"/>, <see cref="VectorDocument"/>,
/// <see cref="DocumentVersion"/>, <see cref="Layer"/>, <see cref="PaletteColor"/> -- al
/// MISMO DbContext (no uno paralelo). <see cref="SchemaProbe"/> queda tal cual, sin que
/// ninguna tarjeta haya pedido todavía removerlo.
///
/// Esta tarjeta NO conecta nada de esto a la aplicación real: ningún endpoint nuevo,
/// ningún repositorio, ninguna query real contra estas tablas (eso es M2.2-S03). Los
/// registries de archivos JSON existentes bajo App_Data/ (PersistentProjectRegistry,
/// PersistentLayerLayoutVersionRegistry, etc.) coexisten sin cambios.
///
/// Ver el ERD + ADR completos en
/// .sprint/3e8d77b2-6398-8129-8517-c62d242f6be1/IMPL.md para el razonamiento detrás de
/// qué se normaliza como tabla propia (Layer/PaletteColor) vs qué se guarda como
/// JSONB/asset (DocumentVersion.MetadataJson, la geometría SVG en sí) y los
/// DeleteBehavior elegidos caso por caso.
/// </summary>
public sealed class VectorizationDbContext : DbContext
{
    public VectorizationDbContext(DbContextOptions<VectorizationDbContext> options)
        : base(options)
    {
    }

    public DbSet<SchemaProbe> SchemaProbes => Set<SchemaProbe>();

    public DbSet<User> Users => Set<User>();

    public DbSet<Project> Projects => Set<Project>();

    public DbSet<Asset> Assets => Set<Asset>();

    public DbSet<VectorDocument> VectorDocuments => Set<VectorDocument>();

    public DbSet<DocumentVersion> DocumentVersions => Set<DocumentVersion>();

    public DbSet<Layer> Layers => Set<Layer>();

    public DbSet<PaletteColor> PaletteColors => Set<PaletteColor>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<SchemaProbe>(entity =>
        {
            entity.ToTable("schema_probes");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.Id).ValueGeneratedOnAdd();
            entity.Property(e => e.CreatedAt).IsRequired();
        });

        modelBuilder.Entity<User>(entity =>
        {
            entity.ToTable("users");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.DisplayName).IsRequired();
            entity.Property(e => e.CreatedAt).IsRequired();
        });

        modelBuilder.Entity<Project>(entity =>
        {
            entity.ToTable("projects");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.Name).IsRequired();
            entity.Property(e => e.CreatedAt).IsRequired();
            entity.Property(e => e.UpdatedAt).IsRequired();

            // Índices pedidos explícitamente por la tarjeta: OwnerId (ownership lookups)
            // y UpdatedAt (listados "más recientes primero" de M2.2-S03 en adelante).
            entity.HasIndex(e => e.OwnerId);
            entity.HasIndex(e => e.UpdatedAt);

            // User -> Project: Restrict. No existe todavía ningún flujo de borrado de
            // User (fuera de alcance de esta tarjeta); Restrict evita que un hard delete
            // de User cascadee silenciosamente sobre todos sus proyectos.
            entity.HasOne(e => e.Owner)
                .WithMany(u => u.Projects)
                .HasForeignKey(e => e.OwnerId)
                .OnDelete(DeleteBehavior.Restrict);

            // Project.ThumbnailAssetId -> Asset: Restrict. Evita borrar un Asset que
            // todavía está referenciado como thumbnail de un proyecto sin primero limpiar
            // el puntero explícitamente -- ver ADR (ciclo Project<->Asset).
            entity.HasOne(e => e.ThumbnailAsset)
                .WithMany()
                .HasForeignKey(e => e.ThumbnailAssetId)
                .OnDelete(DeleteBehavior.Restrict);

            // Project.CurrentVersionId -> DocumentVersion: Restrict, mismo criterio que
            // ThumbnailAsset -- ver ADR.
            entity.HasOne(e => e.CurrentVersion)
                .WithMany()
                .HasForeignKey(e => e.CurrentVersionId)
                .OnDelete(DeleteBehavior.Restrict);

            // Soft delete: cualquier query futura contra Projects excluye por defecto los
            // proyectos con DeletedAt != null. Usar IgnoreQueryFilters() explícitamente
            // para los (pocos) casos que sí necesiten verlos.
            entity.HasQueryFilter(e => e.DeletedAt == null);

            // Concurrencia optimista (M2.2-S03): mapea la columna de SISTEMA "xmin" de
            // PostgreSQL (que el motor actualiza automáticamente en cada UPDATE de la fila,
            // sin que ninguna aplicación la escriba) como concurrency token -- en vez de
            // agregar una columna propia tipo "RowVersion"/"byte[]". Es una shadow property
            // (no existe como miembro en Project.cs): el nombre de la propiedad ("xmin")
            // determina el nombre de columna por convención, y coincide deliberadamente con
            // la columna de sistema real. IsRowVersion() = ValueGeneratedOnAddOrUpdate() +
            // IsConcurrencyToken(). La migración generada para esto NO debe emitir
            // AddColumn/DropColumn para "xmin" -- esa columna ya existe en TODA tabla de
            // PostgreSQL por definición del motor, y un ALTER TABLE ADD COLUMN "xmin" falla
            // en runtime ("column name "xmin" conflicts with a system column name"). Ver
            // Migrations/*_AddProjectConcurrencyToken.cs (editada a mano para remover esas
            // operaciones) e IMPL.md para el razonamiento completo.
            entity.Property<uint>("xmin")
                .HasColumnName("xmin")
                .IsRowVersion();
        });

        modelBuilder.Entity<Asset>(entity =>
        {
            entity.ToTable("assets");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.Type).IsRequired();
            entity.Property(e => e.StorageKey).IsRequired();
            entity.Property(e => e.MimeType).IsRequired();
            entity.Property(e => e.FileName).IsRequired();
            entity.Property(e => e.Checksum).IsRequired();
            entity.Property(e => e.CreatedAt).IsRequired();

            entity.HasIndex(e => e.ProjectId);

            // Asset.ProjectId -> Project: Restrict (no Cascade) para evitar el ciclo de
            // cascada con Project.ThumbnailAssetId -- ver ADR.
            entity.HasOne(e => e.Project)
                .WithMany(p => p.Assets)
                .HasForeignKey(e => e.ProjectId)
                .OnDelete(DeleteBehavior.Restrict);
        });

        modelBuilder.Entity<VectorDocument>(entity =>
        {
            entity.ToTable("vector_documents");
            entity.HasKey(e => e.Id);

            entity.HasIndex(e => e.ProjectId);

            // VectorDocument.ProjectId -> Project: Restrict, mismo criterio que Asset --
            // ver ADR.
            entity.HasOne(e => e.Project)
                .WithMany(p => p.VectorDocuments)
                .HasForeignKey(e => e.ProjectId)
                .OnDelete(DeleteBehavior.Restrict);
        });

        modelBuilder.Entity<DocumentVersion>(entity =>
        {
            entity.ToTable("document_versions");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.ViewBox).IsRequired();

            // Vocabulario cerrado (M2.2-S06): la columna sigue siendo texto libre (no un
            // enum de Postgres), pero la aplicación solo puede escribir/leer uno de los 5
            // valores de DocumentVersionOrigin -- ver DocumentVersionOriginParser.
            entity.Property(e => e.Origin)
                .HasConversion(o => DocumentVersionOriginParser.ToWireValue(o), s => DocumentVersionOriginParser.Parse(s))
                .IsRequired();

            entity.Property(e => e.MetadataJson).HasColumnType("jsonb").IsRequired();
            entity.Property(e => e.CreatedAt).IsRequired();

            // Constraint ÚNICO COMPUESTO: VersionNumber único por VectorDocumentId, no un
            // índice único global -- dos documentos distintos SÍ pueden tener ambos una
            // versión "1".
            entity.HasIndex(e => new { e.VectorDocumentId, e.VersionNumber }).IsUnique();

            // Idempotencia real de POST /api/v2/workspaces/save (M2.2-S07): índice único PARCIAL
            // -- solo sobre valores NO NULOS (HasFilter) -- para no romper ninguna DocumentVersion
            // vieja que nunca mandó un IdempotencyKey (PATCH/Restore, o un Save de antes de esta
            // tarjeta, todos con la columna en null). Npgsql soporta índices únicos parciales
            // reales vía HasFilter, mismo criterio ya documentado en IdempotencyKey más arriba.
            entity.HasIndex(e => e.IdempotencyKey)
                .IsUnique()
                .HasFilter("\"IdempotencyKey\" IS NOT NULL");

            // VectorDocument -> DocumentVersion: Cascade. DocumentVersion es un hijo
            // propio de VectorDocument sin otra entidad apuntándole desde "afuera" de esa
            // relación salvo Project.CurrentVersionId, que es Restrict -- así que si una
            // versión es la actual de algún proyecto, Postgres rechaza el borrado del
            // VectorDocument en cascada (protección real, no solo documentada). Ver ADR.
            entity.HasOne(e => e.VectorDocument)
                .WithMany(d => d.Versions)
                .HasForeignKey(e => e.VectorDocumentId)
                .OnDelete(DeleteBehavior.Cascade);

            // DocumentVersion.SvgAssetId -> Asset: Restrict. Preserva la integridad de
            // snapshots históricos -- no se puede borrar el Asset que es el SVG canónico
            // de una versión sin limpiar el puntero primero.
            entity.HasOne(e => e.SvgAsset)
                .WithMany()
                .HasForeignKey(e => e.SvgAssetId)
                .OnDelete(DeleteBehavior.Restrict);
        });

        modelBuilder.Entity<Layer>(entity =>
        {
            entity.ToTable("layers");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.Name).IsRequired();
            entity.Property(e => e.ManufacturingOperation).HasConversion<string>();

            entity.HasIndex(e => e.VersionId);
            entity.HasIndex(e => e.ColorId);

            // Índice único compuesto (M2.2-S06): el groupId clásico es único DENTRO de cada
            // DocumentVersion (una fila de Layer por groupId por versión), nunca un índice
            // único global sobre GroupId solo -- el mismo groupId SÍ se repite, a propósito,
            // en cada versión donde ese layer conceptual estuvo presente (ver Layer.GroupId).
            entity.HasIndex(e => new { e.VersionId, e.GroupId }).IsUnique();

            // DocumentVersion -> Layer: Cascade. Layer es un hijo propio de
            // DocumentVersion, nada más lo referencia -- ver ADR.
            entity.HasOne(e => e.Version)
                .WithMany(v => v.Layers)
                .HasForeignKey(e => e.VersionId)
                .OnDelete(DeleteBehavior.Cascade);

            // PaletteColor -> Layer: Cascade, mismo criterio (Layer.ColorId es un
            // componente propio de la paleta de esa versión, nada más lo referencia). Con
            // VersionId también en Cascade esto arma un "diamante" de cascada hacia Layer
            // (vía DocumentVersion directo y vía PaletteColor) -- soportado sin problema
            // por PostgreSQL (a diferencia de SQL Server, no restringe múltiples rutas de
            // cascada hacia la misma tabla). Ver ADR.
            entity.HasOne(e => e.Color)
                .WithMany(c => c.Layers)
                .HasForeignKey(e => e.ColorId)
                .OnDelete(DeleteBehavior.Cascade);

            // Layer.SvgAssetId -> Asset: SetNull (M2.2-S05, migración AddLayerSvgAsset).
            // Borrar el Asset no debe cascadear el borrado del Layer -- es metadata
            // recuperable con un nuevo Save, distinto del resto de FKs de Layer (que SÍ
            // cascadean porque Layer es un hijo propio de esa versión/color).
            entity.HasOne(e => e.SvgAsset)
                .WithMany()
                .HasForeignKey(e => e.SvgAssetId)
                .OnDelete(DeleteBehavior.SetNull);
        });

        modelBuilder.Entity<PaletteColor>(entity =>
        {
            entity.ToTable("palette_colors");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.Hex).IsRequired();

            entity.HasIndex(e => e.VersionId);

            // DocumentVersion -> PaletteColor: Cascade, mismo criterio que Layer -- ver
            // ADR.
            entity.HasOne(e => e.Version)
                .WithMany(v => v.PaletteColors)
                .HasForeignKey(e => e.VersionId)
                .OnDelete(DeleteBehavior.Cascade);
        });
    }
}

/// <summary>
/// Tabla marcador MÍNIMA, sin ningún significado de dominio -- ver el comentario de
/// <see cref="VectorizationDbContext"/>. Descartable/reemplazable en cuanto M2.2-S02
/// introduzca el modelo real.
/// </summary>
public sealed class SchemaProbe
{
    public int Id { get; set; }

    public DateTimeOffset CreatedAt { get; set; }
}
