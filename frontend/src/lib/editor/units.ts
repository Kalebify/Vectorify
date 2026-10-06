/**
 * Unidades del editor (ADR D1): el espacio de DOCUMENTO son las unidades del
 * `viewBox` del VectorDocument (px de origen); los milímetros se derivan con
 * un único factor, `mmPerUnit = widthMm / viewBoxWidth`. Este archivo es el
 * ÚNICO lugar donde se convierte entre ambos (el Inspector muestra y acepta
 * mm; ninguna operación guarda mm ni coordenadas de pantalla).
 */

/** Factor mm por unidad de documento, o `null` si el documento no tiene dimensiones físicas conocidas (ancho en mm o viewBox inválidos). */
export function mmPerUnit(widthMm: number | null | undefined, viewBoxWidth: number | null | undefined): number | null {
  if (widthMm === null || widthMm === undefined || viewBoxWidth === null || viewBoxWidth === undefined) return null;
  if (!Number.isFinite(widthMm) || !Number.isFinite(viewBoxWidth) || widthMm <= 0 || viewBoxWidth <= 0) return null;
  return widthMm / viewBoxWidth;
}

export function toMm(units: number, factor: number): number {
  return units * factor;
}

export function fromMm(mm: number, factor: number): number {
  return mm / factor;
}

/** Tolerancia de hit-testing en px de PANTALLA convertida a unidades de documento (a más zoom, menos unidades de documento). */
export function screenToleranceToDocument(pixels: number, scale: number): number {
  return scale > 0 && Number.isFinite(scale) ? pixels / scale : pixels;
}

/**
 * Texto de un campo numérico del Inspector -> número, o `null` si es inválido
 * (vacío, texto, infinito). Acepta coma decimal ("12,5") por el locale
 * es-AR del resto de la app; no acepta notación con separador de miles.
 */
export function parseNumericInput(text: string): number | null {
  const normalized = text.trim().replace(",", ".");
  if (normalized.length === 0) return null;
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

/** Número para mostrar en un campo (hasta 3 decimales, sin ceros de relleno, sin "-0"). */
export function formatDisplayNumber(value: number, decimals = 3): string {
  if (!Number.isFinite(value)) return "";
  const rounded = Number(value.toFixed(decimals));
  return String(Object.is(rounded, -0) ? 0 : rounded);
}
