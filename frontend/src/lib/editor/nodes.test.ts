import { describe, expect, it } from "vitest";
import {
  addNodeOnSegment,
  closeSubpath,
  closeSubpathBlocker,
  closestPointOnSegment,
  createKindMemory,
  deleteNodes,
  inferKind,
  isSegmentCurved,
  kindsHintFor,
  kindsOf,
  modelBounds,
  modelSignature,
  modelToPath,
  moveAnchors,
  moveHandle,
  nodeCount,
  nodeKey,
  openSubpathAt,
  parseNodeKey,
  pathToModel,
  pointOnCurve,
  rememberKinds,
  segmentCurve,
  setAnchor,
  setAnchors,
  setHandleVector,
  setNodeKind,
  splitCubic,
  toggleNodeKind,
  toggleSegmentKind,
  toggleSegments,
  validateModel,
  type ModelResult,
  type NodeKind,
  type PathModel,
  type PathNode,
} from "./nodes";
import { distanceToPolylines, flattenSegments, parsePathData } from "./pathGeometry";
import type { Point } from "./types";

/**
 * Modelo de nodos (M3-S05) con valores calculados A MANO: round-trip d -> modelo -> d, inferencia de tipo, movimiento, reglas de handles por
 * tipo, De Casteljau exacto, eliminación mínima, cerrar/abrir, alternar segmentos, setters del Inspector, idempotencia y precisión.
 */

function parse(d: string, hint?: NodeKind[][]): PathModel {
  const result = pathToModel(d, hint);
  if (!result.ok) throw new Error(result.error);
  return result.model;
}

function ok(result: ModelResult) {
  if (!result.ok) throw new Error(result.error);
  return result;
}

function node(anchor: Point, handleIn: Point | null, handleOut: Point | null, kind: NodeKind): PathNode {
  return { anchor, handleIn, handleOut, kind };
}

function literal(nodes: PathNode[], closed = false): PathModel {
  return { subpaths: [{ closed, nodes }] };
}

/** Área con signo (cordón) de un subpath POLIGONAL: el signo es el sentido de giro. */
function signedArea(points: Point[]): number {
  let twice = 0;
  points.forEach((p, index) => {
    const q = points[(index + 1) % points.length];
    twice += p.x * q.y - q.x * p.y;
  });
  return twice / 2;
}

function polyline(d: string, flatness = 0.005) {
  return flattenSegments(parsePathData(d).segments, flatness);
}

/** Distancia máxima de los puntos del aplanado de `from` al aplanado de `to` (forma idéntica => ~0). */
function maxDeviation(from: string, to: string): number {
  const target = polyline(to);
  let worst = 0;
  for (const line of polyline(from)) for (const point of line.points) worst = Math.max(worst, distanceToPolylines(target, point, true));
  return worst;
}

const SQUARE = "M0 0 L10 0 L10 10 L0 10 Z";
const CURVE_SYMMETRIC = "M0 0 C2 4 6 4 8 0 C10 -4 14 -4 16 0";
const CURVE_SMOOTH = "M0 0 C2 4 6 3 8 0 C12 -6 14 -4 16 0";
const CURVE_CORNER = "M0 0 C2 4 6 4 8 0 C8 -5 14 -4 16 0";
const ARCH = "M0 0 C0 8 8 8 8 0";

describe("pathToModel / modelToPath — round trip", () => {
  it("rectas: subpath cerrado de 4 nodos corner sin handles, y vuelve al mismo d", () => {
    const model = parse(SQUARE);
    expect(model.subpaths).toHaveLength(1);
    expect(model.subpaths[0].closed).toBe(true);
    expect(model.subpaths[0].nodes.map((n) => n.anchor)).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]);
    expect(model.subpaths[0].nodes.every((n) => n.handleIn === null && n.handleOut === null && n.kind === "corner")).toBe(true);
    expect(modelToPath(model)).toBe(SQUARE);
  });

  it("H, V y relativos se normalizan a absolutos (el parser los resuelve)", () => {
    expect(modelToPath(parse("M0 0 H10 V10 h-10 z"))).toBe("M0 0 L10 0 L10 10 L0 10 Z");
  });

  it("curva abierta: dos nodos con los handles de la cúbica y el mismo d de vuelta", () => {
    const model = parse(ARCH);
    const [start, end] = model.subpaths[0].nodes;
    expect(model.subpaths[0].closed).toBe(false);
    expect(start.handleOut).toEqual({ x: 0, y: 8 });
    expect(start.handleIn).toBeNull();
    expect(end.handleIn).toEqual({ x: 8, y: 8 });
    expect(end.handleOut).toBeNull();
    expect(modelToPath(model)).toBe(ARCH);
  });

  it("arco normalizado: el semicírculo son 2 cúbicas (3 nodos) y su nodo medio cae en (5, -5)", () => {
    const model = parse("M0 0 A5 5 0 0 1 10 0");
    const nodes = model.subpaths[0].nodes;
    expect(nodes).toHaveLength(3);
    expect(nodes[1].anchor.x).toBeCloseTo(5, 9);
    expect(nodes[1].anchor.y).toBeCloseTo(-5, 9);
    expect(nodes[2].anchor.x).toBeCloseTo(10, 9);
    // El nodo medio del arco es una tangente continua: se infiere suave/simétrico, no corner.
    expect(nodes[1].kind).not.toBe("corner");
  });

  it("compound path con hueco: subpaths en ORDEN y cada uno con su sentido de giro (winding)", () => {
    const d = "M0 0 L100 0 L100 100 L0 100 Z M20 20 L20 80 L80 80 L80 20 Z";
    const model = parse(d);
    expect(model.subpaths).toHaveLength(2);
    const areas = model.subpaths.map((subpath) => signedArea(subpath.nodes.map((n) => n.anchor)));
    expect(areas[0]).toBe(10000);
    expect(areas[1]).toBe(-3600);
    expect(Math.sign(areas[0])).not.toBe(Math.sign(areas[1]));
    const roundTrip = modelToPath(model);
    expect(roundTrip).toBe(d);
    const again = parse(roundTrip);
    expect(again.subpaths.map((subpath) => signedArea(subpath.nodes.map((n) => n.anchor)))).toEqual(areas);
  });

  it("un cierre curvo (`C ... x0 y0 Z`) fusiona el último nodo con el primero y se vuelve a emitir igual", () => {
    const d = "M0 0 C0 10 10 10 10 0 C10 -10 0 -10 0 0 Z";
    const model = parse(d);
    const nodes = model.subpaths[0].nodes;
    expect(model.subpaths[0].closed).toBe(true);
    expect(nodes).toHaveLength(2);
    expect(nodes[0].handleIn).toEqual({ x: 0, y: -10 });
    expect(nodes[0].handleOut).toEqual({ x: 0, y: 10 });
    expect(modelToPath(model)).toBe(d);
  });

  it("un cierre recto que repite el primer punto se fusiona (y el Z lo cierra)", () => {
    expect(modelToPath(parse("M0 0 L10 0 L10 10 L0 0 Z"))).toBe("M0 0 L10 0 L10 10 Z");
  });

  it("abierto que termina donde empieza (sin Z) NO se fusiona: sigue siendo un path abierto de 4 nodos", () => {
    const model = parse("M0 0 L10 0 L10 10 L0 0");
    expect(model.subpaths[0].closed).toBe(false);
    expect(model.subpaths[0].nodes).toHaveLength(4);
  });

  it("formato numérico: hasta 6 decimales, sin ceros sobrantes ni -0", () => {
    expect(modelToPath(parse("M0.1234567891 0.5 L1.000000 -0 L2.25 3.1000004"))).toBe("M0.123457 0.5 L1 0 L2.25 3.1");
  });

  it("idempotencia: d -> modelo -> d -> modelo -> d no cambia en la segunda vuelta (rectas, curvas, arcos, compuestos, cierres curvos)", () => {
    const inputs = [
      SQUARE,
      CURVE_SYMMETRIC,
      CURVE_SMOOTH,
      "M0 0 A5 5 0 0 1 10 0 L10 10 Z",
      "M0.333333333 0.666666666 C1.1234567 2.7654321 3.3333333 4.4444444 5.5555555 6.6666666",
      "M0 0 L100 0 L100 100 L0 100 Z M20 20 L20 80 L80 80 L80 20 Z",
      "M0 0 C0 10 10 10 10 0 C10 -10 0 -10 0 0 Z",
      "m10 10 q5 -10 10 0 t10 0 s5 5 10 0 z",
    ];
    for (const input of inputs) {
      const once = modelToPath(parse(input));
      const twice = modelToPath(parse(once));
      expect(twice).toBe(once);
      expect(parse(twice)).toEqual(parse(once));
    }
  });

  it("entradas inválidas: se rechazan con mensaje (sin reserializar una cola dañada)", () => {
    expect(pathToModel("M0 0 L10 foo")).toMatchObject({ ok: false });
    expect(pathToModel("")).toMatchObject({ ok: false, error: expect.stringContaining("vacío") });
    expect(pathToModel("L10 10")).toMatchObject({ ok: false });
    expect(pathToModel("M0 0 L10 10 Q")).toMatchObject({ ok: false });
  });

  it("un solo punto (`M5 5`) y un segmento de largo 0 son modelos válidos y degenerados", () => {
    expect(nodeCount(parse("M5 5"))).toBe(1);
    expect(modelToPath(parse("M5 5"))).toBe("M5 5");
    expect(modelToPath(parse("M3 3 L3 3"))).toBe("M3 3 L3 3");
    expect(modelToPath(parse("M5 5 Z"))).toBe("M5 5 Z");
  });
});

