"""M3-S11: piezas flotantes y bridges del servicio de geometría del servidor (ADR D4 de docs/ADR_EDITOR_MVP3.md). Mismo formato de
intercambio que las booleanas de S04/S08, el offset de S09 y el corte de S10 (anillos de polígonos en UNIDADES DE DOCUMENTO, nunca path
data), mismo motor (Shapely/GEOS) y los mismos ayudantes de `app.core.geometry_ops` (regla par-impar, `make_valid`, descarte de piezas
< tolerancia², orientación/orden canónicos). Sin estado y sin E/S. Referencia de CONCEPTOS (no se modifica): `component_analysis`
(componentes, contención/profundidad) y `physical_union._build_bridge` (puente rectangular con solape) del flujo clásico de MVP 1.

Qué es "flotante" (dos modos explícitos; el editor los muestra siempre):
- `stencil` (Plantilla): las formas son CORTES (vacío); el material es la hoja menos esas formas. Una isla es una región de material
  rodeada por completo por cortes: cada HUECO (anillo interior) de la unión de las formas, a cualquier profundidad (un corte dentro de una
  isla no la conecta: la isla sigue flotando y sus propios huecos son islas más profundas). Al cortar, la isla se cae.
- `parts` (Piezas): las formas son MATERIAL; flotante = componente de la unión que está DENTRO DE UN HUECO de otro (contención), es decir,
  desconectado del cuerpo principal (el punto dentro de una "O"). Dos componentes disjuntos sin contención NO son flotantes.
Ambos modos usan la unión de TODAS las formas (los bloqueados cuentan para el análisis) y la regla par-impar por forma: el sentido de giro
de los anillos no cambia nada.

Análisis (`run_floating`): lista de componentes `{id, kind: principal|floating, depth, parent, polygon, area, bounds, subjects}`. En
`stencil` el único principal es la hoja (id 0, sin polígono: es lo que rodea a todo). `depth` = ancestros en el árbol de contención (la
hoja o el cuerpo principal 0). `subjects` = formas que forman el componente (parts: las que lo solapan; stencil: las que bordean la isla).
Los ids son posiciones en un orden DETERMINISTA (profundidad, coordenadas canónicas): mismas entradas -> mismas salidas, byte a byte.
Componentes con área < tolerancia² se descartan y se cuentan (`discarded`); nunca se omiten en silencio.

Bridges (`run_bridges`): un bridge es una conexión FÍSICA real, un rectángulo de ancho `width` que cruza el hueco entre una pieza flotante y
el material vecino. En `stencil` se RESTA de las formas de corte (abre un puente de material); en `parts` se SUMA (unión) a la forma dueña
del componente. El rectángulo arranca `2·tolerancia` dentro del componente de origen y termina `2·tolerancia` dentro del vecino (solape real,
no una tangencia), así el área quitada/agregada es EXACTAMENTE `width × largo del hueco` (`length`). Cada bridge se resuelve a un ancla
sobre el borde de una pieza flotante + una dirección (perpendicular al borde, hacia afuera, si no se da; la sugerencia automática usa el
segmento más corto hacia el borde del padre) y se valida por separado: no es válido si el ancla cae fuera, el ancho es menor que la
tolerancia, no cruza ningún hueco, queda corto (`length` explícito), necesita modificar una forma bloqueada, o no reduce el número de
flotantes. Con `suggest` se completan, con una sugerencia, las islas flotantes que ningún bridge válido cubre. Los válidos se aplican JUNTOS
y el servidor REANALIZA el resultado (`floating_before`, `floating_after`, `main_after`) sobre la geometría resultante ya finalizada, la
misma que recibe el cliente. Las formas que no cambian vuelven con `changed: false` y sin geometría (el cliente conserva su objeto).
"""

import math
from dataclasses import dataclass

import numpy as np
import shapely
from shapely.geometry import LinearRing, LineString, Point, Polygon
from shapely.geometry.base import BaseGeometry
from shapely.geometry.polygon import orient
from shapely.ops import nearest_points, unary_union
from shapely.strtree import STRtree

