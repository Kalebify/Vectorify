import type { BooleanShape } from "../../lib/editor/boolean";
import type { EditorObject } from "../../lib/editor/types";
import { documentToScreen, type ViewportParams } from "../../lib/editor/viewport";
import type { AffineMatrix } from "../../lib/svgTransform";

const ACCENT = "#3a5cf5";
const PREVIEW_STROKE = "#1f2a5c";
const COLLAPSE_STROKE = "#d11a2a";
const VEIL = "rgba(255, 255, 255, 0.72)";

/** Un objeto que se desplaza: se atenúa mientras hay preview y, si colapsa, se marca (no se va a tocar). */
export interface OffsetOverlayObject {
  object: EditorObject;
  collapsed: boolean;
}

/** Pieza del resultado con el color de la capa en la que va a caer (o `null` si todavía no se sabe: tono neutro, el color no se decide por el usuario). */
export interface OffsetOverlayShape extends BooleanShape {
  color: string | null;
}

export interface OffsetOverlayProps {
  viewport: ViewportParams;
  objects: readonly OffsetOverlayObject[];
  /** Resultado a previsualizar (vacío mientras se calcula o si no hay). */
  shapes: readonly OffsetOverlayShape[];
}

function matrixAttribute(matrix: AffineMatrix): string {
  return `matrix(${matrix.a} ${matrix.b} ${matrix.c} ${matrix.d} ${matrix.e} ${matrix.f})`;
}

/**
 * Overlay de un offset (M3-S09): un velo que ATENÚA los objetos originales mientras hay preview, el RESULTADO calculado por el servidor con el color de su
 * capa destino, y los objetos que COLAPSAN con un contorno rojo discontinuo (no se van a modificar: se ve en el canvas, no solo en el panel). SVG de solo
 * lectura (no captura el puntero) en el espacio del documento con la misma transformación del canvas; no toca el documento ni la pila de undo.
 */
export function OffsetOverlay({ viewport, objects, shapes }: OffsetOverlayProps) {
  const origin = documentToScreen({ x: 0, y: 0 }, viewport);
  const showVeil = shapes.length > 0;

  return (
    <svg className="boolean-overlay" data-testid="offset-overlay" width={viewport.containerWidth} height={viewport.containerHeight} aria-hidden="true" focusable="false">
      <g transform={`translate(${origin.x} ${origin.y}) scale(${viewport.scale})`}>
        {showVeil &&
          objects.map(({ object }) => <path key={object.id} data-testid="offset-veil" d={object.d} transform={matrixAttribute(object.matrix)} fill={VEIL} stroke="none" />)}
        <g data-testid="offset-preview">
          {shapes.map((shape, index) => (
            <path
              key={index}
              d={shape.d}
              transform={matrixAttribute(shape.matrix)}
              fill={shape.color ?? ACCENT}
              fillOpacity={shape.color ? 0.9 : 0.35}
              fillRule="evenodd"
              stroke={PREVIEW_STROKE}
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </g>
        {objects
          .filter(({ collapsed }) => collapsed)
          .map(({ object }) => (
            <path
              key={object.id}
              data-testid="offset-collapsed"
              d={object.d}
              transform={matrixAttribute(object.matrix)}
              fill="none"
              stroke={COLLAPSE_STROKE}
              strokeWidth={2}
              strokeDasharray="6 4"
              vectorEffect="non-scaling-stroke"
            />
          ))}
      </g>
    </svg>
  );
}
