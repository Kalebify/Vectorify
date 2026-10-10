"""Modelos tipados de respuesta. Contrato inicial consumido por ASP.NET Core:
GET /health -> { status, service, version }.
"""

from typing import Annotated, Literal

from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
    status: str = Field(examples=["ok"])
    service: str = Field(examples=["vectorify-python-engine"])
    version: str = Field(examples=["0.1.0"])


class InfoResponse(BaseModel):
    service: str = Field(examples=["vectorify-python-engine"])
    version: str = Field(examples=["0.1.0"])
    capabilities: list[str] = Field(
        examples=[["health-check"]],
        description=(
            "Capacidades habilitadas del motor. En este sprint fundacional "
            "no hay vectorización real; solo el chequeo de salud."
        ),
    )


class PreprocessParams(BaseModel):
    """Parámetros ajustables del pipeline de preprocesamiento (M1-S03).

    spec.md no cuantifica rangos numéricos ("Ambigüedades detectadas"); los
    límites de acá son la fuente de verdad del lado Python y deben coincidir
    con los que valida Vectorify.Api (Preprocessing/PreprocessOptions) antes de
    llamar a este servicio — documentado como supuesto en el reporte del
    sprint.
    """

    grayscale: bool = Field(False, description="Convierte la imagen a escala de grises")
    contrast: float = Field(1.0, ge=0.5, le=3.0, description="Factor multiplicativo de contraste (1.0 = sin cambio)")
    brightness: int = Field(0, ge=-100, le=100, description="Offset aditivo de brillo (0 = sin cambio)")
    denoise: int = Field(0, ge=0, le=10, description="Intensidad de suavizado/reducción de ruido (0 = sin cambio)")


class PreprocessMetrics(BaseModel):
    mean_brightness: float = Field(examples=[128.4])
    std_dev: float = Field(examples=[42.1])
    min_value: int = Field(examples=[0])
    max_value: int = Field(examples=[255])


class PreprocessResponse(BaseModel):
    """Respuesta de POST /api/v1/preprocess. Consumida únicamente por
    Vectorify.Api (el navegador nunca llama directamente a este motor); por eso
    el resultado viaja como imagen embebida en base64 en vez de un archivo
    binario separado, para mantener un único contrato JSON simple de testear
    de forma determinista.
    """

    image_base64: str = Field(description="Preview codificado como PNG, en base64")
    content_type: str = Field(default="image/png", examples=["image/png"])
    width: int
    height: int
    original_width: int
    original_height: int
    effective_params: PreprocessParams
    metrics: PreprocessMetrics


class ThresholdParams(BaseModel):
    """Parámetros ajustables de la etapa de threshold B/N (M1-S04): umbral
    global y su inversión. Rangos alineados con Vectorify.Api.Options.ThresholdOptions
    (defensa en profundidad, mismo criterio que PreprocessParams). El modo
    adaptativo (vs. global) se decidió no incluir en este sprint -- ver
    reporte del sprint.
    """

    value: int = Field(128, ge=0, le=255, description="Umbral global (0 = todo negro, 255 = todo blanco)")
    invert: bool = Field(False, description="Invierte blanco/negro del resultado")


class ThresholdMetrics(BaseModel):
    """Porcentaje crudo de píxeles foreground/background de la máscara
    resultante. La clasificación de "casi vacía/casi llena" como advertencia
    se calcula del lado de Vectorify.Api (Threshold/ThresholdService.cs), no acá.
    """

    foreground_percent: float = Field(examples=[42.3], ge=0, le=100)
    background_percent: float = Field(examples=[57.7], ge=0, le=100)


class ThresholdResponse(BaseModel):
    """Respuesta de POST /api/v1/threshold. Igual convención que
    PreprocessResponse: consumida únicamente por Vectorify.Api, la máscara viaja
    embebida en base64 para mantener un único contrato JSON simple de testear
    de forma determinista.
    """

    image_base64: str = Field(description="Máscara binaria codificada como PNG, en base64")
    content_type: str = Field(default="image/png", examples=["image/png"])
    width: int
    height: int
    effective_params: ThresholdParams
    metrics: ThresholdMetrics


