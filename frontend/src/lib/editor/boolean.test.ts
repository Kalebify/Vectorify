import { describe, expect, it } from "vitest";
import type { BooleanResponse, GeometryOperationName, GeometryPiece } from "../../types/geometry";
import { IDENTITY_MATRIX } from "../svgTransform";
import {
  applyBooleanResult,
  booleanAvailability,
  booleanLabel,
  booleanNotice,
  booleanOutcome,
  booleanTargetCandidates,
  describeOperand,
  moveOperand,
  operandLetter,
  paintOrderIds,
  pieceArea,
  planBoolean,
  reverseOperands,
  toleranceFromMm,
  validateBooleanOperands,
  type BooleanOp,
  type BooleanOptions,
  type BooleanPlan,
} from "./boolean";
import type { EditableDocument, EditableLayerMeta, EditorObject } from "./types";

function meta(groupId: string, overrides: Partial<EditableLayerMeta> = {}): EditableLayerMeta {
  return { groupId, name: `Capa ${groupId}`, colorHex: "#ff0000", order: 0, visible: true, locked: false, manufacturingOperation: "unassigned", isNew: false, ...overrides };
}

function rect(id: string, layerGroupId: string, x: number, y: number, w: number, h = w, overrides: Partial<EditorObject> = {}): EditorObject {
  return { id, layerGroupId, d: `M${x} ${y} H${x + w} V${y + h} H${x} Z`, fill: "#ff0000", matrix: IDENTITY_MATRIX, ...overrides };
}

function stateOf(objectsByLayer: Record<string, EditorObject[]>, layers: EditableLayerMeta[]): EditableDocument {
  return { objectsByLayer, layers };
}

const poly = (...rings: number[][][]): GeometryPiece => ({ type: "polygon", coordinates: rings.map((ring) => [...ring, ring[0]] as [number, number][]) });
const square = (x: number, y: number, size: number): number[][] => [[x, y], [x + size, y], [x + size, y + size], [x, y + size]];

function idFactory(prefix = "n") {
  let counter = 0;
  return { next: () => `${prefix}${(counter += 1)}`, get calls() { return counter; } };
}

/** Respuesta del servidor para la petición del plan: `changed` y piezas por resultado. */
function responseFor(plan: BooleanPlan, items: Array<{ changed?: boolean; geometries: GeometryPiece[] }>): BooleanResponse {
  const wire: GeometryOperationName = plan.request.operation;
  const perSubject = wire === "difference";
  return {
    operation: wire,
    scope: perSubject ? "per_subject" : "combined",
    tolerance: plan.request.tolerance,
    pieceCount: items.reduce((total, item) => total + item.geometries.length, 0),
    results: items.map((item, index) => ({ subjectIndex: perSubject ? index : null, changed: item.changed ?? true, geometries: item.geometries })),
  };
}

// Capa A (roja, abajo): x0, r1 (0..20), x1, r2 (10..30), x2. Capa B (azul, arriba): b1 (50..70).
const r1 = rect("r1", "A", 0, 0, 20);
const r2 = rect("r2", "A", 10, 0, 20);
const x0 = rect("x0", "A", 200, 200, 5);
const x1 = rect("x1", "A", 210, 200, 5);
const x2 = rect("x2", "A", 220, 200, 5);
const b1 = rect("b1", "B", 50, 0, 20, 20, { fill: "#0000ff" });
const LAYERS = [meta("A", { name: "Rojo", colorHex: "#ff0000", order: 0 }), meta("B", { name: "Azul", colorHex: "#0000ff", order: 1 }), meta("C", { name: "Verde", colorHex: "#00ff00", order: 2 })];
const DOC = stateOf({ A: [x0, r1, x1, r2, x2], B: [b1], C: [] }, LAYERS);
const TOL = 0.02;

function plan(selection: EditorObject[], options: Partial<BooleanOptions> = {}, document: EditableDocument = DOC): BooleanPlan {
  const result = planBoolean(selection, document, { op: "union", tolerance: TOL, ...options });
  if (!result.ok) throw new Error(`se esperaba un plan y fue ${result.reason}: ${result.message}`);
  return result.plan;
}

const idsOf = (objects: readonly EditorObject[]) => objects.map((object) => object.id);

