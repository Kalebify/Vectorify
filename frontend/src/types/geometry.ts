/**
 * Contrato del servicio de geometría del editor (M3-S04, `docs/ADR_EDITOR_MVP3.md` D4): refleja `Vectorify.Api.Contracts.
 * GeometryBooleanRequest/Response`. Se intercambian ANILLOS de polígonos / polilíneas en UNIDADES DE DOCUMENTO (formato tipo GeoJSON
 * `MultiPolygon` / `MultiLineString`), nunca path data: el cliente aplana sus curvas con una tolerancia explícita y el servidor
 * (Shapely) opera sobre coordenadas puras.
 */

export type GeometryPoint = [number, number];

/**
 * `intersection` = cada subject ∩ la UNIÓN de los operandos (S04). `intersection_all` (M3-S08) = región común a TODAS las formas
 * (subjects + operands, >= 2), resultado combinado: lo usan las booleanas del editor.
 */
export type GeometryOperationName = "union" | "difference" | "intersection" | "intersection_all" | "xor" | "normalize";

/** Polígono = lista de anillos (el primero exterior; los huecos salen de la regla PAR-IMPAR). Un anillo puede venir abierto o cerrado. */
export interface PolygonGeometry {
  type: "polygon";
  coordinates: GeometryPoint[][];
}

/** Polilínea (abierta, o cerrada si repite su primer vértice). */
export interface LineGeometry {
  type: "line";
  coordinates: GeometryPoint[];
}

/** Pincel de borrador: línea con radio (extremos y uniones redondos). Solo como operando. */
export interface BufferedLineOperand {
  type: "bufferedLine";
  points: GeometryPoint[];
  radius: number;
}

export type GeometrySubject = PolygonGeometry | LineGeometry;
export type GeometryOperand = GeometrySubject | BufferedLineOperand;

export interface BooleanRequest {
  operation: GeometryOperationName;
  subjects: GeometrySubject[];
  operands: GeometryOperand[];
  /** Unidades de documento (> 0): resolución de los arcos del pincel y umbral de "pieza despreciable". */
  tolerance: number;
}

/** Pieza del resultado: polígono con anillos CERRADOS (exterior primero) o polilínea. */
export type GeometryPiece = PolygonGeometry | LineGeometry;

export interface BooleanResultItem {
  /** Índice del subject (difference/intersection/normalize) o `null` (union/xor: resultado único). */
  subjectIndex: number | null;
  /** `false` = el resultado es topológicamente igual al subject: el cliente conserva su objeto original (con sus curvas). */
  changed: boolean;
  geometries: GeometryPiece[];
}

export interface BooleanResponse {
  operation: GeometryOperationName;
  scope: "per_subject" | "combined";
  tolerance: number;
  results: BooleanResultItem[];
  pieceCount: number;
}

// ---- Offset (M3-S09): `POST /api/v2/geometry/offset`, refleja `Vectorify.Api.Contracts.GeometryOffsetRequest/Response` ----

/** Forma de las esquinas del offset: redondo (default), inglete (con límite) o bisel. */
export type OffsetJoinStyle = "round" | "mitre" | "bevel";

/** Forma de los extremos de una línea abierta: redondo (default), plano o cuadrado. Solo afecta a líneas. */
export type OffsetCapStyle = "round" | "flat" | "square";

export interface OffsetRequest {
  /** Polígonos y polilíneas (nunca un pincel), en unidades de documento: el mismo formato de anillos de las booleanas. */
  subjects: GeometrySubject[];
  /** FIRMADA y en unidades de documento: > 0 exterior (agranda), < 0 interior (encoge). 0 se rechaza. Las líneas solo admiten > 0 (ambos lados). */
  distance: number;
  joinStyle: OffsetJoinStyle;
  /** Razón máxima entre el largo del inglete y la distancia (> 0); pasado el límite el servidor recorta la punta. Solo afecta a `mitre`. */
  mitreLimit: number;
  capStyle: OffsetCapStyle;
  /** Unidades de documento (> 0): resolución de los arcos redondos y umbral de "pieza despreciable" (área < tolerancia²). */
  tolerance: number;
}

