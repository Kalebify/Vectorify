import type { AffineMatrix } from "../svgTransform";
import { applyMatrixToPoint, invertMatrix, isFiniteMatrix } from "./matrix";
import {
  allNodeRefs,
  closestPointOnSegment,
  curveBox,
  handleKey,
  kindsHintFor,
  kindsOf,
  locateNode,
  modelToPath,
  nodeKey,
  parseNodeKey,
  pathToModel,
  segmentCount,
  segmentCurve,
  type DeleteConfirmation,
  type HandleRef,
  type KindMemory,
  type ModelResult,
  type NodeKind,
  type NodeRef,
  type PathModel,
  type SegmentCurve,
  type SegmentRef,
} from "./nodes";
import { replaceObjects } from "./selection";
import type { EditableDocument, EditorObject, EditProduction, Point, Rect } from "./types";
import { screenToleranceToDocument } from "./units";
import type { ViewportParams } from "./viewport";
import { screenToDocument } from "./viewport";

/**
 * Integración de la herramienta Path (M3-S05) con el documento editable: objetivo de edición (qué objeto y por qué se rechaza), aplicación
 * de una operación del modelo de nodos a un `EditorObject` (UN comando, solo cambia `d`), hit-testing en píxeles de pantalla y selección
 * del overlay acotada al viewport. Todo puro; `lib/editor/nodes.ts` no conoce objetos ni matrices.
 *
 * La edición ocurre en el espacio LOCAL del objeto (el de su `d`): la `matrix` ni se hornea ni se modifica; los punteros (documento) se
 * convierten con su inversa y los nodos se dibujan/hit-testean aplicándosela.
 */

// ---- Tamaños en píxeles de PANTALLA (constantes a cualquier zoom) ----

/** Lado del cuadrado de un anchor. */
export const ANCHOR_SIZE_PX = 8;
/** Radio del círculo de un handle. */
export const HANDLE_RADIUS_PX = 4;
/** Radio de hit de un anchor / de un handle / de un segmento (más generosos que lo dibujado). */
export const ANCHOR_HIT_RADIUS_PX = 9;
export const HANDLE_HIT_RADIUS_PX = 8;
export const SEGMENT_HIT_RADIUS_PX = 6;
/** Arrastre mínimo (px de pantalla) para que un click pase a ser drag: evita mover por un temblor del mouse. */
export const DRAG_THRESHOLD_PX = 3;
/** Tope de nodos dibujados a la vez: por encima el overlay se limita al viewport y avisa (un path de miles de nodos no se puede editar nodo a nodo en un solo vistazo). */
export const MAX_OVERLAY_NODES = 1500;
/** Nudge con flechas, en unidades de DOCUMENTO (igual que el de objetos de S01): 1, o 10 con Shift. */
export const NODE_NUDGE_STEP = 1;
export const NODE_NUDGE_STEP_SHIFT = 10;

export interface HitTolerances {
  anchor: number;
  handle: number;
  segment: number;
}

/** Radios de hit en unidades de DOCUMENTO para un zoom dado: `px / zoom`, así el área clickeable mide lo mismo en pantalla a cualquier zoom. */
export function pathHitTolerances(zoom: number): HitTolerances {
  return {
    anchor: screenToleranceToDocument(ANCHOR_HIT_RADIUS_PX, zoom),
    handle: screenToleranceToDocument(HANDLE_HIT_RADIUS_PX, zoom),
    segment: screenToleranceToDocument(SEGMENT_HIT_RADIUS_PX, zoom),
  };
}

// ---- Objetivo ----

export interface PathTargetLayer {
  groupId: string;
  name: string;
  locked: boolean;
  visible: boolean;
}

export type PathTarget =
  | { status: "ok"; object: EditorObject; model: PathModel }
  | { status: "none" | "multiple" | "locked" | "hidden" | "matrix" | "geometry"; message: string; object: EditorObject | null };

