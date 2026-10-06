import { describe, expect, it } from "vitest";
import {
  cropFrame,
  cropProduction,
  deserializeFrame,
  dimRects,
  fitToContent,
  frameCenter,
  frameSizeMm,
  frameToViewBox,
  frameWithAspect,
  framesEqual,
  isValidFrame,
  MAX_FRAME_EXTENT,
  objectsRelativeToFrame,
  orientDocumentProduction,
  orientFrame,
  rotateFrame90,
  serializeFrame,
  sourceFrameOf,
  summarizeCrop,
  validateFrame,
  viewBoxToFrame,
} from "./frame";
import { rotationAboutMatrix, translationMatrix } from "./matrix";
import { bounds, parseEditableLayer, serializeEditableLayer } from "./objects";
import { composeOrientation, IDENTITY_ORIENTATION } from "./orientation";
import type { DocumentFrame, EditableDocument, EditorObject } from "./types";

const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

function obj(id: string, d: string, layerGroupId = "L1", matrix = IDENTITY): EditorObject {
  return { id, layerGroupId, d, fill: "#000000", matrix };
}

/** Rectángulo de x..x+w, y..y+h. */
function rect(id: string, x: number, y: number, w: number, h: number, layer = "L1"): EditorObject {
  return obj(id, `M${x} ${y} H${x + w} V${y + h} H${x} Z`, layer);
}

const FRAME: DocumentFrame = { x: 0, y: 0, width: 100, height: 100 };

/** Igualdad EXACTA de los seis coeficientes (===, sin épsilon). Ojo: `===` trata 0 y -0 como iguales, que es lo que importa al dibujar y serializar. */
function expectSameMatrix(actual: EditorObject["matrix"], expected: EditorObject["matrix"]) {
  for (const key of ["a", "b", "c", "d", "e", "f"] as const) expect(actual[key] === expected[key], `coeficiente ${key}: ${actual[key]} vs ${expected[key]}`).toBe(true);
}

describe("validateFrame / cropFrame", () => {
  it("acepta un marco finito con área, aunque salga del marco actual (agranda el área de trabajo)", () => {
    expect(validateFrame({ x: 10, y: 20, width: 30, height: 40 })).toBeNull();
    const result = cropFrame(FRAME, { x: -50, y: -50, width: 300, height: 300 });
    expect(result).toEqual({ ok: true, frame: { x: -50, y: -50, width: 300, height: 300 } });
  });

  it("rechaza ancho/alto 0 o negativos, NaN/Infinity, demasiado chico y fuera de límites razonables, cada uno con su mensaje", () => {
    expect(validateFrame({ x: 0, y: 0, width: 0, height: 10 })).toMatch(/mayores que 0/);
    expect(validateFrame({ x: 0, y: 0, width: 10, height: -5 })).toMatch(/mayores que 0/);
    expect(validateFrame({ x: Number.NaN, y: 0, width: 10, height: 10 })).toMatch(/no son números/);
    expect(validateFrame({ x: 0, y: 0, width: Infinity, height: 10 })).toMatch(/no son números/);
    expect(validateFrame({ x: 0, y: 0, width: 0.001, height: 10 })).toMatch(/demasiado pequeña/);
    expect(validateFrame({ x: 0, y: 0, width: MAX_FRAME_EXTENT + 1, height: 10 })).toMatch(/límite razonable/);
    expect(validateFrame({ x: -(MAX_FRAME_EXTENT + 1), y: 0, width: 10, height: 10 })).toMatch(/límite razonable/);
    // El límite exacto sí es válido.
    expect(isValidFrame({ x: 0, y: 0, width: MAX_FRAME_EXTENT, height: 0.01 })).toBe(true);
  });

  it("cropFrame propaga el error de validación y no devuelve marco", () => {
    const result = cropFrame(FRAME, { x: 0, y: 0, width: 0, height: 10 });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/mayores que 0/);
  });

  it("un destino igual al vigente devuelve el MISMO marco (referencia idéntica: no es un cambio)", () => {
    const result = cropFrame(FRAME, { ...FRAME });
    expect(result.ok && result.frame).toBe(FRAME);
  });
});

