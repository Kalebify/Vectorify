import { hexEquals } from "./colors";
import type { EditableLayerMeta, EditorEdit } from "./types";

/**
 * Estructura de capas del estado editable (MVP3-S03), lógica pura. La metadata de las capas del SERVIDOR sigue viviendo en
 * `useVectorDocument` (PATCH); el editor solo guarda lo que le es propio:
 * - `overrides`: la meta de las capas TOCADAS por comandos (capas creadas en el cliente, `isNew`, o capas del servidor con otro
 *   color). Sobre una capa del servidor solo manda `colorHex`: el resto (nombre, orden, bloqueo...) sigue siendo del servidor.
 * - `LocalLayerPatch`: ediciones de metadata de las capas `isNew` (que no existen en el servidor: no hay PATCH posible).
 */

/** Edición local de metadata de una capa `isNew` (sin PATCH). No forma parte del historial (la metadata de capas entra al historial en M3-S12). */
export type LocalLayerPatch = Partial<Pick<EditableLayerMeta, "name" | "visible" | "locked" | "order" | "manufacturingOperation">>;

/** Ids de capa que un comando agrega (`undo` -> los quita) o quita (`redo` -> ...) al cambiar de estado: las que están en un lado y no en el otro. */
export function layerIdsAbsentAfter(change: NonNullable<EditorEdit["layers"]>, direction: "undo" | "redo"): string[] {
  const target = direction === "undo" ? change.before : change.after;
  const origin = direction === "undo" ? change.after : change.before;
  const kept = new Set(target.map((layer) => layer.groupId));
  return origin.filter((layer) => !kept.has(layer.groupId)).map((layer) => layer.groupId);
}

/**
 * Aplica a los `overrides` el estado `snapshots` de las capas tocadas por un comando y quita las de `removeIds` (las que el comando
 * crea, al deshacerlo). Una capa del SERVIDOR que vuelve a su color original deja de ser un override (así `undo` hasta el origen
 * deja la estructura LIMPIA y el documento deja de figurar como modificado). Devuelve otro objeto: nunca muta el recibido.
 */
export function applyLayerSnapshots(
  overrides: Record<string, EditableLayerMeta>,
  snapshots: readonly EditableLayerMeta[],
  removeIds: readonly string[],
  serverColorOf: (groupId: string) => string | undefined,
): Record<string, EditableLayerMeta> {
  const next = { ...overrides };
  for (const groupId of removeIds) delete next[groupId];
  for (const snapshot of snapshots) {
    const serverColor = serverColorOf(snapshot.groupId);
    if (!snapshot.isNew && serverColor !== undefined && hexEquals(serverColor, snapshot.colorHex)) delete next[snapshot.groupId];
    else next[snapshot.groupId] = snapshot;
  }
  return next;
}

/** Lo mínimo de una capa efectiva para derivar su meta (compatible con `VectorDocumentLayer`). */
export interface LayerLike {
  groupId: string;
  name: string;
  colorHex: string;
  order: number;
  visible: boolean;
  locked: boolean;
  manufacturingOperation: EditableLayerMeta["manufacturingOperation"];
  isNew?: boolean;
}

/** Meta de las capas efectivas, con la visibilidad EFECTIVA que decida `visibleOf` (p. ej. con Isolate aplicado). */
export function toLayerMetas(layers: readonly LayerLike[], visibleOf: (layer: LayerLike) => boolean): EditableLayerMeta[] {
  return layers.map((layer) => ({
    groupId: layer.groupId,
    name: layer.name,
    colorHex: layer.colorHex,
    order: layer.order,
    visible: visibleOf(layer),
    locked: layer.locked,
    manufacturingOperation: layer.manufacturingOperation,
    isNew: layer.isNew === true,
  }));
}

export function sameLayerMeta(left: EditableLayerMeta, right: EditableLayerMeta): boolean {
  return (
    left.groupId === right.groupId &&
    left.name === right.name &&
    left.colorHex === right.colorHex &&
    left.order === right.order &&
    left.visible === right.visible &&
    left.locked === right.locked &&
    left.manufacturingOperation === right.manufacturingOperation &&
    left.isNew === right.isNew
  );
}

/**
 * Posición de las capas NUEVAS tras reordenar el panel de capas. El servidor solo conoce sus capas (su `order` va de 0 a n-1 y se
 * persiste con PATCH), así que cada capa nueva recibe un `order` FRACCIONARIO entre sus vecinas del servidor: ordenar por `order`
 * reproduce exactamente el orden pedido sin tocar ni persistir nada de las capas nuevas. `serverOrderOf` es el `order` que tendrá
 * cada capa del servidor una vez aplicado el reorden.
 */
export function placeNewLayers(orderedIds: readonly string[], isNew: (groupId: string) => boolean, serverOrderOf: (groupId: string) => number): Record<string, number> {
  const orders: Record<string, number> = {};
  const hasServerLayers = orderedIds.some((groupId) => !isNew(groupId));
  let index = 0;
  while (index < orderedIds.length) {
    if (!isNew(orderedIds[index])) {
      index += 1;
      continue;
    }
    // Tramo de capas nuevas consecutivas: se reparte entre la capa del servidor que lo precede y la que lo sigue.
    const start = index;
    while (index < orderedIds.length && isNew(orderedIds[index])) index += 1;
    const run = orderedIds.slice(start, index);
    if (!hasServerLayers) {
      run.forEach((groupId, offset) => (orders[groupId] = start + offset));
      continue;
    }
    const previous = start > 0 ? orderedIds[start - 1] : null;
    const next = index < orderedIds.length ? orderedIds[index] : null;
    const lower = previous !== null ? serverOrderOf(previous) : serverOrderOf(next as string) - 1;
    const upper = next !== null ? serverOrderOf(next) : lower + 1;
    run.forEach((groupId, offset) => (orders[groupId] = lower + ((upper - lower) * (offset + 1)) / (run.length + 1)));
  }
  return orders;
}