class VectorBounds(BaseModel):
    """Caja delimitadora (aproximada -- ver
    app.core.svg_processing.compute_svg_stats) del contenido dibujado, en las
    mismas unidades que el `viewBox`/coordenadas del SVG (no necesariamente
    igual al lienzo completo: un logo pequeño centrado en una máscara grande
    tiene bounds más chicos que width/height). Ver spec.md M1-S05: "devolver
    estadísticas como ... bounds"."""

    min_x: float
    min_y: float
    max_x: float
    max_y: float
    width: float
    height: float


class VectorMetrics(BaseModel):
    """Estadísticas del SVG YA sanitizado. `approx_node_count` es aproximado a
    propósito (ver spec.md, criterios de aceptación: "nodos aproximados"):
    cuenta comandos de trazado (M/L/C), no un conteo geométrico exacto de
    vértices tras posibles optimizaciones futuras del motor."""

    path_count: int = Field(examples=[1], ge=0)
    approx_node_count: int = Field(examples=[4], ge=0)
    bounds: VectorBounds


class VectorizeResponse(BaseModel):
    """Respuesta de POST /api/v1/vectorize. Misma convención que
    Preprocess/ThresholdResponse (consumida únicamente por Vectorify.Api), pero
    el SVG viaja como texto plano en `svg` (no base64): es XML/texto válido,
    no bytes binarios, así que no hace falta codificarlo -- FastAPI/Pydantic
    ya lo serializan como un string JSON correctamente escapado."""

    svg: str = Field(description="Marcado SVG YA sanitizado (ver app.core.svg_processing.sanitize_svg)")
    content_type: str = Field(default="image/svg+xml", examples=["image/svg+xml"])
    width: int
    height: int
    metrics: VectorMetrics


class RasterValidationResult(BaseModel):
    """Resultado de comparar, para UNA capa, la geometría vectorial
    resultante contra su máscara raster de origen (M2.1-S03) -- ver
    app.core.raster_validation.compare_layer_raster. Análisis de SOLO
    LECTURA: nunca bloquea la generación de la capa (ver spec.md,
    "Ambigüedades detectadas": "advertir, no bloquear" -- decisión
    documentada en el reporte del sprint), solo la reporta."""

    own_mismatch_ratio: float = Field(
        ge=0,
        description=(
            "Fracción de píxeles donde el SVG rasterizado de vuelta difiere de su propia "
            "máscara de origen, relativa al área de foreground de esa máscara."
        ),
    )
    own_mismatch_tolerance: float = Field(ge=0, description="Tolerancia aplicada -- ver Settings.raster_validation_own_mismatch_tolerance.")
    own_mismatch_within_tolerance: bool
    contamination_ratio: float = Field(
        ge=0,
        description=(
            "Fracción del área rasterizada de ESTA capa que cae dentro de la unión de las "
            "máscaras de las DEMÁS capas de la misma paleta -- señal de contaminación cruzada "
            "entre colores (spec.md, 'Validación': 'evitar que regiones de otro color aparezcan "
            "dentro del layer seleccionado')."
        ),
    )
    contamination_tolerance: float = Field(ge=0, description="Tolerancia aplicada -- ver Settings.raster_validation_contamination_tolerance.")
    contamination_within_tolerance: bool
    warnings: list[str] = Field(
        default_factory=list,
        description="Mensajes legibles, uno por métrica fuera de tolerancia (vacío si ambas están dentro).",
    )


class VectorLayerItem(BaseModel):
    """Un color/grupo vectorizado de forma INDEPENDIENTE (M2-S02): mismo
    contrato que VectorizeResponse (svg/content_type/width/height/metrics) --
    reutiliza VectorizationService.process máscara por máscara, sin
    reinventar el trazado de contornos ya usado en M1-S05 -- con el agregado
    de `group_id`. `group_id` es opaco para Python (el GUID de ColorGroup que
    ya administra Vectorify.Api del lado de ColorPalette/M2-S01): se echoa tal
    cual se recibió, únicamente para que Vectorify.Api pueda emparejar cada SVG
    con su ColorGroup de origen sin depender de que el orden de la lista se
    preserve en el transporte. `raster_validation` (M2.1-S03, NUEVO): resultado
    de comparar esta capa contra su máscara de origen y contra las demás
    máscaras de la paleta -- ver RasterValidationResult."""

    group_id: str = Field(description="Identificador del ColorGroup de origen, echoado tal cual se recibió.")
    svg: str = Field(description="Marcado SVG YA sanitizado de esta capa (ver app.core.svg_processing.sanitize_svg)")
    content_type: str = Field(default="image/svg+xml", examples=["image/svg+xml"])
    width: int
    height: int
    metrics: VectorMetrics
    raster_validation: RasterValidationResult


