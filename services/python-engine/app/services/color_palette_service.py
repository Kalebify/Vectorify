"""Servicio que orquesta la detección/reducción de paleta de colores
(M2-S01): lectura segura de la imagen (preservando alpha, igual criterio que
ThresholdingService -- la transparencia tiene significado semántico propio
acá también), validación de dimensiones (defensa en profundidad, mismo
límite que el resto del pipeline) y clustering determinista de color (ver
app.core.color_palette_pipeline), acotado por un timeout interno -- mismo
criterio que SimplificationService/PathCheckerService: el clustering es
Python/NumPy puro, sin punto de cancelación cooperativa, se corre en un hilo
aparte y se abandona si no responde a tiempo.
"""

from __future__ import annotations

import base64
import concurrent.futures
import io
from typing import Callable

import imagesize

from app.core import color_families, color_palette_pipeline, pipeline, threshold_pipeline
from app.core.color_palette_pipeline import PaletteDetectionResult
from app.core.config import Settings
from app.core.errors import ColorPaletteTimeoutError, DimensionsExceededError
from app.models.schemas import (
    BackgroundPayload,
    ColorGroupPayload,
    ColorPaletteMetrics,
    ColorPaletteParams,
    ColorPaletteResponse,
)

DetectFn = Callable[..., PaletteDetectionResult]


class ColorPaletteService:
    def __init__(
        self, settings: Settings, detect_fn: DetectFn | None = None, family_detect_fn: DetectFn | None = None
    ) -> None:
        self._settings = settings
        # Inyectable (mismo criterio que SimplifyFn en SimplificationService)
        # para poder simular un clustering lento en tests de timeout sin
        # depender de que el algoritmo real tarde.
        self._detect_fn = detect_fn or color_palette_pipeline.detect_palette
        # Estilo "Colores base": mismo presupuesto de tiempo, misma inyección.
        self._family_detect_fn = family_detect_fn or color_palette_pipeline.detect_base_color_palette

    def process(self, data: bytes, params: ColorPaletteParams) -> ColorPaletteResponse:
        """Detecta la paleta de colores a partir de los bytes recibidos (la
        misma imagen de entrada que ya usa el pipeline de preprocesamiento/
        threshold, RGBA soportado) y los parámetros ya validados.
        Determinista: mismos `data` + mismos `params` siempre producen el
        mismo resultado (ver app.core.color_palette_pipeline).
        """
        self._reject_if_header_dimensions_exceed_limits(data)

        image = threshold_pipeline.read_image_with_alpha(data)
        pipeline.check_dimensions(
            image, self._settings.max_image_width, self._settings.max_image_height, self._settings.max_image_pixels
        )

        bgr_image, alpha = threshold_pipeline.split_alpha_channel(image)
        bgr_image = _ensure_three_channels(bgr_image)

        result = self._detect_with_timeout(bgr_image, alpha, params)

        preview = color_palette_pipeline.build_quantized_preview(result)
        preview_base64 = base64.b64encode(pipeline.encode_png(preview)).decode("ascii")

        groups = [
            ColorGroupPayload(
                id=index,
                color_hex=_bgr_to_hex(group.color_bgr),
                pixel_count=group.pixel_count,
                area_percent=(group.pixel_count / result.total_pixel_count * 100.0) if result.total_pixel_count else 0.0,
                has_partial_alpha=group.has_partial_alpha,
                touches_border=group.touches_border,
                mask_base64=base64.b64encode(pipeline.encode_png(group.mask)).decode("ascii"),
                is_background=group.is_background,
                source_group_count=group.source_group_count,
                piece_count=group.piece_count,
            )
            for index, group in enumerate(result.groups)
        ]
        drawing_groups = [g for g in groups if not g.is_background]

        transparent_percent = (
            result.transparent_pixel_count / result.total_pixel_count * 100.0 if result.total_pixel_count else 0.0
        )

        return ColorPaletteResponse(
            width=result.width,
            height=result.height,
            content_type="image/png",
            effective_params=params,
            algorithm_version=color_families.ALGORITHM_VERSION,
            metrics=ColorPaletteMetrics(
                color_count=len(groups),
                transparent_percent=transparent_percent,
                family_count=len(drawing_groups),
                piece_count=sum(g.piece_count for g in drawing_groups),
                background=_background_payload(result),
            ),
            groups=groups,
            quantized_preview_base64=preview_base64,
        )

    def _reject_if_header_dimensions_exceed_limits(self, data: bytes) -> None:
        """Mismo criterio de defensa contra "bombas de descompresión" que
        ThresholdingService._reject_if_header_dimensions_exceed_limits."""
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

    def _detect_with_timeout(self, bgr_image, alpha, params: ColorPaletteParams) -> PaletteDetectionResult:
        """Aplica ColorPalette:TimeoutSeconds (color_palette_timeout_seconds).
        Mismo criterio (y misma razón de NO usar `with ThreadPoolExecutor`)
        que SimplificationService._simplify_with_timeout: el `__exit__` de un
        `with` esperaría a que el hilo colgado termine, anulando el propósito
        del timeout."""
        executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        if params.grouping_style == "base_colors":
            future = executor.submit(
                self._family_detect_fn,
                bgr_image,
                alpha,
                params.tolerance,
                self._settings.max_palette_unique_colors,
                params.tiny_area_ratio,
                params.target_families,
                params.grouping_strength,
                [correction.points for correction in params.background_corrections],
            )
        else:
            future = executor.submit(
                self._detect_fn,
                bgr_image,
                alpha,
                params.tolerance,
                params.max_colors,
                self._settings.max_palette_unique_colors,
                params.tiny_area_ratio,
            )
        try:
            result = future.result(timeout=self._settings.color_palette_timeout_seconds)
        except concurrent.futures.TimeoutError as exc:
            executor.shutdown(wait=False)
            raise ColorPaletteTimeoutError(
                f"La detección de paleta de colores tardó más de {self._settings.color_palette_timeout_seconds}s y se abortó."
            ) from exc
        executor.shutdown(wait=True)
        return result


def _background_payload(result: PaletteDetectionResult) -> BackgroundPayload | None:
    report = result.background
    if report is None or not result.total_pixel_count:
        return None
    total = result.total_pixel_count
    return BackgroundPayload(
        pixel_count=report.pixel_count,
        area_percent=report.pixel_count / total * 100.0,
        ambiguous_pixel_count=report.ambiguous_pixel_count,
        ambiguous_percent=report.ambiguous_pixel_count / total * 100.0,
        contact_pixel_count=report.contact_pixel_count,
        contact_percent=report.contact_pixel_count / total * 100.0,
        needs_review=report.needs_review,
    )


def _ensure_three_channels(image):
    """threshold_pipeline.split_alpha_channel ya separa el alpha si había 4
    canales; si la imagen decodificada venía en escala de grises (2
    dimensiones, sin alpha), se replica a 3 canales BGR para que el
    clustering siempre opere sobre tripletas de color -- mismo criterio que
    app.core.pipeline.to_grayscale."""
    if image.ndim == 2:
        import cv2

        return cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)
    return image


def _bgr_to_hex(color_bgr: tuple[int, int, int]) -> str:
    b, g, r = color_bgr
    return f"#{r:02x}{g:02x}{b:02x}"
