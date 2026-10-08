import { describe, expect, it } from "vitest";
import type { BooleanResponse, GeometryPiece } from "../../types/geometry";
import { IDENTITY_MATRIX } from "../svgTransform";
import { applyEraseResult, eraseLabel, eraseNotice, objectsAlongPath, planGeometryErase, planObjectErase, strokeSamples, type EraseOptions, type ErasePlan } from "./erase";
import type { EditableDocument, EditableLayerMeta, EditorObject, Point } from "./types";

const p = (x: number, y: number): Point => ({ x, y });

function meta(groupId: string, overrides: Partial<EditableLayerMeta> = {}): EditableLayerMeta {
  return { groupId, name: `Capa ${groupId}`, colorHex: "#ff0000", order: 0, visible: true, locked: false, manufacturingOperation: "unassigned", isNew: false, ...overrides };
}

function rect(id: string, layerGroupId: string, x: number, y: number, size: number, overrides: Partial<EditorObject> = {}): EditorObject {
  return { id, layerGroupId, d: `M${x} ${y} H${x + size} V${y + size} H${x} Z`, fill: "#ff0000", matrix: IDENTITY_MATRIX, ...overrides };
}

function stateOf(objectsByLayer: Record<string, EditorObject[]>, layers: EditableLayerMeta[]): EditableDocument {
  return { objectsByLayer, layers };
}

const OPTIONS: EraseOptions = { radius: 5, flatness: 0.01, scope: "active-layer", activeGroupId: "A" };
/** Trazo horizontal y = 20 que cruza el cuadrado de 40. */
const ACROSS = [p(-10, 20), p(50, 20)];

function ready(state: EditableDocument, stroke: Point[] = ACROSS, options: Partial<EraseOptions> = {}): ErasePlan {
  const planned = planGeometryErase(state, stroke, { ...OPTIONS, ...options });
  if (planned.status !== "ready") throw new Error(`se esperaba ready y fue ${planned.status}`);
  return planned.plan;
}

const topPiece: GeometryPiece = { type: "polygon", coordinates: [[[0, 0], [40, 0], [40, 15], [0, 15], [0, 0]]] };
const bottomPiece: GeometryPiece = { type: "polygon", coordinates: [[[0, 25], [40, 25], [40, 40], [0, 40], [0, 25]]] };

function responseFor(plan: ErasePlan, items: Array<{ changed: boolean; geometries: GeometryPiece[] }>): BooleanResponse {
  return {
    operation: "difference",
    scope: "per_subject",
    tolerance: plan.request.tolerance,
    pieceCount: items.reduce((total, item) => total + item.geometries.length, 0),
    results: items.map((item, index) => ({ subjectIndex: index, ...item })),
  };
}

function idFactory(prefix = "n") {
  let counter = 0;
  return { next: () => `${prefix}${(counter += 1)}`, get calls() { return counter; } };
}

describe("strokeSamples", () => {
  it("interpola con separación ≤ paso y conserva el último punto exacto", () => {
    const samples = strokeSamples([p(0, 0), p(10, 0)], 4);
    expect(samples).toHaveLength(4); // ceil(10 / 4) = 3 tramos
    expect(samples[0]).toEqual(p(0, 0));
    expect(samples[1].x).toBeCloseTo(10 / 3, 12);
    expect(samples[3]).toEqual(p(10, 0));
  });

  it("un solo punto es una sola muestra; sin puntos, ninguna", () => {
    expect(strokeSamples([p(3, 4)], 1)).toEqual([p(3, 4)]);
    expect(strokeSamples([], 1)).toEqual([]);
  });

  it("acota el total de muestras en un trazo larguísimo", () => {
    expect(strokeSamples([p(0, 0), p(1_000_000, 0)], 0.001).length).toBeLessThanOrEqual(4002);
  });
});

