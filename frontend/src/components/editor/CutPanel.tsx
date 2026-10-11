import { useId } from "react";
import { CUT_MODES, CUT_MODE_INFO, MAX_SLOT_WIDTH_MM, MIN_SLOT_WIDTH_MM, type CutWarning } from "../../lib/editor/cut";
import type { SplitMode } from "../../types/geometry";
import { MeasureField } from "./MeasureField";

/** Estado de la previsualización que muestra el panel (ver `useCutOperation`). */
export interface CutPanelPreview {
  status: "idle" | "waiting" | "calculating" | "ready" | "error";
  /** Texto del estado listo: «Se cortarán 2 objetos: …», «Ningún objeto cambia con este corte.», etc. */
  readyText: string | null;
  /** Objetos que el corte toca sin atravesar, omitidos por capa, piezas descartadas...: se muestran ANTES de aplicar. */
  warnings: readonly CutWarning[];
  errorMessage: string | null;
}

interface CutPanelProps {
  mode: SplitMode;
  onModeChange: (mode: SplitMode) => void;
  /** Ancho de la ranura en mm (o u sin escala física). */
  slotWidth: number;
  unitLabel: "mm" | "u";
  onSlotWidthChange: (value: number) => void;
  /** Aviso permanente «sin escala física», o `null`. */
  scaleNotice: string | null;
  extend: boolean;
  onExtendChange: (value: boolean) => void;
  /** A qué objetos se aplica: «Selección: 2 objetos» o «Sin selección: …». */
  scopeText: string;
  /** Puntos de la línea de corte y si está terminada. */
  linePoints: number;
  lineFinished: boolean;
  onFinishLine: () => void;
  onUndoPoint: () => void;
  onClearLine: () => void;
  preview: CutPanelPreview;
  /** La línea o los valores no permiten calcular: se muestra y no hay preview. `info` = todavía no es un error (falta dibujar la línea). */
  rejection: { message: string; info: boolean } | null;
  /** Mensaje del último intento de aplicar que falló. */
  message: string | null;
  applying: boolean;
  /** Por qué Apply está deshabilitado, o `null`. */
  applyDisabledReason: string | null;
  onApply: () => void;
  onCancel: () => void;
  onRetry: () => void;
}

/**
 * Panel de Cut (M3-S10), en el rail derecho mientras la herramienta está activa:
 * - **Modo** explícito (*Dividir* / *Separar con hueco*), con su descripción; el activo se indica siempre. En *Separar con hueco*, el **ancho de la ranura en mm**
 *   (o unidades, con aviso, si el documento no tiene escala física).
 * - **Extender el corte hasta cruzar todo**: sin ella un corte que termina dentro de una forma NO la divide (y el panel lo dice).
 * - La **línea de corte** (puntos, terminada o en curso) con los equivalentes de teclado como botones: terminar (Enter), quitar el último punto (Retroceso), borrarla.
 * - **Alcance**: la selección, o (sin selección) todos los objetos visibles y desbloqueados que la línea cruza, listados antes de aplicar.
 * - Estado del cálculo en una región `aria-live`: calculando, listo («Se cortarán N objetos»), avisos (no atraviesa, omitidos por capa, descartes), error
 *   recuperable (con Reintentar). Si ningún objeto cambia Apply queda deshabilitado con la explicación. Apply = Enter (con la línea terminada), Cancel = Escape.
 */