from app.core.errors import GeometryResultInvalidError, InvalidParametersError
from app.core.geometry_ops import _finalize, _polygonal_parts, _subject_geometry, _union, _walk

FLOATING_MODES = ("stencil", "parts")

# Motivos (estables, el editor los traduce) por los que un bridge NO es válido.
REASON_UNKNOWN_ISLAND = "unknown_island"
REASON_ANCHOR_OUTSIDE = "anchor_outside"
REASON_WIDTH_BELOW_TOLERANCE = "width_below_tolerance"
REASON_INVALID_DIRECTION = "invalid_direction"
REASON_NO_CROSSING = "no_crossing"
REASON_TOO_SHORT = "too_short"
REASON_LOCKED_SUBJECT = "locked_subject"
REASON_NO_CONNECTION = "no_connection"
BRIDGE_REASONS = (
    REASON_UNKNOWN_ISLAND,
    REASON_ANCHOR_OUTSIDE,
    REASON_WIDTH_BELOW_TOLERANCE,
    REASON_INVALID_DIRECTION,
    REASON_NO_CROSSING,
    REASON_TOO_SHORT,
    REASON_LOCKED_SUBJECT,
    REASON_NO_CONNECTION,
)

# El rectángulo de un bridge se mete `OVERLAP_FACTOR · tolerancia` dentro de cada lado; un ancla puede estar a lo sumo a `tolerancia` del borde.
OVERLAP_FACTOR = 2.0
# Superficie mínima (relativa a tolerancia²) para decir que un bridge solapa de verdad con una forma.
OVERLAP_AREA_FACTOR = 1e-3


# ---- Árbol de componentes ----


@dataclass
class _Node:
    kind: str  # "principal" | "floating"
    polygon: BaseGeometry | None  # None solo en la hoja de `stencil`
    parent: int | None  # índice en la lista de nodos
    target_ring: list | None  # anillo hacia el que apunta una sugerencia: el borde del lado del padre
    depth: int = 0


def _depths(parents: list[int | None]) -> list[int]:
    depths: list[int] = []
    for index in range(len(parents)):
        depth, current = 0, parents[index]
        while current is not None:
            depth += 1
            current = parents[current]
        depths.append(depth)
    return depths


def _holes(parts: list[Polygon]) -> tuple[list[tuple[int, list]], list[Polygon]]:
    """Todos los huecos de los polígonos como (dueño, coordenadas del anillo) y como polígonos rellenos."""
    holes = [(owner, list(ring.coords)) for owner, part in enumerate(parts) for ring in part.interiors]
    return holes, [Polygon(coords) for _, coords in holes]


def _smallest_container(parts: list[Polygon], hole_polygons: list[Polygon], tree: STRtree | None) -> list[int | None]:
    """Por cada polígono, el índice del hueco más chico (de otro polígono) que lo contiene por completo, o None."""
    containers: list[int | None] = []
    for part in parts:
        best: int | None = None
        if tree is not None:
            for candidate in tree.query(part, predicate="within"):
                if best is None or hole_polygons[int(candidate)].area < hole_polygons[best].area:
                    best = int(candidate)
        containers.append(best)
    return containers


