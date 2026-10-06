import type { AffineMatrix } from "../svgTransform";

/**
 * Tipos base del editor de MVP 3 (ver `docs/ADR_EDITOR_MVP3.md`, D1/D2). Todo
 * `lib/editor/*` es lógica pura (sin React ni Konva): estas formas son las que
 * reusan S02-S16 (crop, nodos Bézier, booleanas, copy/paste, historial...).
 */

export interface Point {
  x: number;
  y: number;
}

/** Rectángulo en espacio de DOCUMENTO (unidades del viewBox), con origen arriba-izquierda (eje Y hacia abajo, como SVG). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Objeto editable = un `<path>` de una capa (ADR D1). Inmutable: toda
 * operación devuelve un objeto nuevo y deja el anterior intacto (los
 * comandos guardan snapshots por referencia, no copias profundas).
 */
export interface EditorObject {
  /** Estable y único en el documento: `data-vid` del SVG de origen o un UUID generado al cargar. */
  id: string;
  /** Capa (groupId del VectorDocument) dueña del objeto -- nunca cambia salvo un comando explícito de "mover a capa". */
  layerGroupId: string;
  /** Path data ORIGINAL: fuente de verdad geométrica, no se reescribe para move/scale/rotate (solo al hornear la matriz). */
  d: string;
  fill: string;
  /** Transform acumulado (documento): propio + ancestros `<g>` del SVG de origen + cualquier edición posterior. */
  matrix: AffineMatrix;
}

/** Estado editable en memoria (ADR D2): objetos por capa en orden de pintado (el último queda arriba). */
export interface EditableDocument {
  objectsByLayer: Record<string, EditorObject[]>;
}

/** Resultado de un productor de edición: SOLO las capas tocadas, con su lista completa de objetos ya modificada. */
export interface EditProduction {
  layers: Record<string, EditorObject[]>;
}

/** Cambio de UNA capa dentro de un comando (snapshots inmutables por referencia). */
export interface EditorLayerChange {
  before: EditorObject[];
  after: EditorObject[];
}

/**
 * Comando de edición (ADR D2): determinista y serializable -- `undo`
 * restaura `before`, `redo` restaura `after` de cada capa tocada.
 */
export interface EditorEdit {
  label: string;
  touched: Record<string, EditorLayerChange>;
}
