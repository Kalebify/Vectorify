import { afterEach, describe, expect, it, vi } from "vitest";
import { abortAwareFetch } from "../test/abortableFetch";
import type { BooleanRequest, BridgeRequest, FloatingRequest, OffsetRequest, SplitRequest } from "../types/geometry";
import { postBooleanOperation, postBridgeOperation, postFloatingAnalysis, postOffsetOperation, postSplitOperation } from "./geometryApi";
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

describe("postOffsetOperation (M3-S09)", () => {
  afterEach(() => vi.unstubAllGlobals());

  const OFFSET: OffsetRequest = {
    subjects: [{ type: "polygon", coordinates: [[[0, 0], [40, 0], [40, 20], [0, 20]]] }],
    distance: -3,
    joinStyle: "mitre",
    mitreLimit: 2,
    capStyle: "round",
    tolerance: 0.02,
  };

  it("POST JSON a /api/v2/geometry/offset (no a boolean) con la petición tal cual y la señal de aborto", async () => {
    const payload = {
      distance: -3,
      joinStyle: "mitre",
      mitreLimit: 2,
      capStyle: "round",
      tolerance: 0.02,
      pieceCount: 0,
      results: [{ subjectIndex: 0, geometries: [], collapsed: true, piecesBefore: 1, splitCount: 0, lostPieces: 1, holesBefore: 0, holesAfter: 0, maxInwardOffset: 10 }],
    };
    const fetchMock = abortAwareFetch(() => new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    const response = await postOffsetOperation(OFFSET, controller.signal);

    expect(response).toEqual(payload);
    expect(fetchMock.urls).toEqual([`${API_BASE_URL}/api/v2/geometry/offset`]);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual(OFFSET);
    expect(init.signal).toBe(controller.signal);
  });

  it("un error de la Web API llega como ApiClientError con status y el código propio del offset", async () => {
    vi.stubGlobal("fetch", abortAwareFetch(() => new Response(JSON.stringify({ code: "invalid_distance", message: "cero" }), { status: 400, headers: { "Content-Type": "application/json" } })));

    const error = await postOffsetOperation(OFFSET).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiClientError);
    expect((error as ApiClientError).status).toBe(400);
    expect((error as ApiClientError).body).toEqual({ code: "invalid_distance", message: "cero" });
  });

  it("una señal abortada rechaza con isAborted y no llama a la red", async () => {
    const fetchMock = abortAwareFetch(() => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort();

    const error = await postOffsetOperation(OFFSET, controller.signal).catch((caught: unknown) => caught);

    expect((error as ApiClientError).isAborted).toBe(true);
  });
});

describe("postSplitOperation (M3-S10)", () => {
  afterEach(() => vi.unstubAllGlobals());

  const SPLIT: SplitRequest = {
    subjects: [{ type: "polygon", coordinates: [[[0, 0], [40, 0], [40, 20], [0, 20]]] }],
    cutter: { points: [[20, -5], [20, 25]] },
    mode: "slot",
    slotWidth: 0.4,
    extend: true,
    tolerance: 0.02,
  };

  it("POST JSON a /api/v2/geometry/split (ni boolean ni offset) con la petición tal cual y la señal de aborto", async () => {
    const payload = {
      mode: "slot",
      slotWidth: 0.4,
      extend: true,
      tolerance: 0.02,
      pieceCount: 0,
      results: [{ subjectIndex: 0, touched: false, changed: false, pieces: [], pieceCount: 0, discarded: 0 }],
    };
    const fetchMock = abortAwareFetch(() => new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    const response = await postSplitOperation(SPLIT, controller.signal);

    expect(response).toEqual(payload);
    expect(fetchMock.urls).toEqual([`${API_BASE_URL}/api/v2/geometry/split`]);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual(SPLIT);
    expect(init.signal).toBe(controller.signal);
  });

  it("un error de la Web API llega como ApiClientError con status y el código propio del corte", async () => {
    vi.stubGlobal("fetch", abortAwareFetch(() => new Response(JSON.stringify({ code: "invalid_cutter", message: "un punto" }), { status: 400, headers: { "Content-Type": "application/json" } })));

    const error = await postSplitOperation(SPLIT).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiClientError);
    expect((error as ApiClientError).status).toBe(400);
    expect((error as ApiClientError).body).toEqual({ code: "invalid_cutter", message: "un punto" });
  });

  it("una señal ya abortada rechaza con isAborted", async () => {
    const fetchMock = abortAwareFetch(() => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort();

    const error = await postSplitOperation(SPLIT, controller.signal).catch((caught: unknown) => caught);

    expect((error as ApiClientError).isAborted).toBe(true);
  });

  it("sin conexión rechaza con isNetworkError", async () => {
    vi.stubGlobal("fetch", abortAwareFetch(() => Promise.reject(new TypeError("Failed to fetch"))));

    const error = await postSplitOperation(SPLIT).catch((caught: unknown) => caught);

    expect((error as ApiClientError).isNetworkError).toBe(true);
  });
});

describe("postFloatingAnalysis / postBridgeOperation (M3-S11)", () => {
  afterEach(() => vi.unstubAllGlobals());

  const SUBJECTS = [{ type: "polygon" as const, locked: false, coordinates: [[[0, 0], [20, 0], [20, 20], [0, 20]], [[5, 5], [15, 5], [15, 15], [5, 15]]] as [number, number][][] }];
  const FLOATING: FloatingRequest = { subjects: SUBJECTS, mode: "stencil", tolerance: 0.02 };
  const BRIDGE: BridgeRequest = { subjects: SUBJECTS, mode: "stencil", bridges: [{ island: 1, width: 1.6 }], suggest: false, tolerance: 0.02 };

  it("el análisis hace POST JSON a /api/v2/geometry/floating con la petición tal cual y la señal de aborto", async () => {
    const payload = { mode: "stencil", tolerance: 0.02, components: [], floatingCount: 0, mainCount: 0, discarded: 0 };
    const fetchMock = abortAwareFetch(() => new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    const response = await postFloatingAnalysis(FLOATING, controller.signal);

    expect(response).toEqual(payload);
    expect(fetchMock.urls).toEqual([`${API_BASE_URL}/api/v2/geometry/floating`]);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual(FLOATING);
    expect(init.signal).toBe(controller.signal);
  });

  it("los bridges hacen POST JSON a /api/v2/geometry/bridge con la petición tal cual y la señal de aborto", async () => {
    const payload = { mode: "stencil", tolerance: 0.02, bridges: [], results: [], reanalysis: { floatingBefore: 1, floatingAfter: 0, mainAfter: 1 }, pieceCount: 0 };
    const fetchMock = abortAwareFetch(() => new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    const response = await postBridgeOperation(BRIDGE, controller.signal);

    expect(response).toEqual(payload);
    expect(fetchMock.urls).toEqual([`${API_BASE_URL}/api/v2/geometry/bridge`]);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual(BRIDGE);
    expect(init.signal).toBe(controller.signal);
  });

  it("un error de la Web API llega como ApiClientError con status y el código propio de los bridges", async () => {
    vi.stubGlobal("fetch", abortAwareFetch(() => new Response(JSON.stringify({ code: "invalid_bridge_width", message: "ancho" }), { status: 400, headers: { "Content-Type": "application/json" } })));

    const error = await postBridgeOperation(BRIDGE).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiClientError);
    expect((error as ApiClientError).status).toBe(400);
    expect((error as ApiClientError).body).toEqual({ code: "invalid_bridge_width", message: "ancho" });
  });

  it("una señal ya abortada rechaza con isAborted y sin conexión con isNetworkError, en ambas rutas", async () => {
    vi.stubGlobal("fetch", abortAwareFetch(() => new Response("{}")));
    const controller = new AbortController();
    controller.abort();
    expect(((await postFloatingAnalysis(FLOATING, controller.signal).catch((caught: unknown) => caught)) as ApiClientError).isAborted).toBe(true);
    expect(((await postBridgeOperation(BRIDGE, controller.signal).catch((caught: unknown) => caught)) as ApiClientError).isAborted).toBe(true);

    vi.stubGlobal("fetch", abortAwareFetch(() => Promise.reject(new TypeError("Failed to fetch"))));
    expect(((await postFloatingAnalysis(FLOATING).catch((caught: unknown) => caught)) as ApiClientError).isNetworkError).toBe(true);
    expect(((await postBridgeOperation(BRIDGE).catch((caught: unknown) => caught)) as ApiClientError).isNetworkError).toBe(true);
  });
});
