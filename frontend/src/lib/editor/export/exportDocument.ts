import type { ManufacturingOperationValue } from "../../../types/manufacturingOperations";
import { frameSizeMm } from "../frame";
import type { DocumentFrame, EditableLayerMeta, EditorObject } from "../types";

/**
 * Lo que el export lee del editor (M3-S15): el documento EN MEMORIA tal como lo ve el usuario (estado confirmado, con la estructura efectiva de capas y la
 * visibilidad efectiva), no la versión guardada. Se arma en el shell; todo el export es puro sobre esta forma.
 */
export interface ExportDocument {
  /** Nombre del proyecto (de ahí sale la primera parte de cada nombre de archivo). */
  projectName: string;
  /** Área de trabajo (la «hoja»): lo que se exporta es el contenido de este marco, en unidades de documento. */
  frame: DocumentFrame;
  /** mm por unidad de documento, o `null` si el documento no tiene escala física. */
  mmFactor: number | null;
  layers: readonly EditableLayerMeta[];
  objectsByLayer: Readonly<Record<string, readonly EditorObject[]>>;
}

export const OPERATION_LABEL: Record<ManufacturingOperationValue, string> = { cut: "Corte", engrave: "Grabado", ignore: "Ignorada", unassigned: "Sin operación" };

/** Capas por orden de pintado (`order`; desempate por `groupId` para que el resultado sea determinista). */
export function orderedLayers(layers: readonly EditableLayerMeta[]): EditableLayerMeta[] {
  return [...layers].sort((left, right) => left.order - right.order || (left.groupId < right.groupId ? -1 : left.groupId > right.groupId ? 1 : 0));
}

export function layerObjects(document: ExportDocument, groupId: string): readonly EditorObject[] {
  return document.objectsByLayer[groupId] ?? [];
}

/** Selección por defecto de layers a exportar: las VISIBLES y distintas de IGNORE. */
export function defaultExportSelection(layers: readonly EditableLayerMeta[]): Set<string> {
  return new Set(layers.filter((layer) => layer.visible && layer.manufacturingOperation !== "ignore").map((layer) => layer.groupId));
}

/** Las capas elegidas, en orden de pintado. Un id que no existe se ignora. */
export function selectedLayers(document: ExportDocument, selection: ReadonlySet<string>): EditableLayerMeta[] {
  return orderedLayers(document.layers).filter((layer) => selection.has(layer.groupId));
}

/** Tamaño físico del área de trabajo, o `null` sin escala. */
export function documentSizeMm(document: ExportDocument): { widthMm: number; heightMm: number } | null {
  return frameSizeMm(document.frame, document.mmFactor);
}
