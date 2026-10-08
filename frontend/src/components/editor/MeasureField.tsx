import { useId, useState } from "react";
import { formatDisplayNumber, parseNumericInput } from "../../lib/editor/units";

interface MeasureFieldProps {
  label: string;
  /** Valor vigente en la unidad del panel (mm o u). */
  value: number;
  unitLabel: "mm" | "u";
  /** Máximo aceptado (inclusive); el mínimo es siempre > 0. */
  max: number;
  /** Confirma un valor válido (Enter/blur). */
  onCommit: (value: number) => void;
  disabled?: boolean;
  hint?: string;
}

/**
 * Campo numérico de los paneles de Draw/Erase (ancho de línea, simplificación, radio del pincel): se edita en mm (o unidades si el documento
 * no tiene escala física), se confirma con Enter/blur y un valor inválido (texto, ≤ 0, fuera de rango) se RECHAZA con mensaje y conserva el
 * anterior. Escape descarta el borrador del campo.
 */
export function MeasureField({ label, value, unitLabel, max, onCommit, disabled = false, hint }: MeasureFieldProps) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const commit = () => {
    if (draft === null) return;
    const text = draft;
    setDraft(null);
    const parsed = parseNumericInput(text);
    if (parsed === null) {
      setError(`"${text.trim() || "(vacío)"}" no es un número válido para «${label}». Se mantiene ${formatDisplayNumber(value)} ${unitLabel}.`);
      return;
    }
    if (parsed <= 0 || parsed > max) {
      setError(`«${label}» debe estar entre 0 (sin incluir) y ${max.toLocaleString("es-AR")} ${unitLabel}. Se mantiene ${formatDisplayNumber(value)} ${unitLabel}.`);
      return;
    }
    setError(null);
    if (parsed !== value) onCommit(parsed);
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
