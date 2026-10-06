import Konva from "konva";
import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { abortAwareFetch, svgResponse } from "../../test/abortableFetch";
import { EditorShell } from "./EditorShell";

/**
 * Integración de M3-S01 en el Workspace completo: selección de objetos <-> capas, Inspector numérico, Undo/Redo
 * (botones + teclado), indicador de guardado honesto y aviso de salida. Todos los `fetch` respetan AbortSignal
 * (`abortAwareFetch`, lección de M2.2).
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

// Capa Rojo: r1 (0..40) y r2 (20..60, arriba). Capa Azul: b1 (100..140).
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
    groups: [
      { groupId: GROUP_A_ID, name: "Rojo", colorHex: "#ff0000", rgb: { r: 255, g: 0, b: 0 }, pixelCount: 100, areaPercent: 60, hasPartialAlpha: false, isExcluded: false, maskUrl: "/mask/a", isMerged: false },
      { groupId: GROUP_B_ID, name: "Azul", colorHex: "#0000ff", rgb: { r: 0, g: 0, b: 255 }, pixelCount: 60, areaPercent: 40, hasPartialAlpha: false, isExcluded: false, maskUrl: "/mask/b", isMerged: false },
    ],
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
    layers: [
      { groupId: GROUP_A_ID, name: "Rojo", colorHex: "#ff0000", areaPercent: 60, hasPartialAlpha: false, vectorId: VECTOR_A_ID, svgUrl: `/vectors/${VECTOR_A_ID}` },
      { groupId: GROUP_B_ID, name: "Azul", colorHex: "#0000ff", areaPercent: 40, hasPartialAlpha: false, vectorId: VECTOR_B_ID, svgUrl: `/vectors/${VECTOR_B_ID}` },
    ],
    cached: true,
  };
}

function consolidatedResponse(lockedA = false) {
  const validation = { ownMismatchRatio: 0, ownMismatchTolerance: 0.02, ownMismatchWithinTolerance: true, contaminationRatio: 0, contaminationTolerance: 0.02, contaminationWithinTolerance: true, warnings: [] };
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
      { id: GROUP_A_ID, name: "Rojo", colorHex: "#ff0000", fill: "#ff0000", vectorId: VECTOR_A_ID, svgUrl: `/vectors/${VECTOR_A_ID}`, pathCount: 2, componentCount: 1, manufacturingOperation: "cut", visible: true, locked: lockedA, order: 0, rasterValidation: validation },
      { id: GROUP_B_ID, name: "Azul", colorHex: "#0000ff", fill: "#0000ff", vectorId: VECTOR_B_ID, svgUrl: `/vectors/${VECTOR_B_ID}`, pathCount: 1, componentCount: null, manufacturingOperation: "unassigned", visible: true, locked: false, order: 1, rasterValidation: validation },
    ],
  };
}

function installStagingFetch(options: { lockedA?: boolean } = {}) {
  const fetchMock = abortAwareFetch((url, init) => {
    if (url === `/vectors/${VECTOR_A_ID}` || url.endsWith(`/vectors/${VECTOR_A_ID}`)) return svgResponse(SVG_A);
    if (url === `/vectors/${VECTOR_B_ID}` || url.endsWith(`/vectors/${VECTOR_B_ID}`)) return svgResponse(SVG_B);
    if (url.includes("/layers/consolidated")) return jsonResponse(consolidatedResponse(options.lockedA));
    if (/\/layers\/[0-9a-f-]+\/lock$/.test(url) && init?.method === "POST") {
      return jsonResponse({ entries: [{ groupId: GROUP_A_ID, order: 0, visible: true, locked: true, name: null }, { groupId: GROUP_B_ID, order: 1, visible: true, locked: false, name: null }] });
    }
    if (/\/layers$/.test(url)) return jsonResponse(layerSetResponse());
    if (url.endsWith(`/color-palette/${PALETTE_ID}`)) return jsonResponse(paletteResponse());
    return new Response(JSON.stringify({ code: "not_found", message: "No existe." }), { status: 404, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderShell(props: Partial<React.ComponentProps<typeof EditorShell>> = {}) {
  const onClose = vi.fn();
  const utils = render(
    <EditorShell projectId={PROJECT_ID} imageId={IMAGE_ID} paletteId={PALETTE_ID} projectName="mi-diseño.svg" dimensionWidthMm={160} onClose={onClose} {...props} />,
  );
  return { ...utils, onClose };
}

async function renderLoadedShell(props: Partial<React.ComponentProps<typeof EditorShell>> = {}, minPaths = 3) {
  const utils = renderShell(props);
  const canvas = await screen.findByRole("application");
  await waitFor(() => expect(Konva.stages[Konva.stages.length - 1]?.find("Path").length).toBeGreaterThanOrEqual(minPaths));
  return { ...utils, canvas };
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

const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement;
const GEOMETRY_DIRTY = "Cambios de geometría sin guardar";

describe("EditorShell — edición de objetos (M3-S01)", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ImmediateResizeObserver);
    installStagingFetch();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("el canvas carga las capas desde el estado editable y dibuja un Path por objeto", async () => {
    await renderLoadedShell();
    expect(Konva.stages[Konva.stages.length - 1].getLayers()[0].find("Path")).toHaveLength(3);
  });

  it("React StrictMode: el workspace carga sus capas igual (cleanup/abort de los efectos de carga)", async () => {
    const fetchMock = installStagingFetch();
    render(
      <StrictMode>
        <EditorShell projectId={PROJECT_ID} imageId={IMAGE_ID} paletteId={PALETTE_ID} projectName="x.svg" onClose={vi.fn()} />
      </StrictMode>,
    );
    await screen.findByRole("application");
    await waitFor(() => expect(Konva.stages[Konva.stages.length - 1]?.find("Path").length).toBeGreaterThanOrEqual(3));
    // Hubo cargas abortadas por el cleanup y se reintentaron: el estado final es completo.
    expect(fetchMock.signals.some((signal) => signal?.aborted)).toBe(true);
  });

  it("seleccionar un objeto activa su capa y el Inspector muestra X/Y/ancho/alto en mm (dimensiones aplicadas: 160 mm sobre 320 u)", async () => {
    const { canvas } = await renderLoadedShell();
    expect(screen.queryByRole("heading", { name: "Objeto" })).not.toBeInTheDocument();

    click(canvas, 120, 120); // b1 (capa Azul)
    expect(await screen.findByRole("heading", { name: "Objeto" })).toBeInTheDocument();
    // 0.5 mm por unidad: b1 = (100,100) 40×40 u -> 50, 50, 20×20 mm
    expect(field("X (mm)")).toHaveValue("50");
    expect(field("Ancho (mm)")).toHaveValue("20");
    // Su capa quedó activa: el Inspector de capa muestra el HEX de Azul y la paleta lo marca.
    expect(screen.getByText("#0000ff")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Seleccionar el color Azul/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("documento ya guardado: manda el widthMm del documento (640 mm sobre 320 u => 2 mm por unidad)", async () => {
    const fetchMock = abortAwareFetch((url) => {
      if (url.includes(`/api/v2/projects/${SAVED_PROJECT_ID}/document`)) {
        return jsonResponse({
          projectId: SAVED_PROJECT_ID,
          schemaVersion: 1,
          widthMm: 640,
          heightMm: 480,
          viewBox: "0 0 320 240",
          versionNumber: 1,
          createdAt: "2026-01-01T00:00:00Z",
          layers: [
            { id: GROUP_A_ID, name: "Rojo", order: 0, visible: true, locked: false, manufacturingOperation: "cut", colorHex: "#ff0000", coverage: 60, isBackground: false, svgAssetId: null, svgUrl: `/assets/${GROUP_A_ID}`, pathCount: 2 },
          ],
        });
      }
      if (url.includes("/assets/")) return svgResponse(SVG_A);
      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { canvas } = await renderLoadedShell({ savedProjectId: SAVED_PROJECT_ID, dimensionWidthMm: 10 }, 2);
    click(canvas, 10, 10); // r1: 40×40 u
    expect(await screen.findByLabelText("Ancho (mm)")).toHaveValue("80");
  });

  it("sin dimensiones físicas el Inspector edita en unidades de documento y lo dice", async () => {
    const { canvas } = await renderLoadedShell({ dimensionWidthMm: null });
    click(canvas, 10, 10);
    expect(await screen.findByLabelText("Ancho (u)")).toHaveValue("40");
    expect(screen.getByText(/no tiene dimensiones físicas/)).toBeInTheDocument();
  });

  it("editar el ancho en el Inspector (mm) = UN comando, deshacible; el header lo refleja y NUNCA dice 'Guardado'", async () => {
    const { canvas } = await renderLoadedShell();
    click(canvas, 120, 120);
    await screen.findByRole("heading", { name: "Objeto" });
    expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();

    fireEvent.change(field("Ancho (mm)"), { target: { value: "40" } }); // 40 mm = 80 u
    fireEvent.keyDown(field("Ancho (mm)"), { key: "Enter" });

    await waitFor(() => expect(field("Ancho (mm)")).toHaveValue("40"));
    expect(screen.getByText(GEOMETRY_DIRTY)).toBeInTheDocument();
    expect(screen.queryByText("Guardado")).not.toBeInTheDocument();
    const undo = screen.getByRole("button", { name: "Deshacer: Redimensionar 1 objeto (Inspector)" });
    expect(undo).toBeEnabled();

    fireEvent.click(undo);
    await waitFor(() => expect(field("Ancho (mm)")).toHaveValue("20"));
    // Todo deshecho: ya no hay geometría pendiente.
    expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deshacer" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Rehacer: Redimensionar 1 objeto (Inspector)" }));
    await waitFor(() => expect(field("Ancho (mm)")).toHaveValue("40"));
  });

  it("la miniatura (Preview) refleja las ediciones: la capa editada se dibuja desde memoria y vuelve al original al deshacer", async () => {
    const { canvas, container } = await renderLoadedShell();
    const previewSources = () => Array.from(container.querySelectorAll(".preview-navigator__layer")).map((image) => image.getAttribute("src") ?? "");
    expect(previewSources().every((src) => src.includes("/vectors/"))).toBe(true);

    drag(canvas, [120, 120], [140, 120]); // edita SOLO la capa Azul
    await waitFor(() => expect(previewSources().some((src) => src.startsWith("data:image/svg+xml"))).toBe(true));
    const [red, blue] = previewSources();
    expect(red).toContain(`/vectors/${VECTOR_A_ID}`);
    expect(decodeURIComponent(blue)).toContain('data-vid="b1"');
    expect(decodeURIComponent(blue)).toContain("matrix(1 0 0 1 20 0)");

    fireEvent.keyDown(canvas, { key: "z", ctrlKey: true });
    await waitFor(() => expect(previewSources().every((src) => src.includes("/vectors/"))).toBe(true));
  });

  it("rotación numérica en el Inspector: un comando 'Rotar'", async () => {
    const { canvas } = await renderLoadedShell();
    click(canvas, 120, 120);
    await screen.findByRole("heading", { name: "Objeto" });
    fireEvent.change(field("Rotación (°)"), { target: { value: "90" } });
    fireEvent.keyDown(field("Rotación (°)"), { key: "Enter" });
    await waitFor(() => expect(field("Rotación (°)")).toHaveValue("90"));
    expect(screen.getByRole("button", { name: "Deshacer: Rotar objeto (Inspector)" })).toBeEnabled();
    // 90° alrededor del centro de un cuadrado: mismo bbox.
    expect(field("Ancho (mm)")).toHaveValue("20");
  });

  it("valor inválido en el Inspector: mensaje, ningún comando y el header sigue sin geometría pendiente", async () => {
    const { canvas } = await renderLoadedShell();
    click(canvas, 120, 120);
    await screen.findByRole("heading", { name: "Objeto" });
    fireEvent.change(field("Ancho (mm)"), { target: { value: "ancho" } });
    fireEvent.keyDown(field("Ancho (mm)"), { key: "Enter" });
    expect(await screen.findByText(/no es un número válido/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deshacer" })).toBeDisabled();
    expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();
  });

  it("arrastrar en el canvas: un comando 'Mover', el Inspector sigue al objeto y Undo lo devuelve", async () => {
    const { canvas } = await renderLoadedShell();
    drag(canvas, [120, 120], [140, 120]); // +20 u = +10 mm
    await waitFor(() => expect(field("X (mm)")).toHaveValue("60"));
    expect(screen.getByRole("button", { name: "Deshacer: Mover 1 objeto" })).toBeEnabled();
    expect(screen.getByText(GEOMETRY_DIRTY)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Deshacer: Mover 1 objeto" }));
    await waitFor(() => expect(field("X (mm)")).toHaveValue("50"));
  });

  it("Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y funcionan con el foco en el canvas", async () => {
    const { canvas } = await renderLoadedShell();
    drag(canvas, [120, 120], [140, 120]);
    await waitFor(() => expect(field("X (mm)")).toHaveValue("60"));

    fireEvent.keyDown(canvas, { key: "z", ctrlKey: true });
    await waitFor(() => expect(field("X (mm)")).toHaveValue("50"));
    fireEvent.keyDown(canvas, { key: "z", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(field("X (mm)")).toHaveValue("60"));
    fireEvent.keyDown(canvas, { key: "z", metaKey: true });
    await waitFor(() => expect(field("X (mm)")).toHaveValue("50"));
    fireEvent.keyDown(canvas, { key: "y", ctrlKey: true });
    await waitFor(() => expect(field("X (mm)")).toHaveValue("60"));
  });

  it("Ctrl+Z dentro de un campo de texto del Inspector NO deshace la geometría (es del propio campo)", async () => {
    const { canvas } = await renderLoadedShell();
    drag(canvas, [120, 120], [140, 120]);
    await waitFor(() => expect(field("X (mm)")).toHaveValue("60"));
    fireEvent.keyDown(field("Ancho (mm)"), { key: "z", ctrlKey: true });
    expect(field("X (mm)")).toHaveValue("60");
    expect(screen.getByRole("button", { name: "Deshacer: Mover 1 objeto" })).toBeEnabled();
  });

  it("aviso beforeunload SOLO mientras hay geometría sin persistir", async () => {
    const { canvas } = await renderLoadedShell();
    const unload = () => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(unload()).toBe(false);

    drag(canvas, [120, 120], [140, 120]);
    await waitFor(() => expect(screen.getByText(GEOMETRY_DIRTY)).toBeInTheDocument());
    expect(unload()).toBe(true);

    fireEvent.keyDown(canvas, { key: "z", ctrlKey: true });
    await waitFor(() => expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument());
    expect(unload()).toBe(false);
  });

  it("'← Projects' con geometría sin guardar pide confirmación; cancelar conserva el editor", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { canvas, onClose } = await renderLoadedShell();

    fireEvent.click(screen.getByRole("button", { name: /Volver a la lista de proyectos/ }));
    expect(confirmSpy).not.toHaveBeenCalled(); // sin ediciones: sale directo
    expect(onClose).toHaveBeenCalledTimes(1);

    drag(canvas, [120, 120], [140, 120]);
    await waitFor(() => expect(screen.getByText(GEOMETRY_DIRTY)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Volver a la lista de proyectos/ }));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1); // canceló
    fireEvent.click(screen.getByRole("button", { name: /Volver a la lista de proyectos/ }));
    expect(onClose).toHaveBeenCalledTimes(2); // aceptó
    confirmSpy.mockRestore();
  });

  it("seleccionar OTRA capa desde el panel descarta la selección de objetos; la misma capa la conserva", async () => {
    const { canvas } = await renderLoadedShell();
    click(canvas, 120, 120); // b1 (Azul)
    await screen.findByRole("heading", { name: "Objeto" });

    fireEvent.click(screen.getByRole("button", { name: "Seleccionar la capa Azul" }));
    expect(screen.getByRole("heading", { name: "Objeto" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Seleccionar la capa Rojo" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Objeto" })).not.toBeInTheDocument());
    // El comportamiento de M2.1 sigue: la capa quedó activa en el Inspector de capa.
    expect(screen.getByText("#ff0000")).toBeInTheDocument();
  });

  it("'Seleccionar todo en la capa' selecciona todos los objetos de la capa (multi: 'Varios')", async () => {
    const { canvas } = await renderLoadedShell();
    click(canvas, 10, 10); // r1 -> capa Rojo activa
    await screen.findByRole("heading", { name: "Objeto" });
    fireEvent.click(screen.getByRole("button", { name: "Seleccionar todo en la capa" }));
    expect(await screen.findByRole("heading", { name: "Varios (2 objetos)" })).toBeInTheDocument();
  });

  it("capa bloqueada: el objeto se selecciona, el Inspector queda de solo lectura y arrastrar no lo mueve", async () => {
    installStagingFetch({ lockedA: true });
    const { canvas } = await renderLoadedShell();
    click(canvas, 10, 10);
    expect(await screen.findByLabelText("Ancho (mm)")).toBeDisabled();
    expect(screen.getByText(/La capa Rojo está bloqueada/)).toBeInTheDocument();

    drag(canvas, [10, 10], [40, 40]);
    expect(await screen.findByText(/La capa está bloqueada: no se puede modificar/)).toBeInTheDocument();
    expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deshacer" })).toBeDisabled();
  });

  it("la herramienta Move del toolbar cambia el modo del canvas (sin handles)", async () => {
    const { canvas } = await renderLoadedShell();
    click(canvas, 10, 10);
    const transformer = Konva.stages[Konva.stages.length - 1].findOne("Transformer") as Konva.Transformer;
    await waitFor(() => expect(transformer.nodes()).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: /^Move/ }));
    await waitFor(() => expect(transformer.nodes()).toHaveLength(0));
    expect(screen.getByRole("button", { name: /^Move/ })).toHaveAttribute("aria-pressed", "true");
    expect(within(screen.getByRole("application")).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("falla de red al cargar una capa: aviso visible con 'Reintentar' que recarga SOLO esa capa", async () => {
    let healthy = false;
    const fetchMock = abortAwareFetch((url) => {
      if (url.endsWith(`/vectors/${VECTOR_B_ID}`)) return healthy ? svgResponse(SVG_B) : svgResponse("boom", 500);
      if (url.endsWith(`/vectors/${VECTOR_A_ID}`)) return svgResponse(SVG_A);
      if (url.includes("/layers/consolidated")) return jsonResponse(consolidatedResponse());
      if (/\/layers$/.test(url)) return jsonResponse(layerSetResponse());
      if (url.endsWith(`/color-palette/${PALETTE_ID}`)) return jsonResponse(paletteResponse());
      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderShell();
    await screen.findByRole("application");
    const alert = await within(screen.getByRole("application")).findByRole("alert");
    expect(alert).toHaveTextContent("No se pudo cargar la capa Azul");

    healthy = true;
    fireEvent.click(within(alert).getByRole("button", { name: "Reintentar" }));
    await waitFor(() => expect(Konva.stages[Konva.stages.length - 1].find("Path").length).toBeGreaterThanOrEqual(3));
    expect(within(screen.getByRole("application")).queryByRole("alert")).not.toBeInTheDocument();
  });
});
