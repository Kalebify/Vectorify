import { describe, expect, it } from "vitest";
import { matricesAlmostEqual, rotationAboutMatrix, translationMatrix } from "./matrix";
import { bounds } from "./objects";
import {
  applyMatrix,
  groupBounds,
  groupCenter,
  proportionalBounds,
  rotateAbout,
  scaleAbout,
  setBounds,
  translate,
} from "./transform";
import type { EditorObject } from "./types";

const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

function obj(id: string, d: string, matrix = IDENTITY): EditorObject {
  return { id, layerGroupId: "layer-1", d, fill: "#000000", matrix };
}

const RECT = "M0 0 H10 V4 H0 Z";

describe("translate", () => {
  it("mueve el bbox exactamente y NO toca d (fuente de verdad geométrica)", () => {
    const before = [obj("a", RECT)];
    const after = translate(before, 7, -3);
    expect(bounds(after)).toEqual({ x: 7, y: -3, width: 10, height: 4 });
    expect(after[0].d).toBe(RECT);
    // Inmutabilidad: el original queda intacto.
    expect(before[0].matrix).toEqual(IDENTITY);
    expect(bounds(before)).toEqual({ x: 0, y: 0, width: 10, height: 4 });
  });

  it("se compone con la matriz previa en espacio de documento (un objeto rotado se mueve en ejes del documento)", () => {
    const rotated = obj("a", RECT, rotationAboutMatrix({ x: 0, y: 0 }, 90)); // bbox x:-4..0, y:0..10
    const moved = translate([rotated], 5, 0);
    expect(bounds(moved)).toEqual({ x: 1, y: 0, width: 4, height: 10 });
  });

  it("delta cero o no finito: devuelve los MISMOS objetos (gesto nulo = sin comando)", () => {
    const before = [obj("a", RECT), obj("b", RECT)];
    const zero = translate(before, 0, 0);
    expect(zero[0]).toBe(before[0]);
    expect(zero[1]).toBe(before[1]);
    expect(translate(before, Number.NaN, 1)[0]).toBe(before[0]);
    expect(translate(before, Infinity, 1)[0]).toBe(before[0]);
  });

  it("sin acumulación de error: recomponer desde 'antes' + delta del gesto (10 000 frames) == un solo salto", () => {
    const before = [obj("a", RECT, translationMatrix(0.1, 0.2))];
    let frame: EditorObject[] = before;
    for (let step = 1; step <= 10000; step += 1) {
      frame = translate(before, step * 0.1, -step * 0.05); // cada frame parte de `before`, nunca de `frame`
    }
    const jump = translate(before, 10000 * 0.1, -10000 * 0.05);
    expect(frame[0].matrix).toEqual(jump[0].matrix);
    // Contraste: la acumulación incremental SÍ deriva (0.1 diez mil veces != 1000).
    let incremental: EditorObject[] = before;
    for (let step = 1; step <= 10000; step += 1) incremental = translate(incremental, 0.1, 0);
    expect(incremental[0].matrix.e).not.toBe(before[0].matrix.e + 1000);
    expect(Math.abs(incremental[0].matrix.e - (0.1 + 1000))).toBeGreaterThan(0);
    // Volver al origen del gesto restaura la matriz original bit a bit.
    expect(translate(before, 0, 0)[0]).toBe(before[0]);
  });
});

