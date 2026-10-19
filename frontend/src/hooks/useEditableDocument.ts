import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildCommand,
  checkDraft,
  COMMAND_REGISTRY,
  exportCommands,
  layerMetaDraft,
  mergeCoalesced,
  type CommandDraft,
  type CommandOrigin,
  type EditorCommand,
  type HistoryExport,
} from "../lib/editor/commands";
import { framesEqual, isValidFrame, sourceFrameOf } from "../lib/editor/frame";
import { applyLayerSnapshots, layerIdsAbsentAfter, sameLayerMeta, toLayerMetas, type LocalLayerPatch } from "../lib/editor/layers";
import { parseEditableLayerStrict, sameObjectContent } from "../lib/editor/objects";
import type { DocumentFrame, EditableDocument, EditableLayerMeta, EditorEdit, EditorLayerChange, EditorObject, EditProduction, LayerMetaChange } from "../lib/editor/types";
import type { VectorDocumentLayer } from "./useVectorDocument";

/**
 * Estado editable del documento (MVP3-S01, ADR D2): carga el SVG de cada capa
 * UNA vez (la carga que antes hacía `VectorCanvas`), la parsea a
 * `EditorObject[]` y centraliza TODA mutación geométrica en un único punto,
 * `applyEdit`, con historial undo/redo, gestos continuos y respeto de
 * locks/visibilidad. La metadata de capas (nombre, orden, visible, locked, operación)
 * sigue viviendo en `useVectorDocument` (PATCH, M2.2): este hook solo LEE
 * `locked`/`visible` de ahí.
 *
 * Limitación intermedia documentada (ADR D2/D5): hasta M3-S13 las ediciones
 * viven solo en memoria. `geometryDirty` lo refleja con honestidad.
 *
 * Marco del documento (M3-S02): además de los objetos, el hook posee el área de trabajo (`DocumentFrame`). Un
 * comando puede traer un cambio de marco OPCIONAL (`EditorEdit.frame`) que viaja junto con los objetos: crop y
 * rotar-documento son UN comando con undo/redo atómico. Los comandos de S01 no traen marco y se comportan igual.
 *
 * Estructura de capas (M3-S03): igual que el marco, un comando puede traer un cambio de estructura OPCIONAL (`EditorEdit.layers`,
 * `EditProduction.layerMetas`): crear una capa (Fill con un color nuevo) o cambiarle el color a una existente conservando su
 * `groupId`. Objetos + estructura son UN comando: undo elimina la capa creada y devuelve los objetos. El hook expone la lista
 * EFECTIVA de capas (`layers`: servidor + overrides del editor + previsualización) que consumen el canvas y los paneles; la
 * metadata de las capas del servidor sigue siendo de `useVectorDocument` (PATCH) y la de las capas `isNew` (que no existen en el
 * servidor) se edita acá, en local (`updateLocalLayer`), sin ningún request.
 *
 * Historial de comandos (M3-S12): cada entrada es `{ command, patch }`. El `command` (`EditorCommand` v1, `lib/editor/commands.ts`) describe la
 * operación sin geometría cruda; el `patch` es el `EditorEdit` de siempre (snapshots) y sigue siendo la fuente de la reversión EXACTA -- el motor
 * de snapshots no cambió. Todo call-site de `applyEdit`/`commitGesture` aporta un `CommandDraft` (tipo + parámetros + origen); los `targets` salen de
 * lo que el parche realmente cambió. Además del historial lineal (`undo`/`redo`/`jumpTo`) el hook ofrece el panel (`historyEntries`), la
 * exportación sin parches (`exportHistory`), el límite con aviso de truncado y el aviso de reinicio. La metadata de capa (renombrar, visibilidad,
 * bloqueo, operación, orden) también entra al historial como entradas SIN objetos (`EditorEdit.meta`): deshacer/rehacer las re-persisten con
 * `persistLayerMeta` (el mismo PATCH que las originó) y, si eso falla, NADA cambia -- ni el estado local ni el puntero -- y queda un error visible.
 */

export type EditableLayerStatus = "loading" | "ready" | "error";

/** Tope de comandos en la pila de undo (ADR D2): al excederlo se descarta el más viejo. */
export const MAX_UNDO_STEPS = 200;

/** Ventana en la que ediciones consecutivas con la misma `coalesceKey` (p. ej. ráfaga de flechas) se funden en un solo comando. */
export const COALESCE_WINDOW_MS = 1000;

export type EditProducer = (state: EditableDocument) => EditProduction | null;

export interface EditOptions {
  /** Ediciones consecutivas con la misma clave dentro de `COALESCE_WINDOW_MS` forman UN comando (nudge por teclado). */
  coalesceKey?: string;
}

export interface ApplyEditResult {
  /** `true` si se registró (o previsualizó) algún cambio. */
  applied: boolean;
  /**
   * Por qué no se aplicó (solo si `applied` es false): sin cambios reales, todo bloqueado/oculto, uso fuera de un gesto, o (M3-S12) un
   * deshacer/rehacer de metadata de capa en vuelo (`history_busy`: una operación a la vez).
   */
  reason?: "no_change" | "blocked" | "gesture_active" | "no_gesture" | "history_busy";
  /** Objetos que el productor quiso modificar en capas BLOQUEADAS y se omitieron. */
  skippedLockedObjects: number;
  /** Objetos que el productor quiso modificar en capas OCULTAS y se omitieron. */
  skippedHiddenObjects: number;
  /**
   * El comando registrado por `applyEdit` (M3-S06): es el MISMO objeto que luego devuelven `undo()`/`redo()`, así que quien lo guarda puede
   * asociarle datos propios (p. ej. la selección de antes y de después) y recuperarlos al deshacer/rehacer. Solo en `applyEdit`.
   * (Desde M3-S12 es el PARCHE de la entrada del historial; su descripción serializable es `command`.)
   */
  edit?: EditorEdit;
  /** El `EditorCommand` v1 registrado (M3-S12): lo que describe esta operación, sin geometría cruda. En una fusión por `coalesceKey` es el comando fundido. */
  command?: EditorCommand;
}

/** Resultado de re-persistir (o aplicar en local) un cambio de metadata de capa al deshacer/rehacer. `noop`: el valor ya era el pedido. */
export type PersistResult = { ok: true; noop?: boolean } | { ok: false; error: string };

/**
 * Persiste un cambio de metadata de capa en la dirección pedida (`"undo"` -> deja el valor `before`, `"redo"` -> el `after`; también se usa para el
 * cambio ORIGINAL, que es un `"redo"`). Para una capa del servidor es el mismo PATCH que originó el cambio; para una capa `isNew` es solo local.
 * Nunca debe lanzar: ante un fallo devuelve `{ ok: false, error }`.
 */
export type PersistLayerMeta = (change: LayerMetaChange, direction: "undo" | "redo", mode: PersistMode) => Promise<PersistResult>;

/**
 * `optimistic: true` = el cambio ORIGINAL del usuario (la UI responde de inmediato y se revierte si el servidor falla, como desde M2.1). `false` = deshacer/rehacer:
 * no se toca nada local hasta que el servidor confirma, así un PATCH inverso que falla deja el estado intacto sin rollback.
 */
export interface PersistMode {
  optimistic: boolean;
}

export interface UseEditableDocumentOptions {
  /** Visibilidad EFECTIVA por groupId (con Isolate aplicado, ver `useVectorDocument.visibility`); default: `layer.visible`. */
  visibility?: Record<string, boolean>;
  /**
   * Capa aislada (Isolate, M3-S03): el overlay manda sobre TODAS las capas, también las creadas en el cliente (que `visibility`, derivada
   * de las capas del servidor, no conoce). Sin Isolate: null/ausente.
   */
  isolatedGroupId?: string | null;
  /** Límite de la pila de undo (default 200). */
  limit?: number;
  /** Generador de ids para paths sin `data-vid` (default `crypto.randomUUID`); inyectable en tests. */
  createId?: () => string;
  /** Tamaño original del documento (viewBox, M3-S02): el marco inicial es `0 0 ancho alto`. Sin él (0 × 0) el marco no es utilizable. */
  sourceSize?: { width: number; height: number };
  /** Reloj del historial (M3-S12): `timestamp` de los comandos y ventana de fusión (default `Date.now`); inyectable en tests. */
  clock?: () => number;
  /** Generador de ids de comando (M3-S12; default `crypto.randomUUID`); inyectable en tests. */
  createCommandId?: () => string;
  /** Re-persiste la metadata de capa al deshacer/rehacer (M3-S12). Sin esto, los cambios de metadata no se pueden registrar. */
  persistLayerMeta?: PersistLayerMeta;
  /**
   * Identidad del documento abierto (M3-S12): si cambia, el estado editable y el historial se reinician con aviso (un historial de otro documento
   * no tiene sentido). Distinto de un `svgUrl` regenerado, que ya reiniciaba el historial desde S01.
   */
  documentKey?: string;
}

