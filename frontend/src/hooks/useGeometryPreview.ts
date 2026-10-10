import { useCallback, useEffect, useRef, useState } from "react";
import { useGeometryOperation, type GeometryOperationConfig } from "./useGeometryOperation";

/**
 * Previsualización de una operación de geometría del servidor sobre `useGeometryOperation`/`geometryApi` de S04. Nació como `useBooleanOperation`
 * (M3-S08) y se generalizó en M3-S09 para el offset: pide el resultado al servidor cuando cambia la petición (operación, parámetros, geometría de los
 * objetos) con DEBOUNCE, cancelando con `AbortController` lo que esté en vuelo. Reglas:
 * - **Una petición viva a la vez**: al cambiar la petición se aborta la anterior y la nueva espera a que aquella termine de cancelarse.
 * - **Un resultado solo vale para SU petición** (`requestKey`): lo que llega de una petición vieja (o cancelada) jamás se entrega ni se muestra.
 * - **Error del servidor recuperable**: queda el mensaje, no hay resultado y no se toca nada (`retry` lo vuelve a intentar).
 * - **Misma clave => no se vuelve a pedir** (cambiar solo la capa destino o «Conservar originales» no cambia la geometría).
 * - `ensure()` (lo usa Apply) devuelve el resultado de la petición ACTUAL: el ya calculado, el que está en vuelo, o lo pide en el acto (sin debounce).
 * - La primera petición de una sesión sale con `setTimeout(0)`: en StrictMode (efecto -> cleanup -> efecto) el timer del primer efecto se cancela y
 *   se hace UNA sola llamada.
 */

export const GEOMETRY_PREVIEW_DEBOUNCE_MS = 250;

export type GeometryPreviewStatus = "idle" | "waiting" | "calculating" | "ready" | "error";

export type GeometryEnsureResult<TResponse> = { ok: true; response: TResponse } | { ok: false; aborted: boolean; message: string };

export interface UseGeometryPreviewParams<TRequest, TResponse> {
  /** Qué endpoint se llama y cómo se explican sus fallas (constante de módulo: ver `GeometryOperationConfig`). */
  operation: GeometryOperationConfig<TRequest, TResponse>;
  /** Petición actual, o `null` si no hay nada que calcular (plan inválido, panel cerrado). */
  request: TRequest | null;
  /** Identifica la petición: igual clave = mismo resultado. */
  requestKey: string | null;
  /** Espera (ms) antes de pedir tras un cambio. La primera petición de la sesión no espera. */
  debounceMs?: number;
}

export interface UseGeometryPreviewState<TResponse> {
  status: GeometryPreviewStatus;
  /** Resultado de la petición ACTUAL (nunca el de una anterior), o `null`. */
  response: TResponse | null;
  /** Mensaje del último fallo recuperable de la petición actual. */
  errorMessage: string | null;
  /** Reintenta la petición actual ya mismo. */
  retry: () => void;
  /** Resultado de la petición actual: el calculado, el que está en vuelo o uno pedido en el acto. Resuelve SIEMPRE. */
  ensure: () => Promise<GeometryEnsureResult<TResponse>>;
  /** Aborta lo que esté en vuelo y cancela la espera. */
  cancel: () => void;
}

const ABORTED = { ok: false, aborted: true, message: "La operación fue cancelada. No se modificó nada." } as const;

