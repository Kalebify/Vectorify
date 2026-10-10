import { useId } from "react";
import {
  MAX_MITRE_LIMIT,
  MAX_OFFSET_MM,
  MAX_OFFSET_TOLERANCE_MM,
  MIN_MITRE_LIMIT,
  MIN_OFFSET_TOLERANCE_MM,
  OFFSET_CAP_INFO,
  OFFSET_CAP_STYLES,
  OFFSET_DIRECTION_INFO,
  OFFSET_JOIN_INFO,
  OFFSET_JOIN_STYLES,
  OFFSET_PRESETS_MM,
  OFFSET_STEP_MM,
  type OffsetDirection,
  type OffsetWarning,
} from "../../lib/editor/offset";
import type { OffsetCapStyle, OffsetJoinStyle } from "../../types/geometry";
import { NEW_LAYER_VALUE } from "./BooleanPanel";
import { MeasureField } from "./MeasureField";

/** Valor del selector de capa destino que significa «cada resultado a la capa de su objeto de origen» (el modo por defecto, explícito en pantalla). */
export const ORIGIN_LAYER_VALUE = "origin";

export interface OffsetPanelTargetOption {
  groupId: string;
  name: string;
  colorHex: string;
  /** Es la capa de alguno de los objetos de origen (se agrupan primero). */
  isOriginLayer: boolean;
}

/** Estado de la previsualización que muestra el panel (ver `useOffsetOperation`). */
export interface OffsetPanelPreview {
  status: "idle" | "waiting" | "calculating" | "ready" | "error";
  /** Texto del estado listo: «Resultado: 3 piezas a partir de 2 objetos.», «Todos los objetos colapsan…», etc. */
  readyText: string | null;
  /** Colapsos, divisiones, pérdida de piezas y de huecos: se muestran ANTES de confirmar. */
  warnings: readonly OffsetWarning[];
  errorMessage: string | null;
}

/** Casilla de confirmación explícita (algunos objetos colapsan o pierden piezas). */
export interface OffsetPanelConfirmation {
  text: string;
  confirmed: boolean;
  onChange: (confirmed: boolean) => void;
}

