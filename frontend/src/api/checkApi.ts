import { httpClient } from "./httpClient";
import type { CheckResponse, CheckSourceKind } from "../types/check";

/** Cuerpo JSON de POST .../check: refleja Vectorify.Api.Contracts.CheckRequest. */
interface CheckRequestBody {
  sourceKind: CheckSourceKind;
  sourceId: string;
  closeGapRatio: number | null;
  duplicatePointRatio: number | null;
}

/**
 * Ejecuta el Laser Checker de paths abiertos/duplicados (M1-S08) sobre un
 * SVG YA generado (vectorizado o simplificado) -- SIEMPRE a pedido del
 * usuario, nunca automático. Análisis de solo lectura: no persiste nada,
 * nunca modifica el SVG de origen.
 */
export function runPathCheck(
  projectId: string,
  imageId: string,
  sourceKind: CheckSourceKind,
  sourceId: string,
  signal?: AbortSignal,
): Promise<CheckResponse> {
  const body: CheckRequestBody = { sourceKind, sourceId, closeGapRatio: null, duplicatePointRatio: null };
  return httpClient.postJson<CheckResponse>(`/api/v1/projects/${projectId}/images/${imageId}/check`, body, { signal });
}

/**
 * Descarga el texto crudo del SVG ya generado (vectorizado o simplificado)
 * para poder resaltar un path localmente antes de renderizarlo (ver
 * lib/highlightSvgPath.ts) -- el mismo recurso que ya se usa como `src` de
 * un `<img>` en VectorCanvas, acá se lee como texto para poder inyectarle
 * el resaltado sin tocar el SVG persistido en el servidor.
 */
export async function fetchSvgText(svgUrl: string, signal?: AbortSignal): Promise<string> {
  // credentials: "include" (M3.1-S09): el SVG vive en la Web API (otro origen en desarrollo) y está protegido por la cookie de sesión; sin esto el navegador no la envía a otro
  // origen y la API responde 401 (el resaltado del Laser Checker fallaba en modo Authenticated).
  const response = await fetch(svgUrl, { signal, credentials: "include" });
  if (!response.ok) {
    throw new Error(`No se pudo descargar el SVG en ${svgUrl} (HTTP ${response.status}).`);
  }
  return response.text();
}