/** Entrada del historial para el panel: el comando y si está aplicado (`true`) o en la rama de rehacer (`false`). */
export interface HistoryEntryView {
  command: EditorCommand;
  applied: boolean;
}

export interface HistoryNotice {
  /** `truncated`: el límite descartó las acciones más viejas. `reset`: el documento se regeneró o cambió y el historial empezó de cero. */
  kind: "truncated" | "reset";
  message: string;
}

export interface JumpResult {
  ok: boolean;
  /** Pasos efectivamente dados (puede ser menor que el pedido si un paso de metadata falló). */
  steps: number;
  direction: "undo" | "redo" | null;
  /** Parches aplicados, en orden (el último manda para restaurar la selección o re-centrar la vista). */
  edits: EditorEdit[];
  error: string | null;
}

export interface LayerMetaCommitResult {
  /** `ok`: persistido y registrado. `noop`: ya tenía ese valor (nada que registrar). `busy`: hay otra operación del historial en curso. `failed`: no se persistió (nada cambió). */
  status: "ok" | "noop" | "busy" | "failed";
  error?: string;
  command?: EditorCommand;
}

export interface EditableDocumentApi {
  /** Objetos por capa EN VIVO: incluye la previsualización de un gesto en curso. */
  objectsByLayer: Record<string, EditorObject[]>;
  layerStatus: Record<string, EditableLayerStatus>;
  /** Alguna capa todavía está cargando. */
  isLoading: boolean;
  /** Reintenta las capas que fallaron. */
  retry: () => void;

  /**
   * Capas EFECTIVAS EN VIVO (M3-S03), por orden de pintado: las del servidor (con el color que les dejó un recoloreo) + las creadas en
   * el cliente (`isNew`) + la previsualización de un gesto en curso. `pathCount` refleja los objetos reales de las capas editadas.
   */
  layers: VectorDocumentLayer[];
  /** Igual que `layers` pero SIN la previsualización de un gesto (base de resúmenes y de las listas que no deben moverse mientras se previsualiza). */
  committedLayers: VectorDocumentLayer[];
  /** Visibilidad EFECTIVA por groupId para TODAS las capas (servidor + creadas en el cliente), con Isolate aplicado. */
  visibility: Record<string, boolean>;
  /**
   * Edita la metadata de una capa `isNew` en local (nombre, visibilidad, bloqueo, orden, operación): no existe en el servidor, así que
   * NO hay PATCH. `false` si la capa no existe o es del servidor (esas siguen yendo por `useVectorDocument`/PATCH). No registra nada en el
   * historial por sí sola (M3-S12: el historial lo registra `commitLayerMeta`, que la llama a través de `persistLayerMeta`).
   */
  updateLocalLayer: (groupId: string, patch: LocalLayerPatch) => boolean;

  /** ÚNICO punto de mutación geométrica (ADR D2): ver `EditProducer`. Desde M3-S12 el primer argumento describe el comando (tipo + parámetros + origen). */
  applyEdit: (draft: CommandDraft, producer: EditProducer, options?: EditOptions) => ApplyEditResult;
  undo: () => EditorEdit | null;
  redo: () => EditorEdit | null;
  canUndo: boolean;
  canRedo: boolean;
  /** Etiqueta del próximo undo/redo (para `aria-label`/tooltips), o null. */
  undoLabel: string | null;
  redoLabel: string | null;
  /** Comandos en la pila de undo (útil para verificar que un gesto NO la llena). */
  undoDepth: number;

  /** Gestos continuos (drag/scale/rotate): UN comando al soltar, nada en la pila durante el gesto. */
  beginGesture: () => boolean;
  previewEdit: (producer: EditProducer) => ApplyEditResult;
  commitGesture: (draft: CommandDraft) => ApplyEditResult;
  cancelGesture: () => void;
  gestureActive: boolean;

  /**
   * Hay ediciones de geometría sin persistir (ADR D2): alguna capa, el marco o la estructura de capas difieren de lo último que el
   * servidor confirmó (`markSaved`) o, si nunca se guardó en esta sesión, de lo cargado.
   */
  geometryDirty: boolean;
  /** Foto del estado confirmado RENDERIZADO ahora (consistente con `committedObjectsByLayer`/`committedFrame`/`committedLayers`): lo que se serializa al guardar. */
  saveMark: GeometrySaveMark;
  /** Declara persistido lo que describe `mark` (M3-S13). No toca el historial; lo editado después de `mark` sigue contando como sin guardar. Ignora marcas de un documento ya reiniciado. */
  markSaved: (mark: GeometrySaveMark) => void;
  /** Área de trabajo EN VIVO (M3-S02): incluye la previsualización de un gesto en curso (p. ej. rotar el documento). */
  frame: DocumentFrame;
  /** Área de trabajo CONFIRMADA (sin previsualización): base de miniatura, mm y zoom de ajuste. */
  committedFrame: DocumentFrame;
  /** Snapshot SÍNCRONO del estado confirmado (sin previsualización), para handlers de eventos. */
  getSnapshot: () => EditableDocument;
  /** Estado CONFIRMADO por capa (sin la previsualización de un gesto en curso), reactivo: base de miniaturas/serialización. */
  committedObjectsByLayer: Record<string, EditorObject[]>;
  /** Capas cuya geometría hoy difiere de la cargada (se calcula por referencia: deshacer hasta el origen la saca del conjunto). */
  editedLayerIds: ReadonlySet<string>;

  // ---- Historial de comandos (M3-S12) ----

  /** Comandos aplicados y rehacibles, en orden cronológico (los rehacibles van después de los aplicados). */
  historyEntries: HistoryEntryView[];
  /** Cuántos comandos están aplicados: el puntero del historial (0 = estado inicial). */
  historyPosition: number;
  /** El comando que deshará / rehará el próximo undo / redo, o null. */
  undoCommand: EditorCommand | null;
  redoCommand: EditorCommand | null;
  /**
   * Va a la posición posterior a la entrada `entryId` (o al estado inicial con `null`): deshace/rehace varios pasos de una vez. Los pasos de
   * geometría son síncronos y atómicos para la UI; si cruzan metadata de capa esperan su PATCH y se detienen en el primer fallo (el puntero
   * queda donde llegó, con el error visible).
   */
  jumpTo: (entryId: string | null) => Promise<JumpResult>;
  /** Descarta todo el historial sin tocar el documento. */
  clearHistory: () => void;
  /** Los comandos del historial (JSON puro), sin parches ni SVG. */
  exportHistory: () => HistoryExport;
  /** Hay un cambio de metadata de capa en vuelo (el original o su deshacer/rehacer): undo/redo quedan deshabilitados. */
  historyBusy: boolean;
  /** Último fallo de un cambio de metadata o de su deshacer/rehacer; el estado local NO cambió. */
  historyError: string | null;
  dismissHistoryError: () => void;
  /** Avisos visibles del historial (truncado por el límite, reinicio por documento regenerado/cambiado). */
  historyNotices: HistoryNotice[];
  dismissHistoryNotice: (kind: HistoryNotice["kind"]) => void;
  /** Límite vigente de la pila de undo. */
  historyLimit: number;
  /**
   * Cambia la metadata de una capa y, si se persistió, la registra en el historial (un comando sin objetos). Usa `persistLayerMeta`: para una capa del
   * servidor es el PATCH de siempre; el historial NO registra nada si falla.
   */
  commitLayerMeta: (change: LayerMetaChange, origin?: CommandOrigin) => Promise<LayerMetaCommitResult>;
  /** Registra un cambio de metadata YA aplicado (sin persistir nada). Lo usa `commitLayerMeta`; útil para integraciones y pruebas. */
  recordLayerMeta: (change: LayerMetaChange, origin?: CommandOrigin) => EditorCommand;
}

