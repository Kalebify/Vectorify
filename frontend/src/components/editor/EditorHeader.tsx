import type { WorkspaceSaveState } from "../../hooks/useWorkspaceSave";
import type { GeometrySaveState } from "../../hooks/useGeometrySave";

interface EditorHeaderProps {
  projectName: string;
  onClose: () => void;
  /** Estado real de guardado (M2.2-S05) -- ver useWorkspaceSave. */
  saveState: WorkspaceSaveState;
  saveErrorMessage: string | null;
  /** Deshabilita el botón Guardar mientras el documento todavía no terminó de cargar (sin paleta/versión resueltas). */
  canSave: boolean;
  onSave: () => void;
  /** Hay ediciones de GEOMETRÍA sin persistir (M3-S01, ADR D2): el indicador nunca dice "Guardado" mientras sea true. */
  geometryDirty?: boolean;
  /** Estado de guardado de geometría (M3-S13): superpone el indicador cuando hay actividad de geometría. */
  geometrySaveState?: GeometrySaveState;
  /** Mensaje de error del guardado de geometría (M3-S13). */
  geometrySaveErrorMessage?: string | null;
  /** Undo/Redo de geometría (M3-S01): estado habilitado + etiqueta del comando que se deshará/rehará. */
  canUndo?: boolean;
  canRedo?: boolean;
  undoLabel?: string | null;
  redoLabel?: string | null;
  onUndo?: () => void;
  onRedo?: () => void;
  /** Por qué Deshacer / Rehacer están deshabilitados (M3-S12): va al tooltip y al nombre accesible, para no dejar un botón apagado sin explicación. */
  undoDisabledReason?: string | null;
  redoDisabledReason?: string | null;
  /** Panel de Historial (M3-S12): botón de apertura, cuántas acciones hay y si hay un aviso/error pendiente de leer. Sin `onToggleHistory` el botón no se muestra. */
  historyOpen?: boolean;
  historyCount?: number;
  historyAttention?: boolean;
  onToggleHistory?: () => void;
  /** Panel de Historial de versiones (M3-S13). Sin `onToggleVersionHistory` el botón no se muestra. */
  versionHistoryOpen?: boolean;
  onToggleVersionHistory?: () => void;
  /** Panel del Laser Checker (M3-S14). Sin `onToggleLaserCheck` el botón no se muestra. */
  laserCheckOpen?: boolean;
  onToggleLaserCheck?: () => void;
  /** Diálogo de export (M3-S15). Sin `onExport` (documento sin cargar) el botón EXPORT queda deshabilitado. */
  exportOpen?: boolean;
  onExport?: () => void;
}

const DIRTY_STATE_COPY: Record<WorkspaceSaveState, string> = {
  idle: "Sin cambios desde la última apertura",
  dirty: "Cambios sin guardar",
  saving: "Guardando…",
  saved: "Guardado",
  error: "No se pudo guardar",
};

const GEOMETRY_SAVE_COPY: Record<GeometrySaveState, string> = {
  idle: "Sin cambios desde la última apertura",
  saving: "Guardando geometría…",
  saved: "Geometría guardada",
  error: "No se pudo guardar la geometría",
};

/**
 * Honestidad de guardado (M3-S01, ADR D2): cuando hay geometría sin persistir el indicador
 * refleja ese estado (y desde M3-S13, el estado real del guardado de geometría).
 */
const GEOMETRY_DIRTY_COPY = "Cambios de geometría sin guardar";

