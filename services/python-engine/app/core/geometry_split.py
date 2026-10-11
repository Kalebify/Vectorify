"""M3-S10: corte / división (cut / split) de geometría del servicio de geometría del servidor (ADR D4 de
docs/ADR_EDITOR_MVP3.md). Mismo formato de intercambio que las booleanas de S04/S08 y el offset de S09 (anillos de
polígonos y polilíneas en UNIDADES DE DOCUMENTO, nunca path data), mismo motor (Shapely/GEOS) y los mismos ayudantes
de `app.core.geometry_ops` (regla par-impar, `make_valid`, resolución de arcos acotada por la tolerancia, descarte de
piezas < tolerancia², orientación/orden canónicos). Sin estado y sin E/S.

Contrato:
- `cutter` es una polilínea de >= 2 puntos DISTINTOS (los consecutivos repetidos se unifican). Con `extend` su primer y
  último tramo se prolongan, en su propia dirección, lo suficiente para cruzar todos los subjects; sin `extend` el corte
  es exactamente la polilínea dibujada.
- `mode == "split"` (dividir): las piezas COMPARTEN el borde del corte. Un polígono se parte con el borde del subject
  nodado contra el corte y `polygonize` (robusto con huecos, islas y varios cruces; un tramo del corte que no cierra
  ninguna región -- un "colgante" -- no divide nada); una polilínea se parte en cada punto donde el corte la cruza o la toca.
- `mode == "slot"` (separar con hueco): se resta una ranura de ancho `slot_width` centrada en el corte (buffer plano,
  uniones redondas, de modo que el área quitada de un corte recto es exactamente `slot_width` x largo atravesado y
  los extremos no se pasan del corte dibujado). Las piezas quedan físicamente separadas.
- Un objeto SOLO cambia si el corte lo SEPARA: `changed` es verdadero únicamente si salen MÁS piezas (con área >=
  tolerancia²; largo > tolerancia en líneas) que las que el subject ya tenía. Un corte que termina dentro de la
  forma, que corre por un borde, o una ranura que solo le hace una muesca, no la parte, dejan el subject IDÉNTICO
  (`changed: false`, `pieces` = el subject tal cual, para que el cliente conserve su `d` con las curvas). Una
  polilínea CERRADA cortada una sola vez queda en una sola pieza abierta: tampoco se considera separada.
- Resultado por subject, SIEMPRE explícito sobre lo que pasó (nada falla en silencio): `touched` (el corte -- o su
  ranura -- toca al subject; permite distinguir "no lo toca" de "lo toca pero no lo atraviesa"), `changed`, `pieces`
  (polígonos válidos / polilíneas, orden determinista), `piece_count` y `discarded` (piezas despreciables, < tolerancia²
  de área o <= tolerancia de largo, que el servidor descartó de un resultado que SÍ cambió; 0 si no cambió).
- Salida determinista (mismas entradas -> mismas salidas, byte a byte), sin NaN, polígonos válidos (`is_valid`).
"""

import math

import numpy as np
import shapely
from shapely.geometry import LineString, Point
from shapely.geometry.base import BaseGeometry
from shapely.ops import polygonize, substring, unary_union
from shapely.prepared import prep

from app.core.errors import GeometryResultInvalidError, InvalidParametersError
from app.core.geometry_ops import _arc_resolution, _dedupe, _finalize, _polygonal_parts, _subject_geometry, _walk

SPLIT_MODES = ("split", "slot")


def cutter_line(points: list, subject_geometries: list[BaseGeometry], extend: bool) -> LineString:
    """Polilínea de corte (ya sin vértices consecutivos repetidos). Con `extend`, el primer y el último tramo se prolongan
    en su dirección una longitud mayor que la diagonal de todo lo involucrado, así que cruzan cualquier subject."""
    cleaned = _dedupe(points, closed=False)
    if len(cleaned) < 2:
        raise InvalidParametersError("El corte necesita al menos dos puntos distintos.")
    if extend:
        present = [geometry for geometry in subject_geometries if not geometry.is_empty]
        xs = [x for x, _ in cleaned]
        ys = [y for _, y in cleaned]
        if present:
            min_x, min_y, max_x, max_y = (float(value) for value in shapely.total_bounds(present))
            xs.extend((min_x, max_x))
            ys.extend((min_y, max_y))
        reach = math.hypot(max(xs) - min(xs), max(ys) - min(ys)) + 1.0
        first = _pushed(cleaned[1], cleaned[0], reach)
        last = _pushed(cleaned[-2], cleaned[-1], reach)
        cleaned = [first, *cleaned[1:-1], last]
    return LineString(cleaned)


