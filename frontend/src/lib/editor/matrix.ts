import { IDENTITY_MATRIX, multiplyMatrices, type AffineMatrix } from "../svgTransform";
import type { Point } from "./types";

/**
 * Álgebra de matrices afines del editor (MVP3-S01), sobre el `AffineMatrix`
 * de `lib/svgTransform.ts` (`{a,b,c,d,e,f}`, convención SVG: x' = a·x + c·y +
 * e, y' = b·x + d·y + f). Todo en espacio de DOCUMENTO.
 */

/**
 * Seno y coseno de un ángulo en grados, EXACTOS para múltiplos de 90° (sin el
 * 6e-17 de `Math.cos(Math.PI / 2)`): rotar 4 veces 90° vuelve a la identidad
 * sin residuo, y una rotación de 90° de un rectángulo da coordenadas enteras.
 */
function sinCosDegrees(degrees: number): { sin: number; cos: number } {
  const normalized = ((degrees % 360) + 360) % 360;
  if (normalized === 0) return { sin: 0, cos: 1 };
  if (normalized === 90) return { sin: 1, cos: 0 };
  if (normalized === 180) return { sin: 0, cos: -1 };
  if (normalized === 270) return { sin: -1, cos: 0 };
  const radians = (degrees * Math.PI) / 180;
  return { sin: Math.sin(radians), cos: Math.cos(radians) };
}

export function translationMatrix(dx: number, dy: number): AffineMatrix {
  return { a: 1, b: 0, c: 0, d: 1, e: dx, f: dy };
}

/** Escala `(sx, sy)` dejando fijo el punto `pivot`. */
export function scaleAboutMatrix(pivot: Point, sx: number, sy: number): AffineMatrix {
  return { a: sx, b: 0, c: 0, d: sy, e: pivot.x - sx * pivot.x, f: pivot.y - sy * pivot.y };
}

/** Rotación de `degrees` (positivo = sentido horario en pantalla, eje Y hacia abajo, igual que SVG `rotate()`) alrededor de `pivot`. */
export function rotationAboutMatrix(pivot: Point, degrees: number): AffineMatrix {
  const { sin, cos } = sinCosDegrees(degrees);
  return {
    a: cos,
    b: sin,
    c: 0 - sin, // `0 - sin` (no `-sin`) evita un -0 cuando sin es 0
    d: cos,
    e: pivot.x - cos * pivot.x + sin * pivot.y,
    f: pivot.y - sin * pivot.x - cos * pivot.y,
  };
}

/**
 * Reflejo exacto respecto de un eje que pasa por `pivot`: `horizontal` invierte izquierda/derecha (x' = 2·px - x),
 * `vertical` invierte arriba/abajo. Los coeficientes lineales son enteros: reflejar dos veces compone la identidad sin residuo.
 */
export function flipAboutMatrix(pivot: Point, axis: "horizontal" | "vertical"): AffineMatrix {
  return axis === "horizontal" ? scaleAboutMatrix(pivot, -1, 1) : scaleAboutMatrix(pivot, 1, -1);
}

export function applyMatrixToPoint(matrix: AffineMatrix, point: Point): Point {
  return {
    x: matrix.a * point.x + matrix.c * point.y + matrix.e,
    y: matrix.b * point.x + matrix.d * point.y + matrix.f,
  };
}

export function matrixDeterminant(matrix: AffineMatrix): number {
  return matrix.a * matrix.d - matrix.b * matrix.c;
}

/** Inversa, o `null` si la matriz es singular (determinante ~0) o no finita. */
export function invertMatrix(matrix: AffineMatrix): AffineMatrix | null {
  const det = matrixDeterminant(matrix);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return {
    a: matrix.d / det,
    b: -matrix.b / det,
    c: -matrix.c / det,
    d: matrix.a / det,
    e: (matrix.c * matrix.f - matrix.d * matrix.e) / det,
    f: (matrix.b * matrix.e - matrix.a * matrix.f) / det,
  };
}

