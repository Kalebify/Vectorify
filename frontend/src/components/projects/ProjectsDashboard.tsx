import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { deleteProject, duplicateProject, listProjects, renameProject } from "../../api/projectsV2Api";
import { ApiClientError } from "../../api/httpClient";
import {
  readProjectsViewMode,
  saveProjectsViewMode,
  type ProjectsViewMode,
} from "../../lib/projectsViewPreference";
import type { WorkspaceLocation } from "../../lib/workspaceLocation";
import type { ProjectSortBy, ProjectSummary } from "../../types/projectsV2";
import { DeleteProjectDialog } from "./DeleteProjectDialog";
import type { ProjectAction } from "./ProjectActionsMenu";
import { ProjectCard } from "./ProjectCard";
import { RenameProjectDialog } from "./RenameProjectDialog";
import "./projects.css";

/** Tamaño de página de Mis Proyectos (spec M2.2-S08). */
export const PROJECTS_PAGE_SIZE = 12;

/** Debounce de la búsqueda (spec M2.2-S08). */
export const SEARCH_DEBOUNCE_MS = 300;

const SORT_OPTIONS: { value: ProjectSortBy; label: string }[] = [
  { value: "LastModified", label: "Última modificación" },
  { value: "Name", label: "Nombre" },
  { value: "Created", label: "Fecha de creación" },
];

const NOT_REOPENABLE_MESSAGE =
  "Este proyecto no se puede reabrir: se creó antes de que el sistema guardara el origen de su imagen. " +
  "Creá un proyecto nuevo a partir de la imagen original.";

const NETWORK_ERROR_MESSAGE = "No se pudo contactar con el servidor. Revisá tu conexión e intentá de nuevo.";

interface ProjectsDashboardProps {
  onNewProject: () => void;
  /** Abre el Workspace de un proyecto guardado: App hace push de la URL y reusa `resolveWorkspaceDeepLink`. */
  onOpenProject: (location: WorkspaceLocation) => void;
  /** Avisos de App (deep-link inválido, "Continuar donde quedaste") que se muestran arriba de todo. */
  notices?: ReactNode;
  pageSize?: number;
}

interface Query {
  page: number;
  /** Búsqueda ya con debounce y trim. */
  search: string;
  sortBy: ProjectSortBy;
}

interface ListData {
  items: ProjectSummary[];
  totalCount: number;
  /** Búsqueda con la que se pidió esta página (para distinguir "vacío" de "sin resultados"). */
  search: string;
  loadedAt: number;
}

type ListState =
  | { status: "loading" }
  | { status: "ready"; data: ListData }
  | { status: "error"; kind: "network" | "api"; httpStatus?: number };

interface Notice {
  kind: "success" | "error";
  text: string;
}

const NO_DISABLED_ACTIONS: ReadonlySet<ProjectAction> = new Set();
const DUPLICATE_DISABLED: ReadonlySet<ProjectAction> = new Set<ProjectAction>(["duplicate"]);

function isAbort(error: unknown): boolean {
  return error instanceof ApiClientError && error.isAborted;
}

function serverMessage(error: unknown): string | null {
  if (error instanceof ApiClientError && typeof error.body === "object" && error.body !== null) {
    const message = (error.body as { message?: unknown }).message;
    return typeof message === "string" && message.trim() ? message : null;
  }
  return null;
}

/** Mensaje comprensible para un fallo genérico (red o API) de una acción. */
function describeFailure(error: unknown): string {
  if (error instanceof ApiClientError && !error.isNetworkError && error.status !== undefined) {
    return `El servidor no pudo completar la operación (código ${error.status}). Intentá de nuevo en unos minutos.`;
  }
  return NETWORK_ERROR_MESSAGE;
}

function httpStatusOf(error: unknown): number | undefined {
  return error instanceof ApiClientError ? error.status : undefined;
}

/**
 * Pantalla "Mis proyectos" (M2.2-S08): lista los proyectos persistentes (API v2 real) y completa el
 * ciclo Create/Open/Rename/Duplicate/Delete con estados loading/empty/error. Es una pantalla
 * "tonta" respecto de la navegación: crear y abrir se delegan a App (`onNewProject`/`onOpenProject`),
 * que es quien conoce las URLs y reusa `resolveWorkspaceDeepLink` -- este componente nunca
 * rehidrata nada por su cuenta.
 */
