import { describe, expect, it } from "vitest";
import {
  buildFillProduction,
  buildRecolorProduction,
  colorLayerName,
  createColorLayer,
  DEFAULT_CONFIRM_THRESHOLD,
  eyedrop,
  findLayersByHex,
  formatHex,
  hexEquals,
  mergeCandidates,
  needsConfirmation,
  normalizeHex,
  parseHex,
  pickLayerAt,
  planRecolor,
  recolorHeadline,
  recolorLabel,
  resolveActiveColor,
  summarizeRecolor,
  type ColorTarget,
} from "./colors";
import { selectableObjects } from "./selection";
import type { EditableDocument, EditableLayerMeta, EditorObject } from "./types";

const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

function object(id: string, layerGroupId: string, fill: string, d = "M0 0 H10 V10 H0 Z"): EditorObject {
  return { id, layerGroupId, d, fill, matrix: IDENTITY };
}

function meta(overrides: Partial<EditableLayerMeta> & { groupId: string }): EditableLayerMeta {
  return {
    name: overrides.groupId,
    colorHex: "#000000",
    order: 0,
    visible: true,
    locked: false,
    manufacturingOperation: "unassigned",
    isNew: false,
    ...overrides,
  };
}

// Dos capas con el MISMO hex visual (A y C) y distinta identidad: el caso que la tarjeta pide cubrir.
const A = meta({ groupId: "A", name: "Rojo", colorHex: "#ff0000", order: 0 });
const B = meta({ groupId: "B", name: "Azul", colorHex: "#0000ff", order: 1 });
const C = meta({ groupId: "C", name: "Rojo 2", colorHex: "#FF0000", order: 2 });
const LOCKED = meta({ groupId: "L", name: "Bloqueada", colorHex: "#00ff00", order: 3, locked: true });
const HIDDEN = meta({ groupId: "H", name: "Oculta", colorHex: "#ffff00", order: 4, visible: false });

function state(overrides: Partial<EditableDocument> = {}): EditableDocument {
  return {
    layers: [A, B, C, LOCKED, HIDDEN],
    objectsByLayer: {
      A: [object("a1", "A", "#ff0000"), object("a2", "A", "#ff0000")],
      B: [object("b1", "B", "#0000ff")],
      C: [object("c1", "C", "#FF0000"), object("c2", "C", "#FF0000")],
      L: [object("l1", "L", "#00ff00")],
      H: [object("h1", "H", "#ffff00")],
    },
    ...overrides,
  };
}

const layerTarget = (groupId: string): ColorTarget => ({ kind: "layer", groupId });
const newTarget = (hex: string, groupId = "NEW"): ColorTarget => ({ kind: "new", hex, groupId });
const ids = (...values: string[]) => new Set(values);

describe("colors — hex", () => {
  it("normalizeHex acepta #rgb/#rrggbb con o sin #, cualquier caja, y devuelve #RRGGBB en mayúsculas", () => {
    expect(normalizeHex("#f00")).toBe("#FF0000");
    expect(normalizeHex("ff0000")).toBe("#FF0000");
    expect(normalizeHex("  #AbCdEf ")).toBe("#ABCDEF");
    expect(normalizeHex("0f0")).toBe("#00FF00");
  });

  it.each(["", "#ff", "#ggg", "#ff00", "#ff00ff00", "rgb(1,2,3)", "red", "#12345", "##ff0000"])("normalizeHex rechaza %j (sin alfa ni nombres)", (input) => {
    expect(normalizeHex(input)).toBeNull();
  });

  it("parseHex/formatHex hacen ida y vuelta y formatHex acota los canales", () => {
    expect(parseHex("#0a141e")).toEqual({ r: 10, g: 20, b: 30 });
    expect(parseHex("nope")).toBeNull();
    expect(formatHex({ r: 10, g: 20, b: 30 })).toBe("#0A141E");
    expect(formatHex({ r: 999, g: -5, b: Number.NaN })).toBe("#FF0000");
    expect(formatHex(parseHex("#12ab9c")!)).toBe("#12AB9C");
  });

  it("hexEquals compara valores visuales sin importar la caja ni el formato corto; un hex inválido nunca es igual", () => {
    expect(hexEquals("#ff0000", "#FF0000")).toBe(true);
    expect(hexEquals("#f00", "#ff0000")).toBe(true);
    expect(hexEquals("#ff0000", "#ff0001")).toBe(false);
    expect(hexEquals("zzz", "zzz")).toBe(false);
  });

  it("findLayersByHex devuelve TODAS las capas con ese hex (A y C), en orden y sin agruparlas; solo sirve para OFRECER coincidencias", () => {
    expect(findLayersByHex([A, B, C], "#ff0000").map((layer) => layer.groupId)).toEqual(["A", "C"]);
    expect(findLayersByHex([A, B, C], "#F00").map((layer) => layer.groupId)).toEqual(["A", "C"]);
    expect(findLayersByHex([A, B, C], "#ff0000", "A").map((layer) => layer.groupId)).toEqual(["C"]);
    expect(findLayersByHex([A, B, C], "#123456")).toEqual([]);
    expect(findLayersByHex([A, B, C], "no-es-hex")).toEqual([]);
  });
});

