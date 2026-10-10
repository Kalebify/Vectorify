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
}
