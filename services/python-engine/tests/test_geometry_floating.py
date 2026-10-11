"""Tests del núcleo puro de piezas flotantes y bridges (M3-S11, app.core.geometry_floating). Fixtures sintéticos tipo dataset (letras A, O, R, stencil con
varias islas, isla anidada) y TODOS los valores esperados (conteos, áreas, largos) calculados A MANO a partir de las coordenadas de cada caso -- ver el
comentario de cada test --, no copiados de la salida del código: un análisis roto (que cuente mal los huecos, que confunda los dos modos, que ignore la
contención) o un bridge roto (que no cruce, que reste de menos, que modifique un bloqueado) tiene que hacer fallar estos tests.
"""

import json
import time

import pytest
from shapely.geometry import Polygon
from shapely.ops import unary_union

from app.core.errors import InvalidParametersError
from app.core.geometry_floating import run_bridges, run_floating

TOLERANCE = 0.01


def _poly(*rings: list[tuple[float, float]], locked: bool = False) -> dict:
    subject = {"type": "polygon", "coordinates": [list(ring) for ring in rings]}
    if locked:
        subject["locked"] = True
    return subject


def _rect(x: float, y: float, width: float, height: float) -> list[tuple[float, float]]:
    return [(x, y), (x + width, y), (x + width, y + height), (x, y + height)]


def _reversed(subject: dict) -> dict:
    """El mismo subject con el sentido de giro de TODOS sus anillos invertido (la regla par-impar no depende del giro)."""
    return {**subject, "coordinates": [list(reversed(ring)) for ring in subject["coordinates"]]}


def _analyze(subjects: list[dict], mode: str = "stencil", tolerance: float = TOLERANCE) -> dict:
    return run_floating(subjects, mode, tolerance)


def _floating(result: dict) -> list[dict]:
    return [component for component in result["components"] if component["kind"] == "floating"]


def _bridge(subjects: list[dict], mode: str, bridges: list[dict], *, suggest: bool = False, suggest_width: float | None = None, tolerance: float = TOLERANCE) -> dict:
    return run_bridges(subjects, mode, bridges, suggest, suggest_width, tolerance)


def _area(piece: dict) -> float:
    rings = piece["coordinates"]
    return Polygon(rings[0], rings[1:]).area


def _result_area(result: dict) -> float:
    return sum(_area(piece) for piece in result["geometries"])


def _union_area(subjects: list[dict], outcome: dict) -> float:
    """Área de la unión de la geometría RESULTANTE (cambiadas con sus piezas nuevas, el resto tal cual)."""
    shapes = []
    for subject, result in zip(subjects, outcome["results"]):
        if result["changed"]:
            shapes.extend(Polygon(piece["coordinates"][0], piece["coordinates"][1:]) for piece in result["geometries"])
        else:
            shapes.append(Polygon(subject["coordinates"][0], subject["coordinates"][1:]))
    return unary_union(shapes).area


def _after_subjects(subjects: list[dict], outcome: dict) -> list[dict]:
    """Los subjects tal como quedan tras aplicar el resultado: lo que el cliente le mandaría a un análisis INDEPENDIENTE del resultado."""
    after: list[dict] = []
    for subject, result in zip(subjects, outcome["results"]):
        if result["changed"]:
            after.extend({"type": "polygon", "coordinates": piece["coordinates"]} for piece in result["geometries"])
        else:
            after.append(subject)
    return after


# ---- Letras del dataset (todas se comprueban válidas: un fixture inválido no probaría nada) ----

# "O": rectángulo 20 x 30 con contra-forma 10 x 20 (área 200).
LETTER_O = _poly(_rect(0, 0, 20, 30), _rect(5, 5, 10, 20))
# "A": silueta con el travesaño y la contra-forma TRIANGULAR (base 3, altura 8 => área 12); el hueco entre las patas está abierto al exterior.
LETTER_A = _poly(
    [(0, 0), (5, 0), (6, 8), (14, 8), (15, 0), (20, 0), (12, 30), (8, 30)],
    [(8.5, 14), (11.5, 14), (10, 22)],
)
# "R": pata, panza y contra-forma trapezoidal ((7 + 8) / 2 · 6 = 45).
LETTER_R = _poly(
    [(0, 0), (5, 0), (5, 12), (8, 12), (13, 0), (19, 0), (12, 13), (18, 17), (18, 25), (14, 30), (0, 30)],
    [(5, 18), (12, 18), (13, 24), (5, 24)],
)
# "B": dos contra-formas. "L": sin huecos.
LETTER_B = _poly(_rect(0, 0, 20, 30), _rect(5, 3, 10, 10), _rect(5, 17, 10, 10))
LETTER_L = _poly([(0, 0), (20, 0), (20, 5), (5, 5), (5, 30), (0, 30)])

# Anillo cuadrado de 20 con hueco de 10 centrado: como CORTE (stencil) su isla es el cuadrado 5..15; como MATERIAL (parts) es una "O" cuadrada.
RING = _poly(_rect(0, 0, 20, 20), _rect(5, 5, 10, 10))


@pytest.mark.parametrize("subject", [LETTER_O, LETTER_A, LETTER_R, LETTER_B, LETTER_L])
def test_las_letras_del_dataset_son_poligonos_validos(subject):
    polygon = Polygon(subject["coordinates"][0], subject["coordinates"][1:])
    assert polygon.is_valid and polygon.area > 0


