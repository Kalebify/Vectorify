import { useCallback, useEffect, useRef, useState } from "react";
import { postBooleanOperation } from "../api/geometryApi";
import { geometryErrorMessage } from "../lib/editor/geometry";
import type { BooleanRequest, BooleanResponse } from "../types/geometry";

/**
 * Llamada al servicio de geometría del servidor (M3-S04, ADR D4) con estado de carga y cancelación. Una operación a la vez: pedir otra
 * mientras hay una en curso la rechaza (`busy`), y cancelar/desmontar aborta el `fetch` (AbortSignal) -- un resultado que llega tarde
 * (o de una operación cancelada) NUNCA se entrega. Las fallas del servidor son recuperables: devuelven un mensaje y no tocan nada.
 *
 * Genérico en la petición/respuesta (M3-S09): por defecto llama a las booleanas (`postBooleanOperation`); el offset pasa su propia
 * `GeometryOperationConfig` (endpoint + mensajes de error) y reusa TODO lo demás (una sola operación viva, aborto, descarte de lo tardío).
 * La config tiene que ser ESTABLE (una constante de módulo): entra en las dependencias de `run`.
 */

/** Qué endpoint llama la operación y cómo se explica una falla suya al usuario. */
export interface GeometryOperationConfig<TRequest, TResponse> {
  post: (request: TRequest, signal: AbortSignal) => Promise<TResponse>;
  describeError: (error: unknown) => string;
}

export const BOOLEAN_OPERATION: GeometryOperationConfig<BooleanRequest, BooleanResponse> = {
  post: postBooleanOperation,
  describeError: geometryErrorMessage,
};

export type GeometryOperationStatus = "idle" | "running" | "error";

export type GeometryRunResult<TResponse = BooleanResponse> = { ok: true; response: TResponse } | { ok: false; aborted: boolean; message: string };

export interface UseGeometryOperationState<TRequest = BooleanRequest, TResponse = BooleanResponse> {
  status: GeometryOperationStatus;
  /** Último error del servidor (recuperable: se limpia al intentar de nuevo o con `clearError`). */
  errorMessage: string | null;
  /** Ejecuta la operación. Resuelve SIEMPRE (nunca rechaza): `ok: false` trae el mensaje y si fue por cancelación. */
  run: (request: TRequest) => Promise<GeometryRunResult<TResponse>>;
  /** Aborta la operación en curso (si la hay). */
  cancel: () => void;
  clearError: () => void;
}

export function useGeometryOperation<TRequest = BooleanRequest, TResponse = BooleanResponse>(
  operation: GeometryOperationConfig<TRequest, TResponse> = BOOLEAN_OPERATION as unknown as GeometryOperationConfig<TRequest, TResponse>,
): UseGeometryOperationState<TRequest, TResponse> {
  const [status, setStatus] = useState<GeometryOperationStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  // Cada operación tiene su número: la respuesta de una operación vieja (cancelada) no pisa el estado de la actual.
  const runIdRef = useRef(0);

  const run = useCallback(async (request: TRequest): Promise<GeometryRunResult<TResponse>> => {
    if (controllerRef.current) {
      return { ok: false, aborted: false, message: "Ya hay un cálculo en curso. Esperá a que termine o cancelalo con Escape." };
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    runIdRef.current += 1;
    const runId = runIdRef.current;
    setStatus("running");
    setErrorMessage(null);
    try {
      const response = await operation.post(request, controller.signal);
      // Cancelada mientras volvía la respuesta: se descarta aunque haya llegado.
      if (controller.signal.aborted) return { ok: false, aborted: true, message: operation.describeError({ isAborted: true }) };
      if (runIdRef.current === runId) setStatus("idle");
      return { ok: true, response };
    } catch (error) {
      const aborted = controller.signal.aborted || (typeof error === "object" && error !== null && (error as { isAborted?: boolean }).isAborted === true);
      const message = operation.describeError(error);
      if (runIdRef.current === runId) {
        setStatus(aborted ? "idle" : "error");
        setErrorMessage(aborted ? null : message);
      }
      return { ok: false, aborted, message };
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, [operation]);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  const clearError = useCallback(() => {
    setErrorMessage(null);
    setStatus((current) => (current === "error" ? "idle" : current));
  }, []);

  // Desmontar (o el doble efecto de StrictMode: efecto -> cleanup -> efecto) aborta lo que esté en vuelo.
  useEffect(
    () => () => {
      controllerRef.current?.abort();
    },
    [],
  );

  return { status, errorMessage, run, cancel, clearError };
}
