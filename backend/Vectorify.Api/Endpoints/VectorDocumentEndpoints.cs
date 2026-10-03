using Vectorify.Api.Contracts;
using Vectorify.Api.Data;
using Vectorify.Api.ManufacturingOperations;
using Vectorify.Api.VectorDocuments;

namespace Vectorify.Api.Endpoints;

/// <summary>
/// Endpoints de persistencia completa del <c>VectorDocument</c> (M2.2-S05): Guardar (crea el
/// <c>Project</c> v2 en el primer Save, o agrega una <c>DocumentVersion</c> nueva en
/// subsiguientes), reabrir el documento guardado, y mutaciones puntuales por capa
/// post-Save (sub-recursos de <c>Layer</c>, cutover de los sidecars clásicos). Mismo patrón
/// arquitectónico que <see cref="ProjectV2Endpoints"/>/<see cref="AssetEndpoints"/>: Endpoint
/// (acá) -&gt; <see cref="IVectorDocumentService"/> -&gt;
/// <see cref="Vectorify.Api.VectorDocuments.Persistence.IVectorDocumentRepository"/> -&gt; EF
/// Core. Ningún endpoint de acá toca <see cref="Vectorify.Api.Data.VectorizationDbContext"/>
/// directamente.
/// </summary>
public static class VectorDocumentEndpoints
{
    public static void MapVectorDocumentEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/api/v2/workspaces/save", async (
            VectorDocumentSaveRequest request,
            IVectorDocumentService service,
            CancellationToken cancellationToken) =>
        {
            var result = await service.SaveAsync(request, cancellationToken);
            return result switch
            {
                VectorDocumentResult.Saved saved when request.ProjectId is null => Results.Created(
                    $"/api/v2/projects/{saved.ProjectId}", ToSaveResponse(saved)),
                VectorDocumentResult.Saved saved => Results.Ok(ToSaveResponse(saved)),
                VectorDocumentResult.NotFound notFound => Results.NotFound(new ApiErrorResponse(notFound.Code, notFound.Message)),
                VectorDocumentResult.ValidationFailed failed => Results.BadRequest(new ApiErrorResponse(failed.Code, failed.Message)),
                VectorDocumentResult.Conflict conflict => Results.Conflict(new ApiErrorResponse(conflict.Code, conflict.Message)),
                VectorDocumentResult.UpstreamError error => UnprocessableEntity(error.Code, error.Message),
                _ => UnexpectedResult(),
            };
        })
        .WithName("SaveWorkspace")
        .WithTags("VectorDocuments")
        .Produces<VectorDocumentSaveResponse>(StatusCodes.Status201Created)
        .Produces<VectorDocumentSaveResponse>(StatusCodes.Status200OK)
        .Produces<ApiErrorResponse>(StatusCodes.Status400BadRequest)
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .Produces<ApiErrorResponse>(StatusCodes.Status409Conflict)
        .Produces<ApiErrorResponse>(StatusCodes.Status422UnprocessableEntity)
        .WithSummary("Guarda el VectorDocument vigente de una sesión de Workspace: crea el Project v2 en el primer Save, agrega una DocumentVersion nueva en los siguientes.")
        .WithDescription(
            "Resuelve el layer set/paleta/layout/operaciones VIGENTES del triple clásico (classicProjectId/imageId/" +
            "paletteId) -- nunca confía en geometría/metadata mandada por el cliente. 422 (UpstreamError) si falta " +
            "algún estado clásico precondición (paleta no confirmada, layer set inexistente, SVG de una capa ya no " +
            "disponible). 409 si otro Save concurrente modificó el mismo Project entre medio (concurrencia " +
            "optimista vía xmin, igual que ProjectV2Endpoints).");

        app.MapGet("/api/v2/projects/{projectId:guid}/document", async (
            Guid projectId,
            IVectorDocumentService service,
            CancellationToken cancellationToken) =>
        {
            var result = await service.GetDocumentAsync(projectId, versionNumber: null, cancellationToken);
            return result switch
            {
                VectorDocumentResult.DocumentReady ready => Results.Ok(ToDocumentResponse(projectId, ready.Version)),
                VectorDocumentResult.NotFound notFound => Results.NotFound(new ApiErrorResponse(notFound.Code, notFound.Message)),
                VectorDocumentResult.UpstreamError error => UnprocessableEntity(error.Code, error.Message),
                _ => UnexpectedResult(),
            };
        })
        .WithName("GetVectorDocument")
        .WithTags("VectorDocuments")
        .Produces<VectorDocumentResponse>(StatusCodes.Status200OK)
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .Produces<ApiErrorResponse>(StatusCodes.Status422UnprocessableEntity)
        .WithSummary("Recupera la DocumentVersion ACTUAL (Project.CurrentVersionId) completa: dimensiones, viewBox, layers (con URL de descarga de su Asset) y paleta.")
        .WithDescription(
            "Atajo para \"la versión actual\" -- equivalente a resolver Project.CurrentVersionId y llamar a " +
            "GET .../versions/{versionNumber} con ese número (M2.2-S06), sin duplicar lógica entre ambos. 404 " +
            "uniforme si el proyecto no existe, no es del usuario efectivo, o todavía no tiene ningún documento " +
            "guardado. 422 (unsupported_schema_version) si el documento usa un SchemaVersion mayor al que este " +
            "backend entiende -- nunca intenta leerlo igual.");

        app.MapGet("/api/v2/projects/{projectId:guid}/versions", async (
            Guid projectId,
            IVectorDocumentService service,
            CancellationToken cancellationToken) =>
        {
            var result = await service.ListVersionsAsync(projectId, cancellationToken);
            return result switch
            {
                VectorDocumentResult.VersionListReady ready => Results.Ok(ready.Versions.Select(ToVersionSummaryResponse).ToList()),
                VectorDocumentResult.NotFound notFound => Results.NotFound(new ApiErrorResponse(notFound.Code, notFound.Message)),
                _ => UnexpectedResult(),
            };
        })
        .WithName("ListVectorDocumentVersions")
        .WithTags("VectorDocuments")
        .Produces<IReadOnlyList<VectorDocumentVersionSummaryResponse>>(StatusCodes.Status200OK)
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .WithSummary("Lista TODAS las versiones del documento de un proyecto (metadata, sin layers), orden versionNumber descendente (M2.2-S06).")
        .WithDescription(
            "404 uniforme si el proyecto no existe, no es del usuario efectivo, o todavía no tiene ningún " +
            "documento guardado. Sin paginación (alcance de esta tarjeta).");

        app.MapGet("/api/v2/projects/{projectId:guid}/versions/{versionNumber:int}", async (
            Guid projectId,
            int versionNumber,
            IVectorDocumentService service,
            CancellationToken cancellationToken) =>
        {
            var result = await service.GetDocumentAsync(projectId, versionNumber, cancellationToken);
            return result switch
            {
                VectorDocumentResult.DocumentReady ready => Results.Ok(ToDocumentResponse(projectId, ready.Version)),
                VectorDocumentResult.NotFound notFound => Results.NotFound(new ApiErrorResponse(notFound.Code, notFound.Message)),
                VectorDocumentResult.UpstreamError error => UnprocessableEntity(error.Code, error.Message),
                _ => UnexpectedResult(),
            };
        })
        .WithName("GetVectorDocumentVersion")
        .WithTags("VectorDocuments")
        .Produces<VectorDocumentResponse>(StatusCodes.Status200OK)
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .Produces<ApiErrorResponse>(StatusCodes.Status422UnprocessableEntity)
        .WithSummary("Recupera CUALQUIER versión histórica completa del documento de un proyecto (mismo shape que GET .../document, M2.2-S06).")
        .WithDescription(
            "404 uniforme si el proyecto no existe, no es del usuario efectivo, todavía no tiene ningún " +
            "documento guardado, o versionNumber no existe para ese documento. 422 (unsupported_schema_version) " +
            "si esa versión usa un SchemaVersion mayor al que este backend entiende.");

        app.MapPost("/api/v2/projects/{projectId:guid}/versions/{versionNumber:int}/restore", async (
            Guid projectId,
            int versionNumber,
            IVectorDocumentService service,
            CancellationToken cancellationToken) =>
        {
            var result = await service.RestoreAsync(projectId, versionNumber, cancellationToken);
            return result switch
            {
                VectorDocumentResult.Saved saved => Results.Ok(ToSaveResponse(saved)),
                VectorDocumentResult.NotFound notFound => Results.NotFound(new ApiErrorResponse(notFound.Code, notFound.Message)),
                VectorDocumentResult.Conflict conflict => Results.Conflict(new ApiErrorResponse(conflict.Code, conflict.Message)),
                _ => UnexpectedResult(),
            };
        })
        .WithName("RestoreVectorDocumentVersion")
        .WithTags("VectorDocuments")
        .Produces<VectorDocumentSaveResponse>(StatusCodes.Status200OK)
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .Produces<ApiErrorResponse>(StatusCodes.Status409Conflict)
        .WithSummary("Restaura versionNumber como una DocumentVersion nueva (siguiente número secuencial) -- nunca borra/modifica las versiones intermedias (M2.2-S06).")
        .WithDescription(
            "Copia fresca (ids nuevos, mismos SvgAssetId reusados tal cual) de layers/paleta/dimensiones/viewBox/" +
            "schemaVersion de la versión origen, Origin: RESTORE, repunta Project.CurrentVersionId a la versión " +
            "nueva. 404 si la versión origen no existe. 409 si otro Save/Restore concurrente modificó el mismo " +
            "Project entre medio (concurrencia optimista vía xmin, igual que /workspaces/save).");

        app.MapPatch("/api/v2/projects/{projectId:guid}/layers/{layerId:guid}", async (
            Guid projectId,
            Guid layerId,
            UpdateLayerRequest request,
            IVectorDocumentService service,
            CancellationToken cancellationToken) =>
        {
            var result = await service.UpdateLayerAsync(projectId, layerId, request, cancellationToken);
            return result switch
            {
                VectorDocumentResult.LayerReady ready => Results.Ok(ToLayerResponse(projectId, ready.Layer)),
                VectorDocumentResult.NotFound notFound => Results.NotFound(new ApiErrorResponse(notFound.Code, notFound.Message)),
                VectorDocumentResult.ValidationFailed failed => Results.BadRequest(new ApiErrorResponse(failed.Code, failed.Message)),
                VectorDocumentResult.Conflict conflict => Results.Conflict(new ApiErrorResponse(conflict.Code, conflict.Message)),
                _ => UnexpectedResult(),
            };
        })
        .WithName("UpdateVectorDocumentLayer")
        .WithTags("VectorDocuments")
        .Produces<VectorDocumentLayerResponse>(StatusCodes.Status200OK)
        .Produces<ApiErrorResponse>(StatusCodes.Status400BadRequest)
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .Produces<ApiErrorResponse>(StatusCodes.Status409Conflict)
        .WithSummary("Actualiza order/visible/locked/name/operación de una capa YA guardada (cutover de los sidecars clásicos tras el primer Save).")
        .WithDescription(
            "Campo null = sin cambios (mismo criterio PATCH que ProjectV2Endpoints). manufacturingOperation acepta " +
            "además 'unassigned' para vaciar explícitamente la asignación. Es, igual que Save/Restore, un checkpoint " +
            "nuevo (M2.2-S06 fix): crea una DocumentVersion completa nueva con el patch aplicado, nunca muta la " +
            "versión actual in-place -- 404 si la capa no existe en la DocumentVersion ACTUAL del proyecto (pertenece " +
            "a una versión histórica ya superada), o si el proyecto no existe/no es del usuario efectivo. 409 si otro " +
            "Save/Restore/PATCH concurrente modificó el mismo Project entre medio (concurrencia optimista vía xmin).");
    }

    private static VectorDocumentSaveResponse ToSaveResponse(VectorDocumentResult.Saved saved) =>
        new(saved.ProjectId, saved.VersionNumber, saved.SavedAt);

    private static VectorDocumentVersionSummaryResponse ToVersionSummaryResponse(DocumentVersion version) => new(
        version.VersionNumber,
        DocumentVersionOriginParser.ToWireValue(version.Origin),
        version.CreatedAt,
        version.WidthMm,
        version.HeightMm,
        version.ViewBox,
        version.SchemaVersion);

    // M2.2-S06: WidthMm/HeightMm/ViewBox/SchemaVersion viven ahora en DocumentVersion (ver el
    // conflicto #2 de spec.md M2.2-S06), ya no en VectorDocument -- este método no necesita el
    // VectorDocument para nada (projectId ya viene de la ruta).
    private static VectorDocumentResponse ToDocumentResponse(Guid projectId, DocumentVersion version) =>
        new(
            projectId,
            version.SchemaVersion,
            version.WidthMm,
            version.HeightMm,
            version.ViewBox,
            version.VersionNumber,
            version.CreatedAt,
            version.Layers
                .OrderBy(layer => layer.Order)
                .Select(layer => ToLayerResponse(projectId, layer))
                .ToList());

    // M2.2-S06: expone Layer.GroupId (el groupId clásico, estable a través de versiones) como
    // "Id" del contrato -- Layer.Id (la PK real) ya NO es estable entre versiones (cada
    // checkpoint inserta una fila nueva, ver el conflicto #1 de spec.md M2.2-S06). El frontend
    // reconstruye VectorDocumentLayer.groupId a partir de este campo sin ningún cambio de
    // contrato de su lado.
    private static VectorDocumentLayerResponse ToLayerResponse(Guid projectId, Layer layer) => new(
        layer.GroupId,
        layer.Name,
        layer.Order,
        layer.Visible,
        layer.Locked,
        layer.ManufacturingOperation is { } kind
            ? ManufacturingOperationParser.ToWireValue(kind)
            : ManufacturingOperationParser.UnassignedWireValue,
        layer.Color?.Hex ?? string.Empty,
        layer.Color?.Coverage ?? 0,
        layer.Color?.IsBackground ?? false,
        layer.SvgAssetId,
        layer.SvgAssetId is { } assetId ? $"/api/v2/projects/{projectId}/assets/{assetId}" : null,
        layer.PathCount);

    private static IResult UnprocessableEntity(string code, string message) => Results.Json(
        new ApiErrorResponse(code, message), statusCode: StatusCodes.Status422UnprocessableEntity);

    private static IResult UnexpectedResult() => Results.Json(
        new ApiErrorResponse("internal_error", "Ocurrió un error inesperado al procesar el documento."),
        statusCode: StatusCodes.Status500InternalServerError);
}
