using System.Text.Json;

namespace Vectorify.Api.Contracts;

/// <summary>
/// Cuerpo JSON de POST /api/v2/geometry/boolean (M3-S04, ADR D4). <see cref="Operation"/>: union | difference |
/// intersection | intersection_all | xor | normalize (case-insensitive; intersection_all = región común a TODAS las formas, M3-S08). <see cref="Subjects"/> son polygon/line; <see cref="Operands"/>
/// además admiten bufferedLine (pincel de borrador). <see cref="Tolerance"/> &gt; 0 está en UNIDADES DE DOCUMENTO.
/// Los campos son anulables y <c>JsonElement</c> a propósito: la validación es explícita y devuelve
/// <see cref="ApiErrorResponse"/> en vez de un 400 genérico del binder (ver GeometryRequestValidator).
/// </summary>
public sealed record GeometryBooleanRequest(
    string? Operation,
    IReadOnlyList<GeometryShapeRequest>? Subjects,
    IReadOnlyList<GeometryShapeRequest>? Operands,
    double? Tolerance);

/// <summary>
/// Una forma del intercambio de geometría. <c>polygon</c>: <see cref="Coordinates"/> = anillos [[[x,y],...],...] (el primero
/// exterior, regla par-impar). <c>line</c>: <see cref="Coordinates"/> = polilínea [[x,y],...]. <c>bufferedLine</c> (solo
/// operandos): <see cref="Points"/> [[x,y],...] + <see cref="Radius"/> (pincel redondo).
/// </summary>
public sealed record GeometryShapeRequest(string? Type, JsonElement? Coordinates, JsonElement? Points, double? Radius);