/**
 * Header del wireframe obligatorio: "VECTORiZE ← Projects Project.svg ✓ ↶
 * ↷ SAVE EXPORT".
 *
 * Guardado real (M2.2-S05): reemplaza el placeholder estático de versiones
 * anteriores ("Sin guardado automático todavía", botón SAVE siempre
 * deshabilitado) por la máquina de estados real `useWorkspaceSave`
 * (idle/dirty/saving/saved/error) -- ver ese hook para el detalle completo.
 * El Save sigue siendo una acción EXPLÍCITA del usuario (sin autosave/
 * debounce, fuera de alcance de esta tarjeta): el botón solo dispara
 * `onSave`, nunca se llama solo.
 *
 * Decisiones documentadas en IMPL.md (spec.md, "Ambigüedades detectadas"):
 * - **Undo/Redo** (M3-S01): ya funcionales sobre la geometría (ver
 *   `useEditableDocument`); deshabilitados cuando no hay nada que deshacer/rehacer.
 * - **Export** (M3-S15): abre el diálogo de export avanzado (SVG/DXF/PNG/layers), que
 *   exporta el documento EN MEMORIA desde el cliente. `ExportPanel` (M1-S10) sigue
 *   siendo el export del pipeline guardado de MVP1 y no se toca. Mientras el documento
 *   no terminó de cargar no hay `onExport` y el botón queda deshabilitado.
 */
