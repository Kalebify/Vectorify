using System.Security.Cryptography;
using Microsoft.EntityFrameworkCore;
using Vectorify.Api.Data;
using Vectorify.Api.Storage;

namespace Vectorify.Api.Maintenance;

/// <summary>Opciones de <see cref="StorageConsistencyChecker.CheckAsync"/>. Por defecto SOLO LECTURA.</summary>
/// <param name="VerifyChecksums">Lee cada archivo y compara su SHA-256 con <c>Asset.Checksum</c> (lento: lee todo el storage).</param>
/// <param name="DeleteOrphanFiles">Borra los archivos sin fila de Asset (nunca borra filas). Respeta <paramref name="OrphanMinAge"/>.</param>
/// <param name="OrphanMinAge">Un archivo huérfano más reciente que esto NO se borra: puede ser un upload en curso (el archivo se guarda ANTES que su fila).</param>
public sealed record ConsistencyCheckOptions(
    bool VerifyChecksums = false, bool DeleteOrphanFiles = false, TimeSpan? OrphanMinAge = null)
{
    public static readonly TimeSpan DefaultOrphanMinAge = TimeSpan.FromMinutes(10);
}

/// <summary>Fila de <c>assets</c> cuyo archivo no existe en el storage.</summary>
public sealed record AssetWithoutFile(Guid AssetId, Guid ProjectId, string Type, string StorageKey, bool ProjectDeleted);

/// <summary>Archivo del storage (bajo el prefijo de assets v2) sin fila de <c>assets</c> que lo referencie.</summary>
public sealed record FileWithoutAsset(string Key, long SizeBytes, DateTimeOffset LastModifiedUtc, bool Deleted);

/// <summary>Asset cuyo archivo existe pero su SHA-256 no coincide con el guardado en la base.</summary>
public sealed record ChecksumMismatch(Guid AssetId, string StorageKey, string ExpectedChecksum, string ActualChecksum);

public sealed record ConsistencyReport(
    int AssetRows,
    int AssetFilesInStorage,
    bool InventorySupported,
    IReadOnlyList<AssetWithoutFile> AssetsWithoutFile,
    IReadOnlyList<FileWithoutAsset> FilesWithoutAsset,
    IReadOnlyList<ChecksumMismatch> ChecksumMismatches,
    bool ChecksumsVerified)
{
    /// <summary>Sin inconsistencias pendientes (los huérfanos borrados en esta corrida ya no cuentan). Un storage sin inventario no puede buscar huérfanos: no los reporta, y el reporte lo avisa.</summary>
    public bool IsConsistent =>
        AssetsWithoutFile.Count == 0 && FilesWithoutAsset.All(f => f.Deleted) && ChecksumMismatches.Count == 0;
}

/// <summary>
/// Verificador de consistencia DB&lt;-&gt;storage (M2.2-S10). Compara las filas de <c>assets</c> (incluidas las de
/// proyectos soft-eliminados: su archivo se conserva a propósito) con lo que hay en el storage bajo el prefijo
/// de assets v2 (<c>projects/</c>, ver <see cref="Vectorify.Api.Assets.AssetKeyFactory"/>):
/// <list type="bullet">
/// <item><b>Fila sin archivo</b>: el asset existe en la base pero su contenido no está (descarga = 404). Típico de
/// restaurar solo la base, o de un archivo borrado a mano.</item>
/// <item><b>Archivo sin fila</b> (huérfano): hay un archivo y nada lo referencia. Típico de un Save que se cortó
/// entre guardar el archivo y escribir la fila, de restaurar solo el storage, o de un <c>.tmp</c> abandonado.</item>
/// <item>(opcional) <b>Checksum distinto</b>: el archivo existe pero sus bytes ya no son los que se subieron.</item>
/// </list>
/// Los archivos del pipeline clásico (originales, SVG y máscaras de sprints previos, claves
/// <c>{projectId}/{imageId}/...</c>) NO tienen fila de Asset por diseño y quedan fuera del chequeo de huérfanos.
/// Solo lectura salvo <see cref="ConsistencyCheckOptions.DeleteOrphanFiles"/>, que borra únicamente archivos huérfanos
/// (nunca filas) y respeta una edad mínima.
/// </summary>
public sealed class StorageConsistencyChecker
{
    /// <summary>Prefijo de las claves de los Assets v2 (<c>projects/{projectId}/{type}/{assetId}.ext</c>).</summary>
    public const string AssetKeyPrefix = "projects";

