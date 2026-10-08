"""M3-S04: núcleo puro del servicio de geometría del servidor (ADR D4 de
docs/ADR_EDITOR_MVP3.md). Operaciones booleanas SIN estado sobre anillos de
polígonos y polilíneas en unidades de documento: el cliente (editor) aplana
sus curvas con una tolerancia explícita y manda coordenadas puras; este módulo
opera con Shapely/GEOS y devuelve coordenadas puras. Nunca ve path data, SVG ni
nada del usuario (las booleanas S08, offset S09, corte S10 y puentes S11
reusan este mismo formato de intercambio).

Formato de intercambio (ver también app.models.schemas):
- `polygon`: lista de anillos, el primero es el exterior. Los huecos se
  construyen con la regla PAR-IMPAR (un anillo dentro de un número impar de
  anillos es relleno, dentro de uno par es hueco), que coincide con
  `fill-rule: evenodd` y, para los paths de vtracer (huecos como subpaths
  disjuntos del exterior), con el relleno no-cero que usa el editor.
- `line`: polilínea de >= 2 vértices.
- `bufferedLine` (solo operandos): pincel de borrador -- línea con radio,
  `cap_style=round`, `join_style=round`, resolución de arcos acotada por la
  tolerancia (ver `_arc_resolution`).

Garantías del resultado (lo que el cliente da por cierto):
- Sin NaN/Infinity, sin polígonos de área < tolerancia², sin polilíneas de
  largo <= tolerancia; cada polígono es VÁLIDO (`is_valid`, tras `make_valid`
  si hizo falta).
- Orden DETERMINISTA: mismas entradas -> mismas salidas, byte a byte. Los
  anillos se orientan igual (exterior antihorario, huecos horarios en ejes
  matemáticos) y empiezan en su vértice mínimo (x, y); las piezas salen
  ordenadas por sus coordenadas (polígonos primero, después polilíneas).
- `difference`: cada `subject` menos la unión de los `operands`. Un subject
  disjunto de los operandos vuelve IDÉNTICO (`changed: false`); uno totalmente
  cubierto vuelve vacío; uno partido vuelve en varias piezas.

Nunca "arregla" en silencio nada que no deba: la geometría de ENTRADA
autointersectante se hace válida (`make_valid`) como parte del contrato (es la
operación `normalize`, y los trazos a mano alzada la necesitan), pero el
resultado siempre se revalida y, si aun así no es válido, se lanza
GeometryResultInvalidError en vez de devolverlo.
"""

import math

from shapely.geometry import GeometryCollection, LineString, Point, Polygon
from shapely.geometry.base import BaseGeometry, BaseMultipartGeometry
from shapely.geometry.polygon import orient
from shapely.ops import linemerge, unary_union
from shapely.validation import make_valid

from app.core.errors import GeometryResultInvalidError, InvalidParametersError

# Resolución de los arcos del pincel: segmentos por cuarto de círculo, acotada para que ni un radio
# enorme con tolerancia mínima genere cientos de miles de vértices ni uno diminuto degenere en un rombo.
MIN_QUAD_SEGS = 2
MAX_QUAD_SEGS = 64

_PER_SUBJECT_OPERATIONS = ("difference", "intersection", "normalize")


def _dedupe(points: list, closed: bool) -> list[tuple[float, float]]:
    """Quita vértices consecutivos repetidos; en un anillo, también el vértice de cierre repetido."""
    cleaned: list[tuple[float, float]] = []
    for x, y in points:
        point = (float(x), float(y))
        if not cleaned or cleaned[-1] != point:
            cleaned.append(point)
    if closed and len(cleaned) > 1 and cleaned[0] == cleaned[-1]:
        cleaned.pop()
    return cleaned


def _polygonal_parts(geometry: BaseGeometry) -> list[Polygon]:
    parts: list[Polygon] = []
    _walk(geometry, parts, None)
    return parts


def _walk(geometry: BaseGeometry | None, polygons: list[Polygon] | None, lines: list[LineString] | None) -> None:
    """Aplana colecciones/multipartes: reparte los polígonos y las polilíneas; los puntos se descartan."""
    if geometry is None or geometry.is_empty:
        return
    if isinstance(geometry, Polygon):
        if polygons is not None:
            polygons.append(geometry)
    elif isinstance(geometry, LineString):
        if lines is not None:
            lines.append(geometry)
    elif isinstance(geometry, BaseMultipartGeometry):
        for part in geometry.geoms:
            _walk(part, polygons, lines)


