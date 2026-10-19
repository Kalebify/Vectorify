import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppRoot } from "../AppRoot";
import { resetSessionBoundaryForTests } from "../api/sessionBoundary";
import { jsonResponse } from "../components/projects/projectsTestSupport";
import { captureRecoveryFragment, clearRecoveryLink, readRecoveryLink } from "./authFragment";
import { ANA, DEV_USER, deferred, installAuthBackend, networkFailure, resetBrowserState, type AuthBackendOptions } from "./authTestSupport";

/** M3.1-S08: restablecimiento de contraseña (DESIGN §5.12, §5.13, §6.5, §9.7). Se monta la app completa; el token llega por el fragmento y lo captura `authFragment`. */

const TOKEN = "CfDJ8-token-de-prueba-A1B2C3";
const EMAIL = "ana.gomez@ejemplo.com";
const NEW_PASSWORD = "una-contrasena-nueva-9";

function linkUrl(email = EMAIL, token = TOKEN) {
  return `/?view=reset-password#email=${encodeURIComponent(email)}&token=${encodeURIComponent(token)}`;
}

beforeEach(() => {
  clearRecoveryLink();
  resetSessionBoundaryForTests();
  resetBrowserState("/");
});

afterEach(() => {
  clearRecoveryLink();
  resetSessionBoundaryForTests();
  resetBrowserState("/");
});

/** Abre el enlace como lo haría el navegador: la URL trae el fragmento y `authFragment` lo captura y borra ANTES de montar React. */
async function renderReset(options: AuthBackendOptions = {}, url: string = linkUrl()) {
  window.history.pushState({}, "", url);
  captureRecoveryFragment();
  const api = installAuthBackend({ user: null, ...options });
  render(<AppRoot />);
  await screen.findByRole("heading", { level: 1 });
  return api;
}

async function renderReady(options: AuthBackendOptions = {}, url?: string) {
  const api = await renderReset(options, url);
  await screen.findByRole("heading", { name: "Elegí una contraseña nueva" });
  return api;
}

const newPassword = () => screen.getByLabelText("Contraseña nueva") as HTMLInputElement;
const confirmation = () => screen.getByLabelText("Repetí la contraseña nueva") as HTMLInputElement;
const submit = () => screen.getByRole("button", { name: /^Guard(ar contraseña nueva|ando contraseña…)/ });
const type = (field: HTMLElement, value: string) => fireEvent.change(field, { target: { value } });
const fillValid = (password = NEW_PASSWORD, repeat = password) => {
  type(newPassword(), password);
  type(confirmation(), repeat);
};
const resetCalls = (api: Awaited<ReturnType<typeof renderReady>>) => api.authCallsTo("POST", "/api/v1/auth/reset-password");

describe("ResetPasswordScreen — el fragmento y el token", () => {
  it("la barra queda sin fragmento y el token no aparece en la URL, history.state, almacenamiento, título ni DOM", async () => {
    await renderReady();

    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(TOKEN);
    expect(JSON.stringify(window.history.state)).not.toContain(TOKEN);
    expect(JSON.stringify({ ...window.localStorage })).not.toContain(TOKEN);
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain(TOKEN);
    expect(document.cookie).not.toContain(TOKEN);
    expect(document.title).not.toContain(TOKEN);
    expect(document.documentElement.outerHTML).not.toContain(TOKEN);
  });

  it("el token solo sale hacia el servidor en el cuerpo del reset (nunca en la URL de la petición)", async () => {
    const api = await renderReady();
    fillValid();

    fireEvent.click(submit());
    await screen.findByRole("heading", { name: "Contraseña cambiada" });

    expect(resetCalls(api)).toHaveLength(1);
    expect(resetCalls(api)[0].body).toEqual({ email: EMAIL, token: TOKEN, newPassword: NEW_PASSWORD });
    expect(JSON.stringify(api.calls.map((call) => [call.path, call.search.toString()]))).not.toContain(TOKEN);
  });
});

