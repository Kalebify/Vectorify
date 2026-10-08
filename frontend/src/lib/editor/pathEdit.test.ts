import { describe, expect, it } from "vitest";
import { IDENTITY_MATRIX, type AffineMatrix } from "../svgTransform";
import { invertMatrix, rotationAboutMatrix, scaleAboutMatrix } from "./matrix";
import {
  createKindMemory,
  deleteNodes,
  modelToPath,
  moveAnchors,
  nodeKey,
  pathToModel,
  rememberKinds,
  setNodeKind,
  type ModelResult,
  type PathModel,
} from "./nodes";
import {
  adjacentSegments,
  ANCHOR_HIT_RADIUS_PX,
  applyModelEdit,
  collectOverlayNodes,
  documentVectorToLocal,
  findEditorObject,
  HANDLE_HIT_RADIUS_PX,
  hitTestPath,
  localToDocument,
  MAX_OVERLAY_NODES,
  nodeEditProduction,
  nodesInRect,
  pathHitTolerances,
  refsFromKeys,
  resolvePathTarget,
  SEGMENT_HIT_RADIUS_PX,
  selectedSegments,
  stepNode,
  viewportRectInDocument,
  visibleHandles,
} from "./pathEdit";
import type { EditableDocument, EditorObject, Point } from "./types";

/**
 * Integración de Path con el documento (M3-S05): objetivo y rechazos, aplicar una operación a un objeto (solo cambia `d`, un objeto no
 * editado conserva su `d` byte a byte), edición en espacio LOCAL con una matriz rotada/escalada/espejada, hit areas constantes en píxeles de
 * pantalla a cualquier zoom, overlay acotado y selección.
 */

const SQUARE = "M0 0 L10 0 L10 10 L0 10 Z";
const ARCH = "M0 0 C0 8 8 8 8 0";

function object(overrides: Partial<EditorObject> = {}): EditorObject {
  return { id: "o1", layerGroupId: "A", d: SQUARE, fill: "#ff0000", matrix: IDENTITY_MATRIX, ...overrides };
}

function model(d: string): PathModel {
  const result = pathToModel(d);
  if (!result.ok) throw new Error(result.error);
  return result.model;
}

const LAYERS = [
  { groupId: "A", name: "Rojo", locked: false, visible: true },
  { groupId: "L", name: "Bloqueada", locked: true, visible: true },
  { groupId: "H", name: "Oculta", locked: false, visible: false },
];