describe("colors — capa nueva (campos por defecto)", () => {
  it("createColorLayer: nombre 'Color #RRGGBB', groupId dado, orden al final, visible, no bloqueada, operación por defecto e isNew", () => {
    const created = createColorLayer([A, B, C], "#0f0", "G1")!;
    expect(created).toEqual({
      groupId: "G1",
      name: "Color #00FF00",
      colorHex: "#00FF00",
      order: 3,
      visible: true,
      locked: false,
      manufacturingOperation: "unassigned",
      isNew: true,
    });
  });

  it("sin capas el orden es 0; con un hex inválido no crea nada", () => {
    expect(createColorLayer([], "#123456", "G")!.order).toBe(0);
    expect(createColorLayer([A], "azul", "G")).toBeNull();
  });

  it("el nombre se desambigua si ya existe una capa con ese nombre (Color #FF0000 (2), (3)...)", () => {
    expect(colorLayerName("#f00")).toBe("Color #FF0000");
    expect(colorLayerName("#f00", ["Color #FF0000"])).toBe("Color #FF0000 (2)");
    expect(colorLayerName("#f00", ["Color #FF0000", "Color #FF0000 (2)"])).toBe("Color #FF0000 (3)");
    const second = createColorLayer([meta({ groupId: "X", name: "Color #00FF00", order: 7 })], "#00ff00", "Y")!;
    expect(second.name).toBe("Color #00FF00 (2)");
    expect(second.order).toBe(8);
  });
});