class VectorizeLayersResponse(BaseModel):
    """Respuesta de POST /api/v1/vectorize-layers (M2-S02): una capa vectorial
    por cada máscara de color recibida, cada una vectorizada de forma
    independiente. Una única llamada .NET -> Python resuelve las N
    vectorizaciones (VectorizationService.process llamado N veces DENTRO de
    esta request), en vez de que Vectorify.Api dispare N requests HTTP
    separadas -- ver spec.md M2-S02, "Ambigüedades detectadas". Ninguna
    máscara se recorta a su propio bounding box antes de vectorizarla: todas
    comparten las dimensiones de la imagen original, así que los SVG
    resultantes ya comparten el mismo sistema de coordenadas/viewBox y
    encajan exactamente superpuestos sin normalización adicional de este
    lado (ver spec.md, "normalización de coordenadas")."""

    layers: list[VectorLayerItem]


class SimplifyParams(BaseModel):
    """Parámetros de la etapa de simplificación de nodos (M1-S07): tolerancia
    relativa de Douglas-Peucker (ver app.core.simplification_pipeline), como
    fracción de la diagonal del bounding box del SVG de ENTRADA -- así escala
    con el tamaño del diseño en vez de ser un valor absoluto en píxeles (ver
    "Ambigüedades detectadas" de spec.md: "el implementador elige y
    documenta"). Los presets Bajo/Medio/Alto que ve el usuario en React no
    existen acá: se resuelven a este valor numérico del lado de
    Vectorify.Api.Simplification.SimplificationOptions antes de llamar a este
    servicio -- Python solo conoce el epsilon ya resuelto, nunca el nombre del
    preset (mismo criterio de encapsulamiento que app.core.vector_engine).
    """

    epsilon_ratio: float = Field(
        ...,
        gt=0,
        le=0.5,
        description="Tolerancia de Douglas-Peucker, relativa a la diagonal del bounding box del SVG (0, 0.5]",
    )


class SimplifyMetrics(BaseModel):
    """Nodos antes/después y % de reducción -- spec.md M1-S07, criterios de
    aceptación: "Reducción de nodos es medible y reportada (nodeCount antes,
    nodeCount después, % reducción) tanto en la respuesta del motor Python
    como en lo que ve el usuario en React". Reutiliza VectorMetrics (mismo
    par path_count/approx_node_count/bounds que devuelve la vectorización) en
    vez de duplicar su forma."""

    before: VectorMetrics
    after: VectorMetrics
    reduction_percent: float = Field(examples=[42.0], ge=0, le=100)


class SimplifyResponse(BaseModel):
    """Respuesta de POST /api/v1/simplify. Misma convención que
    VectorizeResponse: el SVG viaja como texto plano en `svg` (XML/texto
    válido, no bytes binarios)."""

    svg: str = Field(description="Marcado SVG simplificado, YA sanitizado (ver app.core.svg_processing.sanitize_svg)")
    content_type: str = Field(default="image/svg+xml", examples=["image/svg+xml"])
    effective_params: SimplifyParams
    metrics: SimplifyMetrics


class CheckParams(BaseModel):
    """Tolerancias del Laser Checker de paths abiertos/duplicados (M1-S08),
    ambas relativas a la diagonal del bounding box de TODO el SVG de entrada
    (mismo criterio que `SimplifyParams.epsilon_ratio`, M1-S07) -- así
    escalan con el tamaño del diseño en vez de ser un valor absoluto en
    unidades de pantalla/píxeles. spec.md no los cuantifica ("Valor(es) de
    tolerancia por defecto no están cuantificados"); los defaults de acá son
    ese supuesto documentado en el reporte del sprint: 0.5% de la diagonal
    para "casi cerrado", 0.2% para "casi duplicado" (más estricto: un
    duplicado casi-exacto es una señal más fuerte de un problema real que un
    gap de cierre moderado, que puede ser una decisión de diseño legítima).
    """

    close_gap_ratio: float = Field(
        default=0.005,
        gt=0,
        le=0.5,
        description=(
            "Tolerancia de 'debería estar cerrado': distancia máxima entre el primer y "
            "último punto de un subpath SIN comando Z, como fracción de la diagonal del SVG."
        ),
    )
    duplicate_point_ratio: float = Field(
        default=0.002,
        gt=0,
        le=0.5,
        description=(
            "Tolerancia de 'casi-duplicado': distancia punto a punto máxima entre dos "
            "subpaths de igual cantidad de puntos, como fracción de la diagonal del SVG."
        ),
    )


