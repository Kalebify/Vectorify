/**
 * Frontera de autenticación del cliente HTTP (M3.1-S04). Cuando la Web API responde 401 a un endpoint que NO es de
 * autenticación, la sesión (cookie HttpOnly) caducó o fue revocada: este módulo avisa UNA sola vez a quien se haya suscrito.
 *
 * Alcance deliberadamente mínimo: sin pantallas, sin contexto de React y sin navegación a /login (eso es M3.1-S05, que se
 * suscribe con `onSessionExpired`). No hay refresh tokens (la cookie se renueva sola en el servidor), no hay reintentos
 * automáticos de la request fallida y no se guarda nada en localStorage/sessionStorage: el estado de este módulo vive solo
 * en memoria y se pierde al recargar, que es lo correcto (el servidor es la fuente de verdad de la sesión).
 */

/** Prefijo de los endpoints de autenticación: un 401 allí es un resultado normal (credenciales inválidas, «no hay sesión»). */
export const AUTH_PATH_PREFIX = "/api/v1/auth/";

export interface SessionExpiredEvent {
  /** Ruta (relativa a la API) de la primera request que recibió el 401. */
  path: string;
}

export type SessionExpiredHandler = (event: SessionExpiredEvent) => void;

const handlers = new Set<SessionExpiredHandler>();

/**
 * true mientras ya se avisó de la caducidad de ESTA sesión. Evita que N requests concurrentes con 401 produzcan N eventos.
 * Se vuelve a armar con `rearmSessionBoundary` cuando hay una sesión nueva (login correcto o `me` con usuario).
 */
let notified = false;

/**
 * Suscribe `handler` al evento «sesión expirada». Devuelve la función para darse de baja (idempotente). Un mismo handler
 * suscrito dos veces recibe un único aviso (se guarda en un Set).
 */
export function onSessionExpired(handler: SessionExpiredHandler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

/** true si `path` pertenece a los endpoints de autenticación (login, register, me, logout, logout-all). */
export function isAuthPath(path: string): boolean {
  return path.startsWith(AUTH_PATH_PREFIX);
}

/**
 * Lo llama el cliente HTTP ante un 401 de `path`. No hace nada para endpoints de autenticación, ni si ya se avisó de esta
 * caducidad, ni si nadie está suscrito (en ese caso NO se consume el aviso: el primer suscriptor posterior lo recibirá en
 * el siguiente 401). Un handler que lance no impide avisar a los demás ni altera el error que recibe quien hizo la request.
 */
export function reportUnauthorized(path: string): void {
  if (isAuthPath(path) || notified || handlers.size === 0) {
    return;
  }

  notified = true;
  for (const handler of [...handlers]) {
    try {
      handler({ path });
    } catch (error) {
      console.error("sessionBoundary: un suscriptor de onSessionExpired lanzó una excepción.", error);
    }
  }
}

/**
 * Vuelve a armar el aviso: hay una sesión viva otra vez (login correcto o `GET /auth/me` con usuario). Lo llama `authApi`;
 * S05 puede llamarlo también tras restaurar la sesión.
 */
export function rearmSessionBoundary(): void {
  notified = false;
}

/** Solo para tests: borra suscriptores y estado. */
export function resetSessionBoundaryForTests(): void {
  handlers.clear();
  notified = false;
}
