using System.Text.Json;
using System.Text.Json.Serialization;

namespace Vectorify.Api.Contracts;

/// <summary>
/// Forma cruda (snake_case, tal como la serializa Pydantic) de la respuesta de POST /api/v1/geometry/boolean del motor
/// Python/FastAPI -- mismo criterio que <see cref="PythonPhysicalUnionPayload"/>.
/// </summary>
public sealed class PythonGeometryPayload
{
    [JsonPropertyName("operation")]
    public string? Operation { get; set; }

    [JsonPropertyName("scope")]
    public string? Scope { get; set; }

    [JsonPropertyName("tolerance")]
    public double Tolerance { get; set; }

    [JsonPropertyName("results")]
    public List<PythonGeometryResultPayload>? Results { get; set; }

    [JsonPropertyName("piece_count")]
    public int PieceCount { get; set; }
}

public sealed class PythonGeometryResultPayload
{
    [JsonPropertyName("subject_index")]
    public int? SubjectIndex { get; set; }

    [JsonPropertyName("changed")]
    public bool Changed { get; set; }

    [JsonPropertyName("geometries")]
    public List<PythonGeometryPiecePayload>? Geometries { get; set; }
}

public sealed class PythonGeometryPiecePayload
{
    [JsonPropertyName("type")]
    public string? Type { get; set; }

    [JsonPropertyName("coordinates")]
    public JsonElement? Coordinates { get; set; }
}

/// <summary>Cuerpo JSON que Vectorify.Api le envía a Python (ya validado): mismos nombres que GeometryBooleanRequest de Pydantic.</summary>
public sealed class PythonGeometryRequestPayload
{
    [JsonPropertyName("operation")]
    public string Operation { get; set; } = string.Empty;

    [JsonPropertyName("subjects")]
    public List<PythonGeometryShapePayload> Subjects { get; set; } = [];

    [JsonPropertyName("operands")]
    public List<PythonGeometryShapePayload> Operands { get; set; } = [];

    [JsonPropertyName("tolerance")]
    public double Tolerance { get; set; }
}

public sealed class PythonGeometryShapePayload
{
    [JsonPropertyName("type")]
    public string Type { get; set; } = string.Empty;

