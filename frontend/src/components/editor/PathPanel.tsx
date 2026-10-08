import { useId, useState } from "react";
import type { PathPanelModel } from "../../hooks/usePathTool";
import type { NodeKind } from "../../lib/editor/nodes";
import { formatDisplayNumber, parseNumericInput } from "../../lib/editor/units";

interface NumberFieldProps {
  label: string;
  /** Valor vigente ya en la unidad del campo, o `null` (sin valor común / no aplica). */
  value: number | null;
  disabled?: boolean;
  /** Confirma un número válido (Enter/blur); devuelve un mensaje de error o `null` si se aplicó. */
  onCommit: (value: number) => string | null;
}

/**
 * Campo numérico del panel de Path: se confirma con Enter/blur (UN comando), Escape descarta el borrador y un valor inválido se RECHAZA con
 * mensaje sin cambiar nada. A diferencia de `MeasureField` acepta cero y negativos (una coordenada puede ser cualquiera).
 */
function NumberField({ label, value, disabled = false, onCommit }: NumberFieldProps) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const commit = () => {
    if (draft === null) return;
    const text = draft;
    setDraft(null);
    const parsed = parseNumericInput(text);
    if (parsed === null) {
      setError(`"${text.trim() || "(vacío)"}" no es un número válido para «${label}». No se aplicó ningún cambio.`);
      return;
    }
    if (value !== null && formatDisplayNumber(parsed) === formatDisplayNumber(value)) {
      setError(null);
      return;
    }
    setError(onCommit(parsed));
  };

  return (
    <div className="object-inspector__field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        disabled={disabled}
        value={draft ?? (value === null ? "" : formatDisplayNumber(value))}
        placeholder={value === null ? "Varios" : undefined}
        aria-invalid={error !== null ? true : undefined}
        aria-describedby={error !== null ? `${id}-error` : undefined}
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
      {error !== null && (
        <small id={`${id}-error`} className="upload-panel__error" role="alert">
          {error}
        </small>
      )}
    </div>
  );
}

const KIND_OPTIONS: Array<{ kind: NodeKind; label: string }> = [
  { kind: "corner", label: "Esquina" },
  { kind: "smooth", label: "Suave" },
  { kind: "symmetric", label: "Simétrico" },
];

interface PathPanelProps {
  panel: PathPanelModel;
  onExit: () => void;
}

/**
 * Panel contextual de la herramienta Path (M3-S05): estado del objeto editado, coordenadas del nodo seleccionado (mm, relativas al área
 * de trabajo; con varios, los valores comunes), tipo de nodo, largo/ángulo de sus handles, tipo de segmento, recuento de nodos y las
 * acciones de subpath (cerrar / abrir / eliminar). Todo operable por teclado; cada edición confirmada es UN comando.
 */
