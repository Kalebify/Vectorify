import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCanvasTransform } from "../../hooks/useCanvasTransform";
import { useClipboard } from "../../hooks/useClipboard";
import { describeEditFailure, useDrawEraseTools } from "../../hooks/useDrawEraseTools";
import { useBooleanOperation } from "../../hooks/useBooleanOperation";
import { useEditableDocument, type ApplyEditResult, type EditProducer } from "../../hooks/useEditableDocument";
import { usePathTool } from "../../hooks/usePathTool";
import { useLaserWarnings } from "../../hooks/useLaserWarnings";
import { useManufacturingOperations } from "../../hooks/useManufacturingOperations";
import { useVectorDocument, type VectorDocumentLayer } from "../../hooks/useVectorDocument";
import { useWorkspaceSave } from "../../hooks/useWorkspaceSave";
import {
  ARRANGE_SHORTCUTS,
  arrangeAvailability,
  describeArrange,
  matchArrangeShortcut,
  runArrange,
  zOrderActionId,
  type AlignReference,
  type ArrangeActionId,
} from "../../lib/editor/arrange";
import {
  applyBooleanResult,
  booleanAvailability,
  booleanLabel,
  booleanNotice,
  booleanOutcome,
  booleanTargetCandidates,
  DEFAULT_BOOLEAN_TOLERANCE_MM,
  describeOperand,
  moveOperand,
  operandLetter,
  paintOrderIds,
  planBoolean,
  reverseOperands,
  toleranceFromMm,
  type BooleanOp,
  type BooleanTargetChoice,
} from "../../lib/editor/boolean";
import {
  buildClipboard,
  clipboardAvailability,
  describeSkipped,
  isTextFieldTarget,
  matchClipboardShortcut,
  outcomeText,
  pasteOffset,
  planCut,
  planDelete,
  planDuplicate,
  planPaste,
  type ClipboardAction,
  type ClipboardVerb,
  type PasteMode,
  type PlanSkip,
} from "../../lib/editor/clipboard";
import {
  DEFAULT_CONFIRM_THRESHOLD,
  mergeCandidates,
  needsConfirmation,
  planRecolor,
  recolorHeadline,
  recolorLabel,
  resolveActiveColor,
  type ColorPlan,
  type ColorTarget,
  type RecolorRequest,
  type RecolorScope,
} from "../../lib/editor/colors";
import {
  cropFrame as cropFrameOf,
  cropProduction,
  fitToContent,
  frameSizeMm,
  frameWithAspect,
  framesEqual,
  isValidFrame,
  orientDocumentProduction,
  sourceFrameOf,
  summarizeCrop,
  validateFrame,
} from "../../lib/editor/frame";
import { toDocumentUnits } from "../../lib/editor/geometry";
import { placeNewLayers, toLayerMetas } from "../../lib/editor/layers";
import { matrixRotationDegrees } from "../../lib/editor/matrix";
import { serializeEditableLayer } from "../../lib/editor/objects";
import {
  composeOrientation,
  IDENTITY_ORIENTATION,
  isIdentityOrientation,
  orientationLabel,
  orientationVerb,
  orientSelectionProduction,
  type Orientation,
  type OrientationStep,
} from "../../lib/editor/orientation";
import { replaceObjects, resolveSelection, selectableObjects as selectableObjectsOf, splitByLock } from "../../lib/editor/selection";
import { groupBounds, groupCenter, rotateAbout, setBounds } from "../../lib/editor/transform";
import type { DocumentFrame, EditorEdit, EditProduction, Point, Rect } from "../../lib/editor/types";
import { formatDisplayNumber, mmPerUnit as mmPerUnitOf, toMm } from "../../lib/editor/units";
import { svgToDataUrl } from "../../lib/svgToDataUrl";
import { ArrangeBar, type ArrangeNotice } from "./ArrangeBar";
import { BooleanBar, type BooleanNotice } from "./BooleanBar";
import { BooleanPanel, NEW_LAYER_VALUE } from "./BooleanPanel";
import { ClipboardBar, type ClipboardNotice } from "./ClipboardBar";
import { ColorPanel, EyedropperPanel } from "./ColorPanel";
import { CropPanel, type CropPreset } from "./CropPanel";
import { DrawPanel } from "./DrawPanel";
import { EditorHeader } from "./EditorHeader";
import { EditorLayersPanel } from "./EditorLayersPanel";
import { EditorStatusBar } from "./EditorStatusBar";
import { EditorToolbar, type EditorTool } from "./EditorToolbar";
import { ErasePanel } from "./ErasePanel";
import { InspectorPanel } from "./InspectorPanel";
import { ObjectInspector } from "./ObjectInspector";
import { OrientationBar } from "./OrientationBar";
import { PaletteBar } from "./PaletteBar";
import { PathPanel } from "./PathPanel";
import { PreviewNavigator } from "./PreviewNavigator";
import { VectorCanvas } from "./VectorCanvas";
import "./editor.css";

export interface EditorShellProps {
  projectId: string;
  imageId: string;
  /** Sesión de paleta YA CONFIRMADA -- precondición para abrir el Workspace (ver useVectorDocument). */
  paletteId: string;
  projectName: string;
  /** Project.Id v2 ya guardado (M2.2-S05, deep-link/reapertura) -- null si esta sesión todavía no se guardó nunca. */
  savedProjectId?: string | null;
  /** Último DimensionResponse.DimensionId aplicado en el flujo clásico antes de abrir el Workspace, o null si nunca se aplicaron dimensiones físicas (ver spec.md, "Dimensiones físicas"). */
  dimensionId?: string | null;
  /**
   * Ancho físico en mm de las dimensiones aplicadas en el flujo clásico (M3-S01), o null si no se aplicaron. Solo se
   * usa para el Inspector de objetos (X/Y/ancho/alto en mm) en una sesión SIN guardar: un documento ya guardado trae
   * su propio `widthMm` (GET /api/v2/projects/{id}/document) y manda sobre este valor.
   */
  dimensionWidthMm?: number | null;
  /** Notifica al padre (App.tsx) cuando el primer Save resuelve un Project.Id v2 nuevo, para agregarlo a la URL sin recargar la página (ver workspaceLocation.ts). */
  onSaved?: (savedProjectId: string) => void;
  onClose: () => void;
  /**
   * Umbral (en objetos afectados) a partir del cual Fill/Recolor pide confirmación antes de aplicar (M3-S03). Default 50
   * (`DEFAULT_CONFIRM_THRESHOLD`); el alcance "documento" y las fusiones de capas piden confirmación siempre.
   */
  colorConfirmThreshold?: number;
  /** Generador de ids de los objetos que crean Pegar y Duplicar (M3-S06; default `crypto.randomUUID`). Inyectable en tests. */
  createId?: () => string;
}

const EMPTY_LAYERS: VectorDocumentLayer[] = [];
const EMPTY_ID_SET: ReadonlySet<string> = new Set();

/** Rotate/Flip de la selección o del documento completo, en previsualización (gesto de S01) a la espera de Apply/Cancel. */
interface PendingOrientation {
  scope: "selection" | "document";
  /** Objetos EDITABLES de la selección al empezar (solo `scope: "selection"`). */
  ids: string[];
  /** Objetos de la selección en capas bloqueadas: se informan, no se modifican. */
  lockedCount: number;
  /** Orientación ACUMULADA desde el estado original (exacta: ver `lib/editor/orientation.ts`). */
  orientation: Orientation;
}

/** Fill / Color en curso (M3-S03): alcance, origen y fusión elegidos en el panel; el COLOR vive aparte (`activeColor`) porque también lo cambia el Eyedropper. */
interface ColorSession {
  scope: RecolorScope;
  /** Capa de origen elegida del alcance "documento" (el alcance "capa" usa la capa activa). */
  sourceGroupId: string | null;
  /** Fusión explícita con esta capa (alcances capa/documento); null = no fusionar. */
  mergeIntoGroupId: string | null;
  /** Clave de la petición que el usuario está CONFIRMANDO: si algo cambia, deja de coincidir y la confirmación se descarta sola. */
  confirmKey: string | null;
  /**
   * La previsualización está "armada": se muestra mientras el usuario trabaja el panel (color, alcance, selección...). Tras aplicar o
   * deshacer/rehacer se DESARMA, para que el estado confirmado se vea tal cual (si no, un Deshacer con Fill abierto volvería a pintar la
   * previsualización encima y parecería que no hizo nada) hasta la siguiente interacción.
   */
  armed: boolean;
}

/**
 * Booleana abierta (M3-S08). Los OPERANDOS se congelan al abrirla (ids en el orden A, B, C...): mientras está abierta el canvas no edita ni cambia la
 * selección, así que el panel, el overlay y el cálculo hablan siempre de los mismos objetos. Nada de esto toca el documento: aplicar es UN comando.
 */
interface BooleanSession {
  op: BooleanOp;
  /** Ids de los operandos en el orden efectivo (A = el primero). Por defecto, el de pintado. */
  order: string[];
  /** Capa destino elegida: "" (ninguna todavía), un groupId o NEW_LAYER_VALUE. Con operandos en capas distintas NO hay valor por defecto. */
  target: string;
  newHex: string;
  /** Id de la capa que se creará si se elige «capa nueva» (fijo durante la sesión). */
  newGroupId: string;
  keepOriginals: boolean;
  toleranceMm: number;
  /** Último intento de aplicar que falló (resultado vacío, documento cambió...). */
  message: string | null;
}

const SCOPE_ORDER: RecolorScope[] = ["selection", "layer", "document"];

const DOCUMENT_LOCKED_MESSAGE = "Desbloqueá las capas para transformar el documento completo, o seleccioná objetos.";
const SELECTION_LOCKED_MESSAGE = "La selección está en capas bloqueadas: no se puede modificar. Desbloqueá las capas en el panel de Capas.";
const TRANSFORM_PENDING_MESSAGE = "Hay una transformación pendiente: aplicala (Apply) o cancelala (Cancel) antes de editar.";

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Productor del comando de una transformación pendiente: siempre parte del estado "antes" (el gesto lo garantiza). */
function orientationProducer(pending: PendingOrientation): EditProducer {
  return pending.scope === "document"
    ? (state) => orientDocumentProduction(state, pending.orientation)
    : (state) => orientSelectionProduction(state, new Set(pending.ids), pending.orientation);
}

/** Selección de objetos antes y después de un comando de portapapeles (M3-S06): deshacer restaura `before`, rehacer `after`. */
interface SelectionChange {
  before: ReadonlySet<string>;
  after: ReadonlySet<string>;
}

/** ¿Hay texto seleccionado en la página fuera del canvas? Entonces Ctrl/Cmd+C y X son del navegador (copiar ese texto), no de los objetos. */
function pageTextSelected(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (element?.closest?.(".vector-canvas-2")) return false;
  return (window.getSelection?.()?.toString() ?? "").length > 0;
}