def _build_tree(union: BaseGeometry, mode: str, tolerance: float) -> tuple[list[_Node], int]:
    """Árbol de contención de la unión: (nodos, descartados). Los nodos salen sin ordenar (ver `_ordered_tree`)."""
    min_area = tolerance * tolerance
    all_parts = _polygonal_parts(union)
    parts = [part for part in all_parts if part.area >= min_area]
    holes, hole_polygons = _holes(parts)
    tree = STRtree(hole_polygons) if hole_polygons else None
    containers = _smallest_container(parts, hole_polygons, tree)

    if mode == "parts":
        parents = [None if hole is None else holes[hole][0] for hole in containers]
        depths = _depths(parents)
        nodes = [
            _Node("floating" if parents[index] is not None else "principal", part, parents[index],
                  None if containers[index] is None else holes[containers[index]][1], depths[index])
            for index, part in enumerate(parts)
        ]
        return nodes, len(all_parts) - len(parts)

    # stencil: la hoja (sin polígono) y una isla por hueco.
    nodes = []
    if not union.is_empty:
        nodes.append(_Node("principal", None, None, None, 0))
    discarded = 0
    node_of_hole: dict[int, int] = {}
    for hole_index, (owner, coords) in enumerate(holes):
        inside = [index for index, container in enumerate(containers) if container == hole_index]
        island: BaseGeometry = hole_polygons[hole_index]
        if inside:
            island = island.difference(unary_union([Polygon(parts[index].exterior) for index in inside]))
        pieces = _polygonal_parts(island)
        if not pieces:
            discarded += 1
            continue
        island = max(pieces, key=lambda piece: piece.area)
        if island.area < min_area:
            discarded += 1
            continue
        node_of_hole[hole_index] = len(nodes)
        nodes.append(_Node("floating", island, None, list(parts[owner].exterior.coords), 0))

    # Padre de una isla: la isla que contiene al polígono de corte dueño de su hueco (o la hoja).
    sheet = 0 if nodes and nodes[0].polygon is None else None
    for hole_index, node_index in node_of_hole.items():
        owner = holes[hole_index][0]
        ancestor = containers[owner]
        while ancestor is not None and ancestor not in node_of_hole:
            ancestor = containers[holes[ancestor][0]]
        nodes[node_index].parent = node_of_hole[ancestor] if ancestor is not None else sheet
    depths = _depths([node.parent for node in nodes])
    for node, depth in zip(nodes, depths):
        node.depth = depth
    return nodes, discarded


def _piece_of(polygon: BaseGeometry, tolerance: float) -> dict:
    pieces = _finalize(polygon, tolerance, lines=False)
    if len(pieces) != 1:
        raise GeometryResultInvalidError("El análisis de piezas flotantes produjo un componente inválido.")
    return pieces[0]


def _ordered_tree(union: BaseGeometry, mode: str, tolerance: float) -> tuple[list[_Node], list[dict | None], int]:
    """(nodos, piezas canónicas, descartados) con los ids = posiciones, en orden determinista (profundidad, coordenadas)."""
    nodes, discarded = _build_tree(union, mode, tolerance)
    pieces: list[dict | None] = [None if node.polygon is None else _piece_of(node.polygon, tolerance) for node in nodes]
    order = sorted(range(len(nodes)), key=lambda index: (nodes[index].depth, [] if pieces[index] is None else pieces[index]["coordinates"]))
    new_id = {old: new for new, old in enumerate(order)}
    ordered: list[_Node] = []
    for old in order:
        node = nodes[old]
        ordered.append(_Node(node.kind, node.polygon, None if node.parent is None else new_id[node.parent], node.target_ring, node.depth))
    return ordered, [pieces[old] for old in order], discarded


def _count(union: BaseGeometry, mode: str, tolerance: float) -> tuple[int, int]:
    """(flotantes, principales) de una unión; sin ordenar ni canonizar (lo usan las comprobaciones internas de los bridges)."""
    nodes, _ = _build_tree(union, mode, tolerance)
    floating = sum(1 for node in nodes if node.kind == "floating")
    return floating, len(nodes) - floating


# ---- Análisis ----


