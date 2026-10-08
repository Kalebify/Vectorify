import { paintOrdered, type ShortcutKeyEvent } from "./clipboard";
import { isValidFrame } from "./frame";
import { bounds, objectBounds } from "./objects";
import { translate } from "./transform";
import type { DocumentFrame, EditableDocument, EditorObject, EditProduction, Point, Rect } from "./types";
import { formatDisplayNumber, toMm } from "./units";

/**
 * Alinear / Distribuir / Z-order (MVP3-S07). Lógica pura, sin React ni Konva: la UI (EditorShell, ArrangeBar) y los tests usan las
 * mismas funciones, y todo cambio del documento sale como una `EditProduction` que `applyEdit` registra como UN comando.
 *
 * DECISIONES (la tarjeta pide documentarlas):
 * 1. Referencia de alineación (selector visible, default "Selección"): *Selección* = bounds de la unión de los objetos MOVIBLES
 *    seleccionados (requiere 2 o más); *Documento* = el marco vigente (`DocumentFrame` de S02), también con un solo objeto. Se opera sobre
 *    los bounds GEOMÉTRICOS exactos del objeto (curvas incluidas, con su `matrix`); el ancho del trazo NO cuenta.
 * 2. Distribuir (3 o más objetos movibles): huecos iguales entre bounds consecutivos. Se ordena por borde izquierdo (superior en
 *    vertical); un empate se resuelve por orden de pintado (estable). Los dos extremos quedan FIJOS y los intermedios se reubican. Si los
 *    objetos se solapan y el hueco total es negativo se distribuye igual (huecos negativos iguales) y se informa.
 * 3. Objetos bloqueados: se excluyen POR COMPLETO (ni se mueven ni cuentan para la referencia ni para los huecos) y se informan. Una
 *    capa oculta se trata igual (la selección ya no la contiene; es defensa en profundidad).
 * 4. Z-order: SIEMPRE dentro de la capa de cada objeto; nunca cambia un objeto de capa (el orden entre capas es el del panel de Capas).
 *    Cada capa se procesa por separado y todas viajan en UN comando. Adelante/atrás mueven cada objeto seleccionado UN paso respecto del
 *    vecino NO seleccionado más cercano (el orden relativo entre los seleccionados no cambia); frente/fondo los llevan al extremo
 *    conservándolo. En el límite no hay comando.
 * 5. Alinear y distribuir son TRASLACIONES: se compone la `matrix` (nunca se hornea ni se toca `d`), exactas en unidades de documento (sin
 *    redondeo). Un desplazamiento menor que `ARRANGE_EPSILON` es ruido de punto flotante y cuenta como "ya alineado": si nada se mueve
 *    no hay producción (la pila de undo no crece).
 */

/** Desplazamiento (unidades de documento) por debajo del cual un objeto se considera ya en su sitio. */
export const ARRANGE_EPSILON = 1e-9;

export type AlignMode = "left" | "center" | "right" | "top" | "middle" | "bottom";
export type AlignReference = "selection" | "document";
export type DistributeAxis = "horizontal" | "vertical";
export type ZOrderAction = "forward" | "backward" | "front" | "back";

/** Identificador de cada botón de la barra "Organizar". */
export type ArrangeActionId =
  | "align-left"
  | "align-center"
  | "align-right"
  | "align-top"
  | "align-middle"
  | "align-bottom"
  | "distribute-horizontal"
  | "distribute-vertical"
  | "z-forward"
  | "z-backward"
  | "z-front"
  | "z-back";

export type ArrangeDescriptor =
  | { id: ArrangeActionId; group: "align"; label: string; mode: AlignMode }
  | { id: ArrangeActionId; group: "distribute"; label: string; axis: DistributeAxis }
  | { id: ArrangeActionId; group: "order"; label: string; action: ZOrderAction; keys: string; ariaKeys: string };

