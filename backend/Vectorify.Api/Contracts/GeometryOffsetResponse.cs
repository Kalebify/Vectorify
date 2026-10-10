namespace Vectorify.Api.Contracts;

/// <summary>
/// Respuesta de POST /api/v2/geometry/offset: los parámetros efectivos y, por subject (mismo orden que la petición), las piezas
/// resultantes con lo que pasó -- nada se calla: el cliente informa colapsos, divisiones y huecos ANTES de aplicar.
/// </summary>
public sealed record GeometryOffsetResponse(
    double Distance,
    string JoinStyle,
    double MitreLimit,
    string CapStyle,
    double Tolerance,
    IReadOnlyList<GeometryOffsetResultPayload> Results,
    int PieceCount);

/// <summary>
/// Resultado del offset de UN subject. <see cref="Geometries"/> son polígonos (anillos CERRADOS, exterior primero), vacío si
/// <see cref="Collapsed"/>. <see cref="SplitCount"/> = piezas del resultado; <see cref="PiecesBefore"/> = piezas disjuntas del subject;
/// <see cref="LostPieces"/> = piezas del subject que desaparecen del todo; <see cref="MaxInwardOffset"/> = offset interior a partir del
/// cual todo el subject colapsa (null para líneas).
/// </summary>
public sealed record GeometryOffsetResultPayload(
    int SubjectIndex,
    IReadOnlyList<GeometryPiecePayload> Geometries,
    bool Collapsed,
    int PiecesBefore,
    int SplitCount,
    int LostPieces,
    int HolesBefore,
    int HolesAfter,
    double? MaxInwardOffset);
