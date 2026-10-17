import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

/** M3.1-S05: formulario de registro y panel «Registro recibido» (DESIGN.md §5.10, §5.11). */

beforeEach(() => {
  resetSessionBoundaryForTests();
  resetBrowserState("/?view=register");
});

afterEach(() => {
  resetSessionBoundaryForTests();
  resetBrowserState("/");
});

async function renderRegister(options: AuthBackendOptions = {}, url = "/?view=register") {
  window.history.pushState({}, "", url);
  const api = installAuthBackend({ user: null, ...options });
  render(<AppRoot />);
  await screen.findByRole("heading", { name: "Crear cuenta" });
  return api;
}

const email = () => screen.getByLabelText("Correo electrónico") as HTMLInputElement;
const password = () => screen.getByLabelText("Contraseña") as HTMLInputElement;
const confirmation = () => screen.getByLabelText("Repetí la contraseña") as HTMLInputElement;
const submit = () => screen.getByRole("button", { name: /^Crea(r|ndo) cuenta/ });

function type(field: HTMLElement, value: string) {
  fireEvent.change(field, { target: { value } });
}

function fillValid(overrides: { email?: string; password?: string; confirmation?: string } = {}) {
  type(email(), overrides.email ?? "nueva@vectorify.test");
  type(password(), overrides.password ?? GOOD_PASSWORD);
  type(confirmation(), overrides.confirmation ?? overrides.password ?? GOOD_PASSWORD);
}

describe("RegisterScreen — estructura y accesibilidad", () => {
  it("un único h1, campos etiquetados con autocomplete correcto, pista de contraseña asociada y título de documento", async () => {
    await renderRegister();

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(email()).toHaveAttribute("autocomplete", "email");
    expect(password()).toHaveAttribute("autocomplete", "new-password");
    expect(password()).toHaveAttribute("minlength", "12");
    expect(password()).toHaveAttribute("maxlength", "128");
    expect(confirmation()).toHaveAttribute("autocomplete", "new-password");
    expect(password()).toHaveAccessibleDescription(/Usá al menos 12 caracteres/);
    expect(document.title).toBe("Crear cuenta — Vectorify");
    expect(screen.getByRole("link", { name: "Iniciá sesión" })).toHaveAttribute("href", "?view=login");
  });
});

describe("RegisterScreen — validación al enviar", () => {
  it("con todo vacío marca los tres campos y enfoca el primero inválido, sin enviar", async () => {
    const api = await renderRegister();

    fireEvent.click(submit());

    expect(await screen.findByText("Ingresá tu correo electrónico.")).toBeInTheDocument();
    expect(screen.getByText("La contraseña debe tener al menos 12 caracteres.")).toBeInTheDocument();
    expect(screen.getByText("Repetí la contraseña.")).toBeInTheDocument();
    expect(email()).toHaveFocus();
    expect(api.authCallsTo("POST", "/api/v1/auth/register")).toHaveLength(0);
  });

  it("contraseña corta: mensaje y foco en la contraseña", async () => {
    await renderRegister();
    fillValid({ password: "corta", confirmation: "corta" });

    fireEvent.click(submit());

    expect(await screen.findByText("La contraseña debe tener al menos 12 caracteres.")).toBeInTheDocument();
    expect(password()).toHaveFocus();
    expect(password()).toHaveAttribute("aria-invalid", "true");
  });

  it("contraseña de más de 128 caracteres (pegada): mensaje propio", async () => {
    await renderRegister();
    const long = "a".repeat(129);
    fillValid({ password: long, confirmation: long });

    fireEvent.click(submit());

    expect(await screen.findByText("La contraseña no puede superar los 128 caracteres.")).toBeInTheDocument();
    expect(password()).toHaveFocus();
  });

  it("confirmación distinta: «Las contraseñas no coinciden.» y foco en la confirmación", async () => {
    await renderRegister();
    fillValid({ confirmation: "otra-contrasena-larga-2" });

    fireEvent.click(submit());

    expect(await screen.findByText("Las contraseñas no coinciden.")).toBeInTheDocument();
    expect(confirmation()).toHaveFocus();
  });

  it("correo inválido: mensaje con ejemplo y foco en el correo", async () => {
    await renderRegister();
    fillValid({ email: "no-es-un-correo" });

    fireEvent.click(submit());

    expect(await screen.findByText("Ingresá un correo electrónico válido, por ejemplo nombre@ejemplo.com.")).toBeInTheDocument();
    expect(email()).toHaveFocus();
  });
});

