import { IDENTITY_MATRIX } from "../svgTransform";
import type { BooleanRequest, GeometryPiece } from "../../types/geometry";
import { createColorLayer } from "./colors";
import { pieceToPathData } from "./geometry";
import { segmentsToPathData, type PathSegment } from "./pathGeometry";
import type { EditableDocument, EditableLayerMeta, EditorObject, EditProduction, Point } from "./types";

/**
 * Draw (M3-S04): correcciones simples con la pluma (polilínea) o a mano alzada -- no es una herramienta de ilustración. Todo puro:
 * validez del trazo, simplificación Ramer–Douglas–Peucker, conversión a `d`, objetos nuevos (abiertos vs. cerrados) y la CAPA de destino.
 *
 * Decisiones de dominio (spec M3-S04):
 * - **Capa activa**: la capa seleccionada en el panel de capas (o la del objeto seleccionado: seleccionar un objeto activa su capa). Si es
 *   visible y no está bloqueada, ahí va la geometría. Si no hay capa activa se crea una capa NUEVA y explícita «Dibujo» en el MISMO comando
 *   (mismo mecanismo y atomicidad que Fill con un color nuevo, S03; negro `#000000`, editable luego con Fill/Color). Si está bloqueada u
 *   oculta se RECHAZA con un mensaje claro: nunca se dibuja en otra capa en silencio.
 * - **Cerrado vs. abierto**: un trazo cerrado es un relleno con el color de la capa (sin trazo); uno abierto es `fill: "none"` con trazo del
 *   color de la capa y ancho por defecto 0,1 mm (línea fina de corte/grabado).
 * - **Auto-intersecciones**: un cerrado que se cruza a sí mismo NO se crea tal cual (sería geometría inválida): se normaliza con el
 *   servidor (`normalize`), y si el servidor no responde el trazo se rechaza con mensaje.
 * - Sin suavizado Bézier de la mano alzada (la tarjeta lo deja opcional): el trazo simplificado queda como polilínea, exacta y determinista.
 */

export type DrawMode = "polyline" | "freehand";

/** Ancho por defecto de una línea abierta: 0,1 mm. */
export const DEFAULT_LINE_WIDTH_MM = 0.1;
/** Tolerancia de simplificación de la mano alzada, en mm. */
export const DEFAULT_SIMPLIFY_MM = 0.2;
/** Color de la capa que crea Draw cuando no hay capa activa. */
export const DEFAULT_DRAW_COLOR = "#000000";
export const DRAWING_LAYER_NAME = "Dibujo";
/** Tope de puntos de un trazo y de coordenadas (unidades de documento): corta entradas absurdas antes de tocar el documento. */
export const MAX_DRAW_POINTS = 20_000;
export const MAX_DRAW_COORDINATE = 1_000_000;
/** Más puntos que esto no se revisan en el cliente (O(n²)): un cerrado así se manda al servidor para normalizarlo. */
const MAX_LOCAL_INTERSECTION_POINTS = 1500;

// ---- Trazo ----

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Quita los puntos que quedan a ≤ `epsilon` del último conservado (clicks dobles, temblor del mouse). El primero y el orden se conservan. */
export function dedupePoints(points: readonly Point[], epsilon: number): Point[] {
  const kept: Point[] = [];
  for (const point of points) {
    const last = kept[kept.length - 1];
    if (!last || distance(last, point) > epsilon) kept.push(point);
  }
  return kept;
}

function distanceToChord(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return distance(point, start);
  // Distancia a la RECTA (Douglas–Peucker clásico); el cuerpo ya está acotado por los extremos del tramo.
  return Math.abs(dx * (start.y - point.y) - (start.x - point.x) * dy) / Math.sqrt(lengthSquared);
}

/**
 * Ramer–Douglas–Peucker iterativo (sin recursión: un trazo largo no desborda la pila). Conserva siempre el primer y el último punto y
 * cada punto que se aparta MÁS de `tolerance` de la cuerda de su tramo; ante un empate gana el primero (resultado determinista).
 */
export function simplifyPolyline(points: readonly Point[], tolerance: number): Point[] {
  if (points.length <= 2 || !(tolerance > 0)) return [...points];
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    let farthest = -1;
    let farthestDistance = tolerance;
    for (let index = first + 1; index < last; index += 1) {
      const gap = distanceToChord(points[index], points[first], points[last]);
      if (gap > farthestDistance) {
        farthestDistance = gap;
        farthest = index;
      }
    }
    if (farthest !== -1) {
      keep[farthest] = true;
      stack.push([first, farthest], [farthest, last]);
    }
  }
  return points.filter((_, index) => keep[index]);
}

/** Área con signo (fórmula del cordón); su valor absoluto es el área encerrada por un polígono simple. */
export function polygonArea(points: readonly Point[]): number {
  let twice = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    twice += current.x * next.y - next.x * current.y;
  }
  return twice / 2;
}

