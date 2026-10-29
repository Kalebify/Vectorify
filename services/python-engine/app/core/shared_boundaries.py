"""Trazado de un conjunto de máscaras DISJUNTAS (la partición por familias de color) con fronteras
compartidas.

El trazado independiente (`VectorEngine.trace` una vez por máscara) aproxima cada contorno por su
cuenta: dos familias vecinas acaban con bordes distintos, que se cruzan (solape) o dejan rendijas
(huecos). Al combinar las capas, esas rendijas cerradas son «piezas flotantes» diminutas y los
solapes contaminan a la vecina. Aquí la frontera entre dos familias se calcula UNA vez y la usan las
dos, así que no hay solape ni hueco por construcción:

1. Cada máscara se convierte en un polígono EXACTO sobre las esquinas de los píxeles (sin
   aproximar nada): las fronteras entre vecinas ya coinciden vértice a vértice.
2. Se insertan vértices en cada esquina entera de los bordes rectos (`segmentize`) para que cada
   frontera compartida aparezca con los mismos vértices en ambos lados.
3. `coverage_simplify` (GEOS) simplifica el conjunto como una cobertura: cada arista compartida se
   simplifica una sola vez y ambas familias reciben el mismo resultado. Solo elimina vértices, no
   los mueve: las coordenadas siguen siendo enteras.

Funciones puras y deterministas (mismas máscaras y tolerancia -> mismo SVG).
"""

import numpy as np
import shapely
from shapely.geometry import MultiPolygon, Polygon
from shapely.geometry.base import BaseGeometry
from shapely.geometry.polygon import orient

# Tolerancia de simplificación por defecto, en píxeles. Con 0 se conserva el contorno exacto del
# píxel (escalonado en diagonales y curvas, muchos nodos). Medido sobre el pato real (1152x2048, 5 familias +
# fondo): 0,75 px -> 10.338 nodos; 1,0 px -> 7.636 nodos con <= 0,32 % de desajuste y <= 0,17 % de
# contaminación por capa; 2,0 px -> 3.888 nodos pero ya hasta 1,2 % de desajuste. 1 px es el presupuesto de
# desplazamiento de contorno de CA-08 y deja cada pieza muy por debajo del umbral de complejidad del editor.
DEFAULT_SIMPLIFY_TOLERANCE_PX = 1.0


def exact_polygon(mask: np.ndarray) -> BaseGeometry:
    """Polígono (con huecos) de los píxeles 255 de `mask`, sobre las esquinas de los píxeles.

    Se construye a partir de tramos horizontales fusionados verticalmente; el resultado cubre
    exactamente los mismos píxeles que la máscara.
    """
    height, width = mask.shape[:2]
    padded = np.zeros((height, width + 2), dtype=np.int8)
    padded[:, 1:-1] = mask == 255
    edges = np.diff(padded, axis=1)
    ys, starts = np.nonzero(edges == 1)
    _, ends = np.nonzero(edges == -1)
    if ys.size == 0:
        return Polygon()
    order = np.lexsort((ys, ends, starts))
    ys, starts, ends = ys[order], starts[order], ends[order]
    new_block = np.ones(ys.size, dtype=bool)
    new_block[1:] = (starts[1:] != starts[:-1]) | (ends[1:] != ends[:-1]) | (ys[1:] != ys[:-1] + 1)
    first = np.nonzero(new_block)[0]
    last = np.append(first[1:], ys.size) - 1
    boxes = shapely.box(starts[first], ys[first], ends[first], ys[last] + 1)
    return shapely.union_all(boxes)


def trace_polygons(masks: list[np.ndarray], tolerance: float = DEFAULT_SIMPLIFY_TOLERANCE_PX) -> list[BaseGeometry]:
    """Polígonos de las máscaras (mismo orden) con las fronteras compartidas simplificadas a la vez.

    Las máscaras deben ser disjuntas (si dos se solapan, el solape no se simplifica de forma
    coherente: el llamador lo comprueba con `are_disjoint`).
    """
    exact = [exact_polygon(mask) for mask in masks]
    if tolerance <= 0:
        return exact
    dense = [shapely.segmentize(polygon, 1.0) if not polygon.is_empty else polygon for polygon in exact]
    coverage = np.array(dense, dtype=object)
    simplified = shapely.coverage_simplify(coverage, tolerance)
    if not shapely.coverage_is_valid(simplified).all():
        return exact  # nunca debería ocurrir; si ocurre, un contorno exacto es mejor que uno con cruces
    return list(simplified)


def are_disjoint(masks: list[np.ndarray]) -> bool:
    """True si ningún píxel pertenece a más de una máscara."""
    if not masks:
        return True
    total = np.zeros(masks[0].shape[:2], dtype=np.uint8)
    for mask in masks:
        total += (mask == 255).astype(np.uint8)
    return int(total.max()) <= 1


def _ring_d(coords) -> str:
    points = list(coords)[:-1]
    first = points[0]
    body = " ".join(f"L{_num(x)},{_num(y)}" for x, y in points[1:])
    return f"M{_num(first[0])},{_num(first[1])} {body} Z".replace("  ", " ")


def _num(value: float) -> str:
    rounded = round(float(value), 3)
    return str(int(rounded)) if rounded == int(rounded) else f"{rounded:g}"


def polygon_to_path_d(polygon: Polygon) -> str:
    """`d` de un trazado M/L/Z de UN polígono: anillo exterior en un sentido y huecos en el contrario."""
    polygon = orient(polygon, sign=1.0)
    chunks = [_ring_d(polygon.exterior.coords)]
    chunks.extend(_ring_d(ring.coords) for ring in polygon.interiors)
    return " ".join(chunks) + " "


def polygon_to_svg(geometry: BaseGeometry, width: int, height: int) -> str:
    """SVG con el mismo formato que el motor de trazado: un `<path>` por pieza conectada (con sus huecos), relleno
    negro y sin transform. Las piezas salen ordenadas por coordenadas (determinista)."""
    parts = list(geometry.geoms) if isinstance(geometry, MultiPolygon) else [geometry]
    parts = [part for part in parts if isinstance(part, Polygon) and not part.is_empty and part.area > 0]
    parts.sort(key=lambda part: (part.bounds[1], part.bounds[0], part.bounds[3], part.bounds[2]))
    paths = "\n".join(f'<path d="{polygon_to_path_d(part)}" fill="#000000"/>' for part in parts)
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}">\n'
        f"{paths}\n</svg>\n"
    )
