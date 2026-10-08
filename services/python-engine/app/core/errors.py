"""Errores controlados del pipeline de preprocesamiento. Cada subclase lleva un
`code` estable (igual convención que Vectorify.Api.Contracts.ApiErrorResponse: el
frontend/backend mapean por código, no por el texto de `message`). Se traducen a
respuestas JSON `{code, message}` por los exception handlers registrados en
app.main.
"""


class PreprocessingError(Exception):
    """Base de todos los errores controlados de preprocesamiento."""

    code = "processing_error"


class CorruptImageError(PreprocessingError):
    """La imagen no se pudo decodificar: bytes corruptos, vacíos o formato no
    soportado por OpenCV."""

    code = "corrupt_image"


class DimensionsExceededError(PreprocessingError):
    """La imagen decodificada supera los límites de ancho/alto/píxeles totales
    configurados (protección contra "decompression bombs" y agotamiento de
    memoria)."""

    code = "dimensions_exceeded"


class InvalidParametersError(PreprocessingError):
    """Los parámetros recibidos no cumplen el esquema/rangos esperados. Defensa
    en profundidad: Vectorify.Api ya valida rangos antes de llamar a este servicio,
    pero el motor Python nunca confía ciegamente en su caller."""

    code = "invalid_parameters"


class EmptyMaskError(PreprocessingError):
    """La máscara recibida no tiene ningún píxel de foreground (blanco): no hay
    nada que vectorizar. Ver spec.md M1-S05, "Pruebas": "máscara vacía (sin
    contenido) -- debe manejarse como caso controlado, no como crash". Se
    decidió tratarla como error accionable (422) en vez de devolver un SVG
    vacío "exitoso" -- ver reporte del sprint, "Decisiones de diseño"."""

    code = "empty_mask"


class VectorizationTimeoutError(PreprocessingError):
    """El motor de trazado (ver app.core.vector_engine.VectorEngine) tardó más
    que Vectorize:TimeoutSeconds y se abortó. VTracer es una llamada nativa
    (Rust) sin mecanismo de cancelación cooperativa; el timeout se aplica
    desde afuera con un hilo separado (best effort: el hilo de trazado puede
    seguir corriendo en background tras reportar el timeout) -- ver reporte
    del sprint, "Excepciones/limitaciones"."""

    code = "vectorization_timeout"


class VectorizationEngineError(PreprocessingError):
    """El motor de trazado falló de una forma no contemplada por los errores
    de arriba (excepción nativa inesperada). Nunca debería filtrar detalles
    específicos del motor (VTracer) fuera de app.core.vector_engine -- ver
    spec.md M1-S05, Definition of Done."""

    code = "vectorization_engine_error"


class InvalidSvgError(PreprocessingError):
    """El SVG crudo devuelto por el motor de trazado no es XML válido o no
    tiene un elemento <svg> raíz. No debería ocurrir con VTracer (trazado
    geométrico puro) pero se valida de todos modos como defensa en
    profundidad antes de sanitizar/persistir -- ver spec.md M1-S05,
    "Seguridad/robustez"."""

    code = "invalid_svg"


class SvgOutputTooLargeError(PreprocessingError):
    """El SVG sanitizado resultante supera Vectorize:MaxSvgOutputBytes. Límite
    de tamaño de salida explícito, ver spec.md M1-S05, "Seguridad/robustez":
    "límites de ejecución/tamaño"."""

    code = "svg_output_too_large"


class InvalidInputSvgError(PreprocessingError):
    """El SVG recibido como ENTRADA de la etapa de simplificación (M1-S07) --
    un SVG ya generado por una vectorización o simplificación previa -- no es
    UTF-8 válido, no es XML bien formado, o no tiene un elemento <svg> como
    raíz. A diferencia de InvalidSvgError (que cubre el SVG CRUDO recién
    generado por el motor de trazado -- un fallo interno del propio proceso,
    500), esto es un problema del INPUT recibido del caller y se trata como
    error de cliente (400), igual criterio que CorruptImageError."""

    code = "invalid_input_svg"


