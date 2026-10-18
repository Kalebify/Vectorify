using Vectorify.Api.Contracts;
using Vectorify.Api.PhysicalUnion;

namespace Vectorify.Api.Endpoints;

/// <summary>
/// Endpoints de unión física de piezas (M2-S06): preview (calcula la
/// geometría real, NUNCA persiste nada) y confirm (persiste una
/// <see cref="Vectorify.Api.Vectorization.VectorVersion"/> nueva, reutilizando
/// el tipo existente). Anidado bajo .../vectors/{vectorId}/physical-union --
/// mismo nivel que .../components/groups (M2-S05), pero un path DISTINTO y
/// explícitamente separado: "Agrupar" y "Unir físicamente" son acciones
/// DISTINTAS con consecuencias distintas (ver spec.md, criterio de
/// aceptación: "distinguir claramente Agrupar de Unir físicamente ... en
/// toda la UI"), eso empieza por no compartir ni siquiera la URL.
/// </summary>
public static class PhysicalUnionEndpoints
{
    public static void MapPhysicalUnionEndpoints(this RouteGroupBuilder app)
    {
        app.MapPost(
            "/vectors/{vectorId:guid}/physical-union/preview",
            async (
                Guid projectId,
                Guid imageId,
                Guid vectorId,
                PhysicalUnionRequest request,
                IPhysicalUnionService service,
                CancellationToken cancellationToken) =>
            {
                var result = await service.PreviewAsync(projectId, imageId, vectorId, request, cancellationToken);
                return ToPreviewHttpResult(result, projectId, imageId, vectorId, request.ComponentIds);
            })
        .WithName("PreviewPhysicalUnion")
        .WithTags("PhysicalUnion")
        .Produces<PhysicalUnionPreviewResponse>(StatusCodes.Status200OK)
        .Produces<ApiErrorResponse>(StatusCodes.Status400BadRequest)
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .Produces<ApiErrorResponse>(StatusCodes.Status422UnprocessableEntity)
        .WithSummary("Calcula (sin persistir NADA) el resultado real de unir físicamente 2+ componentes seleccionados.")
        .WithDescription(
            "Geometría REAL ya calculada (unión booleana para piezas solapadas/tangentes, bridge simple/directo " +
            "para piezas separadas), no una aproximación visual. Si la unión no fue geométricamente posible " +
            "(la validación post-operación no negociable detectó que el resultado sigue teniendo más de la " +
            "cantidad esperada de componentes), responde 422 explicando por qué -- nunca un SVG que 'parece' " +
            "unido. Nunca modifica ni crea ninguna VectorVersion: llamar a este endpoint repetidamente, o nunca " +
            "confirmar, no tiene ningún efecto persistente.");

        app.MapPost(
            "/vectors/{vectorId:guid}/physical-union/confirm",
            async (
                Guid projectId,
                Guid imageId,
                Guid vectorId,
                PhysicalUnionRequest request,
                IPhysicalUnionService service,
                CancellationToken cancellationToken) =>
            {
                var result = await service.ConfirmAsync(projectId, imageId, vectorId, request, cancellationToken);
                return ToConfirmHttpResult(result, projectId, imageId, vectorId, request.ComponentIds);
            })
        .WithName("ConfirmPhysicalUnion")
        .WithTags("PhysicalUnion")
        .Produces<PhysicalUnionConfirmResponse>(StatusCodes.Status201Created)
        .Produces<ApiErrorResponse>(StatusCodes.Status400BadRequest)
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .Produces<ApiErrorResponse>(StatusCodes.Status422UnprocessableEntity)
        .WithSummary("Confirma la unión física: persiste una VectorVersion NUEVA con el SVG fusionado.")
        .WithDescription(
            "La VectorVersion anterior (vectorId de la URL) NUNCA se destruye ni se muta -- sigue existiendo " +
            "en el historial, recuperable como cualquier otra versión. Si la unión no es geométricamente " +
            "posible, responde 422 explicando por qué y NO persiste absolutamente nada: el usuario sigue " +
            "teniendo exactamente lo que tenía antes de intentar la unión.");

        app.MapGet(
            "/vectors/{vectorId:guid}/physical-union",
            (
                Guid projectId,
                Guid imageId,
                Guid vectorId,
                IPhysicalUnionService service) =>
            {
                var record = service.FindLatest(projectId, imageId, vectorId);
                return record is null
                    ? Results.NotFound(new ApiErrorResponse("not_found", "Nunca se confirmó una unión física a partir de ese vector."))
                    : Results.Ok(ToAuditPayload(record));
            })
        .WithName("GetLatestPhysicalUnion")
        .WithTags("PhysicalUnion")
        .Produces<PhysicalUnionAuditPayload>(StatusCodes.Status200OK)
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .WithSummary("Recupera el registro de auditoría de la última unión física confirmada a partir de ese vector.");
    }