def _pushed(origin: tuple[float, float], end: tuple[float, float], reach: float) -> tuple[float, float]:
    """`end` desplazado `reach` más allá, en la dirección origin -> end."""
    length = math.hypot(end[0] - origin[0], end[1] - origin[1])
    return (end[0] + (end[0] - origin[0]) / length * reach, end[1] + (end[1] - origin[1]) / length * reach)


def _slot_polygon(line: LineString, slot_width: float, tolerance: float) -> BaseGeometry:
    half = slot_width / 2.0
    return line.buffer(half, quad_segs=_arc_resolution(half, tolerance), cap_style="flat", join_style="round")


# ---- Polígonos ----


def _split_polygon_faces(geometry: BaseGeometry, line: LineString) -> list[BaseGeometry]:
    """Caras del subject tras nodar su borde contra el corte. Cada cara se queda solo si su punto representativo cae en el subject
    (las caras que cierran el corte fuera de la forma, o dentro de un hueco, no son suyas)."""
    noded = unary_union([geometry.boundary, line])
    inside = prep(geometry)
    return [face for face in polygonize(noded) if inside.intersects(face.representative_point())]


def _polygon_outcome(geometry: BaseGeometry, cut: LineString, mode: str, slot: BaseGeometry | None, tolerance: float) -> tuple[list[dict], int, bool]:
    """(piezas, descartadas, separó) de un subject poligonal ya no vacío y tocado por el corte."""
    min_area = tolerance * tolerance
    before = sum(1 for part in _polygonal_parts(geometry) if part.area >= min_area)
    if mode == "split":
        raw = _split_polygon_faces(geometry, cut)
    else:
        raw = _polygonal_parts(geometry.difference(slot))
    kept = _finalize(shapely.GeometryCollection(raw), tolerance, lines=False)
    return kept, len(raw) - len(kept), len(kept) > before


# ---- Polilíneas ----


def _point_cuts(hit: BaseGeometry) -> list[Point]:
    """Puntos de una intersección: los `Point` de un Point/MultiPoint/GeometryCollection. Un tramo superpuesto (colineal) no cruza: se ignora."""
    if hit is None or hit.is_empty:
        return []
    if isinstance(hit, Point):
        return [hit]
    return [point for part in getattr(hit, "geoms", ()) for point in _point_cuts(part)]


def _cut_positions(line: LineString, cut: LineString) -> list[float]:
    """Distancias a lo largo de `line` donde `cut` la cruza o la toca, ordenadas y sin repetir ni caer en los extremos."""
    coordinates = np.asarray(line.coords, dtype=float)
    segments = shapely.linestrings(np.stack([coordinates[:-1], coordinates[1:]], axis=1))
    # Cada segmento por separado: así un punto de corte se ubica en el tramo correcto aunque la polilínea se cruce a sí misma.
    hits = shapely.intersection(segments, cut)
    cumulative = np.concatenate(([0.0], np.cumsum(shapely.length(segments))))
    total = float(cumulative[-1])
    epsilon = 1e-12 * max(total, 1.0)
    found: list[float] = []
    for index, hit in enumerate(hits):
        for point in _point_cuts(hit):
            found.append(float(cumulative[index]) + float(shapely.line_locate_point(segments[index], point)))
    positions: list[float] = []
    for position in sorted(found):
        if position <= epsilon or position >= total - epsilon:
            continue  # cortar en un extremo no parte nada
        if positions and position - positions[-1] <= epsilon:
            continue
        positions.append(position)
    return positions


def _join_closed(pieces: list[LineString], start: tuple[float, float]) -> list[LineString]:
    """Una polilínea cerrada cuyo vértice de inicio no es un punto de corte deja un tramo que termina y otro que empieza en él: son uno solo."""
    ending = [piece for piece in pieces if tuple(piece.coords[-1]) == start]
    beginning = [piece for piece in pieces if tuple(piece.coords[0]) == start]
    if len(pieces) < 2 or len(ending) != 1 or len(beginning) != 1 or ending[0] is beginning[0]:
        return pieces
    joined = LineString([*ending[0].coords, *list(beginning[0].coords)[1:]])
    return [piece for piece in pieces if piece is not ending[0] and piece is not beginning[0]] + [joined]


