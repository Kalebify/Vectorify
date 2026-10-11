namespace Vectorify.Api.Contracts;

/// <summary>
/// Respuesta de POST /api/v2/geometry/split: los parámetros efectivos y, por subject (mismo orden que la petición), las piezas
/// resultantes con lo que pasó -- nada se calla: el cliente informa qué objetos se cortan, cuáles solo se tocan sin atravesar y
/// cuántas piezas despreciables se descartaron ANTES de aplicar.
/// </summary>
public sealed record GeometrySplitResponse(
    string Mode,
    double SlotWidth,
    bool Extend,
    double Tolerance,
    IReadOnlyList<GeometrySplitResultPayload> Results,
    int PieceCount);

/// <summary>
/// Resultado del corte de UN subject. <see cref="Touched"/> = el corte (o su ranura) alcanza al subject. <see cref="Changed"/> = quedó
/// SEPARADO en más piezas que antes; si es false, <see cref="Pieces"/> es el subject tal cual (el cliente conserva su objeto con sus
/// curvas). <see cref="Pieces"/> son polígonos (anillos CERRADOS, exterior primero) para un subject poligonal y polilíneas para uno lineal.
/// <see cref="Discarded"/> = piezas despreciables (área &lt; tolerancia², largo &lt;= tolerancia) descartadas de un resultado que sí cambió.
/// </summary>
public sealed record GeometrySplitResultPayload(
    int SubjectIndex,
    bool Changed,
    bool Touched,
    IReadOnlyList<GeometryPiecePayload> Pieces,
    int PieceCount,
    int Discarded);
