import { afterEach, describe, expect, it, vi } from "vitest";
import { abortAwareFetch } from "../test/abortableFetch";
import type { BooleanRequest } from "../types/geometry";
import { postBooleanOperation } from "./geometryApi";
import { API_BASE_URL, ApiClientError } from "./httpClient";

const REQUEST: BooleanRequest = {
  operation: "difference",
  subjects: [{ type: "line", coordinates: [[0, 20], [40, 20]] }],
  operands: [{ type: "bufferedLine", points: [[20, 0], [20, 40]], radius: 2 }],
  tolerance: 0.02,
};

describe("postBooleanOperation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POST JSON a /api/v2/geometry/boolean con la petición tal cual y la señal de aborto", async () => {
    const payload = { operation: "difference", scope: "per_subject", tolerance: 0.02, pieceCount: 0, results: [{ subjectIndex: 0, changed: true, geometries: [] }] };
    const fetchMock = abortAwareFetch(() => new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    const response = await postBooleanOperation(REQUEST, controller.signal);

    expect(response).toEqual(payload);
    expect(fetchMock.urls[0]).toBe(`${API_BASE_URL}/api/v2/geometry/boolean`);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual(REQUEST);
    expect(init.signal).toBe(controller.signal);
  });

  it("un error de la Web API llega como ApiClientError con status y cuerpo tipado (code)", async () => {
    vi.stubGlobal("fetch", abortAwareFetch(() => new Response(JSON.stringify({ code: "too_many_subjects", message: "muchos" }), { status: 400, headers: { "Content-Type": "application/json" } })));

    const error = await postBooleanOperation(REQUEST).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiClientError);
    expect((error as ApiClientError).status).toBe(400);
    expect((error as ApiClientError).body).toEqual({ code: "too_many_subjects", message: "muchos" });
  });

  it("una señal abortada rechaza con isAborted y no llama a la red", async () => {
    const fetchMock = abortAwareFetch(() => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort();

    const error = await postBooleanOperation(REQUEST, controller.signal).catch((caught: unknown) => caught);

    expect((error as ApiClientError).isAborted).toBe(true);
  });

  it("sin conexión rechaza con isNetworkError", async () => {
    vi.stubGlobal("fetch", abortAwareFetch(() => Promise.reject(new TypeError("Failed to fetch"))));

    const error = await postBooleanOperation(REQUEST).catch((caught: unknown) => caught);

    expect((error as ApiClientError).isNetworkError).toBe(true);
  });
});
