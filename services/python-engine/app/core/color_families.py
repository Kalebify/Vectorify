"""Agrupación de grupos de color detallados en FAMILIAS de color base y
detección del fondo como máscara independiente del color (tarjeta "Agrupar
sombras y variantes en colores base antes de vectorizar").

Este módulo es aritmética pura sobre arrays: no conoce `ColorGroup` ni nada
del pato. Decisiones (documentadas en .sprint/405d77b2-.../spec.md):

Clasificación (Lab -> L, C, h). Un grupo es NEUTRO si su croma C es menor que
`neutral_chroma` o si es casi negro (L < `dark_lightness`: el tono es
inestable con tan poca luz); en otro caso es CROMÁTICO.

* Neutros: solo importa la luminosidad. Se ordenan por L y se parten donde
  el salto entre vecinos supera `neutral_l_gap` (enlace simple 1-D): una
  rampa continua de grises/sombras es una única familia, pero negro y gris
  medio quedan separados. Deterministas, sin aleatoriedad.
* Cromáticos: fusión aglomerativa por centroides Lab ponderados por píxeles.
  Dos cromáticos solo pueden fusionarse si (1) la diferencia de TONO circular
  entre centroides es <= `hue_gap` (los rojos a ambos lados de 0°/360°
  cuentan como vecinos), (2) |ΔL| <= `l_guard` y (3) |ΔC| <= `c_guard`: así un
  pastel y el mismo tono saturado, o dos luminosidades muy distintas, no se
  fusionan solo por compartir tinta (la guarda se relaja con la intensidad).
  Se fusiona primero el par de menor diferencia de tono (empate: menores
  índices).
* Nunca se fusiona un neutro con un cromático por umbral: una sombra gris de
  un ojo jamás pasa a naranja solo por tener un tinte cálido. Solo el tope
  `target_families` puede forzar esa fusión, eligiendo el par de menor ΔE.

Fondo: ver `detect_background`.
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

__all__ = [
    "ALGORITHM_VERSION",
    "BackgroundDetection",
    "FamilyThresholds",
    "cluster_families",
    "detect_background",
    "lab_features",
    "resolve_transition_pixels",
    "thresholds_for",
]

# Versión del algoritmo de agrupación por familias: forma parte de la clave de
# caché, de la persistencia y de la respuesta. Subirla invalida paletas
# cacheadas con otra versión (nunca se reutilizan entre versiones).
ALGORITHM_VERSION = 1

# Fracción del perímetro que debe ocupar el color de fondo (mismo criterio que
# color_palette_pipeline._BACKGROUND_BORDER_TOUCH_RATIO).
_BACKGROUND_PERIMETER_RATIO = 0.5
# Radio del elemento estructurante de la apertura que detecta cuellos
# estrechos: fracción del lado menor (mínimo 2 px).
_NECK_RADIUS_RATIO = 0.01
# El contacto de un objeto claro con el fondo solo cuenta si el objeto es más
# grueso que un anillo de antialiasing (radio del elemento de apertura, px).
_CONTACT_OPENING_RADIUS = 2
# "Cerca del color de fondo" para el contacto: múltiplo de la tolerancia.
_CONTACT_DELTA_E_FACTOR = 3.0


@dataclass(frozen=True)
class FamilyThresholds:
    neutral_chroma: float
    dark_lightness: float
    neutral_l_gap: float
    hue_gap: float
    l_guard: float
    c_guard: float


def thresholds_for(strength: float) -> FamilyThresholds:
    """Umbrales en función de la intensidad de agrupación (0 = conservador,
    1 = agresivo). Con 0,5 (default): croma neutro 13, salto de luminosidad
    22, tono 30°, guardas de luminosidad 60 y de croma 60."""
    s = min(1.0, max(0.0, float(strength)))
    return FamilyThresholds(
        neutral_chroma=8.0 + 10.0 * s,
        dark_lightness=12.0,
        neutral_l_gap=12.0 + 20.0 * s,
        hue_gap=12.0 + 36.0 * s,
        l_guard=45.0 + 30.0 * s,
        c_guard=30.0 + 60.0 * s,
    )


def lab_features(colors_bgr: np.ndarray) -> np.ndarray:
    """(n, 3) BGR uint8 -> (n, 3) Lab real (L 0-100, a/b con signo) float64."""
    colors = np.asarray(colors_bgr, dtype=np.uint8).reshape(-1, 1, 3)
    lab = cv2.cvtColor(colors.astype(np.float32) / 255.0, cv2.COLOR_BGR2LAB)
    return lab.reshape(-1, 3).astype(np.float64)


def _chroma_hue(lab: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    chroma = np.hypot(lab[..., 1], lab[..., 2])
    hue = np.degrees(np.arctan2(lab[..., 2], lab[..., 1])) % 360.0
    return chroma, hue


def _circular_diff(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    d = np.abs(a - b) % 360.0
    return np.minimum(d, 360.0 - d)


def _split_neutral_by_lightness(indices: list[int], lab: np.ndarray, gap: float) -> list[list[int]]:
    ordered = sorted(indices, key=lambda i: (lab[i, 0], i))
    clusters: list[list[int]] = []
    previous_l: float | None = None
    for i in ordered:
        if previous_l is None or lab[i, 0] - previous_l > gap:
            clusters.append([i])
        else:
            clusters[-1].append(i)
        previous_l = lab[i, 0]
    return clusters


def _weighted_centroid(indices: list[int], lab: np.ndarray, weights: np.ndarray) -> np.ndarray:
    w = weights[indices].astype(np.float64)
    return (lab[indices] * w[:, None]).sum(axis=0) / w.sum()


def _merge_chromatic(
    indices: list[int], lab: np.ndarray, weights: np.ndarray, thresholds: FamilyThresholds
) -> list[list[int]]:
    clusters: list[list[int]] = [[i] for i in sorted(indices)]
    while len(clusters) > 1:
        centroids = np.stack([_weighted_centroid(c, lab, weights) for c in clusters])
        chroma, hue = _chroma_hue(centroids)
        hue_diff = _circular_diff(hue[:, None], hue[None, :])
        l_diff = np.abs(centroids[:, None, 0] - centroids[None, :, 0])
        c_diff = np.abs(chroma[:, None] - chroma[None, :])
        allowed = (hue_diff <= thresholds.hue_gap) & (l_diff <= thresholds.l_guard) & (c_diff <= thresholds.c_guard)
        np.fill_diagonal(allowed, False)
        if not allowed.any():
            break
        candidate = np.where(allowed, hue_diff, np.inf)
        flat = int(np.argmin(candidate))  # primera ocurrencia en orden row-major: determinista
        a, b = np.unravel_index(flat, candidate.shape)
        a, b = (int(a), int(b)) if a < b else (int(b), int(a))
        clusters[a] = sorted(clusters[a] + clusters[b])
        del clusters[b]
    return clusters


def _cap_families(
    clusters: list[list[int]], lab: np.ndarray, weights: np.ndarray, target: int
) -> list[list[int]]:
    clusters = [list(c) for c in clusters]
    while len(clusters) > max(1, target):
        centroids = np.stack([_weighted_centroid(c, lab, weights) for c in clusters])
        dist = np.linalg.norm(centroids[:, None, :] - centroids[None, :, :], axis=2)
        np.fill_diagonal(dist, np.inf)
        flat = int(np.argmin(dist))
        a, b = np.unravel_index(flat, dist.shape)
        a, b = (int(a), int(b)) if a < b else (int(b), int(a))
        clusters[a] = sorted(clusters[a] + clusters[b])
        del clusters[b]
    return clusters


def cluster_families(
    lab: np.ndarray, weights: np.ndarray, strength: float, target_families: int | None
) -> list[int]:
    """Devuelve, para cada fila de `lab` (un color detallado), el índice de su
    familia. Los índices de familia son estables: se asignan en el orden de
    su miembro de menor índice de entrada."""
    count = len(lab)
    if count == 0:
        return []
    thresholds = thresholds_for(strength)
    chroma, _ = _chroma_hue(lab)
    neutral = [i for i in range(count) if chroma[i] < thresholds.neutral_chroma or lab[i, 0] < thresholds.dark_lightness]
    chromatic = [i for i in range(count) if i not in set(neutral)]

    clusters = _split_neutral_by_lightness(neutral, lab, thresholds.neutral_l_gap) if neutral else []
    if chromatic:
        clusters += _merge_chromatic(chromatic, lab, weights, thresholds)
    if target_families is not None:
        clusters = _cap_families(clusters, lab, weights, target_families)

    clusters.sort(key=lambda c: min(c))
    labels = [0] * count
    for family_index, members in enumerate(clusters):
        for i in members:
            labels[i] = family_index
    return labels


# --- Fondo ---


@dataclass(frozen=True)
class BackgroundDetection:
    """Resultado interno de `detect_background`. `mask` es el fondo SEGURO
    (0/255); `ambiguous` es lo que está conectado al fondo solo por un cuello
    estrecho y se conserva en su familia para revisión."""

    mask: np.ndarray
    ambiguous: np.ndarray
    reference_group: int
    contact_pixel_count: int


def _border_labels(labels: np.ndarray) -> set[int]:
    values = np.concatenate([labels[0, :], labels[-1, :], labels[:, 0], labels[:, -1]])
    return set(int(v) for v in np.unique(values)) - {0}


def _components_touching_border(mask: np.ndarray, connectivity: int = 4) -> np.ndarray:
    count, labels = cv2.connectedComponents(mask.astype(np.uint8), connectivity=connectivity)
    if count <= 1:
        return np.zeros(mask.shape, dtype=bool)
    touching = _border_labels(labels)
    if not touching:
        return np.zeros(mask.shape, dtype=bool)
    return np.isin(labels, list(touching))


def _perimeter_index(height: int, width: int) -> np.ndarray:
    border = np.zeros((height, width), dtype=bool)
    border[0, :] = True
    border[height - 1, :] = True
    border[:, 0] = True
    border[:, width - 1] = True
    return border


def detect_background(
    group_masks: list[np.ndarray],
    group_colors_bgr: list[tuple[int, int, int]],
    bgr: np.ndarray,
    relevant: np.ndarray,
    tolerance: float,
    neutral_chroma: float,
) -> BackgroundDetection | None:
    """Fondo = componentes (4-conexos) conectados al borde del grupo de color
    detallado que más perímetro ocupa, siempre que ocupe >= 50 % del
    perímetro y quede algo de primer plano.

    Salida segura ante ambigüedad: una apertura morfológica separa del fondo
    las 'bolsas' que solo se conectan por un cuello más fino que el elemento
    estructurante (un blanco de primer plano pegado a un fondo blanco sin
    borde distinguible); esas bolsas NO se borran: quedan fuera de la máscara
    de fondo (pertenecen a su familia) y se cuentan como ambiguas. Además se
    mide el contacto del fondo con objetos claros neutros más gruesos que un
    anillo de antialiasing (p. ej. un ojo blanco junto a un fondo blanco): si
    existe, la revisión humana es necesaria aunque no haya cuello.
    """
    height, width = relevant.shape
    if not group_masks:
        return None
    perimeter = _perimeter_index(height, width)
    perimeter_total = int(np.count_nonzero(perimeter))
    if perimeter_total == 0:
        return None

    shares = [int(np.count_nonzero((m == 255) & perimeter)) for m in group_masks]
    best = int(np.argmax(shares))  # empate: primer (mayor área) grupo
    if shares[best] / perimeter_total < _BACKGROUND_PERIMETER_RATIO:
        return None

    candidate = group_masks[best] == 255
    region = _components_touching_border(candidate)
    if not region.any() or not np.any(relevant & ~region):
        return None  # lienzo plano: no hay primer plano que separar del fondo

    radius = max(2, int(round(_NECK_RADIUS_RATIO * min(height, width))))
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * radius + 1, 2 * radius + 1))
    opened = cv2.morphologyEx(region.astype(np.uint8), cv2.MORPH_OPEN, kernel).astype(bool)
    main = _components_touching_border(opened)
    if main.any():
        certain = cv2.dilate(main.astype(np.uint8), kernel).astype(bool) & region
    else:
        certain = region  # fondo más fino que el elemento estructurante: no se puede juzgar
    ambiguous = region & ~certain

    contact = _contact_pixels(bgr, relevant, certain, ambiguous, group_colors_bgr[best], tolerance, neutral_chroma)

    return BackgroundDetection(
        mask=np.where(certain, np.uint8(255), np.uint8(0)),
        ambiguous=np.where(ambiguous, np.uint8(255), np.uint8(0)),
        reference_group=best,
        contact_pixel_count=contact,
    )


def _contact_pixels(
    bgr: np.ndarray,
    relevant: np.ndarray,
    certain: np.ndarray,
    ambiguous: np.ndarray,
    reference_bgr: tuple[int, int, int],
    tolerance: float,
    neutral_chroma: float,
) -> int:
    """Píxeles de objetos claros neutros (cercanos al color de fondo) más
    gruesos que un anillo de antialiasing que tocan el fondo seguro."""
    ys, xs = np.nonzero(relevant & ~certain)
    if ys.size == 0:
        return 0
    lab = lab_features(bgr[ys, xs])
    reference_lab = lab_features(np.array([reference_bgr], dtype=np.uint8))[0]
    chroma, _ = _chroma_hue(lab)
    delta = np.linalg.norm(lab - reference_lab, axis=1)
    light = (chroma < neutral_chroma) & (delta <= _CONTACT_DELTA_E_FACTOR * max(tolerance, 1.0))
    light_mask = np.zeros(relevant.shape, dtype=np.uint8)
    light_mask[ys[light], xs[light]] = 1
    if not light_mask.any():
        return 0

    size = 2 * _CONTACT_OPENING_RADIUS + 1
    thick = cv2.morphologyEx(light_mask, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (size, size)))
    if not thick.any():
        return 0

    count, labels = cv2.connectedComponents(thick, connectivity=8)
    touching_zone = cv2.dilate(certain.astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool)
    touching = set(int(v) for v in np.unique(labels[touching_zone])) - {0}
    if not touching:
        return 0
    return int(np.count_nonzero(np.isin(labels, list(touching))))


# --- Píxeles de transición (antialiasing) ---

_TRANSITION_OPENING = 5  # un trazo de <= 4 px de grosor no tiene "núcleo"
_TRANSITION_RADIUS = 2  # vecindad (px) donde se buscan los núcleos que flanquean el trazo
_TRANSITION_LIGHTNESS_MARGIN = 2.0


def resolve_transition_pixels(
    labels: np.ndarray, bgr: np.ndarray, family_lightness: list[float]
) -> np.ndarray:
    """Reasigna los píxeles de TRANSICIÓN entre dos regiones: los anillos de
    antialiasing de 1-2 px que, al clasificarse por su propio color, caen en
    una familia equivocada (p. ej. el borde marrón entre una pupila negra y un
    ojo gris, que por su tinte cálido acabaría como un contorno naranja
    dentro del ojo).

    Un píxel es de transición si, a la vez, (1) pertenece a una estructura
    de <= 4 px de grosor de su etiqueta (no está en el núcleo de la apertura),
    (2) está flanqueado por los núcleos de al menos DOS etiquetas distintas a
    <= 2 px sin que el núcleo de SU propia etiqueta esté a <= 2 px (así las
    esquinas y bordes de una región gruesa no se erosionan), y (3) su luminosidad queda entre la de esos núcleos (un
    contorno oscuro genuino entre dos colores claros NO cumple (3) y se
    conserva). Se le asigna la etiqueta del núcleo más cercano. Un trazo fino
    entre una misma región (línea de arte sobre fondo liso) tampoco cumple
    (2) y nunca se toca. La partición sigue siendo exacta: solo cambia la
    etiqueta de píxeles ya asignados. `labels` usa -1 para "sin grupo".
    """
    label_count = len(family_lightness)
    cores: list[np.ndarray] = []
    thin = np.zeros(labels.shape, dtype=bool)
    opening = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (_TRANSITION_OPENING, _TRANSITION_OPENING))
    for label in range(label_count):
        mask = (labels == label).astype(np.uint8)
        core = cv2.morphologyEx(mask, cv2.MORPH_OPEN, opening)
        cores.append(core)
        thin |= (mask == 1) & (core == 0)
    ys, xs = np.nonzero(thin)
    if ys.size == 0:
        return labels

    size = 2 * _TRANSITION_RADIUS + 1
    near_kernel = np.ones((size, size), np.uint8)
    neighbours = np.zeros(ys.size, dtype=np.int32)
    own_core_near = np.zeros(ys.size, dtype=bool)
    own_label = labels[ys, xs]
    low = np.full(ys.size, np.inf)
    high = np.full(ys.size, -np.inf)
    for label in range(label_count):
        if not cores[label].any():
            continue
        near = cv2.dilate(cores[label], near_kernel)[ys, xs] == 1
        own_core_near |= near & (own_label == label)
        neighbours += near
        low = np.where(near, np.minimum(low, family_lightness[label]), low)
        high = np.where(near, np.maximum(high, family_lightness[label]), high)

    lightness = lab_features(bgr[ys, xs])[:, 0]
    candidate = (
        ~own_core_near  # un píxel pegado al núcleo de SU propia etiqueta es borde de esa región (p. ej. una esquina), no una transición
        & (neighbours >= 2)
        & (lightness >= low - _TRANSITION_LIGHTNESS_MARGIN)
        & (lightness <= high + _TRANSITION_LIGHTNESS_MARGIN)
    )
    if not candidate.any():
        return labels

    core_any = np.zeros(labels.shape, dtype=bool)
    core_label = np.full(labels.shape, -1, dtype=np.int32)
    for label in range(label_count):
        selected = cores[label] == 1
        core_any |= selected
        core_label[selected] = label
    source = np.where(core_any, 0, 1).astype(np.uint8)
    _distance, nearest = cv2.distanceTransformWithLabels(source, cv2.DIST_L2, 3, labelType=cv2.DIST_LABEL_PIXEL)
    zero_label = core_label[core_any]  # el n-ésimo píxel nulo (orden row-major) tiene la etiqueta n+1
    refined = labels.copy()
    refined[ys[candidate], xs[candidate]] = zero_label[nearest[ys[candidate], xs[candidate]] - 1]
    return refined
