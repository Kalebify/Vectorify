import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppRoot } from "../AppRoot";
import { resetSessionBoundaryForTests } from "../api/sessionBoundary";
import { jsonResponse } from "../components/projects/projectsTestSupport";
import { ANA, DEV_USER, GOOD_PASSWORD, deferred, installAuthBackend, networkFailure, resetBrowserState, type AuthBackendOptions } from "./authTestSupport";

/** M3.1-S08: sección «Contraseña» de «Mi cuenta» (DESIGN §5.16, §6.7, §9.7). Se monta la app completa en `?view=account`. */

const NEW_PASSWORD = "otra-contrasena-nueva-7";

beforeEach(() => {
  resetSessionBoundaryForTests();
  resetBrowserState("/?view=account");
});

afterEach(() => {
  resetSessionBoundaryForTests();
  resetBrowserState("/");
});

async function renderSection(options: AuthBackendOptions = {}) {
  window.history.pushState({}, "", "/?view=account");
  const api = installAuthBackend(options);
  render(<AppRoot />);
  await screen.findByRole("heading", { level: 2, name: "Contraseña" });
  return api;
}

const current = () => screen.getByLabelText("Contraseña actual") as HTMLInputElement;
const next = () => screen.getByLabelText("Contraseña nueva") as HTMLInputElement;
const repeat = () => screen.getByLabelText("Repetí la contraseña nueva") as HTMLInputElement;
const submit = () => screen.getByRole("button", { name: /^Cambi(ar|ando) contraseña/ });
const type = (field: HTMLElement, value: string) => fireEvent.change(field, { target: { value } });
const fill = (values: { current?: string; next?: string; repeat?: string } = {}) => {
  type(current(), values.current ?? GOOD_PASSWORD);
  type(next(), values.next ?? NEW_PASSWORD);
  type(repeat(), values.repeat ?? values.next ?? NEW_PASSWORD);
};
const changeCalls = (api: Awaited<ReturnType<typeof renderSection>>) => api.authCallsTo("POST", "/api/v1/auth/change-password");
const passwordForm = () => screen.getByRole("region", { name: "Contraseña" }).querySelector("form") as HTMLFormElement;

describe("ChangePasswordForm — estructura y accesibilidad", () => {
  it("tercera sección «Contraseña» (h2) después de «Cuenta de acceso», con intro, tres campos con autocomplete correcto y campo de usuario oculto con el correo del perfil", async () => {
    await renderSection();

    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(["Perfil", "Cuenta de acceso", "Contraseña"]);
    const section = screen.getByRole("region", { name: "Contraseña" });
    expect(section).toHaveTextContent("Cambiala cuando quieras. Seguís con la sesión iniciada en este navegador y cerramos las demás.");
    expect(current()).toHaveAttribute("type", "password");
    expect(current()).toHaveAttribute("autocomplete", "current-password");
    expect(current()).toHaveAccessibleDescription(/Si no la recordás, cerrá sesión y usá «¿Olvidaste tu contraseña\?»/);
    expect(next()).toHaveAttribute("autocomplete", "new-password");
    expect(next()).toHaveAttribute("minlength", "12");
    expect(next()).toHaveAttribute("maxlength", "128");
    expect(next()).toHaveAccessibleDescription(/Usá al menos 12 caracteres/);
    expect(repeat()).toHaveAttribute("autocomplete", "new-password");

    const form = passwordForm();
    expect(form).toHaveAttribute("novalidate");
    expect(form).toHaveAttribute("aria-busy", "false");
    const username = form.firstElementChild as HTMLInputElement;
    expect(username).toHaveAttribute("autocomplete", "username");
    expect(username.hidden).toBe(true);
    expect(username.value).toBe(ANA.email);
    // Región de estado persistente (vacía) dentro del formulario.
    const status = form.querySelector("[role='status'][aria-live='polite']") as HTMLElement;
    expect(status).toBeInTheDocument();
    expect(status.childElementCount).toBe(0);
  });

  it("sin correo en el perfil no se renderiza el campo de usuario oculto", async () => {
    await renderSection({ profile: { email: null } });

    expect(passwordForm().querySelector("input[autocomplete='username']")).toBeNull();
  });

  it("en modo Development la sección «Contraseña» no existe", async () => {
    installAuthBackend({ user: DEV_USER });
    window.history.pushState({}, "", "/?view=account");
    render(<AppRoot />);
    await screen.findByRole("textbox", { name: "Nombre para mostrar" });

    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(["Perfil", "Cuenta de acceso"]);
    expect(screen.queryByLabelText("Contraseña actual")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cambiar contraseña" })).not.toBeInTheDocument();
  });

  it("estado inicial: tres campos vacíos y botón primario activo «Cambiar contraseña»", async () => {
    await renderSection();

    expect(current()).toHaveValue("");
    expect(next()).toHaveValue("");
    expect(repeat()).toHaveValue("");
    expect(submit()).not.toHaveAttribute("aria-disabled");
    expect(submit()).toHaveClass("auth-button--primary");
  });
});

describe("ChangePasswordForm — validación al enviar", () => {
  it.each([
    ["actual vacía", { current: "", next: NEW_PASSWORD }, "Ingresá tu contraseña actual.", "Contraseña actual"],
    ["nueva corta", { next: "corta-123" }, "La contraseña debe tener al menos 12 caracteres.", "Contraseña nueva"],
    ["nueva vacía", { next: "", repeat: "" }, "La contraseña debe tener al menos 12 caracteres.", "Contraseña nueva"],
    ["nueva larga", { next: "x".repeat(129) }, "La contraseña no puede superar los 128 caracteres.", "Contraseña nueva"],
    ["repetición vacía", { repeat: "" }, "Repetí la contraseña.", "Repetí la contraseña nueva"],
    ["repetición distinta", { repeat: `${NEW_PASSWORD}x` }, "Las contraseñas no coinciden.", "Repetí la contraseña nueva"],
  ])("%s: error de campo, foco en el primer inválido y ninguna petición", async (_label, values, message, focusLabel) => {
    const api = await renderSection();
    fill(values);

    fireEvent.click(submit());

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByLabelText(focusLabel)).toHaveFocus();
    expect(screen.getByLabelText(focusLabel)).toHaveAttribute("aria-invalid", "true");
    expect(changeCalls(api)).toHaveLength(0);
  });

  it("enviar con todo vacío marca los tres campos y enfoca el primero", async () => {
    await renderSection();

    fireEvent.click(submit());

    expect(await screen.findByText("Ingresá tu contraseña actual.")).toBeInTheDocument();
    expect(screen.getByText("Repetí la contraseña.")).toBeInTheDocument();
    expect(current()).toHaveFocus();
  });
});

