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

/** Códigos de error estables de `/api/v2/geometry/*` (ApiErrorResponse.Code) + los del cliente HTTP. */
export type GeometryErrorCode =
  | "invalid_parameters"
  | "unknown_operation"
  | "invalid_distance"
  | "unknown_join_style"
  | "unknown_cap_style"
  | "invalid_mitre_limit"
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
