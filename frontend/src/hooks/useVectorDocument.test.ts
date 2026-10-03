import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useVectorDocument } from "./useVectorDocument";
import type { VectorDocumentLayerResponse } from "../types/vectorDocument";

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const IMAGE_ID = "22222222-2222-2222-2222-222222222222";
const PALETTE_ID = "33333333-3333-3333-3333-333333333333";
const GROUP_A_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const GROUP_B_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const VECTOR_A_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const VECTOR_B_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const LAYER_SET_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function paletteResponse(overrides: Record<string, unknown> = {}) {
  return {
    projectId: PROJECT_ID,
    imageId: IMAGE_ID,
    paletteId: PALETTE_ID,
    version: 2,
    tolerance: 24,
    maxColors: null,
    tinyAreaRatio: 0.01,
    sourceWidthPx: 320,
    sourceHeightPx: 240,
    transparentPercent: 0,
    groups: [
      { groupId: GROUP_A_ID, name: "Rojo", colorHex: "#ff0000", rgb: { r: 255, g: 0, b: 0 }, pixelCount: 100, areaPercent: 60, hasPartialAlpha: false, isExcluded: false, maskUrl: "/mask/a", isMerged: false },
      { groupId: GROUP_B_ID, name: "Azul", colorHex: "#0000ff", rgb: { r: 0, g: 0, b: 255 }, pixelCount: 60, areaPercent: 40, hasPartialAlpha: false, isExcluded: false, maskUrl: "/mask/b", isMerged: false },
    ],
    previewUrl: "/preview",
    isConfirmed: true,
    cached: false,
    ...overrides,
  };
}

function layerSetResponse(overrides: Record<string, unknown> = {}) {
  return {
    projectId: PROJECT_ID,
    imageId: IMAGE_ID,
    layerSetId: LAYER_SET_ID,
    version: 1,
    paletteId: PALETTE_ID,
    paletteVersion: 2,
    sourceWidthPx: 320,
    sourceHeightPx: 240,
    layers: [
      { groupId: GROUP_A_ID, name: "Rojo", colorHex: "#ff0000", areaPercent: 60, hasPartialAlpha: false, vectorId: VECTOR_A_ID, svgUrl: `/vectors/${VECTOR_A_ID}` },
      { groupId: GROUP_B_ID, name: "Azul", colorHex: "#0000ff", areaPercent: 40, hasPartialAlpha: false, vectorId: VECTOR_B_ID, svgUrl: `/vectors/${VECTOR_B_ID}` },
    ],
    cached: true,
    ...overrides,
  };
}

function consolidatedResponse(overrides: Record<string, unknown> = {}) {
  return {
    projectId: PROJECT_ID,
    imageId: IMAGE_ID,
    layerSetId: LAYER_SET_ID,
    version: 1,
    paletteId: PALETTE_ID,
    paletteVersion: 2,
    sourceWidthPx: 320,
    sourceHeightPx: 240,
    layers: [
      { id: GROUP_A_ID, name: "Rojo", colorHex: "#ff0000", fill: "#ff0000", vectorId: VECTOR_A_ID, svgUrl: `/vectors/${VECTOR_A_ID}`, pathCount: 3, componentCount: 1, manufacturingOperation: "cut", visible: true, locked: false, order: 0, rasterValidation: { ownMismatchRatio: 0, ownMismatchTolerance: 0.02, ownMismatchWithinTolerance: true, contaminationRatio: 0, contaminationTolerance: 0.02, contaminationWithinTolerance: true, warnings: [] } },
      { id: GROUP_B_ID, name: "Azul", colorHex: "#0000ff", fill: "#0000ff", vectorId: VECTOR_B_ID, svgUrl: `/vectors/${VECTOR_B_ID}`, pathCount: 2, componentCount: null, manufacturingOperation: "unassigned", visible: true, locked: false, order: 1, rasterValidation: { ownMismatchRatio: 0, ownMismatchTolerance: 0.02, ownMismatchWithinTolerance: true, contaminationRatio: 0, contaminationTolerance: 0.02, contaminationWithinTolerance: true, warnings: [] } },
    ],
    ...overrides,
  };
}

