using System.Text.Json;

namespace Vectorify.Api.Contracts;

/// <summary>
/// Cuerpo JSON de POST /api/v2/geometry/split (M3-S10, ADR D4). <see cref="Subjects"/> son polygon/line (el mismo formato de anillos de
/// las booleanas). <see cref="Cutter"/> es la línea de corte (polilínea de &gt;= 2 puntos en UNIDADES DE DOCUMENTO). <see cref="Mode"/>
/// <c>split</c> (dividir: las piezas comparten el borde del corte) | <c>slot</c> (separar con hueco: se resta una ranura de ancho
/// <see cref="SlotWidth"/>, &gt; 0 en ese modo e ignorado en <c>split</c>; default 0). <see cref="Extend"/> prolonga el primer y el último tramo del
/// corte para que crucen todo (default false). <see cref="Tolerance"/> &gt; 0 (unidades de documento). Los campos son anulables a propósito:
/// la validación es explícita y devuelve <see cref="ApiErrorResponse"/> en vez de un 400 genérico del binder (ver GeometryRequestValidator).
/// </summary>
public sealed record GeometrySplitRequest(
    IReadOnlyList<GeometryShapeRequest>? Subjects,
    GeometryCutterRequest? Cutter,
    string? Mode,
    double? SlotWidth,
    bool? Extend,
    double? Tolerance);

/// <summary>Línea de corte: <see cref="Points"/> = polilínea [[x,y],...] (&gt;= 2 puntos).</summary>
public sealed record GeometryCutterRequest(JsonElement? Points);
