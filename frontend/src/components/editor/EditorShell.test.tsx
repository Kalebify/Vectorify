import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorShell } from "./EditorShell";

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const IMAGE_ID = "22222222-2222-2222-2222-222222222222";
const PALETTE_ID = "33333333-3333-3333-3333-333333333333";
const GROUP_A_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const GROUP_B_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const VECTOR_A_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const VECTOR_B_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const LAYER_SET_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

const SVG_TEXT = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><path d="M0,0 L10,0 L10,10 Z" fill="#ff0000" /></svg>`;

class ImmediateResizeObserver {
  callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe() {
    this.callback([{ contentRect: { width: 800, height: 600 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve() {}
  disconnect() {}
}

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

function consolidatedResponse() {
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
  };
}

function stubFetch(handler: (url: string) => Response | undefined) {
  // `_init` tipado explícitamente (aunque no se usa en el cuerpo) para que
  // `fetch.mock.calls[i][1]` quede tipado como `RequestInit | undefined` --
  // lo necesita el test de wiring de operaciones (fix round M2.1-S07) para
  // inspeccionar el body del POST, mismo criterio que ColorPalettePanel.test.tsx.
  const fetch = vi.fn((input: string | URL, _init?: RequestInit) => {
    const url = String(input);
    if (/\/vectors\//.test(url)) {
      return Promise.resolve(new Response(SVG_TEXT, { status: 200 }));
    }
    const result = handler(url);
    if (result) return Promise.resolve(result);
    return Promise.reject(new Error(`Unhandled fetch: ${url}`));
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function stubHappyPath() {
  return stubFetch((url) => {
    if (url.includes("/layers/consolidated")) return jsonResponse(consolidatedResponse());
    if (/\/layers$/.test(url)) return jsonResponse(layerSetResponse());
    if (url.endsWith(`/color-palette/${PALETTE_ID}`)) return jsonResponse(paletteResponse());
    return undefined;
  });
}

function renderShell(onClose = vi.fn()) {
  return render(
    <EditorShell projectId={PROJECT_ID} imageId={IMAGE_ID} paletteId={PALETTE_ID} projectName="mi-diseño.svg" onClose={onClose} />,
  );
}

describe("EditorShell — render del workspace completo", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ImmediateResizeObserver);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("muestra header, toolbar, canvas, preview, layers, inspector y bottom bar (proyecto multicolor)", async () => {
    stubHappyPath();
    renderShell();

    await waitFor(() => expect(screen.getByRole("application")).toBeInTheDocument());

    expect(screen.getByText("VECTORiZE")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Herramientas del editor" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Preview" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Layers" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Inspector" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Paleta confirmada del documento" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Controles de zoom y documento" })).toBeInTheDocument();
  });
});

describe("EditorShell — proyecto sin layers", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ImmediateResizeObserver);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("muestra un estado vacío honesto, nunca layers inventadas", async () => {
    stubFetch((url) => {
      if (/\/layers$/.test(url)) return jsonResponse({ code: "not_found", message: "No existe." }, 404);
      if (url.endsWith(`/color-palette/${PALETTE_ID}`)) return jsonResponse(paletteResponse());
      return undefined;
    });

    renderShell();

    expect(await screen.findByText(/todavía no tiene capas vectoriales generadas/)).toBeInTheDocument();
    expect(screen.queryByRole("application")).not.toBeInTheDocument();
  });
});

describe("EditorShell — error de carga", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ImmediateResizeObserver);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("una falla real de red muestra un error con opción de reintentar", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("network down"))));
    renderShell();

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reintentar" })).toBeInTheDocument();
  });
});

describe("EditorShell — resize / zoom / fit", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ImmediateResizeObserver);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("mide el contenedor del canvas (resize) y FIT recalcula el zoom sin romper", async () => {
    stubHappyPath();
    renderShell();

    await waitFor(() => expect(screen.getByRole("application")).toBeInTheDocument(), { timeout: 10000 });

    const zoomBefore = screen.getByLabelText(/Zoom actual/).textContent;
    fireEvent.click(screen.getByRole("button", { name: "Acercar" }));
    const zoomAfterZoomIn = screen.getByLabelText(/Zoom actual/).textContent;
    expect(zoomAfterZoomIn).not.toBe(zoomBefore);

    fireEvent.click(screen.getByRole("button", { name: "FIT" }));
    // fitToScreen no debe lanzar ni dejar el canvas en un estado roto.
    expect(screen.getByRole("application")).toBeInTheDocument();
  }, 15000);
});

describe("EditorShell — sincronización básica con el documento", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ImmediateResizeObserver);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("seleccionar una capa en Layers se refleja en el Inspector y en la Paleta", async () => {
    stubHappyPath();
    renderShell();

    await waitFor(() => expect(screen.getByRole("application")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Seleccionar la capa Rojo" }));

    // Inspector ahora muestra el HEX de la capa seleccionada.
    await waitFor(() => expect(screen.getByText("#ff0000")).toBeInTheDocument());
    // La paleta inferior también refleja la misma selección (mismo groupId compartido).
    expect(screen.getByRole("button", { name: /Seleccionar el color Rojo/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("Aislar desde el Inspector oculta las demás capas en la lista de Layers", async () => {
    stubHappyPath();
    renderShell();

    await waitFor(() => expect(screen.getByRole("application")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Seleccionar la capa Rojo" }));
    await waitFor(() => expect(screen.getByText("#ff0000")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Aislar" }));

    expect(screen.getByRole("button", { name: "Ocultar la capa Rojo" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mostrar la capa Azul" })).toBeInTheDocument();
  });
});

describe("EditorShell — operación de fabricación (fix round M2.1-S07, wiring de useManufacturingOperations)", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ImmediateResizeObserver);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("cambiar la operación desde el panel Layers del Workspace llama al endpoint de asignación con el groupId y la operación correctos", async () => {
    const fetch = stubFetch((url) => {
      if (url.includes("/layers/operations")) {
        return jsonResponse({
          projectId: PROJECT_ID,
          imageId: IMAGE_ID,
          paletteId: PALETTE_ID,
          paletteVersion: 2,
          layerSetId: LAYER_SET_ID,
          version: 0,
          operations: [],
          summary: { cutCount: 0, engraveCount: 0, ignoreCount: 0, unassignedCount: 2, totalCount: 2 },
        });
      }
      if (/\/layers\/[0-9a-f-]+\/operation$/.test(url)) {
        return jsonResponse({
          projectId: PROJECT_ID,
          imageId: IMAGE_ID,
          paletteId: PALETTE_ID,
          paletteVersion: 2,
          layerSetId: LAYER_SET_ID,
          version: 1,
          operations: [{ groupId: GROUP_A_ID, name: "Rojo", colorHex: "#ff0000", operation: "engrave" }],
          summary: { cutCount: 0, engraveCount: 1, ignoreCount: 0, unassignedCount: 1, totalCount: 2 },
        });
      }
      if (url.includes("/layers/consolidated")) return jsonResponse(consolidatedResponse());
      if (/\/layers$/.test(url)) return jsonResponse(layerSetResponse());
      if (url.endsWith(`/color-palette/${PALETTE_ID}`)) return jsonResponse(paletteResponse());
      return undefined;
    });

    renderShell();
    await waitFor(() => expect(screen.getByRole("application")).toBeInTheDocument());

    const select = await screen.findByRole("combobox", { name: "Operación de fabricación de la capa Rojo" });
    expect(select).toHaveValue("cut");

    fireEvent.change(select, { target: { value: "engrave" } });

    // El <select> refleja el valor YA PERSISTIDO (respuesta autoritativa de
    // useManufacturingOperations.assign), no solo un cambio optimista local.
    await waitFor(() => expect(select).toHaveValue("engrave"));

    const operationCall = fetch.mock.calls.find(([input]) => /\/operation$/.test(String(input)));
    expect(operationCall).toBeDefined();
    expect(String(operationCall![0])).toContain(`/layers/${GROUP_A_ID}/operation`);
    const init = operationCall![1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ operation: "engrave" });
  });
});

describe("EditorShell — cutover post-Save (savedProjectId activo, M2.2-S05 ronda de fix 1)", () => {
  const SAVED_PROJECT_ID = "99999999-9999-9999-9999-999999999999";

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ImmediateResizeObserver);
  });
  afterEach(() => vi.unstubAllGlobals());

  function savedDocumentResponse() {
    return {
      projectId: SAVED_PROJECT_ID,
      schemaVersion: 1,
      widthMm: 320,
      heightMm: 240,
      viewBox: "0 0 320 240",
      versionNumber: 1,
      createdAt: "2026-01-01T00:00:00Z",
      layers: [
        { id: GROUP_A_ID, name: "Rojo", order: 0, visible: true, locked: false, manufacturingOperation: "cut", colorHex: "#ff0000", coverage: 60, isBackground: false, svgAssetId: null, svgUrl: `/assets/${GROUP_A_ID}`, pathCount: 3 },
        { id: GROUP_B_ID, name: "Azul", order: 1, visible: true, locked: false, manufacturingOperation: "unassigned", colorHex: "#0000ff", coverage: 40, isBackground: false, svgAssetId: null, svgUrl: `/assets/${GROUP_B_ID}`, pathCount: 2 },
      ],
    };
  }

  function renderSavedShell() {
    return render(
      <EditorShell
        projectId={PROJECT_ID}
        imageId={IMAGE_ID}
        paletteId={PALETTE_ID}
        projectName="mi-diseño.svg"
        savedProjectId={SAVED_PROJECT_ID}
        onClose={vi.fn()}
      />,
    );
  }

  it("cambiar la operación de fabricación llama al PATCH v2 por-layer, nunca al sidecar clásico ManufacturingOperationService", async () => {
    const fetch = stubFetch((url) => {
      if (url.includes(`/api/v2/projects/${SAVED_PROJECT_ID}/document`)) return jsonResponse(savedDocumentResponse());
      if (url.includes("/assets/")) return new Response(SVG_TEXT, { status: 200 });
      if (/\/layers\/[0-9a-f-]+$/.test(url)) {
        return jsonResponse({
          id: GROUP_A_ID, name: "Rojo", order: 0, visible: true, locked: false,
          manufacturingOperation: "engrave", colorHex: "#ff0000", coverage: 60, isBackground: false,
          svgAssetId: null, svgUrl: `/assets/${GROUP_A_ID}`, pathCount: 3,
        });
      }
      return undefined;
    });

    renderSavedShell();
    await waitFor(() => expect(screen.getByRole("application")).toBeInTheDocument());

    const select = await screen.findByRole("combobox", { name: "Operación de fabricación de la capa Rojo" });
    expect(select).toHaveValue("cut");

    fireEvent.change(select, { target: { value: "engrave" } });

    await waitFor(() => expect(select).toHaveValue("engrave"));

    const patchCall = fetch.mock.calls.find(
      ([input, init]) => /\/layers\/[0-9a-f-]+$/.test(String(input)) && (init as RequestInit | undefined)?.method === "PATCH",
    );
    expect(patchCall).toBeDefined();
    expect(String(patchCall![0])).toContain(`/layers/${GROUP_A_ID}`);
    expect(JSON.parse((patchCall![1] as RequestInit).body as string)).toEqual({ manufacturingOperation: "engrave" });

    // NUNCA llama al conjunto clásico de operaciones ni a su endpoint de asignación por-color.
    expect(fetch.mock.calls.some((call) => String(call[0]).includes("/layers/operations"))).toBe(false);
    expect(fetch.mock.calls.some((call) => /\/operation$/.test(String(call[0])))).toBe(false);
  });
});

describe("EditorShell — ← Projects", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ImmediateResizeObserver);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("llama a onClose", async () => {
    stubHappyPath();
    const onClose = vi.fn();
    renderShell(onClose);

    fireEvent.click(screen.getByRole("button", { name: /Volver a la lista de proyectos/ }));
    expect(onClose).toHaveBeenCalled();
  });
});
