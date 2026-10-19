import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppRoot } from "../AppRoot";
import { resetSessionBoundaryForTests } from "../api/sessionBoundary";
import { jsonResponse } from "../components/projects/projectsTestSupport";
import {
  ANA,
  GOOD_PASSWORD,
  deferred,
  installAuthBackend,
  networkFailure,
  resetBrowserState,
  type AuthBackendOptions,
} from "./authTestSupport";

/** M3.1-S05: formulario de login (DESIGN.md §5.9, §9). Se monta la app completa en `?view=login` sin sesión. */

beforeEach(() => {
  resetSessionBoundaryForTests();
  resetBrowserState("/?view=login");
});

afterEach(() => {
  resetSessionBoundaryForTests();
  resetBrowserState("/");
});

async function renderLogin(options: AuthBackendOptions = {}, url = "/?view=login") {
  window.history.pushState({}, "", url);
  const api = installAuthBackend({ user: null, ...options });
  render(<AppRoot />);
  await screen.findByRole("heading", { name: "Iniciar sesión" });
  return api;
}

const email = () => screen.getByLabelText("Correo electrónico") as HTMLInputElement;
const password = () => screen.getByLabelText("Contraseña") as HTMLInputElement;
const submit = () => screen.getByRole("button", { name: /^Inicia(r|ndo) sesión/ });

function type(field: HTMLElement, value: string) {
  fireEvent.change(field, { target: { value } });
}

describe("LoginScreen — estructura, etiquetas y accesibilidad", () => {
  it("tiene un único h1, landmarks header/main, campos etiquetados con autocomplete correcto y título de documento", async () => {
    await renderLogin();

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.queryAllByRole("heading", { level: 2 })).toHaveLength(0);
    expect(screen.getByRole("banner")).toHaveTextContent("VECTORiZE");
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Iniciar sesión" })).toBeInTheDocument();

    expect(email()).toHaveAttribute("type", "email");
    expect(email()).toHaveAttribute("autocomplete", "email");
    expect(email()).toHaveAttribute("autocapitalize", "none");
    expect(email()).toHaveAttribute("spellcheck", "false");
    expect(email()).toBeRequired();
    expect(password()).toHaveAttribute("type", "password");
    expect(password()).toHaveAttribute("autocomplete", "current-password");
    expect(password()).toBeRequired();
    expect(document.title).toBe("Iniciar sesión — Vectorify");

    // «Recordarme»: opcional, desmarcado por defecto, con su aviso para equipos compartidos asociado.
    const remember = screen.getByRole("checkbox", { name: "Recordarme en este dispositivo" });
    expect(remember).not.toBeChecked();
    expect(remember).toHaveAccessibleDescription(/No lo marques en un equipo compartido/);

    // El formulario no usa validación nativa (los mensajes son propios) y no está ocupado.
    expect(document.querySelector("form")).toHaveAttribute("novalidate");
    expect(document.querySelector("form")).toHaveAttribute("aria-busy", "false");
  });

  it("muestra solo enlaces reales (sin enlaces muertos ni promesas fuera de alcance): ayuda de acceso + «Creá una», sin MFA ni login social", async () => {
    await renderLogin();
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/MFA|dos factores|google|github|microsoft/i);
    const links = screen.getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual([
      "¿Olvidaste tu contraseña?",
      "¿No te llegó el correo para confirmar tu cuenta?",
      "Creá una",
    ]);
    // Todos son <a href> reales de la propia app (nada de "#" ni href vacío).
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["?view=forgot-password", "?view=confirm-email", "?view=register"]);
  });

  it("los enlaces de ayuda van DESPUÉS del botón «Iniciar sesión» y ANTES de «Creá una» (orden del DOM = orden de tabulación; Enter en la contraseña sigue enviando)", async () => {
    await renderLogin();

    const button = submit();
    const forgot = screen.getByRole("link", { name: "¿Olvidaste tu contraseña?" });
    const confirm = screen.getByRole("link", { name: "¿No te llegó el correo para confirmar tu cuenta?" });
    const register = screen.getByRole("link", { name: "Creá una" });
    const follows = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(button, forgot)).toBe(true);
    expect(follows(forgot, confirm)).toBe(true);
    expect(follows(confirm, register)).toBe(true);
    expect(button.closest("form")).not.toContainElement(forgot); // fuera del formulario: no interrumpen el camino del teclado
    expect(forgot.closest("ul")).toBe(confirm.closest("ul"));
    expect(document.querySelectorAll("[tabindex]:not([tabindex='-1']):not([tabindex='0'])")).toHaveLength(0);
  });

  it("«¿Olvidaste tu contraseña?» conserva el returnUrl validado", async () => {
    const returnUrl = "/?projectId=p1&imageId=i1&paletteId=pal1";
    await renderLogin({}, `/?view=login&returnUrl=${encodeURIComponent(returnUrl)}`);

    expect(screen.getByRole("link", { name: "¿Olvidaste tu contraseña?" })).toHaveAttribute(
      "href",
      `?view=forgot-password&returnUrl=${encodeURIComponent(returnUrl)}`,
    );
  });

  it("el enlace «Creá una» es un <a href> real que conserva el returnUrl y lleva el foco al h1 del registro", async () => {
    const returnUrl = "/?projectId=p1&imageId=i1&paletteId=pal1";
    await renderLogin({}, `/?view=login&returnUrl=${encodeURIComponent(returnUrl)}`);

    const link = screen.getByRole("link", { name: "Creá una" });
    expect(link).toHaveAttribute("href", `?view=register&returnUrl=${encodeURIComponent(returnUrl)}`);

    fireEvent.click(link);

    const heading = await screen.findByRole("heading", { name: "Crear cuenta" });
    expect(window.location.search).toBe(`?view=register&returnUrl=${encodeURIComponent(returnUrl)}`);
    await waitFor(() => expect(heading).toHaveFocus());
  });
});

