from fastapi import APIRouter, Depends, Request
from pydantic import ValidationError

from app.api.dependencies import get_geometry_service
from app.core.config import Settings, get_settings
from app.core.errors import GeometryRequestTooLargeError, InvalidParametersError
from app.models.schemas import ErrorResponse, GeometryBooleanRequest, GeometryBooleanResponse
from app.services.geometry_service import GeometryService

router = APIRouter(prefix="/api/v1", tags=["geometry"])


@router.post(
    "/geometry/boolean",
    response_model=GeometryBooleanResponse,
    summary="Operaciones booleanas (union/difference/intersection/xor/normalize) sobre anillos de polígonos y polilíneas",
    description=(
        "Servicio de geometría SIN estado (M3-S04, ADR D4 del editor de MVP3). Recibe como cuerpo JSON "
        "`operation`, `subjects` (polygon = lista de anillos con regla par-impar / line = polilínea), "
        "`operands` (además, bufferedLine = pincel de borrador: línea con radio, cap/join redondos) y "
        "`tolerance` (> 0, unidades de documento). Devuelve, por subject (difference/intersection/normalize) "
        "o en conjunto (union/xor), las piezas resultantes -- puede haber 0 o varias -- como anillos/"
        "polilíneas validados, sin NaN, en orden determinista. Opera sobre coordenadas puras: nunca recibe "
        "ni evalúa path data ni SVG. Límites: 500 subjects, 500 000 vértices en total. Solo lo llama "
        "Vectorify.Api."
    ),
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {"application/json": {"schema": GeometryBooleanRequest.model_json_schema()}},
        }
    },
    responses={
        413: {"model": ErrorResponse, "description": "Cuerpo demasiado grande"},
        422: {
            "model": ErrorResponse,
            "description": "Cuerpo inválido (esquema, NaN/Infinity, tolerancia), demasiados subjects o vértices",
        },
        500: {"model": ErrorResponse, "description": "Error inesperado o resultado inválido de la operación"},
        504: {"model": ErrorResponse, "description": "La operación excedió el tiempo máximo configurado"},
    },
)
async def boolean_operation(
    request: Request,
    settings: Settings = Depends(get_settings),
    service: GeometryService = Depends(get_geometry_service),
) -> GeometryBooleanResponse:
    # Se lee el cuerpo crudo (en vez de declarar el modelo como parámetro) para devolver el MISMO formato
    # de error {code, message} que el resto de las rutas -- el 422 por defecto de FastAPI usa otro esquema.
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > settings.max_geometry_request_bytes:
        raise GeometryRequestTooLargeError(
            f"El cuerpo ({declared} bytes) supera el límite permitido ({settings.max_geometry_request_bytes} bytes)."
        )
    body = await request.body()
    if len(body) > settings.max_geometry_request_bytes:
        raise GeometryRequestTooLargeError(
            f"El cuerpo ({len(body)} bytes) supera el límite permitido ({settings.max_geometry_request_bytes} bytes)."
        )

    try:
        parsed = GeometryBooleanRequest.model_validate_json(body)
    except ValidationError as exc:
        raise InvalidParametersError(f"Petición de geometría inválida: {_summarize(exc)}") from exc

    return service.process(parsed)


def _summarize(error: ValidationError) -> str:
    """Primeros errores del esquema, sin volcar el cuerpo recibido (puede tener cientos de miles de vértices)."""
    items = error.errors(include_url=False, include_input=False)
    shown = [f"{'.'.join(str(part) for part in item['loc'])}: {item['msg']}" for item in items[:3]]
    extra = f" (+{len(items) - 3} más)" if len(items) > 3 else ""
    return "; ".join(shown) + extra
