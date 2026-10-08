import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { framesEqual, isValidFrame, sourceFrameOf } from "../lib/editor/frame";
import { applyLayerSnapshots, layerIdsAbsentAfter, sameLayerMeta, toLayerMetas, type LocalLayerPatch } from "../lib/editor/layers";
import { parseEditableLayerStrict } from "../lib/editor/objects";
import type { DocumentFrame, EditableDocument, EditableLayerMeta, EditorEdit, EditorLayerChange, EditorObject, EditProduction } from "../lib/editor/types";
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
   * NO hay PATCH. `false` si la capa no existe o es del servidor (esas siguen yendo por `useVectorDocument`/PATCH). No entra al historial (S12).
   */
  updateLocalLayer: (groupId: string, patch: LocalLayerPatch) => boolean;

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

  /** Hay ediciones de geometría sin persistir (ADR D2: hasta M3-S13 la persistencia no existe, así que significa "alguna capa o el marco difieren de lo cargado"). */
  geometryDirty: boolean;
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
  /** Marco confirmado, o `null` = el marco original del documento (`sourceFrame`): así un documento sin ediciones de marco no depende de cuándo se midió. */
  frame: DocumentFrame | null;
  /**
   * Meta de las capas TOCADAS por comandos (M3-S03): capas creadas en el cliente (`isNew`) y capas del servidor con otro color. Vacío =
   * la estructura es la del servidor (por eso "hay cambios de estructura" es simplemente "no está vacío").
   */
  layerOverrides: Record<string, EditableLayerMeta>;
  /** Metadata editada EN LOCAL de las capas `isNew` (sin PATCH). Fuera del historial: undo/redo no la tocan, así que un redo no pierde un renombre. */
  localLayers: Record<string, LocalLayerPatch>;
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

const EMPTY_STATE: CommittedState = { objectsByLayer: {}, baseline: {}, frame: null, layerOverrides: {}, localLayers: {}, past: [], future: [] };

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