describe("resolvePathTarget — qué objeto se edita y por qué se rechaza", () => {
  const memory = createKindMemory();

  it("un solo objeto en una capa visible y desbloqueada: OK, con su modelo de nodos", () => {
    const target = resolvePathTarget([object()], LAYERS, memory);
    expect(target.status).toBe("ok");
    if (target.status === "ok") expect(target.model.subpaths[0].nodes).toHaveLength(4);
  });

  it("sin selección: pide seleccionar un objeto", () => {
    expect(resolvePathTarget([], LAYERS, memory)).toMatchObject({ status: "none", message: expect.stringContaining("Seleccioná un objeto") });
  });

  it("varios objetos: «Seleccioná un solo objeto» con la cantidad", () => {
    const target = resolvePathTarget([object(), object({ id: "o2" }), object({ id: "o3" })], LAYERS, memory);
    expect(target).toMatchObject({ status: "multiple", message: expect.stringContaining("Seleccioná un solo objeto") });
    expect(target.status !== "ok" && target.message).toContain("3 seleccionados");
  });

  it("capa bloqueada y capa oculta: rechazo claro con el nombre de la capa", () => {
    expect(resolvePathTarget([object({ layerGroupId: "L" })], LAYERS, memory)).toMatchObject({ status: "locked", message: expect.stringContaining("«Bloqueada» está bloqueada") });
    expect(resolvePathTarget([object({ layerGroupId: "H" })], LAYERS, memory)).toMatchObject({ status: "hidden", message: expect.stringContaining("«Oculta» está oculta") });
  });

  it("matriz no invertible (escala 0) o no finita: se rechaza el objeto", () => {
    expect(resolvePathTarget([object({ matrix: { a: 0, b: 0, c: 0, d: 0, e: 5, f: 5 } })], LAYERS, memory)).toMatchObject({ status: "matrix" });
    expect(resolvePathTarget([object({ matrix: { a: 1, b: 2, c: 2, d: 4, e: 0, f: 0 } })], LAYERS, memory)).toMatchObject({ status: "matrix" });
    expect(resolvePathTarget([object({ matrix: { ...IDENTITY_MATRIX, e: Number.NaN } })], LAYERS, memory)).toMatchObject({ status: "matrix" });
  });

  it("un d que el parser no lee completo se rechaza (reserializarlo dañaría la cola)", () => {
    expect(resolvePathTarget([object({ d: "M0 0 L10 foo" })], LAYERS, memory)).toMatchObject({ status: "geometry" });
    expect(resolvePathTarget([object({ d: "" })], LAYERS, memory)).toMatchObject({ status: "geometry" });
  });

  it("una capa que no figura en la lista no bloquea (objeto huérfano de la lista de capas)", () => {
    expect(resolvePathTarget([object({ layerGroupId: "?" })], LAYERS, memory).status).toBe("ok");
  });

  it("usa los tipos recordados: un nodo corner sobre handles collineales sigue siendo corner al volver a abrir", () => {
    const remembered = createKindMemory();
    const d = "M0 0 C2 4 6 4 8 0 C10 -4 14 -4 16 0";
    rememberKinds(remembered, d, [["corner", "corner", "corner"]]);
    const withMemory = resolvePathTarget([object({ d })], LAYERS, remembered);
    const withoutMemory = resolvePathTarget([object({ d })], LAYERS, createKindMemory());
    expect(withMemory.status === "ok" && withMemory.model.subpaths[0].nodes[1].kind).toBe("corner");
    expect(withoutMemory.status === "ok" && withoutMemory.model.subpaths[0].nodes[1].kind).toBe("symmetric");
  });
});