describe("inferKind", () => {
  it("symmetric: handles collineales, en sentidos continuos y de igual largo", () => {
    expect(parse("M0 0 C1 0 2 0 5 0 C8 0 9 0 10 0").subpaths[0].nodes[1].kind).toBe("symmetric");
    expect(parse(CURVE_SYMMETRIC).subpaths[0].nodes[1].kind).toBe("symmetric");
  });

  it("smooth: collineales con largos distintos", () => {
    expect(parse("M0 0 C1 0 2 0 5 0 C9 0 9 0 10 0").subpaths[0].nodes[1].kind).toBe("smooth");
    expect(parse(CURVE_SMOOTH).subpaths[0].nodes[1].kind).toBe("smooth");
  });

  it("corner: no collineales, handle de salida que vuelve sobre el de llegada, un solo handle, o handle de largo 0", () => {
    expect(parse(CURVE_CORNER).subpaths[0].nodes[1].kind).toBe("corner");
    expect(parse("M0 0 C1 0 2 0 5 0 C3 0 9 0 10 0").subpaths[0].nodes[1].kind).toBe("corner");
    expect(inferKind(node({ x: 0, y: 0 }, { x: -1, y: 0 }, null, "corner"))).toBe("corner");
    expect(inferKind(node({ x: 0, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 0 }, "corner"))).toBe("corner");
    // Los extremos de un abierto y los nodos de un polígono son corner.
    expect(parse(SQUARE).subpaths[0].nodes.every((n) => n.kind === "corner")).toBe(true);
  });

  it("la pista del usuario manda si la geometría la admite: corner sobre handles collineales se conserva; symmetric sobre uno solo smooth NO", () => {
    const kinds = (d: string, hint: NodeKind[][]) => kindsOf(parse(d, hint))[0];
    expect(kinds(CURVE_SYMMETRIC, [["corner", "corner", "corner"]])).toEqual(["corner", "corner", "corner"]);
    expect(kinds(CURVE_SYMMETRIC, [["corner", "smooth", "corner"]])).toEqual(["corner", "smooth", "corner"]);
    expect(kinds(CURVE_SMOOTH, [["corner", "symmetric", "corner"]])).toEqual(["corner", "smooth", "corner"]);
    // Una pista con otra forma (distinta cantidad de nodos) se ignora entera.
    expect(kinds(CURVE_SYMMETRIC, [["corner", "corner"]])).toEqual(["corner", "symmetric", "corner"]);
  });
});

