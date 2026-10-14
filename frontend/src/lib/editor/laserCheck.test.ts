import { describe, expect, it } from "vitest";
import type { FloatingComponent, FloatingResponse, GeometryPoint } from "../../types/geometry";
import { IDENTITY_MATRIX } from "../svgTransform";
import { floatingAnalysis, planFloating } from "./floating";
import {
  analyzeLaserLocal,
  buildReport,
  CLOSE_TOLERANCE_MM,
  documentFingerprint,
  DUPLICATE_EXACT_TOLERANCE_MM,
  DUPLICATE_NEAR_TOLERANCE_MM,
  floatingIssues,
  LASER_CHECK_FLOATING_MODE,
  laserCheckStatus,
  MAX_NODES_PER_LAYER,
  MAX_NODES_PER_OBJECT,
  MIN_DETAIL_CUT_MM,
  MIN_DETAIL_ENGRAVE_MM,
  minimumWidth,
  NO_SCALE_CHECK_NOTICE,
  reportSummary,
  scopeText,
  thresholdsText,
  type LaserCheckIssue,
  type LaserCheckKind,
} from "./laserCheck";
import type { EditableDocument, EditableLayerMeta, EditorObject } from "./types";

// ---- Fixtures ----

function meta(groupId: string, overrides: Partial<EditableLayerMeta> = {}): EditableLayerMeta {
  return { groupId, name: `Capa ${groupId}`, colorHex: "#ff0000", order: 0, visible: true, locked: false, manufacturingOperation: "cut", isNew: false, ...overrides };
}

function square(id: string, layerGroupId: string, x: number, y: number, w: number, h = w, overrides: Partial<EditorObject> = {}): EditorObject {
  return { id, layerGroupId, d: `M${x} ${y} H${x + w} V${y + h} H${x} Z`, fill: "#ff0000", matrix: IDENTITY_MATRIX, ...overrides };
}

function raw(id: string, layerGroupId: string, d: string, overrides: Partial<EditorObject> = {}): EditorObject {
  return { id, layerGroupId, d, fill: "#ff0000", matrix: IDENTITY_MATRIX, ...overrides };
}

function line(id: string, layerGroupId: string, d: string): EditorObject {
  return { id, layerGroupId, d, fill: "none", stroke: "#00aa00", strokeWidth: 0.5, matrix: IDENTITY_MATRIX };
}

function documentOf(layers: EditableLayerMeta[], objectsByLayer: Record<string, EditorObject[]>): EditableDocument {
  return { layers, objectsByLayer };
}

/** mm = unidades (1 mm por unidad): los umbrales en mm se leen directo. */
const MM1 = { mmFactor: 1 };

const run = (document: EditableDocument, mmFactor: number | null = 1) => analyzeLaserLocal(document, { mmFactor });
const kinds = (issues: readonly LaserCheckIssue[]): LaserCheckKind[] => issues.map((issue) => issue.kind);
const only = (document: EditableDocument, kind: LaserCheckKind, mmFactor: number | null = 1) => run(document, mmFactor).issues.filter((issue) => issue.kind === kind);

/** Un cuadrado limpio de 20 en el origen: la base de varios casos. */
const CLEAN = square("clean", "A", 0, 0, 20);
const CUT_A = [meta("A", { name: "Corte", order: 0 })];

// ---- Dataset conocido CON problemas (una capa CUT, una ENGRAVE y una sin asignar) ----

// Corte (A): limpio, abierto, duplicado exacto del limpio, casi duplicado, detalle fino, bow-tie (se cruza), ilegible, degenerado.
const PROBLEMS: EditableDocument = documentOf(
  [
    meta("A", { name: "Corte", order: 0 }),
    meta("E", { name: "Grabado", order: 1, manufacturingOperation: "engrave" }),
    meta("U", { name: "Libre", order: 2, manufacturingOperation: "unassigned" }),
    meta("I", { name: "Ignorada", order: 3, manufacturingOperation: "ignore" }),
    meta("H", { name: "Oculta", order: 4, visible: false }),
  ],
  {
    A: [
      CLEAN,
      raw("open", "A", "M30 0 H50 V20 H30"),
      raw("dup", "A", "M0 0 H20 V20 H0 Z"),
      raw("near", "A", "M0.02 0 H20.02 V20 H0.02 Z"),
      square("tiny", "A", 60, 0, 0.05, 20),
      raw("bowtie", "A", "M70 0 L90 20 L90 0 L70 20 Z"),
      raw("broken", "A", "garbage"),
      raw("flat", "A", "M100 0 L110 0 L120 0 Z"),
    ],
    E: [raw("engrave-open", "E", "M0 50 H20 V70"), line("engrave-line", "E", "M0 80 L30 80")],
    U: [raw("free-open", "U", "M200 0 H220 V20 H200")],
    I: [raw("ignored-open", "I", "M0 0 H10 V10")],
    H: [raw("hidden-open", "H", "M0 0 H10 V10")],
  },
);

