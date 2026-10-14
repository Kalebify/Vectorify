import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { LaserCheck } from "../../hooks/useLaserCheck";
import { LASER_CHECK_KIND_INFO, LASER_CHECK_SEVERITY_LABEL, LASER_CHECK_STATUS_LABEL, MAX_LISTED_ISSUES } from "../../lib/editor/laserCheck";
import type { ManufacturingOperationValue } from "../../types/manufacturingOperations";

export type LaserCheckPanelData = LaserCheck["panel"];

export interface LaserCheckPanelProps extends LaserCheckPanelData {
  onClose: () => void;
}

const OPERATION_LABEL: Record<ManufacturingOperationValue, string> = { cut: "Corte", engrave: "Grabado", ignore: "Ignorada", unassigned: "Sin operación" };

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/**
 * Panel del Laser Checker (M3-S14), en el rail derecho mientras está abierto desde el header:
 * - **Estado global** Ready / Review / Blocking, siempre por escrito (no solo por color). Si el documento cambió desde el análisis se muestra «Desactualizado» en su lugar:
 *   un resultado viejo nunca se presenta como vigente (y sus issues no se pueden activar hasta que se re-analice).
 * - **Lista de issues** (`role="listbox"`): severidad, tipo, capa (con su operación), objeto/componente, qué pasa y la acción sugerida. Teclado: Tab entra a la lista,
 *   ↑/↓/Inicio/Fin mueven el cursor, Enter o Espacio activan el issue (selecciona sus objetos y centra la vista), Escape cierra el panel devolviendo el foco al botón del header.
 * - **No verificado**: los checks que no se pudieron correr (flotantes en curso o caídos) se listan aparte: nunca cuentan como «sin problemas».
 * - Resumen en una región `aria-live`. Los umbrales vigentes (mm) y el alcance (qué capas entraron) están a la vista.
 */
