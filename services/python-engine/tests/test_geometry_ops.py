"""Tests del núcleo puro del servicio de geometría (M3-S04, app.core.geometry_ops).
Todos los valores esperados (áreas, número de piezas, huecos, largos) están calculados A MANO a partir
de las coordenadas de cada caso -- ver el comentario de cada test --, no copiados de la salida del
código: una difference rota (p. ej. que devuelva el subject intacto o que "pinte" en vez de restar)
tiene que hacer fallar estos tests.
"""

import math

import pytest
from shapely.geometry import LineString, Polygon

from app.core.errors import InvalidParametersError
from app.core.geometry_ops import MAX_QUAD_SEGS, MIN_QUAD_SEGS, _arc_resolution, _buffered_line, run_boolean

TOLERANCE = 0.01


def _polygon(*rings: list[tuple[float, float]]) -> dict:
    return {"type": "polygon", "coordinates": [list(ring) for ring in rings]}


def _square(x: float, y: float, size: float) -> list[tuple[float, float]]:
    return [(x, y), (x + size, y), (x + size, y + size), (x, y + size)]


def _line(*points: tuple[float, float]) -> dict:
    return {"type": "line", "coordinates": list(points)}


def _brush(*points: tuple[float, float], radius: float) -> dict:
    return {"type": "bufferedLine", "points": list(points), "radius": radius}


def _pieces(outcome: dict, index: int = 0) -> list[dict]:
    return outcome["results"][index]["geometries"]


def _area(piece: dict) -> float:
    assert piece["type"] == "polygon"
    rings = piece["coordinates"]
    return Polygon(rings[0], rings[1:]).area


def _length(piece: dict) -> float:
    assert piece["type"] == "line"
    return LineString(piece["coordinates"]).length


def _assert_clean(outcome: dict) -> None:
    """Contrato del resultado: coordenadas finitas, polígonos válidos y anillos cerrados."""
    for item in outcome["results"]:
        for piece in item["geometries"]:
            rings = piece["coordinates"] if piece["type"] == "polygon" else [piece["coordinates"]]
            for ring in rings:
                assert all(math.isfinite(value) for point in ring for value in point)
            if piece["type"] == "polygon":
                assert Polygon(rings[0], rings[1:]).is_valid
                assert all(ring[0] == ring[-1] for ring in rings)


# ---- difference ----


def test_difference_con_hueco_resta_el_area_exacta_y_deja_un_anillo_interior():
    # 40x40 (1600) menos un cuadrado interior 10..20 (100) = 1500, una pieza con un hueco.
    outcome = run_boolean("difference", [_polygon(_square(0, 0, 40))], [_polygon(_square(10, 10, 10))], TOLERANCE)

    pieces = _pieces(outcome)
    assert len(pieces) == 1
    assert len(pieces[0]["coordinates"]) == 2  # exterior + 1 hueco
    assert _area(pieces[0]) == pytest.approx(1500.0)
    assert sorted(pieces[0]["coordinates"][1][:-1]) == [(10.0, 10.0), (10.0, 20.0), (20.0, 10.0), (20.0, 20.0)]
    assert outcome["results"][0]["changed"] is True
    _assert_clean(outcome)


def test_difference_que_parte_el_subject_devuelve_varias_piezas_en_orden():
    # Franja horizontal y 15..25 (alto 10) que cruza todo el 40x40: quedan 2 piezas de 40 x 15 = 600 cada una.
    outcome = run_boolean("difference", [_polygon(_square(0, 0, 40))], [_polygon([(-5, 15), (45, 15), (45, 25), (-5, 25)])], TOLERANCE)

    pieces = _pieces(outcome)
    assert [round(_area(piece), 6) for piece in pieces] == [600.0, 600.0]
    # Orden determinista: por coordenadas -> primero la de arriba en y (la que empieza en (0, 0)).
    assert pieces[0]["coordinates"][0][0] == (0.0, 0.0)
    assert pieces[1]["coordinates"][0][0] == (0.0, 25.0)
    _assert_clean(outcome)


def test_difference_con_un_poligono_totalmente_cubierto_da_vacio():
    outcome = run_boolean("difference", [_polygon(_square(10, 10, 10))], [_polygon(_square(0, 0, 40))], TOLERANCE)

    assert _pieces(outcome) == []
    assert outcome["results"][0]["changed"] is True  # hay algo que eliminar: el cliente borra el objeto


