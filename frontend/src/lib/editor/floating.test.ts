import { describe, expect, it } from "vitest";
import type { BridgeRequest, BridgeResponse, BridgeResultItem, FloatingComponent, FloatingResponse, GeometryPoint, PolygonGeometry } from "../../types/geometry";
import { IDENTITY_MATRIX } from "../svgTransform";
import {
  analysisSummary,
  applyBridgeResult,
  boundsRect,
  bridgeApplyBlock,
  bridgeInputs,
  bridgeLabel,
  bridgeNotice,
  bridgeOutcome,
  bridgeReadyText,
  bridgeReasonText,
  bridgeWarnings,
  DEFAULT_BRIDGE_WIDTH_MM,
  draftsFromSuggestions,
  floatingAnalysis,
  floatingErrorMessage,
  floatingScope,
  floatingScopeText,
  issueDescription,
  MAX_BRIDGE_WIDTH_MM,
  MAX_BRIDGES,
  MIN_BRIDGE_WIDTH_MM,
  planBridges,
  planFloating,
  reanalysisText,
  snapToIssue,
  validateBridgeResponse,
  validateFloatingResponse,
  type BridgeDraft,
  type BridgePlan,
  type FloatingAnalysis,
  type FloatingPlan,
} from "./floating";
import type { EditableDocument, EditableLayerMeta, EditorObject } from "./types";

// ---- Fixtures ----

function meta(groupId: string, overrides: Partial<EditableLayerMeta> = {}): EditableLayerMeta {
  return { groupId, name: `Capa ${groupId}`, colorHex: "#ff0000", order: 0, visible: true, locked: false, manufacturingOperation: "cut", isNew: false, ...overrides };
}

function rect(id: string, layerGroupId: string, x: number, y: number, w: number, h = w, overrides: Partial<EditorObject> = {}): EditorObject {
  return { id, layerGroupId, d: `M${x} ${y} H${x + w} V${y + h} H${x} Z`, fill: "#ff0000", matrix: IDENTITY_MATRIX, ...overrides };
}

/** Anillo cuadrado de lado `w` con un hueco centrado de lado `w / 2` (el hueco es la isla en Plantilla). */
function ringObject(id: string, layerGroupId: string, x: number, y: number, w: number, overrides: Partial<EditorObject> = {}): EditorObject {
  const hole = w / 4;
  return {
    id,
    layerGroupId,
    d: `M${x} ${y} H${x + w} V${y + w} H${x} Z M${x + hole} ${y + hole} H${x + w - hole} V${y + w - hole} H${x + hole} Z`,
    fill: "#ff0000",
    matrix: IDENTITY_MATRIX,
    ...overrides,
  };
}

function line(id: string, layerGroupId: string, d: string): EditorObject {
  return { id, layerGroupId, d, fill: "none", stroke: "#00aa00", strokeWidth: 0.5, matrix: IDENTITY_MATRIX };
}

function stateOf(objectsByLayer: Record<string, EditorObject[]>, layers: EditableLayerMeta[]): EditableDocument {
  return { objectsByLayer, layers };
}

// Capa A «Rojo» (CUT): o1 = anillo 0..40 con hueco 10..30, o2 = cuadrado macizo 100..140 y una línea abierta. Capa B «Azul» (CUT): o3 = anillo 200..240 con hueco 210..230.
// Capa C «Gris» (CUT, BLOQUEADA): o4 = anillo 0..40 x 200..240. Capa D «Oculta» (CUT, oculta): h1. Capa E «Grabado» (engrave): e1.
const o1 = ringObject("o1", "A", 0, 0, 40);
const o2 = rect("o2", "A", 100, 100, 40);
const ln = line("ln", "A", "M200 20 L260 20");
const o3 = ringObject("o3", "B", 200, 0, 40, { fill: "#0000ff" });
const o4 = ringObject("o4", "C", 0, 200, 40, { fill: "#888888" });
const h1 = rect("h1", "D", 0, 300, 40);
const e1 = rect("e1", "E", 300, 300, 20);
const LAYERS = [
  meta("A", { name: "Rojo", order: 0 }),
  meta("B", { name: "Azul", order: 1, colorHex: "#0000ff" }),
  meta("C", { name: "Gris", order: 2, locked: true, colorHex: "#888888" }),
  meta("D", { name: "Oculta", order: 3, visible: false }),
  meta("E", { name: "Grabado", order: 4, manufacturingOperation: "engrave" }),
];
const DOC = stateOf({ A: [o1, o2, ln], B: [o3], C: [o4], D: [h1], E: [e1] }, LAYERS);
const MM = 0.5; // mm por unidad de documento
const TOL = 0.02; // 0,01 mm / 0,5

