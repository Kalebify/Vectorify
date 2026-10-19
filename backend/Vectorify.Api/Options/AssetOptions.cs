namespace Vectorify.Api.Options;

/// <summary>
/// Reglas de validación para subir Assets nuevos (M2.2-S04,
/// <c>POST /api/v2/projects/{projectId}/assets</c>). Mismo patrón que <see cref="UploadOptions"/>
/// (flujo clásico de M1-S02) pero con su propia sección de configuración ("Asset") y su
/// propia lista de MIME types permitidos -- a diferencia de <see cref="UploadOptions"/>
/// (solo originales raster), acá se incluye <c>image/svg+xml</c> porque un Asset puede ser
/// un original, un preview, un SVG vectorizado o un export (ver spec.md).
/// </summary>
public sealed class AssetOptions
{
    public const string SectionName = "Asset";

    /// <summary>
    /// Tamaño máximo aceptado, en bytes. El spec no cuantifica un límite distinto del de
    /// Upload; se reusa el mismo valor por defecto (15 MB) como punto de partida razonable,
    /// configurable de forma independiente (Asset:MaxFileSizeBytes).
    /// </summary>
    public long MaxFileSizeBytes { get; set; } = 15 * 1024 * 1024;

    /// <summary>Tope de píxeles de una imagen raster subida como Asset (M3.1-S09); ver <see cref="UploadOptions.MaxPixels"/>.</summary>
    public long MaxPixels { get; set; } = Imaging.SafeImageDecoding.DefaultMaxPixels;

    /// <summary>MIME types aceptados, separados por comas.</summary>
    public string AllowedContentTypes { get; set; } = "image/png,image/jpeg,image/webp,image/svg+xml";

    /// <summary>Devuelve los MIME types normalizados (sin espacios, en minúsculas).</summary>
    public string[] GetAllowedContentTypes() => AllowedContentTypes
        .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
        .Select(contentType => contentType.ToLowerInvariant())
        .Distinct()
        .ToArray();
}