describe("laserCheck — dataset con problemas conocidos", () => {
  const result = run(PROBLEMS);
  const byObject = (id: string) => result.issues.filter((issue) => issue.objectIds[0] === id);

  it("detecta cada problema sembrado, con su severidad", () => {
    expect(byObject("open").map((issue) => [issue.kind, issue.severity])).toEqual([["open_path", "error"]]);
    expect(byObject("dup").map((issue) => [issue.kind, issue.severity])).toEqual([["duplicate_exact", "error"]]);
    expect(byObject("near").map((issue) => [issue.kind, issue.severity])).toEqual([["duplicate_near", "warning"]]);
    expect(byObject("tiny").map((issue) => [issue.kind, issue.severity])).toEqual([["tiny_detail", "warning"]]);
    expect(byObject("bowtie").map((issue) => [issue.kind, issue.severity])).toEqual([["invalid_geometry", "error"]]);
    expect(byObject("broken").map((issue) => [issue.kind, issue.severity])).toEqual([["invalid_geometry", "error"]]);
    expect(byObject("flat").map((issue) => [issue.kind, issue.severity])).toEqual([["invalid_geometry", "error"]]);
  });

  it("el objeto limpio no tiene issues propios (solo es el original del duplicado)", () => {
    expect(byObject("clean")).toEqual([]);
    expect(byObject("dup")[0].objectIds).toEqual(["dup", "clean"]);
    expect(byObject("near")[0].objectIds).toEqual(["near", "clean"]);
  });

  it("explica cada problema con la capa, el objeto y una acción sugerida", () => {
    const open = byObject("open")[0];
    expect(open.layerName).toBe("Corte");
    expect(open.objectLabel).toBe("Corte · objeto 2");
    expect(open.message).toMatch(/subpath abierto/);
    expect(open.suggestion).toBe("Cerrar el path o asignar la capa a Engrave.");
    expect(byObject("dup")[0].suggestion).toBe("Eliminar el duplicado.");
    expect(byObject("tiny")[0].suggestion).toBe("Agrandar el detalle o quitarlo.");
    expect(byObject("bowtie")[0].message).toMatch(/Se cruza consigo mismo \(1 cruce\)/);
    expect(byObject("broken")[0].message).toMatch(/^El path no se puede leer/);
    expect(byObject("flat")[0].message).toMatch(/sin área/);
    expect(open.rect).toEqual({ x: 30, y: 0, width: 20, height: 20 });
    expect(open.highlights).toHaveLength(1);
  });

  it("el estado global con un error es Blocking", () => {
    expect(buildReport(result, { state: "done", issues: [] }).status).toBe("blocking");
  });

  it("ordena: errores antes que avisos, por tipo y por posición en el documento", () => {
    const order = result.issues.map((issue) => `${issue.severity}:${issue.kind}`);
    const lastError = order.lastIndexOf("error:invalid_geometry");
    expect(order.indexOf("warning:duplicate_near")).toBeGreaterThan(order.lastIndexOf("error:duplicate_exact"));
    expect(lastError).toBeLessThan(order.indexOf("error:open_path"));
    // Dentro de «geometría inválida», el orden del documento: bowtie, broken, flat.
    expect(result.issues.filter((issue) => issue.kind === "invalid_geometry").map((issue) => issue.objectIds[0])).toEqual(["bowtie", "broken", "flat"]);
  });

  it("es determinista: el mismo documento da los mismos issues en el mismo orden y con los mismos ids", () => {
    const again = run(PROBLEMS);
    expect(again.issues).toEqual(result.issues);
    expect(again.issues.map((issue) => issue.id)).toEqual(result.issues.map((issue) => issue.id));
    expect(new Set(result.issues.map((issue) => issue.id)).size).toBe(result.issues.length);
  });
});