function stubFetchSequence(handlers: Array<(url: string) => Response>) {
  const fetch = vi.fn((input: string | URL, _init?: RequestInit) => {
    const url = String(input);
    for (const handler of handlers) {
      const result = handler(url);
      if (result) return Promise.resolve(result);
    }
    return Promise.reject(new Error(`Unhandled fetch: ${url}`));
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function stubHappyPath() {
  return stubFetchSequence([
    (url) => (url.includes("/layers/consolidated") ? jsonResponse(consolidatedResponse()) : undefined!),
    (url) => (/\/layers$/.test(url) ? jsonResponse(layerSetResponse()) : undefined!),
    (url) => (url.endsWith(`/color-palette/${PALETTE_ID}`) ? jsonResponse(paletteResponse()) : undefined!),
  ]);
}

describe("useVectorDocument — sin paletteId", () => {
  it("queda en estado 'empty' (no_palette_selected) sin pedir nada", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const { result } = renderHook(() => useVectorDocument(PROJECT_ID, IMAGE_ID, null));

    expect(result.current.status).toBe("empty");
    expect(result.current.emptyReason).toBe("no_palette_selected");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("useVectorDocument — proyecto multicolor (caso principal)", () => {
  it("agrega paleta confirmada + capas + consolidado en un único VectorDocument", async () => {
    stubHappyPath();

    const { result } = renderHook(() => useVectorDocument(PROJECT_ID, IMAGE_ID, PALETTE_ID));

    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(result.current.document?.layers).toHaveLength(2);
    expect(result.current.document?.layers[0]).toMatchObject({
      groupId: GROUP_A_ID,
      name: "Rojo",
      colorHex: "#ff0000",
      pathCount: 3,
      componentCount: 1,
      manufacturingOperation: "cut",
      areaPercent: 60,
    });
    expect(result.current.document?.layers[0].svgUrl).toBe(`http://localhost:5080/vectors/${VECTOR_A_ID}`);
    expect(result.current.visibility).toEqual({ [GROUP_A_ID]: true, [GROUP_B_ID]: true });
  });
});

describe("useVectorDocument — proyecto sin layers generadas", () => {
  it("queda en 'empty' (layers_not_generated) sin inventar capas", async () => {
    stubFetchSequence([
      (url) => (/\/layers$/.test(url) ? jsonResponse({ code: "not_found", message: "No existe un conjunto de capas generado para esa paleta." }, 404) : undefined!),
      (url) => (url.endsWith(`/color-palette/${PALETTE_ID}`) ? jsonResponse(paletteResponse()) : undefined!),
    ]);

    const { result } = renderHook(() => useVectorDocument(PROJECT_ID, IMAGE_ID, PALETTE_ID));

    await waitFor(() => expect(result.current.status).toBe("empty"));
    expect(result.current.emptyReason).toBe("layers_not_generated");
    expect(result.current.document).toBeNull();
  });
});

describe("useVectorDocument — paleta no confirmada", () => {
  it("queda en 'empty' (palette_not_confirmed), nunca pide el conjunto de capas", async () => {
    const fetch = stubFetchSequence([
      (url) => (url.endsWith(`/color-palette/${PALETTE_ID}`) ? jsonResponse(paletteResponse({ isConfirmed: false })) : undefined!),
    ]);

    const { result } = renderHook(() => useVectorDocument(PROJECT_ID, IMAGE_ID, PALETTE_ID));

    await waitFor(() => expect(result.current.status).toBe("empty"));
    expect(result.current.emptyReason).toBe("palette_not_confirmed");
    expect(fetch.mock.calls.some((call) => String(call[0]).match(/\/layers$/))).toBe(false);
  });
});

describe("useVectorDocument — error de carga", () => {
  it("paleta inexistente (404) -> 'empty' (palette_not_found), no 'error'", async () => {
    stubFetchSequence([
      (url) =>
        url.endsWith(`/color-palette/${PALETTE_ID}`)
          ? jsonResponse({ code: "not_found", message: "No existe." }, 404)
          : undefined!,
    ]);

    const { result } = renderHook(() => useVectorDocument(PROJECT_ID, IMAGE_ID, PALETTE_ID));

    await waitFor(() => expect(result.current.status).toBe("empty"));
    expect(result.current.emptyReason).toBe("palette_not_found");
  });

  it("falla de red real -> estado 'error' con mensaje honesto", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("network down"))));

    const { result } = renderHook(() => useVectorDocument(PROJECT_ID, IMAGE_ID, PALETTE_ID));

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.errorMessage).toBeTruthy();
  });
});

function layoutResponse(overrides: Record<string, unknown> = {}) {
  return {
    projectId: PROJECT_ID,
    imageId: IMAGE_ID,
    paletteId: PALETTE_ID,
    paletteVersion: 2,
    layerSetId: LAYER_SET_ID,
    version: 1,
    entries: [
      { groupId: GROUP_A_ID, order: 0, visible: true, locked: false, name: null },
      { groupId: GROUP_B_ID, order: 1, visible: true, locked: false, name: null },
    ],
    ...overrides,
  };
}

describe("useVectorDocument — visibilidad PERSISTIDA (Eye, M2.1-S07) + Isolate/Show All EFÍMEROS", () => {
  it("toggleVisibility persiste vía la Web API (optimista) y NO se pierde con Isolate/Show All", async () => {
    const fetch = stubFetchSequence([
      (url) => (url.includes("/visibility") ? jsonResponse(layoutResponse({ entries: [
        { groupId: GROUP_A_ID, order: 0, visible: false, locked: false },
        { groupId: GROUP_B_ID, order: 1, visible: true, locked: false },
      ], version: 1 })) : undefined!),
      (url) => (url.includes("/layers/consolidated") ? jsonResponse(consolidatedResponse()) : undefined!),
      (url) => (/\/layers$/.test(url) ? jsonResponse(layerSetResponse()) : undefined!),
      (url) => (url.endsWith(`/color-palette/${PALETTE_ID}`) ? jsonResponse(paletteResponse()) : undefined!),
    ]);

    const { result } = renderHook(() => useVectorDocument(PROJECT_ID, IMAGE_ID, PALETTE_ID));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    // Optimista: el toggle se refleja de inmediato, antes de que resuelva el POST.
    act(() => result.current.toggleVisibility(GROUP_A_ID));
    expect(result.current.visibility[GROUP_A_ID]).toBe(false);

    await waitFor(() =>
      expect(fetch.mock.calls.some((call) => String(call[0]).includes(`/${GROUP_A_ID}/visibility`))).toBe(true),
    );

    // Isolate NUNCA borra el Eye persistido (spec.md: "sin borrar estados") --
    // solo un overlay de vista, session-only.
    act(() => result.current.isolate(GROUP_B_ID));
    expect(result.current.visibility).toEqual({ [GROUP_A_ID]: false, [GROUP_B_ID]: true });

    // Show All descarta el overlay -- revela el Eye REAL de cada capa (A
    // sigue oculta: eso fue un toggle explícito, no algo que Isolate tocó).
    act(() => result.current.showAll());
    await waitFor(() => expect(result.current.visibility).toEqual({ [GROUP_A_ID]: false, [GROUP_B_ID]: true }));
  });

  it("selectGroup sincroniza la selección compartida y limpia la selección múltiple de paths", async () => {
    stubHappyPath();
    const { result } = renderHook(() => useVectorDocument(PROJECT_ID, IMAGE_ID, PALETTE_ID));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(result.current.selectedGroupId).toBeNull();
    act(() => result.current.selectGroup(GROUP_A_ID));
    expect(result.current.selectedGroupId).toBe(GROUP_A_ID);
  });
});

describe("useVectorDocument — Lock (M2.1-S07, concepto nuevo, PERSISTIDO)", () => {
  it("toggleLocked persiste vía la Web API y NO afecta la visibilidad de la capa", async () => {
    const fetch = stubFetchSequence([
      (url) =>
        url.includes("/lock")
          ? jsonResponse(
              layoutResponse({
                entries: [
                  { groupId: GROUP_A_ID, order: 0, visible: true, locked: true },
                  { groupId: GROUP_B_ID, order: 1, visible: true, locked: false },
                ],
                version: 1,
              }),
            )
          : undefined!,
      (url) => (url.includes("/layers/consolidated") ? jsonResponse(consolidatedResponse()) : undefined!),
      (url) => (/\/layers$/.test(url) ? jsonResponse(layerSetResponse()) : undefined!),
      (url) => (url.endsWith(`/color-palette/${PALETTE_ID}`) ? jsonResponse(paletteResponse()) : undefined!),
    ]);

    const { result } = renderHook(() => useVectorDocument(PROJECT_ID, IMAGE_ID, PALETTE_ID));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.toggleLocked(GROUP_A_ID));
    expect(result.current.document?.layers.find((l) => l.groupId === GROUP_A_ID)?.locked).toBe(true);

    await waitFor(() => expect(fetch.mock.calls.some((call) => String(call[0]).includes(`/${GROUP_A_ID}/lock`))).toBe(true));
    await waitFor(() => expect(result.current.document?.layers.find((l) => l.groupId === GROUP_A_ID)?.locked).toBe(true));

    // Lock jamás toca visible/order de la capa que se bloqueó ni de ninguna otra.
    expect(result.current.visibility[GROUP_A_ID]).toBe(true);
    expect(result.current.document?.layers.find((l) => l.groupId === GROUP_B_ID)?.locked).toBe(false);
  });
});

