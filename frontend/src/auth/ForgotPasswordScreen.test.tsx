import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppRoot } from "../AppRoot";
import { resetSessionBoundaryForTests } from "../api/sessionBoundary";
import { jsonResponse } from "../components/projects/projectsTestSupport";
import { ANA, DEV_USER, deferred, installAuthBackend, networkFailure, resetBrowserState, type AuthBackendOptions } from "./authTestSupport";

/** M3.1-S08: solicitud de recuperación (DESIGN §5.11, §6.4, §9.7). Se monta la app completa en `?view=forgot-password` sin sesión. */

beforeEach(() => {
  resetSessionBoundaryForTests();
  resetBrowserState("/?view=forgot-password");
});

afterEach(() => {
  resetSessionBoundaryForTests();
  resetBrowserState("/");
});

async function renderForgot(options: AuthBackendOptions = {}, url = "/?view=forgot-password") {
  window.history.pushState({}, "", url);
  const api = installAuthBackend({ user: null, ...options });
  render(<AppRoot />);
  await screen.findByRole("heading", { name: "¿Olvidaste tu contraseña?" });
  return api;
}

const email = () => screen.getByLabelText("Correo electrónico") as HTMLInputElement;
const submit = () => screen.getByRole("button", { name: /^Enviar(ndo)?( enlace|…)/ });
const type = (value: string) => fireEvent.change(email(), { target: { value } });
const forgotCalls = (api: Awaited<ReturnType<typeof renderForgot>>) => api.authCallsTo("POST", "/api/v1/auth/forgot-password");

describe("ForgotPasswordScreen — estructura y accesibilidad", () => {
  it("un único h1, header/main, campo de correo etiquetado, botón primario y pie con enlace real al login; título de documento", async () => {
    await renderForgot();

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.queryAllByRole("heading", { level: 2 })).toHaveLength(0);
    expect(screen.getByRole("banner")).toHaveTextContent("VECTORiZE");
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByText(/Escribí el correo con el que entrás\. Si corresponde a una cuenta, te vamos a enviar un enlace/)).toBeInTheDocument();
    expect(email()).toHaveAttribute("type", "email");
    expect(email()).toHaveAttribute("autocomplete", "email");
    expect(email()).toHaveAttribute("autocapitalize", "none");
    expect(email()).toHaveAttribute("spellcheck", "false");
    expect(email()).toBeRequired();
    expect(email()).toHaveValue("");
    expect(document.querySelector("form")).toHaveAttribute("novalidate");
    expect(document.querySelector("form")).toHaveAttribute("aria-busy", "false");
    await waitFor(() => expect(document.title).toBe("¿Olvidaste tu contraseña? — Vectorify"));
    expect(screen.getByText("¿Te acordaste?")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Volver a iniciar sesión" })).toHaveAttribute("href", "?view=login");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("orden de tabulación (= orden del DOM, sin tabindex positivo): correo -> Enviar enlace -> Volver a iniciar sesión", async () => {
    await renderForgot();

    const focusables = Array.from(document.querySelectorAll<HTMLElement>("a[href], button, input, [tabindex]")).filter(
      (element) => element.getAttribute("tabindex") !== "-1" && !element.hidden,
    );
    expect(focusables.map((element) => element.getAttribute("aria-label") ?? element.textContent?.trim() ?? element.tagName)).toEqual([
      "",
      "Enviar enlace",
      "Volver a iniciar sesión",
    ]);
    expect(document.querySelectorAll("[tabindex]:not([tabindex=\"-1\"]):not([tabindex=\"0\"])")).toHaveLength(0);
  });
});

