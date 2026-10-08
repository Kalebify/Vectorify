import Konva from "konva";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useMemo, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDENTITY_TRANSFORM } from "../../hooks/useCanvasTransform";
import { useEditableDocument, type EditableDocumentApi } from "../../hooks/useEditableDocument";
import type { VectorDocumentLayer } from "../../hooks/useVectorDocument";
import { resolveSelection, selectableObjects as selectableObjectsOf } from "../../lib/editor/selection";
import { abortAwareFetch, svgResponse } from "../../test/abortableFetch";
import type { EditorTool } from "./EditorToolbar";
import { VectorCanvas } from "./VectorCanvas";

/**
 * Eyedropper, Fill y Color sobre el canvas (M3-S03): hit-test geométrico de S01 -> la CAPA del objeto visible más arriba. Eyedropper lee
 * capas bloqueadas pero no ocultas; Fill dispara el callback del shell; Fill/Color solo SELECCIONAN (no mueven ni borran objetos).
 */

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

// Capa A: a1 (0..40) y a2 (20..60, arriba) se superponen. Capa B: b1 lejos (100..140), del MISMO hex que A (caso de color compartido).
const SVG_A = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><path data-vid="a1" d="M0 0 H40 V40 H0 Z" fill="#ff0000"/><path data-vid="a2" d="M20 20 H60 V60 H20 Z" fill="#ff0000"/></svg>`;
const SVG_B = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><path data-vid="b1" d="M100 100 H140 V140 H100 Z" fill="#ff0000"/></svg>`;

const LAYER_A = layer();
const LAYER_B = layer({ groupId: "B", name: "Rojo 2", vectorId: "vector-b", svgUrl: "/svg/B", colorHex: "#FF0000", order: 1 });

class ImmediateResizeObserver {
  callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe() {
    this.callback([{ contentRect: { width: 800, height: 600 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve() {}
  disconnect() {}
}

const OFFSET_X = 240;
const OFFSET_Y = 180;
const toScreen = (x: number, y: number) => ({ clientX: x + OFFSET_X, clientY: y + OFFSET_Y });

interface HarnessProps {
  layers: VectorDocumentLayer[];
  visibility?: Record<string, boolean>;
  tool: EditorTool;
  onApi: (api: EditableDocumentApi) => void;
  onSelection: (ids: string[]) => void;
  onPickColor?: (groupId: string) => void;
  onFillObject?: (objectId: string) => void;
  onToolShortcut?: (tool: EditorTool) => void;
}

function Harness({ layers, visibility = {}, tool, onApi, onSelection, onPickColor, onFillObject, onToolShortcut }: HarnessProps) {
  const editable = useEditableDocument(layers, { visibility });
  const [raw, setRaw] = useState<ReadonlySet<string>>(new Set());
  const pool = useMemo(() => selectableObjectsOf(editable.objectsByLayer, layers, visibility), [editable.objectsByLayer, layers, visibility]);
  const selected = useMemo(() => new Set(resolveSelection(pool, raw).map((object) => object.id)), [pool, raw]);
  onApi(editable);
  onSelection([...selected]);

  return (
    <VectorCanvas
      layers={layers}
      visibility={visibility}
      sourceWidthPx={320}
      sourceHeightPx={240}
      selectedGroupId={null}
      editable={editable}
      selectableObjects={pool}
      selectedObjectIds={selected}
      onSelectObjects={(ids) => setRaw(new Set(ids))}
      tool={tool}
      transform={IDENTITY_TRANSFORM}
      onZoomBy={vi.fn()}
      onPanBy={vi.fn()}
      onMeasure={vi.fn()}
      onPickColor={onPickColor}
      onFillObject={onFillObject}
      onToolShortcut={onToolShortcut}
    />
  );
}

async function renderCanvas(tool: EditorTool, props: Partial<HarnessProps> = {}) {
  let latestApi!: EditableDocumentApi;
  let latestSelection: string[] = [];
  const onPickColor = vi.fn();
  const onFillObject = vi.fn();
  const onToolShortcut = vi.fn();
  render(
    <Harness
      layers={[LAYER_A, LAYER_B]}
      tool={tool}
      onApi={(api) => (latestApi = api)}
      onSelection={(ids) => (latestSelection = ids)}
      onPickColor={onPickColor}
      onFillObject={onFillObject}
      onToolShortcut={onToolShortcut}
      {...props}
    />,
  );
  const canvas = await screen.findByRole("application");
  await waitFor(() => expect(Object.values(latestApi.layerStatus).length > 0 && Object.values(latestApi.layerStatus).every((status) => status === "ready")).toBe(true));
  await waitFor(() => expect(Konva.stages[Konva.stages.length - 1]?.find("Path").length).toBeGreaterThan(0));
  return { canvas, api: () => latestApi, selection: () => latestSelection, onPickColor, onFillObject, onToolShortcut };
}

function click(canvas: HTMLElement, x: number, y: number, options: { shiftKey?: boolean } = {}) {
  fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, ...toScreen(x, y), ...options });
  fireEvent.pointerUp(canvas, { pointerId: 1, ...toScreen(x, y), ...options });
}

function drag(canvas: HTMLElement, from: [number, number], to: [number, number]) {
  fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, ...toScreen(...from) });
  for (let step = 1; step <= 4; step += 1) {
    fireEvent.pointerMove(canvas, { pointerId: 1, ...toScreen(from[0] + ((to[0] - from[0]) * step) / 4, from[1] + ((to[1] - from[1]) * step) / 4) });
  }
  fireEvent.pointerUp(canvas, { pointerId: 1, ...toScreen(...to) });
}

function installFetch() {
  vi.stubGlobal("fetch", abortAwareFetch((url) => (url === "/svg/A" ? svgResponse(SVG_A) : url === "/svg/B" ? svgResponse(SVG_B) : svgResponse("", 404))));
}

describe("VectorCanvas — Eyedropper (M3-S03)", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ImmediateResizeObserver);
    installFetch();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("click sobre un objeto devuelve la CAPA del objeto (no un hex) y no toca selección, historial ni geometría", async () => {
    const { canvas, onPickColor, api, selection } = await renderCanvas("eyedropper");
    click(canvas, 10, 10);
    expect(onPickColor).toHaveBeenCalledTimes(1);
    expect(onPickColor).toHaveBeenLastCalledWith("A");
    click(canvas, 120, 120);
    expect(onPickColor).toHaveBeenLastCalledWith("B");
    expect(selection()).toEqual([]);
    expect(api().undoDepth).toBe(0);
    expect(api().geometryDirty).toBe(false);
  });

