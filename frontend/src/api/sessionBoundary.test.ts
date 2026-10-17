import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCurrentUser, login, logoutAll, AUTH_LOGOUT_ALL_PATH } from "./authApi";
import { ApiClientError, httpClient, uploadFile } from "./httpClient";
import {
  isAuthPath,
  onSessionExpired,
  rearmSessionBoundary,
  reportUnauthorized,
  resetSessionBoundaryForTests,
} from "./sessionBoundary";
import { FakeXMLHttpRequest, stubXMLHttpRequest } from "../test/FakeXMLHttpRequest";

const user = { id: "6f1c2a52-9a52-4fd8-9d9f-0a8c0f6d1c11", email: "ana@vectorify.test", displayName: "ana" };

function respond(status: number, body: unknown = {}): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** fetch que responde según la ruta de la request. */
function stubFetchByPath(routes: Record<string, () => Response>) {
  const fetchMock = vi.fn((input: string | URL | Request, _init?: RequestInit) => {
    const url = new URL(String(input));
    const route = routes[url.pathname];
    return Promise.resolve(route ? route() : respond(404));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  resetSessionBoundaryForTests();
});

afterEach(() => {
  resetSessionBoundaryForTests();
  vi.unstubAllGlobals();
});

describe("sessionBoundary — frontera de autenticación (M3.1-S04)", () => {
  it("un 401 de un endpoint que no es de auth notifica «sesión expirada» una vez y el error se propaga igual", async () => {
    const handler = vi.fn();
    onSessionExpired(handler);
    stubFetchByPath({ "/api/v2/projects": () => respond(401, { code: "unauthenticated" }) });

    const failure = await httpClient.get("/api/v2/projects").catch((error: unknown) => error);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ path: "/api/v2/projects" });
    expect(failure).toBeInstanceOf(ApiClientError);
    expect((failure as ApiClientError).status).toBe(401);
  });

  it("varias requests concurrentes con 401 producen UN solo evento", async () => {
    const handler = vi.fn();
    onSessionExpired(handler);
    stubFetchByPath({
      "/api/v2/projects": () => respond(401),
      "/api/v2/projects/p1/assets": () => respond(401),
      "/api/v1/projects/p1/original": () => respond(401),
    });

    const results = await Promise.allSettled([
      httpClient.get("/api/v2/projects"),
      httpClient.get("/api/v2/projects/p1/assets"),
      httpClient.postJson("/api/v1/projects/p1/original", {}),
      httpClient.delete("/api/v2/projects"),
      httpClient.patchJson("/api/v2/projects", {}),
    ]);

    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("un 401 posterior de otra request, ya avisada la caducidad, no vuelve a notificar", async () => {
    const handler = vi.fn();
    onSessionExpired(handler);
    stubFetchByPath({ "/api/v2/projects": () => respond(401) });

    await httpClient.get("/api/v2/projects").catch(() => undefined);
    await httpClient.get("/api/v2/projects").catch(() => undefined);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["login", "/api/v1/auth/login"],
    ["register", "/api/v1/auth/register"],
    ["me", "/api/v1/auth/me"],
    ["logout", "/api/v1/auth/logout"],
    ["logout-all", AUTH_LOGOUT_ALL_PATH],
  ])("un 401 de %s NO dispara el evento (es un resultado normal)", async (_name, path) => {
    const handler = vi.fn();
    onSessionExpired(handler);
    stubFetchByPath({ [path]: () => respond(401, { code: "invalid_credentials" }) });

    await httpClient.postJson(path, {}).catch(() => undefined);
    await httpClient.get(path).catch(() => undefined);

    expect(handler).not.toHaveBeenCalled();
  });

  it("getCurrentUser con 401 devuelve null y no dispara el evento", async () => {
    const handler = vi.fn();
    onSessionExpired(handler);
    stubFetchByPath({ "/api/v1/auth/me": () => respond(401) });

    await expect(getCurrentUser()).resolves.toBeNull();

    expect(handler).not.toHaveBeenCalled();
  });

  it("no reintenta: cada llamada hace exactamente una request a fetch, también con 401", async () => {
    onSessionExpired(vi.fn());
    const fetchMock = stubFetchByPath({ "/api/v2/projects": () => respond(401) });

    await httpClient.get("/api/v2/projects").catch(() => undefined);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("un handler que lanza no impide avisar a los demás ni cambia el error de la request", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const broken = vi.fn(() => {
      throw new Error("boom");
    });
    const healthy = vi.fn();
    onSessionExpired(broken);
    onSessionExpired(healthy);
    stubFetchByPath({ "/api/v2/projects": () => respond(401) });

    const failure = await httpClient.get("/api/v2/projects").catch((error: unknown) => error);

    expect(broken).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledTimes(1);
    expect((failure as ApiClientError).status).toBe(401);
    consoleError.mockRestore();
  });

  it("el suscriptor se puede dar de baja (y la baja es idempotente)", async () => {
    const handler = vi.fn();
    const unsubscribe = onSessionExpired(handler);
    stubFetchByPath({ "/api/v2/projects": () => respond(401) });

    unsubscribe();
    unsubscribe();
    await httpClient.get("/api/v2/projects").catch(() => undefined);

    expect(handler).not.toHaveBeenCalled();
  });

  it("suscribir dos veces el mismo handler lo avisa una sola vez", async () => {
    const handler = vi.fn();
    onSessionExpired(handler);
    onSessionExpired(handler);
    stubFetchByPath({ "/api/v2/projects": () => respond(401) });

    await httpClient.get("/api/v2/projects").catch(() => undefined);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("sin suscriptores un 401 no rompe nada y no consume el aviso para el siguiente suscriptor", async () => {
    stubFetchByPath({ "/api/v2/projects": () => respond(401) });
    await expect(httpClient.get("/api/v2/projects")).rejects.toBeInstanceOf(ApiClientError);

    const handler = vi.fn();
    onSessionExpired(handler);
    await httpClient.get("/api/v2/projects").catch(() => undefined);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("otros errores (403, 404, 500) y las respuestas correctas no disparan el evento", async () => {
    const handler = vi.fn();
    onSessionExpired(handler);
    stubFetchByPath({
      "/a": () => respond(403),
      "/b": () => respond(404),
      "/c": () => respond(500),
      "/d": () => respond(200, { ok: true }),
    });

    await Promise.allSettled(["/a", "/b", "/c", "/d"].map((p) => httpClient.get(p)));

    expect(handler).not.toHaveBeenCalled();
  });

  it("un fallo de red no se confunde con sesión expirada", async () => {
    const handler = vi.fn();
    onSessionExpired(handler);
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));

    await httpClient.get("/api/v2/projects").catch(() => undefined);

    expect(handler).not.toHaveBeenCalled();
  });

  it("un login correcto vuelve a armar el aviso: la sesión nueva que caduque notifica otra vez", async () => {
    const handler = vi.fn();
    onSessionExpired(handler);
    stubFetchByPath({
      "/api/v2/projects": () => respond(401),
      "/api/v1/auth/login": () => respond(200, user),
    });

    await httpClient.get("/api/v2/projects").catch(() => undefined);
    await login({ email: user.email, password: "una-contrasena-larga-1" });
    await httpClient.get("/api/v2/projects").catch(() => undefined);

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("un login fallido (401) NO vuelve a armar el aviso", async () => {
    const handler = vi.fn();
    onSessionExpired(handler);
    stubFetchByPath({
      "/api/v2/projects": () => respond(401),
      "/api/v1/auth/login": () => respond(401, { code: "invalid_credentials" }),
    });

    await httpClient.get("/api/v2/projects").catch(() => undefined);
    await login({ email: user.email, password: "mala" }).catch(() => undefined);
    await httpClient.get("/api/v2/projects").catch(() => undefined);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("me con usuario (sesión restaurada) vuelve a armar el aviso", async () => {
    const handler = vi.fn();
    onSessionExpired(handler);
    stubFetchByPath({
      "/api/v2/projects": () => respond(401),
      "/api/v1/auth/me": () => respond(200, user),
    });

    await httpClient.get("/api/v2/projects").catch(() => undefined);
    await getCurrentUser();
    await httpClient.get("/api/v2/projects").catch(() => undefined);

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("rearmSessionBoundary permite avisar de nuevo explícitamente", () => {
    const handler = vi.fn();
    onSessionExpired(handler);

    reportUnauthorized("/api/v2/projects");
    reportUnauthorized("/api/v2/projects");
    rearmSessionBoundary();
    reportUnauthorized("/api/v2/projects");

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("logoutAll hace POST a /api/v1/auth/logout-all", async () => {
    const fetchMock = stubFetchByPath({ [AUTH_LOGOUT_ALL_PATH]: () => respond(204) });

    await logoutAll();

    const [url, init] = fetchMock.mock.calls[0];
    expect(new URL(String(url)).pathname).toBe("/api/v1/auth/logout-all");
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("include");
  });

  it("isAuthPath reconoce solo el prefijo /api/v1/auth/", () => {
    expect(isAuthPath("/api/v1/auth/login")).toBe(true);
    expect(isAuthPath("/api/v1/auth/me?x=1")).toBe(true);
    expect(isAuthPath("/api/v1/authors")).toBe(false);
    expect(isAuthPath("/api/v2/projects")).toBe(false);
  });

  it("no guarda nada en localStorage ni sessionStorage al expirar la sesión", async () => {
    const setLocal = vi.spyOn(Storage.prototype, "setItem");
    onSessionExpired(vi.fn());
    stubFetchByPath({ "/api/v2/projects": () => respond(401) });

    await httpClient.get("/api/v2/projects").catch(() => undefined);

    expect(setLocal).not.toHaveBeenCalled();
    setLocal.mockRestore();
  });
});

describe("sessionBoundary — subidas (XMLHttpRequest)", () => {
  beforeEach(() => {
    FakeXMLHttpRequest.instances = [];
    stubXMLHttpRequest();
  });

  it("un 401 en uploadFile notifica una vez y rechaza con ApiClientError", async () => {
    const handler = vi.fn();
    onSessionExpired(handler);
    const file = new File(["x"], "a.png", { type: "image/png" });

    const first = uploadFile("/api/v2/projects/p1/assets", file);
    const second = uploadFile("/api/v2/projects/p1/assets", file);
    FakeXMLHttpRequest.instances[0].respond(401, {});
    FakeXMLHttpRequest.instances[1].respond(401, {});

    await expect(first).rejects.toBeInstanceOf(ApiClientError);
    await expect(second).rejects.toBeInstanceOf(ApiClientError);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ path: "/api/v2/projects/p1/assets" });
  });

  it("un 500 en uploadFile no notifica", async () => {
    const handler = vi.fn();
    onSessionExpired(handler);
    const upload = uploadFile("/api/v2/projects/p1/assets", new File(["x"], "a.png"));

    FakeXMLHttpRequest.instances[0].respond(500, {});

    await expect(upload).rejects.toBeInstanceOf(ApiClientError);
    expect(handler).not.toHaveBeenCalled();
  });
});
