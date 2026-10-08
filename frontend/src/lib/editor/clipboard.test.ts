import { describe, expect, it } from "vitest";
import {
  buildClipboard,
  clipboardAvailability,
  CLIPBOARD_SHORTCUTS,
  copyToClipboard,
  describeSkipped,
  EMPTY_CLIPBOARD,
  isTextFieldTarget,
  matchClipboardShortcut,
  nextPasteOffset,
  outcomeText,
  pasteOffset,
  planCut,
  planDelete,
  planDuplicate,
  planPaste,
  registerPaste,
  type ClipboardContent,
  type ShortcutKeyEvent,
} from "./clipboard";
import { bounds } from "./objects";
import type { EditableDocument, EditableLayerMeta, EditorObject, EditProduction } from "./types";

const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** 0,5 mm por unidad de documento (160 mm sobre 320 u): 5 mm = 10 unidades. */
const MM_PER_UNIT = 0.5;

function meta(overrides: Partial<EditableLayerMeta> & Pick<EditableLayerMeta, "groupId" | "name" | "colorHex" | "order">): EditableLayerMeta {
  return { visible: true, locked: false, manufacturingOperation: "cut", isNew: false, ...overrides };
}

const LAYER_A = meta({ groupId: "A", name: "Rojo", colorHex: "#ff0000", order: 0 });
const LAYER_B = meta({ groupId: "B", name: "Azul", colorHex: "#0000ff", order: 1 });
const LAYER_C = meta({ groupId: "C", name: "Verde", colorHex: "#00ff00", order: 2, locked: true });
const LAYER_D = meta({ groupId: "D", name: "Oculta", colorHex: "#ffff00", order: 3, visible: false });
const ALL_LAYERS = [LAYER_A, LAYER_B, LAYER_C, LAYER_D];

/** Documento nuevo en cada test: los objetos son mutables y varios tests los mutan a propósito. */
function makeDocument(layers: EditableLayerMeta[] = ALL_LAYERS): EditableDocument {
  return {
    layers,
    objectsByLayer: {
      A: [
        { id: "a1", layerGroupId: "A", d: "M0 0 H40 V40 H0 Z", fill: "#ff0000", matrix: { ...IDENTITY } },
        { id: "a2", layerGroupId: "A", d: "M20 20 H40 V40 H20 Z", fill: "#ff0000", matrix: { ...IDENTITY, e: 5, f: 7 } },
        // Compound path: dos subpaths (el segundo es un hueco).
        { id: "a3", layerGroupId: "A", d: "M0 0 H10 V10 H0 Z M2 2 H8 V8 H2 Z", fill: "#ff0000", matrix: { a: 2, b: 0, c: 0, d: 2, e: 1, f: 1 } },
        // Línea abierta de Draw: sin relleno, con trazo.
        { id: "a4", layerGroupId: "A", d: "M0 100 L50 100", fill: "none", stroke: "#ff0000", strokeWidth: 0.1, matrix: { ...IDENTITY } },
      ],
      B: [{ id: "b1", layerGroupId: "B", d: "M100 100 H140 V140 H100 Z", fill: "#0000ff", matrix: { ...IDENTITY } }],
      C: [{ id: "c1", layerGroupId: "C", d: "M200 0 H210 V10 H200 Z", fill: "#00ff00", matrix: { ...IDENTITY } }],
      D: [{ id: "d1", layerGroupId: "D", d: "M300 0 H310 V10 H300 Z", fill: "#ffff00", matrix: { ...IDENTITY } }],
    },
  };
}

function pick(document: EditableDocument, ...ids: string[]): EditorObject[] {
  const wanted = new Set(ids);
  return Object.values(document.objectsByLayer)
    .flat()
    .filter((object) => wanted.has(object.id));
}

function copyOf(document: EditableDocument, ...ids: string[]): ClipboardContent {
  const content = buildClipboard(pick(document, ...ids), document);
  if (!content) throw new Error("fixture inválido");
  return content;
}

/** Contador de ids determinista para los tests: n1, n2, n3... */
function counter(prefix = "n") {
  let next = 0;
  return () => `${prefix}${(next += 1)}`;
}

/** Aplica la producción de un plan a un documento (lo que hace applyEdit): reemplaza las capas tocadas. */
function applyProduction(document: EditableDocument, production: EditProduction | null): EditableDocument {
  if (!production) throw new Error("se esperaba una producción");
  return { ...document, objectsByLayer: { ...document.objectsByLayer, ...production.layers } };
}

function allIds(document: EditableDocument): string[] {
  return Object.values(document.objectsByLayer)
    .flat()
    .map((object) => object.id);
}

describe("pasteOffset", () => {
  it("5 mm por paso convertidos a unidades de documento con mmPerUnit (0,5 mm/u -> 10 u por paso)", () => {
    expect(pasteOffset(1, MM_PER_UNIT)).toEqual({ x: 10, y: 10 });
    expect(pasteOffset(2, MM_PER_UNIT)).toEqual({ x: 20, y: 20 });
    expect(pasteOffset(3, MM_PER_UNIT)).toEqual({ x: 30, y: 30 });
    expect(pasteOffset(1, 0.25)).toEqual({ x: 20, y: 20 });
    expect(pasteOffset(1, 2)).toEqual({ x: 2.5, y: 2.5 });
  });

  it("sin escala física (mmPerUnit null o inválido) son 5 unidades por paso", () => {
    expect(pasteOffset(1, null)).toEqual({ x: 5, y: 5 });
    expect(pasteOffset(3, null)).toEqual({ x: 15, y: 15 });
    expect(pasteOffset(1, 0)).toEqual({ x: 5, y: 5 });
    expect(pasteOffset(1, Number.NaN)).toEqual({ x: 5, y: 5 });
    expect(pasteOffset(1, -1)).toEqual({ x: 5, y: 5 });
  });

  it("un contador 0, negativo o no finito no desplaza; uno fraccionario cuenta los pasos enteros", () => {
    expect(pasteOffset(0, MM_PER_UNIT)).toEqual({ x: 0, y: 0 });
    expect(pasteOffset(-2, MM_PER_UNIT)).toEqual({ x: 0, y: 0 });
    expect(pasteOffset(Number.NaN, MM_PER_UNIT)).toEqual({ x: 0, y: 0 });
    expect(pasteOffset(2.9, MM_PER_UNIT)).toEqual({ x: 20, y: 20 });
  });
});

