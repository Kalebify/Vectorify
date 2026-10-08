import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCanvasTransform } from "../../hooks/useCanvasTransform";
import { useDrawEraseTools } from "../../hooks/useDrawEraseTools";
import { useEditableDocument, type ApplyEditResult, type EditProducer } from "../../hooks/useEditableDocument";
import { useLaserWarnings } from "../../hooks/useLaserWarnings";
import { useManufacturingOperations } from "../../hooks/useManufacturingOperations";
import { useVectorDocument, type VectorDocumentLayer } from "../../hooks/useVectorDocument";
import { useWorkspaceSave } from "../../hooks/useWorkspaceSave";
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
import type { DocumentFrame, Point, Rect } from "../../lib/editor/types";
import { formatDisplayNumber, mmPerUnit as mmPerUnitOf, toMm } from "../../lib/editor/units";
import { svgToDataUrl } from "../../lib/svgToDataUrl";
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

  // Tras un cambio de marco (crop, rotar el documento, o su undo/redo) el documento se vuelve a ajustar y centrar (M3-S02).
  const refitTo = useCallback((target: DocumentFrame) => fitToScreen(canvasSize, { width: target.width, height: target.height }), [fitToScreen, canvasSize]);
  const undoWithView = useCallback(() => {
    const edit = undo();
    if (edit) disarmColorPreview();
    if (edit?.frame) refitTo(edit.frame.before);
  }, [undo, refitTo, disarmColorPreview]);
  const redoWithView = useCallback(() => {
    const edit = redo();
    if (edit) disarmColorPreview();
    if (edit?.frame) refitTo(edit.frame.after);
  }, [redo, refitTo, disarmColorPreview]);

  // Selección por ids de objeto. Se guarda cruda y se DEPURA contra los objetos seleccionables vigentes (capas
  // visibles que aún existen): ocultar una capa o borrar un objeto la actualiza sin código extra, y un undo del
  // borrado vuelve a seleccionar lo restaurado.
  const [rawSelectedObjectIds, setRawSelectedObjectIds] = useState<ReadonlySet<string>>(EMPTY_ID_SET);
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
    if (!document || cropDraft !== null) return;
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
    // Cambiar de herramienta con Fill/Color a medias cancela la previsualización sin dejar rastro (nada entró a la pila de undo).
    if (colorSession) endColorSession();
    setColorMessage(null);
    setActionNotice(null);
    setOrientationMessage(null);
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
                editingSuspended={pending !== null}
                cropFrame={cropDraft}
                cropKeepRatio={cropKeepRatio}
                onCropFrameChange={proposeCropFrame}
                onOrientationShortcut={handleOrientationStep}
                onPickColor={handlePickColor}
                onFillObject={handleFillObject}
                onToolShortcut={handleSelectTool}
                toolSurface={drawEraseSurface}
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
