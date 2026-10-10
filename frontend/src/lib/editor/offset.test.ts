import { describe, expect, it } from "vitest";
import type { OffsetResponse, OffsetResultItem, PolygonGeometry } from "../../types/geometry";
import { IDENTITY_MATRIX } from "../svgTransform";
import {
  applyOffsetResult,
  effectiveDirection,
  formatPanelValue,
  hasOpenLines,
  insideUnavailableReason,
  MAX_OFFSET_MM,
  NO_SCALE_NOTICE,
  offsetApplyBlock,
  offsetAvailability,
  offsetConfirmText,
  offsetDestinationText,
  offsetErrorMessage,
  offsetLabel,
  offsetNotice,
  offsetOutcome,
  offsetReadyText,
  offsetResultColor,
  offsetTargetCandidates,
  offsetWarnings,
  panelValue,
  planOffset,
  scaleNotice,
  signedDistanceUnits,
  validateOffsetObjects,
  validateOffsetResponse,
  type OffsetOptions,
  type OffsetPlan,
} from "./offset";
import type { EditableDocument, EditableLayerMeta, EditorObject } from "./types";
import { unitScale } from "./geometry";

// ---- Fixtures ----

function meta(groupId: string, overrides: Partial<EditableLayerMeta> = {}): EditableLayerMeta {
  return { groupId, name: `Capa ${groupId}`, colorHex: "#ff0000", order: 0, visible: true, locked: false, manufacturingOperation: "unassigned", isNew: false, ...overrides };
}

function rect(id: string, layerGroupId: string, x: number, y: number, w: number, h = w, overrides: Partial<EditorObject> = {}): EditorObject {
  return { id, layerGroupId, d: `M${x} ${y} H${x + w} V${y + h} H${x} Z`, fill: "#ff0000", matrix: IDENTITY_MATRIX, ...overrides };
}

function line(id: string, layerGroupId: string, x1: number, y1: number, x2: number, y2: number): EditorObject {
  return { id, layerGroupId, d: `M${x1} ${y1} L${x2} ${y2}`, fill: "none", stroke: "#00aa00", strokeWidth: 0.5, matrix: IDENTITY_MATRIX };
}

function stateOf(objectsByLayer: Record<string, EditorObject[]>, layers: EditableLayerMeta[]): EditableDocument {
  return { objectsByLayer, layers };
}

