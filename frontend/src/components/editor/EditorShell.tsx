import { useEffect, useState } from "react";
import { useCanvasTransform } from "../../hooks/useCanvasTransform";
import { useLaserWarnings } from "../../hooks/useLaserWarnings";
import { useManufacturingOperations } from "../../hooks/useManufacturingOperations";
import { useVectorDocument } from "../../hooks/useVectorDocument";
import { useWorkspaceSave } from "../../hooks/useWorkspaceSave";
import { EditorHeader } from "./EditorHeader";
import { EditorLayersPanel } from "./EditorLayersPanel";
import { EditorStatusBar } from "./EditorStatusBar";
import { EditorToolbar, type EditorTool } from "./EditorToolbar";
import { InspectorPanel } from "./InspectorPanel";
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
  /** Notifica al padre (App.tsx) cuando el primer Save resuelve un Project.Id v2 nuevo, para agregarlo a la URL sin recargar la página (ver workspaceLocation.ts). */
  onSaved?: (savedProjectId: string) => void;
  onClose: () => void;
}

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
  onSaved,
  onClose,
}: EditorShellProps) {
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
  } = useVectorDocument(projectId, imageId, paletteId, savedProjectId);
  const laserWarnings = useLaserWarnings(projectId, imageId);

  // Guardado real del VectorDocument (M2.2-S05) -- ver useWorkspaceSave para la máquina de
  // estados completa (idle/dirty/saving/saved/error).
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
  } = useManufacturingOperations(projectId, imageId, paletteId, document?.layerSetId ?? null, savedProjectId);

  const { transform, zoomBy, panBy, fitToScreen } = useCanvasTransform();
  const [activeTool, setActiveTool] = useState<EditorTool>("select");
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });

  const selectedLayer = document?.layers.find((layer) => layer.groupId === selectedGroupId) ?? null;
  const isSelectedVisible = selectedGroupId ? (visibility[selectedGroupId] ?? true) : false;

  const handleFit = () => {
    if (!document) return;
    fitToScreen(canvasSize, { width: document.sourceWidthPx, height: document.sourceHeightPx });
  };

  // Cualquier mutación del VectorDocument marca "dirty" (M2.2-S05, idle/dirty ->
  // useWorkspaceSave): el Save sigue siendo una acción explícita del botón Guardar, esto solo
  // refleja que hay cambios sin guardar desde el último Save exitoso.
  const { markDirty } = workspaceSave;
  const handleToggleVisibility = (groupId: string) => {
    markDirty();
    toggleVisibility(groupId);
  };
  const handleToggleLocked = (groupId: string) => {
    markDirty();
    toggleLocked(groupId);
  };
  const handleRenameLayer = (groupId: string, name: string) => {
    markDirty();
    renameLayer(groupId, name);
  };
  const handleReorderLayers = (orderedGroupIds: string[]) => {
    markDirty();
    reorderLayers(orderedGroupIds);
  };
  const handleChangeOperation: typeof assignManufacturingOperation = (groupId, operation) => {
    markDirty();
    assignManufacturingOperation(groupId, operation);
  };

  return (
    <div className="editor-shell">
      <EditorHeader
        projectName={projectName}
        onClose={onClose}
        saveState={workspaceSave.state}
        saveErrorMessage={workspaceSave.errorMessage}
        canSave={status === "ready" && Boolean(document)}
        onSave={workspaceSave.save}
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
              onSelectGroup={selectGroup}
              selectedPathKeys={selectedPathKeys}
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
          />

          <EditorLayersPanel
            layers={document?.layers ?? []}
            visibility={visibility}
            onToggleVisibility={handleToggleVisibility}
            onToggleLocked={handleToggleLocked}
            onReorder={handleReorderLayers}
            selectedGroupId={selectedGroupId}
            onSelectGroup={selectGroup}
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
              if (selectedGroupId) selectAllInLayer(selectedGroupId);
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
        <PaletteBar layers={document?.layers ?? []} selectedGroupId={selectedGroupId} onSelectGroup={selectGroup} />
      </footer>
    </div>
  );
}
