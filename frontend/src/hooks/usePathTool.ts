import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invertMatrix } from "../lib/editor/matrix";
import {
  addNodeOnSegment,
  closeSubpath,
  closeSubpathBlocker,
  createKindMemory,
  deleteNodes,
  locateNode,
  modelSignature,
  moveAnchors,
  moveHandle,
  nodeCount,
  nodeKey,
  openSubpathAt,
  openSubpathBlocker,
  rememberKinds,
  setAnchors,
  setHandleVector,
  setNodeKind,
  toggleNodeKind,
  toggleSegmentKind,
  toggleSegments,
  type DeleteConfirmation,
  type HandleSide,
  type ModelResult,
  type NodeKind,
  type NodeRef,
  type PathModel,
} from "../lib/editor/nodes";
import {
  adjacentSegments,
  applyModelEdit,
  documentVectorToLocal,
  findEditorObject,
  localToDocument,
  NODE_NUDGE_STEP,
  NODE_NUDGE_STEP_SHIFT,
  nodeEditProduction,
  refsFromKeys,
  resolvePathTarget,
  selectedSegments,
  stepNode,
  type PathTarget,
} from "../lib/editor/pathEdit";
import type { DocumentFrame, EditableLayerMeta, EditorObject, Point } from "../lib/editor/types";
import { fromMm, toMm } from "../lib/editor/units";
import type { EditableDocumentApi } from "./useEditableDocument";
import { describeEditFailure, isTextEntry } from "./useDrawEraseTools";

/**
 * Orquestación de la herramienta Path (M3-S05) en el Workspace: objetivo de edición (el único objeto seleccionado), selección de nodos,
 * gestos (arrastre de anchors/handles = UN comando), edición por teclado y por el panel numérico. La matemática vive en
 * `lib/editor/{nodes,pathEdit}.ts`; acá solo se sincroniza con el documento editable:
 *
 * - **Un gesto = un comando**: el arrastre usa `beginGesture/previewEdit/commitGesture` (S01) y emite UN comando al soltar; Escape lo cancela
 *   sin dejar rastro; agregar / eliminar / alternar / cerrar / abrir son un comando cada uno; las flechas fusionan ráfagas (`coalesceKey`).
 * - **Siempre desde el estado ANTES**: cada paso de un arrastre se recompone desde el `d` original + el delta total (sin acumular error).
 * - **Solo `d` cambia**: el objeto conserva id, capa, relleno, trazo y matriz. Los punteros llegan en espacio de documento y se convierten a
 *   LOCAL con la inversa de la matriz del objeto.
 * - **Una operación inválida no cambia nada** y explica el motivo en el panel.
 */

const EMPTY_KEYS: ReadonlySet<string> = new Set();
/** Tope de sanidad de un valor tecleado en el panel (mm o unidades), igual que el Inspector de objetos. */
const MAX_ABS_INPUT = 1_000_000;

export type DragRequest = { kind: "anchors"; refs: NodeRef[] } | { kind: "handle"; ref: NodeRef; side: HandleSide };

export interface DragModifiers {
  /** Restringe el arrastre al eje dominante (en documento). */
  shift: boolean;
  /** Rompe el nodo a corner mientras se arrastra su handle. */
  alt: boolean;
}

export type SelectMode = "replace" | "toggle" | "add";

export interface UsePathToolParams {
  activeTool: string;
  editable: Pick<EditableDocumentApi, "applyEdit" | "getSnapshot" | "beginGesture" | "previewEdit" | "commitGesture" | "cancelGesture">;
  /** Estructura EFECTIVA de las capas (visibilidad efectiva con Isolate): para rechazar capas bloqueadas u ocultas. */
  layers: readonly EditableLayerMeta[];
  /** Selección de OBJETOS EN VIVO (incluye la previsualización de un gesto en curso). */
  selectedObjects: readonly EditorObject[];
  /** Área de trabajo vigente: las coordenadas del panel son relativas a su origen. */
  frame: DocumentFrame;
  /** mm por unidad de documento, o `null` sin escala física (entonces el panel trabaja en unidades `u`). */
  mmFactor: number | null;
  /** Mensaje de confirmación de la última acción (barra de estado del canvas). */
  onNotice: (text: string | null) => void;
  /** Click sobre otro objeto estando en modo Path: el shell lo selecciona. */
  onPickObject: (objectId: string) => void;
  /** Escape / Enter: sale de la herramienta. */
  onExit: () => void;
}

