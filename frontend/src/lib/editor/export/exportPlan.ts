import { LASER_CHECK_KIND_INFO, LASER_CHECK_STATUS_LABEL, type LaserCheckReport } from "../laserCheck";
import type { ManufacturingOperationValue } from "../../../types/manufacturingOperations";
import { formatDisplayNumber } from "../units";
import { archiveFileName, documentFileName, layerFileNames, type ExportExtension } from "./fileNames";
import { documentSizeMm, layerObjects, OPERATION_LABEL, orderedLayers, selectedLayers, type ExportDocument } from "./exportDocument";
import { normalizeBackground, PNG_DEFAULT_BACKGROUND, PNG_DEFAULT_WIDTH, resolvePngSize } from "./pngExport";

/**
 * Preflight del export (M3-S15): función PURA que, antes de generar nada, dice qué se va a exportar y qué hay que saber. Dimensiones (mm o «sin escala»), layers
 * incluidas y excluidas (y por qué) con su operación, nombres de archivo, avisos y el estado del Laser Check restringido a lo que se exporta. El Laser Check que no
 * se pudo verificar (sin reporte, desactualizado o con checks pendientes) se muestra como NO VERIFICADO: nunca como «OK». Con un Laser Check Blocking se puede
 * exportar igual, pero solo con confirmación explícita (`requiresConfirmation`).
 */

export type ExportFormat = "svg" | "dxf" | "png";
/** `document`: un archivo con las layers elegidas. `layers`: un archivo por layer (en un ZIP si son varios). */
export type ExportMode = "document" | "layers";

