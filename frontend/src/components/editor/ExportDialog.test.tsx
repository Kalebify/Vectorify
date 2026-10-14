import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { exportDataset, exportDatasetNoScale, IDS, pathObject } from "../../test/exportDataset";
import { readDxf, readZip } from "../../test/exportReaders";
import { fakePng } from "../../test/fakePng";
import type { DownloadableFile } from "../../lib/editor/export/browser";
import type { ExportDocument } from "../../lib/editor/export/exportDocument";
import type { Rasterizer } from "../../lib/editor/export/pngExport";
import { analyzeLaserLocal, buildReport, type LaserCheckReport } from "../../lib/editor/laserCheck";
import { ExportDialog } from "./ExportDialog";

const noYield = async () => {};
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

function realReport(document: ExportDocument): LaserCheckReport {
  const local = analyzeLaserLocal({ objectsByLayer: document.objectsByLayer as never, frame: document.frame, layers: [...document.layers] }, { mmFactor: document.mmFactor });
  return buildReport(local, { state: "done", issues: [] });
}

function documentWithOpenPath(): ExportDocument {
  const base = exportDataset();
  return exportDataset({ objectsByLayer: { ...base.objectsByLayer, [IDS.rojo]: [...base.objectsByLayer[IDS.rojo], pathObject("abierto", IDS.rojo, "M0 0 H10 V10")] } });
}

function setup(props: Partial<Parameters<typeof ExportDialog>[0]> = {}) {
  const download = vi.fn<(file: DownloadableFile) => void>();
  const onClose = vi.fn();
  const rasterize = vi.fn<Rasterizer>(async (_svg, width, height) => fakePng(width, height));
  const utils = render(<ExportDialog document={exportDataset()} laserReport={null} rasterize={rasterize} download={download} yieldToEventLoop={noYield} onClose={onClose} {...props} />);
  return { ...utils, download, onClose, rasterize };
}

const dialog = () => screen.getByRole("dialog", { name: "Exportar" });
const exportButton = () => screen.getByRole("button", { name: /^(Exportar|Exportar de todos modos|Generando…)$/ });
const status = () => screen.getByTestId("export-status");
const layerBox = (name: RegExp) => within(screen.getByRole("list", { name: "Layers del documento" })).getByRole("checkbox", { name });
const radio = (name: RegExp) => screen.getByRole("radio", { name });

