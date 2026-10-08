"""M3-S08: cobertura profunda de las booleanas del editor (union / difference / intersection_all / xor) sobre
el mismo núcleo y endpoint de S04. TODOS los valores esperados (áreas, número de piezas, huecos) están calculados
A MANO a partir de las coordenadas de cada caso -- ver el comentario de cada test --, no copiados de la salida
del código, y cada caso está pensado para FALLAR si el motor: invierte A y B, reduce un n-ario a binario
(p. ej. "A ∩ (B ∪ C)" en vez de "común a todos"), trata el XOR como unión, depende del sentido de giro de los
anillos o descarta/pierde huecos e islas.

Convención de los operandos de la UI: A es el primero (la base de la diferencia): subjects = [A], operands = [B, C, ...]
en `difference`; en union / xor / intersection_all el orden del resultado es irrelevante (se prueba).
"""

import itertools
import json
import math
import time

import pytest
from fastapi.testclient import TestClient
from shapely.geometry import Polygon

from app.core.errors import InvalidParametersError
from app.core.geometry_ops import run_boolean
from app.main import app

TOL = 0.01
URL = "/api/v1/geometry/boolean"


def _poly(*rings) -> dict:
    return {"type": "polygon", "coordinates": [list(ring) for ring in rings]}


def _rect(x0, y0, x1, y1):
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]


def _rect_poly(x0, y0, x1, y1) -> dict:
    return _poly(_rect(x0, y0, x1, y1))


def _line(*points) -> dict:
    return {"type": "line", "coordinates": list(points)}


def _area(piece) -> float:
    rings = piece["coordinates"]
    return Polygon(rings[0], rings[1:]).area


def _pieces(outcome, index=0):
    return outcome["results"][index]["geometries"]


def _total(outcome) -> float:
    return sum(_area(piece) for piece in _pieces(outcome))


def _areas(outcome) -> list[float]:
    return [round(_area(piece), 6) for piece in _pieces(outcome)]


def _valid(outcome) -> None:
    for item in outcome["results"]:
        for piece in item["geometries"]:
            assert piece["type"] == "polygon"
            assert Polygon(piece["coordinates"][0], piece["coordinates"][1:]).is_valid
            assert all(math.isfinite(v) for ring in piece["coordinates"] for point in ring for v in point)


def _reversed(polygon: dict) -> dict:
    return {"type": "polygon", "coordinates": [list(reversed(ring)) for ring in polygon["coordinates"]]}


def _run(op, subjects, operands=(), tolerance=TOL):
    return run_boolean(op, list(subjects), list(operands), tolerance)


# Dos formas asimétricas: A = 20x20 (400) y B = 30x10 desplazado (300), solape 10x10 = 100.
A = _rect_poly(0, 0, 20, 20)
B = _rect_poly(10, 5, 40, 15)


# ---- orden de operandos: A - B != B - A ----


def test_la_diferencia_no_conmuta_a_menos_b_son_300_y_b_menos_a_son_200():
    # A - B = 400 - 100 = 300 (una "C" de 20x20 sin el rectángulo 10..20 x 5..15); B - A = 300 - 100 = 200 (cola 20..40 x 5..15).
    a_menos_b = _run("difference", [A], [B])
    b_menos_a = _run("difference", [B], [A])

    assert _total(a_menos_b) == pytest.approx(300.0)
    assert _total(b_menos_a) == pytest.approx(200.0)
    assert Polygon(_pieces(a_menos_b)[0]["coordinates"][0]).bounds == (0.0, 0.0, 20.0, 20.0)
    assert Polygon(_pieces(b_menos_a)[0]["coordinates"][0]).bounds == (20.0, 5.0, 40.0, 15.0)
    _valid(a_menos_b)
    _valid(b_menos_a)


def test_union_interseccion_y_xor_no_dependen_del_orden_de_los_operandos():
    for op in ("union", "intersection_all", "xor"):
        directo = _run(op, [A, B])
        invertido = _run(op, [B, A])

        assert directo == invertido, op


# ---- las cuatro operaciones con 2 operandos, cálculo a mano ----