describe("ResetPasswordScreen — estructura y accesibilidad (estado ready)", () => {
  it("un h1, landmarks, intro con el correo en negrita, campos new-password con minlength/maxlength y pista, y campo de usuario OCULTO primero en el formulario", async () => {
    await renderReady();

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByRole("main")).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe("Elegí una contraseña nueva — Vectorify"));
    const main = screen.getByRole("main");
    expect(main).toHaveTextContent(`Vas a cambiar la contraseña de la cuenta ${EMAIL}.`);
    expect(within(main).getByText(EMAIL, { selector: "strong" })).toHaveClass("auth-email");

    expect(newPassword()).toHaveAttribute("type", "password");
    expect(newPassword()).toHaveAttribute("autocomplete", "new-password");
    expect(newPassword()).toHaveAttribute("minlength", "12");
    expect(newPassword()).toHaveAttribute("maxlength", "128");
    expect(newPassword()).toHaveAccessibleDescription(/Usá al menos 12 caracteres/);
    expect(confirmation()).toHaveAttribute("autocomplete", "new-password");
    expect(newPassword()).toBeRequired();

    const form = document.querySelector("form") as HTMLFormElement;
    expect(form).toHaveAttribute("novalidate");
    expect(form).toHaveAttribute("aria-busy", "false");
    const username = form.firstElementChild as HTMLInputElement;
    expect(username.tagName).toBe("INPUT");
    expect(username).toHaveAttribute("autocomplete", "username");
    expect(username).toHaveAttribute("name", "username");
    expect(username).toHaveAttribute("type", "email");
    expect(username.hidden).toBe(true);
    expect(username).toHaveAttribute("readonly");
    expect(username.value).toBe(EMAIL);
    expect(username).not.toHaveAttribute("value", TOKEN);
  });

  it("orden de tabulación: nueva -> repetir -> Guardar contraseña nueva -> Volver a iniciar sesión (el campo oculto no es una parada)", async () => {
    await renderReady();

    const focusables = Array.from(document.querySelectorAll<HTMLElement>("a[href], button, input, [tabindex]")).filter(
      (element) => element.getAttribute("tabindex") !== "-1" && !element.hidden,
    );
    expect(focusables.map((element) => element.getAttribute("aria-label") ?? element.textContent?.trim() ?? element.tagName)).toEqual([
      "",
      "",
      "Guardar contraseña nueva",
      "Volver a iniciar sesión",
    ]);
  });
});

describe("ResetPasswordScreen — validación al enviar", () => {
  it.each([
    ["corta", "corta-123", "corta-123", "La contraseña debe tener al menos 12 caracteres.", "Contraseña nueva"],
    ["vacía", "", "", "La contraseña debe tener al menos 12 caracteres.", "Contraseña nueva"],
    ["demasiado larga", "x".repeat(129), "x".repeat(129), "La contraseña no puede superar los 128 caracteres.", "Contraseña nueva"],
    ["repetición vacía", NEW_PASSWORD, "", "Repetí la contraseña.", "Repetí la contraseña nueva"],
    ["repetición distinta", NEW_PASSWORD, `${NEW_PASSWORD}x`, "Las contraseñas no coinciden.", "Repetí la contraseña nueva"],
  ])("%s: error de campo, foco en el primer campo inválido y ninguna petición", async (_label, first, second, message, focusLabel) => {
    const api = await renderReady();
    fillValid(first, second);

    fireEvent.click(submit());

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByLabelText(focusLabel)).toHaveFocus();
    expect(screen.getByLabelText(focusLabel)).toHaveAttribute("aria-invalid", "true");
    expect(resetCalls(api)).toHaveLength(0);
  });

  it("el error se limpia al modificar ese campo", async () => {
    await renderReady();
    fillValid("corta", "corta");
    fireEvent.click(submit());
    await screen.findByText("La contraseña debe tener al menos 12 caracteres.");

    type(newPassword(), NEW_PASSWORD);

    expect(screen.queryByText("La contraseña debe tener al menos 12 caracteres.")).not.toBeInTheDocument();
  });
});