def _subject_ids(nodes: list[_Node], geometries: list[BaseGeometry], mode: str, tolerance: float) -> list[list[int]]:
    """Por nodo, los subjects que lo forman: en `parts` los que solapan el componente; en `stencil` los que bordean la isla."""
    found: list[list[int]] = [[] for _ in nodes]
    with_polygon = [index for index, node in enumerate(nodes) if node.polygon is not None]
    present = [index for index, geometry in enumerate(geometries) if not geometry.is_empty]
    if not with_polygon or not present:
        return found
    tree = STRtree([nodes[index].polygon for index in with_polygon])
    subjects = [geometries[index] for index in present]
    if mode == "stencil":
        subject_rows, node_rows = tree.query(subjects, predicate="dwithin", distance=tolerance * 0.5)
        for subject_row, node_row in zip(subject_rows, node_rows):
            found[with_polygon[int(node_row)]].append(present[int(subject_row)])
    else:
        subject_rows, node_rows = tree.query(subjects, predicate="intersects")
        for subject_row, node_row in zip(subject_rows, node_rows):
            subject, node = present[int(subject_row)], with_polygon[int(node_row)]
            if geometries[subject].intersection(nodes[node].polygon).area > tolerance * tolerance * OVERLAP_AREA_FACTOR:
                found[node].append(subject)
    return [sorted(set(ids)) for ids in found]


def _check_inputs(mode: str, tolerance: float) -> None:
    if mode not in FLOATING_MODES:
        raise InvalidParametersError(f"Modo de análisis desconocido: {mode!r}. Valores válidos: {', '.join(FLOATING_MODES)}.")
    if not math.isfinite(tolerance) or tolerance <= 0:
        raise InvalidParametersError("La tolerancia debe ser un número finito mayor que 0.")


def run_floating(subjects: list[dict], mode: str, tolerance: float) -> dict:
    """Analiza las piezas flotantes de `subjects` (los dicts del contrato, polígonos ya validados por el esquema; `locked` se ignora acá: los
    bloqueados cuentan para el análisis) y devuelve `{"components", "floating_count", "main_count", "discarded"}`."""
    _check_inputs(mode, tolerance)
    geometries = [_subject_geometry(subject) for subject in subjects]
    union = _union(geometries)
    nodes, pieces, discarded = _ordered_tree(union, mode, tolerance)
    attribution = _subject_ids(nodes, geometries, mode, tolerance)

    components = []
    for index, (node, piece) in enumerate(zip(nodes, pieces)):
        polygon = node.polygon
        bounds = union.bounds if polygon is None else polygon.bounds
        components.append(
            {
                "id": index,
                "kind": node.kind,
                "depth": node.depth,
                "parent": node.parent,
                "polygon": piece,
                "area": None if polygon is None else float(polygon.area),
                "bounds": [float(value) for value in bounds],
                "subjects": attribution[index],
            }
        )
    floating = sum(1 for node in nodes if node.kind == "floating")
    return {"components": components, "floating_count": floating, "main_count": len(nodes) - floating, "discarded": discarded}


# ---- Bridges ----


def _unit(vector: tuple[float, float]) -> tuple[float, float] | None:
    length = math.hypot(vector[0], vector[1])
    if not math.isfinite(length) or length <= 1e-12:
        return None
    # `+ 0.0` normaliza un -0.0 (queda feo en el JSON y no significa nada).
    return (vector[0] / length + 0.0, vector[1] / length + 0.0)


def _outward_normal(polygon: Polygon, point: tuple[float, float], tolerance: float) -> tuple[float, float] | None:
    """Normal hacia afuera (del material del polígono) en `point`, sobre su borde. En un vértice promedia las de los dos tramos que lo comparten."""
    oriented = orient(polygon, 1.0)  # exterior antihorario, huecos horarios: el material queda a la izquierda de cada tramo
    target = np.asarray(point, dtype=float)
    eps = max(tolerance * 1e-3, 1e-9)
    candidates: list[tuple[float, np.ndarray]] = []
    for ring in [oriented.exterior, *oriented.interiors]:
        coords = np.asarray(ring.coords, dtype=float)
        start, segment = coords[:-1], coords[1:] - coords[:-1]
        length2 = (segment**2).sum(axis=1)
        safe = np.where(length2 > 0, length2, 1.0)
        along = np.clip(((target - start) * segment).sum(axis=1) / safe, 0.0, 1.0)
        distance = np.linalg.norm(start + segment * along[:, None] - target, axis=1)
        normals = np.stack([segment[:, 1], -segment[:, 0]], axis=1) / np.sqrt(safe)[:, None]
        for index in np.nonzero((length2 > 0) & (distance <= distance.min() + eps))[0]:
            candidates.append((float(distance[index]), normals[index]))
    if not candidates:
        return None
    closest = min(distance for distance, _ in candidates)
    total = sum((normal for distance, normal in candidates if distance <= closest + eps), np.zeros(2))
    return _unit((float(total[0]), float(total[1])))