describe("laserCheck — relevancia por operación y alcance", () => {
  const result = run(PROBLEMS);

  it("las capas ignoradas y las ocultas no se analizan (y se informa)", () => {
    expect(result.issues.some((issue) => issue.objectIds.includes("ignored-open"))).toBe(false);
    expect(result.issues.some((issue) => issue.objectIds.includes("hidden-open"))).toBe(false);
    expect(result.scope.ignoredLayers).toEqual(["Ignorada"]);
    expect(result.scope.hiddenLayers).toEqual(["Oculta"]);
    expect(scopeText(result.scope)).toMatch(/Ignoradas por su operación: Ignorada\. Ocultas \(no se analizan\): Oculta\./);
  });

  it("en ENGRAVE un path abierto con relleno es válido, y una línea abierta nunca es «path abierto»", () => {
    expect(result.issues.some((issue) => issue.objectIds.includes("engrave-open"))).toBe(false);
    expect(result.issues.some((issue) => issue.objectIds.includes("engrave-line"))).toBe(false);
    expect(only(documentOf(CUT_A, { A: [line("l", "A", "M0 0 L40 0")] }), "open_path")).toEqual([]);
  });

  it("una capa sin operación se analiza como CUT y cada issue lo indica; además hay un aviso de capa", () => {
    const open = result.issues.find((issue) => issue.objectIds[0] === "free-open")!;
    expect(open.kind).toBe("open_path");
    expect(open.severity).toBe("error");
    expect(open.unassigned).toBe(true);
    expect(open.message).toMatch(/no tiene operación asignada: se analizó como Corte/);
    const layerIssue = result.issues.find((issue) => issue.kind === "unassigned_layer")!;
    expect(layerIssue).toMatchObject({ severity: "warning", layerName: "Libre", objectIds: [], objectLabel: "Capa Libre" });
    expect(layerIssue.rect).toEqual({ x: 200, y: 0, width: 20, height: 20 });
    // Las capas asignadas no llevan la nota.
    expect(result.issues.find((issue) => issue.objectIds[0] === "open")!.unassigned).toBe(false);
  });

  it("una capa BLOQUEADA se analiza (solo lectura)", () => {
    const locked = documentOf([meta("A", { locked: true, name: "Fija" })], { A: [raw("o", "A", "M0 0 H10 V10")] });
    const analysis = run(locked);
    expect(kinds(analysis.issues)).toEqual(["open_path"]);
    expect(analysis.scope.lockedLayers).toEqual(["Fija"]);
  });

  it("un duplicado entre CUT y ENGRAVE es legítimo (cortar y grabar el mismo contorno); entre dos capas CUT no", () => {
    const layers = [meta("A", { order: 0 }), meta("E", { order: 1, manufacturingOperation: "engrave" }), meta("B", { order: 2 })];
    const same = (id: string, layer: string) => square(id, layer, 0, 0, 20);
    expect(only(documentOf(layers, { A: [same("a", "A")], E: [same("e", "E")] }), "duplicate_exact")).toEqual([]);
    const across = only(documentOf(layers, { A: [same("a", "A")], B: [same("b", "B")] }), "duplicate_exact");
    expect(across).toHaveLength(1);
    expect(across[0].objectIds).toEqual(["b", "a"]);
  });

  it("tres copias iguales dan dos issues, ambos contra el original", () => {
    const issues = only(documentOf(CUT_A, { A: [CLEAN, { ...CLEAN, id: "c2" }, { ...CLEAN, id: "c3" }] }), "duplicate_exact");
    expect(issues.map((issue) => issue.objectIds)).toEqual([["c2", "clean"], ["c3", "clean"]]);
  });

  it("los duplicados se comparan con la matriz horneada (mismo contorno por otro camino)", () => {
    const moved = raw("moved", "A", "M0 0 H10 V10 H0 Z", { matrix: { a: 1, b: 0, c: 0, d: 1, e: 5, f: 0 } });
    const baked = raw("baked", "A", "M5 0 H15 V10 H5 Z");
    expect(only(documentOf(CUT_A, { A: [moved, baked] }), "duplicate_exact")).toHaveLength(1);
    const apart = raw("apart", "A", "M6 0 H16 V10 H6 Z");
    expect(only(documentOf(CUT_A, { A: [moved, apart] }), "duplicate_near")).toEqual([]);
  });

  it("un duplicado con otro punto de inicio o sentido contrario sigue siendo duplicado", () => {
    const a = raw("a", "A", "M0 0 H20 V20 H0 Z");
    const b = raw("b", "A", "M20 20 H0 V0 H20 Z");
    expect(only(documentOf(CUT_A, { A: [a, b] }), "duplicate_exact")).toHaveLength(1);
  });

  it("un cuadrado y otro de distinto tamaño no son duplicados", () => {
    expect(kinds(run(documentOf(CUT_A, { A: [CLEAN, square("big", "A", 0, 0, 21)] })).issues)).toEqual([]);
  });
});

