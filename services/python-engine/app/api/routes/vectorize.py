import json
import logging

import cv2
import numpy as np
from fastapi import APIRouter, Depends, File, Form, UploadFile

from app.api.dependencies import get_vectorization_service
from app.core.config import Settings, get_settings
from app.core.errors import InvalidParametersError, NotAPartitionError
from app.core.raster_validation import compare_layer_raster, rasterize_svg_mask
from app.models.schemas import (
    ErrorResponse,
    RasterValidationResult,
    VectorizeLayersResponse,
    VectorizeResponse,
    VectorLayerItem,
)
from app.services.vectorization_service import VectorizationService

router = APIRouter(prefix="/api/v1", tags=["vectorize"])
logger = logging.getLogger(__name__)


@router.post(
    "/vectorize",
    response_model=VectorizeResponse,
    summary="Vectoriza una máscara B/N (VTracer) y devuelve un SVG sanitizado",
    description=(
        "Recibe la máscara B/N YA generada por threshold (M1-S04, multipart, campo 'file'). "
        "No recibe parámetros ajustables en este sprint: el motor de trazado está encapsulado "
        "detrás de app.core.vector_engine.VectorEngine (VTracer, ver spec.md, 'Decisión "
        "bloqueante resuelta con el usuario') con una configuración fija y determinista. "
        "El SVG resultante se sanitiza (sin <script>, sin referencias externas) antes de "
        "devolverse. Solo lo llama Vectorify.Api."
    ),
    responses={
        400: {"model": ErrorResponse, "description": "Máscara corrupta o no decodificable"},
        413: {"model": ErrorResponse, "description": "Dimensiones de la máscara excesivas, o SVG resultante demasiado grande"},
        422: {"model": ErrorResponse, "description": "La máscara no tiene ningún píxel de foreground (vacía)"},
        500: {"model": ErrorResponse, "description": "Error inesperado del motor de trazado"},
        504: {"model": ErrorResponse, "description": "El trazado excedió el tiempo máximo configurado"},
    },
)
async def vectorize_mask(
    file: UploadFile = File(..., description="Máscara B/N ya generada por threshold (PNG)"),
    service: VectorizationService = Depends(get_vectorization_service),
) -> VectorizeResponse:
    data = await file.read()
    return service.process(data)