def _line_pieces(parts: list[LineString], tolerance: float) -> tuple[list[dict], int]:
    """(piezas del contrato en orden determinista, descartadas): una polilínea de largo <= tolerancia es despreciable."""
    pieces: list[dict] = []
    for part in parts:
        if part.length <= tolerance:
            continue
        coordinates = [(float(x), float(y)) for x, y in part.coords]
        if not all(math.isfinite(value) for point in coordinates for value in point):
            raise GeometryResultInvalidError("El corte produjo coordenadas no finitas.")
        pieces.append({"type": "line", "coordinates": coordinates})
    pieces.sort(key=lambda piece: piece["coordinates"])
    return pieces, len(parts) - len(pieces)


def _line_outcome(geometry: LineString, cut: LineString, mode: str, slot: BaseGeometry | None, tolerance: float) -> tuple[list[dict], int, bool]:
    """(piezas, descartadas, separó) de un subject lineal ya no vacío y tocado por el corte."""
    closed = geometry.is_closed
    start = tuple(geometry.coords[0])
    if mode == "split":
        positions = _cut_positions(geometry, cut)
        edges = [0.0, *positions, geometry.length]
        parts = [substring(geometry, begin, end) for begin, end in zip(edges, edges[1:])]
    else:
        parts = []
        _walk(geometry.difference(slot), None, parts)
    if closed and len(parts) >= 2:
        parts = _join_closed(parts, start)
    pieces, discarded = _line_pieces(parts, tolerance)
    return pieces, discarded, len(pieces) > 1


def _unchanged(item: dict, geometry: BaseGeometry, is_line: bool, tolerance: float) -> dict:
    if is_line:
        pieces, _ = _line_pieces([geometry], tolerance)
    else:
        pieces = _finalize(geometry, tolerance, lines=False)
    return {**item, "changed": False, "pieces": pieces, "piece_count": len(pieces), "discarded": 0}


def run_split(
    subjects: list[dict],
    cutter_points: list,
    mode: str,
    slot_width: float,
    extend: bool,
    tolerance: float,
) -> dict:
    """Ejecuta el corte y devuelve `{"results": [...]}` con una entrada por subject, en orden (ver el docstring del módulo).
    `subjects` son los dicts del contrato (`type` + `coordinates`), ya validados por el esquema."""
    if mode not in SPLIT_MODES:
        raise InvalidParametersError(f"Modo de corte desconocido: {mode!r}. Valores válidos: {', '.join(SPLIT_MODES)}.")
    if not math.isfinite(tolerance) or tolerance <= 0:
        raise InvalidParametersError("La tolerancia debe ser un número finito mayor que 0.")
    if mode == "slot" and (not math.isfinite(slot_width) or slot_width <= 0):
        raise InvalidParametersError("El ancho de la ranura debe ser un número finito mayor que 0.")

    geometries = [_subject_geometry(subject) for subject in subjects]
    cut = cutter_line(cutter_points, geometries, extend)
    slot = _slot_polygon(cut, slot_width, tolerance) if mode == "slot" else None
    # En modo ranura "tocar" es que la ranura (no solo su eje) alcance al subject.
    reach = slot if slot is not None else cut

    results: list[dict] = []
    for index, (subject, geometry) in enumerate(zip(subjects, geometries)):
        is_line = subject["type"] == "line"
        item = {"subject_index": index, "touched": False}
        if geometry.is_empty:
            # Un subject degenerado (anillo sin área, línea de un punto) no tiene nada que partir.
            results.append({**item, "changed": False, "pieces": [], "piece_count": 0, "discarded": 0})
            continue
        if not geometry.intersects(reach):
            results.append(_unchanged(item, geometry, is_line, tolerance))
            continue
        item["touched"] = True

        if is_line:
            pieces, discarded, separated = _line_outcome(geometry, cut, mode, slot, tolerance)
        else:
            pieces, discarded, separated = _polygon_outcome(geometry, cut, mode, slot, tolerance)
        if not separated:
            results.append(_unchanged(item, geometry, is_line, tolerance))
            continue
        results.append({**item, "changed": True, "pieces": pieces, "piece_count": len(pieces), "discarded": discarded})
    return {"results": results}
