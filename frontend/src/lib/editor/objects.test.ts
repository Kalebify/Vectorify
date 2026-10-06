import { describe, expect, it } from "vitest";
import { matricesAlmostEqual, rotationAboutMatrix, translationMatrix } from "./matrix";
import {
  bounds,
  hitTest,
  hitTestAll,
  objectBounds,
  objectsInRect,
  parseEditableLayer,
  parseEditableLayerStrict,
  rectFromPoints,
  rectsIntersect,
  serializeEditableLayer,
  unionRects,
} from "./objects";
import { screenToleranceToDocument } from "./units";
import type { EditorObject } from "./types";

const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

function obj(id: string, d: string, overrides: Partial<EditorObject> = {}): EditorObject {
  return { id, layerGroupId: "layer-1", d, fill: "#ff0000", matrix: IDENTITY, ...overrides };
}

function sequentialIds() {
  let counter = 0;
  return () => `gen-${(counter += 1)}`;
}

// SVG real de vtracer/dimensiones del repo (recortado a 3 paths): coordenadas con 3 decimales y translate por path.
const VTRACER_FIXTURE = `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="360" height="120" viewBox="0 0 360 120">
<path d="M0.000,0.000L8.000,1.000L16.000,25.000L24.000,1.000L32.000,0.000L31.000,8.000L21.000,37.000L11.000,37.000L-1.000,1.000Z" fill="#000000" transform="translate(14,45)" />
<path d="M0.000,0.000L24.000,0.000L25.000,1.000L25.000,7.000L7.000,7.000L7.000,15.000L23.000,15.000L24.000,16.000L23.000,22.000L7.000,22.000L7.000,30.000L25.000,30.000L26.000,31.000L25.000,37.000L-1.000,37.000L-1.000,1.000Z" fill="#000000" transform="translate(52,45)" />
<path d="M0.000,0.000L10.000,0.000C18.000,4.000 21.000,9.000 21.000,13.000L13.000,13.000L11.000,9.000L0.000,8.000Z" fill="#112233" transform="translate(93.5,45.25)" />
</svg>`;

