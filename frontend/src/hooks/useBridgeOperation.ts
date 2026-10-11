import { postBridgeOperation } from "../api/geometryApi";
import { floatingErrorMessage } from "../lib/editor/floating";
import type { BridgeRequest, BridgeResponse } from "../types/geometry";
import type { GeometryOperationConfig } from "./useGeometryOperation";
import { GEOMETRY_PREVIEW_DEBOUNCE_MS, useGeometryPreview, type UseGeometryPreviewState } from "./useGeometryPreview";

/**
 * Previsualización de los bridges (M3-S11): el mismo `useGeometryPreview` que el análisis, las booleanas, el offset y el corte (debounce 250 ms, `AbortController`,
 * UNA petición viva, un resultado solo vale para SU petición, `ensure()` para Apply) apuntando a `POST /api/v2/geometry/bridge`. Cambiar el ancho, quitar o mover un
 * bridge cambia la clave y vuelve a pedir el resultado (geometría + reanálisis); no hay lógica de petición propia.
 */

export const BRIDGE_PREVIEW_DEBOUNCE_MS = GEOMETRY_PREVIEW_DEBOUNCE_MS;

/** Constante de módulo: `useGeometryOperation` la usa como dependencia, así que su identidad tiene que ser estable. */
const BRIDGE_OPERATION: GeometryOperationConfig<BridgeRequest, BridgeResponse> = {
  post: postBridgeOperation,
  describeError: floatingErrorMessage,
};

export interface UseBridgeOperationParams {
  /** Petición actual, o `null` si no hay nada que calcular (sin análisis, sin piezas flotantes, sin bridges, ancho inválido). */
  request: BridgeRequest | null;
  /** Identifica la petición: igual clave = mismo resultado. */
  requestKey: string | null;
  debounceMs?: number;
}

export type UseBridgeOperationState = UseGeometryPreviewState<BridgeResponse>;

export function useBridgeOperation({ request, requestKey, debounceMs = BRIDGE_PREVIEW_DEBOUNCE_MS }: UseBridgeOperationParams): UseBridgeOperationState {
  return useGeometryPreview<BridgeRequest, BridgeResponse>({ operation: BRIDGE_OPERATION, request, requestKey, debounceMs });
}