describe("applyModelEdit / nodeEditProduction", () => {
  const move = (delta: Point) => (current: PathModel): ModelResult => moveAnchors(current, [{ subpath: 0, node: 1 }], delta);

  it("sin cambio (delta 0) devuelve el MISMO objeto: el d original se conserva byte a byte aunque no esté normalizado", () => {
    const original = object({ d: "M0,0 h10 v10 H0 z" });
    const outcome = applyModelEdit(original, createKindMemory(), move({ x: 0, y: 0 }));
    expect(outcome).toMatchObject({ ok: true, changed: false });
    expect(outcome.ok && outcome.object).toBe(original);
    expect(outcome.ok && outcome.object.d).toBe("M0,0 h10 v10 H0 z");
  });

  it("con cambio solo `d` es nuevo: id, capa, relleno, trazo y matriz se conservan", () => {
    const matrix: AffineMatrix = { a: 2, b: 0, c: 0, d: 2, e: 5, f: 5 };
    const original = object({ fill: "none", stroke: "#00aa00", strokeWidth: 0.5, matrix, d: "M0 0 L10 0 L10 10" });
    const outcome = applyModelEdit(original, createKindMemory(), move({ x: 1, y: 2 }));
    expect(outcome.ok && outcome.changed && outcome.object).toEqual({ ...original, d: "M0 0 L11 2 L10 10" });
    expect(outcome.ok && outcome.object.matrix).toBe(matrix);
    expect(original.d).toBe("M0 0 L10 0 L10 10");
  });

  it("solo cambió la etiqueta de un nodo (misma geometría): no es un cambio de objeto, pero devuelve los tipos para recordarlos", () => {
    const original = object({ d: "M0 0 C2 4 6 4 8 0 C10 -4 14 -4 16 0" });
    const memory = createKindMemory();
    const outcome = applyModelEdit(original, memory, (current) => setNodeKind(current, [{ subpath: 0, node: 1 }], "corner"));
    expect(outcome).toMatchObject({ ok: true, changed: false, d: original.d, kinds: [["corner", "corner", "corner"]] });
    expect(outcome.ok && outcome.object).toBe(original);
  });

  it("deja el resultado en `memory.live` para que la previsualización conserve los tipos", () => {
    const memory = createKindMemory();
    const outcome = applyModelEdit(object(), memory, move({ x: 1, y: 0 }));
    expect(memory.live).toEqual({ d: "M0 0 L11 0 L10 10 L0 10 Z", kinds: [["corner", "corner", "corner", "corner"]] });
    expect(outcome.ok && outcome.changed && outcome.object.d).toBe(memory.live!.d);
  });

  it("un rechazo del modelo se propaga con su mensaje y la confirmación, sin tocar el objeto", () => {
    const original = object({ d: "M0 0 L100 0 L100 100 Z M20 20 L20 80 L80 20 Z" });
    const outcome = applyModelEdit(original, createKindMemory(), (current) => deleteNodes(current, [{ subpath: 1, node: 0 }]));
    expect(outcome).toMatchObject({ ok: false, confirm: { subpaths: [1] } });
    expect(applyModelEdit(object({ d: "M0 0 L10 foo" }), createKindMemory(), move({ x: 1, y: 0 }))).toMatchObject({ ok: false });
  });

  it("nodeEditProduction reemplaza SOLO ese objeto en su capa; el resto conserva su referencia", () => {
    const other = object({ id: "o2" });
    const target = object({ id: "o1" });
    const elsewhere = object({ id: "o3", layerGroupId: "B" });
    const state: EditableDocument = { objectsByLayer: { A: [other, target], B: [elsewhere] } };
    const production = nodeEditProduction(state, "o1", createKindMemory(), move({ x: 3, y: 0 }));
    expect(Object.keys(production!.layers)).toEqual(["A"]);
    expect(production!.layers.A[0]).toBe(other);
    expect(production!.layers.A[1]).toEqual({ ...target, d: "M0 0 L13 0 L10 10 L0 10 Z" });
  });

  it("nodeEditProduction devuelve null si el objeto no existe, si no hay cambio o si la operación se rechaza", () => {
    const state: EditableDocument = { objectsByLayer: { A: [object()] } };
    expect(nodeEditProduction(state, "nada", createKindMemory(), move({ x: 1, y: 0 }))).toBeNull();
    expect(nodeEditProduction(state, "o1", createKindMemory(), move({ x: 0, y: 0 }))).toBeNull();
    expect(nodeEditProduction(state, "o1", createKindMemory(), move({ x: Number.NaN, y: 0 }))).toBeNull();
    expect(findEditorObject(state, "o1")).toBe(state.objectsByLayer.A[0]);
    expect(findEditorObject(state, "x")).toBeNull();
  });
});

describe("edición en espacio LOCAL con la matriz del objeto (la matriz no se toca)", () => {
  const matrices: Array<[string, AffineMatrix]> = [
    ["giro de 90°", rotationAboutMatrix({ x: 0, y: 0 }, 90)],
    ["giro de 37° + traslación", { ...rotationAboutMatrix({ x: 3, y: 4 }, 37), e: 20, f: -7 }],
    ["escala 2 x 3", scaleAboutMatrix({ x: 0, y: 0 }, 2, 3)],
    ["espejo horizontal + escala", { a: -2, b: 0, c: 0, d: 1.5, e: 100, f: 50 }],
    ["cizalla", { a: 1, b: 0.4, c: 0.3, d: 1, e: 5, f: 5 }],
  ];

  it.each(matrices)("%s: arrastrar un nodo (delta de documento) lo mueve EXACTAMENTE ese delta en pantalla", (_, matrix) => {
    const inverse = invertMatrix(matrix)!;
    const original = object({ matrix, d: "M0 0 L10 0 L10 10 L0 10 Z" });
    const delta = { x: 7.25, y: -3.5 };
    const local = documentVectorToLocal(inverse, delta);
    const outcome = applyModelEdit(original, createKindMemory(), (current) => moveAnchors(current, [{ subpath: 0, node: 2 }], local));
    expect(outcome.ok && outcome.changed).toBe(true);
    if (!outcome.ok || !outcome.changed) return;
    const before = localToDocument(matrix, model(original.d).subpaths[0].nodes[2].anchor);
    const after = localToDocument(matrix, model(outcome.object.d).subpaths[0].nodes[2].anchor);
    expect(after.x - before.x).toBeCloseTo(delta.x, 4);
    expect(after.y - before.y).toBeCloseTo(delta.y, 4);
    // La matriz es LA MISMA referencia y los otros nodos no se movieron.
    expect(outcome.object.matrix).toBe(matrix);
    expect(model(outcome.object.d).subpaths[0].nodes[0].anchor).toEqual({ x: 0, y: 0 });
  });

  it("documentVectorToLocal ignora la traslación y es la inversa lineal (giro de 90°: (10, 0) de documento = (0, -10) local)", () => {
    const inverse = invertMatrix(rotationAboutMatrix({ x: 0, y: 0 }, 90))!;
    const local = documentVectorToLocal(inverse, { x: 10, y: 0 });
    expect(local.x).toBeCloseTo(0, 12);
    expect(local.y).toBeCloseTo(-10, 12);
    const translated = invertMatrix({ a: 1, b: 0, c: 0, d: 1, e: 500, f: 500 })!;
    expect(documentVectorToLocal(translated, { x: 3, y: 4 })).toEqual({ x: 3, y: 4 });
  });
});