describe("laserCheck — umbrales en mm, con y sin escala", () => {
  const thin = (id: string, layer: string, width: number) => square(id, layer, 0, 0, width, 20);
  const docWith = (operation: "cut" | "engrave", width: number) => documentOf([meta("A", { manufacturingOperation: operation })], { A: [thin("t", "A", width)] });

  it("exporta los umbrales documentados: ENGRAVE es más laxo que CUT", () => {
    expect(MIN_DETAIL_CUT_MM).toBe(0.1);
    expect(MIN_DETAIL_ENGRAVE_MM).toBe(0.05);
    expect(MIN_DETAIL_ENGRAVE_MM).toBeLessThan(MIN_DETAIL_CUT_MM);
    expect(CLOSE_TOLERANCE_MM).toBeLessThan(DUPLICATE_NEAR_TOLERANCE_MM);
    expect(DUPLICATE_EXACT_TOLERANCE_MM).toBeLessThan(DUPLICATE_NEAR_TOLERANCE_MM);
  });

  it("detalle: 0,07 mm es muy fino para CUT (0,1) pero no para ENGRAVE (0,05); 0,03 mm lo es para los dos", () => {
    expect(only(docWith("cut", 0.07), "tiny_detail")).toHaveLength(1);
    expect(only(docWith("engrave", 0.07), "tiny_detail")).toHaveLength(0);
    expect(only(docWith("engrave", 0.03), "tiny_detail")).toHaveLength(1);
    expect(only(docWith("cut", 0.1), "tiny_detail")).toHaveLength(0); // justo en el umbral: alcanza
  });

  it("con escala física los umbrales son mm: a 0,5 mm por unidad, 0,15 u = 0,075 mm", () => {
    expect(only(docWith("cut", 0.15), "tiny_detail", 0.5)).toHaveLength(1);
    expect(only(docWith("engrave", 0.15), "tiny_detail", 0.5)).toHaveLength(0);
    expect(only(docWith("cut", 0.25), "tiny_detail", 0.5)).toHaveLength(0); // 0,125 mm
    // Sin escala el mismo 0,15 son 0,15 u: no es fino.
    expect(only(docWith("cut", 0.15), "tiny_detail", null)).toHaveLength(0);
    expect(only(docWith("cut", 0.07), "tiny_detail", null)).toHaveLength(1);
  });

  it("sin escala física avisa que mide en unidades; con escala no hay aviso", () => {
    expect(run(documentOf(CUT_A, { A: [CLEAN] }), null).scaleNotice).toBe(NO_SCALE_CHECK_NOTICE);
    expect(run(documentOf(CUT_A, { A: [CLEAN] }), 0.5).scaleNotice).toBeNull();
    expect(thresholdsText(null)).toMatch(/0\.1 u en Corte y 0\.05 u en Grabado/);
    expect(thresholdsText(0.5)).toMatch(/0\.1 mm en Corte y 0\.05 mm en Grabado/);
  });

  it("el mensaje de detalle expresa el tamaño en mm aunque el documento esté en otras unidades", () => {
    const message = only(docWith("cut", 0.15), "tiny_detail", 0.5)[0].message;
    expect(message).toMatch(/más fino que 0\.1 mm/);
    expect(message).toMatch(/mide 0\.075 mm/);
  });

  it("cierre: un hueco ≤ 0,01 mm se considera cerrado; uno mayor es un path abierto", () => {
    const almost = (gap: number) => documentOf(CUT_A, { A: [raw("o", "A", `M0 0 H20 V20 H0 V${gap}`)] });
    expect(only(almost(0.005), "open_path")).toEqual([]);
    expect(only(almost(0.05), "open_path")).toHaveLength(1);
    // Con escala 0,5: 0,01 mm = 0,02 u.
    expect(only(almost(0.015), "open_path", 0.5)).toEqual([]);
    expect(only(almost(0.05), "open_path", 0.5)).toHaveLength(1);
  });

  it("duplicado exacto ≤ 0,001 mm y casi ≤ 0,05 mm; más allá no es duplicado", () => {
    const shifted = (dx: number) => documentOf(CUT_A, { A: [CLEAN, square("s", "A", dx, 0, 20)] });
    expect(kinds(run(shifted(0.0005)).issues)).toEqual(["duplicate_exact"]);
    expect(kinds(run(shifted(0.03)).issues)).toEqual(["duplicate_near"]);
    expect(kinds(run(shifted(0.2)).issues)).toEqual([]);
    // La misma separación de 0,03 u a 0,5 mm/u son 0,015 mm: sigue siendo «casi».
    expect(kinds(run(shifted(0.03), 0.5).issues)).toEqual(["duplicate_near"]);
    // Y a 2 mm/u son 0,06 mm: ya no.
    expect(kinds(run(shifted(0.03), 2).issues)).toEqual([]);
  });

  it("minimumWidth: ancho de un rectángulo, de una tira girada y de puntos alineados", () => {
    expect(minimumWidth([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 4 }, { x: 0, y: 4 }])).toBeCloseTo(4, 9);
    const strip = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 10.1, y: 9.9 }, { x: 0.1, y: -0.1 }];
    expect(minimumWidth(strip)).toBeLessThan(0.15);
    expect(minimumWidth([{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 10 }])).toBe(0);
  });
});

