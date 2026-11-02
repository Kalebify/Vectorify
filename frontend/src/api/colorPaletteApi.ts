import { API_BASE_URL, httpClient } from "./httpClient";
import type { BackgroundCorrection, ColorPaletteResponse, GroupingStyle } from "../types/colorPalette";

function baseUrl(projectId: string, imageId: string): string {
  return `/api/v1/projects/${projectId}/images/${imageId}/color-palette`;
}

/**
 * Detecta la paleta de colores de la imagen original ya subida. Sin
 * `paletteId`: arranca una sesión nueva. Con `paletteId`: re-detecta bajo
 * esa misma sesión (mismos parámetros -> cache-hit del lado de la Web API).
 */
export function detectColorPalette(
  projectId: string,
  imageId: string,
  params: {
    paletteId?: string | null;
    tolerance?: number | null;
    maxColors?: number | null;
    groupingStyle?: GroupingStyle | null;
    targetFamilies?: number | null;
    groupingStrength?: number | null;
    backgroundCorrections?: BackgroundCorrection[] | null;
  },
  signal?: AbortSignal,
): Promise<ColorPaletteResponse> {
  return httpClient.postJson<ColorPaletteResponse>(
    `${baseUrl(projectId, imageId)}/detect`,
    {
      paletteId: params.paletteId ?? null,
      tolerance: params.tolerance ?? null,
      maxColors: params.maxColors ?? null,
      groupingStyle: params.groupingStyle ?? null,
      targetFamilies: params.targetFamilies ?? null,
      groupingStrength: params.groupingStrength ?? null,
      backgroundCorrections: params.backgroundCorrections ?? undefined,
    },
    { signal },
  );
}

/** Fusiona 2+ grupos de color en uno solo (crea una nueva versión de la paleta). */
export function mergeColorPaletteGroups(
  projectId: string,
  imageId: string,
  paletteId: string,
  groupIds: string[],
  name: string | null,
  signal?: AbortSignal,
): Promise<ColorPaletteResponse> {
  return httpClient.postJson<ColorPaletteResponse>(
    `${baseUrl(projectId, imageId)}/${paletteId}/merge`,
    { groupIds, name },
    { signal },
  );
}

/** Deshace el último merge que produjo el grupo indicado (mientras la paleta no esté confirmada). */
export function unmergeColorPaletteGroup(
  projectId: string,
  imageId: string,
  paletteId: string,
  groupId: string,
  signal?: AbortSignal,
): Promise<ColorPaletteResponse> {
  return httpClient.postJson<ColorPaletteResponse>(
    `${baseUrl(projectId, imageId)}/${paletteId}/unmerge`,
    { groupId },
    { signal },
  );
}

/** Renombra un grupo de color (crea una nueva versión de la paleta). */
export function renameColorPaletteGroup(
  projectId: string,
  imageId: string,
  paletteId: string,
  groupId: string,
  name: string,
  signal?: AbortSignal,
): Promise<ColorPaletteResponse> {
  return httpClient.postJson<ColorPaletteResponse>(
    `${baseUrl(projectId, imageId)}/${paletteId}/rename`,
    { groupId, name },
    { signal },
  );
}

/** Marca un grupo como incluido/excluido (M2.1-S02), independiente de un merge. */
export function setColorPaletteGroupExclusion(
  projectId: string,
  imageId: string,
  paletteId: string,
  groupId: string,
  isExcluded: boolean,
  signal?: AbortSignal,
): Promise<ColorPaletteResponse> {
  return httpClient.postJson<ColorPaletteResponse>(
    `${baseUrl(projectId, imageId)}/${paletteId}/exclude`,
    { groupId, isExcluded },
    { signal },
  );
}

/** Confirma la paleta final: queda como entrada declarada de M2-S02. */
export function confirmColorPalette(
  projectId: string,
  imageId: string,
  paletteId: string,
  signal?: AbortSignal,
): Promise<ColorPaletteResponse> {
  return httpClient.postJson<ColorPaletteResponse>(`${baseUrl(projectId, imageId)}/${paletteId}/confirm`, {}, { signal });
}

/**
 * Recupera la última versión vigente de una sesión de paleta ya existente
 * (M2.1-S06, Workspace del Editor General: abrir un proyecto existente
 * necesita leer su paleta CONFIRMADA sin volver a detectarla/mutarla) --
 * usa el endpoint GET ya expuesto por ColorPaletteEndpoints
 * (`GetColorPalette`), no uno nuevo.
 */
export function getColorPalette(
  projectId: string,
  imageId: string,
  paletteId: string,
  signal?: AbortSignal,
): Promise<ColorPaletteResponse> {
  return httpClient.get<ColorPaletteResponse>(`${baseUrl(projectId, imageId)}/${paletteId}`, { signal });
}

/** URL para mostrar (en un <img>) el preview cuantizado en vivo de la última versión de una sesión. */
export function getColorPalettePreviewUrl(projectId: string, imageId: string, paletteId: string): string {
  return `${API_BASE_URL}${baseUrl(projectId, imageId)}/${paletteId}/preview`;
}
