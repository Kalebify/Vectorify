import { hexEquals, recolored } from "./colors";
import { bounds, objectBounds } from "./objects";
import { removeObjects } from "./selection";
import { translate } from "./transform";
import type { EditableDocument, EditableLayerMeta, EditorObject, EditProduction, Point, Rect } from "./types";
import { fromMm } from "./units";
import type { AffineMatrix } from "../svgTransform";

/**
 * Copiar / Cortar / Pegar / Duplicar / Eliminar (MVP3-S06). Lógica pura, sin React ni Konva: la UI (EditorShell, ClipboardBar) y los
 * tests usan las mismas funciones, y todo cambio del documento sale como una `EditProduction` que `applyEdit` registra como UN comando.
 *
 * DECISIONES (la tarjeta pide documentarlas):
 * 1. El portapapeles es INTERNO a la sesión del editor (no el del sistema operativo) y guarda copias PROFUNDAS e inmutables
 *    (`d`, `fill`, `stroke`, `strokeWidth`, `matrix`, capa de origen y posición relativa al conjunto). NUNCA guarda ids: cada pegado
 *    genera ids nuevos y únicos con `createId` (inyectable), sin repetir los del documento ni los de otro pegado. Copiar no es un
 *    comando.
 * 2. Offset: 5 mm en x e y (abajo-derecha en pantalla), convertido a unidades de documento con `mmPerUnit`; sin escala física, 5
 *    unidades. Pegados consecutivos ACUMULAN (1x, 2x, 3x...) y el contador se reinicia al copiar o cortar de nuevo. Pegar en el lugar
 *    no usa offset ni mueve el contador. Duplicar usa siempre 1x: duplicar la selección resultante repite el mismo delta ("step and
 *    repeat").
 * 3. Cada objeto se pega en su capa de origen SI existe, está visible y no está bloqueada; si no, se OMITE con su motivo (nunca se
 *    pega en silencio en otra capa). Si nada es pegable no hay comando. "Pegar en la capa activa" manda todo a la capa activa y los
 *    objetos toman el color de esa capa (mecanismo de S03). Una capa de origen que cambió de color desde que se copió también
 *    recolorea los pegados (el color de un objeto es el de su capa).
 * 4. Los objetos nuevos van ENCIMA (al final) de su capa conservando el orden relativo; un compound path se copia como UN objeto.
 * 5. Cortar guarda SOLO lo que corta (lo bloqueado se queda en su sitio y se informa; un corte rechazado no pisa el portapapeles).
 */

// ---- Offset ----

/** Offset de pegado en mm (x e y). */
export const PASTE_OFFSET_MM = 5;
/** Offset de pegado en unidades de documento cuando el documento no tiene escala física. */
export const PASTE_OFFSET_UNITS = 5;

/** Desplazamiento del `count`-ésimo pegado consecutivo (1x, 2x, 3x...) en unidades de documento: `count` pasos de 5 mm (o de 5 unidades sin escala física). */
export function pasteOffset(count: number, mmPerUnit: number | null): Point {
  const steps = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  const step = mmPerUnit !== null && Number.isFinite(mmPerUnit) && mmPerUnit > 0 ? fromMm(PASTE_OFFSET_MM, mmPerUnit) : PASTE_OFFSET_UNITS;
  return { x: step * steps, y: step * steps };
}

// ---- Acciones y atajos ----

export type ClipboardAction = "copy" | "cut" | "paste" | "paste-in-place" | "paste-active" | "duplicate" | "delete";

export interface ClipboardShortcut {
  action: ClipboardAction;
  label: string;
  /** Texto del atajo para tooltips y para la lista de atajos de la UI. */
  keys: string;
  /** Valor de `aria-keyshortcuts` (puede haber varios, separados por espacio). */
  ariaKeys: string;
}

/** Atajos documentados (en este orden se muestran en la UI). Ctrl en Windows/Linux, Cmd en macOS. */
export const CLIPBOARD_SHORTCUTS: readonly ClipboardShortcut[] = [
  { action: "copy", label: "Copiar", keys: "Ctrl/Cmd+C", ariaKeys: "Control+C Meta+C" },
  { action: "cut", label: "Cortar", keys: "Ctrl/Cmd+X", ariaKeys: "Control+X Meta+X" },
  { action: "paste", label: "Pegar", keys: "Ctrl/Cmd+V", ariaKeys: "Control+V Meta+V" },
  { action: "paste-in-place", label: "Pegar en el lugar", keys: "Ctrl/Cmd+Shift+V", ariaKeys: "Control+Shift+V Meta+Shift+V" },
  { action: "paste-active", label: "Pegar en la capa activa", keys: "Ctrl/Cmd+Alt+V", ariaKeys: "Control+Alt+V Meta+Alt+V" },
  { action: "duplicate", label: "Duplicar", keys: "Ctrl/Cmd+D", ariaKeys: "Control+D Meta+D" },
  { action: "delete", label: "Eliminar", keys: "Suprimir / Retroceso", ariaKeys: "Delete Backspace" },
];

