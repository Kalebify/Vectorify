import { useEffect, useId, useRef, useState } from "react";
import type { VectorDocumentLayer } from "../../hooks/useVectorDocument";
import { findLayersByHex, mergeCandidates as mergeCandidatesOf, normalizeHex, recolorHeadline, resolveActiveColor, type ColorPlan, type ColorTarget, type RecolorScope } from "../../lib/editor/colors";
import { PaletteBar } from "./PaletteBar";

export type ColorPanelMode = "fill" | "color";

const SCOPE_LABEL: Record<RecolorScope, string> = {
  selection: "Selección",
  layer: "Capa",
  document: "Documento",
};

interface ActiveColorReadoutProps {
  layers: readonly VectorDocumentLayer[];
  target: ColorTarget | null;
}

/** Swatch + nombre de la capa + hex del color activo ("Color activo: ▇ Rojo #FF0000"). */
export function ActiveColorReadout({ layers, target }: ActiveColorReadoutProps) {
  const active = resolveActiveColor(layers, target);
  return (
    <p className="color-panel__active" role="status" aria-live="polite">
      <span className="color-panel__active-label">Color activo:</span>{" "}
      {active ? (
        <>
          <span className="color-panel__active-swatch" style={{ backgroundColor: active.hex }} aria-hidden="true" />
          <strong>{active.name}</strong> <span>{active.hex}</span>
          {active.isNewColor ? <span> (capa nueva: se crea al aplicar)</span> : null}
        </>
      ) : (
        <span>ninguno. Elegilo en la paleta, con el selector o con el Eyedropper (I).</span>
      )}
    </p>
  );
}

interface EyedropperPanelProps {
  layers: readonly VectorDocumentLayer[];
  target: ColorTarget | null;
}

/** Panel contextual del Eyedropper (M3-S03): dice qué hace y muestra el color tomado (capa + hex). No muestrea píxeles. */
export function EyedropperPanel({ layers, target }: EyedropperPanelProps) {
  const idPrefix = useId();
  return (
    <section aria-labelledby={`${idPrefix}-heading`} className="color-panel">
      <h3 id={`${idPrefix}-heading`} className="editor-panel__heading">
        Eyedropper — tomar color
      </h3>
      <p className="color-panel__domain" role="note">
        Hacé click sobre un objeto del canvas: se toma el color de SU CAPA (no un hex suelto). Lee también capas bloqueadas, pero no las ocultas. Después usá Fill o Color para
        aplicarlo.
      </p>
      <ActiveColorReadout layers={layers} target={target} />
    </section>
  );
}