describe("parseEditableLayer", () => {
  it("SVG plano del pipeline: un objeto por path, en orden de documento, con fill y translate -> matriz", () => {
    const objects = parseEditableLayer(VTRACER_FIXTURE, "g1", "#999999", sequentialIds());
    expect(objects.map((o) => o.id)).toEqual(["gen-1", "gen-2", "gen-3"]);
    expect(objects.every((o) => o.layerGroupId === "g1")).toBe(true);
    expect(objects[0].fill).toBe("#000000");
    expect(objects[2].fill).toBe("#112233");
    expect(objects[0].matrix).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 14, f: 45 });
    expect(objects[2].matrix).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 93.5, f: 45.25 });
    // `d` queda TAL CUAL (fuente de verdad geométrica).
    expect(objects[0].d).toContain("M0.000,0.000L8.000,1.000");
  });

  it("compone el transform de los <g> ancestros con el propio, en orden SVG (ancestro afuera)", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><g transform="translate(10,0)"><g transform="scale(2)"><path d="M0 0 L1 1" transform="translate(1,1)"/></g></g></svg>`;
    const [object] = parseEditableLayer(svg, "g1", "#000");
    // translate(10,0) · scale(2) · translate(1,1): punto (0,0) -> (1,1) -> (2,2) -> (12,2)
    expect(object.matrix).toEqual({ a: 2, b: 0, c: 0, d: 2, e: 12, f: 2 });
  });

  it("fill: propio > del <g> ancestro > fallback de la capa", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><path d="M0 0 L1 1" fill="#111111"/><g fill="#222222"><path d="M0 0 L2 2"/></g><path d="M0 0 L3 3"/></svg>`;
    expect(parseEditableLayer(svg, "g", "#333333").map((o) => o.fill)).toEqual(["#111111", "#222222", "#333333"]);
  });

  it("preserva data-vid; un data-vid repetido recibe un id nuevo (ids únicos)", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><path data-vid="vid-A" d="M0 0 L1 1"/><path data-vid="vid-A" d="M0 0 L2 2"/><path d="M0 0 L3 3"/></svg>`;
    const objects = parseEditableLayer(svg, "g", "#000", sequentialIds());
    expect(objects.map((o) => o.id)).toEqual(["vid-A", "gen-1", "gen-2"]);
    expect(new Set(objects.map((o) => o.id)).size).toBe(3);
  });

  it("sin createId usa UUID reales y distintos", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><path d="M0 0 L1 1"/><path d="M0 0 L2 2"/></svg>`;
    const [first, second] = parseEditableLayer(svg, "g", "#000");
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.id).not.toBe(second.id);
  });

  it("paths sin `d` o con `d` en blanco se omiten (no hay geometría que editar)", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><path fill="#000"/><path d="  "/><path d="M0 0 L1 1"/></svg>`;
    expect(parseEditableLayer(svg, "g", "#000")).toHaveLength(1);
  });

  it("SVG válido sin paths -> [] (capa vacía); XML inválido -> [] en la versión tolerante y null en la estricta", () => {
    expect(parseEditableLayerStrict(`<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>`, "g", "#000")).toEqual([]);
    expect(parseEditableLayer("<svg><path", "g", "#000")).toEqual([]);
    expect(parseEditableLayerStrict("<svg><path", "g", "#000")).toBeNull();
    expect(parseEditableLayerStrict("", "g", "#000")).toBeNull();
  });
});

describe("serializeEditableLayer + round-trip", () => {
  const meta = { width: 360, height: 120 };

  it("formato de origen: <path data-vid d fill transform> planos; identidad no escribe transform", () => {
    const svg = serializeEditableLayer(
      [obj("id-1", "M0 0 L1 1"), obj("id-2", "M0 0 L2 2", { matrix: { a: 1, b: 0, c: 0, d: 1, e: 5, f: 6 }, fill: "#00ff00" })],
      meta,
    );
    expect(svg).toContain('width="360" height="120" viewBox="0 0 360 120"');
    expect(svg).toContain('<path data-vid="id-1" d="M0 0 L1 1" fill="#ff0000"/>');
    expect(svg).toContain('<path data-vid="id-2" d="M0 0 L2 2" fill="#00ff00" transform="matrix(1 0 0 1 5 6)"/>');
  });

  it("escapa comillas, & y < en atributos (el SVG resultante siempre parsea)", () => {
    const tricky = obj('id"&<>', "M0 0 L1 1", { fill: 'url("#a&b")' });
    const parsed = parseEditableLayerStrict(serializeEditableLayer([tricky], meta), "layer-1", "#000");
    expect(parsed).not.toBeNull();
    expect(parsed![0].id).toBe('id"&<>');
    expect(parsed![0].fill).toBe('url("#a&b")');
  });

  it("matriz con NaN/Infinity nunca llega al SVG como 'NaN' (se escribe 0)", () => {
    const svg = serializeEditableLayer([obj("x", "M0 0 L1 1", { matrix: { a: Number.NaN, b: 0, c: 0, d: 1, e: Infinity, f: 0 } })], meta);
    expect(svg).not.toMatch(/NaN|Infinity/);
  });

  function expectRoundTrip(objects: EditorObject[]) {
    const reparsed = parseEditableLayer(serializeEditableLayer(objects, meta), "layer-1", "#000000");
    expect(reparsed).toHaveLength(objects.length);
    objects.forEach((original, index) => {
      expect(reparsed[index].id).toBe(original.id);
      expect(reparsed[index].d).toBe(original.d);
      expect(reparsed[index].fill).toBe(original.fill);
      expect(matricesAlmostEqual(reparsed[index].matrix, original.matrix, 1e-9)).toBe(true);
    });
  }

  it("round-trip del SVG real de vtracer: parse -> serialize -> parse conserva ids, d, fill y matriz", () => {
    expectRoundTrip(parseEditableLayer(VTRACER_FIXTURE, "layer-1", "#000", sequentialIds()));
  });

  it("round-trip con <g transform> anidados (el transform se aplana a una matriz propia equivalente)", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><g transform="translate(10 20) rotate(30)"><path d="M0 0 L10 0 L10 10 Z" fill="#abcdef" transform="scale(1.5, 2)"/></g></svg>`;
    expectRoundTrip(parseEditableLayer(svg, "layer-1", "#000", sequentialIds()));
  });

  it("round-trip tras ediciones: rotaciones/escalas/traslaciones de ángulos 'feos' y magnitudes extremas", () => {
    const edited = [
      obj("a", "M0 0 L1 1", { matrix: rotationAboutMatrix({ x: 3.3, y: 7.7 }, 37.123456789) }),
      obj("b", "M0 0 C1 2 3 4 5 6", { matrix: { a: 1e-7, b: -2.5e-8, c: 3.1e5, d: 0.1 + 0.2, e: 123456.789012345, f: -1e-9 } }),
      obj("c", "M0 0 L9 9 Z", { matrix: translationMatrix(0.1, 0.2) }),
    ];
    expectRoundTrip(edited);
  });

  it("serialize ∘ parse es idempotente: el segundo ciclo produce exactamente el mismo texto", () => {
    const first = serializeEditableLayer(parseEditableLayer(VTRACER_FIXTURE, "layer-1", "#000", sequentialIds()), meta);
    const second = serializeEditableLayer(parseEditableLayer(first, "layer-1", "#000"), meta);
    expect(second).toBe(first);
  });
});

