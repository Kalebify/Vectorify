using Vectorify.Api.Contracts;
using Vectorify.Api.Dimensioning;
using Vectorify.Api.Storage;

namespace Vectorify.Api.Endpoints;

/// <summary>
/// Endpoints de dimensiones físicas en mm (M1-S09): aplicar (crea una nueva
/// DimensionVersion, nunca sobrescribe la anterior) y servir los bytes de
/// unas dimensiones ya aplicadas. Opera sobre un SVG YA vectorizado (M1-S05)
/// o simplificado (M1-S07): nunca toca la máscara B/N ni el original. SIN
/// endpoint de preview -- el preview del tamaño final se calcula 100% en el
/// cliente (React), ver Vectorify.Api.Dimensioning.IDimensionService.
/// </summary>
public static class DimensionEndpoints
{
    public static void MapDimensionEndpoints(this RouteGroupBuilder app)
    {
        app.MapPost("/dimensions/apply", async (
            Guid projectId,
            Guid imageId,
            DimensionRequest request,
            IDimensionService dimensionService,
            CancellationToken cancellationToken) =>
        {
            var result = await dimensionService.ApplyAsync(projectId, imageId, request, cancellationToken);

            return result switch
            {
                DimensionResult.Ready { FromCache: false } ready => Results.Created(
                    DimensionUrl(projectId, imageId, ready.Record.DimensionId),
                    ToResponse(ready.Record, cached: false)),
                DimensionResult.Ready { FromCache: true } ready => Results.Ok(ToResponse(ready.Record, cached: true)),
                DimensionResult.NotFound notFound => Results.NotFound(
                    new ApiErrorResponse(notFound.Code, notFound.Message)),
                DimensionResult.ValidationFailed failed => Results.BadRequest(
                    new ApiErrorResponse(failed.Code, failed.Message)),
                // Ambos códigos posibles ("storage_failure", "invalid_source_svg") son
                // fallos internos inesperados (el storage debería tener el SVG que la
                // propia Web API guardó, y ese SVG debería seguir siendo XML válido) --
                // no hay una distinción de código HTTP más específica que darle al
                // cliente, a diferencia de Simplification/Check (que sí distinguen
                // 413/422/504/etc. de fallos reales del motor Python).
                DimensionResult.UpstreamError error => Results.Json(
                    new ApiErrorResponse(error.Code, error.Message),
                    statusCode: StatusCodes.Status500InternalServerError),
                _ => Results.Json(
                    new ApiErrorResponse("internal_error", "Ocurrió un error inesperado al aplicar las dimensiones físicas."),
                    statusCode: StatusCodes.Status500InternalServerError),
            };
        })
        .WithName("ApplyDimensions")
        .WithTags("Dimensions")
        .Produces<DimensionResponse>(StatusCodes.Status201Created)
        .Produces<DimensionResponse>(StatusCodes.Status200OK)
        .Produces<ApiErrorResponse>(StatusCodes.Status400BadRequest)
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .WithSummary("Aplica dimensiones físicas en mm: crea una nueva DimensionVersion (nunca sobrescribe la anterior).")
        .WithDescription(
            "Recibe sourceKind ('vector' o 'simplification') + sourceId del SVG ya generado, ancho y/o alto en mm y " +
            "si la proporción está bloqueada (default) o desbloqueada. Reescribe SOLO width/height/viewBox/" +
            "preserveAspectRatio del elemento raíz <svg> -- nunca los `d` de los <path> -- y persiste el resultado " +
            "como una nueva versión (cache-hit sobre el mismo SVG de origen + las mismas dimensiones avanza la " +
            "versión en vez de retroceder a una vieja).");

        app.MapGet("/dimensions/{dimensionId:guid}", async (
            Guid projectId,
            Guid imageId,
            Guid dimensionId,
            IDimensionService dimensionService,
            IFileStorage fileStorage,
            CancellationToken cancellationToken) =>
        {
            var record = dimensionService.FindDimension(projectId, imageId, dimensionId);
            if (record is null)
            {
                return Results.NotFound(new ApiErrorResponse("not_found", "No existen dimensiones físicas con ese ID."));
            }

            try
            {
                var stream = await fileStorage.OpenReadAsync(record.SvgStorageKey, cancellationToken);
                return Results.Stream(stream, record.ContentType);
            }
            catch (FileNotFoundException)
            {
                return Results.NotFound(new ApiErrorResponse(
                    "not_found", "Las dimensiones existen en el registro pero el SVG ya no está disponible en el storage."));
            }
        })
        .WithName("GetDimensionedSvg")
        .WithTags("Dimensions")
        .Produces(StatusCodes.Status200OK, contentType: "image/svg+xml")
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .WithSummary("Recupera los bytes de un SVG con dimensiones físicas ya aplicadas (round-trip: width/height llevan unidad 'mm' explícita).");
    }

    private static DimensionResponse ToResponse(DimensionVersion record, bool cached) => new(
        record.ProjectId,
        record.ImageId,
        record.DimensionId,
        DimensionUrl(record.ProjectId, record.ImageId, record.DimensionId),
        record.SourceKind == DimensionSourceKind.Vector ? "vector" : "simplification",
        record.SourceId,
        record.Version,
        record.Parameters.WidthMm,
        record.Parameters.HeightMm,
        record.Parameters.LockAspectRatio,
        record.SourceWidthPx,
        record.SourceHeightPx,
        cached);

    private static string DimensionUrl(Guid projectId, Guid imageId, Guid dimensionId) =>
        $"/api/v1/projects/{projectId}/images/{imageId}/dimensions/{dimensionId}";
}