/** Acciones de la barra, en el orden en que se muestran. Ctrl en Windows/Linux, Cmd en macOS. */
export const ARRANGE_ACTIONS: readonly ArrangeDescriptor[] = [
  { id: "align-left", group: "align", label: "Alinear a la izquierda", mode: "left" },
  { id: "align-center", group: "align", label: "Centrar horizontalmente", mode: "center" },
  { id: "align-right", group: "align", label: "Alinear a la derecha", mode: "right" },
  { id: "align-top", group: "align", label: "Alinear arriba", mode: "top" },
  { id: "align-middle", group: "align", label: "Centrar verticalmente", mode: "middle" },
  { id: "align-bottom", group: "align", label: "Alinear abajo", mode: "bottom" },
  { id: "distribute-horizontal", group: "distribute", label: "Distribuir horizontalmente", axis: "horizontal" },
  { id: "distribute-vertical", group: "distribute", label: "Distribuir verticalmente", axis: "vertical" },
  { id: "z-forward", group: "order", label: "Traer adelante", action: "forward", keys: "Ctrl/Cmd+]", ariaKeys: "Control+] Meta+]" },
  { id: "z-backward", group: "order", label: "Enviar atrás", action: "backward", keys: "Ctrl/Cmd+[", ariaKeys: "Control+[ Meta+[" },
  { id: "z-front", group: "order", label: "Traer al frente", action: "front", keys: "Ctrl/Cmd+Shift+]", ariaKeys: "Control+Shift+] Meta+Shift+]" },
  { id: "z-back", group: "order", label: "Enviar al fondo", action: "back", keys: "Ctrl/Cmd+Shift+[", ariaKeys: "Control+Shift+[ Meta+Shift+[" },
];

/** Atajos de z-order para la lista "Atajos" de la UI (mismo panel que los de portapapeles). */
export const ARRANGE_SHORTCUTS: readonly { label: string; keys: string }[] = ARRANGE_ACTIONS.flatMap((descriptor) =>
  descriptor.group === "order" ? [{ label: descriptor.label, keys: descriptor.keys }] : [],
);

export function arrangeDescriptor(id: ArrangeActionId): ArrangeDescriptor {
  const found = ARRANGE_ACTIONS.find((descriptor) => descriptor.id === id);
  if (!found) throw new Error(`Acción de organizar desconocida: ${id}`);
  return found;
}

const Z_ACTION_IDS: Record<ZOrderAction, ArrangeActionId> = { forward: "z-forward", backward: "z-backward", front: "z-front", back: "z-back" };

/** Id de botón de una acción de z-order (lo usa el atajo de teclado). */
export function zOrderActionId(action: ZOrderAction): ArrangeActionId {
  return Z_ACTION_IDS[action];
}

// ---- Atajos de z-order ----

/**
 * Acción de z-order que dispara un evento de teclado, o `null`: Ctrl/Cmd+] adelante, Ctrl/Cmd+[ atrás, con Shift al frente / al fondo.
 * Los corchetes se reconocen por `key` Y por la tecla física (`code: BracketRight/BracketLeft`): en teclados no-US (es, de, fr...) los
 * corchetes salen con AltGr o con otra tecla y `key` no trae "]". Con Alt apretado no se dispara (en Windows AltGr = Ctrl+Alt: esa
 * pulsación escribe un carácter, no es un atajo). Quien lo usa decide si el foco está en un campo de texto.
 */
export function matchArrangeShortcut(event: ShortcutKeyEvent): ZOrderAction | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null;
  const forward = event.key === "]" || event.key === "}" || event.code === "BracketRight";
  const backward = event.key === "[" || event.key === "{" || event.code === "BracketLeft";
  if (forward === backward) return null;
  if (forward) return event.shiftKey ? "front" : "forward";
  return event.shiftKey ? "back" : "backward";
}

// ---- Resultado ----

export interface ArrangeSummary {
  /** Objetos que cambian de posición (alinear/distribuir) o de lugar en el orden de pintado (z-order: solo los seleccionados). */
  moved: number;
  /** Objetos que participaron (movibles, con geometría). */
  considered: number;
  /** Objetos de la selección en capas bloqueadas: excluidos por completo. */
  skippedLocked: number;
  /** Objetos de la selección en capas ocultas: excluidos por completo. */
  skippedHidden: number;
  /** Objetos sin geometría que dibujar (alinear/distribuir no los puede ubicar). */
  skippedEmpty: number;
  /** Z-order: objetos seleccionados cuya capa ya estaba en el límite (sin cambio). */
  atLimit: number;
  /** La acción es válida pero no cambia nada ("Ya está alineado"): sin producción ni comando. */
  noop: boolean;
  /** Por qué no hay producción (rechazo o no-op), en lenguaje de usuario; `null` si hay producción. */
  reason: string | null;
  /** Distribuir: hueco igual entre bounds consecutivos, en unidades de documento (negativo = se solapan). */
  gap?: number;
}

