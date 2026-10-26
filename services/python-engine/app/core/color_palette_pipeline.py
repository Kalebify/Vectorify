"""Detección y reducción de paleta de colores (M2-S01): agrupa los píxeles de
una imagen en un número acotado de "colores dominantes" mediante clustering
determinista en espacio de color Lab (CIELAB), respetando una tolerancia de
fusión automática y un número objetivo (límite superior) de colores.

Decisión de diseño -- espacio de color (ver "Ambigüedades detectadas" de
spec.md, "el implementador decide y documenta"): se eligió Lab (vía
cv2.cvtColor, ya presente como dependencia -- OpenCV -- sin agregar ninguna
librería nueva) en vez de RGB/BGR puro. Lab fue diseñado para que la distancia
euclídea entre dos puntos se aproxime a la diferencia de color PERCIBIDA por
el ojo humano (a diferencia de RGB, donde la misma distancia euclídea puede
representar saltos de percepción muy distintos según la zona del espacio de
color -- ej. verdes muy distintos entre sí en RGB pueden percibirse como casi
iguales). Para esta herramienta (agrupar colores de un diseño para asignarles
una operación de láser distinta cada uno, M2-S07) importa que "casi el mismo
color" se fusione aunque sus componentes RGB numéricos difieran más que entre
otros pares de colores que SÍ deberían quedar separados -- HSV se descartó
por ser más inestable para grises/casi-grises (Hue indefinido/ruidoso cuando
la saturación es baja, exactamente el caso de sombras/antialiasing sobre un
mismo color lógico, uno de los casos de prueba explícitos de spec.md).

Algoritmo: clustering aglomerativo determinista, SIN aleatoriedad (a
diferencia de k-means con centroides iniciales al azar): se procesan los
colores únicos de la imagen en orden descendente de frecuencia (con empate
resuelto por orden lexicográfico BGR ascendente, ya que np.unique(axis=0)
ordena así de por sí) y cada uno se fusiona con el cluster existente más
cercano en Lab si la distancia es <= tolerancia, o funda un cluster nuevo si
no. Si el resultado tiene más clusters que el `max_colors` pedido, se
fusionan repetidamente los dos clusters más parecidos entre sí hasta entrar
en el límite. Mismos parámetros + misma imagen -> mismo resultado, siempre
(ver spec.md: "paleta ... reproducible").

Transparencia: un píxel con alpha=0 (totalmente transparente) se excluye por
completo del clustering -- nunca cuenta como "color" de la paleta (se
reporta aparte, como `transparent_pixel_count`/`transparent_percent`, para
poder distinguirlo de un color sólido de fondo real). Un píxel con alpha
parcial (0 < alpha < 255) SÍ participa del clustering por su color RGB
compuesto, pero cada cluster resultante expone `has_partial_alpha` para que
el caller sepa que parte de su área no es completamente opaca.

M2.1-S02 -- endurecimiento de la detección (ver spec.md, "Ambigüedades
detectadas", este archivo mantiene el algoritmo de clustering Lab ya
existente, sin migrar a k-means/median-cut: el cuerpo de la tarjeta permite
explícitamente conservarlo si ya cumple, y el clustering aglomerativo
determinista de arriba ya lo hace):

1. `tiny_area_ratio` (nuevo parámetro opcional de `detect_palette`, default
   0.0 = deshabilitado a este nivel -- ver app.services.color_palette_service,
   que SÍ pasa un default no-cero real en producción, resuelto por
   Vectorify.Api.Options.ColorPaletteOptions): antes de aplicar `max_colors`,
   cualquier cluster cuya área (relativa a la cantidad de píxeles
   "relevantes", es decir no completamente transparentes) sea menor que este
   umbral se fusiona con su vecino de color más cercano en Lab, SIN importar
   `tolerance` -- ataca la causa raíz ya documentada en la auditoría
   M2.1-S01 ("con antialiasing, 17 grupos en vez de ~5 lógicos"): los bordes
   suavizados generan clusters minúsculos de "colores casi iguales" que
   sobreviven al primer paso de clustering porque cada uno, tomado solo,
   puede estar a más de `tolerance` de distancia del cluster vecino más
   cercano (aunque sea un color visualmente irrelevante por su área). Ver
   `_merge_tiny_groups_into_nearest` para el detalle, y el reporte del
   sprint (`IMPL.md`) para la evidencia empírica antes/después que motivó el
   valor default elegido.
2. `touches_border` (nuevo campo de `ColorGroup`): fracción del perímetro de
   la imagen (fila superior/inferior + columna izquierda/derecha, sin
   contar dos veces las esquinas) que pertenece a este grupo, comparada
   contra `_BACKGROUND_BORDER_TOUCH_RATIO` -- ver `_border_touch_ratio`.
   Vectorify.Api usa este flag (junto con que el grupo sea el de mayor área,
   ya garantizado por el orden de `groups` de abajo) para PRE-marcar un
   fondo dominante como excluido por default, sin que eso le impida al
   usuario cambiarlo manualmente después (ver ColorPaletteService.DetectAsync).
"""