export interface ExportOptions {
  format: ExportFormat;
  mode: ExportMode;
  /** Ancho del PNG en píxeles (el alto sale de la relación de aspecto). */
  pngWidth: number;
  /** Fondo del PNG: `null` = transparente; si no, un color `#rgb`/`#rrggbb`. */
  pngBackground: string | null;
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = { format: "svg", mode: "document", pngWidth: PNG_DEFAULT_WIDTH, pngBackground: PNG_DEFAULT_BACKGROUND };

export const FORMAT_LABEL: Record<ExportFormat, string> = { svg: "SVG", dxf: "DXF", png: "PNG" };
/** Cuántos issues bloqueantes se listan en el preflight (el recuento cuenta todos). */
export const MAX_PREFLIGHT_ISSUES_SHOWN = 8;

/** Por qué una layer no entra al export: oculta, operación IGNORE o simplemente no elegida (la oculta/ignorada tiene prioridad en el mensaje). */
export type ExclusionReason = "hidden" | "ignore" | "excluded" | "not_selected";

export const EXCLUSION_LABEL: Record<ExclusionReason, string> = { hidden: "oculta", ignore: "ignorada (operación IGNORE)", excluded: "excluida en la paleta (p. ej. fondo)", not_selected: "no seleccionada" };

export interface PreflightLayer {
  groupId: string;
  name: string;
  colorHex: string;
  operation: ManufacturingOperationValue;
  operationLabel: string;
  visible: boolean;
  objectCount: number;
  included: boolean;
  exclusion: ExclusionReason | null;
  /** Nombre del archivo de esta layer en el modo «un archivo por layer» (solo si está incluida). */
  fileName: string | null;
  /** Lo que conviene saber de una layer INCLUIDA (oculta, ignorada, sin operación, vacía). */
  notes: string[];
}

export type LaserPreflightState = "ready" | "review" | "blocking" | "unverified";

export const LASER_PREFLIGHT_LABEL: Record<LaserPreflightState, string> = {
  ready: LASER_CHECK_STATUS_LABEL.ready,
  review: LASER_CHECK_STATUS_LABEL.review,
  blocking: LASER_CHECK_STATUS_LABEL.blocking,
  unverified: "No verificado",
};

export interface PreflightBlockingIssue {
  id: string;
  kindLabel: string;
  layerName: string;
  objectLabel: string;
  message: string;
}

export interface LaserPreflight {
  state: LaserPreflightState;
  label: string;
  /** Una frase con el estado y los conteos. */
  summary: string;
  /** Issues bloqueantes de las layers que se exportan. */
  blocking: PreflightBlockingIssue[];
  /** Avisos (no bloqueantes) de las layers que se exportan. */
  reviewCount: number;
  /** Bloqueantes de layers que NO se exportan (no cuentan para el estado, pero se informan). */
  blockingOutside: number;
  /** Checks que no se pudieron correr, con su motivo. */
  unverified: string[];
}

export interface ExportWarning {
  code: "no_scale" | "unassigned" | "included_hidden" | "included_ignored" | "empty_layers" | "png_preview";
  message: string;
}

export interface ExportPreflight {
  /** Tamaño del área de trabajo en mm, o `null` sin escala física. */
  dimensions: { widthMm: number; heightMm: number } | null;
  /** Tamaño del área de trabajo en unidades de documento. */
  units: { width: number; height: number };
  /** Texto de las dimensiones para mostrar («200 × 100 mm» / «320 × 240 u (sin escala)»). */
  dimensionsText: string;
  layers: PreflightLayer[];
  includedCount: number;
  /** Objetos de las layers incluidas. */
  objectCount: number;
  laser: LaserPreflight;
  warnings: ExportWarning[];
  /** Archivos que se generan (dentro del ZIP, si va empaquetado). */
  files: string[];
  /** Nombre del archivo que se descarga (el ZIP si son varios archivos), o `null` si no hay nada que exportar. */
  downloadName: string | null;
  packaged: boolean;
  /** Tamaño del PNG (solo con formato PNG y un ancho válido). */
  png: { width: number; height: number } | null;
  /** Por qué no se puede exportar (sin layers, sin objetos, PNG fuera de tope...), o `null`. */
  error: string | null;
  /** Laser Check Blocking: exportar exige confirmación explícita. */
  requiresConfirmation: boolean;
  canExport: boolean;
}

function layerNotes(visible: boolean, operation: ManufacturingOperationValue, objectCount: number): string[] {
  const notes: string[] = [];
  if (!visible) notes.push("oculta en el editor");
  if (operation === "ignore") notes.push("operación IGNORE");
  if (operation === "unassigned") notes.push("sin operación asignada");
  if (objectCount === 0) notes.push("sin objetos");
  return notes;
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function buildLaserPreflight(report: LaserCheckReport | null, includedIds: ReadonlySet<string>): LaserPreflight {
  if (!report) {
    return {
      state: "unverified",
      label: LASER_PREFLIGHT_LABEL.unverified,
      summary: "No verificado: el Laser Check todavía no terminó (o el documento cambió desde el último análisis).",
      blocking: [],
      reviewCount: 0,
      blockingOutside: 0,
      unverified: ["Laser Check: sin resultado vigente."],
    };
  }
  const blocking: PreflightBlockingIssue[] = [];
  let blockingOutside = 0;
  let reviewCount = 0;
  for (const issue of report.issues) {
    const inside = includedIds.has(issue.layerGroupId);
    if (issue.severity === "error") {
      if (inside) blocking.push({ id: issue.id, kindLabel: LASER_CHECK_KIND_INFO[issue.kind].label, layerName: issue.layerName, objectLabel: issue.objectLabel, message: issue.message });
      else blockingOutside += 1;
    } else if (inside) {
      reviewCount += 1;
    }
  }
  const unverified = report.unverified.map((check) => `${check.label}: ${check.reason}`);
  const state: LaserPreflightState = blocking.length > 0 ? "blocking" : unverified.length > 0 ? "unverified" : reviewCount > 0 ? "review" : "ready";
  const parts: string[] = [];
  if (blocking.length > 0) parts.push(`${plural(blocking.length, "problema bloqueante", "problemas bloqueantes")} en lo que se exporta`);
  if (reviewCount > 0) parts.push(plural(reviewCount, "aviso", "avisos"));
  if (unverified.length > 0) parts.push(`no verificado: ${report.unverified.map((check) => check.label).join(", ")}`);
  if (blockingOutside > 0) parts.push(`${plural(blockingOutside, "bloqueante", "bloqueantes")} en layers que no se exportan`);
  const summary = `Laser Check: ${LASER_PREFLIGHT_LABEL[state]}.${parts.length > 0 ? ` ${parts.join("; ")}.` : " Sin problemas detectados."}`;
  return { state, label: LASER_PREFLIGHT_LABEL[state], summary, blocking, reviewCount, blockingOutside, unverified };
}

/**
 * Preflight del export. `selection` son los `groupId` elegidos (un id que no existe se ignora); `laserReport` es el reporte VIGENTE del Laser Check o `null` si no
 * hay uno (todavía no corrió, o quedó desactualizado): en ese caso el estado es «No verificado».
 */
export function buildExportPreflight(document: ExportDocument, selection: ReadonlySet<string>, options: ExportOptions, laserReport: LaserCheckReport | null): ExportPreflight {
  const dimensions = documentSizeMm(document);
  const units = { width: document.frame.width, height: document.frame.height };
  const dimensionsText = dimensions
    ? `${formatDisplayNumber(dimensions.widthMm)} × ${formatDisplayNumber(dimensions.heightMm)} mm`
    : `${formatDisplayNumber(units.width)} × ${formatDisplayNumber(units.height)} u (sin escala)`;

  const included = selectedLayers(document, selection);
  const includedIds = new Set(included.map((layer) => layer.groupId));
  const extension: Exclude<ExportExtension, "zip"> = options.format;
  const fileNameByLayer = layerFileNames(document.projectName, included, extension);

  const layers: PreflightLayer[] = orderedLayers(document.layers).map((layer) => {
    const isIncluded = includedIds.has(layer.groupId);
    const exclusion: ExclusionReason | null = isIncluded ? null : !layer.visible ? "hidden" : layer.manufacturingOperation === "ignore" ? "ignore" : layer.isExcluded ? "excluded" : "not_selected";
    const objects = layerObjects(document, layer.groupId).length;
    return {
      groupId: layer.groupId,
      name: layer.name,
      colorHex: layer.colorHex,
      operation: layer.manufacturingOperation,
      operationLabel: OPERATION_LABEL[layer.manufacturingOperation],
      visible: layer.visible,
      objectCount: objects,
      included: isIncluded,
      exclusion,
      fileName: isIncluded ? (fileNameByLayer[layer.groupId] ?? null) : null,
      notes: isIncluded ? layerNotes(layer.visible, layer.manufacturingOperation, objects) : [],
    };
  });

  const includedLayers = layers.filter((layer) => layer.included);
  const objectCount = includedLayers.reduce((total, layer) => total + layer.objectCount, 0);

  const warnings: ExportWarning[] = [];
  if (dimensions === null) {
    const message =
      options.format === "dxf"
        ? "Sin escala física: el DXF se escribe en unidades del documento, sin unidades ($INSUNITS = 0); al importarlo hay que indicar la escala."
        : options.format === "svg"
          ? "Sin escala física: el SVG no lleva milímetros (sus medidas son unidades del documento)."
          : "Sin escala física: no se puede indicar el tamaño real del documento.";
    warnings.push({ code: "no_scale", message });
  }
  const unassigned = includedLayers.filter((layer) => layer.operation === "unassigned");
  if (unassigned.length > 0) warnings.push({ code: "unassigned", message: `${plural(unassigned.length, "layer incluida no tiene", "layers incluidas no tienen")} operación asignada: ${unassigned.map((layer) => layer.name).join(", ")}.` });
  const hidden = includedLayers.filter((layer) => !layer.visible);
  if (hidden.length > 0) warnings.push({ code: "included_hidden", message: `Se incluye ${plural(hidden.length, "layer oculta", "layers ocultas")} (la elegiste a mano): ${hidden.map((layer) => layer.name).join(", ")}.` });
  const ignored = includedLayers.filter((layer) => layer.operation === "ignore");
  if (ignored.length > 0) warnings.push({ code: "included_ignored", message: `Se incluye ${plural(ignored.length, "layer ignorada", "layers ignoradas")} (la elegiste a mano): ${ignored.map((layer) => layer.name).join(", ")}.` });
  const empty = includedLayers.filter((layer) => layer.objectCount === 0);
  if (empty.length > 0) warnings.push({ code: "empty_layers", message: `${plural(empty.length, "layer incluida no tiene", "layers incluidas no tienen")} objetos: ${empty.map((layer) => layer.name).join(", ")}.` });
  if (options.format === "png") warnings.push({ code: "png_preview", message: "El PNG es una vista previa: no conserva la escala ni sirve como archivo de fabricación." });

  let error: string | null = null;
  let png: ExportPreflight["png"] = null;
  if (included.length === 0) error = "Elegí al menos una layer para exportar.";
  else if (objectCount === 0) error = "Las layers elegidas no tienen objetos: no hay nada que exportar.";
  if (options.format === "png" && error === null) {
    const size = resolvePngSize(document.frame, options.pngWidth);
    if (!size.ok) error = size.error;
    else png = { width: size.width, height: size.height };
    if (error === null && options.pngBackground !== null && normalizeBackground(options.pngBackground) === null) error = "El color de fondo del PNG no es válido (usá #rgb o #rrggbb).";
  }

  const files = options.mode === "layers" ? includedLayers.map((layer) => layer.fileName ?? "").filter((name) => name.length > 0) : included.length > 0 ? [documentFileName(document.projectName, extension)] : [];
  const packaged = files.length > 1;
  const downloadName = files.length === 0 ? null : packaged ? archiveFileName(document.projectName) : files[0];

  const laser = buildLaserPreflight(laserReport, includedIds);
  return {
    dimensions,
    units,
    dimensionsText,
    layers,
    includedCount: includedLayers.length,
    objectCount,
    laser,
    warnings,
    files,
    downloadName,
    packaged,
    png,
    error,
    requiresConfirmation: laser.state === "blocking",
    canExport: error === null && files.length > 0,
  };
}
