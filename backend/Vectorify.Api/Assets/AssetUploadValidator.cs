using System.Xml;
using System.Xml.Linq;
using Microsoft.Extensions.Options;
using SixLabors.ImageSharp;
using Vectorify.Api.Options;
using Vectorify.Api.Validation;

namespace Vectorify.Api.Assets;

/// <summary>
/// Implementación de <see cref="IAssetUploadValidator"/>: valida archivo vacío/ausente,
/// tamaño máximo (<see cref="AssetOptions.MaxFileSizeBytes"/>), MIME type contra la lista
/// permitida (<see cref="AssetOptions.GetAllowedContentTypes"/>, exigiendo además que el MIME
/// type tenga una extensión mapeada en <see cref="AssetKeyFactory"/>), que la extensión del
/// <c>FileName</c> declarado sea compatible con ese MIME type, y finalmente el contenido real:
///
/// <list type="bullet">
/// <item>Raster (<c>image/png</c>/<c>image/jpeg</c>/<c>image/webp</c>): mismo criterio que
/// <see cref="Vectorify.Api.Validation.ImageUploadValidator"/> del flujo clásico -- firma
/// binaria (<see cref="Vectorify.Api.Validation.ImageSignature"/>) y decodificación real con
/// ImageSharp. Un archivo que no decodifica de punta a punta (truncado, corrupto, o que
/// directamente no es una imagen) se rechaza acá, nunca llega a <c>IFileStorage.SaveAsync</c>.</item>
/// <item>SVG (<c>image/svg+xml</c>): no es una imagen raster decodificable, es texto/XML --
/// se valida que sea XML bien formado con un elemento raíz <c>&lt;svg&gt;</c>, con un
/// <see cref="XmlReader"/> configurado para NO resolver DTDs ni entidades externas
/// (<see cref="XmlReaderSettings.DtdProcessing"/> = Prohibit, <see cref="XmlReaderSettings.XmlResolver"/>
/// = null), patrón estándar de .NET para parsear XML no confiable sin abrir una vía de XXE.</item>
/// </list>
///
/// Defecto de QA sobre M2.2-S04 (bloqueo post-merge): el validador original confiaba
/// únicamente en el Content-Type/extensión DECLARADOS por el cliente y nunca miraba el
/// contenido real -- bytes arbitrarios ([1,2,3,4]) declarados <c>image/png</c> pasaban sin
/// problema y recibían 201. Este archivo corrige exactamente eso.
/// </summary>
public sealed class AssetUploadValidator : IAssetUploadValidator
{
    /// <summary>
    /// Extensiones de nombre de archivo compatibles por MIME type declarado. A diferencia de
    /// <see cref="AssetKeyFactory"/> (que mapea un único MIME type a UNA extensión para
    /// derivar la clave de storage), acá se aceptan variantes equivalentes del lado del
    /// nombre de usuario (p. ej. tanto ".jpg" como ".jpeg" para <c>image/jpeg</c>) -- mismo
    /// criterio que <see cref="Vectorify.Api.Validation.ImageUploadValidator"/>.
    /// </summary>
    private static readonly IReadOnlyDictionary<string, string[]> CompatibleExtensionsByContentType =
        new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase)
        {
            ["image/png"] = [".png"],
            ["image/jpeg"] = [".jpg", ".jpeg"],
            ["image/webp"] = [".webp"],
            ["image/svg+xml"] = [".svg"],
        };

    private readonly AssetOptions _options;

    public AssetUploadValidator(IOptions<AssetOptions> options)
    {
        _options = options.Value;
    }

    public AssetValidationResult Validate(IFormFile? file)
    {
        if (file is null || file.Length == 0)
        {
            return AssetValidationResult.Failure(
                "empty_file",
                "No se recibió ningún archivo, o el archivo está vacío.");
        }

        if (file.Length > _options.MaxFileSizeBytes)
        {
            var maxMb = _options.MaxFileSizeBytes / (1024.0 * 1024.0);
            return AssetValidationResult.Failure(
                "file_too_large",
                $"El archivo supera el tamaño máximo permitido ({maxMb:0.#} MB).");
        }

        var contentType = (file.ContentType ?? string.Empty).Trim().ToLowerInvariant();
        var allowedContentTypes = _options.GetAllowedContentTypes();

        if (!allowedContentTypes.Contains(contentType) || !AssetKeyFactory.TryGetExtension(contentType, out _))
        {
            return AssetValidationResult.Failure(
                "unsupported_format",
                "Formato no soportado. Solo se aceptan imágenes PNG, JPG/JPEG, WEBP o SVG.");
        }

        var declaredExtension = Path.GetExtension(file.FileName ?? string.Empty).ToLowerInvariant();
        if (!CompatibleExtensionsByContentType.TryGetValue(contentType, out var compatibleExtensions)
            || !compatibleExtensions.Contains(declaredExtension))
        {
            return AssetValidationResult.Failure(
                "extension_mismatch",
                "La extensión del nombre de archivo no coincide con el tipo de contenido declarado.");
        }

        if (contentType == "image/svg+xml")
        {
            using var svgStream = file.OpenReadStream();
            if (!IsWellFormedSvg(svgStream))
            {
                return AssetValidationResult.Failure(
                    "invalid_svg",
                    "El archivo no es un SVG válido: debe ser XML bien formado con un elemento raíz <svg>.");
            }

            return AssetValidationResult.Success(contentType);
        }

        using var rasterStream = file.OpenReadStream();
        if (!ImageSignature.Matches(rasterStream, contentType) || !TryDecodeRasterImage(rasterStream))
        {
            return AssetValidationResult.Failure(
                "corrupt_image",
                "El archivo parece estar corrupto: su contenido no coincide con el formato declarado.");
        }

        return AssetValidationResult.Success(contentType);
    }

    /// <summary>
    /// Intenta decodificar la imagen completa con ImageSharp -- mismo criterio que
    /// <see cref="Vectorify.Api.Validation.ImageUploadValidator"/>: detecta archivos
    /// truncados/corruptos que solo tienen una firma inicial válida pero no son una imagen
    /// decodificable completa (la firma por sí sola es barata pero no alcanza).
    /// </summary>
    private static bool TryDecodeRasterImage(Stream stream)
    {
        try
        {
            using var image = Image.Load(stream);
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

    /// <summary>
    /// Un SVG es texto/XML, no algo que ImageSharp pueda decodificar -- se valida en cambio
    /// que sea XML bien formado con un elemento raíz <c>&lt;svg&gt;</c>. El <see cref="XmlReader"/>
    /// se configura explícitamente para NO resolver DTDs ni entidades externas, para que un
    /// SVG malicioso no pueda usarse como vector de ataque XXE (lectura de archivos locales o
    /// SSRF vía entidades externas).
    /// </summary>
    private static bool IsWellFormedSvg(Stream stream)
    {
        try
        {
            var settings = new XmlReaderSettings
            {
                DtdProcessing = DtdProcessing.Prohibit,
                XmlResolver = null,
            };
            using var reader = XmlReader.Create(stream, settings);
            var document = XDocument.Load(reader, LoadOptions.None);
            return string.Equals(document.Root?.Name.LocalName, "svg", StringComparison.Ordinal);
        }
        catch (XmlException)
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
