import Konva from "konva";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readDxf, readZip } from "../../test/exportReaders";
import { fakePng } from "../../test/fakePng";
import { installResizeObserver, installWorkspaceFetch, jsonResponse, R2, renderWorkspace, toScreen, undoButton } from "../../test/workspaceFixture";
import type { DownloadableFile } from "../../lib/editor/export/browser";
import type { Rasterizer } from "../../lib/editor/export/pngExport";
import { parseEditableLayerStrict } from "../../lib/editor/objects";

/**
 * Integración del export avanzado (M3-S15) en el Workspace completo: botón EXPORT del header, diálogo con preflight sobre el documento EN MEMORIA (lo que el usuario ve, aunque
 * no esté guardado), formatos SVG / DXF / PNG, layers elegidas, un archivo por layer en ZIP, nombres deterministas, confirmación con Laser Check Blocking, error sin descarga,
 * teclado y foco (Escape devuelve el foco al botón EXPORT) y que no toca el historial ni el Laser Check abierto.
 *
 * Documento 320 x 240 u con 0,5 mm por unidad (160 x 120 mm). Capas: Rojo (CUT: r1 = 0..40², r2 = 0..40 x 100..140), Azul (CUT: b1 = 100..140²) y Líneas (ENGRAVE: una línea).
 */

