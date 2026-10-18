using Vectorify.Api.Contracts;
using Vectorify.Api.Preprocessing;
using Vectorify.Api.Storage;

namespace Vectorify.Api.Endpoints;

/// <summary>
/// Endpoints de preprocesamiento (M1-S03): generar/recuperar un preview a partir
/// de imageId + parámetros versionados, y servir los bytes de un preview ya
/// generado. El original (ver Endpoints/ProjectEndpoints.cs) nunca se toca acá:
/// el pipeline trabaja sobre una copia enviada al motor Python y el resultado se
/// guarda bajo una clave de storage nueva.
/// </summary>
public static class PreprocessEndpoints
{
    public static void MapPreprocessEndpoints(this RouteGroupBuilder app)
    {
        app.MapPost("/preview", async (
            Guid projectId,
            Guid imageId,
            PreprocessRequest request,
            IPreprocessService preprocessService,
            CancellationToken cancellationToken) =>
        {
            var result = await preprocessService.GeneratePreviewAsync(projectId, imageId, request, cancellationToken);

            return result switch
            {
                PreprocessResult.Ready { FromCache: false } ready => Results.Created(
                    PreviewUrl(projectId, imageId, ready.Record.PreviewId),
                    ToResponse(ready.Record, cached: false)),
                PreprocessResult.Ready { FromCache: true } ready => Results.Ok(ToResponse(ready.Record, cached: true)),
                PreprocessResult.NotFound => Results.NotFound(
                    new ApiErrorResponse("not_found", "No existe un proyecto/imagen con esos IDs.")),
                PreprocessResult.ValidationFailed failed => Results.BadRequest(
                    new ApiErrorResponse(failed.Code, failed.Message)),
                PreprocessResult.UpstreamError error => Results.Json(
                    new ApiErrorResponse(error.Code, error.Message),
                    statusCode: StatusCodeFor(error.Code)),
                _ => Results.Json(
                    new ApiErrorResponse("internal_error", "Ocurrió un error inesperado al generar el preview."),
                    statusCode: StatusCodes.Status500InternalServerError),
            };
        })
        .WithName("GeneratePreview")
        .WithTags("Preprocessing")
        .Produces<PreprocessResponse>(StatusCodes.Status201Created)
        .Produces<PreprocessResponse>(StatusCodes.Status200OK)
        .Produces<ApiErrorResponse>(StatusCodes.Status400BadRequest)
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .WithSummary("Genera (o referencia, si ya existe para esos parámetros) un preview preprocesado.")
        .WithDescription(
            "Valida los rangos de grayscale/contrast/brightness/denoise, y si ya existe un " +
            "preview generado con exactamente esos parámetros para la imagen lo devuelve " +
            "(200, cacheado) en vez de volver a llamar a Python. Si no existe, orquesta la " +
            "llamada al motor Python sobre el original (sin modificarlo), guarda el preview " +
            "bajo una nueva versión y responde 201 con su ubicación. 'Resetear' es simplemente " +
            "volver a llamar con los valores por defecto (grayscale=false, contrast=1.0, " +
            "brightness=0, denoise=0).");

        app.MapGet("/previews/{previewId:guid}", async (
            Guid projectId,
            Guid imageId,
            Guid previewId,
            IPreprocessService preprocessService,
            IFileStorage fileStorage,
            CancellationToken cancellationToken) =>
        {
            var record = preprocessService.FindPreview(projectId, imageId, previewId);
            if (record is null)
            {
                return Results.NotFound(new ApiErrorResponse("not_found", "No existe un preview con ese ID."));
            }

            try
            {
                var stream = await fileStorage.OpenReadAsync(record.PreviewStorageKey, cancellationToken);
                return Results.Stream(stream, record.ContentType);
            }
            catch (FileNotFoundException)
            {
                return Results.NotFound(new ApiErrorResponse(
                    "not_found", "El preview existe en el registro pero ya no está disponible en el storage."));
            }
        })
        .WithName("GetPreviewImage")
        .WithTags("Preprocessing")
        .Produces(StatusCodes.Status200OK, contentType: "application/octet-stream")
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .WithSummary("Recupera los bytes de un preview ya generado.");
    }

    private static PreprocessResponse ToResponse(PreprocessConfigRecord record, bool cached) => new(
        record.ProjectId,
        record.ImageId,
        record.PreviewId,
        PreviewUrl(record.ProjectId, record.ImageId, record.PreviewId),
        record.Version,
        record.Width,
        record.Height,
        record.OriginalWidth,
        record.OriginalHeight,
        new PreprocessParametersPayload(
            record.Parameters.Grayscale, record.Parameters.Contrast, record.Parameters.Brightness, record.Parameters.Denoise),
        new PreprocessMetricsPayload(
            record.Metrics.MeanBrightness, record.Metrics.StdDev, record.Metrics.MinValue, record.Metrics.MaxValue),
        cached);

    private static string PreviewUrl(Guid projectId, Guid imageId, Guid previewId) =>
        $"/api/v1/projects/{projectId}/images/{imageId}/previews/{previewId}";

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
