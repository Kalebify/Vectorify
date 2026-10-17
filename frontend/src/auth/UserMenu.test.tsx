import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppRoot } from "../AppRoot";
import { resetSessionBoundaryForTests } from "../api/sessionBoundary";
import { jsonResponse } from "../components/projects/projectsTestSupport";
import { DEV_USER, deferred, installAuthBackend, networkFailure, resetBrowserState } from "./authTestSupport";

/** M3.1-S05: menú de cuenta (DESIGN.md §5.15, §5.16): patrón WAI-ARIA «menu button», estados de carga/error y variante Development. */

beforeEach(() => {
  resetSessionBoundaryForTests();
  resetBrowserState("/");
});

afterEach(() => {
  resetSessionBoundaryForTests();
  resetBrowserState("/");
});

async function renderMenu(options: Parameters<typeof installAuthBackend>[0] = {}) {
  const api = installAuthBackend(options);
  render(<AppRoot />);
  const trigger = await screen.findByRole("button", { name: "Menú de cuenta: Ana Gómez" });
  return { api, trigger };
}

describe("UserMenu — patrón menu button", () => {
  it("el trigger es un <button> con aria-haspopup/aria-expanded y nombre accesible que incluye el texto visible", async () => {
    const { trigger } = await renderMenu();

    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).not.toHaveAttribute("aria-controls");
    expect(trigger).toHaveTextContent("Ana Gómez");
    // La inicial y el caret son decorativos.
    expect(trigger.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThanOrEqual(2);
  });

  it("al abrir: role=menu con nombre «Cuenta», solo dos menuitem, aria-controls y el foco en el primero", async () => {
    const { trigger } = await renderMenu();

    fireEvent.click(trigger);

    const menu = await screen.findByRole("menu", { name: "Cuenta" });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Salir",
      "Cerrar sesión en todos lados",
    ]);
    expect(menu.children).toHaveLength(2); // nada más que menuitems dentro del menú
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveAttribute("aria-controls", menu.id);
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Salir" })).toHaveFocus());
  });

  it("teclado: ArrowDown abre; flechas/Inicio/Fin navegan en círculo; Escape cierra devolviendo el foco al trigger", async () => {
    const { trigger } = await renderMenu();
    trigger.focus();

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const first = await screen.findByRole("menuitem", { name: "Salir" });
    const second = screen.getByRole("menuitem", { name: "Cerrar sesión en todos lados" });
    const menu = screen.getByRole("menu");
    await waitFor(() => expect(first).toHaveFocus());

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(second).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(second).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Home" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(menu, { key: "End" });
    expect(second).toHaveFocus();

    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("Tab y el clic fuera cierran el menú", async () => {
    const { trigger } = await renderMenu();
    fireEvent.click(trigger);
    fireEvent.keyDown(await screen.findByRole("menu"), { key: "Tab" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    fireEvent.click(trigger);
    await screen.findByRole("menu");
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});

describe("UserMenu — «Salir»", () => {
  it("mientras sale: aria-busy y aria-disabled en el trigger, anuncio «Cerrando sesión…» y el menú no se reabre", async () => {
    const logoutGate = deferred();
    const { trigger, api } = await renderMenu({ logout: () => logoutGate.promise.then(() => new Response(null, { status: 204 })) });
    fireEvent.click(trigger);

    fireEvent.click(await screen.findByRole("menuitem", { name: "Salir" }));

    await waitFor(() => expect(trigger).toHaveAttribute("aria-busy", "true"));
    expect(trigger).toHaveAttribute("aria-disabled", "true");
    expect(trigger).toHaveFocus(); // el foco volvió al trigger antes de actuar
    expect(screen.getByText("Cerrando sesión…")).toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    logoutGate.resolve();
    await screen.findByRole("heading", { name: "Iniciar sesión" });
    expect(api.authCallsTo("POST", "/api/v1/auth/logout")).toHaveLength(1);
  });

  it.each([
    ["red caída", () => networkFailure(), "No pudimos cerrar la sesión: no hay conexión con el servidor. Intentá de nuevo."],
    ["5xx", () => jsonResponse({}, 503), "El servidor no pudo cerrar la sesión. Intentá de nuevo en unos minutos."],
  ])("%s: la sesión NO se da por cerrada, se muestra el aviso descartable y «Cerrar aviso» devuelve el foco al trigger", async (_label, respond, text) => {
    const { trigger } = await renderMenu({ logout: respond });
    fireEvent.click(trigger);

    fireEvent.click(await screen.findByRole("menuitem", { name: "Salir" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(text);
    expect(screen.queryByRole("heading", { name: "Iniciar sesión" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Mis proyectos" })).toBeInTheDocument();
    expect(trigger).not.toHaveAttribute("aria-busy");

    fireEvent.click(within(alert).getByRole("button", { name: "Cerrar aviso" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});

describe("UserMenu — diálogo «Cerrar sesión en todos lados»", () => {
  it("Escape cierra el diálogo sin cerrar sesión y el foco vuelve al trigger; el foco queda atrapado dentro", async () => {
    const { trigger, api } = await renderMenu();
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Cerrar sesión en todos lados" }));
    const dialog = await screen.findByRole("alertdialog");
    const cancel = within(dialog).getByRole("button", { name: "Cancelar" });
    const confirm = within(dialog).getByRole("button", { name: "Cerrar sesión en todos lados" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(cancel).toHaveFocus();

    // Tab atrapado: del último vuelve al primero y Shift+Tab del primero va al último.
    confirm.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(confirm).toHaveFocus();

    fireEvent.keyDown(dialog, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
    expect(api.authCallsTo("POST", "/api/v1/auth/logout-all")).toHaveLength(0);
  });

  it("mientras confirma, el botón queda en «Cerrando sesiones…» (aria-disabled) y Escape se ignora", async () => {
    const gate = deferred();
    const { trigger, api } = await renderMenu({
      logoutAll: () => gate.promise.then(() => new Response(null, { status: 204 })),
    });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Cerrar sesión en todos lados" }));
    const dialog = await screen.findByRole("alertdialog");

    fireEvent.click(within(dialog).getByRole("button", { name: "Cerrar sesión en todos lados" }));

    const busy = await within(dialog).findByRole("button", { name: "Cerrando sesiones…" });
    expect(busy).toHaveAttribute("aria-disabled", "true");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    fireEvent.click(busy);
    expect(api.authCallsTo("POST", "/api/v1/auth/logout-all")).toHaveLength(1);

    gate.resolve();
    await screen.findByRole("heading", { name: "Iniciar sesión" });
  });

  it("un 5xx deja el diálogo abierto con el error y los botones operativos", async () => {
    const { trigger } = await renderMenu({ logoutAll: () => jsonResponse({ code: "logout_incomplete", message: "x" }, 503) });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Cerrar sesión en todos lados" }));
    const dialog = await screen.findByRole("alertdialog");

    fireEvent.click(within(dialog).getByRole("button", { name: "Cerrar sesión en todos lados" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "El servidor no pudo cerrar las sesiones. Intentá de nuevo en unos minutos.",
    );
    expect(within(dialog).getByRole("button", { name: "Cancelar" })).toBeEnabled();
  });
});

describe("UserMenu — modo Development", () => {
  it("muestra la pastilla y el nombre, sin trigger, sin menú y sin «Salir»", async () => {
    installAuthBackend({ user: DEV_USER });
    render(<AppRoot />);

    expect(await screen.findByText("Modo desarrollo")).toBeInTheDocument();
    expect(screen.getByText("Dev User")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Menú de cuenta/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.queryByText("Salir")).not.toBeInTheDocument();
    expect(screen.queryByText(/Cerrar sesión/)).not.toBeInTheDocument();
  });
});

describe("UserMenu — nombre", () => {
  it("si displayName llegara vacío usa el correo", async () => {
    installAuthBackend({ user: { ...DEV_USER, authMode: "Authenticated", displayName: "", email: "sin-nombre@vectorify.test" } });
    render(<AppRoot />);

    const trigger = await screen.findByRole("button", { name: "Menú de cuenta: sin-nombre@vectorify.test" });
    expect(trigger.querySelector(".user-menu__avatar")).toHaveTextContent("S");
  });
});
