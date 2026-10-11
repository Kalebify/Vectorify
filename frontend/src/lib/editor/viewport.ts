import type { DocumentFrame, Point, Rect } from "./types";

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

/** Fracción del lado menor del contenedor que ocupa el rectángulo al centrarlo (el resto es contexto alrededor). */
export const FOCUS_FILL = 0.4;
/** Zoom máximo al centrar un rectángulo: una isla diminuta no debe llevar la vista a un zoom extremo e inútil. */
export const FOCUS_MAX_SCALE = 6;

export interface FocusParams {
  /** Tamaño medido del contenedor del canvas (px de pantalla). */
  container: { width: number; height: number };
  /** Área de trabajo vigente: define el centro del documento (la misma referencia que `ViewportParams`). */
  frame: DocumentFrame;
  /** Límites de zoom del canvas. */
  minScale: number;
  maxScale: number;
  fill?: number;
  maxFocusScale?: number;
}

/**
 * Transformación (zoom + pan) que CENTRA un rectángulo del documento en el contenedor con un zoom razonable: el rectángulo ocupa `fill` (40 %) del lado menor del
 * contenedor, sin pasar de `FOCUS_MAX_SCALE` ni de los límites del canvas. Es el álgebra inversa de `documentToScreen`: el centro del rectángulo cae en el centro del
 * contenedor. `null` si no hay contenedor medido o el rectángulo no es finito (no se inventa una vista).
 */
export function focusTransform(target: Rect, params: FocusParams): { scale: number; panX: number; panY: number } | null {
  const { container, frame, minScale, maxScale } = params;
  const values = [target.x, target.y, target.width, target.height, frame.x, frame.y, frame.width, frame.height];
  if (!(container.width > 0) || !(container.height > 0) || !values.every(Number.isFinite) || target.width < 0 || target.height < 0) return null;
  const fill = params.fill ?? FOCUS_FILL;
  const ceiling = Math.min(maxScale, params.maxFocusScale ?? FOCUS_MAX_SCALE);
  // Un rectángulo sin extensión (un punto) toma el techo de zoom.
  const fitX = target.width > 0 ? (container.width * fill) / target.width : Infinity;
  const fitY = target.height > 0 ? (container.height * fill) / target.height : Infinity;
  const scale = Math.min(ceiling, Math.max(minScale, Math.min(fitX, fitY)));
  const centerX = target.x + target.width / 2;
  const centerY = target.y + target.height / 2;
  const frameCenterX = frame.x + frame.width / 2;
  const frameCenterY = frame.y + frame.height / 2;
  return { scale, panX: -(centerX - frameCenterX) * scale, panY: -(centerY - frameCenterY) * scale };
}