describe("LoginScreen — validación al enviar", () => {
  it("con todo vacío marca ambos campos, enfoca el PRIMERO inválido y no envía nada", async () => {
    const api = await renderLogin();

    fireEvent.click(submit());

    expect(await screen.findByText("Ingresá tu correo electrónico.")).toBeInTheDocument();
    expect(screen.getByText("Ingresá tu contraseña.")).toBeInTheDocument();
    expect(email()).toHaveAttribute("aria-invalid", "true");
    expect(password()).toHaveAttribute("aria-invalid", "true");
    expect(email()).toHaveFocus();
    expect(email()).toHaveAccessibleDescription("Ingresá tu correo electrónico.");
    expect(api.authCallsTo("POST", "/api/v1/auth/login")).toHaveLength(0);
  });

  it("con correo válido y contraseña vacía el foco va a la contraseña", async () => {
    await renderLogin();
    type(email(), ANA.email!);

    fireEvent.click(submit());

    expect(await screen.findByText("Ingresá tu contraseña.")).toBeInTheDocument();
    expect(password()).toHaveFocus();
    expect(email()).not.toHaveAttribute("aria-invalid");
  });

  it("rechaza un correo con formato inválido con un mensaje con ejemplo", async () => {
    await renderLogin();
    type(email(), "ana-sin-arroba");
    type(password(), "x");

    fireEvent.click(submit());

    expect(await screen.findByText("Ingresá un correo electrónico válido, por ejemplo nombre@ejemplo.com.")).toBeInTheDocument();
    expect(email()).toHaveFocus();
  });

  it("NO valida al perder el foco ni mientras se escribe, y el error de un campo se limpia al editarlo", async () => {
    await renderLogin();
    email().focus();
    fireEvent.blur(email());
    type(email(), "a");
    expect(screen.queryByText(/Ingresá/)).not.toBeInTheDocument();

    fireEvent.click(submit());
    expect(await screen.findByText("Ingresá un correo electrónico válido, por ejemplo nombre@ejemplo.com.")).toBeInTheDocument();

    type(email(), "ana@vectorify.test");
    expect(screen.queryByText("Ingresá un correo electrónico válido, por ejemplo nombre@ejemplo.com.")).not.toBeInTheDocument();
    expect(email()).not.toHaveAttribute("aria-invalid");
  });
});

