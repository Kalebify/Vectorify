import { StrictMode, useEffect } from "react";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildFillProduction, buildRecolorProduction, planRecolor, type ColorTarget } from "../lib/editor/colors";
import type { EditableDocument, EditorObject, EditProduction } from "../lib/editor/types";
import { abortAwareFetch, svgResponse } from "../test/abortableFetch";
import { useEditableDocument, type UseEditableDocumentOptions } from "./useEditableDocument";
import type { VectorDocumentLayer } from "./useVectorDocument";

/**
 * M3-S03: la estructura de capas es parte del estado editable y undoable. Un comando cambia objetos + estructura a la vez (Fill con un
 * color nuevo = crear capa + mover objetos); `isNew` marca las capas creadas en el cliente, cuya metadata se edita en local (sin PATCH).
 */

function layer(overrides: Partial<VectorDocumentLayer> = {}): VectorDocumentLayer {
  return {
    groupId: "A",
    name: "Rojo",
    colorHex: "#ff0000",
    fill: "#ff0000",
    vectorId: "vector-a",
    svgUrl: "/svg/A",
    pathCount: 2,
    componentCount: 1,
    manufacturingOperation: "cut",
    order: 0,
    visible: true,
    locked: false,
    areaPercent: 60,
    hasPartialAlpha: false,
    isExcluded: false,
    ...overrides,
  };
}

