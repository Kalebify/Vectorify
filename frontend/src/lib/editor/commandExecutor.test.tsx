import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEditableDocument, type UseEditableDocumentOptions } from "../../hooks/useEditableDocument";
import type { VectorDocumentLayer } from "../../hooks/useVectorDocument";
import { abortAwareFetch, svgResponse } from "../../test/abortableFetch";
import { runArrange } from "./arrange";
import { pasteOffset, planDelete, planDuplicate } from "./clipboard";
import { arrangeDraft, colorDraft } from "./commandDrafts";
import { commandCatalog, EXECUTABLE_TYPES, executeCommand, type ExecutorResult } from "./commandExecutor";
import { COMMAND_REGISTRY, COMMAND_TYPES, isJsonValue, type CommandDraft, type CommandType, type EditorCommand } from "./commands";
import { planRecolor, recolorLabel, type RecolorRequest, type RecolorScope } from "./colors";
import { planObjectErase } from "./erase";
import { cropFrame, cropProduction, orientDocumentProduction } from "./frame";
import { composeMatrices, scaleAboutMatrix } from "./matrix";
import { moveProduction, objectsByIds } from "./operations";
import { composeOrientation, IDENTITY_ORIENTATION, orientSelectionProduction, orientationFromCommand } from "./orientation";
import { removeObjects, replaceObjects } from "./selection";
import { groupCenter, rotateAbout, setBounds } from "./transform";
import type { EditableDocument } from "./types";

/**
 * Ejecutor declarativo (M3-S12). El corazón: ejecutar un comando serializado produce EXACTAMENTE el mismo estado que la ruta de UI equivalente (dos documentos
 * idénticos, uno operado como lo hace el shell -- con las mismas funciones de `lib/editor/*` y el mismo `applyEdit`/gesto -- y otro con `executeCommand`), y los
 * comandos inválidos devuelven errores SIN tocar el documento. Además: nunca acepta ni devuelve `d`/SVG crudos.
 */

function layer(groupId: string, overrides: Partial<VectorDocumentLayer> = {}): VectorDocumentLayer {
  return {
    groupId,
    name: groupId,
    colorHex: "#ff0000",
    fill: "#ff0000",
    vectorId: `v-${groupId}`,
    svgUrl: `/svg/${groupId}`,
    pathCount: 1,
    componentCount: null,
    manufacturingOperation: "cut",
    order: 0,
    visible: true,
    locked: false,
    areaPercent: 10,
    hasPartialAlpha: false,
    isExcluded: false,
    ...overrides,
  };
}

const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240">${body}</svg>`;
const path = (id: string, d: string, fill: string) => `<path data-vid="${id}" d="${d}" fill="${fill}"/>`;
const SVGS: Record<string, string> = {
  A: svg(path("a1", "M0 0 H10 V10 H0 Z", "#ff0000") + path("a2", "M20 0 H30 V10 H20 Z", "#ff0000")),
  B: svg(path("b1", "M0 20 H10 V30 H0 Z", "#0000ff")),
  E: svg(path("e1", "M60 0 H70 V10 H60 Z", "#00ff00")),
  L: svg(path("l1", "M100 0 H110 V10 H100 Z", "#ffff00")),
  H: svg(path("h1", "M120 0 H130 V10 H120 Z", "#ff00ff")),
};

const BASE_LAYERS = [layer("A"), layer("B", { colorHex: "#0000ff", order: 1 }), layer("E", { colorHex: "#00ff00", order: 2 })];
const GUARDED_LAYERS = [...BASE_LAYERS, layer("L", { colorHex: "#ffff00", order: 3, locked: true }), layer("H", { colorHex: "#ff00ff", order: 4, visible: false })];
const SIZE = { sourceSize: { width: 320, height: 240 } };

function installFetch() {
  vi.stubGlobal(
    "fetch",
    abortAwareFetch((url) => {
      const id = url.split("/").pop() ?? "";
      return SVGS[id] ? svgResponse(SVGS[id]) : svgResponse("no existe", 404);
    }),
  );
}

type Api = ReturnType<typeof useEditableDocument>;

async function world(layers = BASE_LAYERS, options: UseEditableDocumentOptions = {}) {
  installFetch();
  let tick = 0;
  const hook = renderHook(() => useEditableDocument(layers, { ...SIZE, clock: () => 1_000 + (tick += 1), createCommandId: () => `id-${tick}`, ...options }));
  await waitFor(() => expect(Object.values(hook.result.current.layerStatus).every((status) => status === "ready")).toBe(true));
  return hook;
}

type World = Awaited<ReturnType<typeof world>>;

/** Foto exacta del estado observable (objetos, marco, capas efectivas): lo que debe coincidir entre la UI y el ejecutor. */
function capture(hook: World) {
  const api = hook.result.current;
  return structuredClone({ snapshot: api.getSnapshot(), committedLayers: api.committedLayers, geometryDirty: api.geometryDirty });
}

