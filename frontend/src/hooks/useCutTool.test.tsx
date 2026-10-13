import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IDENTITY_MATRIX } from "../lib/svgTransform";
import type { CommandDraft } from "../lib/editor/commands";
import type { EditableDocument, EditableLayerMeta, EditorEdit, EditorObject, EditProduction } from "../lib/editor/types";
import { abortAwareFetch } from "../test/abortableFetch";
import type { SplitResponse } from "../types/geometry";
import type { ApplyEditResult, EditProducer } from "./useEditableDocument";
import { useCutTool, type UseCutToolParams } from "./useCutTool";

/**
 * Orquestación de Cut (M3-S10) sin el Workspace: la sesión de la línea de corte (puntos, terminada, segmento), su descarte al salir, y el pipeline Apply
 * (preview del servidor -> UN `applyEdit` -> aviso). El Workspace completo se prueba en EditorShell.cut.test.tsx.
 */

const LAYERS: EditableLayerMeta[] = [{ groupId: "A", name: "Rojo", colorHex: "#ff0000", order: 0, visible: true, locked: false, manufacturingOperation: "unassigned", isNew: false }];
const r1: EditorObject = { id: "r1", layerGroupId: "A", d: "M0 0 H40 V40 H0 Z", fill: "#ff0000", matrix: IDENTITY_MATRIX };
const r2: EditorObject = { id: "r2", layerGroupId: "A", d: "M0 100 H40 V140 H0 Z", fill: "#ff0000", matrix: IDENTITY_MATRIX };
const DOC: EditableDocument = { objectsByLayer: { A: [r1, r2] }, layers: LAYERS };