interface NodeSelection {
  objectId: string;
  /** Estructura del modelo para la que valen los índices: si cambia (agregar/eliminar un nodo, deshacer...) la selección deja de aplicar. */
  signature: string;
  keys: ReadonlySet<string>;
}

interface DragSession {
  objectId: string;
  request: DragRequest;
  inverse: NonNullable<ReturnType<typeof invertMatrix>>;
  /** Handle (local) al empezar el arrastre: el handle sigue al puntero conservando el agarre. */
  startHandle: Point | null;
}

export interface HandleInfo {
  /** Largo en mm (o u) medido en el espacio de documento. */
  length: number;
  /** Ángulo en grados: `atan2(dy, dx)` en documento (0° = derecha, 90° = abajo). */
  angle: number;
}

export interface PathPanelModel {
  status: PathTarget["status"];
  /** Por qué no se puede editar (si `status` no es `ok`). */
  message: string | null;
  layerName: string | null;
  unitLabel: "mm" | "u";
  subpathCount: number;
  nodeCount: number;
  selectedCount: number;
  activeSubpath: { index: number; nodes: number; closed: boolean } | null;
  /** Tipo común de la selección, `"mixed"` si difieren, `null` sin selección. */
  kind: NodeKind | "mixed" | null;
  /** Coordenadas del/los nodo(s) seleccionado(s) en mm (u), relativas al área de trabajo; `null` si no hay selección o los valores difieren. */
  x: number | null;
  y: number | null;
  /** Handles del nodo seleccionado (solo con UN nodo): `null` = ese lado no tiene handle. */
  handles: { in: HandleInfo | null; out: HandleInfo | null } | null;
  segments: { before: { curved: boolean } | null; after: { curved: boolean } | null; selected: number; selectedCurved: number };
  canClose: boolean;
  canOpen: boolean;
  canDelete: boolean;
  /** Eliminar dejaría subpaths degenerados: se espera la confirmación del usuario. */
  confirm: DeleteConfirmation | null;
  /** Último error de una operación (el panel lo muestra como alerta). */
  error: string | null;
  setKind: (kind: NodeKind) => void;
  commitCoordinate: (axis: "x" | "y", value: number) => string | null;
  commitHandle: (side: HandleSide, field: "length" | "angle", value: number) => string | null;
  toggleSegment: (which: "before" | "after" | "selected") => void;
  closeActive: () => void;
  openAtSelected: () => void;
  deleteSelected: () => void;
  confirmDelete: () => void;
  cancelConfirm: () => void;
  step: (direction: 1 | -1) => void;
  selectAll: () => void;
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

const KIND_LABEL: Record<NodeKind, string> = { corner: "esquina", smooth: "suave", symmetric: "simétrico" };

export function usePathTool({ activeTool, editable, layers, selectedObjects, frame, mmFactor, onNotice, onPickObject, onExit }: UsePathToolParams) {
  const active = activeTool === "path";
  const { applyEdit, getSnapshot, beginGesture, previewEdit, commitGesture, cancelGesture } = editable;
  const [memory] = useState(() => createKindMemory());
  const [version, setVersion] = useState(0);
  const [selection, setSelection] = useState<NodeSelection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<DeleteConfirmation | null>(null);
  const dragRef = useRef<DragSession | null>(null);

  const target = useMemo<PathTarget | null>(
    // `version` fuerza el re-cálculo cuando solo cambió una etiqueta de nodo (la geometría, y por lo tanto `selectedObjects`, no cambia).
    () => (active ? resolvePathTarget(selectedObjects, layers, memory) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [active, selectedObjects, layers, memory, version],
  );
  const object = target?.status === "ok" ? target.object : null;
  const model = target?.status === "ok" ? target.model : null;
  const signature = model ? modelSignature(model) : "";
  const keys = selection && object && selection.objectId === object.id && selection.signature === signature ? selection.keys : EMPTY_KEYS;
  const refs = useMemo(() => (model ? refsFromKeys(model, keys) : []), [model, keys]);

  const unit = mmFactor === null ? "u" : "mm";
  const toDisplay = useCallback((units: number) => (mmFactor === null ? units : toMm(units, mmFactor)), [mmFactor]);
  const fromDisplay = useCallback((value: number) => (mmFactor === null ? value : fromMm(value, mmFactor)), [mmFactor]);

  // Último estado en refs: los handlers de abajo son estables pero siempre leen lo vigente al momento del gesto / la tecla.
  const latest = useRef({ target, object, model, keys, refs, frame, onNotice, onPickObject, onExit, toDisplay, fromDisplay, confirm });
  useEffect(() => {
    latest.current = { target, object, model, keys, refs, frame, onNotice, onPickObject, onExit, toDisplay, fromDisplay, confirm };
  });

  const setSelectionTo = useCallback((objectId: string, nextModel: PathModel, nextRefs: readonly NodeRef[]) => {
    setSelection({ objectId, signature: modelSignature(nextModel), keys: new Set(nextRefs.map(nodeKey)) });
  }, []);

  // ---- Selección ----

  const selectNodes = useCallback(
    (picked: readonly NodeRef[], mode: SelectMode) => {
      const state = latest.current;
      if (!state.object || !state.model) return;
      setError(null);
      setConfirm(null);
      const next = new Set<string>(mode === "replace" ? [] : state.keys);
      for (const ref of picked) {
        const key = nodeKey(ref);
        if (mode === "toggle" && next.has(key)) next.delete(key);
        else next.add(key);
      }
      setSelection({ objectId: state.object.id, signature: modelSignature(state.model), keys: next });
    },
    [],
  );

  const clearSelection = useCallback(() => {
    setError(null);
    setConfirm(null);
    setSelection(null);
  }, []);

  const selectAll = useCallback(() => {
    const state = latest.current;
    if (!state.object || !state.model) return;
    const index = state.refs.length > 0 ? state.refs[0].subpath : 0;
    const subpath = state.model.subpaths[index];
    if (!subpath) return;
    setError(null);
    setSelectionTo(
      state.object.id,
      state.model,
      subpath.nodes.map((_, node) => ({ subpath: index, node })),
    );
  }, [setSelectionTo]);

  const step = useCallback(
    (direction: 1 | -1) => {
      const state = latest.current;
      if (!state.object || !state.model) return;
      const next = stepNode(state.model, state.refs.length > 0 ? state.refs[state.refs.length - 1] : null, direction);
      if (next) setSelectionTo(state.object.id, state.model, [next]);
    },
    [setSelectionTo],
  );

  // ---- Ediciones de un solo paso (UN comando) ----

  /**
   * Corre una operación del modelo sobre el objeto y la aplica como UN comando. Se planifica primero contra el estado CONFIRMADO para poder
   * explicar el rechazo (los productores de `applyEdit` no pueden devolver errores); `applyEdit` vuelve a derivar lo mismo del estado que recibe.
   * `silent`: el error se devuelve pero no se muestra en el panel (lo muestra el campo que lo originó).
   */
  const runEdit = useCallback(
    (label: string, edit: (current: PathModel) => ModelResult, options: { coalesceKey?: string; silent?: boolean } = {}): { ok: boolean; error: string | null } => {
      const state = latest.current;
      const fail = (message: string) => {
        if (!options.silent) setError(message);
        return { ok: false, error: message };
      };
      if (!state.object || !state.model) return fail("No hay un path editable seleccionado.");
      setError(null);
      setConfirm(null);
      state.onNotice(null);
      if (dragRef.current) return fail("Hay un arrastre en curso.");

      const current = findEditorObject(getSnapshot(), state.object.id);
      if (!current) return fail("El objeto ya no existe.");
      const outcome = applyModelEdit(current, memory, edit);
      if (!outcome.ok) {
        if (outcome.confirm) {
          setConfirm(outcome.confirm);
          return { ok: false, error: outcome.error };
        }
        return fail(outcome.error);
      }
      if (!outcome.changed) {
        // Sin cambio de geometría; si solo cambió la etiqueta de un nodo se recuerda y se refresca el panel (no es un comando: no hay nada que deshacer).
        if (outcome.kinds && outcome.d !== undefined) {
          rememberKinds(memory, outcome.d, outcome.kinds);
          setVersion((value) => value + 1);
        }
        return { ok: true, error: null };
      }

      const objectId = current.id;
      const result = applyEdit(label, (document) => nodeEditProduction(document, objectId, memory, edit), options.coalesceKey ? { coalesceKey: options.coalesceKey } : undefined);
      if (!result.applied) return fail(describeEditFailure(result));
      rememberKinds(memory, outcome.object.d, outcome.kinds);
      if (outcome.selection) setSelectionTo(objectId, outcome.model, outcome.selection);
      return { ok: true, error: null };
    },
    [applyEdit, getSnapshot, memory, setSelectionTo],
  );

  const addNode = useCallback((subpath: number, segment: number, t: number) => runEdit("Agregar nodo", (current) => addNodeOnSegment(current, subpath, segment, t)), [runEdit]);

  const toggleKindAt = useCallback(
    (ref: NodeRef) => {
      const state = latest.current;
      const located = state.model ? locateNode(state.model, ref) : null;
      if (!state.object || !state.model || !located) return;
      runEdit(`Nodo ${located.node.kind === "corner" ? "suave" : "esquina"}`, (current) => toggleNodeKind(current, ref));
      // El nodo alternado queda seleccionado, como cuando se hace click sobre él.
      setSelectionTo(state.object.id, state.model, [ref]);
    },
    [runEdit, setSelectionTo],
  );

  const setKind = useCallback(
    (kind: NodeKind) => {
      const state = latest.current;
      if (state.refs.length === 0) return;
      const picked = state.refs;
      runEdit(`Nodo ${KIND_LABEL[kind]}`, (current) => setNodeKind(current, picked, kind));
    },
    [runEdit],
  );

  const deleteSelected = useCallback(
    (removeSubpaths = false) => {
      const state = latest.current;
      if (state.refs.length === 0) return;
      const picked = state.refs;
      const count = picked.length;
      runEdit(removeSubpaths ? "Eliminar subpath" : `Eliminar ${plural(count, "nodo", "nodos")}`, (current) => deleteNodes(current, picked, { removeSubpaths }));
    },
    [runEdit],
  );

  const confirmDelete = useCallback(() => deleteSelected(true), [deleteSelected]);
  const cancelConfirm = useCallback(() => setConfirm(null), []);

  const nudge = useCallback(
    (dx: number, dy: number, big: boolean) => {
      const state = latest.current;
      if (!state.object || state.refs.length === 0) return;
      const inverse = invertMatrix(state.object.matrix);
      if (!inverse) return;
      const amount = big ? NODE_NUDGE_STEP_SHIFT : NODE_NUDGE_STEP;
      const delta = documentVectorToLocal(inverse, { x: dx * amount, y: dy * amount });
      const picked = state.refs;
      // Una ráfaga de flechas sobre los MISMOS nodos es un solo comando de undo.
      runEdit(`Mover ${plural(picked.length, "nodo", "nodos")}`, (current) => moveAnchors(current, picked, delta), {
        coalesceKey: `path-nudge:${state.object.id}:${[...state.keys].sort().join(",")}`,
      });
    },
    [runEdit],
  );

  // ---- Arrastre (gesto) ----

  const beginDrag = useCallback(
    (request: DragRequest): boolean => {
      const state = latest.current;
      if (!state.object || !state.model || dragRef.current) return false;
      const current = findEditorObject(getSnapshot(), state.object.id);
      const inverse = current ? invertMatrix(current.matrix) : null;
      if (!current || !inverse) return false;
      let startHandle: Point | null = null;
      if (request.kind === "handle") {
        const located = locateNode(state.model, request.ref);
        startHandle = located ? (request.side === "in" ? located.node.handleIn : located.node.handleOut) : null;
        if (!startHandle) return false;
      }
      setError(null);
      setConfirm(null);
      state.onNotice(null);
      if (!beginGesture()) {
        setError("Hay una transformación pendiente: aplicala (Apply) o cancelala (Cancel) antes de editar.");
        return false;
      }
      dragRef.current = { objectId: current.id, request, inverse, startHandle };
      return true;
    },
    [beginGesture, getSnapshot],
  );

  const dragBy = useCallback(
    (delta: Point, modifiers: DragModifiers) => {
      const drag = dragRef.current;
      if (!drag) return;
      const restricted = modifiers.shift ? (Math.abs(delta.x) >= Math.abs(delta.y) ? { x: delta.x, y: 0 } : { x: 0, y: delta.y }) : delta;
      const local = documentVectorToLocal(drag.inverse, restricted);
      const { request, startHandle } = drag;
      // Cada paso parte del estado ANTES del gesto (previewEdit): el resultado depende solo de (antes, delta total).
      previewEdit((document) =>
        nodeEditProduction(document, drag.objectId, memory, (current) =>
          request.kind === "anchors"
            ? moveAnchors(current, request.refs, local)
            : moveHandle(current, request.ref, request.side, { x: (startHandle as Point).x + local.x, y: (startHandle as Point).y + local.y }, { breakKind: modifiers.alt }),
        ),
      );
    },
    [memory, previewEdit],
  );

  const endDrag = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    const label = drag.request.kind === "anchors" ? `Mover ${plural(drag.request.refs.length, "nodo", "nodos")}` : "Mover handle";
    const result = commitGesture(label);
    if (result.applied) {
      if (memory.live) rememberKinds(memory, memory.live.d, memory.live.kinds);
    } else if (result.reason === "blocked") {
      setError(describeEditFailure(result));
    }
  }, [commitGesture, memory]);

