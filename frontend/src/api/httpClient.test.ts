import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_BASE_URL, CSRF_HEADER_NAME, CSRF_HEADER_VALUE, httpClient, uploadFile } from "./httpClient";
import { FakeXMLHttpRequest, stubXMLHttpRequest } from "../test/FakeXMLHttpRequest";

function stubFetch(response: () => Response = () => new Response("{}", { status: 200 })) {
  const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) => Promise.resolve(response()));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  return new Headers(init?.headers).get(name) ?? undefined;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("httpClient — sesión por cookie y cabecera anti-CSRF (M3.1-S03)", () => {
  it("el nombre y el valor de la cabecera son los que exige el backend", () => {
    expect(CSRF_HEADER_NAME).toBe("X-Vectorify-Request");
    expect(CSRF_HEADER_VALUE).not.toBe("");
  });

  it.each([
    ["get", (c: typeof httpClient) => c.get("/api/x"), "GET"],
    ["postJson", (c: typeof httpClient) => c.postJson("/api/x", { a: 1 }), "POST"],
    ["patchJson", (c: typeof httpClient) => c.patchJson("/api/x", { a: 1 }), "PATCH"],
    ["delete", (c: typeof httpClient) => c.delete("/api/x"), "DELETE"],
  ])("%s envía credentials include y la cabecera X-Vectorify-Request", async (_name, call, method) => {
    const fetchMock = stubFetch(() => new Response(null, { status: 204 }));

    await call(httpClient);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${API_BASE_URL}/api/x`);
    expect(init?.method).toBe(method);
    expect(init?.credentials).toBe("include");
    expect(headerOf(init, CSRF_HEADER_NAME)).toBe(CSRF_HEADER_VALUE);
  });

  it("get conserva Accept y no añade Content-Type", async () => {
    const fetchMock = stubFetch();

    await httpClient.get("/api/x");

    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({ Accept: "application/json", [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE });
  });

  it("postJson conserva Content-Type, las cabeceras del llamador y el cuerpo, y suma la cabecera anti-CSRF", async () => {
    const fetchMock = stubFetch();

    await httpClient.postJson("/api/x", { a: 1 }, { headers: { "Idempotency-Key": "k-1" } });

    const init = fetchMock.mock.calls[0][1];
    expect(init?.headers).toEqual({
      "Content-Type": "application/json",
      "Idempotency-Key": "k-1",
      [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
    });
    expect(init?.body).toBe(JSON.stringify({ a: 1 }));
  });

  it("un llamador no puede desactivar las credenciales ni quitar la cabecera pasando su propio init", async () => {
    const fetchMock = stubFetch();

    await httpClient.get("/api/x", { credentials: "omit", headers: { [CSRF_HEADER_NAME]: "otro" } });

    const init = fetchMock.mock.calls[0][1];
    expect(init?.credentials).toBe("include");
    expect(headerOf(init, CSRF_HEADER_NAME)).toBe(CSRF_HEADER_VALUE);
  });

  it("cabeceras pasadas como Headers se respetan y también reciben la cabecera anti-CSRF", async () => {
    const fetchMock = stubFetch();

    await httpClient.get("/api/x", { headers: new Headers({ "X-Otra": "1" }) });

    const headers = fetchMock.mock.calls[0][1]?.headers as Headers;
    expect(headers.get("X-Otra")).toBe("1");
    expect(headers.get(CSRF_HEADER_NAME)).toBe(CSRF_HEADER_VALUE);
  });

  it("propaga el status y el cuerpo tipado del error HTTP", async () => {
    stubFetch(() => new Response(JSON.stringify({ code: "invalid_credentials" }), { status: 401 }));

    await expect(httpClient.get("/api/x")).rejects.toMatchObject({
      name: "ApiClientError",
      status: 401,
      body: { code: "invalid_credentials" },
    });
  });
});

describe("uploadFile — sesión por cookie y cabecera anti-CSRF (M3.1-S03)", () => {
  beforeEach(() => {
    stubXMLHttpRequest();
  });

  it("activa withCredentials y envía X-Vectorify-Request junto a Accept y las cabeceras del llamador", () => {
    void uploadFile("/api/v1/projects", new File([new Uint8Array([1])], "a.png", { type: "image/png" }), {
      headers: { "Idempotency-Key": "k-2" },
    }).catch(() => undefined);

    const xhr = FakeXMLHttpRequest.latest();
    expect(xhr.withCredentials).toBe(true);
    expect(xhr.getRequestHeader(CSRF_HEADER_NAME)).toBe(CSRF_HEADER_VALUE);
    expect(xhr.getRequestHeader("Accept")).toBe("application/json");
    expect(xhr.getRequestHeader("Idempotency-Key")).toBe("k-2");
  });
});
