import type { BooleanRequest, BooleanResponse } from "../types/geometry";
import { BOOLEAN_OPERATION } from "./useGeometryOperation";
import {
  GEOMETRY_PREVIEW_DEBOUNCE_MS,
  useGeometryPreview,
  type GeometryEnsureResult,
  type GeometryPreviewStatus,
  type UseGeometryPreviewState,
} from "./useGeometryPreview";

/**
 * Previsualización de una booleana (M3-S08): `useGeometryPreview` (debounce, `AbortController`, una petición viva, resultado solo para SU petición,
 * `ensure()` para Apply) apuntando a las booleanas de S04 (`postBooleanOperation`). La lógica vive en `useGeometryPreview`; el offset (M3-S09) usa la
 * misma con su propio endpoint (`useOffsetOperation`).
 */

export const BOOLEAN_PREVIEW_DEBOUNCE_MS = GEOMETRY_PREVIEW_DEBOUNCE_MS;

export type BooleanPreviewStatus = GeometryPreviewStatus;

export type EnsureResult = GeometryEnsureResult<BooleanResponse>;

export interface UseBooleanOperationParams {
  /** Petición actual, o `null` si no hay nada que calcular (plan inválido, panel cerrado). */
  request: BooleanRequest | null;
  /** Identifica la petición: igual clave = mismo resultado. */
  requestKey: string | null;
  /** Espera (ms) antes de pedir tras un cambio. La primera petición de la sesión no espera. */
  debounceMs?: number;
}

export type UseBooleanOperationState = UseGeometryPreviewState<BooleanResponse>;

export function useBooleanOperation({ request, requestKey, debounceMs = BOOLEAN_PREVIEW_DEBOUNCE_MS }: UseBooleanOperationParams): UseBooleanOperationState {
  return useGeometryPreview<BooleanRequest, BooleanResponse>({ operation: BOOLEAN_OPERATION, request, requestKey, debounceMs });
}
