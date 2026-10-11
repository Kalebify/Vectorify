import { postFloatingAnalysis } from "../api/geometryApi";
import { floatingErrorMessage } from "../lib/editor/floating";
import type { FloatingRequest, FloatingResponse } from "../types/geometry";
import type { GeometryOperationConfig } from "./useGeometryOperation";
import { GEOMETRY_PREVIEW_DEBOUNCE_MS, useGeometryPreview, type UseGeometryPreviewState } from "./useGeometryPreview";

/**
 * Análisis de piezas flotantes (M3-S11): el mismo `useGeometryPreview` de las booleanas, el offset y el corte (debounce, `AbortController`, UNA petición viva, un
 * resultado solo vale para SU petición, `ensure()`, StrictMode sin llamadas dobles) apuntando a `POST /api/v2/geometry/floating` y con los mensajes de error del
 * análisis (`floatingErrorMessage`). No hay lógica de petición propia: duplicarla sería mantener dos máquinas de estados de la misma cosa.
 */

/** Constante de módulo: `useGeometryOperation` la usa como dependencia, así que su identidad tiene que ser estable. */
const FLOATING_OPERATION: GeometryOperationConfig<FloatingRequest, FloatingResponse> = {
  post: postFloatingAnalysis,
  describeError: floatingErrorMessage,
};

export interface UseFloatingAnalysisParams {
  /** Petición actual, o `null` si no hay nada que analizar (todavía no se pidió, herramienta cerrada). */
  request: FloatingRequest | null;
  /** Identifica la petición: igual clave = mismo resultado. */
  requestKey: string | null;
  debounceMs?: number;
}

export type UseFloatingAnalysisState = UseGeometryPreviewState<FloatingResponse>;

export function useFloatingAnalysis({ request, requestKey, debounceMs = GEOMETRY_PREVIEW_DEBOUNCE_MS }: UseFloatingAnalysisParams): UseFloatingAnalysisState {
  return useGeometryPreview<FloatingRequest, FloatingResponse>({ operation: FLOATING_OPERATION, request, requestKey, debounceMs });
}
