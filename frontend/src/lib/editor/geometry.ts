import type { BooleanRequest, BooleanResponse, GeometryErrorCode, GeometryPiece, GeometryPoint, GeometrySubject } from "../../types/geometry";
import { isFiniteMatrix } from "./matrix";
import { isUnfilled } from "./objects";
import { flattenSegments, parsePathData, parsePathDataCached, segmentsBounds, segmentsToPathData, transformSegments, type PathSegment } from "./pathGeometry";
import type { EditorObject, Point } from "./types";

/**
 * Intercambio de geometría con el servidor (M3-S04, `docs/ADR_EDITOR_MVP3.md` D4). El editor NUNCA manda path data: aplana sus curvas
 * con una tolerancia explícita (default 0,01 mm convertida a unidades de documento) y manda ANILLOS de polígonos / polilíneas en
 * unidades de documento; el resultado vuelve como anillos y se serializa a `d` (`M … L … Z`, huecos como subpaths). Consecuencia
 * documentada: las booleanas devuelven POLILÍNEAS aplanadas a la tolerancia pedida (no preservan los Bézier originales) -- por eso
 * un objeto que el servidor declara intacto (`changed: false`) se conserva tal cual, con sus curvas.
 *
 * Todo puro (sin DOM ni React): lo reusan Draw/Erase (S04) y las booleanas, offset, corte y puentes (S08-S11).
 */

/** Tolerancia de aplanado por defecto, en mm (spec M3-S04). */
export const DEFAULT_FLATNESS_MM = 0.01;
/** Espejo de `Geometry:MaxSubjects` / `Geometry:MaxVertices` del backend: el cliente avisa ANTES de mandar algo que el servidor rechazaría. */
export const MAX_SERVER_SUBJECTS = 500;
export const MAX_SERVER_VERTICES = 500_000;

/** Operaciones cuyo resultado trae UNA entrada por subject (el resto devuelve una sola, combinada). */
const PER_SUBJECT_OPERATIONS: ReadonlySet<string> = new Set(["difference", "intersection", "normalize"]);

// ---- Unidades ----

/** Escala de pantalla/panel: mm si el documento tiene dimensiones físicas; si no, las unidades de documento ("u") sin convertir. */
export interface UnitScale {
  /** mm por unidad de documento (1 si no hay escala física). */
  factor: number;
  label: "mm" | "u";
}

export function unitScale(mmFactor: number | null): UnitScale {
  return mmFactor !== null && Number.isFinite(mmFactor) && mmFactor > 0 ? { factor: mmFactor, label: "mm" } : { factor: 1, label: "u" };
}

/** Valor del panel (mm o u) -> unidades de documento. */
export function toDocumentUnits(value: number, scale: UnitScale): number {
  return value / scale.factor;
}

/** Unidades de documento -> valor del panel (mm o u). */
export function fromDocumentUnits(units: number, scale: UnitScale): number {
  return units * scale.factor;
}

/** Factor de escala lineal de una matriz (raíz del |determinante|): cuánto cambia un largo del espacio del objeto en el documento. */
export function matrixScale(matrix: EditorObject["matrix"]): number {
  return Math.sqrt(Math.abs(matrix.a * matrix.d - matrix.b * matrix.c));
}

// ---- Objeto -> subjects ----

export interface ObjectGeometry {
  /** `polygon` = objeto con relleno (UN subject con todos sus anillos); `line` = objeto sin relleno (un subject por subpath). */
  kind: "polygon" | "line";
  subjects: GeometrySubject[];
  vertexCount: number;
}

function toPoint(point: Point): GeometryPoint {
  return [point.x, point.y];
}

/**
 * Geometría de un objeto en UNIDADES DE DOCUMENTO (matriz horneada), aplanada con `flatness` (unidades de documento). `null` si el
 * objeto no se puede enviar de forma segura (path ilegible, matriz o coordenadas no finitas, sin geometría): el llamador lo omite y
 * lo informa -- nunca se manda geometría dudosa al servidor. Con relleno: UN polígono con todos los subpaths como anillos (regla
 * par-impar, igual que los huecos de vtracer). Sin relleno: una polilínea por subpath (cerrada = repite su primer vértice).
 */
