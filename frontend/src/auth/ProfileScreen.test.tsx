import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppRoot } from "../AppRoot";
import { resetSessionBoundaryForTests } from "../api/sessionBoundary";
import { jsonResponse } from "../components/projects/projectsTestSupport";
import {
  ANA,
  DEV_USER,
  GOOD_PASSWORD,
  deferred,
  installAuthBackend,
  networkFailure,
  resetBrowserState,
  type AuthBackendOptions,
} from "./authTestSupport";

/** M3.1-S07: pantalla «Mi cuenta» (DESIGN.md §5.4–5.14, §6, §9.7). Se monta la app completa en `?view=account`. */

beforeEach(() => {
  resetSessionBoundaryForTests();
  resetBrowserState("/?view=account");
});

afterEach(() => {
  vi.restoreAllMocks();
  resetSessionBoundaryForTests();
  resetBrowserState("/");
});

async function renderAccount(options: AuthBackendOptions = {}, url = "/?view=account") {
  window.history.pushState({}, "", url);
  const api = installAuthBackend(options);
  render(<AppRoot />);
  return api;
}

async function renderReady(options: AuthBackendOptions = {}) {
  const api = await renderAccount(options);
  await screen.findByRole("textbox", { name: "Nombre para mostrar" });
  return api;
}

const nameInput = () => screen.getByRole("textbox", { name: "Nombre para mostrar" }) as HTMLInputElement;
const saveButton = () => screen.getByRole("button", { name: /^(Guardar cambios|Guardando…)$/ });
const discardButton = () => screen.getByRole("button", { name: "Descartar cambios" });
const form = () => document.querySelector("form.profile-form") as HTMLFormElement;
const type = (value: string) => fireEvent.change(nameInput(), { target: { value } });
const alertText = () => screen.getByRole("alert").textContent;