/**
 * ¿Se puede editar la selección en modo Path? Exactamente UN objeto, en una capa visible y desbloqueada, con matriz invertible (los
 * punteros se convierten con su inversa) y un `d` que el parser lee COMPLETO (si no, reserializarlo lo dañaría). Cada rechazo trae su mensaje.
 */
export function resolvePathTarget(selected: readonly EditorObject[], layers: readonly PathTargetLayer[], memory: KindMemory): PathTarget {
  if (selected.length === 0) return { status: "none", object: null, message: "Seleccioná un objeto para editar sus nodos: hacé click sobre un path del canvas." };
  if (selected.length > 1) {
    return { status: "multiple", object: null, message: `Seleccioná un solo objeto para editar sus nodos (hay ${selected.length} seleccionados).` };
  }
  const object = selected[0];
  const layer = layers.find((candidate) => candidate.groupId === object.layerGroupId);
  if (layer?.locked) {
    return { status: "locked", object, message: `La capa «${layer.name}» está bloqueada: no se pueden editar sus nodos. Desbloqueala en el panel de Capas.` };
  }
  if (layer && !layer.visible) {
    return { status: "hidden", object, message: `La capa «${layer.name}» está oculta: mostrala para editar sus nodos.` };
  }
  if (!isFiniteMatrix(object.matrix) || invertMatrix(object.matrix) === null) {
    return { status: "matrix", object, message: "La transformación del objeto no es invertible (escala 0): no se pueden editar sus nodos." };
  }
  const parsed = pathToModel(object.d, kindsHintFor(memory, object.d));
  if (!parsed.ok) return { status: "geometry", object, message: parsed.error };
  return { status: "ok", object, model: parsed.model };
}

// ---- Aplicar una operación al objeto ----

export type PathEditOutcome =
  | { ok: true; changed: false; object: EditorObject; kinds?: NodeKind[][]; d?: string }
  | { ok: true; changed: true; object: EditorObject; model: PathModel; kinds: NodeKind[][]; selection?: NodeRef[] }
  | { ok: false; error: string; confirm?: DeleteConfirmation };

/**
 * Corre una operación del modelo sobre el `d` del objeto. Sin cambio (modelo igual, o solo cambió una etiqueta de nodo y el `d` resulta
 * idéntico) devuelve el MISMO objeto: un objeto no editado conserva su `d` byte a byte. Con cambio, solo `d` es nuevo (id, capa, relleno,
 * trazo y matriz se conservan). El resultado queda en `memory.live` para que la previsualización y el panel conserven los tipos de nodo.
 */
export function applyModelEdit(object: EditorObject, memory: KindMemory, edit: (model: PathModel) => ModelResult): PathEditOutcome {
  const parsed = pathToModel(object.d, kindsHintFor(memory, object.d));
  if (!parsed.ok) return parsed;
  const result = edit(parsed.model);
  if (!result.ok) return result;
  if (result.model === parsed.model) return { ok: true, changed: false, object };
  const d = modelToPath(result.model);
  const kinds = kindsOf(result.model);
  memory.live = { d, kinds };
  // Solo cambió una etiqueta (p. ej. corner sobre handles collineales): la geometría es la misma, no hay nada que deshacer.
  if (d === object.d) return { ok: true, changed: false, object, kinds, d };
  return { ok: true, changed: true, object: { ...object, d }, model: result.model, kinds, selection: result.selection };
}

/** El objeto con ese id en cualquier capa del estado, o `null`. */
export function findEditorObject(state: EditableDocument, objectId: string): EditorObject | null {
  for (const objects of Object.values(state.objectsByLayer)) {
    const found = objects.find((object) => object.id === objectId);
    if (found) return found;
  }
  return null;
}

/** Producción de UN comando que reemplaza el objeto por su versión editada (o `null` si no cambia nada / la operación se rechaza). */
export function nodeEditProduction(state: EditableDocument, objectId: string, memory: KindMemory, edit: (model: PathModel) => ModelResult): EditProduction | null {
  const target = findEditorObject(state, objectId);
  if (!target) return null;
  const outcome = applyModelEdit(target, memory, edit);
  if (!outcome.ok || !outcome.changed) return null;
  return replaceObjects(state, [target], () => [outcome.object]);
}