export function PathPanel({ panel, onExit }: PathPanelProps) {
  const idPrefix = useId();
  const unit = panel.unitLabel;
  const editing = panel.status === "ok";
  const single = panel.selectedCount === 1;
  const selection = panel.selectedCount;

  return (
    <section aria-labelledby={`${idPrefix}-heading`} className="draw-panel path-panel">
      <h3 id={`${idPrefix}-heading`} className="editor-panel__heading">
        Path — nodos
      </h3>

      <p className="draw-panel__domain" role="note">
        Edita los nodos y handles del path seleccionado sin tocar su transformación. Cada gesto es un comando: Ctrl+Z lo deshace. Escape limpia la selección o sale; Enter sale.
      </p>

      {!editing && panel.message && (
        <p className="upload-panel__error" role="alert">
          {panel.message}
        </p>
      )}

      {editing && (
        <>
          <p className="draw-panel__target" aria-live="polite">
            Capa: <strong>«{panel.layerName ?? "—"}»</strong> · {panel.subpathCount} {panel.subpathCount === 1 ? "subpath" : "subpaths"} · {panel.nodeCount.toLocaleString("es-AR")}{" "}
            {panel.nodeCount === 1 ? "nodo" : "nodos"} · {selection} {selection === 1 ? "seleccionado" : "seleccionados"}
          </p>
          {panel.activeSubpath && (
            <p className="draw-panel__target">
              Subpath {panel.activeSubpath.index + 1}: {panel.activeSubpath.nodes} {panel.activeSubpath.nodes === 1 ? "nodo" : "nodos"}, {panel.activeSubpath.closed ? "cerrado" : "abierto"}.
            </p>
          )}

          <div className="draw-panel__actions" role="group" aria-label="Navegar entre nodos">
            <button type="button" className="crop-panel__preset" onClick={() => panel.step(-1)} title="Seleccionar el nodo anterior">
              Nodo anterior
            </button>
            <button type="button" className="crop-panel__preset" onClick={() => panel.step(1)} title="Seleccionar el nodo siguiente">
              Nodo siguiente
            </button>
            <button type="button" className="crop-panel__preset" onClick={panel.selectAll} title="Seleccionar todos los nodos del subpath (Ctrl+A)">
              Todo el subpath
            </button>
          </div>

          {selection === 0 ? (
            <p className="draw-panel__hint" role="note">
              Seleccioná un nodo (click) o un segmento para editarlo.
            </p>
          ) : (
            <>
              <div className="object-inspector__grid" role="group" aria-label="Posición de los nodos seleccionados">
                <NumberField label={`X (${unit})`} value={panel.x} onCommit={(value) => panel.commitCoordinate("x", value)} />
                <NumberField label={`Y (${unit})`} value={panel.y} onCommit={(value) => panel.commitCoordinate("y", value)} />
              </div>
              <p className="draw-panel__hint">Relativo al origen del área de trabajo.</p>

              <fieldset className="draw-panel__modes">
                <legend>Tipo de nodo{panel.kind === "mixed" ? " (mixto)" : ""}</legend>
                {KIND_OPTIONS.map((option) => (
                  <label key={option.kind}>
                    <input type="radio" name={`${idPrefix}-kind`} checked={panel.kind === option.kind} onChange={() => panel.setKind(option.kind)} /> {option.label}
                  </label>
                ))}
              </fieldset>

              {single && panel.handles && (
                <div role="group" aria-label="Handles del nodo">
                  {(["in", "out"] as const).map((side) => {
                    const info = panel.handles?.[side] ?? null;
                    const title = side === "in" ? "Handle de entrada" : "Handle de salida";
                    return info ? (
                      <div className="object-inspector__grid" key={side}>
                        <NumberField label={`${title}: largo (${unit})`} value={info.length} onCommit={(value) => panel.commitHandle(side, "length", value)} />
                        <NumberField label={`${title}: ángulo (°)`} value={info.angle} onCommit={(value) => panel.commitHandle(side, "angle", value)} />
                      </div>
                    ) : (
                      <p className="draw-panel__hint" key={side}>
                        {title}: sin handle (segmento recto o extremo del path).
                      </p>
                    );
                  })}
                </div>
              )}

              <div className="draw-panel__actions" role="group" aria-label="Tipo de segmento">
                {single && panel.segments.before && (
                  <button type="button" className="crop-panel__preset" onClick={() => panel.toggleSegment("before")} title="Alternar el segmento que llega al nodo entre recto y curvo">
                    Segmento anterior: {panel.segments.before.curved ? "curvo → recto" : "recto → curvo"}
                  </button>
                )}
                {single && panel.segments.after && (
                  <button type="button" className="crop-panel__preset" onClick={() => panel.toggleSegment("after")} title="Alternar el segmento que sale del nodo entre recto y curvo">
                    Segmento siguiente: {panel.segments.after.curved ? "curvo → recto" : "recto → curvo"}
                  </button>
                )}
                {panel.segments.selected > 0 && (
                  <button type="button" className="crop-panel__preset" onClick={() => panel.toggleSegment("selected")} title="Alternar entre recto y curvo los segmentos entre nodos seleccionados">
                    Alternar {panel.segments.selected} {panel.segments.selected === 1 ? "segmento seleccionado" : "segmentos seleccionados"} (
                    {panel.segments.selectedCurved === panel.segments.selected ? "curvo → recto" : "→ curvo"})
                  </button>
                )}
              </div>
            </>
          )}

          <div className="draw-panel__actions" role="group" aria-label="Acciones del subpath">
            <button type="button" className="crop-panel__preset" disabled={!panel.canClose} title="Cerrar el subpath activo uniendo su último nodo con el primero" onClick={panel.closeActive}>
              Cerrar subpath
            </button>
            <button type="button" className="crop-panel__preset" disabled={!panel.canOpen} title="Abrir el lazo en el nodo seleccionado" onClick={panel.openAtSelected}>
              Abrir en el nodo
            </button>
            <button type="button" className="crop-panel__cancel" disabled={!panel.canDelete} title="Eliminar los nodos seleccionados (Suprimir)" onClick={panel.deleteSelected}>
              Eliminar nodos
            </button>
          </div>

          {panel.confirm && (
            <div className="path-panel__confirm" role="alertdialog" aria-label="Confirmar la eliminación del subpath">
              <p>{panel.confirm.message} Esta acción se puede deshacer con Ctrl+Z.</p>
              <div className="draw-panel__actions">
                <button type="button" className="crop-panel__cancel" onClick={panel.confirmDelete}>
                  Eliminar el subpath
                </button>
                <button type="button" className="crop-panel__preset" onClick={panel.cancelConfirm}>
                  Cancelar
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {panel.error && (
        <p className="upload-panel__error" role="alert">
          {panel.error}
        </p>
      )}

      <div className="draw-panel__actions">
        <button type="button" className="crop-panel__preset" onClick={onExit} title="Salir de la herramienta Path (Enter o Escape)">
          Salir de Path
        </button>
      </div>
    </section>
  );
}