  it("objetos superpuestos: toma la capa del objeto de MÁS ARRIBA", async () => {
    const { canvas, onPickColor } = await renderCanvas("eyedropper");
    click(canvas, 30, 30); // a1 y a2, ambos de A: gana a2 (misma capa)
    expect(onPickColor).toHaveBeenLastCalledWith("A");
  });

  it("COLOR COMPARTIDO: dos capas con el mismo hex devuelven SU capa, no la primera con ese hex", async () => {
    const { canvas, onPickColor } = await renderCanvas("eyedropper");
    click(canvas, 120, 120); // b1 es #FF0000 igual que A, pero es de la capa B
    expect(onPickColor).toHaveBeenLastCalledWith("B");
  });

  it("click en vacío: sin cambios (no llama a nada)", async () => {
    const { canvas, onPickColor } = await renderCanvas("eyedropper");
    click(canvas, 300, 200);
    expect(onPickColor).not.toHaveBeenCalled();
  });

  it("capa OCULTA: no se toma (se ve lo que hay debajo; si no hay nada, nada)", async () => {
    const { canvas, onPickColor } = await renderCanvas("eyedropper", { visibility: { A: true, B: false } });
    click(canvas, 120, 120);
    expect(onPickColor).not.toHaveBeenCalled();
    click(canvas, 10, 10);
    expect(onPickColor).toHaveBeenCalledWith("A");
  });

  it("capa BLOQUEADA: sí se toma (solo lee)", async () => {
    const { canvas, onPickColor } = await renderCanvas("eyedropper", { layers: [LAYER_A, { ...LAYER_B, locked: true }] });
    click(canvas, 120, 120);
    expect(onPickColor).toHaveBeenCalledWith("B");
  });

  it("arrastrar con el Eyedropper no inicia gestos ni mueve objetos", async () => {
    const { canvas, api } = await renderCanvas("eyedropper");
    drag(canvas, [10, 10], [80, 80]);
    expect(api().gestureActive).toBe(false);
    expect(api().undoDepth).toBe(0);
    expect((Konva.stages[Konva.stages.length - 1].getLayers()[0].find("Path") as Konva.Path[])[0].x()).toBe(0);
  });

