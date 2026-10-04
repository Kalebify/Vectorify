import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectsDashboard, SEARCH_DEBOUNCE_MS } from "./ProjectsDashboard";
import { installProjectsApi, jsonResponse, makeProject } from "./projectsTestSupport";

/**
 * Mis Proyectos (M2.2-S08) contra un backend v2 de juguete detrás de `fetch` (ver
 * projectsTestSupport.ts). Los mocks respetan AbortSignal. Los tests de debounce usan fake timers.
 */

const VIEW_STORAGE_KEY = "vectorify.projectsViewMode.v1";

function renderDashboard(overrides: { onNewProject?: () => void; onOpenProject?: (location: unknown) => void } = {}) {
  const onNewProject = overrides.onNewProject ?? vi.fn();
  const onOpenProject = overrides.onOpenProject ?? vi.fn();
  render(<ProjectsDashboard onNewProject={onNewProject} onOpenProject={onOpenProject} />);
  return { onNewProject, onOpenProject };
}

function cardOf(name: string): HTMLElement {
  const item = screen.getByRole("button", { name }).closest("li");
  if (!item) throw new Error(`No se encontró la card de ${name}`);
  return item;
}

function openMenuOf(name: string) {
  fireEvent.click(screen.getByRole("button", { name: `Acciones de ${name}` }));
}

