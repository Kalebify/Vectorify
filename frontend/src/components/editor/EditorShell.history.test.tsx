import Konva from "konva";
import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { abortAwareFetch, svgResponse } from "../../test/abortableFetch";
import { expectLastCommand, historyEntries, historyTypes, openHistory } from "../../test/history";
import { EditorShell } from "./EditorShell";

/**
 * Historial de comandos (M3-S12) en el Workspace completo: botones Undo/Redo con la siguiente acción y su motivo, panel de Historial (lista cronológica, posición
 * actual, entradas futuras atenuadas, jumpTo por clic y por teclado, avisos de reinicio/truncado, `aria-live`), atajos, y la metadata de capa DENTRO del historial
 * con su PATCH inverso (método, URL y cuerpo en el mock de `fetch` con AbortSignal y conteo de llamadas), el fallo del PATCH inverso, la deshabilitación mientras
 * está en vuelo y las capas `isNew` sin red. También verifica el TIPO de comando que deja cada ruta real de la UI.
 */

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const IMAGE_ID = "22222222-2222-2222-2222-222222222222";
const PALETTE_ID = "33333333-3333-3333-3333-333333333333";
const GROUP_A_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const GROUP_B_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const VECTOR_A_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const VECTOR_B_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const LAYER_SET_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const SAVED_PROJECT_ID = "99999999-9999-9999-9999-999999999999";

// 160 mm sobre 320 u => 0,5 mm/u. Capa Rojo: r1 (0..40) y r2 (20..60, arriba). Capa Azul: b1 (100..140).
const SVG_A = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><path data-vid="r1" d="M0 0 H40 V40 H0 Z" fill="#ff0000"/><path data-vid="r2" d="M20 20 H60 V60 H20 Z" fill="#ff0000"/></svg>`;
const SVG_B = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><path data-vid="b1" d="M100 100 H140 V140 H100 Z" fill="#0000ff"/></svg>`;

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

// ---- Servidor simulado con estado: responde a lo que escribe la UI y registra cada escritura ----

interface ServerLayer {
  groupId: string;
  name: string;
  colorHex: string;
  vectorId: string;
  order: number;
  visible: boolean;
  locked: boolean;
  operation: string;
}

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown> | undefined;
}

function createServer(mode: "staging" | "saved") {
  const layers: ServerLayer[] = [
    { groupId: GROUP_A_ID, name: "Rojo", colorHex: "#ff0000", vectorId: VECTOR_A_ID, order: 0, visible: true, locked: false, operation: "cut" },
    { groupId: GROUP_B_ID, name: "Azul", colorHex: "#0000ff", vectorId: VECTOR_B_ID, order: 1, visible: true, locked: false, operation: "unassigned" },
  ];
  const calls: Call[] = [];
  const control = {
    /** La próxima escritura que cumpla el predicado responde 500. */
    failWhen: null as null | ((call: Call) => boolean),
    /** La próxima escritura que cumpla el predicado queda en vuelo hasta `release()`. */
    holdWhen: null as null | ((call: Call) => boolean),
    release: null as null | (() => void),
  };

  const sorted = () => [...layers].sort((a, b) => a.order - b.order);
  const validation = { ownMismatchRatio: 0, ownMismatchTolerance: 0.02, ownMismatchWithinTolerance: true, contaminationRatio: 0, contaminationTolerance: 0.02, contaminationWithinTolerance: true, warnings: [] };
  const savedLayer = (layer: ServerLayer) => ({
    id: layer.groupId,
    name: layer.name,
    order: layer.order,
    visible: layer.visible,
    locked: layer.locked,
    manufacturingOperation: layer.operation,
    colorHex: layer.colorHex,
    coverage: 50,
    isBackground: false,
    svgAssetId: null,
    svgUrl: `/assets/${layer.groupId}`,
    pathCount: 2,
  });
  const layoutResponse = () => ({
    projectId: PROJECT_ID,
    imageId: IMAGE_ID,
    paletteId: PALETTE_ID,
    paletteVersion: 2,
    layerSetId: LAYER_SET_ID,
    version: 1,
    entries: sorted().map((layer) => ({ groupId: layer.groupId, order: layer.order, visible: layer.visible, locked: layer.locked, name: layer.name })),
  });
  const operationResponse = () => ({
    projectId: PROJECT_ID,
    imageId: IMAGE_ID,
    paletteId: PALETTE_ID,
    paletteVersion: 2,
    layerSetId: LAYER_SET_ID,
    version: 1,
    operations: sorted().map((layer) => ({ groupId: layer.groupId, name: layer.name, colorHex: layer.colorHex, operation: layer.operation })),
    summary: { cutCount: 1, engraveCount: 0, ignoreCount: 0, unassignedCount: 1, totalCount: 2 },
  });

  const find = (groupId: string) => layers.find((layer) => layer.groupId === groupId)!;

  const fetchMock = abortAwareFetch(async (url, init) => {
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      const call: Call = { method, url, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined };
      calls.push(call);
      if (control.holdWhen?.(call)) {
        control.holdWhen = null;
        await new Promise<void>((resolve) => (control.release = resolve));
      }
      if (control.failWhen?.(call)) {
        control.failWhen = null;
        return jsonResponse({ code: "internal_error", message: "El servidor falló." }, 500);
      }
      const body = call.body ?? {};
      if (mode === "saved") {
        const match = /\/layers\/([0-9a-f-]+)$/.exec(url);
        if (method === "PATCH" && match) {
          const layer = find(match[1]);
          if (typeof body.name === "string") layer.name = body.name;
          if (typeof body.order === "number") layer.order = body.order;
          if (typeof body.visible === "boolean") layer.visible = body.visible;
          if (typeof body.locked === "boolean") layer.locked = body.locked;
          if (typeof body.manufacturingOperation === "string") layer.operation = body.manufacturingOperation;
          return jsonResponse(savedLayer(layer));
        }
      } else {
        const match = /\/layers\/([0-9a-f-]+)\/(visibility|lock|rename|operation)$/.exec(url);
        if (match) {
          const layer = find(match[1]);
          if (match[2] === "visibility") layer.visible = body.visible as boolean;
          if (match[2] === "lock") layer.locked = body.locked as boolean;
          if (match[2] === "rename") layer.name = body.name as string;
          if (match[2] === "operation") {
            layer.operation = body.operation as string;
            return jsonResponse(operationResponse());
          }
          return jsonResponse(layoutResponse());
        }
        if (url.endsWith("/layers/reorder")) {
          (body.orderedGroupIds as string[]).forEach((groupId, index) => (find(groupId).order = index));
          return jsonResponse(layoutResponse());
        }
      }
      return jsonResponse({ code: "not_found", message: "No existe." }, 404);
    }

    if (mode === "saved" && url.includes(`/api/v2/projects/${SAVED_PROJECT_ID}/document`)) {
      return jsonResponse({ projectId: SAVED_PROJECT_ID, schemaVersion: 1, widthMm: 160, heightMm: 120, viewBox: "0 0 320 240", versionNumber: 1, createdAt: "2026-01-01T00:00:00Z", layers: sorted().map(savedLayer) });
    }
    if (url.endsWith(`/vectors/${VECTOR_A_ID}`) || url.endsWith(`/assets/${GROUP_A_ID}`)) return svgResponse(SVG_A);
    if (url.endsWith(`/vectors/${VECTOR_B_ID}`) || url.endsWith(`/assets/${GROUP_B_ID}`)) return svgResponse(SVG_B);
    if (url.includes("/layers/consolidated")) {
      return jsonResponse({
        projectId: PROJECT_ID,
        imageId: IMAGE_ID,
        layerSetId: LAYER_SET_ID,
        version: 1,
        paletteId: PALETTE_ID,
        paletteVersion: 2,
        sourceWidthPx: 320,
        sourceHeightPx: 240,
        layers: sorted().map((layer) => ({
          id: layer.groupId,
          name: layer.name,
          colorHex: layer.colorHex,
          fill: layer.colorHex,
          vectorId: layer.vectorId,
          svgUrl: `/vectors/${layer.vectorId}`,
          pathCount: 2,
          componentCount: null,
          manufacturingOperation: layer.operation,
          visible: layer.visible,
          locked: layer.locked,
          order: layer.order,
          rasterValidation: validation,
        })),
      });
    }
    if (url.includes("/layers/operations")) return jsonResponse(operationResponse());
    if (/\/layers$/.test(url)) {
      return jsonResponse({
        projectId: PROJECT_ID,
        imageId: IMAGE_ID,
        layerSetId: LAYER_SET_ID,
        version: 1,
        paletteId: PALETTE_ID,
        paletteVersion: 2,
        sourceWidthPx: 320,
        sourceHeightPx: 240,
        layers: sorted().map((layer) => ({ groupId: layer.groupId, name: layer.name, colorHex: layer.colorHex, areaPercent: 50, hasPartialAlpha: false, vectorId: layer.vectorId, svgUrl: `/vectors/${layer.vectorId}` })),
        cached: true,
      });
    }
    if (url.endsWith(`/color-palette/${PALETTE_ID}`)) {
      return jsonResponse({
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
        groups: layers.map((layer) => ({ groupId: layer.groupId, name: layer.name, colorHex: layer.colorHex, rgb: { r: 0, g: 0, b: 0 }, pixelCount: 100, areaPercent: 50, hasPartialAlpha: false, isExcluded: false, maskUrl: "/mask", isMerged: false })),
        previewUrl: "/preview",
        isConfirmed: true,
        cached: false,
      });
    }
    return jsonResponse({ code: "not_found", message: "No existe." }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls, layers, control, find };
}

type Server = ReturnType<typeof createServer>;

interface RenderOptions {
  mode?: "staging" | "saved";
  strict?: boolean;
  historyLimit?: number;
}

async function renderShell({ mode = "staging", strict = false, historyLimit }: RenderOptions = {}) {
  const server = createServer(mode);
  const element = (imageId = IMAGE_ID) => (
    <EditorShell
      projectId={PROJECT_ID}
      imageId={imageId}
      paletteId={PALETTE_ID}
      projectName="mi-diseño.svg"
      dimensionWidthMm={160}
      savedProjectId={mode === "saved" ? SAVED_PROJECT_ID : null}
      historyLimit={historyLimit}
      onClose={vi.fn()}
    />
  );
  const utils = render(strict ? <StrictMode>{element()}</StrictMode> : element());
  const canvas = await screen.findByRole("application");
  await waitFor(() => expect(Konva.stages[Konva.stages.length - 1]?.find("Path").length).toBeGreaterThanOrEqual(3));
  const rerenderWith = (imageId: string) => utils.rerender(strict ? <StrictMode>{element(imageId)}</StrictMode> : element(imageId));
  return { ...utils, canvas, server, rerenderWith };
}

// Con transform identidad y contenedor 800×600 sobre un documento 320×240: pantalla = documento + (240, 180).
const toScreen = (x: number, y: number) => ({ clientX: x + 240, clientY: y + 180 });
function click(canvas: HTMLElement, x: number, y: number, options: { shiftKey?: boolean } = {}) {
  fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, ...toScreen(x, y), ...options });
  fireEvent.pointerUp(canvas, { pointerId: 1, ...toScreen(x, y), ...options });
}
function drag(canvas: HTMLElement, from: [number, number], to: [number, number]) {
  fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, ...toScreen(...from) });
  fireEvent.pointerMove(canvas, { pointerId: 1, ...toScreen((from[0] + to[0]) / 2, (from[1] + to[1]) / 2) });
  fireEvent.pointerMove(canvas, { pointerId: 1, ...toScreen(...to) });
  fireEvent.pointerUp(canvas, { pointerId: 1, ...toScreen(...to) });
}
function press(target: Element | Window | Document, key: string, init: KeyboardEventInit = {}) {
  return fireEvent.keyDown(target, { key, ...init });
}