# ---- Plantilla (stencil): la contra-forma es una isla ----


@pytest.mark.parametrize(
    ("letter", "islands", "island_area"),
    [(LETTER_O, 1, 200.0), (LETTER_A, 1, 12.0), (LETTER_R, 1, 45.0), (LETTER_B, 2, 100.0), (LETTER_L, 0, 0.0)],
)
def test_stencil_cuenta_las_contra_formas_por_letra(letter, islands, island_area):
    result = _analyze([letter], "stencil")

    assert result["floating_count"] == islands == len(_floating(result))
    assert result["main_count"] == 1  # la hoja, siempre una sola
    assert [component["area"] for component in _floating(result)] == pytest.approx([island_area] * islands, abs=1e-9)
    assert result["discarded"] == 0


def test_stencil_la_hoja_es_el_principal_sin_poligono_y_la_isla_cuelga_de_ella():
    result = _analyze([LETTER_O], "stencil")

    sheet, island = result["components"]
    assert (sheet["id"], sheet["kind"], sheet["depth"], sheet["parent"], sheet["polygon"], sheet["area"]) == (0, "principal", 0, None, None, None)
    assert sheet["bounds"] == [0.0, 0.0, 20.0, 30.0]
    assert (island["id"], island["kind"], island["depth"], island["parent"]) == (1, "floating", 1, 0)
    assert island["bounds"] == [5.0, 5.0, 15.0, 25.0]
    assert island["polygon"]["type"] == "polygon" and len(island["polygon"]["coordinates"]) == 1  # una isla sin nada adentro: sin huecos
    assert island["subjects"] == [0]


def test_stencil_la_isla_de_la_letra_a_es_exactamente_el_triangulo_de_la_contra_forma():
    island = _floating(_analyze([LETTER_A], "stencil"))[0]

    assert sorted(map(tuple, island["polygon"]["coordinates"][0][:-1])) == [(8.5, 14.0), (10.0, 22.0), (11.5, 14.0)]
    assert island["bounds"] == [8.5, 14.0, 11.5, 22.0]


def test_stencil_con_varias_islas_cuenta_exacto_y_cada_una_con_su_area():
    # Plancha 70 x 40 con 6 huecos de 15 x 12 (3 columnas x 2 filas): 6 islas de 180 cada una.
    holes = [_rect(5 + 22 * column, 5 + 18 * row, 15, 12) for row in range(2) for column in range(3)]
    plate = _poly(_rect(0, 0, 70, 40), *holes)

    result = _analyze([plate], "stencil")

    assert result["floating_count"] == 6
    assert [component["area"] for component in _floating(result)] == pytest.approx([180.0] * 6, abs=1e-9)
    assert {component["depth"] for component in _floating(result)} == {1}
    assert {component["parent"] for component in _floating(result)} == {0}


def test_stencil_el_hueco_aparece_al_unir_varias_formas_y_no_en_cada_una():
    # Una "U" y una barra que la cierra por arriba: solas no encierran nada; juntas encierran el cuadrado 5..25 x 5..25 (20 x 20 = 400).
    u_shape = _poly([(0, 0), (30, 0), (30, 30), (25, 30), (25, 5), (5, 5), (5, 30), (0, 30)])
    bar = _poly(_rect(0, 25, 30, 5))

    assert _analyze([u_shape], "stencil")["floating_count"] == 0
    assert _analyze([bar], "stencil")["floating_count"] == 0
    joint = _analyze([u_shape, bar], "stencil")

    assert joint["floating_count"] == 1
    island = _floating(joint)[0]
    assert island["area"] == pytest.approx(400.0, abs=1e-9)
    assert island["subjects"] == [0, 1]  # las dos formas bordean la isla


def test_stencil_isla_anidada_un_corte_dentro_de_la_isla_no_la_conecta_y_su_hueco_es_otra_isla():
    # Anillo 40 x 40 con hueco 30 x 30 (isla 1) y, DENTRO de esa isla, otro anillo 20 x 20 con hueco 10 x 10 (isla 2).
    outer = _poly(_rect(0, 0, 40, 40), _rect(5, 5, 30, 30))
    inner = _poly(_rect(10, 10, 20, 20), _rect(15, 15, 10, 10))

    result = _analyze([outer, inner], "stencil")

    assert result["floating_count"] == 2
    shallow, deep = _floating(result)
    assert (shallow["depth"], shallow["parent"]) == (1, 0)
    assert (deep["depth"], deep["parent"]) == (2, shallow["id"])
    # La isla 1 es el hueco 30 x 30 menos el anillo interno 20 x 20 (500); la 2 es el hueco 10 x 10 (100).
    assert shallow["area"] == pytest.approx(500.0, abs=1e-9)
    assert deep["area"] == pytest.approx(100.0, abs=1e-9)
    assert len(shallow["polygon"]["coordinates"]) == 2  # el corte interno es un hueco de la isla 1


def test_stencil_un_corte_macizo_dentro_de_la_isla_no_cambia_el_conteo():
    outer = _poly(_rect(0, 0, 40, 40), _rect(5, 5, 30, 30))
    solid_cut = _poly(_rect(10, 10, 20, 20))

    result = _analyze([outer, solid_cut], "stencil")

    assert result["floating_count"] == 1
    assert _floating(result)[0]["area"] == pytest.approx(500.0, abs=1e-9)


