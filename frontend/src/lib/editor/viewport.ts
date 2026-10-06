import type { Point } from "./types";

/**
 * Conversión espacio de PANTALLA <-> espacio de DOCUMENTO (ADR D1). Es la
 * inversa exacta de la transformación que `VectorCanvas` aplica a su Layer de
 * Konva (`offset = tamaño/2`, `x = ancho/2 + pan`, `scale`) -- el mismo álgebra
 * que `PreviewNavigator` usa para su rectángulo de viewport. Ninguna operación
 * del editor guarda coordenadas de pantalla: se convierten acá y se descartan.
 */
export interface ViewportParams {
  /** Tamaño medido del contenedor del canvas (px de pantalla). */
  containerWidth: number;
  containerHeight: number;
  panX: number;
  panY: number;
  scale: number;
  /** Tamaño del documento (su marco de trabajo) en unidades de viewBox. */
  sourceWidth: number;
  sourceHeight: number;
  /** Origen del marco de trabajo en unidades de documento (M3-S02: tras rotar/recortar ya no es (0,0)). Por defecto 0. */
  originX?: number;
  originY?: number;
}

/** `point` está en px relativos a la esquina arriba-izquierda del contenedor. */
export function screenToDocument(point: Point, viewport: ViewportParams): Point {
  const centerX = (viewport.originX ?? 0) + viewport.sourceWidth / 2;
  const centerY = (viewport.originY ?? 0) + viewport.sourceHeight / 2;
  return {
    x: (point.x - (viewport.containerWidth / 2 + viewport.panX)) / viewport.scale + centerX,
    y: (point.y - (viewport.containerHeight / 2 + viewport.panY)) / viewport.scale + centerY,
  };
}

export function documentToScreen(point: Point, viewport: ViewportParams): Point {
  const centerX = (viewport.originX ?? 0) + viewport.sourceWidth / 2;
  const centerY = (viewport.originY ?? 0) + viewport.sourceHeight / 2;
  return {
    x: (point.x - centerX) * viewport.scale + viewport.containerWidth / 2 + viewport.panX,
    y: (point.y - centerY) * viewport.scale + viewport.containerHeight / 2 + viewport.panY,
  };
}
