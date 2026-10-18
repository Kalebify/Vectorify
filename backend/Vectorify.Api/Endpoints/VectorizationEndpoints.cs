using Vectorify.Api.Contracts;
using Vectorify.Api.Storage;
using Vectorify.Api.Vectorization;

namespace Vectorify.Api.Endpoints;

/// <summary>
/// Endpoints de vectorización raster -> SVG (M1-S05): generar/recuperar un
/// SVG a partir de un maskId (máscara B/N ya generada por threshold, M1-S04)
/// y servir los bytes de un SVG ya generado. La máscara de origen nunca se
/// toca acá: el pipeline trabaja sobre una copia enviada al motor Python y el
/// resultado se guarda bajo una clave de storage nueva.
/// </summary>
public static class VectorizationEndpoints
{
    public static void MapVectorizationEndpoints(this RouteGroupBuilder app)
    {
        app.MapPost("/vectorize", async (
            Guid projectId,
            Guid imageId,
            VectorizeRequest request,
            IVectorizationService vectorizationService,
            CancellationToken cancellationToken) =>
        {
            var result = await vectorizationService.GenerateVectorAsync(projectId, imageId, request, cancellationToken);

            return result switch
            {
                VectorResult.Ready { FromCache: false } ready => Results.Created(
                    VectorUrl(projectId, imageId, ready.Record.VectorId),
                    ToResponse(ready.Record, cached: false)),
                VectorResult.Ready { FromCache: true } ready => Results.Ok(ToResponse(ready.Record, cached: true)),
                VectorResult.NotFound notFound => Results.NotFound(
                    new ApiErrorResponse(notFound.Code, notFound.Message)),
                VectorResult.ValidationFailed failed => Results.BadRequest(
                    new ApiErrorResponse(failed.Code, failed.Message)),
                VectorResult.UpstreamError error => Results.Json(
                    new ApiErrorResponse(error.Code, error.Message),
                    statusCode: StatusCodeFor(error.Code)),
                _ => Results.Json(
                    new ApiErrorResponse("internal_error", "Ocurrió un error inesperado al vectorizar la máscara."),
                    statusCode: StatusCodes.Status500InternalServerError),
            };
        })
        .WithName("GenerateVector")
        .WithTags("Vectorization")
        .Produces<VectorizeResponse>(StatusCodes.Status201Created)
        .Produces<VectorizeResponse>(StatusCodes.Status200OK)
        .Produces<ApiErrorResponse>(StatusCodes.Status400BadRequest)
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .WithSummary("Vectoriza (o referencia, si ya existe para esa máscara) una máscara B/N y devuelve un SVG.")
        .WithDescription(
            "Recibe el maskId de una máscara B/N YA generada por threshold (M1-S04) y la vectoriza " +
            "con el motor configurado (VTracer, encapsulado del lado Python). Si ya existe un SVG " +
            "generado para esa máscara, lo devuelve (200, cacheado) en vez de volver a llamar a " +
            "Python. El SVG resultante está sanitizado (sin scripts ni referencias externas) y " +
            "acompañado de estadísticas (paths, nodos aproximados, bounds).");

        app.MapGet("/vectors/{vectorId:guid}", async (
            Guid projectId,
            Guid imageId,
            Guid vectorId,
            IVectorizationService vectorizationService,
            IFileStorage fileStorage,
            CancellationToken cancellationToken) =>
        {
            var record = vectorizationService.FindVector(projectId, imageId, vectorId);
            if (record is null)
            {
                return Results.NotFound(new ApiErrorResponse("not_found", "No existe un vector con ese ID."));
            }

            try
            {
                var stream = await fileStorage.OpenReadAsync(record.SvgStorageKey, cancellationToken);
                return Results.Stream(stream, record.ContentType);
            }
            catch (FileNotFoundException)
            {
                return Results.NotFound(new ApiErrorResponse(
                    "not_found", "El vector existe en el registro pero ya no está disponible en el storage."));
            }
        })
        .WithName("GetVectorSvg")
        .WithTags("Vectorization")
        .Produces(StatusCodes.Status200OK, contentType: "image/svg+xml")
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .WithSummary("Recupera los bytes de un SVG ya generado.");
    }

    private static VectorizeResponse ToResponse(VectorVersion record, bool cached) => new(
        record.ProjectId,
        record.ImageId,
        record.VectorId,
        VectorUrl(record.ProjectId, record.ImageId, record.VectorId),
        record.SourceMaskId,
        record.Version,
        record.Width,
        record.Height,
        new VectorMetricsPayload(
            record.Metrics.PathCount,
            record.Metrics.ApproxNodeCount,
            new VectorBoundsPayload(
                record.Metrics.Bounds.MinX,
                record.Metrics.Bounds.MinY,
                record.Metrics.Bounds.MaxX,
                record.Metrics.Bounds.MaxY,
                record.Metrics.Bounds.Width,
                record.Metrics.Bounds.Height)),
        cached);

    private static string VectorUrl(Guid projectId, Guid imageId, Guid vectorId) =>
        $"/api/v1/projects/{projectId}/images/{imageId}/vectors/{vectorId}";

    private static int StatusCodeFor(string code) => code switch
    {
        "dimensions_exceeded" => StatusCodes.Status413PayloadTooLarge,
        "empty_mask" => StatusCodes.Status422UnprocessableEntity,
        "invalid_parameters" => StatusCodes.Status422UnprocessableEntity,
        "corrupt_file" => StatusCodes.Status400BadRequest,
        "timeout" => StatusCodes.Status504GatewayTimeout,
        "engine_unavailable" => StatusCodes.Status503ServiceUnavailable,
        "invalid_response" => StatusCodes.Status502BadGateway,
        _ => StatusCodes.Status500InternalServerError,
    };
}
