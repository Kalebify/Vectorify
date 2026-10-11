using Vectorify.Api.Contracts;

namespace Vectorify.Api.Geometry;

/// <summary>
/// Valida la petición de POST /api/v2/geometry/boolean antes de llamar a Python: cuerpo presente, operación conocida,
/// tolerancia finita y positiva, estructura de cada forma, NaN/Infinity/null en las coordenadas y los límites de
/// subjects/operands/vértices. Nada se ejecuta ni se evalúa: solo se recorre y se cuenta.
/// </summary>
public interface IGeometryRequestValidator
{
    GeometryValidationResult Validate(GeometryBooleanRequest? request);

    /// <summary>
    /// Valida la petición de POST /api/v2/geometry/offset (M3-S09): distancia finita, distinta de 0 y dentro del tope (y solo positiva si
    /// hay líneas), join/cap conocidos, límite de inglete en rango, tolerancia, y las mismas reglas de formas y límites que las booleanas.
    /// </summary>
    GeometryValidationResult ValidateOffset(GeometryOffsetRequest? request);

    /// <summary>
    /// Valida la petición de POST /api/v2/geometry/split (M3-S10): modo conocido, ancho de ranura (&gt; 0 y dentro del tope en modo ranura),
    /// tolerancia, la línea de corte (&gt;= 2 puntos distintos, finitos y bajo el tope) y las mismas reglas de formas y límites que las booleanas.
    /// </summary>
    GeometryValidationResult ValidateSplit(GeometrySplitRequest? request);

    /// <summary>
    /// Valida la petición de POST /api/v2/geometry/floating (M3-S11): modo conocido (stencil/parts), tolerancia, y que cada forma sea un polígono bien
    /// formado (anillos de &gt;= 3 puntos finitos, <c>locked</c> opcional) dentro de los límites de subjects/vértices.
    /// </summary>
    GeometryValidationResult ValidateFloating(GeometryFloatingRequest? request);

    /// <summary>
    /// Valida la petición de POST /api/v2/geometry/bridge (M3-S11): lo mismo que el análisis más los bridges (cada uno con isla o ancla, dirección no nula,
    /// ancho y largo finitos dentro del tope, tope de bridges) y el ancho de <c>suggest</c>.
    /// </summary>
    GeometryValidationResult ValidateBridge(GeometryBridgeRequest? request);
}
