"""Servicio que orquesta la etapa de vectorización: lectura segura de la
máscara B/N ya generada (M1-S04), rechazo controlado de máscaras vacías,
trazado con presupuesto de tiempo acotado a través de `VectorEngine` (ver
app.core.vector_engine -- el motor concreto, VTracer, nunca se referencia acá
directamente), sanitización del SVG resultante y cálculo de estadísticas.
Separado de ThresholdingService/PreprocessingService por ser una etapa
distinta del pipeline -- ver spec.md M1-S05, mismo criterio que
threshold_service.py sobre preprocessing_service.py (M1-S04 sobre M1-S03).
"""

import concurrent.futures
import io

import cv2
import imagesize
import numpy as np

from app.core import pipeline, shared_boundaries, threshold_pipeline
from app.core.config import Settings
from app.core.errors import (
    DimensionsExceededError,
    EmptyMaskError,
    NotAPartitionError,
    SvgOutputTooLargeError,
    VectorizationTimeoutError,
)
from app.core.svg_processing import compute_svg_stats, sanitize_svg
from app.core.vector_engine import VectorEngine, VtracerEngine
from app.models.schemas import VectorBounds, VectorizeResponse, VectorMetrics


class VectorizationService:
    def __init__(self, settings: Settings, engine: VectorEngine | None = None) -> None:
        self._settings = settings
        # El motor por defecto es VtracerEngine, pero el servicio solo conoce
        # el Protocol VectorEngine -- inyectable para tests (ver
        # tests/test_vectorization_service.py) y para poder sustituir el
        # motor sin tocar esta clase (Definition of Done de spec.md).
        self._engine = engine or VtracerEngine()

    def process(self, data: bytes) -> VectorizeResponse:
        """Genera un SVG sanitizado a partir de los bytes recibidos (la
        máscara B/N ya generada por threshold -- M1-S04 -- nunca el original
        ni el preview preprocesado). Determinista dentro de lo que garantice
        el motor de trazado subyacente (ver reporte del sprint,
        "Determinismo").
        """
        response, _mask = self.process_with_mask(data)
        return response

    def process_with_mask(self, data: bytes) -> tuple[VectorizeResponse, np.ndarray]:
        """Igual que `process`, pero además devuelve la máscara binaria (0/255)
        REALMENTE usada para trazar (ya rebinarizada defensivamente) -- M2.1-S03
        la reutiliza para la validación raster-vs-vector de
        app.api.routes.vectorize.vectorize_layers (comparar el SVG resultante
        contra la MISMA máscara que lo generó, no una re-decodificada aparte
        que podría divergir sutilmente del binarizado real)."""
        mask = self._decode_mask(data)
        raw_svg = self._trace_with_timeout(mask)
        return self._build_response(raw_svg, mask), mask

    def process_partition_with_masks(
        self, datas: list[bytes], simplify_tolerance: float = shared_boundaries.DEFAULT_SIMPLIFY_TOLERANCE_PX
    ) -> list[tuple[VectorizeResponse, np.ndarray]]:
        """Vectoriza un conjunto de máscaras DISJUNTAS (la partición por familias de color) con fronteras
        compartidas: la frontera entre dos máscaras vecinas se calcula una sola vez (app.core.shared_boundaries),
        así que sus capas no se solapan ni dejan rendijas. Mismas validaciones que `process_with_mask` para cada
        máscara; si no son una partición (dimensiones distintas o algún píxel compartido) lanza
        `NotAPartitionError` y el llamador decide si recurre al trazado independiente."""
        masks = [self._decode_mask(data) for data in datas]
        if len({mask.shape for mask in masks}) > 1:
            raise NotAPartitionError("las máscaras tienen dimensiones distintas")
        if not shared_boundaries.are_disjoint(masks):
            raise NotAPartitionError("las máscaras comparten píxeles")
        polygons = self._run_with_timeout(shared_boundaries.trace_polygons, masks, simplify_tolerance)
        height, width = masks[0].shape[:2]
        return [
            (self._build_response(shared_boundaries.polygon_to_svg(polygon, width, height), mask), mask)
            for polygon, mask in zip(polygons, masks)
        ]

    def _decode_mask(self, data: bytes) -> np.ndarray:
        self._reject_if_header_dimensions_exceed_limits(data)

        image = pipeline.read_image_safely(data)

        pipeline.check_dimensions(
            image,
            self._settings.max_image_width,
            self._settings.max_image_height,
            self._settings.max_image_pixels,
        )

        gray = threshold_pipeline.to_grayscale_single_channel(image)
        # Re-binariza defensivamente (127 como punto medio): la entrada
        # debería ser ya una máscara estrictamente 0/255 (M1-S04), pero este
        # servicio no confía ciegamente en su caller -- mismo criterio de
        # defensa en profundidad que el resto del pipeline.
        _, mask = cv2.threshold(gray, 127, 255, cv2.THRESH_BINARY)

        foreground_pixels = int(np.count_nonzero(mask == 255))
        if foreground_pixels == 0:
            raise EmptyMaskError(
                "La máscara no contiene ningún píxel de foreground (blanco): no hay nada para vectorizar."
            )
        return mask

    def _build_response(self, raw_svg: str, mask: np.ndarray) -> VectorizeResponse:
        sanitized_svg = sanitize_svg(raw_svg)

        encoded_size = len(sanitized_svg.encode("utf-8"))
        if encoded_size > self._settings.max_svg_output_bytes:
            raise SvgOutputTooLargeError(
                f"El SVG generado ({encoded_size} bytes) supera el límite permitido "
                f"({self._settings.max_svg_output_bytes} bytes)."
            )

        stats = compute_svg_stats(sanitized_svg)
        height, width = mask.shape[:2]

        return VectorizeResponse(
            svg=sanitized_svg,
            content_type="image/svg+xml",
            width=width,
            height=height,
            metrics=VectorMetrics(
                path_count=stats["path_count"],
                approx_node_count=stats["approx_node_count"],
                bounds=VectorBounds(**stats["bounds"]),
            ),
        )

    def _trace_with_timeout(self, mask: np.ndarray) -> str:
        return self._run_with_timeout(self._engine.trace, mask)

    def _run_with_timeout(self, function, *args):
        """Aplica Vectorize:TimeoutSeconds (vectorize_timeout_seconds) al
        trazado. VTracer es una llamada nativa (Rust) síncrona sin mecanismo
        de cancelación cooperativa: el timeout se implementa ejecutando el
        trazado en un hilo aparte y abandonándolo si no responde a tiempo
        (best effort -- el hilo puede seguir corriendo en background; no hay
        forma de matarlo desde Python sin terminar el proceso entero). No se
        usa `with ThreadPoolExecutor(...)` deliberadamente: su `__exit__`
        llama a `shutdown(wait=True)`, lo que bloquearía este método (y por
        lo tanto al caller) hasta que el hilo colgado termine, anulando el
        propósito del timeout. En el camino de timeout se hace
        `shutdown(wait=False)` para retornar (lanzando la excepción) sin
        esperar al hilo; en el camino feliz `future.result()` ya implica que
        el hilo terminó, así que el shutdown no bloquea. Ver
        VectorizationTimeoutError y el reporte del sprint, "Excepciones/
        limitaciones".
        """
        executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        future = executor.submit(function, *args)
        try:
            result = future.result(timeout=self._settings.vectorize_timeout_seconds)
        except concurrent.futures.TimeoutError as exc:
            executor.shutdown(wait=False)
            raise VectorizationTimeoutError(
                f"El trazado tardó más de {self._settings.vectorize_timeout_seconds}s y se abortó."
            ) from exc
        executor.shutdown(wait=True)
        return result

    def _reject_if_header_dimensions_exceed_limits(self, data: bytes) -> None:
        """Mismo criterio de defensa contra "bombas de descompresión" que
        Preprocessing/ThresholdingService: lee ancho/alto de la cabecera sin
        decodificar píxeles y rechaza temprano si ya excede los límites
        configurados. Duplicado deliberadamente (ver ThresholdingService,
        mismo comentario) para mantener cada servicio independiente.
        """
        width, height = imagesize.get(io.BytesIO(data))
        if width <= 0 or height <= 0:
            return

        total_pixels = width * height
        max_width = self._settings.max_image_width
        max_height = self._settings.max_image_height
        max_pixels = self._settings.max_image_pixels

        if width > max_width or height > max_height or total_pixels > max_pixels:
            raise DimensionsExceededError(
                f"La imagen ({width}x{height}, {total_pixels} px) supera el límite permitido "
                f"({max_width}x{max_height}, {max_pixels} px totales) según su cabecera, "
                "sin necesidad de decodificarla por completo."
            )