describe("ResetPasswordScreen — éxito", () => {
  it("«Contraseña cambiada» con el foco en el h1, nota de sesiones y el token/contraseñas fuera de memoria", async () => {
    await renderReady();
    fillValid();

    fireEvent.click(submit());

    const heading = await screen.findByRole("heading", { name: "Contraseña cambiada" });
    await waitFor(() => expect(heading).toHaveFocus());
    await waitFor(() => expect(document.title).toBe("Contraseña cambiada — Vectorify"));
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    const main = screen.getByRole("main");
    expect(main).toHaveTextContent("Listo. Ya podés iniciar sesión con tu contraseña nueva.");
    expect(main).toHaveTextContent("Por seguridad, cerramos las sesiones que tenías abiertas con tu cuenta en otros dispositivos y navegadores.");
    expect(screen.queryByLabelText("Contraseña nueva")).not.toBeInTheDocument();
    expect(document.documentElement.outerHTML).not.toContain(NEW_PASSWORD);
    expect(readRecoveryLink("reset-password")).toBeNull(); // el token ya no está en memoria
  });

  it("«Ir a iniciar sesión» lleva al login con el aviso «Cambiaste tu contraseña» y el correo precargado", async () => {
    await renderReady();
    fillValid();
    fireEvent.click(submit());
    const link = await screen.findByRole("link", { name: "Ir a iniciar sesión" });
    expect(link).toHaveAttribute("href", "?view=login");

    fireEvent.click(link);

    await screen.findByRole("heading", { name: "Iniciar sesión" });
    const banner = document.querySelector<HTMLElement>(".auth-banner")!;
    expect(banner).toHaveTextContent("Cambiaste tu contraseña. Iniciá sesión con la contraseña nueva.");
    expect(banner).toHaveClass("status-banner--online");
    await waitFor(() => expect(banner).toHaveFocus());
    expect(screen.getByLabelText("Correo electrónico")).toHaveValue(EMAIL);
    expect(window.location.search).toBe("?view=login");
    expect(window.location.href).not.toContain("ana");
  });

  it("durante el envío: aria-busy, campos de solo lectura, «Guardando contraseña…» y envíos extra ignorados", async () => {
    const gate = deferred();
    const api = await renderReady({ gates: { reset: gate.promise } });
    fillValid();

    fireEvent.click(submit());
    await screen.findByRole("button", { name: /Guardando contraseña…/ });

    expect(document.querySelector("form")).toHaveAttribute("aria-busy", "true");
    expect(newPassword()).toHaveAttribute("readonly");
    expect(confirmation()).toHaveAttribute("readonly");
    fireEvent.click(screen.getByRole("button", { name: /Guardando contraseña…/ }));
    fireEvent.submit(document.querySelector("form")!);
    expect(resetCalls(api)).toHaveLength(1);

    gate.resolve();
    await screen.findByRole("heading", { name: "Contraseña cambiada" });
    expect(resetCalls(api)).toHaveLength(1);
  });
});