describe("matchClipboardShortcut", () => {
  const key = (overrides: Partial<ShortcutKeyEvent>): ShortcutKeyEvent => ({ key: "", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...overrides });

  it.each([
    [{ key: "c", ctrlKey: true }, "copy"],
    [{ key: "x", ctrlKey: true }, "cut"],
    [{ key: "v", ctrlKey: true }, "paste"],
    [{ key: "V", ctrlKey: true, shiftKey: true }, "paste-in-place"],
    [{ key: "v", ctrlKey: true, altKey: true }, "paste-active"],
    [{ key: "d", ctrlKey: true }, "duplicate"],
    [{ key: "Delete" }, "delete"],
    [{ key: "Backspace" }, "delete"],
  ] as Array<[Partial<ShortcutKeyEvent>, string]>)("Ctrl: %j -> %s", (event, action) => {
    expect(matchClipboardShortcut(key(event))).toBe(action);
  });

  it("Cmd (metaKey) dispara las mismas acciones que Ctrl", () => {
    expect(matchClipboardShortcut(key({ key: "c", metaKey: true }))).toBe("copy");
    expect(matchClipboardShortcut(key({ key: "x", metaKey: true }))).toBe("cut");
    expect(matchClipboardShortcut(key({ key: "v", metaKey: true }))).toBe("paste");
    expect(matchClipboardShortcut(key({ key: "V", metaKey: true, shiftKey: true }))).toBe("paste-in-place");
    expect(matchClipboardShortcut(key({ key: "v", metaKey: true, altKey: true }))).toBe("paste-active");
    expect(matchClipboardShortcut(key({ key: "d", metaKey: true }))).toBe("duplicate");
  });

  it("con Bloq Mayús (letra mayúscula, sin Shift) sigue siendo la misma acción", () => {
    expect(matchClipboardShortcut(key({ key: "C", ctrlKey: true }))).toBe("copy");
  });

  it("macOS: Option+V produce otro carácter en `key` ('√'); se reconoce por la tecla física", () => {
    expect(matchClipboardShortcut(key({ key: "√", code: "KeyV", metaKey: true, altKey: true }))).toBe("paste-active");
    expect(matchClipboardShortcut(key({ key: "Dead", code: "KeyD", metaKey: true }))).toBe("duplicate");
  });

  it("sin Ctrl/Cmd no hay atajo de letra; otras combinaciones y teclas no se interceptan", () => {
    expect(matchClipboardShortcut(key({ key: "c" }))).toBeNull();
    expect(matchClipboardShortcut(key({ key: "v", shiftKey: true }))).toBeNull();
    expect(matchClipboardShortcut(key({ key: "z", ctrlKey: true }))).toBeNull();
    expect(matchClipboardShortcut(key({ key: "a", ctrlKey: true }))).toBeNull();
    expect(matchClipboardShortcut(key({ key: "c", ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(matchClipboardShortcut(key({ key: "x", ctrlKey: true, altKey: true }))).toBeNull();
    expect(matchClipboardShortcut(key({ key: "d", ctrlKey: true, altKey: true }))).toBeNull();
    expect(matchClipboardShortcut(key({ key: "v", ctrlKey: true, shiftKey: true, altKey: true }))).toBeNull();
    expect(matchClipboardShortcut(key({ key: "ArrowRight", ctrlKey: true }))).toBeNull();
  });

  it("Suprimir/Retroceso con Ctrl, Cmd o Alt no eliminan (son del navegador o del sistema); con Shift sí", () => {
    expect(matchClipboardShortcut(key({ key: "Delete", ctrlKey: true }))).toBeNull();
    expect(matchClipboardShortcut(key({ key: "Backspace", metaKey: true }))).toBeNull();
    expect(matchClipboardShortcut(key({ key: "Backspace", altKey: true }))).toBeNull();
    expect(matchClipboardShortcut(key({ key: "Delete", shiftKey: true }))).toBe("delete");
  });

  it("la lista de atajos documentada cubre todas las acciones, una vez cada una", () => {
    const actions = CLIPBOARD_SHORTCUTS.map((shortcut) => shortcut.action).sort();
    expect(actions).toEqual(["copy", "cut", "delete", "duplicate", "paste", "paste-active", "paste-in-place"]);
    expect(CLIPBOARD_SHORTCUTS.every((shortcut) => shortcut.keys.length > 0 && shortcut.ariaKeys.length > 0)).toBe(true);
  });
});

describe("isTextFieldTarget", () => {
  const target = (tagName: string, isContentEditable = false) => ({ tagName, isContentEditable }) as unknown as EventTarget;

  it("input, textarea, select y contentEditable son campos de texto; botón, canvas y null no", () => {
    expect(isTextFieldTarget(target("INPUT"))).toBe(true);
    expect(isTextFieldTarget(target("TEXTAREA"))).toBe(true);
    expect(isTextFieldTarget(target("SELECT"))).toBe(true);
    expect(isTextFieldTarget(target("DIV", true))).toBe(true);
    expect(isTextFieldTarget(target("BUTTON"))).toBe(false);
    expect(isTextFieldTarget(target("DIV"))).toBe(false);
    expect(isTextFieldTarget(null)).toBe(false);
  });
});

describe("clipboardAvailability", () => {
  const base = { selected: 2, editable: 2, clipboardSize: 3, hasActiveLayer: true, suspended: false };

  it("con selección, portapapeles y capa activa todo está habilitado", () => {
    expect(Object.values(clipboardAvailability(base)).every((reason) => reason === null)).toBe(true);
  });

  it("sin selección: copiar/cortar/duplicar/eliminar deshabilitados con motivo; pegar sigue habilitado", () => {
    const result = clipboardAvailability({ ...base, selected: 0, editable: 0 });
    expect(result.copy).toMatch(/Seleccioná objetos para copiar/);
    expect(result.cut).toMatch(/Seleccioná objetos para cortar/);
    expect(result.duplicate).toMatch(/Seleccioná objetos para duplicar/);
    expect(result.delete).toMatch(/Seleccioná objetos para eliminar/);
    expect(result.paste).toBeNull();
    expect(result["paste-in-place"]).toBeNull();
    expect(result["paste-active"]).toBeNull();
  });

  it("portapapeles vacío: las tres variantes de pegar deshabilitadas; copiar y eliminar no", () => {
    const result = clipboardAvailability({ ...base, clipboardSize: 0 });
    expect(result.paste).toMatch(/portapapeles está vacío/);
    expect(result["paste-in-place"]).toMatch(/portapapeles está vacío/);
    expect(result["paste-active"]).toMatch(/portapapeles está vacío/);
    expect(result.copy).toBeNull();
    expect(result.delete).toBeNull();
  });

  it("solo objetos bloqueados: se puede copiar, no cortar/duplicar/eliminar", () => {
    const result = clipboardAvailability({ ...base, selected: 2, editable: 0 });
    expect(result.copy).toBeNull();
    expect(result.cut).toMatch(/capas bloqueadas/);
    expect(result.duplicate).toMatch(/capas bloqueadas/);
    expect(result.delete).toMatch(/capas bloqueadas/);
  });

  it("pegar en la capa activa exige capa activa", () => {
    expect(clipboardAvailability({ ...base, hasActiveLayer: false })["paste-active"]).toMatch(/No hay capa activa/);
    expect(clipboardAvailability({ ...base, hasActiveLayer: false }).paste).toBeNull();
  });

  it("con una transformación pendiente todo queda deshabilitado", () => {
    const result = clipboardAvailability({ ...base, suspended: true });
    expect(Object.values(result).every((reason) => reason !== null && /transformación pendiente/.test(reason))).toBe(true);
  });
});

describe("mensajes", () => {
  it("outcomeText concuerda en singular y plural", () => {
    expect(outcomeText("paste", 1)).toBe("Se pegó 1 objeto");
    expect(outcomeText("paste", 3)).toBe("Se pegaron 3 objetos");
    expect(outcomeText("copy", 2)).toBe("Se copiaron 2 objetos");
    expect(outcomeText("duplicate", 1)).toBe("Se duplicó 1 objeto");
    expect(outcomeText("cut", 2)).toBe("Se cortaron 2 objetos");
    expect(outcomeText("delete", 1)).toBe("Se eliminó 1 objeto");
  });

  it("describeSkipped nombra cantidad, capa y motivo (bloqueada / oculta / eliminada)", () => {
    expect(
      describeSkipped(
        [
          { reason: "locked", count: 2, layerGroupId: "C", layerName: "Verde" },
          { reason: "hidden", count: 1, layerGroupId: "D", layerName: "Oculta" },
          { reason: "missing", count: 1, layerGroupId: "Z", layerName: "Vieja" },
        ],
        "paste",
      ),
    ).toBe("2 objetos no se pegaron (capa «Verde» bloqueada); 1 objeto no se pegó (capa «Oculta» oculta); 1 objeto no se pegó (capa «Vieja» eliminada)");
    expect(describeSkipped([{ reason: "locked", count: 1, layerGroupId: "C", layerName: "Verde" }], "delete")).toBe("1 objeto no se eliminó (capa «Verde» bloqueada)");
  });
});

describe("estado del portapapeles (offset acumulado)", () => {
  it("copiar reinicia el contador; cada pegado con offset suma un paso: 1x, 2x, 3x", () => {
    const document = makeDocument();
    let state = copyToClipboard(copyOf(document, "a1"));
    expect(state.pasteCount).toBe(0);
    expect(nextPasteOffset(state, MM_PER_UNIT)).toEqual({ x: 10, y: 10 });
    state = registerPaste(state);
    expect(nextPasteOffset(state, MM_PER_UNIT)).toEqual({ x: 20, y: 20 });
    state = registerPaste(state);
    expect(nextPasteOffset(state, MM_PER_UNIT)).toEqual({ x: 30, y: 30 });

    // Volver a copiar (o cortar) reinicia el contador, aunque sea lo mismo.
    state = copyToClipboard(copyOf(document, "a1"));
    expect(nextPasteOffset(state, MM_PER_UNIT)).toEqual({ x: 10, y: 10 });
  });

  it("registrar un pegado en un portapapeles vacío no hace nada", () => {
    expect(registerPaste(EMPTY_CLIPBOARD)).toBe(EMPTY_CLIPBOARD);
    expect(EMPTY_CLIPBOARD.content).toBeNull();
  });

  it("tres pegados consecutivos caen 10, 20 y 30 unidades más allá del original (valores calculados a mano)", () => {
    let document = makeDocument();
    let state = copyToClipboard(copyOf(document, "a1"));
    const createId = counter();
    const pastedX: number[] = [];
    for (let paste = 0; paste < 3; paste += 1) {
      const plan = planPaste(state.content, document, { mode: "offset", offset: nextPasteOffset(state, MM_PER_UNIT), createId });
      document = applyProduction(document, plan.production);
      state = registerPaste(state);
      pastedX.push(bounds(plan.newObjects)!.x);
    }
    expect(pastedX).toEqual([10, 20, 30]);
  });
});

describe("buildClipboard", () => {
  it("es una copia PROFUNDA: mutar el original después de copiar no cambia el portapapeles", () => {
    const document = makeDocument();
    const original = document.objectsByLayer.A[1];
    const content = buildClipboard([original], document)!;
    const snapshot = JSON.parse(JSON.stringify(content));

    original.matrix.e = 999;
    original.matrix.a = 3;
    original.d = "M0 0 L1 1";
    original.fill = "#123456";
    original.stroke = "#654321";
    original.strokeWidth = 9;
    original.layerGroupId = "B";

    expect(JSON.parse(JSON.stringify(content))).toEqual(snapshot);
    expect(content.items[0].matrix).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 5, f: 7 });
    expect(content.items[0].d).toBe("M20 20 H40 V40 H20 Z");
  });

  it("no comparte la matriz con el original (ni siquiera por referencia)", () => {
    const document = makeDocument();
    const original = document.objectsByLayer.A[1];
    const content = buildClipboard([original], document)!;
    expect(content.items[0].matrix).not.toBe(original.matrix);
  });

  it("es inmutable: el contenido, los items y las matrices están congelados", () => {
    const content = copyOf(makeDocument(), "a2");
    expect(Object.isFrozen(content)).toBe(true);
    expect(Object.isFrozen(content.items)).toBe(true);
    expect(Object.isFrozen(content.items[0])).toBe(true);
    expect(Object.isFrozen(content.items[0].matrix)).toBe(true);
    expect(() => {
      (content.items[0].matrix as { e: number }).e = 1;
    }).toThrow(TypeError);
  });

  it("NO guarda ids: ni en el contenido ni en los items", () => {
    const content = copyOf(makeDocument(), "a1", "b1");
    expect(JSON.stringify(content)).not.toMatch(/"id"/);
    expect(content.items.every((item) => !("id" in item))).toBe(true);
  });

  it("guarda d, fill, stroke, strokeWidth, matriz y la capa de origen (id, nombre y color)", () => {
    const content = copyOf(makeDocument(), "a4", "a3");
    const [a3, a4] = content.items;
    expect(a3).toMatchObject({ layerGroupId: "A", layerName: "Rojo", layerColorHex: "#ff0000", d: "M0 0 H10 V10 H0 Z M2 2 H8 V8 H2 Z", fill: "#ff0000", matrix: { a: 2, b: 0, c: 0, d: 2, e: 1, f: 1 } });
    expect(a4).toMatchObject({ fill: "none", stroke: "#ff0000", strokeWidth: 0.1, d: "M0 100 L50 100" });
    // Un objeto sin trazo no gana propiedades de trazo.
    expect("stroke" in a3).toBe(false);
    expect("strokeWidth" in a3).toBe(false);
  });

  it("orden de pintado del DOCUMENTO, no el de la selección (z-order relativo conservado)", () => {
    const document = makeDocument();
    const content = buildClipboard(pick(document, "b1", "a2", "a1").reverse(), document)!;
    expect(content.items.map((item) => item.d)).toEqual([
      "M0 0 H40 V40 H0 Z", // a1
      "M20 20 H40 V40 H20 Z", // a2
      "M100 100 H140 V140 H100 Z", // b1
    ]);
  });

  it("la posición relativa de cada objeto respecto del conjunto sale del bbox: a1 (0,0,40,40) y a2 desplazado (25,27,20,20)", () => {
    const content = copyOf(makeDocument(), "a1", "a2");
    expect(content.bounds).toEqual({ x: 0, y: 0, width: 45, height: 47 });
    expect(content.items[0].relative).toEqual({ x: 0, y: 0 });
    expect(content.items[1].relative).toEqual({ x: 25, y: 27 });
    // Un objeto solo: su propia esquina es el origen del conjunto.
    expect(copyOf(makeDocument(), "b1").items[0].relative).toEqual({ x: 0, y: 0 });
    expect(copyOf(makeDocument(), "b1").bounds).toEqual({ x: 100, y: 100, width: 40, height: 40 });
  });

  it("copiar incluye objetos de capas bloqueadas (es una lectura)", () => {
    const content = copyOf(makeDocument(), "c1", "a1");
    expect(content.items.map((item) => item.layerGroupId)).toEqual(["A", "C"]);
  });

  it("ids inexistentes se descartan; sin nada que copiar es null", () => {
    const document = makeDocument();
    expect(buildClipboard([], document)).toBeNull();
    expect(buildClipboard([{ id: "fantasma", layerGroupId: "A", d: "M0 0", fill: "#000", matrix: IDENTITY }], document)).toBeNull();
    const mixed = buildClipboard([...pick(document, "a1"), { id: "fantasma", layerGroupId: "A", d: "M0 0", fill: "#000", matrix: IDENTITY }], document)!;
    expect(mixed.items).toHaveLength(1);
  });

  it("toma la geometría del documento (manda), no del objeto que se le pasó", () => {
    const document = makeDocument();
    const stale = { ...document.objectsByLayer.A[0], d: "M999 999 H1000 V1000 H999 Z" };
    expect(buildClipboard([stale], document)!.items[0].d).toBe("M0 0 H40 V40 H0 Z");
  });
});

describe("planPaste — ids nuevos y únicos", () => {
  it("ningún id pegado se repite con el original ni con otro pegado, ni siquiera tras pegar varias veces", () => {
    let document = makeDocument();
    const content = copyOf(document, "a1", "a2", "b1");
    const createId = counter();
    for (let paste = 0; paste < 4; paste += 1) {
      const plan = planPaste(content, document, { mode: "offset", offset: { x: 10, y: 10 }, createId });
      expect(plan.newIds).toHaveLength(3);
      document = applyProduction(document, plan.production);
    }
    const ids = allIds(document);
    expect(new Set(ids).size).toBe(ids.length);
    // Los originales conservan su id y los pegados son otros.
    expect(ids).toContain("a1");
    expect(document.objectsByLayer.A.filter((object) => object.id === "a1")).toHaveLength(1);
  });

  it("un createId defectuoso (repite el id del original, o siempre el mismo) igualmente produce ids únicos", () => {
    const document = makeDocument();
    const content = copyOf(document, "a1", "a2", "b1");

    const cloning = planPaste(content, document, { mode: "in-place", offset: { x: 0, y: 0 }, createId: () => "a1" });
    expect(cloning.newIds).not.toContain("a1");
    expect(new Set(cloning.newIds).size).toBe(3);

    const constant = planPaste(content, document, { mode: "in-place", offset: { x: 0, y: 0 }, createId: () => "siempre-igual" });
    expect(new Set(constant.newIds).size).toBe(3);
    const merged = applyProduction(document, constant.production);
    expect(new Set(allIds(merged)).size).toBe(allIds(merged).length);
  });

  it("un createId que devuelve vacío tampoco deja objetos sin id", () => {
    const plan = planPaste(copyOf(makeDocument(), "a1"), makeDocument(), { mode: "offset", offset: { x: 1, y: 1 }, createId: () => "" });
    expect(plan.newIds[0]).toBeTruthy();
  });

  it("usa createId inyectado, en orden de pintado", () => {
    const plan = planPaste(copyOf(makeDocument(), "a2", "a1"), makeDocument(), { mode: "offset", offset: { x: 0, y: 0 }, createId: counter("nuevo-") });
    expect(plan.newIds).toEqual(["nuevo-1", "nuevo-2"]);
    expect(plan.newObjects.map((object) => object.d)).toEqual(["M0 0 H40 V40 H0 Z", "M20 20 H40 V40 H20 Z"]);
  });

  it("sin createId usa UUIDs (únicos entre sí)", () => {
    const plan = planPaste(copyOf(makeDocument(), "a1", "a2"), makeDocument(), { mode: "offset", offset: { x: 0, y: 0 } });
    expect(plan.newIds[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(plan.newIds[0]).not.toBe(plan.newIds[1]);
  });
});

describe("planPaste — posición", () => {
  it("con offset: la matriz se traslada exactamente (a1 identidad -> e=10,f=10; a2 e=5,f=7 -> e=15,f=17)", () => {
    const document = makeDocument();
    const plan = planPaste(copyOf(document, "a1", "a2"), document, { mode: "offset", offset: { x: 10, y: 10 }, createId: counter() });
    expect(plan.newObjects[0].matrix).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 10, f: 10 });
    expect(plan.newObjects[1].matrix).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 15, f: 17 });
    // El path data no se reescribe: el desplazamiento vive en la matriz.
    expect(plan.newObjects[0].d).toBe("M0 0 H40 V40 H0 Z");
  });

  it("el offset se aplica en espacio de documento también sobre objetos escalados (a3 con escala 2: e=1+10, f=1+10)", () => {
    const document = makeDocument();
    const plan = planPaste(copyOf(document, "a3"), document, { mode: "offset", offset: { x: 10, y: 10 }, createId: counter() });
    expect(plan.newObjects[0].matrix).toEqual({ a: 2, b: 0, c: 0, d: 2, e: 11, f: 11 });
  });

  it("pegar en el lugar es exacto (misma matriz, mismo bbox) y IGNORA el offset recibido", () => {
    const document = makeDocument();
    const content = copyOf(document, "a1", "a2", "a3");
    const plan = planPaste(content, document, { mode: "in-place", offset: { x: 123, y: 456 }, createId: counter() });
    expect(plan.newObjects.map((object) => object.matrix)).toEqual(pick(document, "a1", "a2", "a3").map((object) => object.matrix));
    expect(bounds(plan.newObjects)).toEqual(bounds(pick(document, "a1", "a2", "a3")));
    // Misma posición pero objetos distintos: ids nuevos y matriz propia.
    expect(plan.newObjects[0].matrix).not.toBe(content.items[0].matrix);
  });

  it("un offset no finito se trata como 0 (nunca NaN en la matriz)", () => {
    const document = makeDocument();
    const plan = planPaste(copyOf(document, "a2"), document, { mode: "offset", offset: { x: Number.NaN, y: Number.POSITIVE_INFINITY }, createId: counter() });
    expect(plan.newObjects[0].matrix).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 5, f: 7 });
  });

  it("duplicar repetidamente repite el MISMO delta desde el último duplicado: 10, 20, 30", () => {
    let document = makeDocument();
    let selection = pick(document, "a1");
    const createId = counter();
    const positions: number[] = [];
    for (let times = 0; times < 3; times += 1) {
      const plan = planDuplicate(selection, document, { offset: pasteOffset(1, MM_PER_UNIT), createId });
      document = applyProduction(document, plan.production);
      selection = plan.newObjects;
      positions.push(bounds(selection)!.x);
    }
    expect(positions).toEqual([10, 20, 30]);
  });
});

