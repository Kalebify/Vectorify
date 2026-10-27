using System.Text.Json.Serialization;

namespace Vectorify.Api.Contracts;

/// <summary>
/// Forma cruda (snake_case, tal como la serializa Pydantic) de la respuesta de
/// POST /api/v1/color-palette del motor Python/FastAPI.
/// </summary>
public sealed class PythonColorPalettePayload
{
    [JsonPropertyName("width")]
    public int Width { get; set; }

    [JsonPropertyName("height")]
    public int Height { get; set; }

    [JsonPropertyName("content_type")]
    public string? ContentType { get; set; }

    [JsonPropertyName("effective_params")]
    public PythonColorPaletteParamsPayload? EffectiveParams { get; set; }

    [JsonPropertyName("metrics")]
    public PythonColorPaletteMetricsPayload? Metrics { get; set; }

    [JsonPropertyName("groups")]
    public List<PythonColorGroupPayload>? Groups { get; set; }

    [JsonPropertyName("quantized_preview_base64")]
    public string? QuantizedPreviewBase64 { get; set; }

    /// <summary>Ausente en motores anteriores a la agrupación por familias: 0 = sin versión.</summary>
    [JsonPropertyName("algorithm_version")]
    public int AlgorithmVersion { get; set; }
}

public sealed class PythonColorPaletteParamsPayload
{
    [JsonPropertyName("tolerance")]
    public double Tolerance { get; set; }

    [JsonPropertyName("max_colors")]
    public int? MaxColors { get; set; }

    [JsonPropertyName("tiny_area_ratio")]
    public double TinyAreaRatio { get; set; }

    [JsonPropertyName("grouping_style")]
    public string? GroupingStyle { get; set; }

    [JsonPropertyName("target_families")]
    public int? TargetFamilies { get; set; }

    [JsonPropertyName("grouping_strength")]
    public double? GroupingStrength { get; set; }
}

public sealed class PythonColorPaletteMetricsPayload
{
    [JsonPropertyName("color_count")]
    public int ColorCount { get; set; }

    [JsonPropertyName("transparent_percent")]
    public double TransparentPercent { get; set; }

    [JsonPropertyName("family_count")]
    public int? FamilyCount { get; set; }

    [JsonPropertyName("piece_count")]
    public int? PieceCount { get; set; }

    [JsonPropertyName("background")]
    public PythonBackgroundPayload? Background { get; set; }
}

public sealed class PythonBackgroundPayload
{
    [JsonPropertyName("pixel_count")]
    public long PixelCount { get; set; }

    [JsonPropertyName("area_percent")]
    public double AreaPercent { get; set; }

    [JsonPropertyName("ambiguous_percent")]
    public double AmbiguousPercent { get; set; }

    [JsonPropertyName("contact_percent")]
    public double ContactPercent { get; set; }

    [JsonPropertyName("needs_review")]
    public bool NeedsReview { get; set; }
}

public sealed class PythonColorGroupPayload
{
    [JsonPropertyName("id")]
    public int Id { get; set; }

    [JsonPropertyName("color_hex")]
    public string? ColorHex { get; set; }

    [JsonPropertyName("pixel_count")]
    public long PixelCount { get; set; }

    [JsonPropertyName("area_percent")]
    public double AreaPercent { get; set; }

    [JsonPropertyName("has_partial_alpha")]
    public bool HasPartialAlpha { get; set; }

    [JsonPropertyName("touches_border")]
    public bool TouchesBorder { get; set; }

    [JsonPropertyName("mask_base64")]
    public string? MaskBase64 { get; set; }

    [JsonPropertyName("is_background")]
    public bool IsBackground { get; set; }

    [JsonPropertyName("source_group_count")]
    public int SourceGroupCount { get; set; } = 1;

    [JsonPropertyName("piece_count")]
    public int PieceCount { get; set; }
}