def test_difference_con_un_operando_disjunto_devuelve_el_subject_identico_y_sin_cambios():
    subject = _polygon(_square(0, 0, 40))
    outcome = run_boolean("difference", [subject], [_polygon(_square(100, 100, 10)), _brush((200, 200), (300, 200), radius=5)], TOLERANCE)

    item = outcome["results"][0]
    assert item["changed"] is False
    assert len(item["geometries"]) == 1
    assert item["geometries"][0]["coordinates"] == [[(0.0, 0.0), (40.0, 0.0), (40.0, 40.0), (0.0, 40.0), (0.0, 0.0)]]


def test_difference_sin_operandos_no_cambia_nada():
    outcome = run_boolean("difference", [_polygon(_square(0, 0, 40))], [], TOLERANCE)

    assert outcome["results"][0]["changed"] is False
    assert _area(_pieces(outcome)[0]) == pytest.approx(1600.0)


def test_difference_con_un_pincel_dentro_del_subject_abre_un_hueco_de_area_pi_r2():
    # Un toque circular de radio 5 en el centro: 1600 - pi*25 = 1521,46. El polígono inscrito (flecha <= tolerancia) resta
    # a lo sumo perímetro * tolerancia = 2*pi*5*0,01 = 0,314 de menos que el círculo ideal.
    outcome = run_boolean("difference", [_polygon(_square(0, 0, 40))], [_brush((20, 20), radius=5)], TOLERANCE)

    pieces = _pieces(outcome)
    assert len(pieces) == 1 and len(pieces[0]["coordinates"]) == 2
    assert 1600 - math.pi * 25 < _area(pieces[0]) < 1600 - math.pi * 25 + 2 * math.pi * 5 * TOLERANCE
    _assert_clean(outcome)


def test_difference_con_un_pincel_que_cruza_parte_el_subject_en_dos():
    # Pincel horizontal y = 20, radio 5, que desborda el cuadrado: franja 15..25 -> 2 piezas de 40 x 15.
    outcome = run_boolean("difference", [_polygon(_square(0, 0, 40))], [_brush((-10, 20), (50, 20), radius=5)], TOLERANCE)

    assert [round(_area(piece), 6) for piece in _pieces(outcome)] == [600.0, 600.0]


def test_difference_aplica_cada_operando_a_cada_subject_por_separado():
    subjects = [_polygon(_square(0, 0, 10)), _polygon(_square(100, 0, 10)), _polygon(_square(200, 0, 10))]
    # El pincel solo toca el segundo (x 100..110): borra la mitad izquierda 100..105.
    outcome = run_boolean("difference", subjects, [_polygon([(95, -5), (105, -5), (105, 15), (95, 15)])], TOLERANCE)

    assert [item["subject_index"] for item in outcome["results"]] == [0, 1, 2]
    assert [item["changed"] for item in outcome["results"]] == [False, True, False]
    assert _area(_pieces(outcome, 0)[0]) == pytest.approx(100.0)
    assert _area(_pieces(outcome, 1)[0]) == pytest.approx(50.0)
    assert _area(_pieces(outcome, 2)[0]) == pytest.approx(100.0)


def test_difference_de_lineas_las_parte_con_el_pincel():
    # Línea y = 20 de x 0 a 40, pincel vertical en x = 20 radio 2: quedan 0..18 y 22..40 (18 cada una).
    outcome = run_boolean("difference", [_line((0, 20), (40, 20))], [_brush((20, 0), (20, 40), radius=2)], TOLERANCE)

    pieces = _pieces(outcome)
    assert [piece["type"] for piece in pieces] == ["line", "line"]
    assert [round(_length(piece), 6) for piece in pieces] == [18.0, 18.0]
    assert pieces[0]["coordinates"][0] == (0.0, 20.0) and pieces[0]["coordinates"][-1] == (18.0, 20.0)
    assert pieces[1]["coordinates"][0] == (22.0, 20.0) and pieces[1]["coordinates"][-1] == (40.0, 20.0)


def test_difference_de_una_linea_totalmente_borrada_da_vacio():
    outcome = run_boolean("difference", [_line((10, 10), (12, 10))], [_brush((11, 10), radius=5)], TOLERANCE)

    assert _pieces(outcome) == []
    assert outcome["results"][0]["changed"] is True


def test_difference_de_una_polilinea_cerrada_cortada_una_vez_queda_en_una_sola_pieza():
    # Lazo 10x10 (perímetro 40) cortado en (5, 0) con radio 1: se quita 2 de largo -> UNA polilínea de 38, no dos tramos sueltos.
    loop = _line((0, 0), (10, 0), (10, 10), (0, 10), (0, 0))
    outcome = run_boolean("difference", [loop], [_brush((5, 0), radius=1)], TOLERANCE)

    pieces = _pieces(outcome)
    assert len(pieces) == 1
    assert _length(pieces[0]) == pytest.approx(38.0, abs=0.05)


