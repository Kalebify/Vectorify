import { StrictMode, type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IDENTITY_MATRIX } from "../lib/svgTransform";
import type { EditableDocument, EditableLayerMeta, EditorObject } from "../lib/editor/types";
import { abortAwareFetch } from "../test/abortableFetch";
import type { FloatingComponent, FloatingRequest } from "../types/geometry";
import { useLaserCheck, type UseLaserCheckParams } from "./useLaserCheck";

const DEBOUNCE = 30;

const layer = (overrides: Partial<EditableLayerMeta> = {}): EditableLayerMeta => ({
  groupId: "A",
  name: "Corte",
  colorHex: "#ff0000",
  order: 0,
  visible: true,
  locked: false,
  manufacturingOperation: "cut",
  isNew: false,
  ...overrides,
});

const rect = (id: string, x: number, w = 20, d?: string): EditorObject => ({ id, layerGroupId: "A", d: d ?? `M${x} 0 H${x + w} V20 H${x} Z`, fill: "#ff0000", matrix: IDENTITY_MATRIX });
const doc = (objects: EditorObject[], layers: EditableLayerMeta[] = [layer()]): EditableDocument => ({ layers, objectsByLayer: { A: objects } });

const CLEAN = doc([rect("a", 0)]);
const WITH_OPEN = doc([rect("a", 0), rect("open", 100, 20, "M100 0 H120 V20 H100")]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Respuesta del servidor de flotantes: sin islas, o con una isla (hueco) por cada objeto de `islandOf`. */
function floatingReply(init: RequestInit | undefined, islands: Array<{ subject: number; bounds: [number, number, number, number] }> = []): Response {
  const body = JSON.parse(String(init?.body)) as FloatingRequest;
  const sheet: FloatingComponent = { id: 0, kind: "principal", depth: 0, parent: null, polygon: null, area: null, bounds: [0, 0, 300, 100], subjects: [] };
  const floating: FloatingComponent[] = islands.map((island, index) => {
    const [x0, y0, x1, y1] = island.bounds;
    return { id: index + 1, kind: "floating", depth: 1, parent: 0, polygon: { type: "polygon", coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] }, area: (x1 - x0) * (y1 - y0), bounds: island.bounds, subjects: [island.subject] };
  });
  return json({ mode: body.mode, tolerance: body.tolerance, components: [sheet, ...floating], floatingCount: floating.length, mainCount: 1, discarded: 0 });
}

interface Props {
  open: boolean;
  state: EditableDocument;
  mmFactor?: number | null;
}