class CheckBounds(BaseModel):
    """Caja delimitadora de un único subpath (no de todo el SVG, a
    diferencia de VectorBounds) -- suficiente para que React ubique
    aproximadamente el issue sin tener que volver a parsear el `d` completo
    del `<path>`."""

    min_x: float
    min_y: float
    max_x: float
    max_y: float


class OpenPathIssue(BaseModel):
    """Un subpath sin comando `Z` cuyo primer y último punto están dentro de
    `CheckParams.close_gap_ratio` -- ver app.core.path_checker._detect_open_paths.
    `path_index`/`subpath_index` son 0-based, en el mismo orden de documento
    que ve React al renderizar el SVG (suficientes, junto a `bounds`, para
    resaltar el `<path>` correspondiente -- ver spec.md, Definition of Done:
    "localizable visualmente")."""

    type: Literal["open_path"] = "open_path"
    id: str = Field(examples=["open-0-0"])
    severity: Literal["warning", "error"] = Field(
        examples=["error"],
        description="Siempre 'error': un path abierto que debería cerrarse produce un corte incompleto.",
    )
    path_index: int = Field(ge=0)
    subpath_index: int = Field(ge=0)
    start_point: tuple[float, float]
    end_point: tuple[float, float]
    gap_distance: float = Field(ge=0)
    bounds: CheckBounds


class DuplicateMember(BaseModel):
    """Un subpath miembro de un grupo de duplicados -- ver DuplicatePathIssue."""

    path_index: int = Field(ge=0)
    subpath_index: int = Field(ge=0)
    bounds: CheckBounds


class DuplicatePathIssue(BaseModel):
    """Un grupo de 2+ subpaths geométricamente iguales o casi-iguales dentro
    de `CheckParams.duplicate_point_ratio` -- ver
    app.core.path_checker._detect_duplicates. `members` está en orden de
    documento; `exact` distingue un duplicado byte-a-byte (distancia ~0,
    severidad "error": corte redundante completo, desperdicio/riesgo real)
    de uno casi-idéntico (severidad "warning": podría ser una decisión de
    diseño, ej. doble línea de grabado, aunque la tolerancia por defecto es
    lo bastante chica como para que sea poco probable)."""

    type: Literal["duplicate_path"] = "duplicate_path"
    id: str = Field(examples=["dup-1"])
    severity: Literal["warning", "error"]
    exact: bool
    max_point_distance: float = Field(ge=0)
    members: list[DuplicateMember] = Field(min_length=2)


CheckIssue = Annotated[OpenPathIssue | DuplicatePathIssue, Field(discriminator="type")]


class CheckSummary(BaseModel):
    open_path_count: int = Field(ge=0, examples=[1])
    duplicate_group_count: int = Field(ge=0, examples=[1])


class CheckResponse(BaseModel):
    """Respuesta de POST /api/v1/check. Análisis de SOLO LECTURA: no incluye
    ni modifica el SVG de entrada -- solo lo devuelve indirectamente a
    través de los índices de `issues`, ya que Vectorify.Api/React ya tienen el
    SVG que enviaron a analizar."""

    effective_params: CheckParams
    summary: CheckSummary
    issues: list[CheckIssue]
    skipped_path_count: int = Field(
        ge=0,
        description=(
            "Cantidad de <path> excluidos del análisis por contener comandos no soportados "
            "(cualquier cosa que no sea M/L/Z absolutos en mayúscula) -- ver limitación "
            "documentada en app.core.path_checker."
        ),
    )