def test_stencil_forma_sin_huecos_o_dos_cortes_separados_no_tienen_flotantes():
    result = _analyze([_poly(_rect(0, 0, 10, 10)), _poly(_rect(30, 0, 10, 10))], "stencil")

    assert result["floating_count"] == 0 and result["main_count"] == 1
    assert [component["kind"] for component in result["components"]] == ["principal"]


# ---- Piezas (parts): contención ----


def test_parts_el_punto_dentro_de_una_o_es_flotante():
    dot = _poly(_rect(8, 12, 4, 4))

    result = _analyze([LETTER_O, dot], "parts")

    assert result["floating_count"] == 1 and result["main_count"] == 1
    body, floating = result["components"]
    assert (body["kind"], body["depth"], body["parent"], body["area"]) == ("principal", 0, None, pytest.approx(400.0))
    assert (floating["kind"], floating["depth"], floating["parent"], floating["area"]) == ("floating", 1, 0, pytest.approx(16.0))
    assert body["subjects"] == [0] and floating["subjects"] == [1]


@pytest.mark.parametrize("letter", [LETTER_O, LETTER_A, LETTER_R, LETTER_B])
def test_parts_una_letra_sola_no_tiene_flotantes_su_contra_forma_es_vacio(letter):
    result = _analyze([letter], "parts")

    assert result["floating_count"] == 0 and result["main_count"] == 1


def test_parts_dos_componentes_disjuntos_sin_contencion_no_son_flotantes():
    result = _analyze([_poly(_rect(0, 0, 10, 10)), _poly(_rect(20, 0, 10, 10))], "parts")

    assert result["floating_count"] == 0 and result["main_count"] == 2
    assert all(component["kind"] == "principal" and component["depth"] == 0 for component in result["components"])


def test_parts_un_punto_que_toca_el_borde_de_la_o_se_funde_con_ella_y_no_flota():
    touching = _poly(_rect(5, 10, 4, 4))  # comparte el borde x = 5 con el hueco de la O

    result = _analyze([LETTER_O, touching], "parts")

    assert result["floating_count"] == 0 and result["main_count"] == 1


def test_parts_profundidad_anillo_dentro_de_anillo_con_punto_adentro():
    outer = _poly(_rect(0, 0, 40, 40), _rect(5, 5, 30, 30))
    middle = _poly(_rect(10, 10, 20, 20), _rect(15, 15, 10, 10))
    dot = _poly(_rect(18, 18, 4, 4))

    result = _analyze([outer, middle, dot], "parts")

    assert result["floating_count"] == 2 and result["main_count"] == 1
    body, ring, point = result["components"]
    assert [(c["kind"], c["depth"]) for c in (body, ring, point)] == [("principal", 0), ("floating", 1), ("floating", 2)]
    assert (ring["parent"], point["parent"]) == (body["id"], ring["id"])
    assert (ring["area"], point["area"]) == (pytest.approx(300.0), pytest.approx(16.0))  # 20² − 10² y 4²


def test_parts_forma_sin_huecos_no_tiene_flotantes():
    result = _analyze([LETTER_L], "parts")

    assert result["floating_count"] == 0 and result["main_count"] == 1


def test_los_dos_modos_dan_conteos_distintos_para_la_misma_geometria():
    # La "O" sola: como corte su contra-forma es una isla (1); como material no hay nada dentro del hueco (0). Con el punto adentro, al revés de lo que
    # parece: el corte-punto no conecta la isla (1) y como material el punto flota (1).
    assert (_analyze([LETTER_O], "stencil")["floating_count"], _analyze([LETTER_O], "parts")["floating_count"]) == (1, 0)
    with_dot = [LETTER_O, _poly(_rect(8, 12, 4, 4))]
    assert (_analyze(with_dot, "stencil")["floating_count"], _analyze(with_dot, "parts")["floating_count"]) == (1, 1)


# ---- Invariancias: giro, orden, determinismo ----


@pytest.mark.parametrize("mode", ["stencil", "parts"])
def test_el_sentido_de_giro_de_los_anillos_no_cambia_el_resultado(mode):
    subjects = [LETTER_R, _poly(_rect(7, 20, 3, 3))]

    assert json.dumps(_analyze([_reversed(s) for s in subjects], mode), sort_keys=True) == json.dumps(_analyze(subjects, mode), sort_keys=True)


def test_el_orden_de_los_anillos_de_un_subject_no_importa():
    swapped = {**LETTER_B, "coordinates": [LETTER_B["coordinates"][0], LETTER_B["coordinates"][2], LETTER_B["coordinates"][1]]}

    assert json.dumps(_analyze([swapped]), sort_keys=True) == json.dumps(_analyze([LETTER_B]), sort_keys=True)


@pytest.mark.parametrize("mode", ["stencil", "parts"])
def test_mismas_entradas_mismas_salidas_byte_a_byte(mode):
    subjects = [LETTER_A, LETTER_O, LETTER_R, _poly(_rect(8, 12, 4, 4))]

    first = json.dumps(_analyze(subjects, mode))
    for _ in range(3):
        assert json.dumps(_analyze(subjects, mode)) == first


