import { StrictMode, type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { abortAwareFetch } from "../test/abortableFetch";
import type { BooleanRequest } from "../types/geometry";
import { useGeometryOperation } from "./useGeometryOperation";

const REQUEST: BooleanRequest = {
  operation: "difference",
  subjects: [{ type: "polygon", coordinates: [[[0, 0], [40, 0], [40, 40], [0, 40]]] }],
  operands: [{ type: "bufferedLine", points: [[-10, 20], [50, 20]], radius: 4 }],
  tolerance: 0.02,
};

const RESPONSE = {
  operation: "difference",
  scope: "per_subject",
  tolerance: 0.02,
  pieceCount: 0,
  results: [{ subjectIndex: 0, changed: true, geometries: [] }],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("useGeometryOperation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("run envía la petición por POST /api/v2/geometry/boolean con la señal de aborto y devuelve la respuesta; el estado pasa por running", async () => {
    let release: (response: Response) => void = () => {};
    const fetchMock = abortAwareFetch(() => new Promise<Response>((resolve) => (release = resolve)));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useGeometryOperation());

    let outcome: Awaited<ReturnType<typeof result.current.run>> | undefined;
    act(() => {
      void result.current.run(REQUEST).then((value) => (outcome = value));
    });
    await waitFor(() => expect(result.current.status).toBe("running"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.urls[0]).toMatch(/\/api\/v2\/geometry\/boolean$/);
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("POST");
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual(REQUEST);
    expect(fetchMock.signals[0]).toBeInstanceOf(AbortSignal);

    await act(async () => release(json(RESPONSE)));
    await waitFor(() => expect(outcome).toBeDefined());
    expect(outcome).toEqual({ ok: true, response: RESPONSE });
    expect(result.current.status).toBe("idle");
    expect(result.current.errorMessage).toBeNull();
  });

  it("un error del servidor es recuperable: ok false con mensaje de usuario, status error y NUNCA rechaza la promesa", async () => {
    vi.stubGlobal("fetch", abortAwareFetch(() => json({ code: "engine_unavailable", message: "caído" }, 503)));
    const { result } = renderHook(() => useGeometryOperation());

    let outcome: Awaited<ReturnType<typeof result.current.run>> | undefined;
    await act(async () => {
      outcome = await result.current.run(REQUEST);
    });

    expect(outcome).toMatchObject({ ok: false, aborted: false });
    expect(outcome && !outcome.ok && outcome.message).toMatch(/motor de geometría no está disponible.*No se modificó nada/);
    expect(result.current.status).toBe("error");
    expect(result.current.errorMessage).toMatch(/no está disponible/);

    act(() => result.current.clearError());
    expect(result.current.status).toBe("idle");
    expect(result.current.errorMessage).toBeNull();
  });

  it("un fallo de red también se informa (sin excepciones)", async () => {
    vi.stubGlobal("fetch", abortAwareFetch(() => Promise.reject(new TypeError("Failed to fetch"))));
    const { result } = renderHook(() => useGeometryOperation());

    let outcome: Awaited<ReturnType<typeof result.current.run>> | undefined;
    await act(async () => {
      outcome = await result.current.run(REQUEST);
    });

    expect(outcome && !outcome.ok && outcome.message).toMatch(/No se pudo contactar con el servidor/);
  });

  it("cancel aborta el fetch: ok false con aborted true, status idle y SIN mensaje de error", async () => {
    const fetchMock = abortAwareFetch(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useGeometryOperation());

    let outcome: Awaited<ReturnType<typeof result.current.run>> | undefined;
    act(() => {
      void result.current.run(REQUEST).then((value) => (outcome = value));
    });
    await waitFor(() => expect(result.current.status).toBe("running"));
    act(() => result.current.cancel());

    await waitFor(() => expect(outcome).toBeDefined());
    expect(outcome).toMatchObject({ ok: false, aborted: true });
    expect(fetchMock.signals[0]?.aborted).toBe(true);
    expect(result.current.status).toBe("idle");
    expect(result.current.errorMessage).toBeNull();
  });

  it("una respuesta que llega DESPUÉS de cancelar nunca se entrega", async () => {
    let release: (response: Response) => void = () => {};
    // Un fetch "mal educado" que ignora la señal y responde igual: la entrega igual debe descartarse.
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => (release = resolve)));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useGeometryOperation());

    let outcome: Awaited<ReturnType<typeof result.current.run>> | undefined;
    act(() => {
      void result.current.run(REQUEST).then((value) => (outcome = value));
    });
    await waitFor(() => expect(result.current.status).toBe("running"));
    act(() => result.current.cancel());
    await act(async () => release(json(RESPONSE)));

    await waitFor(() => expect(outcome).toBeDefined());
    expect(outcome).toMatchObject({ ok: false, aborted: true });
  });

  it("una segunda operación mientras hay una en curso se rechaza sin llamar al servidor otra vez", async () => {
    const fetchMock = abortAwareFetch(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useGeometryOperation());

    act(() => {
      void result.current.run(REQUEST);
    });
    let second: Awaited<ReturnType<typeof result.current.run>> | undefined;
    await act(async () => {
      second = await result.current.run(REQUEST);
    });

    expect(second).toMatchObject({ ok: false, aborted: false });
    expect(second && !second.ok && second.message).toMatch(/Ya hay un cálculo en curso/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("después de terminar se puede lanzar otra operación", async () => {
    const fetchMock = abortAwareFetch(() => json(RESPONSE));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useGeometryOperation());

    await act(async () => {
      await result.current.run(REQUEST);
    });
    await act(async () => {
      await result.current.run(REQUEST);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("desmontar aborta lo que esté en vuelo", async () => {
    const fetchMock = abortAwareFetch(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    const { result, unmount } = renderHook(() => useGeometryOperation());

    act(() => {
      void result.current.run(REQUEST);
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    unmount();

    expect(fetchMock.signals[0]?.aborted).toBe(true);
  });

  it("con el doble efecto de StrictMode sigue funcionando: una sola petición y la respuesta se entrega", async () => {
    const fetchMock = abortAwareFetch(() => json(RESPONSE));
    vi.stubGlobal("fetch", fetchMock);
    const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
    const { result } = renderHook(() => useGeometryOperation(), { wrapper });

    let outcome: Awaited<ReturnType<typeof result.current.run>> | undefined;
    await act(async () => {
      outcome = await result.current.run(REQUEST);
    });

    expect(outcome).toEqual({ ok: true, response: RESPONSE });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
