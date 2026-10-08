import { describe, expect, it } from "vitest";
import {
  ARRANGE_ACTIONS,
  ARRANGE_EPSILON,
  ARRANGE_SHORTCUTS,
  alignProduction,
  arrangeAvailability,
  describeArrange,
  distributeProduction,
  matchArrangeShortcut,
  runArrange,
  zOrderActionId,
  zOrderProduction,
  type AlignMode,
  type AlignReference,
  type ArrangeActionId,
  type ArrangeResult,
  type ZOrderAction,
} from "./arrange";
import { rotateFrame90 } from "./frame";
import { objectBounds } from "./objects";
import type { DocumentFrame, EditableDocument, EditableLayerMeta, EditorObject, Rect } from "./types";
import type { ShortcutKeyEvent } from "./clipboard";

/**
 * Alinear / Distribuir / Z-order (M3-S07), lógica pura. Los valores esperados están calculados A MANO (ver el comentario de cada
 * fixture) y se comparan con tolerancia 1e-9: un error de 1e-6 hace fallar los tests.
 */

const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

function meta(overrides: Partial<EditableLayerMeta> & Pick<EditableLayerMeta, "groupId" | "name" | "colorHex" | "order">): EditableLayerMeta {
  return { visible: true, locked: false, manufacturingOperation: "cut", isNew: false, ...overrides };
}

const LAYER_A = meta({ groupId: "A", name: "Rojo", colorHex: "#ff0000", order: 0 });
const LAYER_B = meta({ groupId: "B", name: "Azul", colorHex: "#0000ff", order: 1 });
const LAYER_L = meta({ groupId: "L", name: "Bloqueada", colorHex: "#00ff00", order: 2, locked: true });
const LAYER_H = meta({ groupId: "H", name: "Oculta", colorHex: "#ffff00", order: 3, visible: false });
const ALL_LAYERS = [LAYER_A, LAYER_B, LAYER_L, LAYER_H];

/** Rectángulo con su bbox exacto (x, y, ancho, alto) escrito en `d`; `extra` permite poner una matriz u otros campos. */
function rect(id: string, layer: string, x: number, y: number, width: number, height: number, extra: Partial<EditorObject> = {}): EditorObject {
  return { id, layerGroupId: layer, d: `M${x} ${y} H${x + width} V${y + height} H${x} Z`, fill: "#ff0000", matrix: { ...IDENTITY }, ...extra };
}

function doc(objectsByLayer: Record<string, EditorObject[]>, layers: EditableLayerMeta[] = ALL_LAYERS, frame?: DocumentFrame): EditableDocument {
  return { layers, objectsByLayer, ...(frame ? { frame } : {}) };
}

function allObjects(document: EditableDocument): EditorObject[] {
  return Object.values(document.objectsByLayer).flat();
}

function pick(document: EditableDocument, ...ids: string[]): EditorObject[] {
  const wanted = new Set(ids);
  return allObjects(document).filter((object) => wanted.has(object.id));
}

/** Aplica la producción al documento, como `applyEdit`: reemplaza las capas tocadas. */
function applied(document: EditableDocument, result: ArrangeResult): EditableDocument {
  if (!result.production) throw new Error(`se esperaba una producción (${result.summary.reason})`);
  return { ...document, objectsByLayer: { ...document.objectsByLayer, ...result.production.layers } };
}

function boundsOfId(document: EditableDocument, id: string): Rect {
  const object = allObjects(document).find((candidate) => candidate.id === id);
  const box = object ? objectBounds(object) : null;
  if (!box) throw new Error(`sin bbox: ${id}`);
  return box;
}

function expectRect(actual: Rect, expected: Rect) {
  expect(actual.x).toBeCloseTo(expected.x, 9);
  expect(actual.y).toBeCloseTo(expected.y, 9);
  expect(actual.width).toBeCloseTo(expected.width, 9);
  expect(actual.height).toBeCloseTo(expected.height, 9);
}