const ring = (x: number, y: number, w: number, h = w): [number, number][] => [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
const poly = (...rings: [number, number][][]): PolygonGeometry => ({ type: "polygon", coordinates: rings });

function idFactory(prefix = "n") {
  let counter = 0;
  return { next: () => `${prefix}${(counter += 1)}`, get calls() { return counter; } };
}

// Capa A «Rojo» (roja, abajo): r1 (0..20), r2 (100..120), ln (línea). Capa B «Azul»: b1 (200..220). Capa C «Verde» vacía. Capa D «Naranja» (bloqueada).
const r1 = rect("r1", "A", 0, 0, 20);
const r2 = rect("r2", "A", 100, 0, 20);
const ln = line("ln", "A", 0, 50, 30, 50);
const b1 = rect("b1", "B", 200, 0, 20, 20, { fill: "#0000ff" });
const LAYERS = [
  meta("A", { name: "Rojo", colorHex: "#ff0000", order: 0 }),
  meta("B", { name: "Azul", colorHex: "#0000ff", order: 1 }),
  meta("C", { name: "Verde", colorHex: "#00ff00", order: 2 }),
  meta("D", { name: "Naranja", colorHex: "#ff8800", order: 3, locked: true }),
];
const DOC = stateOf({ A: [r1, r2, ln], B: [b1], C: [], D: [] }, LAYERS);
const MM = 0.5; // mm por unidad de documento

function options(overrides: Partial<OffsetOptions> = {}): OffsetOptions {
  return { distance: 2, direction: "outside", joinStyle: "round", mitreLimit: 2, capStyle: "round", toleranceMm: 0.01, mmFactor: MM, ...overrides };
}

function plan(selection: EditorObject[], overrides: Partial<OffsetOptions> = {}, document: EditableDocument = DOC): OffsetPlan {
  const result = planOffset(selection, document, options(overrides));
  if (!result.ok) throw new Error(`se esperaba un plan y fue ${result.reason}: ${result.message}`);
  return result.plan;
}

function rejection(selection: EditorObject[], overrides: Partial<OffsetOptions> = {}, document: EditableDocument = DOC) {
  const result = planOffset(selection, document, options(overrides));
  if (result.ok) throw new Error("se esperaba un rechazo");
  return result;
}

type ItemInit = Partial<Omit<OffsetResultItem, "subjectIndex" | "geometries">> & { geometries: PolygonGeometry[] };

/** Respuesta del servidor para el plan: un item por subject (los parámetros se repiten tal cual, como hace el servidor). */
function responseFor(target: OffsetPlan, items: ItemInit[]): OffsetResponse {
  const results: OffsetResultItem[] = items.map((item, index) => {
    const isLine = target.request.subjects[index].type === "line";
    const holes = item.geometries.reduce((total, piece) => total + piece.coordinates.length - 1, 0);
    return {
      subjectIndex: index,
      collapsed: item.geometries.length === 0,
      piecesBefore: 1,
      splitCount: item.geometries.length,
      lostPieces: 0,
      holesBefore: 0,
      holesAfter: holes,
      maxInwardOffset: isLine ? null : 20,
      ...item,
    };
  });
  return {
    distance: target.request.distance,
    joinStyle: target.request.joinStyle,
    mitreLimit: target.request.mitreLimit,
    capStyle: target.request.capStyle,
    tolerance: target.request.tolerance,
    results,
    pieceCount: results.reduce((total, item) => total + item.geometries.length, 0),
  };
}

const GROWN = poly(ring(-4, -4, 28)); // r1 con offset de 2 mm (4 u)
const SHRUNK = poly(ring(4, 4, 12));

function apply(target: OffsetPlan, response: OffsetResponse, confirmed = false, state: EditableDocument = DOC, createId = idFactory().next) {
  return applyOffsetResult(target, state, response, { confirmed, createId });
}

function ok(application: ReturnType<typeof apply>) {
  if (!application.ok) throw new Error(`se esperaba aplicar y fue ${application.code}: ${application.error}`);
  return application;
}

const idsOf = (objects: readonly EditorObject[]) => objects.map((object) => object.id);

// ---- Unidades y signo ----

describe("mm ↔ unidades de documento y signo de la distancia", () => {
  it("con escala física: la distancia y la tolerancia se convierten con mmPerUnit (0,5 mm/u: 2 mm = 4 u, 0,01 mm = 0,02 u)", () => {
    const result = plan([r1], { distance: 2 });

    expect(result.request.distance).toBeCloseTo(4, 12);
    expect(result.request.tolerance).toBeCloseTo(0.02, 12);
    expect(result.unit).toEqual({ factor: 0.5, label: "mm" });
    expect(result.scaleNotice).toBeNull();
  });

  it("otra escala da otra conversión: 0,25 mm/u -> 2 mm = 8 u (no hay constantes escondidas)", () => {
    expect(plan([r1], { distance: 2, mmFactor: 0.25 }).request.distance).toBeCloseTo(8, 12);
    expect(plan([r1], { distance: 2, mmFactor: 2 }).request.distance).toBeCloseTo(1, 12);
  });

  it("la dirección fija el signo: exterior es positiva e interior negativa, con la misma magnitud", () => {
    expect(plan([r1], { direction: "outside" }).request.distance).toBeCloseTo(4, 12);
    expect(plan([r1], { direction: "inside" }).request.distance).toBeCloseTo(-4, 12);
    expect(signedDistanceUnits(3, "outside", 0.5)).toBeCloseTo(6, 12);
    expect(signedDistanceUnits(3, "inside", 0.5)).toBeCloseTo(-6, 12);
  });

  it("SIN escala física trabaja en unidades (nunca inventa mm) y deja el aviso visible", () => {
    const result = plan([r1], { distance: 2, mmFactor: null });

    expect(result.request.distance).toBe(2);
    expect(result.request.tolerance).toBe(0.01);
    expect(result.unit).toEqual({ factor: 1, label: "u" });
    expect(result.scaleNotice).toBe(NO_SCALE_NOTICE);
    expect(NO_SCALE_NOTICE).toMatch(/sin escala física/i);
    expect(scaleNotice(null)).toBe(NO_SCALE_NOTICE);
    expect(scaleNotice(0.5)).toBeNull();
    expect(scaleNotice(Number.NaN)).toBe(NO_SCALE_NOTICE);
    expect(scaleNotice(0)).toBe(NO_SCALE_NOTICE);
  });

  it("panelValue y formatPanelValue invierten la conversión y muestran la unidad", () => {
    expect(panelValue(20, 0.5)).toBe(10);
    expect(panelValue(20, null)).toBe(20);
    expect(formatPanelValue(1.5, unitScale(0.5))).toBe("1.5 mm");
    expect(formatPanelValue(1.5, unitScale(null))).toBe("1.5 u");
  });

  it("el offset de 0, negativo, NaN, Infinity o mayor al tope (1000 mm) se rechaza con el motivo; el tope exacto pasa", () => {
    for (const distance of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, MAX_OFFSET_MM + 0.001]) {
      const result = rejection([r1], { distance });
      expect(result.reason).toBe("invalid_distance");
      expect(result.message).toMatch(/No se modificó nada/);
    }
    expect(planOffset([r1], DOC, options({ distance: MAX_OFFSET_MM })).ok).toBe(true);
  });

  it("con una escala diminuta el máximo del servidor (1 000 000 u) se avisa en vez de mandar una distancia que rechazaría", () => {
    const result = rejection([r1], { distance: 1000, mmFactor: 0.0005 }); // 1000 mm = 2 000 000 u

    expect(result.reason).toBe("invalid_distance");
    expect(result.message).toMatch(/máximo que acepta el servidor/);
  });

  it("tolerancia y límite de inglete inválidos se rechazan", () => {
    expect(rejection([r1], { toleranceMm: 0 }).reason).toBe("invalid_tolerance");
    expect(rejection([r1], { toleranceMm: Number.NaN }).reason).toBe("invalid_tolerance");
    expect(rejection([r1], { mitreLimit: 0 }).reason).toBe("invalid_mitre");
    expect(rejection([r1], { mitreLimit: 101 }).reason).toBe("invalid_mitre");
    expect(planOffset([r1], DOC, options({ mitreLimit: 100 })).ok).toBe(true);
  });
});

// ---- Joins, caps, líneas ----

describe("joins, caps y líneas abiertas", () => {
  it("el join, el límite de inglete y el cap viajan tal cual en la petición", () => {
    const result = plan([r1], { joinStyle: "mitre", mitreLimit: 3.5, capStyle: "square" });

    expect(result.request.joinStyle).toBe("mitre");
    expect(result.request.mitreLimit).toBe(3.5);
    expect(result.request.capStyle).toBe("square");
  });

  it("un objeto relleno viaja como UN polígono con todos sus anillos y un objeto sin relleno como polilínea", () => {
    const holed = rect("holed", "A", 0, 0, 40, 40, { d: "M0 0 H40 V40 H0 Z M10 10 H30 V30 H10 Z" });
    const state = stateOf({ A: [holed, ln], B: [], C: [], D: [] }, LAYERS);

    const result = plan([holed, ln], {}, state);

    expect(result.request.subjects.map((subject) => subject.type)).toEqual(["polygon", "line"]);
    expect((result.request.subjects[0] as PolygonGeometry).coordinates).toHaveLength(2);
    expect(result.hasLines).toBe(true);
    expect(result.onlyLines).toBe(false);
  });

  it("una línea abierta solo admite «ambos lados»: Interior se rechaza con el motivo y nunca se reinterpreta", () => {
    const result = rejection([r1, ln], { direction: "inside" });

    expect(result.reason).toBe("interior_lines");
    expect(result.message).toMatch(/no tiene interior/);
    expect(result.message).toMatch(/No se modificó nada/);
    expect(planOffset([r1, ln], DOC, options({ direction: "outside" })).ok).toBe(true);
    expect(planOffset([r1], DOC, options({ direction: "inside" })).ok).toBe(true);
  });

  it("effectiveDirection fuerza «exterior» (ambos lados) con líneas y respeta lo pedido sin ellas", () => {
    expect(effectiveDirection("inside", [r1, ln])).toBe("outside");
    expect(effectiveDirection("inside", [r1])).toBe("inside");
    expect(effectiveDirection("outside", [ln])).toBe("outside");
    expect(hasOpenLines([r1])).toBe(false);
    expect(hasOpenLines([ln])).toBe(true);
    expect(insideUnavailableReason([r1])).toBeNull();
    expect(insideUnavailableReason([ln])).toMatch(/solo se desplaza a ambos lados/);
  });

  it("onlyLines distingue una selección solo de líneas de una mezcla", () => {
    expect(plan([ln]).onlyLines).toBe(true);
    expect(plan([ln, r1]).onlyLines).toBe(false);
    expect(plan([r1]).onlyLines).toBe(false);
  });

  it("la matriz del objeto se hornea: las coordenadas viajan en unidades de documento", () => {
    const moved = rect("moved", "A", 0, 0, 10, 10, { matrix: { a: 1, b: 0, c: 0, d: 1, e: 100, f: 50 } });
    const state = stateOf({ A: [moved], B: [], C: [], D: [] }, LAYERS);

    const result = plan([moved], {}, state);

    expect((result.request.subjects[0] as PolygonGeometry).coordinates[0][0]).toEqual([100, 50]);
  });
});

