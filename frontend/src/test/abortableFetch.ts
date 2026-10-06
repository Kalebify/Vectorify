import { vi } from "vitest";

/**
 * Mock de `fetch` que RESPETA `AbortSignal` (lección de M2.2: un mock que
 * ignora la señal da falsos positivos -- las cargas abortadas por el cleanup de
 * un efecto "terminaban bien" igual y ocultaban el bug de StrictMode). Igual que
 * el `fetch` real:
 * - si la señal ya estaba abortada al llamar, rechaza de inmediato con `AbortError`;
 * - si se aborta mientras la respuesta está pendiente (el `handler` puede devolver
 *   una promesa que el test resuelve a mano), rechaza con `AbortError`.
 *
 * `fetchMock.signals` guarda la señal de cada llamada para verificar abortos.
 */
export function abortAwareFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const signals: Array<AbortSignal | undefined> = [];
  const urls: string[] = [];

  const implementation = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const signal = init?.signal ?? undefined;
    signals.push(signal);
    urls.push(url);

    return new Promise<Response>((resolve, reject) => {
      const onAbort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      Promise.resolve()
        .then(() => handler(url, init))
        .then(
          (response) => {
            signal?.removeEventListener("abort", onAbort);
            resolve(response);
          },
          (error) => {
            signal?.removeEventListener("abort", onAbort);
            reject(error);
          },
        );
    });
  };

  return Object.assign(vi.fn(implementation), { signals, urls });
}

export function svgResponse(text: string, status = 200): Response {
  return new Response(text, { status, headers: { "Content-Type": "image/svg+xml" } });
}