class ComponentAnalysisParams(BaseModel):
    """Parámetros del análisis de componentes físicos independientes por capa
    (M2-S03): `touch_ratio` (tolerancia de "tocarse" -- distancia mínima
    segmento-a-segmento entre dos subpaths para considerarlos la MISMA pieza
    física) y `tiny_area_ratio` (umbral de "componente diminuto"), ambos
    relativos -- `touch_ratio` a la diagonal del bounding box del SVG
    completo (mismo criterio que `CheckParams`, M1-S08), `tiny_area_ratio`
    al ÁREA del bounding box del SVG completo. spec.md no los cuantifica
    ("el implementador decide y documenta"); los defaults de acá son ese
    supuesto documentado en el reporte del sprint: ver
    app.core.config.Settings.component_default_touch_ratio/
    component_default_tiny_area_ratio."""

    touch_ratio: float = Field(
        default=0.001,
        ge=0,
        le=0.5,
        description=(
            "Tolerancia de 'tocarse': distancia mínima segmento-a-segmento entre dos subpaths "
            "para considerarlos la misma pieza física, como fracción de la diagonal del SVG."
        ),
    )
    tiny_area_ratio: float = Field(
        default=0.0005,
        ge=0,
        le=0.5,
        description=(
            "Umbral de 'componente diminuto': área neta del componente, como fracción del área "
            "del bounding box de todo el SVG, por debajo de la cual se marca is_tiny=true "
            "(se reporta igual, nunca se filtra)."
        ),
    )


class ComponentBounds(BaseModel):
    """Caja delimitadora de un único subpath o componente (no de todo el SVG)."""

    min_x: float
    min_y: float
    max_x: float
    max_y: float


class ComponentMember(BaseModel):
    """Un subpath miembro de un componente físico -- ver
    app.core.component_analysis. `role` distingue "solid" (suma al área neta
    del componente) de "hole" (agujero interno, resta -- ver criterio de
    aceptación de spec.md: "un subpath que es un AGUJERO... pertenece al
    MISMO componente")."""

    path_index: int = Field(ge=0)
    subpath_index: int = Field(ge=0)
    role: Literal["solid", "hole"]
    bounds: ComponentBounds
    area: float = Field(ge=0)


class ComponentItem(BaseModel):
    """Un componente físico independiente -- un conjunto de subpaths que
    forman una única pieza física conexa (unidos por contención de
    agujero, por contacto dentro de tolerancia, o ambos). `id` es estable
    DENTRO de esta respuesta/versión (mismo SVG + mismos parámetros -> mismo
    id, mismo orden), NO necesariamente entre versiones distintas -- ver
    spec.md, criterio de aceptación."""

    id: str = Field(examples=["component-1"])
    members: list[ComponentMember] = Field(min_length=1)
    bounds: ComponentBounds
    area: float = Field(ge=0, description="Área NETA (sólidos menos agujeros), aproximada (shoelace).")
    is_tiny: bool = Field(
        description="True si el área neta está por debajo de ComponentAnalysisParams.tiny_area_ratio -- se reporta igual, nunca se filtra."
    )


class ComponentSummary(BaseModel):
    component_count: int = Field(ge=0, examples=[3])
    tiny_component_count: int = Field(ge=0, examples=[0])


class ComponentAnalysisResponse(BaseModel):
    """Respuesta de POST /api/v1/components. Análisis de SOLO LECTURA: nunca
    modifica el SVG de entrada ni une/separa geometría -- solo INFORMA la
    estructura física ya existente (ver spec.md M2-S03, "Fuera de alcance")."""

    effective_params: ComponentAnalysisParams
    summary: ComponentSummary
    components: list[ComponentItem]
    skipped_path_count: int = Field(
        ge=0,
        description=(
            "Cantidad de <path> excluidos del análisis por contener comandos/transforms no "
            "soportados -- ver limitación documentada en app.core.svg_path_parsing."
        ),
    )


class PhysicalUnionMemberRef(BaseModel):
    """Referencia a un subpath miembro de un `LayerComponent` YA calculado
    por M2-S03 -- exactamente `path_index`/`subpath_index`/`role` de
    `ComponentMember`, ecoados tal cual por Vectorify.Api (que ya los tiene
    persistidos en la ComponentSetVersion vigente del VectorId, no hace
    falta recalcularlos acá)."""

    path_index: int = Field(ge=0)
    subpath_index: int = Field(ge=0)
    role: Literal["solid", "hole"]


class PhysicalUnionSelection(BaseModel):
    """Un componente físico completo seleccionado para la unión: su id (solo
    para mensajes de error legibles) y la lista de sus subpaths miembro."""

    component_id: str
    members: list[PhysicalUnionMemberRef] = Field(min_length=1)


