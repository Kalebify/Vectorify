using System.Text.Json;

namespace Vectorify.Api.Contracts;

/// <summary>
/// Cuerpo JSON de POST /api/v2/geometry/floating (M3-S11, ADR D4). <see cref="Subjects"/> son polígonos (anillos con regla par-impar) con
/// <c>locked</c> opcional: una forma bloqueada cuenta para el análisis (no cambia el resultado). <see cref="Mode"/>: <c>stencil</c> (Plantilla: las
/// formas son CORTES y flotante es cada isla de material rodeada de corte) | <c>parts</c> (Piezas: las formas son MATERIAL y flotante es un componente
/// dentro de un hueco de otro). <see cref="Tolerance"/> &gt; 0 en UNIDADES DE DOCUMENTO. Los campos son anulables a propósito: la validación es
/// explícita y devuelve <see cref="ApiErrorResponse"/> en vez de un 400 genérico del binder (ver GeometryRequestValidator).
/// </summary>
public sealed record GeometryFloatingRequest(
    IReadOnlyList<GeometryFloatingSubjectRequest>? Subjects,
    string? Mode,
    double? Tolerance);

/// <summary>Una forma del análisis de piezas flotantes: <c>polygon</c> con sus anillos [[[x,y],...],...] y si está bloqueada (no se modifica).</summary>
public sealed record GeometryFloatingSubjectRequest(string? Type, JsonElement? Coordinates, bool? Locked);

/// <summary>
/// Cuerpo JSON de POST /api/v2/geometry/bridge (M3-S11). <see cref="Bridges"/>: cada uno con <c>island</c> (id de una pieza flotante del análisis: el
/// servidor sugiere ancla y dirección) y/o <c>anchor</c> (punto sobre el borde de una pieza flotante), <c>direction</c> opcional, <c>width</c> (unidades de
/// documento, &gt; 0) y <c>length</c> opcional. Con <see cref="Suggest"/> el servidor completa, con un bridge de ancho <see cref="SuggestWidth"/>, cada pieza
/// flotante que ningún bridge válido cubre.
/// </summary>
public sealed record GeometryBridgeRequest(
    IReadOnlyList<GeometryFloatingSubjectRequest>? Subjects,
    string? Mode,
    IReadOnlyList<GeometryBridgeItemRequest>? Bridges,
    bool? Suggest,
    double? SuggestWidth,
    double? Tolerance);

public sealed record GeometryBridgeItemRequest(int? Island, GeometryPointRequest? Anchor, GeometryPointRequest? Direction, double? Width, double? Length);

public sealed record GeometryPointRequest(double? X, double? Y);