def _polygon_from_rings(rings: list) -> BaseGeometry:
    """Anillos -> región con la regla par-impar (diferencia simétrica acumulada). Cada anillo
    autointersecado se hace válido ANTES de combinarlo (un "moño" son dos triángulos). Un anillo
    degenerado (< 3 vértices distintos, área cero) simplemente no aporta nada."""
    region: BaseGeometry = Polygon()
    for ring in rings:
        points = _dedupe(ring, closed=True)
        if len(points) < 3:
            continue
        polygon: BaseGeometry = Polygon(points)
        if not polygon.is_valid:
            polygon = make_valid(polygon)
        parts = _polygonal_parts(polygon)
        if not parts:
            continue
        region = region.symmetric_difference(unary_union(parts))
    return region


def _line_from_points(points: list) -> BaseGeometry:
    cleaned = _dedupe(points, closed=False)
    if len(cleaned) < 2:
        return LineString()
    return LineString(cleaned)


def _arc_resolution(radius: float, tolerance: float) -> int:
    """Segmentos por cuarto de arco para que la flecha del arco (sagitta) no supere `tolerance`."""
    if tolerance >= radius:
        return MIN_QUAD_SEGS
    step = 2.0 * math.acos(1.0 - tolerance / radius)
    return max(MIN_QUAD_SEGS, min(MAX_QUAD_SEGS, math.ceil((math.pi / 2.0) / step)))


def _buffered_line(points: list, radius: float, tolerance: float) -> BaseGeometry:
    cleaned = _dedupe(points, closed=False)
    segments = _arc_resolution(radius, tolerance)
    if len(cleaned) == 1:
        return Point(cleaned[0]).buffer(radius, quad_segs=segments)
    return LineString(cleaned).buffer(radius, quad_segs=segments, cap_style="round", join_style="round")


def _subject_geometry(subject: dict) -> BaseGeometry:
    if subject["type"] == "polygon":
        return _polygon_from_rings(subject["coordinates"])
    return _line_from_points(subject["coordinates"])


def _operand_geometry(operand: dict, tolerance: float) -> BaseGeometry:
    if operand["type"] == "bufferedLine":
        return _buffered_line(operand["points"], operand["radius"], tolerance)
    return _subject_geometry(operand)


def _union(geometries: list[BaseGeometry]) -> BaseGeometry:
    present = [geometry for geometry in geometries if not geometry.is_empty]
    if not present:
        return GeometryCollection()
    return unary_union(present)


def _canonical_ring(coordinates) -> list[tuple[float, float]]:
    """Anillo cerrado que empieza en su vértice mínimo (x, y): la salida de GEOS puede rotar el inicio."""
    ring = [(float(x), float(y)) for x, y in list(coordinates)[:-1]]
    start = min(range(len(ring)), key=lambda index: ring[index])
    rotated = ring[start:] + ring[:start]
    rotated.append(rotated[0])
    return rotated


def _all_finite(coordinates) -> bool:
    return all(math.isfinite(value) for point in coordinates for value in point)


