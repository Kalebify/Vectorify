using Vectorify.Api.Contracts;
using Vectorify.Api.LayerLayout;
using Vectorify.Api.VectorLayers;

namespace Vectorify.Api.Endpoints;

/// <summary>
/// Endpoints de layout interactivo de capas (M2.1-S07): persistir
/// visibilidad (Eye)/bloqueo (Lock)/orden (Drag &amp; Drop) de una capa o del
/// conjunto -- lo que M2.1-S03 dejó explícitamente pendiente. Anidado bajo
/// .../color-palette/{paletteId}/layers, mismo criterio de anidamiento que
/// <see cref="ManufacturingOperationEndpoints"/>.
/// </summary>
public static class LayerLayoutEndpoints
{
    public static void MapLayerLayoutEndpoints(this RouteGroupBuilder app)
    {
        app.MapPost(
            "/color-palette/{paletteId:guid}/layers/{groupId:guid}/visibility",
            async (
                Guid projectId,
                Guid imageId,
                Guid paletteId,
                Guid groupId,
                SetLayerVisibleRequest request,
                ILayerLayoutService service,
                CancellationToken cancellationToken) =>
            {
                var result = await service.SetVisibleAsync(projectId, imageId, paletteId, groupId, request.Visible, cancellationToken);
                return ToHttpResult(result);
            })
        .WithName("SetVectorLayerVisibility")
        .WithTags("LayerLayout")
        .Produces<LayerLayoutSetResponse>(StatusCodes.Status200OK)
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .WithSummary("Persiste la visibilidad (Eye) de una capa -- crea una nueva versión del layout, NUNCA muta geometría.")
        .WithDescription(
            "Togglear Visible NO afecta Locked ni Order de esa capa ni de ninguna otra. 'Isolate'/'Show all' del " +
            "Workspace son deliberadamente un overlay de VISTA solo de sesión (no llaman a este endpoint): " +
            "persisten únicamente los toggles explícitos del Eye de una capa a la vez -- ver IMPL.md.");

        app.MapPost(
            "/color-palette/{paletteId:guid}/layers/{groupId:guid}/lock",
            async (
                Guid projectId,
                Guid imageId,
                Guid paletteId,
                Guid groupId,
                SetLayerLockedRequest request,
                ILayerLayoutService service,
                CancellationToken cancellationToken) =>
            {
                var result = await service.SetLockedAsync(projectId, imageId, paletteId, groupId, request.Locked, cancellationToken);
                return ToHttpResult(result);
            })
        .WithName("SetVectorLayerLock")
        .WithTags("LayerLayout")
        .Produces<LayerLayoutSetResponse>(StatusCodes.Status200OK)
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .WithSummary("Persiste el bloqueo de edición (Lock, concepto NUEVO de M2.1-S07) de una capa.")
        .WithDescription(
            "Una capa bloqueada sigue siendo visible/seleccionable/inspeccionable (Eye, Isolate, Select All, " +
            "Inspector) -- 'no editable' se traduce hoy en que el Canvas (Konva) refleja el bloqueo sin permitir " +
            "ninguna interacción que mute su geometría. Togglear Locked NO afecta Visible ni Order.");

        app.MapPost(
            "/color-palette/{paletteId:guid}/layers/{groupId:guid}/rename",
            async (
                Guid projectId,
                Guid imageId,
                Guid paletteId,
                Guid groupId,
                SetLayerNameRequest request,
                ILayerLayoutService service,
                CancellationToken cancellationToken) =>
            {
                var result = await service.SetNameAsync(projectId, imageId, paletteId, groupId, request.Name, cancellationToken);
                return ToHttpResult(result);
            })
        .WithName("SetVectorLayerName")
        .WithTags("LayerLayout")
        .Produces<LayerLayoutSetResponse>(StatusCodes.Status200OK)
        .Produces<ApiErrorResponse>(StatusCodes.Status400BadRequest)
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .WithSummary("Persiste el nombre editable (rename, ronda de fix 2) de una capa -- crea una nueva versión del layout, NUNCA muta geometría ni GroupId.")
        .WithDescription(
            "name vacío/solo espacios -> 400 invalid_parameters. Deliberadamente un sidecar propio (LayerLayout), " +
            "no ColorPaletteService.RenameAsync: ese endpoint rechaza con 409 palette_confirmed en cuanto la " +
            "paleta está confirmada, que es SIEMPRE el caso en el Workspace -- ver IMPL-fix-round-1.md. " +
            "Togglear Name NO afecta Visible/Locked/Order de esa capa ni de ninguna otra.");

        app.MapPost(
            "/color-palette/{paletteId:guid}/layers/reorder",
            async (
                Guid projectId,
                Guid imageId,
                Guid paletteId,
                ReorderLayersRequest request,
                ILayerLayoutService service,
                CancellationToken cancellationToken) =>
            {
                var result = await service.ReorderAsync(projectId, imageId, paletteId, request.OrderedGroupIds, cancellationToken);
                return ToHttpResult(result);
            })
        .WithName("ReorderVectorLayers")
        .WithTags("LayerLayout")
        .Produces<LayerLayoutSetResponse>(StatusCodes.Status200OK)
        .Produces<ApiErrorResponse>(StatusCodes.Status400BadRequest)
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .WithSummary("Persiste el nuevo orden visual de TODAS las capas (Drag & Drop).")
        .WithDescription(
            "orderedGroupIds debe listar, exactamente una vez cada uno, todos los groupId del conjunto de capas " +
            "vigente -- si no, 400 invalid_parameters. NUNCA toca d/transform/geometría: reescribe únicamente " +
            "Order, preservando Visible/Locked de cada capa intactos.");

        app.MapGet(
            "/color-palette/{paletteId:guid}/layers/layout",
            (
                Guid projectId,
                Guid imageId,
                Guid paletteId,
                ILayerLayoutService service) =>
            {
                var current = service.FindCurrent(projectId, imageId, paletteId);
                if (current is null)
                {
                    return Results.NotFound(
                        new ApiErrorResponse("not_found", "No existe un conjunto de capas (M2-S02) generado para esa paleta."));
                }

                return Results.Ok(ToResponse(current.Value.LayerSet, current.Value.Layout));
            })
        .WithName("GetVectorLayerLayout")
        .WithTags("LayerLayout")
        .Produces<LayerLayoutSetResponse>(StatusCodes.Status200OK)
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .WithSummary("Recupera el layout (order/visible/locked) vigente de TODAS las capas del conjunto ACTUAL de una paleta.")
        .WithDescription(
            "Incluye las capas que nunca se tocaron, con sus valores DEFAULT (Visible=true, Locked=false, " +
            "Order=posición original). Pensado para reabrir el Workspace (reload) y confirmar que lo persistido sobrevive.");
    }

