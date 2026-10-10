"""Tests del núcleo puro del offset de geometría (M3-S09, app.core.geometry_offset).
Todos los valores esperados (áreas, piezas, huecos, alturas de un inglete) están calculados A MANO a partir de las
coordenadas de cada caso -- ver el comentario de cada test --, no copiados de la salida del código: un offset roto
(que ignore el signo, que no respete el join, que no avise del colapso o de la división...) tiene que hacer fallar
estos tests.
"""

import json
import math
import time

import pytest
from shapely.geometry import Point, Polygon

from app.core.errors import InvalidParametersError
from app.core.geometry_offset import run_offset
from app.core.geometry_ops import MAX_QUAD_SEGS, _arc_resolution

TOLERANCE = 0.01


def _polygon(*rings: list[tuple[float, float]]) -> dict:
    return {"type": "polygon", "coordinates": [list(ring) for ring in rings]}


def _rect(x: float, y: float, width: float, height: float) -> list[tuple[float, float]]:
    return [(x, y), (x + width, y), (x + width, y + height), (x, y + height)]


def _line(*points: tuple[float, float]) -> dict:
    return {"type": "line", "coordinates": list(points)}


def _offset(subject: dict, distance: float, join: str = "round", cap: str = "round", mitre_limit: float = 2.0, tolerance: float = TOLERANCE) -> dict:
    """Offset de UN subject: devuelve su entrada de resultado."""
    return run_offset([subject], distance, join, mitre_limit, cap, tolerance)["results"][0]


def _area(piece: dict) -> float:
    rings = piece["coordinates"]
    return Polygon(rings[0], rings[1:]).area


def _total_area(item: dict) -> float:
    return sum(_area(piece) for piece in item["geometries"])


def _signed(ring: list) -> float:
    return sum(ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1] for i in range(len(ring) - 1)) / 2


def _circle(radius: float, segments: int = 720) -> dict:
    return _polygon([(radius * math.cos(2 * math.pi * i / segments), radius * math.sin(2 * math.pi * i / segments)) for i in range(segments)])


# ---- Rectángulo: exterior con cada join ----


def test_rectangulo_exterior_con_inglete_da_exactamente_w_mas_2d_por_h_mas_2d():
    # 40 x 20, d = 3, inglete: las esquinas quedan en punta -> (40 + 6) x (20 + 6) = 46 x 26 = 1196.
    item = _offset(_polygon(_rect(0, 0, 40, 20)), 3, join="mitre")

    assert len(item["geometries"]) == 1
    assert _area(item["geometries"][0]) == pytest.approx(1196.0, abs=1e-6)
    assert Polygon(item["geometries"][0]["coordinates"][0]).bounds == pytest.approx((-3.0, -3.0, 43.0, 23.0))
    assert item["collapsed"] is False and item["lost_pieces"] == 0


def test_rectangulo_exterior_redondo_da_wh_mas_2d_por_w_mas_h_mas_pi_d_cuadrado_dentro_de_la_tolerancia_de_los_arcos():
    # Área exacta = w·h + 2d(w + h) + π d² = 800 + 2·3·60 + π·9 = 1188,274... Los arcos son polígonos INSCRITOS: el área
    # es menor que la exacta, y el déficit no puede pasar de (largo de los arcos 2π d) x (flecha máxima = tolerancia).
    d = 3.0
    exact = 40 * 20 + 2 * d * (40 + 20) + math.pi * d * d
    item = _offset(_polygon(_rect(0, 0, 40, 20)), d, join="round")

    area = _area(item["geometries"][0])
    assert area < exact
    assert exact - area <= 2 * math.pi * d * TOLERANCE
    assert area == pytest.approx(exact, rel=2e-4)


def test_rectangulo_exterior_con_bisel_da_w_h_mas_2d_por_w_mas_h_mas_4_triangulos_de_d_cuadrado_sobre_2():
    # El bisel corta cada esquina con un triángulo de catetos d: 800 + 360 + 4·(9/2) = 1178. Queda entre el redondo y el inglete.
    rectangle = _polygon(_rect(0, 0, 40, 20))
    bevel = _area(_offset(rectangle, 3, join="bevel")["geometries"][0])
    round_ = _area(_offset(rectangle, 3, join="round")["geometries"][0])
    mitre = _area(_offset(rectangle, 3, join="mitre")["geometries"][0])

    assert bevel == pytest.approx(1178.0, abs=1e-6)
    assert bevel < round_ < mitre