export function CutPanel(props: CutPanelProps) {
  const {
    mode,
    onModeChange,
    slotWidth,
    unitLabel,
    onSlotWidthChange,
    scaleNotice,
    extend,
    onExtendChange,
    scopeText,
    linePoints,
    lineFinished,
    onFinishLine,
    onUndoPoint,
    onClearLine,
    preview,
    rejection,
    message,
    applying,
    applyDisabledReason,
    onApply,
    onCancel,
    onRetry,
  } = props;
  const idPrefix = useId();
  const showBlock = applyDisabledReason !== null && preview.status === "ready" && rejection === null;

  return (
    <section aria-labelledby={`${idPrefix}-heading`} className="boolean-panel cut-panel">
      <h3 id={`${idPrefix}-heading`} className="editor-panel__heading">
        Cut
      </h3>

      {scaleNotice && (
        <p className="offset-panel__scale" role="note">
          {scaleNotice}
        </p>
      )}

      <fieldset className="draw-panel__modes">
        <legend>Modo del corte</legend>
        {CUT_MODES.map((candidate) => (
          <label key={candidate} title={CUT_MODE_INFO[candidate].description}>
            <input type="radio" name={`${idPrefix}-mode`} checked={mode === candidate} onChange={() => onModeChange(candidate)} /> {CUT_MODE_INFO[candidate].label}
          </label>
        ))}
      </fieldset>
      <p className="boolean-panel__hint">
        <strong>Modo activo: {CUT_MODE_INFO[mode].label}.</strong> {CUT_MODE_INFO[mode].description}
      </p>

      {mode === "slot" && (
        <MeasureField
          label="Ancho de la ranura"
          value={slotWidth}
          unitLabel={unitLabel}
          min={MIN_SLOT_WIDTH_MM}
          max={MAX_SLOT_WIDTH_MM}
          onCommit={onSlotWidthChange}
          hint={`Entre ${MIN_SLOT_WIDTH_MM.toLocaleString("es-AR")} y ${MAX_SLOT_WIDTH_MM.toLocaleString("es-AR")} ${unitLabel}. Se quita ese ancho, centrado en la línea.`}
        />
      )}

      <label className="object-inspector__ratio">
        <input type="checkbox" checked={extend} onChange={(event) => onExtendChange(event.target.checked)} /> Extender el corte hasta cruzar todo
      </label>
      <p className="boolean-panel__hint">
        {extend
          ? "El primer y el último tramo de la línea se prolongan lo necesario para atravesar las formas."
          : "Sin extender, un corte que termina dentro de una forma NO la divide: queda intacta."}
      </p>

      <div className="cut-panel__line" role="group" aria-label="Línea de corte">
        <p className="boolean-panel__hint">
          {linePoints === 0
            ? "Todavía no hay línea de corte."
            : `Línea de corte: ${linePoints} ${linePoints === 1 ? "punto" : "puntos"}${lineFinished ? " (terminada)" : linePoints >= 2 ? " (en curso)" : ""}.`}
        </p>
        <div className="crop-panel__actions">
          <button type="button" className="crop-panel__preset" onClick={onFinishLine} disabled={lineFinished || linePoints < 2} title="Terminar la línea (Enter o doble click)">
            Terminar línea
          </button>
          <button type="button" className="crop-panel__preset" onClick={onUndoPoint} disabled={linePoints === 0} title="Quitar el último punto (Retroceso)">
            Quitar último punto
          </button>
          <button type="button" className="crop-panel__preset" onClick={onClearLine} disabled={linePoints === 0} title="Borrar la línea y empezar de nuevo (Escape)">
            Borrar línea
          </button>
        </div>
      </div>

      <p className="boolean-panel__resolved cut-panel__scope">{scopeText}</p>

      <div className="boolean-panel__state" role="status" aria-live="polite">
        {rejection !== null && rejection.info && <span>{rejection.message}</span>}
        {rejection === null && preview.status === "calculating" && <span>Calculando en el servidor…</span>}
        {rejection === null && preview.status === "waiting" && <span>Esperando para calcular…</span>}
        {rejection === null && preview.status === "ready" && preview.readyText && <span>{preview.readyText}</span>}
        {applying && <span> Aplicando…</span>}
      </div>

      {rejection === null && preview.status === "ready" && preview.warnings.length > 0 && (
        <ul className="offset-panel__warnings" aria-label="Advertencias del corte">
          {preview.warnings.map((warning) => (
            <li key={warning.kind} className={`offset-panel__warning cut-panel__warning--${warning.kind}`}>
              {warning.text}
            </li>
          ))}
        </ul>
      )}

      {rejection !== null && !rejection.info && (
        <p className="upload-panel__error" role="alert">
          {rejection.message}
        </p>
      )}
      {rejection === null && preview.status === "error" && preview.errorMessage && (
        <div className="boolean-panel__error" role="alert">
          <p className="upload-panel__error">{preview.errorMessage}</p>
          <button type="button" className="crop-panel__preset" onClick={onRetry}>
            Reintentar
          </button>
        </div>
      )}
      {showBlock && (
        <p className="upload-panel__error" role="alert">
          {applyDisabledReason}
        </p>
      )}
      {message && (
        <p className="upload-panel__error" role="alert">
          {message}
        </p>
      )}

      <div className="crop-panel__actions">
        <button
          type="button"
          className="crop-panel__apply"
          onClick={onApply}
          disabled={applyDisabledReason !== null || applying}
          title={applyDisabledReason ?? "Aplicar el corte (Enter)"}
        >
          Apply
        </button>
        <button type="button" className="crop-panel__cancel" onClick={onCancel} title="Descartar el corte sin dejar rastro (Escape)">
          Cancel
        </button>
      </div>
    </section>
  );
}