def test_solapamiento_parcial_en_las_cuatro_operaciones():
    # |A| = 400, |B| = 300, |A∩B| = 100: unión 600 (1 pieza), común 100, XOR = 600 - 100 = 500 (A-B 300 + B-A 200).
    union = _run("union", [A, B])
    comun = _run("intersection_all", [A, B])
    xor = _run("xor", [A, B])

    assert _areas(union) == [600.0]
    assert _areas(comun) == [100.0]
    assert _total(xor) == pytest.approx(500.0)
    assert sorted(_areas(xor)) == [200.0, 300.0]


def test_contencion_total_el_chico_dentro_del_grande():
    # Grande 40x40 (1600), chico 10..20 (100) dentro: unión 1600; común = el chico (100); G - c = 1500 con hueco; c - G = vacío;
    # XOR = 1500 con un hueco (el chico queda fuera del XOR).
    grande = _rect_poly(0, 0, 40, 40)
    chico = _rect_poly(10, 10, 20, 20)

    assert _areas(_run("union", [grande, chico])) == [1600.0]
    assert _areas(_run("intersection_all", [grande, chico])) == [100.0]
    g_menos_c = _run("difference", [grande], [chico])
    assert _areas(g_menos_c) == [1500.0] and len(_pieces(g_menos_c)[0]["coordinates"]) == 2
    assert _pieces(_run("difference", [chico], [grande])) == []
    xor = _run("xor", [grande, chico])
    assert _areas(xor) == [1500.0] and len(_pieces(xor)[0]["coordinates"]) == 2


def test_sin_solapamiento_la_union_conserva_dos_piezas_y_el_resto_se_comporta():
    izquierda = _rect_poly(0, 0, 10, 10)
    derecha = _rect_poly(50, 0, 60, 10)

    assert _areas(_run("union", [izquierda, derecha])) == [100.0, 100.0]
    assert _pieces(_run("intersection_all", [izquierda, derecha])) == []
    assert _areas(_run("xor", [izquierda, derecha])) == [100.0, 100.0]
    sin_tocar = _run("difference", [izquierda], [derecha])
    assert sin_tocar["results"][0]["changed"] is False
    assert _areas(sin_tocar) == [100.0]


def test_bordes_que_se_tocan_la_union_une_y_la_interseccion_es_vacia():
    # Dos cuadrados 10x10 que comparten el borde x = 10: la unión es UN rectángulo 20x10 (200); el borde común no es un área.
    izquierda = _rect_poly(0, 0, 10, 10)
    derecha = _rect_poly(10, 0, 20, 10)

    union = _run("union", [izquierda, derecha])
    assert _areas(union) == [200.0]
    assert _pieces(_run("intersection_all", [izquierda, derecha])) == []  # ni una línea
    assert _areas(_run("xor", [izquierda, derecha])) == [200.0]
    resta = _run("difference", [izquierda], [derecha])
    assert resta["results"][0]["changed"] is False
    assert _areas(resta) == [100.0]


def test_cuadrados_que_solo_comparten_una_esquina():
    # Comparten el punto (10, 10): unión = 2 piezas (100 + 100), intersección vacía, la resta no cambia nada.
    a = _rect_poly(0, 0, 10, 10)
    b = _rect_poly(10, 10, 20, 20)

    assert _areas(_run("union", [a, b])) == [100.0, 100.0]
    assert _pieces(_run("intersection_all", [a, b])) == []
    assert _run("difference", [a], [b])["results"][0]["changed"] is False


def test_poligonos_identicos():
    # Dos copias de un 20x20: unión 400, común 400, XOR vacío, A - A vacío (y changed true: hay algo que eliminar).
    copia = _rect_poly(0, 0, 20, 20)

    assert _areas(_run("union", [A, copia])) == [400.0]
    assert _areas(_run("intersection_all", [A, copia])) == [400.0]
    assert _pieces(_run("xor", [A, copia])) == []
    resta = _run("difference", [A], [copia])
    assert _pieces(resta) == [] and resta["results"][0]["changed"] is True


# ---- huecos e islas ----


