import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installAuthBackend, resetBrowserState } from "./authTestSupport";
import { clearRecoveryLink } from "./authFragment";

/** M3.1-S08: arrancar la app REAL (`main.tsx`) con un enlace de correo: el fragmento se borra de la barra ANTES del primer fetch. */

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  clearRecoveryLink();
  document.body.innerHTML = "";
  resetBrowserState("/");
});

describe("main.tsx — orden de arranque con un enlace de recuperación", () => {
  it("history.replaceState (borrado del fragmento) ocurre antes del primer fetch y el token no aparece en ningún lado visible", async () => {
    const token = "CfDJ8-token-secreto-de-prueba";
    document.body.innerHTML = '<div id="root"></div>';
    window.history.pushState({}, "", `/?view=reset-password#email=ana%40vectorify.test&token=${token}`);
    const api = installAuthBackend({ user: null });
    const replaceState = vi.spyOn(window.history, "replaceState");
    const fetchMock = vi.mocked(globalThis.fetch);
    vi.resetModules();

    await import("../main.tsx");
    // El import dinámico de main.tsx carga toda la app: bajo la carga de la suite completa supera el 1 s por defecto de findBy*.
    await screen.findByRole("heading", { name: "Elegí una contraseña nueva" }, { timeout: 20000 });

    expect(window.location.hash).toBe("");
    expect(replaceState).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalled(); // GET /api/v1/auth/me de arranque
    const firstReplace = Math.min(...replaceState.mock.invocationCallOrder);
    const firstFetch = Math.min(...fetchMock.mock.invocationCallOrder);
    expect(firstReplace).toBeLessThan(firstFetch);

    // Ninguna petición del arranque lleva el token (ni en la URL ni en el cuerpo) y el DOM no lo muestra.
    expect(JSON.stringify(api.calls)).not.toContain(token);
    expect(document.body.innerHTML).not.toContain(token);
    expect(document.title).not.toContain(token);
  });
});
