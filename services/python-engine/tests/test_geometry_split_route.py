"""Tests de integración de POST /api/v1/geometry/split vía TestClient (M3-S10) y del servicio de orquestación
(GeometryService.process_split): contrato de respuesta con valores calculados a mano, validación de la entrada
(esquema, NaN/Infinity, modo, ancho de ranura, puntos del corte), límites (subjects, vértices, puntos de corte, cuerpo)
y errores en el formato uniforme {code, message}; timeout inyectado como fake.
"""

import json
import time

import pytest
from fastapi.testclient import TestClient
from shapely.geometry import Polygon

from app.api.dependencies import get_geometry_service
from app.core.config import Settings, get_settings
from app.core.errors import GeometryTimeoutError, InvalidParametersError, TooManyGeometrySubjectsError, TooManyGeometryVerticesError
from app.main import app
from app.models.schemas import GeometrySplitRequest
from app.services.geometry_service import GeometryService

URL = "/api/v1/geometry/split"

SQUARE_10 = {"type": "polygon", "coordinates": [[[0, 0], [10, 0], [10, 10], [0, 10]]]}
LINE_10 = {"type": "line", "coordinates": [[0, 0], [10, 0]]}


def _body(**overrides) -> dict:
    body = {
        "subjects": [SQUARE_10],
        "cutter": {"points": [[5, -1], [5, 11]]},
        "mode": "split",
        "slot_width": 0,
        "extend": False,
        "tolerance": 0.01,
    }
    body.update(overrides)
    return body


def _post(client, body: dict | str | bytes):
    content = body if isinstance(body, (str, bytes)) else json.dumps(body)
    return client.post(URL, content=content, headers={"Content-Type": "application/json"})


def _override_service(service: GeometryService):
    app.dependency_overrides[get_geometry_service] = lambda: service


def _request(**overrides) -> GeometrySplitRequest:
    return GeometrySplitRequest.model_validate(_body(**overrides))


def _area(piece: dict) -> float:
    return Polygon(piece["coordinates"][0], piece["coordinates"][1:]).area


# ---- Ruta: contrato ----


def test_split_devuelve_el_contrato_esperado_para_un_cuadrado_dividido_por_la_mitad(client):
    response = _post(client, _body())

    assert response.status_code == 200
    body = response.json()
    assert (body["mode"], body["slot_width"], body["extend"], body["tolerance"]) == ("split", 0, False, 0.01)
    assert body["piece_count"] == 2
    assert len(body["results"]) == 1
    item = body["results"][0]
    assert (item["subject_index"], item["changed"], item["touched"], item["piece_count"], item["discarded"]) == (0, True, True, 2, 0)
    assert sorted(_area(piece) for piece in item["pieces"]) == pytest.approx([50.0, 50.0])
    assert {piece["type"] for piece in item["pieces"]} == {"polygon"}


def test_split_en_modo_ranura_quita_el_ancho_de_la_ranura(client):
    response = _post(client, _body(mode="slot", slot_width=0.4))

    item = response.json()["results"][0]
    assert response.status_code == 200
    assert sorted(_area(piece) for piece in item["pieces"]) == pytest.approx([48.0, 48.0])  # (10 − 0,4)/2 · 10
    assert response.json()["slot_width"] == 0.4


def test_split_de_una_linea_responde_polilineas(client):
    response = _post(client, _body(subjects=[LINE_10], cutter={"points": [[4, -1], [4, 1]]}))

    item = response.json()["results"][0]
    assert [piece["type"] for piece in item["pieces"]] == ["line", "line"]
    assert item["pieces"][0]["coordinates"] == [[0, 0], [4, 0]]
    assert item["pieces"][1]["coordinates"] == [[4, 0], [10, 0]]


def test_split_sin_cruce_responde_changed_false_pero_dice_si_lo_toca(client):
    reaches = _post(client, _body(cutter={"points": [[5, 20], [5, 5]]})).json()["results"][0]
    apart = _post(client, _body(cutter={"points": [[50, 0], [50, 10]]})).json()["results"][0]

    assert (reaches["changed"], reaches["touched"], reaches["piece_count"]) == (False, True, 1)
    assert (apart["changed"], apart["touched"], apart["piece_count"]) == (False, False, 1)


def test_split_extend_hace_que_el_corte_corto_atraviese(client):
    response = _post(client, _body(cutter={"points": [[5, 20], [5, 5]]}, extend=True))

    assert response.json()["extend"] is True
    assert response.json()["results"][0]["changed"] is True


def test_split_responde_un_resultado_por_subject_y_en_orden(client):
    far = {"type": "polygon", "coordinates": [[[100, 100], [110, 100], [110, 110]]]}
    response = _post(client, _body(subjects=[SQUARE_10, far, LINE_10]))

    results = response.json()["results"]
    assert [item["subject_index"] for item in results] == [0, 1, 2]
    assert [item["changed"] for item in results] == [True, False, True]
    assert response.json()["piece_count"] == 2 + 1 + 2


