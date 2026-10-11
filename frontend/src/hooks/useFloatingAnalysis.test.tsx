import { StrictMode, type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { abortAwareFetch } from "../test/abortableFetch";
import type { FloatingRequest, FloatingResponse } from "../types/geometry";
import { useFloatingAnalysis } from "./useFloatingAnalysis";

const DEBOUNCE = 30;

/** La "marca" de la petición viaja en la tolerancia: sirve para saber a cuál respondió el servidor. */
function requestOf(tag: number): FloatingRequest {
  return { subjects: [{ type: "polygon", locked: false, coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10]]] }], mode: "stencil", tolerance: tag };
}

function responseFor(tag: number): FloatingResponse {
  return { mode: "stencil", tolerance: tag, components: [], floatingCount: 0, mainCount: 0, discarded: 0 };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const bodyOf = (fetchMock: ReturnType<typeof abortAwareFetch>, call: number) => JSON.parse(String((fetchMock.mock.calls[call][1] as RequestInit).body)) as FloatingRequest;

interface Props {
  tag: number | null;
}

function setup(initial: number | null, handler: Parameters<typeof abortAwareFetch>[0], options: { strict?: boolean } = {}) {
  const fetchMock = abortAwareFetch(handler);
  vi.stubGlobal("fetch", fetchMock);
  const wrapper = options.strict ? ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode> : undefined;
  const hook = renderHook(({ tag }: Props) => useFloatingAnalysis({ request: tag === null ? null : requestOf(tag), requestKey: tag === null ? null : `k${tag}`, debounceMs: DEBOUNCE }), {
    initialProps: { tag: initial } as Props,
    wrapper,
  });
  return { fetchMock, ...hook };
}

describe("useFloatingAnalysis", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("pide el análisis a /api/v2/geometry/floating (ni booleanas, ni offset, ni corte, ni bridges), con la señal, y pasa por calculando -> listo", async () => {
    let release: (response: Response) => void = () => {};
    const { fetchMock, result } = setup(1, () => new Promise<Response>((resolve) => (release = resolve)));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.urls[0]).toMatch(/\/api\/v2\/geometry\/floating$/);
    expect(bodyOf(fetchMock, 0)).toEqual(requestOf(1));
    expect(fetchMock.signals[0]).toBeInstanceOf(AbortSignal);
    await waitFor(() => expect(result.current.status).toBe("calculating"));

    await act(async () => release(json(responseFor(1))));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.response).toEqual(responseFor(1));
  });

  it("sin petición (todavía no se apretó Analizar): idle y no llama", async () => {
    const { fetchMock, result } = setup(null, () => json(responseFor(1)));

    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE * 3));

    expect(result.current.status).toBe("idle");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("UNA petición viva: al cambiar la clave se ABORTA la anterior y una respuesta tardía nunca se muestra", async () => {
    const releases: Array<(response: Response) => void> = [];
    const fetchMock = abortAwareFetch(() => new Promise<Response>((resolve) => releases.push(resolve)));
    vi.stubGlobal("fetch", fetchMock);
    const { result, rerender } = renderHook(({ tag }: Props) => useFloatingAnalysis({ request: requestOf(tag!), requestKey: `k${tag}`, debounceMs: DEBOUNCE }), { initialProps: { tag: 1 } as Props });
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

  it("errores del servidor con el texto del análisis (no el del corte ni el de las booleanas); reintentar se recupera", async () => {
    let fail = true;
    const { fetchMock, result } = setup(1, () => (fail ? json({ code: "too_many_subjects", message: "muchos" }, 400) : json(responseFor(1))));

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.errorMessage).toMatch(/demasiados objetos para analizarlos juntos.*No se modificó nada/);
    expect(result.current.response).toBeNull();

    fail = false;
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("ensure() con el resultado calculado no vuelve a pedir; desmontar aborta lo que esté en vuelo", async () => {
    const { fetchMock, result, unmount } = setup(1, () => json(responseFor(1)));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let outcome: Awaited<ReturnType<typeof result.current.ensure>> | undefined;
    await act(async () => {
      outcome = await result.current.ensure();
    });
    expect(outcome).toEqual({ ok: true, response: responseFor(1) });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    unmount();

    const pending = setup(1, () => new Promise<Response>(() => {}));
    await waitFor(() => expect(pending.fetchMock).toHaveBeenCalledTimes(1));
    pending.unmount();
    expect(pending.fetchMock.signals[0]?.aborted).toBe(true);
  });
});
