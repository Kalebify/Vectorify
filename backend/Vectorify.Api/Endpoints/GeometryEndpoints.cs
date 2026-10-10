using System.Text.Json;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.Options;
using Vectorify.Api.Contracts;
using Vectorify.Api.Geometry;
using Vectorify.Api.Options;

namespace Vectorify.Api.Endpoints;

/// <summary>
/// Servicio de geometría del editor (M3-S04, ADR D4 de docs/ADR_EDITOR_MVP3.md): operaciones SIN estado (booleanas y, desde M3-S09,
/// offset) sobre anillos de polígonos / polilíneas en unidades de documento, calculadas con Shapely en el motor Python.
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
            var (request, failure) = await ReadRequestAsync<GeometryBooleanRequest>(httpRequest, options.Value, cancellationToken);
            if (failure is not null)
            {
                return failure;
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
        .WithSummary("Operaciones booleanas sobre anillos de polígonos y polilíneas (union, difference, intersection, intersection_all, xor, normalize).")
        .WithDescription(
            "Intercambia coordenadas puras en unidades de documento (nunca path data): el cliente aplana sus curvas con " +
            "una tolerancia explícita y manda `subjects` (polygon = anillos con regla par-impar / line) y `operands` " +
            "(además bufferedLine = pincel de borrador con radio). La respuesta trae, por subject (difference/" +
            "intersection/normalize) o en conjunto (union/xor/intersection_all), 0 o más piezas ya validadas, sin NaN y en orden " +
            "determinista; `changed` es false cuando el resultado es igual al subject. Sin estado: no persiste nada. " +
            "Límites: 500 subjects y 500 000 vértices en total (400 con código claro). Python caído => 503 " +
            "engine_unavailable; timeout => 504.");

        app.MapPost("/api/v2/geometry/offset", async (
            HttpRequest httpRequest,
            IGeometryService service,
            IOptions<GeometryOptions> options,
            CancellationToken cancellationToken) =>
        {
            var (request, failure) = await ReadRequestAsync<GeometryOffsetRequest>(httpRequest, options.Value, cancellationToken);
            if (failure is not null)
            {
                return failure;
            }

            var result = await service.OffsetAsync(request, cancellationToken);
            return result switch
            {
                GeometryOffsetResult.Ready ready => Results.Ok(ready.Response),
                GeometryOffsetResult.ValidationFailed failed => Results.BadRequest(new ApiErrorResponse(failed.Code, failed.Message)),
                GeometryOffsetResult.UpstreamError error => Results.Json(
                    new ApiErrorResponse(error.Code, error.Message),
                    statusCode: StatusCodeFor(error.Code)),
                _ => Results.Json(
                    new ApiErrorResponse("internal_error", "Ocurrió un error inesperado en el offset de geometría."),
                    statusCode: StatusCodes.Status500InternalServerError),
            };
        })
        .WithName("GeometryOffset")
        .WithTags("Geometry")
        .Accepts<GeometryOffsetRequest>("application/json")
        .Produces<GeometryOffsetResponse>(StatusCodes.Status200OK)
        .Produces<ApiErrorResponse>(StatusCodes.Status400BadRequest)
        .Produces<ApiErrorResponse>(StatusCodes.Status413PayloadTooLarge)
        .Produces(StatusCodes.Status415UnsupportedMediaType)
        .Produces<ApiErrorResponse>(StatusCodes.Status503ServiceUnavailable)
        .Produces<ApiErrorResponse>(StatusCodes.Status504GatewayTimeout)
        .WithSummary("Offset (exterior/interior) de polígonos y polilíneas con joins y caps.")
        .WithDescription(
            "Desplaza `subjects` (polygon = anillos con regla par-impar / line) una `distance` FIRMADA en unidades de documento " +
            "(> 0 exterior, < 0 interior; 0 se rechaza; las líneas solo admiten > 0 = ambos lados) con `joinStyle` " +
            "(round/mitre/bevel), `mitreLimit` (> 0) y `capStyle` (round/flat/square, solo líneas). La respuesta trae, por subject, " +
            "los polígonos resultantes (válidos, sin NaN, en orden determinista) y lo que pasó: `collapsed`, `splitCount`, " +
            "`lostPieces`, `holesBefore`/`holesAfter` y `maxInwardOffset` (el offset interior máximo antes de colapsar). Sin estado: " +
            "no persiste nada. Límites: 500 subjects, 500 000 vértices, |distance| y mitreLimit acotados (400 con código claro). " +
            "Python caído => 503 engine_unavailable; timeout => 504.");
    }

    /// <summary>
    /// Lee y deserializa el cuerpo JSON a mano (en vez de dejar que el binder lo haga) para devolver SIEMPRE <see cref="ApiErrorResponse"/>
    /// y poder acotar el tamaño aun sin Content-Length (chunked): el límite de Kestrel se baja al configurado. Devuelve la petición o la
    /// respuesta de error ya armada (413 cuerpo grande, 400 JSON inválido). El Content-Type distinto de application/json lo rechaza el
    /// propio enrutado (`Accepts`, 415 sin cuerpo) antes de llegar acá.
    /// </summary>
    private static async Task<(TRequest? Request, IResult? Failure)> ReadRequestAsync<TRequest>(
        HttpRequest httpRequest, GeometryOptions options, CancellationToken cancellationToken)
        where TRequest : class
    {
        var maxBytes = options.MaxRequestBodyBytes;
        if (httpRequest.ContentLength > maxBytes)
        {
            return (null, TooLarge(maxBytes));
        }

        var sizeFeature = httpRequest.HttpContext.Features.Get<IHttpMaxRequestBodySizeFeature>();
        if (sizeFeature is { IsReadOnly: false })
        {
            sizeFeature.MaxRequestBodySize = maxBytes;
        }

        try
        {
            return (await JsonSerializer.DeserializeAsync<TRequest>(httpRequest.Body, JsonOptions, cancellationToken), null);
        }
        catch (BadHttpRequestException ex) when (ex.StatusCode == StatusCodes.Status413PayloadTooLarge)
        {
            return (null, TooLarge(maxBytes));
        }
        catch (JsonException)
        {
            return (null, Results.BadRequest(new ApiErrorResponse("invalid_parameters", "El cuerpo no es un JSON válido para esta operación.")));
        }
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
