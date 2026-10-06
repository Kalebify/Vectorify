import { composeMatrices, isFiniteMatrix, matricesAlmostEqual, rotationAboutMatrix, scaleAboutMatrix, translationMatrix } from "./matrix";
import { bounds, rectCenter } from "./objects";
import { IDENTITY_MATRIX, type AffineMatrix } from "../svgTransform";
import type { EditorObject, Point, Rect } from "./types";

/**
 * Transformaciones de objetos (MVP3-S01): componen la `matrix` del objeto en
 * espacio de documento y NUNCA tocan `d` (ADR D1: no destructivo y exacto;
 * "hornear" es una operación aparte, `transformPathData`). Cada función es
 * pura e inmutable: devuelve objetos nuevos y deja los originales intactos.
 *
 * Estabilidad numérica ("sin acumular error"): los gestos se recomponen SIEMPRE
 * desde el estado "antes" del gesto + la matriz del gesto (`applyMatrix(before,
 * gesto)`), nunca incrementalmente por frame -- 1000 frames de drag dan el mismo
 * resultado que un único salto, y soltar y volver al origen deja la matriz
 * original bit a bit.
 */

const MIN_SCALE = 1e-9;
const SIZE_EPSILON = 1e-9;

/**
 * Aplica `gesture` (matriz en espacio de documento) DESPUÉS de la matriz de
 * cada objeto: `nueva = gesture × vieja`. Matriz no finita o identidad (dentro
 * de 1e-12) -> devuelve los MISMOS objetos (referencia idéntica): así un gesto
 * nulo no genera un comando vacío.
 */
export function applyMatrix(objects: readonly EditorObject[], gesture: AffineMatrix): EditorObject[] {
  if (!isFiniteMatrix(gesture) || matricesAlmostEqual(gesture, IDENTITY_MATRIX, 1e-12)) return [...objects];
  return objects.map((object) => ({ ...object, matrix: composeMatrices(gesture, object.matrix) }));
}

export function translate(objects: readonly EditorObject[], dx: number, dy: number): EditorObject[] {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return [...objects];
  return applyMatrix(objects, translationMatrix(dx, dy));
}

/** Escala `(sx, sy)` alrededor de `pivot` (negativo = reflejo). Un factor ~0 o no finito se ignora (colapsaría la geometría de forma irreversible). */
export function scaleAbout(objects: readonly EditorObject[], pivot: Point, sx: number, sy: number): EditorObject[] {
  if (!Number.isFinite(sx) || !Number.isFinite(sy) || Math.abs(sx) < MIN_SCALE || Math.abs(sy) < MIN_SCALE) return [...objects];
  return applyMatrix(objects, scaleAboutMatrix(pivot, sx, sy));
}

/** Rota `degrees` (horario en pantalla) alrededor de `pivot`. */
export function rotateAbout(objects: readonly EditorObject[], pivot: Point, degrees: number): EditorObject[] {
  if (!Number.isFinite(degrees)) return [...objects];
  return applyMatrix(objects, rotationAboutMatrix(pivot, degrees));
}

/** Bbox del grupo (multi-selección). Alias semántico de `bounds` para el pivote y el Inspector. */
export function groupBounds(objects: readonly EditorObject[]): Rect | null {
  return bounds(objects);
}

/** Centro del bbox del grupo: pivote por defecto de rotación/escala de la selección. */
export function groupCenter(objects: readonly EditorObject[]): Point | null {
  const rect = groupBounds(objects);
  return rect ? rectCenter(rect) : null;
}

export function isValidRect(rect: Rect): boolean {
  return Number.isFinite(rect.x) && Number.isFinite(rect.y) && Number.isFinite(rect.width) && Number.isFinite(rect.height);
}

/**
 * Lleva el bbox del grupo a `target` (valores numéricos del Inspector):
 * escala (no uniforme) + traslada. Un eje con tamaño actual 0 (línea recta)
 * no se puede escalar: solo se traslada en ese eje. `null` si el grupo no tiene
 * geometría, `target` no es finito o pide un tamaño ≤ 0 sobre un eje escalable.
 */
export function setBounds(objects: readonly EditorObject[], target: Rect): EditorObject[] | null {
  const current = groupBounds(objects);
  if (!current || !isValidRect(target)) return null;

  const scalableX = current.width > SIZE_EPSILON;
  const scalableY = current.height > SIZE_EPSILON;
  if ((scalableX && target.width <= SIZE_EPSILON) || (scalableY && target.height <= SIZE_EPSILON)) return null;

  const sx = scalableX ? target.width / current.width : 1;
  const sy = scalableY ? target.height / current.height : 1;

  // nueva = T(target.x, target.y) · S(sx, sy) · T(-current.x, -current.y)
  const gesture = composeMatrices(
    translationMatrix(target.x, target.y),
    composeMatrices({ a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 }, translationMatrix(-current.x, -current.y)),
  );
  return applyMatrix(objects, gesture);
}

/** Bbox destino manteniendo la proporción: el eje editado manda, el otro se deriva; el origen (arriba-izquierda) no se mueve. */
export function proportionalBounds(current: Rect, edited: "width" | "height", value: number): Rect | null {
  if (!Number.isFinite(value) || current.width <= SIZE_EPSILON || current.height <= SIZE_EPSILON) return null;
  if (edited === "width") return { ...current, width: value, height: (value * current.height) / current.width };
  return { ...current, height: value, width: (value * current.width) / current.height };
}