def test_el_orden_de_los_subjects_cambia_los_indices_pero_no_los_poligonos_ni_los_ids():
    # Dos islas de distinto tamaño en subjects distintos: los ids dependen de la geometría, no del orden en que llegaron.
    first = _poly(_rect(0, 0, 20, 20), _rect(5, 5, 10, 10))
    second = _poly(_rect(40, 0, 20, 20), _rect(45, 5, 6, 6))

    forward = _analyze([first, second])
    backward = _analyze([second, first])

    assert [(c["id"], c["polygon"]) for c in forward["components"]] == [(c["id"], c["polygon"]) for c in backward["components"]]
    assert [c["subjects"] for c in forward["components"]] != [c["subjects"] for c in backward["components"]]


def test_componentes_despreciables_se_descartan_y_se_cuentan():
    # Hueco de 0,005 x 0,005 = 2,5e-5 < tolerancia² (1e-4): no es una isla útil, pero se informa.
    tiny = _poly(_rect(0, 0, 10, 10), _rect(5, 5, 0.005, 0.005))

    result = _analyze([tiny])

    assert result["floating_count"] == 0 and result["discarded"] == 1


def test_un_subject_degenerado_no_aporta_nada_y_sin_geometria_no_hay_componentes():
    flat = _poly([(0, 0), (5, 0), (10, 0)])  # área cero

    result = _analyze([flat], "stencil")

    assert result["components"] == [] and result["floating_count"] == 0 and result["main_count"] == 0


def test_modo_o_tolerancia_invalidos_se_rechazan():
    with pytest.raises(InvalidParametersError):
        _analyze([LETTER_O], "hueco")
    for tolerance in (0, -1, float("nan"), float("inf")):
        with pytest.raises(InvalidParametersError):
            _analyze([LETTER_O], "stencil", tolerance)


def test_muchas_islas_se_analizan_rapido():
    holes = [_rect(2 + 4 * column, 2 + 4 * row, 2, 2) for row in range(12) for column in range(12)]
    plate = _poly(_rect(0, 0, 50, 50), *holes)

    started = time.perf_counter()
    result = _analyze([plate])

    assert result["floating_count"] == 144
    assert time.perf_counter() - started < 5


# ---- Bridges en Plantilla: se RESTA un rectángulo de ancho w que cruza el corte ----


def test_bridge_fino_resta_exactamente_ancho_por_largo_y_conecta_la_isla():
    # Anillo de corte con 5 de espesor (0..5 entre el borde y el hueco): un bridge de 0,8 de ancho quita 0,8 x 5 = 4,0 del corte.
    outcome = _bridge([RING], "stencil", [{"island": 1, "width": 0.8}])

    item = outcome["bridges"][0]
    assert item["valid"] is True and item["reason"] is None and item["reduces"] is True
    assert item["length"] == pytest.approx(5.0, abs=1e-9)
    assert item["area"] == pytest.approx(0.8 * 5.0, abs=1e-9)
    assert item["affects"] == [0] and item["island"] == 1
    assert outcome["reanalysis"] == {"floating_before": 1, "floating_after": 0, "main_after": 1}
    # El anillo (400 − 100 = 300) pierde exactamente lo que dice el bridge.
    assert outcome["results"][0]["changed"] is True
    assert _result_area(outcome["results"][0]) == pytest.approx(300.0 - 4.0, abs=1e-9)


def test_bridge_grueso_resta_proporcionalmente_mas():
    thin = _bridge([RING], "stencil", [{"island": 1, "width": 0.8}])
    thick = _bridge([RING], "stencil", [{"island": 1, "width": 2.5}])

    assert thick["bridges"][0]["area"] == pytest.approx(2.5 * 5.0, abs=1e-9)
    assert _result_area(thick["results"][0]) == pytest.approx(300.0 - 12.5, abs=1e-9)
    assert thick["bridges"][0]["area"] / thin["bridges"][0]["area"] == pytest.approx(2.5 / 0.8)
    assert thick["reanalysis"]["floating_after"] == 0


def test_el_rectangulo_del_bridge_es_ancho_por_largo_mas_el_solape_en_cada_extremo():
    item = _bridge([RING], "stencil", [{"island": 1, "width": 0.8}])["bridges"][0]

    # Largo del hueco (5) + 2 · (2 · tolerancia) de solape; ancho 0,8.
    assert _area(item["polygon"]) == pytest.approx(0.8 * (5.0 + 2 * 2 * TOLERANCE), abs=1e-9)
    assert (item["direction"]["x"], item["direction"]["y"]) in {(1.0, 0.0), (-1.0, 0.0), (0.0, 1.0), (0.0, -1.0)}  # perpendicular al borde


def test_la_sugerencia_va_en_el_punto_medio_del_borde_y_perpendicular():
    item = _bridge([RING], "stencil", [{"island": 1, "width": 1.0}])["bridges"][0]

    anchor = (item["anchor"]["x"], item["anchor"]["y"])
    assert anchor in {(15.0, 10.0), (5.0, 10.0), (10.0, 5.0), (10.0, 15.0)}  # punto medio de uno de los 4 lados de la isla


def test_ancla_manual_sobre_el_borde_cruza_perpendicular_con_el_ancho_pedido():
    # Click sobre el borde derecho de la isla (x = 15) a y = 7: sin dirección, sale hacia afuera (+x) y cruza los 5 de espesor.
    outcome = _bridge([RING], "stencil", [{"anchor": {"x": 15.0, "y": 7.0}, "width": 2.0}])

    item = outcome["bridges"][0]
    assert item["valid"] is True and item["island"] == 1
    assert (item["direction"]["x"], item["direction"]["y"]) == (1.0, 0.0)
    assert item["length"] == pytest.approx(5.0, abs=1e-9) and item["area"] == pytest.approx(10.0, abs=1e-9)
    assert _result_area(outcome["results"][0]) == pytest.approx(290.0, abs=1e-9)


