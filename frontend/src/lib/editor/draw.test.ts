import { describe, expect, it } from "vitest";
import { IDENTITY_MATRIX } from "../svgTransform";
import {
  buildDrawProduction,
  buildNormalizeRequest,
  createDrawingLayer,
  createDrawnObject,
  dedupePoints,
  DEFAULT_DRAW_COLOR,
  drawingLayerName,
  drawPathData,
  drawTargetInfo,
  MAX_DRAW_POINTS,
  objectsFromPolygonPieces,
  planStroke,
  polygonArea,
  resolveDrawTarget,
  segmentsIntersect,
  selfIntersects,
  simplifyPolyline,
} from "./draw";
import { parsePathData } from "./pathGeometry";
import type { EditableDocument, EditableLayerMeta, EditorObject, Point } from "./types";

const p = (x: number, y: number): Point => ({ x, y });

function meta(groupId: string, overrides: Partial<EditableLayerMeta> = {}): EditableLayerMeta {
  return { groupId, name: groupId, colorHex: "#ff0000", order: 0, visible: true, locked: false, manufacturingOperation: "unassigned", isNew: false, ...overrides };
}

function object(id: string, layerGroupId: string): EditorObject {
  return { id, layerGroupId, d: "M0 0 L1 0 L1 1 Z", fill: "#ff0000", matrix: IDENTITY_MATRIX };
}

describe("dedupePoints", () => {
  it("quita los puntos a ≤ epsilon del último conservado, sin reordenar", () => {
    expect(dedupePoints([p(0, 0), p(0, 0), p(0.005, 0), p(1, 0), p(1, 0.004), p(2, 0)], 0.01)).toEqual([p(0, 0), p(1, 0), p(2, 0)]);
  });

  it("con epsilon 0 solo quita los idénticos consecutivos", () => {
    expect(dedupePoints([p(0, 0), p(0, 0), p(0, 0.001)], 0)).toEqual([p(0, 0), p(0, 0.001)]);
  });
});