describe("LoginScreen — envío y errores del servidor", () => {
  it("envía el correo recortado y rememberMe=false por defecto; con la casilla marcada envía rememberMe=true", async () => {
    const api = await renderLogin();
    type(email(), `  ${ANA.email}  `);
    type(password(), GOOD_PASSWORD);
    fireEvent.click(submit());
    await screen.findByRole("heading", { name: "Mis proyectos" });
    expect(api.authCallsTo("POST", "/api/v1/auth/login")[0].body).toEqual({
      email: ANA.email,
      password: GOOD_PASSWORD,
      rememberMe: false,
    });
  });

  it("con «Recordarme» marcado envía rememberMe=true", async () => {
    const api = await renderLogin();
    type(email(), ANA.email!);
    type(password(), GOOD_PASSWORD);
    fireEvent.click(screen.getByRole("checkbox", { name: "Recordarme en este dispositivo" }));
    fireEvent.click(submit());
    await screen.findByRole("heading", { name: "Mis proyectos" });
    expect(api.authCallsTo("POST", "/api/v1/auth/login")[0].body).toMatchObject({ rememberMe: true });
  });

  it("durante el envío: aria-busy, botón aria-disabled con etiqueta de progreso, campos de solo lectura, anuncio oculto y un solo pedido", async () => {
    const gate = deferred();
    const api = await renderLogin({ gates: { login: gate.promise } });
    type(email(), ANA.email!);
    type(password(), GOOD_PASSWORD);
    const button = submit();
    button.focus();

    fireEvent.click(button);

    const busy = await screen.findByRole("button", { name: "Iniciando sesión…" });
    expect(busy).toHaveAttribute("aria-disabled", "true");
    expect(busy).not.toBeDisabled(); // no `disabled`: conserva el foco
    expect(busy).toHaveFocus();
    expect(document.querySelector("form")).toHaveAttribute("aria-busy", "true");
    expect(email()).toHaveAttribute("readonly");
    expect(password()).toHaveAttribute("readonly");
    expect(within(document.querySelector("form")!).getByRole("status")).toHaveTextContent("Iniciando sesión…");

    fireEvent.click(busy);
    fireEvent.submit(document.querySelector("form")!);
    expect(api.authCallsTo("POST", "/api/v1/auth/login")).toHaveLength(1);

    await act(async () => {
      gate.resolve();
    });
    await screen.findByRole("heading", { name: "Mis proyectos" });
  });

  it.each([
    ["401 credenciales inválidas", () => jsonResponse({ code: "invalid_credentials", message: "x" }, 401)],
    ["400", () => jsonResponse({ code: "invalid_request", message: "x" }, 400)],
  ])("%s: MISMO mensaje uniforme (sin revelar si la cuenta existe ni si está bloqueada)", async (_label, respond) => {
    await renderLogin({ login: respond });
    type(email(), "desconocida@vectorify.test");
    type(password(), "cualquier-cosa-larga-1");

    fireEvent.click(submit());

    // Texto de S08: cubre cuenta inexistente, contraseña errónea, bloqueo Y correo sin confirmar (Auth:RequireConfirmedEmail) sin distinguirlos.
    expect((await screen.findByRole("alert")).textContent).toBe(
      "El correo o la contraseña no son correctos. Si fallaste varias veces seguidas, esperá unos minutos antes de volver a intentar. Si todavía no confirmaste tu correo, puede que tengas que hacerlo antes de entrar.",
    );
  });

  it.each([
    ["error de red", () => networkFailure(), "No se pudo contactar con el servidor. Revisá tu conexión e intentá de nuevo."],
    ["500", () => jsonResponse({}, 500), "El servidor no pudo completar el inicio de sesión. Intentá de nuevo en unos minutos."],
    ["503", () => jsonResponse({}, 503), "El servidor no pudo completar el inicio de sesión. Intentá de nuevo en unos minutos."],
    ["403", () => jsonResponse({}, 403), "No pudimos verificar la solicitud. Recargá la página e intentá de nuevo."],
    ["429", () => jsonResponse({}, 429), "Hiciste demasiados intentos. Esperá unos minutos antes de volver a probar."],
  ])("%s: alerta propia, la sesión sigue sin abrirse y nunca se confunde con credenciales inválidas", async (_label, respond, text) => {
    await renderLogin({ login: respond });
    type(email(), ANA.email!);
    type(password(), GOOD_PASSWORD);

    fireEvent.click(submit());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(text);
    expect(alert).not.toHaveTextContent("no son correctos");
    expect(screen.getByRole("heading", { name: "Iniciar sesión" })).toBeInTheDocument();
  });

  it("tras un error la contraseña NO se borra, los campos vuelven a ser editables y el foco se queda donde estaba", async () => {
    await renderLogin({ login: () => jsonResponse({ code: "invalid_credentials", message: "x" }, 401) });
    type(email(), ANA.email!);
    type(password(), "una-contrasena-equivocada");
    const button = submit();
    button.focus();

    fireEvent.click(button);
    await screen.findByRole("alert");

    expect(password().value).toBe("una-contrasena-equivocada");
    expect(email().value).toBe(ANA.email);
    expect(password()).not.toHaveAttribute("readonly");
    expect(document.querySelector("form")).toHaveAttribute("aria-busy", "false");
    expect(screen.getByRole("button", { name: "Iniciar sesión" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Iniciar sesión" })).not.toHaveAttribute("aria-disabled");
  });

  it("la alerta se desmonta al reenviar y se vuelve a montar si falla otra vez (nodo nuevo => se anuncia de nuevo)", async () => {
    await renderLogin({ login: () => jsonResponse({ code: "invalid_credentials", message: "x" }, 401) });
    type(email(), ANA.email!);
    type(password(), "una-contrasena-equivocada");
    fireEvent.click(submit());
    const first = await screen.findByRole("alert");

    fireEvent.click(submit());
    await waitFor(() => expect(screen.getByRole("alert")).not.toBe(first));
    expect(first.isConnected).toBe(false);
  });
});

describe("LoginScreen — avisos y foco al llegar", () => {
  it("el aviso «return-info» aparece con un returnUrl válido y no mueve el foco", async () => {
    await renderLogin({}, `/?view=login&returnUrl=${encodeURIComponent("/?view=new")}`);

    const banner = document.querySelector<HTMLElement>(".auth-banner")!;
    expect(banner).toHaveTextContent("Iniciá sesión para continuar. Después te llevamos a la página que querías abrir.");
    expect(banner).not.toHaveFocus();
  });

  it("sin returnUrl y sin motivo en memoria no hay aviso", async () => {
    await renderLogin();
    expect(document.querySelector(".auth-banner")).toBeNull();
  });

  it("un motivo de la URL no puede fabricar el aviso «Tu sesión terminó»", async () => {
    await renderLogin({}, "/?view=login&notice=expired&reason=expired");
    expect(screen.queryByText(/Tu sesión terminó/)).not.toBeInTheDocument();
  });
});