const UNSAVED_GEOMETRY_CONFIRM =
  "Hay cambios de geometría sin guardar que se perderán al salir (la persistencia de geometría llega en una tarjeta posterior de MVP3). ¿Salir igual?";

const EMPTY_REASON_COPY: Record<string, string> = {
  no_palette_selected: "Este proyecto todavía no tiene una paleta de colores confirmada.",
  palette_not_found: "No se encontró la sesión de paleta de colores de este proyecto.",
  palette_not_confirmed: "La paleta de colores de este proyecto todavía no fue confirmada.",
  layers_not_generated:
    "Este proyecto todavía no tiene capas vectoriales generadas. Generalas desde el panel de Capas por color antes de abrir el Workspace.",
};

/**
 * Layout raíz del Workspace (M2.1-S06): integra en una sola pantalla Canvas,
 * Toolbar, Layers, Palette, Preview, Inspector y controles de documento --
 * ver spec.md, wireframe obligatorio. El estado de dominio vive en
 * `useVectorDocument` (agregación cliente de paleta confirmada + capas +
 * consolidado, ver ese hook); el estado de VISTA (zoom/pan, herramienta
 * activa, tamaño medido del canvas) vive acá, compartido entre VectorCanvas/
 * PreviewNavigator/EditorStatusBar -- ningún panel visual guarda su propia
 * copia divergente de ninguno de los dos.
 */