describe("moveAnchors — los handles viajan con su anchor", () => {
  it("mover B (3, 2) mueve su anchor y sus dos handles; los otros nodos son los MISMOS objetos", () => {
    const model = parse(CURVE_SYMMETRIC);
    const moved = ok(moveAnchors(model, [{ subpath: 0, node: 1 }], { x: 3, y: 2 })).model;
    const [a, b, c] = moved.subpaths[0].nodes;
    expect(b.anchor).toEqual({ x: 11, y: 2 });
    expect(b.handleIn).toEqual({ x: 9, y: 6 });
    expect(b.handleOut).toEqual({ x: 13, y: -2 });
    expect(b.kind).toBe("symmetric");
    expect(a).toBe(model.subpaths[0].nodes[0]);
    expect(c).toBe(model.subpaths[0].nodes[2]);
    expect(modelToPath(moved)).toBe("M0 0 C2 4 9 6 11 2 C13 -2 14 -4 16 0");
    // El original no se tocó (inmutable).
    expect(modelToPath(model)).toBe(CURVE_SYMMETRIC);
  });

  it("varios nodos a la vez y refs repetidas (una sola vez)", () => {
    const model = parse(CURVE_SYMMETRIC);
    const refs = [
      { subpath: 0, node: 0 },
      { subpath: 0, node: 2 },
      { subpath: 0, node: 0 },
    ];
    const moved = ok(moveAnchors(model, refs, { x: 1, y: 1 })).model;
    expect(modelToPath(moved)).toBe("M1 1 C3 5 6 4 8 0 C10 -4 15 -3 17 1");
  });

  it("delta (0, 0) devuelve el MISMO modelo (sin cambio); delta no finito, nodo inexistente o selección vacía se rechazan", () => {
    const model = parse(SQUARE);
    const same = ok(moveAnchors(model, [{ subpath: 0, node: 1 }], { x: 0, y: 0 }));
    expect(same.model).toBe(model);
    expect(moveAnchors(model, [{ subpath: 0, node: 1 }], { x: Number.NaN, y: 0 })).toMatchObject({ ok: false });
    expect(moveAnchors(model, [{ subpath: 0, node: 1 }], { x: Infinity, y: 0 })).toMatchObject({ ok: false });
    expect(moveAnchors(model, [{ subpath: 3, node: 0 }], { x: 1, y: 0 })).toMatchObject({ ok: false });
    expect(moveAnchors(model, [{ subpath: 0, node: 9 }], { x: 1, y: 0 })).toMatchObject({ ok: false });
    expect(moveAnchors(model, [], { x: 1, y: 0 })).toMatchObject({ ok: false });
  });

  it("coordenadas fuera de límite (±1 000 000) se rechazan sin cambiar nada", () => {
    expect(moveAnchors(parse(SQUARE), [{ subpath: 0, node: 1 }], { x: 2_000_000, y: 0 })).toMatchObject({ ok: false, error: expect.stringContaining("límite") });
  });

  it("un cambio que colapsa el bbox a una línea se rechaza; si el original ya era una línea, no", () => {
    const model = parse(SQUARE);
    const collapse = moveAnchors(
      model,
      [
        { subpath: 0, node: 2 },
        { subpath: 0, node: 3 },
      ],
      { x: 0, y: -10 },
    );
    expect(collapse).toMatchObject({ ok: false, error: expect.stringContaining("colapsar") });
    const line = parse("M0 0 L10 0");
    expect(ok(moveAnchors(line, [{ subpath: 0, node: 1 }], { x: 5, y: 0 })).model.subpaths[0].nodes[1].anchor).toEqual({ x: 15, y: 0 });
    expect(validateModel(parse("M0 0 L10 0"), null)).toContain("colapsar");
  });

  it("setAnchor / setAnchors llevan el anchor a un punto absoluto y sus handles conservan la posición relativa", () => {
    const model = parse(CURVE_SYMMETRIC);
    const moved = ok(setAnchor(model, { subpath: 0, node: 1 }, { x: 9, y: 1 })).model;
    expect(moved.subpaths[0].nodes[1].anchor).toEqual({ x: 9, y: 1 });
    expect(moved.subpaths[0].nodes[1].handleIn).toEqual({ x: 7, y: 5 });
    expect(moved.subpaths[0].nodes[1].handleOut).toEqual({ x: 11, y: -3 });
    // Mismo punto: sin cambio.
    expect(ok(setAnchor(model, { subpath: 0, node: 1 }, { x: 8, y: 0 })).model).toBe(model);
    const aligned = ok(
      setAnchors(model, [
        { ref: { subpath: 0, node: 0 }, point: { x: 0, y: 2 } },
        { ref: { subpath: 0, node: 2 }, point: { x: 16, y: 2 } },
      ]),
    ).model;
    expect(aligned.subpaths[0].nodes[0].anchor.y).toBe(2);
    expect(aligned.subpaths[0].nodes[2].anchor.y).toBe(2);
    expect(setAnchor(model, { subpath: 0, node: 1 }, { x: Number.NaN, y: 0 })).toMatchObject({ ok: false });
  });
});

describe("moveHandle — regla por tipo de nodo", () => {
  const smooth = () => literal([node({ x: -10, y: -10 }, null, null, "corner"), node({ x: 0, y: 0 }, { x: -3, y: 0 }, { x: 6, y: 0 }, "smooth"), node({ x: 10, y: 10 }, null, null, "corner")]);
  const symmetric = () => literal([node({ x: 0, y: 0 }, null, null, "corner"), node({ x: 10, y: 10 }, { x: 7, y: 10 }, { x: 13, y: 10 }, "symmetric"), node({ x: 20, y: 20 }, null, null, "corner")]);
  const corner = () => literal([node({ x: 0, y: 0 }, null, null, "corner"), node({ x: 10, y: 10 }, { x: 7, y: 10 }, { x: 13, y: 10 }, "corner"), node({ x: 20, y: 20 }, null, null, "corner")]);
  const middle = { subpath: 0, node: 1 };

  it("corner: el handle opuesto NO se mueve", () => {
    const moved = ok(moveHandle(corner(), middle, "out", { x: 14, y: 13 })).model.subpaths[0].nodes[1];
    expect(moved.handleOut).toEqual({ x: 14, y: 13 });
    expect(moved.handleIn).toEqual({ x: 7, y: 10 });
    expect(moved.kind).toBe("corner");
  });

  it("symmetric: el opuesto es el ESPEJO exacto respecto del anchor", () => {
    const moved = ok(moveHandle(symmetric(), middle, "out", { x: 14, y: 13 })).model.subpaths[0].nodes[1];
    expect(moved.handleOut).toEqual({ x: 14, y: 13 });
    expect(moved.handleIn).toEqual({ x: 6, y: 7 });
    // Desde el otro lado: mover el handleIn espeja el handleOut.
    const fromIn = ok(moveHandle(symmetric(), middle, "in", { x: 5, y: 8 })).model.subpaths[0].nodes[1];
    expect(fromIn.handleOut).toEqual({ x: 15, y: 12 });
  });

  it("smooth: el opuesto se ALINEA y CONSERVA su largo (3, 4, 5)", () => {
    const moved = ok(moveHandle(smooth(), middle, "out", { x: 3, y: 4 })).model.subpaths[0].nodes[1];
    expect(moved.handleOut).toEqual({ x: 3, y: 4 });
    // El handleIn medía 3: queda en la dirección opuesta (0,6 ; 0,8) * 3 = (-1,8 ; -2,4).
    expect(moved.handleIn!.x).toBeCloseTo(-1.8, 12);
    expect(moved.handleIn!.y).toBeCloseTo(-2.4, 12);
    expect(Math.hypot(moved.handleIn!.x, moved.handleIn!.y)).toBeCloseTo(3, 12);
    expect(moved.kind).toBe("smooth");
  });

  it("smooth con el handle puesto sobre el anchor: no hay dirección y el opuesto queda donde estaba", () => {
    const moved = ok(moveHandle(smooth(), middle, "out", { x: 0, y: 0 })).model.subpaths[0].nodes[1];
    expect(moved.handleOut).toEqual({ x: 0, y: 0 });
    expect(moved.handleIn).toEqual({ x: -3, y: 0 });
  });

  it("breakKind (Alt): el nodo pasa a corner y el opuesto no acompaña", () => {
    const moved = ok(moveHandle(symmetric(), middle, "out", { x: 14, y: 13 }, { breakKind: true })).model.subpaths[0].nodes[1];
    expect(moved.kind).toBe("corner");
    expect(moved.handleIn).toEqual({ x: 7, y: 10 });
  });

  it("mismo punto => el MISMO modelo; un extremo abierto no tiene handle del lado sin segmento; punto no finito se rechaza", () => {
    const model = corner();
    expect(ok(moveHandle(model, middle, "out", { x: 13, y: 10 })).model).toBe(model);
    expect(moveHandle(model, { subpath: 0, node: 0 }, "in", { x: 1, y: 1 })).toMatchObject({ ok: false, error: expect.stringContaining("extremo") });
    expect(moveHandle(model, { subpath: 0, node: 2 }, "out", { x: 1, y: 1 })).toMatchObject({ ok: false });
    expect(moveHandle(model, middle, "out", { x: Number.NaN, y: 1 })).toMatchObject({ ok: false });
    expect(moveHandle(model, { subpath: 4, node: 0 }, "out", { x: 1, y: 1 })).toMatchObject({ ok: false });
  });

  it("en un subpath cerrado TODOS los nodos tienen handle de ambos lados (incluido el de cierre)", () => {
    const closed = literal([node({ x: 0, y: 0 }, null, null, "corner"), node({ x: 10, y: 0 }, null, null, "corner"), node({ x: 5, y: 8 }, null, null, "corner")], true);
    const moved = ok(moveHandle(closed, { subpath: 0, node: 0 }, "in", { x: -2, y: 3 })).model;
    expect(moved.subpaths[0].nodes[0].handleIn).toEqual({ x: -2, y: 3 });
    // El segmento de cierre (nodo 2 -> nodo 0) ahora es curvo y se serializa como C antes del Z.
    expect(modelToPath(moved)).toBe("M0 0 L10 0 L5 8 C5 8 -2 3 0 0 Z");
  });

  it("setHandleVector: largo y ángulo (0° = +x, 90° = hacia abajo) en el espacio local", () => {
    const model = corner();
    const pointed = ok(setHandleVector(model, middle, "out", 5, 90)).model.subpaths[0].nodes[1];
    expect(pointed.handleOut!.x).toBeCloseTo(10, 12);
    expect(pointed.handleOut!.y).toBeCloseTo(15, 12);
    const flat = ok(setHandleVector(model, middle, "out", 4, 0)).model.subpaths[0].nodes[1];
    expect(flat.handleOut).toEqual({ x: 14, y: 10 });
    expect(setHandleVector(model, middle, "out", -1, 0)).toMatchObject({ ok: false });
    expect(setHandleVector(model, middle, "out", 1, Number.NaN)).toMatchObject({ ok: false });
  });

  it("setHandleVector con matriz: largo y ángulo se miden en el espacio transformado (escala 2; giro de 90°)", () => {
    const model = corner();
    const scaled = ok(setHandleVector(model, middle, "out", 10, 0, { a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 })).model.subpaths[0].nodes[1];
    // Largo 10 en documento = 5 en local.
    expect(scaled.handleOut!.x).toBeCloseTo(15, 12);
    expect(scaled.handleOut!.y).toBeCloseTo(10, 12);
    // Giro de 90°: (x, y) -> (-y, x). Un vector de documento (4, 0) es el local (0, -4).
    const rotated = ok(setHandleVector(model, middle, "out", 4, 0, { a: 0, b: 1, c: -1, d: 0, e: 0, f: 0 })).model.subpaths[0].nodes[1];
    expect(rotated.handleOut!.x).toBeCloseTo(10, 12);
    expect(rotated.handleOut!.y).toBeCloseTo(6, 12);
    expect(setHandleVector(model, middle, "out", 4, 0, { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 })).toMatchObject({ ok: false });
  });
});

