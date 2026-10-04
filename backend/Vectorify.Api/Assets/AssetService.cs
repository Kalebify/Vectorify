using System.Text.RegularExpressions;
using Vectorify.Api.Assets.Persistence;
using Vectorify.Api.Data;
using Vectorify.Api.Imaging;
using Vectorify.Api.Projects.Persistence;
using Vectorify.Api.Storage;
using Vectorify.Api.Users;

namespace Vectorify.Api.Assets;

/// <summary>Implementación de <see cref="IAssetService"/> (M2.2-S04). Ver la interfaz para el rol en la arquitectura.</summary>
public sealed partial class AssetService : IAssetService
{
    /// <summary>
    /// <see cref="Asset.Type"/> normalizado a minúsculas, charset acotado a
    /// letras/dígitos/guion/guion bajo (participa de la clave de storage vía
    /// <see cref="AssetKeyFactory"/> -- un charset permisivo podría introducir segmentos de
    /// clave inesperados, p. ej. un "/" adicional).
    /// </summary>
    [GeneratedRegex("^[a-z0-9_-]{1,40}$")]
    private static partial Regex TypePattern();

    private readonly IAssetRepository _repository;
    private readonly IProjectRepository _projectRepository;
    private readonly IFileStorage _fileStorage;
    private readonly IAssetUploadValidator _validator;
    private readonly IUserContext _userContext;
    private readonly ILogger<AssetService> _logger;

    public AssetService(
        IAssetRepository repository,
        IProjectRepository projectRepository,
        IFileStorage fileStorage,
        IAssetUploadValidator validator,
        IUserContext userContext,
        ILogger<AssetService> logger)
    {
        _repository = repository;
        _projectRepository = projectRepository;
        _fileStorage = fileStorage;
        _validator = validator;
        _userContext = userContext;
        _logger = logger;
    }

    public async Task<AssetResult> UploadAsync(Guid projectId, string? type, IFormFile? file, CancellationToken cancellationToken)
    {
        var ownerId = _userContext.GetEffectiveUserId();
        var project = await _projectRepository.FindByIdAsync(projectId, ownerId, cancellationToken);
        if (project is null)
        {
            return NotFoundResult();
        }

        var normalizedType = (type ?? string.Empty).Trim().ToLowerInvariant();
        if (!TypePattern().IsMatch(normalizedType))
        {
            return new AssetResult.ValidationFailed(
                "invalid_type",
                "El campo 'type' es requerido y solo puede contener letras minúsculas, dígitos, '-' y '_' (máximo 40 caracteres).");
        }

        var validation = _validator.Validate(file);
        if (!validation.IsValid)
        {
            return new AssetResult.ValidationFailed(validation.ErrorCode!, validation.ErrorMessage!);
        }

        if (!AssetKeyFactory.TryGetExtension(validation.ContentType!, out var extension))
        {
            // No debería ocurrir: el validador ya exige que el content type tenga una
            // extensión mapeada. Defensivo, no un caso de negocio real.
            return new AssetResult.ValidationFailed("unsupported_format", "Formato no soportado.");
        }

        var assetId = Guid.NewGuid();
        var storageKey = AssetKeyFactory.BuildKey(projectId, normalizedType, assetId, extension);

        int? width = null;
        int? height = null;
        await using (var probeStream = file!.OpenReadStream())
        {
            if (ImageDimensionsReader.TryRead(probeStream, validation.ContentType!, out var probedWidth, out var probedHeight))
            {
                width = probedWidth;
                height = probedHeight;
            }
        }

        StoredFile stored;
        try
        {
            await using var content = file.OpenReadStream();

            // Política de consistencia DB<->Storage (ver spec.md, "Ambigüedades detectadas"):
            // guarda PRIMERO en storage. Si esto falla, nunca se llega a insertar la fila --
            // nada que limpiar. Si el storage tiene éxito pero el SaveChangesAsync de abajo
            // falla, queda un archivo huérfano en storage sin fila en DB -- aceptado como
            // trade-off documentado (no corrompe datos ni rompe queries, nada referencia esa
            // clave). Limpieza de huérfanos: fuera de alcance de esta tarjeta.
            stored = await _fileStorage.SaveAsync(storageKey, content, validation.ContentType!, cancellationToken);
        }
        catch (FileStorageException ex)
        {
            _logger.LogError(ex, "Fallo de storage al subir el Asset {AssetId} del proyecto {ProjectId}", assetId, projectId);
            return new AssetResult.StorageFailed(
                "storage_failure", "No se pudo guardar el archivo. Intentá de nuevo en unos minutos.");
        }

        var asset = new Asset
        {
            Id = assetId,
            ProjectId = projectId,
            Type = normalizedType,
            StorageKey = stored.Key,
            MimeType = validation.ContentType!,
            // FileName es SOLO metadata informativa (ver spec.md, "Seguridad") -- nunca
            // participó de storageKey, que se derivó arriba de assetId/type/extensión.
            FileName = Path.GetFileName(file.FileName),
            Size = stored.SizeBytes,
            Width = width,
            Height = height,
            Checksum = stored.Checksum,
            CreatedAt = DateTimeOffset.UtcNow,
        };

        var created = await _repository.CreateAsync(asset, cancellationToken);

        _logger.LogInformation(
            "Asset {AssetId} ({Type}) subido para el proyecto {ProjectId} ({Bytes} bytes, {MimeType})",
            assetId, normalizedType, projectId, stored.SizeBytes, validation.ContentType);

        return new AssetResult.Ready(created);
    }

