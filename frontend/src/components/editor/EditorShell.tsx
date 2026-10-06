import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCanvasTransform } from "../../hooks/useCanvasTransform";
import { useEditableDocument, type ApplyEditResult } from "../../hooks/useEditableDocument";
import { useLaserWarnings } from "../../hooks/useLaserWarnings";
import { useManufacturingOperations } from "../../hooks/useManufacturingOperations";
import { useVectorDocument, type VectorDocumentLayer } from "../../hooks/useVectorDocument";
import { useWorkspaceSave } from "../../hooks/useWorkspaceSave";
import { matrixRotationDegrees } from "../../lib/editor/matrix";
import { serializeEditableLayer } from "../../lib/editor/objects";
import { replaceObjects, resolveSelection, selectableObjects as selectableObjectsOf } from "../../lib/editor/selection";
import { groupBounds, groupCenter, rotateAbout, setBounds } from "../../lib/editor/transform";
import type { Rect } from "../../lib/editor/types";
import { mmPerUnit as mmPerUnitOf } from "../../lib/editor/units";
import { svgToDataUrl } from "../../lib/svgToDataUrl";
import { EditorHeader } from "./EditorHeader";
import { EditorLayersPanel } from "./EditorLayersPanel";
import { EditorStatusBar } from "./EditorStatusBar";
import { EditorToolbar, type EditorTool } from "./EditorToolbar";
import { InspectorPanel } from "./InspectorPanel";
import { ObjectInspector } from "./ObjectInspector";
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
}