    private static IResult ToPreviewHttpResult(
        PhysicalUnionPreviewResult result, Guid projectId, Guid imageId, Guid vectorId, IReadOnlyList<string> componentIds)
    {
        switch (result)
        {
            case PhysicalUnionPreviewResult.Ready ready:
                return Results.Ok(ToPreviewResponse(ready.Outcome, projectId, imageId, vectorId, componentIds));
            case PhysicalUnionPreviewResult.NotFound notFound:
                return Results.NotFound(new ApiErrorResponse(notFound.Code, notFound.Message));
            case PhysicalUnionPreviewResult.ValidationFailed failed:
                return Results.BadRequest(new ApiErrorResponse(failed.Code, failed.Message));
            case PhysicalUnionPreviewResult.GeometryImpossible impossible:
                return Results.UnprocessableEntity(new ApiErrorResponse(impossible.Code, impossible.Message));
            case PhysicalUnionPreviewResult.UpstreamError error:
                return Results.Json(new ApiErrorResponse(error.Code, error.Message), statusCode: StatusCodeFor(error.Code));
            default:
                return Results.Json(
                    new ApiErrorResponse("internal_error", "Ocurrió un error inesperado al calcular el preview de la unión física."),
                    statusCode: StatusCodes.Status500InternalServerError);
        }
    }

    private static IResult ToConfirmHttpResult(
        PhysicalUnionConfirmResult result, Guid projectId, Guid imageId, Guid vectorId, IReadOnlyList<string> componentIds)
    {
        switch (result)
        {
            case PhysicalUnionConfirmResult.Ready ready:
                var response = ToConfirmResponse(ready, projectId, imageId, componentIds);
                return Results.Created(VectorUrl(projectId, imageId, ready.NewVector.VectorId), response);
            case PhysicalUnionConfirmResult.NotFound notFound:
                return Results.NotFound(new ApiErrorResponse(notFound.Code, notFound.Message));
            case PhysicalUnionConfirmResult.ValidationFailed failed:
                return Results.BadRequest(new ApiErrorResponse(failed.Code, failed.Message));
            case PhysicalUnionConfirmResult.GeometryImpossible impossible:
                return Results.UnprocessableEntity(new ApiErrorResponse(impossible.Code, impossible.Message));
            case PhysicalUnionConfirmResult.UpstreamError error:
                return Results.Json(new ApiErrorResponse(error.Code, error.Message), statusCode: StatusCodeFor(error.Code));
            default:
                return Results.Json(
                    new ApiErrorResponse("internal_error", "Ocurrió un error inesperado al confirmar la unión física."),
                    statusCode: StatusCodes.Status500InternalServerError);
        }
    }

