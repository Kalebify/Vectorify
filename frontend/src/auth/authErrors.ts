import { ApiClientError } from "../api/httpClient";

/**
 * Clasificación de fallos de la Web API para la UI de auth (M3.1-S05). Diferencia 401 (sesión/credenciales), 403 (prohibido/CSRF: NO
 * cierra la sesión ni redirige a login), 429, 5xx y red. Un error de red nunca equivale a «sesión cerrada».
 */
export type FailureKind = "aborted" | "network" | "unauthorized" | "badRequest" | "forbidden" | "rateLimited" | "server";

export interface Failure {
  kind: FailureKind;
  /** Código HTTP cuando la Web API respondió. */
  status?: number;
  /** `code` del `ApiErrorResponse` del servidor, si vino. */
  code?: string;
  /** `message` del `ApiErrorResponse` del servidor (ya en español), si vino. */
  message?: string;
  /** Segundos de espera de la cabecera `Retry-After` de un 429 (M3.1-S08), si vino y se pudo leer. */
  retryAfterSeconds?: number;
}

function bodyField(body: unknown, field: "code" | "message"): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function classifyFailure(error: unknown): Failure {
  if (!(error instanceof ApiClientError)) {
    // Un cuerpo 200 ilegible (p. ej. HTML de un proxy) u otro fallo inesperado: el servidor no respondió como corresponde.
    return { kind: "server" };
  }

  if (error.isAborted) return { kind: "aborted" };
  if (error.isNetworkError || error.status === undefined) return { kind: "network" };

  const base = {
    status: error.status,
    code: bodyField(error.body, "code"),
    message: bodyField(error.body, "message"),
    retryAfterSeconds: error.retryAfterSeconds,
  };
  if (error.status === 401) return { kind: "unauthorized", ...base };
  if (error.status === 403) return { kind: "forbidden", ...base };
  if (error.status === 429) return { kind: "rateLimited", ...base };
  if (error.status >= 400 && error.status < 500) return { kind: "badRequest", ...base };
  return { kind: "server", ...base };
}