describe("mm conservados (la escala física no cambia con el marco)", () => {
  it("recortar 200×100 mm a 100×100 mm: el factor es el mismo y los objetos mantienen su tamaño real", () => {
    // 400×200 unidades = 200×100 mm -> 0.5 mm por unidad.
    const factor = 0.5;
    const before = sourceFrameOf(400, 200);
    expect(frameSizeMm(before, factor)).toEqual({ widthMm: 200, heightMm: 100 });

    const crop = cropFrame(before, { x: 100, y: 0, width: 200, height: 200 });
    expect(crop.ok).toBe(true);
    if (!crop.ok) return;
    expect(frameSizeMm(crop.frame, factor)).toEqual({ widthMm: 100, heightMm: 100 });

    // Un objeto de 40×20 u (20×10 mm) no cambia de tamaño por el crop: cropProduction no toca matrices.
    const object = rect("a", 150, 50, 40, 20);
    const state: EditableDocument = { objectsByLayer: { L1: [object] }, frame: before };
    const production = cropProduction(state, crop.frame, true);
    expect(production?.layers).toEqual({});
    const box = bounds([object])!;
    expect({ widthMm: box.width * factor, heightMm: box.height * factor }).toEqual({ widthMm: 20, heightMm: 10 });
  });

  it("frameSizeMm sin escala física conocida es null (nunca mm inventados)", () => {
    expect(frameSizeMm(FRAME, null)).toBeNull();
  });
});

describe("rotateFrame90 / orientFrame", () => {
  const WIDE: DocumentFrame = { x: 0, y: 0, width: 200, height: 100 };

  it("un cuarto de vuelta intercambia ancho/alto alrededor del centro y reubica el origen (valores calculados a mano)", () => {
    // centro (100,50): nuevo ancho 100, alto 200 -> x = 100-50 = 50, y = 50-100 = -50
    expect(rotateFrame90(WIDE, 1)).toEqual({ x: 50, y: -50, width: 100, height: 200 });
    expect(rotateFrame90(WIDE, -1)).toEqual({ x: 50, y: -50, width: 100, height: 200 });
    expect(rotateFrame90(WIDE, 3)).toEqual({ x: 50, y: -50, width: 100, height: 200 });
    expect(frameCenter(rotateFrame90(WIDE, 1))).toEqual(frameCenter(WIDE));
  });

  it("4 giros = identidad EXACTA (el MISMO objeto, sin residuo), 2 giros también; aplicados de a uno vuelven al valor original", () => {
    expect(rotateFrame90(WIDE, 4)).toBe(WIDE);
    expect(rotateFrame90(WIDE, 2)).toBe(WIDE);
    expect(rotateFrame90(WIDE, 0)).toBe(WIDE);
    expect(rotateFrame90(WIDE, -4)).toBe(WIDE);
    let frame = WIDE;
    for (let turn = 0; turn < 4; turn += 1) frame = rotateFrame90(frame, 1);
    expect(frame).toEqual(WIDE);
    // Giros no enteros no son cuartos de vuelta: no se hace nada.
    expect(rotateFrame90(WIDE, 0.5)).toBe(WIDE);
  });

  it("orientFrame: reflejar deja el marco IGUAL (misma referencia); girar 90° o reflejar en diagonal lo intercambia", () => {
    const flip = composeOrientation(IDENTITY_ORIENTATION, "flip-horizontal");
    expect(orientFrame(WIDE, flip)).toBe(WIDE);
    expect(orientFrame(WIDE, composeOrientation(IDENTITY_ORIENTATION, "flip-vertical"))).toBe(WIDE);
    const cw = composeOrientation(IDENTITY_ORIENTATION, "rotate-cw");
    expect(orientFrame(WIDE, cw)).toEqual({ x: 50, y: -50, width: 100, height: 200 });
    expect(orientFrame(WIDE, composeOrientation(cw, "rotate-cw"))).toBe(WIDE);
  });
});