export interface ArrangeResult {
  /** `null` si no hay nada que aplicar (ver `summary.reason`): no se crea comando. */
  production: EditProduction | null;
  /** Etiqueta legible del comando ("Alinear a la izquierda"). */
  label: string;
  summary: ArrangeSummary;
}

interface Classified {
  /** Objetos de la selección que SÍ se pueden modificar, en orden de pintado. */
  free: EditorObject[];
  selected: number;
  skippedLocked: number;
  skippedHidden: number;
}

interface Plan {
  layers: Record<string, EditorObject[]> | null;
  summary: ArrangeSummary;
}

export interface ArrangeOptions {
  /** Capas bloqueadas adicionales a las de `document.layers` (el shell las toma de la estructura vigente). */
  lockedLayerIds?: ReadonlySet<string>;
}

export interface AlignOptions extends ArrangeOptions {
  mode: AlignMode;
  reference: AlignReference;
  /** Marco del documento (referencia "documento"); por defecto `document.frame`. */
  frame?: DocumentFrame;
}

export interface DistributeOptions extends ArrangeOptions {
  axis: DistributeAxis;
}

export interface ZOrderOptions extends ArrangeOptions {
  action: ZOrderAction;
}

const ALIGN_LABELS: Record<AlignMode, string> = {
  left: "Alinear a la izquierda",
  center: "Centrar horizontalmente",
  right: "Alinear a la derecha",
  top: "Alinear arriba",
  middle: "Centrar verticalmente",
  bottom: "Alinear abajo",
};
const DISTRIBUTE_LABELS: Record<DistributeAxis, string> = {
  horizontal: "Distribuir horizontalmente",
  vertical: "Distribuir verticalmente",
};
const Z_ORDER_LABELS: Record<ZOrderAction, string> = {
  forward: "Traer adelante",
  backward: "Enviar atrás",
  front: "Traer al frente",
  back: "Enviar al fondo",
};

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

// ---- Clasificación de la selección ----

/**
 * Separa la selección en lo que se puede modificar y lo que se excluye (capa bloqueada u oculta). Los objetos se RELEEN del `document`
 * (que manda; un id que ya no existe se descarta) y salen en orden de pintado.
 */
function classify(document: EditableDocument, selection: readonly EditorObject[], extraLocked: ReadonlySet<string> | undefined): Classified {
  const wanted = new Set(selection.map((object) => object.id));
  const locked = new Set<string>(extraLocked ?? []);
  const hidden = new Set<string>();
  for (const layer of document.layers ?? []) {
    if (layer.locked) locked.add(layer.groupId);
    else if (!layer.visible) hidden.add(layer.groupId);
  }
  const free: EditorObject[] = [];
  let skippedLocked = 0;
  let skippedHidden = 0;
  let selected = 0;
  if (wanted.size > 0) {
    for (const object of paintOrdered(document)) {
      if (!wanted.has(object.id)) continue;
      selected += 1;
      if (locked.has(object.layerGroupId)) skippedLocked += 1;
      else if (hidden.has(object.layerGroupId)) skippedHidden += 1;
      else free.push(object);
    }
  }
  return { free, selected, skippedLocked, skippedHidden };
}

function summaryOf(classified: Classified, extra: Partial<ArrangeSummary> = {}): ArrangeSummary {
  return {
    moved: 0,
    considered: 0,
    skippedLocked: classified.skippedLocked,
    skippedHidden: classified.skippedHidden,
    skippedEmpty: 0,
    atLimit: 0,
    noop: false,
    reason: null,
    ...extra,
  };
}

const rejection = (classified: Classified, reason: string, extra: Partial<ArrangeSummary> = {}): Plan => ({ layers: null, summary: summaryOf(classified, { reason, ...extra }) });
const nothingToDo = (classified: Classified, reason: string, extra: Partial<ArrangeSummary> = {}): Plan => ({ layers: null, summary: summaryOf(classified, { reason, noop: true, ...extra }) });

