using Microsoft.Extensions.Options;
using SixLabors.ImageSharp;
using Vectorify.Api.Imaging;
using Vectorify.Api.Options;

namespace Vectorify.Api.Validation;

/// <summary>
/// Implementación de <see cref="IImageUploadValidator"/>: valida, en orden,
/// archivo vacío/ausente, tamaño máximo, MIME type + extensión permitidos,
/// la firma binaria del contenido (descarta basura obvia barato y rápido) y
/// finalmente una decodificación real vía ImageSharp (detecta archivos
/// truncados/corruptos que solo tienen una cabecera válida pero no son una
/// imagen decodificable completa).
/// </summary>
public sealed class ImageUploadValidator : IImageUploadValidator
{
    private static readonly IReadOnlyDictionary<string, string[]> ExtensionsByContentType =
        new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase)
        {
            ["image/png"] = [".png"],
            ["image/jpeg"] = [".jpg", ".jpeg"],
            ["image/webp"] = [".webp"],
        };

    private readonly UploadOptions _options;

    public ImageUploadValidator(IOptions<UploadOptions> options)
    {
        _options = options.Value;
    }

    public ImageValidationResult Validate(IFormFile? file)
    {
        if (file is null || file.Length == 0)
        {
            return ImageValidationResult.Failure(
                "empty_file",
                "No se recibió ningún archivo, o el archivo está vacío.");
        }

        if (file.Length > _options.MaxFileSizeBytes)
        {
            var maxMb = _options.MaxFileSizeBytes / (1024.0 * 1024.0);
            return ImageValidationResult.Failure(
                "file_too_large",
                $"El archivo supera el tamaño máximo permitido ({maxMb:0.#} MB).");
        }

        var contentType = file.ContentType.Trim().ToLowerInvariant();
        var extension = Path.GetExtension(file.FileName).ToLowerInvariant();
        var allowedContentTypes = _options.GetAllowedContentTypes();

        var isKnownContentType = allowedContentTypes.Contains(contentType)
            && ExtensionsByContentType.TryGetValue(contentType, out var validExtensions)
            && validExtensions.Contains(extension);

        if (!isKnownContentType)
        {
            return ImageValidationResult.Failure(
                "unsupported_format",
                "Formato no soportado. Solo se aceptan imágenes PNG, JPG/JPEG o WEBP.");
        }

        using var stream = file.OpenReadStream();
        if (!ImageSignature.Matches(stream, contentType))
        {
            return ImageValidationResult.Failure(
                "corrupt_file",
                "El archivo parece estar corrupto: su contenido no coincide con el formato declarado.");
        }

        // M3.1-S09: tope de píxeles leído de la cabecera (sin reservar memoria de píxeles) y solo los decodificadores PNG/JPEG/WEBP (ver SafeImageDecoding).
        if (SafeImageDecoding.CheckPixelLimit(stream, _options.MaxPixels) == PixelCheckResult.TooLarge)
        {
            return ImageValidationResult.Failure(
                "file_too_large",
                $"La imagen supera el tamaño máximo permitido en píxeles ({_options.MaxPixels / 1_000_000.0:0.#} megapíxeles).");
        }

        if (!TryDecode(stream))
        {
            return ImageValidationResult.Failure(
                "corrupt_file",
                "El archivo parece estar corrupto: su contenido no coincide con el formato declarado.");
        }

        return ImageValidationResult.Success(contentType, extension);
    }

    /// <summary>
    /// Intenta decodificar la imagen completa con ImageSharp para detectar archivos
    /// truncados/corruptos que solo tienen una firma inicial válida (el chequeo de
    /// ImageSignature es barato pero no alcanza para eso). Deja el stream
    /// reposicionado en 0 si es seekable, igual que ImageSignature.Matches.
    /// </summary>
    private static bool TryDecode(Stream stream)
    {
        try
        {
            using var image = Image.Load(SafeImageDecoding.Options, stream);
            return true;
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            return false;
        }
        finally
        {
            if (stream.CanSeek)
            {
                stream.Position = 0;
            }
        }
    }
}
