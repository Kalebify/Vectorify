import { describe, expect, it } from "vitest";
import type { GeometryPiece, PolygonGeometry, SplitResponse, SplitResultItem } from "../../types/geometry";
import { IDENTITY_MATRIX } from "../svgTransform";
import {
  applyCutResult,
  CUT_MODE_INFO,
  cutApplyBlock,
  cutErrorMessage,
  cutLabel,
  cutNotice,
  cutOutcome,
  cutReach,
  cutReadyText,
  cutScope,
  cutWarnings,
  dedupeCutPoints,
  DEFAULT_SLOT_WIDTH_MM,
  extendCutLine,
  LINE_HELP,
  MAX_CUTTER_POINTS,
  planLineCut,
  polylineLength,
  validateCutResponse,
  type CutOptions,
  type LineCutPlan,
} from "./cut";
import type { EditableDocument, EditableLayerMeta, EditorObject, Point } from "./types";

// ---- Fixtures ----

function meta(groupId: string, overrides: Partial<EditableLayerMeta> = {}): EditableLayerMeta {
  return { groupId, name: `Capa ${groupId}`, colorHex: "#ff0000", order: 0, visible: true, locked: false, manufacturingOperation: "unassigned", isNew: false, ...overrides };
}

function rect(id: string, layerGroupId: string, x: number, y: number, w: number, h = w, overrides: Partial<EditorObject> = {}): EditorObject {
  return { id, layerGroupId, d: `M${x} ${y} H${x + w} V${y + h} H${x} Z`, fill: "#ff0000", matrix: IDENTITY_MATRIX, ...overrides };
}

function line(id: string, layerGroupId: string, d: string, overrides: Partial<EditorObject> = {}): EditorObject {
  return { id, layerGroupId, d, fill: "none", stroke: "#00aa00", strokeWidth: 0.5, matrix: IDENTITY_MATRIX, ...overrides };
}

function stateOf(objectsByLayer: Record<string, EditorObject[]>, layers: EditableLayerMeta[]): EditableDocument {
  return { objectsByLayer, layers };
}

