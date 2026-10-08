import { useId } from "react";
import type { EraseMode, EraseScope } from "../../lib/editor/erase";
import { MeasureField } from "./MeasureField";

interface ErasePanelProps {
  mode: EraseMode;
  onModeChange: (mode: EraseMode) => void;
  unitLabel: "mm" | "u";
  /** Radio del pincel en mm (o u). */
  radius: number;
  onRadiusChange: (value: number) => void;
  scope: EraseScope;
  onScopeChange: (scope: EraseScope) => void;
  /** Nombre de la capa activa (alcance «solo capa activa»), o null si no hay. */
  activeLayerName: string | null;
  busy: boolean;
  message: string | null;
  serverError: string | null;
  onCancelCalculation: () => void;
}

const MAX_RADIUS = 5000;

/**
 * Panel contextual de Erase (M3-S04). Los dos modos son EXPLÍCITOS y el activo siempre se indica -- Erase nunca "pinta de blanco":
 * - **Objeto**: elimina los objetos bajo el cursor (un comando por gesto).
 * - **Restar geometría**: un pincel circular (radio en mm, mostrado a su tamaño real sobre el canvas) resta geometría REAL calculada en el
 *   servidor; un objeto puede quedar intacto, reducido, partido en varias piezas o eliminado. Alcance: solo la capa activa o todas las
 *   capas desbloqueadas. Si el servidor falla, no se modifica nada y se puede reintentar.
 */
export function ErasePanel({ mode, onModeChange, unitLabel, radius, onRadiusChange, scope, onScopeChange, activeLayerName, busy, message, serverError, onCancelCalculation }: ErasePanelProps) {
  const idPrefix = useId();
  const modeName = mode === "object" ? "Objeto" : "Restar geometría";

  return (
    <section aria-labelledby={`${idPrefix}-heading`} className="erase-panel">
      <h3 id={`${idPrefix}-heading`} className="editor-panel__heading">
        Erase — borrar
      </h3>

      <fieldset className="draw-panel__modes">
        <legend>Modo de borrado</legend>
        <label>
          <input type="radio" name={`${idPrefix}-mode`} checked={mode === "object"} onChange={() => onModeChange("object")} /> Objeto
        </label>
        <label>
          <input type="radio" name={`${idPrefix}-mode`} checked={mode === "geometry"} onChange={() => onModeChange("geometry")} /> Restar geometría
        </label>
      </fieldset>
      <p className="draw-panel__active-mode" aria-live="polite">
        Modo activo: <strong>{modeName}</strong>
      </p>
      <p className="draw-panel__domain" role="note">
        {mode === "object"
          ? "Click o arrastre: elimina los objetos bajo el cursor (capas visibles y no bloqueadas). Un solo comando por gesto."
          : "Arrastrá el pincel: se resta geometría real a los objetos que toca (pueden quedar intactos, reducidos, partidos o eliminados)."}
      </p>

      {mode === "geometry" && (
        <>
          <MeasureField label="Radio del pincel" value={radius} unitLabel={unitLabel} max={MAX_RADIUS} onCommit={onRadiusChange} hint="El cursor muestra el tamaño real, también al hacer zoom." />

          <fieldset className="draw-panel__modes">
            <legend>Alcance</legend>
            <label>
              <input type="radio" name={`${idPrefix}-scope`} checked={scope === "active-layer"} onChange={() => onScopeChange("active-layer")} /> Solo capa activa
              {activeLayerName ? ` («${activeLayerName}»)` : " (ninguna elegida)"}
            </label>
            <label>
              <input type="radio" name={`${idPrefix}-scope`} checked={scope === "unlocked-layers"} onChange={() => onScopeChange("unlocked-layers")} /> Todas las capas desbloqueadas
            </label>
          </fieldset>
        </>
      )}

      {busy && (
        <div className="draw-panel__busy" role="status">
          <span>Calculando en el servidor…</span>
          <button type="button" className="crop-panel__cancel" onClick={onCancelCalculation} title="Cancelar el cálculo (Escape)">
            Cancelar cálculo
          </button>
        </div>
      )}

      {(message ?? serverError) && (
        <p className="upload-panel__error" role="alert">
          {message ?? serverError}
        </p>
      )}
    </section>
  );
}