# ---- Rectángulo: interior y colapso exacto ----


@pytest.mark.parametrize("join", ["round", "mitre", "bevel"])
def test_rectangulo_interior_da_w_menos_2d_por_h_menos_2d_con_cualquier_join(join):
    # Las esquinas de un rectángulo son convexas: hacia adentro el join no actúa. (40 - 6) x (20 - 6) = 34 x 14 = 476.
    item = _offset(_polygon(_rect(0, 0, 40, 20)), -3, join=join)

    assert _area(item["geometries"][0]) == pytest.approx(476.0, abs=1e-6)
    assert Polygon(item["geometries"][0]["coordinates"][0]).bounds == pytest.approx((3.0, 3.0, 37.0, 17.0))
    assert item["collapsed"] is False


@pytest.mark.parametrize("join", ["round", "mitre", "bevel"])
@pytest.mark.parametrize("distance", [10.0, 10.5, 15.0, 100.0])
def test_rectangulo_colapsa_exactamente_cuando_2d_alcanza_el_lado_menor(join, distance):
    # 40 x 20: el lado menor es 20, así que con d >= 10 (2d >= 20) no queda nada.
    item = _offset(_polygon(_rect(0, 0, 40, 20)), -distance, join=join)

    assert item["collapsed"] is True
    assert item["geometries"] == []
    assert item["split_count"] == 0
    assert item["lost_pieces"] == 1  # la única pieza del subject desaparece


@pytest.mark.parametrize("distance", [9.9, 9.99, 5.0, 0.5])
def test_rectangulo_no_colapsa_mientras_2d_sea_menor_que_el_lado_menor(distance):
    # Justo por debajo del límite todavía queda una tira: (40 - 2d) x (20 - 2d).
    item = _offset(_polygon(_rect(0, 0, 40, 20)), -distance, join="mitre")

    assert item["collapsed"] is False
    assert _total_area(item) == pytest.approx((40 - 2 * distance) * (20 - 2 * distance), abs=1e-6)


def test_cuadrado_colapsa_en_el_mismo_umbral_que_el_lado():
    assert _offset(_polygon(_rect(0, 0, 20, 20)), -10)["collapsed"] is True
    assert _offset(_polygon(_rect(0, 0, 20, 20)), -9.9)["collapsed"] is False


def test_una_pieza_menor_que_la_tolerancia_al_cuadrado_se_descarta_y_cuenta_como_colapso():
    # tolerancia 1 -> piezas de área < 1 se descartan. 40 x 20 con d = 9,99 deja 20,02 x 0,02 = 0,4004 (< 1): colapsa.
    # Con d = 9,9 deja 20,2 x 0,2 = 4,04 (>= 1): sobrevive.
    assert _offset(_polygon(_rect(0, 0, 40, 20)), -9.99, join="mitre", tolerance=1.0)["collapsed"] is True
    survives = _offset(_polygon(_rect(0, 0, 40, 20)), -9.9, join="mitre", tolerance=1.0)
    assert survives["collapsed"] is False
    assert _total_area(survives) == pytest.approx(20.2 * 0.2, abs=1e-6)


def test_el_contorno_de_una_linea_menor_que_la_tolerancia_al_cuadrado_se_descarta_y_cuenta_como_colapso():
    # (0,0)-(10,0) con d = 0,01 y cap plano: 10 x 0,02 = 0,2 de área. Con tolerancia 1 (umbral 1) se descarta; con 0,1 (umbral 0,01) sobrevive.
    thin = _line((0, 0), (10, 0))

    discarded = _offset(thin, 0.01, cap="flat", tolerance=1.0)
    kept = _offset(thin, 0.01, cap="flat", tolerance=0.1)

    assert discarded["collapsed"] is True and discarded["geometries"] == []
    assert kept["collapsed"] is False
    assert _total_area(kept) == pytest.approx(0.2, abs=1e-9)


