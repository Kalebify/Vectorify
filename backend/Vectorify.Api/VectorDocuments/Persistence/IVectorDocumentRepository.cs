using Vectorify.Api.Data;

namespace Vectorify.Api.VectorDocuments.Persistence;

/// <summary>
/// Acceso a datos de <see cref="VectorDocument"/>/<see cref="DocumentVersion"/>/<see cref="Layer"/>/
/// <see cref="PaletteColor"/> (M2.2-S05/S06) contra PostgreSQL vía EF Core. Mismo patrón
/// arquitectónico que <see cref="Vectorify.Api.Projects.Persistence.IProjectRepository"/>
/// (M2.2-S03)/<see cref="Vectorify.Api.Assets.Persistence.IAssetRepository"/> (M2.2-S04): vive
/// en un sub-namespace <c>.Persistence</c> propio, y NO resuelve ownership "de negocio" --
/// recibe <c>ownerId</c> explícito y SIEMPRE filtra por él, nunca una query sin ese filtro.
///
/// A diferencia de esos dos repositorios (CRUD simple sobre una sola tabla), este orquesta la
/// escritura de TODO el grafo (VectorDocument + DocumentVersion + Layer + PaletteColor + el
/// puntero Project.CurrentVersionId) en una ÚNICA transacción EF Core -- ver
/// <see cref="VectorDocumentRepository.SaveAsync"/>/<see cref="VectorDocumentRepository.RestoreAsync"/>
/// para el detalle de por qué.
/// </summary>
public interface IVectorDocumentRepository
{
    /// <summary>
    /// Agrega una <see cref="DocumentVersion"/> nueva (creando el <see cref="VectorDocument"/>
    /// si el <see cref="Project"/> todavía no tenía uno) INSERTANDO SIEMPRE filas 100% nuevas
    /// de <see cref="Layer"/>/<see cref="PaletteColor"/> (M2.2-S06: nunca reutiliza/actualiza
    /// una fila de una versión anterior -- ver el conflicto #1 de spec.md M2.2-S06, el upsert
    /// de M2.2-S05 violaba la inmutabilidad de versiones históricas), y actualiza
    /// <see cref="Project.CurrentVersionId"/>/<see cref="Project.UpdatedAt"/> -- todo en un
    /// único <c>SaveChangesAsync</c>. Null si el proyecto no existe o no pertenece a
    /// <paramref name="ownerId"/>. Puede lanzar
    /// <see cref="Microsoft.EntityFrameworkCore.DbUpdateConcurrencyException"/> si el
    /// concurrency token (xmin) de <see cref="Project"/> cambió desde que se leyó la fila
    /// (Save concurrente) -- <see cref="VectorDocumentService"/> la traduce a
    /// <see cref="VectorDocumentResult.Conflict"/> (409).
    /// </summary>
    Task<VectorDocumentSaveOutcome?> SaveAsync(
        Guid projectId, Guid ownerId, DocumentSnapshot snapshot, CancellationToken cancellationToken);

    /// <summary>
    /// La <see cref="VectorDocument"/>/<see cref="DocumentVersion"/> ACTUAL
    /// (<see cref="Project.CurrentVersionId"/>) de un proyecto, con Layers (+ su
    /// <see cref="PaletteColor"/>) y PaletteColors ya cargados. Null si el proyecto no existe,
    /// no pertenece a <paramref name="ownerId"/>, o no tiene ninguna versión guardada todavía
    /// (<see cref="Project.CurrentVersionId"/> null) -- mismo 404 uniforme para los tres casos.
    /// Caso particular de <see cref="FindVersionAsync"/> (M2.2-S06): resuelve el
    /// <see cref="DocumentVersion.VersionNumber"/> de la versión actual y delega ahí, sin
    /// duplicar la lógica de carga del grafo completo.
    /// </summary>
    Task<(VectorDocument Document, DocumentVersion Version)?> FindCurrentDocumentAsync(
        Guid projectId, Guid ownerId, CancellationToken cancellationToken);

    /// <summary>
    /// Una <see cref="DocumentVersion"/> CUALQUIERA (no solo la actual, M2.2-S06) de un
    /// proyecto, identificada por su <paramref name="versionNumber"/> (único por
    /// <see cref="VectorDocument"/>), con Layers (+ su <see cref="PaletteColor"/>) y
    /// PaletteColors ya cargados -- mismo shape que <see cref="FindCurrentDocumentAsync"/>.
    /// Null si el proyecto no existe, no pertenece a <paramref name="ownerId"/>, todavía no
    /// tiene ningún documento guardado, o <paramref name="versionNumber"/> no existe para ese
    /// documento -- mismo 404 uniforme para los cuatro casos.
    /// </summary>
    Task<(VectorDocument Document, DocumentVersion Version)?> FindVersionAsync(
        Guid projectId, Guid ownerId, int versionNumber, CancellationToken cancellationToken);