export function isFiniteMatrix(matrix: AffineMatrix): boolean {
  return (
    Number.isFinite(matrix.a) &&
    Number.isFinite(matrix.b) &&
    Number.isFinite(matrix.c) &&
    Number.isFinite(matrix.d) &&
    Number.isFinite(matrix.e) &&
    Number.isFinite(matrix.f)
  );
}

export function matricesAlmostEqual(left: AffineMatrix, right: AffineMatrix, epsilon = 1e-9): boolean {
  return (
    Math.abs(left.a - right.a) <= epsilon &&
    Math.abs(left.b - right.b) <= epsilon &&
    Math.abs(left.c - right.c) <= epsilon &&
    Math.abs(left.d - right.d) <= epsilon &&
    Math.abs(left.e - right.e) <= epsilon &&
    Math.abs(left.f - right.f) <= epsilon
  );
}

export function isIdentityMatrix(matrix: AffineMatrix, epsilon = 0): boolean {
  return matricesAlmostEqual(matrix, IDENTITY_MATRIX, epsilon);
}

/** `after ∘ before` en el orden de composición del editor: el punto se transforma primero por `before` y después por `after` (ambas en espacio de documento). */
export function composeMatrices(after: AffineMatrix, before: AffineMatrix): AffineMatrix {
  return multiplyMatrices(after, before);
}

/** Rotación (grados, en (-180, 180]) de la matriz, según la misma convención de `decomposeMatrix` (ángulo de la primera columna). */
export function matrixRotationDegrees(matrix: AffineMatrix): number {
  if (matrix.a === 0 && matrix.b === 0) return 0;
  const degrees = (Math.atan2(matrix.b, matrix.a) * 180) / Math.PI;
  // Normaliza el ruido de punto flotante (89.99999999999999 -> 90).
  const rounded = Math.round(degrees * 1e9) / 1e9;
  return rounded === -180 ? 180 : rounded;
}

/** Props de un nodo Konva (`x/y/rotation/scaleX/scaleY/skewX`) que reproducen EXACTAMENTE una matriz afín. */
export interface KonvaNodeProps {
  x: number;
  y: number;
  /** Grados. */
  rotation: number;
  scaleX: number;
  /** Negativo si la matriz refleja (determinante < 0). */
  scaleY: number;
  /** Ojo: en Konva `skewX` es la TANGENTE del ángulo (se aplica como `x' = x + skewX·y`), NO grados. */
  skewX: number;
}

/**
 * Descompone una matriz en los props de Konva respetando su orden de
 * composición (`translate · rotate · skew · scale`, ver `Node._getTransform`
 * de Konva): `M = T(e,f) · R(θ) · [[1,k],[0,1]] · S(sx,sy)`.
 *
 * Difiere de `svgTransform.decomposeMatrix` (usada por el visor de M2.1) en dos
 * puntos que importan para un EDITOR: conserva el signo de `scaleY` (un reflejo
 * no se pierde) y devuelve `skewX` como tangente (lo que Konva espera), no en
 * grados. Test: `matrix.test.ts` verifica contra `Konva.Node.getTransform()`.
 */
export function matrixToKonvaProps(matrix: AffineMatrix): KonvaNodeProps {
  const { a, b, c, d, e, f } = matrix;
  const scaleX = Math.hypot(a, b);

  if (scaleX < 1e-12) {
    // Primera columna nula (matriz singular): el ángulo sale de la segunda.
    const norm = Math.hypot(c, d);
    return { x: e, y: f, rotation: norm < 1e-12 ? 0 : (Math.atan2(-c, d) * 180) / Math.PI, scaleX: 0, scaleY: norm, skewX: 0 };
  }

  const ux = a / scaleX;
  const uy = b / scaleX;
  const scaleY = d * ux - c * uy;
  const skewX = Math.abs(scaleY) < 1e-12 ? 0 : (c * ux + d * uy) / scaleY;

  return { x: e, y: f, rotation: (Math.atan2(b, a) * 180) / Math.PI, scaleX, scaleY, skewX };
}