def test_un_operando_dentro_del_hueco_queda_como_isla_en_la_union():
    # Corona 40x40 con hueco 10..30 (1600 - 400 = 1200) + isla 15..25 (100) dentro del hueco: unión = 1300 en 2 piezas
    # (la corona con su hueco y la isla suelta); la resta de la isla a la corona no cambia nada.
    corona = _poly(_rect(0, 0, 40, 40), _rect(10, 10, 30, 30))
    isla = _rect_poly(15, 15, 25, 25)

    union = _run("union", [corona, isla])
    assert sorted(_areas(union)) == [100.0, 1200.0]
    assert _total(union) == pytest.approx(1300.0)
    assert _run("difference", [corona], [isla])["results"][0]["changed"] is False
    assert _pieces(_run("intersection_all", [corona, isla])) == []  # la isla está en el hueco: nada en común


def test_un_operando_que_tapa_el_hueco_lo_rellena():
    # Corona de 1200 y un 30x30 (900) que cubre el hueco 10..30 y parte de la corona: la unión es el cuadrado 40x40 entero SIN hueco.
    corona = _poly(_rect(0, 0, 40, 40), _rect(10, 10, 30, 30))
    tapa = _rect_poly(5, 5, 35, 35)

    union = _run("union", [corona, tapa])
    assert _areas(union) == [1600.0]
    assert len(_pieces(union)[0]["coordinates"]) == 1  # sin anillo interior
    # común = la parte de la corona dentro de 5..35: 900 - 400 (hueco) = 500 (un anillo con hueco).
    comun = _run("intersection_all", [corona, tapa])
    assert _areas(comun) == [500.0] and len(_pieces(comun)[0]["coordinates"]) == 2


def test_isla_dentro_del_hueco_del_mismo_objeto_regla_par_impar():
    # Objeto de 3 anillos anidados: 40x40 (1600) - 30x30 (900) + 10x10 (100) = 800 en 2 piezas (corona 700 + isla 100).
    anidado = _poly(_rect(0, 0, 40, 40), _rect(5, 5, 35, 35), _rect(15, 15, 25, 25))
    lejos = _rect_poly(100, 100, 110, 110)

    union = _run("union", [anidado, lejos])
    assert sorted(_areas(union)) == [100.0, 100.0, 700.0]
    # Una diferencia que corta la isla por la mitad: se queda con 50 de isla y la corona entera.
    corte = _run("difference", [anidado], [_rect_poly(20, 0, 50, 50)])
    assert sorted(_areas(corte)) == [50.0, 350.0]  # la corona queda sólo con x<20 (350) + media isla (50)
    _valid(union)
    _valid(corte)


# ---- winding horario/antihorario: la regla par-impar da el mismo resultado ----


@pytest.mark.parametrize("op", ["union", "intersection_all", "xor"])
def test_el_sentido_de_giro_de_los_anillos_no_cambia_el_resultado(op):
    # Mismo par con y sin los anillos invertidos (incluye un hueco): salida IDÉNTICA byte a byte.
    base = _poly(_rect(0, 0, 40, 40), _rect(10, 10, 20, 20))
    otro = _rect_poly(15, 15, 55, 55)
    esperado = _run(op, [base, otro])

    assert _run(op, [_reversed(base), otro]) == esperado
    assert _run(op, [base, _reversed(otro)]) == esperado
    assert _run(op, [_reversed(base), _reversed(otro)]) == esperado
    assert json.dumps(esperado, sort_keys=True)  # serializable


def test_el_sentido_de_giro_no_cambia_la_diferencia_y_un_hueco_con_el_mismo_giro_sigue_siendo_hueco():
    base = _poly(_rect(0, 0, 40, 40), _rect(10, 10, 20, 20))  # exterior y hueco con el mismo giro (par-impar)
    sustraendo = _rect_poly(30, 30, 60, 60)

    esperado = _run("difference", [base], [sustraendo])
    # 1600 - 100 (hueco) - 100 (zona 30..40 que se resta) = 1400.
    assert _total(esperado) == pytest.approx(1400.0)
    assert _run("difference", [_reversed(base)], [_reversed(sustraendo)]) == esperado
    horario_y_antihorario = _poly(_rect(0, 0, 40, 40), list(reversed(_rect(10, 10, 20, 20))))
    assert _run("difference", [horario_y_antihorario], [sustraendo]) == esperado


# ---- entrada autointersectante ----