describe("objectsRelativeToFrame", () => {
  const classify = (objects: EditorObject[]) => {
    const { inside, outside, crossing } = objectsRelativeToFrame(objects, FRAME);
    return { inside: inside.map((o) => o.id), outside: outside.map((o) => o.id), crossing: crossing.map((o) => o.id) };
  };

  it("dentro / fuera / cruzando, con valores calculados a mano", () => {
    expect(
      classify([rect("in", 10, 10, 10, 10), rect("out", 200, 200, 10, 10), rect("cross", 90, 90, 20, 20), rect("cross-left", -5, 40, 10, 10)]),
    ).toEqual({ inside: ["in"], outside: ["out"], crossing: ["cross", "cross-left"] });
  });

  it("bordes exactos: un objeto que coincide con el borde del marco está DENTRO", () => {
    expect(classify([rect("full", 0, 0, 100, 100), rect("edge-right", 90, 0, 10, 10)])).toEqual({ inside: ["full", "edge-right"], outside: [], crossing: [] });
  });

  it("objetos que solo TOCAN el borde desde afuera no comparten área: están FUERA (también por una esquina)", () => {
    expect(classify([rect("touch-right", 100, 10, 20, 20), rect("touch-corner", 100, 100, 10, 10), rect("touch-top", 10, -10, 10, 10)])).toEqual({
      inside: [],
      outside: ["touch-right", "touch-corner", "touch-top"],
      crossing: [],
    });
  });

  it("un objeto 1 unidad adentro del borde, o 1 afuera, queda del lado correcto (sin falsos positivos por la tolerancia)", () => {
    expect(classify([rect("one-in", 99, 10, 1, 10), rect("one-out", 101, 10, 5, 10), rect("sliver-cross", 99.5, 10, 5, 10)])).toEqual({
      inside: ["one-in"],
      outside: ["one-out"],
      crossing: ["sliver-cross"],
    });
  });

  it("líneas sin grosor (bbox de alto 0): sobre el borde cuentan como dentro; fuera del marco, como fuera; atravesando el borde, cruzan", () => {
    expect(classify([obj("on-top", "M10 0 H50"), obj("above", "M10 -5 H50"), obj("beyond", "M50 20 H150")])).toEqual({
      inside: ["on-top"],
      outside: ["above"],
      crossing: ["beyond"],
    });
  });

  it("usa el bbox EXACTO de las curvas: extremos adentro pero panza afuera = cruza", () => {
    // Cúbica de (0,50) a (100,50) con controles en y=-50: su punto más alto es y = 0.25·50 + 0.75·(-50) = -25 (t = 0.5).
    const bulge = obj("bulge", "M0 50 C0 -50 100 -50 100 50 Z");
    expect(objectBounds(bulge).y).toBeCloseTo(-25, 12);
    expect(classify([bulge])).toEqual({ inside: [], outside: [], crossing: ["bulge"] });
  });

  it("aplica la matriz del objeto: un objeto trasladado fuera del marco queda fuera aunque su d esté adentro", () => {
    const moved = obj("moved", "M10 10 H20 V20 H10 Z", "L1", translationMatrix(500, 0));
    expect(classify([moved])).toEqual({ inside: [], outside: ["moved"], crossing: [] });
  });

  it("el ruido de punto flotante en el borde (1e-9) no cambia la clase; 1e-3 sí", () => {
    expect(classify([rect("noise", -1e-9, 10, 10, 10)]).inside).toEqual(["noise"]);
    expect(classify([rect("real", -1e-3, 10, 10, 10)]).crossing).toEqual(["real"]);
  });
});

function objectBounds(object: EditorObject) {
  return bounds([object])!;
}

describe("fitToContent", () => {
  it("abraza el bbox unión del contenido (más padding)", () => {
    const objects = [rect("a", 10, 20, 30, 10), rect("b", 60, 50, 10, 10)];
    expect(fitToContent(objects)).toEqual({ x: 10, y: 20, width: 60, height: 40 });
    expect(fitToContent(objects, 5)).toEqual({ x: 5, y: 15, width: 70, height: 50 });
  });

  it("sin geometría -> null; una sola línea (alto 0) no es un marco válido -> null", () => {
    expect(fitToContent([])).toBeNull();
    expect(fitToContent([obj("line", "M0 0 H50")])).toBeNull();
    expect(fitToContent([obj("line", "M0 0 H50")], 1)).toEqual({ x: -1, y: -1, width: 52, height: 2 });
  });
});

describe("frameWithAspect (presets 1:1, 4:3, 16:9)", () => {
  it("el rectángulo más grande de esa proporción que cabe CENTRADO", () => {
    expect(frameWithAspect({ x: 0, y: 0, width: 200, height: 100 }, 1)).toEqual({ x: 50, y: 0, width: 100, height: 100 });
    expect(frameWithAspect({ x: 0, y: 0, width: 100, height: 100 }, 2)).toEqual({ x: 0, y: 25, width: 100, height: 50 });
    const wide = frameWithAspect({ x: 10, y: 20, width: 100, height: 100 }, 16 / 9);
    expect(wide.width).toBe(100);
    expect(wide.width / wide.height).toBeCloseTo(16 / 9, 12);
    expect(frameCenter(wide)).toEqual({ x: 60, y: 70 });
  });

  it("una proporción inválida deja el marco como está", () => {
    expect(frameWithAspect(FRAME, 0)).toBe(FRAME);
    expect(frameWithAspect(FRAME, Number.NaN)).toBe(FRAME);
  });
});