const ring = (x: number, y: number, w: number, h = w): [number, number][] => [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
const poly = (...rings: [number, number][][]): PolygonGeometry => ({ type: "polygon", coordinates: rings });
const pt = (x: number, y: number): Point => ({ x, y });

function idFactory(prefix = "n") {
  let counter = 0;
  return { next: () => `${prefix}${(counter += 1)}`, get calls() { return counter; } };
}

// Capa A «Rojo» (abajo): r1 (0..40), r2 (0..40 x 100..140) y ln (línea y = 20, x 200..260). Capa B «Azul»: b1 (100..140 x 100..140). Capa C «Gris» BLOQUEADA: c1 (0..40 x 200..240).
// Capa D «Oculta»: h1 (0..40 x 300..340).
const r1 = rect("r1", "A", 0, 0, 40);
const r2 = rect("r2", "A", 0, 100, 40);
const ln = line("ln", "A", "M200 20 L260 20");
const b1 = rect("b1", "B", 100, 100, 40, 40, { fill: "#0000ff" });
const c1 = rect("c1", "C", 0, 200, 40);
const h1 = rect("h1", "D", 0, 300, 40);
const LAYERS = [
  meta("A", { name: "Rojo", colorHex: "#ff0000", order: 0 }),
  meta("B", { name: "Azul", colorHex: "#0000ff", order: 1 }),
  meta("C", { name: "Gris", colorHex: "#888888", order: 2, locked: true }),
  meta("D", { name: "Oculta", colorHex: "#ffee00", order: 3, visible: false }),
];
const DOC = stateOf({ A: [r1, r2, ln], B: [b1], C: [c1], D: [h1] }, LAYERS);
const MM = 0.5; // mm por unidad de documento

/** Corte vertical en x = 20 de y = -10 a y = 50: atraviesa r1 (0..40). */
const THROUGH_R1 = [pt(20, -10), pt(20, 50)];
/** Corte vertical en x = 20 de y = -10 a 340: cruza r1, r2, c1 (bloqueado) y h1 (oculto). */
const THROUGH_ALL = [pt(20, -10), pt(20, 340)];

function options(overrides: Partial<CutOptions> = {}): CutOptions {
  return { line: THROUGH_R1, mode: "split", slotWidthMm: DEFAULT_SLOT_WIDTH_MM, extend: false, mmFactor: MM, ...overrides };
}

function plan(selection: EditorObject[], overrides: Partial<CutOptions> = {}, document: EditableDocument = DOC): LineCutPlan {
  const result = planLineCut(selection, document, options(overrides));
  if (!result.ok) throw new Error(`se esperaba un plan y fue ${result.reason}: ${result.message}`);
  return result.plan;
}

function rejection(selection: EditorObject[], overrides: Partial<CutOptions> = {}, document: EditableDocument = DOC) {
  const result = planLineCut(selection, document, options(overrides));
  if (result.ok) throw new Error("se esperaba un rechazo");
  return result;
}

type ItemInit = { pieces: GeometryPiece[]; changed?: boolean; touched?: boolean; discarded?: number };

/** Respuesta del servidor para el plan: un item por subject (los parámetros se repiten tal cual). Por defecto «cambió» = 2 o más piezas. */
function responseFor(target: LineCutPlan, items: ItemInit[]): SplitResponse {
  const results: SplitResultItem[] = items.map((item, index) => {
    const changed = item.changed ?? item.pieces.length >= 2;
    return { subjectIndex: index, changed, touched: item.touched ?? changed, pieces: item.pieces, pieceCount: item.pieces.length, discarded: item.discarded ?? 0 };
  });
  return {
    mode: target.request.mode,
    slotWidth: target.request.slotWidth,
    extend: target.request.extend,
    tolerance: target.request.tolerance,
    results,
    pieceCount: results.reduce((total, item) => total + item.pieces.length, 0),
  };
}

const HALVES_OF_R1 = [poly(ring(0, 0, 20, 40)), poly(ring(20, 0, 20, 40))];

// ---- La línea de corte ----

describe("la línea de corte", () => {
  it("dedupeCutPoints quita los consecutivos repetidos (un doble click suma dos veces el mismo punto), no los separados", () => {
    expect(dedupeCutPoints([pt(1, 1), pt(1, 1), pt(2, 2), pt(1, 1)])).toEqual([pt(1, 1), pt(2, 2), pt(1, 1)]);
    expect(dedupeCutPoints([])).toEqual([]);
  });

  it("polylineLength suma los tramos", () => {
    expect(polylineLength([pt(0, 0), pt(3, 4), pt(3, 10)])).toBe(11);
    expect(polylineLength([pt(1, 1)])).toBe(0);
  });

  it("extendCutLine prolonga SOLO el primer y el último tramo en su propia dirección; los vértices intermedios no se mueven", () => {
    const extended = extendCutLine([pt(0, 0), pt(10, 0), pt(10, 10)], 5);

    expect(extended).toEqual([pt(-5, 0), pt(10, 0), pt(10, 15)]);
  });

  it("extendCutLine de un solo segmento lo prolonga en AMBOS extremos", () => {
    expect(extendCutLine([pt(0, 0), pt(3, 4)], 10)).toEqual([pt(-6, -8), pt(9, 12)]);
  });

  it("extendCutLine no inventa una dirección: con menos de 2 puntos distintos devuelve la línea tal cual", () => {
    expect(extendCutLine([pt(1, 1), pt(1, 1)], 5)).toEqual([pt(1, 1)]);
  });

  it("cutReach es la diagonal de la línea y los objetos más 1: alcanza para cruzar cualquiera", () => {
    // Línea (0,0)-(3,4); r1 (0..40): caja unión 0..40 x 0..40 -> diagonal 40·√2.
    expect(cutReach([pt(0, 0), pt(3, 4)], [r1])).toBeCloseTo(40 * Math.SQRT2 + 1, 9);
    expect(cutReach([pt(0, 0), pt(3, 4)], [])).toBe(6);
  });
});

// ---- Alcance ----

describe("alcance del corte", () => {
  it("con selección: solo los objetos seleccionados, aunque la línea cruce otros", () => {
    const scope = cutScope([r2], DOC, THROUGH_ALL);

    expect(scope.kind).toBe("selection");
    expect(scope.objects.map((object) => object.id)).toEqual(["r2"]);
  });

  it("sin selección: TODOS los objetos visibles y desbloqueados que la línea cruza, en orden de pintado", () => {
    const scope = cutScope([], DOC, [pt(20, -10), pt(20, 150)]);

    expect(scope.kind).toBe("crossed");
    expect(scope.objects.map((object) => object.id)).toEqual(["r1", "r2"]);
  });

  it("sin selección, un objeto que la línea no toca NO entra (aunque esté en una capa visible)", () => {
    const scope = cutScope([], DOC, [pt(20, -10), pt(20, 150)]);

    expect(scope.objects.map((object) => object.id)).not.toContain("b1");
    expect(scope.objects.map((object) => object.id)).not.toContain("ln");
  });

  it("sin selección, los objetos de capas bloqueadas y ocultas que la línea cruza se OMITEN y quedan contados aparte", () => {
    const scope = cutScope([], DOC, THROUGH_ALL);

    expect(scope.objects.map((object) => object.id)).toEqual(["r1", "r2"]);
    expect(scope.omittedLocked.map((object) => object.id)).toEqual(["c1"]);
    expect(scope.omittedHidden.map((object) => object.id)).toEqual(["h1"]);
  });

  it("con selección, los objetos seleccionados de una capa bloqueada se omiten e informan; el resto se corta", () => {
    const scope = cutScope([r1, c1], DOC, THROUGH_ALL);

    expect(scope.kind).toBe("selection");
    expect(scope.objects.map((object) => object.id)).toEqual(["r1"]);
    expect(scope.omittedLocked.map((object) => object.id)).toEqual(["c1"]);
  });

  it("el alcance ordena por pintado, no por el orden de la selección", () => {
    const scope = cutScope([b1, r2, r1], DOC, THROUGH_ALL);

    expect(scope.objects.map((object) => object.id)).toEqual(["r1", "r2", "b1"]);
  });

  it("detecta una línea abierta (trazo) cruzada y no cuenta una línea que pasa por fuera de su caja", () => {
    const crossed = cutScope([], DOC, [pt(230, 0), pt(230, 40)]);
    const apart = cutScope([], DOC, [pt(230, 30), pt(230, 60)]);

    expect(crossed.objects.map((object) => object.id)).toEqual(["ln"]);
    expect(apart.objects).toEqual([]);
  });

  it("una línea que corre TODA dentro de un relleno, sin tocar su borde, no lo cruza", () => {
    expect(cutScope([], DOC, [pt(10, 10), pt(30, 30)]).objects).toEqual([]);
  });

  it("una línea que termina justo sobre el borde cuenta como contacto (el servidor decide si atraviesa)", () => {
    expect(cutScope([], DOC, [pt(20, 20), pt(20, 40)]).objects.map((object) => object.id)).toEqual(["r1"]);
  });
});

// ---- Plan ----

describe("planLineCut", () => {
  it("arma la petición en unidades de documento: línea, modo dividir, ancho 0, sin extender, tolerancia 0,01 mm = 0,02 u", () => {
    const result = plan([r1]);

    expect(result.scope).toBe("selection");
    expect(result.objects).toEqual([r1]);
    expect(result.request).toEqual({
      subjects: [{ type: "polygon", coordinates: [[[0, 0], [40, 0], [40, 40], [0, 40]]] }],
      cutter: { points: [[20, -10], [20, 50]] },
      mode: "split",
      slotWidth: 0,
      extend: false,
      tolerance: 0.02,
    });
  });

  it("modo ranura: el ancho en mm se convierte a unidades (0,2 mm = 0,4 u) y viaja; en modo dividir el ancho del panel NO viaja", () => {
    const slot = plan([r1], { mode: "slot", slotWidthMm: 0.2 });
    const split = plan([r1], { mode: "split", slotWidthMm: 0.2 });

    expect(slot.request.slotWidth).toBeCloseTo(0.4, 12);
    expect(slot.request.mode).toBe("slot");
    expect(split.request.slotWidth).toBe(0);
  });

  it("extender viaja en la petición y la línea efectiva se prolonga; sin extender la línea efectiva es la dibujada", () => {
    const plain = plan([r1], { line: [pt(20, 5), pt(20, 20)] });
    const extended = plan([r1], { line: [pt(20, 5), pt(20, 20)], extend: true });

    expect(plain.request.extend).toBe(false);
    expect(plain.effectiveLine).toEqual([pt(20, 5), pt(20, 20)]);
    expect(extended.request.extend).toBe(true);
    expect(extended.request.cutter.points).toEqual([[20, 5], [20, 20]]); // el servidor prolonga; el cliente manda la línea tal cual se dibujó
    expect(extended.effectiveLine[0].y).toBeLessThan(5);
    expect(extended.effectiveLine[1].y).toBeGreaterThan(20);
    expect(extended.effectiveLine[0].x).toBe(20);
  });

  it("sin selección, el plan cubre los objetos cruzados y lo dice (scope crossed) con lo omitido por capa", () => {
    const result = plan([], { line: THROUGH_ALL });

    expect(result.scope).toBe("crossed");
    expect(result.objects.map((object) => object.id)).toEqual(["r1", "r2"]);
    expect(result.omittedLocked).toBe(1);
    expect(result.omittedHidden).toBe(1);
    expect(result.request.subjects).toHaveLength(2);
  });

  it("«Extender» amplía el alcance sin selección: una línea corta dentro de la forma, prolongada, sí cruza su borde", () => {
    const inside = [pt(20, 10), pt(20, 30)];

    expect(rejection([], { line: inside }).reason).toBe("no_targets");
    // Prolongada hacia ambos lados la línea recorre toda la columna x = 20: cruza r1 y r2 y alcanza al bloqueado y al oculto (que se omiten).
    const extended = plan([], { line: inside, extend: true });
    expect(extended.objects.map((object) => object.id)).toEqual(["r1", "r2"]);
    expect([extended.omittedLocked, extended.omittedHidden]).toEqual([1, 1]);
  });

  it("un objeto sin relleno aporta un subject `line`; con varios subpaths, uno por subpath, todos del mismo dueño", () => {
    const multi = line("multi", "A", "M0 500 L40 500 M0 520 L40 520");
    const result = plan([ln, multi], {}, stateOf({ A: [ln, multi] }, LAYERS));

    expect(result.request.subjects.map((subject) => subject.type)).toEqual(["line", "line", "line"]);
    expect(result.owners).toEqual([0, 1, 1]);
    expect(result.request.subjects[1]).toEqual({ type: "line", coordinates: [[0, 500], [40, 500]] });
  });

  it("hornea la matriz del objeto en las coordenadas que se mandan (unidades de documento)", () => {
    const moved = rect("m1", "A", 0, 0, 10, 10, { matrix: { a: 2, b: 0, c: 0, d: 2, e: 100, f: 100 } });

    const result = plan([moved], { line: [pt(120, 90), pt(120, 130)] }, stateOf({ A: [moved] }, LAYERS));

    expect(result.request.subjects[0]).toEqual({ type: "polygon", coordinates: [[[100, 100], [120, 100], [120, 120], [100, 120]]] });
  });

  it("los nombres legibles de los objetos salen del plan (capa · posición en la capa)", () => {
    const result = plan([r2]);

    expect(result.names).toEqual({ r2: "Rojo · objeto 2" });
  });

  it("sin escala física opera en unidades, con el aviso: el ancho de la ranura va tal cual", () => {
    const result = plan([r1], { mode: "slot", slotWidthMm: 3, mmFactor: null });

    expect(result.unit.label).toBe("u");
    expect(result.scaleNotice).toMatch(/Sin escala física/);
    expect(result.request.slotWidth).toBe(3);
    expect(result.request.tolerance).toBe(0.01);
  });

  it("con escala física no hay aviso de escala", () => {
    expect(plan([r1]).scaleNotice).toBeNull();
  });

  it("sin línea (0 o 1 puntos, o todos iguales) rechaza con la ayuda de cómo dibujarla", () => {
    for (const points of [[], [pt(1, 1)], [pt(1, 1), pt(1, 1), pt(1, 1)]]) {
      const result = rejection([r1], { line: points });
      expect(result.reason).toBe("line_missing");
      expect(result.message).toBe(LINE_HELP);
    }
  });

  it("una coordenada no finita en la línea la rechaza sin llegar al servidor", () => {
    expect(rejection([r1], { line: [pt(0, 0), pt(Number.NaN, 5)] }).reason).toBe("line_invalid");
    expect(rejection([r1], { line: [pt(0, 0), pt(Number.POSITIVE_INFINITY, 5)] }).reason).toBe("line_invalid");
  });

  it("más puntos que el tope (10 000) se rechaza; exactamente el tope pasa", () => {
    const many = (count: number) => Array.from({ length: count }, (_, index) => pt(index, index % 2 === 0 ? 0 : 10));

    expect(rejection([r1], { line: many(MAX_CUTTER_POINTS + 1) }).reason).toBe("too_many_points");
    expect(planLineCut([r1], DOC, options({ line: many(MAX_CUTTER_POINTS) })).ok).toBe(true);
  });

  it("ranura fuera de rango o no finita (modo ranura) se rechaza; en modo dividir el ancho se ignora", () => {
    for (const width of [0, 0.005, 100.5, Number.NaN, -1]) {
      expect(rejection([r1], { mode: "slot", slotWidthMm: width }).reason).toBe("invalid_slot_width");
    }
    expect(planLineCut([r1], DOC, options({ mode: "slot", slotWidthMm: 0.01 })).ok).toBe(true);
    expect(planLineCut([r1], DOC, options({ mode: "slot", slotWidthMm: 100 })).ok).toBe(true);
    expect(planLineCut([r1], DOC, options({ mode: "split", slotWidthMm: 0 })).ok).toBe(true);
  });

  it("una ranura que con la escala del documento supera el tope del servidor se rechaza", () => {
    const result = rejection([r1], { mode: "slot", slotWidthMm: 100, mmFactor: 0.00001 });

    expect(result.reason).toBe("invalid_slot_width");
    expect(result.message).toMatch(/servidor/);
  });

  it("una línea que no cruza nada (sin selección) rechaza con el motivo; una selección toda bloqueada, también", () => {
    const nothing = rejection([], { line: [pt(400, 400), pt(410, 410)] });
    const locked = rejection([c1]);

    expect(nothing.reason).toBe("no_targets");
    expect(nothing.message).toMatch(/no cruza ningún objeto visible y desbloqueado/);
    expect(locked.reason).toBe("no_targets");
    expect(locked.message).toMatch(/capas bloqueadas u ocultas/);
  });

  it("si la línea solo cruza objetos de capas bloqueadas u ocultas, el rechazo dice cuántos se omiten", () => {
    const result = rejection([], { line: [pt(20, 190), pt(20, 350)] });

    expect(result.reason).toBe("no_targets");
    expect(result.message).toMatch(/\(2\)/);
  });

  it("un objeto con geometría ilegible se omite e informa; si todos lo son, se rechaza", () => {
    const broken = rect("broken", "A", 0, 0, 10, 10, { d: "esto no es un path" });
    const mixed = plan([r1, broken], {}, stateOf({ A: [r1, broken] }, LAYERS));

    expect(mixed.objects).toEqual([r1]);
    expect(mixed.skippedInvalid).toBe(1);
    expect(rejection([broken], {}, stateOf({ A: [broken] }, LAYERS)).reason).toBe("invalid_geometry");
  });

  it("demasiados objetos (más de 500 contornos) se rechaza con el motivo", () => {
    const many = Array.from({ length: 501 }, (_, index) => rect(`m${index}`, "A", index * 3, 0, 2));

    const result = rejection(many, { line: [pt(-5, 1), pt(5000, 1)] }, stateOf({ A: many }, LAYERS));

    expect(result.reason).toBe("too_many");
    expect(result.message).toMatch(/501 contornos/);
  });

  it("la clave de la petición es estable si nada cambia y cambia con la línea, el modo, el ancho, la extensión y los objetos", () => {
    const base = plan([r1]).requestKey;

    expect(plan([r1]).requestKey).toBe(base);
    expect(plan([r1], { line: [pt(21, -10), pt(21, 50)] }).requestKey).not.toBe(base);
    expect(plan([r1], { mode: "slot" }).requestKey).not.toBe(base);
    expect(plan([r1], { mode: "slot", slotWidthMm: 0.3 }).requestKey).not.toBe(plan([r1], { mode: "slot", slotWidthMm: 0.2 }).requestKey);
    expect(plan([r1], { extend: true }).requestKey).not.toBe(base);
    expect(plan([r1, r2], { line: THROUGH_ALL }).requestKey).not.toBe(plan([r1], { line: THROUGH_ALL }).requestKey);
    // Otra referencia del objeto (por ejemplo tras moverlo) es otra geometría.
    const moved = { ...r1 };
    expect(plan([moved], {}, stateOf({ A: [moved, r2, ln], B: [b1], C: [c1], D: [h1] }, LAYERS)).requestKey).not.toBe(base);
  });

  it("cambiar solo el ancho de la ranura en modo dividir NO cambia la clave (no hay que volver a pedir)", () => {
    expect(plan([r1], { mode: "split", slotWidthMm: 0.2 }).requestKey).toBe(plan([r1], { mode: "split", slotWidthMm: 0.9 }).requestKey);
  });

  it("los modos tienen etiqueta y descripción", () => {
    expect(CUT_MODE_INFO.split.label).toBe("Dividir");
    expect(CUT_MODE_INFO.slot.label).toBe("Separar con hueco");
  });
});

// ---- Validación de la respuesta ----

describe("validateCutResponse", () => {
  const target = plan([r1]);
  const good = () => responseFor(target, [{ pieces: HALVES_OF_R1 }]);

  it("acepta una respuesta coherente", () => {
    expect(validateCutResponse(target.request, good())).toBeNull();
  });

  it("rechaza parámetros que no son los pedidos (modo, ancho, extensión)", () => {
    expect(validateCutResponse(target.request, { ...good(), mode: "slot" })).toMatch(/otro modo/);
    expect(validateCutResponse(target.request, { ...good(), slotWidth: 1 })).toMatch(/otro modo/);
    expect(validateCutResponse(target.request, { ...good(), extend: true })).toMatch(/otro modo/);
  });

  it("rechaza una cantidad de resultados distinta de la de subjects, o un índice fuera de lugar", () => {
    const response = good();

    expect(validateCutResponse(target.request, { ...response, results: [] })).toMatch(/0 resultados/);
    expect(validateCutResponse(target.request, { ...response, results: [{ ...response.results[0], subjectIndex: 3 }] })).toMatch(/no corresponde a su subject/);
  });

  it("rechaza una pieza del tipo equivocado, un anillo abierto o con coordenadas no finitas", () => {
    const withPieces = (pieces: GeometryPiece[]) => responseFor(target, [{ pieces, changed: true, touched: true }]);

    expect(validateCutResponse(target.request, withPieces([{ type: "line", coordinates: [[0, 0], [1, 1]] }, { type: "line", coordinates: [[0, 0], [2, 2]] }]))).toMatch(/solo admite/);
    expect(validateCutResponse(target.request, withPieces([poly([[0, 0], [10, 0], [10, 10], [0, 10]]), poly(ring(20, 0, 20))]))).toMatch(/no está cerrado/);
    expect(validateCutResponse(target.request, withPieces([poly([[0, 0], [Number.NaN, 0], [10, 10], [0, 0]]), poly(ring(20, 0, 20))]))).toMatch(/no finitas/);
  });

  it("rechaza un piece_count que no coincide con las piezas, por objeto y en total", () => {
    const response = good();

    expect(validateCutResponse(target.request, { ...response, results: [{ ...response.results[0], pieceCount: 5 }] })).toMatch(/cantidad de piezas/);
    expect(validateCutResponse(target.request, { ...response, pieceCount: 7 })).toMatch(/cantidad total de piezas/);
  });

  it("rechaza un objeto «separado» sin haberlo tocado o con menos de 2 piezas", () => {
    const response = good();

    expect(validateCutResponse(target.request, { ...response, results: [{ ...response.results[0], touched: false }] })).toMatch(/sin tocarlo/);
    const single = responseFor(target, [{ pieces: [poly(ring(0, 0, 40))], changed: true, touched: true }]);
    expect(validateCutResponse(target.request, single)).toMatch(/menos de 2 piezas/);
  });

  it("rechaza un conteo de descartadas incoherente (negativo, o distinto de 0 en lo que no cambió)", () => {
    const response = good();
    const unchanged = responseFor(target, [{ pieces: [poly(ring(0, 0, 40))], changed: false, touched: true, discarded: 2 }]);

    expect(validateCutResponse(target.request, { ...response, results: [{ ...response.results[0], discarded: -1 }] })).toMatch(/descartadas/);
    expect(validateCutResponse(target.request, unchanged)).toMatch(/descartadas/);
  });

  it("rechaza una respuesta que ni siquiera trae resultados", () => {
    expect(validateCutResponse(target.request, null as unknown as SplitResponse)).toMatch(/no trae resultados/);
    expect(validateCutResponse(target.request, { ...good(), results: undefined } as unknown as SplitResponse)).toMatch(/no trae resultados/);
  });
});

// ---- Resultado ----

describe("cutOutcome", () => {
  it("un objeto separado: sus piezas (d de las polilíneas del servidor) en el orden del servidor", () => {
    const target = plan([r1, r2], { line: THROUGH_ALL });
    const result = cutOutcome(target, responseFor(target, [{ pieces: HALVES_OF_R1 }, { pieces: [poly(ring(0, 100, 20, 40)), poly(ring(20, 100, 20, 40))] }]));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome.cutCount).toBe(2);
    expect(result.outcome.pieceCount).toBe(4);
    expect(result.outcome.nothingToApply).toBe(false);
    expect(result.outcome.objects[0].status).toBe("cut");
    expect(result.outcome.objects[0].shapes.map((shape) => shape.d)).toEqual(["M0 0 L20 0 L20 40 L0 40 Z", "M20 0 L40 0 L40 40 L20 40 Z"]);
    expect(result.outcome.objects[0].shapes.every((shape) => shape.line === false)).toBe(true);
  });

  it("un objeto que el corte toca pero no separa es `intact` (changed:false conserva su d: no hay piezas)", () => {
    const target = plan([r1]);
    const result = cutOutcome(target, responseFor(target, [{ pieces: [poly(ring(0, 0, 40))], changed: false, touched: true }]));

    expect(result.ok && result.outcome.objects[0]).toMatchObject({ status: "intact", shapes: [] });
    expect(result.ok && result.outcome.intactCount).toBe(1);
    expect(result.ok && result.outcome.nothingToApply).toBe(true);
  });

  it("un objeto que ni toca es `untouched`", () => {
    const target = plan([r1]);
    const result = cutOutcome(target, responseFor(target, [{ pieces: [poly(ring(0, 0, 40))], changed: false, touched: false }]));

    expect(result.ok && result.outcome.objects[0].status).toBe("untouched");
    expect(result.ok && result.outcome.untouchedCount).toBe(1);
  });

  it("mezcla: lo que se corta, lo intacto y lo no tocado se cuentan por separado", () => {
    const target = plan([r1, r2, b1], { line: THROUGH_ALL });
    const result = cutOutcome(
      target,
      responseFor(target, [
        { pieces: HALVES_OF_R1 },
        { pieces: [poly(ring(0, 100, 40))], changed: false, touched: true },
        { pieces: [poly(ring(100, 100, 40))], changed: false, touched: false },
      ]),
    );

    expect(result.ok && [result.outcome.cutCount, result.outcome.intactCount, result.outcome.untouchedCount, result.outcome.pieceCount]).toEqual([1, 1, 1, 2]);
  });

  it("descarta las piezas con área < tolerancia² y las informa; con >= 2 piezas útiles el objeto se corta igual", () => {
    // tolerancia 0,02 u -> área mínima 0,0004.
    const target = plan([r1]);
    const sliver = poly(ring(20, 0, 0.01, 0.01)); // 0,0001
    const result = cutOutcome(target, responseFor(target, [{ pieces: [poly(ring(0, 0, 20, 40)), sliver, poly(ring(20, 0, 20, 40))], discarded: 1 }]));

    expect(result.ok && result.outcome.objects[0].status).toBe("cut");
    expect(result.ok && result.outcome.objects[0].shapes).toHaveLength(2);
    expect(result.ok && result.outcome.discarded).toBe(2); // 1 que descartó el servidor + 1 que descarta el cliente
  });

  it("si tras descartar astillas quedan menos de 2 piezas útiles, el objeto NO se corta (queda intacto)", () => {
    const target = plan([r1]);
    const sliver = poly(ring(20, 0, 0.01, 0.01));
    const result = cutOutcome(target, responseFor(target, [{ pieces: [poly(ring(0, 0, 40)), sliver] }]));

    expect(result.ok && result.outcome.objects[0].status).toBe("intact");
    expect(result.ok && result.outcome.nothingToApply).toBe(true);
  });

  it("un objeto sin relleno: las piezas son polilíneas abiertas (`line: true`) y un subpath no cortado aporta la suya", () => {
    const multi = line("multi", "A", "M0 500 L40 500 M0 520 L40 520");
    const target = plan([multi], { line: [pt(20, 490), pt(20, 510)] }, stateOf({ A: [multi] }, LAYERS));
    const result = cutOutcome(
      target,
      responseFor(target, [
        { pieces: [{ type: "line", coordinates: [[0, 500], [20, 500]] }, { type: "line", coordinates: [[20, 500], [40, 500]] }] },
        { pieces: [{ type: "line", coordinates: [[0, 520], [40, 520]] }], changed: false, touched: false },
      ]),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome.objects).toHaveLength(1);
    expect(result.outcome.objects[0].status).toBe("cut");
    expect(result.outcome.objects[0].shapes.map((shape) => shape.d)).toEqual(["M0 500 L20 500", "M20 500 L40 500", "M0 520 L40 520"]);
    expect(result.outcome.objects[0].shapes.every((shape) => shape.line)).toBe(true);
  });

  it("una polilínea de largo <= tolerancia se descarta", () => {
    const target = plan([ln], { line: [pt(230, 0), pt(230, 40)] });
    const result = cutOutcome(
      target,
      responseFor(target, [{ pieces: [{ type: "line", coordinates: [[200, 20], [230, 20]] }, { type: "line", coordinates: [[230, 20], [230.01, 20]] }, { type: "line", coordinates: [[230, 20], [260, 20]] }] }]),
    );

    expect(result.ok && result.outcome.objects[0].shapes).toHaveLength(2);
    expect(result.ok && result.outcome.discarded).toBe(1);
  });

  it("una respuesta incoherente es un error que dice que no se modificó nada", () => {
    const target = plan([r1]);
    const result = cutOutcome(target, { ...responseFor(target, [{ pieces: HALVES_OF_R1 }]), pieceCount: 9 });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/respuesta incoherente.*No se modificó nada/);
  });
});