describe("planPaste — capa de destino y z-order", () => {
  it("cada objeto va a SU capa de origen, encima de los existentes y en orden relativo", () => {
    const document = makeDocument();
    const plan = planPaste(copyOf(document, "a1", "a3", "b1"), document, { mode: "offset", offset: { x: 10, y: 10 }, createId: counter() });
    expect(Object.keys(plan.production!.layers).sort()).toEqual(["A", "B"]);
    expect(plan.production!.layers.A.map((object) => object.id)).toEqual(["a1", "a2", "a3", "a4", "n1", "n2"]);
    expect(plan.production!.layers.B.map((object) => object.id)).toEqual(["b1", "n3"]);
    expect(plan.newObjects.map((object) => object.layerGroupId)).toEqual(["A", "A", "B"]);
    // Los existentes conservan su referencia (no se tocan).
    expect(plan.production!.layers.A[0]).toBe(document.objectsByLayer.A[0]);
  });

  it("la producción es atómica y NO muta el documento ni el portapapeles", () => {
    const document = makeDocument();
    const before = JSON.stringify(document);
    const content = copyOf(document, "a1", "b1");
    const contentBefore = JSON.stringify(content);
    const plan = planPaste(content, document, { mode: "offset", offset: { x: 10, y: 10 }, createId: counter() });
    expect(plan.production!.atomic).toBe(true);
    expect(JSON.stringify(document)).toBe(before);
    expect(JSON.stringify(content)).toBe(contentBefore);
  });

  it("capa de origen bloqueada: el objeto se OMITE con motivo; el resto se pega", () => {
    const document = makeDocument();
    const plan = planPaste(copyOf(document, "a1", "c1"), document, { mode: "offset", offset: { x: 10, y: 10 }, createId: counter() });
    expect(plan.summary.pasted).toBe(1);
    expect(plan.summary.skipped).toEqual([{ reason: "locked", count: 1, layerGroupId: "C", layerName: "Verde" }]);
    expect(plan.summary.skippedCount).toBe(1);
    expect(Object.keys(plan.production!.layers)).toEqual(["A"]);
    expect(plan.error).toBeNull();
  });

  it("capa de origen oculta: se omite con motivo 'hidden'", () => {
    const document = makeDocument();
    const plan = planPaste(copyOf(document, "a1", "d1"), document, { mode: "offset", offset: { x: 10, y: 10 }, createId: counter() });
    expect(plan.summary.skipped).toEqual([{ reason: "hidden", count: 1, layerGroupId: "D", layerName: "Oculta" }]);
    expect(Object.keys(plan.production!.layers)).toEqual(["A"]);
  });

  it("capa de origen eliminada: se omite con motivo 'missing' y el nombre que tenía al copiar", () => {
    const document = makeDocument();
    const content = copyOf(document, "a1", "b1");
    const withoutB = makeDocument([LAYER_A, LAYER_C, LAYER_D]);
    const plan = planPaste(content, withoutB, { mode: "offset", offset: { x: 10, y: 10 }, createId: counter() });
    expect(plan.summary.skipped).toEqual([{ reason: "missing", count: 1, layerGroupId: "B", layerName: "Azul" }]);
    // No se pegó en silencio en otra capa.
    expect(Object.keys(plan.production!.layers)).toEqual(["A"]);
    expect(plan.production!.layers.A).toHaveLength(5);
  });

  it("varios omitidos de la misma capa se agrupan; de distintas capas/motivos son entradas separadas", () => {
    const document = makeDocument();
    document.objectsByLayer.C.push({ id: "c2", layerGroupId: "C", d: "M0 0 H5 V5 H0 Z", fill: "#00ff00", matrix: { ...IDENTITY } });
    const plan = planPaste(copyOf(document, "c1", "c2", "d1", "a1"), document, { mode: "offset", offset: { x: 10, y: 10 }, createId: counter() });
    expect(plan.summary.skipped).toEqual([
      { reason: "locked", count: 2, layerGroupId: "C", layerName: "Verde" },
      { reason: "hidden", count: 1, layerGroupId: "D", layerName: "Oculta" },
    ]);
    expect(plan.summary.skippedCount).toBe(3);
    expect(plan.summary.pasted).toBe(1);
  });

  it("si NINGÚN objeto es pegable: rechazo con motivo, sin producción (sin comando)", () => {
    const document = makeDocument();
    const plan = planPaste(copyOf(document, "c1", "d1"), document, { mode: "offset", offset: { x: 10, y: 10 }, createId: counter() });
    expect(plan.production).toBeNull();
    expect(plan.newObjects).toEqual([]);
    expect(plan.summary.pasted).toBe(0);
    expect(plan.error).toMatch(/No se pegó nada/);
    expect(plan.error).toMatch(/1 objeto no se pegó \(capa «Verde» bloqueada\)/);
    expect(plan.error).toMatch(/1 objeto no se pegó \(capa «Oculta» oculta\)/);
    expect(plan.error).toMatch(/Pegar en la capa activa/);
  });

  it("portapapeles vacío o nulo: rechazo claro", () => {
    expect(planPaste(null, makeDocument(), { mode: "offset", offset: { x: 1, y: 1 } })).toMatchObject({ production: null, error: expect.stringMatching(/portapapeles está vacío/) });
    expect(planPaste({ items: [], bounds: null }, makeDocument(), { mode: "offset", offset: { x: 1, y: 1 } }).production).toBeNull();
  });

  it("pega en una capa cargada pero VACÍA ([]), y deja intactas las demás", () => {
    const document = makeDocument();
    document.objectsByLayer.B = [];
    const content = copyOf(makeDocument(), "b1");
    const plan = planPaste(content, document, { mode: "offset", offset: { x: 10, y: 10 }, createId: counter() });
    expect(plan.production!.layers.B.map((object) => object.id)).toEqual(["n1"]);
  });

  it("una capa que todavía no cargó sus objetos (sin entrada) no admite el pegado: se omite con motivo 'unloaded' (se perdería al cargar)", () => {
    const document = makeDocument();
    delete (document.objectsByLayer as Record<string, EditorObject[]>).B;
    const content = copyOf(makeDocument(), "a1", "b1");
    const plan = planPaste(content, document, { mode: "offset", offset: { x: 10, y: 10 }, createId: counter() });
    expect(plan.summary.skipped).toEqual([{ reason: "unloaded", count: 1, layerGroupId: "B", layerName: "Azul" }]);
    expect(Object.keys(plan.production!.layers)).toEqual(["A"]);
    expect(describeSkipped(plan.summary.skipped, "paste")).toBe("1 objeto no se pegó (capa «Azul» sin cargar)");
    // También como destino de "Pegar en la capa activa".
    const active = planPaste(content, document, { mode: "active-layer", offset: { x: 0, y: 0 }, activeLayerId: "B" });
    expect(active.production).toBeNull();
    expect(active.error).toMatch(/capa «Azul» sin cargar/);
  });

  it("capas nuevas (isNew) se copian y pegan como cualquier otra", () => {
    const fresh = meta({ groupId: "N", name: "Color #123456", colorHex: "#123456", order: 4, isNew: true });
    const document = makeDocument([...ALL_LAYERS, fresh]);
    document.objectsByLayer.N = [{ id: "n-1", layerGroupId: "N", d: "M0 0 H5 V5 H0 Z", fill: "#123456", matrix: { ...IDENTITY, e: 3 } }];
    const plan = planPaste(copyOf(document, "n-1"), document, { mode: "offset", offset: { x: 10, y: 10 }, createId: counter() });
    expect(plan.newObjects[0]).toMatchObject({ layerGroupId: "N", fill: "#123456", matrix: { e: 13, f: 10 } });
  });

  it("usa `options.layers` si se lo pasa (por encima de document.layers)", () => {
    const document = makeDocument();
    const plan = planPaste(copyOf(document, "a1"), document, { mode: "offset", offset: { x: 10, y: 10 }, layers: [{ ...LAYER_A, locked: true }, LAYER_B] });
    expect(plan.production).toBeNull();
    expect(plan.summary.skipped[0]).toMatchObject({ reason: "locked", layerGroupId: "A" });
  });
});