class PhysicalUnionParams(BaseModel):
    """Parámetros de la unión física de piezas (M2-S06): la selección de 2+
    componentes a fusionar, más las MISMAS tolerancias relativas de M2-S03
    (`touch_ratio`/`tiny_area_ratio`, ver ComponentAnalysisParams -- se
    reutiliza EXACTAMENTE el mismo criterio, ver spec.md, "Ambigüedades
    detectadas") y `bridge_width_ratio` (ancho del bridge simple/directo
    para piezas separadas, como fracción de la diagonal del SVG completo --
    spec.md no lo cuantifica, ver
    app.core.config.Settings.physical_union_default_bridge_width_ratio)."""

    selections: list[PhysicalUnionSelection] = Field(min_length=2)
    touch_ratio: float = Field(default=0.001, ge=0, le=0.5)
    tiny_area_ratio: float = Field(default=0.0005, ge=0, le=0.5)
    bridge_width_ratio: float = Field(default=0.02, ge=0, le=0.5)


class PhysicalUnionResponse(BaseModel):
    """Respuesta de POST /api/v1/components/union. El SVG viaja como texto
    plano en `svg` (misma convención que Vectorize/SimplifyResponse). Nunca
    se devuelve un `PhysicalUnionResponse` "parcialmente exitoso": si la
    validación post-operación (reanalizar el resultado con EL MISMO
    analizador de M2-S03) no confirma el conteo esperado de componentes, el
    servicio lanza PhysicalUnionImpossibleError en vez de construir esta
    respuesta (ver app.core.physical_union, "nunca fingir unión")."""

    svg: str = Field(description="Marcado SVG con las piezas seleccionadas YA fusionadas, sanitizado de nuevo")
    content_type: str = Field(default="image/svg+xml", examples=["image/svg+xml"])
    width: int
    height: int
    metrics: VectorMetrics
    effective_params: PhysicalUnionParams
    component_count_before: int = Field(ge=0)
    component_count_after: int = Field(ge=0)
    expected_component_count_after: int = Field(ge=0)
    strategy: Literal["boolean_union", "bridge", "mixed"]
    bridge_count: int = Field(ge=0)


class ColorPaletteParams(BaseModel):
    """Parámetros de detección/reducción de paleta de colores (M2-S01):
    tolerancia de fusión automática (distancia euclídea en espacio Lab, ver
    app.core.color_palette_pipeline) y número objetivo (límite superior
    opcional) de colores. Rangos alineados con
    Vectorify.Api.Options.ColorPaletteOptions (defensa en profundidad, mismo
    criterio que el resto de los *Params)."""

    tolerance: float = Field(
        12.0,
        ge=0,
        le=100,
        description="Distancia Lab máxima para fusionar automáticamente dos colores parecidos (0 = solo colores idénticos).",
    )
    max_colors: int | None = Field(
        None,
        ge=1,
        le=64,
        description="Límite superior opcional de colores en la paleta resultante (null = sin límite explícito).",
    )
    tiny_area_ratio: float = Field(
        0.001,
        ge=0,
        le=0.5,
        description=(
            "Umbral de 'grupo diminuto' (M2.1-S02, mismo estilo relativo que "
            "ComponentAnalysisParams.tiny_area_ratio): cualquier grupo cuya área sea menor a esta fracción "
            "de los píxeles relevantes (no completamente transparentes) se fusiona automáticamente con su "
            "vecino de color más cercano ANTES de aplicar max_colors -- ataca la explosión de grupos por "
            "antialiasing documentada en la auditoría M2.1-S01 (17 grupos en vez de ~5 lógicos). 0 = "
            "deshabilitado (ver app.core.color_palette_pipeline, 'el implementador decide y documenta'; "
            "valor default con evidencia empírica antes/después en el reporte del sprint)."
        ),
    )


