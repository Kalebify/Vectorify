import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildFillProduction, type ColorTarget } from "../lib/editor/colors";
import { cropProduction } from "../lib/editor/frame";
import { replaceObjects } from "../lib/editor/selection";
import { translate } from "../lib/editor/transform";
import type { DocumentFrame, EditableDocument, EditorObject } from "../lib/editor/types";
import { abortAwareFetch, svgResponse } from "../test/abortableFetch";
import { cmd } from "../test/commands";
import { useEditableDocument } from "./useEditableDocument";
import type { VectorDocumentLayer } from "./useVectorDocument";

/**
 * M3-S13: `markSaved` declara persistido lo que describe la marca (`saveMark`) SIN tocar el historial. `geometryDirty` pasa a significar
 * "difiere de lo último que el servidor confirmó": deshacer más allá del punto guardado vuelve a ensuciar, rehacer hasta él lo limpia, y lo
 * editado entre el envío y la confirmación sigue contando como sin guardar.
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

const LAYERS = [layer(), layer({ groupId: "B", name: "Azul", vectorId: "vector-b", svgUrl: "/svg/B", colorHex: "#0000ff", fill: "#0000ff", order: 1, pathCount: 1 })];
const SIZE = { sourceSize: { width: 320, height: 240 } };

function installFetch() {
  vi.stubGlobal(
    "fetch",
    abortAwareFetch((url) => {
      if (url === "/svg/A") return svgResponse(SVG_A);
      if (url === "/svg/B") return svgResponse(SVG_B);
      return svgResponse("no existe", 404);
    }),
  );
}

async function renderLoaded(documentKey = "doc") {
  const hook = renderHook(({ key }) => useEditableDocument(LAYERS, { ...SIZE, documentKey: key }), { initialProps: { key: documentKey } });
  await waitFor(() => expect(Object.values(hook.result.current.layerStatus).every((status) => status === "ready")).toBe(true));
  return hook;
}

function moveIds(ids: string[], dx: number) {
  return (state: { objectsByLayer: Record<string, EditorObject[]> }) => {
    const targets = Object.values(state.objectsByLayer)
      .flat()
      .filter((object) => ids.includes(object.id));
    return replaceObjects(state, targets, (found) => translate(found, dx, 0));
  };
}

const fillNew = (selection: string[], hex: string, groupId: string) => (state: EditableDocument) =>
  buildFillProduction(state, new Set(selection), { kind: "new", hex, groupId } satisfies ColorTarget);

describe("useEditableDocument — baseline de guardado (M3-S13)", () => {
  beforeEach(installFetch);
  afterEach(() => vi.unstubAllGlobals());

  it("tras markSaved(saveMark) deja de estar sucio, SIN tocar el historial: se sigue pudiendo deshacer", async () => {
    const { result } = await renderLoaded();
    act(() => void result.current.applyEdit(cmd("Mover"), moveIds(["a1"], 5)));
    expect(result.current.geometryDirty).toBe(true);

    act(() => result.current.markSaved(result.current.saveMark));

    expect(result.current.geometryDirty).toBe(false);
    expect(result.current.undoDepth).toBe(1);
    expect(result.current.canUndo).toBe(true);
    expect(result.current.historyEntries).toHaveLength(1);
  });

  it("deshacer más allá del punto guardado vuelve a ensuciar (difiere de lo del servidor); rehacer hasta él lo limpia", async () => {
    const { result } = await renderLoaded();
    act(() => void result.current.applyEdit(cmd("Mover"), moveIds(["a1"], 5)));
    act(() => result.current.markSaved(result.current.saveMark));

    act(() => void result.current.undo());
    expect(result.current.geometryDirty).toBe(true); // el servidor tiene a1 movido; localmente ya no

    act(() => void result.current.redo());
    expect(result.current.geometryDirty).toBe(false);
  });

  it("lo editado ENTRE el envío y la confirmación sigue sin guardar (la marca es la del envío)", async () => {
    const { result } = await renderLoaded();
    act(() => void result.current.applyEdit(cmd("Mover"), moveIds(["a1"], 5)));
    const sentMark = result.current.saveMark;

    act(() => void result.current.applyEdit(cmd("Mover otra vez"), moveIds(["a2"], 3))); // el usuario sigue editando con el guardado en vuelo
    act(() => result.current.markSaved(sentMark)); // llega la confirmación del envío anterior

    expect(result.current.geometryDirty).toBe(true);
    act(() => result.current.markSaved(result.current.saveMark));
    expect(result.current.geometryDirty).toBe(false);
  });

  it("una capa creada en el cliente (isNew) queda limpia tras guardar; renombrarla después la vuelve a ensuciar", async () => {
    const { result } = await renderLoaded();
    act(() => void result.current.applyEdit(cmd("Rellenar", "object.fill"), fillNew(["a1", "b1"], "#00ff00", "NEW")));
    expect(result.current.geometryDirty).toBe(true);

    act(() => result.current.markSaved(result.current.saveMark));
    expect(result.current.geometryDirty).toBe(false);

    act(() => void result.current.updateLocalLayer("NEW", { name: "Verde" }));
    expect(result.current.geometryDirty).toBe(true);
    act(() => result.current.markSaved(result.current.saveMark));
    expect(result.current.geometryDirty).toBe(false);
  });

  it("deshacer la creación de una capa YA guardada vuelve a ensuciar (el servidor todavía la tiene)", async () => {
    const { result } = await renderLoaded();
    act(() => void result.current.applyEdit(cmd("Rellenar", "object.fill"), fillNew(["a1"], "#00ff00", "NEW")));
    act(() => result.current.markSaved(result.current.saveMark));

    act(() => void result.current.undo());

    expect(result.current.layers.some((candidate) => candidate.groupId === "NEW")).toBe(false);
    expect(result.current.geometryDirty).toBe(true);
  });

  it("el marco (crop) también se confirma: limpio tras guardar, sucio si cambia después", async () => {
    const { result } = await renderLoaded();
    const target: DocumentFrame = { x: 0, y: 0, width: 160, height: 120 };
    act(() => void result.current.applyEdit(cmd("Recortar", "document.crop"), (state: EditableDocument) => cropProduction(state, target, true)));
    expect(result.current.geometryDirty).toBe(true);

    act(() => result.current.markSaved(result.current.saveMark));
    expect(result.current.geometryDirty).toBe(false);

    act(() => void result.current.undo());
    expect(result.current.geometryDirty).toBe(true);
  });

  it("una marca de un documento ya reiniciado (otro documentKey) se ignora", async () => {
    const { result, rerender } = await renderLoaded("doc-1");
    act(() => void result.current.applyEdit(cmd("Mover"), moveIds(["a1"], 5)));
    const staleMark = result.current.saveMark;

    rerender({ key: "doc-2" });
    await waitFor(() => expect(Object.values(result.current.layerStatus).every((status) => status === "ready")).toBe(true));
    act(() => void result.current.applyEdit(cmd("Mover"), moveIds(["a1"], 9)));
    expect(result.current.geometryDirty).toBe(true);

    act(() => result.current.markSaved(staleMark));

    expect(result.current.geometryDirty).toBe(true);
  });

  it("sin guardados el comportamiento es el de siempre: sucio al editar, limpio al deshacer hasta el origen", async () => {
    const { result } = await renderLoaded();
    expect(result.current.geometryDirty).toBe(false);
    act(() => void result.current.applyEdit(cmd("Mover"), moveIds(["a1"], 5)));
    expect(result.current.geometryDirty).toBe(true);
    act(() => void result.current.undo());
    expect(result.current.geometryDirty).toBe(false);
  });
});