describe("laserCheck — geometría inválida y otros casos", () => {
  it("una matriz no finita y coordenadas no finitas son geometría inválida", () => {
    const nan = square("nan", "A", 0, 0, 10, 10, { matrix: { a: Number.NaN, b: 0, c: 0, d: 1, e: 0, f: 0 } });
    const inf = square("inf", "A", 0, 0, 10, 10, { matrix: { a: 1e308, b: 0, c: 0, d: 1e308, e: 0, f: 0 } });
    const issues = only(documentOf(CUT_A, { A: [nan, inf] }), "invalid_geometry");
    expect(issues.map((issue) => issue.objectIds[0])).toEqual(["nan", "inf"]);
    expect(issues[0].message).toMatch(/matriz de transformación no es finita/);
  });

  it("un path vacío ('M0 0' suelto) o sin largo es inválido; un moveto suelto entre subformas válidas no", () => {
    expect(only(documentOf(CUT_A, { A: [raw("p", "A", "M5 5")] }), "invalid_geometry")).toHaveLength(1);
    expect(only(documentOf(CUT_A, { A: [raw("p", "A", "M0 0 H10 V10 H0 Z M50 50")] }), "invalid_geometry")).toEqual([]);
    expect(only(documentOf(CUT_A, { A: [line("l", "A", "M5 5 L5 5")] }), "invalid_geometry")).toHaveLength(1);
  });

  it("una subforma cerrada de solo dos puntos es degenerada", () => {
    expect(only(documentOf(CUT_A, { A: [raw("z", "A", "M0 0 L5 5 Z")] }), "invalid_geometry")[0].message).toMatch(/sin área/);
  });

  it("una autointersección en un contorno SIN relleno cerrado también se detecta; en una línea abierta no", () => {
    const outline = { ...raw("o", "A", "M0 0 L20 20 L20 0 L0 20 Z"), fill: "none", stroke: "#00f", strokeWidth: 0.5 };
    expect(only(documentOf(CUT_A, { A: [outline] }), "invalid_geometry")).toHaveLength(1);
    expect(only(documentOf(CUT_A, { A: [line("l", "A", "M0 0 L20 20 L20 0 L0 20")] }), "invalid_geometry")).toEqual([]);
  });

  it("un anillo con hueco (dos subpaths, uno dentro del otro) NO es una autointersección", () => {
    const ring = raw("ring", "A", "M0 0 H40 V40 H0 Z M10 10 H30 V30 H10 Z");
    expect(kinds(run(documentOf(CUT_A, { A: [ring] })).issues)).toEqual([]);
  });

  it("una curva (arco cerrado con Bézier) limpia no genera falsos positivos", () => {
    const blob = raw("blob", "A", "M50 0 C77 0 100 22 100 50 C100 77 77 100 50 100 C22 100 0 77 0 50 C0 22 22 0 50 0 Z");
    expect(kinds(run(documentOf(CUT_A, { A: [blob] })).issues)).toEqual([]);
  });

  it("un lazo en una curva (cúspide que se cruza) es una autointersección", () => {
    const loop = raw("loop", "A", "M0 0 C60 60 -40 60 20 0 Z");
    expect(only(documentOf(CUT_A, { A: [loop] }), "invalid_geometry")).toHaveLength(1);
  });

  it("la autointersección sin presupuesto queda NO VERIFICADA (y nunca Ready)", () => {
    const limited = analyzeLaserLocal(documentOf(CUT_A, { A: [CLEAN] }), { ...MM1, selfIntersectionBudget: { perObject: 0, total: 100 } });
    expect(limited.issues).toEqual([]);
    expect(limited.unverified).toEqual([{ id: "self_intersection", label: "Autointersección", reason: "1 objeto es demasiado complejo para comprobar si se cruzan consigo mismos." }]);
    const report = buildReport(limited, { state: "done", issues: [] });
    expect(report.status).toBe("review");
    expect(reportSummary(report)).toMatch(/No verificado: Autointersección\./);
  });

  it("complejidad: más de 5000 nodos en un objeto es un aviso; sin pasar el umbral no hay aviso", () => {
    const polygon = (id: string, count: number) =>
      raw(id, "A", `${Array.from({ length: count }, (_, i) => `${i === 0 ? "M" : "L"}${(1000 + 1000 * Math.cos((i / count) * 2 * Math.PI)).toFixed(3)} ${(1000 + 1000 * Math.sin((i / count) * 2 * Math.PI)).toFixed(3)}`).join(" ")} Z`);
    const fine = only(documentOf(CUT_A, { A: [polygon("ok", MAX_NODES_PER_OBJECT)] }), "complexity");
    expect(fine).toEqual([]);
    const heavy = only(documentOf(CUT_A, { A: [polygon("heavy", MAX_NODES_PER_OBJECT + 1)] }), "complexity");
    expect(heavy).toHaveLength(1);
    expect(heavy[0]).toMatchObject({ severity: "warning", objectIds: ["heavy"] });
    expect(heavy[0].message).toMatch(/nodos/);
  });

  it("complejidad por capa: la suma de nodos de la capa sobre el umbral es un issue de CAPA (sin objetos)", () => {
    const chunk = (id: string) => raw(id, "A", `M0 0 ${Array.from({ length: 3000 }, (_, i) => `L${i + 1} ${i % 2}`).join(" ")} L3000 100 Z`);
    const count = Math.ceil(MAX_NODES_PER_LAYER / 3000) + 1;
    const objects = Array.from({ length: count }, (_, i) => chunk(`c${i}`));
    const layerIssues = only(documentOf(CUT_A, { A: objects }), "complexity").filter((issue) => issue.objectIds.length === 0);
    expect(layerIssues).toHaveLength(1);
    expect(layerIssues[0].objectLabel).toBe("Capa Corte");
    expect(layerIssues[0].highlights).toEqual([]);
  });

  it("capas sin objetos y documentos vacíos no generan nada", () => {
    expect(run(documentOf(CUT_A, { A: [] })).issues).toEqual([]);
    expect(run({ objectsByLayer: {} }).issues).toEqual([]);
  });

  it("un documento sin estructura de capas trata las capas con objetos como visibles y sin operación", () => {
    const analysis = run({ objectsByLayer: { X: [raw("o", "X", "M0 0 H10 V10")] } });
    expect(kinds(analysis.issues)).toEqual(["open_path", "unassigned_layer"]);
  });
});