describe("planPaste — objetos con matriz, trazo, compound path", () => {
  it("un compound path se pega como UN solo objeto con su path data (subpaths y huecos) intacto", () => {
    const document = makeDocument();
    const plan = planPaste(copyOf(document, "a3"), document, { mode: "in-place", offset: { x: 0, y: 0 }, createId: counter() });
    expect(plan.newObjects).toHaveLength(1);
    expect(plan.newObjects[0].d).toBe("M0 0 H10 V10 H0 Z M2 2 H8 V8 H2 Z");
    expect(plan.summary.pasted).toBe(1);
  });

  it("una línea abierta conserva fill 'none', stroke y strokeWidth; un objeto con matriz conserva sus 6 coeficientes", () => {
    const document = makeDocument();
    const plan = planPaste(copyOf(document, "a4", "a3"), document, { mode: "in-place", offset: { x: 0, y: 0 }, createId: counter() });
    const [a3, a4] = plan.newObjects;
    expect(a4).toMatchObject({ fill: "none", stroke: "#ff0000", strokeWidth: 0.1, d: "M0 100 L50 100" });
    expect(a3.matrix).toEqual({ a: 2, b: 0, c: 0, d: 2, e: 1, f: 1 });
    expect("stroke" in a3).toBe(false);
  });
});

