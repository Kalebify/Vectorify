import { applyMatrix } from "./transform";
import { objectBounds, unionRects } from "./objects";
import { isIdentityOrientation, orientationAboutMatrix, swapsAxes, type Orientation } from "./orientation";
import { mmPerUnit as mmPerUnitOf } from "./units";
import type { DocumentFrame, EditableDocument, EditorObject, EditProduction, Point, Rect } from "./types";

/**
 * Área de trabajo del documento (MVP3-S02, `DocumentFrame`): helpers puros de Crop y de Rotate/Flip del documento
 * completo. Decisión de dominio (spec M3-S02): Crop modifica el MARCO del documento vectorial -- nunca el raster fuente
 * ni los assets originales -- y CONSERVA la escala física (`mmPerUnit` no cambia: recortar de 200×100 mm a 100×100 mm
 * deja los objetos en su tamaño real). Los objetos que cruzan el borde se conservan completos: el recorte geométrico
 * exacto es la booleana Intersect de M3-S08.
 */

/** Lado mínimo de un marco (unidades de documento): por debajo no hay área de trabajo utilizable. */
export const MIN_FRAME_SIZE = 0.01;
/** Tope de coordenadas/tamaño de un marco (unidades de documento): evita marcos absurdos que rompan viewBox y render. */
export const MAX_FRAME_EXTENT = 1_000_000;
/** Tolerancia al clasificar un objeto contra el marco: el ruido de punto flotante en el borde (1e-14 tras rotar) no cambia su clase. */
export const FRAME_TOLERANCE = 1e-6;

export function sourceFrameOf(width: number, height: number): DocumentFrame {
  return { x: 0, y: 0, width, height };
}

export function frameCenter(frame: DocumentFrame): Point {
  return { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
}

export function framesEqual(left: DocumentFrame, right: DocumentFrame): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}

/** Mensaje de por qué el marco no sirve, o `null` si es válido (finito, con área y dentro de límites razonables). */
export function validateFrame(frame: DocumentFrame): string | null {
  const values = [frame.x, frame.y, frame.width, frame.height];
  if (!values.every((value) => Number.isFinite(value))) return "El área de recorte tiene valores que no son números.";
  if (frame.width <= 0 || frame.height <= 0) return "El ancho y el alto del área de recorte deben ser mayores que 0.";
  if (frame.width < MIN_FRAME_SIZE || frame.height < MIN_FRAME_SIZE) return `El área de recorte es demasiado pequeña (mínimo ${MIN_FRAME_SIZE.toLocaleString("es-AR")} unidades por lado).`;
  if (values.some((value) => Math.abs(value) > MAX_FRAME_EXTENT)) return `El área de recorte excede el límite razonable (±${MAX_FRAME_EXTENT.toLocaleString("es-AR")} unidades).`;
  return null;
}

export function isValidFrame(frame: DocumentFrame): boolean {
  return validateFrame(frame) === null;
}

export type FrameResult = { ok: true; frame: DocumentFrame } | { ok: false; error: string };

/**
 * Valida el área de recorte pedida. Puede salir del marco actual (agranda el área de trabajo) siempre que sea razonable;
 * un destino igual al vigente devuelve el MISMO marco (referencia idéntica: no es un cambio).
 */
export function cropFrame(current: DocumentFrame, target: DocumentFrame): FrameResult {
  const error = validateFrame(target);
  if (error) return { ok: false, error };
  return { ok: true, frame: framesEqual(current, target) ? current : { x: target.x, y: target.y, width: target.width, height: target.height } };
}

/**
 * Gira el marco `turns` cuartos de vuelta horarios (negativo = antihorario) alrededor de SU centro: con un número impar de
 * cuartos intercambia ancho/alto y reubica el origen (`x' = x + (w-h)/2`, `y' = y + (h-w)/2`); con uno par el marco no
 * cambia y se devuelve el MISMO objeto -- `turns = 4` es la identidad exacta, sin residuo.
 */
export function rotateFrame90(frame: DocumentFrame, turns: number): DocumentFrame {
  if (!Number.isInteger(turns)) return frame;
  const quarter = ((turns % 4) + 4) % 4;
  if (quarter % 2 === 0) return frame;
  return { x: frame.x + (frame.width - frame.height) / 2, y: frame.y + (frame.height - frame.width) / 2, width: frame.height, height: frame.width };
}

/** El marco tras aplicar una orientación al documento completo: gira (alrededor de su centro) si la orientación intercambia ejes; reflejar lo deja igual. */
export function orientFrame(frame: DocumentFrame, orientation: Orientation): DocumentFrame {
  return swapsAxes(orientation) ? rotateFrame90(frame, 1) : frame;
}

// ---- mm / serialización ----

export function frameSizeMm(frame: DocumentFrame, factor: number | null): { widthMm: number; heightMm: number } | null {
  return factor === null ? null : { widthMm: frame.width * factor, heightMm: frame.height * factor };
}