// ---- Selección ----

describe("selección y capas de origen", () => {
  it("sin selección no hay plan (y se dice por qué)", () => {
    const result = rejection([]);

    expect(result.reason).toBe("none_selected");
    expect(offsetAvailability([], DOC)).toMatch(/Seleccioná uno o más objetos/);
    expect(offsetAvailability([r1], DOC)).toBeNull();
  });

  it("una capa de origen bloqueada rechaza la operación COMPLETA, aunque los demás objetos estén bien", () => {
    const locked = rect("lk", "D", 0, 0, 10);
    const state = stateOf({ A: [r1], B: [b1], C: [], D: [locked] }, LAYERS);

    const result = rejection([r1, locked], {}, state);

    expect(result.reason).toBe("locked");
    expect(result.message).toMatch(/1 objeto está en una capa bloqueada/);
    expect(result.message).toMatch(/No se modificó nada/);
    expect(validateOffsetObjects([locked], state)?.reason).toBe("locked");
  });

  it("una capa de origen oculta rechaza la operación completa", () => {
    const hiddenLayers = LAYERS.map((layer) => (layer.groupId === "B" ? { ...layer, visible: false } : layer));
    const state = stateOf({ A: [r1], B: [b1], C: [], D: [] }, hiddenLayers);

    const result = rejection([r1, b1], {}, state);

    expect(result.reason).toBe("hidden");
    expect(result.message).toMatch(/capa oculta/);
  });

  it("bloqueada gana sobre oculta en el mensaje, y se cuentan los objetos", () => {
    const layers = LAYERS.map((layer) => (layer.groupId === "A" ? { ...layer, locked: true } : layer.groupId === "B" ? { ...layer, visible: false } : layer));
    const state = stateOf({ A: [r1, r2], B: [b1], C: [], D: [] }, layers);

    expect(rejection([r1, r2, b1], {}, state).message).toMatch(/2 objetos están en capas bloqueadas/);
  });

  it("un objeto que ya no existe en el documento rechaza todo", () => {
    const ghost = rect("ghost", "A", 0, 0, 5);

    expect(rejection([r1, ghost]).reason).toBe("missing");
  });

  it("geometría ilegible o sin área rechaza todo (nunca se manda geometría dudosa)", () => {
    const broken = rect("broken", "A", 0, 0, 10, 10, { d: "esto no es un path" });
    const state = stateOf({ A: [r1, broken], B: [], C: [], D: [] }, LAYERS);

    expect(rejection([r1, broken], {}, state).reason).toBe("invalid_geometry");
  });

  it("demasiados contornos (más de 500) se rechazan con el motivo", () => {
    const many = Array.from({ length: 501 }, (_, index) => rect(`m${index}`, "A", index * 3, 0, 2));
    const state = stateOf({ A: many, B: [], C: [], D: [] }, LAYERS);

    const result = rejection(many, {}, state);

    expect(result.reason).toBe("too_many");
    expect(result.message).toMatch(/501 contornos/);
  });

  it("los objetos van en orden de PINTADO sin importar el orden de la selección", () => {
    expect(idsOf(plan([b1, r2, r1]).objects)).toEqual(["r1", "r2", "b1"]);
  });

  it("la clave de la petición cambia con la distancia, el signo, el join, el cap, el inglete, la tolerancia y la geometría; NO con conservar originales ni la capa", () => {
    const base = plan([r1]);

    expect(plan([r1]).requestKey).toBe(base.requestKey);
    expect(plan([r1], { distance: 3 }).requestKey).not.toBe(base.requestKey);
    expect(plan([r1], { direction: "inside" }).requestKey).not.toBe(base.requestKey);
    expect(plan([r1], { joinStyle: "bevel" }).requestKey).not.toBe(base.requestKey);
    expect(plan([r1], { capStyle: "flat" }).requestKey).not.toBe(base.requestKey);
    expect(plan([r1], { mitreLimit: 4 }).requestKey).not.toBe(base.requestKey);
    expect(plan([r1], { toleranceMm: 0.02 }).requestKey).not.toBe(base.requestKey);
    expect(plan([r1, r2]).requestKey).not.toBe(base.requestKey);
    expect(plan([r1], { keepOriginals: false }).requestKey).toBe(base.requestKey);
    expect(plan([r1], { targetLayer: { kind: "layer", groupId: "C" } }).requestKey).toBe(base.requestKey);
    // Otra referencia del mismo id (el objeto cambió) = otra clave.
    const edited = { ...r1, d: "M0 0 H30 V30 H0 Z" };
    expect(plan([edited], {}, stateOf({ A: [edited, r2, ln], B: [b1], C: [], D: [] }, LAYERS)).requestKey).not.toBe(base.requestKey);
  });
});

// ---- Capa destino ----

