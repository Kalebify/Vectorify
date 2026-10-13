import { StrictMode, useEffect } from "react";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cropProduction } from "../lib/editor/frame";
import { planRecolor } from "../lib/editor/colors";
import { parseCommand, type CommandDraft, type EditorCommand } from "../lib/editor/commands";
import { moveProduction } from "../lib/editor/operations";
import type { EditableDocument, LayerMetaChange } from "../lib/editor/types";
import { abortAwareFetch, svgResponse } from "../test/abortableFetch";
import { cmd } from "../test/commands";
import { useEditableDocument, type PersistLayerMeta, type PersistResult, type UseEditableDocumentOptions } from "./useEditableDocument";
import type { VectorDocumentLayer } from "./useVectorDocument";

/**
 * Historial de comandos (M3-S12) sobre `useEditableDocument`: cada entrada es `{ command, patch }`; secuencias mixtas (objetos + marco + estructura de capas +
 * metadata), 60 acciones recorridas hacia atrás y adelante recuperando el estado EXACTO, `jumpTo`, ramas de rehacer, límite y avisos, y metadata de capa con
 * PATCH inverso (persistidor simulado con conteo de llamadas).
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
const SVG_A2 = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><path data-vid="z1" d="M0 0 H5 V5 H0 Z" fill="#ff0000"/></svg>`;

function installFetch(overrides: Record<string, () => Response | Promise<Response>> = {}) {
  const fetchMock = abortAwareFetch((url) => {
    if (overrides[url]) return overrides[url]();
    if (url === "/svg/A") return svgResponse(SVG_A);
    if (url === "/svg/A2") return svgResponse(SVG_A2);
    if (url === "/svg/B") return svgResponse(SVG_B);
    return svgResponse("no existe", 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const LAYERS = [layer(), layer({ groupId: "B", name: "Azul", vectorId: "vector-b", svgUrl: "/svg/B", colorHex: "#0000ff", order: 1, manufacturingOperation: "unassigned" })];
const SIZE = { sourceSize: { width: 320, height: 240 } };

/** Un reloj que solo avanza cuando el test lo dice, y ids de comando predecibles. */
function fakes() {
  let now = 1_000;
  let counter = 0;
  return {
    clock: () => now,
    tick: (ms = 10) => {
      now += ms;
    },
    createCommandId: () => `cmd-${(counter += 1)}`,
  };
}

/** Productor de prueba: traslada los objetos con esos ids (reusa el mismo productor que el canvas). */
function moveIds(ids: string[], dx: number, dy = 0) {
  return (state: EditableDocument) => moveProduction(state, new Set(ids), dx, dy);
}

interface World {
  hook: ReturnType<typeof renderHook<ReturnType<typeof useEditableDocument>, { layers: VectorDocumentLayer[]; options: UseEditableDocumentOptions }>>;
  /** Metadata de las capas DEL SERVIDOR que mantiene el persistidor simulado (en producción vive en `useVectorDocument`). */
  server: Record<string, { name: string; visible: boolean; locked: boolean; operation: string }>;
  calls: Array<{ change: LayerMetaChange; direction: "undo" | "redo"; optimistic: boolean }>;
  failNext: { error: string } | null;
  gate: { release: (() => void) | null; hold: boolean };
  time: ReturnType<typeof fakes>;
}

/**
 * Hook + persistidor simulado. Hace lo mismo que el del shell, sin red: una capa `isNew` se edita con `updateLocalLayer`; una del servidor actualiza `world.server`
 * (su "PATCH"). `failNext` hace fallar el próximo; `gate.hold` lo deja en vuelo hasta `gate.release()`.
 */
async function setup(options: UseEditableDocumentOptions = {}, layers = LAYERS): Promise<World & { result: World["hook"]["result"] }> {
  installFetch();
  const time = fakes();
  const world = { server: {}, calls: [], failNext: null, gate: { release: null, hold: false }, time } as unknown as World;
  for (const l of layers) world.server[l.groupId] = { name: l.name, visible: l.visible, locked: l.locked, operation: l.manufacturingOperation };

  const persist: PersistLayerMeta = async (change, direction, mode) => {
    world.calls.push({ change, direction, optimistic: mode.optimistic });
    if (world.gate.hold) await new Promise<void>((resolve) => (world.gate.release = resolve));
    if (world.failNext) {
      const error = world.failNext.error;
      world.failNext = null;
      return { ok: false, error } satisfies PersistResult;
    }
    if (change.kind === "order") return { ok: true };
    const side = direction === "undo" ? "before" : "after";
    const value = change[side];
    const current = world.hook.result.current;
    // Estado fresco (no el último render): dentro de un jumpTo los pasos de geometría ya cambiaron las capas nuevas.
    if (current.getSnapshot().layers?.find((candidate) => candidate.groupId === change.groupId)?.isNew) {
      const key = change.kind === "rename" ? "name" : change.kind === "operation" ? "manufacturingOperation" : change.kind;
      current.updateLocalLayer(change.groupId, { [key]: value });
      return { ok: true };
    }
    const target = world.server[change.groupId];
    const field = change.kind === "rename" ? "name" : change.kind === "operation" ? "operation" : change.kind;
    (target as Record<string, unknown>)[field] = value;
    return { ok: true };
  };

  const hookOptions: UseEditableDocumentOptions = { ...SIZE, clock: time.clock, createCommandId: time.createCommandId, persistLayerMeta: persist, ...options };
  world.hook = renderHook(({ layers: current, options: opts }) => useEditableDocument(current, opts), { initialProps: { layers, options: hookOptions } });
  await waitFor(() => expect(Object.values(world.hook.result.current.layerStatus).every((status) => status === "ready")).toBe(true));
  return Object.assign(world, { result: world.hook.result });
}

