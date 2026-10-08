"""Tests de integración de POST /api/v1/geometry/boolean vía TestClient (M3-S04): contrato de respuesta,
valores calculados a mano, validación de la entrada (esquema, NaN/Infinity, tolerancia, tipos desconocidos),
límites (subjects, vértices, cuerpo) y errores en el formato uniforme {code, message}.
"""

import json
import math

import pytest
from fastapi.testclient import TestClient
from shapely.geometry import Polygon

from app.api.dependencies import get_geometry_service
from app.core.config import Settings, get_settings
from app.main import app
from app.services.geometry_service import GeometryService

URL = "/api/v1/geometry/boolean"

SQUARE_40 = {"type": "polygon", "coordinates": [[[0, 0], [40, 0], [40, 40], [0, 40]]]}


def _body(**overrides) -> dict:
    body = {
        "operation": "difference",
        "subjects": [SQUARE_40],
        "operands": [{"type": "bufferedLine", "points": [[-10, 20], [50, 20]], "radius": 5}],
        "tolerance": 0.01,
    }
    body.update(overrides)
    return body


def _post(client, body: dict | str | bytes):
    content = body if isinstance(body, (str, bytes)) else json.dumps(body)
    return client.post(URL, content=content, headers={"Content-Type": "application/json"})


def test_boolean_devuelve_el_contrato_esperado_para_un_pincel_que_parte_el_cuadrado(client):
    response = _post(client, _body())

    assert response.status_code == 200
    body = response.json()
    assert body["operation"] == "difference"
    assert body["scope"] == "per_subject"
    assert body["tolerance"] == 0.01
    assert body["piece_count"] == 2
    assert len(body["results"]) == 1
    item = body["results"][0]
    assert item["subject_index"] == 0
    assert item["changed"] is True
    # Franja y 15..25 quitada del 40x40: dos piezas de 40 x 15 = 600 de área cada una.
    areas = [Polygon(piece["coordinates"][0]).area for piece in item["geometries"]]
    assert areas == pytest.approx([600.0, 600.0])
    assert [piece["type"] for piece in item["geometries"]] == ["polygon", "polygon"]


def test_boolean_con_un_poligono_totalmente_cubierto_responde_vacio(client):
    covered = {"type": "polygon", "coordinates": [[[10, 10], [20, 10], [20, 20], [10, 20]]]}
    response = _post(client, _body(subjects=[covered], operands=[SQUARE_40]))

    assert response.status_code == 200
    assert response.json()["results"][0]["geometries"] == []
    assert response.json()["piece_count"] == 0


def test_boolean_con_operando_disjunto_responde_sin_cambios_e_identico(client):
    response = _post(client, _body(operands=[{"type": "polygon", "coordinates": [[[100, 100], [110, 100], [110, 110]]]}]))

    item = response.json()["results"][0]
    assert item["changed"] is False
    assert item["geometries"][0]["coordinates"] == [[[0, 0], [40, 0], [40, 40], [0, 40], [0, 0]]]


def test_boolean_parte_una_linea_con_el_pincel(client):
    line = {"type": "line", "coordinates": [[0, 20], [40, 20]]}
    response = _post(client, _body(subjects=[line], operands=[{"type": "bufferedLine", "points": [[20, 0], [20, 40]], "radius": 2}]))

    pieces = response.json()["results"][0]["geometries"]
    assert [piece["type"] for piece in pieces] == ["line", "line"]
    assert pieces[0]["coordinates"] == [[0, 20], [18, 20]]
    assert pieces[1]["coordinates"] == [[22, 20], [40, 20]]


def test_boolean_union_devuelve_un_resultado_combinado(client):
    squares = [
        {"type": "polygon", "coordinates": [[[0, 0], [20, 0], [20, 20], [0, 20]]]},
        {"type": "polygon", "coordinates": [[[10, 10], [30, 10], [30, 30], [10, 30]]]},
    ]
    response = _post(client, _body(operation="union", subjects=squares, operands=[]))

    body = response.json()
    assert body["scope"] == "combined"
    assert body["results"][0]["subject_index"] is None
    assert Polygon(body["results"][0]["geometries"][0]["coordinates"][0]).area == pytest.approx(700.0)