  it("el atajo I con el foco en el canvas pide la herramienta Eyedropper; con Ctrl/Alt/Shift no", async () => {
    const { canvas, onToolShortcut } = await renderCanvas("select");
    fireEvent.keyDown(canvas, { key: "i" });
    expect(onToolShortcut).toHaveBeenLastCalledWith("eyedropper");
    fireEvent.keyDown(canvas, { key: "I" });
    expect(onToolShortcut).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(canvas, { key: "i", ctrlKey: true });
    fireEvent.keyDown(canvas, { key: "i", altKey: true });
    fireEvent.keyDown(canvas, { key: "i", shiftKey: true });
    expect(onToolShortcut).toHaveBeenCalledTimes(2);
  });

  it("anuncia la herramienta activa en el nombre accesible y usa el cursor de mira", async () => {
    const { canvas } = await renderCanvas("eyedropper");
    expect(canvas).toHaveAttribute("aria-label", expect.stringContaining("Herramienta activa: Eyedropper"));
    expect(canvas).toHaveClass("vector-canvas-2--eyedropper");
  });
});

describe("VectorCanvas — Fill y Color (M3-S03): solo seleccionan, no mueven", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ImmediateResizeObserver);
    installFetch();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("Fill: el click sobre un objeto avisa al shell (onFillObject con su id) y no lo selecciona ni lo mueve", async () => {
    const { canvas, onFillObject, selection, api } = await renderCanvas("fill");
    click(canvas, 120, 120);
    expect(onFillObject).toHaveBeenCalledTimes(1);
    expect(onFillObject).toHaveBeenCalledWith("b1");
    expect(selection()).toEqual([]);
    expect(api().undoDepth).toBe(0);
  });

  it("Fill: Shift+click solo alterna la selección (para armar una multi-selección) y NO rellena", async () => {
    const { canvas, onFillObject, selection } = await renderCanvas("fill");
    click(canvas, 10, 10, { shiftKey: true });
    click(canvas, 120, 120, { shiftKey: true });
    expect(onFillObject).not.toHaveBeenCalled();
    expect(selection().sort()).toEqual(["a1", "b1"]);
  });

  it("Fill: click en vacío no rellena nada; arrastrar sobre el fondo hace marquee de selección", async () => {
    const { canvas, onFillObject, selection } = await renderCanvas("fill");
    click(canvas, 300, 200);
    expect(onFillObject).not.toHaveBeenCalled();
    drag(canvas, [-10, -10], [70, 70]);
    expect(selection().sort()).toEqual(["a1", "a2"]);
  });

  it("Color: el click selecciona el objeto (single) y NO rellena; arrastrarlo no lo mueve", async () => {
    const { canvas, onFillObject, selection, api } = await renderCanvas("color");
    click(canvas, 120, 120);
    expect(selection()).toEqual(["b1"]);
    expect(onFillObject).not.toHaveBeenCalled();
    drag(canvas, [120, 120], [200, 200]);
    expect(api().gestureActive).toBe(false);
    expect(api().undoDepth).toBe(0);
    expect(api().objectsByLayer.B[0]).toBe(api().committedObjectsByLayer.B[0]);
  });

  it("Color: Ctrl+A selecciona todo lo seleccionable, pero Suprimir y las flechas NO eliminan ni mueven (la selección es el objetivo del color)", async () => {
    const { canvas, selection, api } = await renderCanvas("color");
    fireEvent.keyDown(canvas, { key: "a", ctrlKey: true });
    expect(selection().sort()).toEqual(["a1", "a2", "b1"]);
    fireEvent.keyDown(canvas, { key: "Delete" });
    fireEvent.keyDown(canvas, { key: "ArrowRight" });
    expect(api().undoDepth).toBe(0);
    expect(api().objectsByLayer.A).toHaveLength(2);
  });

  it("Escape en Fill/Color NO limpia la selección (lo resuelve el shell: cancela el panel)", async () => {
    const { canvas, selection } = await renderCanvas("color");
    click(canvas, 120, 120);
    fireEvent.keyDown(canvas, { key: "Escape" });
    expect(selection()).toEqual(["b1"]);
  });

  it("Fill usa el cursor de mira", async () => {
    const fill = await renderCanvas("fill");
    expect(fill.canvas).toHaveClass("vector-canvas-2--fill");
  });
});
