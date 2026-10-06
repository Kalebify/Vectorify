import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseEditableLayerStrict } from "../lib/editor/objects";
import type { EditableDocument, EditorEdit, EditorLayerChange, EditorObject, EditProduction } from "../lib/editor/types";
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
  /** Por qué no se aplicó (solo si `applied` es false): sin cambios reales, todo bloqueado/oculto, o uso fuera de un gesto. */
  reason?: "no_change" | "blocked" | "gesture_active" | "no_gesture";
  /** Objetos que el productor quiso modificar en capas BLOQUEADAS y se omitieron. */
  skippedLockedObjects: number;
  /** Objetos que el productor quiso modificar en capas OCULTAS y se omitieron. */
  skippedHiddenObjects: number;
}

export interface UseEditableDocumentOptions {
  /** Visibilidad EFECTIVA por groupId (con Isolate aplicado, ver `useVectorDocument.visibility`); default: `layer.visible`. */
  visibility?: Record<string, boolean>;
  /** Límite de la pila de undo (default 200). */
  limit?: number;
  /** Generador de ids para paths sin `data-vid` (default `crypto.randomUUID`); inyectable en tests. */
  createId?: () => string;
}

export interface EditableDocumentApi {
  /** Objetos por capa EN VIVO: incluye la previsualización de un gesto en curso. */
  objectsByLayer: Record<string, EditorObject[]>;
  layerStatus: Record<string, EditableLayerStatus>;
  /** Alguna capa todavía está cargando. */
  isLoading: boolean;
  /** Reintenta las capas que fallaron. */
  retry: () => void;

  /** ÚNICO punto de mutación geométrica (ADR D2): ver `EditProducer`. */
  applyEdit: (label: string, producer: EditProducer, options?: EditOptions) => ApplyEditResult;
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
  commitGesture: (label: string) => ApplyEditResult;
  cancelGesture: () => void;
  gestureActive: boolean;

  /** Hay ediciones de geometría sin persistir (ADR D2: hasta M3-S13 la persistencia no existe, así que significa "alguna capa difiere de lo cargado"). */
  geometryDirty: boolean;
  /** Snapshot SÍNCRONO del estado confirmado (sin previsualización), para handlers de eventos. */
  getSnapshot: () => EditableDocument;
  /** Estado CONFIRMADO por capa (sin la previsualización de un gesto en curso), reactivo: base de miniaturas/serialización. */
  committedObjectsByLayer: Record<string, EditorObject[]>;
  /** Capas cuya geometría hoy difiere de la cargada (se calcula por referencia: deshacer hasta el origen la saca del conjunto). */
  editedLayerIds: ReadonlySet<string>;
}

interface HistoryEntry {
  edit: EditorEdit;
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
  past: HistoryEntry[];
  future: HistoryEntry[];
}

interface LoadResult {
  status: "ready" | "error";
  url: string;
  /** Intento de carga (`retryNonce`) en el que se obtuvo: un error de un intento anterior se considera "cargando" de nuevo. */
  attempt: number;
}

interface GestureState {
  base: Record<string, EditorObject[]>;
  /** Capas tocadas por la última previsualización (lista completa ya modificada). */
  after: Record<string, EditorObject[]>;
  skippedLockedObjects: number;
  skippedHiddenObjects: number;
}

const EMPTY_STATE: CommittedState = { objectsByLayer: {}, baseline: {}, past: [], future: [] };

function sameList(left: readonly EditorObject[], right: readonly EditorObject[]): boolean {
  return left.length === right.length && left.every((object, index) => object === right[index]);
}

/** Mismas capas de objetos por CONTENIDO (id, geometría, fill, matriz), aunque sean otras referencias. */
function sameListContent(left: readonly EditorObject[], right: readonly EditorObject[]): boolean {
  return left.length === right.length && left.every((object, index) => object.id === right[index].id && sameObjectContent(object, right[index]));
}