const ring = (x0: number, y0: number, x1: number, y1: number): Array<[number, number]> => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const halves = (request: { tolerance: number }): SplitResponse => ({
  mode: "split",
  slotWidth: 0,
  extend: false,
  tolerance: request.tolerance,
  pieceCount: 2,
  results: [
    {
      subjectIndex: 0,
      touched: true,
      changed: true,
      pieces: [{ type: "polygon", coordinates: [ring(0, 0, 20, 40)] }, { type: "polygon", coordinates: [ring(20, 0, 40, 40)] }],
      pieceCount: 2,
      discarded: 0,
    },
  ],
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const APPLIED: ApplyEditResult = { applied: true, skippedLockedObjects: 0, skippedHiddenObjects: 0, edit: { label: "x", touched: {} } as EditorEdit };

function setup(overrides: Partial<UseCutToolParams> = {}, respond: (body: { tolerance: number }) => Response | Promise<Response> = (body) => json(halves(body))) {
  const fetchMock = abortAwareFetch((_url, init) => respond(JSON.parse(String(init?.body))));
  vi.stubGlobal("fetch", fetchMock);
  const applyEdit = vi.fn<(draft: CommandDraft, producer: EditProducer) => ApplyEditResult>(() => APPLIED);
  const onApplied = vi.fn();
  const onClose = vi.fn();
  let counter = 0;
  const params: UseCutToolParams = {
    active: true,
    editable: { applyEdit, getSnapshot: () => DOC },
    state: DOC,
    selectedObjects: [r1],
    mmFactor: 0.5,
    createId: () => `p${(counter += 1)}`,
    onApplied,
    onClose,
    ...overrides,
  };
  const hook = renderHook((props: UseCutToolParams) => useCutTool(props), { initialProps: params });
  return { ...hook, params, applyEdit, onApplied, onClose, fetchMock };
}

const surface = (result: { current: ReturnType<typeof useCutTool> }) => result.current.surface!;
const points = (result: { current: ReturnType<typeof useCutTool> }) => result.current.panel.linePoints;

describe("useCutTool — la línea de corte", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("cada click suma un punto; el mismo punto dos veces seguidas (doble click) cuenta una sola vez", () => {
    const { result } = setup();

    act(() => surface(result).onCutPoint(pt(10, 10)));
    act(() => surface(result).onCutPoint(pt(10, 10)));
    expect(points(result)).toBe(1);
    act(() => surface(result).onCutPoint(pt(50, 10)));
    act(() => surface(result).onCutPoint(pt(10, 10))); // volver a un punto anterior NO es repetir
    expect(points(result)).toBe(3);
  });

  it("terminar necesita 2 puntos distintos; una línea terminada no acepta más puntos (Retroceso la reabre)", () => {
    const { result } = setup();
    act(() => surface(result).onCutPoint(pt(10, 10)));
    act(() => surface(result).onCutFinish());
    expect(result.current.panel.lineFinished).toBe(false);

    act(() => surface(result).onCutPoint(pt(50, 10)));
    act(() => surface(result).onCutFinish());
    expect(result.current.panel.lineFinished).toBe(true);
    act(() => surface(result).onCutPoint(pt(90, 10)));
    expect(points(result)).toBe(2);

    act(() => result.current.panel.onUndoPoint());
    expect(points(result)).toBe(1);
    expect(result.current.panel.lineFinished).toBe(false);
    act(() => surface(result).onCutPoint(pt(90, 10)));
    expect(points(result)).toBe(2);
  });

  it("un segmento recto reemplaza lo que hubiera y deja la línea terminada; un segmento de largo cero se ignora", () => {
    const { result } = setup();
    act(() => surface(result).onCutPoint(pt(1, 1)));
    act(() => surface(result).onCutPoint(pt(2, 2)));
    act(() => surface(result).onCutPoint(pt(3, 3)));

    act(() => surface(result).onCutSegment(pt(20, -10), pt(20, 50)));
    expect(result.current.surface!.cutLine).toEqual([pt(20, -10), pt(20, 50)]);
    expect(result.current.panel.lineFinished).toBe(true);

    act(() => surface(result).onCutSegment(pt(5, 5), pt(5, 5)));
    expect(result.current.surface!.cutLine).toEqual([pt(20, -10), pt(20, 50)]);
  });

  it("Borrar línea vacía el borrador; Cancel lo descarta TODO (modo incluido) y cierra la herramienta una sola vez", () => {
    const { result, onClose } = setup();
    act(() => surface(result).onCutSegment(pt(20, -10), pt(20, 50)));
    act(() => result.current.panel.onModeChange("slot"));
    act(() => result.current.panel.onClearLine());
    expect(points(result)).toBe(0);
    expect(result.current.panel.mode).toBe("slot");

    act(() => surface(result).onCutSegment(pt(20, -10), pt(20, 50)));
    act(() => result.current.panel.onCancel());

    expect(points(result)).toBe(0);
    expect(result.current.panel.mode).toBe("split");
    expect(result.current.panel.extend).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("al salir de la herramienta (active:false) la sesión se descarta; al volver a entrar empieza de cero", () => {
    const { result, rerender, params } = setup();
    act(() => surface(result).onCutSegment(pt(20, -10), pt(20, 50)));
    act(() => result.current.panel.onExtendChange(true));
    expect(points(result)).toBe(2);

    rerender({ ...params, active: false });
    expect(result.current.surface).toBeUndefined();
    expect(result.current.overlay).toBeUndefined();
    rerender({ ...params, active: true });

    expect(points(result)).toBe(0);
    expect(result.current.panel.extend).toBe(false);
  });

  it("sin línea no hay petición ni overlay: solo la ayuda de cómo dibujarla", () => {
    const { result, fetchMock } = setup();

    expect(result.current.panel.rejection).toEqual({ message: expect.stringMatching(/Dibujá la línea de corte/), info: true });
    expect(result.current.panel.applyDisabledReason).toMatch(/Dibujá la línea de corte/);
    expect(result.current.overlay).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("useCutTool — Apply", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function drawAndWaitReady(context: ReturnType<typeof setup>) {
    act(() => context.result.current.surface!.onCutSegment(pt(20, -10), pt(20, 50)));
    await waitFor(() => expect(context.result.current.panel.preview.status).toBe("ready"));
  }

  it("con el resultado listo, Apply hace UN applyEdit con la etiqueta del corte y avisa con las piezas nuevas; la sesión queda limpia", async () => {
    const context = setup();
    await drawAndWaitReady(context);
    expect(context.result.current.panel.applyDisabledReason).toBeNull();

    await act(async () => context.result.current.panel.onApply());

    expect(context.applyEdit).toHaveBeenCalledTimes(1);
    expect(context.applyEdit.mock.calls[0][0]).toMatchObject({ type: "geometry.split", label: "Cortar: dividir (1 objeto → 2 piezas)", parameters: { mode: "split", extend: false, cutPointCount: 2, pieceCount: 2 } });
    expect(context.fetchMock).toHaveBeenCalledTimes(1); // Apply usó el resultado ya calculado
    expect(context.onApplied).toHaveBeenCalledTimes(1);
    const [applied, edit] = context.onApplied.mock.calls[0];
    expect(applied.resultIds).toEqual(["p1", "p2"]);
    expect(applied.activeGroupId).toBe("A");
    expect(edit).toBe(APPLIED.edit);
    expect(points(context.result)).toBe(0);
  });

  it("el productor del comando solo aplica si el documento sigue siendo el mismo que se leyó (si no, devuelve null)", async () => {
    const context = setup();
    await drawAndWaitReady(context);

    await act(async () => context.result.current.panel.onApply());

    const producer = context.applyEdit.mock.calls[0][1];
    const production = producer(DOC) as EditProduction;
    expect(Object.keys(production.layers)).toEqual(["A"]);
    expect(production.layers.A.map((object) => object.id)).toEqual(["p1", "p2", "r2"]);
    expect(production.atomic).toBe(true);
    expect(producer({ ...DOC, objectsByLayer: { A: [r1, r2] } })).toBeNull(); // otra referencia de objectsByLayer
  });

  it("si applyEdit no aplica (capa bloqueada entretanto) queda el mensaje en el panel, no se avisa y la línea se conserva", async () => {
    const context = setup();
    context.applyEdit.mockReturnValue({ applied: false, reason: "blocked", skippedLockedObjects: 1, skippedHiddenObjects: 0 });
    await drawAndWaitReady(context);

    await act(async () => context.result.current.panel.onApply());

    expect(context.onApplied).not.toHaveBeenCalled();
    expect(context.result.current.panel.message).toMatch(/Alguna capa está bloqueada u oculta.*No se hizo ningún cambio/);
    expect(points(context.result)).toBe(2);
  });

  it("si el documento cambió mientras se calculaba, applyCutResult lo rechaza y NO se llama a applyEdit", async () => {
    const edited = { ...r1 };
    const context = setup();
    await drawAndWaitReady(context);
    // El snapshot que lee Apply ya no contiene el objeto planeado (otra referencia).
    context.rerender({ ...context.params, editable: { applyEdit: context.applyEdit, getSnapshot: () => ({ objectsByLayer: { A: [edited, r2] }, layers: LAYERS }) } });

    await act(async () => context.result.current.panel.onApply());

    expect(context.applyEdit).not.toHaveBeenCalled();
    expect(context.result.current.panel.message).toMatch(/El documento cambió mientras se calculaba/);
  });

  it("un error del servidor deja Apply deshabilitado con el motivo y applyEdit nunca se llama", async () => {
    const context = setup({}, () => json({ code: "processing_error", message: "x" }, 500));
    act(() => context.result.current.surface!.onCutSegment(pt(20, -10), pt(20, 50)));
    await waitFor(() => expect(context.result.current.panel.preview.status).toBe("error"));

    expect(context.result.current.panel.applyDisabledReason).toBe("El cálculo falló: reintentalo o cambiá la línea.");
    await act(async () => context.result.current.panel.onApply());
    expect(context.applyEdit).not.toHaveBeenCalled();
  });

  it("dos Apply seguidos aplican UNA sola vez (el segundo se ignora mientras el primero está en curso)", async () => {
    const context = setup();
    await drawAndWaitReady(context);

    await act(async () => {
      void context.result.current.panel.onApply();
      void context.result.current.panel.onApply();
    });

    expect(context.applyEdit).toHaveBeenCalledTimes(1);
    expect(context.onApplied).toHaveBeenCalledTimes(1);
  });

  it("cambiar de modo después de calcular vuelve a pedir y Apply usa el resultado del modo vigente", async () => {
    const context = setup({}, (body) => json({ ...halves(body), mode: (body as unknown as { mode: string }).mode, slotWidth: (body as unknown as { slotWidth: number }).slotWidth }));
    await drawAndWaitReady(context);

    act(() => context.result.current.panel.onModeChange("slot"));
    await waitFor(() => expect(context.fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(context.result.current.panel.preview.status).toBe("ready"));
    await act(async () => context.result.current.panel.onApply());

    expect(context.applyEdit.mock.calls[0][0]).toMatchObject({ type: "geometry.split", label: "Cortar: ranura de 0.2 mm (1 objeto → 2 piezas)", parameters: { mode: "slot", slotWidth: 0.2, unit: "mm" } });
  });
});

function pt(x: number, y: number) {
  return { x, y };
}
