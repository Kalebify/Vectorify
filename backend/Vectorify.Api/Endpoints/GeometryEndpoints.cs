using System.Text.Json;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.Options;
using Vectorify.Api.Contracts;
using Vectorify.Api.Geometry;
using Vectorify.Api.Options;

namespace Vectorify.Api.Endpoints;

/// <summary>
/// Servicio de geometría del editor (M3-S04, ADR D4 de docs/ADR_EDITOR_MVP3.md): operaciones booleanas SIN estado
/// sobre anillos de polígonos / polilíneas en unidades de documento, calculadas con Shapely en el motor Python.
/// Misma arquitectura proxy que el resto (Endpoint -&gt; <see cref="IGeometryService"/> -&gt; IPythonGeometryClient,
/// <see cref="ApiErrorResponse"/> uniforme) pero SIN <c>IUserContext</c> ni base de datos: la operación solo recibe
/// coordenadas y devuelve coordenadas, no hay nada del usuario que proteger ni persistir. Lo reusan S08-S11.
/// </summary>
public static class GeometryEndpoints
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public static void MapGeometryEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/api/v2/geometry/boolean", async (
            HttpRequest httpRequest,
            IGeometryService service,
            IOptions<GeometryOptions> options,
            CancellationToken cancellationToken) =>
        {
            // El Content-Type distinto de application/json lo rechaza el propio enrutado (`Accepts`, 415 sin cuerpo) antes de llegar acá.
            var maxBytes = options.Value.MaxRequestBodyBytes;
            if (httpRequest.ContentLength > maxBytes)
            {
                return TooLarge(maxBytes);
            }

            // El cuerpo se lee a mano (en vez de dejar que el binder lo haga) para devolver SIEMPRE ApiErrorResponse y poder acotar
            // el tamaño aun sin Content-Length (chunked): el límite de Kestrel se baja al configurado.
            var sizeFeature = httpRequest.HttpContext.Features.Get<IHttpMaxRequestBodySizeFeature>();
            if (sizeFeature is { IsReadOnly: false })
            {
                sizeFeature.MaxRequestBodySize = maxBytes;
            }

            GeometryBooleanRequest? request;
            try
            {
                request = await JsonSerializer.DeserializeAsync<GeometryBooleanRequest>(httpRequest.Body, JsonOptions, cancellationToken);
            }
            catch (BadHttpRequestException ex) when (ex.StatusCode == StatusCodes.Status413PayloadTooLarge)
            {
                return TooLarge(maxBytes);
            }
            catch (JsonException)
            {
                return Results.BadRequest(new ApiErrorResponse("invalid_parameters", "El cuerpo no es un JSON válido para esta operación."));
            }

            var result = await service.BooleanAsync(request, cancellationToken);
            return result switch
            {
                GeometryBooleanResult.Ready ready => Results.Ok(ready.Response),
                GeometryBooleanResult.ValidationFailed failed => Results.BadRequest(new ApiErrorResponse(failed.Code, failed.Message)),
                GeometryBooleanResult.UpstreamError error => Results.Json(
                    new ApiErrorResponse(error.Code, error.Message),
                    statusCode: StatusCodeFor(error.Code)),
                _ => Results.Json(
                    new ApiErrorResponse("internal_error", "Ocurrió un error inesperado en la operación de geometría."),
                    statusCode: StatusCodes.Status500InternalServerError),
            };
        })
        .WithName("GeometryBoolean")
        .WithTags("Geometry")
        .Accepts<GeometryBooleanRequest>("application/json")
        .Produces<GeometryBooleanResponse>(StatusCodes.Status200OK)
        .Produces<ApiErrorResponse>(StatusCodes.Status400BadRequest)
        .Produces<ApiErrorResponse>(StatusCodes.Status413PayloadTooLarge)
        .Produces(StatusCodes.Status415UnsupportedMediaType)
        .Produces<ApiErrorResponse>(StatusCodes.Status503ServiceUnavailable)
        .Produces<ApiErrorResponse>(StatusCodes.Status504GatewayTimeout)
        .WithSummary("Operaciones booleanas sobre anillos de polígonos y polilíneas (union, difference, intersection, xor, normalize).")
        .WithDescription(
            "Intercambia coordenadas puras en unidades de documento (nunca path data): el cliente aplana sus curvas con " +
            "una tolerancia explícita y manda `subjects` (polygon = anillos con regla par-impar / line) y `operands` " +
            "(además bufferedLine = pincel de borrador con radio). La respuesta trae, por subject (difference/" +
            "intersection/normalize) o en conjunto (union/xor), 0 o más piezas ya validadas, sin NaN y en orden " +
            "determinista; `changed` es false cuando el resultado es igual al subject. Sin estado: no persiste nada. " +
            "Límites: 500 subjects y 500 000 vértices en total (400 con código claro). Python caído => 503 " +
            "engine_unavailable; timeout => 504.");
    }

    private static IResult TooLarge(long maxBytes) => Results.Json(
        new ApiErrorResponse("payload_too_large", $"El cuerpo supera el máximo de {maxBytes} bytes."),
        statusCode: StatusCodes.Status413PayloadTooLarge);

    private static int StatusCodeFor(string code) => code switch
    {
        "invalid_parameters" => StatusCodes.Status422UnprocessableEntity,
        "payload_too_large" => StatusCodes.Status413PayloadTooLarge,
        "timeout" => StatusCodes.Status504GatewayTimeout,
        "engine_unavailable" => StatusCodes.Status503ServiceUnavailable,
        "invalid_response" => StatusCodes.Status502BadGateway,
        _ => StatusCodes.Status500InternalServerError,
    };
}
