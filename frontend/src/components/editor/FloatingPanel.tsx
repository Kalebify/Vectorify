import { useId, type KeyboardEvent } from "react";
import { FLOATING_MODES, FLOATING_MODE_INFO } from "../../lib/editor/floating";
import { formatDisplayNumber } from "../../lib/editor/units";
import type { FloatingTool } from "../../hooks/useFloatingTool";
import { MeasureField } from "./MeasureField";

export type FloatingPanelProps = FloatingTool["panel"];

/**
 * Panel de piezas flotantes y bridges (M3-S11), en el rail derecho mientras la herramienta está activa:
 * - **Modo** explícito de «flotante» (*Plantilla* / *Piezas*), con su descripción; el activo se indica siempre por escrito. Cambiarlo descarta el análisis.
 * - **Alcance**: qué se analiza («Capas CUT: A, B (12 objetos)» o «Selección: 3 objetos»), con lo bloqueado (cuenta, no se modifica) y lo oculto (no cuenta).
 * - **Analizar** y la **lista de issues** (`role="listbox"`, navegable con ↑/↓/Inicio/Fin): seleccionar una pieza centra la vista en ella y la resalta en el canvas.
 * - **Bridges**: ancho en mm, sugerencias del servidor, colocación manual (click sobre el borde de una pieza), mover/quitar por bridge, el resultado del reanálisis
 *   «N flotantes → M» y los avisos (no redujo nada, quedan sin puente, bloqueados, descartes). Apply queda deshabilitado con CUALQUIER bridge inválido (con el motivo).
 * - Estado del cálculo en una región `aria-live`. Apply = Enter, Cancel = Escape.
 */