def test_ancla_dentro_de_la_tolerancia_se_ajusta_al_borde_y_fuera_se_rechaza():
    near = _bridge([RING], "stencil", [{"anchor": {"x": 15.005, "y": 7.0}, "width": 1.0}])["bridges"][0]
    far = _bridge([RING], "stencil", [{"anchor": {"x": 15.5, "y": 7.0}, "width": 1.0}])["bridges"][0]
    outside = _bridge([RING], "stencil", [{"anchor": {"x": 50.0, "y": 50.0}, "width": 1.0}])["bridges"][0]

    assert near["valid"] is True and near["anchor"]["x"] == 15.0  # se ajustó al borde
    assert (far["valid"], far["reason"]) == (False, "anchor_outside")
    assert (outside["valid"], outside["reason"]) == (False, "anchor_outside")


def test_direccion_explicita_hacia_afuera_cruza_y_hacia_adentro_no():
    up = _bridge([RING], "stencil", [{"anchor": {"x": 10.0, "y": 15.0}, "direction": {"x": 0.0, "y": 3.0}, "width": 1.0}])["bridges"][0]
    inward = _bridge([RING], "stencil", [{"anchor": {"x": 10.0, "y": 15.0}, "direction": {"x": 0.0, "y": -1.0}, "width": 1.0}])["bridges"][0]
    zero = _bridge([RING], "stencil", [{"anchor": {"x": 10.0, "y": 15.0}, "direction": {"x": 0.0, "y": 0.0}, "width": 1.0}])["bridges"][0]

    assert up["valid"] is True and up["direction"] == {"x": 0.0, "y": 1.0}  # se normaliza
    assert up["length"] == pytest.approx(5.0, abs=1e-9)
    assert (inward["valid"], inward["reason"]) == (False, "no_crossing")
    assert (zero["valid"], zero["reason"]) == (False, "invalid_direction")


def test_bridge_corto_o_con_largo_insuficiente_es_invalido_y_no_cambia_nada():
    # Largo explícito de 4 < 5 del hueco: queda corto, no abre el puente.
    outcome = _bridge([RING], "stencil", [{"island": 1, "width": 1.0, "length": 4.0}])

    item = outcome["bridges"][0]
    assert (item["valid"], item["reason"], item["reduces"]) == (False, "too_short", False)
    assert item["polygon"] is not None  # se dibuja igual para que el usuario vea que queda corto
    assert outcome["results"][0] == {"subject_index": 0, "changed": False, "geometries": []}
    assert outcome["reanalysis"] == {"floating_before": 1, "floating_after": 1, "main_after": 1}


def test_bridge_con_el_largo_justo_es_valido():
    outcome = _bridge([RING], "stencil", [{"island": 1, "width": 1.0, "length": 5.0}])

    assert outcome["bridges"][0]["valid"] is True
    assert outcome["reanalysis"]["floating_after"] == 0


def test_un_bridge_invalido_no_impide_que_otro_valido_reduzca():
    outcome = _bridge(
        [RING],
        "stencil",
        [{"island": 1, "width": 1.0, "length": 1.0}, {"island": 1, "width": 1.0}, {"anchor": {"x": 99.0, "y": 99.0}, "width": 1.0}],
    )

    assert [item["valid"] for item in outcome["bridges"]] == [False, True, False]
    assert [item["reason"] for item in outcome["bridges"]] == ["too_short", None, "anchor_outside"]
    assert outcome["reanalysis"]["floating_after"] == 0
    assert _result_area(outcome["results"][0]) == pytest.approx(300.0 - 5.0, abs=1e-9)  # solo el válido quitó material


def test_ancho_menor_que_la_tolerancia_es_invalido():
    item = _bridge([RING], "stencil", [{"island": 1, "width": 0.005}])["bridges"][0]

    assert (item["valid"], item["reason"]) == (False, "width_below_tolerance")
    assert item["polygon"] is None


def test_isla_inexistente_o_que_no_es_flotante_es_invalida():
    unknown = _bridge([RING], "stencil", [{"island": 7, "width": 1.0}])["bridges"][0]
    sheet = _bridge([RING], "stencil", [{"island": 0, "width": 1.0}])["bridges"][0]  # id 0 = la hoja: no flota

    assert (unknown["valid"], unknown["reason"]) == (False, "unknown_island")
    assert (sheet["valid"], sheet["reason"]) == (False, "unknown_island")


def test_isla_y_ancla_que_no_coinciden_se_rechazan():
    outer = _poly(_rect(0, 0, 40, 40), _rect(5, 5, 30, 30))
    inner = _poly(_rect(10, 10, 20, 20), _rect(15, 15, 10, 10))
    shallow, deep = (c["id"] for c in _floating(_analyze([outer, inner])))

    # El ancla (25, 20) está en el borde de la isla profunda (hueco 15..25) pero se pide la poco profunda.
    wrong = _bridge([outer, inner], "stencil", [{"island": shallow, "anchor": {"x": 25.0, "y": 20.0}, "width": 1.0}])["bridges"][0]
    right = _bridge([outer, inner], "stencil", [{"island": deep, "anchor": {"x": 25.0, "y": 20.0}, "width": 1.0}])["bridges"][0]

    assert (wrong["valid"], wrong["reason"]) == (False, "anchor_outside")
    assert right["valid"] is True and right["island"] == deep and right["length"] == pytest.approx(5.0, abs=1e-9)


