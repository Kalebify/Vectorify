using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;
using Vectorify.Api.Storage;

namespace Vectorify.Api.Imaging;

/// <summary>
/// Composición de máscaras/preview de paleta de colores (M2-S01) puramente
/// del lado de Vectorify.Api, SIN volver a llamar a Python: un merge/unmerge
/// de grupos ya detectados es una operación geométrica simple (OR de
/// máscaras binarias, "pintar" un color donde una máscara está activa) que
/// no justifica un round-trip a FastAPI -- mismo criterio de "sin llamada
/// costosa" que Vectorify.Api.Dimensioning.SvgDimensionWriter (M1-S09).
/// Implementación deliberadamente simple (indexado píxel a píxel, no Span/
/// SIMD): las paletas de esta herramienta son diseños gráficos acotados
/// (mismo límite de dimensiones que el resto del pipeline), no video en
/// tiempo real -- prioriza corrección/legibilidad sobre throughput extremo.
/// </summary>
public static class MaskCompositor
{
    /// <summary>
    /// Combina (OR binario) dos o más máscaras ya persistidas en un único PNG
    /// de máscara nueva -- usado al fusionar (merge) grupos.
    /// </summary>
    public static async Task<byte[]> CombineMasksAsync(
        IFileStorage storage, IReadOnlyList<string> maskStorageKeys, int width, int height, CancellationToken cancellationToken)
    {
        using var combined = new Image<L8>(width, height);

        foreach (var key in maskStorageKeys)
        {
            using var mask = await LoadMaskAsync(storage, key, width, height, cancellationToken);
            for (var y = 0; y < height; y++)
            {
                for (var x = 0; x < width; x++)
                {
                    if (mask[x, y].PackedValue >= 128)
                    {
                        combined[x, y] = new L8(255);
                    }
                }
            }
        }

        return await EncodePngAsync(combined, cancellationToken);
    }

    /// <summary>
    /// Construye el preview cuantizado (RGBA): cada píxel pintado con el
    /// color de su grupo donde la máscara correspondiente está activa,
    /// transparente en el resto -- se reconstruye desde cero en cada
    /// detección/merge/unmerge a partir de los grupos VIGENTES de esa
    /// versión, nunca acumula estado de versiones anteriores.
    /// </summary>
    public static async Task<byte[]> BuildQuantizedPreviewAsync(
        IFileStorage storage,
        IReadOnlyList<(string MaskStorageKey, string ColorHex)> groups,
        int width,
        int height,
        CancellationToken cancellationToken)
    {
        using var canvas = new Image<Rgba32>(width, height);

        foreach (var (maskStorageKey, colorHex) in groups)
        {
            var color = ParseHexColor(colorHex);
            using var mask = await LoadMaskAsync(storage, maskStorageKey, width, height, cancellationToken);
            for (var y = 0; y < height; y++)
            {
                for (var x = 0; x < width; x++)
                {
                    if (mask[x, y].PackedValue >= 128)
                    {
                        canvas[x, y] = new Rgba32(color.R, color.G, color.B, 255);
                    }
                }
            }
        }

        return await EncodePngAsync(canvas, cancellationToken);
    }

    /// <summary>Pondera colores hex (#RRGGBB) por peso (ej. cantidad de píxeles) para el color representativo de un merge.</summary>
    public static string WeightedAverageHexColor(IReadOnlyList<(string ColorHex, double Weight)> colors)
    {
        double r = 0, g = 0, b = 0, totalWeight = 0;
        foreach (var (colorHex, weight) in colors)
        {
            var (cr, cg, cb) = ParseHexColor(colorHex);
            r += cr * weight;
            g += cg * weight;
            b += cb * weight;
            totalWeight += weight;
        }

        if (totalWeight <= 0)
        {
            return "#000000";
        }

        var finalR = (int)Math.Clamp(Math.Round(r / totalWeight), 0, 255);
        var finalG = (int)Math.Clamp(Math.Round(g / totalWeight), 0, 255);
        var finalB = (int)Math.Clamp(Math.Round(b / totalWeight), 0, 255);
        return $"#{finalR:x2}{finalG:x2}{finalB:x2}";
    }

    private static async Task<Image<L8>> LoadMaskAsync(
        IFileStorage storage, string key, int expectedWidth, int expectedHeight, CancellationToken cancellationToken)
    {
        await using var stream = await storage.OpenReadAsync(key, cancellationToken);
        var mask = await Image.LoadAsync<L8>(SafeImageDecoding.Options, stream, cancellationToken);
        if (mask.Width != expectedWidth || mask.Height != expectedHeight)
        {
            mask.Dispose();
            throw new InvalidOperationException(
                $"La máscara '{key}' tiene dimensiones {mask.Width}x{mask.Height}, se esperaban {expectedWidth}x{expectedHeight}.");
        }

        return mask;
    }

    private static async Task<byte[]> EncodePngAsync<TPixel>(Image<TPixel> image, CancellationToken cancellationToken)
        where TPixel : unmanaged, IPixel<TPixel>
    {
        using var output = new MemoryStream();
        await image.SaveAsPngAsync(output, cancellationToken);
        return output.ToArray();
    }

    private static (int R, int G, int B) ParseHexColor(string colorHex)
    {
        var hex = colorHex.TrimStart('#');
        var r = Convert.ToInt32(hex[..2], 16);
        var g = Convert.ToInt32(hex[2..4], 16);
        var b = Convert.ToInt32(hex[4..6], 16);
        return (r, g, b);
    }
}