/** Contador de ids determinista (p1, p2...): la UI y el ejecutor lo usan por separado y deben pedir los mismos ids en el mismo orden. */
const counter = (prefix = "g") => {
  let count = 0;
  return () => `${prefix}${(count += 1)}`;
};

const lastCommand = (hook: World): EditorCommand => hook.result.current.undoCommand!;

/** Selección tal como la resuelve el shell (objetos por id). */
const selected = (api: Api, ids: string[]) => objectsByIds(api.getSnapshot(), new Set(ids));

interface Case {
  name: string;
  type: CommandType;
  targets?: { objectIds?: string[]; layerIds?: string[] };
  parameters?: Record<string, unknown>;
  /** La ruta de UI equivalente: lo que hace el shell/canvas para esa operación, con las mismas funciones. */
  ui: (api: Api, createId: () => string) => void;
  mmPerUnit?: number | null;
}

/** Aplica una producción como lo hace el shell (applyEdit con el borrador del call-site). */
const apply = (api: Api, draft: CommandDraft, producer: (state: EditableDocument) => ReturnType<Parameters<Api["applyEdit"]>[1]>) => {
  const result = api.applyEdit(draft, producer);
  expect(result.applied, `la ruta de UI de «${draft.type}» debe aplicarse`).toBe(true);
};

/** Una orientación pendiente de Apply: previsualización (gesto) + commit, como `handleApplyPending`. */
const orient = (api: Api, scope: "selection" | "document", ids: string[], draft: CommandDraft, orientation = composeOrientation(IDENTITY_ORIENTATION, "rotate-cw")) => {
  const producer = scope === "document" ? (state: EditableDocument) => orientDocumentProduction(state, orientation) : (state: EditableDocument) => orientSelectionProduction(state, new Set(ids), orientation);
  expect(api.beginGesture()).toBe(true);
  expect(api.previewEdit(producer).applied).toBe(true);
  expect(api.commitGesture(draft).applied).toBe(true);
};

const recolor = (api: Api, scope: RecolorScope, request: RecolorRequest, fromFill: boolean) => {
  const plan = planRecolor(scope, api.getSnapshot(), request);
  expect(plan.production, plan.error ?? "").not.toBeNull();
  apply(api, colorDraft(fromFill, scope, request, recolorLabel(plan.summary)), (state) => planRecolor(scope, state, request).production);
};