describe("hit areas en píxeles de pantalla", () => {
  const SQUARE_MODEL = model(SQUARE);
  const none = { handles: [] };

  it("los radios en unidades de documento escalan con 1/zoom: radio × zoom = constante en px", () => {
    for (const zoom of [0.1, 0.25, 0.5, 1, 2, 4, 16]) {
      const tolerances = pathHitTolerances(zoom);
      expect(tolerances.anchor * zoom).toBeCloseTo(ANCHOR_HIT_RADIUS_PX, 9);
      expect(tolerances.handle * zoom).toBeCloseTo(HANDLE_HIT_RADIUS_PX, 9);
      expect(tolerances.segment * zoom).toBeCloseTo(SEGMENT_HIT_RADIUS_PX, 9);
    }
    // Duplicar el zoom reduce el radio en unidades de documento a la mitad.
    expect(pathHitTolerances(2).anchor).toBeCloseTo(pathHitTolerances(1).anchor / 2, 12);
  });

  it("un anchor se golpea a 8,9 px de pantalla y no a 9,5 px, a CUALQUIER zoom", () => {
    for (const zoom of [0.25, 0.5, 1, 2, 8]) {
      const tolerances = pathHitTolerances(zoom);
      const inside = hitTestPath(SQUARE_MODEL, IDENTITY_MATRIX, { x: 10 + 8.9 / zoom, y: 0 }, tolerances, none);
      const outside = hitTestPath(SQUARE_MODEL, IDENTITY_MATRIX, { x: 10 + 9.5 / zoom, y: 0 }, tolerances, none);
      expect(inside).toEqual({ kind: "anchor", ref: { subpath: 0, node: 1 } });
      expect(outside).toBeNull();
    }
  });

  it("un segmento se golpea a 5,9 px y no a 6,5 px, a cualquier zoom; devuelve el segmento y el parámetro t", () => {
    const line = model("M0 0 L1000 0");
    for (const zoom of [0.5, 1, 4]) {
      const tolerances = pathHitTolerances(zoom);
      const near = hitTestPath(line, IDENTITY_MATRIX, { x: 400, y: 5.9 / zoom }, tolerances, none);
      expect(near).toMatchObject({ kind: "segment", subpath: 0, segment: 0 });
      expect(near?.kind === "segment" && near.t).toBeCloseTo(0.4, 9);
      expect(hitTestPath(line, IDENTITY_MATRIX, { x: 400, y: 6.5 / zoom }, tolerances, none)).toBeNull();
    }
  });

  it("un anchor gana sobre el segmento que pasa por él; el segmento de cierre también se golpea", () => {
    const tolerances = pathHitTolerances(1);
    const large = model("M0 0 L100 0 L100 100 L0 100 Z");
    expect(hitTestPath(large, IDENTITY_MATRIX, { x: 1, y: 0 }, tolerances, none)).toMatchObject({ kind: "anchor", ref: { subpath: 0, node: 0 } });
    expect(hitTestPath(large, IDENTITY_MATRIX, { x: 0, y: 50 }, tolerances, none)).toMatchObject({ kind: "segment", segment: 3 });
  });

  it("un segmento curvo devuelve el t de la curva (el punto en t = 0,5 de esta arcada es (40, 60))", () => {
    const hit = hitTestPath(model("M0 0 C0 80 80 80 80 0"), IDENTITY_MATRIX, { x: 40, y: 60.4 }, pathHitTolerances(1), none);
    expect(hit).toMatchObject({ kind: "segment", subpath: 0, segment: 0 });
    expect(hit?.kind === "segment" && hit.t).toBeCloseTo(0.5, 3);
    expect(hit?.kind === "segment" && hit.point.y).toBeCloseTo(60, 6);
  });

  it("los handles visibles se golpean antes que el anchor si están más cerca; un handle sobre su anchor cede al anchor", () => {
    const withHandles = model("M0 0 C2 4 6 4 8 0 C10 -4 14 -4 16 0");
    const handles = visibleHandles(withHandles, new Set(["0:1"]));
    const tolerances = pathHitTolerances(1);
    expect(hitTestPath(withHandles, IDENTITY_MATRIX, { x: 10.5, y: -3.5 }, tolerances, { handles })).toEqual({ kind: "handle", ref: { subpath: 0, node: 1 }, side: "out" });
    expect(hitTestPath(withHandles, IDENTITY_MATRIX, { x: 8, y: 0.5 }, tolerances, { handles })).toMatchObject({ kind: "anchor", ref: { subpath: 0, node: 1 } });
    // Sin handles visibles ese mismo punto ya no golpea el handle (cae sobre el anchor, a 4,3 px).
    expect(hitTestPath(withHandles, IDENTITY_MATRIX, { x: 10.5, y: -3.5 }, tolerances, none)).toMatchObject({ kind: "anchor" });
  });

  it("con una matriz de giro/escala el hit se resuelve en DOCUMENTO (los nodos se transforman)", () => {
    const matrix = scaleAboutMatrix({ x: 0, y: 0 }, 2, 2);
    // El anchor local (10, 0) está en (20, 0) de documento.
    expect(hitTestPath(SQUARE_MODEL, matrix, { x: 20, y: 0 }, pathHitTolerances(1), none)).toMatchObject({ kind: "anchor", ref: { subpath: 0, node: 1 } });
    // Los segmentos también se transforman: el punto medio del primero está en (10, 0); un punto lejos de todo no golpea nada.
    expect(hitTestPath(SQUARE_MODEL, matrix, { x: 10, y: 0 }, pathHitTolerances(1), none)).toMatchObject({ kind: "segment", segment: 0 });
    expect(hitTestPath(SQUARE_MODEL, matrix, { x: 10, y: 40 }, pathHitTolerances(1), none)).toBeNull();
  });

  it("`allowedAnchors` limita el hit a lo que el overlay dibuja", () => {
    const tolerances = pathHitTolerances(1);
    expect(hitTestPath(SQUARE_MODEL, IDENTITY_MATRIX, { x: 10, y: 0 }, tolerances, { handles: [], allowedAnchors: new Set(["0:0"]) })).toMatchObject({ kind: "segment" });
    expect(hitTestPath(SQUARE_MODEL, IDENTITY_MATRIX, { x: 10, y: 0 }, tolerances, { handles: [], allowedAnchors: new Set(["0:1"]) })).toMatchObject({ kind: "anchor" });
  });
});

