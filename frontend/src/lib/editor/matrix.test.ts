import Konva from "konva";
import { describe, expect, it } from "vitest";
import { multiplyMatrices, parseSvgTransformAttribute, type AffineMatrix } from "../svgTransform";
import {
  applyMatrixToPoint,
  composeMatrices,
  flipAboutMatrix,
  invertMatrix,
  isFiniteMatrix,
  isIdentityMatrix,
  matricesAlmostEqual,
  matrixDeterminant,
  matrixRotationDegrees,
  matrixToKonvaProps,
  rotationAboutMatrix,
  scaleAboutMatrix,
  translationMatrix,
} from "./matrix";

describe("flipAboutMatrix (M3-S02) — reflejo exacto", () => {
  it("horizontal alrededor de x = 100: x' = 200 - x y el eje queda fijo (coeficientes enteros)", () => {
    const flip = flipAboutMatrix({ x: 100, y: 50 }, "horizontal");
    expect(flip).toEqual({ a: -1, b: 0, c: 0, d: 1, e: 200, f: 0 });
    expect(applyMatrixToPoint(flip, { x: 100, y: 7 })).toEqual({ x: 100, y: 7 });
    expect(applyMatrixToPoint(flip, { x: 130, y: 7 })).toEqual({ x: 70, y: 7 });
  });

  it("vertical alrededor de y = 50: y' = 100 - y", () => {
    const flip = flipAboutMatrix({ x: 100, y: 50 }, "vertical");
    expect(flip).toEqual({ a: 1, b: 0, c: 0, d: -1, e: 0, f: 100 });
    expect(applyMatrixToPoint(flip, { x: 3, y: 80 })).toEqual({ x: 3, y: 20 });
  });

  it("reflejar dos veces = identidad EXACTA (coeficientes y traslación, también con pivotes fraccionarios)", () => {
    for (const axis of ["horizontal", "vertical"] as const) {
      for (const pivot of [{ x: 100, y: 50 }, { x: 33.5, y: -7.25 }, { x: 0.1, y: 0.2 }]) {
        const flip = flipAboutMatrix(pivot, axis);
        const twice = composeMatrices(flip, flip);
        for (const key of ["a", "b", "c", "d", "e", "f"] as const) expect(twice[key] === (key === "a" || key === "d" ? 1 : 0), `${axis} ${pivot.x}: ${key}=${twice[key]}`).toBe(true);
      }
    }
  });

  it("el determinante es -1 (es un reflejo, no una rotación)", () => {
    expect(matrixDeterminant(flipAboutMatrix({ x: 1, y: 2 }, "horizontal"))).toBe(-1);
    expect(matrixDeterminant(flipAboutMatrix({ x: 1, y: 2 }, "vertical"))).toBe(-1);
  });
});