export function EditorHeader({
  projectName,
  onClose,
  saveState,
  saveErrorMessage,
  canSave,
  onSave,
  geometryDirty = false,
  geometrySaveState,
  geometrySaveErrorMessage = null,
  canUndo = false,
  canRedo = false,
  undoLabel = null,
  redoLabel = null,
  onUndo,
  onRedo,
  undoDisabledReason = null,
  redoDisabledReason = null,
  historyOpen = false,
  historyCount = 0,
  historyAttention = false,
  onToggleHistory,
  versionHistoryOpen = false,
  onToggleVersionHistory,
  laserCheckOpen = false,
  onToggleLaserCheck,
  exportOpen = false,
  onExport,
}: EditorHeaderProps) {
  const isSaving = saveState === "saving" || geometrySaveState === "saving";

  // Prioridad del indicador: 1) guardado de geometría en curso / con error / confirmado, 2) error del save clásico, 3) geometría sin guardar,
  // 4) estado del save clásico. "Geometría guardada" solo si no quedaron ediciones posteriores al envío: nunca dice "guardado" con geometría pendiente.
  const showGeometrySaveState =
    geometrySaveState === "saving" || geometrySaveState === "error" || (geometrySaveState === "saved" && !geometryDirty);
  const showGeometryDirty = geometryDirty && !showGeometrySaveState && saveState !== "error" && saveState !== "saving";

  let dirtyStateText: string;
  if (showGeometrySaveState && geometrySaveState) {
    if (geometrySaveState === "error" && geometrySaveErrorMessage) {
      dirtyStateText = geometrySaveErrorMessage;
    } else {
      dirtyStateText = GEOMETRY_SAVE_COPY[geometrySaveState];
    }
  } else if (saveState === "error" && saveErrorMessage) {
    dirtyStateText = saveErrorMessage;
  } else if (showGeometryDirty) {
    dirtyStateText = GEOMETRY_DIRTY_COPY;
  } else {
    dirtyStateText = DIRTY_STATE_COPY[saveState];
  }

  const dirtyStateKey = showGeometrySaveState && geometrySaveState
    ? `geometry-${geometrySaveState}`
    : showGeometryDirty
    ? "geometry"
    : saveState;

  return (
    <header className="editor-header">
      <div className="editor-header__brand">
        <span className="editor-header__logo">VECTORiZE</span>
        <button type="button" className="editor-header__back" onClick={onClose} aria-label="Volver a la lista de proyectos">
          ← Projects
        </button>
        <span className="editor-header__project-name">{projectName}</span>
        <span
          className={`editor-header__dirty-state editor-header__dirty-state--${dirtyStateKey}`}
          role="status"
        >
          {dirtyStateText}
        </span>
      </div>

      <div className="editor-header__actions">
        {onToggleLaserCheck && (
          <button
            type="button"
            id="editor-laser-check-toggle"
            className="editor-header__button"
            aria-expanded={laserCheckOpen}
            aria-controls="editor-laser-check-panel"
            onClick={onToggleLaserCheck}
            title="Laser Check: revisar la fabricabilidad del documento (paths abiertos, duplicados, piezas flotantes, detalles pequeños...)"
          >
            Laser Check
          </button>
        )}
        {onToggleVersionHistory && (
          <button
            type="button"
            id="editor-version-history-toggle"
            className="editor-header__button"
            aria-expanded={versionHistoryOpen}
            aria-controls="editor-version-history-panel"
            onClick={onToggleVersionHistory}
            title="Historial de versiones guardadas"
          >
            Versiones
          </button>
        )}
        {onToggleHistory && (
          <button
            type="button"
            id="editor-history-toggle"
            className={`editor-header__button${historyAttention ? " editor-header__button--attention" : ""}`}
            aria-expanded={historyOpen}
            aria-controls="editor-history-panel"
            onClick={onToggleHistory}
            title={`Historial de acciones de esta sesión${historyAttention ? " (hay un aviso)" : ""}`}
          >
            Historial ({historyCount}){historyAttention ? " ⚠" : ""}
          </button>
        )}
        <button
          type="button"
          className="editor-header__button"
          disabled={!canUndo}
          onClick={onUndo}
          aria-label={undoLabel ? `Deshacer: ${undoLabel}` : "Deshacer"}
          aria-describedby={!canUndo && undoDisabledReason ? "editor-undo-reason" : undefined}
          title={canUndo ? (undoLabel ? `Deshacer: ${undoLabel} (Ctrl+Z)` : "Deshacer (Ctrl+Z)") : undoDisabledReason ? `Deshacer no disponible: ${undoDisabledReason}` : "Deshacer (Ctrl+Z)"}
        >
          ↶
        </button>
        {!canUndo && undoDisabledReason && (
          <span id="editor-undo-reason" className="editor-sr-only">
            Deshacer no disponible: {undoDisabledReason}
          </span>
        )}
        <button
          type="button"
          className="editor-header__button"
          disabled={!canRedo}
          onClick={onRedo}
          aria-label={redoLabel ? `Rehacer: ${redoLabel}` : "Rehacer"}
          aria-describedby={!canRedo && redoDisabledReason ? "editor-redo-reason" : undefined}
          title={canRedo ? (redoLabel ? `Rehacer: ${redoLabel} (Ctrl+Shift+Z)` : "Rehacer (Ctrl+Shift+Z)") : redoDisabledReason ? `Rehacer no disponible: ${redoDisabledReason}` : "Rehacer (Ctrl+Shift+Z)"}
        >
          ↷
        </button>
        {!canRedo && redoDisabledReason && (
          <span id="editor-redo-reason" className="editor-sr-only">
            Rehacer no disponible: {redoDisabledReason}
          </span>
        )}
        <button
          type="button"
          className="editor-header__button editor-header__button--primary"
          onClick={onSave}
          disabled={!canSave || isSaving}
          aria-label={
            geometrySaveState === "error" || saveState === "error"
              ? "Reintentar guardar"
              : "Guardar"
          }
          title={
            geometrySaveState === "error" || saveState === "error"
              ? "Reintentar guardar"
              : "Guardar"
          }
        >
          {isSaving
            ? "GUARDANDO…"
            : geometrySaveState === "error" || saveState === "error"
            ? "REINTENTAR"
            : "SAVE"}
        </button>
        <button
          type="button"
          id="editor-export-button"
          className="editor-header__button"
          disabled={!onExport}
          onClick={onExport}
          aria-haspopup="dialog"
          aria-expanded={exportOpen}
          aria-label={onExport ? "Exportar el documento (SVG, DXF, PNG o layers)" : "Exportar el documento (disponible cuando termine de cargar)"}
          title={onExport ? "Exportar el documento: SVG, DXF, PNG o un archivo por layer" : "Exportar — disponible cuando el documento termine de cargar"}
        >
          EXPORT
        </button>
      </div>
    </header>
  );
}
