using System.Globalization;
using System.Text.Json;
using Vectorify.Api.Contracts;

namespace Vectorify.Api.Tests.TestSupport;

/// <summary>
/// Cuerpos JSON del servicio de geometría (M3-S04): peticiones del cliente (camelCase, como las manda el editor) y
/// respuestas crudas de Python (snake_case, como las serializa Pydantic) para simular al motor en los tests.
/// </summary>
internal static class GeometryPayloads
{
    public const string Square40 = "{\"type\":\"polygon\",\"coordinates\":[[[0,0],[40,0],[40,40],[0,40]]]}";
    public const string Brush = "{\"type\":\"bufferedLine\",\"points\":[[-10,20],[50,20]],\"radius\":5}";
    public const string Line = "{\"type\":\"line\",\"coordinates\":[[0,20],[40,20]]}";

    /// <summary>Petición válida por defecto: el cuadrado de 40 menos un pincel horizontal.</summary>
    public static string Request(
        string operation = "difference",
        string subjects = Square40,
        string operands = Brush,
        string tolerance = "0.01") =>
        $$"""{"operation":"{{operation}}","subjects":[{{subjects}}],"operands":[{{operands}}],"tolerance":{{tolerance}}}""";

    public static GeometryBooleanRequest Parse(string json) =>
        JsonSerializer.Deserialize<GeometryBooleanRequest>(json, new JsonSerializerOptions(JsonSerializerDefaults.Web))!;

    public static JsonElement Element(string json) => JsonDocument.Parse(json).RootElement.Clone();

    /// <summary>Respuesta de Python para el caso por defecto: el cuadrado partido en dos piezas de 40 x 15.</summary>
    public static string SplitSquareResponse(string operation = "difference", string scope = "per_subject", int? pieceCount = null) =>
        Response(
            operation,
            scope,
            """
            [{"subject_index":0,"changed":true,"geometries":[
              {"type":"polygon","coordinates":[[[0,0],[40,0],[40,15],[0,15],[0,0]]]},
              {"type":"polygon","coordinates":[[[0,25],[40,25],[40,40],[0,40],[0,25]]]}
            ]}]
            """,
            pieceCount ?? 2);

    public static string Response(string operation, string scope, string resultsJson, int pieceCount, double tolerance = 0.01) =>
        string.Create(
            CultureInfo.InvariantCulture,
            $$"""{"operation":"{{operation}}","scope":"{{scope}}","tolerance":{{tolerance}},"results":{{resultsJson}},"piece_count":{{pieceCount}}}""");

    public static string ErrorBody(string code, string message) => $$"""{"code":"{{code}}","message":"{{message}}"}""";

    // ---- Offset (M3-S09) ----

    /// <summary>Petición de offset válida por defecto: el cuadrado de 40 desplazado 3 hacia afuera con inglete (límite 2).</summary>
    public static string OffsetRequest(
        string subjects = Square40,
        string distance = "3",
        string joinStyle = "mitre",
        string mitreLimit = "2",
        string capStyle = "round",
        string tolerance = "0.01") =>
        $$"""{"subjects":[{{subjects}}],"distance":{{distance}},"joinStyle":"{{joinStyle}}","mitreLimit":{{mitreLimit}},"capStyle":"{{capStyle}}","tolerance":{{tolerance}}}""";

    public static GeometryOffsetRequest ParseOffset(string json) =>
        JsonSerializer.Deserialize<GeometryOffsetRequest>(json, new JsonSerializerOptions(JsonSerializerDefaults.Web))!;

    /// <summary>Respuesta cruda de Python (snake_case) para el offset por defecto: el cuadrado de 40 agrandado a 46 x 46.</summary>
    public static string GrownSquareOffsetResponse() =>
        OffsetResponse(
            OffsetResult(0, """[{"type":"polygon","coordinates":[[[-3,-3],[43,-3],[43,43],[-3,43],[-3,-3]]]}]""", maxInward: "20"),
            pieceCount: 1);

    /// <summary>Un resultado de offset de Python (snake_case) con los conteos por defecto de un cuadrado sin colapso, huecos ni división.</summary>
    public static string OffsetResult(
        int subjectIndex,
        string geometriesJson,
        bool? collapsed = null,
        int piecesBefore = 1,
        int? splitCount = null,
        int lostPieces = 0,
        int holesBefore = 0,
        int holesAfter = 0,
        string maxInward = "20")
    {
        var isCollapsed = (collapsed ?? PieceCountOf(geometriesJson) == 0).ToString().ToLowerInvariant();
        var pieces = splitCount ?? PieceCountOf(geometriesJson);
        return string.Create(
            CultureInfo.InvariantCulture,
            $$"""{"subject_index":{{subjectIndex}},"geometries":{{geometriesJson}},"collapsed":{{isCollapsed}},"pieces_before":{{piecesBefore}},"split_count":{{pieces}},"lost_pieces":{{lostPieces}},"holes_before":{{holesBefore}},"holes_after":{{holesAfter}},"max_inward_offset":{{maxInward}}}""");
    }

    private static int PieceCountOf(string geometriesJson) => JsonDocument.Parse(geometriesJson).RootElement.GetArrayLength();

    public static string OffsetResponse(
        string resultsJson,
        int pieceCount,
        double distance = 3,
        string joinStyle = "mitre",
        double mitreLimit = 2,
        string capStyle = "round",
        double tolerance = 0.01) =>
        string.Create(
            CultureInfo.InvariantCulture,
            $$"""{"distance":{{distance}},"join_style":"{{joinStyle}}","mitre_limit":{{mitreLimit}},"cap_style":"{{capStyle}}","tolerance":{{tolerance}},"results":[{{resultsJson}}],"piece_count":{{pieceCount}}}""");
}
