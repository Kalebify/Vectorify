import { describe, expect, it, vi } from "vitest";
import { exportDataset, IDS, layer, pathObject } from "../../../test/exportDataset";
import { readDxf, readZip } from "../../../test/exportReaders";
import { fakePng } from "../../../test/fakePng";
import { parseEditableLayerStrict } from "../objects";
import { defaultExportSelection } from "./exportDocument";
import { DEFAULT_EXPORT_OPTIONS, type ExportOptions } from "./exportPlan";
import { ExportError, generateExport, isAbortError, MIME_BY_FORMAT, ZIP_MIME } from "./exportRunner";
import { pngDimensions, type Rasterizer } from "./pngExport";

const document = exportDataset();
const selection = defaultExportSelection(document.layers); // Rojo, Grabado, Ñandú Ánimo
const options = (overrides: Partial<ExportOptions> = {}): ExportOptions => ({ ...DEFAULT_EXPORT_OPTIONS, ...overrides });
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const noYield = async () => {};
const rasterizer = () => vi.fn<Rasterizer>(async (_svg, width, height) => fakePng(width, height));

describe("generateExport: un archivo con las layers elegidas", () => {
  it("SVG: nombre proyecto_documento.svg, MIME correcto y solo las layers elegidas; reabrible con el parser del editor", async () => {
    const result = await generateExport(document, selection, options(), { yieldToEventLoop: noYield });
    expect(result.name).toBe("mi-diseno_documento.svg");
    expect(result.mime).toBe(MIME_BY_FORMAT.svg);
    expect(result.files).toEqual(["mi-diseno_documento.svg"]);
    const reopened = parseEditableLayerStrict(text(result.data), "doc", "#000") ?? [];
    expect(reopened.map((object) => object.id)).toEqual(["marco", "disco", "linea", "sin"]); // sin Ignorada ni Oculta
  });

  it("DXF: se arma desde el documento en memoria y el parser mínimo lo lee", async () => {
    const result = await generateExport(document, selection, options({ format: "dxf" }), { yieldToEventLoop: noYield });
    expect(result.name).toBe("mi-diseno_documento.dxf");
    expect(result.mime).toBe(MIME_BY_FORMAT.dxf);
    const dxf = readDxf(text(result.data));
    expect(dxf.layerTable).toEqual(["0", "ROJO", "GRABADO", "NANDU-ANIMO"]);
    expect(dxf.polylines).toHaveLength(5); // marco + hueco + disco + línea + cuadrado
  });

  it("export parcial: solo la layer elegida", async () => {
    const result = await generateExport(document, new Set([IDS.grabado]), options({ format: "dxf" }), { yieldToEventLoop: noYield });
    expect(readDxf(text(result.data)).polylines.map((polyline) => polyline.layer)).toEqual(["GRABADO"]);
  });

  it("PNG: tamaño pedido con la relación de aspecto, fondo opaco y una sola llamada al rasterizador", async () => {
    const rasterize = rasterizer();
    const result = await generateExport(document, selection, options({ format: "png", pngWidth: 640, pngBackground: "#ABCDEF" }), { rasterize, yieldToEventLoop: noYield });
    expect(result.name).toBe("mi-diseno_documento.png");
    expect(result.mime).toBe("image/png");
    expect(pngDimensions(result.data)).toEqual({ width: 640, height: 320 });
    expect(rasterize).toHaveBeenCalledTimes(1);
    expect(rasterize.mock.calls[0].slice(1)).toEqual([640, 320, "#abcdef"]);
  });

  it("PNG transparente: el fondo llega como null", async () => {
    const rasterize = rasterizer();
    await generateExport(document, selection, options({ format: "png", pngBackground: null }), { rasterize, yieldToEventLoop: noYield });
    expect(rasterize.mock.calls[0][3]).toBeNull();
  });

  it("un documento grande (2 000 objetos con curvas) se genera completo", async () => {
    const many = Array.from({ length: 2000 }, (_, index) => pathObject(`o${index}`, IDS.rojo, `M${index % 190} ${index % 90} c10 0 10 10 0 10 z`));
    const big = exportDataset({ objectsByLayer: { ...document.objectsByLayer, [IDS.rojo]: many } });
    const dxf = await generateExport(big, new Set([IDS.rojo]), options({ format: "dxf" }), { yieldToEventLoop: noYield });
    expect(readDxf(text(dxf.data)).polylines).toHaveLength(2000);
    const svg = await generateExport(big, new Set([IDS.rojo]), options(), { yieldToEventLoop: noYield });
    expect(parseEditableLayerStrict(text(svg.data), "x", "#000")).toHaveLength(2000);
  });
});

