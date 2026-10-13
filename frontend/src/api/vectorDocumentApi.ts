import { httpClient } from "./httpClient";
import type {
  EditorSaveRequestBody,
  EditorSaveResponse,
  UpdateLayerRequestBody,
  VectorDocumentLayerResponse,
  VectorDocumentResponse,
  VectorDocumentSaveRequestBody,
  VectorDocumentSaveResponse,
  VectorDocumentVersionSummaryResponse,
} from "../types/vectorDocument";

/**
 * Guarda el VectorDocument vigente de una sesión de Workspace (M2.2-S05): crea el Project v2 en
 * el primer Save (`body.projectId` null), o agrega una DocumentVersion nueva en los siguientes
 * (`body.projectId` ya conocido). Nunca optimista del lado del cliente -- el llamador
 * (useWorkspaceSave) solo marca "saved" tras la confirmación 200/201 real de esta promesa.
 */
export function saveWorkspace(
  body: VectorDocumentSaveRequestBody,
  signal?: AbortSignal,
): Promise<VectorDocumentSaveResponse> {
  return httpClient.postJson<VectorDocumentSaveResponse>("/api/v2/workspaces/save", body, { signal });
}

/**
 * Recupera la DocumentVersion ACTUAL completa de un proyecto guardado -- usado por la
 * reapertura del Workspace vía deep-link (`savedProjectId`), en vez de reconstruir el documento
 * desde el flujo clásico (ver lib/workspaceLocation.ts).
 */
export function getVectorDocument(projectId: string, signal?: AbortSignal): Promise<VectorDocumentResponse> {
  return httpClient.get<VectorDocumentResponse>(`/api/v2/projects/${projectId}/document`, { signal });
}

/**
 * Persiste el estado de geometría del editor como una nueva DocumentVersion (M3-S13).
 * El cliente manda el SVG serializado de TODAS las capas; el servidor las sube como Assets
 * y crea la versión. Soporta idempotencia (misma key = mismo resultado).
 */
export function editorSave(
  projectId: string,
  body: EditorSaveRequestBody,
  signal?: AbortSignal,
): Promise<EditorSaveResponse> {
  return httpClient.postJson<EditorSaveResponse>(
    `/api/v2/projects/${projectId}/document/editor-save`,
    body,
    { signal },
  );
}

/**
 * Lista todas las versiones del documento de un proyecto (M2.2-S06, M3-S13): metadata, sin layers.
 */
export function listVersions(
  projectId: string,
  signal?: AbortSignal,
): Promise<VectorDocumentVersionSummaryResponse[]> {
  return httpClient.get<VectorDocumentVersionSummaryResponse[]>(
    `/api/v2/projects/${projectId}/versions`,
    { signal },
  );
}

/**
 * Restaura una versión histórica del documento como una nueva DocumentVersion (M2.2-S06, M3-S13).
 * El servidor crea una copia de la versión indicada con Origin: RESTORE.
 */
export function restoreVersion(
  projectId: string,
  versionNumber: number,
  signal?: AbortSignal,
): Promise<VectorDocumentSaveResponse> {
  return httpClient.postJson<VectorDocumentSaveResponse>(
    `/api/v2/projects/${projectId}/versions/${versionNumber}/restore`,
    {},
    { signal },
  );
}

/**
 * Actualiza order/visible/locked/name/operación de una capa YA guardada (cutover de los
 * sidecars clásicos tras el primer Save, M2.2-S05). Campo ausente/null = sin cambios.
 */
export function updateVectorDocumentLayer(
  projectId: string,
  layerId: string,
  patch: UpdateLayerRequestBody,
  signal?: AbortSignal,
): Promise<VectorDocumentLayerResponse> {
  return httpClient.patchJson<VectorDocumentLayerResponse>(
    `/api/v2/projects/${projectId}/layers/${layerId}`,
    patch,
    { signal },
  );
}
