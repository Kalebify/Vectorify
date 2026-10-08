import { applyMatrixToPoint, invertMatrix } from "./matrix";
import { parsePathDataCached, segmentsBounds, segmentsToPathData, type PathSegment } from "./pathGeometry";
import type { AffineMatrix } from "../svgTransform";
import type { Point, Rect } from "./types";

/**
 * Modelo de nodos Bézier (M3-S05, ADR D1/D2): lógica PURA (sin React ni Konva) para editar un `d` como una lista de subpaths con nodos
 * (anchor + handles). Es la base de la herramienta Path y de lo que vengan después (S08+ operan sobre geometría, no sobre nodos).
 *
 * Decisiones de dominio:
 * - **Derivado de `parsePathData`**: el parser ya normaliza H/V/S/Q/T/A a M/L/C/Z ABSOLUTOS, así que el modelo solo conoce cúbicas y rectas.
 *   Un `d` que el parser no puede leer COMPLETO (`error` != null) se rechaza: reserializarlo perdería la cola.
 * - **Handles absolutos en el espacio LOCAL del `d`** (el de `EditorObject.d`; la `matrix` del objeto no se toca ni se hornea). `null` = sin
 *   handle = segmento recto de ese lado. Un segmento `C` del `d` SIEMPRE trae handles en sus dos extremos (aunque midan 0): así
 *   `d -> modelo -> d` es estructuralmente idempotente y una cúbica degenerada no se convierte en recta sin que nadie lo pida.
 * - **Subpaths cerrados**: el último nodo que repite el anchor del primero (`... C ... x0 y0 Z`) se FUSIONA con el primero (su `handleIn`
 *   pasa al primero): evita dos nodos apilados. Al serializar, un cierre curvo vuelve a emitirse como `C ... Z`.
 * - **Formato numérico**: hasta 6 decimales sin ceros sobrantes (el de `segmentsToPathData`). Idempotente: un valor ya redondeado a 6
 *   decimales se re-parsea y re-serializa idéntico, así que `modelo -> d -> modelo -> d` no deriva por más ediciones que se encadenen.
 * - **`kind`**: se INFIERE de la geometría (collineal e igual largo => symmetric; collineal => smooth; si no => corner) y se conserva
 *   mientras se edita. Una "pista" opcional (`kindsHint`, ver `KindMemory`) permite recordar una etiqueta que la geometría no distingue
 *   (un nodo corner con handles collineales); la pista solo vale si la geometría la admite.
 * - **Operaciones inmutables**: cada una devuelve un `PathModel` NUEVO (comparten los nodos que no cambian), el MISMO modelo si no hubo
 *   cambio, o un error de validación en español SIN modificar nada.
 */

export type NodeKind = "corner" | "smooth" | "symmetric";
export type HandleSide = "in" | "out";

export interface PathNode {
  anchor: Point;
  /** Control de la curva que LLEGA al anchor (absoluto), o `null` si ese segmento es recto / no existe. */
  handleIn: Point | null;
  /** Control de la curva que SALE del anchor (absoluto), o `null`. */
  handleOut: Point | null;
  kind: NodeKind;
}

export interface Subpath {
  closed: boolean;
  nodes: PathNode[];
}

export interface PathModel {
  subpaths: Subpath[];
}

/** Referencia a un nodo por posición (subpath, nodo). Vale solo para el modelo del que salió. */
export interface NodeRef {
  subpath: number;
  node: number;
}

export interface HandleRef extends NodeRef {
  side: HandleSide;
}

export interface SegmentRef {
  subpath: number;
  /** El segmento `i` une el nodo `i` con el `(i + 1) % n` (en un subpath cerrado el último es el de cierre). */
  segment: number;
}

/** Subpaths que la eliminación pide confirmar (quedarían degenerados). */
export interface DeleteConfirmation {
  subpaths: number[];
  message: string;
}

export type ModelResult =
  | {
      ok: true;
      model: PathModel;
      /** Selección sugerida tras la operación (referencias del modelo NUEVO); ausente = la selección no cambia. */
      selection?: NodeRef[];
    }
  | { ok: false; error: string; confirm?: DeleteConfirmation };

export type PathModelResult = { ok: true; model: PathModel } | { ok: false; error: string };

/** Magnitud máxima de una coordenada (unidades locales): el mismo tope de sanidad que el Inspector y Draw. */
export const MAX_NODE_COORDINATE = 1_000_000;
/** Distancia mínima (unidades locales) para considerar dos puntos distintos. */
const EPSILON = 1e-9;
/** Seno máximo del ángulo entre dos handles para llamarlos collineales (~0,057°). */
const KIND_ANGLE_TOLERANCE = 1e-3;
/** Diferencia relativa máxima de largo entre dos handles para llamarlos simétricos. */
const KIND_LENGTH_TOLERANCE = 1e-3;
/** Parámetro mínimo desde un extremo para partir un segmento (más cerca crearía un nodo apilado sobre el vecino). */
export const MIN_SPLIT_T = 1e-6;

// ---- Álgebra de puntos ----

const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const scaleBy = (a: Point, factor: number): Point => ({ x: a.x * factor, y: a.y * factor });
const length = (a: Point): number => Math.hypot(a.x, a.y);
const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const isFinitePoint = (p: Point): boolean => Number.isFinite(p.x) && Number.isFinite(p.y);
const samePoint = (a: Point, b: Point): boolean => Math.abs(a.x - b.x) <= EPSILON && Math.abs(a.y - b.y) <= EPSILON;
const sameOptionalPoint = (a: Point | null, b: Point | null): boolean => (a === null || b === null ? a === b : a.x === b.x && a.y === b.y);

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

// ---- Claves de nodo (selección) ----

export function nodeKey(ref: NodeRef): string {
  return `${ref.subpath}:${ref.node}`;
}

