import { useCallback, useEffect, useRef, useState } from "react";
import { postBooleanOperation } from "../api/geometryApi";
import { geometryErrorMessage } from "../lib/editor/geometry";
import type { BooleanRequest, BooleanResponse } from "../types/geometry";

/**
 * Llamada al servicio de geometría del servidor (M3-S04, ADR D4) con estado de carga y cancelación. Una operación a la vez: pedir otra
 * mientras hay una en curso la rechaza (`busy`), y cancelar/desmontar aborta el `fetch` (AbortSignal) -- un resultado que llega tarde
 * (o de una operación cancelada) NUNCA se entrega. Las fallas del servidor son recuperables: devuelven un mensaje y no tocan nada.
 */

export type GeometryOperationStatus = "idle" | "running" | "error";

export type GeometryRunResult = { ok: true; response: BooleanResponse } | { ok: false; aborted: boolean; message: string };

export interface UseGeometryOperationState {
  status: GeometryOperationStatus;
  /** Último error del servidor (recuperable: se limpia al intentar de nuevo o con `clearError`). */
  errorMessage: string | null;
  /** Ejecuta la operación. Resuelve SIEMPRE (nunca rechaza): `ok: false` trae el mensaje y si fue por cancelación. */
  run: (request: BooleanRequest) => Promise<GeometryRunResult>;
  /** Aborta la operación en curso (si la hay). */
  cancel: () => void;
  clearError: () => void;
}

export function useGeometryOperation(): UseGeometryOperationState {
  const [status, setStatus] = useState<GeometryOperationStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  // Cada operación tiene su número: la respuesta de una operación vieja (cancelada) no pisa el estado de la actual.
  const runIdRef = useRef(0);

  const run = useCallback(async (request: BooleanRequest): Promise<GeometryRunResult> => {
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
      const response = await postBooleanOperation(request, controller.signal);
      // Cancelada mientras volvía la respuesta: se descarta aunque haya llegado.
      if (controller.signal.aborted) return { ok: false, aborted: true, message: geometryErrorMessage({ isAborted: true }) };
      if (runIdRef.current === runId) setStatus("idle");
      return { ok: true, response };
    } catch (error) {
      const aborted = controller.signal.aborted || (typeof error === "object" && error !== null && (error as { isAborted?: boolean }).isAborted === true);
      const message = geometryErrorMessage(error);
      if (runIdRef.current === runId) {
        setStatus(aborted ? "idle" : "error");
        setErrorMessage(aborted ? null : message);
      }
      return { ok: false, aborted, message };
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, []);

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