const closed = (x: number, y: number, w: number, h = w): GeometryPoint[] => [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
const poly = (...rings: GeometryPoint[][]): PolygonGeometry => ({ type: "polygon", coordinates: rings });

function plan(selection: EditorObject[] = [], mode: "stencil" | "parts" = "stencil", document: EditableDocument = DOC): FloatingPlan {
  const result = planFloating(selection, document, { mode, mmFactor: MM });
  if (!result.ok) throw new Error(`se esperaba un plan y fue ${result.reason}: ${result.message}`);
  return result.plan;
}

/** Componente flotante de la hoja: id 0. */
const SHEET: FloatingComponent = { id: 0, kind: "principal", depth: 0, parent: null, polygon: null, area: null, bounds: [0, 0, 240, 240], subjects: [] };

/** Una isla por cada hueco del plan (un hueco por anillo `ringObject`): hueco = cuarto del lado centrado. */
function islandOf(id: number, parent: number, x: number, y: number, w: number, subjects: number[], depth = 1): FloatingComponent {
  return { id, kind: "floating", depth, parent, polygon: poly(closed(x, y, w)), area: w * w, bounds: [x, y, x + w, y + w], subjects };
}

/** Respuesta del análisis del plan por defecto (stencil): subjects o1 (0), o2 (1), o3 (2), o4 (3, bloqueado) -> 3 islas: o1, o3 y o4. */
function analysisResponseFor(target: FloatingPlan, components?: FloatingComponent[]): FloatingResponse {
  const list = components ?? [SHEET, islandOf(1, 0, 10, 10, 20, [0]), islandOf(2, 0, 210, 10, 20, [2]), islandOf(3, 0, 10, 210, 20, [3])];
  return {
    mode: target.mode,
    tolerance: target.request.tolerance,
    components: list,
    floatingCount: list.filter((component) => component.kind === "floating").length,
    mainCount: list.filter((component) => component.kind === "principal").length,
    discarded: 0,
  };
}

function analysisOf(target: FloatingPlan, response = analysisResponseFor(target)): FloatingAnalysis {
  const result = floatingAnalysis(target, response);
  if (!result.ok) throw new Error(result.error);
  return result.analysis;
}

const point = (x: number, y: number) => ({ x, y });

function bridgePlanOf(target: FloatingPlan, analysis: FloatingAnalysis, drafts: BridgeDraft[] | null = null, widthMm = DEFAULT_BRIDGE_WIDTH_MM): BridgePlan {
  const result = planBridges(target, analysis, drafts, widthMm);
  if (!result.ok) throw new Error(`se esperaba un plan de bridges y fue ${result.reason}`);
  return result.plan;
}

const draft = (key: string, island: number | null, anchor: { x: number; y: number } | null = null, direction: { x: number; y: number } | null = null): BridgeDraft => ({ key, island, anchor, direction });

/** Un bridge válido sobre `island` que cruza 10 de hueco con 1,6 u de ancho (0,8 mm): quita 16 u². */
function bridgeItem(index: number, island: number, overrides: Partial<BridgeResultItem> = {}): BridgeResultItem {
  return {
    index,
    suggested: false,
    valid: true,
    reason: null,
    island,
    anchor: point(30, 20),
    direction: point(1, 0),
    width: 1.6,
    length: 10,
    area: 16,
    reduces: true,
    affects: [0],
    polygon: poly(closed(29.96, 19.2, 10.08, 1.6)),
    ...overrides,
  };
}

/** C abierta: el anillo exterior de o1 con la muesca del bridge (un solo anillo cerrado, 12 vértices + cierre). */
const OPENED_O1 = poly([[0, 0], [40, 0], [40, 19.2], [30, 19.2], [30, 10], [10, 10], [10, 30], [30, 30], [30, 20.8], [40, 20.8], [40, 40], [0, 40], [0, 0]]);

function bridgeResponseFor(target: BridgePlan, items: BridgeResultItem[], changed: Record<number, PolygonGeometry[]> = {}, reanalysis = { floatingBefore: 3, floatingAfter: 2, mainAfter: 1 }): BridgeResponse {
  const results = target.request.subjects.map((_, index) => ({ subjectIndex: index, changed: index in changed, geometries: changed[index] ?? [] }));
  return {
    mode: target.request.mode,
    tolerance: target.request.tolerance,
    bridges: items,
    results,
    reanalysis,
    pieceCount: results.reduce((total, item) => total + item.geometries.length, 0),
  };
}

/** Plan y respuesta válidos de un bridge manual sobre la isla 1 (o1, subject 0). */
function validBridge(overrides: { items?: BridgeResultItem[]; changed?: Record<number, PolygonGeometry[]>; reanalysis?: { floatingBefore: number; floatingAfter: number; mainAfter: number } } = {}) {
  const base = plan();
  const analysis = analysisOf(base);
  const target = bridgePlanOf(base, analysis, [draft("m1", 1, point(30, 20))]);
  const response = bridgeResponseFor(target, overrides.items ?? [bridgeItem(0, 1)], overrides.changed ?? { 0: [OPENED_O1] }, overrides.reanalysis);
  return { base, analysis, target, response };
}

function idFactory(prefix = "n") {
  let counter = 0;
  return { next: () => `${prefix}${(counter += 1)}`, get calls() { return counter; } };
}

// ---- Alcance ----

describe("floatingScope", () => {
  it("sin selección: los objetos CON RELLENO de las capas CUT visibles, bloqueadas incluidas (cuentan, no se modifican), en orden de pintado", () => {
    const scope = floatingScope([], DOC);

    expect(scope.kind).toBe("cut-layers");
    expect(scope.objects.map((object) => object.id)).toEqual(["o1", "o2", "o3", "o4"]);
    expect(scope.lockedCount).toBe(1);
    expect(scope.layerNames).toEqual(["Rojo", "Azul", "Gris"]);
  });

  it("las capas ocultas no cuentan (se informan), las que no son CUT no entran y las líneas abiertas se omiten contadas", () => {
    const scope = floatingScope([], DOC);

    expect(scope.objects.map((object) => object.id)).not.toContain("h1"); // capa CUT oculta
    expect(scope.objects.map((object) => object.id)).not.toContain("e1"); // capa de grabado
    expect(scope.hiddenCutLayers).toEqual(["Oculta"]);
    expect(scope.unfilledOmitted).toBe(1); // la línea de la capa A
  });

  it("con selección: solo esos objetos (aunque su capa no sea CUT), los de capas ocultas no cuentan y las líneas se omiten; un id viejo se ignora", () => {
    const scope = floatingScope([e1, h1, ln, o4, { ...o1, id: "fantasma" }], DOC);

    expect(scope.kind).toBe("selection");
    expect(scope.objects.map((object) => object.id)).toEqual(["o4", "e1"]); // orden de pintado: capa C antes que E
    expect(scope.hiddenOmitted).toBe(1);
    expect(scope.unfilledOmitted).toBe(1);
    expect(scope.lockedCount).toBe(1);
    expect(scope.layerNames).toEqual([]);
  });

  it("sin capas con operación CUT visibles el alcance queda vacío", () => {
    const doc = stateOf({ A: [o1] }, [meta("A", { manufacturingOperation: "unassigned" })]);

    expect(floatingScope([], doc).objects).toEqual([]);
  });

  it("describe el alcance por escrito: capas y cantidad, bloqueados que cuentan y ocultos que no", () => {
    expect(floatingScopeText(floatingScope([], DOC))).toBe(
      "Capas CUT: Rojo, Azul, Gris (4 objetos). 1 objeto bloqueado cuenta para el análisis pero no se modifica. 1 capa CUT oculta no cuenta (Oculta). 1 línea abierta se omite (sin relleno).",
    );
    expect(floatingScopeText(floatingScope([o1, o3], DOC))).toBe("Selección: 2 objetos.");
    expect(floatingScopeText(floatingScope([o1], DOC))).toBe("Selección: 1 objeto.");
    expect(floatingScopeText(floatingScope([], stateOf({}, [meta("A", { manufacturingOperation: "ignore" })])))).toBe("Capas CUT: ninguna visible.");
  });
});

// ---- Plan del análisis ----

describe("planFloating", () => {
  it("arma la petición con las formas en unidades de documento (anillos), el bloqueo de cada una, el modo y la tolerancia convertida de mm", () => {
    const target = plan();

    expect(target.request.mode).toBe("stencil");
    expect(target.request.tolerance).toBeCloseTo(TOL, 12);
    expect(target.objects.map((object) => object.id)).toEqual(["o1", "o2", "o3", "o4"]);
    expect(target.request.subjects.map((subject) => subject.locked)).toEqual([false, false, false, true]);
    expect(target.request.subjects.map((subject) => subject.coordinates.length)).toEqual([2, 1, 2, 2]); // los anillos con hueco traen 2
    const [outer, hole] = target.request.subjects[0].coordinates;
    expect(Math.max(...outer.map((p) => p[0]))).toBe(40);
    expect(Math.min(...hole.map((p) => p[0]))).toBe(10);
    expect(target.skippedInvalid).toBe(0);
    expect(target.names).toEqual(["Rojo · objeto 1", "Rojo · objeto 2", "Azul · objeto 1", "Gris · objeto 1"]);
    expect(target.scaleNotice).toBeNull();
  });

  it("el modo viaja tal cual", () => {
    expect(plan([], "parts").request.mode).toBe("parts");
  });

  it("sin escala física opera en unidades y lo avisa (la tolerancia son 0,01 u)", () => {
    const result = planFloating([], DOC, { mode: "stencil", mmFactor: null });

    expect(result.ok && result.plan.request.tolerance).toBeCloseTo(0.01, 12);
    expect(result.ok && result.plan.unit.label).toBe("u");
    expect(result.ok && result.plan.scaleNotice).toMatch(/Sin escala física/);
  });

  it("la clave de la petición cambia con el modo, con el contenido de un objeto y con el bloqueo; no con un objeto ajeno al alcance", () => {
    const base = plan().requestKey;

    expect(plan([], "parts").requestKey).not.toBe(base);
    expect(plan([], "stencil", stateOf({ ...DOC.objectsByLayer, A: [{ ...o1 }, o2, ln] }, LAYERS)).requestKey).not.toBe(base);
    expect(plan([], "stencil", stateOf(DOC.objectsByLayer, LAYERS.map((layer) => (layer.groupId === "A" ? { ...layer, locked: true } : layer)))).requestKey).not.toBe(base);
    expect(plan([], "stencil", stateOf({ ...DOC.objectsByLayer, E: [rect("e1", "E", 5, 5, 5)] }, LAYERS)).requestKey).toBe(base);
    expect(plan().requestKey).toBe(base);
  });

  it("rechaza con el motivo cuando no hay nada que analizar (selección sin relleno, capas CUT ocultas, ninguna capa CUT)", () => {
    const onlyLine = planFloating([ln], DOC, { mode: "stencil", mmFactor: MM });
    const hiddenCut = planFloating([], stateOf({ D: [h1] }, [LAYERS[3]]), { mode: "stencil", mmFactor: MM });
    const noCut = planFloating([], stateOf({ E: [e1] }, [LAYERS[4]]), { mode: "stencil", mmFactor: MM });

    expect(onlyLine).toMatchObject({ ok: false, reason: "no_targets" });
    expect(!onlyLine.ok && onlyLine.message).toMatch(/no tienen relleno.*No se modificó nada/);
    expect(!hiddenCut.ok && hiddenCut.message).toMatch(/Las capas CUT \(Oculta\) están ocultas/);
    expect(!noCut.ok && noCut.message).toMatch(/No hay capas con operación CUT visibles/);
  });

  it("omite e informa un objeto cuya geometría no se puede enviar; si no queda ninguno, rechaza", () => {
    const broken = rect("broken", "A", 0, 0, 10, 10, { d: "esto no es un path" });
    const mixed = planFloating([], stateOf({ A: [o1, broken] }, [LAYERS[0]]), { mode: "stencil", mmFactor: MM });
    const onlyBroken = planFloating([], stateOf({ A: [broken] }, [LAYERS[0]]), { mode: "stencil", mmFactor: MM });

    expect(mixed.ok && mixed.plan.skippedInvalid).toBe(1);
    expect(mixed.ok && mixed.plan.objects.map((object) => object.id)).toEqual(["o1"]);
    expect(onlyBroken).toMatchObject({ ok: false, reason: "invalid_geometry" });
  });

  it("rechaza más de 500 objetos antes de mandar nada", () => {
    const many = Array.from({ length: 501 }, (_, index) => rect(`m${index}`, "A", index * 3, 0, 2));
    const result = planFloating([], stateOf({ A: many }, [LAYERS[0]]), { mode: "stencil", mmFactor: MM });

    expect(result).toMatchObject({ ok: false, reason: "too_many" });
    expect(!result.ok && result.message).toMatch(/demasiados objetos \(501; el máximo es 500\)/);
  });
});

// ---- Validación de la respuesta del análisis ----

describe("validateFloatingResponse", () => {
  const target = plan();
  const valid = () => analysisResponseFor(target);
  const mutate = (change: (response: FloatingResponse) => void) => {
    const response = structuredClone(valid());
    change(response);
    return validateFloatingResponse(target.request, response);
  };

  it("acepta una respuesta coherente (la hoja sin polígono, las islas colgando de ella)", () => {
    expect(validateFloatingResponse(target.request, valid())).toBeNull();
  });

  it.each<[string, (response: FloatingResponse) => void]>([
    ["otro modo", (r) => void (r.mode = "parts")],
    ["tolerancia no positiva", (r) => void (r.tolerance = 0)],
    ["sin componentes", (r) => void (r.components = undefined as unknown as FloatingComponent[])],
    ["id fuera de posición", (r) => void (r.components[1].id = 5)],
    ["tipo desconocido", (r) => void ((r.components[1] as { kind: string }).kind = "rara")],
    ["flotante sin padre", (r) => void (r.components[1].parent = null)],
    ["padre que no es anterior", (r) => void (r.components[1].parent = 1)],
    ["profundidad que no es la del padre + 1", (r) => void (r.components[1].depth = 2)],
    ["principal con padre", (r) => void (r.components[0].parent = 1)],
    ["la hoja con polígono", (r) => void (r.components[0].polygon = poly(closed(0, 0, 5)))],
    ["la hoja con área", (r) => void (r.components[0].area = 10)],
    ["una isla sin polígono", (r) => void (r.components[1].polygon = null)],
    ["anillo sin cerrar", (r) => void (r.components[1].polygon = poly(closed(10, 10, 20).slice(0, 4)))],
    ["área cero", (r) => void (r.components[1].area = 0)],
    ["área nula", (r) => void (r.components[1].area = null)],
    ["bounds de largo 3", (r) => void (r.components[1].bounds = [0, 0, 1] as unknown as [number, number, number, number])],
    ["bounds invertidos", (r) => void (r.components[1].bounds = [30, 10, 10, 30])],
    ["bounds no finitos", (r) => void (r.components[1].bounds = [10, 10, Infinity, 30])],
    ["forma inexistente", (r) => void (r.components[1].subjects = [9])],
    ["formas repetidas", (r) => void (r.components[1].subjects = [0, 0])],
    ["formas desordenadas", (r) => void (r.components[1].subjects = [1, 0])],
    ["recuento de flotantes inventado", (r) => void (r.floatingCount = 5)],
    ["recuento de principales inventado", (r) => void (r.mainCount = 2)],
    ["descartados negativos", (r) => void (r.discarded = -1)],
  ])("rechaza: %s", (_label, change) => {
    expect(mutate(change)).not.toBeNull();
  });

  it("en Plantilla dos principales son incoherentes; la hoja tiene que ser el componente 0", () => {
    expect(mutate((r) => void (r.components[2] = { ...SHEET, id: 2 }))).not.toBeNull();
    expect(mutate((r) => void ([r.components[0], r.components[1]] = [r.components[1], r.components[0]]))).not.toBeNull();
  });

  it("en Piezas el principal es un cuerpo real: sin polígono es incoherente", () => {
    const parts = plan([], "parts");
    const response = analysisResponseFor(parts, [{ ...SHEET }]);

    expect(validateFloatingResponse(parts.request, response)).not.toBeNull();
    expect(validateFloatingResponse(parts.request, analysisResponseFor(parts, [{ ...SHEET, polygon: poly(closed(0, 0, 40)), area: 1600, bounds: [0, 0, 40, 40], subjects: [0] }]))).toBeNull();
  });
});

// ---- Issues ----

describe("floatingAnalysis", () => {
  it("una lista de issues en el orden del servidor: etiqueta, área en mm², bounding box, padre y los objetos que forman el borde", () => {
    const target = plan();
    const analysis = analysisOf(target);

    expect(analysis.issues.map((issue) => issue.label)).toEqual(["Isla 1", "Isla 2", "Isla 3"]);
    expect(analysis.issues.map((issue) => issue.id)).toEqual([1, 2, 3]);
    const first = analysis.issues[0];
    expect(first.area).toBeCloseTo(400 * MM * MM, 12); // 20 x 20 u = 10 x 10 mm = 100 mm²
    expect(first.rect).toEqual({ x: 10, y: 10, width: 20, height: 20 });
    expect(first.parentLabel).toBe("la hoja");
    expect(first.objectNames).toEqual(["Rojo · objeto 1"]);
    expect(first.d).toMatch(/^M10 10 L30 10 L30 30 L10 30 Z$/);
    expect(analysis.issues[2].objectNames).toEqual(["Gris · objeto 1"]);
    expect(analysis.mainCount).toBe(1);
  });

  it("en Piezas las etiquetas son «Pieza flotante n» y el padre es el cuerpo principal; las anidadas cuelgan de su pieza", () => {
    const parts = plan([], "parts");
    const body: FloatingComponent = { id: 0, kind: "principal", depth: 0, parent: null, polygon: poly(closed(0, 0, 40)), area: 1600, bounds: [0, 0, 40, 40], subjects: [0] };
    const analysis = analysisOf(parts, analysisResponseFor(parts, [body, islandOf(1, 0, 10, 10, 20, [1]), islandOf(2, 1, 15, 15, 5, [1], 2)]));

    expect(analysis.issues.map((issue) => [issue.label, issue.parentLabel, issue.depth])).toEqual([
      ["Pieza flotante 1", "el cuerpo principal", 1],
      ["Pieza flotante 2", "Pieza flotante 1", 2],
    ]);
  });

  it("la clave de un issue anidado cuelga de la isla que lo rodea (Plantilla)", () => {
    const target = plan();
    const analysis = analysisOf(target, analysisResponseFor(target, [SHEET, islandOf(1, 0, 10, 10, 20, [0]), islandOf(2, 1, 15, 15, 5, [0], 2)]));

    expect(analysis.issues[1].parentLabel).toBe("Isla 1");
  });

  it("devuelve un error legible (y nada que mostrar) si la respuesta es incoherente con la petición", () => {
    const target = plan();
    const result = floatingAnalysis(target, { ...analysisResponseFor(target), floatingCount: 9 });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/respuesta incoherente.*No se modificó nada/);
  });

  it("resume en palabras lo que se encontró (con lo descartado) o que no hay nada", () => {
    const target = plan();

    expect(analysisSummary(analysisOf(target))).toBe("Se encontraron 3 islas (se caen al cortar).");
    expect(analysisSummary(analysisOf(target, analysisResponseFor(target, [SHEET, islandOf(1, 0, 10, 10, 20, [0])])))).toBe("Se encontraron 1 isla (se caen al cortar).");
    expect(analysisSummary(analysisOf(target, analysisResponseFor(target, [SHEET])))).toBe("No se encontraron islas: ninguna parte se cae al cortar.");
    expect(analysisSummary({ ...analysisOf(target, analysisResponseFor(target, [SHEET])), mode: "parts", discarded: 2 })).toBe(
      "No se encontraron piezas flotantes: todo está conectado al cuerpo principal. 2 componentes despreciables se descartaron.",
    );
  });

  it("describe un issue con su área en mm² y los objetos que lo rodean", () => {
    const target = plan();
    const analysis = analysisOf(target);

    expect(issueDescription(analysis.issues[0], target.unit, "stencil")).toBe("Isla 1 · 100 mm² · rodeada por «Rojo · objeto 1»");
    expect(issueDescription(analysis.issues[0], target.unit, "parts")).toBe("Isla 1 · 100 mm² · formada por «Rojo · objeto 1»");
  });

  it("boundsRect convierte [minX, minY, maxX, maxY] en un rectángulo del documento", () => {
    expect(boundsRect([10, 20, 50, 80])).toEqual({ x: 10, y: 20, width: 40, height: 60 });
  });
});

