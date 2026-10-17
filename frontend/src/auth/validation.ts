/** Validación de cliente de los formularios de auth (M3.1-S05). El servidor valida de nuevo: esto solo ahorra una ida y vuelta. */

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;

const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmailFormat(email: string): boolean {
  return EMAIL_FORMAT.test(email);
}
