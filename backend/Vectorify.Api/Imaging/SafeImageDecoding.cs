using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Formats.Jpeg;
using SixLabors.ImageSharp.Formats.Png;
using SixLabors.ImageSharp.Formats.Webp;

namespace Vectorify.Api.Imaging;

/// <summary>Resultado de comprobar el tamaño en píxeles declarado en la cabecera de una imagen.</summary>
public enum PixelCheckResult
{
    /// <summary>La cabecera se leyó y declara como mucho el tope de píxeles.</summary>
    WithinLimit,

    /// <summary>La cabecera se leyó y declara MÁS píxeles que el tope.</summary>
    TooLarge,

    /// <summary>No se pudo leer la cabecera (formato no permitido, truncada, corrupta): lo decide la decodificación, que la rechazará como corrupta.</summary>
    Unreadable,
}

/// <summary>
/// Decodificación ACOTADA de imágenes subidas por usuarios (M3.1-S09; mitigación de los avisos de SixLabors.ImageSharp 2.1.13, ver docs/AUTH_SECURITY_REVIEW.md, hallazgo H-1):
/// <list type="bullet">
/// <item><b>Solo los tres formatos que el producto acepta</b> (PNG, JPEG, WEBP): se usa una <see cref="Configuration"/> propia con únicamente esos decodificadores, en vez de la global
/// (que además registra TIFF, GIF, BMP, TGA y PBM). Los cinco avisos de ImageSharp 2.1.13 están en TIFF (decodificador BigTIFF, codificadores CCITT T4/T6), en ecualización de histograma y en el
/// análisis de perfiles ICC; con esta configuración ningún contenido subido puede ENTRAR al código de TIFF, ni por un archivo políglota.</item>
/// <item><b>Tope de píxeles leído de la CABECERA</b> (<see cref="Image.Identify(Configuration, Stream)"/>, que no reserva memoria de píxeles) antes de decodificar: un PNG/JPEG de pocos MB puede
/// declarar 60 000 × 60 000 píxeles y agotar la memoria al decodificarlo (bomba de descompresión); el límite de 15 MB de archivo no lo evita.</item>
/// </list>
/// Es una mitigación, no una corrección: el código vulnerable sigue en el ensamblado hasta que se decida actualizar (cambio de MAYOR versión y de licencia).
/// </summary>
public static class SafeImageDecoding
{
    /// <summary>Tope por defecto: 64 megapíxeles (8000 × 8000), unos 256 MB de píxeles RGBA decodificados. Configurable con <c>Upload:MaxPixels</c> / <c>Asset:MaxPixels</c>.</summary>
    public const long DefaultMaxPixels = 64_000_000;

    private static readonly Configuration RestrictedConfiguration =
        new(new PngConfigurationModule(), new JpegConfigurationModule(), new WebpConfigurationModule());

    /// <summary>Configuración de ImageSharp con SOLO los decodificadores/codificadores PNG, JPEG y WEBP (se pasa a <c>Image.Load(Configuration, ...)</c>).</summary>
    public static Configuration Options => RestrictedConfiguration;

    /// <summary>
    /// Lee la cabecera y compara el tamaño declarado con <paramref name="maxPixels"/>. Deja el stream reposicionado donde estaba (si es seekable).
    /// </summary>
    public static PixelCheckResult CheckPixelLimit(Stream stream, long maxPixels)
    {
        var start = stream.CanSeek ? stream.Position : 0;
        try
        {
            var info = Image.Identify(Options, stream);
            if (info is null)
            {
                return PixelCheckResult.Unreadable;
            }

            var pixels = (long)info.Width * info.Height;
            return pixels > maxPixels ? PixelCheckResult.TooLarge : PixelCheckResult.WithinLimit;
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            return PixelCheckResult.Unreadable;
        }
        finally
        {
            if (stream.CanSeek)
            {
                stream.Position = start;
            }
        }
    }
}