// ---- Ajuste de un click al borde ----

describe("snapToIssue", () => {
  const issues = analysisOf(plan()).issues; // islas 10..30 (o1), 210..230 x 10..30 (o3) y 10..30 x 210..230 (o4)

  it("ajusta un click cercano al punto más próximo del BORDE de la isla", () => {
    const snapped = snapToIssue(point(31, 20), issues, 2);

    expect(snapped).toEqual({ issueId: 1, point: { x: 30, y: 20 } });
  });

  it("en una esquina cae sobre el vértice; sobre un lado, en la proyección exacta", () => {
    expect(snapToIssue(point(31, 31), issues, 2)?.point).toEqual({ x: 30, y: 30 });
    expect(snapToIssue(point(15, 8), issues, 2)?.point).toEqual({ x: 15, y: 10 });
  });

  it("devuelve la isla MÁS cercana cuando varias entran en la tolerancia", () => {
    const near = [issues[0], { ...issues[1], id: 7, component: { ...issues[1].component, polygon: poly(closed(32, 10, 20)) } }];

    expect(snapToIssue(point(31.5, 20), near, 5)?.issueId).toBe(7); // 0,5 del borde izquierdo de la 7 contra 1,5 del derecho de la 1
  });

  it("fuera de la tolerancia (o dentro de la isla lejos de su borde) no engancha nada", () => {
    expect(snapToIssue(point(40, 20), issues, 2)).toBeNull();
    expect(snapToIssue(point(20, 20), issues, 2)).toBeNull(); // centro de la isla: a 10 del borde
    expect(snapToIssue(point(31, 20), [], 2)).toBeNull();
  });
});

