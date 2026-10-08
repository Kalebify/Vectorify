"""Servicio que orquesta las operaciones booleanas del servicio de geometría
(M3-S04, ADR D4): aplica los límites de entrada (cantidad de subjects/operands
y de vértices -- Vectorify.Api ya los valida, pero el motor Python nunca confía
ciegamente en su caller, mismo criterio que PhysicalUnionService), corre el
núcleo puro de app.core.geometry_ops con timeout y devuelve la respuesta
tipada. Sin estado y sin E/S: no lee ni escribe nada, no conoce proyectos,
versiones ni usuarios.
"""

import concurrent.futures
from typing import Callable

from app.core.config import Settings
from app.core.errors import GeometryTimeoutError, TooManyGeometrySubjectsError, TooManyGeometryVerticesError
from app.core.geometry_ops import run_boolean
from app.models.schemas import GeometryBooleanRequest, GeometryBooleanResponse, GeometryResultItem

BooleanFn = Callable[[str, list[dict], list[dict], float], dict]


def _vertex_count(geometry: dict) -> int:
    if geometry["type"] == "polygon":
        return sum(len(ring) for ring in geometry["coordinates"])
    if geometry["type"] == "bufferedLine":
        return len(geometry["points"])
    return len(geometry["coordinates"])


class GeometryService:
    def __init__(self, settings: Settings, boolean_fn: BooleanFn | None = None) -> None:
        self._settings = settings
        # `boolean_fn` inyectable -- mismo criterio que `union_fn` de PhysicalUnionService: simula una
        # operación lenta en los tests de timeout sin depender de una geometría realmente enorme.
        self._boolean_fn = boolean_fn or run_boolean

    def process(self, request: GeometryBooleanRequest) -> GeometryBooleanResponse:
        """Determinista: mismos `request` siempre producen la misma respuesta (o el mismo error)."""
        if len(request.subjects) > self._settings.max_geometry_subjects:
            raise TooManyGeometrySubjectsError(
                f"La petición trae {len(request.subjects)} subjects; el máximo es {self._settings.max_geometry_subjects}."
            )
        if len(request.operands) > self._settings.max_geometry_operands:
            raise TooManyGeometrySubjectsError(
                f"La petición trae {len(request.operands)} operands; el máximo es {self._settings.max_geometry_operands}."
            )

        subjects = [subject.model_dump() for subject in request.subjects]
        operands = [operand.model_dump() for operand in request.operands]
        vertices = sum(_vertex_count(geometry) for geometry in subjects) + sum(_vertex_count(geometry) for geometry in operands)
        if vertices > self._settings.max_geometry_vertices:
            raise TooManyGeometryVerticesError(
                f"La petición trae {vertices} vértices; el máximo es {self._settings.max_geometry_vertices}."
            )

        outcome = self._run_with_timeout(request.operation, subjects, operands, request.tolerance)
        results = [GeometryResultItem(**item) for item in outcome["results"]]
        return GeometryBooleanResponse(
            operation=request.operation,
            scope=outcome["scope"],
            tolerance=request.tolerance,
            results=results,
            piece_count=sum(len(item.geometries) for item in results),
        )

    def _run_with_timeout(self, operation: str, subjects: list[dict], operands: list[dict], tolerance: float) -> dict:
        """Aplica Geometry:TimeoutSeconds (geometry_timeout_seconds). Mismo criterio (y misma corrección de
        bug conocida del proyecto) que PhysicalUnionService._union_with_timeout: GEOS no tiene punto de
        cancelación cooperativa, así que se ejecuta en un hilo aparte y se abandona si no responde a
        tiempo (nunca `with ThreadPoolExecutor(...)`: su `__exit__` bloquearía hasta que el hilo colgado
        termine, anulando el timeout)."""
        executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        future = executor.submit(self._boolean_fn, operation, subjects, operands, tolerance)
        try:
            result = future.result(timeout=self._settings.geometry_timeout_seconds)
        except concurrent.futures.TimeoutError as exc:
            executor.shutdown(wait=False)
            raise GeometryTimeoutError(
                f"La operación de geometría tardó más de {self._settings.geometry_timeout_seconds}s y se abortó."
            ) from exc
        executor.shutdown(wait=True)
        return result