export function FloatingPanel(props: FloatingPanelProps) {
  const {
    mode,
    onModeChange,
    scopeText,
    unitLabel,
    scaleNotice,
    widthMm,
    widthMin,
    widthMax,
    onWidthChange,
    analysis,
    onAnalyze,
    onRetryAnalysis,
    issues,
    selectedIssue,
    onSelectIssue,
    bridges,
    placing,
    onTogglePlacing,
    onStartMoving,
    onRemoveBridge,
    onSuggest,
    onRetryBridges,
    message,
    applying,
    applyDisabledReason,
    onApply,
    onCancel,
  } = props;
  const idPrefix = useId();
  const showBlock = applyDisabledReason !== null && bridges.visible && bridges.status === "ready" && bridges.rejection === null;
  const modeInfo = FLOATING_MODE_INFO[mode];

  const handleListKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (issues.length === 0) return;
    const current = issues.findIndex((issue) => issue.id === selectedIssue);
    let next = -1;
    if (event.key === "ArrowDown") next = current < 0 ? 0 : Math.min(issues.length - 1, current + 1);
    else if (event.key === "ArrowUp") next = current < 0 ? issues.length - 1 : Math.max(0, current - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = issues.length - 1;
    else if ((event.key === "Enter" || event.key === " ") && current >= 0) next = current;
    if (next < 0) return;
    event.preventDefault();
    event.stopPropagation();
    onSelectIssue(issues[next].id);
  };

  return (
    <section aria-labelledby={`${idPrefix}-heading`} className="boolean-panel floating-panel">
      <h3 id={`${idPrefix}-heading`} className="editor-panel__heading">
        Piezas flotantes
      </h3>

      {scaleNotice && (
        <p className="offset-panel__scale" role="note">
          {scaleNotice}
        </p>
      )}

      <fieldset className="draw-panel__modes">
        <legend>Qué significa «flotante»</legend>
        {FLOATING_MODES.map((candidate) => (
          <label key={candidate} title={FLOATING_MODE_INFO[candidate].description}>
            <input type="radio" name={`${idPrefix}-mode`} checked={mode === candidate} onChange={() => onModeChange(candidate)} /> {FLOATING_MODE_INFO[candidate].label}
          </label>
        ))}
      </fieldset>
      <p className="boolean-panel__hint">
        <strong>Modo activo: {modeInfo.label}.</strong> {modeInfo.description}
      </p>

      <p className="boolean-panel__resolved floating-panel__scope">{scopeText}</p>

      <div className="crop-panel__actions">
        <button type="button" className="crop-panel__preset" onClick={onAnalyze} title="Analizar las piezas flotantes del alcance indicado">
          {analysis.hasAnalysis ? "Volver a analizar" : "Analizar"}
        </button>
      </div>

      <div className="boolean-panel__state" role="status" aria-live="polite">
        {analysis.hasAnalysis && analysis.status === "calculating" && <span>Analizando en el servidor…</span>}
        {analysis.hasAnalysis && analysis.status === "waiting" && <span>Esperando para analizar…</span>}
        {analysis.summary && <span>{analysis.summary}</span>}
        {bridges.visible && bridges.status === "calculating" && <span> Calculando los bridges en el servidor…</span>}
        {bridges.visible && bridges.status === "ready" && bridges.reanalysisText && (
          <strong className="floating-panel__result" data-testid="floating-reanalysis">
            {bridges.reanalysisText}
          </strong>
        )}
        {applying && <span> Aplicando…</span>}
      </div>

      {analysis.stale && (
        <p className="upload-panel__error" role="alert">
          El documento cambió desde el análisis: volvé a analizar. No se modificó nada.
        </p>
      )}
      {analysis.errorMessage && (
        <div className="boolean-panel__error" role="alert">
          <p className="upload-panel__error">{analysis.errorMessage}</p>
          <button type="button" className="crop-panel__preset" onClick={onRetryAnalysis}>
            Reintentar
          </button>
        </div>
      )}

      {issues.length > 0 && (
        <>
          <p id={`${idPrefix}-issues-label`} className="boolean-panel__hint">
            {issues.length === 1 ? "1 pieza" : `${issues.length} piezas`} (↑/↓ para recorrerlas: la vista se centra en cada una).
          </p>
          <ul
            className="floating-panel__issues"
            role="listbox"
            tabIndex={0}
            aria-labelledby={`${idPrefix}-issues-label`}
            aria-activedescendant={selectedIssue !== null ? `${idPrefix}-issue-${selectedIssue}` : undefined}
            onKeyDown={handleListKeyDown}
          >
            {issues.map((issue) => (
              <li
                key={issue.id}
                id={`${idPrefix}-issue-${issue.id}`}
                role="option"
                aria-selected={issue.id === selectedIssue}
                className={`floating-panel__issue${issue.id === selectedIssue ? " floating-panel__issue--selected" : ""}`}
                onClick={() => onSelectIssue(issue.id)}
              >
                {issue.description}
              </li>
            ))}
          </ul>
        </>
      )}

      {bridges.visible && (
        <div className="floating-panel__bridges" role="group" aria-label="Bridges">
          <h4 className="floating-panel__subheading">Bridges</h4>
          <MeasureField
            label="Ancho del bridge"
            value={widthMm}
            unitLabel={unitLabel}
            min={widthMin}
            max={widthMax}
            step={0.1}
            onCommit={onWidthChange}
            hint={`Entre ${widthMin.toLocaleString("es-AR")} y ${widthMax.toLocaleString("es-AR")} ${unitLabel}. El puente que conecta cada pieza con el material vecino.`}
          />
          <div className="crop-panel__actions">
            <button type="button" className="crop-panel__preset" onClick={onSuggest} title="Volver a pedir una sugerencia de bridge por cada pieza flotante">
              Sugerir bridges
            </button>
            <button
              type="button"
              className="crop-panel__preset"
              aria-pressed={placing === "add"}
              onClick={onTogglePlacing}
              title="Hacé click sobre el borde de una pieza flotante para colocar un bridge (Escape sale del modo)"
            >
              Colocar bridge
            </button>
          </div>
          {placing !== null && (
            <p className="boolean-panel__hint" role="note">
              {placing === "move" ? "Hacé click sobre el borde de una pieza para mover el bridge ahí." : "Hacé click sobre el borde de una pieza flotante para colocar un bridge."} Escape sale del modo.
            </p>
          )}

          {bridges.suggestPending && bridges.status !== "ready" && bridges.status !== "error" && <p className="boolean-panel__hint">Calculando las sugerencias…</p>}

          {bridges.rows.length > 0 && (
            <ul className="floating-panel__bridge-list" aria-label="Bridges propuestos">
              {bridges.rows.map((row) => (
                <li key={row.index} className={`floating-panel__bridge${row.valid ? "" : " floating-panel__bridge--invalid"}`} data-testid="floating-bridge-row">
                  <span className="floating-panel__bridge-text">
                    <strong>{row.label}</strong>
                    {row.islandLabel ? ` · ${row.islandLabel}` : ""}
                    {row.suggested ? " · sugerido" : ""}
                    {row.valid && row.length !== null && row.area !== null
                      ? ` · largo ${formatDisplayNumber(row.length)} ${unitLabel} · ${bridges.areaVerb} ${formatDisplayNumber(row.area)} ${unitLabel}²${row.reduces ? "" : " · no reduce nada"}`
                      : ""}
                    {!row.valid && row.reasonText ? ` · inválido: ${row.reasonText}` : ""}
                  </span>
                  {row.key !== null && (
                    <span className="floating-panel__bridge-actions">
                      <button type="button" className="crop-panel__preset" aria-pressed={row.moving} onClick={() => onStartMoving(row.key!)} aria-label={`Mover ${row.label}`}>
                        Mover
                      </button>
                      <button type="button" className="crop-panel__preset" onClick={() => onRemoveBridge(row.key!)} aria-label={`Quitar ${row.label}`}>
                        Quitar
                      </button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}

          {bridges.status === "ready" && bridges.warnings.length > 0 && (
            <ul className="offset-panel__warnings" aria-label="Advertencias de los bridges">
              {bridges.warnings.map((warning) => (
                <li key={warning.kind} className={`offset-panel__warning floating-panel__warning--${warning.kind}`}>
                  {warning.text}
                </li>
              ))}
            </ul>
          )}

          {bridges.rejection !== null && (
            <p className={bridges.rejection.info ? "boolean-panel__hint" : "upload-panel__error"} role={bridges.rejection.info ? "status" : "alert"}>
              {bridges.rejection.message}
            </p>
          )}
          {bridges.rejection === null && bridges.errorMessage && (
            <div className="boolean-panel__error" role="alert">
              <p className="upload-panel__error">{bridges.errorMessage}</p>
              <button type="button" className="crop-panel__preset" onClick={onRetryBridges}>
                Reintentar
              </button>
            </div>
          )}
          {showBlock && (
            <p className="upload-panel__error" role="alert">
              {applyDisabledReason}
            </p>
          )}
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
          title={applyDisabledReason ?? "Aplicar los bridges (Enter)"}
        >
          Apply
        </button>
        <button type="button" className="crop-panel__cancel" onClick={onCancel} title="Descartar el análisis y los bridges sin dejar rastro (Escape)">
          Cancel
        </button>
      </div>
    </section>
  );
}