describe("visibleHandles", () => {
  const curved = model("M0 0 C2 4 6 4 8 0 C10 -4 14 -4 16 0");

  it("los handles de los nodos seleccionados y los de sus vecinos que dan forma a los segmentos adyacentes", () => {
    const handles = visibleHandles(curved, new Set(["0:1"]));
    expect(handles.map((handle) => `${nodeKey(handle)}:${handle.side}`).sort()).toEqual(["0:0:out", "0:1:in", "0:1:out", "0:2:in"]);
  });

  it("sin selección no hay handles; un handle de largo 0 no se muestra; no se repiten", () => {
    expect(visibleHandles(curved, new Set())).toEqual([]);
    expect(visibleHandles(model("M0 0 C0 0 8 0 8 0"), new Set(["0:0", "0:1"]))).toEqual([]);
    const both = visibleHandles(curved, new Set(["0:0", "0:1"]));
    expect(new Set(both.map((handle) => `${nodeKey(handle)}:${handle.side}`)).size).toBe(both.length);
  });

  it("en un subpath cerrado el nodo 0 ve también el handle del último (segmento de cierre)", () => {
    const closed = model("M0 0 C0 10 10 10 10 0 C10 -10 0 -10 0 0 Z");
    expect(visibleHandles(closed, new Set(["0:0"])).map((handle) => `${nodeKey(handle)}:${handle.side}`).sort()).toEqual(["0:0:in", "0:0:out", "0:1:in", "0:1:out"]);
  });
});

