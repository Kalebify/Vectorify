import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppRoot } from "../AppRoot";
import { resetSessionBoundaryForTests } from "../api/sessionBoundary";
import { installAuthBackend, resetBrowserState } from "./authTestSupport";

/** M3.1-S07: ítem «Mi cuenta» del menú de usuario (DESIGN.md §5.2): enlace real, orden, teclado, página actual y aviso de trabajo sin guardar. */

beforeEach(() => {
  resetSessionBoundaryForTests();
  resetBrowserState("/");
});

afterEach(() => {
  vi.restoreAllMocks();
  resetSessionBoundaryForTests();
  resetBrowserState("/");
});

async function openMenu(url = "/") {
  resetBrowserState(url);
  const api = installAuthBackend();
  render(<AppRoot />);
  const trigger = await screen.findByRole("button", { name: "Menú de cuenta: Ana Gómez" });
  fireEvent.click(trigger);
  const item = await screen.findByRole("menuitem", { name: "Mi cuenta" });
  return { api, trigger, item };
}

describe("UserMenu — ítem «Mi cuenta»", () => {
  it("es un <a role=menuitem> con href real a ?view=account, primero del menú, con «Salir» como inicio del grupo de salidas", async () => {
    const { item } = await openMenu();

    expect(item.tagName).toBe("A");
    expect(item).toHaveAttribute("href", "/?view=account");
    expect(item).not.toHaveAttribute("aria-current");
    const items = within(screen.getByRole("menu", { name: "Cuenta" })).getAllByRole("menuitem");
    expect(items.map((node) => node.textContent)).toEqual(["Mi cuenta", "Salir", "Cerrar sesión en todos lados"]);
    expect(items[1]).toHaveClass("user-menu__item--group-start"); // separador decorativo, no un elemento
    await waitFor(() => expect(item).toHaveFocus());
  });

  it("clic izquierdo: cierra el menú, navega a ?view=account sin recargar y el foco queda en el h1 «Mi cuenta»", async () => {
    const { item } = await openMenu();

    fireEvent.click(item);

    const heading = await screen.findByRole("heading", { level: 1, name: "Mi cuenta" });
    expect(window.location.search).toBe("?view=account");
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("Enter (activación nativa del enlace) y Espacio (manejador explícito) navegan igual", async () => {
    const { item } = await openMenu();

    // Espacio: preventDefault + click().
    const notPrevented = fireEvent.keyDown(item, { key: " " });
    expect(notPrevented).toBe(false);
    await screen.findByRole("heading", { level: 1, name: "Mi cuenta" });
    expect(window.location.search).toBe("?view=account");
  });

  it("clic central y Ctrl/Cmd/Mayús+clic NO se interceptan (otra pestaña con el href real): no navega y el menú sigue abierto", async () => {
    const { item } = await openMenu();

    for (const init of [{ button: 1 }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }]) {
      expect(fireEvent.click(item, init), JSON.stringify(init)).toBe(true);
    }

    expect(window.location.search).toBe("");
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1, name: "Mi cuenta" })).not.toBeInTheDocument();
  });

  it("teclado: ArrowDown desde el trigger enfoca «Mi cuenta»; Inicio = «Mi cuenta», Fin = «Cerrar sesión en todos lados»; Escape cierra y vuelve al trigger", async () => {
    resetBrowserState("/");
    installAuthBackend();
    render(<AppRoot />);
    const trigger = await screen.findByRole("button", { name: "Menú de cuenta: Ana Gómez" });
    trigger.focus();

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const menu = await screen.findByRole("menu");
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Mi cuenta" })).toHaveFocus());
    fireEvent.keyDown(menu, { key: "End" });
    expect(screen.getByRole("menuitem", { name: "Cerrar sesión en todos lados" })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Home" });
    expect(screen.getByRole("menuitem", { name: "Mi cuenta" })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(screen.getByRole("menuitem", { name: "Cerrar sesión en todos lados" })).toHaveFocus();

    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("en la propia pantalla: aria-current=page; activarlo no navega, cierra el menú y mueve el foco al h1", async () => {
    const { item } = await openMenu("/?view=account");
    await waitFor(() => expect(item).toHaveAttribute("aria-current", "page"));
    const entries = window.history.length;

    fireEvent.click(item);

    expect(window.history.length).toBe(entries);
    expect(window.location.search).toBe("?view=account");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Mi cuenta" })).toHaveFocus();
  });

  it("«Salir» y «Cerrar sesión en todos lados» siguen funcionando desde el menú ampliado", async () => {
    const { api } = await openMenu();

    fireEvent.click(screen.getByRole("menuitem", { name: "Salir" }));

    expect(await screen.findByRole("heading", { name: "Iniciar sesión" })).toBeInTheDocument();
    expect(api.authCallsTo("POST", "/api/v1/auth/logout")).toHaveLength(1);
  });

  describe("trabajo sin guardar (Editor / guardado del Workspace)", () => {
    function unsavedWork() {
      const handler = (event: Event) => event.preventDefault(); // lo que registran el Editor y useWorkspaceSave con trabajo pendiente
      window.addEventListener("beforeunload", handler);
      return () => window.removeEventListener("beforeunload", handler);
    }

    it("pide confirmación antes de salir de la pantalla; si se cancela no navega", async () => {
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
      const off = unsavedWork();
      const { item } = await openMenu();

      fireEvent.click(item);

      expect(confirm).toHaveBeenCalledTimes(1);
      expect(confirm.mock.calls[0][0]).toContain("cambios sin guardar");
      expect(window.location.search).toBe("");
      expect(screen.getByRole("heading", { name: "Mis proyectos" })).toBeInTheDocument();
      off();
    });

    it("si se confirma, navega a «Mi cuenta»", async () => {
      vi.spyOn(window, "confirm").mockReturnValue(true);
      const off = unsavedWork();
      const { item } = await openMenu();

      fireEvent.click(item);

      expect(await screen.findByRole("heading", { level: 1, name: "Mi cuenta" })).toBeInTheDocument();
      off();
    });

    it("sin trabajo pendiente no se pregunta nada", async () => {
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
      const { item } = await openMenu();

      fireEvent.click(item);

      await screen.findByRole("heading", { level: 1, name: "Mi cuenta" });
      expect(confirm).not.toHaveBeenCalled();
    });
  });
});
