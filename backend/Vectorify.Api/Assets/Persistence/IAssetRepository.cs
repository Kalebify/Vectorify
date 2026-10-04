using Vectorify.Api.Data;

namespace Vectorify.Api.Assets.Persistence;

/// <summary>
/// Acceso a datos de <see cref="Asset"/> (M2.2-S04) contra PostgreSQL vía EF Core. Mismo
/// patrón arquitectónico que <see cref="Vectorify.Api.Projects.Persistence.IProjectRepository"/>
/// (M2.2-S03): vive en un sub-namespace <c>.Persistence</c> propio, y NO resuelve ownership
/// por sí mismo -- <see cref="AssetService"/> ya validó que el <see cref="Project"/> dueño
/// pertenece al usuario efectivo (vía <c>IProjectRepository.FindByIdAsync</c>) ANTES de
/// llamar a cualquier método de acá, así que alcanza con filtrar por <c>projectId</c> (no
/// hace falta repetir el filtro por <c>ownerId</c> acá también).
/// </summary>
public interface IAssetRepository
{
    Task<Asset> CreateAsync(Asset asset, CancellationToken cancellationToken);

    /// <summary>Null si no existe un Asset con ese Id perteneciente a <paramref name="projectId"/>.</summary>
    Task<Asset?> FindByIdAsync(Guid projectId, Guid assetId, CancellationToken cancellationToken);

    /// <summary>
    /// Borra SOLO la fila -- el llamador (<see cref="AssetService"/>) es responsable de
    /// borrar el contenido real en storage (vía <see cref="Vectorify.Api.Storage.IFileStorage.DeleteAsync"/>)
    /// antes de llamar a esto. False si no existe un Asset con ese Id perteneciente a
    /// <paramref name="projectId"/>.
    /// </summary>
    Task<bool> DeleteRowAsync(Guid projectId, Guid assetId, CancellationToken cancellationToken);

    /// <summary>
    /// Cantidad de filas de Asset (de CUALQUIER proyecto) que apuntan a <paramref name="storageKey"/>.
    /// Duplicar un proyecto (M2.2-S08) crea filas nuevas que comparten la misma clave de storage
    /// que las del original, así que borrar el archivo solo es seguro cuando queda una única fila.
    /// </summary>
    Task<int> CountByStorageKeyAsync(string storageKey, CancellationToken cancellationToken);
}
