"""Tests del núcleo puro del corte / división de geometría (M3-S10, app.core.geometry_split).
Todos los valores esperados (áreas, piezas, largos) están calculados A MANO a partir de las coordenadas de cada caso -- ver el
comentario de cada test --, no copiados de la salida del código: un corte roto (que ignore el modo, que divida sin atravesar, que
no reparta un hueco, que pierda área, que no extienda...) tiene que hacer fallar estos tests.
"""

import json
import math
import time

import pytest
from shapely.geometry import Polygon

from app.core.errors import InvalidParametersError
from app.core.geometry_split import cutter_line, run_split

TOLERANCE = 0.01


def _polygon(*rings: list[tuple[float, float]]) -> dict:
    return {"type": "polygon", "coordinates": [list(ring) for ring in rings]}


def _rect(x: float, y: float, width: float, height: float) -> list[tuple[float, float]]:
    return [(x, y), (x + width, y), (x + width, y + height), (x, y + height)]


def _line(*points: tuple[float, float]) -> dict:
    return {"type": "line", "coordinates": list(points)}


def _split(subject: dict, cutter: list, mode: str = "split", slot_width: float = 0.0, extend: bool = False, tolerance: float = TOLERANCE) -> dict:
    """Corte de UN subject: devuelve su entrada de resultado."""
    return run_split([subject], cutter, mode, slot_width, extend, tolerance)["results"][0]


def _area(piece: dict) -> float:
    rings = piece["coordinates"]
    return Polygon(rings[0], rings[1:]).area


def _areas(item: dict) -> list[float]:
    return sorted(_area(piece) for piece in item["pieces"])


def _length(piece: dict) -> float:
    return sum(math.dist(a, b) for a, b in zip(piece["coordinates"], piece["coordinates"][1:]))


def _lengths(item: dict) -> list[float]:
    return sorted(_length(piece) for piece in item["pieces"])


def _signed(ring: list) -> float:
    return sum(ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1] for i in range(len(ring) - 1)) / 2


SQUARE_10 = _polygon(_rect(0, 0, 10, 10))


# ---- Dividir: polígonos ----


def test_cuadrado_dividido_por_la_diagonal_da_dos_triangulos_de_area_mitad_con_suma_exacta():
    # Cuadrado 10 x 10 (área 100); la diagonal (0,0)-(10,10) pasa por dos vértices: 2 triángulos de 10·10/2 = 50 cada uno.
    item = _split(SQUARE_10, [(-1, -1), (11, 11)])

    assert item["changed"] is True and item["touched"] is True
    assert item["piece_count"] == 2 == len(item["pieces"])
    assert _areas(item) == pytest.approx([50.0, 50.0], abs=1e-9)
    assert sum(_areas(item)) == pytest.approx(100.0, abs=1e-9)
    # Cada triángulo tiene exactamente 3 vértices distintos (4 con el cierre) y comparten la diagonal.
    assert [len(piece["coordinates"][0]) for piece in item["pieces"]] == [4, 4]
    shared = set(map(tuple, item["pieces"][0]["coordinates"][0])) & set(map(tuple, item["pieces"][1]["coordinates"][0]))
    assert shared == {(0.0, 0.0), (10.0, 10.0)}


def test_rectangulo_con_corte_recto_da_areas_w1_por_h_y_w2_por_h():
    # 30 x 10 cortado en x = 12: 12·10 = 120 y 18·10 = 180 (suma 300).
    item = _split(_polygon(_rect(0, 0, 30, 10)), [(12, -5), (12, 15)])

    assert item["piece_count"] == 2
    assert _areas(item) == pytest.approx([120.0, 180.0], abs=1e-9)


def test_poligono_con_hueco_cortado_por_la_mitad_reparte_el_hueco_entre_las_dos_piezas():
    # 20 x 10 con un hueco 8..12 x 3..7 (4 x 4 = 16). El corte x = 10 pasa por el centro del hueco: cada mitad es 10·10 − 2·4 = 92 y
    # ninguna conserva un hueco cerrado (queda una muesca en el borde): un solo anillo por pieza.
    subject = _polygon(_rect(0, 0, 20, 10), _rect(8, 3, 4, 4))

    item = _split(subject, [(10, -1), (10, 11)])

    assert item["piece_count"] == 2
    assert _areas(item) == pytest.approx([92.0, 92.0], abs=1e-9)
    assert [len(piece["coordinates"]) for piece in item["pieces"]] == [1, 1]