describe("planPaste — pegar en la capa activa", () => {
  it("todos los objetos van a la capa activa y toman su color (relleno)", () => {
    const document = makeDocument();
    const plan = planPaste(copyOf(document, "a1", "a2"), document, { mode: "active-layer", offset: { x: 10, y: 10 }, activeLayerId: "B", createId: counter() });
    expect(plan.newObjects.map((object) => object.layerGroupId)).toEqual(["B", "B"]);
    expect(plan.newObjects.map((object) => object.fill)).toEqual(["#0000ff", "#0000ff"]);
    expect(Object.keys(plan.production!.layers)).toEqual(["B"]);
    expect(plan.production!.layers.B.map((object) => object.id)).toEqual(["b1", "n1", "n2"]);
    expect(plan.label).toBe("Pegar 2 objetos en la capa «Azul»");
  });

  it("una línea abierta toma el color de la capa en su TRAZO (sigue sin relleno)", () => {
    const document = makeDocument();
    const plan = planPaste(copyOf(document, "a4"), document, { mode: "active-layer", offset: { x: 0, y: 0 }, activeLayerId: "B", createId: counter() });
    expect(plan.newObjects[0]).toMatchObject({ layerGroupId: "B", fill: "none", stroke: "#0000ff", strokeWidth: 0.1 });
  });

  it("aplica el offset como un pegado normal", () => {
    const document = makeDocument();
    const plan = planPaste(copyOf(document, "a1"), document, { mode: "active-layer", offset: { x: 10, y: 10 }, activeLayerId: "B", createId: counter() });
    expect(plan.newObjects[0].matrix).toMatchObject({ e: 10, f: 10 });
  });

  it("mezcla de capas de origen: todo converge en la activa conservando el orden de pintado", () => {
    const document = makeDocument();
    const plan = planPaste(copyOf(document, "b1", "a1"), document, { mode: "active-layer", offset: { x: 0, y: 0 }, activeLayerId: "A", createId: counter() });
    expect(plan.newObjects.map((object) => object.d)).toEqual(["M0 0 H40 V40 H0 Z", "M100 100 H140 V140 H100 Z"]);
    expect(plan.newObjects.map((object) => object.fill)).toEqual(["#ff0000", "#ff0000"]);
  });

  it("si al copiar no se conocía el color de la capa de origen (sin estructura de capas), cambiar de capa recolorea igual", () => {
    const document = makeDocument();
    const withoutLayers = buildClipboard(pick(document, "a1"), { objectsByLayer: document.objectsByLayer })!;
    expect(withoutLayers.items[0].layerColorHex).toBeNull();
    const plan = planPaste(withoutLayers, document, { mode: "active-layer", offset: { x: 0, y: 0 }, activeLayerId: "B", createId: counter() });
    expect(plan.newObjects[0]).toMatchObject({ layerGroupId: "B", fill: "#0000ff" });
    // En su propia capa de origen no hay nada que recolorear.
    const same = planPaste(withoutLayers, document, { mode: "offset", offset: { x: 0, y: 0 }, createId: counter() });
    expect(same.newObjects[0].fill).toBe("#ff0000");
  });

  it("pegar en la misma capa de origen no recolorea (fidelidad: conserva el fill tal cual)", () => {
    const document = makeDocument();
    document.objectsByLayer.A[0].fill = "#FF0000"; // mismo color, otra caja
    const plan = planPaste(copyOf(document, "a1"), document, { mode: "active-layer", offset: { x: 10, y: 10 }, activeLayerId: "A", createId: counter() });
    expect(plan.newObjects[0].fill).toBe("#FF0000");
  });

  it("sin capa activa (null, o una capa que no existe) se rechaza sin comando", () => {
    const document = makeDocument();
    const content = copyOf(document, "a1");
    for (const activeLayerId of [null, undefined, "no-existe"]) {
      const plan = planPaste(content, document, { mode: "active-layer", offset: { x: 0, y: 0 }, activeLayerId });
      expect(plan.production).toBeNull();
      expect(plan.error).toMatch(/No hay capa activa/);
    }
  });

  it("capa activa bloqueada u oculta: todo se omite con motivo y no hay comando", () => {
    const document = makeDocument();
    const content = copyOf(document, "a1", "a2");
    const locked = planPaste(content, document, { mode: "active-layer", offset: { x: 0, y: 0 }, activeLayerId: "C" });
    expect(locked.production).toBeNull();
    expect(locked.summary.skipped).toEqual([{ reason: "locked", count: 2, layerGroupId: "C", layerName: "Verde" }]);
    expect(locked.error).toMatch(/2 objetos no se pegaron \(capa «Verde» bloqueada\)/);
    const hidden = planPaste(content, document, { mode: "active-layer", offset: { x: 0, y: 0 }, activeLayerId: "D" });
    expect(hidden.production).toBeNull();
    expect(hidden.error).toMatch(/capa «Oculta» oculta/);
    // En este modo no se sugiere "Pegar en la capa activa" (ya es lo que se hizo).
    expect(locked.error).not.toMatch(/Usá «Pegar en la capa activa»/);
  });

  it("puede pegar objetos cuya capa de origen está bloqueada u oculta (es justamente la alternativa)", () => {
    const document = makeDocument();
    const plan = planPaste(copyOf(document, "c1", "d1"), document, { mode: "active-layer", offset: { x: 0, y: 0 }, activeLayerId: "A", createId: counter() });
    expect(plan.summary.pasted).toBe(2);
    expect(plan.newObjects.map((object) => object.fill)).toEqual(["#ff0000", "#ff0000"]);
  });
});