describe("RegisterScreen — registro recibido (202 uniforme)", () => {
  it("envía solo correo y contraseña; muestra «Registro recibido» con el foco en el h1, sin mencionar correos enviados ni verificación", async () => {
    const api = await renderRegister();
    fillValid();

    fireEvent.click(submit());

    const heading = await screen.findByRole("heading", { name: "Registro recibido" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(api.authCallsTo("POST", "/api/v1/auth/register")[0].body).toEqual({
      email: "nueva@vectorify.test",
      password: GOOD_PASSWORD,
    });
    expect(document.title).toBe("Registro recibido — Vectorify");

    const text = document.body.textContent ?? "";
    expect(text).toContain("Ya podés iniciar sesión con tu correo y la contraseña que elegiste.");
    expect(text).not.toMatch(/enviamos|te enviamos|bandeja|verific|confirmá tu|revisá tu (correo|email)|spam/i);
    // No confirma que la cuenta sea nueva y no deja contraseñas en el DOM.
    expect(text).not.toMatch(/cuenta (fue )?creada|bienvenid/i);
    expect(screen.queryByLabelText("Contraseña")).not.toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("«Ir a iniciar sesión» lleva al login con el aviso de registro recibido y el correo precargado (nunca la contraseña)", async () => {
    await renderRegister();
    fillValid();
    fireEvent.click(submit());
    const link = await screen.findByRole("link", { name: "Ir a iniciar sesión" });
    expect(link).toHaveAttribute("href", "?view=login");

    fireEvent.click(link);

    await screen.findByRole("heading", { name: "Iniciar sesión" });
    const banner = document.querySelector<HTMLElement>(".auth-banner")!;
    expect(banner).toHaveTextContent("Registro recibido. Iniciá sesión con tu correo y tu contraseña.");
    await waitFor(() => expect(banner).toHaveFocus());
    expect((screen.getByLabelText("Correo electrónico") as HTMLInputElement).value).toBe("nueva@vectorify.test");
    expect((screen.getByLabelText("Contraseña") as HTMLInputElement).value).toBe("");
    // El correo precargado NO viaja por la URL.
    expect(window.location.search).toBe("?view=login");
  });

  it("conserva el returnUrl hasta el login", async () => {
    const returnUrl = "/?projectId=p1&imageId=i1&paletteId=pal1";
    await renderRegister({}, `/?view=register&returnUrl=${encodeURIComponent(returnUrl)}`);
    fillValid();
    fireEvent.click(submit());

    fireEvent.click(await screen.findByRole("link", { name: "Ir a iniciar sesión" }));

    await screen.findByRole("heading", { name: "Iniciar sesión" });
    expect(window.location.search).toBe(`?view=login&returnUrl=${encodeURIComponent(returnUrl)}`);
  });

  it("durante el envío: botón aria-disabled «Creando cuenta…», campos de solo lectura y un solo pedido", async () => {
    const gate = deferred();
    const api = await renderRegister({
      register: () => gate.promise.then(() => jsonResponse({ status: "accepted" }, 202)),
    });
    fillValid();
    fireEvent.click(submit());

    const busy = await screen.findByRole("button", { name: "Creando cuenta…" });
    expect(busy).toHaveAttribute("aria-disabled", "true");
    expect(document.querySelector("form")).toHaveAttribute("aria-busy", "true");
    expect(password()).toHaveAttribute("readonly");
    fireEvent.click(busy);
    expect(api.authCallsTo("POST", "/api/v1/auth/register")).toHaveLength(1);

    gate.resolve();
    await screen.findByRole("heading", { name: "Registro recibido" });
  });
});

describe("RegisterScreen — errores del servidor", () => {
  it("400 invalid_email: el mensaje del servidor queda en el campo correo y el foco va allí", async () => {
    await renderRegister({
      register: () => jsonResponse({ code: "invalid_email", message: "Indicá un correo electrónico válido." }, 400),
    });
    fillValid({ email: "a@b.co" });

    fireEvent.click(submit());

    expect(await screen.findByText("Indicá un correo electrónico válido.")).toBeInTheDocument();
    expect(email()).toHaveAttribute("aria-invalid", "true");
    expect(email()).toHaveFocus();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("400 weak_password: el mensaje del servidor queda en el campo contraseña, que no se borra", async () => {
    await renderRegister({
      register: () => jsonResponse({ code: "weak_password", message: "La contraseña debe tener al menos 14 caracteres." }, 400),
    });
    fillValid();

    fireEvent.click(submit());

    expect(await screen.findByText("La contraseña debe tener al menos 14 caracteres.")).toBeInTheDocument();
    expect(password()).toHaveFocus();
    expect(password().value).toBe(GOOD_PASSWORD);
  });

  it.each([
    ["400 invalid_request", () => jsonResponse({ code: "invalid_request", message: "x" }, 400), "No pudimos procesar el registro con esos datos. Revisalos e intentá de nuevo."],
    ["error de red", () => networkFailure(), "No se pudo contactar con el servidor. Revisá tu conexión e intentá de nuevo."],
    ["500", () => jsonResponse({}, 500), "El servidor no pudo completar el registro. Intentá de nuevo en unos minutos."],
    ["403", () => jsonResponse({}, 403), "No pudimos verificar la solicitud. Recargá la página e intentá de nuevo."],
    ["429", () => jsonResponse({}, 429), "Hiciste demasiados intentos. Esperá unos minutos antes de volver a probar."],
  ])("%s: alerta de formulario, contraseñas conservadas y sin pasar a «Registro recibido»", async (_label, respond, text) => {
    await renderRegister({ register: respond });
    fillValid();
    const button = submit();
    button.focus();

    fireEvent.click(button);

    expect(await screen.findByRole("alert")).toHaveTextContent(text);
    expect(password().value).toBe(GOOD_PASSWORD);
    expect(confirmation().value).toBe(GOOD_PASSWORD);
    expect(screen.getByRole("button", { name: "Crear cuenta" })).toHaveFocus();
    expect(screen.queryByRole("heading", { name: "Registro recibido" })).not.toBeInTheDocument();
  });
});

describe("RegisterScreen — navegación", () => {
  it("un usuario ya autenticado que abre ?view=register es llevado a Mis proyectos", async () => {
    window.history.pushState({}, "", "/?view=register");
    installAuthBackend({ user: ANA });
    render(<AppRoot />);

    expect(await screen.findByRole("heading", { name: "Mis proyectos" })).toBeInTheDocument();
    expect(window.location.search).toBe("");
  });
});
