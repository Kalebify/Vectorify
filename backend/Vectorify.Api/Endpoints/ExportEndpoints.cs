using Microsoft.Net.Http.Headers;
using Vectorify.Api.Contracts;
using Vectorify.Api.Export;
using Vectorify.Api.Storage;

namespace Vectorify.Api.Endpoints;

/// <summary>
/// Endpoint de exportación SVG (M1-S10): sirve, tal cual, los mismos bytes YA
/// persistidos por la etapa de origen -- una VectorVersion (M1-S05), una
/// SimplificationVersion (M1-S07) o una DimensionVersion (M1-S09) -- con los
/// headers HTTP correctos para forzar la descarga
/// (<c>Content-Disposition: attachment</c>) y un nombre de archivo
/// sanitizado. NUNCA modifica geometría ni genera un artefacto nuevo: no hay
/// ningún POST equivalente a "aplicar" en este módulo, es un GET puro de
/// lectura -- ver spec.md, Definition of Done: "corresponde exactamente a
/// una versión del proyecto". Determinista por construcción: exportar la
/// misma versión dos veces sirve exactamente los mismos bytes (ver spec.md,
/// "Pruebas": "export repetido").
/// </summary>
public static class ExportEndpoints
{
    public static void MapExportEndpoints(this RouteGroupBuilder app)
    {
        app.MapGet("/export", async (
            Guid projectId,
            Guid imageId,
            string? sourceKind,
            Guid sourceId,
            HttpContext httpContext,
            IExportService exportService,
            IFileStorage fileStorage,
            CancellationToken cancellationToken) =>
        {
            var result = exportService.Resolve(projectId, imageId, sourceKind, sourceId);

            switch (result)
            {
                case ExportResult.Ready ready:
                    Stream stream;
                    try
                    {
                        stream = await fileStorage.OpenReadAsync(ready.SvgStorageKey, cancellationToken);
                    }
                    catch (FileNotFoundException)
                    {
                        return Results.NotFound(new ApiErrorResponse(
                            "not_found", "El SVG existe en el registro pero ya no está disponible en el storage."));
                    }

                    // RFC 6266, patrón de dos partes: `filename="..."` (respaldo
                    // ASCII para clientes que no soportan filename*) +
                    // `filename*=UTF-8''...` (nombre real, con tildes/espacios/
                    // símbolos, para navegadores modernos) -- SetHttpFileName
                    // arma ambas variantes a partir de un único nombre "real",
                    // sin reinventar el encoding RFC 5987 a mano.
                    var contentDisposition = new ContentDispositionHeaderValue("attachment");
                    contentDisposition.SetHttpFileName(ready.FileName);
                    httpContext.Response.Headers.ContentDisposition = contentDisposition.ToString();

                    return Results.Stream(stream, ready.ContentType);

                case ExportResult.NotFound notFound:
                    return Results.NotFound(new ApiErrorResponse(notFound.Code, notFound.Message));

                case ExportResult.ValidationFailed failed:
                    return Results.BadRequest(new ApiErrorResponse(failed.Code, failed.Message));

                default:
                    return Results.Json(
                        new ApiErrorResponse("internal_error", "Ocurrió un error inesperado al exportar el SVG."),
                        statusCode: StatusCodes.Status500InternalServerError);
            }
        })
        .WithName("ExportSvg")
        .WithTags("Export")
        .Produces(StatusCodes.Status200OK, contentType: "image/svg+xml")
        .Produces<ApiErrorResponse>(StatusCodes.Status400BadRequest)
        .Produces<ApiErrorResponse>(StatusCodes.Status404NotFound)
        .WithSummary("Exporta (descarga) el SVG de una versión ya generada del pipeline, sin modificar su geometría.")
        .WithDescription(
            "Recibe sourceKind ('vector', 'simplification' o 'dimension') + sourceId de un SVG YA generado, y " +
            "devuelve exactamente los mismos bytes ya persistidos por esa etapa, con Content-Disposition: " +
            "attachment y un nombre de archivo sanitizado derivado del nombre original subido por el usuario. " +
            "Nunca llama a ningún motor externo ni reescribe el SVG -- es un GET de solo lectura.");
    }
}
