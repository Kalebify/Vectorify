import type { ManufacturingOperationValue } from "../../types/manufacturingOperations";
import type { FloatingMode } from "../../types/geometry";
import { IDENTITY_MATRIX, type AffineMatrix } from "../svgTransform";
import type { FloatingAnalysis, FloatingPlan } from "./floating";
import { issueDescription } from "./floating";
import { DEFAULT_FLATNESS_MM, fromDocumentUnits, toDocumentUnits, unitScale, type UnitScale } from "./geometry";
import { isFiniteMatrix } from "./matrix";
import { isUnfilled, objectBounds, unionRects } from "./objects";
import { serialOf } from "./offset";
import { distanceToPolylines, flattenSegments, parsePathDataCached, transformSegments, type PathSegment, type Polyline } from "./pathGeometry";
import type { EditableDocument, EditableLayerMeta, EditorObject, Point, Rect } from "./types";
import { formatDisplayNumber } from "./units";

/**
 * Laser Checker del editor (M3-S14): analiza la geometría EDITADA EN MEMORIA (`EditableDocument`: capas efectivas + objetos confirmados) y devuelve los problemas de
 * fabricabilidad con la geometría que los provoca. Módulo PURO (sin React ni DOM). No reemplaza al checker de M1-S08 (`/api/v1/.../check`): ese analiza versiones
 * GUARDADAS y solo M/L/Z, así que no ve ediciones sin guardar ni curvas del editor.
 *
 * Decisiones (documentadas también en `docs/ADR_EDITOR_MVP3.md`):
 * 1. **Relevancia por operación.** Capas `ignore` y ocultas no se analizan; las bloqueadas sí (solo lectura). Los paths abiertos y las piezas flotantes solo importan en
 *    CUT (en ENGRAVE un contorno abierto es una línea grabada válida). Una capa `unassigned` se analiza como CUT y lo dice (cada issue + un aviso de capa): nunca se
 *    asume Corte en silencio.
 * 2. **Umbrales en mm** (constantes exportadas). Sin escala física (`mmFactor` nulo) los mismos números se leen como UNIDADES del documento y el panel lo avisa
 *    (`NO_SCALE_CHECK_NOTICE`), igual que S11.
 * 3. **«Path abierto»** solo aplica a objetos con RELLENO en capas CUT: donde se espera un área. Una línea (`fill: none`) abierta es una línea de corte/grabado válida.
 *    Un subpath sin `Z` cuyo final queda a ≤ `CLOSE_TOLERANCE_MM` de su inicio se considera cerrado.
 * 4. **Duplicados** (dentro de la misma clase de operación: CUT+unassigned por un lado, ENGRAVE por otro; cortar y grabar el mismo contorno es legítimo): se compara la
 *    geometría HORNEADA (matriz aplicada) con una desviación simétrica sobre puntos muestreados por longitud de arco. ≤ `DUPLICATE_EXACT_TOLERANCE_MM` = exacto (error),
 *    ≤ `DUPLICATE_NEAR_TOLERANCE_MM` = casi (aviso). El redundante es el de más arriba en el orden de pintado.
 * 5. **Detalle pequeño**: ancho mínimo de cada subforma (ancho del casco convexo; para una línea abierta, su largo). Un detalle < umbral no se corta/graba de forma fiable.
 *    Límite conocido: un estrechamiento CÓNCAVO dentro de una forma grande no se detecta (el casco lo oculta).
 * 6. **Geometría inválida**: path ilegible, matriz o coordenadas no finitas, sin área / sin largo, subformas degeneradas y AUTOINTERSECCIÓN (cruces propios entre
 *    segmentos aplanados). La autointersección tiene un presupuesto de comparaciones; si se agota, el check queda NO VERIFICADO (nunca «OK»).
 * 7. **Complejidad** por nº de nodos (M/L/C) por objeto y por capa.
 * 8. **Severidad → estado global**: `blocking` si hay algún issue `error`; `review` si solo hay avisos O si algún check no se pudo verificar; `ready` solo con cero
 *    issues Y todos los checks verificados. Las piezas flotantes las calcula el servidor (S11) de forma asíncrona: se integran con `buildReport`.
 */

// ---- Umbrales (mm; unidades del documento sin escala física) ----