export function parseNodeKey(key: string): NodeRef | null {
  const match = /^(\d+):(\d+)$/.exec(key);
  return match ? { subpath: Number(match[1]), node: Number(match[2]) } : null;
}

export function handleKey(ref: HandleRef): string {
  return `${nodeKey(ref)}:${ref.side}`;
}

// ---- Estructura ----

export function hasSegmentIn(subpath: Subpath, index: number): boolean {
  return subpath.closed ? subpath.nodes.length >= 2 : index > 0;
}

export function hasSegmentOut(subpath: Subpath, index: number): boolean {
  return subpath.closed ? subpath.nodes.length >= 2 : index < subpath.nodes.length - 1;
}

/** Cantidad de segmentos del subpath: un cerrado de `n >= 2` nodos tiene `n` (incluye el de cierre), uno abierto `n - 1`. */
export function segmentCount(subpath: Subpath): number {
  const count = subpath.nodes.length;
  if (subpath.closed) return count >= 2 ? count : 0;
  return Math.max(0, count - 1);
}

export function nodeCount(model: PathModel): number {
  return model.subpaths.reduce((total, subpath) => total + subpath.nodes.length, 0);
}

export function locateNode(model: PathModel, ref: NodeRef): { subpath: Subpath; node: PathNode } | null {
  const subpath = model.subpaths[ref.subpath];
  const node = subpath?.nodes[ref.node];
  return subpath && node ? { subpath, node } : null;
}

/** Todas las referencias del modelo, en orden de subpath y de nodo. */
export function allNodeRefs(model: PathModel): NodeRef[] {
  const refs: NodeRef[] = [];
  model.subpaths.forEach((subpath, subpathIndex) => subpath.nodes.forEach((_, node) => refs.push({ subpath: subpathIndex, node })));
  return refs;
}

/** Firma de la estructura (cantidad de nodos y cierre de cada subpath): una selección por índices solo vale mientras no cambie. */
export function modelSignature(model: PathModel): string {
  return model.subpaths.map((subpath) => `${subpath.nodes.length}${subpath.closed ? "c" : "o"}`).join(",");
}

export function segmentEnds(subpath: Subpath, segment: number): [PathNode, PathNode] | null {
  if (!Number.isInteger(segment) || segment < 0 || segment >= segmentCount(subpath)) return null;
  return [subpath.nodes[segment], subpath.nodes[(segment + 1) % subpath.nodes.length]];
}

/** ¿El segmento tiene algún handle (se serializa como `C`)? */
export function isSegmentCurved(subpath: Subpath, segment: number): boolean {
  const ends = segmentEnds(subpath, segment);
  return ends !== null && (ends[0].handleOut !== null || ends[1].handleIn !== null);
}

// ---- Tipo de nodo ----

/** Tipo de un nodo según su geometría. Un nodo con menos de dos handles, o con un handle de largo 0, es siempre `corner`. */
export function inferKind(node: Pick<PathNode, "anchor" | "handleIn" | "handleOut">): NodeKind {
  if (!node.handleIn || !node.handleOut) return "corner";
  const incoming = sub(node.anchor, node.handleIn);
  const outgoing = sub(node.handleOut, node.anchor);
  const incomingLength = length(incoming);
  const outgoingLength = length(outgoing);
  if (incomingLength < EPSILON || outgoingLength < EPSILON) return "corner";
  const cross = incoming.x * outgoing.y - incoming.y * outgoing.x;
  const dot = incoming.x * outgoing.x + incoming.y * outgoing.y;
  // `dot <= 0`: el handle de salida vuelve sobre el de llegada (pico), no es una tangente continua.
  if (dot <= 0 || Math.abs(cross) > KIND_ANGLE_TOLERANCE * incomingLength * outgoingLength) return "corner";
  return Math.abs(incomingLength - outgoingLength) <= KIND_LENGTH_TOLERANCE * Math.max(incomingLength, outgoingLength) ? "symmetric" : "smooth";
}

const KIND_RANK: Record<NodeKind, number> = { corner: 0, smooth: 1, symmetric: 2 };

/** Etiqueta efectiva: la pista del usuario si la geometría la admite (corner siempre; smooth si es al menos collineal; symmetric solo si lo es), si no la inferida. */
function effectiveKind(node: Pick<PathNode, "anchor" | "handleIn" | "handleOut">, hint: NodeKind | undefined): NodeKind {
  const inferred = inferKind(node);
  if (hint === undefined || hint === inferred) return inferred;
  if (hint === "corner") return "corner";
  return KIND_RANK[hint] <= KIND_RANK[inferred] ? hint : inferred;
}

/** Baja la etiqueta de un nodo a lo que su geometría todavía admite (un handle quitado o movido deja de ser smooth/symmetric). */
function clampKind(node: PathNode): PathNode {
  const inferred = inferKind(node);
  return KIND_RANK[node.kind] <= KIND_RANK[inferred] ? node : { ...node, kind: inferred };
}

// ---- d <-> modelo ----

function freshNode(anchor: Point): PathNode {
  return { anchor, handleIn: null, handleOut: null, kind: "corner" };
}

/**
 * Parsea un `d` a modelo de nodos. `kindsHint[subpath][nodo]` (de `kindsOf` de una edición anterior) fija las etiquetas que la geometría
 * no distingue; si su forma no coincide con la del path se ignora entera. Nunca lanza.
 */