describe("ExportDialog: accesibilidad", () => {
  it("es un diálogo modal con nombre y descripción, y el foco entra al diálogo al abrir", () => {
    setup();
    expect(dialog()).toHaveAttribute("aria-modal", "true");
    expect(dialog()).toHaveAccessibleDescription(/Proyecto «Mi Diseño» · 100 × 50 mm/);
    expect(dialog()).toHaveFocus();
  });

  it("Escape cierra el diálogo", () => {
    const { onClose } = setup();
    fireEvent.keyDown(dialog(), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("los botones Cerrar y Cancelar cierran", () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Cerrar el diálogo de exportación" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("Tab queda atrapado: desde el último control vuelve al primero y Shift+Tab desde el diálogo/primero va al último", () => {
    setup();
    const focusable = Array.from(dialog().querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])'));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    expect(first).toHaveAccessibleName("Cerrar el diálogo de exportación");
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
    dialog().focus();
    fireEvent.keyDown(dialog(), { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
  });

  it("las teclas dentro del diálogo no llegan a los atajos del editor (Ctrl+Z no deshace)", () => {
    setup();
    const onWindowKey = vi.fn();
    window.addEventListener("keydown", onWindowKey);
    fireEvent.keyDown(screen.getByRole("radio", { name: /SVG/ }), { key: "z", ctrlKey: true });
    window.removeEventListener("keydown", onWindowKey);
    expect(onWindowKey).not.toHaveBeenCalled();
  });

  it("el estado va en una región aria-live (polite)", () => {
    setup();
    expect(status()).toHaveAttribute("aria-live", "polite");
    expect(status()).toHaveAttribute("role", "status");
  });
});

describe("ExportDialog: preflight", () => {
  it("muestra dimensiones en mm, cada layer con su operación y objetos, y por qué se excluyen las que no entran", () => {
    setup();
    expect(screen.getByTestId("export-dimensions")).toHaveTextContent("Dimensiones: 100 × 50 mm.");
    const rows = within(screen.getByRole("list", { name: "Layers del documento" })).getAllByRole("listitem");
    expect(rows).toHaveLength(5);
    expect(rows[0]).toHaveTextContent("Rojo · Corte · 2 objetos");
    expect(rows[1]).toHaveTextContent("Grabado · Grabado · 1 objeto");
    expect(rows[2]).toHaveTextContent("Ignorada · Ignorada · 1 objeto");
    expect(rows[2]).toHaveTextContent("no se exporta: ignorada (operación IGNORE)");
    expect(rows[3]).toHaveTextContent("no se exporta: oculta");
    expect(rows[4]).toHaveTextContent("Ñandú Ánimo · Sin operación");
    expect(layerBox(/Rojo/)).toBeChecked();
    expect(layerBox(/Ignorada/)).not.toBeChecked();
    expect(layerBox(/Oculta/)).not.toBeChecked();
    expect(screen.getByTestId("export-summary")).toHaveTextContent("3 layers incluidas (4 objetos)");
  });

  it("sin escala: lo muestra como «sin escala» y avisa", () => {
    setup({ document: exportDatasetNoScale() });
    expect(screen.getByTestId("export-dimensions")).toHaveTextContent("200 × 100 u (sin escala)");
    expect(screen.getByRole("list", { name: "Avisos del export" })).toHaveTextContent(/Sin escala física/);
  });

  it("avisa de la capa sin operación", () => {
    setup();
    expect(screen.getByRole("list", { name: "Avisos del export" })).toHaveTextContent(/no tienen operación asignada|no tiene operación asignada/);
  });

  it("sin análisis del Laser Check se muestra «No verificado» (nunca Ready)", () => {
    setup();
    expect(screen.getByTestId("export-laser-status")).toHaveTextContent("No verificado");
    expect(screen.getByTestId("export-laser-status")).toHaveAttribute("data-state", "unverified");
    expect(screen.getAllByTestId("export-unverified").length).toBeGreaterThan(0);
    expect(screen.queryByText("Ready")).not.toBeInTheDocument();
  });

  it("con un reporte sin bloqueantes muestra su estado y el botón no pide confirmación", () => {
    const document = exportDataset();
    setup({ document, laserReport: realReport(document) });
    expect(screen.getByTestId("export-laser-status")).toHaveTextContent("Review");
    expect(screen.queryByRole("checkbox", { name: /Entiendo/ })).not.toBeInTheDocument();
    expect(exportButton()).toHaveTextContent("Exportar");
    expect(exportButton()).toBeEnabled();
  });

  it("muestra los nombres de los archivos y el ZIP cuando se elige un archivo por layer", () => {
    setup();
    fireEvent.click(radio(/Un archivo por layer/));
    expect(screen.getByTestId("export-download-name")).toHaveTextContent("mi-diseno_layers.zip (ZIP con 3 archivos)");
    expect(within(screen.getByRole("list", { name: "Archivos dentro del ZIP" })).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "mi-diseno_rojo_cut.svg",
      "mi-diseno_grabado_engrave.svg",
      "mi-diseno_nandu-animo_unassigned.svg",
    ]);
  });
});

describe("ExportDialog: exportar", () => {
  it("SVG por defecto: genera, entrega el archivo por el seam y anuncia «Listo»", async () => {
    const { download } = setup();
    fireEvent.click(exportButton());
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    const file = download.mock.calls[0][0];
    expect(file.name).toBe("mi-diseno_documento.svg");
    expect(file.mime).toBe("image/svg+xml");
    expect(text(file.data)).toContain('width="100mm" height="50mm" viewBox="0 0 200 100"');
    await waitFor(() => expect(status()).toHaveTextContent("Listo: se descargó «mi-diseno_documento.svg»."));
    expect(status()).toHaveAttribute("data-state", "done");
  });

  it("DXF: elige el formato y descarga un DXF válido", async () => {
    const { download } = setup();
    fireEvent.click(radio(/DXF/));
    fireEvent.click(exportButton());
    await waitFor(() => expect(download).toHaveBeenCalled());
    const file = download.mock.calls[0][0];
    expect(file.name).toBe("mi-diseno_documento.dxf");
    expect(readDxf(text(file.data)).polylines.length).toBeGreaterThan(0);
  });

  it("un archivo por layer en DXF: descarga un ZIP con los nombres deterministas", async () => {
    const { download } = setup();
    fireEvent.click(radio(/DXF/));
    fireEvent.click(radio(/Un archivo por layer/));
    fireEvent.click(exportButton());
    await waitFor(() => expect(download).toHaveBeenCalled());
    const file = download.mock.calls[0][0];
    expect(file.name).toBe("mi-diseno_layers.zip");
    expect(file.mime).toBe("application/zip");
    expect(readZip(file.data).map((entry) => entry.name)).toEqual(["mi-diseno_rojo_cut.dxf", "mi-diseno_grabado_engrave.dxf", "mi-diseno_nandu-animo_unassigned.dxf"]);
    await waitFor(() => expect(status()).toHaveTextContent("3 archivos en un ZIP"));
  });

  it("selección parcial: desmarcar una layer la saca del archivo y del preflight", async () => {
    const { download } = setup();
    fireEvent.click(layerBox(/Rojo/));
    expect(layerBox(/Rojo/)).not.toBeChecked();
    expect(screen.getByTestId("export-summary")).toHaveTextContent("2 layers incluidas (2 objetos)");
    expect(within(screen.getByRole("list", { name: "Layers del documento" })).getAllByRole("listitem")[0]).toHaveTextContent("no se exporta: no seleccionada");
    fireEvent.click(exportButton());
    await waitFor(() => expect(download).toHaveBeenCalled());
    expect(text(download.mock.calls[0][0].data)).not.toContain('data-name="Rojo"');
    expect(text(download.mock.calls[0][0].data)).toContain('data-name="Grabado"');
  });

  it("los atajos de selección: Todas / Ninguna / Visibles", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Todas" }));
    expect(screen.getByTestId("export-summary")).toHaveTextContent("5 layers incluidas");
    fireEvent.click(screen.getByRole("button", { name: "Ninguna" }));
    expect(screen.getByTestId("export-summary")).toHaveTextContent("0 layers incluidas");
    fireEvent.click(screen.getByRole("button", { name: "Visibles" }));
    expect(screen.getByTestId("export-summary")).toHaveTextContent("3 layers incluidas");
  });

  it("sin layers elegidas el botón queda deshabilitado y explica por qué", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Ninguna" }));
    expect(exportButton()).toBeDisabled();
    expect(screen.getByTestId("export-hint")).toHaveTextContent("Elegí al menos una layer para exportar.");
    expect(exportButton()).toHaveAccessibleDescription("Elegí al menos una layer para exportar.");
  });

  it("anuncia «Generando…» mientras trabaja, bloquea los controles y descarga recién al terminar", async () => {
    let finish: (bytes: Uint8Array) => void = () => {};
    const rasterize = vi.fn<Rasterizer>(() => new Promise<Uint8Array>((resolve) => (finish = resolve)));
    const { download } = setup({ rasterize });
    fireEvent.click(radio(/PNG/));
    fireEvent.click(exportButton());
    await waitFor(() => expect(status()).toHaveTextContent("Generando el archivo…"));
    expect(status()).toHaveAttribute("data-state", "generating");
    expect(exportButton()).toBeDisabled();
    expect(exportButton()).toHaveTextContent("Generando…");
    expect(radio(/SVG/)).toBeDisabled();
    expect(download).not.toHaveBeenCalled();
    await act(async () => finish(fakePng(1024, 512)));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    expect(status()).toHaveAttribute("data-state", "done");
  });

  it("un error de generación se muestra (role=alert) y NO se descarga nada", async () => {
    const rasterize = vi.fn<Rasterizer>(async () => Promise.reject(new Error("canvas lleno")));
    const { download } = setup({ rasterize });
    fireEvent.click(radio(/PNG/));
    fireEvent.click(exportButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo generar el PNG: canvas lleno");
    expect(status()).toHaveTextContent("Error: No se pudo generar el PNG: canvas lleno");
    expect(download).not.toHaveBeenCalled();
    expect(exportButton()).toBeEnabled(); // se puede reintentar
  });

  it("si la descarga falla también se informa como error", async () => {
    const { download } = setup();
    download.mockImplementation(() => {
      throw new Error("bloqueada");
    });
    fireEvent.click(exportButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("bloqueada");
  });

  it("cerrar el diálogo mientras genera cancela: no se descarga nada", async () => {
    let finish: (bytes: Uint8Array) => void = () => {};
    const rasterize = vi.fn<Rasterizer>(() => new Promise<Uint8Array>((resolve) => (finish = resolve)));
    const { download, unmount } = setup({ rasterize });
    fireEvent.click(radio(/PNG/));
    fireEvent.click(exportButton());
    await waitFor(() => expect(rasterize).toHaveBeenCalled());
    unmount();
    await act(async () => finish(fakePng(1024, 512)));
    expect(download).not.toHaveBeenCalled();
  });

  it("cambiar una opción después de exportar limpia el mensaje «Listo»", async () => {
    const { download } = setup();
    fireEvent.click(exportButton());
    await waitFor(() => expect(download).toHaveBeenCalled());
    await waitFor(() => expect(status()).toHaveAttribute("data-state", "done"));
    fireEvent.click(radio(/DXF/));
    expect(status()).toHaveAttribute("data-state", "idle");
  });
});

describe("ExportDialog: PNG", () => {
  it("muestra el tamaño resultante con la relación de aspecto y lo actualiza al cambiar el ancho", async () => {
    const { rasterize, download } = setup();
    fireEvent.click(radio(/PNG/));
    expect(screen.getByTestId("export-png-size")).toHaveTextContent("Resultado: 1024 × 512 px");
    fireEvent.change(screen.getByRole("textbox", { name: "Ancho (px)" }), { target: { value: "600" } });
    expect(screen.getByTestId("export-png-size")).toHaveTextContent("Resultado: 600 × 300 px");
    fireEvent.click(exportButton());
    await waitFor(() => expect(download).toHaveBeenCalled());
    expect(rasterize.mock.calls[0].slice(1, 3)).toEqual([600, 300]);
    expect(download.mock.calls[0][0].name).toBe("mi-diseno_documento.png");
    expect(download.mock.calls[0][0].mime).toBe("image/png");
  });

  it("fondo opaco por defecto (blanco); «Fondo transparente» manda null al rasterizador; un color propio se respeta", async () => {
    const { rasterize, download } = setup();
    fireEvent.click(radio(/PNG/));
    fireEvent.click(exportButton());
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    expect(rasterize.mock.calls[0][3]).toBe("#ffffff");

    fireEvent.click(radio(/Fondo transparente/));
    expect(screen.getByLabelText("Color de fondo")).toBeDisabled();
    fireEvent.click(exportButton());
    await waitFor(() => expect(download).toHaveBeenCalledTimes(2));
    expect(rasterize.mock.calls[1][3]).toBeNull();

    fireEvent.click(radio(/Fondo de color/));
    fireEvent.change(screen.getByLabelText("Color de fondo"), { target: { value: "#112233" } });
    fireEvent.click(exportButton());
    await waitFor(() => expect(download).toHaveBeenCalledTimes(3));
    expect(rasterize.mock.calls[2][3]).toBe("#112233");
  });

  it("un ancho fuera de tope se explica y deshabilita Exportar; un ancho no numérico también", () => {
    setup();
    fireEvent.click(radio(/PNG/));
    const input = screen.getByRole("textbox", { name: "Ancho (px)" });
    fireEvent.change(input, { target: { value: "20000" } });
    expect(screen.getByTestId("export-hint")).toHaveTextContent(/supera el máximo.*ancho máximo es \d+ px/);
    expect(exportButton()).toBeDisabled();
    fireEvent.change(input, { target: { value: "abc" } });
    expect(screen.getByTestId("export-png-size")).toHaveTextContent("Resultado: ancho inválido.");
    expect(exportButton()).toBeDisabled();
    fireEvent.change(input, { target: { value: "800" } });
    expect(exportButton()).toBeEnabled();
  });

  it("avisa que el PNG es una vista previa", () => {
    setup();
    fireEvent.click(radio(/PNG/));
    expect(screen.getByRole("list", { name: "Avisos del export" })).toHaveTextContent("vista previa");
  });
});

describe("ExportDialog: confirmación con Laser Check Blocking", () => {
  const blocking = () => {
    const document = documentWithOpenPath();
    return { document, laserReport: realReport(document) };
  };

  it("lista los problemas bloqueantes, cambia el botón a «Exportar de todos modos» y lo deshabilita hasta confirmar", () => {
    setup(blocking());
    expect(screen.getByTestId("export-laser-status")).toHaveTextContent("Blocking");
    const issues = screen.getAllByTestId("export-blocking-issue");
    expect(issues[0]).toHaveTextContent("Path abierto");
    expect(issues[0]).toHaveTextContent("Capa «Rojo»");
    expect(exportButton()).toHaveTextContent("Exportar de todos modos");
    expect(exportButton()).toBeDisabled();
    expect(screen.getByTestId("export-hint")).toHaveTextContent("Confirmá que querés exportar");
  });

  it("con la confirmación tildada exporta igual", async () => {
    const { download } = setup(blocking());
    fireEvent.click(screen.getByRole("checkbox", { name: /Entiendo que el Laser Check/ }));
    expect(exportButton()).toBeEnabled();
    fireEvent.click(exportButton());
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
  });

  it("sin confirmar no se puede exportar ni forzando el click", () => {
    const { download } = setup(blocking());
    fireEvent.click(exportButton());
    expect(download).not.toHaveBeenCalled();
  });

  it("la confirmación se pide DE NUEVO si cambia el conjunto de problemas (otra selección de layers)", () => {
    setup(blocking());
    const confirm = () => screen.getByRole("checkbox", { name: /Entiendo que el Laser Check/ });
    fireEvent.click(confirm());
    expect(exportButton()).toBeEnabled();
    // Sacar Rojo (donde está el path abierto) elimina el bloqueo: ya no hace falta confirmar.
    fireEvent.click(layerBox(/Rojo/));
    expect(screen.queryByRole("checkbox", { name: /Entiendo/ })).not.toBeInTheDocument();
    expect(exportButton()).toHaveTextContent("Exportar");
    // Volver a meterla: el bloqueo reaparece y la confirmación anterior no vale.
    fireEvent.click(layerBox(/Rojo/));
    expect(confirm()).not.toBeChecked();
    expect(exportButton()).toBeDisabled();
  });
});
