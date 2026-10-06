import { describe, expect, it } from "vitest";
import { bounds } from "./objects";
import {
  composeOrientation,
  IDENTITY_ORIENTATION,
  isIdentityOrientation,
  orientationAboutMatrix,
  orientationLabel,
  orientationVerb,
  orientObjects,
  orientSelectionProduction,
  swapsAxes,
  type Orientation,
  type OrientationStep,
} from "./orientation";
import type { EditableDocument, EditorObject } from "./types";

const IDENTITY_MATRIX = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

function rect(id: string, x: number, y: number, w: number, h: number, layer = "L1"): EditorObject {
  return { id, layerGroupId: layer, d: `M${x} ${y} H${x + w} V${y + h} H${x} Z`, fill: "#000000", matrix: IDENTITY_MATRIX };
}

function run(...steps: OrientationStep[]): Orientation {
  return steps.reduce((current, step) => composeOrientation(current, step), IDENTITY_ORIENTATION);
}

const CW: Orientation = { a: 0, b: 1, c: -1, d: 0 };
const CCW: Orientation = { a: 0, b: -1, c: 1, d: 0 };
const FLIP_H: Orientation = { a: -1, b: 0, c: 0, d: 1 };
const FLIP_V: Orientation = { a: 1, b: 0, c: 0, d: -1 };

describe("composeOrientation — álgebra exacta de giros de 90° y reflejos", () => {
  it("cada paso es la matriz entera esperada (calculadas a mano; toEqual distingue 0 de -0)", () => {
    expect(run("rotate-cw")).toEqual(CW);
    expect(run("rotate-ccw")).toEqual(CCW);
    expect(run("flip-horizontal")).toEqual(FLIP_H);
    expect(run("flip-vertical")).toEqual(FLIP_V);
  });

  it("rotate 90 x4 = identidad EXACTA (en ambos sentidos), sin -0 ni residuo", () => {
    expect(run("rotate-cw", "rotate-cw", "rotate-cw", "rotate-cw")).toEqual(IDENTITY_ORIENTATION);
    expect(run("rotate-ccw", "rotate-ccw", "rotate-ccw", "rotate-ccw")).toEqual(IDENTITY_ORIENTATION);
    expect(run("rotate-cw", "rotate-ccw")).toEqual(IDENTITY_ORIENTATION);
    expect(run("rotate-cw", "rotate-cw")).toEqual({ a: -1, b: 0, c: 0, d: -1 });
    expect(isIdentityOrientation(run("rotate-cw", "rotate-cw", "rotate-cw", "rotate-cw"))).toBe(true);
  });

  it("flip x2 = identidad exacta (horizontal y vertical); flip H + flip V = giro de 180°", () => {
    expect(run("flip-horizontal", "flip-horizontal")).toEqual(IDENTITY_ORIENTATION);
    expect(run("flip-vertical", "flip-vertical")).toEqual(IDENTITY_ORIENTATION);
    expect(run("flip-horizontal", "flip-vertical")).toEqual(run("rotate-cw", "rotate-cw"));
  });

  it("el orden importa: girar y luego reflejar != reflejar y luego girar (valores a mano)", () => {
    // cw luego flip-H: (1,0) -> (0,1) -> (0,1); (0,1) -> (-1,0) -> (1,0): transpuesta.
    expect(run("rotate-cw", "flip-horizontal")).toEqual({ a: 0, b: 1, c: 1, d: 0 });
    // flip-H luego cw: (1,0) -> (-1,0) -> (0,-1); (0,1) -> (0,1) -> (-1,0): anti-transpuesta.
    expect(run("flip-horizontal", "rotate-cw")).toEqual({ a: 0, b: -1, c: -1, d: 0 });
  });

  it("una cadena larga y arbitraria sigue siendo entera y exacta: 1000 pasos que suman identidad dan la identidad", () => {
    let orientation = IDENTITY_ORIENTATION;
    for (let index = 0; index < 250; index += 1) {
      for (const step of ["rotate-cw", "flip-horizontal", "flip-horizontal", "rotate-ccw"] as const) orientation = composeOrientation(orientation, step);
    }
    expect(orientation).toEqual(IDENTITY_ORIENTATION);
    // Y mientras tanto todos los coeficientes siempre fueron -1, 0 o 1.
    let walk = IDENTITY_ORIENTATION;
    for (let index = 0; index < 100; index += 1) {
      walk = composeOrientation(walk, index % 3 === 0 ? "rotate-cw" : index % 3 === 1 ? "flip-vertical" : "rotate-ccw");
      for (const value of Object.values(walk)) expect([-1, 0, 1]).toContain(value);
    }
  });

  it("el grupo tiene exactamente 8 elementos (4 giros x con/sin reflejo)", () => {
    const seen = new Set<string>();
    const queue: Orientation[] = [IDENTITY_ORIENTATION];
    // Tope de seguridad: si la álgebra dejara de ser entera el grupo sería infinito y el recorrido no terminaría.
    while (queue.length > 0 && seen.size <= 64) {
      const current = queue.pop()!;
      const key = JSON.stringify(current);
      if (seen.has(key)) continue;
      seen.add(key);
      for (const step of ["rotate-cw", "rotate-ccw", "flip-horizontal", "flip-vertical"] as const) queue.push(composeOrientation(current, step));
    }
    expect(seen.size).toBe(8);
  });
});