export function objectGeometry(object: EditorObject, flatness: number): ObjectGeometry | null {
  if (!isFiniteMatrix(object.matrix) || !(flatness > 0) || !Number.isFinite(flatness)) return null;
  const parsed = parsePathDataCached(object.d);
  if (parsed.error !== null || parsed.segments.length === 0) return null;

  const polylines = flattenSegments(transformSegments(parsed.segments, object.matrix), flatness);
  if (polylines.some((polyline) => polyline.points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y)))) return null;

  if (!isUnfilled(object.fill)) {
    const rings = polylines.filter((polyline) => polyline.points.length >= 3).map((polyline) => polyline.points.map(toPoint));
    if (rings.length === 0) return null;
    return { kind: "polygon", subjects: [{ type: "polygon", coordinates: rings }], vertexCount: rings.reduce((total, ring) => total + ring.length, 0) };
  }

  const subjects: GeometrySubject[] = [];
  let vertexCount = 0;
  for (const polyline of polylines) {
    if (polyline.points.length < 2) continue;
    const coordinates = polyline.points.map(toPoint);
    if (polyline.closed) coordinates.push(coordinates[0]);
    subjects.push({ type: "line", coordinates });
    vertexCount += coordinates.length;
  }
  return subjects.length === 0 ? null : { kind: "line", subjects, vertexCount };
}

// ---- Pieza -> path data ----

function ringSegments(ring: GeometryPoint[], close: boolean): PathSegment[] {
  const points = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] && close ? ring.slice(0, -1) : ring;
  const segments: PathSegment[] = points.map(([x, y], index) => (index === 0 ? { type: "M", x, y } : { type: "L", x, y }));
  if (close) segments.push({ type: "Z" });
  return segments;
}

/**
 * Pieza del servidor -> `d` en unidades de documento (`M … L … Z`; los huecos son subpaths). `null` si la pieza no alcanza para dibujar
 * algo válido (anillo con < 3 vértices, polilínea con < 2, coordenadas no finitas) o si el `d` resultante no se vuelve a leer sin error.
 */
export function pieceToPathData(piece: GeometryPiece): string | null {
  // Sin esta guarda, `segmentsToPathData` escribiría un NaN como "0" y la pieza "válida" sería geometría inventada.
  const rings: GeometryPoint[][] = piece.type === "polygon" ? piece.coordinates : [piece.coordinates];
  if (!rings.every((ring) => Array.isArray(ring) && ring.every(validPoint))) return null;
  let segments: PathSegment[];
  if (piece.type === "polygon") {
    segments = [];
    for (const ring of piece.coordinates) {
      const open = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.length - 1 : ring.length;
      if (open < 3) return null;
      segments.push(...ringSegments(ring, true));
    }
  } else {
    if (piece.coordinates.length < 2) return null;
    segments = ringSegments(piece.coordinates, false);
  }
  if (segments.length === 0) return null;
  const d = segmentsToPathData(segments);
  const reparsed = parsePathData(d);
  if (reparsed.error !== null || reparsed.segments.length === 0) return null;
  const bounds = segmentsBounds(reparsed.segments);
  return bounds !== null && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) ? d : null;
}

// ---- Validación de la respuesta ----

function validPoint(point: unknown): point is GeometryPoint {
  return Array.isArray(point) && point.length === 2 && typeof point[0] === "number" && typeof point[1] === "number" && Number.isFinite(point[0]) && Number.isFinite(point[1]);
}

export function validPiece(piece: unknown, expected: "polygon" | "line" | null): string | null {
  if (typeof piece !== "object" || piece === null) return "una pieza no tiene la forma esperada";
  const { type, coordinates } = piece as { type?: unknown; coordinates?: unknown };
  if (type !== "polygon" && type !== "line") return `una pieza tiene un tipo desconocido («${String(type)}»)`;
  if (expected !== null && type !== expected) return `una pieza «${type}» no corresponde a un objeto que solo admite «${expected}»`;
  if (!Array.isArray(coordinates)) return "una pieza no trae coordenadas";
  if (type === "line") {
    return coordinates.length >= 2 && coordinates.every(validPoint) ? null : "una polilínea tiene menos de 2 vértices o coordenadas no finitas";
  }
  if (coordinates.length === 0) return "un polígono no trae anillos";
  for (const ring of coordinates as unknown[]) {
    if (!Array.isArray(ring) || ring.length < 4 || !ring.every(validPoint)) return "un anillo tiene menos de 3 vértices o coordenadas no finitas";
    const first = ring[0] as GeometryPoint;
    const last = ring[ring.length - 1] as GeometryPoint;
    if (first[0] !== last[0] || first[1] !== last[1]) return "un anillo no está cerrado";
  }
  return null;
}

