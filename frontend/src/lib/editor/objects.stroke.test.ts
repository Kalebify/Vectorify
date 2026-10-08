import { describe, expect, it } from "vitest";
import { translationMatrix } from "./matrix";
import { hitTest, isUnfilled, parseEditableLayer, serializeEditableLayer } from "./objects";
import { screenToleranceToDocument } from "./units";
import type { EditorObject } from "./types";

/**
 * Trazos y `fill: "none"` (M3-S04): el modelo gana `stroke`/`strokeWidth` opcionales para las líneas abiertas de Draw. Round-trip
 * serialize -> parse, que los objetos de S01-S03 no cambien, y el hit-test de líneas (tolerancia = max(strokeWidth / 2, px de pantalla)).
 */

const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

function obj(id: string, d: string, overrides: Partial<EditorObject> = {}): EditorObject {
  return { id, layerGroupId: "layer-1", d, fill: "#ff0000", matrix: IDENTITY, ...overrides };
}

function sequentialIds() {
  let counter = 0;
  return () => `gen-${(counter += 1)}`;
}

const OPEN_LINE = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50" viewBox="0 0 100 50"><path data-vid="line-1" d="M0 0 L10 0 L10 10" fill="none" stroke="#123456" stroke-width="0.35"/><path data-vid="shape-1" d="M0 0 H5 V5 Z" fill="#ff0000"/></svg>`;

describe("parse / serialize con trazo", () => {
  it('parse conserva fill="none", stroke y stroke-width; los objetos sin trazo NO ganan propiedades nuevas', () => {
    const [line, shape] = parseEditableLayer(OPEN_LINE, "g1", "#999999", sequentialIds());

    expect(line).toStrictEqual({ id: "line-1", layerGroupId: "g1", d: "M0 0 L10 0 L10 10", fill: "none", stroke: "#123456", strokeWidth: 0.35, matrix: IDENTITY });
    expect(shape).toStrictEqual({ id: "shape-1", layerGroupId: "g1", d: "M0 0 H5 V5 Z", fill: "#ff0000", matrix: IDENTITY });
    expect("stroke" in shape).toBe(false);
  });

  it('un trazo sin ancho válido conserva el color; stroke="none" o un ancho <= 0 / no numérico no inventan trazo', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 L5 5" fill="none" stroke="#000"/><path d="M0 0 L5 5" fill="none" stroke="none" stroke-width="2"/><path d="M0 0 L5 5" stroke="#000" stroke-width="0"/><path d="M0 0 L5 5" stroke="#000" stroke-width="abc"/></svg>`;
    const [colorOnly, none, zero, text] = parseEditableLayer(svg, "g1", "#999999", sequentialIds());

    expect(colorOnly.stroke).toBe("#000");
    expect("strokeWidth" in colorOnly).toBe(false);
    expect("stroke" in none).toBe(false);
    expect(zero.stroke).toBe("#000");
    expect("strokeWidth" in zero).toBe(false);
    expect("strokeWidth" in text).toBe(false);
  });

  it("serialize escribe fill none, stroke y stroke-width SOLO si el objeto los tiene (un objeto de S01-S03 se serializa exactamente igual que antes)", () => {
    const line = obj("line-1", "M0 0 L10 0", { fill: "none", stroke: "#123456", strokeWidth: 0.35 });
    const plain = obj("shape-1", "M0 0 H5 V5 Z");

    expect(serializeEditableLayer([line, plain], { width: 100, height: 50 })).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50" viewBox="0 0 100 50"><path data-vid="line-1" d="M0 0 L10 0" fill="none" stroke="#123456" stroke-width="0.35"/><path data-vid="shape-1" d="M0 0 H5 V5 Z" fill="#ff0000"/></svg>',
    );
  });

  it("round-trip: parse(serialize(x)) conserva id, d, fill none, stroke, strokeWidth y matriz; y es idempotente", () => {
    const original = [
      obj("line-1", "M0 0 L10 0 L10 10", { fill: "none", stroke: "#123456", strokeWidth: 0.1, matrix: translationMatrix(3, 4) }),
      obj("line-2", "M5 5 L6 6", { fill: "none", stroke: "#abcdef" }),
      obj("shape-1", "M0 0 H5 V5 Z"),
    ];
    const meta = { width: 100, height: 50 };
    const text = serializeEditableLayer(original, meta);
    const parsed = parseEditableLayer(text, "layer-1", "#999999", sequentialIds());

    expect(parsed).toStrictEqual(original);
    expect(serializeEditableLayer(parsed, meta)).toBe(text);
  });

  it("el round-trip no rompe los objetos de S01-S03 (relleno, matriz, id): mismo texto antes y después", () => {
    const legacy = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10"><path data-vid="a" d="M0 0 H5 V5 Z" fill="#00ff00" transform="matrix(1 0 0 1 2 3)"/></svg>';
    const parsed = parseEditableLayer(legacy, "g1", "#999999", sequentialIds());

    expect(serializeEditableLayer(parsed, { width: 10, height: 10 })).toBe(legacy);
  });

  it("escapa el color del trazo y un strokeWidth no finito nunca llega como NaN", () => {
    const svg = serializeEditableLayer([obj("a", "M0 0 L1 1", { fill: "none", stroke: 'x"<', strokeWidth: Number.NaN })], { width: 1, height: 1 });

    expect(svg).toContain('stroke="x&quot;&lt;"');
    expect(svg).not.toContain("NaN");
    expect(new DOMParser().parseFromString(svg, "image/svg+xml").getElementsByTagName("parsererror")).toHaveLength(0);
  });
});

