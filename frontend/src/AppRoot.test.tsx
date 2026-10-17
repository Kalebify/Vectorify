import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppRoot } from "./AppRoot";
import { resetSessionBoundaryForTests } from "./api/sessionBoundary";
import {
  ANA,
  DEV_USER,
  GOOD_PASSWORD,
  deferred,
  installAuthBackend,
  resetBrowserState,
} from "./auth/authTestSupport";
import { makeProject } from "./components/projects/projectsTestSupport";

/**
 * M3.1-S05: integración de la sesión con la navegación a mano de la app (AppRoot). `EditorShell` se mockea con un stub mínimo (su
 * comportamiento interno ya tiene sus propios tests): acá el foco es la orquestación de sesión, login, returnUrl y salida.
 */

vi.mock("./components/editor/EditorShell", () => ({
  EditorShell: ({
    savedProjectId,
    accountSlot,
  }: {
    savedProjectId: string | null;
    accountSlot?: React.ReactNode;
  }) => (
    <div role="application" aria-label="Workspace de prueba" data-saved-project-id={savedProjectId ?? ""}>
      {accountSlot}
    </div>
  ),
}));

const DEEP_LINK = "/?projectId=p1&imageId=i1&paletteId=pal1&savedProjectId=s1";

beforeEach(() => {
  resetSessionBoundaryForTests();
  resetBrowserState("/");
});

afterEach(() => {
  resetSessionBoundaryForTests();
  resetBrowserState("/");
});

/** Aviso contextual del login (role=status con tabIndex=-1); hay otros role=status ocultos (progreso, menú). */
function loginBanner(): HTMLElement {
  const banner = document.querySelector<HTMLElement>(".auth-banner");
  if (!banner) throw new Error("No hay aviso contextual en el login.");
  return banner;
}

async function openUserMenu() {
  const trigger = await screen.findByRole("button", { name: "Menú de cuenta: Ana Gómez" });
  fireEvent.click(trigger);
  return trigger;
}

