import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { abortAwareFetch } from "../test/abortableFetch";
import { useManufacturingOperations } from "./useManufacturingOperations";
import { useVectorDocument } from "./useVectorDocument";

/**
 * Las escrituras de metadata de capa que usa el historial (M3-S12): valor explícito (no toggle), con o sin escritura optimista, respuesta awaitable
 * (`ok` / `noop` / `failed`), lectura FRESCA de las capas (`getLayers`) y el mismo PATCH que originó el cambio. Los toggles históricos siguen devolviendo void.
 */

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const IMAGE_ID = "22222222-2222-2222-2222-222222222222";
const PALETTE_ID = "33333333-3333-3333-3333-333333333333";
const SAVED = "99999999-9999-9999-9999-999999999999";
const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const API = "http://localhost:5080";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

interface Fake {
  id: string;
  name: string;
  order: number;
  visible: boolean;
  locked: boolean;
  op: string;
}

function savedLayer(layer: Fake) {
  return { id: layer.id, name: layer.name, order: layer.order, visible: layer.visible, locked: layer.locked, manufacturingOperation: layer.op, colorHex: layer.id === A ? "#ff0000" : "#0000ff", coverage: 50, isBackground: false, svgAssetId: null, svgUrl: null, pathCount: 1 };
}

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown> | undefined;
}