describe("bounds", () => {
  it("objectBounds aplica la matriz (traslación y rotación exactas)", () => {
    const rect = objectBounds(obj("a", "M0 0 H10 V5 H0 Z", { matrix: translationMatrix(100, 50) }))!;
    expect(rect).toEqual({ x: 100, y: 50, width: 10, height: 5 });

    const rotated = objectBounds(obj("b", "M0 0 H10 V5 H0 Z", { matrix: rotationAboutMatrix({ x: 0, y: 0 }, 90) }))!;
    expect(rotated).toEqual({ x: -5, y: 0, width: 5, height: 10 });
  });

  it("bounds(objects) = unión; sin geometría -> null", () => {
    const a = obj("a", "M0 0 H10 V10 H0 Z");
    const b = obj("b", "M0 0 H4 V4 H0 Z", { matrix: translationMatrix(20, -5) });
    expect(bounds([a, b])).toEqual({ x: 0, y: -5, width: 24, height: 15 });
    expect(bounds([])).toBeNull();
    expect(bounds([obj("empty", "")])).toBeNull();
    expect(bounds([obj("empty", ""), a])).toEqual({ x: 0, y: 0, width: 10, height: 10 });
  });

  it("objectBounds es estable por referencia (cache) y matriz no finita -> null", () => {
    const a = obj("a", "M0 0 H10 V10 H0 Z");
    expect(objectBounds(a)).toBe(objectBounds(a));
    expect(objectBounds(obj("n", "M0 0 L1 1", { matrix: { ...IDENTITY, e: Number.NaN } }))).toBeNull();
  });

  it("unionRects / rectsIntersect / rectFromPoints", () => {
    expect(unionRects([])).toBeNull();
    expect(rectsIntersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 10, width: 5, height: 5 })).toBe(true);
    expect(rectsIntersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 10.01, y: 0, width: 5, height: 5 })).toBe(false);
    expect(rectFromPoints({ x: 10, y: 8 }, { x: 4, y: 20 })).toEqual({ x: 4, y: 8, width: 6, height: 12 });
  });
});