const CASES: Case[] = [
  {
    name: "mover (arrastre del canvas, gesto)",
    type: "object.move",
    targets: { objectIds: ["a1", "b1"] },
    parameters: { dx: 5, dy: -3 },
    ui: (api) => {
      const ids = new Set(["a1", "b1"]);
      expect(api.beginGesture()).toBe(true);
      expect(api.previewEdit((state) => moveProduction(state, ids, 5, -3)).applied).toBe(true);
      expect(api.commitGesture({ type: "object.move", label: "Mover 2 objetos", parameters: { dx: 5, dy: -3 } }).applied).toBe(true);
    },
  },
  {
    name: "empujar con las flechas (nudge)",
    type: "object.nudge",
    targets: { objectIds: ["a2"] },
    parameters: { dx: 1, dy: 0 },
    ui: (api) => {
      const ids = new Set(["a2"]);
      expect(api.applyEdit({ type: "object.nudge", label: "Mover 1 objeto", parameters: { dx: 1, dy: 0 } }, (state) => moveProduction(state, ids, 1, 0), { coalesceKey: "nudge:1:a2:a2" }).applied).toBe(true);
    },
  },
  {
    name: "escalar (Transformer: matriz de gesto sobre la de cada objeto)",
    type: "object.scale",
    targets: { objectIds: ["a1", "a2"] },
    parameters: { sx: 2, sy: 0.5 },
    ui: (api) => {
      const targets = selected(api, ["a1", "a2"]);
      const gesture = scaleAboutMatrix(groupCenter(targets)!, 2, 0.5);
      apply(api, { type: "object.scale", label: "Escalar 2 objetos", parameters: { sx: 2, sy: 0.5 } }, (state) =>
        replaceObjects(state, selected(api, ["a1", "a2"]), (found) => found.map((object) => ({ ...object, matrix: composeMatrices(gesture, object.matrix) }))),
      );
    },
  },
  {
    name: "rotar (Inspector: giro relativo alrededor del centro)",
    type: "object.rotate",
    targets: { objectIds: ["a1"] },
    parameters: { degrees: 30 },
    ui: (api) => {
      const [target] = selected(api, ["a1"]);
      const center = groupCenter([target])!;
      apply(api, { type: "object.rotate", label: "Rotar objeto (Inspector)", parameters: { degrees: 30 } }, (state) => replaceObjects(state, [target], (found) => rotateAbout(found, center, 30)));
    },
  },
  {
    name: "posicionar y dimensionar (Inspector)",
    type: "object.setBounds",
    targets: { objectIds: ["a1", "a2"] },
    parameters: { x: 5, y: 6, width: 60, height: 20 },
    ui: (api) => {
      const target = { x: 5, y: 6, width: 60, height: 20 };
      const ids = new Set(["a1", "a2"]);
      apply(api, { type: "object.setBounds", label: "Redimensionar 2 objetos (Inspector)", parameters: target }, (state) =>
        replaceObjects(
          state,
          Object.values(state.objectsByLayer)
            .flat()
            .filter((object) => ids.has(object.id)),
          (found) => setBounds(found, target) ?? found,
        ),
      );
    },
  },
  {
    name: "eliminar (planDelete)",
    type: "object.delete",
    targets: { objectIds: ["a1", "b1"] },
    ui: (api) => {
      const plan = planDelete(api.getSnapshot(), new Set(["a1", "b1"]));
      apply(api, { type: "object.delete", label: plan.label }, () => plan.production);
    },
  },
  {
    name: "borrar objetos con el borrador",
    type: "object.erase.objects",
    targets: { objectIds: ["a2", "e1"] },
    ui: (api) => {
      const snapshot = api.getSnapshot();
      const hit = selected(api, ["a2", "e1"]);
      const plan = planObjectErase(snapshot, hit, new Set());
      apply(api, { type: "object.erase.objects", label: `Borrar ${plan.removed} objetos` }, (state) => removeObjects(state, new Set(hit.map((object) => object.id))));
    },
  },
  {
    name: "duplicar (desplazamiento de pegado por defecto, con escala física)",
    type: "object.duplicate",
    targets: { objectIds: ["a1", "b1"] },
    mmPerUnit: 0.5,
    ui: (api, createId) => {
      const offset = pasteOffset(1, 0.5);
      const plan = planDuplicate(selected(api, ["a1", "b1"]), api.getSnapshot(), { offset, createId });
      apply(api, { type: "object.duplicate", label: plan.label, parameters: { offsetX: offset.x, offsetY: offset.y } }, () => plan.production);
    },
  },
  {
    name: "duplicar con desplazamiento explícito",
    type: "object.duplicate",
    targets: { objectIds: ["e1"] },
    parameters: { offsetX: 3, offsetY: 4 },
    ui: (api, createId) => {
      const plan = planDuplicate(selected(api, ["e1"]), api.getSnapshot(), { offset: { x: 3, y: 4 }, createId });
      apply(api, { type: "object.duplicate", label: plan.label, parameters: { offsetX: 3, offsetY: 4 } }, () => plan.production);
    },
  },
  {
    name: "Fill a una capa existente",
    type: "object.fill",
    targets: { objectIds: ["a1", "a2"] },
    parameters: { targetLayerId: "B" },
    ui: (api) => recolor(api, "selection", { target: { kind: "layer", groupId: "B" }, objectIds: new Set(["a1", "a2"]) }, true),
  },
  {
    name: "Fill con un color libre nuevo (crea la capa en el MISMO comando)",
    type: "object.fill",
    targets: { objectIds: ["a2"] },
    parameters: { newColorHex: "#123456" },
    ui: (api, createId) => recolor(api, "selection", { target: { kind: "new", hex: "#123456", groupId: createId() }, objectIds: new Set(["a2"]) }, true),
  },
  {
    name: "Recolor de la selección",
    type: "object.recolor",
    targets: { objectIds: ["b1"] },
    parameters: { scope: "selection", targetLayerId: "E" },
    ui: (api) => recolor(api, "selection", { target: { kind: "layer", groupId: "E" }, objectIds: new Set(["b1"]) }, false),
  },
  {
    name: "Recolor de una capa (cambia su color, mismo groupId)",
    type: "object.recolor",
    parameters: { scope: "layer", sourceLayerId: "A", newColorHex: "#abcdef" },
    ui: (api, createId) => recolor(api, "layer", { target: { kind: "new", hex: "#abcdef", groupId: createId() }, sourceGroupId: "A" }, false),
  },
  {
    name: "Recolor del documento (capa origen elegida)",
    type: "object.recolor",
    parameters: { scope: "document", sourceLayerId: "B", targetLayerId: "E" },
    ui: (api) => recolor(api, "document", { target: { kind: "layer", groupId: "E" }, sourceGroupId: "B" }, false),
  },
  {
    name: "Fusionar capas (la origen queda vacía)",
    type: "object.merge",
    parameters: { scope: "layer", sourceLayerId: "A", mergeIntoLayerId: "E", targetLayerId: "E" },
    ui: (api) => recolor(api, "layer", { target: { kind: "layer", groupId: "E" }, sourceGroupId: "A", mergeIntoGroupId: "E" }, false),
  },
  {
    name: "recortar el área de trabajo",
    type: "document.crop",
    parameters: { x: 0, y: 0, width: 55, height: 25, removeOutside: true },
    ui: (api) => {
      const checked = cropFrame(api.committedFrame, { x: 0, y: 0, width: 55, height: 25 });
      if (!checked.ok) throw new Error(checked.error);
      apply(api, { type: "document.crop", label: "Recortar", parameters: { x: 0, y: 0, width: 55, height: 25, removeOutside: true } }, (state) => cropProduction(state, checked.frame, true));
    },
  },
  {
    name: "recortar sin eliminar lo de afuera (removeOutside omitido = true; explícito false)",
    type: "document.crop",
    parameters: { x: 5, y: 5, width: 80, height: 40, removeOutside: false },
    ui: (api) => {
      const checked = cropFrame(api.committedFrame, { x: 5, y: 5, width: 80, height: 40 });
      if (!checked.ok) throw new Error(checked.error);
      apply(api, { type: "document.crop", label: "Recortar", parameters: { x: 5, y: 5, width: 80, height: 40, removeOutside: false } }, (state) => cropProduction(state, checked.frame, false));
    },
  },
  {
    name: "rotar el documento 90°",
    type: "document.rotate",
    parameters: { quarterTurns: 1 },
    ui: (api) => orient(api, "document", [], { type: "document.rotate", label: "Rotar 90° horario (documento completo)", parameters: { quarterTurns: 1 } }),
  },
  {
    name: "rotar el documento 270°",
    type: "document.rotate",
    parameters: { quarterTurns: 3 },
    ui: (api) => orient(api, "document", [], { type: "document.rotate", label: "Rotar", parameters: { quarterTurns: 3 } }, orientationFromCommand({ kind: "rotate", quarterTurns: 3 })),
  },
  {
    name: "reflejar el documento verticalmente",
    type: "document.flip",
    parameters: { axis: "vertical" },
    ui: (api) => orient(api, "document", [], { type: "document.flip", label: "Reflejar", parameters: { axis: "vertical", quarterTurns: 0 } }, orientationFromCommand({ kind: "flip", axis: "vertical", quarterTurns: 0 })),
  },
  {
    name: "rotar la selección",
    type: "selection.rotate",
    targets: { objectIds: ["a1", "a2"] },
    parameters: { quarterTurns: 1 },
    ui: (api) => orient(api, "selection", ["a1", "a2"], { type: "selection.rotate", label: "Rotar 90° horario (2 objetos)", parameters: { quarterTurns: 1 } }),
  },
  {
    name: "reflejar la selección (diagonal: reflejo + un cuarto de vuelta)",
    type: "selection.flip",
    targets: { objectIds: ["a1", "b1"] },
    parameters: { axis: "horizontal", quarterTurns: 1 },
    ui: (api) => orient(api, "selection", ["a1", "b1"], { type: "selection.flip", label: "Reflejar", parameters: { axis: "horizontal", quarterTurns: 1 } }, orientationFromCommand({ kind: "flip", axis: "horizontal", quarterTurns: 1 })),
  },
  {
    name: "alinear a la izquierda con la selección",
    type: "arrange.align",
    targets: { objectIds: ["a2", "e1"] },
    parameters: { mode: "left", reference: "selection" },
    ui: (api) => {
      const result = runArrange(api.getSnapshot(), selected(api, ["a2", "e1"]), "align-left", { reference: "selection" });
      apply(api, arrangeDraft("align-left", result.label, "selection"), () => result.production);
    },
  },
  {
    name: "centrar respecto del documento",
    type: "arrange.align",
    targets: { objectIds: ["b1"] },
    parameters: { mode: "center", reference: "document" },
    ui: (api) => {
      const result = runArrange(api.getSnapshot(), selected(api, ["b1"]), "align-center", { reference: "document" });
      apply(api, arrangeDraft("align-center", result.label, "document"), () => result.production);
    },
  },
  {
    name: "distribuir horizontalmente (huecos iguales)",
    type: "arrange.distribute",
    targets: { objectIds: ["a1", "a2", "e1"] },
    parameters: { axis: "horizontal" },
    ui: (api) => {
      const result = runArrange(api.getSnapshot(), selected(api, ["a1", "a2", "e1"]), "distribute-horizontal", { reference: "selection" });
      apply(api, arrangeDraft("distribute-horizontal", result.label, "selection"), () => result.production);
    },
  },
  {
    name: "traer adelante (z-order dentro de la capa)",
    type: "arrange.zorder",
    targets: { objectIds: ["a1"] },
    parameters: { action: "forward" },
    ui: (api) => {
      const result = runArrange(api.getSnapshot(), selected(api, ["a1"]), "z-forward", { reference: "selection" });
      apply(api, arrangeDraft("z-forward", result.label, "selection"), () => result.production);
    },
  },
  {
    name: "enviar al fondo",
    type: "arrange.zorder",
    targets: { objectIds: ["a2"] },
    parameters: { action: "back" },
    ui: (api) => {
      const result = runArrange(api.getSnapshot(), selected(api, ["a2"]), "z-back", { reference: "selection" });
      apply(api, arrangeDraft("z-back", result.label, "selection"), () => result.production);
    },
  },
];

