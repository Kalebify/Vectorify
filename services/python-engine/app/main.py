"""Punto de entrada del motor Python/FastAPI.

Ejecución local: uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
(o python -m app.main, que respeta HOST/PORT de la configuración).
"""

import logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.api.routes.check import router as check_router
from app.api.routes.color_palette import router as color_palette_router
from app.api.routes.components import router as components_router
from app.api.routes.geometry import router as geometry_router
from app.api.routes.health import router as health_router
from app.api.routes.info import router as info_router
from app.api.routes.physical_union import router as physical_union_router
from app.api.routes.preprocess import router as preprocess_router
from app.api.routes.simplify import router as simplify_router
from app.api.routes.threshold import router as threshold_router
from app.api.routes.vectorize import router as vectorize_router
from app.core.config import get_settings
from app.core.errors import (
    CheckTimeoutError,
    ColorPaletteTimeoutError,
    ComponentAnalysisTimeoutError,
    CorruptImageError,
    DimensionsExceededError,
    EmptyMaskError,
    GeometryRequestTooLargeError,
    GeometryResultInvalidError,
    GeometryTimeoutError,
    InvalidInputSvgError,
    InvalidParametersError,
    InvalidSvgError,
    PhysicalUnionImpossibleError,
    PhysicalUnionInvalidGeometryError,
    PhysicalUnionTimeoutError,
    PreprocessingError,
    SimplificationTimeoutError,
    SvgInputTooLargeError,
    SvgOutputTooLargeError,
    TooManyGeometrySubjectsError,
    TooManyGeometryVerticesError,
    TooManySubpathsError,
    TooManySubpathsForComponentsError,
    VectorizationEngineError,
    VectorizationTimeoutError,
)
from app.core.logging import configure_logging

settings = get_settings()
configure_logging(settings.log_level)
logger = logging.getLogger("app.main")

app = FastAPI(
    title="Vectorify — Motor Python",
    description=(
        "Microservicio de procesamiento/vectorización. Expone chequeos de salud, "
        "información del servicio, el pipeline determinista de preprocesamiento "
        "de imágenes (grayscale, contraste/brillo, suavizado/denoise), de "
        "threshold B/N (umbral global, inversión), de vectorización raster -> SVG "
        "(motor VTracer, encapsulado detrás de app.core.vector_engine.VectorEngine), de "
        "simplificación de nodos de un SVG ya vectorizado (Douglas-Peucker, ver "
        "app.core.simplification_pipeline), del Laser Checker de paths abiertos/duplicados "
        "(análisis de solo lectura, ver app.core.path_checker), de detección/reducción de "
        "paleta de colores dominantes (clustering determinista en espacio Lab, ver "
        "app.core.color_palette_pipeline), de componentes físicos independientes por capa "
        "(M2-S03, análisis de solo lectura, ver app.core.component_analysis) y de unión física de "
        "piezas (M2-S06, modifica geometría: unión booleana + bridging simple con Shapely, ver "
        "app.core.physical_union) y del servicio de geometría sin estado del editor (M3-S04, ADR D4: "
        "booleanas y offset sobre anillos/polilíneas con Shapely, ver app.core.geometry_ops y app.core.geometry_offset)."
    ),
    version=settings.service_version,
)

app.include_router(health_router)
app.include_router(info_router)
app.include_router(preprocess_router)
app.include_router(threshold_router)
app.include_router(vectorize_router)
app.include_router(simplify_router)
app.include_router(check_router)
app.include_router(color_palette_router)
app.include_router(components_router)
app.include_router(physical_union_router)
app.include_router(geometry_router)

# Códigos HTTP por tipo de error controlado del pipeline (ver "Errores y
# límites" de spec.md): imagen corrupta -> 400, dimensiones excesivas -> 413,
# parámetros inválidos -> 422, máscara vacía -> 422 (M1-S05: nada para
# vectorizar), SVG de salida demasiado grande -> 413, timeout de trazado ->
# 504, fallo inesperado del motor de trazado o SVG crudo inválido -> 500.
# M1-S07 (simplificación de nodos): SVG de entrada inválido/no decodificable
# -> 400 (problema del caller, no interno), SVG de entrada demasiado grande ->
# 413, timeout de la simplificación -> 504. M1-S08 (Laser Checker de paths
# abiertos/duplicados): mismos códigos que M1-S07 para SVG de entrada
# inválido/demasiado grande/timeout, más 413 si el SVG tiene demasiados
# subpaths analizables (TooManySubpathsError). Cualquier otro
# PreprocessingError (memoria, fallo inesperado de OpenCV) cae a 500.
_STATUS_BY_ERROR: dict[type[PreprocessingError], int] = {
    CorruptImageError: 400,
    DimensionsExceededError: 413,
    InvalidParametersError: 422,
    EmptyMaskError: 422,
    SvgOutputTooLargeError: 413,
    VectorizationTimeoutError: 504,
    VectorizationEngineError: 500,
    InvalidSvgError: 500,
    InvalidInputSvgError: 400,
    SvgInputTooLargeError: 413,
    CheckTimeoutError: 504,
    TooManySubpathsError: 413,
    SimplificationTimeoutError: 504,
    ColorPaletteTimeoutError: 504,
    ComponentAnalysisTimeoutError: 504,
    TooManySubpathsForComponentsError: 413,
    PhysicalUnionTimeoutError: 504,
    PhysicalUnionInvalidGeometryError: 422,
    PhysicalUnionImpossibleError: 422,
    # M3-S04 (servicio de geometría): cuerpo/vértices/subjects excedidos -> 413/422, timeout -> 504; un
    # resultado inválido de la operación es un fallo del motor -> 500 (el cliente nunca recibe geometría inválida).
    GeometryRequestTooLargeError: 413,
    TooManyGeometrySubjectsError: 422,
    TooManyGeometryVerticesError: 422,
    GeometryTimeoutError: 504,
    GeometryResultInvalidError: 500,
}


@app.exception_handler(PreprocessingError)
async def preprocessing_error_handler(request: Request, exc: PreprocessingError) -> JSONResponse:
    status_code = _STATUS_BY_ERROR.get(type(exc), 500)
    return JSONResponse(status_code=status_code, content={"code": exc.code, "message": str(exc)})


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    # Red de seguridad: un fallo inesperado (memoria, error interno de OpenCV,
    # etc.) nunca debe filtrar un stack trace ni devolver el 500 sin formato
    # por defecto de FastAPI; se registra server-side y se responde con la
    # misma forma {code, message} que el resto de errores controlados.
    logger.exception("Error inesperado no controlado: %s", exc)
    return JSONResponse(
        status_code=500,
        content={"code": "processing_error", "message": "Ocurrió un error inesperado al procesar la solicitud."},
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host=settings.host, port=settings.port)