// ---- Textos ----

describe("textos del panel", () => {
  const target = plan([r1, r2, b1], { line: THROUGH_ALL });
  const outcomeOf = (items: ItemInit[], source: LineCutPlan = target) => {
    const result = cutOutcome(source, responseFor(source, items));
    if (!result.ok) throw new Error(result.error);
    return result.outcome;
  };
  const CUT_R2 = { pieces: [poly(ring(0, 100, 20, 40)), poly(ring(20, 100, 20, 40))] };
  const INTACT = (square: PolygonGeometry): ItemInit => ({ pieces: [square], changed: false, touched: true });

  it("cutReadyText: «Se cortarán N objetos: …» con los nombres y las piezas resultantes", () => {
    const outcome = outcomeOf([{ pieces: HALVES_OF_R1 }, CUT_R2, INTACT(poly(ring(100, 100, 40)))]);

    expect(cutReadyText(target, outcome)).toBe("Se cortarán 2 objetos: Rojo · objeto 1, Rojo · objeto 2. Resultado: 4 piezas.");
  });

  it("cutReadyText en singular y con la lista truncada pasados 6 objetos", () => {
    const single = outcomeOf([{ pieces: HALVES_OF_R1 }, INTACT(poly(ring(0, 100, 40))), INTACT(poly(ring(100, 100, 40)))]);
    expect(cutReadyText(target, single)).toBe("Se cortarán 1 objeto: Rojo · objeto 1. Resultado: 2 piezas.");

    const many = Array.from({ length: 8 }, (_, index) => rect(`s${index}`, "A", index * 50, 0, 40));
    const manyPlan = plan(many, { line: [pt(-5, 20), pt(500, 20)] }, stateOf({ A: many }, LAYERS));
    const pieces = (index: number) => [poly(ring(index * 50, 0, 20, 40)), poly(ring(index * 50 + 20, 0, 20, 40))];
    const outcome = outcomeOf(many.map((_, index) => ({ pieces: pieces(index) })), manyPlan);
    expect(cutReadyText(manyPlan, outcome)).toMatch(/Se cortarán 8 objetos: .* y 2 más\. Resultado: 16 piezas\./);
  });

  it("cutReadyText cuando nada cambia lo dice", () => {
    const outcome = outcomeOf([INTACT(poly(ring(0, 0, 40))), INTACT(poly(ring(0, 100, 40))), INTACT(poly(ring(100, 100, 40)))]);

    expect(cutReadyText(target, outcome)).toBe("Ningún objeto cambia con este corte.");
  });

  it("cutWarnings: el corte que no atraviesa nombra al objeto y sugiere «Extender» (solo si no está activado)", () => {
    const outcome = outcomeOf([{ pieces: HALVES_OF_R1 }, INTACT(poly(ring(0, 100, 40))), INTACT(poly(ring(100, 100, 40)))]);

    const withoutExtend = cutWarnings(target, outcome).find((warning) => warning.kind === "intact")!;
    expect(withoutExtend.text).toBe("El corte no atraviesa completamente «Rojo · objeto 2», «Azul · objeto 1»: quedan intactos. Prolongá la línea o activá «Extender el corte hasta cruzar todo».");

    const extending = plan([r1, r2, b1], { line: THROUGH_ALL, extend: true });
    const extended = cutOutcome(extending, responseFor(extending, [{ pieces: HALVES_OF_R1 }, INTACT(poly(ring(0, 100, 40))), INTACT(poly(ring(100, 100, 40)))]));
    expect(extended.ok && cutWarnings(extending, extended.outcome).find((warning) => warning.kind === "intact")!.text).not.toMatch(/Extender/);
  });

  it("cutWarnings: lo no tocado de la selección, lo omitido por capa, lo no procesable y lo descartado se informan", () => {
    const broken = rect("broken", "A", 0, 0, 10, 10, { d: "nada" });
    const mixed = plan([r1, c1, broken], { line: THROUGH_ALL }, stateOf({ A: [r1, broken], C: [c1] }, LAYERS));
    const outcome = outcomeOf([{ pieces: HALVES_OF_R1, discarded: 2 }], mixed);

    const kinds = cutWarnings(mixed, outcome).map((warning) => warning.kind);
    expect(kinds).toEqual(["locked", "invalid", "discarded"]);
    expect(cutWarnings(mixed, outcome).map((warning) => warning.text)).toEqual([
      "1 objeto en una capa bloqueada se omite: no se modifica.",
      "1 objeto no se pudo procesar y se omite.",
      "2 piezas despreciables descartadas.",
    ]);
  });

  it("cutWarnings: sin selección, lo omitido por capas bloqueadas Y ocultas se informa por separado", () => {
    const crossed = plan([], { line: THROUGH_ALL });
    const outcome = outcomeOf([{ pieces: HALVES_OF_R1 }, CUT_R2], crossed);

    expect(cutWarnings(crossed, outcome).map((warning) => [warning.kind, warning.text])).toEqual([
      ["locked", "1 objeto en una capa bloqueada se omite: no se modifica."],
      ["hidden", "1 objeto en una capa oculta se omite: no se modifica."],
    ]);
  });

  it("cutWarnings: un objeto seleccionado que la línea no toca se informa en el alcance de selección", () => {
    const selected = plan([r1, b1], { line: THROUGH_R1 });
    const outcome = outcomeOf([{ pieces: HALVES_OF_R1 }, { pieces: [poly(ring(100, 100, 40))], changed: false, touched: false }], selected);

    expect(cutWarnings(selected, outcome).find((warning) => warning.kind === "untouched")!.text).toBe("«Azul · objeto 1» no toca la línea de corte: queda intacto.");
  });

  it("cutApplyBlock: sin resultado espera al servidor; si algo se corta Apply está habilitado", () => {
    expect(cutApplyBlock(target, null)).toBe("Esperando el resultado del servidor…");
    expect(cutApplyBlock(target, outcomeOf([{ pieces: HALVES_OF_R1 }, INTACT(poly(ring(0, 100, 40))), INTACT(poly(ring(100, 100, 40)))]))).toBeNull();
  });

  it("cutApplyBlock: si nada cambia explica por qué (no atraviesa) y qué hacer", () => {
    const outcome = outcomeOf([INTACT(poly(ring(0, 0, 40))), INTACT(poly(ring(0, 100, 40))), INTACT(poly(ring(100, 100, 40)))]);

    expect(cutApplyBlock(target, outcome)).toMatch(/^El corte no atraviesa completamente «Rojo · objeto 1», «Rojo · objeto 2», «Azul · objeto 1»: ningún objeto cambia\. Prolongá la línea o activá «Extender/);
    const extending = plan([r1], { extend: true });
    const extended = cutOutcome(extending, responseFor(extending, [INTACT(poly(ring(0, 0, 40)))]));
    expect(extended.ok && cutApplyBlock(extending, extended.outcome)).toMatch(/Prolongá la línea hasta salir de la forma\.$/);
  });

  it("cutApplyBlock: si la línea no toca nada lo dice, según el alcance", () => {
    const apart = (source: LineCutPlan) => {
      const result = cutOutcome(source, responseFor(source, source.objects.map(() => ({ pieces: [poly(ring(0, 0, 40))], changed: false, touched: false }))));
      return result.ok ? cutApplyBlock(source, result.outcome) : null;
    };

    expect(apart(plan([r1]))).toBe("La línea de corte no toca ningún objeto de la selección: no hay nada que cortar.");
    expect(apart(plan([], { line: [pt(20, -10), pt(20, 50)] }))).toBe("La línea de corte no toca ningún objeto: no hay nada que cortar.");
  });
});

