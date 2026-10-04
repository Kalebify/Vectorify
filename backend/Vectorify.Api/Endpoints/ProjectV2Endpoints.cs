using Vectorify.Api.Contracts;
using Vectorify.Api.Data;
using Vectorify.Api.ProjectManagement;
using Vectorify.Api.Projects.Persistence;

namespace Vectorify.Api.Endpoints;

/// <summary>
/// API CRUD NUEVA de proyectos persistentes (M2.2-S03), bajo <c>/api/v2/projects</c> --
/// deliberadamente NO bajo <c>/api/v1/projects</c> (ver spec.md, "⚠️ Conflicto real
/// detectado"): esa ruta ya existe en <see cref="ProjectEndpoints"/> para el flujo clásico
/// de upload (MVP1, <c>ProjectRecord</c>/<c>IProjectRegistry</c>), un concepto de dominio
/// completamente distinto (par ProjectId+ImageId de un archivo subido, sin ownership) que
/// coincide en nombre por casualidad. Esta clase NO toca <see cref="ProjectEndpoints"/> ni
/// nada de <c>Vectorify.Api.Projects</c> (namespace del flujo clásico).
///
/// Arquitectura: Endpoint (acá) -&gt; <see cref="IProjectService"/> -&gt;
/// <see cref="Vectorify.Api.Projects.Persistence.IProjectRepository"/> -&gt; EF Core.
/// Ningún endpoint de acá toca <see cref="Vectorify.Api.Data.VectorizationDbContext"/>
/// directamente.
/// </summary>
public static class ProjectV2Endpoints
{
    public static void MapProjectV2Endpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/api/v2/projects", async (
            CreateProjectRequest request,
            IProjectService service,
            CancellationToken cancellationToken) =>
        {
            var result = await service.CreateAsync(request.Name, request.Description, cancellationToken);
            return result switch
            {
                ProjectResult.Ready ready => Results.Created(
                    $"/api/v2/projects/{ready.Record.Id}", ToResponse(ready.Record)),
                ProjectResult.ValidationFailed failed => Results.BadRequest(new ApiErrorResponse(failed.Code, failed.Message)),
                _ => UnexpectedResult(),
            };
        })
        .WithName("CreateProjectV2")
        .WithTags("ProjectsV2")
        .Produces<ProjectResponse>(StatusCodes.Status201Created)
        .Produces<ApiErrorResponse>(StatusCodes.Status400BadRequest)
        .WithSummary("Crea un Project persistente nuevo (Name requerido, Description opcional). OwnerId = usuario efectivo (IUserContext).")
        .WithDescription(
            "NO sube ningún archivo -- eso sigue siendo responsabilidad del flujo clásico (POST /api/v1/projects) " +
            "o de una tarjeta posterior que conecte ambos mundos. Ver spec.md M2.2-S03.");

        app.MapGet("/api/v2/projects", async (
            int? page,
            int? pageSize,
            string? search,
            string? sortBy,
            IProjectService service,
            CancellationToken cancellationToken) =>
        {
            var result = await service.ListAsync(page, pageSize, search, sortBy, cancellationToken);
            return result switch
            {
                ProjectResult.ListReady ready => Results.Ok(new ProjectListResponse(
                    ready.Items.Select(ToSummary).ToList(), ready.Page, ready.PageSize, ready.TotalCount)),
                ProjectResult.ValidationFailed failed => Results.BadRequest(new ApiErrorResponse(failed.Code, failed.Message)),
                _ => UnexpectedResult(),
            };
        })
        .WithName("ListProjectsV2")
        .WithTags("ProjectsV2")
        .Produces<ProjectListResponse>(StatusCodes.Status200OK)
        .Produces<ApiErrorResponse>(StatusCodes.Status400BadRequest)
        .WithSummary("Lista los proyectos del usuario efectivo: paginado (page/pageSize, máx. 100), búsqueda por nombre y orden.")
        .WithDescription(
            "sortBy acepta 'LastModified' (default, UpdatedAt descendente), 'Name' (alfabético ascendente) o " +
            "'Created' (CreatedAt descendente) -- case-insensitive. search filtra por coincidencia parcial de " +
            "Name (case-insensitive). Nunca incluye proyectos soft-deleteados (filtro global de M2.2-S02).");

        app.MapGet("/api/v2/projects/{id:guid}", async (
            Guid id,
            IProjectService service,
            CancellationToken cancellationToken) =>
        {
            var result = await service.GetAsync(id, cancellationToken);
            return ToHttpResult(result);
        })
        .WithName("GetProjectV2")
        .WithTags("ProjectsV2")
        .Produces<ProjectResponse>(StatusCodes.Status200OK)
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .WithSummary("Recupera un proyecto por Id.")
        .WithDescription(
            "404 si no existe O si existe pero pertenece a otro usuario -- mismo comportamiento para ambos casos, " +
            "nunca revela que el recurso existe a un usuario no autorizado.");

        app.MapPatch("/api/v2/projects/{id:guid}", async (
            Guid id,
            UpdateProjectRequest request,
            IProjectService service,
            CancellationToken cancellationToken) =>
        {
            var result = await service.UpdateAsync(id, request.Name, request.Description, cancellationToken);
            return ToHttpResult(result);
        })
        .WithName("UpdateProjectV2")
        .WithTags("ProjectsV2")
        .Produces<ProjectResponse>(StatusCodes.Status200OK)
        .Produces<ApiErrorResponse>(StatusCodes.Status400BadRequest)
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .Produces<ApiErrorResponse>(StatusCodes.Status409Conflict)
        .WithSummary("Renombra y/o actualiza la descripción de un proyecto (rename).")
        .WithDescription(
            "Campo null = sin cambios (ver ProjectRequests.cs). Mismo criterio 404 de ownership que GET. 409 " +
            "concurrency_conflict si otra request modificó el proyecto entre que se leyó y se escribió " +
            "(concurrencia optimista vía la columna de sistema xmin de PostgreSQL).");

        app.MapDelete("/api/v2/projects/{id:guid}", async (
            Guid id,
            IProjectService service,
            CancellationToken cancellationToken) =>
        {
            var result = await service.DeleteAsync(id, cancellationToken);
            return result switch
            {
                ProjectResult.Deleted => Results.NoContent(),
                ProjectResult.NotFound notFound => Results.NotFound(new ApiErrorResponse(notFound.Code, notFound.Message)),
                _ => UnexpectedResult(),
            };
        })
        .WithName("DeleteProjectV2")
        .WithTags("ProjectsV2")
        .Produces(StatusCodes.Status204NoContent)
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .WithSummary("Soft-delete de un proyecto (setea DeletedAt; el global query filter de M2.2-S02 lo excluye de listados/GET a partir de ahora).")
        .WithDescription(
            "Los Assets del proyecto NO se tocan (ni se borran ni se desvinculan) -- siguen existiendo en la " +
            "tabla, ver IMPL.md. Mismo criterio 404 de ownership que GET.");

        app.MapPost("/api/v2/projects/{id:guid}/duplicate", async (
            Guid id,
            IProjectService service,
            CancellationToken cancellationToken) =>
        {
            var result = await service.DuplicateAsync(id, cancellationToken);
            return result switch
            {
                ProjectResult.Ready ready => Results.Created(
                    $"/api/v2/projects/{ready.Record.Id}", ToResponse(ready.Record)),
                ProjectResult.NotFound notFound => Results.NotFound(new ApiErrorResponse(notFound.Code, notFound.Message)),
                _ => UnexpectedResult(),
            };
        })
        .WithName("DuplicateProjectV2")
        .WithTags("ProjectsV2")
        .Produces<ProjectResponse>(StatusCodes.Status201Created)
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .WithSummary("Duplica un proyecto: nuevo Project.Id, nuevo Name ('Copia de X'), copia Description/OwnerId.")
        .WithDescription(
            "Si el origen tiene VectorDocument/DocumentVersion/Layer/PaletteColor asociados, los duplica también " +
            "con Ids nuevos propios (nunca reutiliza Ids del original). Los Assets referenciados (SVG de " +
            "cada capa y thumbnail) se copian como filas propias del duplicado con Ids nuevos, apuntando al mismo " +
            "contenido en storage (el binario no se re-copia).");
    }

    private static IResult ToHttpResult(ProjectResult result) => result switch
    {
        ProjectResult.Ready ready => Results.Ok(ToResponse(ready.Record)),
        ProjectResult.NotFound notFound => Results.NotFound(new ApiErrorResponse(notFound.Code, notFound.Message)),
        ProjectResult.ValidationFailed failed => Results.BadRequest(new ApiErrorResponse(failed.Code, failed.Message)),
        ProjectResult.Conflict conflict => Results.Conflict(new ApiErrorResponse(conflict.Code, conflict.Message)),
        _ => UnexpectedResult(),
    };

    private static IResult UnexpectedResult() => Results.Json(
        new ApiErrorResponse("internal_error", "Ocurrió un error inesperado al procesar el proyecto."),
        statusCode: StatusCodes.Status500InternalServerError);

    private static ProjectResponse ToResponse(Project project) => new(
        project.Id,
        project.OwnerId,
        project.Name,
        project.Description,
        project.ThumbnailAssetId,
        project.CurrentVersionId,
        project.CreatedAt,
        project.UpdatedAt,
        project.ClassicProjectId,
        project.ClassicImageId,
        project.ClassicPaletteId);

    private static ProjectSummaryResponse ToSummary(ProjectListItem item)
    {
        var project = item.Project;

        var thumbnailUrl = project.ThumbnailAssetId is { } assetId
            ? $"/api/v2/projects/{project.Id}/assets/{assetId}"
            : null;

        return new ProjectSummaryResponse(
            project.Id,
            project.Name,
            project.ThumbnailAssetId,
            project.CreatedAt,
            project.UpdatedAt,
            item.LayerCount,
            thumbnailUrl,
            project.ClassicProjectId,
            project.ClassicImageId,
            project.ClassicPaletteId);
    }
}