describe("dimRects (exterior atenuado)", () => {
  it("cubre el exterior con 4 rectángulos que no pisan el hueco", () => {
    expect(dimRects({ x: 0, y: 0, width: 100, height: 100 }, { x: 20, y: 30, width: 40, height: 50 })).toEqual([
      { x: 0, y: 0, width: 100, height: 30 },
      { x: 0, y: 80, width: 100, height: 20 },
      { x: 0, y: 30, width: 20, height: 50 },
      { x: 60, y: 30, width: 40, height: 50 },
    ]);
  });

  it("descarta las franjas vacías (hueco pegado a un borde o igual al exterior)", () => {
    expect(dimRects({ x: 0, y: 0, width: 100, height: 100 }, { x: 0, y: 0, width: 100, height: 100 })).toEqual([]);
    expect(dimRects({ x: 0, y: 0, width: 100, height: 100 }, { x: 0, y: 0, width: 50, height: 100 })).toEqual([{ x: 50, y: 0, width: 50, height: 100 }]);
  });
});

describe("summarizeCrop", () => {
  const objectsByLayer = {
    L1: [rect("in", 10, 10, 10, 10, "L1"), rect("out1", 200, 0, 10, 10, "L1"), rect("cross", 90, 10, 20, 10, "L1")],
    LOCKED: [rect("out-locked", 300, 0, 10, 10, "LOCKED")],
    HIDDEN: [rect("out-hidden", 0, 300, 10, 10, "HIDDEN")],
  };
  const protection = { lockedLayerIds: new Set(["LOCKED"]), hiddenLayerIds: new Set(["HIDDEN"]) };

  it("cuenta dentro/cruzan/fuera y separa bloqueados y ocultos (que no se eliminan)", () => {
    expect(summarizeCrop(objectsByLayer, FRAME, protection, true)).toEqual({
      total: 5,
      inside: 1,
      crossing: 1,
      outside: 3,
      lockedOutside: 1,
      hiddenOutside: 1,
      removable: 1,
    });
  });

  it("con 'Eliminar objetos fuera del área' desmarcada no se elimina nada", () => {
    expect(summarizeCrop(objectsByLayer, FRAME, protection, false).removable).toBe(0);
  });

  it("una capa bloqueada Y oculta cuenta como bloqueada (no se duplica)", () => {
    const both = summarizeCrop(objectsByLayer, FRAME, { lockedLayerIds: new Set(["LOCKED", "HIDDEN"]), hiddenLayerIds: new Set(["HIDDEN"]) }, true);
    expect(both.lockedOutside).toBe(2);
    expect(both.hiddenOutside).toBe(0);
    expect(both.removable).toBe(1);
  });
});

describe("cropProduction", () => {
  const source = sourceFrameOf(200, 100);
  const state: EditableDocument = {
    frame: source,
    objectsByLayer: {
      L1: [rect("in", 10, 10, 10, 10), rect("out", 150, 10, 10, 10), rect("cross", 90, 10, 20, 10)],
      L2: [rect("in2", 20, 20, 5, 5, "L2")],
      L3: [rect("out3", 190, 90, 5, 5, "L3")],
    },
  };
  const target: DocumentFrame = { x: 0, y: 0, width: 100, height: 100 };

  it("UN solo resultado: nuevo marco + objetos eliminados; los que cruzan el borde se CONSERVAN completos", () => {
    const production = cropProduction(state, target, true)!;
    expect(production.frame).toEqual(target);
    expect(production.layers.L1.map((o) => o.id)).toEqual(["in", "cross"]);
    expect(production.layers.L3).toEqual([]);
    expect(production.layers.L2).toBeUndefined(); // capa sin cambios: no se toca
    // Los objetos que se conservan son los MISMOS (sin recortar ni modificar).
    expect(production.layers.L1[1]).toBe(state.objectsByLayer.L1[2]);
  });

  it("sin eliminar-fuera: solo cambia el marco y no se toca ninguna capa", () => {
    const production = cropProduction(state, target, false)!;
    expect(production.layers).toEqual({});
    expect(production.frame).toEqual(target);
  });

  it("marco igual al vigente y nada fuera: null (sin comando vacío); si hay objetos fuera igual los limpia, sin tocar el marco", () => {
    expect(cropProduction(state, source, true)).toBeNull(); // todo está dentro de 200×100
    const withStray = { ...state, objectsByLayer: { ...state.objectsByLayer, L2: [state.objectsByLayer.L2[0], rect("stray", 500, 0, 5, 5, "L2")] } };
    const clean = cropProduction(withStray, source, true)!;
    expect(clean.frame).toBeUndefined();
    expect(clean.layers.L2.map((o) => o.id)).toEqual(["in2"]);
  });

  it("destino inválido o estado sin marco: null", () => {
    expect(cropProduction(state, { x: 0, y: 0, width: 0, height: 10 }, true)).toBeNull();
    expect(cropProduction({ objectsByLayer: state.objectsByLayer }, target, true)).toBeNull();
  });
});

