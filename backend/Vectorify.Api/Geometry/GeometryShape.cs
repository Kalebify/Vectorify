namespace Vectorify.Api.Geometry;

/// <summary>
/// Forma ya validada del intercambio de geometría (M3-S04, ADR D4): coordenadas finitas, estructura correcta. Es lo que
/// el validador entrega al cliente de Python; nada de esto es path data ni SVG.
/// </summary>
public abstract record GeometryShape
{
    private GeometryShape()
    {
    }

    /// <summary>Polígono = anillos (el primero exterior; huecos por regla par-impar). Cada anillo tiene &gt;= 3 vértices.</summary>
    public sealed record Polygon(double[][][] Rings) : GeometryShape;

    /// <summary>Polilínea de &gt;= 2 vértices.</summary>
    public sealed record Line(double[][] Points) : GeometryShape;

    /// <summary>Pincel de borrador (solo operando): línea (&gt;= 1 punto) con radio &gt; 0, extremos y uniones redondos.</summary>
    public sealed record BufferedLine(double[][] Points, double Radius) : GeometryShape;
}

/// <summary>Parámetros efectivos y válidos de una operación booleana.</summary>
public sealed record GeometryBooleanParameters(
    GeometryOperation Operation,
    IReadOnlyList<GeometryShape> Subjects,
    IReadOnlyList<GeometryShape> Operands,
    double Tolerance);
