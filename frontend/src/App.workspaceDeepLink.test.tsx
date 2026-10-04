import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { pushWorkspaceLocation } from "./lib/workspaceLocation";
import type { UploadImageResponse } from "./types/upload";
import type { ColorPaletteResponse } from "./types/colorPalette";

/**
 * M2.1-S08: reconstrucción del Workspace vía URL (reload/deep-link) y
 * actualización de la URL al abrirlo desde el flujo normal. `UploadPanel`/
 * `ColorPalettePanel` se mockean con stubs mínimos para llegar al estado
 * "proyecto activo + paleta confirmada" sin replicar toda su lógica interna
 * (ya cubierta por sus propios tests) -- acá el foco es la orquestación de
 * navegación que vive en App.tsx.
 */

vi.mock("./components/upload/UploadPanel", () => ({
  UploadPanel: ({ onProjectCreated }: { onProjectCreated: (project: UploadImageResponse | null) => void }) => (
    <button
      type="button"
      onClick={() =>
        onProjectCreated({
          projectId: PROJECT_ID,
          imageId: IMAGE_ID,
          filename: "logo.png",
          mimeType: "image/png",
          bytes: 4096,
          width: 320,
          height: 240,
          status: "uploaded",
        })
      }
    >
      Simular carga completa
    </button>
  ),
}));

vi.mock("./components/colorPalette/ColorPalettePanel", () => ({
  ColorPalettePanel: ({ onConfirmed }: { onConfirmed: (palette: ColorPaletteResponse) => void }) => (
    <button
      type="button"
      onClick={() =>
        onConfirmed({
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
          groups: [],
          previewUrl: "/preview",
          isConfirmed: true,
          cached: false,
        })
      }
    >
      Simular confirmación de paleta
    </button>
  ),
}));

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const IMAGE_ID = "22222222-2222-2222-2222-222222222222";
const PALETTE_ID = "33333333-3333-3333-3333-333333333333";
const GROUP_A_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const GROUP_B_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const VECTOR_A_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const VECTOR_B_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const LAYER_SET_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

