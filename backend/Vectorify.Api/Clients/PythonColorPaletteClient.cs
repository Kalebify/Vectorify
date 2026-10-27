using System.Net.Http.Headers;
using System.Text.Json;
using Microsoft.Extensions.Options;
using Vectorify.Api.ColorPalette;
using Vectorify.Api.Contracts;
using Vectorify.Api.Options;

namespace Vectorify.Api.Clients;

/// <summary>
/// Implementación de <see cref="IPythonColorPaletteClient"/> sobre un
/// HttpClient tipado propio (timeout: ColorPalette:TimeoutSeconds). Igual
/// que PythonSimplifyClient/PythonVectorizeClient, aplica defensa en
/// profundidad adicional sobre la respuesta de Python antes de confiar en
/// ella (Vectorify.Api nunca confía ciegamente en su caller, aunque Python ya
/// sanitice/valide del lado suyo).
/// </summary>
public sealed class PythonColorPaletteClient : IPythonColorPaletteClient
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private const string ExpectedContentType = "image/png";
    private const double PercentToleranceUnits = 0.01;

    private readonly HttpClient _httpClient;
    private readonly ILogger<PythonColorPaletteClient> _logger;

    public PythonColorPaletteClient(HttpClient httpClient, ILogger<PythonColorPaletteClient> logger)
    {
        _httpClient = httpClient;
        _logger = logger;
    }

    public async Task<PythonColorPaletteResult> DetectAsync(
        Stream imageContent,
        string contentType,
        string fileName,
        ColorPaletteParameters parameters,
        CancellationToken cancellationToken = default)
    {
        using var form = new MultipartFormDataContent();
        var fileContent = new StreamContent(imageContent);
        fileContent.Headers.ContentType = new MediaTypeHeaderValue(contentType);
        form.Add(fileContent, "file", fileName);

        var paramsJson = JsonSerializer.Serialize(
            new
            {
                tolerance = parameters.Tolerance,
                max_colors = parameters.MaxColors,
                tiny_area_ratio = parameters.TinyAreaRatio,
                grouping_style = parameters.GroupingStyle,
                target_families = parameters.TargetFamilies,
                grouping_strength = parameters.GroupingStrength,
            },
            JsonOptions);
        form.Add(new StringContent(paramsJson), "params");

        HttpResponseMessage response;
        try
        {
            response = await _httpClient.PostAsync("/api/v1/color-palette", form, cancellationToken);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            _logger.LogWarning(
                "Timeout al detectar la paleta de colores en el motor Python en {BaseAddress}", _httpClient.BaseAddress);
            return Failure(PythonColorPaletteState.Timeout, "Tiempo de espera agotado al detectar la paleta de colores.");
        }
        catch (HttpRequestException ex)
        {
            _logger.LogWarning(ex, "Motor Python no disponible en {BaseAddress}", _httpClient.BaseAddress);
            return Failure(PythonColorPaletteState.Unavailable, "No se pudo establecer conexión con el motor Python.");
        }

        using (response)
        {
            string body;
            try
            {
                body = await response.Content.ReadAsStringAsync(cancellationToken);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                return Failure(PythonColorPaletteState.Timeout, "Tiempo de espera agotado al leer la respuesta del motor Python.");
            }

            if (!response.IsSuccessStatusCode)
            {
                return MapErrorResponse(response.StatusCode, body);
            }

            PythonColorPalettePayload? payload;
            try
            {
                payload = JsonSerializer.Deserialize<PythonColorPalettePayload>(body, JsonOptions);
            }
            catch (JsonException ex)
            {
                _logger.LogWarning(ex, "Respuesta no-JSON del motor Python al detectar paleta de colores: {Body}", body);
                return Failure(PythonColorPaletteState.InvalidResponse, "La respuesta del motor Python no es un JSON válido.");
            }

            if (payload is null || payload.Width <= 0 || payload.Height <= 0
                || payload.Groups is null || payload.Metrics is null
                || string.IsNullOrEmpty(payload.QuantizedPreviewBase64))
            {
                _logger.LogWarning("Respuesta incompleta del motor Python al detectar paleta de colores: {Body}", body);
                return Failure(PythonColorPaletteState.InvalidResponse, "La respuesta del motor Python no contiene los campos esperados.");
            }

            if (!TryValidateAndConvert(payload, out var groups, out var previewBytes, out var validationError))
            {
                _logger.LogWarning(
                    "Respuesta de paleta de colores rechazada por validación defensiva adicional: {Reason}. Body: {Body}",
                    validationError,
                    body);
                return Failure(PythonColorPaletteState.InvalidPaletteResponse, validationError!);
            }

            return new PythonColorPaletteResult(
                PythonColorPaletteState.Success,
                payload.Width,
                payload.Height,
                payload.ContentType ?? "image/png",
                groups,
                payload.Metrics!.TransparentPercent,
                previewBytes,
                Message: null,
                Background: ToBackgroundInfo(payload.Metrics.Background),
                AlgorithmVersion: payload.AlgorithmVersion);
        }
    }

    /// <summary>
    /// Defensa en profundidad adicional (mismo criterio que
    /// PythonSimplifyClient.TryGetValidationFailureReason): decodifica cada
    /// máscara/preview base64 y valida que color_hex/porcentajes/Content-Type
    /// sean coherentes antes de confiar en la respuesta.
    /// </summary>
    private bool TryValidateAndConvert(
        PythonColorPalettePayload payload,
        out IReadOnlyList<PythonColorGroupResult>? groups,
        out byte[]? previewBytes,
        out string? reason)
    {
        groups = null;
        previewBytes = null;

        if (!string.Equals(payload.ContentType, ExpectedContentType, StringComparison.OrdinalIgnoreCase))
        {
            reason = $"El Content-Type devuelto por el motor Python no es '{ExpectedContentType}' (recibido: '{payload.ContentType ?? "(ausente)"}').";
            return false;
        }

        var transparentPercent = payload.Metrics!.TransparentPercent;
        if (double.IsNaN(transparentPercent) || double.IsInfinity(transparentPercent)
            || transparentPercent < 0 - PercentToleranceUnits || transparentPercent > 100 + PercentToleranceUnits)
        {
            reason = $"El % de transparencia devuelto por el motor Python está fuera de rango (0-100): {transparentPercent}.";
            return false;
        }

        try
        {
            previewBytes = Convert.FromBase64String(payload.QuantizedPreviewBase64!);
        }
        catch (FormatException)
        {
            reason = "El preview cuantizado devuelto por el motor Python no es base64 válido.";
            return false;
        }

        if (payload.Metrics!.ColorCount != payload.Groups!.Count)
        {
            reason = $"metrics.color_count ({payload.Metrics!.ColorCount}) no coincide con la cantidad de grupos devueltos ({payload.Groups!.Count}).";
            return false;
        }

        if (payload.Groups!.Count(g => g.IsBackground) > 1)
        {
            reason = "El motor Python devolvió más de un grupo de fondo.";
            return false;
        }

        var converted = new List<PythonColorGroupResult>(payload.Groups!.Count);
        foreach (var group in payload.Groups!)
        {
            if (!IsValidHexColor(group.ColorHex))
            {
                reason = $"color_hex inválido devuelto por el motor Python: '{group.ColorHex}'.";
                return false;
            }

            if (group.PixelCount < 0)
            {
                reason = $"pixel_count negativo devuelto por el motor Python para el grupo {group.Id}: {group.PixelCount}.";
                return false;
            }

            if (double.IsNaN(group.AreaPercent) || double.IsInfinity(group.AreaPercent)
                || group.AreaPercent < 0 - PercentToleranceUnits || group.AreaPercent > 100 + PercentToleranceUnits)
            {
                reason = $"area_percent fuera de rango (0-100) para el grupo {group.Id}: {group.AreaPercent}.";
                return false;
            }

            byte[] maskBytes;
            try
            {
                maskBytes = Convert.FromBase64String(group.MaskBase64 ?? string.Empty);
            }
            catch (FormatException)
            {
                reason = $"La máscara del grupo {group.Id} devuelta por el motor Python no es base64 válida.";
                return false;
            }

            if (maskBytes.Length == 0)
            {
                reason = $"La máscara del grupo {group.Id} devuelta por el motor Python está vacía.";
                return false;
            }

            if (group.PieceCount < 0 || group.SourceGroupCount < 1)
            {
                reason = $"piece_count/source_group_count inválidos devueltos por el motor Python para el grupo {group.Id}.";
                return false;
            }

            converted.Add(new PythonColorGroupResult(
                group.Id, group.ColorHex!, group.PixelCount, group.AreaPercent, group.HasPartialAlpha, group.TouchesBorder, maskBytes,
                group.IsBackground, group.PieceCount, group.SourceGroupCount));
        }

        groups = converted;
        reason = null;
        return true;
    }

    private static BackgroundInfo? ToBackgroundInfo(PythonBackgroundPayload? background) =>
        background is null
            ? null
            : new BackgroundInfo(background.AreaPercent, background.AmbiguousPercent, background.ContactPercent, background.NeedsReview);

    private static bool IsValidHexColor(string? colorHex)
    {
        if (string.IsNullOrEmpty(colorHex) || colorHex.Length != 7 || colorHex[0] != '#')
        {
            return false;
        }

        for (var i = 1; i < colorHex.Length; i++)
        {
            if (!Uri.IsHexDigit(colorHex[i]))
            {
                return false;
            }
        }

        return true;
    }

    private PythonColorPaletteResult MapErrorResponse(System.Net.HttpStatusCode statusCode, string body)
    {
        PythonErrorPayload? errorPayload;
        try
        {
            errorPayload = JsonSerializer.Deserialize<PythonErrorPayload>(body, JsonOptions);
        }
        catch (JsonException)
        {
            errorPayload = null;
        }

        var state = (errorPayload?.Code, (int)statusCode) switch
        {
            ("corrupt_image", _) => PythonColorPaletteState.CorruptImage,
            ("dimensions_exceeded", _) => PythonColorPaletteState.DimensionsExceeded,
            ("invalid_parameters", _) => PythonColorPaletteState.InvalidParameters,
            ("color_palette_timeout", _) => PythonColorPaletteState.Timeout,
            (_, 400) => PythonColorPaletteState.CorruptImage,
            (_, 413) => PythonColorPaletteState.DimensionsExceeded,
            (_, 422) => PythonColorPaletteState.InvalidParameters,
            (_, 504) => PythonColorPaletteState.Timeout,
            _ => PythonColorPaletteState.HttpError,
        };

        var message = errorPayload?.Message ?? $"El motor Python respondió con código HTTP {(int)statusCode}.";

        if (state == PythonColorPaletteState.HttpError)
        {
            _logger.LogWarning("El motor Python respondió con código {StatusCode} al detectar paleta de colores", (int)statusCode);
        }

        return Failure(state, message);
    }

    private static PythonColorPaletteResult Failure(PythonColorPaletteState state, string message) =>
        new(state, null, null, null, null, null, null, message);
}
