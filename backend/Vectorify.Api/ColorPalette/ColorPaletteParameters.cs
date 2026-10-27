using System.Globalization;

namespace Vectorify.Api.ColorPalette;

/// <summary>
/// Parámetros efectivos de detección de paleta de colores (M2-S01/M2.1-S02):
/// tolerancia de fusión automática (distancia Lab, ver
/// services/python-engine/app/core/color_palette_pipeline.py), número
/// objetivo (límite superior opcional) de colores, y (M2.1-S02)
/// <see cref="TinyAreaRatio"/> -- umbral de "grupo diminuto" (relativo a los
/// píxeles relevantes de la imagen) para fusionar automáticamente hacia su
/// vecino más cercano los grupos que la explosión de colores por
/// antialiasing genera (ver auditoría M2.1-S01 y
/// app.core.color_palette_pipeline._merge_tiny_groups_into_nearest).
///
/// Agrupación por familias (tarjeta "Agrupar sombras y variantes en colores base"):
/// <see cref="GroupingStyle"/> (<c>detailed</c> por defecto, también para todo registro
/// persistido antes de existir el campo, o <c>base_colors</c>), <see cref="TargetFamilies"/>
/// (tope de familias, solo <c>base_colors</c>), <see cref="GroupingStrength"/> (0-1, solo
/// <c>base_colors</c>) y <see cref="AlgorithmVersion"/> (0 = paleta anterior a la versión).
/// Los valores por defecto de los campos nuevos reproducen el comportamiento histórico, de modo
/// que los sidecars JSON anteriores se rehidratan como paletas detalladas sin modificarse.
/// </summary>
public sealed record ColorPaletteParameters(
    double Tolerance,
    int? MaxColors,
    double TinyAreaRatio,
    string GroupingStyle = ColorPaletteAlgorithm.Detailed,
    int? TargetFamilies = null,
    double GroupingStrength = 0.5,
    int AlgorithmVersion = 0)
{
    /// <summary>Clave estable para deduplicar/cachear detecciones -- ver ColorPaletteVersion.</summary>
    public string ToCacheKey() =>
        $"tolerance={Tolerance.ToString("F6", CultureInfo.InvariantCulture)};" +
        $"maxColors={MaxColors?.ToString(CultureInfo.InvariantCulture) ?? "none"};" +
        $"tinyAreaRatio={TinyAreaRatio.ToString("F6", CultureInfo.InvariantCulture)};" +
        $"style={GroupingStyle};" +
        $"targetFamilies={TargetFamilies?.ToString(CultureInfo.InvariantCulture) ?? "auto"};" +
        $"strength={GroupingStrength.ToString("F6", CultureInfo.InvariantCulture)};" +
        $"algorithm={AlgorithmVersion.ToString(CultureInfo.InvariantCulture)}";
}
