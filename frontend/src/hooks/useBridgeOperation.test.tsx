import { StrictMode, type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { abortAwareFetch } from "../test/abortableFetch";
import type { BridgeRequest, BridgeResponse } from "../types/geometry";
import { useBridgeOperation } from "./useBridgeOperation";

const DEBOUNCE = 30;

/** La "marca" de la petición viaja en el ancho del bridge: sirve para saber a cuál respondió el servidor. */
function requestOf(tag: number): BridgeRequest {
  return {
    subjects: [{ type: "polygon", locked: false, coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10]]] }],
    mode: "stencil",
    bridges: [{ island: 1, width: tag }],
    suggest: false,
    tolerance: 0.02,
  };
}

function responseFor(tag: number): BridgeResponse {
  return { mode: "stencil", tolerance: 0.02, bridges: [], results: [], reanalysis: { floatingBefore: tag, floatingAfter: 0, mainAfter: 1 }, pieceCount: 0 };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const bodyOf = (fetchMock: ReturnType<typeof abortAwareFetch>, call: number) => JSON.parse(String((fetchMock.mock.calls[call][1] as RequestInit).body)) as BridgeRequest;

interface Props {
  tag: number | null;
}

function setup(initial: number | null, handler: Parameters<typeof abortAwareFetch>[0], options: { strict?: boolean; debounceMs?: number } = {}) {
  const fetchMock = abortAwareFetch(handler);
  vi.stubGlobal("fetch", fetchMock);
  const wrapper = options.strict ? ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode> : undefined;
  const hook = renderHook(
    ({ tag }: Props) => useBridgeOperation({ request: tag === null ? null : requestOf(tag), requestKey: tag === null ? null : `k${tag}`, debounceMs: options.debounceMs ?? DEBOUNCE }),
    { initialProps: { tag: initial } as Props, wrapper },
  );
  return { fetchMock, ...hook };
}

describe("useBridgeOperation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("pide los bridges a /api/v2/geometry/bridge (ni booleanas, ni offset, ni corte, ni el análisis), con la señal, y pasa por calculando -> listo", async () => {
    let release: (response: Response) => void = () => {};
    const { fetchMock, result } = setup(1, () => new Promise<Response>((resolve) => (release = resolve)));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.urls[0]).toMatch(/\/api\/v2\/geometry\/bridge$/);
    expect(bodyOf(fetchMock, 0)).toEqual(requestOf(1));
    expect(fetchMock.signals[0]).toBeInstanceOf(AbortSignal);
    await waitFor(() => expect(result.current.status).toBe("calculating"));

    await act(async () => release(json(responseFor(1))));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.response).toEqual(responseFor(1));
  });

  it("DEBOUNCE: cambiar el ancho varias veces seguidas pide UNA sola vez, con el último ancho", async () => {
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const { fetchMock, result, rerender } = setup(1, (_url, init) => json(responseFor(JSON.parse(String(init?.body)).bridges[0].width)), { debounceMs: 300 });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    rerender({ tag: 2 });
    await wait(25);
    rerender({ tag: 3 });
    await wait(25);
    rerender({ tag: 4 });
    await wait(25);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(result.current.status).toBe("ready"), { timeout: 2000 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetchMock, 1).bridges[0].width).toBe(4);
    expect(result.current.response).toEqual(responseFor(4));
  });

  it("UNA petición viva: al cambiar la clave se ABORTA la anterior y una respuesta tardía nunca se muestra", async () => {
    const releases: Array<(response: Response) => void> = [];
    const fetchMock = abortAwareFetch(() => new Promise<Response>((resolve) => releases.push(resolve)));
    vi.stubGlobal("fetch", fetchMock);
    const { result, rerender } = renderHook(({ tag }: Props) => useBridgeOperation({ request: requestOf(tag!), requestKey: `k${tag}`, debounceMs: DEBOUNCE }), { initialProps: { tag: 1 } as Props });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rerender({ tag: 2 });
    expect(fetchMock.signals[0]?.aborted).toBe(true);
    await act(async () => releases[0](json(responseFor(1))));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(result.current.response).toBeNull();

    await act(async () => releases[1](json(responseFor(2))));
    await waitFor(() => expect(result.current.response).toEqual(responseFor(2)));
  });

  it("StrictMode (efecto -> cleanup -> efecto) hace UNA sola llamada", async () => {
    const { fetchMock, result } = setup(1, () => json(responseFor(1)), { strict: true });

    await waitFor(() => expect(result.current.status).toBe("ready"));
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE * 3));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("errores del servidor con el texto de los bridges (no el del corte ni el de las booleanas); reintentar se recupera", async () => {
    let fail = true;
    const { fetchMock, result } = setup(1, () => (fail ? json({ code: "invalid_bridge_width", message: "ancho" }, 400) : json(responseFor(1))));

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.errorMessage).toMatch(/rechazó el ancho de un bridge.*No se modificó nada/);
    expect(result.current.response).toBeNull();

    fail = false;
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("ensure(): con el resultado ya calculado no vuelve a pedir; si cambió algo recalcula ya y no deja una tercera petición", async () => {
    const { fetchMock, result, rerender } = setup(1, (_url, init) => json(responseFor(JSON.parse(String(init?.body)).bridges[0].width)));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let same: Awaited<ReturnType<typeof result.current.ensure>> | undefined;
    await act(async () => {
      same = await result.current.ensure();
    });
    expect(same).toEqual({ ok: true, response: responseFor(1) });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    rerender({ tag: 2 });
    let changed: Awaited<ReturnType<typeof result.current.ensure>> | undefined;
    await act(async () => {
      changed = await result.current.ensure();
    });
    expect(changed).toEqual({ ok: true, response: responseFor(2) });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE * 3));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sin petición (sin bridges): idle, aborta lo que estaba en vuelo; cancel() y desmontar también abortan", async () => {
    const { fetchMock, result, rerender, unmount } = setup(1, () => new Promise<Response>(() => {}));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rerender({ tag: null });

    expect(fetchMock.signals[0]?.aborted).toBe(true);
    expect(result.current.status).toBe("idle");
    unmount();

    const cancelled = setup(1, () => new Promise<Response>(() => {}));
    await waitFor(() => expect(cancelled.fetchMock).toHaveBeenCalledTimes(1));
    act(() => cancelled.result.current.cancel());
    expect(cancelled.fetchMock.signals[0]?.aborted).toBe(true);
    expect(cancelled.result.current.response).toBeNull();
  });
});