    private static IResult ToHttpResult(LayerLayoutResult result) => result switch
    {
        LayerLayoutResult.Ready ready => Results.Ok(ToResponse(ready.LayerSet, ready.Record)),
        LayerLayoutResult.NotFound notFound => Results.NotFound(new ApiErrorResponse(notFound.Code, notFound.Message)),
        LayerLayoutResult.ValidationFailed failed => Results.BadRequest(new ApiErrorResponse(failed.Code, failed.Message)),
        _ => Results.Json(
            new ApiErrorResponse("internal_error", "Ocurrió un error inesperado al actualizar el layout de la capa."),
            statusCode: StatusCodes.Status500InternalServerError),
    };

    private static LayerLayoutSetResponse ToResponse(VectorLayerSetVersion layerSet, LayerLayoutSetVersion? layout)
    {
        var entries = LayerLayoutDefaults.Resolve(layerSet, layout);
        return new LayerLayoutSetResponse(
            layerSet.ProjectId,
            layerSet.ImageId,
            layerSet.PaletteId,
            layerSet.PaletteVersion,
            layerSet.LayerSetId,
            layout?.Version ?? 0,
            entries.Select(e => new LayerLayoutEntryPayload(e.GroupId, e.Order, e.Visible, e.Locked, e.Name)).ToList());
    }
}