// ---- Bridges: borradores y petición ----

describe("bridgeInputs / draftsFromSuggestions", () => {
  it("manda lo que el usuario fijó (isla, ancla, dirección) con el ancho en unidades, y omite lo que decide el servidor", () => {
    const inputs = bridgeInputs([draft("a", 1), draft("b", null, point(30, 20)), draft("c", 2, point(230, 20), point(0, 2))], 1.6);

    expect(inputs).toEqual([
      { island: 1, width: 1.6 },
      { anchor: { x: 30, y: 20 }, width: 1.6 },
      { island: 2, anchor: { x: 230, y: 20 }, direction: { x: 0, y: 2 }, width: 1.6 },
    ]);
  });

  it("adopta las sugerencias VÁLIDAS del servidor como borradores explícitos, con clave estable por isla; las inválidas o ajenas no", () => {
    const base = plan();
    const target = bridgePlanOf(base, analysisOf(base), null);
    const response = bridgeResponseFor(target, [
      bridgeItem(0, 1, { suggested: true }),
      // Una sugerencia inválida por un bloqueado SÍ trae ancla y dirección resueltas: aun así no es un borrador (rechazaría Apply).
      bridgeItem(1, 2, { suggested: true, valid: false, reason: "locked_subject", reduces: false, affects: [3] }),
      bridgeItem(2, 3, { suggested: false }),
    ]);

    expect(draftsFromSuggestions(response)).toEqual([{ key: "s1", island: 1, anchor: point(30, 20), direction: point(1, 0) }]);
    expect(draftsFromSuggestions(null)).toEqual([]);
  });
});

