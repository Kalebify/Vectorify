import { useId } from "react";
import {
  BOOLEAN_OPS,
  BOOLEAN_OP_INFO,
  MAX_BOOLEAN_TOLERANCE_MM,
  MIN_BOOLEAN_TOLERANCE_MM,
  type BooleanOp,
} from "../../lib/editor/boolean";
import { MeasureField } from "./MeasureField";

/** Un operando en la lista del panel: la insignia (A, B, C...) más el nombre legible «capa · objeto n» (no depende del color). */
export interface BooleanPanelOperand {
  id: string;
  letter: string;
  name: string;
  colorHex: string;
}

export interface BooleanPanelTargetOption {
  groupId: string;
  name: string;
  colorHex: string;
  /** Es la capa de alguno de los operandos (se agrupan primero). */
  isOperandLayer: boolean;
}

/** Valor del selector de capa destino que significa «capa nueva con un color nuevo». */
export const NEW_LAYER_VALUE = "__new__";

/** Estado de la previsualización que muestra el panel (ver `useBooleanOperation`). */
export interface BooleanPanelPreview {
  status: "idle" | "waiting" | "calculating" | "ready" | "error";
  /** Texto del estado listo: «Resultado: 2 piezas.», «El resultado está vacío…», etc. */
  readyText: string | null;
  /** El resultado está vacío: no se puede aplicar. */
  empty: boolean;
  errorMessage: string | null;
}

interface BooleanPanelProps {
  op: BooleanOp;
  onOpChange: (op: BooleanOp) => void;
  operands: readonly BooleanPanelOperand[];
  onMoveOperand: (index: number, delta: -1 | 1) => void;
  onReverse: () => void;
  /** Los operandos están en capas distintas: el destino lo elige el usuario (sin valor por defecto). */
  layersDiffer: boolean;
  /** Nombre y color de la capa destino automática (todos los operandos en la misma capa), o la ya resuelta. */
  resolvedTarget: { name: string; colorHex: string; created: boolean } | null;
  targetCandidates: readonly BooleanPanelTargetOption[];
  /** `""` = nada elegido todavía; un `groupId`; o `NEW_LAYER_VALUE`. */
  targetValue: string;
  onTargetChange: (value: string) => void;
  newColorHex: string;
  onNewColorChange: (hex: string) => void;
  /** Por qué el destino no se puede usar (bloqueada, color inválido...), o `null`. */
  targetIssue: string | null;
  keepOriginals: boolean;
  onKeepOriginalsChange: (value: boolean) => void;
  toleranceMm: number;
  unitLabel: "mm" | "u";
  onToleranceChange: (value: number) => void;
  preview: BooleanPanelPreview;
  /** El plan no es válido (operandos rechazados, demasiados vértices...): se muestra y no hay preview. */
  rejection: string | null;
  /** Mensaje del último intento de aplicar que falló (vacío, documento cambió...). */
  message: string | null;
  applying: boolean;
  /** Por qué Apply está deshabilitado, o `null`. */
  applyDisabledReason: string | null;
  onApply: () => void;
  onCancel: () => void;
  onRetry: () => void;
}

/**
 * Panel de una booleana (M3-S08), en el rail derecho mientras hay una operación abierta:
 * - **Operandos con orden explícito**: lista A, B, C... (insignia + «capa · objeto n») con subir/bajar por operando e «Invertir orden»; el orden por defecto es el de pintado.
 * - **Capa destino**: la capa común si todos los operandos comparten una; si no, un selector SIN valor por defecto (Apply queda deshabilitado hasta
 *   elegir) entre las capas de los operandos, otras capas desbloqueadas y visibles, o una capa nueva con un color. El color del resultado es el de esa capa.
 * - «Conservar originales» (desactivado = los operandos se reemplazan por el resultado), tolerancia avanzada en mm.
 * - Estado del cálculo en una región `aria-live`: calculando, listo, vacío, error recuperable (con Reintentar). Apply = Enter, Cancel = Escape.
 */