/** Lo mínimo de un `KeyboardEvent` que mira el reconocedor de atajos (testeable sin DOM). */
export interface ShortcutKeyEvent {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** Letra de la tecla: `key` si es una letra ASCII; si no (p. ej. Option+V en macOS produce "√") la tecla física (`code: "KeyV"`). */
function keyLetter(event: ShortcutKeyEvent): string | null {
  if (/^[a-z]$/i.test(event.key)) return event.key.toLowerCase();
  const physical = /^Key([A-Z])$/.exec(event.code ?? "");
  return physical ? physical[1].toLowerCase() : null;
}

/**
 * Acción de portapapeles que dispara un evento de teclado, o `null`. Ctrl o Cmd + C / X / V / Shift+V / Alt+V / D, y Suprimir o
 * Retroceso sin Ctrl/Cmd/Alt. Quien lo usa decide si el foco está en un campo de texto (ahí NO se dispara nada).
 */
export function matchClipboardShortcut(event: ShortcutKeyEvent): ClipboardAction | null {
  const modifier = event.ctrlKey || event.metaKey;
  if (event.key === "Delete" || event.key === "Backspace") return !modifier && !event.altKey ? "delete" : null;
  if (!modifier) return null;
  const letter = keyLetter(event);
  if (letter === "v") {
    if (event.altKey && !event.shiftKey) return "paste-active";
    if (event.shiftKey && !event.altKey) return "paste-in-place";
    return !event.shiftKey && !event.altKey ? "paste" : null;
  }
  if (event.shiftKey || event.altKey) return null;
  if (letter === "c") return "copy";
  if (letter === "x") return "cut";
  if (letter === "d") return "duplicate";
  return null;
}

/** ¿El foco está en un campo donde esas teclas pertenecen al propio campo (input, textarea, select, contentEditable)? Mismo criterio que Undo/Redo de S01. */
export function isTextFieldTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return Boolean(element && (element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.tagName === "SELECT" || element.isContentEditable));
}

export interface ClipboardAvailabilityInput {
  /** Objetos seleccionados (incluidos los de capas bloqueadas). */
  selected: number;
  /** De ellos, los de capas desbloqueadas (los únicos que se pueden cortar, duplicar o eliminar). */
  editable: number;
  /** Objetos en el portapapeles. */
  clipboardSize: number;
  hasActiveLayer: boolean;
  /** Hay una transformación pendiente de Apply/Cancel: no se edita. */
  suspended: boolean;
}

const SUSPENDED_REASON = "Hay una transformación pendiente: aplicala (Apply) o cancelala (Cancel) antes de editar.";

/** Por qué cada acción está deshabilitada (texto para el tooltip), o `null` si se puede ejecutar. */
export function clipboardAvailability(input: ClipboardAvailabilityInput): Record<ClipboardAction, string | null> {
  const { selected, editable, clipboardSize, hasActiveLayer, suspended } = input;
  const needsSelection = (verb: string) => (selected === 0 ? `Seleccioná objetos para ${verb}.` : null);
  const needsEditable = (verb: string) =>
    needsSelection(verb) ?? (editable === 0 ? `Los objetos seleccionados están en capas bloqueadas: no se pueden ${verb}. Desbloqueá las capas en el panel de Capas.` : null);
  const emptyClipboard = clipboardSize === 0 ? "El portapapeles está vacío: copiá o cortá objetos primero." : null;
  const result: Record<ClipboardAction, string | null> = {
    copy: needsSelection("copiar"),
    cut: needsEditable("cortar"),
    paste: emptyClipboard,
    "paste-in-place": emptyClipboard,
    "paste-active": emptyClipboard ?? (hasActiveLayer ? null : "No hay capa activa: elegí una capa en el panel de Capas."),
    duplicate: needsEditable("duplicar"),
    delete: needsEditable("eliminar"),
  };
  if (suspended) {
    for (const action of Object.keys(result) as ClipboardAction[]) result[action] = SUSPENDED_REASON;
  }
  return result;
}

