using Vectorify.Api.ColorPalette;
using Vectorify.Api.Contracts;
using Vectorify.Api.Storage;

namespace Vectorify.Api.Endpoints;

/// <summary>
/// Endpoints de detección/reducción de paleta de colores (M2-S01): detectar,
/// fusionar/deshacer fusión/renombrar grupos, confirmar, y servir el preview
/// cuantizado + las máscaras por grupo ya persistidas. Arranca el flujo
/// multicapa operando directamente sobre la imagen original YA subida
/// (M1-S02); no depende de ninguna otra etapa del pipeline de MVP1.
/// </summary>
public static class ColorPaletteEndpoints
{
    public static void MapColorPaletteEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/api/v1/projects/{projectId:guid}/images/{imageId:guid}/color-palette/detect", async (
            Guid projectId,
            Guid imageId,
            ColorPaletteDetectRequest request,
            IColorPaletteService service,
            CancellationToken cancellationToken) =>
        {
            var result = await service.DetectAsync(projectId, imageId, request, cancellationToken);
            return ToHttpResult(result, created: result is ColorPaletteResult.Ready { FromCache: false });
        })
        .WithName("DetectColorPalette")
        .WithTags("ColorPalette")
        .Produces<ColorPaletteResponse>(StatusCodes.Status201Created)
        .Produces<ColorPaletteResponse>(StatusCodes.Status200OK)
        .Produces<ApiErrorResponse>(StatusCodes.Status400BadRequest)
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .WithSummary("Detecta la paleta de colores de la imagen original YA subida (arranca o continúa una sesión).")
        .WithDescription(
            "Sin `paletteId`: arranca una sesión nueva. Con `paletteId`: re-detecta bajo esa misma sesión " +
            "(debe existir y no estar confirmada); mismos parámetros -> cache-hit (crea versión nueva " +
            "reutilizando los grupos ya detectados), parámetros distintos -> llama a Python de nuevo.");

        app.MapPost("/api/v1/projects/{projectId:guid}/images/{imageId:guid}/color-palette/{paletteId:guid}/merge", async (
            Guid projectId,
            Guid imageId,
            Guid paletteId,
            ColorPaletteMergeRequest request,
            IColorPaletteService service,
            CancellationToken cancellationToken) =>
        {
            var result = await service.MergeAsync(projectId, imageId, paletteId, request, cancellationToken);
            return ToHttpResult(result, created: false);
        })
        .WithName("MergeColorPaletteGroups")
        .WithTags("ColorPalette")
        .Produces<ColorPaletteResponse>(StatusCodes.Status200OK)
        .Produces<ApiErrorResponse>(StatusCodes.Status400BadRequest)
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .Produces<ApiErrorResponse>(StatusCodes.Status409Conflict)
        .WithSummary("Fusiona 2+ grupos de color en uno solo (crea una nueva versión de la paleta).");

        app.MapPost("/api/v1/projects/{projectId:guid}/images/{imageId:guid}/color-palette/{paletteId:guid}/unmerge", async (
            Guid projectId,
            Guid imageId,
            Guid paletteId,
            ColorPaletteUnmergeRequest request,
            IColorPaletteService service,
            CancellationToken cancellationToken) =>
        {
            var result = await service.UnmergeAsync(projectId, imageId, paletteId, request, cancellationToken);
            return ToHttpResult(result, created: false);
        })
        .WithName("UnmergeColorPaletteGroup")
        .WithTags("ColorPalette")
        .Produces<ColorPaletteResponse>(StatusCodes.Status200OK)
        .Produces<ApiErrorResponse>(StatusCodes.Status400BadRequest)
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .Produces<ApiErrorResponse>(StatusCodes.Status409Conflict)
        .WithSummary("Deshace el último merge que produjo un grupo (mientras la paleta no esté confirmada).");

        app.MapPost("/api/v1/projects/{projectId:guid}/images/{imageId:guid}/color-palette/{paletteId:guid}/rename", async (
            Guid projectId,
            Guid imageId,
            Guid paletteId,
            ColorPaletteRenameRequest request,
            IColorPaletteService service,
            CancellationToken cancellationToken) =>
        {
            var result = await service.RenameAsync(projectId, imageId, paletteId, request, cancellationToken);
            return ToHttpResult(result, created: false);
        })
        .WithName("RenameColorPaletteGroup")
        .WithTags("ColorPalette")
        .Produces<ColorPaletteResponse>(StatusCodes.Status200OK)
        .Produces<ApiErrorResponse>(StatusCodes.Status400BadRequest)
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .Produces<ApiErrorResponse>(StatusCodes.Status409Conflict)
        .WithSummary("Renombra un grupo de color (crea una nueva versión de la paleta).");

        app.MapPost("/api/v1/projects/{projectId:guid}/images/{imageId:guid}/color-palette/{paletteId:guid}/exclude", async (
            Guid projectId,
            Guid imageId,
            Guid paletteId,
            ColorPaletteSetExclusionRequest request,
            IColorPaletteService service,
            CancellationToken cancellationToken) =>
        {
            var result = await service.SetExclusionAsync(projectId, imageId, paletteId, request, cancellationToken);
            return ToHttpResult(result, created: false);
        })
        .WithName("SetColorPaletteGroupExclusion")
        .WithTags("ColorPalette")
        .Produces<ColorPaletteResponse>(StatusCodes.Status200OK)
        .Produces<ApiErrorResponse>(StatusCodes.Status400BadRequest)
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .Produces<ApiErrorResponse>(StatusCodes.Status409Conflict)
        .WithSummary("Marca un grupo como incluido/excluido (M2.1-S02), independiente de un merge.");

        app.MapPost("/api/v1/projects/{projectId:guid}/images/{imageId:guid}/color-palette/{paletteId:guid}/confirm", async (
            Guid projectId,
            Guid imageId,
            Guid paletteId,
            IColorPaletteService service,
            CancellationToken cancellationToken) =>
        {
            var result = await service.ConfirmAsync(projectId, imageId, paletteId, cancellationToken);
            return ToHttpResult(result, created: false);
        })
        .WithName("ConfirmColorPalette")
        .WithTags("ColorPalette")
        .Produces<ColorPaletteResponse>(StatusCodes.Status200OK)
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .Produces<ApiErrorResponse>(StatusCodes.Status409Conflict)
        .WithSummary("Confirma la paleta final: queda como entrada declarada de M2-S02 (no genera capas SVG en esta tarjeta).");

        app.MapGet("/api/v1/projects/{projectId:guid}/images/{imageId:guid}/color-palette/{paletteId:guid}", (
            Guid projectId,
            Guid imageId,
            Guid paletteId,
            IColorPaletteService service) =>
        {
            var record = service.FindLatest(projectId, imageId, paletteId);
            return record is null
                ? Results.NotFound(new ApiErrorResponse("not_found", "No existe una sesión de paleta de colores con ese ID para esta imagen."))
                : Results.Ok(ToResponse(record, cached: false));
        })
        .WithName("GetColorPalette")
        .WithTags("ColorPalette")
        .Produces<ColorPaletteResponse>(StatusCodes.Status200OK)
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .WithSummary("Recupera la última versión vigente de una sesión de paleta de colores.");

        app.MapGet("/api/v1/projects/{projectId:guid}/images/{imageId:guid}/color-palette/{paletteId:guid}/preview", async (
            Guid projectId,
            Guid imageId,
            Guid paletteId,
            IColorPaletteService service,
            IFileStorage fileStorage,
            CancellationToken cancellationToken) =>
        {
            var record = service.FindLatest(projectId, imageId, paletteId);
            if (record is null)
            {
                return Results.NotFound(new ApiErrorResponse("not_found", "No existe una sesión de paleta de colores con ese ID para esta imagen."));
            }

            try
            {
                var stream = await fileStorage.OpenReadAsync(record.QuantizedPreviewStorageKey, cancellationToken);
                return Results.Stream(stream, "image/png");
            }
            catch (FileNotFoundException)
            {
                return Results.NotFound(new ApiErrorResponse("not_found", "El preview existe en el registro pero ya no está disponible en el storage."));
            }
        })
        .WithName("GetColorPalettePreview")
        .WithTags("ColorPalette")
        .Produces(StatusCodes.Status200OK, contentType: "image/png")
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .WithSummary("Recupera el preview cuantizado (PNG) de la última versión de una sesión de paleta de colores.");

        app.MapGet("/api/v1/projects/{projectId:guid}/images/{imageId:guid}/color-palette/{paletteId:guid}/groups/{groupId:guid}/mask", async (
            Guid projectId,
            Guid imageId,
            Guid paletteId,
            Guid groupId,
            IColorPaletteService service,
            IFileStorage fileStorage,
            CancellationToken cancellationToken) =>
        {
            var record = service.FindLatest(projectId, imageId, paletteId);
            var group = record?.Groups.FirstOrDefault(g => g.GroupId == groupId);
            if (group is null)
            {
                return Results.NotFound(new ApiErrorResponse("not_found", "No existe ese grupo en la última versión de la paleta."));
            }

            try
            {
                var stream = await fileStorage.OpenReadAsync(group.MaskStorageKey, cancellationToken);
                return Results.Stream(stream, "image/png");
            }
            catch (FileNotFoundException)
            {
                return Results.NotFound(new ApiErrorResponse("not_found", "La máscara existe en el registro pero ya no está disponible en el storage."));
            }
        })
        .WithName("GetColorPaletteGroupMask")
        .WithTags("ColorPalette")
        .Produces(StatusCodes.Status200OK, contentType: "image/png")
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .WithSummary("Recupera la máscara binaria (PNG) de un grupo de color -- entrada declarada de M2-S02.");
    }

    private static IResult ToHttpResult(ColorPaletteResult result, bool created) => result switch
    {
        ColorPaletteResult.Ready ready when created => Results.Created(
            ColorPaletteUrl(ready.Record.ProjectId, ready.Record.ImageId, ready.Record.PaletteId),
            ToResponse(ready.Record, ready.FromCache)),
        ColorPaletteResult.Ready ready => Results.Ok(ToResponse(ready.Record, ready.FromCache)),
        ColorPaletteResult.NotFound notFound => Results.NotFound(new ApiErrorResponse(notFound.Code, notFound.Message)),
        ColorPaletteResult.ValidationFailed failed => Results.BadRequest(new ApiErrorResponse(failed.Code, failed.Message)),
        ColorPaletteResult.Conflict conflict => Results.Conflict(new ApiErrorResponse(conflict.Code, conflict.Message)),
        ColorPaletteResult.UpstreamError error => Results.Json(
            new ApiErrorResponse(error.Code, error.Message), statusCode: StatusCodeFor(error.Code)),
        _ => Results.Json(
            new ApiErrorResponse("internal_error", "Ocurrió un error inesperado al procesar la paleta de colores."),
            statusCode: StatusCodes.Status500InternalServerError),
    };

    private static ColorPaletteResponse ToResponse(ColorPaletteVersion record, bool cached) => new(
        record.ProjectId,
        record.ImageId,
        record.PaletteId,
        record.Version,
        record.DetectionParameters.Tolerance,
        record.DetectionParameters.MaxColors,
        record.DetectionParameters.TinyAreaRatio,
        record.SourceWidthPx,
        record.SourceHeightPx,
        record.TransparentPercent,
        record.Groups.Select(g => ToGroupPayload(record, g)).ToList(),
        PreviewUrl: $"{ColorPaletteUrl(record.ProjectId, record.ImageId, record.PaletteId)}/preview",
        record.IsConfirmed,
        cached,
        GroupingStyle: record.DetectionParameters.GroupingStyle,
        TargetFamilies: record.DetectionParameters.TargetFamilies,
        GroupingStrength: record.DetectionParameters.GroupingStrength,
        AlgorithmVersion: record.DetectionParameters.AlgorithmVersion,
        FamilyCount: record.Groups.Count(g => !g.IsBackground),
        PieceCount: record.Groups.Where(g => !g.IsBackground).Sum(g => g.PieceCount),
        BackgroundCorrections: record.DetectionParameters.BackgroundCorrections,
        Background: record.Background is null
            ? null
            : new ColorPaletteBackgroundPayload(
                record.Background.AreaPercent, record.Background.AmbiguousPercent,
                record.Background.ContactPercent, record.Background.NeedsReview));

    private static ColorGroupPayload ToGroupPayload(ColorPaletteVersion record, ColorGroup group) => new(
        group.GroupId,
        group.Name,
        group.ColorHex,
        ToRgb(group.ColorHex),
        group.PixelCount,
        group.AreaPercent,
        group.HasPartialAlpha,
        group.IsExcluded,
        MaskUrl: $"{ColorPaletteUrl(record.ProjectId, record.ImageId, record.PaletteId)}/groups/{group.GroupId}/mask",
        IsMerged: group.MergedFrom is { Count: > 0 },
        IsBackground: group.IsBackground,
        PieceCount: group.PieceCount,
        SourceGroupCount: group.SourceGroupCount);

    /// <summary>
    /// Parsea "#rrggbb" (formato ya validado aguas arriba por
    /// PythonColorPaletteClient.IsValidHexColor -- nunca llega acá un
    /// ColorHex mal formado) a sus tres componentes RGB explícitos -- ver
    /// RgbColor, contrato aditivo de M2.1-S02.
    /// </summary>
    private static RgbColor ToRgb(string colorHex) => new(
        Convert.ToInt32(colorHex.Substring(1, 2), 16),
        Convert.ToInt32(colorHex.Substring(3, 2), 16),
        Convert.ToInt32(colorHex.Substring(5, 2), 16));

    private static string ColorPaletteUrl(Guid projectId, Guid imageId, Guid paletteId) =>
        $"/api/v1/projects/{projectId}/images/{imageId}/color-palette/{paletteId}";

    private static int StatusCodeFor(string code) => code switch
    {
        "dimensions_exceeded" => StatusCodes.Status413PayloadTooLarge,
        "corrupt_image" => StatusCodes.Status400BadRequest,
        "invalid_parameters" => StatusCodes.Status422UnprocessableEntity,
        "timeout" => StatusCodes.Status504GatewayTimeout,
        "engine_unavailable" => StatusCodes.Status503ServiceUnavailable,
        "invalid_response" => StatusCodes.Status502BadGateway,
        _ => StatusCodes.Status500InternalServerError,
    };
}
