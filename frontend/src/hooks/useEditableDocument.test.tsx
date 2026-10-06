import { StrictMode, useEffect } from "react";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bounds } from "../lib/editor/objects";
import { replaceObjects } from "../lib/editor/selection";
import { translate } from "../lib/editor/transform";
import type { EditorObject } from "../lib/editor/types";
import { abortAwareFetch, svgResponse } from "../test/abortableFetch";
import { COALESCE_WINDOW_MS, countChangedObjects, MAX_UNDO_STEPS, useEditableDocument, type UseEditableDocumentOptions } from "./useEditableDocument";
import type { VectorDocumentLayer } from "./useVectorDocument";

function layer(overrides: Partial<VectorDocumentLayer> = {}): VectorDocumentLayer {
  return {
    groupId: "A",
    name: "Rojo",
    colorHex: "#ff0000",
    fill: "#ff0000",
    vectorId: "vector-a",
    svgUrl: "/svg/A",
    pathCount: 2,
    componentCount: 1,
    manufacturingOperation: "cut",
    order: 0,
    visible: true,
    locked: false,
    areaPercent: 60,
    hasPartialAlpha: false,
    isExcluded: false,
    ...overrides,
  };
}

const SVG_A = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><path data-vid="a1" d="M0 0 H10 V10 H0 Z" fill="#ff0000"/><path data-vid="a2" d="M20 0 H30 V10 H20 Z" fill="#ff0000"/></svg>`;
const SVG_B = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><path data-vid="b1" d="M0 20 H10 V30 H0 Z" fill="#0000ff"/></svg>`;