/** Motivo por el que no hay NADA movible en la selección (sin selección, todo bloqueado/oculto), o `null` si hay con qué trabajar. */
function nothingMovableReason(classified: Classified, verb: string): string | null {
  if (classified.selected === 0) return `Seleccioná objetos para ${verb}.`;
  if (classified.free.length > 0) return null;
  if (classified.skippedLocked > 0) return `Los objetos seleccionados están en capas bloqueadas: no se pueden ${verb}. Desbloqueá las capas en el panel de Capas.`;
  return `Los objetos seleccionados están en capas ocultas: no se pueden ${verb}. Mostrá las capas en el panel de Capas.`;
}

/** Objetos movibles con bbox, en orden de pintado (alinear/distribuir). Los que no dibujan nada no se pueden ubicar. */
function withGeometry(classified: Classified): { objects: EditorObject[]; skippedEmpty: number } {
  const objects = classified.free.filter((object) => objectBounds(object) !== null);
  return { objects, skippedEmpty: classified.free.length - objects.length };
}

/** Capas del documento con los desplazamientos aplicados (traslaciones: se compone la `matrix`), solo las tocadas. */
function applyMoves(document: EditableDocument, moves: ReadonlyMap<string, Point>): Record<string, EditorObject[]> {
  const layers: Record<string, EditorObject[]> = {};
  for (const [layerId, objects] of Object.entries(document.objectsByLayer)) {
    if (!objects.some((object) => moves.has(object.id))) continue;
    layers[layerId] = objects.map((object) => {
      const move = moves.get(object.id);
      return move ? translate([object], move.x, move.y)[0] : object;
    });
  }
  return layers;
}

// ---- Alinear ----

/** Desplazamiento que lleva el bbox `box` a la referencia `ref` según el modo. Alinear izquierda/centro/derecha mueve solo x; arriba/medio/abajo solo y. */
function alignDelta(mode: AlignMode, box: Rect, ref: Rect): Point {
  switch (mode) {
    case "left":
      return { x: ref.x - box.x, y: 0 };
    case "center":
      return { x: ref.x + ref.width / 2 - (box.x + box.width / 2), y: 0 };
    case "right":
      return { x: ref.x + ref.width - (box.x + box.width), y: 0 };
    case "top":
      return { x: 0, y: ref.y - box.y };
    case "middle":
      return { x: 0, y: ref.y + ref.height / 2 - (box.y + box.height / 2) };
    case "bottom":
      return { x: 0, y: ref.y + ref.height - (box.y + box.height) };
  }
}

function planAlign(document: EditableDocument, selection: readonly EditorObject[], options: AlignOptions, build = true): Plan {
  const classified = classify(document, selection, options.lockedLayerIds);
  const blocked = nothingMovableReason(classified, "alinear");
  if (blocked) return rejection(classified, blocked);

  const { objects, skippedEmpty } = withGeometry(classified);
  if (objects.length === 0) return rejection(classified, "Los objetos seleccionados no tienen geometría para alinear.", { skippedEmpty });

  let reference: Rect | null;
  if (options.reference === "selection") {
    if (objects.length < 2) {
      return rejection(classified, "Alinear respecto de la selección requiere 2 o más objetos movibles: elegí la referencia «Documento» o sumá objetos a la selección.", {
        considered: objects.length,
        skippedEmpty,
      });
    }
    reference = bounds(objects);
  } else {
    const frame = options.frame ?? document.frame;
    if (!frame || !isValidFrame(frame)) return rejection(classified, "El área de trabajo no es válida: no se puede alinear respecto del documento.", { considered: objects.length, skippedEmpty });
    reference = { x: frame.x, y: frame.y, width: frame.width, height: frame.height };
  }
  if (!reference) return rejection(classified, "Los objetos seleccionados no tienen geometría para alinear.", { skippedEmpty });

  const moves = new Map<string, Point>();
  for (const object of objects) {
    const box = objectBounds(object);
    if (!box) continue;
    const delta = alignDelta(options.mode, box, reference);
    if (Math.abs(delta.x) > ARRANGE_EPSILON || Math.abs(delta.y) > ARRANGE_EPSILON) moves.set(object.id, delta);
  }
  const extra = { considered: objects.length, skippedEmpty };
  if (moves.size === 0) return nothingToDo(classified, "Ya está alineado.", extra);
  return { layers: build ? applyMoves(document, moves) : {}, summary: summaryOf(classified, { ...extra, moved: moves.size }) };
}