/**
 * Defensa del cliente (el editor NUNCA crea geometría inválida): la respuesta tiene que corresponder a LA petición -- una entrada por
 * subject en orden, piezas del tipo del subject (un polígono da polígonos, una línea da líneas), anillos cerrados y coordenadas
 * finitas. `null` si es coherente; si no, el motivo. Aunque el backend ya valida lo mismo, esto es lo último antes de tocar el documento.
 */
export function validateBooleanResponse(request: BooleanRequest, response: BooleanResponse): string | null {
  if (!response || !Array.isArray(response.results)) return "la respuesta no trae resultados";
  if (response.operation !== request.operation) return "la respuesta es de otra operación";
  const perSubject = PER_SUBJECT_OPERATIONS.has(request.operation);
  const expected = perSubject ? request.subjects.length : 1;
  if (response.results.length !== expected) return `trae ${response.results.length} resultados y se esperaban ${expected}`;

  for (let index = 0; index < response.results.length; index += 1) {
    const item = response.results[index];
    if (!item || !Array.isArray(item.geometries)) return "un resultado no trae geometrías";
    if (item.subjectIndex !== (perSubject ? index : null)) return "un resultado no corresponde a su subject";
    const expectedType = perSubject ? request.subjects[index].type : null;
    for (const piece of item.geometries) {
      const problem = validPiece(piece, expectedType);
      if (problem) return problem;
    }
  }
  return null;
}

// ---- Errores del servidor, en lenguaje de usuario ----

interface ApiErrorLike {
  isAborted?: boolean;
  isNetworkError?: boolean;
  status?: number;
  body?: unknown;
}

const NOTHING_CHANGED = "No se modificó nada.";

const ERROR_MESSAGES: Partial<Record<GeometryErrorCode, string>> = {
  engine_unavailable: `El motor de geometría no está disponible. ${NOTHING_CHANGED} Probá de nuevo en unos segundos.`,
  timeout: `El cálculo tardó demasiado y se canceló. ${NOTHING_CHANGED} Probá con un trazo más corto o un radio menor.`,
  too_many_subjects: `Hay demasiados objetos bajo el trazo para calcularlos juntos. ${NOTHING_CHANGED} Probá con un radio menor o con el modo Objeto.`,
  too_many_operands: `El trazo es demasiado complejo para calcularlo. ${NOTHING_CHANGED}`,
  too_many_vertices: `La geometría afectada es demasiado grande para calcularla. ${NOTHING_CHANGED} Probá con un radio menor o acercate a una zona más chica.`,
  payload_too_large: `La geometría afectada es demasiado grande para calcularla. ${NOTHING_CHANGED} Probá con un radio menor.`,
  invalid_response: `El servidor devolvió un resultado que no se puede usar. ${NOTHING_CHANGED}`,
  invalid_result: `El servidor devolvió un resultado que no se puede usar. ${NOTHING_CHANGED}`,
  processing_error: `El servidor no pudo completar el cálculo. ${NOTHING_CHANGED}`,
  internal_error: `El servidor no pudo completar el cálculo. ${NOTHING_CHANGED}`,
  invalid_coordinates: `El servidor rechazó la geometría (coordenadas no válidas). ${NOTHING_CHANGED}`,
  invalid_parameters: `El servidor rechazó la geometría. ${NOTHING_CHANGED}`,
  invalid_tolerance: `El servidor rechazó la tolerancia. ${NOTHING_CHANGED}`,
  unknown_operation: `El servidor no reconoce la operación. ${NOTHING_CHANGED}`,
};

/** Mensaje para el usuario ante un fallo del servicio de geometría: siempre dice que NO se modificó nada y, si se puede, qué hacer. */
export function geometryErrorMessage(error: unknown): string {
  const candidate = (typeof error === "object" && error !== null ? error : {}) as ApiErrorLike;
  if (candidate.isAborted) return `La operación fue cancelada. ${NOTHING_CHANGED}`;
  if (candidate.isNetworkError) return `No se pudo contactar con el servidor. ${NOTHING_CHANGED} Revisá la conexión y reintentá.`;
  const code = (candidate.body as { code?: unknown } | undefined)?.code;
  if (typeof code === "string" && code in ERROR_MESSAGES) return ERROR_MESSAGES[code as GeometryErrorCode]!;
  if (candidate.status === 413) return ERROR_MESSAGES.payload_too_large!;
  if (candidate.status === 503) return ERROR_MESSAGES.engine_unavailable!;
  if (candidate.status === 504) return ERROR_MESSAGES.timeout!;
  return `El servidor no pudo completar la operación. ${NOTHING_CHANGED}`;
}
