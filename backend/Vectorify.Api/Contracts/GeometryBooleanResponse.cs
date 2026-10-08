using System.Text.Json;

namespace Vectorify.Api.Contracts;

/// <summary>
/// Respuesta de POST /api/v2/geometry/boolean. <see cref="Scope"/> = "per_subject" (difference/intersection/normalize: una
/// entrada de <see cref="Results"/> por subject, en el mismo orden) o "combined" (union/xor/intersection_all: una sola entrada). Cada pieza
/// es un anillo-lista (polygon) o una polilínea (line) en unidades de documento, ya validada y en orden determinista.
/// </summary>
public sealed record GeometryBooleanResponse(
    string Operation,
    string Scope,
    double Tolerance,
    IReadOnlyList<GeometryResultPayload> Results,
    int PieceCount);

/// <summary>
/// Resultado para un subject (<see cref="SubjectIndex"/>) o para el conjunto (null). <see cref="Changed"/> false = el resultado
/// es topológicamente igual al subject (el cliente conserva su objeto original). <see cref="Geometries"/> puede estar vacío.
/// </summary>
public sealed record GeometryResultPayload(int? SubjectIndex, bool Changed, IReadOnlyList<GeometryPiecePayload> Geometries);

/// <summary>Pieza del resultado: <c>polygon</c> (anillos CERRADOS, exterior primero) o <c>line</c>.</summary>
public sealed record GeometryPiecePayload(string Type, JsonElement Coordinates);
