import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IDENTITY_MATRIX } from "../lib/svgTransform";
import { abortAwareFetch } from "../test/abortableFetch";
import type { EditableDocument, EditableLayerMeta, EditorObject, EditProduction } from "../lib/editor/types";
import type { ApplyEditResult } from "./useEditableDocument";
import { useDrawEraseTools } from "./useDrawEraseTools";

/**
 * useDrawEraseTools (M3-S04) aislado del Workspace: con un `editable` simulado que captura cada comando se verifican los ids REALES
 * (UUID únicos), la capa de cada objeto y que cada trazo/gesto produce exactamente UN comando. El flujo completo con la UI está en
 * EditorShell.draw.test.tsx / EditorShell.erase.test.tsx.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function layer(groupId: string, overrides: Partial<EditableLayerMeta> = {}): EditableLayerMeta {
  return { groupId, name: `Capa ${groupId}`, colorHex: "#ff0000", order: 0, visible: true, locked: false, manufacturingOperation: "unassigned", isNew: false, ...overrides };
}

const SQUARE: EditorObject = { id: "sq", layerGroupId: "A", d: "M0 0 H40 V40 H0 Z", fill: "#ff0000", matrix: IDENTITY_MATRIX };

function setup(options: { layers?: EditableLayerMeta[]; activeGroupId?: string | null; objects?: Record<string, EditorObject[]>; activeTool?: string } = {}) {
  const layers = options.layers ?? [layer("A")];
  const state: EditableDocument = { objectsByLayer: options.objects ?? { A: [SQUARE] }, layers };
  const commands: Array<{ label: string; production: EditProduction | null }> = [];
  const applyEdit = vi.fn((label: string, producer: (current: EditableDocument) => EditProduction | null): ApplyEditResult => {
    const production = producer(state);
    commands.push({ label, production });
    return production ? { applied: true, skippedLockedObjects: 0, skippedHiddenObjects: 0 } : { applied: false, reason: "no_change", skippedLockedObjects: 0, skippedHiddenObjects: 0 };
  });
  const selectGroup = vi.fn();
  const onNotice = vi.fn();
  const hook = renderHook(
    (props: { activeGroupId: string | null }) =>
      useDrawEraseTools({
        activeTool: options.activeTool ?? "draw",
        editable: { applyEdit, getSnapshot: () => state },
        layers,
        activeGroupId: props.activeGroupId,
        selectGroup,
        mmFactor: 0.5,
        onNotice,
      }),
    { initialProps: { activeGroupId: options.activeGroupId ?? null } },
  );
  return { ...hook, commands, applyEdit, selectGroup, onNotice, state };
}

describe("useDrawEraseTools — Draw", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("un trazo en una capa existente produce UN comando con un objeto de id UUID en ESA capa y selecciona la capa", () => {
    const { result, commands, selectGroup } = setup({ activeGroupId: "A" });
    act(() => {
      result.current.draw.addPoint({ x: 10, y: 10 }, false);
      result.current.draw.addPoint({ x: 50, y: 10 }, false);
    });
    act(() => result.current.draw.finish(false));

    expect(commands).toHaveLength(1);
    const production = commands[0].production!;
    expect(Object.keys(production.layers)).toEqual(["A"]);
    const created = production.layers.A[production.layers.A.length - 1];
    expect(created.id).toMatch(UUID);
    expect(created.layerGroupId).toBe("A");
    expect(production.layers.A[0]).toBe(SQUARE);
    expect(production.layerMetas).toBeUndefined();
    expect(selectGroup).toHaveBeenCalledWith("A");
    expect(result.current.draw.draft).toEqual([]);
  });

  it("sin capa activa: la capa «Dibujo» nueva y su objeto salen en el MISMO comando, con ids UUID distintos entre sí", () => {
    const { result, commands, selectGroup } = setup();
    act(() => {
      result.current.draw.addPoint({ x: 10, y: 10 }, false);
      result.current.draw.addPoint({ x: 50, y: 10 }, false);
    });
    act(() => result.current.draw.finish(false));

    expect(commands).toHaveLength(1);
    const production = commands[0].production!;
    const [newLayer] = production.layerMetas!;
    expect(newLayer).toMatchObject({ name: "Dibujo", colorHex: "#000000", isNew: true, locked: false, visible: true });
    expect(newLayer.groupId).toMatch(UUID);
    const [created] = production.layers[newLayer.groupId];
    expect(created.id).toMatch(UUID);
    expect(created.id).not.toBe(newLayer.groupId);
    expect(created.layerGroupId).toBe(newLayer.groupId);
    expect(selectGroup).toHaveBeenCalledWith(newLayer.groupId);
    expect(production.atomic).toBe(true);
  });

  it("cada trazo genera ids nuevos (nunca repite)", () => {
    const { result, commands } = setup({ activeGroupId: "A" });
    for (let index = 0; index < 3; index += 1) {
      act(() => {
        result.current.draw.addPoint({ x: 10, y: 10 + index * 5 }, false);
        result.current.draw.addPoint({ x: 50, y: 10 + index * 5 }, false);
      });
      act(() => result.current.draw.finish(false));
    }
    const ids = commands.map((command) => command.production!.layers.A.at(-1)!.id);
    expect(commands).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });

  it("una capa activa bloqueada u oculta rechaza con mensaje y no genera ningún comando; el borrador se conserva", () => {
    const locked = setup({ layers: [layer("A", { name: "Rojo", locked: true })], activeGroupId: "A" });
    act(() => {
      locked.result.current.draw.addPoint({ x: 10, y: 10 }, false);
      locked.result.current.draw.addPoint({ x: 50, y: 10 }, false);
    });
    act(() => locked.result.current.draw.finish(false));
    expect(locked.commands).toHaveLength(0);
    expect(locked.result.current.draw.message).toMatch(/«Rojo» está bloqueada/);
    expect(locked.result.current.draw.draft).toHaveLength(2);
    expect(locked.result.current.draw.target).toMatchObject({ kind: "rejected", layerName: "Rojo" });

    const hidden = setup({ layers: [layer("A", { name: "Azul", visible: false })], activeGroupId: "A" });
    act(() => {
      hidden.result.current.draw.addPoint({ x: 10, y: 10 }, false);
      hidden.result.current.draw.addPoint({ x: 50, y: 10 }, false);
    });
    act(() => hidden.result.current.draw.finish(false));
    expect(hidden.commands).toHaveLength(0);
    expect(hidden.result.current.draw.message).toMatch(/«Azul» está oculta/);
  });

  it("el estado de la capa de destino sigue a la capa activa", () => {
    const { result, rerender } = setup({ layers: [layer("A", { name: "Rojo" })], activeGroupId: null });
    expect(result.current.draw.target).toEqual({ kind: "create", layerName: null, message: null });
    rerender({ activeGroupId: "A" });
    expect(result.current.draw.target).toEqual({ kind: "existing", layerName: "Rojo", message: null });
  });

  it("un cerrado que se cruza llama al servidor, y sin servidor NO crea nada (ni el moño)", async () => {
    vi.stubGlobal("fetch", abortAwareFetch(() => new Response(JSON.stringify({ code: "engine_unavailable", message: "caído" }), { status: 503, headers: { "Content-Type": "application/json" } })));
    const { result, commands } = setup({ activeGroupId: "A" });
    act(() => {
      for (const [x, y] of [[0, 0], [40, 40], [40, 0], [0, 40]]) result.current.draw.addPoint({ x, y }, false);
    });
    await act(async () => result.current.draw.finish(true));

    await waitFor(() => expect(result.current.draw.message).toMatch(/El trazo no se creó/));
    expect(commands).toHaveLength(0);
    expect(result.current.draw.draft).toHaveLength(4);
  });

  it("los parámetros en mm se convierten con el factor del documento: 0,1 mm de ancho = 0,2 u (0,5 mm por unidad)", () => {
    const { result, commands } = setup({ activeGroupId: "A" });
    act(() => {
      result.current.draw.addPoint({ x: 10, y: 10 }, false);
      result.current.draw.addPoint({ x: 50, y: 10 }, false);
    });
    act(() => result.current.draw.finish(false));

    expect(result.current.unit).toEqual({ factor: 0.5, label: "mm" });
    expect(commands[0].production!.layers.A.at(-1)!.strokeWidth).toBeCloseTo(0.2, 12);
  });
});

describe("useDrawEraseTools — Erase", () => {
  afterEach(() => vi.unstubAllGlobals());

  const response = (pieces: unknown[]) =>
    new Response(JSON.stringify({ operation: "difference", scope: "per_subject", tolerance: 0.02, pieceCount: pieces.length, results: [{ subjectIndex: 0, changed: true, geometries: pieces }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  const top = { type: "polygon", coordinates: [[[0, 0], [40, 0], [40, 16], [0, 16], [0, 0]]] };
  const bottom = { type: "polygon", coordinates: [[[0, 24], [40, 24], [40, 40], [0, 40], [0, 24]]] };

  it("el borrado parcial que parte un objeto crea piezas con ids UUID únicos en la capa del original y un solo comando", async () => {
    vi.stubGlobal("fetch", abortAwareFetch(() => response([top, bottom])));
    const { result, commands } = setup({ activeTool: "erase", activeGroupId: "A" });

    await act(async () => result.current.erase.eraseStroke([{ x: -10, y: 20 }, { x: 50, y: 20 }]));

    await waitFor(() => expect(commands).toHaveLength(1));
    const pieces = commands[0].production!.layers.A;
    expect(pieces).toHaveLength(2);
    expect(pieces.map((piece) => piece.layerGroupId)).toEqual(["A", "A"]);
    for (const piece of pieces) expect(piece.id).toMatch(UUID);
    expect(new Set(pieces.map((piece) => piece.id)).size).toBe(2);
    expect(pieces.map((piece) => piece.id)).not.toContain("sq");
    expect(commands[0].label).toBe("Borrar con pincel (1 objeto)");
  });

  it("un objeto reducido a UNA pieza conserva su id", async () => {
    vi.stubGlobal("fetch", abortAwareFetch(() => response([top])));
    const { result, commands } = setup({ activeTool: "erase", activeGroupId: "A" });

    await act(async () => result.current.erase.eraseStroke([{ x: -10, y: 20 }, { x: 50, y: 20 }]));

    await waitFor(() => expect(commands).toHaveLength(1));
    expect(commands[0].production!.layers.A.map((piece) => piece.id)).toEqual(["sq"]);
  });

  it("si el servidor falla no hay comando y el error queda disponible", async () => {
    vi.stubGlobal("fetch", abortAwareFetch(() => new Response(JSON.stringify({ code: "timeout", message: "lento" }), { status: 504, headers: { "Content-Type": "application/json" } })));
    const { result, commands } = setup({ activeTool: "erase", activeGroupId: "A" });

    await act(async () => result.current.erase.eraseStroke([{ x: -10, y: 20 }, { x: 50, y: 20 }]));

    await waitFor(() => expect(result.current.serverError).toMatch(/tardó demasiado/));
    expect(commands).toHaveLength(0);
  });

  it("el modo Objeto genera UN comando que quita los objetos pedidos y deja los de capas bloqueadas", () => {
    const locked = { ...SQUARE, id: "lk", layerGroupId: "L" };
    const { result, commands, onNotice } = setup({
      activeTool: "erase",
      layers: [layer("A"), layer("L", { locked: true })],
      objects: { A: [SQUARE], L: [locked] },
    });

    act(() => result.current.erase.eraseObjects(["sq", "lk"]));

    expect(commands).toHaveLength(1);
    expect(commands[0].production!.layers).toEqual({ A: [] });
    expect(commands[0].label).toBe("Borrar 1 objeto");
    expect(onNotice).toHaveBeenLastCalledWith("1 objeto eliminado. 1 objeto está en capas bloqueadas y no se borró.");
  });

  it("los ids de objetos que ya no existen se ignoran sin comando", () => {
    const { result, commands } = setup({ activeTool: "erase" });
    act(() => result.current.erase.eraseObjects(["fantasma"]));
    expect(commands).toHaveLength(0);
  });

  it("el radio en mm se expone en unidades de documento (2 mm = 4 u) y no depende de nada más", () => {
    const { result } = setup({ activeTool: "erase" });
    expect(result.current.erase.radiusMm).toBe(2);
    expect(result.current.erase.radiusUnits).toBe(4);
    act(() => result.current.erase.setRadiusMm(5));
    expect(result.current.erase.radiusUnits).toBe(10);
  });
});
