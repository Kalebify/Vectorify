using Vectorify.Api.Components;
using Vectorify.Api.Contracts;
using Vectorify.Api.LayerLayout;
using Vectorify.Api.ManufacturingOperations;
using Vectorify.Api.VectorLayers;
using Vectorify.Api.Vectorization;

namespace Vectorify.Api.Endpoints;

/// <summary>
/// Endpoint del modelo `VectorLayer` CONSOLIDADO (M2.1-S03, extendido en
/// M2.1-S04 con `PathCount`): combina, para cada capa del conjunto vigente de
/// una paleta confirmada (M2-S02), lo que hoy está disperso en varios
/// servicios separados --
/// <see cref="IVectorLayerService"/> (color/fill/SVG, M2-S02/M2.1-S01),
/// <see cref="IComponentAnalysisService"/> (componentCount, M2-S03),
/// <see cref="IManufacturingOperationService"/> (operación de fabricación,
/// M2-S07), <see cref="ILayerLayoutService"/> (order/visible/locked YA
/// PERSISTIDOS, M2.1-S07) y <see cref="IVectorizationService"/> (pathCount,
/// M1-S05) -- en una única respuesta, SIN recalcular ninguno de ellos (solo
/// lectura de lo ya persistido por cada uno, mismo criterio de composición
/// fina en el endpoint que ya usa <see cref="ManufacturingOperationEndpoints"/>
/// al combinar VectorLayerSetVersion + ManufacturingOperationSetVersion).
///
/// Deliberadamente un endpoint NUEVO (no una modificación del contrato ya
/// existente de <see cref="VectorLayerEndpoints"/>, del que ya dependen otras
/// tarjetas, como M2-S07/ManufacturingOperationEndpoints): aditivo, sin
/// riesgo de romper ningún consumidor existente de GET/POST .../layers.
/// </summary>
public static class ConsolidatedVectorLayerEndpoints
{
    public static void MapConsolidatedVectorLayerEndpoints(this RouteGroupBuilder app)
    {
        app.MapGet(
            "/color-palette/{paletteId:guid}/layers/consolidated",
            (
                Guid projectId,
                Guid imageId,
                Guid paletteId,
                IVectorLayerService vectorLayerService,
                IComponentAnalysisService componentAnalysisService,
                IManufacturingOperationService manufacturingOperationService,
                ILayerLayoutService layerLayoutService,
                IVectorizationService vectorizationService) =>
            {
                var layerSet = vectorLayerService.FindLatest(projectId, imageId, paletteId);
                if (layerSet is null)
                {
                    return Results.NotFound(
                        new ApiErrorResponse("not_found", "No existe un conjunto de capas (M2-S02) generado para esa paleta."));
                }

                var assignments = manufacturingOperationService.FindCurrent(projectId, imageId, paletteId)?.Assignments;
                var operationByGroupId = (assignments?.Assignments ?? Array.Empty<ManufacturingOperationAssignment>())
                    .ToDictionary(a => a.GroupId, a => a.Operation);

                // Layout (order/visible/locked, M2.1-S07): resuelto por groupId
                // vía el MISMO helper que usan los endpoints dedicados de
                // LayerLayoutEndpoints (LayerLayoutDefaults.Resolve), para que
                // esta respuesta consolidada y GET .../layers/layout nunca
                // diverjan sobre "cuál es el valor vigente de una capa".
                var layout = layerLayoutService.FindCurrent(projectId, imageId, paletteId)?.Layout;
                var layoutByGroupId = LayerLayoutDefaults.Resolve(layerSet, layout).ToDictionary(e => e.GroupId);

                var layers = layerSet.Layers
                    .Select(layer => ToPayload(
                        projectId, imageId, layer, layoutByGroupId[layer.GroupId], componentAnalysisService, vectorizationService, operationByGroupId))
                    .ToList();

                return Results.Ok(new ConsolidatedVectorLayerSetResponse(
                    layerSet.ProjectId,
                    layerSet.ImageId,
                    layerSet.LayerSetId,
                    layerSet.Version,
                    layerSet.PaletteId,
                    layerSet.PaletteVersion,
                    layerSet.SourceWidthPx,
                    layerSet.SourceHeightPx,
                    layers));
            })
        .WithName("GetConsolidatedVectorLayers")
        .WithTags("VectorLayers")
        .Produces<ConsolidatedVectorLayerSetResponse>(StatusCodes.Status200OK)
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .WithSummary(
            "Recupera el conjunto de capas vigente de una paleta con el modelo VectorLayer " +
            "CONSOLIDADO (M2.1-S03/M2.1-S04): color/fill/geometría, pathCount (M1-S05), componentCount " +
            "(si ya se calculó, M2-S03), manufacturingOperation (M2-S07, 'unassigned' si no se asignó), " +
            "y visible/locked/order YA PERSISTIDOS (M2.1-S07, sidecar propio -- ver LayerLayoutEndpoints).")
        .WithDescription(
            "Precondición: debe existir un conjunto de capas generado para esa paleta (POST " +
            ".../layers de M2-S02); si no, responde 404 sin llamar a ningún servicio adicional. " +
            "NUNCA dispara un cálculo de componentes ni una llamada a Python: componentCount es " +
            "null si esa capa (VectorId) todavía no tiene un análisis de componentes calculado.");
    }