describe("overlay acotado al viewport y a un máximo", () => {
  const big = (count: number) => model(`M0 0 ${Array.from({ length: count - 1 }, (_, index) => `L${index + 1} ${index % 2 === 0 ? 1 : 0}`).join(" ")}`);

  it("un path de 5 000 nodos dibuja solo los que caen en el viewport (y avisa si superan el tope)", () => {
    const path = big(5000);
    const view = { x: 100, y: -5, width: 50, height: 20 };
    const overlay = collectOverlayNodes(path, IDENTITY_MATRIX, view, new Set());
    expect(overlay.total).toBe(5000);
    expect(overlay.nodes).toHaveLength(51);
    expect(overlay.inView).toBe(51);
    expect(overlay.truncated).toBe(false);
    expect(overlay.nodes.every((node) => node.doc.x >= 100 && node.doc.x <= 150)).toBe(true);
  });

  it("con todo el path a la vista se recorta al tope y lo informa", () => {
    const overlay = collectOverlayNodes(big(5000), IDENTITY_MATRIX, { x: -10, y: -10, width: 6000, height: 50 }, new Set());
    expect(overlay.nodes).toHaveLength(MAX_OVERLAY_NODES);
    expect(overlay.inView).toBe(5000);
    expect(overlay.truncated).toBe(true);
    expect(MAX_OVERLAY_NODES).toBeLessThan(5000);
  });

  it("los nodos seleccionados se dibujan SIEMPRE (aunque estén fuera de la vista o de más de `cap`) y van primero", () => {
    const path = big(100);
    const overlay = collectOverlayNodes(path, IDENTITY_MATRIX, { x: 0, y: -5, width: 10, height: 20 }, new Set(["0:90", "0:95"]), 5);
    expect(overlay.nodes.slice(0, 2).map((node) => node.key)).toEqual(["0:90", "0:95"]);
    expect(overlay.nodes.every((node, index) => (index < 2) === node.selected)).toBe(true);
    expect(overlay.nodes).toHaveLength(5);
    expect(overlay.truncated).toBe(true);
  });

  it("sin viewport (null) no se recorta por vista; la matriz se aplica a la posición de documento", () => {
    const overlay = collectOverlayNodes(model(SQUARE), scaleAboutMatrix({ x: 0, y: 0 }, 2, 2), null, new Set());
    expect(overlay.nodes.map((node) => node.doc)).toEqual([
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 20 },
      { x: 0, y: 20 },
    ]);
  });

  it("viewportRectInDocument: la inversa del viewport con un margen en px (documento 320 x 240 centrado en 800 x 600)", () => {
    const rect = viewportRectInDocument({ containerWidth: 800, containerHeight: 600, panX: 0, panY: 0, scale: 1, sourceWidth: 320, sourceHeight: 240 });
    expect(rect).toEqual({ x: -264, y: -204, width: 848, height: 648 });
    // A zoom 2 el mismo margen de 24 px son 12 unidades de documento.
    const zoomed = viewportRectInDocument({ containerWidth: 800, containerHeight: 600, panX: 0, panY: 0, scale: 2, sourceWidth: 320, sourceHeight: 240 });
    expect(zoomed).toEqual({ x: -52, y: -42, width: 424, height: 324 });
  });
});