/** Servidor guardado (PATCH v2) con estado; `fail` hace fallar la próxima escritura que cumpla el predicado. */
function savedServer() {
  const layers: Fake[] = [
    { id: A, name: "Rojo", order: 0, visible: true, locked: false, op: "cut" },
    { id: B, name: "Azul", order: 1, visible: true, locked: false, op: "unassigned" },
  ];
  const calls: Call[] = [];
  const control = { fail: null as null | ((call: Call) => boolean), hold: null as null | Promise<void> };
  const fetchMock = abortAwareFetch(async (url, init) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url.includes(`/api/v2/projects/${SAVED}/document`)) {
      return json({ projectId: SAVED, schemaVersion: 1, widthMm: 160, heightMm: 120, viewBox: "0 0 320 240", versionNumber: 1, createdAt: "2026-01-01T00:00:00Z", layers: [...layers].sort((x, y) => x.order - y.order).map(savedLayer) });
    }
    const call: Call = { method, url, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined };
    calls.push(call);
    if (control.hold) await control.hold;
    if (control.fail?.(call)) {
      control.fail = null;
      return json({ code: "internal_error", message: "boom" }, 500);
    }
    const match = /\/layers\/([0-9a-f-]+)$/.exec(url);
    if (method === "PATCH" && match) {
      const layer = layers.find((candidate) => candidate.id === match[1])!;
      const body = call.body ?? {};
      if (typeof body.name === "string") layer.name = body.name;
      if (typeof body.order === "number") layer.order = body.order;
      if (typeof body.visible === "boolean") layer.visible = body.visible;
      if (typeof body.locked === "boolean") layer.locked = body.locked;
      if (typeof body.manufacturingOperation === "string") layer.op = body.manufacturingOperation;
      return json(savedLayer(layer));
    }
    return json({ code: "not_found" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls, control, layers };
}

async function savedHook(trackPatch?: (promise: Promise<unknown>) => void) {
  const server = savedServer();
  const hook = renderHook(() => useVectorDocument(PROJECT_ID, IMAGE_ID, PALETTE_ID, SAVED, trackPatch));
  await waitFor(() => expect(hook.result.current.status).toBe("ready"));
  return { ...hook, server };
}

const layerOf = (hook: Awaited<ReturnType<typeof savedHook>>, id: string) => hook.result.current.document!.layers.find((layer) => layer.groupId === id)!;

describe("useVectorDocument — setLayerProp (valor explícito, awaitable) con un proyecto guardado", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sin optimismo: NO toca el estado local hasta que el PATCH confirma; el PATCH es el mismo (método, URL y cuerpo) y trackPatch recibe su promesa", async () => {
    const trackPatch = vi.fn();
    const hook = await savedHook(trackPatch);
    let release!: () => void;
    hook.server.control.hold = new Promise<void>((resolve) => (release = resolve));

    let status = null as unknown as Promise<string>;
    act(() => {
      status = hook.result.current.setLayerProp(A, "name", "Carmín", { optimistic: false });
    });
    await waitFor(() => expect(hook.server.calls).toHaveLength(1));
    // En vuelo: la UI sigue mostrando el valor viejo (no hay optimismo que revertir si falla).
    expect(layerOf(hook, A).name).toBe("Rojo");
    expect(hook.result.current.getLayers().find((layer) => layer.groupId === A)?.name).toBe("Rojo");

    hook.server.control.hold = null;
    await act(async () => {
      release();
      expect(await status).toBe("ok");
    });
    expect(layerOf(hook, A).name).toBe("Carmín");
    expect(hook.server.calls).toEqual([{ method: "PATCH", url: `${API}/api/v2/projects/${SAVED}/layers/${A}`, body: { name: "Carmín" } }]);
    expect(trackPatch).toHaveBeenCalledTimes(1);
    expect(trackPatch.mock.calls[0][0]).toBeInstanceOf(Promise);
    expect(hook.server.fetchMock.signals.filter((signal) => signal?.aborted)).toHaveLength(0);
  });

  it("sin optimismo y el PATCH falla: devuelve 'failed' y el estado nunca cambió", async () => {
    const hook = await savedHook();
    hook.server.control.fail = () => true;
    let status = "";
    await act(async () => {
      status = await hook.result.current.setLayerProp(A, "locked", true, { optimistic: false });
    });
    expect(status).toBe("failed");
    expect(layerOf(hook, A).locked).toBe(false);
    expect(hook.server.layers[0].locked).toBe(false);
  });

  it("con optimismo (default): se ve de inmediato y, si el PATCH falla, se REVIERTE una sola vez", async () => {
    const hook = await savedHook();
    hook.server.control.fail = () => true;
    let promise = null as unknown as Promise<string>;
    act(() => {
      promise = hook.result.current.setLayerProp(B, "visible", false);
    });
    expect(layerOf(hook, B).visible).toBe(false);
    await act(async () => {
      expect(await promise).toBe("failed");
    });
    expect(layerOf(hook, B).visible).toBe(true);
  });

  it("valor que la capa ya tiene (o nombre vacío) = 'noop' SIN pedir nada; capa inexistente = 'failed'", async () => {
    const hook = await savedHook();
    await act(async () => {
      expect(await hook.result.current.setLayerProp(A, "visible", true)).toBe("noop");
      expect(await hook.result.current.setLayerProp(A, "name", "Rojo")).toBe("noop");
      expect(await hook.result.current.setLayerProp(A, "name", "   ")).toBe("noop");
      expect(await hook.result.current.setLayerProp("no-existe", "locked", true)).toBe("failed");
    });
    expect(hook.server.calls).toHaveLength(0);
  });

  it("el nombre se recorta antes de escribirse", async () => {
    const hook = await savedHook();
    await act(async () => {
      expect(await hook.result.current.setLayerProp(A, "name", "  Carmín  ", { optimistic: false })).toBe("ok");
    });
    expect(hook.server.calls[0].body).toEqual({ name: "Carmín" });
  });

  it("getLayers() lee el estado FRESCO aun antes de que React vuelva a renderizar: dos escrituras encadenadas se ven una a la otra", async () => {
    const hook = await savedHook();
    await act(async () => {
      void hook.result.current.setLayerProp(A, "name", "Uno");
      // Sin esperar el render: el espejo síncrono ya refleja la escritura optimista.
      expect(hook.result.current.getLayers().find((layer) => layer.groupId === A)?.name).toBe("Uno");
      expect(await hook.result.current.setLayerProp(A, "name", "Dos", { optimistic: false })).toBe("ok");
      expect(hook.result.current.getLayers().find((layer) => layer.groupId === A)?.name).toBe("Dos");
    });
    expect(layerOf(hook, A).name).toBe("Dos");
  });

  it("los toggles históricos siguen siendo fire-and-forget (devuelven void) y optimistas", async () => {
    const hook = await savedHook();
    let returned: unknown = "x";
    act(() => {
      returned = hook.result.current.toggleLocked(A);
    });
    expect(returned).toBeUndefined();
    expect(layerOf(hook, A).locked).toBe(true);
    await waitFor(() => expect(hook.server.calls).toHaveLength(1));
    expect(hook.server.calls[0].body).toEqual({ locked: true });
  });
});

