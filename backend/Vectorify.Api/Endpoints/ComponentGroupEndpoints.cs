using Vectorify.Api.Components;
using Vectorify.Api.Contracts;

namespace Vectorify.Api.Endpoints;

/// <summary>
/// Endpoints de agrupación LÓGICA de componentes físicos (M2-S05): agrupar,
/// desagrupar, renombrar y recuperar el conjunto de grupos vigente de una
/// capa vectorial. Anidado bajo .../vectors/{vectorId}/components/groups --
/// un grupo referencia componentIds de la ComponentSetVersion de ESE VectorId
/// (M2-S03), así que se expone bajo el mismo VectorId, un nivel más adentro
/// que /components. Ninguna de estas operaciones modifica paths ni la
/// cantidad de piezas físicas: son referencias lógicas puras.
/// </summary>
public static class ComponentGroupEndpoints
{
    public static void MapComponentGroupEndpoints(this RouteGroupBuilder app)
    {
        app.MapPost(
            "/vectors/{vectorId:guid}/components/groups",
            async (
                Guid projectId,
                Guid imageId,
                Guid vectorId,
                ComponentGroupCreateRequest request,
                IComponentGroupService service,
                IComponentAnalysisService componentAnalysisService,
                CancellationToken cancellationToken) =>
            {
                var result = await service.GroupAsync(projectId, imageId, vectorId, request, cancellationToken);
                return ToHttpResult(result, componentAnalysisService, projectId, imageId, vectorId, created: true);
            })
        .WithName("GroupComponents")
        .WithTags("ComponentGroups")
        .Produces<ComponentGroupSetResponse>(StatusCodes.Status201Created)
        .Produces<ApiErrorResponse>(StatusCodes.Status400BadRequest)
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .WithSummary("Agrupa 2+ componentes físicos ya calculados (M2-S03) bajo un nuevo ComponentGroup lógico.")
        .WithDescription(
            "NO modifica ningún path, NO crea una nueva VectorVersion/ComponentSetVersion, NO cambia la " +
            "cantidad de piezas físicas: es una referencia lógica pura, validada contra la " +
            "ComponentSetVersion vigente del VectorId indicado al momento de crear el grupo.");

        app.MapPost(
            "/vectors/{vectorId:guid}/components/groups/{groupId:guid}/ungroup",
            async (
                Guid projectId,
                Guid imageId,
                Guid vectorId,
                Guid groupId,
                IComponentGroupService service,
                IComponentAnalysisService componentAnalysisService,
                CancellationToken cancellationToken) =>
            {
                var result = await service.UngroupAsync(projectId, imageId, vectorId, groupId, cancellationToken);
                return ToHttpResult(result, componentAnalysisService, projectId, imageId, vectorId, created: false);
            })
        .WithName("UngroupComponents")
        .WithTags("ComponentGroups")
        .Produces<ComponentGroupSetResponse>(StatusCodes.Status200OK)
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .WithSummary("Desagrupa un ComponentGroup: sus componentes vuelven a existir individualmente exactamente como antes de agruparlos.");

        app.MapPost(
            "/vectors/{vectorId:guid}/components/groups/{groupId:guid}/rename",
            async (
                Guid projectId,
                Guid imageId,
                Guid vectorId,
                Guid groupId,
                ComponentGroupRenameRequest request,
                IComponentGroupService service,
                IComponentAnalysisService componentAnalysisService,
                CancellationToken cancellationToken) =>
            {
                var result = await service.RenameAsync(projectId, imageId, vectorId, groupId, request, cancellationToken);
                return ToHttpResult(result, componentAnalysisService, projectId, imageId, vectorId, created: false);
            })
        .WithName("RenameComponentGroup")
        .WithTags("ComponentGroups")
        .Produces<ComponentGroupSetResponse>(StatusCodes.Status200OK)
        .Produces<ApiErrorResponse>(StatusCodes.Status400BadRequest)
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .WithSummary("Renombra un ComponentGroup existente.");

        app.MapGet(
            "/vectors/{vectorId:guid}/components/groups",
            (
                Guid projectId,
                Guid imageId,
                Guid vectorId,
                IComponentGroupService service,
                IComponentAnalysisService componentAnalysisService) =>
            {
                var record = service.FindLatest(projectId, imageId, vectorId);
                if (record is null)
                {
                    return Results.Ok(new ComponentGroupSetResponse(projectId, imageId, vectorId, Version: 0, Groups: Array.Empty<ComponentGroupPayload>()));
                }

                var currentComponents = componentAnalysisService.FindLatest(projectId, imageId, vectorId);
                return Results.Ok(ToResponse(record, currentComponents));
            })
        .WithName("GetComponentGroups")
        .WithTags("ComponentGroups")
        .Produces<ComponentGroupSetResponse>(StatusCodes.Status200OK)
        .WithSummary("Recupera el conjunto de grupos lógicos vigente de una capa vectorial (vacío si nunca se agrupó nada).");
    }

    private static IResult ToHttpResult(
        ComponentGroupResult result,
        IComponentAnalysisService componentAnalysisService,
        Guid projectId,
        Guid imageId,
        Guid vectorId,
        bool created)
    {
        switch (result)
        {
            case ComponentGroupResult.Ready ready:
                var currentComponents = componentAnalysisService.FindLatest(projectId, imageId, vectorId);
                var response = ToResponse(ready.Record, currentComponents);
                return created ? Results.Created(GroupsUrl(projectId, imageId, vectorId), response) : Results.Ok(response);
            case ComponentGroupResult.NotFound notFound:
                return Results.NotFound(new ApiErrorResponse(notFound.Code, notFound.Message));
            case ComponentGroupResult.ValidationFailed failed:
                return Results.BadRequest(new ApiErrorResponse(failed.Code, failed.Message));
            default:
                return Results.Json(
                    new ApiErrorResponse("internal_error", "Ocurrió un error inesperado al procesar los grupos de componentes."),
                    statusCode: StatusCodes.Status500InternalServerError);
        }
    }

    private static ComponentGroupSetResponse ToResponse(ComponentGroupSetVersion record, ComponentSetVersion? currentComponents) => new(
        record.ProjectId,
        record.ImageId,
        record.VectorId,
        record.Version,
        record.Groups.Select(g => ToPayload(g, currentComponents)).ToList());

    private static ComponentGroupPayload ToPayload(ComponentGroup group, ComponentSetVersion? currentComponents)
    {
        var missing = ComponentGroupStaleness.MissingComponentIds(group, currentComponents);
        return new ComponentGroupPayload(
            group.GroupId,
            group.Name,
            group.ComponentIds,
            IsStale: ComponentGroupStaleness.IsStale(group, currentComponents),
            MissingComponentIds: missing);
    }

    private static string GroupsUrl(Guid projectId, Guid imageId, Guid vectorId) =>
        $"/api/v1/projects/{projectId}/images/{imageId}/vectors/{vectorId}/components/groups";
}