class ColorGroupPayload(BaseModel):
    """Un color/grupo detectado -- ver app.core.color_palette_pipeline.ColorGroup.
    `id` es el índice 0-based determinista (orden de presentación: área
    descendente) dentro de ESTA detección; Vectorify.Api lo usa para asignarle
    un GroupId (GUID) propio y estable en su modelo versionado."""

    id: int = Field(ge=0, examples=[0])
    color_hex: str = Field(examples=["#3a6ea5"], description="Color representativo (RGB), formato #RRGGBB.")
    pixel_count: int = Field(ge=0)
    area_percent: float = Field(ge=0, le=100, description="Porcentaje del ÁREA TOTAL de la imagen (incluye píxeles transparentes en el denominador).")
    has_partial_alpha: bool = Field(
        description="True si parte de los píxeles de este grupo tenían alpha parcial (0 < alpha < 255)."
    )
    touches_border: bool = Field(
        description=(
            "M2.1-S02: True si este grupo cubre al menos la mitad del perímetro de la imagen -- ver "
            "app.core.color_palette_pipeline._BACKGROUND_BORDER_TOUCH_RATIO. Vectorify.Api combina esto con "
            "que el grupo sea el de mayor área para PRE-marcarlo como excluido/fondo por default (el "
            "usuario puede cambiarlo manualmente en cualquier momento)."
        )
    )
    mask_base64: str = Field(description="Máscara binaria (0/255) de este grupo, codificada como PNG en base64.")


class ColorPaletteMetrics(BaseModel):
    color_count: int = Field(ge=0, examples=[4])
    transparent_percent: float = Field(ge=0, le=100, examples=[0.0])


class ColorPaletteResponse(BaseModel):
    """Respuesta de POST /api/v1/color-palette. Misma convención que el
    resto de las respuestas de este motor: consumida únicamente por
    Vectorify.Api, imágenes embebidas en base64 para un contrato JSON simple y
    determinista."""

    width: int
    height: int
    content_type: str = Field(default="image/png", examples=["image/png"])
    effective_params: ColorPaletteParams
    metrics: ColorPaletteMetrics
    groups: list[ColorGroupPayload]
    quantized_preview_base64: str = Field(
        description="Preview RGBA (PNG en base64): cada píxel pintado con el color de su grupo, transparente donde no hay grupo asignado."
    )


# ---- Servicio de geometría (M3-S04, ADR D4) ----
# Se intercambian ANILLOS de polígonos / polilíneas en unidades de documento (formato tipo GeoJSON
# MultiPolygon / MultiLineString), nunca path data: el cliente aplana las curvas con su propia
# tolerancia y el servidor opera sobre coordenadas puras (ver app.core.geometry_ops).

# Coordenada finita y acotada: el JSON de Python acepta `NaN`/`Infinity` aunque el estándar no, así que
# se rechazan explícitamente (y un valor enorme que desborde al operar también).
GEOMETRY_COORDINATE_LIMIT = 1_000_000_000.0
GeometryCoordinate = Annotated[float, Field(allow_inf_nan=False, ge=-GEOMETRY_COORDINATE_LIMIT, le=GEOMETRY_COORDINATE_LIMIT)]
GeometryPoint = tuple[GeometryCoordinate, GeometryCoordinate]
GeometryOperation = Literal["union", "difference", "intersection", "intersection_all", "xor", "normalize"]


class PolygonGeometry(BaseModel):
    """Polígono = lista de anillos (el primero es el exterior). Los huecos se construyen con la regla
    par-impar: un anillo contenido en un número impar de anillos es relleno, en uno par es hueco. Un anillo
    puede venir abierto o cerrado (con el primer vértice repetido al final); se necesitan >= 3 vértices."""

    type: Literal["polygon"]
    coordinates: list[Annotated[list[GeometryPoint], Field(min_length=3)]] = Field(min_length=1)


class LineGeometry(BaseModel):
    """Polilínea abierta (o cerrada si repite su primer vértice): >= 2 vértices."""

    type: Literal["line"]
    coordinates: list[GeometryPoint] = Field(min_length=2)


class BufferedLineOperand(BaseModel):
    """Pincel de borrador: una línea con radio (cap/join redondos). Un solo punto es un toque (círculo)."""

    type: Literal["bufferedLine"]
    points: list[GeometryPoint] = Field(min_length=1)
    radius: float = Field(gt=0, le=GEOMETRY_COORDINATE_LIMIT, allow_inf_nan=False)


SubjectGeometry = Annotated[PolygonGeometry | LineGeometry, Field(discriminator="type")]
OperandGeometry = Annotated[PolygonGeometry | LineGeometry | BufferedLineOperand, Field(discriminator="type")]