/** Resultado del offset de UN subject: lo que pasó, nunca en silencio. */
export interface OffsetResultItem {
  subjectIndex: number;
  /** Polígonos válidos (anillos cerrados, exterior primero); vacío si `collapsed`. */
  geometries: PolygonGeometry[];
  /** No queda NADA del subject (se encogió hasta desaparecer o ya era degenerado). */
  collapsed: boolean;
  /** Piezas disjuntas del subject antes del offset. */
  piecesBefore: number;
  /** Piezas del resultado: más que las que sobreviven del subject = el subject se PARTIÓ. */
  splitCount: number;
  /** Piezas del subject que desaparecen del todo (solo hacia adentro). */
  lostPieces: number;
  holesBefore: number;
  holesAfter: number;
  /** Offset interior a partir del cual TODO el subject colapsa (radio del máximo círculo inscrito); `null` para líneas. */
  maxInwardOffset: number | null;
}

export interface OffsetResponse {
  distance: number;
  joinStyle: OffsetJoinStyle;
  mitreLimit: number;
  capStyle: OffsetCapStyle;
  tolerance: number;
  results: OffsetResultItem[];
  pieceCount: number;
}

// ---- Corte / división (M3-S10): `POST /api/v2/geometry/split`, refleja `Vectorify.Api.Contracts.GeometrySplitRequest/Response` ----

/** `split` = dividir (las piezas comparten el borde del corte); `slot` = separar con hueco (se resta una ranura de ancho `slotWidth` centrada en la línea). */
export type SplitMode = "split" | "slot";

/** Línea de corte: polilínea de >= 2 puntos distintos, en unidades de documento. */
export interface CutterLine {
  points: GeometryPoint[];
}

export interface SplitRequest {
  /** Polígonos y polilíneas (nunca un pincel), en unidades de documento: el mismo formato de anillos de las booleanas. */
  subjects: GeometrySubject[];
  cutter: CutterLine;
  mode: SplitMode;
  /** Unidades de documento: > 0 en modo `slot`; en modo `split` se ignora (el cliente manda 0). */
  slotWidth: number;
  /** Prolonga el primer y el último tramo del corte para que crucen todo. */
  extend: boolean;
  /** Unidades de documento (> 0): resolución de los arcos de la ranura y umbral de "pieza despreciable" (área < tolerancia², largo <= tolerancia). */
  tolerance: number;
}

/** Resultado del corte de UN subject: lo que pasó, nunca en silencio. */
export interface SplitResultItem {
  subjectIndex: number;
  /** El corte (o su ranura) alcanza al subject. Permite distinguir «no lo toca» de «lo toca pero no lo atraviesa». */
  touched: boolean;
  /** `true` solo si el corte SEPARA al subject en más piezas que antes. Si es `false`, `pieces` es el subject tal cual (el cliente conserva su `d` con las curvas). */
  changed: boolean;
  /** Polígonos para un subject poligonal y polilíneas para uno lineal; anillos cerrados, orden determinista. */
  pieces: GeometryPiece[];
  pieceCount: number;
  /** Piezas despreciables que el servidor descartó de un resultado que cambió (0 si no cambió). */
  discarded: number;
}

export interface SplitResponse {
  mode: SplitMode;
  slotWidth: number;
  extend: boolean;
  tolerance: number;
  results: SplitResultItem[];
  pieceCount: number;
}

// ---- Piezas flotantes y bridges (M3-S11): `POST /api/v2/geometry/floating` y `/bridge`, reflejan `Vectorify.Api.Contracts.GeometryFloatingRequest/Response` y `GeometryBridgeRequest/Response` ----

/**
 * Qué significa «flotante»: `stencil` (Plantilla) = las formas son CORTES (vacío) y flotante es cada isla de material rodeada de corte (se cae al cortar);
 * `parts` (Piezas) = las formas son MATERIAL y flotante es un componente que está dentro de un hueco de otro (desconectado del cuerpo principal).
 */
export type FloatingMode = "stencil" | "parts";

/** Forma del análisis: un polígono (anillos con regla par-impar) y si está bloqueada (cuenta para el análisis, pero ningún bridge la modifica). */
export interface FloatingSubject extends PolygonGeometry {
  locked: boolean;
}

export interface FloatingRequest {
  subjects: FloatingSubject[];
  mode: FloatingMode;
  /** Unidades de documento (> 0): umbral de componente despreciable (área < tolerancia²). */
  tolerance: number;
}

export type FloatingComponentKind = "principal" | "floating";