def test_el_hueco_que_el_corte_no_toca_se_conserva_en_su_pieza():
    # Mismo polígono cortado en x = 4: izquierda 4·10 = 40 sin hueco; derecha 16·10 − 16 = 144 con su hueco entero (2 anillos).
    subject = _polygon(_rect(0, 0, 20, 10), _rect(8, 3, 4, 4))

    item = _split(subject, [(4, -1), (4, 11)])

    assert _areas(item) == pytest.approx([40.0, 144.0], abs=1e-9)
    by_rings = sorted(len(piece["coordinates"]) for piece in item["pieces"])
    assert by_rings == [1, 2]


def test_forma_en_u_cortada_por_una_linea_que_cruza_dos_veces_da_tres_piezas():
    # U: contorno (0,0)-(9,0)-(9,6)-(6,6)-(6,2)-(3,2)-(3,6)-(0,6); área = 9·6 − 3·4 = 42. La línea y = 4 cruza los dos brazos (x 0..3 y x 6..9):
    # dos puntas de 3·2 = 6 y la base con los troncos de los brazos, 42 − 12 = 30.
    u_shape = _polygon([(0, 0), (9, 0), (9, 6), (6, 6), (6, 2), (3, 2), (3, 6), (0, 6)])

    item = _split(u_shape, [(-1, 4), (10, 4)])

    assert item["piece_count"] == 3
    assert _areas(item) == pytest.approx([6.0, 6.0, 30.0], abs=1e-9)
    assert sum(_areas(item)) == pytest.approx(42.0, abs=1e-9)


def test_la_u_cortada_por_una_linea_que_cruza_un_solo_brazo_da_dos_piezas():
    u_shape = _polygon([(0, 0), (9, 0), (9, 6), (6, 6), (6, 2), (3, 2), (3, 6), (0, 6)])

    item = _split(u_shape, [(-1, 4), (4, 4)])  # entra por la izquierda y termina en el hueco de la U: cruza solo el brazo izquierdo

    assert item["piece_count"] == 2
    assert _areas(item) == pytest.approx([6.0, 36.0], abs=1e-9)


def test_corte_en_ele_con_dos_tramos_separa_una_esquina():
    # Entra por la izquierda (y = 5) hasta x = 5 y baja hasta salir por abajo (x = 5): aísla el cuadrante inferior izquierdo, 5·5 = 25 (el resto 75).
    item = _split(SQUARE_10, [(-1, 5), (5, 5), (5, -1)])

    assert _areas(item) == pytest.approx([25.0, 75.0], abs=1e-9)


def test_islas_dentro_de_huecos_se_cortan_como_piezas_aparte():
    # 30 x 10 con un hueco 5..25 x 2..8 y una isla 10..20 x 4..6 dentro del hueco (regla par-impar). Corte en x = 15:
    # el marco izquierdo (x < 15) = 15·10 − 10·6 = 90, el derecho también, y cada mitad de la isla 5·2 = 10.
    subject = _polygon(_rect(0, 0, 30, 10), _rect(5, 2, 20, 6), _rect(10, 4, 10, 2))

    item = _split(subject, [(15, -1), (15, 11)])

    assert item["piece_count"] == 4
    assert _areas(item) == pytest.approx([10.0, 10.0, 90.0, 90.0], abs=1e-9)


def test_las_piezas_son_poligonos_validos_cerrados_y_con_orientacion_canonica():
    subject = _polygon(_rect(0, 0, 20, 10), _rect(8, 3, 4, 4))

    for piece in _split(subject, [(4, -1), (4, 11)])["pieces"]:
        exterior, *holes = piece["coordinates"]
        assert piece["type"] == "polygon"
        assert Polygon(exterior, holes).is_valid
        assert _signed(exterior) > 0  # exterior antihorario
        assert all(_signed(hole) < 0 for hole in holes)  # huecos horarios
        for ring in piece["coordinates"]:
            assert ring[0] == ring[-1] == min(ring[:-1])  # cerrado y empieza en su vértice mínimo