@router.post(
    "/vectorize-layers",
    response_model=VectorizeLayersResponse,
    summary="Vectoriza N máscaras de color de forma independiente en una sola llamada (M2-S02)",
    description=(
        "Recibe N máscaras B/N (multipart, campo repetido 'files', una por ColorGroup YA "
        "confirmado -- M2-S01) y sus IDs de grupo correspondientes (campo 'group_ids', JSON "
        "array de strings, mismo orden y cantidad que 'files'). Vectoriza cada máscara de forma "
        "INDEPENDIENTE reutilizando VectorizationService.process (el mismo motor/pipeline de "
        "M1-S05, sin reinventar el trazado de contornos) N veces DENTRO de esta única request -- "
        "evita N round-trips HTTP separados entre Vectorify.Api y este motor. Ninguna máscara se "
        "recorta a su bounding box: todas comparten las dimensiones de la imagen original, así "
        "que los SVG resultantes ya comparten el mismo sistema de coordenadas/viewBox sin "
        "normalización adicional. Si cualquier máscara falla (corrupta, vacía, demasiado grande, "
        "timeout), toda la solicitud falla -- el conjunto de capas se genera todo o nada, nunca "
        "parcial. Cada capa devuelta incluye `raster_validation` (M2.1-S03): el SVG resultante se "
        "rasteriza de vuelta y se compara contra su propia máscara de origen y contra la unión de "
        "las demás máscaras recibidas (detecta contaminación cruzada entre colores) -- una "
        "discrepancia por encima de tolerancia se loggea como advertencia, nunca bloquea la "
        "respuesta. Solo lo llama Vectorify.Api."
    ),
    responses={
        400: {"model": ErrorResponse, "description": "Alguna máscara es corrupta o no decodificable"},
        413: {"model": ErrorResponse, "description": "Alguna máscara excede las dimensiones máximas, o su SVG resultante es demasiado grande"},
        422: {"model": ErrorResponse, "description": "'group_ids' inválido/no coincide con 'files', o alguna máscara no tiene foreground"},
        500: {"model": ErrorResponse, "description": "Error inesperado del motor de trazado"},
        504: {"model": ErrorResponse, "description": "El trazado de alguna máscara excedió el tiempo máximo configurado"},
    },
)
async def vectorize_layers(
    files: list[UploadFile] = File(..., description="Máscaras B/N (PNG), una por ColorGroup"),
    group_ids: str = Form(..., description="JSON array de IDs (string) de ColorGroup, mismo orden/cantidad que 'files'"),
    shared_boundaries: bool = Form(
        False,
        description=(
            "Si es true, las máscaras son una PARTICIÓN (ningún píxel en dos máscaras: p. ej. las familias de color base) "
            "y se trazan juntas con fronteras compartidas, sin solapes ni rendijas entre capas vecinas. Si dos máscaras "
            "comparten píxeles no hay partición: se trazan por su cuenta y se registra una advertencia. Por defecto "
            "false: cada máscara se traza por su cuenta."
        ),
    ),
    service: VectorizationService = Depends(get_vectorization_service),
    settings: Settings = Depends(get_settings),
) -> VectorizeLayersResponse:
    try:
        parsed_group_ids = json.loads(group_ids)
    except json.JSONDecodeError as exc:
        raise InvalidParametersError(f"'group_ids' no es JSON válido: {exc}") from exc

    if not isinstance(parsed_group_ids, list) or not all(
        isinstance(item, str) and item for item in parsed_group_ids
    ):
        raise InvalidParametersError("'group_ids' debe ser un array JSON de strings no vacíos.")

    if len(parsed_group_ids) != len(files):
        raise InvalidParametersError(
            f"La cantidad de group_ids ({len(parsed_group_ids)}) no coincide con la cantidad de "
            f"archivos recibidos ({len(files)})."
        )

    if len(files) == 0:
        raise InvalidParametersError("Debe enviarse al menos una máscara para vectorizar.")

    # Traza cada máscara de forma independiente (sin cambios sobre M2-S02),
    # pero además conserva la máscara binaria REALMENTE usada para trazar
    # (process_with_mask, M2.1-S03) -- necesaria más abajo para la
    # validación raster-vs-vector de CADA capa contra las demás.
    results: list[tuple[str, VectorizeResponse, np.ndarray]] = []
    datas = [await file.read() for file in files]
    if shared_boundaries:
        try:
            traced = service.process_partition_with_masks(datas)
            results = [(group_id, response, mask) for group_id, (response, mask) in zip(parsed_group_ids, traced)]
        except NotAPartitionError as exc:
            logger.warning("shared_boundaries solicitado pero las máscaras no son una partición (%s): se trazan por separado", exc)
    if not results:
        for group_id, data in zip(parsed_group_ids, datas):
            response, mask = service.process_with_mask(data)
            results.append((group_id, response, mask))

    layers: list[VectorLayerItem] = []
    for index, (group_id, result, own_mask) in enumerate(results):
        other_masks_union = np.zeros_like(own_mask)
        for other_index, (_, _, other_mask) in enumerate(results):
            if other_index != index:
                other_masks_union = cv2.bitwise_or(other_masks_union, other_mask)

        reconstructed = rasterize_svg_mask(result.svg, result.width, result.height)
        outcome = compare_layer_raster(
            reconstructed,
            own_mask,
            other_masks_union,
            settings.raster_validation_own_mismatch_tolerance,
            settings.raster_validation_contamination_tolerance,
        )

        if outcome.warnings:
            # Advertir, NUNCA bloquear la generación de la capa -- decisión
            # documentada en el reporte del sprint (M2.1-S03, "Ambigüedades
            # detectadas"): una discrepancia por encima de tolerancia es una
            # señal para revisar, no una razón para fallar toda la request
            # (que ya de por sí es "todo o nada" a nivel de errores de
            # trazado -- esto es deliberadamente distinto, una advertencia de
            # calidad, no un error).
            logger.warning(
                "Validación raster-vs-vector fuera de tolerancia para group_id=%s: %s",
                group_id,
                "; ".join(outcome.warnings),
            )

        layers.append(
            VectorLayerItem(
                group_id=group_id,
                svg=result.svg,
                content_type=result.content_type,
                width=result.width,
                height=result.height,
                metrics=result.metrics,
                raster_validation=RasterValidationResult(**outcome.to_dict()),
            )
        )

    return VectorizeLayersResponse(layers=layers)