  const cancelDrag = useCallback(() => {
    if (!dragRef.current) return;
    dragRef.current = null;
    cancelGesture();
    memory.live = null;
    setVersion((value) => value + 1);
  }, [cancelGesture, memory]);

  // ---- Panel numérico ----

  const commitCoordinate = useCallback(
    (axis: "x" | "y", value: number): string | null => {
      const state = latest.current;
      if (!state.object || !state.model || state.refs.length === 0) return "No hay nodos seleccionados.";
      if (!Number.isFinite(value) || Math.abs(value) > MAX_ABS_INPUT) return `El valor está fuera de rango (máximo ±${MAX_ABS_INPUT.toLocaleString("es-AR")}). No se aplicó ningún cambio.`;
      const matrix = state.object.matrix;
      const inverse = invertMatrix(matrix);
      if (!inverse) return "La transformación del objeto no es invertible.";
      const documentValue = state.fromDisplay(value) + (axis === "x" ? state.frame.x : state.frame.y);
      const model = state.model;
      const entries = state.refs.flatMap((ref) => {
        const located = locateNode(model, ref);
        if (!located) return [];
        const inDocument = localToDocument(matrix, located.node.anchor);
        const moved = axis === "x" ? { x: documentValue, y: inDocument.y } : { x: inDocument.x, y: documentValue };
        return [{ ref, point: localToDocument(inverse, moved) }];
      });
      return runEdit(`Mover ${plural(entries.length, "nodo", "nodos")} (Inspector)`, (current) => setAnchors(current, entries), { silent: true }).error;
    },
    [runEdit],
  );