def test_un_corte_multiple_que_cruza_varias_veces_parte_en_todas_las_regiones():
    # Zigzag (2,-1) -> (2,11) -> (4,11) -> (4,-1): cruza 2 veces el rectángulo 6 x 10 -> 3 franjas de 2·10, 2·10 y 2·10 = 20 cada una.
    item = _split(_polygon(_rect(0, 0, 6, 10)), [(2, -1), (2, 11), (4, 11), (4, -1)])

    assert _areas(item) == pytest.approx([20.0, 20.0, 20.0], abs=1e-9)


# ---- Cortes que no atraviesan ----


def test_un_corte_que_termina_dentro_de_la_forma_no_la_divide_y_la_devuelve_intacta():
    # Desde fuera hasta el centro (5,5): entra pero no sale -> sin extender no divide. changed:false, touched:true y la pieza es el cuadrado.
    item = _split(SQUARE_10, [(5, 20), (5, 5)])

    assert item["touched"] is True
    assert item["changed"] is False
    assert item["piece_count"] == 1
    assert item["pieces"][0]["coordinates"] == [[(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0), (0.0, 0.0)]]
    assert item["discarded"] == 0


def test_extender_hace_que_el_mismo_corte_si_atraviese():
    # El mismo corte que termina en el centro, prolongado en su dirección (el primer tramo hacia (5,20) y el último hacia abajo): x = 5 completo.
    item = _split(SQUARE_10, [(5, 20), (5, 5)], extend=True)

    assert item["changed"] is True
    assert _areas(item) == pytest.approx([50.0, 50.0], abs=1e-9)


def test_extender_prolonga_solo_los_extremos_y_no_los_vertices_intermedios():
    # Tres puntos: (0,0) -> (4,0) -> (4,4). Extendido: el primer tramo hacia -x y el último hacia +y; el vértice (4,0) queda donde estaba.
    line = cutter_line([(0, 0), (4, 0), (4, 4)], [], True)

    points = list(line.coords)
    assert len(points) == 3 and points[1] == (4.0, 0.0)
    assert points[0][0] < 0 and points[0][1] == 0.0
    assert points[2][0] == 4.0 and points[2][1] > 4.0


def test_extender_alcanza_a_los_subjects_lejanos():
    far = _polygon(_rect(1000, 1000, 10, 10))
    reaching = run_split([far], [(0, 0), (1, 1)], "split", 0.0, True, TOLERANCE)["results"][0]
    short = run_split([far], [(0, 0), (1, 1)], "split", 0.0, False, TOLERANCE)["results"][0]

    # La diagonal prolongada pasa por (1000,1000) y (1010,1010): divide el cuadrado lejano. Sin extender ni lo toca.
    assert reaching["changed"] is True and _areas(reaching) == pytest.approx([50.0, 50.0], abs=1e-9)
    assert short["touched"] is False and short["changed"] is False


def test_un_corte_colineal_con_un_borde_no_divide():
    # La línea corre exactamente por el borde inferior (y = 0): toca la forma pero no la separa.
    item = _split(SQUARE_10, [(-5, 0), (15, 0)])

    assert item["touched"] is True
    assert item["changed"] is False
    assert item["piece_count"] == 1 and _areas(item) == pytest.approx([100.0])


def test_un_corte_que_no_toca_el_subject_responde_no_tocado():
    item = _split(SQUARE_10, [(20, 0), (20, 10)])

    assert item["touched"] is False
    assert item["changed"] is False
    assert item["piece_count"] == 1


def test_un_corte_dentro_de_un_hueco_no_toca_la_forma():
    # El segmento queda por completo dentro del hueco 8..12 x 3..7: no hay forma que cortar.
    subject = _polygon(_rect(0, 0, 20, 10), _rect(8, 3, 4, 4))

    item = _split(subject, [(9, 5), (11, 5)])

    assert item["touched"] is False and item["changed"] is False


