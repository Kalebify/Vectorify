using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Xml.Linq;
using Microsoft.Extensions.Options;
using Vectorify.Api.Contracts;
using Vectorify.Api.Options;
using Vectorify.Api.VectorLayers;
using Vectorify.Api.Vectorization;

namespace Vectorify.Api.Clients;

/// <summary>
/// Implementación de <see cref="IPythonVectorLayerClient"/> sobre un
/// HttpClient tipado propio (timeout: VectorLayer:TimeoutSeconds). Igual
/// criterio que PythonVectorizeClient: defensa en profundidad adicional
/// sobre la respuesta de Python antes de confiar en ella, más una validación
/// propia de este endpoint batch -- la cantidad de capas devueltas y sus
/// group_id deben coincidir exactamente con las máscaras enviadas.
/// </summary>
public sealed class PythonVectorLayerClient : IPythonVectorLayerClient
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private const double BoundsToleranceUnits = 0.01;
    private const string ExpectedContentType = "image/svg+xml";

    private readonly HttpClient _httpClient;
    private readonly ILogger<PythonVectorLayerClient> _logger;
    private readonly int _maxSvgResponseBytes;

    public PythonVectorLayerClient(HttpClient httpClient, IOptions<VectorLayerOptions> options, ILogger<PythonVectorLayerClient> logger)
    {
        _httpClient = httpClient;
        _logger = logger;
        _maxSvgResponseBytes = options.Value.MaxSvgResponseBytes;
    }

    public async Task<PythonVectorLayerBatchResult> VectorizeLayersAsync(
        IReadOnlyList<(Guid GroupId, Stream Content, string ContentType)> masks,
        bool sharedBoundaries = false,
        CancellationToken cancellationToken = default)
    {
        using var form = new MultipartFormDataContent();
        foreach (var (groupId, content, contentType) in masks)
        {
            var fileContent = new StreamContent(content);
            fileContent.Headers.ContentType = new MediaTypeHeaderValue(contentType);
            form.Add(fileContent, "files", $"{groupId:N}.png");
        }

        var groupIdsJson = JsonSerializer.Serialize(masks.Select(m => m.GroupId.ToString("N")).ToList(), JsonOptions);
        form.Add(new StringContent(groupIdsJson), "group_ids");
        if (sharedBoundaries)
        {
            form.Add(new StringContent("true"), "shared_boundaries");
        }

        HttpResponseMessage response;
        try
        {
            response = await _httpClient.PostAsync("/api/v1/vectorize-layers", form, cancellationToken);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            _logger.LogWarning(
                "Timeout al vectorizar el conjunto de capas en el motor Python en {BaseAddress}", _httpClient.BaseAddress);
            return Failure(PythonVectorLayerState.Timeout, "Tiempo de espera agotado al vectorizar el conjunto de capas.");
        }
        catch (HttpRequestException ex)
        {
            _logger.LogWarning(ex, "Motor Python no disponible en {BaseAddress}", _httpClient.BaseAddress);
            return Failure(PythonVectorLayerState.Unavailable, "No se pudo establecer conexión con el motor Python.");
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
                return Failure(PythonVectorLayerState.Timeout, "Tiempo de espera agotado al leer la respuesta del motor Python.");
            }

            if (!response.IsSuccessStatusCode)
            {
                return MapErrorResponse(response.StatusCode, body);
            }

            PythonVectorizeLayersPayload? payload;
            try
            {
                payload = JsonSerializer.Deserialize<PythonVectorizeLayersPayload>(body, JsonOptions);
            }
            catch (JsonException ex)
            {
                _logger.LogWarning(ex, "Respuesta no-JSON del motor Python al vectorizar el conjunto de capas: {Body}", body);
                return Failure(PythonVectorLayerState.InvalidResponse, "La respuesta del motor Python no es un JSON válido.");
            }

            if (payload?.Layers is null)
            {
                _logger.LogWarning("Respuesta incompleta del motor Python al vectorizar el conjunto de capas: {Body}", body);
                return Failure(PythonVectorLayerState.InvalidResponse, "La respuesta del motor Python no contiene los campos esperados.");
            }

            if (!TryValidateAndConvert(masks, payload.Layers, out var layers, out var validationError))
            {
                _logger.LogWarning(
                    "Respuesta de vectorización de capas rechazada por validación defensiva adicional: {Reason}. Body: {Body}",
                    validationError,
                    body);
                return Failure(PythonVectorLayerState.InvalidSvg, validationError!);
            }

            return new PythonVectorLayerBatchResult(PythonVectorLayerState.Success, layers, Message: null);
        }
    }

    /// <summary>
    /// Defensa en profundidad adicional (mismo criterio que
    /// PythonVectorizeClient.TryGetValidationFailureReason), más la
    /// invariante propia de este endpoint batch: la cantidad de capas
    /// devueltas debe coincidir con la cantidad de máscaras enviadas y cada
    /// group_id devuelto debe corresponder a exactamente una de ellas (sin
    /// repetidos, sin desconocidos).
    /// </summary>
    private bool TryValidateAndConvert(
        IReadOnlyList<(Guid GroupId, Stream Content, string ContentType)> masks,
        List<PythonVectorLayerItemPayload> payloadLayers,
        out IReadOnlyList<PythonVectorLayerItemResult>? layers,
        out string? reason)
    {
        layers = null;

        if (payloadLayers.Count != masks.Count)
        {
            reason = $"La cantidad de capas devueltas por el motor Python ({payloadLayers.Count}) no coincide con la cantidad de máscaras enviadas ({masks.Count}).";
            return false;
        }

        var pendingGroupIds = masks.Select(m => m.GroupId).ToHashSet();
        var converted = new List<PythonVectorLayerItemResult>(payloadLayers.Count);

        foreach (var item in payloadLayers)
        {
            if (!Guid.TryParseExact(item.GroupId, "N", out var groupId) || !pendingGroupIds.Remove(groupId))
            {
                reason = $"group_id devuelto por el motor Python no coincide con ninguna máscara enviada: '{item.GroupId ?? "(ausente)"}'.";
                return false;
            }

            if (string.IsNullOrEmpty(item.Svg) || item.Metrics?.Bounds is null)
            {
                reason = $"La capa del grupo {groupId:N} no contiene los campos esperados.";
                return false;
            }

            var svgByteCount = Encoding.UTF8.GetByteCount(item.Svg);
            if (svgByteCount > _maxSvgResponseBytes)
            {
                reason = $"El SVG de la capa {groupId:N} ({svgByteCount} bytes) supera el límite permitido ({_maxSvgResponseBytes} bytes).";
                return false;
            }

            try
            {
                var parsed = XDocument.Parse(item.Svg);
                if (parsed.Root is null || !string.Equals(parsed.Root.Name.LocalName, "svg", StringComparison.OrdinalIgnoreCase))
                {
                    reason = $"El SVG de la capa {groupId:N} no tiene un elemento <svg> como raíz.";
                    return false;
                }
            }
            catch (System.Xml.XmlException ex)
            {
                reason = $"El SVG de la capa {groupId:N} no es XML bien formado: {ex.Message}";
                return false;
            }

            if (item.Width <= 0 || item.Height <= 0)
            {
                reason = $"Las dimensiones devueltas por el motor Python para la capa {groupId:N} no son positivas (width={item.Width}, height={item.Height}).";
                return false;
            }

            var metrics = item.Metrics!;
            if (metrics.PathCount < 0 || metrics.ApproxNodeCount < 0)
            {
                reason = $"Las métricas devueltas por el motor Python para la capa {groupId:N} son negativas.";
                return false;
            }

            var bounds = metrics.Bounds!;
            var boundsValues = new[] { bounds.MinX, bounds.MinY, bounds.MaxX, bounds.MaxY, bounds.Width, bounds.Height };
            if (boundsValues.Any(v => double.IsNaN(v) || double.IsInfinity(v)))
            {
                reason = $"Los bounds devueltos por el motor Python para la capa {groupId:N} contienen valores no finitos (NaN/Infinity).";
                return false;
            }

            if (bounds.MaxX < bounds.MinX || bounds.MaxY < bounds.MinY)
            {
                reason = $"Los bounds devueltos por el motor Python para la capa {groupId:N} son incoherentes (max < min).";
                return false;
            }

            if (Math.Abs((bounds.MaxX - bounds.MinX) - bounds.Width) > BoundsToleranceUnits
                || Math.Abs((bounds.MaxY - bounds.MinY) - bounds.Height) > BoundsToleranceUnits)
            {
                reason = $"Los bounds devueltos por el motor Python para la capa {groupId:N} son incoherentes: width/height no coinciden con max-min.";
                return false;
            }

            if (!string.Equals(item.ContentType, ExpectedContentType, StringComparison.OrdinalIgnoreCase))
            {
                reason = $"El Content-Type devuelto por el motor Python para la capa {groupId:N} no es '{ExpectedContentType}' (recibido: '{item.ContentType ?? "(ausente)"}').";
                return false;
            }

            if (!TryConvertRasterValidation(groupId, item.RasterValidation, out var rasterValidation, out reason))
            {
                return false;
            }

            converted.Add(new PythonVectorLayerItemResult(
                groupId,
                item.Svg,
                item.ContentType!,
                item.Width,
                item.Height,
                new VectorMetrics(
                    metrics.PathCount,
                    metrics.ApproxNodeCount,
                    new VectorBounds(bounds.MinX, bounds.MinY, bounds.MaxX, bounds.MaxY, bounds.Width, bounds.Height)),
                rasterValidation!));
        }

        layers = converted;
        reason = null;
        return true;
    }

    /// <summary>
    /// Defensa en profundidad adicional (M2.1-S03) sobre `raster_validation`:
    /// debe estar presente (Python SIEMPRE lo calcula desde que esta tarjeta
    /// existe) y sus ratios/tolerancias deben ser finitos y no negativos --
    /// mismo criterio que la validación de bounds/métricas de arriba.
    /// </summary>
    private static bool TryConvertRasterValidation(
        Guid groupId, PythonRasterValidationPayload? payload, out LayerRasterValidation? result, out string? reason)
    {
        result = null;

        if (payload is null)
        {
            reason = $"La capa del grupo {groupId:N} no contiene el campo 'raster_validation' esperado.";
            return false;
        }

        var ratiosAndTolerances = new[]
        {
            payload.OwnMismatchRatio, payload.OwnMismatchTolerance, payload.ContaminationRatio, payload.ContaminationTolerance,
        };
        if (ratiosAndTolerances.Any(v => double.IsNaN(v) || double.IsInfinity(v) || v < 0))
        {
            reason = $"La validación raster-vs-vector devuelta por el motor Python para la capa {groupId:N} contiene valores no finitos o negativos.";
            return false;
        }

        result = new LayerRasterValidation(
            payload.OwnMismatchRatio,
            payload.OwnMismatchTolerance,
            payload.OwnMismatchWithinTolerance,
            payload.ContaminationRatio,
            payload.ContaminationTolerance,
            payload.ContaminationWithinTolerance,
            payload.Warnings ?? new List<string>());
        reason = null;
        return true;
    }

    private PythonVectorLayerBatchResult MapErrorResponse(System.Net.HttpStatusCode statusCode, string body)
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
            ("corrupt_image", _) => PythonVectorLayerState.CorruptImage,
            ("dimensions_exceeded", _) => PythonVectorLayerState.DimensionsExceeded,
            ("svg_output_too_large", _) => PythonVectorLayerState.DimensionsExceeded,
            ("empty_mask", _) => PythonVectorLayerState.EmptyMask,
            ("invalid_parameters", _) => PythonVectorLayerState.InvalidParameters,
            ("vectorization_timeout", _) => PythonVectorLayerState.Timeout,
            ("vectorization_engine_error", _) => PythonVectorLayerState.EngineError,
            ("invalid_svg", _) => PythonVectorLayerState.EngineError,
            (_, 400) => PythonVectorLayerState.CorruptImage,
            (_, 413) => PythonVectorLayerState.DimensionsExceeded,
            (_, 422) => PythonVectorLayerState.InvalidParameters,
            (_, 504) => PythonVectorLayerState.Timeout,
            _ => PythonVectorLayerState.HttpError,
        };

        var message = errorPayload?.Message ?? $"El motor Python respondió con código HTTP {(int)statusCode}.";

        if (state == PythonVectorLayerState.HttpError)
        {
            _logger.LogWarning("El motor Python respondió con código {StatusCode} al vectorizar el conjunto de capas", (int)statusCode);
        }

        return Failure(state, message);
    }

    private static PythonVectorLayerBatchResult Failure(PythonVectorLayerState state, string message) =>
        new(state, null, message);
}