export interface HistoryEntry {
  command: EditorCommand;
  patch: EditorEdit;
  coalesceKey?: string;
  at: number;
}

interface CommittedState {
  objectsByLayer: Record<string, EditorObject[]>;
  /**
   * Objetos de cada capa tal como se CARGARON. Una capa está "editada" si su array de hoy no es (por referencia) el cargado:
   * deshacer hasta el origen restaura los snapshots por referencia, así que vuelve a coincidir -- y el límite de la pila de
   * undo no puede hacer olvidar que hay cambios sin persistir (a diferencia de contar comandos).
   */
  baseline: Record<string, EditorObject[]>;
  /** Marco confirmado, o `null` = el marco original del documento (`sourceFrame`): así un documento sin ediciones de marco no depende de cuándo se midió. */
  frame: DocumentFrame | null;
  /**
   * Meta de las capas TOCADAS por comandos (M3-S03): capas creadas en el cliente (`isNew`) y capas del servidor con otro color. Vacío =
   * la estructura es la del servidor (por eso "hay cambios de estructura" es simplemente "no está vacío").
   */
  layerOverrides: Record<string, EditableLayerMeta>;
  /** Metadata editada EN LOCAL de las capas `isNew` (sin PATCH). Desde M3-S12 sus cambios entran al historial (`commitLayerMeta`), así que un undo/redo los revierte/reaplica. */
  localLayers: Record<string, LocalLayerPatch>;
  past: HistoryEntry[];
  future: HistoryEntry[];
  /** Se incrementa cada vez que el documento se reinicia (otro documento / regenerado): invalida marcas de guardado anteriores. */
  epoch: number;
  /** Lo último que el servidor confirmó haber persistido (M3-S13). Ausente = nada guardado todavía: se compara contra lo cargado. */
  saved?: GeometrySaveMark;
}

/**
 * Foto del estado confirmado en el instante de serializar para un guardado (M3-S13). Se entrega a `markSaved` al confirmarse el
 * guardado: lo editado ENTRE el envío y la confirmación sigue contando como sin guardar.
 */
export interface GeometrySaveMark {
  epoch: number;
  objectsByLayer: Record<string, EditorObject[]>;
  /** Marco confirmado, o `null` = el original del documento. */
  frame: DocumentFrame | null;
  /** Huella estable de la estructura de capas (overrides + metadata local). */
  structureKey: string;
}

interface LoadResult {
  status: "ready" | "error";
  url: string;
  /** Intento de carga (`retryNonce`) en el que se obtuvo: un error de un intento anterior se considera "cargando" de nuevo. */
  attempt: number;
}

interface GestureState {
  base: Record<string, EditorObject[]>;
  /** Marco vigente al empezar el gesto: la previsualización siempre parte de él (nunca del frame anterior). */
  baseFrame: DocumentFrame;
  /** Capas tocadas por la última previsualización (lista completa ya modificada). */
  after: Record<string, EditorObject[]>;
  /** Marco de la última previsualización, o `null` si no cambia el marco. */
  afterFrame: DocumentFrame | null;
  /** Estructura de capas al empezar el gesto / tras la última previsualización (capas tocadas). */
  baseMetas: EditableLayerMeta[];
  afterMetas: EditableLayerMeta[];
  skippedLockedObjects: number;
  skippedHiddenObjects: number;
}

const EMPTY_STATE: CommittedState = { objectsByLayer: {}, baseline: {}, frame: null, layerOverrides: {}, localLayers: {}, past: [], future: [], epoch: 0 };

/** Huella estable (claves ordenadas) de la estructura de capas: dos estados con la misma estructura dan la misma huella. */
function structureKeyOf(layerOverrides: Record<string, EditableLayerMeta>, localLayers: Record<string, LocalLayerPatch>): string {
  const sorted = (record: Record<string, unknown>) => Object.keys(record).sort().map((key) => [key, record[key]]);
  return JSON.stringify([sorted(layerOverrides), sorted(localLayers)]);
}

/** Visibilidad EFECTIVA de una capa: Isolate manda sobre todas (también las creadas en el cliente); si no, `visibility` del servidor o su propio `visible`. */
function effectiveVisible(layer: { groupId: string; visible: boolean }, visibility: Record<string, boolean> | undefined, isolatedGroupId: string | null | undefined): boolean {
  if (isolatedGroupId) return layer.groupId === isolatedGroupId;
  return visibility?.[layer.groupId] ?? layer.visible;
}

/**
 * Lista efectiva de capas: las del servidor (con el color override de un recoloreo; el resto de su metadata es del servidor), más las
 * creadas en el cliente (con su metadata local), por orden de pintado. `counts` = objetos reales de las capas editadas (para `pathCount`).
 */
function composeLayers(
  server: readonly VectorDocumentLayer[],
  overrides: Record<string, EditableLayerMeta>,
  local: Record<string, LocalLayerPatch>,
  counts: Record<string, number>,
): VectorDocumentLayer[] {
  const serverIds = new Set(server.map((layer) => layer.groupId));
  const result: VectorDocumentLayer[] = server.map((layer) => {
    const override = overrides[layer.groupId];
    const count = counts[layer.groupId];
    if (!override && count === undefined) return layer;
    return {
      ...layer,
      ...(override ? { colorHex: override.colorHex, fill: override.colorHex } : {}),
      ...(count !== undefined ? { pathCount: count } : {}),
    };
  });
  for (const override of Object.values(overrides)) {
    if (!override.isNew || serverIds.has(override.groupId)) continue;
    const patch = local[override.groupId];
    result.push({
      groupId: override.groupId,
      name: patch?.name ?? override.name,
      colorHex: override.colorHex,
      fill: override.colorHex,
      // Sin vector ni SVG en el servidor (se persisten con M3-S13): nada que cargar ni que pedirle al Laser Checker.
      vectorId: "",
      svgUrl: "",
      pathCount: counts[override.groupId] ?? 0,
      componentCount: null,
      manufacturingOperation: patch?.manufacturingOperation ?? override.manufacturingOperation,
      order: patch?.order ?? override.order,
      visible: patch?.visible ?? override.visible,
      locked: patch?.locked ?? override.locked,
      areaPercent: 0,
      hasPartialAlpha: false,
      isExcluded: false,
      isNew: true,
    });
  }
  // Orden estable: las capas del servidor ya vienen ordenadas y las nuevas se intercalan por su `order`.
  return result.sort((a, b) => a.order - b.order);
}

/** Cuántos objetos tiene cada capa EDITADA (su array difiere del cargado): solo esas pisan el `pathCount` del servidor. Serializado para memoizar por valor. */
function editedCountsKey(objectsByLayer: Record<string, EditorObject[]>, baseline: Record<string, EditorObject[]>): string {
  const counts: Record<string, number> = {};
  for (const [groupId, objects] of Object.entries(objectsByLayer)) {
    if (baseline[groupId] !== objects) counts[groupId] = objects.length;
  }
  return JSON.stringify(counts);
}

/**
 * Une el cambio de marco de un comando con el del siguiente al fundirlos (nudge): `before` del primero que lo traiga,
 * `after` del último. `undefined` si ninguno cambia el marco (el caso de S01).
 */
function mergeFrameChange(previous: EditorEdit["frame"], next: EditorEdit["frame"]): EditorEdit["frame"] {
  if (!previous) return next;
  if (!next) return previous;
  return { before: previous.before, after: next.after };
}

function sameList(left: readonly EditorObject[], right: readonly EditorObject[]): boolean {
  return left.length === right.length && left.every((object, index) => object === right[index]);
}

/** Mismas capas de objetos por CONTENIDO (id, geometría, fill, matriz), aunque sean otras referencias. */
function sameListContent(left: readonly EditorObject[], right: readonly EditorObject[]): boolean {
  return left.length === right.length && left.every((object, index) => object.id === right[index].id && sameObjectContent(object, right[index]));
}