/** `viewBox` SVG ("x y w h") del marco: los números salen con su representación más corta que vuelve idéntica (round-trip exacto). */
export function frameToViewBox(frame: DocumentFrame): string {
  return `${frame.x} ${frame.y} ${frame.width} ${frame.height}`;
}

export function viewBoxToFrame(viewBox: string | null | undefined): DocumentFrame | null {
  if (!viewBox) return null;
  const parts = viewBox.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || !parts.every((part) => Number.isFinite(part))) return null;
  const [x, y, width, height] = parts;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

export interface SerializedFrame {
  viewBox: string;
  /** Tamaño físico del marco, o `null` si el documento no tiene escala física conocida. */
  widthMm: number | null;
  heightMm: number | null;
}

/** Forma persistible del marco (la usará M3-S13): `viewBox` en unidades de documento + tamaño en mm. */
export function serializeFrame(frame: DocumentFrame, factor: number | null): SerializedFrame {
  const size = frameSizeMm(frame, factor);
  return { viewBox: frameToViewBox(frame), widthMm: size?.widthMm ?? null, heightMm: size?.heightMm ?? null };
}

/** Inversa de `serializeFrame`: el marco y la escala (mm por unidad) que implican `viewBox` + `widthMm`. `null` si el `viewBox` no es válido. */
export function deserializeFrame(data: SerializedFrame): { frame: DocumentFrame; mmPerUnit: number | null } | null {
  const frame = viewBoxToFrame(data.viewBox);
  if (!frame) return null;
  return { frame, mmPerUnit: mmPerUnitOf(data.widthMm, frame.width) };
}

// ---- Clasificación de objetos contra el marco ----

export interface FrameClassification {
  /** Totalmente dentro del marco (con tolerancia). */
  inside: EditorObject[];
  /** Sin área en común con el marco (separados o apenas tocando el borde desde afuera). */
  outside: EditorObject[];
  /** Cruzan el borde: parte adentro, parte afuera. */
  crossing: EditorObject[];
}

type AxisRelation = "inside" | "overlap" | "apart";

function axisRelation(min: number, max: number, frameMin: number, frameMax: number, tolerance: number): AxisRelation {
  if (min >= frameMin - tolerance && max <= frameMax + tolerance) return "inside";
  // Un objeto sin extensión en este eje (una línea) que no está adentro no tiene nada en común con el marco.
  if (max - min <= tolerance) return "apart";
  return Math.min(max, frameMax) - Math.max(min, frameMin) > tolerance ? "overlap" : "apart";
}

/**
 * Clasifica por bbox EXACTO (curvas incluidas, matriz aplicada): `inside` / `outside` / `crossing`. Un objeto que solo toca el
 * borde desde afuera es `outside` (no comparte área); uno sin geometría dibujable se considera `inside` (nunca se elimina).
 */
export function objectsRelativeToFrame(objects: readonly EditorObject[], frame: DocumentFrame, tolerance = FRAME_TOLERANCE): FrameClassification {
  const result: FrameClassification = { inside: [], outside: [], crossing: [] };
  for (const object of objects) {
    const box = objectBounds(object);
    if (!box) {
      result.inside.push(object);
      continue;
    }
    const horizontal = axisRelation(box.x, box.x + box.width, frame.x, frame.x + frame.width, tolerance);
    const vertical = axisRelation(box.y, box.y + box.height, frame.y, frame.y + frame.height, tolerance);
    if (horizontal === "apart" || vertical === "apart") result.outside.push(object);
    else if (horizontal === "inside" && vertical === "inside") result.inside.push(object);
    else result.crossing.push(object);
  }
  return result;
}

/** Marco que abraza exactamente el contenido (bbox unión) más `padding`, o `null` si no hay geometría o el resultado no es un marco válido (p. ej. una sola línea). */
export function fitToContent(objects: readonly EditorObject[], padding = 0): DocumentFrame | null {
  const rects: Rect[] = [];
  for (const object of objects) {
    const box = objectBounds(object);
    if (box) rects.push(box);
  }
  const union = unionRects(rects);
  if (!union) return null;
  const frame = { x: union.x - padding, y: union.y - padding, width: union.width + 2 * padding, height: union.height + 2 * padding };
  return isValidFrame(frame) ? frame : null;
}

/** El rectángulo de proporción `ratio` (ancho/alto) más grande que cabe CENTRADO dentro de `frame` (presets 1:1, 4:3, 16:9). */
export function frameWithAspect(frame: DocumentFrame, ratio: number): DocumentFrame {
  if (!Number.isFinite(ratio) || ratio <= 0) return frame;
  const wide = frame.width / frame.height > ratio;
  const width = wide ? frame.height * ratio : frame.width;
  const height = wide ? frame.height : frame.width / ratio;
  return { x: frame.x + (frame.width - width) / 2, y: frame.y + (frame.height - height) / 2, width, height };
}