def test_un_corte_que_solo_roza_un_vertice_no_divide():
    # La línea toca el vértice (10,10) del cuadrado y sigue por fuera: un punto no separa nada.
    item = _split(SQUARE_10, [(10, 10), (20, 20)])

    assert item["touched"] is True and item["changed"] is False


# ---- Orientación e invariancias ----


def test_el_sentido_de_giro_de_los_anillos_no_cambia_el_resultado():
    ccw = _polygon(_rect(0, 0, 20, 10), _rect(8, 3, 4, 4))
    cw = _polygon(list(reversed(_rect(0, 0, 20, 10))), list(reversed(_rect(8, 3, 4, 4))))

    assert _split(ccw, [(4, -1), (4, 11)]) == _split(cw, [(4, -1), (4, 11)])


def test_el_sentido_de_la_linea_de_corte_no_cambia_las_piezas():
    forward = _split(SQUARE_10, [(-1, -1), (11, 11)])
    backward = _split(SQUARE_10, [(11, 11), (-1, -1)])

    assert forward["pieces"] == backward["pieces"]


def test_los_anillos_abiertos_o_cerrados_dan_lo_mismo():
    closed = _polygon([*_rect(0, 0, 10, 10), (0, 0)])

    assert _split(closed, [(5, -1), (5, 11)]) == _split(SQUARE_10, [(5, -1), (5, 11)])


def test_es_determinista_byte_a_byte():
    subject = _polygon(_rect(0, 0, 20, 10), _rect(8, 3, 4, 4))
    runs = [json.dumps(run_split([subject, SQUARE_10], [(4, -1), (4, 11), (9, 12)], "split", 0.0, False, TOLERANCE)) for _ in range(5)]

    assert len(set(runs)) == 1
    slot_runs = [json.dumps(run_split([subject], [(4, -1), (4, 11)], "slot", 0.5, True, TOLERANCE)) for _ in range(3)]
    assert len(set(slot_runs)) == 1


def test_un_resultado_por_subject_en_el_mismo_orden():
    far = _polygon(_rect(100, 100, 5, 5))
    results = run_split([SQUARE_10, far, _polygon(_rect(0, 20, 10, 10))], [(5, -1), (5, 11)], "split", 0.0, False, TOLERANCE)["results"]

    assert [item["subject_index"] for item in results] == [0, 1, 2]
    assert [item["changed"] for item in results] == [True, False, False]
    assert [item["touched"] for item in results] == [True, False, False]


# ---- Ranura ----


def test_ranura_de_ancho_w_quita_w_por_el_largo_atravesado_y_deja_dos_piezas_separadas():
    # Cuadrado 10 x 10, ranura w = 0,4 en x = 5 (de x 4,8 a 5,2): área = 100 − 0,4·10 = 96; dos piezas de 4,8·10 = 48.
    item = _split(SQUARE_10, [(5, -1), (5, 11)], mode="slot", slot_width=0.4)

    assert item["changed"] is True and item["piece_count"] == 2
    assert _areas(item) == pytest.approx([48.0, 48.0], abs=1e-9)
    assert sum(_areas(item)) == pytest.approx(100.0 - 0.4 * 10.0, abs=1e-9)
    left, right = sorted(item["pieces"], key=lambda piece: piece["coordinates"])
    assert Polygon(left["coordinates"][0]).bounds == pytest.approx((0.0, 0.0, 4.8, 10.0))
    assert Polygon(right["coordinates"][0]).bounds == pytest.approx((5.2, 0.0, 10.0, 10.0))
    assert Polygon(left["coordinates"][0]).distance(Polygon(right["coordinates"][0])) == pytest.approx(0.4)


def test_ranura_en_rectangulo_asimetrico_quita_exactamente_w_por_alto():
    # 30 x 10 con w = 0,5 en x = 12: izquierda (12 − 0,25)·10 = 117,5; derecha (18 − 0,25)·10 = 177,5; suma 295 = 300 − 0,5·10.
    item = _split(_polygon(_rect(0, 0, 30, 10)), [(12, -5), (12, 15)], mode="slot", slot_width=0.5)

    assert _areas(item) == pytest.approx([117.5, 177.5], abs=1e-9)