describe("ChangePasswordForm — éxito", () => {
  it("envía {currentPassword, newPassword}, vacía los tres campos, anuncia el éxito en la región `status` y el foco se queda en el botón", async () => {
    const api = await renderSection();
    fill();
    submit().focus();

    fireEvent.click(submit());

    const text =
      "Cambiamos tu contraseña. Seguís con la sesión iniciada en este navegador; en tus otros dispositivos la sesión se cierra en unos minutos y vas a tener que entrar con la contraseña nueva.";
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(changeCalls(api)[0].body).toEqual({ currentPassword: GOOD_PASSWORD, newPassword: NEW_PASSWORD });
    expect(current()).toHaveValue("");
    expect(next()).toHaveValue("");
    expect(repeat()).toHaveValue("");
    const region = screen.getByText(text).closest("[role='status']") as HTMLElement;
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region.className).toContain("profile-status");
    expect(submit()).toHaveFocus();
    // La sesión sigue: seguimos en «Mi cuenta» y el menú no cambió.
    expect(screen.getByRole("heading", { level: 1, name: "Mi cuenta" })).toBeInTheDocument();
    expect(window.location.search).toBe("?view=account");
    expect(api.authCallsTo("POST", "/api/v1/auth/logout")).toHaveLength(0);
    expect(document.documentElement.outerHTML).not.toContain(NEW_PASSWORD);
  });

  it("el banner de éxito se quita al modificar cualquier campo", async () => {
    await renderSection();
    fill();
    fireEvent.click(submit());
    const text = await screen.findByText(/^Cambiamos tu contraseña\./);

    type(current(), "x");

    expect(text).not.toBeInTheDocument();
  });

  it("durante el envío: aria-busy, campos de solo lectura, «Cambiando contraseña…» y envíos extra ignorados", async () => {
    const gate = deferred();
    const api = await renderSection({ gates: { changePassword: gate.promise } });
    fill();

    fireEvent.click(submit());
    await screen.findByRole("button", { name: /Cambiando contraseña…/ });

    expect(passwordForm()).toHaveAttribute("aria-busy", "true");
    expect(current()).toHaveAttribute("readonly");
    expect(next()).toHaveAttribute("readonly");
    expect(repeat()).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: /Cambiando contraseña…/ })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: /Cambiando contraseña…/ }));
    fireEvent.submit(passwordForm());
    expect(changeCalls(api)).toHaveLength(1);

    gate.resolve();
    await screen.findByText(/^Cambiamos tu contraseña\./);
    expect(changeCalls(api)).toHaveLength(1);
  });
});

