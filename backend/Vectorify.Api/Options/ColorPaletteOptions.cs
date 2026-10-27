namespace Vectorify.Api.Options;

/// <summary>
/// Configuración de detección de paleta de colores (M2-S01): timeout HTTP
/// hacia el motor Python y rangos permitidos de tolerancia/número objetivo
/// de colores. spec.md no cuantifica ninguno de estos valores
/// ("Ambigüedades detectadas": "el implementador decide y documenta"); los
/// valores de acá son ese supuesto, documentado en el reporte del sprint,
/// alineados 1:1 con services/python-engine/app/core/config.py
/// (color_palette_default_tolerance, etc.) -- defensa en profundidad, mismo
/// criterio que SimplificationOptions/CheckOptions. Se enlaza desde la
/// sección "ColorPalette".
/// </summary>
public sealed class ColorPaletteOptions
{
    public const string SectionName = "ColorPalette";

    public int TimeoutSeconds { get; set; } = 25;

    public double DefaultTolerance { get; set; } = 12.0;
    public double MinTolerance { get; set; } = 0.0;
    public double MaxTolerance { get; set; } = 100.0;

    public int MinColors { get; set; } = 1;
    public int MaxColorsUpperBound { get; set; } = 64;

    // M2.1-S02: umbral de "grupo diminuto" (relativo a los píxeles
    // relevantes de la imagen, ver services/python-engine/app/core/
    // color_palette_pipeline.py._merge_tiny_groups_into_nearest) para
    // fusionar automáticamente hacia el vecino más cercano los grupos que
    // la explosión de colores por antialiasing genera (auditoría M2.1-S01:
    // 17 grupos en vez de ~5 lógicos). 0.001 (0.1%) es un supuesto
    // documentado con evidencia empírica en el reporte del sprint --
    // espejado 1:1 con Settings.color_palette_default_tiny_area_ratio del
    // motor Python (mismo criterio que DefaultTolerance).
    public double DefaultTinyAreaRatio { get; set; } = 0.001;
    public double MinTinyAreaRatio { get; set; } = 0.0;
    public double MaxTinyAreaRatio { get; set; } = 0.5;

    // Agrupación por familias de color base (espejo de ColorPaletteParams del motor Python).
    // DefaultGroupingStyle es "detailed" a propósito: una petición que omite el estilo -- y
    // cualquier paleta/documento anterior -- conserva el comportamiento histórico, nunca cambia
    // en silencio. La propuesta "Colores base" como valor inicial es decisión del frontend para
    // detecciones NUEVAS (ver spec.md, ambigüedad 2).
    public string DefaultGroupingStyle { get; set; } = ColorPalette.ColorPaletteAlgorithm.Detailed;
    public int MinTargetFamilies { get; set; } = 1;
    public int MaxTargetFamilies { get; set; } = 16;
    public double DefaultGroupingStrength { get; set; } = 0.5;
    public double MinGroupingStrength { get; set; } = 0.0;
    public double MaxGroupingStrength { get; set; } = 1.0;
}