const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement;
const undoButton = () => screen.getByRole("button", { name: /^Deshacer/ }) as HTMLButtonElement;
const redoButton = () => screen.getByRole("button", { name: /^Rehacer/ }) as HTMLButtonElement;
const historyToggle = () => screen.getByRole("button", { name: /^Historial/ }) as HTMLButtonElement;
const layersList = () => screen.getByRole("list", { name: /Capas del documento/ });
const layerNames = () => within(layersList()).getAllByLabelText(/^Nombre de la capa/).map((input) => (input as HTMLInputElement).value);
const GEOMETRY_DIRTY = "Cambios de geometría sin guardar";

function dataTransferStub() {
  const store = new Map<string, string>();
  return { effectAllowed: "", dropEffect: "", setData: (format: string, value: string) => store.set(format, value), getData: (format: string) => store.get(format) ?? "" };
}

/** Renombra una capa desde el panel de capas (commit a blur). */
function renameLayerInPanel(current: string, next: string) {
  const input = within(layersList()).getByLabelText(`Nombre de la capa ${current}`);
  fireEvent.change(input, { target: { value: next } });
  fireEvent.blur(input);
}

async function settle() {
  await waitFor(() => expect(undoButton().title).not.toMatch(/guardándose/));
}

describe("EditorShell — historial: botones Deshacer / Rehacer (M3-S12)", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ImmediateResizeObserver);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sin acciones están deshabilitados y CADA UNO dice por qué (tooltip + descripción accesible)", async () => {
    await renderShell();
    expect(undoButton()).toBeDisabled();
    expect(redoButton()).toBeDisabled();
    expect(undoButton()).toHaveAttribute("title", "Deshacer no disponible: no hay nada que deshacer");
    expect(redoButton()).toHaveAttribute("title", "Rehacer no disponible: no hay nada que rehacer");
    expect(undoButton()).toHaveAccessibleDescription("Deshacer no disponible: no hay nada que deshacer");
    expect(redoButton()).toHaveAccessibleDescription("Rehacer no disponible: no hay nada que rehacer");
  });

  it("muestran la SIGUIENTE acción en su nombre accesible y su tooltip, y la siguen al deshacer y rehacer", async () => {
    const { canvas } = await renderShell();
    drag(canvas, [120, 120], [140, 120]);
    await waitFor(() => expect(undoButton()).toBeEnabled());
    expect(undoButton()).toHaveAccessibleName("Deshacer: Mover 1 objeto");
    expect(undoButton()).toHaveAttribute("title", "Deshacer: Mover 1 objeto (Ctrl+Z)");
    expect(redoButton()).toBeDisabled();

    fireEvent.click(undoButton());
    await waitFor(() => expect(redoButton()).toBeEnabled());
    expect(redoButton()).toHaveAccessibleName("Rehacer: Mover 1 objeto");
    expect(redoButton()).toHaveAttribute("title", "Rehacer: Mover 1 objeto (Ctrl+Shift+Z)");
    expect(undoButton()).toBeDisabled();
    expect(undoButton()).toHaveAttribute("title", "Deshacer no disponible: no hay nada que deshacer");
  });

  it("mientras un cambio de capa se está guardando quedan deshabilitados CON ese motivo, y Ctrl+Z no hace nada", async () => {
    const { canvas, server } = await renderShell();
    drag(canvas, [120, 120], [140, 120]);
    await waitFor(() => expect(undoButton()).toBeEnabled());
    server.control.holdWhen = (call) => call.url.endsWith("/rename");
    renameLayerInPanel("Rojo", "Carmín");
    await waitFor(() => expect(undoButton()).toBeDisabled());
    expect(undoButton()).toHaveAttribute("title", "Deshacer no disponible: hay un cambio de capa guardándose");
    expect(redoButton()).toHaveAttribute("title", "Rehacer no disponible: hay un cambio de capa guardándose");

    press(canvas, "z", { ctrlKey: true });
    expect(field("X (mm)")).toHaveValue("60"); // el drag NO se deshizo

    server.control.release?.();
    await waitFor(() => expect(undoButton()).toBeEnabled());
    expect(undoButton()).toHaveAccessibleName("Deshacer: Renombrar la capa «Rojo» a «Carmín»");
  });
});

