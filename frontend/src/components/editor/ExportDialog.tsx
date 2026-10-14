import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useExport } from "../../hooks/useExport";
import type { DownloadFile } from "../../lib/editor/export/browser";
import type { ExportDocument } from "../../lib/editor/export/exportDocument";
import { EXCLUSION_LABEL, FORMAT_LABEL, MAX_PREFLIGHT_ISSUES_SHOWN, type ExportFormat, type ExportMode } from "../../lib/editor/export/exportPlan";
import { PNG_DEFAULT_BACKGROUND, PNG_MAX_PIXELS, PNG_MAX_SIDE, type Rasterizer } from "../../lib/editor/export/pngExport";
import type { LaserCheckReport } from "../../lib/editor/laserCheck";
import { parseNumericInput } from "../../lib/editor/units";

export interface ExportDialogProps {
  document: ExportDocument;
  /** Reporte VIGENTE del Laser Check, o `null` (sin análisis todavía o desactualizado): el preflight lo muestra como NO VERIFICADO. */
  laserReport: LaserCheckReport | null;
  rasterize?: Rasterizer;
  download: DownloadFile;
  yieldToEventLoop?: () => Promise<void>;
  onClose: () => void;
}

const FORMATS: ExportFormat[] = ["svg", "dxf", "png"];
const FORMAT_HINT: Record<ExportFormat, string> = {
  svg: "Formato canónico, en mm cuando hay escala.",
  dxf: "Para CAD/CAM, en mm (polilíneas R12).",
  png: "Vista previa, no es un archivo de fabricación.",
};
const MODES: Array<{ value: ExportMode; label: string }> = [
  { value: "document", label: "Un solo archivo con las layers elegidas" },
  { value: "layers", label: "Un archivo por layer (en un ZIP si son varios)" },
];
const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/**
 * Diálogo de export avanzado (M3-S15), modal y accesible: `role="dialog"` + `aria-modal`, el foco entra al diálogo, Tab queda atrapado dentro, Escape cierra (y el
 * shell devuelve el foco al botón EXPORT) y el estado «Generando… / Listo / Error» se anuncia en una región `aria-live`. Muestra el preflight (dimensiones, layers con
 * su operación, Laser Check) antes de generar; con un Laser Check Blocking el botón dice «Exportar de todos modos» y exige tildar una confirmación.
 */
