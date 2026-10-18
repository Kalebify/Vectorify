using Vectorify.Api.Contracts;
using Vectorify.Api.Simplification;
using Vectorify.Api.Storage;

namespace Vectorify.Api.Endpoints;

/// <summary>
/// Endpoints de simplificación de nodos (M1-S07): preview reversible (sin
/// persistir), aplicar (crea una nueva SimplificationVersion, nunca
/// sobrescribe la anterior) y servir los bytes de una simplificación ya
/// aplicada. Opera sobre un SVG YA vectorizado (M1-S05, referenciado por
/// VectorId): nunca toca la máscara B/N ni el original.
/// </summary>
public static class SimplificationEndpoints
{
    public static void MapSimplificationEndpoints(this RouteGroupBuilder app)
    {
        app.MapPost("/simplify/preview", async (
            Guid projectId,
            Guid imageId,
            SimplifyRequest request,
            ISimplificationService simplificationService,
            CancellationToken cancellationToken) =>
        {
            var result = await simplificationService.PreviewAsync(projectId, imageId, request, cancellationToken);

            return result switch
            {
                SimplificationPreviewResult.Ready ready => Results.Ok(ToPreviewResponse(projectId, imageId, request.VectorId, ready)),
                SimplificationPreviewResult.NotFound notFound => Results.NotFound(
                    new ApiErrorResponse(notFound.Code, notFound.Message)),
                SimplificationPreviewResult.ValidationFailed failed => Results.BadRequest(
                    new ApiErrorResponse(failed.Code, failed.Message)),
                SimplificationPreviewResult.UpstreamError error => Results.Json(
                    new ApiErrorResponse(error.Code, error.Message),
                    statusCode: StatusCodeFor(error.Code)),
                _ => Results.Json(
                    new ApiErrorResponse("internal_error", "Ocurrió un error inesperado al generar el preview de simplificación."),
                    statusCode: StatusCodes.Status500InternalServerError),
            };
        })
        .WithName("PreviewSimplification")
        .WithTags("Simplification")
        .Produces<SimplifyPreviewResponse>(StatusCodes.Status200OK)
        .Produces<ApiErrorResponse>(StatusCodes.Status400BadRequest)
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .WithSummary("Genera un preview de simplificación (nodeCount antes/después, % reducción) sin persistir nada.")
        .WithDescription(
            "Recibe el vectorId de un SVG YA vectorizado (M1-S05) y un preset (low/medium/high) o una " +
            "tolerancia numérica custom. Llama al motor Python y devuelve el SVG simplificado junto con " +
            "sus métricas, SIN crear una versión nueva ni tocar el storage -- cancelar (simplemente no " +
            "llamar a /simplify/apply) no deja rastro.");

        app.MapPost("/simplify/apply", async (
            Guid projectId,
            Guid imageId,
            SimplifyRequest request,
            ISimplificationService simplificationService,
            CancellationToken cancellationToken) =>
        {
            var result = await simplificationService.ApplyAsync(projectId, imageId, request, cancellationToken);

            return result switch
            {
                SimplificationResult.Ready { FromCache: false } ready => Results.Created(
                    SimplificationUrl(projectId, imageId, ready.Record.SimplificationId),
                    ToResponse(ready.Record, cached: false)),
                SimplificationResult.Ready { FromCache: true } ready => Results.Ok(ToResponse(ready.Record, cached: true)),
                SimplificationResult.NotFound notFound => Results.NotFound(
                    new ApiErrorResponse(notFound.Code, notFound.Message)),
                SimplificationResult.ValidationFailed failed => Results.BadRequest(
                    new ApiErrorResponse(failed.Code, failed.Message)),
                SimplificationResult.UpstreamError error => Results.Json(
                    new ApiErrorResponse(error.Code, error.Message),
                    statusCode: StatusCodeFor(error.Code)),
                _ => Results.Json(
                    new ApiErrorResponse("internal_error", "Ocurrió un error inesperado al aplicar la simplificación."),
                    statusCode: StatusCodes.Status500InternalServerError),
            };
        })
        .WithName("ApplySimplification")
        .WithTags("Simplification")
        .Produces<SimplifyResponse>(StatusCodes.Status201Created)
        .Produces<SimplifyResponse>(StatusCodes.Status200OK)
        .Produces<ApiErrorResponse>(StatusCodes.Status400BadRequest)
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .WithSummary("Aplica la simplificación: crea una nueva SimplificationVersion (nunca sobrescribe la anterior).")
        .WithDescription(
            "Mismos parámetros que /simplify/preview, pero esta vez persiste el resultado: guarda el SVG " +
            "simplificado en storage y registra una nueva versión en el historial (cache-hit sobre el mismo " +
            "vector de origen + parámetros avanza la versión en vez de retroceder a una vieja).");

        app.MapGet("/simplifications/{simplificationId:guid}", async (
            Guid projectId,
            Guid imageId,
            Guid simplificationId,
            ISimplificationService simplificationService,
            IFileStorage fileStorage,
            CancellationToken cancellationToken) =>
        {
            var record = simplificationService.FindSimplification(projectId, imageId, simplificationId);
            if (record is null)
            {
                return Results.NotFound(new ApiErrorResponse("not_found", "No existe una simplificación con ese ID."));
            }

            try
            {
                var stream = await fileStorage.OpenReadAsync(record.SvgStorageKey, cancellationToken);
                return Results.Stream(stream, record.ContentType);
            }
            catch (FileNotFoundException)
            {
                return Results.NotFound(new ApiErrorResponse(
                    "not_found", "La simplificación existe en el registro pero ya no está disponible en el storage."));
            }
        })
        .WithName("GetSimplificationSvg")
        .WithTags("Simplification")
        .Produces(StatusCodes.Status200OK, contentType: "image/svg+xml")
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .WithSummary("Recupera los bytes de un SVG simplificado ya aplicado.");
    }