const SVG_TEXT = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><path d="M0,0 L10,0 L10,10 Z" fill="#ff0000" /></svg>`;

const METADATA_URL_PATTERN = new RegExp(`/images/${IMAGE_ID}$`);

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

function healthResponse(): Response {
  return jsonResponse({
    status: "online",
    timestamp: new Date().toISOString(),
    api: { status: "online" },
    python: { status: "online", service: "vectorify-python-engine", version: "0.1.0", message: null },
  });
}

function metadataResponse(overrides: Record<string, unknown> = {}) {
  return {
    projectId: PROJECT_ID,
    imageId: IMAGE_ID,
    filename: "logo.png",
    mimeType: "image/png",
    bytes: 4096,
    width: 320,
    height: 240,
    status: "uploaded",
    ...overrides,
  };
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

function layerSetResponse() {
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
  };
}

/**
 * Layout PERSISTIDO no trivial (M2.1-S07): Azul queda primero (order 0,
 * oculta, bloqueada) y Rojo segundo (order 1, visible, sin bloquear) -- así
 * la reconstrucción por URL se verifica contra un estado que NO es el
 * default ("todo visible, sin bloquear, orden de detección"), sino el que
 * realmente quedó persistido.
 */
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
      { id: GROUP_A_ID, name: "Rojo", colorHex: "#ff0000", fill: "#ff0000", vectorId: VECTOR_A_ID, svgUrl: `/vectors/${VECTOR_A_ID}`, pathCount: 3, componentCount: 1, manufacturingOperation: "cut", visible: true, locked: false, order: 1, rasterValidation: { ownMismatchRatio: 0, ownMismatchTolerance: 0.02, ownMismatchWithinTolerance: true, contaminationRatio: 0, contaminationTolerance: 0.02, contaminationWithinTolerance: true, warnings: [] } },
      { id: GROUP_B_ID, name: "Azul", colorHex: "#0000ff", fill: "#0000ff", vectorId: VECTOR_B_ID, svgUrl: `/vectors/${VECTOR_B_ID}`, pathCount: 2, componentCount: null, manufacturingOperation: "unassigned", visible: false, locked: true, order: 0, rasterValidation: { ownMismatchRatio: 0, ownMismatchTolerance: 0.02, ownMismatchWithinTolerance: true, contaminationRatio: 0, contaminationTolerance: 0.02, contaminationWithinTolerance: true, warnings: [] } },
    ],
  };
}

function stubFetch(handler: (url: string) => Response | undefined) {
  const fetch = vi.fn((input: string | URL) => {
    const url = String(input);
    if (/\/system\/health$/.test(url)) return Promise.resolve(healthResponse());
    if (/\/vectors\//.test(url)) return Promise.resolve(new Response(SVG_TEXT, { status: 200 }));
    const result = handler(url);
    if (result) return Promise.resolve(result);
    // Cualquier otra llamada no relevante para este test (ej. paneles del
    // flujo clásico que también montan al setear activeProject) responde un
    // 404 controlado en vez de rechazar la promesa -- evita unhandled
    // rejections de hooks que no son el foco de este archivo.
    return Promise.resolve(jsonResponse({ code: "not_found", message: "No relevante para este test." }, 404));
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function stubHappyPath(paletteOverrides: Record<string, unknown> = {}) {
  return stubFetch((url) => {
    if (METADATA_URL_PATTERN.test(url)) return jsonResponse(metadataResponse());
    if (url.includes("/layers/consolidated")) return jsonResponse(consolidatedResponse());
    if (/\/layers$/.test(url)) return jsonResponse(layerSetResponse());
    if (url.endsWith(`/color-palette/${PALETTE_ID}`)) return jsonResponse(paletteResponse(paletteOverrides));
    return undefined;
  });
}

describe("App — reapertura del Workspace por URL (M2.1-S08)", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ImmediateResizeObserver);
  });

  afterEach(() => {
    window.history.pushState({}, "", "/");
  });

  it("recargar el navegador dentro del Workspace reconstruye paleta + capas + layout idénticos", async () => {
    stubHappyPath();
    pushWorkspaceLocation({ projectId: PROJECT_ID, imageId: IMAGE_ID, paletteId: PALETTE_ID });

    const first = render(<App />);
    await waitFor(() => expect(screen.getByRole("application")).toBeInTheDocument());

    // Nunca pasó por Upload: saltó directo al Workspace.
    expect(screen.queryByText("Nuevo proyecto")).not.toBeInTheDocument();

    const listBefore = screen.getByRole("list", { name: "Capas del documento (arrastrá para reordenar)" });
    const rowsBefore = within(listBefore).getAllByRole("listitem");
    expect(rowsBefore).toHaveLength(2);
    // Layout persistido: Azul (order 0, oculta, bloqueada) antes que Rojo (order 1).
    // El nombre es un <input> editable (fix round M2.1-S07, Rename) -- se verifica por su value, no por texto.
    expect(within(rowsBefore[0]).getByDisplayValue("Azul")).toBeInTheDocument();
    expect(within(rowsBefore[1]).getByDisplayValue("Rojo")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mostrar la capa Azul" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Desbloquear la capa Azul" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ocultar la capa Rojo" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bloquear la capa Rojo" })).toBeInTheDocument();

    first.unmount();

    // Simula un reload real: remonta el árbol de React con la URL YA
    // seteada (pushWorkspaceLocation de arriba sigue vigente), sin pasar
    // props manualmente -- ver spec.md, sección Tests.
    render(<App />);
    await waitFor(() => expect(screen.getByRole("application")).toBeInTheDocument());

    const listAfter = screen.getByRole("list", { name: "Capas del documento (arrastrá para reordenar)" });
    const rowsAfter = within(listAfter).getAllByRole("listitem");
    expect(rowsAfter).toHaveLength(2);
    expect(within(rowsAfter[0]).getByDisplayValue("Azul")).toBeInTheDocument();
    expect(within(rowsAfter[1]).getByDisplayValue("Rojo")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mostrar la capa Azul" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Desbloquear la capa Azul" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ocultar la capa Rojo" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bloquear la capa Rojo" })).toBeInTheDocument();
  });

  it("abrir el Workspace desde el flujo normal actualiza la URL sin necesidad de recargar", async () => {
    stubHappyPath();
    // M2.2-S08: el flujo de upload ya no es la home -- vive en `?view=new`.
    window.history.pushState({}, "", "/?view=new");
    render(<App />);

    expect(window.location.search).toBe("?view=new");

    fireEvent.click(await screen.findByRole("button", { name: "Simular carga completa" }));
    fireEvent.click(await screen.findByRole("button", { name: "Simular confirmación de paleta" }));

    expect(window.location.search).toBe("?view=new");

    fireEvent.click(await screen.findByRole("button", { name: "Abrir en el Workspace" }));

    expect(window.location.search).toContain(`projectId=${PROJECT_ID}`);
    expect(window.location.search).toContain(`imageId=${IMAGE_ID}`);
    expect(window.location.search).toContain(`paletteId=${PALETTE_ID}`);
  });

  it("proyecto/imagen inexistente en la URL no crashea y muestra un estado vacío honesto", async () => {
    stubFetch((url) => {
      if (METADATA_URL_PATTERN.test(url)) return jsonResponse({ code: "not_found", message: "No existe." }, 404);
      // El deep-link inválido aterriza en Mis proyectos (M2.2-S08): responde su listado vacío.
      if (/\/api\/v2\/projects\?/.test(url)) return jsonResponse({ items: [], page: 1, pageSize: 12, totalCount: 0 });
      return undefined;
    });
    pushWorkspaceLocation({ projectId: PROJECT_ID, imageId: IMAGE_ID, paletteId: PALETTE_ID });

    render(<App />);

    expect(await screen.findByRole("alert", { name: "Enlace del Workspace inválido" })).toHaveTextContent(/ya no existe/);
    // Aterriza en el dashboard (la home), no en el flujo de upload.
    expect(screen.getByRole("heading", { name: "Mis proyectos" })).toBeInTheDocument();
    expect(screen.queryByText("Nuevo proyecto")).not.toBeInTheDocument();
    expect(screen.queryByRole("application")).not.toBeInTheDocument();
    // La URL inválida se limpia: no queda "pegada" con los params del Workspace.
    expect(window.location.search).toBe("");
  });

  it("paleta en la URL existente pero no confirmada reutiliza el emptyReason ya existente", async () => {
    stubHappyPath({ isConfirmed: false });
    pushWorkspaceLocation({ projectId: PROJECT_ID, imageId: IMAGE_ID, paletteId: PALETTE_ID });

    render(<App />);

    expect(
      await screen.findByText("La paleta de colores de este proyecto todavía no fue confirmada."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("application")).not.toBeInTheDocument();
  });
});