    private readonly VectorizationDbContext _dbContext;
    private readonly IFileStorage _storage;

    public StorageConsistencyChecker(VectorizationDbContext dbContext, IFileStorage storage)
    {
        _dbContext = dbContext;
        _storage = storage;
    }

    public async Task<(ConsistencyReport Report, IReadOnlyList<string> DeletedOrphans)> CheckAsync(
        ConsistencyCheckOptions options, CancellationToken cancellationToken)
    {
        var assets = await (
            from asset in _dbContext.Assets.AsNoTracking()
            join project in _dbContext.Projects.IgnoreQueryFilters().AsNoTracking() on asset.ProjectId equals project.Id
            select new
            {
                asset.Id, asset.ProjectId, asset.Type, asset.StorageKey, asset.Checksum,
                ProjectDeleted = project.DeletedAt != null,
            }).ToListAsync(cancellationToken);

        var assetsWithoutFile = new List<AssetWithoutFile>();
        var checksumMismatches = new List<ChecksumMismatch>();
        foreach (var asset in assets)
        {
            if (!await _storage.ExistsAsync(asset.StorageKey, cancellationToken))
            {
                assetsWithoutFile.Add(new AssetWithoutFile(asset.Id, asset.ProjectId, asset.Type, asset.StorageKey, asset.ProjectDeleted));
                continue;
            }

            if (options.VerifyChecksums)
            {
                var actual = await ComputeChecksumAsync(asset.StorageKey, cancellationToken);
                if (!string.Equals(actual, asset.Checksum, StringComparison.OrdinalIgnoreCase))
                {
                    checksumMismatches.Add(new ChecksumMismatch(asset.Id, asset.StorageKey, asset.Checksum, actual));
                }
            }
        }

        var filesWithoutAsset = new List<FileWithoutAsset>();
        var deletedOrphans = new List<string>();
        var filesInStorage = 0;
        var inventorySupported = _storage is IFileStorageInventory;
        if (_storage is IFileStorageInventory inventory)
        {
            var knownKeys = assets.Select(a => a.StorageKey).ToHashSet(StringComparer.Ordinal);
            var minAge = options.OrphanMinAge ?? ConsistencyCheckOptions.DefaultOrphanMinAge;

            await foreach (var file in inventory.ListAsync(AssetKeyPrefix, cancellationToken))
            {
                filesInStorage++;
                if (knownKeys.Contains(file.Key))
                {
                    continue;
                }

                var deleted = false;
                if (options.DeleteOrphanFiles && DateTimeOffset.UtcNow - file.LastModifiedUtc >= minAge)
                {
                    await _storage.DeleteAsync(file.Key, cancellationToken);
                    deletedOrphans.Add(file.Key);
                    deleted = true;
                }

                filesWithoutAsset.Add(new FileWithoutAsset(file.Key, file.SizeBytes, file.LastModifiedUtc, deleted));
            }
        }

        var report = new ConsistencyReport(
            assets.Count, filesInStorage, inventorySupported,
            assetsWithoutFile, filesWithoutAsset, checksumMismatches, options.VerifyChecksums);
        return (report, deletedOrphans);
    }

    private async Task<string> ComputeChecksumAsync(string key, CancellationToken cancellationToken)
    {
        await using var stream = await _storage.OpenReadAsync(key, cancellationToken);
        var hash = await SHA256.HashDataAsync(stream, cancellationToken);
        return Convert.ToHexStringLower(hash);
    }
}