def test_difference_ignora_los_vertices_repetidos_y_el_cierre_explicito_del_anillo():
    abierto = run_boolean("difference", [_polygon(_square(0, 0, 40))], [_polygon(_square(10, 10, 10))], TOLERANCE)
    cerrado = run_boolean(
        "difference",
        [_polygon([(0, 0), (0, 0), (40, 0), (40, 40), (0, 40), (0, 0)])],
        [_polygon(_square(10, 10, 10))],
        TOLERANCE,
    )

    assert cerrado == abierto


# ---- regla par-impar ----


def test_anillos_anidados_siguen_la_regla_par_impar_hueco_e_isla():
    # Exterior 40x40 (1600) - hueco 30x30 desde (5,5) (900) + isla 10x10 dentro del hueco (100) = 800: 2 piezas, la isla aparte.
    subject = _polygon(_square(0, 0, 40), _square(5, 5, 30), _square(15, 15, 10))
    outcome = run_boolean("difference", [subject], [_polygon(_square(500, 500, 1))], TOLERANCE)

    pieces = _pieces(outcome)
    assert sorted(round(_area(piece), 6) for piece in pieces) == [100.0, 700.0]  # corona (1600-900) + isla
    assert sum(_area(piece) for piece in pieces) == pytest.approx(800.0)


def test_el_pincel_dentro_del_hueco_del_subject_no_lo_toca():
    subject = _polygon(_square(0, 0, 40), _square(10, 10, 20))  # hueco 10..30
    outcome = run_boolean("difference", [subject], [_brush((20, 20), radius=3)], TOLERANCE)

    assert outcome["results"][0]["changed"] is False
    assert _area(_pieces(outcome)[0]) == pytest.approx(1600 - 400)


# ---- intersection / union / xor / normalize ----


def test_intersection_deja_solo_la_zona_comun():
    outcome = run_boolean("intersection", [_polygon(_square(0, 0, 20))], [_polygon(_square(10, 10, 20))], TOLERANCE)

    pieces = _pieces(outcome)
    assert len(pieces) == 1 and _area(pieces[0]) == pytest.approx(100.0)  # [10,20]^2


def test_intersection_sin_operandos_es_un_error_de_parametros():
    with pytest.raises(InvalidParametersError):
        run_boolean("intersection", [_polygon(_square(0, 0, 20))], [], TOLERANCE)


def test_intersection_disjunta_da_vacio():
    outcome = run_boolean("intersection", [_polygon(_square(0, 0, 10))], [_polygon(_square(50, 50, 10))], TOLERANCE)

    assert _pieces(outcome) == []


def test_union_funde_los_solapados_en_una_sola_pieza_y_es_un_resultado_unico():
    outcome = run_boolean("union", [_polygon(_square(0, 0, 20)), _polygon(_square(10, 10, 20))], [], TOLERANCE)

    assert outcome["scope"] == "combined"
    assert len(outcome["results"]) == 1 and outcome["results"][0]["subject_index"] is None
    pieces = _pieces(outcome)
    assert len(pieces) == 1 and _area(pieces[0]) == pytest.approx(400 + 400 - 100)


def test_union_de_disjuntos_mantiene_las_dos_piezas():
    outcome = run_boolean("union", [_polygon(_square(0, 0, 10)), _polygon(_square(50, 0, 10))], [], TOLERANCE)

    assert [round(_area(piece), 6) for piece in _pieces(outcome)] == [100.0, 100.0]


def test_xor_de_dos_cuadrados_solapados_quita_la_zona_comun():
    outcome = run_boolean("xor", [_polygon(_square(0, 0, 20)), _polygon(_square(10, 10, 20))], [], TOLERANCE)

    # 400 + 400 - 2 * 100 = 600 repartidos en dos piezas en L de 300.
    assert sum(_area(piece) for piece in _pieces(outcome)) == pytest.approx(600.0)
    assert sorted(round(_area(piece), 6) for piece in _pieces(outcome)) == [300.0, 300.0]
    _assert_clean(outcome)


def test_normalize_de_un_mono_lo_divide_en_dos_triangulos_validos():
    # Moño (0,0)-(40,40)-(40,0)-(0,40): se cruza en (20,20). Dos triángulos de 40 de base x 20 de alto / 2 = 400.
    bowtie = _polygon([(0, 0), (40, 40), (40, 0), (0, 40)])
    outcome = run_boolean("normalize", [bowtie], [], TOLERANCE)

    pieces = _pieces(outcome)
    assert [round(_area(piece), 6) for piece in pieces] == [400.0, 400.0]
    _assert_clean(outcome)