describe("orientDocumentProduction (rotar/reflejar el documento completo)", () => {
  const frame: DocumentFrame = { x: 0, y: 0, width: 200, height: 100 };
  const state: EditableDocument = {
    frame,
    objectsByLayer: { L1: [rect("a", 0, 0, 20, 10)], L2: [rect("b", 180, 90, 20, 10, "L2")] },
  };
  const cw = composeOrientation(IDENTITY_ORIENTATION, "rotate-cw");

  it("girar 90° horario: gira todos los objetos de todas las capas y el marco alrededor del centro del marco (valores a mano)", () => {
    const production = orientDocumentProduction(state, cw)!;
    expect(production.documentWide).toBe(true);
    expect(production.frame).toEqual({ x: 50, y: -50, width: 100, height: 200 });
    // Esquina (0,0) -> (150,-50); (20,10) -> (140,-30): bbox x 140..150, y -50..-30.
    expect(bounds(production.layers.L1)).toEqual({ x: 140, y: -50, width: 10, height: 20 });
    // Esquina (180,90) -> (60, 130); (200,100) -> (50,150): bbox x 50..60, y 130..150 (la esquina opuesta del marco nuevo).
    expect(bounds(production.layers.L2)).toEqual({ x: 50, y: 130, width: 10, height: 20 });
    // Todo queda dentro del marco nuevo.
    const { inside } = objectsRelativeToFrame(Object.values(production.layers).flat(), production.frame!);
    expect(inside).toHaveLength(2);
  });

  it("reflejar horizontal: el marco no cambia (misma referencia) y los objetos se espejan respecto del centro del marco", () => {
    const production = orientDocumentProduction(state, composeOrientation(IDENTITY_ORIENTATION, "flip-horizontal"))!;
    expect(production.frame).toBe(frame);
    // x' = 200 - x: el rectángulo 0..20 pasa a 180..200.
    expect(bounds(production.layers.L1)).toEqual({ x: 180, y: 0, width: 20, height: 10 });
  });

  it("rotate 90 x4 y flip x2 componen la identidad: no hay producción (sin comando vacío)", () => {
    let orientation = IDENTITY_ORIENTATION;
    for (let turn = 0; turn < 4; turn += 1) orientation = composeOrientation(orientation, "rotate-cw");
    expect(orientDocumentProduction(state, orientation)).toBeNull();
    const flipTwice = composeOrientation(composeOrientation(IDENTITY_ORIENTATION, "flip-vertical"), "flip-vertical");
    expect(orientDocumentProduction(state, flipTwice)).toBeNull();
  });

  it("girar 90° cuatro veces SEPARADAS (4 comandos) devuelve exactamente la matriz original y el marco original", () => {
    let current: EditableDocument = state;
    for (let turn = 0; turn < 4; turn += 1) {
      const production = orientDocumentProduction(current, cw)!;
      current = { objectsByLayer: { ...current.objectsByLayer, ...production.layers }, frame: production.frame };
    }
    expect(current.frame).toEqual(frame);
    expectSameMatrix(current.objectsByLayer.L1[0].matrix, IDENTITY);
    expectSameMatrix(current.objectsByLayer.L2[0].matrix, IDENTITY);
  });

  it("sin marco, con marco inválido o con la orientación identidad: null", () => {
    expect(orientDocumentProduction({ objectsByLayer: state.objectsByLayer }, cw)).toBeNull();
    expect(orientDocumentProduction({ ...state, frame: sourceFrameOf(0, 0) }, cw)).toBeNull();
    expect(orientDocumentProduction(state, IDENTITY_ORIENTATION)).toBeNull();
  });

  it("las capas sin objetos no se tocan", () => {
    const production = orientDocumentProduction({ frame, objectsByLayer: { L1: state.objectsByLayer.L1, EMPTY: [] } }, cw)!;
    expect(Object.keys(production.layers)).toEqual(["L1"]);
  });

  it("un objeto ya rotado conserva su rotación al girar el documento (matrices compuestas, d intacto)", () => {
    const rotated = obj("r", "M0 0 H10 V10 H0 Z", "L1", rotationAboutMatrix({ x: 5, y: 5 }, 90));
    const production = orientDocumentProduction({ frame, objectsByLayer: { L1: [rotated] } }, cw)!;
    expect(production.layers.L1[0].d).toBe("M0 0 H10 V10 H0 Z");
  });
});