def test_ranura_diagonal_quita_w_por_el_largo_de_la_diagonal():
    # Diagonal del cuadrado 10 x 10 con w = 0,2. La ranura {|x − y| <= d} con d = 0,1·√2 es una banda: dentro del cuadrado queda
    # 100 − (10 − d)² = 20d − d² = 2√2 − 0,02 (la banda es más angosta que w·10√2 en las dos esquinas, que la recortan en triángulos de d²/2).
    item = _split(SQUARE_10, [(-5, -5), (15, 15)], mode="slot", slot_width=0.2)

    assert item["piece_count"] == 2
    assert 100.0 - sum(_areas(item)) == pytest.approx(2 * math.sqrt(2) - 0.02, abs=1e-9)


def test_ranura_que_no_atraviesa_no_cambia_nada():
    # La ranura termina en (5,5): hace una muesca, no separa -> el cuadrado vuelve intacto.
    item = _split(SQUARE_10, [(5, 20), (5, 5)], mode="slot", slot_width=0.4)

    assert item["touched"] is True and item["changed"] is False
    assert _areas(item) == pytest.approx([100.0])


def test_la_ranura_termina_exactamente_donde_termina_la_linea_dibujada_extremos_planos():
    # La línea llega a y = 0,1 del borde inferior (no lo alcanza) y la ranura mide 0,4 de ancho. Con extremo PLANO la ranura no pasa de y = 0,1 y deja un puente
    # de 0,1 de alto: no separa nada. Con extremo redondo (radio 0,2) la ranura asomaría hasta y = −0,1 y partiría el cuadrado: eso es lo que NO debe pasar.
    item = _split(SQUARE_10, [(5, 0.1), (5, 12)], mode="slot", slot_width=0.4)

    assert item["touched"] is True and item["changed"] is False
    assert _areas(item) == pytest.approx([100.0])


def test_ranura_con_extender_si_atraviesa():
    item = _split(SQUARE_10, [(5, 20), (5, 5)], mode="slot", slot_width=0.4, extend=True)

    assert item["changed"] is True
    assert _areas(item) == pytest.approx([48.0, 48.0], abs=1e-9)


def test_ranura_con_hueco_reparte_el_hueco_y_resta_solo_el_area_de_forma():
    # 20 x 10 con hueco 8..12 x 3..7, ranura w = 1 en x = 10: el hueco ocupa 4 de los 10 de alto, así que la ranura solo quita
    # 1·(10 − 4) = 6 de forma. Total: 200 − 16 − 6 = 178; mitades de 89.
    subject = _polygon(_rect(0, 0, 20, 10), _rect(8, 3, 4, 4))

    item = _split(subject, [(10, -1), (10, 11)], mode="slot", slot_width=1.0)

    assert _areas(item) == pytest.approx([89.0, 89.0], abs=1e-9)


def test_ranura_con_corte_en_ele_usa_uniones_redondas_sin_pasarse_del_trazo():
    # L de dos tramos: (−1,5)→(5,5)→(5,−1) con w = 0,2. Aísla el cuadrante inferior izquierdo. Área quitada dentro del cuadrado: banda horizontal
    # (x 0..5: 5·0,2 = 1) + banda vertical (y 0..5: 1) − su solape (0,1·0,1 = 0,01) = 1,99, más la unión redonda hacia afuera de la esquina (un
    # cuarto de disco de radio 0,1: π·0,01/4 = 0,00785 si fuera un arco perfecto; el arco es un polígono inscrito, así que queda algo menos).
    item = _split(SQUARE_10, [(-1, 5), (5, 5), (5, -1)], mode="slot", slot_width=0.2)

    assert item["piece_count"] == 2
    removed = 100.0 - sum(_areas(item))
    assert 1.99 + 0.0070 < removed < 1.99 + math.pi * 0.01 / 4 + 1e-9


# ---- Polilíneas ----


