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
