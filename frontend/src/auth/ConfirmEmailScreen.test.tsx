import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppRoot } from "../AppRoot";
import { resetSessionBoundaryForTests } from "../api/sessionBoundary";
import { jsonResponse } from "../components/projects/projectsTestSupport";
import { captureRecoveryFragment, clearRecoveryLink, readRecoveryLink } from "./authFragment";
import { resetConfirmRequestsForTests } from "./confirmRequests";
import { ANA, DEV_USER, deferred, installAuthBackend, networkFailure, resetBrowserState, type AuthBackendOptions } from "./authTestSupport";

/** M3.1-S08: confirmación de correo (DESIGN §5.14, §5.15, §6.6, §9.7). El token llega por el fragmento; la confirmación es automática y única por token. */

const TOKEN = "CfDJ8-token-de-confirmacion-Z9Y8";
const USER_ID = "6f1c2a52-9a52-4fd8-9d9f-0a8c0f6d1c11";
const confirmUrl = (identifier = `userId=${USER_ID}`) => `/?view=confirm-email#${identifier}&token=${encodeURIComponent(TOKEN)}`;

beforeEach(() => {
  clearRecoveryLink();
  resetConfirmRequestsForTests();
  resetSessionBoundaryForTests();
  resetBrowserState("/");
});

afterEach(() => {
  clearRecoveryLink();
  resetConfirmRequestsForTests();
  resetSessionBoundaryForTests();
  resetBrowserState("/");
});

async function renderConfirm(options: AuthBackendOptions = {}, url: string = confirmUrl(), strict = false) {
  window.history.pushState({}, "", url);
  captureRecoveryFragment();
  const api = installAuthBackend({ user: null, ...options });
  render(strict ? <StrictMode><AppRoot /></StrictMode> : <AppRoot />);
  return api;
}

const confirmCalls = (api: Awaited<ReturnType<typeof renderConfirm>>) => api.authCallsTo("POST", "/api/v1/auth/confirm-email");
const resendCalls = (api: Awaited<ReturnType<typeof renderConfirm>>) => api.authCallsTo("POST", "/api/v1/auth/resend-confirmation");