describe("isUnfilled", () => {
  it("none y transparent (sin importar mayúsculas ni espacios), no un color", () => {
    expect(isUnfilled("none")).toBe(true);
    expect(isUnfilled("  NONE ")).toBe(true);
    expect(isUnfilled("transparent")).toBe(true);
    expect(isUnfilled("#ff0000")).toBe(false);
  });
});

describe("hit-test de líneas abiertas", () => {
  const thin = obj("thin", "M0 0 L100 0", { fill: "none", stroke: "#000000", strokeWidth: 0.1 });
  const thick = obj("thick", "M0 0 L100 0", { fill: "none", stroke: "#000000", strokeWidth: 10 });

  it("la tolerancia en px de pantalla manda en una línea fina: a zoom 1, 3 unidades golpean y 5 no (4 px)", () => {
    const tolerance = screenToleranceToDocument(4, 1);
    expect(hitTest([thin], { x: 50, y: 3 }, tolerance)?.id).toBe("thin");
    expect(hitTest([thin], { x: 50, y: 5 }, tolerance)).toBeNull();
  });

  it("a más zoom la misma tolerancia en px son menos unidades de documento: la línea fina deja de golpear de lejos", () => {
    expect(hitTest([thin], { x: 50, y: 3 }, screenToleranceToDocument(4, 8))).toBeNull(); // 4 px / 8 = 0,5 unidades
    expect(hitTest([thin], { x: 50, y: 0.4 }, screenToleranceToDocument(4, 8))?.id).toBe("thin");
  });

  it("una línea gruesa responde en TODO su ancho aunque la tolerancia sea 0 (strokeWidth / 2 = 5), también en la punta", () => {
    expect(hitTest([thick], { x: 50, y: 4.9 }, 0)?.id).toBe("thick");
    expect(hitTest([thick], { x: 50, y: 5.1 }, 0)).toBeNull();
    expect(hitTest([thick], { x: -4.9, y: 0 }, 0)?.id).toBe("thick");
  });

  it("el ancho del trazo se escala con la matriz del objeto (medio ancho 5 x 2 = 10)", () => {
    const scaled = obj("scaled", "M0 0 L100 0", { fill: "none", stroke: "#000", strokeWidth: 10, matrix: { a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 } });
    expect(hitTest([scaled], { x: 50, y: 9.9 }, 0)?.id).toBe("scaled");
    expect(hitTest([scaled], { x: 50, y: 10.1 }, 0)).toBeNull();
  });

  it("un contorno ABIERTO sin relleno no tiene el lado de cierre implícito: la hipotenusa de una L no se golpea", () => {
    const corner = obj("corner", "M0 0 H10 V10", { fill: "none", stroke: "#000", strokeWidth: 0.1 });
    expect(hitTest([corner], { x: 5, y: 5 }, 0.5)).toBeNull();
    expect(hitTest([corner], { x: 5, y: 0 }, 0.5)?.id).toBe("corner");
    expect(hitTest([corner], { x: 10, y: 5 }, 0.5)?.id).toBe("corner");
  });

  it("un contorno cerrado (Z) sin relleno sí tiene su último lado", () => {
    const closed = obj("closed", "M0 0 H10 V10 Z", { fill: "none", stroke: "#000", strokeWidth: 0.1 });
    expect(hitTest([closed], { x: 5, y: 5 }, 0.5)?.id).toBe("closed");
  });

  it("un objeto con relleno y sin trazo conserva su comportamiento: el trazo no agrega holgura", () => {
    const filled = obj("filled", "M0 0 H10 V10 H0 Z");
    expect(hitTest([filled], { x: 10.4, y: 5 }, 0)).toBeNull();
    expect(hitTest([filled], { x: 5, y: 5 }, 0)?.id).toBe("filled");
  });

  it("una línea sin strokeWidth (solo color) usa solo la tolerancia", () => {
    const colorOnly = obj("c", "M0 0 L100 0", { fill: "none", stroke: "#000" });
    expect(hitTest([colorOnly], { x: 50, y: 0.4 }, 0)).toBeNull();
    expect(hitTest([colorOnly], { x: 50, y: 0.4 }, 0.5)?.id).toBe("c");
  });
});