describe("useVectorDocument — Rename (M2.1-S07, ronda de fix 2 -- PERSISTIDO vía el sidecar LayerLayout)", () => {
  it("renameLayer persiste vía setLayerName (sidecar LayerLayout), NO vía renameColorPaletteGroup", async () => {
    const fetch = stubFetchSequence([
      (url) =>
        url.includes("/rename")
          ? jsonResponse(
              layoutResponse({
                entries: [
                  { groupId: GROUP_A_ID, order: 0, visible: true, locked: false, name: "Rojo carmesí" },
                  { groupId: GROUP_B_ID, order: 1, visible: true, locked: false, name: null },
                ],
                version: 1,
              }),
            )
          : undefined!,
      (url) => (url.includes("/layers/consolidated") ? jsonResponse(consolidatedResponse()) : undefined!),
      (url) => (/\/layers$/.test(url) ? jsonResponse(layerSetResponse()) : undefined!),
      (url) => (url.endsWith(`/color-palette/${PALETTE_ID}`) ? jsonResponse(paletteResponse()) : undefined!),
    ]);

    const { result } = renderHook(() => useVectorDocument(PROJECT_ID, IMAGE_ID, PALETTE_ID));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    // Optimista: el nombre se refleja de inmediato, antes de que resuelva el POST.
    act(() => result.current.renameLayer(GROUP_A_ID, "Rojo carmesí"));
    expect(result.current.document?.layers.find((l) => l.groupId === GROUP_A_ID)?.name).toBe("Rojo carmesí");

    await waitFor(() =>
      expect(fetch.mock.calls.some((call) => String(call[0]).includes(`/${GROUP_A_ID}/rename`))).toBe(true),
    );
    // Nunca pega al endpoint clásico de M2-S01 (ese sí rechazaría con 409 palette_confirmed).
    expect(fetch.mock.calls.some((call) => String(call[0]).endsWith(`/color-palette/${PALETTE_ID}/rename`))).toBe(false);

    await waitFor(() =>
      expect(result.current.document?.layers.find((l) => l.groupId === GROUP_A_ID)?.name).toBe("Rojo carmesí"),
    );
    // NUNCA toca el GroupId ni Visible/Locked/Order de la capa renombrada ni de ninguna otra.
    expect(result.current.document?.layers.find((l) => l.groupId === GROUP_A_ID)?.groupId).toBe(GROUP_A_ID);
    expect(result.current.document?.layers.find((l) => l.groupId === GROUP_B_ID)?.name).toBe("Azul");
  });

  it("si la Web API falla, retrocede (rollback) al nombre anterior", async () => {
    const fetch = stubFetchSequence([
      (url) => (url.includes("/rename") ? new Response("error", { status: 400 }) : undefined!),
      (url) => (url.includes("/layers/consolidated") ? jsonResponse(consolidatedResponse()) : undefined!),
      (url) => (/\/layers$/.test(url) ? jsonResponse(layerSetResponse()) : undefined!),
      (url) => (url.endsWith(`/color-palette/${PALETTE_ID}`) ? jsonResponse(paletteResponse()) : undefined!),
    ]);

    const { result } = renderHook(() => useVectorDocument(PROJECT_ID, IMAGE_ID, PALETTE_ID));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.renameLayer(GROUP_A_ID, "Nombre que falla"));
    expect(result.current.document?.layers.find((l) => l.groupId === GROUP_A_ID)?.name).toBe("Nombre que falla");

    await waitFor(() => expect(fetch.mock.calls.some((call) => String(call[0]).includes("/rename"))).toBe(true));
    await waitFor(() =>
      expect(result.current.document?.layers.find((l) => l.groupId === GROUP_A_ID)?.name).toBe("Rojo"),
    );
  });
});