    /// <summary>
    /// TODAS las <see cref="DocumentVersion"/> del documento de un proyecto (metadata
    /// solamente -- SIN Layers/PaletteColors, esa es carga completa vía
    /// <see cref="FindVersionAsync"/>), orden <see cref="DocumentVersion.VersionNumber"/>
    /// descendente (la más reciente primero). Null si el proyecto no existe, no pertenece a
    /// <paramref name="ownerId"/>, o todavía no tiene ningún documento guardado -- mismo 404
    /// uniforme que el resto del módulo.
    /// </summary>
    Task<IReadOnlyList<DocumentVersion>?> ListVersionsAsync(
        Guid projectId, Guid ownerId, CancellationToken cancellationToken);

    /// <summary>
    /// Restaura la versión <paramref name="versionNumber"/> (M2.2-S06): crea una
    /// <see cref="DocumentVersion"/> NUEVA (siguiente número secuencial, nunca sobrescribe ni
    /// borra las versiones intermedias) con una copia fresca (ids nuevos, mismos
    /// <see cref="Layer.SvgAssetId"/> reusados tal cual -- no hace falta volver a subir nada a
    /// storage) de los Layers/PaletteColors/dimensiones/viewBox/schemaVersion de la versión
    /// origen, <see cref="DocumentVersionOrigin.Restore"/>,
    /// <c>MetadataJson: {"restoredFromVersion": versionNumber}</c>, y repunta
    /// <see cref="Project.CurrentVersionId"/> a la versión nueva -- misma transacción EF
    /// explícita de dos fases que <see cref="SaveAsync"/>. Null si el proyecto no existe, no
    /// pertenece a <paramref name="ownerId"/>, todavía no tiene ningún documento guardado, o
    /// <paramref name="versionNumber"/> no existe para ese documento. Puede lanzar
    /// <see cref="Microsoft.EntityFrameworkCore.DbUpdateConcurrencyException"/> igual que
    /// <see cref="SaveAsync"/> (mismo mecanismo de concurrencia vía xmin, 409).
    /// </summary>
    Task<VectorDocumentSaveOutcome?> RestoreAsync(
        Guid projectId, Guid ownerId, int versionNumber, CancellationToken cancellationToken);

    /// <summary>
    /// Aplica <paramref name="patch"/> sobre el <see cref="Layer"/> cuyo
    /// <see cref="Layer.GroupId"/> es <paramref name="layerId"/> (M2.2-S06: ya NO busca por
    /// <see cref="Layer.Id"/> -- esa PK cambia en cada checkpoint, ver el conflicto #1 de
    /// spec.md M2.2-S06), SOLO si pertenece a la <see cref="DocumentVersion"/> ACTUAL
    /// (<see cref="Project.CurrentVersionId"/>) del proyecto <paramref name="projectId"/>
    /// perteneciente a <paramref name="ownerId"/> -- null en cualquier otro caso (no existe,
    /// pertenece a otro proyecto/usuario, o pertenece a una versión histórica ya superada),
    /// mismo 404 uniforme que el resto del módulo.
    ///
    /// Fix round 1 (QA post-merge, M2.2-S06): YA NO muta la fila de la versión actual in-place
    /// -- PATCH es, igual que <see cref="SaveAsync"/>/<see cref="RestoreAsync"/>, un checkpoint:
    /// crea una <see cref="DocumentVersion"/> COMPLETA nueva (copia fresca, ids nuevos, de TODOS
    /// los <see cref="Layer"/>/<see cref="PaletteColor"/> de la versión actual, mismo patrón que
    /// <see cref="RestoreAsync"/>) con el patch aplicado SOLO sobre la copia nueva del layer
    /// identificado, <see cref="DocumentVersionOrigin.ManualEdit"/>, y repunta
    /// <see cref="Project.CurrentVersionId"/> a la versión nueva -- la versión anterior queda
    /// intacta como checkpoint histórico (consultar <c>GET .../versions/{n}</c> sobre ella sigue
    /// devolviendo el contenido ORIGINAL, sin el patch). Misma transacción EF explícita de dos
    /// fases y mismo mecanismo de concurrencia (xmin) que <see cref="SaveAsync"/>: puede lanzar
    /// <see cref="Microsoft.EntityFrameworkCore.DbUpdateConcurrencyException"/>
    /// (<see cref="VectorDocumentService"/> la traduce a <see cref="VectorDocumentResult.Conflict"/>, 409).
    /// </summary>
    Task<Layer?> UpdateLayerAsync(
        Guid projectId, Guid ownerId, Guid layerId, LayerPatch patch, CancellationToken cancellationToken);
}
