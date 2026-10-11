import { CUT_PIECE_COLORS, type CutObjectStatus, type CutPiece } from "../../lib/editor/cut";
import type { EditorObject, Point } from "../../lib/editor/types";
import { documentToScreen, type ViewportParams } from "../../lib/editor/viewport";
import type { AffineMatrix } from "../../lib/svgTransform";

const CUT_COLOR = "#c2410c";
const INTACT_STROKE = "#b26a00";
const VEIL = "rgba(255, 255, 255, 0.72)";
/** Un objeto del alcance: si se corta se atenúa; si el corte lo toca sin atravesarlo se marca (queda intacto); `pending` = el servidor todavía no contestó. */
export interface CutOverlayObject {
  object: EditorObject;
  status: CutObjectStatus | "pending";
}

export interface CutOverlayProps {
  viewport: ViewportParams;
  objects: readonly CutOverlayObject[];
  /** Piezas del resultado (vacío mientras se calcula o si no hay), con el índice de la pieza dentro de su objeto (decide el color). */
  shapes: ReadonlyArray<CutPiece & { index: number }>;
  /** Tramos que «Extender» agrega a la línea dibujada (se muestran punteados); vacío sin extender. */
  extension: ReadonlyArray<readonly [Point, Point]>;
}

function matrixAttribute(matrix: AffineMatrix): string {
  return `matrix(${matrix.a} ${matrix.b} ${matrix.c} ${matrix.d} ${matrix.e} ${matrix.f})`;
}

/**
 * Overlay de un corte (M3-S10): un velo que ATENÚA los objetos que se van a cortar, las PIEZAS del resultado calculadas por el servidor, cada una de un color
 * distinguible (para ver cuántas salen y dónde), los objetos que el corte toca sin atravesar con un contorno ámbar discontinuo (quedan intactos: se ve en el
 * canvas, no solo en el panel) y la prolongación de «Extender» punteada. SVG de solo lectura (no captura el puntero) en el espacio del documento con la misma
 * transformación del canvas; no toca el documento ni la pila de undo.
 */
export function CutOverlay({ viewport, objects, shapes, extension }: CutOverlayProps) {
  const origin = documentToScreen({ x: 0, y: 0 }, viewport);

  return (
    <svg className="boolean-overlay" data-testid="cut-overlay" width={viewport.containerWidth} height={viewport.containerHeight} aria-hidden="true" focusable="false">
      <g transform={`translate(${origin.x} ${origin.y}) scale(${viewport.scale})`}>
        {objects
          .filter(({ status }) => status === "cut")
          .map(({ object }) => (
            <path key={object.id} data-testid="cut-veil" d={object.d} transform={matrixAttribute(object.matrix)} fill={VEIL} stroke="none" />
          ))}
        <g data-testid="cut-pieces">
          {shapes.map((shape, position) => {
            const color = CUT_PIECE_COLORS[shape.index % CUT_PIECE_COLORS.length];
            return (
              <path
                key={position}
                data-piece={shape.index}
                d={shape.d}
                transform={matrixAttribute(shape.matrix)}
                fill={shape.line ? "none" : color}
                fillOpacity={shape.line ? undefined : 0.55}
                fillRule="evenodd"
                stroke={color}
                strokeWidth={shape.line ? 3 : 1.5}
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
        </g>
        {objects
          .filter(({ status }) => status === "intact")
          .map(({ object }) => (
            <path
              key={object.id}
              data-testid="cut-intact"
              d={object.d}
              transform={matrixAttribute(object.matrix)}
              fill="none"
              stroke={INTACT_STROKE}
              strokeWidth={2}
              strokeDasharray="6 4"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        {extension.map(([from, to], index) => (
          <line
            key={index}
            data-testid="cut-extension"
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
            stroke={CUT_COLOR}
            strokeWidth={1.5}
            strokeDasharray="5 4"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </g>
    </svg>
  );
}