/** Alinea la selección a su propia unión o al marco del documento. Cada objeto se traslada (su `matrix` se compone; `d` no se toca). */
export function alignProduction(document: EditableDocument, selection: readonly EditorObject[], options: AlignOptions): ArrangeResult {
  const plan = planAlign(document, selection, options);
  return { production: plan.layers ? { layers: plan.layers } : null, label: ALIGN_LABELS[options.mode], summary: plan.summary };
}

// ---- Distribuir ----

interface DistributeItem {
  object: EditorObject;
  start: number;
  size: number;
  paintIndex: number;
}

function planDistribute(document: EditableDocument, selection: readonly EditorObject[], options: DistributeOptions, build = true): Plan {
  const classified = classify(document, selection, options.lockedLayerIds);
  const blocked = nothingMovableReason(classified, "distribuir");
  if (blocked) return rejection(classified, blocked);

  const { objects, skippedEmpty } = withGeometry(classified);
  if (objects.length < 3) {
    return rejection(classified, `Distribuir requiere 3 o más objetos movibles (hay ${objects.length}).`, { considered: objects.length, skippedEmpty });
  }

  const horizontal = options.axis === "horizontal";
  const items: DistributeItem[] = objects.map((object, paintIndex) => {
    const box = objectBounds(object) as Rect;
    return { object, start: horizontal ? box.x : box.y, size: horizontal ? box.width : box.height, paintIndex };
  });
  // Posición por borde inicial; un empate exacto se resuelve por orden de pintado (determinista).
  items.sort((left, right) => left.start - right.start || left.paintIndex - right.paintIndex);

  const first = items[0];
  const last = items[items.length - 1];
  const totalSize = items.reduce((sum, item) => sum + item.size, 0);
  const span = last.start + last.size - first.start;
  const gap = (span - totalSize) / (items.length - 1);

  // Extremos fijos; el i-ésimo intermedio empieza tras los tamaños de los anteriores y `i` huecos.
  const moves = new Map<string, Point>();
  let occupied = first.size;
  for (let index = 1; index < items.length - 1; index += 1) {
    const item = items[index];
    const delta = first.start + occupied + index * gap - item.start;
    if (Math.abs(delta) > ARRANGE_EPSILON) moves.set(item.object.id, horizontal ? { x: delta, y: 0 } : { x: 0, y: delta });
    occupied += item.size;
  }
  const extra = { considered: items.length, skippedEmpty, gap };
  if (moves.size === 0) return nothingToDo(classified, "Ya está distribuido con huecos iguales.", extra);
  return { layers: build ? applyMoves(document, moves) : {}, summary: summaryOf(classified, { ...extra, moved: moves.size }) };
}

/**
 * Distribuye 3 o más objetos con huecos iguales entre sus bounds (los dos extremos quedan fijos). Con objetos solapados el hueco es
 * negativo (se informa en `summary.gap`).
 */
export function distributeProduction(document: EditableDocument, selection: readonly EditorObject[], options: DistributeOptions): ArrangeResult {
  const plan = planDistribute(document, selection, options);
  return { production: plan.layers ? { layers: plan.layers } : null, label: DISTRIBUTE_LABELS[options.axis], summary: plan.summary };
}

// ---- Z-order ----

/**
 * Nueva lista de una capa tras la acción, o `null` si queda igual (límite). Es una PERMUTACIÓN de los mismos objetos (referencias
 * intactas): ni ids ni contenido ni capa cambian. `isSelected` marca el bloque que se mueve.
 */
function reorderLayer(objects: readonly EditorObject[], isSelected: (object: EditorObject) => boolean, action: ZOrderAction): EditorObject[] | null {
  let next: EditorObject[];
  if (action === "front") {
    next = [...objects.filter((object) => !isSelected(object)), ...objects.filter(isSelected)];
  } else if (action === "back") {
    next = [...objects.filter(isSelected), ...objects.filter((object) => !isSelected(object))];
  } else {
    next = [...objects];
    if (action === "forward") {
      // De arriba hacia abajo: cada seleccionado salta por encima del vecino NO seleccionado inmediato (un bloque contiguo sube de a un paso).
      for (let index = next.length - 2; index >= 0; index -= 1) {
        if (isSelected(next[index]) && !isSelected(next[index + 1])) [next[index], next[index + 1]] = [next[index + 1], next[index]];
      }
    } else {
      for (let index = 1; index < next.length; index += 1) {
        if (isSelected(next[index]) && !isSelected(next[index - 1])) [next[index], next[index - 1]] = [next[index - 1], next[index]];
      }
    }
  }
  return next.some((object, index) => object !== objects[index]) ? next : null;
}

