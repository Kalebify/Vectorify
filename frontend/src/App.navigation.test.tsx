import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { installProjectsApi, jsonResponse, makeProject, type RequestOverride } from "./components/projects/projectsTestSupport";
import { saveWorkspaceRecoveryPointer } from "./lib/workspaceRecovery";

/**
 * M2.2-S08: navegación entre vistas de `App` -- default = dashboard "Mis proyectos", `?view=new` =
 * flujo clásico de upload, params de Workspace = Workspace, y cierre del Workspace según tenga o
 * no `savedProjectId`. `EditorShell` se mockea con un stub mínimo (su comportamiento interno ya
 * tiene sus propios tests): acá el foco es la orquestación de vistas/URL de App.tsx.
 */

vi.mock("./components/editor/EditorShell", () => ({
  EditorShell: ({
    savedProjectId,
    onClose,
    onSaved,
  }: {
    savedProjectId: string | null;
    onClose: () => void;
    onSaved?: (id: string) => void;
  }) => (
    <div role="application" aria-label="Workspace de prueba" data-saved-project-id={savedProjectId ?? ""}>
      <button type="button" onClick={onClose}>
        Cerrar Workspace
      </button>
      <button type="button" onClick={() => onSaved?.("55555555-5555-5555-5555-555555555555")}>
        Simular guardado
      </button>
    </div>
  ),
}));

const IMAGE_ID_PATTERN = /\/api\/v1\/projects\/([^/]+)\/images\/([^/]+)$/;

function healthResponse(): Response {
  return jsonResponse({
    status: "online",
    timestamp: new Date().toISOString(),
    api: { status: "online" },
    python: { status: "online", service: "vectorify-python-engine", version: "0.1.0", message: null },
  });
}

/** Backend v2 de juguete + health + metadata clásica + documento v2 + paleta clásica. */
function installBackend(
  projects = [makeProject(1, { name: "Llavero" })],
  options: { documentStatus?: number } = {},
) {
  const classicOverride: RequestOverride = (call) => {
    if (/\/system\/health$/.test(call.path)) return healthResponse();

    const imageMatch = IMAGE_ID_PATTERN.exec(call.path);
    if (imageMatch) {
      return jsonResponse({
        projectId: imageMatch[1],
        imageId: imageMatch[2],
        filename: "logo.png",
        mimeType: "image/png",
        bytes: 4096,
        width: 320,
        height: 240,
        status: "uploaded",
      });
    }

    if (/^\/api\/v2\/projects\/[^/]+\/document$/.test(call.path)) {
      return options.documentStatus && options.documentStatus !== 200
        ? jsonResponse({ code: "not_found", message: "No existe." }, options.documentStatus)
        : jsonResponse({ layers: [] });
    }

    if (/\/color-palette\/[^/]+$/.test(call.path)) {
      return jsonResponse({
        projectId: "p",
        imageId: "i",
        paletteId: "pal",
        version: 1,
        tolerance: 24,
        maxColors: null,
        tinyAreaRatio: 0.01,
        sourceWidthPx: 320,
        sourceHeightPx: 240,
        transparentPercent: 0,
        groups: [],
        previewUrl: "/preview",
        isConfirmed: true,
        cached: false,
      });
    }

    return undefined;
  };

  return installProjectsApi(projects, classicOverride);
}

beforeEach(() => {
  window.history.pushState({}, "", "/");
  window.localStorage.clear();
});

afterEach(() => {
  window.history.pushState({}, "", "/");
  window.localStorage.clear();
});

describe("App — vista por defecto y navegación (M2.2-S08)", () => {
  it("sin params la home es el dashboard 'Mis proyectos', no el flujo de upload", async () => {
    const api = installBackend();
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Mis proyectos" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Llavero" })).toBeInTheDocument();
    expect(screen.queryByText("Nuevo proyecto")).not.toBeInTheDocument();
    expect(api.listCalls().length).toBeGreaterThan(0);
  });

  it("?view=new muestra el flujo clásico de upload con los estados del sistema y un enlace a Mis proyectos", async () => {
    window.history.pushState({}, "", "/?view=new");
    const api = installBackend();
    render(<App />);

    expect(screen.getByRole("heading", { name: "Nuevo proyecto" })).toBeInTheDocument();
    expect(await screen.findByText("Todos los servicios están en línea.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Mis proyectos" })).toBeInTheDocument();
    // No carga el listado de proyectos en esta vista.
    expect(api.listCalls()).toHaveLength(0);
  });

  it("el enlace 'Mis proyectos' del flujo clásico vuelve al dashboard y limpia la URL", async () => {
    window.history.pushState({}, "", "/?view=new");
    installBackend();
    render(<App />);

    fireEvent.click(screen.getByRole("link", { name: "Mis proyectos" }));

    expect(await screen.findByRole("heading", { name: "Mis proyectos" })).toBeInTheDocument();
    expect(window.location.search).toBe("");
    expect(screen.queryByRole("heading", { name: "Nuevo proyecto" })).not.toBeInTheDocument();
  });

  it("'New Project' lleva a ?view=new (flujo clásico de upload)", async () => {
    installBackend();
    render(<App />);
    await screen.findByRole("button", { name: "Llavero" });

    fireEvent.click(screen.getByRole("button", { name: "New Project" }));

    expect(await screen.findByRole("heading", { name: "Nuevo proyecto" })).toBeInTheDocument();
    expect(window.location.search).toBe("?view=new");
  });

  it("la CTA 'Crear proyecto' del empty state también lleva a ?view=new", async () => {
    installBackend([]);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Crear proyecto" }));

    expect(await screen.findByRole("heading", { name: "Nuevo proyecto" })).toBeInTheDocument();
    expect(window.location.search).toBe("?view=new");
  });

  it("el botón atrás del navegador vuelve del flujo de upload al dashboard", async () => {
    installBackend();
    render(<App />);
    await screen.findByRole("button", { name: "Llavero" });
    fireEvent.click(screen.getByRole("button", { name: "New Project" }));
    await screen.findByRole("heading", { name: "Nuevo proyecto" });

    act(() => {
      window.history.back();
    });

    expect(await screen.findByRole("heading", { name: "Mis proyectos" })).toBeInTheDocument();
    expect(window.location.search).toBe("");
  });
});

