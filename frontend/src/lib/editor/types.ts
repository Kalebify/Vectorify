import type { ManufacturingOperationValue } from "../../types/manufacturingOperations";
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
 * Área de trabajo del documento (M3-S02): origen + tamaño en unidades de documento (las del `viewBox`). Es la
 * "hoja" sobre la que se trabaja y se exporta: Crop la recorta, Rotate 90° del documento le intercambia
 * ancho/alto. Su equivalente en mm es `width * mmPerUnit` (`lib/editor/units.ts`): la escala física NO cambia con el
 * marco. Inmutable, igual que los objetos.
 */
export interface DocumentFrame {
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
  /** Color de relleno, o `"none"` para un objeto ABIERTO (línea de Draw, M3-S04) que solo tiene trazo. */
  fill: string;
  /**
   * Trazo (M3-S04), opcional: los objetos de S01-S03 no lo traen y se comportan igual. Una línea abierta de Draw lleva `fill: "none"`,
   * `stroke` = el color de su capa y `strokeWidth` en UNIDADES DE DOCUMENTO del espacio del propio objeto (el mismo que `d`: la matriz
   * lo escala, como en SVG).
   */
  stroke?: string;
  strokeWidth?: number;
  /** Transform acumulado (documento): propio + ancestros `<g>` del SVG de origen + cualquier edición posterior. */
  matrix: AffineMatrix;
}

/**
 * Estructura de UNA capa dentro del estado editable (M3-S03). En este documento una capa = un color de paleta (relación 1:1) y su
 * IDENTIDAD es `groupId`, nunca `colorHex`: dos capas pueden tener el mismo hex sin ser el mismo color. `isNew` marca las capas
 * creadas en el cliente (p. ej. Fill con un color nuevo): todavía no existen en el servidor (se persisten con M3-S13), así que sus
 * cambios de metadata (nombre, visibilidad, bloqueo, orden, operación) NO viajan por PATCH.
 */
export interface EditableLayerMeta {
  groupId: string;
  name: string;
  colorHex: string;
  order: number;
  visible: boolean;
  locked: boolean;
  manufacturingOperation: ManufacturingOperationValue;
  isNew: boolean;
}

/** Estado editable en memoria (ADR D2): objetos por capa en orden de pintado (el último queda arriba). */
export interface EditableDocument {
  objectsByLayer: Record<string, EditorObject[]>;
  /** Área de trabajo vigente (M3-S02). Opcional por compatibilidad: los productores de S01 no la usan. */
  frame?: DocumentFrame;
  /** Estructura EFECTIVA de capas (M3-S03: servidor + overrides del editor), por orden de pintado. Opcional: los productores de S01/S02 no la usan. */
  layers?: EditableLayerMeta[];
}

/** Resultado de un productor de edición: SOLO las capas tocadas, con su lista completa de objetos ya modificada. */
export interface EditProduction {
  layers: Record<string, EditorObject[]>;
  /** Nuevo marco del documento (M3-S02): objetos + marco viajan en UN comando. Un marco igual al vigente no cuenta como cambio. */
  frame?: DocumentFrame;
  /**
   * Operación sobre el DOCUMENTO COMPLETO (M3-S02: rotar/reflejar todo): las capas ocultas se transforman igual (ocultar es un
   * estado de vista, no puede dejar una capa descolocada respecto del marco) y, si alguna capa tocada está BLOQUEADA, se rechaza
   * la edición entera -- nunca se transforma a medias.
   */
  documentWide?: boolean;
  /**
   * Estructura de capas tras el comando (M3-S03): SOLO las capas tocadas, con su meta completa (crear una capa = incluirla acá;
   * recolorear una capa = su meta con otro `colorHex` y el MISMO `groupId`). Objetos + estructura viajan en UN comando.
   */
  layerMetas?: EditableLayerMeta[];
  /**
   * Todo o nada (M3-S03): si el filtro de bloqueo/visibilidad omite ALGUNA capa tocada se rechaza la producción entera. Los comandos
   * que mueven objetos entre capas lo necesitan: aplicar solo la mitad (quitar de la capa origen sin agregar en la destino, o al
   * revés) perdería o duplicaría objetos.
   */
  atomic?: boolean;
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
  /** Cambio de marco (M3-S02), opcional: los comandos de S01 no lo traen y se comportan igual. Atómico con `touched`: un solo undo/redo. */
  frame?: { before: DocumentFrame; after: DocumentFrame };
  /**
   * Cambio de estructura de capas (M3-S03), opcional como `frame`: las capas TOCADAS antes/después. Una capa creada por el comando está en
   * `after` y NO en `before` (undo la elimina); una recoloreada está en ambas con el mismo `groupId`. Atómico con `touched`.
   */
  layers?: { before: EditableLayerMeta[]; after: EditableLayerMeta[] };
}
