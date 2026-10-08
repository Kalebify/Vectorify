"""Configuración del motor Python, leída de variables de entorno (o un
archivo .env local). Nada crítico queda hardcodeado: host, puerto, nombre
de servicio, versión y nivel de log son todos configurables.
"""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    service_name: str = "vectorify-python-engine"
    service_version: str = "0.1.0"
    host: str = "0.0.0.0"
    port: int = 8000
    log_level: str = "info"

    # Límites del pipeline de preprocesamiento (M1-S03). spec.md no cuantifica
    # "dimensiones excesivas"; estos valores son un supuesto documentado (ver
    # reporte del sprint): suficientes para imágenes de trabajo típicas de
    # tracing/vectorización sin arriesgar agotar memoria en un solo proceso.
    max_image_width: int = 6000
    max_image_height: int = 6000
    max_image_pixels: int = 25_000_000

    # Límites de la etapa de vectorización (M1-S05). spec.md tampoco los
    # cuantifica ("Ambigüedades detectadas" en spec.md); supuesto documentado
    # en el reporte del sprint. vectorize_timeout_seconds es un presupuesto
    # interno del proceso Python (ver app.services.vectorization_service),
    # independiente y menor al timeout HTTP configurado del lado de
    # Vectorify.Api (Vectorize:TimeoutSeconds), para que el error tipado de
    # Python llegue a tiempo en vez de que el cliente HTTP corte primero.
    vectorize_timeout_seconds: int = 25
    max_svg_output_bytes: int = 5_000_000

    # Límites de la etapa de simplificación de nodos (M1-S07). spec.md
    # tampoco los cuantifica ("Valores numéricos concretos de los presets
    # Bajo/Medio/Alto ... no bloqueante, el implementador elige y documenta");
    # supuesto documentado en el reporte del sprint. simplify_timeout_seconds
    # es un presupuesto interno del proceso Python (ver
    # app.services.simplification_service), independiente y menor al timeout
    # HTTP configurado del lado de Vectorify.Api (Simplify:TimeoutSeconds), mismo
    # criterio que vectorize_timeout_seconds. El SVG de entrada reutiliza
    # max_svg_output_bytes como límite de tamaño (nunca debería ser más grande
    # que el límite que ya se le aplicó al generarlo).
    simplify_timeout_seconds: int = 15

    # Límites del Laser Checker de paths abiertos/duplicados (M1-S08). spec.md
    # tampoco los cuantifica ("Valor(es) de tolerancia por defecto no están
    # cuantificados -- no bloqueante, el implementador elige y documenta");
    # supuesto documentado en el reporte del sprint. check_timeout_seconds es
    # un presupuesto interno del proceso Python (ver
    # app.services.path_checker_service), mismo criterio que
    # simplify_timeout_seconds. max_check_subpaths acota la cantidad de
    # subpaths analizables antes de intentar la detección de duplicados
    # (O(n^2) sobre esa cantidad) -- ver app.core.errors.TooManySubpathsError.
    check_timeout_seconds: int = 15
    max_check_subpaths: int = 20_000

    # Detección/reducción de paleta de colores (M2-S01). spec.md tampoco
    # cuantifica tolerancia/número objetivo de colores ("Ambigüedades
    # detectadas": "el implementador decide y documenta"); supuestos
    # documentados en el reporte del sprint. color_palette_timeout_seconds es
    # un presupuesto interno del proceso Python (mismo criterio que
    # simplify_timeout_seconds/check_timeout_seconds): el clustering es CPU-
    # bound puro Python/NumPy, se acota con un hilo separado.
    color_palette_timeout_seconds: int = 20

    # Tolerancia por defecto (distancia euclídea en espacio Lab -- ver
    # app.core.color_palette_pipeline) para fusionar automáticamente dos
    # colores "casi iguales" durante el clustering determinista. El rango
    # [0, 100] cubre holgadamente el espacio Lab de OpenCV (L,a,b en [0,255]
    # tras su escalado a 8 bits): una tolerancia de 100 ya fusiona casi
    # cualquier par de colores.
    color_palette_default_tolerance: float = 12.0
    color_palette_min_tolerance: float = 0.0
    color_palette_max_tolerance: float = 100.0

    # Límite superior opcional de colores en la paleta resultante (fusiona
    # los clusters más parecidos entre sí hasta entrar en el presupuesto).
    color_palette_min_colors: int = 1
    color_palette_max_colors_upper_bound: int = 64

    # M2.1-S02: umbral de "grupo diminuto" (relativo a los píxeles
    # relevantes, ver app.core.color_palette_pipeline._merge_tiny_groups_into_nearest)
    # para fusionar automáticamente hacia el vecino más cercano los grupos
    # que la explosión de colores por antialiasing genera (auditoría
    # M2.1-S01: 17 grupos en vez de ~5 lógicos). 0.001 (0.1%) es un supuesto
    # documentado con evidencia empírica en el reporte del sprint: en el
    # fixture de reproducción (ilustración con antialiasing en sol/techo),
    # los 11 grupos "ruido" miden como máximo 0.0756% del área relevante y
    # los 6 colores lógicos miden como mínimo 1.1844% -- 0.001 separa ambos
    # grupos con margen de ~10x hacia cada lado. Mismo estilo relativo que
    # component_default_tiny_area_ratio (ver más abajo), valor distinto
    # porque el dominio es otro (área de un grupo de color vs. área de un
    # componente físico de corte) y la evidencia empírica de este caso
    # concreto lo respalda. Espejado 1:1 en
    # Vectorify.Api.Options.ColorPaletteOptions (DefaultTinyAreaRatio, etc.),
    # mismo criterio que color_palette_default_tolerance -- Vectorify.Api
    # siempre envía el valor ya resuelto explícitamente, este default de acá
    # solo aplica cuando se llama a Python directamente (tests/uso manual).
    color_palette_default_tiny_area_ratio: float = 0.001
    color_palette_min_tiny_area_ratio: float = 0.0
    color_palette_max_tiny_area_ratio: float = 0.5

    # Componentes físicos independientes por capa (M2-S03). spec.md no
    # cuantifica el criterio exacto de "tocarse" ni el umbral de "componente
    # diminuto" ("el implementador decide y documenta"); supuestos
    # documentados en el reporte del sprint, mismo estilo que
    # Check:DefaultCloseGapRatio/DefaultDuplicatePointRatio (M1-S08):
    # component_default_touch_ratio (0.1% de la diagonal del SVG) es más
    # estricto que la tolerancia de "casi cerrado" de M1-S08 (0.5%) a
    # propósito -- "tocarse" acá decide si dos piezas se fusionan en una sola
    # (una decisión de mayor impacto que solo avisar de un posible defecto),
    # así que el umbral es más conservador. component_default_tiny_area_ratio
    # (0.05% del área total del bounding box de la capa) NO filtra
    # componentes diminutos (ver app.core.component_analysis): se reportan
    # igual, marcados `is_tiny`, porque en el dominio de corte láser una
    # pieza real -aunque chica- nunca debería desaparecer en silencio.
    # component_timeout_seconds es un presupuesto interno del proceso Python
    # (mismo criterio que check_timeout_seconds): tanto la detección de
    # contención como la de contacto son O(n^2) puro Python, se acotan con un
    # hilo separado. max_component_subpaths acota la cantidad de subpaths
    # analizables antes de intentar ambos análisis O(n^2).
    component_timeout_seconds: int = 15
    max_component_subpaths: int = 20_000
    component_default_touch_ratio: float = 0.001
    component_default_tiny_area_ratio: float = 0.0005
    component_min_touch_ratio: float = 0.0
    component_max_touch_ratio: float = 0.5
    component_min_tiny_area_ratio: float = 0.0
    component_max_tiny_area_ratio: float = 0.5

    # Unión física de piezas (M2-S06). Reutiliza EXACTAMENTE los mismos
    # component_default_touch_ratio/component_default_tiny_area_ratio/
    # max_component_subpaths de arriba para el criterio de "tocarse"/
    # "diminuto"/salvaguarda de rendimiento (ver spec.md, "Ambigüedades
    # detectadas": "el implementador reutiliza el mismo criterio de
    # tolerancia relativa ya establecido en M2-S03") -- ver
    # app.models.schemas.PhysicalUnionParams, que espeja esos mismos
    # valores como default. physical_union_timeout_seconds es un
    # presupuesto interno del proceso Python (mismo criterio que
    # component_timeout_seconds): el cómputo booleano/bridging con Shapely
    # más la re-validación de componentes del resultado es CPU-bound puro
    # Python/GEOS, se acota con un hilo separado.
    # physical_union_default_bridge_width_ratio (2% de la diagonal del SVG
    # completo) es un supuesto documentado (spec.md no lo cuantifica): lo
    # bastante ancho para que el bridge sea una pieza físicamente cortable
    # con láser (no una línea infinitesimal), lo bastante angosto para no
    # invadir visualmente piezas cercanas no seleccionadas en el caso común.
    physical_union_timeout_seconds: int = 20
    physical_union_default_bridge_width_ratio: float = 0.02
    physical_union_min_bridge_width_ratio: float = 0.001
    physical_union_max_bridge_width_ratio: float = 0.5

    # Servicio de geometría del servidor (M3-S04, ADR D4): operaciones booleanas
    # sin estado sobre anillos de polígonos / polilíneas en unidades de
    # documento (ver app.core.geometry_ops). spec.md fija los topes de entrada:
    # 500 subjects y 500 000 vértices en total; `max_geometry_operands` (mismo
    # valor que los subjects) y `max_geometry_request_bytes` (~64 bytes por
    # vértice como cota holgada del JSON de 500 000 vértices) son supuestos
    # documentados en el IMPL del sprint. geometry_timeout_seconds es un
    # presupuesto interno del proceso Python, menor al timeout HTTP del lado de
    # Vectorify.Api (Geometry:TimeoutSeconds), mismo criterio que
    # physical_union_timeout_seconds.
    geometry_timeout_seconds: int = 15
    max_geometry_subjects: int = 500
    max_geometry_operands: int = 500
    max_geometry_vertices: int = 500_000
    max_geometry_request_bytes: int = 32_000_000

    # Validación raster-vs-vector por capa (M2.1-S03): después de vectorizar
    # la máscara de una capa, se rasteriza el SVG resultante de vuelta (ver
    # app.core.raster_validation.rasterize_svg_mask) y se compara contra (a)
    # la propia máscara de origen (`own_mismatch_ratio`) y (b) la unión de las
    # máscaras de las DEMÁS capas de la misma paleta (`contamination_ratio`,
    # la señal "crucial" pedida por spec.md: contaminación cruzada entre
    # colores). spec.md no cuantifica ninguno de los dos umbrales
    # ("Ambigüedades detectadas": "el implementador decide y documenta");
    # valores elegidos con evidencia empírica documentada en el reporte del
    # sprint (script de reproducción, mismo criterio que
    # color_palette_default_tiny_area_ratio):
    #
    # raster_validation_own_mismatch_tolerance = 0.15 (15%): el peor caso
    # observado NO es un bug sino aproximación geométrica genuina de formas
    # curvas chicas (VtracerEngine mode="polygon" aproxima círculos con un
    # número finito de vértices) -- un círculo de radio 5px midió 9.88% de
    # mismatch, uno de radio 8px 5.58%, ninguna forma con bordes rectos midió
    # más de 0% (una vez corregido el sesgo de rasterización de +1 fila/
    # columna de cv2.fillPoly, ver raster_validation.py). 15% deja ~1.5x de
    # margen sobre el peor caso observado (círculo de 5px) sin dejar de ser
    # sensible a errores reales (una capa vectorizada a partir de la máscara
    # EQUIVOCADA mide un mismatch mucho más alto, típicamente >50-90%).
    #
    # raster_validation_contamination_tolerance = 0.01 (1%): el peor caso
    # observado de DOS colores CONTIGUOS (que se tocan en un borde recto,
    # sin solaparse -- el caso de "falso positivo" que spec.md pide evitar
    # explícitamente) midió como máximo 0.2% de contaminación (lienzos
    # grandes, donde el presupuesto de supermuestreo cae a escala 1x); la
    # mayoría de los casos (lienzos chicos/medianos, escala 8x) midieron
    # exactamente 0%. 1% deja ~5x de margen sobre el peor caso observado,
    # mientras sigue siendo un umbral mucho más estricto que
    # own_mismatch_tolerance a propósito: contaminación cruzada es la señal
    # de mayor impacto (geometría de un color invadiendo el territorio de
    # otro) que esta tarjeta pide priorizar.
    raster_validation_own_mismatch_tolerance: float = 0.15
    raster_validation_contamination_tolerance: float = 0.01

    # Salvaguarda de rendimiento: si la imagen tiene más colores únicos que
    # esto (fotografías/degradés de tono continuo, no el caso de uso
    # principal de esta herramienta -- logos/diseños gráficos para corte
    # láser), se re-cuantiza el color a menos niveles por canal antes de
    # clusterizar, para acotar el costo O(k) del armado de clusters y el
    # O(k^2) de la fusión hacia `max_colors` -- ver
    # app.core.color_palette_pipeline.extract_unique_colors.
    max_palette_unique_colors: int = 512


@lru_cache
def get_settings() -> Settings:
    return Settings()