from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np

__all__ = ["ColorGroup", "PaletteDetectionResult", "detect_palette"]

# Umbral de "toca el borde" (M2.1-S02): fracción del perímetro total de la
# imagen que debe pertenecer a un grupo para considerarlo "candidato a fondo"
# por tocar los bordes -- spec.md no lo cuantifica ("el implementador decide
# y documenta", ver "Ambigüedades detectadas"). 0.5 (mayoría absoluta del
# perímetro) se eligió porque un fondo real típicamente rodea la imagen casi
# por completo, mientras que una forma en primer plano que apenas roza una
# esquina o un borde (ej. un elemento decorativo cortado por el encuadre)
# normalmente cubre una fracción bastante menor del perímetro total.
_BACKGROUND_BORDER_TOUCH_RATIO = 0.5


@dataclass(frozen=True)
class ColorGroup:
    """Un color/grupo detectado: color representativo (promedio ponderado
    por cantidad de píxeles de los colores únicos que lo integran), cuántos
    píxeles ocupa, y una máscara binaria (0/255, mismas dimensiones que la
    imagen de origen) con los píxeles que pertenecen a este grupo.

    `touches_border` (M2.1-S02): True si este grupo cubre al menos
    `_BACKGROUND_BORDER_TOUCH_RATIO` del perímetro de la imagen -- ver
    `_border_touch_ratio` y el docstring del módulo."""

    color_bgr: tuple[int, int, int]
    pixel_count: int
    has_partial_alpha: bool
    touches_border: bool
    mask: np.ndarray


@dataclass(frozen=True)
class PaletteDetectionResult:
    width: int
    height: int
    total_pixel_count: int
    transparent_pixel_count: int
    groups: list[ColorGroup] = field(default_factory=list)