describe("planBridges", () => {
  const base = plan();
  const analysis = analysisOf(base);

  it("sin lista del usuario pide las SUGERENCIAS (suggest + ancho sugerido en unidades: 0,8 mm = 1,6 u)", () => {
    const target = bridgePlanOf(base, analysis, null);

    expect(target.request.suggest).toBe(true);
    expect(target.request.suggestWidth).toBeCloseTo(1.6, 12);
    expect(target.request.bridges).toEqual([]);
    expect(target.request.mode).toBe("stencil");
    expect(target.request.subjects).toBe(base.subjects); // las mismas formas que el análisis (con su bloqueo)
    expect(target.request.tolerance).toBe(base.request.tolerance);
    expect(target.drafts).toBeNull();
  });

  it("con lista explícita manda esos bridges (mm -> unidades) y NO pide sugerencias", () => {
    const target = bridgePlanOf(base, analysis, [draft("m1", 1, point(30, 20))], 2);

    expect(target.request.suggest).toBe(false);
    expect(target.request.suggestWidth).toBeUndefined();
    expect(target.request.bridges).toEqual([{ island: 1, anchor: { x: 30, y: 20 }, width: 4 }]); // 2 mm / 0,5
    expect(target.widthUnits).toBe(4);
  });

  it("la clave cambia con el ancho, con cada bridge y con su posición; igual petición, igual clave", () => {
    const a = bridgePlanOf(base, analysis, [draft("m1", 1, point(30, 20))]).requestKey;

    expect(bridgePlanOf(base, analysis, [draft("m1", 1, point(30, 20))]).requestKey).toBe(a);
    expect(bridgePlanOf(base, analysis, [draft("otra", 1, point(30, 20))]).requestKey).toBe(a); // la clave del borrador es del cliente, no de la petición
    expect(bridgePlanOf(base, analysis, [draft("m1", 1, point(30, 21))]).requestKey).not.toBe(a);
    expect(bridgePlanOf(base, analysis, [draft("m1", 1, point(30, 20), point(1, 0))]).requestKey).not.toBe(a);
    expect(bridgePlanOf(base, analysis, [draft("m1", 1, point(30, 20))], 1).requestKey).not.toBe(a);
    expect(bridgePlanOf(base, analysis, null).requestKey).not.toBe(a);
  });

  it("rechaza con el motivo: sin piezas flotantes, ancho fuera de rango, ningún bridge o demasiados", () => {
    const empty = analysisOf(base, analysisResponseFor(base, [SHEET]));

    expect(planBridges(base, empty, null, 0.8)).toMatchObject({ ok: false, reason: "no_issues" });
    for (const width of [MIN_BRIDGE_WIDTH_MM / 2, MAX_BRIDGE_WIDTH_MM + 1, 0, -1, NaN, Infinity]) {
      expect(planBridges(base, analysis, null, width)).toMatchObject({ ok: false, reason: "invalid_width" });
    }
    expect(planBridges(base, analysis, [], 0.8)).toMatchObject({ ok: false, reason: "no_bridges" });
    const tooMany = Array.from({ length: MAX_BRIDGES + 1 }, (_, index) => draft(`m${index}`, 1));
    expect(planBridges(base, analysis, tooMany, 0.8)).toMatchObject({ ok: false, reason: "too_many_bridges" });
    expect(planBridges(base, analysis, tooMany.slice(0, MAX_BRIDGES), 0.8).ok).toBe(true);
  });

  it("acepta los extremos exactos del ancho (0,05 y 20 mm)", () => {
    expect(planBridges(base, analysis, null, MIN_BRIDGE_WIDTH_MM).ok).toBe(true);
    expect(planBridges(base, analysis, null, MAX_BRIDGE_WIDTH_MM).ok).toBe(true);
  });
});

// ---- Validación de la respuesta de los bridges ----

describe("validateBridgeResponse", () => {
  const mutate = (change: (response: BridgeResponse, request: BridgeRequest) => void) => {
    const { target, response } = validBridge();
    const copy = structuredClone(response);
    const request = structuredClone(target.request);
    change(copy, request);
    return validateBridgeResponse(request, copy);
  };

  it("acepta una respuesta coherente", () => {
    const { target, response } = validBridge();

    expect(validateBridgeResponse(target.request, response)).toBeNull();
  });

  it.each<[string, (response: BridgeResponse, request: BridgeRequest) => void]>([
    ["otro modo", (r) => void (r.mode = "parts")],
    ["tolerancia no positiva", (r) => void (r.tolerance = 0)],
    ["menos bridges que los pedidos", (r) => void (r.bridges = [])],
    ["más bridges que los pedidos sin suggest", (r) => void r.bridges.push(bridgeItem(1, 1, { suggested: true }))],
    ["índice fuera de posición", (r) => void (r.bridges[0].index = 3)],
    ["un pedido marcado como sugerido", (r) => void (r.bridges[0].suggested = true)],
    ["ancho distinto del pedido", (r) => void (r.bridges[0].width = 9)],
    ["válido con motivo", (r) => void (r.bridges[0].reason = "too_short")],
    ["válido sin isla", (r) => void (r.bridges[0].island = null)],
    ["isla negativa", (r) => void (r.bridges[0].island = -1)],
    ["válido sin ancla", (r) => void (r.bridges[0].anchor = null)],
    ["ancla no finita", (r) => void (r.bridges[0].anchor = { x: NaN, y: 1 })],
    ["válido sin dirección", (r) => void (r.bridges[0].direction = null)],
    ["dirección no unitaria", (r) => void (r.bridges[0].direction = { x: 3, y: 0 })],
    ["válido sin rectángulo", (r) => void (r.bridges[0].polygon = null)],
    ["rectángulo con dos anillos", (r) => void (r.bridges[0].polygon = poly(closed(0, 0, 5), closed(1, 1, 2)))],
    ["rectángulo sin cerrar", (r) => void (r.bridges[0].polygon = poly(closed(0, 0, 5).slice(0, 4)))],
    ["largo cero", (r) => void (r.bridges[0].length = 0)],
    ["largo negativo", (r) => void (r.bridges[0].length = -2)],
    ["área nula", (r) => void (r.bridges[0].area = null)],
    ["área cero", (r) => void (r.bridges[0].area = 0)],
    ["válido que no modifica nada", (r) => void (r.bridges[0].affects = [])],
    ["válido que modifica una forma inexistente", (r) => void (r.bridges[0].affects = [9])],
    ["válido que modifica una forma bloqueada", (_r, q) => void (q.subjects[0].locked = true)],
    ["inválido sin motivo", (r) => void Object.assign(r.bridges[0], { valid: false, reason: null, reduces: false, affects: [] })],
    ["inválido con un motivo desconocido", (r) => void Object.assign(r.bridges[0], { valid: false, reason: "rara", reduces: false, affects: [] })],
    ["inválido que reduce", (r) => void Object.assign(r.bridges[0], { valid: false, reason: "too_short", reduces: true, affects: [] })],
    ["menos resultados que formas", (r) => void r.results.pop()],
    ["resultado fuera de posición", (r) => void (r.results[1].subjectIndex = 7)],
    ["resultado cambiado sin bridge que lo modifique", (r) => void ((r.results[1].changed = true), (r.results[1].geometries = [OPENED_O1]))],
    ["forma modificada declarada intacta", (r) => void (r.results[0].changed = false)],
    ["forma intacta con geometría", (r) => void (r.results[1].geometries = [OPENED_O1])],
    ["pieza que no es un polígono", (r) => void (r.results[0].geometries = [{ type: "line", coordinates: [[0, 0], [1, 1]] } as unknown as PolygonGeometry])],
    ["pieza con un anillo sin cerrar", (r) => void (r.results[0].geometries = [poly(closed(0, 0, 5).slice(0, 4))])],
    ["más flotantes después que antes", (r) => void (r.reanalysis = { floatingBefore: 3, floatingAfter: 4, mainAfter: 1 })],
    ["conteos negativos", (r) => void (r.reanalysis = { floatingBefore: -1, floatingAfter: 0, mainAfter: 1 })],
    ["piece_count inventado", (r) => void (r.pieceCount = 9)],
    ["sin reanálisis", (r) => void (r.reanalysis = undefined as unknown as BridgeResponse["reanalysis"])],
  ])("rechaza: %s", (_label, change) => {
    expect(mutate(change)).not.toBeNull();
  });

  it("sin bridges válidos el reanálisis no puede cambiar", () => {
    const { target, response } = validBridge({
      items: [bridgeItem(0, 1, { valid: false, reason: "too_short", reduces: false, affects: [] })],
      changed: {},
      reanalysis: { floatingBefore: 3, floatingAfter: 2, mainAfter: 1 },
    });

    expect(validateBridgeResponse(target.request, response)).not.toBeNull();
  });

  it("con suggest acepta los sugeridos DESPUÉS de los pedidos, con el ancho sugerido; con otro ancho, no", () => {
    const base = plan();
    const target = bridgePlanOf(base, analysisOf(base), null);
    const ok = bridgeResponseFor(target, [bridgeItem(0, 1, { suggested: true, width: target.widthUnits })], { 0: [OPENED_O1] });

    expect(validateBridgeResponse(target.request, ok)).toBeNull();
    expect(validateBridgeResponse(target.request, { ...ok, bridges: [{ ...ok.bridges[0], width: 9 }] })).not.toBeNull();
    expect(validateBridgeResponse(target.request, { ...ok, bridges: [{ ...ok.bridges[0], suggested: false }] })).not.toBeNull();
  });
});