describe("laserCheck — dataset limpio y estado global", () => {
  const CLEAN_DOC = documentOf(
    [meta("A", { name: "Corte", order: 0 }), meta("E", { name: "Grabado", order: 1, manufacturingOperation: "engrave" })],
    {
      A: [
        square("a1", "A", 0, 0, 20),
        square("a2", "A", 40, 0, 20),
        raw("blob", "A", "M150 100 C177 100 200 122 200 150 C200 177 177 200 150 200 C122 200 100 177 100 150 C100 122 122 100 150 100 Z"),
        raw("ring", "A", "M300 0 H340 V40 H300 Z M310 10 H330 V30 H310 Z"),
      ],
      E: [raw("e1", "E", "M0 100 H30 V130"), line("e2", "E", "M0 150 L50 150"), square("e3", "E", 0, 200, 30)],
    },
  );

  it("no tiene issues ni checks sin verificar", () => {
    const analysis = run(CLEAN_DOC);
    expect(analysis.issues).toEqual([]);
    expect(analysis.unverified).toEqual([]);
  });

  it("Ready solo cuando las flotantes también se verificaron (sin issues)", () => {
    const analysis = run(CLEAN_DOC);
    expect(buildReport(analysis, { state: "done", issues: [] }).status).toBe("ready");
    expect(buildReport(analysis, { state: "not_applicable" }).status).toBe("ready");
  });

  it("flotantes pendientes o no disponibles = NO VERIFICADO: nunca Ready, siempre Review", () => {
    const analysis = run(CLEAN_DOC);
    const pending = buildReport(analysis, { state: "pending" });
    expect(pending.status).toBe("review");
    expect(pending.unverified).toEqual([{ id: "floating", label: "Piezas flotantes", reason: "analizando en el servidor…" }]);
    const failed = buildReport(analysis, { state: "unavailable", message: "El servidor no respondió." });
    expect(failed.status).toBe("review");
    expect(failed.unverified[0]).toMatchObject({ id: "floating", reason: "El servidor no respondió." });
    expect(reportSummary(failed)).toBe("Laser Check: Review. Sin problemas detectados. No verificado: Piezas flotantes.");
  });

  it("un documento sin nada que analizar (todo oculto, ignorado o vacío) no es Ready: el alcance queda no verificado", () => {
    const hidden = documentOf([meta("A", { visible: false }), meta("I", { manufacturingOperation: "ignore" })], { A: [CLEAN], I: [CLEAN] });
    for (const empty of [hidden, { objectsByLayer: {} }]) {
      const analysis = run(empty);
      expect(analysis.unverified.map((check) => check.id)).toEqual(["scope"]);
      expect(buildReport(analysis, { state: "not_applicable" }).status).toBe("review");
    }
    expect(scopeText(run(hidden).scope)).toBe("Se analizaron 0 capas (0 objetos). Ignoradas por su operación: Capa I. Ocultas (no se analizan): Capa A.");
  });

  it("un check no verificado no tapa un error: con un issue error sigue siendo Blocking", () => {
    const report = buildReport(run(PROBLEMS), { state: "pending" });
    expect(report.status).toBe("blocking");
  });

  it("laserCheckStatus: error => blocking, solo avisos => review, nada => ready, sin issues pero no verificado => review", () => {
    const base = run(PROBLEMS).issues;
    const error = base.find((issue) => issue.severity === "error")!;
    const warning = base.find((issue) => issue.severity === "warning")!;
    expect(laserCheckStatus([error, warning], [])).toBe("blocking");
    expect(laserCheckStatus([warning], [])).toBe("review");
    expect(laserCheckStatus([], [])).toBe("ready");
    expect(laserCheckStatus([], [{ id: "floating", label: "Piezas flotantes", reason: "x" }])).toBe("review");
  });

  it("una capa sin asignar y limpia es Review (sin operación no se puede dar por lista)", () => {
    const doc = documentOf([meta("A", { manufacturingOperation: "unassigned" })], { A: [CLEAN] });
    const report = buildReport(run(doc), { state: "done", issues: [] });
    expect(kinds(report.issues)).toEqual(["unassigned_layer"]);
    expect(report.status).toBe("review");
  });

  it("solo avisos (casi duplicado o detalle fino) => Review", () => {
    const doc = documentOf(CUT_A, { A: [CLEAN, square("near", "A", 0.02, 0, 20), square("thin", "A", 100, 0, 0.05, 20)] });
    const report = buildReport(run(doc), { state: "done", issues: [] });
    expect(report.counts).toEqual({ errors: 0, warnings: 2 });
    expect(report.status).toBe("review");
    expect(reportSummary(report)).toBe("Laser Check: Review. 0 bloqueantes y 2 avisos.");
  });
});