def extract_unique_colors(
    pixels: np.ndarray, max_unique_colors: int
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Devuelve (colores_únicos, inverse, counts) de forma determinista
    (claves BGR de 24 bits ordenadas lexicográficamente, sin aleatoriedad). Si la
    cantidad de colores únicos observados supera `max_unique_colors`
    (imágenes de tono continuo/fotografías, fuera del caso de uso principal
    de esta herramienta -- diseños gráficos para corte láser), se re-
    cuantiza el color a menos niveles por canal (potencias de 2 crecientes)
    hasta que la cardinalidad entra en el presupuesto -- acota el costo
    O(k)/O(k^2) del clustering de abajo sin sacrificar el determinismo:
    mismos píxeles de entrada + mismo `max_unique_colors` siempre producen
    el mismo resultado.

    `inverse` tiene la misma longitud que `pixels` (uno por fila) y apunta al
    índice del color único correspondiente -- se usa para reconstruir la
    máscara de cada cluster sin tener que volver a comparar colores píxel a
    píxel.
    """
    # np.unique(axis=0) ordena filas estructuradas: repetirlo sobre una foto
    # de millones de píxeles puede agotar el timeout. Una clave de 24 bits
    # conserva exactamente el orden BGR y permite el ordenamiento numérico.
    packed = pixels.astype(np.uint32)
    keys = (packed[:, 0] << 16) | (packed[:, 1] << 8) | packed[:, 2]
    step = 1
    working = keys
    while True:
        unique, inverse, counts = np.unique(working, return_inverse=True, return_counts=True)
        # Tope de step=128 (no 256): a step=256, `canal // 256 * 256` colapsa
        # TODO canal a 0 (uint8 nunca llega a 256), perdiendo toda la
        # información de color de un plumazo. A step=128 cada canal queda en
        # como máximo 2 niveles (0/128) -- ya reduce la cardinalidad a un
        # máximo de 8 colores sin degenerar a un único color.
        if len(unique) <= max_unique_colors or step >= 128:
            colors = np.column_stack([(unique >> 16) & 255, (unique >> 8) & 255, unique & 255]).astype(np.uint8)
            inverse = inverse.reshape(-1)
            if step > 1:
                # El bucket solo limita el costo del clustering. Su borde inferior
                # oscurece todos los tonos (blanco 255 -> 224 a step=32).
                # Representar cada bucket con la media de los píxeles ORIGINALES.
                sums = np.column_stack([
                    np.bincount(inverse, weights=pixels[:, channel], minlength=len(colors))
                    for channel in range(3)
                ])
                colors = np.rint(sums / counts[:, None]).astype(np.uint8)
            return colors, inverse, counts
        step *= 2
        channel_mask = 256 - step
        working = keys & ((channel_mask << 16) | (channel_mask << 8) | channel_mask)


class _UnionFind:
    """Estructura union-find mínima para fusionar clusters hacia
    `max_colors`, conservando en todo momento a qué cluster "vivo" terminó
    perteneciendo cada cluster original (con compresión de camino)."""

    def __init__(self, size: int) -> None:
        self._parent = list(range(size))

    def find(self, x: int) -> int:
        root = x
        while self._parent[root] != root:
            root = self._parent[root]
        while self._parent[x] != root:
            self._parent[x], x = root, self._parent[x]
        return root

    def union(self, keep: int, absorb: int) -> None:
        self._parent[self.find(absorb)] = self.find(keep)


def _cluster_unique_colors(
    colors: np.ndarray, counts: np.ndarray, partial_any: np.ndarray, tolerance: float
) -> tuple[list[np.ndarray], list[int], list[np.ndarray], list[bool], np.ndarray]:
    """Primer paso del clustering: agrupa los colores únicos entre sí según
    `tolerance` (distancia Lab), en orden descendente de frecuencia. Devuelve
    los centroides Lab, conteos de píxeles, sumas BGR ponderadas y flag de
    alpha parcial de cada cluster inicial, junto con el mapeo
    color_único -> cluster inicial."""
    lab_colors = cv2.cvtColor(colors.reshape(-1, 1, 3), cv2.COLOR_BGR2LAB).reshape(-1, 3).astype(np.float64)
    order = np.argsort(-counts, kind="stable")

    centroids_lab: list[np.ndarray] = []
    pixel_counts: list[int] = []
    bgr_sums: list[np.ndarray] = []
    has_partial: list[bool] = []
    unique_to_cluster = np.full(len(colors), -1, dtype=np.int64)

    for idx in order:
        lab = lab_colors[idx]
        count = int(counts[idx])
        bgr = colors[idx].astype(np.float64)

        assigned = -1
        if centroids_lab:
            centroids_arr = np.stack(centroids_lab)
            dists = np.linalg.norm(centroids_arr - lab, axis=1)
            best = int(np.argmin(dists))
            if dists[best] <= tolerance:
                assigned = best

        if assigned == -1:
            centroids_lab.append(lab.copy())
            pixel_counts.append(count)
            bgr_sums.append(bgr * count)
            has_partial.append(bool(partial_any[idx]))
            unique_to_cluster[idx] = len(centroids_lab) - 1
        else:
            new_count = pixel_counts[assigned] + count
            centroids_lab[assigned] = (centroids_lab[assigned] * pixel_counts[assigned] + lab * count) / new_count
            bgr_sums[assigned] = bgr_sums[assigned] + bgr * count
            pixel_counts[assigned] = new_count
            has_partial[assigned] = has_partial[assigned] or bool(partial_any[idx])
            unique_to_cluster[idx] = assigned

    return centroids_lab, pixel_counts, bgr_sums, has_partial, unique_to_cluster


def _merge_tiny_groups_into_nearest(
    centroids_lab: list[np.ndarray],
    pixel_counts: list[int],
    bgr_sums: list[np.ndarray],
    has_partial: list[bool],
    tiny_area_ratio: float,
    total_relevant_pixel_count: int,
) -> tuple[list[int], _UnionFind]:
    """Paso de limpieza (M2.1-S02, se aplica ANTES de `_merge_down_to_max_colors`):
    mientras quede más de un cluster "vivo" y el más chico de todos siga por
    debajo de `tiny_area_ratio` (relativo a `total_relevant_pixel_count`, NO
    al área total del lienzo -- así una imagen con mucho margen transparente
    no hace que colores opacos legítimos parezcan "diminutos"), lo fusiona
    con su vecino de color más cercano en Lab -- SIN mirar `tolerance`, a
    diferencia de `_cluster_unique_colors`: un cluster de 3 píxeles a
    distancia 40 en Lab de su vecino más cercano sigue siendo ruido de
    antialiasing que hay que absorber, no un color legítimo que preservar
    separado solo porque nadie más quedó tan cerca.

    Determinista: ante empate de tamaño, se elige el índice de cluster más
    bajo (`min` con clave `(pixel_counts[i], i)`); el vecino más cercano se
    resuelve con `np.argmin` sobre la lista de candidatos en el mismo orden
    en que aparecen en `live` (primera ocurrencia en caso de empate de
    distancia). `tiny_area_ratio <= 0` (o un único cluster) es un no-op
    explícito -- ver ColorPaletteOptions/color_palette_pipeline docstring
    del módulo: este paso es opcional/configurable, nunca obligatorio.
    """
    union_find = _UnionFind(len(pixel_counts))
    live = list(range(len(pixel_counts)))

    if tiny_area_ratio <= 0 or total_relevant_pixel_count <= 0:
        return live, union_find

    threshold = tiny_area_ratio * total_relevant_pixel_count

    while len(live) > 1:
        smallest = min(live, key=lambda i: (pixel_counts[i], i))
        if pixel_counts[smallest] >= threshold:
            break

        candidates = [i for i in live if i != smallest]
        centroids_arr = np.stack([centroids_lab[i] for i in candidates])
        dists = np.linalg.norm(centroids_arr - centroids_lab[smallest], axis=1)
        nearest = candidates[int(np.argmin(dists))]

        total = pixel_counts[smallest] + pixel_counts[nearest]
        centroids_lab[nearest] = (
            centroids_lab[nearest] * pixel_counts[nearest] + centroids_lab[smallest] * pixel_counts[smallest]
        ) / total
        bgr_sums[nearest] = bgr_sums[nearest] + bgr_sums[smallest]
        pixel_counts[nearest] = total
        has_partial[nearest] = has_partial[nearest] or has_partial[smallest]

        union_find.union(keep=nearest, absorb=smallest)
        live.remove(smallest)

    return live, union_find


def _merge_down_to_max_colors(
    centroids_lab: list[np.ndarray],
    pixel_counts: list[int],
    bgr_sums: list[np.ndarray],
    has_partial: list[bool],
    max_colors: int,
    live: list[int] | None = None,
    union_find: _UnionFind | None = None,
) -> tuple[list[int], _UnionFind]:
    """Segundo paso (opcional): mientras haya más clusters que `max_colors`,
    fusiona repetidamente el par de clusters "vivos" más parecido entre sí
    (menor distancia Lab entre centroides), determinista (ante empates, el
    primero encontrado en orden de `live` ascendente, ya que np.argmin sobre
    una matriz aplanada devuelve la primera ocurrencia en orden row-major).

    `live`/`union_find`, si se pasan (ver `detect_palette`: se les pasa el
    resultado de `_merge_tiny_groups_into_nearest`), continúan ese mismo
    union-find en vez de arrancar de cero -- el presupuesto `max_colors` se
    aplica sobre los clusters que quedaron VIVOS después de la limpieza de
    grupos diminutos, no sobre los originales (algunos de esos índices ya
    fueron absorbidos y no deberían volver a contarse).
    """
    if union_find is None:
        union_find = _UnionFind(len(pixel_counts))
    live = list(range(len(pixel_counts))) if live is None else list(live)

    while len(live) > max_colors:
        centroids_arr = np.stack([centroids_lab[i] for i in live])
        diff = centroids_arr[:, None, :] - centroids_arr[None, :, :]
        dist_matrix = np.linalg.norm(diff, axis=2)
        np.fill_diagonal(dist_matrix, np.inf)
        flat_index = int(np.argmin(dist_matrix))
        a, b = np.unravel_index(flat_index, dist_matrix.shape)
        i_live, j_live = live[int(a)], live[int(b)]
        if i_live > j_live:
            i_live, j_live = j_live, i_live

        total = pixel_counts[i_live] + pixel_counts[j_live]
        centroids_lab[i_live] = (
            centroids_lab[i_live] * pixel_counts[i_live] + centroids_lab[j_live] * pixel_counts[j_live]
        ) / total
        bgr_sums[i_live] = bgr_sums[i_live] + bgr_sums[j_live]
        pixel_counts[i_live] = total
        has_partial[i_live] = has_partial[i_live] or has_partial[j_live]

        union_find.union(keep=i_live, absorb=j_live)
        live.remove(j_live)

    return live, union_find


def _border_touch_ratio(mask: np.ndarray) -> float:
    """Fracción del perímetro de la imagen (fila superior + fila inferior +
    columna izquierda + columna derecha, sin contar dos veces las cuatro
    esquinas) que pertenece a este grupo (`mask == 255`) -- ver
    `_BACKGROUND_BORDER_TOUCH_RATIO` y el docstring del módulo. Imágenes de
    1 fila o 1 columna siguen siendo válidas: cada borde colapsa a la
    fila/columna única existente, sin dividir por cero."""
    height, width = mask.shape[:2]
    if height == 0 or width == 0:
        return 0.0

    border = np.zeros((height, width), dtype=bool)
    border[0, :] = True
    border[height - 1, :] = True
    border[:, 0] = True
    border[:, width - 1] = True

    total_border = int(np.count_nonzero(border))
    if total_border == 0:
        return 0.0

    touched = int(np.count_nonzero((mask == 255) & border))
    return touched / total_border


def detect_palette(
    bgr: np.ndarray,
    alpha: np.ndarray | None,
    tolerance: float,
    max_colors: int | None,
    max_unique_colors: int,
    tiny_area_ratio: float = 0.0,
) -> PaletteDetectionResult:
    """Punto de entrada: agrupa los píxeles de `bgr` (imagen decodificada,
    3 canales) en como máximo `max_colors` grupos de color (si se especifica),
    fusionando automáticamente los que estén a distancia Lab <= `tolerance`.
    `alpha`, si no es None, marca como excluidos (ni color ni fusión) los
    píxeles con alpha=0 -- ver docstring del módulo. `tiny_area_ratio`
    (default 0.0 = deshabilitado a este nivel, ver docstring del módulo)
    fusiona hacia su vecino más cercano cualquier grupo cuya área sea menor
    a esa fracción del total de píxeles relevantes, ANTES de aplicar
    `max_colors` -- ver `_merge_tiny_groups_into_nearest`.
    """
    height, width = bgr.shape[:2]
    total_pixel_count = height * width
    flat_bgr = bgr.reshape(-1, 3)

    if alpha is not None:
        flat_alpha = alpha.reshape(-1)
        transparent_flat = flat_alpha == 0
        partial_flat = (flat_alpha > 0) & (flat_alpha < 255)
        relevant_flat = flat_alpha > 0
    else:
        transparent_flat = np.zeros(total_pixel_count, dtype=bool)
        partial_flat = np.zeros(total_pixel_count, dtype=bool)
        relevant_flat = np.ones(total_pixel_count, dtype=bool)

    transparent_pixel_count = int(np.count_nonzero(transparent_flat))
    relevant_indices = np.nonzero(relevant_flat)[0]

    if relevant_indices.size == 0:
        # Imagen completamente transparente: no hay ningún color que detectar.
        return PaletteDetectionResult(
            width=width, height=height, total_pixel_count=total_pixel_count,
            transparent_pixel_count=transparent_pixel_count, groups=[],
        )

    relevant_pixels = flat_bgr[relevant_indices]
    relevant_partial = partial_flat[relevant_indices]

    colors, inverse, counts = extract_unique_colors(relevant_pixels, max_unique_colors)

    partial_any = np.zeros(len(colors), dtype=bool)
    np.logical_or.at(partial_any, inverse, relevant_partial)

    centroids_lab, pixel_counts, bgr_sums, has_partial, unique_to_cluster = _cluster_unique_colors(
        colors, counts, partial_any, tolerance
    )

    live, union_find = _merge_tiny_groups_into_nearest(
        centroids_lab, pixel_counts, bgr_sums, has_partial, tiny_area_ratio, int(relevant_indices.size)
    )

    if max_colors is not None and len(live) > max_colors:
        live, union_find = _merge_down_to_max_colors(
            centroids_lab, pixel_counts, bgr_sums, has_partial, max_colors, live=live, union_find=union_find
        )

    # Orden de presentación final: por cantidad de píxeles descendente,
    # empate por índice de cluster "vivo" ascendente (determinista).
    live_sorted = sorted(live, key=lambda i: (-pixel_counts[i], i))
    rank_by_live_index = {live_index: rank for rank, live_index in enumerate(live_sorted)}

    unique_to_final = np.array(
        [rank_by_live_index[union_find.find(int(c))] for c in unique_to_cluster], dtype=np.int64,
    )

    pixel_final_cluster = unique_to_final[inverse]
    label_flat = np.full(total_pixel_count, -1, dtype=np.int32)
    label_flat[relevant_indices] = pixel_final_cluster
    label_image = label_flat.reshape(height, width)

    groups: list[ColorGroup] = []
    for rank, live_index in enumerate(live_sorted):
        count = pixel_counts[live_index]
        avg_bgr = bgr_sums[live_index] / count
        color_bgr = tuple(int(round(channel)) for channel in np.clip(avg_bgr, 0, 255))
        mask = np.where(label_image == rank, np.uint8(255), np.uint8(0))
        groups.append(
            ColorGroup(
                color_bgr=color_bgr,  # type: ignore[arg-type]
                pixel_count=int(count),
                has_partial_alpha=bool(has_partial[live_index]),
                touches_border=_border_touch_ratio(mask) >= _BACKGROUND_BORDER_TOUCH_RATIO,
                mask=mask,
            )
        )

    return PaletteDetectionResult(
        width=width,
        height=height,
        total_pixel_count=total_pixel_count,
        transparent_pixel_count=transparent_pixel_count,
        groups=groups,
    )


def build_quantized_preview(result: PaletteDetectionResult) -> np.ndarray:
    """Construye la imagen "cuantizada" (BGRA): cada píxel pintado con el
    color representativo de su grupo, y completamente transparente si no
    pertenece a ningún grupo (excluido por alpha=0 en el origen) -- ver
    spec.md: "preview del resultado cuantizado"."""
    preview = np.zeros((result.height, result.width, 4), dtype=np.uint8)
    for group in result.groups:
        b, g, r = group.color_bgr
        preview[group.mask == 255] = (b, g, r, 255)
    return preview
