using Vectorify.Api.Contracts;
using Vectorify.Api.VectorLayers;

namespace Vectorify.Api.Endpoints;

/// <summary>
/// Endpoints del conjunto de capas vectoriales por color (M2-S02): generar
/// (u obtener, si ya existe) TODAS las capas de una paleta confirmada de una
/// sola vez, y recuperar la última versión vigente. Los bytes de cada SVG
/// individual se sirven a través del endpoint YA EXISTENTE
/// GET .../vectors/{vectorId} (M1-S05) -- no hay un endpoint nuevo para
/// servir SVG acá, cada capa ES una VectorVersion normal.
/// </summary>
public static class VectorLayerEndpoints
{
    public static void MapVectorLayerEndpoints(this RouteGroupBuilder app)
    {
        app.MapPost("/color-palette/{paletteId:guid}/layers", async (
            Guid projectId,
            Guid imageId,
            Guid paletteId,
            IVectorLayerService service,
            CancellationToken cancellationToken) =>
        {
            var result = await service.GenerateLayersAsync(projectId, imageId, paletteId, cancellationToken);

            return result switch
            {
                VectorLayerSetResult.Ready { FromCache: false } ready => Results.Created(
                    LayerSetUrl(projectId, imageId, paletteId),
                    ToResponse(ready.Record, cached: false)),
                VectorLayerSetResult.Ready { FromCache: true } ready => Results.Ok(ToResponse(ready.Record, cached: true)),
                VectorLayerSetResult.NotFound notFound => Results.NotFound(
                    new ApiErrorResponse(notFound.Code, notFound.Message)),
                VectorLayerSetResult.Conflict conflict => Results.Conflict(
                    new ApiErrorResponse(conflict.Code, conflict.Message)),
                VectorLayerSetResult.UpstreamError error => Results.Json(
                    new ApiErrorResponse(error.Code, error.Message),
                    statusCode: StatusCodeFor(error.Code)),
                _ => Results.Json(
                    new ApiErrorResponse("internal_error", "Ocurrió un error inesperado al generar el conjunto de capas."),
                    statusCode: StatusCodes.Status500InternalServerError),
            };
        })
        .WithName("GenerateVectorLayers")
        .WithTags("VectorLayers")
        .Produces<VectorLayerSetResponse>(StatusCodes.Status201Created)
        .Produces<VectorLayerSetResponse>(StatusCodes.Status200OK)
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .Produces<ApiErrorResponse>(StatusCodes.Status409Conflict)
        .WithSummary(
            "Genera (u obtiene, si ya existe para esa paleta+versión confirmada) el conjunto COMPLETO " +
            "de capas vectoriales de una paleta de colores confirmada, una por color.")
        .WithDescription(
            "Precondición: la paleta referenciada debe existir y estar CONFIRMADA (M2-S01); si no, " +
            "responde 404/409 sin llamar a Python. Por cada ColorGroup de la paleta, vectoriza su " +
            "máscara de forma independiente (reutilizando el motor de M1-S05) en una ÚNICA llamada " +
            "al motor Python (no una por color), y persiste cada resultado como una VectorVersion " +
            "normal (servida por el mismo endpoint GET .../vectors/{vectorId} que el resto del " +
            "pipeline). Si ya existe un conjunto de capas para esta paleta en exactamente esta " +
            "versión confirmada, lo reutiliza (200, cacheado) en vez de volver a llamar a Python, " +
            "pero igual registra una versión nueva del conjunto (nunca retrocede ni muta una " +
            "versión existente).");

        app.MapGet("/color-palette/{paletteId:guid}/layers", (
            Guid projectId,
            Guid imageId,
            Guid paletteId,
            IVectorLayerService service) =>
        {
            var record = service.FindLatest(projectId, imageId, paletteId);
            return record is null
                ? Results.NotFound(new ApiErrorResponse("not_found", "No existe un conjunto de capas generado para esa paleta."))
                : Results.Ok(ToResponse(record, cached: false));
        })
        .WithName("GetVectorLayers")
        .WithTags("VectorLayers")
        .Produces<VectorLayerSetResponse>(StatusCodes.Status200OK)
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .WithSummary("Recupera la última versión vigente del conjunto de capas de una sesión de paleta.");
    }

    private static VectorLayerSetResponse ToResponse(VectorLayerSetVersion record, bool cached) => new(
        record.ProjectId,
        record.ImageId,
        record.LayerSetId,
        record.Version,
        record.PaletteId,
        record.PaletteVersion,
        record.SourceWidthPx,
        record.SourceHeightPx,
        record.Layers.Select(layer => ToLayerPayload(record, layer)).ToList(),
        cached);

    private static VectorLayerPayload ToLayerPayload(VectorLayerSetVersion record, VectorLayer layer) => new(
        layer.GroupId,
        layer.Name,
        layer.ColorHex,
        layer.AreaPercent,
        layer.HasPartialAlpha,
        layer.VectorId,
        SvgUrl: $"/api/v1/projects/{record.ProjectId}/images/{record.ImageId}/vectors/{layer.VectorId}");

    private static string LayerSetUrl(Guid projectId, Guid imageId, Guid paletteId) =>
        $"/api/v1/projects/{projectId}/images/{imageId}/color-palette/{paletteId}/layers";

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