export function BooleanPanel(props: BooleanPanelProps) {
  const {
    op,
    onOpChange,
    operands,
    onMoveOperand,
    onReverse,
    layersDiffer,
    resolvedTarget,
    targetCandidates,
    targetValue,
    onTargetChange,
    newColorHex,
    onNewColorChange,
    targetIssue,
    keepOriginals,
    onKeepOriginalsChange,
    toleranceMm,
    unitLabel,
    onToleranceChange,
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
  const info = BOOLEAN_OP_INFO[op];
  const operandOptions = targetCandidates.filter((candidate) => candidate.isOperandLayer);
  const otherOptions = targetCandidates.filter((candidate) => !candidate.isOperandLayer);

  return (
    <section aria-labelledby={`${idPrefix}-heading`} className="boolean-panel">
      <h3 id={`${idPrefix}-heading`} className="editor-panel__heading">
        Booleana — {info.label}
      </h3>

      <fieldset className="draw-panel__modes">
        <legend>Operación</legend>
        {BOOLEAN_OPS.map((candidate) => (
          <label key={candidate}>
            <input type="radio" name={`${idPrefix}-op`} checked={op === candidate} onChange={() => onOpChange(candidate)} /> {BOOLEAN_OP_INFO[candidate].label}
          </label>
        ))}
      </fieldset>
      <p className="boolean-panel__formula" role="note">
        {info.formula}
      </p>

      <section aria-labelledby={`${idPrefix}-operands`} className="boolean-panel__operands">
        <h4 id={`${idPrefix}-operands`} className="editor-panel__heading">
          Operandos (A es la base)
        </h4>
        <ol className="boolean-panel__list" aria-label="Operandos en orden">
          {operands.map((operand, index) => (
            <li key={operand.id} className="boolean-panel__operand">
              <span className="boolean-panel__badge" aria-hidden="true">
                {operand.letter}
              </span>
              <span className="boolean-panel__swatch" style={{ background: operand.colorHex }} aria-hidden="true" />
              <span className="boolean-panel__operand-name">
                <span className="boolean-panel__sr-letter">Operando {operand.letter}: </span>
                {operand.name}
              </span>
              <button
                type="button"
                className="boolean-panel__move"
                aria-label={`Subir ${operand.letter} (${operand.name})`}
                title="Subir un lugar en el orden"
                disabled={index === 0}
                onClick={() => onMoveOperand(index, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                className="boolean-panel__move"
                aria-label={`Bajar ${operand.letter} (${operand.name})`}
                title="Bajar un lugar en el orden"
                disabled={index === operands.length - 1}
                onClick={() => onMoveOperand(index, 1)}
              >
                ↓
              </button>
            </li>
          ))}
        </ol>
        <button type="button" className="crop-panel__preset" onClick={onReverse} title="El último pasa a ser A">
          Invertir orden
        </button>
      </section>

      <fieldset className="boolean-panel__target">
        <legend>Capa destino</legend>
        {layersDiffer ? (
          <>
            <label htmlFor={`${idPrefix}-target`}>Los operandos están en capas distintas: elegí dónde va el resultado</label>
            <select id={`${idPrefix}-target`} value={targetValue} onChange={(event) => onTargetChange(event.target.value)}>
              <option value="">Elegí una capa…</option>
              {operandOptions.length > 0 && (
                <optgroup label="Capas de los operandos">
                  {operandOptions.map((option) => (
                    <option key={option.groupId} value={option.groupId}>
                      {option.name} ({option.colorHex})
                    </option>
                  ))}
                </optgroup>
              )}
              {otherOptions.length > 0 && (
                <optgroup label="Otras capas desbloqueadas y visibles">
                  {otherOptions.map((option) => (
                    <option key={option.groupId} value={option.groupId}>
                      {option.name} ({option.colorHex})
                    </option>
                  ))}
                </optgroup>
              )}
              <option value={NEW_LAYER_VALUE}>Capa nueva con un color…</option>
            </select>
            {targetValue === NEW_LAYER_VALUE && (
              <div className="boolean-panel__new-layer">
                <label htmlFor={`${idPrefix}-hex`}>Color de la capa nueva (#RRGGBB)</label>
                <input
                  id={`${idPrefix}-hex`}
                  type="text"
                  inputMode="text"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="#RRGGBB"
                  value={newColorHex}
                  onChange={(event) => onNewColorChange(event.target.value)}
                  aria-invalid={targetIssue !== null ? true : undefined}
                />
              </div>
            )}
            {resolvedTarget && (
              <p className="boolean-panel__resolved">
                El resultado va a «{resolvedTarget.name}»{resolvedTarget.created ? " (capa nueva)" : ""} con el color{" "}
                <span className="boolean-panel__swatch" style={{ background: resolvedTarget.colorHex }} aria-hidden="true" /> {resolvedTarget.colorHex}.
              </p>
            )}
            {!resolvedTarget && targetIssue === null && <p className="boolean-panel__resolved">Todavía no elegiste la capa destino: Apply está deshabilitado.</p>}
          </>
        ) : (
          resolvedTarget && (
            <p className="boolean-panel__resolved">
              Todos los operandos están en «{resolvedTarget.name}»: el resultado va a esa capa, con su color{" "}
              <span className="boolean-panel__swatch" style={{ background: resolvedTarget.colorHex }} aria-hidden="true" /> {resolvedTarget.colorHex}.
            </p>
          )
        )}
        {targetIssue !== null && (layersDiffer ? targetValue !== "" : true) && (
          <p className="upload-panel__error" role="alert">
            {targetIssue}
          </p>
        )}
      </fieldset>

      <label className="object-inspector__ratio">
        <input type="checkbox" checked={keepOriginals} onChange={(event) => onKeepOriginalsChange(event.target.checked)} /> Conservar originales
      </label>
      <p className="boolean-panel__hint">
        {keepOriginals ? "Los resultados se agregan y los operandos quedan." : "Los operandos se reemplazan por el resultado (un solo comando: Deshacer los recupera)."}
      </p>

      <details className="boolean-panel__advanced">
        <summary>Avanzado</summary>
        <MeasureField
          label="Tolerancia"
          value={toleranceMm}
          unitLabel={unitLabel}
          min={MIN_BOOLEAN_TOLERANCE_MM}
          max={MAX_BOOLEAN_TOLERANCE_MM}
          onCommit={onToleranceChange}
          hint="Precisión de aplanado de las curvas y umbral de pieza despreciable. El resultado son polilíneas."
        />
      </details>

      <div className="boolean-panel__state" role="status" aria-live="polite">
        {rejection === null && preview.status === "calculating" && <span>Calculando en el servidor…</span>}
        {rejection === null && preview.status === "waiting" && <span>Esperando para calcular…</span>}
        {rejection === null && preview.status === "ready" && preview.readyText && <span>{preview.readyText}</span>}
        {applying && <span> Aplicando…</span>}
      </div>

      {rejection !== null && (
        <p className="upload-panel__error" role="alert">
          {rejection}
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
          title={applyDisabledReason ?? "Aplicar la operación (Enter)"}
        >
          Apply
        </button>
        <button type="button" className="crop-panel__cancel" onClick={onCancel} title="Descartar la operación sin dejar rastro (Escape)">
          Cancel
        </button>
      </div>
    </section>
  );
}
