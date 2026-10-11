import { httpClient } from "./httpClient";
import type {
  BooleanRequest,
  BooleanResponse,
  BridgeRequest,
  BridgeResponse,
  FloatingRequest,
  FloatingResponse,
  OffsetRequest,
  OffsetResponse,
  SplitRequest,
  SplitResponse,
} from "../types/geometry";

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

/**
 * Corte / división (M3-S10) del mismo servicio: `subjects` + una línea de corte (`cutter.points`) en unidades de documento -> las piezas de cada
 * subject y si el corte lo atraviesa de verdad. Sin estado ni datos del usuario; el `signal` cancela la petición (Escape, cambio de herramienta, desmontaje).
 */
export function postSplitOperation(request: SplitRequest, signal?: AbortSignal): Promise<SplitResponse> {
  return httpClient.postJson<SplitResponse>("/api/v2/geometry/split", request, { signal });
}

/**
 * Análisis de piezas flotantes (M3-S11) del mismo servicio: `subjects` (polígonos, con `locked`) + `mode` (`stencil` = las formas son cortes, `parts` = las formas son
 * material) -> los componentes de su unión con clasificación (principal/flotante), padre, profundidad, polígono y bounds. Sin estado ni datos del usuario; el `signal`
 * cancela la petición (Escape, cambio de herramienta, desmontaje).
 */
export function postFloatingAnalysis(request: FloatingRequest, signal?: AbortSignal): Promise<FloatingResponse> {
  return httpClient.postJson<FloatingResponse>("/api/v2/geometry/floating", request, { signal });
}

/**
 * Bridges (M3-S11) del mismo servicio: los bridges propuestos (en unidades de documento) sobre las formas -> por bridge si es válido (o el motivo), la geometría
 * resultante por forma y el REANÁLISIS (flotantes antes -> después). Con `suggest` el servidor completa con una sugerencia cada pieza flotante sin bridge válido.
 * Sin estado ni datos del usuario; el `signal` cancela la petición.
 */
export function postBridgeOperation(request: BridgeRequest, signal?: AbortSignal): Promise<BridgeResponse> {
  return httpClient.postJson<BridgeResponse>("/api/v2/geometry/bridge", request, { signal });
}