describe("useVectorDocument — setLayerOrder (orden completo, awaitable)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sin optimismo: un PATCH {order} por capa que cambió, estado local intacto hasta que todos confirman, y getLayers() queda en el orden pedido", async () => {
    const hook = await savedHook();
    let release!: () => void;
    hook.server.control.hold = new Promise<void>((resolve) => (release = resolve));
    let status = null as unknown as Promise<string>;
    act(() => {
      status = hook.result.current.setLayerOrder([B, A], { optimistic: false });
    });
    await waitFor(() => expect(hook.server.calls).toHaveLength(2));
    expect(hook.result.current.getLayers().map((layer) => layer.groupId)).toEqual([A, B]);
    hook.server.control.hold = null;
    await act(async () => {
      release();
      expect(await status).toBe("ok");
    });
    expect(hook.result.current.getLayers().map((layer) => layer.groupId)).toEqual([B, A]);
    expect(hook.server.calls.map((call) => [call.url.split("/").pop(), call.body])).toEqual([
      [B, { order: 0 }],
      [A, { order: 1 }],
    ]);
  });

  it("una lista que no coincide con las capas del documento se rechaza ('failed') sin pedir nada", async () => {
    const hook = await savedHook();
    await act(async () => {
      expect(await hook.result.current.setLayerOrder([A])).toBe("failed");
      expect(await hook.result.current.setLayerOrder([A, "otra"])).toBe("failed");
    });
    expect(hook.server.calls).toHaveLength(0);
  });

  it("si un PATCH del orden falla, sin optimismo no queda nada cambiado; con optimismo se revierte el orden visual", async () => {
    const hook = await savedHook();
    hook.server.control.fail = () => true;
    await act(async () => {
      expect(await hook.result.current.setLayerOrder([B, A], { optimistic: false })).toBe("failed");
    });
    expect(hook.result.current.getLayers().map((layer) => layer.groupId)).toEqual([A, B]);

    hook.server.control.fail = () => true;
    let promise = null as unknown as Promise<string>;
    act(() => {
      promise = hook.result.current.setLayerOrder([B, A]);
    });
    expect(hook.result.current.getLayers().map((layer) => layer.groupId)).toEqual([B, A]);
    await act(async () => {
      expect(await promise).toBe("failed");
    });
    expect(hook.result.current.getLayers().map((layer) => layer.groupId)).toEqual([A, B]);
  });

  it("reorderLayers (histórico) sigue siendo void y optimista", async () => {
    const hook = await savedHook();
    let returned: unknown = "x";
    act(() => {
      returned = hook.result.current.reorderLayers([B, A]);
    });
    expect(returned).toBeUndefined();
    expect(hook.result.current.getLayers().map((layer) => layer.groupId)).toEqual([B, A]);
    await waitFor(() => expect(hook.server.calls).toHaveLength(2));
  });
});