// ---- Resultado ----

describe("bridgeOutcome", () => {
  it("interpreta la respuesta: bridges con isla, medidas en mm / mm², objetos modificados y el reanálisis", () => {
    const { target, response } = validBridge();

    const result = bridgeOutcome(target, response);

    expect(result.ok).toBe(true);
    const outcome = result.ok ? result.outcome : null;
    expect(outcome?.validCount).toBe(1);
    expect(outcome?.invalidCount).toBe(0);
    expect(outcome?.floatingBefore).toBe(3);
    expect(outcome?.floatingAfter).toBe(2);
    const view = outcome!.bridges[0];
    expect(view).toMatchObject({ key: "m1", valid: true, islandLabel: "Isla 1", suggested: false, reduces: true, reason: null, reasonText: null });
    expect(view.length).toBeCloseTo(5, 12); // 10 u = 5 mm
    expect(view.area).toBeCloseTo(4, 12); // 16 u² = 4 mm²
    expect(view.d).toMatch(/^M29\.96 19\.2/);
    expect(outcome!.objects.map((entry) => [entry.object.id, entry.status])).toEqual([["o1", "changed"], ["o2", "unchanged"], ["o3", "unchanged"], ["o4", "unchanged"]]);
    expect(outcome!.objects[3].locked).toBe(true);
    expect(outcome!.changedCount).toBe(1);
    expect(outcome!.pieceCount).toBe(1);
    expect(outcome!.uncovered.map((issue) => issue.label)).toEqual(["Isla 2", "Isla 3"]);
    expect(outcome!.notReducing).toEqual([]);
  });

  it("un bridge inválido trae su motivo en palabras (y, si es por un bloqueado, qué objeto)", () => {
    const { target, response } = validBridge({
      items: [bridgeItem(0, 1, { valid: false, reason: "locked_subject", reduces: false, affects: [3] })],
      changed: {},
      reanalysis: { floatingBefore: 3, floatingAfter: 3, mainAfter: 1 },
    });

    const outcome = bridgeOutcome(target, response);

    expect(outcome.ok && outcome.outcome.bridges[0].reasonText).toBe("necesitaría modificar un objeto en una capa bloqueada («Gris · objeto 1»)");
    expect(outcome.ok && outcome.outcome.invalidCount).toBe(1);
  });

  it("cada motivo tiene un texto propio", () => {
    for (const reason of ["unknown_island", "anchor_outside", "width_below_tolerance", "invalid_direction", "no_crossing", "too_short", "locked_subject", "no_connection"] as const) {
      expect(bridgeReasonText(reason).length).toBeGreaterThan(10);
    }
    expect(new Set(["unknown_island", "anchor_outside", "no_crossing", "too_short", "no_connection"].map((reason) => bridgeReasonText(reason as "too_short"))).size).toBe(5);
  });

  it("un segundo bridge sobre la misma isla es válido pero NO redujo nada: se informa; las piezas sin bridge quedan listadas", () => {
    const base = plan();
    const target = bridgePlanOf(base, analysisOf(base), [draft("m1", 1, point(30, 20)), draft("m2", 1, point(10, 20))]);
    const response = bridgeResponseFor(target, [bridgeItem(0, 1), bridgeItem(1, 1, { reduces: false })], { 0: [OPENED_O1] });

    const outcome = bridgeOutcome(target, response);

    expect(outcome.ok && outcome.outcome.notReducing.map((bridge) => bridge.index)).toEqual([1]);
    expect(outcome.ok && outcome.outcome.uncovered.map((issue) => issue.label)).toEqual(["Isla 2", "Isla 3"]);
    expect(outcome.ok && outcome.outcome.validCount).toBe(2);
  });

  it("las sugerencias que el servidor no pudo resolver NO bloquean (se informan); un bridge pedido inválido sí", () => {
    const base = plan();
    const target = bridgePlanOf(base, analysisOf(base), null);
    const response = bridgeResponseFor(
      target,
      [
        bridgeItem(0, 1, { suggested: true, width: target.widthUnits }),
        bridgeItem(1, 2, { suggested: true, width: target.widthUnits, valid: false, reason: "no_crossing", anchor: null, direction: null, polygon: null, length: null, area: null, reduces: false, affects: [] }),
      ],
      { 0: [OPENED_O1] },
    );

    const outcome = bridgeOutcome(target, response);

    expect(outcome.ok && outcome.outcome.invalidCount).toBe(0);
    expect(outcome.ok && outcome.outcome.unsuggested.map((bridge) => bridge.islandLabel)).toEqual(["Isla 2"]);
    expect(outcome.ok && bridgeApplyBlock(outcome.outcome)).toBeNull();
    const warnings = outcome.ok ? bridgeWarnings(target, outcome.outcome) : [];
    expect(warnings.map((warning) => warning.kind)).toContain("unsuggested");
    expect(warnings.find((warning) => warning.kind === "unsuggested")?.text).toMatch(/No se pudo sugerir un bridge para Isla 2 \(no cruza ningún hueco en esa dirección\)/);
  });

  it("un objeto modificado que se queda sin piezas útiles invalida TODO el resultado (nunca se borra un diseño)", () => {
    const { target, response } = validBridge({ changed: { 0: [poly(closed(0, 0, 0.005))] } }); // área < tolerancia²

    const outcome = bridgeOutcome(target, response);

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error).toMatch(/resultado vacío.*no se borra ningún diseño/);
  });

  it("las piezas despreciables de un objeto que sí queda con piezas útiles se descartan e informan", () => {
    const { target, response } = validBridge({ changed: { 0: [OPENED_O1, poly(closed(50, 50, 0.005))] } });

    const outcome = bridgeOutcome(target, response);

    expect(outcome.ok && outcome.outcome.discarded).toBe(1);
    expect(outcome.ok && outcome.outcome.objects[0].shapes).toHaveLength(1);
  });

  it("una respuesta incoherente con la petición no produce resultado", () => {
    const { target, response } = validBridge();

    const outcome = bridgeOutcome(target, { ...response, mode: "parts" });

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error).toMatch(/respuesta incoherente/);
  });
});