describe("colors — Fill (alcance selección)", () => {
  it("objeto único: pasa de su capa a la capa destino (por groupId), toma el color de la capa y conserva todo lo demás; las capas no tocadas no aparecen", () => {
    const base = state();
    const production = buildFillProduction(base, ids("a1"), layerTarget("B"))!;

    expect(Object.keys(production.layers).sort()).toEqual(["A", "B"]);
    expect(production.layers.A.map((o) => o.id)).toEqual(["a2"]);
    expect(production.layers.B.map((o) => o.id)).toEqual(["b1", "a1"]);
    const moved = production.layers.B[1];
    expect(moved).toEqual({ ...base.objectsByLayer.A[0], layerGroupId: "B", fill: "#0000ff" });
    expect(moved.d).toBe(base.objectsByLayer.A[0].d);
    expect(moved.matrix).toBe(base.objectsByLayer.A[0].matrix);
    expect(production.layers.B[0]).toBe(base.objectsByLayer.B[0]); // lo que no cambia conserva su referencia
    expect(production.layerMetas).toBeUndefined();
    expect(production.atomic).toBe(true);
  });

  it("multi-selección de varias capas: todos van a la capa destino, en orden de pintado, y cada capa origen conserva lo que no se movió", () => {
    const production = buildFillProduction(state(), ids("b1", "a2", "a1"), layerTarget("C"))!;
    expect(production.layers.C.map((o) => o.id)).toEqual(["c1", "c2", "a1", "a2", "b1"]);
    expect(production.layers.A).toEqual([]);
    expect(production.layers.B).toEqual([]);
    expect(production.layers.C.every((o) => o.layerGroupId === "C")).toBe(true);
  });

  it("color libre NUEVO: crea la capa en la MISMA producción (layerMetas) y mueve los objetos a ella", () => {
    const production = buildFillProduction(state(), ids("a1", "b1"), newTarget("#0f0", "NEW-1"))!;
    expect(production.layerMetas).toHaveLength(1);
    expect(production.layerMetas![0]).toMatchObject({ groupId: "NEW-1", name: "Color #00FF00", colorHex: "#00FF00", isNew: true, visible: true, locked: false, order: 5 });
    expect(production.layers["NEW-1"].map((o) => [o.id, o.layerGroupId, o.fill])).toEqual([
      ["a1", "NEW-1", "#00FF00"],
      ["b1", "NEW-1", "#00FF00"],
    ]);
    expect(production.layers.A.map((o) => o.id)).toEqual(["a2"]);
    expect(production.layers.B).toEqual([]);
    expect(production.atomic).toBe(true);
  });

  it("si la capa del color libre YA existe (mismo groupId, p. ej. tras aplicar) se usa tal cual: no se crea otra", () => {
    const created = meta({ groupId: "NEW-1", colorHex: "#00FF00", isNew: true, order: 5 });
    const base = state({ layers: [...state().layers!, created], objectsByLayer: { ...state().objectsByLayer, "NEW-1": [object("n1", "NEW-1", "#00FF00")] } });
    const production = buildFillProduction(base, ids("a1"), newTarget("#00ff00", "NEW-1"))!;
    expect(production.layerMetas).toBeUndefined();
    expect(production.layers["NEW-1"].map((o) => o.id)).toEqual(["n1", "a1"]);
  });

  it("COLOR COMPARTIDO: A y C tienen el mismo hex pero son capas distintas: elegir C como destino lleva el objeto a C, no a A (y viceversa)", () => {
    const toC = buildFillProduction(state(), ids("b1"), layerTarget("C"))!;
    expect(Object.keys(toC.layers).sort()).toEqual(["B", "C"]);
    expect(toC.layers.C.map((o) => o.id)).toEqual(["c1", "c2", "b1"]);
    expect(toC.layers.A).toBeUndefined();

    const toA = buildFillProduction(state(), ids("b1"), layerTarget("A"))!;
    expect(Object.keys(toA.layers).sort()).toEqual(["A", "B"]);
    expect(toA.layers.A.map((o) => o.id)).toEqual(["a1", "a2", "b1"]);
    expect(toA.layers.C).toBeUndefined();
  });

  it("COLOR COMPARTIDO: un objeto de A rellenado con la capa C (mismo hex) SÍ se mueve: la identidad es el groupId, no el hex", () => {
    const plan = planRecolor("selection", state(), { target: layerTarget("C"), objectIds: ids("a1") });
    expect(plan.error).toBeNull();
    expect(plan.summary.objectCount).toBe(1);
    expect(plan.summary.alreadyThere).toBe(0);
    expect(plan.production!.layers.A.map((o) => o.id)).toEqual(["a2"]);
    expect(plan.production!.layers.C.map((o) => o.id)).toEqual(["c1", "c2", "a1"]);
    expect(plan.production!.layers.C[2].layerGroupId).toBe("C");
  });

  it("COLOR COMPARTIDO: un color libre con el hex de una capa existente crea una capa NUEVA (no reutiliza A en silencio)", () => {
    const production = buildFillProduction(state(), ids("b1"), newTarget("#ff0000", "NEW-RED"))!;
    expect(production.layerMetas![0]).toMatchObject({ groupId: "NEW-RED", name: "Color #FF0000", isNew: true });
    expect(production.layers["NEW-RED"].map((o) => o.id)).toEqual(["b1"]);
    expect(production.layers.A).toBeUndefined();
    expect(production.layers.C).toBeUndefined();
  });

  it("objetos que ya están en la capa destino no cambian; si TODOS lo están no hay producción y el motivo lo dice", () => {
    const partial = planRecolor("selection", state(), { target: layerTarget("A"), objectIds: ids("a1", "b1") });
    expect(partial.summary.alreadyThere).toBe(1);
    expect(partial.summary.objectCount).toBe(1);
    expect(partial.production!.layers.A.map((o) => o.id)).toEqual(["a1", "a2", "b1"]);

    const none = planRecolor("selection", state(), { target: layerTarget("A"), objectIds: ids("a1", "a2") });
    expect(none.production).toBeNull();
    expect(none.error).toMatch(/ya están en la capa «Rojo»/);
  });

  it("capas bloqueadas: sus objetos NO se mueven (se informan) y no pueden recibir objetos", () => {
    const mixed = planRecolor("selection", state(), { target: layerTarget("B"), objectIds: ids("a1", "l1") });
    expect(mixed.summary.skippedLocked).toBe(1);
    expect(mixed.summary.objectCount).toBe(1);
    expect(mixed.production!.layers.L).toBeUndefined();
    expect(mixed.production!.layers.B.map((o) => o.id)).toEqual(["b1", "a1"]);

    const onlyLocked = planRecolor("selection", state(), { target: layerTarget("B"), objectIds: ids("l1") });
    expect(onlyLocked.production).toBeNull();
    expect(onlyLocked.summary.skippedLocked).toBe(1);
    expect(onlyLocked.error).toMatch(/bloqueadas u ocultas/);

    const intoLocked = planRecolor("selection", state(), { target: layerTarget("L"), objectIds: ids("a1") });
    expect(intoLocked.production).toBeNull();
    expect(intoLocked.error).toMatch(/destino «Bloqueada» está bloqueada/);
  });

  it("capas ocultas: sus objetos no se modifican y no pueden recibir objetos", () => {
    const fromHidden = planRecolor("selection", state(), { target: layerTarget("B"), objectIds: ids("a1", "h1") });
    expect(fromHidden.summary.skippedHidden).toBe(1);
    expect(fromHidden.production!.layers.H).toBeUndefined();

    const intoHidden = planRecolor("selection", state(), { target: layerTarget("H"), objectIds: ids("a1") });
    expect(intoHidden.production).toBeNull();
    expect(intoHidden.error).toMatch(/destino «Oculta» está oculta/);
  });

  it("errores de entrada: sin selección, destino inexistente, hex inválido -> sin producción y con motivo", () => {
    expect(planRecolor("selection", state(), { target: layerTarget("B"), objectIds: ids() }).error).toMatch(/No hay objetos seleccionados/);
    expect(planRecolor("selection", state(), { target: layerTarget("ZZZ"), objectIds: ids("a1") }).error).toMatch(/ya no existe/);
    const invalid = planRecolor("selection", state(), { target: newTarget("rojo"), objectIds: ids("a1") });
    expect(invalid.production).toBeNull();
    expect(invalid.error).toMatch(/no es un color hex válido/);
  });

  it("un estado sin estructura de capas (productores de S01/S02) no revienta: no hay destino", () => {
    const bare: EditableDocument = { objectsByLayer: state().objectsByLayer };
    expect(buildFillProduction(bare, ids("a1"), layerTarget("B"))).toBeNull();
    // Un color libre sí puede crear la capa aunque no hubiera estructura previa.
    const created = buildFillProduction(bare, ids("a1"), newTarget("#123456", "N"))!;
    expect(created.layerMetas![0]).toMatchObject({ groupId: "N", order: 0 });
  });

  it("no muta el estado de entrada", () => {
    const base = state();
    const before = JSON.stringify(base);
    buildFillProduction(base, ids("a1", "b1"), newTarget("#0f0"));
    expect(JSON.stringify(base)).toBe(before);
  });
});