function setup(initial: Props, handler: Parameters<typeof abortAwareFetch>[0], options: { strict?: boolean; onActivateIssue?: UseLaserCheckParams["onActivateIssue"] } = {}) {
  const fetchMock = abortAwareFetch(handler);
  vi.stubGlobal("fetch", fetchMock);
  const onActivateIssue = options.onActivateIssue ?? vi.fn();
  const wrapper = options.strict ? ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode> : undefined;
  const hook = renderHook(({ open, state, mmFactor = 1 }: Props) => useLaserCheck({ open, state, mmFactor, debounceMs: DEBOUNCE, onActivateIssue }), { initialProps: initial, wrapper });
  return { fetchMock, onActivateIssue, ...hook };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const bodyOf = (fetchMock: ReturnType<typeof abortAwareFetch>, call: number) => JSON.parse(String((fetchMock.mock.calls[call][1] as RequestInit).body)) as FloatingRequest;

describe("useLaserCheck", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("con el panel cerrado no analiza ni llama al servidor", async () => {
    const { fetchMock, result } = setup({ open: false, state: WITH_OPEN }, (_url, init) => floatingReply(init));

    await wait(DEBOUNCE * 4);

    expect(result.current.report).toBeNull();
    expect(result.current.overlay).toBeUndefined();
    expect(result.current.panel.hasAnalysis).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("al abrir analiza de inmediato los checks locales; las flotantes quedan pendientes (NO VERIFICADO: nunca Ready) hasta que contesta el servidor", async () => {
    let release: (response: Response) => void = () => {};
    const { fetchMock, result } = setup({ open: true, state: CLEAN }, () => new Promise<Response>((resolve) => (release = resolve)));

    await waitFor(() => expect(result.current.report).not.toBeNull());
    expect(result.current.report!.issues).toEqual([]);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(result.current.report!.status).toBe("review");
    expect(result.current.report!.unverified.map((check) => check.id)).toEqual(["floating"]);
    expect(result.current.panel.analyzing).toBe(true);
    expect(result.current.stale).toBe(false);

    await act(async () => release(floatingReply({ body: JSON.stringify(bodyOf(fetchMock, 0)) })));

    await waitFor(() => expect(result.current.report!.status).toBe("ready"));
    expect(result.current.panel.analyzing).toBe(false);
    expect(result.current.report!.unverified).toEqual([]);
    expect(result.current.panel.summary).toBe("Laser Check: Ready. Sin problemas detectados.");
  });

  it("manda UNA petición de flotantes en modo stencil con las formas con relleno de las capas CUT, en unidades de documento", async () => {
    const { fetchMock, result } = setup({ open: true, state: WITH_OPEN, mmFactor: 0.5 }, (_url, init) => floatingReply(init));

    await waitFor(() => expect(result.current.report!.unverified).toEqual([]));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.urls[0]).toMatch(/\/api\/v2\/geometry\/floating$/);
    const body = bodyOf(fetchMock, 0);
    expect(body.mode).toBe("stencil");
    expect(body.tolerance).toBeCloseTo(0.02, 12); // 0,01 mm a 0,5 mm por unidad
    expect(body.subjects).toHaveLength(2);
  });

  it("las islas del servidor entran como issues de error (Blocking) junto a los locales", async () => {
    const { result } = setup({ open: true, state: doc([rect("ring", 0, 40, "M0 0 H40 V40 H0 Z M10 10 H30 V30 H10 Z")]) }, (_url, init) =>
      floatingReply(init, [{ subject: 0, bounds: [10, 10, 30, 30] }]),
    );

    await waitFor(() => expect(result.current.report?.issues.map((issue) => issue.kind)).toEqual(["floating"]));

    expect(result.current.report!.status).toBe("blocking");
    expect(result.current.report!.issues[0]).toMatchObject({ objectIds: ["ring"], layerName: "Corte", rect: { x: 10, y: 10, width: 20, height: 20 } });
  });

  it("si las flotantes fallan lo informa SIN invalidar los checks locales: el error queda, el estado nunca es Ready y Reintentar se recupera", async () => {
    let fail = true;
    const { fetchMock, result } = setup({ open: true, state: WITH_OPEN }, (_url, init) => (fail ? json({ code: "processing_error", message: "boom" }, 500) : floatingReply(init)));

    await waitFor(() => expect(result.current.panel.floatingError).toMatch(/El servidor no pudo completar el cálculo/));

    expect(result.current.report!.issues.map((issue) => issue.kind)).toEqual(["open_path"]); // lo local sigue ahí
    expect(result.current.report!.status).toBe("blocking");
    expect(result.current.report!.unverified[0]).toMatchObject({ id: "floating" });
    fail = false;
    act(() => result.current.panel.onRetryFloating());
    await waitFor(() => expect(result.current.report!.unverified).toEqual([]));
    expect(result.current.panel.floatingError).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("un documento limpio con el servidor caído es Review, nunca Ready", async () => {
    const { result } = setup({ open: true, state: CLEAN }, () => json({ code: "engine_unavailable", message: "x" }, 503));

    await waitFor(() => expect(result.current.panel.floatingError).not.toBeNull());

    expect(result.current.report!.issues).toEqual([]);
    expect(result.current.report!.status).toBe("review");
  });

  it("sin objetos con relleno en CUT las flotantes no aplican: no se llama al servidor y el estado puede ser Ready", async () => {
    const engrave = doc([rect("a", 0)], [layer({ manufacturingOperation: "engrave" })]);
    const { fetchMock, result } = setup({ open: true, state: engrave }, (_url, init) => floatingReply(init));

    await waitFor(() => expect(result.current.report).not.toBeNull());
    await wait(DEBOUNCE * 3);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.report!.status).toBe("ready");
  });

  it("si el documento cambia, el resultado queda DESACTUALIZADO al instante (no se presenta como vigente) y se re-analiza tras el debounce", async () => {
    const { result, rerender } = setup({ open: true, state: CLEAN }, (_url, init) => floatingReply(init));
    await waitFor(() => expect(result.current.report!.status).toBe("ready"));
    const before = result.current.report;

    rerender({ open: true, state: WITH_OPEN });

    expect(result.current.stale).toBe(true);
    expect(result.current.panel.stale).toBe(true);
    expect(result.current.report).toBe(before); // sigue siendo el viejo
    expect(result.current.overlay).toBeUndefined(); // el overlay no resalta geometría vieja
    await waitFor(() => expect(result.current.stale).toBe(false));
    expect(result.current.report!.issues.map((issue) => issue.kind)).toEqual(["open_path"]);
  });

  it("varios cambios seguidos dentro del debounce = un solo re-análisis y una sola petición con lo último", async () => {
    const { fetchMock, result, rerender } = setup({ open: true, state: CLEAN }, (_url, init) => floatingReply(init));
    await waitFor(() => expect(result.current.report!.status).toBe("ready"));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    rerender({ open: true, state: doc([rect("a", 0), rect("b", 40)]) });
    rerender({ open: true, state: doc([rect("a", 0), rect("b", 40), rect("c", 80)]) });
    rerender({ open: true, state: doc([rect("a", 0), rect("b", 40), rect("c", 80), rect("d", 120)]) });
    await wait(DEBOUNCE * 4);
    await waitFor(() => expect(result.current.stale).toBe(false));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(bodyOf(fetchMock, 1).subjects).toHaveLength(4);
  });

  it("UNA petición viva: si el documento cambia mientras las flotantes están en vuelo, se ABORTA la anterior y la respuesta tardía nunca se muestra", async () => {
    const releases: Array<(response: Response) => void> = [];
    const { fetchMock, result, rerender } = setup({ open: true, state: CLEAN }, () => new Promise<Response>((resolve) => releases.push(resolve)));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rerender({ open: true, state: WITH_OPEN });
    await waitFor(() => expect(result.current.stale).toBe(false));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.signals[0]?.aborted).toBe(true);
    await act(async () => releases[0](floatingReply({ body: JSON.stringify(bodyOf(fetchMock, 0)) })));
    expect(result.current.panel.analyzing).toBe(true); // la respuesta vieja no se entrega

    await act(async () => releases[1](floatingReply({ body: JSON.stringify(bodyOf(fetchMock, 1)) })));
    await waitFor(() => expect(result.current.panel.analyzing).toBe(false));
    expect(result.current.report!.issues.map((issue) => issue.kind)).toEqual(["open_path"]);
  });

  it("un cambio que no toca la geometría de las flotantes (renombrar una capa) re-analiza lo local pero NO vuelve a pedir al servidor", async () => {
    const { fetchMock, result, rerender } = setup({ open: true, state: CLEAN }, (_url, init) => floatingReply(init));
    await waitFor(() => expect(result.current.report!.status).toBe("ready"));

    rerender({ open: true, state: { ...CLEAN, layers: [layer({ name: "Otro nombre" })] } });
    await waitFor(() => expect(result.current.stale).toBe(false));
    await wait(DEBOUNCE * 3);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.report!.status).toBe("ready");
  });

  it("Analizar a mano vuelve a correr los checks sin cambios en el documento; con la misma petición no vuelve a llamar al servidor", async () => {
    const { fetchMock, result } = setup({ open: true, state: CLEAN }, (_url, init) => floatingReply(init));
    await waitFor(() => expect(result.current.report!.status).toBe("ready"));
    const before = result.current.report;

    act(() => result.current.panel.onAnalyze());

    await waitFor(() => expect(result.current.report).not.toBe(before));
    expect(result.current.report!.status).toBe("ready");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("activar un issue lo deja seleccionado y avisa al shell; un issue de un resultado desactualizado no se activa", async () => {
    const onActivateIssue = vi.fn();
    const { result, rerender } = setup({ open: true, state: WITH_OPEN }, (_url, init) => floatingReply(init), { onActivateIssue });
    await waitFor(() => expect(result.current.report!.unverified).toEqual([]));
    const issue = result.current.report!.issues[0];

    act(() => result.current.panel.onSelectIssue(issue.id));

    expect(onActivateIssue).toHaveBeenCalledWith(issue);
    expect(result.current.panel.selectedIssueId).toBe(issue.id);
    expect(result.current.overlay).toMatchObject({ selectedId: issue.id });
    expect(result.current.overlay!.issues[0]).toMatchObject({ id: issue.id, severity: "error" });

    onActivateIssue.mockClear();
    rerender({ open: true, state: CLEAN });
    expect(result.current.stale).toBe(true);
    act(() => result.current.panel.onSelectIssue(issue.id));
    expect(onActivateIssue).not.toHaveBeenCalled();
    // Tras re-analizar, el issue ya no existe: no queda seleccionado.
    await waitFor(() => expect(result.current.stale).toBe(false));
    expect(result.current.panel.selectedIssueId).toBeNull();
  });

  it("la selección sobrevive a un re-análisis si el issue sigue existiendo (ids estables)", async () => {
    const { result, rerender } = setup({ open: true, state: WITH_OPEN }, (_url, init) => floatingReply(init));
    await waitFor(() => expect(result.current.report!.unverified).toEqual([]));
    const issue = result.current.report!.issues[0];
    act(() => result.current.panel.onSelectIssue(issue.id));

    rerender({ open: true, state: doc([...WITH_OPEN.objectsByLayer.A, rect("extra", 200)]) });
    await waitFor(() => expect(result.current.stale).toBe(false));

    expect(result.current.panel.selectedIssueId).toBe(issue.id);
  });

  it("cerrar el panel descarta el resultado, la selección y ABORTA lo que esté en vuelo; al reabrir analiza de cero", async () => {
    const releases: Array<(response: Response) => void> = [];
    const { fetchMock, result, rerender } = setup({ open: true, state: WITH_OPEN }, () => new Promise<Response>((resolve) => releases.push(resolve)));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    act(() => result.current.panel.onSelectIssue(result.current.report!.issues[0].id));

    rerender({ open: false, state: WITH_OPEN });

    expect(result.current.report).toBeNull();
    expect(result.current.panel.selectedIssueId).toBeNull();
    await waitFor(() => expect(fetchMock.signals[0]?.aborted).toBe(true));

    rerender({ open: true, state: WITH_OPEN });
    await waitFor(() => expect(result.current.report).not.toBeNull());
    expect(result.current.panel.selectedIssueId).toBeNull();
  });

  it("StrictMode: el análisis sale UNA sola vez (efecto -> cleanup -> efecto)", async () => {
    const { fetchMock, result } = setup({ open: true, state: CLEAN }, (_url, init) => floatingReply(init), { strict: true });

    await waitFor(() => expect(result.current.report!.status).toBe("ready"));
    await wait(DEBOUNCE * 3);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("con el servicio de geometría rechazando por demasiada geometría, las flotantes quedan no verificadas con el motivo (sin llamar)", async () => {
    const many = doc(Array.from({ length: 501 }, (_, index) => rect(`o${index}`, index * 30)));
    const { fetchMock, result } = setup({ open: true, state: many }, (_url, init) => floatingReply(init));

    await waitFor(() => expect(result.current.report).not.toBeNull());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.report!.status).toBe("review");
    expect(result.current.panel.floatingError).toMatch(/demasiados objetos/);
  });
});