def test_un_operando_autointersectante_se_hace_valido_antes_de_operar():
    # Moño (0,0)-(40,40)-(40,0)-(0,40): dos triángulos de 400 (total 800) tocándose en (20, 20).
    mono = _poly([(0, 0), (40, 40), (40, 0), (0, 40)])
    lejano = _rect_poly(100, 0, 110, 10)

    union = _run("union", [mono, lejano])
    assert sorted(_areas(union)) == [100.0, 400.0, 400.0]
    _valid(union)
    # Intersección con una franja vertical x 0..10 que atraviesa SOLO el triángulo izquierdo: trapecio de ancho 10 entre
    # y = x y y = 40 - x -> alto en x: 40 - 2x; área = ∫0..10 (40-2x) dx = 400 - 100 = 300.
    franja = _rect_poly(0, -5, 10, 45)
    assert _total(_run("intersection_all", [mono, franja])) == pytest.approx(300.0)
    _valid(_run("xor", [mono, franja]))


# ---- slivers y tolerancia ----


def test_astillas_de_la_diferencia_se_filtran_segun_la_tolerancia():
    # A = 10x10; B = 0..9,999 x 0..10 -> A - B es una astilla de 0,001 x 10 = 0,01 de área.
    a = _rect_poly(0, 0, 10, 10)
    b = _rect_poly(0, 0, 9.999, 10)

    assert _pieces(_run("difference", [a], [b], tolerance=0.5)) == []  # umbral 0,25 > 0,01: descartada
    conservada = _run("difference", [a], [b], tolerance=0.01)  # umbral 1e-4 < 0,01: se conserva
    assert _areas(conservada) == [0.01]


def test_astillas_de_la_interseccion_y_el_xor_tambien_se_filtran():
    # Solape de 0,001 x 10 = 0,01: con tolerancia 0,5 la intersección es vacía; con 0,01 hay una pieza de 0,01.
    a = _rect_poly(0, 0, 10, 10)
    b = _rect_poly(9.999, 0, 20, 10)

    assert _pieces(_run("intersection_all", [a, b], tolerance=0.5)) == []
    assert _areas(_run("intersection_all", [a, b], tolerance=0.01)) == [0.01]
    # XOR = A + B - 2 * solape = 100 + 100,01 - 0,02 = 199,99: dos piezas grandes (99,99 de A-B y 100 de B-A); el solape de 0,01 no está.
    xor = _run("xor", [a, b], tolerance=0.5)
    assert sorted(_areas(xor)) == [99.99, 100.0]


def test_la_tolerancia_no_cambia_la_geometria_de_los_poligonos_grandes():
    # Las booleanas entre polígonos no aplanan nada en el servidor: tolerancias distintas dan las mismas coordenadas.
    fina = _run("union", [A, B], tolerance=0.001)
    gruesa = _run("union", [A, B], tolerance=2.0)

    assert fina["results"][0]["geometries"] == gruesa["results"][0]["geometries"]


# ---- coordenadas grandes y pequeñas ----


def test_coordenadas_grandes_lejos_del_origen():
    # Cuadrados de 20 desplazados 1e8 en ambos ejes: mismas áreas que en el origen (unión 700, común 100, XOR 600).
    base = 1e8
    a = _rect_poly(base, base, base + 20, base + 20)
    b = _rect_poly(base + 10, base + 10, base + 30, base + 30)

    assert _total(_run("union", [a, b], tolerance=0.01)) == pytest.approx(700.0)
    assert _total(_run("intersection_all", [a, b])) == pytest.approx(100.0)
    assert _total(_run("xor", [a, b])) == pytest.approx(600.0)


def test_coordenadas_pequenas_con_tolerancia_pequena():
    # Escala 1e-3: cuadrados de 0,02 (área 4e-4) con solape de 0,01 x 0,01 (1e-4): unión 7e-4, común 1e-4, XOR 6e-4 (dos L de 3e-4). Tolerancia 1e-6.
    a = _rect_poly(0, 0, 0.02, 0.02)
    b = _rect_poly(0.01, 0.01, 0.03, 0.03)

    assert _total(_run("union", [a, b], tolerance=1e-6)) == pytest.approx(7e-4)
    assert _total(_run("intersection_all", [a, b], tolerance=1e-6)) == pytest.approx(1e-4)
    assert _total(_run("xor", [a, b], tolerance=1e-6)) == pytest.approx(6e-4)
    # Con tolerancia 0,02 el umbral es 4e-4: la unión (7e-4) se conserva; la intersección (1e-4) y las L del XOR (3e-4) son despreciables.
    assert _areas(_run("union", [a, b], tolerance=0.02)) == [pytest.approx(7e-4)]
    assert _pieces(_run("intersection_all", [a, b], tolerance=0.02)) == []
    assert _pieces(_run("xor", [a, b], tolerance=0.02)) == []