describe("EditorShell — panel de Historial (M3-S12)", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ImmediateResizeObserver);
  });
  afterEach(() => vi.unstubAllGlobals());

  /** Tres acciones sobre b1: arrastrar (+20 u), redimensionar a 40 mm desde el Inspector, rotar 90° desde el Inspector. */
  async function threeActions() {
    const shell = await renderShell();
    drag(shell.canvas, [120, 120], [140, 120]);
    await waitFor(() => expect(field("X (mm)")).toHaveValue("60"));
    fireEvent.change(field("Ancho (mm)"), { target: { value: "40" } });
    fireEvent.keyDown(field("Ancho (mm)"), { key: "Enter" });
    await waitFor(() => expect(field("Ancho (mm)")).toHaveValue("40"));
    fireEvent.change(field("Rotación (°)"), { target: { value: "90" } });
    fireEvent.keyDown(field("Rotación (°)"), { key: "Enter" });
    await waitFor(() => expect(field("Rotación (°)")).toHaveValue("90"));
    return shell;
  }

  it("se abre desde el header (aria-expanded/aria-controls) y lista cronológicamente tipo, etiqueta, hora y objetos afectados; la posición actual queda marcada", async () => {
    await threeActions();
    expect(historyToggle()).toHaveTextContent("Historial (3)");
    expect(historyToggle()).toHaveAttribute("aria-expanded", "false");
    expect(historyToggle()).toHaveAttribute("aria-controls", "editor-history-panel");

    fireEvent.click(historyToggle());
    const panel = screen.getByRole("region", { name: "Historial de acciones" });
    expect(panel).toHaveAttribute("id", "editor-history-panel");
    expect(historyToggle()).toHaveAttribute("aria-expanded", "true");
    expect(within(panel).getByText(/El historial dura mientras la sesión esté abierta/)).toBeInTheDocument();

    const items = within(panel).getAllByRole("listitem");
    expect(items).toHaveLength(4); // estado inicial + 3 acciones
    expect(items[0]).toHaveTextContent("Estado inicial");
    expect(historyTypes()).toEqual(["object.move", "object.setBounds", "object.rotate"]);
    const [drag1, resize, rotate] = historyEntries();
    expect(drag1).toHaveTextContent("Mover 1 objeto");
    expect(resize).toHaveTextContent("Redimensionar 1 objeto (Inspector)");
    expect(rotate).toHaveTextContent("Rotar objeto (Inspector)");
    expect(drag1).toHaveTextContent(/\d{2}:\d{2}:\d{2}/);
    expect(drag1).toHaveTextContent("1 objeto · 1 capa");
    // La posición actual es la última acción; las demás no.
    expect(rotate).toHaveAttribute("aria-current", "step");
    expect(rotate).toHaveTextContent("actual");
    expect(drag1).not.toHaveAttribute("aria-current");
    // Todas aplicadas: ninguna atenuada.
    for (const entry of [drag1, resize, rotate]) expect(entry).not.toHaveAttribute("data-future");
    // Anuncio para lectores de pantalla.
    expect(within(panel).getByText("Posición 3 de 3: Rotar objeto (Inspector).")).toBeInTheDocument();
  });

  it("las entradas «futuras» (rehacer) se muestran atenuadas y marcadas; la posición actual se mueve con Deshacer/Rehacer", async () => {
    await threeActions();
    fireEvent.click(undoButton());
    fireEvent.click(undoButton());
    await waitFor(() => expect(field("Ancho (mm)")).toHaveValue("20"));
    const panel = openHistory();
    const [first, second, third] = historyEntries();
    expect(first).toHaveAttribute("aria-current", "step");
    expect(first).not.toHaveAttribute("data-future");
    for (const future of [second, third]) {
      expect(future).toHaveAttribute("data-future", "true");
      expect(future.className).toMatch(/history-panel__entry--future/);
      expect(future).toHaveTextContent("rehacer");
    }
    expect(within(panel).getByText("Posición 1 de 3: Mover 1 objeto.")).toBeInTheDocument();

    fireEvent.click(redoButton());
    await waitFor(() => expect(field("Ancho (mm)")).toHaveValue("40"));
    expect(second).toHaveAttribute("aria-current", "step");
    expect(second).not.toHaveAttribute("data-future");
    expect(third).toHaveAttribute("data-future", "true");
  });

  it("clic en una entrada = jumpTo: deshace/rehace varios pasos de una vez y deja el estado EXACTO de ese punto; «Estado inicial» vuelve al origen", async () => {
    await threeActions();
    const [moved, resized] = historyEntries();
    fireEvent.click(moved); // tras el primer arrastre: X=60 mm, ancho 20 mm, sin rotación
    await waitFor(() => expect(field("Ancho (mm)")).toHaveValue("20"));
    expect(field("X (mm)")).toHaveValue("60");
    expect(field("Rotación (°)")).toHaveValue("0");
    expect(moved).toHaveAttribute("aria-current", "step");
    expect(screen.getByText(GEOMETRY_DIRTY)).toBeInTheDocument();

    fireEvent.click(resized);
    await waitFor(() => expect(field("Ancho (mm)")).toHaveValue("40"));
    expect(field("Rotación (°)")).toHaveValue("0");

    fireEvent.click(within(openHistory()).getByRole("button", { name: /Estado inicial/ }));
    await waitFor(() => expect(field("X (mm)")).toHaveValue("50"));
    expect(field("Ancho (mm)")).toHaveValue("20");
    // De vuelta en el origen: nada que persistir y nada que deshacer.
    expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();
    expect(undoButton()).toBeDisabled();
    expect(redoButton()).toBeEnabled();
    expect(within(openHistory()).getByRole("button", { name: /Estado inicial/ })).toHaveAttribute("aria-current", "step");

    // …y se puede volver hasta la última acción de un salto.
    fireEvent.click(historyEntries()[2]);
    await waitFor(() => expect(field("Rotación (°)")).toHaveValue("90"));
    // 40 × 20 mm girado 90°: la caja pasa a ser 20 × 40 mm.
    expect(field("Ancho (mm)")).toHaveValue("20");
    expect(field("Alto (mm)")).toHaveValue("40");
    expect(redoButton()).toBeDisabled();
  });

  it("una acción nueva tras saltar hacia atrás DESCARTA las entradas futuras", async () => {
    const { canvas } = await threeActions();
    fireEvent.click(historyEntries()[0]);
    await waitFor(() => expect(field("Ancho (mm)")).toHaveValue("20"));
    expect(historyEntries().filter((entry) => entry.dataset.future === "true")).toHaveLength(2);

    drag(canvas, [140, 120], [150, 120]); // b1 (ahora en x 120..160) sigue seleccionado: se arrastra otra vez
    await waitFor(() => expect(historyTypes()).toEqual(["object.move", "object.move"]));
    expect(historyEntries().some((entry) => entry.dataset.future === "true")).toBe(false);
    expect(redoButton()).toBeDisabled();
  });

  it("teclado: el foco entra a la acción actual; ↑/↓/Inicio/Fin mueven el foco entre entradas; son botones (Enter/Espacio los activan); Escape cierra y devuelve el foco al botón", async () => {
    await threeActions();
    fireEvent.click(historyToggle());
    const [, , rotate] = historyEntries();
    expect(rotate).toHaveFocus();
    const initial = within(openHistory()).getByRole("button", { name: /Estado inicial/ });
    const [moved, resized] = historyEntries();

    fireEvent.keyDown(rotate, { key: "ArrowUp" });
    expect(resized).toHaveFocus();
    fireEvent.keyDown(resized, { key: "ArrowUp" });
    expect(moved).toHaveFocus();
    fireEvent.keyDown(moved, { key: "ArrowUp" });
    expect(initial).toHaveFocus();
    fireEvent.keyDown(initial, { key: "ArrowUp" }); // ya es la primera
    expect(initial).toHaveFocus();
    fireEvent.keyDown(initial, { key: "End" });
    expect(rotate).toHaveFocus();
    fireEvent.keyDown(rotate, { key: "ArrowDown" }); // ya es la última
    expect(rotate).toHaveFocus();
    fireEvent.keyDown(rotate, { key: "Home" });
    expect(initial).toHaveFocus();
    fireEvent.keyDown(initial, { key: "ArrowDown" });
    expect(moved).toHaveFocus();

    // Cada entrada es un <button type="button">: Enter y Espacio disparan su clic de forma nativa (jumpTo).
    expect(moved.tagName).toBe("BUTTON");
    expect(moved).toHaveAttribute("type", "button");
    fireEvent.click(moved);
    await waitFor(() => expect(field("Ancho (mm)")).toHaveValue("20"));

    fireEvent.keyDown(moved, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Historial de acciones" })).not.toBeInTheDocument();
    expect(historyToggle()).toHaveFocus();
    expect(historyToggle()).toHaveAttribute("aria-expanded", "false");
  });

  it("los atajos Ctrl/Cmd+Z, Ctrl+Shift+Z y Ctrl+Y siguen funcionando con el panel abierto (también con el foco en una entrada) y NO cierran el panel", async () => {
    await threeActions();
    fireEvent.click(historyToggle());
    const [, , rotate] = historyEntries();
    expect(rotate).toHaveFocus();

    press(rotate, "z", { ctrlKey: true });
    await waitFor(() => expect(field("Rotación (°)")).toHaveValue("0"));
    press(rotate, "z", { ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(field("Rotación (°)")).toHaveValue("90"));
    press(rotate, "z", { metaKey: true });
    await waitFor(() => expect(field("Rotación (°)")).toHaveValue("0"));
    press(rotate, "y", { ctrlKey: true });
    await waitFor(() => expect(field("Rotación (°)")).toHaveValue("90"));
    expect(screen.getByRole("region", { name: "Historial de acciones" })).toBeInTheDocument();
    expect(historyEntries()[2]).toHaveAttribute("aria-current", "step");
  });

  it("el límite descarta lo más viejo y AVISA (en el banner con el panel cerrado y en el panel); «Entendido» lo descarta", async () => {
    await renderShell({ historyLimit: 3 });
    click(screen.getByRole("application"), 120, 120);
    await screen.findByRole("heading", { name: "Objeto" });
    for (const width of ["30", "32", "34", "36", "38"]) {
      fireEvent.change(field("Ancho (mm)"), { target: { value: width } });
      fireEvent.keyDown(field("Ancho (mm)"), { key: "Enter" });
      await waitFor(() => expect(field("Ancho (mm)")).toHaveValue(width));
    }
    expect(historyToggle()).toHaveTextContent("Historial (3)");
    expect(historyToggle().textContent).toContain("⚠");
    const banner = screen.getByText(/El historial guarda las últimas 3 acciones: se descartaron las 2 más antiguas/);
    expect(banner).toBeInTheDocument();

    fireEvent.click(within(banner.closest("p")!).getByRole("button", { name: "Ver historial" }));
    const panel = screen.getByRole("region", { name: "Historial de acciones" });
    expect(within(panel).getByText(/se descartaron las 2 más antiguas/)).toBeInTheDocument();
    expect(historyEntries()).toHaveLength(3);
    fireEvent.click(within(panel).getByRole("button", { name: "Entendido" }));
    expect(screen.queryByText(/se descartaron las 2 más antiguas/)).not.toBeInTheDocument();
    expect(historyToggle().textContent).not.toContain("⚠");
  });

  it("al abrir OTRO documento el historial se reinicia con un aviso visible", async () => {
    const { canvas, rerenderWith } = await renderShell();
    drag(canvas, [120, 120], [140, 120]);
    await waitFor(() => expect(undoButton()).toBeEnabled());

    rerenderWith("99999999-9999-9999-9999-999999999999");
    expect(await screen.findByText(/Se abrió otro documento: el historial empezó de cero \(se descartó 1 acción del historial\)/)).toBeInTheDocument();
    await waitFor(() => expect(undoButton()).toBeDisabled());
    expect(historyToggle()).toHaveTextContent("Historial (0)");
    fireEvent.click(historyToggle());
    expect(within(screen.getByRole("region", { name: "Historial de acciones" })).getByText(/Se abrió otro documento/)).toBeInTheDocument();
  });

  it("React StrictMode: arrastrar, deshacer, rehacer, saltar y renombrar funcionan con efectos dobles", async () => {
    const { canvas, server } = await renderShell({ strict: true });
    drag(canvas, [120, 120], [140, 120]);
    await waitFor(() => expect(field("X (mm)")).toHaveValue("60"));
    press(canvas, "z", { ctrlKey: true });
    await waitFor(() => expect(field("X (mm)")).toHaveValue("50"));
    press(canvas, "y", { ctrlKey: true });
    await waitFor(() => expect(field("X (mm)")).toHaveValue("60"));

    renameLayerInPanel("Rojo", "Carmín");
    await waitFor(() => expect(historyTypes()).toEqual(["object.move", "layer.rename"]));
    expect(server.calls.filter((call) => call.url.endsWith("/rename"))).toHaveLength(1);
    fireEvent.click(historyEntries()[0]);
    await waitFor(() => expect(layerNames()).toContain("Rojo"));
    expect(server.calls.filter((call) => call.url.endsWith("/rename"))).toHaveLength(2);
    expect(server.find(GROUP_A_ID).name).toBe("Rojo");
  });
});

