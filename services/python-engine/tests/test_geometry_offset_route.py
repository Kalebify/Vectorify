"""Tests de integración de POST /api/v1/geometry/offset vía TestClient (M3-S09) y del servicio de orquestación
(GeometryService.process_offset): contrato de respuesta con valores calculados a mano, validación de la entrada
(esquema, NaN/Infinity, distancia, join/cap, inglete, líneas con distancia interior), límites (subjects, vértices,
cuerpo, tope de distancia) y errores en el formato uniforme {code, message}; timeout inyectado como fake.
"""

import json
import math
import time

import pytest
from fastapi.testclient import TestClient
from shapely.geometry import Polygon

from app.api.dependencies import get_geometry_service
from app.core.config import Settings, get_settings
from app.core.errors import GeometryTimeoutError, InvalidParametersError, TooManyGeometrySubjectsError, TooManyGeometryVerticesError
from app.main import app
from app.models.schemas import GeometryOffsetRequest
from app.services.geometry_service import GeometryService

URL = "/api/v1/geometry/offset"

RECT_40_20 = {"type": "polygon", "coordinates": [[[0, 0], [40, 0], [40, 20], [0, 20]]]}
LINE_10 = {"type": "line", "coordinates": [[0, 0], [10, 0]]}


def _body(**overrides) -> dict:
    body = {
        "subjects": [RECT_40_20],
        "distance": 3,
        "join_style": "mitre",
        "mitre_limit": 2,
        "cap_style": "round",
        "tolerance": 0.01,
    }
    body.update(overrides)
    return body


def _post(client, body: dict | str | bytes):
    content = body if isinstance(body, (str, bytes)) else json.dumps(body)
    return client.post(URL, content=content, headers={"Content-Type": "application/json"})


def _override_service(service: GeometryService):
    app.dependency_overrides[get_geometry_service] = lambda: service


def _request(**overrides) -> GeometryOffsetRequest:
    return GeometryOffsetRequest.model_validate(_body(**overrides))


# ---- Ruta: contrato ----


def test_offset_devuelve_el_contrato_esperado_para_un_rectangulo_con_inglete(client):
    response = _post(client, _body())

    assert response.status_code == 200
    body = response.json()
    assert body["distance"] == 3
    assert body["join_style"] == "mitre"
    assert body["mitre_limit"] == 2
    assert body["cap_style"] == "round"
    assert body["tolerance"] == 0.01
    assert body["piece_count"] == 1
    assert len(body["results"]) == 1
    item = body["results"][0]
    assert item["subject_index"] == 0
    assert item["collapsed"] is False
    assert (item["pieces_before"], item["split_count"], item["lost_pieces"]) == (1, 1, 0)
    assert (item["holes_before"], item["holes_after"]) == (0, 0)
    assert item["max_inward_offset"] == pytest.approx(10.0, abs=0.01)
    # (40 + 6) x (20 + 6) = 1196.
    assert Polygon(item["geometries"][0]["coordinates"][0]).area == pytest.approx(1196.0)
    assert item["geometries"][0]["type"] == "polygon"


def test_offset_interior_que_colapsa_responde_vacio_y_lo_dice(client):
    response = _post(client, _body(distance=-10))

    item = response.json()["results"][0]
    assert response.status_code == 200
    assert item["geometries"] == []
    assert item["collapsed"] is True
    assert item["lost_pieces"] == 1
    assert response.json()["piece_count"] == 0


def test_offset_de_una_linea_responde_un_poligono_con_el_cap_pedido(client):
    response = _post(client, _body(subjects=[LINE_10], distance=1, cap_style="square", join_style="round"))

    item = response.json()["results"][0]
    assert Polygon(item["geometries"][0]["coordinates"][0]).area == pytest.approx(24.0)
    assert item["max_inward_offset"] is None