describe("bridgeApplyBlock / bridgeWarnings / textos", () => {
  const ok = () => {
    const built = validBridge();
    const outcome = bridgeOutcome(built.target, built.response);
    if (!outcome.ok) throw new Error(outcome.error);
    return { ...built, outcome: outcome.outcome };
  };

  it("sin resultado todavía: espera al servidor", () => {
    expect(bridgeApplyBlock(null)).toBe("Esperando el resultado del servidor…");
  });

  it("habilitado cuando hay bridges válidos que reducen y modifican algo", () => {
    expect(bridgeApplyBlock(ok().outcome)).toBeNull();
  });

  it("CUALQUIER bridge inválido deshabilita Apply, con el motivo y la salida", () => {
    const base = plan();
    const target = bridgePlanOf(base, analysisOf(base), [draft("m1", 1, point(30, 20)), draft("m2", 2, point(230, 20))]);
    const response = bridgeResponseFor(target, [bridgeItem(0, 1), bridgeItem(1, 2, { valid: false, reason: "too_short", reduces: false, affects: [] })], { 0: [OPENED_O1] });

    const outcome = bridgeOutcome(target, response);

    expect(outcome.ok && bridgeApplyBlock(outcome.outcome)).toBe("1 bridge es inválido: quitalo o corregilo antes de aplicar.");
  });

  it("sin bridges válidos, o sin que ninguno reduzca, o sin objetos modificados, no hay nada que aplicar", () => {
    const base = ok().outcome;

    expect(bridgeApplyBlock({ ...base, validCount: 0, invalidCount: 0 })).toBe("No hay bridges para aplicar.");
    expect(bridgeApplyBlock({ ...base, floatingAfter: base.floatingBefore })).toBe("Ningún bridge reduce las piezas flotantes: no hay nada que aplicar.");
    expect(bridgeApplyBlock({ ...base, changedCount: 0 })).toBe("Los bridges no modifican ningún objeto.");
  });

  it("avisos: lo que no redujo, lo que queda flotando, lo bloqueado, lo descartado, lo omitido", () => {
    const { target, outcome } = ok();
    const withExtras = { ...outcome, notReducing: [outcome.bridges[0]], discarded: 2 };

    const kinds = bridgeWarnings(target, withExtras).map((warning) => warning.kind);

    expect(kinds).toEqual(["not_reducing", "uncovered", "locked", "discarded", "omitted"]);
    const texts = bridgeWarnings(target, withExtras).map((warning) => warning.text);
    expect(texts[1]).toBe("2 islas sin bridge: Isla 2, Isla 3. Quedan flotando.");
    expect(texts[2]).toBe("1 objeto en una capa bloqueada cuenta para el análisis y no se modifica.");
  });

  it("«N flotantes → M» dice cuántas piezas se caen antes y después", () => {
    const { outcome } = ok();

    expect(reanalysisText(outcome)).toBe("3 flotantes → 2");
    expect(reanalysisText({ ...outcome, floatingBefore: 1, floatingAfter: 0 })).toBe("1 flotante → 0 (ninguna pieza se cae)");
    expect(bridgeReadyText(outcome)).toMatch(/1 bridge: 1 válido\. Resultado: 3 flotantes → 2\. 1 objeto se modifica \(1 pieza\), en su capa\./);
  });
});

// ---- Aplicar ----