export function pathToModel(d: string, kindsHint?: readonly (readonly NodeKind[])[]): PathModelResult {
  const parsed = parsePathDataCached(d);
  if (parsed.error !== null) return fail(`El path no se puede leer completo (${parsed.error}): editar sus nodos lo dañaría.`);
  if (parsed.segments.length === 0) return fail("El path está vacío: no tiene nodos para editar.");

  const subpaths: Subpath[] = [];
  let current: Subpath | null = null;
  for (const segment of parsed.segments) {
    switch (segment.type) {
      case "M":
        if (current) subpaths.push(current);
        current = { closed: false, nodes: [freshNode({ x: segment.x, y: segment.y })] };
        break;
      case "L":
        if (!current) return fail("El path no empieza con un moveto: no se puede editar.");
        current.nodes.push(freshNode({ x: segment.x, y: segment.y }));
        break;
      case "C": {
        if (!current) return fail("El path no empieza con un moveto: no se puede editar.");
        const previous = current.nodes[current.nodes.length - 1];
        previous.handleOut = { x: segment.x1, y: segment.y1 };
        current.nodes.push({ anchor: { x: segment.x, y: segment.y }, handleIn: { x: segment.x2, y: segment.y2 }, handleOut: null, kind: "corner" });
        break;
      }
      case "Z":
        if (current) {
          current.closed = true;
          subpaths.push(current);
          current = null;
        }
        break;
    }
  }
  if (current) subpaths.push(current);

  for (const subpath of subpaths) {
    if (!subpath.closed || subpath.nodes.length < 3) continue;
    const first = subpath.nodes[0];
    const last = subpath.nodes[subpath.nodes.length - 1];
    if (samePoint(first.anchor, last.anchor)) {
      // El nodo de cierre repite el anchor inicial: es el MISMO nodo (su handleIn es el que cierra la curva).
      first.handleIn = last.handleIn;
      subpath.nodes.pop();
    }
  }

  const hint = kindsHint !== undefined && kindsHint.length === subpaths.length && subpaths.every((subpath, index) => kindsHint[index].length === subpath.nodes.length) ? kindsHint : undefined;
  subpaths.forEach((subpath, subpathIndex) => {
    subpath.nodes.forEach((node, index) => {
      node.kind = effectiveKind(node, hint?.[subpathIndex]?.[index]);
    });
  });
  return { ok: true, model: { subpaths } };
}

function segmentBetween(from: PathNode, to: PathNode): PathSegment {
  if (from.handleOut === null && to.handleIn === null) return { type: "L", x: to.anchor.x, y: to.anchor.y };
  const control1 = from.handleOut ?? from.anchor;
  const control2 = to.handleIn ?? to.anchor;
  return { type: "C", x1: control1.x, y1: control1.y, x2: control2.x, y2: control2.y, x: to.anchor.x, y: to.anchor.y };
}

/** Segmentos M/L/C/Z del modelo: subpaths en orden, cada cerrado termina en `Z` (con una `C` previa solo si su cierre es curvo). */
export function modelToSegments(model: PathModel): PathSegment[] {
  const segments: PathSegment[] = [];
  for (const subpath of model.subpaths) {
    const { nodes } = subpath;
    if (nodes.length === 0) continue;
    segments.push({ type: "M", x: nodes[0].anchor.x, y: nodes[0].anchor.y });
    for (let index = 1; index < nodes.length; index += 1) segments.push(segmentBetween(nodes[index - 1], nodes[index]));
    if (subpath.closed) {
      if (nodes.length >= 2) {
        const closing = segmentBetween(nodes[nodes.length - 1], nodes[0]);
        if (closing.type === "C") segments.push(closing);
      }
      segments.push({ type: "Z" });
    }
  }
  return segments;
}

/** `d` del modelo (absoluto, M/L/C/Z, hasta 6 decimales sin ceros sobrantes). */
export function modelToPath(model: PathModel): string {
  return segmentsToPathData(modelToSegments(model));
}

export function kindsOf(model: PathModel): NodeKind[][] {
  return model.subpaths.map((subpath) => subpath.nodes.map((node) => node.kind));
}

export function modelBounds(model: PathModel): Rect | null {
  return segmentsBounds(modelToSegments(model));
}

// ---- Memoria de tipos de nodo ----

/** Máximo de `d` recordados por sesión de edición (los más viejos se descartan). */
const KIND_MEMORY_LIMIT = 300;

/**
 * Recuerda las etiquetas de nodo de los `d` que la propia herramienta produjo, para que una etiqueta que la geometría no distingue (un
 * corner con handles collineales, tras "alternar corner/smooth") sobreviva al re-parseo de cada comando y al deshacer/rehacer. `live` es el
 * último resultado, aún sin confirmar (la previsualización de un arrastre).
 */
export interface KindMemory {
  saved: Map<string, NodeKind[][]>;
  live: { d: string; kinds: NodeKind[][] } | null;
}

export function createKindMemory(): KindMemory {
  return { saved: new Map(), live: null };
}

export function kindsHintFor(memory: KindMemory, d: string): NodeKind[][] | undefined {
  if (memory.live && memory.live.d === d) return memory.live.kinds;
  return memory.saved.get(d);
}

export function rememberKinds(memory: KindMemory, d: string, kinds: NodeKind[][]): void {
  memory.saved.delete(d);
  memory.saved.set(d, kinds);
  while (memory.saved.size > KIND_MEMORY_LIMIT) {
    const oldest = memory.saved.keys().next();
    if (oldest.done) break;
    memory.saved.delete(oldest.value);
  }
}

// ---- Validación ----

function allPointsValid(model: PathModel): boolean {
  const ok = (p: Point | null) => p === null || (Number.isFinite(p.x) && Number.isFinite(p.y) && Math.abs(p.x) <= MAX_NODE_COORDINATE && Math.abs(p.y) <= MAX_NODE_COORDINATE);
  return model.subpaths.every((subpath) => subpath.nodes.every((node) => ok(node.anchor) && ok(node.handleIn) && ok(node.handleOut)));
}

function isDegenerateRect(rect: Rect | null): boolean {
  return rect === null || rect.width < EPSILON || rect.height < EPSILON;
}