describe("capa destino", () => {
  it("por defecto cada resultado va a la capa de su origen y el panel lo dice", () => {
    const result = plan([r1, b1]);

    expect(result.mode).toBe("origin");
    expect(result.target).toBeNull();
    expect(offsetDestinationText(result, LAYERS)).toBe("Cada resultado va a la capa de su objeto de origen, con el color de esa capa: «Rojo» (1 objeto), «Azul» (1 objeto).");
    expect(offsetResultColor(result, r1, LAYERS)).toBe("#ff0000");
    expect(offsetResultColor(result, b1, LAYERS)).toBe("#0000ff");
  });

  it("una capa destino explícita se resuelve con su nombre y color, y es 'explicit'", () => {
    const result = plan([r1, b1], { targetLayer: { kind: "layer", groupId: "C" } });

    expect(result.mode).toBe("explicit");
    expect(result.target).toEqual({ groupId: "C", name: "Verde", colorHex: "#00ff00", created: false });
    expect(offsetDestinationText(result, LAYERS)).toBe("Todos los resultados van a «Verde», con el color #00ff00.");
    expect(offsetResultColor(result, r1, LAYERS)).toBe("#00ff00");
  });

  it("un destino bloqueado, oculto o inexistente deja el plan SIN destino y explica por qué", () => {
    const locked = plan([r1], { targetLayer: { kind: "layer", groupId: "D" } });
    expect(locked.target).toBeNull();
    expect(locked.targetIssue).toMatch(/«Naranja» está bloqueada/);
    expect(offsetDestinationText(locked, LAYERS)).toBeNull();
    expect(offsetResultColor(locked, r1, LAYERS)).toBeNull();

    const hiddenLayers = LAYERS.map((layer) => (layer.groupId === "C" ? { ...layer, visible: false } : layer));
    const hidden = plan([r1], { targetLayer: { kind: "layer", groupId: "C" } }, stateOf(DOC.objectsByLayer, hiddenLayers));
    expect(hidden.targetIssue).toMatch(/«Verde» está oculta/);

    expect(plan([r1], { targetLayer: { kind: "layer", groupId: "zzz" } }).targetIssue).toMatch(/ya no existe/);
  });

  it("una capa nueva con un color: se crea en el plan (created) y un color inválido deja el plan sin destino", () => {
    const valid = plan([r1], { targetLayer: { kind: "new", hex: "#112233", groupId: "NEW" } });
    expect(valid.target).toMatchObject({ groupId: "NEW", colorHex: "#112233", created: true });
    expect(offsetDestinationText(valid, LAYERS)).toMatch(/\(capa nueva\)/);

    const invalid = plan([r1], { targetLayer: { kind: "new", hex: "rojo", groupId: "NEW" } });
    expect(invalid.target).toBeNull();
    expect(invalid.targetIssue).toMatch(/no es un color hex válido/);
  });

  it("los candidatos son capas desbloqueadas y visibles; las de los objetos primero", () => {
    const candidates = offsetTargetCandidates([b1], LAYERS);

    expect(candidates.map((entry) => [entry.layer.groupId, entry.isOriginLayer])).toEqual([
      ["B", true],
      ["A", false],
      ["C", false],
    ]);
  });
});

// ---- Respuesta ----

describe("la respuesta del servidor", () => {
  it("una respuesta coherente se acepta y cada pieza pasa a ser un path válido, sin matriz", () => {
    const target = plan([r1]);

    const result = offsetOutcome(target, responseFor(target, [{ geometries: [GROWN] }]));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome.objects[0].shapes).toEqual([{ d: "M-4 -4 L24 -4 L24 24 L-4 24 Z", matrix: IDENTITY_MATRIX }]);
    expect(result.outcome.shapeCount).toBe(1);
    expect(result.outcome.allCollapsed).toBe(false);
    expect(result.outcome.needsConfirmation).toBe(false);
  });

  it("los huecos viajan como subpaths del mismo path", () => {
    const target = plan([r1]);
    const withHole = poly(ring(-4, -4, 28), ring(2, 2, 4));

    const result = offsetOutcome(target, responseFor(target, [{ geometries: [withHole], holesBefore: 1 }]));

    expect(result.ok && result.outcome.objects[0].shapes[0].d).toBe("M-4 -4 L24 -4 L24 24 L-4 24 Z M2 2 L6 2 L6 6 L2 6 Z");
  });

  it.each<[string, (response: OffsetResponse) => OffsetResponse]>([
    ["otra distancia", (response: OffsetResponse) => ({ ...response, distance: response.distance + 1 })],
    ["otro join", (response: OffsetResponse) => ({ ...response, joinStyle: "bevel" as const })],
    ["otro cap", (response: OffsetResponse) => ({ ...response, capStyle: "flat" as const })],
    ["otro límite de inglete", (response: OffsetResponse) => ({ ...response, mitreLimit: 9 })],
    ["menos resultados", (response: OffsetResponse) => ({ ...response, results: [] })],
    ["subjectIndex equivocado", (response: OffsetResponse) => ({ ...response, results: [{ ...response.results[0], subjectIndex: 4 }] })],
    ["collapsed que no coincide con las piezas", (response: OffsetResponse) => ({ ...response, results: [{ ...response.results[0], collapsed: true }] })],
    ["splitCount que no coincide", (response: OffsetResponse) => ({ ...response, results: [{ ...response.results[0], splitCount: 3 }] })],
    ["huecos inventados", (response: OffsetResponse) => ({ ...response, results: [{ ...response.results[0], holesAfter: 2 }] })],
    ["piezas perdidas > piezas previas", (response: OffsetResponse) => ({ ...response, results: [{ ...response.results[0], lostPieces: 2 }] })],
    ["conteos negativos", (response: OffsetResponse) => ({ ...response, results: [{ ...response.results[0], piecesBefore: -1 }] })],
    ["máximo interior ausente en un polígono", (response: OffsetResponse) => ({ ...response, results: [{ ...response.results[0], maxInwardOffset: null }] })],
    ["máximo interior negativo", (response: OffsetResponse) => ({ ...response, results: [{ ...response.results[0], maxInwardOffset: -1 }] })],
    ["anillo sin cerrar", (response: OffsetResponse) => ({ ...response, results: [{ ...response.results[0], geometries: [{ type: "polygon" as const, coordinates: [[[0, 0], [5, 0], [5, 5], [0, 5]]] }] }] })],
    ["coordenadas no finitas", (response: OffsetResponse) => ({ ...response, results: [{ ...response.results[0], geometries: [poly([[0, 0], [5, 0], [5, Number.NaN], [0, 0]])] }] })],
    ["una polilínea en vez de un polígono", (response: OffsetResponse) => ({ ...response, results: [{ ...response.results[0], geometries: [{ type: "line", coordinates: [[0, 0], [1, 1]] } as unknown as PolygonGeometry] }] })],
  ])("rechaza la respuesta incoherente: %s", (_name, mutate) => {
    const target = plan([r1]);
    const broken = mutate(responseFor(target, [{ geometries: [GROWN] }]));

    expect(validateOffsetResponse(target.request, broken)).not.toBeNull();
    const outcome = offsetOutcome(target, broken);
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error).toMatch(/No se modificó nada/);
  });

  it("una línea con offset interior máximo se rechaza (no tiene interior)", () => {
    const target = plan([ln]);

    const response = responseFor(target, [{ geometries: [GROWN], maxInwardOffset: 5 }]);

    expect(validateOffsetResponse(target.request, response)).toMatch(/offset interior máximo/);
  });

  it("una pieza menor que la tolerancia² se descarta y se cuenta; si no queda ninguna, el objeto colapsa", () => {
    const target = plan([r1], { toleranceMm: 1 }); // tolerancia 2 u -> área mínima 4 u²
    const sliver = poly(ring(0, 0, 1)); // 1 u² < 4

    const kept = offsetOutcome(target, responseFor(target, [{ geometries: [GROWN, sliver], piecesBefore: 1 }]));
    expect(kept.ok && kept.outcome.objects[0].shapes).toHaveLength(1);
    expect(kept.ok && kept.outcome.discarded).toBe(1);

    const gone = offsetOutcome(target, responseFor(target, [{ geometries: [sliver] }]));
    expect(gone.ok && gone.outcome.objects[0].collapsed).toBe(true);
    expect(gone.ok && gone.outcome.allCollapsed).toBe(true);
  });

  it("agrega los subpaths de un objeto sin relleno: un objeto = un resultado aunque tenga varios contornos", () => {
    const twoStrokes = line("two", "A", 0, 0, 10, 0);
    const compound = { ...twoStrokes, d: "M0 0 L10 0 M0 20 L10 20" };
    const state = stateOf({ A: [compound], B: [], C: [], D: [] }, LAYERS);
    const target = plan([compound], {}, state);

    const result = offsetOutcome(target, responseFor(target, [{ geometries: [GROWN] }, { geometries: [poly(ring(0, 18, 12, 4))] }]));

    expect(target.request.subjects).toHaveLength(2);
    expect(target.owners).toEqual([0, 0]);
    expect(result.ok && result.outcome.objects).toHaveLength(1);
    expect(result.ok && result.outcome.objects[0].shapes).toHaveLength(2);
    expect(result.ok && result.outcome.objects[0].divided).toBe(false); // dos contornos no son una división
  });
});