describe("addNodeOnSegment — De Casteljau exacto", () => {
  it("cúbica conocida en t = 0,5: los puntos intermedios calculados a mano", () => {
    // P0 (0,0) P1 (0,8) P2 (8,8) P3 (8,0): Q0 (0,4) Q1 (4,8) Q2 (8,4); R0 (2,6) R1 (6,6); S (4,6).
    const split = splitCubic({ x: 0, y: 0 }, { x: 0, y: 8 }, { x: 8, y: 8 }, { x: 8, y: 0 }, 0.5);
    expect(split.q0).toEqual({ x: 0, y: 4 });
    expect(split.q1).toEqual({ x: 4, y: 8 });
    expect(split.q2).toEqual({ x: 8, y: 4 });
    expect(split.r0).toEqual({ x: 2, y: 6 });
    expect(split.r1).toEqual({ x: 6, y: 6 });
    expect(split.s).toEqual({ x: 4, y: 6 });
  });

  it("el nodo agregado lleva los handles de la subdivisión y los vecinos los suyos; sale simétrico en t = 0,5", () => {
    const added = ok(addNodeOnSegment(parse(ARCH), 0, 0, 0.5));
    const [a, mid, b] = added.model.subpaths[0].nodes;
    expect(a.handleOut).toEqual({ x: 0, y: 4 });
    expect(mid.anchor).toEqual({ x: 4, y: 6 });
    expect(mid.handleIn).toEqual({ x: 2, y: 6 });
    expect(mid.handleOut).toEqual({ x: 6, y: 6 });
    expect(mid.kind).toBe("symmetric");
    expect(b.handleIn).toEqual({ x: 8, y: 4 });
    expect(added.selection).toEqual([{ subpath: 0, node: 1 }]);
    expect(modelToPath(added.model)).toBe("M0 0 C0 4 2 6 4 6 C6 6 8 4 8 0");
  });

  it("en t = 0,25 el punto agregado cae sobre la curva original (8·B(0,25) calculado a mano: x = 1,25 ; y = 3,75)", () => {
    // B(0,25) de ARCH: x = 3(1-t)t²·8 + t³·8 = 3·0,75·0,0625·8 + 0,015625·8 = 1,125 + 0,125 = 1,25 ; y = 3(1-t)²t·8 + 3(1-t)t²·8 = 3·0,5625·0,25·8 + 3·0,75·0,0625·8 = 3,375 + 1,125 = 4,5.
    const added = ok(addNodeOnSegment(parse(ARCH), 0, 0, 0.25));
    const mid = added.model.subpaths[0].nodes[1];
    expect(mid.anchor.x).toBeCloseTo(1.25, 12);
    expect(mid.anchor.y).toBeCloseTo(4.5, 12);
    const original = segmentCurve(parse(ARCH).subpaths[0], 0)!;
    const onCurve = pointOnCurve(original, 0.25);
    expect(mid.anchor.x).toBeCloseTo(onCurve.x, 12);
    expect(mid.anchor.y).toBeCloseTo(onCurve.y, 12);
  });

  it("la FORMA no cambia: las dos mitades reproducen la curva original (reparametrizada) y el aplanado antes/después coincide", () => {
    const d = "M0 0 C10 20 30 -10 40 10";
    const model = parse(d);
    const original = segmentCurve(model.subpaths[0], 0)!;
    for (const t of [0.1, 0.3, 0.5, 0.77, 0.95]) {
      const added = ok(addNodeOnSegment(model, 0, 0, t)).model.subpaths[0];
      const first = segmentCurve(added, 0)!;
      const second = segmentCurve(added, 1)!;
      for (let step = 0; step <= 10; step += 1) {
        const u = step / 10;
        const a = pointOnCurve(first, u);
        const expectedA = pointOnCurve(original, u * t);
        expect(a.x).toBeCloseTo(expectedA.x, 9);
        expect(a.y).toBeCloseTo(expectedA.y, 9);
        const b = pointOnCurve(second, u);
        const expectedB = pointOnCurve(original, t + u * (1 - t));
        expect(b.x).toBeCloseTo(expectedB.x, 9);
        expect(b.y).toBeCloseTo(expectedB.y, 9);
      }
      const after = modelToPath(ok(addNodeOnSegment(model, 0, 0, t)).model);
      expect(maxDeviation(d, after)).toBeLessThan(0.05);
      expect(maxDeviation(after, d)).toBeLessThan(0.05);
    }
  });

  it("segmento recto: agrega el punto interpolado SIN handles; la forma no cambia", () => {
    const added = ok(addNodeOnSegment(parse("M0 0 L10 0 L10 10"), 0, 0, 0.25)).model;
    expect(added.subpaths[0].nodes[1]).toEqual({ anchor: { x: 2.5, y: 0 }, handleIn: null, handleOut: null, kind: "corner" });
    expect(modelToPath(added)).toBe("M0 0 L2.5 0 L10 0 L10 10");
  });

  it("segmento con un solo handle: el control que falta es el extremo (la forma tampoco cambia)", () => {
    const model = literal([node({ x: 0, y: 0 }, null, { x: 0, y: 8 }, "corner"), node({ x: 8, y: 0 }, null, null, "corner")]);
    const added = ok(addNodeOnSegment(model, 0, 0, 0.5)).model;
    const before = segmentCurve(model.subpaths[0], 0)!;
    const mid = added.subpaths[0].nodes[1].anchor;
    const expected = pointOnCurve(before, 0.5);
    expect(mid.x).toBeCloseTo(expected.x, 12);
    expect(mid.y).toBeCloseTo(expected.y, 12);
    expect(maxDeviation(modelToPath(model), modelToPath(added))).toBeLessThan(0.05);
  });

  it("segmento de cierre de un subpath cerrado: el nodo nuevo va al final y el lazo sigue cerrado", () => {
    const added = ok(addNodeOnSegment(parse(SQUARE), 0, 3, 0.5));
    expect(added.model.subpaths[0].nodes).toHaveLength(5);
    expect(added.model.subpaths[0].nodes[4].anchor).toEqual({ x: 0, y: 5 });
    expect(added.selection).toEqual([{ subpath: 0, node: 4 }]);
    expect(modelToPath(added.model)).toBe("M0 0 L10 0 L10 10 L0 10 L0 5 Z");
  });

  it("curva en un subpath compuesto: solo cambia ese subpath, el resto conserva su referencia", () => {
    const model = parse("M0 0 L100 0 L100 100 L0 100 Z M20 20 L20 80 L80 80 L80 20 Z");
    const added = ok(addNodeOnSegment(model, 1, 1, 0.5)).model;
    expect(added.subpaths[0]).toBe(model.subpaths[0]);
    expect(added.subpaths[1].nodes).toHaveLength(5);
    expect(added.subpaths[1].nodes[2].anchor).toEqual({ x: 50, y: 80 });
  });

  it("t fuera de (0, 1) o pegado a un extremo, y segmentos inexistentes, se rechazan sin cambios", () => {
    const model = parse(ARCH);
    for (const t of [0, 1, -0.2, 1.5, Number.NaN, 1e-9, 1 - 1e-9]) expect(addNodeOnSegment(model, 0, 0, t)).toMatchObject({ ok: false });
    expect(addNodeOnSegment(model, 0, 1, 0.5)).toMatchObject({ ok: false });
    expect(addNodeOnSegment(model, 2, 0, 0.5)).toMatchObject({ ok: false });
    expect(addNodeOnSegment(parse("M5 5"), 0, 0, 0.5)).toMatchObject({ ok: false });
  });
});