def test_offset_responde_un_resultado_por_subject_y_en_orden(client):
    small = {"type": "polygon", "coordinates": [[[0, 0], [4, 0], [4, 4], [0, 4]]]}
    response = _post(client, _body(subjects=[RECT_40_20, small, LINE_10], distance=-1.5))

    # El tercero es una línea con distancia interior: toda la petición se rechaza en vez de reinterpretarla.
    assert response.status_code == 422
    ok = _post(client, _body(subjects=[RECT_40_20, small], distance=-1.5, join_style="mitre"))
    results = ok.json()["results"]
    assert [item["subject_index"] for item in results] == [0, 1]
    assert [item["collapsed"] for item in results] == [False, False]
    assert Polygon(results[1]["geometries"][0]["coordinates"][0]).area == pytest.approx(1.0)  # (4 - 3) x (4 - 3)


def test_offset_usa_los_valores_por_defecto_de_join_mitre_cap_y_tolerancia_requerida(client):
    minimal = {"subjects": [RECT_40_20], "distance": 3, "tolerance": 0.01}

    response = _post(client, minimal)

    body = response.json()
    assert response.status_code == 200
    assert (body["join_style"], body["mitre_limit"], body["cap_style"]) == ("round", 2, "round")


def test_offset_es_determinista_entre_peticiones_repetidas(client):
    first = _post(client, _body(join_style="round"))
    second = _post(client, _body(join_style="round"))

    assert first.status_code == second.status_code == 200
    assert first.content == second.content


def test_offset_la_respuesta_no_contiene_valores_no_finitos(client):
    response = _post(client, _body(join_style="round", distance=7))

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

    assert all(math.isfinite(value) for value in values(response.json()["results"]))


# ---- Ruta: validación ----


@pytest.mark.parametrize(
    "mutation",
    [
        {"subjects": []},
        {"tolerance": 0},
        {"tolerance": -0.5},
        {"tolerance": "mucho"},
        {"join_style": "miter"},  # estilo desconocido
        {"cap_style": "butt"},
        {"distance": "mucho"},
        {"subjects": [{"type": "circle", "coordinates": [[0, 0]]}]},
        {"subjects": [{"type": "bufferedLine", "points": [[0, 0]], "radius": 1}]},  # un pincel no es un subject
        {"subjects": [{"type": "polygon", "coordinates": [[[0, 0], [1, 1]]]}]},
        {"subjects": [{"type": "line", "coordinates": [[0, 0]]}]},
        {"subjects": [{"type": "line", "coordinates": [[0, 0], [1e12, 0]]}]},
    ],
)
def test_offset_rechaza_peticiones_invalidas_con_422_y_formato_uniforme(client, mutation):
    response = _post(client, _body(**mutation))

    assert response.status_code == 422
    body = response.json()
    assert body["code"] == "invalid_parameters"
    assert isinstance(body["message"], str) and body["message"]
    assert "detail" not in body


@pytest.mark.parametrize("field", ["subjects", "distance", "tolerance"])
def test_offset_rechaza_una_peticion_sin_los_campos_obligatorios(client, field):
    body = _body()
    del body[field]

    response = _post(client, body)

    assert response.status_code == 422
    assert response.json()["code"] == "invalid_parameters"


@pytest.mark.parametrize("distance", [0, 0.0, 1_000_001, -1_000_001])
def test_offset_rechaza_distancia_cero_o_fuera_del_tope(client, distance):
    response = _post(client, _body(distance=distance))

    assert response.status_code == 422
    assert response.json()["code"] == "invalid_parameters"


def test_offset_acepta_la_distancia_justo_en_el_tope():
    _override_service(GeometryService(Settings(max_geometry_offset_distance=5.0)))
    try:
        with TestClient(app) as limited:
            assert _post(limited, _body(distance=5)).status_code == 200
            assert _post(limited, _body(distance=-5)).status_code == 200
            assert _post(limited, _body(distance=5.0001)).status_code == 422
    finally:
        app.dependency_overrides.pop(get_geometry_service, None)