export function ProjectsDashboard({
  onNewProject,
  onOpenProject,
  notices,
  pageSize = PROJECTS_PAGE_SIZE,
}: ProjectsDashboardProps) {
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState<Query>({ page: 1, search: "", sortBy: "LastModified" });
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [viewMode, setViewMode] = useState<ProjectsViewMode>(readProjectsViewMode);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [renameTarget, setRenameTarget] = useState<ProjectSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProjectSummary | null>(null);
  const [duplicatingIds, setDuplicatingIds] = useState<ReadonlySet<string>>(new Set());

  const controllerRef = useRef<AbortController | null>(null);
  const queryRef = useRef(query);
  // Guarda síncrona contra el doble click en "Duplicar": el estado de React se actualiza de forma
  // asíncrona, dos clicks en el mismo tick verían ambos "no hay duplicación en vuelo".
  const duplicatingRef = useRef(new Set<string>());
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  // Pide una página. `silent` = refresco posterior a una acción: no vuelve a mostrar el skeleton
  // (la lista actual se queda en pantalla hasta que llegue la nueva).
  const load = useCallback(
    (target: Query, silent: boolean) => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      if (!silent) {
        setList({ status: "loading" });
      }

      listProjects({
        page: target.page,
        pageSize,
        search: target.search || undefined,
        sortBy: target.sortBy,
        signal: controller.signal,
      })
        .then((response) => {
          if (controller.signal.aborted) return;

          // La página pedida ya no existe (se borraron proyectos, p. ej. desde otra pestaña):
          // retrocede a la última página válida en vez de mostrar una lista vacía engañosa.
          if (response.items.length === 0 && response.totalCount > 0 && target.page > 1) {
            const lastPage = Math.max(1, Math.ceil(response.totalCount / pageSize));
            setQuery((current) => (current.page === target.page ? { ...current, page: lastPage } : current));
            return;
          }

          setList({
            status: "ready",
            data: {
              items: response.items,
              totalCount: response.totalCount,
              search: target.search,
              loadedAt: Date.now(),
            },
          });
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || isAbort(error)) return;

          setList({
            status: "error",
            kind: error instanceof ApiClientError && !error.isNetworkError ? "api" : "network",
            httpStatus: httpStatusOf(error),
          });
        });
    },
    [pageSize],
  );

  useEffect(() => {
    load(query, false);
    return () => controllerRef.current?.abort();
  }, [query, load]);

  // Debounce de la búsqueda: reinicia a la página 1 solo cuando el término efectivo cambia.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const next = searchInput.trim();
      setQuery((current) => (current.search === next ? current : { ...current, search: next, page: 1 }));
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const refresh = useCallback(() => load(queryRef.current, true), [load]);

  const changeViewMode = (mode: ProjectsViewMode) => {
    setViewMode(mode);
    saveProjectsViewMode(mode);
  };

  const clearSearch = () => {
    setSearchInput("");
    setQuery((current) => (current.search === "" ? current : { ...current, search: "", page: 1 }));
  };

  const handleOpen = (project: ProjectSummary) => {
    if (!project.classicProjectId || !project.classicImageId || !project.classicPaletteId) {
      setNotice({ kind: "error", text: NOT_REOPENABLE_MESSAGE });
      return;
    }

    setNotice(null);
    onOpenProject({
      projectId: project.classicProjectId,
      imageId: project.classicImageId,
      paletteId: project.classicPaletteId,
      savedProjectId: project.id,
    });
  };

  const handleDuplicate = async (project: ProjectSummary) => {
    if (duplicatingRef.current.has(project.id)) return;

    duplicatingRef.current.add(project.id);
    setDuplicatingIds(new Set(duplicatingRef.current));
    setNotice(null);

    try {
      const copy = await duplicateProject(project.id);
      setNotice({ kind: "success", text: `Se creó la copia «${copy.name}».` });
      refresh();
    } catch (error) {
      if (httpStatusOf(error) === 404) {
        setNotice({
          kind: "error",
          text: `«${project.name}» ya no existe (quizá se eliminó desde otra pestaña). Actualizamos la lista.`,
        });
        refresh();
      } else {
        setNotice({ kind: "error", text: `No se pudo duplicar «${project.name}». ${describeFailure(error)}` });
      }
    } finally {
      duplicatingRef.current.delete(project.id);
      setDuplicatingIds(new Set(duplicatingRef.current));
    }
  };

  const handleRename = async (project: ProjectSummary, name: string): Promise<string | null> => {
    if (name === project.name) {
      setRenameTarget(null);
      return null;
    }

    try {
      await renameProject(project.id, name);
    } catch (error) {
      const status = httpStatusOf(error);

      if (status === 400) {
        return serverMessage(error) ?? "El nombre no es válido.";
      }

      if (status === 404) {
        setRenameTarget(null);
        setNotice({
          kind: "error",
          text: `«${project.name}» ya no existe (quizá se eliminó desde otra pestaña). Actualizamos la lista.`,
        });
        refresh();
        return null;
      }

      if (status === 409) {
        setRenameTarget(null);
        setNotice({
          kind: "error",
          text: `«${project.name}» se modificó desde otra pestaña o sesión y no se pudo renombrar. Actualizamos la lista: intentá de nuevo.`,
        });
        refresh();
        return null;
      }

      return describeFailure(error);
    }

    setRenameTarget(null);
    setNotice({ kind: "success", text: `Proyecto renombrado a «${name}».` });
    refresh();
    return null;
  };

  const handleDelete = async (project: ProjectSummary): Promise<string | null> => {
    let alreadyGone = false;
    try {
      await deleteProject(project.id);
    } catch (error) {
      // 404: ya lo había borrado otra pestaña -- el resultado deseado ("no está más") ya se cumple.
      if (httpStatusOf(error) === 404) {
        alreadyGone = true;
      } else {
        return describeFailure(error);
      }
    }

    setDeleteTarget(null);
    setNotice({
      kind: "success",
      text: alreadyGone ? `«${project.name}» ya había sido eliminado.` : `Se eliminó «${project.name}».`,
    });

    // Si era el único proyecto de una página que no es la primera, retrocede una página (el cambio
    // de `query` dispara la recarga); si no, refresca la página actual.
    const itemsOnPage = list.status === "ready" ? list.data.items.length : 0;
    if (itemsOnPage <= 1 && queryRef.current.page > 1) {
      setQuery((current) => ({ ...current, page: current.page - 1 }));
    } else {
      refresh();
    }

    // La card eliminada se llevó consigo el foco: lo reubica en el título de la pantalla.
    window.setTimeout(() => headingRef.current?.focus(), 0);
    return null;
  };

  const handleAction = (action: ProjectAction, project: ProjectSummary) => {
    switch (action) {
      case "open":
        handleOpen(project);
        break;
      case "rename":
        setRenameTarget(project);
        break;
      case "duplicate":
        void handleDuplicate(project);
        break;
      case "delete":
        setDeleteTarget(project);
        break;
    }
  };

  const totalPages = list.status === "ready" ? Math.max(1, Math.ceil(list.data.totalCount / pageSize)) : 1;

  return (
    <div className="projects-dashboard">
      <header className="projects-header">
        <h1 className="projects-header__brand">VECTORiZE</h1>
        <button type="button" className="upload-actions__button upload-actions__button--primary" onClick={onNewProject}>
          New Project
        </button>
      </header>

      <main className="projects-main">
        {notices}

        {notice && (
          <div
            className={`projects-notice projects-notice--${notice.kind}`}
            role={notice.kind === "error" ? "alert" : "status"}
            aria-label={notice.kind === "error" ? "Error" : "Aviso"}
          >
            <p>{notice.text}</p>
            <button type="button" className="upload-actions__button" onClick={() => setNotice(null)}>
              Cerrar aviso
            </button>
          </div>
        )}

        <section aria-labelledby="projects-heading" className="projects-section">
          <h2 id="projects-heading" ref={headingRef} tabIndex={-1}>
            Mis proyectos
          </h2>

          <div className="projects-toolbar">
            <input
              type="search"
              className="projects-toolbar__search"
              aria-label="Buscar proyectos"
              placeholder="Buscar por nombre"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
            />

            <label className="projects-toolbar__sort">
              <span>Ordenar por</span>
              <select
                value={query.sortBy}
                onChange={(event) =>
                  setQuery((current) => ({ ...current, sortBy: event.target.value as ProjectSortBy, page: 1 }))
                }
              >
                {SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <div className="projects-toolbar__modes" role="group" aria-label="Tipo de vista">
              <button
                type="button"
                className="projects-toolbar__mode"
                aria-pressed={viewMode === "grid"}
                onClick={() => changeViewMode("grid")}
              >
                Grid
              </button>
              <button
                type="button"
                className="projects-toolbar__mode"
                aria-pressed={viewMode === "list"}
                onClick={() => changeViewMode("list")}
              >
                List
              </button>
            </div>
          </div>

          {list.status === "loading" && (
            <div className="projects-skeleton" role="status" aria-busy="true" aria-label="Cargando proyectos">
              <ul className={`projects-list projects-list--${viewMode}`} aria-hidden="true">
                {Array.from({ length: 6 }, (_, index) => (
                  <li key={index} className="project-card project-card--skeleton">
                    <div className="project-card__thumbnail" />
                    <div className="project-card__body">
                      <span className="projects-skeleton__line" />
                      <span className="projects-skeleton__line projects-skeleton__line--short" />
                    </div>
                  </li>
                ))}
              </ul>
              <span className="projects-visually-hidden">Cargando proyectos…</span>
            </div>
          )}

          {list.status === "error" && (
            <div className="projects-state projects-state--error" role="alert">
              <h3>No pudimos cargar tus proyectos</h3>
              <p>
                {list.kind === "network"
                  ? NETWORK_ERROR_MESSAGE
                  : `El servidor respondió con un error${list.httpStatus ? ` (código ${list.httpStatus})` : ""}. Intentá de nuevo en unos minutos.`}
              </p>
              <button
                type="button"
                className="upload-actions__button upload-actions__button--primary"
                onClick={() => load(query, false)}
              >
                Reintentar
              </button>
            </div>
          )}

          {list.status === "ready" && list.data.items.length === 0 && list.data.search === "" && (
            <div className="projects-state">
              <h3>Todavía no tenés proyectos</h3>
              <p>Subí una imagen y guardá el documento desde el Workspace: va a aparecer acá.</p>
              <button type="button" className="upload-actions__button upload-actions__button--primary" onClick={onNewProject}>
                Crear proyecto
              </button>
            </div>
          )}

          {list.status === "ready" && list.data.items.length === 0 && list.data.search !== "" && (
            <div className="projects-state">
              <h3>Sin resultados</h3>
              <p>No encontramos proyectos que coincidan con «{list.data.search}».</p>
              <button type="button" className="upload-actions__button" onClick={clearSearch}>
                Limpiar búsqueda
              </button>
            </div>
          )}

          {list.status === "ready" && list.data.items.length > 0 && (
            <>
              <p className="projects-count" aria-live="polite">
                {list.data.totalCount} {list.data.totalCount === 1 ? "proyecto" : "proyectos"}
              </p>

              <ul className={`projects-list projects-list--${viewMode}`} aria-label="Proyectos">
                {list.data.items.map((project) => (
                  <ProjectCard
                    key={project.id}
                    project={project}
                    now={list.data.loadedAt}
                    disabledActions={duplicatingIds.has(project.id) ? DUPLICATE_DISABLED : NO_DISABLED_ACTIONS}
                    onAction={handleAction}
                  />
                ))}
              </ul>

              {totalPages > 1 && (
                <nav className="projects-pagination" aria-label="Paginación">
                  <button
                    type="button"
                    className="upload-actions__button"
                    disabled={query.page <= 1}
                    onClick={() => setQuery((current) => ({ ...current, page: current.page - 1 }))}
                  >
                    Anterior
                  </button>
                  <span aria-live="polite">
                    Página {query.page} de {totalPages}
                  </span>
                  <button
                    type="button"
                    className="upload-actions__button"
                    disabled={query.page >= totalPages}
                    onClick={() => setQuery((current) => ({ ...current, page: current.page + 1 }))}
                  >
                    Siguiente
                  </button>
                </nav>
              )}
            </>
          )}
        </section>
      </main>

      {renameTarget && (
        <RenameProjectDialog
          key={renameTarget.id}
          projectName={renameTarget.name}
          onSubmit={(name) => handleRename(renameTarget, name)}
          onClose={() => setRenameTarget(null)}
        />
      )}

      {deleteTarget && (
        <DeleteProjectDialog
          key={deleteTarget.id}
          projectName={deleteTarget.name}
          onConfirm={() => handleDelete(deleteTarget)}
          onClose={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