    private static ConsolidatedVectorLayerPayload ToPayload(
        Guid projectId,
        Guid imageId,
        VectorLayer layer,
        LayerLayoutEntry layout,
        IComponentAnalysisService componentAnalysisService,
        IVectorizationService vectorizationService,
        IReadOnlyDictionary<Guid, ManufacturingOperationKind> operationByGroupId)
    {
        var componentCount = componentAnalysisService.FindLatest(projectId, imageId, layer.VectorId)?.Components.Count;
        // Lectura trivial de la MISMA VectorVersion (M1-S05) que ya sirve el
        // SVG de esta capa vía SvgUrl -- nunca se recalcula, solo se expone
        // Metrics.PathCount que M1-S05 ya persistió (ver docstring del
        // record). 0 en el caso (no esperado en la práctica) de que la
        // VectorVersion referenciada ya no exista en el registro.
        var pathCount = vectorizationService.FindVector(projectId, imageId, layer.VectorId)?.Metrics.PathCount ?? 0;
        var operation = operationByGroupId.TryGetValue(layer.GroupId, out var kind)
            ? ManufacturingOperationParser.ToWireValue(kind)
            : ManufacturingOperationParser.UnassignedWireValue;

        return new ConsolidatedVectorLayerPayload(
            Id: layer.GroupId,
            // Nombre EFECTIVO (ronda de fix 2): el override del sidecar LayerLayout
            // si existe (rename post-confirmación, ver LayerLayoutEndpoints), o el
            // snapshot original de VectorLayer.Name (capturado de ColorGroup.Name al
            // generar las capas, sin cambios acá) -- mismo criterio ya usado para
            // Visible/Locked/Order.
            Name: layout.Name ?? layer.Name,
            ColorHex: layer.ColorHex,
            Fill: layer.ColorHex,
            VectorId: layer.VectorId,
            SvgUrl: $"/api/v1/projects/{projectId}/images/{imageId}/vectors/{layer.VectorId}",
            PathCount: pathCount,
            ComponentCount: componentCount,
            ManufacturingOperation: operation,
            Visible: layout.Visible,
            Locked: layout.Locked,
            Order: layout.Order,
            RasterValidation: new RasterValidationPayload(
                layer.RasterValidation.OwnMismatchRatio,
                layer.RasterValidation.OwnMismatchTolerance,
                layer.RasterValidation.OwnMismatchWithinTolerance,
                layer.RasterValidation.ContaminationRatio,
                layer.RasterValidation.ContaminationTolerance,
                layer.RasterValidation.ContaminationWithinTolerance,
                layer.RasterValidation.Warnings));
    }
}
