import { postOffsetOperation } from "../api/geometryApi";
import { offsetErrorMessage } from "../lib/editor/offset";
import type { OffsetRequest, OffsetResponse } from "../types/geometry";
import type { GeometryOperationConfig } from "./useGeometryOperation";
import { GEOMETRY_PREVIEW_DEBOUNCE_MS, useGeometryPreview, type UseGeometryPreviewState } from "./useGeometryPreview";

/**
 * Previsualización de un offset (M3-S09): el mismo `useGeometryPreview` de las booleanas (debounce, `AbortController`, UNA petición viva, un resultado solo
 * vale para SU petición, `ensure()` para Apply, StrictMode sin llamadas dobles) apuntando a `POST /api/v2/geometry/offset` y con los mensajes de error del
 * offset (`offsetErrorMessage`). No hay lógica de petición propia: duplicarla sería mantener dos máquinas de estados de la misma cosa.
 */

export const OFFSET_PREVIEW_DEBOUNCE_MS = GEOMETRY_PREVIEW_DEBOUNCE_MS;

/** Constante de módulo: `useGeometryOperation` la usa como dependencia, así que su identidad tiene que ser estable. */
const OFFSET_OPERATION: GeometryOperationConfig<OffsetRequest, OffsetResponse> = {
  post: postOffsetOperation,
  describeError: offsetErrorMessage,
};

export interface UseOffsetOperationParams {
  /** Petición actual, o `null` si no hay nada que calcular (selección inválida, panel cerrado). */
  request: OffsetRequest | null;
  /** Identifica la petición: igual clave = mismo resultado. */
  requestKey: string | null;
  /** Espera (ms) antes de pedir tras un cambio. La primera petición de la sesión no espera. */
  debounceMs?: number;
}

export type UseOffsetOperationState = UseGeometryPreviewState<OffsetResponse>;

export function useOffsetOperation({ request, requestKey, debounceMs = OFFSET_PREVIEW_DEBOUNCE_MS }: UseOffsetOperationParams): UseOffsetOperationState {
  return useGeometryPreview<OffsetRequest, OffsetResponse>({ operation: OFFSET_OPERATION, request, requestKey, debounceMs });
}