const OPEN1 = "M0 0 H40 V40 H0";
const SVG_OPEN = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><path data-vid="o1" d="${OPEN1}" fill="#ff0000"/><path data-vid="r2" d="${R2}" fill="#ff0000"/></svg>`;
const OPERATIONS = { A: "cut", B: "cut", C: "engrave" } as const;
const BASE = {
  operations: OPERATIONS,
  floating: (body: Record<string, unknown>) =>
    jsonResponse({ mode: body.mode, tolerance: body.tolerance, components: [{ id: 0, kind: "principal", depth: 0, parent: null, polygon: null, area: null, bounds: [0, 0, 320, 240], subjects: [] }], floatingCount: 0, mainCount: 1, discarded: 0 }),
};

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const exportButton = () => screen.getByRole("button", { name: /^Exportar el documento/ });
const dialog = () => screen.getByRole("dialog", { name: "Exportar" });
const inDialog = () => within(dialog());
const status = () => screen.getByTestId("export-status");
const submit = () => inDialog().getByRole("button", { name: /^(Exportar|Exportar de todos modos)$/ });
const radio = (name: RegExp) => inDialog().getByRole("radio", { name });
const layerBox = (name: RegExp) => within(inDialog().getByRole("list", { name: "Layers del documento" })).getByRole("checkbox", { name });

function seams() {
  const download = vi.fn<(file: DownloadableFile) => void>();
  const rasterize = vi.fn<Rasterizer>(async (_svg, width, height) => fakePng(width, height));
  return { download, rasterize, yieldToEventLoop: async () => {} };
}

async function openDialog(fetchMock: ReturnType<typeof installWorkspaceFetch>, options: { waitLaser?: boolean } = {}) {
  fireEvent.click(exportButton());
  await screen.findByRole("dialog", { name: "Exportar" });
  if (options.waitLaser !== false) {
    await waitFor(() => expect(fetchMock.floatingCalls).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId("export-laser-status")).not.toHaveAttribute("data-state", "unverified"));
  }
}

function click(canvas: HTMLElement, x: number, y: number) {
  fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, ...toScreen(x, y) });
  fireEvent.pointerUp(canvas, { pointerId: 1, ...toScreen(x, y) });
}

describe("EditorShell — Export avanzado (M3-S15)", () => {
  beforeEach(() => installResizeObserver());
  afterEach(() => vi.unstubAllGlobals());

  it("el botón EXPORT está habilitado con el documento cargado y abre un diálogo modal con el preflight", async () => {
    const fetchMock = installWorkspaceFetch(BASE);
    await renderWorkspace({ exportSeams: seams() });
    expect(exportButton()).toBeEnabled();
    expect(exportButton()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await openDialog(fetchMock);

    expect(exportButton()).toHaveAttribute("aria-expanded", "true");
    expect(dialog()).toHaveAttribute("aria-modal", "true");
    expect(dialog()).toHaveFocus();
    expect(screen.getByTestId("export-dimensions")).toHaveTextContent("Dimensiones: 160 × 120 mm.");
    const rows = within(inDialog().getByRole("list", { name: "Layers del documento" })).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      expect.stringContaining("Rojo · Corte · 2 objetos"),
      expect.stringContaining("Azul · Corte · 1 objeto"),
      expect.stringContaining("Líneas · Grabado · 1 objeto"),
    ]);
    expect(screen.getByTestId("export-laser-status")).toHaveTextContent("Ready");
    expect(screen.getByTestId("export-download-name")).toHaveTextContent("mi-diseno_documento.svg");
  });

  it("abrir y cerrar el export no toca el historial, no abre el panel del Laser Check ni dibuja su overlay, y analiza UNA sola vez", async () => {
    const fetchMock = installWorkspaceFetch(BASE);
    await renderWorkspace({ exportSeams: seams() });
    await openDialog(fetchMock);
    await new Promise((resolve) => setTimeout(resolve, 450));

    expect(undoButton()).toBeDisabled();
    expect(screen.queryByRole("region", { name: "Laser Check" })).not.toBeInTheDocument();
    expect(document.querySelector('[data-testid="laser-check-overlay"]')).toBeNull();
    expect(fetchMock.floatingCalls).toHaveLength(1);
  });

  it("StrictMode: el diálogo abre, analiza UNA sola vez y exporta una sola vez", async () => {
    const fetchMock = installWorkspaceFetch(BASE);
    const injected = seams();
    await renderWorkspace({ strict: true, exportSeams: injected });
    await openDialog(fetchMock);
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(fetchMock.floatingCalls).toHaveLength(1);
    fireEvent.click(submit());
    await waitFor(() => expect(injected.download).toHaveBeenCalledTimes(1));
  });

  it("exporta SVG por el seam de descarga: mm, viewBox del documento y todas las capas visibles; reabrible con el parser del editor", async () => {
    const fetchMock = installWorkspaceFetch(BASE);
    const injected = seams();
    await renderWorkspace({ exportSeams: injected });
    await openDialog(fetchMock);

    fireEvent.click(submit());

    await waitFor(() => expect(injected.download).toHaveBeenCalledTimes(1));
    const file = injected.download.mock.calls[0][0];
    expect(file.name).toBe("mi-diseno_documento.svg");
    expect(file.mime).toBe("image/svg+xml");
    const svg = text(file.data);
    expect(svg).toContain('width="160mm" height="120mm" viewBox="0 0 320 240"');
    const reopened = parseEditableLayerStrict(svg, "doc", "#000") ?? [];
    expect(reopened.map((object) => object.id)).toEqual(["r1", "r2", "b1", "ln1"]);
    await waitFor(() => expect(status()).toHaveTextContent("Listo: se descargó «mi-diseno_documento.svg»."));
    expect(undoButton()).toBeDisabled(); // exportar no es un comando
  });

  it("lo exportado es lo que se ve en el editor, aunque NO esté guardado: un objeto eliminado no sale", async () => {
    const fetchMock = installWorkspaceFetch(BASE);
    const injected = seams();
    const { canvas } = await renderWorkspace({ exportSeams: injected });
    click(canvas, 10, 10); // r1
    fireEvent.keyDown(canvas, { key: "Delete" });
    expect(Konva.stages[Konva.stages.length - 1].find("Path")).toHaveLength(3);
    expect(screen.getByText("Cambios de geometría sin guardar")).toBeInTheDocument();

    await openDialog(fetchMock);
    expect(screen.getByTestId("export-summary")).toHaveTextContent("3 layers incluidas (3 objetos)");
    fireEvent.click(submit());

    await waitFor(() => expect(injected.download).toHaveBeenCalled());
    const ids = (parseEditableLayerStrict(text(injected.download.mock.calls[0][0].data), "doc", "#000") ?? []).map((object) => object.id);
    expect(ids).toEqual(["r2", "b1", "ln1"]);
  });

  it("una capa oculta no se exporta por defecto (y el diálogo dice por qué); se puede incluir a mano", async () => {
    const fetchMock = installWorkspaceFetch({ ...BASE, hiddenB: true });
    const injected = seams();
    await renderWorkspace({ exportSeams: injected, minPaths: 3 });
    await openDialog(fetchMock);

    const azul = within(inDialog().getByRole("list", { name: "Layers del documento" })).getAllByRole("listitem")[1];
    expect(azul).toHaveTextContent("no se exporta: oculta");
    expect(layerBox(/Azul/)).not.toBeChecked();
    fireEvent.click(submit());
    await waitFor(() => expect(injected.download).toHaveBeenCalledTimes(1));
    expect((parseEditableLayerStrict(text(injected.download.mock.calls[0][0].data), "doc", "#000") ?? []).map((object) => object.id)).toEqual(["r1", "r2", "ln1"]);

    fireEvent.click(layerBox(/Azul/));
    expect(screen.getByRole("list", { name: "Avisos del export" })).toHaveTextContent("Se incluye 1 layer oculta");
    fireEvent.click(submit());
    await waitFor(() => expect(injected.download).toHaveBeenCalledTimes(2));
    expect((parseEditableLayerStrict(text(injected.download.mock.calls[1][0].data), "doc", "#000") ?? []).map((object) => object.id)).toContain("b1");
  });

  it("una capa IGNORE no se exporta por defecto", async () => {
    const fetchMock = installWorkspaceFetch({ ...BASE, operations: { A: "cut", B: "ignore", C: "engrave" } });
    await renderWorkspace({ exportSeams: seams() });
    await openDialog(fetchMock);
    expect(layerBox(/Azul/)).not.toBeChecked();
    expect(within(inDialog().getByRole("list", { name: "Layers del documento" })).getAllByRole("listitem")[1]).toHaveTextContent("no se exporta: ignorada (operación IGNORE)");
  });

  it("DXF por layer en un ZIP con nombres proyecto_layer_operación.dxf, en mm y con las layers elegidas", async () => {
    const fetchMock = installWorkspaceFetch(BASE);
    const injected = seams();
    await renderWorkspace({ exportSeams: injected });
    await openDialog(fetchMock);

    fireEvent.click(radio(/DXF/));
    fireEvent.click(radio(/Un archivo por layer/));
    fireEvent.click(layerBox(/Azul/)); // export parcial
    fireEvent.click(submit());

    await waitFor(() => expect(injected.download).toHaveBeenCalledTimes(1));
    const file = injected.download.mock.calls[0][0];
    expect(file.name).toBe("mi-diseno_layers.zip");
    const entries = readZip(file.data);
    expect(entries.map((entry) => entry.name)).toEqual(["mi-diseno_rojo_cut.dxf", "mi-diseno_lineas_engrave.dxf"]);
    const rojo = readDxf(text(entries[0].data));
    expect(rojo.header["$INSUNITS"]).toEqual(["70:4"]);
    // r1 = 0..40 x 0..40 u => 0..20 mm; Y invertido sobre 120 mm de alto: y' = 120 - y·0,5 => 100..120.
    expect(rojo.polylines[0].vertices.map((vertex) => [vertex.x, vertex.y])).toEqual([[0, 120], [20, 120], [20, 100], [0, 100]]);
  });

  it("PNG: tamaño configurable, fondo transparente u opaco y rasterizador inyectado", async () => {
    const fetchMock = installWorkspaceFetch(BASE);
    const injected = seams();
    await renderWorkspace({ exportSeams: injected });
    await openDialog(fetchMock);

    fireEvent.click(radio(/PNG/));
    fireEvent.change(inDialog().getByRole("textbox", { name: "Ancho (px)" }), { target: { value: "640" } });
    fireEvent.click(radio(/Fondo transparente/));
    expect(screen.getByTestId("export-png-size")).toHaveTextContent("Resultado: 640 × 480 px");
    fireEvent.click(submit());

    await waitFor(() => expect(injected.download).toHaveBeenCalledTimes(1));
    expect(injected.rasterize.mock.calls[0].slice(1)).toEqual([640, 480, null]);
    expect(injected.download.mock.calls[0][0].name).toBe("mi-diseno_documento.png");
    expect(injected.rasterize.mock.calls[0][0]).toContain('width="640" height="480" viewBox="0 0 320 240"');
  });

  it("sin escala física: lo dice en el preflight y el SVG sale sin milímetros", async () => {
    const fetchMock = installWorkspaceFetch(BASE);
    const injected = seams();
    await renderWorkspace({ dimensionWidthMm: null, exportSeams: injected });
    await openDialog(fetchMock);

    expect(screen.getByTestId("export-dimensions")).toHaveTextContent("320 × 240 u (sin escala)");
    fireEvent.click(submit());
    await waitFor(() => expect(injected.download).toHaveBeenCalled());
    const svg = text(injected.download.mock.calls[0][0].data);
    expect(svg).toContain('width="320" height="240" viewBox="0 0 320 240"');
    expect(svg).not.toMatch(/width="[\d.]+mm"/);
  });

  it("Laser Check Blocking: lista el problema, pide confirmación explícita y recién entonces exporta", async () => {
    const fetchMock = installWorkspaceFetch({ ...BASE, svg: { A: SVG_OPEN } });
    const injected = seams();
    await renderWorkspace({ exportSeams: injected });
    await openDialog(fetchMock);
    await waitFor(() => expect(screen.getByTestId("export-laser-status")).toHaveTextContent("Blocking"));

    expect(screen.getAllByTestId("export-blocking-issue")[0]).toHaveTextContent("Path abierto");
    expect(submit()).toHaveTextContent("Exportar de todos modos");
    expect(submit()).toBeDisabled();
    fireEvent.click(inDialog().getByRole("checkbox", { name: /Entiendo que el Laser Check/ }));
    expect(submit()).toBeEnabled();
    fireEvent.click(submit());
    await waitFor(() => expect(injected.download).toHaveBeenCalledTimes(1));
  });

  it("si el servicio de flotantes falla, el preflight lo marca NO VERIFICADO (no Ready) y deja exportar", async () => {
    const fetchMock = installWorkspaceFetch({ ...BASE, floating: () => jsonResponse({ code: "processing_error", message: "caído" }, 500) });
    const injected = seams();
    await renderWorkspace({ exportSeams: injected });
    fireEvent.click(exportButton());
    await screen.findByRole("dialog", { name: "Exportar" });
    await waitFor(() => expect(fetchMock.floatingCalls.length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getAllByTestId("export-unverified").some((item) => /flotantes/i.test(item.textContent ?? ""))).toBe(true));
    expect(screen.getByTestId("export-laser-status")).toHaveTextContent("No verificado");
    expect(screen.getByTestId("export-laser-status")).not.toHaveTextContent("Ready");
    expect(submit()).toBeEnabled();
  });

  it("un error de generación se muestra y no descarga nada", async () => {
    const fetchMock = installWorkspaceFetch(BASE);
    const injected = seams();
    injected.rasterize.mockRejectedValue(new Error("canvas lleno"));
    await renderWorkspace({ exportSeams: injected });
    await openDialog(fetchMock);

    fireEvent.click(radio(/PNG/));
    fireEvent.click(submit());

    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo generar el PNG: canvas lleno");
    expect(injected.download).not.toHaveBeenCalled();
  });

  it("Escape cierra el diálogo y devuelve el foco al botón EXPORT; el botón Cancelar también", async () => {
    const fetchMock = installWorkspaceFetch(BASE);
    await renderWorkspace({ exportSeams: seams() });
    await openDialog(fetchMock);

    fireEvent.keyDown(dialog(), { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(exportButton()).toHaveFocus();
    expect(exportButton()).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(exportButton());
    await screen.findByRole("dialog", { name: "Exportar" });
    fireEvent.click(inDialog().getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(exportButton()).toHaveFocus();
  });

  it("el atajo Ctrl+Z dentro del diálogo no deshace nada del documento", async () => {
    const fetchMock = installWorkspaceFetch(BASE);
    const { canvas } = await renderWorkspace({ exportSeams: seams() });
    click(canvas, 10, 10);
    fireEvent.keyDown(canvas, { key: "Delete" });
    expect(Konva.stages[Konva.stages.length - 1].find("Path")).toHaveLength(3);

    await openDialog(fetchMock);
    fireEvent.keyDown(radio(/SVG/), { key: "z", ctrlKey: true });
    expect(Konva.stages[Konva.stages.length - 1].find("Path")).toHaveLength(3);
  });

  it("con el panel del Laser Check abierto, el export reutiliza su análisis (una sola petición de flotantes) y al cerrarlo el panel sigue abierto", async () => {
    const fetchMock = installWorkspaceFetch(BASE);
    await renderWorkspace({ exportSeams: seams() });
    fireEvent.click(screen.getByRole("button", { name: "Laser Check" }));
    await waitFor(() => expect(fetchMock.floatingCalls).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId("laser-check-status")).toHaveTextContent("Ready"));

    fireEvent.click(exportButton());
    await screen.findByRole("dialog", { name: "Exportar" });
    await waitFor(() => expect(screen.getByTestId("export-laser-status")).toHaveTextContent("Ready"));
    expect(fetchMock.floatingCalls).toHaveLength(1);

    fireEvent.keyDown(dialog(), { key: "Escape" });
    expect(screen.getByRole("region", { name: "Laser Check" })).toBeInTheDocument();
  });
});
