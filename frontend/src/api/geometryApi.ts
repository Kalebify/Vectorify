import { httpClient } from "./httpClient";
import type { BooleanRequest, BooleanResponse, OffsetRequest, OffsetResponse } from "../types/geometry";

/**
 * Operación booleana del servicio de geometría (M3-S04, ADR D4): `subjects`/`operands` en unidades de documento -> piezas resultantes.
 * Sin estado ni datos del usuario: no recibe ids de proyecto. El `signal` cancela la petición (Escape, cambio de herramienta, desmontaje).
 */
export function postBooleanOperation(request: BooleanRequest, signal?: AbortSignal): Promise<BooleanResponse> {
  return httpClient.postJson<BooleanResponse>("/api/v2/geometry/boolean", request, { signal });
}

/**
 * Offset (M3-S09) del mismo servicio: `subjects` en unidades de documento + `distance` firmada -> polígonos resultantes y lo que pasó
 * (colapso, división, huecos). Sin estado ni datos del usuario; el `signal` cancela la petición (Escape, cambio de herramienta, desmontaje).
 */
export function postOffsetOperation(request: OffsetRequest, signal?: AbortSignal): Promise<OffsetResponse> {
  return httpClient.postJson<OffsetResponse>("/api/v2/geometry/offset", request, { signal });
}