# ---- maxInwardOffset ----


@pytest.mark.parametrize(("width", "height"), [(40, 20), (20, 40), (30, 30), (100, 6)])
def test_max_inward_offset_de_un_rectangulo_es_la_mitad_del_lado_menor(width, height):
    item = _offset(_polygon(_rect(0, 0, width, height)), 1)

    assert item["max_inward_offset"] == pytest.approx(min(width, height) / 2, abs=TOLERANCE)


def test_max_inward_offset_es_consistente_con_el_colapso():
    # Con un offset interior un poco MENOR que el máximo todavía queda algo; con uno igual o mayor, nada.
    rectangle = _polygon(_rect(0, 0, 40, 20))
    maximum = _offset(rectangle, 1)["max_inward_offset"]

    assert _offset(rectangle, -(maximum - 2 * TOLERANCE))["collapsed"] is False
    assert _offset(rectangle, -maximum)["collapsed"] is True
    assert _offset(rectangle, -(maximum + 1))["collapsed"] is True


def test_max_inward_offset_de_un_circulo_es_su_radio_y_no_cambia_con_el_signo_de_la_distancia():
    circle = _circle(10.0)
    outward = _offset(circle, 2)["max_inward_offset"]
    inward = _offset(circle, -2)["max_inward_offset"]

    # El máximo círculo inscrito de un 720-ágono regular de radio 10 es su apotema, r·cos(π/720) = 9,9999...
    assert outward == pytest.approx(10.0, abs=TOLERANCE)
    assert outward == inward


def test_max_inward_offset_de_una_mancuerna_es_el_radio_de_su_cuadrado_mayor():
    # Dos cuadrados de 20 x 20 unidos por un cuello de 4: el círculo mayor cabe en un cuadrado, radio 10.
    item = _offset(_DUMBBELL, -1)

    assert item["max_inward_offset"] == pytest.approx(10.0, abs=TOLERANCE)


def test_las_lineas_no_tienen_offset_interior_y_lo_informan_como_nulo():
    assert _offset(_line((0, 0), (10, 0)), 1)["max_inward_offset"] is None


# ---- Círculo, anillo con hueco ----


def test_circulo_exterior_da_pi_por_r_mas_d_al_cuadrado_y_el_interior_pi_por_r_menos_d_al_cuadrado():
    # Polígono de 720 lados inscrito en r = 10: su área es π r² (1 - ~1e-5). Exterior d = 2 -> π·144; interior -> π·64.
    circle = _circle(10.0)

    outside = _offset(circle, 2)
    inside = _offset(circle, -2)

    assert _total_area(outside) == pytest.approx(math.pi * 12**2, rel=1e-3)
    assert _total_area(inside) == pytest.approx(math.pi * 8**2, rel=1e-3)
    assert outside["collapsed"] is False and inside["collapsed"] is False


def test_anillo_exterior_achica_el_hueco_y_el_interior_lo_agranda():
    # Cuadrado de 40 con hueco de 20 (10..30). Exterior d = 2 (inglete): fuera 44 x 44, hueco 16 x 16 -> 1936 - 256 = 1680.
    # Interior d = 2: fuera 36 x 36, hueco 24 x 24 -> 1296 - 576 = 720.
    ring = _polygon(_rect(0, 0, 40, 40), _rect(10, 10, 20, 20))

    outside = _offset(ring, 2, join="mitre")
    inside = _offset(ring, -2, join="mitre")

    assert _total_area(outside) == pytest.approx(1680.0, abs=1e-6)
    assert (outside["holes_before"], outside["holes_after"]) == (1, 1)
    assert _total_area(inside) == pytest.approx(720.0, abs=1e-6)
    assert (inside["holes_before"], inside["holes_after"]) == (1, 1)
    # El hueco sale como anillo interior del resultado.
    assert len(outside["geometries"][0]["coordinates"]) == 2


