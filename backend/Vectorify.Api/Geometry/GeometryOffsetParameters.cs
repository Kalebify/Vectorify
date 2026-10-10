namespace Vectorify.Api.Geometry;

/// <summary>Forma de las esquinas del offset (M3-S09). El nombre en el cable es el del enum en minúsculas (<c>mitre</c> = inglete).</summary>
public enum OffsetJoinStyle
{
    Round,
    Mitre,
    Bevel,
}

/// <summary>Forma de los extremos de una línea abierta en el offset (M3-S09).</summary>
public enum OffsetCapStyle
{
    Round,
    Flat,
    Square,
}

public static class OffsetStyleNames
{
    public static string ToWireName(this OffsetJoinStyle style) => style switch
    {
        OffsetJoinStyle.Round => "round",
        OffsetJoinStyle.Mitre => "mitre",
        OffsetJoinStyle.Bevel => "bevel",
        _ => throw new ArgumentOutOfRangeException(nameof(style), style, null),
    };

    public static string ToWireName(this OffsetCapStyle style) => style switch
    {
        OffsetCapStyle.Round => "round",
        OffsetCapStyle.Flat => "flat",
        OffsetCapStyle.Square => "square",
        _ => throw new ArgumentOutOfRangeException(nameof(style), style, null),
    };

    public static bool TryParseJoin(string? value, out OffsetJoinStyle style)
    {
        switch (value?.Trim().ToLowerInvariant())
        {
            case "round": style = OffsetJoinStyle.Round; return true;
            case "mitre": style = OffsetJoinStyle.Mitre; return true;
            case "bevel": style = OffsetJoinStyle.Bevel; return true;
            default: style = default; return false;
        }
    }

    public static bool TryParseCap(string? value, out OffsetCapStyle style)
    {
        switch (value?.Trim().ToLowerInvariant())
        {
            case "round": style = OffsetCapStyle.Round; return true;
            case "flat": style = OffsetCapStyle.Flat; return true;
            case "square": style = OffsetCapStyle.Square; return true;
            default: style = default; return false;
        }
    }
}

/// <summary>Parámetros efectivos y válidos de un offset: subjects (polygon/line) ya validados y la distancia firmada en unidades de documento.</summary>
public sealed record GeometryOffsetParameters(
    IReadOnlyList<GeometryShape> Subjects,
    double Distance,
    OffsetJoinStyle JoinStyle,
    double MitreLimit,
    OffsetCapStyle CapStyle,
    double Tolerance);
