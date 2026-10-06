import { useId, useState } from "react";
import { framesEqual, type CropSummary } from "../../lib/editor/frame";
import { proportionalBounds } from "../../lib/editor/transform";
import type { DocumentFrame } from "../../lib/editor/types";
import { formatDisplayNumber, fromMm, parseNumericInput, toMm } from "../../lib/editor/units";

export type CropPreset = "1:1" | "4:3" | "16:9" | "content" | "reset";

type FieldName = "x" | "y" | "width" | "height";

/** Tope de sanidad de un valor tecleado (mm o unidades), igual que el Inspector de objetos. */
const MAX_ABS_VALUE = 1_000_000;

interface CropPanelProps {
  /** Área de trabajo vigente (antes de aplicar). */
  frame: DocumentFrame;
  /** Marco propuesto (lo que se ve sobre el canvas). */
  draft: DocumentFrame;
  /** mm por unidad de documento, o null si el documento no tiene dimensiones físicas: entonces se edita en unidades (u). */
  mmPerUnit: number | null;
  keepRatio: boolean;
  onKeepRatioChange: (keep: boolean) => void;
  removeOutside: boolean;
  onRemoveOutsideChange: (remove: boolean) => void;
  summary: CropSummary;
  /** Rechazo del marco propuesto o de Apply (inválido, sin contenido, capas bloqueadas...). Visible, nunca silencioso. */
  error: string | null;
  /** Propone un marco nuevo; devuelve el mensaje de error si no es válido (y entonces no cambia nada). */
  onDraftChange: (next: DocumentFrame) => string | null;
  /** Presets; devuelve el mensaje de error si no se pudo (p. ej. "Ajustar al contenido" sin contenido). */
  onPreset: (preset: CropPreset) => string | null;
  onApply: () => void;
  onCancel: () => void;
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

const PRESETS: Array<{ preset: CropPreset; label: string; title: string }> = [
  { preset: "1:1", label: "1:1", title: "El cuadrado más grande que cabe centrado en el área de trabajo" },
  { preset: "4:3", label: "4:3", title: "El rectángulo 4:3 más grande que cabe centrado en el área de trabajo" },
  { preset: "16:9", label: "16:9", title: "El rectángulo 16:9 más grande que cabe centrado en el área de trabajo" },
  { preset: "content", label: "Ajustar al contenido", title: "Ajusta el marco al contenido visible" },
  { preset: "reset", label: "Restablecer", title: "Vuelve el marco al área de trabajo actual" },
];

/**
 * Panel contextual de la herramienta Crop (M3-S02). Decisión de dominio (la tarjeta pide NO mezclar comportamientos):
 * Crop recorta el ÁREA DE TRABAJO del documento vectorial -- no el raster fuente ni los assets originales, que nunca se
 * tocan -- y conserva la escala física. Los objetos que cruzan el borde se conservan completos (el recorte exacto de
 * paths es la booleana Intersect de M3-S08); nada se recorta "en silencio".
 *
 * Muestra X/Y/ancho/alto en mm (o unidades, si el documento no tiene escala física) con bloqueo de proporción, presets y un
 * resumen en vivo "Qué se va a modificar". Edición numérica con Enter/blur sobre el marco PROPUESTO (nada se aplica hasta
 * Apply); un valor inválido se rechaza con mensaje y no cambia nada. Apply = Enter, Cancel = Escape (los maneja el shell).
 */
export function CropPanel({
  frame,
  draft,
  mmPerUnit,
  keepRatio,
  onKeepRatioChange,
  removeOutside,
  onRemoveOutsideChange,
  summary,
  error,
  onDraftChange,
  onPreset,
  onApply,
  onCancel,
}: CropPanelProps) {
  const idPrefix = useId();
  const [drafts, setDrafts] = useState<Partial<Record<FieldName, string>>>({});
  const [localError, setLocalError] = useState<string | null>(null);

  const unitLabel = mmPerUnit === null ? "u" : "mm";
  const toDisplay = (units: number) => (mmPerUnit === null ? units : toMm(units, mmPerUnit));
  const fromDisplay = (value: number) => (mmPerUnit === null ? value : fromMm(value, mmPerUnit));
  const formatSize = (rect: DocumentFrame) => `${formatDisplayNumber(toDisplay(rect.width))} × ${formatDisplayNumber(toDisplay(rect.height))} ${unitLabel}`;

  const FIELD_LABELS: Record<FieldName, string> = {
    x: `X del recorte (${unitLabel})`,
    y: `Y del recorte (${unitLabel})`,
    width: `Ancho del recorte (${unitLabel})`,
    height: `Alto del recorte (${unitLabel})`,
  };

  const shownValue = (field: FieldName): string => drafts[field] ?? formatDisplayNumber(toDisplay(draft[field]));

  const clearDraft = (field: FieldName) =>
    setDrafts((current) => {
      const next = { ...current };
      delete next[field];
      return next;
    });

  const commit = (field: FieldName) => {
    const text = drafts[field];
    if (text === undefined) return;
    clearDraft(field);

    const value = parseNumericInput(text);
    if (value === null) {
      setLocalError(`"${text.trim() || "(vacío)"}" no es un número válido para ${FIELD_LABELS[field]}. No se aplicó ningún cambio.`);
      return;
    }
    if (Math.abs(value) > MAX_ABS_VALUE) {
      setLocalError(`El valor de ${FIELD_LABELS[field]} está fuera de rango (máximo ±${MAX_ABS_VALUE.toLocaleString("es-AR")}). No se aplicó ningún cambio.`);
      return;
    }
    if ((field === "width" || field === "height") && value <= 0) {
      setLocalError(`${field === "width" ? "El ancho" : "El alto"} del recorte debe ser mayor que 0. No se aplicó ningún cambio.`);
      return;
    }
    if (formatDisplayNumber(value) === formatDisplayNumber(toDisplay(draft[field]))) {
      setLocalError(null);
      return;
    }

    const units = fromDisplay(value);
    let target: DocumentFrame | null = { ...draft, [field]: units };
    if (keepRatio && (field === "width" || field === "height")) {
      target = proportionalBounds(draft, field, units);
      if (!target) {
        setLocalError("No se puede mantener la proporción: el marco tiene ancho o alto 0.");
        return;
      }
    }
    setLocalError(onDraftChange(target));
  };

  const handlePreset = (preset: CropPreset) => setLocalError(onPreset(preset));
  const handleApply = () => {
    setLocalError(null);
    onApply();
  };

  const unchanged = framesEqual(draft, frame) && summary.removable === 0;
  const shownError = localError ?? error;

  const renderField = (field: FieldName) => {
    const id = `${idPrefix}-${field}`;
    return (
      <div className="object-inspector__field" key={field}>
        <label htmlFor={id}>{FIELD_LABELS[field]}</label>
        <input
          id={id}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={shownValue(field)}
          aria-invalid={shownError !== null && drafts[field] !== undefined ? true : undefined}
          onChange={(event) => setDrafts((current) => ({ ...current, [field]: event.target.value }))}
          onBlur={() => commit(field)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              // Enter dentro de un campo confirma el CAMPO (no aplica el recorte): evita aplicar con un borrador a medias.
              event.preventDefault();
              event.stopPropagation();
              commit(field);
            } else if (event.key === "Escape" && drafts[field] !== undefined) {
              // Primer Escape: descarta el borrador del campo; el siguiente (sin borrador) cancela el recorte (lo maneja el shell).
              event.stopPropagation();
              clearDraft(field);
            }
          }}
        />
      </div>
    );
  };

  return (
    <section aria-labelledby={`${idPrefix}-heading`} className="crop-panel">
      <h3 id={`${idPrefix}-heading`} className="editor-panel__heading">
        Crop — área de trabajo
      </h3>

      <p className="crop-panel__domain" role="note">
        Recorta el área de trabajo del documento. La imagen original y los archivos de origen no se modifican y la escala física se conserva.
      </p>

      <div className="object-inspector__grid" role="group" aria-label="Posición y tamaño del recorte">
        {renderField("x")}
        {renderField("y")}
        {renderField("width")}
        {renderField("height")}
      </div>

      <label className="object-inspector__ratio">
        <input type="checkbox" checked={keepRatio} onChange={(event) => onKeepRatioChange(event.target.checked)} /> Bloquear proporción
      </label>

      <div className="crop-panel__presets" role="group" aria-label="Presets de recorte">
        {PRESETS.map(({ preset, label, title }) => (
          <button key={preset} type="button" className="crop-panel__preset" title={title} onClick={() => handlePreset(preset)}>
            {label}
          </button>
        ))}
      </div>

      <label className="object-inspector__ratio">
        <input type="checkbox" checked={removeOutside} onChange={(event) => onRemoveOutsideChange(event.target.checked)} /> Eliminar objetos fuera del área
      </label>

      <section aria-labelledby={`${idPrefix}-summary`} className="crop-panel__summary" aria-live="polite">
        <h4 id={`${idPrefix}-summary`} className="editor-panel__heading">
          Qué se va a modificar
        </h4>
        <ul>
          <li>
            Área de trabajo: {formatSize(frame)} → {formatSize(draft)}
          </li>
          <li>
            {removeOutside
              ? summary.removable > 0
                ? `${plural(summary.removable, "objeto se eliminará", "objetos se eliminarán")}.`
                : "No se eliminará ningún objeto."
              : summary.outside > 0
                ? `No se eliminará ningún objeto (${plural(summary.outside, "queda", "quedan")} fuera del área).`
                : "No se eliminará ningún objeto."}
          </li>
          {summary.crossing > 0 && (
            <li>
              {summary.crossing === 1
                ? "1 objeto cruza el borde; seguirá completo (recorte exacto: operación Intersect, M3-S08)."
                : `${summary.crossing} objetos cruzan el borde; seguirán completos (recorte exacto: operación Intersect, M3-S08).`}
            </li>
          )}
          {removeOutside && summary.lockedOutside > 0 && (
            <li>{plural(summary.lockedOutside, "objeto está en una capa bloqueada y no se elimina", "objetos están en capas bloqueadas y no se eliminan")}.</li>
          )}
          {removeOutside && summary.hiddenOutside > 0 && (
            <li>{plural(summary.hiddenOutside, "objeto está en una capa oculta y no se elimina", "objetos están en capas ocultas y no se eliminan")}.</li>
          )}
        </ul>
      </section>

      {shownError && (
        <p className="upload-panel__error" role="alert">
          {shownError}
        </p>
      )}

      <div className="crop-panel__actions">
        <button type="button" className="crop-panel__apply" onClick={handleApply} disabled={unchanged} title={unchanged ? "No hay cambios para aplicar" : "Aplicar el recorte (Enter)"}>
          Apply
        </button>
        <button type="button" className="crop-panel__cancel" onClick={onCancel} title="Descartar el recorte (Escape)">
          Cancel
        </button>
      </div>
    </section>
  );
}
