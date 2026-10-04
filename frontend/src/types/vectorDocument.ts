/**
 * Contratos tipados de la persistencia completa del VectorDocument (M2.2-S05):
 * POST /api/v2/workspaces/save, GET /api/v2/projects/{projectId}/document,
 * PATCH /api/v2/projects/{projectId}/layers/{layerId}. Deben reflejar
 * exactamente Vectorify.Api.Contracts.VectorDocumentSaveRequest/
 * VectorDocumentSaveResponse/VectorDocumentResponse/VectorDocumentLayerResponse/
 * UpdateLayerRequest.
 */

/**
 * Cuerpo JSON de POST /api/v2/workspaces/save. `projectId` null -> crea un Project v2 nuevo
 * (`name` requerido en ese caso). `idempotencyKey` (M2.2-S07, opcional): GUID generado por el
 * cliente UNA vez por intento lógico de guardar -- el mismo valor se reenvía en cada reintento
 * (automático del debounce o manual) de ESE mismo intento, nunca uno nuevo por reintento. Ver
 * useWorkspaceSave.ts para dónde se genera.
 */
export interface VectorDocumentSaveRequestBody {
  projectId: string | null;
  name: string | null;
  classicProjectId: string;
  imageId: string;
  paletteId: string;
  paletteVersion: number;
  dimensionId: string | null;
  idempotencyKey?: string | null;
}

/** Respuesta de POST /api/v2/workspaces/save: confirmación mínima de que el Save se persistió. */
export interface VectorDocumentSaveResponse {
  projectId: string;
  versionNumber: number;
  savedAt: string;
}

/** Una capa dentro de VectorDocumentResponse (o respuesta individual de PATCH .../layers/{layerId}). */
export interface VectorDocumentLayerResponse {
  id: string;
  name: string;
  order: number;
  visible: boolean;
  locked: boolean;
  manufacturingOperation: string;
  colorHex: string;
  coverage: number;
  isBackground: boolean;
  svgAssetId: string | null;
  svgUrl: string | null;
  pathCount: number;
}

/** Respuesta de GET /api/v2/projects/{projectId}/document: la DocumentVersion ACTUAL completa. */
export interface VectorDocumentResponse {
  projectId: string;
  schemaVersion: number;
  widthMm: number;
  heightMm: number;
  viewBox: string;
  versionNumber: number;
  createdAt: string;
  layers: VectorDocumentLayerResponse[];
}

/** Cuerpo JSON de PATCH /api/v2/projects/{projectId}/layers/{layerId}: campo null/undefined = sin cambios. "unassigned" vacía explícitamente manufacturingOperation. */
export interface UpdateLayerRequestBody {
  name?: string | null;
  order?: number | null;
  visible?: boolean | null;
  locked?: boolean | null;
  manufacturingOperation?: string | null;
}

/** Code estable de error devuelto por estos tres endpoints -- se mapea a copy en React sin parsear message. */
export type VectorDocumentErrorCode =
  | "invalid_request"
  | "invalid_name"
  | "invalid_parameters"
  | "layer_set_not_found"
  | "palette_not_found"
  | "palette_not_confirmed"
  | "dimension_not_found"
  | "vector_not_found"
  | "storage_failure"
  | "unsupported_schema_version"
  | "concurrency_conflict"
  | "not_found"
  | "internal_error"
  | "network_error";