// ---- Mensajes ----

/** `unloaded`: la capa existe pero sus objetos todavía no se cargaron (o falló la carga): pegar ahí se perdería al terminar de cargar. */
export type SkipReason = "locked" | "hidden" | "missing" | "unloaded";

/** Objetos omitidos por una misma causa en una misma capa. */
export interface PlanSkip {
  reason: SkipReason;
  count: number;
  layerGroupId: string;
  layerName: string;
}

/** Acción cuyo resultado se narra en los mensajes ("Se pegaron 3 objetos", "2 objetos no se eliminaron..."). */
export type ClipboardVerb = "copy" | "cut" | "paste" | "duplicate" | "delete";

const VERBS: Record<ClipboardVerb, { one: string; many: string }> = {
  copy: { one: "se copió", many: "se copiaron" },
  cut: { one: "se cortó", many: "se cortaron" },
  paste: { one: "se pegó", many: "se pegaron" },
  duplicate: { one: "se duplicó", many: "se duplicaron" },
  delete: { one: "se eliminó", many: "se eliminaron" },
};

const REASON_TEXT: Record<SkipReason, string> = { locked: "bloqueada", hidden: "oculta", missing: "eliminada", unloaded: "sin cargar" };

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** "Se pegaron 3 objetos" / "Se copió 1 objeto". */
export function outcomeText(action: ClipboardVerb, count: number): string {
  const verb = count === 1 ? VERBS[action].one : VERBS[action].many;
  return `${verb[0].toUpperCase()}${verb.slice(1)} ${plural(count, "objeto", "objetos")}`;
}

/** "2 objetos no se pegaron (capa «Rojo» bloqueada); 1 objeto no se pegó (capa «Azul» oculta)". Sin punto final. */
export function describeSkipped(skipped: readonly PlanSkip[], action: ClipboardVerb): string {
  return skipped
    .map((skip) => `${plural(skip.count, "objeto", "objetos")} no ${skip.count === 1 ? VERBS[action].one : VERBS[action].many} (capa «${skip.layerName}» ${REASON_TEXT[skip.reason]})`)
    .join("; ");
}

function totalOf(skipped: readonly PlanSkip[]): number {
  return skipped.reduce((sum, skip) => sum + skip.count, 0);
}

/** Acumula omisiones agrupadas por (motivo, capa), en el orden en que aparecen. */
function createSkipTally() {
  const entries = new Map<string, PlanSkip>();
  return {
    add(reason: SkipReason, layerGroupId: string, layerName: string) {
      const key = `${reason}:${layerGroupId}`;
      const found = entries.get(key);
      if (found) found.count += 1;
      else entries.set(key, { reason, count: 1, layerGroupId, layerName });
    },
    list: (): PlanSkip[] => [...entries.values()],
  };
}

// ---- Portapapeles ----

/** Un objeto copiado: SIN id, con todo lo demás en copia profunda inmutable. */
export interface ClipboardItem {
  readonly layerGroupId: string;
  /** Nombre y color de la capa de origen al copiar: para informar una capa que ya no existe y para detectar que la capa cambió de color. */
  readonly layerName: string;
  readonly layerColorHex: string | null;
  readonly d: string;
  readonly fill: string;
  readonly stroke?: string;
  readonly strokeWidth?: number;
  readonly matrix: Readonly<AffineMatrix>;
  /** Esquina superior izquierda del bbox del objeto respecto de la del conjunto (unidades de documento); `null` si no dibuja nada. */
  readonly relative: Readonly<Point> | null;
}

export interface ClipboardContent {
  /** En orden de pintado del documento (el último queda arriba). */
  readonly items: readonly ClipboardItem[];
  /** Bbox del conjunto al copiar (unidades de documento), o `null` si ninguno tiene geometría. */
  readonly bounds: Readonly<Rect> | null;
}

/** Estado del portapapeles de la sesión + cuántos pegados con offset se hicieron desde la última copia. */
export interface ClipboardState {
  content: ClipboardContent | null;
  pasteCount: number;
}

export const EMPTY_CLIPBOARD: ClipboardState = { content: null, pasteCount: 0 };

/** Copiar (o cortar) reemplaza el contenido y REINICIA el contador de offset. */
export function copyToClipboard(content: ClipboardContent): ClipboardState {
  return { content, pasteCount: 0 };
}