# ---- n-arios (3+ operandos) con resultados calculados a mano ----

# Tres franjas de 20 de alto: A x 0..20, B x 10..30, C x 15..35. Cobertura por tramo de x:
#   [0,10)=1 (A)   [10,15)=2 (A,B)   [15,20)=3 (A,B,C)   [20,30)=2 (B,C)   [30,35)=1 (C)
A3 = _rect_poly(0, 0, 20, 20)
B3 = _rect_poly(10, 0, 30, 20)
C3 = _rect_poly(15, 0, 35, 20)


def test_union_de_tres_es_la_cobertura_total_en_una_pieza():
    # 35 de ancho x 20 = 700.
    assert _areas(_run("union", [A3, B3, C3])) == [700.0]


def test_interseccion_comun_a_los_tres_no_es_a_interseccion_union_de_los_demas():
    # Común a A, B y C: x 15..20 -> 5 x 20 = 100. Un motor que reduzca a "A ∩ (B ∪ C)" daría x 10..20 = 200.
    comun = _run("intersection_all", [A3, B3, C3])
    assert _areas(comun) == [100.0]
    assert Polygon(_pieces(comun)[0]["coordinates"][0]).bounds == (15.0, 0.0, 20.0, 20.0)
    # También con la forma subject/operands (el cliente manda A como subject y el resto como operandos).
    assert _run("intersection_all", [A3], [B3, C3]) == comun
    # El "intersection" de S04 sigue siendo "cada subject ∩ la UNIÓN de operandos": 200, per_subject (no se rompió).
    legado = _run("intersection", [A3], [B3, C3])
    assert legado["scope"] == "per_subject" and _areas(legado) == [200.0]


def test_xor_de_tres_es_paridad_impar_y_no_union_ni_xor_binario_encadenado_incorrecto():
    # Cubierto por 1 o 3 operandos: x [0,10) (10) + [15,20) (5) + [30,35) (5) = 20 de ancho x 20 = 400 en 3 piezas (200, 100, 100).
    # La unión daría 700; el "A xor (B ∪ C)" daría [0,10) + [20,35) = 25 x 20 = 500.
    xor = _run("xor", [A3, B3, C3])

    assert sorted(_areas(xor)) == [100.0, 100.0, 200.0]
    assert _total(xor) == pytest.approx(400.0)
    # El tramo de 2 operandos [10,15) y [20,30) NO está en el resultado.
    xs = sorted(piece["coordinates"][0][0][0] for piece in _pieces(xor))
    assert xs == [0.0, 15.0, 30.0]
    _valid(xor)


def test_xor_con_un_operando_repetido_se_cancela_en_pares():
    # XOR(A, A, B) = B (A se cuenta 2 veces = par); XOR(A, A, A) = A (3 = impar); XOR(A, A) = vacío.
    assert _areas(_run("xor", [A3, A3, B3])) == [400.0]
    assert _pieces(_run("xor", [A3, A3, B3]))[0]["coordinates"][0][0] == (10.0, 0.0)
    assert _areas(_run("xor", [A3, A3, A3])) == [400.0]
    assert _pieces(_run("xor", [A3, A3])) == []
    # Cuatro operandos: A, B, A, B -> todo se cancela.
    assert _pieces(_run("xor", [A3, B3, A3, B3])) == []


def test_diferencia_de_a_menos_la_union_de_los_demas_con_operandos_que_se_solapan_entre_si():
    # A = 0..40 x 0..10 (400); B = 5..15 (100); C = 10..20 (100); B∪C = 5..20 (150, se solapan 5..15... [10,15] es común).
    # A - (B ∪ C) = [0,5) (50) + [20,40] (200) = 250 en 2 piezas. Restar sólo el primero daría 300; sumar áreas de B y C (200) daría 200.
    a = _rect_poly(0, 0, 40, 10)
    b = _rect_poly(5, 0, 15, 10)
    c = _rect_poly(10, 0, 20, 10)

    resultado = _run("difference", [a], [b, c])

    assert sorted(_areas(resultado)) == [50.0, 200.0]
    assert resultado["results"][0]["changed"] is True
    # El orden de los operandos B, C no importa (la base es A).
    assert _run("difference", [a], [c, b]) == resultado
    # Pero cambiar la base sí: B - (A ∪ C) = vacío (B está dentro de A).
    assert _pieces(_run("difference", [b], [a, c])) == []


