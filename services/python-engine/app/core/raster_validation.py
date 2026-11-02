"""M2.1-S03: "Validación raster-vs-vector" -- lo más nuevo de esta tarjeta
(ver spec.md, "Criterios de aceptación ampliados"). Después de vectorizar la
máscara de UNA capa (M2-S02), rasteriza el SVG resultante de vuelta a una
máscara binaria del MISMO tamaño que la máscara de origen y la compara
contra ella, con dos métricas relativas independientes:

1. `own_mismatch_ratio`: cuán fiel es la geometría vectorial a SU PROPIA
   máscara de origen (píxeles en los que el SVG rasterizado y la máscara
   original difieren, como fracción del área de foreground de la máscara
   original) -- captura errores de trazado/redondeo "normales" (antialiasing
   en los bordes, cuantización a coordenadas enteras de VTracer).

2. `contamination_ratio`: cuán CONTAMINADA queda el área vectorizada de esta
   capa con píxeles que en realidad pertenecen a la máscara de OTRO color
   (fracción del área rasterizada de ESTA capa que cae dentro de la unión de
   las demás máscaras de la paleta) -- la señal "crucial" pedida por
   spec.md: "evitar que regiones de otro color aparezcan dentro del layer
   seleccionado". Deliberadamente una métrica DISTINTA de `own_mismatch_ratio`
   (no "cuántos píxeles coinciden en general"): un error de alineación
   symmetric respecto a la propia máscara no dice nada sobre si el error
   invade el territorio de otro color en particular.

Ambas relativas (no absolutas en píxeles) -- mismo estilo que el resto de
las tolerancias del motor (CheckParams, ComponentAnalysisParams): así
escalan con el tamaño/densidad de la capa en vez de ser un número fijo de
píxeles. Ver app.core.config.Settings.raster_validation_own_mismatch_tolerance/
raster_validation_contamination_tolerance para los valores por defecto (con
evidencia empírica documentada en el reporte del sprint) y la decisión de
"advertir, no bloquear".

Reutiliza EXACTAMENTE la misma infraestructura de parseo de subpaths que
app.core.component_analysis (app.core.svg_path_parsing.collect_document_subpaths)
-- mismo criterio de "M/L/Z absolutos, transform resoluble" y mismos
subpaths en coordenadas ABSOLUTAS, sin duplicar el tokenizer.
"""

import math
import xml.etree.ElementTree as ET

import cv2
import numpy as np

from app.core.svg_path_parsing import collect_document_subpaths

# Un subpath de menos de 3 puntos no delimita ningún área rellenable.
_MIN_POINTS_FOR_FILL = 3

# Criterio de rasterizado: un píxel entra si su CENTRO cae dentro del polígono (regla par-impar). `cv2.fillPoly`
# no sirve para esto: también pinta los píxeles que cruza el borde (un cuadrado de 30x30 con vértices exactos
# en la grilla sale de 31x31, 961 píxeles en vez de 900) y cualquier capa mediría un sesgo de +1 fila/columna.
# Antes se corregía supermuestreando (factor 1-8 según el tamaño de la capa), pero en las capas grandes el
# factor caía a 1 y el sesgo quedaba entero: en el pato real, geometría EXACTA al píxel medía 0,7-3,3 % de
# «contaminación» y «desajuste» solo por el rasterizador, y 0 % en las capas chicas (factor 8). Ahora se
# rellena por líneas de barrido (`fill_even_odd`), exacto y sin supermuestreo.
#
# El punto de muestreo es el centro del píxel movido una fracción de px (`_SAMPLE_OFFSET_*`, primos distintos
# en x e y): un centro que cae justo SOBRE una arista diagonal compartida pertenece así a un único polígono
# (sin desempate, dos capas vecinas contarían ese píxel las dos).
_SAMPLE_OFFSET_X = 0.5 - 1.0 / 997.0
_SAMPLE_OFFSET_Y = 0.5 - 1.0 / 1009.0


