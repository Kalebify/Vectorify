namespace Vectorify.Api.Geometry;

/// <summary>Modo del corte (M3-S10). El nombre en el cable es el del enum en minúsculas: <c>split</c> = dividir, <c>slot</c> = separar con hueco.</summary>
public enum SplitMode
{
    Split,
    Slot,
}

public static class SplitModeNames
{
    public static string ToWireName(this SplitMode mode) => mode switch
    {
        SplitMode.Split => "split",
        SplitMode.Slot => "slot",
        _ => throw new ArgumentOutOfRangeException(nameof(mode), mode, null),
    };

    public static bool TryParse(string? value, out SplitMode mode)
    {
        switch (value?.Trim().ToLowerInvariant())
        {
            case "split": mode = SplitMode.Split; return true;
            case "slot": mode = SplitMode.Slot; return true;
            default: mode = default; return false;
        }
    }
}

/// <summary>
/// Parámetros efectivos y válidos de un corte (M3-S10): subjects (polygon/line) ya validados, la polilínea de corte (&gt;= 2 puntos, no todos
/// iguales), el modo, el ancho de la ranura en unidades de documento (&gt; 0 en <see cref="SplitMode.Slot"/>), si se extiende y la tolerancia.
/// </summary>
public sealed record GeometrySplitParameters(
    IReadOnlyList<GeometryShape> Subjects,
    double[][] CutterPoints,
    SplitMode Mode,
    double SlotWidth,
    bool Extend,
    double Tolerance);
