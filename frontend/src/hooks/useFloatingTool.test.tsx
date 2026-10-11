import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IDENTITY_MATRIX } from "../lib/svgTransform";
import type { EditableDocument, EditableLayerMeta, EditorEdit, EditorObject, EditProduction } from "../lib/editor/types";
import { abortAwareFetch } from "../test/abortableFetch";
import type { ApplyEditResult, EditProducer } from "./useEditableDocument";
import { useFloatingTool, type UseFloatingToolParams } from "./useFloatingTool";

/**
 * Orquestación de las piezas flotantes y los bridges (M3-S11) sin el Workspace: la sesión (análisis congelado, issue seleccionado, lista de bridges), el centrado del
 * issue (el `Rect` exacto que recibe `onFocusRect`), el ajuste de un click al borde según el zoom, el análisis viejo, el descarte al salir y el pipeline Apply
 * (preview del servidor -> UN `applyEdit` atómico -> aviso). El Workspace completo se prueba en EditorShell.floating.test.tsx.
 */

const LAYERS: EditableLayerMeta[] = [{ groupId: "A", name: "Rojo", colorHex: "#ff0000", order: 0, visible: true, locked: false, manufacturingOperation: "cut", isNew: false }];
// Un anillo 0..40 con hueco 10..30 (la isla) y un cuadrado macizo.
const o1: EditorObject = { id: "o1", layerGroupId: "A", d: "M0 0 H40 V40 H0 Z M10 10 H30 V30 H10 Z", fill: "#ff0000", matrix: IDENTITY_MATRIX };
const o2: EditorObject = { id: "o2", layerGroupId: "A", d: "M0 100 H40 V140 H0 Z", fill: "#ff0000", matrix: IDENTITY_MATRIX };
const DOC: EditableDocument = { objectsByLayer: { A: [o1, o2] }, layers: LAYERS };

const closed = (x0: number, y0: number, x1: number, y1: number): Array<[number, number]> => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];

type Body = Record<string, unknown>;

function floatingPayload(body: Body) {
  return {
    mode: body.mode,
    tolerance: body.tolerance,
    components: [
      { id: 0, kind: "principal", depth: 0, parent: null, polygon: null, area: null, bounds: [0, 0, 40, 140], subjects: [] },
      { id: 1, kind: "floating", depth: 1, parent: 0, polygon: { type: "polygon", coordinates: [closed(10, 10, 30, 30)] }, area: 400, bounds: [10, 10, 30, 30], subjects: [0] },
    ],
    floatingCount: 1,
    mainCount: 1,
    discarded: 0,
  };
}