def test_split_usa_los_valores_por_defecto_de_slot_width_y_extend(client):
    minimal = {"subjects": [SQUARE_10], "cutter": {"points": [[5, -1], [5, 11]]}, "mode": "split", "tolerance": 0.01}

    body = _post(client, minimal).json()

    assert (body["slot_width"], body["extend"]) == (0, False)


def test_split_es_determinista_entre_peticiones_repetidas(client):
    first = _post(client, _body(mode="slot", slot_width=0.5))
    second = _post(client, _body(mode="slot", slot_width=0.5))

    assert first.status_code == second.status_code == 200
    assert first.content == second.content


def test_split_la_respuesta_no_contiene_valores_no_finitos(client):
    response = _post(client, _body(mode="slot", slot_width=0.7, cutter={"points": [[-1, -1], [11, 11]]}))

    def values(node):
        if isinstance(node, bool) or node is None:
            return
        if isinstance(node, (int, float)):
            yield node
        elif isinstance(node, list):
            for child in node:
                yield from values(child)
        elif isinstance(node, dict):
            for child in node.values():
                yield from values(child)

    numbers = list(values(response.json()))
    assert numbers and all(abs(value) < 1e9 for value in numbers)
    assert "NaN" not in response.text and "Infinity" not in response.text


# ---- Ruta: validación ----


@pytest.mark.parametrize(
    "overrides",
    [
        {"cutter": {"points": [[0, 0]]}},  # un solo punto
        {"cutter": {"points": []}},
        {"cutter": {}},
        {"cutter": {"points": [[0, 0], [1]]}},  # punto de una coordenada
        {"cutter": {"points": [[0, 0], [1, 1, 1]]}},  # punto de tres
        {"mode": "chop"},
        {"mode": "SPLIT"},
        {"mode": None},
        {"tolerance": 0},
        {"tolerance": -1},
        {"tolerance": 1_000_001},
        {"slot_width": -1},
        {"extend": "yes"},
        {"extend": 1},
        {"subjects": []},
        {"subjects": [{"type": "polygon", "coordinates": [[[0, 0], [1, 1]]]}]},  # anillo de 2 vértices
        {"subjects": [{"type": "bufferedLine", "points": [[0, 0]], "radius": 1}]},  # el pincel no es un subject
        {"cutter": {"points": [[0, 0], [1e12, 1]]}},  # fuera de |v| <= 1e9
    ],
)
def test_split_rechaza_un_cuerpo_invalido_con_422_uniforme(client, overrides):
    response = _post(client, _body(**overrides))

    assert response.status_code == 422
    assert response.json()["code"] == "invalid_parameters"


@pytest.mark.parametrize("literal", ["NaN", "Infinity", "-Infinity"])
@pytest.mark.parametrize(
    "overrides",
    [
        {"tolerance": "@@"},
        {"slot_width": "@@", "mode": "slot"},
        {"cutter": {"points": [["@@", -1], [5, 11]]}},
        {"subjects": [{"type": "polygon", "coordinates": [[[0, 0], ["@@", 0], [10, 10]]]}]},
    ],
)
def test_split_rechaza_nan_e_infinity_en_cualquier_campo_numerico(client, literal, overrides):
    # Python acepta los literales NaN/Infinity aunque no sean JSON estándar: el esquema los rechaza explícitamente.
    content = json.dumps(_body(**overrides)).replace('"@@"', literal)

    response = _post(client, content)

    assert response.status_code == 422
    assert response.json()["code"] == "invalid_parameters"


def test_split_modo_ranura_exige_un_ancho_mayor_que_cero(client):
    zero = _post(client, _body(mode="slot", slot_width=0))
    negative = _post(client, _body(mode="slot", slot_width=-0.2))

    assert zero.status_code == negative.status_code == 422
    assert zero.json()["code"] == "invalid_parameters"


def test_split_un_corte_con_todos_los_puntos_iguales_responde_422(client):
    response = _post(client, _body(cutter={"points": [[3, 3], [3, 3]]}))

    assert response.status_code == 422
    assert response.json()["code"] == "invalid_parameters"


@pytest.mark.parametrize("payload", ["", "{", "[]", "null", '{"subjects": 1}'])
def test_split_rechaza_json_malformado_o_de_otra_forma(client, payload):
    assert _post(client, payload).status_code == 422


# ---- Ruta: límites y errores ----


def test_split_rechaza_demasiados_subjects_con_422_tipado():
    app.dependency_overrides[get_geometry_service] = lambda: GeometryService(Settings(max_geometry_subjects=2))
    try:
        with TestClient(app) as limited:
            ok = _post(limited, _body(subjects=[SQUARE_10, SQUARE_10]))
            too_many = _post(limited, _body(subjects=[SQUARE_10, SQUARE_10, SQUARE_10]))

        assert ok.status_code == 200
        assert too_many.status_code == 422
        assert too_many.json()["code"] == "too_many_geometry_subjects"
    finally:
        app.dependency_overrides.pop(get_geometry_service, None)