// ---- Conversión documento <-> local ----

/** Vector de documento a local (solo la parte lineal de la inversa: un desplazamiento no lleva traslación). */
export function documentVectorToLocal(inverse: AffineMatrix, vector: Point): Point {
  return { x: inverse.a * vector.x + inverse.c * vector.y, y: inverse.b * vector.x + inverse.d * vector.y };
}

export function localToDocument(matrix: AffineMatrix, point: Point): Point {
  return applyMatrixToPoint(matrix, point);
}

// ---- Handles visibles ----

/**
 * Handles que se muestran: los de los nodos seleccionados y los de sus vecinos que dan forma a los segmentos adyacentes (como en las
 * herramientas de dibujo vectorial). Un handle de largo 0 no se muestra (queda debajo de su anchor).
 */
export function visibleHandles(model: PathModel, selected: ReadonlySet<string>): HandleRef[] {
  const handles: HandleRef[] = [];
  const seen = new Set<string>();
  const push = (ref: NodeRef, side: "in" | "out") => {
    const located = locateNode(model, ref);
    if (!located) return;
    const point = side === "in" ? located.node.handleIn : located.node.handleOut;
    if (!point || (point.x === located.node.anchor.x && point.y === located.node.anchor.y)) return;
    const handle: HandleRef = { ...ref, side };
    const key = handleKey(handle);
    if (seen.has(key)) return;
    seen.add(key);
    handles.push(handle);
  };
  for (const key of selected) {
    const ref = parseNodeKey(key);
    const located = ref ? locateNode(model, ref) : null;
    if (!ref || !located) continue;
    const count = located.subpath.nodes.length;
    push(ref, "in");
    push(ref, "out");
    if (located.subpath.closed ? count >= 2 : ref.node > 0) push({ subpath: ref.subpath, node: (ref.node - 1 + count) % count }, "out");
    if (located.subpath.closed ? count >= 2 : ref.node < count - 1) push({ subpath: ref.subpath, node: (ref.node + 1) % count }, "in");
  }
  return handles;
}

// ---- Hit-testing ----

export type PathHit =
  | { kind: "handle"; ref: NodeRef; side: "in" | "out" }
  | { kind: "anchor"; ref: NodeRef }
  | { kind: "segment"; subpath: number; segment: number; t: number; point: Point };

export interface PathHitOptions {
  handles: readonly HandleRef[];
  /** Solo estos anchors (claves `nodeKey`) son golpeables: los que el overlay realmente dibuja. `null`/ausente = todos. */
  allowedAnchors?: ReadonlySet<string> | null;
}