function installFetch(overrides: Record<string, () => Response | Promise<Response>> = {}) {
  const fetchMock = abortAwareFetch((url) => {
    if (overrides[url]) return overrides[url]();
    if (url === "/svg/A") return svgResponse(SVG_A);
    if (url === "/svg/B") return svgResponse(SVG_B);
    return svgResponse("no existe", 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const LAYERS = [layer(), layer({ groupId: "B", vectorId: "vector-b", svgUrl: "/svg/B", colorHex: "#0000ff", order: 1 })];

async function renderLoaded(layers = LAYERS, options: UseEditableDocumentOptions = {}) {
  const hook = renderHook(({ layers: current, options: opts }) => useEditableDocument(current, opts), {
    initialProps: { layers, options },
  });
  await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
  await waitFor(() => expect(Object.values(hook.result.current.layerStatus).every((status) => status === "ready")).toBe(true));
  return hook;
}

/** Productor de prueba: traslada los objetos con esos ids (en cualquier capa). */
function moveIds(ids: string[], dx: number, dy = 0) {
  return (state: { objectsByLayer: Record<string, EditorObject[]> }) => {
    const targets = Object.values(state.objectsByLayer)
      .flat()
      .filter((object) => ids.includes(object.id));
    return replaceObjects(state, targets, (found) => translate(found, dx, dy));
  };
}

function layerBounds(result: { current: { objectsByLayer: Record<string, EditorObject[]> } }, groupId: string, id: string) {
  const object = result.current.objectsByLayer[groupId].find((candidate) => candidate.id === id)!;
  return bounds([object]);
}

describe("useEditableDocument — carga", () => {
  beforeEach(() => {
    installFetch();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("pide el SVG de cada capa UNA vez y expone objetos con ids de data-vid", async () => {
    const fetchMock = installFetch();
    const { result, rerender } = await renderLoaded();

    expect(fetchMock.urls.sort()).toEqual(["/svg/A", "/svg/B"]);
    expect(result.current.objectsByLayer.A.map((o) => o.id)).toEqual(["a1", "a2"]);
    expect(result.current.objectsByLayer.B.map((o) => o.id)).toEqual(["b1"]);
    expect(result.current.objectsByLayer.A[0].layerGroupId).toBe("A");

    // Metadata nueva (otra referencia de `layers`, mismas URLs): NO vuelve a pedir nada.
    rerender({ layers: LAYERS.map((l) => ({ ...l, name: `${l.name}!` })), options: {} });
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.geometryDirty).toBe(false);
  });

  it("estado de carga por capa: loading mientras la respuesta está pendiente, ready al llegar", async () => {
    let release: (response: Response) => void = () => {};
    installFetch({ "/svg/B": () => new Promise<Response>((resolve) => (release = resolve)) });

    const { result } = renderHook(() => useEditableDocument(LAYERS));
    await waitFor(() => expect(result.current.layerStatus.A).toBe("ready"));
    expect(result.current.layerStatus.B).toBe("loading");
    expect(result.current.isLoading).toBe(true);

    await act(async () => release(svgResponse(SVG_B)));
    await waitFor(() => expect(result.current.layerStatus.B).toBe("ready"));
    expect(result.current.isLoading).toBe(false);
  });

  it("HTTP de error o SVG inválido -> status error SOLO de esa capa; retry la recarga", async () => {
    let healthy = false;
    installFetch({ "/svg/B": () => (healthy ? svgResponse(SVG_B) : svgResponse("boom", 500)) });
    const { result } = renderHook(() => useEditableDocument(LAYERS));
    await waitFor(() => expect(result.current.layerStatus.B).toBe("error"));
    expect(result.current.layerStatus.A).toBe("ready");
    expect(result.current.objectsByLayer.B).toBeUndefined();

    healthy = true;
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.layerStatus.B).toBe("ready"));
    expect(result.current.objectsByLayer.B).toHaveLength(1);
  });

  it("un SVG que no es XML válido marca error (no una capa vacía silenciosa)", async () => {
    installFetch({ "/svg/A": () => svgResponse("<svg><path") });
    const { result } = renderHook(() => useEditableDocument([layer()]));
    await waitFor(() => expect(result.current.layerStatus.A).toBe("error"));
  });

  it("al desmontar aborta las cargas pendientes (AbortSignal) y no actualiza estado después", async () => {
    const fetchMock = installFetch({ "/svg/A": () => new Promise<Response>(() => {}) });
    const { unmount } = renderHook(() => useEditableDocument([layer()]));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.signals[0]?.aborted).toBe(false);
    unmount();
    expect(fetchMock.signals[0]?.aborted).toBe(true);
  });

  it("React StrictMode (efecto doble): las cargas abortadas se reinician y el documento termina cargado (nunca 'Cargando' eterno)", async () => {
    const fetchMock = installFetch();
    // `renderHook` con wrapper no dobla los efectos en este entorno: se usa `render` con un componente sonda.
    let latest: ReturnType<typeof useEditableDocument> | null = null;
    function Probe() {
      const api = useEditableDocument(LAYERS);
      useEffect(() => {
        latest = api;
      });
      return null;
    }
    render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    );

    await waitFor(() => expect(latest?.layerStatus.A).toBe("ready"));
    await waitFor(() => expect(latest?.layerStatus.B).toBe("ready"));
    expect(latest!.objectsByLayer.A).toHaveLength(2);
    // La primera pasada fue abortada de verdad (el mock respeta la señal) y se reintentó.
    expect(fetchMock.signals).toHaveLength(4);
    expect(fetchMock.signals.filter((signal) => signal?.aborted)).toHaveLength(2);
    expect(fetchMock.signals.filter((signal) => signal && !signal.aborted)).toHaveLength(2);
  });

  it("capa sin svgUrl (documento guardado sin asset): lista vacía lista, sin pedir la página como SVG", async () => {
    const fetchMock = installFetch();
    const { result } = renderHook(() => useEditableDocument([layer({ svgUrl: "" })]));
    await waitFor(() => expect(result.current.layerStatus.A).toBe("ready"));
    expect(result.current.objectsByLayer.A).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("si una capa ya cargada cambia de svgUrl se recarga y el historial se reinicia (los comandos viejos ya no son coherentes)", async () => {
    installFetch({ "/svg/A2": () => svgResponse(SVG_B) });
    const { result, rerender } = await renderLoaded();
    act(() => void result.current.applyEdit("Mover", moveIds(["a1"], 5)));
    expect(result.current.canUndo).toBe(true);

    rerender({ layers: [layer({ svgUrl: "/svg/A2" }), LAYERS[1]], options: {} });
    await waitFor(() => expect(result.current.objectsByLayer.A.map((o) => o.id)).toEqual(["b1"]));
    expect(result.current.canUndo).toBe(false);
    expect(result.current.geometryDirty).toBe(false);
  });
});

describe("useEditableDocument — applyEdit / undo / redo", () => {
  beforeEach(() => {
    installFetch();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("applyEdit cambia la geometría, undo la restaura EXACTA y redo la reaplica", async () => {
    const { result } = await renderLoaded();
    const original = result.current.objectsByLayer.A[0];

    let outcome = { applied: false } as ReturnType<typeof result.current.applyEdit>;
    act(() => {
      outcome = result.current.applyEdit("Mover 1 objeto", moveIds(["a1"], 5, 7));
    });
    expect(outcome.applied).toBe(true);
    expect(layerBounds(result, "A", "a1")).toEqual({ x: 5, y: 7, width: 10, height: 10 });
    expect(result.current.undoLabel).toBe("Mover 1 objeto");
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(false);

    act(() => void result.current.undo());
    expect(result.current.objectsByLayer.A[0]).toBe(original); // snapshot restaurado por referencia
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(true);
    expect(result.current.redoLabel).toBe("Mover 1 objeto");

    act(() => void result.current.redo());
    expect(layerBounds(result, "A", "a1")).toEqual({ x: 5, y: 7, width: 10, height: 10 });
    expect(result.current.canRedo).toBe(false);
  });

  it("un edit nuevo descarta la rama redo", async () => {
    const { result } = await renderLoaded();
    act(() => void result.current.applyEdit("uno", moveIds(["a1"], 1)));
    act(() => void result.current.applyEdit("dos", moveIds(["a1"], 1)));
    act(() => void result.current.undo());
    expect(result.current.canRedo).toBe(true);

    act(() => void result.current.applyEdit("tres", moveIds(["a2"], 3)));
    expect(result.current.canRedo).toBe(false);
    expect(result.current.undoDepth).toBe(2);
    expect(result.current.undoLabel).toBe("tres");
  });

  it("un comando que toca dos capas se deshace/rehace atómicamente", async () => {
    const { result } = await renderLoaded();
    act(() => void result.current.applyEdit("Mover 2", moveIds(["a1", "b1"], 4)));
    expect(layerBounds(result, "B", "b1")).toEqual({ x: 4, y: 20, width: 10, height: 10 });
    act(() => void result.current.undo());
    expect(layerBounds(result, "A", "a1")).toEqual({ x: 0, y: 0, width: 10, height: 10 });
    expect(layerBounds(result, "B", "b1")).toEqual({ x: 0, y: 20, width: 10, height: 10 });
  });

  it("producer null o sin cambios reales -> applied=false y NADA entra a la pila", async () => {
    const { result } = await renderLoaded();
    let first = { applied: true } as ReturnType<typeof result.current.applyEdit>;
    let second = { applied: true } as ReturnType<typeof result.current.applyEdit>;
    act(() => {
      first = result.current.applyEdit("nada", () => null);
      second = result.current.applyEdit("cero", moveIds(["a1"], 0, 0));
    });
    expect(first).toMatchObject({ applied: false, reason: "no_change" });
    expect(second).toMatchObject({ applied: false, reason: "no_change" });
    expect(result.current.undoDepth).toBe(0);
    expect(result.current.geometryDirty).toBe(false);
  });

  it("undo/redo sin historial no hacen nada", async () => {
    const { result } = await renderLoaded();
    let undone: unknown = "x";
    let redone: unknown = "x";
    act(() => {
      undone = result.current.undo();
      redone = result.current.redo();
    });
    expect(undone).toBeNull();
    expect(redone).toBeNull();
  });

  it("límite de la pila: al excederlo se descarta el más viejo (y sigue 'sin guardar')", async () => {
    const { result } = await renderLoaded(LAYERS, { limit: 3 });
    for (let step = 1; step <= 5; step += 1) {
      act(() => void result.current.applyEdit(`paso ${step}`, moveIds(["a1"], 1)));
    }
    expect(result.current.undoDepth).toBe(3);
    expect(result.current.undoLabel).toBe("paso 5");

    for (let step = 0; step < 3; step += 1) act(() => void result.current.undo());
    expect(result.current.canUndo).toBe(false);
    // El historial se agotó pero el documento NO volvió al estado cargado (2 pasos se descartaron).
    expect(layerBounds(result, "A", "a1")).toEqual({ x: 2, y: 0, width: 10, height: 10 });
    expect(result.current.geometryDirty).toBe(true);
  });

  it("el límite por defecto es 200", () => {
    expect(MAX_UNDO_STEPS).toBe(200);
  });

  it("geometryDirty: false al cargar, true tras editar, false al deshacer todo, true al rehacer", async () => {
    const { result } = await renderLoaded();
    expect(result.current.geometryDirty).toBe(false);
    act(() => void result.current.applyEdit("x", moveIds(["a1"], 1)));
    expect(result.current.geometryDirty).toBe(true);
    act(() => void result.current.undo());
    expect(result.current.geometryDirty).toBe(false);
    act(() => void result.current.redo());
    expect(result.current.geometryDirty).toBe(true);
  });

  it("getSnapshot devuelve el estado confirmado de forma síncrona (para handlers de teclado)", async () => {
    const { result } = await renderLoaded();
    act(() => {
      result.current.applyEdit("x", moveIds(["a1"], 9));
      const snapshot = result.current.getSnapshot();
      expect(bounds([snapshot.objectsByLayer.A[0]])).toEqual({ x: 9, y: 0, width: 10, height: 10 });
    });
  });
});

describe("useEditableDocument — capas editadas (base de la miniatura del Preview)", () => {
  beforeEach(() => {
    installFetch();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("editedLayerIds marca solo las capas cuya geometría difiere de la cargada; deshacer hasta el origen la saca", async () => {
    const { result } = await renderLoaded();
    expect([...result.current.editedLayerIds]).toEqual([]);

    act(() => void result.current.applyEdit("Mover", moveIds(["a1"], 5)));
    expect([...result.current.editedLayerIds]).toEqual(["A"]);

    act(() => void result.current.applyEdit("Mover", moveIds(["b1"], 5)));
    expect([...result.current.editedLayerIds].sort()).toEqual(["A", "B"]);

    act(() => void result.current.undo());
    act(() => void result.current.undo());
    expect([...result.current.editedLayerIds]).toEqual([]);
  });

  it("committedObjectsByLayer NO incluye la previsualización de un gesto en curso", async () => {
    const { result } = await renderLoaded();
    act(() => void result.current.beginGesture());
    act(() => void result.current.previewEdit(moveIds(["a1"], 50)));
    expect(layerBounds(result, "A", "a1")).toEqual({ x: 50, y: 0, width: 10, height: 10 });
    expect(result.current.committedObjectsByLayer.A[0].matrix.e).toBe(0);
    expect([...result.current.editedLayerIds]).toEqual([]);
  });
});

describe("useEditableDocument — gestos continuos (UN comando al soltar)", () => {
  beforeEach(() => {
    installFetch();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("durante el gesto la pila de undo NO crece; al soltar entra UN solo comando y un undo lo revierte completo", async () => {
    const { result } = await renderLoaded();
    expect(result.current.undoDepth).toBe(0);

    act(() => void result.current.beginGesture());
    for (let frame = 1; frame <= 60; frame += 1) {
      act(() => void result.current.previewEdit(moveIds(["a1", "a2"], frame, frame / 2)));
      expect(result.current.undoDepth).toBe(0); // nada en la pila mientras dura el gesto
      expect(result.current.canUndo).toBe(false);
    }
    // La vista SÍ muestra la previsualización...
    expect(layerBounds(result, "A", "a1")).toEqual({ x: 60, y: 30, width: 10, height: 10 });
    // ...y no es todavía el estado confirmado.
    expect(result.current.getSnapshot().objectsByLayer.A[0].matrix.e).toBe(0);

    let outcome = { applied: false } as ReturnType<typeof result.current.commitGesture>;
    act(() => {
      outcome = result.current.commitGesture("Mover 2 objetos");
    });
    expect(outcome.applied).toBe(true);
    expect(result.current.undoDepth).toBe(1);
    expect(result.current.gestureActive).toBe(false);
    expect(layerBounds(result, "A", "a2")).toEqual({ x: 80, y: 30, width: 10, height: 10 });

    act(() => void result.current.undo());
    expect(layerBounds(result, "A", "a1")).toEqual({ x: 0, y: 0, width: 10, height: 10 });
    expect(layerBounds(result, "A", "a2")).toEqual({ x: 20, y: 0, width: 10, height: 10 });
    expect(result.current.undoDepth).toBe(0);
  });

  it("cada previsualización parte del estado ANTES del gesto (no se acumulan los frames)", async () => {
    const { result } = await renderLoaded();
    act(() => void result.current.beginGesture());
    act(() => void result.current.previewEdit(moveIds(["a1"], 5)));
    act(() => void result.current.previewEdit(moveIds(["a1"], 7)));
    expect(layerBounds(result, "A", "a1")).toEqual({ x: 7, y: 0, width: 10, height: 10 }); // 7, no 12
  });

  it("cancelGesture descarta la previsualización sin dejar nada en la pila", async () => {
    const { result } = await renderLoaded();
    const original = result.current.objectsByLayer.A[0];
    act(() => void result.current.beginGesture());
    act(() => void result.current.previewEdit(moveIds(["a1"], 50)));
    act(() => result.current.cancelGesture());
    expect(result.current.objectsByLayer.A[0]).toBe(original);
    expect(result.current.undoDepth).toBe(0);
    expect(result.current.gestureActive).toBe(false);
    expect(result.current.geometryDirty).toBe(false);
  });

  it("soltar sin movimiento neto (volvió al origen) no crea comando", async () => {
    const { result } = await renderLoaded();
    act(() => void result.current.beginGesture());
    act(() => void result.current.previewEdit(moveIds(["a1"], 30)));
    act(() => void result.current.previewEdit(moveIds(["a1"], 0)));
    let outcome = { applied: true } as ReturnType<typeof result.current.commitGesture>;
    act(() => {
      outcome = result.current.commitGesture("Mover");
    });
    expect(outcome).toMatchObject({ applied: false, reason: "no_change" });
    expect(result.current.undoDepth).toBe(0);
  });

  it("applyEdit/undo/redo se rechazan mientras hay un gesto activo; beginGesture doble no pisa el anterior", async () => {
    const { result } = await renderLoaded();
    act(() => void result.current.applyEdit("previo", moveIds(["a2"], 1)));
    act(() => void result.current.beginGesture());

    let begun = true;
    let applied = { applied: true } as ReturnType<typeof result.current.applyEdit>;
    let undone: unknown = "x";
    act(() => {
      begun = result.current.beginGesture();
      applied = result.current.applyEdit("x", moveIds(["a1"], 1));
      undone = result.current.undo();
    });
    expect(begun).toBe(false);
    expect(applied).toMatchObject({ applied: false, reason: "gesture_active" });
    expect(undone).toBeNull();
    expect(result.current.undoDepth).toBe(1);
  });

  it("previewEdit/commitGesture fuera de un gesto no hacen nada", async () => {
    const { result } = await renderLoaded();
    let preview = { applied: true } as ReturnType<typeof result.current.previewEdit>;
    let commit = { applied: true } as ReturnType<typeof result.current.commitGesture>;
    act(() => {
      preview = result.current.previewEdit(moveIds(["a1"], 1));
      commit = result.current.commitGesture("x");
    });
    expect(preview.reason).toBe("no_gesture");
    expect(commit.reason).toBe("no_gesture");
    expect(result.current.undoDepth).toBe(0);
  });
});

describe("useEditableDocument — capas bloqueadas y ocultas", () => {
  beforeEach(() => {
    installFetch();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("una capa bloqueada NO se modifica: applied=false, reason blocked, cuenta de objetos omitidos y nada en la pila", async () => {
    const locked = [layer({ locked: true }), LAYERS[1]];
    const { result } = await renderLoaded(locked);
    const original = result.current.objectsByLayer.A;

    let outcome = { applied: true } as ReturnType<typeof result.current.applyEdit>;
    act(() => {
      outcome = result.current.applyEdit("Mover", moveIds(["a1", "a2"], 10));
    });
    expect(outcome).toMatchObject({ applied: false, reason: "blocked", skippedLockedObjects: 2, skippedHiddenObjects: 0 });
    expect(result.current.objectsByLayer.A).toBe(original);
    expect(result.current.undoDepth).toBe(0);
  });

  it("edición mixta: aplica a la capa libre, omite la bloqueada e informa cuántos objetos omitió", async () => {
    const { result } = await renderLoaded([layer({ locked: true }), LAYERS[1]]);
    let outcome = { applied: false } as ReturnType<typeof result.current.applyEdit>;
    act(() => {
      outcome = result.current.applyEdit("Mover", moveIds(["a1", "b1"], 10));
    });
    expect(outcome).toMatchObject({ applied: true, skippedLockedObjects: 1 });
    expect(layerBounds(result, "B", "b1")).toEqual({ x: 10, y: 20, width: 10, height: 10 });
    expect(layerBounds(result, "A", "a1")).toEqual({ x: 0, y: 0, width: 10, height: 10 });
    // El comando guardado solo toca la capa B.
    act(() => void result.current.undo());
    expect(layerBounds(result, "B", "b1")).toEqual({ x: 0, y: 20, width: 10, height: 10 });
  });

  it("bloquear una capa ANTES de editar bloquea la edición también en gestos (preview + commit)", async () => {
    const { result } = await renderLoaded([layer({ locked: true }), LAYERS[1]]);
    act(() => void result.current.beginGesture());
    let preview = { applied: true } as ReturnType<typeof result.current.previewEdit>;
    act(() => {
      preview = result.current.previewEdit(moveIds(["a1"], 10));
    });
    expect(preview).toMatchObject({ applied: false, reason: "blocked", skippedLockedObjects: 1 });
    let commit = { applied: true } as ReturnType<typeof result.current.commitGesture>;
    act(() => {
      commit = result.current.commitGesture("Mover");
    });
    expect(commit).toMatchObject({ applied: false, reason: "blocked", skippedLockedObjects: 1 });
    expect(result.current.undoDepth).toBe(0);
  });

  it("el lock se evalúa en el momento de editar (latest ref): bloquear después de cargar también aplica", async () => {
    const { result, rerender } = await renderLoaded();
    rerender({ layers: [layer({ locked: true }), LAYERS[1]], options: {} });
    let outcome = { applied: true } as ReturnType<typeof result.current.applyEdit>;
    act(() => {
      outcome = result.current.applyEdit("Mover", moveIds(["a1"], 3));
    });
    expect(outcome).toMatchObject({ applied: false, reason: "blocked" });
  });

  it("undo de una edición en una capa que se bloqueó después SÍ funciona (el historial no queda trabado)", async () => {
    const { result, rerender } = await renderLoaded();
    act(() => void result.current.applyEdit("Mover", moveIds(["a1"], 3)));
    rerender({ layers: [layer({ locked: true }), LAYERS[1]], options: {} });
    act(() => void result.current.undo());
    expect(layerBounds(result, "A", "a1")).toEqual({ x: 0, y: 0, width: 10, height: 10 });
  });

  it("capas ocultas (visibilidad efectiva) no se modifican y se informa", async () => {
    const { result } = await renderLoaded(LAYERS, { visibility: { A: false, B: true } });
    let outcome = { applied: true } as ReturnType<typeof result.current.applyEdit>;
    act(() => {
      outcome = result.current.applyEdit("Mover", moveIds(["a1", "b1"], 3));
    });
    expect(outcome).toMatchObject({ applied: true, skippedHiddenObjects: 1, skippedLockedObjects: 0 });
    expect(layerBounds(result, "A", "a1")).toEqual({ x: 0, y: 0, width: 10, height: 10 });
    expect(layerBounds(result, "B", "b1")).toEqual({ x: 3, y: 20, width: 10, height: 10 });
  });
});

describe("useEditableDocument — coalescing de ediciones repetidas (flechas)", () => {
  beforeEach(() => {
    installFetch();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("misma clave dentro de la ventana -> UN comando que conserva el 'antes' original", async () => {
    // Se hace sin waitFor con timers falsos de Date: renderLoaded usa timers reales de waitFor (solo Date está falseado).
    const { result } = await renderLoaded();
    for (let press = 0; press < 5; press += 1) {
      act(() => void result.current.applyEdit("Mover", moveIds(["a1"], 1), { coalesceKey: "nudge" }));
      vi.setSystemTime(Date.now() + 100);
    }
    expect(result.current.undoDepth).toBe(1);
    expect(layerBounds(result, "A", "a1")).toEqual({ x: 5, y: 0, width: 10, height: 10 });
    act(() => void result.current.undo());
    expect(layerBounds(result, "A", "a1")).toEqual({ x: 0, y: 0, width: 10, height: 10 });
  });

  it("fuera de la ventana o con otra clave -> comandos separados", async () => {
    const { result } = await renderLoaded();
    act(() => void result.current.applyEdit("Mover", moveIds(["a1"], 1), { coalesceKey: "nudge" }));
    vi.setSystemTime(Date.now() + COALESCE_WINDOW_MS + 1);
    act(() => void result.current.applyEdit("Mover", moveIds(["a1"], 1), { coalesceKey: "nudge" }));
    act(() => void result.current.applyEdit("Mover", moveIds(["a1"], 1), { coalesceKey: "otra" }));
    act(() => void result.current.applyEdit("Mover", moveIds(["a1"], 1)));
    expect(result.current.undoDepth).toBe(4);
  });

  it("ir y volver (→ ←) deja el comando en no-op: se descarta y el documento vuelve a 'sin cambios'", async () => {
    const { result } = await renderLoaded();
    act(() => void result.current.applyEdit("Mover", moveIds(["a1"], 1), { coalesceKey: "nudge" }));
    act(() => void result.current.applyEdit("Mover", moveIds(["a1"], -1), { coalesceKey: "nudge" }));
    expect(result.current.undoDepth).toBe(0);
    expect(result.current.geometryDirty).toBe(false);
  });
});

describe("countChangedObjects", () => {
  const base = (id: string, e = 0): EditorObject => ({ id, layerGroupId: "A", d: "M0 0 L1 1", fill: "#000", matrix: { a: 1, b: 0, c: 0, d: 1, e, f: 0 } });

  it("cuenta modificados, agregados y quitados; copias idénticas no cuentan; reordenar cuenta 1", () => {
    const a = base("a");
    const b = base("b");
    expect(countChangedObjects([a, b], [a, b])).toBe(0);
    expect(countChangedObjects([a, b], [base("a"), b])).toBe(0); // misma geometría, otra referencia
    expect(countChangedObjects([a, b], [base("a", 5), b])).toBe(1);
    expect(countChangedObjects([a, b], [a])).toBe(1);
    expect(countChangedObjects([a], [a, base("c")])).toBe(1);
    expect(countChangedObjects([a, b], [b, a])).toBe(1);
  });
});
