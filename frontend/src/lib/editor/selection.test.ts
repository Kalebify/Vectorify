import { describe, expect, it } from "vitest";
import { bounds } from "./objects";
import { cycleHit, removeObjects, replaceObjects, resolveSelection, selectableObjects, splitByLock, toggleId } from "./selection";
import { translate } from "./transform";
import type { EditableDocument, EditorObject } from "./types";

const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

function obj(id: string, layerGroupId: string, d = "M0 0 H10 V10 H0 Z"): EditorObject {
  return { id, layerGroupId, d, fill: "#000000", matrix: IDENTITY };
}

const A1 = obj("a1", "A");
const A2 = obj("a2", "A");
const B1 = obj("b1", "B");
const C1 = obj("c1", "C");

const STATE: EditableDocument = { objectsByLayer: { A: [A1, A2], B: [B1], C: [C1] } };
const LAYERS = [
  { groupId: "A", locked: false },
  { groupId: "B", locked: true },
  { groupId: "C", locked: false },
];

describe("selectableObjects", () => {
  it("orden de pintado: capas en el orden dado, objetos en su orden", () => {
    expect(selectableObjects(STATE.objectsByLayer, LAYERS, {}).map((o) => o.id)).toEqual(["a1", "a2", "b1", "c1"]);
  });

  it("capas ocultas NO son seleccionables; capas bloqueadas SÍ (para inspeccionar)", () => {
    const ids = selectableObjects(STATE.objectsByLayer, LAYERS, { A: false }).map((o) => o.id);
    expect(ids).toEqual(["b1", "c1"]);
  });

  it("capas aún sin cargar (sin objetos) se saltean sin romper", () => {
    expect(selectableObjects({ A: [A1] }, LAYERS, {}).map((o) => o.id)).toEqual(["a1"]);
  });
});

describe("resolveSelection / toggleId", () => {
  const pool = selectableObjects(STATE.objectsByLayer, LAYERS, {});

  it("devuelve los objetos seleccionados en orden de pintado e ignora ids inexistentes", () => {
    expect(resolveSelection(pool, new Set(["c1", "a1", "fantasma"])).map((o) => o.id)).toEqual(["a1", "c1"]);
    expect(resolveSelection(pool, new Set())).toEqual([]);
  });

  it("toggleId agrega o quita sin mutar el set original", () => {
    const original = new Set(["a1"]);
    const added = toggleId(original, "b1");
    expect([...added].sort()).toEqual(["a1", "b1"]);
    expect([...toggleId(added, "a1")]).toEqual(["b1"]);
    expect([...original]).toEqual(["a1"]);
  });
});

describe("cycleHit (Alt+click sobre una pila)", () => {
  const stack = [obj("top", "A"), obj("mid", "A"), obj("bottom", "A")]; // de arriba hacia abajo

  it("sin selección elige el de arriba", () => {
    expect(cycleHit(stack, new Set())?.id).toBe("top");
  });

  it("con uno seleccionado de la pila elige el siguiente hacia abajo y, en el fondo, vuelve al tope", () => {
    expect(cycleHit(stack, new Set(["top"]))?.id).toBe("mid");
    expect(cycleHit(stack, new Set(["mid"]))?.id).toBe("bottom");
    expect(cycleHit(stack, new Set(["bottom"]))?.id).toBe("top");
  });

  it("una selección que no pertenece a la pila no cuenta; pila vacía -> null", () => {
    expect(cycleHit(stack, new Set(["otro"]))?.id).toBe("top");
    expect(cycleHit([], new Set())).toBeNull();
  });
});

describe("splitByLock", () => {
  it("separa editables de bloqueados por capa", () => {
    const { editable, locked } = splitByLock([A1, B1, C1], new Set(["B"]));
    expect(editable.map((o) => o.id)).toEqual(["a1", "c1"]);
    expect(locked.map((o) => o.id)).toEqual(["b1"]);
  });
});

describe("replaceObjects", () => {
  it("reemplaza solo los objetivos; capas tocadas = las que los contenían; el resto conserva referencias", () => {
    const production = replaceObjects(STATE, [A2, C1], (targets) => translate(targets, 5, 0))!;
    expect(Object.keys(production.layers).sort()).toEqual(["A", "C"]);
    expect(production.layers.A[0]).toBe(A1); // no seleccionado: misma referencia
    expect(production.layers.A[1]).not.toBe(A2);
    expect(bounds([production.layers.A[1]])).toEqual({ x: 5, y: 0, width: 10, height: 10 });
    expect(production.layers.B).toBeUndefined();
  });

  it("si el mapeo no cambia nada (mismas referencias) o devuelve otro largo -> null", () => {
    expect(replaceObjects(STATE, [A1], (targets) => targets)).toBeNull();
    expect(replaceObjects(STATE, [A1], () => [])).toBeNull();
    expect(replaceObjects(STATE, [], (targets) => targets)).toBeNull();
  });

  it("el mapeo recibe la selección COMPLETA como grupo (para pivotes de grupo)", () => {
    let received = 0;
    replaceObjects(STATE, [A1, B1, C1], (targets) => {
      received = targets.length;
      return translate(targets, 1, 1);
    });
    expect(received).toBe(3);
  });
});

describe("removeObjects", () => {
  it("quita los ids y solo devuelve las capas afectadas", () => {
    const production = removeObjects(STATE, new Set(["a1", "c1"]))!;
    expect(production.layers.A.map((o) => o.id)).toEqual(["a2"]);
    expect(production.layers.C).toEqual([]);
    expect(production.layers.B).toBeUndefined();
  });

  it("ids inexistentes -> null", () => {
    expect(removeObjects(STATE, new Set(["nada"]))).toBeNull();
    expect(removeObjects(STATE, new Set())).toBeNull();
  });
});
