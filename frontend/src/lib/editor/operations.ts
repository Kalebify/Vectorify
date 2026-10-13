import { replaceObjects } from "./selection";
import { groupCenter, rotateAbout, scaleAbout, setBounds, translate } from "./transform";
import type { EditableDocument, EditorObject, EditProduction, Point, Rect } from "./types";

/**
 * Productores de las operaciones geométricas simples sobre objetos por id (M3-S12). Los comparten la UI (arrastre, flechas, Inspector) y el ejecutor
 * declarativo (`commandExecutor.ts`): así «ejecutar un comando» y «hacerlo con la UI» recorren EXACTAMENTE el mismo código. Lógica pura.
 */

/** Los objetos del documento con esos ids, en el orden del documento. */
export function objectsByIds(state: EditableDocument, ids: ReadonlySet<string>): EditorObject[] {
  return Object.values(state.objectsByLayer)
    .flat()
    .filter((object) => ids.has(object.id));
}

/** Traslada los objetos (arrastre del canvas, flechas, `object.move`/`object.nudge`): compone la matriz, `d` queda intacto. */
export function moveProduction(state: EditableDocument, ids: ReadonlySet<string>, dx: number, dy: number): EditProduction | null {
  return replaceObjects(state, objectsByIds(state, ids), (found) => translate(found, dx, dy));
}

/** Rota los objetos COMO GRUPO `degrees` (horario en pantalla) alrededor del centro de su caja (Inspector, `object.rotate`). */
export function rotateProduction(state: EditableDocument, ids: ReadonlySet<string>, degrees: number): EditProduction | null {
  const targets = objectsByIds(state, ids);
  const center = groupCenter(targets);
  if (!center) return null;
  return replaceObjects(state, targets, (found) => rotateAbout(found, center, degrees));
}

/** Escala los objetos COMO GRUPO alrededor de `pivot` (por defecto el centro de su caja): `object.scale`. */
export function scaleProduction(state: EditableDocument, ids: ReadonlySet<string>, sx: number, sy: number, pivot?: Point): EditProduction | null {
  const targets = objectsByIds(state, ids);
  const center = pivot ?? groupCenter(targets);
  if (!center) return null;
  return replaceObjects(state, targets, (found) => scaleAbout(found, center, sx, sy));
}

/** Fija posición y tamaño del grupo (Inspector numérico, `object.setBounds`). Un destino inválido deja los objetos como estaban. */
export function setBoundsProduction(state: EditableDocument, ids: ReadonlySet<string>, target: Rect): EditProduction | null {
  return replaceObjects(state, objectsByIds(state, ids), (found) => setBounds(found, target) ?? found);
}