class GeometryBooleanRequest(BaseModel):
    """Cuerpo de POST /api/v1/geometry/boolean. `tolerance` (> 0, unidades de documento) gobierna la
    resolución de los arcos del pincel y el umbral de "pieza despreciable" (área < tolerance², largo <
    tolerance) del resultado."""

    operation: GeometryOperation
    subjects: list[SubjectGeometry] = Field(min_length=1)
    operands: list[OperandGeometry] = Field(default_factory=list)
    tolerance: float = Field(gt=0, le=1_000_000, allow_inf_nan=False)


class PolygonPiece(BaseModel):
    """Pieza poligonal del resultado: anillos CERRADOS (primer vértice repetido al final), exterior primero
    (antihorario en ejes matemáticos) y huecos después (horarios), cada anillo empezando por su vértice
    mínimo (x, y) -- representación canónica, determinista."""

    type: Literal["polygon"]
    coordinates: list[list[GeometryPoint]]


class LinePiece(BaseModel):
    type: Literal["line"]
    coordinates: list[GeometryPoint]


GeometryPiece = Annotated[PolygonPiece | LinePiece, Field(discriminator="type")]


class GeometryResultItem(BaseModel):
    """Resultado para UN subject (`subject_index`) o para el conjunto (`null`, union/xor/intersection_all). `changed` es false
    cuando el resultado es topológicamente igual al subject (el cliente conserva entonces su objeto
    original, con sus curvas). `geometries` puede estar vacío (nada queda) o tener varias piezas."""

    subject_index: int | None
    changed: bool
    geometries: list[GeometryPiece]


class GeometryBooleanResponse(BaseModel):
    operation: GeometryOperation
    scope: Literal["per_subject", "combined"]
    tolerance: float
    results: list[GeometryResultItem]
    piece_count: int = Field(ge=0)


# ---- Offset de geometría (M3-S09): mismo servicio y mismo formato de anillos que las booleanas ----

OffsetJoinStyle = Literal["round", "mitre", "bevel"]
OffsetCapStyle = Literal["round", "flat", "square"]


class GeometryOffsetRequest(BaseModel):
    """Cuerpo de POST /api/v1/geometry/offset. `distance` está FIRMADA y en unidades de documento (> 0 exterior,
    < 0 interior; 0 se rechaza); `join_style`/`mitre_limit` gobiernan las esquinas, `cap_style` los extremos de
    las líneas (que solo se desplazan a ambos lados) y `tolerance` (> 0) la resolución de los arcos y el umbral
    de pieza despreciable (área < tolerance²)."""

    subjects: list[SubjectGeometry] = Field(min_length=1)
    distance: float = Field(allow_inf_nan=False)
    join_style: OffsetJoinStyle = "round"
    mitre_limit: float = Field(default=2.0, allow_inf_nan=False)
    cap_style: OffsetCapStyle = "round"
    tolerance: float = Field(gt=0, le=1_000_000, allow_inf_nan=False)


class OffsetResultItem(BaseModel):
    """Resultado del offset de UN subject (ver app.core.geometry_offset): `geometries` son polígonos válidos;
    `collapsed` = no queda nada; `split_count` = piezas del resultado (más que las piezas que sobreviven del subject
    = se partió); `lost_pieces` = piezas del subject que desaparecen del todo; `holes_before`/`holes_after` y
    `max_inward_offset` (offset interior a partir del cual todo el subject colapsa; `null` para líneas)."""

    subject_index: int
    geometries: list[PolygonPiece]
    collapsed: bool
    pieces_before: int = Field(ge=0)
    split_count: int = Field(ge=0)
    lost_pieces: int = Field(ge=0)
    holes_before: int = Field(ge=0)
    holes_after: int = Field(ge=0)
    max_inward_offset: float | None


class GeometryOffsetResponse(BaseModel):
    distance: float
    join_style: OffsetJoinStyle
    mitre_limit: float
    cap_style: OffsetCapStyle
    tolerance: float
    results: list[OffsetResultItem]
    piece_count: int = Field(ge=0)


class ErrorResponse(BaseModel):
    """Forma común de error controlado, igual convención que
    Vectorify.Api.Contracts.ApiErrorResponse: `code` es estable, `message` es
    para logs/debug humano."""

    code: str = Field(examples=["corrupt_image"])
    message: str
