import type { EditableDocument, EditorObject, EditProduction } from "./types";

/**
 * Selección por ids de objeto (MVP3-S01, ADR D3) y construcción de ediciones
 * sobre la selección. Puro: la UI (VectorCanvas/Inspector) y los tests usan
 * las mismas funciones.
 */

/** Lo mínimo de una capa que necesita la selección (compatible con `VectorDocumentLayer`). */
export interface SelectableLayer {
  groupId: string;
  locked: boolean;
}

/**
 * Objetos SELECCIONABLES en orden de pintado (el último queda arriba): solo
 * capas visibles, siguiendo el orden de `layers` (ya ordenado por `order`).
 * Las capas bloqueadas SÍ son seleccionables (para inspeccionar); lo que no
 * pueden es modificarse (ver `splitByLock`).
 */
export function selectableObjects(
  objectsByLayer: Record<string, EditorObject[]>,
  layers: readonly SelectableLayer[],
  visibility: Record<string, boolean>,
): EditorObject[] {
  const result: EditorObject[] = [];
  for (const layer of layers) {
    if (!(visibility[layer.groupId] ?? true)) continue;
    const objects = objectsByLayer[layer.groupId];
    if (objects) result.push(...objects);
  }
  return result;
}

/** Subconjunto de `pool` (en su orden de pintado) cuyos ids están en `ids`. Ids que ya no existen o no son seleccionables se descartan. */
export function resolveSelection(pool: readonly EditorObject[], ids: ReadonlySet<string>): EditorObject[] {
  if (ids.size === 0) return [];
  return pool.filter((object) => ids.has(object.id));
}

/** Shift+click: agrega el id si no estaba, lo quita si estaba. */
export function toggleId(ids: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(ids);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/**
 * Alt+click sobre una pila de objetos superpuestos (`stack`, el de más arriba
 * primero): elige el SIGUIENTE hacia abajo respecto del que ya está
 * seleccionado en esa pila; con ninguno seleccionado, el de más arriba; al
 * llegar al fondo vuelve al tope.
 */
export function cycleHit(stack: readonly EditorObject[], selectedIds: ReadonlySet<string>): EditorObject | null {
  if (stack.length === 0) return null;
  const currentIndex = stack.findIndex((object) => selectedIds.has(object.id));
  if (currentIndex === -1) return stack[0];
  return stack[(currentIndex + 1) % stack.length];
}

/** Separa objetos editables de los de capas bloqueadas. */
export function splitByLock(
  objects: readonly EditorObject[],
  lockedLayerIds: ReadonlySet<string>,
): { editable: EditorObject[]; locked: EditorObject[] } {
  const editable: EditorObject[] = [];
  const locked: EditorObject[] = [];
  for (const object of objects) {
    (lockedLayerIds.has(object.layerGroupId) ? locked : editable).push(object);
  }
  return { editable, locked };
}

/**
 * Construye la producción de un comando que reemplaza los `targets` por el
 * resultado de `map(targets)` (mismo largo y orden: el mapeo trata la
 * selección COMPLETA como grupo, p. ej. con el pivote en el centro del grupo).
 * Solo devuelve las capas efectivamente tocadas; los objetos no seleccionados
 * conservan su referencia. `null` si nada cambió.
 */
export function replaceObjects(
  state: EditableDocument,
  targets: readonly EditorObject[],
  map: (targets: EditorObject[]) => EditorObject[],
): EditProduction | null {
  if (targets.length === 0) return null;
  const mapped = map([...targets]);
  if (mapped.length !== targets.length) return null;

  const replacements = new Map<string, EditorObject>();
  targets.forEach((target, index) => {
    if (mapped[index] !== target) replacements.set(target.id, mapped[index]);
  });
  if (replacements.size === 0) return null;

  const layers: Record<string, EditorObject[]> = {};
  for (const [layerId, objects] of Object.entries(state.objectsByLayer)) {
    if (!objects.some((object) => replacements.has(object.id))) continue;
    layers[layerId] = objects.map((object) => replacements.get(object.id) ?? object);
  }
  return Object.keys(layers).length > 0 ? { layers } : null;
}

/** Producción que elimina los objetos con esos ids. `null` si ninguno existe. */
export function removeObjects(state: EditableDocument, ids: ReadonlySet<string>): EditProduction | null {
  const layers: Record<string, EditorObject[]> = {};
  for (const [layerId, objects] of Object.entries(state.objectsByLayer)) {
    if (!objects.some((object) => ids.has(object.id))) continue;
    layers[layerId] = objects.filter((object) => !ids.has(object.id));
  }
  return Object.keys(layers).length > 0 ? { layers } : null;
}
