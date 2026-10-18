using Vectorify.Api.Components;
using Vectorify.Api.Contracts;

namespace Vectorify.Api.Endpoints;

/// <summary>
/// Endpoints de componentes físicos independientes por capa (M2-S03):
/// calcular (u obtener, si ya se calculó para ese VectorId) el análisis de
/// componentes de UNA capa vectorial ya generada, y recuperar el último
/// análisis vigente. Anidado bajo .../vectors/{vectorId}/components -- cada
/// capa YA ES un vector normal (M2-S02), así que este análisis se expone
/// exactamente igual que Check/Dimension: por el VectorId de origen, sin
/// necesidad de conocer la paleta/sesión de color que lo generó.
/// </summary>
public static class ComponentEndpoints
{
    public static void MapComponentEndpoints(this RouteGroupBuilder app)
    {
        app.MapPost(
            "/vectors/{vectorId:guid}/components",
            async (
                Guid projectId,
                Guid imageId,
                Guid vectorId,
                IComponentAnalysisService service,
                CancellationToken cancellationToken) =>
            {
                var result = await service.AnalyzeAsync(projectId, imageId, vectorId, cancellationToken);

                return result switch
                {
                    ComponentSetResult.Ready { FromCache: false } ready => Results.Created(
                        ComponentsUrl(projectId, imageId, vectorId),
                        ToResponse(ready.Record, cached: false)),
                    ComponentSetResult.Ready { FromCache: true } ready => Results.Ok(ToResponse(ready.Record, cached: true)),
                    ComponentSetResult.NotFound notFound => Results.NotFound(
                        new ApiErrorResponse(notFound.Code, notFound.Message)),
                    ComponentSetResult.UpstreamError error => Results.Json(
                        new ApiErrorResponse(error.Code, error.Message),
                        statusCode: StatusCodeFor(error.Code)),
                    _ => Results.Json(
                        new ApiErrorResponse("internal_error", "Ocurrió un error inesperado al analizar los componentes de la capa."),
                        statusCode: StatusCodes.Status500InternalServerError),
                };
            })
        .WithName("AnalyzeVectorComponents")
        .WithTags("Components")
        .Produces<ComponentSetResponse>(StatusCodes.Status201Created)
        .Produces<ComponentSetResponse>(StatusCodes.Status200OK)
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .WithSummary(
            "Calcula (u obtiene, si ya se calculó para ese VectorId) los componentes físicos " +
            "independientes de una capa vectorial ya generada.")
        .WithDescription(
            "Precondición: debe existir una VectorVersion con ese VectorId para esta imagen; si no, " +
            "responde 404 sin llamar a Python. Detecta connected components sobre la geometría SVG " +
            "de la capa (subpaths que forman una pieza física conexa, agujeros incluidos en el " +
            "mismo componente que los contiene) y persiste el resultado versionado. Si ya existe un " +
            "análisis para exactamente este VectorId (inmutable una vez generado), lo reutiliza (200, " +
            "cacheado) en vez de volver a llamar a Python, pero igual registra una versión nueva.");

        app.MapGet(
            "/vectors/{vectorId:guid}/components",
            (
                Guid projectId,
                Guid imageId,
                Guid vectorId,
                IComponentAnalysisService service) =>
            {
                var record = service.FindLatest(projectId, imageId, vectorId);
                return record is null
                    ? Results.NotFound(new ApiErrorResponse("not_found", "No existe un análisis de componentes calculado para ese vector."))
                    : Results.Ok(ToResponse(record, cached: false));
            })
        .WithName("GetVectorComponents")
        .WithTags("Components")
        .Produces<ComponentSetResponse>(StatusCodes.Status200OK)
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .WithSummary("Recupera el último análisis de componentes vigente de una capa vectorial.");
    }

    private static ComponentSetResponse ToResponse(ComponentSetVersion record, bool cached) => new(
        record.ProjectId,
        record.ImageId,
        record.ComponentSetId,
        record.Version,
        record.VectorId,
        record.Components.Select(ToPayload).ToList(),
        record.SkippedPathCount,
        cached);

    private static LayerComponentPayload ToPayload(LayerComponent component) => new(
        component.Id,
        component.Members.Select(ToPayload).ToList(),
        ToPayload(component.Bounds),
        component.Area,
        component.IsTiny);

    private static ComponentMemberPayload ToPayload(ComponentMember member) => new(
        member.PathIndex, member.SubpathIndex, member.Role, ToPayload(member.Bounds), member.Area);

    private static ComponentBoundsPayload ToPayload(ComponentBounds bounds) =>
        new(bounds.MinX, bounds.MinY, bounds.MaxX, bounds.MaxY);

    private static string ComponentsUrl(Guid projectId, Guid imageId, Guid vectorId) =>
        $"/api/v1/projects/{projectId}/images/{imageId}/vectors/{vectorId}/components";

    private static int StatusCodeFor(string code) => code switch
    {
        "svg_too_large" => StatusCodes.Status413PayloadTooLarge,
        "too_many_subpaths" => StatusCodes.Status413PayloadTooLarge,
        "invalid_input_svg" => StatusCodes.Status400BadRequest,
        "invalid_parameters" => StatusCodes.Status422UnprocessableEntity,
        "timeout" => StatusCodes.Status504GatewayTimeout,
        "engine_unavailable" => StatusCodes.Status503ServiceUnavailable,
        "invalid_response" => StatusCodes.Status502BadGateway,
        "storage_failure" => StatusCodes.Status500InternalServerError,
        _ => StatusCodes.Status500InternalServerError,
    };
}