describe("ProfileScreen — estructura y accesibilidad", () => {
  it("un h1 «Mi cuenta», tres h2 con secciones nombradas (Perfil, Cuenta de acceso, Contraseña), un main, un banner y título de documento", async () => {
    await renderReady();

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Mi cuenta" })).toHaveAttribute("tabindex", "-1");
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(["Perfil", "Cuenta de acceso", "Contraseña"]);
    expect(screen.queryAllByRole("heading", { level: 3 })).toHaveLength(0);
    expect(screen.getByRole("region", { name: "Perfil" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Cuenta de acceso" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Contraseña" })).toBeInTheDocument();
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.getAllByRole("banner")).toHaveLength(1);
    expect(document.title).toBe("Mi cuenta — Vectorify");
    expect(screen.getByText("Revisá cómo te mostramos en VECTORiZE y con qué datos entrás.")).toBeInTheDocument();
  });

  it("el campo del nombre está etiquetado, es requerido, sin maxLength, con autocomplete=nickname y descripción accesible", async () => {
    await renderReady();

    expect(nameInput()).toBeRequired();
    expect(nameInput()).toHaveValue("Ana Gómez");
    expect(nameInput()).toHaveAttribute("type", "text");
    expect(nameInput()).toHaveAttribute("autocomplete", "nickname");
    expect(nameInput()).toHaveAttribute("autocapitalize", "words");
    expect(nameInput()).toHaveAttribute("spellcheck", "false");
    expect(nameInput()).not.toHaveAttribute("maxlength");
    expect(nameInput()).toHaveAccessibleDescription(/Entre 1 y 80 caracteres/);
    expect(form()).toHaveAttribute("novalidate");
    expect(form()).toHaveAttribute("aria-busy", "false");
  });

  it("el correo y la fecha son información (lista de definición), no controles: sin textbox de correo y con la explicación", async () => {
    await renderReady();

    expect(screen.queryByRole("textbox", { name: /correo/i })).not.toBeInTheDocument();
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    const facts = document.querySelector("dl.profile-facts") as HTMLElement;
    expect(within(facts).getByText("Correo electrónico").tagName).toBe("DT");
    expect(within(facts).getByText("ana@vectorify.test")).toBeInTheDocument();
    expect(within(facts).getByText("Tu correo se gestiona con tu cuenta y no se puede cambiar desde esta pantalla.")).toBeInTheDocument();
    expect(within(facts).getByText("Cuenta creada el")).toBeInTheDocument();
    const time = facts.querySelector("time") as HTMLTimeElement;
    expect(time).toHaveAttribute("datetime", "2026-10-15T14:32:00Z");
    expect(time.textContent).toMatch(/^1[56] de octubre de 2026$/);
  });

  it("si createdAt no llega o no es una fecha, el par de la fecha no se renderiza; sin correo dice «Sin correo asociado»", async () => {
    await renderReady({ profile: { createdAt: null, email: null } });

    expect(screen.queryByText("Cuenta creada el")).not.toBeInTheDocument();
    expect(document.querySelector("time")).toBeNull();
    expect(screen.getByText("Sin correo asociado")).toBeInTheDocument();
  });

  it("una fecha inválida tampoco se muestra", async () => {
    await renderReady({ profile: { createdAt: "no-es-una-fecha" } });

    expect(screen.queryByText("Cuenta creada el")).not.toBeInTheDocument();
  });

  it("nunca muestra el id interno del usuario ni proveedor/subject", async () => {
    await renderReady();

    const text = document.body.textContent ?? "";
    expect(text).not.toContain(ANA.id);
    expect(text).not.toMatch(/provider|subject|aspnet/i);
  });

  it("no promete nada fuera de alcance: sin cambio de correo, avatar, preferencias, supresión ni exportación (el cambio de contraseña llegó en S08)", async () => {
    await renderReady();

    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/avatar|preferencias|idioma|elimin|borrar cuenta|suprim|exportar|próximamente|pronto/i);
    expect(text).not.toMatch(/MFA|verificación en dos pasos|autenticación de dos factores|confirmado|sin confirmar/i); // fuera de alcance: MFA y estado de confirmación del correo
    expect(screen.queryByRole("button", { name: /correo/i })).not.toBeInTheDocument();
  });

  it("orden de tabulación: trigger del menú -> volver -> campo -> Guardar -> Descartar -> contraseña actual -> nueva -> repetir -> Cambiar contraseña; sin tabindex positivo", async () => {
    await renderReady();
    type("Otro nombre");

    const focusables = Array.from(document.querySelectorAll<HTMLElement>("a[href], button, input, [tabindex]")).filter(
      (element) => element.getAttribute("tabindex") !== "-1" && !element.hidden, // el campo de usuario oculto no es una parada de tabulación
    );
    expect(focusables.map((element) => element.getAttribute("aria-label") ?? element.textContent?.trim() ?? element.tagName)).toEqual([
      expect.stringContaining("Ana Gómez"),
      "← Volver a Mis proyectos",
      "",
      "Guardar cambios",
      "Descartar cambios",
      "", // contraseña actual
      "", // contraseña nueva
      "", // repetir
      "Cambiar contraseña",
    ]);
    expect(document.querySelectorAll("[tabindex]:not([tabindex='-1']):not([tabindex='0'])")).toHaveLength(0);
  });
});