    private static PhysicalUnionPreviewResponse ToPreviewResponse(
        PhysicalUnionOutcome outcome, Guid projectId, Guid imageId, Guid vectorId, IReadOnlyList<string> componentIds) => new(
        projectId,
        imageId,
        vectorId,
        componentIds,
        outcome.Svg,
        outcome.ContentType,
        outcome.Width,
        outcome.Height,
        ToMetricsPayload(outcome),
        outcome.ComponentCountBefore,
        outcome.ComponentCountAfter,
        outcome.Strategy,
        outcome.BridgeCount);

    private static PhysicalUnionConfirmResponse ToConfirmResponse(
        PhysicalUnionConfirmResult.Ready ready, Guid projectId, Guid imageId, IReadOnlyList<string> componentIds) => new(
        projectId,
        imageId,
        ready.Record.SourceVectorId,
        ready.NewVector.VectorId,
        VectorUrl(projectId, imageId, ready.NewVector.VectorId),
        ready.NewVector.Version,
        ready.Record.Version,
        componentIds,
        ready.NewVector.Width,
        ready.NewVector.Height,
        new VectorMetricsPayload(
            ready.NewVector.Metrics.PathCount,
            ready.NewVector.Metrics.ApproxNodeCount,
            new VectorBoundsPayload(
                ready.NewVector.Metrics.Bounds.MinX,
                ready.NewVector.Metrics.Bounds.MinY,
                ready.NewVector.Metrics.Bounds.MaxX,
                ready.NewVector.Metrics.Bounds.MaxY,
                ready.NewVector.Metrics.Bounds.Width,
                ready.NewVector.Metrics.Bounds.Height)),
        ready.Record.ComponentCountBefore,
        ready.Record.ResultComponentCount,
        ready.Record.Strategy,
        ready.Record.BridgeCount);

    private static VectorMetricsPayload ToMetricsPayload(PhysicalUnionOutcome outcome) => new(
        outcome.Metrics.PathCount,
        outcome.Metrics.ApproxNodeCount,
        new VectorBoundsPayload(
            outcome.Metrics.Bounds.MinX,
            outcome.Metrics.Bounds.MinY,
            outcome.Metrics.Bounds.MaxX,
            outcome.Metrics.Bounds.MaxY,
            outcome.Metrics.Bounds.Width,
            outcome.Metrics.Bounds.Height));

    private static PhysicalUnionAuditPayload ToAuditPayload(Vectorify.Api.PhysicalUnion.PhysicalUnionVersion record) => new(
        record.ProjectId,
        record.ImageId,
        record.SourceVectorId,
        record.ResultVectorId,
        record.Version,
        record.ComponentIds,
        record.ComponentCountBefore,
        record.ResultComponentCount,
        record.Strategy,
        record.BridgeCount,
        record.CreatedAt);

    private static string VectorUrl(Guid projectId, Guid imageId, Guid vectorId) =>
        $"/api/v1/projects/{projectId}/images/{imageId}/vectors/{vectorId}";

    private static int StatusCodeFor(string code) => code switch
    {
        "svg_too_large" => StatusCodes.Status413PayloadTooLarge,
        "invalid_input_svg" => StatusCodes.Status400BadRequest,
        "invalid_parameters" => StatusCodes.Status422UnprocessableEntity,
        "timeout" => StatusCodes.Status504GatewayTimeout,
        "engine_unavailable" => StatusCodes.Status503ServiceUnavailable,
        "invalid_response" => StatusCodes.Status502BadGateway,
        "storage_failure" => StatusCodes.Status500InternalServerError,
        _ => StatusCodes.Status500InternalServerError,
    };
}

/// <summary>Payload de auditoría (GET .../physical-union) -- ver PhysicalUnionVersion.</summary>
public sealed record PhysicalUnionAuditPayload(
    Guid ProjectId,
    Guid ImageId,
    Guid SourceVectorId,
    Guid ResultVectorId,
    int Version,
    IReadOnlyList<string> ComponentIds,
    int ComponentCountBefore,
    int ResultComponentCount,
    string Strategy,
    int BridgeCount,
    DateTimeOffset CreatedAt);