export function useEditableDocument(layers: VectorDocumentLayer[], options: UseEditableDocumentOptions = {}): EditableDocumentApi {
  const { visibility, isolatedGroupId = null, limit = MAX_UNDO_STEPS, createId } = options;
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

  // Último valor de layers/visibility/límite en refs (patrón "latest ref" de useWorkspaceSave): los
  // handlers de abajo son ESTABLES pero siempre leen lo vigente al momento de la edición.
  const latestRef = useRef({ layers, visibility, isolatedGroupId, limit, createId, sourceFrame });
  useEffect(() => {
    latestRef.current = { layers, visibility, isolatedGroupId, limit, createId, sourceFrame };
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
        // El marco también vuelve al original: un recorte hecho sobre la geometría anterior ya no describe este documento.
        // Y la estructura de capas (M3-S03): las capas creadas en el cliente y los colores recoloreados describían la geometría anterior. Como
        // un comando de estructura mueve objetos ENTRE capas (y la capa regenerada vuelve a traer los suyos), conservar a medias las ediciones
        // de las otras capas dejaría objetos duplicados o huérfanos: se descartan TODAS las ediciones sin guardar y cada capa vuelve a lo cargado.
        if (previousUrl !== undefined) {
          commit({ objectsByLayer: loaded.baseline, baseline: loaded.baseline, frame: null, layerOverrides: {}, localLayers: {}, past: [], future: [] });
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

  const pushEdit = useCallback(
    (edit: EditorEdit, editOptions?: EditOptions) => {
      const state = committedRef.current;
      const now = Date.now();
      const past = [...state.past];
      const last = past[past.length - 1];
      // Capas que quedan con el estado "antes" (solo cambia si un comando fundido resulta no-op).
      let restoreBefore: Record<string, EditorObject[]> | null = null;
      let restoreFrameBefore: DocumentFrame | null = null;

      // Un comando que cambia la estructura de capas nunca se funde con otro (crear/recolorear una capa es un paso propio del historial).
      const canCoalesce = Boolean(editOptions?.coalesceKey) && last?.coalesceKey === editOptions?.coalesceKey && now - (last?.at ?? 0) <= COALESCE_WINDOW_MS && !edit.layers && !last?.edit.layers;
      if (editOptions?.coalesceKey && last && canCoalesce) {
        const merged: Record<string, EditorLayerChange> = { ...last.edit.touched };
        for (const [layerId, change] of Object.entries(edit.touched)) {
          merged[layerId] = merged[layerId] ? { before: merged[layerId].before, after: change.after } : change;
        }
        const mergedFrame = mergeFrameChange(last.edit.frame, edit.frame);
        // Si el comando fundido queda en no-op se descarta del todo (ir y volver con flechas no deja basura) y la
        // geometría vuelve EXACTAMENTE a los snapshots originales.
        const isNoop = Object.values(merged).every((change) => sameListContent(change.before, change.after)) && (!mergedFrame || framesEqual(mergedFrame.before, mergedFrame.after));
        if (isNoop) {
          past.pop();
          restoreBefore = Object.fromEntries(Object.entries(merged).map(([layerId, change]) => [layerId, change.before]));
          restoreFrameBefore = mergedFrame?.before ?? null;
        } else {
          past[past.length - 1] = {
            edit: mergedFrame ? { label: edit.label, touched: merged, frame: mergedFrame } : { label: edit.label, touched: merged },
            coalesceKey: editOptions.coalesceKey,
            at: now,
          };
        }
      } else {
        past.push({ edit, coalesceKey: editOptions?.coalesceKey, at: now });
      }

      while (past.length > latestRef.current.limit) past.shift();

      const objectsByLayer = { ...state.objectsByLayer };
      for (const [layerId, change] of Object.entries(edit.touched)) objectsByLayer[layerId] = restoreBefore?.[layerId] ?? change.after;
      const frame = restoreFrameBefore ?? (edit.frame ? edit.frame.after : state.frame);
      const layerOverrides = edit.layers ? applyLayerSnapshots(state.layerOverrides, edit.layers.after, layerIdsAbsentAfter(edit.layers, "redo"), serverColorOf) : state.layerOverrides;
      commit({ ...state, objectsByLayer, frame, layerOverrides, past, future: [] });
    },
    [commit, serverColorOf],
  );

  // ---- applyEdit ----
  const applyEdit = useCallback(
    (label: string, producer: EditProducer, editOptions?: EditOptions): ApplyEditResult => {
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

      pushEdit(buildEdit(label, state.objectsByLayer, baseFrame, after, afterFrame, metas, afterMetas), editOptions);
      return { applied: true, skippedLockedObjects, skippedHiddenObjects };
    },
    [filterProduction, pushEdit, frameOf, layersNow],
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
    // Las capas que el comando CREÓ desaparecen con él: su entrada de objetos se elimina (no queda una capa fantasma vacía).
    const removed = entry.edit.layers ? layerIdsAbsentAfter(entry.edit.layers, "undo") : [];
    for (const [layerId, change] of Object.entries(entry.edit.touched)) {
      if (removed.includes(layerId)) delete objectsByLayer[layerId];
      else objectsByLayer[layerId] = change.before;
    }
    // El marco y la estructura de capas vuelven junto con los objetos (atómico): un undo no deja nada a medias.
    const layerOverrides = entry.edit.layers ? applyLayerSnapshots(state.layerOverrides, entry.edit.layers.before, removed, serverColorOf) : state.layerOverrides;
    commit({ ...state, objectsByLayer, layerOverrides, frame: entry.edit.frame ? entry.edit.frame.before : state.frame, past: state.past.slice(0, -1), future: [...state.future, entry] });
    return entry.edit;
  }, [commit, serverColorOf]);

  const redo = useCallback((): EditorEdit | null => {
    if (gestureRef.current) return null;
    const state = committedRef.current;
    const entry = state.future[state.future.length - 1];
    if (!entry) return null;
    const objectsByLayer = { ...state.objectsByLayer };
    const removed = entry.edit.layers ? layerIdsAbsentAfter(entry.edit.layers, "redo") : [];
    for (const [layerId, change] of Object.entries(entry.edit.touched)) {
      if (removed.includes(layerId)) delete objectsByLayer[layerId];
      else objectsByLayer[layerId] = change.after;
    }
    const layerOverrides = entry.edit.layers ? applyLayerSnapshots(state.layerOverrides, entry.edit.layers.after, removed, serverColorOf) : state.layerOverrides;
    commit({ ...state, objectsByLayer, layerOverrides, frame: entry.edit.frame ? entry.edit.frame.after : state.frame, past: [...state.past, entry], future: state.future.slice(0, -1) });
    return entry.edit;
  }, [commit, serverColorOf]);

  // ---- Gestos continuos ----
  const beginGesture = useCallback((): boolean => {
    if (gestureRef.current) return false;
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
    (label: string): ApplyEditResult => {
      const gesture = gestureRef.current;
      if (!gesture) return { applied: false, reason: "no_gesture", skippedLockedObjects: 0, skippedHiddenObjects: 0 };
      endGesture();

      const { skippedLockedObjects, skippedHiddenObjects } = gesture;
      if (Object.keys(gesture.after).length === 0 && gesture.afterFrame === null && gesture.afterMetas.length === 0) {
        const blocked = skippedLockedObjects + skippedHiddenObjects > 0;
        return { applied: false, reason: blocked ? "blocked" : "no_change", skippedLockedObjects, skippedHiddenObjects };
      }

      pushEdit(buildEdit(label, gesture.base, gesture.baseFrame, gesture.after, gesture.afterFrame, gesture.baseMetas, gesture.afterMetas));
      return { applied: true, skippedLockedObjects, skippedHiddenObjects };
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

  const objectsByLayer = gestureView ?? committed.objectsByLayer;
  const committedFrame = committed.frame ?? sourceFrame;
  const frameDirty = !framesEqual(committedFrame, sourceFrame);

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
    // La estructura de capas también cuenta (crear/recolorear una capa): hasta M3-S13 vive solo en memoria.
    geometryDirty: editedLayerIds.size > 0 || frameDirty || Object.keys(committed.layerOverrides).length > 0,
    frame: gestureFrame ?? committedFrame,
    committedFrame,
    getSnapshot,
    committedObjectsByLayer: committed.objectsByLayer,
    editedLayerIds,
  };
}