  const commitHandle = useCallback(
    (side: HandleSide, field: "length" | "angle", value: number): string | null => {
      const state = latest.current;
      if (!state.object || !state.model || state.refs.length !== 1) return "Seleccioná un solo nodo para editar sus handles.";
      if (!Number.isFinite(value) || Math.abs(value) > MAX_ABS_INPUT) return `El valor está fuera de rango (máximo ±${MAX_ABS_INPUT.toLocaleString("es-AR")}). No se aplicó ningún cambio.`;
      if (field === "length" && value < 0) return "El largo del handle no puede ser negativo. No se aplicó ningún cambio.";
      const ref = state.refs[0];
      const located = locateNode(state.model, ref);
      const handle = located ? (side === "in" ? located.node.handleIn : located.node.handleOut) : null;
      if (!located || !handle) return "Ese lado del nodo no tiene handle: es un segmento recto. Curvá el segmento para crearlos.";
      const matrix = state.object.matrix;
      const anchorInDocument = localToDocument(matrix, located.node.anchor);
      const handleInDocument = localToDocument(matrix, handle);
      const vector = { x: handleInDocument.x - anchorInDocument.x, y: handleInDocument.y - anchorInDocument.y };
      const length = field === "length" ? state.fromDisplay(value) : Math.hypot(vector.x, vector.y);
      const angle = field === "angle" ? value : (Math.atan2(vector.y, vector.x) * 180) / Math.PI;
      return runEdit("Editar handle (Inspector)", (current) => setHandleVector(current, ref, side, length, angle, matrix), { silent: true }).error;
    },
    [runEdit],
  );

