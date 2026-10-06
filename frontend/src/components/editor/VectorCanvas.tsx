import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { Group, Layer, Path, Rect as KonvaRect, Stage, Transformer } from "react-konva";
import type Konva from "konva";
import type { CanvasTransform } from "../../hooks/useCanvasTransform";
import type { ApplyEditResult, EditableDocumentApi } from "../../hooks/useEditableDocument";
import type { VectorDocumentLayer } from "../../hooks/useVectorDocument";
import { composeMatrices, invertMatrix, isFiniteMatrix, matricesAlmostEqual, matrixToKonvaProps } from "../../lib/editor/matrix";
import { hitTestAll, objectsInRect, rectFromPoints } from "../../lib/editor/objects";
import { cycleHit, removeObjects, replaceObjects, resolveSelection, splitByLock, toggleId } from "../../lib/editor/selection";
import { translate } from "../../lib/editor/transform";
import type { EditableDocument, EditorObject, Point, Rect } from "../../lib/editor/types";
import { screenToleranceToDocument } from "../../lib/editor/units";
import { screenToDocument, type ViewportParams } from "../../lib/editor/viewport";
import { IDENTITY_MATRIX, type AffineMatrix } from "../../lib/svgTransform";
import { EditorLayerNodes } from "./EditorLayerNodes";
import type { EditorTool } from "./EditorToolbar";

const WHEEL_ZOOM_SENSITIVITY = 0.0015;
const KEYBOARD_ZOOM_FACTOR = 1.25;
const KEYBOARD_PAN_STEP_PX = 40;

/** Arrastre mínimo (px de PANTALLA) para que un click pase a ser drag/marquee: evita mover por un temblor del mouse. */
const DRAG_THRESHOLD_PX = 3;
/** Radio de click (px de PANTALLA) alrededor del cursor: constante a cualquier zoom (se convierte a unidades de documento). */
const HIT_TOLERANCE_PX = 4;
/**
 * Convención del nudge por teclado (M3-S01, documentada en IMPL): flecha = 1 unidad de DOCUMENTO,
 * Shift+flecha = 10. Independiente del zoom (como pide el spec) y del factor mm (que puede no existir en
 * una sesión sin dimensiones físicas); el Inspector ofrece la edición en mm.
 */
const NUDGE_STEP = 1;
const NUDGE_STEP_SHIFT = 10;
/** Con más objetos seleccionados que esto no se dibuja un contorno por objeto (el Transformer ya muestra el bbox del grupo). */
const MAX_SELECTION_OUTLINES = 300;
const ACCENT = "#3a5cf5";
const LOCKED_OUTLINE = "#7a808a";
const ROTATION_SNAPS = Array.from({ length: 24 }, (_, index) => index * 15);
const EMPTY_OBJECTS: readonly EditorObject[] = [];

interface VectorCanvasProps {
  layers: VectorDocumentLayer[];
  visibility: Record<string, boolean>;
  sourceWidthPx: number;
  sourceHeightPx: number;
  /** Capa activa (M2.1): se resalta SOLO si no hay objetos seleccionados. */
  selectedGroupId: string | null;
  /** Estado editable (M3-S01): objetos por capa + applyEdit/gestos. Ver `useEditableDocument`. */
  editable: EditableDocumentApi;
  /** Objetos seleccionables (capas visibles, en orden de pintado, el último arriba) -- pool de hit-test/marquee/Select All. */
  selectableObjects: EditorObject[];
  /** Selección por ids de objeto, ya depurada contra `selectableObjects`. */
  selectedObjectIds: ReadonlySet<string>;
  /** `activeLayerId`: capa que debe quedar activa (Inspector/paleta), o null para no cambiarla. */
  onSelectObjects: (ids: string[], activeLayerId: string | null) => void;
  tool: EditorTool;
  transform: CanvasTransform;
  onZoomBy: (factor: number, anchor?: { x: number; y: number }) => void;
  onPanBy: (dx: number, dy: number) => void;
  onMeasure: (size: { width: number; height: number }) => void;
}

type Interaction =
  | {
      kind: "drag";
      pointerId: number;
      startScreen: Point;
      startDoc: Point;
      hitId: string;
      wasSelected: boolean;
      dragIds: string[];
      gestureStarted: boolean;
    }
  | {
      kind: "marquee";
      pointerId: number;
      startScreen: Point;
      startDoc: Point;
      additive: boolean;
      base: ReadonlySet<string>;
      moved: boolean;
      /** En la herramienta Move no hay marquee: el click en fondo solo limpia la selección. */
      enabled: boolean;
    };