def test_diferencia_donde_ningun_operando_toca_a_a_la_deja_sin_cambios():
    a = _rect_poly(0, 0, 10, 10)
    resultado = _run("difference", [a], [_rect_poly(50, 50, 60, 60), _rect_poly(70, 70, 80, 80)])

    assert resultado["results"][0]["changed"] is False
    assert _areas(resultado) == [100.0]


def test_interseccion_de_tres_en_2d_con_resultado_vacio_si_uno_no_comparte_zona():
    # A y B se solapan (10..20)², C está lejos: la intersección común de los tres es vacía aunque A ∩ B no lo sea.
    a = _rect_poly(0, 0, 20, 20)
    b = _rect_poly(10, 10, 30, 30)
    c = _rect_poly(100, 100, 110, 110)

    assert _areas(_run("intersection_all", [a, b])) == [100.0]
    assert _pieces(_run("intersection_all", [a, b, c])) == []


def test_interseccion_de_tres_en_2d_calculada_a_mano():
    # A (0..30)², B (10..40) x (0..30), C (0..30) x (10..40): común = x 10..30, y 10..30 = 20 x 20 = 400.
    a = _rect_poly(0, 0, 30, 30)
    b = _rect_poly(10, 0, 40, 30)
    c = _rect_poly(0, 10, 30, 40)

    assert _areas(_run("intersection_all", [a, b, c])) == [400.0]


@pytest.mark.parametrize("op", ["union", "intersection_all", "xor"])
def test_los_resultados_n_arios_no_dependen_del_orden_de_los_tres_operandos(op):
    base = _run(op, [A3, B3, C3])
    for permutacion in itertools.permutations([A3, B3, C3]):
        assert _run(op, list(permutacion)) == base, (op, permutacion)


def test_n_ario_con_operandos_en_subjects_y_en_operands_es_equivalente():
    for op in ("union", "xor", "intersection_all"):
        assert _run(op, [A3, B3], [C3]) == _run(op, [A3, B3, C3]), op


def test_interseccion_comun_necesita_al_menos_dos_geometrias():
    with pytest.raises(InvalidParametersError):
        _run("intersection_all", [A3])


def test_una_geometria_degenerada_hace_vacia_la_interseccion_comun_pero_no_la_union():
    degenerado = _poly([(5, 5), (6, 5), (7, 5)])  # colineal: sin área
    assert _pieces(_run("intersection_all", [A3, degenerado])) == []
    assert _areas(_run("union", [A3, degenerado])) == [400.0]


def test_operacion_desconocida_se_rechaza_en_el_nucleo():
    with pytest.raises(InvalidParametersError):
        _run("buffer", [A3])


# ---- determinismo byte a byte ----


def test_el_mismo_pedido_n_ario_da_los_mismos_bytes():
    for op in ("union", "xor", "intersection_all"):
        primero = json.dumps(_run(op, [A3, B3, C3]))
        segundo = json.dumps(_run(op, [A3, B3, C3]))
        assert primero == segundo, op


def test_el_resultado_trae_anillos_cerrados_orientados_y_desde_su_vertice_minimo():
    xor = _run("xor", [_poly(_rect(0, 0, 40, 40)), _rect_poly(10, 10, 20, 20)])
    exterior, hueco = _pieces(xor)[0]["coordinates"]

    def signed(ring):
        return sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(ring, ring[1:])) / 2

    assert signed(exterior) == pytest.approx(1600.0) and signed(hueco) == pytest.approx(-100.0)
    assert exterior[0] == exterior[-1] == (0.0, 0.0) and hueco[0] == hueco[-1] == (10.0, 10.0)


# ---- rendimiento razonable (sin umbrales frágiles) ----

# 200 cuadrados de 10 en fila, cada uno desplazado 8 (solapan 2 con el siguiente).


def _fila(n: int = 200) -> list[dict]:
    return [_rect_poly(8 * i, 0, 8 * i + 10, 10) for i in range(n)]


