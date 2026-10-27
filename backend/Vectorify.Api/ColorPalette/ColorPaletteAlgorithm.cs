namespace Vectorify.Api.ColorPalette;

/// <summary>
/// Versión del algoritmo de detección/agrupación de paleta y nombres de los estilos de
/// agrupación. <see cref="CurrentVersion"/> espeja
/// <c>services/python-engine/app/core/color_families.py::ALGORITHM_VERSION</c>: forma parte
/// de <see cref="ColorPaletteParameters"/> (clave de caché, persistencia y respuesta), de modo que
/// una paleta generada con otra versión nunca se reutiliza como si fuera la vigente. Una
/// paleta persistida antes de existir este campo se rehidrata con versión 0.
/// </summary>
public static class ColorPaletteAlgorithm
{
    public const int CurrentVersion = 1;

    /// <summary>Conserva cada tono detectado (comportamiento histórico, valor por defecto de la API).</summary>
    public const string Detailed = "detailed";

    /// <summary>Reúne luces y sombras de una misma familia de color en una capa antes de vectorizar.</summary>
    public const string BaseColors = "base_colors";

    public static bool IsKnownStyle(string? style) => style is Detailed or BaseColors;
}
