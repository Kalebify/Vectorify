namespace Vectorify.Api.Contracts;

/// <summary>
/// Respuesta de POST /api/v2/geometry/floating: los componentes de la unión de las formas en orden determinista (profundidad, coordenadas). En
/// <c>stencil</c> el único principal es la hoja (id 0, sin polígono ni área); en <c>parts</c> los principales son los cuerpos no contenidos en un hueco.
/// <see cref="Discarded"/> = componentes despreciables (área &lt; tolerancia²) que se descartaron: nada se calla.
/// </summary>
public sealed record GeometryFloatingResponse(
    string Mode,
    double Tolerance,
    IReadOnlyList<FloatingComponentPayload> Components,
    int FloatingCount,
    int MainCount,
    int Discarded);

/// <summary>
/// Un componente. <see cref="Kind"/> <c>principal</c> | <c>floating</c>; <see cref="Depth"/> = ancestros en el árbol de contención;
/// <see cref="Parent"/> = id del componente que lo rodea; <see cref="Bounds"/> = [minX, minY, maxX, maxY]; <see cref="Subjects"/> = índices de las formas que lo forman.
/// </summary>
public sealed record FloatingComponentPayload(
    int Id,
    string Kind,
    int Depth,
    int? Parent,
    GeometryPiecePayload? Polygon,
    double? Area,
    IReadOnlyList<double> Bounds,
    IReadOnlyList<int> Subjects);

/// <summary>
/// Respuesta de POST /api/v2/geometry/bridge: un resultado por bridge (los pedidos en orden y después los sugeridos), la geometría resultante por forma
/// (<c>changed: false</c> = igual, sin geometrías: el cliente conserva su objeto) y el REANÁLISIS de esa geometría resultante.
/// </summary>
public sealed record GeometryBridgeResponse(
    string Mode,
    double Tolerance,
    IReadOnlyList<BridgeResultPayload> Bridges,
    IReadOnlyList<BridgeSubjectResultPayload> Results,
    BridgeReanalysisPayload Reanalysis,
    int PieceCount);

public sealed record BridgePointPayload(double X, double Y);

/// <summary>
/// Un bridge resuelto. <see cref="Valid"/>/<see cref="Reason"/> (motivo estable si no lo es); <see cref="Island"/>, <see cref="Anchor"/> y
/// <see cref="Direction"/> (unitaria) resueltos; <see cref="Length"/> = largo del hueco que cruza; <see cref="Area"/> = lo que realmente quita
/// (stencil) o agrega (parts) = ancho × largo; <see cref="Reduces"/> = sumado a los válidos anteriores deja menos flotantes; <see cref="Affects"/> =
/// formas que modifica; <see cref="Polygon"/> = su rectángulo (un solo anillo cerrado).
/// </summary>
public sealed record BridgeResultPayload(
    int Index,
    bool Suggested,
    bool Valid,
    string? Reason,
    int? Island,
    BridgePointPayload? Anchor,
    BridgePointPayload? Direction,
    double Width,
    double? Length,
    double? Area,
    bool Reduces,
    IReadOnlyList<int> Affects,
    GeometryPiecePayload? Polygon);

public sealed record BridgeSubjectResultPayload(int SubjectIndex, bool Changed, IReadOnlyList<GeometryPiecePayload> Geometries);

public sealed record BridgeReanalysisPayload(int FloatingBefore, int FloatingAfter, int MainAfter);