describe("ResetPasswordScreen — enlace no válido (un solo mensaje)", () => {
  it.each([
    ["token caducado", jsonResponse({ code: "invalid_token", message: "El enlace no es válido o ya venció. Pedí uno nuevo." }, 400)],
    ["token reusado", jsonResponse({ code: "token_used", message: "x" }, 400)],
    ["token malformado", jsonResponse({ code: "malformed_token", message: "otro texto" }, 400)],
    ["token de otra cuenta", jsonResponse({ code: "other_account", message: "otro más" }, 400)],
    ["cuenta inexistente", jsonResponse({ code: "unknown_account", message: "x" }, 400)],
    ["404", jsonResponse({}, 404)],
    ["401 (cualquier 4xx que no sea 403, 429 ni weak_password)", jsonResponse({}, 401)],
  ])("%s: «Este enlace ya no es válido» con el foco en el h1 y el token fuera de memoria", async (_label, response) => {
    await renderReady({ reset: () => response.clone() });
    fillValid();

    fireEvent.click(submit());

    const heading = await screen.findByRole("heading", { name: "Este enlace ya no es válido" });
    await waitFor(() => expect(heading).toHaveFocus());
    const main = screen.getByRole("main");
    expect(main).toHaveTextContent(
      "No pudimos usar este enlace para cambiar la contraseña. Puede que haya vencido, que ya se haya usado o que esté incompleto.",
    );
    expect(main).toHaveTextContent("Pedí un enlace nuevo: cada enlace sirve una sola vez y por poco tiempo.");
    expect(screen.queryByLabelText("Contraseña nueva")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(readRecoveryLink("reset-password")).toBeNull();
    await waitFor(() => expect(document.title).toBe("Este enlace ya no es válido — Vectorify"));
  });

  it("«Pedir un enlace nuevo» lleva a la solicitud con el correo precargado; «Volver a iniciar sesión» al login", async () => {
    await renderReady({ reset: () => jsonResponse({ code: "invalid_token", message: "x" }, 400) });
    fillValid();
    fireEvent.click(submit());
    const askNew = await screen.findByRole("link", { name: "Pedir un enlace nuevo" });
    expect(askNew).toHaveClass("auth-button--primary");
    expect(screen.getByRole("link", { name: "Volver a iniciar sesión" })).toBeInTheDocument();

    fireEvent.click(askNew);

    await screen.findByRole("heading", { name: "¿Olvidaste tu contraseña?" });
    expect(screen.getByLabelText("Correo electrónico")).toHaveValue(EMAIL);
    expect(window.location.search).toBe("?view=forgot-password");
  });
});

describe("ResetPasswordScreen — errores recuperables", () => {
  it("400 weak_password: el mensaje del servidor va en «Contraseña nueva», con el foco, y el token se conserva para reintentar", async () => {
    let calls = 0;
    const api = await renderReady({
      reset: () =>
        ++calls === 1
          ? jsonResponse({ code: "weak_password", message: "La contraseña debe tener al menos 12 caracteres." }, 400)
          : new Response(null, { status: 204 }),
    });
    fillValid();

    fireEvent.click(submit());

    expect(await screen.findByText("La contraseña debe tener al menos 12 caracteres.")).toBeInTheDocument();
    expect(newPassword()).toHaveFocus();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(readRecoveryLink("reset-password")).not.toBeNull();

    type(newPassword(), "otra-contrasena-nueva-10");
    type(confirmation(), "otra-contrasena-nueva-10");
    fireEvent.click(submit());
    await screen.findByRole("heading", { name: "Contraseña cambiada" });
    expect(resetCalls(api)).toHaveLength(2);
    expect(resetCalls(api)[1].body).toMatchObject({ token: TOKEN });
  });

  it.each([
    ["red caída", () => networkFailure(), "No pudimos confirmar el cambio: no hay conexión con el servidor. Revisá tu conexión e intentá de nuevo."],
    ["5xx", () => jsonResponse({}, 503), "El servidor no pudo cambiar la contraseña. Intentá de nuevo en unos minutos."],
    [
      "403 (no pide recargar: recargar perdería el enlace)",
      () => jsonResponse({ code: "csrf_rejected", message: "x" }, 403),
      "No pudimos verificar la solicitud. Intentá de nuevo; si vuelve a pasar, abrí otra vez el enlace desde tu correo.",
    ],
    ["429 sin Retry-After", () => jsonResponse({}, 429), "Hiciste demasiados intentos. Esperá unos minutos antes de volver a probar."],
    [
      "429 con Retry-After: 120",
      () => new Response("{}", { status: 429, headers: { "Retry-After": "120" } }),
      "Hiciste demasiados pedidos seguidos. Probá de nuevo en 2 minutos.",
    ],
  ])("%s: alerta con su texto, contraseñas y token conservados, foco donde estaba", async (_label, respond, text) => {
    await renderReady({ reset: () => respond() });
    fillValid();
    submit().focus();

    fireEvent.click(submit());

    expect(await screen.findByRole("alert")).toHaveTextContent(text);
    expect(newPassword()).toHaveValue(NEW_PASSWORD);
    expect(confirmation()).toHaveValue(NEW_PASSWORD);
    expect(submit()).toHaveFocus();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Elegí una contraseña nueva");
    expect(readRecoveryLink("reset-password")).not.toBeNull();
  });
});

describe("ResetPasswordScreen — sin enlace (missing)", () => {
  it.each([
    ["sin fragmento", "/?view=reset-password"],
    ["solo token (sin correo)", "/?view=reset-password#token=abc"],
    ["solo correo (sin token)", "/?view=reset-password#email=ana%40vectorify.test"],
    ["correo con formato inválido", "/?view=reset-password#email=no-es-un-correo&token=abc"],
    ["fragmento mal formado", "/?view=reset-password#basura"],
  ])("%s: «Abrí el enlace desde tu correo» con «Pedir un enlace nuevo»", async (_label, url) => {
    await renderReset({}, url);

    const heading = await screen.findByRole("heading", { name: "Abrí el enlace desde tu correo" });
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    await waitFor(() => expect(document.title).toBe("Abrí el enlace desde tu correo — Vectorify"));
    expect(screen.getByRole("main")).toHaveTextContent("Esta página funciona con el enlace del correo de recuperación.");
    expect(screen.getByRole("link", { name: "Pedir un enlace nuevo" })).toHaveAttribute("href", "?view=forgot-password");
    expect(screen.getByRole("link", { name: "Volver a iniciar sesión" })).toHaveAttribute("href", "?view=login");
    expect(screen.queryByLabelText("Contraseña nueva")).not.toBeInTheDocument();
    expect(heading).not.toHaveFocus(); // carga desde el correo: el foco no se mueve
    expect(window.location.hash).toBe("");
  });

  it("tras una recarga (la variable de módulo se perdió) vuelve a «sin enlace»", async () => {
    await renderReady();
    document.body.innerHTML = "";
    clearRecoveryLink(); // equivale a recargar: el módulo se evalúa de nuevo y la URL ya no trae fragmento
    window.history.replaceState({}, "", "/?view=reset-password");

    render(<AppRoot />);

    await screen.findByRole("heading", { name: "Abrí el enlace desde tu correo" });
  });
});

describe("ResetPasswordScreen — sesión y modo", () => {
  it("con una sesión real se muestra igual (no redirige) y, al restablecer, cierra la sesión local sin el aviso «Tu sesión terminó»", async () => {
    const api = await renderReady({ user: ANA });
    fillValid();

    fireEvent.click(submit());

    await screen.findByRole("heading", { name: "Contraseña cambiada" });
    await waitFor(() => expect(api.authCallsTo("POST", "/api/v1/auth/logout")).toHaveLength(1));
    expect(window.location.search).toBe("?view=reset-password");

    fireEvent.click(screen.getByRole("link", { name: "Ir a iniciar sesión" }));
    await screen.findByRole("heading", { name: "Iniciar sesión" });
    const banner = document.querySelector<HTMLElement>(".auth-banner")!;
    expect(banner).toHaveTextContent("Cambiaste tu contraseña.");
    expect(document.body.textContent).not.toContain("Tu sesión terminó");
  });

  it("si el cierre de sesión local falla (red), el restablecimiento igual termina bien", async () => {
    await renderReady({ user: ANA, logout: () => new Response("{}", { status: 503 }) });
    fillValid();

    fireEvent.click(submit());

    await screen.findByRole("heading", { name: "Contraseña cambiada" });
    await screen.findByRole("link", { name: "Ir a iniciar sesión" });
  });

  it("con error al comprobar la sesión (red) la pantalla se muestra igual: su propio envío informará el error", async () => {
    await renderReady({ me: "network" });
    fillValid();

    fireEvent.click(submit());

    await screen.findByRole("heading", { name: "Contraseña cambiada" });
  });

  it("en modo Development redirige: no hay recuperación", async () => {
    window.history.pushState({}, "", linkUrl());
    captureRecoveryFragment();
    installAuthBackend({ user: DEV_USER });
    render(<AppRoot />);

    await screen.findByRole("heading", { name: "Mis proyectos" });
    expect(window.location.search).toBe("");
  });

  it("mientras se comprueba la sesión muestra «Comprobando tu sesión…»", async () => {
    const gate = deferred();
    window.history.pushState({}, "", linkUrl());
    captureRecoveryFragment();
    installAuthBackend({ user: null, gates: { me: gate.promise } });
    render(<AppRoot />);

    expect(await screen.findByText("Comprobando tu sesión…")).toBeInTheDocument();
    gate.resolve();
    await screen.findByRole("heading", { name: "Elegí una contraseña nueva" });
  });
});

describe("ResetPasswordScreen — enlace pegado en una pestaña que ya está en la vista", () => {
  it("hashchange: la pantalla se rehace con el enlace nuevo y el fragmento vuelve a borrarse", async () => {
    const api = await renderReady();
    fillValid();

    act(() => {
      window.history.pushState({}, "", linkUrl("otra@vectorify.test", "TOKEN-NUEVO"));
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });

    await waitFor(() => expect(screen.getByRole("main")).toHaveTextContent("Vas a cambiar la contraseña de la cuenta otra@vectorify.test."));
    expect(window.location.hash).toBe("");
    expect(newPassword()).toHaveValue(""); // formulario nuevo
    fillValid();
    fireEvent.click(submit());
    await screen.findByRole("heading", { name: "Contraseña cambiada" });
    expect(resetCalls(api)[0].body).toEqual({ email: "otra@vectorify.test", token: "TOKEN-NUEVO", newPassword: NEW_PASSWORD });
  });
});