def test_anillo_estrecho_colapsa_cuando_el_offset_interior_iguala_la_mitad_del_grosor():
    # Grosor del anillo = (40 - 20) / 2 = 10. Interior d = 5 -> desaparece. d = 4,9 -> queda una tira de (40 - 9,8)² - (20 + 9,8)² = 30,2² - 29,8² = 24.
    ring = _polygon(_rect(0, 0, 40, 40), _rect(10, 10, 20, 20))

    assert _offset(ring, -5, join="mitre")["collapsed"] is True
    thin = _offset(ring, -4.9, join="mitre")
    assert thin["collapsed"] is False
    assert _total_area(thin) == pytest.approx(24.0, abs=1e-6)
    assert thin["holes_after"] == 1


def test_un_hueco_chico_se_cierra_con_el_offset_exterior_y_se_informa_que_se_perdio():
    # Hueco de 4 x 4 con d = 2: queda de 0 -> desaparece. El resultado es el cuadrado macizo de 44 x 44 = 1936.
    ring = _polygon(_rect(0, 0, 40, 40), _rect(18, 18, 4, 4))

    item = _offset(ring, 2, join="mitre")

    assert (item["holes_before"], item["holes_after"]) == (1, 0)
    assert _total_area(item) == pytest.approx(1936.0, abs=1e-6)
    assert len(item["geometries"][0]["coordinates"]) == 1


def test_una_c_casi_cerrada_gana_un_hueco_con_el_offset_exterior():
    # Un cuadrado de 40 al que se le quita una ranura de 2 de ancho en el medio de un lado forma una "C": exterior d = 2 cierra la
    # ranura (2 < 2d) pero deja la cavidad interior encerrada -> un hueco nuevo. La cavidad es 30 x 30 (5..35) menos 2 d por lado = 26 x 26.
    c_shape = _polygon([(0, 0), (40, 0), (40, 40), (21, 40), (21, 35), (35, 35), (35, 5), (5, 5), (5, 35), (19, 35), (19, 40), (0, 40)])

    item = _offset(c_shape, 2, join="mitre")

    assert (item["holes_before"], item["holes_after"]) == (0, 1)
    hole = Polygon(item["geometries"][0]["coordinates"][1])
    assert hole.area == pytest.approx(26.0 * 26.0, abs=1e-6)


# ---- Piezas: división, pérdida parcial, fusión ----

# Dos cuadrados de 20 x 20 (0..20 y 30..50) unidos por un cuello de 4 de alto (y 8..12).
_DUMBBELL = _polygon([(0, 0), (20, 0), (20, 8), (30, 8), (30, 0), (50, 0), (50, 20), (30, 20), (30, 12), (20, 12), (20, 20), (0, 20)])


def test_mancuerna_se_parte_en_dos_piezas_con_el_offset_interior_y_lo_informa():
    # Cuello de 4: con d = 3 (2d = 6 > 4) desaparece y quedan dos cuadrados de 14 x 14 (3..17 y 33..47): 196 cada uno.
    item = _offset(_DUMBBELL, -3, join="mitre")

    assert item["split_count"] == 2
    assert item["pieces_before"] == 1 and item["lost_pieces"] == 0
    assert item["collapsed"] is False
    assert [_area(piece) for piece in item["geometries"]] == pytest.approx([196.0, 196.0], abs=1e-6)
    assert [Polygon(piece["coordinates"][0]).bounds for piece in item["geometries"]] == pytest.approx([(3.0, 3.0, 17.0, 17.0), (33.0, 3.0, 47.0, 17.0)])


def test_mancuerna_con_offset_interior_menor_que_la_mitad_del_cuello_sigue_en_una_pieza():
    # d = 1 (2d = 2 < 4): el cuello sobrevive con 2 de alto.
    item = _offset(_DUMBBELL, -1, join="mitre")

    assert item["split_count"] == 1
    assert item["collapsed"] is False


def test_mancuerna_con_offset_exterior_nunca_se_parte():
    item = _offset(_DUMBBELL, 3, join="mitre")

    assert item["split_count"] == 1 and item["pieces_before"] == 1