describe("orden de los operandos", () => {
  it("por defecto es el de PINTADO (el de abajo es A), sin importar el orden en que se seleccionaron", () => {
    // Pintado: capa A (r1, r2) y encima capa B (b1). Selección al revés.
    const result = plan([b1, r2, r1]);

    expect(idsOf(result.operands)).toEqual(["r1", "r2", "b1"]);
    expect(paintOrderIds(["b1", "r2", "r1"], DOC)).toEqual(["r1", "r2", "b1"]);
  });

  it("dentro de una capa el último de la lista está arriba: el de más abajo es A", () => {
    expect(idsOf(plan([r2, r1]).operands)).toEqual(["r1", "r2"]);
  });

  it("el orden pedido manda; los ids desconocidos y repetidos se ignoran y los que faltan se agregan al final en orden de pintado", () => {
    expect(idsOf(plan([r1, r2, b1], { order: ["b1", "r1", "r2"] }).operands)).toEqual(["b1", "r1", "r2"]);
    expect(idsOf(plan([r1, r2, b1], { order: ["r2", "fantasma", "r2"] }).operands)).toEqual(["r2", "r1", "b1"]);
  });

  it("subir/bajar mueve un lugar y no se sale de los bordes; invertir da vuelta la lista", () => {
    expect(moveOperand(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]);
    expect(moveOperand(["a", "b", "c"], 1, 1)).toEqual(["a", "c", "b"]);
    expect(moveOperand(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"]);
    expect(moveOperand(["a", "b", "c"], 2, 1)).toEqual(["a", "b", "c"]);
    expect(reverseOperands(["a", "b", "c"])).toEqual(["c", "b", "a"]);
    const original = ["a", "b"];
    moveOperand(original, 0, 1);
    reverseOperands(original);
    expect(original).toEqual(["a", "b"]); // no muta
  });

  it("las insignias son A..Z y luego A1, B1...", () => {
    expect([0, 1, 25, 26, 27, 52].map(operandLetter)).toEqual(["A", "B", "Z", "A1", "B1", "A2"]);
  });

  it("el nombre legible de un operando es «capa · objeto n» (n = posición dentro de su capa)", () => {
    expect(describeOperand(r2, 1, DOC)).toEqual({ letter: "B", layerName: "Rojo", indexInLayer: 4, name: "Rojo · objeto 4" });
    expect(describeOperand(b1, 2, DOC).name).toBe("Azul · objeto 1");
  });
});

describe("la petición al servidor", () => {
  const first = (subject: object) => (subject as { coordinates: number[][][] }).coordinates[0][0];

  it("la DIFERENCIA no conmuta: A es el subject y el resto los operandos; invertir el orden invierte la petición", () => {
    const aMenosB = plan([r1, b1], { op: "difference" });
    const bMenosA = plan([r1, b1], { op: "difference", order: ["b1", "r1"] });

    expect(aMenosB.request.operation).toBe("difference");
    expect(aMenosB.request.subjects).toHaveLength(1);
    expect(first(aMenosB.request.subjects[0])).toEqual([0, 0]); // A = r1
    expect(first(aMenosB.request.operands[0])).toEqual([50, 0]); // B = b1
    expect(first(bMenosA.request.subjects[0])).toEqual([50, 0]);
    expect(first(bMenosA.request.operands[0])).toEqual([0, 0]);
    expect(aMenosB.requestKey).not.toBe(bMenosA.requestKey);
  });

  it("diferencia de 3: A es el único subject y B y C van como operandos, en orden (no se reduce a binario)", () => {
    const result = plan([r1, r2, b1], { op: "difference" });

    expect(result.request.subjects).toHaveLength(1);
    expect(result.request.operands).toHaveLength(2);
    expect(first(result.request.operands[0])).toEqual([10, 0]);
    expect(first(result.request.operands[1])).toEqual([50, 0]);
  });

  it("la intersección es la región común a TODOS: usa intersection_all con todos los operandos como subjects", () => {
    const result = plan([r1, r2, b1], { op: "intersection" });

    expect(result.request.operation).toBe("intersection_all");
    expect(result.request.subjects).toHaveLength(3);
    expect(result.request.operands).toEqual([]);
  });

  it("unión y XOR mandan todas las formas como subjects (XOR de paridad impar lo resuelve el servidor)", () => {
    for (const op of ["union", "xor"] as BooleanOp[]) {
      const result = plan([r1, r2, b1], { op });
      expect(result.request.operation).toBe(op);
      expect(result.request.subjects).toHaveLength(3);
      expect(result.request.operands).toEqual([]);
    }
  });

  it("cada operando viaja como UN polígono con todos sus anillos (la regla par-impar arma los huecos)", () => {
    const ring = rect("ring", "A", 0, 0, 40, 40, { d: "M0 0 H40 V40 H0 Z M10 10 H30 V30 H10 Z" });
    const state = stateOf({ A: [ring, r1], B: [], C: [] }, LAYERS);

    const result = plan([ring, r1], { op: "union" }, state);

    expect((result.request.subjects[0] as { coordinates: unknown[] }).coordinates).toHaveLength(2);
  });

  it("la matriz del objeto se hornea: las coordenadas van en unidades de documento", () => {
    const moved = rect("moved", "A", 0, 0, 10, 10, { matrix: { a: 1, b: 0, c: 0, d: 1, e: 100, f: 50 } });
    const state = stateOf({ A: [r1, moved], B: [], C: [] }, LAYERS);

    const result = plan([moved, r1], { op: "union" }, state);

    expect(first(result.request.subjects[1])).toEqual([100, 50]); // el movido pasa a ser B (r1 está debajo)
    expect(first(result.request.subjects[0])).toEqual([0, 0]);
  });

  it("la tolerancia convertida desde mm viaja en unidades de documento y gobierna el aplanado de las curvas", () => {
    expect(toleranceFromMm(0.01, 0.5)).toBeCloseTo(0.02, 12); // 0,5 mm por unidad
    expect(toleranceFromMm(0.01, null)).toBe(0.01); // sin escala física: unidades
    const curve = rect("curve", "A", 0, 0, 0, 0, { d: "M0 100 C0 0 100 0 100 100 Z" });
    const state = stateOf({ A: [curve, r1], B: [], C: [] }, LAYERS);

    const fine = plan([curve, r1], { tolerance: 0.01 }, state);
    const coarse = plan([curve, r1], { tolerance: 5 }, state);

    expect(fine.request.tolerance).toBe(0.01);
    expect(coarse.request.tolerance).toBe(5);
    const vertices = (result: BooleanPlan) => (result.request.subjects[0] as { coordinates: number[][][] }).coordinates[0].length;
    expect(vertices(fine)).toBeGreaterThan(vertices(coarse));
  });

  it("la clave de la petición cambia con la operación, el orden, la tolerancia y la geometría, pero NO con la capa destino ni «conservar originales»", () => {
    const base = plan([r1, b1], { op: "union" });

    expect(plan([r1, b1], { op: "union" }).requestKey).toBe(base.requestKey);
    expect(plan([r1, b1], { op: "xor" }).requestKey).not.toBe(base.requestKey);
    expect(plan([r1, b1], { order: ["b1", "r1"] }).requestKey).not.toBe(base.requestKey);
    expect(plan([r1, b1], { tolerance: 0.5 }).requestKey).not.toBe(base.requestKey);
    expect(plan([r1, b1], { targetLayer: { kind: "layer", groupId: "B" } }).requestKey).toBe(base.requestKey);
    expect(plan([r1, b1], { keepOriginals: true }).requestKey).toBe(base.requestKey);
    // Otra referencia del mismo id (el objeto cambió) => otra clave.
    const edited = { ...r1, d: "M0 0 H25 V25 H0 Z" };
    expect(plan([edited, b1], {}, stateOf({ A: [x0, edited, x1, r2, x2], B: [b1], C: [] }, LAYERS)).requestKey).not.toBe(base.requestKey);
  });
});

describe("rechazos (todo o nada, con el motivo)", () => {
  function rejected(selection: EditorObject[], document: EditableDocument = DOC, options: Partial<BooleanOptions> = {}) {
    const result = planBoolean(selection, document, { op: "union", tolerance: TOL, ...options });
    if (result.ok) throw new Error("se esperaba un rechazo");
    return result;
  }

  it("menos de 2 objetos", () => {
    expect(rejected([r1]).reason).toBe("too_few");
    expect(rejected([]).reason).toBe("too_few");
    expect(rejected([r1, r1]).reason).toBe("too_few"); // el mismo objeto dos veces es uno solo
  });

  it("las líneas abiertas (fill none) se rechazan: «Las booleanas operan sobre formas rellenas»", () => {
    const line = rect("ln", "A", 0, 0, 0, 0, { d: "M0 0 L100 0", fill: "none", stroke: "#000000", strokeWidth: 1 });
    const transparent = rect("tr", "A", 0, 0, 10, 10, { fill: "transparent" });
    const state = stateOf({ A: [r1, line, transparent], B: [], C: [] }, LAYERS);

    const lineResult = rejected([r1, line], state);
    expect(lineResult.reason).toBe("unfilled");
    expect(lineResult.message).toMatch(/Las booleanas operan sobre formas rellenas/);
    expect(rejected([r1, transparent], state).reason).toBe("unfilled");
  });

  it("operandos en capas bloqueadas u ocultas: rechazo completo (no se omiten en silencio)", () => {
    const locked = stateOf(DOC.objectsByLayer, [meta("A", { locked: true }), ...LAYERS.slice(1)]);
    const hidden = stateOf(DOC.objectsByLayer, [LAYERS[0], meta("B", { visible: false }), LAYERS[2]]);

    expect(rejected([r1, r2], locked).reason).toBe("locked");
    expect(rejected([r1, b1], locked).message).toMatch(/1 objeto está en una capa bloqueada/);
    expect(rejected([r1, b1], hidden).reason).toBe("hidden");
    expect(rejected([r1, b1], hidden).message).toMatch(/capa oculta/);
  });

  it("un operando que ya no existe en el documento", () => {
    expect(rejected([r1, rect("fantasma", "A", 0, 0, 5)]).reason).toBe("missing");
  });

  it("un path ilegible o sin área no se manda al servidor", () => {
    const broken = rect("broken", "A", 0, 0, 5, 5, { d: "esto no es un path" });
    const state = stateOf({ A: [r1, broken], B: [], C: [] }, LAYERS);

    const result = rejected([r1, broken], state);

    expect(result.reason).toBe("invalid_geometry");
    expect(result.message).toMatch(/operando B/);
  });

  it("matriz no finita => geometría inválida", () => {
    const bad = rect("bad", "A", 0, 0, 5, 5, { matrix: { a: Number.NaN, b: 0, c: 0, d: 1, e: 0, f: 0 } });
    expect(rejected([r1, bad], stateOf({ A: [r1, bad], B: [], C: [] }, LAYERS)).reason).toBe("invalid_geometry");
  });

  it("más operandos que el máximo del servidor (500)", () => {
    const many = Array.from({ length: 501 }, (_, index) => rect(`m${index}`, "A", index, 0, 1));
    const state = stateOf({ A: many, B: [], C: [] }, LAYERS);

    expect(rejected(many, state).reason).toBe("too_many");
    expect(planBoolean(many.slice(0, 500), state, { op: "union", tolerance: TOL }).ok).toBe(true);
  });

  it("tolerancia inválida (0, negativa, NaN)", () => {
    for (const tolerance of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(rejected([r1, r2], DOC, { tolerance }).reason).toBe("invalid_tolerance");
    }
  });

  it("validateBooleanOperands y booleanAvailability dicen lo mismo (tooltip de los botones)", () => {
    expect(validateBooleanOperands([r1, r2], DOC)).toBeNull();
    expect(booleanAvailability([r1, r2], DOC)).toBeNull();
    expect(booleanAvailability([r1], DOC)).toMatch(/al menos 2 formas rellenas/);
    expect(booleanAvailability([r1, r2], DOC, { suspended: true })).toMatch(/giro o reflejo pendiente/);
  });
});

describe("capa destino: nunca se decide en silencio", () => {
  it("misma capa => el destino es esa capa, con su color", () => {
    const result = plan([r1, r2]);

    expect(result.layersDiffer).toBe(false);
    expect(result.target).toEqual({ groupId: "A", name: "Rojo", colorHex: "#ff0000", created: false });
    expect(result.targetIssue).toBeNull();
  });

  it("capas distintas SIN elección => sin destino y no se puede aplicar (no hay valor por defecto)", () => {
    const result = plan([r1, b1]);

    expect(result.layersDiffer).toBe(true);
    expect(result.target).toBeNull();
    expect(result.targetIssue).toMatch(/elegí la capa de destino/);
    const attempt = applyBooleanResult(result, DOC, responseFor(result, [{ geometries: [poly(square(0, 0, 10))] }]), idFactory().next);
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.code).toBe("target_required");
  });

  it("capas distintas: ni la capa del primero (A) ni la de más arriba se eligen solas, en ninguna operación ni orden", () => {
    for (const op of ["union", "difference", "intersection", "xor"] as BooleanOp[]) {
      expect(plan([r1, b1], { op }).target).toBeNull();
      expect(plan([r1, b1], { op, order: ["b1", "r1"] }).target).toBeNull();
    }
  });

  it("con elección explícita el color del resultado es el de ESA capa (de un operando u otra desbloqueada y visible)", () => {
    expect(plan([r1, b1], { targetLayer: { kind: "layer", groupId: "B" } }).target).toEqual({ groupId: "B", name: "Azul", colorHex: "#0000ff", created: false });
    expect(plan([r1, b1], { targetLayer: { kind: "layer", groupId: "C" } }).target?.colorHex).toBe("#00ff00");
  });

  it("una capa destino bloqueada, oculta o inexistente no sirve", () => {
    const locked = stateOf(DOC.objectsByLayer, [LAYERS[0], LAYERS[1], meta("C", { locked: true, name: "Verde" })]);
    const hidden = stateOf(DOC.objectsByLayer, [LAYERS[0], LAYERS[1], meta("C", { visible: false, name: "Verde" })]);

    expect(plan([r1, b1], { targetLayer: { kind: "layer", groupId: "C" } }, locked).targetIssue).toMatch(/bloqueada/);
    expect(plan([r1, b1], { targetLayer: { kind: "layer", groupId: "C" } }, hidden).targetIssue).toMatch(/oculta/);
    expect(plan([r1, b1], { targetLayer: { kind: "layer", groupId: "Z" } }).targetIssue).toMatch(/ya no existe/);
    expect(plan([r1, b1], { targetLayer: { kind: "layer", groupId: "C" } }, locked).target).toBeNull();
  });

  it("una capa nueva toma el hex elegido (mecánica de S03: «Color #RRGGBB»); un hex inválido deja el plan sin destino", () => {
    const ok = plan([r1, b1], { targetLayer: { kind: "new", hex: "#abc", groupId: "N" } });
    expect(ok.target).toEqual({ groupId: "N", name: "Color #AABBCC", colorHex: "#AABBCC", created: true });

    const bad = plan([r1, b1], { targetLayer: { kind: "new", hex: "rojo", groupId: "N" } });
    expect(bad.target).toBeNull();
    expect(bad.targetIssue).toMatch(/no es un color hex válido/);
  });

  it("los candidatos son las capas desbloqueadas y visibles, las de los operandos primero", () => {
    const state = stateOf(DOC.objectsByLayer, [meta("C", { name: "Verde", order: 0 }), meta("B", { name: "Azul", order: 1 }), meta("A", { name: "Rojo", order: 2, locked: true }), meta("D", { name: "Gris", order: 3, visible: false })]);

    const candidates = booleanTargetCandidates([r1, b1], state.layers ?? []);

    expect(candidates.map((candidate) => [candidate.layer.groupId, candidate.isOperandLayer])).toEqual([
      ["B", true],
      ["C", false],
    ]);
  });
});

describe("applyBooleanResult: UN comando atómico", () => {
  const piece = poly(square(0, 0, 40));

  it("reemplaza los operandos por las piezas: ids NUEVOS, capa y color del destino, sin matriz, en el lugar del operando más alto", () => {
    const planned = plan([r1, r2], { op: "union" });
    const ids = idFactory();

    const applied = applyBooleanResult(planned, DOC, responseFor(planned, [{ geometries: [piece] }]), ids.next);

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.production.atomic).toBe(true);
    expect(Object.keys(applied.production.layers)).toEqual(["A"]); // solo se toca la capa de los operandos
    const out = applied.production.layers.A;
    // Antes: x0, r1, x1, r2, x2. r1 y r2 desaparecen; el resultado ocupa el lugar de r2 (el más alto).
    expect(idsOf(out)).toEqual(["x0", "x1", "n1", "x2"]);
    expect(out[2]).toEqual({ id: "n1", layerGroupId: "A", d: expect.any(String), fill: "#ff0000", matrix: IDENTITY_MATRIX });
    expect(applied.resultIds).toEqual(["n1"]);
    expect(applied.summary).toMatchObject({ operandCount: 2, resultCount: 1, removed: 2, keepOriginals: false, unchanged: false });
    expect(applied.production.layerMetas).toBeUndefined();
    // Los objetos no operandos conservan su referencia.
    expect(out[0]).toBe(x0);
    expect(out[1]).toBe(x1);
  });

  it("varias piezas disjuntas son varios objetos, en el orden del servidor, con sus huecos como subpaths del mismo objeto", () => {
    const planned = plan([r1, r2]);
    const withHole = poly(square(0, 0, 40), square(10, 10, 10));
    const island = poly(square(100, 100, 5));
    const ids = idFactory();

    const applied = applyBooleanResult(planned, DOC, responseFor(planned, [{ geometries: [withHole, island] }]), ids.next);

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.resultIds).toEqual(["n1", "n2"]);
    const [first, second] = applied.production.layers.A.filter((object) => object.id.startsWith("n"));
    expect((first.d.match(/M/g) ?? []).length).toBe(2); // exterior + hueco
    expect((first.d.match(/Z/g) ?? []).length).toBe(2);
    expect((second.d.match(/M/g) ?? []).length).toBe(1);
    expect(ids.calls).toBe(2);
    expect(applied.summary.resultCount).toBe(2);
  });

  it("la posición de inserción es determinista: mismo resultado, misma lista", () => {
    const planned = plan([r1, r2]);
    const response = responseFor(planned, [{ geometries: [piece, poly(square(100, 100, 5))] }]);

    const one = applyBooleanResult(planned, DOC, response, idFactory().next);
    const two = applyBooleanResult(planned, DOC, response, idFactory().next);

    expect(one).toEqual(two);
  });

  it("«Conservar originales»: los operandos quedan y los resultados se agregan justo encima del operando más alto", () => {
    const planned = plan([r1, r2], { keepOriginals: true });

    const applied = applyBooleanResult(planned, DOC, responseFor(planned, [{ geometries: [piece] }]), idFactory().next);

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(idsOf(applied.production.layers.A)).toEqual(["x0", "r1", "x1", "r2", "n1", "x2"]);
    expect(applied.summary.removed).toBe(0);
    expect(Object.keys(applied.production.layers)).toEqual(["A"]);
  });

  it("operandos en dos capas: se quitan de la capa de origen y el resultado va a la capa ELEGIDA, con su color", () => {
    const planned = plan([r1, b1], { targetLayer: { kind: "layer", groupId: "B" } });

    const applied = applyBooleanResult(planned, DOC, responseFor(planned, [{ geometries: [piece] }]), idFactory().next);

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(idsOf(applied.production.layers.A)).toEqual(["x0", "x1", "r2", "x2"]); // r1 salió
    expect(applied.production.layers.B).toEqual([expect.objectContaining({ id: "n1", layerGroupId: "B", fill: "#0000ff" })]); // b1 salió, el resultado ocupa su lugar
    expect(applied.targetGroupId).toBe("B");
  });

  it("si ningún operando está en la capa destino, el resultado va al tope de ella", () => {
    const state = stateOf({ ...DOC.objectsByLayer, C: [rect("c1", "C", 300, 300, 5)] }, LAYERS);
    const planned = plan([r1, r2], { targetLayer: { kind: "layer", groupId: "C" } }, state);

    const applied = applyBooleanResult(planned, state, responseFor(planned, [{ geometries: [piece] }]), idFactory().next);

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(idsOf(applied.production.layers.C)).toEqual(["c1", "n1"]);
    expect(applied.production.layers.C[1].fill).toBe("#00ff00");
    expect(idsOf(applied.production.layers.A)).toEqual(["x0", "x1", "x2"]);
  });

  it("capa nueva: viaja en el MISMO comando (layerMetas) con el color elegido y el resultado cae en ella", () => {
    const planned = plan([r1, b1], { targetLayer: { kind: "new", hex: "#112233", groupId: "N" } });

    const applied = applyBooleanResult(planned, DOC, responseFor(planned, [{ geometries: [piece] }]), idFactory().next);

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.production.layerMetas).toEqual([expect.objectContaining({ groupId: "N", colorHex: "#112233", name: "Color #112233", isNew: true })]);
    expect(applied.production.layers.N).toEqual([expect.objectContaining({ layerGroupId: "N", fill: "#112233" })]);
    expect(applied.summary.target.created).toBe(true);
    expect(booleanNotice(applied.summary)).toMatch(/capa es nueva/);
  });

  it("resultado VACÍO => no se aplica y no hay producción: «El resultado está vacío»", () => {
    const planned = plan([r1, b1], { op: "intersection", targetLayer: { kind: "layer", groupId: "A" } });

    const applied = applyBooleanResult(planned, DOC, responseFor(planned, [{ geometries: [] }]), idFactory().next);

    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.code).toBe("empty");
    expect(applied.error).toMatch(/El resultado está vacío/);
    expect(applied).not.toHaveProperty("production");
  });

  it("una diferencia totalmente cubierta también es vacía y no borra nada", () => {
    const planned = plan([r1, r2], { op: "difference", order: ["r1", "r2"] });

    const applied = applyBooleanResult(planned, DOC, responseFor(planned, [{ changed: true, geometries: [] }]), idFactory().next);

    expect(applied.ok).toBe(false);
    if (!applied.ok) expect(applied.code).toBe("empty");
  });

  it("las piezas despreciables (área < tolerancia²) se descartan y se cuentan; si no queda ninguna, el resultado está vacío", () => {
    const planned = plan([r1, r2], { tolerance: 1 }); // umbral = 1
    const speck = poly(square(0, 0, 0.5)); // área 0,25 < 1
    const real = poly(square(100, 100, 5)); // 25

    const mixed = applyBooleanResult(planned, DOC, responseFor(planned, [{ geometries: [speck, real] }]), idFactory().next);
    const onlySpeck = applyBooleanResult(planned, DOC, responseFor(planned, [{ geometries: [speck] }]), idFactory().next);

    expect(mixed.ok).toBe(true);
    if (mixed.ok) {
      expect(mixed.summary).toMatchObject({ resultCount: 1, discarded: 1 });
      expect(booleanNotice(mixed.summary)).toMatch(/1 pieza despreciable descartada/);
    }
    expect(onlySpeck.ok).toBe(false);
    if (!onlySpeck.ok) {
      expect(onlySpeck.code).toBe("empty");
      expect(onlySpeck.error).toMatch(/1 pieza despreciable descartada/);
    }
  });

  describe("`changed: false` (la diferencia no toca a A)", () => {
    const curved = rect("curved", "A", 0, 0, 0, 0, { d: "M0 100 C0 0 100 0 100 100 Z", matrix: { a: 1, b: 0, c: 0, d: 1, e: 5, f: 5 } });
    const far = rect("far", "A", 500, 500, 10);
    const state = stateOf({ A: [x0, curved, x1, far, x2], B: [b1], C: [] }, LAYERS);

    it("A conserva su d con las curvas, su matriz y su id (sin aplanar); el otro operando desaparece y no se crean ids", () => {
      const planned = plan([curved, far], { op: "difference" }, state);
      const ids = idFactory();

      const applied = applyBooleanResult(planned, state, responseFor(planned, [{ changed: false, geometries: [poly(square(0, 0, 1))] }]), ids.next);

      expect(applied.ok).toBe(true);
      if (!applied.ok) return;
      expect(ids.calls).toBe(0);
      expect(applied.summary.unchanged).toBe(true);
      expect(applied.production.layers.A).toEqual([x0, curved, x1, x2]);
      expect(applied.production.layers.A[1]).toBe(curved); // la MISMA referencia: d con "C" intacto
      expect(applied.production.layers.A[1].d).toContain("C");
      expect(applied.resultIds).toEqual(["curved"]);
      expect(booleanNotice(applied.summary)).toMatch(/se conservó intacto, con sus curvas/);
    });

    it("con «Conservar originales» no hay nada que agregar: no se aplica", () => {
      const planned = plan([curved, far], { op: "difference", keepOriginals: true }, state);

      const applied = applyBooleanResult(planned, state, responseFor(planned, [{ changed: false, geometries: [poly(square(0, 0, 1))] }]), idFactory().next);

      expect(applied.ok).toBe(false);
      if (!applied.ok) expect(applied.code).toBe("nothing_to_do");
    });

    it("si A está en otra capa que el destino, pasa a ella con su color pero conserva d y matriz", () => {
      const aInRed = rect("a", "A", 0, 0, 10, 10, { d: "M0 0 C5 -5 10 -5 10 0 L10 10 Z" });
      const farBlue = rect("far2", "B", 500, 500, 10, 10, { fill: "#0000ff" });
      const split = stateOf({ A: [aInRed], B: [farBlue], C: [] }, LAYERS);
      const planned = plan([aInRed, farBlue], { op: "difference", targetLayer: { kind: "layer", groupId: "B" } }, split);

      const applied = applyBooleanResult(planned, split, responseFor(planned, [{ changed: false, geometries: [poly(square(0, 0, 1))] }]), idFactory().next);

      expect(applied.ok).toBe(true);
      if (!applied.ok) return;
      expect(applied.production.layers.A).toEqual([]);
      expect(applied.production.layers.B).toEqual([{ ...aInRed, layerGroupId: "B", fill: "#0000ff" }]);
      expect(applied.summary.moved).toBe(1);
    });
  });

  describe("respuestas incoherentes: nunca se crea geometría dudosa", () => {
    const planned = plan([r1, r2]);

    it("otra operación, otro alcance o otra cantidad de resultados", () => {
      const good = responseFor(planned, [{ geometries: [piece] }]);

      for (const bad of [
        { ...good, operation: "xor" as const },
        { ...good, results: [] },
        { ...good, results: [good.results[0], good.results[0]] },
        { ...good, results: [{ ...good.results[0], subjectIndex: 0 }] },
      ]) {
        const applied = applyBooleanResult(planned, DOC, bad, idFactory().next);
        expect(applied.ok).toBe(false);
        if (!applied.ok) expect(applied.code).toBe("invalid_response");
      }
    });

    it("anillo abierto, coordenadas no finitas o una polilínea para formas rellenas", () => {
      const open: GeometryPiece = { type: "polygon", coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10]]] };
      const nan: GeometryPiece = { type: "polygon", coordinates: [[[0, 0], [Number.NaN, 0], [10, 10], [0, 0]]] };
      const line: GeometryPiece = { type: "line", coordinates: [[0, 0], [10, 10]] };

      for (const bad of [open, nan, line]) {
        const applied = applyBooleanResult(planned, DOC, responseFor(planned, [{ geometries: [bad] }]), idFactory().next);
        expect(applied.ok).toBe(false);
        if (!applied.ok) expect(applied.code).toBe("invalid_response");
      }
    });

    it("el documento cambió mientras se calculaba (un operando ya no es el mismo objeto): se descarta", () => {
      const moved = { ...r2, d: "M0 0 H5 V5 H0 Z" };
      const changed = stateOf({ A: [x0, r1, x1, moved, x2], B: [b1], C: [] }, LAYERS);

      const applied = applyBooleanResult(planned, changed, responseFor(planned, [{ geometries: [piece] }]), idFactory().next);

      expect(applied.ok).toBe(false);
      if (!applied.ok) expect(applied.code).toBe("stale");
    });

    it("una capa que se bloqueó o se ocultó entre el preview y Apply: rechazo, sin producción", () => {
      const locked = stateOf(DOC.objectsByLayer, [meta("A", { name: "Rojo", locked: true }), LAYERS[1], LAYERS[2]]);
      const hiddenTarget = stateOf(DOC.objectsByLayer, [meta("A", { name: "Rojo", visible: false }), LAYERS[1], LAYERS[2]]);

      for (const state of [locked, hiddenTarget]) {
        const applied = applyBooleanResult(planned, state, responseFor(planned, [{ geometries: [piece] }]), idFactory().next);
        expect(applied.ok).toBe(false);
        if (!applied.ok) expect(applied.code).toBe("blocked");
      }
    });
  });

  it("etiqueta y aviso del comando", () => {
    const planned = plan([r1, r2], { op: "xor" });
    const applied = applyBooleanResult(planned, DOC, responseFor(planned, [{ geometries: [piece, poly(square(100, 100, 5))] }]), idFactory().next);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    expect(booleanLabel(applied.summary)).toBe("XOR (exclusión) (2 objetos → 2 piezas)");
    expect(booleanNotice(applied.summary)).toBe("XOR (exclusión) aplicada: 2 objetos → 2 objetos en la capa «Rojo». 2 originales reemplazados.");
  });
});