describe("orientationAboutMatrix", () => {
  it("giro horario de 90° alrededor de (100, 50): e = 150, f = -50 (a mano) y el pivote queda fijo", () => {
    const matrix = orientationAboutMatrix({ x: 100, y: 50 }, CW);
    expect(matrix).toEqual({ a: 0, b: 1, c: -1, d: 0, e: 150, f: -50 });
    // El pivote: 0·100 + (-1)·50 + 150 = 100 ; 1·100 + 0·50 - 50 = 50.
    expect(matrix.a * 100 + matrix.c * 50 + matrix.e).toBe(100);
    expect(matrix.b * 100 + matrix.d * 50 + matrix.f).toBe(50);
  });

  it("reflejo horizontal alrededor de x = 100: x' = 200 - x", () => {
    expect(orientationAboutMatrix({ x: 100, y: 50 }, FLIP_H)).toEqual({ a: -1, b: 0, c: 0, d: 1, e: 200, f: 0 });
    expect(orientationAboutMatrix({ x: 100, y: 50 }, FLIP_V)).toEqual({ a: 1, b: 0, c: 0, d: -1, e: 0, f: 100 });
  });

  it("la identidad es EXACTAMENTE la identidad para cualquier pivote (también negativo o fraccionario)", () => {
    for (const pivot of [{ x: 0.1, y: 0.2 }, { x: -3, y: -7 }, { x: 1e6, y: -1e6 }, { x: 33.333333333333336, y: 7.1 }]) {
      expect(orientationAboutMatrix(pivot, IDENTITY_ORIENTATION)).toEqual(IDENTITY_MATRIX);
    }
  });
});

describe("swapsAxes / orientationLabel / orientationVerb", () => {
  it("intercambia ejes con giros de 90°/270° y con reflejos diagonales, no con 180° ni con flips simples", () => {
    expect(swapsAxes(CW)).toBe(true);
    expect(swapsAxes(CCW)).toBe(true);
    expect(swapsAxes(run("rotate-cw", "flip-horizontal"))).toBe(true);
    expect(swapsAxes(run("rotate-cw", "rotate-cw"))).toBe(false);
    expect(swapsAxes(FLIP_H)).toBe(false);
    expect(swapsAxes(IDENTITY_ORIENTATION)).toBe(false);
  });

  it("etiquetas en español para el resumen previo a Apply y el historial", () => {
    expect(orientationLabel(IDENTITY_ORIENTATION)).toBe("Sin cambios");
    expect(orientationLabel(CW)).toBe("Rotar 90° horario");
    expect(orientationLabel(CCW)).toBe("Rotar 90° antihorario");
    expect(orientationLabel(run("rotate-cw", "rotate-cw"))).toBe("Rotar 180°");
    expect(orientationLabel(FLIP_H)).toBe("Reflejar horizontalmente");
    expect(orientationLabel(FLIP_V)).toBe("Reflejar verticalmente");
    expect(orientationLabel(run("rotate-cw", "flip-horizontal"))).toBe("Reflejar horizontalmente y rotar 90° antihorario");
    expect(orientationLabel(run("flip-horizontal", "rotate-cw"))).toBe("Reflejar horizontalmente y rotar 90° horario");
  });

  it("verbo: rotación pura 'rotará', reflejo puro 'reflejará', combinado 'transformará'", () => {
    expect(orientationVerb(CW)).toBe("rotará");
    expect(orientationVerb(run("rotate-cw", "rotate-cw"))).toBe("rotará");
    expect(orientationVerb(FLIP_H)).toBe("reflejará");
    expect(orientationVerb(FLIP_V)).toBe("reflejará");
    expect(orientationVerb(run("rotate-cw", "flip-horizontal"))).toBe("transformará");
  });
});