describe("planPaste — la capa de origen cambió de color desde que se copió", () => {
  it("los pegados en su capa de origen toman el color ACTUAL de la capa (el color de un objeto es el de su capa)", () => {
    const document = makeDocument();
    const content = copyOf(document, "a1", "a4");
    const recolored = makeDocument([{ ...LAYER_A, colorHex: "#00ff00" }, LAYER_B, LAYER_C, LAYER_D]);
    const plan = planPaste(content, recolored, { mode: "offset", offset: { x: 10, y: 10 }, createId: counter() });
    expect(plan.newObjects[0].fill).toBe("#00ff00");
    expect(plan.newObjects[1]).toMatchObject({ fill: "none", stroke: "#00ff00" });
  });

  it("si el color es el mismo (aunque cambie la caja del hex) no se toca el objeto", () => {
    const document = makeDocument();
    const content = copyOf(document, "a1");
    const sameColor = makeDocument([{ ...LAYER_A, colorHex: "#FF0000" }, LAYER_B, LAYER_C, LAYER_D]);
    const plan = planPaste(content, sameColor, { mode: "offset", offset: { x: 10, y: 10 }, createId: counter() });
    expect(plan.newObjects[0].fill).toBe("#ff0000");
  });
});

describe("planPaste — etiquetas", () => {
  it("'Pegar N objetos', 'Pegar N objetos en el lugar', 'Pegar 1 objeto'", () => {
    const document = makeDocument();
    expect(planPaste(copyOf(document, "a1", "b1", "a2"), document, { mode: "offset", offset: { x: 1, y: 1 } }).label).toBe("Pegar 3 objetos");
    expect(planPaste(copyOf(document, "a1"), document, { mode: "offset", offset: { x: 1, y: 1 } }).label).toBe("Pegar 1 objeto");
    expect(planPaste(copyOf(document, "a1", "a2"), document, { mode: "in-place", offset: { x: 1, y: 1 } }).label).toBe("Pegar 2 objetos en el lugar");
  });

  it("el label cuenta lo pegado, no lo copiado (los omitidos no suman)", () => {
    const document = makeDocument();
    expect(planPaste(copyOf(document, "a1", "a2", "c1"), document, { mode: "offset", offset: { x: 1, y: 1 } }).label).toBe("Pegar 2 objetos");
  });
});