    private static SimplifyPreviewResponse ToPreviewResponse(
        Guid projectId, Guid imageId, Guid sourceVectorId, SimplificationPreviewResult.Ready ready) => new(
        projectId,
        imageId,
        sourceVectorId,
        ready.Svg,
        ready.Width,
        ready.Height,
        ToMetricsPayload(ready.Metrics),
        ready.Parameters.Preset,
        ready.Parameters.EpsilonRatio);

    private static SimplifyResponse ToResponse(SimplificationVersion record, bool cached) => new(
        record.ProjectId,
        record.ImageId,
        record.SimplificationId,
        SimplificationUrl(record.ProjectId, record.ImageId, record.SimplificationId),
        record.SourceVectorId,
        record.Version,
        record.Width,
        record.Height,
        ToMetricsPayload(record.Metrics),
        record.Parameters.Preset,
        record.Parameters.EpsilonRatio,
        cached);

    private static SimplificationMetricsPayload ToMetricsPayload(SimplificationMetrics metrics) => new(
        ToVectorMetricsPayload(metrics.Before),
        ToVectorMetricsPayload(metrics.After),
        metrics.ReductionPercent);

    private static VectorMetricsPayload ToVectorMetricsPayload(Vectorify.Api.Vectorization.VectorMetrics metrics) => new(
        metrics.PathCount,
        metrics.ApproxNodeCount,
        new VectorBoundsPayload(
            metrics.Bounds.MinX,
            metrics.Bounds.MinY,
            metrics.Bounds.MaxX,
            metrics.Bounds.MaxY,
            metrics.Bounds.Width,
            metrics.Bounds.Height));

    private static string SimplificationUrl(Guid projectId, Guid imageId, Guid simplificationId) =>
        $"/api/v1/projects/{projectId}/images/{imageId}/simplifications/{simplificationId}";

    private static int StatusCodeFor(string code) => code switch
    {
        "svg_too_large" => StatusCodes.Status413PayloadTooLarge,
        "invalid_input_svg" => StatusCodes.Status400BadRequest,
        "invalid_parameters" => StatusCodes.Status422UnprocessableEntity,
        "timeout" => StatusCodes.Status504GatewayTimeout,
        "engine_unavailable" => StatusCodes.Status503ServiceUnavailable,
        "invalid_response" => StatusCodes.Status502BadGateway,
        _ => StatusCodes.Status500InternalServerError,
    };
}