// ---- Colapso, división, huecos ----

describe("colapso, división y huecos: nada en silencio", () => {
  const two = () => plan([r1, r2], { direction: "inside" });

  it("TODOS colapsan: no hay nada que aplicar, Apply bloqueado con la explicación y el máximo interior sugerido", () => {
    const target = two();
    const response = responseFor(target, [{ geometries: [], maxInwardOffset: 10 }, { geometries: [], maxInwardOffset: 20 }]);
    const outcome = offsetOutcome(target, response);
    if (!outcome.ok) throw new Error(outcome.error);

    expect(outcome.outcome.allCollapsed).toBe(true);
    expect(outcome.outcome.needsConfirmation).toBe(false);
    expect(outcome.outcome.collapsedCount).toBe(2);
    // El menor máximo interior (10 u = 5 mm): por debajo de él no colapsa ninguno.
    expect(offsetApplyBlock(target, outcome.outcome, false)).toBe("Todos los objetos colapsan con este offset (máximo interior ≈ 5 mm). Reducí el offset o elegí Exterior.");
    expect(offsetApplyBlock(target, outcome.outcome, true)).not.toBeNull(); // confirmar no cambia nada: no hay qué aplicar
    expect(offsetReadyText(target, outcome.outcome)).toMatch(/Todos los objetos colapsan con este offset \(máximo interior ≈ 5 mm\): no hay nada que aplicar/);
    const application = apply(target, response, true);
    expect(application.ok).toBe(false);
    expect(!application.ok && application.code).toBe("all_collapsed");
  });

  it("un solo objeto que colapsa lo dice en singular", () => {
    const target = plan([r1], { direction: "inside" });
    const outcome = offsetOutcome(target, responseFor(target, [{ geometries: [], maxInwardOffset: 10 }]));
    if (!outcome.ok) throw new Error(outcome.error);

    expect(offsetApplyBlock(target, outcome.outcome, false)).toMatch(/^El objeto colapsa con este offset/);
  });

  it("ALGUNOS colapsan: hace falta la confirmación explícita; sin ella no se aplica nada", () => {
    const target = two();
    const response = responseFor(target, [{ geometries: [SHRUNK], maxInwardOffset: 10 }, { geometries: [], maxInwardOffset: 3 }]);
    const outcome = offsetOutcome(target, response);
    if (!outcome.ok) throw new Error(outcome.error);

    expect(outcome.outcome.allCollapsed).toBe(false);
    expect(outcome.outcome.collapsedCount).toBe(1);
    expect(outcome.outcome.needsConfirmation).toBe(true);
    expect(offsetApplyBlock(target, outcome.outcome, false)).toMatch(/1 objeto colapsa o pierde piezas: confirmá que se aplica solo a los demás, o ajustá el valor/);
    expect(offsetApplyBlock(target, outcome.outcome, true)).toBeNull();
    expect(offsetConfirmText(outcome.outcome)).toBe("Entiendo que 1 objeto colapsa y no se modifica: aplicar solo a los demás.");

    const withoutConfirm = apply(target, response, false);
    expect(withoutConfirm.ok).toBe(false);
    expect(!withoutConfirm.ok && withoutConfirm.code).toBe("confirmation_required");
    expect(!withoutConfirm.ok && withoutConfirm.error).toMatch(/No se modificó nada/);
    expect("production" in withoutConfirm).toBe(false);
    expect(apply(target, response, true).ok).toBe(true);
  });

  it("el máximo interior sugerido sale del menor de los objetos que colapsan, convertido a mm", () => {
    const target = two();
    const response = responseFor(target, [{ geometries: [], maxInwardOffset: 30 }, { geometries: [], maxInwardOffset: 8 }]);
    const outcome = offsetOutcome(target, response);
    if (!outcome.ok) throw new Error(outcome.error);

    expect(outcome.outcome.maxInwardUnits).toBe(8);
    expect(offsetWarnings(target, outcome.outcome)[0].text).toBe("2 objetos colapsan con este offset (máximo interior ≈ 4 mm): desaparecen y no se modifican.");
  });

  it("sin escala física el máximo interior se sugiere en unidades, nunca en mm inventados", () => {
    const target = plan([r1, r2], { direction: "inside", mmFactor: null });
    const outcome = offsetOutcome(target, responseFor(target, [{ geometries: [], maxInwardOffset: 10 }, { geometries: [SHRUNK] }]));
    if (!outcome.ok) throw new Error(outcome.error);

    expect(offsetWarnings(target, outcome.outcome)[0].text).toMatch(/máximo interior ≈ 10 u\)/);
  });

  it("un objeto que pierde piezas pero no todas también pide confirmación (no solo el que desaparece entero)", () => {
    const target = plan([r1], { direction: "inside" });
    const response = responseFor(target, [{ geometries: [SHRUNK], piecesBefore: 2, lostPieces: 1 }]);
    const outcome = offsetOutcome(target, response);
    if (!outcome.ok) throw new Error(outcome.error);

    expect(outcome.outcome.partialCount).toBe(1);
    expect(outcome.outcome.collapsedCount).toBe(0);
    expect(outcome.outcome.needsConfirmation).toBe(true);
    expect(offsetWarnings(target, outcome.outcome).map((warning) => warning.kind)).toEqual(["partial"]);
    expect(offsetConfirmText(outcome.outcome)).toBe("Entiendo que 1 objeto pierde piezas pequeñas: aplicar solo a los demás.");
    expect(apply(target, response, false).ok).toBe(false);
    expect(apply(target, response, true).ok).toBe(true);
  });

  it("la división se informa con cuántas piezas, pero no necesita confirmación (no se pierde nada)", () => {
    const target = plan([r1], { direction: "inside" });
    const response = responseFor(target, [{ geometries: [poly(ring(3, 3, 5)), poly(ring(12, 3, 5))] }]);
    const outcome = offsetOutcome(target, response);
    if (!outcome.ok) throw new Error(outcome.error);

    expect(outcome.outcome.dividedCount).toBe(1);
    expect(outcome.outcome.dividedPieces).toBe(2);
    expect(outcome.outcome.needsConfirmation).toBe(false);
    expect(offsetWarnings(target, outcome.outcome)).toEqual([{ kind: "split", text: "1 objeto se divide en 2 piezas." }]);
    expect(offsetApplyBlock(target, outcome.outcome, false)).toBeNull();
  });

  it("dos piezas que ya eran dos antes del offset NO cuentan como división; tres sí", () => {
    const target = plan([r1], { direction: "inside" });
    const pieces = [poly(ring(3, 3, 5)), poly(ring(12, 3, 5))];

    const already = offsetOutcome(target, responseFor(target, [{ geometries: pieces, piecesBefore: 2 }]));
    expect(already.ok && already.outcome.dividedCount).toBe(0);

    const split = offsetOutcome(target, responseFor(target, [{ geometries: [...pieces, poly(ring(30, 3, 5))], piecesBefore: 2 }]));
    expect(split.ok && split.outcome.dividedCount).toBe(1);
  });

  it("perder y ganar huecos se informa (un hueco que se cierra, o una abertura que se cierra y deja uno)", () => {
    const lost = plan([r1]);
    const lostOutcome = offsetOutcome(lost, responseFor(lost, [{ geometries: [GROWN], holesBefore: 2, holesAfter: 0 }]));
    if (!lostOutcome.ok) throw new Error(lostOutcome.error);
    expect(offsetWarnings(lost, lostOutcome.outcome)).toEqual([{ kind: "holes_lost", text: "1 objeto pierde huecos (se cierran o se funden)." }]);

    const gained = offsetOutcome(lost, responseFor(lost, [{ geometries: [poly(ring(-4, -4, 28), ring(2, 2, 4))], holesBefore: 0 }]));
    if (!gained.ok) throw new Error(gained.error);
    expect(offsetWarnings(lost, gained.outcome)).toEqual([{ kind: "holes_gained", text: "1 objeto gana huecos (una abertura estrecha se cierra)." }]);
  });

  it("sin nada para avisar, no hay advertencias", () => {
    const target = plan([r1]);
    const outcome = offsetOutcome(target, responseFor(target, [{ geometries: [GROWN] }]));
    if (!outcome.ok) throw new Error(outcome.error);

    expect(offsetWarnings(target, outcome.outcome)).toEqual([]);
    expect(offsetReadyText(target, outcome.outcome)).toBe("Resultado: 1 pieza a partir de 1 objeto.");
    expect(offsetApplyBlock(target, outcome.outcome, false)).toBeNull();
  });

  it("antes de tener resultado, Apply está bloqueado (esperando al servidor); con un destino explícito inválido, por el destino", () => {
    expect(offsetApplyBlock(plan([r1]), null, false)).toBe("Esperando el resultado del servidor…");
    const noTarget = plan([r1], { targetLayer: { kind: "layer", groupId: "D" } });
    expect(offsetApplyBlock(noTarget, null, false)).toMatch(/«Naranja» está bloqueada/);
  });
});