describe("executeCommand — equivalencia con la ruta de UI (mismo estado EXACTO, mismo comando)", () => {
  beforeEach(() => {
    installFetch();
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(CASES.map((testCase) => [testCase.name, testCase] as const))("%s", async (_name, testCase) => {
    const uiWorld = await world();
    const exWorld = await world();
    expect(capture(exWorld)).toEqual(capture(uiWorld));

    act(() => testCase.ui(uiWorld.result.current, counter()));

    // El comando viaja SERIALIZADO: lo que ejecuta el ejecutor es el JSON, no el objeto original.
    const input = JSON.parse(JSON.stringify({ type: testCase.type, targets: testCase.targets, parameters: testCase.parameters }));
    let result = null as unknown as ExecutorResult;
    act(() => {
      result = executeCommand(exWorld.result.current, input, { createId: counter(), mmPerUnit: testCase.mmPerUnit });
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);

    // Mismo estado exacto: objetos, marco, estructura efectiva de capas y banderas derivadas.
    expect(capture(exWorld)).toEqual(capture(uiWorld));
    expect(exWorld.result.current.historyEntries).toHaveLength(1);
    expect(uiWorld.result.current.historyEntries).toHaveLength(1);

    // Mismo comando (salvo el origen y la hora): el ejecutor deja en el historial lo mismo que la UI.
    const fromUi = lastCommand(uiWorld);
    const fromExecutor = lastCommand(exWorld);
    expect(fromExecutor.type).toBe(testCase.type);
    expect(fromUi.type).toBe(testCase.type);
    expect(fromExecutor.targets).toEqual(fromUi.targets);
    expect(fromExecutor.parameters).toEqual(fromUi.parameters);
    expect(fromUi.origin).toBe("user");
    expect(fromExecutor.origin).toBe("ai");
    if (result.ok) expect(result.command).toEqual(fromExecutor);

    // Y es reversible como cualquiera: deshacer vuelve al estado inicial exacto.
    const pristine = capture(await world());
    act(() => void exWorld.result.current.undo());
    expect(capture(exWorld)).toEqual(pristine);
    act(() => void exWorld.result.current.redo());
    expect(capture(exWorld)).toEqual(capture(uiWorld));
  });

  it("los casos cubren TODOS los tipos ejecutables del registro (si se agrega uno, hay que agregar su equivalencia)", () => {
    const covered = new Set(CASES.map((testCase) => testCase.type));
    const missing = EXECUTABLE_TYPES.filter((type) => !covered.has(type) && type !== "layer.create");
    expect(missing).toEqual([]);
    expect([...EXECUTABLE_TYPES].sort()).toEqual(COMMAND_TYPES.filter((type) => COMMAND_REGISTRY[type].executable).sort());
  });
});

describe("executeCommand — layer.create", () => {
  beforeEach(() => {
    installFetch();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("crea una capa nueva (isNew) con nombre «Color #HEX», al final, sin objetos y con un comando propio; deshacer la quita", async () => {
    const hook = await world();
    const initial = capture(hook);
    let result = null as unknown as ExecutorResult;
    act(() => {
      result = executeCommand(hook.result.current, { type: "layer.create", parameters: { colorHex: "#AABBCC" } }, { createId: counter("layer-") });
    });
    expect(result.ok).toBe(true);
    const created = hook.result.current.committedLayers.find((candidate) => candidate.groupId === "layer-1")!;
    expect(created).toMatchObject({ isNew: true, name: "Color #AABBCC", colorHex: "#AABBCC", order: 3, visible: true, locked: false, pathCount: 0 });
    expect(lastCommand(hook)).toMatchObject({ type: "layer.create", origin: "ai", targets: { layerIds: ["layer-1"], objectIds: [] }, parameters: { colorHex: "#AABBCC", createdLayerIds: ["layer-1"] } });
    expect(hook.result.current.geometryDirty).toBe(true);

    act(() => void hook.result.current.undo());
    expect(capture(hook)).toEqual(initial);
    act(() => void hook.result.current.redo());
    expect(hook.result.current.committedLayers.some((candidate) => candidate.groupId === "layer-1")).toBe(true);
  });

  it("un nombre explícito se respeta; un hex inválido se rechaza sin tocar nada", async () => {
    const hook = await world();
    let named = null as unknown as ExecutorResult;
    act(() => {
      named = executeCommand(hook.result.current, { type: "layer.create", parameters: { colorHex: "#0f0", name: "  Mi capa  " } }, { createId: counter("layer-") });
    });
    expect(named.ok).toBe(true);
    expect(hook.result.current.committedLayers.at(-1)?.name).toBe("Mi capa");
    const before = capture(hook);
    let bad = null as unknown as ExecutorResult;
    act(() => {
      bad = executeCommand(hook.result.current, { type: "layer.create", parameters: { colorHex: "verde" } });
    });
    expect(bad).toMatchObject({ ok: false, errors: [{ code: "invalid_parameters" }] });
    expect(capture(hook)).toEqual(before);
    expect(hook.result.current.historyEntries).toHaveLength(1);
  });
});

describe("executeCommand — validaciones: errores estructurados y el documento NO se toca", () => {
  let hook: World;
  beforeEach(async () => {
    hook = await world(GUARDED_LAYERS);
  });
  afterEach(() => vi.unstubAllGlobals());

  const run = (input: unknown, context = {}): ExecutorResult => {
    let result = null as unknown as ExecutorResult;
    act(() => {
      result = executeCommand(hook.result.current, input, context);
    });
    return result;
  };
  const expectRejected = (input: unknown, code: string, pattern?: RegExp, context = {}) => {
    const before = capture(hook);
    const result = run(input, context);
    expect(result.ok, JSON.stringify(result)).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((error) => error.code)).toContain(code);
    if (pattern) expect(result.errors.map((error) => error.message).join(" | ")).toMatch(pattern);
    // Nada cambió: ni objetos, ni marco, ni capas, ni una entrada en el historial.
    expect(capture(hook)).toEqual(before);
    expect(hook.result.current.historyEntries).toHaveLength(0);
    // Y el resultado de error es JSON puro y sin geometría.
    expect(isJsonValue(JSON.parse(JSON.stringify(result)))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/M\d+ \d+|<svg|<path/);
  };

  it("entrada que no es un objeto, con claves ajenas o sin tipo", () => {
    expectRejected(null, "invalid_input");
    expectRejected("object.move", "invalid_input");
    expectRejected([], "invalid_input");
    expectRejected({ type: "object.move", dx: 1 }, "invalid_input", /Claves no admitidas.*dx/);
    expectRejected({ parameters: {} }, "unknown_type");
  });

  it("tipo desconocido", () => {
    expectRejected({ type: "object.teleport" }, "unknown_type", /object\.teleport/);
    expectRejected({ type: 5 }, "unknown_type");
  });

  it.each(COMMAND_TYPES.filter((type) => !COMMAND_REGISTRY[type].executable))("%s no es ejecutable y devuelve el MOTIVO del registro", (type) => {
    expectRejected({ type, targets: { objectIds: ["a1"] } }, "not_executable", new RegExp(COMMAND_REGISTRY[type].reason!.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("origin inválido", () => {
    expectRejected({ type: "object.move", origin: "robot", targets: { objectIds: ["a1"] }, parameters: { dx: 1, dy: 0 } }, "invalid_origin");
  });

  it("targets mal formados", () => {
    expectRejected({ type: "object.move", targets: [], parameters: { dx: 1, dy: 0 } }, "invalid_targets");
    expectRejected({ type: "object.move", targets: { objectIds: "a1" }, parameters: { dx: 1, dy: 0 } }, "invalid_targets");
    expectRejected({ type: "object.move", targets: { objectIds: [1] }, parameters: { dx: 1, dy: 0 } }, "invalid_targets");
    expectRejected({ type: "object.move", targets: { objectIds: ["a1"], extra: [] }, parameters: { dx: 1, dy: 0 } }, "invalid_targets", /sobra: extra/);
    expectRejected({ type: "object.move", targets: { objectIds: [""] }, parameters: { dx: 1, dy: 0 } }, "invalid_targets");
  });

  it("ids que no existen (objetos y capas) y falta de objetivos", () => {
    expectRejected({ type: "object.move", targets: { objectIds: ["a1", "fantasma"] }, parameters: { dx: 1, dy: 0 } }, "unknown_target", /fantasma/);
    expectRejected({ type: "arrange.align", targets: { objectIds: ["a1"], layerIds: ["Z"] }, parameters: { mode: "left", reference: "document" } }, "unknown_target", /Z/);
    expectRejected({ type: "object.move", parameters: { dx: 1, dy: 0 } }, "missing_target", /al menos un objeto/);
    expectRejected({ type: "object.recolor", parameters: { scope: "selection", newColorHex: "#fff" } }, "missing_target");
  });

  it("objetos en una capa BLOQUEADA o OCULTA rechazan el comando entero (todo o nada, a diferencia de la UI que omite y avisa)", () => {
    expectRejected({ type: "object.move", targets: { objectIds: ["a1", "l1"] }, parameters: { dx: 1, dy: 0 } }, "layer_locked", /bloqueadas \(L\)/);
    expectRejected({ type: "object.delete", targets: { objectIds: ["h1"] } }, "layer_hidden", /ocultas \(H\)/);
  });

  it("recolorear una capa bloqueada u ocultas lo explica el planificador (sin tocar nada)", () => {
    expectRejected({ type: "object.recolor", parameters: { scope: "layer", sourceLayerId: "L", newColorHex: "#123456" } }, "nothing_to_do", /bloqueada/);
    expectRejected({ type: "object.recolor", parameters: { scope: "layer", sourceLayerId: "H", newColorHex: "#123456" } }, "nothing_to_do", /oculta/);
    expectRejected({ type: "object.fill", targets: { objectIds: ["a1"] }, parameters: { targetLayerId: "L" } }, "nothing_to_do", /bloqueada/);
  });

  it("rotar o reflejar el DOCUMENTO con una capa bloqueada se rechaza entero (nunca a medias)", () => {
    expectRejected({ type: "document.rotate", parameters: { quarterTurns: 1 } }, "blocked", /bloqueadas/);
    expectRejected({ type: "document.flip", parameters: { axis: "horizontal" } }, "blocked");
  });

  it("parámetros fuera de rango, de otro tipo, faltantes o desconocidos", () => {
    expectRejected({ type: "object.rotate", targets: { objectIds: ["a1"] }, parameters: { degrees: 5000 } }, "invalid_parameters", /≤ 3600/);
    expectRejected({ type: "object.scale", targets: { objectIds: ["a1"] }, parameters: { sx: 0, sy: 1 } }, "invalid_parameters", /\(casi\) 0/);
    expectRejected({ type: "object.scale", targets: { objectIds: ["a1"] }, parameters: { sx: 2, sy: 1, pivotX: 4 } }, "invalid_parameters", /juntos/);
    expectRejected({ type: "object.move", targets: { objectIds: ["a1"] }, parameters: { dx: "5", dy: 0 } }, "invalid_parameters", /número/);
    expectRejected({ type: "object.move", targets: { objectIds: ["a1"] }, parameters: { dx: 1 } }, "invalid_parameters", /Falta.*dy/);
    expectRejected({ type: "object.move", targets: { objectIds: ["a1"] }, parameters: { dx: 1, dy: 0, color: "rojo" } }, "invalid_parameters", /no es un parámetro/);
    expectRejected({ type: "object.move", targets: { objectIds: ["a1"] }, parameters: { dx: 1, dy: 0, objectCount: 9 } }, "invalid_parameters", /lo calcula el historial/);
    expectRejected({ type: "document.crop", parameters: { x: 0, y: 0, width: -5, height: 10 } }, "invalid_parameters", /≥/);
    expectRejected({ type: "document.rotate", parameters: { quarterTurns: 4 } }, "invalid_parameters");
    expectRejected({ type: "arrange.align", targets: { objectIds: ["a1"] }, parameters: { mode: "arriba", reference: "selection" } }, "invalid_parameters", /uno de/);
    expectRejected({ type: "object.fill", targets: { objectIds: ["a1"] }, parameters: { targetLayerId: "B", newColorHex: "#fff" } }, "invalid_parameters", /exactamente uno/);
    expectRejected({ type: "object.move", targets: { objectIds: ["a1"] }, parameters: [] }, "invalid_parameters");
    expectRejected({ type: "object.move", targets: { objectIds: ["a1"] }, parameters: { dx: Number.NaN, dy: 0 } }, "invalid_parameters");
  });

  it("un marco de recorte inválido o sin intersección se rechaza con el motivo del planificador", () => {
    expectRejected({ type: "document.crop", parameters: { x: 0, y: 0, width: 1e-9, height: 10 } }, "invalid_parameters");
    expectRejected({ type: "object.setBounds", targets: { objectIds: ["a1"] }, parameters: { x: 0, y: 0, width: 1e-12, height: 5 } }, "invalid_parameters");
  });

  it("un comando que no cambia nada responde nothing_to_do (sin entrada en el historial)", () => {
    expectRejected({ type: "object.move", targets: { objectIds: ["a1"] }, parameters: { dx: 0, dy: 0 } }, "nothing_to_do");
    expectRejected({ type: "arrange.align", targets: { objectIds: ["a1"] }, parameters: { mode: "left", reference: "document" } }, "nothing_to_do");
    expectRejected({ type: "arrange.distribute", targets: { objectIds: ["a1", "a2"] }, parameters: { axis: "horizontal" } }, "nothing_to_do");
  });

  describe("NUNCA acepta d / SVG crudos (en ningún lugar de la entrada)", () => {
    const withTargets = { objectIds: ["a1"] };
    it.each([
      ["clave d en parameters", { type: "object.move", targets: withTargets, parameters: { dx: 1, dy: 0, d: "M0 0 L9 9" } }],
      ["clave svg", { type: "object.move", targets: withTargets, parameters: { dx: 1, dy: 0, svg: "<svg/>" } }],
      ["clave path anidada", { type: "object.fill", targets: withTargets, parameters: { newColorHex: "#fff", extra: { path: "M0 0" } } }],
      ["points", { type: "object.move", targets: withTargets, parameters: { dx: 1, dy: 0, points: [[0, 0], [1, 1]] } }],
      ["matrix", { type: "object.move", targets: withTargets, parameters: { dx: 1, dy: 0, matrix: { a: 1 } } }],
      ["marcado SVG dentro de un texto", { type: "layer.create", parameters: { colorHex: "#fff", name: "<svg><path d='M0 0 L5 5'/></svg>" } }],
      ["path data dentro de un texto", { type: "layer.create", parameters: { colorHex: "#fff", name: "M 10 20 L 30 40 Z" } }],
      ["d dentro de targets", { type: "object.move", targets: { objectIds: ["a1"], d: "M0 0" }, parameters: { dx: 1, dy: 0 } }],
      ["d en el nivel superior", { type: "object.move", d: "M0 0 L1 1", targets: withTargets, parameters: { dx: 1, dy: 0 } }],
    ])("%s", (_name, input) => {
      expectRejected(input, "raw_geometry", /crudos/);
    });
  });
});

describe("executeCommand — nunca DEVUELVE geometría cruda", () => {
  beforeEach(() => {
    installFetch();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("el resultado de un comando exitoso trae el EditorCommand (JSON puro) y ningún d, SVG ni matriz, aunque el documento los tenga", async () => {
    const hook = await world();
    const geometry = Object.values(hook.result.current.getSnapshot().objectsByLayer).flat();
    expect(geometry.every((object) => object.d.startsWith("M"))).toBe(true);
    let result = null as unknown as ExecutorResult;
    act(() => {
      result = executeCommand(hook.result.current, { type: "object.rotate", targets: { objectIds: ["a1", "a2"] }, parameters: { degrees: 45 } });
    });
    expect(result.ok).toBe(true);
    const text = JSON.stringify(result);
    for (const object of geometry) expect(text).not.toContain(object.d);
    expect(text).not.toMatch(/<svg|<path|"matrix"|"d":/);
    expect(isJsonValue(JSON.parse(text))).toBe(true);
    expect(Object.keys((result as { command: EditorCommand }).command).sort()).toEqual(["id", "label", "origin", "parameters", "sequence", "targets", "timestamp", "type", "version"]);
  });
});

describe("executeCommand — origen y estado", () => {
  beforeEach(() => {
    installFetch();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("origin por defecto 'ai'; 'user' y 'system' se respetan", async () => {
    const hook = await world();
    for (const origin of [undefined, "user", "system"] as const) {
      act(() => void executeCommand(hook.result.current, { type: "object.move", origin, targets: { objectIds: ["a1"] }, parameters: { dx: 1, dy: 0 } }));
    }
    expect(hook.result.current.historyEntries.map((entry) => entry.command.origin)).toEqual(["ai", "user", "system"]);
  });

  it("con un gesto en curso responde 'busy' y no toca nada", async () => {
    const hook = await world();
    act(() => void hook.result.current.beginGesture());
    let result = null as unknown as ExecutorResult;
    act(() => {
      result = executeCommand(hook.result.current, { type: "object.move", targets: { objectIds: ["a1"] }, parameters: { dx: 1, dy: 0 } });
    });
    expect(result).toMatchObject({ ok: false, errors: [{ code: "busy" }] });
    expect(hook.result.current.historyEntries).toHaveLength(0);
  });

  it("dos comandos seguidos son dos entradas con secuencias consecutivas; el historial los exporta sin parches", async () => {
    const hook = await world();
    act(() => {
      executeCommand(hook.result.current, { type: "object.move", targets: { objectIds: ["a1"] }, parameters: { dx: 1, dy: 0 } });
    });
    act(() => {
      executeCommand(hook.result.current, { type: "object.rotate", targets: { objectIds: ["a1"] }, parameters: { degrees: 10 } });
    });
    expect(hook.result.current.historyEntries.map((entry) => entry.command.sequence)).toEqual([1, 2]);
    const exported = JSON.stringify(hook.result.current.exportHistory());
    expect(exported).not.toMatch(/touched|<svg|"d":/);
  });
});

describe("commandCatalog — lo que ve quien emite comandos", () => {
  it("una entrada JSON-pura por tipo, con parámetros tipados y el motivo de lo no ejecutable", () => {
    const catalog = commandCatalog();
    expect(catalog.map((entry) => entry.type).sort()).toEqual([...COMMAND_TYPES].sort());
    expect(isJsonValue(JSON.parse(JSON.stringify(catalog)))).toBe(true);
    const move = catalog.find((entry) => entry.type === "object.move")!;
    expect(move).toMatchObject({ executable: true, needsObjects: true, parameters: { dx: { kind: "number", required: true }, dy: { kind: "number", required: true } } });
    const align = catalog.find((entry) => entry.type === "arrange.align")!;
    expect(align.parameters.mode.options).toContain("left");
    const boolean = catalog.find((entry) => entry.type === "geometry.boolean")!;
    expect(boolean.executable).toBe(false);
    expect(boolean.reason).toMatch(/servidor/);
    // Ni el catálogo menciona geometría cruda como parámetro.
    expect(JSON.stringify(catalog)).not.toMatch(/"d":/);
  });
});