describe("applyBridgeResult", () => {
  it("un comando atómico: el objeto modificado se reemplaza por sus piezas (ids nuevos, misma capa, mismo fill, sin matriz, en el mismo lugar); el resto intacto", () => {
    const { target, response } = validBridge();
    const ids = idFactory();

    const applied = applyBridgeResult(target, DOC, response, { createId: ids.next });

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.production.atomic).toBe(true);
    expect(Object.keys(applied.production.layers)).toEqual(["A"]); // solo la capa tocada
    const layerA = applied.production.layers.A;
    expect(layerA.map((object) => object.id)).toEqual(["n1", "o2", "ln"]); // la pieza ocupa el lugar de o1
    expect(layerA[0]).toMatchObject({ layerGroupId: "A", fill: "#ff0000", matrix: IDENTITY_MATRIX });
    expect(layerA[0].d).toMatch(/^M0 0 L40 0 L40 19\.2/);
    expect(layerA[1]).toBe(o2); // sin cambios: la MISMA referencia (conserva d, matriz e id)
    expect(layerA[2]).toBe(ln);
    expect(applied.resultIds).toEqual(["n1"]);
    expect(applied.activeGroupId).toBe("A");
    expect(applied.summary).toMatchObject({ bridgeCount: 1, floatingBefore: 3, floatingAfter: 2, changedCount: 1, pieceCount: 1, lockedCount: 1, widthMm: DEFAULT_BRIDGE_WIDTH_MM });
  });

  it("no muta el documento ni la respuesta", () => {
    const { target, response } = validBridge();
    const before = JSON.stringify([DOC, response]);

    applyBridgeResult(target, DOC, response, { createId: idFactory().next });

    expect(JSON.stringify([DOC, response])).toBe(before);
  });

  it("un objeto con huecos que se parte en varias piezas las pone todas en su lugar, en el orden del servidor", () => {
    const pieces = [OPENED_O1, poly(closed(60, 60, 5))];
    const { target, response } = validBridge({ changed: { 0: pieces } });
    const ids = idFactory();

    const applied = applyBridgeResult(target, DOC, response, { createId: ids.next });

    expect(applied.ok && applied.production.layers.A.map((object) => object.id)).toEqual(["n1", "n2", "o2", "ln"]);
    expect(applied.ok && applied.resultIds).toEqual(["n1", "n2"]);
  });

  it("escala el grosor de trazo del original por su matriz horneada (el resultado no tiene matriz)", () => {
    const scaled = { ...o1, matrix: { a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 }, stroke: "#000000", strokeWidth: 1 };
    const doc = stateOf({ ...DOC.objectsByLayer, A: [scaled, o2, ln] }, LAYERS);
    const base = plan([], "stencil", doc);
    const target = bridgePlanOf(base, analysisOf(base), [draft("m1", 1, point(30, 20))]);
    const response = bridgeResponseFor(target, [bridgeItem(0, 1)], { 0: [OPENED_O1] });

    const applied = applyBridgeResult(target, doc, response, { createId: idFactory().next });

    expect(applied.ok && applied.production.layers.A[0].strokeWidth).toBe(2);
    expect(applied.ok && applied.production.layers.A[0].matrix).toBe(IDENTITY_MATRIX);
  });

  it("los bloqueados NO se modifican: ni aparecen en la producción", () => {
    const { target, response } = validBridge();

    const applied = applyBridgeResult(target, DOC, response, { createId: idFactory().next });

    expect(applied.ok && Object.keys(applied.production.layers)).not.toContain("C");
  });

  it("si un bridge es inválido no aplica nada y lo dice", () => {
    const { target, response } = validBridge({
      items: [bridgeItem(0, 1, { valid: false, reason: "too_short", reduces: false, affects: [] })],
      changed: {},
      reanalysis: { floatingBefore: 3, floatingAfter: 3, mainAfter: 1 },
    });

    const applied = applyBridgeResult(target, DOC, response, { createId: idFactory().next });

    expect(applied).toMatchObject({ ok: false, code: "invalid_bridges" });
    expect(!applied.ok && applied.error).toMatch(/inválido.*No se modificó nada/);
  });

  it("si ningún bridge reduce no hay nada que aplicar", () => {
    const { target, response } = validBridge({ reanalysis: { floatingBefore: 3, floatingAfter: 3, mainAfter: 1 } });

    expect(applyBridgeResult(target, DOC, response, { createId: idFactory().next })).toMatchObject({ ok: false, code: "nothing_to_apply" });
  });

  it("si el documento cambió desde el análisis (otro objeto con el mismo id) descarta el resultado: STALE", () => {
    const { target, response } = validBridge();
    const moved = stateOf({ ...DOC.objectsByLayer, A: [{ ...o1 }, o2, ln] }, LAYERS);

    const applied = applyBridgeResult(target, moved, response, { createId: idFactory().next });

    expect(applied).toMatchObject({ ok: false, code: "stale" });
    expect(!applied.ok && applied.error).toMatch(/Volvé a analizar/);
  });

  it("si la capa del objeto a modificar se bloqueó (o se ocultó) mientras tanto, se rechaza", () => {
    const { target, response } = validBridge();
    const locked = stateOf(DOC.objectsByLayer, LAYERS.map((layer) => (layer.groupId === "A" ? { ...layer, locked: true } : layer)));
    const hidden = stateOf(DOC.objectsByLayer, LAYERS.map((layer) => (layer.groupId === "A" ? { ...layer, visible: false } : layer)));

    const byLock = applyBridgeResult(target, locked, response, { createId: idFactory().next });
    const byHidden = applyBridgeResult(target, hidden, response, { createId: idFactory().next });

    expect(byLock).toMatchObject({ ok: false, code: "blocked" });
    expect(!byLock.ok && byLock.error).toMatch(/«Rojo» está bloqueada/);
    expect(byHidden).toMatchObject({ ok: false, code: "blocked" });
    expect(!byHidden.ok && byHidden.error).toMatch(/está oculta/);
  });

  it("una respuesta incoherente no produce nada (invalid_response)", () => {
    const { target, response } = validBridge();

    expect(applyBridgeResult(target, DOC, { ...response, pieceCount: 9 }, { createId: idFactory().next })).toMatchObject({ ok: false, code: "invalid_response" });
  });

  it("sin createId usa crypto.randomUUID", () => {
    const { target, response } = validBridge();

    const applied = applyBridgeResult(target, DOC, response);

    expect(applied.ok && applied.resultIds[0]).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("textos del comando", () => {
  const summary = { mode: "stencil" as const, bridgeCount: 2, floatingBefore: 3, floatingAfter: 1, changedCount: 2, pieceCount: 2, lockedCount: 1, discarded: 0, widthMm: 0.8, unit: { factor: 0.5, label: "mm" as const } };

  it("la etiqueta de Deshacer/Rehacer dice cuántos bridges, su ancho y el reanálisis", () => {
    expect(bridgeLabel(summary)).toBe("Bridges: 2 bridges de 0.8 mm (3 → 1 flotantes)");
  });

  it("el aviso posterior dice qué se hizo y qué quedó: lo que sigue flotando, lo bloqueado, lo descartado", () => {
    expect(bridgeNotice(summary)).toBe(
      "Se aplicaron 2 bridges de 0.8 mm: 3 flotantes → 1. 2 objetos modificados (2 piezas), en su capa. 1 pieza sigue flotando. 1 objeto bloqueado no se modificó.",
    );
    expect(bridgeNotice({ ...summary, bridgeCount: 1, floatingAfter: 0, lockedCount: 0, discarded: 3, changedCount: 1, pieceCount: 1 })).toBe(
      "Se aplicaron 1 bridge de 0.8 mm: 3 flotantes → 0. 1 objeto modificado (1 pieza), en su capa. 3 piezas despreciables descartadas.",
    );
  });
});

describe("floatingErrorMessage", () => {
  const apiError = (code: string, status = 400) => ({ status, body: { code } });

  it("traduce los códigos propios del análisis y los bridges, siempre diciendo que no se modificó nada", () => {
    for (const code of ["unknown_floating_mode", "invalid_bridge", "invalid_bridge_width", "too_many_bridges", "timeout", "too_many_subjects", "too_many_vertices", "payload_too_large"]) {
      expect(floatingErrorMessage(apiError(code))).toMatch(/No se modificó nada/);
    }
    expect(floatingErrorMessage(apiError("invalid_bridge_width"))).toMatch(/ancho de un bridge/);
    expect(floatingErrorMessage(apiError("too_many_bridges"))).toMatch(/Quitá algunos/);
  });

  it("un 413 o 504 sin código usa los textos de tamaño y de tiempo; el resto cae en el mensaje genérico del servicio de geometría", () => {
    expect(floatingErrorMessage({ status: 413 })).toMatch(/demasiado grande/);
    expect(floatingErrorMessage({ status: 504 })).toMatch(/tardó demasiado/);
    expect(floatingErrorMessage(apiError("engine_unavailable", 503))).toMatch(/motor de geometría no está disponible/);
    expect(floatingErrorMessage({ isAborted: true })).toMatch(/cancelada/);
    expect(floatingErrorMessage({ isNetworkError: true })).toMatch(/No se pudo contactar/);
    expect(floatingErrorMessage(new Error("x"))).toMatch(/No se modificó nada/);
  });
});