def test_linea_abierta_cortada_en_dos_puntos_da_tres_tramos_con_largos_calculados():
    # (0,0)-(10,0) cortada por x = 3 y x = 7 -> tramos de 3, 4 y 3.
    one = _split(_line((0, 0), (10, 0)), [(3, -1), (3, 1)])
    assert _lengths(one) == pytest.approx([3.0, 7.0])

    two = run_split([_line((0, 0), (10, 0))], [(3, -1), (3, 1), (7, 1), (7, -1)], "split", 0.0, False, TOLERANCE)["results"][0]
    assert two["piece_count"] == 3
    assert _lengths(two) == pytest.approx([3.0, 3.0, 4.0])
    assert sum(_lengths(two)) == pytest.approx(10.0)


def test_polilinea_con_codo_se_corta_en_el_punto_de_cruce():
    # (0,0)→(10,0)→(10,10) cortada por y = 5 en (10,5): 10 + 5 = 15 y 5.
    item = _split(_line((0, 0), (10, 0), (10, 10)), [(5, 5), (15, 5)])

    assert _lengths(item) == pytest.approx([5.0, 15.0])
    assert any(piece["coordinates"][0] == (0.0, 0.0) and piece["coordinates"][-1] == (10.0, 5.0) for piece in item["pieces"])


def test_una_linea_cortada_en_un_extremo_o_sin_cruce_no_se_divide():
    # El corte toca el extremo (10,0) de la línea: cortar en un extremo no parte nada.
    at_end = _split(_line((0, 0), (10, 0)), [(10, -1), (10, 1)])
    apart = _split(_line((0, 0), (10, 0)), [(20, -1), (20, 1)])

    assert at_end["touched"] is True and at_end["changed"] is False and at_end["piece_count"] == 1
    assert apart["touched"] is False and apart["changed"] is False
    assert at_end["pieces"][0]["coordinates"] == [(0.0, 0.0), (10.0, 0.0)]


def test_un_corte_que_toca_un_extremo_de_la_linea_y_cruza_en_otro_punto_no_deja_tramos_de_largo_cero():
    # Zigzag (0,-1) -> (0,1) -> (5,1) -> (5,-1): toca la línea en su extremo (0,0) y la cruza en (5,0). Solo el cruce parte: 2 tramos de 5 y NADA que descartar.
    item = _split(_line((0, 0), (10, 0)), [(0, -1), (0, 1), (5, 1), (5, -1)])

    assert item["piece_count"] == 2 and item["discarded"] == 0
    assert _lengths(item) == pytest.approx([5.0, 5.0])


def test_un_tramo_de_largo_exactamente_igual_a_la_tolerancia_es_despreciable():
    # Tolerancia 0,25 (binario exacto): el tramo (0,0)-(0,25) mide justo 0,25 -> se descarta (<=); queda una sola pieza útil y el corte no separa.
    item = _split(_line((0, 0), (10, 0)), [(0.25, -1), (0.25, 1)], tolerance=0.25)

    assert item["changed"] is False and item["piece_count"] == 1


def test_una_linea_colineal_con_el_corte_no_se_divide():
    item = _split(_line((0, 0), (10, 0)), [(-5, 0), (15, 0)])

    assert item["changed"] is False and item["piece_count"] == 1


def test_polilinea_que_se_cruza_a_si_misma_se_corta_en_el_tramo_correcto():
    # "Moño" abierto: (0,0)→(10,10)→(10,0)→(0,10); se cruza en (5,5) (tramos 1 y 3). El corte y = 2 cruza el tramo 2 ((10,10)→(10,0)) en (10,2) y
    # el tramo 1 en (2,2); y el tramo 3 ((10,0)→(0,10)) en (8,2): 3 cruces -> 4 tramos.
    item = _split(_line((0, 0), (10, 10), (10, 0), (0, 10)), [(-1, 2), (11, 2)])

    assert item["piece_count"] == 4
    assert sum(_lengths(item)) == pytest.approx(10 * math.sqrt(2) + 10 + 10 * math.sqrt(2))