describe("ForgotPasswordScreen — validación al enviar", () => {
  it("vacío: error de campo, foco en el campo y ninguna petición", async () => {
    const api = await renderForgot();

    fireEvent.click(submit());

    expect(await screen.findByText("Ingresá tu correo electrónico.")).toBeInTheDocument();
    expect(email()).toHaveFocus();
    expect(email()).toHaveAttribute("aria-invalid", "true");
    expect(email()).toHaveAccessibleDescription("Ingresá tu correo electrónico.");
    expect(forgotCalls(api)).toHaveLength(0);
  });

  it("formato inválido: mensaje de formato; el error se limpia al escribir (nunca se valida mientras se escribe)", async () => {
    const api = await renderForgot();
    type("sin-arroba");
    expect(screen.queryByText(/Ingresá un correo electrónico válido/)).not.toBeInTheDocument();

    fireEvent.click(submit());
    expect(await screen.findByText("Ingresá un correo electrónico válido, por ejemplo nombre@ejemplo.com.")).toBeInTheDocument();
    expect(forgotCalls(api)).toHaveLength(0);

    type("ana@vectorify.test");
    expect(screen.queryByText(/Ingresá un correo electrónico válido/)).not.toBeInTheDocument();
  });
});

describe("ForgotPasswordScreen — pedido recibido (202 uniforme)", () => {
  it("envía solo el correo y pasa a «Pedido recibido» con el correo en negrita y el foco en el h1", async () => {
    const api = await renderForgot();
    type("  ana.gomez@ejemplo.com ");

    fireEvent.click(submit());

    const heading = await screen.findByRole("heading", { name: "Pedido recibido" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(forgotCalls(api)[0].body).toEqual({ email: "ana.gomez@ejemplo.com" });
    await waitFor(() => expect(document.title).toBe("Pedido recibido — Vectorify"));
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    const main = screen.getByRole("main");
    expect(within(main).getByText("ana.gomez@ejemplo.com").tagName).toBe("STRONG");
    expect(main).toHaveTextContent(
      "Si existe una cuenta con ana.gomez@ejemplo.com, en unos minutos debería llegarte un correo con un enlace para elegir una contraseña nueva.",
    );
    expect(main).toHaveTextContent("Por seguridad, el enlace vence al poco tiempo y sirve una sola vez.");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    // Nunca afirma que el correo se envió ni que la cuenta existe.
    expect(main.textContent).not.toMatch(/te enviamos|enviamos un|cuenta (existe|encontrada)|no existe/i);
  });

  it("con cuenta existente y con cuenta inexistente (mismo 202) el panel resultante es IDÉNTICO", async () => {
    const snapshots: string[] = [];
    for (const label of ["existente", "inexistente"]) {
      resetBrowserState("/?view=forgot-password");
      const api = await renderForgot({ forgot: () => jsonResponse({ status: "accepted" }, 202) });
      type("ana.gomez@ejemplo.com");
      fireEvent.click(submit());
      const heading = await screen.findByRole("heading", { name: "Pedido recibido" });
      await waitFor(() => expect(heading).toHaveFocus());
      expect(forgotCalls(api), label).toHaveLength(1);
      snapshots.push(document.querySelector(".auth-card")!.outerHTML.replace(/_r_[a-z0-9]+_/g, "ID")); // useId difiere entre montajes
      document.body.innerHTML = "";
    }

    expect(snapshots[0]).toBe(snapshots[1]);
  });

  it("acciones: «Volver a iniciar sesión» (primario) y «Volver a pedir el enlace» (secundario) en columna", async () => {
    await renderForgot();
    type("ana@vectorify.test");
    fireEvent.click(submit());
    await screen.findByRole("heading", { name: "Pedido recibido" });

    const actions = document.querySelector(".auth-result__actions") as HTMLElement;
    const children = Array.from(actions.children).map((child) => child.textContent);
    expect(children).toEqual(["Volver a iniciar sesión", "Volver a pedir el enlace"]);
    expect(screen.getByRole("link", { name: "Volver a iniciar sesión" })).toHaveClass("auth-button--primary");
    expect(screen.getByRole("button", { name: "Volver a pedir el enlace" })).toHaveClass("auth-button--secondary");
  });

  it("«Volver a pedir el enlace» vuelve al formulario con el mismo correo y el foco en el campo", async () => {
    await renderForgot();
    type("ana@vectorify.test");
    fireEvent.click(submit());
    await screen.findByRole("heading", { name: "Pedido recibido" });

    fireEvent.click(screen.getByRole("button", { name: "Volver a pedir el enlace" }));

    expect(await screen.findByRole("heading", { name: "¿Olvidaste tu contraseña?" })).toBeInTheDocument();
    expect(email()).toHaveValue("ana@vectorify.test");
    expect(email()).toHaveFocus();
  });

  it("«Volver a iniciar sesión» lleva al login con el correo precargado", async () => {
    await renderForgot();
    type("ana@vectorify.test");
    fireEvent.click(submit());
    await screen.findByRole("heading", { name: "Pedido recibido" });

    fireEvent.click(screen.getByRole("link", { name: "Volver a iniciar sesión" }));

    await screen.findByRole("heading", { name: "Iniciar sesión" });
    expect(screen.getByLabelText("Correo electrónico")).toHaveValue("ana@vectorify.test");
    expect(window.location.search).toBe("?view=login");
  });
});

describe("ForgotPasswordScreen — envío", () => {
  it("durante el envío: aria-busy, campo de solo lectura, botón «Enviando…» y envíos extra ignorados", async () => {
    const gate = deferred();
    const api = await renderForgot({ gates: { forgot: gate.promise } });
    type("ana@vectorify.test");

    fireEvent.click(submit());
    await screen.findByRole("button", { name: /Enviando…/ });

    expect(document.querySelector("form")).toHaveAttribute("aria-busy", "true");
    expect(email()).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: /Enviando…/ })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: /Enviando…/ })).not.toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Enviando…/ }));
    fireEvent.submit(document.querySelector("form")!);
    expect(forgotCalls(api)).toHaveLength(1);

    gate.resolve();
    await screen.findByRole("heading", { name: "Pedido recibido" });
    expect(forgotCalls(api)).toHaveLength(1);
  });
});