def test_varios_bridges_sobre_una_isla_son_validos_pero_solo_el_primero_reduce():
    outcome = _bridge(
        [RING],
        "stencil",
        [{"anchor": {"x": 15.0, "y": 7.0}, "width": 1.0}, {"anchor": {"x": 5.0, "y": 13.0}, "width": 1.5}],
    )

    first, second = outcome["bridges"]
    assert (first["valid"], second["valid"]) == (True, True)
    assert (first["reduces"], second["reduces"]) == (True, False)
    assert (first["area"], second["area"]) == (pytest.approx(5.0), pytest.approx(7.5))
    assert outcome["reanalysis"]["floating_after"] == 0
    assert _result_area(outcome["results"][0]) == pytest.approx(300.0 - 5.0 - 7.5, abs=1e-9)


def test_suggest_completa_las_islas_sin_bridge_valido_y_respeta_las_que_ya_tienen():
    plate = _poly(_rect(0, 0, 70, 20), _rect(5, 5, 15, 10), _rect(27, 5, 15, 10), _rect(49, 5, 15, 10))
    manual = {"anchor": {"x": 20.0, "y": 10.0}, "width": 1.0}  # sobre el borde derecho de la primera isla (5..20): cruza hacia x = 27

    outcome = _bridge([plate], "stencil", [manual], suggest=True, suggest_width=0.5)

    assert [item["suggested"] for item in outcome["bridges"]] == [False, True, True]
    assert all(item["valid"] for item in outcome["bridges"])
    # Las dos sugeridas son de las otras dos islas y llevan el ancho sugerido.
    assert sorted(item["island"] for item in outcome["bridges"][1:]) != []
    assert {item["width"] for item in outcome["bridges"][1:]} == {0.5}
    assert len({item["island"] for item in outcome["bridges"]}) == 3
    assert outcome["reanalysis"]["floating_before"] == 3 and outcome["reanalysis"]["floating_after"] == 0


def test_suggest_sin_ancho_se_rechaza():
    with pytest.raises(InvalidParametersError):
        _bridge([RING], "stencil", [], suggest=True)


def test_suggest_no_repite_una_isla_ya_cubierta_por_un_bridge_valido():
    outcome = _bridge([RING], "stencil", [{"island": 1, "width": 1.0}], suggest=True, suggest_width=1.0)

    assert len(outcome["bridges"]) == 1


def test_el_reanalisis_coincide_con_un_analisis_independiente_del_resultado():
    holes = [_rect(5 + 22 * column, 5 + 18 * row, 15, 12) for row in range(2) for column in range(3)]
    plate = _poly(_rect(0, 0, 70, 40), *holes)
    subjects = [plate]

    # Solo se puentean 4 de las 6 islas: el reanálisis tiene que decir 6 -> 2, y un análisis aparte del resultado también.
    islands = _floating(_analyze(subjects))
    bridges = [{"island": island["id"], "width": 1.0} for island in islands[:4]]
    outcome = _bridge(subjects, "stencil", bridges)

    independent = _analyze(_after_subjects(subjects, outcome), "stencil")
    assert outcome["reanalysis"] == {"floating_before": 6, "floating_after": 2, "main_after": 1}
    assert independent["floating_count"] == outcome["reanalysis"]["floating_after"] == 2
    assert independent["main_count"] == outcome["reanalysis"]["main_after"]


def test_el_reanalisis_en_parts_coincide_con_un_analisis_independiente_del_resultado():
    dots = [_poly(_rect(7, 7, 2, 2)), _poly(_rect(11, 7, 2, 2)), _poly(_rect(7, 12, 2, 2))]
    subjects = [RING, *dots]

    outcome = _bridge(subjects, "parts", [], suggest=True, suggest_width=0.5)

    independent = _analyze(_after_subjects(subjects, outcome), "parts")
    assert outcome["reanalysis"]["floating_before"] == 3
    assert independent["floating_count"] == outcome["reanalysis"]["floating_after"]
    assert independent["main_count"] == outcome["reanalysis"]["main_after"]


# ---- Bloqueados: cuentan para el análisis, no se modifican ----


def _u_and_bar(*, locked_u: bool = False, locked_bar: bool = False) -> list[dict]:
    """Isla 5..25 x 5..25 cerrada por una "U" (sujeto 0) y una barra superior (sujeto 1) que se solapan en las esquinas."""
    u_shape = _poly([(0, 0), (30, 0), (30, 30), (25, 30), (25, 5), (5, 5), (5, 30), (0, 30)], locked=locked_u)
    bar = _poly(_rect(0, 25, 30, 5), locked=locked_bar)
    return [u_shape, bar]


def test_un_bridge_que_necesita_modificar_un_bloqueado_se_rechaza_con_el_motivo():
    subjects = _u_and_bar(locked_bar=True)

    # Cruzando por la barra (arriba de la isla, x = 15): el único material que hay que cortar es el de la barra, bloqueada.
    outcome = _bridge(subjects, "stencil", [{"anchor": {"x": 15.0, "y": 25.0}, "direction": {"x": 0.0, "y": 1.0}, "width": 1.0}])

    item = outcome["bridges"][0]
    assert (item["valid"], item["reason"]) == (False, "locked_subject")
    assert item["affects"] == [1]
    assert [result["changed"] for result in outcome["results"]] == [False, False]
    assert outcome["reanalysis"]["floating_after"] == outcome["reanalysis"]["floating_before"] == 1