describe("ProfileScreen — carga del perfil", () => {
  it("muestra «Cargando tu perfil…» (aria-busy) con la cabecera de página ya pintada, y pide GET /api/v1/me una sola vez", async () => {
    const gate = deferred();
    const api = await renderAccount({ gates: { profile: gate.promise } });

    expect(await screen.findByRole("heading", { level: 1, name: "Mi cuenta" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Volver a Mis proyectos" })).toBeInTheDocument();
    const loading = screen.getByText("Cargando tu perfil…");
    expect(loading).toHaveAttribute("role", "status");
    expect(loading.parentElement).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();

    gate.resolve();
    expect(await screen.findByRole("textbox", { name: "Nombre para mostrar" })).toBeInTheDocument();
    expect(screen.queryByText("Cargando tu perfil…")).not.toBeInTheDocument();
    expect(api.profileCallsTo("GET")).toHaveLength(1);
    expect(api.authCallsTo("GET", "/api/v1/auth/me")).toHaveLength(1); // solo la consulta de sesión inicial
  });

  it.each([
    ["red caída", () => networkFailure(), "No pudimos cargar tu perfil: no hay conexión con el servidor. Revisá tu conexión e intentá de nuevo."],
    ["5xx con código", () => jsonResponse({}, 503), "El servidor no pudo cargar tu perfil (código 503). Intentá de nuevo en unos minutos."],
    [
      "respuesta ilegible",
      () => new Response("<html>proxy</html>", { status: 200 }),
      "El servidor no pudo cargar tu perfil. Intentá de nuevo en unos minutos.",
    ],
    ["403", () => jsonResponse({ code: "csrf_rejected", message: "x" }, 403), "El servidor rechazó la solicitud (código 403). Recargá la página e intentá de nuevo."],
    ["otro 4xx", () => jsonResponse({ code: "x", message: "x" }, 404), "No pudimos cargar tu perfil. Recargá la página e intentá de nuevo."],
  ])("%s: alerta con su texto exacto, «Esto no cierra tu sesión.» y «Reintentar»; no es sesión cerrada", async (_label, respond, text) => {
    await renderAccount({ profile: { get: () => respond() } });

    expect(await screen.findByRole("alert")).toHaveTextContent(text);
    expect(screen.getByText("Esto no cierra tu sesión.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reintentar" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Iniciar sesión" })).not.toBeInTheDocument();
    expect(window.location.search).toBe("?view=account");
  });

  it("reintento: «Reintentando…» sin alerta; si sale bien, la pantalla queda lista y el foco va al h1; si falla, el foco se queda en «Reintentar»", async () => {
    const gate = deferred();
    let attempt = 0;
    const api = await renderAccount({
      profile: {
        get: () => {
          const index = attempt++;
          if (index === 0) return jsonResponse({}, 503); // carga inicial: falla
          if (index === 1) return gate.promise.then(() => jsonResponse({}, 503)); // primer reintento: retenido, luego falla
          return undefined; // segundo reintento: el perfil en memoria
        },
      },
    });
    const retry = await screen.findByRole("button", { name: "Reintentar" });
    retry.focus();

    fireEvent.click(retry);
    const busy = await screen.findByRole("button", { name: "Reintentando…" });
    expect(busy).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    gate.resolve();
    // Reintento fallido: alerta remontada y el foco sigue en el botón.
    expect(await screen.findByRole("alert")).toHaveTextContent("código 503");
    expect(screen.getByRole("button", { name: "Reintentar" })).toHaveFocus();

    // Reintento correcto: el botón desaparece y el foco no cae en el body.
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(await screen.findByRole("textbox", { name: "Nombre para mostrar" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Mi cuenta" })).toHaveFocus();
    expect(api.profileCallsTo("GET")).toHaveLength(3);
  });

  it("al volver la conexión (evento online) estando en error se reintenta automáticamente una vez", async () => {
    let first = true;
    const api = await renderAccount({
      profile: {
        get: () => {
          if (first) {
            first = false;
            return networkFailure();
          }
          return undefined;
        },
      },
    });
    await screen.findByRole("alert");

    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });

    expect(await screen.findByRole("textbox", { name: "Nombre para mostrar" })).toBeInTheDocument();
    expect(api.profileCallsTo("GET")).toHaveLength(2);
  });

  it("401 al cargar: no hay alerta propia; la frontera lleva al login con el aviso «Tu sesión terminó…» y returnUrl de esta pantalla", async () => {
    await renderAccount({
      profile: { get: () => jsonResponse({ code: "unauthenticated", message: "x" }, 401) },
    });

    expect(await screen.findByRole("heading", { name: "Iniciar sesión" })).toBeInTheDocument();
    expect(screen.queryByText(/No pudimos cargar tu perfil/)).not.toBeInTheDocument();
    expect(window.location.search).toBe(`?view=login&returnUrl=${encodeURIComponent("/?view=account")}`);
    expect(screen.getByText("Tu sesión terminó. Iniciá sesión de nuevo para continuar.")).toBeInTheDocument();
  });
});

describe("ProfileScreen — ruta protegida y deep link", () => {
  it("sin sesión: nunca se pinta «Mi cuenta»; redirige al login con returnUrl=/?view=account y el aviso «Iniciá sesión para continuar…»", async () => {
    const api = await renderAccount({ user: null });

    expect(await screen.findByRole("heading", { name: "Iniciar sesión" })).toBeInTheDocument();
    expect(window.location.search).toBe(`?view=login&returnUrl=${encodeURIComponent("/?view=account")}`);
    expect(screen.queryByRole("heading", { name: "Mi cuenta" })).not.toBeInTheDocument();
    expect(screen.getByText(/Iniciá sesión para continuar/)).toBeInTheDocument();
    expect(api.profileCalls).toHaveLength(0); // ni siquiera se pidió el perfil
  });

  it("deep link sin sesión => login => vuelve a «Mi cuenta» con el foco en el h1", async () => {
    const api = await renderAccount({ user: null });
    await screen.findByRole("heading", { name: "Iniciar sesión" });

    fireEvent.change(screen.getByLabelText("Correo electrónico"), { target: { value: ANA.email } });
    fireEvent.change(screen.getByLabelText("Contraseña"), { target: { value: GOOD_PASSWORD } });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar sesión" }));

    expect(await screen.findByRole("textbox", { name: "Nombre para mostrar" })).toBeInTheDocument();
    expect(window.location.search).toBe("?view=account");
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Mi cuenta" })).toHaveFocus());
    expect(api.profileCallsTo("GET")).toHaveLength(1);
  });

  it("con error de sesión (no 401) no se redirige: se muestra el panel de reintento de la sesión", async () => {
    await renderAccount({ me: 503 });

    expect(await screen.findByRole("heading", { name: "No pudimos comprobar tu sesión" })).toBeInTheDocument();
    expect(window.location.search).toBe("?view=account");
  });

  it("una carga directa o recarga con sesión no mueve el foco", async () => {
    await renderReady();

    expect(document.body).toHaveFocus();
  });

  it("el botón atrás desde «Mi cuenta» vuelve a Mis proyectos (popstate)", async () => {
    window.history.pushState({}, "", "/");
    await renderAccount();
    await screen.findByRole("textbox", { name: "Nombre para mostrar" });

    await act(async () => {
      window.history.pushState({}, "", "/");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(await screen.findByRole("heading", { name: "Mis proyectos" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Mi cuenta" })).not.toBeInTheDocument();
  });
});

describe("ProfileForm — estados", () => {
  it("sin cambios: «Guardar cambios» inactivo (aria-disabled, enfocable, no disabled), sin «Descartar cambios», contador y Enter no hacen nada", async () => {
    const api = await renderReady();

    expect(saveButton()).toHaveAttribute("aria-disabled", "true");
    expect(saveButton()).not.toBeDisabled();
    expect(saveButton().className).toContain("auth-button--inactive");
    saveButton().focus();
    expect(saveButton()).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Descartar cambios" })).not.toBeInTheDocument();
    expect(document.querySelector(".profile-field__count")).toHaveTextContent("9/80");
    expect(document.querySelector(".profile-field__count")).toHaveAttribute("aria-hidden", "true");

    fireEvent.click(saveButton());
    fireEvent.submit(form());
    expect(api.profileCallsTo("PATCH")).toHaveLength(0);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("al editar: «Guardar cambios» se activa, aparece «Descartar cambios» y el contador sigue lo escrito", async () => {
    await renderReady();

    type("Ana María Gómez");

    expect(saveButton()).not.toHaveAttribute("aria-disabled");
    expect(discardButton()).toBeInTheDocument();
    expect(document.querySelector(".profile-field__count")).toHaveTextContent("15/80");
  });

  it("agregar o quitar solo espacios en los extremos no cuenta como cambio", async () => {
    await renderReady();

    type("  Ana Gómez  ");

    expect(saveButton()).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("button", { name: "Descartar cambios" })).not.toBeInTheDocument();
    expect(document.querySelector(".profile-field__count")).toHaveTextContent("9/80");
  });

  it.each([
    ["vacío", "", "Escribí un nombre para mostrar."],
    ["solo espacios", "     ", "Escribí un nombre para mostrar."],
    ["81 caracteres", "x".repeat(81), "El nombre para mostrar puede tener hasta 80 caracteres. Ahora tiene 81."],
    ["93 caracteres (largo real recortado)", `  ${"y".repeat(93)}  `, "El nombre para mostrar puede tener hasta 80 caracteres. Ahora tiene 93."],
    ["un tabulador pegado", "Ana\tGómez", "El nombre para mostrar no puede tener tabulaciones, saltos de línea ni otros caracteres de control."],
    ["un carácter de control C1", "Ana\u0085Gómez", "El nombre para mostrar no puede tener tabulaciones, saltos de línea ni otros caracteres de control."],
  ])("validación al enviar (%s): mensaje exacto, aria-invalid, foco en el campo y SIN petición", async (_label, value, message) => {
    const api = await renderReady();
    type(value);
    expect(screen.queryByText(message)).not.toBeInTheDocument(); // nunca mientras se escribe
    saveButton().focus();

    fireEvent.submit(form());

    const error = await screen.findByText(message);
    expect(error).toHaveClass("auth-field__error");
    expect(nameInput()).toHaveAttribute("aria-invalid", "true");
    expect(nameInput()).toHaveAccessibleDescription(new RegExp(`Entre 1 y 80 caracteres.*${message.slice(0, 20)}`));
    expect(nameInput()).toHaveFocus();
    expect(nameInput()).toHaveValue(value);
    expect(api.profileCallsTo("PATCH")).toHaveLength(0);

    // El error se quita al modificar el campo.
    type(`${value}a`);
    expect(screen.queryByText(message)).not.toBeInTheDocument();
    expect(nameInput()).not.toHaveAttribute("aria-invalid");
  });

  it("el contador pasa a error (clase) cuando excede 80 pero el campo no se trunca", async () => {
    await renderReady();

    type("z".repeat(100));

    expect(nameInput()).toHaveValue("z".repeat(100));
    expect(document.querySelector(".profile-field__count")).toHaveTextContent("100/80");
    expect(document.querySelector(".profile-field__count")).toHaveClass("profile-field__count--over");
  });

  it("«Descartar cambios» repone el valor guardado, quita error y aviso, lleva el foco al campo y lo anuncia en la región oculta", async () => {
    await renderReady();
    type("");
    fireEvent.submit(form());
    await screen.findByText("Escribí un nombre para mostrar.");
    type("Otro");
    discardButton().focus();

    fireEvent.click(discardButton());

    expect(nameInput()).toHaveValue("Ana Gómez");
    expect(nameInput()).toHaveFocus();
    expect(screen.queryByText("Escribí un nombre para mostrar.")).not.toBeInTheDocument();
    expect(screen.getByText("Descartaste los cambios.")).toHaveClass("auth-visually-hidden");
    expect(screen.queryByRole("button", { name: "Descartar cambios" })).not.toBeInTheDocument();
    expect(saveButton()).toHaveAttribute("aria-disabled", "true");

    type("Otro más"); // el anuncio se limpia al volver a editar
    expect(screen.queryByText("Descartaste los cambios.")).not.toBeInTheDocument();
  });
});

describe("ProfileForm — guardado", () => {
  it("envía SOLO { displayName } recortado con PATCH /api/v1/me, muestra lo que devolvió el servidor y confirma en la región viva", async () => {
    const api = await renderReady();
    nameInput().focus();
    type("  Ana María  ");

    fireEvent.click(saveButton());

    await waitFor(() => expect(api.profileCallsTo("PATCH")).toHaveLength(1));
    expect(api.profileCallsTo("PATCH")[0].body).toEqual({ displayName: "Ana María" });
    expect(await screen.findByText("Guardamos tu nombre para mostrar.")).toBeInTheDocument();
    const region = screen.getByText("Guardamos tu nombre para mostrar.").closest("[role='status']") as HTMLElement;
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region.className).toContain("profile-status");
    expect(nameInput()).toHaveValue("Ana María");
    expect(saveButton()).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("button", { name: "Descartar cambios" })).not.toBeInTheDocument();
    expect(form()).toHaveAttribute("aria-busy", "false");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("el foco no se mueve al guardar; la región de confirmación existe (vacía) antes de guardar", async () => {
    await renderReady();
    expect(document.querySelector(".profile-status")).toBeEmptyDOMElement();
    type("Nuevo nombre");
    saveButton().focus();

    fireEvent.click(saveButton());
    await screen.findByText("Guardamos tu nombre para mostrar.");

    expect(saveButton()).toHaveFocus();
  });

  it("si el foco estaba en «Descartar cambios» (que desaparece), pasa al campo", async () => {
    await renderReady();
    type("Nuevo nombre");
    discardButton().focus();

    fireEvent.submit(form());
    await screen.findByText("Guardamos tu nombre para mostrar.");

    expect(nameInput()).toHaveFocus();
  });

  it("el nombre del menú cambia al guardar, SIN volver a pedir GET /api/v1/auth/me", async () => {
    const api = await renderReady();
    expect(screen.getByRole("button", { name: "Menú de cuenta: Ana Gómez" })).toBeInTheDocument();
    const before = api.authCallsTo("GET", "/api/v1/auth/me").length;

    type("Beatriz");
    fireEvent.click(saveButton());

    const trigger = await screen.findByRole("button", { name: "Menú de cuenta: Beatriz" });
    expect(trigger.querySelector(".user-menu__avatar")).toHaveTextContent("B");
    expect(api.authCallsTo("GET", "/api/v1/auth/me")).toHaveLength(before);
  });

  it("mientras guarda: aria-busy, campo de solo lectura (enfocable), «Guardando…» aria-disabled, «Descartar» inactivo, anuncio oculto; los envíos extra se ignoran", async () => {
    const gate = deferred();
    const api = await renderReady({ gates: { profileSave: gate.promise } });
    type("Nombre lento");
    nameInput().focus();

    fireEvent.click(saveButton());

    await waitFor(() => expect(form()).toHaveAttribute("aria-busy", "true"));
    expect(nameInput()).toHaveAttribute("readonly");
    expect(nameInput()).toHaveFocus();
    expect(saveButton()).toHaveTextContent("Guardando…");
    expect(saveButton()).toHaveAttribute("aria-disabled", "true");
    expect(discardButton()).toHaveAttribute("aria-disabled", "true");
    expect(screen.getAllByText("Guardando…").some((node) => node.classList.contains("auth-visually-hidden"))).toBe(true);

    fireEvent.click(saveButton());
    fireEvent.submit(form());
    fireEvent.click(discardButton());
    expect(nameInput()).toHaveValue("Nombre lento"); // descartar se ignora durante el guardado
    expect(api.profileCallsTo("PATCH")).toHaveLength(1);

    gate.resolve();
    await screen.findByText("Guardamos tu nombre para mostrar.");
    expect(nameInput()).not.toHaveAttribute("readonly");
  });

  it("la confirmación se quita al volver a editar y no desaparece por tiempo", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await renderReady();
      type("Persistente");
      fireEvent.click(saveButton());
      await screen.findByText("Guardamos tu nombre para mostrar.");

      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      expect(screen.getByText("Guardamos tu nombre para mostrar.")).toBeInTheDocument();

      type("Persistente 2");
      expect(screen.queryByText("Guardamos tu nombre para mostrar.")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ProfileForm — errores al guardar (se conserva lo escrito y el foco)", () => {
  it.each([
    [
      "red caída",
      () => networkFailure(),
      "No pudimos guardar el cambio: no hay conexión con el servidor. Lo que escribiste sigue acá; revisá tu conexión e intentá de nuevo.",
    ],
    [
      "5xx con código",
      () => jsonResponse({}, 503),
      "El servidor no pudo guardar el cambio (código 503). Lo que escribiste sigue acá; intentá de nuevo en unos minutos.",
    ],
    [
      "respuesta ilegible",
      () => new Response("<html>proxy</html>", { status: 200 }),
      "El servidor no pudo guardar el cambio. Lo que escribiste sigue acá; intentá de nuevo en unos minutos.",
    ],
    [
      "403",
      () => jsonResponse({ code: "csrf_rejected", message: "x" }, 403),
      "El servidor rechazó el cambio (código 403) y no se guardó. Intentá de nuevo; si vuelve a pasar, copiá el nombre que escribiste y recargá la página.",
    ],
    ["429", () => jsonResponse({ code: "rate_limited", message: "x" }, 429), "Hiciste demasiados intentos. Esperá unos minutos antes de volver a probar."],
    [
      "otro 400",
      () => jsonResponse({ code: "invalid_request", message: "x" }, 400),
      "No pudimos guardar el nombre con esos datos. Revisalo e intentá de nuevo.",
    ],
  ])("%s: alerta con su texto exacto, el campo conserva exactamente lo escrito, sigue habiendo cambios y el foco no se movió", async (_label, respond, text) => {
    const api = await renderReady({ profile: { patch: () => respond() } });
    type("  Lo que escribí  ");
    saveButton().focus();

    fireEvent.click(saveButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(text);
    expect(nameInput()).toHaveValue("  Lo que escribí  "); // ni recortado ni repuesto
    expect(nameInput()).not.toHaveAttribute("readonly");
    expect(form()).toHaveAttribute("aria-busy", "false");
    expect(saveButton()).not.toHaveAttribute("aria-disabled");
    expect(saveButton()).toHaveFocus();
    expect(discardButton()).toBeInTheDocument();
    expect(screen.queryByText("Guardamos tu nombre para mostrar.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Menú de cuenta: Ana Gómez" })).toBeInTheDocument(); // el menú no cambió
    expect(window.location.search).toBe("?view=account"); // un 403 no cierra la sesión ni redirige
    expect(api.profileCallsTo("PATCH")).toHaveLength(1);
  });

  it("cada error distinto usa su propio alert; al reintentar con éxito la alerta desaparece", async () => {
    const answers = [() => networkFailure(), () => jsonResponse({}, 503), () => undefined];
    const api = await renderReady({ profile: { patch: () => answers.shift()?.() } });
    type("Reintento");

    fireEvent.click(saveButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("no hay conexión con el servidor");

    fireEvent.click(saveButton());
    await waitFor(() => expect(alertText()).toContain("código 503"));

    fireEvent.click(saveButton());
    await screen.findByText("Guardamos tu nombre para mostrar.");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(api.profileCallsTo("PATCH")).toHaveLength(3);
  });

  it("el mismo error repetido se vuelve a anunciar (la alerta se remonta)", async () => {
    await renderReady({ profile: { patch: () => jsonResponse({}, 503) } });
    type("Mismo error");

    fireEvent.click(saveButton());
    const first = await screen.findByRole("alert");
    fireEvent.click(saveButton());

    await waitFor(() => expect(screen.getByRole("alert")).not.toBe(first));
    expect(screen.getByRole("alert")).toHaveTextContent("código 503");
  });

  it("400 invalid_display_name del servidor: el message va TAL CUAL como error del campo, con foco en el input y lo escrito intacto", async () => {
    await renderReady({
      profile: {
        patch: () => jsonResponse({ code: "invalid_display_name", message: "El nombre para mostrar debe tener entre 1 y 80 caracteres." }, 400),
      },
    });
    type("Nombre");
    saveButton().focus();

    fireEvent.click(saveButton());

    expect(await screen.findByText("El nombre para mostrar debe tener entre 1 y 80 caracteres.")).toHaveClass("auth-field__error");
    expect(nameInput()).toHaveAttribute("aria-invalid", "true");
    expect(nameInput()).toHaveFocus();
    expect(nameInput()).toHaveValue("Nombre");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("401 al guardar: sin alerta propia; la frontera lleva al login con el aviso de sesión terminada y returnUrl de esta pantalla", async () => {
    await renderReady({ profile: { patch: () => jsonResponse({ code: "unauthenticated", message: "x" }, 401) } });
    type("Se pierde");

    fireEvent.click(saveButton());

    expect(await screen.findByRole("heading", { name: "Iniciar sesión" })).toBeInTheDocument();
    expect(window.location.search).toBe(`?view=login&returnUrl=${encodeURIComponent("/?view=account")}`);
    expect(screen.queryByText(/No pudimos guardar/)).not.toBeInTheDocument();
    expect(screen.getByText("Tu sesión terminó. Iniciá sesión de nuevo para continuar.")).toBeInTheDocument();
  });

  it("al salir de la pantalla durante un guardado en curso se aborta la petición sin errores", async () => {
    const gate = deferred();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await renderReady({ gates: { profileSave: gate.promise } });
    type("Nombre lento");
    fireEvent.click(saveButton());
    await waitFor(() => expect(form()).toHaveAttribute("aria-busy", "true"));

    fireEvent.click(screen.getByRole("link", { name: "Volver a Mis proyectos" }));
    expect(await screen.findByRole("heading", { name: "Mis proyectos" })).toBeInTheDocument();
    await act(async () => {
      gate.resolve();
    });

    expect(errors).not.toHaveBeenCalled();
  });
});

describe("Mi cuenta — enlace de vuelta", () => {
  it("clic izquierdo: vuelve a Mis proyectos sin recargar y el foco va al h2 «Mis proyectos»", async () => {
    await renderReady();
    const back = screen.getByRole("link", { name: "Volver a Mis proyectos" });
    expect(back).toHaveAttribute("href", window.location.pathname);

    fireEvent.click(back);

    const heading = await screen.findByRole("heading", { name: "Mis proyectos" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(window.location.search).toBe("");
  });

  it("clic central y Ctrl/Cmd/Mayús+clic NO se interceptan (el navegador abre otra pestaña): la pantalla no cambia", async () => {
    await renderReady();
    const back = screen.getByRole("link", { name: "Volver a Mis proyectos" });

    for (const init of [{ button: 1 }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }]) {
      const proceeded = fireEvent.click(back, init); // false si alguien llamó a preventDefault
      expect(proceeded, JSON.stringify(init)).toBe(true);
    }

    expect(window.location.search).toBe("?view=account");
    expect(screen.getByRole("heading", { level: 1, name: "Mi cuenta" })).toBeInTheDocument();
  });
});

describe("Mi cuenta — modo Development", () => {
  async function renderDev(options: AuthBackendOptions = {}) {
    const api = await renderAccount({ user: DEV_USER, ...options });
    await screen.findByRole("textbox", { name: "Nombre para mostrar" });
    return api;
  }

  it("pastilla «Modo desarrollo» + enlace «Mi cuenta: Dev User» (aria-current), sin menú ni «Salir», y el aviso del modo antes del Perfil", async () => {
    await renderDev();

    expect(screen.getByText("Modo desarrollo")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Mi cuenta: Dev User" });
    expect(link).toHaveAttribute("aria-current", "page");
    expect(link).toHaveAttribute("href", `${window.location.pathname}?view=account`);
    expect(link.querySelector(".user-menu__avatar")).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("button", { name: /Menú de cuenta/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Salir")).not.toBeInTheDocument();

    const notice = screen.getByText(/Estás en modo desarrollo: usás el usuario de desarrollo, sin iniciar sesión\./);
    expect(notice.closest("[role]")).toBeNull();
    expect(notice.compareDocumentPosition(screen.getByRole("region", { name: "Perfil" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("Son los datos del usuario de desarrollo configurado en el servidor.")).toBeInTheDocument();
    expect(screen.getByText(/En modo desarrollo el correo es el del usuario de desarrollo/)).toBeInTheDocument();
    expect(screen.queryByText(/Son los datos con los que iniciás sesión/)).not.toBeInTheDocument();
  });

  it("el usuario de desarrollo guarda su nombre y el enlace lo muestra sin pedir /auth/me otra vez", async () => {
    const api = await renderDev();
    const before = api.authCallsTo("GET", "/api/v1/auth/me").length;

    type("Dev renombrado");
    fireEvent.click(saveButton());

    expect(await screen.findByRole("link", { name: "Mi cuenta: Dev renombrado" })).toBeInTheDocument();
    expect(screen.getByText("Guardamos tu nombre para mostrar.")).toBeInTheDocument();
    expect(api.authCallsTo("GET", "/api/v1/auth/me")).toHaveLength(before);
    expect(api.profileCallsTo("PATCH")[0].body).toEqual({ displayName: "Dev renombrado" });
  });

  it("desde Mis proyectos, el nombre es un enlace a «Mi cuenta» (clic izquierdo navega y enfoca el h1)", async () => {
    resetBrowserState("/");
    installAuthBackend({ user: DEV_USER });
    render(<AppRoot />);
    const link = await screen.findByRole("link", { name: "Mi cuenta: Dev User" });
    expect(link).not.toHaveAttribute("aria-current");

    fireEvent.click(link);

    const heading = await screen.findByRole("heading", { level: 1, name: "Mi cuenta" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(window.location.search).toBe("?view=account");
  });

  it("estando ya en «Mi cuenta», activar el enlace no navega y lleva el foco al h1; Ctrl+clic no se intercepta", async () => {
    await renderDev();
    const link = screen.getByRole("link", { name: "Mi cuenta: Dev User" });
    nameInput().focus();

    expect(fireEvent.click(link, { ctrlKey: true })).toBe(true);
    expect(nameInput()).toHaveFocus();

    expect(fireEvent.click(link)).toBe(false);
    expect(screen.getByRole("heading", { level: 1, name: "Mi cuenta" })).toHaveFocus();
    expect(window.location.search).toBe("?view=account");
  });
});