/**
 * Valida el resultado de una operación: sin NaN/Infinity, dentro de límites y con un bbox que no colapsa (ancho o alto ~0) salvo que
 * el original ya lo fuera (una línea recta es un path válido). `null` = válido.
 */
export function validateModel(next: PathModel, previous: PathModel | null): string | null {
  if (!allPointsValid(next)) return `Alguna coordenada no es finita o supera el límite de ±${MAX_NODE_COORDINATE.toLocaleString("es-AR")}. No se aplicó ningún cambio.`;
  if (isDegenerateRect(modelBounds(next)) && (previous === null || !isDegenerateRect(modelBounds(previous)))) {
    return "El cambio colapsaría el path a una línea o a un punto. No se aplicó ningún cambio.";
  }
  return null;
}

function finish(previous: PathModel, next: PathModel, selection?: NodeRef[]): ModelResult {
  const invalid = validateModel(next, previous);
  if (invalid) return fail(invalid);
  return selection ? { ok: true, model: next, selection } : { ok: true, model: next };
}

// ---- Reemplazo de nodos ----

function resolveRefs(model: PathModel, refs: readonly NodeRef[]): { ok: true; refs: NodeRef[] } | { ok: false; error: string } {
  const seen = new Set<string>();
  const unique: NodeRef[] = [];
  for (const ref of refs) {
    if (!locateNode(model, ref)) return fail("Alguno de los nodos seleccionados ya no existe. No se aplicó ningún cambio.");
    const key = nodeKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(ref);
  }
  if (unique.length === 0) return fail("No hay nodos seleccionados.");
  return { ok: true, refs: unique };
}

function updateNodes(model: PathModel, updates: ReadonlyMap<string, PathNode>): PathModel {
  const bySubpath = new Map<number, Map<number, PathNode>>();
  for (const [key, node] of updates) {
    const ref = parseNodeKey(key);
    if (!ref) continue;
    const changes = bySubpath.get(ref.subpath) ?? new Map<number, PathNode>();
    changes.set(ref.node, node);
    bySubpath.set(ref.subpath, changes);
  }
  return {
    subpaths: model.subpaths.map((subpath, subpathIndex) => {
      const changes = bySubpath.get(subpathIndex);
      return changes ? { closed: subpath.closed, nodes: subpath.nodes.map((node, index) => changes.get(index) ?? node) } : subpath;
    }),
  };
}

function translateNode(node: PathNode, delta: Point): PathNode {
  return {
    anchor: add(node.anchor, delta),
    handleIn: node.handleIn && add(node.handleIn, delta),
    handleOut: node.handleOut && add(node.handleOut, delta),
    kind: node.kind,
  };
}

// ---- Mover ----

/** Mueve los anchors `refs` en `delta` (espacio local); sus handles viajan con ellos. Delta (0, 0) => el MISMO modelo. */
export function moveAnchors(model: PathModel, refs: readonly NodeRef[], delta: Point): ModelResult {
  if (!isFinitePoint(delta)) return fail("El desplazamiento no es un número válido. No se movió nada.");
  const resolved = resolveRefs(model, refs);
  if (!resolved.ok) return resolved;
  if (delta.x === 0 && delta.y === 0) return { ok: true, model };
  const updates = new Map<string, PathNode>();
  for (const ref of resolved.refs) updates.set(nodeKey(ref), translateNode(locateNode(model, ref)!.node, delta));
  return finish(model, updateNodes(model, updates));
}

/** Lleva cada anchor a un punto absoluto (Inspector numérico); sus handles conservan su posición relativa. */
export function setAnchors(model: PathModel, entries: ReadonlyArray<{ ref: NodeRef; point: Point }>): ModelResult {
  const resolved = resolveRefs(model, entries.map((entry) => entry.ref));
  if (!resolved.ok) return resolved;
  if (entries.some((entry) => !isFinitePoint(entry.point))) return fail("La posición no es un número válido. No se movió nada.");
  const updates = new Map<string, PathNode>();
  let changed = false;
  for (const { ref, point } of entries) {
    const { node } = locateNode(model, ref)!;
    const delta = sub(point, node.anchor);
    if (delta.x === 0 && delta.y === 0) continue;
    changed = true;
    updates.set(nodeKey(ref), { ...translateNode(node, delta), anchor: point });
  }
  return changed ? finish(model, updateNodes(model, updates)) : { ok: true, model };
}

export function setAnchor(model: PathModel, ref: NodeRef, point: Point): ModelResult {
  return setAnchors(model, [{ ref, point }]);
}

export interface MoveHandleOptions {
  /** Alt en la UI: rompe el nodo a `corner` (el handle opuesto no acompaña) y lo deja así. */
  breakKind?: boolean;
}

/** Handle opuesto que corresponde a mover un handle hasta `moved`: simétrico (espejo exacto) o suave (alineado, conserva su largo). `null` = no cambia. */
function oppositeHandle(anchor: Point, moved: Point, opposite: Point, kind: "smooth" | "symmetric"): Point | null {
  if (kind === "symmetric") return { x: 2 * anchor.x - moved.x, y: 2 * anchor.y - moved.y };
  const vector = sub(moved, anchor);
  const vectorLength = length(vector);
  if (vectorLength < EPSILON) return null;
  return sub(anchor, scaleBy(vector, length(sub(opposite, anchor)) / vectorLength));
}

/**
 * Mueve un handle a `to` (absoluto, espacio local) según el tipo del nodo: corner = independiente; smooth = el opuesto se alinea y
 * CONSERVA su largo; symmetric = el opuesto es el espejo exacto. Con `breakKind` el nodo pasa a corner. Un extremo de path abierto no
 * tiene handle del lado sin segmento.
 */
