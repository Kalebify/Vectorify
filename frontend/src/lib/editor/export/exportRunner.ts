import type { EditableLayerMeta } from "../types";
import { assembleDxf, dxfLayerBody, dxfWarnings, planDxfLayers, type DxfLayerBody } from "./dxfExport";
import { selectedLayers, type ExportDocument } from "./exportDocument";
import { buildExportPreflight, type ExportFormat, type ExportOptions } from "./exportPlan";
import { archiveFileName } from "./fileNames";
import { normalizeBackground, renderPng, resolvePngSize, type Rasterizer } from "./pngExport";
import { buildSvg } from "./svgExport";
import { createZip, utf8 } from "./zip";

/**
 * Generación del export (M3-S15): del documento en memoria a los bytes del archivo que se descarga. Sin DOM: lo único que toca el navegador (el rasterizado del PNG
 * y la descarga) entra por parámetros. Todo o nada: si algo falla se lanza un `ExportError` y NO se devuelve un archivo parcial.
 */

export const MIME_BY_FORMAT: Record<ExportFormat, string> = { svg: "image/svg+xml", dxf: "image/vnd.dxf", png: "image/png" };
export const ZIP_MIME = "application/zip";

export interface GeneratedExport {
  /** Nombre del archivo a descargar (el ZIP si son varios archivos). */
  name: string;
  mime: string;
  data: Uint8Array;
  /** Archivos incluidos (los del ZIP, o el único). */
  files: string[];
  /** Avisos de la generación (p. ej. objetos omitidos del DXF). */
  warnings: string[];
}

export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportError";
  }
}

export interface GenerateDeps {
  /** Necesario solo para PNG. */
  rasterize?: Rasterizer;
  /** Cede el control entre layers para no congelar la UI en documentos grandes. */
  yieldToEventLoop?: () => Promise<void>;
  /** Cancela la generación (se cierra el diálogo): lanza un `AbortError` y no se entrega nada. */
  signal?: AbortSignal;
}

const defaultYield = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function abortError(): Error {
  const error = new Error("Export cancelado.");
  error.name = "AbortError";
  return error;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

interface NamedFile {
  name: string;
  data: Uint8Array;
}

/**
 * Genera el export. Valida con el mismo preflight que ve el usuario (sin layers, sin objetos, PNG fuera de tope => `ExportError`). Modo `document`: un archivo con todas
 * las layers elegidas. Modo `layers`: un archivo por layer, todos con el mismo marco y tamaño (se superponen exactamente), empaquetados en un ZIP si son varios.
 */
export async function generateExport(document: ExportDocument, selection: ReadonlySet<string>, options: ExportOptions, deps: GenerateDeps = {}): Promise<GeneratedExport> {
  const preflight = buildExportPreflight(document, selection, options, null);
  if (!preflight.canExport) throw new ExportError(preflight.error ?? "No hay nada que exportar.");
  const layers = selectedLayers(document, selection);
  const yieldToEventLoop = deps.yieldToEventLoop ?? defaultYield;
  const checkpoint = async () => {
    if (deps.signal?.aborted) throw abortError();
    await yieldToEventLoop();
    if (deps.signal?.aborted) throw abortError();
  };

  const files: NamedFile[] = [];
  const warnings: string[] = [];
  const addWarnings = (found: readonly string[]) => {
    for (const warning of found) if (!warnings.includes(warning)) warnings.push(warning);
  };

  // Un trozo de trabajo por layer: render, SVG o entidades DXF; entre uno y otro se cede el control.
  if (options.mode === "layers") {
    const fileNames = new Map(preflight.layers.map((layer) => [layer.groupId, layer.fileName ?? ""]));
    for (const layer of layers) {
      await checkpoint();
      files.push({ name: fileNames.get(layer.groupId) ?? "", data: await renderOne(document, [layer], options, deps, addWarnings) });
    }
  } else {
    files.push({ name: preflight.files[0], data: await renderOne(document, layers, options, deps, addWarnings, checkpoint) });
  }
  if (deps.signal?.aborted) throw abortError();

  if (files.length === 1) return { name: files[0].name, mime: MIME_BY_FORMAT[options.format], data: files[0].data, files: [files[0].name], warnings };
  try {
    return {
      name: archiveFileName(document.projectName),
      mime: ZIP_MIME,
      data: createZip(files.map((file) => ({ name: file.name, data: file.data }))),
      files: files.map((file) => file.name),
      warnings,
    };
  } catch (error) {
    throw new ExportError(error instanceof Error ? error.message : "No se pudo armar el ZIP.");
  }
}

/** Los bytes de UN archivo con las layers dadas, en el formato elegido. */
async function renderOne(
  document: ExportDocument,
  layers: readonly EditableLayerMeta[],
  options: ExportOptions,
  deps: GenerateDeps,
  addWarnings: (warnings: readonly string[]) => void,
  checkpoint?: () => Promise<void>,
): Promise<Uint8Array> {
  if (options.format === "svg") return utf8(buildSvg(document, layers));

  if (options.format === "dxf") {
    const plans = planDxfLayers(layers);
    const bodies: DxfLayerBody[] = [];
    for (const plan of plans) {
      if (checkpoint && bodies.length > 0) await checkpoint();
      bodies.push(dxfLayerBody(document, plan));
    }
    addWarnings(dxfWarnings(bodies));
    return utf8(assembleDxf(plans, bodies, document.mmFactor !== null));
  }

  if (!deps.rasterize) throw new ExportError("Este navegador no puede generar el PNG (no hay un rasterizador disponible).");
  const size = resolvePngSize(document.frame, options.pngWidth);
  if (!size.ok) throw new ExportError(size.error);
  const background = options.pngBackground === null ? null : normalizeBackground(options.pngBackground);
  if (options.pngBackground !== null && background === null) throw new ExportError("El color de fondo del PNG no es válido (usá #rgb o #rrggbb).");
  try {
    return await renderPng({ document, layers, width: size.width, height: size.height, background }, deps.rasterize);
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ExportError(error instanceof Error && error.message ? `No se pudo generar el PNG: ${error.message}` : "No se pudo generar el PNG.");
  }
}