describe("deleteNodes — eliminación mínima", () => {
  it("los vecinos se unen conservando sus handles (la forma SÍ cambia): B fuera => C(A.out, C.in)", () => {
    const deleted = ok(deleteNodes(parse(CURVE_SYMMETRIC), [{ subpath: 0, node: 1 }]));
    expect(modelToPath(deleted.model)).toBe("M0 0 C2 4 14 -4 16 0");
    expect(deleted.selection).toEqual([]);
    expect(maxDeviation(CURVE_SYMMETRIC, "M0 0 C2 4 14 -4 16 0")).toBeGreaterThan(0.3);
  });

  it("un extremo abierto pierde el handle que miraba al nodo eliminado", () => {
    expect(modelToPath(ok(deleteNodes(parse(CURVE_SYMMETRIC), [{ subpath: 0, node: 0 }])).model)).toBe("M8 0 C10 -4 14 -4 16 0");
    expect(modelToPath(ok(deleteNodes(parse(CURVE_SYMMETRIC), [{ subpath: 0, node: 2 }])).model)).toBe("M0 0 C2 4 6 4 8 0");
  });

  it("cerrado con 4 nodos: quitar uno deja un triángulo cerrado válido", () => {
    expect(modelToPath(ok(deleteNodes(parse(SQUARE), [{ subpath: 0, node: 3 }])).model)).toBe("M0 0 L10 0 L10 10 Z");
  });

  it("varios nodos a la vez, en cualquier orden, con refs repetidas", () => {
    const d = "M0 0 L10 0 L20 0 L30 0 L40 10 L40 20";
    const refs = [
      { subpath: 0, node: 3 },
      { subpath: 0, node: 1 },
      { subpath: 0, node: 1 },
    ];
    expect(modelToPath(ok(deleteNodes(parse(d), refs)).model)).toBe("M0 0 L20 0 L40 10 L40 20");
  });

  it("el subpath quedaría degenerado (cerrado < 3): pide CONFIRMACIÓN y no cambia nada", () => {
    const model = parse("M0 0 L100 0 L100 100 L0 100 Z M20 20 L20 80 L80 20 Z");
    const result = deleteNodes(model, [{ subpath: 1, node: 0 }]);
    expect(result).toMatchObject({ ok: false, confirm: { subpaths: [1] } });
    expect(modelToPath(model)).toBe("M0 0 L100 0 L100 100 L0 100 Z M20 20 L20 80 L80 20 Z");
  });

  it("confirmado: se elimina el subpath COMPLETO y el resto conserva su orden", () => {
    const model = parse("M0 0 L100 0 L100 100 L0 100 Z M20 20 L20 80 L80 20 Z M200 0 L300 0 L300 100 Z");
    const result = ok(deleteNodes(model, [{ subpath: 1, node: 0 }], { removeSubpaths: true }));
    expect(modelToPath(result.model)).toBe("M0 0 L100 0 L100 100 L0 100 Z M200 0 L300 0 L300 100 Z");
  });

  it("nodos de un subpath sano + uno que queda degenerado: confirmado, se quitan los nodos del primero y el segundo entero", () => {
    const model = parse("M0 0 L100 0 L100 100 L0 100 Z M20 20 L20 80 L80 20 Z");
    const refs = [
      { subpath: 0, node: 0 },
      { subpath: 1, node: 2 },
    ];
    expect(deleteNodes(model, refs)).toMatchObject({ ok: false, confirm: { subpaths: [1] } });
    expect(modelToPath(ok(deleteNodes(model, refs, { removeSubpaths: true })).model)).toBe("M100 0 L100 100 L0 100 Z");
  });

  it("abierto con 2 nodos: quitar uno lo degenera (< 2) y pide confirmación si hay otro subpath", () => {
    const model = parse("M0 0 L10 0 L10 10 Z M50 50 L60 60");
    expect(deleteNodes(model, [{ subpath: 1, node: 1 }])).toMatchObject({ ok: false, confirm: { subpaths: [1] } });
    expect(modelToPath(ok(deleteNodes(model, [{ subpath: 1, node: 1 }], { removeSubpaths: true })).model)).toBe("M0 0 L10 0 L10 10 Z");
  });

  it("ÚNICO subpath del objeto => rechazo con mensaje, incluso confirmado; y no hay `confirm` (no hay nada que confirmar)", () => {
    const model = parse("M0 0 L10 0 L10 10 Z");
    const plain = deleteNodes(model, [{ subpath: 0, node: 0 }]);
    expect(plain).toMatchObject({ ok: false, error: expect.stringContaining("sin geometría") });
    expect((plain as { confirm?: unknown }).confirm).toBeUndefined();
    expect(deleteNodes(model, [{ subpath: 0, node: 0 }], { removeSubpaths: true })).toMatchObject({ ok: false });
    expect(deleteNodes(parse("M0 0 L10 10"), [{ subpath: 0, node: 0 }], { removeSubpaths: true })).toMatchObject({ ok: false });
  });

  it("si TODOS los subpaths quedarían degenerados también se rechaza", () => {
    const model = parse("M0 0 L10 0 L10 10 Z M50 50 L60 50 L60 60 Z");
    const refs = [
      { subpath: 0, node: 0 },
      { subpath: 1, node: 0 },
    ];
    expect(deleteNodes(model, refs, { removeSubpaths: true })).toMatchObject({ ok: false, error: expect.stringContaining("sin geometría") });
  });

  it("conserva el winding de los subpaths que sobreviven", () => {
    const model = parse("M0 0 L100 0 L100 100 L0 100 Z M20 20 L20 80 L80 80 L80 20 Z");
    const result = ok(deleteNodes(model, [{ subpath: 0, node: 3 }])).model;
    expect(Math.sign(signedArea(result.subpaths[0].nodes.map((n) => n.anchor)))).toBe(1);
    expect(Math.sign(signedArea(result.subpaths[1].nodes.map((n) => n.anchor)))).toBe(-1);
  });

  it("nodos inexistentes o selección vacía se rechazan", () => {
    expect(deleteNodes(parse(SQUARE), [{ subpath: 0, node: 9 }])).toMatchObject({ ok: false });
    expect(deleteNodes(parse(SQUARE), [])).toMatchObject({ ok: false });
  });
});