describe("AppRoot — sesión desconocida, sin flash de contenido privado", () => {
  it("mientras /me está pendiente solo muestra «Comprobando tu sesión…»: ni contenido privado, ni login, ni pedidos de producto", async () => {
    const gate = deferred();
    const api = installAuthBackend({ gates: { me: gate.promise } });
    render(<AppRoot />);

    expect(screen.getByRole("status")).toHaveTextContent("Comprobando tu sesión…");
    expect(screen.getByRole("main")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("heading", { name: "Mis proyectos" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "VECTORiZE" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Iniciar sesión" })).not.toBeInTheDocument();
    expect(api.listCalls()).toHaveLength(0);

    await act(async () => {
      gate.resolve();
    });

    expect(await screen.findByRole("heading", { name: "Mis proyectos" })).toBeInTheDocument();
  });

  it("sin flash tampoco para un deep link: no pide nada de producto hasta conocer la sesión", async () => {
    window.history.pushState({}, "", DEEP_LINK);
    const gate = deferred();
    const api = installAuthBackend({ user: null, gates: { me: gate.promise } });
    render(<AppRoot />);

    expect(screen.queryByRole("application")).not.toBeInTheDocument();
    await act(async () => {
      gate.resolve();
    });
    await screen.findByRole("heading", { name: "Iniciar sesión" });

    expect(api.calls.filter((call) => !call.path.startsWith("/api/v1/auth/"))).toHaveLength(0);
  });

  it("consulta /me una sola vez por arranque, no por cambio de vista", async () => {
    const api = installAuthBackend();
    render(<AppRoot />);
    await screen.findByRole("heading", { name: "Mis proyectos" });

    fireEvent.click(screen.getByRole("button", { name: "New Project" }));
    await screen.findByRole("heading", { name: "Nuevo proyecto" });
    fireEvent.click(screen.getByRole("link", { name: "Mis proyectos" }));
    await screen.findByRole("heading", { name: "Mis proyectos" });

    expect(api.authCallsTo("GET", "/api/v1/auth/me")).toHaveLength(1);
  });
});

describe("AppRoot — refresh del navegador con sesión válida", () => {
  it("al recargar con cookie vigente vuelve a /me y se queda en la misma pantalla (deep link incluido)", async () => {
    window.history.pushState({}, "", DEEP_LINK);
    const api = installAuthBackend();
    const first = render(<AppRoot />);
    expect(await screen.findByRole("application", { name: "Workspace de prueba" })).toBeInTheDocument();
    first.unmount();

    // «Recarga»: la sesión vive en la cookie (servidor), no en el cliente.
    render(<AppRoot />);

    expect(await screen.findByRole("application", { name: "Workspace de prueba" })).toHaveAttribute("data-saved-project-id", "s1");
    expect(window.location.search).toBe(DEEP_LINK.slice(1));
    expect(api.authCallsTo("GET", "/api/v1/auth/me")).toHaveLength(2);
    expect(screen.queryByRole("heading", { name: "Iniciar sesión" })).not.toBeInTheDocument();
  });
});

describe("AppRoot — deep link sin sesión => login => vuelve al deep link", () => {
  it("redirige al login reemplazando la entrada, con aviso, y tras autenticarse restaura el Workspace con todos sus query params", async () => {
    window.history.pushState({}, "", DEEP_LINK);
    const historyLength = window.history.length;
    const api = installAuthBackend({ user: null });
    render(<AppRoot />);

    expect(await screen.findByRole("heading", { name: "Iniciar sesión" })).toBeInTheDocument();
    expect(window.location.search).toBe(`?view=login&returnUrl=${encodeURIComponent(DEEP_LINK)}`);
    expect(window.history.length).toBe(historyLength); // replace, no push
    expect(loginBanner()).toHaveTextContent("Iniciá sesión para continuar.");
    expect(screen.queryByRole("application")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Correo electrónico"), { target: { value: ANA.email } });
    fireEvent.change(screen.getByLabelText("Contraseña"), { target: { value: GOOD_PASSWORD } });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar sesión" }));

    const workspace = await screen.findByRole("application", { name: "Workspace de prueba" });
    expect(workspace).toHaveAttribute("data-saved-project-id", "s1");
    expect(window.location.search).toBe(DEEP_LINK.slice(1));
    expect(screen.queryByRole("heading", { name: "Iniciar sesión" })).not.toBeInTheDocument();
    expect(api.authCallsTo("POST", "/api/v1/auth/login")).toHaveLength(1);
  });

  it("sin returnUrl (acceso a la raíz) el login lleva a Mis proyectos", async () => {
    installAuthBackend({ user: null });
    render(<AppRoot />);
    await screen.findByRole("heading", { name: "Iniciar sesión" });
    expect(window.location.search).toBe("?view=login");
    // Sin returnUrl no hay aviso de «te llevamos a la página que querías abrir».
    expect(screen.queryByText(/Después te llevamos/)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Correo electrónico"), { target: { value: ANA.email } });
    fireEvent.change(screen.getByLabelText("Contraseña"), { target: { value: GOOD_PASSWORD } });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar sesión" }));

    expect(await screen.findByRole("heading", { name: "Mis proyectos" })).toBeInTheDocument();
    expect(window.location.search).toBe("");
  });

  it("tras el login el foco va al encabezado «Mis proyectos» del destino", async () => {
    installAuthBackend({ user: null });
    render(<AppRoot />);
    await screen.findByRole("heading", { name: "Iniciar sesión" });
    fireEvent.change(screen.getByLabelText("Correo electrónico"), { target: { value: ANA.email } });
    fireEvent.change(screen.getByLabelText("Contraseña"), { target: { value: GOOD_PASSWORD } });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar sesión" }));

    const heading = await screen.findByRole("heading", { name: "Mis proyectos" });
    await waitFor(() => expect(heading).toHaveFocus());
  });
});

describe("AppRoot — returnUrl malicioso se ignora", () => {
  it.each([
    ["//evil.com", "esquema relativo"],
    ["https://evil.com", "URL absoluta"],
    ["javascript:alert(1)", "javascript:"],
    ["/\\evil.com", "barra + invertida"],
    ["%2f%2fevil", "// codificado"],
    ["", "vacío"],
  ])("tras el login con returnUrl %j (%s) cae en Mis proyectos y nunca sale del origen", async (payload) => {
    window.history.pushState({}, "", `/?view=login&returnUrl=${encodeURIComponent(payload)}`);
    installAuthBackend({ user: null });
    render(<AppRoot />);
    await screen.findByRole("heading", { name: "Iniciar sesión" });
    // Un returnUrl inválido no genera el aviso «te llevamos a la página que querías abrir».
    expect(screen.queryByText(/Después te llevamos/)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Correo electrónico"), { target: { value: ANA.email } });
    fireEvent.change(screen.getByLabelText("Contraseña"), { target: { value: GOOD_PASSWORD } });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar sesión" }));

    expect(await screen.findByRole("heading", { name: "Mis proyectos" })).toBeInTheDocument();
    expect(window.location.origin).toBe("http://localhost:3000");
    expect(window.location.pathname).toBe("/");
    expect(window.location.search).toBe("");
  });

  it("un usuario ya autenticado que abre ?view=login con returnUrl válido es llevado a ese destino (reemplazando la entrada)", async () => {
    window.history.pushState({}, "", `/?view=login&returnUrl=${encodeURIComponent("/?view=new")}`);
    installAuthBackend();
    render(<AppRoot />);

    expect(await screen.findByRole("heading", { name: "Nuevo proyecto" })).toBeInTheDocument();
    expect(window.location.search).toBe("?view=new");
  });
});

describe("AppRoot — sesión expirada (evento de S04)", () => {
  it("un 401 de un endpoint de producto lleva al login con aviso «Tu sesión terminó», foco en el aviso y returnUrl de la ruta actual", async () => {
    const api = installAuthBackend();
    render(<AppRoot />);
    await screen.findByRole("button", { name: "Llavero" });
    fireEvent.click(screen.getByRole("button", { name: "New Project" }));
    await screen.findByRole("heading", { name: "Nuevo proyecto" });

    // La cookie caducó en el servidor: la próxima request de producto (health del flujo clásico) da 401.
    api.session.user = null;
    fireEvent.click(screen.getByRole("link", { name: "Mis proyectos" }));
    // El dashboard pide la lista => 401 => evento de sesión expirada.
    expect(await screen.findByRole("heading", { name: "Iniciar sesión" })).toBeInTheDocument();

    const banner = loginBanner();
    expect(banner).toHaveTextContent("Tu sesión terminó. Iniciá sesión de nuevo para continuar.");
    expect(banner).toHaveFocus();
    // Estaba en «Mis proyectos» (raíz): destino por defecto, sin returnUrl.
    expect(window.location.search).toBe("?view=login");
    expect(screen.queryByRole("heading", { name: "Mis proyectos" })).not.toBeInTheDocument();
  });

  it("el returnUrl conserva la ruta con su consulta cuando la sesión expira dentro de ?view=new", async () => {
    window.history.pushState({}, "", "/?view=new");
    const api = installAuthBackend();
    render(<AppRoot />);
    await screen.findByRole("heading", { name: "Nuevo proyecto" });

    // La cookie caduca en el servidor y el cliente hace una request de producto => 401 => evento de sesión expirada.
    api.session.user = null;
    const { httpClient } = await import("./api/httpClient");
    await act(async () => {
      await httpClient.get("/api/v1/system/health").catch(() => undefined);
    });

    expect(await screen.findByRole("heading", { name: "Iniciar sesión" })).toBeInTheDocument();
    expect(window.location.search).toBe(`?view=login&returnUrl=${encodeURIComponent("/?view=new")}`);
    expect(loginBanner()).toHaveTextContent("Tu sesión terminó.");

    // Al volver a entrar se restaura la ruta original.
    fireEvent.change(screen.getByLabelText("Correo electrónico"), { target: { value: ANA.email } });
    fireEvent.change(screen.getByLabelText("Contraseña"), { target: { value: GOOD_PASSWORD } });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar sesión" }));
    expect(await screen.findByRole("heading", { name: "Nuevo proyecto" })).toBeInTheDocument();
    expect(window.location.search).toBe("?view=new");
  });

  it("varias requests concurrentes con 401 producen un único redireccionamiento", async () => {
    window.history.pushState({}, "", "/?view=new");
    const api = installAuthBackend();
    render(<AppRoot />);
    await screen.findByRole("heading", { name: "Nuevo proyecto" });
    api.session.user = null;
    const { httpClient } = await import("./api/httpClient");
    const replaceSpy = vi.spyOn(window.history, "replaceState");

    await act(async () => {
      await Promise.all([1, 2, 3].map(() => httpClient.get("/api/v2/projects").catch(() => undefined)));
    });

    await screen.findByRole("heading", { name: "Iniciar sesión" });
    expect(replaceSpy.mock.calls.filter(([, , url]) => String(url).includes("view=login"))).toHaveLength(1);
  });

  it("en modo Development un 401 espurio no cierra nada (no hay sesión que pueda caducar)", async () => {
    installAuthBackend({ user: DEV_USER });
    render(<AppRoot />);
    await screen.findByRole("heading", { name: "Mis proyectos" });
    const { httpClient } = await import("./api/httpClient");

    await act(async () => {
      await httpClient.get("/api/v2/otra-cosa").catch(() => undefined);
    });

    expect(screen.getByRole("heading", { name: "Mis proyectos" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Iniciar sesión" })).not.toBeInTheDocument();
  });
});

describe("AppRoot — 401 vs 403", () => {
  it("un 403 en una pantalla de producto NO cierra la sesión ni redirige al login", async () => {
    installAuthBackend({ projectsStatus: 403 });
    render(<AppRoot />);

    expect(await screen.findByText("No pudimos cargar tus proyectos")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Iniciar sesión" })).not.toBeInTheDocument();
    expect(window.location.search).toBe("");
    expect(screen.getByRole("button", { name: "Menú de cuenta: Ana Gómez" })).toBeInTheDocument();
  });
});

describe("AppRoot — error de red al comprobar la sesión", () => {
  it("un fallo de red en /me muestra la pantalla de reintento, NUNCA el login, y no cambia la URL", async () => {
    window.history.pushState({}, "", DEEP_LINK);
    installAuthBackend({ me: "network" });
    render(<AppRoot />);

    expect(await screen.findByRole("heading", { name: "No pudimos comprobar tu sesión" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("No se pudo contactar con el servidor. Revisá tu conexión e intentá de nuevo.");
    expect(screen.getByText("Esto no cierra tu sesión.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Iniciar sesión" })).not.toBeInTheDocument();
    expect(window.location.search).toBe(DEEP_LINK.slice(1));
    expect(document.title).toBe("No pudimos comprobar tu sesión — Vectorify");
  });

  it("un 503 en /me muestra el código real y tampoco es «sesión cerrada»", async () => {
    installAuthBackend({ me: 503 });
    render(<AppRoot />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "El servidor no pudo responder (código 503). Intentá de nuevo en unos minutos.",
    );
    expect(screen.queryByRole("heading", { name: "Iniciar sesión" })).not.toBeInTheDocument();
  });

  it("«Reintentar» muestra «Reintentando…» (aria-disabled), y si responde 200 entra al contenido; si responde 401 va al login", async () => {
    const api = installAuthBackend({ me: "network" });
    render(<AppRoot />);
    await screen.findByRole("heading", { name: "No pudimos comprobar tu sesión" });

    const gate = deferred();
    api.session.me = "session";
    // Retiene la nueva respuesta para observar el estado intermedio.
    const original = api.fetchMock.getMockImplementation()!;
    api.fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/api/v1/auth/me")) await gate.promise;
      return original(input, init);
    });

    const retry = screen.getByRole("button", { name: "Reintentar" });
    fireEvent.click(retry);
    const busy = await screen.findByRole("button", { name: "Reintentando…" });
    expect(busy).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(busy); // el clic extra se ignora
    await act(async () => {
      gate.resolve();
    });

    expect(await screen.findByRole("heading", { name: "Mis proyectos" })).toBeInTheDocument();
    expect(api.authCallsTo("GET", "/api/v1/auth/me")).toHaveLength(2);
  });

  it("si el reintento da 401 va al login sin aviso de sesión expirada", async () => {
    const api = installAuthBackend({ user: null, me: "network" });
    render(<AppRoot />);
    await screen.findByRole("button", { name: "Reintentar" });

    api.session.me = "session";
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));

    expect(await screen.findByRole("heading", { name: "Iniciar sesión" })).toBeInTheDocument();
    expect(screen.queryByText(/Tu sesión terminó/)).not.toBeInTheDocument();
  });

  it("si vuelve a fallar sigue en la pantalla de reintento y la causa se vuelve a anunciar (nodo nuevo)", async () => {
    installAuthBackend({ me: "network" });
    render(<AppRoot />);
    const firstAlert = await screen.findByRole("alert");

    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));

    await waitFor(() => expect(screen.getByRole("alert")).not.toBe(firstAlert));
    expect(screen.getByRole("heading", { name: "No pudimos comprobar tu sesión" })).toBeInTheDocument();
  });

  it("al volver la conexión (evento online) reintenta sola", async () => {
    const api = installAuthBackend({ me: "network" });
    render(<AppRoot />);
    await screen.findByRole("button", { name: "Reintentar" });

    api.session.me = "session";
    act(() => {
      window.dispatchEvent(new Event("online"));
    });

    expect(await screen.findByRole("heading", { name: "Mis proyectos" })).toBeInTheDocument();
  });
});

describe("AppRoot — salir y cerrar sesión en todos lados", () => {
  it("«Salir» cierra la sesión y lleva al login sin returnUrl, con el aviso «Cerraste sesión.»", async () => {
    const api = installAuthBackend();
    render(<AppRoot />);
    await openUserMenu();

    fireEvent.click(screen.getByRole("menuitem", { name: "Salir" }));

    expect(await screen.findByRole("heading", { name: "Iniciar sesión" })).toBeInTheDocument();
    expect(loginBanner()).toHaveTextContent("Cerraste sesión.");
    expect(window.location.search).toBe("?view=login");
    expect(api.authCallsTo("POST", "/api/v1/auth/logout")).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "Mis proyectos" })).not.toBeInTheDocument();
  });

  it("«Salir» desde un Workspace abierto no deja rastro del deep link en el login", async () => {
    window.history.pushState({}, "", DEEP_LINK);
    installAuthBackend();
    render(<AppRoot />);
    const workspace = await screen.findByRole("application", { name: "Workspace de prueba" });
    fireEvent.click(within(workspace).getByRole("button", { name: "Menú de cuenta: Ana Gómez" }));

    fireEvent.click(screen.getByRole("menuitem", { name: "Salir" }));

    await screen.findByRole("heading", { name: "Iniciar sesión" });
    expect(window.location.search).toBe("?view=login");
  });

  it("«Cerrar sesión en todos lados» pide confirmación; Cancelar no cierra nada y devuelve el foco al menú", async () => {
    const api = installAuthBackend();
    render(<AppRoot />);
    const trigger = await openUserMenu();

    fireEvent.click(screen.getByRole("menuitem", { name: "Cerrar sesión en todos lados" }));

    const dialog = await screen.findByRole("alertdialog", { name: "¿Cerrar sesión en todos lados?" });
    expect(dialog).toHaveAccessibleDescription(/Vamos a cerrar tu sesión en este navegador y en todos los dispositivos/);
    const cancel = within(dialog).getByRole("button", { name: "Cancelar" });
    expect(cancel).toHaveFocus();
    expect(api.authCallsTo("POST", "/api/v1/auth/logout-all")).toHaveLength(0);

    fireEvent.click(cancel);

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
    expect(api.authCallsTo("POST", "/api/v1/auth/logout-all")).toHaveLength(0);
    expect(screen.getByRole("heading", { name: "Mis proyectos" })).toBeInTheDocument();
  });

  it("confirmar cierra la sesión en todos lados y lleva al login con «Cerraste sesión en todos tus dispositivos.»", async () => {
    const api = installAuthBackend();
    render(<AppRoot />);
    await openUserMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Cerrar sesión en todos lados" }));
    const dialog = await screen.findByRole("alertdialog");

    fireEvent.click(within(dialog).getByRole("button", { name: "Cerrar sesión en todos lados" }));

    expect(await screen.findByRole("heading", { name: "Iniciar sesión" })).toBeInTheDocument();
    expect(loginBanner()).toHaveTextContent("Cerraste sesión en todos tus dispositivos.");
    expect(window.location.search).toBe("?view=login");
    expect(api.authCallsTo("POST", "/api/v1/auth/logout-all")).toHaveLength(1);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("un fallo de red en «Cerrar sesión en todos lados» deja la sesión abierta y muestra el error dentro del diálogo", async () => {
    const api = installAuthBackend({ logoutAll: () => Promise.reject(new TypeError("Failed to fetch")) });
    render(<AppRoot />);
    await openUserMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Cerrar sesión en todos lados" }));
    const dialog = await screen.findByRole("alertdialog");

    fireEvent.click(within(dialog).getByRole("button", { name: "Cerrar sesión en todos lados" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "No pudimos cerrar las sesiones: no hay conexión con el servidor. Intentá de nuevo.",
    );
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(api.session.user).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "Iniciar sesión" })).not.toBeInTheDocument();
    // Los botones vuelven a estar operativos.
    expect(within(dialog).getByRole("button", { name: "Cerrar sesión en todos lados" })).not.toHaveAttribute("aria-disabled");
  });

  it("un 401 en logout-all equivale a sesión expirada", async () => {
    const api = installAuthBackend();
    render(<AppRoot />);
    await openUserMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Cerrar sesión en todos lados" }));
    const dialog = await screen.findByRole("alertdialog");
    api.session.user = null;

    fireEvent.click(within(dialog).getByRole("button", { name: "Cerrar sesión en todos lados" }));

    expect(await screen.findByRole("heading", { name: "Iniciar sesión" })).toBeInTheDocument();
    expect(loginBanner()).toHaveTextContent("Tu sesión terminó.");
  });
});

describe("AppRoot — modo Development (sin login)", () => {
  it("la app se usa como siempre: sin pantallas de login, pastilla «Modo desarrollo» y sin «Salir»", async () => {
    const api = installAuthBackend({ user: DEV_USER });
    render(<AppRoot />);

    expect(await screen.findByRole("heading", { name: "Mis proyectos" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Llavero" })).toBeInTheDocument();
    expect(screen.getByText("Modo desarrollo")).toBeInTheDocument();
    expect(screen.getByText("Dev User")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Menú de cuenta/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Salir" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Iniciar sesión" })).not.toBeInTheDocument();
    expect(api.authCallsTo("POST", "/api/v1/auth/login")).toHaveLength(0);
    // La pastilla no se anuncia al montar (no es un role=status).
    expect(screen.getByText("Modo desarrollo").getAttribute("role")).toBeNull();
  });

  it("?view=login y ?view=register redirigen a Mis proyectos", async () => {
    window.history.pushState({}, "", "/?view=register");
    installAuthBackend({ user: DEV_USER });
    render(<AppRoot />);

    expect(await screen.findByRole("heading", { name: "Mis proyectos" })).toBeInTheDocument();
    expect(window.location.search).toBe("");
  });

  it("el deep link de un Workspace abre directo, sin pasar por el login", async () => {
    window.history.pushState({}, "", DEEP_LINK);
    installAuthBackend({ user: DEV_USER });
    render(<AppRoot />);

    expect(await screen.findByRole("application", { name: "Workspace de prueba" })).toBeInTheDocument();
    expect(screen.getByText("Modo desarrollo")).toBeInTheDocument();
  });
});

describe("AppRoot — el menú de cuenta se inyecta en las tres cabeceras de producto", () => {
  it("Mis proyectos: menú después de «New Project»", async () => {
    installAuthBackend();
    render(<AppRoot />);
    const trigger = await screen.findByRole("button", { name: "Menú de cuenta: Ana Gómez" });
    const newProject = screen.getByRole("button", { name: "New Project" });
    expect(newProject.compareDocumentPosition(trigger) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(screen.getByRole("banner")).getByRole("button", { name: "Menú de cuenta: Ana Gómez" })).toBe(trigger);
  });

  it("flujo clásico ?view=new: dentro de la navegación principal, después de «Mis proyectos»", async () => {
    window.history.pushState({}, "", "/?view=new");
    installAuthBackend();
    render(<AppRoot />);
    const nav = await screen.findByRole("navigation", { name: "Navegación principal" });
    expect(within(nav).getByRole("link", { name: "Mis proyectos" })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "Menú de cuenta: Ana Gómez" })).toBeInTheDocument();
  });

  it("Workspace: el slot llega a EditorShell", async () => {
    window.history.pushState({}, "", DEEP_LINK);
    installAuthBackend({ projects: [makeProject(1)] });
    render(<AppRoot />);
    const workspace = await screen.findByRole("application", { name: "Workspace de prueba" });
    expect(within(workspace).getByRole("button", { name: "Menú de cuenta: Ana Gómez" })).toBeInTheDocument();
  });
});