function chooseAction(projectName: string, action: string) {
  openMenuOf(projectName);
  fireEvent.click(screen.getByRole("menuitem", { name: action }));
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe("ProjectsDashboard — estados de la lista", () => {
  it("muestra un skeleton accesible mientras carga (no un spinner global)", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    renderDashboard();

    const skeleton = screen.getByRole("status", { name: "Cargando proyectos" });
    expect(skeleton).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("heading", { name: "VECTORiZE", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New Project" })).toBeInTheDocument();
  });

  it("sin proyectos muestra el empty state con la CTA 'Crear proyecto'", async () => {
    installProjectsApi([]);
    const { onNewProject } = renderDashboard();

    expect(await screen.findByText("Todavía no tenés proyectos")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Crear proyecto" }));

    expect(onNewProject).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status", { name: "Cargando proyectos" })).not.toBeInTheDocument();
  });

  it("el botón 'New Project' del header llama a onNewProject", async () => {
    installProjectsApi([makeProject(1)]);
    const { onNewProject } = renderDashboard();
    await screen.findByRole("button", { name: "Proyecto 01" });

    fireEvent.click(screen.getByRole("button", { name: "New Project" }));

    expect(onNewProject).toHaveBeenCalledTimes(1);
  });

  it("con un proyecto muestra nombre, 'N layers' (singular/plural) y la última modificación relativa con fecha absoluta accesible", async () => {
    const updatedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    installProjectsApi([
      makeProject(1, { name: "Llavero", layerCount: 1, updatedAt }),
      makeProject(2, { name: "Placa", layerCount: 4, updatedAt: new Date(Date.now() - 2 * 60 * 1000).toISOString() }),
      makeProject(3, { name: "Vacío", layerCount: 0, updatedAt: new Date(Date.now() - 1000).toISOString() }),
    ]);
    renderDashboard();

    await screen.findByRole("button", { name: "Llavero" });

    expect(within(cardOf("Llavero")).getByText("1 layer")).toBeInTheDocument();
    expect(within(cardOf("Placa")).getByText("4 layers")).toBeInTheDocument();
    expect(within(cardOf("Vacío")).getByText("0 layers")).toBeInTheDocument();

    const time = within(cardOf("Llavero")).getByText("hace 3 horas");
    expect(time.tagName).toBe("TIME");
    expect(time).toHaveAttribute("dateTime", updatedAt);
    expect(time.getAttribute("title")).toMatch(/\d/);
    expect(screen.getByText("3 proyectos")).toBeInTheDocument();
  });

  it("un error de red muestra un mensaje de conexión y 'Reintentar' vuelve a cargar", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")));
    renderDashboard();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("No se pudo contactar con el servidor");

    const api = installProjectsApi([makeProject(1)]);
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));

    expect(await screen.findByRole("button", { name: "Proyecto 01" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(api.listCalls()).toHaveLength(1);
  });

  it("un error de la API muestra un mensaje DISTINTO al de red, con el código", async () => {
    installProjectsApi([], (call) =>
      call.method === "GET" ? jsonResponse({ code: "internal_error", message: "Boom" }, 500) : undefined,
    );
    renderDashboard();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("El servidor respondió con un error (código 500)");
    expect(alert).not.toHaveTextContent("No se pudo contactar");
    expect(screen.getByRole("button", { name: "Reintentar" })).toBeInTheDocument();
  });

  it("pide la primera página con page=1, pageSize=12 y orden LastModified", async () => {
    const api = installProjectsApi([makeProject(1)]);
    renderDashboard();
    await screen.findByRole("button", { name: "Proyecto 01" });

    const [first] = api.listCalls();
    expect(first.search.get("page")).toBe("1");
    expect(first.search.get("pageSize")).toBe("12");
    expect(first.search.get("sortBy")).toBe("LastModified");
    expect(first.search.has("search")).toBe(false);
  });
});

describe("ProjectsDashboard — thumbnails", () => {
  it("sin thumbnail (null) muestra un placeholder visible", async () => {
    installProjectsApi([makeProject(1, { thumbnailUrl: null })]);
    renderDashboard();

    await screen.findByRole("button", { name: "Proyecto 01" });

    expect(within(cardOf("Proyecto 01")).getByRole("img", { name: "Sin vista previa de Proyecto 01" })).toBeInTheDocument();
    expect(within(cardOf("Proyecto 01")).queryByAltText("Vista previa de Proyecto 01")).not.toBeInTheDocument();
  });

  it("con thumbnail muestra la imagen con la URL de la API resuelta, dimensiones explícitas y lazy", async () => {
    installProjectsApi([makeProject(1, { thumbnailUrl: "/api/v2/projects/abc/assets/def" })]);
    renderDashboard();

    const image = await screen.findByAltText("Vista previa de Proyecto 01");

    expect(image.getAttribute("src")).toMatch(/\/api\/v2\/projects\/abc\/assets\/def$/);
    expect(image).toHaveAttribute("loading", "lazy");
    expect(image).toHaveAttribute("width");
    expect(image).toHaveAttribute("height");
  });

  it("un thumbnail que falla al cargar cae al placeholder", async () => {
    installProjectsApi([makeProject(1, { thumbnailUrl: "/api/v2/projects/abc/assets/roto" })]);
    renderDashboard();

    fireEvent.error(await screen.findByAltText("Vista previa de Proyecto 01"));

    expect(screen.queryByAltText("Vista previa de Proyecto 01")).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Sin vista previa de Proyecto 01" })).toBeInTheDocument();
  });
});

describe("ProjectsDashboard — paginación", () => {
  it("con 30 proyectos pagina de a 12 con anterior/siguiente y deshabilita los extremos", async () => {
    const projects = Array.from({ length: 30 }, (_, i) => makeProject(i + 1));
    const api = installProjectsApi(projects);
    renderDashboard();

    await screen.findByText("30 proyectos");
    expect(screen.getAllByRole("listitem")).toHaveLength(12);
    expect(screen.getByText("Página 1 de 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Anterior" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    await screen.findByText("Página 2 de 3");
    expect(api.listCalls().at(-1)?.search.get("page")).toBe("2");

    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    await screen.findByText("Página 3 de 3");
    expect(screen.getAllByRole("listitem")).toHaveLength(6);
    expect(screen.getByRole("button", { name: "Siguiente" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Anterior" }));
    await screen.findByText("Página 2 de 3");
  });

  it("con una sola página no muestra controles de paginación", async () => {
    installProjectsApi([makeProject(1), makeProject(2)]);
    renderDashboard();
    await screen.findByText("2 proyectos");

    expect(screen.queryByRole("navigation", { name: "Paginación" })).not.toBeInTheDocument();
  });
});

describe("ProjectsDashboard — búsqueda y orden", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  async function flush() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  it("la búsqueda tiene debounce de 300 ms y manda un solo pedido con el término final", async () => {
    const api = installProjectsApi([makeProject(1, { name: "Llavero" }), makeProject(2, { name: "Placa" })]);
    renderDashboard();
    await flush();
    expect(api.listCalls()).toHaveLength(1);

    const input = screen.getByRole("searchbox", { name: "Buscar proyectos" });
    fireEvent.change(input, { target: { value: "lla" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 50);
    });
    fireEvent.change(input, { target: { value: "llav" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 50);
    });

    // Todavía no pasaron 300 ms desde la última tecla: ningún pedido nuevo.
    expect(api.listCalls()).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(api.listCalls()).toHaveLength(2);
    expect(api.listCalls().at(-1)?.search.get("search")).toBe("llav");
    expect(screen.getByRole("button", { name: "Llavero" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Placa" })).not.toBeInTheDocument();
  });

  it("buscar reinicia a la página 1", async () => {
    const projects = Array.from({ length: 30 }, (_, i) => makeProject(i + 1));
    const api = installProjectsApi(projects);
    renderDashboard();
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    await flush();
    expect(screen.getByText("Página 2 de 3")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "Buscar proyectos" }), { target: { value: "Proyecto 1" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    });

    const last = api.listCalls().at(-1);
    expect(last?.search.get("page")).toBe("1");
    expect(last?.search.get("search")).toBe("Proyecto 1");
  });

  it("sin resultados de búsqueda muestra un estado distinto del vacío, que ofrece limpiar el filtro", async () => {
    const api = installProjectsApi([makeProject(1, { name: "Llavero" })]);
    renderDashboard();
    await flush();

    fireEvent.change(screen.getByRole("searchbox", { name: "Buscar proyectos" }), { target: { value: "zzz" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    });

    expect(screen.getByText("Sin resultados")).toBeInTheDocument();
    expect(screen.getByText(/No encontramos proyectos que coincidan con «zzz»/)).toBeInTheDocument();
    expect(screen.queryByText("Todavía no tenés proyectos")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Crear proyecto" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Limpiar búsqueda" }));
    await flush();

    expect(screen.getByRole("button", { name: "Llavero" })).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Buscar proyectos" })).toHaveValue("");
    expect(api.listCalls().at(-1)?.search.has("search")).toBe(false);
  });

  it("cambiar el orden pide ese sortBy y vuelve a la página 1", async () => {
    const projects = Array.from({ length: 30 }, (_, i) => makeProject(i + 1));
    const api = installProjectsApi(projects);
    renderDashboard();
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    await flush();

    fireEvent.change(screen.getByRole("combobox", { name: "Ordenar por" }), { target: { value: "Name" } });
    await flush();

    let last = api.listCalls().at(-1);
    expect(last?.search.get("sortBy")).toBe("Name");
    expect(last?.search.get("page")).toBe("1");

    fireEvent.change(screen.getByRole("combobox", { name: "Ordenar por" }), { target: { value: "Created" } });
    await flush();

    last = api.listCalls().at(-1);
    expect(last?.search.get("sortBy")).toBe("Created");
  });

  it("una respuesta vieja abortada por una búsqueda nueva no pisa la nueva", async () => {
    let releaseSlow: (() => void) | undefined;
    const api = installProjectsApi(
      [makeProject(1, { name: "Alfa" }), makeProject(2, { name: "Beta" })],
      (call) => {
        if (call.method === "GET" && call.search.get("search") === "alf") {
          return new Promise<Response>((resolve) => {
            releaseSlow = () => resolve(jsonResponse({ items: [makeProject(1, { name: "Alfa" })], page: 1, pageSize: 12, totalCount: 1 }));
          });
        }
        return undefined;
      },
    );
    renderDashboard();
    await flush();

    const input = screen.getByRole("searchbox", { name: "Buscar proyectos" });
    fireEvent.change(input, { target: { value: "alf" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    });
    fireEvent.change(input, { target: { value: "bet" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    });

    expect(screen.getByRole("button", { name: "Beta" })).toBeInTheDocument();

    // La respuesta de "alf" llega tarde (su fetch fue abortado): no debe reemplazar la de "bet".
    await act(async () => {
      releaseSlow?.();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByRole("button", { name: "Beta" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Alfa" })).not.toBeInTheDocument();
    expect(api.listCalls().at(-1)?.search.get("search")).toBe("bet");
  });
});

describe("ProjectsDashboard — Open", () => {
  it("con triple clásico navega al Workspace con savedProjectId", async () => {
    const project = makeProject(1);
    installProjectsApi([project]);
    const { onOpenProject } = renderDashboard();

    fireEvent.click(await screen.findByRole("button", { name: "Proyecto 01" }));

    expect(onOpenProject).toHaveBeenCalledWith({
      projectId: project.classicProjectId,
      imageId: project.classicImageId,
      paletteId: project.classicPaletteId,
      savedProjectId: project.id,
    });
  });

  it("click en la card (fuera del nombre) también abre", async () => {
    installProjectsApi([makeProject(1)]);
    const { onOpenProject } = renderDashboard();
    await screen.findByRole("button", { name: "Proyecto 01" });

    fireEvent.click(cardOf("Proyecto 01").querySelector(".project-card__thumbnail")!);

    expect(onOpenProject).toHaveBeenCalledTimes(1);
  });

  it("'Abrir' del menú contextual abre el proyecto", async () => {
    installProjectsApi([makeProject(1)]);
    const { onOpenProject } = renderDashboard();
    await screen.findByRole("button", { name: "Proyecto 01" });

    chooseAction("Proyecto 01", "Abrir");

    expect(onOpenProject).toHaveBeenCalledTimes(1);
  });

  it("sin triple clásico muestra un error controlado y NO navega", async () => {
    installProjectsApi([makeProject(1, { classicProjectId: null, classicImageId: null, classicPaletteId: null })]);
    const { onOpenProject } = renderDashboard();

    fireEvent.click(await screen.findByRole("button", { name: "Proyecto 01" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Este proyecto no se puede reabrir");
    expect(onOpenProject).not.toHaveBeenCalled();
  });

  it("un triple incompleto (falta paletteId) tampoco navega", async () => {
    installProjectsApi([makeProject(1, { classicPaletteId: null })]);
    const { onOpenProject } = renderDashboard();

    fireEvent.click(await screen.findByRole("button", { name: "Proyecto 01" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("no se puede reabrir");
    expect(onOpenProject).not.toHaveBeenCalled();
  });
});

describe("ProjectsDashboard — Rename", () => {
  it("renombra, cierra el diálogo, avisa y refresca la lista", async () => {
    const api = installProjectsApi([makeProject(1)]);
    renderDashboard();
    await screen.findByRole("button", { name: "Proyecto 01" });

    chooseAction("Proyecto 01", "Renombrar");
    const dialog = screen.getByRole("dialog", { name: "Renombrar proyecto" });
    const input = within(dialog).getByLabelText("Nombre del proyecto");
    expect(input).toHaveValue("Proyecto 01");
    expect(input).toHaveFocus();

    fireEvent.change(input, { target: { value: "  Nombre nuevo  " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Guardar" }));

    expect(await screen.findByRole("button", { name: "Nombre nuevo" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Aviso" })).toHaveTextContent("Proyecto renombrado a «Nombre nuevo».");
    expect(api.callsOf("PATCH")[0].body).toEqual({ name: "Nombre nuevo" });
    expect(api.listCalls()).toHaveLength(2);
  });

  it("valida nombre vacío del lado cliente: no manda ningún pedido", async () => {
    const api = installProjectsApi([makeProject(1)]);
    renderDashboard();
    await screen.findByRole("button", { name: "Proyecto 01" });

    chooseAction("Proyecto 01", "Renombrar");
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Nombre del proyecto"), { target: { value: "   " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Guardar" }));

    expect(within(dialog).getByRole("alert")).toHaveTextContent("El nombre no puede estar vacío.");
    expect(within(dialog).getByLabelText("Nombre del proyecto")).toHaveAttribute("aria-invalid", "true");
    expect(api.callsOf("PATCH")).toHaveLength(0);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("muestra el error 400 del servidor dentro del diálogo y lo deja abierto para corregir", async () => {
    installProjectsApi([makeProject(1)], (call) =>
      call.method === "PATCH"
        ? jsonResponse({ code: "invalid_name", message: "El nombre no puede superar los 200 caracteres." }, 400)
        : undefined,
    );
    renderDashboard();
    await screen.findByRole("button", { name: "Proyecto 01" });

    chooseAction("Proyecto 01", "Renombrar");
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Nombre del proyecto"), { target: { value: "x" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Guardar" }));

    expect(await within(dialog).findByText("El nombre no puede superar los 200 caracteres.")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Guardar" })).toBeEnabled();
  });

  it("404 (borrado en otra pestaña): cierra el diálogo, avisa y refresca la lista", async () => {
    const api = installProjectsApi([makeProject(1)], (call) =>
      call.method === "PATCH" ? jsonResponse({ code: "not_found", message: "No existe." }, 404) : undefined,
    );
    renderDashboard();
    await screen.findByRole("button", { name: "Proyecto 01" });

    chooseAction("Proyecto 01", "Renombrar");
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Nombre del proyecto"), { target: { value: "Otro" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Guardar" }));

    expect(await screen.findByRole("alert", { name: "Error" })).toHaveTextContent("ya no existe");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(api.listCalls()).toHaveLength(2));
  });

  it("409 (conflicto xmin): cierra el diálogo, avisa con claridad y refresca la lista", async () => {
    const api = installProjectsApi([makeProject(1)], (call) =>
      call.method === "PATCH" ? jsonResponse({ code: "concurrency_conflict", message: "Conflicto." }, 409) : undefined,
    );
    renderDashboard();
    await screen.findByRole("button", { name: "Proyecto 01" });

    chooseAction("Proyecto 01", "Renombrar");
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Nombre del proyecto"), { target: { value: "Otro" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Guardar" }));

    expect(await screen.findByRole("alert", { name: "Error" })).toHaveTextContent("se modificó desde otra pestaña");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(api.listCalls()).toHaveLength(2));
  });

  it("un fallo de red al renombrar deja el diálogo abierto con un mensaje de conexión", async () => {
    installProjectsApi([makeProject(1)], (call) => {
      if (call.method === "PATCH") throw new TypeError("Failed to fetch");
      return undefined;
    });
    renderDashboard();
    await screen.findByRole("button", { name: "Proyecto 01" });

    chooseAction("Proyecto 01", "Renombrar");
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Nombre del proyecto"), { target: { value: "Otro" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Guardar" }));

    expect(await within(dialog).findByText(/No se pudo contactar con el servidor/)).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("si el nombre no cambió, cierra sin pedir nada al servidor", async () => {
    const api = installProjectsApi([makeProject(1)]);
    renderDashboard();
    await screen.findByRole("button", { name: "Proyecto 01" });

    chooseAction("Proyecto 01", "Renombrar");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Guardar" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.callsOf("PATCH")).toHaveLength(0);
  });
});

describe("ProjectsDashboard — Duplicate", () => {
  it("la copia aparece en la lista (refresco con los mismos filtros) y muestra feedback de éxito", async () => {
    const api = installProjectsApi([makeProject(1, { name: "Llavero" })]);
    renderDashboard();
    await screen.findByRole("button", { name: "Llavero" });

    chooseAction("Llavero", "Duplicar");

    expect(await screen.findByRole("button", { name: "Copia de Llavero" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Aviso" })).toHaveTextContent("Se creó la copia «Copia de Llavero».");
    expect(api.callsOf("POST")).toHaveLength(1);
    expect(api.listCalls().at(-1)?.search.get("sortBy")).toBe("LastModified");
    expect(api.listCalls().at(-1)?.search.get("page")).toBe("1");
  });

  it("el ítem 'Duplicar' queda deshabilitado en vuelo: un segundo intento no crea otra copia", async () => {
    let release: (() => void) | undefined;
    const api = installProjectsApi([makeProject(1, { name: "Llavero" })], (call) => {
      if (call.method === "POST") {
        return new Promise<Response>((resolve) => {
          release = () =>
            resolve(
              jsonResponse(
                { id: "copy", ownerId: "o", name: "Copia de Llavero", description: null, thumbnailAssetId: null, currentVersionId: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", classicProjectId: null, classicImageId: null, classicPaletteId: null },
                201,
              ),
            );
        });
      }
      return undefined;
    });
    renderDashboard();
    await screen.findByRole("button", { name: "Llavero" });

    chooseAction("Llavero", "Duplicar");
    openMenuOf("Llavero");
    const item = screen.getByRole("menuitem", { name: "Duplicar" });
    expect(item).toBeDisabled();
    fireEvent.click(item);

    expect(api.callsOf("POST")).toHaveLength(1);

    await act(async () => {
      release?.();
    });
    await waitFor(() => expect(screen.getByRole("status", { name: "Aviso" })).toBeInTheDocument());
    expect(api.callsOf("POST")).toHaveLength(1);
  });

  it("404 al duplicar (origen borrado en otra pestaña): avisa y refresca", async () => {
    const api = installProjectsApi([makeProject(1)], (call) =>
      call.method === "POST" ? jsonResponse({ code: "not_found", message: "No existe." }, 404) : undefined,
    );
    renderDashboard();
    await screen.findByRole("button", { name: "Proyecto 01" });

    chooseAction("Proyecto 01", "Duplicar");

    expect(await screen.findByRole("alert", { name: "Error" })).toHaveTextContent("ya no existe");
    await waitFor(() => expect(api.listCalls()).toHaveLength(2));
  });

  it("un error del servidor al duplicar muestra un aviso de error y no refresca", async () => {
    const api = installProjectsApi([makeProject(1)], (call) =>
      call.method === "POST" ? jsonResponse({ code: "internal_error", message: "x" }, 500) : undefined,
    );
    renderDashboard();
    await screen.findByRole("button", { name: "Proyecto 01" });

    chooseAction("Proyecto 01", "Duplicar");

    expect(await screen.findByRole("alert", { name: "Error" })).toHaveTextContent("No se pudo duplicar «Proyecto 01»");
    expect(api.listCalls()).toHaveLength(1);
    // Terminó: el ítem vuelve a estar habilitado.
    openMenuOf("Proyecto 01");
    expect(screen.getByRole("menuitem", { name: "Duplicar" })).toBeEnabled();
  });
});

describe("ProjectsDashboard — Delete", () => {
  it("pide confirmación con un diálogo propio que nombra el proyecto (nunca window.confirm)", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    const api = installProjectsApi([makeProject(1, { name: "Llavero" })]);
    renderDashboard();
    await screen.findByRole("button", { name: "Llavero" });

    chooseAction("Llavero", "Eliminar");

    const dialog = screen.getByRole("alertdialog", { name: "Eliminar proyecto" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleDescription(/Llavero/);
    expect(within(dialog).getByRole("button", { name: "Cancelar" })).toHaveFocus();
    expect(api.callsOf("DELETE")).toHaveLength(0);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("confirmar elimina, avisa y la lista queda vacía (empty state)", async () => {
    const api = installProjectsApi([makeProject(1, { name: "Llavero" })]);
    renderDashboard();
    await screen.findByRole("button", { name: "Llavero" });

    chooseAction("Llavero", "Eliminar");
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Eliminar" }));

    expect(await screen.findByText("Todavía no tenés proyectos")).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Aviso" })).toHaveTextContent("Se eliminó «Llavero».");
    expect(api.callsOf("DELETE")).toHaveLength(1);
  });

  it("cancelar no borra nada y devuelve el foco al disparador del menú", async () => {
    const api = installProjectsApi([makeProject(1, { name: "Llavero" })]);
    renderDashboard();
    await screen.findByRole("button", { name: "Llavero" });

    chooseAction("Llavero", "Eliminar");
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancelar" }));

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(api.callsOf("DELETE")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Llavero" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Acciones de Llavero" })).toHaveFocus();
  });

  it("Escape cierra el diálogo de confirmación sin borrar", async () => {
    const api = installProjectsApi([makeProject(1)]);
    renderDashboard();
    await screen.findByRole("button", { name: "Proyecto 01" });

    chooseAction("Proyecto 01", "Eliminar");
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(api.callsOf("DELETE")).toHaveLength(0);
  });

  it("Tab queda atrapado dentro del diálogo", async () => {
    installProjectsApi([makeProject(1)]);
    renderDashboard();
    await screen.findByRole("button", { name: "Proyecto 01" });

    chooseAction("Proyecto 01", "Eliminar");
    const dialog = screen.getByRole("alertdialog");
    const confirm = within(dialog).getByRole("button", { name: "Eliminar" });
    confirm.focus();

    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(within(dialog).getByRole("button", { name: "Cancelar" })).toHaveFocus();

    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(confirm).toHaveFocus();
  });

  it("si borrar deja vacía una página que no es la 1, retrocede una página", async () => {
    // 13 proyectos: la página 2 tiene exactamente uno (Proyecto 01, el más viejo por LastModified).
    const projects = Array.from({ length: 13 }, (_, i) => makeProject(i + 1));
    const api = installProjectsApi(projects);
    renderDashboard();
    await screen.findByText("13 proyectos");

    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    await screen.findByText("Página 2 de 2");
    expect(screen.getAllByRole("listitem")).toHaveLength(1);

    chooseAction("Proyecto 01", "Eliminar");
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Eliminar" }));

    await screen.findByText("12 proyectos");
    expect(screen.queryByText(/Página 2/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(12);
    expect(api.listCalls().at(-1)?.search.get("page")).toBe("1");
  });

  it("404 al eliminar (ya borrado en otra pestaña) se trata como borrado y refresca", async () => {
    installProjectsApi([makeProject(1, { name: "Llavero" })], (call) =>
      call.method === "DELETE" ? jsonResponse({ code: "not_found", message: "No existe." }, 404) : undefined,
    );
    renderDashboard();
    await screen.findByRole("button", { name: "Llavero" });

    chooseAction("Llavero", "Eliminar");
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Eliminar" }));

    expect(await screen.findByRole("status", { name: "Aviso" })).toHaveTextContent("ya había sido eliminado");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("un error del servidor al eliminar deja el diálogo abierto con el mensaje", async () => {
    installProjectsApi([makeProject(1)], (call) =>
      call.method === "DELETE" ? jsonResponse({ code: "internal_error", message: "x" }, 500) : undefined,
    );
    renderDashboard();
    await screen.findByRole("button", { name: "Proyecto 01" });

    chooseAction("Proyecto 01", "Eliminar");
    const dialog = screen.getByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Eliminar" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("código 500");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Eliminar" })).toBeEnabled();
  });
});

describe("ProjectsDashboard — menú contextual (teclado y aria)", () => {
  it("el disparador expone aria-haspopup/expanded/controls y el menú sus ítems", async () => {
    installProjectsApi([makeProject(1)]);
    renderDashboard();
    await screen.findByRole("button", { name: "Proyecto 01" });

    const trigger = screen.getByRole("button", { name: "Acciones de Proyecto 01" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const menu = screen.getByRole("menu", { name: "Acciones de Proyecto 01" });
    expect(trigger).toHaveAttribute("aria-controls", menu.id);
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Abrir",
      "Renombrar",
      "Duplicar",
      "Eliminar",
    ]);
    expect(screen.getByRole("menuitem", { name: "Abrir" })).toHaveFocus();
  });

  it("flechas, Home y End navegan; Escape cierra y devuelve el foco al disparador", async () => {
    installProjectsApi([makeProject(1)]);
    renderDashboard();
    await screen.findByRole("button", { name: "Proyecto 01" });

    const trigger = screen.getByRole("button", { name: "Acciones de Proyecto 01" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const menu = screen.getByRole("menu");
    expect(screen.getByRole("menuitem", { name: "Abrir" })).toHaveFocus();

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Renombrar" })).toHaveFocus();

    fireEvent.keyDown(menu, { key: "End" });
    expect(screen.getByRole("menuitem", { name: "Eliminar" })).toHaveFocus();

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Abrir" })).toHaveFocus();

    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(screen.getByRole("menuitem", { name: "Eliminar" })).toHaveFocus();

    fireEvent.keyDown(menu, { key: "Home" });
    expect(screen.getByRole("menuitem", { name: "Abrir" })).toHaveFocus();

    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("un click fuera del menú lo cierra", async () => {
    installProjectsApi([makeProject(1)]);
    renderDashboard();
    await screen.findByRole("button", { name: "Proyecto 01" });

    openMenuOf("Proyecto 01");
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.mouseDown(document.body);

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("elegir una acción por teclado (Enter sobre el ítem) la dispara", async () => {
    installProjectsApi([makeProject(1)]);
    renderDashboard();
    await screen.findByRole("button", { name: "Proyecto 01" });

    openMenuOf("Proyecto 01");
    // Un <button> real: Enter/Space producen un click nativo; acá se simula ese click.
    fireEvent.click(screen.getByRole("menuitem", { name: "Renombrar" }));

    expect(screen.getByRole("dialog", { name: "Renombrar proyecto" })).toBeInTheDocument();
  });
});

describe("ProjectsDashboard — Grid / List", () => {
  it("arranca en Grid, alterna a List y persiste la preferencia", async () => {
    installProjectsApi([makeProject(1)]);
    renderDashboard();
    await screen.findByRole("button", { name: "Proyecto 01" });

    const grid = screen.getByRole("button", { name: "Grid" });
    const list = screen.getByRole("button", { name: "List" });
    expect(grid).toHaveAttribute("aria-pressed", "true");
    expect(list).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("list", { name: "Proyectos" })).toHaveClass("projects-list--grid");

    fireEvent.click(list);

    expect(list).toHaveAttribute("aria-pressed", "true");
    expect(grid).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("list", { name: "Proyectos" })).toHaveClass("projects-list--list");
    expect(window.localStorage.getItem(VIEW_STORAGE_KEY)).toBe("list");
  });

  it("restaura la preferencia guardada al montar", async () => {
    window.localStorage.setItem(VIEW_STORAGE_KEY, "list");
    installProjectsApi([makeProject(1)]);
    renderDashboard();
    await screen.findByRole("button", { name: "Proyecto 01" });

    expect(screen.getByRole("list", { name: "Proyectos" })).toHaveClass("projects-list--list");
    expect(screen.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
  });

  it("si localStorage lanza (bloqueado), la pantalla funciona igual con el default Grid", async () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    installProjectsApi([makeProject(1)]);
    renderDashboard();
    await screen.findByRole("button", { name: "Proyecto 01" });

    expect(screen.getByRole("list", { name: "Proyectos" })).toHaveClass("projects-list--grid");
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(screen.getByRole("list", { name: "Proyectos" })).toHaveClass("projects-list--list");

    getItem.mockRestore();
    setItem.mockRestore();
  });
});

describe("ProjectsDashboard — avisos de App", () => {
  it("renderiza los avisos recibidos (deep-link inválido, recuperación) arriba de la lista", async () => {
    installProjectsApi([]);
    render(
      <ProjectsDashboard
        onNewProject={vi.fn()}
        onOpenProject={vi.fn()}
        notices={<div role="alert">Aviso externo</div>}
      />,
    );

    expect(screen.getByText("Aviso externo")).toBeInTheDocument();
    await screen.findByText("Todavía no tenés proyectos");
  });
});