def _finalize(geometry: BaseGeometry, tolerance: float, *, polygons: bool = True, lines: bool = True) -> list[dict]:
    """Geometría de Shapely -> piezas del contrato, validadas y en orden determinista."""
    found_polygons: list[Polygon] = []
    found_lines: list[LineString] = []
    _walk(geometry, found_polygons, found_lines)

    min_area = tolerance * tolerance
    polygon_pieces: list[dict] = []
    if polygons:
        valid: list[Polygon] = []
        for polygon in found_polygons:
            if polygon.is_valid:
                valid.append(polygon)
            else:
                # Defensa en profundidad: GEOS no debería devolver un polígono inválido de una booleana.
                valid.extend(_polygonal_parts(make_valid(polygon)))
        for polygon in valid:
            if not polygon.is_valid:
                raise GeometryResultInvalidError("La operación booleana produjo un polígono inválido.")
            if polygon.area < min_area:
                continue
            oriented = orient(polygon, 1.0)
            exterior = _canonical_ring(oriented.exterior.coords)
            holes = sorted(_canonical_ring(hole.coords) for hole in oriented.interiors)
            rings = [exterior, *holes]
            if not all(_all_finite(ring) for ring in rings):
                raise GeometryResultInvalidError("La operación booleana produjo coordenadas no finitas.")
            polygon_pieces.append({"type": "polygon", "coordinates": rings})
        polygon_pieces.sort(key=lambda piece: piece["coordinates"])

    line_pieces: list[dict] = []
    if lines:
        merged: list[LineString] = found_lines
        if len(found_lines) > 1:
            # Una polilínea cerrada partida una sola vez deja dos tramos unidos en su vértice de origen: se vuelven a unir.
            merged = []
            _walk(linemerge(found_lines), None, merged)
        for line in merged:
            if line.length <= tolerance:
                continue
            coordinates = [(float(x), float(y)) for x, y in line.coords]
            if not _all_finite(coordinates):
                raise GeometryResultInvalidError("La operación booleana produjo coordenadas no finitas.")
            line_pieces.append({"type": "line", "coordinates": coordinates})
        line_pieces.sort(key=lambda piece: piece["coordinates"])

    return [*polygon_pieces, *line_pieces]


def _same_geometry(left: BaseGeometry, right: BaseGeometry) -> bool:
    try:
        return bool(left.equals(right))
    except Exception:  # equals no soporta GeometryCollection mixtas: ante la duda, "cambió".
        return False


def run_boolean(operation: str, subjects: list[dict], operands: list[dict], tolerance: float) -> dict:
    """Ejecuta `operation` y devuelve `{"scope", "results"}` con `results` = lista de
    `{"subject_index", "changed", "geometries"}` (una entrada por subject en difference/intersection/
    normalize; una sola entrada con `subject_index: None` en union/xor). `subjects`/`operands` son los
    dicts del contrato (`type` + `coordinates`/`points`+`radius`), ya validados por el esquema."""
    if tolerance <= 0 or not math.isfinite(tolerance):
        raise InvalidParametersError("La tolerancia debe ser un número finito mayor que 0.")

    subject_geometries = [_subject_geometry(subject) for subject in subjects]
    operand_geometries = [_operand_geometry(operand, tolerance) for operand in operands]

    if operation in _PER_SUBJECT_OPERATIONS:
        cutter = _union(operand_geometries)
        if operation == "intersection" and not operands:
            raise InvalidParametersError("La intersección necesita al menos un operando.")
        results = []
        for index, (subject, geometry) in enumerate(zip(subjects, subject_geometries)):
            is_line = subject["type"] == "line"
            keep = {"polygons": not is_line, "lines": is_line}
            if geometry.is_empty:
                # Un subject degenerado (anillo sin área, línea de un punto) no tiene nada que conservar.
                results.append({"subject_index": index, "changed": False, "geometries": []})
                continue
            if operation == "normalize":
                outcome, changed = geometry, True
            elif cutter.is_empty or (operation == "difference" and not geometry.intersects(cutter)):
                # Disjunto (o sin operandos): vuelve IDÉNTICO, sin pasar por GEOS (que podría agregar vértices).
                outcome, changed = (geometry, False) if operation == "difference" else (GeometryCollection(), True)
            elif operation == "difference":
                outcome = geometry.difference(cutter)
                changed = not _same_geometry(outcome, geometry)
            else:
                outcome = geometry.intersection(cutter)
                changed = not _same_geometry(outcome, geometry)
            results.append({"subject_index": index, "changed": changed, "geometries": _finalize(outcome, tolerance, **keep)})
        return {"scope": "per_subject", "results": results}

    everything = [*subject_geometries, *operand_geometries]
    if operation == "union":
        combined = _union(everything)
    else:  # xor: se pliega en orden (definido) sobre subjects y luego operands
        combined = GeometryCollection()
        for geometry in everything:
            if geometry.is_empty:
                continue
            combined = geometry if combined.is_empty else combined.symmetric_difference(geometry)
    return {"scope": "combined", "results": [{"subject_index": None, "changed": True, "geometries": _finalize(combined, tolerance)}]}
