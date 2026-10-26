import { useState } from "react";
import { getExportSvgUrl } from "../../api/exportApi";
import { useCheck } from "../../hooks/useCheck";
import type { CheckSourceKind } from "../../types/check";
import type { ExportSourceKind } from "../../types/export";

/**
 * Un SVG ya generado (vectorizado, simplificado o dimensionado) que el
 * usuario puede elegir como fuente de exportación -- extiende a un tercer
 * valor el mismo patrón dual ya usado en CheckSourceOption/
 * DimensionSourceOption (M1-S08/M1-S09).
 */
export interface ExportSourceOption {
  kind: ExportSourceKind;
  id: string;
  label: string;
  version: number;
  widthPx: number;
  heightPx: number;
  /** Solo presente si kind === "dimension": tamaño físico ya aplicado (ver DimensionResponse). */
  widthMm?: number;
  heightMm?: number;
  /**
   * El Laser Checker (M1-S08) solo admite "vector"/"simplification" como
   * fuente -- una DimensionVersion nunca toca los `d` de los paths (solo
   * width/height/viewBox del <svg> raíz, ver SvgDimensionWriter), así que
   * comparte EXACTAMENTE la misma geometría que el vector/simplificación del
   * que se originó. Para poder mostrar un resumen de issues también cuando
   * la fuente elegida es "dimension", el análisis se corre sobre este par
   * (el origen real de la geometría) en vez de sobre el dimensionId.
   */
  checkSourceKind: CheckSourceKind;
  checkSourceId: string;
}

interface ExportPanelProps {
  projectId: string;
  imageId: string;
  /** Al menos una fuente (el vector actual); simplificación y/o dimensión si ya se aplicaron. */
  sources: ExportSourceOption[];
}

/**
 * Orquesta el diálogo/resumen de exportación de spec.md M1-S10: el usuario
 * elige QUÉ versión exportar (vector/simplificación/dimensión), ve un
 * resumen (versión, tamaño físico en mm o en px, e issues del Laser
 * Checker) y descarga el archivo. El Laser Checker es puramente informativo
 * acá también (M1-S08): NUNCA deshabilita "Descargar", solo informa. El
 * checker se corre a pedido del usuario (mismo criterio de disparo manual
 * que CheckPanel) -- no se re-ejecuta automáticamente al cambiar de fuente,
 * para no forzar un análisis que el usuario no pidió.
 */
export function ExportPanel({ projectId, imageId, sources }: ExportPanelProps) {
  const [selectedIndex, setSelectedIndex] = useState(sources.length - 1);
  const selectedSource = sources[selectedIndex] ?? sources[0];

  const { status, result, errorMessage, run } = useCheck(
    projectId,
    imageId,
    selectedSource.checkSourceKind,
    selectedSource.checkSourceId,
  );

  const isRunning = status === "running";
  const exportUrl = getExportSvgUrl(projectId, imageId, selectedSource.kind, selectedSource.id);
  const sizeText =
    selectedSource.widthMm !== undefined && selectedSource.heightMm !== undefined
      ? `${formatNumber(selectedSource.widthMm)}mm × ${formatNumber(selectedSource.heightMm)}mm (${selectedSource.widthPx}px × ${selectedSource.heightPx}px internos)`
      : `${selectedSource.widthPx}px × ${selectedSource.heightPx}px`;

  return (
    <div className="export-panel">
      {sources.length > 1 && (
        <fieldset className="export-panel__source">
          <legend className="export-panel__source-legend">Versión a exportar</legend>
          <div className="export-panel__source-options" role="radiogroup" aria-label="Versión a exportar">
            {sources.map((source, index) => (
              <label key={`${source.kind}:${source.id}`} className="export-panel__source-option">
                <input
                  type="radio"
                  name="export-source"
                  checked={selectedIndex === index}
                  onChange={() => setSelectedIndex(index)}
                  aria-label={source.label}
                />
                <span aria-hidden="true">{source.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <dl className="service-card__details export-panel__summary">
        <div>
          <dt>Versión</dt>
          <dd>
            {selectedSource.label} (v{selectedSource.version})
          </dd>
        </div>
        <div>
          <dt>Tamaño</dt>
          <dd>{sizeText}</dd>
        </div>
      </dl>

      <div className="export-panel__checker">
        <div className="export-panel__actions">
          <button
            type="button"
            className="upload-actions__button"
            onClick={run}
            disabled={isRunning}
          >
            {isRunning ? "Analizando…" : status === "ready" ? "Analizar de nuevo" : "Revisar con Laser Checker"}
          </button>
          <span className="export-panel__status" role="status">
            {isRunning ? "Analizando…" : ""}
          </span>
        </div>

        {status === "error" && errorMessage && (
          <p className="upload-panel__error" role="alert">
            {errorMessage}
          </p>
        )}

        {result && (
          <dl className="service-card__details export-panel__summary">
            <div>
              <dt>Paths abiertos</dt>
              <dd>{result.summary.openPathCount}</dd>
            </div>
            <div>
              <dt>Duplicados/casi-duplicados</dt>
              <dd>{result.summary.duplicateGroupCount}</dd>
            </div>
          </dl>
        )}

        <p className="export-panel__hint">
          El Laser Checker es solo informativo: encontrar issues nunca impide la descarga.
        </p>
      </div>

      <a
        className="upload-actions__button upload-actions__button--primary export-panel__download"
        href={exportUrl}
        download
      >
        Descargar SVG en blanco y negro
      </a>
    </div>
  );
}

function formatNumber(value: number): string {
  return Number(value.toFixed(3)).toString();
}