export function moveHandle(model: PathModel, ref: NodeRef, side: HandleSide, to: Point, options: MoveHandleOptions = {}): ModelResult {
  if (!isFinitePoint(to)) return fail("La posición del handle no es un número válido. No se movió nada.");
  const located = locateNode(model, ref);
  if (!located) return fail("El nodo ya no existe. No se aplicó ningún cambio.");
  const { subpath, node } = located;
  if (!(side === "in" ? hasSegmentIn(subpath, ref.node) : hasSegmentOut(subpath, ref.node))) {
    return fail("Ese nodo es un extremo del path: no tiene handle de ese lado.");
  }

  const kind: NodeKind = options.breakKind ? "corner" : node.kind;
  let next: PathNode = side === "in" ? { ...node, handleIn: to, kind } : { ...node, handleOut: to, kind };
  if (kind !== "corner") {
    const opposite = side === "in" ? node.handleOut : node.handleIn;
    const mirrored = opposite ? oppositeHandle(node.anchor, to, opposite, kind) : null;
    if (mirrored) next = side === "in" ? { ...next, handleOut: mirrored } : { ...next, handleIn: mirrored };
  }
  if (sameOptionalPoint(next.handleIn, node.handleIn) && sameOptionalPoint(next.handleOut, node.handleOut) && next.kind === node.kind) return { ok: true, model };
  return finish(model, updateNodes(model, new Map([[nodeKey(ref), next]])));
}

/**
 * Handle por longitud y ángulo (Inspector numérico). `angleDegrees` = `atan2(dy, dx)` (0° = +x, 90° = hacia abajo en pantalla, eje Y hacia
 * abajo como SVG). Con `matrix`, longitud y ángulo se miden en el espacio transformado (documento) -- el que el usuario ve --; sin ella,
 * en el local. La regla del tipo de nodo es la de `moveHandle`.
 */
