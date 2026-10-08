import Konva from "konva";
import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { abortAwareFetch, svgResponse } from "../../test/abortableFetch";
import { EditorShell } from "./EditorShell";

/**
 * Integración de M3-S03 en el Workspace completo: Fill / Color (Recolor con alcance) / Eyedropper. Una capa = un color de paleta, su identidad
 * es el groupId (nunca el hex): el documento de prueba tiene DOS capas con el mismo hex (Rojo y Rojo 2). Todos los `fetch` respetan
 * AbortSignal (`abortAwareFetch`) y cuentan los POST/PATCH de metadata de capa (las capas creadas en el cliente no deben dispararlos).
 */

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const IMAGE_ID = "22222222-2222-2222-2222-222222222222";
const PALETTE_ID = "33333333-3333-3333-3333-333333333333";
const SAVED_PROJECT_ID = "99999999-9999-9999-9999-999999999999";
const GROUP_A_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const GROUP_B_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const GROUP_C_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const VECTOR_A_ID = "a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1";
const VECTOR_B_ID = "b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b1b1";
const VECTOR_C_ID = "c1c1c1c1-c1c1-c1c1-c1c1-c1c1c1c1c1c1";
const LAYER_SET_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

// Documento 320×240 u (160×120 mm con dimensionWidthMm=160). Rojo: r1 (0..40) y r2 (20..60, arriba). Azul: b1 (100..140).
// Rojo 2: c1 (200..240 × 150..190), con el MISMO hex que Rojo.
const SVG_A = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><path data-vid="r1" d="M0 0 H40 V40 H0 Z" fill="#ff0000"/><path data-vid="r2" d="M20 20 H60 V60 H20 Z" fill="#ff0000"/></svg>`;
const SVG_B = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><path data-vid="b1" d="M100 100 H140 V140 H100 Z" fill="#0000ff"/></svg>`;
const SVG_C = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><path data-vid="c1" d="M200 150 H240 V190 H200 Z" fill="#ff0000"/></svg>`;

const R1 = "M0 0 H40 V40 H0 Z";
const R2 = "M20 20 H60 V60 H20 Z";
const B1 = "M100 100 H140 V140 H100 Z";
const C1 = "M200 150 H240 V190 H200 Z";

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

interface FixtureOptions {
  lockedA?: boolean;
  lockedC?: boolean;
  hiddenB?: boolean;
}

const GROUPS = [
  { groupId: GROUP_A_ID, vectorId: VECTOR_A_ID, name: "Rojo", colorHex: "#ff0000", areaPercent: 40 },
  { groupId: GROUP_B_ID, vectorId: VECTOR_B_ID, name: "Azul", colorHex: "#0000ff", areaPercent: 30 },
  { groupId: GROUP_C_ID, vectorId: VECTOR_C_ID, name: "Rojo 2", colorHex: "#ff0000", areaPercent: 30 },
];

function paletteResponse() {
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
    groups: GROUPS.map((group) => ({ groupId: group.groupId, name: group.name, colorHex: group.colorHex, rgb: { r: 0, g: 0, b: 0 }, pixelCount: 100, areaPercent: group.areaPercent, hasPartialAlpha: false, isExcluded: false, maskUrl: "/mask", isMerged: false })),
    previewUrl: "/preview",
    isConfirmed: true,
    cached: false,
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
    layers: GROUPS.map((group) => ({ groupId: group.groupId, name: group.name, colorHex: group.colorHex, areaPercent: group.areaPercent, hasPartialAlpha: false, vectorId: group.vectorId, svgUrl: `/vectors/${group.vectorId}` })),
    cached: true,
  };
}

function consolidatedResponse(options: FixtureOptions) {
  const validation = { ownMismatchRatio: 0, ownMismatchTolerance: 0.02, ownMismatchWithinTolerance: true, contaminationRatio: 0, contaminationTolerance: 0.02, contaminationWithinTolerance: true, warnings: [] };
  const counts = [2, 1, 1];
  return {
    projectId: PROJECT_ID,
    imageId: IMAGE_ID,
    layerSetId: LAYER_SET_ID,
    version: 1,
    paletteId: PALETTE_ID,
    paletteVersion: 2,
    sourceWidthPx: 320,
    sourceHeightPx: 240,
    layers: GROUPS.map((group, index) => ({
      id: group.groupId,
      name: group.name,
      colorHex: group.colorHex,
      fill: group.colorHex,
      vectorId: group.vectorId,
      svgUrl: `/vectors/${group.vectorId}`,
      pathCount: counts[index],
      componentCount: null,
      manufacturingOperation: index === 0 ? "cut" : "unassigned",
      visible: group.groupId === GROUP_B_ID ? !options.hiddenB : true,
      locked: group.groupId === GROUP_A_ID ? Boolean(options.lockedA) : group.groupId === GROUP_C_ID ? Boolean(options.lockedC) : false,
      order: index,
      rasterValidation: validation,
    })),
  };
}

function savedDocumentResponse(options: FixtureOptions) {
  return {
    projectId: SAVED_PROJECT_ID,
    schemaVersion: 1,
    widthMm: 160,
    heightMm: 120,
    viewBox: "0 0 320 240",
    versionNumber: 1,
    createdAt: "2026-01-01T00:00:00Z",
    layers: GROUPS.map((group, index) => ({
      id: group.groupId,
      name: group.name,
      order: index,
      visible: group.groupId === GROUP_B_ID ? !options.hiddenB : true,
      locked: group.groupId === GROUP_A_ID ? Boolean(options.lockedA) : group.groupId === GROUP_C_ID ? Boolean(options.lockedC) : false,
      manufacturingOperation: index === 0 ? "cut" : "unassigned",
      colorHex: group.colorHex,
      coverage: group.areaPercent,
      isBackground: false,
      svgAssetId: null,
      svgUrl: `/assets/${group.groupId}`,
      pathCount: [2, 1, 1][index],
    })),
  };
}

const SVG_BY_GROUP: Record<string, string> = { [GROUP_A_ID]: SVG_A, [GROUP_B_ID]: SVG_B, [GROUP_C_ID]: SVG_C };

function installFetch(options: FixtureOptions = {}) {
  const fetchMock = abortAwareFetch((url, init) => {
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      // Metadata de capa: la Web API devuelve el layout vigente tras el POST/PATCH (solo debería ocurrir con capas del servidor).
      const patched = /\/layers\/([0-9a-f-]+)$/.exec(url);
      if (method === "PATCH" && patched) {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        const base = savedDocumentResponse(options).layers.find((layer) => layer.id === patched[1]);
        return jsonResponse({ ...base, ...body });
      }
      if (url.endsWith("/reorder")) {
        // La Web API responde con el layout autoritativo: el orden pedido.
        const { orderedGroupIds } = JSON.parse(String(init?.body ?? "{}")) as { orderedGroupIds: string[] };
        return jsonResponse({ entries: orderedGroupIds.map((groupId, index) => ({ groupId, order: index, visible: true, locked: false, name: null })) });
      }
      return jsonResponse({ entries: GROUPS.map((group, index) => ({ groupId: group.groupId, order: index, visible: true, locked: false, name: null })) });
    }
    if (url.includes(`/api/v2/projects/${SAVED_PROJECT_ID}/document`)) return jsonResponse(savedDocumentResponse(options));
    for (const group of GROUPS) {
      if (url.endsWith(`/vectors/${group.vectorId}`) || url.endsWith(`/assets/${group.groupId}`)) return svgResponse(SVG_BY_GROUP[group.groupId]);
    }
    if (url.includes("/layers/consolidated")) return jsonResponse(consolidatedResponse(options));
    if (url.includes("/layers/operations")) return jsonResponse({ projectId: PROJECT_ID, imageId: IMAGE_ID, paletteId: PALETTE_ID, paletteVersion: 2, layerSetId: LAYER_SET_ID, version: 1, operations: [], summary: { cutCount: 0, engraveCount: 0, ignoreCount: 0, unassignedCount: 3, totalCount: 3 } });
    if (/\/layers$/.test(url)) return jsonResponse(layerSetResponse());
    if (url.endsWith(`/color-palette/${PALETTE_ID}`)) return jsonResponse(paletteResponse());
    return jsonResponse({ code: "not_found", message: "No existe." }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** POST/PATCH que modifican metadata de capa (visibilidad, bloqueo, nombre, orden, operación). */
function metadataWrites(fetchMock: ReturnType<typeof installFetch>) {
  return fetchMock.mock.calls.filter(([, init]) => {
    const method = (init as RequestInit | undefined)?.method;
    return method === "POST" || method === "PATCH" || method === "PUT";
  });
}

interface ShellProps {
  colorConfirmThreshold?: number;
  saved?: boolean;
  strict?: boolean;
  minPaths?: number;
}

async function renderShell({ colorConfirmThreshold, saved = false, strict = false, minPaths = 4 }: ShellProps = {}) {
  const shell = (
    <EditorShell
      projectId={PROJECT_ID}
      imageId={IMAGE_ID}
      paletteId={PALETTE_ID}
      projectName="mi-diseño.svg"
      dimensionWidthMm={160}
      savedProjectId={saved ? SAVED_PROJECT_ID : null}
      colorConfirmThreshold={colorConfirmThreshold}
      onClose={vi.fn()}
    />
  );
  const utils = render(strict ? <StrictMode>{shell}</StrictMode> : shell);
  const canvas = await screen.findByRole("application");
  await waitFor(() => expect(Konva.stages[Konva.stages.length - 1]?.find("Path").length).toBeGreaterThanOrEqual(minPaths));
  return { ...utils, canvas };
}

const stage = () => Konva.stages[Konva.stages.length - 1];
const documentPaths = () => stage().getLayers()[0].find("Path") as Konva.Path[];
const pathByData = (d: string) => documentPaths().find((node) => node.data() === d)!;
const GEOMETRY_DIRTY = "Cambios de geometría sin guardar";

// Con escala 1 y contenedor 800×600 sobre un documento 320×240: pantalla = documento + (240, 180).
const toScreen = (x: number, y: number) => ({ clientX: x + 240, clientY: y + 180 });
function click(canvas: HTMLElement, x: number, y: number, options: { shiftKey?: boolean } = {}) {
  fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, ...toScreen(x, y), ...options });
  fireEvent.pointerUp(canvas, { pointerId: 1, ...toScreen(x, y), ...options });
}

const tool = (name: RegExp) => screen.getByRole("button", { name });
const panel = (heading: RegExp) => screen.getByRole("heading", { name: heading }).closest("section")!;
const colorPanel = () => within(panel(/Fill — aplicar color|Color — recolorear/));
const hexField = () => screen.getByLabelText("Color hex") as HTMLInputElement;
const objectRegion = () => within(screen.getByRole("region", { name: "Objeto" }));
const layersList = () => screen.getByRole("list", { name: /Capas del documento/ });
const layerRows = () => within(layersList()).getAllByRole("listitem");
const layerNames = () => within(layersList()).getAllByLabelText(/^Nombre de la capa/).map((input) => (input as HTMLInputElement).value);
const paletteBar = () => screen.getByRole("group", { name: "Paleta confirmada del documento" });
const swatchLabels = () => within(paletteBar()).getAllByRole("button").map((button) => button.getAttribute("aria-label"));
const undoButton = () => screen.getByRole("button", { name: /^Deshacer/ });
const redoButton = () => screen.getByRole("button", { name: /^Rehacer/ });

function typeHex(value: string) {
  fireEvent.change(hexField(), { target: { value } });
  fireEvent.keyDown(hexField(), { key: "Enter" });
}

/** Elige la capa de la paleta DEL PANEL (los swatches del panel dicen "Usar el color de la capa X"). */
function pickSwatch(layerName: string) {
  fireEvent.click(colorPanel().getByRole("button", { name: new RegExp(`^Usar el color de la capa ${layerName} \\(`) }));
}

describe("EditorShell — Eyedropper (M3-S03)", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ImmediateResizeObserver);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("la barra trae Eyedropper (atajo I), Fill y Color habilitados; Eyedropper abre su panel y muestra el color tomado: swatch + NOMBRE DE CAPA + hex", async () => {
    installFetch();
    const { canvas } = await renderShell();
    for (const name of [/^Fill/, /^Color/, /^Eyedropper/]) expect(tool(name)).toBeEnabled();

    fireEvent.click(tool(/^Eyedropper/));
    expect(tool(/^Eyedropper/)).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("heading", { name: /Eyedropper — tomar color/ })).toBeInTheDocument();
    expect(screen.getByText(/ninguno\. Elegilo en la paleta/)).toBeInTheDocument();

    click(canvas, 120, 120); // b1
    const readout = screen.getByText("Color activo:").closest("p")!;
    expect(within(readout).getByText("Azul")).toBeInTheDocument();
    expect(within(readout).getByText("#0000ff")).toBeInTheDocument();
    // No muestrea ni cambia nada: sin selección, sin historial, sin geometría sin guardar.
    expect(screen.queryByRole("region", { name: "Objeto" })).not.toBeInTheDocument();
    expect(undoButton()).toBeDisabled();
    expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();
  });

  it("click en vacío no cambia el color activo; objetos superpuestos toman la capa del de más arriba", async () => {
    installFetch();
    const { canvas } = await renderShell();
    fireEvent.click(tool(/^Eyedropper/));
    click(canvas, 120, 120);
    click(canvas, 300, 20); // vacío
    expect(within(screen.getByText("Color activo:").closest("p")!).getByText("Azul")).toBeInTheDocument();
    click(canvas, 30, 30); // r1 y r2 (Rojo): toma Rojo
    expect(within(screen.getByText("Color activo:").closest("p")!).getByText("Rojo")).toBeInTheDocument();
  });

  it("COLOR COMPARTIDO: tomar un objeto de 'Rojo 2' devuelve la capa 'Rojo 2' (no 'Rojo', aunque tengan el mismo hex)", async () => {
    installFetch();
    const { canvas } = await renderShell();
    fireEvent.click(tool(/^Eyedropper/));
    click(canvas, 220, 170); // c1
    const readout = screen.getByText("Color activo:").closest("p")!;
    expect(within(readout).getByText("Rojo 2")).toBeInTheDocument();
    expect(within(readout).queryByText("Rojo")).not.toBeInTheDocument();
    // La barra de paleta marca ESA capa como color activo (no la otra roja).
    expect(swatchLabels().filter((label) => /\(color activo\)/.test(label ?? ""))).toEqual(["Seleccionar el color Rojo 2 (#ff0000) (color activo)"]);
  });

  it("lee capas BLOQUEADAS (solo lee) pero no las OCULTAS", async () => {
    installFetch({ lockedA: true, hiddenB: true });
    const { canvas } = await renderShell({ minPaths: 3 });
    fireEvent.click(tool(/^Eyedropper/));
    click(canvas, 10, 10); // r1: capa bloqueada -> se toma
    expect(within(screen.getByText("Color activo:").closest("p")!).getByText("Rojo")).toBeInTheDocument();

    click(canvas, 220, 170); // c1 -> Rojo 2
    click(canvas, 120, 120); // b1: capa oculta -> no se toma: el color activo sigue siendo Rojo 2
    expect(within(screen.getByText("Color activo:").closest("p")!).getByText("Rojo 2")).toBeInTheDocument();
  });

  it("el atajo I (con el foco en el canvas) activa el Eyedropper", async () => {
    installFetch();
    const { canvas } = await renderShell();
    canvas.focus();
    fireEvent.keyDown(canvas, { key: "i" });
    expect(tool(/^Eyedropper/)).toHaveAttribute("aria-pressed", "true");
    expect(tool(/^Select/)).toHaveAttribute("aria-pressed", "false");
  });

  it("el color tomado queda como color activo para el siguiente Fill: el panel de Fill lo muestra y su resumen lo usa como destino", async () => {
    installFetch();
    const { canvas } = await renderShell();
    fireEvent.click(tool(/^Eyedropper/));
    click(canvas, 120, 120); // Azul
    fireEvent.click(tool(/^Select/));
    click(canvas, 10, 10); // r1 seleccionado
    fireEvent.click(tool(/^Fill/));
    expect(within(screen.getByText("Color activo:").closest("p")!).getByText("Azul")).toBeInTheDocument();
    const summary = colorPanel().getByRole("region", { name: "Qué se va a modificar" });
    expect(within(summary).getByText("Los objetos se moverán a la capa «Azul» (#0000ff).")).toBeInTheDocument();
  });
});

describe("EditorShell — Fill (M3-S03)", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ImmediateResizeObserver);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("Fill con una capa de la paleta: previsualiza sin tocar la pila de undo y Apply es UN comando que mueve el objeto a la capa por groupId", async () => {
    installFetch();
    const { canvas } = await renderShell();
    click(canvas, 10, 10); // r1
    expect(objectRegion().getByText("Capa").closest("div")).toHaveTextContent("Rojo");

    fireEvent.click(tool(/^Fill/));
    expect(screen.getByRole("heading", { name: /Fill — aplicar color/ })).toBeInTheDocument();
    expect(colorPanel().getByRole("button", { name: "Apply" })).toBeDisabled(); // sin color activo
    pickSwatch("Azul");

    // Previsualización: el Inspector ya muestra la capa nueva del objeto, pero NADA entró al historial ni se marcó como sin guardar.
    expect(objectRegion().getByText("Capa").closest("div")).toHaveTextContent("Azul");
    expect(objectRegion().getByText("Color").closest("div")).toHaveTextContent("#0000FF");
    expect(pathByData(R1).fill()).toBe("#0000ff");
    expect(undoButton()).toBeDisabled();
    expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();
    const summary = colorPanel().getByRole("region", { name: "Qué se va a modificar" });
    expect(within(summary).getByText("Alcance: Selección. Se recolorará 1 objeto en 1 capa.")).toBeInTheDocument();

    fireEvent.click(colorPanel().getByRole("button", { name: "Apply" }));
    expect(screen.getByRole("button", { name: "Deshacer: Rellenar 1 objeto con «Azul»" })).toBeEnabled();
    expect(screen.getByText(GEOMETRY_DIRTY)).toBeInTheDocument();
    expect(screen.getByText(/Rellenar 1 objeto con «Azul» aplicado\./)).toBeInTheDocument();
    expect(objectRegion().getByText("Capa").closest("div")).toHaveTextContent("Azul");
    expect(pathByData(R1).fill()).toBe("#0000ff");
    // El color activo pasó a ser la capa destino y las otras capas no cambiaron.
    expect(pathByData(R2).fill()).toBe("#ff0000");
    expect(pathByData(C1).fill()).toBe("#ff0000");

    // Undo restaura la capa y el color EXACTOS del objeto.
    fireEvent.click(undoButton());
    expect(pathByData(R1).fill()).toBe("#ff0000");
    expect(objectRegion().getByText("Capa").closest("div")).toHaveTextContent("Rojo");
    expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();
    fireEvent.click(redoButton());
    expect(pathByData(R1).fill()).toBe("#0000ff");
    expect(objectRegion().getByText("Capa").closest("div")).toHaveTextContent("Azul");
  });

  it("Fill con un color NUEVO: la capa se crea EXPLÍCITAMENTE (resumen, panel de capas, paleta) en UN comando; undo la elimina y redo la restaura", async () => {
    installFetch();
    const { canvas } = await renderShell();
    click(canvas, 10, 10);
    fireEvent.click(tool(/^Fill/));
    typeHex("#0f0");

    // El resumen anuncia la creación; la previsualización ya muestra la capa nueva en TODOS los paneles.
    const summary = colorPanel().getByRole("region", { name: "Qué se va a modificar" });
    expect(within(summary).getByText(/Se creará la capa nueva «Color #00FF00» \(#00FF00\), sin guardar todavía/)).toBeInTheDocument();
    expect(layerNames()).toEqual(["Rojo", "Azul", "Rojo 2", "Color #00FF00"]);
    expect(within(layerRows()[3]).getByText("nueva")).toBeInTheDocument();
    // La paleta la muestra como capa NUEVA y como el color activo (el que se está aplicando).
    expect(swatchLabels()).toContain("Seleccionar el color Color #00FF00 (#00FF00) (capa nueva) (color activo)");
    expect(pathByData(R1).fill()).toBe("#00FF00");
    expect(undoButton()).toBeDisabled();

    fireEvent.click(colorPanel().getByRole("button", { name: "Apply" }));
    expect(screen.getByRole("button", { name: "Deshacer: Rellenar 1 objeto con el color nuevo #00FF00" })).toBeEnabled();
    expect(screen.getByText(/Se creó la capa nueva «Color #00FF00» \(sin guardar todavía\)\./)).toBeInTheDocument();
    expect(layerNames()).toEqual(["Rojo", "Azul", "Rojo 2", "Color #00FF00"]);
    expect(screen.getByText(GEOMETRY_DIRTY)).toBeInTheDocument();
    expect(objectRegion().getByText("Capa").closest("div")).toHaveTextContent("Color #00FF00");
    expect(objectRegion().getByText("Color").closest("div")).toHaveTextContent("#00FF00");

    // UN solo undo elimina la capa Y devuelve el objeto a su capa y color.
    fireEvent.click(undoButton());
    expect(layerNames()).toEqual(["Rojo", "Azul", "Rojo 2"]);
    expect(swatchLabels().some((label) => /Color #00FF00/.test(label ?? ""))).toBe(false);
    expect(pathByData(R1).fill()).toBe("#ff0000");
    expect(objectRegion().getByText("Capa").closest("div")).toHaveTextContent("Rojo");
    expect(undoButton()).toBeDisabled();
    expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();

    fireEvent.click(redoButton());
    expect(layerNames()).toEqual(["Rojo", "Azul", "Rojo 2", "Color #00FF00"]);
    expect(pathByData(R1).fill()).toBe("#00FF00");
    expect(screen.getByText(GEOMETRY_DIRTY)).toBeInTheDocument();
  });

  it("Cancel (botón o Escape) descarta la previsualización SIN RASTRO: capas, colores, historial y 'sin guardar' como antes; vuelve a Select", async () => {
    installFetch();
    const { canvas } = await renderShell();
    click(canvas, 10, 10);
    fireEvent.click(tool(/^Fill/));
    typeHex("#0f0");
    expect(layerNames()).toContain("Color #00FF00");

    fireEvent.click(colorPanel().getByRole("button", { name: "Cancel" }));
    expect(layerNames()).toEqual(["Rojo", "Azul", "Rojo 2"]);
    expect(pathByData(R1).fill()).toBe("#ff0000");
    expect(undoButton()).toBeDisabled();
    expect(redoButton()).toBeDisabled();
    expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();
    expect(tool(/^Select/)).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("heading", { name: /Fill — aplicar color/ })).not.toBeInTheDocument();

    // Con Escape.
    fireEvent.click(tool(/^Fill/));
    typeHex("#0f0");
    expect(layerNames()).toContain("Color #00FF00");
    fireEvent.keyDown(canvas, { key: "Escape" });
    expect(layerNames()).toEqual(["Rojo", "Azul", "Rojo 2"]);
    expect(undoButton()).toBeDisabled();
    expect(tool(/^Select/)).toHaveAttribute("aria-pressed", "true");
  });

  it("cambiar de herramienta con una previsualización abierta también la descarta sin rastro", async () => {
    installFetch();
    const { canvas } = await renderShell();
    click(canvas, 10, 10);
    fireEvent.click(tool(/^Fill/));
    pickSwatch("Azul");
    expect(pathByData(R1).fill()).toBe("#0000ff");
    fireEvent.click(tool(/^Pan/));
    expect(pathByData(R1).fill()).toBe("#ff0000");
    expect(undoButton()).toBeDisabled();
    expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();
  });

  it("Enter con el foco en el canvas aplica y Escape cancela (Apply/Cancel por teclado)", async () => {
    installFetch();
    const { canvas } = await renderShell();
    click(canvas, 10, 10);
    fireEvent.click(tool(/^Fill/));
    pickSwatch("Azul");
    canvas.focus();
    fireEvent.keyDown(canvas, { key: "Enter" });
    expect(screen.getByRole("button", { name: "Deshacer: Rellenar 1 objeto con «Azul»" })).toBeEnabled();
  });

  it("COLOR COMPARTIDO: un color libre con el hex de una capa existente OFRECE 'Usar la capa «X»' por cada coincidencia y, sin elegir una, crea una capa NUEVA (nunca reutiliza una en silencio)", async () => {
    installFetch();
    const { canvas } = await renderShell();
    click(canvas, 120, 120); // b1 (Azul)
    fireEvent.click(tool(/^Fill/));
    typeHex("#FF0000");

    const matches = within(screen.getByRole("group", { name: "Capas con el mismo color" }));
    expect(matches.getByRole("button", { name: "Usar la capa «Rojo»" })).toBeInTheDocument();
    expect(matches.getByRole("button", { name: "Usar la capa «Rojo 2»" })).toBeInTheDocument();

    // Sin elegir: capa nueva, distinta de las dos rojas (que no se tocan).
    fireEvent.click(colorPanel().getByRole("button", { name: "Apply" }));
    expect(layerNames()).toEqual(["Rojo", "Azul", "Rojo 2", "Color #FF0000"]);
    expect(pathByData(R1).fill()).toBe("#ff0000");
    expect(pathByData(C1).fill()).toBe("#ff0000");
    expect(objectRegion().getByText("Capa").closest("div")).toHaveTextContent("Color #FF0000");
  });

  it("COLOR COMPARTIDO: elegir 'Usar la capa «Rojo 2»' mueve el objeto a ESA capa (por groupId), no a la otra roja", async () => {
    installFetch();
    const { canvas } = await renderShell();
    click(canvas, 120, 120);
    fireEvent.click(tool(/^Fill/));
    typeHex("#FF0000");
    fireEvent.click(screen.getByRole("button", { name: "Usar la capa «Rojo 2»" }));

    expect(within(screen.getByText("Color activo:").closest("p")!).getByText("Rojo 2")).toBeInTheDocument();
    fireEvent.click(colorPanel().getByRole("button", { name: "Apply" }));
    expect(layerNames()).toEqual(["Rojo", "Azul", "Rojo 2"]); // ninguna capa nueva
    expect(objectRegion().getByText("Capa").closest("div")).toHaveTextContent("Rojo 2");
    expect(screen.getByRole("button", { name: "Deshacer: Rellenar 1 objeto con «Rojo 2»" })).toBeEnabled();
  });

  it("un hex inválido muestra el error, no cambia el color activo y no crea nada", async () => {
    installFetch();
    const { canvas } = await renderShell();
    click(canvas, 10, 10);
    fireEvent.click(tool(/^Fill/));
    typeHex("rojo");
    expect(colorPanel().getByRole("alert")).toHaveTextContent(/"rojo" no es un color hex válido/);
    expect(colorPanel().getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(layerNames()).toEqual(["Rojo", "Azul", "Rojo 2"]);
  });

  it("Fill sobre el canvas: el click aplica el color activo al objeto clickeado (un comando); sin color activo lo pide y no cambia nada", async () => {
    installFetch();
    const { canvas } = await renderShell();
    fireEvent.click(tool(/^Fill/));
    click(canvas, 10, 10);
    expect(colorPanel().getByRole("alert")).toHaveTextContent(/Elegí un color/);
    expect(undoButton()).toBeDisabled();

    pickSwatch("Azul");
    click(canvas, 10, 10); // r1
    expect(screen.getByRole("button", { name: "Deshacer: Rellenar 1 objeto con «Azul»" })).toBeEnabled();
    expect(pathByData(R1).fill()).toBe("#0000ff");
    expect(pathByData(R2).fill()).toBe("#ff0000");
    // Sigue en Fill: un segundo click rellena otro objeto como OTRO comando.
    click(canvas, 50, 50); // r2
    expect(pathByData(R2).fill()).toBe("#0000ff");
    fireEvent.click(undoButton());
    expect(pathByData(R2).fill()).toBe("#ff0000");
    expect(pathByData(R1).fill()).toBe("#0000ff");
  });

  it("Fill sobre un objeto de la selección rellena TODA la selección", async () => {
    installFetch();
    const { canvas } = await renderShell();
    click(canvas, 10, 10);
    click(canvas, 50, 50, { shiftKey: true }); // r1 + r2
    fireEvent.click(tool(/^Fill/));
    pickSwatch("Azul");
    click(canvas, 10, 10);
    expect(screen.getByRole("button", { name: "Deshacer: Rellenar 2 objetos con «Azul»" })).toBeEnabled();
    expect(pathByData(R1).fill()).toBe("#0000ff");
    expect(pathByData(R2).fill()).toBe("#0000ff");
  });

  it("capas bloqueadas: un objeto bloqueado NO se rellena (se informa) y una capa destino bloqueada se rechaza con motivo", async () => {
    installFetch({ lockedA: true });
    const { canvas } = await renderShell();
    click(canvas, 10, 10); // r1: capa Rojo bloqueada
    fireEvent.click(tool(/^Fill/));
    pickSwatch("Azul");
    expect(colorPanel().getByRole("alert")).toHaveTextContent(/bloqueadas u ocultas/);
    expect(colorPanel().getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(pathByData(R1).fill()).toBe("#ff0000");

    // Destino bloqueado: el objeto de Azul no puede recibirse en Rojo (bloqueada).
    fireEvent.click(tool(/^Select/));
    click(canvas, 120, 120);
    fireEvent.click(tool(/^Fill/));
    pickSwatch("Rojo");
    expect(colorPanel().getByRole("alert")).toHaveTextContent(/destino «Rojo» está bloqueada/);
    expect(undoButton()).toBeDisabled();
  });

  it("selección mixta (una capa bloqueada + una editable): solo se rellena lo editable y el resumen informa lo omitido", async () => {
    installFetch({ lockedA: true });
    const { canvas } = await renderShell();
    click(canvas, 10, 10); // r1 (bloqueada)
    click(canvas, 120, 120, { shiftKey: true }); // b1
    fireEvent.click(tool(/^Fill/));
    pickSwatch("Rojo 2");
    const summary = colorPanel().getByRole("region", { name: "Qué se va a modificar" });
    expect(within(summary).getByText("1 objeto está en capas bloqueadas y no se modificará.")).toBeInTheDocument();
    fireEvent.click(colorPanel().getByRole("button", { name: "Apply" }));
    expect(screen.getByText(/1 objeto está en capas bloqueadas y no se modificó\./)).toBeInTheDocument();
    expect(pathByData(B1).fill()).toBe("#ff0000");
    expect(pathByData(R1).fill()).toBe("#ff0000");
  });

  it("alcance grande: con el umbral configurable (aquí 2) Apply pide CONFIRMACIÓN; 'Volver' no aplica nada y 'Confirmar' aplica", async () => {
    installFetch();
    const { canvas } = await renderShell({ colorConfirmThreshold: 2 });
    click(canvas, 10, 10);
    click(canvas, 50, 50, { shiftKey: true });
    fireEvent.click(tool(/^Fill/));
    pickSwatch("Azul");
    fireEvent.click(colorPanel().getByRole("button", { name: "Apply" }));

    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("Se recolorarán 2 objetos en 1 capa. ¿Confirmás?");
    expect(undoButton()).toBeDisabled(); // todavía nada aplicado
    expect(within(dialog).getByRole("button", { name: "Confirmar" })).toHaveFocus();

    fireEvent.click(within(dialog).getByRole("button", { name: "Volver" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(undoButton()).toBeDisabled();

    fireEvent.click(colorPanel().getByRole("button", { name: "Apply" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Confirmar" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deshacer: Rellenar 2 objetos con «Azul»" })).toBeEnabled();
  });

  it("con el umbral por defecto (50) un alcance chico NO pide confirmación", async () => {
    installFetch();
    const { canvas } = await renderShell();
    click(canvas, 10, 10);
    click(canvas, 50, 50, { shiftKey: true });
    fireEvent.click(tool(/^Fill/));
    pickSwatch("Azul");
    fireEvent.click(colorPanel().getByRole("button", { name: "Apply" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deshacer: Rellenar 2 objetos con «Azul»" })).toBeEnabled();
  });

  it("Escape dentro de la confirmación vuelve atrás (no cancela todo); el siguiente Escape cancela el panel", async () => {
    installFetch();
    const { canvas } = await renderShell({ colorConfirmThreshold: 1 });
    click(canvas, 10, 10);
    fireEvent.click(tool(/^Fill/));
    pickSwatch("Azul");
    fireEvent.click(colorPanel().getByRole("button", { name: "Apply" }));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    fireEvent.keyDown(canvas, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Fill — aplicar color/ })).toBeInTheDocument();
    fireEvent.keyDown(canvas, { key: "Escape" });
    expect(screen.queryByRole("heading", { name: /Fill — aplicar color/ })).not.toBeInTheDocument();
    expect(undoButton()).toBeDisabled();
  });

  it("Fill sobre el canvas con una selección grande también pide confirmación antes de aplicar", async () => {
    installFetch();
    const { canvas } = await renderShell({ colorConfirmThreshold: 2 });
    click(canvas, 10, 10);
    click(canvas, 50, 50, { shiftKey: true });
    fireEvent.click(tool(/^Fill/));
    pickSwatch("Azul");
    click(canvas, 10, 10);
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Se recolorarán 2 objetos en 1 capa.");
    expect(undoButton()).toBeDisabled();
  });
});

describe("EditorShell — Color / Recolor con alcance (M3-S03)", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ImmediateResizeObserver);
  });
  afterEach(() => vi.unstubAllGlobals());

  const selectLayerRow = (name: string) => fireEvent.click(screen.getByRole("button", { name: `Seleccionar la capa ${name}` }));
  const scopeRadio = (name: RegExp | string) => screen.getByRole("radio", { name }) as HTMLInputElement;

  it("el alcance está SIEMPRE visible; sin selección 'Selección' queda deshabilitado con su motivo, con una selección se habilita y es el alcance inicial", async () => {
    installFetch();
    const { canvas } = await renderShell();
    fireEvent.click(tool(/^Color/));
    expect(screen.getByRole("heading", { name: /Color — recolorear/ })).toBeInTheDocument();
    expect(scopeRadio("Selección (sin selección)")).toBeDisabled();
    expect(scopeRadio("Documento")).toBeEnabled();
    expect(scopeRadio("Capa (sin capa activa)")).toBeDisabled();
    expect(scopeRadio("Documento")).toBeChecked(); // sin selección ni capa activa: el único alcance posible

    fireEvent.click(tool(/^Select/));
    click(canvas, 10, 10);
    fireEvent.click(tool(/^Color/));
    expect(scopeRadio("Selección")).toBeEnabled();
    expect(scopeRadio("Selección")).toBeChecked();
    expect(scopeRadio("Capa")).toBeEnabled(); // seleccionar un objeto activa su capa
  });

  it("alcance Capa: cambia el color de la PROPIA capa (mismo groupId y nombre), actualiza paleta, panel de capas y objetos, y NO toca la otra capa del mismo hex; undo lo restaura", async () => {
    installFetch();
    await renderShell();
    selectLayerRow("Rojo");
    fireEvent.click(tool(/^Color/));
    expect(scopeRadio("Capa")).toBeChecked();
    typeHex("#00ff00");

    const summary = colorPanel().getByRole("region", { name: "Qué se va a modificar" });
    expect(within(summary).getByText("La capa «Rojo» cambia de #ff0000 a #00FF00 y conserva su identidad.")).toBeInTheDocument();
    expect(within(summary).getByText("Alcance: Capa. Se recolorarán 2 objetos en 1 capa.")).toBeInTheDocument();
    // Previsualización: la paleta y los objetos ya cambian, sin historial.
    expect(pathByData(R1).fill()).toBe("#00FF00");
    expect(undoButton()).toBeDisabled();

    fireEvent.click(colorPanel().getByRole("button", { name: "Apply" }));
    expect(screen.getByRole("button", { name: "Deshacer: Recolorear la capa «Rojo» a #00FF00" })).toBeEnabled();
    expect(layerNames()).toEqual(["Rojo", "Azul", "Rojo 2"]); // misma capa: no se creó ninguna
    expect(swatchLabels()).toContain("Seleccionar el color Rojo (#00FF00)");
    expect(swatchLabels()).toContain("Seleccionar el color Rojo 2 (#ff0000)");
    expect(pathByData(R1).fill()).toBe("#00FF00");
    expect(pathByData(R2).fill()).toBe("#00FF00");
    expect(pathByData(C1).fill()).toBe("#ff0000"); // COLOR COMPARTIDO: Rojo 2 no cambia
    expect(screen.getByText(GEOMETRY_DIRTY)).toBeInTheDocument();

    fireEvent.click(undoButton());
    expect(swatchLabels()).toContain("Seleccionar el color Rojo (#ff0000)");
    expect(pathByData(R1).fill()).toBe("#ff0000");
    expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();
    fireEvent.click(redoButton());
    expect(swatchLabels()).toContain("Seleccionar el color Rojo (#00FF00)");
  });

  it("alcance Capa con el color de OTRA capa del mismo hex (swatch): sin fusionar quedan DOS capas con el mismo color y distinta identidad", async () => {
    installFetch();
    await renderShell();
    selectLayerRow("Azul");
    fireEvent.click(tool(/^Color/));
    pickSwatch("Rojo");

    // Se OFRECE fusionar, pero 'No fusionar' es lo elegido.
    const merge = within(screen.getByRole("group", { name: "Capas con el color de destino" }));
    expect(merge.getByRole("radio", { name: /No fusionar/ })).toBeChecked();
    expect(merge.getByRole("radio", { name: /Fusionar con «Rojo»/ })).not.toBeChecked();
    expect(merge.getByRole("radio", { name: /Fusionar con «Rojo 2»/ })).not.toBeChecked();

    fireEvent.click(colorPanel().getByRole("button", { name: "Apply" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(layerNames()).toEqual(["Rojo", "Azul", "Rojo 2"]); // ninguna desapareció
    expect(swatchLabels()).toContain("Seleccionar el color Azul (#FF0000)");
    expect(pathByData(B1).fill()).toBe("#FF0000");
    // Las otras rojas siguen siendo capas distintas con sus propios objetos.
    expect(within(layersList()).getAllByRole("listitem")).toHaveLength(3);
  });

  it("Fusionar con «X» es EXPLÍCITO y CONFIRMADO: mueve todos los objetos, la capa origen queda VACÍA (no se borra) y se informa; undo la deja como estaba", async () => {
    installFetch();
    await renderShell();
    selectLayerRow("Azul");
    fireEvent.click(tool(/^Color/));
    pickSwatch("Rojo 2");
    fireEvent.click(within(screen.getByRole("group", { name: "Capas con el color de destino" })).getByRole("radio", { name: /Fusionar con «Rojo 2»/ }));

    const summary = colorPanel().getByRole("region", { name: "Qué se va a modificar" });
    expect(within(summary).getByText("Se fusiona «Azul» con «Rojo 2»: «Azul» queda vacía (no se elimina).")).toBeInTheDocument();
    fireEvent.click(colorPanel().getByRole("button", { name: "Apply" }));

    // La fusión SIEMPRE pide confirmación.
    expect(screen.getByRole("alertdialog")).toHaveTextContent(/Incluye fusionar capas\. ¿Confirmás\?/);
    expect(undoButton()).toBeDisabled();
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Confirmar" }));

    expect(screen.getByRole("button", { name: "Deshacer: Fusionar «Azul» con «Rojo 2»" })).toBeEnabled();
    expect(layerNames()).toEqual(["Rojo", "Azul", "Rojo 2"]); // «Azul» NO se eliminó
    expect(screen.getByText(/«Azul» quedó vacía \(no se eliminó\)\./)).toBeInTheDocument();
    expect(pathByData(B1).fill()).toBe("#ff0000");

    // La capa vacía sigue en el Inspector, con 0 paths.
    selectLayerRow("Azul");
    expect(screen.getByText("Paths").closest("div")).toHaveTextContent("0");

    // Con una previsualización abierta el historial queda quieto (como en cualquier gesto): se cierra la herramienta y se deshace.
    fireEvent.click(tool(/^Select/));
    fireEvent.click(undoButton());
    expect(pathByData(B1).fill()).toBe("#0000ff");
    selectLayerRow("Azul");
    expect(screen.getByText("Paths").closest("div")).toHaveTextContent("1");
  });

  it("alcance Documento: sustituye el color de una capa elegida y SIEMPRE pide confirmación", async () => {
    installFetch();
    await renderShell();
    fireEvent.click(tool(/^Color/));
    expect(scopeRadio("Documento")).toBeChecked();
    fireEvent.change(screen.getByLabelText("Color de origen (capa)"), { target: { value: GROUP_B_ID } });
    typeHex("#abcdef");
    const summary = colorPanel().getByRole("region", { name: "Qué se va a modificar" });
    expect(within(summary).getByText("Alcance: Documento. Se recolorará 1 objeto en 1 capa.")).toBeInTheDocument();

    fireEvent.click(colorPanel().getByRole("button", { name: "Apply" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent(/Alcance: TODO el documento\./);
    expect(undoButton()).toBeDisabled();
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Confirmar" }));
    expect(screen.getByRole("button", { name: /^Deshacer: Recolorear en el documento «Azul»: #0000FF → #ABCDEF/ })).toBeEnabled();
    expect(swatchLabels()).toContain("Seleccionar el color Azul (#ABCDEF)");
    expect(pathByData(B1).fill()).toBe("#ABCDEF");
  });

  it("alcance Selección desde el panel Color mueve los objetos a la capa elegida (igual que Fill)", async () => {
    installFetch();
    const { canvas } = await renderShell();
    click(canvas, 10, 10);
    fireEvent.click(tool(/^Color/));
    pickSwatch("Rojo 2");
    fireEvent.click(colorPanel().getByRole("button", { name: "Apply" }));
    expect(screen.getByRole("button", { name: "Deshacer: Rellenar 1 objeto con «Rojo 2»" })).toBeEnabled();
    expect(objectRegion().getByText("Capa").closest("div")).toHaveTextContent("Rojo 2");
  });

  it("capa de origen BLOQUEADA: se rechaza con motivo y no cambia nada", async () => {
    installFetch({ lockedA: true });
    await renderShell();
    selectLayerRow("Rojo");
    fireEvent.click(tool(/^Color/));
    typeHex("#00ff00");
    expect(colorPanel().getByRole("alert")).toHaveTextContent(/origen «Rojo» está bloqueada/);
    expect(colorPanel().getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(pathByData(R1).fill()).toBe("#ff0000");
    expect(undoButton()).toBeDisabled();
  });

  it("elegir un color con alcance Selección y luego quitar la selección cambia a un alcance disponible (sin quedar en uno inválido)", async () => {
    installFetch();
    const { canvas } = await renderShell();
    click(canvas, 10, 10);
    fireEvent.click(tool(/^Color/));
    expect(scopeRadio("Selección")).toBeChecked();
    click(canvas, 300, 20); // click en vacío: limpia la selección
    expect(scopeRadio("Selección (sin selección)")).toBeDisabled();
    expect(scopeRadio("Selección (sin selección)")).not.toBeChecked();
  });
});

describe("EditorShell — capas creadas en el cliente: metadata local, sin PATCH (M3-S03)", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ImmediateResizeObserver);
  });
  afterEach(() => vi.unstubAllGlobals());

  async function withNewLayer(options: ShellProps = {}, fixture: FixtureOptions = {}) {
    const fetchMock = installFetch(fixture);
    const rendered = await renderShell(options);
    click(rendered.canvas, 10, 10);
    fireEvent.click(tool(/^Fill/));
    typeHex("#00ff00");
    fireEvent.click(colorPanel().getByRole("button", { name: "Apply" }));
    fireEvent.click(tool(/^Select/));
    expect(layerNames()).toEqual(["Rojo", "Azul", "Rojo 2", "Color #00FF00"]);
    return { ...rendered, fetchMock, writesAfterCreate: metadataWrites(fetchMock).length };
  }

  it("ocultar/mostrar, bloquear, renombrar y cambiar la operación de una capa NUEVA se aplican en local y NO disparan ningún POST/PATCH", async () => {
    const { fetchMock, writesAfterCreate } = await withNewLayer();
    const row = () => within(layerRows()[3]);

    fireEvent.click(row().getByRole("button", { name: "Ocultar la capa Color #00FF00" }));
    expect(row().getByRole("button", { name: "Mostrar la capa Color #00FF00" })).toHaveAttribute("aria-pressed", "false");
    expect(pathByData(R1)).toBeUndefined(); // oculta: sus objetos no se dibujan
    fireEvent.click(row().getByRole("button", { name: "Mostrar la capa Color #00FF00" }));
    expect(pathByData(R1).fill()).toBe("#00FF00");

    fireEvent.click(row().getByRole("button", { name: "Bloquear la capa Color #00FF00" }));
    expect(row().getByRole("button", { name: "Desbloquear la capa Color #00FF00" })).toHaveAttribute("aria-pressed", "true");
    expect(row().getByLabelText("Nombre de la capa Color #00FF00")).toBeDisabled();

    fireEvent.click(row().getByRole("button", { name: "Desbloquear la capa Color #00FF00" }));
    const name = row().getByLabelText("Nombre de la capa Color #00FF00");
    fireEvent.change(name, { target: { value: "Verde fluor" } });
    fireEvent.blur(name);
    expect(layerNames()[3]).toBe("Verde fluor");
    fireEvent.change(row().getByLabelText("Operación de fabricación de la capa Verde fluor"), { target: { value: "engrave" } });
    expect(row().getByLabelText("Operación de fabricación de la capa Verde fluor")).toHaveValue("engrave");

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(metadataWrites(fetchMock)).toHaveLength(writesAfterCreate); // NINGÚN request nuevo
    expect(writesAfterCreate).toBe(0);
  });

  it("las capas del servidor SIGUEN usando su PATCH/POST (control: el contador de requests es válido)", async () => {
    const { fetchMock, writesAfterCreate } = await withNewLayer();
    fireEvent.click(within(layerRows()[0]).getByRole("button", { name: "Bloquear la capa Rojo" }));
    await waitFor(() => expect(metadataWrites(fetchMock).length).toBeGreaterThan(writesAfterCreate));
    expect(String(metadataWrites(fetchMock)[0][0])).toContain(`/layers/${GROUP_A_ID}/lock`);
  });

  it("sesión YA guardada (savedProjectId): una capa nueva tampoco dispara PATCH v2; una capa del servidor sí", async () => {
    const { fetchMock } = await withNewLayer({ saved: true });
    const row = () => within(layerRows()[3]);
    fireEvent.click(row().getByRole("button", { name: "Bloquear la capa Color #00FF00" }));
    fireEvent.click(row().getByRole("button", { name: "Desbloquear la capa Color #00FF00" }));
    const name = row().getByLabelText("Nombre de la capa Color #00FF00");
    fireEvent.change(name, { target: { value: "Verde" } });
    fireEvent.blur(name);
    fireEvent.click(row().getByRole("button", { name: "Ocultar la capa Verde" }));
    fireEvent.change(row().getByLabelText("Operación de fabricación de la capa Verde"), { target: { value: "cut" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(metadataWrites(fetchMock)).toHaveLength(0);
    // La capa nueva tampoco aparece en ningún request (ni siquiera por id).
    expect(fetchMock.mock.calls.some(([url]) => /\/layers\/(?!aaaa|bbbb|cccc)[0-9a-f-]{36}/.test(String(url)))).toBe(false);

    // Control: una capa del servidor sí va por PATCH.
    fireEvent.click(within(layerRows()[0]).getByRole("button", { name: "Bloquear la capa Rojo" }));
    await waitFor(() => expect(metadataWrites(fetchMock)).toHaveLength(1));
    const [url, init] = metadataWrites(fetchMock)[0];
    expect(String(url)).toContain(`/api/v2/projects/${SAVED_PROJECT_ID}/layers/${GROUP_A_ID}`);
    expect((init as RequestInit).method).toBe("PATCH");
  });

  it("reordenar: mover la capa nueva (drag & drop) se resuelve en local, sin request; reordenar las del servidor con una capa nueva presente manda SOLO los ids del servidor", async () => {
    const { fetchMock, writesAfterCreate } = await withNewLayer();
    const dataTransfer = () => {
      const store = new Map<string, string>();
      return { effectAllowed: "", dropEffect: "", setData: (k: string, v: string) => store.set(k, v), getData: (k: string) => store.get(k) ?? "" };
    };
    const drop = (from: number, onto: number) => {
      const rows = layerRows();
      const transfer = dataTransfer();
      fireEvent.dragStart(rows[from], { dataTransfer: transfer });
      fireEvent.dragOver(rows[onto], { dataTransfer: transfer });
      fireEvent.drop(rows[onto], { dataTransfer: transfer });
    };

    drop(3, 0); // la capa nueva arriba de todo
    expect(layerNames()).toEqual(["Color #00FF00", "Rojo", "Azul", "Rojo 2"]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(metadataWrites(fetchMock)).toHaveLength(writesAfterCreate);

    drop(1, 3); // Rojo (servidor) por delante de Rojo 2 -> cambia el orden del servidor
    await waitFor(() => expect(metadataWrites(fetchMock).length).toBeGreaterThan(writesAfterCreate));
    const reorder = metadataWrites(fetchMock).filter(([url]) => String(url).endsWith("/reorder"));
    expect(reorder).toHaveLength(1);
    // El servidor recibe SOLO sus tres capas (nunca el id de la capa nueva), en el orden pedido.
    expect(JSON.parse(String((reorder[0][1] as RequestInit).body))).toEqual({ orderedGroupIds: [GROUP_B_ID, GROUP_A_ID, GROUP_C_ID] });
    // Y la lista muestra EXACTAMENTE el orden pedido, con la capa nueva donde la dejaste.
    expect(layerNames()).toEqual(["Color #00FF00", "Azul", "Rojo", "Rojo 2"]);
  });

  it("una capa nueva BLOQUEADA localmente protege sus objetos: Fill hacia ella se rechaza con motivo", async () => {
    await withNewLayer();
    fireEvent.click(within(layerRows()[3]).getByRole("button", { name: "Bloquear la capa Color #00FF00" }));
    click(screen.getByRole("application"), 120, 120); // b1
    fireEvent.click(tool(/^Fill/));
    fireEvent.click(colorPanel().getByRole("button", { name: /^Usar el color de la capa Color #00FF00/ }));
    expect(colorPanel().getByRole("alert")).toHaveTextContent(/destino «Color #00FF00» está bloqueada/);
  });

  it("Inspector de una capa nueva: sin Laser Checker (no existe en el servidor)", async () => {
    await withNewLayer();
    fireEvent.click(screen.getByRole("button", { name: "Seleccionar la capa Color #00FF00" }));
    expect(screen.queryByRole("button", { name: "Ejecutar Laser Checker" })).not.toBeInTheDocument();
    expect(screen.getByText(/Capa nueva, todavía sin guardar/)).toBeInTheDocument();
    expect(screen.getByText("Paths").closest("div")).toHaveTextContent("1");
  });

  it("Aislar una capa nueva muestra SOLO esa capa", async () => {
    await withNewLayer();
    fireEvent.click(screen.getByRole("button", { name: "Seleccionar la capa Color #00FF00" }));
    fireEvent.click(screen.getByRole("button", { name: "Aislar" }));
    await waitFor(() => expect(documentPaths()).toHaveLength(1));
    expect(documentPaths()[0].data()).toBe(R1);
  });

  it("React StrictMode: crear una capa por Fill, deshacer y rehacer funcionan con los efectos dobles (la previsualización no deja rastro)", async () => {
    installFetch();
    const { canvas } = await renderShell({ strict: true });
    click(canvas, 10, 10);
    fireEvent.click(tool(/^Fill/));
    typeHex("#00ff00");
    expect(layerNames()).toContain("Color #00FF00");
    fireEvent.click(colorPanel().getByRole("button", { name: "Apply" }));
    expect(layerNames()).toEqual(["Rojo", "Azul", "Rojo 2", "Color #00FF00"]);
    fireEvent.click(undoButton());
    expect(layerNames()).toEqual(["Rojo", "Azul", "Rojo 2"]);
    fireEvent.click(redoButton());
    expect(layerNames()).toEqual(["Rojo", "Azul", "Rojo 2", "Color #00FF00"]);
  });
});