describe("EditorShell — metadata de capa DENTRO del historial: PATCH inverso (sin guardar: sidecars clásicos)", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ImmediateResizeObserver);
  });
  afterEach(() => vi.unstubAllGlobals());

  const writes = (server: Server) => server.calls.map((call) => `${call.method} ${call.url.replace(/^.*\/layers\//, "")} ${JSON.stringify(call.body)}`);

  it("renombrar: entra al historial SOLO tras persistir; deshacer y rehacer re-persisten el nombre anterior/siguiente con el mismo POST (conteo exacto)", async () => {
    const { server } = await renderShell();
    renameLayerInPanel("Rojo", "Carmín");
    await waitFor(() => expect(layerNames()).toContain("Carmín"));
    await waitFor(() => expect(undoButton()).toBeEnabled());
    expect(writes(server)).toEqual([`POST ${GROUP_A_ID}/rename {"name":"Carmín"}`]);
    expect(undoButton()).toHaveAccessibleName("Deshacer: Renombrar la capa «Rojo» a «Carmín»");
    expect(historyTypes()).toEqual(["layer.rename"]);
    // Una edición de metadata NO es geometría sin guardar.
    expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();

    fireEvent.click(undoButton());
    await waitFor(() => expect(layerNames()).toContain("Rojo"));
    await waitFor(() => expect(redoButton()).toBeEnabled());
    expect(writes(server)).toEqual([`POST ${GROUP_A_ID}/rename {"name":"Carmín"}`, `POST ${GROUP_A_ID}/rename {"name":"Rojo"}`]);
    expect(server.find(GROUP_A_ID).name).toBe("Rojo");

    fireEvent.click(redoButton());
    await waitFor(() => expect(layerNames()).toContain("Carmín"));
    expect(server.calls).toHaveLength(3);
    expect(server.calls[2].body).toEqual({ name: "Carmín" });
    expect(server.find(GROUP_A_ID).name).toBe("Carmín");
    // Cada llamada de escritura del mock quedó registrada (con o sin AbortSignal) y ninguna se canceló.
    expect(server.fetchMock.signals.filter((signal) => signal?.aborted)).toHaveLength(0);
  });

  it("bloquear, mostrar/ocultar y cambiar la operación: cada uno es un comando propio (layer.setLocked / setVisible / setOperation) con su POST inverso", async () => {
    const { server } = await renderShell();
    fireEvent.click(screen.getByRole("button", { name: "Bloquear la capa Azul" }));
    await waitFor(() => expect(historyTypes()).toEqual(["layer.setLocked"]));
    fireEvent.click(screen.getByRole("button", { name: "Ocultar la capa Rojo" }));
    await waitFor(() => expect(historyTypes()).toEqual(["layer.setLocked", "layer.setVisible"]));
    fireEvent.change(screen.getByLabelText("Operación de fabricación de la capa Rojo"), { target: { value: "engrave" } });
    await waitFor(() => expect(historyTypes()).toEqual(["layer.setLocked", "layer.setVisible", "layer.setOperation"]));
    expect(writes(server)).toEqual([`POST ${GROUP_B_ID}/lock {"locked":true}`, `POST ${GROUP_A_ID}/visibility {"visible":false}`, `POST ${GROUP_A_ID}/operation {"operation":"engrave"}`]);
    expect(undoButton()).toHaveAccessibleName("Deshacer: Asignar «Grabado» a la capa «Rojo»");

    // Deshacer los tres, de a uno: cada paso re-persiste el valor anterior.
    for (let step = 0; step < 3; step += 1) {
      fireEvent.click(undoButton());
      await waitFor(() => expect(server.calls).toHaveLength(4 + step));
      await waitFor(() => expect(undoButton().title).not.toMatch(/guardándose/));
    }
    expect(writes(server).slice(3)).toEqual([`POST ${GROUP_A_ID}/operation {"operation":"cut"}`, `POST ${GROUP_A_ID}/visibility {"visible":true}`, `POST ${GROUP_B_ID}/lock {"locked":false}`]);
    expect(server.find(GROUP_A_ID)).toMatchObject({ operation: "cut", visible: true });
    expect(server.find(GROUP_B_ID).locked).toBe(false);
    expect(screen.getByRole("button", { name: "Bloquear la capa Azul" })).toBeInTheDocument();
  });

  it("reordenar las capas (arrastrar y soltar): un comando layer.reorder; deshacer re-persiste el orden anterior COMPLETO", async () => {
    const { server } = await renderShell();
    expect(layerNames()).toEqual(["Rojo", "Azul"]);
    const rows = within(layersList()).getAllByRole("listitem");
    const dataTransfer = dataTransferStub();
    fireEvent.dragStart(rows[1], { dataTransfer }); // arrastra Azul sobre Rojo
    fireEvent.dragOver(rows[0], { dataTransfer });
    fireEvent.drop(rows[0], { dataTransfer });
    await waitFor(() => expect(layerNames()).toEqual(["Azul", "Rojo"]));
    await waitFor(() => expect(historyTypes()).toEqual(["layer.reorder"]));
    expect(writes(server)).toEqual([`POST reorder ${JSON.stringify({ orderedGroupIds: [GROUP_B_ID, GROUP_A_ID] })}`]);

    fireEvent.click(undoButton());
    await waitFor(() => expect(layerNames()).toEqual(["Rojo", "Azul"]));
    expect(writes(server)[1]).toBe(`POST reorder ${JSON.stringify({ orderedGroupIds: [GROUP_A_ID, GROUP_B_ID] })}`);
    await waitFor(() => expect(redoButton()).toBeEnabled());
    fireEvent.click(redoButton());
    await waitFor(() => expect(layerNames()).toEqual(["Azul", "Rojo"]));
    expect(server.calls).toHaveLength(3);
  });

  it("PATCH INVERSO que falla: el estado local queda INTACTO, el puntero no se mueve, hay un error visible, Deshacer sigue disponible y reintentar funciona", async () => {
    const { canvas, server } = await renderShell();
    renameLayerInPanel("Rojo", "Carmín");
    await waitFor(() => expect(historyTypes()).toEqual(["layer.rename"]));
    drag(canvas, [120, 120], [140, 120]);
    await waitFor(() => expect(historyTypes()).toEqual(["layer.rename", "object.move"]));

    fireEvent.click(undoButton()); // deshace el arrastre (geometría, sin red)
    await waitFor(() => expect(field("X (mm)")).toHaveValue("50"));
    server.control.failWhen = (call) => call.url.endsWith("/rename");
    fireEvent.click(undoButton()); // deshace el rename: el POST inverso falla
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/No se pudo deshacer el cambio de la capa «Rojo»: el servidor no lo aceptó\. No se modificó nada; podés reintentar\./);
    // Nada cambió: el nombre sigue siendo «Carmín» en la UI y en el servidor, y el puntero está donde estaba (la acción de rename sigue aplicada).
    expect(layerNames()).toContain("Carmín");
    expect(server.find(GROUP_A_ID).name).toBe("Carmín");
    expect(within(openHistory()).getAllByRole("listitem").filter((item) => item.querySelector("[aria-current='step']"))[0]).toHaveTextContent("Renombrar la capa");
    expect(undoButton()).toBeEnabled();
    expect(undoButton()).toHaveAccessibleName("Deshacer: Renombrar la capa «Rojo» a «Carmín»");
    expect(server.calls.filter((call) => call.url.endsWith("/rename"))).toHaveLength(2);

    // Reintentar: el mismo POST inverso, ahora sí.
    fireEvent.click(undoButton());
    await waitFor(() => expect(layerNames()).toContain("Rojo"));
    expect(server.calls.filter((call) => call.url.endsWith("/rename"))).toHaveLength(3);
    expect(server.calls[2].body).toEqual({ name: "Rojo" });
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("el cambio ORIGINAL que falla no entra al historial: la capa vuelve a como estaba y el error queda visible", async () => {
    const { server } = await renderShell();
    server.control.failWhen = (call) => call.url.endsWith("/lock");
    fireEvent.click(screen.getByRole("button", { name: "Bloquear la capa Rojo" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/No se pudo guardar el cambio de la capa «Rojo» en el servidor\. No se modificó nada\./);
    await waitFor(() => expect(screen.getByRole("button", { name: "Bloquear la capa Rojo" })).toBeInTheDocument()); // rollback optimista
    expect(undoButton()).toBeDisabled();
    expect(historyToggle()).toHaveTextContent("Historial (0)");
    // Cerrar el aviso.
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Cerrar" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("con un PATCH inverso EN VUELO Deshacer/Rehacer están deshabilitados (tooltip con el motivo), Ctrl+Z no dispara otra llamada y el panel no deja saltar; al terminar vuelve todo", async () => {
    const { canvas, server } = await renderShell();
    renameLayerInPanel("Rojo", "Carmín");
    await waitFor(() => expect(historyTypes()).toEqual(["layer.rename"]));
    drag(canvas, [120, 120], [140, 120]);
    await waitFor(() => expect(historyTypes()).toEqual(["layer.rename", "object.move"]));
    fireEvent.click(undoButton());
    await waitFor(() => expect(field("X (mm)")).toHaveValue("50"));

    server.control.holdWhen = (call) => call.url.endsWith("/rename");
    fireEvent.click(undoButton());
    await waitFor(() => expect(server.calls.filter((call) => call.url.endsWith("/rename"))).toHaveLength(2));
    await waitFor(() => expect(undoButton()).toBeDisabled());
    expect(redoButton()).toBeDisabled();
    expect(undoButton()).toHaveAttribute("title", "Deshacer no disponible: hay un cambio de capa guardándose");
    press(canvas, "z", { ctrlKey: true });
    press(canvas, "y", { ctrlKey: true });
    expect(server.calls.filter((call) => call.url.endsWith("/rename"))).toHaveLength(2);
    for (const entry of historyEntries()) expect(entry).toBeDisabled();
    expect(within(openHistory()).getByText(/Guardando un cambio de capa en el servidor/)).toBeInTheDocument();

    server.control.release?.();
    await waitFor(() => expect(layerNames()).toContain("Rojo"));
    await waitFor(() => expect(redoButton()).toBeEnabled());
    expect(server.calls.filter((call) => call.url.endsWith("/rename"))).toHaveLength(2);
    for (const entry of historyEntries()) expect(entry).toBeEnabled();
  });

  it("un salto del panel que cruza metadata espera cada POST inverso y deja el estado exacto (sin geometría ni nombre de más)", async () => {
    const { canvas, server } = await renderShell();
    drag(canvas, [120, 120], [140, 120]);
    await waitFor(() => expect(historyTypes()).toEqual(["object.move"]));
    renameLayerInPanel("Rojo", "Carmín");
    await waitFor(() => expect(historyTypes()).toEqual(["object.move", "layer.rename"]));
    fireEvent.click(screen.getByRole("button", { name: "Bloquear la capa Azul" }));
    await waitFor(() => expect(historyTypes()).toEqual(["object.move", "layer.rename", "layer.setLocked"]));

    fireEvent.click(within(openHistory()).getByRole("button", { name: /Estado inicial/ }));
    await waitFor(() => expect(field("X (mm)")).toHaveValue("50"));
    await waitFor(() => expect(layerNames()).toEqual(["Rojo", "Azul"]));
    expect(server.find(GROUP_A_ID).name).toBe("Rojo");
    expect(server.find(GROUP_B_ID).locked).toBe(false);
    expect(writes(server).slice(2)).toEqual([`POST ${GROUP_B_ID}/lock {"locked":false}`, `POST ${GROUP_A_ID}/rename {"name":"Rojo"}`]);
    await waitFor(() => expect(redoButton()).toBeEnabled());

    // Hacia adelante otra vez: re-persiste los valores siguientes.
    fireEvent.click(historyEntries()[2]);
    await waitFor(() => expect(server.find(GROUP_B_ID).locked).toBe(true));
    expect(server.find(GROUP_A_ID).name).toBe("Carmín");
    expect(server.calls).toHaveLength(6);
  });

  it("una primera asignación de operación en un proyecto SIN guardar no entra al historial (el sidecar no acepta volver a «sin asignar») y lo avisa", async () => {
    const { server } = await renderShell();
    fireEvent.change(screen.getByLabelText("Operación de fabricación de la capa Azul"), { target: { value: "ignore" } });
    await waitFor(() => expect(server.calls).toHaveLength(1));
    expect(server.calls[0].body).toEqual({ operation: "ignore" });
    expect(await screen.findByText(/la primera asignación no se puede deshacer/)).toBeInTheDocument();
    expect(historyToggle()).toHaveTextContent("Historial (0)");
    expect(undoButton()).toBeDisabled();
    // Cambiarla de nuevo (ya asignada) SÍ es reversible.
    fireEvent.change(screen.getByLabelText("Operación de fabricación de la capa Azul"), { target: { value: "cut" } });
    await waitFor(() => expect(historyTypes()).toEqual(["layer.setOperation"]));
    fireEvent.click(undoButton());
    await waitFor(() => expect(server.calls).toHaveLength(3));
    expect(server.calls[2].body).toEqual({ operation: "ignore" });
  });
});

describe("EditorShell — metadata de capa con un proyecto GUARDADO: PATCH v2 y su PATCH inverso", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ImmediateResizeObserver);
  });
  afterEach(() => vi.unstubAllGlobals());

  const patchUrl = (groupId: string) => `/api/v2/projects/${SAVED_PROJECT_ID}/layers/${groupId}`;
  const patches = (server: Server) => server.calls.map((call) => ({ method: call.method, path: call.url.replace(/^https?:\/\/[^/]+/, ""), body: call.body }));

  it("renombrar: PATCH con {name}; deshacer y rehacer repiten el MISMO PATCH (método, URL y cuerpo) con el valor anterior/siguiente", async () => {
    const { server } = await renderShell({ mode: "saved" });
    renameLayerInPanel("Rojo", "Carmín");
    await waitFor(() => expect(historyTypes()).toEqual(["layer.rename"]));
    fireEvent.click(undoButton());
    await waitFor(() => expect(layerNames()).toContain("Rojo"));
    await waitFor(() => expect(redoButton()).toBeEnabled());
    fireEvent.click(redoButton());
    await waitFor(() => expect(layerNames()).toContain("Carmín"));
    expect(patches(server)).toEqual([
      { method: "PATCH", path: patchUrl(GROUP_A_ID), body: { name: "Carmín" } },
      { method: "PATCH", path: patchUrl(GROUP_A_ID), body: { name: "Rojo" } },
      { method: "PATCH", path: patchUrl(GROUP_A_ID), body: { name: "Carmín" } },
    ]);
    expect(server.fetchMock.signals.filter((signal) => signal?.aborted)).toHaveLength(0);
  });

  it("bloquear / ocultar / operación: PATCH por campo; la operación puede volver a «unassigned» (el PATCH v2 lo acepta)", async () => {
    const { server } = await renderShell({ mode: "saved" });
    fireEvent.click(screen.getByRole("button", { name: "Bloquear la capa Azul" }));
    await waitFor(() => expect(historyTypes()).toEqual(["layer.setLocked"]));
    fireEvent.click(screen.getByRole("button", { name: "Ocultar la capa Rojo" }));
    await waitFor(() => expect(historyTypes()).toEqual(["layer.setLocked", "layer.setVisible"]));
    // El selector de operación de una capa bloqueada está deshabilitado: se usa la capa sin bloquear (Rojo ya tiene «cut»).
    fireEvent.change(screen.getByLabelText("Operación de fabricación de la capa Rojo"), { target: { value: "ignore" } });
    await waitFor(() => expect(historyTypes()).toEqual(["layer.setLocked", "layer.setVisible", "layer.setOperation"]));
    await waitFor(() => expect(undoButton()).toBeEnabled());

    for (let step = 0; step < 3; step += 1) {
      fireEvent.click(undoButton());
      await waitFor(() => expect(server.calls).toHaveLength(4 + step));
      await waitFor(() => expect(undoButton().title).not.toMatch(/guardándose/));
    }
    expect(patches(server)).toEqual([
      { method: "PATCH", path: patchUrl(GROUP_B_ID), body: { locked: true } },
      { method: "PATCH", path: patchUrl(GROUP_A_ID), body: { visible: false } },
      { method: "PATCH", path: patchUrl(GROUP_A_ID), body: { manufacturingOperation: "ignore" } },
      { method: "PATCH", path: patchUrl(GROUP_A_ID), body: { manufacturingOperation: "cut" } },
      { method: "PATCH", path: patchUrl(GROUP_A_ID), body: { visible: true } },
      { method: "PATCH", path: patchUrl(GROUP_B_ID), body: { locked: false } },
    ]);
  });

  it("deshacer la PRIMERA asignación de operación (de «sin asignar») re-persiste «unassigned» con el PATCH v2", async () => {
    const { server } = await renderShell({ mode: "saved" });
    fireEvent.change(screen.getByLabelText("Operación de fabricación de la capa Azul"), { target: { value: "engrave" } });
    await waitFor(() => expect(historyTypes()).toEqual(["layer.setOperation"]));
    await waitFor(() => expect(undoButton()).toBeEnabled());
    fireEvent.click(undoButton());
    await waitFor(() => expect(server.calls).toHaveLength(2));
    expect(patches(server)[1]).toEqual({ method: "PATCH", path: patchUrl(GROUP_B_ID), body: { manufacturingOperation: "unassigned" } });
    expect(server.find(GROUP_B_ID).operation).toBe("unassigned");
    await waitFor(() => expect(screen.getByLabelText("Operación de fabricación de la capa Azul")).toHaveValue("unassigned"));
  });

  it("reordenar: un PATCH {order} por capa que cambió; deshacer los repite con el orden anterior", async () => {
    const { server } = await renderShell({ mode: "saved" });
    const rows = within(layersList()).getAllByRole("listitem");
    const dataTransfer = dataTransferStub();
    fireEvent.dragStart(rows[1], { dataTransfer });
    fireEvent.dragOver(rows[0], { dataTransfer });
    fireEvent.drop(rows[0], { dataTransfer });
    await waitFor(() => expect(layerNames()).toEqual(["Azul", "Rojo"]));
    await waitFor(() => expect(historyTypes()).toEqual(["layer.reorder"]));
    expect(patches(server)).toEqual([
      { method: "PATCH", path: patchUrl(GROUP_B_ID), body: { order: 0 } },
      { method: "PATCH", path: patchUrl(GROUP_A_ID), body: { order: 1 } },
    ]);

    fireEvent.click(undoButton());
    await waitFor(() => expect(layerNames()).toEqual(["Rojo", "Azul"]));
    expect(patches(server).slice(2)).toEqual([
      { method: "PATCH", path: patchUrl(GROUP_A_ID), body: { order: 0 } },
      { method: "PATCH", path: patchUrl(GROUP_B_ID), body: { order: 1 } },
    ]);
  });

  it("PATCH inverso que falla: estado intacto (nombre y puntero), error visible; sin escritura optimista previa no hay parpadeo que revertir", async () => {
    const { server } = await renderShell({ mode: "saved" });
    renameLayerInPanel("Rojo", "Carmín");
    await waitFor(() => expect(historyTypes()).toEqual(["layer.rename"]));
    server.control.failWhen = () => true;
    fireEvent.click(undoButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(/No se pudo deshacer el cambio de la capa «Rojo»/);
    expect(layerNames()).toContain("Carmín");
    expect(server.find(GROUP_A_ID).name).toBe("Carmín");
    expect(undoButton()).toBeEnabled();
    expect(redoButton()).toBeDisabled();
  });
});