describe("booleanOutcome / pieceArea", () => {
  it("el área de una pieza es |exterior| − Σ|huecos| (calculada a mano), sin depender del giro de los anillos", () => {
    expect(pieceArea(poly(square(0, 0, 10)))).toBe(100);
    expect(pieceArea(poly(square(0, 0, 10), square(2, 2, 4)))).toBe(84); // 100 - 16
    const clockwise = poly([[0, 0], [0, 10], [10, 10], [10, 0]]);
    expect(pieceArea(clockwise)).toBe(100);
    expect(pieceArea({ type: "line", coordinates: [[0, 0], [5, 5]] })).toBe(0);
  });

  it("clasifica el resultado: piezas, A sin cambios o vacío", () => {
    const union = plan([r1, r2]);
    const difference = plan([r1, b1], { op: "difference", targetLayer: { kind: "layer", groupId: "A" } });

    const pieces = booleanOutcome(union, responseFor(union, [{ geometries: [poly(square(0, 0, 10))] }]));
    const same = booleanOutcome(difference, responseFor(difference, [{ changed: false, geometries: [poly(square(0, 0, 10))] }]));
    const empty = booleanOutcome(union, responseFor(union, [{ geometries: [] }]));

    expect(pieces.ok && pieces.outcome.kind).toBe("pieces");
    expect(same.ok && same.outcome.kind).toBe("unchanged");
    expect(same.ok && same.outcome.shapes[0]).toEqual({ d: r1.d, matrix: r1.matrix });
    expect(empty.ok && empty.outcome.kind).toBe("empty");
  });
});