const act0 = async (fn: () => unknown) => {
  await act(async () => {
    await fn();
  });
};

/** Foto EXACTA del estado observable: objetos, marco, estructura efectiva de capas, metadata del servidor y banderas derivadas. */
function capture(world: World) {
  const { result } = world.hook;
  return structuredClone({
    snapshot: result.current.getSnapshot(),
    committedLayers: result.current.committedLayers,
    server: world.server,
    geometryDirty: result.current.geometryDirty,
    edited: [...result.current.editedLayerIds].sort(),
  });
}

describe("useEditableDocument — historial: forma de las entradas (command + patch)", () => {
  beforeEach(() => {
    installFetch();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("applyEdit registra un EditorCommand v1 con id, sequence, type, label, targets derivados del parche, parameters, origin y timestamp del reloj inyectado", async () => {
    const w = await setup();
    w.time.tick(50);
    let applied = { applied: false } as ReturnType<typeof w.result.current.applyEdit>;
    await act0(() => {
      applied = w.result.current.applyEdit({ type: "object.move", label: "Mover 2 objetos", parameters: { dx: 5, dy: 0 } }, moveIds(["a1", "b1"], 5));
    });
    expect(applied.applied).toBe(true);
    const command = applied.command!;
    expect(command).toEqual({
      version: 1,
      id: "cmd-1",
      sequence: 1,
      type: "object.move",
      label: "Mover 2 objetos",
      // Los targets salen de lo que REALMENTE cambió: dos objetos en dos capas.
      targets: { layerIds: ["A", "B"], objectIds: ["a1", "b1"] },
      parameters: { dx: 5, dy: 0, objectCount: 2 },
      origin: "user",
      timestamp: 1_050,
    });
    expect(w.result.current.undoCommand).toEqual(command);
    expect(w.result.current.redoCommand).toBeNull();
    expect(w.result.current.undoLabel).toBe("Mover 2 objetos");
    // El comando es JSON puro: ida y vuelta idéntica, y válido para el lector estricto.
    expect(JSON.parse(JSON.stringify(command))).toEqual(command);
    expect(parseCommand(JSON.stringify(command))).toEqual({ ok: true, command });
  });

  it("sin label en el borrador, la etiqueta sale del registro (en español); origin por defecto 'user' y se respeta 'ai'/'system'", async () => {
    const w = await setup();
    await act0(() => {
      w.result.current.applyEdit({ type: "object.move", parameters: { dx: 1, dy: 0 } }, moveIds(["a1"], 1));
      w.result.current.applyEdit({ type: "object.move", label: "  ", origin: "ai", parameters: { dx: 1, dy: 0 } }, moveIds(["a1"], 1));
      w.result.current.applyEdit({ type: "object.move", origin: "system", parameters: { dx: 1, dy: 0 } }, moveIds(["a1"], 1));
    });
    const entries = w.result.current.historyEntries.map((entry) => entry.command);
    expect(entries.map((c) => c.label)).toEqual(["Mover objetos", "Mover objetos", "Mover objetos"]);
    expect(entries.map((c) => c.origin)).toEqual(["user", "ai", "system"]);
  });

  it("sequence crece de a uno, no se reutiliza al descartar la rama de rehacer, y timestamp sigue al reloj", async () => {
    const w = await setup();
    for (let step = 0; step < 3; step += 1) {
      w.time.tick(100);
      await act0(() => void w.result.current.applyEdit(cmd(`m${step}`), moveIds(["a1"], 1)));
    }
    expect(w.result.current.historyEntries.map((e) => [e.command.sequence, e.command.timestamp])).toEqual([
      [1, 1_100],
      [2, 1_200],
      [3, 1_300],
    ]);
    await act0(() => void w.result.current.undo());
    await act0(() => void w.result.current.undo());
    w.time.tick(100);
    await act0(() => void w.result.current.applyEdit(cmd("nueva rama"), moveIds(["a1"], 7)));
    // La rama descartada ya consumió las secuencias 2 y 3: la nueva es la 4.
    expect(w.result.current.historyEntries.map((e) => e.command.sequence)).toEqual([1, 4]);
  });

  it("un tipo desconocido es un error de programación: lanza ANTES de tocar el documento ni la pila", async () => {
    const w = await setup();
    const before = capture(w);
    expect(() => w.result.current.applyEdit({ type: "object.teleport" as never }, moveIds(["a1"], 1))).toThrow(/desconocido/);
    expect(w.result.current.undoDepth).toBe(0);
    expect(capture(w)).toEqual(before);
  });

  it("parámetros con geometría cruda o claves desconocidas fallan en desarrollo (nunca llegan al historial)", async () => {
    const w = await setup();
    expect(() => w.result.current.applyEdit({ type: "object.move", parameters: { dx: 1, dy: 0, d: "M0 0 L10 10" } }, moveIds(["a1"], 1))).toThrow(/crudos|no es un parámetro/);
    expect(() => w.result.current.applyEdit({ type: "object.move", parameters: { dx: 1, dy: 0, note: "<svg><path d='M0 0'/></svg>" } }, moveIds(["a1"], 1))).toThrow();
    expect(w.result.current.undoDepth).toBe(0);
  });

  it("exportHistory devuelve SOLO los comandos (sin parches, snapshots ni SVG) y la posición; incluye la rama de rehacer", async () => {
    const w = await setup();
    for (let step = 0; step < 3; step += 1) await act0(() => void w.result.current.applyEdit(cmd(`m${step}`), moveIds(["a1"], 1)));
    await act0(() => void w.result.current.undo());
    const exported = w.result.current.exportHistory();
    expect(exported.version).toBe(1);
    expect(exported.position).toBe(2);
    expect(exported.commands.map((c) => c.label)).toEqual(["m0", "m1", "m2"]);
    const text = JSON.stringify(exported);
    for (const forbidden of ["touched", "before", "after", "<svg", "<path", "\"d\":", "matrix"]) expect(text).not.toContain(forbidden);
    // Es una copia: mutarla no toca el historial.
    exported.commands[0].label = "mutado";
    expect(w.result.current.historyEntries[0].command.label).toBe("m0");
  });

  it("targets del borrador (si el call-site los pide) mandan sobre los derivados", async () => {
    const w = await setup();
    await act0(() => void w.result.current.applyEdit({ type: "object.move", parameters: { dx: 1, dy: 0 }, targets: { objectIds: ["a1"], layerIds: ["A"] } }, moveIds(["a1"], 1)));
    expect(w.result.current.undoCommand!.targets).toEqual({ layerIds: ["A"], objectIds: ["a1"] });
  });
});

describe("useEditableDocument — historial: undo, redo y rama de rehacer", () => {
  beforeEach(() => {
    installFetch();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("una acción nueva tras un undo DESCARTA la rama redo (y la secuencia/exportación lo reflejan)", async () => {
    const w = await setup();
    await act0(() => void w.result.current.applyEdit(cmd("uno"), moveIds(["a1"], 1)));
    await act0(() => void w.result.current.applyEdit(cmd("dos"), moveIds(["a1"], 1)));
    await act0(() => void w.result.current.applyEdit(cmd("tres"), moveIds(["a2"], 3)));
    await act0(() => void w.result.current.undo());
    await act0(() => void w.result.current.undo());
    expect(w.result.current.canRedo).toBe(true);
    expect(w.result.current.historyEntries.map((e) => [e.command.label, e.applied])).toEqual([
      ["uno", true],
      ["dos", false],
      ["tres", false],
    ]);

    await act0(() => void w.result.current.applyEdit(cmd("rama nueva"), moveIds(["b1"], 4)));
    expect(w.result.current.canRedo).toBe(false);
    expect(w.result.current.redoCommand).toBeNull();
    expect(w.result.current.historyEntries.map((e) => e.command.label)).toEqual(["uno", "rama nueva"]);
    expect(w.result.current.exportHistory().commands.map((c) => c.label)).toEqual(["uno", "rama nueva"]);
  });

  it("undoCommand/redoCommand siguen al puntero, y los botones leen undoLabel/redoLabel del comando", async () => {
    const w = await setup();
    await act0(() => void w.result.current.applyEdit(cmd("uno"), moveIds(["a1"], 1)));
    await act0(() => void w.result.current.applyEdit(cmd("dos"), moveIds(["a1"], 1)));
    expect([w.result.current.undoCommand?.label, w.result.current.redoCommand?.label]).toEqual(["dos", undefined]);
    await act0(() => void w.result.current.undo());
    expect([w.result.current.undoCommand?.label, w.result.current.redoCommand?.label]).toEqual(["uno", "dos"]);
    expect([w.result.current.undoLabel, w.result.current.redoLabel]).toEqual(["uno", "dos"]);
    expect(w.result.current.historyPosition).toBe(1);
  });

  it("un gesto (previewEdit xN + commitGesture) crece la pila en 1 y registra un solo comando con sus parámetros", async () => {
    const w = await setup();
    await act0(() => {
      expect(w.result.current.beginGesture()).toBe(true);
    });
    for (let frame = 1; frame <= 25; frame += 1) await act0(() => void w.result.current.previewEdit(moveIds(["a1"], frame)));
    expect(w.result.current.undoDepth).toBe(0);
    expect(w.result.current.historyEntries).toHaveLength(0);
    let outcome = { applied: false } as ReturnType<typeof w.result.current.commitGesture>;
    await act0(() => {
      outcome = w.result.current.commitGesture({ type: "object.move", label: "Mover 1 objeto", parameters: { dx: 25, dy: 0 } });
    });
    expect(outcome.applied).toBe(true);
    expect(w.result.current.undoDepth).toBe(1);
    expect(w.result.current.historyEntries.map((e) => e.command)).toHaveLength(1);
    expect(w.result.current.undoCommand).toMatchObject({ type: "object.move", parameters: { dx: 25, dy: 0, objectCount: 1 }, targets: { objectIds: ["a1"] } });
  });

  it("un borrador inválido en commitGesture lanza SIN dejar el gesto colgado", async () => {
    const w = await setup();
    await act0(() => void w.result.current.beginGesture());
    await act0(() => void w.result.current.previewEdit(moveIds(["a1"], 3)));
    expect(() => w.result.current.commitGesture({ type: "nope" as never })).toThrow();
    await waitFor(() => expect(w.result.current.gestureActive).toBe(false));
    expect(w.result.current.undoDepth).toBe(0);
  });

  it("un producer que lanza no corrompe la pila ni el documento; un rechazo por locks no registra comando", async () => {
    const lockedLayers = [layer({ locked: true }), LAYERS[1]];
    const w = await setup({}, lockedLayers);
    const before = capture(w);
    expect(() =>
      w.result.current.applyEdit(cmd("explota"), () => {
        throw new Error("productor roto");
      }),
    ).toThrow("productor roto");
    expect(w.result.current.undoDepth).toBe(0);
    expect(capture(w)).toEqual(before);

    let rejected = { applied: true } as ReturnType<typeof w.result.current.applyEdit>;
    await act0(() => {
      rejected = w.result.current.applyEdit(cmd("mover bloqueado"), moveIds(["a1"], 5));
    });
    expect(rejected).toMatchObject({ applied: false, reason: "blocked", skippedLockedObjects: 1 });
    expect(w.result.current.historyEntries).toHaveLength(0);
    expect(capture(w)).toEqual(before);
    // …y el historial sigue sano: una edición válida se registra normalmente.
    await act0(() => void w.result.current.applyEdit(cmd("mover libre"), moveIds(["b1"], 5)));
    expect(w.result.current.historyEntries).toHaveLength(1);
  });

  it("una ráfaga con coalesceKey es UN comando con los parameters ACUMULADOS (dx/dy sumados) y conserva id/sequence del primero", async () => {
    const w = await setup();
    for (let step = 0; step < 4; step += 1) {
      w.time.tick(100);
      await act0(() => void w.result.current.applyEdit({ type: "object.nudge", label: "Mover 1 objeto", parameters: { dx: 1, dy: 2 } }, moveIds(["a1"], 1, 2), { coalesceKey: "nudge:1:a1:a1" }));
    }
    expect(w.result.current.undoDepth).toBe(1);
    const [only] = w.result.current.historyEntries;
    expect(only.command).toMatchObject({ id: "cmd-1", sequence: 1, type: "object.nudge", timestamp: 1_400, parameters: { dx: 4, dy: 8, objectCount: 1 } });
    // Una acción de OTRO tipo con la misma clave no se funde.
    await act0(() => void w.result.current.applyEdit({ type: "object.move", parameters: { dx: 1, dy: 0 } }, moveIds(["a1"], 1), { coalesceKey: "nudge:1:a1:a1" }));
    expect(w.result.current.undoDepth).toBe(2);
    // Deshacer revierte la ráfaga completa de un tirón.
    await act0(() => void w.result.current.undo());
    await act0(() => void w.result.current.undo());
    expect(w.result.current.geometryDirty).toBe(false);
  });

  it("el límite descarta la entrada más vieja y AVISA una vez (descartable); el documento no 'olvida' lo editado", async () => {
    const w = await setup({ limit: 3 });
    for (let step = 0; step < 5; step += 1) await act0(() => void w.result.current.applyEdit(cmd(`m${step}`), moveIds(["a1"], 1)));
    expect(w.result.current.historyEntries.map((e) => e.command.label)).toEqual(["m2", "m3", "m4"]);
    expect(w.result.current.historyLimit).toBe(3);
    const notice = w.result.current.historyNotices.find((n) => n.kind === "truncated");
    expect(notice?.message).toMatch(/últimas 3 acciones.*2 más antiguas/);
    // Aunque el historial ya no llegue al origen, el documento sigue marcado como editado (honestidad de guardado).
    for (let step = 0; step < 3; step += 1) await act0(() => void w.result.current.undo());
    expect(w.result.current.geometryDirty).toBe(true);

    await act0(() => w.result.current.dismissHistoryNotice("truncated"));
    expect(w.result.current.historyNotices).toEqual([]);
    // Seguir descartando NO vuelve a avisar (se avisa una vez).
    for (let step = 0; step < 4; step += 1) await act0(() => void w.result.current.applyEdit(cmd(`n${step}`), moveIds(["a1"], 1)));
    expect(w.result.current.historyNotices).toEqual([]);
  });

  it("clearHistory vacía las entradas sin tocar el documento", async () => {
    const w = await setup();
    await act0(() => void w.result.current.applyEdit(cmd("uno"), moveIds(["a1"], 5)));
    const before = capture(w);
    await act0(() => w.result.current.clearHistory());
    expect(w.result.current.historyEntries).toEqual([]);
    expect(w.result.current.canUndo).toBe(false);
    expect(capture(w)).toEqual(before);
  });
});

describe("useEditableDocument — historial: reinicio por documento regenerado o distinto (reload según alcance)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("si cambia el svgUrl de una capa cargada el historial se reinicia CON AVISO visible (las ediciones sin guardar se descartan)", async () => {
    installFetch();
    const fakesSet = fakes();
    const options: UseEditableDocumentOptions = { ...SIZE, clock: fakesSet.clock, createCommandId: fakesSet.createCommandId };
    const hook = renderHook(({ layers }) => useEditableDocument(layers, options), { initialProps: { layers: LAYERS } });
    await waitFor(() => expect(hook.result.current.layerStatus.A).toBe("ready"));
    await act0(() => void hook.result.current.applyEdit(cmd("uno"), moveIds(["a1"], 5)));
    await act0(() => void hook.result.current.applyEdit(cmd("dos"), moveIds(["a1"], 5)));
    expect(hook.result.current.historyNotices).toEqual([]);

    hook.rerender({ layers: [layer({ svgUrl: "/svg/A2" }), LAYERS[1]] });
    await waitFor(() => expect(hook.result.current.objectsByLayer.A.map((o) => o.id)).toEqual(["z1"]));
    expect(hook.result.current.historyEntries).toEqual([]);
    expect(hook.result.current.canUndo).toBe(false);
    expect(hook.result.current.geometryDirty).toBe(false);
    const [notice] = hook.result.current.historyNotices;
    expect(notice.kind).toBe("reset");
    expect(notice.message).toMatch(/regeneró.*2 acciones/);
    await act0(() => hook.result.current.dismissHistoryNotice("reset"));
    expect(hook.result.current.historyNotices).toEqual([]);
  });

  it("sin nada que perder, la regeneración no inventa un aviso", async () => {
    installFetch();
    const hook = renderHook(({ layers }) => useEditableDocument(layers), { initialProps: { layers: LAYERS } });
    await waitFor(() => expect(hook.result.current.layerStatus.A).toBe("ready"));
    hook.rerender({ layers: [layer({ svgUrl: "/svg/A2" }), LAYERS[1]] });
    await waitFor(() => expect(hook.result.current.objectsByLayer.A.map((o) => o.id)).toEqual(["z1"]));
    expect(hook.result.current.historyNotices).toEqual([]);
  });

  it("cambiar de documento (documentKey) reinicia el estado editable y el historial, con aviso", async () => {
    installFetch();
    const hook = renderHook(({ key }) => useEditableDocument(LAYERS, { documentKey: key }), { initialProps: { key: "p1|i1|pal1" } });
    await waitFor(() => expect(hook.result.current.layerStatus.A).toBe("ready"));
    await act0(() => void hook.result.current.applyEdit(cmd("uno"), moveIds(["a1"], 5)));
    expect(hook.result.current.historyEntries).toHaveLength(1);

    hook.rerender({ key: "p1|i2|pal1" });
    await waitFor(() => expect(hook.result.current.historyNotices.map((n) => n.kind)).toEqual(["reset"]));
    expect(hook.result.current.historyEntries).toEqual([]);
    expect(hook.result.current.historyNotices[0].message).toMatch(/otro documento/);
    // Se vuelve a cargar limpio desde los SVG de origen.
    await waitFor(() => expect(hook.result.current.layerStatus.A).toBe("ready"));
    expect(hook.result.current.geometryDirty).toBe(false);
    expect(hook.result.current.objectsByLayer.A.map((o) => o.id)).toEqual(["a1", "a2"]);
  });

  it("React StrictMode: el efecto doble no reinicia ni duplica el historial", async () => {
    installFetch();
    let latest: ReturnType<typeof useEditableDocument> | null = null;
    function Probe() {
      const api = useEditableDocument(LAYERS, { documentKey: "doc", ...SIZE });
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
    await waitFor(() => expect(latest?.layerStatus.A).toBe("ready"));
    await waitFor(() => expect(latest?.layerStatus.B).toBe("ready"));
    await act0(() => void latest!.applyEdit(cmd("uno"), moveIds(["a1"], 5)));
    await act0(() => void latest!.undo());
    await act0(() => void latest!.redo());
    expect(latest!.historyEntries).toHaveLength(1);
    expect(latest!.historyNotices).toEqual([]);
  });
});

describe("useEditableDocument — jumpTo", () => {
  beforeEach(() => {
    installFetch();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("deshace y rehace varios pasos de una vez, atómico para la UI, y al estado inicial con null", async () => {
    const w = await setup();
    const initial = capture(w);
    const snapshots = [initial];
    for (let step = 0; step < 5; step += 1) {
      await act0(() => void w.result.current.applyEdit(cmd(`m${step}`), moveIds(["a1"], step + 1)));
      snapshots.push(capture(w));
    }
    const ids = w.result.current.historyEntries.map((e) => e.command.id);

    let jump = { ok: false } as Awaited<ReturnType<typeof w.result.current.jumpTo>>;
    await act0(async () => {
      jump = await w.result.current.jumpTo(ids[1]);
    });
    expect(jump).toMatchObject({ ok: true, steps: 3, direction: "undo", error: null });
    expect(jump.edits.map((e) => e.label)).toEqual(["m4", "m3", "m2"]);
    expect(capture(w)).toEqual(snapshots[2]);
    expect(w.result.current.historyPosition).toBe(2);
    expect(w.result.current.historyEntries.map((e) => e.applied)).toEqual([true, true, false, false, false]);

    await act0(async () => {
      jump = await w.result.current.jumpTo(ids[4]);
    });
    expect(jump).toMatchObject({ ok: true, steps: 3, direction: "redo" });
    expect(capture(w)).toEqual(snapshots[5]);

    await act0(async () => {
      jump = await w.result.current.jumpTo(null);
    });
    expect(jump).toMatchObject({ ok: true, steps: 5, direction: "undo" });
    expect(capture(w)).toEqual(initial);
    expect(w.result.current.geometryDirty).toBe(false);
  });

  it("saltar a donde ya está no hace nada; un id que ya no existe devuelve un error sin mover el puntero", async () => {
    const w = await setup();
    await act0(() => void w.result.current.applyEdit(cmd("uno"), moveIds(["a1"], 1)));
    const [entry] = w.result.current.historyEntries;
    let jump = { ok: false } as Awaited<ReturnType<typeof w.result.current.jumpTo>>;
    await act0(async () => {
      jump = await w.result.current.jumpTo(entry.command.id);
    });
    expect(jump).toMatchObject({ ok: true, steps: 0, direction: null });
    await act0(async () => {
      jump = await w.result.current.jumpTo("no-existe");
    });
    expect(jump.ok).toBe(false);
    expect(jump.error).toMatch(/ya no está/);
    expect(w.result.current.historyPosition).toBe(1);
  });

  it("no se puede saltar con un gesto en curso", async () => {
    const w = await setup();
    await act0(() => void w.result.current.applyEdit(cmd("uno"), moveIds(["a1"], 1)));
    await act0(() => void w.result.current.beginGesture());
    let jump = { ok: true } as Awaited<ReturnType<typeof w.result.current.jumpTo>>;
    await act0(async () => {
      jump = await w.result.current.jumpTo(null);
    });
    expect(jump.ok).toBe(false);
    expect(w.result.current.historyPosition).toBe(1);
  });
});

/**
 * Las 60 acciones mixtas: objetos (movimientos), marco (crops), estructura de capas (Fill con un color nuevo = capa nueva) y metadata (renombrar una capa del
 * servidor, mostrar/ocultar otra y renombrar una capa nueva). Cada paso agrega EXACTAMENTE una entrada al historial.
 */
describe("useEditableDocument — 60 acciones mixtas, hacia atrás y hacia adelante, estado EXACTO", () => {
  beforeEach(() => {
    installFetch();
  });
  afterEach(() => vi.unstubAllGlobals());

  const hexFor = (index: number) => `#00${(index + 16).toString(16).padStart(2, "0")}${(index * 3 + 7).toString(16).padStart(2, "0")}`;
  const KIND_NAMES = ["mover", "crop", "fill con un color nuevo (capa nueva)", "renombrar capa del servidor", "mostrar/ocultar capa del servidor", "renombrar capa nueva"];

  it("recorre 60 acciones: cada una suma UNA entrada; deshacer de a una recupera cada estado y el inicial EXACTO; rehacer vuelve a cada estado; saltos intermedios", async () => {
    const w = await setup();
    const initial = capture(w);
    const states = [initial];

    // El rename del servidor necesita conocer el nombre vigente: el persistidor simulado lo lleva, el test lo reproduce.
    const renames: string[] = ["Azul"];
    for (let index = 0; index < 60; index += 1) {
      const kind = index % 6;
      w.time.tick(5);
      const before = w.result.current.historyPosition;
      await act0(async () => {
        if (kind === 3) {
          const previous = renames[renames.length - 1];
          const next = `Azul ${index}`;
          renames.push(next);
          await w.result.current.commitLayerMeta({ kind: "rename", groupId: "B", layerName: previous, before: previous, after: next });
        } else if (kind === 4) {
          const visible = w.server.B.visible;
          await w.result.current.commitLayerMeta({ kind: "visible", groupId: "B", layerName: w.server.B.name, before: visible, after: !visible });
        } else if (kind === 0) {
          w.result.current.applyEdit({ type: "object.move", parameters: { dx: 1 + (index % 5), dy: 0 } }, moveIds(["a1"], 1 + (index % 5)));
        } else if (kind === 1) {
          const target = { x: 0, y: 0, width: 320 - index, height: 240 - index };
          w.result.current.applyEdit({ type: "document.crop", parameters: { ...target, removeOutside: false } }, (state) => cropProduction(state, target, false));
        } else if (kind === 2) {
          const hex = hexFor(index);
          w.result.current.applyEdit({ type: "object.fill", parameters: { newColorHex: hex } }, (state) => planRecolor("selection", state, { target: { kind: "new", hex, groupId: `new-${index}` }, objectIds: new Set(["a2"]) }).production);
        } else {
          const created = w.result.current.committedLayers.find((candidate) => candidate.groupId === "new-2")!;
          await w.result.current.commitLayerMeta({ kind: "rename", groupId: "new-2", layerName: created.name, before: created.name, after: `Mi color ${index}` });
        }
      });
      expect(w.result.current.historyPosition, `la acción ${index} (${KIND_NAMES[kind]}) debe registrar UNA entrada`).toBe(before + 1);
      states.push(capture(w));
    }
    expect(w.result.current.historyEntries).toHaveLength(60);
    expect(w.result.current.undoDepth).toBe(60);
    // Los tipos de comando de la secuencia son los esperados (objetos, marco, estructura y metadata).
    const types = new Set(w.result.current.historyEntries.map((e) => e.command.type));
    expect([...types].sort()).toEqual(["document.crop", "layer.rename", "layer.setVisible", "object.fill", "object.move"]);
    expect(w.result.current.historyEntries.filter((entry) => entry.command.type === "layer.rename")).toHaveLength(20);
    // Cada comando es JSON puro y pasa el lector estricto.
    for (const entry of w.result.current.historyEntries) expect(parseCommand(JSON.stringify(entry.command)).ok).toBe(true);

    // ---- hacia atrás, de a una ----
    for (let index = 59; index >= 0; index -= 1) {
      await act0(async () => void w.result.current.undo());
      // El undo de metadata de capa es asíncrono: se espera a que el puntero se mueva.
      await waitFor(() => expect(w.result.current.historyPosition).toBe(index));
      expect(capture(w), `tras deshacer la acción ${index}`).toEqual(states[index]);
    }
    expect(capture(w)).toEqual(initial);
    expect(w.result.current.geometryDirty).toBe(false);
    expect(w.result.current.canUndo).toBe(false);

    // ---- hacia adelante, de a una ----
    for (let index = 0; index < 60; index += 1) {
      await act0(async () => void w.result.current.redo());
      await waitFor(() => expect(w.result.current.historyPosition).toBe(index + 1));
      expect(capture(w), `tras rehacer la acción ${index}`).toEqual(states[index + 1]);
    }
    expect(w.result.current.canRedo).toBe(false);

    // ---- saltos a posiciones intermedias (atrás y adelante, cruzando todos los tipos) ----
    const ids = w.result.current.historyEntries.map((e) => e.command.id);
    for (const position of [30, 7, 44, 12, 59, 0, 33, 60]) {
      await act0(async () => {
        const jump = await w.result.current.jumpTo(position === 0 ? null : ids[position - 1]);
        expect(jump.error).toBeNull();
        expect(jump.ok).toBe(true);
      });
      expect(w.result.current.historyPosition).toBe(position);
      expect(capture(w), `tras saltar a la posición ${position}`).toEqual(states[position]);
    }
  });
});

describe("useEditableDocument — metadata de capa dentro del historial (PATCH inverso)", () => {
  beforeEach(() => {
    installFetch();
  });
  afterEach(() => vi.unstubAllGlobals());

  const rename: LayerMetaChange = { kind: "rename", groupId: "B", layerName: "Azul", before: "Azul", after: "Cielo" };

  it("commitLayerMeta persiste (redo, optimista) y SOLO entonces registra el comando layer.rename; deshacer y rehacer re-persisten (no optimista)", async () => {
    const w = await setup();
    let committed = { status: "failed" } as Awaited<ReturnType<typeof w.result.current.commitLayerMeta>>;
    await act0(async () => {
      committed = await w.result.current.commitLayerMeta(rename);
    });
    expect(committed.status).toBe("ok");
    expect(w.calls).toEqual([{ change: rename, direction: "redo", optimistic: true }]);
    expect(w.server.B.name).toBe("Cielo");
    expect(w.result.current.undoCommand).toMatchObject({ type: "layer.rename", label: "Renombrar la capa «Azul» a «Cielo»", targets: { layerIds: ["B"], objectIds: [] }, parameters: { from: "Azul", to: "Cielo" } });
    // Sin geometría: renombrar una capa no es una edición de geometría.
    expect(w.result.current.geometryDirty).toBe(false);

    await act0(async () => void w.result.current.undo());
    await waitFor(() => expect(w.result.current.historyPosition).toBe(0));
    expect(w.calls[1]).toEqual({ change: rename, direction: "undo", optimistic: false });
    expect(w.server.B.name).toBe("Azul");

    await act0(async () => void w.result.current.redo());
    await waitFor(() => expect(w.result.current.historyPosition).toBe(1));
    expect(w.calls[2]).toEqual({ change: rename, direction: "redo", optimistic: false });
    expect(w.server.B.name).toBe("Cielo");
    expect(w.calls).toHaveLength(3);
  });

  it("PATCH original que falla: no se registra nada, queda el error visible y la pila no se mueve", async () => {
    const w = await setup();
    w.failNext = { error: "El servidor no respondió." };
    let committed = { status: "ok" } as Awaited<ReturnType<typeof w.result.current.commitLayerMeta>>;
    await act0(async () => {
      committed = await w.result.current.commitLayerMeta(rename);
    });
    expect(committed).toEqual({ status: "failed", error: "El servidor no respondió." });
    expect(w.result.current.historyEntries).toEqual([]);
    expect(w.result.current.historyError).toBe("El servidor no respondió.");
    await act0(() => w.result.current.dismissHistoryError());
    expect(w.result.current.historyError).toBeNull();
  });

  it("PATCH INVERSO que falla: estado local intacto, el puntero NO se mueve, error visible; reintentar funciona", async () => {
    const w = await setup();
    await act0(async () => void (await w.result.current.commitLayerMeta(rename)));
    await act0(() => void w.result.current.applyEdit(cmd("mover"), moveIds(["a1"], 5)));
    const before = capture(w);

    // Se deshace primero lo geométrico (síncrono) y luego el rename falla al deshacerse.
    await act0(async () => void w.result.current.undo());
    const afterGeometryUndo = capture(w);
    expect(afterGeometryUndo.snapshot).not.toEqual(before.snapshot);
    w.failNext = { error: "PATCH rechazado (503)." };
    await act0(async () => void w.result.current.undo());
    await waitFor(() => expect(w.result.current.historyError).toBe("PATCH rechazado (503)."));
    expect(w.result.current.historyPosition).toBe(1);
    expect(w.server.B.name).toBe("Cielo");
    expect(capture(w)).toEqual(afterGeometryUndo);
    expect(w.result.current.canUndo).toBe(true);
    expect(w.result.current.historyBusy).toBe(false);

    // Reintentar: el mismo PATCH inverso, ahora sí.
    await act0(async () => void w.result.current.undo());
    await waitFor(() => expect(w.result.current.historyPosition).toBe(0));
    expect(w.result.current.historyError).toBeNull();
    expect(w.server.B.name).toBe("Azul");
    expect(w.calls.map((c) => c.direction)).toEqual(["redo", "undo", "undo"]);
  });

  it("mientras un PATCH inverso está en vuelo, undo/redo quedan deshabilitados, no se puede editar ni saltar, y al terminar se recupera todo", async () => {
    const w = await setup();
    await act0(async () => void (await w.result.current.commitLayerMeta(rename)));
    await act0(async () => void (await w.result.current.commitLayerMeta({ kind: "locked", groupId: "B", layerName: "Cielo", before: false, after: true })));

    w.gate.hold = true;
    await act0(async () => void w.result.current.undo());
    await waitFor(() => expect(w.result.current.historyBusy).toBe(true));
    expect(w.result.current.canUndo).toBe(false);
    expect(w.result.current.canRedo).toBe(false);
    // Una operación a la vez: otro undo no dispara un segundo PATCH, editar se rechaza y saltar también.
    await act0(async () => void w.result.current.undo());
    expect(w.calls.filter((c) => c.direction === "undo")).toHaveLength(1);
    let edit = { applied: true } as ReturnType<typeof w.result.current.applyEdit>;
    await act0(() => {
      edit = w.result.current.applyEdit(cmd("durante el PATCH"), moveIds(["a1"], 5));
    });
    expect(edit).toMatchObject({ applied: false, reason: "history_busy" });
    let jump = { ok: true } as Awaited<ReturnType<typeof w.result.current.jumpTo>>;
    await act0(async () => {
      jump = await w.result.current.jumpTo(null);
    });
    expect(jump.ok).toBe(false);
    expect(w.result.current.beginGesture()).toBe(false);
    let busy = { status: "ok" } as Awaited<ReturnType<typeof w.result.current.commitLayerMeta>>;
    await act0(async () => {
      busy = await w.result.current.commitLayerMeta(rename);
    });
    expect(busy.status).toBe("busy");

    w.gate.hold = false;
    await act0(async () => w.gate.release?.());
    await waitFor(() => expect(w.result.current.historyBusy).toBe(false));
    expect(w.result.current.historyPosition).toBe(1);
    expect(w.result.current.canUndo).toBe(true);
    expect(w.result.current.canRedo).toBe(true);
    expect(w.server.B.locked).toBe(false);
  });

  it("un cambio ORIGINAL en vuelo también deshabilita undo/redo (no se pueden pisar dos escrituras de metadata)", async () => {
    const w = await setup();
    await act0(() => void w.result.current.applyEdit(cmd("mover"), moveIds(["a1"], 5)));
    w.gate.hold = true;
    let promise: Promise<unknown> = Promise.resolve();
    await act0(() => {
      promise = w.result.current.commitLayerMeta(rename);
    });
    await waitFor(() => expect(w.result.current.historyBusy).toBe(true));
    expect(w.result.current.canUndo).toBe(false);
    await act0(async () => void w.result.current.undo());
    expect(w.result.current.historyPosition).toBe(1);

    w.gate.hold = false;
    await act0(async () => {
      w.gate.release?.();
      await promise;
    });
    expect(w.result.current.historyBusy).toBe(false);
    expect(w.result.current.historyPosition).toBe(2);
  });

  it("jumpTo cruza metadata: espera cada PATCH inverso y se DETIENE en el primer fallo (puntero donde llegó, error visible)", async () => {
    const w = await setup();
    await act0(() => void w.result.current.applyEdit(cmd("m0"), moveIds(["a1"], 1)));
    await act0(async () => void (await w.result.current.commitLayerMeta({ kind: "visible", groupId: "B", layerName: "Azul", before: true, after: false })));
    await act0(async () => void (await w.result.current.commitLayerMeta(rename)));
    await act0(() => void w.result.current.applyEdit(cmd("m3"), moveIds(["a1"], 1)));
    expect(w.result.current.historyPosition).toBe(4);

    // Al deshacer el rename (paso 3) falla: el salto a 0 se detiene ahí, con m3 ya deshecho.
    w.calls.length = 0;
    let jump = { ok: true } as Awaited<ReturnType<typeof w.result.current.jumpTo>>;
    // La primera llamada de undo es la del RENAME (m3 es geometría: no pasa por el persistidor).
    w.failNext = { error: "sin red" };
    await act0(async () => {
      jump = await w.result.current.jumpTo(null);
    });
    expect(jump).toMatchObject({ ok: false, steps: 1, direction: "undo", error: "sin red" });
    expect(w.result.current.historyPosition).toBe(3);
    expect(w.server.B.name).toBe("Cielo");

    // Sin fallo, ahora sí llega al inicio pasando por los dos cambios de metadata.
    await act0(async () => {
      jump = await w.result.current.jumpTo(null);
    });
    expect(jump).toMatchObject({ ok: true, steps: 3, direction: "undo" });
    expect(w.server.B).toMatchObject({ name: "Azul", visible: true });
    expect(w.calls.filter((c) => c.direction === "undo").map((c) => c.change.kind)).toEqual(["rename", "rename", "visible"]);
  });

  it("recordLayerMeta registra sin persistir (útil si el cambio ya se aplicó); sin persistidor, commitLayerMeta falla con un mensaje claro", async () => {
    const hook = renderHook(() => useEditableDocument(LAYERS, {}));
    await waitFor(() => expect(hook.result.current.layerStatus.A).toBe("ready"));
    let command = null as EditorCommand | null;
    await act0(() => {
      command = hook.result.current.recordLayerMeta({ kind: "operation", groupId: "A", layerName: "Rojo", before: "cut", after: "engrave" });
    });
    expect(command).toMatchObject({ type: "layer.setOperation", parameters: { operation: "engrave", previous: "cut" } });
    let result = { status: "ok" } as Awaited<ReturnType<typeof hook.result.current.commitLayerMeta>>;
    await act0(async () => {
      result = await hook.result.current.commitLayerMeta({ kind: "locked", groupId: "A", layerName: "Rojo", before: false, after: true });
    });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/no puede persistir/);
    expect(hook.result.current.historyEntries).toHaveLength(1);
  });

  it("un persistidor que LANZA se convierte en un fallo recuperable (nunca una excepción sin atrapar)", async () => {
    const persist: PersistLayerMeta = async () => {
      throw new Error("explotó");
    };
    const hook = renderHook(() => useEditableDocument(LAYERS, { persistLayerMeta: persist }));
    await waitFor(() => expect(hook.result.current.layerStatus.A).toBe("ready"));
    let result = { status: "ok" } as Awaited<ReturnType<typeof hook.result.current.commitLayerMeta>>;
    await act0(async () => {
      result = await hook.result.current.commitLayerMeta(rename);
    });
    expect(result).toEqual({ status: "failed", error: "explotó" });
    expect(hook.result.current.historyError).toBe("explotó");
  });

  it("noop del persistidor (el valor ya era ese) no registra nada", async () => {
    const persist: PersistLayerMeta = async () => ({ ok: true, noop: true });
    const hook = renderHook(() => useEditableDocument(LAYERS, { persistLayerMeta: persist }));
    await waitFor(() => expect(hook.result.current.layerStatus.A).toBe("ready"));
    let result = { status: "ok" } as Awaited<ReturnType<typeof hook.result.current.commitLayerMeta>>;
    await act0(async () => {
      result = await hook.result.current.commitLayerMeta(rename);
    });
    expect(result.status).toBe("noop");
    expect(hook.result.current.historyEntries).toEqual([]);
  });
});

describe("useEditableDocument — comandos tipados: ningún camino registra sin descriptor", () => {
  beforeEach(() => {
    installFetch();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("el borrador sin tipo (JS puro) falla; el comando registrado conserva el origen y sigue siendo serializable", async () => {
    const w = await setup();
    const draft = { label: "sin tipo" } as unknown as CommandDraft;
    expect(() => w.result.current.applyEdit(draft, moveIds(["a1"], 1))).toThrow();
    expect(() => w.result.current.commitGesture(draft)).not.toThrow(); // sin gesto activo no hay nada que cerrar
    await act0(() => void w.result.current.applyEdit({ type: "object.move", origin: "ai", parameters: { dx: 1, dy: 0 } }, moveIds(["a1"], 1)));
    expect(JSON.parse(JSON.stringify(w.result.current.exportHistory())).commands[0].origin).toBe("ai");
  });
});
