namespace Vectorify.Api.Contracts;

/// <summary>
/// Cuerpo JSON de POST /api/v2/geometry/offset (M3-S09, ADR D4). <see cref="Subjects"/> son polygon/line (el mismo formato de anillos de
/// las booleanas). <see cref="Distance"/> está FIRMADA y en UNIDADES DE DOCUMENTO (&gt; 0 exterior, &lt; 0 interior, 0 se rechaza; las
/// líneas solo admiten &gt; 0 = ambos lados). <see cref="JoinStyle"/> round | mitre | bevel (default round), <see cref="MitreLimit"/>
/// &gt; 0 (default 2), <see cref="CapStyle"/> round | flat | square (solo líneas; default round) y <see cref="Tolerance"/> &gt; 0 (unidades
/// de documento). Los campos son anulables a propósito: la validación es explícita y devuelve <see cref="ApiErrorResponse"/> en vez de
/// un 400 genérico del binder (ver GeometryRequestValidator).
/// </summary>
public sealed record GeometryOffsetRequest(
    IReadOnlyList<GeometryShapeRequest>? Subjects,
    double? Distance,
    string? JoinStyle,
    double? MitreLimit,
    string? CapStyle,
    double? Tolerance);
