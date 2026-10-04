/**
 * Recovery local del Workspace en STAGING (M2.2-S07): mientras una sesión todavía no tiene
 * `savedProjectId` (sin Project v2 todavía) y está "dirty" (hay una mutación sin confirmar por un
 * Save real), se guarda acá un PUNTERO liviano -- NUNCA el documento en sí. La fuente de verdad
 * real de staging sigue siendo el backend/los sidecars clásicos (ver spec.md M2.2-S07,
 * "Recuperación al cerrar la pestaña": "SOLO como puntero, nunca como fuente de verdad del
 * contenido"). Al recuperar, `App.tsx` siempre vuelve a pedir el documento real al backend --
 * nunca lo rehidrata desde acá.
 */

const STORAGE_KEY = "vectorify.workspaceRecovery.v1";

/** Ventana de "reciente" para ofrecer el affordance "Continuar donde quedaste" (spec.md: "p. ej. últimas 24 h"). */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface WorkspaceRecoveryPointer {
  classicProjectId: string;
  imageId: string;
  paletteId: string;
  /** ISO 8601 -- momento de la última escritura de este puntero (última mutación "dirty" conocida). */
  updatedAt: string;
}

function readLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    // localStorage puede no estar disponible (modo privado agotado, política de cookies/storage
    // del navegador, SSR, etc.) -- la recuperación es un affordance best-effort, nunca crítico
    // para el flujo real (ver docstring del módulo).
    return null;
  }
}

/** Guarda/actualiza el puntero -- llamado en cada mutación mientras la sesión está en staging y sin confirmar. */
export function saveWorkspaceRecoveryPointer(pointer: WorkspaceRecoveryPointer): void {
  const storage = readLocalStorage();
  if (!storage) return;

  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(pointer));
  } catch {
    // Cuota excedida u otro fallo de escritura -- mismo criterio best-effort.
  }
}

/** Borra el puntero -- llamado apenas la sesión pasa a "saved" (ya no hace falta recuperar nada). */
export function clearWorkspaceRecoveryPointer(): void {
  const storage = readLocalStorage();
  if (!storage) return;

  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // ver comentario de arriba.
  }
}

/**
 * El puntero guardado, si existe y es RECIENTE (ver MAX_AGE_MS) -- null en cualquier otro caso
 * (nunca hubo uno, está corrupto, o ya expiró). Usado al iniciar la app SIN deep-link en la URL
 * para ofrecer "Continuar donde quedaste" (ver App.tsx).
 */
export function readRecentWorkspaceRecoveryPointer(now: number = Date.now()): WorkspaceRecoveryPointer | null {
  const storage = readLocalStorage();
  if (!storage) return null;

  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<WorkspaceRecoveryPointer>;
    if (!parsed.classicProjectId || !parsed.imageId || !parsed.paletteId || !parsed.updatedAt) {
      return null;
    }

    const updatedAtMs = Date.parse(parsed.updatedAt);
    if (!Number.isFinite(updatedAtMs) || now - updatedAtMs > MAX_AGE_MS) {
      return null;
    }

    return {
      classicProjectId: parsed.classicProjectId,
      imageId: parsed.imageId,
      paletteId: parsed.paletteId,
      updatedAt: parsed.updatedAt,
    };
  } catch {
    // JSON corrupto -- tratado igual que "nunca hubo puntero".
    return null;
  }
}