/** Un componente de la unión de las formas. En `stencil` el único principal es la HOJA (id 0, sin polígono ni área). */
export interface FloatingComponent {
  /** = su posición en la lista (orden determinista: profundidad, coordenadas). */
  id: number;
  kind: FloatingComponentKind;
  /** Ancestros en el árbol de contención (la hoja / el cuerpo principal = 0). */
  depth: number;
  /** Id del componente que lo rodea (siempre anterior en la lista), o `null` en un principal. */
  parent: number | null;
  /** Polígono (anillos cerrados; los huecos son los de la propia pieza). `null` solo en la hoja de `stencil`. */
  polygon: PolygonGeometry | null;
  area: number | null;
  /** [minX, minY, maxX, maxY] en unidades de documento. */
  bounds: [number, number, number, number];
  /** Índices (en `subjects`) de las formas que lo forman. */
  subjects: number[];
}

export interface FloatingResponse {
  mode: FloatingMode;
  tolerance: number;
  components: FloatingComponent[];
  floatingCount: number;
  mainCount: number;
  /** Componentes despreciables (área < tolerancia²) que el servidor descartó. */
  discarded: number;
}

export interface BridgePoint {
  x: number;
  y: number;
}

/** Un bridge pedido: `island` (el servidor sugiere ancla y dirección) y/o `anchor` (punto sobre el borde de una pieza flotante). Medidas en unidades de documento. */
export interface BridgeInput {
  island?: number;
  anchor?: BridgePoint;
  /** Cualquier vector no nulo; sin él, perpendicular al borde hacia afuera. */
  direction?: BridgePoint;
  width: number;
  /** Largo desde el ancla; sin él, lo justo para cruzar el hueco. */
  length?: number;
}

export interface BridgeRequest {
  subjects: FloatingSubject[];
  mode: FloatingMode;
  bridges: BridgeInput[];
  /** El servidor completa con una sugerencia cada pieza flotante que ningún bridge válido cubre. */
  suggest: boolean;
  suggestWidth?: number;
  tolerance: number;
}

/** Motivos estables por los que un bridge no es válido. */
export type BridgeReason =
  | "unknown_island"
  | "anchor_outside"
  | "width_below_tolerance"
  | "invalid_direction"
  | "no_crossing"
  | "too_short"
  | "locked_subject"
  | "no_connection";

export interface BridgeResultItem {
  index: number;
  suggested: boolean;
  valid: boolean;
  reason: BridgeReason | null;
  /** Id de la pieza flotante a la que pertenece el ancla. */
  island: number | null;
  anchor: BridgePoint | null;
  /** Unitaria. */
  direction: BridgePoint | null;
  width: number;
  /** Largo del hueco que cruza. */
  length: number | null;
  /** Lo que realmente quita (stencil) o agrega (parts) = ancho × largo. */
  area: number | null;
  /** Sumado a los bridges válidos anteriores deja menos flotantes. */
  reduces: boolean;
  /** Índices de las formas que modifica. */
  affects: number[];
  /** Su rectángulo: un solo anillo cerrado. */
  polygon: PolygonGeometry | null;
}

/** Geometría resultante de UNA forma. `changed: false` = igual (sin geometrías: el cliente conserva su objeto con sus curvas). */
export interface BridgeSubjectResult {
  subjectIndex: number;
  changed: boolean;
  geometries: PolygonGeometry[];
}

export interface BridgeReanalysis {
  floatingBefore: number;
  floatingAfter: number;
  mainAfter: number;
}

export interface BridgeResponse {
  mode: FloatingMode;
  tolerance: number;
  /** Los pedidos, en orden, y después los sugeridos. */
  bridges: BridgeResultItem[];
  results: BridgeSubjectResult[];
  reanalysis: BridgeReanalysis;
  pieceCount: number;
}

/** Códigos de error estables de `/api/v2/geometry/*` (ApiErrorResponse.Code) + los del cliente HTTP. */
export type GeometryErrorCode =
  | "invalid_parameters"
  | "unknown_operation"
  | "invalid_distance"
  | "unknown_join_style"
  | "unknown_cap_style"
  | "invalid_mitre_limit"
  | "unknown_split_mode"
  | "invalid_slot_width"
  | "invalid_cutter"
  | "too_many_cutter_points"
  | "unknown_floating_mode"
  | "invalid_bridge"
  | "invalid_bridge_width"
  | "too_many_bridges"
  | "invalid_tolerance"
  | "invalid_coordinates"
  | "too_many_subjects"
  | "too_many_operands"
  | "too_many_vertices"
  | "payload_too_large"
  | "timeout"
  | "engine_unavailable"
  | "invalid_response"
  | "processing_error"
  | "internal_error"
  | "network_error"
  | "invalid_result";