export function EditorShell({
  projectId,
  imageId,
  paletteId,
  projectName,
  savedProjectId = null,
  dimensionId = null,
  dimensionWidthMm = null,
  onSaved,
  onClose,
  colorConfirmThreshold = DEFAULT_CONFIRM_THRESHOLD,
  createId,
}: EditorShellProps) {
  // M2.2-S07: `useVectorDocument`/`useManufacturingOperations` necesitan `trackPatch` (expuesto
  // por `useWorkspaceSave`, declarado más abajo) para conectar cada PATCH-por-edición al
  // indicador compartido en una sesión ya guardada -- pero `useWorkspaceSave` a su vez necesita
  // `document.paletteVersion` (de `useVectorDocument`). Se rompe el ciclo con el patrón "latest
  // ref" (mismo criterio que `latestParamsRef` dentro de useWorkspaceSave.ts): `trackPatch` (la
  // función ESTABLE pasada a los hooks de abajo) reenvía a `trackPatchRef.current`, asignado
  // recién una vez resuelto `workspaceSave` más abajo -- siempre con el valor VIGENTE para cuando
  // alguna mutación real la invoque (nunca antes de que termine este mismo render).
  const trackPatchRef = useRef<((promise: Promise<unknown>) => void) | undefined>(undefined);
  const trackPatch = useCallback((promise: Promise<unknown>) => {
    trackPatchRef.current?.(promise);
  }, []);

  const {
    status,
    document,
    emptyReason,
    errorMessage,
    reload,
    visibility: serverVisibility,
    toggleVisibility,
    isolate,
    isolatedGroupId,
    showAll,
    toggleLocked,
    renameLayer,
    reorderLayers,
    selectedGroupId,
    selectGroup,
    selectedPathKeys,
    selectAllInLayer,
  } = useVectorDocument(projectId, imageId, paletteId, savedProjectId, trackPatch);
  const laserWarnings = useLaserWarnings(projectId, imageId);

  // Guardado real del VectorDocument (M2.2-S05/S07) -- ver useWorkspaceSave para la máquina de
  // estados completa (idle/dirty/saving/saved/error) y el autosave (debounce de staging +
  // trackPatch de una sesión ya guardada).
  const workspaceSave = useWorkspaceSave({
    initialSavedProjectId: savedProjectId,
    projectName,
    classicProjectId: projectId,
    imageId,
    paletteId,
    paletteVersion: document?.paletteVersion ?? null,
    dimensionId,
  });
  useEffect(() => {
    trackPatchRef.current = workspaceSave.trackPatch;
  }, [workspaceSave.trackPatch]);

  useEffect(() => {
    if (workspaceSave.state === "saved" && workspaceSave.savedProjectId && workspaceSave.savedProjectId !== savedProjectId) {
      onSaved?.(workspaceSave.savedProjectId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceSave.state, workspaceSave.savedProjectId]);

  // Operación de fabricación CUT/ENGRAVE/IGNORE (fix round M2.1-S07): el
  // Workspace leía `manufacturingOperation` solo de lectura vía el
  // consolidado de `useVectorDocument` -- este hook es el mismo que ya usa
  // `LayersPanel.tsx` (flujo clásico) para ofrecer la asignación real, ver
  // IMPL.md "Ronda de fix 1". `paletteId` viene confirmado por props (misma
  // precondición que abre el Workspace); `layerSetId` recién existe una vez
  // que el documento cargó. `savedProjectId` (M2.2-S05, ronda de fix 1): con
  // un Project.Id v2 activo, el hook bifurca a PATCH v2 (Data.Layer) en vez
  // del sidecar clásico -- ver docstring de `useManufacturingOperations`.
  const {
    operations: manufacturingOperations,
    mutatingGroupId: manufacturingMutatingGroupId,
    assign: assignManufacturingOperation,
  } = useManufacturingOperations(projectId, imageId, paletteId, document?.layerSetId ?? null, savedProjectId, trackPatch);

  const { transform, zoomBy, panBy, fitToScreen } = useCanvasTransform();

  // ---- Edición de geometría (M3-S01, ver docs/ADR_EDITOR_MVP3.md) ----
  // Estado editable + historial (la carga de los SVG de capa vive acá, ya no en VectorCanvas). La metadata de capas
  // (locked/visible) la sigue poseyendo useVectorDocument; este hook solo la lee para respetar locks y visibilidad.
  // M3-S03: la estructura de capas es parte del estado editable. `serverLayers` son las del servidor (PATCH, useVectorDocument);
  // `documentLayers` la lista EFECTIVA (servidor + capas creadas en el cliente + colores recoloreados + previsualización) que consumen el
  // canvas y TODOS los paneles; `committedLayers` es lo mismo sin la previsualización de un gesto en curso.
  const serverLayers = document?.layers ?? EMPTY_LAYERS;
  const sourceWidthPx = document?.sourceWidthPx ?? 0;
  const sourceHeightPx = document?.sourceHeightPx ?? 0;
  const editable = useEditableDocument(serverLayers, { visibility: serverVisibility, isolatedGroupId, sourceSize: { width: sourceWidthPx, height: sourceHeightPx } });
  const { undo, redo, applyEdit, geometryDirty, frame, committedFrame } = editable;
  const documentLayers = editable.layers;
  const committedLayers = editable.committedLayers;
  const visibility = editable.visibility;

  // Estado de vista / herramienta (declarado arriba porque los atajos de undo/redo y el re-centrado tras un cambio de marco lo usan).
  const [activeTool, setActiveTool] = useState<EditorTool>("select");
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });

  // Color activo (una REFERENCIA a una capa -- paleta/Eyedropper -- o un color libre nuevo) y sesión de Fill/Color en curso (M3-S03).
  const [activeColor, setActiveColor] = useState<ColorTarget | null>(null);
  const [colorSession, setColorSession] = useState<ColorSession | null>(null);
  const [colorMessage, setColorMessage] = useState<string | null>(null);
  const disarmColorPreview = useCallback(() => setColorSession((current) => (current && current.armed ? { ...current, armed: false, confirmKey: null } : current)), []);
  const armColorPreview = useCallback(() => setColorSession((current) => (current && !current.armed ? { ...current, armed: true } : current)), []);

  // Selección por ids de objeto. Se guarda cruda y se DEPURA contra los objetos seleccionables vigentes (capas
  // visibles que aún existen): ocultar una capa o borrar un objeto la actualiza sin código extra.
  const [rawSelectedObjectIds, setRawSelectedObjectIds] = useState<ReadonlySet<string>>(EMPTY_ID_SET);

  // Portapapeles (M3-S06): último mensaje y, por comando, la selección de antes y de después (clave = el propio comando que devuelven
  // `applyEdit`/`undo`/`redo`). Así deshacer un pegado vuelve a seleccionar los originales y rehacerlo, los pegados; deshacer un borrado
  // vuelve a seleccionar lo restaurado. Los comandos que no pasan por el portapapeles no tienen entrada y no tocan la selección.
  // El aviso pertenece al documento donde se produjo (la misma clave que vacía el portapapeles): en otro documento no se muestra.
  const clipboardScope = `${projectId}|${imageId}|${paletteId}`;
  const [storedNotice, setClipboardNotice] = useState<(ClipboardNotice & { scope: string }) | null>(null);
  const clipboardNotice = storedNotice?.scope === clipboardScope ? storedNotice : null;
  const [selectionJournal] = useState(() => new WeakMap<EditorEdit, SelectionChange>());
  // Organizar (M3-S07): referencia de alineación (default "Selección") y último mensaje, que pertenece al documento donde se produjo.
  const [arrangeReference, setArrangeReference] = useState<AlignReference>("selection");
  const [storedArrangeNotice, setArrangeNotice] = useState<(ArrangeNotice & { scope: string }) | null>(null);
  const arrangeNotice = storedArrangeNotice?.scope === clipboardScope ? storedArrangeNotice : null;

  // Booleanas (M3-S08): sesión abierta (operandos congelados) y último mensaje de la barra, que pertenece al documento donde se produjo.
  const [booleanSession, setBooleanSession] = useState<BooleanSession | null>(null);
  const [booleanApplying, setBooleanApplying] = useState(false);
  const [storedBooleanNotice, setBooleanNotice] = useState<(BooleanNotice & { scope: string }) | null>(null);
  const booleanNoticeShown = storedBooleanNotice?.scope === clipboardScope ? storedBooleanNotice : null;
  const booleanOpen = booleanSession !== null;
  // Cerrar sin rastro: el hook cancela el cálculo en vuelo al quedarse sin petición; nada de esto toca el documento ni la pila de undo.
  const closeBooleanSession = useCallback(() => setBooleanSession(null), []);

  // Tras un cambio de marco (crop, rotar el documento, o su undo/redo) el documento se vuelve a ajustar y centrar (M3-S02).
  const refitTo = useCallback((target: DocumentFrame) => fitToScreen(canvasSize, { width: target.width, height: target.height }), [fitToScreen, canvasSize]);
  const undoWithView = useCallback(() => {
    const edit = undo();
    if (edit) {
      closeBooleanSession();
      disarmColorPreview();
      setClipboardNotice(null);
      setArrangeNotice(null);
      const selection = selectionJournal.get(edit);
      if (selection) setRawSelectedObjectIds(selection.before);
    }
    if (edit?.frame) refitTo(edit.frame.before);
  }, [undo, refitTo, disarmColorPreview, selectionJournal, closeBooleanSession]);
  const redoWithView = useCallback(() => {
    const edit = redo();
    if (edit) {
      closeBooleanSession();
      disarmColorPreview();
      setClipboardNotice(null);
      setArrangeNotice(null);
      const selection = selectionJournal.get(edit);
      if (selection) setRawSelectedObjectIds(selection.after);
    }
    if (edit?.frame) refitTo(edit.frame.after);
  }, [redo, refitTo, disarmColorPreview, selectionJournal, closeBooleanSession]);

  const selectableObjects = useMemo(
    () => selectableObjectsOf(editable.objectsByLayer, documentLayers, visibility),
    [editable.objectsByLayer, documentLayers, visibility],
  );
  const selectedObjectIds = useMemo(() => {
    if (rawSelectedObjectIds.size === 0) return rawSelectedObjectIds;
    const present = new Set(selectableObjects.map((object) => object.id));
    const kept = [...rawSelectedObjectIds].filter((id) => present.has(id));
    return kept.length === rawSelectedObjectIds.size ? rawSelectedObjectIds : new Set(kept);
  }, [rawSelectedObjectIds, selectableObjects]);
  const selectedObjects = useMemo(() => resolveSelection(selectableObjects, selectedObjectIds), [selectableObjects, selectedObjectIds]);

  // Miniatura (Preview): las capas con ediciones de geometría se dibujan desde su estado en memoria, serializado con el
  // mismo formato de origen (solo cuando cambia el estado CONFIRMADO: no por frame de un gesto en curso).
  // Con el marco cambiado (crop / giro del documento) TODAS las capas se dibujan desde memoria: el SVG de origen tiene el
  // viewBox original y no mostraría el área de trabajo vigente (ni los objetos que un giro llevó fuera del lienzo original).
  const { committedObjectsByLayer, editedLayerIds } = editable;
  const frameChanged = !framesEqual(committedFrame, sourceFrameOf(sourceWidthPx, sourceHeightPx));
  const previewImageOverrides = useMemo(() => {
    const overrides: Record<string, string> = {};
    const meta = { width: committedFrame.width, height: committedFrame.height, x: committedFrame.x, y: committedFrame.y };
    const groupIds = frameChanged ? committedLayers.map((layer) => layer.groupId) : [...editedLayerIds];
    for (const groupId of groupIds) {
      overrides[groupId] = svgToDataUrl(serializeEditableLayer(committedObjectsByLayer[groupId] ?? [], meta));
    }
    return overrides;
  }, [frameChanged, committedLayers, editedLayerIds, committedObjectsByLayer, committedFrame]);

  // mm por unidad de documento: el tamaño físico del documento guardado manda; si no, el de las dimensiones del flujo clásico.
  const mmFactor = mmPerUnitOf(document?.widthMm ?? dimensionWidthMm, document?.sourceWidthPx);

  const handleSelectObjects = useCallback(
    (ids: string[], activeLayerId: string | null) => {
      setRawSelectedObjectIds(new Set(ids));
      // Seleccionar un objeto activa su capa (Inspector de capa, paleta, panel de capas).
      if (activeLayerId) selectGroup(activeLayerId);
      armColorPreview();
    },
    [selectGroup, armColorPreview],
  );

  // Seleccionar una capa desde un panel conserva el comportamiento de M2.1; los objetos seleccionados de OTRAS capas se descartan.
  const handleSelectGroup = useCallback(
    (groupId: string | null) => {
      selectGroup(groupId);
      armColorPreview();
      setRawSelectedObjectIds((current) => {
        if (current.size === 0) return current;
        const keep = groupId !== null && selectedObjects.every((object) => object.layerGroupId === groupId);
        return keep ? current : EMPTY_ID_SET;
      });
    },
    [selectGroup, selectedObjects, armColorPreview],
  );

  const handleSelectAllInLayer = (groupId: string) => {
    selectAllInLayer(groupId);
    // Una capa creada en el cliente no está en el documento del servidor: `selectAllInLayer` no la conoce, solo se la activa.
    if (documentLayers.find((layer) => layer.groupId === groupId)?.isNew) selectGroup(groupId);
    setRawSelectedObjectIds(new Set((editable.objectsByLayer[groupId] ?? []).map((object) => object.id)));
  };

  // Undo/Redo por teclado (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl/Cmd+Y): listener de ventana para que funcione con el foco
  // en el canvas o en cualquier botón del editor, pero NO dentro de campos de texto (Inspector numérico, renombrar
  // capa), donde Ctrl+Z pertenece al propio campo.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        undoWithView();
      } else if ((key === "z" && event.shiftKey) || key === "y") {
        event.preventDefault();
        redoWithView();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [undoWithView, redoWithView]);

  // Aviso al salir con geometría sin persistir (ADR D2): hasta M3-S13 las ediciones solo viven en memoria.
  useEffect(() => {
    if (!geometryDirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [geometryDirty]);

  // "← Projects" también descarta la geometría sin persistir (navegación interna: no dispara beforeunload).
  const handleClose = () => {
    if (geometryDirty && !window.confirm(UNSAVED_GEOMETRY_CONFIRM)) return;
    onClose();
  };

  const objectEditMessage = (result: ApplyEditResult): string | null => {
    if (result.reason === "blocked") return "La capa está bloqueada: no se puede modificar. Desbloqueala en el panel de Capas.";
    if (result.reason === "gesture_active") return TRANSFORM_PENDING_MESSAGE;
    return null;
  };

  // Inspector numérico -> UN comando por edición confirmada (Enter/blur).
  const commitObjectBounds = (target: Rect): string | null => {
    const current = groupBounds(selectedObjects);
    if (!current) return "La selección no tiene geometría para editar.";
    if (setBounds(selectedObjects, target) === null) return "No se pudo aplicar ese tamaño o posición.";
    const ids = new Set(selectedObjects.map((object) => object.id));
    const resized = Math.abs(target.width - current.width) > 1e-9 || Math.abs(target.height - current.height) > 1e-9;
    const count = ids.size === 1 ? "1 objeto" : `${ids.size} objetos`;
    return objectEditMessage(
      applyEdit(`${resized ? "Redimensionar" : "Mover"} ${count} (Inspector)`, (state) => {
        const targets = Object.values(state.objectsByLayer)
          .flat()
          .filter((object) => ids.has(object.id));
        return replaceObjects(state, targets, (found) => setBounds(found, target) ?? found);
      }),
    );
  };

  const commitObjectRotation = (degrees: number): string | null => {
    if (selectedObjects.length !== 1) return "La rotación numérica requiere un solo objeto seleccionado.";
    const [object] = selectedObjects;
    const center = groupCenter(selectedObjects);
    if (!center) return "La selección no tiene geometría para rotar.";
    const delta = degrees - matrixRotationDegrees(object.matrix);
    return objectEditMessage(
      applyEdit("Rotar objeto (Inspector)", (state) => {
        const target = state.objectsByLayer[object.layerGroupId]?.find((candidate) => candidate.id === object.id);
        return target ? replaceObjects(state, [target], (found) => rotateAbout(found, center, delta)) : null;
      }),
    );
  };

  // ---- Rotate / Flip (M3-S02): previsualización (gesto de S01, sin tocar la pila de undo) + Apply/Cancel ----
  const lockedLayerIds = useMemo(() => new Set(documentLayers.filter((layer) => layer.locked).map((layer) => layer.groupId)), [documentLayers]);
  const hiddenLayerIds = useMemo(
    () => new Set(documentLayers.filter((layer) => !(visibility[layer.groupId] ?? true)).map((layer) => layer.groupId)),
    [documentLayers, visibility],
  );
  const [pending, setPending] = useState<PendingOrientation | null>(null);
  const [orientationMessage, setOrientationMessage] = useState<string | null>(null);
  /** Confirmación de la última acción aplicada (crop / rotar / reflejar): el usuario ve qué cambió sin tener que adivinarlo. */
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const { editable: editableSelection, locked: lockedSelection } = useMemo(() => splitByLock(selectedObjects, lockedLayerIds), [selectedObjects, lockedLayerIds]);

  const blockedMessage = (scope: PendingOrientation["scope"]) => (scope === "document" ? DOCUMENT_LOCKED_MESSAGE : SELECTION_LOCKED_MESSAGE);

  const cancelPending = () => {
    editable.cancelGesture();
    setPending(null);
    setOrientationMessage(null);
  };

  const handleOrientationStep = (step: OrientationStep) => {
    if (!document || cropDraft !== null || booleanSession !== null) return;
    setActionNotice(null);
    setOrientationMessage(null);

    let current = pending;
    if (!current) {
      // El alcance se fija al EMPEZAR (selección o documento completo) y se mantiene hasta Apply/Cancel.
      if (selectedObjects.length > 0) {
        if (editableSelection.length === 0) {
          setOrientationMessage(SELECTION_LOCKED_MESSAGE);
          return;
        }
        current = { scope: "selection", ids: editableSelection.map((object) => object.id), lockedCount: lockedSelection.length, orientation: IDENTITY_ORIENTATION };
      } else {
        // Documento completo con capas bloqueadas: rechazo claro, nada se transforma a medias.
        const snapshot = editable.getSnapshot();
        if (documentLayers.some((layer) => layer.locked && (snapshot.objectsByLayer[layer.groupId]?.length ?? 0) > 0)) {
          setOrientationMessage(DOCUMENT_LOCKED_MESSAGE);
          return;
        }
        if (!isValidFrame(committedFrame)) return;
        current = { scope: "document", ids: [], lockedCount: 0, orientation: IDENTITY_ORIENTATION };
      }
      if (!editable.beginGesture()) return;
    }

    const next: PendingOrientation = { ...current, orientation: composeOrientation(current.orientation, step) };
    const result = editable.previewEdit(orientationProducer(next));
    if (!result.applied && result.reason === "blocked") {
      editable.cancelGesture();
      setPending(null);
      setOrientationMessage(blockedMessage(next.scope));
      return;
    }
    setPending(next);
  };

  const handleApplyPending = () => {
    if (!pending) return;
    if (isIdentityOrientation(pending.orientation)) {
      cancelPending();
      return;
    }
    // Se vuelve a evaluar contra los bloqueos/visibilidad VIGENTES justo antes de confirmar (pudieron cambiar desde la previsualización).
    const preview = editable.previewEdit(orientationProducer(pending));
    if (!preview.applied) {
      editable.cancelGesture();
      setPending(null);
      setOrientationMessage(preview.reason === "blocked" ? blockedMessage(pending.scope) : "No hay cambios para aplicar.");
      return;
    }
    const scopeLabel = pending.scope === "document" ? "documento completo" : plural(pending.ids.length, "objeto", "objetos");
    const label = `${orientationLabel(pending.orientation)} (${scopeLabel})`;
    const result = editable.commitGesture(label);
    setPending(null);
    setOrientationMessage(null);
    if (!result.applied) return;
    if (pending.scope === "document") refitTo(editable.getSnapshot().frame ?? committedFrame);
    setActionNotice(
      `${label} aplicado.${result.skippedLockedObjects > 0 ? ` ${plural(result.skippedLockedObjects, "objeto está", "objetos están")} en capas bloqueadas y no se modificó.` : ""}`,
    );
  };

  const pendingText = pending
    ? `Se ${orientationVerb(pending.orientation)} ${pending.scope === "document" ? "TODO el documento" : `la selección (${plural(pending.ids.length, "objeto", "objetos")})`}: ${orientationLabel(pending.orientation)}.${
        pending.lockedCount > 0 ? ` ${plural(pending.lockedCount, "objeto está", "objetos están")} en capas bloqueadas y no se modificará.` : ""
      }`
    : null;
  const orientationScopeText =
    selectedObjects.length > 0
      ? `Rotar y reflejar afectan a la selección (${plural(selectedObjects.length, "objeto", "objetos")}).`
      : "Sin selección: rotar y reflejar afectan a TODO el documento.";

  // ---- Crop (M3-S02): marco propuesto sobre el canvas + panel con resumen "Qué se va a modificar" ----
  const [cropDraft, setCropDraft] = useState<DocumentFrame | null>(null);
  const [cropKeepRatio, setCropKeepRatio] = useState(false);
  const [cropRemoveOutside, setCropRemoveOutside] = useState(true);
  const [cropError, setCropError] = useState<string | null>(null);

  const cropSummary = useMemo(
    () => (cropDraft ? summarizeCrop(committedObjectsByLayer, cropDraft, { lockedLayerIds, hiddenLayerIds }, cropRemoveOutside) : null),
    [cropDraft, committedObjectsByLayer, lockedLayerIds, hiddenLayerIds, cropRemoveOutside],
  );

  const proposeCropFrame = (next: DocumentFrame): string | null => {
    const error = validateFrame(next);
    if (error) return error;
    setCropDraft(next);
    setCropError(null);
    return null;
  };

  const handleCropPreset = (preset: CropPreset): string | null => {
    let next: DocumentFrame | null;
    if (preset === "content") next = fitToContent(selectableObjects);
    else if (preset === "reset") next = committedFrame;
    else next = frameWithAspect(committedFrame, preset === "1:1" ? 1 : preset === "4:3" ? 4 / 3 : 16 / 9);
    if (!next) return "No hay contenido visible con tamaño suficiente para ajustar el marco.";
    return proposeCropFrame({ ...next });
  };

  const formatFrameSize = (target: DocumentFrame) =>
    mmFactor === null
      ? `${formatDisplayNumber(target.width)} × ${formatDisplayNumber(target.height)} u`
      : `${formatDisplayNumber(toMm(target.width, mmFactor))} × ${formatDisplayNumber(toMm(target.height, mmFactor))} mm`;

  const closeCrop = () => {
    setCropDraft(null);
    setCropError(null);
    setActiveTool("select");
  };

  const handleApplyCrop = () => {
    if (!cropDraft || !cropSummary) return;
    const checked = cropFrameOf(committedFrame, cropDraft);
    if (!checked.ok) {
      setCropError(checked.error);
      return;
    }
    const target = checked.frame;
    const label = `Recortar el área de trabajo a ${formatFrameSize(target)}`;
    const result = applyEdit(label, (state) => cropProduction(state, target, cropRemoveOutside));
    if (!result.applied) {
      setCropError(
        result.reason === "blocked"
          ? "Los objetos fuera del área están en capas bloqueadas u ocultas: no se pueden eliminar. Desbloquealas o desmarcá 'Eliminar objetos fuera del área'."
          : result.reason === "no_change"
            ? "No hay cambios para aplicar."
            : TRANSFORM_PENDING_MESSAGE,
      );
      return;
    }
    const parts = [`Área de trabajo recortada a ${formatFrameSize(target)}.`];
    if (cropSummary.removable > 0) parts.push(`${plural(cropSummary.removable, "objeto eliminado", "objetos eliminados")}.`);
    if (cropSummary.crossing > 0) parts.push(`${plural(cropSummary.crossing, "objeto cruza el borde y sigue completo", "objetos cruzan el borde y siguen completos")}.`);
    if (result.skippedLockedObjects > 0) parts.push(`${plural(result.skippedLockedObjects, "objeto en una capa bloqueada se conservó", "objetos en capas bloqueadas se conservaron")}.`);
    setActionNotice(parts.join(" "));
    closeCrop();
    refitTo(target);
  };

  const handleSelectTool = (tool: EditorTool) => {
    if (tool === activeTool) return;
    if (pending) cancelPending();
    // Cambiar de herramienta con una booleana abierta la cancela sin dejar rastro (el preview no entró a la pila de undo).
    closeBooleanSession();
    setBooleanNotice(null);
    // Cambiar de herramienta con Fill/Color a medias cancela la previsualización sin dejar rastro (nada entró a la pila de undo).
    if (colorSession) endColorSession();
    setColorMessage(null);
    setActionNotice(null);
    setOrientationMessage(null);
    setClipboardNotice(null);
    setArrangeNotice(null);
    if (tool === "crop") {
      // Sin documento medido no hay área de trabajo que recortar.
      if (!document || !isValidFrame(committedFrame)) return;
      setCropDraft({ ...committedFrame });
      setCropError(null);
    } else {
      setCropDraft(null);
      setCropError(null);
    }
    if (tool === "fill" || tool === "color") startColorSession(tool);
    setActiveTool(tool);
  };

  // Apply = Enter, Cancel = Escape para Crop y para una transformación pendiente. Enter dentro de un campo o sobre un botón conserva su
  // significado propio (confirmar el campo / activar el botón).
  useEffect(() => {
    if (!pending && !cropDraft && !colorSession) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (event.key === "Escape") {
        event.preventDefault();
        if (pending) cancelPending();
        else if (colorSession) {
          // Primer Escape: vuelve atrás desde la confirmación; el siguiente cancela Fill/Color (sin rastro).
          if (colorConfirming) setColorSession({ ...colorSession, confirmKey: null });
          else cancelColorTool();
        } else closeCrop();
      } else if (event.key === "Enter") {
        if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.tagName === "BUTTON" || target.isContentEditable)) return;
        event.preventDefault();
        if (pending) handleApplyPending();
        else if (colorSession) handleColorApply();
        else handleApplyCrop();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const selectedLayer = documentLayers.find((layer) => layer.groupId === selectedGroupId) ?? null;
  const isSelectedVisible = selectedGroupId ? (visibility[selectedGroupId] ?? true) : false;

  // ---- Copiar / Cortar / Pegar / Duplicar / Eliminar (M3-S06) ----
  // Portapapeles INTERNO de la sesión (ver lib/editor/clipboard.ts); se vacía al cambiar de documento. Copiar NO es un comando (no entra al historial ni
  // activa geometryDirty); cortar, pegar, duplicar y eliminar son UN comando cada uno (atómico: lo que no se puede aplicar se omite y se informa).
  const clipboard = useClipboard(clipboardScope);
  // Con una booleana abierta los atajos y las barras de portapapeles/organizar se apagan: los operandos están congelados hasta Apply/Cancel.
  const selectMoveTool = activeTool === "select" || activeTool === "move";
  const clipboardTool = selectMoveTool && !booleanOpen;
  const clipboardAvail = useMemo(
    () =>
      clipboardAvailability({
        selected: selectedObjects.length,
        editable: editableSelection.length,
        clipboardSize: clipboard.size,
        hasActiveLayer: selectedLayer !== null,
        suspended: pending !== null,
      }),
    [selectedObjects.length, editableSelection.length, clipboard.size, selectedLayer, pending],
  );

  const reportClipboard = (kind: ClipboardNotice["kind"], text: string) => setClipboardNotice({ scope: clipboardScope, kind, text });
  const finishClipboard = (summary: string, skipped: readonly PlanSkip[], verb: ClipboardVerb) =>
    reportClipboard("ok", skipped.length > 0 ? `${summary}. ${describeSkipped(skipped, verb)}.` : `${summary}.`);

  /** Aplica la producción de un plan como UN comando y deja la selección resultante, asociando la de antes y la de después al comando (undo/redo). */
  const applyClipboardEdit = (label: string, production: EditProduction, nextIds: string[], nextLayerId: string | null): ApplyEditResult => {
    const before = selectedObjectIds;
    const result = applyEdit(label, () => production);
    if (result.applied) {
      if (result.edit) selectionJournal.set(result.edit, { before, after: new Set(nextIds) });
      handleSelectObjects(nextIds, nextLayerId);
    }
    return result;
  };

  const performClipboardAction = (action: ClipboardAction) => {
    if (!document) return;
    setClipboardNotice(null);
    setActionNotice(null);
    if (pending !== null) {
      reportClipboard("error", TRANSFORM_PENDING_MESSAGE);
      return;
    }
    const snapshot = editable.getSnapshot();
    const selectedIds: ReadonlySet<string> = new Set(selectedObjects.map((object) => object.id));

    if (action === "copy") {
      const content = buildClipboard(selectedObjects, snapshot);
      if (!content) {
        reportClipboard("error", "No hay objetos seleccionados para copiar.");
        return;
      }
      clipboard.copy(content);
      reportClipboard("ok", `${outcomeText("copy", content.items.length)} al portapapeles del editor.`);
      return;
    }

    if (action === "cut" || action === "delete") {
      const cutPlan = action === "cut" ? planCut(snapshot, selectedIds) : null;
      const plan = cutPlan ?? planDelete(snapshot, selectedIds);
      if (!plan.production) {
        reportClipboard("error", plan.error ?? "No hay nada que eliminar.");
        return;
      }
      const result = applyClipboardEdit(plan.label, plan.production, [], null);
      if (!result.applied) {
        reportClipboard("error", describeEditFailure(result));
        return;
      }
      // Solo un corte APLICADO pisa el portapapeles, y solo con lo que cortó.
      if (cutPlan?.clipboard) clipboard.copy(cutPlan.clipboard);
      finishClipboard(outcomeText(action, plan.deleted.length), plan.skipped, action);
      return;
    }

    const duplicating = action === "duplicate";
    const mode: PasteMode = action === "paste-in-place" ? "in-place" : action === "paste-active" ? "active-layer" : "offset";
    const plan = duplicating
      ? planDuplicate(selectedObjects, snapshot, { offset: pasteOffset(1, mmFactor), createId })
      : planPaste(clipboard.content, snapshot, { mode, offset: clipboard.nextOffset(mmFactor), activeLayerId: selectedGroupId, createId });
    if (!plan.production) {
      reportClipboard("error", plan.error ?? "No se pudo pegar.");
      return;
    }
    const last = plan.newObjects[plan.newObjects.length - 1];
    const result = applyClipboardEdit(plan.label, plan.production, plan.newIds, last.layerGroupId);
    if (!result.applied) {
      reportClipboard("error", describeEditFailure(result));
      return;
    }
    // Pegar en el lugar no usa offset: no adelanta el contador (el próximo Pegar sigue siendo 1x). Duplicar no toca el portapapeles.
    if (!duplicating && mode !== "in-place") clipboard.registerPaste();
    finishClipboard(outcomeText(duplicating ? "duplicate" : "paste", plan.summary.pasted), plan.summary.skipped, duplicating ? "duplicate" : "paste");
  };

  // Atajos de portapapeles: listener de ventana (como Undo/Redo), con el foco en el canvas o en cualquier botón del editor, pero NUNCA dentro de
  // campos de texto (ahí Ctrl+C/V/X y Suprimir son del propio campo). Solo con Select/Move; el canvas ya resuelve Suprimir con su foco
  // (`defaultPrevented`). Mantener la tecla apretada no repite la acción (un comando por pulsación).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || !clipboardTool) return;
      const action = matchClipboardShortcut(event);
      if (!action || isTextFieldTarget(event.target)) return;
      if ((action === "copy" || action === "cut") && pageTextSelected(event.target)) return;
      // Suprimir sin selección no es nuestro (no se intercepta ni se avisa).
      if (action === "delete" && selectedObjects.length === 0) return;
      event.preventDefault();
      performClipboardAction(action);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  // ---- Fill / Recolor / Eyedropper (M3-S03) ----
  // Decisión de dominio (ver lib/editor/colors.ts): una capa = un color; la identidad es el groupId, nunca el hex. El "color activo" es por
  // eso una REFERENCIA a una capa (o un color libre nuevo que crea una capa al aplicar), y los alcances de Recolor son explícitos.
  const colorMode = activeTool === "fill" ? "fill" : activeTool === "color" ? "color" : null;

  // Una referencia a una capa que ya no existe (se deshizo su creación) no es un color activo.
  const activeTarget = useMemo(() => (resolveActiveColor(committedLayers, activeColor) ? activeColor : null), [committedLayers, activeColor]);

  const scopeAvailability = useMemo<Record<RecolorScope, string | null>>(
    () => ({
      selection: selectedObjects.length > 0 ? null : "sin selección",
      layer: selectedLayer ? null : "sin capa activa",
      document: committedLayers.length > 0 ? null : "sin capas",
    }),
    [selectedObjects.length, selectedLayer, committedLayers.length],
  );
  const requestedScope: RecolorScope = colorMode === "fill" ? "selection" : (colorSession?.scope ?? "selection");
  const colorScope: RecolorScope =
    scopeAvailability[requestedScope] === null || colorMode === "fill" ? requestedScope : (SCOPE_ORDER.find((candidate) => scopeAvailability[candidate] === null) ?? requestedScope);
  const sessionSourceId = colorSession?.sourceGroupId ?? null;
  const sessionMergeId = colorSession?.mergeIntoGroupId ?? null;
  const colorSourceId = useMemo(() => {
    if (colorScope === "selection") return null;
    const wanted = colorScope === "layer" ? selectedGroupId : (sessionSourceId ?? selectedGroupId);
    return committedLayers.some((layer) => layer.groupId === wanted) ? wanted : null;
  }, [colorScope, selectedGroupId, sessionSourceId, committedLayers]);
  // La fusión solo vale si el destino sigue siendo una capa con el color elegido (si el color cambia, se vuelve a "no fusionar").
  const colorMergeInto = useMemo(() => {
    if (colorScope === "selection" || !sessionMergeId) return null;
    return mergeCandidates(committedLayers, colorSourceId, activeTarget).some((layer) => layer.groupId === sessionMergeId) ? sessionMergeId : null;
  }, [colorScope, sessionMergeId, committedLayers, colorSourceId, activeTarget]);

  const hasColorSession = colorSession !== null;
  const colorRequest = useMemo<RecolorRequest | null>(
    () =>
      hasColorSession && activeTarget
        ? { target: activeTarget, objectIds: colorScope === "selection" ? selectedObjectIds : undefined, sourceGroupId: colorSourceId, mergeIntoGroupId: colorMergeInto }
        : null,
    [hasColorSession, activeTarget, colorScope, selectedObjectIds, colorSourceId, colorMergeInto],
  );
  // Estado CONFIRMADO sobre el que se planea (nunca el vivo: la previsualización lo cambia en cada paso y el plan se recalcularía en bucle).
  const colorState = useMemo(
    () => ({
      objectsByLayer: committedObjectsByLayer,
      frame: committedFrame,
      layers: toLayerMetas(committedLayers, (layer) => (isolatedGroupId ? layer.groupId === isolatedGroupId : (serverVisibility[layer.groupId] ?? layer.visible))),
    }),
    [committedObjectsByLayer, committedFrame, committedLayers, serverVisibility, isolatedGroupId],
  );
  const colorPlan = useMemo(() => (colorRequest ? planRecolor(colorScope, colorState, colorRequest) : null), [colorRequest, colorScope, colorState]);
  const colorRequestKey = colorRequest ? JSON.stringify([colorScope, colorRequest.target, colorSourceId, colorMergeInto, selectedObjectIds.size]) : null;
  const colorConfirming = colorSession?.confirmKey != null && colorSession.confirmKey === colorRequestKey;
  const colorNeedsConfirmation = colorPlan?.production ? needsConfirmation(colorPlan.summary, colorConfirmThreshold) : false;

  const { beginGesture, previewEdit, cancelGesture } = editable;
  const colorArmed = colorSession?.armed ?? false;
  // Previsualización con el gesto de S01: parte SIEMPRE del estado confirmado, no llena la pila de undo y se descarta sin rastro. Si el plan no
  // es aplicable (sin color, destino bloqueado...) no se muestra nada.
  useEffect(() => {
    if (!hasColorSession) return;
    if (!colorArmed || !colorRequest || !colorPlan?.production) {
      cancelGesture();
      return;
    }
    beginGesture();
    previewEdit((state) => planRecolor(colorScope, state, colorRequest).production);
  }, [hasColorSession, colorArmed, colorRequest, colorPlan, colorScope, beginGesture, previewEdit, cancelGesture]);

  // Tras aplicar, el plan sobre el estado ya confirmado dice "ya están en esa capa": no es un error que mostrar mientras no haya una interacción nueva.
  const panelPlan = colorPlan && !colorArmed && !colorPlan.production ? { ...colorPlan, error: null } : colorPlan;

  function startColorSession(tool: "fill" | "color") {
    const scope: RecolorScope = tool === "fill" ? "selection" : selectedObjects.length > 0 ? "selection" : selectedGroupId ? "layer" : "document";
    setColorSession({ scope, sourceGroupId: selectedGroupId, mergeIntoGroupId: null, confirmKey: null, armed: true });
  }

  function endColorSession() {
    editable.cancelGesture();
    setColorSession(null);
  }

  function cancelColorTool() {
    endColorSession();
    setColorMessage(null);
    setActiveTool("select");
  }

  const updateColorSession = (patch: Partial<ColorSession>) => {
    setColorMessage(null);
    setColorSession((current) => (current ? { ...current, confirmKey: null, armed: true, ...patch } : current));
  };

  const handlePickColor = (groupId: string) => {
    setActionNotice(null);
    setColorMessage(null);
    setActiveColor({ kind: "layer", groupId });
    setColorSession((current) => (current ? { ...current, confirmKey: null, mergeIntoGroupId: null, armed: true } : current));
  };

  const handleFreeColor = (hex: string) => {
    setColorMessage(null);
    // Un color libre es un color NUEVO (capa nueva al aplicar): con el mismo hex ya elegido se conserva su id de capa futura.
    if (activeColor?.kind === "new" && activeColor.hex === hex) return;
    setActiveColor({ kind: "new", hex, groupId: crypto.randomUUID() });
    setColorSession((current) => (current ? { ...current, confirmKey: null, mergeIntoGroupId: null, armed: true } : current));
  };

  const colorSummaryNotice = (plan: ColorPlan, label: string): string => {
    const { summary } = plan;
    const parts = [`${label} aplicado.`];
    if (summary.destination?.created) parts.push(`Se creó la capa nueva «${summary.destination.name}» (sin guardar todavía).`);
    if (summary.merge) parts.push(`«${summary.merge.fromName}» quedó vacía (no se eliminó).`);
    if (summary.skippedLocked > 0) parts.push(`${plural(summary.skippedLocked, "objeto está", "objetos están")} en capas bloqueadas y no se modificó.`);
    if (summary.skippedHidden > 0) parts.push(`${plural(summary.skippedHidden, "objeto está", "objetos están")} en capas ocultas y no se modificó.`);
    return parts.join(" ");
  };

  /** Aplica Fill/Recolor como UN comando (objetos + estructura de capas). Descarta antes la previsualización y vuelve a evaluar contra el estado vigente. */
  const commitColor = (scope: RecolorScope, request: RecolorRequest, plan: ColorPlan) => {
    editable.cancelGesture();
    const label = recolorLabel(plan.summary);
    const result = applyEdit(label, (state) => planRecolor(scope, state, request).production);
    if (!result.applied) {
      setColorMessage(
        result.reason === "blocked"
          ? "La capa de origen o de destino está bloqueada u oculta: no se puede modificar. Desbloqueala o mostrala en el panel de Capas."
          : result.reason === "no_change"
            ? "No hay cambios para aplicar."
            : TRANSFORM_PENDING_MESSAGE,
      );
      return;
    }
    setColorMessage(null);
    setActionNotice(colorSummaryNotice(plan, label));
    setColorSession((current) => (current ? { ...current, confirmKey: null, mergeIntoGroupId: null, armed: false } : current));
    const destination = plan.summary.destination;
    if (scope === "selection" && destination) {
      // El color activo pasa a ser la capa destino (existente o recién creada) y el Inspector/paleta/capas la muestran.
      setActiveColor({ kind: "layer", groupId: destination.groupId });
      selectGroup(destination.groupId);
    }
  };

  function handleColorApply() {
    if (!colorSession || !colorRequest || !colorPlan?.production) return;
    if (colorNeedsConfirmation && !colorConfirming) {
      setColorSession({ ...colorSession, confirmKey: colorRequestKey });
      return;
    }
    commitColor(colorScope, colorRequest, colorPlan);
  }

  // Fill sobre el canvas: aplica el color activo al objeto (o a toda la selección si el objeto forma parte de ella).
  const handleFillObject = (objectId: string) => {
    if (!colorSession) return;
    setColorMessage(null);
    setActionNotice(null);
    if (!activeTarget) {
      setColorMessage("Elegí un color (paleta, selector o Eyedropper) antes de rellenar.");
      return;
    }
    const ids: ReadonlySet<string> = selectedObjectIds.has(objectId) ? selectedObjectIds : new Set([objectId]);
    const request: RecolorRequest = { target: activeTarget, objectIds: ids };
    const plan = planRecolor("selection", colorState, request);
    if (!plan.production) {
      setColorMessage(plan.error);
      return;
    }
    if (!selectedObjectIds.has(objectId)) {
      const hit = selectableObjects.find((object) => object.id === objectId);
      handleSelectObjects([objectId], hit?.layerGroupId ?? null);
    }
    if (needsConfirmation(plan.summary, colorConfirmThreshold)) {
      // Alcance grande: no se aplica al click; el panel muestra la previsualización y pide confirmación.
      setColorSession({ ...colorSession, armed: true, confirmKey: JSON.stringify(["selection", activeTarget, null, null, ids.size]) });
      return;
    }
    commitColor("selection", request, plan);
  };

  const colorConfirmText = colorPlan
    ? `${recolorHeadline(colorPlan.summary)}${colorScope === "document" ? " Alcance: TODO el documento." : ""}${colorPlan.summary.merge ? " Incluye fusionar capas." : ""} ¿Confirmás?`
    : "";

  // ---- Organizar: alinear / distribuir / z-order (M3-S07) ----
  // Cada operación es UN comando (applyEdit) sobre lo que NO está bloqueado; lo bloqueado se excluye por completo y se informa. Alinear y
  // distribuir trasladan (componen la matriz); el z-order permuta la lista de cada capa y nunca cambia un objeto de capa (ver lib/editor/arrange.ts).
  // La selección no cambia: deshacer/rehacer la conservan sin ayuda del diario de selección.
  const arrangeAvail = useMemo(
    () => arrangeAvailability(colorState, selectedObjects, { reference: arrangeReference, suspended: pending !== null }),
    [colorState, selectedObjects, arrangeReference, pending],
  );

  const reportArrange = (kind: ArrangeNotice["kind"], text: string) => setArrangeNotice({ scope: clipboardScope, kind, text });

  const performArrangeAction = (id: ArrangeActionId) => {
    if (!document) return;
    setArrangeNotice(null);
    setClipboardNotice(null);
    setActionNotice(null);
    if (pending !== null) {
      reportArrange("error", TRANSFORM_PENDING_MESSAGE);
      return;
    }
    const context = { mmPerUnit: mmFactor, reference: arrangeReference };
    const result = runArrange(editable.getSnapshot(), selectedObjects, id, { reference: arrangeReference });
    const production = result.production;
    if (!production) {
      const message = describeArrange(id, result, context);
      reportArrange(message.kind, message.text);
      return;
    }
    const applied = applyEdit(result.label, () => production);
    if (!applied.applied) {
      reportArrange("error", describeEditFailure(applied));
      return;
    }
    const message = describeArrange(id, result, context);
    reportArrange(message.kind, message.text);
  };

  // Atajos de z-order: Ctrl/Cmd+] y [ (con Shift: al frente / al fondo), listener de ventana como el resto, NUNCA dentro de campos de texto. Solo con
  // Select/Move y con una selección (sin ella no se intercepta: Cmd+[ y Cmd+Shift+[ son de navegación del navegador). Sin auto-repetición.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || !clipboardTool) return;
      const action = matchArrangeShortcut(event);
      if (!action || isTextFieldTarget(event.target) || selectedObjects.length === 0) return;
      event.preventDefault();
      performArrangeAction(zOrderActionId(action));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  // ---- Booleanas (M3-S08) ----
  // Unión / Diferencia / Intersección / XOR sobre 2+ formas rellenas, con orden de operandos explícito (A, B, C...), capa destino que SIEMPRE decide el
  // usuario cuando los operandos están en capas distintas, preview del servidor (debounce + AbortController, una petición viva) y Apply/Cancel. Aplicar es
  // UN comando atómico (objetos + capa nueva); Cancel y el preview no dejan rastro (nada entra a la pila de undo). Ver lib/editor/boolean.ts.
  const booleanBarReason = useMemo(
    () => booleanAvailability(selectedObjects, colorState, { suspended: pending !== null }),
    [selectedObjects, colorState, pending],
  );
  const reportBoolean = (kind: BooleanNotice["kind"], text: string) => setBooleanNotice({ scope: clipboardScope, kind, text });

  const startBoolean = (op: BooleanOp) => {
    if (!document) return;
    setActionNotice(null);
    if (booleanSession) {
      // Ya hay una abierta: elegir otra operación solo cambia la operación (los operandos y su orden se conservan).
      setBooleanSession({ ...booleanSession, op, message: null });
      return;
    }
    if (booleanBarReason) {
      reportBoolean("error", booleanBarReason);
      return;
    }
    setBooleanNotice(null);
    setBooleanSession({
      op,
      order: paintOrderIds(
        selectedObjects.map((object) => object.id),
        colorState,
      ),
      target: "",
      newHex: "",
      newGroupId: createId?.() ?? crypto.randomUUID(),
      keepOriginals: false,
      toleranceMm: DEFAULT_BOOLEAN_TOLERANCE_MM,
      message: null,
    });
  };

  const updateBoolean = (patch: Partial<BooleanSession>) => setBooleanSession((current) => (current ? { ...current, message: null, ...patch } : current));

  const booleanOperandObjects = useMemo(() => {
    if (!booleanSession) return [];
    const byId = new Map<string, (typeof selectableObjects)[number]>();
    for (const objects of Object.values(colorState.objectsByLayer)) for (const object of objects) byId.set(object.id, object);
    return booleanSession.order.flatMap((id) => {
      const object = byId.get(id);
      return object ? [object] : [];
    });
  }, [booleanSession, colorState.objectsByLayer]);

  let booleanTargetChoice: BooleanTargetChoice | null = null;
  if (booleanSession && booleanSession.target !== "") {
    booleanTargetChoice =
      booleanSession.target === NEW_LAYER_VALUE
        ? { kind: "new", hex: booleanSession.newHex, groupId: booleanSession.newGroupId }
        : { kind: "layer", groupId: booleanSession.target };
  }
  const booleanOp = booleanSession?.op ?? null;
  const booleanOrder = booleanSession?.order ?? null;
  const booleanKeep = booleanSession?.keepOriginals ?? false;
  const booleanToleranceMm = booleanSession?.toleranceMm ?? DEFAULT_BOOLEAN_TOLERANCE_MM;
  const booleanTargetKey = booleanTargetChoice ? JSON.stringify(booleanTargetChoice) : "";
  const booleanPlanResult = useMemo(() => {
    if (booleanOp === null || booleanOrder === null) return null;
    if (booleanOperandObjects.length < booleanOrder.length) {
      return { ok: false as const, reason: "missing" as const, message: "Algún operando ya no existe en el documento. No se modificó nada." };
    }
    return planBoolean(booleanOperandObjects, colorState, {
      op: booleanOp,
      order: booleanOrder,
      targetLayer: booleanTargetKey ? (JSON.parse(booleanTargetKey) as BooleanTargetChoice) : null,
      keepOriginals: booleanKeep,
      tolerance: toleranceFromMm(booleanToleranceMm, mmFactor),
    });
  }, [booleanOp, booleanOrder, booleanOperandObjects, colorState, booleanTargetKey, booleanKeep, booleanToleranceMm, mmFactor]);
  const booleanPlan = booleanPlanResult?.ok ? booleanPlanResult.plan : null;
  const booleanRejection = booleanPlanResult && !booleanPlanResult.ok ? booleanPlanResult.message : null;

  const booleanPreview = useBooleanOperation({ request: booleanPlan?.request ?? null, requestKey: booleanPlan?.requestKey ?? null });
  const booleanOutcomeResult = useMemo(
    () => (booleanPlan && booleanPreview.response ? booleanOutcome(booleanPlan, booleanPreview.response) : null),
    [booleanPlan, booleanPreview.response],
  );
  const booleanOutcomeValue = booleanOutcomeResult?.ok ? booleanOutcomeResult.outcome : null;
  const booleanPreviewError = booleanPreview.errorMessage ?? (booleanOutcomeResult && !booleanOutcomeResult.ok ? booleanOutcomeResult.error : null);

  // Lo último, para el Apply asíncrono (tras esperar al servidor el estado puede ser otro).
  const booleanLatest = useRef({ session: booleanSession, plan: booleanPlan });
  useEffect(() => {
    booleanLatest.current = { session: booleanSession, plan: booleanPlan };
  });
  const booleanApplyingRef = useRef(false);

  const booleanReadyText = (() => {
    if (!booleanOutcomeValue) return null;
    const dropped = booleanOutcomeValue.discarded > 0 ? ` (${plural(booleanOutcomeValue.discarded, "pieza despreciable descartada", "piezas despreciables descartadas")}.)` : "";
    if (booleanOutcomeValue.kind === "empty") return `El resultado está vacío: la operación no deja ninguna forma. No se puede aplicar.${dropped}`;
    if (booleanOutcomeValue.kind === "unchanged") return "El resto de los operandos no toca a A: A se conserva intacto, con sus curvas.";
    return `Resultado: ${plural(booleanOutcomeValue.shapes.length, "pieza", "piezas")}.${dropped}`;
  })();

  const booleanApplyDisabledReason = (() => {
    if (!booleanSession) return "No hay una operación abierta.";
    if (booleanRejection) return `Corregí la selección: ${booleanRejection}`;
    if (!booleanPlan) return "No hay una operación para aplicar.";
    if (booleanPlan.target === null) return booleanPlan.targetIssue;
    if (booleanPreviewError) return "El cálculo falló: reintentalo o cambiá la operación.";
    if (booleanOutcomeValue?.kind === "empty") return "El resultado está vacío: no hay nada que aplicar.";
    if (booleanOutcomeValue?.kind === "unchanged" && booleanPlan.keepOriginals) return "El resultado es idéntico a A: no hay nada que agregar.";
    return null;
  })();

  const handleBooleanApply = async () => {
    const started = booleanLatest.current;
    if (!started.session || !started.plan || booleanApplyingRef.current) return;
    if (started.plan.target === null) {
      updateBoolean({ message: started.plan.targetIssue });
      return;
    }
    booleanApplyingRef.current = true;
    setBooleanApplying(true);
    try {
      // Si cambió algo desde el último preview, se recalcula primero; si ya está calculado, se usa tal cual.
      const ensured = await booleanPreview.ensure();
      const latest = booleanLatest.current;
      if (!latest.session || !latest.plan) return;
      if (!ensured.ok) {
        if (!ensured.aborted) updateBoolean({ message: ensured.message });
        return;
      }
      if (latest.plan.requestKey !== started.plan.requestKey) {
        updateBoolean({ message: "La operación cambió mientras se calculaba: revisá el resultado y volvé a aplicar." });
        return;
      }
      const plan = latest.plan;
      const before = selectedObjectIds;
      const fresh = editable.getSnapshot();
      const applied = applyBooleanResult(plan, fresh, ensured.response, createId);
      if (!applied.ok) {
        updateBoolean({ message: applied.error });
        return;
      }
      const production = applied.production;
      const result = applyEdit(booleanLabel(applied.summary), (current) => (current.objectsByLayer === fresh.objectsByLayer ? production : null));
      if (!result.applied) {
        updateBoolean({ message: result.reason === "blocked" ? "Alguna capa está bloqueada u oculta: no se puede modificar. No se hizo ningún cambio." : describeEditFailure(result) });
        return;
      }
      if (result.edit) selectionJournal.set(result.edit, { before, after: new Set(applied.resultIds) });
      handleSelectObjects(applied.resultIds, applied.targetGroupId);
      closeBooleanSession();
      reportBoolean("ok", booleanNotice(applied.summary));
    } finally {
      booleanApplyingRef.current = false;
      setBooleanApplying(false);
    }
  };

  // Apply = Enter, Cancel = Escape (como Crop y Fill/Color). Enter dentro de un campo, lista desplegable o sobre un botón conserva su significado propio.
  useEffect(() => {
    if (!booleanOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (event.key === "Escape") {
        event.preventDefault();
        closeBooleanSession();
      } else if (event.key === "Enter") {
        if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.tagName === "BUTTON" || target.isContentEditable)) return;
        event.preventDefault();
        if (booleanApplyDisabledReason === null) void handleBooleanApply();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const booleanPanelOperands = booleanOperandObjects.map((object, index) => ({
    id: object.id,
    letter: operandLetter(index),
    name: describeOperand(object, index, colorState).name,
    colorHex: colorState.layers.find((layer) => layer.groupId === object.layerGroupId)?.colorHex ?? "#999999",
  }));
  const booleanOverlay = booleanSession
    ? {
        operands: booleanOperandObjects.map((object, index) => ({ letter: operandLetter(index), object })),
        shapes: booleanOutcomeValue?.shapes ?? [],
        color: booleanPlan?.target?.colorHex ?? null,
      }
    : undefined;

  // ---- Draw / Erase (M3-S04) ----
  // Toda geometría nueva pertenece a una capa identificada (la activa, o una «Dibujo» nueva en el mismo comando); Erase resta geometría real en el
  // servidor. La orquestación (borrador de la pluma, pipelines trazo -> servidor -> UN comando, teclado) vive en `useDrawEraseTools`.
  const tools = useDrawEraseTools({
    activeTool,
    editable,
    layers: colorState.layers,
    activeGroupId: selectedGroupId,
    selectGroup,
    mmFactor,
    onNotice: setActionNotice,
  });
  const drawEraseSurface =
    activeTool === "draw" || activeTool === "erase"
      ? {
          tool: activeTool,
          drawMode: tools.draw.mode,
          draft: tools.draw.draft,
          lineWidthUnits: toDocumentUnits(tools.draw.lineWidthMm, tools.unit),
          onPolylinePoint: tools.draw.addPoint,
          onPolylineFinish: () => tools.draw.finish(false),
          onFreehandStroke: tools.draw.commitFreehand,
          eraseMode: tools.erase.mode,
          radiusUnits: tools.erase.radiusUnits,
          busy: tools.busy,
          onEraseObjects: tools.erase.eraseObjects,
          onEraseStroke: (points: Point[]) => void tools.erase.eraseStroke(points),
        }
      : undefined;

  // ---- Path (M3-S05) ----
  // Edita los nodos y handles del ÚNICO objeto seleccionado en su espacio local (la matriz no se toca). La selección de objetos es la del shell: un
  // click sobre otro objeto estando en Path lo selecciona, y Escape/Enter vuelven a Select. Todo gesto de nodos es UN comando.
  const pathTool = usePathTool({
    activeTool,
    editable,
    layers: colorState.layers,
    selectedObjects,
    frame: committedFrame,
    mmFactor,
    onNotice: setActionNotice,
    onPickObject: (objectId) => handleSelectObjects([objectId], selectableObjects.find((object) => object.id === objectId)?.layerGroupId ?? null),
    onExit: () => handleSelectTool("select"),
  });
  const pathSurface = activeTool === "path" && pathTool.object && pathTool.model ? { object: pathTool.object, model: pathTool.model, selection: pathTool.keys, ...pathTool.surface } : undefined;

  const handleFit = () => {
    if (!document) return;
    // Ajusta el ÁREA DE TRABAJO vigente (M3-S02), no el viewBox original.
    fitToScreen(canvasSize, { width: frame.width, height: frame.height });
  };
  const frameSize = frameSizeMm(frame, mmFactor);

  // Cualquier mutación del VectorDocument marca "dirty" EN STAGING (M2.2-S05, idle/dirty ->
  // useWorkspaceSave; M2.2-S07: ese "dirty" ahora arranca el debounce que dispara el primer Save
  // automáticamente). Una vez que hay `savedProjectId` (sesión ya guardada), el PATCH de cada
  // mutación YA ES el autosave real (ver `trackPatch`, conectado dentro de
  // useVectorDocument/useManufacturingOperations) -- llamar `markDirty()` acá dejaría un "dirty"
  // mentiroso, inmediatamente pisado por el resultado del PATCH (spec.md M2.2-S07, "Estado
  // Dirty/Saving/Saved/Error").
  const { markDirty } = workspaceSave;
  // Capas creadas en el cliente (`isNew`, M3-S03): no existen en el servidor, así que su metadata se edita en LOCAL y NUNCA dispara un PATCH
  // ni marca "dirty" del documento guardado (la geometría sin guardar ya la refleja `geometryDirty`). Las capas del servidor siguen como siempre.
  const newLayerOf = (groupId: string) => documentLayers.find((layer) => layer.groupId === groupId && layer.isNew === true);
  const handleToggleVisibility = (groupId: string) => {
    const created = newLayerOf(groupId);
    if (created) {
      editable.updateLocalLayer(groupId, { visible: !created.visible });
      return;
    }
    if (!savedProjectId) markDirty();
    toggleVisibility(groupId);
  };
  const handleToggleLocked = (groupId: string) => {
    const created = newLayerOf(groupId);
    if (created) {
      editable.updateLocalLayer(groupId, { locked: !created.locked });
      return;
    }
    if (!savedProjectId) markDirty();
    toggleLocked(groupId);
  };
  const handleRenameLayer = (groupId: string, name: string) => {
    const created = newLayerOf(groupId);
    if (created) {
      const trimmed = name.trim();
      if (trimmed && trimmed !== created.name) editable.updateLocalLayer(groupId, { name: trimmed });
      return;
    }
    if (!savedProjectId) markDirty();
    renameLayer(groupId, name);
  };
  const handleReorderLayers = (orderedGroupIds: string[]) => {
    const newIds = new Set(documentLayers.filter((layer) => layer.isNew).map((layer) => layer.groupId));
    if (newIds.size === 0) {
      if (!savedProjectId) markDirty();
      reorderLayers(orderedGroupIds);
      return;
    }
    // El servidor solo conoce SUS capas: se le manda el nuevo orden de ellas (PATCH como siempre) y las capas nuevas se acomodan en local
    // con un `order` fraccionario entre sus vecinas, para que el orden pedido se vea exacto sin persistir nada de las capas nuevas.
    const serverIds = orderedGroupIds.filter((groupId) => !newIds.has(groupId));
    const serverChanged = serverIds.length !== serverLayers.length || serverIds.some((groupId, index) => serverLayers[index]?.groupId !== groupId);
    if (serverChanged) {
      if (!savedProjectId) markDirty();
      reorderLayers(serverIds);
    }
    const serverOrder = new Map(serverLayers.map((layer) => [layer.groupId, serverChanged ? serverIds.indexOf(layer.groupId) : layer.order]));
    const orders = placeNewLayers(orderedGroupIds, (groupId) => newIds.has(groupId), (groupId) => serverOrder.get(groupId) ?? 0);
    for (const [groupId, order] of Object.entries(orders)) editable.updateLocalLayer(groupId, { order });
  };
  const handleChangeOperation: typeof assignManufacturingOperation = (groupId, operation) => {
    if (newLayerOf(groupId)) {
      editable.updateLocalLayer(groupId, { manufacturingOperation: operation });
      return;
    }
    if (!savedProjectId) markDirty();
    assignManufacturingOperation(groupId, operation);
  };

  return (
    <div className="editor-shell">
      <EditorHeader
        projectName={projectName}
        onClose={handleClose}
        saveState={workspaceSave.state}
        saveErrorMessage={workspaceSave.errorMessage}
        canSave={status === "ready" && Boolean(document)}
        onSave={workspaceSave.save}
        // TODO(M3-S13): persistir la geometría, el marco del documento Y la estructura de capas (serializeEditableLayer + serializeFrame ->
        // DocumentVersion nueva con viewBox/mm; las capas `isNew` creadas por Fill se crean en el servidor con su color de paleta y los
        // colores recoloreados se guardan sobre el mismo groupId) y limpiar `geometryDirty` al confirmar el guardado. Hasta entonces el indicador debe seguir diciendo
        // "Cambios de geometría sin guardar" (un crop o un giro del documento también lo activan).
        geometryDirty={geometryDirty}
        canUndo={editable.canUndo}
        canRedo={editable.canRedo}
        undoLabel={editable.undoLabel}
        redoLabel={editable.redoLabel}
        onUndo={undoWithView}
        onRedo={redoWithView}
      />

      <div className="editor-shell__body">
        <EditorToolbar activeTool={activeTool} onSelectTool={handleSelectTool} />

        <main className="editor-shell__canvas-area" aria-label="Canvas del documento">
          {status === "loading" || status === "idle" ? (
            <p className="editor-shell__status" role="status">
              Cargando el documento del proyecto…
            </p>
          ) : status === "error" ? (
            <div className="editor-shell__status editor-shell__status--error" role="alert">
              <p>{errorMessage ?? "No se pudo cargar el documento del proyecto."}</p>
              <button type="button" className="upload-actions__button" onClick={reload}>
                Reintentar
              </button>
            </div>
          ) : status === "empty" ? (
            <p className="editor-shell__status" role="status">
              {EMPTY_REASON_COPY[emptyReason ?? ""] ?? "No hay contenido para mostrar todavía."}
            </p>
          ) : document ? (
            <>
              {(activeTool === "select" || activeTool === "move") && (
                <OrientationBar
                  scopeText={orientationScopeText}
                  pending={pending !== null}
                  pendingText={pendingText}
                  pendingIsIdentity={pending !== null && isIdentityOrientation(pending.orientation)}
                  message={orientationMessage}
                  onStep={handleOrientationStep}
                  onApply={handleApplyPending}
                  onCancel={cancelPending}
                />
              )}
              {clipboardTool && (
                <ClipboardBar
                  availability={clipboardAvail}
                  clipboardSize={clipboard.size}
                  notice={clipboardNotice}
                  onAction={performClipboardAction}
                  extraShortcuts={ARRANGE_SHORTCUTS}
                />
              )}
              {clipboardTool && (
                <ArrangeBar
                  availability={arrangeAvail}
                  reference={arrangeReference}
                  onReferenceChange={setArrangeReference}
                  notice={arrangeNotice}
                  onAction={performArrangeAction}
                />
              )}
              {selectMoveTool && <BooleanBar unavailableReason={booleanBarReason} activeOp={booleanSession?.op ?? null} notice={booleanNoticeShown} onStart={startBoolean} />}
              <VectorCanvas
                layers={documentLayers}
                visibility={visibility}
                sourceWidthPx={document.sourceWidthPx}
                sourceHeightPx={document.sourceHeightPx}
                frame={frame}
                selectedGroupId={selectedGroupId}
                editable={editable}
                selectableObjects={selectableObjects}
                selectedObjectIds={selectedObjectIds}
                onSelectObjects={handleSelectObjects}
                tool={activeTool}
                transform={transform}
                onZoomBy={zoomBy}
                onPanBy={panBy}
                onMeasure={setCanvasSize}
                editingSuspended={pending !== null || booleanOpen}
                cropFrame={cropDraft}
                cropKeepRatio={cropKeepRatio}
                onCropFrameChange={proposeCropFrame}
                onOrientationShortcut={handleOrientationStep}
                onPickColor={handlePickColor}
                onFillObject={handleFillObject}
                onToolShortcut={handleSelectTool}
                onDeleteSelection={() => performClipboardAction("delete")}
                toolSurface={drawEraseSurface}
                pathSurface={pathSurface}
                booleanOverlay={booleanOverlay}
                onEditPath={(objectId, layerGroupId) => {
                  handleSelectObjects([objectId], layerGroupId);
                  handleSelectTool("path");
                }}
              />
              {actionNotice && (
                <p className="editor-shell__action-notice" role="status">
                  {actionNotice}
                </p>
              )}
            </>
          ) : null}
        </main>

        <aside className="editor-shell__right-rail" aria-label="Paneles del documento">
          <PreviewNavigator
            layers={committedLayers}
            visibility={visibility}
            // La miniatura sigue el ÁREA DE TRABAJO confirmada (sus imágenes se serializan con ese viewBox).
            sourceWidthPx={committedFrame.width}
            sourceHeightPx={committedFrame.height}
            transform={transform}
            viewportSize={canvasSize}
            layerImageOverrides={previewImageOverrides}
          />

          {activeTool === "crop" && cropDraft && cropSummary && (
            <CropPanel
              frame={committedFrame}
              draft={cropDraft}
              mmPerUnit={mmFactor}
              keepRatio={cropKeepRatio}
              onKeepRatioChange={setCropKeepRatio}
              removeOutside={cropRemoveOutside}
              onRemoveOutsideChange={setCropRemoveOutside}
              summary={cropSummary}
              error={cropError}
              onDraftChange={proposeCropFrame}
              onPreset={handleCropPreset}
              onApply={handleApplyCrop}
              onCancel={closeCrop}
            />
          )}

          {booleanSession && (
            <BooleanPanel
              op={booleanSession.op}
              onOpChange={(op) => updateBoolean({ op })}
              operands={booleanPanelOperands}
              onMoveOperand={(index, delta) => updateBoolean({ order: moveOperand(booleanSession.order, index, delta) })}
              onReverse={() => updateBoolean({ order: reverseOperands(booleanSession.order) })}
              layersDiffer={booleanPlan?.layersDiffer ?? new Set(booleanOperandObjects.map((object) => object.layerGroupId)).size > 1}
              resolvedTarget={booleanPlan?.target ?? null}
              targetCandidates={booleanTargetCandidates(booleanOperandObjects, colorState.layers).map(({ layer, isOperandLayer }) => ({
                groupId: layer.groupId,
                name: layer.name,
                colorHex: layer.colorHex,
                isOperandLayer,
              }))}
              targetValue={booleanSession.target}
              onTargetChange={(value) => updateBoolean({ target: value })}
              newColorHex={booleanSession.newHex}
              onNewColorChange={(hex) => updateBoolean({ newHex: hex })}
              targetIssue={booleanPlan?.targetIssue ?? null}
              keepOriginals={booleanSession.keepOriginals}
              onKeepOriginalsChange={(value) => updateBoolean({ keepOriginals: value })}
              toleranceMm={booleanSession.toleranceMm}
              unitLabel={mmFactor === null ? "u" : "mm"}
              onToleranceChange={(value) => updateBoolean({ toleranceMm: value })}
              preview={{
                status: booleanPreviewError ? "error" : booleanPreview.status,
                readyText: booleanReadyText,
                empty: booleanOutcomeValue?.kind === "empty",
                errorMessage: booleanPreviewError,
              }}
              rejection={booleanRejection}
              message={booleanSession.message}
              applying={booleanApplying}
              applyDisabledReason={booleanApplyDisabledReason}
              onApply={() => void handleBooleanApply()}
              onCancel={closeBooleanSession}
              onRetry={booleanPreview.retry}
            />
          )}

          {colorMode && colorSession && (
            <ColorPanel
              mode={colorMode}
              layers={committedLayers}
              target={activeTarget}
              onPickLayer={handlePickColor}
              onFreeColor={handleFreeColor}
              scope={colorScope}
              onScopeChange={(next) => updateColorSession({ scope: next, mergeIntoGroupId: null })}
              scopeAvailability={scopeAvailability}
              sourceGroupId={colorSourceId}
              onSourceChange={(groupId) => updateColorSession({ sourceGroupId: groupId, mergeIntoGroupId: null })}
              mergeIntoGroupId={colorMergeInto}
              onMergeChange={(groupId) => updateColorSession({ mergeIntoGroupId: groupId })}
              plan={panelPlan}
              message={colorMessage}
              confirming={colorConfirming}
              confirmText={colorConfirmText}
              onApply={handleColorApply}
              onConfirm={() => colorRequest && colorPlan && commitColor(colorScope, colorRequest, colorPlan)}
              onBack={() => updateColorSession({})}
              onCancel={cancelColorTool}
            />
          )}

          {activeTool === "eyedropper" && <EyedropperPanel layers={committedLayers} target={activeTarget} />}

          {activeTool === "draw" && (
            <DrawPanel
              mode={tools.draw.mode}
              onModeChange={tools.draw.setMode}
              unitLabel={tools.unit.label}
              lineWidth={tools.draw.lineWidthMm}
              onLineWidthChange={tools.draw.setLineWidthMm}
              simplify={tools.draw.simplifyMm}
              onSimplifyChange={tools.draw.setSimplifyMm}
              closeFreehand={tools.draw.closeFreehand}
              onCloseFreehandChange={tools.draw.setCloseFreehand}
              pointCount={tools.draw.draft.length}
              target={tools.draw.target}
              message={tools.draw.message}
              serverError={tools.serverError}
              busy={tools.busy}
              onFinish={tools.draw.finish}
              onUndoPoint={tools.draw.undoPoint}
              onCancel={tools.draw.cancelDraft}
              onCancelCalculation={tools.cancelCalculation}
            />
          )}

          {activeTool === "erase" && (
            <ErasePanel
              mode={tools.erase.mode}
              onModeChange={tools.erase.setMode}
              unitLabel={tools.unit.label}
              radius={tools.erase.radiusMm}
              onRadiusChange={tools.erase.setRadiusMm}
              scope={tools.erase.scope}
              onScopeChange={tools.erase.setScope}
              activeLayerName={committedLayers.find((layer) => layer.groupId === selectedGroupId)?.name ?? null}
              busy={tools.busy}
              message={tools.erase.message}
              serverError={tools.serverError}
              onCancelCalculation={tools.cancelCalculation}
            />
          )}

          {activeTool === "path" && <PathPanel panel={pathTool.panel} onExit={() => handleSelectTool("select")} />}

          <EditorLayersPanel
            layers={documentLayers}
            visibility={visibility}
            onToggleVisibility={handleToggleVisibility}
            onToggleLocked={handleToggleLocked}
            onReorder={handleReorderLayers}
            selectedGroupId={selectedGroupId}
            onSelectGroup={handleSelectGroup}
            onRename={handleRenameLayer}
            operations={manufacturingOperations}
            onChangeOperation={handleChangeOperation}
            mutatingGroupId={manufacturingMutatingGroupId}
          />

          <InspectorPanel
            layers={documentLayers}
            selectedLayer={selectedLayer}
            isVisible={isSelectedVisible}
            onIsolate={() => {
              if (selectedGroupId) isolate(selectedGroupId);
            }}
            onShowAll={showAll}
            onRefresh={reload}
            onSelectAllInLayer={() => {
              if (selectedGroupId) handleSelectAllInLayer(selectedGroupId);
            }}
            selectedPathCount={selectedPathKeys.size}
            onToggleLocked={() => {
              if (selectedGroupId) handleToggleLocked(selectedGroupId);
            }}
            laserWarnings={laserWarnings}
            onRename={handleRenameLayer}
            operations={manufacturingOperations}
            onChangeOperation={handleChangeOperation}
            mutatingGroupId={manufacturingMutatingGroupId}
            objectSection={
              selectedObjects.length > 0 && activeTool !== "crop" ? (
                <ObjectInspector
                  objects={selectedObjects}
                  layers={documentLayers}
                  mmPerUnit={mmFactor}
                  onApplyBounds={commitObjectBounds}
                  onRotateTo={commitObjectRotation}
                />
              ) : undefined
            }
          />
        </aside>
      </div>

      <footer className="editor-shell__bottombar">
        <EditorStatusBar
          scale={transform.scale}
          onZoomBy={zoomBy}
          onFit={handleFit}
          sourceWidthPx={frame.width}
          sourceHeightPx={frame.height}
          widthMm={frameSize?.widthMm ?? null}
          heightMm={frameSize?.heightMm ?? null}
        />
        <PaletteBar
          layers={documentLayers}
          selectedGroupId={selectedGroupId}
          onSelectGroup={handleSelectGroup}
          activeColorGroupId={activeTarget && documentLayers.some((layer) => layer.groupId === activeTarget.groupId) ? activeTarget.groupId : null}
        />
      </footer>
    </div>
  );
}
