import { useCallback, useState } from "react";
import type { DocumentFrame, Rect } from "../lib/editor/types";
import { focusTransform } from "../lib/editor/viewport";

/**
 * Transformación puramente presentacional aplicada a un VectorCanvas
 * (spec.md M1-S06, Definition of Done: "la visualización no modifica el
 * SVG"): nunca toca el contenido del SVG/imagen subyacente, solo un
 * `transform` CSS. `scale` es un factor absoluto (1 = tamaño natural en
 * píxeles del recurso, independiente del tamaño del contenedor); `panX`/
 * `panY` son desplazamiento en píxeles de pantalla, sin escalar por `scale`
 * (se aplican como `translate(...)` DESPUÉS de `scale(...)` en la cadena de
 * `transform` de VectorCanvas, lo que en CSS significa que se calculan en el
 * mismo espacio de píxeles del contenedor sin importar el zoom vigente).
 */
export interface CanvasTransform {
  scale: number;
  panX: number;
  panY: number;
}

export const IDENTITY_TRANSFORM: CanvasTransform = { scale: 1, panX: 0, panY: 0 };

export interface ContainerSize {
  width: number;
  height: number;
}

export interface IntrinsicSize {
  width: number;
  height: number;
}

const DEFAULT_MIN_SCALE = 0.1;
const DEFAULT_MAX_SCALE = 8;

export interface UseCanvasTransformOptions {
  minScale?: number;
  maxScale?: number;
}

export interface UseCanvasTransformResult {
  transform: CanvasTransform;
  minScale: number;
  maxScale: number;
  /**
   * Multiplica el zoom actual por `factor` (>1 acerca, <1 aleja), manteniendo
   * fijo el punto `anchor` (offset en px de pantalla respecto del centro del
   * contenedor) bajo el cursor. Sin `anchor`, zoomea sobre el centro.
   */
  zoomBy: (factor: number, anchor?: { x: number; y: number }) => void;
  /** Desplaza el pan por (dx, dy) px de pantalla. */
  panBy: (dx: number, dy: number) => void;
  /** Vuelve a escala 1:1 (tamaño natural del recurso) sin desplazamiento. */
  reset: () => void;
  /**
   * Ajusta la escala para que `intrinsic` (tamaño natural del recurso) quepa
   * completo dentro de `container` (tamaño del contenedor en pantalla), sin
   * desplazamiento. Si falta alguna dimensión (recurso todavía sin cargar,
   * contenedor sin medir todavía) no hace nada -- evita dividir por cero o
   * fijar una escala sin sentido antes de tener datos reales.
   */
  fitToScreen: (container: ContainerSize, intrinsic: IntrinsicSize) => void;
  /**
   * Centra `target` (rectángulo del DOCUMENTO) en `container` con un zoom razonable (ver `focusTransform`): lo usa el editor al seleccionar una pieza flotante de
   * la lista de issues. Sin contenedor medido o con un rectángulo no finito no hace nada.
   */
  centerOn: (target: Rect, container: ContainerSize, frame: DocumentFrame) => void;
}

/**
 * Estado de zoom/pan compartido por un par de VectorCanvas (original +
 * vector) en VectorComparison: una sola instancia de este hook para ambos
 * paneles garantiza que comparten *exactamente* el mismo factor de escala y
 * desplazamiento -- la "misma escala de referencia" pedida por la
 * Definition of Done de spec.md M1-S06, sin necesidad de sincronizar dos
 * estados independientes.
 */
export function useCanvasTransform(options?: UseCanvasTransformOptions): UseCanvasTransformResult {
  const minScale = options?.minScale ?? DEFAULT_MIN_SCALE;
  const maxScale = options?.maxScale ?? DEFAULT_MAX_SCALE;
  const [transform, setTransform] = useState<CanvasTransform>(IDENTITY_TRANSFORM);

  const clampScale = useCallback(
    (scale: number) => Math.min(maxScale, Math.max(minScale, scale)),
    [minScale, maxScale],
  );

  const zoomBy = useCallback(
    (factor: number, anchor?: { x: number; y: number }) => {
      if (!Number.isFinite(factor) || factor <= 0) {
        return;
      }
      setTransform((prev) => {
        const nextScale = clampScale(prev.scale * factor);
        if (nextScale === prev.scale) {
          return prev;
        }
        if (!anchor) {
          return { ...prev, scale: nextScale };
        }
        // Mantiene fijo el punto bajo el cursor: si el punto de contenido
        // que hoy cae en `anchor` es `(anchor - pan) / scale`, el nuevo pan
        // despeja para que siga cayendo en el mismo `anchor` con la nueva
        // escala.
        const ratio = nextScale / prev.scale;
        return {
          scale: nextScale,
          panX: anchor.x - (anchor.x - prev.panX) * ratio,
          panY: anchor.y - (anchor.y - prev.panY) * ratio,
        };
      });
    },
    [clampScale],
  );

  const panBy = useCallback((dx: number, dy: number) => {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
      return;
    }
    setTransform((prev) => ({ ...prev, panX: prev.panX + dx, panY: prev.panY + dy }));
  }, []);

  const reset = useCallback(() => {
    setTransform(IDENTITY_TRANSFORM);
  }, []);

  const fitToScreen = useCallback(
    (container: ContainerSize, intrinsic: IntrinsicSize) => {
      if (!container.width || !container.height || !intrinsic.width || !intrinsic.height) {
        return;
      }
      const fitScale = Math.min(container.width / intrinsic.width, container.height / intrinsic.height);
      setTransform({ scale: clampScale(fitScale), panX: 0, panY: 0 });
    },
    [clampScale],
  );

  const centerOn = useCallback(
    (target: Rect, container: ContainerSize, frame: DocumentFrame) => {
      const next = focusTransform(target, { container, frame, minScale, maxScale });
      if (next) setTransform(next);
    },
    [minScale, maxScale],
  );

  return { transform, minScale, maxScale, zoomBy, panBy, reset, fitToScreen, centerOn };
}
