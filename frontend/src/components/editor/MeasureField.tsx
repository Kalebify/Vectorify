import { useId, useState } from "react";
import { formatDisplayNumber, parseNumericInput } from "../../lib/editor/units";

interface MeasureFieldProps {
  label: string;
  /** Valor vigente en la unidad del panel (mm o u). */
  value: number;
  /** Unidad que se muestra junto al nombre: «mm» o «u» (o la que corresponda al valor, p. ej. «×» para una razón). */
  unitLabel: string;
  /** Máximo aceptado (inclusive). */
  max: number;
  /** Mínimo aceptado (inclusive, M3-S08: tolerancia de las booleanas). Sin él, cualquier valor > 0. */
  min?: number;
  /** Confirma un valor válido (Enter/blur). */
  onCommit: (value: number) => void;
  disabled?: boolean;
  hint?: string;
  /** Paso de las flechas ↑/↓ (M3-S09): confirma `valor ± paso` (con la misma validación que el texto). Sin él las flechas no hacen nada. */
  step?: number;
}

/**
 * Campo numérico de los paneles de Draw/Erase (ancho de línea, simplificación, radio del pincel): se edita en mm (o unidades si el documento
 * no tiene escala física), se confirma con Enter/blur y un valor inválido (texto, ≤ 0, fuera de rango) se RECHAZA con mensaje y conserva el
 * anterior. Escape descarta el borrador del campo.
 */
export function MeasureField({ label, value, unitLabel, max, min, onCommit, disabled = false, hint, step }: MeasureFieldProps) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Mensaje de error si `parsed` no entra en el rango del campo, o `null`. */
  const rangeError = (parsed: number): string | null => {
    if (parsed <= 0 || parsed > max || (min !== undefined && parsed < min)) {
      const lower = min === undefined ? "0 (sin incluir)" : `${min.toLocaleString("es-AR")} (inclusive)`;
      return `«${label}» debe estar entre ${lower} y ${max.toLocaleString("es-AR")} ${unitLabel}. Se mantiene ${formatDisplayNumber(value)} ${unitLabel}.`;
    }
    return null;
  };

  const confirm = (parsed: number) => {
    const problem = rangeError(parsed);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    if (parsed !== value) onCommit(parsed);
  };

  const commit = () => {
    if (draft === null) return;
    const text = draft;
    setDraft(null);
    const parsed = parseNumericInput(text);
    if (parsed === null) {
      setError(`"${text.trim() || "(vacío)"}" no es un número válido para «${label}». Se mantiene ${formatDisplayNumber(value)} ${unitLabel}.`);
      return;
    }
    confirm(parsed);
  };

  /** Flecha ↑/↓: parte del borrador si es un número válido, si no del valor vigente; redondea para no arrastrar ruido de coma flotante (0,1 + 0,2). */
  const stepBy = (direction: 1 | -1) => {
    if (step === undefined) return;
    const base = (draft !== null ? parseNumericInput(draft) : null) ?? value;
    setDraft(null);
    confirm(Number((base + direction * step).toFixed(6)));
  };

  return (
    <div className="object-inspector__field">
      <label htmlFor={id}>
        {label} ({unitLabel})
      </label>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        disabled={disabled}
        value={draft ?? formatDisplayNumber(value)}
        aria-invalid={error !== null ? true : undefined}
        aria-describedby={error !== null ? `${id}-error` : hint ? `${id}-hint` : undefined}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            commit();
          } else if ((event.key === "ArrowUp" || event.key === "ArrowDown") && step !== undefined) {
            event.preventDefault();
            event.stopPropagation();
            stepBy(event.key === "ArrowUp" ? 1 : -1);
          } else if (event.key === "Escape" && draft !== null) {
            event.stopPropagation();
            setDraft(null);
            setError(null);
          }
        }}
      />
      {hint && error === null && (
        <small id={`${id}-hint`} className="draw-panel__hint">
          {hint}
        </small>
      )}
      {error !== null && (
        <small id={`${id}-error`} className="upload-panel__error" role="alert">
          {error}
        </small>
      )}
    </div>
  );
}