class SvgInputTooLargeError(PreprocessingError):
    """El SVG de entrada de la etapa de simplificación (M1-S07) supera
    Vectorize:MaxSvgOutputBytes (mismo límite que el tamaño de salida de
    vectorización: un SVG de entrada nunca debería ser más grande que el
    límite que ya se le aplicó cuando se generó)."""

    code = "svg_input_too_large"


class SimplificationTimeoutError(PreprocessingError):
    """La simplificación de nodos (ver
    app.services.simplification_service.SimplificationService) tardó más que
    Simplify:TimeoutSeconds/simplify_timeout_seconds y se abortó. Mismo
    criterio que VectorizationTimeoutError: Douglas-Peucker es puro Python, se
    acota con un hilo separado (best effort, ver
    SimplificationService._simplify_with_timeout)."""

    code = "simplification_timeout"


class CheckTimeoutError(PreprocessingError):
    """El Laser Checker de paths abiertos/duplicados (M1-S08, ver
    app.services.path_checker_service.PathCheckerService) tardó más que
    Check:TimeoutSeconds/check_timeout_seconds y se abortó. Mismo criterio que
    SimplificationTimeoutError: la detección de duplicados es O(n^2) sobre la
    cantidad de subpaths analizables (puro Python), se acota con un hilo
    separado (best effort, ver PathCheckerService._check_with_timeout)."""

    code = "check_timeout"


class ColorPaletteTimeoutError(PreprocessingError):
    """La detección/reducción de paleta de colores (M2-S01, ver
    app.services.color_palette_service.ColorPaletteService) tardó más que
    ColorPalette:TimeoutSeconds/color_palette_timeout_seconds y se abortó.
    Mismo criterio que SimplificationTimeoutError/CheckTimeoutError: el
    clustering es puro Python/NumPy, se acota con un hilo separado (best
    effort, ver ColorPaletteService._detect_with_timeout)."""

    code = "color_palette_timeout"


class TooManySubpathsError(PreprocessingError):
    """El SVG de entrada del Laser Checker de paths (M1-S08) tiene más
    subpaths analizables que Check:MaxSubpaths/max_check_subpaths. Salvaguarda
    de rendimiento explícita (además del timeout): la detección de
    duplicados (ver app.core.path_checker._detect_duplicates) compara todos
    los pares de subpaths (O(n^2)), así que un diseño con una cantidad
    excesiva de subpaths se rechaza de forma controlada en vez de arriesgar
    agotar CPU/memoria antes siquiera de llegar al timeout."""

    code = "too_many_subpaths"


class ComponentAnalysisTimeoutError(PreprocessingError):
    """El análisis de componentes físicos independientes por capa (M2-S03,
    ver app.services.component_analysis_service.ComponentAnalysisService)
    tardó más que Component:TimeoutSeconds/component_timeout_seconds y se
    abortó. Mismo criterio que CheckTimeoutError: la detección de
    contención/contacto entre subpaths es O(n^2) sobre la cantidad de
    subpaths analizables (puro Python), se acota con un hilo separado (best
    effort, ver ComponentAnalysisService._analyze_with_timeout)."""

    code = "component_analysis_timeout"


class PhysicalUnionTimeoutError(PreprocessingError):
    """La unión física de componentes (M2-S06, ver
    app.services.physical_union_service.PhysicalUnionService) tardó más que
    PhysicalUnion:TimeoutSeconds/physical_union_timeout_seconds y se abortó.
    Mismo criterio que ComponentAnalysisTimeoutError: el cómputo (booleanas/
    bridging con Shapely, más la re-validación de componentes sobre el
    resultado) es puro Python/GEOS sin punto de cancelación cooperativa, se
    acota con un hilo separado (best effort, ver
    PhysicalUnionService._union_with_timeout)."""

    code = "physical_union_timeout"