def _cast(origin: tuple[float, float], direction: tuple[float, float], union: BaseGeometry, mode: str, tolerance: float) -> tuple[float, float] | None:
    """Rayo desde `origin` hacia `direction`: (inicio, fin) del primer tramo del HUECO (stencil: dentro del corte; parts: fuera de las piezas) que
    arranca en `origin`, medidos desde `origin`. None si el rayo no empieza en un hueco o nunca vuelve a encontrar material."""
    min_x, min_y, max_x, max_y = union.bounds
    reach = math.hypot(max_x - min_x, max_y - min_y) + math.hypot(origin[0] - min_x, origin[1] - min_y) + 1.0
    ray = LineString([origin, (origin[0] + direction[0] * reach, origin[1] + direction[1] * reach)])
    hit = ray.intersection(union) if mode == "stencil" else ray.difference(union)
    lines: list[LineString] = []
    _walk(hit, None, lines)
    best: tuple[float, float] | None = None
    for line in lines:
        ends = sorted((float(ray.project(Point(line.coords[0]))), float(ray.project(Point(line.coords[-1])))))
        if ends[0] <= tolerance and (best is None or ends[0] < best[0]):
            best = (ends[0], ends[1])
    if best is None or best[1] >= reach - 1e-9 * reach or best[1] - best[0] <= 0:
        return None
    return best


def _rectangle(origin: tuple[float, float], direction: tuple[float, float], back: float, forward: float, width: float) -> Polygon:
    nx, ny = -direction[1], direction[0]
    half = width / 2.0
    start = (origin[0] - direction[0] * back, origin[1] - direction[1] * back)
    end = (origin[0] + direction[0] * forward, origin[1] + direction[1] * forward)
    return Polygon(
        [
            (start[0] + nx * half, start[1] + ny * half),
            (end[0] + nx * half, end[1] + ny * half),
            (end[0] - nx * half, end[1] - ny * half),
            (start[0] - nx * half, start[1] - ny * half),
        ]
    )


@dataclass
class _Context:
    union: BaseGeometry
    nodes: list[_Node]
    geometries: list[BaseGeometry]
    locked: list[bool]
    mode: str
    tolerance: float
    floating_before: int
    subject_tree: STRtree | None


def _apply_to_union(union: BaseGeometry, mode: str, rectangles: list[Polygon]) -> BaseGeometry:
    if not rectangles:
        return union
    combined = unary_union(rectangles)
    return union.difference(combined) if mode == "stencil" else union.union(combined)


def _find_anchor(context: _Context, anchor: tuple[float, float], island: int | None) -> tuple[int, tuple[float, float]] | None:
    """(id de la pieza flotante, punto del borde) más cercano al ancla, a lo sumo a `tolerancia`; con `island` solo se mira esa pieza."""
    point = Point(anchor)
    best: tuple[float, int, tuple[float, float]] | None = None
    for index, node in enumerate(context.nodes):
        if node.kind != "floating" or node.polygon is None or (island is not None and index != island):
            continue
        boundary = node.polygon.boundary
        distance = float(boundary.distance(point))
        if distance <= context.tolerance and (best is None or distance < best[0]):
            snapped = nearest_points(boundary, point)[0]
            best = (distance, index, (float(snapped.x), float(snapped.y)))
    return None if best is None else (best[1], best[2])


# Tramos del borde que compiten por ser el de la sugerencia (los más cercanos al borde del padre): acota el costo en bordes muy curvos.
SUGGEST_CANDIDATES = 8