describe("colors — Recolor de capa (alcance capa)", () => {
  it("cambia el color de la PROPIA capa: mismo groupId, hex nuevo normalizado, todos sus objetos con el fill nuevo", () => {
    const base = state();
    const production = buildRecolorProduction("layer", base, { target: newTarget("#00f0ff", "x"), sourceGroupId: "A" })!;

    expect(production.layerMetas).toEqual([{ ...A, colorHex: "#00F0FF" }]);
    expect(production.layerMetas![0].groupId).toBe("A");
    expect(Object.keys(production.layers)).toEqual(["A"]);
    expect(production.layers.A.map((o) => [o.id, o.layerGroupId, o.fill, o.d])).toEqual([
      ["a1", "A", "#00F0FF", base.objectsByLayer.A[0].d],
      ["a2", "A", "#00F0FF", base.objectsByLayer.A[1].d],
    ]);
    expect(production.atomic).toBe(true);
  });

  it("COLOR COMPARTIDO: recolorear A no toca C aunque tengan el mismo hex (solo cambian los objetos de A)", () => {
    const production = buildRecolorProduction("layer", state(), { target: newTarget("#00ff00"), sourceGroupId: "A" })!;
    expect(production.layers.C).toBeUndefined();
    expect(production.layerMetas!.map((layer) => layer.groupId)).toEqual(["A"]);
    expect(production.layers.A.every((o) => o.fill === "#00FF00")).toBe(true);
  });

  it("COLOR COMPARTIDO: pintar B con el hex de A deja DOS capas distintas con el mismo hex (sin fusión, sin tocar A)", () => {
    const plan = planRecolor("layer", state(), { target: layerTarget("A"), sourceGroupId: "B" });
    expect(plan.error).toBeNull();
    expect(plan.summary.merge).toBeNull();
    expect(plan.summary.emptiedLayerIds).toEqual([]);
    expect(plan.production!.layerMetas).toEqual([{ ...B, colorHex: "#FF0000" }]);
    expect(plan.production!.layerMetas![0].groupId).toBe("B");
    expect(plan.production!.layers.A).toBeUndefined();
    expect(plan.production!.layers.B.map((o) => [o.layerGroupId, o.fill])).toEqual([["B", "#FF0000"]]);
    // Sigue habiendo dos capas con ese hex y se OFRECE (no se aplica) la fusión.
    expect(mergeCandidates([A, { ...B, colorHex: "#FF0000" }, C], "B", layerTarget("A")).map((layer) => layer.groupId)).toEqual(["A", "C"]);
  });

  it("un color que la capa ya tiene (otra caja/formato) no es un cambio", () => {
    const plan = planRecolor("layer", state(), { target: newTarget("#F00"), sourceGroupId: "A" });
    expect(plan.production).toBeNull();
    expect(plan.error).toMatch(/ya tiene el color #FF0000/);
  });

  it("capa bloqueada u oculta como origen: se rechaza e informa cuántos objetos se omitieron", () => {
    const locked = planRecolor("layer", state(), { target: newTarget("#ffffff"), sourceGroupId: "L" });
    expect(locked.production).toBeNull();
    expect(locked.summary.skippedLocked).toBe(1);
    expect(locked.error).toMatch(/origen «Bloqueada» está bloqueada/);

    const hidden = planRecolor("layer", state(), { target: newTarget("#ffffff"), sourceGroupId: "H" });
    expect(hidden.production).toBeNull();
    expect(hidden.summary.skippedHidden).toBe(1);
  });

  it("sin capa de origen, destino inexistente o hex inválido: rechazo con motivo", () => {
    expect(planRecolor("layer", state(), { target: newTarget("#fff") }).error).toMatch(/Elegí la capa/);
    expect(planRecolor("layer", state(), { target: layerTarget("ZZZ"), sourceGroupId: "A" }).error).toMatch(/ya no existe/);
    expect(planRecolor("layer", state(), { target: newTarget("azul"), sourceGroupId: "A" }).error).toMatch(/no es un color hex válido/);
  });

  it("una capa vacía igual cambia de color (solo estructura, sin objetos)", () => {
    const base = state({ objectsByLayer: { ...state().objectsByLayer, A: [] } });
    const production = buildRecolorProduction("layer", base, { target: newTarget("#123456"), sourceGroupId: "A" })!;
    expect(production.layers).toEqual({});
    expect(production.layerMetas![0].colorHex).toBe("#123456");
  });
});

describe("colors — fusión explícita", () => {
  it("fusionar A con C (mismo hex): todos los objetos de A pasan a C, A queda VACÍA (no se elimina: sigue en la estructura) y se informa", () => {
    const base = state();
    const plan = planRecolor("layer", base, { target: layerTarget("C"), sourceGroupId: "A", mergeIntoGroupId: "C" });

    expect(plan.error).toBeNull();
    expect(plan.production!.layers.A).toEqual([]);
    expect(plan.production!.layers.C.map((o) => [o.id, o.layerGroupId, o.fill])).toEqual([
      ["c1", "C", "#FF0000"],
      ["c2", "C", "#FF0000"],
      ["a1", "C", "#FF0000"],
      ["a2", "C", "#FF0000"],
    ]);
    // Ninguna capa se elimina ni se recolorea: no hay cambios de estructura.
    expect(plan.production!.layerMetas).toBeUndefined();
    expect(plan.summary.merge).toEqual({ fromGroupId: "A", fromName: "Rojo", intoGroupId: "C", intoName: "Rojo 2" });
    expect(plan.summary.emptiedLayerIds).toEqual(["A"]);
    expect(plan.summary.objectCount).toBe(2);
    expect(recolorLabel(plan.summary)).toBe("Fusionar «Rojo» con «Rojo 2»");
  });

  it("la fusión NUNCA es implícita: con el mismo destino pero sin mergeIntoGroupId la capa solo cambia de color", () => {
    const plan = planRecolor("layer", state(), { target: layerTarget("A"), sourceGroupId: "B" });
    expect(plan.summary.merge).toBeNull();
    expect(plan.production!.layers.B).toHaveLength(1);
    expect(plan.production!.layers.A).toBeUndefined();
  });

  it("solo se fusiona con una capa que tenga el color de destino, no consigo misma, ni con capas bloqueadas/ocultas, ni una capa vacía", () => {
    expect(planRecolor("layer", state(), { target: layerTarget("A"), sourceGroupId: "B", mergeIntoGroupId: "C" }).error).toBeNull(); // C tiene el hex de A
    expect(planRecolor("layer", state(), { target: layerTarget("B"), sourceGroupId: "A", mergeIntoGroupId: "C" }).error).toMatch(/no tiene el color/);
    expect(planRecolor("layer", state(), { target: layerTarget("A"), sourceGroupId: "A", mergeIntoGroupId: "A" }).error).toMatch(/consigo misma/);
    expect(planRecolor("layer", state(), { target: layerTarget("L"), sourceGroupId: "A", mergeIntoGroupId: "L" }).error).toMatch(/bloqueada/);
    expect(planRecolor("layer", state(), { target: layerTarget("H"), sourceGroupId: "A", mergeIntoGroupId: "H" }).error).toMatch(/oculta/);
    expect(planRecolor("layer", state(), { target: layerTarget("C"), sourceGroupId: "A", mergeIntoGroupId: "ZZZ" }).error).toMatch(/ya no existe/);
    const emptySource = state({ objectsByLayer: { ...state().objectsByLayer, A: [] } });
    expect(planRecolor("layer", emptySource, { target: layerTarget("C"), sourceGroupId: "A", mergeIntoGroupId: "C" }).error).toMatch(/no tiene objetos para fusionar/);
  });

  it("mergeCandidates ofrece las capas con el hex de destino (excluida la origen), por groupId o por hex libre", () => {
    expect(mergeCandidates([A, B, C], "A", layerTarget("C")).map((layer) => layer.groupId)).toEqual(["C"]);
    expect(mergeCandidates([A, B, C], "B", newTarget("#ff0000")).map((layer) => layer.groupId)).toEqual(["A", "C"]);
    expect(mergeCandidates([A, B, C], "B", newTarget("#123456"))).toEqual([]);
    expect(mergeCandidates([A, B, C], null, layerTarget("A"))).toEqual([]);
    expect(mergeCandidates([A, B, C], "B", null)).toEqual([]);
  });
});

describe("colors — Recolor de documento", () => {
  it("sustituye el color de la capa de origen elegida: mismo resultado que capa, con alcance 'documento' en el resumen", () => {
    const plan = planRecolor("document", state(), { target: newTarget("#abcdef"), sourceGroupId: "B" });
    expect(plan.error).toBeNull();
    expect(plan.summary.scope).toBe("document");
    expect(plan.production!.layerMetas).toEqual([{ ...B, colorHex: "#ABCDEF" }]);
    expect(plan.production!.layers.B[0].fill).toBe("#ABCDEF");
    expect(recolorLabel(plan.summary)).toBe("Recolorear en el documento «Azul»: #0000FF → #ABCDEF");
  });

  it("sin capa de origen elegida lo pide; con fusión explícita también deja la origen vacía", () => {
    expect(planRecolor("document", state(), { target: newTarget("#abcdef") }).error).toMatch(/Elegí la capa de origen/);
    const merged = planRecolor("document", state(), { target: layerTarget("A"), sourceGroupId: "C", mergeIntoGroupId: "A" });
    expect(merged.summary.emptiedLayerIds).toEqual(["C"]);
    expect(merged.production!.layers.C).toEqual([]);
  });
});

describe("colors — resumen, etiquetas y confirmación", () => {
  it("summarizeRecolor es el resumen del plan; recolorHeadline cuenta objetos y capas con singular/plural", () => {
    const summary = summarizeRecolor("selection", state(), { target: layerTarget("B"), objectIds: ids("a1", "a2", "c1") });
    expect(summary).toMatchObject({ scope: "selection", objectCount: 3, layerCount: 2 });
    expect(recolorHeadline(summary)).toBe("Se recolorarán 3 objetos en 2 capas.");
    expect(recolorHeadline(summarizeRecolor("selection", state(), { target: layerTarget("B"), objectIds: ids("a1") }))).toBe("Se recolorará 1 objeto en 1 capa.");
    expect(recolorHeadline(summarizeRecolor("selection", state(), { target: layerTarget("B"), objectIds: ids() }))).toBe("No hay objetos para recolorear.");
  });

  it("recolorLabel: relleno con capa, con color nuevo, y recolor de capa", () => {
    expect(recolorLabel(summarizeRecolor("selection", state(), { target: layerTarget("B"), objectIds: ids("a1", "a2") }))).toBe("Rellenar 2 objetos con «Azul»");
    expect(recolorLabel(summarizeRecolor("selection", state(), { target: newTarget("#0f0"), objectIds: ids("a1") }))).toBe("Rellenar 1 objeto con el color nuevo #00FF00");
    expect(recolorLabel(summarizeRecolor("layer", state(), { target: newTarget("#0f0"), sourceGroupId: "A" }))).toBe("Recolorear la capa «Rojo» a #00FF00");
  });

  it("umbral de confirmación: 49 no pide, 50 (default) sí; documento y fusión piden siempre", () => {
    const base = { scope: "selection" as const, layerCount: 1, destination: null, alreadyThere: 0, skippedLocked: 0, skippedHidden: 0, merge: null, emptiedLayerIds: [], layerRecolor: null };
    expect(DEFAULT_CONFIRM_THRESHOLD).toBe(50);
    expect(needsConfirmation({ ...base, objectCount: 49 })).toBe(false);
    expect(needsConfirmation({ ...base, objectCount: 50 })).toBe(true);
    expect(needsConfirmation({ ...base, scope: "layer", objectCount: 1 })).toBe(false);
    expect(needsConfirmation({ ...base, scope: "document", objectCount: 1 })).toBe(true);
    expect(needsConfirmation({ ...base, scope: "layer", objectCount: 1, merge: { fromGroupId: "A", fromName: "A", intoGroupId: "C", intoName: "C" } })).toBe(true);
  });

  it("el umbral es configurable; un umbral inválido (0, negativo, NaN) vuelve al default", () => {
    const base = { scope: "selection" as const, layerCount: 1, destination: null, alreadyThere: 0, skippedLocked: 0, skippedHidden: 0, merge: null, emptiedLayerIds: [], layerRecolor: null, objectCount: 5 };
    expect(needsConfirmation(base, 5)).toBe(true);
    expect(needsConfirmation(base, 6)).toBe(false);
    expect(needsConfirmation(base, 0)).toBe(false);
    expect(needsConfirmation(base, -3)).toBe(false);
    expect(needsConfirmation(base, Number.NaN)).toBe(false);
    expect(needsConfirmation({ ...base, objectCount: 50 }, Number.NaN)).toBe(true);
  });
});

describe("colors — color activo", () => {
  it("una referencia a capa se resuelve por groupId (nombre + hex de ESA capa); si la capa ya no existe no hay color activo", () => {
    expect(resolveActiveColor([A, B, C], layerTarget("C"))).toEqual({ name: "Rojo 2", hex: "#FF0000", isNewColor: false });
    expect(resolveActiveColor([A, B, C], layerTarget("A"))).toEqual({ name: "Rojo", hex: "#ff0000", isNewColor: false });
    expect(resolveActiveColor([A, B], layerTarget("C"))).toBeNull();
    expect(resolveActiveColor([A], null)).toBeNull();
  });

  it("un color libre es 'color nuevo' hasta que su capa existe; con hex inválido no es un color", () => {
    expect(resolveActiveColor([A], newTarget("#0f0", "N"))).toEqual({ name: "Color nuevo #00FF00", hex: "#00FF00", isNewColor: true });
    expect(resolveActiveColor([A, meta({ groupId: "N", name: "Color #00FF00", colorHex: "#00FF00", isNew: true })], newTarget("#0f0", "N"))).toEqual({
      name: "Color #00FF00",
      hex: "#00FF00",
      isNewColor: false,
    });
    expect(resolveActiveColor([A], newTarget("zzz", "N"))).toBeNull();
  });
});

describe("colors — Eyedropper", () => {
  // Capa A (abajo): cuadrado 0..100. Capa B (arriba): cuadrado 50..150. Se superponen en 50..100.
  const objectsByLayer = {
    A: [object("a1", "A", "#ff0000", "M0 0 H100 V100 H0 Z")],
    B: [object("b1", "B", "#0000ff", "M50 50 H150 V150 H50 Z")],
  };
  const layers = [A, B];

  it("toma la CAPA del objeto visible bajo el cursor (no un hex)", () => {
    const hit = eyedrop(objectsByLayer, layers, {}, { x: 25, y: 25 });
    expect(hit?.groupId).toBe("A");
    expect(hit?.object.id).toBe("a1");
    expect(eyedrop(objectsByLayer, layers, {}, { x: 125, y: 125 })?.groupId).toBe("B");
  });

  it("objetos superpuestos: gana el de más arriba (la capa que se pinta después)", () => {
    expect(eyedrop(objectsByLayer, layers, {}, { x: 75, y: 75 })?.groupId).toBe("B");
    // Con el orden de capas invertido gana la otra: el criterio es el orden de pintado, no el color.
    expect(eyedrop(objectsByLayer, [B, A], {}, { x: 75, y: 75 })?.groupId).toBe("A");
  });

  it("click en vacío: sin resultado", () => {
    expect(eyedrop(objectsByLayer, layers, {}, { x: 400, y: 400 })).toBeNull();
    expect(pickLayerAt([], { x: 0, y: 0 })).toBeNull();
  });

  it("capa OCULTA: no se toma (se ve lo de abajo); capa BLOQUEADA: sí se toma (solo lee)", () => {
    expect(eyedrop(objectsByLayer, layers, { A: true, B: false }, { x: 75, y: 75 })?.groupId).toBe("A");
    expect(eyedrop(objectsByLayer, layers, { A: true, B: false }, { x: 125, y: 125 })).toBeNull();

    const lockedLayers = [{ ...A, locked: true }, { ...B, locked: true }];
    expect(eyedrop(objectsByLayer, lockedLayers, {}, { x: 75, y: 75 })?.groupId).toBe("B");
  });

  it("COLOR COMPARTIDO: dos capas con el mismo hex devuelven SU capa (la de arriba), nunca 'la del hex'", () => {
    const shared = {
      A: [object("a1", "A", "#ff0000", "M0 0 H100 V100 H0 Z")],
      C: [object("c1", "C", "#FF0000", "M50 50 H150 V150 H50 Z")],
    };
    expect(eyedrop(shared, [A, C], {}, { x: 25, y: 25 })?.groupId).toBe("A");
    expect(eyedrop(shared, [A, C], {}, { x: 125, y: 125 })?.groupId).toBe("C");
    expect(eyedrop(shared, [A, C], {}, { x: 75, y: 75 })?.groupId).toBe("C");
  });

  it("pickLayerAt sobre el pool de objetos seleccionables da lo mismo que eyedrop", () => {
    const pool = selectableObjects(objectsByLayer, layers, {});
    expect(pickLayerAt(pool, { x: 75, y: 75 })?.groupId).toBe("B");
  });

  it("la tolerancia (px de pantalla convertidos) permite tomar un objeto fino cerca de su contorno", () => {
    expect(eyedrop(objectsByLayer, layers, {}, { x: 103, y: 25 }, 5)?.groupId).toBe("A");
    expect(eyedrop(objectsByLayer, layers, {}, { x: 103, y: 25 }, 0)).toBeNull();
  });
});