function planZOrder(document: EditableDocument, selection: readonly EditorObject[], options: ZOrderOptions): Plan {
  const classified = classify(document, selection, options.lockedLayerIds);
  const blocked = nothingMovableReason(classified, "reordenar");
  if (blocked) return rejection(classified, blocked);

  const movable = new Set(classified.free.map((object) => object.id));
  const isSelected = (object: EditorObject) => movable.has(object.id);
  const layers: Record<string, EditorObject[]> = {};
  let moved = 0;
  let atLimit = 0;
  // Cada capa por separado: el orden de pintado ENTRE capas es el del panel de Capas y acá no se toca.
  for (const [layerId, objects] of Object.entries(document.objectsByLayer)) {
    const selectedHere = objects.filter(isSelected).length;
    if (selectedHere === 0) continue;
    const reordered = reorderLayer(objects, isSelected, options.action);
    if (!reordered) {
      atLimit += selectedHere;
      continue;
    }
    layers[layerId] = reordered;
    const before = new Map(objects.map((object, index) => [object.id, index]));
    moved += reordered.filter((object, index) => isSelected(object) && before.get(object.id) !== index).length;
  }

  const extra = { considered: classified.free.length, atLimit };
  if (Object.keys(layers).length === 0) {
    const atTop = options.action === "forward" || options.action === "front";
    const manyObjects = classified.free.length > 1;
    const manyLayers = new Set(classified.free.map((object) => object.layerGroupId)).size > 1;
    return nothingToDo(classified, `${manyObjects ? "Ya están" : "Ya está"} ${atTop ? "al frente" : "al fondo"} de ${manyLayers ? "sus capas" : "su capa"}.`, extra);
  }
  return { layers, summary: summaryOf(classified, { ...extra, moved }) };
}

/**
 * Reordena el orden de pintado de la selección DENTRO de la capa de cada objeto (nunca los cambia de capa). Varias capas = un solo
 * comando; una capa donde ya no hay nada que mover no se toca. Sin cambios en ninguna capa no hay producción.
 */
export function zOrderProduction(document: EditableDocument, selection: readonly EditorObject[], options: ZOrderOptions): ArrangeResult {
  const plan = planZOrder(document, selection, options);
  return { production: plan.layers ? { layers: plan.layers } : null, label: Z_ORDER_LABELS[options.action], summary: plan.summary };
}

// ---- Despacho por botón / disponibilidad ----

export interface ArrangeRunOptions extends ArrangeOptions {
  reference: AlignReference;
  frame?: DocumentFrame;
}

/** `build: false` solo decide si la acción es posible (disponibilidad): no construye los objetos trasladados. */
function planFor(document: EditableDocument, selection: readonly EditorObject[], id: ArrangeActionId, options: ArrangeRunOptions, build = true): { plan: Plan; label: string } {
  const descriptor = arrangeDescriptor(id);
  const { lockedLayerIds } = options;
  if (descriptor.group === "align") {
    return { plan: planAlign(document, selection, { mode: descriptor.mode, reference: options.reference, frame: options.frame, lockedLayerIds }, build), label: descriptor.label };
  }
  if (descriptor.group === "distribute") {
    return { plan: planDistribute(document, selection, { axis: descriptor.axis, lockedLayerIds }, build), label: descriptor.label };
  }
  return { plan: planZOrder(document, selection, { action: descriptor.action, lockedLayerIds }), label: descriptor.label };
}

/** Ejecuta la acción de un botón de la barra "Organizar" sobre `selection`. */
export function runArrange(document: EditableDocument, selection: readonly EditorObject[], id: ArrangeActionId, options: ArrangeRunOptions): ArrangeResult {
  const { plan, label } = planFor(document, selection, id, options);
  return { production: plan.layers ? { layers: plan.layers } : null, label, summary: plan.summary };
}

const SUSPENDED_REASON = "Hay una transformación pendiente: aplicala (Apply) o cancelala (Cancel) antes de editar.";