@pytest.mark.parametrize("mitre_limit", [0, -1, 101])
def test_offset_rechaza_un_limite_de_inglete_fuera_de_rango(client, mitre_limit):
    response = _post(client, _body(mitre_limit=mitre_limit))

    assert response.status_code == 422
    assert response.json()["code"] == "invalid_parameters"


def test_offset_rechaza_la_distancia_interior_con_lineas_en_vez_de_reinterpretarla(client):
    response = _post(client, _body(subjects=[LINE_10], distance=-1))

    assert response.status_code == 422
    assert response.json()["code"] == "invalid_parameters"
    assert "línea" in response.json()["message"]


@pytest.mark.parametrize("literal", ["NaN", "Infinity", "-Infinity"])
def test_offset_rechaza_nan_e_infinity_en_las_coordenadas_la_distancia_y_el_inglete(client, literal):
    square = json.dumps(RECT_40_20)
    templates = [
        '{"subjects":[{"type":"line","coordinates":[[0,0],[%s,5]]}],"distance":1,"tolerance":0.01}' % literal,
        '{"subjects":[%s],"distance":%s,"tolerance":0.01}' % (square, literal),
        '{"subjects":[%s],"distance":1,"mitre_limit":%s,"tolerance":0.01}' % (square, literal),
        '{"subjects":[%s],"distance":1,"tolerance":%s}' % (square, literal),
    ]

    for raw in templates:
        response = _post(client, raw)
        assert response.status_code == 422, raw
        assert response.json()["code"] == "invalid_parameters", raw


@pytest.mark.parametrize("raw", ["", "esto no es JSON", "[]", "null", "{}"])
def test_offset_rechaza_cuerpos_que_no_son_la_peticion(client, raw):
    response = _post(client, raw)

    assert response.status_code == 422
    assert response.json()["code"] == "invalid_parameters"


def test_offset_no_vuelca_el_cuerpo_recibido_en_el_mensaje_de_error(client):
    huge = {"type": "polygon", "coordinates": [[[i, i] for i in range(2000)] + [[0, "x"]]]}

    response = _post(client, _body(subjects=[huge]))

    assert response.status_code == 422
    assert len(response.json()["message"]) < 600


# ---- Ruta: límites y errores del motor ----


def test_offset_rechaza_mas_subjects_que_el_maximo_con_422_y_codigo_claro():
    _override_service(GeometryService(Settings(max_geometry_subjects=1)))
    try:
        with TestClient(app) as limited:
            response = _post(limited, _body(subjects=[RECT_40_20, RECT_40_20]))

        assert response.status_code == 422
        assert response.json()["code"] == "too_many_geometry_subjects"
    finally:
        app.dependency_overrides.pop(get_geometry_service, None)


def test_offset_rechaza_mas_vertices_que_el_maximo_con_422_y_codigo_claro():
    _override_service(GeometryService(Settings(max_geometry_vertices=3)))
    try:
        with TestClient(app) as limited:
            response = _post(limited, _body())  # 4 vértices

        assert response.status_code == 422
        assert response.json()["code"] == "too_many_geometry_vertices"
    finally:
        app.dependency_overrides.pop(get_geometry_service, None)


def test_offset_rechaza_un_cuerpo_demasiado_grande_con_413():
    app.dependency_overrides[get_settings] = lambda: Settings(max_geometry_request_bytes=100)
    try:
        with TestClient(app) as limited:
            response = _post(limited, _body())

        assert response.status_code == 413
        assert response.json()["code"] == "geometry_request_too_large"
    finally:
        app.dependency_overrides.pop(get_settings, None)


def test_offset_reporta_el_timeout_como_error_tipado_504():
    def slow_offset(subjects, distance, join_style, mitre_limit, cap_style, tolerance) -> dict:
        time.sleep(0.5)
        return {"results": []}

    _override_service(GeometryService(Settings(geometry_timeout_seconds=0), offset_fn=slow_offset))
    try:
        with TestClient(app) as slow:
            response = _post(slow, _body())

        assert response.status_code == 504
        assert response.json()["code"] == "geometry_timeout"
    finally:
        app.dependency_overrides.pop(get_geometry_service, None)