def test_normalize_conserva_un_poligono_ya_valido():
    outcome = run_boolean("normalize", [_polygon(_square(0, 0, 40))], [], TOLERANCE)

    pieces = _pieces(outcome)
    assert len(pieces) == 1 and _area(pieces[0]) == pytest.approx(1600.0)


# ---- determinismo y forma canónica ----


def test_el_resultado_no_depende_del_vertice_inicial_ni_del_sentido_de_los_anillos():
    base = run_boolean("difference", [_polygon(_square(0, 0, 40), _square(10, 10, 10))], [_polygon(_square(30, 30, 20))], TOLERANCE)
    rotado_e_invertido = run_boolean(
        "difference",
        [_polygon([(40, 40), (40, 0), (0, 0), (0, 40)], [(20, 20), (20, 10), (10, 10), (10, 20)])],
        [_polygon(_square(30, 30, 20))],
        TOLERANCE,
    )

    assert rotado_e_invertido == base


def test_las_piezas_salen_ordenadas_por_coordenadas_sin_importar_el_orden_de_entrada():
    # Cuatro cuadrados disjuntos declarados de derecha a izquierda: el resultado siempre va de izquierda a derecha.
    rings = [_square(300, 0, 10), _square(100, 0, 10), _square(200, 0, 10), _square(0, 0, 10)]
    for operation, subjects in (("normalize", [_polygon(*rings)]), ("union", [_polygon(ring) for ring in rings])):
        outcome = run_boolean(operation, subjects, [], TOLERANCE)

        assert [piece["coordinates"][0][0][0] for piece in _pieces(outcome)] == [0.0, 100.0, 200.0, 300.0], operation


def test_el_mismo_pedido_repetido_da_exactamente_el_mismo_resultado():
    args = ("difference", [_polygon(_square(0, 0, 40)), _line((0, 5), (40, 5))], [_brush((-5, 20), (45, 25), radius=4)], TOLERANCE)

    assert run_boolean(*args) == run_boolean(*args)


def test_anillos_orientados_de_forma_consistente_exterior_antihorario_huecos_horarios():
    # En ejes matemáticos: el área con signo del exterior es > 0 y la de cada hueco < 0.
    outcome = run_boolean("difference", [_polygon(_square(0, 0, 40))], [_polygon(_square(10, 10, 10))], TOLERANCE)

    exterior, hole = _pieces(outcome)[0]["coordinates"]

    def signed_area(ring):
        return sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(ring, ring[1:])) / 2

    assert signed_area(exterior) == pytest.approx(1600.0)
    assert signed_area(hole) == pytest.approx(-100.0)
    assert exterior[0] == min(exterior[:-1]) and hole[0] == min(hole[:-1])


# ---- entradas degeneradas ----


def test_un_anillo_colineal_o_de_menos_de_tres_vertices_distintos_no_aporta_geometria():
    colineal = run_boolean("normalize", [_polygon([(0, 0), (10, 0), (20, 0)])], [], TOLERANCE)
    repetido = run_boolean("normalize", [_polygon([(5, 5), (5, 5), (5, 5)])], [], TOLERANCE)

    assert _pieces(colineal) == [] and _pieces(repetido) == []
    assert colineal["results"][0]["changed"] is False


def test_una_linea_con_todos_los_vertices_iguales_es_degenerada():
    outcome = run_boolean("difference", [_line((3, 3), (3, 3))], [_brush((100, 100), radius=1)], TOLERANCE)

    assert _pieces(outcome) == []


def test_las_piezas_despreciables_se_descartan_con_la_tolerancia():
    # Cuadrado de 0,05 de lado (área 0,0025) con tolerancia 0,1 (umbral 0,01): se descarta; con tolerancia 0,01 (umbral 1e-4) se conserva.
    pequeno = _polygon(_square(0, 0, 0.05))
    assert _pieces(run_boolean("normalize", [pequeno], [], 0.1)) == []
    assert len(_pieces(run_boolean("normalize", [pequeno], [], 0.01))) == 1