/** Detalle mínimo en CUT (≈ ancho del kerf de un láser de CO2). */
export const MIN_DETAIL_CUT_MM = 0.1;
/** Detalle mínimo en ENGRAVE: más laxo que CUT (el grabado resuelve mejor detalles finos que el corte). */
export const MIN_DETAIL_ENGRAVE_MM = 0.05;
/** Un subpath abierto cuyo final queda a esta distancia de su inicio se trata como cerrado (ruido de exportación). */
export const CLOSE_TOLERANCE_MM = 0.01;
/** Dos objetos coinciden «exactamente» si su desviación máxima es ≤ a esto (1 µm: ruido numérico, no una diferencia real). */
export const DUPLICATE_EXACT_TOLERANCE_MM = 0.001;
/** Dos objetos son «casi duplicados» si su desviación máxima es ≤ a esto (la mitad del kerf: el láser corta casi el mismo surco dos veces). */
export const DUPLICATE_NEAR_TOLERANCE_MM = 0.05;
/** Una subforma con un ancho menor a esto no tiene área real (degenerada). */
export const DEGENERATE_WIDTH_MM = 0.0001;
/** Nodos (M/L/C) a partir de los cuales un objeto o una capa se considera demasiado complejo. */
export const MAX_NODES_PER_OBJECT = 5_000;
export const MAX_NODES_PER_LAYER = 50_000;
/** Presupuesto de comparaciones segmento-segmento de la autointersección: por objeto y en total. Si se agota el check queda NO VERIFICADO. */
export const MAX_SELF_INTERSECTION_TESTS_PER_OBJECT = 2_000_000;
export const MAX_SELF_INTERSECTION_TESTS_TOTAL = 20_000_000;
/** Tolerancia de aplanado de las curvas (la de todo el servicio de geometría). */
export const LASER_CHECK_FLATNESS_MM = DEFAULT_FLATNESS_MM;
/** Puntos por objeto del muestreo de duplicados. */
const DUPLICATE_SAMPLES = 24;
/** Cruces que se cuentan por objeto antes de dejar de buscar (alcanza para el mensaje). */
const MAX_CROSSINGS_REPORTED = 20;
/** Hasta cuántos issues se listan en el panel y cuántos se dibujan en el overlay (el resumen cuenta todos). */
export const MAX_LISTED_ISSUES = 200;
export const MAX_OVERLAY_ISSUES = 300;
/** Modo de las piezas flotantes: el default de S11 (las formas son cortes y una isla es material rodeado de corte). */
export const LASER_CHECK_FLOATING_MODE: FloatingMode = "stencil";

export const NO_SCALE_CHECK_NOTICE = "Sin escala física: los umbrales (detalle mínimo, cierre, duplicados) se miden en unidades del documento (u), no en mm.";

// ---- Tipos ----

export type LaserCheckKind = "invalid_geometry" | "open_path" | "duplicate_exact" | "floating" | "duplicate_near" | "tiny_detail" | "complexity" | "unassigned_layer";
export type LaserCheckSeverity = "error" | "warning";
export type LaserCheckStatus = "ready" | "review" | "blocking";

/** Geometría a resaltar de un issue: `d` en el espacio del objeto y su matriz (identidad si `d` ya está en el documento). */
export interface LaserCheckHighlight {
  d: string;
  matrix: AffineMatrix;
  filled: boolean;
}

export interface LaserCheckIssue {
  /** Estable entre análisis del mismo documento (permite conservar la selección tras re-analizar). */
  id: string;
  kind: LaserCheckKind;
  severity: LaserCheckSeverity;
  layerGroupId: string;
  layerName: string;
  operation: ManufacturingOperationValue;
  /** La capa no tiene operación asignada: el issue se evaluó como CUT. */
  unassigned: boolean;
  /** Objetos implicados (el primero es el «principal»). Vacío en los issues de CAPA completa. */
  objectIds: string[];
  /** «Rojo · objeto 2», «Isla 1» o «Capa Rojo». */
  objectLabel: string;
  message: string;
  suggestion: string;
  /** Rectángulo (documento) al que se centra la vista; `null` si no hay geometría que mostrar. */
  rect: Rect | null;
  highlights: LaserCheckHighlight[];
  /** Posición determinista en el documento (orden de pintado) para ordenar. */
  order: number;
}

/** Un check que NO se pudo correr: nunca cuenta como «OK». */
export interface UnverifiedCheck {
  id: "self_intersection" | "floating" | "scope";
  label: string;
  reason: string;
}

export interface LaserCheckScope {
  analyzedLayers: number;
  analyzedObjects: number;
  ignoredLayers: string[];
  hiddenLayers: string[];
  lockedLayers: string[];
}

export interface LaserCheckLocalResult {
  /** Huella del documento analizado (`documentFingerprint`). */
  fingerprint: string;
  issues: LaserCheckIssue[];
  unverified: UnverifiedCheck[];
  unit: UnitScale;
  scaleNotice: string | null;
  scope: LaserCheckScope;
  /** Objetos con relleno de capas CUT/unassigned: lo que se manda al análisis de flotantes de S11. */
  floatingTargets: EditorObject[];
}

export type FloatingCheckState =
  | { state: "not_applicable" }
  | { state: "pending" }
  | { state: "unavailable"; message: string }
  | { state: "done"; issues: LaserCheckIssue[] };

export interface LaserCheckReport {
  status: LaserCheckStatus;
  issues: LaserCheckIssue[];
  unverified: UnverifiedCheck[];
  counts: { errors: number; warnings: number };
}

export const LASER_CHECK_KIND_INFO: Record<LaserCheckKind, { label: string; suggestion: string }> = {
  invalid_geometry: { label: "Geometría inválida", suggestion: "Reparar el objeto con la herramienta Path o eliminarlo." },
  open_path: { label: "Path abierto", suggestion: "Cerrar el path o asignar la capa a Engrave." },
  duplicate_exact: { label: "Duplicado exacto", suggestion: "Eliminar el duplicado." },
  floating: { label: "Pieza flotante", suggestion: "Agregar un bridge que la conecte (herramienta Flotantes) o descartarla." },
  duplicate_near: { label: "Casi duplicado", suggestion: "Revisar y eliminar el objeto sobrante: se cortaría dos veces casi en el mismo lugar." },
  tiny_detail: { label: "Detalle muy pequeño", suggestion: "Agrandar el detalle o quitarlo." },
  complexity: { label: "Complejidad excesiva", suggestion: "Simplificar el path (menos nodos) o dividirlo en objetos más pequeños." },
  unassigned_layer: { label: "Capa sin operación", suggestion: "Asignar Corte, Grabado o Ignorar a la capa en el panel de Capas." },
};

