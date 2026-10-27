"""Motor de vectorización encapsulado detrás de un Protocol (`VectorEngine`),
tal como pide spec.md M1-S05 explícitamente: "encapsularlo detrás de
interfaz" / Definition of Done: "cambiar de motor no requiere cambiar React".
`VectorizationService` (app.services.vectorization_service) solo conoce este
Protocol, nunca el paquete `vtracer` directamente -- sustituir VTracer por
Potrace en el futuro implica escribir OTRA clase que cumpla `VectorEngine` y
cambiar una única línea de wiring en app.api.dependencies, sin tocar el
servicio, el contrato HTTP ni React.

Motor elegido: VTracer (paquete PyPI `vtracer`). La decisión entre
Potrace/VTracer no la resolvió un spike (no existe esa tarjeta en el board):
se consultó explícitamente al usuario en el chat -- ver spec.md, "Decisión
bloqueante resuelta con el usuario".
"""

import re
import xml.etree.ElementTree as ET
from typing import Protocol

import cv2
import numpy as np

from app.core.errors import VectorizationEngineError
from app.core.svg_path_parsing import extract_subpaths, is_supported_path, local_name, tokenize_path_d


class VectorEngine(Protocol):
    """Contrato mínimo que cualquier motor de trazado debe cumplir: recibe una
    máscara binaria de un canal (0/255) YA decodificada y devuelve el SVG
    crudo (todavía sin sanitizar -- eso lo hace VectorizationService vía
    app.core.svg_processing, es responsabilidad del orquestador, no del
    motor) como string. Ningún parámetro ni detalle propio de una
    implementación concreta (ej. nombres de argumentos de VTracer) debe
    aparecer en esta interfaz.
    """

    def trace(self, mask: np.ndarray) -> str: ...


class VtracerEngine:
    """Implementación de `VectorEngine` sobre el paquete PyPI `vtracer`
    (wheels precompilados, no requiere compilar contra libpotrace+agg en
    Windows -- motivo por el que se eligió sobre Potrace, ver decisión
    documentada en spec.md).

    Detalles de integración verificados empíricamente contra la wheel
    instalada (0.6.15), documentados acá porque son la razón de ser de esta
    clase -- ver reporte del sprint, "Decisiones de diseño":

    1. Inversión de la máscara: en `colormode="binary"`, VTracer trata los
       píxeles NEGROS (valor 0) como la región a rellenar/trazar y los
       BLANCOS (255) como fondo/hueco -- lo inverso de la convención interna
       de Vectorify (Threshold: foreground = 255/blanco, ver
       app.core.threshold_pipeline.compute_threshold_metrics). Sin invertir,
       el resultado sería un path que cubre todo el lienzo con un agujero
       donde debería estar la forma. Por eso se invierte con
       `cv2.bitwise_not` antes de codificar y enviar la máscara al motor.
    2. `mode="polygon"` (en vez de `"spline"`, el default de VTracer): evita
       curvas Bézier (comandos `C`), dejando coordenadas deterministas y
       fáciles de parsear (solo `M`/`L`/`Z`) -- de las que depende
       app.core.svg_processing.compute_svg_stats para bounds/nodos
       aproximados exactos en vez de una aproximación más burda sobre
       puntos de control de curvas.
    3. `hierarchical="stacked"` (el default de VTracer): las formas con
       agujeros internos se representan como un único `<path>` con subpaths
       anidados de sentido de recorrido opuesto (fill-rule por winding), no
       como paths separados -- ver spec.md, "Pruebas": "formas con agujeros
       internos (topología con paths anidados/fill-rule)".
    """

    def trace(self, mask: np.ndarray) -> str:
        import vtracer  # import perezoso: acá vive el único acoplamiento a este motor concreto

        inverted = cv2.bitwise_not(mask)
        success, buffer = cv2.imencode(".png", inverted)
        if not success:
            raise VectorizationEngineError(
                "No se pudo codificar la máscara antes de enviarla al motor de trazado."
            )

        try:
            svg = vtracer.convert_raw_image_to_svg(
                buffer.tobytes(),
                img_format="png",
                colormode="binary",
                hierarchical="stacked",
                mode="polygon",
            )
        except Exception as exc:  # pragma: no cover - vtracer no documenta qué excepciones puede lanzar
            raise VectorizationEngineError(f"El motor de trazado falló: {exc}") from exc

        if not isinstance(svg, str) or not svg.strip():
            raise VectorizationEngineError("El motor de trazado devolvió una respuesta vacía o inválida.")

        return _remove_zero_area_subpaths(svg)



def _remove_zero_area_subpaths(svg: str) -> str:
    """El trazador poligonal puede dejar contornos cerrados colineales.

    No tienen relleno visible y bloquean la fabricación. Quitar SOLO esos
    contornos (no por tamaño ni por área firmada: un cruce puede cancelarla).
    Conservar textualmente los demás subpaths, sus huecos y transforms.
    """
    try:
        root = ET.fromstring(svg)
    except ET.ParseError:
        return svg  # El sanitizador del servicio informa el XML inválido.
    changed = False
    for parent in root.iter():
        for path in list(parent):
            if local_name(path.tag) != "path":
                continue
            d = path.get("d", "")
            commands = tokenize_path_d(d)
            if not is_supported_path(commands):
                continue
            subpaths = extract_subpaths(commands)
            chunks = re.findall(r"M[^M]*", d)
            if len(subpaths) != len(chunks):
                continue
            kept = []
            for chunk, subpath in zip(chunks, subpaths):
                points = subpath["points"]
                collinear = True
                if points:
                    origin = points[0]
                    second = next((point for point in points if point != origin), origin)
                    dx, dy = second[0] - origin[0], second[1] - origin[1]
                    collinear = all(dx * (y - origin[1]) == dy * (x - origin[0]) for x, y in points)
                if subpath["closed"] and collinear:
                    changed = True
                else:
                    kept.append(chunk.strip())
            if len(kept) == len(chunks):
                continue
            if kept:
                path.set("d", " ".join(kept))
            else:
                parent.remove(path)
    if not changed:
        return svg
    ET.register_namespace("", "http://www.w3.org/2000/svg")
    return ET.tostring(root, encoding="unicode")