// ---- Aplicar ----

describe("aplicar: capa, originales y un comando atómico", () => {
  it("por defecto CONSERVA el original y agrega el contorno nuevo justo encima de su objeto, en su capa, con su color y sin matriz", () => {
    const target = plan([r1]);
    const ids = idFactory();

    const application = ok(apply(target, responseFor(target, [{ geometries: [GROWN] }]), false, DOC, ids.next));

    expect(Object.keys(application.production.layers)).toEqual(["A"]);
    const layerA = application.production.layers.A;
    expect(idsOf(layerA)).toEqual(["r1", "n1", "r2", "ln"]); // el nuevo, justo encima de r1
    expect(layerA[0]).toBe(r1); // el original, intacto (misma referencia)
    expect(layerA[1]).toEqual({ id: "n1", layerGroupId: "A", d: "M-4 -4 L24 -4 L24 24 L-4 24 Z", fill: "#ff0000", matrix: IDENTITY_MATRIX });
    expect(application.production.atomic).toBe(true);
    expect(application.production.layerMetas).toBeUndefined();
    expect(application.resultIds).toEqual(["n1"]);
    expect(application.activeGroupId).toBe("A");
    expect(application.summary).toMatchObject({ removed: 0, keepOriginals: true, resultCount: 1, processedCount: 1, collapsedCount: 0 });
  });

  it("«Reemplazar» saca el original y el contorno nuevo ocupa su lugar", () => {
    const target = plan([r1], { keepOriginals: false });

    const application = ok(apply(target, responseFor(target, [{ geometries: [GROWN] }])));

    expect(idsOf(application.production.layers.A)).toEqual(["n1", "r2", "ln"]);
    expect(application.summary.removed).toBe(1);
  });

  it("cada resultado va a la capa de SU objeto, con el color de ESA capa, sin tocar las demás", () => {
    const target = plan([r1, b1]);
    const response = responseFor(target, [{ geometries: [GROWN] }, { geometries: [poly(ring(196, -4, 28))] }]);

    const application = ok(apply(target, response));

    expect(Object.keys(application.production.layers).sort()).toEqual(["A", "B"]);
    expect(application.production.layers.A.find((object) => object.id === "n1")).toMatchObject({ layerGroupId: "A", fill: "#ff0000" });
    expect(application.production.layers.B.find((object) => object.id === "n2")).toMatchObject({ layerGroupId: "B", fill: "#0000ff" });
    expect(idsOf(application.production.layers.B)).toEqual(["b1", "n2"]);
    expect(application.summary.targets.map((entry) => [entry.name, entry.count])).toEqual([["Rojo", 1], ["Azul", 1]]);
  });

  it("una pieza disjunta es un objeto nuevo con id nuevo (los huecos van como subpaths del mismo)", () => {
    const target = plan([r1], { direction: "inside" });
    const response = responseFor(target, [{ geometries: [poly(ring(3, 3, 5)), poly(ring(12, 3, 5), ring(13, 4, 1))] }]);
    const ids = idFactory("p");

    const application = ok(apply(target, response, false, DOC, ids.next));

    expect(idsOf(application.production.layers.A)).toEqual(["r1", "p1", "p2", "r2", "ln"]);
    expect(application.production.layers.A[2].d).toBe("M12 3 L17 3 L17 8 L12 8 Z M13 4 L14 4 L14 5 L13 5 Z");
    expect(ids.calls).toBe(2);
    expect(application.summary.dividedCount).toBe(1);
  });

  it("los ids nuevos son siempre distintos de los existentes y entre sí (una llamada de createId por pieza)", () => {
    const target = plan([r1, r2]);
    const response = responseFor(target, [{ geometries: [GROWN] }, { geometries: [GROWN, GROWN] }]);

    const application = ok(apply(target, response));
    const all = Object.values(application.production.layers).flat().map((object) => object.id);

    expect(new Set(all).size).toBe(all.length);
    expect(application.resultIds).toHaveLength(3);
  });

  it("OTRA capa destino explícita: los resultados van al tope de esa capa con SU color; el original (o su ausencia) sigue la regla de conservar", () => {
    const target = plan([r1, b1], { targetLayer: { kind: "layer", groupId: "C" }, keepOriginals: false });
    const response = responseFor(target, [{ geometries: [GROWN] }, { geometries: [poly(ring(196, -4, 28))] }]);

    const application = ok(apply(target, response));

    expect(idsOf(application.production.layers.C)).toEqual(["n1", "n2"]);
    expect(application.production.layers.C.every((object) => object.fill === "#00ff00" && object.layerGroupId === "C")).toBe(true);
    expect(idsOf(application.production.layers.A)).toEqual(["r2", "ln"]); // Reemplazar: los originales salieron
    expect(idsOf(application.production.layers.B)).toEqual([]);
    expect(application.activeGroupId).toBe("C");
  });

  it("destino explícito = la capa de uno de los objetos: ese objeto lo tiene justo encima y los de otras capas van al tope", () => {
    const target = plan([r1, b1], { targetLayer: { kind: "layer", groupId: "A" } });
    const response = responseFor(target, [{ geometries: [GROWN] }, { geometries: [poly(ring(196, -4, 28))] }]);

    const application = ok(apply(target, response));

    expect(idsOf(application.production.layers.A)).toEqual(["r1", "n1", "r2", "ln", "n2"]);
    expect(Object.keys(application.production.layers)).toEqual(["A"]);
  });

  it("capa nueva con un color: viaja en el MISMO comando (layerMetas) y el resultado toma su color", () => {
    const target = plan([r1], { targetLayer: { kind: "new", hex: "#112233", groupId: "NEW" } });

    const application = ok(apply(target, responseFor(target, [{ geometries: [GROWN] }])));

    expect(application.production.layerMetas).toHaveLength(1);
    expect(application.production.layerMetas![0]).toMatchObject({ groupId: "NEW", colorHex: "#112233", isNew: true });
    expect(application.production.layers.NEW[0]).toMatchObject({ layerGroupId: "NEW", fill: "#112233" });
    expect(application.summary.targets[0]).toMatchObject({ groupId: "NEW", created: true });
    expect(offsetNotice(application.summary)).toMatch(/\(capa nueva, sin guardar todavía\)/);
  });

  it("un destino explícito inválido NO se resuelve en silencio: no se aplica", () => {
    const target = plan([r1], { targetLayer: { kind: "layer", groupId: "D" } });

    const application = apply(target, responseFor(target, [{ geometries: [GROWN] }]));

    expect(application.ok).toBe(false);
    expect(!application.ok && application.code).toBe("target_required");
  });

  it("si el destino explícito se bloquea después de planear, se rechaza (no se escribe en una capa bloqueada)", () => {
    const target = plan([r1], { targetLayer: { kind: "layer", groupId: "C" } });
    const lockedNow = stateOf(DOC.objectsByLayer, LAYERS.map((layer) => (layer.groupId === "C" ? { ...layer, locked: true } : layer)));

    const application = apply(target, responseFor(target, [{ geometries: [GROWN] }]), false, lockedNow);

    expect(!application.ok && application.code).toBe("blocked");
    expect(!application.ok && application.error).toMatch(/«Verde» está bloqueada/);
  });

  it("si la capa de origen se bloquea u oculta después de planear, se rechaza la operación completa", () => {
    const target = plan([r1, b1]);
    const response = responseFor(target, [{ geometries: [GROWN] }, { geometries: [GROWN] }]);

    const locked = apply(target, response, false, stateOf(DOC.objectsByLayer, LAYERS.map((layer) => (layer.groupId === "B" ? { ...layer, locked: true } : layer))));
    const hidden = apply(target, response, false, stateOf(DOC.objectsByLayer, LAYERS.map((layer) => (layer.groupId === "A" ? { ...layer, visible: false } : layer))));

    expect(!locked.ok && locked.code).toBe("blocked");
    expect(!hidden.ok && hidden.code).toBe("blocked");
  });

  it("si el documento cambió mientras se calculaba (otra referencia), el resultado se descarta", () => {
    const target = plan([r1]);
    const response = responseFor(target, [{ geometries: [GROWN] }]);
    const edited = stateOf({ ...DOC.objectsByLayer, A: [{ ...r1 }, r2, ln] }, LAYERS);

    const application = apply(target, response, false, edited);

    expect(!application.ok && application.code).toBe("stale");
  });

  it("una respuesta incoherente no se aplica: invalid_response", () => {
    const target = plan([r1]);

    const application = apply(target, { ...responseFor(target, [{ geometries: [GROWN] }]), distance: 99 });

    expect(!application.ok && application.code).toBe("invalid_response");
  });

  it("un objeto que COLAPSA no se toca aunque se pida «Reemplazar»: sigue en su capa y no recibe nada", () => {
    const target = plan([r1, r2], { direction: "inside", keepOriginals: false });
    const response = responseFor(target, [{ geometries: [SHRUNK] }, { geometries: [], maxInwardOffset: 3 }]);

    const application = ok(apply(target, response, true));

    expect(idsOf(application.production.layers.A)).toEqual(["n1", "r2", "ln"]); // r1 reemplazado; r2 (colapsó) intacto
    expect(application.production.layers.A[1]).toBe(r2);
    expect(application.summary).toMatchObject({ collapsedCount: 1, processedCount: 1, removed: 1, resultCount: 1 });
    expect(application.resultIds).toEqual(["n1"]);
  });

  it("con «Conservar original» el que colapsa tampoco recibe nada y el resumen lo cuenta", () => {
    const target = plan([r1, r2], { direction: "inside" });

    const application = ok(apply(target, responseFor(target, [{ geometries: [], maxInwardOffset: 3 }, { geometries: [SHRUNK] }]), true));

    expect(idsOf(application.production.layers.A)).toEqual(["r1", "r2", "n1", "ln"]);
    expect(offsetNotice(application.summary)).toMatch(/1 objeto colapsó y no se modificó/);
  });

  it("una línea abierta se convierte en el contorno relleno alrededor de ella, con el color de su capa", () => {
    const target = plan([ln], { keepOriginals: false });
    const band = poly([[-2, 48], [32, 48], [32, 52], [-2, 52], [-2, 48]]);

    const application = ok(apply(target, responseFor(target, [{ geometries: [band] }])));

    expect(idsOf(application.production.layers.A)).toEqual(["r1", "r2", "n1"]);
    expect(application.production.layers.A[2]).toMatchObject({ fill: "#ff0000", matrix: IDENTITY_MATRIX });
    expect(application.production.layers.A[2].stroke).toBeUndefined();
    expect(application.summary.onlyLines).toBe(true);
    expect(offsetLabel(application.summary)).toMatch(/^Offset a ambos lados 2 mm/);
  });

  it("es DETERMINISTA: la misma respuesta y los mismos ids dan exactamente la misma producción", () => {
    const target = plan([r1, b1]);
    const response = responseFor(target, [{ geometries: [GROWN] }, { geometries: [GROWN] }]);

    expect(apply(target, response, false, DOC, idFactory().next)).toEqual(apply(target, response, false, DOC, idFactory().next));
  });

  it("no muta el documento ni la respuesta", () => {
    const target = plan([r1]);
    const response = responseFor(target, [{ geometries: [GROWN] }]);
    const before = JSON.stringify([DOC, response]);

    ok(apply(target, response));

    expect(JSON.stringify([DOC, response])).toBe(before);
  });

  it("etiqueta y aviso: describen dirección, valor, objetos, capa y qué no se pudo hacer", () => {
    const target = plan([r1, r2], { direction: "inside", distance: 1.5 });
    const response = responseFor(target, [{ geometries: [poly(ring(3, 3, 5)), poly(ring(12, 3, 5))], holesBefore: 1, holesAfter: 0 }, { geometries: [] }]);
    const application = ok(apply(target, response, true));

    expect(offsetLabel(application.summary)).toBe("Offset interior 1.5 mm (1 objeto → 2 piezas)");
    const notice = offsetNotice(application.summary);
    expect(notice).toMatch(/^Offset interior de 1.5 mm aplicado: 1 objeto → 2 piezas en «Rojo»\./);
    expect(notice).toMatch(/Los originales se conservaron\./);
    expect(notice).toMatch(/1 objeto colapsó y no se modificó\./);
    expect(notice).toMatch(/1 objeto se dividió en 2 piezas\./);
    expect(notice).toMatch(/1 objeto perdió huecos\./);
  });
});