function turn(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function withinSpan(a: number, b: number, value: number): boolean {
  return value >= Math.min(a, b) && value <= Math.max(a, b);
}

/** ¿Se cruzan (o se tocan) los segmentos p1-p2 y p3-p4? */
export function segmentsIntersect(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const d1 = turn(p3, p4, p1);
  const d2 = turn(p3, p4, p2);
  const d3 = turn(p1, p2, p3);
  const d4 = turn(p1, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const touches = (a: Point, b: Point, c: Point, orientation: number) => orientation === 0 && withinSpan(a.x, b.x, c.x) && withinSpan(a.y, b.y, c.y);
  return touches(p3, p4, p1, d1) || touches(p3, p4, p2, d2) || touches(p1, p2, p3, d3) || touches(p1, p2, p4, d4);
}

/**
 * ¿El polígono (anillo implícitamente cerrado) se cruza consigo mismo? Revisa cada par de lados NO contiguos y los contiguos que se
 * superponen (una "espina" que vuelve sobre sí). Con más de `MAX_LOCAL_INTERSECTION_POINTS` puntos responde `true` sin revisar: el
 * servidor decide (la normalización de un anillo válido lo devuelve igual).
 */
export function selfIntersects(points: readonly Point[]): boolean {
  const count = points.length;
  if (count < 4) {
    // Un triángulo no puede cruzarse; menos de 3 puntos tampoco encierra nada.
    return false;
  }
  if (count > MAX_LOCAL_INTERSECTION_POINTS) return true;
  for (let i = 0; i < count; i += 1) {
    const a1 = points[i];
    const a2 = points[(i + 1) % count];
    for (let j = i + 1; j < count; j += 1) {
      const b1 = points[j];
      const b2 = points[(j + 1) % count];
      const adjacent = j === i + 1 || (i === 0 && j === count - 1);
      if (adjacent) {
        // Comparten un vértice: solo es problema si se superponen en línea (vuelta atrás).
        const shared = j === i + 1 ? a2 : a1;
        const farA = j === i + 1 ? a1 : a2;
        const farB = j === i + 1 ? b2 : b1;
        if (turn(farA, shared, farB) === 0 && (farA.x - shared.x) * (farB.x - shared.x) + (farA.y - shared.y) * (farB.y - shared.y) > 0) return true;
        continue;
      }
      if (segmentsIntersect(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

export type StrokePlan = { ok: true; points: Point[]; closed: boolean; needsNormalize: boolean } | { ok: false; error: string };

/**
 * Valida un trazo y lo deja listo para crear: sin NaN, dentro de límites razonables, ≥ 2 puntos DISTINTOS (abierto) o ≥ 3 con área >
 * `minDistance`² (cerrado). `minDistance` (unidades de documento) es lo mínimo que separa dos puntos como distintos. `needsNormalize` =
 * cerrado que se auto-intersecta: hay que pasarlo por el servidor antes de crearlo.
 */
export function planStroke(points: readonly Point[], closed: boolean, minDistance: number): StrokePlan {
  if (points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y) || Math.abs(point.x) > MAX_DRAW_COORDINATE || Math.abs(point.y) > MAX_DRAW_COORDINATE)) {
    return { ok: false, error: "El trazo tiene coordenadas fuera de rango o no válidas. No se creó nada." };
  }
  const cleaned = dedupePoints(points, minDistance);
  if (closed && cleaned.length > 1 && distance(cleaned[0], cleaned[cleaned.length - 1]) <= minDistance) cleaned.pop();
  if (cleaned.length > MAX_DRAW_POINTS) {
    return { ok: false, error: `El trazo tiene demasiados puntos (más de ${MAX_DRAW_POINTS.toLocaleString("es-AR")}). No se creó nada.` };
  }
  if (!closed) {
    return cleaned.length >= 2 ? { ok: true, points: cleaned, closed: false, needsNormalize: false } : { ok: false, error: "Una línea necesita al menos 2 puntos distintos. No se creó nada." };
  }
  if (cleaned.length < 3) return { ok: false, error: "Un trazo cerrado necesita al menos 3 puntos distintos. No se creó nada." };
  const needsNormalize = selfIntersects(cleaned);
  // El área con signo de un anillo que se cruza puede cancelarse (un "moño" simétrico da 0): solo un anillo SIMPLE se descarta por falta de área.
  if (!needsNormalize && Math.abs(polygonArea(cleaned)) <= minDistance * minDistance) {
    return { ok: false, error: "El trazo cerrado no encierra área (puntos alineados o casi iguales). No se creó nada." };
  }
  return { ok: true, points: cleaned, closed: true, needsNormalize };
}

/** `d` del trazo: `M x y L … [Z]` (absoluto, 6 decimales como el resto del editor). */
export function drawPathData(points: readonly Point[], closed: boolean): string {
  const segments: PathSegment[] = points.map((point, index) => (index === 0 ? { type: "M", x: point.x, y: point.y } : { type: "L", x: point.x, y: point.y }));
  if (closed) segments.push({ type: "Z" });
  return segmentsToPathData(segments);
}

/** Petición `normalize` de un anillo que se auto-intersecta: el servidor lo hace válido (un "moño" son dos triángulos) y devuelve 1..N piezas. */
export function buildNormalizeRequest(points: readonly Point[], tolerance: number): BooleanRequest {
  return { operation: "normalize", subjects: [{ type: "polygon", coordinates: [points.map((point): [number, number] => [point.x, point.y])] }], operands: [], tolerance };
}

// ---- Capa de destino ----

export function drawingLayerName(existingNames: readonly string[]): string {
  if (!existingNames.includes(DRAWING_LAYER_NAME)) return DRAWING_LAYER_NAME;
  let suffix = 2;
  while (existingNames.includes(`${DRAWING_LAYER_NAME} (${suffix})`)) suffix += 1;
  return `${DRAWING_LAYER_NAME} (${suffix})`;
}

/** La capa «Dibujo»: la de un color nuevo de S03 (negro, orden al final, visible, desbloqueada, `isNew`) con su nombre propio. */
export function createDrawingLayer(layers: readonly EditableLayerMeta[], groupId: string): EditableLayerMeta | null {
  const base = createColorLayer(layers, DEFAULT_DRAW_COLOR, groupId);
  return base ? { ...base, name: drawingLayerName(layers.map((layer) => layer.name)) } : null;
}

export type DrawTarget = { kind: "existing"; layer: EditableLayerMeta } | { kind: "create"; groupId: string };
export type DrawTargetResult = { ok: true; target: DrawTarget } | { ok: false; message: string };

/**
 * Capa de destino de la geometría nueva (decisión 1 de la tarjeta): la capa activa si es visible y no está bloqueada; sin capa activa (o
 * una que ya no existe, p. ej. tras deshacer su creación) una capa «Dibujo» nueva con `newGroupId`; bloqueada u oculta -> rechazo claro.
 */
export function resolveDrawTarget(layers: readonly EditableLayerMeta[], activeGroupId: string | null, newGroupId: string): DrawTargetResult {
  const active = activeGroupId === null ? undefined : layers.find((layer) => layer.groupId === activeGroupId);
  if (!active) return { ok: true, target: { kind: "create", groupId: newGroupId } };
  if (active.locked) return { ok: false, message: `La capa «${active.name}» está bloqueada. Desbloqueá la capa «${active.name}» o elegí otra. No se creó nada.` };
  if (!active.visible) return { ok: false, message: `La capa «${active.name}» está oculta. Mostrá la capa «${active.name}» o elegí otra. No se creó nada.` };
  return { ok: true, target: { kind: "existing", layer: active } };
}

/** Capa y color con los que se crean los objetos nuevos. */
export function drawTargetInfo(target: DrawTarget): { groupId: string; colorHex: string } {
  return target.kind === "existing" ? { groupId: target.layer.groupId, colorHex: target.layer.colorHex } : { groupId: target.groupId, colorHex: DEFAULT_DRAW_COLOR };
}

// ---- Objetos nuevos ----

interface NewObjectBase {
  layerGroupId: string;
  colorHex: string;
}

/** Objeto de un trazo: cerrado = relleno con el color de la capa (sin trazo); abierto = `fill: "none"` + trazo del color de la capa. */
export function createDrawnObject(args: NewObjectBase & { id: string; points: readonly Point[]; closed: boolean; lineWidth: number }): EditorObject {
  const d = drawPathData(args.points, args.closed);
  return args.closed
    ? { id: args.id, layerGroupId: args.layerGroupId, d, fill: args.colorHex, matrix: IDENTITY_MATRIX }
    : { id: args.id, layerGroupId: args.layerGroupId, d, fill: "none", stroke: args.colorHex, strokeWidth: args.lineWidth, matrix: IDENTITY_MATRIX };
}

/** Piezas poligonales (resultado de `normalize`) -> objetos rellenos con ids nuevos. Una pieza ilegible descarta TODO (`null`): nunca se crea a medias. */
export function objectsFromPolygonPieces(pieces: readonly GeometryPiece[], args: NewObjectBase & { createId: () => string }): EditorObject[] | null {
  const objects: EditorObject[] = [];
  for (const piece of pieces) {
    if (piece.type !== "polygon") return null;
    const d = pieceToPathData(piece);
    if (d === null) return null;
    objects.push({ id: args.createId(), layerGroupId: args.layerGroupId, d, fill: args.colorHex, matrix: IDENTITY_MATRIX });
  }
  return objects.length > 0 ? objects : null;
}

/**
 * Producción del comando de Draw: los objetos van al final de la capa de destino. Con capa existente se agregan a ella; con capa NUEVA el
 * comando incluye la creación de la capa (`layerMetas`) -- capa + objetos en UN comando, atómico (undo la elimina junto con el trazo).
 */
export function buildDrawProduction(state: EditableDocument, objects: readonly EditorObject[], target: DrawTarget): EditProduction | null {
  if (objects.length === 0) return null;
  if (target.kind === "existing") {
    const groupId = target.layer.groupId;
    return { layers: { [groupId]: [...(state.objectsByLayer[groupId] ?? []), ...objects] }, atomic: true };
  }
  const layer = createDrawingLayer(state.layers ?? [], target.groupId);
  if (!layer) return null;
  return { layers: { [layer.groupId]: [...objects] }, layerMetas: [layer], atomic: true };
}
