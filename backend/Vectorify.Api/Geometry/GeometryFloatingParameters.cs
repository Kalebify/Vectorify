namespace Vectorify.Api.Geometry;

/// <summary>Modo del análisis de piezas flotantes (M3-S11). El nombre en el cable: <c>stencil</c> (Plantilla: las formas son cortes) | <c>parts</c> (Piezas: las formas son material).</summary>
public enum FloatingMode
{
    Stencil,
    Parts,
}

public static class FloatingModeNames
{
    public static string ToWireName(this FloatingMode mode) => mode switch
    {
        FloatingMode.Stencil => "stencil",
        FloatingMode.Parts => "parts",
        _ => throw new ArgumentOutOfRangeException(nameof(mode), mode, null),
    };

    public static bool TryParse(string? value, out FloatingMode mode)
    {
        switch (value?.Trim().ToLowerInvariant())
        {
            case "stencil": mode = FloatingMode.Stencil; return true;
            case "parts": mode = FloatingMode.Parts; return true;
            default: mode = default; return false;
        }
    }
}

/// <summary>Una forma ya validada del análisis: los anillos de un polígono (regla par-impar) y si está bloqueada (cuenta para el análisis, no se modifica).</summary>
public sealed record GeometryFloatingSubject(double[][][] Rings, bool Locked);

/// <summary>Parámetros efectivos y válidos del análisis de piezas flotantes (M3-S11).</summary>
public sealed record GeometryFloatingParameters(IReadOnlyList<GeometryFloatingSubject> Subjects, FloatingMode Mode, double Tolerance);

/// <summary>Un bridge pedido, ya validado: al menos <see cref="Island"/> o <see cref="Anchor"/>; <see cref="Width"/> &gt; 0; <see cref="Direction"/> y <see cref="Length"/> opcionales.</summary>
public sealed record GeometryBridgeSpec(int? Island, double[]? Anchor, double[]? Direction, double Width, double? Length);

/// <summary>Parámetros efectivos y válidos de los bridges (M3-S11): <see cref="SuggestWidth"/> es obligatorio con <see cref="Suggest"/>.</summary>
public sealed record GeometryBridgeParameters(
    IReadOnlyList<GeometryFloatingSubject> Subjects,
    FloatingMode Mode,
    IReadOnlyList<GeometryBridgeSpec> Bridges,
    bool Suggest,
    double? SuggestWidth,
    double Tolerance);