describe("modo Objeto", () => {
  const pool = [rect("o1", "A", 0, 0, 40), rect("o2", "A", 100, 0, 40), rect("o3", "B", 200, 0, 40)];

  it("objectsAlongPath devuelve los objetos tocados por el trazo, en orden de pintado, aunque el trazo salte entre eventos", () => {
    // Un solo segmento largo de x = -10 a 130 pasa por o1 y o2 sin tener un punto del mouse adentro de ninguno.
    expect(objectsAlongPath(pool, [p(-10, 20), p(130, 20)], 1).map((o) => o.id)).toEqual(["o1", "o2"]);
    expect(objectsAlongPath(pool, [p(60, 20)], 1)).toEqual([]);
    expect(objectsAlongPath(pool, [p(20, 20)], 1).map((o) => o.id)).toEqual(["o1"]);
  });

  it("una línea abierta fina se borra a cualquier zoom (tolerancia en unidades de documento)", () => {
    const line = rect("l1", "A", 0, 0, 0, { d: "M0 0 L100 0", fill: "none", stroke: "#000000", strokeWidth: 0.1 });
    expect(objectsAlongPath([line], [p(50, 0.8)], 1).map((o) => o.id)).toEqual(["l1"]);
    expect(objectsAlongPath([line], [p(50, 1.2)], 1)).toEqual([]);
  });

  it("planObjectErase elimina los objetos de capas desbloqueadas y SOLO informa los de capas bloqueadas", () => {
    const state = stateOf({ A: [pool[0], pool[1]], B: [pool[2]] }, [meta("A"), meta("B", { locked: true })]);
    const plan = planObjectErase(state, pool, new Set(["B"]));

    expect(plan.removed).toBe(2);
    expect(plan.skippedLocked).toBe(1);
    expect(plan.production?.layers).toEqual({ A: [] });
  });

  it("si todo lo que hay bajo el cursor está bloqueado no hay producción", () => {
    const state = stateOf({ B: [pool[2]] }, [meta("B", { locked: true })]);
    const plan = planObjectErase(state, [pool[2]], new Set(["B"]));

    expect(plan.production).toBeNull();
    expect(plan.removed).toBe(0);
    expect(plan.skippedLocked).toBe(1);
  });
});