describe("useVectorDocument — reload conserva el nombre renombrado (Rename, M2.1-S07, ronda de fix 2)", () => {
  it("después de recargar (reload/remount), el nombre override del sidecar LayerLayout vuelve a leerse de la Web API tal como quedó persistido", async () => {
    stubFetchSequence([
      (url) =>
        url.includes("/layers/consolidated")
          ? jsonResponse(
              consolidatedResponse({
                layers: [
                  { id: GROUP_A_ID, name: "Rojo carmesí", colorHex: "#ff0000", fill: "#ff0000", vectorId: VECTOR_A_ID, svgUrl: `/vectors/${VECTOR_A_ID}`, pathCount: 3, componentCount: 1, manufacturingOperation: "cut", visible: true, locked: false, order: 0, rasterValidation: { ownMismatchRatio: 0, ownMismatchTolerance: 0.02, ownMismatchWithinTolerance: true, contaminationRatio: 0, contaminationTolerance: 0.02, contaminationWithinTolerance: true, warnings: [] } },
                  { id: GROUP_B_ID, name: "Azul", colorHex: "#0000ff", fill: "#0000ff", vectorId: VECTOR_B_ID, svgUrl: `/vectors/${VECTOR_B_ID}`, pathCount: 2, componentCount: null, manufacturingOperation: "unassigned", visible: true, locked: false, order: 1, rasterValidation: { ownMismatchRatio: 0, ownMismatchTolerance: 0.02, ownMismatchWithinTolerance: true, contaminationRatio: 0, contaminationTolerance: 0.02, contaminationWithinTolerance: true, warnings: [] } },
                ],
              }),
            )
          : undefined!,
      (url) => (/\/layers$/.test(url) ? jsonResponse(layerSetResponse()) : undefined!),
      (url) => (url.endsWith(`/color-palette/${PALETTE_ID}`) ? jsonResponse(paletteResponse()) : undefined!),
    ]);

    const { result } = renderHook(() => useVectorDocument(PROJECT_ID, IMAGE_ID, PALETTE_ID));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    // "Rojo carmesí" viene del consolidado (que ya resuelve el override del
    // sidecar LayerLayout, layout.Name ?? layer.Name) -- no del snapshot
    // crudo "Rojo" de VectorLayer.Name (ver layerSetResponse() arriba).
    expect(result.current.document?.layers.find((l) => l.groupId === GROUP_A_ID)?.name).toBe("Rojo carmesí");
  });
});

