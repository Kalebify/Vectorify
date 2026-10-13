import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VersionHistoryPanel } from "./VersionHistoryPanel";

const PROJECT_ID = "44444444-4444-4444-4444-444444444444";

const VERSIONS = [
  { versionNumber: 3, origin: "AUTOSAVE", createdAt: "2026-10-14T10:30:00Z", widthMm: 160, heightMm: 120.5, viewBox: "0 0 320 241", schemaVersion: 1 },
  { versionNumber: 2, origin: "MANUAL_EDIT", createdAt: "2026-10-14T10:00:00Z", widthMm: 160, heightMm: 120, viewBox: "0 0 320 240", schemaVersion: 1 },
  { versionNumber: 1, origin: "VECTORIZE", createdAt: "2026-10-14T09:00:00Z", widthMm: 160, heightMm: 120, viewBox: "0 0 320 240", schemaVersion: 1 },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

interface Calls {
  gets: string[];
  posts: string[];
}

function installFetch(handlers: { list?: () => Response | Promise<Response>; restore?: () => Response | Promise<Response> } = {}): Calls {
  const calls: Calls = { gets: [], posts: [] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if ((init?.method ?? "GET") === "POST") {
        calls.posts.push(url);
        return (handlers.restore ?? (() => jsonResponse({ projectId: PROJECT_ID, versionNumber: 4, savedAt: "2026-10-14T11:00:00Z" }, 201)))();
      }
      calls.gets.push(url);
      return (handlers.list ?? (() => jsonResponse(VERSIONS)))();
    }),
  );
  return calls;
}

const reload = vi.fn();

function renderPanel(props: Partial<React.ComponentProps<typeof VersionHistoryPanel>> = {}) {
  const onClose = vi.fn();
  const view = render(
    <StrictMode>
      <VersionHistoryPanel projectId={PROJECT_ID} currentVersionNumber={3} geometryDirty={false} onClose={onClose} {...props} />
    </StrictMode>,
  );
  return { ...view, onClose };
}

describe("VersionHistoryPanel (M3-S13)", () => {
  beforeEach(() => {
    reload.mockReset();
    vi.stubGlobal("location", { ...window.location, reload });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("carga las versiones al abrir (StrictMode incluido) y las lista con número, origen en español, fecha y tamaño; la actual va marcada y sin botón", async () => {
    const calls = installFetch();
    renderPanel();

    expect(screen.getByText("Cargando versiones…", { selector: "p" })).toBeInTheDocument();
    const list = await screen.findByRole("list", { name: "Lista de versiones" });
    const items = within(list).getAllByRole("listitem");

    expect(items).toHaveLength(3);
    expect(calls.gets.every((url) => url.endsWith(`/api/v2/projects/${PROJECT_ID}/versions`))).toBe(true);
    expect(items[0]).toHaveTextContent("v3");
    expect(items[0]).toHaveTextContent("(actual)");
    expect(items[0]).toHaveTextContent("Guardado automático");
    expect(items[0]).toHaveTextContent("160 × 120.5 mm");
    expect(items[1]).toHaveTextContent("Guardado manual");
    expect(items[2]).toHaveTextContent("Vectorización");
    expect(within(items[0]).queryByRole("button")).toBeNull(); // no se restaura la actual
    expect(within(items[1]).getByRole("button", { name: /Restaurar versión 2/ })).toBeEnabled();
  });

  it("estado vacío: avisa que todavía no hay versiones", async () => {
    installFetch({ list: () => jsonResponse([]) });
    renderPanel({ currentVersionNumber: null });

    expect(await screen.findByText("Este proyecto todavía no tiene versiones guardadas.")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Lista de versiones" })).toBeNull();
  });

  it("error de carga: mensaje con role=alert, sin lista", async () => {
    installFetch({ list: () => jsonResponse({ code: "internal_error", message: "Falló." }, 500) });
    renderPanel();

    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo cargar el historial de versiones");
    expect(screen.queryByRole("list", { name: "Lista de versiones" })).toBeNull();
  });

  it("restaurar: POST a /versions/{n}/restore, avisa antes y después, y recarga el documento", async () => {
    const calls = installFetch();
    const onBeforeRestore = vi.fn();
    const onRestored = vi.fn();
    renderPanel({ onBeforeRestore, onRestored });

    fireEvent.click(await screen.findByRole("button", { name: /Restaurar versión 2/ }));

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(calls.posts).toHaveLength(1);
    expect(calls.posts[0]).toMatch(new RegExp(`/api/v2/projects/${PROJECT_ID}/versions/2/restore$`));
    expect(onBeforeRestore).toHaveBeenCalledTimes(1);
    expect(onRestored).toHaveBeenCalledTimes(1);
    expect(onBeforeRestore.mock.invocationCallOrder[0]).toBeLessThan(onRestored.mock.invocationCallOrder[0]);
  });

  it("con cambios de geometría sin guardar pide confirmación; si el usuario cancela NO restaura ni toca el autosave", async () => {
    const calls = installFetch();
    const onBeforeRestore = vi.fn();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderPanel({ geometryDirty: true, onBeforeRestore });

    fireEvent.click(await screen.findByRole("button", { name: /Restaurar versión 2/ }));

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("sin guardar"));
    expect(calls.posts).toHaveLength(0);
    expect(onBeforeRestore).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it("con cambios sin guardar y confirmación aceptada, restaura", async () => {
    const calls = installFetch();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPanel({ geometryDirty: true });

    fireEvent.click(await screen.findByRole("button", { name: /Restaurar versión 1/ }));

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(calls.posts[0]).toMatch(/\/versions\/1\/restore$/);
    confirm.mockRestore();
  });

  it("sin cambios sin guardar NO pide confirmación", async () => {
    installFetch();
    const confirm = vi.spyOn(window, "confirm");
    renderPanel({ geometryDirty: false });

    fireEvent.click(await screen.findByRole("button", { name: /Restaurar versión 2/ }));

    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it("restauración fallida: muestra el error, NO recarga, no avisa 'restaurado' y se puede reintentar", async () => {
    installFetch({ restore: () => jsonResponse({ code: "not_found", message: "La versión ya no existe." }, 404) });
    const onRestored = vi.fn();
    renderPanel({ onRestored });

    fireEvent.click(await screen.findByRole("button", { name: /Restaurar versión 2/ }));

    expect(await screen.findByText("La versión ya no existe.")).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    expect(onRestored).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Restaurar versión 2/ })).toBeEnabled();
  });

  it("mientras restaura deshabilita el resto de botones de restaurar", async () => {
    let release!: () => void;
    installFetch({
      restore: () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(jsonResponse({ projectId: PROJECT_ID, versionNumber: 4, savedAt: "2026-10-14T11:00:00Z" }, 201));
        }),
    });
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: /Restaurar versión 2/ }));

    await waitFor(() => expect(screen.getByRole("button", { name: /Restaurar versión 1/ })).toBeDisabled());
    expect(screen.getByRole("button", { name: /Restaurar versión 2/ })).toHaveTextContent("Restaurando…");
    release();
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it("anuncia la carga y la restauración en una región aria-live", async () => {
    installFetch();
    const { container } = renderPanel();

    const live = container.querySelector('[aria-live="polite"]')!;
    expect(live).toHaveTextContent("Cargando versiones…");
    await screen.findByRole("list", { name: "Lista de versiones" });
    expect(live).toHaveTextContent("");
  });

  it("Escape y el botón × cierran el panel", async () => {
    installFetch();
    const { onClose } = renderPanel();
    await screen.findByRole("list", { name: "Lista de versiones" });

    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Cerrar historial de versiones" }));

    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
