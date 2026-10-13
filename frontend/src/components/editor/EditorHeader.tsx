import type { WorkspaceSaveState } from "../../hooks/useWorkspaceSave";

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
}

const DIRTY_STATE_COPY: Record<WorkspaceSaveState, string> = {
  idle: "Sin cambios desde la última apertura",
  dirty: "Cambios sin guardar",
  saving: "Guardando…",
  saved: "Guardado",
  error: "No se pudo guardar",
};

/**
 * Honestidad de guardado (M3-S01, ADR D2): hasta M3-S13 las ediciones de geometría viven solo en
 * memoria, así que el indicador NUNCA muestra "Guardado" mientras haya geometría sin persistir --
 * incluso si el último guardado de metadata (nombre/orden/visibilidad/bloqueo) sí se confirmó.
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
 * - **Export**: placeholder deshabilitado. `ExportPanel` (M1-S10) exporta
 *   UN `VectorVersion`/`SimplificationVersion`/`DimensionVersion` del
 *   pipeline de un solo vector de MVP1 -- no existe hoy un endpoint que
 *   exporte el `VectorDocument` multicapa completo como un solo archivo, y
 *   crear uno no fue pedido por esta tarjeta (fuera de alcance: "no
 *   inventes que algo funciona").
 */
export function EditorHeader({
  projectName,
  onClose,
  saveState,
  saveErrorMessage,
  canSave,
  onSave,
  geometryDirty = false,
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
}: EditorHeaderProps) {
  const isSaving = saveState === "saving";
  // Un error de guardado y un guardado en curso siguen siendo lo más urgente de mostrar; en el resto de
  // estados (idle/dirty/saved) la geometría sin persistir manda sobre cualquier "Guardado".
  const showGeometryDirty = geometryDirty && saveState !== "error" && saveState !== "saving";
  const dirtyStateKey = showGeometryDirty ? "geometry" : saveState;

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
          {showGeometryDirty ? GEOMETRY_DIRTY_COPY : saveState === "error" && saveErrorMessage ? saveErrorMessage : DIRTY_STATE_COPY[saveState]}
        </span>
      </div>

      <div className="editor-header__actions">
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
          aria-label={saveState === "error" ? "Reintentar guardar" : "Guardar"}
          title={saveState === "error" ? "Reintentar guardar" : "Guardar"}
        >
          {isSaving ? "GUARDANDO…" : saveState === "error" ? "REINTENTAR" : "SAVE"}
        </button>
        <button
          type="button"
          className="editor-header__button"
          disabled
          aria-label="Exportar el documento completo (próximamente)"
          title="Exportar el documento completo — próximamente"
        >
          EXPORT
        </button>
      </div>
    </header>
  );
}