describe("planGeometryErase: petición y alcance", () => {
  const sq = rect("s1", "A", 0, 0, 40);
  const far = rect("s2", "A", 500, 500, 40);
  const other = rect("d1", "D", 10, 10, 20);
  const locked = rect("b1", "B", 0, 0, 40);
  const hidden = rect("c1", "C", 0, 0, 40);
  const state = stateOf({ A: [sq, far], B: [locked], C: [hidden], D: [other] }, [meta("A"), meta("B", { locked: true }), meta("C", { visible: false }), meta("D")]);

  it("arma `difference` con el pincel como bufferedLine (radio en unidades de documento) y los subjects en coordenadas de documento", () => {
    const plan = ready(state);

    expect(plan.request).toEqual({
      operation: "difference",
      subjects: [{ type: "polygon", coordinates: [[[0, 0], [40, 0], [40, 40], [0, 40]]] }],
      operands: [{ type: "bufferedLine", points: [[-10, 20], [50, 20]], radius: 5 }],
      tolerance: 0.01,
    });
    expect(plan.owners).toEqual(["s1"]);
    expect(plan.originals).toEqual([sq]);
  });

  it("solo capa activa (default): el objeto de OTRA capa desbloqueada bajo el trazo no es candidato", () => {
    expect(ready(state).owners).toEqual(["s1"]);
  });

  it("todas las capas desbloqueadas: incluye las otras capas visibles y desbloqueadas, no las bloqueadas ni las ocultas", () => {
    const plan = ready(state, ACROSS, { scope: "unlocked-layers", activeGroupId: null });

    expect(plan.owners).toEqual(["s1", "d1"]);
    expect(plan.skippedLocked).toBe(1); // b1 está bajo el trazo pero su capa está bloqueada
    expect(plan.request.subjects).toHaveLength(2);
  });

  it("los objetos lejanos del trazo (fuera de bbox + hit) no se mandan al servidor", () => {
    const plan = ready(state, ACROSS, { scope: "unlocked-layers" });
    expect(plan.owners).not.toContain("s2");
  });

  it("un trazo que toca solo el borde exterior con el radio completo sí es candidato; uno a más de 1,25 radios, no", () => {
    // Borde derecho x = 40; el pincel con radio 5 centrado en x = 44 lo toca (distancia 4 ≤ 5).
    expect(planGeometryErase(state, [p(44, 20)], OPTIONS).status).toBe("ready");
    // Centrado en x = 60 queda a 20 > 6,25 + margen: no toca nada.
    expect(planGeometryErase(state, [p(60, 20)], OPTIONS).status).toBe("empty");
  });

  it("un toque dentro del relleno (sin acercarse al contorno) es candidato", () => {
    const big = rect("big", "A", 0, 0, 1000);
    expect(planGeometryErase(stateOf({ A: [big] }, [meta("A")]), [p(500, 500)], OPTIONS).status).toBe("ready");
  });

  it("sin capa activa, con la capa bloqueada u oculta: error claro y NINGUNA petición", () => {
    const none = planGeometryErase(state, ACROSS, { ...OPTIONS, activeGroupId: null });
    expect(none.status === "error" && none.message).toMatch(/No hay una capa activa.*todas las capas desbloqueadas/);
    const lockedActive = planGeometryErase(state, ACROSS, { ...OPTIONS, activeGroupId: "B" });
    expect(lockedActive.status === "error" && lockedActive.message).toMatch(/«Capa B» está bloqueada.*No se borró nada/);
    const hiddenActive = planGeometryErase(state, ACROSS, { ...OPTIONS, activeGroupId: "C" });
    expect(hiddenActive.status === "error" && hiddenActive.message).toMatch(/«Capa C» está oculta/);
    const missing = planGeometryErase(state, ACROSS, { ...OPTIONS, activeGroupId: "ya-no-existe" });
    expect(missing.status).toBe("error");
  });

  it("un trazo que no toca nada informa que no se borró nada y cuenta los objetos bloqueados que sí tocó", () => {
    const planned = planGeometryErase(state, [p(1000, 1000)], OPTIONS);
    expect(planned.status === "empty" && planned.message).toMatch(/no tocó ningún objeto de la capa activa/);
    const lockedOnly = planGeometryErase(stateOf({ A: [far], B: [locked] }, [meta("A"), meta("B", { locked: true })]), ACROSS, { ...OPTIONS, scope: "unlocked-layers" });
    expect(lockedOnly.status === "empty" && lockedOnly.skippedLocked).toBe(1);
  });

  it("rechaza un trazo vacío o con coordenadas no finitas, y un radio inválido", () => {
    expect(planGeometryErase(state, [], OPTIONS).status).toBe("error");
    expect(planGeometryErase(state, [p(0, Number.NaN)], OPTIONS).status).toBe("error");
    expect(planGeometryErase(state, ACROSS, { ...OPTIONS, radius: 0 }).status).toBe("error");
    expect(planGeometryErase(state, ACROSS, { ...OPTIONS, radius: Number.POSITIVE_INFINITY }).status).toBe("error");
  });

  it("el pincel se simplifica con la tolerancia de aplanado: 1000 puntos alineados viajan como 2", () => {
    const dense = Array.from({ length: 1000 }, (_, index) => p(-10 + index * 0.06, 20));
    const plan = ready(state, dense);
    const brush = plan.request.operands[0];
    expect(brush.type === "bufferedLine" && brush.points).toHaveLength(2);
  });

  it("los objetos sin relleno aportan una polilínea por subpath (todas con el mismo dueño) y la matriz queda horneada", () => {
    const lines = rect("l1", "A", 0, 0, 0, { d: "M0 0 L40 0 M0 30 L40 30", fill: "none", stroke: "#000000", strokeWidth: 0.1, matrix: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 5 } });
    const plan = ready(stateOf({ A: [lines] }, [meta("A")]), [p(20, -5), p(20, 40)]);

    expect(plan.request.subjects).toEqual([
      { type: "line", coordinates: [[0, 5], [40, 5]] },
      { type: "line", coordinates: [[0, 35], [40, 35]] },
    ]);
    expect(plan.owners).toEqual(["l1", "l1"]);
  });

  it("un candidato que no se puede enviar de forma segura se omite y se cuenta; si son todos, error", () => {
    const degenerate = rect("bad", "A", 0, 0, 0, { d: "M0 0 L40 0" }); // relleno de 2 puntos: no es un anillo
    const mixed = planGeometryErase(stateOf({ A: [degenerate, sq] }, [meta("A")]), [p(20, 0)], OPTIONS);
    expect(mixed.status === "ready" && mixed.plan.skippedInvalid).toBe(1);
    expect(mixed.status === "ready" && mixed.plan.owners).toEqual(["s1"]);

    const onlyBad = planGeometryErase(stateOf({ A: [degenerate] }, [meta("A")]), [p(20, 0)], OPTIONS);
    expect(onlyBad.status === "error" && onlyBad.message).toMatch(/no tienen una geometría que se pueda procesar/);
  });

  it("más de 500 subjects: error con el conteo y SIN petición; exactamente 500 pasa", () => {
    const many = (count: number) => Array.from({ length: count }, (_, index) => rect(`m${index}`, "A", index * 2, 0, 1));
    const stroke = [p(0, 0.5), p(2000, 0.5)];
    const over = planGeometryErase(stateOf({ A: many(501) }, [meta("A")]), stroke, { ...OPTIONS, radius: 2 });
    expect(over.status === "error" && over.message).toMatch(/demasiados objetos.*501.*500/);
    expect(planGeometryErase(stateOf({ A: many(500) }, [meta("A")]), stroke, { ...OPTIONS, radius: 2 }).status).toBe("ready");
  });

  it("más de 500 000 vértices: error y SIN petición", () => {
    const huge = rect("huge", "A", 0, 0, 1, { d: `M0 0 ${Array.from({ length: 500_001 }, (_, index) => `L${index + 1} ${index % 2}`).join(" ")} Z` });
    const planned = planGeometryErase(stateOf({ A: [huge] }, [meta("A")]), [p(0, 0)], OPTIONS);
    expect(planned.status === "error" && planned.message).toMatch(/demasiado grande/);
  });
});