describe("simplifyPolyline (Ramer–Douglas–Peucker)", () => {
  it("quita un punto a 0,25 de la cuerda cuando la tolerancia es ≥ 0,25 y lo conserva si es menor (frontera exacta)", () => {
    const bump = [p(0, 0), p(5, 0.25), p(10, 0)];
    expect(simplifyPolyline(bump, 0.25)).toEqual([p(0, 0), p(10, 0)]);
    expect(simplifyPolyline(bump, 0.2499)).toEqual(bump);
    expect(simplifyPolyline(bump, 1)).toEqual([p(0, 0), p(10, 0)]);
  });

  it("conserva la esquina de una L (distancia a la cuerda 100/√200 ≈ 7,07 > tolerancia)", () => {
    const corner = [p(0, 0), p(10, 0), p(10, 10)];
    expect(simplifyPolyline(corner, 1)).toEqual(corner);
    expect(simplifyPolyline(corner, 7.08)).toEqual([p(0, 0), p(10, 10)]);
  });

  it("aplana un zigzag de ruido de 0,1 con tolerancia 0,2 a sus extremos", () => {
    expect(simplifyPolyline([p(0, 0), p(1, 0.1), p(2, -0.1), p(3, 0.1), p(4, 0)], 0.2)).toEqual([p(0, 0), p(4, 0)]);
  });

  it("ante un empate gana el primer punto más lejano y se conservan los que siguen fuera de tolerancia", () => {
    // (2,1) y (6,1) empatan a distancia 1 de la cuerda (0,0)-(8,0): entra (2,1); luego (4,0) y (6,1) quedan a 4/√37 ≈ 0,657 > 0,5 de (2,1)-(8,0).
    const zigzag = [p(0, 0), p(2, 1), p(4, 0), p(6, 1), p(8, 0)];
    expect(simplifyPolyline(zigzag, 0.5)).toEqual(zigzag);
    // Con tolerancia 0,7 esos dos ya entran en tolerancia y quedan solo (2,1) y los extremos.
    expect(simplifyPolyline(zigzag, 0.7)).toEqual([p(0, 0), p(2, 1), p(8, 0)]);
  });

  it("siempre conserva el primero y el último, no muta la entrada y es determinista", () => {
    const input = [p(0, 0), p(1, 0.1), p(2, 0), p(3, 0.1), p(4, 0)];
    const snapshot = JSON.stringify(input);
    const first = simplifyPolyline(input, 0.5);
    expect(first[0]).toBe(input[0]);
    expect(first[first.length - 1]).toBe(input[input.length - 1]);
    expect(simplifyPolyline(input, 0.5)).toEqual(first);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("devuelve una copia si hay ≤ 2 puntos o la tolerancia no es positiva", () => {
    const two = [p(0, 0), p(1, 1)];
    expect(simplifyPolyline(two, 5)).toEqual(two);
    expect(simplifyPolyline(two, 5)).not.toBe(two);
    const three = [p(0, 0), p(1, 0.5), p(2, 0)];
    expect(simplifyPolyline(three, 0)).toEqual(three);
    expect(simplifyPolyline(three, -1)).toEqual(three);
  });

  it("no desborda la pila con un trazo largo y conserva sus extremos", () => {
    const long = Array.from({ length: 5000 }, (_, index) => p(index, index % 2 === 0 ? 0 : 5));
    const simplified = simplifyPolyline(long, 1);
    expect(simplified[0]).toBe(long[0]);
    expect(simplified[simplified.length - 1]).toBe(long[long.length - 1]);
  });
});

describe("polygonArea / segmentsIntersect / selfIntersects", () => {
  it("área con signo: 4 x 3 = 12 antihorario en matemáticas, -12 al invertir", () => {
    const rect = [p(0, 0), p(4, 0), p(4, 3), p(0, 3)];
    expect(polygonArea(rect)).toBe(12);
    expect(polygonArea([...rect].reverse())).toBe(-12);
  });

  it("segmentos que se cruzan, se tocan en un extremo, se superponen en línea o son paralelos/disjuntos", () => {
    expect(segmentsIntersect(p(0, 0), p(4, 4), p(0, 4), p(4, 0))).toBe(true);
    expect(segmentsIntersect(p(0, 0), p(2, 0), p(2, 0), p(2, 2))).toBe(true);
    expect(segmentsIntersect(p(0, 0), p(4, 0), p(2, 0), p(6, 0))).toBe(true);
    expect(segmentsIntersect(p(0, 0), p(1, 0), p(2, 0), p(3, 0))).toBe(false);
    expect(segmentsIntersect(p(0, 0), p(4, 0), p(0, 1), p(4, 1))).toBe(false);
    expect(segmentsIntersect(p(0, 0), p(1, 1), p(2, 0), p(3, 5))).toBe(false);
  });

  it("un moño se auto-intersecta; un cuadrado, un triángulo y un círculo de 100 puntos no", () => {
    expect(selfIntersects([p(0, 0), p(40, 40), p(40, 0), p(0, 40)])).toBe(true);
    expect(selfIntersects([p(0, 0), p(40, 0), p(40, 40), p(0, 40)])).toBe(false);
    expect(selfIntersects([p(0, 0), p(10, 0), p(0, 10)])).toBe(false);
    const circle = Array.from({ length: 100 }, (_, index) => p(50 * Math.cos((index * Math.PI * 2) / 100), 50 * Math.sin((index * Math.PI * 2) / 100)));
    expect(selfIntersects(circle)).toBe(false);
  });

  it("una espina que vuelve sobre sí misma (lados contiguos superpuestos) cuenta como auto-intersección", () => {
    expect(selfIntersects([p(0, 0), p(10, 0), p(5, 0), p(5, 5)])).toBe(true);
  });

  it("detecta el cruce entre lados no contiguos aunque estén lejos en la lista", () => {
    // Una "C" cuyos extremos se cruzan: el lado 0 corta al lado 4.
    expect(selfIntersects([p(0, 5), p(10, 5), p(10, 10), p(0, 10), p(5, 0), p(5, 7)])).toBe(true);
  });

  it("con más de 1500 puntos no revisa en el cliente y delega en el servidor (true)", () => {
    const circle = Array.from({ length: 1501 }, (_, index) => p(50 * Math.cos((index * Math.PI * 2) / 1501), 50 * Math.sin((index * Math.PI * 2) / 1501)));
    expect(selfIntersects(circle)).toBe(true);
  });
});

describe("planStroke", () => {
  it("acepta una línea abierta de 2 puntos distintos y no pide normalizar", () => {
    expect(planStroke([p(0, 0), p(10, 0)], false, 0.01)).toEqual({ ok: true, points: [p(0, 0), p(10, 0)], closed: false, needsNormalize: false });
  });

  it("rechaza una línea cuyos puntos colapsan dentro de la distancia mínima (1 punto distinto)", () => {
    const plan = planStroke([p(0, 0), p(0.005, 0)], false, 0.01);
    expect(plan.ok).toBe(false);
    expect(plan.ok === false && plan.error).toMatch(/al menos 2 puntos distintos/);
  });

  it("rechaza un solo punto y un trazo vacío", () => {
    expect(planStroke([p(1, 1)], false, 0.01).ok).toBe(false);
    expect(planStroke([], false, 0.01).ok).toBe(false);
  });

  it("acepta un cerrado de 3 puntos con área real y lo deja sin normalizar", () => {
    const plan = planStroke([p(0, 0), p(10, 0), p(0, 10)], true, 0.01);
    expect(plan).toEqual({ ok: true, points: [p(0, 0), p(10, 0), p(0, 10)], closed: true, needsNormalize: false });
  });

  it("rechaza un cerrado con menos de 3 puntos distintos o sin área (alineados)", () => {
    const few = planStroke([p(0, 0), p(10, 0)], true, 0.01);
    expect(few.ok === false && few.error).toMatch(/al menos 3 puntos distintos/);
    const flat = planStroke([p(0, 0), p(5, 0), p(10, 0)], true, 0.01);
    expect(flat.ok === false && flat.error).toMatch(/no encierra área/);
  });

  it("descarta el último punto de un cerrado si coincide con el primero (cierre explícito)", () => {
    const plan = planStroke([p(0, 0), p(10, 0), p(10, 10), p(0, 10), p(0.005, 0.005)], true, 0.01);
    expect(plan.ok && plan.points).toHaveLength(4);
  });

  it("marca para normalizar un cerrado auto-intersecado (moño) y no una espiral abierta", () => {
    const bowtie = planStroke([p(0, 0), p(40, 40), p(40, 0), p(0, 40)], true, 0.01);
    expect(bowtie.ok && bowtie.needsNormalize).toBe(true);
    // Una línea abierta puede cruzarse: es un trazo legítimo, no geometría inválida.
    const crossing = planStroke([p(0, 0), p(40, 40), p(40, 0), p(0, 40)], false, 0.01);
    expect(crossing.ok && crossing.needsNormalize).toBe(false);
  });

  it("rechaza NaN, Infinity y coordenadas fuera de rango", () => {
    expect(planStroke([p(0, 0), p(Number.NaN, 5)], false, 0.01).ok).toBe(false);
    expect(planStroke([p(0, 0), p(Number.POSITIVE_INFINITY, 5)], false, 0.01).ok).toBe(false);
    expect(planStroke([p(0, 0), p(2_000_000, 5)], false, 0.01).ok).toBe(false);
  });

  it("rechaza un trazo con más puntos que el máximo", () => {
    const huge = Array.from({ length: MAX_DRAW_POINTS + 1 }, (_, index) => p(index, 0));
    const plan = planStroke(huge, false, 0.01);
    expect(plan.ok === false && plan.error).toMatch(/demasiados puntos/);
    expect(planStroke(huge.slice(0, MAX_DRAW_POINTS), false, 0.01).ok).toBe(true);
  });
});

describe("conversión a d y objetos nuevos", () => {
  it("drawPathData: abierto no lleva Z, cerrado sí", () => {
    expect(drawPathData([p(0, 0), p(10, 5)], false)).toBe("M0 0 L10 5");
    expect(drawPathData([p(0, 0), p(10, 0), p(10, 5)], true)).toBe("M0 0 L10 0 L10 5 Z");
  });

  it("el d generado se vuelve a leer sin error", () => {
    expect(parsePathData(drawPathData([p(0.123456789, 1), p(2, 3), p(4, 0)], true)).error).toBeNull();
  });

  it("un cerrado es un relleno con el color de la capa y SIN trazo", () => {
    const created = createDrawnObject({ id: "n1", layerGroupId: "A", colorHex: "#00ff00", points: [p(0, 0), p(10, 0), p(0, 10)], closed: true, lineWidth: 0.5 });
    expect(created).toEqual({ id: "n1", layerGroupId: "A", d: "M0 0 L10 0 L0 10 Z", fill: "#00ff00", matrix: IDENTITY_MATRIX });
    expect("stroke" in created).toBe(false);
    expect("strokeWidth" in created).toBe(false);
  });

  it("un abierto es fill none + trazo del color de la capa con el ancho pedido", () => {
    const created = createDrawnObject({ id: "n2", layerGroupId: "A", colorHex: "#00ff00", points: [p(0, 0), p(10, 0)], closed: false, lineWidth: 0.35 });
    expect(created).toEqual({ id: "n2", layerGroupId: "A", d: "M0 0 L10 0", fill: "none", stroke: "#00ff00", strokeWidth: 0.35, matrix: IDENTITY_MATRIX });
  });

  it("buildNormalizeRequest manda el anillo como un solo subject polygon, sin operandos", () => {
    expect(buildNormalizeRequest([p(0, 0), p(40, 40), p(40, 0), p(0, 40)], 0.01)).toEqual({
      operation: "normalize",
      subjects: [{ type: "polygon", coordinates: [[[0, 0], [40, 40], [40, 0], [0, 40]]] }],
      operands: [],
      tolerance: 0.01,
    });
  });

  it("objectsFromPolygonPieces crea un objeto relleno por pieza con ids nuevos y los huecos como subpaths", () => {
    let counter = 0;
    const created = objectsFromPolygonPieces(
      [
        { type: "polygon", coordinates: [[[0, 0], [40, 0], [40, 40], [0, 40], [0, 0]], [[10, 10], [10, 20], [20, 20], [20, 10], [10, 10]]] },
        { type: "polygon", coordinates: [[[100, 0], [110, 0], [110, 10], [100, 0]]] },
      ],
      { layerGroupId: "A", colorHex: "#111111", createId: () => `id-${(counter += 1)}` },
    );
    expect(created?.map((o) => o.id)).toEqual(["id-1", "id-2"]);
    expect(created?.[0].d).toBe("M0 0 L40 0 L40 40 L0 40 Z M10 10 L10 20 L20 20 L20 10 Z");
    expect(created?.every((o) => o.fill === "#111111" && o.layerGroupId === "A")).toBe(true);
  });

  it("objectsFromPolygonPieces rechaza TODO si una pieza no es un polígono o no se puede dibujar", () => {
    const base = { layerGroupId: "A", colorHex: "#111111", createId: () => "x" };
    expect(objectsFromPolygonPieces([{ type: "line", coordinates: [[0, 0], [1, 1]] }], base)).toBeNull();
    expect(objectsFromPolygonPieces([{ type: "polygon", coordinates: [[[0, 0], [1, 1], [0, 0]]] }], base)).toBeNull();
    expect(objectsFromPolygonPieces([{ type: "polygon", coordinates: [[[0, 0], [Number.NaN, 1], [1, 1], [0, 0]]] }], base)).toBeNull();
    expect(objectsFromPolygonPieces([], base)).toBeNull();
  });
});

describe("capa de destino", () => {
  const layers = [meta("A", { name: "Rojo" }), meta("B", { name: "Candado", locked: true }), meta("C", { name: "Oculta", visible: false })];

  it("sin capa activa (o una que ya no existe) se crea una capa nueva «Dibujo»", () => {
    expect(resolveDrawTarget(layers, null, "new-1")).toEqual({ ok: true, target: { kind: "create", groupId: "new-1" } });
    expect(resolveDrawTarget(layers, "ya-no-existe", "new-2")).toEqual({ ok: true, target: { kind: "create", groupId: "new-2" } });
  });

  it("con capa activa visible y desbloqueada se dibuja ahí", () => {
    const result = resolveDrawTarget(layers, "A", "new-1");
    expect(result.ok && result.target).toEqual({ kind: "existing", layer: layers[0] });
  });

  it("capa bloqueada u oculta: rechazo claro con el nombre de la capa y qué hacer, sin elegir otra capa", () => {
    const locked = resolveDrawTarget(layers, "B", "new-1");
    expect(locked.ok).toBe(false);
    expect(!locked.ok && locked.message).toBe("La capa «Candado» está bloqueada. Desbloqueá la capa «Candado» o elegí otra. No se creó nada.");
    const hidden = resolveDrawTarget(layers, "C", "new-1");
    expect(!hidden.ok && hidden.message).toBe("La capa «Oculta» está oculta. Mostrá la capa «Oculta» o elegí otra. No se creó nada.");
  });

  it("drawTargetInfo: la capa existente aporta su color; la nueva, negro #000000", () => {
    expect(drawTargetInfo({ kind: "existing", layer: layers[0] })).toEqual({ groupId: "A", colorHex: "#ff0000" });
    expect(drawTargetInfo({ kind: "create", groupId: "new-1" })).toEqual({ groupId: "new-1", colorHex: DEFAULT_DRAW_COLOR });
    expect(DEFAULT_DRAW_COLOR).toBe("#000000");
  });

  it("el nombre de la capa nueva es «Dibujo» y se desambigua", () => {
    expect(drawingLayerName([])).toBe("Dibujo");
    expect(drawingLayerName(["Dibujo"])).toBe("Dibujo (2)");
    expect(drawingLayerName(["Dibujo", "Dibujo (2)"])).toBe("Dibujo (3)");
  });

  it("createDrawingLayer: negro, al final del orden, visible, desbloqueada, isNew y operación sin asignar", () => {
    const created = createDrawingLayer([meta("A", { order: 0 }), meta("B", { order: 4 })], "new-1");
    expect(created).toEqual({ groupId: "new-1", name: "Dibujo", colorHex: "#000000", order: 5, visible: true, locked: false, manufacturingOperation: "unassigned", isNew: true });
  });
});

describe("buildDrawProduction", () => {
  const state = (layerMetas: EditableLayerMeta[], objectsByLayer: Record<string, EditorObject[]>): EditableDocument => ({ objectsByLayer, layers: layerMetas });

  it("en una capa existente agrega los objetos al final de ESA capa y nada más", () => {
    const existing = object("o1", "A");
    const fresh = object("n1", "A");
    const production = buildDrawProduction(state([meta("A")], { A: [existing], B: [object("o2", "B")] }), [fresh], { kind: "existing", layer: meta("A") });
    expect(production).toEqual({ layers: { A: [existing, fresh] }, atomic: true });
  });

  it("en una capa nueva el MISMO comando incluye la capa (layerMetas) y los objetos", () => {
    const fresh = object("n1", "new-1");
    const production = buildDrawProduction(state([meta("A", { order: 2 })], { A: [] }), [fresh], { kind: "create", groupId: "new-1" });
    expect(production?.layers).toEqual({ "new-1": [fresh] });
    expect(production?.layerMetas).toEqual([{ groupId: "new-1", name: "Dibujo", colorHex: "#000000", order: 3, visible: true, locked: false, manufacturingOperation: "unassigned", isNew: true }]);
    expect(production?.atomic).toBe(true);
  });

  it("sin objetos no hay producción", () => {
    expect(buildDrawProduction(state([], {}), [], { kind: "create", groupId: "new-1" })).toBeNull();
  });
});