describe("App — abrir y cerrar el Workspace desde Mis proyectos (M2.2-S08)", () => {
  it("Open con triple clásico: actualiza la URL con savedProjectId, reusa el deep-link y abre el Workspace", async () => {
    const project = makeProject(1, { name: "Llavero" });
    installBackend([project]);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Llavero" }));

    expect(await screen.findByRole("application", { name: "Workspace de prueba" })).toHaveAttribute(
      "data-saved-project-id",
      project.id,
    );
    expect(window.location.search).toContain(`projectId=${project.classicProjectId}`);
    expect(window.location.search).toContain(`imageId=${project.classicImageId}`);
    expect(window.location.search).toContain(`paletteId=${project.classicPaletteId}`);
    expect(window.location.search).toContain(`savedProjectId=${project.id}`);
  });

  it("Open sin triple clásico: error controlado, sin navegar a un deep-link inválido", async () => {
    installBackend([makeProject(1, { name: "Viejo", classicProjectId: null, classicImageId: null, classicPaletteId: null })]);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Viejo" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Este proyecto no se puede reabrir");
    expect(screen.queryByRole("application")).not.toBeInTheDocument();
    expect(window.location.search).toBe("");
  });

  it("cerrar un Workspace con savedProjectId vuelve al dashboard (y vuelve a cargar la lista)", async () => {
    const api = installBackend();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Llavero" }));
    await screen.findByRole("application", { name: "Workspace de prueba" });
    const listCallsBeforeClose = api.listCalls().length;

    fireEvent.click(screen.getByRole("button", { name: "Cerrar Workspace" }));

    expect(await screen.findByRole("heading", { name: "Mis proyectos" })).toBeInTheDocument();
    expect(window.location.search).toBe("");
    expect(screen.queryByRole("application")).not.toBeInTheDocument();
    await waitFor(() => expect(api.listCalls().length).toBeGreaterThan(listCallsBeforeClose));
  });

  it("cerrar un Workspace SIN savedProjectId (staging) vuelve al flujo ?view=new", async () => {
    installBackend();
    window.history.pushState({}, "", "/?projectId=p1&imageId=i1&paletteId=pal1");
    render(<App />);

    const workspace = await screen.findByRole("application", { name: "Workspace de prueba" });
    expect(workspace).toHaveAttribute("data-saved-project-id", "");

    fireEvent.click(screen.getByRole("button", { name: "Cerrar Workspace" }));

    expect(await screen.findByRole("heading", { name: "Nuevo proyecto" })).toBeInTheDocument();
    expect(window.location.search).toBe("?view=new");
  });

  it("guardar en el Workspace (primer Save) y cerrar lleva al dashboard", async () => {
    installBackend();
    window.history.pushState({}, "", "/?projectId=p1&imageId=i1&paletteId=pal1");
    render(<App />);
    await screen.findByRole("application", { name: "Workspace de prueba" });

    fireEvent.click(screen.getByRole("button", { name: "Simular guardado" }));
    expect(window.location.search).toContain("savedProjectId=55555555-5555-5555-5555-555555555555");

    fireEvent.click(screen.getByRole("button", { name: "Cerrar Workspace" }));

    expect(await screen.findByRole("heading", { name: "Mis proyectos" })).toBeInTheDocument();
    expect(window.location.search).toBe("");
  });

  it("si el documento guardado ya no existe, Open aterriza en el dashboard con el aviso de deep-link inválido", async () => {
    installBackend([makeProject(1, { name: "Llavero" })], { documentStatus: 404 });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Llavero" }));

    const banner = await screen.findByRole("alert", { name: "Enlace del Workspace inválido" });
    expect(banner).toHaveTextContent("El documento guardado de esta URL ya no existe.");
    expect(screen.getByRole("heading", { name: "Mis proyectos" })).toBeInTheDocument();
    expect(window.location.search).toBe("");
  });
});

describe("App — avisos de recuperación (M2.2-S08)", () => {
  it("'Continuar donde quedaste' sigue alcanzable en el dashboard (la nueva home)", async () => {
    saveWorkspaceRecoveryPointer({
      classicProjectId: "p1",
      imageId: "i1",
      paletteId: "pal1",
      updatedAt: new Date().toISOString(),
    });
    installBackend();
    render(<App />);

    const banner = await screen.findByRole("status", { name: "Recuperar sesión del Workspace" });
    expect(banner).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Continuar donde quedaste" }));

    expect(await screen.findByRole("application", { name: "Workspace de prueba" })).toBeInTheDocument();
    expect(window.location.search).toContain("projectId=p1");
  });

  it("'Continuar donde quedaste' también aparece en ?view=new", async () => {
    saveWorkspaceRecoveryPointer({
      classicProjectId: "p1",
      imageId: "i1",
      paletteId: "pal1",
      updatedAt: new Date().toISOString(),
    });
    window.history.pushState({}, "", "/?view=new");
    installBackend();
    render(<App />);

    expect(await screen.findByRole("button", { name: "Continuar donde quedaste" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Nuevo proyecto" })).toBeInTheDocument();
  });
});