describe("generateExport: un archivo por layer", () => {
  it("SVG por layer en un ZIP con nombres proyecto_layer_operación.svg; cada uno reabre con SOLO su geometría", async () => {
    const result = await generateExport(document, selection, options({ mode: "layers" }), { yieldToEventLoop: noYield });
    expect(result.name).toBe("mi-diseno_layers.zip");
    expect(result.mime).toBe(ZIP_MIME);
    const entries = readZip(result.data);
    expect(entries.map((entry) => entry.name)).toEqual(["mi-diseno_rojo_cut.svg", "mi-diseno_grabado_engrave.svg", "mi-diseno_nandu-animo_unassigned.svg"]);
    expect(result.files).toEqual(entries.map((entry) => entry.name));
    expect(entries.every((entry) => entry.crcActual === entry.crcDeclared && entry.method === 0)).toBe(true);
    const ids = entries.map((entry) => (parseEditableLayerStrict(text(entry.data), "x", "#000") ?? []).map((object) => object.id));
    expect(ids).toEqual([["marco", "disco"], ["linea"], ["sin"]]);
  });

  it("DXF por layer: cada archivo trae su propia capa y comparte coordenadas con el documento completo", async () => {
    const whole = readDxf(text((await generateExport(document, selection, options({ format: "dxf" }), { yieldToEventLoop: noYield })).data));
    const zip = await generateExport(document, selection, options({ format: "dxf", mode: "layers" }), { yieldToEventLoop: noYield });
    const entries = readZip(zip.data);
    expect(entries.map((entry) => entry.name)).toEqual(["mi-diseno_rojo_cut.dxf", "mi-diseno_grabado_engrave.dxf", "mi-diseno_nandu-animo_unassigned.dxf"]);
    for (const entry of entries) {
      const dxf = readDxf(text(entry.data));
      expect(new Set(dxf.polylines.map((polyline) => polyline.layer)).size).toBe(1);
      const name = dxf.polylines[0].layer;
      expect(dxf.polylines).toEqual(whole.polylines.filter((polyline) => polyline.layer === name));
    }
  });

  it("PNG por layer: un PNG por layer con el MISMO tamaño (se superponen), en un ZIP", async () => {
    const rasterize = rasterizer();
    const result = await generateExport(document, selection, options({ format: "png", mode: "layers", pngWidth: 400 }), { rasterize, yieldToEventLoop: noYield });
    expect(rasterize).toHaveBeenCalledTimes(3);
    expect(rasterize.mock.calls.map((call) => [call[1], call[2]])).toEqual([[400, 200], [400, 200], [400, 200]]);
    const entries = readZip(result.data);
    expect(entries.map((entry) => entry.name)).toEqual(["mi-diseno_rojo_cut.png", "mi-diseno_grabado_engrave.png", "mi-diseno_nandu-animo_unassigned.png"]);
    expect(entries.every((entry) => pngDimensions(entry.data)?.width === 400)).toBe(true);
    // Cada rasterizado recibió una sola capa.
    expect(rasterize.mock.calls.map((call) => call[0].match(/<g /g)?.length)).toEqual([1, 1, 1]);
  });

  it("con una sola layer elegida no hay ZIP: se descarga el archivo directo", async () => {
    const result = await generateExport(document, new Set([IDS.rojo]), options({ mode: "layers" }), { yieldToEventLoop: noYield });
    expect(result.name).toBe("mi-diseno_rojo_cut.svg");
    expect(result.mime).toBe(MIME_BY_FORMAT.svg);
    expect(result.files).toEqual(["mi-diseno_rojo_cut.svg"]);
  });

  it("es determinista: dos corridas dan exactamente los mismos bytes y nombres", async () => {
    const first = await generateExport(document, selection, options({ format: "dxf", mode: "layers" }), { yieldToEventLoop: noYield });
    const second = await generateExport(exportDataset(), defaultExportSelection(exportDataset().layers), options({ format: "dxf", mode: "layers" }), { yieldToEventLoop: noYield });
    expect(second.files).toEqual(first.files);
    expect(Array.from(second.data)).toEqual(Array.from(first.data));
  });

  it("cede el control entre layers (no congela la UI)", async () => {
    const yieldToEventLoop = vi.fn(async () => {});
    await generateExport(document, selection, options({ mode: "layers" }), { yieldToEventLoop });
    expect(yieldToEventLoop.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("dos layers con el mismo nombre => archivos distintos (-2) y un ZIP válido", async () => {
    const twin = exportDataset({ layers: [layer("a", { name: "Igual", order: 0 }), layer("b", { name: "Igual", order: 1 })], objectsByLayer: { a: [pathObject("a1", "a", "M0 0 H5 V5 H0 Z")], b: [pathObject("b1", "b", "M10 10 H15 V15 H10 Z")] } });
    const result = await generateExport(twin, new Set(["a", "b"]), options({ mode: "layers" }), { yieldToEventLoop: noYield });
    expect(readZip(result.data).map((entry) => entry.name)).toEqual(["mi-diseno_igual_cut.svg", "mi-diseno_igual_cut-2.svg"]);
  });
});

describe("generateExport: errores (nunca un archivo parcial)", () => {
  it("sin layers elegidas => ExportError con el motivo del preflight", async () => {
    await expect(generateExport(document, new Set(), options())).rejects.toThrow(ExportError);
    await expect(generateExport(document, new Set(), options())).rejects.toThrow("Elegí al menos una layer");
  });

  it("PNG sin rasterizador disponible", async () => {
    await expect(generateExport(document, selection, options({ format: "png" }), { yieldToEventLoop: noYield })).rejects.toThrow(/no hay un rasterizador/);
  });

  it("PNG fuera de tope => error del preflight, sin llamar al rasterizador", async () => {
    const rasterize = rasterizer();
    await expect(generateExport(document, selection, options({ format: "png", pngWidth: 99999 }), { rasterize })).rejects.toThrow(/supera el máximo/);
    expect(rasterize).not.toHaveBeenCalled();
  });

  it("si el rasterizador falla en la 2.ª layer, TODO el export falla (no se entrega un ZIP a medias)", async () => {
    let calls = 0;
    const rasterize: Rasterizer = async (_svg, width, height) => {
      calls += 1;
      if (calls === 2) throw new Error("canvas lleno");
      return fakePng(width, height);
    };
    const failing = generateExport(document, selection, options({ format: "png", mode: "layers" }), { rasterize, yieldToEventLoop: noYield });
    await expect(failing).rejects.toThrow(ExportError);
    await expect(failing).rejects.toThrow(/No se pudo generar el PNG: canvas lleno/);
  });

  it("un rasterizador que devuelve basura => error", async () => {
    await expect(generateExport(document, selection, options({ format: "png" }), { rasterize: async () => new Uint8Array(10), yieldToEventLoop: noYield })).rejects.toThrow(/PNG válida/);
  });

  it("cancelar (AbortSignal) lanza un AbortError y no entrega nada", async () => {
    const controller = new AbortController();
    const yieldToEventLoop = vi.fn(async () => controller.abort());
    const promise = generateExport(document, selection, options({ mode: "layers" }), { yieldToEventLoop, signal: controller.signal });
    await expect(promise).rejects.toSatisfy(isAbortError);
  });

  it("los avisos del DXF (objetos omitidos) llegan al resultado", async () => {
    const broken = exportDataset({ objectsByLayer: { ...document.objectsByLayer, [IDS.rojo]: [pathObject("x", IDS.rojo, "M0 0 L10 0", { matrix: { a: Number.NaN, b: 0, c: 0, d: 1, e: 0, f: 0 } }), ...document.objectsByLayer[IDS.rojo]] } });
    const result = await generateExport(broken, selection, options({ format: "dxf" }), { yieldToEventLoop: noYield });
    expect(result.warnings).toEqual(["1 objeto con una transformación inválida se omitió del DXF."]);
  });
});