const EMPTY_LAYERS: VectorDocumentLayer[] = [];
const EMPTY_ID_SET: ReadonlySet<string> = new Set();

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
    visibility,
    toggleVisibility,
    isolate,
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
  const documentLayers = document?.layers ?? EMPTY_LAYERS;
  const editable = useEditableDocument(documentLayers, { visibility });
  const { undo, redo, applyEdit, geometryDirty } = editable;

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
  const { committedObjectsByLayer, editedLayerIds } = editable;
  const sourceWidthPx = document?.sourceWidthPx ?? 0;
  const sourceHeightPx = document?.sourceHeightPx ?? 0;
  const previewImageOverrides = useMemo(() => {
    const overrides: Record<string, string> = {};
    for (const groupId of editedLayerIds) {
      overrides[groupId] = svgToDataUrl(serializeEditableLayer(committedObjectsByLayer[groupId] ?? [], { width: sourceWidthPx, height: sourceHeightPx }));
    }
    return overrides;
  }, [editedLayerIds, committedObjectsByLayer, sourceWidthPx, sourceHeightPx]);

  // mm por unidad de documento: el tamaño físico del documento guardado manda; si no, el de las dimensiones del flujo clásico.
  const mmFactor = mmPerUnitOf(document?.widthMm ?? dimensionWidthMm, document?.sourceWidthPx);

  const handleSelectObjects = useCallback(
    (ids: string[], activeLayerId: string | null) => {
      setRawSelectedObjectIds(new Set(ids));
      // Seleccionar un objeto activa su capa (Inspector de capa, paleta, panel de capas).
      if (activeLayerId) selectGroup(activeLayerId);
    },
    [selectGroup],
  );

  // Seleccionar una capa desde un panel conserva el comportamiento de M2.1; los objetos seleccionados de OTRAS capas se descartan.
  const handleSelectGroup = useCallback(
    (groupId: string | null) => {
      selectGroup(groupId);
      setRawSelectedObjectIds((current) => {
        if (current.size === 0) return current;
        const keep = groupId !== null && selectedObjects.every((object) => object.layerGroupId === groupId);
        return keep ? current : EMPTY_ID_SET;
      });
    },
    [selectGroup, selectedObjects],
  );

  const handleSelectAllInLayer = (groupId: string) => {
    selectAllInLayer(groupId);
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
        undo();
      } else if ((key === "z" && event.shiftKey) || key === "y") {
        event.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [undo, redo]);

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

  const objectEditMessage = (result: ApplyEditResult): string | null =>
    result.reason === "blocked" ? "La capa está bloqueada: no se puede modificar. Desbloqueala en el panel de Capas." : null;

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
  const [activeTool, setActiveTool] = useState<EditorTool>("select");
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });

  const selectedLayer = document?.layers.find((layer) => layer.groupId === selectedGroupId) ?? null;
  const isSelectedVisible = selectedGroupId ? (visibility[selectedGroupId] ?? true) : false;

  const handleFit = () => {
    if (!document) return;
    fitToScreen(canvasSize, { width: document.sourceWidthPx, height: document.sourceHeightPx });
  };

  // Cualquier mutación del VectorDocument marca "dirty" EN STAGING (M2.2-S05, idle/dirty ->
  // useWorkspaceSave; M2.2-S07: ese "dirty" ahora arranca el debounce que dispara el primer Save
  // automáticamente). Una vez que hay `savedProjectId` (sesión ya guardada), el PATCH de cada
  // mutación YA ES el autosave real (ver `trackPatch`, conectado dentro de
  // useVectorDocument/useManufacturingOperations) -- llamar `markDirty()` acá dejaría un "dirty"
  // mentiroso, inmediatamente pisado por el resultado del PATCH (spec.md M2.2-S07, "Estado
  // Dirty/Saving/Saved/Error").
  const { markDirty } = workspaceSave;
  const handleToggleVisibility = (groupId: string) => {
    if (!savedProjectId) markDirty();
    toggleVisibility(groupId);
  };
  const handleToggleLocked = (groupId: string) => {
    if (!savedProjectId) markDirty();
    toggleLocked(groupId);
  };
  const handleRenameLayer = (groupId: string, name: string) => {
    if (!savedProjectId) markDirty();
    renameLayer(groupId, name);
  };
  const handleReorderLayers = (orderedGroupIds: string[]) => {
    if (!savedProjectId) markDirty();
    reorderLayers(orderedGroupIds);
  };
  const handleChangeOperation: typeof assignManufacturingOperation = (groupId, operation) => {
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
        // TODO(M3-S13): persistir la geometría (serializeEditableLayer -> DocumentVersion nueva) y limpiar `geometryDirty`
        // al confirmar el guardado. Hasta entonces el indicador debe seguir diciendo "Cambios de geometría sin guardar".
        geometryDirty={geometryDirty}
        canUndo={editable.canUndo}
        canRedo={editable.canRedo}
        undoLabel={editable.undoLabel}
        redoLabel={editable.redoLabel}
        onUndo={undo}
        onRedo={redo}
      />

      <div className="editor-shell__body">
        <EditorToolbar activeTool={activeTool} onSelectTool={setActiveTool} />

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
            <VectorCanvas
              layers={document.layers}
              visibility={visibility}
              sourceWidthPx={document.sourceWidthPx}
              sourceHeightPx={document.sourceHeightPx}
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
            />
          ) : null}
        </main>

        <aside className="editor-shell__right-rail" aria-label="Paneles del documento">
          <PreviewNavigator
            layers={document?.layers ?? []}
            visibility={visibility}
            sourceWidthPx={document?.sourceWidthPx ?? 0}
            sourceHeightPx={document?.sourceHeightPx ?? 0}
            transform={transform}
            viewportSize={canvasSize}
            layerImageOverrides={previewImageOverrides}
          />

          <EditorLayersPanel
            layers={document?.layers ?? []}
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
            layers={document?.layers ?? []}
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
              selectedObjects.length > 0 ? (
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
          sourceWidthPx={document?.sourceWidthPx ?? 0}
          sourceHeightPx={document?.sourceHeightPx ?? 0}
        />
        <PaletteBar layers={document?.layers ?? []} selectedGroupId={selectedGroupId} onSelectGroup={handleSelectGroup} />
      </footer>
    </div>
  );
}
