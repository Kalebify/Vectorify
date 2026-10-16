import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTH_LOGIN_PATH,
  AUTH_LOGOUT_PATH,
  AUTH_ME_PATH,
  AUTH_REGISTER_PATH,
  getCurrentUser,
  isUnauthorizedError,
  login,
  logout,
  register,
} from "./authApi";
import { API_BASE_URL, ApiClientError, CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from "./httpClient";

function stubFetch(response: Response | (() => Response)) {
  const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
    Promise.resolve(typeof response === "function" ? response() : response),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const user = { id: "6f1c2a52-9a52-4fd8-9d9f-0a8c0f6d1c11", email: "ana@vectorify.test", displayName: "ana" };

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  return new Headers(init?.headers).get(name) ?? undefined;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("authApi", () => {
  it("los paths son los del backend", () => {
    expect(AUTH_REGISTER_PATH).toBe("/api/v1/auth/register");
    expect(AUTH_LOGIN_PATH).toBe("/api/v1/auth/login");
    expect(AUTH_LOGOUT_PATH).toBe("/api/v1/auth/logout");
    expect(AUTH_ME_PATH).toBe("/api/v1/auth/me");
  });

  it("register hace POST JSON con email y contraseña y devuelve la respuesta uniforme", async () => {
    const fetchMock = stubFetch(json({ status: "accepted" }, 202));

    const result = await register({ email: "ana@vectorify.test", password: "una-contrasena-larga-1" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${API_BASE_URL}/api/v1/auth/register`);
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("include");
    expect(JSON.parse(String(init?.body))).toEqual({ email: "ana@vectorify.test", password: "una-contrasena-larga-1" });
    expect(result).toEqual({ status: "accepted" });
  });

  it("login hace POST JSON con credentials include y la cabecera anti-CSRF, y devuelve el usuario actual", async () => {
    const fetchMock = stubFetch(json(user));

    const result = await login({ email: "ana@vectorify.test", password: "una-contrasena-larga-1" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${API_BASE_URL}/api/v1/auth/login`);
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("include");
    expect(headerOf(init, CSRF_HEADER_NAME)).toBe(CSRF_HEADER_VALUE);
    expect(result).toEqual(user);
  });

  it("login con credenciales inválidas propaga un ApiClientError 401 con el cuerpo tipado, sin filtrar la contraseña", async () => {
    stubFetch(json({ code: "invalid_credentials", message: "Correo o contraseña incorrectos." }, 401));

    const error = await login({ email: "ana@vectorify.test", password: "mala-contrasena-1" }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiClientError);
    expect(isUnauthorizedError(error)).toBe(true);
    expect((error as ApiClientError).body).toEqual({ code: "invalid_credentials", message: "Correo o contraseña incorrectos." });
    expect(String((error as ApiClientError).message)).not.toContain("mala-contrasena-1");
  });

  it("logout hace POST a /logout y resuelve con el 204", async () => {
    const fetchMock = stubFetch(new Response(null, { status: 204 }));

    await expect(logout()).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${API_BASE_URL}/api/v1/auth/logout`);
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("include");
    expect(headerOf(init, CSRF_HEADER_NAME)).toBe(CSRF_HEADER_VALUE);
  });

  it("getCurrentUser devuelve el usuario con una sesión válida", async () => {
    const fetchMock = stubFetch(json(user));

    await expect(getCurrentUser()).resolves.toEqual(user);
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${API_BASE_URL}/api/v1/auth/me`);
    expect(fetchMock.mock.calls[0][1]?.method).toBe("GET");
    expect(fetchMock.mock.calls[0][1]?.credentials).toBe("include");
  });

  it("getCurrentUser devuelve null ante un 401 (sin sesión, caducada o cerrada)", async () => {
    stubFetch(new Response(null, { status: 401 }));

    await expect(getCurrentUser()).resolves.toBeNull();
  });

  it("getCurrentUser propaga los demás errores (503, red caída)", async () => {
    stubFetch(json({ code: "database_unavailable" }, 503));
    await expect(getCurrentUser()).rejects.toMatchObject({ name: "ApiClientError", status: 503 });

    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    await expect(getCurrentUser()).rejects.toMatchObject({ name: "ApiClientError", isNetworkError: true });
  });

  it("isUnauthorizedError solo reconoce el 401 de la Web API", () => {
    expect(isUnauthorizedError(new ApiClientError("x", { status: 401 }))).toBe(true);
    expect(isUnauthorizedError(new ApiClientError("x", { status: 403 }))).toBe(false);
    expect(isUnauthorizedError(new ApiClientError("x", { isNetworkError: true }))).toBe(false);
    expect(isUnauthorizedError(new Error("401"))).toBe(false);
    expect(isUnauthorizedError(undefined)).toBe(false);
  });
});