def test_boolean_normalize_divide_un_mono_en_dos_triangulos(client):
    bowtie = {"type": "polygon", "coordinates": [[[0, 0], [40, 40], [40, 0], [0, 40]]]}
    response = _post(client, _body(operation="normalize", subjects=[bowtie], operands=[]))

    pieces = response.json()["results"][0]["geometries"]
    assert [Polygon(piece["coordinates"][0]).area for piece in pieces] == pytest.approx([400.0, 400.0])


def test_boolean_es_determinista_entre_peticiones_repetidas(client):
    first = _post(client, _body())
    second = _post(client, _body())

    assert first.status_code == second.status_code == 200
    assert first.content == second.content


def test_boolean_acepta_las_cinco_operaciones(client):
    operands = [{"type": "polygon", "coordinates": [[[10, 10], [60, 10], [60, 60], [10, 60]]]}]
    for operation in ("union", "difference", "intersection", "xor", "normalize"):
        assert _post(client, _body(operation=operation, operands=operands)).status_code == 200, operation


@pytest.mark.parametrize(
    "mutation",
    [
        {"operation": "buffer"},  # operación desconocida
        {"subjects": []},  # sin subjects
        {"tolerance": 0},
        {"tolerance": -0.5},
        {"subjects": [{"type": "circle", "coordinates": [[0, 0]]}]},  # tipo desconocido
        {"subjects": [{"type": "polygon", "coordinates": [[[0, 0], [1, 1]]]}]},  # anillo de 2 vértices
        {"subjects": [{"type": "polygon", "coordinates": []}]},  # sin anillos
        {"subjects": [{"type": "line", "coordinates": [[0, 0]]}]},  # línea de 1 punto
        {"subjects": [{"type": "line", "coordinates": [[0, 0, 5], [1, 1, 5]]}]},  # vértices de 3 componentes
        {"operands": [{"type": "bufferedLine", "points": [[0, 0]], "radius": 0}]},
        {"operands": [{"type": "bufferedLine", "points": [], "radius": 1}]},
        {"operands": [{"type": "bufferedLine", "points": [[0, 0]], "radius": -3}]},
        {"subjects": [{"type": "bufferedLine", "points": [[0, 0]], "radius": 1}]},  # un pincel no puede ser subject
        {"subjects": [{"type": "line", "coordinates": [[0, 0], [1e12, 0]]}]},  # fuera de los límites razonables
        {"tolerance": "mucho"},
    ],
)
def test_boolean_rechaza_peticiones_invalidas_con_422_y_formato_uniforme(client, mutation):
    response = _post(client, _body(**mutation))

    assert response.status_code == 422
    body = response.json()
    assert body["code"] == "invalid_parameters"
    assert isinstance(body["message"], str) and body["message"]
    assert "detail" not in body  # no el esquema por defecto de FastAPI


@pytest.mark.parametrize(
    "literal",
    ["NaN", "Infinity", "-Infinity"],
)
def test_boolean_rechaza_nan_e_infinity_en_las_coordenadas(client, literal):
    raw = '{"operation":"difference","subjects":[{"type":"line","coordinates":[[0,0],[%s,5]]}],"operands":[],"tolerance":0.01}' % literal

    response = _post(client, raw)

    assert response.status_code == 422
    assert response.json()["code"] == "invalid_parameters"


def test_boolean_rechaza_nan_en_la_tolerancia_y_en_el_radio(client):
    raw_tolerance = '{"operation":"normalize","subjects":[%s],"operands":[],"tolerance":NaN}' % json.dumps(SQUARE_40)
    raw_radius = (
        '{"operation":"difference","subjects":[%s],"operands":[{"type":"bufferedLine","points":[[0,0]],"radius":Infinity}],"tolerance":0.01}'
        % json.dumps(SQUARE_40)
    )

    for raw in (raw_tolerance, raw_radius):
        response = _post(client, raw)
        assert response.status_code == 422 and response.json()["code"] == "invalid_parameters"