def test_el_pincel_deja_una_astilla_menor_que_la_tolerancia_y_se_descarta():
    # Línea 0..10, pincel (centro 6,995, radio 3) que llega a x = 9,995: quedan 0..3,995 y una astilla de 0,005 < tolerancia 0,01 -> la astilla se descarta.
    outcome = run_boolean("difference", [_line((0, 0), (10, 0))], [_brush((9.995 - 3, 0), radius=3)], TOLERANCE)

    assert [round(_length(piece), 3) for piece in _pieces(outcome)] == [3.995]


def test_la_tolerancia_debe_ser_positiva_y_finita():
    for invalid in (0, -1, math.nan, math.inf):
        with pytest.raises(InvalidParametersError):
            run_boolean("normalize", [_polygon(_square(0, 0, 10))], [], invalid)


# ---- resolución del pincel ----


def test_el_area_del_pincel_coincide_con_la_formula_de_un_stadium():
    # Segmento de 60 con radio 5: 2*r*L + pi*r^2 = 600 + 78,54 (el borde curvo es un polígono inscrito: error <= 2*pi*r*tolerancia).
    stadium = _buffered_line([(0, 0), (60, 0)], 5.0, TOLERANCE)

    assert 600 + math.pi * 25 - 2 * math.pi * 5 * TOLERANCE < stadium.area < 600 + math.pi * 25
    assert stadium.bounds == pytest.approx((-5.0, -5.0, 65.0, 5.0))


def test_un_solo_punto_del_pincel_es_un_circulo():
    dab = _buffered_line([(10, 10)], 5.0, TOLERANCE)

    assert math.pi * 25 - 2 * math.pi * 5 * TOLERANCE < dab.area < math.pi * 25
    assert dab.centroid.coords[0] == pytest.approx((10.0, 10.0))


def test_la_resolucion_de_arcos_crece_al_bajar_la_tolerancia_y_esta_acotada():
    gruesa = _arc_resolution(10.0, 1.0)
    fina = _arc_resolution(10.0, 0.001)

    assert gruesa < fina <= MAX_QUAD_SEGS
    assert _arc_resolution(1.0, 5.0) == MIN_QUAD_SEGS  # tolerancia mayor que el radio
    assert _arc_resolution(1e9, 1e-6) == MAX_QUAD_SEGS  # radio enorme: acotado
    # La flecha del arco de la resolución elegida respeta la tolerancia: r*(1 - cos(pi / (4*n))) <= tol.
    assert 10.0 * (1 - math.cos(math.pi / (4 * fina))) <= 0.001


# ---- aptitud para operaciones posteriores (S08 booleanas, S14 Laser Checker) ----


def test_un_poligono_dibujado_cerrado_y_simple_pasa_normalize_igual_y_es_valido():
    # El anillo que Draw manda para un cerrado SIMPLE (sin cruces) vuelve idéntico en área y válido: normalize no lo "arregla" ni lo deforma.
    drawn = [(10, 10), (70, 10), (90, 40), (50, 80), (10, 50)]
    outcome = run_boolean("normalize", [_polygon(drawn)], [], TOLERANCE)

    pieces = _pieces(outcome)
    assert len(pieces) == 1
    assert _area(pieces[0]) == pytest.approx(Polygon(drawn).area)
    assert Polygon(pieces[0]["coordinates"][0]).is_valid
    _assert_clean(outcome)


def test_un_trazo_cerrado_con_varios_cruces_queda_en_piezas_validas_sin_nan():
    # Figura en "8" con un tercer cruce: todas las piezas salen válidas y finitas, y ninguna es un lazo auto-intersecado.
    scribble = [(0, 0), (40, 40), (40, 0), (0, 40), (20, -10), (60, 20)]
    outcome = run_boolean("normalize", [_polygon(scribble)], [], TOLERANCE)

    assert len(_pieces(outcome)) >= 2
    _assert_clean(outcome)
    assert all(Polygon(piece["coordinates"][0]).is_simple for piece in _pieces(outcome))


def test_un_borrado_parcial_con_muchos_trazos_no_deja_poligonos_invalidos_ni_nan():
    # Polígono con hueco recorrido por un pincel en zigzag de 40 puntos: el resultado (varias piezas, con y sin huecos) es válido y finito.
    subject = _polygon(_square(0, 0, 200), _square(80, 80, 40))
    zigzag = [(-10 + 5 * index, 20 + (index % 2) * 150) for index in range(42)]
    outcome = run_boolean("difference", [subject], [_brush(*zigzag, radius=6)], TOLERANCE)

    assert outcome["results"][0]["changed"] is True
    assert len(_pieces(outcome)) >= 1
    _assert_clean(outcome)
    assert sum(_area(piece) for piece in _pieces(outcome)) < 200 * 200 - 40 * 40