def test_un_subject_con_dos_piezas_pierde_la_chica_y_conserva_la_grande_sin_estar_colapsado():
    # Un cuadrado de 40 y otro de 4 (lejos). Interior d = 3: el de 4 desaparece (4 < 6); el grande queda de 34 x 34 = 1156.
    two_islands = _polygon(_rect(0, 0, 40, 40), _rect(100, 0, 4, 4))

    item = _offset(two_islands, -3, join="mitre")

    assert item["pieces_before"] == 2
    assert item["lost_pieces"] == 1
    assert item["collapsed"] is False
    assert item["split_count"] == 1
    assert _total_area(item) == pytest.approx(1156.0, abs=1e-6)


def test_dos_piezas_que_se_funden_con_el_offset_exterior_son_una_sola_y_no_cuentan_como_division():
    # Dos cuadrados de 10 separados por un hueco de 4 (0..10 y 14..24): con d = 3 se tocan y se funden en una pieza.
    two_squares = _polygon(_rect(0, 0, 10, 10), _rect(14, 0, 10, 10))

    item = _offset(two_squares, 3, join="mitre")

    assert item["pieces_before"] == 2
    assert item["split_count"] == 1
    assert item["lost_pieces"] == 0
    assert _total_area(item) == pytest.approx((24 + 6) * (10 + 6), abs=1e-6)


def test_un_mono_autointersecado_se_normaliza_antes_de_desplazar():
    # Un "moño" (0,0)-(10,10)-(10,0)-(0,10) son dos triángulos que se tocan en (5,5): 2 piezas antes, y válidas después.
    bowtie = _polygon([(0, 0), (10, 10), (10, 0), (0, 10)])

    item = _offset(bowtie, 1, join="mitre")

    assert item["pieces_before"] == 2
    assert item["split_count"] == 1  # se funden: la unión de los dos offsets
    assert Polygon(item["geometries"][0]["coordinates"][0]).is_valid


# ---- Líneas ----


def test_linea_abierta_con_cap_plano_es_largo_por_2d():
    # (0,0)-(10,0), d = 1: rectángulo de 10 x 2 = 20.
    item = _offset(_line((0, 0), (10, 0)), 1, cap="flat")

    assert _area(item["geometries"][0]) == pytest.approx(20.0, abs=1e-6)
    assert Polygon(item["geometries"][0]["coordinates"][0]).bounds == pytest.approx((0.0, -1.0, 10.0, 1.0))


def test_linea_abierta_con_cap_cuadrado_extiende_d_en_cada_extremo():
    # (10 + 2·1) x 2 = 24.
    item = _offset(_line((0, 0), (10, 0)), 1, cap="square")

    assert _area(item["geometries"][0]) == pytest.approx(24.0, abs=1e-6)
    assert Polygon(item["geometries"][0]["coordinates"][0]).bounds == pytest.approx((-1.0, -1.0, 11.0, 1.0))


def test_linea_abierta_con_cap_redondo_suma_un_circulo_en_los_extremos():
    # 10 x 2 + π·1² = 23,14159... dentro de la tolerancia de los arcos (déficit <= 2π d · tolerancia).
    exact = 10 * 2 + math.pi
    item = _offset(_line((0, 0), (10, 0)), 1, cap="round")

    area = _area(item["geometries"][0])
    assert area < exact
    assert exact - area <= 2 * math.pi * 1 * TOLERANCE
    assert Polygon(item["geometries"][0]["coordinates"][0]).bounds == pytest.approx((-1.0, -1.0, 11.0, 1.0))


def test_linea_con_codo_respeta_el_join_en_el_lado_externo_del_codo():
    # L de 10 + 10, d = 1, extremos planos: tramo horizontal x 0..11 (11 con la esquina externa en inglete) x y -1..1 = 22 y tramo vertical
    # x 9..11 x y 1..10 = 18 -> 40. Con bisel la esquina externa pierde un triángulo de catetos d (1/2): 39,5.
    elbow = _line((0, 0), (10, 0), (10, 10))

    mitre = _area(_offset(elbow, 1, join="mitre", cap="flat")["geometries"][0])
    bevel = _area(_offset(elbow, 1, join="bevel", cap="flat")["geometries"][0])

    assert mitre == pytest.approx(40.0, abs=1e-6)
    assert bevel == pytest.approx(39.5, abs=1e-6)