describe("EditorShell — capas creadas en el cliente (isNew): metadata en el historial SIN red", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ImmediateResizeObserver);
  });
  afterEach(() => vi.unstubAllGlobals());

  /** Crea una capa nueva con Fill y un color libre; devuelve cuántas llamadas de escritura se habían hecho hasta ahí. */
  async function withNewLayer(mode: "staging" | "saved") {
    const shell = await renderShell({ mode });
    click(shell.canvas, 120, 120); // b1
    await screen.findByRole("heading", { name: "Objeto" });
    fireEvent.click(screen.getByRole("button", { name: /^Fill/ }));
    const hex = await screen.findByLabelText("Color hex");
    fireEvent.change(hex, { target: { value: "#12ab34" } });
    fireEvent.keyDown(hex, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(layerNames()).toContain("Color #12AB34"));
    await waitFor(() => expect(historyTypes()).toEqual(["object.fill"]));
    return shell;
  }

  it.each(["staging", "saved"] as const)("(%s) renombrar, bloquear, ocultar, cambiar la operación y reordenar la capa nueva: comandos del historial, ninguna llamada de red; undo/redo tampoco", async (mode) => {
    const { server } = await withNewLayer(mode);
    expect(server.calls).toHaveLength(0);

    renameLayerInPanel("Color #12AB34", "Verde lima");
    await waitFor(() => expect(layerNames()).toContain("Verde lima"));
    fireEvent.click(screen.getByRole("button", { name: "Ocultar la capa Verde lima" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Mostrar la capa Verde lima" })).toBeInTheDocument());
    const operationSelect = (name: string) => within(layersList()).getByLabelText(`Operación de fabricación de la capa ${name}`);
    fireEvent.change(operationSelect("Verde lima"), { target: { value: "engrave" } });
    await waitFor(() => expect(operationSelect("Verde lima")).toHaveValue("engrave"));
    fireEvent.click(screen.getByRole("button", { name: "Bloquear la capa Verde lima" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Desbloquear la capa Verde lima" })).toBeInTheDocument());
    await waitFor(() => expect(historyTypes()).toEqual(["object.fill", "layer.rename", "layer.setVisible", "layer.setOperation", "layer.setLocked"]));

    // Reordenar: la capa nueva arrastrada sobre la primera.
    const rows = within(layersList()).getAllByRole("listitem");
    const dataTransfer = dataTransferStub();
    fireEvent.dragStart(rows[2], { dataTransfer });
    fireEvent.dragOver(rows[0], { dataTransfer });
    fireEvent.drop(rows[0], { dataTransfer });
    await waitFor(() => expect(layerNames()[0]).toBe("Verde lima"));
    await waitFor(() => expect(historyTypes()).toHaveLength(6));
    // Reordenar con una capa nueva SÍ persiste el orden de las capas del servidor… solo si ese orden cambió: acá no cambió ⇒ cero llamadas.
    expect(server.calls).toHaveLength(0);

    // Deshacer TODO: vuelve a "Color #12AB34", visible, desbloqueada y sin operación asignada, y deshacer el Fill quita la capa.
    for (let step = 0; step < 5; step += 1) {
      fireEvent.click(undoButton());
      await waitFor(() => expect(historyEntries().filter((entry) => entry.dataset.future !== "true")).toHaveLength(5 - step));
    }
    expect(layerNames()).not.toContain("Verde lima");
    expect(layerNames()).toContain("Color #12AB34");
    expect(layerNames()[layerNames().length - 1]).toBe("Color #12AB34");
    expect(screen.getByRole("button", { name: "Ocultar la capa Color #12AB34" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bloquear la capa Color #12AB34" })).toBeInTheDocument();
    expect(within(layersList()).getByLabelText("Operación de fabricación de la capa Color #12AB34")).toHaveValue("unassigned");
    fireEvent.click(undoButton());
    await waitFor(() => expect(layerNames()).toEqual(["Rojo", "Azul"]));
    expect(historyEntries().every((entry) => entry.dataset.future === "true")).toBe(true);

    // …y rehacer todo, otra vez sin red.
    for (let step = 0; step < 6; step += 1) {
      fireEvent.click(redoButton());
      await waitFor(() => expect(historyEntries().filter((entry) => entry.dataset.future !== "true")).toHaveLength(step + 1));
    }
    expect(layerNames()[0]).toBe("Verde lima");
    expect(screen.getByRole("button", { name: "Desbloquear la capa Verde lima" })).toBeInTheDocument();
    expect(server.calls).toHaveLength(0);
    expect(server.fetchMock.mock.calls.filter(([, init]) => ["POST", "PATCH", "PUT"].includes((init as RequestInit | undefined)?.method ?? "GET"))).toHaveLength(0);
  });
});

describe("EditorShell — el tipo de comando que deja cada ruta real de la UI (M3-S12)", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ImmediateResizeObserver);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("arrastrar -> object.move; flechas -> object.nudge (ráfaga = UN comando); Suprimir -> object.delete", async () => {
    const { canvas } = await renderShell();
    drag(canvas, [120, 120], [140, 120]);
    await waitFor(() => expect(historyTypes()).toEqual(["object.move"]));
    const [moved] = historyEntries();
    expect(moved).toHaveTextContent("Mover 1 objeto");

    fireEvent.keyDown(canvas, { key: "ArrowRight" });
    fireEvent.keyDown(canvas, { key: "ArrowRight" });
    fireEvent.keyDown(canvas, { key: "ArrowDown", shiftKey: true });
    await waitFor(() => expect(historyTypes()).toEqual(["object.move", "object.nudge"]));
    press(canvas, "Delete");
    await waitFor(() => expect(historyTypes()).toEqual(["object.move", "object.nudge", "object.delete"]));
    expectLastCommand("object.delete");
  });

  it("Inspector: tamaño -> object.setBounds; rotación -> object.rotate", async () => {
    const { canvas } = await renderShell();
    click(canvas, 120, 120);
    await screen.findByRole("heading", { name: "Objeto" });
    fireEvent.change(field("Ancho (mm)"), { target: { value: "30" } });
    fireEvent.keyDown(field("Ancho (mm)"), { key: "Enter" });
    await waitFor(() => expectLastCommand("object.setBounds"));
    fireEvent.change(field("Rotación (°)"), { target: { value: "45" } });
    fireEvent.keyDown(field("Rotación (°)"), { key: "Enter" });
    await waitFor(() => expectLastCommand("object.rotate"));
    expect(historyTypes()).toEqual(["object.setBounds", "object.rotate"]);
  });

  it("portapapeles: cortar -> object.cut, pegar -> object.paste, pegar en el lugar -> object.pasteInPlace, pegar en la capa activa -> object.pasteToLayer, duplicar -> object.duplicate", async () => {
    const { canvas } = await renderShell();
    click(canvas, 10, 10); // r1
    press(canvas, "x", { ctrlKey: true });
    await waitFor(() => expectLastCommand("object.cut"));
    press(canvas, "v", { ctrlKey: true });
    await waitFor(() => expectLastCommand("object.paste"));
    press(canvas, "v", { ctrlKey: true, shiftKey: true });
    await waitFor(() => expectLastCommand("object.pasteInPlace"));
    press(canvas, "v", { ctrlKey: true, altKey: true });
    await waitFor(() => expectLastCommand("object.pasteToLayer"));
    press(canvas, "d", { ctrlKey: true });
    await waitFor(() => expectLastCommand("object.duplicate"));
    expect(historyTypes()).toEqual(["object.cut", "object.paste", "object.pasteInPlace", "object.pasteToLayer", "object.duplicate"]);
    // Los parámetros de las pegadas llevan el desplazamiento y la capa, no geometría.
    const entries = historyEntries();
    expect(entries[1]).toHaveTextContent("1 objeto");
  });

  it("Organizar: alinear -> arrange.align, distribuir -> arrange.distribute, orden de pintado -> arrange.zorder", async () => {
    const { canvas } = await renderShell();
    const bar = within(screen.getByRole("toolbar", { name: "Organizar: alinear, distribuir y orden" }));
    click(canvas, 10, 10); // r1 (debajo de r2 en su capa)
    fireEvent.click(bar.getByRole("button", { name: /^Traer al frente/ }));
    await waitFor(() => expectLastCommand("arrange.zorder"));
    click(canvas, 10, 10);
    click(canvas, 50, 50, { shiftKey: true });
    click(canvas, 110, 110, { shiftKey: true });
    fireEvent.click(bar.getByRole("button", { name: "Alinear a la izquierda" }));
    await waitFor(() => expectLastCommand("arrange.align"));
    fireEvent.click(bar.getByRole("button", { name: "Distribuir verticalmente" }));
    await waitFor(() => expectLastCommand("arrange.distribute"));
    expect(historyTypes()).toEqual(["arrange.zorder", "arrange.align", "arrange.distribute"]);
  });

  it("Rotar / Reflejar: la selección -> selection.rotate / selection.flip; sin selección el documento completo -> document.rotate / document.flip", async () => {
    const { canvas } = await renderShell();
    click(canvas, 110, 110);
    fireEvent.click(screen.getByRole("button", { name: "Rotar 90° horario" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expectLastCommand("selection.rotate"));
    fireEvent.click(screen.getByRole("button", { name: "Reflejar horizontalmente" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expectLastCommand("selection.flip"));

    press(canvas, "Escape"); // sin selección: el alcance pasa a ser TODO el documento
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Objeto" })).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Rotar 90° horario" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expectLastCommand("document.rotate"));
    fireEvent.click(screen.getByRole("button", { name: "Reflejar verticalmente" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expectLastCommand("document.flip"));
    expect(historyTypes()).toEqual(["selection.rotate", "selection.flip", "document.rotate", "document.flip"]);
  });

  it("Crop -> document.crop (con el marco y removeOutside en sus parámetros)", async () => {
    await renderShell();
    fireEvent.click(screen.getByRole("button", { name: /^Crop/ }));
    const width = await screen.findByLabelText("Ancho del recorte (mm)");
    fireEvent.change(width, { target: { value: "100" } });
    fireEvent.keyDown(width, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expectLastCommand("document.crop"));
    expect(historyEntries()[0]).toHaveTextContent("Recortar el área de trabajo");
  });

  it("Fill con un color libre -> object.fill; Recolor de la capa -> object.recolor", async () => {
    const { canvas } = await renderShell();
    click(canvas, 120, 120);
    await screen.findByRole("heading", { name: "Objeto" });
    fireEvent.click(screen.getByRole("button", { name: /^Fill/ }));
    const hex = await screen.findByLabelText("Color hex");
    fireEvent.change(hex, { target: { value: "#12ab34" } });
    fireEvent.keyDown(hex, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expectLastCommand("object.fill"));

    fireEvent.click(screen.getByRole("button", { name: /^Color/ }));
    await screen.findByRole("heading", { name: /Color — recolorear/ });
    const recolorHex = screen.getByLabelText("Color hex");
    fireEvent.change(recolorHex, { target: { value: "#ff00aa" } });
    fireEvent.keyDown(recolorHex, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(historyTypes().length).toBeGreaterThanOrEqual(2));
    expect(historyTypes()[historyTypes().length - 1]).toBe("object.recolor");
  });

  it("renombrar, ocultar, bloquear, operación y orden de capas -> layer.rename / setVisible / setLocked / setOperation / reorder", async () => {
    await renderShell();
    renameLayerInPanel("Rojo", "Carmín");
    await waitFor(() => expectLastCommand("layer.rename"));
    fireEvent.click(screen.getByRole("button", { name: "Ocultar la capa Azul" }));
    await waitFor(() => expectLastCommand("layer.setVisible"));
    fireEvent.click(screen.getByRole("button", { name: "Bloquear la capa Azul" }));
    await waitFor(() => expectLastCommand("layer.setLocked"));
    fireEvent.change(screen.getByLabelText("Operación de fabricación de la capa Carmín"), { target: { value: "ignore" } });
    await waitFor(() => expectLastCommand("layer.setOperation"));
    const rows = within(layersList()).getAllByRole("listitem");
    const dataTransfer = dataTransferStub();
    fireEvent.dragStart(rows[1], { dataTransfer });
    fireEvent.dragOver(rows[0], { dataTransfer });
    fireEvent.drop(rows[0], { dataTransfer });
    await waitFor(() => expectLastCommand("layer.reorder"));
    await settle();
  });
});
