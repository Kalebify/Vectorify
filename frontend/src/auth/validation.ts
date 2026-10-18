/** Validación de cliente de los formularios de auth (M3.1-S05). El servidor valida de nuevo: esto solo ahorra una ida y vuelta. */

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;

const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmailFormat(email: string): boolean {
  return EMAIL_FORMAT.test(email);
}

/** Largo máximo del nombre para mostrar (unidades UTF-16, igual que `string.Length` en el servidor). */
export const MAX_DISPLAY_NAME_LENGTH = 80;

// Caracteres de control: U+0000–U+001F y U+007F–U+009F (los mismos que `char.IsControl` en el servidor).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

export type DisplayNameProblem = { kind: "required" } | { kind: "tooLong"; length: number } | { kind: "controlCharacters" };

/** Valida el nombre para mostrar YA recortado (M3.1-S07). Devuelve `null` si es válido. El servidor valida de nuevo. */
export function checkDisplayName(trimmed: string): DisplayNameProblem | null {
  if (trimmed.length === 0) return { kind: "required" };
  if (trimmed.length > MAX_DISPLAY_NAME_LENGTH) return { kind: "tooLong", length: trimmed.length };
  if (CONTROL_CHARACTERS.test(trimmed)) return { kind: "controlCharacters" };
  return null;
}