@pytest.mark.parametrize("raw", ["", "esto no es JSON", "[]", "null", "{}"])
def test_boolean_rechaza_cuerpos_que_no_son_la_peticion(client, raw):
    response = _post(client, raw)

    assert response.status_code == 422
    assert response.json()["code"] == "invalid_parameters"


def test_boolean_no_vuelca_el_cuerpo_recibido_en_el_mensaje_de_error(client):
    huge = {"type": "polygon", "coordinates": [[[i, i] for i in range(2000)] + [[0, "x"]]]}

    response = _post(client, _body(subjects=[huge]))

    assert response.status_code == 422
    assert len(response.json()["message"]) < 600


def test_boolean_rechaza_mas_subjects_que_el_maximo_con_422_y_codigo_claro():
    app.dependency_overrides[get_geometry_service] = lambda: GeometryService(Settings(max_geometry_subjects=1))
    try:
        with TestClient(app) as limited:
            response = _post(limited, _body(subjects=[SQUARE_40, SQUARE_40]))

        assert response.status_code == 422
        assert response.json()["code"] == "too_many_geometry_subjects"
    finally:
        app.dependency_overrides.pop(get_geometry_service, None)


def test_boolean_rechaza_mas_vertices_que_el_maximo_con_422_y_codigo_claro():
    app.dependency_overrides[get_geometry_service] = lambda: GeometryService(Settings(max_geometry_vertices=5))
    try:
        with TestClient(app) as limited:
            response = _post(limited, _body())  # 4 + 2 vértices

        assert response.status_code == 422
        assert response.json()["code"] == "too_many_geometry_vertices"
    finally:
        app.dependency_overrides.pop(get_geometry_service, None)


def test_boolean_rechaza_un_cuerpo_demasiado_grande_con_413():
    app.dependency_overrides[get_settings] = lambda: Settings(max_geometry_request_bytes=100)
    try:
        with TestClient(app) as limited:
            response = _post(limited, _body())

        assert response.status_code == 413
        assert response.json()["code"] == "geometry_request_too_large"
    finally:
        app.dependency_overrides.pop(get_settings, None)


def test_boolean_reporta_el_timeout_como_error_tipado_504():
    import time

    def slow_boolean(operation, subjects, operands, tolerance) -> dict:
        time.sleep(0.5)
        return {"scope": "per_subject", "results": []}

    app.dependency_overrides[get_geometry_service] = lambda: GeometryService(
        Settings(geometry_timeout_seconds=0), boolean_fn=slow_boolean
    )
    try:
        with TestClient(app) as slow:
            response = _post(slow, _body())

        assert response.status_code == 504
        assert response.json()["code"] == "geometry_timeout"
    finally:
        app.dependency_overrides.pop(get_geometry_service, None)


def test_boolean_reporta_un_resultado_invalido_del_motor_como_500_y_nunca_lo_devuelve():
    from app.core.errors import GeometryResultInvalidError

    def broken_boolean(operation, subjects, operands, tolerance) -> dict:
        raise GeometryResultInvalidError("polígono inválido")

    app.dependency_overrides[get_geometry_service] = lambda: GeometryService(Settings(), boolean_fn=broken_boolean)
    try:
        with TestClient(app) as broken:
            response = _post(broken, _body())

        assert response.status_code == 500
        assert response.json()["code"] == "geometry_result_invalid"
    finally:
        app.dependency_overrides.pop(get_geometry_service, None)


def test_boolean_la_respuesta_no_contiene_valores_no_finitos(client):
    response = _post(client, _body(operands=[{"type": "bufferedLine", "points": [[0, 0], [40, 40]], "radius": 7}]))

    def values(node):
        if isinstance(node, (int, float)):
            yield node
        elif isinstance(node, list):
            for child in node:
                yield from values(child)
        elif isinstance(node, dict):
            for child in node.values():
                yield from values(child)

    assert all(math.isfinite(value) for value in values(response.json()["results"]))