def test_polilinea_cerrada_se_desplaza_a_ambos_lados_y_deja_un_anillo_con_hueco():
    # Contorno cuadrado de 10 (cerrado repitiendo el primer vértice), d = 1, inglete: fuera 12 x 12, hueco 8 x 8 -> 144 - 64 = 80.
    outline = _line((0, 0), (10, 0), (10, 10), (0, 10), (0, 0))

    item = _offset(outline, 1, join="mitre", cap="flat")

    assert _total_area(item) == pytest.approx(80.0, abs=1e-6)
    assert item["holes_after"] == 1 and item["holes_before"] == 0
    assert len(item["geometries"][0]["coordinates"]) == 2


def test_una_linea_con_distancia_interior_se_rechaza_en_vez_de_reinterpretarse():
    with pytest.raises(InvalidParametersError, match="línea"):
        run_offset([_line((0, 0), (10, 0))], -1.0, "round", 2.0, "round", TOLERANCE)


def test_un_poligono_acompanado_de_una_linea_con_distancia_interior_se_rechaza_entero():
    with pytest.raises(InvalidParametersError):
        run_offset([_polygon(_rect(0, 0, 40, 20)), _line((0, 0), (10, 0))], -1.0, "round", 2.0, "round", TOLERANCE)


def test_el_cap_no_afecta_a_los_poligonos():
    rectangle = _polygon(_rect(0, 0, 40, 20))

    assert _offset(rectangle, 3, join="mitre", cap="flat") == _offset(rectangle, 3, join="mitre", cap="square")


# ---- Inglete y su límite ----

# Triángulo agudo: base 10 (0..10) y ápice (5, 50). Semiángulo del ápice = atan(5/50) = 5,71°; la razón del inglete es 1/sin(semiángulo) = 10,05.
_ACUTE = _polygon([(0, 0), (10, 0), (5, 50)])
_MITRE_RATIO = 1 / math.sin(math.atan2(5, 50))


def _top(item: dict) -> float:
    return Polygon(item["geometries"][0]["coordinates"][0]).bounds[3]


def test_inglete_de_un_angulo_agudo_respeta_el_limite_y_recorta_la_punta():
    # Con d = 1 la punta completa llegaría a 50 + 10,05·1 = 60,05; el límite recorta la punta en 50 + límite·d.
    assert _top(_offset(_ACUTE, 1, join="mitre", mitre_limit=2.0)) == pytest.approx(52.0, abs=1e-6)
    assert _top(_offset(_ACUTE, 1, join="mitre", mitre_limit=5.0)) == pytest.approx(55.0, abs=1e-6)
    assert _top(_offset(_ACUTE, 1, join="mitre", mitre_limit=9.9)) == pytest.approx(59.9, abs=1e-6)


def test_inglete_con_limite_mayor_que_la_razon_conserva_la_punta_completa():
    top = 50 + _MITRE_RATIO * 1
    assert _top(_offset(_ACUTE, 1, join="mitre", mitre_limit=10.1)) == pytest.approx(top, abs=1e-6)
    assert _top(_offset(_ACUTE, 1, join="mitre", mitre_limit=50.0)) == pytest.approx(top, abs=1e-6)


def test_inglete_sin_recorte_da_el_triangulo_semejante_con_inradio_r_mas_d():
    # El offset exterior con inglete de un triángulo es otro triángulo semejante de inradio r + d: área = A·((r + d)/r)².
    # A = 250, perímetro = 10 + 2·hypot(5, 50), r = 2A/perímetro.
    area = 250.0
    perimeter = 10 + 2 * math.hypot(5, 50)
    inradius = 2 * area / perimeter
    expected = area * ((inradius + 1) / inradius) ** 2

    item = _offset(_ACUTE, 1, join="mitre", mitre_limit=20.0)

    assert _total_area(item) == pytest.approx(expected, abs=1e-6)


def test_un_limite_de_inglete_mas_bajo_nunca_agranda_el_resultado():
    areas = [_total_area(_offset(_ACUTE, 1, join="mitre", mitre_limit=limit)) for limit in (1.0, 2.0, 5.0, 10.1)]

    assert areas == sorted(areas)
    assert areas[0] < areas[-1]