describe("closeSubpath / openSubpathAt", () => {
  it("cerrar un abierto válido: el Z une el último con el primero", () => {
    expect(modelToPath(ok(closeSubpath(parse("M0 0 L10 0 L10 10 L0 10"), 0)).model)).toBe(SQUARE);
  });

  it("si el último ya coincide con el primero se FUSIONAN (no quedan dos nodos apilados)", () => {
    const closed = ok(closeSubpath(parse("M0 0 L10 0 L10 10 L0 0"), 0)).model;
    expect(closed.subpaths[0].nodes).toHaveLength(3);
    expect(modelToPath(closed)).toBe("M0 0 L10 0 L10 10 Z");
  });

  it("la fusión pasa el handleIn del último al primero: el cierre curvo se conserva", () => {
    const closed = ok(closeSubpath(parse("M0 0 L10 0 L10 10 C10 20 0 20 0 0"), 0)).model;
    expect(closed.subpaths[0].nodes[0].handleIn).toEqual({ x: 0, y: 20 });
    expect(modelToPath(closed)).toBe("M0 0 L10 0 L10 10 C10 20 0 20 0 0 Z");
  });

  it("no se puede cerrar: ya cerrado, con menos de 3 nodos o subpath inexistente", () => {
    expect(closeSubpath(parse(SQUARE), 0)).toMatchObject({ ok: false, error: expect.stringContaining("ya está cerrado") });
    expect(closeSubpath(parse("M0 0 L10 0"), 0)).toMatchObject({ ok: false, error: expect.stringContaining("menos de 3") });
    expect(closeSubpath(parse("M0 0 L10 0 L0 0"), 0)).toMatchObject({ ok: false });
    expect(closeSubpath(parse(SQUARE), 5)).toMatchObject({ ok: false });
    expect(closeSubpathBlocker(parse("M0 0 L10 0 L10 10"), 0)).toBeNull();
    expect(closeSubpathBlocker(parse(SQUARE), 0)).not.toBeNull();
  });

  it("abrir en el nodo 2 de un cuadrado: empieza y termina en ese anchor (5 nodos) y el sentido de giro no cambia", () => {
    const model = parse(SQUARE);
    const opened = ok(openSubpathAt(model, { subpath: 0, node: 2 }));
    expect(modelToPath(opened.model)).toBe("M10 10 L0 10 L0 0 L10 0 L10 10");
    expect(opened.model.subpaths[0].closed).toBe(false);
    expect(opened.selection).toEqual([
      { subpath: 0, node: 0 },
      { subpath: 0, node: 4 },
    ]);
    const polygon = (m: PathModel) => signedArea(m.subpaths[0].nodes.slice(0, 4).map((n) => n.anchor));
    expect(Math.sign(polygon(opened.model))).toBe(Math.sign(polygon(model)));
  });

  it("abrir y volver a cerrar fusiona los extremos: la forma y el winding son los de antes", () => {
    const model = parse(SQUARE);
    const reopened = ok(closeSubpath(ok(openSubpathAt(model, { subpath: 0, node: 2 })).model, 0)).model;
    expect(modelToPath(reopened)).toBe("M10 10 L0 10 L0 0 L10 0 Z");
    expect(signedArea(reopened.subpaths[0].nodes.map((n) => n.anchor))).toBe(signedArea(model.subpaths[0].nodes.map((n) => n.anchor)));
  });

  it("abrir un lazo curvo reparte los handles: el primero lleva el de salida y el último el de llegada", () => {
    const model = parse("M0 0 C3 -3 7 -3 10 0 C10 4 8 8 5 8 C2 8 0 4 0 0 Z M30 30 L40 30 L40 40 Z");
    expect(model.subpaths[0].nodes).toHaveLength(3);
    const opened = ok(openSubpathAt(model, { subpath: 0, node: 1 })).model;
    const nodes = opened.subpaths[0].nodes;
    expect(nodes).toHaveLength(4);
    expect(nodes[0].anchor).toEqual({ x: 10, y: 0 });
    expect(nodes[0].handleIn).toBeNull();
    expect(nodes[0].handleOut).toEqual({ x: 10, y: 4 });
    expect(nodes[3].anchor).toEqual({ x: 10, y: 0 });
    expect(nodes[3].handleIn).toEqual({ x: 7, y: -3 });
    expect(nodes[3].handleOut).toBeNull();
    expect(opened.subpaths[1]).toBe(model.subpaths[1]);
    expect(modelToPath(opened)).toBe("M10 0 C10 4 8 8 5 8 C2 8 0 4 0 0 C3 -3 7 -3 10 0 M30 30 L40 30 L40 40 Z");
  });

  it("no se puede abrir: ya abierto, lazo de menos de 3 nodos o nodo inexistente", () => {
    expect(openSubpathAt(parse("M0 0 L10 0 L10 10"), { subpath: 0, node: 1 })).toMatchObject({ ok: false, error: expect.stringContaining("ya está abierto") });
    expect(openSubpathAt(parse("M0 0 L10 0 L10 10 L0 0 Z M5 5 L6 6 Z"), { subpath: 1, node: 0 })).toMatchObject({ ok: false });
    expect(openSubpathAt(parse(SQUARE), { subpath: 0, node: 7 })).toMatchObject({ ok: false });
  });
});