export function setHandleVector(model: PathModel, ref: NodeRef, side: HandleSide, handleLength: number, angleDegrees: number, matrix?: AffineMatrix): ModelResult {
  if (!Number.isFinite(handleLength) || handleLength < 0 || !Number.isFinite(angleDegrees)) return fail("El largo o el ángulo del handle no son válidos. No se aplicó ningún cambio.");
  const located = locateNode(model, ref);
  if (!located) return fail("El nodo ya no existe. No se aplicó ningún cambio.");
  const space: AffineMatrix = matrix ?? { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const inverse = invertMatrix(space);
  if (!inverse) return fail("La transformación del objeto no es invertible: no se puede editar el handle.");
  const anchorInSpace = applyMatrixToPoint(space, located.node.anchor);
  const radians = (angleDegrees * Math.PI) / 180;
  const target = { x: anchorInSpace.x + handleLength * Math.cos(radians), y: anchorInSpace.y + handleLength * Math.sin(radians) };
  return moveHandle(model, ref, side, applyMatrixToPoint(inverse, target));
}

// ---- Curvas ----

export interface SegmentCurve {
  p0: Point;
  p1: Point;
  p2: Point;
  p3: Point;
  /** Falso = recta (los controles no se usan). */
  curved: boolean;
}

export function segmentCurve(subpath: Subpath, segment: number): SegmentCurve | null {
  const ends = segmentEnds(subpath, segment);
  if (!ends) return null;
  const [from, to] = ends;
  return { p0: from.anchor, p1: from.handleOut ?? from.anchor, p2: to.handleIn ?? to.anchor, p3: to.anchor, curved: from.handleOut !== null || to.handleIn !== null };
}

export function pointOnCurve(curve: SegmentCurve, t: number): Point {
  if (!curve.curved) return lerp(curve.p0, curve.p3, t);
  const mt = 1 - t;
  const w0 = mt * mt * mt;
  const w1 = 3 * mt * mt * t;
  const w2 = 3 * mt * t * t;
  const w3 = t * t * t;
  return { x: w0 * curve.p0.x + w1 * curve.p1.x + w2 * curve.p2.x + w3 * curve.p3.x, y: w0 * curve.p0.y + w1 * curve.p1.y + w2 * curve.p2.y + w3 * curve.p3.y };
}

/** Subdivisión de De Casteljau de una cúbica en `t`: `q*` y `r*` son las capas intermedias, `s` el punto de la curva. */
export function splitCubic(p0: Point, p1: Point, p2: Point, p3: Point, t: number) {
  const q0 = lerp(p0, p1, t);
  const q1 = lerp(p1, p2, t);
  const q2 = lerp(p2, p3, t);
  const r0 = lerp(q0, q1, t);
  const r1 = lerp(q1, q2, t);
  const s = lerp(r0, r1, t);
  return { q0, q1, q2, r0, r1, s };
}

/** Caja que contiene al segmento (la de sus puntos de control: una Bézier queda dentro de su envolvente convexa). */
export function curveBox(curve: SegmentCurve): Rect {
  const points = curve.curved ? [curve.p0, curve.p1, curve.p2, curve.p3] : [curve.p0, curve.p3];
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

const CLOSEST_SAMPLES = 24;
const CLOSEST_REFINEMENTS = 60;

/** Punto del segmento más cercano a `point`: muestreo grueso + búsqueda ternaria (el parámetro `t` es el de la curva, invariante bajo transformaciones afines). */
export function closestPointOnSegment(curve: SegmentCurve, point: Point): { t: number; point: Point; distance: number } {
  if (!curve.curved) {
    const direction = sub(curve.p3, curve.p0);
    const lengthSquared = direction.x * direction.x + direction.y * direction.y;
    const raw = lengthSquared === 0 ? 0 : ((point.x - curve.p0.x) * direction.x + (point.y - curve.p0.y) * direction.y) / lengthSquared;
    const t = Math.max(0, Math.min(1, raw));
    const nearest = lerp(curve.p0, curve.p3, t);
    return { t, point: nearest, distance: distance(nearest, point) };
  }
  const squaredAt = (t: number) => {
    const p = pointOnCurve(curve, t);
    return (p.x - point.x) ** 2 + (p.y - point.y) ** 2;
  };
  let bestT = 0;
  let bestSquared = Infinity;
  for (let index = 0; index <= CLOSEST_SAMPLES; index += 1) {
    const t = index / CLOSEST_SAMPLES;
    const squared = squaredAt(t);
    if (squared < bestSquared) {
      bestSquared = squared;
      bestT = t;
    }
  }
  let low = Math.max(0, bestT - 1 / CLOSEST_SAMPLES);
  let high = Math.min(1, bestT + 1 / CLOSEST_SAMPLES);
  for (let step = 0; step < CLOSEST_REFINEMENTS; step += 1) {
    const third = (high - low) / 3;
    if (squaredAt(low + third) < squaredAt(high - third)) high -= third;
    else low += third;
  }
  const refined = (low + high) / 2;
  const t = squaredAt(refined) <= bestSquared ? refined : bestT;
  const nearest = pointOnCurve(curve, t);
  return { t, point: nearest, distance: distance(nearest, point) };
}

// ---- Agregar nodo ----

/** Tras tocar los handles de un nodo, una etiqueta symmetric deja de serlo (los largos cambiaron) pero sigue siendo suave si lo era. */
function demoteSymmetric(node: PathNode): PathNode {
  return node.kind === "symmetric" ? { ...node, kind: "smooth" } : node;
}

/**
 * Agrega un nodo sobre el segmento `segment` del subpath en el parámetro `t` (0 < t < 1) por **De Casteljau exacto**: la forma NO cambia.
 * En un segmento recto el nodo nuevo no lleva handles; en uno curvo parte la cúbica en dos y reparte los controles. El nodo nuevo queda
 * seleccionado (índice `segment + 1`).
 */
export function addNodeOnSegment(model: PathModel, subpathIndex: number, segment: number, t: number): ModelResult {
  const subpath = model.subpaths[subpathIndex];
  const ends = subpath ? segmentEnds(subpath, segment) : null;
  if (!subpath || !ends) return fail("Ese segmento ya no existe. No se agregó ningún nodo.");
  if (!Number.isFinite(t) || t <= MIN_SPLIT_T || t >= 1 - MIN_SPLIT_T) return fail("El punto está demasiado cerca de un nodo existente para agregar otro. No se agregó ningún nodo.");

  const [from, to] = ends;
  const nodes = [...subpath.nodes];
  const nextIndex = (segment + 1) % nodes.length;
  let inserted: PathNode;
  if (from.handleOut === null && to.handleIn === null) {
    inserted = { anchor: lerp(from.anchor, to.anchor, t), handleIn: null, handleOut: null, kind: "corner" };
  } else {
    const split = splitCubic(from.anchor, from.handleOut ?? from.anchor, to.handleIn ?? to.anchor, to.anchor, t);
    nodes[segment] = demoteSymmetric({ ...from, handleOut: split.q0 });
    nodes[nextIndex] = demoteSymmetric({ ...to, handleIn: split.q2 });
    inserted = { anchor: split.s, handleIn: split.r0, handleOut: split.r1, kind: "corner" };
    inserted.kind = inferKind(inserted);
  }
  nodes.splice(segment + 1, 0, inserted);

  const subpaths = model.subpaths.map((candidate, index) => (index === subpathIndex ? { closed: candidate.closed, nodes } : candidate));
  return finish(model, { subpaths }, [{ subpath: subpathIndex, node: segment + 1 }]);
}

// ---- Eliminar nodos ----

export interface DeleteOptions {
  /** El usuario confirmó eliminar los subpaths que quedarían degenerados. */
  removeSubpaths?: boolean;
}

/**
 * Elimina los nodos `refs`: los vecinos se unen conservando sus handles (el segmento nuevo usa el `handleOut` del anterior y el `handleIn`
 * del siguiente: la forma SÍ cambia). **Eliminación mínima**: nunca deja un subpath abierto con < 2 nodos ni uno cerrado con < 3; en ese caso
 * hay que pedir confirmación (`removeSubpaths`) y se elimina el subpath COMPLETO. Si esos subpaths son todos los del objeto, se rechaza.
 */
export function deleteNodes(model: PathModel, refs: readonly NodeRef[], options: DeleteOptions = {}): ModelResult {
  const resolved = resolveRefs(model, refs);
  if (!resolved.ok) return resolved;
  const doomed = new Map<number, Set<number>>();
  for (const ref of resolved.refs) {
    const set = doomed.get(ref.subpath) ?? new Set<number>();
    set.add(ref.node);
    doomed.set(ref.subpath, set);
  }

  const degenerate: number[] = [];
  for (const [subpathIndex, indexes] of doomed) {
    const subpath = model.subpaths[subpathIndex];
    const remaining = subpath.nodes.length - indexes.size;
    if (remaining < (subpath.closed ? 3 : 2)) degenerate.push(subpathIndex);
  }
  degenerate.sort((a, b) => a - b);

  if (degenerate.length > 0) {
    if (model.subpaths.length - degenerate.length === 0) {
      return fail("No se pueden eliminar esos nodos: el objeto se quedaría sin geometría. Para quitar el objeto usá Suprimir con el objeto seleccionado o Erase.");
    }
    if (!options.removeSubpaths) {
      const names = degenerate.map((index) => `${index + 1}`).join(", ");
      return {
        ok: false,
        error: `Eliminar esos nodos dejaría ${degenerate.length === 1 ? `el subpath ${names}` : `los subpaths ${names}`} con menos de ${degenerate.some((index) => model.subpaths[index].closed) ? "3 nodos (cerrado) o 2 (abierto)" : "2 nodos"}: hay que eliminar ${degenerate.length === 1 ? "el subpath completo" : "los subpaths completos"}. Confirmalo para continuar.`,
        confirm: { subpaths: degenerate, message: `Se eliminará ${degenerate.length === 1 ? `el subpath ${names}` : `los subpaths ${names}`} completo${degenerate.length === 1 ? "" : "s"}.` },
      };
    }
  }

  const subpaths: Subpath[] = [];
  model.subpaths.forEach((subpath, subpathIndex) => {
    if (degenerate.includes(subpathIndex)) return;
    const indexes = doomed.get(subpathIndex);
    if (!indexes) {
      subpaths.push(subpath);
      return;
    }
    const nodes = subpath.nodes.filter((_, index) => !indexes.has(index));
    if (!subpath.closed) {
      // Un extremo abierto no tiene segmento hacia afuera: el handle que miraba al nodo eliminado deja de tener sentido.
      nodes[0] = clampKind({ ...nodes[0], handleIn: null });
      nodes[nodes.length - 1] = clampKind({ ...nodes[nodes.length - 1], handleOut: null });
    }
    subpaths.push({ closed: subpath.closed, nodes });
  });
  return finish(model, { subpaths }, []);
}

// ---- Tipo de nodo / segmento ----

/** Re-alinea los handles de un nodo para que sea smooth o symmetric. El handle de salida manda; sin handles se genera la tangente con 1/3 de la distancia a los vecinos. */
function alignNode(subpath: Subpath, index: number, kind: "smooth" | "symmetric"): PathNode {
  const { nodes } = subpath;
  const node = nodes[index];
  const hasIn = hasSegmentIn(subpath, index);
  const hasOut = hasSegmentOut(subpath, index);
  const anchor = node.anchor;
  const outgoing = node.handleOut && hasOut ? sub(node.handleOut, anchor) : null;
  const incoming = node.handleIn && hasIn ? sub(anchor, node.handleIn) : null;
  const outgoingLength = outgoing ? length(outgoing) : 0;
  const incomingLength = incoming ? length(incoming) : 0;

  if (outgoing && outgoingLength > EPSILON && node.handleOut) {
    const direction = scaleBy(outgoing, 1 / outgoingLength);
    if (kind === "symmetric") return { ...node, handleIn: hasIn ? { x: 2 * anchor.x - node.handleOut.x, y: 2 * anchor.y - node.handleOut.y } : node.handleIn, kind };
    const size = incomingLength > EPSILON ? incomingLength : outgoingLength;
    return { ...node, handleIn: hasIn ? sub(anchor, scaleBy(direction, size)) : node.handleIn, kind };
  }
  if (incoming && incomingLength > EPSILON && node.handleIn) {
    const direction = scaleBy(incoming, 1 / incomingLength);
    if (kind === "symmetric") return { ...node, handleOut: hasOut ? { x: 2 * anchor.x - node.handleIn.x, y: 2 * anchor.y - node.handleIn.y } : node.handleOut, kind };
    return { ...node, handleOut: hasOut ? add(anchor, scaleBy(direction, incomingLength)) : node.handleOut, kind };
  }

  // Sin handles útiles: tangente por los vecinos (los extremos abiertos usan solo el vecino que tienen).
  const previous = hasIn ? nodes[(index - 1 + nodes.length) % nodes.length].anchor : null;
  const following = hasOut ? nodes[(index + 1) % nodes.length].anchor : null;
  const span = sub(following ?? anchor, previous ?? anchor);
  const spanLength = length(span);
  if (spanLength < EPSILON) return { ...node, kind };
  const direction = scaleBy(span, 1 / spanLength);
  let outSize = following ? distance(anchor, following) / 3 : 0;
  let inSize = previous ? distance(anchor, previous) / 3 : 0;
  if (kind === "symmetric" && following && previous) {
    outSize = Math.min(outSize, inSize);
    inSize = outSize;
  }
  return {
    ...node,
    handleOut: following ? add(anchor, scaleBy(direction, outSize)) : null,
    handleIn: previous ? sub(anchor, scaleBy(direction, inSize)) : null,
    kind,
  };
}

/**
 * Cambia el tipo de los nodos `refs`. `corner` solo cambia la etiqueta (los handles no se tocan, y desde ahí mover uno no arrastra al
 * otro); `smooth`/`symmetric` ALINEAN los handles (generándolos con 1/3 de la distancia a los vecinos si el nodo no tenía).
 */
export function setNodeKind(model: PathModel, refs: readonly NodeRef[], kind: NodeKind): ModelResult {
  const resolved = resolveRefs(model, refs);
  if (!resolved.ok) return resolved;
  const updates = new Map<string, PathNode>();
  for (const ref of resolved.refs) {
    const { subpath, node } = locateNode(model, ref)!;
    const next = kind === "corner" ? { ...node, kind } : alignNode(subpath, ref.node, kind);
    if (next.kind !== node.kind || !sameOptionalPoint(next.handleIn, node.handleIn) || !sameOptionalPoint(next.handleOut, node.handleOut)) updates.set(nodeKey(ref), next);
  }
  return updates.size === 0 ? { ok: true, model } : finish(model, updateNodes(model, updates));
}

/** Alt+click: corner <-> smooth. Un nodo suave (o simétrico) pasa a corner; uno corner pasa a smooth. */
export function toggleNodeKind(model: PathModel, ref: NodeRef): ModelResult {
  const located = locateNode(model, ref);
  if (!located) return fail("El nodo ya no existe. No se aplicó ningún cambio.");
  return setNodeKind(model, [ref], located.node.kind === "corner" ? "smooth" : "corner");
}

function setSegmentCurved(model: PathModel, subpathIndex: number, segment: number, curved: boolean): ModelResult {
  const subpath = model.subpaths[subpathIndex];
  const ends = subpath ? segmentEnds(subpath, segment) : null;
  if (!subpath || !ends) return fail("Ese segmento ya no existe. No se aplicó ningún cambio.");
  if (isSegmentCurved(subpath, segment) === curved) return { ok: true, model };
  const [from, to] = ends;
  const fromIndex = segment;
  const toIndex = (segment + 1) % subpath.nodes.length;
  let nextFrom: PathNode;
  let nextTo: PathNode;
  if (curved) {
    if (distance(from.anchor, to.anchor) < EPSILON) return fail("El segmento tiene largo 0: no se puede curvar.");
    const third = scaleBy(sub(to.anchor, from.anchor), 1 / 3);
    nextFrom = { ...from, handleOut: add(from.anchor, third) };
    nextTo = { ...to, handleIn: sub(to.anchor, third) };
  } else {
    nextFrom = { ...from, handleOut: null };
    nextTo = { ...to, handleIn: null };
  }
  return finish(model, updateNodes(model, new Map([[nodeKey({ subpath: subpathIndex, node: fromIndex }), clampKind(nextFrom)], [nodeKey({ subpath: subpathIndex, node: toIndex }), clampKind(nextTo)]])));
}

/** Recto <-> curvo: al curvar se generan los handles a 1/3 del segmento (la forma no cambia: una cúbica con controles a 1/3 es la recta); al enderezar se quitan. */
export function toggleSegmentKind(model: PathModel, subpathIndex: number, segment: number): ModelResult {
  const subpath = model.subpaths[subpathIndex];
  if (!subpath || !segmentEnds(subpath, segment)) return fail("Ese segmento ya no existe. No se aplicó ningún cambio.");
  return setSegmentCurved(model, subpathIndex, segment, !isSegmentCurved(subpath, segment));
}

/** Varios segmentos a la vez: si ALGUNO es recto se curvan todos; si todos son curvos se enderezan todos. */
export function toggleSegments(model: PathModel, segments: readonly SegmentRef[]): ModelResult {
  if (segments.length === 0) return fail("No hay segmentos para alternar.");
  const anyStraight = segments.some((ref) => {
    const subpath = model.subpaths[ref.subpath];
    return subpath !== undefined && segmentEnds(subpath, ref.segment) !== null && !isSegmentCurved(subpath, ref.segment);
  });
  let current = model;
  for (const ref of segments) {
    const result = setSegmentCurved(current, ref.subpath, ref.segment, anyStraight);
    if (!result.ok) return result;
    current = result.model;
  }
  return { ok: true, model: current };
}

// ---- Cerrar / abrir ----

/** ¿Se puede cerrar el subpath? (abierto y con ≥ 3 nodos distintos tras fusionar un último nodo que ya coincide con el primero). */
export function closeSubpathBlocker(model: PathModel, subpathIndex: number): string | null {
  const subpath = model.subpaths[subpathIndex];
  if (!subpath) return "Ese subpath ya no existe.";
  if (subpath.closed) return "El subpath ya está cerrado.";
  const count = subpath.nodes.length;
  const coincides = count >= 2 && samePoint(subpath.nodes[0].anchor, subpath.nodes[count - 1].anchor);
  if ((coincides ? count - 1 : count) < 3) return "Cerrar este subpath dejaría menos de 3 nodos: no formaría un contorno válido.";
  return null;
}

/** Cierra el subpath: une el último nodo con el primero (si ya coinciden se FUSIONAN). Solo si el resultado es válido (≥ 3 nodos). */
export function closeSubpath(model: PathModel, subpathIndex: number): ModelResult {
  const blocker = closeSubpathBlocker(model, subpathIndex);
  if (blocker) return fail(blocker);
  const subpath = model.subpaths[subpathIndex];
  const count = subpath.nodes.length;
  let nodes = subpath.nodes;
  if (samePoint(nodes[0].anchor, nodes[count - 1].anchor)) {
    const merged: PathNode = { ...nodes[0], handleIn: nodes[count - 1].handleIn };
    merged.kind = effectiveKind(merged, nodes[0].kind);
    nodes = [merged, ...nodes.slice(1, count - 1)];
  }
  const subpaths = model.subpaths.map((candidate, index) => (index === subpathIndex ? { closed: true, nodes } : candidate));
  return finish(model, { subpaths });
}

/** ¿Se puede abrir el subpath en ese nodo? (cerrado y con ≥ 3 nodos). */
export function openSubpathBlocker(model: PathModel, ref: NodeRef): string | null {
  const located = locateNode(model, ref);
  if (!located) return "El nodo ya no existe.";
  if (!located.subpath.closed) return "El subpath ya está abierto.";
  if (located.subpath.nodes.length < 3) return "Un contorno de menos de 3 nodos no se puede abrir.";
  return null;
}

/**
 * Abre el lazo en el nodo `ref`: el subpath pasa a abierto y empieza y termina en ese anchor (dos nodos coincidentes, como "cortar en un
 * anchor"); el relleno y el sentido de giro no cambian. Volver a cerrarlo fusiona los dos extremos.
 */
export function openSubpathAt(model: PathModel, ref: NodeRef): ModelResult {
  const blocker = openSubpathBlocker(model, ref);
  if (blocker) return fail(blocker);
  const { subpath, node } = locateNode(model, ref)!;
  const count = subpath.nodes.length;
  const rotated: PathNode[] = [];
  for (let offset = 1; offset < count; offset += 1) rotated.push(subpath.nodes[(ref.node + offset) % count]);
  const first: PathNode = { anchor: node.anchor, handleIn: null, handleOut: node.handleOut, kind: "corner" };
  const last: PathNode = { anchor: node.anchor, handleIn: node.handleIn, handleOut: null, kind: "corner" };
  const subpaths = model.subpaths.map((candidate, index) => (index === ref.subpath ? { closed: false, nodes: [first, ...rotated, last] } : candidate));
  return finish(model, { subpaths }, [
    { subpath: ref.subpath, node: 0 },
    { subpath: ref.subpath, node: count },
  ]);
}