describe("ChangePasswordForm — errores del servidor", () => {
  it("400 invalid_current_password (NO 401): error en «Contraseña actual», foco ahí, valores conservados y la sesión sigue", async () => {
    const api = await renderSection({ changePassword: () => jsonResponse({ code: "invalid_current_password", message: "La contraseña actual no es correcta." }, 400) });
    fill();

    fireEvent.click(submit());

    expect(await screen.findByText("La contraseña actual no es correcta.")).toBeInTheDocument();
    expect(current()).toHaveFocus();
    expect(current()).toHaveAttribute("aria-invalid", "true");
    expect(current()).toHaveValue(GOOD_PASSWORD);
    expect(next()).toHaveValue(NEW_PASSWORD);
    expect(repeat()).toHaveValue(NEW_PASSWORD);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // Sigue en «Mi cuenta» con sesión: no hubo login ni aviso de sesión terminada.
    expect(screen.getByRole("heading", { level: 1, name: "Mi cuenta" })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("Tu sesión terminó");
    expect(api.authCallsTo("GET", "/api/v1/auth/me")).toHaveLength(1);
  });

  it("400 weak_password: el mensaje del servidor va en «Contraseña nueva», con el foco", async () => {
    await renderSection({ changePassword: () => jsonResponse({ code: "weak_password", message: "La contraseña debe tener al menos 12 caracteres." }, 400) });
    fill();

    fireEvent.click(submit());

    expect(await screen.findByText("La contraseña debe tener al menos 12 caracteres.")).toBeInTheDocument();
    expect(next()).toHaveFocus();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("401: lleva al login con el aviso «Tu sesión terminó» y el returnUrl de «Mi cuenta» (lo escrito se pierde)", async () => {
    await renderSection({ changePassword: () => jsonResponse({ code: "unauthenticated", message: "x" }, 401) });
    fill();

    fireEvent.click(submit());

    await screen.findByRole("heading", { name: "Iniciar sesión" });
    expect(document.querySelector(".auth-banner")).toHaveTextContent("Tu sesión terminó. Iniciá sesión de nuevo para continuar.");
    expect(window.location.search).toContain("view=login");
    expect(decodeURIComponent(window.location.search)).toContain("returnUrl=/?view=account");
    expect(document.body.textContent).not.toContain(NEW_PASSWORD);
  });

  it.each([
    ["otro 4xx", () => jsonResponse({ code: "x", message: "x" }, 400), "No pudimos cambiar la contraseña con esos datos. Revisalos e intentá de nuevo."],
    ["red caída", () => networkFailure(), "No pudimos confirmar el cambio: no hay conexión con el servidor. Revisá tu conexión e intentá de nuevo."],
    ["5xx con código", () => jsonResponse({}, 503), "El servidor no pudo cambiar la contraseña (código 503). Intentá de nuevo en unos minutos."],
    ["403", () => jsonResponse({ code: "csrf_rejected", message: "x" }, 403), "El servidor rechazó el cambio (código 403). Recargá la página e intentá de nuevo."],
    ["429 sin Retry-After", () => jsonResponse({}, 429), "Hiciste demasiados intentos. Esperá unos minutos antes de volver a probar."],
    [
      "429 con Retry-After: 240",
      () => new Response("{}", { status: 429, headers: { "Retry-After": "240" } }),
      "Hiciste demasiados pedidos seguidos. Probá de nuevo en 4 minutos.",
    ],
  ])("%s: alerta con su texto, valores conservados y el foco donde estaba", async (_label, respond, text) => {
    await renderSection({ changePassword: () => respond() });
    fill();
    submit().focus();

    fireEvent.click(submit());

    expect(await screen.findByRole("alert")).toHaveTextContent(text);
    expect(current()).toHaveValue(GOOD_PASSWORD);
    expect(next()).toHaveValue(NEW_PASSWORD);
    expect(repeat()).toHaveValue(NEW_PASSWORD);
    expect(submit()).toHaveFocus();
    expect(submit()).not.toHaveAttribute("aria-disabled");
  });

  it("un fallo se puede reintentar: la alerta se desmonta al reenviar y el éxito la reemplaza por el banner", async () => {
    let calls = 0;
    await renderSection({ changePassword: () => (++calls === 1 ? jsonResponse({}, 503) : new Response(null, { status: 204 })) });
    fill();

    fireEvent.click(submit());
    await screen.findByRole("alert");
    fireEvent.click(submit());

    await screen.findByText(/^Cambiamos tu contraseña\./);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("ChangePasswordForm — orden de tabulación", () => {
  it("contraseña actual -> nueva -> repetir -> Cambiar contraseña (el campo oculto no es una parada)", async () => {
    await renderSection();

    const section = screen.getByRole("region", { name: "Contraseña" });
    const focusables = Array.from(section.querySelectorAll<HTMLElement>("a[href], button, input, [tabindex]")).filter(
      (element) => element.getAttribute("tabindex") !== "-1" && !element.hidden,
    );
    expect(focusables.map((element) => element.getAttribute("aria-label") ?? element.textContent?.trim() ?? element.tagName)).toEqual([
      "",
      "",
      "",
      "Cambiar contraseña",
    ]);
    expect(within(section).getAllByLabelText(/contraseña/i).length).toBeGreaterThanOrEqual(3);
    await waitFor(() => expect(document.querySelectorAll("[tabindex]:not([tabindex='-1']):not([tabindex='0'])")).toHaveLength(0));
  });
});