def test_las_piezas_de_una_linea_salen_en_orden_determinista_por_coordenadas_aunque_la_linea_vaya_al_reves():
    # (10,0) -> (0,0) cortada en x = 3: por posición salen primero (10,0)-(3,0) y luego (3,0)-(0,0); el contrato las ordena por coordenadas: (3,0)... antes que (10,0)...
    item = _split(_line((10, 0), (0, 0)), [(3, -1), (3, 1)])

    assert [piece["coordinates"] for piece in item["pieces"]] == [[(3.0, 0.0), (0.0, 0.0)], [(10.0, 0.0), (3.0, 0.0)]]


def test_polilinea_cerrada_cortada_dos_veces_da_dos_tramos_que_se_vuelven_a_unir_en_el_origen():
    # Cuadrado cerrado de perímetro 40 cortado por x = 5 (cruza en (5,0) y (5,10)): dos tramos de 20 (el que contiene el vértice inicial (0,0) se une).
    ring = _line((0, 0), (10, 0), (10, 10), (0, 10), (0, 0))

    item = _split(ring, [(5, -1), (5, 11)])

    assert item["changed"] is True and item["piece_count"] == 2
    assert _lengths(item) == pytest.approx([20.0, 20.0])


def test_polilinea_cerrada_cortada_una_sola_vez_no_se_considera_separada():
    # Un corte (5,-1)→(5,5): cruza solo en (5,0): el anillo queda abierto, una sola pieza -> intacto.
    ring = _line((0, 0), (10, 0), (10, 10), (0, 10), (0, 0))

    item = _split(ring, [(5, -1), (5, 5)])

    assert item["touched"] is True and item["changed"] is False and item["piece_count"] == 1


def test_ranura_en_una_linea_quita_el_ancho_de_la_ranura_del_trazo():
    # (0,0)-(10,0) con una ranura de w = 2 en x = 5 (x 4..6): quedan dos tramos de 4.
    item = _split(_line((0, 0), (10, 0)), [(5, -1), (5, 1)], mode="slot", slot_width=2.0)

    assert item["changed"] is True
    assert _lengths(item) == pytest.approx([4.0, 4.0])
    assert all(piece["type"] == "line" for piece in item["pieces"])


def test_ranura_en_una_polilinea_cerrada_une_el_tramo_que_cruza_el_vertice_inicial():
    # Cuadrado cerrado (perímetro 40), ranura w = 2 en x = 5: quita 2 del borde inferior y 2 del superior -> dos tramos de (40 − 4)/2 = 18.
    ring = _line((0, 0), (10, 0), (10, 10), (0, 10), (0, 0))

    item = _split(ring, [(5, -1), (5, 11)], mode="slot", slot_width=2.0)

    assert item["piece_count"] == 2
    assert _lengths(item) == pytest.approx([18.0, 18.0])


def test_los_tramos_de_linea_de_largo_menor_o_igual_a_la_tolerancia_se_descartan_y_se_cuentan():
    # Corte a 0,005 del extremo con tolerancia 0,01: el tramo de 0,005 es despreciable. Con 1 tramo útil no hay separación.
    item = _split(_line((0, 0), (10, 0)), [(0.005, -1), (0.005, 1)])

    assert item["changed"] is False and item["piece_count"] == 1

    # Con un corte más en medio: salen 3 tramos (0,005 / 4,995 / 5), uno despreciable -> 2 piezas y 1 descartada.
    mid = run_split([_line((0, 0), (10, 0))], [(0.005, -1), (0.005, 1), (5, 1), (5, -1)], "split", 0.0, False, TOLERANCE)["results"][0]
    assert mid["changed"] is True and mid["piece_count"] == 2 and mid["discarded"] == 1
    assert _lengths(mid) == pytest.approx([4.995, 5.0])


# ---- Astillas ----


def test_una_astilla_menor_que_tolerancia_cuadrada_no_cuenta_como_separacion():
    # Corte a x = 0,000005 de un cuadrado de 10: la astilla izquierda mide 0,000005·10 = 5e-5 < 0,01² = 1e-4. Queda una sola pieza util: sin cambio.
    item = _split(SQUARE_10, [(0.000005, -1), (0.000005, 11)])

    assert item["touched"] is True and item["changed"] is False
    assert _areas(item) == pytest.approx([100.0])


