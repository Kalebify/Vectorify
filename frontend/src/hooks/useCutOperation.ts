import { postSplitOperation } from "../api/geometryApi";
import { cutErrorMessage } from "../lib/editor/cut";
import type { SplitRequest, SplitResponse } from "../types/geometry";
import type { GeometryOperationConfig } from "./useGeometryOperation";
import { GEOMETRY_PREVIEW_DEBOUNCE_MS, useGeometryPreview, type UseGeometryPreviewState } from "./useGeometryPreview";

/**
 * Previsualización de un corte (M3-S10): el mismo `useGeometryPreview` de las booleanas y el offset (debounce, `AbortController`, UNA petición viva, un resultado
 * solo vale para SU petición, `ensure()` para Apply, StrictMode sin llamadas dobles) apuntando a `POST /api/v2/geometry/split` y con los mensajes de error del
 * corte (`cutErrorMessage`). No hay lógica de petición propia: duplicarla sería mantener dos máquinas de estados de la misma cosa.
 */

export const CUT_PREVIEW_DEBOUNCE_MS = GEOMETRY_PREVIEW_DEBOUNCE_MS;

/** Constante de módulo: `useGeometryOperation` la usa como dependencia, así que su identidad tiene que ser estable. */
const CUT_OPERATION: GeometryOperationConfig<SplitRequest, SplitResponse> = {
  post: postSplitOperation,
  describeError: cutErrorMessage,
};

export interface UseCutOperationParams {
  /** Petición actual, o `null` si no hay nada que calcular (línea incompleta, nada que cortar, herramienta cerrada). */
  request: SplitRequest | null;
  /** Identifica la petición: igual clave = mismo resultado. */
  requestKey: string | null;
  /** Espera (ms) antes de pedir tras un cambio. La primera petición de la sesión no espera. */
  debounceMs?: number;
}

export type UseCutOperationState = UseGeometryPreviewState<SplitResponse>;

export function useCutOperation({ request, requestKey, debounceMs = CUT_PREVIEW_DEBOUNCE_MS }: UseCutOperationParams): UseCutOperationState {
  return useGeometryPreview<SplitRequest, SplitResponse>({ operation: CUT_OPERATION, request, requestKey, debounceMs });
}
