/**
 * Ruteo mínimo del Workspace (M2.1-S06, persistencia M2.1-S08): la URL
 * identifica projectId/imageId/paletteId vía query string, sincronizada a
 * mano con `URLSearchParams` + `History.pushState` -- sin agregar
 * `react-router` ni ninguna otra dependencia de ruteo.
 *
 * Justificación (ver IMPL.md para el detalle completo): hoy la app tiene un
 * solo estado de navegación real ("Workspace abierto con estos 3 ids" vs.
 * "flujo clásico de Upload hacia abajo"), sin rutas anidadas, sin parámetros
 * dinámicos adicionales y sin necesidad de un layout por ruta -- exactamente
 * el mismo criterio ya aplicado en M2.1-S07 para Drag & Drop nativo (preferir
 * la plataforma antes que una dependencia nueva cuando el caso de uso es
 * acotado). Si una tarjeta futura agrega rutas anidadas reales (ej. M2.2-S08,
 * "Mis Proyectos", con su propia URL y navegación entre proyectos), ahí sí
 * vale la pena reevaluar `react-router`.
 */

export interface WorkspaceLocation {
  projectId: string;
  imageId: string;
  paletteId: string;
  /**
   * Project.Id v2 (M2.2-S05, "Reapertura") -- presente solo después de un primer Save exitoso
   * en esta sesión del Workspace (agregado a la URL sin recargar la página, ver
   * `pushWorkspaceLocation`/`useWorkspaceSave`) o si el deep-link lo trae de entrada (reload
   * dentro del Workspace ya guardado). Cuando está presente, `App.tsx` lo prioriza para
   * reconstruir el VectorDocument vía `GET /api/v2/projects/{savedProjectId}/document` en vez
   * del flujo clásico de 3 endpoints -- ver ese archivo. Opcional: el triple clásico
   * (projectId/imageId/paletteId) sigue siendo obligatorio incluso con `savedProjectId`
   * presente, porque las mutaciones del Workspace (toggle/rename/reorder/operación) siguen
   * resolviéndose contra los sidecars clásicos en esta tarjeta (ver spec.md, cutover de
   * sidecars: el frontend no migra esas llamadas a los PATCH v2 nuevos todavía).
   */
  savedProjectId?: string;
}

const PROJECT_PARAM = "projectId";
const IMAGE_PARAM = "imageId";
const PALETTE_PARAM = "paletteId";
const SAVED_PROJECT_PARAM = "savedProjectId";

/**
 * Lee projectId/imageId/paletteId (+ savedProjectId opcional) de una query string (default: la
 * URL actual del navegador). Devuelve `null` si falta cualquiera de los tres PRIMEROS -- un
 * deep-link parcial no alcanza para reconstruir el Workspace. `savedProjectId` nunca es
 * obligatorio: su ausencia simplemente significa "sesión todavía no guardada" (comportamiento
 * de M2.1-S08 sin cambios).
 */
export function readWorkspaceLocation(search: string = window.location.search): WorkspaceLocation | null {
  const params = new URLSearchParams(search);
  const projectId = params.get(PROJECT_PARAM);
  const imageId = params.get(IMAGE_PARAM);
  const paletteId = params.get(PALETTE_PARAM);
  const savedProjectId = params.get(SAVED_PROJECT_PARAM);

  if (!projectId || !imageId || !paletteId) {
    return null;
  }

  return { projectId, imageId, paletteId, ...(savedProjectId ? { savedProjectId } : {}) };
}

/** Construye la query string (con el `?` inicial) para una ubicación del Workspace. */
export function buildWorkspaceSearch(location: WorkspaceLocation): string {
  const params = new URLSearchParams();
  params.set(PROJECT_PARAM, location.projectId);
  params.set(IMAGE_PARAM, location.imageId);
  params.set(PALETTE_PARAM, location.paletteId);
  if (location.savedProjectId) {
    params.set(SAVED_PROJECT_PARAM, location.savedProjectId);
  }
  return `?${params.toString()}`;
}

/**
 * Actualiza la URL del navegador para reflejar el Workspace abierto (push,
 * no replace -- un reload inmediatamente después reconstruye la misma
 * sesión, ver spec.md punto 4 del alcance).
 */
export function pushWorkspaceLocation(location: WorkspaceLocation): void {
  const search = buildWorkspaceSearch(location);
  window.history.pushState({}, "", `${window.location.pathname}${search}`);
}

/** Vuelve a la URL del flujo clásico (sin query params) -- usado al cerrar el Workspace. */
export function clearWorkspaceLocation(): void {
  window.history.pushState({}, "", window.location.pathname);
}

/**
 * Vistas de la app (M2.2-S08), identificadas por la misma query string -- sin `react-router`
 * (mismo criterio que el Workspace, ver cabecera del archivo):
 *  - `dashboard`: sin params (o `?view=<desconocido>`) -- pantalla "Mis proyectos", landing por defecto.
 *  - `new`: `?view=new` -- flujo clásico de upload (la home hasta M2.2-S07).
 *  - `workspace`: params de Workspace (`projectId/imageId/paletteId[/savedProjectId]`), sin cambios.
 * El Workspace tiene prioridad: un deep-link completo gana sobre cualquier `view`.
 */
export type AppView = "dashboard" | "new" | "workspace";

/** Vistas "de página" que se navegan con `pushAppView` (el Workspace se navega con `pushWorkspaceLocation`). */
export type PageView = Exclude<AppView, "workspace">;

const VIEW_PARAM = "view";
const NEW_VIEW_VALUE = "new";

/** Resuelve la vista de una query string (default: la URL actual del navegador). */
export function readAppView(search: string = window.location.search): AppView {
  if (readWorkspaceLocation(search)) {
    return "workspace";
  }

  return new URLSearchParams(search).get(VIEW_PARAM) === NEW_VIEW_VALUE ? "new" : "dashboard";
}

/** Query string (con `?` inicial, o "" para el dashboard) de una vista de página. */
export function buildViewSearch(view: PageView): string {
  if (view === "new") {
    const params = new URLSearchParams();
    params.set(VIEW_PARAM, NEW_VIEW_VALUE);
    return `?${params.toString()}`;
  }

  return "";
}

/** Navega (push, sin recargar) a una vista de página. */
export function pushAppView(view: PageView): void {
  window.history.pushState({}, "", `${window.location.pathname}${buildViewSearch(view)}`);
}
