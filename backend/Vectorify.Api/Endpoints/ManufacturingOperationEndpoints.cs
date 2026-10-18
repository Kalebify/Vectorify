using Vectorify.Api.Contracts;
using Vectorify.Api.ManufacturingOperations;
using Vectorify.Api.VectorLayers;

namespace Vectorify.Api.Endpoints;

/// <summary>
/// Endpoints de intención de fabricación por capa de color (M2-S07): asignar
/// (o reasignar) Corte/Grabado/Ignorar a una capa, y recuperar el conjunto
/// completo -- con leyenda y resumen -- del conjunto de capas ACTUAL de una
/// paleta. Anidado bajo .../color-palette/{paletteId}/layers, un nivel más
/// adentro que el propio conjunto de capas (M2-S02) -- mismo criterio de
/// anidamiento que ComponentGroupEndpoints bajo .../vectors/{vectorId}.
/// </summary>
public static class ManufacturingOperationEndpoints
{
    public static void MapManufacturingOperationEndpoints(this RouteGroupBuilder app)
    {
        app.MapPost(
            "/color-palette/{paletteId:guid}/layers/{groupId:guid}/operation",
            async (
                Guid projectId,
                Guid imageId,
                Guid paletteId,
                Guid groupId,
                ManufacturingOperationRequest request,
                IManufacturingOperationService service,
                CancellationToken cancellationToken) =>
            {
                var result = await service.AssignAsync(projectId, imageId, paletteId, groupId, request.Operation, cancellationToken);
                return result switch
                {
                    ManufacturingOperationResult.Ready ready => Results.Ok(ToResponse(ready.LayerSet, ready.Record)),
                    ManufacturingOperationResult.NotFound notFound => Results.NotFound(
                        new ApiErrorResponse(notFound.Code, notFound.Message)),
                    ManufacturingOperationResult.ValidationFailed failed => Results.BadRequest(
                        new ApiErrorResponse(failed.Code, failed.Message)),
                    _ => Results.Json(
                        new ApiErrorResponse("internal_error", "Ocurrió un error inesperado al asignar la operación de fabricación."),
                        statusCode: StatusCodes.Status500InternalServerError),
                };
            })
        .WithName("AssignManufacturingOperation")
        .WithTags("ManufacturingOperations")
        .Produces<ManufacturingOperationSetResponse>(StatusCodes.Status200OK)
        .Produces<ApiErrorResponse>(StatusCodes.Status400BadRequest)
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .WithSummary("Asigna (o reasigna) la intención de fabricación (Corte/Grabado/Ignorar) de una capa de color.")
        .WithDescription(
            "NO modifica geometría, NO crea una nueva VectorVersion/VectorLayerSetVersion: es metadata pura, " +
            "persistida como una nueva versión del conjunto de asignaciones vinculada a la paleta+versión " +
            "confirmada vigente. Si esa paleta se recalcula (versión confirmada nueva), las asignaciones " +
            "viejas no se migran automáticamente -- mismo criterio que M2-S05 (ComponentGroup/ComponentSetVersion).");

        app.MapGet(
            "/color-palette/{paletteId:guid}/layers/operations",
            (
                Guid projectId,
                Guid imageId,
                Guid paletteId,
                IManufacturingOperationService service) =>
            {
                var current = service.FindCurrent(projectId, imageId, paletteId);
                if (current is null)
                {
                    return Results.NotFound(
                        new ApiErrorResponse("not_found", "No existe un conjunto de capas (M2-S02) generado para esa paleta."));
                }

                return Results.Ok(ToResponse(current.Value.LayerSet, current.Value.Assignments));
            })
        .WithName("GetManufacturingOperations")
        .WithTags("ManufacturingOperations")
        .Produces<ManufacturingOperationSetResponse>(StatusCodes.Status200OK)
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .WithSummary(
            "Recupera, con leyenda y resumen, la intención de fabricación vigente de TODAS las capas del " +
            "conjunto ACTUAL de capas de una paleta (incluidas las que todavía no tienen ninguna asignación " +
            "explícita -- 'unassigned'). Pensado para mostrarse antes de exportar.");
    }

    private static ManufacturingOperationSetResponse ToResponse(
        VectorLayerSetVersion layerSet, ManufacturingOperationSetVersion? assignments)
    {
        var assignmentByGroupId = (assignments?.Assignments ?? Array.Empty<ManufacturingOperationAssignment>())
            .ToDictionary(a => a.GroupId, a => a.Operation);

        var operations = layerSet.Layers
            .Select(layer => new ManufacturingOperationPayload(
                layer.GroupId,
                layer.Name,
                layer.ColorHex,
                assignmentByGroupId.TryGetValue(layer.GroupId, out var operation)
                    ? ManufacturingOperationParser.ToWireValue(operation)
                    : ManufacturingOperationParser.UnassignedWireValue))
            .ToList();

        var summary = new ManufacturingOperationSummaryPayload(
            CutCount: operations.Count(o => o.Operation == "cut"),
            EngraveCount: operations.Count(o => o.Operation == "engrave"),
            IgnoreCount: operations.Count(o => o.Operation == "ignore"),
            UnassignedCount: operations.Count(o => o.Operation == ManufacturingOperationParser.UnassignedWireValue),
            TotalCount: operations.Count);

        return new ManufacturingOperationSetResponse(
            layerSet.ProjectId,
            layerSet.ImageId,
            layerSet.PaletteId,
            layerSet.PaletteVersion,
            layerSet.LayerSetId,
            assignments?.Version ?? 0,
            operations,
            summary);
    }
}
