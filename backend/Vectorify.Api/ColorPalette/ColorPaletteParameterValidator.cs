using Microsoft.Extensions.Options;
using Vectorify.Api.Contracts;
using Vectorify.Api.Options;

namespace Vectorify.Api.ColorPalette;

/// <summary>
/// Valida tolerancia/número objetivo de colores dentro de los rangos
/// configurados (<see cref="ColorPaletteOptions"/>), resolviendo los
/// defaults cuando el cliente los omite -- mismo criterio de defensa en
/// profundidad que SimplificationParameterValidator/CheckParameterValidator
/// (Python vuelve a validar del lado suyo, pero Vectorify.Api nunca confía
/// ciegamente en lo que llega del navegador).
/// </summary>
public sealed class ColorPaletteParameterValidator : IColorPaletteParameterValidator
{
    private readonly ColorPaletteOptions _options;

    public ColorPaletteParameterValidator(IOptions<ColorPaletteOptions> options)
    {
        _options = options.Value;
    }

    public ColorPaletteParameterValidationResult Validate(ColorPaletteDetectRequest request)
    {
        var tolerance = request.Tolerance ?? _options.DefaultTolerance;

        if (double.IsNaN(tolerance) || double.IsInfinity(tolerance)
            || tolerance < _options.MinTolerance || tolerance > _options.MaxTolerance)
        {
            return ColorPaletteParameterValidationResult.Failure(
                "invalid_parameters",
                $"La tolerancia debe estar en el rango [{_options.MinTolerance}, {_options.MaxTolerance}].");
        }

        if (request.MaxColors.HasValue
            && (request.MaxColors.Value < _options.MinColors || request.MaxColors.Value > _options.MaxColorsUpperBound))
        {
            return ColorPaletteParameterValidationResult.Failure(
                "invalid_parameters",
                $"maxColors debe estar en el rango [{_options.MinColors}, {_options.MaxColorsUpperBound}], o null para sin límite.");
        }

        var tinyAreaRatio = request.TinyAreaRatio ?? _options.DefaultTinyAreaRatio;

        if (double.IsNaN(tinyAreaRatio) || double.IsInfinity(tinyAreaRatio)
            || tinyAreaRatio < _options.MinTinyAreaRatio || tinyAreaRatio > _options.MaxTinyAreaRatio)
        {
            return ColorPaletteParameterValidationResult.Failure(
                "invalid_parameters",
                $"tinyAreaRatio debe estar en el rango [{_options.MinTinyAreaRatio}, {_options.MaxTinyAreaRatio}].");
        }

        var style = request.GroupingStyle ?? _options.DefaultGroupingStyle;
        if (!ColorPaletteAlgorithm.IsKnownStyle(style))
        {
            return ColorPaletteParameterValidationResult.Failure(
                "invalid_parameters",
                $"groupingStyle debe ser '{ColorPaletteAlgorithm.Detailed}' o '{ColorPaletteAlgorithm.BaseColors}'.");
        }

        if (style == ColorPaletteAlgorithm.Detailed)
        {
            // Los parámetros de familias no aplican: se normalizan para que no generen entradas de caché distintas.
            return ColorPaletteParameterValidationResult.Success(new ColorPaletteParameters(
                tolerance, request.MaxColors, tinyAreaRatio, style, TargetFamilies: null,
                GroupingStrength: _options.DefaultGroupingStrength, AlgorithmVersion: ColorPaletteAlgorithm.CurrentVersion));
        }

        if (request.TargetFamilies.HasValue
            && (request.TargetFamilies.Value < _options.MinTargetFamilies || request.TargetFamilies.Value > _options.MaxTargetFamilies))
        {
            return ColorPaletteParameterValidationResult.Failure(
                "invalid_parameters",
                $"targetFamilies debe estar en el rango [{_options.MinTargetFamilies}, {_options.MaxTargetFamilies}], o null para automático.");
        }

        var strength = request.GroupingStrength ?? _options.DefaultGroupingStrength;
        if (double.IsNaN(strength) || double.IsInfinity(strength)
            || strength < _options.MinGroupingStrength || strength > _options.MaxGroupingStrength)
        {
            return ColorPaletteParameterValidationResult.Failure(
                "invalid_parameters",
                $"groupingStrength debe estar en el rango [{_options.MinGroupingStrength}, {_options.MaxGroupingStrength}].");
        }

        // En base_colors el tope lo da targetFamilies: maxColors no aplica y se normaliza a null.
        return ColorPaletteParameterValidationResult.Success(new ColorPaletteParameters(
            tolerance, MaxColors: null, tinyAreaRatio, style, request.TargetFamilies, strength, ColorPaletteAlgorithm.CurrentVersion));
    }
}