describe("matrices base", () => {
  it("translación y escala alrededor de un pivote dejan el pivote fijo", () => {
    expect(applyMatrixToPoint(translationMatrix(3, -4), { x: 1, y: 1 })).toEqual({ x: 4, y: -3 });

    const scale = scaleAboutMatrix({ x: 10, y: 20 }, 2, 3);
    expect(applyMatrixToPoint(scale, { x: 10, y: 20 })).toEqual({ x: 10, y: 20 });
    // (12, 21) está a (+2,+1) del pivote -> (+4,+3).
    expect(applyMatrixToPoint(scale, { x: 12, y: 21 })).toEqual({ x: 14, y: 23 });
  });

  it("rotación de 90° horaria (y hacia abajo): (1,0) -> (0,1), EXACTO (sin 6e-17)", () => {
    const rotation = rotationAboutMatrix({ x: 0, y: 0 }, 90);
    expect(rotation).toEqual({ a: 0, b: 1, c: -1, d: 0, e: 0, f: 0 });
    expect(applyMatrixToPoint(rotation, { x: 1, y: 0 })).toEqual({ x: 0, y: 1 });
  });

  it("rotación alrededor de un pivote: el pivote no se mueve y un punto a su derecha pasa a estar debajo", () => {
    const rotation = rotationAboutMatrix({ x: 10, y: 10 }, 90);
    expect(applyMatrixToPoint(rotation, { x: 10, y: 10 })).toEqual({ x: 10, y: 10 });
    expect(applyMatrixToPoint(rotation, { x: 15, y: 10 })).toEqual({ x: 10, y: 15 });
  });

  it("4 rotaciones de 90° vuelven a la identidad exacta; 360° también", () => {
    const rotation = rotationAboutMatrix({ x: 7, y: 3 }, 90);
    let accumulated: AffineMatrix = rotation;
    for (let index = 0; index < 3; index += 1) accumulated = composeMatrices(rotation, accumulated);
    expect(isIdentityMatrix(accumulated, 1e-12)).toBe(true);
    expect(rotationAboutMatrix({ x: 7, y: 3 }, 360)).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
  });

  it("rotación de ángulo arbitrario coincide con SVG rotate(30, cx, cy) del parser existente", () => {
    const expected = parseSvgTransformAttribute("rotate(30, 5, 5)");
    expect(matricesAlmostEqual(rotationAboutMatrix({ x: 5, y: 5 }, 30), expected, 1e-12)).toBe(true);
  });

  it("invertMatrix: M · M⁻¹ = I; singular -> null", () => {
    const matrix: AffineMatrix = { a: 2, b: 1, c: -1, d: 3, e: 5, f: -7 };
    const inverse = invertMatrix(matrix)!;
    expect(matricesAlmostEqual(multiplyMatrices(matrix, inverse), { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })).toBe(true);
    expect(invertMatrix({ a: 1, b: 2, c: 2, d: 4, e: 0, f: 0 })).toBeNull();
    expect(invertMatrix({ a: Number.NaN, b: 0, c: 0, d: 1, e: 0, f: 0 })).toBeNull();
  });

  it("determinante, finitud y rotación extraída", () => {
    expect(matrixDeterminant({ a: 2, b: 0, c: 0, d: -3, e: 0, f: 0 })).toBe(-6);
    expect(isFiniteMatrix({ a: 1, b: 0, c: 0, d: 1, e: Infinity, f: 0 })).toBe(false);
    expect(matrixRotationDegrees(rotationAboutMatrix({ x: 3, y: 3 }, 90))).toBe(90);
    expect(matrixRotationDegrees(rotationAboutMatrix({ x: 0, y: 0 }, -30))).toBeCloseTo(-30, 9);
    expect(matrixRotationDegrees(rotationAboutMatrix({ x: 0, y: 0 }, 180))).toBe(180);
    expect(matrixRotationDegrees({ a: 0, b: 0, c: 0, d: 0, e: 1, f: 1 })).toBe(0);
  });
});

describe("matrixToKonvaProps — reproduce EXACTO la matriz en un nodo de Konva", () => {
  const cases: Array<[string, AffineMatrix]> = [
    ["identidad", { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }],
    ["traslación", translationMatrix(12.5, -3)],
    ["rotación 30°", rotationAboutMatrix({ x: 4, y: 9 }, 30)],
    ["escala no uniforme", { a: 2, b: 0, c: 0, d: 0.5, e: 1, f: 2 }],
    ["rotación + escala + traslación", { a: 1.2, b: 0.9, c: -0.45, d: 0.6, e: 10, f: -20 }],
    ["con skew", { a: 1, b: 0, c: 0.7, d: 1, e: 0, f: 0 }],
    ["reflejo horizontal (det < 0)", { a: -1, b: 0, c: 0, d: 1, e: 100, f: 0 }],
    ["reflejo vertical", { a: 1, b: 0, c: 0, d: -1, e: 0, f: 50 }],
    ["reflejo + rotación + skew", { a: -0.8, b: 0.6, c: 0.5, d: 0.9, e: 3, f: 4 }],
    ["rotación 90°", rotationAboutMatrix({ x: 0, y: 0 }, 90)],
  ];

  for (const [name, matrix] of cases) {
    it(`${name}: node.getTransform() == matriz original`, () => {
      const node = new Konva.Rect(matrixToKonvaProps(matrix));
      const [a, b, c, d, e, f] = node.getTransform().getMatrix();
      expect(a).toBeCloseTo(matrix.a, 9);
      expect(b).toBeCloseTo(matrix.b, 9);
      expect(c).toBeCloseTo(matrix.c, 9);
      expect(d).toBeCloseTo(matrix.d, 9);
      expect(e).toBeCloseTo(matrix.e, 9);
      expect(f).toBeCloseTo(matrix.f, 9);
    });
  }

  it("matriz singular (columna nula) no produce NaN", () => {
    const props = matrixToKonvaProps({ a: 0, b: 0, c: 2, d: 0, e: 5, f: 6 });
    for (const value of Object.values(props)) expect(Number.isFinite(value)).toBe(true);
  });
});