interface TransformSession {
  anchor: string | null;
  objects: EditorObject[];
  startMatrices: Map<string, AffineMatrix>;
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Texto de feedback cuando una edición tocó objetos de capas bloqueadas (spec: "feedback visible al intentarlo"). */
function lockNotice(result: ApplyEditResult): string | null {
  if (result.skippedLockedObjects === 0) return null;
  return result.applied
    ? `${plural(result.skippedLockedObjects, "objeto está", "objetos están")} en capas bloqueadas y no se modificó.`
    : "La capa está bloqueada: no se puede modificar. Desbloqueala en el panel de Capas.";
}

function nodeMatrix(node: Konva.Node): AffineMatrix {
  const [a, b, c, d, e, f] = node.getTransform().getMatrix();
  return { a, b, c, d, e, f };
}

function moveProduction(state: EditableDocument, ids: ReadonlySet<string>, dx: number, dy: number) {
  const targets = Object.values(state.objectsByLayer)
    .flat()
    .filter((object) => ids.has(object.id));
  return replaceObjects(state, targets, (found) => translate(found, dx, dy));
}

/**
 * Motor gráfico del Workspace (M2.1-S06, Konva/react-konva -- decisión del ADR
 * de M2.1-S05) convertido en EDITOR en M3-S01 (ver `docs/ADR_EDITOR_MVP3.md`):
 *
 * - Renderiza DESDE el estado editable (`EditorObject[]` por capa, un `<Path>`
 *   por objeto, memoizado por objeto), no desde el SVG crudo. La carga de los SVG
 *   se movió a `useEditableDocument`.
 * - Selección por ids de objeto: click, Shift+click (toggle), Alt+click (cicla la
 *   pila de superpuestos), marquee, Ctrl/Cmd+A, Escape. El hit-testing es
 *   geométrico y exacto (`lib/editor/objects.ts`), con tolerancia en px de pantalla
 *   convertida a unidades de documento: los paths de Konva no escuchan eventos.
 * - Move: arrastre de la selección (un único comando al soltar, vía el gesto de
 *   `useEditableDocument`) y flechas (1 / Shift 10 unidades de documento).
 * - Scale/Rotate: `Konva.Transformer` sobre los objetos EDITABLES seleccionados; el
 *   resultado se expresa como matriz compuesta (no toca `d`) y entra como un solo
 *   comando al soltar el handle.
 * - Locks: los objetos de capas bloqueadas se seleccionan para inspeccionar pero
 *   `applyEdit` los filtra, y el canvas lo informa (aviso + insignia).
 *
 * El zoom/pan sigue siendo `useCanvasTransform` (M1-S06); el dominio
 * (`useEditableDocument`) sigue siendo la fuente de verdad: Konva solo dibuja e
 * interpreta gestos -- nunca "posee" el documento.
 */
export function VectorCanvas({
  layers,
  visibility,
  sourceWidthPx,
  sourceHeightPx,
  selectedGroupId,
  editable,
  selectableObjects,
  selectedObjectIds,
  onSelectObjects,
  tool,
  transform,
  onZoomBy,
  onPanBy,
  onMeasure,
}: VectorCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<Konva.Stage | null>(null);
  const transformerRef = useRef<Konva.Transformer | null>(null);
  const nodesRef = useRef<Map<string, Konva.Path>>(new Map());
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const dragStateRef = useRef<{ pointerId: number; lastX: number; lastY: number } | null>(null);
  const pendingPanRef = useRef<{ dx: number; dy: number } | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const [spacePanHeld, setSpacePanHeld] = useState(false);
  const [shiftHeld, setShiftHeld] = useState(false);
  const interactionRef = useRef<Interaction | null>(null);
  const transformSessionRef = useRef<TransformSession | null>(null);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const effectiveTool: EditorTool = spacePanHeld ? "pan" : tool;
  const isEditingTool = effectiveTool === "select" || effectiveTool === "move";
  const { objectsByLayer, layerStatus, applyEdit, beginGesture, previewEdit, commitGesture, cancelGesture, retry } = editable;

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const size = { width: entry.contentRect.width, height: entry.contentRect.height };
      setContainerSize(size);
      onMeasure(size);
    });
    observer.observe(node);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Zoom con la rueda del mouse, centrado en el puntero -- listener nativo
  // (no `onWheel` de JSX) por la misma razón documentada en
  // `components/vectorize/VectorCanvas.tsx`: React adjunta "wheel" como
  // passive por defecto, y acá necesitamos `preventDefault()` para que la
  // rueda no scrollee la página en vez de zoomear el canvas.
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = node.getBoundingClientRect();
      const anchor = {
        x: event.clientX - (rect.left + rect.width / 2),
        y: event.clientY - (rect.top + rect.height / 2),
      };
      const factor = Math.exp(-event.deltaY * WHEEL_ZOOM_SENSITIVITY);
      onZoomBy(factor, anchor);
    };

    node.addEventListener("wheel", handleWheel, { passive: false });
    return () => node.removeEventListener("wheel", handleWheel);
  }, [onZoomBy]);

  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current);
    };
  }, []);

  // Shift sostenido: pasos de 15° al rotar con el handle (Konva solo ofrece `rotationSnaps` fijos).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Shift") setShiftHeld(event.type === "keydown");
    };
    const onBlur = () => setShiftHeld(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // Un gesto a medias no sobrevive al desmontaje del canvas.
  useEffect(() => cancelGesture, [cancelGesture]);

  const lockedLayerIds = useMemo(() => new Set(layers.filter((layer) => layer.locked).map((layer) => layer.groupId)), [layers]);
  const selectedObjects = useMemo(() => resolveSelection(selectableObjects, selectedObjectIds), [selectableObjects, selectedObjectIds]);
  const { editable: editableSelected, locked: lockedSelected } = useMemo(() => splitByLock(selectedObjects, lockedLayerIds), [selectedObjects, lockedLayerIds]);
  const editableSelectionKey = useMemo(() => editableSelected.map((object) => object.id).join("|"), [editableSelected]);

  const visibleLayers = useMemo(() => layers.filter((layer) => visibility[layer.groupId] ?? true), [layers, visibility]);
  const hasContainerSize = containerSize.width > 0 && containerSize.height > 0;
  const showTransformer = effectiveTool === "select" && editableSelected.length > 0;
  const readyLayersKey = visibleLayers.map((layer) => `${layer.groupId}:${layerStatus[layer.groupId] ?? ""}`).join("|");

  const registerNode = useCallback((id: string, node: Konva.Path | null) => {
    if (node) nodesRef.current.set(id, node);
    else nodesRef.current.delete(id);
  }, []);

  // El Transformer se engancha a los nodos de Konva de los objetos EDITABLES seleccionados. Se reengancha solo
  // cuando cambia QUÉ está seleccionado (no en cada frame de drag): mientras se arrastra, el Transformer sigue a
  // los nodos por sí mismo (escucha sus cambios de transformación).
  useEffect(() => {
    const transformer = transformerRef.current;
    if (!transformer) return;
    const nodes = showTransformer
      ? editableSelectionKey
          .split("|")
          .map((id) => nodesRef.current.get(id))
          .filter((node): node is Konva.Path => node !== undefined)
      : [];
    transformer.nodes(nodes);
    transformer.getLayer()?.batchDraw();
  }, [editableSelectionKey, showTransformer, hasContainerSize, readyLayersKey]);

  const viewport: ViewportParams = {
    containerWidth: containerSize.width,
    containerHeight: containerSize.height,
    panX: transform.panX,
    panY: transform.panY,
    scale: transform.scale,
    sourceWidth: sourceWidthPx,
    sourceHeight: sourceHeightPx,
  };

  const toContainerPoint = (event: { clientX: number; clientY: number }): Point => {
    const rect = containerRef.current?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  };

  const isTransformerAnchorAt = (point: Point): boolean => {
    const stage = stageRef.current;
    const transformer = transformerRef.current;
    if (!stage || !transformer || transformer.nodes().length === 0) return false;
    try {
      const shape = stage.getIntersection(point);
      return Boolean(shape && shape.getParent() === transformer && shape.name().includes("_anchor"));
    } catch {
      return false;
    }
  };

  const flushPendingPan = () => {
    rafIdRef.current = null;
    const pending = pendingPanRef.current;
    pendingPanRef.current = null;
    if (pending) onPanBy(pending.dx, pending.dy);
  };

  const releaseCapture = (event: ReactPointerEvent<HTMLDivElement>) => {
    try {
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture?.(event.pointerId);
      }
    } catch {
      // noop.
    }
  };

  const reportEditResult = (result: ApplyEditResult) => {
    setNotice(lockNotice(result));
  };

  // ---- Selección / Move por puntero ----

  const beginSelectionInteraction = (event: ReactPointerEvent<HTMLDivElement>) => {
    const screenPoint = toContainerPoint(event);
    if (isTransformerAnchorAt(screenPoint)) return; // el Transformer maneja su propio handle
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // noop: continuar sin captura de puntero (ej. entorno de test).
    }

    const docPoint = screenToDocument(screenPoint, viewport);
    const stack = hitTestAll(selectableObjects, docPoint, screenToleranceToDocument(HIT_TOLERANCE_PX, transform.scale));
    setNotice(null);

    // Alt+click: recorre la pila de objetos superpuestos hacia abajo.
    if (event.altKey && stack.length > 0) {
      const picked = cycleHit(stack, selectedObjectIds);
      if (picked) onSelectObjects([picked.id], picked.layerGroupId);
      return;
    }

    const hit = stack[0] ?? null;
    if (hit) {
      if (event.shiftKey) {
        const next = toggleId(selectedObjectIds, hit.id);
        onSelectObjects([...next], next.has(hit.id) ? hit.layerGroupId : null);
        return;
      }
      const wasSelected = selectedObjectIds.has(hit.id);
      if (!wasSelected) onSelectObjects([hit.id], hit.layerGroupId);
      interactionRef.current = {
        kind: "drag",
        pointerId: event.pointerId,
        startScreen: screenPoint,
        startDoc: docPoint,
        hitId: hit.id,
        wasSelected,
        // Click sobre un objeto ya seleccionado arrastra TODA la selección; sobre uno no seleccionado, solo ese.
        dragIds: wasSelected ? [...selectedObjectIds] : [hit.id],
        gestureStarted: false,
      };
      return;
    }

    interactionRef.current = {
      kind: "marquee",
      pointerId: event.pointerId,
      startScreen: screenPoint,
      startDoc: docPoint,
      additive: event.shiftKey,
      base: new Set(selectedObjectIds),
      moved: false,
      enabled: effectiveTool === "select",
    };
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;

    if (effectiveTool === "pan") {
      try {
        event.currentTarget.setPointerCapture?.(event.pointerId);
      } catch {
        // noop: continuar sin captura de puntero (ej. entorno de test).
      }
      dragStateRef.current = { pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY };
      return;
    }
    if (isEditingTool) beginSelectionInteraction(event);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (effectiveTool === "pan") {
      const drag = dragStateRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const dx = event.clientX - drag.lastX;
      const dy = event.clientY - drag.lastY;
      drag.lastX = event.clientX;
      drag.lastY = event.clientY;

      const pending = pendingPanRef.current ?? { dx: 0, dy: 0 };
      pending.dx += dx;
      pending.dy += dy;
      pendingPanRef.current = pending;

      if (rafIdRef.current === null) {
        rafIdRef.current = requestAnimationFrame(flushPendingPan);
      }
      return;
    }

    const interaction = interactionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return;
    const screenPoint = toContainerPoint(event);
    const pastThreshold = Math.hypot(screenPoint.x - interaction.startScreen.x, screenPoint.y - interaction.startScreen.y) >= DRAG_THRESHOLD_PX;

    if (interaction.kind === "drag") {
      if (!interaction.gestureStarted) {
        if (!pastThreshold) return;
        beginGesture();
        interaction.gestureStarted = true;
      }
      const docPoint = screenToDocument(screenPoint, viewport);
      // Cada frame se recompone desde el estado ANTES del gesto + el delta total (sin acumular error).
      const ids = new Set(interaction.dragIds);
      const result = previewEdit((state) => moveProduction(state, ids, docPoint.x - interaction.startDoc.x, docPoint.y - interaction.startDoc.y));
      if (!result.applied && result.reason === "blocked") setNotice(lockNotice(result));
      return;
    }

    if (!interaction.moved && !pastThreshold) return;
    interaction.moved = true;
    if (interaction.enabled) setMarquee(rectFromPoints(interaction.startDoc, screenToDocument(screenPoint, viewport)));
  };

  const finishSelectionInteraction = (event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const interaction = interactionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return;
    interactionRef.current = null;
    releaseCapture(event);

    if (interaction.kind === "drag") {
      if (interaction.gestureStarted) {
        if (cancelled) {
          cancelGesture();
          return;
        }
        const count = interaction.dragIds.length;
        reportEditResult(commitGesture(`Mover ${plural(count, "objeto", "objetos")}`));
        return;
      }
      // Click simple sobre un objeto de una multi-selección: la selección se reduce a ese objeto.
      if (!cancelled && interaction.wasSelected && selectedObjectIds.size > 1 && !event.shiftKey) {
        const hit = selectableObjects.find((object) => object.id === interaction.hitId);
        onSelectObjects([interaction.hitId], hit?.layerGroupId ?? null);
      }
      return;
    }

    setMarquee(null);
    if (cancelled) return;
    if (!interaction.moved) {
      // Click en fondo vacío: limpia la selección (Shift+click en fondo no la toca).
      if (!interaction.additive) onSelectObjects([], null);
      return;
    }
    if (!interaction.enabled) return;
    const rect = rectFromPoints(interaction.startDoc, screenToDocument(toContainerPoint(event), viewport));
    const inside = objectsInRect(selectableObjects, rect);
    const ids = new Set(interaction.additive ? interaction.base : []);
    for (const object of inside) ids.add(object.id);
    onSelectObjects([...ids], inside.length > 0 ? inside[inside.length - 1].layerGroupId : null);
  };

  const endPanDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragStateRef.current?.pointerId !== event.pointerId) return;
    dragStateRef.current = null;
    releaseCapture(event);
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    finishSelectionInteraction(event, false);
    endPanDrag(event);
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    finishSelectionInteraction(event, true);
    endPanDrag(event);
  };

  // ---- Transformer (scale / rotate) ----

  const handleTransformStart = () => {
    const transformer = transformerRef.current;
    const objects = editableSelected;
    const startMatrices = new Map<string, AffineMatrix>();
    for (const object of objects) {
      const node = nodesRef.current.get(object.id);
      if (node) startMatrices.set(object.id, nodeMatrix(node));
    }
    transformSessionRef.current = { anchor: transformer?.getActiveAnchor() ?? null, objects, startMatrices };
    setNotice(null);
  };

  const handleTransformEnd = () => {
    const session = transformSessionRef.current;
    transformSessionRef.current = null;
    if (!session) return;

    // Matriz de gesto por nodo = (matriz final de Konva) × (matriz inicial de Konva)⁻¹, aplicada sobre la matriz EXACTA
    // del objeto: el error de descomposición de Konva se cancela y la matriz se recompone desde el estado "antes".
    const updates = new Map<string, AffineMatrix>();
    let valid = true;
    for (const object of session.objects) {
      const node = nodesRef.current.get(object.id);
      const start = session.startMatrices.get(object.id);
      if (!node || !start) continue;
      const end = nodeMatrix(node);
      const inverse = invertMatrix(start);
      const gesture = inverse ? composeMatrices(end, inverse) : null;
      const next = gesture ? composeMatrices(gesture, object.matrix) : end;
      if (!isFiniteMatrix(next)) {
        valid = false;
        break;
      }
      updates.set(object.id, gesture && matricesAlmostEqual(gesture, IDENTITY_MATRIX, 1e-9) ? object.matrix : next);
    }

    const rotating = session.anchor === "rotater";
    const label = `${rotating ? "Rotar" : "Escalar"} ${plural(session.objects.length, "objeto", "objetos")}`;
    const result = valid
      ? applyEdit(label, (state) => {
          const ids = new Set(updates.keys());
          const targets = Object.values(state.objectsByLayer)
            .flat()
            .filter((object) => ids.has(object.id));
          return replaceObjects(state, targets, (found) =>
            found.map((object) => {
              const next = updates.get(object.id);
              return next && next !== object.matrix ? { ...object, matrix: next } : object;
            }),
          );
        })
      : null;

    // Konva ya mutó los nodos: se dejan EXACTAMENTE en el estado confirmado (o se restauran si la edición se
    // rechazó/fue nula), porque React no vuelve a aplicar props que no cambiaron.
    for (const object of session.objects) {
      const node = nodesRef.current.get(object.id);
      if (!node) continue;
      const final = result?.applied ? (updates.get(object.id) ?? object.matrix) : object.matrix;
      node.setAttrs(matrixToKonvaProps(final));
    }
    transformerRef.current?.forceUpdate();
    transformerRef.current?.getLayer()?.batchDraw();
    if (result) reportEditResult(result);
  };

  // ---- Teclado ----

  const selectAllObjects = () => {
    const last = selectableObjects[selectableObjects.length - 1];
    onSelectObjects(
      selectableObjects.map((object) => object.id),
      last?.layerGroupId ?? null,
    );
  };

  const nudgeSelection = (dx: number, dy: number) => {
    if (selectedObjects.length === 0) return;
    const ids = new Set(selectedObjects.map((object) => object.id));
    const first = selectedObjects[0].id;
    const last = selectedObjects[selectedObjects.length - 1].id;
    reportEditResult(
      applyEdit(`Mover ${plural(ids.size, "objeto", "objetos")}`, (state) => moveProduction(state, ids, dx, dy), {
        // Una ráfaga de flechas sobre la MISMA selección es un solo comando de undo.
        coalesceKey: `nudge:${ids.size}:${first}:${last}`,
      }),
    );
  };

  const deleteSelection = () => {
    if (selectedObjects.length === 0) return;
    const ids = new Set(selectedObjects.map((object) => object.id));
    reportEditResult(applyEdit(`Eliminar ${plural(ids.size, "objeto", "objetos")}`, (state) => removeObjects(state, ids)));
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const modifier = event.ctrlKey || event.metaKey;

    if (modifier && event.key.toLowerCase() === "a" && isEditingTool) {
      event.preventDefault();
      selectAllObjects();
      return;
    }

    if (event.key === "Escape") {
      const interaction = interactionRef.current;
      if (interaction) {
        // Cancela un drag/marquee en curso sin tocar la selección.
        if (interaction.kind === "drag" && interaction.gestureStarted) cancelGesture();
        interactionRef.current = null;
        setMarquee(null);
        return;
      }
      if (selectedObjectIds.size > 0) onSelectObjects([], null);
      setNotice(null);
      return;
    }

    if ((event.key === "Delete" || event.key === "Backspace") && isEditingTool && selectedObjects.length > 0) {
      event.preventDefault();
      deleteSelection();
      return;
    }

    switch (event.key) {
      case " ":
      case "Spacebar":
        event.preventDefault();
        setSpacePanHeld(true);
        break;
      case "ArrowUp":
      case "ArrowDown":
      case "ArrowLeft":
      case "ArrowRight": {
        event.preventDefault();
        const vertical = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
        const horizontal = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
        if (isEditingTool && selectedObjects.length > 0) {
          // Con selección, las flechas mueven los objetos (nudge); sin selección siguen desplazando la vista.
          const step = event.shiftKey ? NUDGE_STEP_SHIFT : NUDGE_STEP;
          nudgeSelection(horizontal * step, vertical * step);
        } else {
          onPanBy(0 - horizontal * KEYBOARD_PAN_STEP_PX, 0 - vertical * KEYBOARD_PAN_STEP_PX);
        }
        break;
      }
      case "+":
      case "=":
        event.preventDefault();
        onZoomBy(KEYBOARD_ZOOM_FACTOR);
        break;
      case "-":
      case "_":
        event.preventDefault();
        onZoomBy(1 / KEYBOARD_ZOOM_FACTOR);
        break;
      default:
        break;
    }
  };

  const handleKeyUp = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === " " || event.key === "Spacebar") {
      setSpacePanHeld(false);
    }
  };

  const documentLayerProps = {
    offsetX: sourceWidthPx / 2,
    offsetY: sourceHeightPx / 2,
    x: containerSize.width / 2 + transform.panX,
    y: containerSize.height / 2 + transform.panY,
    scaleX: transform.scale,
    scaleY: transform.scale,
  };

  const failedLayers = layers.filter((layer) => layerStatus[layer.groupId] === "error");
  const toolLabel = effectiveTool === "pan" ? "Pan" : effectiveTool === "move" ? "Move" : "Select";
  const showOutlines = selectedObjects.length > 0 && selectedObjects.length <= MAX_SELECTION_OUTLINES;
  const layerHighlightId = selectedObjectIds.size === 0 ? selectedGroupId : null;

  return (
    <div
      ref={containerRef}
      className={`vector-canvas-2 vector-canvas-2--${effectiveTool}`}
      tabIndex={0}
      role="application"
      aria-label={`Canvas del documento. Herramienta activa: ${toolLabel}. Rueda del mouse para zoom. Mantené Espacio para pan temporal. Con foco: click o Control+A para seleccionar objetos, flechas para mover la selección (Shift: 10 unidades) o desplazar la vista si no hay selección, Suprimir para eliminar, Escape para limpiar, + y - para zoom.`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
    >
      {layers.length === 0 ? (
        <p className="vector-canvas-2__empty">Ninguna capa visible.</p>
      ) : hasContainerSize ? (
        <Stage ref={stageRef} width={containerSize.width} height={containerSize.height}>
          {/* Capa del documento: sin eventos (listening=false) -- el hit-testing es geométrico, no del hit-canvas. */}
          <Layer {...documentLayerProps} listening={false}>
            {visibleLayers.map((layer) => (
              <EditorLayerNodes
                key={layer.groupId}
                groupId={layer.groupId}
                locked={layer.locked}
                objects={objectsByLayer[layer.groupId] ?? EMPTY_OBJECTS}
                highlighted={layerHighlightId === layer.groupId}
                onRegister={registerNode}
              />
            ))}
          </Layer>

          {/* Overlay: contornos de selección + marquee (en espacio de documento) y el Transformer (en pantalla,
              fuera de la escala del documento para que sus handles midan siempre lo mismo). */}
          <Layer>
            <Group {...documentLayerProps} listening={false}>
              {showOutlines &&
                selectedObjects.map((object) => (
                  <Path
                    key={object.id}
                    data={object.d}
                    {...matrixToKonvaProps(object.matrix)}
                    fillEnabled={false}
                    stroke={lockedLayerIds.has(object.layerGroupId) ? LOCKED_OUTLINE : ACCENT}
                    strokeWidth={1.5}
                    dash={lockedLayerIds.has(object.layerGroupId) ? [4, 3] : undefined}
                    strokeScaleEnabled={false}
                    listening={false}
                    perfectDrawEnabled={false}
                  />
                ))}
              {marquee && (
                <KonvaRect
                  name="marquee"
                  x={marquee.x}
                  y={marquee.y}
                  width={marquee.width}
                  height={marquee.height}
                  fill="rgba(58, 92, 245, 0.08)"
                  stroke={ACCENT}
                  strokeWidth={1}
                  dash={[4, 3]}
                  strokeScaleEnabled={false}
                  listening={false}
                />
              )}
            </Group>
            <Transformer
              ref={transformerRef}
              visible={showTransformer}
              rotateEnabled
              // Esquinas proporcionales por defecto; Shift las libera (invertido respecto del default de Konva).
              keepRatio
              shiftBehavior="inverted"
              // Reflejar es de S02 (flip): acá cruzar un handle no invierte el objeto.
              flipEnabled={false}
              rotationSnaps={shiftHeld ? ROTATION_SNAPS : []}
              rotationSnapTolerance={7.5}
              borderStroke={ACCENT}
              anchorStroke={ACCENT}
              anchorFill="#ffffff"
              anchorSize={9}
              boundBoxFunc={(oldBox, newBox) => (Math.abs(newBox.width) < 4 || Math.abs(newBox.height) < 4 ? oldBox : newBox)}
              onTransformStart={handleTransformStart}
              onTransformEnd={handleTransformEnd}
            />
          </Layer>
        </Stage>
      ) : null}

      {lockedSelected.length > 0 && (
        <p className="vector-canvas-2__lock-badge" role="status">
          <span aria-hidden="true">🔒</span> {plural(lockedSelected.length, "objeto bloqueado", "objetos bloqueados")}: se pueden inspeccionar pero no modificar.
        </p>
      )}
      {notice && (
        <p className="vector-canvas-2__notice" role="alert">
          {notice}
        </p>
      )}
      {failedLayers.length > 0 && (
        <p className="vector-canvas-2__layer-error" role="alert">
          No se pudo cargar {failedLayers.length === 1 ? `la capa ${failedLayers[0].name}` : `${failedLayers.length} capas`}.{" "}
          <button type="button" className="upload-actions__button" onClick={retry}>
            Reintentar
          </button>
        </p>
      )}
      <span className="vector-canvas-2__sr" aria-live="polite">
        {selectedObjects.length > 0 ? `${plural(selectedObjects.length, "objeto seleccionado", "objetos seleccionados")}.` : ""}
      </span>
    </div>
  );
}