def _suggest(context: _Context, node: _Node) -> tuple[tuple[float, float], tuple[float, float]] | None:
    """Sugerencia automática (heurística simple y determinista): los tramos del borde de la pieza más cercanos al borde de su padre son los que miran
    al hueco; el puente va en el PUNTO MEDIO de uno de ellos y perpendicular a él (hacia afuera). Gana el hueco más corto (a igual hueco, el tramo
    más largo, y a igual todo, el punto medio menor): no depende del vértice por el que arranque ni del sentido de giro de los anillos.
    (ancla, dirección) o None."""
    if node.polygon is None or node.target_ring is None:
        return None
    coords = np.asarray(orient(node.polygon, 1.0).exterior.coords, dtype=float)
    start, segment = coords[:-1], coords[1:] - coords[:-1]
    length = np.linalg.norm(segment, axis=1)
    usable = np.nonzero(length > 0)[0]
    if usable.size == 0:
        return None
    edges = shapely.linestrings(np.stack([start[usable], coords[1:][usable]], axis=1))
    distance = shapely.distance(edges, LinearRing(node.target_ring))
    slack = max(context.tolerance * 1e-3, 1e-9, float(distance.min()) * 1e-9)
    close = [(float(distance[position]), int(usable[position])) for position in np.nonzero(distance <= distance.min() + slack)[0]]
    candidates = []
    for _, index in sorted(close, key=lambda pair: (round(pair[0], 9), round(float(start[pair[1]][0] + segment[pair[1]][0] / 2), 9), round(float(start[pair[1]][1] + segment[pair[1]][1] / 2), 9)))[:SUGGEST_CANDIDATES]:
        middle = (float(start[index][0] + segment[index][0] / 2), float(start[index][1] + segment[index][1] / 2))
        normal = (float(segment[index][1] / length[index]) + 0.0, float(-segment[index][0] / length[index]) + 0.0)
        crossing = _cast(middle, normal, context.union, context.mode, context.tolerance)
        if crossing is not None:
            candidates.append(((round(crossing[1], 9), round(-float(length[index]), 9), round(middle[0], 9), round(middle[1], 9)), middle, normal))
    if not candidates:
        return None
    _, middle, normal = min(candidates, key=lambda candidate: candidate[0])
    return middle, normal


def _owner_candidates(context: _Context, island: int, far_point: Point) -> list[int]:
    """Parts: subjects a los que se le puede sumar el bridge, en orden: los de la pieza flotante y luego los del cuerpo al que se llega."""
    node = context.nodes[island]
    threshold = context.tolerance * context.tolerance * OVERLAP_AREA_FACTOR
    near = [index for index, geometry in enumerate(context.geometries) if not geometry.is_empty and geometry.intersection(node.polygon).area > threshold]
    far = [index for index, geometry in enumerate(context.geometries) if not geometry.is_empty and geometry.intersects(far_point)]
    return [*near, *[index for index in far if index not in near]]