    /// <summary>polygon: anillos (double[][][]); line: polilínea (double[][]). Se serializa por su tipo en ejecución.</summary>
    [JsonPropertyName("coordinates")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public object? Coordinates { get; set; }

    [JsonPropertyName("points")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public double[][]? Points { get; set; }

    [JsonPropertyName("radius")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public double? Radius { get; set; }
}

/// <summary>Forma cruda (snake_case, tal como la serializa Pydantic) de la respuesta de POST /api/v1/geometry/offset del motor Python (M3-S09).</summary>
public sealed class PythonGeometryOffsetPayload
{
    [JsonPropertyName("distance")]
    public double Distance { get; set; }

    [JsonPropertyName("join_style")]
    public string? JoinStyle { get; set; }

    [JsonPropertyName("mitre_limit")]
    public double MitreLimit { get; set; }

    [JsonPropertyName("cap_style")]
    public string? CapStyle { get; set; }

    [JsonPropertyName("tolerance")]
    public double Tolerance { get; set; }

    [JsonPropertyName("results")]
    public List<PythonGeometryOffsetResultPayload>? Results { get; set; }

    [JsonPropertyName("piece_count")]
    public int PieceCount { get; set; }
}

public sealed class PythonGeometryOffsetResultPayload
{
    [JsonPropertyName("subject_index")]
    public int SubjectIndex { get; set; }

    [JsonPropertyName("geometries")]
    public List<PythonGeometryPiecePayload>? Geometries { get; set; }

    [JsonPropertyName("collapsed")]
    public bool Collapsed { get; set; }

    [JsonPropertyName("pieces_before")]
    public int PiecesBefore { get; set; }

    [JsonPropertyName("split_count")]
    public int SplitCount { get; set; }

    [JsonPropertyName("lost_pieces")]
    public int LostPieces { get; set; }

    [JsonPropertyName("holes_before")]
    public int HolesBefore { get; set; }

    [JsonPropertyName("holes_after")]
    public int HolesAfter { get; set; }

    [JsonPropertyName("max_inward_offset")]
    public double? MaxInwardOffset { get; set; }
}

/// <summary>Cuerpo JSON del offset que Vectorify.Api le envía a Python (ya validado): mismos nombres que GeometryOffsetRequest de Pydantic.</summary>
public sealed class PythonGeometryOffsetRequestPayload
{
    [JsonPropertyName("subjects")]
    public List<PythonGeometryShapePayload> Subjects { get; set; } = [];

    [JsonPropertyName("distance")]
    public double Distance { get; set; }

    [JsonPropertyName("join_style")]
    public string JoinStyle { get; set; } = string.Empty;

    [JsonPropertyName("mitre_limit")]
    public double MitreLimit { get; set; }

    [JsonPropertyName("cap_style")]
    public string CapStyle { get; set; } = string.Empty;

    [JsonPropertyName("tolerance")]
    public double Tolerance { get; set; }
}

/// <summary>Forma cruda (snake_case, tal como la serializa Pydantic) de la respuesta de POST /api/v1/geometry/split del motor Python (M3-S10).</summary>
public sealed class PythonGeometrySplitPayload
{
    [JsonPropertyName("mode")]
    public string? Mode { get; set; }

    [JsonPropertyName("slot_width")]
    public double SlotWidth { get; set; }

    [JsonPropertyName("extend")]
    public bool Extend { get; set; }

    [JsonPropertyName("tolerance")]
    public double Tolerance { get; set; }

    [JsonPropertyName("results")]
    public List<PythonGeometrySplitResultPayload>? Results { get; set; }

    [JsonPropertyName("piece_count")]
    public int PieceCount { get; set; }
}

public sealed class PythonGeometrySplitResultPayload
{
    [JsonPropertyName("subject_index")]
    public int SubjectIndex { get; set; }

    [JsonPropertyName("changed")]
    public bool Changed { get; set; }

    [JsonPropertyName("touched")]
    public bool Touched { get; set; }

    [JsonPropertyName("pieces")]
    public List<PythonGeometryPiecePayload>? Pieces { get; set; }

    [JsonPropertyName("piece_count")]
    public int PieceCount { get; set; }

    [JsonPropertyName("discarded")]
    public int Discarded { get; set; }
}

/// <summary>Cuerpo JSON del corte que Vectorify.Api le envía a Python (ya validado): mismos nombres que GeometrySplitRequest de Pydantic.</summary>
public sealed class PythonGeometrySplitRequestPayload
{
    [JsonPropertyName("subjects")]
    public List<PythonGeometryShapePayload> Subjects { get; set; } = [];

    [JsonPropertyName("cutter")]
    public PythonGeometryCutterPayload Cutter { get; set; } = new();

    [JsonPropertyName("mode")]
    public string Mode { get; set; } = string.Empty;

    [JsonPropertyName("slot_width")]
    public double SlotWidth { get; set; }

    [JsonPropertyName("extend")]
    public bool Extend { get; set; }

    [JsonPropertyName("tolerance")]
    public double Tolerance { get; set; }
}

public sealed class PythonGeometryCutterPayload
{
    [JsonPropertyName("points")]
    public double[][] Points { get; set; } = [];
}

// ---- Piezas flotantes y bridges (M3-S11) ----

/// <summary>Forma cruda (snake_case, tal como la serializa Pydantic) de la respuesta de POST /api/v1/geometry/floating del motor Python (M3-S11).</summary>
public sealed class PythonGeometryFloatingPayload
{
    [JsonPropertyName("mode")]
    public string? Mode { get; set; }

    [JsonPropertyName("tolerance")]
    public double Tolerance { get; set; }

    [JsonPropertyName("components")]
    public List<PythonFloatingComponentPayload>? Components { get; set; }

    [JsonPropertyName("floating_count")]
    public int FloatingCount { get; set; }

    [JsonPropertyName("main_count")]
    public int MainCount { get; set; }

    [JsonPropertyName("discarded")]
    public int Discarded { get; set; }
}

public sealed class PythonFloatingComponentPayload
{
    [JsonPropertyName("id")]
    public int Id { get; set; }

    [JsonPropertyName("kind")]
    public string? Kind { get; set; }

    [JsonPropertyName("depth")]
    public int Depth { get; set; }

    [JsonPropertyName("parent")]
    public int? Parent { get; set; }

    [JsonPropertyName("polygon")]
    public PythonGeometryPiecePayload? Polygon { get; set; }

    [JsonPropertyName("area")]
    public double? Area { get; set; }

    [JsonPropertyName("bounds")]
    public List<double>? Bounds { get; set; }

    [JsonPropertyName("subjects")]
    public List<int>? Subjects { get; set; }
}

/// <summary>Forma polygon con <c>locked</c>: lo que Vectorify.Api le envía a Python (ya validado).</summary>
public sealed class PythonFloatingSubjectPayload
{
    [JsonPropertyName("type")]
    public string Type { get; set; } = "polygon";

    [JsonPropertyName("coordinates")]
    public double[][][] Coordinates { get; set; } = [];

    [JsonPropertyName("locked")]
    public bool Locked { get; set; }
}

/// <summary>Cuerpo JSON del análisis que Vectorify.Api le envía a Python (ya validado): mismos nombres que GeometryFloatingRequest de Pydantic.</summary>
public sealed class PythonGeometryFloatingRequestPayload
{
    [JsonPropertyName("subjects")]
    public List<PythonFloatingSubjectPayload> Subjects { get; set; } = [];

    [JsonPropertyName("mode")]
    public string Mode { get; set; } = string.Empty;

    [JsonPropertyName("tolerance")]
    public double Tolerance { get; set; }
}

public sealed class PythonBridgePointPayload
{
    [JsonPropertyName("x")]
    public double X { get; set; }

    [JsonPropertyName("y")]
    public double Y { get; set; }
}

public sealed class PythonBridgeInputPayload
{
    [JsonPropertyName("island")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? Island { get; set; }

    [JsonPropertyName("anchor")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public PythonBridgePointPayload? Anchor { get; set; }

    [JsonPropertyName("direction")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public PythonBridgePointPayload? Direction { get; set; }

    [JsonPropertyName("width")]
    public double Width { get; set; }

    [JsonPropertyName("length")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public double? Length { get; set; }
}

/// <summary>Cuerpo JSON de los bridges que Vectorify.Api le envía a Python (ya validado): mismos nombres que GeometryBridgeRequest de Pydantic.</summary>
public sealed class PythonGeometryBridgeRequestPayload
{
    [JsonPropertyName("subjects")]
    public List<PythonFloatingSubjectPayload> Subjects { get; set; } = [];

    [JsonPropertyName("mode")]
    public string Mode { get; set; } = string.Empty;

    [JsonPropertyName("bridges")]
    public List<PythonBridgeInputPayload> Bridges { get; set; } = [];

    [JsonPropertyName("suggest")]
    public bool Suggest { get; set; }

    [JsonPropertyName("suggest_width")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public double? SuggestWidth { get; set; }

    [JsonPropertyName("tolerance")]
    public double Tolerance { get; set; }
}

/// <summary>Forma cruda (snake_case) de la respuesta de POST /api/v1/geometry/bridge del motor Python (M3-S11).</summary>
public sealed class PythonGeometryBridgePayload
{
    [JsonPropertyName("mode")]
    public string? Mode { get; set; }

    [JsonPropertyName("tolerance")]
    public double Tolerance { get; set; }

    [JsonPropertyName("bridges")]
    public List<PythonBridgeResultPayload>? Bridges { get; set; }

    [JsonPropertyName("results")]
    public List<PythonBridgeSubjectResultPayload>? Results { get; set; }

    [JsonPropertyName("reanalysis")]
    public PythonBridgeReanalysisPayload? Reanalysis { get; set; }

    [JsonPropertyName("piece_count")]
    public int PieceCount { get; set; }
}

public sealed class PythonBridgeResultPayload
{
    [JsonPropertyName("index")]
    public int Index { get; set; }

    [JsonPropertyName("suggested")]
    public bool Suggested { get; set; }

    [JsonPropertyName("valid")]
    public bool Valid { get; set; }

    [JsonPropertyName("reason")]
    public string? Reason { get; set; }

    [JsonPropertyName("island")]
    public int? Island { get; set; }

    [JsonPropertyName("anchor")]
    public PythonBridgePointPayload? Anchor { get; set; }

    [JsonPropertyName("direction")]
    public PythonBridgePointPayload? Direction { get; set; }

    [JsonPropertyName("width")]
    public double Width { get; set; }

    [JsonPropertyName("length")]
    public double? Length { get; set; }

    [JsonPropertyName("area")]
    public double? Area { get; set; }

    [JsonPropertyName("reduces")]
    public bool Reduces { get; set; }

    [JsonPropertyName("affects")]
    public List<int>? Affects { get; set; }

    [JsonPropertyName("polygon")]
    public PythonGeometryPiecePayload? Polygon { get; set; }
}

public sealed class PythonBridgeSubjectResultPayload
{
    [JsonPropertyName("subject_index")]
    public int SubjectIndex { get; set; }

    [JsonPropertyName("changed")]
    public bool Changed { get; set; }

    [JsonPropertyName("geometries")]
    public List<PythonGeometryPiecePayload>? Geometries { get; set; }
}

public sealed class PythonBridgeReanalysisPayload
{
    [JsonPropertyName("floating_before")]
    public int FloatingBefore { get; set; }

    [JsonPropertyName("floating_after")]
    public int FloatingAfter { get; set; }

    [JsonPropertyName("main_after")]
    public int MainAfter { get; set; }
}