// ---- Aplicar ----

describe("applyCutResult", () => {
  const ids = () => idFactory("p");

  it("reemplaza el objeto por sus piezas EN SU LUGAR: ids nuevos, misma capa, mismo fill, sin matriz; lo no cortado conserva su referencia", () => {
    const target = plan([r1]);
    const factory = ids();

    const applied = applyCutResult(target, DOC, responseFor(target, [{ pieces: HALVES_OF_R1 }]), { createId: factory.next });

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(Object.keys(applied.production.layers)).toEqual(["A"]);
    const layer = applied.production.layers.A;
    expect(layer.map((object) => object.id)).toEqual(["p1", "p2", "r2", "ln"]); // r1 sale; las piezas ocupan su lugar
    expect(layer[2]).toBe(r2);
    expect(layer[3]).toBe(ln);
    expect(layer.slice(0, 2).every((object) => object.layerGroupId === "A" && object.fill === "#ff0000" && object.matrix === IDENTITY_MATRIX)).toBe(true);
    expect(layer.slice(0, 2).map((object) => object.d)).toEqual(["M0 0 L20 0 L20 40 L0 40 Z", "M20 0 L40 0 L40 40 L20 40 Z"]);
    expect(applied.production.atomic).toBe(true);
    expect(applied.production.layerMetas).toBeUndefined();
    expect(applied.resultIds).toEqual(["p1", "p2"]);
    expect(applied.activeGroupId).toBe("A");
  });

  it("un objeto separado NO conserva su id (todas las piezas son nuevas); ninguna pieza repite el id del original", () => {
    const target = plan([r1]);

    const applied = applyCutResult(target, DOC, responseFor(target, [{ pieces: HALVES_OF_R1 }]), { createId: ids().next });

    expect(applied.ok && applied.production.layers.A.some((object) => object.id === "r1")).toBe(false);
  });

  it("varios objetos en capas distintas: un solo comando con las dos capas tocadas; las demás no aparecen", () => {
    const target = plan([r1, b1], { line: [pt(20, -10), pt(120, 140)] });

    const applied = applyCutResult(
      target,
      DOC,
      responseFor(target, [{ pieces: HALVES_OF_R1 }, { pieces: [poly(ring(100, 100, 20, 40)), poly(ring(120, 100, 20, 40))] }]),
      { createId: ids().next },
    );

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(Object.keys(applied.production.layers).sort()).toEqual(["A", "B"]);
    expect(applied.production.layers.B.map((object) => object.id)).toEqual(["p3", "p4"]);
    expect(applied.production.layers.B.every((object) => object.fill === "#0000ff" && object.layerGroupId === "B")).toBe(true);
  });

  it("las piezas de un objeto sin relleno conservan su trazo y color, con el ancho escalado por la matriz del original", () => {
    const thick = line("thick", "A", "M0 500 L40 500", { strokeWidth: 0.5, matrix: { a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 } });
    const doc = stateOf({ A: [thick] }, LAYERS);
    const target = plan([thick], { line: [pt(40, 990), pt(40, 1010)] }, doc);

    const applied = applyCutResult(
      target,
      doc,
      responseFor(target, [{ pieces: [{ type: "line", coordinates: [[0, 1000], [40, 1000]] }, { type: "line", coordinates: [[40, 1000], [80, 1000]] }] }]),
      { createId: ids().next },
    );

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    for (const piece of applied.production.layers.A) {
      expect(piece).toMatchObject({ fill: "none", stroke: "#00aa00", strokeWidth: 1, layerGroupId: "A" });
      expect(piece.matrix).toBe(IDENTITY_MATRIX);
    }
    expect(applied.production.layers.A.map((object) => object.d)).toEqual(["M0 1000 L40 1000", "M40 1000 L80 1000"]);
  });

  it("un objeto cuyo corte no lo separa no se toca: ni su d, ni su matriz, ni su id", () => {
    const target = plan([r1, r2], { line: THROUGH_ALL });

    const applied = applyCutResult(
      target,
      DOC,
      responseFor(target, [{ pieces: HALVES_OF_R1 }, { pieces: [poly(ring(0, 100, 40))], changed: false, touched: true }]),
      { createId: ids().next },
    );

    expect(applied.ok && applied.production.layers.A.includes(r2)).toBe(true);
    expect(applied.ok && applied.summary).toMatchObject({ cutCount: 1, pieceCount: 2, intactCount: 1 });
  });

  it("si ningún objeto se corta devuelve `nothing_to_cut` con el motivo y no produce nada", () => {
    const target = plan([r1]);

    const applied = applyCutResult(target, DOC, responseFor(target, [{ pieces: [poly(ring(0, 0, 40))], changed: false, touched: true }]), { createId: ids().next });

    expect(applied.ok).toBe(false);
    expect(!applied.ok && applied.code).toBe("nothing_to_cut");
    expect(!applied.ok && applied.error).toMatch(/no atraviesa completamente.*No se modificó nada/);
  });

  it("una respuesta incoherente devuelve `invalid_response` y no consume ids", () => {
    const target = plan([r1]);
    const factory = ids();

    const applied = applyCutResult(target, DOC, { ...responseFor(target, [{ pieces: HALVES_OF_R1 }]), mode: "slot" }, { createId: factory.next });

    expect(!applied.ok && applied.code).toBe("invalid_response");
    expect(factory.calls).toBe(0);
  });

  it("si el documento cambió mientras se calculaba (otra referencia del objeto) devuelve `stale`", () => {
    const target = plan([r1]);
    const edited = { ...r1 };

    const applied = applyCutResult(target, stateOf({ A: [edited, r2, ln], B: [b1], C: [c1], D: [h1] }, LAYERS), responseFor(target, [{ pieces: HALVES_OF_R1 }]), { createId: ids().next });

    expect(!applied.ok && applied.code).toBe("stale");
    expect(!applied.ok && applied.error).toMatch(/No se modificó nada/);
  });

  it("si el objeto desapareció del documento devuelve `stale`", () => {
    const target = plan([r1]);

    const applied = applyCutResult(target, stateOf({ A: [r2, ln], B: [b1], C: [c1], D: [h1] }, LAYERS), responseFor(target, [{ pieces: HALVES_OF_R1 }]), { createId: ids().next });

    expect(!applied.ok && applied.code).toBe("stale");
  });

  it("si la capa del objeto se bloqueó u ocultó mientras tanto devuelve `blocked`", () => {
    const target = plan([r1]);
    const response = responseFor(target, [{ pieces: HALVES_OF_R1 }]);
    const lockedA = LAYERS.map((layer) => (layer.groupId === "A" ? { ...layer, locked: true } : layer));
    const hiddenA = LAYERS.map((layer) => (layer.groupId === "A" ? { ...layer, visible: false } : layer));

    const locked = applyCutResult(target, { ...DOC, layers: lockedA }, response, { createId: ids().next });
    const hidden = applyCutResult(target, { ...DOC, layers: hiddenA }, response, { createId: ids().next });

    expect(!locked.ok && locked.code).toBe("blocked");
    expect(!locked.ok && locked.error).toMatch(/«Rojo» está bloqueada/);
    expect(!hidden.ok && hidden.code).toBe("blocked");
    expect(!hidden.ok && hidden.error).toMatch(/«Rojo» está oculta/);
  });

  it("es determinista: la misma respuesta produce el mismo documento (mismo orden de piezas y de ids)", () => {
    const target = plan([r1, r2], { line: [pt(20, -10), pt(20, 150)] });
    const response = responseFor(target, [{ pieces: HALVES_OF_R1 }, { pieces: [poly(ring(0, 100, 20, 40)), poly(ring(20, 100, 20, 40))] }]);

    const first = applyCutResult(target, DOC, response, { createId: ids().next });
    const second = applyCutResult(target, DOC, response, { createId: ids().next });

    expect(first).toEqual(second);
    expect(first.ok && first.production.layers.A.map((object) => object.id)).toEqual(["p1", "p2", "p3", "p4", "ln"]);
  });

  it("el id de las piezas viene de `createId` o, por defecto, de crypto.randomUUID (únicos entre sí)", () => {
    const target = plan([r1]);

    const applied = applyCutResult(target, DOC, responseFor(target, [{ pieces: HALVES_OF_R1 }]));

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(new Set(applied.resultIds).size).toBe(2);
    expect(applied.resultIds.every((id) => /^[0-9a-f-]{36}$/.test(id))).toBe(true);
  });

  it("el resumen, la etiqueta y el aviso describen lo hecho y lo que NO se pudo hacer", () => {
    const target = plan([r1, r2, c1], { line: THROUGH_ALL, mode: "slot", slotWidthMm: 0.2 });
    const applied = applyCutResult(
      target,
      DOC,
      responseFor(target, [{ pieces: HALVES_OF_R1, discarded: 1 }, { pieces: [poly(ring(0, 100, 40))], changed: false, touched: true }]),
      { createId: ids().next },
    );

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(cutLabel(applied.summary)).toBe("Cortar: ranura de 0.2 mm (1 objeto → 2 piezas)");
    expect(cutNotice(applied.summary)).toBe(
      "Corte aplicado con una ranura de 0.2 mm: 1 objeto → 2 piezas, en la capa de cada original. 1 objeto no fue atravesado y quedó intacto. 1 objeto en una capa bloqueada se omitió. 1 pieza despreciable descartada.",
    );
  });

  it("la etiqueta del modo dividir y los avisos de oculto / no procesable", () => {
    const summary = { mode: "split" as const, slotWidthMm: 0.2, unit: { factor: 0.5, label: "mm" as const }, cutCount: 2, pieceCount: 5, intactCount: 0, untouchedCount: 0, omittedLocked: 0, omittedHidden: 3, skippedInvalid: 2, discarded: 0 };

    expect(cutLabel(summary)).toBe("Cortar: dividir (2 objetos → 5 piezas)");
    expect(cutNotice(summary)).toBe(
      "Corte aplicado dividiendo: 2 objetos → 5 piezas, en la capa de cada original. 3 objetos en capas ocultas se omitieron. 2 objetos no se pudieron procesar y se omitieron.",
    );
  });
});

