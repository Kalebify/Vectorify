using Vectorify.Api.Contracts;
using Vectorify.Api.Projects;
using Vectorify.Api.Storage;
using Vectorify.Api.Users;

namespace Vectorify.Api.Endpoints;

/// <summary>
/// Endpoints versionados de carga y recuperación de proyectos/imágenes
/// (POST /api/v1/projects, GET .../original). El original solo se lee/escribe acá;
/// nunca se modifica una vez guardado.
/// </summary>
public static class ProjectEndpoints
{
    public const string IdempotencyHeaderName = "Idempotency-Key";
    private const string FileFieldName = "file";

    public static void MapProjectEndpoints(this IEndpointRouteBuilder app)
    {
        // Crea un proyecto a partir de una imagen. multipart/form-data con un campo
        // "file" (PNG/JPG/WEBP). El formulario se lee manualmente (en vez de dejar
        // que el binding automático de IFormFile lo haga) para poder controlar el
        // caso de una carga que se interrumpe a mitad de la subida (IOException/
        // OperationCanceledException al leer el body) y devolver un error
        // "upload_interrupted" en vez de una excepción sin manejar.
        app.MapPost("/api/v1/projects", async (
            HttpRequest request,
            IProjectUploadService uploadService,
            ILogger<Program> logger,
            CancellationToken cancellationToken) =>
        {
            IFormFile? file;
            try
            {
                if (!request.HasFormContentType)
                {
                    return Results.BadRequest(new ApiErrorResponse(
                        "unsupported_format",
                        "La solicitud debe ser multipart/form-data con un campo 'file'."));
                }

                var form = await request.ReadFormAsync(cancellationToken);
                file = form.Files.GetFile(FileFieldName);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                // El cliente cortó la conexión de verdad: no hay a quién responderle.
                throw;
            }
            catch (Exception ex)
            {
                // Cualquier fallo leyendo/parseando el cuerpo multipart (conexión cortada a
                // mitad de la subida, límite excedido, formulario malformado) se trata como
                // carga interrumpida en vez de dejar una excepción sin manejar (500).
                logger.LogWarning(ex, "La carga se interrumpió o el formulario multipart no se pudo leer");
                return Results.BadRequest(new ApiErrorResponse(
                    "upload_interrupted",
                    "La carga se interrumpió antes de completarse. Intentá de nuevo."));
            }

            var idempotencyKey = request.Headers[IdempotencyHeaderName].FirstOrDefault();

            ProjectUploadResult result;
            try
            {
                result = await uploadService.UploadAsync(file, idempotencyKey, cancellationToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogError(ex, "Error inesperado al procesar la carga de imagen");
                return Results.Json(
                    new ApiErrorResponse("internal_error", "Ocurrió un error inesperado al procesar la carga."),
                    statusCode: StatusCodes.Status500InternalServerError);
            }

            return result switch
            {
                ProjectUploadResult.Created created => Results.Created(
                    OriginalImageUrl(created.Response.ProjectId, created.Response.ImageId),
                    created.Response),
                ProjectUploadResult.Replayed replayed => Results.Ok(replayed.Response),
                ProjectUploadResult.ValidationFailed failed =>
                    Results.BadRequest(new ApiErrorResponse(failed.Code, failed.Message)),
                ProjectUploadResult.StorageFailed failure => Results.Json(
                    new ApiErrorResponse("storage_failure", failure.Message),
                    statusCode: StatusCodes.Status500InternalServerError),
                _ => Results.Json(
                    new ApiErrorResponse("internal_error", "Ocurrió un error inesperado al procesar la carga."),
                    statusCode: StatusCodes.Status500InternalServerError),
            };
        })
        .WithName("CreateProjectFromImage")
        .WithTags("Projects")
        .Accepts<IFormFile>("multipart/form-data")
        .Produces<UploadImageResponse>(StatusCodes.Status201Created)
        .Produces<UploadImageResponse>(StatusCodes.Status200OK)
        .Produces<ApiErrorResponse>(StatusCodes.Status400BadRequest)
        .Produces<ApiErrorResponse>(StatusCodes.Status500InternalServerError)
        .WithSummary("Crea un proyecto a partir de una imagen original (PNG/JPG/WEBP).")
        .WithDescription(
            "Recibe multipart/form-data con un campo 'file'. Valida MIME, extensión, " +
            "tamaño máximo y que el archivo no esté vacío ni corrupto; genera projectId/" +
            "imageId y guarda el original mediante IFileStorage sin modificarlo. El header " +
            "opcional 'Idempotency-Key' evita duplicar el proyecto ante un reintento del " +
            "mismo envío: si se repite la clave, se devuelve 200 con el proyecto ya creado " +
            "en vez de crear uno nuevo.");

        // Metadata JSON de un proyecto/imagen ya subida (M2.1-S08): permite reconstruir
        // `activeProject` del lado del cliente a partir de una URL (deep-link/reload del
        // Workspace) sin volver a subir el archivo. Mismo shape que UploadImageResponse.
        app.MapGet("/api/v1/projects/{projectId:guid}/images/{imageId:guid}", (
            Guid projectId,
            Guid imageId,
            IProjectRegistry registry,
            IUserContext userContext) =>
        {
            // M2.2-S09: un registro de otro usuario es un 404 idéntico al de uno inexistente.
            var record = registry.Find(projectId, imageId);
            if (record is null || !record.IsAccessibleBy(userContext.GetEffectiveUserId()))
            {
                return Results.NotFound(new ApiErrorResponse("not_found", "No existe un proyecto/imagen con esos IDs."));
            }

            return Results.Ok(new UploadImageResponse(
                record.ProjectId,
                record.ImageId,
                record.FileName,
                record.MimeType,
                record.Bytes,
                record.Width,
                record.Height,
                record.Status));
        })
        .WithName("GetProjectImageMetadata")
        .WithTags("Projects")
        .Produces<UploadImageResponse>(StatusCodes.Status200OK)
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .WithSummary("Recupera la metadata (filename/dimensiones) de un proyecto/imagen ya cargada, sin su binario.")
        .WithDescription(
            "404 uniforme si no existe O si fue subida por otro usuario (M2.2-S09). Los registros previos a esa " +
            "tarjeta no tienen dueño y siguen siendo accesibles.");

        // Recupera el original guardado, sin procesarlo (fuera de alcance de este sprint).
        app.MapGet("/api/v1/projects/{projectId:guid}/images/{imageId:guid}/original", async (
            Guid projectId,
            Guid imageId,
            IProjectRegistry registry,
            IUserContext userContext,
            IFileStorage fileStorage,
            CancellationToken cancellationToken) =>
        {
            var record = registry.Find(projectId, imageId);
            if (record is null || !record.IsAccessibleBy(userContext.GetEffectiveUserId()))
            {
                return Results.NotFound(new ApiErrorResponse("not_found", "No existe un proyecto/imagen con esos IDs."));
            }

            try
            {
                var stream = await fileStorage.OpenReadAsync(record.StorageKey, cancellationToken);
                return Results.Stream(stream, record.MimeType, record.FileName);
            }
            catch (FileNotFoundException)
            {
                return Results.NotFound(new ApiErrorResponse(
                    "not_found",
                    "El proyecto existe pero su original ya no está disponible en el storage."));
            }
        })
        .WithName("GetOriginalImage")
        .WithTags("Projects")
        .Produces(StatusCodes.Status200OK, contentType: "application/octet-stream")
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .WithSummary("Recupera el original de una imagen ya cargada, sin procesarla.")
        .WithDescription("Mismo criterio de ownership que la metadata: 404 uniforme si la imagen es de otro usuario (M2.2-S09).");
    }

    private static string OriginalImageUrl(Guid projectId, Guid imageId) =>
        $"/api/v1/projects/{projectId}/images/{imageId}/original";
}
