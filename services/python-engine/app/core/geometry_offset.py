"""M3-S09: offset (inset/outset) de geometría del servicio de geometría del servidor (ADR D4 de
docs/ADR_EDITOR_MVP3.md). Mismo formato de intercambio que las booleanas de S04/S08 (anillos de polígonos y
polilíneas en UNIDADES DE DOCUMENTO, nunca path data), mismo motor (Shapely/GEOS `buffer`) y los mismos
ayudantes de `app.core.geometry_ops` (regla par-impar, `make_valid`, resolución de arcos acotada por la
tolerancia, descarte de piezas < tolerancia², orientación/orden canónicos). Sin estado y sin E/S.

Contrato:
- `distance` está FIRMADA y en unidades de documento: > 0 agranda (exterior), < 0 encoge (interior). El
  cliente convierte los mm del panel con `mmPerUnit`; este módulo no sabe de mm.
- Subject `polygon`: exterior (+) o interior (−). Subject `line` (polilínea abierta o cerrada): solo "ambos
  lados" -- el resultado es un polígono alrededor de la línea de ancho total 2·|distance| (una polilínea
  cerrada da un anillo con hueco); una `distance` negativa con líneas es un error de parámetros (el cliente
  deshabilita "Interior" para ellas y el servidor no lo reinterpreta en silencio).
- `join_style`: `round` (arcos con resolución acotada por la tolerancia), `mitre` (inglete; `mitre_limit` es
  la razón máxima entre el largo del inglete y la distancia: pasado el límite GEOS recorta la punta) o `bevel`.
  `cap_style` (solo líneas): `round`, `flat` o `square`. En un offset INTERIOR el join solo actúa en las
  esquinas cóncavas (en las convexas la forma simplemente se encoge).
- Resultado por subject, SIEMPRE explícito sobre lo que pasó (nada falla en silencio):
  `geometries` (polígonos válidos, orden determinista), `collapsed` (no queda NADA), `pieces_before` (piezas
  disjuntas del subject), `split_count` (piezas del resultado: > pieces_before - lost_pieces = el subject se partió),
  `lost_pieces` (piezas del subject que desaparecen del todo; solo puede pasar hacia adentro), `holes_before`/
  `holes_after` y `max_inward_offset` (radio del máximo círculo inscrito: con un offset interior mayor o igual
  todo el subject colapsa; `None` para líneas, que no tienen interior).
- Salida determinista (mismas entradas -> mismas salidas, byte a byte), sin NaN, polígonos válidos
  (`is_valid`) y sin piezas de área < tolerancia² (se descartan).
"""

import math

import shapely
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union

from app.core.errors import InvalidParametersError
from app.core.geometry_ops import _arc_resolution, _finalize, _polygonal_parts, _subject_geometry

JOIN_STYLES = ("round", "mitre", "bevel")
CAP_STYLES = ("round", "flat", "square")


def _hole_count(parts) -> int:
    return sum(len(part.interiors) for part in parts)


def _piece_holes(pieces: list[dict]) -> int:
    return sum(len(piece["coordinates"]) - 1 for piece in pieces)


def _max_inward_offset(region: BaseGeometry, tolerance: float) -> float:
    """Radio del máximo círculo inscrito de la región (exacto salvo `tolerance`): el offset interior a partir del
    cual TODO el subject colapsa. Sin interior (región vacía) es 0."""
    if region.is_empty:
        return 0.0
    radius = float(shapely.maximum_inscribed_circle(region, tolerance).length)
    return radius if math.isfinite(radius) else 0.0


def _empty_item(index: int, is_line: bool) -> dict:
    """Un subject degenerado (anillo sin área, línea de un solo punto) no tiene nada que desplazar: no queda nada."""
    return {
        "subject_index": index,
        "geometries": [],
        "collapsed": True,
        "pieces_before": 0,
        "split_count": 0,
        "lost_pieces": 0,
        "holes_before": 0,
        "holes_after": 0,
        "max_inward_offset": None if is_line else 0.0,
    }