export const LASER_CHECK_SEVERITY_LABEL: Record<LaserCheckSeverity, string> = { error: "Bloqueante", warning: "Revisar" };
export const LASER_CHECK_STATUS_LABEL: Record<LaserCheckStatus, string> = { ready: "Ready", review: "Review", blocking: "Blocking" };

const KIND_RANK: Record<LaserCheckKind, number> = {
  invalid_geometry: 0,
  open_path: 1,
  duplicate_exact: 2,
  floating: 3,
  duplicate_near: 4,
  tiny_detail: 5,
  complexity: 6,
  unassigned_layer: 7,
};

const SEVERITY_RANK: Record<LaserCheckSeverity, number> = { error: 0, warning: 1 };
const KIND_SEVERITY: Record<LaserCheckKind, LaserCheckSeverity> = {
  invalid_geometry: "error",
  open_path: "error",
  duplicate_exact: "error",
  floating: "error",
  duplicate_near: "warning",
  tiny_detail: "warning",
  complexity: "warning",
  unassigned_layer: "warning",
};

// ---- Huella del documento ----

/**
 * Identifica el contenido que el análisis mira: cada capa (id, nombre, orden, visibilidad, bloqueo, operación) y la referencia de cada objeto (las referencias son
 * inmutables: otra referencia = otro contenido) más la escala. Igual huella => mismo resultado; distinta => el resultado quedó desactualizado.
 */
export function documentFingerprint(document: EditableDocument, mmFactor: number | null): string {
  const layers = layerList(document);
  const parts = layers.map(
    (layer) =>
      `${layer.groupId}|${layer.name}|${layer.order}|${layer.visible ? 1 : 0}${layer.locked ? 1 : 0}|${layer.manufacturingOperation}|${(document.objectsByLayer[layer.groupId] ?? []).map(serialOf).join(",")}`,
  );
  return `${mmFactor ?? "null"}#${parts.join(";")}`;
}

/** Capas efectivas en orden de pintado, más las que tienen objetos sin figurar en la estructura (se tratan como visibles y sin operación). */
function layerList(document: EditableDocument): EditableLayerMeta[] {
  const layers = [...(document.layers ?? [])];
  const known = new Set(layers.map((layer) => layer.groupId));
  for (const groupId of Object.keys(document.objectsByLayer)) {
    if (known.has(groupId)) continue;
    layers.push({ groupId, name: "Capa", colorHex: "#000000", order: layers.length, visible: true, locked: false, manufacturingOperation: "unassigned", isNew: false });
  }
  return layers;
}

// ---- Geometría auxiliar ----