describe("orientObjects — el grupo gira/se refleja alrededor del centro de su bbox", () => {
  const group = [rect("a", 0, 0, 10, 10), rect("b", 30, 0, 10, 10)]; // bbox 0..40 × 0..10, centro (20, 5)

  it("reflejo horizontal: el grupo se espeja y su bbox total no cambia (a mano: x' = 40 - x)", () => {
    const flipped = orientObjects(group, FLIP_H);
    expect(bounds([flipped[0]])).toEqual({ x: 30, y: 0, width: 10, height: 10 });
    expect(bounds([flipped[1]])).toEqual({ x: 0, y: 0, width: 10, height: 10 });
    expect(bounds(flipped)).toEqual(bounds(group));
  });

  it("giro horario de 90°: el bbox 40×10 pasa a 10×40 centrado en el mismo punto", () => {
    // (0,0) -> (25,-15); (40,10) -> (15,25)
    expect(bounds(orientObjects(group, CW))).toEqual({ x: 15, y: -15, width: 10, height: 40 });
  });

  it("NO toca d (fuente de verdad geométrica) y deja los originales intactos (inmutabilidad)", () => {
    const rotated = orientObjects(group, CW);
    expect(rotated.map((o) => o.d)).toEqual(group.map((o) => o.d));
    expect(group[0].matrix).toEqual(IDENTITY_MATRIX);
    expect(rotated[0]).not.toBe(group[0]);
  });

  it("identidad o sin geometría: los MISMOS objetos (sin comando vacío)", () => {
    const same = orientObjects(group, IDENTITY_ORIENTATION);
    expect(same[0]).toBe(group[0]);
    expect(same[1]).toBe(group[1]);
    expect(orientObjects([], CW)).toEqual([]);
  });

  it("4 giros de 90° aplicados de a uno devuelven la matriz original EXACTA (bbox con valores enteros)", () => {
    let current = group;
    for (let turn = 0; turn < 4; turn += 1) current = orientObjects(current, CW);
    for (const [index, object] of current.entries()) {
      for (const key of ["a", "b", "c", "d", "e", "f"] as const) expect(object.matrix[key] === IDENTITY_MATRIX[key], `${object.id}.${key}`).toBe(true);
      expect(bounds([object])).toEqual(bounds([group[index]]));
    }
  });

  it("2 reflejos (vertical) de a uno vuelven EXACTAMENTE a la geometría original", () => {
    const twice = orientObjects(orientObjects(group, FLIP_V), FLIP_V);
    expect(bounds(twice)).toEqual(bounds(group));
    for (const [index, object] of twice.entries()) {
      for (const key of ["a", "b", "c", "d", "e", "f"] as const) expect(object.matrix[key] === group[index].matrix[key], `${object.id}.${key}`).toBe(true);
    }
  });
});

describe("orientSelectionProduction", () => {
  const state: EditableDocument = {
    objectsByLayer: {
      L1: [rect("a", 0, 0, 10, 10), rect("keep", 100, 100, 10, 10)],
      L2: [rect("b", 30, 0, 10, 10, "L2")],
    },
  };

  it("transforma SOLO los ids pedidos (en cualquier capa) como un grupo; el resto conserva su referencia", () => {
    const production = orientSelectionProduction(state, new Set(["a", "b"]), FLIP_H)!;
    expect(Object.keys(production.layers).sort()).toEqual(["L1", "L2"]);
    expect(production.layers.L1[1]).toBe(state.objectsByLayer.L1[1]);
    // bbox del grupo 0..40: a pasa a 30..40 y b a 0..10.
    expect(bounds([production.layers.L1[0]])).toEqual({ x: 30, y: 0, width: 10, height: 10 });
    expect(bounds([production.layers.L2[0]])).toEqual({ x: 0, y: 0, width: 10, height: 10 });
  });

  it("una capa sin objetos seleccionados no figura en la producción", () => {
    const production = orientSelectionProduction(state, new Set(["b"]), CW)!;
    expect(Object.keys(production.layers)).toEqual(["L2"]);
  });

  it("identidad, ids inexistentes o selección vacía: null (no hay nada que aplicar)", () => {
    expect(orientSelectionProduction(state, new Set(["a"]), IDENTITY_ORIENTATION)).toBeNull();
    expect(orientSelectionProduction(state, new Set(["nope"]), CW)).toBeNull();
    expect(orientSelectionProduction(state, new Set(), CW)).toBeNull();
  });
});
