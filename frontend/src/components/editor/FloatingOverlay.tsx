import type { Point, Rect } from "../../lib/editor/types";
import { documentToScreen, type ViewportParams } from "../../lib/editor/viewport";

const ISSUE_COLOR = "#d97706";
const SELECTED_COLOR = "#dc2626";
const VALID_COLOR = "#15803d";
const INVALID_COLOR = "#dc2626";

export interface FloatingOverlayIssue {
  id: number;
  /** 1, 2, 3...: el número de la insignia (el mismo de la lista). */
  position: number;
  /** Path data del polígono en el documento (huecos como subpaths). */
  d: string;
  /** Su bounding box: de ahí sale la posición de la insignia. */
  rect: Rect;
}

export interface FloatingOverlayBridge {
  index: number;
  valid: boolean;
  /** Path data del rectángulo del bridge, o `null` si el servidor no llegó a calcularlo. */
  d: string | null;
  anchor: Point | null;
}

export interface FloatingOverlayProps {
  viewport: ViewportParams;
  issues: readonly FloatingOverlayIssue[];
  /** Pieza seleccionada en la lista: se resalta más fuerte. */
  selectedId: number | null;
  bridges: readonly FloatingOverlayBridge[];
}

/**
 * Overlay de piezas flotantes y bridges (M3-S11): cada pieza flotante resaltada (naranja) con la insignia de su número, la seleccionada de la lista en rojo y más
 * gruesa (el resaltado que acompaña al centrado de la vista), y los bridges propuestos: verde sólido si son válidos, rojo discontinuo si no (se ve en el canvas cuál no
 * conecta, no solo en el panel). SVG de solo lectura (no captura el puntero) en el espacio del documento con la misma transformación del canvas; no toca el documento
 * ni la pila de undo.
 */
export function FloatingOverlay({ viewport, issues, selectedId, bridges }: FloatingOverlayProps) {
  const origin = documentToScreen({ x: 0, y: 0 }, viewport);

  return (
    <svg className="boolean-overlay floating-overlay" data-testid="floating-overlay" width={viewport.containerWidth} height={viewport.containerHeight} aria-hidden="true" focusable="false">
      <g transform={`translate(${origin.x} ${origin.y}) scale(${viewport.scale})`}>
        {issues.map((issue) => {
          const selected = issue.id === selectedId;
          const color = selected ? SELECTED_COLOR : ISSUE_COLOR;
          return (
            <path
              key={issue.id}
              data-testid="floating-issue"
              data-issue={issue.id}
              data-selected={selected ? "true" : "false"}
              d={issue.d}
              fill={color}
              fillOpacity={selected ? 0.5 : 0.3}
              fillRule="evenodd"
              stroke={color}
              strokeWidth={selected ? 3 : 1.5}
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
        {bridges.map((bridge) =>
          bridge.d === null ? null : (
            <path
              key={bridge.index}
              data-testid="floating-bridge"
              data-valid={bridge.valid ? "true" : "false"}
              d={bridge.d}
              fill={bridge.valid ? VALID_COLOR : INVALID_COLOR}
              fillOpacity={0.55}
              stroke={bridge.valid ? VALID_COLOR : INVALID_COLOR}
              strokeWidth={1.5}
              strokeDasharray={bridge.valid ? undefined : "5 3"}
              vectorEffect="non-scaling-stroke"
            />
          ),
        )}
      </g>
      {bridges.map((bridge) => {
        if (!bridge.anchor) return null;
        const at = documentToScreen(bridge.anchor, viewport);
        return <circle key={`anchor-${bridge.index}`} data-testid="floating-anchor" cx={at.x} cy={at.y} r={3.5} fill="#ffffff" stroke={bridge.valid ? VALID_COLOR : INVALID_COLOR} strokeWidth={1.5} />;
      })}
      {issues.map((issue) => {
        const at = documentToScreen({ x: issue.rect.x + issue.rect.width / 2, y: issue.rect.y + issue.rect.height / 2 }, viewport);
        const selected = issue.id === selectedId;
        return (
          <g key={`badge-${issue.id}`} data-testid="floating-badge" data-issue={issue.id}>
            <circle cx={at.x} cy={at.y} r={10} fill={selected ? SELECTED_COLOR : ISSUE_COLOR} stroke="#ffffff" strokeWidth={1.5} />
            <text x={at.x} y={at.y} textAnchor="middle" dominantBaseline="central" fontSize={11} fontWeight={700} fill="#ffffff">
              {issue.position}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
