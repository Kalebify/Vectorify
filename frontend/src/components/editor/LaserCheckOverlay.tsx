import type { LaserCheckHighlight, LaserCheckSeverity } from "../../lib/editor/laserCheck";
import type { Rect } from "../../lib/editor/types";
import { documentToScreen, type ViewportParams } from "../../lib/editor/viewport";

const COLORS: Record<LaserCheckSeverity, string> = { error: "#dc2626", warning: "#d97706" };

export interface LaserCheckOverlayIssue {
  id: string;
  severity: LaserCheckSeverity;
  highlights: readonly LaserCheckHighlight[];
  rect: Rect | null;
}

export interface LaserCheckOverlayProps {
  viewport: ViewportParams;
  issues: readonly LaserCheckOverlayIssue[];
  /** Issue activado en la lista: se resalta más fuerte y con su rectángulo. */
  selectedId: string | null;
}

function matrixAttribute({ a, b, c, d, e, f }: LaserCheckHighlight["matrix"]): string | undefined {
  return a === 1 && b === 0 && c === 0 && d === 1 && e === 0 && f === 0 ? undefined : `matrix(${a} ${b} ${c} ${d} ${e} ${f})`;
}

/**
 * Overlay del Laser Checker (M3-S14): la geometría de cada issue resaltada (rojo = bloqueante, naranja = aviso) y, para el issue activado en la lista, más gruesa y
 * con el rectángulo que enmarca lo que la vista centró. Los issues de capa completa (sin geometría propia) solo dibujan su rectángulo. SVG de solo lectura (no
 * captura el puntero) en el espacio del documento con la misma transformación del canvas, como `FloatingOverlay`; no toca el documento ni la pila de undo.
 */
export function LaserCheckOverlay({ viewport, issues, selectedId }: LaserCheckOverlayProps) {
  const origin = documentToScreen({ x: 0, y: 0 }, viewport);
  // El activado se dibuja al final para quedar encima.
  const ordered = [...issues.filter((issue) => issue.id !== selectedId), ...issues.filter((issue) => issue.id === selectedId)];

  return (
    <svg className="boolean-overlay laser-check-overlay" data-testid="laser-check-overlay" width={viewport.containerWidth} height={viewport.containerHeight} aria-hidden="true" focusable="false">
      <g transform={`translate(${origin.x} ${origin.y}) scale(${viewport.scale})`}>
        {ordered.map((issue) => {
          const selected = issue.id === selectedId;
          const color = COLORS[issue.severity];
          return (
            <g key={issue.id} data-testid="laser-check-issue" data-issue={issue.id} data-severity={issue.severity} data-selected={selected ? "true" : "false"}>
              {issue.highlights.map((highlight, index) => (
                <path
                  key={index}
                  data-testid="laser-check-highlight"
                  d={highlight.d}
                  transform={matrixAttribute(highlight.matrix)}
                  fill={highlight.filled ? color : "none"}
                  fillOpacity={selected ? 0.4 : 0.2}
                  fillRule="evenodd"
                  stroke={color}
                  strokeWidth={selected ? 3 : 1.5}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              {issue.rect && (selected || issue.highlights.length === 0) && (
                <rect
                  data-testid="laser-check-rect"
                  x={issue.rect.x}
                  y={issue.rect.y}
                  width={issue.rect.width}
                  height={issue.rect.height}
                  fill="none"
                  stroke={color}
                  strokeWidth={selected ? 2 : 1}
                  strokeDasharray="6 4"
                  vectorEffect="non-scaling-stroke"
                />
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );
}