def test_un_bloqueado_cuenta_para_el_analisis_pero_no_se_toca_si_el_bridge_cruza_otra_forma():
    subjects = _u_and_bar(locked_u=True)

    # Cruzando por la barra, la "U" bloqueada no se modifica pero igual forma parte de la isla (si no, no habría isla).
    outcome = _bridge(subjects, "stencil", [{"anchor": {"x": 15.0, "y": 25.0}, "direction": {"x": 0.0, "y": 1.0}, "width": 1.0}])

    assert _analyze(subjects)["floating_count"] == 1
    assert outcome["bridges"][0]["valid"] is True and outcome["bridges"][0]["affects"] == [1]
    assert [result["changed"] for result in outcome["results"]] == [False, True]
    assert outcome["results"][0]["geometries"] == []
    assert outcome["reanalysis"]["floating_after"] == 0


def test_por_el_lado_de_la_u_bloqueada_se_rechaza_y_por_el_de_la_barra_se_acepta():
    subjects = _u_and_bar(locked_u=True)

    through_u = _bridge(subjects, "stencil", [{"anchor": {"x": 5.0, "y": 15.0}, "direction": {"x": -1.0, "y": 0.0}, "width": 1.0}])
    through_bar = _bridge(subjects, "stencil", [{"anchor": {"x": 15.0, "y": 25.0}, "direction": {"x": 0.0, "y": 1.0}, "width": 1.0}])

    assert (through_u["bridges"][0]["valid"], through_u["bridges"][0]["reason"]) == (False, "locked_subject")
    assert through_bar["bridges"][0]["valid"] is True


# ---- Bridges en Piezas: se SUMA un rectángulo de ancho w entre la pieza flotante y el cuerpo ----

# "O" 20 x 30 (400) con un punto de 4 x 4 dentro de su hueco 5..15 x 5..25: separaciones 3 a los lados (x 5..8 y 12..15), 7 abajo, 9 arriba.
O_AND_DOT = [LETTER_O, _poly(_rect(8, 12, 4, 4))]


def test_parts_bridge_fino_y_grueso_suman_exactamente_ancho_por_largo():
    for width in (0.5, 1.5):
        outcome = _bridge(O_AND_DOT, "parts", [{"island": 1, "width": width}])

        item = outcome["bridges"][0]
        assert item["valid"] is True and item["reduces"] is True
        assert item["length"] == pytest.approx(3.0, abs=1e-9)  # el hueco más corto: 3
        assert item["area"] == pytest.approx(width * 3.0, abs=1e-9)
        # Unión resultante = O (400) + punto (16) + puente (ancho x 3).
        assert _union_area(O_AND_DOT, outcome) == pytest.approx(416.0 + width * 3.0, abs=1e-9)
        assert outcome["reanalysis"] == {"floating_before": 1, "floating_after": 0, "main_after": 1}


def test_parts_el_bridge_se_suma_a_la_forma_dueña_de_la_pieza_flotante_y_la_otra_queda_igual():
    outcome = _bridge(O_AND_DOT, "parts", [{"island": 1, "width": 1.0}])

    assert outcome["bridges"][0]["affects"] == [1]
    assert [result["changed"] for result in outcome["results"]] == [False, True]
    assert outcome["results"][0]["geometries"] == []


def test_parts_bridge_corto_es_invalido_y_no_agrega_nada():
    outcome = _bridge(O_AND_DOT, "parts", [{"island": 1, "width": 1.0, "length": 2.0}])

    item = outcome["bridges"][0]
    assert (item["valid"], item["reason"]) == (False, "too_short")
    assert [result["changed"] for result in outcome["results"]] == [False, False]
    assert outcome["reanalysis"]["floating_after"] == 1


def test_parts_ancla_fuera_de_la_pieza_flotante_es_invalida():
    item = _bridge(O_AND_DOT, "parts", [{"anchor": {"x": 1.0, "y": 1.0}, "width": 1.0}])["bridges"][0]  # sobre el cuerpo, no sobre la pieza que flota

    assert (item["valid"], item["reason"]) == (False, "anchor_outside")


def test_parts_sin_flotantes_cualquier_isla_es_desconocida():
    subjects = [_poly(_rect(0, 0, 10, 10)), _poly(_rect(20, 0, 10, 10))]

    item = _bridge(subjects, "parts", [{"island": 1, "width": 1.0}])["bridges"][0]

    assert (item["valid"], item["reason"]) == (False, "unknown_island")


def test_parts_si_la_forma_flotante_esta_bloqueada_el_bridge_se_suma_al_cuerpo():
    subjects = [LETTER_O, _poly(_rect(8, 12, 4, 4), locked=True)]

    outcome = _bridge(subjects, "parts", [{"island": 1, "width": 1.0}])

    assert outcome["bridges"][0]["valid"] is True and outcome["bridges"][0]["affects"] == [0]
    assert [result["changed"] for result in outcome["results"]] == [True, False]
    assert outcome["reanalysis"]["floating_after"] == 0