export interface ArrangeAvailabilityOptions extends ArrangeRunOptions {
  /** Hay una transformación pendiente de Apply/Cancel: no se edita. */
  suspended: boolean;
}

/**
 * Por qué cada botón está deshabilitado (texto del tooltip), o `null` si se puede ejecutar. Alinear y distribuir solo se deshabilitan
 * ante un RECHAZO (sin selección, todo bloqueado, menos de 2 / 3 objetos...): "ya alineado" se informa al ejecutar. El z-order también se
 * deshabilita cuando ya está en el límite de su capa.
 */
export function arrangeAvailability(document: EditableDocument, selection: readonly EditorObject[], options: ArrangeAvailabilityOptions): Record<ArrangeActionId, string | null> {
  const result = {} as Record<ArrangeActionId, string | null>;
  for (const descriptor of ARRANGE_ACTIONS) {
    if (options.suspended) {
      result[descriptor.id] = SUSPENDED_REASON;
      continue;
    }
    const { plan } = planFor(document, selection, descriptor.id, options, false);
    const unavailable = plan.layers === null && (!plan.summary.noop || descriptor.group === "order");
    result[descriptor.id] = unavailable ? plan.summary.reason : null;
  }
  return result;
}

// ---- Mensajes ----

/** "1 objeto bloqueado omitido; 2 objetos en capas ocultas omitidos." (con un espacio inicial) o cadena vacía. */
function skippedText(summary: ArrangeSummary): string {
  const parts: string[] = [];
  if (summary.skippedLocked > 0) parts.push(plural(summary.skippedLocked, "objeto bloqueado omitido", "objetos bloqueados omitidos"));
  if (summary.skippedHidden > 0) parts.push(plural(summary.skippedHidden, "objeto en capa oculta omitido", "objetos en capas ocultas omitidos"));
  if (summary.skippedEmpty > 0) parts.push(plural(summary.skippedEmpty, "objeto sin geometría omitido", "objetos sin geometría omitidos"));
  return parts.length > 0 ? ` ${parts.join("; ")}.` : "";
}

export interface ArrangeMessageContext {
  /** mm por unidad de documento, o `null` si el documento no tiene escala física (los huecos se informan en unidades). */
  mmPerUnit: number | null;
  reference: AlignReference;
}

export interface ArrangeMessage {
  kind: "ok" | "error";
  text: string;
}

function formatLength(units: number, mmPerUnit: number | null): string {
  return mmPerUnit === null ? `${formatDisplayNumber(units)} u` : `${formatDisplayNumber(toMm(units, mmPerUnit))} mm`;
}

/**
 * Mensaje para el usuario del resultado de `runArrange`: lo aplicado (con lo omitido por bloqueo), el "ya está alineado" de un no-op o el
 * motivo de un rechazo.
 */
export function describeArrange(id: ArrangeActionId, result: ArrangeResult, context: ArrangeMessageContext): ArrangeMessage {
  const { summary, label } = result;
  if (!result.production) {
    const text = `${summary.reason ?? "No hay cambios para aplicar."}${summary.noop ? skippedText(summary) : ""}`;
    return { kind: summary.noop ? "ok" : "error", text };
  }
  const descriptor = arrangeDescriptor(id);
  let text: string;
  if (descriptor.group === "align") {
    text = `${label}: ${plural(summary.moved, "objeto movido", "objetos movidos")} (referencia: ${context.reference === "document" ? "documento" : "selección"}).`;
  } else if (descriptor.group === "distribute") {
    const gap = summary.gap ?? 0;
    text =
      gap < 0
        ? `${label}: ${plural(summary.moved, "objeto movido", "objetos movidos")}. Los objetos se solapan: huecos negativos iguales de ${formatLength(gap, context.mmPerUnit)}.`
        : `${label}: ${plural(summary.moved, "objeto movido", "objetos movidos")}; hueco igual de ${formatLength(gap, context.mmPerUnit)} entre objetos.`;
  } else {
    text = `${label}: ${plural(summary.moved, "objeto reordenado", "objetos reordenados")} dentro de su capa.`;
    if (summary.atLimit > 0) text += ` ${plural(summary.atLimit, "objeto ya estaba", "objetos ya estaban")} en el límite de su capa.`;
  }
  return { kind: "ok", text: `${text}${skippedText(summary)}` };
}