export function LaserCheckPanel(props: LaserCheckPanelProps) {
  const { hasAnalysis, status, stale, analyzing, summary, scopeText, thresholdsText, scaleNotice, issues, unverified, floatingError, selectedIssueId, onSelectIssue, onAnalyze, onRetryFloating, onClose } = props;
  const idPrefix = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const [cursor, setCursor] = useState<string | null>(null);

  // Al abrir el foco entra al panel: el teclado sigue desde ahí (Tab -> Analizar -> lista).
  useEffect(() => {
    sectionRef.current?.focus();
  }, []);

  const shown = issues.slice(0, MAX_LISTED_ISSUES);
  const activeId = shown.some((issue) => issue.id === cursor) ? cursor : shown.some((issue) => issue.id === selectedIssueId) ? selectedIssueId : null;

  const moveCursor = (id: string) => {
    setCursor(id);
    document.getElementById(`${idPrefix}-issue-${id}`)?.scrollIntoView?.({ block: "nearest" });
  };

  // Un resultado desactualizado puede apuntar a objetos que ya no existen: no se navega hasta re-analizar.
  const activate = (id: string) => {
    if (!stale) onSelectIssue(id);
  };

  const handleListKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (shown.length === 0) return;
    const current = shown.findIndex((issue) => issue.id === activeId);
    let next = -1;
    if (event.key === "ArrowDown") next = current < 0 ? 0 : Math.min(shown.length - 1, current + 1);
    else if (event.key === "ArrowUp") next = current < 0 ? shown.length - 1 : Math.max(0, current - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = shown.length - 1;
    else if ((event.key === "Enter" || event.key === " ") && current >= 0) {
      event.preventDefault();
      event.stopPropagation();
      activate(shown[current].id);
      return;
    }
    if (next < 0) return;
    event.preventDefault();
    event.stopPropagation();
    moveCursor(shown[next].id);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };

  const badgeKey = stale ? "stale" : status ?? "pending";
  const badgeText = stale ? "Desactualizado" : status ? LASER_CHECK_STATUS_LABEL[status] : "Analizando…";
  const liveText = stale
    ? `Resultado desactualizado${status ? ` (último análisis: ${LASER_CHECK_STATUS_LABEL[status]})` : ""}: el documento cambió. Re-analizando…`
    : summary;

  return (
    <section
      id="editor-laser-check-panel"
      ref={sectionRef}
      tabIndex={-1}
      aria-labelledby={`${idPrefix}-heading`}
      className="boolean-panel laser-check-panel"
      data-stale={stale ? "true" : "false"}
      onKeyDown={handleKeyDown}
    >
      <header className="laser-check-panel__header">
        <h3 id={`${idPrefix}-heading`} className="editor-panel__heading">
          Laser Check
        </h3>
        <button type="button" className="laser-check-panel__close" onClick={onClose} aria-label="Cerrar el Laser Check" title="Cerrar (Escape)">
          ✕
        </button>
      </header>

      {scaleNotice && (
        <p className="offset-panel__scale" role="note">
          {scaleNotice}
        </p>
      )}

      <div className="laser-check-panel__status">
        <span className={`laser-check-panel__badge laser-check-panel__badge--${badgeKey}`} data-testid="laser-check-status" data-status={status ?? ""} data-stale={stale ? "true" : "false"}>
          {badgeText}
        </span>
        <button type="button" className="crop-panel__preset" onClick={onAnalyze} title="Volver a analizar el documento ahora">
          {hasAnalysis ? "Volver a analizar" : "Analizar"}
        </button>
      </div>

      <p className="boolean-panel__state" role="status" aria-live="polite" data-testid="laser-check-summary">
        {liveText}
        {analyzing && !stale ? " Analizando las piezas flotantes en el servidor…" : ""}
      </p>

      {hasAnalysis && <p className="boolean-panel__hint">{scopeText}</p>}

      {unverified.length > 0 && (
        <ul className="offset-panel__warnings" aria-label="Checks no verificados">
          {unverified.map((check) => (
            <li key={check.id} className="offset-panel__warning laser-check-panel__unverified" data-check={check.id}>
              <strong>No verificado: {check.label}.</strong> {check.reason}
            </li>
          ))}
        </ul>
      )}
      {floatingError && (
        <div className="boolean-panel__error" role="alert">
          <p className="upload-panel__error">No se pudieron analizar las piezas flotantes. Los demás checks siguen siendo válidos.</p>
          <button type="button" className="crop-panel__preset" onClick={onRetryFloating}>
            Reintentar
          </button>
        </div>
      )}

      {hasAnalysis && issues.length === 0 && !stale && (
        <p className="boolean-panel__hint" data-testid="laser-check-empty">
          {unverified.length === 0 ? "No se encontraron problemas de fabricación." : "No se encontraron problemas en lo que se pudo verificar."}
        </p>
      )}

      {issues.length > 0 && (
        <>
          <p id={`${idPrefix}-issues-label`} className="boolean-panel__hint">
            {plural(issues.length, "problema", "problemas")} (↑/↓ para recorrerlos, Enter para ir al objeto: se selecciona y la vista se centra).
            {issues.length > shown.length ? ` Se muestran los primeros ${shown.length}.` : ""}
          </p>
          <ul
            className="laser-check-panel__issues"
            role="listbox"
            tabIndex={0}
            aria-labelledby={`${idPrefix}-issues-label`}
            aria-activedescendant={activeId !== null ? `${idPrefix}-issue-${activeId}` : undefined}
            onKeyDown={handleListKeyDown}
          >
            {shown.map((issue) => {
              const selected = issue.id === selectedIssueId;
              return (
                <li
                  key={issue.id}
                  id={`${idPrefix}-issue-${issue.id}`}
                  role="option"
                  aria-selected={selected}
                  aria-disabled={stale || undefined}
                  data-severity={issue.severity}
                  data-kind={issue.kind}
                  className={`laser-check-panel__issue laser-check-panel__issue--${issue.severity}${selected ? " laser-check-panel__issue--selected" : ""}${issue.id === activeId ? " laser-check-panel__issue--active" : ""}${stale ? " laser-check-panel__issue--stale" : ""}`}
                  onClick={() => activate(issue.id)}
                >
                  <span className="laser-check-panel__issue-head">
                    <span className={`laser-check-panel__severity laser-check-panel__severity--${issue.severity}`}>{LASER_CHECK_SEVERITY_LABEL[issue.severity]}</span>
                    <strong>{LASER_CHECK_KIND_INFO[issue.kind].label}</strong>
                  </span>
                  <span className="laser-check-panel__issue-meta">
                    Capa «{issue.layerName}» ({OPERATION_LABEL[issue.operation]}) · {issue.objectLabel}
                  </span>
                  <span className="laser-check-panel__issue-message">{issue.message}</span>
                  <span className="laser-check-panel__issue-action">Acción sugerida: {issue.suggestion}</span>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <details className="boolean-panel__advanced">
        <summary>Umbrales y alcance</summary>
        <p className="boolean-panel__hint">{thresholdsText}</p>
        <p className="boolean-panel__hint">
          Paths abiertos y piezas flotantes solo importan en Corte; las capas ignoradas y ocultas no se analizan; una capa sin operación se analiza como Corte.
        </p>
      </details>
    </section>
  );
}