/** Un bridge recto a la derecha de la isla (ancho `width`, de x = 30 a x = 40): válido; con `suggest` se agrega la sugerencia de la isla 1. */
function bridgePayload(body: Body) {
  const asks = body.bridges as Array<{ island?: number; anchor?: { x: number; y: number }; direction?: { x: number; y: number }; width: number }>;
  const list = asks.length > 0 ? asks.map((ask) => ({ ask, suggested: false })) : body.suggest === true ? [{ ask: { island: 1, width: body.suggestWidth as number }, suggested: true }] : [];
  const bridges = list.map(({ ask, suggested }, index) => ({
    index,
    suggested,
    valid: true,
    reason: null,
    island: 1,
    anchor: { x: 30, y: ask.anchor?.y ?? 20 },
    direction: { x: 1, y: 0 },
    width: ask.width,
    length: 10,
    area: ask.width * 10,
    reduces: index === 0,
    affects: [0],
    polygon: { type: "polygon", coordinates: [closed(29.96, (ask.anchor?.y ?? 20) - ask.width / 2, 40.04, (ask.anchor?.y ?? 20) + ask.width / 2)] },
  }));
  const piece = { type: "polygon", coordinates: [[[0, 0], [40, 0], [40, 19], [30, 19], [30, 10], [10, 10], [10, 30], [30, 30], [30, 21], [40, 21], [40, 40], [0, 40], [0, 0]]] };
  const changed = bridges.length > 0;
  return {
    mode: body.mode,
    tolerance: body.tolerance,
    bridges,
    results: [
      { subjectIndex: 0, changed, geometries: changed ? [piece] : [] },
      { subjectIndex: 1, changed: false, geometries: [] },
    ],
    reanalysis: { floatingBefore: 1, floatingAfter: changed ? 0 : 1, mainAfter: 1 },
    pieceCount: changed ? 1 : 0,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const APPLIED: ApplyEditResult = { applied: true, skippedLockedObjects: 0, skippedHiddenObjects: 0, edit: { label: "x", touched: {} } as EditorEdit };

interface Setup {
  fetchMock: ReturnType<typeof abortAwareFetch>;
  calls: { floating: Body[]; bridge: Body[] };
  applyEdit: ReturnType<typeof vi.fn<(label: string, producer: EditProducer) => ApplyEditResult>>;
  onApplied: ReturnType<typeof vi.fn>;
  onClose: ReturnType<typeof vi.fn>;
  onFocusRect: ReturnType<typeof vi.fn>;
}

function setup(overrides: Partial<UseFloatingToolParams> = {}, respond: { floating?: (body: Body) => Response | Promise<Response>; bridge?: (body: Body) => Response | Promise<Response> } = {}) {
  const calls: Setup["calls"] = { floating: [], bridge: [] };
  const fetchMock = abortAwareFetch((url, init) => {
    const body = JSON.parse(String(init?.body)) as Body;
    if (url.endsWith("/api/v2/geometry/floating")) {
      calls.floating.push(body);
      return respond.floating ? respond.floating(body) : json(floatingPayload(body));
    }
    calls.bridge.push(body);
    return respond.bridge ? respond.bridge(body) : json(bridgePayload(body));
  });
  vi.stubGlobal("fetch", fetchMock);
  const applyEdit = vi.fn<(label: string, producer: EditProducer) => ApplyEditResult>(() => APPLIED);
  const onApplied = vi.fn();
  const onClose = vi.fn();
  const onFocusRect = vi.fn();
  let counter = 0;
  const params: UseFloatingToolParams = {
    active: true,
    editable: { applyEdit, getSnapshot: () => DOC },
    state: DOC,
    selectedObjects: [],
    mmFactor: 0.5,
    viewScale: 1,
    createId: () => `p${(counter += 1)}`,
    onFocusRect,
    onApplied,
    onClose,
    ...overrides,
  };
  const hook = renderHook((props: UseFloatingToolParams) => useFloatingTool(props), { initialProps: params });
  return { ...hook, fetchMock, calls, applyEdit, onApplied, onClose, onFocusRect, params };
}

/** Analiza y espera el análisis y las sugerencias. */
async function analyzed(overrides: Partial<UseFloatingToolParams> = {}, respond: Parameters<typeof setup>[1] = {}) {
  const built = setup(overrides, respond);
  act(() => built.result.current.panel.onAnalyze());
  await waitFor(() => expect(built.result.current.panel.issues).toHaveLength(1));
  await waitFor(() => expect(built.result.current.panel.bridges.status).toBe("ready"));
  return built;
}

describe("useFloatingTool", () => {
  afterEach(() => vi.unstubAllGlobals());

  describe("análisis", () => {
    it("sin apretar Analizar no pide nada, y Apply dice que primero hay que analizar", async () => {
      const { result, fetchMock } = setup();

      await new Promise((resolve) => setTimeout(resolve, 350));

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.current.panel.applyDisabledReason).toBe("Primero analizá las piezas flotantes.");
      expect(result.current.panel.issues).toEqual([]);
      expect(result.current.overlay).toBeUndefined();
    });

    it("Analizar congela el plan, pide el análisis UNA vez y arma los issues; el alcance son las capas CUT", async () => {
      const { result, calls, fetchMock } = await analyzed();

      expect(calls.floating).toHaveLength(1);
      expect(calls.floating[0].mode).toBe("stencil");
      expect((calls.floating[0].subjects as unknown[]).length).toBe(2);
      expect(fetchMock.urls.filter((url) => url.endsWith("/floating"))).toHaveLength(1);
      expect(result.current.panel.issues).toEqual([{ id: 1, label: "Isla 1", description: "Isla 1 · 100 mm² · rodeada por «Rojo · objeto 1»", depth: 1 }]);
      expect(result.current.panel.analysis.summary).toBe("Se encontraron 1 isla (se caen al cortar).");
      expect(result.current.panel.scopeText).toBe("Capas CUT: Rojo (2 objetos).");
    });

    it("sin objetos que analizar el rechazo queda en el mensaje y no se llama al servidor", async () => {
      const { result, fetchMock } = setup({ state: { objectsByLayer: { A: [o1] }, layers: [{ ...LAYERS[0], manufacturingOperation: "unassigned" }] } });

      act(() => result.current.panel.onAnalyze());

      expect(result.current.panel.message).toMatch(/No hay capas con operación CUT visibles/);
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("cambiar el modo descarta el análisis (y lo que se había pedido) y el siguiente Analizar manda el modo nuevo", async () => {
      const { result, calls } = await analyzed();

      act(() => result.current.panel.onModeChange("parts"));

      expect(result.current.panel.issues).toEqual([]);
      expect(result.current.panel.mode).toBe("parts");
      expect(result.current.panel.analysis.hasAnalysis).toBe(false);
      act(() => result.current.panel.onAnalyze());
      await waitFor(() => expect(calls.floating).toHaveLength(2));
      expect(calls.floating[1].mode).toBe("parts");
    });

    it("cambiar el modo a ese mismo no descarta nada", async () => {
      const { result } = await analyzed();

      act(() => result.current.panel.onModeChange("stencil"));

      expect(result.current.panel.issues).toHaveLength(1);
    });
  });

  describe("seleccionar un issue", () => {
    it("avisa al shell el rectángulo EXACTO de la pieza para centrar la vista y la marca como seleccionada para resaltarla en el overlay", async () => {
      const { result, onFocusRect } = await analyzed();
      expect(result.current.overlay?.selectedId).toBeNull();

      act(() => result.current.panel.onSelectIssue(1));

      expect(onFocusRect).toHaveBeenCalledTimes(1);
      expect(onFocusRect).toHaveBeenCalledWith({ x: 10, y: 10, width: 20, height: 20 });
      expect(result.current.panel.selectedIssue).toBe(1);
      expect(result.current.overlay?.selectedId).toBe(1);
      expect(result.current.overlay?.issues).toEqual([{ id: 1, position: 1, d: "M10 10 L30 10 L30 30 L10 30 Z", rect: { x: 10, y: 10, width: 20, height: 20 } }]);
    });

    it("un id que no existe no centra nada ni cambia la selección", async () => {
      const { result, onFocusRect } = await analyzed();

      act(() => result.current.panel.onSelectIssue(99));

      expect(onFocusRect).not.toHaveBeenCalled();
      expect(result.current.panel.selectedIssue).toBeNull();
    });
  });

  describe("bridges", () => {
    it("tras el análisis pide las sugerencias (ancho 0,8 mm = 1,6 u) y las muestra; un solo bridge sugerido para la única isla", async () => {
      const { result, calls } = await analyzed();

      expect(calls.bridge).toHaveLength(1);
      expect(calls.bridge[0]).toMatchObject({ suggest: true, bridges: [] });
      expect(calls.bridge[0].suggestWidth).toBeCloseTo(1.6, 12);
      expect(result.current.panel.bridges.rows).toEqual([
        expect.objectContaining({ index: 0, key: "s1", label: "Bridge 1", islandLabel: "Isla 1", suggested: true, valid: true, reduces: true, moving: false }),
      ]);
      expect(result.current.panel.bridges.reanalysisText).toBe("1 flotante → 0 (ninguna pieza se cae)");
      expect(result.current.panel.applyDisabledReason).toBeNull();
    });

    it("quitar un bridge adopta la lista como explícita y, sin ninguno, no hay nada que pedir ni aplicar", async () => {
      const { result, calls } = await analyzed();

      act(() => result.current.panel.onRemoveBridge("s1"));

      await waitFor(() => expect(result.current.panel.bridges.rows).toEqual([]));
      expect(result.current.panel.bridges.rejection).toMatchObject({ info: true });
      expect(result.current.panel.applyDisabledReason).toMatch(/No hay bridges\. Usá «Sugerir bridges»/);
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(calls.bridge).toHaveLength(1); // no se pidió una lista vacía

      // Las sugerencias vuelven (la petición es la misma de antes y su resultado sigue calculado: no hace falta pedirlo de nuevo).
      act(() => result.current.panel.onSuggest());
      await waitFor(() => expect(result.current.panel.bridges.rows).toHaveLength(1));
      expect(result.current.panel.bridges.rows[0]).toMatchObject({ key: "s1", suggested: true });
      expect(calls.bridge).toHaveLength(1);
    });

    it("el ancho nuevo (mm) viaja en unidades; con la lista adoptada, los bridges van explícitos", async () => {
      const { result, calls } = await analyzed();
      act(() => result.current.panel.onRemoveBridge("nada")); // adopta la lista sin quitar nada real

      act(() => result.current.panel.onWidthChange(2));

      await waitFor(() => expect(calls.bridge).toHaveLength(2));
      expect(calls.bridge[1]).toMatchObject({ suggest: false, bridges: [{ island: 1, anchor: { x: 30, y: 20 }, direction: { x: 1, y: 0 }, width: 4 }] });
    });

    it("colocar: el click se AJUSTA al borde según el zoom (10 px de pantalla): a escala 1 un click a 8 u engancha; a escala 4 (2,5 u) no", async () => {
      const near = await analyzed();
      act(() => near.result.current.panel.onTogglePlacing());
      expect(near.result.current.surface).toBeDefined();

      act(() => near.result.current.surface!.onFloatingPoint({ x: 38, y: 20 })); // a 8 u del borde derecho de la isla (x = 30)

      await waitFor(() => expect(near.result.current.panel.bridges.rows).toHaveLength(2));
      expect(near.result.current.panel.message).toBeNull();
      await waitFor(() => expect(near.calls.bridge).toHaveLength(2));
      expect(near.calls.bridge[1].bridges).toEqual([
        { island: 1, anchor: { x: 30, y: 20 }, direction: { x: 1, y: 0 }, width: 1.6 },
        { island: 1, anchor: { x: 30, y: 20 }, width: 1.6 },
      ]);
      near.unmount();

      const far = await analyzed({ viewScale: 4 });
      act(() => far.result.current.panel.onTogglePlacing());
      act(() => far.result.current.surface!.onFloatingPoint({ x: 38, y: 20 }));
      expect(far.result.current.panel.message).toMatch(/Hacé click sobre el borde de una pieza flotante marcada/);
      expect(far.result.current.panel.bridges.rows).toHaveLength(1);
    });

    it("sin modo de colocación o sin piezas flotantes no hay superficie que capture el puntero", async () => {
      const { result } = await analyzed();
      expect(result.current.surface).toBeUndefined();

      act(() => result.current.panel.onTogglePlacing());
      expect(result.current.surface).toBeDefined();
      act(() => result.current.panel.onTogglePlacing());
      expect(result.current.surface).toBeUndefined();
    });

    it("mover reubica ESE bridge: el siguiente click sobre un borde cambia su ancla y termina el modo", async () => {
      const { result, calls } = await analyzed();
      act(() => result.current.panel.onStartMoving("s1"));
      expect(result.current.panel.placing).toBe("move");
      expect(result.current.panel.bridges.rows[0].moving).toBe(true);

      act(() => result.current.surface!.onFloatingPoint({ x: 29, y: 14 }));

      await waitFor(() => expect(calls.bridge).toHaveLength(2));
      expect(calls.bridge[1].bridges).toEqual([{ island: 1, anchor: { x: 30, y: 14 }, width: 1.6 }]);
      expect(result.current.panel.placing).toBeNull();
    });
  });

  describe("análisis viejo y salida", () => {
    it("si cambia alguno de los objetos analizados el análisis queda viejo: sin issues, sin overlay, sin más pedidos y Apply deshabilitado", async () => {
      const built = await analyzed();
      const calls = built.calls.bridge.length;

      built.rerender({ ...built.params, state: { objectsByLayer: { A: [{ ...o1 }, o2] }, layers: LAYERS } });

      await waitFor(() => expect(built.result.current.panel.analysis.stale).toBe(true));
      expect(built.result.current.panel.issues).toEqual([]);
      expect(built.result.current.overlay).toBeUndefined();
      expect(built.result.current.panel.applyDisabledReason).toBe("El documento cambió desde el análisis: volvé a analizar.");
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(built.calls.bridge).toHaveLength(calls);
    });

    it("cambiar la SELECCIÓN no deja viejo el análisis (solo cambiar los objetos)", async () => {
      const built = await analyzed();

      built.rerender({ ...built.params, selectedObjects: [o2] });

      expect(built.result.current.panel.analysis.stale).toBe(false);
      expect(built.result.current.panel.issues).toHaveLength(1);
      expect(built.result.current.panel.scopeText).toBe("Selección: 1 objeto."); // el alcance VIVO cambia; el análisis ya hecho no
    });

    it("salir de la herramienta aborta lo que estaba en vuelo y descarta la sesión; al volver entra una nueva", async () => {
      const built = setup({}, { floating: () => new Promise<Response>(() => {}) });
      act(() => built.result.current.panel.onAnalyze());
      await waitFor(() => expect(built.fetchMock).toHaveBeenCalledTimes(1));

      built.rerender({ ...built.params, active: false });

      expect(built.fetchMock.signals[0]?.aborted).toBe(true);
      built.rerender({ ...built.params, active: true });
      expect(built.result.current.panel.analysis.hasAnalysis).toBe(false);
      expect(built.result.current.panel.issues).toEqual([]);
    });

    it("un error del análisis queda como mensaje recuperable y deja a Apply deshabilitado", async () => {
      const built = setup({}, { floating: () => json({ code: "processing_error", message: "boom" }, 500) });

      act(() => built.result.current.panel.onAnalyze());

      await waitFor(() => expect(built.result.current.panel.analysis.status).toBe("error"));
      expect(built.result.current.panel.analysis.errorMessage).toMatch(/No se modificó nada/);
      expect(built.result.current.panel.applyDisabledReason).toBe("El análisis falló: reintentalo.");
    });
  });

  describe("Apply y teclado", () => {
    it("Apply llama a applyEdit UNA vez con la etiqueta del comando; el productor entrega la producción atómica solo si el documento sigue siendo el mismo; avisa con las piezas nuevas", async () => {
      const { result, applyEdit, onApplied } = await analyzed();

      await act(async () => result.current.panel.onApply());

      await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
      expect(applyEdit).toHaveBeenCalledTimes(1);
      expect(applyEdit.mock.calls[0][0]).toBe("Bridges: 1 bridge de 0.8 mm (1 → 0 flotantes)");
      const producer = applyEdit.mock.calls[0][1];
      const production = producer(DOC) as EditProduction;
      expect(production.atomic).toBe(true);
      expect(production.layers.A.map((object) => object.id)).toEqual(["p1", "o2"]);
      expect(producer({ ...DOC, objectsByLayer: { A: [o1, o2] } })).toBeNull(); // otra referencia de objectsByLayer: el documento cambió
      const [applied, edit] = onApplied.mock.calls[0];
      expect(applied.resultIds).toEqual(["p1"]);
      expect(applied.activeGroupId).toBe("A");
      expect(edit).toBe(APPLIED.edit);
      expect(result.current.panel.analysis.hasAnalysis).toBe(false); // la sesión se descartó
    });

    it("si applyEdit no aplica (capa bloqueada entre medio) no cierra nada y lo dice", async () => {
      const { result, applyEdit, onApplied } = await analyzed();
      applyEdit.mockReturnValueOnce({ applied: false, reason: "blocked", skippedLockedObjects: 1, skippedHiddenObjects: 0 });

      await act(async () => result.current.panel.onApply());

      await waitFor(() => expect(result.current.panel.message).toMatch(/Alguna capa está bloqueada u oculta.*No se hizo ningún cambio/));
      expect(onApplied).not.toHaveBeenCalled();
      expect(result.current.panel.analysis.hasAnalysis).toBe(true);
    });

    it("un doble Apply seguido aplica UNA sola vez", async () => {
      const { result, applyEdit } = await analyzed();

      await act(async () => {
        result.current.panel.onApply();
        result.current.panel.onApply();
      });

      await waitFor(() => expect(applyEdit).toHaveBeenCalledTimes(1));
    });

    it("sin resultado en cache Apply recalcula (ensure) y aplica lo ya calculado para SU petición; si el servidor falla, no aplica y avisa", async () => {
      let fail = false;
      const { result, applyEdit } = await analyzed({}, { bridge: (body) => (fail ? json({ code: "timeout", message: "lento" }, 504) : json(bridgePayload(body))) });
      fail = true;
      act(() => result.current.panel.onWidthChange(2)); // cambia la petición: el resultado viejo ya no vale

      await act(async () => result.current.panel.onApply());

      await waitFor(() => expect(result.current.panel.bridges.errorMessage).toMatch(/tardó demasiado/));
      expect(applyEdit).not.toHaveBeenCalled();
    });

    it("el teclado: Escape sale de la colocación, después descarta el análisis y, sin análisis, cierra; Enter aplica; los campos de texto conservan su Enter", async () => {
      const { result, onClose, applyEdit, onApplied } = await analyzed();
      act(() => result.current.panel.onTogglePlacing());

      act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })));
      expect(result.current.panel.placing).toBeNull();
      expect(result.current.panel.analysis.hasAnalysis).toBe(true);

      const input = document.createElement("input");
      document.body.appendChild(input);
      act(() => void input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
      expect(applyEdit).not.toHaveBeenCalled(); // Enter dentro de un campo no aplica
      input.remove();

      act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true })));
      await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
      expect(onClose).not.toHaveBeenCalled();
    });

    it("Escape sin análisis cierra la herramienta; con análisis solo lo descarta", async () => {
      const { result, onClose } = await analyzed();

      act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })));
      expect(result.current.panel.analysis.hasAnalysis).toBe(false);
      expect(onClose).not.toHaveBeenCalled();

      act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("Cancel cierra la herramienta sin aplicar nada", async () => {
      const { result, onClose, applyEdit } = await analyzed();

      act(() => result.current.panel.onCancel());

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(applyEdit).not.toHaveBeenCalled();
      expect(result.current.panel.analysis.hasAnalysis).toBe(false);
    });
  });
});
