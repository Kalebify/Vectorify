import { objectBounds } from "../../lib/editor/objects";
import type { BooleanShape } from "../../lib/editor/boolean";
import type { EditorObject } from "../../lib/editor/types";
import { documentToScreen, type ViewportParams } from "../../lib/editor/viewport";
import type { AffineMatrix } from "../../lib/svgTransform";

const ACCENT = "#3a5cf5";
const PREVIEW_STROKE = "#1f2a5c";
const VEIL = "rgba(255, 255, 255, 0.72)";
const BADGE_RADIUS = 9;

export interface BooleanOverlayOperand {
  letter: string;
  object: EditorObject;
}

export interface BooleanOverlayProps {
  viewport: ViewportParams;
  /** Operandos en orden (A, B, C...): reciben su insignia sobre el canvas. */
  operands: readonly BooleanOverlayOperand[];
  /** Resultado a previsualizar (vacío mientras se calcula o si no hay). */
  shapes: readonly BooleanShape[];
  /** Color del resultado = el de la capa destino; sin destino elegido se usa un tono neutro (el color no se decide por el usuario). */
  color: string | null;
}

function matrixAttribute(matrix: AffineMatrix): string {
  return `matrix(${matrix.a} ${matrix.b} ${matrix.c} ${matrix.d} ${matrix.e} ${matrix.f})`;
}

/**
 * Overlay de una booleana (M3-S08): insignias A/B/C sobre cada operando (en píxeles de pantalla: miden siempre lo mismo), un velo que ATENÚA los operandos
 * mientras hay preview y el RESULTADO calculado por el servidor, dibujado con el color de la capa destino. SVG de solo lectura (no captura el puntero) en
 * el espacio del documento con la misma transformación del canvas; no toca el documento ni la pila de undo.
 */
export function BooleanOverlay({ viewport, operands, shapes, color }: BooleanOverlayProps) {
  const origin = documentToScreen({ x: 0, y: 0 }, viewport);
  const showVeil = shapes.length > 0;

  return (
    <svg className="boolean-overlay" data-testid="boolean-overlay" width={viewport.containerWidth} height={viewport.containerHeight} aria-hidden="true" focusable="false">
      <g transform={`translate(${origin.x} ${origin.y}) scale(${viewport.scale})`}>
        {showVeil &&
          operands.map(({ letter, object }) => (
            <path key={object.id} data-testid={`boolean-veil-${letter}`} d={object.d} transform={matrixAttribute(object.matrix)} fill={VEIL} stroke="none" />
          ))}
        <g data-testid="boolean-preview">
          {shapes.map((shape, index) => (
            <path
              key={index}
              d={shape.d}
              transform={matrixAttribute(shape.matrix)}
              fill={color ?? ACCENT}
              fillOpacity={color ? 0.9 : 0.35}
              fillRule="evenodd"
              stroke={PREVIEW_STROKE}
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </g>
      </g>
      {operands.map(({ letter, object }) => {
        const box = objectBounds(object);
        if (!box) return null;
        const corner = documentToScreen({ x: box.x, y: box.y }, viewport);
        return (
          <g key={object.id} data-testid={`boolean-badge-${letter}`} transform={`translate(${corner.x} ${corner.y})`}>
            <circle r={BADGE_RADIUS} fill={ACCENT} stroke="#ffffff" strokeWidth={1.5} />
            <text textAnchor="middle" dominantBaseline="central" fontSize={letter.length > 1 ? 9 : 11} fontWeight={700} fill="#ffffff">
              {letter}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