  const toggleSegment = useCallback(
    (which: "before" | "after" | "selected") => {
      const state = latest.current;
      if (!state.model || state.refs.length === 0) return;
      if (which === "selected") {
        const segments = selectedSegments(state.model, state.keys);
        runEdit(`Alternar ${plural(segments.length, "segmento", "segmentos")} recto/curvo`, (current) => toggleSegments(current, segments));
        return;
      }
      const around = adjacentSegments(state.model, state.refs[0]);
      const segment = which === "before" ? around.before : around.after;
      if (segment) runEdit("Alternar segmento recto/curvo", (current) => toggleSegmentKind(current, segment.subpath, segment.segment));
    },
    [runEdit],
  );

  const activeSubpathIndex = (): number | null => {
    if (!model) return null;
    if (refs.length > 0) return refs[0].subpath;
    return model.subpaths.length === 1 ? 0 : null;
  };

  const closeActive = useCallback(() => {
    const state = latest.current;
    if (!state.model) return;
    const index = state.refs.length > 0 ? state.refs[0].subpath : state.model.subpaths.length === 1 ? 0 : null;
    if (index === null) return;
    runEdit("Cerrar subpath", (current) => closeSubpath(current, index));
  }, [runEdit]);

  const openAtSelected = useCallback(() => {
    const state = latest.current;
    if (state.refs.length !== 1) return;
    const ref = state.refs[0];
    runEdit("Abrir subpath", (current) => openSubpathAt(current, ref));
  }, [runEdit]);