describe("useVectorDocument — Reorder (Drag & Drop, M2.1-S07, PERSISTIDO)", () => {
  it("reorderLayers persiste el nuevo orden y preserva el VectorId (geometría) de cada capa", async () => {
    const fetch = stubFetchSequence([
      (url) =>
        url.includes("/reorder")
          ? jsonResponse(
              layoutResponse({
                entries: [
                  { groupId: GROUP_B_ID, order: 0, visible: true, locked: false },
                  { groupId: GROUP_A_ID, order: 1, visible: true, locked: false },
                ],
                version: 1,
              }),
            )
          : undefined!,
      (url) => (url.includes("/layers/consolidated") ? jsonResponse(consolidatedResponse()) : undefined!),
      (url) => (/\/layers$/.test(url) ? jsonResponse(layerSetResponse()) : undefined!),
      (url) => (url.endsWith(`/color-palette/${PALETTE_ID}`) ? jsonResponse(paletteResponse()) : undefined!),
    ]);

    const { result } = renderHook(() => useVectorDocument(PROJECT_ID, IMAGE_ID, PALETTE_ID));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    const vectorIdsBefore = new Map(result.current.document!.layers.map((l) => [l.groupId, l.vectorId]));

    act(() => result.current.reorderLayers([GROUP_B_ID, GROUP_A_ID]));

    expect(result.current.document?.layers.map((l) => l.groupId)).toEqual([GROUP_B_ID, GROUP_A_ID]);

    await waitFor(() => expect(fetch.mock.calls.some((call) => String(call[0]).includes("/reorder"))).toBe(true));
    await waitFor(() => expect(result.current.document?.layers[0]?.groupId).toBe(GROUP_B_ID));

    // NUNCA toca geometría: mismo VectorId de cada capa, antes y después.
    for (const layer of result.current.document!.layers) {
      expect(layer.vectorId).toBe(vectorIdsBefore.get(layer.groupId));
    }
  });
});

describe("useVectorDocument — Select All in Layer (M2.1-S07, primera selección múltiple real)", () => {
  it("selecciona TODOS los paths de esa capa (una clave por índice 0..pathCount-1) y también selecciona el Layer", async () => {
    stubHappyPath();
    const { result } = renderHook(() => useVectorDocument(PROJECT_ID, IMAGE_ID, PALETTE_ID));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(result.current.selectedPathKeys.size).toBe(0);

    act(() => result.current.selectAllInLayer(GROUP_A_ID));

    // consolidatedResponse() define pathCount=3 para GROUP_A_ID.
    expect(result.current.selectedPathKeys.size).toBe(3);
    expect(result.current.selectedPathKeys.has(`${GROUP_A_ID}:0`)).toBe(true);
    expect(result.current.selectedPathKeys.has(`${GROUP_A_ID}:2`)).toBe(true);
    expect(result.current.selectedGroupId).toBe(GROUP_A_ID);
  });

  it("seleccionar otra capa limpia la selección múltiple de la capa anterior", async () => {
    stubHappyPath();
    const { result } = renderHook(() => useVectorDocument(PROJECT_ID, IMAGE_ID, PALETTE_ID));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.selectAllInLayer(GROUP_A_ID));
    expect(result.current.selectedPathKeys.size).toBe(3);

    act(() => result.current.selectGroup(GROUP_B_ID));
    expect(result.current.selectedPathKeys.size).toBe(0);
  });
});

const SAVED_PROJECT_ID = "99999999-9999-9999-9999-999999999999";

function savedDocumentResponse(overrides: Record<string, unknown> = {}) {
  return {
    projectId: SAVED_PROJECT_ID,
    schemaVersion: 1,
    widthMm: 320,
    heightMm: 240,
    viewBox: "0 0 320 240",
    versionNumber: 1,
    createdAt: "2026-01-01T00:00:00Z",
    layers: [
      {
        id: GROUP_A_ID, name: "Rojo", order: 0, visible: true, locked: false,
        manufacturingOperation: "cut", colorHex: "#ff0000", coverage: 60, isBackground: false,
        svgAssetId: "ffffffff-ffff-ffff-ffff-ffffffffffff", svgUrl: `/api/v2/projects/${SAVED_PROJECT_ID}/assets/ffffffff-ffff-ffff-ffff-ffffffffffff`,
        pathCount: 5,
      },
      {
        id: GROUP_B_ID, name: "Azul", order: 1, visible: true, locked: false,
        manufacturingOperation: "unassigned", colorHex: "#0000ff", coverage: 40, isBackground: false,
        svgAssetId: null, svgUrl: null, pathCount: 2,
      },
    ],
    ...overrides,
  };
}