/** Cuántos objetos distintos hay entre dos versiones de una capa (agregados + quitados + modificados; un simple reordenamiento cuenta 1). */
export function countChangedObjects(before: readonly EditorObject[], after: readonly EditorObject[]): number {
  const remaining = new Map(before.map((object) => [object.id, object]));
  let changed = 0;
  for (const object of after) {
    const previous = remaining.get(object.id);
    if (!previous || (previous !== object && !sameObjectContent(previous, object))) changed += 1;
    remaining.delete(object.id);
  }
  changed += remaining.size;
  // Un simple reordenamiento (mismos objetos, otro orden de pintado) también es un cambio.
  const sameOrder = before.length === after.length && before.every((object, index) => object.id === after[index].id);
  return changed === 0 && !sameOrder ? 1 : changed;
}

/** Arma el comando de una producción ya filtrada (sin la clave `frame` si no cambia el marco: los comandos de S01 quedan idénticos). */
function buildEdit(
  label: string,
  base: Record<string, EditorObject[]>,
  baseFrame: DocumentFrame,
  after: Record<string, EditorObject[]>,
  afterFrame: DocumentFrame | null,
  baseMetas: readonly EditableLayerMeta[] = [],
  afterMetas: readonly EditableLayerMeta[] = [],
): EditorEdit {
  const touched: Record<string, EditorLayerChange> = {};
  for (const layerId of Object.keys(after)) touched[layerId] = { before: base[layerId] ?? [], after: after[layerId] };
  const edit: EditorEdit = { label, touched };
  if (afterFrame) edit.frame = { before: baseFrame, after: afterFrame };
  if (afterMetas.length > 0) {
    // Una capa creada por el comando no está en `before` (undo la elimina); una recoloreada está en ambos lados con el mismo groupId.
    const before = afterMetas.flatMap((meta) => baseMetas.find((candidate) => candidate.groupId === meta.groupId) ?? []);
    edit.layers = { before, after: [...afterMetas] };
  }
  return edit;
}

/** Etiqueta final de un borrador: la del call-site o la por defecto del registro. */
function draftLabel(draft: CommandDraft): string {
  return draft.label?.trim() || COMMAND_REGISTRY[draft.type].label;
}

/**
 * Mueve UNA entrada del historial entre `past` y `future` aplicando su parche: `undo` restaura `before` y `redo` `after` (objetos, marco y estructura de
 * capas, atómico). Sin filtro de bloqueo: undo/redo son la historia del usuario y bloquear una capa después de editarla no debe trabarlo (IMPL de M3-S01).
 * Una entrada de metadata no toca objetos: su parte asíncrona la resuelve quien llama ANTES de mover el puntero.
 */
function moveEntry(state: CommittedState, direction: "undo" | "redo", serverColorOf: (groupId: string) => string | undefined): CommittedState {
  const entry = direction === "undo" ? state.past[state.past.length - 1] : state.future[state.future.length - 1];
  if (!entry) return state;
  const edit = entry.patch;
  const objectsByLayer = { ...state.objectsByLayer };
  // Las capas que el comando CREÓ desaparecen con él (al deshacer) o reaparecen (al rehacer): una capa eliminada no deja una entrada de objetos fantasma.
  const removed = edit.layers ? layerIdsAbsentAfter(edit.layers, direction) : [];
  for (const [layerId, change] of Object.entries(edit.touched)) {
    if (removed.includes(layerId)) delete objectsByLayer[layerId];
    else objectsByLayer[layerId] = direction === "undo" ? change.before : change.after;
  }
  // El marco y la estructura de capas vuelven junto con los objetos (atómico): un undo/redo no deja nada a medias.
  const layerOverrides = edit.layers ? applyLayerSnapshots(state.layerOverrides, direction === "undo" ? edit.layers.before : edit.layers.after, removed, serverColorOf) : state.layerOverrides;
  const frame = edit.frame ? (direction === "undo" ? edit.frame.before : edit.frame.after) : state.frame;
  return direction === "undo"
    ? { ...state, objectsByLayer, layerOverrides, frame, past: state.past.slice(0, -1), future: [...state.future, entry] }
    : { ...state, objectsByLayer, layerOverrides, frame, past: [...state.past, entry], future: state.future.slice(0, -1) };
}

function defaultCommandId(): string {
  return crypto.randomUUID();
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "No se pudo completar el cambio de la capa.";
}

type StepOutcome =
  | { kind: "none" }
  | { kind: "sync"; edit: EditorEdit }
  | { kind: "async"; promise: Promise<{ ok: true; edit: EditorEdit } | { ok: false; error: string }> };