describe("ForgotPasswordScreen — errores", () => {
  it.each([
    ["red caída", () => networkFailure(), "No se pudo contactar con el servidor. Revisá tu conexión e intentá de nuevo."],
    ["5xx", () => jsonResponse({}, 503), "El servidor no pudo recibir el pedido. Intentá de nuevo en unos minutos."],
    ["403", () => jsonResponse({ code: "csrf_rejected", message: "x" }, 403), "No pudimos verificar la solicitud. Recargá la página e intentá de nuevo."],
    ["429 sin Retry-After", () => jsonResponse({ code: "rate_limited", message: "x" }, 429), "Hiciste demasiados intentos. Esperá unos minutos antes de volver a probar."],
    [
      "429 con Retry-After: 120",
      () => new Response("{}", { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "120" } }),
      "Hiciste demasiados pedidos seguidos. Probá de nuevo en 2 minutos.",
    ],
    [
      "429 con Retry-After: 30 (mínimo 1 minuto, singular)",
      () => new Response("{}", { status: 429, headers: { "Retry-After": "30" } }),
      "Hiciste demasiados pedidos seguidos. Probá de nuevo en 1 minuto.",
    ],
    [
      "429 con Retry-After: 61 (redondea hacia arriba)",
      () => new Response("{}", { status: 429, headers: { "Retry-After": "61" } }),
      "Hiciste demasiados pedidos seguidos. Probá de nuevo en 2 minutos.",
    ],
    [
      "400 sin código de campo",
      () => jsonResponse({ code: "invalid_request", message: "x" }, 400),
      "No pudimos procesar el pedido con esos datos. Revisá el correo e intentá de nuevo.",
    ],
  ])("%s: alerta con su texto exacto, lo escrito se conserva y el foco no se mueve", async (_label, respond, text) => {
    await renderForgot({ forgot: () => respond() });
    type("ana@vectorify.test");
    submit().focus();

    fireEvent.click(submit());

    expect(await screen.findByRole("alert")).toHaveTextContent(text);
    expect(email()).toHaveValue("ana@vectorify.test");
    expect(submit()).toHaveFocus();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("¿Olvidaste tu contraseña?");
    expect(submit()).not.toHaveAttribute("aria-disabled");
  });

  it("400 invalid_email: el mensaje del servidor va en el campo y el foco a ese campo", async () => {
    await renderForgot({ forgot: () => jsonResponse({ code: "invalid_email", message: "Indicá un correo electrónico válido." }, 400) });
    type("ana@vectorify.test");

    fireEvent.click(submit());

    expect(await screen.findByText("Indicá un correo electrónico válido.")).toBeInTheDocument();
    expect(email()).toHaveFocus();
    expect(email()).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("un fallo se puede reintentar: la alerta se desmonta al reenviar y el éxito pasa al panel", async () => {
    let calls = 0;
    await renderForgot({ forgot: () => (++calls === 1 ? jsonResponse({}, 503) : jsonResponse({ status: "accepted" }, 202)) });
    type("ana@vectorify.test");

    fireEvent.click(submit());
    await screen.findByRole("alert");
    fireEvent.click(submit());

    await screen.findByRole("heading", { name: "Pedido recibido" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("ForgotPasswordScreen — desde el login y con sesión", () => {
  it("«¿Olvidaste tu contraseña?» del login lleva a la solicitud con el correo escrito precargado y el foco en el h1", async () => {
    const api = installAuthBackend({ user: null });
    window.history.pushState({}, "", "/?view=login");
    render(<AppRoot />);
    await screen.findByRole("heading", { name: "Iniciar sesión" });
    fireEvent.change(screen.getByLabelText("Correo electrónico"), { target: { value: "ana@vectorify.test" } });

    fireEvent.click(screen.getByRole("link", { name: "¿Olvidaste tu contraseña?" }));

    const heading = await screen.findByRole("heading", { name: "¿Olvidaste tu contraseña?" });
    expect(email()).toHaveValue("ana@vectorify.test");
    await waitFor(() => expect(heading).toHaveFocus());
    expect(window.location.search).toBe("?view=forgot-password");
    expect(window.location.search).not.toContain("ana"); // el correo viaja en memoria, nunca en la URL
    expect(api.authCallsTo("POST", "/api/v1/auth/forgot-password")).toHaveLength(0);
  });

  it("un correo con formato inválido en el login NO se precarga", async () => {
    installAuthBackend({ user: null });
    window.history.pushState({}, "", "/?view=login");
    render(<AppRoot />);
    await screen.findByRole("heading", { name: "Iniciar sesión" });
    fireEvent.change(screen.getByLabelText("Correo electrónico"), { target: { value: "no-es-un-correo" } });

    fireEvent.click(screen.getByRole("link", { name: "¿Olvidaste tu contraseña?" }));

    await screen.findByRole("heading", { name: "¿Olvidaste tu contraseña?" });
    expect(email()).toHaveValue("");
  });

  it("conserva el returnUrl validado al volver al login", async () => {
    await renderForgot({}, `/?view=forgot-password&returnUrl=${encodeURIComponent("/?projectId=p1")}`);

    expect(screen.getByRole("link", { name: "Volver a iniciar sesión" })).toHaveAttribute(
      "href",
      `?view=login&returnUrl=${encodeURIComponent("/?projectId=p1")}`,
    );
  });

  it("con sesión iniciada redirige a Mis proyectos (como el login)", async () => {
    installAuthBackend({ user: ANA });
    window.history.pushState({}, "", "/?view=forgot-password");
    render(<AppRoot />);

    await screen.findByRole("heading", { name: "Mis proyectos" });
    expect(window.location.search).toBe("");
  });

  it("en modo Development (sin login) redirige: no hay recuperación", async () => {
    installAuthBackend({ user: DEV_USER });
    window.history.pushState({}, "", "/?view=forgot-password");
    render(<AppRoot />);

    await screen.findByRole("heading", { name: "Mis proyectos" });
    expect(window.location.search).toBe("");
  });

  it("mientras se comprueba la sesión muestra «Comprobando tu sesión…» y no el formulario", async () => {
    const gate = deferred();
    installAuthBackend({ user: null, gates: { me: gate.promise } });
    window.history.pushState({}, "", "/?view=forgot-password");
    render(<AppRoot />);

    expect(await screen.findByText("Comprobando tu sesión…")).toBeInTheDocument();
    expect(screen.queryByLabelText("Correo electrónico")).not.toBeInTheDocument();
    gate.resolve();
    await screen.findByRole("heading", { name: "¿Olvidaste tu contraseña?" });
  });

  it("con error al comprobar la sesión (red) muestra el panel de error de sesión, como el login", async () => {
    installAuthBackend({ user: null, me: "network" });
    window.history.pushState({}, "", "/?view=forgot-password");
    render(<AppRoot />);

    expect(await screen.findByRole("heading", { name: "No pudimos comprobar tu sesión" })).toBeInTheDocument();
  });
});
