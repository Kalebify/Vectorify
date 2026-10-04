/**
 * Preferencia Grid/List de Mis Proyectos (M2.2-S08), guardada en localStorage SOLO como
 * conveniencia: cualquier fallo de acceso (storage bloqueado, cuota, modo privado) se ignora y
 * la pantalla cae al default "grid" -- mismo criterio best-effort que `workspaceRecovery.ts`.
 */

export type ProjectsViewMode = "grid" | "list";

const STORAGE_KEY = "vectorify.projectsViewMode.v1";

export function readProjectsViewMode(): ProjectsViewMode {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

export function saveProjectsViewMode(mode: ProjectsViewMode): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Preferencia puramente cosmética: si no se puede persistir, la sesión actual sigue igual.
  }
}
