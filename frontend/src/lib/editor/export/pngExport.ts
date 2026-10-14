import type { DocumentFrame, EditableLayerMeta } from "../types";
import type { ExportDocument } from "./exportDocument";
import { buildSvg } from "./svgExport";

/**
 * Export PNG (M3-S15): una vista previa (NO un archivo de fabricación: la escala se pierde en píxeles). El SVG exportado se rasteriza detrás de una interfaz
 * inyectable (`Rasterizer`), así la lógica (tamaño, relación de aspecto, topes, fondo) se prueba sin navegador; la implementación real, con `<canvas>`, está en
 * `rasterizeCanvas.ts`.
 */

/** Ancho por defecto de la vista previa. */
export const PNG_DEFAULT_WIDTH = 1024;
/** Ancho mínimo: por debajo no hay nada que ver. */
export const PNG_MIN_SIDE = 16;
/** Tope por lado y por área: protegen la memoria del navegador (un canvas más grande falla o se vacía en silencio). */
export const PNG_MAX_SIDE = 8192;
export const PNG_MAX_PIXELS = 16_000_000;
/** Fondo opaco por defecto. */
export const PNG_DEFAULT_BACKGROUND = "#ffffff";

/**
 * `background`: `null` = transparente; si no, un color CSS `#rgb`/`#rrggbb`. Devuelve los bytes de un PNG.
 */
export type Rasterizer = (svg: string, width: number, height: number, background: string | null) => Promise<Uint8Array>;

function heightFor(frame: Pick<DocumentFrame, "width" | "height">, width: number): number {
  return Math.max(1, Math.round((width * frame.height) / frame.width));
}

function exceedsLimits(width: number, height: number): boolean {
  return width > PNG_MAX_SIDE || height > PNG_MAX_SIDE || width * height > PNG_MAX_PIXELS;
}

/** El mayor ancho que respeta los topes con la relación de aspecto del marco (el que se sugiere en el mensaje de error). */
export function maxPngWidth(frame: Pick<DocumentFrame, "width" | "height">): number {
  let width = Math.floor(Math.min(PNG_MAX_SIDE, (PNG_MAX_SIDE * frame.width) / frame.height, Math.sqrt((PNG_MAX_PIXELS * frame.width) / frame.height)));
  // El alto se redondea: el candidato puede pasarse por un píxel de área; se baja hasta que entre.
  while (width > PNG_MIN_SIDE && exceedsLimits(width, heightFor(frame, width))) width -= 1;
  return Math.max(PNG_MIN_SIDE, width);
}

export type PngSizeResult = { ok: true; width: number; height: number } | { ok: false; error: string };

/** Tamaño del PNG para un ancho pedido: el alto sale de la relación de aspecto del área de trabajo. Fuera de los topes => error con el máximo que sí se admite. */
export function resolvePngSize(frame: Pick<DocumentFrame, "width" | "height">, requestedWidth: number): PngSizeResult {
  if (!(frame.width > 0) || !(frame.height > 0) || !Number.isFinite(frame.width) || !Number.isFinite(frame.height)) {
    return { ok: false, error: "El área de trabajo no tiene un tamaño válido para generar un PNG." };
  }
  if (!Number.isFinite(requestedWidth)) return { ok: false, error: "Indicá un ancho en píxeles para el PNG." };
  const width = Math.round(requestedWidth);
  if (width < PNG_MIN_SIDE) return { ok: false, error: `El ancho mínimo del PNG es ${PNG_MIN_SIDE} px.` };
  const height = heightFor(frame, width);
  if (exceedsLimits(width, height)) {
    return {
      ok: false,
      error: `El PNG de ${width} × ${height} px supera el máximo (${PNG_MAX_SIDE} px por lado y ${PNG_MAX_PIXELS / 1_000_000} megapíxeles). Con este documento el ancho máximo es ${maxPngWidth(frame)} px.`,
    };
  }
  return { ok: true, width, height };
}

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Color de fondo válido (`#rgb` / `#rrggbb`), normalizado a minúsculas; `null` si no lo es. */
export function normalizeBackground(color: string): string | null {
  const trimmed = color.trim();
  return HEX_COLOR.test(trimmed) ? trimmed.toLowerCase() : null;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length > PNG_SIGNATURE.length && PNG_SIGNATURE.every((value, index) => bytes[index] === value);
}

/** Dimensiones declaradas en el IHDR de un PNG, o `null` si no es un PNG. */
export function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (!isPng(bytes) || bytes.length < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
}

export interface PngRender {
  document: ExportDocument;
  layers: readonly EditableLayerMeta[];
  width: number;
  height: number;
  /** `null` = fondo transparente. */
  background: string | null;
}

/** Rasteriza las capas dadas: SVG con el tamaño en píxeles pedido -> `rasterize`. Valida lo que devuelve (un PNG de verdad) antes de aceptarlo. */
export async function renderPng(render: PngRender, rasterize: Rasterizer): Promise<Uint8Array> {
  const svg = buildSvg(render.document, render.layers, { pixelSize: { width: render.width, height: render.height } });
  const bytes = await rasterize(svg, render.width, render.height, render.background);
  if (!isPng(bytes)) throw new Error("El navegador no devolvió una imagen PNG válida.");
  return bytes;
}
