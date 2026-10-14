import type { ExportDocument } from "../lib/editor/export/exportDocument";
import type { EditableLayerMeta, EditorObject } from "../lib/editor/types";
import { IDENTITY_MATRIX } from "../lib/svgTransform";

/**
 * Dataset del export (M3-S15). Documento 200 x 100 u con 0,5 mm por unidad (= 100 x 50 mm):
 *
 * - `rojo`  CUT, visible (orden 0): `marco` = cuadrado 10..90 x 10..60 CON HUECO (subpath 30..70 x 20..50 en sentido contrario) y `disco` = círculo de radio 20 (arcos -> cúbicas)
 *   desplazado con un transform `translate(5 5)`.
 * - `grabado` ENGRAVE, visible (orden 1): `linea` = línea abierta sin relleno con trazo.
 * - `ignorada` IGNORE, visible (orden 2): un rectángulo.
 * - `oculta` CUT, OCULTA (orden 3): un rectángulo.
 * - `sinop` sin operación asignada, visible (orden 4), con nombre con tildes y eñe: «Ñandú Ánimo».
 */

export const IDS = { rojo: "rojo-id", grabado: "grabado-id", ignorada: "ignorada-id", oculta: "oculta-id", sinop: "sinop-id" } as const;

export const MARCO_D = "M10 10 H90 V60 H10 Z M30 20 V50 H70 V20 Z";
export const DISCO_D = "M150 30 a20 20 0 1 0 40 0 a20 20 0 1 0 -40 0 Z";
export const LINEA_D = "M20 80 L180 80";

export function layer(groupId: string, overrides: Partial<EditableLayerMeta> = {}): EditableLayerMeta {
  return { groupId, name: groupId, colorHex: "#ff0000", order: 0, visible: true, locked: false, manufacturingOperation: "cut", isNew: false, ...overrides };
}

export function pathObject(id: string, layerGroupId: string, d: string, overrides: Partial<EditorObject> = {}): EditorObject {
  return { id, layerGroupId, d, fill: "#ff0000", matrix: IDENTITY_MATRIX, ...overrides };
}

export function exportDataset(overrides: Partial<ExportDocument> = {}): ExportDocument {
  const layers: EditableLayerMeta[] = [
    layer(IDS.rojo, { name: "Rojo", order: 0, manufacturingOperation: "cut", colorHex: "#ff0000" }),
    layer(IDS.grabado, { name: "Grabado", order: 1, manufacturingOperation: "engrave", colorHex: "#00aa00" }),
    layer(IDS.ignorada, { name: "Ignorada", order: 2, manufacturingOperation: "ignore", colorHex: "#999999" }),
    layer(IDS.oculta, { name: "Oculta", order: 3, visible: false, manufacturingOperation: "cut", colorHex: "#0000ff" }),
    layer(IDS.sinop, { name: "Ñandú Ánimo", order: 4, manufacturingOperation: "unassigned", colorHex: "#ffaa00" }),
  ];
  const objectsByLayer: Record<string, EditorObject[]> = {
    [IDS.rojo]: [
      pathObject("marco", IDS.rojo, MARCO_D),
      pathObject("disco", IDS.rojo, DISCO_D, { matrix: { a: 1, b: 0, c: 0, d: 1, e: 5, f: 5 } }),
    ],
    [IDS.grabado]: [pathObject("linea", IDS.grabado, LINEA_D, { fill: "none", stroke: "#00aa00", strokeWidth: 0.5 })],
    [IDS.ignorada]: [pathObject("ign", IDS.ignorada, "M0 0 H5 V5 H0 Z", { fill: "#999999" })],
    [IDS.oculta]: [pathObject("ocu", IDS.oculta, "M100 70 H120 V90 H100 Z", { fill: "#0000ff" })],
    [IDS.sinop]: [pathObject("sin", IDS.sinop, "M130 60 H150 V80 H130 Z", { fill: "#ffaa00" })],
  };
  return { projectName: "Mi Diseño", frame: { x: 0, y: 0, width: 200, height: 100 }, mmFactor: 0.5, layers, objectsByLayer, ...overrides };
}

/** El mismo documento sin escala física. */
export function exportDatasetNoScale(): ExportDocument {
  return exportDataset({ mmFactor: null });
}
