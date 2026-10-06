import { describe, expect, it } from "vitest";
import { formatDisplayNumber, fromMm, mmPerUnit, parseNumericInput, screenToleranceToDocument, toMm } from "./units";

describe("mmPerUnit / toMm / fromMm", () => {
  it("100 mm de ancho sobre un viewBox de 360 unidades -> 0.2777… mm por unidad", () => {
    const factor = mmPerUnit(100, 360)!;
    expect(factor).toBeCloseTo(100 / 360, 12);
    expect(toMm(360, factor)).toBeCloseTo(100, 9);
    expect(fromMm(50, factor)).toBeCloseTo(180, 9);
  });

  it("toMm y fromMm son inversas", () => {
    const factor = mmPerUnit(213.7, 1024)!;
    expect(fromMm(toMm(37.25, factor), factor)).toBeCloseTo(37.25, 12);
  });

  it("dimensiones desconocidas o inválidas -> null (el Inspector NO inventa mm)", () => {
    expect(mmPerUnit(null, 360)).toBeNull();
    expect(mmPerUnit(100, undefined)).toBeNull();
    expect(mmPerUnit(0, 360)).toBeNull();
    expect(mmPerUnit(100, 0)).toBeNull();
    expect(mmPerUnit(100, -5)).toBeNull();
    expect(mmPerUnit(Number.NaN, 360)).toBeNull();
    expect(mmPerUnit(100, Infinity)).toBeNull();
  });
});

describe("screenToleranceToDocument", () => {
  it("a más zoom, menos unidades de documento para los mismos px de pantalla", () => {
    expect(screenToleranceToDocument(4, 1)).toBe(4);
    expect(screenToleranceToDocument(4, 8)).toBe(0.5);
    expect(screenToleranceToDocument(4, 0.1)).toBeCloseTo(40, 9);
  });

  it("escala inválida: devuelve los px tal cual (nunca Infinity/NaN)", () => {
    expect(screenToleranceToDocument(4, 0)).toBe(4);
    expect(screenToleranceToDocument(4, Number.NaN)).toBe(4);
  });
});

describe("parseNumericInput", () => {
  it("acepta enteros, decimales, signo, coma decimal y notación científica", () => {
    expect(parseNumericInput("12")).toBe(12);
    expect(parseNumericInput(" -3.5 ")).toBe(-3.5);
    expect(parseNumericInput("12,5")).toBe(12.5);
    expect(parseNumericInput(".5")).toBe(0.5);
    expect(parseNumericInput("1e2")).toBe(100);
  });

  it("rechaza vacío, texto, mezclas y no finitos", () => {
    for (const text of ["", "   ", "abc", "12abc", "1,2,3", "1.2.3", "--1", "Infinity", "NaN", "0x10", "1e999"]) {
      expect(parseNumericInput(text), text).toBeNull();
    }
  });
});

describe("formatDisplayNumber", () => {
  it("hasta 3 decimales sin ceros de relleno ni -0", () => {
    expect(formatDisplayNumber(12.3456)).toBe("12.346");
    expect(formatDisplayNumber(5)).toBe("5");
    expect(formatDisplayNumber(-0.0001)).toBe("0");
    expect(formatDisplayNumber(0.30000000000000004)).toBe("0.3");
    expect(formatDisplayNumber(Number.NaN)).toBe("");
  });
});
