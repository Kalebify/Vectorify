import { API_BASE_URL, httpClient } from "./httpClient";
import type { ListProjectsParams, ProjectDetail, ProjectListResponse } from "../types/projectsV2";

/**
 * Cliente de la API CRUD de proyectos persistentes (`/api/v2/projects`, M2.2-S03). Archivo
 * deliberadamente distinto de `projectsApi.ts`, que es del flujo clásico de upload
 * (`/api/v1/projects`, otro concepto de dominio que coincide en nombre por casualidad).
 */

/** Lista los proyectos del usuario efectivo: paginado, con búsqueda por nombre y orden. */
export function listProjects(params: ListProjectsParams = {}): Promise<ProjectListResponse> {
  const query = new URLSearchParams();
  if (params.page !== undefined) query.set("page", String(params.page));
  if (params.pageSize !== undefined) query.set("pageSize", String(params.pageSize));
  if (params.search) query.set("search", params.search);
  if (params.sortBy) query.set("sortBy", params.sortBy);

  const queryString = query.toString();
  return httpClient.get<ProjectListResponse>(`/api/v2/projects${queryString ? `?${queryString}` : ""}`, {
    signal: params.signal,
  });
}

export function getProject(id: string, signal?: AbortSignal): Promise<ProjectDetail> {
  return httpClient.get<ProjectDetail>(`/api/v2/projects/${id}`, { signal });
}

/** PATCH con solo `name` (el backend trata un campo null como "sin cambios"). */
export function renameProject(id: string, name: string, signal?: AbortSignal): Promise<ProjectDetail> {
  return httpClient.patchJson<ProjectDetail>(`/api/v2/projects/${id}`, { name }, { signal });
}

export function duplicateProject(id: string, signal?: AbortSignal): Promise<ProjectDetail> {
  return httpClient.postJson<ProjectDetail>(`/api/v2/projects/${id}/duplicate`, {}, { signal });
}

/** Soft-delete: el backend responde 204 sin cuerpo. */
export function deleteProject(id: string, signal?: AbortSignal): Promise<void> {
  return httpClient.delete(`/api/v2/projects/${id}`, { signal });
}

/**
 * `ProjectSummary.thumbnailUrl` es una ruta relativa al origen de la API (el backend no conoce
 * el origen público): se prefija con `API_BASE_URL` igual que el resto de las URLs de assets.
 */
export function resolveThumbnailUrl(thumbnailUrl: string | null): string | null {
  if (!thumbnailUrl) return null;
  return /^https?:\/\//i.test(thumbnailUrl) ? thumbnailUrl : `${API_BASE_URL}${thumbnailUrl}`;
}