describe("toggleSegmentKind / toggleSegments", () => {
  it("recto -> curvo: handles a 1/3 del segmento (la forma no cambia: la cúbica con controles a 1/3 es la recta)", () => {
    const model = parse("M0 0 L9 0");
    const curved = ok(toggleSegmentKind(model, 0, 0)).model;
    expect(modelToPath(curved)).toBe("M0 0 C3 0 6 0 9 0");
    expect(isSegmentCurved(curved.subpaths[0], 0)).toBe(true);
    expect(maxDeviation("M0 0 L9 0", "M0 0 C3 0 6 0 9 0")).toBeLessThan(1e-9);
  });

  it("curvo -> recto: quita los dos handles del segmento y deja los externos", () => {
    const straight = ok(toggleSegmentKind(parse(CURVE_SYMMETRIC), 0, 0)).model;
    expect(modelToPath(straight)).toBe("M0 0 L8 0 C10 -4 14 -4 16 0");
    // El nodo B perdió un handle: ya no puede ser simétrico.
    expect(straight.subpaths[0].nodes[1].kind).toBe("corner");
  });

  it("el segmento de cierre también se alterna", () => {
    const curved = ok(toggleSegmentKind(parse(SQUARE), 0, 3)).model;
    expect(modelToPath(curved)).toBe("M0 0 L10 0 L10 10 L0 10 C0 6.666667 0 3.333333 0 0 Z");
    expect(modelToPath(ok(toggleSegmentKind(curved, 0, 3)).model)).toBe(SQUARE);
  });

  it("largo 0 o segmento inexistente se rechazan", () => {
    expect(toggleSegmentKind(parse("M3 3 L3 3"), 0, 0)).toMatchObject({ ok: false, error: expect.stringContaining("largo 0") });
    expect(toggleSegmentKind(parse(SQUARE), 0, 9)).toMatchObject({ ok: false });
    expect(toggleSegmentKind(parse(SQUARE), 8, 0)).toMatchObject({ ok: false });
  });

  it("varios segmentos: si alguno es recto se curvan todos; si todos son curvos se enderezan todos", () => {
    const mixed = parse("M0 0 L9 0 C10 5 12 5 18 0 L27 9");
    const all = ok(
      toggleSegments(mixed, [
        { subpath: 0, segment: 0 },
        { subpath: 0, segment: 1 },
        { subpath: 0, segment: 2 },
      ]),
    ).model;
    expect([0, 1, 2].every((segment) => isSegmentCurved(all.subpaths[0], segment))).toBe(true);
    const back = ok(
      toggleSegments(all, [
        { subpath: 0, segment: 0 },
        { subpath: 0, segment: 1 },
        { subpath: 0, segment: 2 },
      ]),
    ).model;
    expect([0, 1, 2].some((segment) => isSegmentCurved(back.subpaths[0], segment))).toBe(false);
    expect(toggleSegments(mixed, [])).toMatchObject({ ok: false });
  });
});

describe("setNodeKind / toggleNodeKind", () => {
  const middle = { subpath: 0, node: 1 };

  it("symmetric: el handleIn pasa a ser el espejo EXACTO del handleOut", () => {
    const result = ok(setNodeKind(parse(CURVE_CORNER), [middle], "symmetric")).model.subpaths[0].nodes[1];
    expect(result.kind).toBe("symmetric");
    expect(result.handleOut).toEqual({ x: 8, y: -5 });
    expect(result.handleIn).toEqual({ x: 8, y: 5 });
  });

  it("smooth: se alinea y cada handle conserva su largo", () => {
    const result = ok(setNodeKind(parse(CURVE_CORNER), [middle], "smooth")).model.subpaths[0].nodes[1];
    expect(result.kind).toBe("smooth");
    expect(result.handleOut).toEqual({ x: 8, y: -5 });
    // El handleIn medía √20 = 4,4721 y apunta contra la salida (0, -1): (8, 0 + 4,4721).
    expect(result.handleIn!.x).toBeCloseTo(8, 12);
    expect(result.handleIn!.y).toBeCloseTo(Math.sqrt(20), 12);
  });

  it("corner solo cambia la etiqueta: los handles no se mueven", () => {
    const model = parse(CURVE_SYMMETRIC);
    const result = ok(setNodeKind(model, [middle], "corner")).model.subpaths[0].nodes[1];
    expect(result.kind).toBe("corner");
    expect(result.handleIn).toEqual(model.subpaths[0].nodes[1].handleIn);
    expect(result.handleOut).toEqual(model.subpaths[0].nodes[1].handleOut);
  });

  it("sin handles genera la tangente con 1/3 de la distancia a los vecinos", () => {
    const result = ok(setNodeKind(parse("M0 0 L9 0 L9 9 L0 9 Z"), [middle], "smooth")).model.subpaths[0].nodes[1];
    const side = (3 * Math.SQRT2) / 2;
    expect(result.handleOut!.x).toBeCloseTo(9 + side, 12);
    expect(result.handleOut!.y).toBeCloseTo(side, 12);
    expect(result.handleIn!.x).toBeCloseTo(9 - side, 12);
    expect(result.handleIn!.y).toBeCloseTo(-side, 12);
    expect(inferKind(result)).toBe("symmetric");
  });

  it("el extremo de un path abierto solo genera el handle del lado que tiene segmento", () => {
    const result = ok(setNodeKind(parse("M0 0 L9 0 L9 9"), [{ subpath: 0, node: 0 }], "smooth")).model.subpaths[0].nodes[0];
    expect(result.handleOut).toEqual({ x: 3, y: 0 });
    expect(result.handleIn).toBeNull();
  });

  it("mismo tipo sobre un nodo ya alineado => el MISMO modelo", () => {
    const model = parse(CURVE_SYMMETRIC);
    expect(ok(setNodeKind(model, [middle], "symmetric")).model).toBe(model);
  });

  it("toggleNodeKind alterna corner <-> smooth", () => {
    const smooth = ok(toggleNodeKind(parse(CURVE_CORNER), middle)).model;
    expect(smooth.subpaths[0].nodes[1].kind).toBe("smooth");
    const corner = ok(toggleNodeKind(smooth, middle)).model;
    expect(corner.subpaths[0].nodes[1].kind).toBe("corner");
    expect(toggleNodeKind(smooth, { subpath: 0, node: 9 })).toMatchObject({ ok: false });
  });
});

