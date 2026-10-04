using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Formats.Jpeg;
using SixLabors.ImageSharp.Formats.Png;
using SixLabors.ImageSharp.Processing;

namespace Vectorify.Api.Imaging;

/// <summary>Thumbnail ya codificado, listo para subirse como Asset (M2.2-S08).</summary>
public sealed record ThumbnailImage(byte[] Content, string ContentType);

/// <summary>
/// Reduce la imagen original subida a un thumbnail de a lo sumo <see cref="MaxSidePx"/> px de
/// lado mayor (M2.2-S08). Best-effort a propósito, mismo criterio que
/// <see cref="ImageDimensionsReader"/>: cualquier fallo de decodificación/codificación devuelve
/// null (nunca lanza) para que el llamador nunca haga fallar un Save por un thumbnail. No agranda
/// imágenes chicas. JPEG de origen -> JPEG; cualquier otro formato (PNG/WEBP, que pueden tener
/// transparencia) -> PNG.
/// </summary>
public static class ThumbnailGenerator
{
    /// <summary>Lado mayor máximo del thumbnail, en píxeles.</summary>
    public const int MaxSidePx = 320;

    public static ThumbnailImage? TryCreate(Stream source)
    {
        try
        {
            using var image = Image.Load(source, out var format);

            if (Math.Max(image.Width, image.Height) > MaxSidePx)
            {
                image.Mutate(context => context.Resize(new ResizeOptions
                {
                    Size = new Size(MaxSidePx, MaxSidePx),
                    Mode = ResizeMode.Max,
                }));
            }

            using var output = new MemoryStream();
            string contentType;
            if (string.Equals(format.Name, "JPEG", StringComparison.OrdinalIgnoreCase))
            {
                image.Save(output, new JpegEncoder { Quality = 80 });
                contentType = "image/jpeg";
            }
            else
            {
                image.Save(output, new PngEncoder());
                contentType = "image/png";
            }

            return new ThumbnailImage(output.ToArray(), contentType);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            return null;
        }
    }
}
