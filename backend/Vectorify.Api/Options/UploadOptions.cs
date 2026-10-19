namespace Vectorify.Api.Options;

/// <summary>
/// Reglas de validación para la carga de imágenes originales. Se enlaza desde la
/// sección "Upload" de appsettings/variables de entorno (por ejemplo,
/// Upload__MaxFileSizeBytes, Upload__AllowedContentTypes).
/// </summary>
public sealed class UploadOptions
{
    public const string SectionName = "Upload";

    /// <summary>
    /// Tamaño máximo aceptado, en bytes. El spec de la tarjeta no cuantifica un
    /// límite; 15 MB es un valor razonable para imágenes originales PNG/JPG/WEBP
    /// (ver "Ambigüedades detectadas" en spec.md).
    /// </summary>
    public long MaxFileSizeBytes { get; set; } = 15 * 1024 * 1024;

    /// <summary>
    /// Tope de píxeles de la imagen (ancho × alto) leído de su cabecera ANTES de decodificarla (M3.1-S09): protege contra bombas de descompresión (un archivo pequeño que declara
    /// decenas de miles de píxeles por lado). 64 megapíxeles por defecto (8000 × 8000).
    /// </summary>
    public long MaxPixels { get; set; } = Imaging.SafeImageDecoding.DefaultMaxPixels;

    /// <summary>MIME types aceptados, separados por comas.</summary>
    public string AllowedContentTypes { get; set; } = "image/png,image/jpeg,image/webp";

    /// <summary>Devuelve los MIME types normalizados (sin espacios, en minúsculas).</summary>
    public string[] GetAllowedContentTypes() => AllowedContentTypes
        .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
        .Select(contentType => contentType.ToLowerInvariant())
        .Distinct()
        .ToArray();
}
