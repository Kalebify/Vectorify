using System.Globalization;
using System.Text.Json;
using Vectorify.Api.Contracts;

namespace Vectorify.Api.Tests.TestSupport;

/// <summary>
/// Cuerpos JSON del servicio de geometría (M3-S04, M3-S09, M3-S10, M3-S11): peticiones del cliente (camelCase, como las manda el editor) y
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

    // ---- Corte (M3-S10) ----

    /// <summary>Línea de corte vertical por el centro del cuadrado de 40 (x = 20), de un extremo al otro.</summary>
    public const string Cutter = "{\"points\":[[20,-5],[20,45]]}";

    /// <summary>Petición de corte válida por defecto: el cuadrado de 40 dividido por x = 20 (modo dividir, sin extender).</summary>
    public static string SplitRequest(
        string subjects = Square40,
        string cutter = Cutter,
        string mode = "split",
        string slotWidth = "0",
        string extend = "false",
        string tolerance = "0.01") =>
        $$"""{"subjects":[{{subjects}}],"cutter":{{cutter}},"mode":"{{mode}}","slotWidth":{{slotWidth}},"extend":{{extend}},"tolerance":{{tolerance}}}""";

    public static GeometrySplitRequest ParseSplit(string json) =>
        JsonSerializer.Deserialize<GeometrySplitRequest>(json, new JsonSerializerOptions(JsonSerializerDefaults.Web))!;

    public const string LeftHalf = """{"type":"polygon","coordinates":[[[0,0],[20,0],[20,40],[0,40],[0,0]]]}""";
    public const string RightHalf = """{"type":"polygon","coordinates":[[[20,0],[40,0],[40,40],[20,40],[20,0]]]}""";
    public const string WholeSquare = """{"type":"polygon","coordinates":[[[0,0],[40,0],[40,40],[0,40],[0,0]]]}""";

    /// <summary>
    /// Un resultado de corte de Python (snake_case). Por defecto `changed` es verdadero si hay >= 2 piezas, `touched` si cambió y
    /// `piece_count` la cantidad de piezas, que es lo coherente; cada test los pisa para fabricar respuestas mentirosas.
    /// </summary>
    public static string SplitResult(
        int subjectIndex,
        string piecesJson,
        bool? changed = null,
        bool? touched = null,
        int? pieceCount = null,
        int discarded = 0)
    {
        var pieces = PieceCountOf(piecesJson);
        var isChanged = changed ?? pieces >= 2;
        return string.Create(
            CultureInfo.InvariantCulture,
            $$"""{"subject_index":{{subjectIndex}},"changed":{{isChanged.ToString().ToLowerInvariant()}},"touched":{{(touched ?? isChanged).ToString().ToLowerInvariant()}},"pieces":{{piecesJson}},"piece_count":{{pieceCount ?? pieces}},"discarded":{{discarded}}}""");
    }

    public static string SplitResponse(
        string resultsJson,
        int pieceCount,
        string mode = "split",
        double slotWidth = 0,
        bool extend = false,
        double tolerance = 0.01) =>
        string.Create(
            CultureInfo.InvariantCulture,
            $$"""{"mode":"{{mode}}","slot_width":{{slotWidth}},"extend":{{extend.ToString().ToLowerInvariant()}},"tolerance":{{tolerance}},"results":[{{resultsJson}}],"piece_count":{{pieceCount}}}""");

    /// <summary>Respuesta cruda de Python para el corte por defecto: el cuadrado de 40 partido en dos mitades de 20 x 40.</summary>
    public static string HalvesSplitResponse() =>
        SplitResponse(SplitResult(0, $"[{LeftHalf},{RightHalf}]"), pieceCount: 2);

    // ---- Piezas flotantes y bridges (M3-S11) ----

    /// <summary>Anillo cuadrado de 20 con hueco de 10 centrado (espesor 5): como corte (stencil) su isla es el cuadrado 5..15.</summary>
    public const string RingPolygon = """{"type":"polygon","coordinates":[[[0,0],[20,0],[20,20],[0,20]],[[5,5],[15,5],[15,15],[5,15]]]}""";

    public const string DotPolygon = """{"type":"polygon","coordinates":[[[8,8],[12,8],[12,12],[8,12]]]}""";

    /// <summary>Petición de análisis válida por defecto: el anillo como plantilla (1 isla).</summary>
    public static string FloatingRequest(string subjects = RingPolygon, string mode = "stencil", string tolerance = "0.01") =>
        $$"""{"subjects":[{{subjects}}],"mode":"{{mode}}","tolerance":{{tolerance}}}""";

    public static GeometryFloatingRequest ParseFloating(string json) =>
        JsonSerializer.Deserialize<GeometryFloatingRequest>(json, new JsonSerializerOptions(JsonSerializerDefaults.Web))!;

    public const string DefaultBridge = """{"island":1,"width":0.8}""";

    /// <summary>Petición de bridges válida por defecto: un bridge de 0,8 sobre la isla 1 del anillo.</summary>
    public static string BridgeRequest(
        string subjects = RingPolygon,
        string mode = "stencil",
        string bridges = DefaultBridge,
        string suggest = "false",
        string suggestWidth = "null",
        string tolerance = "0.01") =>
        $$"""{"subjects":[{{subjects}}],"mode":"{{mode}}","bridges":[{{bridges}}],"suggest":{{suggest}},"suggestWidth":{{suggestWidth}},"tolerance":{{tolerance}}}""";

    public static GeometryBridgeRequest ParseBridge(string json) =>
        JsonSerializer.Deserialize<GeometryBridgeRequest>(json, new JsonSerializerOptions(JsonSerializerDefaults.Web))!;

    public const string SheetComponent = """{"id":0,"kind":"principal","depth":0,"parent":null,"polygon":null,"area":null,"bounds":[0,0,20,20],"subjects":[]}""";

    public const string IslandComponent =
        """{"id":1,"kind":"floating","depth":1,"parent":0,"polygon":{"type":"polygon","coordinates":[[[5,5],[15,5],[15,15],[5,15],[5,5]]]},"area":100,"bounds":[5,5,15,15],"subjects":[0]}""";

    /// <summary>Respuesta cruda de Python del análisis en modo `parts` sin flotantes: un solo cuerpo principal, que sí trae polígono.</summary>
    public static string PartsResponse() =>
        FloatingResponse(
            """{"id":0,"kind":"principal","depth":0,"parent":null,"polygon":{"type":"polygon","coordinates":[[[0,0],[10,0],[10,10],[0,0]]]},"area":50,"bounds":[0,0,10,10],"subjects":[0]}""",
            floatingCount: 0,
            mainCount: 1,
            mode: "parts");

    /// <summary>Respuesta cruda de Python (snake_case) del análisis: por defecto la hoja y la isla del anillo.</summary>
    public static string FloatingResponse(
        string componentsJson = SheetComponent + "," + IslandComponent,
        int floatingCount = 1,
        int mainCount = 1,
        int discarded = 0,
        string mode = "stencil",
        double tolerance = 0.01) =>
        string.Create(
            CultureInfo.InvariantCulture,
            $$"""{"mode":"{{mode}}","tolerance":{{tolerance}},"components":[{{componentsJson}}],"floating_count":{{floatingCount}},"main_count":{{mainCount}},"discarded":{{discarded}}}""");

    /// <summary>El rectángulo de un bridge de 0,8 de ancho que cruza el espesor de 5 del anillo, con 0,02 de solape a cada lado.</summary>
    public const string BridgeRectangle = """{"type":"polygon","coordinates":[[[14.98,9.6],[20.02,9.6],[20.02,10.4],[14.98,10.4],[14.98,9.6]]]}""";

    /// <summary>El anillo con el puente abierto (una "C"): lo que queda del corte tras restar el bridge.</summary>
    public const string OpenedRing =
        """{"type":"polygon","coordinates":[[[0,0],[20,0],[20,9.6],[15,9.6],[15,5],[5,5],[5,15],[15,15],[15,10.4],[20,10.4],[20,20],[0,20],[0,0]]]}""";

    /// <summary>Un resultado de bridge de Python (snake_case); por defecto uno válido, perpendicular al borde derecho de la isla, que cruza 5 y quita 0,8 x 5 = 4.</summary>
    public static string BridgeItem(
        int index = 0,
        bool suggested = false,
        bool valid = true,
        string? reason = null,
        string island = "1",
        string anchor = """{"x":15,"y":10}""",
        string direction = """{"x":1,"y":0}""",
        double width = 0.8,
        string length = "5",
        string area = "4",
        bool reduces = true,
        string affects = "[0]",
        string polygon = BridgeRectangle)
    {
        var reasonJson = reason is null ? "null" : $"\"{reason}\"";
        return string.Create(
            CultureInfo.InvariantCulture,
            $$"""{"index":{{index}},"suggested":{{suggested.ToString().ToLowerInvariant()}},"valid":{{valid.ToString().ToLowerInvariant()}},"reason":{{reasonJson}},"island":{{island}},"anchor":{{anchor}},"direction":{{direction}},"width":{{width}},"length":{{length}},"area":{{area}},"reduces":{{reduces.ToString().ToLowerInvariant()}},"affects":{{affects}},"polygon":{{polygon}}}""");
    }

    public static string BridgeSubjectResult(int subjectIndex, bool changed, string geometriesJson) =>
        string.Create(
            CultureInfo.InvariantCulture,
            $$"""{"subject_index":{{subjectIndex}},"changed":{{changed.ToString().ToLowerInvariant()}},"geometries":{{geometriesJson}}}""");

    /// <summary>Respuesta cruda de Python (snake_case) de los bridges: por defecto un bridge válido, el anillo abierto y el reanálisis 1 -> 0.</summary>
    public static string BridgeResponse(
        string? bridgesJson = null,
        string? resultsJson = null,
        int floatingBefore = 1,
        int floatingAfter = 0,
        int mainAfter = 1,
        int pieceCount = 1,
        string mode = "stencil",
        double tolerance = 0.01) =>
        string.Create(
            CultureInfo.InvariantCulture,
            $$"""{"mode":"{{mode}}","tolerance":{{tolerance}},"bridges":[{{bridgesJson ?? BridgeItem()}}],"results":[{{resultsJson ?? BridgeSubjectResult(0, true, $"[{OpenedRing}]")}}],"reanalysis":{"floating_before":{{floatingBefore}},"floating_after":{{floatingAfter}},"main_after":{{mainAfter}}},"piece_count":{{pieceCount}}}""");
}
