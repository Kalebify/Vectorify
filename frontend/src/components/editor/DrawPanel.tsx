import { useId } from "react";
import type { DrawTargetStatus } from "../../hooks/useDrawEraseTools";
import type { DrawMode } from "../../lib/editor/draw";
import { MeasureField } from "./MeasureField";

interface DrawPanelProps {
  mode: DrawMode;
  onModeChange: (mode: DrawMode) => void;
  unitLabel: "mm" | "u";
  /** Ancho de las líneas abiertas, en mm (o u). */
  lineWidth: number;
  onLineWidthChange: (value: number) => void;
  /** Tolerancia de simplificación de la mano alzada, en mm (o u). */
  simplify: number;
  onSimplifyChange: (value: number) => void;
  closeFreehand: boolean;
  onCloseFreehandChange: (close: boolean) => void;
  /** Puntos de la polilínea en curso. */
  pointCount: number;
  target: DrawTargetStatus;
  message: string | null;
  serverError: string | null;
  busy: boolean;
  onFinish: (closed: boolean) => void;
  onUndoPoint: () => void;
  onCancel: () => void;
  onCancelCalculation: () => void;
}

const MAX_MEASURE = 1000;

/**
 * Panel contextual de Draw (M3-S04). Draw hace correcciones simples, no ilustración: la POLILÍNEA/pluma (click agrega un punto; Enter o doble
 * click termina abierta; click en el primer punto o «Cerrar» cierra; Retroceso quita el último; Escape cancela) y la MANO ALZADA (arrastre;
 * al soltar se simplifica con Ramer–Douglas–Peucker a una tolerancia en mm). Un trazo cerrado es un RELLENO con el color de la capa; uno
 * abierto es una línea fina (por defecto 0,1 mm) con ese color. Dice siempre en qué capa va a dibujar.
 */
export function DrawPanel({
  mode,
  onModeChange,
  unitLabel,
  lineWidth,
  onLineWidthChange,
  simplify,
  onSimplifyChange,
  closeFreehand,
  onCloseFreehandChange,
  pointCount,
  target,
  message,
  serverError,
  busy,
  onFinish,
  onUndoPoint,
  onCancel,
  onCancelCalculation,
}: DrawPanelProps) {
  const idPrefix = useId();
  const modeName = mode === "polyline" ? "Polilínea" : "Mano alzada";

  return (
    <section aria-labelledby={`${idPrefix}-heading`} className="draw-panel">
      <h3 id={`${idPrefix}-heading`} className="editor-panel__heading">
        Draw — dibujar
      </h3>

      <p className="draw-panel__domain" role="note">
        Para correcciones simples. Un trazo cerrado crea una forma rellena con el color de la capa; uno abierto crea una línea fina con ese color.
      </p>

      <fieldset className="draw-panel__modes">
        <legend>Modo de dibujo</legend>
        <label>
          <input type="radio" name={`${idPrefix}-mode`} checked={mode === "polyline"} onChange={() => onModeChange("polyline")} /> Polilínea
        </label>
        <label>
          <input type="radio" name={`${idPrefix}-mode`} checked={mode === "freehand"} onChange={() => onModeChange("freehand")} /> Mano alzada
        </label>
      </fieldset>
      <p className="draw-panel__active-mode" aria-live="polite">
        Modo activo: <strong>{modeName}</strong>
      </p>

      <div className="object-inspector__grid">
        <MeasureField label="Ancho de línea" value={lineWidth} unitLabel={unitLabel} max={MAX_MEASURE} onCommit={onLineWidthChange} hint="Solo para líneas abiertas." />
        {mode === "freehand" && (
          <MeasureField label="Simplificación" value={simplify} unitLabel={unitLabel} max={MAX_MEASURE} onCommit={onSimplifyChange} hint="Tolerancia Ramer–Douglas–Peucker." />
        )}
      </div>

      {mode === "freehand" && (
        <label className="object-inspector__ratio">
          <input type="checkbox" checked={closeFreehand} onChange={(event) => onCloseFreehandChange(event.target.checked)} /> Cerrar el trazo al soltar
        </label>
      )}

      <p className="draw-panel__target" aria-live="polite">
        {target.kind === "existing" && (
          <>
            Capa de destino: <strong>«{target.layerName}»</strong>
          </>
        )}
        {target.kind === "create" && (
          <>
            No hay capa activa: al dibujar se creará la capa <strong>«Dibujo»</strong> (negro, editable luego con Fill/Color).
          </>
        )}
        {target.kind === "rejected" && <strong>No se puede dibujar en «{target.layerName}».</strong>}
      </p>
      {target.kind === "rejected" && target.message && (
        <p className="upload-panel__error" role="alert">
          {target.message}
        </p>
      )}

      {mode === "polyline" && (
        <div className="draw-panel__draft">
          <p aria-live="polite">{pointCount === 0 ? "Hacé click en el canvas para empezar la polilínea." : `${pointCount} ${pointCount === 1 ? "punto" : "puntos"} colocados.`}</p>
          <div className="draw-panel__actions" role="group" aria-label="Acciones de la polilínea">
            <button type="button" className="crop-panel__preset" disabled={busy || pointCount < 2} title="Terminar la línea abierta (Enter o doble click)" onClick={() => onFinish(false)}>
              Terminar
            </button>
            <button type="button" className="crop-panel__preset" disabled={busy || pointCount < 3} title="Cerrar la forma (click en el primer punto)" onClick={() => onFinish(true)}>
              Cerrar
            </button>
            <button type="button" className="crop-panel__preset" disabled={busy || pointCount === 0} title="Quitar el último punto (Retroceso)" onClick={onUndoPoint}>
              Quitar último punto
            </button>
            <button type="button" className="crop-panel__cancel" disabled={pointCount === 0} title="Descartar la polilínea (Escape)" onClick={onCancel}>
              Cancelar
            </button>
          </div>
        </div>
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
