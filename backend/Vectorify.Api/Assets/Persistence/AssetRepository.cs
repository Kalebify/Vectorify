using Microsoft.EntityFrameworkCore;
using Vectorify.Api.Data;

namespace Vectorify.Api.Assets.Persistence;

/// <summary>
/// Implementación EF Core de <see cref="IAssetRepository"/> (M2.2-S04) contra
/// <see cref="VectorizationDbContext"/>. Único punto del código que emite queries EF
/// directas sobre <c>DbSet&lt;Asset&gt;</c> para este caso de uso.
/// </summary>
public sealed class AssetRepository : IAssetRepository
{
    private readonly VectorizationDbContext _dbContext;

    public AssetRepository(VectorizationDbContext dbContext)
    {
        _dbContext = dbContext;
    }

    public async Task<Asset> CreateAsync(Asset asset, CancellationToken cancellationToken)
    {
        _dbContext.Assets.Add(asset);
        await _dbContext.SaveChangesAsync(cancellationToken);
        return asset;
    }

    public Task<Asset?> FindByIdAsync(Guid projectId, Guid assetId, CancellationToken cancellationToken) =>
        _dbContext.Assets.FirstOrDefaultAsync(a => a.Id == assetId && a.ProjectId == projectId, cancellationToken);

    public Task<int> CountByStorageKeyAsync(string storageKey, CancellationToken cancellationToken) =>
        _dbContext.Assets.IgnoreQueryFilters().CountAsync(a => a.StorageKey == storageKey, cancellationToken);

    public async Task<bool> DeleteRowAsync(Guid projectId, Guid assetId, CancellationToken cancellationToken)
    {
        var asset = await _dbContext.Assets
            .FirstOrDefaultAsync(a => a.Id == assetId && a.ProjectId == projectId, cancellationToken);
        if (asset is null)
        {
            return false;
        }

        _dbContext.Assets.Remove(asset);
        await _dbContext.SaveChangesAsync(cancellationToken);
        return true;
    }
}
