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
}
