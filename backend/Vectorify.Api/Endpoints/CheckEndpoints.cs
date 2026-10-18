using Vectorify.Api.Checking;
using Vectorify.Api.Contracts;

namespace Vectorify.Api.Endpoints;

/// <summary>
/// Endpoint del Laser Checker de paths abiertos/duplicados (M1-S08): analiza
/// a pedido un SVG YA vectorizado (M1-S05) o simplificado (M1-S07) y devuelve
/// los issues encontrados. SIEMPRE 200 en éxito (nunca 201): este análisis es
/// de solo lectura, no crea ni persiste nada -- ver spec.md, Definition of
/// Done: "sin modificar el SVG".
/// </summary>
public static class CheckEndpoints
{
    public static void MapCheckEndpoints(this RouteGroupBuilder app)
    {
        app.MapPost("/check", async (
            Guid projectId,
            Guid imageId,
            CheckRequest request,
            ICheckService checkService,
            CancellationToken cancellationToken) =>
        {
            var result = await checkService.AnalyzeAsync(projectId, imageId, request, cancellationToken);

            return result switch
            {
                CheckResult.Ready ready => Results.Ok(ToResponse(projectId, imageId, ready)),
                CheckResult.NotFound notFound => Results.NotFound(new ApiErrorResponse(notFound.Code, notFound.Message)),
                CheckResult.ValidationFailed failed => Results.BadRequest(new ApiErrorResponse(failed.Code, failed.Message)),
                CheckResult.UpstreamError error => Results.Json(
                    new ApiErrorResponse(error.Code, error.Message),
                    statusCode: StatusCodeFor(error.Code)),
                _ => Results.Json(
                    new ApiErrorResponse("internal_error", "Ocurrió un error inesperado al analizar el SVG."),
                    statusCode: StatusCodes.Status500InternalServerError),
            };
        })
        .WithName("CheckPaths")
        .WithTags("Checking")
        .Produces<CheckResponse>(StatusCodes.Status200OK)
        .Produces<ApiErrorResponse>(StatusCodes.Status400BadRequest)
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .WithSummary("Laser Checker: detecta paths abiertos y duplicados/casi-duplicados en un SVG ya vectorizado o simplificado.")
        .WithDescription(
            "Recibe sourceKind ('vector' o 'simplification') + sourceId del SVG ya generado, y " +
            "opcionalmente closeGapRatio/duplicatePointRatio (tolerancias relativas a la diagonal " +
            "del SVG, en unidades del modelo). Llama al motor Python y devuelve los issues " +
            "encontrados -- SIEMPRE de solo lectura: nunca modifica ni persiste el SVG de origen.");
    }

    private static CheckResponse ToResponse(Guid projectId, Guid imageId, CheckResult.Ready ready)
    {
        var issues = ready.Issues.Select(ToPayload).ToList();
        var summary = new CheckSummaryPayload(
            issues.OfType<OpenPathIssuePayload>().Count(),
            issues.OfType<DuplicatePathIssuePayload>().Count());

        return new CheckResponse(
            projectId,
            imageId,
            ready.SourceKind == CheckSourceKind.Vector ? "vector" : "simplification",
            ready.SourceId,
            summary,
            issues,
            ready.SkippedPathCount,
            ready.Parameters.CloseGapRatio,
            ready.Parameters.DuplicatePointRatio);
    }

    private static CheckIssuePayload ToPayload(CheckIssue issue) => issue switch
    {
        CheckIssue.OpenPath openPath => new OpenPathIssuePayload(
            openPath.Id,
            openPath.Severity,
            openPath.PathIndex,
            openPath.SubpathIndex,
            openPath.StartPoint.X,
            openPath.StartPoint.Y,
            openPath.EndPoint.X,
            openPath.EndPoint.Y,
            openPath.GapDistance,
            ToPayload(openPath.Bounds)),
        CheckIssue.DuplicatePath duplicatePath => new DuplicatePathIssuePayload(
            duplicatePath.Id,
            duplicatePath.Severity,
            duplicatePath.Exact,
            duplicatePath.MaxPointDistance,
            duplicatePath.Members.Select(member => new CheckDuplicateMemberPayload(
                member.PathIndex, member.SubpathIndex, ToPayload(member.Bounds))).ToList()),
        _ => throw new InvalidOperationException($"Tipo de issue no reconocido: {issue.GetType()}"),
    };

    private static CheckBoundsPayload ToPayload(CheckBounds bounds) =>
        new(bounds.MinX, bounds.MinY, bounds.MaxX, bounds.MaxY);

    private static int StatusCodeFor(string code) => code switch
    {
        "svg_too_large" => StatusCodes.Status413PayloadTooLarge,
        "too_many_subpaths" => StatusCodes.Status413PayloadTooLarge,
        "invalid_input_svg" => StatusCodes.Status400BadRequest,
        "invalid_parameters" => StatusCodes.Status422UnprocessableEntity,
        "timeout" => StatusCodes.Status504GatewayTimeout,
        "engine_unavailable" => StatusCodes.Status503ServiceUnavailable,
        "invalid_response" => StatusCodes.Status502BadGateway,
        _ => StatusCodes.Status500InternalServerError,
    };
}