    public async Task<AssetResult> CreateFromBytesAsync(
        Guid projectId, string type, string fileName, string contentType, byte[] content, CancellationToken cancellationToken)
    {
        var normalizedType = (type ?? string.Empty).Trim().ToLowerInvariant();
        if (!TypePattern().IsMatch(normalizedType))
        {
            return new AssetResult.ValidationFailed(
                "invalid_type",
                "El campo 'type' es requerido y solo puede contener letras minúsculas, dígitos, '-' y '_' (máximo 40 caracteres).");
        }

        if (content is null || content.Length == 0)
        {
            return new AssetResult.ValidationFailed("empty_file", "No se recibió contenido para el archivo.");
        }

        if (!AssetKeyFactory.TryGetExtension(contentType, out var extension))
        {
            return new AssetResult.ValidationFailed("unsupported_format", "Formato no soportado.");
        }

        var assetId = Guid.NewGuid();
        var storageKey = AssetKeyFactory.BuildKey(projectId, normalizedType, assetId, extension);

        StoredFile stored;
        try
        {
            // Misma política storage-primero-fila-después que UploadAsync (ver esa clase): si
            // esto falla, nunca se llega a insertar la fila.
            await using var contentStream = new MemoryStream(content, writable: false);
            stored = await _fileStorage.SaveAsync(storageKey, contentStream, contentType, cancellationToken);
        }
        catch (FileStorageException ex)
        {
            _logger.LogError(
                ex, "Fallo de storage al subir el Asset {AssetId} ({Type}) del proyecto {ProjectId} desde bytes server-side",
                assetId, normalizedType, projectId);
            return new AssetResult.StorageFailed(
                "storage_failure", "No se pudo guardar el archivo. Intentá de nuevo en unos minutos.");
        }

        var asset = new Asset
        {
            Id = assetId,
            ProjectId = projectId,
            Type = normalizedType,
            StorageKey = stored.Key,
            MimeType = contentType,
            FileName = Path.GetFileName(fileName),
            Size = stored.SizeBytes,
            Checksum = stored.Checksum,
            CreatedAt = DateTimeOffset.UtcNow,
        };

        var created = await _repository.CreateAsync(asset, cancellationToken);

        _logger.LogInformation(
            "Asset {AssetId} ({Type}) subido para el proyecto {ProjectId} desde bytes server-side ({Bytes} bytes, {MimeType})",
            assetId, normalizedType, projectId, stored.SizeBytes, contentType);

        return new AssetResult.Ready(created);
    }

    public async Task<AssetResult> DownloadAsync(Guid projectId, Guid assetId, CancellationToken cancellationToken)
    {
        var ownerId = _userContext.GetEffectiveUserId();
        var project = await _projectRepository.FindByIdAsync(projectId, ownerId, cancellationToken);
        if (project is null)
        {
            return NotFoundResult();
        }

        var asset = await _repository.FindByIdAsync(projectId, assetId, cancellationToken);
        if (asset is null)
        {
            return NotFoundResult();
        }

        try
        {
            var stream = await _fileStorage.OpenReadAsync(asset.StorageKey, cancellationToken);
            return new AssetResult.Downloaded(stream, asset.MimeType, asset.FileName);
        }
        catch (FileNotFoundException)
        {
            _logger.LogWarning(
                "El Asset {AssetId} existe en la base pero su contenido ya no está disponible en storage (clave {StorageKey})",
                assetId, asset.StorageKey);
            return NotFoundResult();
        }
    }

    public async Task<AssetResult> DeleteAsync(Guid projectId, Guid assetId, CancellationToken cancellationToken)
    {
        var ownerId = _userContext.GetEffectiveUserId();
        var project = await _projectRepository.FindByIdAsync(projectId, ownerId, cancellationToken);
        if (project is null)
        {
            return NotFoundResult();
        }

        var asset = await _repository.FindByIdAsync(projectId, assetId, cancellationToken);
        if (asset is null)
        {
            return NotFoundResult();
        }

        // Hard delete intencional (distinto del soft-delete de Project, que NUNCA toca
        // Assets -- ver M2.2-S03): borra el archivo real primero; solo si eso tiene éxito se
        // borra la fila, para no perder la única referencia a una clave que todavía podría
        // tener contenido en storage.
        //
        // Excepción (M2.2-S08): un proyecto duplicado tiene filas de Asset propias que comparten
        // la StorageKey del original -- si otra fila (de cualquier proyecto, incluso uno
        // soft-deleteado) todavía referencia el mismo archivo, solo se borra esta fila.
        var sharedWithOtherRows = await _repository.CountByStorageKeyAsync(asset.StorageKey, cancellationToken) > 1;
        if (!sharedWithOtherRows)
        {
            try
            {
                await _fileStorage.DeleteAsync(asset.StorageKey, cancellationToken);
            }
            catch (FileStorageException ex)
            {
                _logger.LogError(ex, "Fallo de storage al borrar el Asset {AssetId} del proyecto {ProjectId}", assetId, projectId);
                return new AssetResult.StorageFailed(
                    "storage_failure", "No se pudo borrar el archivo. Intentá de nuevo en unos minutos.");
            }
        }

        await _repository.DeleteRowAsync(projectId, assetId, cancellationToken);

        return new AssetResult.Deleted();
    }

    private static AssetResult.NotFound NotFoundResult() =>
        new("not_found", "No existe un asset con ese Id para este proyecto.");
}
