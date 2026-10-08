import { StrictMode, type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { abortAwareFetch } from "../test/abortableFetch";
import type { BooleanRequest } from "../types/geometry";
import { useBooleanOperation } from "./useBooleanOperation";

const DEBOUNCE = 30;

function requestOf(tag: number): BooleanRequest {
  return {
    operation: "union",
    subjects: [
      { type: "polygon", coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10]]] },
      { type: "polygon", coordinates: [[[5, 5], [15, 5], [15, 15], [5, 15]]] },
    ],
    operands: [],
    tolerance: tag, // la "marca" de la petición: sirve para saber a cuál respondió el servidor
  };
}

function responseFor(tag: number) {
  return { operation: "union", scope: "combined", tolerance: tag, pieceCount: 0, results: [{ subjectIndex: null, changed: true, geometries: [] }] };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const bodyOf = (fetchMock: ReturnType<typeof abortAwareFetch>, call: number) => JSON.parse(String((fetchMock.mock.calls[call][1] as RequestInit).body)) as BooleanRequest;

interface Props {
  tag: number | null;
}

function setup(initial: number | null, handler: Parameters<typeof abortAwareFetch>[0], options: { strict?: boolean; debounceMs?: number } = {}) {
  const fetchMock = abortAwareFetch(handler);
  vi.stubGlobal("fetch", fetchMock);
  const wrapper = options.strict ? ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode> : undefined;
  const hook = renderHook(
    ({ tag }: Props) => useBooleanOperation({ request: tag === null ? null : requestOf(tag), requestKey: tag === null ? null : `k${tag}`, debounceMs: options.debounceMs ?? DEBOUNCE }),
    { initialProps: { tag: initial } as Props, wrapper },
  );
  return { fetchMock, ...hook };
}

describe("useBooleanOperation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("la primera petición sale enseguida (sin esperar el debounce): POST con la señal, y el estado pasa por calculando -> listo", async () => {
    let release: (response: Response) => void = () => {};
    const { fetchMock, result } = setup(1, () => new Promise<Response>((resolve) => (release = resolve)));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.urls[0]).toMatch(/\/api\/v2\/geometry\/boolean$/);
    expect(bodyOf(fetchMock, 0)).toEqual(requestOf(1));
    expect(fetchMock.signals[0]).toBeInstanceOf(AbortSignal);
    await waitFor(() => expect(result.current.status).toBe("calculating"));
    expect(result.current.response).toBeNull();

    await act(async () => release(json(responseFor(1))));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.response).toEqual(responseFor(1));
    expect(result.current.errorMessage).toBeNull();
  });

  it("DEBOUNCE: varios cambios seguidos (separados por menos que la espera) piden UNA sola vez, con la última petición", async () => {
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const { fetchMock, result, rerender } = setup(1, (_url, init) => json(responseFor(JSON.parse(String(init?.body)).tolerance)), { debounceMs: 300 });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    rerender({ tag: 2 });
    await wait(25);
    rerender({ tag: 3 });
    await wait(25);
    rerender({ tag: 4 });
    await wait(25);
    expect(fetchMock).toHaveBeenCalledTimes(1); // pasó tiempo real, pero cada cambio reinició la espera: nada salió todavía

    await waitFor(() => expect(result.current.status).toBe("ready"), { timeout: 2000 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetchMock, 1).tolerance).toBe(4);
    expect(result.current.response).toEqual(responseFor(4));
  });

  it("UNA petición viva a la vez: al cambiar, la anterior se ABORTA y la nueva espera a que termine de cancelarse", async () => {
    const aliveWhenCalled: boolean[] = [];
    const releases: Array<(response: Response) => void> = [];
    const live = new Set<number>();
    const fetchMock = abortAwareFetch((_url, init) => {
      const id = fetchMock.mock.calls.length;
      live.add(id);
      aliveWhenCalled.push(live.size > 1);
      const signal = init?.signal;
      signal?.addEventListener("abort", () => live.delete(id));
      return new Promise<Response>((resolve) => releases.push((response) => (live.delete(id), resolve(response))));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result, rerender } = renderHook(({ tag }: Props) => useBooleanOperation({ request: requestOf(tag!), requestKey: `k${tag}`, debounceMs: DEBOUNCE }), { initialProps: { tag: 1 } as Props });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rerender({ tag: 2 });
    // Se aborta YA, sin esperar al debounce.
    expect(fetchMock.signals[0]?.aborted).toBe(true);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(aliveWhenCalled).toEqual([false, false]); // al salir la 2ª no había otra viva
    expect(bodyOf(fetchMock, 1).tolerance).toBe(2);

    await act(async () => releases[1](json(responseFor(2))));
    await waitFor(() => expect(result.current.response).toEqual(responseFor(2)));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("un resultado solo vale para SU petición: al cambiar la clave no se muestra el de la anterior", async () => {
    const { fetchMock, result, rerender } = setup(1, (_url, init) => json(responseFor(JSON.parse(String(init?.body)).tolerance)));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.response).toEqual(responseFor(1));

    rerender({ tag: 2 });

    expect(result.current.response).toBeNull(); // no queda el resultado viejo "pegado" mientras se calcula el nuevo
    expect(result.current.status).not.toBe("ready");
    await waitFor(() => expect(result.current.response).toEqual(responseFor(2)));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("la misma clave con otra referencia de la petición NO vuelve a pedir (cambiar capa o «conservar originales» no cambia la geometría)", async () => {
    const { fetchMock, result, rerender } = setup(1, (_url, init) => json(responseFor(JSON.parse(String(init?.body)).tolerance)));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    rerender({ tag: 1 });
    rerender({ tag: 1 });
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE * 3));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("ready");
  });

  it("error del servidor: recuperable, sin resultado y con mensaje; reintentar vuelve a pedir y se recupera", async () => {
    let fail = true;
    const { fetchMock, result } = setup(1, () => (fail ? json({ code: "engine_unavailable", message: "caído" }, 503) : json(responseFor(1))));

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.response).toBeNull();
    expect(result.current.errorMessage).toMatch(/motor de geometría no está disponible.*No se modificó nada/);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fail = false;
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.errorMessage).toBeNull();
  });

  it("ensure(): con el resultado ya calculado no vuelve a pedir", async () => {
    const { fetchMock, result } = setup(1, () => json(responseFor(1)));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let outcome: Awaited<ReturnType<typeof result.current.ensure>> | undefined;
    await act(async () => {
      outcome = await result.current.ensure();
    });

    expect(outcome).toEqual({ ok: true, response: responseFor(1) });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ensure(): si cambió algo desde el último preview, RECALCULA ya (sin esperar el debounce) y devuelve el de la petición actual", async () => {
    const { fetchMock, result, rerender } = setup(1, (_url, init) => json(responseFor(JSON.parse(String(init?.body)).tolerance)));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    rerender({ tag: 2 });
    let outcome: Awaited<ReturnType<typeof result.current.ensure>> | undefined;
    await act(async () => {
      outcome = await result.current.ensure();
    });

    expect(outcome).toEqual({ ok: true, response: responseFor(2) });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // El timer del debounce que quedaba pendiente no genera una tercera petición.
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE * 3));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("ensure() mientras hay una petición en vuelo de la misma clave la reutiliza (una sola llamada)", async () => {
    let release: (response: Response) => void = () => {};
    const { fetchMock, result } = setup(1, () => new Promise<Response>((resolve) => (release = resolve)));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    let first: Promise<unknown> | undefined;
    let second: Promise<unknown> | undefined;
    act(() => {
      first = result.current.ensure();
      second = result.current.ensure();
    });
    await act(async () => release(json(responseFor(1))));

    await expect(first).resolves.toEqual({ ok: true, response: responseFor(1) });
    await expect(second).resolves.toEqual({ ok: true, response: responseFor(1) });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ensure() ante un error del servidor resuelve ok:false con el mensaje (nunca rechaza)", async () => {
    const { result } = setup(1, () => json({ code: "timeout", message: "lento" }, 504));
    await waitFor(() => expect(result.current.status).toBe("error"));

    let outcome: Awaited<ReturnType<typeof result.current.ensure>> | undefined;
    await act(async () => {
      outcome = await result.current.ensure();
    });

    expect(outcome).toMatchObject({ ok: false, aborted: false });
    expect(outcome && !outcome.ok && outcome.message).toMatch(/tardó demasiado/);
  });

  it("sin petición (plan inválido o panel cerrado): idle, no llama y aborta lo que estaba en vuelo", async () => {
    const { fetchMock, result, rerender } = setup(1, () => new Promise<Response>(() => {}));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rerender({ tag: null });

    expect(fetchMock.signals[0]?.aborted).toBe(true);
    expect(result.current.status).toBe("idle");
    expect(result.current.response).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE * 3));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cancel() aborta lo que está en vuelo y no entrega ningún resultado ni error", async () => {
    const { fetchMock, result } = setup(1, () => new Promise<Response>(() => {}));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    act(() => result.current.cancel());

    expect(fetchMock.signals[0]?.aborted).toBe(true);
    await waitFor(() => expect(result.current.status).not.toBe("calculating"));
    expect(result.current.response).toBeNull();
    expect(result.current.errorMessage).toBeNull();
  });

  it("desmontar aborta la petición en vuelo", async () => {
    const { fetchMock, unmount } = setup(1, () => new Promise<Response>(() => {}));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    unmount();

    expect(fetchMock.signals[0]?.aborted).toBe(true);
  });

  it("StrictMode (efecto -> cleanup -> efecto): UNA sola llamada al servidor", async () => {
    const { fetchMock, result } = setup(1, () => json(responseFor(1)), { strict: true });

    await waitFor(() => expect(result.current.status).toBe("ready"));
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE * 3));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.signals[0]?.aborted).toBe(false);
  });
});