describe("planDuplicate", () => {
  it("duplica la selección en la capa de cada objeto, desplazada; etiqueta 'Duplicar N objetos'", () => {
    const document = makeDocument();
    const plan = planDuplicate(pick(document, "a1", "b1"), document, { offset: { x: 10, y: 10 }, createId: counter() });
    expect(plan.label).toBe("Duplicar 2 objetos");
    expect(plan.newObjects.map((object) => [object.layerGroupId, object.matrix.e, object.matrix.f])).toEqual([
      ["A", 10, 10],
      ["B", 10, 10],
    ]);
    expect(plan.newIds.every((id) => !allIds(document).includes(id))).toBe(true);
  });

  it("selección simple: 'Duplicar 1 objeto'", () => {
    const document = makeDocument();
    expect(planDuplicate(pick(document, "a2"), document, { offset: { x: 10, y: 10 } }).label).toBe("Duplicar 1 objeto");
  });

  it("los objetos de capas bloqueadas u ocultas no se duplican y se informa; si no queda ninguno, no hay comando", () => {
    const document = makeDocument();
    const mixed = planDuplicate(pick(document, "a1", "c1"), document, { offset: { x: 10, y: 10 }, createId: counter() });
    expect(mixed.summary.pasted).toBe(1);
    expect(describeSkipped(mixed.summary.skipped, "duplicate")).toBe("1 objeto no se duplicó (capa «Verde» bloqueada)");

    const none = planDuplicate(pick(document, "c1"), document, { offset: { x: 10, y: 10 } });
    expect(none.production).toBeNull();
    expect(none.error).toMatch(/No se duplicó nada/);
    expect(none.error).not.toMatch(/Pegar en la capa activa/);
  });

  it("selección vacía: rechazo", () => {
    const plan = planDuplicate([], makeDocument(), { offset: { x: 10, y: 10 } });
    expect(plan.production).toBeNull();
    expect(plan.error).toMatch(/No hay objetos seleccionados para duplicar/);
  });
});