// ---- Errores del servidor ----

describe("errores del servidor en lenguaje de usuario", () => {
  const withCode = (code: string, status = 400) => ({ status, body: { code, message: "x" } });

  it("los códigos propios del offset tienen su mensaje y siempre dicen que no se modificó nada", () => {
    for (const code of ["invalid_distance", "unknown_join_style", "unknown_cap_style", "invalid_mitre_limit", "timeout", "too_many_subjects", "too_many_vertices", "payload_too_large"]) {
      expect(offsetErrorMessage(withCode(code))).toMatch(/No se modificó nada/);
    }
    expect(offsetErrorMessage(withCode("invalid_distance"))).toMatch(/distancia/);
    expect(offsetErrorMessage(withCode("timeout", 504))).toMatch(/menos objetos/);
    expect(offsetErrorMessage(withCode("too_many_subjects"))).not.toMatch(/trazo/); // no habla del pincel de Erase
  });

  it("sin código, el estado HTTP decide; lo demás cae a los mensajes comunes del servicio de geometría", () => {
    expect(offsetErrorMessage({ status: 504 })).toMatch(/tardó demasiado/);
    expect(offsetErrorMessage({ status: 413 })).toMatch(/demasiado grande/);
    expect(offsetErrorMessage(withCode("engine_unavailable", 503))).toMatch(/motor de geometría no está disponible/);
    expect(offsetErrorMessage({ isNetworkError: true })).toMatch(/No se pudo contactar/);
    expect(offsetErrorMessage({ isAborted: true })).toMatch(/cancelada/);
    expect(offsetErrorMessage(undefined)).toMatch(/No se modificó nada/);
  });
});