class PhysicalUnionInvalidGeometryError(PreprocessingError):
    """Uno o más de los componentes seleccionados para la unión física
    (M2-S06) tiene geometría autointersectante, degenerada (menos de 3
    puntos, área ~0) o que de cualquier otra forma no se puede procesar de
    forma SEGURA con las operaciones booleanas disponibles (ver
    app.core.physical_union). Deliberadamente NUNCA se intenta "arreglar"
    la geometría inválida en silencio (ej. `buffer(0)` de Shapely, que
    puede alterar la forma sin que el usuario lo sepa) -- se rechaza la
    operación completa con un mensaje explícito en vez de arriesgar un
    resultado corrupto (ver spec.md M2-S06, criterio de aceptación: "nunca
    fingir unión")."""

    code = "physical_union_invalid_geometry"


class PhysicalUnionImpossibleError(PreprocessingError):
    """La unión física (M2-S06) no logró producir una única pieza conexa a
    partir de los componentes seleccionados: tras generar el resultado (
    booleanas para piezas solapadas/tangentes, bridges simples/directos
    para piezas separadas -- ver app.core.physical_union) se reanalizó el
    SVG resultante con EL MISMO analizador de componentes físicos de M2-S03
    (app.core.component_analysis.analyze_svg_components) y la cantidad de
    componentes no coincide con la esperada (las piezas NO seleccionadas
    intactas, más exactamente 1 pieza fusionada a partir de las
    seleccionadas). Ver spec.md M2-S06, criterio de aceptación explícito:
    "Nunca fingir unión si las piezas siguen desconectadas" -- esta
    excepción es la forma en que ese criterio se hace cumplir: la operación
    se rechaza por completo (nunca se persiste un resultado parcial o
    incorrecto) y el mensaje explica el conteo esperado vs. el real."""

    code = "physical_union_impossible"


class TooManySubpathsForComponentsError(PreprocessingError):
    """El SVG de entrada del análisis de componentes físicos (M2-S03) tiene
    más subpaths analizables que Component:MaxSubpaths/max_component_subpaths.
    Salvaguarda de rendimiento explícita (además del timeout), mismo
    criterio que TooManySubpathsError: tanto la detección de contención
    (nesting, O(n^2) con un point-in-polygon O(m) por par) como la de
    contacto/"tocarse" (O(n^2) comparaciones de segmento a segmento) escalan
    con el cuadrado de la cantidad de subpaths -- un diseño con una cantidad
    excesiva se rechaza de forma controlada en vez de arriesgar agotar
    CPU/memoria antes de llegar al timeout."""

    code = "too_many_component_subpaths"


class GeometryTimeoutError(PreprocessingError):
    """La operación booleana del servicio de geometría (M3-S04, ver
    app.services.geometry_service.GeometryService) tardó más que
    Geometry:TimeoutSeconds/geometry_timeout_seconds y se abortó. Mismo
    criterio que PhysicalUnionTimeoutError: el cómputo (Shapely/GEOS) es puro
    Python/C sin punto de cancelación cooperativa, se acota con un hilo
    separado (best effort, ver GeometryService._run_with_timeout)."""

    code = "geometry_timeout"


class GeometryRequestTooLargeError(PreprocessingError):
    """El cuerpo de la petición al servicio de geometría (M3-S04) supera
    max_geometry_request_bytes. Se rechaza antes de parsearlo: es el primer
    tope contra una entrada hostil (el segundo es el conteo de vértices)."""

    code = "geometry_request_too_large"


class TooManyGeometrySubjectsError(PreprocessingError):
    """La petición trae más `subjects` (o `operands`) que
    max_geometry_subjects/max_geometry_operands (M3-S04)."""

    code = "too_many_geometry_subjects"


class TooManyGeometryVerticesError(PreprocessingError):
    """La suma de vértices de todos los subjects y operands supera
    max_geometry_vertices (M3-S04): salvaguarda de CPU/memoria previa al
    timeout, igual criterio que TooManySubpathsError."""

    code = "too_many_geometry_vertices"


class GeometryResultInvalidError(PreprocessingError):
    """El resultado de una operación booleana (M3-S04) no pasó la validación
    final (coordenadas no finitas, polígono inválido tras make_valid). Es un
    fallo del motor, no del caller (500): el cliente NUNCA debe recibir
    geometría inválida, así que se responde error en vez de devolverla."""

    code = "geometry_result_invalid"