describe("ConfirmEmailScreen — confirmación automática", () => {
  it("al abrir el enlace muestra «Confirmando tu correo…» (aria-busy) y envía {userId, token} una sola vez", async () => {
    const gate = deferred();
    const api = await renderConfirm({ gates: { confirm: gate.promise } });

    expect(await screen.findByRole("heading", { name: "Confirmando tu correo" })).toBeInTheDocument();
    const status = screen.getByText("Confirmando tu correo…");
    expect(status).toHaveAttribute("role", "status");
    expect(status.parentElement).toHaveAttribute("aria-busy", "true");
    await waitFor(() => expect(document.title).toBe("Confirmando tu correo — Vectorify"));
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(TOKEN);

    gate.resolve();
    await screen.findByRole("heading", { name: "Correo confirmado" });
    expect(confirmCalls(api)).toHaveLength(1);
    expect(confirmCalls(api)[0].body).toEqual({ userId: USER_ID, token: TOKEN });
    expect(JSON.stringify(api.calls.map((call) => [call.path, call.search.toString()]))).not.toContain(TOKEN);
  });

  it("StrictMode (doble montaje): UNA sola petición de confirmación", async () => {
    const api = await renderConfirm({}, confirmUrl(), true);

    await screen.findByRole("heading", { name: "Correo confirmado" });

    expect(confirmCalls(api)).toHaveLength(1);
  });

  it("acepta el correo como identificador y lo reenvía tal cual", async () => {
    const api = await renderConfirm({}, confirmUrl("email=ana%40vectorify.test"));

    await screen.findByRole("heading", { name: "Correo confirmado" });

    expect(confirmCalls(api)[0].body).toEqual({ email: "ana@vectorify.test", token: TOKEN });
  });

  it("éxito: «Correo confirmado» con el foco en el h1, un solo h1 y el token fuera de memoria", async () => {
    await renderConfirm();

    const heading = await screen.findByRole("heading", { name: "Correo confirmado" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveTextContent("Listo: confirmamos tu correo. Desde ahora lo podés usar para recuperar el acceso a tu cuenta.");
    await waitFor(() => expect(document.title).toBe("Correo confirmado — Vectorify"));
    expect(readRecoveryLink("confirm-email")).toBeNull();
    expect(document.documentElement.outerHTML).not.toContain(TOKEN);
  });

  it("sin sesión: «Ir a iniciar sesión» lleva al login con el aviso «Confirmaste tu correo»", async () => {
    await renderConfirm();
    const link = await screen.findByRole("link", { name: "Ir a iniciar sesión" });
    expect(link).toHaveClass("auth-button--primary");

    fireEvent.click(link);

    await screen.findByRole("heading", { name: "Iniciar sesión" });
    const banner = document.querySelector<HTMLElement>(".auth-banner")!;
    expect(banner).toHaveTextContent("Confirmaste tu correo. Iniciá sesión para continuar.");
    expect(banner).toHaveClass("status-banner--online");
    await waitFor(() => expect(banner).toHaveFocus());
  });

  it("con sesión: «Ir a Mis proyectos» (la pantalla no redirige sola)", async () => {
    await renderConfirm({ user: ANA });
    const link = await screen.findByRole("link", { name: "Ir a Mis proyectos" });
    expect(screen.queryByRole("link", { name: "Ir a iniciar sesión" })).not.toBeInTheDocument();

    fireEvent.click(link);

    await screen.findByRole("heading", { name: "Mis proyectos" });
    expect(window.location.search).toBe("");
  });

  it("en modo Development redirige: no hay confirmación", async () => {
    const api = await renderConfirm({ user: DEV_USER });

    await screen.findByRole("heading", { name: "Mis proyectos" });
    expect(confirmCalls(api)).toHaveLength(0);
  });
});

describe("ConfirmEmailScreen — enlace no válido", () => {
  it.each([
    ["400 invalid_token", jsonResponse({ code: "invalid_token", message: "x" }, 400)],
    ["otro 400", jsonResponse({ code: "otra_cosa", message: "y" }, 400)],
    ["404", jsonResponse({}, 404)],
  ])("%s: «No pudimos confirmar tu correo» con reenvío, foco en el h1 y el token fuera de memoria", async (_label, response) => {
    await renderConfirm({ confirm: () => response.clone() });

    const heading = await screen.findByRole("heading", { name: "No pudimos confirmar tu correo" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByRole("main")).toHaveTextContent(
      "Puede que el enlace haya vencido, que ya se haya usado o que esté incompleto. Si ya habías confirmado tu correo, no tenés que hacer nada más.",
    );
    expect(screen.getByLabelText("Correo de tu cuenta")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enviar otro enlace" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Volver a iniciar sesión" })).toHaveAttribute("href", "?view=login");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(readRecoveryLink("confirm-email")).toBeNull();
    await waitFor(() => expect(document.title).toBe("No pudimos confirmar tu correo — Vectorify"));
  });

  it("el formulario de reenvío llega con el correo del enlace precargado (cuando el enlace traía correo)", async () => {
    await renderConfirm({ confirm: () => jsonResponse({}, 400) }, confirmUrl("email=ana%40vectorify.test"));

    await screen.findByRole("heading", { name: "No pudimos confirmar tu correo" });

    expect(screen.getByLabelText("Correo de tu cuenta")).toHaveValue("ana@vectorify.test");
  });
});

describe("ConfirmEmailScreen — errores recuperables", () => {
  it.each([
    ["red caída", () => networkFailure(), "No pudimos confirmar tu correo: no hay conexión con el servidor. Revisá tu conexión e intentá de nuevo."],
    ["5xx", () => jsonResponse({}, 503), "El servidor no pudo confirmar tu correo. Intentá de nuevo en unos minutos."],
    ["403", () => jsonResponse({}, 403), "No pudimos verificar la solicitud. Intentá de nuevo."],
    ["429 sin Retry-After", () => jsonResponse({}, 429), "Hiciste demasiados intentos. Esperá unos minutos antes de volver a probar."],
    [
      "429 con Retry-After: 180",
      () => new Response("{}", { status: 429, headers: { "Retry-After": "180" } }),
      "Hiciste demasiados pedidos seguidos. Probá de nuevo en 3 minutos.",
    ],
  ])("%s: alerta + «Tu enlace sigue sirviendo mientras no venza.» + «Reintentar», sin mover el foco", async (_label, respond, text) => {
    await renderConfirm({ confirm: () => respond() });

    expect(await screen.findByRole("alert")).toHaveTextContent(text);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Confirmando tu correo");
    expect(screen.getByText("Tu enlace sigue sirviendo mientras no venza.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reintentar" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).not.toHaveFocus();
  });

  it("«Reintentar» vuelve a enviar (con el mismo token) y, si ahora sirve, pasa a «Correo confirmado» con el foco en el h1", async () => {
    let calls = 0;
    const api = await renderConfirm({ confirm: () => (++calls === 1 ? jsonResponse({}, 503) : new Response(null, { status: 204 })) }, confirmUrl(), true);
    await screen.findByRole("alert");

    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));

    const heading = await screen.findByRole("heading", { name: "Correo confirmado" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(confirmCalls(api)).toHaveLength(2);
    expect(confirmCalls(api)[1].body).toEqual({ userId: USER_ID, token: TOKEN });
  });

  it("al volver la conexión reintenta automáticamente UNA vez", async () => {
    let calls = 0;
    const api = await renderConfirm({ confirm: () => (++calls === 1 ? networkFailure() : new Response(null, { status: 204 })) });
    await screen.findByRole("alert");

    act(() => {
      window.dispatchEvent(new Event("online"));
      window.dispatchEvent(new Event("online"));
    });

    await screen.findByRole("heading", { name: "Correo confirmado" });
    expect(confirmCalls(api)).toHaveLength(2);
  });
});

describe("ConfirmEmailScreen — sin enlace (missing) y reenvío", () => {
  async function renderMissing(options: AuthBackendOptions = {}, url = "/?view=confirm-email") {
    const api = await renderConfirm(options, url);
    await screen.findByRole("heading", { name: "Confirmá tu correo" });
    return api;
  }

  it.each([
    ["sin fragmento", "/?view=confirm-email"],
    ["solo token (sin identificador)", "/?view=confirm-email#token=abc"],
    ["solo identificador (sin token)", `/?view=confirm-email#userId=${USER_ID}`],
    ["fragmento mal formado", "/?view=confirm-email#basura"],
  ])("%s: «Confirmá tu correo» con el formulario de reenvío, sin ninguna petición de confirmación", async (_label, url) => {
    const api = await renderMissing({}, url);

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    await waitFor(() => expect(document.title).toBe("Confirmá tu correo — Vectorify"));
    expect(screen.getByRole("main")).toHaveTextContent("Para confirmar tu correo, abrí el enlace del mensaje que te enviamos al crear la cuenta.");
    expect(screen.getByLabelText("Correo de tu cuenta")).toHaveValue("");
    expect(confirmCalls(api)).toHaveLength(0);
    expect(window.location.hash).toBe("");
  });

  it("desde el login («¿No te llegó el correo…?») llega con el correo escrito precargado y el foco en el h1", async () => {
    installAuthBackend({ user: null });
    window.history.pushState({}, "", "/?view=login");
    render(<AppRoot />);
    await screen.findByRole("heading", { name: "Iniciar sesión" });
    fireEvent.change(screen.getByLabelText("Correo electrónico"), { target: { value: "ana@vectorify.test" } });

    fireEvent.click(screen.getByRole("link", { name: "¿No te llegó el correo para confirmar tu cuenta?" }));

    const heading = await screen.findByRole("heading", { name: "Confirmá tu correo" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByLabelText("Correo de tu cuenta")).toHaveValue("ana@vectorify.test");
    expect(window.location.search).toBe("?view=confirm-email");
  });

  it("reenvío: valida vacío y formato al enviar, con foco en el campo y sin petición", async () => {
    const api = await renderMissing();

    fireEvent.click(screen.getByRole("button", { name: "Enviar otro enlace" }));
    expect(await screen.findByText("Ingresá tu correo electrónico.")).toBeInTheDocument();
    expect(screen.getByLabelText("Correo de tu cuenta")).toHaveFocus();

    fireEvent.change(screen.getByLabelText("Correo de tu cuenta"), { target: { value: "no-es-un-correo" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar otro enlace" }));
    expect(await screen.findByText("Ingresá un correo electrónico válido, por ejemplo nombre@ejemplo.com.")).toBeInTheDocument();
    expect(resendCalls(api)).toHaveLength(0);
  });

  it("reenvío aceptado (202): el banner aparece en la región `status`, el foco NO se mueve y el formulario sigue disponible", async () => {
    const api = await renderMissing();
    const field = screen.getByLabelText("Correo de tu cuenta");
    fireEvent.change(field, { target: { value: "ana@vectorify.test" } });
    const button = screen.getByRole("button", { name: "Enviar otro enlace" });
    button.focus();

    fireEvent.click(button);

    const text = "Pedido recibido. Si hay una cuenta con ese correo pendiente de confirmar, en unos minutos debería llegarte un enlace nuevo.";
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(resendCalls(api)[0].body).toEqual({ email: "ana@vectorify.test" });
    const region = screen.getByText(text).closest("[role='status']") as HTMLElement;
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region.querySelector("[role]")).toBeNull(); // el banner interior no lleva rol
    expect(screen.getByRole("button", { name: "Enviar otro enlace" })).toHaveFocus(); // el foco no se movió
    expect(field).toBeInTheDocument();

    // El banner de éxito se quita al modificar el correo.
    fireEvent.change(field, { target: { value: "otra@vectorify.test" } });
    expect(screen.queryByText(text)).not.toBeInTheDocument();
  });

  it("la región de estado existe (vacía) antes de cualquier envío: es persistente", async () => {
    await renderMissing();

    const regions = document.querySelectorAll(".auth-status[role='status']");
    expect(regions).toHaveLength(1);
    expect(regions[0].childElementCount).toBe(0);
  });

  it.each([
    ["red caída", () => networkFailure(), "No se pudo contactar con el servidor. Revisá tu conexión e intentá de nuevo."],
    ["5xx", () => jsonResponse({}, 502), "El servidor no pudo recibir el pedido. Intentá de nuevo en unos minutos."],
    ["403", () => jsonResponse({}, 403), "No pudimos verificar la solicitud. Recargá la página e intentá de nuevo."],
    [
      "429 con Retry-After: 60",
      () => new Response("{}", { status: 429, headers: { "Retry-After": "60" } }),
      "Hiciste demasiados pedidos seguidos. Probá de nuevo en 1 minuto.",
    ],
    ["400 sin código", () => jsonResponse({ code: "x", message: "x" }, 400), "No pudimos procesar el pedido con esos datos. Revisá el correo e intentá de nuevo."],
  ])("reenvío con %s: alerta, foco donde estaba y correo conservado", async (_label, respond, text) => {
    await renderMissing({ resend: () => respond() });
    fireEvent.change(screen.getByLabelText("Correo de tu cuenta"), { target: { value: "ana@vectorify.test" } });
    const button = screen.getByRole("button", { name: "Enviar otro enlace" });
    button.focus();

    fireEvent.click(button);

    expect(await screen.findByRole("alert")).toHaveTextContent(text);
    expect(screen.getByLabelText("Correo de tu cuenta")).toHaveValue("ana@vectorify.test");
    expect(screen.getByRole("button", { name: "Enviar otro enlace" })).toHaveFocus();
  });

  it("reenvío con 400 invalid_email: el mensaje del servidor va en el campo", async () => {
    await renderMissing({ resend: () => jsonResponse({ code: "invalid_email", message: "Indicá un correo electrónico válido." }, 400) });
    fireEvent.change(screen.getByLabelText("Correo de tu cuenta"), { target: { value: "ana@vectorify.test" } });

    fireEvent.click(screen.getByRole("button", { name: "Enviar otro enlace" }));

    expect(await screen.findByText("Indicá un correo electrónico válido.")).toBeInTheDocument();
    expect(screen.getByLabelText("Correo de tu cuenta")).toHaveFocus();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("durante el reenvío: aria-busy, solo lectura, «Enviando…» y envíos extra ignorados", async () => {
    const gate = deferred();
    const api = await renderMissing({ gates: { resend: gate.promise } });
    fireEvent.change(screen.getByLabelText("Correo de tu cuenta"), { target: { value: "ana@vectorify.test" } });

    fireEvent.click(screen.getByRole("button", { name: "Enviar otro enlace" }));
    await screen.findByRole("button", { name: /Enviando…/ });

    expect(screen.getByLabelText("Correo de tu cuenta")).toHaveAttribute("readonly");
    fireEvent.click(screen.getByRole("button", { name: /Enviando…/ }));
    fireEvent.submit(document.querySelector("form")!);
    expect(resendCalls(api)).toHaveLength(1);
    gate.resolve();
    await screen.findByText(/Pedido recibido\. Si hay una cuenta/);
  });
});

describe("ConfirmEmailScreen — enlace pegado en una pestaña que ya está en la vista", () => {
  it("hashchange: confirma con el enlace nuevo", async () => {
    const api = await renderConfirm({}, "/?view=confirm-email");
    await screen.findByRole("heading", { name: "Confirmá tu correo" });

    act(() => {
      window.history.pushState({}, "", `/?view=confirm-email#userId=${USER_ID}&token=NUEVO`);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });

    await screen.findByRole("heading", { name: "Correo confirmado" });
    expect(confirmCalls(api)[0].body).toEqual({ userId: USER_ID, token: "NUEVO" });
    expect(window.location.hash).toBe("");
  });
});