def fill_even_odd(rings: list[np.ndarray], width: int, height: int) -> np.ndarray:
    """Máscara booleana (height x width) de los píxeles cuyo punto de muestreo cae dentro de `rings` (coordenadas
    locales del recorte, cada anillo un array Nx2; se cierra solo) según la regla par-impar."""
    rows: list[np.ndarray] = []
    crossings: list[np.ndarray] = []
    for ring in rings:
        start = ring.astype(np.float64)
        end = np.roll(start, -1, axis=0)
        keep = start[:, 1] != end[:, 1]
        if not keep.any():
            continue
        x0, y0 = start[keep, 0], start[keep, 1]
        x1, y1 = end[keep, 0], end[keep, 1]
        low = np.minimum(y0, y1)
        high = np.maximum(y0, y1)
        # Filas cuyo punto de muestreo `row + _SAMPLE_OFFSET_Y` cae en [low, high).
        first = np.maximum(np.ceil(low - _SAMPLE_OFFSET_Y).astype(np.int64), 0)
        last = np.minimum(np.ceil(high - _SAMPLE_OFFSET_Y).astype(np.int64), height)
        counts = np.maximum(last - first, 0)
        total = int(counts.sum())
        if total == 0:
            continue
        edge = np.repeat(np.arange(first.size), counts)
        offsets = np.arange(total) - np.repeat(np.cumsum(counts) - counts, counts)
        row = first[edge] + offsets
        sample_y = row + _SAMPLE_OFFSET_Y
        slope = (x1[edge] - x0[edge]) / (y1[edge] - y0[edge])
        rows.append(row)
        crossings.append(x0[edge] + (sample_y - y0[edge]) * slope)
    if not rows:
        return np.zeros((height, width), dtype=bool)

    row = np.concatenate(rows)
    crossing = np.concatenate(crossings)
    order = np.lexsort((crossing, row))
    row, crossing = row[order], crossing[order]
    # Dentro de cada fila, los cruces ordenados se emparejan (1.º-2.º, 3.º-4.º, ...): tramos rellenos.
    new_row = np.ones(row.size, dtype=bool)
    new_row[1:] = row[1:] != row[:-1]
    group_start = np.nonzero(new_row)[0]
    rank = np.arange(row.size) - np.repeat(group_start, np.diff(np.append(group_start, row.size)))
    opening = (rank % 2 == 0) & (np.arange(row.size) + 1 < row.size)
    opening[:-1] &= row[1:] == row[:-1]
    starts = np.nonzero(opening)[0]
    first_col = np.clip(np.ceil(crossing[starts] - _SAMPLE_OFFSET_X).astype(np.int64), 0, width)
    last_col = np.clip(np.ceil(crossing[starts + 1] - _SAMPLE_OFFSET_X).astype(np.int64), 0, width)
    delta = np.zeros((height, width + 1), dtype=np.int32)
    np.add.at(delta, (row[starts], first_col), 1)
    np.add.at(delta, (row[starts], last_col), -1)
    return np.cumsum(delta[:, :width], axis=1) > 0


def rasterize_svg_mask(svg_text: str, width: int, height: int) -> np.ndarray:
    """Rasteriza los subpaths ANALIZABLES (ver `collect_document_subpaths`,
    misma limitación ya documentada/aceptada por component_analysis: `<path>`
    con comandos/transform no soportados se ignoran) de un SVG a una máscara
    binaria (0/255) de exactamente `width`x`height` -- las mismas dimensiones
    que la máscara raster de origen (M2-S02 garantiza que ninguna capa se
    recorta a su propio bounding box, así que el sistema de coordenadas ya
    coincide sin ninguna normalización adicional).

    Composición por XOR (no por relleno acumulativo simple): cada subpath se
    rellena en un lienzo temporal propio y se combina con XOR sobre el
    acumulado -- para la topología "stacked" que emite VtracerEngine (anillos
    simples anidados, sin auto-intersección, sentido de recorrido opuesto
    para agujeros, ver vector_engine.py), esto es EQUIVALENTE al resultado
    real de fill-rule nonzero con anidamiento simple: cada nivel de anidado
    alterna adentro/afuera exactamente igual que la paridad par/impar que ya
    usa app.core.component_analysis para decidir agujero vs. sólido -- sin
    duplicar ese cálculo de profundidad/contención (privado a ese módulo),
    solo para rasterizar.

    Solo se rasteriza (muestreando el centro de cada píxel, ver constantes de
    arriba) el recorte del RECTÁNGULO delimitador de todos los subpaths de
    esta capa (expandido 1px de margen, recortado al lienzo) -- el resto del
    lienzo es 0/background por construcción.
    """
    root = ET.fromstring(svg_text)
    subpaths, _ = collect_document_subpaths(root)

    mask = np.zeros((height, width), dtype=np.uint8)
    fillable = [sp for sp in subpaths if len(sp["points"]) >= _MIN_POINTS_FOR_FILL]
    if not fillable:
        return mask

    xs = [x for sp in fillable for x, _ in sp["points"]]
    ys = [y for sp in fillable for _, y in sp["points"]]
    min_x = max(0, int(math.floor(min(xs))) - 1)
    min_y = max(0, int(math.floor(min(ys))) - 1)
    max_x = min(width, int(math.ceil(max(xs))) + 1)
    max_y = min(height, int(math.ceil(max(ys))) + 1)
    bbox_width = max(1, max_x - min_x)
    bbox_height = max(1, max_y - min_y)

    rings = [
        np.array([[x - min_x, y - min_y] for x, y in subpath["points"]], dtype=np.float64) for subpath in fillable
    ]
    accumulated = np.where(fill_even_odd(rings, bbox_width, bbox_height), np.uint8(255), np.uint8(0))
    mask[min_y:max_y, min_x:max_x] = accumulated

    return mask