// ---- Errores del servidor ----

describe("cutErrorMessage", () => {
  const body = (code: string) => ({ status: 400, body: { code } });

  it("traduce los códigos propios del corte y dice que no se modificó nada", () => {
    for (const code of ["invalid_cutter", "unknown_split_mode", "invalid_slot_width", "too_many_cutter_points", "timeout", "too_many_subjects", "too_many_vertices", "payload_too_large"]) {
      expect(cutErrorMessage(body(code))).toMatch(/No se modificó nada/);
    }
    expect(cutErrorMessage(body("invalid_cutter"))).toMatch(/línea de corte/);
    expect(cutErrorMessage(body("too_many_cutter_points"))).toMatch(/demasiados puntos/);
  });

  it("413 y 504 sin código se interpretan; lo demás cae en el mensaje general de geometría", () => {
    expect(cutErrorMessage({ status: 413 })).toMatch(/demasiado grande/);
    expect(cutErrorMessage({ status: 504 })).toMatch(/tardó demasiado/);
    expect(cutErrorMessage({ isAborted: true })).toMatch(/cancelada/);
    expect(cutErrorMessage({ isNetworkError: true })).toMatch(/No se pudo contactar/);
    expect(cutErrorMessage({ status: 503 })).toMatch(/motor de geometría no está disponible/);
    expect(cutErrorMessage(new Error("x"))).toMatch(/No se modificó nada/);
    expect(cutErrorMessage(null)).toMatch(/No se modificó nada/);
  });
});