def _resolve(context: _Context, index: int, bridge: dict, suggested: bool) -> dict:
    """Resuelve y valida UN bridge contra la geometría original. Devuelve el dict de la respuesta + `_rectangle` (interno)."""
    tolerance = context.tolerance
    width = float(bridge["width"])
    item = {
        "index": index, "suggested": suggested, "valid": False, "reason": None, "island": bridge.get("island"), "anchor": None,
        "direction": None, "width": width, "length": None, "area": None, "reduces": False, "affects": [], "polygon": None,
        "_rectangle": None,
    }

    def fail(reason: str) -> dict:
        item["reason"] = reason
        return item

    if width < tolerance:
        return fail(REASON_WIDTH_BELOW_TOLERANCE)

    requested = bridge.get("island")
    given_anchor = bridge.get("anchor")
    given_direction = bridge.get("direction")
    if requested is not None and (requested >= len(context.nodes) or context.nodes[requested].kind != "floating"):
        return fail(REASON_UNKNOWN_ISLAND)

    direction: tuple[float, float] | None
    if given_anchor is not None:
        found = _find_anchor(context, (float(given_anchor["x"]), float(given_anchor["y"])), requested)
        if found is None:
            return fail(REASON_ANCHOR_OUTSIDE)
        island, origin = found
        direction = None
        if given_direction is not None:
            direction = _unit((float(given_direction["x"]), float(given_direction["y"])))
            if direction is None:
                return fail(REASON_INVALID_DIRECTION)
        else:
            direction = _outward_normal(context.nodes[island].polygon, origin, tolerance)
    else:
        island = requested
        suggestion = _suggest(context, context.nodes[island])
        if suggestion is None:
            item["island"] = island
            return fail(REASON_NO_CROSSING)
        origin, direction = suggestion
        if given_direction is not None:
            direction = _unit((float(given_direction["x"]), float(given_direction["y"])))
            if direction is None:
                item["island"] = island
                return fail(REASON_INVALID_DIRECTION)

    item["island"] = island
    item["anchor"] = {"x": origin[0], "y": origin[1]}
    if direction is None:
        return fail(REASON_NO_CROSSING)
    item["direction"] = {"x": direction[0], "y": direction[1]}

    crossing = _cast(origin, direction, context.union, context.mode, tolerance)
    if crossing is None:
        return fail(REASON_NO_CROSSING)
    start, end = crossing
    item["length"] = end - start

    overlap = OVERLAP_FACTOR * tolerance
    explicit = bridge.get("length")
    reach = end if explicit is None else float(explicit)
    rectangle = _rectangle(origin, direction, overlap, reach + overlap, width)
    item["_rectangle"] = rectangle
    item["polygon"] = {"type": "polygon", "coordinates": _closed_ring(rectangle)}
    if explicit is not None and float(explicit) < end - max(tolerance * 1e-3, 1e-9):
        return fail(REASON_TOO_SHORT)

    if context.mode == "stencil":
        item["area"] = float(rectangle.intersection(context.union).area)
        affects = _stencil_affected(context, rectangle)
    else:
        item["area"] = float(rectangle.difference(context.union).area)
        far = Point(origin[0] + direction[0] * (end + overlap * 0.5), origin[1] + direction[1] * (end + overlap * 0.5))
        candidates = _owner_candidates(context, island, far)
        owner = next((candidate for candidate in candidates if not context.locked[candidate]), None)
        affects = [] if owner is None else [owner]
        if owner is None and candidates:
            item["affects"] = [candidates[0]]
            return fail(REASON_LOCKED_SUBJECT)
    item["affects"] = affects
    if any(context.locked[subject] for subject in affects):
        return fail(REASON_LOCKED_SUBJECT)
    if not affects:
        # Ninguna forma recibiría el bridge (no hay corte que abrir / cuerpo al que sumarlo): no conecta nada.
        return fail(REASON_NO_CONNECTION)

    after, _ = _count(_apply_to_union(context.union, context.mode, [rectangle]), context.mode, tolerance)
    if after >= context.floating_before:
        return fail(REASON_NO_CONNECTION)
    item["valid"] = True
    return item


def _closed_ring(polygon: Polygon) -> list:
    """Anillos canónicos (cerrados, exterior antihorario) de un rectángulo; sin umbral de área práctico: un bridge muy fino igual se dibuja."""
    piece = _finalize(polygon, 1e-12, lines=False)
    if len(piece) != 1:
        raise GeometryResultInvalidError("Un bridge produjo un rectángulo inválido.")
    return piece[0]["coordinates"]


def _stencil_affected(context: _Context, rectangle: Polygon) -> list[int]:
    """Subjects de corte con los que el rectángulo solapa de verdad (los que perderían material al restarlo)."""
    if context.subject_tree is None:
        return []
    threshold = context.tolerance * context.tolerance * OVERLAP_AREA_FACTOR
    present = [index for index, geometry in enumerate(context.geometries) if not geometry.is_empty]
    found = []
    for position in context.subject_tree.query(rectangle, predicate="intersects"):
        index = present[int(position)]
        if context.geometries[index].intersection(rectangle).area > threshold:
            found.append(index)
    return sorted(found)