def test_parts_si_las_dos_formas_estan_bloqueadas_el_bridge_se_rechaza():
    subjects = [_poly(*LETTER_O["coordinates"], locked=True), _poly(_rect(8, 12, 4, 4), locked=True)]

    outcome = _bridge(subjects, "parts", [{"island": 1, "width": 1.0}])

    assert (outcome["bridges"][0]["valid"], outcome["bridges"][0]["reason"]) == (False, "locked_subject")
    assert [result["changed"] for result in outcome["results"]] == [False, False]
    assert outcome["reanalysis"]["floating_after"] == 1


def test_parts_anillo_anidado_cada_bridge_va_a_su_padre_y_uno_solo_reduce_de_a_uno():
    outer = _poly(_rect(0, 0, 40, 40), _rect(5, 5, 30, 30))
    middle = _poly(_rect(10, 10, 20, 20), _rect(15, 15, 10, 10))
    dot = _poly(_rect(18, 18, 4, 4))
    subjects = [outer, middle, dot]
    ring, point = (c["id"] for c in _floating(_analyze(subjects, "parts")))

    both = _bridge(subjects, "parts", [{"island": ring, "width": 1.0}, {"island": point, "width": 1.0}])
    only_point = _bridge(subjects, "parts", [{"island": point, "width": 1.0}])

    assert [item["length"] for item in both["bridges"]] == [pytest.approx(5.0, abs=1e-9), pytest.approx(3.0, abs=1e-9)]  # 10 − 5 y 18 − 15
    assert both["reanalysis"] == {"floating_before": 2, "floating_after": 0, "main_after": 1}
    # Conectar solo el punto con el anillo del medio: el anillo del medio sigue flotando.
    assert only_point["reanalysis"] == {"floating_before": 2, "floating_after": 1, "main_after": 1}


# ---- Invariancias de los bridges ----


@pytest.mark.parametrize("mode", ["stencil", "parts"])
def test_bridges_son_deterministas_y_no_dependen_del_giro(mode):
    subjects = [RING] if mode == "stencil" else O_AND_DOT

    first = json.dumps(_bridge(subjects, mode, [], suggest=True, suggest_width=0.8))
    assert json.dumps(_bridge(subjects, mode, [], suggest=True, suggest_width=0.8)) == first
    assert json.dumps(_bridge([_reversed(s) for s in subjects], mode, [], suggest=True, suggest_width=0.8)) == first


def test_bridges_sin_geometria_o_modo_invalido():
    with pytest.raises(InvalidParametersError):
        _bridge([RING], "hueco", [{"island": 1, "width": 1.0}])

    outcome = _bridge([_poly([(0, 0), (5, 0), (10, 0)])], "stencil", [{"island": 1, "width": 1.0}])

    assert (outcome["bridges"][0]["valid"], outcome["bridges"][0]["reason"]) == (False, "unknown_island")


@pytest.mark.parametrize(("letter", "islands"), [(LETTER_O, 1), (LETTER_A, 1), (LETTER_R, 1), (LETTER_B, 2)])
def test_las_sugerencias_conectan_todas_las_islas_de_cada_letra_sin_destruir_el_diseno(letter, islands):
    # Una sugerencia por contra-forma (O, A, R: 1; B: 2) lleva los flotantes a 0, quita del corte exactamente lo que dicen los bridges (el resto del
    # diseño queda tal cual) y un análisis aparte del resultado confirma el reanálisis.
    original_area = Polygon(letter["coordinates"][0], letter["coordinates"][1:]).area

    outcome = _bridge([letter], "stencil", [], suggest=True, suggest_width=0.8)

    assert len(outcome["bridges"]) == islands and all(item["valid"] and item["suggested"] for item in outcome["bridges"])
    assert outcome["reanalysis"] == {"floating_before": islands, "floating_after": 0, "main_after": 1}
    removed = sum(item["area"] for item in outcome["bridges"])
    assert _result_area(outcome["results"][0]) == pytest.approx(original_area - removed, abs=1e-6)
    assert _analyze(_after_subjects([letter], outcome))["floating_count"] == 0


def test_un_bridge_que_corre_por_el_borde_de_la_isla_sin_cruzar_el_corte_no_conecta_nada():
    # Con la dirección PARALELA al borde (hacia arriba por x = 15) el rectángulo solo ensancha el hueco: la isla sigue encerrada.
    for direction in ({"x": 0.0, "y": 1.0}, {"x": 0.0, "y": -1.0}):
        outcome = _bridge([RING], "stencil", [{"anchor": {"x": 15.0, "y": 10.0}, "direction": direction, "width": 1.0}])

        item = outcome["bridges"][0]
        assert (item["valid"], item["reason"], item["reduces"]) == (False, "no_connection", False)
        assert item["polygon"] is not None  # se dibuja igual para que se vea por qué no conecta
        assert outcome["reanalysis"] == {"floating_before": 1, "floating_after": 1, "main_after": 1}
        assert outcome["results"][0] == {"subject_index": 0, "changed": False, "geometries": []}


def test_en_parts_un_bridge_paralelo_al_borde_tampoco_conecta():
    outcome = _bridge(O_AND_DOT, "parts", [{"anchor": {"x": 12.0, "y": 14.0}, "direction": {"x": 0.0, "y": 1.0}, "width": 1.0}])

    item = outcome["bridges"][0]
    assert item["valid"] is False and item["reason"] in {"no_connection", "no_crossing"}
    assert outcome["reanalysis"]["floating_after"] == 1