describe("segmentos y curvas", () => {
  it("closestPointOnSegment: un punto sobre la curva da su t; uno fuera da la distancia real", () => {
    const curve = segmentCurve(parse(ARCH).subpaths[0], 0)!;
    const onCurve = closestPointOnSegment(curve, { x: 4, y: 6 });
    expect(onCurve.t).toBeCloseTo(0.5, 6);
    expect(onCurve.distance).toBeCloseTo(0, 9);
    const above = closestPointOnSegment(curve, { x: 4, y: 10 });
    expect(above.t).toBeCloseTo(0.5, 6);
    expect(above.distance).toBeCloseTo(4, 9);
  });

  it("segmento recto: proyecta y limita a los extremos", () => {
    const curve = segmentCurve(parse("M0 0 L10 0").subpaths[0], 0)!;
    expect(closestPointOnSegment(curve, { x: 4, y: 3 })).toMatchObject({ t: 0.4, distance: 3 });
    expect(closestPointOnSegment(curve, { x: -5, y: 0 })).toMatchObject({ t: 0, distance: 5 });
    expect(closestPointOnSegment(curve, { x: 15, y: 0 })).toMatchObject({ t: 1, distance: 5 });
  });

  it("el nodo en cuya vecindad hay un handle de largo 0 sigue siendo una curva `C` (idempotencia estructural)", () => {
    const d = "M0 0 C0 0 8 0 8 0";
    const model = parse(d);
    expect(isSegmentCurved(model.subpaths[0], 0)).toBe(true);
    expect(modelToPath(model)).toBe(d);
  });
});

describe("precisión: sin deriva tras muchas ediciones encadenadas (cada una reserializa y re-parsea)", () => {
  const base = "M0.123457 0.5 C1.25 2.5 3.75 2.5 5.123457 0.5 L10 10";
  const ref = { subpath: 0, node: 1 };
  const move = (d: string, delta: Point) => modelToPath(ok(moveAnchors(parse(d), [ref], delta)).model);

  it("ir y volver 1 000 veces deja el d idéntico", () => {
    let d = base;
    for (let step = 0; step < 1000; step += 1) d = move(d, { x: step % 2 === 0 ? 0.1 : -0.1, y: step % 2 === 0 ? 0.3 : -0.3 });
    expect(d).toBe(modelToPath(parse(base)));
  });

  it("1 000 movimientos de 0,1 suman exactamente 100 (no 100,00000000007)", () => {
    let d = base;
    for (let step = 0; step < 1000; step += 1) d = move(d, { x: 0.1, y: 0 });
    expect(parse(d).subpaths[0].nodes[1].anchor.x).toBe(105.123457);
    expect(parse(d).subpaths[0].nodes[1].handleIn!.x).toBe(103.75);
  });

  it("un movimiento y su inverso devuelven el modelo ORIGINAL (handles incluidos)", () => {
    const model = parse(base);
    const there = ok(moveAnchors(model, [ref], { x: 7.3, y: -2.9 })).model;
    const back = ok(moveAnchors(parse(modelToPath(there)), [ref], { x: -7.3, y: 2.9 })).model;
    expect(parse(modelToPath(back))).toEqual(model);
  });
});

describe("utilidades", () => {
  it("nodeKey / parseNodeKey y modelSignature", () => {
    expect(nodeKey({ subpath: 2, node: 7 })).toBe("2:7");
    expect(parseNodeKey("2:7")).toEqual({ subpath: 2, node: 7 });
    expect(parseNodeKey("2:x")).toBeNull();
    expect(parseNodeKey("")).toBeNull();
    expect(modelSignature(parse("M0 0 L10 0 L10 10 Z M5 5 L6 6"))).toBe("3c,2o");
  });

  it("modelBounds es el bbox exacto de las curvas (no el de los puntos de control)", () => {
    // ARCH: x(t) = 24t² - 16t³ crece hasta 8 en t = 1; y(t) = 24t(1 - t) llega a 6 en t = 0,5 (el control está en 8).
    const bounds = modelBounds(parse(ARCH))!;
    expect(bounds.x).toBeCloseTo(0, 9);
    expect(bounds.y).toBeCloseTo(0, 9);
    expect(bounds.width).toBeCloseTo(8, 9);
    expect(bounds.height).toBeCloseTo(6, 9);
  });

  it("memoria de tipos: recuerda por d, el último resultado vivo manda y descarta lo más viejo pasado el límite", () => {
    const memory = createKindMemory();
    expect(kindsHintFor(memory, "M0 0")).toBeUndefined();
    rememberKinds(memory, "M0 0", [["corner"]]);
    expect(kindsHintFor(memory, "M0 0")).toEqual([["corner"]]);
    memory.live = { d: "M0 0", kinds: [["smooth"]] };
    expect(kindsHintFor(memory, "M0 0")).toEqual([["smooth"]]);
    for (let index = 0; index < 305; index += 1) rememberKinds(memory, `M${index} 0`, [["corner"]]);
    expect(memory.saved.size).toBe(300);
    expect(memory.saved.has("M0 0")).toBe(false);
    expect(memory.saved.has("M304 0")).toBe(true);
  });

  it("un modelo con NaN o una coordenada enorme no valida", () => {
    expect(validateModel(literal([node({ x: Number.NaN, y: 0 }, null, null, "corner"), node({ x: 1, y: 1 }, null, null, "corner")]), null)).toContain("finita");
    expect(validateModel(literal([node({ x: 0, y: 0 }, null, null, "corner"), node({ x: 5_000_000, y: 1 }, null, null, "corner")]), null)).toContain("límite");
    expect(validateModel(parse(SQUARE), null)).toBeNull();
  });
});