describe("useVectorDocument — reapertura vía savedProjectId (M2.2-S05)", () => {
  it("reconstruye el documento directo desde GET .../document, sin pasar por la agregación clásica de 3 endpoints", async () => {
    const fetch = stubFetchSequence([
      (url) => (url.includes(`/api/v2/projects/${SAVED_PROJECT_ID}/document`) ? jsonResponse(savedDocumentResponse()) : undefined!),
    ]);

    const { result } = renderHook(() => useVectorDocument(PROJECT_ID, IMAGE_ID, PALETTE_ID, SAVED_PROJECT_ID));

    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(result.current.document?.layers).toHaveLength(2);
    expect(result.current.document?.layers[0]).toMatchObject({
      groupId: GROUP_A_ID,
      name: "Rojo",
      colorHex: "#ff0000",
      manufacturingOperation: "cut",
      visible: true,
      locked: false,
      // Bug real encontrado en revisión (ver Data.Layer.PathCount/AddLayerPathCount): sin esto
      // quedaba hardcodeado en 0, mostrando un dato falso en el Inspector y rompiendo
      // silenciosamente "Seleccionar todo en la capa" para cualquier proyecto reabierto.
      pathCount: 5,
    });
    expect(result.current.document?.sourceWidthPx).toBe(320);
    expect(result.current.document?.sourceHeightPx).toBe(240);

    // Ninguna llamada al flujo clásico de 3 endpoints (paleta/layers/consolidado).
    expect(fetch.mock.calls.some((call) => String(call[0]).includes("/color-palette/"))).toBe(false);
    expect(fetch.mock.calls.some((call) => String(call[0]).match(/\/layers$/))).toBe(false);
    expect(fetch.mock.calls.some((call) => String(call[0]).includes("/layers/consolidated"))).toBe(false);
  });

  it("documento guardado inexistente (404) -> 'empty' (palette_not_found), igual criterio que el flujo clásico", async () => {
    stubFetchSequence([
      (url) =>
        url.includes(`/api/v2/projects/${SAVED_PROJECT_ID}/document`)
          ? jsonResponse({ code: "not_found", message: "No existe." }, 404)
          : undefined!,
    ]);

    const { result } = renderHook(() => useVectorDocument(PROJECT_ID, IMAGE_ID, PALETTE_ID, SAVED_PROJECT_ID));

    await waitFor(() => expect(result.current.status).toBe("empty"));
    expect(result.current.emptyReason).toBe("palette_not_found");
  });
});

