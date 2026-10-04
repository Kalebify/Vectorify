/**
 * Contratos tipados de la API CRUD de proyectos persistentes (M2.2-S03, extendidos en M2.2-S08):
 * GET/POST/PATCH/DELETE /api/v2/projects[/{id}], POST /api/v2/projects/{id}/duplicate. Deben
 * reflejar exactamente Vectorify.Api.Contracts.ProjectResponse / ProjectSummaryResponse /
 * ProjectListResponse. No confundir con `UploadImageResponse` (flujo clásico, `types/upload.ts`).
 */

/** Órdenes soportados por GET /api/v2/projects (`sortBy`, case-insensitive en el backend). */
export type ProjectSortBy = "LastModified" | "Name" | "Created";

/** Un proyecto dentro del listado (ProjectSummaryResponse). */
export interface ProjectSummary {
  id: string;
  name: string;
  thumbnailAssetId: string | null;
  createdAt: string;
  updatedAt: string;
  /** Cantidad de capas de la versión actual (0 si todavía no hay ninguna). */
  layerCount: number;
  /** Ruta RELATIVA al origen de la API (ver `resolveThumbnailUrl`); null si no hay thumbnail. */
  thumbnailUrl: string | null;
  /** Triple clásico con el que se reabre el Workspace; null = "no se puede reabrir". */
  classicProjectId: string | null;
  classicImageId: string | null;
  classicPaletteId: string | null;
}

export interface ProjectListResponse {
  items: ProjectSummary[];
  page: number;
  pageSize: number;
  /** Total ANTES de paginar. */
  totalCount: number;
}

/** Detalle de un proyecto (ProjectResponse): respuesta de GET/PATCH/duplicate de un único proyecto. */
export interface ProjectDetail {
  id: string;
  ownerId: string;
  name: string;
  description: string | null;
  thumbnailAssetId: string | null;
  currentVersionId: string | null;
  createdAt: string;
  updatedAt: string;
  classicProjectId: string | null;
  classicImageId: string | null;
  classicPaletteId: string | null;
}

export interface ListProjectsParams {
  page?: number;
  pageSize?: number;
  search?: string;
  sortBy?: ProjectSortBy;
  signal?: AbortSignal;
}