interface OffsetPanelProps {
  direction: OffsetDirection;
  onDirectionChange: (direction: OffsetDirection) => void;
  /** Por qué *Interior* no se puede elegir (hay líneas abiertas), o `null`. */
  insideDisabledReason: string | null;
  /** Todos los objetos son líneas abiertas: solo existe «ambos lados». */
  onlyLines: boolean;
  /** Distancia en mm (o u sin escala física). */
  distance: number;
  unitLabel: "mm" | "u";
  onDistanceChange: (value: number) => void;
  /** Aviso permanente «sin escala física», o `null`. */
  scaleNotice: string | null;
  joinStyle: OffsetJoinStyle;
  onJoinStyleChange: (style: OffsetJoinStyle) => void;
  mitreLimit: number;
  onMitreLimitChange: (value: number) => void;
  /** Hay líneas abiertas entre los objetos: los caps tienen efecto. */
  hasLines: boolean;
  capStyle: OffsetCapStyle;
  onCapStyleChange: (style: OffsetCapStyle) => void;
  keepOriginals: boolean;
  onKeepOriginalsChange: (value: boolean) => void;
  /** `ORIGIN_LAYER_VALUE` (cada resultado a la capa de su origen), un `groupId` o `NEW_LAYER_VALUE`. */
  targetValue: string;
  onTargetChange: (value: string) => void;
  targetCandidates: readonly OffsetPanelTargetOption[];
  newColorHex: string;
  onNewColorChange: (hex: string) => void;
  /** Por qué la capa elegida no se puede usar (bloqueada, color inválido...), o `null`. */
  targetIssue: string | null;
  /** Dónde va a caer el resultado, para mostrarlo siempre: capas de origen con su cantidad de objetos, o la destino explícita. */
  destinationText: string | null;
  toleranceMm: number;
  onToleranceChange: (value: number) => void;
  preview: OffsetPanelPreview;
  /** La selección o los valores no permiten calcular: se muestra y no hay preview. `info` = todavía no es un error (nada seleccionado). */
  rejection: { message: string; info: boolean } | null;
  confirmation: OffsetPanelConfirmation | null;
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
 * Panel de Offset (M3-S09), en el rail derecho mientras la herramienta está activa:
 * - **Distancia en mm** (o unidades, con aviso, si el documento no tiene escala física): presets, campo libre validado y flechas ↑/↓.
 * - **Dirección** explícita (Exterior agranda, Interior encoge); con líneas abiertas solo «ambos lados» y Interior se deshabilita con el motivo.
 * - **Esquinas** (redondo, inglete con límite, bisel) y **extremos** de línea (redondo, plano, cuadrado), con una descripción corta de cada uno.
 * - **Capa**: por defecto cada resultado va a la capa de su objeto de origen (se muestra cuál); o una capa destino elegida a propósito.
 * - «Conservar original» (activado por defecto) o reemplazar. Tolerancia avanzada en mm.
 * - Estado del cálculo en una región `aria-live`: calculando, listo, colapsos, divisiones, huecos, error recuperable (con Reintentar). Si algunos objetos
 *   colapsan hay que marcar la casilla de confirmación; si todos colapsan Apply queda deshabilitado con la explicación. Apply = Enter, Cancel = Escape.
 */
export function OffsetPanel(props: OffsetPanelProps) {
  const {
    direction,
    onDirectionChange,
    insideDisabledReason,
    onlyLines,
    distance,
    unitLabel,
    onDistanceChange,
    scaleNotice,
    joinStyle,
    onJoinStyleChange,
    mitreLimit,
    onMitreLimitChange,
    hasLines,
    capStyle,
    onCapStyleChange,
    keepOriginals,
    onKeepOriginalsChange,
    targetValue,
    onTargetChange,
    targetCandidates,
    newColorHex,
    onNewColorChange,
    targetIssue,
    destinationText,
    toleranceMm,
    onToleranceChange,
    preview,
    rejection,
    confirmation,
    message,
    applying,
    applyDisabledReason,
    onApply,
    onCancel,
    onRetry,
  } = props;
  const idPrefix = useId();
  const originOptions = targetCandidates.filter((candidate) => candidate.isOriginLayer);
  const otherOptions = targetCandidates.filter((candidate) => !candidate.isOriginLayer);
  const showBlock = applyDisabledReason !== null && preview.status === "ready" && rejection === null;

  return (
    <section aria-labelledby={`${idPrefix}-heading`} className="boolean-panel offset-panel">
      <h3 id={`${idPrefix}-heading`} className="editor-panel__heading">
        Offset
      </h3>

      {scaleNotice && (
        <p className="offset-panel__scale" role="note">
          {scaleNotice}
        </p>
      )}

      <fieldset className="draw-panel__modes">
        <legend>Dirección</legend>
        <label title={OFFSET_DIRECTION_INFO.outside.description}>
          <input type="radio" name={`${idPrefix}-direction`} checked={direction === "outside"} onChange={() => onDirectionChange("outside")} />{" "}
          {onlyLines ? "Ambos lados" : OFFSET_DIRECTION_INFO.outside.label}
        </label>
        <label title={insideDisabledReason ?? OFFSET_DIRECTION_INFO.inside.description}>
          <input
            type="radio"
            name={`${idPrefix}-direction`}
            checked={direction === "inside"}
            disabled={insideDisabledReason !== null}
            onChange={() => onDirectionChange("inside")}
          />{" "}
          {OFFSET_DIRECTION_INFO.inside.label}
        </label>
      </fieldset>
      <p className="boolean-panel__hint">
        {onlyLines
          ? "El contorno queda alrededor de la línea: ancho total 2 × el offset."
          : direction === "inside"
            ? OFFSET_DIRECTION_INFO.inside.description
            : hasLines
              ? "Las formas se agrandan; las líneas se desplazan a ambos lados."
              : OFFSET_DIRECTION_INFO.outside.description}
      </p>
      {insideDisabledReason !== null && <p className="boolean-panel__hint">Interior deshabilitado: {insideDisabledReason}</p>}

      <div className="offset-panel__presets" role="group" aria-label={`Distancias frecuentes (${unitLabel})`}>
        {OFFSET_PRESETS_MM.map((preset) => (
          <button
            key={preset}
            type="button"
            className="crop-panel__preset"
            aria-pressed={distance === preset}
            aria-label={`${preset.toLocaleString("es-AR")} ${unitLabel}`}
            title={`Offset de ${preset.toLocaleString("es-AR")} ${unitLabel}`}
            onClick={() => onDistanceChange(preset)}
          >
            {preset.toLocaleString("es-AR")}
          </button>
        ))}
      </div>
      <MeasureField
        label="Offset"
        value={distance}
        unitLabel={unitLabel}
        max={MAX_OFFSET_MM}
        step={OFFSET_STEP_MM}
        onCommit={onDistanceChange}
        hint={`Mayor que 0 y hasta ${MAX_OFFSET_MM.toLocaleString("es-AR")} ${unitLabel}. Flechas ↑/↓: ±${OFFSET_STEP_MM.toLocaleString("es-AR")} ${unitLabel}.`}
      />

      <fieldset className="draw-panel__modes">
        <legend>Esquinas</legend>
        {OFFSET_JOIN_STYLES.map((style) => (
          <label key={style} title={OFFSET_JOIN_INFO[style].description}>
            <input type="radio" name={`${idPrefix}-join`} checked={joinStyle === style} onChange={() => onJoinStyleChange(style)} /> {OFFSET_JOIN_INFO[style].label}
          </label>
        ))}
      </fieldset>
      <p className="boolean-panel__hint">{OFFSET_JOIN_INFO[joinStyle].description}</p>
      {joinStyle === "mitre" && (
        <MeasureField
          label="Límite de inglete"
          value={mitreLimit}
          unitLabel="×"
          min={MIN_MITRE_LIMIT}
          max={MAX_MITRE_LIMIT}
          onCommit={onMitreLimitChange}
          hint="Cuántas veces el offset puede alargarse una punta antes de recortarse."
        />
      )}

      {hasLines && (
        <>
          <fieldset className="draw-panel__modes">
            <legend>Extremos de las líneas</legend>
            {OFFSET_CAP_STYLES.map((style) => (
              <label key={style} title={OFFSET_CAP_INFO[style].description}>
                <input type="radio" name={`${idPrefix}-cap`} checked={capStyle === style} onChange={() => onCapStyleChange(style)} /> {OFFSET_CAP_INFO[style].label}
              </label>
            ))}
          </fieldset>
          <p className="boolean-panel__hint">{OFFSET_CAP_INFO[capStyle].description}</p>
        </>
      )}

      <label className="object-inspector__ratio">
        <input type="checkbox" checked={keepOriginals} onChange={(event) => onKeepOriginalsChange(event.target.checked)} /> Conservar original
      </label>
      <p className="boolean-panel__hint">
        {keepOriginals
          ? "El offset se agrega como un contorno nuevo y el original queda."
          : "El original se reemplaza por el offset (un solo comando: Deshacer lo recupera). Lo que colapsa no se toca."}
      </p>

      <fieldset className="boolean-panel__target">
        <legend>Capa del resultado</legend>
        <label htmlFor={`${idPrefix}-target`}>Dónde va el resultado</label>
        <select id={`${idPrefix}-target`} value={targetValue} onChange={(event) => onTargetChange(event.target.value)}>
          <option value={ORIGIN_LAYER_VALUE}>La capa de cada objeto de origen</option>
          {originOptions.length > 0 && (
            <optgroup label="Capas de los objetos">
              {originOptions.map((option) => (
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
        {destinationText && <p className="boolean-panel__resolved">{destinationText}</p>}
        {targetIssue !== null && (
          <p className="upload-panel__error" role="alert">
            {targetIssue}
          </p>
        )}
      </fieldset>

      <details className="boolean-panel__advanced">
        <summary>Avanzado</summary>
        <MeasureField
          label="Tolerancia"
          value={toleranceMm}
          unitLabel={unitLabel}
          min={MIN_OFFSET_TOLERANCE_MM}
          max={MAX_OFFSET_TOLERANCE_MM}
          onCommit={onToleranceChange}
          hint="Precisión de aplanado de las curvas y de los arcos redondos. El resultado son polilíneas (no conserva los Bézier)."
        />
      </details>

      <div className="boolean-panel__state" role="status" aria-live="polite">
        {rejection !== null && rejection.info && <span>{rejection.message}</span>}
        {rejection === null && preview.status === "calculating" && <span>Calculando en el servidor…</span>}
        {rejection === null && preview.status === "waiting" && <span>Esperando para calcular…</span>}
        {rejection === null && preview.status === "ready" && preview.readyText && <span>{preview.readyText}</span>}
        {applying && <span> Aplicando…</span>}
      </div>

      {rejection === null && preview.status === "ready" && preview.warnings.length > 0 && (
        <ul className="offset-panel__warnings" aria-label="Advertencias del offset">
          {preview.warnings.map((warning) => (
            <li key={warning.kind} className={`offset-panel__warning offset-panel__warning--${warning.kind}`}>
              {warning.text}
            </li>
          ))}
        </ul>
      )}

      {confirmation && (
        <label className="offset-panel__confirm">
          <input type="checkbox" checked={confirmation.confirmed} onChange={(event) => confirmation.onChange(event.target.checked)} /> {confirmation.text}
        </label>
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
          title={applyDisabledReason ?? "Aplicar el offset (Enter)"}
        >
          Apply
        </button>
        <button type="button" className="crop-panel__cancel" onClick={onCancel} title="Descartar el offset sin dejar rastro (Escape)">
          Cancel
        </button>
      </div>
    </section>
  );
}