function distanceBetween(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Qué hay bajo `point` (espacio de DOCUMENTO). Prioridad: handle o anchor (el más cercano; en un empate gana el anchor) y, si no, el
 * segmento más cercano con su parámetro `t`. Las tolerancias están en unidades de documento (`pathHitTolerances(zoom)`): el área de hit
 * mide lo mismo en pantalla a cualquier zoom.
 */
export function hitTestPath(model: PathModel, matrix: AffineMatrix, point: Point, tolerances: HitTolerances, options: PathHitOptions): PathHit | null {
  let best: PathHit | null = null;
  let bestDistance = Infinity;

  for (const handle of options.handles) {
    const located = locateNode(model, handle);
    const local = located ? (handle.side === "in" ? located.node.handleIn : located.node.handleOut) : null;
    if (!local) continue;
    const gap = distanceBetween(applyMatrixToPoint(matrix, local), point);
    if (gap <= tolerances.handle && gap < bestDistance) {
      best = { kind: "handle", ref: { subpath: handle.subpath, node: handle.node }, side: handle.side };
      bestDistance = gap;
    }
  }

  const allowed = options.allowedAnchors ?? null;
  for (let subpathIndex = 0; subpathIndex < model.subpaths.length; subpathIndex += 1) {
    const { nodes } = model.subpaths[subpathIndex];
    for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
      if (allowed && !allowed.has(nodeKey({ subpath: subpathIndex, node: nodeIndex }))) continue;
      const gap = distanceBetween(applyMatrixToPoint(matrix, nodes[nodeIndex].anchor), point);
      if (gap <= tolerances.anchor && gap <= bestDistance) {
        best = { kind: "anchor", ref: { subpath: subpathIndex, node: nodeIndex } };
        bestDistance = gap;
      }
    }
  }
  if (best !== null) return best;

  let nearest: PathHit | null = null;
  let nearestDistance = Infinity;
  for (let subpathIndex = 0; subpathIndex < model.subpaths.length; subpathIndex += 1) {
    const subpath = model.subpaths[subpathIndex];
    const total = segmentCount(subpath);
    for (let segment = 0; segment < total; segment += 1) {
      if (allowed && !allowed.has(nodeKey({ subpath: subpathIndex, node: segment })) && !allowed.has(nodeKey({ subpath: subpathIndex, node: (segment + 1) % subpath.nodes.length }))) continue;
      const curve = segmentCurve(subpath, segment);
      if (!curve) continue;
      const docCurve: SegmentCurve = {
        p0: applyMatrixToPoint(matrix, curve.p0),
        p1: applyMatrixToPoint(matrix, curve.p1),
        p2: applyMatrixToPoint(matrix, curve.p2),
        p3: applyMatrixToPoint(matrix, curve.p3),
        curved: curve.curved,
      };
      const box = curveBox(docCurve);
      const slack = tolerances.segment;
      if (point.x < box.x - slack || point.x > box.x + box.width + slack || point.y < box.y - slack || point.y > box.y + box.height + slack) continue;
      const closest = closestPointOnSegment(docCurve, point);
      if (closest.distance <= slack && closest.distance < nearestDistance) {
        nearest = { kind: "segment", subpath: subpathIndex, segment, t: closest.t, point: closest.point };
        nearestDistance = closest.distance;
      }
    }
  }
  return nearest;
}

// ---- Overlay acotado ----

export interface OverlayNode {
  ref: NodeRef;
  key: string;
  /** Posición del anchor en espacio de DOCUMENTO. */
  doc: Point;
  selected: boolean;
}

export interface OverlayNodes {
  nodes: OverlayNode[];
  /** Nodos del path en total / que caen en el viewport (o están seleccionados). */
  total: number;
  inView: number;
  /** Hay más nodos en pantalla que el tope: se dibujan solo `nodes.length`. */
  truncated: boolean;
}

/** Rectángulo de DOCUMENTO que ve el viewport (con un margen en px de pantalla). */
export function viewportRectInDocument(viewport: ViewportParams, marginPx = 24): Rect {
  const topLeft = screenToDocument({ x: -marginPx, y: -marginPx }, viewport);
  const bottomRight = screenToDocument({ x: viewport.containerWidth + marginPx, y: viewport.containerHeight + marginPx }, viewport);
  return { x: topLeft.x, y: topLeft.y, width: bottomRight.x - topLeft.x, height: bottomRight.y - topLeft.y };
}

/**
 * Nodos que se dibujan: primero los seleccionados y después los que caen en `view`, hasta `cap`. Un path de miles de nodos no satura el
 * overlay (ni el DOM): se acota al viewport y a un máximo, y `truncated` permite avisar al usuario.
 */