describe("applyEraseResult: de la respuesta del servidor a UN comando", () => {
  const sq = rect("s1", "A", 0, 0, 40, { fill: "#ff0000" });
  const bystander = rect("s2", "A", 500, 500, 40);
  const layers = [meta("A"), meta("D")];
  const state = stateOf({ A: [sq, bystander], D: [] }, layers);

  it("un objeto PARTIDO en dos piezas: ids nuevos, ocupan el lugar del original, conservan capa y fill, con la matriz horneada", () => {
    const plan = ready(state);
    const ids = idFactory();
    const applied = applyEraseResult(state, plan, responseFor(plan, [{ changed: true, geometries: [topPiece, bottomPiece] }]), ids.next);

    expect(applied.ok).toBe(true);
    if (!applied.ok || !applied.production) throw new Error("sin producción");
    const [first, second, untouched] = applied.production.layers.A;
    expect([first.id, second.id]).toEqual(["n1", "n2"]);
    expect(first).toEqual({ id: "n1", layerGroupId: "A", d: "M0 0 L40 0 L40 15 L0 15 Z", fill: "#ff0000", matrix: IDENTITY_MATRIX });
    expect(second.d).toBe("M0 25 L40 25 L40 40 L0 40 Z");
    expect(untouched).toBe(bystander); // el resto de la capa conserva su referencia
    expect(applied.production.layers.A).toHaveLength(3);
    expect(applied.production.atomic).toBe(true);
    expect(applied.summary).toEqual({ removed: 0, reduced: 0, split: 1, untouched: 0, created: 2 });
    expect(ids.calls).toBe(2);
  });

  it("un objeto REDUCIDO a una sola pieza conserva su id (y solo cambia su d)", () => {
    const plan = ready(state);
    const ids = idFactory();
    const applied = applyEraseResult(state, plan, responseFor(plan, [{ changed: true, geometries: [topPiece] }]), ids.next);

    if (!applied.ok || !applied.production) throw new Error("sin producción");
    expect(applied.production.layers.A[0]).toEqual({ ...sq, d: "M0 0 L40 0 L40 15 L0 15 Z" });
    expect(applied.production.layers.A[0].id).toBe("s1");
    expect(applied.summary.reduced).toBe(1);
    expect(ids.calls).toBe(0); // no se pidió ningún id nuevo
  });

  it("un objeto ELIMINADO por completo desaparece de su capa", () => {
    const plan = ready(state);
    const applied = applyEraseResult(state, plan, responseFor(plan, [{ changed: true, geometries: [] }]), idFactory().next);

    if (!applied.ok || !applied.production) throw new Error("sin producción");
    expect(applied.production.layers.A).toEqual([bystander]);
    expect(applied.summary.removed).toBe(1);
  });

  it("un objeto INTACTO (changed: false) no se toca: sin producción y conserva sus curvas originales", () => {
    const curved = rect("c1", "A", 0, 0, 0, { d: "M0 20 C0 0 40 0 40 20 L40 40 L0 40 Z" });
    const curvedState = stateOf({ A: [curved] }, [meta("A")]);
    const plan = ready(curvedState, [p(20, 30)]);
    const applied = applyEraseResult(curvedState, plan, responseFor(plan, [{ changed: false, geometries: [topPiece] }]), idFactory().next);

    expect(applied).toEqual({ ok: true, production: null, summary: { removed: 0, reduced: 0, split: 0, untouched: 1, created: 0 } });
  });

  it("los huecos viajan como subpaths del objeto resultante", () => {
    const plan = ready(state);
    const withHole: GeometryPiece = { type: "polygon", coordinates: [[[0, 0], [40, 0], [40, 40], [0, 40], [0, 0]], [[10, 10], [10, 20], [20, 20], [20, 10], [10, 10]]] };
    const applied = applyEraseResult(state, plan, responseFor(plan, [{ changed: true, geometries: [withHole] }]), idFactory().next);

    if (!applied.ok || !applied.production) throw new Error("sin producción");
    expect(applied.production.layers.A[0].d).toBe("M0 0 L40 0 L40 40 L0 40 Z M10 10 L10 20 L20 20 L20 10 Z");
  });

  it("una línea con dos subpaths se parte en piezas sueltas que conservan stroke y fill none; el ancho se hornea con la escala de la matriz", () => {
    const stroked = rect("l1", "A", 0, 0, 0, { d: "M0 0 L20 0 M0 5 L20 5", fill: "none", stroke: "#123456", strokeWidth: 0.5, matrix: { a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 } });
    const lineState = stateOf({ A: [stroked] }, [meta("A")]);
    const plan = ready(lineState, [p(20, -5), p(20, 20)]);
    expect(plan.owners).toEqual(["l1", "l1"]);

    const left: GeometryPiece = { type: "line", coordinates: [[0, 0], [36, 0]] };
    const right: GeometryPiece = { type: "line", coordinates: [[44, 0], [80, 0]] };
    const second: GeometryPiece = { type: "line", coordinates: [[0, 10], [80, 10]] };
    const ids = idFactory("line");
    const applied = applyEraseResult(lineState, plan, responseFor(plan, [{ changed: true, geometries: [left, right] }, { changed: false, geometries: [second] }]), ids.next);

    if (!applied.ok || !applied.production) throw new Error("sin producción");
    const pieces = applied.production.layers.A;
    expect(pieces.map((o) => o.id)).toEqual(["line1", "line2", "line3"]);
    expect(pieces.map((o) => o.d)).toEqual(["M0 0 L36 0", "M44 0 L80 0", "M0 10 L80 10"]);
    for (const piece of pieces) {
      expect(piece).toMatchObject({ layerGroupId: "A", fill: "none", stroke: "#123456", strokeWidth: 1, matrix: IDENTITY_MATRIX });
    }
    expect(applied.summary).toEqual({ removed: 0, reduced: 0, split: 1, untouched: 0, created: 3 });
  });

  it("varias capas: un solo comando atómico con las capas tocadas", () => {
    const manyState = stateOf({ A: [sq], D: [rect("d1", "D", 10, 10, 20)] }, layers);
    const plan = ready(manyState, ACROSS, { scope: "unlocked-layers", activeGroupId: null });
    const smaller: GeometryPiece = { type: "polygon", coordinates: [[[10, 10], [30, 10], [30, 15], [10, 15], [10, 10]]] };
    const applied = applyEraseResult(manyState, plan, responseFor(plan, [{ changed: true, geometries: [topPiece] }, { changed: true, geometries: [smaller] }]), idFactory().next);

    if (!applied.ok || !applied.production) throw new Error("sin producción");
    expect(Object.keys(applied.production.layers).sort()).toEqual(["A", "D"]);
    expect(applied.production.layers.D[0].id).toBe("d1");
    expect(applied.production.atomic).toBe(true);
  });

  it("si el documento CAMBIÓ mientras se calculaba (otro objeto en el lugar del candidato) NO se aplica nada", () => {
    const plan = ready(state);
    const changed = stateOf({ A: [{ ...sq }, bystander], D: [] }, layers); // mismo contenido, otra referencia: otra edición lo reemplazó
    const applied = applyEraseResult(changed, plan, responseFor(plan, [{ changed: true, geometries: [topPiece] }]), idFactory().next);

    expect(applied.ok).toBe(false);
    expect(!applied.ok && applied.error).toMatch(/El documento cambió mientras se calculaba.*No se modificó nada/);
  });

  it("si el candidato ya no existe (se borró o se deshizo) tampoco se aplica nada", () => {
    const plan = ready(state);
    const gone = stateOf({ A: [bystander], D: [] }, layers);

    expect(applyEraseResult(gone, plan, responseFor(plan, [{ changed: true, geometries: [] }]), idFactory().next).ok).toBe(false);
  });

  it("una respuesta incoherente con la petición se rechaza entera", () => {
    const plan = ready(state);
    const nan = responseFor(plan, [{ changed: true, geometries: [{ type: "polygon", coordinates: [[[0, 0], [Number.NaN, 0], [0, 10], [0, 0]]] }] }]);
    const wrongCount: BooleanResponse = { ...responseFor(plan, []), results: [] };
    const wrongType = responseFor(plan, [{ changed: true, geometries: [{ type: "line", coordinates: [[0, 0], [1, 1]] }] }]);

    for (const response of [nan, wrongCount, wrongType]) {
      const applied = applyEraseResult(state, plan, response, idFactory().next);
      expect(applied.ok).toBe(false);
      expect(!applied.ok && applied.error).toMatch(/incoherente.*No se modificó nada/);
    }
  });

  it("es todo o nada: una sola pieza ilegible entre varias descarta el comando completo", () => {
    const multiState = stateOf({ A: [sq, rect("s3", "A", 100, 0, 40)] }, layers);
    const plan = ready(multiState, [p(-10, 20), p(150, 20)], { radius: 5 });
    expect(plan.owners).toEqual(["s1", "s3"]);
    // El segundo resultado trae un anillo de solo 2 vértices distintos: la validación del cliente corta TODO antes de tocar nada.
    const bad = responseFor(plan, [
      { changed: true, geometries: [topPiece] },
      { changed: true, geometries: [{ type: "polygon", coordinates: [[[100, 0], [140, 0], [100, 0]]] }] },
    ]);

    const applied = applyEraseResult(multiState, plan, bad, idFactory().next);
    expect(applied.ok).toBe(false);
  });

  it("los ids son únicos entre sí y distintos de los existentes", () => {
    const plan = ready(state);
    const ids = idFactory("uuid-");
    const applied = applyEraseResult(state, plan, responseFor(plan, [{ changed: true, geometries: [topPiece, bottomPiece] }]), ids.next);
    if (!applied.ok || !applied.production) throw new Error("sin producción");
    const all = Object.values(applied.production.layers).flat().map((o) => o.id);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("etiquetas y resumen", () => {
  it("eraseLabel cuenta los objetos tocados (no los intactos) y singulariza", () => {
    expect(eraseLabel({ removed: 1, reduced: 0, split: 0, untouched: 5, created: 0 })).toBe("Borrar con pincel (1 objeto)");
    expect(eraseLabel({ removed: 1, reduced: 2, split: 1, untouched: 0, created: 3 })).toBe("Borrar con pincel (4 objetos)");
  });

  it("eraseNotice resume qué pasó con cada objeto y avisa de los bloqueados/no procesables", () => {
    expect(eraseNotice({ removed: 1, reduced: 2, split: 1, untouched: 0, created: 3 }, { skippedLocked: 0, skippedInvalid: 0 })).toBe(
      "Borrado aplicado: 1 objeto eliminado, 2 objetos reducidos, 1 objeto partido en 3 piezas.",
    );
    expect(eraseNotice({ removed: 1, reduced: 0, split: 0, untouched: 0, created: 0 }, { skippedLocked: 2, skippedInvalid: 1 })).toBe(
      "Borrado aplicado: 1 objeto eliminado. 2 objetos están en capas bloqueadas y no se modificó. 1 objeto no se pudo procesar y se dejó igual.",
    );
    expect(eraseNotice({ removed: 0, reduced: 0, split: 0, untouched: 3, created: 0 }, { skippedLocked: 0, skippedInvalid: 0 })).toBe("El pincel no modificó ningún objeto.");
  });
});