class RasterValidationOutcome:
    """Resultado puro de comparar la geometría reconstruida de UNA capa
    contra su máscara de origen y contra las máscaras de las DEMÁS capas de
    la misma paleta. Ver `compare_layer_raster`."""

    def __init__(
        self,
        own_mismatch_ratio: float,
        own_mismatch_tolerance: float,
        contamination_ratio: float,
        contamination_tolerance: float,
    ) -> None:
        self.own_mismatch_ratio = own_mismatch_ratio
        self.own_mismatch_tolerance = own_mismatch_tolerance
        self.contamination_ratio = contamination_ratio
        self.contamination_tolerance = contamination_tolerance

    @property
    def own_mismatch_within_tolerance(self) -> bool:
        return self.own_mismatch_ratio <= self.own_mismatch_tolerance

    @property
    def contamination_within_tolerance(self) -> bool:
        return self.contamination_ratio <= self.contamination_tolerance

    @property
    def warnings(self) -> list[str]:
        """Mensajes legibles para logging -- nunca bloquean la generación de
        la capa (ver spec.md, "Ambigüedades detectadas": "advertir, no
        bloquear", decisión documentada en el reporte del sprint)."""
        messages: list[str] = []
        if not self.own_mismatch_within_tolerance:
            messages.append(
                f"La geometría vectorial difiere de su máscara de origen en "
                f"{self.own_mismatch_ratio:.4%} de su área de foreground "
                f"(tolerancia: {self.own_mismatch_tolerance:.4%})."
            )
        if not self.contamination_within_tolerance:
            messages.append(
                f"El área vectorizada de esta capa contiene {self.contamination_ratio:.4%} "
                f"de píxeles que pertenecen a la máscara de OTRO color "
                f"(tolerancia: {self.contamination_tolerance:.4%}) -- posible contaminación cruzada."
            )
        return messages

    def to_dict(self) -> dict:
        return {
            "own_mismatch_ratio": self.own_mismatch_ratio,
            "own_mismatch_tolerance": self.own_mismatch_tolerance,
            "own_mismatch_within_tolerance": self.own_mismatch_within_tolerance,
            "contamination_ratio": self.contamination_ratio,
            "contamination_tolerance": self.contamination_tolerance,
            "contamination_within_tolerance": self.contamination_within_tolerance,
            "warnings": self.warnings,
        }


def compare_layer_raster(
    reconstructed_mask: np.ndarray,
    own_mask: np.ndarray,
    other_masks_union: np.ndarray,
    own_mismatch_tolerance: float,
    contamination_tolerance: float,
) -> RasterValidationOutcome:
    """Compara la máscara RECONSTRUIDA (rasterizada de vuelta desde el SVG,
    ver `rasterize_svg_mask`) contra (a) la máscara ORIGINAL de esta misma
    capa -- fidelidad propia -- y (b) la UNIÓN de las máscaras originales de
    TODAS las demás capas de la paleta -- contaminación cruzada. Las tres
    máscaras deben tener exactamente las mismas dimensiones (garantizado por
    el caller: mismo lienzo sin recortar para toda la paleta, M2-S02).

    `own_mismatch_ratio` = píxeles donde reconstructed_mask y own_mask
    difieren (XOR), relativo al área de foreground de `own_mask` (si la
    máscara original está vacía -- no debería ocurrir, M2-S02 ya rechaza
    máscaras vacías antes de llegar acá -- se usa 1 como denominador para
    evitar división por cero sin lanzar).

    `contamination_ratio` = píxeles donde reconstructed_mask es foreground Y
    `other_masks_union` también es foreground, relativo al área de
    foreground de `reconstructed_mask` (mismo criterio de "relativo al propio
    resultado" -- si la capa reconstruida está vacía, 0% de contaminación por
    definición, no hay área que contaminar).
    """
    own_foreground = int(np.count_nonzero(own_mask))
    reconstructed_foreground = int(np.count_nonzero(reconstructed_mask))

    mismatch_pixels = int(np.count_nonzero(cv2.bitwise_xor(reconstructed_mask, own_mask)))
    own_mismatch_ratio = mismatch_pixels / max(own_foreground, 1)

    if reconstructed_foreground == 0:
        contamination_ratio = 0.0
    else:
        contamination_pixels = int(np.count_nonzero(cv2.bitwise_and(reconstructed_mask, other_masks_union)))
        contamination_ratio = contamination_pixels / reconstructed_foreground

    return RasterValidationOutcome(
        own_mismatch_ratio=own_mismatch_ratio,
        own_mismatch_tolerance=own_mismatch_tolerance,
        contamination_ratio=contamination_ratio,
        contamination_tolerance=contamination_tolerance,
    )