def test_el_limite_de_inglete_no_cambia_nada_con_round_ni_con_bisel():
    for join in ("round", "bevel"):
        assert _offset(_ACUTE, 1, join=join, mitre_limit=1.0) == _offset(_ACUTE, 1, join=join, mitre_limit=50.0)


# ---- Resolución de arcos ----


def test_los_arcos_redondos_se_desvian_de_la_distancia_pedida_a_lo_sumo_la_tolerancia():
    # Cuadrado de 10, d = 5, tolerancia 0,05: todo punto del borde del resultado está a distancia d de la forma, o hasta `tolerancia` menos (la flecha del arco).
    tolerance = 0.05
    item = _offset(_polygon(_rect(0, 0, 10, 10)), 5, join="round", tolerance=tolerance)
    source = Polygon(_rect(0, 0, 10, 10))
    boundary = Polygon(item["geometries"][0]["coordinates"][0]).exterior.segmentize(0.01)

    distances = [source.distance(Point(point)) for point in boundary.coords]

    assert max(distances) <= 5 + 1e-9
    assert min(distances) >= 5 - tolerance - 1e-9


def test_una_tolerancia_mas_fina_usa_mas_vertices_y_una_mas_gruesa_menos():
    rectangle = _polygon(_rect(0, 0, 10, 10))
    fine = len(_offset(rectangle, 5, tolerance=0.001)["geometries"][0]["coordinates"][0])
    coarse = len(_offset(rectangle, 5, tolerance=1.0)["geometries"][0]["coordinates"][0])

    assert fine > coarse >= 4 * 2


def test_la_resolucion_de_los_arcos_esta_acotada_aunque_la_distancia_sea_enorme():
    # d = 1e6 con tolerancia 1e-3 pediría ~100 000 segmentos por cuarto: el tope MAX_QUAD_SEGS lo acota.
    assert _arc_resolution(1_000_000.0, 0.001) == MAX_QUAD_SEGS
    item = _offset(_polygon(_rect(0, 0, 10, 10)), 1_000_000.0, tolerance=0.001)

    assert len(item["geometries"][0]["coordinates"][0]) <= 4 * MAX_QUAD_SEGS + 8
    assert _area(item["geometries"][0]) == pytest.approx(math.pi * 1_000_000.0**2, rel=1e-3)


# ---- Winding, determinismo, canon de salida ----


def test_el_sentido_de_giro_de_los_anillos_no_cambia_el_resultado():
    # Exterior horario/antihorario y hueco horario/antihorario: las cuatro combinaciones dan lo mismo (regla par-impar).
    outer = _rect(0, 0, 40, 40)
    hole = _rect(10, 10, 20, 20)
    variants = [
        _polygon(outer, hole),
        _polygon(outer[::-1], hole),
        _polygon(outer, hole[::-1]),
        _polygon(outer[::-1], hole[::-1]),
    ]

    for distance in (2, -2):
        outcomes = [json.dumps(_offset(variant, distance, join="mitre")) for variant in variants]
        assert len(set(outcomes)) == 1, distance


def test_el_vertice_de_inicio_de_los_anillos_no_cambia_el_resultado():
    base = _rect(0, 0, 40, 20)
    rotated = base[2:] + base[:2]

    assert _offset(_polygon(base), 3, join="round") == _offset(_polygon(rotated), 3, join="round")
    assert _offset(_polygon(base), -3, join="round") == _offset(_polygon(rotated), -3, join="round")


def test_determinismo_byte_a_byte_entre_corridas_repetidas():
    subjects = [_polygon(_rect(0, 0, 40, 40), _rect(10, 10, 20, 20)), _DUMBBELL, _circle(10.0, 90), _line((0, 0), (10, 5), (20, 0))]

    first = json.dumps(run_offset(subjects, 2.5, "round", 2.0, "round", TOLERANCE))
    second = json.dumps(run_offset(subjects, 2.5, "round", 2.0, "round", TOLERANCE))

    assert first == second