function ids(objects: readonly EditorObject[]): string[] {
  return objects.map((object) => object.id);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Alinear
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * o1 = (10,20) 30×10 -> x 10..40, y 20..30
 * o2 = (50,10) 20×40 -> x 50..70, y 10..50
 * o3 = (30,40) 10×10 -> x 30..40, y 40..50
 * Unión de o1+o2: x 10..70, y 10..50 (centro 40, 30). o3 queda dentro de esa unión, así que la unión de los tres es la misma.
 */
function alignFixture(): EditableDocument {
  return doc({ A: [rect("o1", "A", 10, 20, 30, 10), rect("o2", "A", 50, 10, 20, 40), rect("o3", "A", 30, 40, 10, 10)], B: [], L: [], H: [] });
}

const align = (document: EditableDocument, selected: string[], mode: AlignMode, reference: AlignReference = "selection", frame?: DocumentFrame) =>
  alignProduction(document, pick(document, ...selected), { mode, reference, frame });

describe("alignProduction — referencia Selección, 2 objetos de tamaños distintos", () => {
  it("izquierda: la unión empieza en x=10 -> o2 se mueve -40 (x 10..30); o1 ya estaba", () => {
    const document = alignFixture();
    const result = align(document, ["o1", "o2"], "left");
    const after = applied(document, result);
    expectRect(boundsOfId(after, "o1"), { x: 10, y: 20, width: 30, height: 10 });
    expectRect(boundsOfId(after, "o2"), { x: 10, y: 10, width: 20, height: 40 });
    expect(result.summary.moved).toBe(1);
    expect(result.label).toBe("Alinear a la izquierda");
  });

  it("centro horizontal: centro de la unión x=40 -> o1 (centro 25) +15 => 25..55; o2 (centro 60) -20 => 30..50", () => {
    const document = alignFixture();
    const after = applied(document, align(document, ["o1", "o2"], "center"));
    expectRect(boundsOfId(after, "o1"), { x: 25, y: 20, width: 30, height: 10 });
    expectRect(boundsOfId(after, "o2"), { x: 30, y: 10, width: 20, height: 40 });
  });

  it("derecha: borde derecho de la unión x=70 -> o1 (borde 40) +30 => 40..70; o2 ya estaba", () => {
    const document = alignFixture();
    const result = align(document, ["o1", "o2"], "right");
    const after = applied(document, result);
    expectRect(boundsOfId(after, "o1"), { x: 40, y: 20, width: 30, height: 10 });
    expectRect(boundsOfId(after, "o2"), { x: 50, y: 10, width: 20, height: 40 });
    expect(result.summary.moved).toBe(1);
  });

  it("arriba: borde superior de la unión y=10 -> o1 (y 20) -10 => 10..20; o2 ya estaba", () => {
    const document = alignFixture();
    const after = applied(document, align(document, ["o1", "o2"], "top"));
    expectRect(boundsOfId(after, "o1"), { x: 10, y: 10, width: 30, height: 10 });
    expectRect(boundsOfId(after, "o2"), { x: 50, y: 10, width: 20, height: 40 });
  });

  it("centro vertical (middle): centro de la unión y=30 -> o1 (centro 25) +5 => y 25..35; o2 (centro 30) ya estaba", () => {
    const document = alignFixture();
    const result = align(document, ["o1", "o2"], "middle");
    const after = applied(document, result);
    expectRect(boundsOfId(after, "o1"), { x: 10, y: 25, width: 30, height: 10 });
    expectRect(boundsOfId(after, "o2"), { x: 50, y: 10, width: 20, height: 40 });
    expect(result.summary.moved).toBe(1);
  });

  it("abajo: borde inferior de la unión y=50 -> o1 (borde 30) +20 => y 40..50; o2 ya estaba", () => {
    const document = alignFixture();
    const after = applied(document, align(document, ["o1", "o2"], "bottom"));
    expectRect(boundsOfId(after, "o1"), { x: 10, y: 40, width: 30, height: 10 });
    expectRect(boundsOfId(after, "o2"), { x: 50, y: 10, width: 20, height: 40 });
  });
});

describe("alignProduction — referencia Selección, 3 objetos de tamaños distintos", () => {
  const cases: Array<[AlignMode, Record<string, Rect>]> = [
    // izquierda x=10: o1 0, o2 -40, o3 -20
    ["left", { o1: { x: 10, y: 20, width: 30, height: 10 }, o2: { x: 10, y: 10, width: 20, height: 40 }, o3: { x: 10, y: 40, width: 10, height: 10 } }],
    // centro x=40: o1 +15 (centro 25), o2 -20 (centro 60), o3 +5 (centro 35)
    ["center", { o1: { x: 25, y: 20, width: 30, height: 10 }, o2: { x: 30, y: 10, width: 20, height: 40 }, o3: { x: 35, y: 40, width: 10, height: 10 } }],
    // derecha x=70: o1 +30, o2 0, o3 +30 (borde 40)
    ["right", { o1: { x: 40, y: 20, width: 30, height: 10 }, o2: { x: 50, y: 10, width: 20, height: 40 }, o3: { x: 60, y: 40, width: 10, height: 10 } }],
    // arriba y=10: o1 -10, o2 0, o3 -30
    ["top", { o1: { x: 10, y: 10, width: 30, height: 10 }, o2: { x: 50, y: 10, width: 20, height: 40 }, o3: { x: 30, y: 10, width: 10, height: 10 } }],
    // middle y=30: o1 +5, o2 0, o3 -15 (centro 45)
    ["middle", { o1: { x: 10, y: 25, width: 30, height: 10 }, o2: { x: 50, y: 10, width: 20, height: 40 }, o3: { x: 30, y: 25, width: 10, height: 10 } }],
    // abajo y=50: o1 +20, o2 0, o3 0
    ["bottom", { o1: { x: 10, y: 40, width: 30, height: 10 }, o2: { x: 50, y: 10, width: 20, height: 40 }, o3: { x: 30, y: 40, width: 10, height: 10 } }],
  ];

  it.each(cases)("%s: cada objeto cae en su posición calculada a mano", (mode, expected) => {
    const document = alignFixture();
    const after = applied(document, align(document, ["o1", "o2", "o3"], mode));
    for (const [id, box] of Object.entries(expected)) expectRect(boundsOfId(after, id), box);
  });

  it("solo se mueven los que no estaban en su sitio: los demás conservan su referencia exacta", () => {
    const document = alignFixture();
    const result = align(document, ["o1", "o2", "o3"], "bottom");
    const [o1, o2, o3] = document.objectsByLayer.A;
    const out = result.production!.layers.A;
    expect(out[0]).not.toBe(o1);
    expect(out[1]).toBe(o2);
    expect(out[2]).toBe(o3);
    expect(result.summary.moved).toBe(1);
    expect(result.summary.considered).toBe(3);
  });
});

describe("alignProduction — referencia Documento (marco vigente de S02)", () => {
  /** Marco recortado: origen (5,5), 100×80 -> x 5..105, y 5..85 (centro 55, 45). */
  const FRAME: DocumentFrame = { x: 5, y: 5, width: 100, height: 80 };

  it("con UN solo objeto sí se puede: izquierda x=5 => o1 (x 10) se mueve -5", () => {
    const document = alignFixture();
    const result = align(document, ["o1"], "left", "document", FRAME);
    expectRect(boundsOfId(applied(document, result), "o1"), { x: 5, y: 20, width: 30, height: 10 });
  });

  it.each([
    // izquierda 5: o1 10 -> -5 ; o2 50 -> -45
    ["left", { o1: { x: 5, y: 20, width: 30, height: 10 }, o2: { x: 5, y: 10, width: 20, height: 40 } }],
    // centro x=55: o1 centro 25 -> +30 (x 40..70); o2 centro 60 -> -5 (x 45..65)
    ["center", { o1: { x: 40, y: 20, width: 30, height: 10 }, o2: { x: 45, y: 10, width: 20, height: 40 } }],
    // derecha 105: o1 borde 40 -> +65 (x 75..105); o2 borde 70 -> +35 (x 85..105)
    ["right", { o1: { x: 75, y: 20, width: 30, height: 10 }, o2: { x: 85, y: 10, width: 20, height: 40 } }],
    // arriba 5: o1 y 20 -> -15 ; o2 y 10 -> -5
    ["top", { o1: { x: 10, y: 5, width: 30, height: 10 }, o2: { x: 50, y: 5, width: 20, height: 40 } }],
    // centro y=45: o1 centro 25 -> +20 (y 40..50); o2 centro 30 -> +15 (y 25..65)
    ["middle", { o1: { x: 10, y: 40, width: 30, height: 10 }, o2: { x: 50, y: 25, width: 20, height: 40 } }],
    // abajo 85: o1 borde 30 -> +55 (y 75..85); o2 borde 50 -> +35 (y 45..85)
    ["bottom", { o1: { x: 10, y: 75, width: 30, height: 10 }, o2: { x: 50, y: 45, width: 20, height: 40 } }],
  ] as Array<[AlignMode, Record<string, Rect>]>)("%s: los objetos se llevan al marco, no a su propia unión", (mode, expected) => {
    const document = alignFixture();
    const after = applied(document, align(document, ["o1", "o2"], mode, "document", FRAME));
    for (const [id, box] of Object.entries(expected)) expectRect(boundsOfId(after, id), box);
  });

  it("marco ROTADO 90° (200×100 -> origen (50,-50), 100×200): derecha = 150 y abajo = 150", () => {
    const rotated = rotateFrame90({ x: 0, y: 0, width: 200, height: 100 }, 1);
    expect(rotated).toEqual({ x: 50, y: -50, width: 100, height: 200 });
    const document = alignFixture();
    const right = applied(document, align(document, ["o1"], "right", "document", rotated));
    expectRect(boundsOfId(right, "o1"), { x: 120, y: 20, width: 30, height: 10 });
    const bottom = applied(document, align(document, ["o1"], "bottom", "document", rotated));
    expectRect(boundsOfId(bottom, "o1"), { x: 10, y: 140, width: 30, height: 10 });
  });

  it("sin la opción `frame` usa el marco del documento (`document.frame`)", () => {
    const document = doc(alignFixture().objectsByLayer, ALL_LAYERS, FRAME);
    const after = applied(document, alignProduction(document, pick(document, "o1"), { mode: "left", reference: "document" }));
    expectRect(boundsOfId(after, "o1"), { x: 5, y: 20, width: 30, height: 10 });
  });

  it("sin marco válido se rechaza con motivo (y sin producción)", () => {
    const document = alignFixture();
    const none = alignProduction(document, pick(document, "o1"), { mode: "left", reference: "document" });
    expect(none.production).toBeNull();
    expect(none.summary.noop).toBe(false);
    expect(none.summary.reason).toMatch(/área de trabajo no es válida/);
    const invalid = alignProduction(document, pick(document, "o1"), { mode: "left", reference: "document", frame: { x: 0, y: 0, width: 0, height: 10 } });
    expect(invalid.production).toBeNull();
  });
});

describe("alignProduction — geometría exacta (matrices y curvas)", () => {
  it("curva Bézier: usa el bbox EXACTO de la curva, no el de sus puntos de control", () => {
    // M0 0 C0 20 20 20 20 0: y(t)=60·t·(1-t) => máximo 15 en t=0.5 (los puntos de control llegarían a 20). x en 0..20.
    // Trasladada (30,10): bbox x 30..50, y 10..25. El rect r ocupa y 12..42 => unión y 10..42 => abajo = 42: la curva (borde 25) +17.
    const curve: EditorObject = { id: "c", layerGroupId: "A", d: "M0 0 C0 20 20 20 20 0", fill: "#ff0000", matrix: { ...IDENTITY, e: 30, f: 10 } };
    const r = rect("r", "A", 100, 12, 10, 30);
    const document = doc({ A: [curve, r] });
    expectRect(boundsOfId(document, "c"), { x: 30, y: 10, width: 20, height: 15 });
    const result = align(document, ["c", "r"], "bottom");
    const after = applied(document, result);
    expectRect(boundsOfId(after, "c"), { x: 30, y: 27, width: 20, height: 15 });
    // `d` intacto (no se hornea) y la matriz solo cambia en f: f = 10 + 17.
    const moved = after.objectsByLayer.A[0];
    expect(moved.d).toBe(curve.d);
    expect(moved.matrix).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 30, f: 27 });
  });

  it("objeto ROTADO 90° (matriz {0 1 -1 0 100 50}): bbox x 90..100, y 50..70; izquierda al x=0 del marco => e pasa de 100 a 0", () => {
    // Rect 20×10 en el origen: (x,y) -> (-y, x) + (100,50): esquinas (100,50) (100,70) (90,70) (90,50).
    const rotated: EditorObject = { id: "rot", layerGroupId: "A", d: "M0 0 H20 V10 H0 Z", fill: "#ff0000", matrix: { a: 0, b: 1, c: -1, d: 0, e: 100, f: 50 } };
    const document = doc({ A: [rotated] });
    expectRect(boundsOfId(document, "rot"), { x: 90, y: 50, width: 10, height: 20 });
    const result = align(document, ["rot"], "left", "document", { x: 0, y: 0, width: 200, height: 100 });
    const after = applied(document, result);
    expectRect(boundsOfId(after, "rot"), { x: 0, y: 50, width: 10, height: 20 });
    expect(after.objectsByLayer.A[0].matrix).toEqual({ a: 0, b: 1, c: -1, d: 0, e: 10, f: 50 });
    expect(after.objectsByLayer.A[0].d).toBe("M0 0 H20 V10 H0 Z");
  });

  it("objeto ESCALADO (matriz {2 0 0 3 10 10}) sobre un rect 5×4: bbox x 10..20, y 10..22; centro vertical con otro objeto", () => {
    const scaled: EditorObject = { id: "sc", layerGroupId: "A", d: "M0 0 H5 V4 H0 Z", fill: "#ff0000", matrix: { a: 2, b: 0, c: 0, d: 3, e: 10, f: 10 } };
    const other = rect("ot", "A", 40, 0, 10, 40); // y 0..40, centro 20
    const document = doc({ A: [scaled, other] });
    expectRect(boundsOfId(document, "sc"), { x: 10, y: 10, width: 10, height: 12 });
    // unión y 0..40 => centro 20: sc (centro 16) +4; other (centro 20) ya estaba.
    const after = applied(document, align(document, ["sc", "ot"], "middle"));
    expectRect(boundsOfId(after, "sc"), { x: 10, y: 14, width: 10, height: 12 });
    expect(after.objectsByLayer.A[0].matrix).toEqual({ a: 2, b: 0, c: 0, d: 3, e: 10, f: 14 });
  });

  it("objeto girado 45° (no múltiplo de 90): bbox x ±10·√½, y 0..20·√½; izquierda lo lleva exactamente al x pedido", () => {
    const s = Math.SQRT1_2;
    // Cuadrado 10×10 girado 45° en el origen: esquinas (0,0) (7.07,7.07) (0,14.14) (-7.07,7.07).
    const diamond: EditorObject = { id: "dm", layerGroupId: "A", d: "M0 0 H10 V10 H0 Z", fill: "#ff0000", matrix: { a: s, b: s, c: -s, d: s, e: 0, f: 0 } };
    const document = doc({ A: [diamond] });
    expectRect(boundsOfId(document, "dm"), { x: -10 * s, y: 0, width: 20 * s, height: 20 * s });
    const after = applied(document, align(document, ["dm"], "left", "document", { x: 3, y: 0, width: 50, height: 50 }));
    expectRect(boundsOfId(after, "dm"), { x: 3, y: 0, width: 20 * s, height: 20 * s });
  });

  it("alinear solo traslada: a/b/c/d de la matriz y `d` no cambian (no se hornea)", () => {
    const document = alignFixture();
    const result = align(document, ["o1", "o2", "o3"], "left");
    for (const object of result.production!.layers.A) {
      const before = document.objectsByLayer.A.find((candidate) => candidate.id === object.id)!;
      expect(object.d).toBe(before.d);
      expect(object.fill).toBe(before.fill);
      expect(object.matrix.a).toBe(before.matrix.a);
      expect(object.matrix.b).toBe(before.matrix.b);
      expect(object.matrix.c).toBe(before.matrix.c);
      expect(object.matrix.d).toBe(before.matrix.d);
    }
    // o3 (x 30..40) a x=10: matriz e = -20, f = 0 (alinear a la izquierda no toca y).
    expect(result.production!.layers.A[2].matrix.e).toBeCloseTo(-20, 12);
    expect(result.production!.layers.A[2].matrix.f).toBe(0);
  });

  it("un desfase de 1e-6 SÍ se corrige exactamente (la tolerancia de 'ya alineado' es 1e-9)", () => {
    const document = doc({ A: [rect("p", "A", 10, 0, 10, 10), rect("q", "A", 10.000001, 20, 10, 10)] });
    const result = align(document, ["p", "q"], "left");
    expect(result.production).not.toBeNull();
    expect(result.production!.layers.A[1].matrix.e).toBeCloseTo(-0.000001, 12);
    expectRect(boundsOfId(applied(document, result), "q"), { x: 10, y: 20, width: 10, height: 10 });
  });
});