export function useEditableDocument(layers: VectorDocumentLayer[], options: UseEditableDocumentOptions = {}): EditableDocumentApi {
  const { visibility, isolatedGroupId = null, limit = MAX_UNDO_STEPS, createId, clock, createCommandId, persistLayerMeta, documentKey } = options;
  const sourceWidth = options.sourceSize?.width ?? 0;
  const sourceHeight = options.sourceSize?.height ?? 0;
  // Marco original del documento: referencia estable mientras no cambie el tamaño medido.
  const sourceFrame = useMemo(() => sourceFrameOf(sourceWidth, sourceHeight), [sourceWidth, sourceHeight]);

  const [committed, setCommitted] = useState<CommittedState>(EMPTY_STATE);
  const committedRef = useRef<CommittedState>(EMPTY_STATE);
  const [results, setResults] = useState<Record<string, LoadResult>>({});
  const [gestureView, setGestureView] = useState<Record<string, EditorObject[]> | null>(null);
  const [gestureFrame, setGestureFrame] = useState<DocumentFrame | null>(null);
  const [gestureOverrides, setGestureOverrides] = useState<Record<string, EditableLayerMeta> | null>(null);
  const [gestureActive, setGestureActive] = useState(false);
  const gestureRef = useRef<GestureState | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  // Historial (M3-S12): contador de secuencia monótono de la sesión, operaciones de metadata en vuelo y avisos.
  const sequenceRef = useRef(0);
  const stepBusyRef = useRef(false);
  const pendingMetaRef = useRef(0);
  const [pendingMeta, setPendingMeta] = useState(0);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [truncatedCount, setTruncatedCount] = useState(0);
  const [resetNotice, setResetNotice] = useState<{ reason: "regenerated" | "document"; discarded: number; hadEdits: boolean } | null>(null);
  const [dismissedNotices, setDismissedNotices] = useState<ReadonlySet<HistoryNotice["kind"]>>(new Set());

  // Último valor de layers/visibility/límite en refs (patrón "latest ref" de useWorkspaceSave): los
  // handlers de abajo son ESTABLES pero siempre leen lo vigente al momento de la edición.
  const latestRef = useRef({ layers, visibility, isolatedGroupId, limit, createId, sourceFrame, clock, createCommandId, persistLayerMeta });
  useEffect(() => {
    latestRef.current = { layers, visibility, isolatedGroupId, limit, createId, sourceFrame, clock, createCommandId, persistLayerMeta };
  });

  /** Marco confirmado del estado `state` (sin override = el original). */
  const frameOf = useCallback((state: CommittedState): DocumentFrame => state.frame ?? latestRef.current.sourceFrame, []);

  /** Color que tiene en el SERVIDOR una capa (para saber cuándo un override vuelve a coincidir con él y deja de serlo). */
  const serverColorOf = useCallback((groupId: string) => latestRef.current.layers.find((layer) => layer.groupId === groupId)?.colorHex, []);

  /**
   * Estructura EFECTIVA ahora mismo (lo que ven los productores y el filtro de bloqueo): capas del servidor + overrides confirmados +
   * capas nuevas, con la visibilidad efectiva (Isolate). Se lee de refs -- así un comando ve SIEMPRE lo vigente, no el último render.
   */
  const layersNow = useCallback((): EditableLayerMeta[] => {
    const { layers: server, visibility: currentVisibility, isolatedGroupId: isolated } = latestRef.current;
    const state = committedRef.current;
    return toLayerMetas(composeLayers(server, state.layerOverrides, state.localLayers, {}), (layer) => effectiveVisible(layer, currentVisibility, isolated));
  }, []);

  // groupId -> url ya cargada con éxito. Solo se marca al terminar: así el doble efecto de
  // StrictMode (efecto -> cleanup/abort -> efecto) reinicia las cargas abortadas en vez de darlas por hechas.
  const loadedUrlsRef = useRef<Map<string, string>>(new Map());

  const commit = useCallback((next: CommittedState) => {
    committedRef.current = next;
    setCommitted(next);
  }, []);

  /** Aviso de reinicio del historial (documento regenerado o cambiado). Solo si había algo que perder. */
  const noteReset = useCallback((reason: "regenerated" | "document", state: CommittedState) => {
    const discarded = state.past.length + state.future.length;
    const hadEdits = Object.entries(state.objectsByLayer).some(([groupId, objects]) => state.baseline[groupId] !== objects) || state.frame !== null || Object.keys(state.layerOverrides).length > 0;
    if (discarded === 0 && !hadEdits) return;
    setResetNotice({ reason, discarded, hadEdits });
    setDismissedNotices((current) => (current.has("reset") ? new Set([...current].filter((kind) => kind !== "reset")) : current));
  }, []);

  // El documento abierto cambió (otro proyecto/imagen/paleta): se parte de cero con aviso. Va ANTES del efecto de carga para que éste lo vea limpio.
  const documentKeyRef = useRef(documentKey);
  useEffect(() => {
    if (documentKeyRef.current === documentKey) return;
    documentKeyRef.current = documentKey;
    loadedUrlsRef.current.clear();
    noteReset("document", committedRef.current);
    commit({ ...EMPTY_STATE, epoch: committedRef.current.epoch + 1 });
    setResults({});
    setTruncatedCount(0);
    setHistoryError(null);
  }, [documentKey, commit, noteReset]);

  // ---- Carga ----
  const sourcesKey = JSON.stringify(layers.map((layer) => [layer.groupId, layer.svgUrl, layer.colorHex]));

  useEffect(() => {
    const sources = JSON.parse(sourcesKey) as Array<[string, string, string]>;
    const controller = new AbortController();
    const { signal } = controller;

    for (const [groupId, svgUrl, colorHex] of sources) {
      const previousUrl = loadedUrlsRef.current.get(groupId);
      if (previousUrl === svgUrl) continue;

      const finish = (objects: EditorObject[]) => {
        if (signal.aborted) return;
        loadedUrlsRef.current.set(groupId, svgUrl);
        const current = committedRef.current;
        const loaded = { objectsByLayer: { ...current.objectsByLayer, [groupId]: objects }, baseline: { ...current.baseline, [groupId]: objects } };
        // Si una capa YA cargada cambia de svgUrl (el documento se regeneró por debajo), los comandos del
        // historial dejan de ser coherentes con la nueva geometría: se reinicia el historial (con aviso, M3-S12).
        // El marco también vuelve al original: un recorte hecho sobre la geometría anterior ya no describe este documento.
        // Y la estructura de capas (M3-S03): las capas creadas en el cliente y los colores recoloreados describían la geometría anterior. Como
        // un comando de estructura mueve objetos ENTRE capas (y la capa regenerada vuelve a traer los suyos), conservar a medias las ediciones
        // de las otras capas dejaría objetos duplicados o huérfanos: se descartan TODAS las ediciones sin guardar y cada capa vuelve a lo cargado.
        if (previousUrl !== undefined) {
          noteReset("regenerated", current);
          setTruncatedCount(0);
          commit({ objectsByLayer: loaded.baseline, baseline: loaded.baseline, frame: null, layerOverrides: {}, localLayers: {}, past: [], future: [], epoch: current.epoch + 1 });
        } else {
          commit({ ...current, ...loaded });
        }
        setResults((all) => ({ ...all, [groupId]: { status: "ready", url: svgUrl, attempt: retryNonce } }));
      };
      const fail = () => {
        if (signal.aborted) return;
        setResults((all) => ({ ...all, [groupId]: { status: "error", url: svgUrl, attempt: retryNonce } }));
      };

      if (!svgUrl) {
        // Capa sin SVG asociado (documento guardado sin asset): nada que cargar, nada que editar.
        finish([]);
        continue;
      }

      // credentials: "include" (M3.1-S09): el SVG de la capa está detrás de la cookie de sesión de la Web API (otro origen en desarrollo); sin ella el editor no cargaría las capas en modo Authenticated.
      fetch(svgUrl, { signal, credentials: "include" })
        .then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.text();
        })
        .then((text) => {
          if (signal.aborted) return;
          const objects = parseEditableLayerStrict(text, groupId, colorHex, latestRef.current.createId);
          if (objects === null) fail();
          else finish(objects);
        })
        .catch(fail);
    }

    return () => controller.abort();
    // `documentKey`: al cambiar de documento se vuelve a cargar todo desde cero (el efecto de arriba ya vació lo cargado).
  }, [sourcesKey, retryNonce, commit, noteReset, documentKey]);

  // Estado de carga DERIVADO (sin setState síncrono en el efecto): una capa sin resultado para su url actual está cargando.
  const layerStatus = useMemo(() => {
    const status: Record<string, EditableLayerStatus> = {};
    for (const layer of layers) {
      const result = results[layer.groupId];
      const current = result !== undefined && result.url === layer.svgUrl && (result.status === "ready" || result.attempt === retryNonce);
      status[layer.groupId] = current ? result.status : "loading";
    }
    // Las capas creadas en el cliente no se cargan de ningún lado: sus objetos ya están en memoria.
    for (const override of Object.values(committed.layerOverrides)) {
      if (override.isNew && status[override.groupId] === undefined) status[override.groupId] = "ready";
    }
    return status;
  }, [layers, results, retryNonce, committed.layerOverrides]);

  const retry = useCallback(() => setRetryNonce((nonce) => nonce + 1), []);

  // ---- Filtro de bloqueo / visibilidad ----
  const filterProduction = useCallback(
    (base: Record<string, EditorObject[]>, baseFrame: DocumentFrame, production: EditProduction | null, metas: readonly EditableLayerMeta[]) => {
      const metaById = new Map(metas.map((meta) => [meta.groupId, meta]));
      const after: Record<string, EditorObject[]> = {};
      const afterMetas: EditableLayerMeta[] = [];
      let skippedLockedObjects = 0;
      let skippedHiddenObjects = 0;
      const documentWide = production?.documentWide === true;
      const rejected = { after: {} as Record<string, EditorObject[]>, afterFrame: null, afterMetas: [] as EditableLayerMeta[] };

      // Un marco inválido (NaN, tamaño 0...) es un error del productor: se rechaza TODA la producción, no solo el marco.
      if (production?.frame && !isValidFrame(production.frame)) return { ...rejected, skippedLockedObjects, skippedHiddenObjects };

      // Capas omitidas por bloqueo/visibilidad: una capa cuenta una sola vez aunque cambien sus objetos Y su estructura.
      const skippedLayerIds = new Set<string>();
      for (const [layerId, nextObjects] of Object.entries(production?.layers ?? {})) {
        const previousObjects = base[layerId] ?? [];
        if (sameList(previousObjects, nextObjects)) continue;

        const meta = metaById.get(layerId);
        if (meta?.locked) {
          skippedLockedObjects += countChangedObjects(previousObjects, nextObjects);
          skippedLayerIds.add(layerId);
          continue;
        }
        // Documento completo: una capa oculta es parte del documento (ocultar es de vista) y se transforma igual.
        if (!documentWide && meta && !meta.visible) {
          skippedHiddenObjects += countChangedObjects(previousObjects, nextObjects);
          skippedLayerIds.add(layerId);
          continue;
        }
        after[layerId] = nextObjects;
      }

      // Estructura de capas (M3-S03): misma regla que los objetos. Una capa del servidor bloqueada/oculta no cambia de color; las capas
      // que el comando crea todavía no existen en `metaById` y pasan. Un cambio que no cambia nada se descarta (no es un comando vacío).
      for (const next of production?.layerMetas ?? []) {
        const current = metaById.get(next.groupId);
        if (current && (current.locked || (!documentWide && !current.visible))) {
          if (!skippedLayerIds.has(next.groupId)) {
            if (current.locked) skippedLockedObjects += 1;
            else skippedHiddenObjects += 1;
            skippedLayerIds.add(next.groupId);
          }
          continue;
        }
        if (current && sameLayerMeta(current, next)) continue;
        afterMetas.push(next);
      }

      // Documento completo con alguna capa bloqueada: se rechaza TODO (objetos y marco) -- nunca se transforma a medias.
      if (documentWide && skippedLockedObjects > 0) return { ...rejected, skippedLockedObjects, skippedHiddenObjects };
      // Movimiento entre capas (Fill/Recolor): quitar de una capa sin agregar en la otra perdería objetos -- todo o nada.
      if (production?.atomic && skippedLockedObjects + skippedHiddenObjects > 0) return { ...rejected, skippedLockedObjects, skippedHiddenObjects };

      const afterFrame = production?.frame && !framesEqual(production.frame, baseFrame) ? production.frame : null;
      return { after, afterFrame, afterMetas, skippedLockedObjects, skippedHiddenObjects };
    },
    [],
  );

  /** Metadatos de un comando NUEVO (id, secuencia, hora). La secuencia solo avanza al registrar de verdad: una fusión no consume ninguna. */
  const nextMeta = useCallback((now: number) => ({ id: (latestRef.current.createCommandId ?? defaultCommandId)(), sequence: ++sequenceRef.current, timestamp: now }), []);

  /**
   * Registra un comando en el historial: `edit` es el parche (snapshots), `draft` su descripción declarativa. Una acción nueva descarta la rama de rehacer.
   * Devuelve el comando que queda al tope (el fundido si hubo fusión) o `null` si la fusión resultó un no-op y se descartó.
   */
  const pushEdit = useCallback(
    (edit: EditorEdit, draft: CommandDraft, editOptions?: EditOptions): EditorCommand | null => {
      const state = committedRef.current;
      const now = (latestRef.current.clock ?? Date.now)();
      const past = [...state.past];
      const last = past[past.length - 1];
      // Capas que quedan con el estado "antes" (solo cambia si un comando fundido resulta no-op).
      let restoreBefore: Record<string, EditorObject[]> | null = null;
      let restoreFrameBefore: DocumentFrame | null = null;
      let recorded: EditorCommand | null;

      // Un comando que cambia la estructura de capas nunca se funde con otro (crear/recolorear una capa es un paso propio del historial).
      const canCoalesce =
        Boolean(editOptions?.coalesceKey) &&
        last?.coalesceKey === editOptions?.coalesceKey &&
        now - (last?.at ?? 0) <= COALESCE_WINDOW_MS &&
        !edit.layers &&
        !last?.patch.layers &&
        last?.command.type === draft.type;
      if (editOptions?.coalesceKey && last && canCoalesce) {
        const merged: Record<string, EditorLayerChange> = { ...last.patch.touched };
        for (const [layerId, change] of Object.entries(edit.touched)) {
          merged[layerId] = merged[layerId] ? { before: merged[layerId].before, after: change.after } : change;
        }
        const mergedFrame = mergeFrameChange(last.patch.frame, edit.frame);
        // Si el comando fundido queda en no-op se descarta del todo (ir y volver con flechas no deja basura) y la
        // geometría vuelve EXACTAMENTE a los snapshots originales.
        const isNoop = Object.values(merged).every((change) => sameListContent(change.before, change.after)) && (!mergedFrame || framesEqual(mergedFrame.before, mergedFrame.after));
        if (isNoop) {
          past.pop();
          restoreBefore = Object.fromEntries(Object.entries(merged).map(([layerId, change]) => [layerId, change.before]));
          restoreFrameBefore = mergedFrame?.before ?? null;
          recorded = null;
        } else {
          const patch: EditorEdit = mergedFrame ? { label: edit.label, touched: merged, frame: mergedFrame } : { label: edit.label, touched: merged };
          // El comando fundido conserva id/secuencia del primero y ACUMULA el desplazamiento (parameters.dx/dy).
          const next = buildCommand(draft, edit, { id: last.command.id, sequence: last.command.sequence, timestamp: now });
          recorded = mergeCoalesced(last.command, next);
          past[past.length - 1] = { command: recorded, patch, coalesceKey: editOptions.coalesceKey, at: now };
        }
      } else {
        recorded = buildCommand(draft, edit, nextMeta(now));
        past.push({ command: recorded, patch: edit, coalesceKey: editOptions?.coalesceKey, at: now });
      }

      let dropped = 0;
      while (past.length > latestRef.current.limit) {
        past.shift();
        dropped += 1;
      }
      if (dropped > 0) setTruncatedCount((count) => count + dropped);

      const objectsByLayer = { ...state.objectsByLayer };
      for (const [layerId, change] of Object.entries(edit.touched)) objectsByLayer[layerId] = restoreBefore?.[layerId] ?? change.after;
      const frame = restoreFrameBefore ?? (edit.frame ? edit.frame.after : state.frame);
      const layerOverrides = edit.layers ? applyLayerSnapshots(state.layerOverrides, edit.layers.after, layerIdsAbsentAfter(edit.layers, "redo"), serverColorOf) : state.layerOverrides;
      commit({ ...state, objectsByLayer, frame, layerOverrides, past, future: [] });
      return recorded;
    },
    [commit, serverColorOf, nextMeta],
  );

  // ---- applyEdit ----
  const applyEdit = useCallback(
    (draft: CommandDraft, producer: EditProducer, editOptions?: EditOptions): ApplyEditResult => {
      // Un borrador sin tipo válido es un error de programación: falla ANTES de tocar nada (ver `checkDraft`).
      const checked = checkDraft(draft);
      if (stepBusyRef.current) {
        return { applied: false, reason: "history_busy", skippedLockedObjects: 0, skippedHiddenObjects: 0 };
      }
      if (gestureRef.current) {
        return { applied: false, reason: "gesture_active", skippedLockedObjects: 0, skippedHiddenObjects: 0 };
      }
      const state = committedRef.current;
      const baseFrame = frameOf(state);
      const metas = layersNow();
      const { after, afterFrame, afterMetas, skippedLockedObjects, skippedHiddenObjects } = filterProduction(
        state.objectsByLayer,
        baseFrame,
        producer({ objectsByLayer: state.objectsByLayer, frame: baseFrame, layers: metas }),
        metas,
      );

      if (Object.keys(after).length === 0 && afterFrame === null && afterMetas.length === 0) {
        const blocked = skippedLockedObjects + skippedHiddenObjects > 0;
        return { applied: false, reason: blocked ? "blocked" : "no_change", skippedLockedObjects, skippedHiddenObjects };
      }

      const edit = buildEdit(draftLabel(checked), state.objectsByLayer, baseFrame, after, afterFrame, metas, afterMetas);
      const command = pushEdit(edit, checked, editOptions);
      return { applied: true, skippedLockedObjects, skippedHiddenObjects, edit, ...(command ? { command } : {}) };
    },
    [filterProduction, pushEdit, frameOf, layersNow],
  );

  // ---- Metadata de capa dentro del historial (M3-S12) ----

  const beginMetaWork = useCallback(() => {
    pendingMetaRef.current += 1;
    setPendingMeta(pendingMetaRef.current);
  }, []);
  const endMetaWork = useCallback(() => {
    pendingMetaRef.current = Math.max(0, pendingMetaRef.current - 1);
    setPendingMeta(pendingMetaRef.current);
  }, []);

  const recordLayerMeta = useCallback(
    (change: LayerMetaChange, origin: CommandOrigin = "user"): EditorCommand => {
      const draft = checkDraft(layerMetaDraft(change, origin));
      const edit: EditorEdit = { label: draftLabel(draft), touched: {}, meta: change };
      // Una entrada de metadata nunca se funde y siempre queda registrada (no hay "sin cambios": el valor ya cambió).
      return pushEdit(edit, draft) as EditorCommand;
    },
    [pushEdit],
  );

  /** Persiste (o aplica en local) un cambio de metadata sin que el persistidor pueda lanzar. */
  const persistMeta = useCallback(async (change: LayerMetaChange, direction: "undo" | "redo", mode: PersistMode): Promise<PersistResult> => {
    const persist = latestRef.current.persistLayerMeta;
    if (!persist) return { ok: false, error: "Este editor no puede persistir cambios de metadata de capa." };
    try {
      return await persist(change, direction, mode);
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }, []);

  const commitLayerMeta = useCallback(
    async (change: LayerMetaChange, origin: CommandOrigin = "user"): Promise<LayerMetaCommitResult> => {
      if (stepBusyRef.current) return { status: "busy", error: "Esperá a que termine el deshacer o rehacer en curso." };
      beginMetaWork();
      setHistoryError(null);
      try {
        const result = await persistMeta(change, "redo", { optimistic: true });
        if (!result.ok) {
          setHistoryError(result.error);
          return { status: "failed", error: result.error };
        }
        if (result.noop) return { status: "noop" };
        return { status: "ok", command: recordLayerMeta(change, origin) };
      } finally {
        endMetaWork();
      }
    },
    [beginMetaWork, endMetaWork, persistMeta, recordLayerMeta],
  );

  // ---- undo / redo / jumpTo ----

  /**
   * Un paso del historial. Geometría (y marco/estructura): síncrono, devuelve el parche. Metadata de capa: arranca el PATCH inverso (asíncrono) y el
   * puntero se mueve SOLO si se persistió; ante un fallo no cambia nada y queda el error visible. Mientras uno está en vuelo no empieza otro.
   */
  const startStep = useCallback(
    (direction: "undo" | "redo"): StepOutcome => {
      if (gestureRef.current || stepBusyRef.current || pendingMetaRef.current > 0) return { kind: "none" };
      const state = committedRef.current;
      const entry = direction === "undo" ? state.past[state.past.length - 1] : state.future[state.future.length - 1];
      if (!entry) return { kind: "none" };
      const meta = entry.patch.meta;
      if (!meta) {
        commit(moveEntry(state, direction, serverColorOf));
        return { kind: "sync", edit: entry.patch };
      }
      stepBusyRef.current = true;
      beginMetaWork();
      setHistoryError(null);
      const promise = (async () => {
        try {
          const result = await persistMeta(meta, direction, { optimistic: false });
          if (!result.ok) {
            setHistoryError(result.error);
            return { ok: false as const, error: result.error };
          }
          // El puntero se mueve recién ahora, sobre el estado FRESCO (la parte local de la metadata ya se aplicó dentro de `persistMeta`).
          const fresh = committedRef.current;
          const head = direction === "undo" ? fresh.past[fresh.past.length - 1] : fresh.future[fresh.future.length - 1];
          if (head !== entry) {
            const error = "El historial cambió mientras se persistía el cambio de la capa: revisá el estado de las capas.";
            setHistoryError(error);
            return { ok: false as const, error };
          }
          commit(moveEntry(fresh, direction, serverColorOf));
          return { ok: true as const, edit: entry.patch };
        } finally {
          stepBusyRef.current = false;
          endMetaWork();
        }
      })();
      return { kind: "async", promise };
    },
    [commit, serverColorOf, beginMetaWork, endMetaWork, persistMeta],
  );

  const undo = useCallback((): EditorEdit | null => {
    const outcome = startStep("undo");
    return outcome.kind === "sync" ? outcome.edit : null;
  }, [startStep]);

  const redo = useCallback((): EditorEdit | null => {
    const outcome = startStep("redo");
    return outcome.kind === "sync" ? outcome.edit : null;
  }, [startStep]);

  const jumpTo = useCallback(
    async (entryId: string | null): Promise<JumpResult> => {
      const fail = (error: string): JumpResult => ({ ok: false, steps: 0, direction: null, edits: [], error });
      if (gestureRef.current) return fail("Hay una transformación pendiente: aplicala o cancelala antes de moverte por el historial.");
      if (stepBusyRef.current || pendingMetaRef.current > 0) return fail("Hay un cambio de capa en curso: esperá a que termine.");
      const start = committedRef.current;
      const all = [...start.past, ...[...start.future].reverse()];
      const target = entryId === null ? 0 : all.findIndex((entry) => entry.command.id === entryId) + 1;
      if (entryId !== null && target === 0) return fail("Esa acción ya no está en el historial.");
      const direction = start.past.length > target ? "undo" : start.past.length < target ? "redo" : null;
      if (direction === null) return { ok: true, steps: 0, direction: null, edits: [], error: null };

      const edits: EditorEdit[] = [];
      while (committedRef.current.past.length !== target) {
        const step = committedRef.current.past.length > target ? "undo" : "redo";
        const outcome = startStep(step);
        if (outcome.kind === "none") return { ok: false, steps: edits.length, direction, edits, error: "No se pudo completar el salto en el historial." };
        if (outcome.kind === "sync") {
          edits.push(outcome.edit);
          continue;
        }
        const result = await outcome.promise;
        if (!result.ok) return { ok: false, steps: edits.length, direction, edits, error: result.error };
        edits.push(result.edit);
      }
      return { ok: true, steps: edits.length, direction, edits, error: null };
    },
    [startStep],
  );

  const clearHistory = useCallback(() => {
    if (stepBusyRef.current) return;
    commit({ ...committedRef.current, past: [], future: [] });
  }, [commit]);

  const exportHistory = useCallback((): HistoryExport => {
    const state = committedRef.current;
    return exportCommands(
      [...state.past, ...[...state.future].reverse()].map((entry) => entry.command),
      state.past.length,
    );
  }, []);

  const dismissHistoryError = useCallback(() => setHistoryError(null), []);
  const dismissHistoryNotice = useCallback((kind: HistoryNotice["kind"]) => setDismissedNotices((current) => new Set([...current, kind])), []);

  // ---- Gestos continuos ----
  const beginGesture = useCallback((): boolean => {
    if (gestureRef.current || stepBusyRef.current) return false;
    gestureRef.current = {
      base: committedRef.current.objectsByLayer,
      baseFrame: frameOf(committedRef.current),
      after: {},
      afterFrame: null,
      baseMetas: layersNow(),
      afterMetas: [],
      skippedLockedObjects: 0,
      skippedHiddenObjects: 0,
    };
    setGestureActive(true);
    return true;
  }, [frameOf, layersNow]);

  const previewEdit = useCallback(
    (producer: EditProducer): ApplyEditResult => {
      const gesture = gestureRef.current;
      if (!gesture) return { applied: false, reason: "no_gesture", skippedLockedObjects: 0, skippedHiddenObjects: 0 };
      // El productor SIEMPRE parte del estado "antes" del gesto, nunca del frame anterior: el resultado
      // depende solo de (antes, gesto) y no acumula error de punto flotante.
      // La estructura de capas también parte del estado "antes" (las confirmadas no cambian durante un gesto).
      const metas = layersNow();
      const { after, afterFrame, afterMetas, skippedLockedObjects, skippedHiddenObjects } = filterProduction(
        gesture.base,
        gesture.baseFrame,
        producer({ objectsByLayer: gesture.base, frame: gesture.baseFrame, layers: metas }),
        metas,
      );
      gesture.after = after;
      gesture.afterFrame = afterFrame;
      gesture.afterMetas = afterMetas;
      gesture.skippedLockedObjects = skippedLockedObjects;
      gesture.skippedHiddenObjects = skippedHiddenObjects;
      const touched = Object.keys(after).length > 0 || afterFrame !== null || afterMetas.length > 0;
      setGestureView(Object.keys(after).length > 0 ? { ...gesture.base, ...after } : null);
      setGestureFrame(afterFrame);
      // La previsualización de una capa creada/recoloreada se ve en la lista efectiva de capas (canvas, paleta, panel) sin tocar lo confirmado.
      setGestureOverrides(afterMetas.length > 0 ? applyLayerSnapshots(committedRef.current.layerOverrides, afterMetas, [], serverColorOf) : null);
      return touched
        ? { applied: true, skippedLockedObjects, skippedHiddenObjects }
        : { applied: false, reason: skippedLockedObjects + skippedHiddenObjects > 0 ? "blocked" : "no_change", skippedLockedObjects, skippedHiddenObjects };
    },
    [filterProduction, layersNow, serverColorOf],
  );

  const endGesture = useCallback(() => {
    gestureRef.current = null;
    setGestureView(null);
    setGestureFrame(null);
    setGestureOverrides(null);
    setGestureActive(false);
  }, []);

  const commitGesture = useCallback(
    (draft: CommandDraft): ApplyEditResult => {
      const gesture = gestureRef.current;
      if (!gesture) return { applied: false, reason: "no_gesture", skippedLockedObjects: 0, skippedHiddenObjects: 0 };
      let checked: CommandDraft;
      try {
        checked = checkDraft(draft);
      } catch (error) {
        // Un borrador inválido es un error de programación: el gesto no puede quedar colgado.
        endGesture();
        throw error;
      }
      endGesture();

      const { skippedLockedObjects, skippedHiddenObjects } = gesture;
      if (Object.keys(gesture.after).length === 0 && gesture.afterFrame === null && gesture.afterMetas.length === 0) {
        const blocked = skippedLockedObjects + skippedHiddenObjects > 0;
        return { applied: false, reason: blocked ? "blocked" : "no_change", skippedLockedObjects, skippedHiddenObjects };
      }

      const edit = buildEdit(draftLabel(checked), gesture.base, gesture.baseFrame, gesture.after, gesture.afterFrame, gesture.baseMetas, gesture.afterMetas);
      const command = pushEdit(edit, checked);
      return { applied: true, skippedLockedObjects, skippedHiddenObjects, edit, ...(command ? { command } : {}) };
    },
    [endGesture, pushEdit],
  );

  const cancelGesture = useCallback(() => {
    if (gestureRef.current) endGesture();
  }, [endGesture]);

  const getSnapshot = useCallback(
    (): EditableDocument => ({ objectsByLayer: committedRef.current.objectsByLayer, frame: frameOf(committedRef.current), layers: layersNow() }),
    [frameOf, layersNow],
  );

  // Metadata local de capas nuevas (M3-S03): sin PATCH, porque la capa no existe en el servidor. Las capas del servidor NO pasan por acá.
  const updateLocalLayer = useCallback(
    (groupId: string, patch: LocalLayerPatch): boolean => {
      const state = committedRef.current;
      if (state.layerOverrides[groupId]?.isNew !== true) return false;
      commit({ ...state, localLayers: { ...state.localLayers, [groupId]: { ...state.localLayers[groupId], ...patch } } });
      return true;
    },
    [commit],
  );

  const markSaved = useCallback(
    (mark: GeometrySaveMark) => {
      const state = committedRef.current;
      if (mark.epoch !== state.epoch) return;
      commit({ ...state, saved: mark });
    },
    [commit],
  );

  const objectsByLayer = gestureView ?? committed.objectsByLayer;
  const committedFrame = committed.frame ?? sourceFrame;
  const saved = committed.saved;
  const frameDirty = !framesEqual(committedFrame, saved ? (saved.frame ?? sourceFrame) : sourceFrame);
  const structureKey = useMemo(() => structureKeyOf(committed.layerOverrides, committed.localLayers), [committed.layerOverrides, committed.localLayers]);
  const saveMark = useMemo<GeometrySaveMark>(
    () => ({ epoch: committed.epoch, objectsByLayer: committed.objectsByLayer, frame: committed.frame, structureKey }),
    [committed.epoch, committed.objectsByLayer, committed.frame, structureKey],
  );
  const structureDirty = saved ? structureKey !== saved.structureKey : Object.keys(committed.layerOverrides).length > 0;
  const layersDirty = useMemo(
    () => Object.entries(committed.objectsByLayer).some(([groupId, objects]) => (saved?.objectsByLayer[groupId] ?? committed.baseline[groupId]) !== objects),
    [committed.objectsByLayer, committed.baseline, saved],
  );

  // Lista efectiva de capas (servidor + overrides + capas nuevas). `pathCount` solo se pisa en las capas EDITADAS. Se memoiza por el
  // VALOR de los conteos (no por el array de objetos), así un drag no recrea la lista de capas en cada frame.
  const committedCountsKey = useMemo(() => editedCountsKey(committed.objectsByLayer, committed.baseline), [committed.objectsByLayer, committed.baseline]);
  const liveCountsKey = useMemo(() => editedCountsKey(objectsByLayer, committed.baseline), [objectsByLayer, committed.baseline]);
  const committedLayers = useMemo(
    () => composeLayers(layers, committed.layerOverrides, committed.localLayers, JSON.parse(committedCountsKey) as Record<string, number>),
    [layers, committed.layerOverrides, committed.localLayers, committedCountsKey],
  );
  const liveOverrides = gestureOverrides ?? committed.layerOverrides;
  const composedLiveLayers = useMemo(
    () => composeLayers(layers, liveOverrides, committed.localLayers, JSON.parse(liveCountsKey) as Record<string, number>),
    [layers, liveOverrides, committed.localLayers, liveCountsKey],
  );
  const liveLayers = gestureOverrides === null && liveCountsKey === committedCountsKey ? committedLayers : composedLiveLayers;
  // Visibilidad efectiva: memoizada por VALOR (una previsualización recrea la lista de capas en cada paso, pero la visibilidad no cambia).
  const visibilityKey = JSON.stringify(liveLayers.map((layer) => [layer.groupId, effectiveVisible(layer, visibility, isolatedGroupId)]));
  const effectiveVisibility = useMemo(() => Object.fromEntries(JSON.parse(visibilityKey) as Array<[string, boolean]>) as Record<string, boolean>, [visibilityKey]);
  const isLoading = useMemo(() => Object.values(layerStatus).some((status) => status === "loading"), [layerStatus]);
  const editedLayerIds = useMemo(() => {
    const edited = new Set<string>();
    for (const [groupId, objects] of Object.entries(committed.objectsByLayer)) {
      if (committed.baseline[groupId] !== objects) edited.add(groupId);
    }
    return edited as ReadonlySet<string>;
  }, [committed.objectsByLayer, committed.baseline]);
  const lastPast = committed.past[committed.past.length - 1];
  const lastFuture = committed.future[committed.future.length - 1];
  const historyBusy = pendingMeta > 0;

  const historyEntries = useMemo<HistoryEntryView[]>(
    () => [
      ...committed.past.map((entry) => ({ command: entry.command, applied: true })),
      ...[...committed.future].reverse().map((entry) => ({ command: entry.command, applied: false })),
    ],
    [committed.past, committed.future],
  );
  const historyNotices = useMemo<HistoryNotice[]>(() => {
    const notices: HistoryNotice[] = [];
    if (truncatedCount > 0 && !dismissedNotices.has("truncated")) {
      notices.push({
        kind: "truncated",
        message: `El historial guarda las últimas ${limit} acciones: se descartaron las ${truncatedCount} más antiguas y ya no se pueden deshacer.`,
      });
    }
    if (resetNotice && !dismissedNotices.has("reset")) {
      const lost = resetNotice.discarded > 0 ? `${resetNotice.discarded} ${resetNotice.discarded === 1 ? "acción" : "acciones"} del historial` : "las ediciones sin guardar";
      notices.push({
        kind: "reset",
        message:
          resetNotice.reason === "document"
            ? `Se abrió otro documento: el historial empezó de cero (se descartó ${lost}).`
            : `El documento se regeneró: el historial se reinició y se descartó ${lost}${resetNotice.discarded > 0 && resetNotice.hadEdits ? " junto con las ediciones sin guardar" : ""}.`,
      });
    }
    return notices;
  }, [truncatedCount, resetNotice, dismissedNotices, limit]);

  return {
    objectsByLayer,
    layerStatus,
    isLoading,
    retry,
    layers: liveLayers,
    committedLayers,
    visibility: effectiveVisibility,
    updateLocalLayer,
    applyEdit,
    undo,
    redo,
    canUndo: committed.past.length > 0 && !gestureActive && !historyBusy,
    canRedo: committed.future.length > 0 && !gestureActive && !historyBusy,
    undoLabel: lastPast?.command.label ?? null,
    redoLabel: lastFuture?.command.label ?? null,
    undoDepth: committed.past.length,
    beginGesture,
    previewEdit,
    commitGesture,
    cancelGesture,
    gestureActive,
    // La estructura de capas también cuenta (crear/recolorear una capa).
    geometryDirty: layersDirty || frameDirty || structureDirty,
    saveMark,
    markSaved,
    frame: gestureFrame ?? committedFrame,
    committedFrame,
    getSnapshot,
    committedObjectsByLayer: committed.objectsByLayer,
    editedLayerIds,
    historyEntries,
    historyPosition: committed.past.length,
    undoCommand: lastPast?.command ?? null,
    redoCommand: lastFuture?.command ?? null,
    jumpTo,
    clearHistory,
    exportHistory,
    historyBusy,
    historyError,
    dismissHistoryError,
    historyNotices,
    dismissHistoryNotice,
    historyLimit: limit,
    commitLayerMeta,
    recordLayerMeta,
  };
}
