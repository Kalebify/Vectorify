/**
 * Cliente HTTP centralizado hacia ASP.NET Core. Todo llamado del frontend a la
 * Web API pasa por acá — el navegador nunca llama directamente a Python.
 */

import { reportUnauthorized } from "./sessionBoundary";

export const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:5080";

/**
 * Cabecera anti-CSRF (M3.1-S03, T3): la sesión es una cookie, y el backend (modo Authenticated) exige esta cabecera
 * personalizada en todo método no seguro, junto con un Origin permitido. Un formulario o una imagen de otro sitio no pueden
 * añadirla. Se envía en TODA request del cliente (no cuesta nada y evita decidir por método).
 */
export const CSRF_HEADER_NAME = "X-Vectorify-Request";
export const CSRF_HEADER_VALUE = "1";

/**
 * Añade la cabecera anti-CSRF a las cabeceras de una request conservando la forma en que el llamador las pasó
 * (objeto plano, Headers o lista de pares).
 */
function withCsrfHeader(headers: HeadersInit): HeadersInit {
  if (headers instanceof Headers || Array.isArray(headers)) {
    const merged = new Headers(headers);
    merged.set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE);
    return merged;
  }
  return { ...headers, [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
}

export class ApiClientError extends Error {
  readonly cause?: unknown;
  /** Cuerpo de error tipado (ApiErrorResponse) cuando la Web API respondió 4xx/5xx con JSON. */
  readonly body?: unknown;
  /** true si nunca se pudo contactar a la Web API (red caída, CORS). */
  readonly isNetworkError: boolean;
  /** true si la operación fue cancelada explícitamente (botón "Cancelar" o AbortSignal). */
  readonly isAborted: boolean;
  /** Código HTTP cuando la Web API respondió 4xx/5xx (M2.2-S08); undefined en errores de red/abort. */
  readonly status?: number;
  /**
   * Segundos de espera que pidió el servidor con la cabecera `Retry-After` (M3.1-S08; en segundos o como fecha HTTP), o undefined si no vino o
   * no se puede leer. En una llamada entre orígenes solo es legible si el backend la expone con `Access-Control-Expose-Headers`.
   */
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    options?: {
      cause?: unknown;
      body?: unknown;
      isNetworkError?: boolean;
      isAborted?: boolean;
      status?: number;
      retryAfterSeconds?: number;
    },
  ) {
    super(message);
    this.name = "ApiClientError";
    this.cause = options?.cause;
    this.body = options?.body;
    this.status = options?.status;
    this.retryAfterSeconds = options?.retryAfterSeconds;
    this.isNetworkError = options?.isNetworkError ?? false;
    this.isAborted = options?.isAborted ?? false;
  }
}

/** Interpreta `Retry-After` (entero de segundos o fecha HTTP) como segundos de espera; undefined si falta o es ilegible. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - now) / 1000));
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      // Sesión por cookie HttpOnly (M3.1-S03): el navegador debe enviarla y aceptarla también hacia otro origen (CORS con
      // credenciales en el backend). Va DESPUÉS de ...init a propósito: ningún llamador puede desactivarla por accidente.
      credentials: "include",
      // Cabeceras por defecto (Accept) solo si el llamador no pasó las suyas, como antes; la cabecera anti-CSRF siempre.
      headers: withCsrfHeader(init?.headers ?? { Accept: "application/json" }),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ApiClientError("La solicitud fue cancelada.", { cause: error, isAborted: true });
    }

    throw new ApiClientError(
      `No se pudo contactar a la Web API en ${API_BASE_URL}${path}`,
      { cause: error, isNetworkError: true },
    );
  }

  if (!response.ok) {
    const body = await response.json().catch(() => undefined);
    // Frontera de autenticación (M3.1-S04): un 401 fuera de /api/v1/auth/ = sesión caducada o revocada. Se notifica UNA vez
    // (ver sessionBoundary) y el error se propaga igual: sin reintento automático de la request.
    if (response.status === 401) {
      reportUnauthorized(path);
    }
    throw new ApiClientError(
      `La Web API respondió con código ${response.status} en ${path}`,
      { body, status: response.status, retryAfterSeconds: parseRetryAfter(response.headers.get("Retry-After")) },
    );
  }

  // 204 No Content (p. ej. DELETE /api/v2/projects/{id}): no hay cuerpo que parsear.
  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export const httpClient = {
  get: <T>(path: string, init?: RequestInit) => request<T>(path, { ...init, method: "GET" }),
  /** POST con cuerpo JSON (Content-Type: application/json), para endpoints que no suben archivos. */
  postJson: <T>(path: string, body: unknown, init?: RequestInit) =>
    request<T>(path, {
      ...init,
      method: "POST",
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
      body: JSON.stringify(body),
    }),
  /** PATCH con cuerpo JSON parcial (Content-Type: application/json) -- mismo criterio que postJson. */
  patchJson: <T>(path: string, body: unknown, init?: RequestInit) =>
    request<T>(path, {
      ...init,
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
      body: JSON.stringify(body),
    }),
  /** DELETE sin cuerpo; resuelve `undefined` ante un 204 (M2.2-S08). */
  delete: (path: string, init?: RequestInit) => request<void>(path, { ...init, method: "DELETE" }),
};

export interface UploadFileOptions {
  /** Nombre del campo multipart que espera el endpoint. Default: "file". */
  fieldName?: string;
  headers?: Record<string, string>;
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
}

function safeParseJson(text: string): unknown {
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Sube un archivo como multipart/form-data con progreso de subida. fetch no expone
 * eventos de progreso de upload, así que esta función usa XMLHttpRequest — el único
 * lugar del cliente HTTP que lo hace, todo lo demás pasa por `request`/fetch.
 */
export function uploadFile<T>(path: string, file: File, options?: UploadFileOptions): Promise<T> {
  const fieldName = options?.fieldName ?? "file";
  const url = `${API_BASE_URL}${path}`;

  return new Promise<T>((resolve, reject) => {
    if (options?.signal?.aborted) {
      reject(new ApiClientError("La carga fue cancelada.", { isAborted: true }));
      return;
    }

    const xhr = new XMLHttpRequest();
    const formData = new FormData();
    formData.append(fieldName, file);

    xhr.open("POST", url);
    // Misma política que `request`: cookie de sesión también hacia otro origen y cabecera anti-CSRF (M3.1-S03).
    xhr.withCredentials = true;
    xhr.setRequestHeader("Accept", "application/json");
    xhr.setRequestHeader(CSRF_HEADER_NAME, CSRF_HEADER_VALUE);
    for (const [key, value] of Object.entries(options?.headers ?? {})) {
      xhr.setRequestHeader(key, value);
    }

    const onAbort = () => xhr.abort();
    options?.signal?.addEventListener("abort", onAbort);
    const cleanup = () => options?.signal?.removeEventListener("abort", onAbort);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        options?.onProgress?.(Math.round((event.loaded / event.total) * 100));
      }
    };

    xhr.onload = () => {
      cleanup();
      const body = safeParseJson(xhr.responseText);
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body as T);
      } else {
        if (xhr.status === 401) {
          reportUnauthorized(path);
        }
        reject(new ApiClientError(`La Web API respondió con código ${xhr.status} en ${path}`, { body }));
      }
    };

    xhr.onerror = () => {
      cleanup();
      reject(new ApiClientError(`No se pudo contactar a la Web API en ${url}`, { isNetworkError: true }));
    };

    xhr.onabort = () => {
      cleanup();
      reject(new ApiClientError("La carga fue cancelada.", { isAborted: true }));
    };

    xhr.send(formData);
  });
}