def test_split_rechaza_un_cuerpo_demasiado_grande_con_413():
    app.dependency_overrides[get_settings] = lambda: Settings(max_geometry_request_bytes=100)
    try:
        with TestClient(app) as limited:
            response = _post(limited, _body())

        assert response.status_code == 413
        assert response.json()["code"] == "geometry_request_too_large"
    finally:
        app.dependency_overrides.pop(get_settings, None)


def test_split_reporta_el_timeout_como_error_tipado_504():
    def slow_split(subjects, cutter_points, mode, slot_width, extend, tolerance) -> dict:
        time.sleep(0.5)
        return {"results": []}

    _override_service(GeometryService(Settings(geometry_timeout_seconds=0), split_fn=slow_split))
    try:
        with TestClient(app) as slow:
            response = _post(slow, _body())

        assert response.status_code == 504
        assert response.json()["code"] == "geometry_timeout"
    finally:
        app.dependency_overrides.pop(get_geometry_service, None)


def test_split_reporta_un_resultado_invalido_del_motor_como_500_y_nunca_lo_devuelve():
    from app.core.errors import GeometryResultInvalidError

    def broken_split(subjects, cutter_points, mode, slot_width, extend, tolerance) -> dict:
        raise GeometryResultInvalidError("polígono inválido")

    _override_service(GeometryService(Settings(), split_fn=broken_split))
    try:
        with TestClient(app) as broken:
            response = _post(broken, _body())

        assert response.status_code == 500
        assert response.json()["code"] == "geometry_result_invalid"
    finally:
        app.dependency_overrides.pop(get_geometry_service, None)


# ---- Servicio ----


def test_process_split_devuelve_la_respuesta_tipada_del_nucleo_y_es_reproducible():
    service = GeometryService(Settings())

    response = service.process_split(_request())

    assert (response.mode, response.slot_width, response.extend, response.tolerance) == ("split", 0, False, 0.01)
    assert response.piece_count == 2
    assert response.results[0].subject_index == 0 and response.results[0].changed and response.results[0].touched
    assert service.process_split(_request()) == response


def test_process_split_cuenta_las_piezas_de_todos_los_resultados():
    response = GeometryService(Settings()).process_split(_request(subjects=[SQUARE_10, SQUARE_10, LINE_10]))

    assert [item.piece_count for item in response.results] == [2, 2, 2]
    assert response.piece_count == 6


def test_process_split_rechaza_mas_subjects_que_el_maximo_y_acepta_exactamente_el_maximo():
    service = GeometryService(Settings(max_geometry_subjects=2))

    assert len(service.process_split(_request(subjects=[SQUARE_10, SQUARE_10])).results) == 2
    with pytest.raises(TooManyGeometrySubjectsError):
        service.process_split(_request(subjects=[SQUARE_10, SQUARE_10, SQUARE_10]))


def test_process_split_cuenta_los_puntos_del_corte_en_el_tope_de_vertices():
    # 4 vértices del cuadrado + 2 del corte = 6.
    assert GeometryService(Settings(max_geometry_vertices=6)).process_split(_request()).piece_count == 2
    with pytest.raises(TooManyGeometryVerticesError):
        GeometryService(Settings(max_geometry_vertices=5)).process_split(_request())


def test_process_split_acota_los_puntos_del_corte_y_acepta_exactamente_el_maximo():
    zigzag = [[5, -1], [5, 11]]
    assert GeometryService(Settings(max_geometry_cutter_points=2)).process_split(_request(cutter={"points": zigzag})).piece_count == 2
    with pytest.raises(InvalidParametersError):
        GeometryService(Settings(max_geometry_cutter_points=2)).process_split(_request(cutter={"points": [*zigzag, [6, 11]]}))


def test_process_split_acota_el_ancho_de_la_ranura_solo_en_modo_ranura():
    assert GeometryService(Settings(max_geometry_offset_distance=2.0)).process_split(_request(mode="slot", slot_width=2)).piece_count == 2
    with pytest.raises(InvalidParametersError):
        GeometryService(Settings(max_geometry_offset_distance=2.0)).process_split(_request(mode="slot", slot_width=2.5))
    # En modo dividir el ancho se ignora (no se compara con el tope).
    assert GeometryService(Settings(max_geometry_offset_distance=2.0)).process_split(_request(mode="split", slot_width=50)).piece_count == 2


def test_process_split_aborta_con_timeout_tipado_si_la_operacion_tarda_demasiado():
    def slow_split(subjects, cutter_points, mode, slot_width, extend, tolerance) -> dict:
        time.sleep(0.5)
        return {"results": []}

    service = GeometryService(Settings(geometry_timeout_seconds=0), split_fn=slow_split)

    with pytest.raises(GeometryTimeoutError):
        service.process_split(_request())


def test_process_split_propaga_los_errores_controlados_del_nucleo():
    with pytest.raises(InvalidParametersError):
        GeometryService(Settings()).process_split(_request(cutter={"points": [[3, 3], [3, 3]]}))