export function collectOverlayNodes(model: PathModel, matrix: AffineMatrix, view: Rect | null, selected: ReadonlySet<string>, cap = MAX_OVERLAY_NODES): OverlayNodes {
  const inside = (p: Point) => view === null || (p.x >= view.x && p.x <= view.x + view.width && p.y >= view.y && p.y <= view.y + view.height);
  const nodes: OverlayNode[] = [];
  let total = 0;
  let inView = 0;
  const rest: OverlayNode[] = [];
  model.subpaths.forEach((subpath, subpathIndex) => {
    subpath.nodes.forEach((node, nodeIndex) => {
      total += 1;
      const ref = { subpath: subpathIndex, node: nodeIndex };
      const key = nodeKey(ref);
      const isSelected = selected.has(key);
      const doc = applyMatrixToPoint(matrix, node.anchor);
      if (!isSelected && !inside(doc)) return;
      inView += 1;
      const entry: OverlayNode = { ref, key, doc, selected: isSelected };
      if (isSelected) {
        if (nodes.length < cap) nodes.push(entry);
      } else {
        rest.push(entry);
      }
    });
  });
  for (const entry of rest) {
    if (nodes.length >= cap) break;
    nodes.push(entry);
  }
  return { nodes, total, inView, truncated: inView > nodes.length };
}

/** Nodos cuyo anchor (en documento) cae dentro de `rect`; `allowed` limita a los que el overlay dibuja. */
export function nodesInRect(model: PathModel, matrix: AffineMatrix, rect: Rect, allowed?: ReadonlySet<string> | null): NodeRef[] {
  const refs: NodeRef[] = [];
  model.subpaths.forEach((subpath, subpathIndex) => {
    subpath.nodes.forEach((node, nodeIndex) => {
      if (allowed && !allowed.has(nodeKey({ subpath: subpathIndex, node: nodeIndex }))) return;
      const p = applyMatrixToPoint(matrix, node.anchor);
      if (p.x >= rect.x && p.x <= rect.x + rect.width && p.y >= rect.y && p.y <= rect.y + rect.height) refs.push({ subpath: subpathIndex, node: nodeIndex });
    });
  });
  return refs;
}

// ---- Selección ----

/** Referencias válidas del modelo para un conjunto de claves (las que ya no existen se descartan). */
export function refsFromKeys(model: PathModel, keys: Iterable<string>): NodeRef[] {
  const refs: NodeRef[] = [];
  for (const key of keys) {
    const ref = parseNodeKey(key);
    if (ref && locateNode(model, ref)) refs.push(ref);
  }
  return refs;
}

/** Segmentos cuyos DOS extremos están seleccionados (los que se pueden alternar entre recto y curvo). */
export function selectedSegments(model: PathModel, selected: ReadonlySet<string>): SegmentRef[] {
  const segments: SegmentRef[] = [];
  model.subpaths.forEach((subpath, subpathIndex) => {
    const count = subpath.nodes.length;
    for (let segment = 0; segment < segmentCount(subpath); segment += 1) {
      if (selected.has(nodeKey({ subpath: subpathIndex, node: segment })) && selected.has(nodeKey({ subpath: subpathIndex, node: (segment + 1) % count }))) segments.push({ subpath: subpathIndex, segment });
    }
  });
  return segments;
}

/** Los segmentos que entran y salen de un nodo (los que existen), para alternar su tipo desde el panel. */
export function adjacentSegments(model: PathModel, ref: NodeRef): { before: SegmentRef | null; after: SegmentRef | null } {
  const subpath = model.subpaths[ref.subpath];
  if (!subpath) return { before: null, after: null };
  const total = segmentCount(subpath);
  const count = subpath.nodes.length;
  const after = ref.node < total ? { subpath: ref.subpath, segment: ref.node } : null;
  const beforeIndex = subpath.closed ? (ref.node - 1 + count) % count : ref.node - 1;
  const before = beforeIndex >= 0 && beforeIndex < total ? { subpath: ref.subpath, segment: beforeIndex } : null;
  return { before, after };
}

/** Nodo siguiente/anterior en el orden del modelo (con vuelta al otro extremo): navegación por teclado entre nodos. */
export function stepNode(model: PathModel, from: NodeRef | null, step: 1 | -1): NodeRef | null {
  const refs = allNodeRefs(model);
  if (refs.length === 0) return null;
  if (!from) return step === 1 ? refs[0] : refs[refs.length - 1];
  const index = refs.findIndex((ref) => ref.subpath === from.subpath && ref.node === from.node);
  if (index === -1) return refs[0];
  return refs[(index + step + refs.length) % refs.length];
}