def test_offset_reporta_un_resultado_invalido_del_motor_como_500_y_nunca_lo_devuelve():
    from app.core.errors import GeometryResultInvalidError

    def broken_offset(subjects, distance, join_style, mitre_limit, cap_style, tolerance) -> dict:
        raise GeometryResultInvalidError("polígono inválido")

    _override_service(GeometryService(Settings(), offset_fn=broken_offset))
    try:
        with TestClient(app) as broken:
            response = _post(broken, _body())

        assert response.status_code == 500
        assert response.json()["code"] == "geometry_result_invalid"
    finally:
        app.dependency_overrides.pop(get_geometry_service, None)


# ---- Servicio ----


def test_process_offset_devuelve_la_respuesta_tipada_del_nucleo_y_es_reproducible():
    service = GeometryService(Settings())

    response = service.process_offset(_request())

    assert (response.distance, response.join_style, response.mitre_limit, response.cap_style, response.tolerance) == (3, "mitre", 2, "round", 0.01)
    assert response.piece_count == 1
    assert response.results[0].subject_index == 0
    assert response.results[0].max_inward_offset == pytest.approx(10.0, abs=0.01)
    assert service.process_offset(_request()) == response


def test_process_offset_cuenta_las_piezas_de_todos_los_resultados():
    dumbbell = {"type": "polygon", "coordinates": [[[0, 0], [20, 0], [20, 8], [30, 8], [30, 0], [50, 0], [50, 20], [30, 20], [30, 12], [20, 12], [20, 20], [0, 20]]]}
    response = GeometryService(Settings()).process_offset(_request(subjects=[dumbbell, RECT_40_20], distance=-3))

    # La mancuerna se parte en 2 piezas y el rectángulo queda en 1.
    assert [item.split_count for item in response.results] == [2, 1]
    assert response.piece_count == 3


def test_process_offset_rechaza_mas_subjects_que_el_maximo_y_acepta_exactamente_el_maximo():
    service = GeometryService(Settings(max_geometry_subjects=2))

    assert len(service.process_offset(_request(subjects=[RECT_40_20, RECT_40_20])).results) == 2
    with pytest.raises(TooManyGeometrySubjectsError):
        service.process_offset(_request(subjects=[RECT_40_20, RECT_40_20, RECT_40_20]))


def test_process_offset_acepta_exactamente_el_maximo_de_vertices():
    assert GeometryService(Settings(max_geometry_vertices=4)).process_offset(_request()).piece_count == 1
    with pytest.raises(TooManyGeometryVerticesError):
        GeometryService(Settings(max_geometry_vertices=3)).process_offset(_request())


def test_process_offset_aborta_con_timeout_tipado_si_la_operacion_tarda_demasiado():
    def slow_offset(subjects, distance, join_style, mitre_limit, cap_style, tolerance) -> dict:
        time.sleep(0.5)
        return {"results": []}

    service = GeometryService(Settings(geometry_timeout_seconds=0), offset_fn=slow_offset)

    with pytest.raises(GeometryTimeoutError):
        service.process_offset(_request())


def test_process_offset_propaga_los_errores_controlados_del_nucleo():
    with pytest.raises(InvalidParametersError):
        GeometryService(Settings()).process_offset(_request(subjects=[LINE_10], distance=-1))


def test_process_offset_el_tope_de_la_distancia_y_del_inglete_son_configurables():
    assert GeometryService(Settings(max_geometry_mitre_limit=5.0)).process_offset(_request(mitre_limit=5)).piece_count == 1
    with pytest.raises(InvalidParametersError):
        GeometryService(Settings(max_geometry_mitre_limit=5.0)).process_offset(_request(mitre_limit=5.5))
    with pytest.raises(InvalidParametersError):
        GeometryService(Settings(max_geometry_offset_distance=2.0)).process_offset(_request(distance=3))