def test_rendimiento_union_de_200_operandos_pequenos():
    inicio = time.perf_counter()
    union = _run("union", _fila())
    elapsed = time.perf_counter() - inicio

    # Cobertura: 8 * 199 + 10 = 1602 de ancho x 10 = 16020 en una sola pieza.
    assert _areas(union) == [16020.0]
    assert elapsed < 30  # holgado a propósito: sólo detecta una regresión catastrófica (el servicio corta a los 15 s)


def test_rendimiento_xor_de_200_operandos_pequenos():
    inicio = time.perf_counter()
    xor = _run("xor", _fila())
    elapsed = time.perf_counter() - inicio

    # Un solo operando cubre cada tramo salvo los 199 solapes de 2 x 10 (cuentan 2 = par): 16020 - 199 * 20 = 12040 en 200 piezas.
    assert len(_pieces(xor)) == 200
    assert _total(xor) == pytest.approx(12040.0)
    assert elapsed < 30


def test_rendimiento_diferencia_e_interseccion_de_200_operandos_pequenos():
    fila = _fila()
    base = _rect_poly(0, -5, 1602, 15)  # 1602 x 20 = 32040
    inicio = time.perf_counter()
    resta = _run("difference", [base], fila)
    # Una intersección común de toda la fila es vacía: los extremos no se tocan (el primero termina en 10, el último empieza en 1592).
    comun = _run("intersection_all", fila)
    elapsed = time.perf_counter() - inicio

    # base - fila: 32040 - 16020 = 16020 (franjas de 5 de alto arriba y abajo: 2 x 1602 x 5).
    assert _total(resta) == pytest.approx(16020.0)
    assert _pieces(comun) == []
    assert elapsed < 30


# ---- el endpoint (mismo de S04) con las operaciones n-arias ----


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _post(client, body):
    return client.post(URL, content=json.dumps(body), headers={"Content-Type": "application/json"})


def test_endpoint_intersection_all_devuelve_resultado_combinado_calculado_a_mano(client):
    body = {"operation": "intersection_all", "subjects": [A3, B3], "operands": [C3], "tolerance": TOL}

    response = _post(client, body)

    assert response.status_code == 200
    data = response.json()
    assert data["operation"] == "intersection_all"
    assert data["scope"] == "combined"
    assert len(data["results"]) == 1 and data["results"][0]["subject_index"] is None
    assert data["piece_count"] == 1
    assert Polygon(data["results"][0]["geometries"][0]["coordinates"][0]).area == pytest.approx(100.0)


def test_endpoint_xor_de_tres_y_determinismo_byte_a_byte(client):
    body = {"operation": "xor", "subjects": [A3, B3, C3], "operands": [], "tolerance": TOL}

    primero = _post(client, body)
    segundo = _post(client, body)

    assert primero.status_code == 200 and primero.content == segundo.content
    assert primero.json()["piece_count"] == 3


def test_endpoint_diferencia_n_aria_y_orden_de_la_base(client):
    a = _rect_poly(0, 0, 40, 10)
    b = _rect_poly(5, 0, 15, 10)
    c = _rect_poly(10, 0, 20, 10)

    a_menos = _post(client, {"operation": "difference", "subjects": [a], "operands": [b, c], "tolerance": TOL}).json()
    b_menos = _post(client, {"operation": "difference", "subjects": [b], "operands": [a, c], "tolerance": TOL}).json()

    assert a_menos["piece_count"] == 2
    assert sum(Polygon(piece["coordinates"][0]).area for piece in a_menos["results"][0]["geometries"]) == pytest.approx(250.0)
    assert b_menos["piece_count"] == 0 and b_menos["results"][0]["changed"] is True


def test_endpoint_intersection_all_con_una_sola_geometria_es_un_error_422(client):
    response = _post(client, {"operation": "intersection_all", "subjects": [A3], "operands": [], "tolerance": TOL})

    assert response.status_code == 422
    assert response.json()["code"] == "invalid_parameters"


def test_endpoint_sigue_rechazando_operaciones_desconocidas(client):
    response = _post(client, {"operation": "intersect_all", "subjects": [A3, B3], "operands": [], "tolerance": TOL})

    assert response.status_code == 422
    assert response.json()["code"] == "invalid_parameters"
