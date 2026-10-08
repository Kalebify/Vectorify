"""Tests del servicio de orquestación del servicio de geometría (GeometryService, M3-S04): límites de
entrada (subjects/operands/vértices), timeout inyectado como fake, reproducibilidad y que la respuesta
tipada refleje el resultado del núcleo. Mismo criterio que test_physical_union_service.py.
"""

import time

import pytest

from app.core.config import Settings
from app.core.errors import GeometryTimeoutError, TooManyGeometrySubjectsError, TooManyGeometryVerticesError
from app.models.schemas import GeometryBooleanRequest
from app.services.geometry_service import GeometryService


def _request(**overrides) -> GeometryBooleanRequest:
    body = {
        "operation": "difference",
        "subjects": [{"type": "polygon", "coordinates": [[[0, 0], [40, 0], [40, 40], [0, 40]]]}],
        "operands": [{"type": "polygon", "coordinates": [[[10, 10], [20, 10], [20, 20], [10, 20]]]}],
        "tolerance": 0.01,
    }
    body.update(overrides)
    return GeometryBooleanRequest.model_validate(body)


def _square_subject(x: float) -> dict:
    return {"type": "polygon", "coordinates": [[[x, 0], [x + 1, 0], [x + 1, 1], [x, 1]]]}


def test_process_devuelve_la_respuesta_tipada_del_nucleo():
    response = GeometryService(Settings()).process(_request())

    assert response.operation == "difference"
    assert response.scope == "per_subject"
    assert response.tolerance == 0.01
    assert response.piece_count == 1
    assert len(response.results) == 1
    assert response.results[0].subject_index == 0
    assert response.results[0].changed is True
    assert len(response.results[0].geometries[0].coordinates) == 2  # exterior + hueco


def test_process_es_reproducible_para_la_misma_peticion():
    service = GeometryService(Settings())

    assert service.process(_request()) == service.process(_request())


def test_process_cuenta_las_piezas_de_todos_los_resultados():
    request = _request(
        subjects=[_square_subject(0), _square_subject(10), _square_subject(20)],
        operands=[{"type": "polygon", "coordinates": [[[0.4, -1], [0.6, -1], [0.6, 2], [0.4, 2]]]}],
    )

    response = GeometryService(Settings()).process(request)

    # Solo el primer cuadrado se parte (2 piezas); los otros dos quedan intactos (1 pieza cada uno).
    assert [len(item.geometries) for item in response.results] == [2, 1, 1]
    assert response.piece_count == 4
    assert [item.changed for item in response.results] == [True, False, False]


def test_process_rechaza_mas_subjects_que_el_maximo():
    service = GeometryService(Settings(max_geometry_subjects=2))

    with pytest.raises(TooManyGeometrySubjectsError):
        service.process(_request(subjects=[_square_subject(0), _square_subject(5), _square_subject(10)]))


def test_process_acepta_exactamente_el_maximo_de_subjects():
    service = GeometryService(Settings(max_geometry_subjects=2))

    response = service.process(_request(subjects=[_square_subject(0), _square_subject(5)]))

    assert len(response.results) == 2


def test_process_rechaza_mas_operands_que_el_maximo():
    service = GeometryService(Settings(max_geometry_operands=1))
    operand = {"type": "bufferedLine", "points": [[0, 0], [1, 1]], "radius": 1}

    with pytest.raises(TooManyGeometrySubjectsError):
        service.process(_request(operands=[operand, operand]))


def test_process_rechaza_mas_vertices_que_el_maximo_sumando_subjects_y_operands():
    # 4 vértices del subject + 4 del operando = 8 > 7.
    service = GeometryService(Settings(max_geometry_vertices=7))

    with pytest.raises(TooManyGeometryVerticesError):
        service.process(_request())


def test_process_acepta_exactamente_el_maximo_de_vertices():
    service = GeometryService(Settings(max_geometry_vertices=8))

    assert service.process(_request()).piece_count == 1


def test_process_cuenta_los_puntos_de_un_pincel_como_vertices():
    service = GeometryService(Settings(max_geometry_vertices=5))
    brush = {"type": "bufferedLine", "points": [[0, 0], [1, 0]], "radius": 1}  # 2 vértices + 4 del subject = 6 > 5

    with pytest.raises(TooManyGeometryVerticesError):
        service.process(_request(operands=[brush]))


def test_process_aborta_con_timeout_tipado_si_la_operacion_tarda_demasiado():
    def slow_boolean(operation, subjects, operands, tolerance) -> dict:
        time.sleep(0.5)
        return {"scope": "per_subject", "results": []}

    service = GeometryService(Settings(geometry_timeout_seconds=0), boolean_fn=slow_boolean)

    with pytest.raises(GeometryTimeoutError):
        service.process(_request())


def test_process_propaga_los_errores_controlados_del_nucleo():
    from app.core.errors import InvalidParametersError

    with pytest.raises(InvalidParametersError):
        GeometryService(Settings()).process(_request(operation="intersection", operands=[]))