describe("round-trip del marco (viewBox + mm)", () => {
  it("viewBox <-> marco sin pérdida, incluso con decimales y origen negativo", () => {
    for (const frame of [{ x: 0, y: 0, width: 320, height: 240 }, { x: -50.25, y: 12.125, width: 99.875, height: 0.1 }, { x: 50, y: -50, width: 100, height: 200 }]) {
      expect(viewBoxToFrame(frameToViewBox(frame))).toEqual(frame);
    }
    expect(frameToViewBox({ x: 50, y: -50, width: 100, height: 200 })).toBe("50 -50 100 200");
  });

  it("serializeFrame / deserializeFrame conservan marco y escala (mm por unidad)", () => {
    const frame = { x: 20, y: 10, width: 160, height: 120 };
    const serialized = serializeFrame(frame, 0.5);
    expect(serialized).toEqual({ viewBox: "20 10 160 120", widthMm: 80, heightMm: 60 });
    expect(deserializeFrame(serialized)).toEqual({ frame, mmPerUnit: 0.5 });
  });

  it("sin escala física: mm null y la escala vuelve null (no se inventa)", () => {
    const serialized = serializeFrame(FRAME, null);
    expect(serialized.widthMm).toBeNull();
    expect(deserializeFrame(serialized)).toEqual({ frame: FRAME, mmPerUnit: null });
  });

  it("viewBox inválido (cantidad de números, NaN, ancho 0, vacío) -> null", () => {
    expect(viewBoxToFrame("0 0 10")).toBeNull();
    expect(viewBoxToFrame("0 0 a b")).toBeNull();
    expect(viewBoxToFrame("0 0 0 10")).toBeNull();
    expect(viewBoxToFrame("")).toBeNull();
    expect(viewBoxToFrame(null)).toBeNull();
    expect(deserializeFrame({ viewBox: "x", widthMm: 1, heightMm: 1 })).toBeNull();
  });

  it("el SVG de capa serializado con el marco lleva su viewBox y los objetos sobreviven al round-trip (ids, d, fill, matriz)", () => {
    const frame = { x: 50, y: -50, width: 100, height: 200 };
    const objects = [obj("a", "M0 0 H10 V10 H0 Z", "L1", rotationAboutMatrix({ x: 5, y: 5 }, 90))];
    const svg = serializeEditableLayer(objects, { width: frame.width, height: frame.height, x: frame.x, y: frame.y });
    expect(new DOMParser().parseFromString(svg, "image/svg+xml").documentElement.getAttribute("viewBox")).toBe("50 -50 100 200");
    expect(viewBoxToFrame(new DOMParser().parseFromString(svg, "image/svg+xml").documentElement.getAttribute("viewBox"))).toEqual(frame);
    expect(parseEditableLayer(svg, "L1", "#000000")).toEqual(objects);
  });

  it("sin origen en la meta el viewBox sigue siendo '0 0 w h' (compatibilidad con S01)", () => {
    expect(serializeEditableLayer([], { width: 320, height: 240 })).toContain('viewBox="0 0 320 240"');
  });
});

describe("framesEqual", () => {
  it("compara los cuatro campos", () => {
    expect(framesEqual(FRAME, { ...FRAME })).toBe(true);
    expect(framesEqual(FRAME, { ...FRAME, x: 1 })).toBe(false);
    expect(framesEqual(FRAME, { ...FRAME, height: 99 })).toBe(false);
  });
});