/** Registra un pegado con offset: el siguiente se desplaza un paso más. Sin contenido no hace nada. */
export function registerPaste(state: ClipboardState): ClipboardState {
  return state.content ? { ...state, pasteCount: state.pasteCount + 1 } : state;
}

/** Offset del PRÓXIMO pegado con offset (1x justo después de copiar, 2x después del primero...). */
export function nextPasteOffset(state: ClipboardState, mmPerUnit: number | null): Point {
  return pasteOffset(state.pasteCount + 1, mmPerUnit);
}

/** Objetos del documento en orden de pintado: primero la estructura vigente (`layers`), después las capas con objetos que no estén en ella. */
export function paintOrdered(document: EditableDocument): EditorObject[] {
  const ids = (document.layers ?? []).map((layer) => layer.groupId);
  const known = new Set(ids);
  for (const groupId of Object.keys(document.objectsByLayer)) {
    if (!known.has(groupId)) ids.push(groupId);
  }
  return ids.flatMap((groupId) => document.objectsByLayer[groupId] ?? []);
}

/**
 * Copia profunda e inmutable de `selection` (los objetos se releen del `document`, que manda; los ids que ya no existen se descartan) en
 * orden de pintado. Incluye objetos de capas bloqueadas: copiar es lectura. `null` si no queda nada.
 */
export function buildClipboard(selection: readonly EditorObject[], document: EditableDocument): ClipboardContent | null {
  const wanted = new Set(selection.map((object) => object.id));
  if (wanted.size === 0) return null;
  const objects = paintOrdered(document).filter((object) => wanted.has(object.id));
  if (objects.length === 0) return null;

  const layerById = new Map((document.layers ?? []).map((layer) => [layer.groupId, layer]));
  const setBounds = bounds(objects);
  const items = objects.map((object): ClipboardItem => {
    const layer = layerById.get(object.layerGroupId);
    const box = objectBounds(object);
    const item: ClipboardItem = {
      layerGroupId: object.layerGroupId,
      layerName: layer?.name ?? "",
      layerColorHex: layer?.colorHex ?? null,
      d: object.d,
      fill: object.fill,
      ...(object.stroke !== undefined ? { stroke: object.stroke } : {}),
      ...(object.strokeWidth !== undefined ? { strokeWidth: object.strokeWidth } : {}),
      matrix: Object.freeze({ ...object.matrix }),
      relative: box && setBounds ? Object.freeze({ x: box.x - setBounds.x, y: box.y - setBounds.y }) : null,
    };
    return Object.freeze(item);
  });
  return Object.freeze({ items: Object.freeze(items), bounds: setBounds ? Object.freeze({ ...setBounds }) : null });
}

// ---- Pegar / Duplicar ----

export type PasteMode = "offset" | "in-place" | "active-layer";

export interface PasteOptions {
  mode: PasteMode;
  /** Desplazamiento en unidades de documento (`pasteOffset`). Se ignora en "in-place". */
  offset: Point;
  /** Capa activa: destino del modo "active-layer". */
  activeLayerId?: string | null;
  /** Estructura de capas vigente (default: `document.layers`). */
  layers?: readonly EditableLayerMeta[];
  /** Generador de ids (default `crypto.randomUUID`); inyectable en tests. Un id repetido se descarta y se vuelve a pedir. */
  createId?: () => string;
  /** "duplicate" solo cambia la etiqueta y los mensajes. */
  action?: "paste" | "duplicate";
}

export interface PasteSummary {
  pasted: number;
  skipped: PlanSkip[];
  /** Total de objetos omitidos. */
  skippedCount: number;
}

export interface PastePlan {
  /** `null` si no hay nada que aplicar (ver `error`). */
  production: EditProduction | null;
  summary: PasteSummary;
  /** Los objetos creados, en orden de pintado, y sus ids. */
  newObjects: EditorObject[];
  newIds: string[];
  /** Etiqueta legible del comando ("Pegar 3 objetos"). */
  label: string;
  /** Por qué no se puede aplicar, en lenguaje de usuario. */
  error: string | null;
}

function defaultCreateId(): string {
  return crypto.randomUUID();
}

