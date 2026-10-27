namespace Vectorify.Api.Tests.TestSupport;

/// <summary>Cuerpos JSON crudos (snake_case, como los devuelve Pydantic) para simular al motor Python en tests de paleta de colores.</summary>
internal static class ColorPalettePayloads
{
    /// <summary>Base64 de un PNG 1x1 válido (mismos bytes que SampleImages.ValidPng1x1).</summary>
    private const string TinyPngBase64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

    public static string SuccessBody(
        int width = 1,
        int height = 1,
        double tolerance = 12.0,
        int? maxColors = null,
        double transparentPercent = 0.0,
        bool touchesBorder = false)
    {
        var maxColorsJson = maxColors.HasValue ? maxColors.Value.ToString() : "null";
        var touchesBorderJson = touchesBorder ? "true" : "false";

        return string.Create(
            System.Globalization.CultureInfo.InvariantCulture,
            $$"""
            {
              "width": {{width}},
              "height": {{height}},
              "content_type": "image/png",
              "effective_params": {
                "tolerance": {{tolerance}},
                "max_colors": {{maxColorsJson}},
                "tiny_area_ratio": 0.001
              },
              "metrics": {
                "color_count": 1,
                "transparent_percent": {{transparentPercent}}
              },
              "groups": [
                {
                  "id": 0,
                  "color_hex": "#3a6ea5",
                  "pixel_count": 4,
                  "area_percent": 100.0,
                  "has_partial_alpha": false,
                  "touches_border": {{touchesBorderJson}},
                  "mask_base64": "{{TinyPngBase64}}"
                }
              ],
              "quantized_preview_base64": "{{TinyPngBase64}}"
            }
            """);
    }

    public static string ErrorBody(string code, string message) =>
        $$"""{"code": "{{code}}", "message": "{{message}}"}""";

    /// <summary>
    /// Paleta con VARIOS grupos de color (M2.2-S05, "Documento multicolor"), ninguno
    /// pre-excluido (<c>touches_border: false</c> para todos) para no tener que lidiar con el
    /// heurístico de "fondo dominante" en tests que no lo necesitan. Área repartida en partes
    /// iguales entre los colores dados.
    /// </summary>
    public static string MultiGroupSuccessBody(int width, int height, params string[] colorHexes)
    {
        var areaPercentPerGroup = 100.0 / colorHexes.Length;
        var groups = string.Join(",", colorHexes.Select((hex, index) => string.Create(
            System.Globalization.CultureInfo.InvariantCulture,
            $$"""
            {
              "id": {{index}},
              "color_hex": "{{hex}}",
              "pixel_count": 4,
              "area_percent": {{areaPercentPerGroup}},
              "has_partial_alpha": false,
              "touches_border": false,
              "mask_base64": "{{TinyPngBase64}}"
            }
            """)));

        return string.Create(
            System.Globalization.CultureInfo.InvariantCulture,
            $$"""
            {
              "width": {{width}},
              "height": {{height}},
              "content_type": "image/png",
              "effective_params": { "tolerance": 12.0, "max_colors": null, "tiny_area_ratio": 0.001 },
              "metrics": { "color_count": {{colorHexes.Length}}, "transparent_percent": 0.0 },
              "groups": [{{groups}}],
              "quantized_preview_base64": "{{TinyPngBase64}}"
            }
            """);
    }

    /// <summary>
    /// Respuesta del estilo <c>base_colors</c> (agrupación por familias): dos familias del dibujo y el
    /// grupo técnico de fondo (último, <c>is_background</c>), con el bloque de revisión del fondo.
    /// </summary>
    public static string FamiliesBody(int width = 1, int height = 1, bool needsReview = true, int algorithmVersion = 1) =>
        string.Create(
            System.Globalization.CultureInfo.InvariantCulture,
            $$"""
            {
              "width": {{width}},
              "height": {{height}},
              "content_type": "image/png",
              "effective_params": {
                "tolerance": 12.0, "max_colors": null, "tiny_area_ratio": 0.001,
                "grouping_style": "base_colors", "target_families": 5, "grouping_strength": 0.5
              },
              "algorithm_version": {{algorithmVersion}},
              "metrics": {
                "color_count": 3, "transparent_percent": 0.0, "family_count": 2, "piece_count": 4,
                "background": {
                  "pixel_count": 6, "area_percent": 60.0, "ambiguous_pixel_count": 0, "ambiguous_percent": 0.0,
                  "contact_pixel_count": 2, "contact_percent": 20.0, "needs_review": {{(needsReview ? "true" : "false")}}
                }
              },
              "groups": [
                { "id": 0, "color_hex": "#c8551f", "pixel_count": 3, "area_percent": 30.0, "has_partial_alpha": false,
                  "touches_border": false, "mask_base64": "{{TinyPngBase64}}", "is_background": false, "source_group_count": 11, "piece_count": 3 },
                { "id": 1, "color_hex": "#bea90e", "pixel_count": 1, "area_percent": 10.0, "has_partial_alpha": false,
                  "touches_border": false, "mask_base64": "{{TinyPngBase64}}", "is_background": false, "source_group_count": 9, "piece_count": 1 },
                { "id": 2, "color_hex": "#ffffff", "pixel_count": 6, "area_percent": 60.0, "has_partial_alpha": false,
                  "touches_border": true, "mask_base64": "{{TinyPngBase64}}", "is_background": true, "source_group_count": 1, "piece_count": 1 }
              ],
              "quantized_preview_base64": "{{TinyPngBase64}}"
            }
            """);
}