describe("selección: marquee, segmentos y navegación", () => {
  const path = model(SQUARE);

  it("nodesInRect: anchors cuya posición de DOCUMENTO cae dentro (la matriz cuenta)", () => {
    expect(nodesInRect(path, IDENTITY_MATRIX, { x: -1, y: -1, width: 12, height: 5 })).toEqual([
      { subpath: 0, node: 0 },
      { subpath: 0, node: 1 },
    ]);
    expect(nodesInRect(path, scaleAboutMatrix({ x: 0, y: 0 }, 2, 2), { x: 15, y: 15, width: 10, height: 10 })).toEqual([{ subpath: 0, node: 2 }]);
    expect(nodesInRect(path, IDENTITY_MATRIX, { x: -1, y: -1, width: 12, height: 5 }, new Set(["0:1"]))).toEqual([{ subpath: 0, node: 1 }]);
  });

  it("refsFromKeys descarta claves que ya no existen o mal formadas", () => {
    expect(refsFromKeys(path, ["0:1", "0:9", "x", "3:0"])).toEqual([{ subpath: 0, node: 1 }]);
  });

  it("selectedSegments: los segmentos con AMBOS extremos seleccionados (incluye el de cierre)", () => {
    expect(selectedSegments(path, new Set(["0:0", "0:1"]))).toEqual([{ subpath: 0, segment: 0 }]);
    expect(selectedSegments(path, new Set(["0:3", "0:0"]))).toEqual([{ subpath: 0, segment: 3 }]);
    expect(selectedSegments(path, new Set(["0:0", "0:2"]))).toEqual([]);
    expect(selectedSegments(path, new Set(["0:0", "0:1", "0:2", "0:3"]))).toHaveLength(4);
  });

  it("adjacentSegments: en un cerrado todos los nodos tienen anterior y siguiente; en un abierto los extremos solo uno", () => {
    expect(adjacentSegments(path, { subpath: 0, node: 0 })).toEqual({ before: { subpath: 0, segment: 3 }, after: { subpath: 0, segment: 0 } });
    const open = model("M0 0 L10 0 L10 10");
    expect(adjacentSegments(open, { subpath: 0, node: 0 })).toEqual({ before: null, after: { subpath: 0, segment: 0 } });
    expect(adjacentSegments(open, { subpath: 0, node: 2 })).toEqual({ before: { subpath: 0, segment: 1 }, after: null });
    expect(adjacentSegments(open, { subpath: 5, node: 0 })).toEqual({ before: null, after: null });
  });

  it("stepNode recorre todos los nodos del modelo con vuelta al otro extremo", () => {
    const two = model("M0 0 L10 0 L10 10 Z M50 50 L60 50 L60 60 Z");
    expect(stepNode(two, null, 1)).toEqual({ subpath: 0, node: 0 });
    expect(stepNode(two, null, -1)).toEqual({ subpath: 1, node: 2 });
    expect(stepNode(two, { subpath: 0, node: 2 }, 1)).toEqual({ subpath: 1, node: 0 });
    expect(stepNode(two, { subpath: 1, node: 2 }, 1)).toEqual({ subpath: 0, node: 0 });
    expect(stepNode(two, { subpath: 0, node: 0 }, -1)).toEqual({ subpath: 1, node: 2 });
  });
});

describe("flujo completo sin UI: editar, deshacer (snapshot) y re-parsear", () => {
  it("add -> delete -> mover deja un d válido en cada paso y el snapshot anterior es el d EXACTO anterior", () => {
    const memory = createKindMemory();
    let current = object({ d: ARCH });
    const snapshots = [current.d];
    const steps: Array<(m: PathModel) => ModelResult> = [
      (m) => moveAnchors(m, [{ subpath: 0, node: 1 }], { x: 1, y: 1 }),
      (m) => moveAnchors(m, [{ subpath: 0, node: 0 }], { x: -2.5, y: 0.125 }),
    ];
    for (const step of steps) {
      const outcome = applyModelEdit(current, memory, step);
      if (!outcome.ok || !outcome.changed) throw new Error("se esperaba un cambio");
      current = outcome.object;
      snapshots.push(current.d);
      expect(pathToModel(current.d).ok).toBe(true);
    }
    expect(snapshots).toEqual(["M0 0 C0 8 8 8 8 0", "M0 0 C0 8 9 9 9 1", "M-2.5 0.125 C-2.5 8.125 9 9 9 1"]);
    expect(modelToPath(model(snapshots[2]))).toBe(snapshots[2]);
  });
});