/** Id nuevo que no esté en `used` (ni en el documento ni en otro pegado), aunque `createId` repita valores. */
function allocateId(createId: () => string, used: Set<string>): string {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const candidate = createId();
    if (candidate && !used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  let fallback = defaultCreateId();
  while (used.has(fallback)) fallback = defaultCreateId();
  used.add(fallback);
  return fallback;
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function pasteLabel(action: "paste" | "duplicate", mode: PasteMode, count: number, targetName: string | null): string {
  const objects = plural(count, "objeto", "objetos");
  if (action === "duplicate") return `Duplicar ${objects}`;
  if (mode === "in-place") return `Pegar ${objects} en el lugar`;
  if (mode === "active-layer" && targetName !== null) return `Pegar ${objects} en la capa «${targetName}»`;
  return `Pegar ${objects}`;
}

/**
 * Plan completo (producción + resumen + motivo de rechazo) de pegar `clipboard` en `document`. Cada objeto nuevo es una copia con id
 * nuevo y único; se agrega encima de su capa destino. Los objetos cuya capa no admite el pegado se omiten con su motivo y el resto se
 * pega en UN solo comando (`atomic`); si ninguno es pegable, no hay producción.
 */
export function planPaste(clipboard: ClipboardContent | null, document: EditableDocument, options: PasteOptions): PastePlan {
  const { mode, activeLayerId = null, createId = defaultCreateId, action = "paste" } = options;
  const layers = options.layers ?? document.layers ?? [];
  const empty = (error: string, skipped: PlanSkip[] = []): PastePlan => ({
    production: null,
    summary: { pasted: 0, skipped, skippedCount: totalOf(skipped) },
    newObjects: [],
    newIds: [],
    label: pasteLabel(action, mode, 0, null),
    error,
  });

  if (!clipboard || clipboard.items.length === 0) {
    return empty(action === "duplicate" ? "No hay objetos seleccionados para duplicar." : "El portapapeles está vacío: copiá (Ctrl/Cmd+C) o cortá (Ctrl/Cmd+X) objetos primero.");
  }

  const layerById = new Map(layers.map((layer) => [layer.groupId, layer]));
  let activeLayer: EditableLayerMeta | undefined;
  if (mode === "active-layer") {
    activeLayer = activeLayerId ? layerById.get(activeLayerId) : undefined;
    if (!activeLayer) return empty("No hay capa activa: elegí una capa en el panel de Capas para pegar en ella.");
  }

  const offset = mode === "in-place" ? { x: 0, y: 0 } : { x: finiteOrZero(options.offset.x), y: finiteOrZero(options.offset.y) };
  const used = new Set<string>(Object.values(document.objectsByLayer).flatMap((objects) => objects.map((object) => object.id)));
  const tally = createSkipTally();
  const created: EditorObject[] = [];

  for (const item of clipboard.items) {
    // Destino: la capa activa, o la de origen. Una capa que no admite el pegado omite el objeto -- nunca se reubica en silencio.
    const target = activeLayer ?? layerById.get(item.layerGroupId);
    if (!target) {
      tally.add("missing", item.layerGroupId, item.layerName);
      continue;
    }
    if (target.locked) {
      tally.add("locked", target.groupId, target.name);
      continue;
    }
    if (!target.visible) {
      tally.add("hidden", target.groupId, target.name);
      continue;
    }
    // Sin entrada de objetos = capa sin cargar (una capa cargada y vacía tiene `[]`): lo pegado se perdería cuando termine de cargar.
    if (document.objectsByLayer[target.groupId] === undefined) {
      tally.add("unloaded", target.groupId, target.name);
      continue;
    }

    let object: EditorObject = {
      id: allocateId(createId, used),
      layerGroupId: target.groupId,
      d: item.d,
      fill: item.fill,
      ...(item.stroke !== undefined ? { stroke: item.stroke } : {}),
      ...(item.strokeWidth !== undefined ? { strokeWidth: item.strokeWidth } : {}),
      matrix: { ...item.matrix },
    };
    if (offset.x !== 0 || offset.y !== 0) object = translate([object], offset.x, offset.y)[0];
    // Cambia de capa (o la capa cambió de color desde que se copió): el objeto toma el color de la capa destino.
    const recolor = target.groupId !== item.layerGroupId || (item.layerColorHex !== null && !hexEquals(item.layerColorHex, target.colorHex));
    created.push(recolor ? recolored(object, target) : object);
  }

  const skipped = tally.list();
  if (created.length === 0) {
    const reasons = describeSkipped(skipped, action);
    const hint = mode !== "active-layer" && action === "paste" ? " Usá «Pegar en la capa activa» para copiarlos a otra capa." : "";
    return empty(`${action === "duplicate" ? "No se duplicó nada" : "No se pegó nada"}: ${reasons}.${hint}`, skipped);
  }

  const layersOut: Record<string, EditorObject[]> = {};
  for (const object of created) {
    layersOut[object.layerGroupId] = [...(layersOut[object.layerGroupId] ?? document.objectsByLayer[object.layerGroupId] ?? []), object];
  }
  return {
    production: { layers: layersOut, atomic: true },
    summary: { pasted: created.length, skipped, skippedCount: totalOf(skipped) },
    newObjects: created,
    newIds: created.map((object) => object.id),
    label: pasteLabel(action, mode, created.length, activeLayer?.name ?? null),
    error: null,
  };
}

/** Duplicar = copiar la selección y pegarla de inmediato en la capa de cada objeto, desplazada `offset`, sin tocar el portapapeles. */
export function planDuplicate(
  selection: readonly EditorObject[],
  document: EditableDocument,
  options: { offset: Point; layers?: readonly EditableLayerMeta[]; createId?: () => string },
): PastePlan {
  return planPaste(buildClipboard(selection, document), document, { ...options, mode: "offset", action: "duplicate" });
}

// ---- Eliminar / Cortar ----

export interface DeletePlan {
  /** `null` si no hay nada que aplicar (ver `error`). */
  production: EditProduction | null;
  /** Los objetos que se eliminan (en orden de pintado). */
  deleted: EditorObject[];
  skipped: PlanSkip[];
  skippedCount: number;
  label: string;
  error: string | null;
}

export interface CutPlan extends DeletePlan {
  /** Lo que queda en el portapapeles si el corte se aplica: SOLO lo cortado. */
  clipboard: ClipboardContent | null;
}

function planRemoval(document: EditableDocument, ids: ReadonlySet<string>, action: "delete" | "cut", layers: readonly EditableLayerMeta[]): DeletePlan {
  const verbLabel = action === "cut" ? "Cortar" : "Eliminar";
  const noun = action === "cut" ? "cortar" : "eliminar";
  const layerById = new Map(layers.map((layer) => [layer.groupId, layer]));
  const tally = createSkipTally();
  const deleted: EditorObject[] = [];
  for (const object of paintOrdered(document)) {
    if (!ids.has(object.id)) continue;
    const layer = layerById.get(object.layerGroupId);
    // Una capa sin meta conocida no tiene bloqueo que respetar acá (applyEdit igual lo filtra con la estructura vigente).
    if (layer?.locked) tally.add("locked", layer.groupId, layer.name);
    else if (layer && !layer.visible) tally.add("hidden", layer.groupId, layer.name);
    else deleted.push(object);
  }
  const skipped = tally.list();
  const base = { deleted, skipped, skippedCount: totalOf(skipped), label: `${verbLabel} ${plural(deleted.length, "objeto", "objetos")}` };
  if (ids.size === 0) return { ...base, production: null, error: `No hay objetos seleccionados para ${noun}.` };
  if (deleted.length === 0) {
    const reasons = skipped.length > 0 ? describeSkipped(skipped, action) : "los objetos seleccionados ya no existen";
    return { ...base, production: null, error: `No se ${action === "cut" ? "cortó" : "eliminó"} nada: ${reasons}.${skipped.length > 0 ? " Desbloqueá las capas en el panel de Capas." : ""}` };
  }
  return { ...base, production: removeObjects(document, new Set(deleted.map((object) => object.id))), error: null };
}

/** Elimina la selección: lo de capas bloqueadas u ocultas se OMITE (con su motivo); si no queda nada eliminable no hay comando. */
export function planDelete(document: EditableDocument, ids: ReadonlySet<string>, options: { layers?: readonly EditableLayerMeta[] } = {}): DeletePlan {
  return planRemoval(document, ids, "delete", options.layers ?? document.layers ?? []);
}

/** Cortar = copiar lo eliminable + eliminarlo en UN comando. Lo bloqueado ni se corta ni entra al portapapeles. */
export function planCut(document: EditableDocument, ids: ReadonlySet<string>, options: { layers?: readonly EditableLayerMeta[] } = {}): CutPlan {
  const plan = planRemoval(document, ids, "cut", options.layers ?? document.layers ?? []);
  return { ...plan, clipboard: plan.production ? buildClipboard(plan.deleted, document) : null };
}