export function ExportDialog({ document: exportDocument, laserReport, rasterize, download, yieldToEventLoop, onClose }: ExportDialogProps) {
  const exporter = useExport({ document: exportDocument, laserReport, rasterize, download, yieldToEventLoop });
  const { options, updateOptions, selection, setLayerSelected, selectLayers, preflight, confirmed, setConfirmed, status, announcement, generating, canSubmit, submit } = exporter;
  const idPrefix = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [widthText, setWidthText] = useState(String(options.pngWidth));
  const [solidColor, setSolidColor] = useState(options.pngBackground ?? PNG_DEFAULT_BACKGROUND);

  // Al abrir el foco entra al diálogo (el lector de pantalla lee su título).
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Nada de lo que se teclea acá debe llegar a los atajos del editor (Ctrl+Z, Suprimir...).
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = globalThis.document.activeElement;
    if (event.shiftKey && (active === first || active === dialog)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const changeWidth = (text: string) => {
    setWidthText(text);
    updateOptions({ pngWidth: parseNumericInput(text) ?? Number.NaN });
  };

  const { laser } = preflight;
  const titleId = `${idPrefix}-title`;
  const descriptionId = `${idPrefix}-description`;
  const hintId = `${idPrefix}-hint`;
  const transparent = options.pngBackground === null;
  const submitLabel = generating ? "Generando…" : laser.state === "blocking" ? "Exportar de todos modos" : "Exportar";
  const submitHint = preflight.error ?? (preflight.requiresConfirmation && !confirmed ? "Confirmá que querés exportar con problemas bloqueantes del Laser Check." : null);

  return (
    <div className="export-dialog__backdrop">
      <div
        ref={dialogRef}
        id="editor-export-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={generating}
        tabIndex={-1}
        className="export-dialog"
        onKeyDown={handleKeyDown}
      >
        <header className="export-dialog__header">
          <h2 id={titleId} className="editor-panel__heading">
            Exportar
          </h2>
          <button type="button" className="laser-check-panel__close" onClick={onClose} aria-label="Cerrar el diálogo de exportación" title="Cerrar (Escape)">
            ✕
          </button>
        </header>

        <p id={descriptionId} className="boolean-panel__hint" data-testid="export-summary">
          Proyecto «{exportDocument.projectName}» · {preflight.dimensionsText} · {plural(preflight.includedCount, "layer incluida", "layers incluidas")} ({plural(preflight.objectCount, "objeto", "objetos")}).
        </p>

        <p className="boolean-panel__state" role="status" aria-live="polite" aria-atomic="true" data-testid="export-status" data-state={status.state}>
          {announcement}
        </p>

        <fieldset className="export-dialog__group" disabled={generating}>
          <legend>Formato</legend>
          <div className="export-dialog__options">
            {FORMATS.map((format) => (
              <label key={format} className="export-dialog__option">
                <input type="radio" name={`${idPrefix}-format`} value={format} checked={options.format === format} onChange={() => updateOptions({ format })} />
                <span>
                  <strong>{FORMAT_LABEL[format]}</strong> <span className="export-dialog__muted">{FORMAT_HINT[format]}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="export-dialog__group" disabled={generating}>
          <legend>Archivos</legend>
          <div className="export-dialog__options">
            {MODES.map((mode) => (
              <label key={mode.value} className="export-dialog__option">
                <input type="radio" name={`${idPrefix}-mode`} value={mode.value} checked={options.mode === mode.value} onChange={() => updateOptions({ mode: mode.value })} />
                <span>{mode.label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        {options.format === "png" && (
          <fieldset className="export-dialog__group" disabled={generating}>
            <legend>Tamaño y fondo del PNG</legend>
            <label className="export-dialog__field">
              <span>Ancho (px)</span>
              <input type="text" inputMode="numeric" value={widthText} onChange={(event) => changeWidth(event.target.value)} aria-describedby={`${idPrefix}-png-size`} />
            </label>
            <p id={`${idPrefix}-png-size`} className="boolean-panel__hint" data-testid="export-png-size">
              {preflight.png ? `Resultado: ${preflight.png.width} × ${preflight.png.height} px (se mantiene la relación de aspecto).` : "Resultado: ancho inválido."} Máximo {PNG_MAX_SIDE} px por lado y {PNG_MAX_PIXELS / 1_000_000} megapíxeles.
            </p>
            <div className="export-dialog__options">
              <label className="export-dialog__option">
                <input type="radio" name={`${idPrefix}-background`} checked={transparent} onChange={() => updateOptions({ pngBackground: null })} />
                <span>Fondo transparente</span>
              </label>
              <label className="export-dialog__option">
                <input type="radio" name={`${idPrefix}-background`} checked={!transparent} onChange={() => updateOptions({ pngBackground: solidColor })} />
                <span>Fondo de color</span>
              </label>
              <label className="export-dialog__field">
                <span>Color de fondo</span>
                <input
                  type="color"
                  value={solidColor}
                  disabled={transparent}
                  onChange={(event) => {
                    setSolidColor(event.target.value);
                    updateOptions({ pngBackground: event.target.value });
                  }}
                />
              </label>
            </div>
          </fieldset>
        )}

        <fieldset className="export-dialog__group" disabled={generating}>
          <legend>Layers a exportar</legend>
          <div className="export-dialog__bulk">
            <button type="button" className="crop-panel__preset" onClick={() => selectLayers("default")} title="Las layers visibles y que no están en IGNORE">
              Visibles
            </button>
            <button type="button" className="crop-panel__preset" onClick={() => selectLayers("all")}>
              Todas
            </button>
            <button type="button" className="crop-panel__preset" onClick={() => selectLayers("none")}>
              Ninguna
            </button>
          </div>
          <ul className="export-dialog__layers" aria-label="Layers del documento">
            {preflight.layers.map((layer) => (
              <li key={layer.groupId} className={`export-dialog__layer${layer.included ? "" : " export-dialog__layer--excluded"}`} data-operation={layer.operation} data-included={layer.included ? "true" : "false"}>
                <label className="export-dialog__option">
                  <input type="checkbox" checked={selection.has(layer.groupId)} onChange={(event) => setLayerSelected(layer.groupId, event.target.checked)} />
                  <span className="export-dialog__swatch" style={{ background: layer.colorHex }} aria-hidden="true" />
                  <span>
                    <strong>{layer.name}</strong> · {layer.operationLabel} · {plural(layer.objectCount, "objeto", "objetos")}
                    {layer.exclusion && <span className="export-dialog__muted"> · no se exporta: {EXCLUSION_LABEL[layer.exclusion]}</span>}
                    {layer.notes.length > 0 && <span className="export-dialog__muted"> · {layer.notes.join(", ")}</span>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>

        <section className="export-dialog__preflight" aria-labelledby={`${idPrefix}-preflight`}>
          <h3 id={`${idPrefix}-preflight`} className="editor-panel__heading">
            Preflight
          </h3>
          <p className="boolean-panel__hint" data-testid="export-dimensions">
            Dimensiones: {preflight.dimensionsText}.
          </p>

          <div className="laser-check-panel__status">
            <span className={`laser-check-panel__badge laser-check-panel__badge--${laser.state === "unverified" ? "stale" : laser.state}`} data-testid="export-laser-status" data-state={laser.state}>
              {laser.label}
            </span>
            <span className="boolean-panel__hint" data-testid="export-laser-summary">
              {laser.summary}
            </span>
          </div>

          {laser.blocking.length > 0 && (
            <ul className="export-dialog__issues" aria-label="Problemas bloqueantes del Laser Check">
              {laser.blocking.slice(0, MAX_PREFLIGHT_ISSUES_SHOWN).map((issue) => (
                <li key={issue.id} className="laser-check-panel__issue laser-check-panel__issue--error" data-testid="export-blocking-issue">
                  <span className="laser-check-panel__issue-head">
                    <span className="laser-check-panel__severity laser-check-panel__severity--error">Bloqueante</span>
                    <strong>{issue.kindLabel}</strong>
                  </span>
                  <span className="laser-check-panel__issue-meta">
                    Capa «{issue.layerName}» · {issue.objectLabel}
                  </span>
                  <span className="laser-check-panel__issue-message">{issue.message}</span>
                </li>
              ))}
              {laser.blocking.length > MAX_PREFLIGHT_ISSUES_SHOWN && <li className="export-dialog__muted">… y {laser.blocking.length - MAX_PREFLIGHT_ISSUES_SHOWN} más (están en el panel del Laser Check).</li>}
            </ul>
          )}

          {laser.unverified.length > 0 && (
            <ul className="offset-panel__warnings" aria-label="Checks no verificados">
              {laser.unverified.map((text) => (
                <li key={text} className="offset-panel__warning laser-check-panel__unverified" data-testid="export-unverified">
                  <strong>No verificado.</strong> {text}
                </li>
              ))}
            </ul>
          )}

          {preflight.warnings.length > 0 && (
            <ul className="offset-panel__warnings" aria-label="Avisos del export">
              {preflight.warnings.map((warning) => (
                <li key={warning.code} className="offset-panel__warning" data-code={warning.code}>
                  {warning.message}
                </li>
              ))}
            </ul>
          )}

          {preflight.files.length > 0 && (
            <div className="export-dialog__files">
              <p className="boolean-panel__hint" data-testid="export-download-name">
                Se descargará: <strong>{preflight.downloadName}</strong>
                {preflight.packaged ? ` (ZIP con ${preflight.files.length} archivos)` : ""}
              </p>
              {preflight.packaged && (
                <ul aria-label="Archivos dentro del ZIP" className="export-dialog__file-list">
                  {preflight.files.map((name) => (
                    <li key={name}>{name}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>

        {status.state === "error" && (
          <p className="boolean-panel__error upload-panel__error" role="alert" data-testid="export-error">
            {status.message}
          </p>
        )}

        {preflight.requiresConfirmation && (
          <label className="export-dialog__option export-dialog__confirm">
            <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} disabled={generating} />
            <span>Entiendo que el Laser Check encontró problemas bloqueantes y quiero exportar de todos modos.</span>
          </label>
        )}

        {submitHint && !generating && (
          <p id={hintId} className="boolean-panel__hint" data-testid="export-hint">
            {submitHint}
          </p>
        )}

        <footer className="export-dialog__footer">
          <button type="button" className="editor-header__button" onClick={onClose}>
            Cancelar
          </button>
          <button
            type="button"
            className="editor-header__button editor-header__button--primary"
            disabled={!canSubmit}
            aria-describedby={submitHint && !generating ? hintId : undefined}
            onClick={() => void submit()}
          >
            {submitLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}