describe("hitTest / hitTestAll", () => {
  const bottom = obj("bottom", "M0 0 H10 V10 H0 Z", { fill: "#ff0000" });
  const top = obj("top", "M5 5 H15 V15 H5 Z", { fill: "#00ff00" });

  it("el objeto de más arriba gana; hitTestAll devuelve la pila de arriba hacia abajo", () => {
    expect(hitTest([bottom, top], { x: 7, y: 7 })?.id).toBe("top");
    expect(hitTestAll([bottom, top], { x: 7, y: 7 }).map((o) => o.id)).toEqual(["top", "bottom"]);
    expect(hitTest([bottom, top], { x: 2, y: 2 })?.id).toBe("bottom");
    expect(hitTestAll([bottom, top], { x: 12, y: 12 }).map((o) => o.id)).toEqual(["top"]);
  });

  it("fuera de todo -> null / []", () => {
    expect(hitTest([bottom, top], { x: 50, y: 50 })).toBeNull();
    expect(hitTestAll([bottom, top], { x: 50, y: 50 })).toEqual([]);
    expect(hitTest([], { x: 0, y: 0 })).toBeNull();
  });

  it("relleno vs. hueco: un punto dentro del bbox pero en un hueco NO golpea (con tolerancia 0)", () => {
    const ring = obj("ring", "M0 0 H10 V10 H0 Z M3 3 V7 H7 V3 Z");
    expect(hitTest([ring], { x: 1, y: 1 })?.id).toBe("ring");
    expect(hitTest([ring], { x: 5, y: 5 })).toBeNull();
  });

  it("un punto dentro del bbox pero fuera de una curva no golpea (círculo)", () => {
    const circle = obj("circle", "M0 5 A5 5 0 1 1 10 5 A5 5 0 1 1 0 5Z");
    expect(hitTest([circle], { x: 5, y: 5 })?.id).toBe("circle");
    expect(hitTest([circle], { x: 0.4, y: 0.4 })).toBeNull();
  });

  it("respeta la matriz: traslación y rotación (una esquina rotada deja de ser parte del objeto)", () => {
    const moved = obj("moved", "M0 0 H10 V10 H0 Z", { matrix: translationMatrix(100, 100) });
    expect(hitTest([moved], { x: 105, y: 105 })?.id).toBe("moved");
    expect(hitTest([moved], { x: 5, y: 5 })).toBeNull();

    const diamond = obj("diamond", "M0 0 H10 V10 H0 Z", { matrix: rotationAboutMatrix({ x: 5, y: 5 }, 45) });
    expect(hitTest([diamond], { x: 0.5, y: 0.5 })).toBeNull();
    expect(hitTest([diamond], { x: 5, y: -1.5 })?.id).toBe("diamond");
  });

  it("tolerancia en px de pantalla -> unidades de documento: un trazo fino se clickea a zoom bajo y no a zoom alto", () => {
    const thin = obj("thin", "M0 0 H100 V0.5 H0 Z");
    const point = { x: 50, y: 2.5 }; // a 2 unidades de documento del borde del trazo
    const lowZoom = screenToleranceToDocument(4, 0.5); // 8 unidades
    const highZoom = screenToleranceToDocument(4, 8); // 0.5 unidades
    expect(hitTest([thin], point, lowZoom)?.id).toBe("thin");
    expect(hitTest([thin], point, highZoom)).toBeNull();
    expect(hitTest([thin], point, 0)).toBeNull();
  });

  it("tolerancia cerca del borde de un hueco", () => {
    const ring = obj("ring", "M0 0 H10 V10 H0 Z M3 3 V7 H7 V3 Z");
    expect(hitTest([ring], { x: 3.2, y: 5 }, 0.5)?.id).toBe("ring");
    expect(hitTest([ring], { x: 3.2, y: 5 }, 0.1)).toBeNull();
  });

  it("objeto sin relleno (fill none): solo el contorno, con tolerancia", () => {
    const outline = obj("outline", "M0 0 H10 V10 H0 Z", { fill: "none" });
    expect(hitTest([outline], { x: 5, y: 5 })).toBeNull();
    expect(hitTest([outline], { x: 5, y: 0.3 }, 0.5)?.id).toBe("outline");
  });

  it("objetos sin geometría o con matriz inválida nunca golpean", () => {
    expect(hitTest([obj("e", ""), obj("n", "M0 0 H5 V5 Z", { matrix: { ...IDENTITY, a: Number.NaN } })], { x: 1, y: 1 })).toBeNull();
  });
});

describe("objectsInRect (marquee por intersección de bbox)", () => {
  const a = obj("a", "M0 0 H10 V10 H0 Z");
  const b = obj("b", "M0 0 H10 V10 H0 Z", { matrix: translationMatrix(100, 0) });
  const c = obj("c", "M0 0 H10 V10 H0 Z", { matrix: translationMatrix(0, 100) });

  it("incluye los que el rectángulo toca o corta parcialmente, no los lejanos", () => {
    expect(objectsInRect([a, b, c], { x: 5, y: 5, width: 3, height: 3 }).map((o) => o.id)).toEqual(["a"]);
    expect(objectsInRect([a, b, c], { x: 8, y: -5, width: 100, height: 10 }).map((o) => o.id)).toEqual(["a", "b"]);
    expect(objectsInRect([a, b, c], { x: -1000, y: -1000, width: 5000, height: 5000 }).map((o) => o.id)).toEqual(["a", "b", "c"]);
  });

  it("rectángulo sobre el borde cuenta; fuera por una fracción no", () => {
    expect(objectsInRect([a], { x: 10, y: 10, width: 5, height: 5 })).toHaveLength(1);
    expect(objectsInRect([a], { x: 10.001, y: 10.001, width: 5, height: 5 })).toHaveLength(0);
  });

  it("los objetos sin geometría no entran al marquee", () => {
    expect(objectsInRect([obj("empty", "")], { x: -10, y: -10, width: 100, height: 100 })).toEqual([]);
  });
});