describe("alignProduction — ya alineado, rechazos y bloqueados", () => {
  it("ya alineado: sin producción (la pila de undo no crece), noop y 'Ya está alineado.'", () => {
    const document = doc({ A: [rect("p", "A", 10, 0, 10, 10), rect("q", "A", 10, 20, 30, 10)] });
    const result = align(document, ["p", "q"], "left");
    expect(result.production).toBeNull();
    expect(result.summary.noop).toBe(true);
    expect(result.summary.reason).toBe("Ya está alineado.");
    expect(result.summary.moved).toBe(0);
  });

  it("el ruido de punto flotante (1e-12) cuenta como ya alineado", () => {
    const document = doc({ A: [rect("p", "A", 10, 0, 10, 10), rect("q", "A", 10 + 1e-12, 20, 30, 10)] });
    expect(ARRANGE_EPSILON).toBeGreaterThan(1e-12);
    expect(align(document, ["p", "q"], "left").production).toBeNull();
  });

  it("alinear dos veces seguidas: la segunda no hace nada", () => {
    const document = alignFixture();
    const first = align(document, ["o1", "o2", "o3"], "center");
    const second = align(applied(document, first), ["o1", "o2", "o3"], "center");
    expect(second.production).toBeNull();
    expect(second.summary.noop).toBe(true);
  });

  it("sin selección: rechazo 'Seleccioná objetos para alinear.' (no es un no-op)", () => {
    const document = alignFixture();
    const result = align(document, [], "left");
    expect(result.production).toBeNull();
    expect(result.summary.noop).toBe(false);
    expect(result.summary.reason).toBe("Seleccioná objetos para alinear.");
  });

  it("un id que ya no existe en el documento se descarta (la selección se relee del documento)", () => {
    const document = alignFixture();
    const ghost = rect("fantasma", "A", 0, 0, 1, 1);
    const result = alignProduction(document, [ghost], { mode: "left", reference: "document", frame: { x: 0, y: 0, width: 100, height: 100 } });
    expect(result.production).toBeNull();
    expect(result.summary.reason).toBe("Seleccioná objetos para alinear.");
  });

  it("referencia Selección con UN objeto movible: rechazo con motivo que sugiere 'Documento'", () => {
    const document = alignFixture();
    const result = align(document, ["o1"], "left");
    expect(result.production).toBeNull();
    expect(result.summary.noop).toBe(false);
    expect(result.summary.reason).toMatch(/2 o más objetos movibles/);
    expect(result.summary.reason).toMatch(/Documento/);
  });

  describe("capas bloqueadas", () => {
    /** o1 (10..40) y o2 (50..70) editables; lk1 está en la capa L bloqueada, x 200..250. */
    function lockedFixture() {
      return doc({ A: [rect("o1", "A", 10, 20, 30, 10), rect("o2", "A", 50, 10, 20, 40)], B: [], L: [rect("lk1", "L", 200, 0, 50, 10)], H: [] });
    }

    it("no se mueven y NO cuentan para la referencia: izquierda de la selección = x 10 (no 10..250)", () => {
      const document = lockedFixture();
      const result = align(document, ["o1", "o2", "lk1"], "right");
      // Sin el bloqueado la unión termina en x=70 (con él, en 250): o1 +30 => 40..70.
      expectRect(boundsOfId(applied(document, result), "o1"), { x: 40, y: 20, width: 30, height: 10 });
      expect(Object.keys(result.production!.layers)).toEqual(["A"]);
      expect(result.summary.skippedLocked).toBe(1);
      expect(result.summary.considered).toBe(2);
    });

    it("lo bloqueado conserva su referencia y la capa L ni aparece en la producción", () => {
      const document = lockedFixture();
      const result = align(document, ["o1", "o2", "lk1"], "left");
      expect(result.production!.layers.L).toBeUndefined();
      expect(Object.values(result.production!.layers).flat().some((object) => object.id === "lk1")).toBe(false);
      expect(boundsOfId(applied(document, result), "lk1")).toEqual({ x: 200, y: 0, width: 50, height: 10 });
    });

    it("también se excluye si la capa viene en `lockedLayerIds` (sin meta en `layers`)", () => {
      const document = doc({ A: [rect("o1", "A", 10, 20, 30, 10), rect("o2", "A", 50, 10, 20, 40), rect("o3", "A", 300, 0, 10, 10)] }, []);
      const result = alignProduction(document, pick(document, "o1", "o2", "o3"), {
        mode: "left",
        reference: "selection",
        lockedLayerIds: new Set(["A"]),
      });
      expect(result.production).toBeNull();
      expect(result.summary.reason).toMatch(/capas bloqueadas/);
    });

    it("1 editable + 1 bloqueado con referencia Selección: solo hay UN movible => rechazo; con referencia Documento sí alinea", () => {
      const document = lockedFixture();
      const rejected = align(document, ["o1", "lk1"], "left");
      expect(rejected.production).toBeNull();
      expect(rejected.summary.reason).toMatch(/2 o más objetos movibles/);
      expect(rejected.summary.skippedLocked).toBe(1);
      const ok = align(document, ["o1", "lk1"], "left", "document", { x: 0, y: 0, width: 300, height: 100 });
      expectRect(boundsOfId(applied(document, ok), "o1"), { x: 0, y: 20, width: 30, height: 10 });
      expect(ok.summary.skippedLocked).toBe(1);
    });

    it("selección SOLO bloqueada: rechazo que explica el bloqueo", () => {
      const document = lockedFixture();
      const result = align(document, ["lk1"], "left", "document", { x: 0, y: 0, width: 300, height: 100 });
      expect(result.production).toBeNull();
      expect(result.summary.noop).toBe(false);
      expect(result.summary.reason).toMatch(/capas bloqueadas/);
      expect(result.summary.skippedLocked).toBe(1);
    });

    it("una capa oculta se trata igual que una bloqueada (defensa en profundidad)", () => {
      const document = doc({ A: [rect("o1", "A", 10, 20, 30, 10), rect("o2", "A", 50, 10, 20, 40)], H: [rect("h1", "H", 900, 0, 10, 10)] });
      const result = align(document, ["o1", "o2", "h1"], "right");
      expect(result.production!.layers.H).toBeUndefined();
      expect(result.summary.skippedHidden).toBe(1);
      expectRect(boundsOfId(applied(document, result), "o1"), { x: 40, y: 20, width: 30, height: 10 });
    });

    it("el ya-alineado también informa lo omitido por bloqueo", () => {
      const document = doc({ A: [rect("p", "A", 10, 0, 10, 10), rect("q", "A", 10, 20, 30, 10)], L: [rect("lk1", "L", 200, 0, 50, 10)] });
      const result = align(document, ["p", "q", "lk1"], "left");
      expect(result.production).toBeNull();
      expect(result.summary.noop).toBe(true);
      expect(result.summary.skippedLocked).toBe(1);
    });
  });

  it("objetos sin geometría no se pueden ubicar: se omiten (y no rompen la referencia)", () => {
    const empty: EditorObject = { id: "vacio", layerGroupId: "A", d: "", fill: "#ff0000", matrix: { ...IDENTITY } };
    const document = doc({ A: [rect("o1", "A", 10, 20, 30, 10), rect("o2", "A", 50, 10, 20, 40), empty] });
    const result = align(document, ["o1", "o2", "vacio"], "left");
    expect(result.summary.skippedEmpty).toBe(1);
    expect(result.summary.considered).toBe(2);
    expect(result.production!.layers.A[2]).toBe(empty);
    const onlyEmpty = align(document, ["vacio"], "left", "document", { x: 0, y: 0, width: 10, height: 10 });
    expect(onlyEmpty.production).toBeNull();
    expect(onlyEmpty.summary.reason).toMatch(/no tienen geometría/);
  });

  it("varias capas: cada objeto se mueve DENTRO de su capa (layerGroupId e ids intactos) y la producción trae las dos", () => {
    // a1 0..10 (centro 5) y b1 50..70 (centro 60): la unión 0..70 tiene centro 35 => a1 +30 (30..40), b1 -25 (25..45).
    const document = doc({ A: [rect("a1", "A", 0, 0, 10, 10)], B: [rect("b1", "B", 50, 30, 20, 10)] });
    const result = align(document, ["a1", "b1"], "center");
    expect(Object.keys(result.production!.layers).sort()).toEqual(["A", "B"]);
    for (const [layerId, objects] of Object.entries(result.production!.layers)) {
      for (const object of objects) expect(object.layerGroupId).toBe(layerId);
    }
    expect(ids(result.production!.layers.A)).toEqual(["a1"]);
    expect(ids(result.production!.layers.B)).toEqual(["b1"]);
    expectRect(boundsOfId(applied(document, result), "a1"), { x: 30, y: 0, width: 10, height: 10 });
    expectRect(boundsOfId(applied(document, result), "b1"), { x: 25, y: 30, width: 20, height: 10 });
  });

  it("no muta el documento de entrada (arreglos y objetos congelados)", () => {
    const document = alignFixture();
    for (const objects of Object.values(document.objectsByLayer)) {
      objects.forEach((object) => Object.freeze(object));
      Object.freeze(objects);
    }
    expect(() => align(document, ["o1", "o2", "o3"], "right")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Distribuir
// ---------------------------------------------------------------------------------------------------------------------------------

const distribute = (document: EditableDocument, selected: string[], axis: "horizontal" | "vertical") => distributeProduction(document, pick(document, ...selected), { axis });

describe("distributeProduction — horizontal / vertical", () => {
  it("3 objetos de ancho distinto: huecos iguales de 30 (A 0..10, B 20..50, C 100..140 => B pasa a 40..70)", () => {
    // suma de anchos = 10 + 30 + 40 = 80; tramo = 140 - 0; hueco = (140 - 80) / 2 = 30; B = 0 + 10 + 30 = 40 (dx +20).
    const document = doc({ A: [rect("A1", "A", 0, 0, 10, 10), rect("B1", "A", 20, 5, 30, 10), rect("C1", "A", 100, 0, 40, 10)] });
    const result = distribute(document, ["A1", "B1", "C1"], "horizontal");
    const after = applied(document, result);
    expectRect(boundsOfId(after, "A1"), { x: 0, y: 0, width: 10, height: 10 });
    expectRect(boundsOfId(after, "B1"), { x: 40, y: 5, width: 30, height: 10 });
    expectRect(boundsOfId(after, "C1"), { x: 100, y: 0, width: 40, height: 10 });
    expect(result.summary.gap).toBeCloseTo(30, 9);
    expect(result.summary.moved).toBe(1);
    expect(result.label).toBe("Distribuir horizontalmente");
  });

  it("los extremos quedan FIJOS (misma referencia) y solo cambia el eje de la distribución", () => {
    const document = doc({ A: [rect("A1", "A", 0, 0, 10, 10), rect("B1", "A", 20, 5, 30, 10), rect("C1", "A", 100, 0, 40, 10)] });
    const result = distribute(document, ["A1", "B1", "C1"], "horizontal");
    const [a1, b1, c1] = document.objectsByLayer.A;
    expect(result.production!.layers.A[0]).toBe(a1);
    expect(result.production!.layers.A[2]).toBe(c1);
    expect(result.production!.layers.A[1].matrix.f).toBe(b1.matrix.f);
    expect(result.production!.layers.A[1].matrix.e).toBeCloseTo(20, 12);
  });

  it("4 objetos: huecos iguales de 20 (A 0..10, B 15..25, C 30..50, D 100..120 => B 30..40, C 60..80)", () => {
    // anchos 10+10+20+20 = 60; tramo 120; hueco = 60 / 3 = 20; B = 0 + 10 + 20 = 30 (dx +15); C = 0 + 20 + 40 = 60 (dx +30).
    const document = doc({ A: [rect("A1", "A", 0, 0, 10, 10), rect("B1", "A", 15, 0, 10, 10), rect("C1", "A", 30, 0, 20, 10), rect("D1", "A", 100, 0, 20, 10)] });
    const result = distribute(document, ["A1", "B1", "C1", "D1"], "horizontal");
    const after = applied(document, result);
    expectRect(boundsOfId(after, "B1"), { x: 30, y: 0, width: 10, height: 10 });
    expectRect(boundsOfId(after, "C1"), { x: 60, y: 0, width: 20, height: 10 });
    expect(result.summary.moved).toBe(2);
    expect(result.summary.gap).toBeCloseTo(20, 9);
  });

  it("el orden se determina por POSICIÓN, no por el orden de pintado: el resultado es el mismo y los arreglos conservan su orden", () => {
    const document = doc({ A: [rect("C1", "A", 100, 0, 40, 10), rect("A1", "A", 0, 0, 10, 10), rect("B1", "A", 20, 5, 30, 10)] });
    const result = distribute(document, ["A1", "B1", "C1"], "horizontal");
    expectRect(boundsOfId(applied(document, result), "B1"), { x: 40, y: 5, width: 30, height: 10 });
    expect(ids(result.production!.layers.A)).toEqual(["C1", "A1", "B1"]);
  });

  it("vertical: misma lógica sobre y (A 0..10, B 20..50, C 100..140 => B pasa a y 40..70)", () => {
    const document = doc({ A: [rect("A1", "A", 0, 0, 10, 10), rect("B1", "A", 5, 20, 10, 30), rect("C1", "A", 0, 100, 10, 40)] });
    const result = distribute(document, ["A1", "B1", "C1"], "vertical");
    const after = applied(document, result);
    expectRect(boundsOfId(after, "B1"), { x: 5, y: 40, width: 10, height: 30 });
    expect(result.label).toBe("Distribuir verticalmente");
  });

  it("solapados: hueco total NEGATIVO e igual (A 0..50, B 10..40, C 20..70 => hueco -30, B pasa a 20..50)", () => {
    // anchos 50+30+50 = 130; tramo = 70 - 0; hueco = (70 - 130) / 2 = -30; B = 0 + 50 - 30 = 20 (dx +10).
    const document = doc({ A: [rect("A1", "A", 0, 0, 50, 10), rect("B1", "A", 10, 0, 30, 10), rect("C1", "A", 20, 0, 50, 10)] });
    const result = distribute(document, ["A1", "B1", "C1"], "horizontal");
    const after = applied(document, result);
    expectRect(boundsOfId(after, "B1"), { x: 20, y: 0, width: 30, height: 10 });
    expect(result.summary.gap).toBeCloseTo(-30, 9);
    expect(result.production).not.toBeNull();
    // Se informa: el mensaje habla de solapamiento y del hueco negativo.
    const message = describeArrange("distribute-horizontal", result, { mmPerUnit: null, reference: "selection" });
    expect(message.kind).toBe("ok");
    expect(message.text).toMatch(/solapan/);
    expect(message.text).toMatch(/negativos iguales de -30 u/);
  });

  describe("empates (desempate estable por orden de pintado)", () => {
    // p y q empiezan ambos en x=0 (anchos 10 y 20); r está en 100..110. Suma de anchos 40; tramo 110 => hueco 35.
    it("pintado [p, q, r]: p primero => q = 0 + 10 + 35 = 45 (dx +45)", () => {
      const document = doc({ A: [rect("p", "A", 0, 0, 10, 10), rect("q", "A", 0, 20, 20, 10), rect("r", "A", 100, 0, 10, 10)] });
      const after = applied(document, distribute(document, ["p", "q", "r"], "horizontal"));
      expectRect(boundsOfId(after, "q"), { x: 45, y: 20, width: 20, height: 10 });
      expectRect(boundsOfId(after, "p"), { x: 0, y: 0, width: 10, height: 10 });
    });

    it("pintado [q, p, r]: q primero => p = 0 + 20 + 35 = 55 (dx +55)", () => {
      const document = doc({ A: [rect("q", "A", 0, 20, 20, 10), rect("p", "A", 0, 0, 10, 10), rect("r", "A", 100, 0, 10, 10)] });
      const after = applied(document, distribute(document, ["p", "q", "r"], "horizontal"));
      expectRect(boundsOfId(after, "p"), { x: 55, y: 0, width: 10, height: 10 });
      expectRect(boundsOfId(after, "q"), { x: 0, y: 20, width: 20, height: 10 });
    });

    it("es determinista: dos corridas dan exactamente lo mismo", () => {
      const document = doc({ A: [rect("p", "A", 0, 0, 10, 10), rect("q", "A", 0, 20, 20, 10), rect("r", "A", 100, 0, 10, 10)] });
      const first = distribute(document, ["p", "q", "r"], "horizontal");
      const second = distribute(document, ["p", "q", "r"], "horizontal");
      expect(second.production!.layers.A.map((object) => object.matrix)).toEqual(first.production!.layers.A.map((object) => object.matrix));
    });
  });

  it("objetos con matriz (rotado 90° y escalado) y curva: se distribuyen por sus bounds exactos", () => {
    // rot: rect 20×10 con {0 1 -1 0 e f}: bbox ancho 10, alto 20. En x: e-10..e. Con e=30 => 20..30.
    const rot: EditorObject = { id: "rot", layerGroupId: "A", d: "M0 0 H20 V10 H0 Z", fill: "#ff0000", matrix: { a: 0, b: 1, c: -1, d: 0, e: 30, f: 0 } };
    // curva (ancho 20 exacto, 0..20), trasladada a x=100 => 100..120.
    const curve: EditorObject = { id: "cur", layerGroupId: "A", d: "M0 0 C0 20 20 20 20 0", fill: "#ff0000", matrix: { ...IDENTITY, e: 100 } };
    // escalado: rect 5×4 por 2x => ancho 10, en x=0..10.
    const scaled: EditorObject = { id: "esc", layerGroupId: "A", d: "M0 0 H5 V4 H0 Z", fill: "#ff0000", matrix: { a: 2, b: 0, c: 0, d: 3, e: 0, f: 0 } };
    const document = doc({ A: [rot, curve, scaled] });
    // orden por posición: esc (0..10), rot (20..30), cur (100..120); anchos 10+10+20 = 40; tramo 120; hueco = 40; rot = 0 + 10 + 40 = 50 (dx +30).
    const after = applied(document, distribute(document, ["rot", "cur", "esc"], "horizontal"));
    expectRect(boundsOfId(after, "rot"), { x: 50, y: 0, width: 10, height: 20 });
    expect(after.objectsByLayer.A[0].matrix).toEqual({ a: 0, b: 1, c: -1, d: 0, e: 60, f: 0 });
    expect(after.objectsByLayer.A[0].d).toBe(rot.d);
  });

  it("ya distribuido: sin producción, noop y 'Ya está distribuido con huecos iguales.'", () => {
    const document = doc({ A: [rect("a", "A", 0, 0, 10, 10), rect("b", "A", 30, 0, 10, 10), rect("c", "A", 60, 0, 10, 10)] });
    const result = distribute(document, ["a", "b", "c"], "horizontal");
    expect(result.production).toBeNull();
    expect(result.summary.noop).toBe(true);
    expect(result.summary.reason).toBe("Ya está distribuido con huecos iguales.");
  });

  it("un desfase de 1e-6 en el intermedio SÍ se corrige", () => {
    const document = doc({ A: [rect("a", "A", 0, 0, 10, 10), rect("b", "A", 30.000001, 0, 10, 10), rect("c", "A", 60, 0, 10, 10)] });
    const result = distribute(document, ["a", "b", "c"], "horizontal");
    expect(result.production).not.toBeNull();
    expectRect(boundsOfId(applied(document, result), "b"), { x: 30, y: 0, width: 10, height: 10 });
  });
});

describe("distributeProduction — rechazos y bloqueados", () => {
  it("menos de 3 objetos: rechazo 'requiere 3 o más' (no es no-op), sin producción", () => {
    const document = doc({ A: [rect("a", "A", 0, 0, 10, 10), rect("b", "A", 30, 0, 10, 10)] });
    const two = distribute(document, ["a", "b"], "horizontal");
    expect(two.production).toBeNull();
    expect(two.summary.noop).toBe(false);
    expect(two.summary.reason).toBe("Distribuir requiere 3 o más objetos movibles (hay 2).");
    expect(distribute(document, ["a"], "horizontal").summary.reason).toMatch(/hay 1/);
    expect(distribute(document, [], "horizontal").summary.reason).toBe("Seleccioná objetos para distribuir.");
  });

  it("2 editables + 1 bloqueado: el bloqueado NO cuenta, así que sigue siendo < 3", () => {
    const document = doc({ A: [rect("a", "A", 0, 0, 10, 10), rect("b", "A", 30, 0, 10, 10)], L: [rect("lk", "L", 60, 0, 10, 10)] });
    const result = distribute(document, ["a", "b", "lk"], "horizontal");
    expect(result.production).toBeNull();
    expect(result.summary.reason).toMatch(/hay 2/);
    expect(result.summary.skippedLocked).toBe(1);
  });

  it("el bloqueado NO entra en el cálculo de huecos: A 0..10, B 20..30, C 100..110 con lk 500..600 => B pasa a 50..60", () => {
    // Sin el bloqueado: anchos 30; tramo 110; hueco = 40; B = 0 + 10 + 40 = 50. Si lk contara, el tramo llegaría a 600.
    const document = doc({ A: [rect("A1", "A", 0, 0, 10, 10), rect("B1", "A", 20, 0, 10, 10), rect("C1", "A", 100, 0, 10, 10)], L: [rect("lk", "L", 500, 0, 100, 10)] });
    const result = distribute(document, ["A1", "B1", "C1", "lk"], "horizontal");
    expectRect(boundsOfId(applied(document, result), "B1"), { x: 50, y: 0, width: 10, height: 10 });
    expect(result.production!.layers.L).toBeUndefined();
    expect(result.summary.skippedLocked).toBe(1);
    expect(result.summary.gap).toBeCloseTo(40, 9);
  });

  it("todo bloqueado: rechazo que explica el bloqueo", () => {
    const document = doc({ L: [rect("l1", "L", 0, 0, 10, 10), rect("l2", "L", 30, 0, 10, 10), rect("l3", "L", 90, 0, 10, 10)] });
    const result = distribute(document, ["l1", "l2", "l3"], "horizontal");
    expect(result.production).toBeNull();
    expect(result.summary.reason).toMatch(/capas bloqueadas/);
    expect(result.summary.skippedLocked).toBe(3);
  });

  it("objetos en VARIAS capas se distribuyen juntos y cada uno conserva su capa", () => {
    const document = doc({ A: [rect("a1", "A", 0, 0, 10, 10), rect("a2", "A", 100, 0, 10, 10)], B: [rect("b1", "B", 20, 0, 10, 10)] });
    const result = distribute(document, ["a1", "a2", "b1"], "horizontal");
    // anchos 30; tramo 110; hueco 40; b1 = 0 + 10 + 40 = 50.
    expectRect(boundsOfId(applied(document, result), "b1"), { x: 50, y: 0, width: 10, height: 10 });
    expect(Object.keys(result.production!.layers)).toEqual(["B"]);
    expect(result.production!.layers.B[0].layerGroupId).toBe("B");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Z-order
// ---------------------------------------------------------------------------------------------------------------------------------

/** Capa A = [a1..a5] (a5 arriba), capa B = [b1..b3], capa L (bloqueada) = [l1, l2], capa H (oculta) = [h1, h2]. */
function zFixture(): EditableDocument {
  const layer = (id: string, names: string[]) => names.map((name, index) => rect(name, id, index * 10, 0, 5, 5));
  return doc({
    A: layer("A", ["a1", "a2", "a3", "a4", "a5"]),
    B: layer("B", ["b1", "b2", "b3"]),
    L: layer("L", ["l1", "l2"]),
    H: layer("H", ["h1", "h2"]),
  });
}

const zOrder = (document: EditableDocument, selected: string[], action: ZOrderAction) => zOrderProduction(document, pick(document, ...selected), { action });

/** Invariantes de TODA acción de z-order: ninguna capa pierde ni gana objetos, cada objeto sigue en la suya y las referencias no cambian. */
function expectNoLayerChange(before: EditableDocument, result: ArrangeResult) {
  const after = result.production ? applied(before, result) : before;
  for (const [layerId, objects] of Object.entries(before.objectsByLayer)) {
    expect(ids(after.objectsByLayer[layerId]).sort(), `capa ${layerId}`).toEqual(ids(objects).sort());
    for (const object of after.objectsByLayer[layerId]) {
      expect(object.layerGroupId).toBe(layerId);
      expect(object, `${object.id} misma referencia`).toBe(objects.find((candidate) => candidate.id === object.id));
    }
  }
  expect(Object.keys(after.objectsByLayer)).toEqual(Object.keys(before.objectsByLayer));
  for (const layerId of Object.keys(result.production?.layers ?? {})) expect(Object.keys(before.objectsByLayer)).toContain(layerId);
}

describe("zOrderProduction — un paso (adelante / atrás)", () => {
  it("adelante, selección única: a2 sube un paso => [a1, a3, a2, a4, a5]", () => {
    const document = zFixture();
    const result = zOrder(document, ["a2"], "forward");
    expect(ids(result.production!.layers.A)).toEqual(["a1", "a3", "a2", "a4", "a5"]);
    expect(result.label).toBe("Traer adelante");
    expect(result.summary.moved).toBe(1);
    expectNoLayerChange(document, result);
  });

  it("atrás, selección única: a4 baja un paso => [a1, a2, a4, a3, a5]", () => {
    const document = zFixture();
    const result = zOrder(document, ["a4"], "backward");
    expect(ids(result.production!.layers.A)).toEqual(["a1", "a2", "a4", "a3", "a5"]);
    expect(result.label).toBe("Enviar atrás");
    expectNoLayerChange(document, result);
  });

  it("adelante, selección múltiple NO contigua: cada uno salta al vecino no seleccionado => a2,a4 => [a1, a3, a2, a5, a4]", () => {
    const document = zFixture();
    const result = zOrder(document, ["a2", "a4"], "forward");
    expect(ids(result.production!.layers.A)).toEqual(["a1", "a3", "a2", "a5", "a4"]);
    expect(result.summary.moved).toBe(2);
    expectNoLayerChange(document, result);
  });

  it("adelante, bloque contiguo: a2,a3 saltan JUNTOS por encima de a4 y su orden relativo se conserva => [a1, a4, a2, a3, a5]", () => {
    const document = zFixture();
    const result = zOrder(document, ["a2", "a3"], "forward");
    expect(ids(result.production!.layers.A)).toEqual(["a1", "a4", "a2", "a3", "a5"]);
    expectNoLayerChange(document, result);
  });

  it("atrás, bloque contiguo: a3,a4 bajan juntos por debajo de a2 => [a1, a3, a4, a2, a5]", () => {
    const document = zFixture();
    const result = zOrder(document, ["a3", "a4"], "backward");
    expect(ids(result.production!.layers.A)).toEqual(["a1", "a3", "a4", "a2", "a5"]);
  });

  it("atrás, selección múltiple NO contigua: a2,a4 => [a2, a1, a4, a3, a5]", () => {
    const document = zFixture();
    const result = zOrder(document, ["a2", "a4"], "backward");
    expect(ids(result.production!.layers.A)).toEqual(["a2", "a1", "a4", "a3", "a5"]);
  });

  it("'un paso' se mide contra el vecino NO seleccionado: a3 y a5 (a5 ya está arriba) => solo a3 sube, pasando por a4", () => {
    const document = zFixture();
    const result = zOrder(document, ["a3", "a5"], "forward");
    expect(ids(result.production!.layers.A)).toEqual(["a1", "a2", "a4", "a3", "a5"]);
    expect(result.summary.moved).toBe(1);
  });

  it("un seleccionado nunca cuenta como vecino: a1,a2,a4 hacia adelante => a4 pasa a5, a2 y a1 pasan a3 => [a3, a1, a2, a5, a4]", () => {
    // Arreglo [a1 a2 a3 a4 a5], seleccionados a1,a2,a4. De arriba abajo: a4<->a5 => [a1 a2 a3 a5 a4]; a2<->a3 => [a1 a3 a2 a5 a4]; a1<->a3 => [a3 a1 a2 a5 a4].
    const document = zFixture();
    const result = zOrder(document, ["a1", "a2", "a4"], "forward");
    expect(ids(result.production!.layers.A)).toEqual(["a3", "a1", "a2", "a5", "a4"]);
  });

  it("adelante con la selección en el tope de su capa: sin producción, noop y mensaje 'Ya está al frente de su capa.'", () => {
    const document = zFixture();
    const result = zOrder(document, ["a5"], "forward");
    expect(result.production).toBeNull();
    expect(result.summary.noop).toBe(true);
    expect(result.summary.reason).toBe("Ya está al frente de su capa.");
    const block = zOrder(document, ["a4", "a5"], "forward");
    expect(block.production).toBeNull();
    expect(block.summary.reason).toBe("Ya están al frente de su capa.");
    // Varias capas en el límite: el motivo habla de "sus capas".
    expect(zOrder(document, ["a5", "b3"], "front").summary.reason).toBe("Ya están al frente de sus capas.");
  });

  it("atrás con la selección en el fondo de su capa: sin producción", () => {
    const document = zFixture();
    const result = zOrder(document, ["a1"], "backward");
    expect(result.production).toBeNull();
    expect(result.summary.noop).toBe(true);
    expect(result.summary.reason).toBe("Ya está al fondo de su capa.");
    expect(zOrder(document, ["a1", "a2"], "backward").production).toBeNull();
  });

  it("toda la capa seleccionada: no hay vecino no seleccionado => noop en las cuatro acciones", () => {
    const document = zFixture();
    for (const action of ["forward", "backward", "front", "back"] as ZOrderAction[]) {
      expect(zOrder(document, ["a1", "a2", "a3", "a4", "a5"], action).production, action).toBeNull();
    }
  });
});

describe("zOrderProduction — extremos (frente / fondo)", () => {
  it("al frente conserva el orden relativo: a2,a4 => [a1, a3, a5, a2, a4]", () => {
    const document = zFixture();
    const result = zOrder(document, ["a4", "a2"], "front"); // el orden de los argumentos no importa
    expect(ids(result.production!.layers.A)).toEqual(["a1", "a3", "a5", "a2", "a4"]);
    expect(result.label).toBe("Traer al frente");
    expectNoLayerChange(document, result);
  });

  it("al fondo conserva el orden relativo: a2,a4 => [a2, a4, a1, a3, a5]", () => {
    const document = zFixture();
    const result = zOrder(document, ["a4", "a2"], "back");
    expect(ids(result.production!.layers.A)).toEqual(["a2", "a4", "a1", "a3", "a5"]);
    expect(result.label).toBe("Enviar al fondo");
    expectNoLayerChange(document, result);
  });

  it("al frente, selección única: a2 => [a1, a3, a4, a5, a2]; al fondo: a4 => [a4, a1, a2, a3, a5]", () => {
    const document = zFixture();
    expect(ids(zOrder(document, ["a2"], "front").production!.layers.A)).toEqual(["a1", "a3", "a4", "a5", "a2"]);
    expect(ids(zOrder(document, ["a4"], "back").production!.layers.A)).toEqual(["a4", "a1", "a2", "a3", "a5"]);
  });

  it("al frente cuando ya está arriba (bloque a4,a5): sin producción; al fondo con a1,a2: sin producción", () => {
    const document = zFixture();
    expect(zOrder(document, ["a4", "a5"], "front").production).toBeNull();
    expect(zOrder(document, ["a1", "a2"], "back").production).toBeNull();
    expect(zOrder(document, ["a5"], "front").summary.reason).toBe("Ya está al frente de su capa.");
    expect(zOrder(document, ["a1"], "back").summary.reason).toBe("Ya está al fondo de su capa.");
  });

  it("al frente con un hueco: a1,a5 => [a2, a3, a4, a1, a5] (a1 salta todo lo no seleccionado)", () => {
    const document = zFixture();
    expect(ids(zOrder(document, ["a1", "a5"], "front").production!.layers.A)).toEqual(["a2", "a3", "a4", "a1", "a5"]);
  });
});

describe("zOrderProduction — varias capas, capa propia y bloqueadas", () => {
  it("varias capas se procesan POR SEPARADO y en UNA producción: a2 y b1 al frente", () => {
    const document = zFixture();
    const result = zOrder(document, ["a2", "b1"], "front");
    expect(Object.keys(result.production!.layers).sort()).toEqual(["A", "B"]);
    expect(ids(result.production!.layers.A)).toEqual(["a1", "a3", "a4", "a5", "a2"]);
    expect(ids(result.production!.layers.B)).toEqual(["b2", "b3", "b1"]);
    expect(result.summary.moved).toBe(2);
    expectNoLayerChange(document, result);
  });

  it("una capa en el límite no se toca: a2 (sube) y b3 (ya arriba) hacia adelante => solo A en la producción; atLimit = 1", () => {
    const document = zFixture();
    const result = zOrder(document, ["a2", "b3"], "forward");
    expect(Object.keys(result.production!.layers)).toEqual(["A"]);
    expect(result.summary.atLimit).toBe(1);
    expect(result.summary.moved).toBe(1);
    const message = describeArrange("z-forward", result, { mmPerUnit: null, reference: "selection" });
    expect(message.text).toMatch(/1 objeto ya estaba en el límite de su capa/);
    expectNoLayerChange(document, result);
  });

  it("todas las capas en el límite: sin producción", () => {
    const document = zFixture();
    expect(zOrder(document, ["a5", "b3"], "front").production).toBeNull();
  });

  it("el orden ENTRE capas no se toca: ni las claves ni el orden de `objectsByLayer` cambian, y el pintado global sigue siendo capa por capa", () => {
    const document = zFixture();
    const result = zOrder(document, ["a2", "b1"], "front");
    const after = applied(document, result);
    expect(Object.keys(after.objectsByLayer)).toEqual(["A", "B", "L", "H"]);
    expect(after.layers).toBe(document.layers);
  });

  it("NINGÚN objeto cambia de capa en ninguna acción ni con ninguna selección (barrido)", () => {
    const document = zFixture();
    const selections = [["a1"], ["a3"], ["a5"], ["a1", "a2"], ["a2", "a4"], ["a1", "a5"], ["a2", "b2"], ["a1", "a2", "a3", "a4", "a5", "b1", "b2", "b3"], ["b1", "b3"]];
    for (const action of ["forward", "backward", "front", "back"] as ZOrderAction[]) {
      for (const selected of selections) expectNoLayerChange(document, zOrder(document, selected, action));
    }
  });

  it("los ids y el contenido de cada objeto quedan intactos (mismas referencias)", () => {
    const document = zFixture();
    const result = zOrder(document, ["a1", "a3"], "front");
    for (const object of result.production!.layers.A) {
      const original = document.objectsByLayer.A.find((candidate) => candidate.id === object.id)!;
      expect(object).toBe(original);
      expect(object.layerGroupId).toBe("A");
      expect(object.d).toBe(original.d);
      expect(object.matrix).toBe(original.matrix);
    }
  });

  it("capa BLOQUEADA: la selección solo bloqueada se rechaza con motivo", () => {
    const document = zFixture();
    const result = zOrder(document, ["l1"], "front");
    expect(result.production).toBeNull();
    expect(result.summary.noop).toBe(false);
    expect(result.summary.reason).toMatch(/capas bloqueadas/);
    expect(result.summary.skippedLocked).toBe(1);
  });

  it("selección mixta: lo bloqueado se omite (no se reordena, no aparece en la producción) y se informa", () => {
    const document = zFixture();
    const result = zOrder(document, ["a2", "l1"], "front");
    expect(Object.keys(result.production!.layers)).toEqual(["A"]);
    expect(result.summary.skippedLocked).toBe(1);
    const message = describeArrange("z-front", result, { mmPerUnit: null, reference: "selection" });
    expect(message.text).toMatch(/1 objeto bloqueado omitido/);
    expectNoLayerChange(document, result);
  });

  it("lo bloqueado tampoco cuenta como vecino: es de otra capa, así que no interviene en el paso", () => {
    const document = zFixture();
    expect(ids(zOrder(document, ["a2", "l2"], "forward").production!.layers.A)).toEqual(["a1", "a3", "a2", "a4", "a5"]);
  });

  it("capa oculta: se omite igual (defensa en profundidad)", () => {
    const document = zFixture();
    const result = zOrder(document, ["h1"], "front");
    expect(result.production).toBeNull();
    expect(result.summary.reason).toMatch(/capas ocultas/);
    expect(result.summary.skippedHidden).toBe(1);
  });

  it("`lockedLayerIds` extra también excluye (aunque la meta de la capa no diga bloqueada)", () => {
    const document = zFixture();
    const result = zOrderProduction(document, pick(document, "a2"), { action: "front", lockedLayerIds: new Set(["A"]) });
    expect(result.production).toBeNull();
    expect(result.summary.skippedLocked).toBe(1);
  });

  it("sin selección: rechazo 'Seleccioná objetos para reordenar.'", () => {
    const result = zOrder(zFixture(), [], "front");
    expect(result.production).toBeNull();
    expect(result.summary.noop).toBe(false);
    expect(result.summary.reason).toBe("Seleccioná objetos para reordenar.");
  });

  it("objetos sin geometría también se pueden reordenar (el z-order no necesita bbox)", () => {
    const empty: EditorObject = { id: "vacio", layerGroupId: "A", d: "", fill: "#ff0000", matrix: { ...IDENTITY } };
    const document = doc({ A: [empty, rect("a2", "A", 0, 0, 5, 5)] });
    expect(ids(zOrder(document, ["vacio"], "front").production!.layers.A)).toEqual(["a2", "vacio"]);
  });

  it("no muta el documento de entrada (arreglos congelados)", () => {
    const document = zFixture();
    for (const objects of Object.values(document.objectsByLayer)) Object.freeze(objects);
    expect(() => zOrder(document, ["a1", "a3", "b2"], "forward")).not.toThrow();
  });

  it("aplicar la acción inversa devuelve el orden original (adelante y luego atrás)", () => {
    const document = zFixture();
    const forward = applied(document, zOrder(document, ["a3"], "forward"));
    const back = applied(forward, zOrder(forward, ["a3"], "backward"));
    expect(ids(back.objectsByLayer.A)).toEqual(ids(document.objectsByLayer.A));
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Despacho, disponibilidad, mensajes y atajos
// ---------------------------------------------------------------------------------------------------------------------------------

describe("runArrange / ARRANGE_ACTIONS", () => {
  it("hay 12 acciones con ids únicos: 6 de alinear, 2 de distribuir y 4 de orden", () => {
    expect(ARRANGE_ACTIONS).toHaveLength(12);
    expect(new Set(ARRANGE_ACTIONS.map((action) => action.id)).size).toBe(12);
    expect(ARRANGE_ACTIONS.filter((action) => action.group === "align")).toHaveLength(6);
    expect(ARRANGE_ACTIONS.filter((action) => action.group === "distribute")).toHaveLength(2);
    expect(ARRANGE_ACTIONS.filter((action) => action.group === "order")).toHaveLength(4);
  });

  it("cada id ejecuta SU operación y su etiqueta es la del comando", () => {
    const document = alignFixture();
    const selection = pick(document, "o1", "o2", "o3");
    const expectedLabels: Record<ArrangeActionId, string> = {
      "align-left": "Alinear a la izquierda",
      "align-center": "Centrar horizontalmente",
      "align-right": "Alinear a la derecha",
      "align-top": "Alinear arriba",
      "align-middle": "Centrar verticalmente",
      "align-bottom": "Alinear abajo",
      "distribute-horizontal": "Distribuir horizontalmente",
      "distribute-vertical": "Distribuir verticalmente",
      "z-forward": "Traer adelante",
      "z-backward": "Enviar atrás",
      "z-front": "Traer al frente",
      "z-back": "Enviar al fondo",
    };
    for (const action of ARRANGE_ACTIONS) {
      expect(runArrange(document, selection, action.id, { reference: "selection" }).label, action.id).toBe(expectedLabels[action.id]);
    }
    expect(runArrange(document, selection, "align-left", { reference: "selection" }).production).toEqual(align(document, ["o1", "o2", "o3"], "left").production);
    expect(runArrange(document, selection, "z-front", { reference: "selection" }).production).toEqual(zOrder(document, ["o1", "o2", "o3"], "front").production);
  });

  it("el atajo de cada acción de z-order mapea a su botón", () => {
    expect(zOrderActionId("forward")).toBe("z-forward");
    expect(zOrderActionId("backward")).toBe("z-backward");
    expect(zOrderActionId("front")).toBe("z-front");
    expect(zOrderActionId("back")).toBe("z-back");
    expect(ARRANGE_SHORTCUTS.map((shortcut) => shortcut.keys)).toEqual(["Ctrl/Cmd+]", "Ctrl/Cmd+[", "Ctrl/Cmd+Shift+]", "Ctrl/Cmd+Shift+["]);
  });
});

describe("arrangeAvailability", () => {
  const base = { reference: "selection" as AlignReference, suspended: false };

  it("sin selección: alinear, distribuir y ordenar deshabilitados, cada uno con su motivo", () => {
    const document = alignFixture();
    const result = arrangeAvailability(document, [], base);
    expect(result["align-left"]).toBe("Seleccioná objetos para alinear.");
    expect(result["distribute-horizontal"]).toBe("Seleccioná objetos para distribuir.");
    expect(result["z-front"]).toBe("Seleccioná objetos para reordenar.");
  });

  it("2 objetos: alinear habilitado, distribuir deshabilitado ('3 o más'); orden habilitado si hay a dónde moverse", () => {
    const document = alignFixture();
    const result = arrangeAvailability(document, pick(document, "o1", "o2"), base);
    expect(result["align-left"]).toBeNull();
    expect(result["distribute-horizontal"]).toMatch(/3 o más/);
    expect(result["distribute-vertical"]).toMatch(/3 o más/);
    // o1 y o2 son los dos de abajo de su capa (o1, o2, o3): subir se puede, bajar ya no.
    expect(result["z-front"]).toBeNull();
    expect(result["z-forward"]).toBeNull();
    expect(result["z-back"]).toBe("Ya están al fondo de su capa.");
    expect(result["z-backward"]).toBe("Ya están al fondo de su capa.");
  });

  it("3 objetos: todo habilitado (los que ya están en el límite se deshabilitan sólo en z-order)", () => {
    const document = alignFixture();
    const result = arrangeAvailability(document, pick(document, "o1", "o2", "o3"), base);
    expect(result["align-right"]).toBeNull();
    expect(result["distribute-horizontal"]).toBeNull();
  });

  it("1 objeto: Selección deshabilita alinear; Documento lo habilita", () => {
    const document = doc(alignFixture().objectsByLayer, ALL_LAYERS, { x: 0, y: 0, width: 100, height: 100 });
    const one = pick(document, "o1");
    expect(arrangeAvailability(document, one, base)["align-left"]).toMatch(/2 o más objetos movibles/);
    expect(arrangeAvailability(document, one, { ...base, reference: "document" })["align-left"]).toBeNull();
  });

  it("'Ya alineado' NO deshabilita alinear (se informa al ejecutar), pero el límite de z-order SÍ deshabilita", () => {
    const aligned = doc({ A: [rect("p", "A", 10, 0, 10, 10), rect("q", "A", 10, 20, 30, 10)] });
    const result = arrangeAvailability(aligned, pick(aligned, "p", "q"), base);
    expect(result["align-left"]).toBeNull();
    // p, q son los dos únicos de su capa: están al frente y al fondo a la vez.
    expect(result["z-front"]).toBe("Ya están al frente de su capa.");
    expect(result["z-back"]).toBe("Ya están al fondo de su capa.");
    expect(result["z-forward"]).toBe("Ya están al frente de su capa.");
    expect(result["z-backward"]).toBe("Ya están al fondo de su capa.");
  });

  it("z-order en el límite: el tope no puede subir, pero sí bajar", () => {
    const document = zFixture();
    const result = arrangeAvailability(document, pick(document, "a5"), base);
    expect(result["z-front"]).toBe("Ya está al frente de su capa.");
    expect(result["z-forward"]).toBe("Ya está al frente de su capa.");
    expect(result["z-back"]).toBeNull();
    expect(result["z-backward"]).toBeNull();
  });

  it("todo bloqueado: todo deshabilitado con el motivo del bloqueo", () => {
    const document = zFixture();
    const result = arrangeAvailability(document, pick(document, "l1", "l2"), { ...base, reference: "document" });
    for (const action of ARRANGE_ACTIONS) expect(result[action.id], action.id).toMatch(/capas bloqueadas/);
  });

  it("transformación pendiente (suspended): todo deshabilitado con el mismo motivo", () => {
    const document = alignFixture();
    const result = arrangeAvailability(document, pick(document, "o1", "o2", "o3"), { ...base, suspended: true });
    for (const action of ARRANGE_ACTIONS) expect(result[action.id], action.id).toMatch(/transformación pendiente/);
  });
});

describe("describeArrange", () => {
  const context = { mmPerUnit: null, reference: "selection" as AlignReference };

  it("alinear: cuenta lo movido y dice la referencia; omitidos por bloqueo con el texto exacto 'N objetos bloqueados omitidos'", () => {
    const document = doc({ A: [rect("o1", "A", 10, 20, 30, 10), rect("o2", "A", 50, 10, 20, 40)], L: [rect("lk1", "L", 200, 0, 50, 10), rect("lk2", "L", 300, 0, 50, 10)] });
    const result = align(document, ["o1", "o2", "lk1", "lk2"], "left");
    const message = describeArrange("align-left", result, context);
    expect(message).toEqual({ kind: "ok", text: "Alinear a la izquierda: 1 objeto movido (referencia: selección). 2 objetos bloqueados omitidos." });
    expect(describeArrange("align-left", result, { ...context, reference: "document" }).text).toMatch(/referencia: documento/);
  });

  it("'Ya está alineado.' es una confirmación (kind ok), no un error", () => {
    const document = doc({ A: [rect("p", "A", 10, 0, 10, 10), rect("q", "A", 10, 20, 30, 10)] });
    expect(describeArrange("align-left", align(document, ["p", "q"], "left"), context)).toEqual({ kind: "ok", text: "Ya está alineado." });
  });

  it("un rechazo es kind error con su motivo", () => {
    const document = alignFixture();
    const message = describeArrange("distribute-horizontal", distribute(document, ["o1", "o2"], "horizontal"), context);
    expect(message.kind).toBe("error");
    expect(message.text).toBe("Distribuir requiere 3 o más objetos movibles (hay 2).");
  });

  it("distribuir: hueco en mm con la escala física (hueco 30 u * 0,5 mm/u = 15 mm) y en unidades sin escala", () => {
    const document = doc({ A: [rect("A1", "A", 0, 0, 10, 10), rect("B1", "A", 20, 5, 30, 10), rect("C1", "A", 100, 0, 40, 10)] });
    const result = distribute(document, ["A1", "B1", "C1"], "horizontal");
    expect(describeArrange("distribute-horizontal", result, { ...context, mmPerUnit: 0.5 }).text).toBe("Distribuir horizontalmente: 1 objeto movido; hueco igual de 15 mm entre objetos.");
    expect(describeArrange("distribute-horizontal", result, context).text).toBe("Distribuir horizontalmente: 1 objeto movido; hueco igual de 30 u entre objetos.");
  });

  it("z-order: 'N objetos reordenados dentro de su capa'", () => {
    const document = zFixture();
    expect(describeArrange("z-front", zOrder(document, ["a2", "a4"], "front"), context).text).toBe("Traer al frente: 2 objetos reordenados dentro de su capa.");
  });
});

describe("matchArrangeShortcut", () => {
  const key = (overrides: Partial<ShortcutKeyEvent>): ShortcutKeyEvent => ({ key: "", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...overrides });

  it.each([
    [{ key: "]", ctrlKey: true }, "forward"],
    [{ key: "[", ctrlKey: true }, "backward"],
    [{ key: "}", ctrlKey: true, shiftKey: true }, "front"],
    [{ key: "{", ctrlKey: true, shiftKey: true }, "back"],
    [{ key: "]", ctrlKey: true, shiftKey: true }, "front"],
    [{ key: "[", ctrlKey: true, shiftKey: true }, "back"],
  ] as Array<[Partial<ShortcutKeyEvent>, ZOrderAction]>)("Ctrl: %j -> %s", (event, action) => {
    expect(matchArrangeShortcut(key(event))).toBe(action);
  });

  it("Cmd (macOS) dispara lo mismo que Ctrl", () => {
    expect(matchArrangeShortcut(key({ key: "]", metaKey: true }))).toBe("forward");
    expect(matchArrangeShortcut(key({ key: "[", metaKey: true }))).toBe("backward");
    expect(matchArrangeShortcut(key({ key: "}", metaKey: true, shiftKey: true }))).toBe("front");
    expect(matchArrangeShortcut(key({ key: "{", metaKey: true, shiftKey: true }))).toBe("back");
  });

  it("teclados no-US: se reconoce por la tecla FÍSICA (`code`) aunque `key` no sea un corchete", () => {
    // es-ES: la tecla BracketRight escribe "+", la BracketLeft "`"; en de-DE "+" y "ü"; con Shift cambian otra vez.
    expect(matchArrangeShortcut(key({ key: "+", code: "BracketRight", ctrlKey: true }))).toBe("forward");
    expect(matchArrangeShortcut(key({ key: "`", code: "BracketLeft", ctrlKey: true }))).toBe("backward");
    expect(matchArrangeShortcut(key({ key: "*", code: "BracketRight", metaKey: true, shiftKey: true }))).toBe("front");
    expect(matchArrangeShortcut(key({ key: "^", code: "BracketLeft", metaKey: true, shiftKey: true }))).toBe("back");
    expect(matchArrangeShortcut(key({ key: "Dead", code: "BracketLeft", ctrlKey: true }))).toBe("backward");
  });

  it("sin Ctrl/Cmd no hay atajo; con Alt tampoco (AltGr = Ctrl+Alt escribe un carácter)", () => {
    expect(matchArrangeShortcut(key({ key: "]" }))).toBeNull();
    expect(matchArrangeShortcut(key({ key: "]", code: "BracketRight", shiftKey: true }))).toBeNull();
    expect(matchArrangeShortcut(key({ key: "]", ctrlKey: true, altKey: true }))).toBeNull();
    expect(matchArrangeShortcut(key({ key: "[", code: "BracketLeft", ctrlKey: true, altKey: true }))).toBeNull();
    expect(matchArrangeShortcut(key({ key: "[", metaKey: true, altKey: true }))).toBeNull();
  });

  it("otras teclas con Ctrl no se interceptan", () => {
    expect(matchArrangeShortcut(key({ key: "z", code: "KeyZ", ctrlKey: true }))).toBeNull();
    expect(matchArrangeShortcut(key({ key: "d", code: "KeyD", ctrlKey: true }))).toBeNull();
    expect(matchArrangeShortcut(key({ key: "ArrowUp", ctrlKey: true }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Rendimiento (humo, ADR D6): 5 000 objetos, sin umbrales frágiles
// ---------------------------------------------------------------------------------------------------------------------------------

describe("rendimiento con 5 000 objetos (humo)", () => {
  const COUNT = 5000;
  const COLUMNS = 100;
  const GENEROUS_LIMIT_MS = 5000;
  // Grilla de cuadraditos de 8×8 cada 12 unidades; columna c empieza en x = 12·c.
  const objects = Array.from({ length: COUNT }, (_, index) => rect(`p${index}`, "A", (index % COLUMNS) * 12, Math.floor(index / COLUMNS) * 12, 8, 8));
  const document = doc({ A: objects });
  const everything = objects;

  function timed<T>(action: () => T): { result: T; ms: number } {
    const start = performance.now();
    const result = action();
    return { result, ms: performance.now() - start };
  }

  it("la disponibilidad de los 12 botones con todo seleccionado no es cuadrática", () => {
    const { result, ms } = timed(() => arrangeAvailability(document, everything, { reference: "selection", suspended: false }));
    expect(ms).toBeLessThan(GENEROUS_LIMIT_MS);
    expect(result["align-left"]).toBeNull();
    expect(result["distribute-horizontal"]).toBeNull();
    // Toda la capa seleccionada: no hay vecino sin seleccionar, así que el orden no tiene a dónde moverse.
    expect(result["z-front"]).toBe("Ya están al frente de su capa.");
  });

  it("alinear a la izquierda 5 000 objetos: se mueven los 4 950 de fuera de la primera columna y los demás conservan su referencia", () => {
    const { result, ms } = timed(() => alignProduction(document, everything, { mode: "left", reference: "selection" }));
    expect(ms).toBeLessThan(GENEROUS_LIMIT_MS);
    expect(result.summary.moved).toBe(COUNT - 50);
    const out = result.production!.layers.A;
    expect(out).toHaveLength(COUNT);
    expect(out[0]).toBe(objects[0]);
    expect(out[COLUMNS]).toBe(objects[COLUMNS]);
    expect(out[1]).not.toBe(objects[1]);
    // p1 (x = 12) llega a x = 0 con una traslación de -12.
    expect(out[1].matrix.e).toBe(-12);
  });

  it("al frente 2 500 objetos alternados: partición estable (los no seleccionados primero, cada grupo en su orden original)", () => {
    const selection = objects.filter((_, index) => index % 2 === 0);
    const { result, ms } = timed(() => zOrderProduction(document, selection, { action: "front" }));
    expect(ms).toBeLessThan(GENEROUS_LIMIT_MS);
    const out = result.production!.layers.A;
    expect(out).toHaveLength(COUNT);
    expect(ids(out.slice(0, COUNT / 2))).toEqual(ids(objects.filter((_, index) => index % 2 === 1)));
    expect(ids(out.slice(COUNT / 2))).toEqual(ids(selection));
    expect(new Set(ids(out)).size).toBe(COUNT);
  });
});