/** Cuatro rectángulos que cubren `outer` salvo el hueco `hole` (el "exterior atenuado" del marco de recorte). Sin áreas vacías. */
export function dimRects(outer: Rect, hole: Rect): Rect[] {
  const outerRight = outer.x + outer.width;
  const outerBottom = outer.y + outer.height;
  const holeLeft = Math.min(Math.max(hole.x, outer.x), outerRight);
  const holeRight = Math.min(Math.max(hole.x + hole.width, outer.x), outerRight);
  const holeTop = Math.min(Math.max(hole.y, outer.y), outerBottom);
  const holeBottom = Math.min(Math.max(hole.y + hole.height, outer.y), outerBottom);
  const rects: Rect[] = [
    { x: outer.x, y: outer.y, width: outer.width, height: holeTop - outer.y },
    { x: outer.x, y: holeBottom, width: outer.width, height: outerBottom - holeBottom },
    { x: outer.x, y: holeTop, width: holeLeft - outer.x, height: holeBottom - holeTop },
    { x: holeRight, y: holeTop, width: outerRight - holeRight, height: holeBottom - holeTop },
  ];
  return rects.filter((rect) => rect.width > 0 && rect.height > 0);
}

// ---- Resumen "Qué se va a modificar" de Crop ----

export interface CropSummary {
  total: number;
  inside: number;
  crossing: number;
  /** Totalmente fuera del nuevo marco (de cualquier capa). */
  outside: number;
  /** Fuera y en una capa BLOQUEADA: nunca se eliminan. */
  lockedOutside: number;
  /** Fuera y en una capa OCULTA (no bloqueada): tampoco se eliminan (se respetan igual que en S01). */
  hiddenOutside: number;
  /** Los que realmente se eliminarán: fuera, en capas editables y visibles, y solo si la opción está marcada. */
  removable: number;
}

export function summarizeCrop(
  objectsByLayer: Record<string, EditorObject[]>,
  target: DocumentFrame,
  protection: { lockedLayerIds: ReadonlySet<string>; hiddenLayerIds: ReadonlySet<string> },
  removeOutside: boolean,
): CropSummary {
  const all = Object.values(objectsByLayer).flat();
  const { inside, outside, crossing } = objectsRelativeToFrame(all, target);
  const lockedOutside = outside.filter((object) => protection.lockedLayerIds.has(object.layerGroupId)).length;
  const hiddenOutside = outside.filter((object) => !protection.lockedLayerIds.has(object.layerGroupId) && protection.hiddenLayerIds.has(object.layerGroupId)).length;
  return {
    total: all.length,
    inside: inside.length,
    crossing: crossing.length,
    outside: outside.length,
    lockedOutside,
    hiddenOutside,
    removable: removeOutside ? outside.length - lockedOutside - hiddenOutside : 0,
  };
}

// ---- Producciones de comando (un solo comando: objetos + marco) ----

/**
 * Crop como UN comando: el marco pasa a `target` y, con `removeOutside`, se eliminan los objetos totalmente fuera. Los que
 * cruzan el borde NO se tocan. `null` si el destino es inválido o no cambia nada. El filtro de bloqueo/visibilidad lo aplica
 * `applyEdit` capa por capa (las capas bloqueadas conservan sus objetos; el marco cambia igual).
 */
export function cropProduction(state: EditableDocument, target: DocumentFrame, removeOutside: boolean): EditProduction | null {
  const current = state.frame;
  if (!current || !isValidFrame(target)) return null;

  const layers: Record<string, EditorObject[]> = {};
  if (removeOutside) {
    const { outside } = objectsRelativeToFrame(Object.values(state.objectsByLayer).flat(), target);
    if (outside.length > 0) {
      const outsideIds = new Set(outside.map((object) => object.id));
      for (const [layerId, objects] of Object.entries(state.objectsByLayer)) {
        if (objects.some((object) => outsideIds.has(object.id))) layers[layerId] = objects.filter((object) => !outsideIds.has(object.id));
      }
    }
  }

  const frameChanged = !framesEqual(current, target);
  if (!frameChanged && Object.keys(layers).length === 0) return null;
  return frameChanged ? { layers, frame: target } : { layers };
}

/**
 * Rotar/reflejar el DOCUMENTO COMPLETO como UN comando: todos los objetos de todas las capas + el marco, alrededor del
 * centro del marco (los objetos y la hoja giran juntos). `documentWide`: ver `EditProduction`.
 */
export function orientDocumentProduction(state: EditableDocument, orientation: Orientation): EditProduction | null {
  const frame = state.frame;
  if (!frame || !isValidFrame(frame) || isIdentityOrientation(orientation)) return null;

  const matrix = orientationAboutMatrix(frameCenter(frame), orientation);
  const layers: Record<string, EditorObject[]> = {};
  for (const [layerId, objects] of Object.entries(state.objectsByLayer)) {
    if (objects.length > 0) layers[layerId] = applyMatrix(objects, matrix);
  }
  return { layers, frame: orientFrame(frame, orientation), documentWide: true };
}
