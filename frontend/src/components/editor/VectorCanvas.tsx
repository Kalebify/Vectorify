import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { Group, Layer, Path, Rect as KonvaRect, Stage, Transformer } from "react-konva";
import type Konva from "konva";
import type { CanvasTransform } from "../../hooks/useCanvasTransform";
import type { ApplyEditResult, EditableDocumentApi } from "../../hooks/useEditableDocument";
import type { VectorDocumentLayer } from "../../hooks/useVectorDocument";
import { composeMatrices, invertMatrix, isFiniteMatrix, matricesAlmostEqual, matrixToKonvaProps } from "../../lib/editor/matrix";
import { hitTest, hitTestAll, objectsInRect, rectFromPoints } from "../../lib/editor/objects";
import { dimRects, sourceFrameOf } from "../../lib/editor/frame";
import type { OrientationStep } from "../../lib/editor/orientation";
import { describeSkipped, planDelete } from "../../lib/editor/clipboard";
import { cycleHit, replaceObjects, resolveSelection, splitByLock, toggleId } from "../../lib/editor/selection";
import { translate } from "../../lib/editor/transform";
import type { DocumentFrame, EditableDocument, EditorObject, Point, Rect } from "../../lib/editor/types";
import { screenToleranceToDocument } from "../../lib/editor/units";
import { screenToDocument, type ViewportParams } from "../../lib/editor/viewport";
import { IDENTITY_MATRIX, type AffineMatrix } from "../../lib/svgTransform";
import { BooleanOverlay, type BooleanOverlayProps } from "./BooleanOverlay";
import { OffsetOverlay, type OffsetOverlayProps } from "./OffsetOverlay";
import { EditorLayerNodes } from "./EditorLayerNodes";
import type { EditorTool } from "./EditorToolbar";
import { PathSurface, type PathSurfaceProps } from "./PathSurface";
import { ToolSurface, type ToolSurfaceProps } from "./ToolSurface";

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
/** Crop (M3-S02): exterior atenuado, relleno casi transparente del marco (para que Konva lo pueda arrastrar) y borde del área de trabajo. */
const CROP_DIM_FILL = "rgba(15, 23, 42, 0.45)";
const CROP_HIT_FILL = "rgba(58, 92, 245, 0.04)";
const FRAME_OUTLINE = "#8a909c";
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
  /** Área de trabajo vigente (M3-S02, `DocumentFrame`): centra el documento y define la hoja. Sin ella: `0 0 sourceWidthPx sourceHeightPx`. */
  frame?: DocumentFrame;
  /** Hay una transformación (rotar/reflejar) esperando Apply/Cancel: el canvas no edita para no pisar la previsualización. */
  editingSuspended?: boolean;
  /** Marco PROPUESTO de la herramienta Crop (null/ausente = sin overlay) y su callback: el shell lo posee, el canvas solo lo dibuja y lo mueve. */
  cropFrame?: DocumentFrame | null;
  cropKeepRatio?: boolean;
  onCropFrameChange?: (frame: DocumentFrame) => void;
  /** Atajos R/Shift+R (girar 90°) y F/Shift+F (reflejar) con el foco en el canvas. */
  onOrientationShortcut?: (step: OrientationStep) => void;
  /** Eyedropper (M3-S03): click sobre un objeto visible -> la CAPA de ese objeto (no un hex). Click en vacío no llama. */
  onPickColor?: (groupId: string) => void;
  /** Fill (M3-S03): click sobre un objeto -> aplicar el color activo a él (o a toda la selección si forma parte de ella). Shift+click solo alterna la selección. */
  onFillObject?: (objectId: string) => void;
  /** Atajo de herramienta con el foco en el canvas (I = Eyedropper). */
  onToolShortcut?: (tool: EditorTool) => void;
  /** Draw / Erase (M3-S04): la superficie que captura el puntero y dibuja el preview. El shell posee todo el estado; el canvas solo aporta viewport, pool de hit-test y locks. */
  toolSurface?: Omit<ToolSurfaceProps, "viewport" | "suspended" | "pool" | "lockedLayerIds">;
  /** Path (M3-S05): la superficie de edición de nodos del objeto seleccionado. Igual que `toolSurface`, el shell posee el estado; el canvas aporta viewport, pool de hit-test y locks. */
  pathSurface?: Omit<PathSurfaceProps, "viewport" | "suspended" | "pool">;
  /** Booleana abierta (M3-S08): insignias A/B/C de los operandos + preview del resultado. Solo lectura (no captura el puntero); el shell posee todo el estado. */
  booleanOverlay?: Omit<BooleanOverlayProps, "viewport">;
  /** Offset abierto (M3-S09): originales atenuados, resultado y objetos que colapsan. Solo lectura (no captura el puntero); el shell posee todo el estado. */
  offsetOverlay?: Omit<OffsetOverlayProps, "viewport">;
  /** Doble click sobre un objeto con Select (M3-S05): el shell lo selecciona y pasa a la herramienta Path. */
  onEditPath?: (objectId: string, layerGroupId: string) => void;
  /**
   * Suprimir / Retroceso con la selección (M3-S06): el shell elimina con el módulo de portapapeles (mensajes, selección coherente al deshacer).
   * Sin él, el canvas elimina por su cuenta con el MISMO `planDelete` (uso autónomo del canvas y sus tests).
   */
  onDeleteSelection?: () => void;
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
  frame,
  editingSuspended = false,
  cropFrame = null,
  cropKeepRatio = false,
  onCropFrameChange,
  onOrientationShortcut,
  onPickColor,
  onFillObject,
  onToolShortcut,
  toolSurface,
  pathSurface,
  booleanOverlay,
  offsetOverlay,
  onEditPath,
  onDeleteSelection,
}: VectorCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<Konva.Stage | null>(null);
  const transformerRef = useRef<Konva.Transformer | null>(null);
  const cropRectRef = useRef<Konva.Rect | null>(null);
  const cropTransformerRef = useRef<Konva.Transformer | null>(null);
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
  const canOrient = effectiveTool === "select" || effectiveTool === "move";
  // Fill y Color (M3-S03) solo SELECCIONAN en el canvas (click, Shift, marquee): la selección es el objetivo del color, no se mueve ni se transforma.
  // Offset (M3-S09) también: la selección es lo que se desplaza, y mientras se calcula nada se arrastra ni se transforma.
  // Path (M3-S05) sin objeto editable (nada o varios seleccionados, capa bloqueada...) tampoco tiene superficie de nodos: el canvas deja elegir el objeto a editar.
  const selectOnly = effectiveTool === "fill" || effectiveTool === "color" || effectiveTool === "offset" || (effectiveTool === "path" && !pathSurface);
  // Con una transformación pendiente de Apply/Cancel (o con Crop) las herramientas de edición de objetos quedan suspendidas.
  const isEditingTool = canOrient && !editingSuspended;
  const isSelectingTool = (canOrient || selectOnly) && !editingSuspended;
  const cropActive = effectiveTool === "crop" && cropFrame !== null && onCropFrameChange !== undefined;
  const docFrame = useMemo(() => frame ?? sourceFrameOf(sourceWidthPx, sourceHeightPx), [frame, sourceWidthPx, sourceHeightPx]);
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

  // Path (M3-S05): al entrar el foco pasa al canvas, así Suprimir, las flechas, Escape y Enter de la herramienta funcionan sin tener que hacer click antes
  // (tras activar la herramienta con su botón el foco quedaba en el botón de la barra, que esos atajos ignoran).
  useEffect(() => {
    if (tool === "path") containerRef.current?.focus({ preventScroll: true });
  }, [tool]);

  const lockedLayerIds = useMemo(() => new Set(layers.filter((layer) => layer.locked).map((layer) => layer.groupId)), [layers]);
  const selectedObjects = useMemo(() => resolveSelection(selectableObjects, selectedObjectIds), [selectableObjects, selectedObjectIds]);
  const { editable: editableSelected, locked: lockedSelected } = useMemo(() => splitByLock(selectedObjects, lockedLayerIds), [selectedObjects, lockedLayerIds]);
  const editableSelectionKey = useMemo(() => editableSelected.map((object) => object.id).join("|"), [editableSelected]);
  // Los nodos de Konva se RECREAN cuando un objeto cambia de capa (Fill/Recolor y su undo/redo): el Transformer debe reengancharse aunque los ids no cambien.
  const editableMembershipKey = useMemo(() => editableSelected.map((object) => object.layerGroupId).join("|"), [editableSelected]);

  const visibleLayers = useMemo(() => layers.filter((layer) => visibility[layer.groupId] ?? true), [layers, visibility]);
  const hasContainerSize = containerSize.width > 0 && containerSize.height > 0;
  const showTransformer = effectiveTool === "select" && !editingSuspended && editableSelected.length > 0;
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
  }, [editableSelectionKey, editableMembershipKey, showTransformer, hasContainerSize, readyLayersKey]);

  // El Transformer del marco de Crop se engancha a su Rect mientras la herramienta está activa (el Rect se monta con ella).
  useEffect(() => {
    const cropTransformer = cropTransformerRef.current;
    if (!cropTransformer) return;
    const node = cropActive ? cropRectRef.current : null;
    cropTransformer.nodes(node ? [node] : []);
    cropTransformer.getLayer()?.batchDraw();
  }, [cropActive, hasContainerSize]);

  const viewport: ViewportParams = {
    containerWidth: containerSize.width,
    containerHeight: containerSize.height,
    panX: transform.panX,
    panY: transform.panY,
    scale: transform.scale,
    sourceWidth: docFrame.width,
    sourceHeight: docFrame.height,
    originX: docFrame.x,
    originY: docFrame.y,
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

    // Eyedropper (M3-S03): el objeto VISIBLE de más arriba bajo el cursor -> su capa. Lee capas bloqueadas (solo lee), no las ocultas (no están en el pool).
    if (effectiveTool === "eyedropper") {
      const picked = stack[0];
      if (picked) onPickColor?.(picked.layerGroupId);
      return;
    }

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
      if (effectiveTool === "fill") {
        // Fill: el click APLICA el color activo al objeto (o a toda la selección si el objeto forma parte de ella); lo resuelve el shell.
        onFillObject?.(hit.id);
        return;
      }
      // Path sin objeto editable (varios seleccionados, capa bloqueada...): el click ELIGE el objeto a editar, incluso entre los ya seleccionados.
      if (effectiveTool === "path") {
        onSelectObjects([hit.id], hit.layerGroupId);
        return;
      }
      const wasSelected = selectedObjectIds.has(hit.id);
      if (!wasSelected) onSelectObjects([hit.id], hit.layerGroupId);
      // Color: el click solo selecciona; no hay arrastre de objetos.
      if (selectOnly) return;
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
      enabled: effectiveTool === "select" || selectOnly,
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
    if (isSelectingTool || effectiveTool === "eyedropper") beginSelectionInteraction(event);
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

  // ---- Crop (marco propuesto) ----

  // Konva resuelve el resize del Transformer como ESCALA del Rect: se vuelve a ancho/alto reales (escala 1) en cada paso, así el
  // nodo y el marco propuesto del shell coinciden siempre y el resumen "Qué se va a modificar" se actualiza en vivo.
  const handleCropNodeChange = () => {
    const node = cropRectRef.current;
    if (!node || !onCropFrameChange) return;
    const next: DocumentFrame = {
      x: node.x(),
      y: node.y(),
      width: node.width() * Math.abs(node.scaleX()),
      height: node.height() * Math.abs(node.scaleY()),
    };
    node.setAttrs({ width: next.width, height: next.height, scaleX: 1, scaleY: 1 });
    onCropFrameChange(next);
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
    if (onDeleteSelection) {
      onDeleteSelection();
      return;
    }
    // Uso autónomo: misma planificación que el shell (lo bloqueado se omite y se informa; nada eliminable = sin comando).
    const plan = planDelete(editable.getSnapshot(), new Set(selectedObjects.map((object) => object.id)));
    const production = plan.production;
    if (!production) {
      setNotice(plan.error);
      return;
    }
    const result = applyEdit(plan.label, () => production);
    if (!result.applied) {
      reportEditResult(result);
      return;
    }
    // Los eliminados dejan de ser seleccionables (la selección cruda del dueño los conserva: deshacer los vuelve a seleccionar, como en S01).
    setNotice(plan.skippedCount > 0 ? `${describeSkipped(plan.skipped, "delete")}.` : null);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const modifier = event.ctrlKey || event.metaKey;

    if (modifier && event.key.toLowerCase() === "a" && isSelectingTool) {
      event.preventDefault();
      selectAllObjects();
      return;
    }

    // Z-order (M3-S07): Ctrl/Cmd + la tecla física de los corchetes lo resuelve el shell (por `code`). En teclados no-US esa tecla escribe "+" u otro
    // carácter y "+" haría zoom acá (con preventDefault), llevándose el evento antes que el atajo global: con una selección editable se lo deja pasar.
    if (modifier && !event.altKey && isEditingTool && selectedObjects.length > 0 && (event.code === "BracketRight" || event.code === "BracketLeft")) return;

    // Path (M3-S05): las flechas (nudge de nodos), Escape, Enter y Suprimir los resuelve la herramienta; acá no se desplaza la vista ni se toca la selección de objetos.
    if (tool === "path" && pathSurface && (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "ArrowLeft" || event.key === "ArrowRight")) return;

    if (event.key === "Escape") {
      // Crop o una transformación pendiente: Escape es "Cancel" y lo resuelve el shell (no limpia la selección).
      if (tool === "crop" || tool === "fill" || tool === "color" || tool === "draw" || tool === "erase" || tool === "offset" || tool === "path" || editingSuspended) return;
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

    // Eyedropper (M3-S03): I con el foco en el canvas.
    if (onToolShortcut && !modifier && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "i") {
      event.preventDefault();
      onToolShortcut("eyedropper");
      return;
    }

    // Atajos de Rotate/Flip (M3-S02): válidos también con una transformación pendiente (componen sobre el estado original).
    if (canOrient && onOrientationShortcut && !modifier && !event.altKey) {
      const key = event.key.toLowerCase();
      if (key === "r") {
        event.preventDefault();
        onOrientationShortcut(event.shiftKey ? "rotate-ccw" : "rotate-cw");
        return;
      }
      if (key === "f") {
        event.preventDefault();
        onOrientationShortcut(event.shiftKey ? "flip-vertical" : "flip-horizontal");
        return;
      }
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
        if (cropActive && cropFrame && onCropFrameChange) {
          // Crop: las flechas mueven el marco propuesto (1 unidad, Shift 10) -- misma convención que el nudge de objetos.
          const step = event.shiftKey ? NUDGE_STEP_SHIFT : NUDGE_STEP;
          onCropFrameChange({ ...cropFrame, x: cropFrame.x + horizontal * step, y: cropFrame.y + vertical * step });
        } else if (isEditingTool && selectedObjects.length > 0) {
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

  // Doble click sobre un objeto con Select: pasa a editar sus nodos (M3-S05). El shell lo selecciona y activa Path.
  const handleDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (effectiveTool !== "select" || editingSuspended || !onEditPath) return;
    const screenPoint = toContainerPoint(event);
    if (isTransformerAnchorAt(screenPoint)) return;
    const hit = hitTest(selectableObjects, screenToDocument(screenPoint, viewport), screenToleranceToDocument(HIT_TOLERANCE_PX, transform.scale));
    if (hit) onEditPath(hit.id, hit.layerGroupId);
  };

  const handleKeyUp = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === " " || event.key === "Spacebar") {
      setSpacePanHeld(false);
    }
  };

  // El documento se centra por el centro de su ÁREA DE TRABAJO (tras un crop o un giro del documento ya no es 0 0 w h).
  const documentLayerProps = {
    offsetX: docFrame.x + docFrame.width / 2,
    offsetY: docFrame.y + docFrame.height / 2,
    x: containerSize.width / 2 + transform.panX,
    y: containerSize.height / 2 + transform.panY,
    scaleX: transform.scale,
    scaleY: transform.scale,
  };

  const failedLayers = layers.filter((layer) => layerStatus[layer.groupId] === "error");
  const TOOL_LABELS: Record<EditorTool, string> = { select: "Select", pan: "Pan", move: "Move", crop: "Crop", fill: "Fill", color: "Color", eyedropper: "Eyedropper", draw: "Draw", erase: "Erase", offset: "Offset", path: "Path" };
  const toolLabel = TOOL_LABELS[effectiveTool];
  // Margen del exterior atenuado de Crop: cubre cualquier vista razonable alrededor del área de trabajo y del marco propuesto.
  const dimMargin = Math.max(docFrame.width, docFrame.height);
  // Con Path el contorno lo dibuja la propia superficie de nodos (sobre el mismo `d`): un segundo contorno azul lo duplicaría.
  const showOutlines = selectedObjects.length > 0 && selectedObjects.length <= MAX_SELECTION_OUTLINES && tool !== "path";
  // Con Draw/Erase la capa activa (la de destino) NO se resalta: el contorno azul taparía el color real de las líneas que se dibujan (el panel dice cuál es).
  const layerHighlightId = selectedObjectIds.size === 0 && tool !== "draw" && tool !== "erase" ? selectedGroupId : null;

  return (
    <div
      ref={containerRef}
      className={`vector-canvas-2 vector-canvas-2--${effectiveTool}`}
      tabIndex={0}
      role="application"
      aria-label={`Canvas del documento. Herramienta activa: ${toolLabel}. Rueda del mouse para zoom. Mantené Espacio para pan temporal. Con foco: click o Control+A para seleccionar objetos, flechas para mover la selección (Shift: 10 unidades) o desplazar la vista si no hay selección, Suprimir para eliminar, Control o Comando más C, X, V y D para copiar, cortar, pegar y duplicar, Control o Comando más corchete derecho o izquierdo traen adelante o envían atrás la selección dentro de su capa (con Mayúscula, al frente o al fondo), Escape para limpiar, + y - para zoom. R y Mayúscula+R giran 90° la selección (o todo el documento sin selección), F y Mayúscula+F la reflejan; Enter aplica y Escape cancela. Con Crop activo, las flechas mueven el marco de recorte. Con Fill, Color u Offset, click selecciona y Fill además aplica el color activo al objeto; con Offset Enter aplica y Escape cancela. I activa el Eyedropper: click sobre un objeto toma el color de su capa. Con Draw o Erase, la superficie de dibujo captura el puntero: Escape cancela el trazo o el cálculo en curso. Doble click sobre un objeto con Select pasa a Path: click en un nodo lo selecciona, arrastre mueve, Suprimir elimina y las flechas mueven los nodos seleccionados.`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onDoubleClick={handleDoubleClick}
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
              {/* Borde del área de trabajo (la "hoja"): tras un crop o un giro es lo único que dice dónde termina el documento. */}
              <KonvaRect
                name="document-frame"
                x={docFrame.x}
                y={docFrame.y}
                width={docFrame.width}
                height={docFrame.height}
                stroke={FRAME_OUTLINE}
                strokeWidth={1}
                strokeScaleEnabled={false}
                listening={false}
              />
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
            {/* Crop (M3-S02): exterior atenuado + marco propuesto arrastrable/redimensionable (en espacio de documento). */}
            {cropActive && cropFrame && (
              <Group {...documentLayerProps}>
                {dimRects(
                  {
                    x: Math.min(docFrame.x, cropFrame.x) - dimMargin,
                    y: Math.min(docFrame.y, cropFrame.y) - dimMargin,
                    width: Math.max(docFrame.x + docFrame.width, cropFrame.x + cropFrame.width) - Math.min(docFrame.x, cropFrame.x) + 2 * dimMargin,
                    height: Math.max(docFrame.y + docFrame.height, cropFrame.y + cropFrame.height) - Math.min(docFrame.y, cropFrame.y) + 2 * dimMargin,
                  },
                  cropFrame,
                ).map((rect, index) => (
                  <KonvaRect key={index} name="crop-dim" x={rect.x} y={rect.y} width={rect.width} height={rect.height} fill={CROP_DIM_FILL} listening={false} />
                ))}
                <KonvaRect
                  ref={cropRectRef}
                  name="crop-frame"
                  x={cropFrame.x}
                  y={cropFrame.y}
                  width={cropFrame.width}
                  height={cropFrame.height}
                  fill={CROP_HIT_FILL}
                  stroke={ACCENT}
                  strokeWidth={1.5}
                  dash={[6, 4]}
                  strokeScaleEnabled={false}
                  draggable
                  onDragMove={handleCropNodeChange}
                  onDragEnd={handleCropNodeChange}
                  onTransform={handleCropNodeChange}
                  onTransformEnd={handleCropNodeChange}
                />
              </Group>
            )}
            {cropActive && (
              <Transformer
                ref={cropTransformerRef}
                rotateEnabled={false}
                flipEnabled={false}
                keepRatio={cropKeepRatio}
                borderStroke={ACCENT}
                anchorStroke={ACCENT}
                anchorFill="#ffffff"
                anchorSize={9}
                boundBoxFunc={(oldBox, newBox) => (Math.abs(newBox.width) < 4 || Math.abs(newBox.height) < 4 ? oldBox : newBox)}
              />
            )}
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

      {hasContainerSize && toolSurface && tool === toolSurface.tool && (
        <ToolSurface {...toolSurface} viewport={viewport} suspended={spacePanHeld || editingSuspended} pool={selectableObjects} lockedLayerIds={lockedLayerIds} />
      )}
      {hasContainerSize && booleanOverlay && <BooleanOverlay {...booleanOverlay} viewport={viewport} />}
      {hasContainerSize && offsetOverlay && <OffsetOverlay {...offsetOverlay} viewport={viewport} />}
      {hasContainerSize && pathSurface && tool === "path" && <PathSurface {...pathSurface} viewport={viewport} suspended={spacePanHeld || editingSuspended} pool={selectableObjects} />}

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
