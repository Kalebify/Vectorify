"""Tests de integración de POST /api/v1/geometry/floating y /api/v1/geometry/bridge vía TestClient (M3-S11) y del servicio de orquestación
(GeometryService.process_floating / process_bridge): contrato de respuesta con valores calculados a mano, validación de la entrada (esquema,
NaN/Infinity, modo, bridge sin isla ni ancla, ancho/largo/tolerancia), límites (subjects, vértices, bridges, cuerpo) y errores en el formato
uniforme {code, message}; timeout inyectado como fake.
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
from app.models.schemas import GeometryBridgeRequest, GeometryFloatingRequest
from app.services.geometry_service import GeometryService

FLOATING_URL = "/api/v1/geometry/floating"
BRIDGE_URL = "/api/v1/geometry/bridge"

# Anillo cuadrado de 20 con hueco de 10 centrado (espesor 5).
RING = {"type": "polygon", "coordinates": [[[0, 0], [20, 0], [20, 20], [0, 20]], [[5, 5], [15, 5], [15, 15], [5, 15]]]}
DOT = {"type": "polygon", "coordinates": [[[8, 8], [12, 8], [12, 12], [8, 12]]]}


def _floating_body(**overrides) -> dict:
    body = {"subjects": [RING], "mode": "stencil", "tolerance": 0.01}
    body.update(overrides)
    return body


def _bridge_body(**overrides) -> dict:
    body = {"subjects": [RING], "mode": "stencil", "bridges": [{"island": 1, "width": 0.8}], "suggest": False, "tolerance": 0.01}
    body.update(overrides)
    return body


def _post(client, url: str, body: dict | str | bytes):
    content = body if isinstance(body, (str, bytes)) else json.dumps(body)
    return client.post(url, content=content, headers={"Content-Type": "application/json"})


def _override_service(service: GeometryService):
    app.dependency_overrides[get_geometry_service] = lambda: service


def _floating_request(**overrides) -> GeometryFloatingRequest:
    return GeometryFloatingRequest.model_validate(_floating_body(**overrides))


def _bridge_request(**overrides) -> GeometryBridgeRequest:
    return GeometryBridgeRequest.model_validate(_bridge_body(**overrides))


def _area(piece: dict) -> float:
    return Polygon(piece["coordinates"][0], piece["coordinates"][1:]).area


# ---- /floating: contrato ----


def test_floating_devuelve_el_contrato_esperado_para_la_isla_de_una_o(client):
    response = _post(client, FLOATING_URL, _floating_body())

    assert response.status_code == 200
    body = response.json()
    assert (body["mode"], body["tolerance"], body["floating_count"], body["main_count"], body["discarded"]) == ("stencil", 0.01, 1, 1, 0)
    sheet, island = body["components"]
    assert (sheet["kind"], sheet["polygon"], sheet["area"], sheet["parent"]) == ("principal", None, None, None)
    assert (island["id"], island["kind"], island["depth"], island["parent"], island["subjects"]) == (1, "floating", 1, 0, [0])
    assert island["area"] == pytest.approx(100.0) and _area(island["polygon"]) == pytest.approx(100.0)
    assert island["bounds"] == [5, 5, 15, 15]


def test_floating_en_modo_piezas_detecta_el_punto_dentro_de_la_o(client):
    body = _post(client, FLOATING_URL, _floating_body(subjects=[RING, DOT], mode="parts")).json()

    assert (body["floating_count"], body["main_count"]) == (1, 1)
    assert [component["kind"] for component in body["components"]] == ["principal", "floating"]
    assert body["components"][1]["area"] == pytest.approx(16.0)
    assert body["components"][1]["subjects"] == [1]


def test_floating_acepta_locked_y_no_cambia_el_analisis(client):
    locked = _post(client, FLOATING_URL, _floating_body(subjects=[{**RING, "locked": True}])).json()
    plain = _post(client, FLOATING_URL, _floating_body()).json()

    assert locked == plain


def test_floating_es_determinista_entre_peticiones_repetidas(client):
    first = _post(client, FLOATING_URL, _floating_body(subjects=[RING, DOT], mode="parts"))
    second = _post(client, FLOATING_URL, _floating_body(subjects=[RING, DOT], mode="parts"))

    assert first.status_code == second.status_code == 200
    assert first.content == second.content


# ---- /floating: validación ----


@pytest.mark.parametrize(
    "overrides",
    [
        {"mode": "hueco"},
        {"mode": "STENCIL"},
        {"mode": None},
        {"tolerance": 0},
        {"tolerance": -1},
        {"tolerance": 1_000_001},
        {"subjects": []},
        {"subjects": [{"type": "line", "coordinates": [[0, 0], [1, 1]]}]},  # un trazo abierto no es una forma de relleno
        {"subjects": [{"type": "polygon", "coordinates": [[[0, 0], [1, 1]]]}]},  # anillo de 2 vértices
        {"subjects": [{**RING, "locked": "si"}]},
        {"subjects": [{"type": "polygon", "coordinates": [[[0, 0], [1e12, 0], [1, 1]]]}]},
    ],
)
def test_floating_rechaza_un_cuerpo_invalido_con_422_uniforme(client, overrides):
    response = _post(client, FLOATING_URL, _floating_body(**overrides))

    assert response.status_code == 422
    assert response.json()["code"] == "invalid_parameters"


@pytest.mark.parametrize("literal", ["NaN", "Infinity", "-Infinity"])
@pytest.mark.parametrize(
    "overrides",
    [{"tolerance": "@@"}, {"subjects": [{"type": "polygon", "coordinates": [[[0, 0], ["@@", 0], [10, 10]]]}]}],
)
def test_floating_rechaza_nan_e_infinity(client, literal, overrides):
    content = json.dumps(_floating_body(**overrides)).replace('"@@"', literal)

    response = _post(client, FLOATING_URL, content)

    assert response.status_code == 422
    assert response.json()["code"] == "invalid_parameters"


@pytest.mark.parametrize("payload", ["", "{", "[]", "null", '{"subjects": 1}'])
def test_floating_rechaza_json_malformado_o_de_otra_forma(client, payload):
    assert _post(client, FLOATING_URL, payload).status_code == 422


# ---- /bridge: contrato ----


def test_bridge_devuelve_el_contrato_esperado(client):
    response = _post(client, BRIDGE_URL, _bridge_body())

    assert response.status_code == 200
    body = response.json()
    assert (body["mode"], body["tolerance"], body["piece_count"]) == ("stencil", 0.01, 1)
    assert body["reanalysis"] == {"floating_before": 1, "floating_after": 0, "main_after": 1}
    item = body["bridges"][0]
    assert (item["index"], item["suggested"], item["valid"], item["reason"], item["island"], item["reduces"], item["affects"]) == (0, False, True, None, 1, True, [0])
    assert item["length"] == pytest.approx(5.0) and item["area"] == pytest.approx(4.0)  # 0,8 x 5
    assert item["width"] == 0.8 and item["direction"]["x"] in (-1, 0, 1) and set(item["anchor"]) == {"x", "y"}
    assert _area(item["polygon"]) == pytest.approx(0.8 * 5.04)  # 5 de hueco + 2 · (2 · tolerancia) de solape
    result = body["results"][0]
    assert (result["subject_index"], result["changed"]) == (0, True)
    assert sum(_area(piece) for piece in result["geometries"]) == pytest.approx(300.0 - 4.0)


def test_bridge_un_bridge_invalido_responde_200_con_el_motivo_y_sin_cambios(client):
    body = _post(client, BRIDGE_URL, _bridge_body(bridges=[{"island": 1, "width": 1.0, "length": 2.0}])).json()

    assert (body["bridges"][0]["valid"], body["bridges"][0]["reason"]) == (False, "too_short")
    assert body["results"] == [{"subject_index": 0, "changed": False, "geometries": []}]
    assert body["reanalysis"]["floating_after"] == 1 and body["piece_count"] == 0


def test_bridge_suggest_devuelve_los_bridges_sugeridos(client):
    body = _post(client, BRIDGE_URL, _bridge_body(bridges=[], suggest=True, suggest_width=0.5)).json()

    assert [(item["suggested"], item["valid"], item["width"]) for item in body["bridges"]] == [(True, True, 0.5)]
    assert body["reanalysis"]["floating_after"] == 0


def test_bridge_respeta_locked_y_lo_informa(client):
    body = _post(client, BRIDGE_URL, _bridge_body(subjects=[{**RING, "locked": True}])).json()

    assert (body["bridges"][0]["valid"], body["bridges"][0]["reason"]) == (False, "locked_subject")
    assert body["results"][0]["changed"] is False


def test_bridge_en_modo_piezas_suma_ancho_por_largo(client):
    body = _post(client, BRIDGE_URL, _bridge_body(subjects=[RING, DOT], mode="parts", bridges=[{"island": 1, "width": 1.5}])).json()

    assert body["bridges"][0]["area"] == pytest.approx(1.5 * 3.0)  # el hueco entre el punto (x 8..12) y el borde del hueco (x 5..15): 3
    assert [result["changed"] for result in body["results"]] == [False, True]
    assert body["reanalysis"] == {"floating_before": 1, "floating_after": 0, "main_after": 1}


def test_bridge_es_determinista_y_no_contiene_valores_no_finitos(client):
    first = _post(client, BRIDGE_URL, _bridge_body(bridges=[], suggest=True, suggest_width=0.8))
    second = _post(client, BRIDGE_URL, _bridge_body(bridges=[], suggest=True, suggest_width=0.8))

    assert first.content == second.content
    assert "NaN" not in first.text and "Infinity" not in first.text


# ---- /bridge: validación ----


@pytest.mark.parametrize(
    "overrides",
    [
        {"bridges": [{"width": 1.0}]},  # ni isla ni ancla
        {"bridges": [{"island": 1}]},  # sin ancho
        {"bridges": [{"island": 1, "width": 0}]},
        {"bridges": [{"island": 1, "width": -1}]},
        {"bridges": [{"island": -1, "width": 1}]},
        {"bridges": [{"island": 1, "width": 1, "length": 0}]},
        {"bridges": [{"anchor": {"x": 1}, "width": 1}]},
        {"bridges": [{"anchor": {"x": 1, "y": 1e12}, "width": 1}]},
        {"bridges": [{"island": 1, "width": 1, "direction": {"x": 1}}]},
        {"bridges": "uno"},
        {"suggest": True, "bridges": []},  # suggest sin suggest_width
        {"suggest": "si", "suggest_width": 1},
        {"suggest_width": 0},
        {"mode": "hueco"},
        {"tolerance": 0},
        {"subjects": []},
    ],
)
def test_bridge_rechaza_un_cuerpo_invalido_con_422_uniforme(client, overrides):
    response = _post(client, BRIDGE_URL, _bridge_body(**overrides))

    assert response.status_code == 422
    assert response.json()["code"] == "invalid_parameters"


@pytest.mark.parametrize("literal", ["NaN", "Infinity", "-Infinity"])
@pytest.mark.parametrize(
    "overrides",
    [
        {"bridges": [{"island": 1, "width": "@@"}]},
        {"bridges": [{"island": 1, "width": 1, "length": "@@"}]},
        {"bridges": [{"anchor": {"x": "@@", "y": 1}, "width": 1}]},
        {"bridges": [{"island": 1, "width": 1, "direction": {"x": 1, "y": "@@"}}]},
        {"suggest": True, "suggest_width": "@@"},
        {"tolerance": "@@"},
    ],
)
def test_bridge_rechaza_nan_e_infinity_en_cualquier_campo_numerico(client, literal, overrides):
    content = json.dumps(_bridge_body(**overrides)).replace('"@@"', literal)

    response = _post(client, BRIDGE_URL, content)

    assert response.status_code == 422
    assert response.json()["code"] == "invalid_parameters"


# ---- Límites y errores ----


def test_floating_y_bridge_rechazan_demasiados_subjects_con_422_tipado():
    app.dependency_overrides[get_geometry_service] = lambda: GeometryService(Settings(max_geometry_subjects=2))
    try:
        with TestClient(app) as limited:
            ok = _post(limited, FLOATING_URL, _floating_body(subjects=[RING, RING]))
            floating = _post(limited, FLOATING_URL, _floating_body(subjects=[RING, RING, RING]))
            bridge = _post(limited, BRIDGE_URL, _bridge_body(subjects=[RING, RING, RING]))

        assert ok.status_code == 200
        assert (floating.status_code, bridge.status_code) == (422, 422)
        assert floating.json()["code"] == bridge.json()["code"] == "too_many_geometry_subjects"
    finally:
        app.dependency_overrides.pop(get_geometry_service, None)


def test_floating_y_bridge_rechazan_un_cuerpo_demasiado_grande_con_413():
    app.dependency_overrides[get_settings] = lambda: Settings(max_geometry_request_bytes=100)
    try:
        with TestClient(app) as limited:
            floating = _post(limited, FLOATING_URL, _floating_body())
            bridge = _post(limited, BRIDGE_URL, _bridge_body())

        assert (floating.status_code, bridge.status_code) == (413, 413)
        assert floating.json()["code"] == "geometry_request_too_large"
    finally:
        app.dependency_overrides.pop(get_settings, None)


def test_floating_y_bridge_reportan_el_timeout_como_error_tipado_504():
    def slow_floating(subjects, mode, tolerance) -> dict:
        time.sleep(0.5)
        return {}

    def slow_bridge(subjects, mode, bridges, suggest, suggest_width, tolerance) -> dict:
        time.sleep(0.5)
        return {}

    _override_service(GeometryService(Settings(geometry_timeout_seconds=0), floating_fn=slow_floating, bridge_fn=slow_bridge))
    try:
        with TestClient(app) as slow:
            floating = _post(slow, FLOATING_URL, _floating_body())
            bridge = _post(slow, BRIDGE_URL, _bridge_body())

        assert (floating.status_code, bridge.status_code) == (504, 504)
        assert floating.json()["code"] == bridge.json()["code"] == "geometry_timeout"
    finally:
        app.dependency_overrides.pop(get_geometry_service, None)


def test_bridge_reporta_un_resultado_invalido_del_motor_como_500_y_nunca_lo_devuelve():
    from app.core.errors import GeometryResultInvalidError

    def broken(subjects, mode, bridges, suggest, suggest_width, tolerance) -> dict:
        raise GeometryResultInvalidError("rectángulo inválido")

    _override_service(GeometryService(Settings(), bridge_fn=broken))
    try:
        with TestClient(app) as broken_client:
            response = _post(broken_client, BRIDGE_URL, _bridge_body())

        assert response.status_code == 500
        assert response.json()["code"] == "geometry_result_invalid"
    finally:
        app.dependency_overrides.pop(get_geometry_service, None)


# ---- Servicio ----


def test_process_floating_devuelve_la_respuesta_tipada_del_nucleo_y_es_reproducible():
    service = GeometryService(Settings())

    response = service.process_floating(_floating_request())

    assert (response.mode, response.tolerance, response.floating_count, response.main_count) == ("stencil", 0.01, 1, 1)
    assert [component.kind for component in response.components] == ["principal", "floating"]
    assert service.process_floating(_floating_request()) == response


def test_process_floating_acepta_exactamente_el_maximo_de_subjects_y_rechaza_uno_mas():
    service = GeometryService(Settings(max_geometry_subjects=2))

    assert service.process_floating(_floating_request(subjects=[RING, RING])).floating_count == 1
    with pytest.raises(TooManyGeometrySubjectsError):
        service.process_floating(_floating_request(subjects=[RING, RING, RING]))


def test_process_floating_acota_los_vertices_en_total():
    # El anillo tiene 8 vértices.
    assert GeometryService(Settings(max_geometry_vertices=8)).process_floating(_floating_request()).floating_count == 1
    with pytest.raises(TooManyGeometryVerticesError):
        GeometryService(Settings(max_geometry_vertices=7)).process_floating(_floating_request())


def test_process_bridge_devuelve_la_respuesta_tipada_cuenta_piezas_y_es_reproducible():
    service = GeometryService(Settings())

    response = service.process_bridge(_bridge_request())

    assert response.reanalysis.floating_before == 1 and response.reanalysis.floating_after == 0
    assert response.piece_count == 1 and response.bridges[0].valid
    assert service.process_bridge(_bridge_request()) == response


def test_process_bridge_acota_la_cantidad_de_bridges_y_acepta_exactamente_el_maximo():
    two = [{"island": 1, "width": 1}, {"island": 1, "width": 2}]
    service = GeometryService(Settings(max_geometry_bridges=2))

    assert len(service.process_bridge(_bridge_request(bridges=two)).bridges) == 2
    with pytest.raises(InvalidParametersError):
        service.process_bridge(_bridge_request(bridges=[*two, {"island": 1, "width": 3}]))


def test_process_bridge_acota_el_ancho_y_el_largo():
    service = GeometryService(Settings(max_geometry_offset_distance=2.0))

    assert service.process_bridge(_bridge_request(bridges=[{"island": 1, "width": 2.0, "length": 2.0}])).bridges[0].width == 2.0
    with pytest.raises(InvalidParametersError):
        service.process_bridge(_bridge_request(bridges=[{"island": 1, "width": 2.5}]))
    with pytest.raises(InvalidParametersError):
        service.process_bridge(_bridge_request(bridges=[{"island": 1, "width": 1.0, "length": 2.5}]))
    with pytest.raises(InvalidParametersError):
        service.process_bridge(_bridge_request(bridges=[], suggest=True, suggest_width=2.5))


def test_process_bridge_acota_subjects_y_vertices():
    with pytest.raises(TooManyGeometrySubjectsError):
        GeometryService(Settings(max_geometry_subjects=1)).process_bridge(_bridge_request(subjects=[RING, RING]))
    with pytest.raises(TooManyGeometryVerticesError):
        GeometryService(Settings(max_geometry_vertices=7)).process_bridge(_bridge_request())


def test_process_floating_y_bridge_abortan_con_timeout_tipado_si_la_operacion_tarda_demasiado():
    def slow(*_arguments) -> dict:
        time.sleep(0.5)
        return {}

    service = GeometryService(Settings(geometry_timeout_seconds=0), floating_fn=slow, bridge_fn=slow)

    with pytest.raises(GeometryTimeoutError):
        service.process_floating(_floating_request())
    with pytest.raises(GeometryTimeoutError):
        service.process_bridge(_bridge_request())
