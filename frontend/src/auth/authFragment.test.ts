import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import mainSource from "../main.tsx?raw";
import {
  captureRecoveryFragment,
  clearRecoveryLink,
  getRecoveryLinkGeneration,
  readRecoveryLink,
  subscribeRecoveryLink,
} from "./authFragment";

/** M3.1-S08: captura y borrado inmediato del token del fragmento de los enlaces de correo (DESIGN §6.1). */

const TOKEN = "CfDJ8N+/abc==_token-secreto";

function openLink(url: string) {
  window.history.pushState({ keep: "me" }, "", url);
  captureRecoveryFragment();
}

beforeEach(() => {
  clearRecoveryLink();
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  vi.restoreAllMocks();
  clearRecoveryLink();
  window.history.replaceState({}, "", "/");
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("authFragment — reset-password", () => {
  it("lee correo y token, los guarda en memoria y borra el fragmento de la barra", () => {
    openLink(`/?view=reset-password#email=${encodeURIComponent("ana@vectorify.test")}&token=${encodeURIComponent(TOKEN)}`);

    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain("token");
    expect(window.location.search).toBe("?view=reset-password");
    expect(readRecoveryLink("reset-password")).toEqual({ view: "reset-password", token: TOKEN, email: "ana@vectorify.test", userId: null });
    expect(readRecoveryLink("confirm-email")).toBeNull();
  });

  it("decodifica con URLSearchParams lo que el backend codifica con encodeURIComponent (+, / y = del token)", () => {
    openLink(`/?view=reset-password#email=a%2Bb%40vectorify.test&token=${encodeURIComponent("a+b/c=d")}`);

    expect(readRecoveryLink("reset-password")).toMatchObject({ email: "a+b@vectorify.test", token: "a+b/c=d" });
  });

  it("el token no queda en history.state, localStorage, sessionStorage, cookies, document.title ni en el DOM", () => {
    openLink(`/?view=reset-password#email=ana%40vectorify.test&token=${encodeURIComponent(TOKEN)}`);

    expect(JSON.stringify(window.history.state)).not.toContain("token");
    expect(JSON.stringify(window.history.state)).not.toContain(TOKEN);
    expect(window.history.state).toEqual({ keep: "me" }); // history.state se conserva tal cual
    expect(JSON.stringify({ ...window.localStorage })).not.toContain(TOKEN);
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain(TOKEN);
    expect(document.cookie).not.toContain(TOKEN);
    expect(document.title).not.toContain(TOKEN);
    expect(document.documentElement.outerHTML).not.toContain(TOKEN);
  });

  it("borra el fragmento aunque esté mal formado (sin token, sin correo o vacío de valores)", () => {
    openLink("/?view=reset-password#basura");
    expect(window.location.hash).toBe("");
    expect(readRecoveryLink("reset-password")).toEqual({ view: "reset-password", token: null, email: null, userId: null });

    openLink("/?view=reset-password#token=");
    expect(window.location.hash).toBe("");
    expect(readRecoveryLink("reset-password")?.token).toBeNull();
  });

  it("sin fragmento no toca nada (ni la URL ni la memoria)", () => {
    const replaceState = vi.spyOn(window.history, "replaceState");

    openLink("/?view=reset-password");

    expect(replaceState).not.toHaveBeenCalled();
    expect(readRecoveryLink("reset-password")).toBeNull();
  });

  it("clearRecoveryLink olvida el enlace", () => {
    openLink("/?view=reset-password#email=ana%40vectorify.test&token=t");
    clearRecoveryLink();

    expect(readRecoveryLink("reset-password")).toBeNull();
  });
});

describe("authFragment — confirm-email", () => {
  it("acepta userId o email y los reenvía tal cual", () => {
    openLink("/?view=confirm-email#userId=6f1c2a52-9a52-4fd8-9d9f-0a8c0f6d1c11&token=abc");
    expect(readRecoveryLink("confirm-email")).toEqual({
      view: "confirm-email",
      token: "abc",
      email: null,
      userId: "6f1c2a52-9a52-4fd8-9d9f-0a8c0f6d1c11",
    });
    expect(window.location.hash).toBe("");

    openLink("/?view=confirm-email#email=ana%40vectorify.test&token=xyz");
    expect(readRecoveryLink("confirm-email")).toMatchObject({ email: "ana@vectorify.test", token: "xyz", userId: null });
  });
});

describe("authFragment — otras vistas", () => {
  it.each(["/?view=login", "/?view=register", "/?view=forgot-password", "/?view=account", "/"])(
    "en %s no captura ni borra nada (el fragmento no es de esta vista)",
    (path) => {
      const replaceState = vi.spyOn(window.history, "replaceState");

      openLink(`${path}${path.includes("?") ? "" : "?x=1"}#token=algo`);

      expect(window.location.hash).toBe("#token=algo");
      expect(replaceState).not.toHaveBeenCalled();
      expect(readRecoveryLink("reset-password")).toBeNull();
      expect(readRecoveryLink("confirm-email")).toBeNull();
    },
  );
});

describe("authFragment — hashchange", () => {
  it("pegar el enlace en una pestaña que ya está en la vista (navegación de fragmento sin recarga) también lo captura, lo borra y avisa a las pantallas", () => {
    window.history.replaceState({}, "", "/?view=reset-password");
    const listener = vi.fn();
    const unsubscribe = subscribeRecoveryLink(listener);
    const before = getRecoveryLinkGeneration();

    window.history.pushState({}, "", "/?view=reset-password#email=ana%40vectorify.test&token=nuevo");
    window.dispatchEvent(new HashChangeEvent("hashchange"));

    expect(window.location.hash).toBe("");
    expect(readRecoveryLink("reset-password")).toMatchObject({ token: "nuevo" });
    expect(getRecoveryLinkGeneration()).toBe(before + 1);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    openLink("/?view=reset-password#email=ana%40vectorify.test&token=otro");
    expect(listener).toHaveBeenCalledTimes(1); // dado de baja
  });
});

describe("main.tsx", () => {
  it("importa el módulo de captura PRIMERO (se evalúa antes que React, AppRoot y cualquier fetch)", () => {
    const imports = [...mainSource.matchAll(/^import\s+(?:[^'"]*from\s+)?['"]([^'"]+)['"]/gm)].map((match) => match[1]);

    expect(imports[0]).toBe("./auth/authFragment.ts");
    expect(imports.indexOf("./AppRoot.tsx")).toBeGreaterThan(0);
  });
});