describe("planDelete", () => {
  it("elimina los objetos pedidos (varias capas) en UNA producción; etiqueta 'Eliminar N objetos'", () => {
    const document = makeDocument();
    const plan = planDelete(document, new Set(["a1", "b1"]));
    expect(plan.label).toBe("Eliminar 2 objetos");
    expect(plan.deleted.map((object) => object.id)).toEqual(["a1", "b1"]);
    expect(plan.production!.layers.A.map((object) => object.id)).toEqual(["a2", "a3", "a4"]);
    expect(plan.production!.layers.B).toEqual([]);
    expect(Object.keys(plan.production!.layers).sort()).toEqual(["A", "B"]);
    expect(plan.error).toBeNull();
  });

  it("selección simple: 'Eliminar 1 objeto'", () => {
    expect(planDelete(makeDocument(), new Set(["a2"])).label).toBe("Eliminar 1 objeto");
  });

  it("omite lo de capas bloqueadas y lo informa; la capa bloqueada ni se toca", () => {
    const plan = planDelete(makeDocument(), new Set(["a1", "c1"]));
    expect(plan.deleted.map((object) => object.id)).toEqual(["a1"]);
    expect(plan.skipped).toEqual([{ reason: "locked", count: 1, layerGroupId: "C", layerName: "Verde" }]);
    expect(plan.skippedCount).toBe(1);
    expect(Object.keys(plan.production!.layers)).toEqual(["A"]);
  });

  it("omite lo de capas ocultas con su motivo", () => {
    const plan = planDelete(makeDocument(), new Set(["b1", "d1"]));
    expect(plan.skipped).toEqual([{ reason: "hidden", count: 1, layerGroupId: "D", layerName: "Oculta" }]);
    expect(plan.deleted.map((object) => object.id)).toEqual(["b1"]);
  });

  it("si todo está bloqueado: rechazo claro, sin producción (sin comando)", () => {
    const plan = planDelete(makeDocument(), new Set(["c1"]));
    expect(plan.production).toBeNull();
    expect(plan.error).toMatch(/No se eliminó nada/);
    expect(plan.error).toMatch(/capa «Verde» bloqueada/);
  });

  it("selección vacía o ids que ya no existen: rechazo sin producción", () => {
    expect(planDelete(makeDocument(), new Set()).error).toMatch(/No hay objetos seleccionados para eliminar/);
    const stale = planDelete(makeDocument(), new Set(["fantasma"]));
    expect(stale.production).toBeNull();
    expect(stale.error).toMatch(/ya no existen/);
  });

  it("sin información de capas (documento de S01) no hay bloqueos que respetar acá: elimina todo lo pedido", () => {
    const document = { objectsByLayer: makeDocument().objectsByLayer };
    const plan = planDelete(document, new Set(["a1", "c1"]));
    expect(plan.deleted.map((object) => object.id)).toEqual(["a1", "c1"]);
    expect(plan.skipped).toEqual([]);
  });

  it("no muta el documento", () => {
    const document = makeDocument();
    const before = JSON.stringify(document);
    planDelete(document, new Set(["a1", "a2"]));
    expect(JSON.stringify(document)).toBe(before);
  });
});

describe("planCut", () => {
  it("copia lo eliminable y lo elimina en la misma producción", () => {
    const document = makeDocument();
    const plan = planCut(document, new Set(["a1", "b1"]));
    expect(plan.label).toBe("Cortar 2 objetos");
    expect(plan.production!.layers.A.map((object) => object.id)).toEqual(["a2", "a3", "a4"]);
    expect(plan.clipboard!.items.map((item) => item.d)).toEqual(["M0 0 H40 V40 H0 Z", "M100 100 H140 V140 H100 Z"]);
    expect(JSON.stringify(plan.clipboard)).not.toMatch(/"id"/);
  });

  it("mezcla bloqueado/desbloqueado: solo se corta (y entra al portapapeles) lo desbloqueado; lo bloqueado se informa", () => {
    const plan = planCut(makeDocument(), new Set(["a1", "c1"]));
    expect(plan.deleted.map((object) => object.id)).toEqual(["a1"]);
    expect(plan.clipboard!.items).toHaveLength(1);
    expect(plan.clipboard!.items[0].layerGroupId).toBe("A");
    expect(plan.skipped).toEqual([{ reason: "locked", count: 1, layerGroupId: "C", layerName: "Verde" }]);
    expect(describeSkipped(plan.skipped, "cut")).toBe("1 objeto no se cortó (capa «Verde» bloqueada)");
  });

  it("un corte imposible (todo bloqueado) no produce portapapeles ni comando", () => {
    const plan = planCut(makeDocument(), new Set(["c1"]));
    expect(plan.production).toBeNull();
    expect(plan.clipboard).toBeNull();
    expect(plan.error).toMatch(/No se cortó nada/);
  });

  it("lo cortado se puede pegar de vuelta en el lugar con ids nuevos (round-trip)", () => {
    const document = makeDocument();
    const cut = planCut(document, new Set(["a2"]));
    const afterCut = applyProduction(document, cut.production);
    expect(allIds(afterCut)).not.toContain("a2");
    const paste = planPaste(cut.clipboard, afterCut, { mode: "in-place", offset: { x: 0, y: 0 }, createId: counter() });
    expect(paste.newObjects[0]).toMatchObject({ id: "n1", layerGroupId: "A", d: "M20 20 H40 V40 H20 Z", matrix: { e: 5, f: 7 } });
  });
});