function sameObjectContent(left: EditorObject, right: EditorObject): boolean {
  return (
    left.d === right.d &&
    left.fill === right.fill &&
    left.layerGroupId === right.layerGroupId &&
    left.matrix.a === right.matrix.a &&
    left.matrix.b === right.matrix.b &&
    left.matrix.c === right.matrix.c &&
    left.matrix.d === right.matrix.d &&
    left.matrix.e === right.matrix.e &&
    left.matrix.f === right.matrix.f
  );
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

export function useEditableDocument(layers: VectorDocumentLayer[], options: UseEditableDocumentOptions = {}): EditableDocumentApi {
  const { visibility, limit = MAX_UNDO_STEPS, createId } = options;

  const [committed, setCommitted] = useState<CommittedState>(EMPTY_STATE);
  const committedRef = useRef<CommittedState>(EMPTY_STATE);
  const [results, setResults] = useState<Record<string, LoadResult>>({});
  const [gestureView, setGestureView] = useState<Record<string, EditorObject[]> | null>(null);
  const [gestureActive, setGestureActive] = useState(false);
  const gestureRef = useRef<GestureState | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  // Último valor de layers/visibility/límite en refs (patrón "latest ref" de useWorkspaceSave): los
  // handlers de abajo son ESTABLES pero siempre leen lo vigente al momento de la edición.
  const latestRef = useRef({ layers, visibility, limit, createId });
  useEffect(() => {
    latestRef.current = { layers, visibility, limit, createId };
  });

  // groupId -> url ya cargada con éxito. Solo se marca al terminar: así el doble efecto de
  // StrictMode (efecto -> cleanup/abort -> efecto) reinicia las cargas abortadas en vez de darlas por hechas.
  const loadedUrlsRef = useRef<Map<string, string>>(new Map());

  const commit = useCallback((next: CommittedState) => {
    committedRef.current = next;
    setCommitted(next);
  }, []);

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
        // historial dejan de ser coherentes con la nueva geometría: se reinicia el historial.
        commit(previousUrl !== undefined ? { ...loaded, past: [], future: [] } : { ...current, ...loaded });
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

      fetch(svgUrl, { signal })
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
  }, [sourcesKey, retryNonce, commit]);

  // Estado de carga DERIVADO (sin setState síncrono en el efecto): una capa sin resultado para su url actual está cargando.
  const layerStatus = useMemo(() => {
    const status: Record<string, EditableLayerStatus> = {};
    for (const layer of layers) {
      const result = results[layer.groupId];
      const current = result !== undefined && result.url === layer.svgUrl && (result.status === "ready" || result.attempt === retryNonce);
      status[layer.groupId] = current ? result.status : "loading";
    }
    return status;
  }, [layers, results, retryNonce]);

  const retry = useCallback(() => setRetryNonce((nonce) => nonce + 1), []);

  // ---- Filtro de bloqueo / visibilidad ----
  const filterProduction = useCallback(
    (base: Record<string, EditorObject[]>, production: EditProduction | null) => {
      const { layers: currentLayers, visibility: currentVisibility } = latestRef.current;
      const after: Record<string, EditorObject[]> = {};
      let skippedLockedObjects = 0;
      let skippedHiddenObjects = 0;

      for (const [layerId, nextObjects] of Object.entries(production?.layers ?? {})) {
        const previousObjects = base[layerId] ?? [];
        if (sameList(previousObjects, nextObjects)) continue;

        const meta = currentLayers.find((layer) => layer.groupId === layerId);
        if (meta?.locked) {
          skippedLockedObjects += countChangedObjects(previousObjects, nextObjects);
          continue;
        }
        if (meta && !(currentVisibility?.[layerId] ?? meta.visible)) {
          skippedHiddenObjects += countChangedObjects(previousObjects, nextObjects);
          continue;
        }
        after[layerId] = nextObjects;
      }
      return { after, skippedLockedObjects, skippedHiddenObjects };
    },
    [],
  );

  const pushEdit = useCallback(
    (edit: EditorEdit, editOptions?: EditOptions) => {
      const state = committedRef.current;
      const now = Date.now();
      const past = [...state.past];
      const last = past[past.length - 1];
      // Capas que quedan con el estado "antes" (solo cambia si un comando fundido resulta no-op).
      let restoreBefore: Record<string, EditorObject[]> | null = null;

      if (editOptions?.coalesceKey && last?.coalesceKey === editOptions.coalesceKey && now - last.at <= COALESCE_WINDOW_MS) {
        const merged: Record<string, EditorLayerChange> = { ...last.edit.touched };
        for (const [layerId, change] of Object.entries(edit.touched)) {
          merged[layerId] = merged[layerId] ? { before: merged[layerId].before, after: change.after } : change;
        }
        // Si el comando fundido queda en no-op se descarta del todo (ir y volver con flechas no deja basura) y la
        // geometría vuelve EXACTAMENTE a los snapshots originales.
        const isNoop = Object.values(merged).every((change) => sameListContent(change.before, change.after));
        if (isNoop) {
          past.pop();
          restoreBefore = Object.fromEntries(Object.entries(merged).map(([layerId, change]) => [layerId, change.before]));
        } else {
          past[past.length - 1] = { edit: { label: edit.label, touched: merged }, coalesceKey: editOptions.coalesceKey, at: now };
        }
      } else {
        past.push({ edit, coalesceKey: editOptions?.coalesceKey, at: now });
      }

      while (past.length > latestRef.current.limit) past.shift();

      const objectsByLayer = { ...state.objectsByLayer };
      for (const [layerId, change] of Object.entries(edit.touched)) objectsByLayer[layerId] = restoreBefore?.[layerId] ?? change.after;
      commit({ ...state, objectsByLayer, past, future: [] });
    },
    [commit],
  );

  // ---- applyEdit ----
  const applyEdit = useCallback(
    (label: string, producer: EditProducer, editOptions?: EditOptions): ApplyEditResult => {
      if (gestureRef.current) {
        return { applied: false, reason: "gesture_active", skippedLockedObjects: 0, skippedHiddenObjects: 0 };
      }
      const state = committedRef.current;
      const { after, skippedLockedObjects, skippedHiddenObjects } = filterProduction(state.objectsByLayer, producer({ objectsByLayer: state.objectsByLayer }));

      const touchedLayers = Object.keys(after);
      if (touchedLayers.length === 0) {
        const blocked = skippedLockedObjects + skippedHiddenObjects > 0;
        return { applied: false, reason: blocked ? "blocked" : "no_change", skippedLockedObjects, skippedHiddenObjects };
      }

      const touched: Record<string, EditorLayerChange> = {};
      for (const layerId of touchedLayers) touched[layerId] = { before: state.objectsByLayer[layerId] ?? [], after: after[layerId] };
      pushEdit({ label, touched }, editOptions);
      return { applied: true, skippedLockedObjects, skippedHiddenObjects };
    },
    [filterProduction, pushEdit],
  );

  // ---- undo / redo ----
  const undo = useCallback((): EditorEdit | null => {
    if (gestureRef.current) return null;
    const state = committedRef.current;
    const entry = state.past[state.past.length - 1];
    if (!entry) return null;
    // Undo/redo restauran snapshots tal cual, SIN el filtro de bloqueo: son la historia del usuario y
    // bloquear una capa después de editarla no debe dejar el historial trabado (ver IMPL de M3-S01).
    const objectsByLayer = { ...state.objectsByLayer };
    for (const [layerId, change] of Object.entries(entry.edit.touched)) objectsByLayer[layerId] = change.before;
    commit({ ...state, objectsByLayer, past: state.past.slice(0, -1), future: [...state.future, entry] });
    return entry.edit;
  }, [commit]);

  const redo = useCallback((): EditorEdit | null => {
    if (gestureRef.current) return null;
    const state = committedRef.current;
    const entry = state.future[state.future.length - 1];
    if (!entry) return null;
    const objectsByLayer = { ...state.objectsByLayer };
    for (const [layerId, change] of Object.entries(entry.edit.touched)) objectsByLayer[layerId] = change.after;
    commit({ ...state, objectsByLayer, past: [...state.past, entry], future: state.future.slice(0, -1) });
    return entry.edit;
  }, [commit]);

  // ---- Gestos continuos ----
  const beginGesture = useCallback((): boolean => {
    if (gestureRef.current) return false;
    gestureRef.current = { base: committedRef.current.objectsByLayer, after: {}, skippedLockedObjects: 0, skippedHiddenObjects: 0 };
    setGestureActive(true);
    return true;
  }, []);

  const previewEdit = useCallback(
    (producer: EditProducer): ApplyEditResult => {
      const gesture = gestureRef.current;
      if (!gesture) return { applied: false, reason: "no_gesture", skippedLockedObjects: 0, skippedHiddenObjects: 0 };
      // El productor SIEMPRE parte del estado "antes" del gesto, nunca del frame anterior: el resultado
      // depende solo de (antes, gesto) y no acumula error de punto flotante.
      const { after, skippedLockedObjects, skippedHiddenObjects } = filterProduction(gesture.base, producer({ objectsByLayer: gesture.base }));
      gesture.after = after;
      gesture.skippedLockedObjects = skippedLockedObjects;
      gesture.skippedHiddenObjects = skippedHiddenObjects;
      const touched = Object.keys(after).length > 0;
      setGestureView(touched ? { ...gesture.base, ...after } : null);
      return touched
        ? { applied: true, skippedLockedObjects, skippedHiddenObjects }
        : { applied: false, reason: skippedLockedObjects + skippedHiddenObjects > 0 ? "blocked" : "no_change", skippedLockedObjects, skippedHiddenObjects };
    },
    [filterProduction],
  );

  const endGesture = useCallback(() => {
    gestureRef.current = null;
    setGestureView(null);
    setGestureActive(false);
  }, []);

  const commitGesture = useCallback(
    (label: string): ApplyEditResult => {
      const gesture = gestureRef.current;
      if (!gesture) return { applied: false, reason: "no_gesture", skippedLockedObjects: 0, skippedHiddenObjects: 0 };
      endGesture();

      const touchedLayers = Object.keys(gesture.after);
      const { skippedLockedObjects, skippedHiddenObjects } = gesture;
      if (touchedLayers.length === 0) {
        const blocked = skippedLockedObjects + skippedHiddenObjects > 0;
        return { applied: false, reason: blocked ? "blocked" : "no_change", skippedLockedObjects, skippedHiddenObjects };
      }

      const touched: Record<string, EditorLayerChange> = {};
      for (const layerId of touchedLayers) touched[layerId] = { before: gesture.base[layerId] ?? [], after: gesture.after[layerId] };
      pushEdit({ label, touched });
      return { applied: true, skippedLockedObjects, skippedHiddenObjects };
    },
    [endGesture, pushEdit],
  );

  const cancelGesture = useCallback(() => {
    if (gestureRef.current) endGesture();
  }, [endGesture]);

  const getSnapshot = useCallback((): EditableDocument => ({ objectsByLayer: committedRef.current.objectsByLayer }), []);

  const objectsByLayer = gestureView ?? committed.objectsByLayer;
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

  return {
    objectsByLayer,
    layerStatus,
    isLoading,
    retry,
    applyEdit,
    undo,
    redo,
    canUndo: committed.past.length > 0 && !gestureActive,
    canRedo: committed.future.length > 0 && !gestureActive,
    undoLabel: lastPast?.edit.label ?? null,
    redoLabel: lastFuture?.edit.label ?? null,
    undoDepth: committed.past.length,
    beginGesture,
    previewEdit,
    commitGesture,
    cancelGesture,
    gestureActive,
    geometryDirty: editedLayerIds.size > 0,
    getSnapshot,
    committedObjectsByLayer: committed.objectsByLayer,
    editedLayerIds,
  };
}