describe("laserCheck — huella del documento", () => {
  const base = documentOf(CUT_A, { A: [CLEAN] });

  it("igual contenido y escala => igual huella", () => {
    expect(documentFingerprint(base, 1)).toBe(documentFingerprint(base, 1));
    expect(run(base).fingerprint).toBe(documentFingerprint(base, 1));
  });

  it("cambia al reemplazar un objeto (otra referencia), al agregar uno, al cambiar la operación, la visibilidad o la escala", () => {
    const fingerprint = documentFingerprint(base, 1);
    expect(documentFingerprint(documentOf(CUT_A, { A: [{ ...CLEAN }] }), 1)).not.toBe(fingerprint);
    expect(documentFingerprint(documentOf(CUT_A, { A: [CLEAN, square("b", "A", 40, 0, 20)] }), 1)).not.toBe(fingerprint);
    expect(documentFingerprint(documentOf([meta("A", { name: "Corte", manufacturingOperation: "engrave" })], { A: [CLEAN] }), 1)).not.toBe(fingerprint);
    expect(documentFingerprint(documentOf([meta("A", { name: "Corte", visible: false })], { A: [CLEAN] }), 1)).not.toBe(fingerprint);
    expect(documentFingerprint(base, 0.5)).not.toBe(fingerprint);
    expect(documentFingerprint(base, null)).not.toBe(fingerprint);
  });
});