describe("scaleAbout", () => {
  it("escala alrededor de un pivote: el pivote queda fijo", () => {
    const after = scaleAbout([obj("a", RECT)], { x: 0, y: 0 }, 2, 3);
    expect(bounds(after)).toEqual({ x: 0, y: 0, width: 20, height: 12 });

    const aroundCenter = scaleAbout([obj("a", RECT)], { x: 5, y: 2 }, 2, 2);
    expect(bounds(aroundCenter)).toEqual({ x: -5, y: -2, width: 20, height: 8 });
  });

  it("factor negativo = reflejo (el bbox queda espejado respecto del pivote)", () => {
    const after = scaleAbout([obj("a", RECT)], { x: 0, y: 0 }, -1, 1);
    expect(bounds(after)).toEqual({ x: -10, y: 0, width: 10, height: 4 });
  });

  it("factor 0, ~0 o no finito se ignora (no colapsa la geometría)", () => {
    const before = [obj("a", RECT)];
    expect(scaleAbout(before, { x: 0, y: 0 }, 0, 1)[0]).toBe(before[0]);
    expect(scaleAbout(before, { x: 0, y: 0 }, 1, 1e-12)[0]).toBe(before[0]);
    expect(scaleAbout(before, { x: 0, y: 0 }, Number.NaN, 1)[0]).toBe(before[0]);
  });

  it("escala unitaria no cambia nada (misma referencia)", () => {
    const before = [obj("a", RECT)];
    expect(scaleAbout(before, { x: 3, y: 3 }, 1, 1)[0]).toBe(before[0]);
  });
});

describe("rotateAbout", () => {
  it("90° de un rectángulo 10×4 alrededor de su centro: 4×10 con el mismo centro (valores exactos)", () => {
    const after = rotateAbout([obj("a", RECT)], { x: 5, y: 2 }, 90);
    expect(bounds(after)).toEqual({ x: 3, y: -3, width: 4, height: 10 });
    expect(after[0].d).toBe(RECT);
  });

  it("180° alrededor del centro deja el bbox idéntico", () => {
    expect(bounds(rotateAbout([obj("a", RECT)], { x: 5, y: 2 }, 180))).toEqual({ x: 0, y: 0, width: 10, height: 4 });
  });

  it("cuatro rotaciones de 90° vuelven a la matriz identidad exacta", () => {
    let current = [obj("a", RECT)];
    for (let index = 0; index < 4; index += 1) current = rotateAbout(current, { x: 5, y: 2 }, 90);
    expect(matricesAlmostEqual(current[0].matrix, IDENTITY, 0)).toBe(true);
  });

  it("rotación de multi-selección alrededor del centro del grupo: el bbox del grupo conserva su centro", () => {
    const group = [obj("left", "M0 0 H10 V10 H0 Z"), obj("right", "M0 0 H10 V10 H0 Z", translationMatrix(30, 0))];
    const center = groupCenter(group)!;
    expect(center).toEqual({ x: 20, y: 5 });
    const rotated = rotateAbout(group, center, 90);
    expect(bounds(rotated)).toEqual({ x: 15, y: -15, width: 10, height: 40 });
  });

  it("0° o no finito: mismas referencias", () => {
    const before = [obj("a", RECT)];
    expect(rotateAbout(before, { x: 0, y: 0 }, 0)[0]).toBe(before[0]);
    expect(rotateAbout(before, { x: 0, y: 0 }, Number.NaN)[0]).toBe(before[0]);
  });
});

describe("applyMatrix / groupBounds / groupCenter", () => {
  it("matriz no finita se rechaza (nunca contamina el SVG con NaN)", () => {
    const before = [obj("a", RECT)];
    const result = applyMatrix(before, { a: Number.NaN, b: 0, c: 0, d: 1, e: 0, f: 0 });
    expect(result[0]).toBe(before[0]);
  });

  it("groupBounds es el bbox unión; groupCenter su centro; vacío -> null", () => {
    const group = [obj("a", RECT), obj("b", RECT, translationMatrix(20, 10))];
    expect(groupBounds(group)).toEqual({ x: 0, y: 0, width: 30, height: 14 });
    expect(groupCenter(group)).toEqual({ x: 15, y: 7 });
    expect(groupBounds([])).toBeNull();
    expect(groupCenter([])).toBeNull();
  });
});

