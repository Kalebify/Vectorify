"""Servicio que orquesta las operaciones del servicio de geometría (booleanas
M3-S04/S08 y offset M3-S09, ADR D4): aplica los límites de entrada (cantidad de
subjects/operands y de vértices -- Vectorify.Api ya los valida, pero el motor
Python nunca confía ciegamente en su caller, mismo criterio que
PhysicalUnionService), corre el núcleo puro (app.core.geometry_ops /
app.core.geometry_offset) con timeout y devuelve la respuesta tipada. Sin
estado y sin E/S: no lee ni escribe nada, no conoce proyectos, versiones ni
usuarios.
"""

import concurrent.futures
import math
from typing import Callable

from app.core.config import Settings
from app.core.errors import (
    GeometryTimeoutError,
    InvalidParametersError,
    TooManyGeometrySubjectsError,
    TooManyGeometryVerticesError,
)
from app.core.geometry_offset import run_offset
from app.core.geometry_ops import run_boolean
from app.models.schemas import (
    GeometryBooleanRequest,
    GeometryBooleanResponse,
    GeometryOffsetRequest,
    GeometryOffsetResponse,
    GeometryResultItem,
    OffsetResultItem,
)

BooleanFn = Callable[[str, list[dict], list[dict], float], dict]
OffsetFn = Callable[[list[dict], float, str, float, str, float], dict]


def _vertex_count(geometry: dict) -> int:
    if geometry["type"] == "polygon":
        return sum(len(ring) for ring in geometry["coordinates"])
    if geometry["type"] == "bufferedLine":
        return len(geometry["points"])
    return len(geometry["coordinates"])


class GeometryService:
    def __init__(self, settings: Settings, boolean_fn: BooleanFn | None = None, offset_fn: OffsetFn | None = None) -> None:
        self._settings = settings
        # `boolean_fn`/`offset_fn` inyectables -- mismo criterio que `union_fn` de PhysicalUnionService: simulan una
        # operación lenta en los tests de timeout sin depender de una geometría realmente enorme.
        self._boolean_fn = boolean_fn or run_boolean
        self._offset_fn = offset_fn or run_offset

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

        outcome = self._run_with_timeout(self._boolean_fn, request.operation, subjects, operands, request.tolerance)
        results = [GeometryResultItem(**item) for item in outcome["results"]]
        return GeometryBooleanResponse(
            operation=request.operation,
            scope=outcome["scope"],
            tolerance=request.tolerance,
            results=results,
            piece_count=sum(len(item.geometries) for item in results),
        )

    def process_offset(self, request: GeometryOffsetRequest) -> GeometryOffsetResponse:
        """Offset (M3-S09). Determinista como `process`. Rechaza (422) la distancia 0 o fuera de tope, el límite de inglete fuera de
        rango y, más allá de los topes de subjects/vértices de las booleanas, nada más: el resto lo valida el esquema."""
        if len(request.subjects) > self._settings.max_geometry_subjects:
            raise TooManyGeometrySubjectsError(
                f"La petición trae {len(request.subjects)} subjects; el máximo es {self._settings.max_geometry_subjects}."
            )
        limit = self._settings.max_geometry_offset_distance
        if request.distance == 0 or not math.isfinite(request.distance) or abs(request.distance) > limit:
            raise InvalidParametersError(f"La distancia debe ser distinta de 0 y su valor absoluto no puede superar {limit} (unidades de documento).")
        mitre_max = self._settings.max_geometry_mitre_limit
        if not math.isfinite(request.mitre_limit) or request.mitre_limit <= 0 or request.mitre_limit > mitre_max:
            raise InvalidParametersError(f"El límite de inglete debe estar en el rango (0, {mitre_max}].")

        subjects = [subject.model_dump() for subject in request.subjects]
        vertices = sum(_vertex_count(geometry) for geometry in subjects)
        if vertices > self._settings.max_geometry_vertices:
            raise TooManyGeometryVerticesError(
                f"La petición trae {vertices} vértices; el máximo es {self._settings.max_geometry_vertices}."
            )

        outcome = self._run_with_timeout(
            self._offset_fn, subjects, request.distance, request.join_style, request.mitre_limit, request.cap_style, request.tolerance
        )
        results = [OffsetResultItem(**item) for item in outcome["results"]]
        return GeometryOffsetResponse(
            distance=request.distance,
            join_style=request.join_style,
            mitre_limit=request.mitre_limit,
            cap_style=request.cap_style,
            tolerance=request.tolerance,
            results=results,
            piece_count=sum(len(item.geometries) for item in results),
        )

    def _run_with_timeout(self, operation_fn: Callable[..., dict], *arguments) -> dict:
        """Aplica Geometry:TimeoutSeconds (geometry_timeout_seconds). Mismo criterio (y misma corrección de
        bug conocida del proyecto) que PhysicalUnionService._union_with_timeout: GEOS no tiene punto de
        cancelación cooperativa, así que se ejecuta en un hilo aparte y se abandona si no responde a
        tiempo (nunca `with ThreadPoolExecutor(...)`: su `__exit__` bloquearía hasta que el hilo colgado
        termine, anulando el timeout)."""
        executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        future = executor.submit(operation_fn, *arguments)
        try:
            result = future.result(timeout=self._settings.geometry_timeout_seconds)
        except concurrent.futures.TimeoutError as exc:
            executor.shutdown(wait=False)
            raise GeometryTimeoutError(
                f"La operación de geometría tardó más de {self._settings.geometry_timeout_seconds}s y se abortó."
            ) from exc
        executor.shutdown(wait=True)
        return result
