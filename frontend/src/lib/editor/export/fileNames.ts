import type { ManufacturingOperationValue } from "../../../types/manufacturingOperations";

/**
 * Nombres de archivo del export (M3-S15): `proyecto_layer_operación.ext`. Puros, deterministas (mismo documento => mismos nombres, en el orden de las capas) y seguros
 * en cualquier sistema de archivos: minúsculas, sin tildes, solo `[a-z0-9._-]`, longitud acotada, sin nombres reservados de Windows y sin colisiones.
 */

/** Largo máximo de cada parte (proyecto, capa) del nombre: `proyecto_layer_operación` queda muy por debajo de los 255 bytes de los sistemas de archivos. */
export const MAX_NAME_PART_LENGTH = 40;

export type ExportExtension = "svg" | "dxf" | "png" | "zip";

/** Lo que se escribe en el nombre para cada operación (`unassigned` = capa sin operación asignada). */
const OPERATION_SLUG: Record<ManufacturingOperationValue, string> = { cut: "cut", engrave: "engrave", ignore: "ignore", unassigned: "unassigned" };

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;
const KNOWN_EXTENSION = /\.(svg|dxf|png|zip)$/i;

/** Letras que NFD no descompone y que no deben convertirse en «-» (se transliteran a su equivalente ASCII). */
const TRANSLITERATION: Record<string, string> = { ß: "ss", æ: "ae", œ: "oe", ø: "o", đ: "d", ł: "l", ð: "d", þ: "th", ı: "i" };

export function operationSlug(operation: ManufacturingOperationValue): string {
  return OPERATION_SLUG[operation] ?? "unassigned";
}

/**
 * Una parte de nombre segura. Tildes fuera (NFD), minúsculas, todo carácter fuera de `[a-z0-9.-]` pasa a «-» (el «_» queda reservado como separador de partes), las
 * rachas de «-» y «.» se colapsan, los bordes se recortan y el resultado se acota a `MAX_NAME_PART_LENGTH`. Vacío => `fallback`. Una parte que es un nombre
 * reservado de Windows (`con`, `nul`, `com1`...) recibe un sufijo para dejar de serlo.
 */
export function sanitizeNamePart(text: string, fallback: string): string {
  const decomposed = text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[ßæœøđłðþı]/g, (letter) => TRANSLITERATION[letter] ?? "-");
  let part = decomposed
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  if (part.length > MAX_NAME_PART_LENGTH) part = part.slice(0, MAX_NAME_PART_LENGTH).replace(/[-.]+$/g, "");
  if (part.length === 0) return fallback;
  // Windows reserva el nombre aunque lleve extensión («con.txt»): el sufijo va en el primer tramo, antes del primer punto.
  const [head, ...rest] = part.split(".");
  if (WINDOWS_RESERVED.test(head)) part = [`${head}-x`, ...rest].join(".");
  return part;
}

/** Nombre del proyecto como parte de archivo: sin la extensión conocida con la que suele terminar («Project.svg» => «project»). */
export function projectNamePart(projectName: string): string {
  return sanitizeNamePart(projectName.trim().replace(KNOWN_EXTENSION, ""), "proyecto");
}

/** `proyecto_documento.ext`: el archivo único con todo el documento (o con las capas elegidas). */
export function documentFileName(projectName: string, extension: Exclude<ExportExtension, "zip">): string {
  return `${projectNamePart(projectName)}_documento.${extension}`;
}

/** `proyecto_layers.zip`: el paquete de los archivos por layer. */
export function archiveFileName(projectName: string): string {
  return `${projectNamePart(projectName)}_layers.zip`;
}

export interface NamedLayer {
  groupId: string;
  name: string;
  order: number;
  manufacturingOperation: ManufacturingOperationValue;
}

/**
 * Nombre de archivo de cada capa, `proyecto_capa_operación.ext`, por `groupId`. Se asignan en el orden de las capas (`order`, desempate por `groupId`) para que dos
 * capas con el mismo nombre saneado reciban siempre los mismos sufijos: la primera conserva el nombre, la siguiente `-2`, `-3`... (sobre el nombre completo, antes de la
 * extensión). Una colisión con un nombre ya generado (incluido uno con sufijo) se resuelve igual. Se compara sin distinguir mayúsculas (Windows/macOS).
 */
export function layerFileNames(projectName: string, layers: readonly NamedLayer[], extension: Exclude<ExportExtension, "zip">): Record<string, string> {
  const project = projectNamePart(projectName);
  const ordered = [...layers].sort((left, right) => left.order - right.order || (left.groupId < right.groupId ? -1 : left.groupId > right.groupId ? 1 : 0));
  const used = new Set<string>();
  const names: Record<string, string> = {};
  for (const layer of ordered) {
    const stem = `${project}_${sanitizeNamePart(layer.name, "capa")}_${operationSlug(layer.manufacturingOperation)}`;
    let candidate = stem;
    for (let attempt = 2; used.has(candidate.toLowerCase()); attempt += 1) candidate = `${stem}-${attempt}`;
    used.add(candidate.toLowerCase());
    names[layer.groupId] = `${candidate}.${extension}`;
  }
  return names;
}

/**
 * Nombre de una capa DXF (R12): mayúsculas, dígitos y `_ - $`, máximo 31 caracteres, nunca vacío. Los duplicados reciben `-2`, `-3`... dentro del límite.
 * `taken` lleva los nombres ya usados (en mayúsculas) y se actualiza.
 */
export function dxfLayerName(name: string, taken: Set<string>): string {
  const base = sanitizeNamePart(name, "capa").toUpperCase().replace(/\./g, "_").slice(0, 31).replace(/[-_]+$/g, "") || "CAPA";
  let candidate = base;
  for (let attempt = 2; taken.has(candidate); attempt += 1) {
    const suffix = `-${attempt}`;
    candidate = `${base.slice(0, 31 - suffix.length)}${suffix}`;
  }
  taken.add(candidate);
  return candidate;
}