def _offset_polygon(subject_geometry: BaseGeometry, distance: float, buffer_args: dict, tolerance: float) -> tuple[list[dict], int, int, int]:
    """(piezas, piezas_antes, huecos_antes, piezas_perdidas) de un subject poligonal."""
    parts = _polygonal_parts(subject_geometry)
    if distance > 0:
        # Hacia afuera las piezas pueden fundirse entre sí: se desplaza el conjunto, nada se pierde.
        return _finalize(subject_geometry.buffer(distance, **buffer_args), tolerance, lines=False), len(parts), _hole_count(parts), 0

    # Hacia adentro una región nunca se funde con otra (el resultado es un subconjunto): cada pieza se encoge por separado, así se sabe
    # cuáles desaparecen del todo (un círculo de radio |distance| tiene que caber dentro de UNA sola pieza, por lo que el resultado es el mismo).
    pieces: list[dict] = []
    lost = 0
    for part in parts:
        shrunk = _finalize(part.buffer(distance, **buffer_args), tolerance, lines=False)
        if not shrunk:
            lost += 1
        pieces.extend(shrunk)
    pieces.sort(key=lambda piece: piece["coordinates"])
    return pieces, len(parts), _hole_count(parts), lost


def run_offset(
    subjects: list[dict],
    distance: float,
    join_style: str,
    mitre_limit: float,
    cap_style: str,
    tolerance: float,
) -> dict:
    """Ejecuta el offset y devuelve `{"results": [...]}` con una entrada por subject, en orden (ver el docstring del módulo).
    `subjects` son los dicts del contrato (`type` + `coordinates`), ya validados por el esquema."""
    if join_style not in JOIN_STYLES:
        raise InvalidParametersError(f"join_style desconocido: {join_style!r}. Valores válidos: {', '.join(JOIN_STYLES)}.")
    if cap_style not in CAP_STYLES:
        raise InvalidParametersError(f"cap_style desconocido: {cap_style!r}. Valores válidos: {', '.join(CAP_STYLES)}.")
    if not math.isfinite(distance) or distance == 0:
        raise InvalidParametersError("La distancia debe ser un número finito distinto de 0.")
    if not math.isfinite(mitre_limit) or mitre_limit <= 0:
        raise InvalidParametersError("El límite de inglete debe ser un número finito mayor que 0.")
    if not math.isfinite(tolerance) or tolerance <= 0:
        raise InvalidParametersError("La tolerancia debe ser un número finito mayor que 0.")
    if distance < 0 and any(subject["type"] == "line" for subject in subjects):
        raise InvalidParametersError("Una línea abierta solo se desplaza a ambos lados: la distancia interior (negativa) no aplica a líneas.")

    buffer_args = {
        "quad_segs": _arc_resolution(abs(distance), tolerance),
        "join_style": join_style,
        "mitre_limit": mitre_limit,
        "cap_style": cap_style,
    }
    results: list[dict] = []
    for index, subject in enumerate(subjects):
        is_line = subject["type"] == "line"
        geometry = _subject_geometry(subject)
        if geometry.is_empty:
            results.append(_empty_item(index, is_line))
            continue

        if is_line:
            # Ambos lados: el buffer de una polilínea es un polígono de ancho total 2·|distance| (con `cap_style` en los extremos).
            pieces = _finalize(geometry.buffer(abs(distance), **buffer_args), tolerance, lines=False)
            pieces_before, holes_before, lost, max_inward = 1, 0, 0, None
        else:
            pieces, pieces_before, holes_before, lost = _offset_polygon(geometry, distance, buffer_args, tolerance)
            max_inward = _max_inward_offset(unary_union(_polygonal_parts(geometry)), tolerance)

        results.append(
            {
                "subject_index": index,
                "geometries": pieces,
                "collapsed": len(pieces) == 0,
                "pieces_before": pieces_before,
                "split_count": len(pieces),
                "lost_pieces": lost,
                "holes_before": holes_before,
                "holes_after": _piece_holes(pieces),
                "max_inward_offset": max_inward,
            }
        )
    return {"results": results}