def _rebuild(pieces: list[dict]) -> BaseGeometry:
    return _union([Polygon(piece["coordinates"][0], piece["coordinates"][1:]) for piece in pieces])


def run_bridges(
    subjects: list[dict],
    mode: str,
    bridges: list[dict],
    suggest: bool,
    suggest_width: float | None,
    tolerance: float,
) -> dict:
    """Resuelve, valida y aplica `bridges` (ver el docstring del módulo). `subjects` son los dicts del contrato (con `locked` opcional);
    `bridges`: `{"island", "anchor": {"x","y"}, "direction": {"x","y"}, "width", "length"}` con al menos `island` o `anchor`.
    Devuelve `{"bridges", "results", "reanalysis"}`."""
    _check_inputs(mode, tolerance)
    if suggest and (suggest_width is None or not math.isfinite(suggest_width) or suggest_width <= 0):
        raise InvalidParametersError("`suggest` necesita `suggest_width`: un ancho finito mayor que 0.")

    geometries = [_subject_geometry(subject) for subject in subjects]
    locked = [bool(subject.get("locked", False)) for subject in subjects]
    union = _union(geometries)
    nodes, _, _ = _ordered_tree(union, mode, tolerance)
    present = [geometry for geometry in geometries if not geometry.is_empty]
    floating_before = sum(1 for node in nodes if node.kind == "floating")
    context = _Context(union, nodes, geometries, locked, mode, tolerance, floating_before, STRtree(present) if present else None)

    resolved = [_resolve(context, index, bridge, False) for index, bridge in enumerate(bridges)]
    if suggest:
        covered = {item["island"] for item in resolved if item["valid"]}
        for island, node in enumerate(nodes):
            if node.kind == "floating" and island not in covered:
                resolved.append(_resolve(context, len(resolved), {"island": island, "width": suggest_width}, True))

    valid = [item for item in resolved if item["valid"]]
    rectangles = [item["_rectangle"] for item in valid]

    # Qué pierde / gana cada forma: stencil resta los rectángulos que la solapan; parts suma al dueño los que le tocan.
    new_geometry: dict[int, BaseGeometry] = {}
    for subject_index, geometry in enumerate(geometries):
        mine = [item["_rectangle"] for item in valid if subject_index in item["affects"]]
        if not mine:
            continue
        combined = unary_union(mine)
        new_geometry[subject_index] = geometry.difference(combined) if mode == "stencil" else geometry.union(combined)

    results = []
    final_geometries: list[BaseGeometry] = []
    for subject_index, geometry in enumerate(geometries):
        if subject_index not in new_geometry:
            results.append({"subject_index": subject_index, "changed": False, "geometries": []})
            final_geometries.append(geometry)
            continue
        pieces = _finalize(new_geometry[subject_index], tolerance, lines=False)
        results.append({"subject_index": subject_index, "changed": True, "geometries": pieces})
        final_geometries.append(_rebuild(pieces))

    after_floating, after_main = _count(_union(final_geometries), mode, tolerance)

    # Un bridge "reduce" si, sumado a los válidos anteriores (en orden), deja menos flotantes: dos bridges sobre la misma isla -> el segundo no reduce nada.
    accumulated: list[Polygon] = []
    previous = floating_before
    for item in valid:
        accumulated.append(item["_rectangle"])
        current, _ = _count(_apply_to_union(union, mode, accumulated), mode, tolerance)
        item["reduces"] = current < previous
        previous = current

    public = [{key: value for key, value in item.items() if not key.startswith("_")} for item in resolved]
    return {
        "bridges": public,
        "results": results,
        "reanalysis": {"floating_before": floating_before, "floating_after": after_floating, "main_after": after_main},
    }
