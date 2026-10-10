from typing import TypeVar

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ValidationError

from app.api.dependencies import get_geometry_service
from app.core.config import Settings, get_settings
from app.core.errors import GeometryRequestTooLargeError, InvalidParametersError
from app.models.schemas import (
    ErrorResponse,
    GeometryBooleanRequest,
    GeometryBooleanResponse,
    GeometryOffsetRequest,
    GeometryOffsetResponse,
)
from app.services.geometry_service import GeometryService

router = APIRouter(prefix="/api/v1", tags=["geometry"])

ModelT = TypeVar("ModelT", bound=BaseModel)


@router.post(
    "/geometry/boolean",
    response_model=GeometryBooleanResponse,
    summary="Operaciones booleanas (union/difference/intersection/intersection_all/xor/normalize) sobre anillos de polígonos y polilíneas",
    description=(
        "Servicio de geometría SIN estado (M3-S04, ADR D4 del editor de MVP3). Recibe como cuerpo JSON "
        "`operation`, `subjects` (polygon = lista de anillos con regla par-impar / line = polilínea), "
        "`operands` (además, bufferedLine = pincel de borrador: línea con radio, cap/join redondos) y "
        "`tolerance` (> 0, unidades de documento). Devuelve, por subject (difference/intersection/normalize) "
        "o en conjunto (union/xor/intersection_all), las piezas resultantes -- puede haber 0 o varias -- como anillos/"
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
    parsed = await _read_request(request, settings, GeometryBooleanRequest)
    return service.process(parsed)


@router.post(
    "/geometry/offset",
    response_model=GeometryOffsetResponse,
    summary="Offset (exterior/interior) de polígonos y polilíneas con joins y caps",
    description=(
        "Offset SIN estado del servicio de geometría (M3-S09, ADR D4). Recibe como cuerpo JSON `subjects` (los mismos "
        "polygon/line de las booleanas), `distance` FIRMADA en unidades de documento (> 0 exterior, < 0 interior, 0 se "
        "rechaza; las líneas solo admiten > 0 = ambos lados), `join_style` (round/mitre/bevel), `mitre_limit`, "
        "`cap_style` (round/flat/square, solo líneas) y `tolerance` (> 0). Devuelve por subject los polígonos resultantes "
        "(válidos, sin NaN, en orden determinista) y lo que pasó: `collapsed`, `split_count`, `lost_pieces`, "
        "`holes_before`/`holes_after` y `max_inward_offset`. Nada de esto se calla: el cliente lo informa antes de aplicar. "
        "Límites: 500 subjects, 500 000 vértices, |distance| y mitre_limit acotados. Solo lo llama Vectorify.Api."
    ),
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {"application/json": {"schema": GeometryOffsetRequest.model_json_schema()}},
        }
    },
    responses={
        413: {"model": ErrorResponse, "description": "Cuerpo demasiado grande"},
        422: {
            "model": ErrorResponse,
            "description": "Cuerpo inválido (esquema, NaN/Infinity), distancia 0 o fuera de tope, inglete fuera de rango, interior con líneas, demasiados subjects o vértices",
        },
        500: {"model": ErrorResponse, "description": "Error inesperado o resultado inválido de la operación"},
        504: {"model": ErrorResponse, "description": "La operación excedió el tiempo máximo configurado"},
    },
)
async def offset_operation(
    request: Request,
    settings: Settings = Depends(get_settings),
    service: GeometryService = Depends(get_geometry_service),
) -> GeometryOffsetResponse:
    parsed = await _read_request(request, settings, GeometryOffsetRequest)
    return service.process_offset(parsed)


async def _read_request(request: Request, settings: Settings, model: type[ModelT]) -> ModelT:
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
        return model.model_validate_json(body)
    except ValidationError as exc:
        raise InvalidParametersError(f"Petición de geometría inválida: {_summarize(exc)}") from exc


def _summarize(error: ValidationError) -> str:
    """Primeros errores del esquema, sin volcar el cuerpo recibido (puede tener cientos de miles de vértices)."""
    items = error.errors(include_url=False, include_input=False)
    shown = [f"{'.'.join(str(part) for part in item['loc'])}: {item['msg']}" for item in items[:3]]
    extra = f" (+{len(items) - 3} más)" if len(items) > 3 else ""
    return "; ".join(shown) + extra