describe("setBounds (valores numéricos del Inspector)", () => {
  it("lleva el bbox exactamente al rectángulo destino (escala + traslación)", () => {
    const before = [obj("a", "M10 20 H40 V60 H10 Z")]; // bbox x:10 y:20 w:30 h:40
    const after = setBounds(before, { x: 0, y: 0, width: 60, height: 20 })!;
    expect(bounds(after)).toEqual({ x: 0, y: 0, width: 60, height: 20 });
    expect(after[0].d).toBe("M10 20 H40 V60 H10 Z");
  });

  it("solo mover (mismo tamaño) equivale a una traslación", () => {
    const before = [obj("a", RECT)];
    const after = setBounds(before, { x: 100, y: -50, width: 10, height: 4 })!;
    expect(matricesAlmostEqual(after[0].matrix, translationMatrix(100, -50), 0)).toBe(true);
  });

  it("objeto con rotación previa: el bbox final coincide con el destino", () => {
    const before = [obj("a", RECT, rotationAboutMatrix({ x: 5, y: 2 }, 30))];
    const target = { x: 7, y: 9, width: 33, height: 21 };
    const result = bounds(setBounds(before, target)!)!;
    expect(result.x).toBeCloseTo(target.x, 9);
    expect(result.y).toBeCloseTo(target.y, 9);
    expect(result.width).toBeCloseTo(target.width, 9);
    expect(result.height).toBeCloseTo(target.height, 9);
  });

  it("multi-selección: el bbox del GRUPO llega al destino y las posiciones relativas se escalan", () => {
    const group = [obj("a", "M0 0 H10 V10 H0 Z"), obj("b", "M0 0 H10 V10 H0 Z", translationMatrix(30, 0))]; // grupo 40×10
    const after = setBounds(group, { x: 0, y: 0, width: 80, height: 10 })!;
    expect(bounds(after)).toEqual({ x: 0, y: 0, width: 80, height: 10 });
    expect(bounds([after[1]])).toEqual({ x: 60, y: 0, width: 20, height: 10 });
  });

  it("línea recta (alto 0): no se puede escalar ese eje, solo se traslada", () => {
    const line = [obj("l", "M0 3 H10")];
    const after = setBounds(line, { x: 0, y: 50, width: 20, height: 123 })!;
    expect(bounds(after)).toEqual({ x: 0, y: 50, width: 20, height: 0 });
  });

  it("rechaza (null): tamaño ≤ 0 en un eje escalable, no finitos, sin geometría", () => {
    const before = [obj("a", RECT)];
    expect(setBounds(before, { x: 0, y: 0, width: 0, height: 4 })).toBeNull();
    expect(setBounds(before, { x: 0, y: 0, width: -5, height: 4 })).toBeNull();
    expect(setBounds(before, { x: Number.NaN, y: 0, width: 5, height: 4 })).toBeNull();
    expect(setBounds(before, { x: 0, y: 0, width: Infinity, height: 4 })).toBeNull();
    expect(setBounds([obj("e", "")], { x: 0, y: 0, width: 5, height: 4 })).toBeNull();
    expect(setBounds([], { x: 0, y: 0, width: 5, height: 4 })).toBeNull();
  });

  it("destino == bbox actual: mismas referencias (no genera comando)", () => {
    const before = [obj("a", RECT)];
    expect(setBounds(before, { x: 0, y: 0, width: 10, height: 4 })![0]).toBe(before[0]);
  });
});

describe("proportionalBounds", () => {
  const current = { x: 5, y: 6, width: 20, height: 10 };

  it("editar ancho deriva el alto con la misma proporción y conserva el origen", () => {
    expect(proportionalBounds(current, "width", 40)).toEqual({ x: 5, y: 6, width: 40, height: 20 });
  });

  it("editar alto deriva el ancho", () => {
    expect(proportionalBounds(current, "height", 5)).toEqual({ x: 5, y: 6, width: 10, height: 5 });
  });

  it("sin proporción definida (ancho o alto 0) o valor no finito -> null", () => {
    expect(proportionalBounds({ x: 0, y: 0, width: 0, height: 10 }, "width", 5)).toBeNull();
    expect(proportionalBounds(current, "width", Number.NaN)).toBeNull();
  });
});