interface Ring {
  points: Point[];
  /** Cerrado de verdad (`Z`) o con el final a ≤ tolerancia del inicio. */
  closed: boolean;
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function cross(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/** Casco convexo (cadena monótona de Andrew), sin repetir el primer punto. */
function convexHull(points: readonly Point[]): Point[] {
  const sorted = [...points].sort((p, q) => p.x - q.x || p.y - q.y);
  const unique = sorted.filter((p, i) => i === 0 || p.x !== sorted[i - 1].x || p.y !== sorted[i - 1].y);
  if (unique.length < 3) return unique;
  const lower: Point[] = [];
  for (const p of unique) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = unique.length - 1; i >= 0; i -= 1) {
    const p = unique[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

const MAX_HULL_FOR_WIDTH = 2_000;

/** Ancho mínimo del casco convexo de la subforma (calibres rotantes). 0 si colapsa en un punto o una recta. */
export function minimumWidth(points: readonly Point[]): number {
  const hull = convexHull(points);
  if (hull.length < 3) return 0;
  if (hull.length > MAX_HULL_FOR_WIDTH) {
    // Casco enorme (curva muy fina): se acota con el bbox, que solo puede SOBRESTIMAR el ancho (nunca inventa un problema).
    const xs = hull.map((p) => p.x);
    const ys = hull.map((p) => p.y);
    return Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  }
  let best = Infinity;
  for (let i = 0; i < hull.length; i += 1) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const length = dist(a, b);
    if (length === 0) continue;
    let far = 0;
    for (const p of hull) far = Math.max(far, Math.abs(cross(a, b, p)) / length);
    best = Math.min(best, far);
  }
  return best === Infinity ? 0 : best;
}

function polylineLength(points: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += dist(points[i - 1], points[i]);
  return total;
}

function pathLength(polylines: readonly Polyline[]): number {
  return polylines.reduce((total, polyline) => total + polylineLength(polyline.points) + (polyline.closed && polyline.points.length > 1 ? dist(polyline.points[polyline.points.length - 1], polyline.points[0]) : 0), 0);
}

/** Puntos repartidos por longitud de arco a lo largo de todas las polilíneas (las cerradas incluyen su lado de cierre). */
function samplePolylines(polylines: readonly Polyline[], count: number): Point[] {
  const segments: Array<[Point, Point]> = [];
  for (const { points, closed } of polylines) {
    for (let i = 1; i < points.length; i += 1) segments.push([points[i - 1], points[i]]);
    if (closed && points.length > 2) segments.push([points[points.length - 1], points[0]]);
  }
  const total = segments.reduce((sum, [a, b]) => sum + dist(a, b), 0);
  if (segments.length === 0 || total === 0) {
    const first = polylines.find((polyline) => polyline.points.length > 0)?.points[0];
    return first ? [first] : [];
  }
  const out: Point[] = [];
  let index = 0;
  let walked = 0;
  for (let k = 0; k < count; k += 1) {
    const target = ((k + 0.5) * total) / count;
    while (index < segments.length - 1 && walked + dist(segments[index][0], segments[index][1]) < target) {
      walked += dist(segments[index][0], segments[index][1]);
      index += 1;
    }
    const [a, b] = segments[index];
    const length = dist(a, b);
    const t = length === 0 ? 0 : Math.min(1, Math.max(0, (target - walked) / length));
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return out;
}

function segmentsFinite(segments: readonly PathSegment[]): boolean {
  return segments.every((segment) => {
    switch (segment.type) {
      case "M":
      case "L":
        return Number.isFinite(segment.x) && Number.isFinite(segment.y);
      case "C":
        return [segment.x1, segment.y1, segment.x2, segment.y2, segment.x, segment.y].every(Number.isFinite);
      case "Z":
        return true;
    }
  });
}

// ---- Autointersección ----

interface SweepSegment {
  ring: number;
  index: number;
  size: number;
  a: Point;
  b: Point;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

function properCrossing(a: Point, b: Point, c: Point, d: Point, eps: number): boolean {
  const d1 = cross(a, b, c);
  const d2 = cross(a, b, d);
  const d3 = cross(c, d, a);
  const d4 = cross(c, d, b);
  return ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps));
}

/**
 * Cruces propios de un conjunto de subformas (un objeto): barrido por X sobre los segmentos aplanados. Los segmentos contiguos de una misma subforma comparten vértice y
 * no cuentan; un roce en un vértice tampoco (solo cruces propios). `budget` = comparaciones permitidas: si se agota devuelve `exhausted`.
 */
function countCrossings(rings: readonly Ring[], extent: number, budget: number): { crossings: number; tests: number; exhausted: boolean } {
  const segments: SweepSegment[] = [];
  rings.forEach((ring, ringIndex) => {
    const n = ring.points.length;
    for (let i = 0; i < n; i += 1) {
      const a = ring.points[i];
      const b = ring.points[(i + 1) % n];
      if (a.x === b.x && a.y === b.y) continue;
      segments.push({ ring: ringIndex, index: i, size: n, a, b, minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y) });
    }
  });
  segments.sort((p, q) => p.minX - q.minX);
  const eps = 1e-12 * extent * extent;
  let crossings = 0;
  let tests = 0;
  for (let i = 0; i < segments.length; i += 1) {
    const s = segments[i];
    for (let j = i + 1; j < segments.length && segments[j].minX <= s.maxX; j += 1) {
      const t = segments[j];
      if (t.minY > s.maxY || t.maxY < s.minY) continue;
      tests += 1;
      if (tests > budget) return { crossings, tests, exhausted: true };
      if (s.ring === t.ring) {
        const gap = Math.abs(s.index - t.index);
        if (gap === 1 || gap === s.size - 1) continue;
      }
      if (properCrossing(s.a, s.b, t.a, t.b, eps)) {
        crossings += 1;
        if (crossings >= MAX_CROSSINGS_REPORTED) return { crossings, tests, exhausted: false };
      }
    }
  }
  return { crossings, tests, exhausted: false };
}

// ---- Análisis por objeto ----

type OperationClass = "cut" | "engrave";

interface Prepared {
  object: EditorObject;
  layer: EditableLayerMeta;
  ordinal: number;
  cls: OperationClass;
  label: string;
  filled: boolean;
  unreadable: string | null;
  nodes: number;
  polylines: Polyline[];
  rings: Ring[];
  bounds: Rect | null;
}

function nodeCount(segments: readonly PathSegment[]): number {
  return segments.filter((segment) => segment.type !== "Z").length;
}

function prepare(object: EditorObject, layer: EditableLayerMeta, ordinal: number, index: number, flatness: number, closeTolerance: number): Prepared {
  const base = {
    object,
    layer,
    ordinal,
    cls: (layer.manufacturingOperation === "engrave" ? "engrave" : "cut") as OperationClass,
    label: `${layer.name} · objeto ${index + 1}`,
    filled: !isUnfilled(object.fill),
    nodes: 0,
    polylines: [] as Polyline[],
    rings: [] as Ring[],
    bounds: null as Rect | null,
  };
  if (!isFiniteMatrix(object.matrix)) return { ...base, unreadable: "la matriz de transformación no es finita" };
  const parsed = parsePathDataCached(object.d);
  if (parsed.error !== null) return { ...base, unreadable: `el path no se puede leer (${parsed.error})` };
  if (parsed.segments.length === 0) return { ...base, unreadable: "el path está vacío" };
  const baked = transformSegments(parsed.segments, object.matrix);
  if (!segmentsFinite(baked)) return { ...base, unreadable: "el path tiene coordenadas no finitas" };

  const polylines = flattenSegments(baked, flatness)
    .map((polyline) => ({ ...polyline, points: polyline.points.filter((p, i, all) => i === 0 || p.x !== all[i - 1].x || p.y !== all[i - 1].y) }))
    .filter((polyline) => polyline.points.length > 0);
  const rings: Ring[] = [];
  for (const polyline of polylines) {
    const points = polyline.points;
    if (points.length < 2) continue; // un moveto suelto no dibuja nada
    const effectivelyClosed = polyline.closed || (points.length >= 3 && dist(points[0], points[points.length - 1]) <= closeTolerance);
    const trimmed = effectivelyClosed && points.length >= 3 && dist(points[0], points[points.length - 1]) <= closeTolerance ? points.slice(0, -1) : points;
    rings.push({ points: trimmed, closed: effectivelyClosed });
  }
  return { ...base, unreadable: null, nodes: nodeCount(parsed.segments), polylines, rings, bounds: objectBounds(object) };
}

interface ThresholdsInUnits {
  minDetailCut: number;
  minDetailEngrave: number;
  closeTolerance: number;
  exact: number;
  near: number;
  degenerate: number;
  flatness: number;
}

function thresholdsFor(unit: UnitScale): ThresholdsInUnits {
  return {
    minDetailCut: toDocumentUnits(MIN_DETAIL_CUT_MM, unit),
    minDetailEngrave: toDocumentUnits(MIN_DETAIL_ENGRAVE_MM, unit),
    closeTolerance: toDocumentUnits(CLOSE_TOLERANCE_MM, unit),
    exact: toDocumentUnits(DUPLICATE_EXACT_TOLERANCE_MM, unit),
    near: toDocumentUnits(DUPLICATE_NEAR_TOLERANCE_MM, unit),
    degenerate: toDocumentUnits(DEGENERATE_WIDTH_MM, unit),
    flatness: toDocumentUnits(LASER_CHECK_FLATNESS_MM, unit),
  };
}

/** Umbrales vigentes en una frase (para el panel): el usuario ve contra qué se mide. */
export function thresholdsText(mmFactor: number | null): string {
  const unit = unitScale(mmFactor);
  const l = unit.label;
  return `Umbrales: detalle mínimo ${formatDisplayNumber(MIN_DETAIL_CUT_MM)} ${l} en Corte y ${formatDisplayNumber(MIN_DETAIL_ENGRAVE_MM)} ${l} en Grabado · path cerrado si el hueco es ≤ ${formatDisplayNumber(CLOSE_TOLERANCE_MM)} ${l} · duplicado exacto ≤ ${formatDisplayNumber(DUPLICATE_EXACT_TOLERANCE_MM)} ${l}, casi duplicado ≤ ${formatDisplayNumber(DUPLICATE_NEAR_TOLERANCE_MM)} ${l} · complejidad: más de ${MAX_NODES_PER_OBJECT.toLocaleString("es-AR")} nodos por objeto o ${MAX_NODES_PER_LAYER.toLocaleString("es-AR")} por capa.`;
}

/** Primera letra en mayúscula y punto final. */
function sentence(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function highlightOf(object: EditorObject): LaserCheckHighlight {
  return { d: object.d, matrix: object.matrix, filled: !isUnfilled(object.fill) };
}

function unassignedNote(layer: EditableLayerMeta): string {
  return layer.manufacturingOperation === "unassigned" ? " La capa no tiene operación asignada: se analizó como Corte." : "";
}

function makeIssue(
  kind: LaserCheckKind,
  layer: EditableLayerMeta,
  ids: string[],
  objectLabel: string,
  message: string,
  rect: Rect | null,
  highlights: LaserCheckHighlight[],
  order: number,
  idSuffix = "",
): LaserCheckIssue {
  return {
    id: `${kind}:${ids.length > 0 ? ids.join("+") : `layer-${layer.groupId}`}${idSuffix}`,
    kind,
    severity: KIND_SEVERITY[kind],
    layerGroupId: layer.groupId,
    layerName: layer.name,
    operation: layer.manufacturingOperation,
    unassigned: layer.manufacturingOperation === "unassigned",
    objectIds: ids,
    objectLabel,
    message: `${message}${unassignedNote(layer)}`,
    suggestion: LASER_CHECK_KIND_INFO[kind].suggestion,
    rect,
    highlights,
    order,
  };
}

function compareIssues(a: LaserCheckIssue, b: LaserCheckIssue): number {
  return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

// ---- Análisis local ----

export interface LaserCheckOptions {
  /** mm por unidad de documento, o `null` sin escala física. */
  mmFactor: number | null;
  /** Presupuesto de comparaciones de la autointersección (solo para probar el «no verificado»; por defecto, las constantes exportadas). */
  selfIntersectionBudget?: { perObject: number; total: number };
}

/**
 * Corre los checks que no necesitan el servidor (todos menos las piezas flotantes) sobre el documento. Determinista: el mismo documento da los mismos issues en el mismo
 * orden. Total (nunca lanza): un objeto ilegible se informa como geometría inválida.
 */
export function analyzeLaserLocal(document: EditableDocument, options: LaserCheckOptions): LaserCheckLocalResult {
  const unit = unitScale(options.mmFactor);
  const t = thresholdsFor(unit);
  const fmt = (units: number) => formatDisplayNumber(fromDocumentUnits(units, unit), 3);
  const u = unit.label;

  const issues: LaserCheckIssue[] = [];
  const unverified: UnverifiedCheck[] = [];
  const scope: LaserCheckScope = { analyzedLayers: 0, analyzedObjects: 0, ignoredLayers: [], hiddenLayers: [], lockedLayers: [] };
  const floatingTargets: EditorObject[] = [];
  const prepared: Prepared[] = [];
  let ordinal = 0;
  let intersectionTests = 0;
  let intersectionSkipped = 0;
  const budgetPerObject = options.selfIntersectionBudget?.perObject ?? MAX_SELF_INTERSECTION_TESTS_PER_OBJECT;
  const budgetTotal = options.selfIntersectionBudget?.total ?? MAX_SELF_INTERSECTION_TESTS_TOTAL;

  for (const layer of layerList(document)) {
    const objects = document.objectsByLayer[layer.groupId] ?? [];
    if (!layer.visible) {
      scope.hiddenLayers.push(layer.name);
      continue;
    }
    if (layer.manufacturingOperation === "ignore") {
      scope.ignoredLayers.push(layer.name);
      continue;
    }
    if (objects.length === 0) continue;
    scope.analyzedLayers += 1;
    if (layer.locked) scope.lockedLayers.push(layer.name);
    const firstOrdinal = ordinal;
    const firstPrepared = prepared.length;
    let layerNodes = 0;

    objects.forEach((object, index) => {
      const item = prepare(object, layer, ordinal, index, t.flatness, t.closeTolerance);
      ordinal += 1;
      scope.analyzedObjects += 1;
      prepared.push(item);
      layerNodes += item.nodes;
      const rect = item.bounds;
      const one = [object.id];
      const lines = [highlightOf(object)];

      if (item.unreadable !== null) {
        issues.push(makeIssue("invalid_geometry", layer, one, item.label, sentence(item.unreadable), rect, lines, item.ordinal));
        return;
      }
      if (item.cls === "cut" && item.filled) floatingTargets.push(object);

      // -- Geometría inválida --
      // Subformas con área: con relleno todo subpath de ≥ 3 puntos (el relleno lo cierra); sin relleno, solo los contornos cerrados.
      const areaRings = item.rings.filter((ring) => ring.points.length >= 3 && (item.filled || ring.closed));
      const ringWidths = areaRings.map((ring) => minimumWidth(ring.points));
      const degenerate = ringWidths.filter((width) => width < t.degenerate).length;
      // Subforma cerrada de solo 2 puntos (p. ej. «M0 0 L5 5 Z»): tampoco tiene área.
      const degenerateCount = degenerate + item.rings.filter((ring) => ring.closed && ring.points.length === 2).length;
      const reasons: string[] = [];
      if (degenerateCount > 0) reasons.push(plural(degenerateCount, "subforma sin área (degenerada)", "subformas sin área (degeneradas)"));
      let noArea = false;
      if (item.filled && ringWidths.length - degenerate === 0 && degenerateCount === 0) {
        noArea = true;
        reasons.push("no tiene ninguna subforma cerrada con área");
      } else if (!item.filled && pathLength(item.polylines) <= t.degenerate && degenerateCount === 0) {
        noArea = true;
        reasons.push("no tiene largo (todos sus puntos coinciden)");
      }

      // Autointersección de las subformas con área (presupuesto acotado: si se agota, el check queda NO VERIFICADO).
      if (areaRings.length > 0 && item.bounds) {
        if (intersectionTests >= budgetTotal) {
          intersectionSkipped += 1;
        } else {
          const budget = Math.min(budgetPerObject, budgetTotal - intersectionTests);
          const result = countCrossings(areaRings, Math.max(item.bounds.width, item.bounds.height, 1e-9), budget);
          intersectionTests += result.tests;
          if (result.exhausted) intersectionSkipped += 1;
          else if (result.crossings > 0) {
            const count = result.crossings >= MAX_CROSSINGS_REPORTED ? `${MAX_CROSSINGS_REPORTED}+` : String(result.crossings);
            reasons.push(`se cruza consigo mismo (${count} ${result.crossings === 1 ? "cruce" : "cruces"})`);
          }
        }
      }
      if (reasons.length > 0) issues.push(makeIssue("invalid_geometry", layer, one, item.label, sentence(reasons.join("; ")), rect, lines, item.ordinal));

      // -- Path abierto: solo donde se espera un área (relleno en CUT) --
      if (item.cls === "cut" && item.filled && !noArea) {
        const gaps = item.rings.filter((ring) => !ring.closed).map((ring) => dist(ring.points[0], ring.points[ring.points.length - 1])).filter((gap) => gap > t.closeTolerance);
        if (gaps.length > 0) {
          issues.push(
            makeIssue(
              "open_path",
              layer,
              one,
              item.label,
              `${plural(gaps.length, "subpath abierto", "subpaths abiertos")} (sin cerrar; el hueco llega a ${fmt(Math.max(...gaps))} ${u}). Un contorno abierto no recorta una pieza.`,
              rect,
              lines,
              item.ordinal,
            ),
          );
        }
      }

      // -- Detalle muy pequeño: ancho de cada subforma con área; largo de cada línea abierta --
      const minDetail = item.cls === "cut" ? t.minDetailCut : t.minDetailEngrave;
      const tiny = ringWidths.filter((width) => width >= t.degenerate && width < minDetail);
      if (!item.filled) {
        for (const ring of item.rings.filter((candidate) => !candidate.closed)) {
          const length = polylineLength(ring.points);
          if (length > t.degenerate && length < minDetail) tiny.push(length);
        }
      }
      if (tiny.length > 0) {
        issues.push(
          makeIssue(
            "tiny_detail",
            layer,
            one,
            item.label,
            `${plural(tiny.length, "detalle más fino", "detalles más finos")} que ${fmt(minDetail)} ${u} (el mínimo para ${item.cls === "cut" ? "Corte" : "Grabado"}); el más fino mide ${fmt(Math.min(...tiny))} ${u}.`,
            rect,
            lines,
            item.ordinal,
          ),
        );
      }

      // -- Complejidad por objeto --
      if (item.nodes > MAX_NODES_PER_OBJECT) {
        issues.push(
          makeIssue("complexity", layer, one, item.label, `${item.nodes.toLocaleString("es-AR")} nodos (el umbral es ${MAX_NODES_PER_OBJECT.toLocaleString("es-AR")}).`, rect, lines, item.ordinal),
        );
      }
    });

    // -- Complejidad por capa y capa sin operación (issues de CAPA completa) --
    const layerRect = unionRects(prepared.slice(firstPrepared).flatMap((item) => (item.bounds ? [item.bounds] : [])));
    if (layerNodes > MAX_NODES_PER_LAYER) {
      issues.push(
        makeIssue(
          "complexity",
          layer,
          [],
          `Capa ${layer.name}`,
          `La capa «${layer.name}» suma ${layerNodes.toLocaleString("es-AR")} nodos (el umbral es ${MAX_NODES_PER_LAYER.toLocaleString("es-AR")}).`,
          layerRect,
          [],
          firstOrdinal - 0.5,
        ),
      );
    }
    if (layer.manufacturingOperation === "unassigned") {
      issues.push(
        makeIssue("unassigned_layer", layer, [], `Capa ${layer.name}`, `La capa «${layer.name}» no tiene operación de fabricación asignada: se analizó como Corte.`, layerRect, [], firstOrdinal - 0.5),
      );
    }
  }

  // -- Duplicados --
  for (const found of findDuplicates(prepared, t)) {
    const { later, earlier, level, deviation } = found;
    const kind: LaserCheckKind = level === "exact" ? "duplicate_exact" : "duplicate_near";
    const rect = unionRects([later.bounds, earlier.bounds].filter((rect): rect is Rect => rect !== null));
    const how = level === "exact" ? "coincide exactamente" : `casi coincide (desviación ${fmt(deviation)} ${u})`;
    issues.push(
      makeIssue(kind, later.layer, [later.object.id, earlier.object.id], later.label, `${later.label} ${how} con ${earlier.label}: se cortaría/grabaría dos veces.`, rect, [highlightOf(later.object), highlightOf(earlier.object)], later.ordinal),
    );
  }

  if (intersectionSkipped > 0) {
    unverified.push({
      id: "self_intersection",
      label: "Autointersección",
      reason: `${plural(intersectionSkipped, "objeto es demasiado complejo", "objetos son demasiado complejos")} para comprobar si se cruzan consigo mismos.`,
    });
  }

  // Sin ningún objeto analizable (todo oculto, ignorado o vacío) no se verificó nada: nunca «Ready».
  if (scope.analyzedObjects === 0) {
    unverified.push({ id: "scope", label: "Alcance", reason: "no hay objetos visibles y con operación distinta de Ignore para analizar." });
  }

  issues.sort(compareIssues);
  return {
    fingerprint: documentFingerprint(document, options.mmFactor),
    issues: dedupeIds(issues),
    unverified,
    unit,
    scaleNotice: unit.label === "mm" ? null : NO_SCALE_CHECK_NOTICE,
    scope,
    floatingTargets,
  };
}

/** Ids únicos y estables: dos issues del mismo tipo sobre los mismos objetos se distinguen por su orden. */
function dedupeIds(issues: LaserCheckIssue[]): LaserCheckIssue[] {
  const seen = new Map<string, number>();
  return issues.map((issue) => {
    const count = seen.get(issue.id) ?? 0;
    seen.set(issue.id, count + 1);
    return count === 0 ? issue : { ...issue, id: `${issue.id}#${count + 1}` };
  });
}

// ---- Duplicados ----

interface DuplicateFound {
  later: Prepared;
  earlier: Prepared;
  level: "exact" | "near";
  deviation: number;
}

function sameMatrix(a: AffineMatrix, b: AffineMatrix): boolean {
  return a.a === b.a && a.b === b.b && a.c === b.c && a.d === b.d && a.e === b.e && a.f === b.f;
}

function deviation(a: Prepared, b: Prepared): number {
  if (a.object.d === b.object.d && sameMatrix(a.object.matrix, b.object.matrix)) return 0;
  let worst = 0;
  for (const point of samplePolylines(a.polylines, DUPLICATE_SAMPLES)) worst = Math.max(worst, distanceToPolylines(b.polylines, point, true));
  for (const point of samplePolylines(b.polylines, DUPLICATE_SAMPLES)) worst = Math.max(worst, distanceToPolylines(a.polylines, point, true));
  return worst;
}

function findDuplicates(items: readonly Prepared[], t: ThresholdsInUnits): DuplicateFound[] {
  const found = new Map<number, DuplicateFound>();
  for (const cls of ["cut", "engrave"] as const) {
    const eligible = items
      .filter((item) => item.cls === cls && item.unreadable === null && item.bounds !== null && item.polylines.length > 0)
      .sort((p, q) => (p.bounds as Rect).x - (q.bounds as Rect).x);
    for (let i = 0; i < eligible.length; i += 1) {
      const a = eligible[i];
      const ra = a.bounds as Rect;
      for (let j = i + 1; j < eligible.length; j += 1) {
        const b = eligible[j];
        const rb = b.bounds as Rect;
        if (rb.x > ra.x + t.near) break;
        if (Math.abs(ra.y - rb.y) > t.near) continue;
        if (Math.abs(ra.x + ra.width - (rb.x + rb.width)) > t.near || Math.abs(ra.y + ra.height - (rb.y + rb.height)) > t.near) continue;
        const gap = deviation(a, b);
        if (gap > t.near) continue;
        const level = gap <= t.exact ? "exact" : "near";
        const [earlier, later] = a.ordinal < b.ordinal ? [a, b] : [b, a];
        const current = found.get(later.ordinal);
        const better = !current || (level === "exact" && current.level === "near") || (level === current.level && earlier.ordinal < current.earlier.ordinal);
        if (better) found.set(later.ordinal, { later, earlier, level, deviation: gap });
      }
    }
  }
  return [...found.values()];
}

// ---- Piezas flotantes (S11) -> issues ----

/**
 * Las piezas flotantes del análisis de S11 como issues del checker. `plan.objects[i]` es el objeto del subject `i`: de ahí salen la capa y los objetos que forman el
 * borde de la isla. El rectángulo es el de la isla (a lo que se centra la vista) y el resaltado, su polígono.
 */
export function floatingIssues(plan: FloatingPlan, analysis: FloatingAnalysis, document: EditableDocument): LaserCheckIssue[] {
  const layers = new Map(layerList(document).map((layer) => [layer.groupId, layer]));
  return analysis.issues.map((issue) => {
    const members = issue.component.subjects.map((subject) => plan.objects[subject]).filter((object): object is EditorObject => object !== undefined);
    const owners = members.length > 0 ? members : plan.objects.slice(0, 1);
    const primary = owners[0];
    const layer = layers.get(primary.layerGroupId) ?? layerList(document)[0];
    const ids = [...new Set(owners.map((object) => object.id))];
    const order = plan.objects.indexOf(primary);
    return makeIssue(
      "floating",
      layer,
      ids,
      issue.label,
      `${issueDescription(issue, plan.unit, plan.mode)}. Se cae al cortar.`,
      issue.rect,
      [{ d: issue.d, matrix: IDENTITY_MATRIX, filled: true }],
      order,
      `@${issue.id}`,
    );
  });
}

// ---- Informe combinado ----

export function laserCheckStatus(issues: readonly LaserCheckIssue[], unverified: readonly UnverifiedCheck[]): LaserCheckStatus {
  if (issues.some((issue) => issue.severity === "error")) return "blocking";
  if (issues.length > 0 || unverified.length > 0) return "review";
  return "ready";
}

/** Une los issues locales con el resultado (asíncrono) de las flotantes. «Pendiente» y «no disponible» son NO VERIFICADO: nunca `ready`. */
export function buildReport(local: LaserCheckLocalResult, floating: FloatingCheckState): LaserCheckReport {
  const unverified = [...local.unverified];
  let issues = local.issues;
  if (floating.state === "done") issues = dedupeIds([...issues, ...floating.issues].sort(compareIssues));
  else if (floating.state === "pending") unverified.push({ id: "floating", label: "Piezas flotantes", reason: "analizando en el servidor…" });
  else if (floating.state === "unavailable") unverified.push({ id: "floating", label: "Piezas flotantes", reason: floating.message });
  const errors = issues.filter((issue) => issue.severity === "error").length;
  return { status: laserCheckStatus(issues, unverified), issues, unverified, counts: { errors, warnings: issues.length - errors } };
}

/** Resumen para la región aria-live: estado global, cuántos issues y qué no se pudo verificar. */
export function reportSummary(report: LaserCheckReport): string {
  const head = `Laser Check: ${LASER_CHECK_STATUS_LABEL[report.status]}.`;
  const counts =
    report.issues.length === 0
      ? "Sin problemas detectados."
      : `${plural(report.counts.errors, "bloqueante", "bloqueantes")} y ${plural(report.counts.warnings, "aviso", "avisos")}.`;
  const pending = report.unverified.length > 0 ? ` No verificado: ${report.unverified.map((check) => check.label).join(", ")}.` : "";
  return `${head} ${counts}${pending}`;
}

/** Qué se analizó, en una frase: transparencia sobre lo que NO entró (ocultas, ignoradas). */
export function scopeText(scope: LaserCheckScope): string {
  const parts = [`Se analizaron ${plural(scope.analyzedLayers, "capa", "capas")} (${plural(scope.analyzedObjects, "objeto", "objetos")}).`];
  if (scope.ignoredLayers.length > 0) parts.push(`Ignoradas por su operación: ${scope.ignoredLayers.join(", ")}.`);
  if (scope.hiddenLayers.length > 0) parts.push(`Ocultas (no se analizan): ${scope.hiddenLayers.join(", ")}.`);
  if (scope.lockedLayers.length > 0) parts.push(`Bloqueadas (se analizan, solo lectura): ${scope.lockedLayers.join(", ")}.`);
  return parts.join(" ");
}
