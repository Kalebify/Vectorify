import type { AffineMatrix } from "../svgTransform";
import { flipAboutMatrix, rotationAboutMatrix } from "./matrix";
import { replaceObjects } from "./selection";
import { applyMatrix, groupCenter } from "./transform";
import type { EditableDocument, EditorObject, EditProduction, Point } from "./types";

/**
 * Orientación = giros de 90° y reflejos (MVP3-S02): las 8 simetrías del cuadrado (grupo D4). Se representa por
 * su parte lineal 2×2 con coeficientes SIEMPRE en {-1, 0, 1}: componer N pasos es un producto de enteros pequeños,
 * exacto -- 4 giros de 90° o 2 reflejos dan la identidad SIN residuo de punto flotante, sin importar el orden ni
 * cuántas veces el usuario toque los botones antes de confirmar. Recién al aplicar se arma la matriz afín alrededor
 * de un pivote (`orientationAboutMatrix`), siempre desde el estado "antes" (misma regla de estabilidad que los gestos de S01).
 */
export interface Orientation {
  a: number;
  b: number;
  c: number;
  d: number;
}

export type OrientationStep = "rotate-cw" | "rotate-ccw" | "flip-horizontal" | "flip-vertical";

export const IDENTITY_ORIENTATION: Orientation = { a: 1, b: 0, c: 0, d: 1 };

const ORIGIN: Point = { x: 0, y: 0 };

/** Evita el `-0` que deja un producto como `0 * -1` (distinto de `0` para `Object.is`/`toEqual`). */
function exact(value: number): number {
  return value === 0 ? 0 : value;
}

function linearPart(matrix: AffineMatrix): Orientation {
  return { a: exact(matrix.a), b: exact(matrix.b), c: exact(matrix.c), d: exact(matrix.d) };
}

// Los pasos salen de los helpers EXACTOS de matrix.ts (rotación en múltiplos de 90° sin 6e-17, reflejo con enteros).
const STEP_ORIENTATION: Record<OrientationStep, Orientation> = {
  "rotate-cw": linearPart(rotationAboutMatrix(ORIGIN, 90)),
  "rotate-ccw": linearPart(rotationAboutMatrix(ORIGIN, -90)),
  "flip-horizontal": linearPart(flipAboutMatrix(ORIGIN, "horizontal")),
  "flip-vertical": linearPart(flipAboutMatrix(ORIGIN, "vertical")),
};

function multiplyOrientations(left: Orientation, right: Orientation): Orientation {
  return {
    a: exact(left.a * right.a + left.c * right.b),
    b: exact(left.b * right.a + left.d * right.b),
    c: exact(left.a * right.c + left.c * right.d),
    d: exact(left.b * right.c + left.d * right.d),
  };
}

/** Aplica `step` DESPUÉS de la orientación que ya había (el punto pasa primero por `current`, luego por el paso). */
export function composeOrientation(current: Orientation, step: OrientationStep): Orientation {
  return multiplyOrientations(STEP_ORIENTATION[step], current);
}

export function isIdentityOrientation(orientation: Orientation): boolean {
  return orientation.a === 1 && orientation.b === 0 && orientation.c === 0 && orientation.d === 1;
}

/** ¿Intercambia los ejes? (giro de 90°/270° o reflejo diagonal): el ancho pasa a ser alto y viceversa. */
export function swapsAxes(orientation: Orientation): boolean {
  return orientation.a === 0;
}

function isReflection(orientation: Orientation): boolean {
  return orientation.a * orientation.d - orientation.b * orientation.c < 0;
}

/** Matriz afín de la orientación alrededor de `pivot` (el pivote queda fijo). Para la identidad es EXACTAMENTE la identidad. */
export function orientationAboutMatrix(pivot: Point, orientation: Orientation): AffineMatrix {
  const { a, b, c, d } = orientation;
  return {
    a,
    b,
    c,
    d,
    e: exact(pivot.x - a * pivot.x - c * pivot.y),
    f: exact(pivot.y - b * pivot.x - d * pivot.y),
  };
}

/** Giros horarios de 90° (0..3) de una orientación SIN reflejo. */
function clockwiseTurns(orientation: Orientation): number {
  if (orientation.a === 1) return 0;
  if (orientation.b === 1) return 1;
  if (orientation.a === -1) return 2;
  return 3;
}

const TURN_LABEL = ["", "90° horario", "180°", "90° antihorario"];

/** Texto del cambio acumulado, para el resumen previo a Apply y la etiqueta del comando (undo). */
export function orientationLabel(orientation: Orientation): string {
  if (isIdentityOrientation(orientation)) return "Sin cambios";
  if (!isReflection(orientation)) return `Rotar ${TURN_LABEL[clockwiseTurns(orientation)]}`;
  // O = R · F_h (primero se refleja, después se gira): R = O · F_h porque F_h · F_h = identidad.
  const turns = clockwiseTurns(multiplyOrientations(orientation, STEP_ORIENTATION["flip-horizontal"]));
  if (turns === 0) return "Reflejar horizontalmente";
  if (turns === 2) return "Reflejar verticalmente";
  return `Reflejar horizontalmente y rotar ${TURN_LABEL[turns]}`;
}

/** Verbo (futuro) para frases como "Se rotará la selección": rotación pura, reflejo puro o combinación. */
export function orientationVerb(orientation: Orientation): "rotará" | "reflejará" | "transformará" {
  if (!isReflection(orientation)) return "rotará";
  return swapsAxes(orientation) ? "transformará" : "reflejará";
}

/** Orienta el GRUPO de objetos alrededor del centro de su bbox. Sin geometría o identidad: los mismos objetos (referencias idénticas). */
export function orientObjects(objects: readonly EditorObject[], orientation: Orientation): EditorObject[] {
  const center = groupCenter(objects);
  if (!center || isIdentityOrientation(orientation)) return [...objects];
  return applyMatrix(objects, orientationAboutMatrix(center, orientation));
}

/**
 * Producción de un comando que orienta los objetos con esos ids (en cualquier capa) como UN grupo alrededor del centro de su
 * bbox. `null` si no hay nada que cambiar. El bloqueo/visibilidad los filtra `applyEdit` (ver `useEditableDocument`).
 */
export function orientSelectionProduction(state: EditableDocument, ids: ReadonlySet<string>, orientation: Orientation): EditProduction | null {
  const targets = Object.values(state.objectsByLayer)
    .flat()
    .filter((object) => ids.has(object.id));
  return replaceObjects(state, targets, (found) => orientObjects(found, orientation));
}
