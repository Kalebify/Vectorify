import { describe, expect, it } from "vitest";
import { IDENTITY_MATRIX } from "../svgTransform";
import { bounds } from "./objects";
import { moveProduction, objectsByIds, rotateProduction, scaleProduction, setBoundsProduction } from "./operations";
import type { EditableDocument, EditorObject } from "./types";

/** Los productores compartidos por la UI y el ejecutor (M3-S12): mismo resultado que las funciones puras de transform, sobre objetos por id. */

const square = (id: string, x: number, y: number, layer = "A", size = 10): EditorObject => ({
  id,
  layerGroupId: layer,
  d: `M${x} ${y} H${x + size} V${y + size} H${x} Z`,
  fill: "#ff0000",
  matrix: IDENTITY_MATRIX,
});

const DOC: EditableDocument = { objectsByLayer: { A: [square("a1", 0, 0), square("a2", 20, 0)], B: [square("b1", 0, 20, "B")] } };

describe("objectsByIds", () => {
  it("devuelve los objetos del documento con esos ids, en orden de documento, ignorando los que no existen", () => {
    expect(objectsByIds(DOC, new Set(["b1", "a1", "zz"])).map((object) => object.id)).toEqual(["a1", "b1"]);
    expect(objectsByIds(DOC, new Set())).toEqual([]);
  });
});

describe("moveProduction", () => {
  it("traslada SOLO esos objetos, en las capas que tocan, y deja intactas (misma referencia) las demás y los objetos no movidos", () => {
    const production = moveProduction(DOC, new Set(["a1", "b1"]), 5, 7)!;
    expect(Object.keys(production.layers).sort()).toEqual(["A", "B"]);
    const [moved, untouched] = production.layers.A;
    expect(moved.matrix).toMatchObject({ e: 5, f: 7 });
    expect(untouched).toBe(DOC.objectsByLayer.A[1]);
    expect(moved.d).toBe(DOC.objectsByLayer.A[0].d); // d intacto: solo se compone la matriz
    expect(moveProduction(DOC, new Set(["a2"]), 1, 1)!.layers.B).toBeUndefined();
  });

  it("sin cambio (0,0), sin ids o con un desplazamiento no finito no hay producción", () => {
    expect(moveProduction(DOC, new Set(["a1"]), 0, 0)).toBeNull();
    expect(moveProduction(DOC, new Set(), 5, 5)).toBeNull();
    expect(moveProduction(DOC, new Set(["a1"]), Number.NaN, 0)).toBeNull();
  });
});

describe("rotateProduction", () => {
  it("rota el GRUPO alrededor del centro de su caja: 90° sobre dos cuadrados lado a lado los apila alrededor del centro común", () => {
    const production = rotateProduction(DOC, new Set(["a1", "a2"]), 90)!;
    const rotated = production.layers.A;
    const box = bounds(rotated)!;
    // Caja original: x 0..30, y 0..10 (centro 15,5) -> girada 90°: x 10..20, y -10..20.
    expect(box.x).toBeCloseTo(10, 9);
    expect(box.y).toBeCloseTo(-10, 9);
    expect(box.width).toBeCloseTo(10, 9);
    expect(box.height).toBeCloseTo(30, 9);
  });

  it("un solo objeto gira alrededor de SU centro y vuelve con -degrees; sin objetos no hay producción", () => {
    const there = rotateProduction(DOC, new Set(["a1"]), 30)!;
    const back = rotateProduction({ objectsByLayer: { ...DOC.objectsByLayer, A: there.layers.A } }, new Set(["a1"]), -30)!;
    expect(back.layers.A[0].matrix.a).toBeCloseTo(1, 9);
    expect(back.layers.A[0].matrix.e).toBeCloseTo(0, 9);
    expect(rotateProduction(DOC, new Set(["nada"]), 30)).toBeNull();
  });
});

describe("scaleProduction", () => {
  it("escala el grupo alrededor de su centro por defecto y alrededor de un pivote explícito", () => {
    const centered = scaleProduction(DOC, new Set(["a1"]), 2, 2)!.layers.A[0];
    expect(bounds([centered])).toEqual({ x: -5, y: -5, width: 20, height: 20 });
    const pivoted = scaleProduction(DOC, new Set(["a1"]), 2, 0.5, { x: 0, y: 0 })!.layers.A[0];
    expect(bounds([pivoted])).toEqual({ x: 0, y: 0, width: 20, height: 5 });
  });

  it("un factor casi 0 o no finito no colapsa la geometría: no hay producción", () => {
    expect(scaleProduction(DOC, new Set(["a1"]), 0, 1)).toBeNull();
    expect(scaleProduction(DOC, new Set(["a1"]), Number.POSITIVE_INFINITY, 1)).toBeNull();
  });
});

describe("setBoundsProduction", () => {
  it("fija posición y tamaño del grupo; un destino inválido deja todo como estaba", () => {
    const production = setBoundsProduction(DOC, new Set(["a1", "a2"]), { x: 100, y: 50, width: 60, height: 20 })!;
    expect(bounds(production.layers.A)).toEqual({ x: 100, y: 50, width: 60, height: 20 });
    expect(setBoundsProduction(DOC, new Set(["a1"]), { x: 0, y: 0, width: 0, height: 5 })).toBeNull();
    expect(setBoundsProduction(DOC, new Set(["a1"]), { x: 0, y: 0, width: 10, height: 10 })).toBeNull(); // ya está ahí
  });
});