describe("laserCheck — piezas flotantes (S11) como issues", () => {
  const ring = (id: string, layer: string, x: number): EditorObject => raw(id, layer, `M${x} 0 H${x + 40} V40 H${x} Z M${x + 10} 10 H${x + 30} V30 H${x + 10} Z`);
  const doc = documentOf([meta("A", { name: "Rojo", order: 0 }), meta("B", { name: "Azul", order: 1, manufacturingOperation: "unassigned" })], { A: [ring("r1", "A", 0)], B: [ring("b1", "B", 200)] });
  const closed = (x: number, y: number, w: number): GeometryPoint[] => [[x, y], [x + w, y], [x + w, y + w], [x, y + w], [x, y]];
  const SHEET: FloatingComponent = { id: 0, kind: "principal", depth: 0, parent: null, polygon: null, area: null, bounds: [0, 0, 240, 40], subjects: [] };
  const island = (id: number, x: number, subjects: number[]): FloatingComponent => ({ id, kind: "floating", depth: 1, parent: 0, polygon: { type: "polygon", coordinates: [closed(x, 10, 20)] }, area: 400, bounds: [x, 10, x + 20, 30], subjects });

  function analysisFor(components: FloatingComponent[]) {
    const planned = planFloating(analyzeLaserLocal(doc, { mmFactor: 0.5 }).floatingTargets, doc, { mode: LASER_CHECK_FLOATING_MODE, mmFactor: 0.5 });
    if (!planned.ok) throw new Error(planned.message);
    const response: FloatingResponse = {
      mode: planned.plan.mode,
      tolerance: planned.plan.request.tolerance,
      components,
      floatingCount: components.filter((component) => component.kind === "floating").length,
      mainCount: 1,
      discarded: 0,
    };
    const analysis = floatingAnalysis(planned.plan, response);
    if (!analysis.ok) throw new Error(analysis.error);
    return { plan: planned.plan, analysis: analysis.analysis };
  }

  it("el modo de S11 es el stencil por defecto y los objetivos son los objetos con relleno de capas CUT/unassigned visibles", () => {
    expect(LASER_CHECK_FLOATING_MODE).toBe("stencil");
    expect(analyzeLaserLocal(doc, { mmFactor: 0.5 }).floatingTargets.map((object) => object.id)).toEqual(["r1", "b1"]);
    const engraveOnly = documentOf([meta("E", { manufacturingOperation: "engrave" })], { E: [ring("e", "E", 0)] });
    expect(analyzeLaserLocal(engraveOnly, { mmFactor: 0.5 }).floatingTargets).toEqual([]);
    const lines = documentOf(CUT_A, { A: [line("l", "A", "M0 0 L10 0")] });
    expect(analyzeLaserLocal(lines, { mmFactor: 0.5 }).floatingTargets).toEqual([]);
  });

  it("cada isla es un issue de error en la capa del objeto que la rodea, con su polígono y su rectángulo", () => {
    const { plan, analysis } = analysisFor([SHEET, island(1, 10, [0]), island(2, 210, [1])]);

    const issues = floatingIssues(plan, analysis, doc);

    expect(issues.map((issue) => [issue.kind, issue.severity, issue.layerName, issue.objectLabel, issue.objectIds])).toEqual([
      ["floating", "error", "Rojo", "Isla 1", ["r1"]],
      ["floating", "error", "Azul", "Isla 2", ["b1"]],
    ]);
    expect(issues[0].rect).toEqual({ x: 10, y: 10, width: 20, height: 20 });
    expect(issues[0].highlights).toHaveLength(1);
    expect(issues[0].highlights[0].matrix).toEqual(IDENTITY_MATRIX);
    expect(issues[0].message).toMatch(/Isla 1 · 100 mm² · rodeada por «Rojo · objeto 1»\. Se cae al cortar\./);
    expect(issues[0].suggestion).toBe("Agregar un bridge que la conecte (herramienta Flotantes) o descartarla.");
    // La capa «Azul» no tiene operación: el issue lo dice.
    expect(issues[1].unassigned).toBe(true);
    expect(issues[0].unassigned).toBe(false);
  });

  it("se integran con los locales (errores primero) y llevan el estado a Blocking; sin islas, Ready", () => {
    const local = analyzeLaserLocal(documentOf([meta("A", { name: "Rojo" })], { A: [ring("r1", "A", 0)] }), { mmFactor: 0.5 });
    const { plan, analysis } = analysisFor([SHEET, island(1, 10, [0])]);
    const issues = floatingIssues(plan, analysis, doc);

    const withIsland = buildReport(local, { state: "done", issues });
    expect(withIsland.status).toBe("blocking");
    expect(withIsland.issues.map((issue) => issue.kind)).toEqual(["floating"]);
    expect(buildReport(local, { state: "done", issues: [] }).status).toBe("ready");
  });
});