export function useGeometryPreview<TRequest, TResponse>({
  operation,
  request,
  requestKey,
  debounceMs = GEOMETRY_PREVIEW_DEBOUNCE_MS,
}: UseGeometryPreviewParams<TRequest, TResponse>): UseGeometryPreviewState<TResponse> {
  const { run, cancel: cancelRun } = useGeometryOperation<TRequest, TResponse>(operation);
  const [result, setResult] = useState<{ key: string; response: TResponse } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [runningKey, setRunningKey] = useState<string | null>(null);

  const mountedRef = useRef(false);
  const latestRef = useRef<{ request: TRequest | null; key: string | null }>({ request, key: requestKey });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Última ejecución en curso (para encadenar: la nueva espera a que la cancelada termine) y su clave (para que `ensure` la reuse). */
  const pendingRef = useRef<Promise<GeometryEnsureResult<TResponse>> | null>(null);
  const inflightRef = useRef<{ key: string; promise: Promise<GeometryEnsureResult<TResponse>> } | null>(null);
  const resultRef = useRef(result);
  const requestedBeforeRef = useRef(false);

  useEffect(() => {
    resultRef.current = result;
  }, [result]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const execute = useCallback(
    (key: string, body: TRequest): Promise<GeometryEnsureResult<TResponse>> => {
      // Una sola petición viva: la anterior (ya abortada) tiene que terminar antes de que `run` acepte otra.
      const previous = pendingRef.current;
      cancelRun();
      const promise = (async (): Promise<GeometryEnsureResult<TResponse>> => {
        if (previous) await previous.catch(() => undefined);
        if (!mountedRef.current || latestRef.current.key !== key) return ABORTED;
        setRunningKey(key);
        const outcome = await run(body);
        if (mountedRef.current) setRunningKey((current) => (current === key ? null : current));
        // Lo que llega de una petición que ya no es la actual (o tras desmontar) jamás se entrega.
        if (!mountedRef.current || latestRef.current.key !== key) return ABORTED;
        if (outcome.ok) {
          // Síncrono en el ref (el estado de React se refleja en `resultRef` recién tras el render): `ensure()` ya ve el resultado.
          resultRef.current = { key, response: outcome.response };
          setResult({ key, response: outcome.response });
          setFailure(null);
          return { ok: true, response: outcome.response };
        }
        if (!outcome.aborted) setFailure({ key, message: outcome.message });
        return { ok: false, aborted: outcome.aborted, message: outcome.message };
      })();
      pendingRef.current = promise;
      inflightRef.current = { key, promise };
      void promise.then(() => {
        if (pendingRef.current === promise) pendingRef.current = null;
        if (inflightRef.current?.promise === promise) inflightRef.current = null;
      });
      return promise;
    },
    [run, cancelRun],
  );

  // Siempre la última petición: su referencia puede cambiar en cada render; lo que decide si hay que volver a pedir es la CLAVE.
  useEffect(() => {
    latestRef.current = { request, key: requestKey };
  });

  // La clave cambió: se cancela lo que estaba en vuelo YA (no hay que esperar al debounce para dejar de gastar el servidor) y se agenda la nueva.
  useEffect(() => {
    const { request: current, key } = latestRef.current;
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (current === null || key === null) {
      cancelRun();
      requestedBeforeRef.current = false;
      return;
    }
    if (resultRef.current?.key === key) return;
    // Ya hay una en vuelo para esta misma clave (p. ej. la pidió Apply): se reutiliza.
    if (inflightRef.current?.key === key) return;
    cancelRun();
    const delay = requestedBeforeRef.current ? debounceMs : 0;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      requestedBeforeRef.current = true;
      void execute(key, current);
    }, delay);
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [requestKey, debounceMs, execute, cancelRun]);

  const ensure = useCallback((): Promise<GeometryEnsureResult<TResponse>> => {
    const { request: current, key } = latestRef.current;
    if (current === null || key === null) return Promise.resolve({ ok: false, aborted: false, message: "No hay una operación para calcular." });
    if (resultRef.current?.key === key) return Promise.resolve({ ok: true, response: resultRef.current.response });
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (inflightRef.current?.key === key) return inflightRef.current.promise;
    requestedBeforeRef.current = true;
    return execute(key, current);
  }, [execute]);

  const retry = useCallback(() => {
    const { request: current, key } = latestRef.current;
    if (current === null || key === null) return;
    setFailure(null);
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (inflightRef.current?.key === key) return;
    void execute(key, current);
  }, [execute]);

  const cancel = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    cancelRun();
  }, [cancelRun]);

  const current = request !== null && requestKey !== null;
  const response = current && result?.key === requestKey ? result.response : null;
  const errorMessage = current && failure?.key === requestKey ? failure.message : null;
  let status: GeometryPreviewStatus = "idle";
  if (current) {
    if (response) status = "ready";
    else if (errorMessage) status = "error";
    else if (runningKey === requestKey) status = "calculating";
    else status = "waiting";
  }

  return { status, response, errorMessage, retry, ensure, cancel };
}