describe("useVectorDocument — cutover post-Save (PATCH v2, M2.2-S05 ronda de fix 1)", () => {
  it("toggleVisibility con savedProjectId llama al PATCH v2, NUNCA al sidecar clásico de LayerLayout", async () => {
    const fetch = stubFetchSequence([
      (url) => (url.includes(`/api/v2/projects/${SAVED_PROJECT_ID}/document`) ? jsonResponse(savedDocumentResponse()) : undefined!),
    ]);

    const { result } = renderHook(() => useVectorDocument(PROJECT_ID, IMAGE_ID, PALETTE_ID, SAVED_PROJECT_ID));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    fetch.mockImplementation((input: string | URL) => {
      const url = String(input);
      if (url === `http://localhost:5080/api/v2/projects/${SAVED_PROJECT_ID}/layers/${GROUP_A_ID}`) {
        return Promise.resolve(
          jsonResponse({
            id: GROUP_A_ID, name: "Rojo", order: 0, visible: false, locked: false,
            manufacturingOperation: "cut", colorHex: "#ff0000", coverage: 60, isBackground: false,
            svgAssetId: null, svgUrl: null, pathCount: 5,
          }),
        );
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });

    act(() => result.current.toggleVisibility(GROUP_A_ID));
    // Optimista: se refleja de inmediato, antes de que resuelva el PATCH.
    expect(result.current.visibility[GROUP_A_ID]).toBe(false);

    await waitFor(() =>
      expect(fetch.mock.calls.some(([input, init]) => String(input).endsWith(`/layers/${GROUP_A_ID}`) && (init as RequestInit)?.method === "PATCH")).toBe(true),
    );
    // NUNCA pega al endpoint clásico del sidecar LayerLayout.
    expect(fetch.mock.calls.some((call) => String(call[0]).includes("/visibility"))).toBe(false);

    await waitFor(() => expect(result.current.visibility[GROUP_A_ID]).toBe(false));
  });

  it("toggleLocked con savedProjectId llama al PATCH v2 con { locked }", async () => {
    const fetch = stubFetchSequence([
      (url) => (url.includes(`/api/v2/projects/${SAVED_PROJECT_ID}/document`) ? jsonResponse(savedDocumentResponse()) : undefined!),
    ]);

    const { result } = renderHook(() => useVectorDocument(PROJECT_ID, IMAGE_ID, PALETTE_ID, SAVED_PROJECT_ID));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    fetch.mockImplementation((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/layers/${GROUP_A_ID}`) && init?.method === "PATCH") {
        return Promise.resolve(
          jsonResponse({
            id: GROUP_A_ID, name: "Rojo", order: 0, visible: true, locked: true,
            manufacturingOperation: "cut", colorHex: "#ff0000", coverage: 60, isBackground: false,
            svgAssetId: null, svgUrl: null, pathCount: 5,
          }),
        );
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });

    act(() => result.current.toggleLocked(GROUP_A_ID));

    await waitFor(() => expect(result.current.document?.layers.find((l) => l.groupId === GROUP_A_ID)?.locked).toBe(true));
    expect(fetch.mock.calls.some((call) => String(call[0]).includes("/lock"))).toBe(false);

    const patchCall = fetch.mock.calls.find(
      ([input, init]) => String(input).endsWith(`/layers/${GROUP_A_ID}`) && (init as RequestInit | undefined)?.method === "PATCH",
    );
    expect(patchCall).toBeDefined();
    expect(JSON.parse((patchCall![1] as RequestInit).body as string)).toEqual({ locked: true });
  });

  it("renameLayer con savedProjectId llama al PATCH v2 con { name }", async () => {
    const fetch = stubFetchSequence([
      (url) => (url.includes(`/api/v2/projects/${SAVED_PROJECT_ID}/document`) ? jsonResponse(savedDocumentResponse()) : undefined!),
    ]);

    const { result } = renderHook(() => useVectorDocument(PROJECT_ID, IMAGE_ID, PALETTE_ID, SAVED_PROJECT_ID));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    fetch.mockImplementation((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/layers/${GROUP_A_ID}`) && init?.method === "PATCH") {
        return Promise.resolve(
          jsonResponse({
            id: GROUP_A_ID, name: "Rojo carmesí", order: 0, visible: true, locked: false,
            manufacturingOperation: "cut", colorHex: "#ff0000", coverage: 60, isBackground: false,
            svgAssetId: null, svgUrl: null, pathCount: 5,
          }),
        );
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });

    act(() => result.current.renameLayer(GROUP_A_ID, "Rojo carmesí"));

    await waitFor(() => expect(result.current.document?.layers.find((l) => l.groupId === GROUP_A_ID)?.name).toBe("Rojo carmesí"));
    expect(fetch.mock.calls.some((call) => String(call[0]).includes("/rename"))).toBe(false);

    const patchCall = fetch.mock.calls.find(
      ([input, init]) => String(input).endsWith(`/layers/${GROUP_A_ID}`) && (init as RequestInit | undefined)?.method === "PATCH",
    );
    expect(patchCall).toBeDefined();
    expect(JSON.parse((patchCall![1] as RequestInit).body as string)).toEqual({ name: "Rojo carmesí" });
  });

  it("reorderLayers con savedProjectId manda un PATCH { order } por cada layer cuyo orden cambió, sin endpoint de batch", async () => {
    const fetch = stubFetchSequence([
      (url) => (url.includes(`/api/v2/projects/${SAVED_PROJECT_ID}/document`) ? jsonResponse(savedDocumentResponse()) : undefined!),
    ]);

    const { result } = renderHook(() => useVectorDocument(PROJECT_ID, IMAGE_ID, PALETTE_ID, SAVED_PROJECT_ID));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    fetch.mockImplementation((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/layers/${GROUP_A_ID}`) && init?.method === "PATCH") {
        return Promise.resolve(
          jsonResponse({
            id: GROUP_A_ID, name: "Rojo", order: 1, visible: true, locked: false,
            manufacturingOperation: "cut", colorHex: "#ff0000", coverage: 60, isBackground: false,
            svgAssetId: null, svgUrl: null, pathCount: 5,
          }),
        );
      }
      if (url.endsWith(`/layers/${GROUP_B_ID}`) && init?.method === "PATCH") {
        return Promise.resolve(
          jsonResponse({
            id: GROUP_B_ID, name: "Azul", order: 0, visible: true, locked: false,
            manufacturingOperation: "unassigned", colorHex: "#0000ff", coverage: 40, isBackground: false,
            svgAssetId: null, svgUrl: null, pathCount: 2,
          }),
        );
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });

    // Orden original: A (0), B (1) -- se invierte a B (0), A (1): AMBOS layers cambian de orden.
    act(() => result.current.reorderLayers([GROUP_B_ID, GROUP_A_ID]));

    await waitFor(() => expect(result.current.document?.layers.map((l) => l.groupId)).toEqual([GROUP_B_ID, GROUP_A_ID]));

    const patchCalls = fetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "PATCH");
    expect(patchCalls).toHaveLength(2);
    expect(fetch.mock.calls.some((call) => String(call[0]).includes("/reorder"))).toBe(false);

    const patchByGroupId = new Map(patchCalls.map(([input, init]) => [String(input), JSON.parse((init as RequestInit).body as string)]));
    expect(patchByGroupId.get(`http://localhost:5080/api/v2/projects/${SAVED_PROJECT_ID}/layers/${GROUP_A_ID}`)).toEqual({ order: 1 });
    expect(patchByGroupId.get(`http://localhost:5080/api/v2/projects/${SAVED_PROJECT_ID}/layers/${GROUP_B_ID}`)).toEqual({ order: 0 });
  });

  it("round-trip: editar (visible/locked/order/nombre/operación) con savedProjectId -> reabrir vía GET .../document -> el cambio sigue ahí", async () => {
    // Simula el estado real persistido en el backend: GET siempre devuelve el estado VIGENTE,
    // y cada PATCH lo muta -- igual que Data.Layer en PostgreSQL (ver spec.md M2.2-S05,
    // Decisión arquitectónica #2: "la DB es la fuente autoritativa").
    const serverLayers: VectorDocumentLayerResponse[] = [
      { id: GROUP_A_ID, name: "Rojo", order: 0, visible: true, locked: false, manufacturingOperation: "cut", colorHex: "#ff0000", coverage: 60, isBackground: false, svgAssetId: null, svgUrl: null, pathCount: 5 },
      { id: GROUP_B_ID, name: "Azul", order: 1, visible: true, locked: false, manufacturingOperation: "unassigned", colorHex: "#0000ff", coverage: 40, isBackground: false, svgAssetId: null, svgUrl: null, pathCount: 2 },
    ];

    const fetch = vi.fn((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes(`/api/v2/projects/${SAVED_PROJECT_ID}/document`) && (!init || init.method === undefined || init.method === "GET")) {
        return Promise.resolve(jsonResponse(savedDocumentResponse({ layers: serverLayers })));
      }
      const patchMatch = url.match(new RegExp(`/layers/([0-9a-f-]+)$`));
      if (patchMatch && init?.method === "PATCH") {
        const layerId = patchMatch[1];
        const layer = serverLayers.find((l) => l.id === layerId)!;
        const patch = JSON.parse(init.body as string) as Partial<VectorDocumentLayerResponse>;
        Object.assign(layer, patch);
        return Promise.resolve(jsonResponse(layer));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal("fetch", fetch);

    const { result, unmount } = renderHook(() => useVectorDocument(PROJECT_ID, IMAGE_ID, PALETTE_ID, SAVED_PROJECT_ID));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    // Editar: visibilidad, lock, orden (invertir A/B) y nombre -- todo contra el PATCH v2.
    act(() => result.current.toggleVisibility(GROUP_B_ID));
    await waitFor(() => expect(result.current.visibility[GROUP_B_ID]).toBe(false));

    act(() => result.current.toggleLocked(GROUP_A_ID));
    await waitFor(() => expect(result.current.document?.layers.find((l) => l.groupId === GROUP_A_ID)?.locked).toBe(true));

    act(() => result.current.renameLayer(GROUP_A_ID, "Rojo carmesí"));
    await waitFor(() => expect(result.current.document?.layers.find((l) => l.groupId === GROUP_A_ID)?.name).toBe("Rojo carmesí"));

    act(() => result.current.reorderLayers([GROUP_B_ID, GROUP_A_ID]));
    await waitFor(() => expect(result.current.document?.layers.map((l) => l.groupId)).toEqual([GROUP_B_ID, GROUP_A_ID]));

    // "Reabrir": desmontar el hook (como si se cerrara el Workspace) y montar uno nuevo, que
    // vuelve a pedir GET .../document desde cero -- NUNCA desde memoria del cliente.
    unmount();
    const { result: reopened } = renderHook(() => useVectorDocument(PROJECT_ID, IMAGE_ID, PALETTE_ID, SAVED_PROJECT_ID));
    await waitFor(() => expect(reopened.current.status).toBe("ready"));

    expect(reopened.current.document?.layers.map((l) => l.groupId)).toEqual([GROUP_B_ID, GROUP_A_ID]);
    expect(reopened.current.visibility[GROUP_B_ID]).toBe(false);
    expect(reopened.current.document?.layers.find((l) => l.groupId === GROUP_A_ID)).toMatchObject({
      locked: true,
      name: "Rojo carmesí",
    });
  });
});

describe("useVectorDocument — reload conserva order/visible/locked persistidos", () => {
  it("después de recargar (reload/remount), los valores de order/visible/locked vuelven a leerse de la Web API tal como quedaron persistidos", async () => {
    stubFetchSequence([
      (url) =>
        url.includes("/layers/consolidated")
          ? jsonResponse(
              consolidatedResponse({
                layers: [
                  { id: GROUP_A_ID, name: "Rojo", colorHex: "#ff0000", fill: "#ff0000", vectorId: VECTOR_A_ID, svgUrl: `/vectors/${VECTOR_A_ID}`, pathCount: 3, componentCount: 1, manufacturingOperation: "cut", visible: false, locked: true, order: 1, rasterValidation: { ownMismatchRatio: 0, ownMismatchTolerance: 0.02, ownMismatchWithinTolerance: true, contaminationRatio: 0, contaminationTolerance: 0.02, contaminationWithinTolerance: true, warnings: [] } },
                  { id: GROUP_B_ID, name: "Azul", colorHex: "#0000ff", fill: "#0000ff", vectorId: VECTOR_B_ID, svgUrl: `/vectors/${VECTOR_B_ID}`, pathCount: 2, componentCount: null, manufacturingOperation: "unassigned", visible: true, locked: false, order: 0, rasterValidation: { ownMismatchRatio: 0, ownMismatchTolerance: 0.02, ownMismatchWithinTolerance: true, contaminationRatio: 0, contaminationTolerance: 0.02, contaminationWithinTolerance: true, warnings: [] } },
                ],
              }),
            )
          : undefined!,
      (url) => (/\/layers$/.test(url) ? jsonResponse(layerSetResponse()) : undefined!),
      (url) => (url.endsWith(`/color-palette/${PALETTE_ID}`) ? jsonResponse(paletteResponse()) : undefined!),
    ]);

    const { result } = renderHook(() => useVectorDocument(PROJECT_ID, IMAGE_ID, PALETTE_ID));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    // Persistido: Azul (order=0) va PRIMERO, Rojo (order=1, locked, oculta) va segundo.
    expect(result.current.document?.layers.map((l) => l.groupId)).toEqual([GROUP_B_ID, GROUP_A_ID]);
    expect(result.current.document?.layers.find((l) => l.groupId === GROUP_A_ID)?.locked).toBe(true);
    expect(result.current.visibility[GROUP_A_ID]).toBe(false);
  });
});