def test_una_astilla_entre_dos_cortes_se_descarta_y_se_cuenta():
    # Zigzag con dos cortes a x = 5 y x = 5,000005: la franja del medio mide 5e-5 < 1e-4 -> se descarta; quedan 2 piezas útiles.
    item = _split(SQUARE_10, [(5, -1), (5, 11), (5.000005, 11), (5.000005, -1)])

    assert item["changed"] is True
    assert item["piece_count"] == 2
    assert item["discarded"] == 1
    assert _areas(item) == pytest.approx([50.0 - 5e-5, 50.0], abs=1e-9)


# ---- Entradas degeneradas y parámetros ----


def test_un_subject_degenerado_no_tiene_nada_que_partir():
    degenerate = _polygon([(0, 0), (5, 0), (10, 0)])  # área cero
    point_line = _line((1, 1), (1, 1))  # un solo punto distinto

    results = run_split([degenerate, point_line], [(-1, 0), (11, 0)], "split", 0.0, False, TOLERANCE)["results"]

    assert [(item["touched"], item["changed"], item["piece_count"], item["pieces"]) for item in results] == [(False, False, 0, [])] * 2


def test_un_corte_con_todos_los_puntos_iguales_se_rechaza():
    with pytest.raises(InvalidParametersError):
        run_split([SQUARE_10], [(5, 5), (5, 5), (5, 5)], "split", 0.0, False, TOLERANCE)


@pytest.mark.parametrize("width", [0.0, -1.0, math.nan, math.inf])
def test_modo_ranura_exige_ancho_positivo_y_finito(width):
    with pytest.raises(InvalidParametersError):
        run_split([SQUARE_10], [(5, -1), (5, 11)], "slot", width, False, TOLERANCE)


def test_modo_dividir_ignora_el_ancho_de_la_ranura():
    assert run_split([SQUARE_10], [(5, -1), (5, 11)], "split", 0.0, False, TOLERANCE) == run_split(
        [SQUARE_10], [(5, -1), (5, 11)], "split", 7.0, False, TOLERANCE
    )


def test_modo_desconocido_o_tolerancia_invalida_se_rechazan():
    with pytest.raises(InvalidParametersError):
        run_split([SQUARE_10], [(5, -1), (5, 11)], "chop", 0.0, False, TOLERANCE)
    for tolerance in (0.0, -0.1, math.nan, math.inf):
        with pytest.raises(InvalidParametersError):
            run_split([SQUARE_10], [(5, -1), (5, 11)], "split", 0.0, False, tolerance)


def test_los_vertices_consecutivos_repetidos_del_corte_no_cambian_el_resultado():
    clean = _split(SQUARE_10, [(5, -1), (5, 11)])
    noisy = _split(SQUARE_10, [(5, -1), (5, -1), (5, 11), (5, 11)])

    assert clean == noisy


def test_el_resultado_no_contiene_valores_no_finitos():
    item = _split(_polygon(_rect(0, 0, 20, 10), _rect(8, 3, 4, 4)), [(-1, -1), (21, 11)], mode="slot", slot_width=0.7)

    values = [value for piece in item["pieces"] for ring in piece["coordinates"] for point in ring for value in point]
    assert values and all(math.isfinite(value) for value in values)


# ---- Rendimiento ----


def test_muchos_subjects_se_cortan_en_un_tiempo_razonable():
    # Rejilla de 20 x 15 = 300 cuadrados de 8 x 8 (paso 10) cortados por una línea horizontal en y = 4 (mitad de la primera fila) y extendida:
    # solo cruza los 20 cuadrados de la primera fila; el resto queda intacto y no tocado.
    squares = [_polygon(_rect(column * 10, row * 10, 8, 8)) for row in range(15) for column in range(20)]

    started = time.perf_counter()
    results = run_split(squares, [(-1, 4), (201, 4)], "split", 0.0, False, TOLERANCE)["results"]
    elapsed = time.perf_counter() - started

    assert len(results) == 300
    assert sum(1 for item in results if item["changed"]) == 20
    assert sum(1 for item in results if item["touched"]) == 20
    assert all(_areas(item) == pytest.approx([32.0, 32.0]) for item in results if item["changed"])
    assert elapsed < 5.0