const SVG_A = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><path data-vid="a1" d="M0 0 H10 V10 H0 Z" fill="#ff0000"/><path data-vid="a2" d="M20 0 H30 V10 H20 Z" fill="#ff0000"/></svg>`;
const SVG_B = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><path data-vid="b1" d="M0 20 H10 V30 H0 Z" fill="#0000ff"/></svg>`;
// Capa C: MISMO hex que A (#ff0000, otra caja) pero otra capa.
const SVG_C = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><path data-vid="c1" d="M0 40 H10 V50 H0 Z" fill="#FF0000"/></svg>`;

function installFetch(overrides: Record<string, () => Response | Promise<Response>> = {}) {
  const fetchMock = abortAwareFetch((url) => {
    if (overrides[url]) return overrides[url]();
    if (url === "/svg/A") return svgResponse(SVG_A);
    if (url === "/svg/B") return svgResponse(SVG_B);
    if (url === "/svg/C") return svgResponse(SVG_C);
    return svgResponse("no existe", 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const LAYER_A = layer();
const LAYER_B = layer({ groupId: "B", name: "Azul", vectorId: "vector-b", svgUrl: "/svg/B", colorHex: "#0000ff", fill: "#0000ff", order: 1, pathCount: 1 });
const LAYER_C = layer({ groupId: "C", name: "Rojo 2", vectorId: "vector-c", svgUrl: "/svg/C", colorHex: "#FF0000", fill: "#FF0000", order: 2, pathCount: 1 });
const LAYERS = [LAYER_A, LAYER_B, LAYER_C];

async function renderLoaded(layers = LAYERS, options: UseEditableDocumentOptions = {}) {
  const hook = renderHook(({ layers: current, options: opts }) => useEditableDocument(current, opts), { initialProps: { layers, options } });
  await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
  await waitFor(() => expect(Object.values(hook.result.current.layerStatus).every((status) => status === "ready")).toBe(true));
  return hook;
}

const ids = (...values: string[]) => new Set(values);
const newTarget = (hex: string, groupId = "NEW"): ColorTarget => ({ kind: "new", hex, groupId });
const fillProducer = (selection: string[], target: ColorTarget) => (state: EditableDocument) => buildFillProduction(state, ids(...selection), target);

describe("useEditableDocument — estructura de capas (M3-S03)", () => {
  beforeEach(() => {
    installFetch();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("la lista efectiva de capas es la del servidor, sin overrides ni capas nuevas mientras nada se edita (y el pathCount del servidor se respeta)", async () => {
    const { result } = await renderLoaded();
    expect(result.current.layers).toEqual(LAYERS);
    expect(result.current.layers[0]).toBe(LAYER_A);
    expect(result.current.committedLayers).toBe(result.current.layers);
    expect(result.current.visibility).toEqual({ A: true, B: true, C: true });
    expect(result.current.geometryDirty).toBe(false);
  });

  it("Fill con color NUEVO = UN comando atómico: crea la capa (isNew) y mueve los objetos; undo ELIMINA la capa y devuelve los objetos EXACTOS; redo los reaplica", async () => {
    const { result } = await renderLoaded();
    const originalA = result.current.objectsByLayer.A;
    const originalB = result.current.objectsByLayer.B;

    let outcome!: ReturnType<typeof result.current.applyEdit>;
    act(() => {
      outcome = result.current.applyEdit("Rellenar 2 objetos", fillProducer(["a1", "b1"], newTarget("#00ff00", "NEW")));
    });
    expect(outcome).toMatchObject({ applied: true, skippedLockedObjects: 0, skippedHiddenObjects: 0 });
    expect(result.current.undoDepth).toBe(1); // UN solo comando para capa + objetos

    const created = result.current.layers.find((candidate) => candidate.groupId === "NEW")!;
    expect(created).toMatchObject({ name: "Color #00FF00", colorHex: "#00FF00", fill: "#00FF00", isNew: true, visible: true, locked: false, order: 3, manufacturingOperation: "unassigned", pathCount: 2, svgUrl: "", vectorId: "" });
    expect(result.current.layers.map((candidate) => candidate.groupId)).toEqual(["A", "B", "C", "NEW"]);
    expect(result.current.objectsByLayer.NEW.map((object) => [object.id, object.layerGroupId, object.fill])).toEqual([
      ["a1", "NEW", "#00FF00"],
      ["b1", "NEW", "#00FF00"],
    ]);
    expect(result.current.objectsByLayer.A.map((object) => object.id)).toEqual(["a2"]);
    expect(result.current.objectsByLayer.B).toEqual([]);
    // La capa creada no se carga de ningún lado: ya está lista.
    expect(result.current.layerStatus.NEW).toBe("ready");
    expect(result.current.geometryDirty).toBe(true);
    // Las capas tocadas pasan a reportar sus objetos reales; las que no, conservan el conteo del servidor.
    expect(result.current.layers.find((candidate) => candidate.groupId === "A")!.pathCount).toBe(1);
    expect(result.current.layers.find((candidate) => candidate.groupId === "C")!.pathCount).toBe(1);

    let undone: ReturnType<typeof result.current.undo> = null;
    act(() => {
      undone = result.current.undo();
    });
    // El comando de la historia describe estructura + objetos: la capa creada está en "después" y NO en "antes".
    expect(undone!.layers!.before).toEqual([]);
    expect(undone!.layers!.after.map((entry) => entry.groupId)).toEqual(["NEW"]);
    // Estructura y objetos restaurados EXACTOS (mismas referencias que antes del comando).
    expect(result.current.layers.find((candidate) => candidate.groupId === "NEW")).toBeUndefined();
    expect(result.current.layers.map((candidate) => candidate.groupId)).toEqual(["A", "B", "C"]);
    expect(result.current.objectsByLayer.NEW).toBeUndefined();
    expect("NEW" in result.current.objectsByLayer).toBe(false);
    expect(result.current.objectsByLayer.A).toBe(originalA);
    expect(result.current.objectsByLayer.B).toBe(originalB);
    expect(result.current.geometryDirty).toBe(false);
    expect(result.current.undoDepth).toBe(0);
    expect(result.current.canRedo).toBe(true);

    act(() => void result.current.redo());
    expect(result.current.layers.find((candidate) => candidate.groupId === "NEW")).toMatchObject({ isNew: true, colorHex: "#00FF00", pathCount: 2 });
    expect(result.current.objectsByLayer.NEW.map((object) => object.id)).toEqual(["a1", "b1"]);
    expect(result.current.objectsByLayer.A.map((object) => object.id)).toEqual(["a2"]);
    expect(result.current.geometryDirty).toBe(true);
    expect(result.current.undoDepth).toBe(1);
  });

  it("la capa nueva no vuelve a pedir ningún SVG (nada que cargar) ni dispara requests al crearse", async () => {
    const fetchMock = installFetch();
    const { result } = await renderLoaded();
    const callsBefore = fetchMock.mock.calls.length;
    act(() => void result.current.applyEdit("Rellenar", fillProducer(["a1"], newTarget("#00ff00"))));
    act(() => void result.current.undo());
    act(() => void result.current.redo());
    await act(async () => {});
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });

  it("Recolor de capa conserva el groupId (identidad): cambia su color y el fill de sus objetos; undo hasta el origen deja la estructura LIMPIA", async () => {
    const { result } = await renderLoaded();
    act(() => {
      result.current.applyEdit("Recolorear", (state) => buildRecolorProduction("layer", state, { target: newTarget("#00ff00"), sourceGroupId: "A" }));
    });
    const recolored = result.current.layers.find((candidate) => candidate.groupId === "A")!;
    expect(recolored).toMatchObject({ groupId: "A", colorHex: "#00FF00", fill: "#00FF00", name: "Rojo", order: 0, manufacturingOperation: "cut" });
    expect(recolored.isNew).toBeFalsy(); // sigue siendo una capa del servidor
    expect(result.current.layers).toHaveLength(3);
    expect(result.current.objectsByLayer.A.every((object) => object.fill === "#00FF00" && object.layerGroupId === "A")).toBe(true);
    expect(result.current.geometryDirty).toBe(true);
    // La capa C (mismo hex que tenía A) NO cambia.
    expect(result.current.layers.find((candidate) => candidate.groupId === "C")!.colorHex).toBe("#FF0000");
    expect(result.current.objectsByLayer.C[0].fill).toBe("#FF0000");

    act(() => void result.current.undo());
    expect(result.current.layers.find((candidate) => candidate.groupId === "A")).toBe(LAYER_A);
    expect(result.current.objectsByLayer.A.every((object) => object.fill === "#ff0000")).toBe(true);
    expect(result.current.geometryDirty).toBe(false);

    act(() => void result.current.redo());
    expect(result.current.layers.find((candidate) => candidate.groupId === "A")!.colorHex).toBe("#00FF00");
  });

  it("COLOR COMPARTIDO: pintar B con el hex de A deja DOS capas distintas con el mismo hex (ninguna se fusiona ni desaparece)", async () => {
    const { result } = await renderLoaded();
    act(() => {
      result.current.applyEdit("Recolorear", (state) => buildRecolorProduction("layer", state, { target: { kind: "layer", groupId: "A" }, sourceGroupId: "B" }));
    });
    const hexes = Object.fromEntries(result.current.layers.map((candidate) => [candidate.groupId, candidate.colorHex.toLowerCase()]));
    expect(hexes).toEqual({ A: "#ff0000", B: "#ff0000", C: "#ff0000" });
    expect(result.current.layers.map((candidate) => candidate.groupId)).toEqual(["A", "B", "C"]);
    expect(result.current.objectsByLayer.A.map((object) => object.id)).toEqual(["a1", "a2"]);
    expect(result.current.objectsByLayer.B.map((object) => [object.id, object.layerGroupId])).toEqual([["b1", "B"]]);
    expect(result.current.objectsByLayer.C.map((object) => object.id)).toEqual(["c1"]);
  });

  it("Fusión explícita: la capa origen queda VACÍA pero NO se elimina; undo la deja como estaba", async () => {
    const { result } = await renderLoaded();
    const originalA = result.current.objectsByLayer.A;
    const originalC = result.current.objectsByLayer.C;
    act(() => {
      result.current.applyEdit("Fusionar", (state) => buildRecolorProduction("layer", state, { target: { kind: "layer", groupId: "C" }, sourceGroupId: "A", mergeIntoGroupId: "C" }));
    });
    expect(result.current.layers.map((candidate) => candidate.groupId)).toEqual(["A", "B", "C"]); // la capa origen sigue existiendo
    expect(result.current.objectsByLayer.A).toEqual([]);
    expect(result.current.objectsByLayer.C.map((object) => object.id)).toEqual(["c1", "a1", "a2"]);
    expect(result.current.layers.find((candidate) => candidate.groupId === "A")!.pathCount).toBe(0);
    expect(result.current.layers.find((candidate) => candidate.groupId === "C")!.pathCount).toBe(3);

    act(() => void result.current.undo());
    expect(result.current.objectsByLayer.A).toBe(originalA);
    expect(result.current.objectsByLayer.C).toBe(originalC);
    expect(result.current.geometryDirty).toBe(false);
  });

  it("Cancel sin rastro: una previsualización (gesto) muestra la capa nueva y los objetos movidos, no llena la pila de undo y al cancelar no queda NADA", async () => {
    const { result } = await renderLoaded();
    const originalObjects = result.current.objectsByLayer;
    const originalLayers = result.current.layers;

    act(() => void result.current.beginGesture());
    act(() => void result.current.previewEdit(fillProducer(["a1"], newTarget("#00ff00", "NEW"))));
    expect(result.current.layers.find((candidate) => candidate.groupId === "NEW")).toMatchObject({ isNew: true, pathCount: 1 });
    expect(result.current.objectsByLayer.NEW.map((object) => object.id)).toEqual(["a1"]);
    expect(result.current.visibility.NEW).toBe(true);
    // Lo CONFIRMADO no se entera de la previsualización.
    expect(result.current.committedLayers).toBe(originalLayers);
    expect(result.current.committedObjectsByLayer).toBe(originalObjects);
    expect(result.current.undoDepth).toBe(0);
    expect(result.current.geometryDirty).toBe(false);

    act(() => result.current.cancelGesture());
    expect(result.current.layers.some((candidate) => candidate.groupId === "NEW")).toBe(false);
    expect(result.current.objectsByLayer).toBe(originalObjects);
    expect(result.current.layers).toBe(originalLayers);
    expect(result.current.undoDepth).toBe(0);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
    expect(result.current.geometryDirty).toBe(false);
  });

  it("cambiar de parámetros durante la previsualización recompone SIEMPRE desde el estado confirmado (no deja capas huérfanas de la previsualización anterior)", async () => {
    const { result } = await renderLoaded();
    act(() => void result.current.beginGesture());
    act(() => void result.current.previewEdit(fillProducer(["a1"], newTarget("#00ff00", "NEW-1"))));
    expect(result.current.layers.map((candidate) => candidate.groupId)).toContain("NEW-1");
    act(() => void result.current.previewEdit(fillProducer(["a1"], newTarget("#0000aa", "NEW-2"))));
    expect(result.current.layers.map((candidate) => candidate.groupId)).toEqual(["A", "B", "C", "NEW-2"]);
    expect(Object.keys(result.current.objectsByLayer).sort()).toEqual(["A", "B", "C", "NEW-2"]);
    // Una previsualización sin plan (p. ej. destino bloqueado) vuelve todo al estado confirmado.
    act(() => void result.current.previewEdit(() => null));
    expect(result.current.layers.map((candidate) => candidate.groupId)).toEqual(["A", "B", "C"]);
  });

  it("commitGesture de una previsualización de Fill con color nuevo = UN comando con capa + objetos (undo lo revierte completo)", async () => {
    const { result } = await renderLoaded();
    act(() => void result.current.beginGesture());
    act(() => void result.current.previewEdit(fillProducer(["a1"], newTarget("#00ff00", "NEW"))));
    let outcome!: ReturnType<typeof result.current.commitGesture>;
    act(() => {
      outcome = result.current.commitGesture("Rellenar 1 objeto");
    });
    expect(outcome.applied).toBe(true);
    expect(result.current.undoDepth).toBe(1);
    expect(result.current.layers.some((candidate) => candidate.groupId === "NEW")).toBe(true);
    expect(result.current.committedLayers.some((candidate) => candidate.groupId === "NEW")).toBe(true);

    act(() => void result.current.undo());
    expect(result.current.layers.some((candidate) => candidate.groupId === "NEW")).toBe(false);
    expect(result.current.objectsByLayer.A.map((object) => object.id)).toEqual(["a1", "a2"]);
  });

  it("los productores reciben la estructura efectiva (state.layers) con la visibilidad EFECTIVA", async () => {
    const { result } = await renderLoaded([LAYER_A, { ...LAYER_B, locked: true }, LAYER_C], { visibility: { A: true, B: true, C: false } });
    let seen: EditableDocument["layers"];
    act(() => {
      result.current.applyEdit("espía", (state) => {
        seen = state.layers;
        return null;
      });
    });
    expect(seen!.map((meta) => [meta.groupId, meta.visible, meta.locked, meta.isNew])).toEqual([
      ["A", true, false, false],
      ["B", true, true, false],
      ["C", false, false, false],
    ]);
    expect(result.current.getSnapshot().layers).toEqual(seen);
  });
});

describe("useEditableDocument — estructura de capas: bloqueo y visibilidad (todo o nada)", () => {
  beforeEach(() => {
    installFetch();
  });
  afterEach(() => vi.unstubAllGlobals());

  /** Mueve a1 de A a B a mano (sin las comprobaciones del constructor de Fill): pone a prueba el filtro del hook. */
  const moveA1ToB = (atomic: boolean) => (state: EditableDocument): EditProduction => ({
    layers: {
      A: state.objectsByLayer.A.filter((object) => object.id !== "a1"),
      B: [...state.objectsByLayer.B, { ...state.objectsByLayer.A[0], layerGroupId: "B", fill: "#0000ff" }],
    },
    atomic,
  });

  it("movimiento entre capas con la capa DESTINO bloqueada: se rechaza ENTERO (no se pierde el objeto de la capa origen)", async () => {
    const { result } = await renderLoaded([LAYER_A, { ...LAYER_B, locked: true }, LAYER_C]);
    const originalA = result.current.objectsByLayer.A;
    let outcome!: ReturnType<typeof result.current.applyEdit>;
    act(() => {
      outcome = result.current.applyEdit("mover", moveA1ToB(true));
    });
    expect(outcome).toMatchObject({ applied: false, reason: "blocked", skippedLockedObjects: 1 });
    expect(result.current.objectsByLayer.A).toBe(originalA);
    expect(result.current.undoDepth).toBe(0);
    expect(result.current.geometryDirty).toBe(false);
  });

  it("movimiento entre capas con la capa ORIGEN bloqueada: también se rechaza entero", async () => {
    const { result } = await renderLoaded([{ ...LAYER_A, locked: true }, LAYER_B, LAYER_C]);
    let outcome!: ReturnType<typeof result.current.applyEdit>;
    act(() => {
      outcome = result.current.applyEdit("mover", moveA1ToB(true));
    });
    expect(outcome).toMatchObject({ applied: false, reason: "blocked" });
    expect(result.current.objectsByLayer.B.map((object) => object.id)).toEqual(["b1"]);
  });

  it("movimiento entre capas con la capa destino OCULTA: se rechaza entero", async () => {
    const { result } = await renderLoaded(LAYERS, { visibility: { A: true, B: false, C: true } });
    let outcome!: ReturnType<typeof result.current.applyEdit>;
    act(() => {
      outcome = result.current.applyEdit("mover", moveA1ToB(true));
    });
    expect(outcome).toMatchObject({ applied: false, reason: "blocked", skippedHiddenObjects: 1 });
    expect(result.current.objectsByLayer.A).toHaveLength(2);
  });

  it("recolorear una capa BLOQUEADA no cambia su color (ni sus objetos) y lo informa", async () => {
    const lockedA = { ...LAYER_A, locked: true };
    const { result } = await renderLoaded([lockedA, LAYER_B, LAYER_C]);
    // Producción armada a mano para saltarse la comprobación del constructor: el filtro del hook es la defensa en profundidad.
    let outcome!: ReturnType<typeof result.current.applyEdit>;
    act(() => {
      outcome = result.current.applyEdit("recolor", (state) => {
        const plan = planRecolor("layer", { ...state, layers: state.layers!.map((meta) => ({ ...meta, locked: false })) }, { target: newTarget("#00ff00"), sourceGroupId: "A" });
        return plan.production;
      });
    });
    expect(outcome).toMatchObject({ applied: false, reason: "blocked" });
    expect(result.current.layers.find((candidate) => candidate.groupId === "A")).toBe(lockedA);
    expect(result.current.objectsByLayer.A.every((object) => object.fill === "#ff0000")).toBe(true);
    expect(result.current.geometryDirty).toBe(false);
  });

  it("un cambio de estructura que no cambia nada (la misma meta) es 'no_change', no un comando vacío", async () => {
    const { result } = await renderLoaded();
    let outcome!: ReturnType<typeof result.current.applyEdit>;
    act(() => {
      outcome = result.current.applyEdit("igual", (state) => ({ layers: {}, layerMetas: [state.layers![0]] }));
    });
    expect(outcome).toMatchObject({ applied: false, reason: "no_change" });
    expect(result.current.undoDepth).toBe(0);
  });

  it("un comando que solo cambia la estructura (capa vacía recoloreada) SÍ es un comando", async () => {
    const { result } = await renderLoaded();
    act(() => void result.current.applyEdit("vaciar", () => ({ layers: { B: [] } })));
    act(() => {
      result.current.applyEdit("recolor", (state) => buildRecolorProduction("layer", state, { target: newTarget("#123456"), sourceGroupId: "B" }));
    });
    expect(result.current.layers.find((candidate) => candidate.groupId === "B")!.colorHex).toBe("#123456");
    expect(result.current.undoDepth).toBe(2);
  });

  it("un cambio SOLO de estructura (capa sin objetos recoloreada) activa geometryDirty y su undo lo apaga: la estructura también cuenta como 'sin guardar'", async () => {
    const empty = layer({ groupId: "E", name: "Vacía", svgUrl: "", colorHex: "#123456", fill: "#123456", pathCount: 0, order: 3 });
    const { result } = await renderLoaded([LAYER_A, empty]);
    expect(result.current.geometryDirty).toBe(false);
    act(() => {
      result.current.applyEdit("Recolorear", (state) => buildRecolorProduction("layer", state, { target: newTarget("#abcdef"), sourceGroupId: "E" }));
    });
    expect(result.current.editedLayerIds.size).toBe(0); // ninguna geometría cambió...
    expect(result.current.geometryDirty).toBe(true); // ...pero la estructura sí
    expect(result.current.layers.find((candidate) => candidate.groupId === "E")!.colorHex).toBe("#ABCDEF");
    act(() => void result.current.undo());
    expect(result.current.geometryDirty).toBe(false);
    expect(result.current.layers.find((candidate) => candidate.groupId === "E")!.colorHex).toBe("#123456");
  });

  it("los comandos con cambio de estructura no se funden con otros aunque compartan coalesceKey", async () => {
    const { result } = await renderLoaded();
    const producer = (hex: string, groupId: string) => (state: EditableDocument) => buildFillProduction(state, ids("a1"), newTarget(hex, groupId));
    act(() => void result.current.applyEdit("uno", producer("#00ff00", "N1"), { coalesceKey: "k" }));
    act(() => void result.current.applyEdit("dos", producer("#0000aa", "N2"), { coalesceKey: "k" }));
    expect(result.current.undoDepth).toBe(2);
  });
});

describe("useEditableDocument — metadata local de capas nuevas (sin PATCH)", () => {
  beforeEach(() => {
    installFetch();
  });
  afterEach(() => vi.unstubAllGlobals());

  async function withNewLayer() {
    const hook = await renderLoaded();
    act(() => void hook.result.current.applyEdit("Rellenar", fillProducer(["a1"], newTarget("#00ff00", "NEW"))));
    return hook;
  }

  it("updateLocalLayer edita nombre, visibilidad, bloqueo, orden y operación de una capa NUEVA y devuelve true", async () => {
    const { result } = await withNewLayer();
    let ok = false;
    act(() => {
      ok = result.current.updateLocalLayer("NEW", { name: "Verde", visible: false, locked: true, manufacturingOperation: "engrave" });
    });
    expect(ok).toBe(true);
    expect(result.current.layers.find((candidate) => candidate.groupId === "NEW")).toMatchObject({ name: "Verde", visible: false, locked: true, manufacturingOperation: "engrave", isNew: true });
    expect(result.current.visibility.NEW).toBe(false);
  });

  it("sobre una capa del SERVIDOR (o inexistente) devuelve false y no cambia nada: esas van por PATCH", async () => {
    const { result } = await withNewLayer();
    const before = result.current.layers;
    let ok = true;
    act(() => {
      ok = result.current.updateLocalLayer("A", { name: "Intruso", locked: true });
    });
    expect(ok).toBe(false);
    act(() => {
      ok = result.current.updateLocalLayer("NO-EXISTE", { name: "x" });
    });
    expect(ok).toBe(false);
    expect(result.current.layers).toBe(before);
  });

  it("el orden local reubica la capa en la lista efectiva (entre capas del servidor, con un order fraccionario)", async () => {
    const { result } = await withNewLayer();
    expect(result.current.layers.map((candidate) => candidate.groupId)).toEqual(["A", "B", "C", "NEW"]);
    act(() => void result.current.updateLocalLayer("NEW", { order: 0.5 }));
    expect(result.current.layers.map((candidate) => candidate.groupId)).toEqual(["A", "NEW", "B", "C"]);
  });

  it("la metadata local NO entra al historial: un renombre sobrevive a undo + redo de la creación", async () => {
    const { result } = await withNewLayer();
    act(() => void result.current.updateLocalLayer("NEW", { name: "Verde mío" }));
    expect(result.current.undoDepth).toBe(1);
    act(() => void result.current.undo());
    expect(result.current.layers.some((candidate) => candidate.groupId === "NEW")).toBe(false);
    act(() => void result.current.redo());
    expect(result.current.layers.find((candidate) => candidate.groupId === "NEW")!.name).toBe("Verde mío");
  });

  it("una capa nueva BLOQUEADA localmente rechaza ediciones de objetos (mismo filtro que las del servidor)", async () => {
    const { result } = await withNewLayer();
    act(() => void result.current.updateLocalLayer("NEW", { locked: true }));
    let outcome!: ReturnType<typeof result.current.applyEdit>;
    act(() => {
      outcome = result.current.applyEdit("quitar", () => ({ layers: { NEW: [] } }));
    });
    expect(outcome).toMatchObject({ applied: false, reason: "blocked", skippedLockedObjects: 1 });
    expect(result.current.objectsByLayer.NEW).toHaveLength(1);
  });

  it("Isolate (isolatedGroupId) manda también sobre las capas nuevas: solo la aislada es visible", async () => {
    const { result, rerender } = await withNewLayer();
    rerender({ layers: LAYERS, options: { isolatedGroupId: "A", visibility: { A: true, B: false, C: false } } });
    expect(result.current.visibility).toEqual({ A: true, B: false, C: false, NEW: false });
    rerender({ layers: LAYERS, options: { isolatedGroupId: "NEW", visibility: { A: false, B: false, C: false } } });
    expect(result.current.visibility).toEqual({ A: false, B: false, C: false, NEW: true });
  });

  it("si una capa ya cargada cambia de svgUrl (documento regenerado) se descarta TODA edición sin guardar: capas creadas, colores recoloreados y objetos movidos vuelven a lo cargado, junto con el historial", async () => {
    installFetch({ "/svg/A2": () => svgResponse(SVG_B) });
    const { result, rerender } = await renderLoaded();
    act(() => void result.current.applyEdit("Rellenar", fillProducer(["a1"], newTarget("#00ff00", "NEW"))));
    act(() => {
      result.current.applyEdit("Recolorear", (state) => buildRecolorProduction("layer", state, { target: newTarget("#123456"), sourceGroupId: "C" }));
    });
    expect(result.current.geometryDirty).toBe(true);

    rerender({ layers: [layer({ svgUrl: "/svg/A2" }), LAYER_B, LAYER_C], options: {} });
    await waitFor(() => expect(result.current.objectsByLayer.A.map((object) => object.id)).toEqual(["b1"]));
    expect(result.current.layers.map((candidate) => candidate.groupId)).toEqual(["A", "B", "C"]);
    expect(result.current.layers.find((candidate) => candidate.groupId === "C")!.colorHex).toBe("#FF0000");
    expect(result.current.objectsByLayer.C[0].fill).toBe("#FF0000"); // el recolor de C (otra capa) también se descartó: nada queda a medias
    expect("NEW" in result.current.objectsByLayer).toBe(false);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.geometryDirty).toBe(false);
  });

  it("React StrictMode (efectos dobles + cargas abortadas): crear una capa, deshacer y rehacer funcionan igual", async () => {
    const fetchMock = installFetch();
    let latest: ReturnType<typeof useEditableDocument> | null = null;
    function Probe() {
      const api = useEditableDocument(LAYERS);
      useEffect(() => {
        latest = api;
      });
      return null;
    }
    render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    );
    await waitFor(() => expect(latest?.layerStatus.C).toBe("ready"));
    await waitFor(() => expect(latest?.layerStatus.A).toBe("ready"));
    await waitFor(() => expect(latest?.layerStatus.B).toBe("ready"));
    expect(fetchMock.signals.some((signal) => signal?.aborted)).toBe(true);

    act(() => void latest!.applyEdit("Rellenar", fillProducer(["a1"], newTarget("#00ff00", "NEW"))));
    await waitFor(() => expect(latest!.layers.some((candidate) => candidate.groupId === "NEW")).toBe(true));
    act(() => void latest!.undo());
    await waitFor(() => expect(latest!.layers.some((candidate) => candidate.groupId === "NEW")).toBe(false));
    expect(latest!.objectsByLayer.A).toHaveLength(2);
    act(() => void latest!.redo());
    await waitFor(() => expect(latest!.layers.some((candidate) => candidate.groupId === "NEW")).toBe(true));
  });
});

// Evita un falso verde si el helper de objetos cambia de forma.
describe("useEditableDocument — sanidad de los fixtures", () => {
  it("los objetos parseados tienen la forma que asumen los tests de estructura", async () => {
    installFetch();
    const { result } = await renderLoaded();
    const first: EditorObject = result.current.objectsByLayer.A[0];
    expect(first).toMatchObject({ id: "a1", layerGroupId: "A", fill: "#ff0000" });
    vi.unstubAllGlobals();
  });
});
