using Vectorify.Api.Contracts;
using Vectorify.Api.Storage;
using Vectorify.Api.Threshold;

namespace Vectorify.Api.Endpoints;

/// <summary>
/// Endpoints de threshold B/N (M1-S04): generar/recuperar una máscara a
/// partir de un previewId ya preprocesado (M1-S03) + parámetros versionados,
/// y servir los bytes de una máscara ya generada. El preview de origen nunca
/// se toca acá: el pipeline trabaja sobre una copia enviada al motor Python y
/// el resultado se guarda bajo una clave de storage nueva.
/// </summary>
public static class ThresholdEndpoints
{
    public static void MapThresholdEndpoints(this RouteGroupBuilder app)
    {
        app.MapPost("/threshold", async (
            Guid projectId,
            Guid imageId,
            ThresholdRequest request,
            IThresholdService thresholdService,
            CancellationToken cancellationToken) =>
        {
            var result = await thresholdService.GenerateMaskAsync(projectId, imageId, request, cancellationToken);

            return result switch
            {
                ThresholdResult.Ready { FromCache: false } ready => Results.Created(
                    MaskUrl(projectId, imageId, ready.Record.MaskId),
                    ToResponse(ready.Record, cached: false)),
                ThresholdResult.Ready { FromCache: true } ready => Results.Ok(ToResponse(ready.Record, cached: true)),
                ThresholdResult.NotFound notFound => Results.NotFound(
                    new ApiErrorResponse(notFound.Code, notFound.Message)),
                ThresholdResult.ValidationFailed failed => Results.BadRequest(
                    new ApiErrorResponse(failed.Code, failed.Message)),
                ThresholdResult.UpstreamError error => Results.Json(
                    new ApiErrorResponse(error.Code, error.Message),
                    statusCode: StatusCodeFor(error.Code)),
                _ => Results.Json(
                    new ApiErrorResponse("internal_error", "Ocurrió un error inesperado al generar la máscara."),
                    statusCode: StatusCodes.Status500InternalServerError),
            };
        })
        .WithName("GenerateThresholdMask")
        .WithTags("Threshold")
        .Produces<ThresholdResponse>(StatusCodes.Status201Created)
        .Produces<ThresholdResponse>(StatusCodes.Status200OK)
        .Produces<ApiErrorResponse>(StatusCodes.Status400BadRequest)
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .WithSummary("Genera (o referencia, si ya existe para esos parámetros) una máscara B/N a partir de un preview preprocesado.")
        .WithDescription(
            "Recibe el previewId de un preview YA preprocesado (M1-S03) y aplica un umbral " +
            "global determinista, con inversión opcional. Si ya existe una máscara generada " +
            "con exactamente esos parámetros para ese preview, la devuelve (200, cacheada) en " +
            "vez de volver a llamar a Python. Si el resultado queda casi vacío o casi completo, " +
            "la respuesta incluye un código/mensaje de advertencia (no un error). 'Resetear' es " +
            "simplemente volver a llamar con los valores por defecto (value=128, invert=false).");

        app.MapGet("/masks/{maskId:guid}", async (
            Guid projectId,
            Guid imageId,
            Guid maskId,
            IThresholdService thresholdService,
            IFileStorage fileStorage,
            CancellationToken cancellationToken) =>
        {
            var record = thresholdService.FindMask(projectId, imageId, maskId);
            if (record is null)
            {
                return Results.NotFound(new ApiErrorResponse("not_found", "No existe una máscara con ese ID."));
            }

            try
            {
                var stream = await fileStorage.OpenReadAsync(record.MaskStorageKey, cancellationToken);
                return Results.Stream(stream, record.ContentType);
            }
            catch (FileNotFoundException)
            {
                return Results.NotFound(new ApiErrorResponse(
                    "not_found", "La máscara existe en el registro pero ya no está disponible en el storage."));
            }
        })
        .WithName("GetThresholdMaskImage")
        .WithTags("Threshold")
        .Produces(StatusCodes.Status200OK, contentType: "application/octet-stream")
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .WithSummary("Recupera los bytes de una máscara ya generada.");
    }

    private static ThresholdResponse ToResponse(ThresholdConfigRecord record, bool cached) => new(
        record.ProjectId,
        record.ImageId,
        record.MaskId,
        MaskUrl(record.ProjectId, record.ImageId, record.MaskId),
        record.SourcePreviewId,
        record.Version,
        record.Width,
        record.Height,
        new ThresholdParametersPayload(record.Parameters.Value, record.Parameters.Invert),
        new ThresholdMetricsPayload(
            record.Metrics.ForegroundPercent,
            record.Metrics.BackgroundPercent,
            record.Metrics.IsNearEmpty,
            record.Metrics.IsNearFull,
            record.Metrics.WarningCode,
            record.Metrics.WarningMessage),
        cached);

    private static string MaskUrl(Guid projectId, Guid imageId, Guid maskId) =>
        $"/api/v1/projects/{projectId}/images/{imageId}/masks/{maskId}";

    private static int StatusCodeFor(string code) => code switch
    {
        "dimensions_exceeded" => StatusCodes.Status413PayloadTooLarge,
        "invalid_parameters" => StatusCodes.Status422UnprocessableEntity,
        "corrupt_file" => StatusCodes.Status400BadRequest,
        "timeout" => StatusCodes.Status504GatewayTimeout,
        "engine_unavailable" => StatusCodes.Status503ServiceUnavailable,
        "invalid_response" => StatusCodes.Status502BadGateway,
        _ => StatusCodes.Status500InternalServerError,
    };
}