  // ---- Salir de la herramienta ----

  // Cambiar de herramienta descarta lo efímero (selección de nodos, mensajes, arrastre a medias, tipos recordados); los cambios ya están comiteados gesto a gesto.
  useEffect(() => {
    if (active) return;
    if (dragRef.current) {
      dragRef.current = null;
      cancelGesture();
    }
    setSelection(null);
    setError(null);
    setConfirm(null);
    memory.saved.clear();
    memory.live = null;
  }, [active, cancelGesture, memory]);

  // Un arrastre a medias no sobrevive al desmontaje.
  useEffect(
    () => () => {
      if (dragRef.current) {
        dragRef.current = null;
        cancelGesture();
      }
    },
    [cancelGesture],
  );

  // ---- Teclado (ventana, como Draw): Escape / Enter salen; Suprimir elimina; flechas empujan; Ctrl+A selecciona el subpath activo ----
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || isTextEntry(event.target)) return;
      const state = latest.current;
      const editing = state.target?.status === "ok";
      if (event.ctrlKey || event.metaKey) {
        if (editing && event.key.toLowerCase() === "a") {
          event.preventDefault();
          selectAll();
        }
        return;
      }
      switch (event.key) {
        case "Escape":
          event.preventDefault();
          if (state.confirm) cancelConfirm();
          else if (state.keys.size > 0) clearSelection();
          else state.onExit();
          return;
        case "Enter":
          event.preventDefault();
          state.onExit();
          return;
        case "Delete":
        case "Backspace":
          if (!editing || state.keys.size === 0) return;
          event.preventDefault();
          deleteSelected();
          return;
        case "ArrowUp":
        case "ArrowDown":
        case "ArrowLeft":
        case "ArrowRight":
          if (!editing || state.keys.size === 0) return;
          event.preventDefault();
          nudge(event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0, event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0, event.shiftKey);
          return;
        default:
          return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, selectAll, clearSelection, cancelConfirm, deleteSelected, nudge]);

  // ---- Vista del panel ----

  const panel: PathPanelModel = useMemo(() => {
    const selectedNodes = model ? refs.flatMap((ref) => locateNode(model, ref)?.node ?? []) : [];
    const kinds = new Set(selectedNodes.map((node) => node.kind));
    const common = (values: number[]): number | null => {
      if (values.length === 0) return null;
      const shown = values.map((value) => Number(value.toFixed(3)));
      return shown.every((value) => value === shown[0]) ? shown[0] : null;
    };
    const coordinates = object ? refs.map((ref) => localToDocument(object.matrix, locateNode(model as PathModel, ref)!.node.anchor)) : [];
    const handleInfo = (handle: Point | null, anchor: Point): HandleInfo | null => {
      if (!handle || !object) return null;
      const from = localToDocument(object.matrix, anchor);
      const to = localToDocument(object.matrix, handle);
      const vector = { x: to.x - from.x, y: to.y - from.y };
      return { length: toDisplay(Math.hypot(vector.x, vector.y)), angle: (Math.atan2(vector.y, vector.x) * 180) / Math.PI };
    };
    const single = refs.length === 1 && model ? locateNode(model, refs[0]) : null;
    const around = model && refs.length === 1 ? adjacentSegments(model, refs[0]) : { before: null, after: null };
    const curved = (segment: { subpath: number; segment: number } | null) => {
      const subpath = segment && model ? model.subpaths[segment.subpath] : undefined;
      if (!segment || !subpath) return null;
      const ends = [subpath.nodes[segment.segment], subpath.nodes[(segment.segment + 1) % subpath.nodes.length]];
      return { curved: ends[0].handleOut !== null || ends[1].handleIn !== null };
    };
    const picked = model ? selectedSegments(model, keys) : [];
    const selectedCurved = model
      ? picked.filter((segment) => {
          const info = curved(segment);
          return info?.curved === true;
        }).length
      : 0;
    const subpathIndex = activeSubpathIndex();
    const subpath = model && subpathIndex !== null ? model.subpaths[subpathIndex] : undefined;
    const layerName = object ? (layers.find((layer) => layer.groupId === object.layerGroupId)?.name ?? null) : null;

    return {
      status: target?.status ?? "none",
      message: target && target.status !== "ok" ? target.message : null,
      layerName,
      unitLabel: unit,
      subpathCount: model?.subpaths.length ?? 0,
      nodeCount: model ? nodeCount(model) : 0,
      selectedCount: refs.length,
      activeSubpath: subpath && subpathIndex !== null ? { index: subpathIndex, nodes: subpath.nodes.length, closed: subpath.closed } : null,
      kind: selectedNodes.length === 0 ? null : kinds.size === 1 ? selectedNodes[0].kind : "mixed",
      x: common(coordinates.map((point) => toDisplay(point.x - frame.x))),
      y: common(coordinates.map((point) => toDisplay(point.y - frame.y))),
      handles: single ? { in: handleInfo(single.node.handleIn, single.node.anchor), out: handleInfo(single.node.handleOut, single.node.anchor) } : null,
      segments: { before: curved(around.before), after: curved(around.after), selected: picked.length, selectedCurved },
      canClose: model !== null && subpathIndex !== null && closeSubpathBlocker(model, subpathIndex) === null,
      canOpen: model !== null && refs.length === 1 && openSubpathBlocker(model, refs[0]) === null,
      canDelete: refs.length > 0,
      confirm,
      error,
      setKind,
      commitCoordinate,
      commitHandle,
      toggleSegment,
      closeActive,
      openAtSelected,
      deleteSelected: () => deleteSelected(false),
      confirmDelete,
      cancelConfirm,
      step,
      selectAll,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, model, object, refs, keys, layers, unit, toDisplay, frame.x, frame.y, confirm, error, setKind, commitCoordinate, commitHandle, toggleSegment, closeActive, openAtSelected, deleteSelected, confirmDelete, cancelConfirm, step, selectAll]);

  return {
    active,
    target,
    object,
    model,
    keys,
    panel,
    surface: {
      onSelectNodes: selectNodes,
      onClearSelection: clearSelection,
      onBeginDrag: beginDrag,
      onDragBy: dragBy,
      onEndDrag: endDrag,
      onCancelDrag: cancelDrag,
      onAddNode: addNode,
      onToggleKind: toggleKindAt,
      onPickObject: (objectId: string) => {
        setError(null);
        latest.current.onPickObject(objectId);
      },
    },
  };
}

export type PathTool = ReturnType<typeof usePathTool>;