describe("useVectorDocument — sin guardar: setLayerProp usa los sidecars clásicos", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("bloquear sin optimismo: POST …/lock con {locked}; el estado cambia solo con la respuesta autoritativa", async () => {
    const validation = { ownMismatchRatio: 0, ownMismatchTolerance: 0.02, ownMismatchWithinTolerance: true, contaminationRatio: 0, contaminationTolerance: 0.02, contaminationWithinTolerance: true, warnings: [] };
    const calls: Call[] = [];
    const fetchMock = abortAwareFetch((url, init) => {
      const method = init?.method ?? "GET";
      if (method === "POST") {
        calls.push({ method, url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return json({ entries: [{ groupId: A, order: 0, visible: true, locked: true, name: null }, { groupId: B, order: 1, visible: true, locked: false, name: null }] });
      }
      if (url.includes("/layers/consolidated")) {
        return json({
          projectId: PROJECT_ID, imageId: IMAGE_ID, layerSetId: "ls", version: 1, paletteId: PALETTE_ID, paletteVersion: 2, sourceWidthPx: 320, sourceHeightPx: 240,
          layers: [A, B].map((id, index) => ({ id, name: index === 0 ? "Rojo" : "Azul", colorHex: "#ff0000", fill: "#ff0000", vectorId: `v${index}`, svgUrl: `/vectors/v${index}`, pathCount: 1, componentCount: null, manufacturingOperation: "cut", visible: true, locked: false, order: index, rasterValidation: validation })),
        });
      }
      if (/\/layers$/.test(url)) {
        return json({ projectId: PROJECT_ID, imageId: IMAGE_ID, layerSetId: "ls", version: 1, paletteId: PALETTE_ID, paletteVersion: 2, sourceWidthPx: 320, sourceHeightPx: 240, layers: [A, B].map((id, index) => ({ groupId: id, name: index === 0 ? "Rojo" : "Azul", colorHex: "#ff0000", areaPercent: 50, hasPartialAlpha: false, vectorId: `v${index}`, svgUrl: `/vectors/v${index}` })), cached: true });
      }
      if (url.endsWith(`/color-palette/${PALETTE_ID}`)) {
        return json({ projectId: PROJECT_ID, imageId: IMAGE_ID, paletteId: PALETTE_ID, version: 2, tolerance: 24, maxColors: null, tinyAreaRatio: 0.01, sourceWidthPx: 320, sourceHeightPx: 240, transparentPercent: 0, groups: [], previewUrl: "/p", isConfirmed: true, cached: false });
      }
      return json({ code: "not_found" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const hook = renderHook(() => useVectorDocument(PROJECT_ID, IMAGE_ID, PALETTE_ID));
    await waitFor(() => expect(hook.result.current.status).toBe("ready"));

    let status = "";
    await act(async () => {
      const promise = hook.result.current.setLayerProp(A, "locked", true, { optimistic: false });
      expect(hook.result.current.document!.layers[0].locked).toBe(false);
      status = await promise;
    });
    expect(status).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(new RegExp(`/layers/${A}/lock$`));
    expect(calls[0].body).toEqual({ locked: true });
    expect(hook.result.current.document!.layers[0].locked).toBe(true);
  });
});

describe("useManufacturingOperations — assignOperation (awaitable, para el historial)", () => {
  afterEach(() => vi.unstubAllGlobals());

  const opResponse = (operation: string) => ({
    projectId: PROJECT_ID, imageId: IMAGE_ID, paletteId: PALETTE_ID, paletteVersion: 2, layerSetId: "ls", version: 1,
    operations: [{ groupId: A, name: "Rojo", colorHex: "#ff0000", operation }],
    summary: { cutCount: 1, engraveCount: 0, ignoreCount: 0, unassignedCount: 0, totalCount: 1 },
  });

  it("proyecto guardado: acepta «unassigned» (vacía la asignación) con el PATCH v2 y devuelve 'ok'", async () => {
    const server = savedServer();
    const hook = renderHook(() => useManufacturingOperations(PROJECT_ID, IMAGE_ID, PALETTE_ID, "ls", SAVED));
    let status = "";
    await act(async () => {
      status = await hook.result.current.assignOperation(A, "unassigned");
    });
    expect(status).toBe("ok");
    expect(server.calls).toEqual([{ method: "PATCH", url: `${API}/api/v2/projects/${SAVED}/layers/${A}`, body: { manufacturingOperation: "unassigned" } }]);
    expect(hook.result.current.operations[A]?.operation).toBe("unassigned");
  });

  it("sin guardar: «unassigned» NO existe en el sidecar clásico: 'failed' con el motivo y SIN request", async () => {
    const fetchMock = abortAwareFetch(() => json(opResponse("cut")));
    vi.stubGlobal("fetch", fetchMock);
    const hook = renderHook(() => useManufacturingOperations(PROJECT_ID, IMAGE_ID, PALETTE_ID, "ls"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled()); // la carga inicial de operaciones
    fetchMock.mockClear();
    let status = "";
    await act(async () => {
      status = await hook.result.current.assignOperation(A, "unassigned");
    });
    expect(status).toBe("failed");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(hook.result.current.errorMessage).toMatch(/no se puede volver a «sin asignar»/);
  });

  it("sin guardar: una asignación real hace POST …/operation y 'ok'; un error de la Web API da 'failed' y queda el mensaje; sin paleta es 'noop'", async () => {
    const calls: Call[] = [];
    let failing = false;
    const fetchMock = abortAwareFetch((url, init) => {
      if (init?.method === "POST") {
        calls.push({ method: "POST", url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return failing ? json({ code: "internal_error", message: "falló" }, 500) : json(opResponse("engrave"));
      }
      return json(opResponse("cut"));
    });
    vi.stubGlobal("fetch", fetchMock);
    const hook = renderHook(() => useManufacturingOperations(PROJECT_ID, IMAGE_ID, PALETTE_ID, "ls"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    let status = "";
    await act(async () => {
      status = await hook.result.current.assignOperation(A, "engrave");
    });
    expect(status).toBe("ok");
    expect(calls[0].url).toMatch(new RegExp(`/layers/${A}/operation$`));
    expect(calls[0].body).toEqual({ operation: "engrave" });

    failing = true;
    await act(async () => {
      status = await hook.result.current.assignOperation(A, "ignore");
    });
    expect(status).toBe("failed");
    expect(hook.result.current.errorCode).toBe("internal_error");

    const noPalette = renderHook(() => useManufacturingOperations(PROJECT_ID, IMAGE_ID, null, null));
    await act(async () => {
      expect(await noPalette.result.current.assignOperation(A, "cut")).toBe("noop");
    });
  });

  it("assign (histórico) sigue siendo void", async () => {
    const server = savedServer();
    const hook = renderHook(() => useManufacturingOperations(PROJECT_ID, IMAGE_ID, PALETTE_ID, "ls", SAVED));
    let returned: unknown = "x";
    act(() => {
      returned = hook.result.current.assign(A, "engrave");
    });
    expect(returned).toBeUndefined();
    await waitFor(() => expect(server.calls).toHaveLength(1));
  });
});