interface ColorPanelProps {
  mode: ColorPanelMode;
  /** Capas efectivas CONFIRMADAS (paleta de swatches, orígenes y fusiones posibles). */
  layers: VectorDocumentLayer[];
  /** Color activo (de la paleta, del Eyedropper o libre). */
  target: ColorTarget | null;
  onPickLayer: (groupId: string) => void;
  /** Color libre (hex ya normalizado `#RRGGBB`): un color NUEVO salvo que el usuario elija usar una capa existente. */
  onFreeColor: (hex: string) => void;
  scope: RecolorScope;
  onScopeChange: (scope: RecolorScope) => void;
  /** Por alcance: `null` = disponible, texto = por qué está deshabilitado (p. ej. "sin selección"). */
  scopeAvailability: Record<RecolorScope, string | null>;
  /** Capa de origen efectiva de los alcances capa/documento. */
  sourceGroupId: string | null;
  onSourceChange: (groupId: string) => void;
  /** Fusión explícita (alcances capa/documento): `null` = no fusionar. */
  mergeIntoGroupId: string | null;
  onMergeChange: (groupId: string | null) => void;
  /** Plan del recoloreo con la configuración actual (resumen + motivo de rechazo); `null` si todavía no hay color elegido. */
  plan: ColorPlan | null;
  /** Rechazo al aplicar o al rellenar desde el canvas (sin color, capa bloqueada...). Visible, nunca silencioso. */
  message: string | null;
  /** Hay que pedir confirmación antes de aplicar (alcance grande, documento o fusión) y el texto de esa confirmación. */
  confirming: boolean;
  confirmText: string;
  onApply: () => void;
  onConfirm: () => void;
  onBack: () => void;
  onCancel: () => void;
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/**
 * Panel contextual de Fill y Color/Recolor (M3-S03). Decisión de dominio (la tarjeta pide NO usar el hex como identidad): una capa es un
 * color de paleta; elegir un swatch elige una CAPA (destino por `groupId`), y un color libre NUEVO crea una capa nueva de forma explícita
 * (visible en el resumen, en el panel de capas y en la barra de paleta). Si el color libre coincide en hex con una capa existente se OFRECE
 * "Usar la capa «X»", nunca se compara en silencio.
 *
 * El alcance (selección / capa / documento) siempre está a la vista y el resumen dice qué se va a modificar ANTES de aplicar. Con
 * previsualización en el canvas (no entra en la pila de undo), Apply = Enter, Cancel = Escape (los maneja el shell) y confirmación
 * cuando el alcance es grande, el documento o una fusión.
 */
export function ColorPanel({
  mode,
  layers,
  target,
  onPickLayer,
  onFreeColor,
  scope,
  onScopeChange,
  scopeAvailability,
  sourceGroupId,
  onSourceChange,
  mergeIntoGroupId,
  onMergeChange,
  plan,
  message,
  confirming,
  confirmText,
  onApply,
  onConfirm,
  onBack,
  onCancel,
}: ColorPanelProps) {
  const idPrefix = useId();
  const [hexDraft, setHexDraft] = useState<string | undefined>(undefined);
  const [hexError, setHexError] = useState<string | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  // Al pedir confirmación el foco pasa al botón "Confirmar": operable por teclado sin buscarlo.
  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  const active = resolveActiveColor(layers, target);
  const freeHex = target?.kind === "new" ? normalizeHex(target.hex) : null;
  const matches = freeHex ? findLayersByHex(layers, freeHex) : [];
  const shownHex = hexDraft ?? active?.hex ?? "";
  const summary = plan?.summary ?? null;
  const showsSource = mode === "color" && scope !== "selection";
  const mergeCandidates = showsSource ? mergeCandidatesOf(layers, sourceGroupId, target) : [];

  const commitHex = () => {
    if (hexDraft === undefined) return;
    const text = hexDraft;
    setHexDraft(undefined);
    const normalized = normalizeHex(text);
    if (!normalized) {
      setHexError(`"${text.trim() || "(vacío)"}" no es un color hex válido (#RGB o #RRGGBB). No se cambió el color.`);
      return;
    }
    setHexError(null);
    onFreeColor(normalized);
  };

  const heading = mode === "fill" ? "Fill — aplicar color" : "Color — recolorear";
  const unchanged = !plan || plan.production === null;

  return (
    <section aria-labelledby={`${idPrefix}-heading`} className="color-panel">
      <h3 id={`${idPrefix}-heading`} className="editor-panel__heading">
        {heading}
      </h3>

      <p className="color-panel__domain" role="note">
        {mode === "fill"
          ? "Fill mueve los objetos seleccionados a la capa del color elegido. El color es la capa, no su hex: un color nuevo crea una capa nueva."
          : "Recolor cambia el color de la selección, de una capa o de un color en todo el documento. El color es la capa, no su hex: dos capas con el mismo hex siguen siendo capas distintas."}
      </p>

      <ActiveColorReadout layers={layers} target={target} />

      <PaletteBar
        layers={layers}
        selectedGroupId={target?.kind === "layer" ? target.groupId : null}
        onSelectGroup={onPickLayer}
        ariaLabel="Colores de la paleta para aplicar"
        swatchLabel={(layer) => `Usar el color de la capa ${layer.name} (${layer.colorHex})`}
        showAdd={false}
      />

      <div className="color-panel__free" role="group" aria-label="Color libre">
        <label htmlFor={`${idPrefix}-native`}>Selector de color</label>
        <input
          id={`${idPrefix}-native`}
          type="color"
          value={(freeHex ?? active?.hex ?? "#000000").toLowerCase()}
          onChange={(event) => {
            setHexDraft(undefined);
            setHexError(null);
            const normalized = normalizeHex(event.target.value);
            if (normalized) onFreeColor(normalized);
          }}
        />
        <label htmlFor={`${idPrefix}-hex`}>Color hex</label>
        <input
          id={`${idPrefix}-hex`}
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={shownHex}
          placeholder="#RRGGBB"
          aria-invalid={hexError !== null ? true : undefined}
          aria-describedby={hexError ? `${idPrefix}-hex-error` : undefined}
          onChange={(event) => setHexDraft(event.target.value)}
          onBlur={commitHex}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              // Enter dentro del campo confirma el CAMPO (no aplica el recoloreo): evita aplicar con un borrador a medias.
              event.preventDefault();
              event.stopPropagation();
              commitHex();
            } else if (event.key === "Escape" && hexDraft !== undefined) {
              event.stopPropagation();
              setHexDraft(undefined);
              setHexError(null);
            }
          }}
        />
      </div>
      {hexError && (
        <p id={`${idPrefix}-hex-error`} className="upload-panel__error" role="alert">
          {hexError}
        </p>
      )}

      {freeHex && matches.length > 0 && (
        <div className="color-panel__matches" role="group" aria-label="Capas con el mismo color">
          <p>
            {matches.length === 1 ? "Ya existe una capa con este color:" : "Ya existen capas con este color:"} no se compara en silencio, elegí si querés usar una de ellas o crear una capa nueva.
          </p>
          {matches.map((layer) => (
            <button key={layer.groupId} type="button" className="color-panel__match" onClick={() => onPickLayer(layer.groupId)}>
              Usar la capa «{layer.name}»
            </button>
          ))}
        </div>
      )}

      <fieldset className="color-panel__scope">
        <legend>Alcance</legend>
        {mode === "fill" ? (
          <p className="color-panel__scope-fixed">Selección: Fill se aplica a los objetos seleccionados (o al objeto en el que hagas click).</p>
        ) : (
          (Object.keys(SCOPE_LABEL) as RecolorScope[]).map((candidate) => {
            const reason = scopeAvailability[candidate];
            return (
              <label key={candidate} className="color-panel__scope-option" title={reason ?? undefined}>
                <input type="radio" name={`${idPrefix}-scope`} value={candidate} checked={scope === candidate} disabled={reason !== null} onChange={() => reason === null && onScopeChange(candidate)} />{" "}
                {SCOPE_LABEL[candidate]}
                {reason !== null ? ` (${reason})` : ""}
              </label>
            );
          })
        )}
      </fieldset>

      {showsSource && (
        <div className="color-panel__source">
          {scope === "document" ? (
            <>
              <label htmlFor={`${idPrefix}-source`}>Color de origen (capa)</label>
              <select id={`${idPrefix}-source`} value={sourceGroupId ?? ""} onChange={(event) => onSourceChange(event.target.value)}>
                <option value="" disabled>
                  Elegí una capa
                </option>
                {layers.map((layer) => (
                  <option key={layer.groupId} value={layer.groupId}>
                    {layer.name} ({layer.colorHex})
                  </option>
                ))}
              </select>
            </>
          ) : (
            <p>
              Capa a recolorear: <strong>{layers.find((layer) => layer.groupId === sourceGroupId)?.name ?? "—"}</strong>
            </p>
          )}
        </div>
      )}

      {mergeCandidates.length > 0 && (
        <fieldset className="color-panel__merge">
          <legend>Capas con el color de destino</legend>
          <label>
            <input type="radio" name={`${idPrefix}-merge`} checked={mergeIntoGroupId === null} onChange={() => onMergeChange(null)} /> No fusionar: la capa conserva su identidad y solo cambia de color
          </label>
          {mergeCandidates.map((layer) => (
            <label key={layer.groupId}>
              <input type="radio" name={`${idPrefix}-merge`} checked={mergeIntoGroupId === layer.groupId} onChange={() => onMergeChange(layer.groupId)} /> Fusionar con «{layer.name}» (mueve todos los objetos; la capa origen queda vacía)
            </label>
          ))}
        </fieldset>
      )}

      <section aria-labelledby={`${idPrefix}-summary`} className="color-panel__summary" aria-live="polite">
        <h4 id={`${idPrefix}-summary`} className="editor-panel__heading">
          Qué se va a modificar
        </h4>
        {summary === null || !plan ? (
          <p>Elegí un color para ver el resumen.</p>
        ) : (
          <ul>
            <li>
              Alcance: {mode === "fill" ? SCOPE_LABEL.selection : SCOPE_LABEL[scope]}. {plan.production ? recolorHeadline(summary) : "No hay cambios para aplicar."}
            </li>
            {summary.destination && summary.merge === null && summary.scope === "selection" && (
              <li>
                {summary.destination.created
                  ? `Se creará la capa nueva «${summary.destination.name}» (${summary.destination.colorHex}), sin guardar todavía, y los objetos se moverán a ella.`
                  : `Los objetos se moverán a la capa «${summary.destination.name}» (${summary.destination.colorHex}).`}
              </li>
            )}
            {summary.layerRecolor && (
              <li>
                La capa «{summary.layerRecolor.name}» cambia de {summary.layerRecolor.from} a {summary.layerRecolor.to} y conserva su identidad.
              </li>
            )}
            {summary.merge && (
              <li>
                Se fusiona «{summary.merge.fromName}» con «{summary.merge.intoName}»: «{summary.merge.fromName}» queda vacía (no se elimina).
              </li>
            )}
            {summary.alreadyThere > 0 && <li>{plural(summary.alreadyThere, "objeto ya está", "objetos ya están")} en la capa destino.</li>}
            {summary.skippedLocked > 0 && <li>{plural(summary.skippedLocked, "objeto está", "objetos están")} en capas bloqueadas y no se modificará.</li>}
            {summary.skippedHidden > 0 && <li>{plural(summary.skippedHidden, "objeto está", "objetos están")} en capas ocultas y no se modificará.</li>}
          </ul>
        )}
      </section>

      {(message ?? plan?.error) && (
        <p className="upload-panel__error" role="alert">
          {message ?? plan?.error}
        </p>
      )}

      {confirming ? (
        <div className="color-panel__confirm" role="alertdialog" aria-labelledby={`${idPrefix}-confirm`}>
          <p id={`${idPrefix}-confirm`}>{confirmText}</p>
          <div className="color-panel__actions">
            <button ref={confirmRef} type="button" className="color-panel__apply" onClick={onConfirm}>
              Confirmar
            </button>
            <button type="button" className="color-panel__cancel" onClick={onBack}>
              Volver
            </button>
          </div>
        </div>
      ) : (
        <div className="color-panel__actions">
          <button type="button" className="color-panel__apply" onClick={onApply} disabled={unchanged} title={unchanged ? "No hay cambios para aplicar" : "Aplicar (Enter)"}>
            Apply
          </button>
          <button type="button" className="color-panel__cancel" onClick={onCancel} title="Descartar la previsualización (Escape)">
            Cancel
          </button>
        </div>
      )}
    </section>
  );
}