def test_cada_subject_se_resuelve_igual_solo_que_acompanado_y_en_su_posicion():
    subjects = [_polygon(_rect(0, 0, 40, 20)), _DUMBBELL, _polygon(_rect(100, 100, 6, 6))]

    together = run_offset(subjects, -2.0, "mitre", 2.0, "round", TOLERANCE)["results"]

    for index, subject in enumerate(subjects):
        alone = run_offset([subject], -2.0, "mitre", 2.0, "round", TOLERANCE)["results"][0]
        assert together[index]["subject_index"] == index
        assert {**together[index], "subject_index": 0} == alone


def test_la_salida_es_canonica_anillos_cerrados_exterior_antihorario_huecos_horarios_y_sin_nan():
    item = _offset(_polygon(_rect(0, 0, 40, 40), _rect(10, 10, 20, 20)), 2, join="mitre")

    piece = item["geometries"][0]
    exterior, hole = piece["coordinates"]
    assert exterior[0] == exterior[-1] and hole[0] == hole[-1]
    assert _signed(exterior) > 0 > _signed(hole)
    assert exterior[0] == min(exterior[:-1]) and hole[0] == min(hole[:-1])
    assert all(math.isfinite(value) for ring in piece["coordinates"] for point in ring for value in point)
    assert Polygon(exterior, [hole]).is_valid


def test_las_piezas_salen_ordenadas_por_sus_coordenadas():
    item = _offset(_DUMBBELL, -3)

    coordinates = [piece["coordinates"] for piece in item["geometries"]]
    assert coordinates == sorted(coordinates)


# ---- Entradas degeneradas y errores ----


def test_un_anillo_sin_area_no_tiene_nada_que_desplazar_y_se_informa_como_colapsado():
    item = _offset(_polygon([(0, 0), (5, 0), (10, 0)]), 2)

    assert item["collapsed"] is True
    assert item["geometries"] == []
    assert item["pieces_before"] == 0
    assert item["max_inward_offset"] == 0.0


def test_una_linea_de_un_solo_punto_distinto_no_tiene_nada_que_desplazar():
    item = _offset(_line((3, 3), (3, 3)), 2)

    assert item["collapsed"] is True and item["geometries"] == []
    assert item["max_inward_offset"] is None


def test_los_vertices_repetidos_y_el_cierre_explicito_no_cambian_el_resultado():
    clean = _polygon(_rect(0, 0, 40, 20))
    dirty = _polygon([(0, 0), (0, 0), (40, 0), (40, 0), (40, 20), (0, 20), (0, 20), (0, 0)])

    assert _offset(dirty, 3, join="mitre") == _offset(clean, 3, join="mitre")


@pytest.mark.parametrize("distance", [0.0, math.nan, math.inf, -math.inf])
def test_distancia_cero_o_no_finita_se_rechaza(distance):
    with pytest.raises(InvalidParametersError):
        run_offset([_polygon(_rect(0, 0, 4, 4))], distance, "round", 2.0, "round", TOLERANCE)


def test_join_cap_inglete_y_tolerancia_invalidos_se_rechazan():
    subject = [_polygon(_rect(0, 0, 4, 4))]
    for join, cap, mitre, tolerance in [
        ("miter", "round", 2.0, TOLERANCE),
        ("round", "butt", 2.0, TOLERANCE),
        ("mitre", "round", 0.0, TOLERANCE),
        ("mitre", "round", -1.0, TOLERANCE),
        ("mitre", "round", math.nan, TOLERANCE),
        ("round", "round", 2.0, 0.0),
        ("round", "round", 2.0, math.nan),
    ]:
        with pytest.raises(InvalidParametersError):
            run_offset(subject, 1.0, join, mitre, cap, tolerance)


# ---- Rendimiento ----


def test_cientos_de_subjects_se_desplazan_en_un_tiempo_razonable():
    subjects = [_polygon(_rect(i * 30, j * 30, 20, 20)) for i in range(25) for j in range(20)]  # 500 cuadrados

    started = time.perf_counter()
    results = run_offset(subjects, 2.0, "round", 2.0, "round", TOLERANCE)["results"]
    elapsed = time.perf_counter() - started

    assert len(results) == 500
    assert all(len(item["geometries"]) == 1 for item in results)
    assert elapsed < 10.0
