import Konva from "konva";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useMemo, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDENTITY_TRANSFORM, type CanvasTransform } from "../../hooks/useCanvasTransform";
import { useEditableDocument, type EditableDocumentApi } from "../../hooks/useEditableDocument";
import type { VectorDocumentLayer } from "../../hooks/useVectorDocument";
import { matrixRotationDegrees } from "../../lib/editor/matrix";
import { bounds } from "../../lib/editor/objects";
import { resolveSelection, selectableObjects as selectableObjectsOf } from "../../lib/editor/selection";
import { abortAwareFetch, svgResponse } from "../../test/abortableFetch";
import type { EditorTool } from "./EditorToolbar";
import { VectorCanvas } from "./VectorCanvas";

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

// Capa A: a1 (0..40) y a2 (20..60) se SUPERPONEN (a2 arriba) -> pila de 2 en el cuadrante (20..40). Capa B: b1 lejos (100..140).
const SVG_A = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><path data-vid="a1" d="M0 0 H40 V40 H0 Z" fill="#ff0000"/><path data-vid="a2" d="M20 20 H60 V60 H20 Z" fill="#ff0000"/></svg>`;
const SVG_B = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><path data-vid="b1" d="M100 100 H140 V140 H100 Z" fill="#0000ff"/></svg>`;

const LAYER_A = layer();
const LAYER_B = layer({ groupId: "B", vectorId: "vector-b", svgUrl: "/svg/B", colorHex: "#0000ff", order: 1, name: "Azul" });

// jsdom no mide el layout: ResizeObserver con medición inmediata de 800×600 (ver también EditorShell.test.tsx).
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

// Con transform identidad, contenedor 800×600 y documento 320×240: pantalla = documento + (240, 180).
const OFFSET_X = 240;
const OFFSET_Y = 180;

interface HarnessProps {
  layers: VectorDocumentLayer[];
  visibility?: Record<string, boolean>;
  tool?: EditorTool;
  transform?: CanvasTransform;
  initialSelection?: string[];
  onApi: (api: EditableDocumentApi) => void;
  onSelection: (ids: string[]) => void;
  onZoomBy?: (factor: number, anchor?: { x: number; y: number }) => void;
  onPanBy?: (dx: number, dy: number) => void;
  onMeasure?: (size: { width: number; height: number }) => void;
}

/** Réplica mínima de la integración de EditorShell: estado editable real + selección por ids depurada contra los objetos seleccionables. */
function Harness({ layers, visibility = {}, tool = "select", transform = IDENTITY_TRANSFORM, initialSelection = [], onApi, onSelection, onZoomBy, onPanBy, onMeasure }: HarnessProps) {
  const editable = useEditableDocument(layers, { visibility });
  const [raw, setRaw] = useState<ReadonlySet<string>>(new Set(initialSelection));
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
      transform={transform}
      onZoomBy={onZoomBy ?? vi.fn()}
      onPanBy={onPanBy ?? vi.fn()}
      onMeasure={onMeasure ?? vi.fn()}
    />
  );
}

interface Rendered {
  canvas: HTMLElement;
  api: () => EditableDocumentApi;
  selection: () => string[];
  onZoomBy: ReturnType<typeof vi.fn>;
  onPanBy: ReturnType<typeof vi.fn>;
  onMeasure: ReturnType<typeof vi.fn>;
  rerender: (props: Partial<HarnessProps>) => void;
}

async function renderCanvas(props: Partial<HarnessProps> = {}, waitForLoad = true): Promise<Rendered> {
  let latestApi!: EditableDocumentApi;
  let latestSelection: string[] = [];
  const onZoomBy = vi.fn();
  const onPanBy = vi.fn();
  const onMeasure = vi.fn();
  const base: HarnessProps = {
    layers: [LAYER_A, LAYER_B],
    onApi: (api) => (latestApi = api),
    onSelection: (ids) => (latestSelection = ids),
    onZoomBy,
    onPanBy,
    onMeasure,
    ...props,
  };
  const utils = render(<Harness {...base} />);
  const canvas = await screen.findByRole("application");
  if (waitForLoad && (props.layers ?? base.layers).length > 0) {
    await waitFor(() => expect(Object.values(latestApi.layerStatus).length > 0 && Object.values(latestApi.layerStatus).every((status) => status === "ready")).toBe(true));
    await waitFor(() => expect(Konva.stages[Konva.stages.length - 1]?.find("Path").length).toBeGreaterThan(0));
  }
  return {
    canvas,
    api: () => latestApi,
    selection: () => latestSelection,
    onZoomBy,
    onPanBy,
    onMeasure,
    rerender: (next) => utils.rerender(<Harness {...base} {...next} />),
  };
}

function stage(): Konva.Stage {
  return Konva.stages[Konva.stages.length - 1];
}

/** Nodos Path del DOCUMENTO (primer Layer), por id de objeto (`data-vid`) vía orden de pintado. */
function documentPaths(): Konva.Path[] {
  return stage().getLayers()[0].find("Path") as Konva.Path[];
}

function transformer(): Konva.Transformer {
  return stage().findOne("Transformer") as Konva.Transformer;
}

interface PointerOptions {
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
}

const toScreen = (x: number, y: number) => ({ clientX: x + OFFSET_X, clientY: y + OFFSET_Y });

function pointerDown(canvas: HTMLElement, x: number, y: number, options: PointerOptions = {}) {
  fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, ...toScreen(x, y), ...options });
}
function pointerMove(canvas: HTMLElement, x: number, y: number, options: PointerOptions = {}) {
  fireEvent.pointerMove(canvas, { pointerId: 1, ...toScreen(x, y), ...options });
}
function pointerUp(canvas: HTMLElement, x: number, y: number, options: PointerOptions = {}) {
  fireEvent.pointerUp(canvas, { pointerId: 1, ...toScreen(x, y), ...options });
}
function click(canvas: HTMLElement, x: number, y: number, options: PointerOptions = {}) {
  pointerDown(canvas, x, y, options);
  pointerUp(canvas, x, y, options);
}
function drag(canvas: HTMLElement, from: [number, number], to: [number, number], steps = 4) {
  pointerDown(canvas, from[0], from[1]);
  for (let step = 1; step <= steps; step += 1) {
    pointerMove(canvas, from[0] + ((to[0] - from[0]) * step) / steps, from[1] + ((to[1] - from[1]) * step) / steps);
  }
  pointerUp(canvas, to[0], to[1]);
}

function boundsOf(api: EditableDocumentApi, groupId: string, id: string) {
  return bounds([api.objectsByLayer[groupId].find((object) => object.id === id)!]);
}

function installFetch() {
  const fetchMock = abortAwareFetch((url) => (url === "/svg/A" ? svgResponse(SVG_A) : url === "/svg/B" ? svgResponse(SVG_B) : svgResponse("", 404)));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("VectorCanvas — vista, zoom y pan (comportamiento de M2.1 que se conserva)", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ImmediateResizeObserver);
    installFetch();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("proyecto sin capas: estado vacío honesto, sin Stage", async () => {
    await renderCanvas({ layers: [] });
    expect(screen.getByText("Ninguna capa visible.")).toBeInTheDocument();
  });

  it("proyecto multicolor: pide el SVG real de cada capa (una vez; nunca datos hardcodeados)", async () => {
    const fetchMock = installFetch();
    await renderCanvas();
    expect(fetchMock.urls.sort()).toEqual(["/svg/A", "/svg/B"]);
  });

  it("dibuja un <Path> de Konva por objeto, en el orden de pintado de las capas", async () => {
    await renderCanvas();
    expect(documentPaths()).toHaveLength(3);
    expect(documentPaths().map((node) => node.data())).toEqual(["M0 0 H40 V40 H0 Z", "M20 20 H60 V60 H20 Z", "M100 100 H140 V140 H100 Z"]);
  });

  it("capa oculta: sus objetos no se dibujan", async () => {
    await renderCanvas({ visibility: { A: true, B: false } });
    expect(documentPaths()).toHaveLength(2);
  });

  it("reporta el tamaño medido del contenedor vía onMeasure (resize)", async () => {
    const { onMeasure } = await renderCanvas();
    await waitFor(() => expect(onMeasure).toHaveBeenCalledWith({ width: 800, height: 600 }));
  });

  it("la rueda del mouse llama a onZoomBy con un factor y un ancla relativa al centro", async () => {
    const { canvas, onZoomBy } = await renderCanvas();
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);

    fireEvent.wheel(canvas, { deltaY: -100, clientX: 400, clientY: 300 });

    expect(onZoomBy).toHaveBeenCalled();
    const [factor, anchor] = onZoomBy.mock.calls[0];
    expect(factor).toBeGreaterThan(1);
    expect(anchor).toEqual({ x: 0, y: 0 });
  });

  it("con la herramienta Pan, arrastrar llama a onPanBy y NO selecciona ni mueve objetos", async () => {
    const { canvas, onPanBy, api, selection } = await renderCanvas({ tool: "pan" });
    fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 120, clientY: 90 });
    await waitFor(() => expect(onPanBy).toHaveBeenCalled());
    expect(api().undoDepth).toBe(0);
    expect(selection()).toEqual([]);
  });

  it("con la herramienta Select, arrastrar el fondo NO llama a onPanBy (es un marquee)", async () => {
    const { canvas, onPanBy } = await renderCanvas({ tool: "select" });
    fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 120, clientY: 90 });
    expect(onPanBy).not.toHaveBeenCalled();
  });

  it("mantener Espacio activa el pan temporalmente (shortcut documentado)", async () => {
    const { canvas, onPanBy } = await renderCanvas({ tool: "select" });
    fireEvent.keyDown(canvas, { key: " " });
    fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 130, clientY: 100 });
    await waitFor(() => expect(onPanBy).toHaveBeenCalled());
  });

  it("+ / - de teclado llaman a onZoomBy; las flechas SIN selección desplazan la vista (pan)", async () => {
    const { canvas, onZoomBy, onPanBy } = await renderCanvas();
    fireEvent.keyDown(canvas, { key: "+" });
    expect(onZoomBy).toHaveBeenCalledWith(expect.any(Number));

    fireEvent.keyDown(canvas, { key: "ArrowUp" });
    expect(onPanBy).toHaveBeenLastCalledWith(0, 40);
    fireEvent.keyDown(canvas, { key: "ArrowLeft" });
    expect(onPanBy).toHaveBeenLastCalledWith(40, 0);
  });
});

describe("VectorCanvas — selección", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ImmediateResizeObserver);
    installFetch();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("click sobre un objeto lo selecciona (single); click en otro reemplaza la selección", async () => {
    const { canvas, selection } = await renderCanvas();
    click(canvas, 10, 10);
    expect(selection()).toEqual(["a1"]);
    click(canvas, 120, 120);
    expect(selection()).toEqual(["b1"]);
  });

  it("objetos superpuestos: el click elige el de MÁS ARRIBA", async () => {
    const { canvas, selection } = await renderCanvas();
    click(canvas, 30, 30); // dentro de a1 y a2
    expect(selection()).toEqual(["a2"]);
  });

  it("Alt+click cicla la pila de superpuestos hacia abajo y vuelve al tope", async () => {
    const { canvas, selection } = await renderCanvas();
    click(canvas, 30, 30);
    expect(selection()).toEqual(["a2"]);
    click(canvas, 30, 30, { altKey: true });
    expect(selection()).toEqual(["a1"]);
    click(canvas, 30, 30, { altKey: true });
    expect(selection()).toEqual(["a2"]);
  });

  it("click en el fondo vacío limpia la selección", async () => {
    const { canvas, selection } = await renderCanvas();
    click(canvas, 10, 10);
    expect(selection()).toEqual(["a1"]);
    click(canvas, 200, 10);
    expect(selection()).toEqual([]);
  });

  it("Shift+click agrega y quita objetos (toggle) sin arrastrar", async () => {
    const { canvas, selection, api } = await renderCanvas();
    click(canvas, 10, 10);
    click(canvas, 120, 120, { shiftKey: true });
    expect([...selection()].sort()).toEqual(["a1", "b1"]);
    click(canvas, 10, 10, { shiftKey: true });
    expect(selection()).toEqual(["b1"]);
    expect(api().undoDepth).toBe(0);
  });

  it("marquee: arrastrar en el fondo selecciona lo que el rectángulo intersecta; Shift agrega", async () => {
    const { canvas, selection } = await renderCanvas();
    drag(canvas, [-10, -10], [70, 70]);
    expect([...selection()].sort()).toEqual(["a1", "a2"]);

    pointerDown(canvas, 90, 90, { shiftKey: true });
    pointerMove(canvas, 150, 150, { shiftKey: true });
    pointerUp(canvas, 150, 150, { shiftKey: true });
    expect([...selection()].sort()).toEqual(["a1", "a2", "b1"]);
  });

  it("marquee con un rectángulo que no toca nada deja la selección vacía", async () => {
    const { canvas, selection } = await renderCanvas();
    click(canvas, 10, 10);
    drag(canvas, [200, 5], [260, 50]);
    expect(selection()).toEqual([]);
  });

  it("marquee dibuja un rectángulo en el overlay mientras se arrastra y lo quita al soltar", async () => {
    const { canvas } = await renderCanvas();
    pointerDown(canvas, -10, -10);
    pointerMove(canvas, 80, 80);
    await waitFor(() => expect(stage().find(".marquee").length).toBeGreaterThan(0));
    pointerUp(canvas, 80, 80);
    await waitFor(() => expect(stage().find(".marquee").length).toBe(0));
  });

  it("Ctrl+A selecciona todo lo seleccionable; Escape lo limpia", async () => {
    const { canvas, selection } = await renderCanvas();
    fireEvent.keyDown(canvas, { key: "a", ctrlKey: true });
    expect([...selection()].sort()).toEqual(["a1", "a2", "b1"]);
    fireEvent.keyDown(canvas, { key: "Escape" });
    expect(selection()).toEqual([]);
  });

  it("Cmd+A (metaKey) también selecciona todo", async () => {
    const { canvas, selection } = await renderCanvas();
    fireEvent.keyDown(canvas, { key: "A", metaKey: true });
    expect(selection()).toHaveLength(3);
  });

  it("capas ocultas no son seleccionables: ni por click, ni por marquee, ni por Ctrl+A", async () => {
    const { canvas, selection } = await renderCanvas({ visibility: { A: true, B: false } });
    click(canvas, 120, 120);
    expect(selection()).toEqual([]);
    drag(canvas, [90, 90], [150, 150]);
    expect(selection()).toEqual([]);
    fireEvent.keyDown(canvas, { key: "a", ctrlKey: true });
    expect([...selection()].sort()).toEqual(["a1", "a2"]);
  });

  it("ocultar la capa de un objeto seleccionado lo saca de la selección", async () => {
    const { canvas, selection, rerender } = await renderCanvas();
    click(canvas, 120, 120);
    expect(selection()).toEqual(["b1"]);
    rerender({ visibility: { A: true, B: false } });
    await waitFor(() => expect(selection()).toEqual([]));
  });

  it("dibuja un contorno por objeto seleccionado en el overlay (no en la capa del documento)", async () => {
    const { canvas } = await renderCanvas();
    click(canvas, 10, 10);
    await waitFor(() => expect(stage().getLayers()[1].find("Path").length).toBe(1));
    expect(documentPaths()).toHaveLength(3);
  });

  it("zoom ALTO (8×): la tolerancia de click es de ~4 px de pantalla, o sea 0.5 unidades de documento", async () => {
    const zoomed: CanvasTransform = { scale: 8, panX: 0, panY: 0 };
    const { canvas, selection } = await renderCanvas({ transform: zoomed });
    // doc (x,y) -> pantalla = (x-160)*8 + 400 ; (y-120)*8 + 300. Objeto a1 llega a x=40 -> pantalla 400-960 (fuera de vista pero válido).
    const screenOf = (x: number, y: number) => ({ clientX: (x - 160) * 8 + 400, clientY: (y - 120) * 8 + 300 });
    // 0.3 unidades (2.4 px) a la derecha del borde de a2 (x=60): dentro de la tolerancia.
    fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, ...screenOf(60.3, 40) });
    fireEvent.pointerUp(canvas, { pointerId: 1, ...screenOf(60.3, 40) });
    expect(selection()).toEqual(["a2"]);
    // 1 unidad (8 px) fuera: no.
    fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, ...screenOf(61, 40) });
    fireEvent.pointerUp(canvas, { pointerId: 1, ...screenOf(61, 40) });
    expect(selection()).toEqual([]);
  });

  it("zoom BAJO (0.1×): la misma tolerancia de 4 px abarca 40 unidades de documento", async () => {
    const zoomed: CanvasTransform = { scale: 0.1, panX: 0, panY: 0 };
    const { canvas, selection } = await renderCanvas({ transform: zoomed });
    const screenOf = (x: number, y: number) => ({ clientX: (x - 160) * 0.1 + 400, clientY: (y - 120) * 0.1 + 300 });
    // 30 unidades de documento (3 px) a la derecha del borde de a2.
    fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, ...screenOf(90, 40) });
    fireEvent.pointerUp(canvas, { pointerId: 1, ...screenOf(90, 40) });
    expect(selection()).toEqual(["a2"]);
  });
});

describe("VectorCanvas — Move (drag y teclado)", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ImmediateResizeObserver);
    installFetch();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("arrastrar un objeto lo mueve; durante el drag NO hay comandos en la pila; al soltar entra UNO", async () => {
    const { canvas, api } = await renderCanvas();
    pointerDown(canvas, 10, 10);
    pointerMove(canvas, 20, 10);
    pointerMove(canvas, 30, 20);
    pointerMove(canvas, 40, 40);

    // En pleno gesto: la vista ya muestra el movimiento, pero la pila de undo sigue vacía.
    expect(boundsOf(api(), "A", "a1")).toEqual({ x: 30, y: 30, width: 40, height: 40 });
    expect(api().undoDepth).toBe(0);
    expect(api().canUndo).toBe(false);
    expect(api().gestureActive).toBe(true);

    pointerUp(canvas, 40, 40);
    expect(api().undoDepth).toBe(1);
    expect(api().undoLabel).toBe("Mover 1 objeto");
    expect(api().gestureActive).toBe(false);
    expect(boundsOf(api(), "A", "a1")).toEqual({ x: 30, y: 30, width: 40, height: 40 });

    act(() => void api().undo());
    expect(boundsOf(api(), "A", "a1")).toEqual({ x: 0, y: 0, width: 40, height: 40 });
  });

  it("el desplazamiento es el delta TOTAL del puntero en unidades de documento (sin acumular por frame)", async () => {
    const { canvas, api } = await renderCanvas();
    drag(canvas, [10, 10], [13.7, 17.3], 50);
    const moved = boundsOf(api(), "A", "a1")!;
    expect(moved.x).toBeCloseTo(3.7, 9);
    expect(moved.y).toBeCloseTo(7.3, 9);
  });

  it("un temblor menor al umbral (3 px) NO mueve ni crea comando; solo selecciona", async () => {
    const { canvas, api, selection } = await renderCanvas();
    pointerDown(canvas, 10, 10);
    pointerMove(canvas, 11, 11);
    pointerUp(canvas, 11, 11);
    expect(api().undoDepth).toBe(0);
    expect(boundsOf(api(), "A", "a1")).toEqual({ x: 0, y: 0, width: 40, height: 40 });
    expect(selection()).toEqual(["a1"]);
  });

  it("zoom alto (4×): 40 px de pantalla = 10 unidades de documento", async () => {
    const zoomed: CanvasTransform = { scale: 4, panX: 0, panY: 0 };
    const { canvas, api } = await renderCanvas({ transform: zoomed });
    const screenOf = (x: number, y: number) => ({ clientX: (x - 160) * 4 + 400, clientY: (y - 120) * 4 + 300 });
    fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, ...screenOf(10, 10) });
    fireEvent.pointerMove(canvas, { pointerId: 1, ...screenOf(10, 10), clientX: screenOf(10, 10).clientX + 40 });
    fireEvent.pointerUp(canvas, { pointerId: 1, ...screenOf(10, 10), clientX: screenOf(10, 10).clientX + 40 });
    expect(boundsOf(api(), "A", "a1")).toEqual({ x: 10, y: 0, width: 40, height: 40 });
  });

  it("zoom bajo (0.5×): 20 px de pantalla = 40 unidades de documento", async () => {
    const zoomed: CanvasTransform = { scale: 0.5, panX: 0, panY: 0 };
    const { canvas, api } = await renderCanvas({ transform: zoomed });
    const screenOf = (x: number, y: number) => ({ clientX: (x - 160) * 0.5 + 400, clientY: (y - 120) * 0.5 + 300 });
    fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, ...screenOf(10, 10) });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: screenOf(10, 10).clientX + 20, clientY: screenOf(10, 10).clientY });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: screenOf(10, 10).clientX + 20, clientY: screenOf(10, 10).clientY });
    expect(boundsOf(api(), "A", "a1")).toEqual({ x: 40, y: 0, width: 40, height: 40 });
  });

  it("arrastrar un objeto NO seleccionado lo selecciona y mueve solo a ese; arrastrar uno seleccionado mueve TODA la selección", async () => {
    const { canvas, api } = await renderCanvas();
    click(canvas, 10, 10); // a1
    click(canvas, 120, 120, { shiftKey: true }); // + b1
    drag(canvas, [120, 120], [130, 120]);
    expect(boundsOf(api(), "A", "a1")!.x).toBe(10);
    expect(boundsOf(api(), "B", "b1")!.x).toBe(110);
    expect(api().undoDepth).toBe(1); // dos objetos de dos capas, UN comando

    act(() => void api().undo());
    expect(boundsOf(api(), "A", "a1")!.x).toBe(0);
    expect(boundsOf(api(), "B", "b1")!.x).toBe(100);

    // Objeto no seleccionado (a2) mientras a1+b1 están seleccionados -> se reemplaza la selección y solo se mueve a2.
    drag(canvas, [50, 50], [55, 50]);
    expect(boundsOf(api(), "A", "a2")!.x).toBe(25);
    expect(boundsOf(api(), "A", "a1")!.x).toBe(0);
  });

  it("click simple sobre un objeto de una multi-selección reduce la selección a ese objeto", async () => {
    const { canvas, selection } = await renderCanvas();
    fireEvent.keyDown(canvas, { key: "a", ctrlKey: true });
    expect(selection()).toHaveLength(3);
    click(canvas, 120, 120);
    expect(selection()).toEqual(["b1"]);
  });

  it("Escape durante el drag lo cancela: nada se mueve y no queda comando", async () => {
    const { canvas, api } = await renderCanvas();
    pointerDown(canvas, 10, 10);
    pointerMove(canvas, 40, 40);
    expect(api().gestureActive).toBe(true);
    fireEvent.keyDown(canvas, { key: "Escape" });
    pointerUp(canvas, 40, 40);
    expect(api().gestureActive).toBe(false);
    expect(api().undoDepth).toBe(0);
    expect(boundsOf(api(), "A", "a1")).toEqual({ x: 0, y: 0, width: 40, height: 40 });
  });

  it("pointercancel cancela el drag sin dejar comando", async () => {
    const { canvas, api } = await renderCanvas();
    pointerDown(canvas, 10, 10);
    pointerMove(canvas, 40, 40);
    fireEvent.pointerCancel(canvas, { pointerId: 1 });
    expect(api().undoDepth).toBe(0);
    expect(boundsOf(api(), "A", "a1")).toEqual({ x: 0, y: 0, width: 40, height: 40 });
  });

  it("flechas mueven la selección 1 unidad de documento; Shift+flecha, 10 -- sin depender del zoom", async () => {
    const zoomed: CanvasTransform = { scale: 4, panX: 0, panY: 0 };
    const { canvas, api } = await renderCanvas({ transform: zoomed, initialSelection: ["a1"] });
    fireEvent.keyDown(canvas, { key: "ArrowRight" });
    expect(boundsOf(api(), "A", "a1")).toEqual({ x: 1, y: 0, width: 40, height: 40 });
    fireEvent.keyDown(canvas, { key: "ArrowDown", shiftKey: true });
    expect(boundsOf(api(), "A", "a1")).toEqual({ x: 1, y: 10, width: 40, height: 40 });
    fireEvent.keyDown(canvas, { key: "ArrowLeft" });
    fireEvent.keyDown(canvas, { key: "ArrowUp", shiftKey: true });
    expect(boundsOf(api(), "A", "a1")).toEqual({ x: 0, y: 0, width: 40, height: 40 });
  });

  it("con selección las flechas NO desplazan la vista", async () => {
    const { canvas, onPanBy } = await renderCanvas({ initialSelection: ["a1"] });
    fireEvent.keyDown(canvas, { key: "ArrowRight" });
    expect(onPanBy).not.toHaveBeenCalled();
  });

  it("una ráfaga de flechas sobre la misma selección es UN solo comando de undo", async () => {
    const { canvas, api } = await renderCanvas({ initialSelection: ["a1"] });
    for (let press = 0; press < 6; press += 1) fireEvent.keyDown(canvas, { key: "ArrowRight" });
    expect(boundsOf(api(), "A", "a1")!.x).toBe(6);
    expect(api().undoDepth).toBe(1);
    act(() => void api().undo());
    expect(boundsOf(api(), "A", "a1")!.x).toBe(0);
  });

  it("Delete y Backspace eliminan la selección (un comando); undo la restaura", async () => {
    const { canvas, api, selection } = await renderCanvas({ initialSelection: ["a1", "b1"] });
    fireEvent.keyDown(canvas, { key: "Delete" });
    expect(api().objectsByLayer.A.map((o) => o.id)).toEqual(["a2"]);
    expect(api().objectsByLayer.B).toEqual([]);
    expect(api().undoDepth).toBe(1);
    expect(api().undoLabel).toBe("Eliminar 2 objetos");
    expect(selection()).toEqual([]);

    act(() => void api().undo());
    expect(api().objectsByLayer.A.map((o) => o.id)).toEqual(["a1", "a2"]);
    expect(api().objectsByLayer.B.map((o) => o.id)).toEqual(["b1"]);

    fireEvent.keyDown(canvas, { key: "Backspace" });
    expect(api().undoDepth).toBe(1);
  });

  it("la herramienta Move arrastra igual, pero SIN Transformer y sin marquee", async () => {
    const { canvas, api, selection } = await renderCanvas({ tool: "move" });
    click(canvas, 10, 10);
    expect(selection()).toEqual(["a1"]);
    expect(transformer().visible()).toBe(false);
    expect(transformer().nodes()).toHaveLength(0);

    drag(canvas, [10, 10], [20, 10]);
    expect(boundsOf(api(), "A", "a1")!.x).toBe(10);

    // Arrastrar el fondo no dibuja un marquee ni selecciona nada.
    drag(canvas, [-10, -10], [80, 80]);
    expect(stage().find(".marquee")).toHaveLength(0);
    expect(selection()).toEqual(["a1"]);
  });
});

describe("VectorCanvas — locks", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ImmediateResizeObserver);
    installFetch();
  });
  afterEach(() => vi.unstubAllGlobals());

  const LOCKED_A = layer({ locked: true });

  it("un objeto de capa bloqueada SE SELECCIONA (para inspeccionar) y muestra la insignia de candado", async () => {
    const { canvas, selection } = await renderCanvas({ layers: [LOCKED_A, LAYER_B] });
    click(canvas, 10, 10);
    expect(selection()).toEqual(["a1"]);
    expect(await screen.findByText(/1 objeto bloqueado/)).toBeInTheDocument();
  });

  it("arrastrar un objeto bloqueado NO lo mueve, no deja comandos y avisa con un mensaje visible", async () => {
    const { canvas, api } = await renderCanvas({ layers: [LOCKED_A, LAYER_B] });
    drag(canvas, [10, 10], [40, 40]);
    expect(boundsOf(api(), "A", "a1")).toEqual({ x: 0, y: 0, width: 40, height: 40 });
    expect(api().undoDepth).toBe(0);
    expect(await screen.findByRole("alert")).toHaveTextContent(/bloqueada/);
  });

  it("las flechas y Delete sobre un objeto bloqueado tampoco lo modifican y avisan", async () => {
    const { canvas, api } = await renderCanvas({ layers: [LOCKED_A, LAYER_B], initialSelection: ["a1"] });
    fireEvent.keyDown(canvas, { key: "ArrowRight" });
    expect(boundsOf(api(), "A", "a1")!.x).toBe(0);
    expect(await screen.findByRole("alert")).toHaveTextContent(/bloqueada/);
    fireEvent.keyDown(canvas, { key: "Delete" });
    expect(api().objectsByLayer.A).toHaveLength(2);
    expect(api().undoDepth).toBe(0);
  });

  it("selección mixta (bloqueado + libre): se mueve solo el libre y se informa cuántos se omitieron", async () => {
    const { canvas, api } = await renderCanvas({ layers: [LOCKED_A, LAYER_B], initialSelection: ["a1", "b1"] });
    drag(canvas, [120, 120], [130, 120]);
    expect(boundsOf(api(), "A", "a1")!.x).toBe(0);
    expect(boundsOf(api(), "B", "b1")!.x).toBe(110);
    expect(api().undoDepth).toBe(1);
    expect(await screen.findByRole("alert")).toHaveTextContent(/1 objeto está en capas bloqueadas/);
  });

  it("los objetos bloqueados no reciben el Transformer; los libres sí", async () => {
    const { canvas } = await renderCanvas({ layers: [LOCKED_A, LAYER_B] });
    click(canvas, 10, 10);
    expect(transformer().nodes()).toHaveLength(0);
    click(canvas, 120, 120);
    await waitFor(() => expect(transformer().nodes()).toHaveLength(1));
  });

  it("bloquear la capa DESPUÉS de seleccionar también impide mover (el lock se lee al editar)", async () => {
    const { canvas, api, rerender } = await renderCanvas();
    click(canvas, 10, 10);
    rerender({ layers: [LOCKED_A, LAYER_B] });
    drag(canvas, [10, 10], [40, 40]);
    expect(api().undoDepth).toBe(0);
  });
});

describe("VectorCanvas — Transformer (scale / rotate)", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ImmediateResizeObserver);
    installFetch();
  });
  afterEach(() => vi.unstubAllGlobals());

  /** Simula lo que hace el Transformer de Konva al soltar un handle: muta el nodo y dispara transformstart/transformend. */
  function simulateTransform(node: Konva.Node, mutate: (node: Konva.Node) => void, anchor: string | null = "bottom-right") {
    const tr = transformer();
    (tr as unknown as { _movingAnchorName: string | null })._movingAnchorName = anchor;
    act(() => {
      tr.fire("transformstart");
      mutate(node);
      tr.fire("transformend");
    });
  }

  it("el Transformer se engancha a los nodos de la selección editable, con rotación, proporción por defecto y Shift que la invierte", async () => {
    const { canvas } = await renderCanvas();
    click(canvas, 10, 10);
    await waitFor(() => expect(transformer().nodes()).toHaveLength(1));
    expect(transformer().nodes()[0]).toBe(documentPaths()[0]);
    expect(transformer().rotateEnabled()).toBe(true);
    expect(transformer().keepRatio()).toBe(true);
    expect(transformer().shiftBehavior()).toBe("inverted");
    expect(transformer().flipEnabled()).toBe(false);
    expect(transformer().visible()).toBe(true);
  });

  it("el Transformer dibuja su caja en coordenadas de PANTALLA con zoom (2×): handles de tamaño constante, caja = bbox del objeto escalado", async () => {
    const zoomed: CanvasTransform = { scale: 2, panX: 10, panY: -20 };
    const { canvas } = await renderCanvas({ transform: zoomed, initialSelection: ["a1"] });
    await waitFor(() => expect(transformer().nodes()).toHaveLength(1));
    // a1 = (0,0) 40×40 en documento. Pantalla: x = (0-160)*2 + 400 + 10 = 90 ; y = (0-120)*2 + 300 - 20 = 40 ; lado 80.
    expect(transformer().x()).toBeCloseTo(90, 6);
    expect(transformer().y()).toBeCloseTo(40, 6);
    expect(transformer().width()).toBeCloseTo(80, 6);
    expect(transformer().height()).toBeCloseTo(80, 6);
    expect(transformer().getAbsoluteScale().x).toBeCloseTo(1, 9);
    expect(canvas).toBeInTheDocument();
  });

  it("multi-selección: un solo Transformer sobre todos los nodos (bbox de grupo)", async () => {
    const { canvas } = await renderCanvas();
    fireEvent.keyDown(canvas, { key: "a", ctrlKey: true });
    await waitFor(() => expect(transformer().nodes()).toHaveLength(3));
  });

  it("sin selección el Transformer no tiene nodos y está oculto", async () => {
    await renderCanvas();
    expect(transformer().nodes()).toHaveLength(0);
    expect(transformer().visible()).toBe(false);
  });

  it("Shift sostenido activa los pasos de 15° de la rotación; al soltarlo, rotación libre", async () => {
    const { canvas } = await renderCanvas();
    click(canvas, 10, 10);
    expect(transformer().rotationSnaps()).toEqual([]);
    act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift" })));
    await waitFor(() => expect(transformer().rotationSnaps()).toContain(15));
    expect(transformer().rotationSnaps()).toHaveLength(24);
    act(() => void window.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift" })));
    await waitFor(() => expect(transformer().rotationSnaps()).toEqual([]));
  });

  it("escalar: UN comando 'Escalar', la matriz se compone (d NO se toca) y el bbox escala exacto", async () => {
    const { canvas, api } = await renderCanvas();
    click(canvas, 10, 10);
    await waitFor(() => expect(transformer().nodes()).toHaveLength(1));
    const node = documentPaths()[0];
    const originalD = api().objectsByLayer.A[0].d;

    // a1 mide 40×40 en (0,0). El Transformer lo escala 2× alrededor de su esquina superior izquierda.
    simulateTransform(node, (target) => {
      target.scaleX(2);
      target.scaleY(2);
    });

    expect(api().undoDepth).toBe(1);
    expect(api().undoLabel).toBe("Escalar 1 objeto");
    expect(api().objectsByLayer.A[0].d).toBe(originalD);
    expect(boundsOf(api(), "A", "a1")).toEqual({ x: 0, y: 0, width: 80, height: 80 });
    expect(api().objectsByLayer.A[0].matrix).toMatchObject({ a: 2, d: 2 });

    act(() => void api().undo());
    expect(boundsOf(api(), "A", "a1")).toEqual({ x: 0, y: 0, width: 40, height: 40 });
  });

  it("escalar sobre un objeto YA transformado compone con su matriz previa (no la pisa)", async () => {
    const { canvas, api } = await renderCanvas({ initialSelection: ["a1"] });
    fireEvent.keyDown(canvas, { key: "ArrowRight", shiftKey: true }); // a1 -> x:10
    await waitFor(() => expect(transformer().nodes()).toHaveLength(1));
    simulateTransform(documentPaths()[0], (target) => {
      target.scaleX(target.scaleX() * 0.5);
      target.scaleY(target.scaleY() * 0.5);
    });
    // Escala 0.5 alrededor del origen del nodo (que está en x=10): el bbox queda 20×20 en (10, 0).
    expect(boundsOf(api(), "A", "a1")).toEqual({ x: 10, y: 0, width: 20, height: 20 });
    expect(api().undoDepth).toBe(2);
  });

  it("rotar con el handle de rotación: comando 'Rotar' y la rotación de la matriz refleja el ángulo", async () => {
    const { canvas, api } = await renderCanvas();
    click(canvas, 10, 10);
    await waitFor(() => expect(transformer().nodes()).toHaveLength(1));
    simulateTransform(documentPaths()[0], (target) => target.rotation(90), "rotater");
    expect(api().undoLabel).toBe("Rotar 1 objeto");
    expect(matrixRotationDegrees(api().objectsByLayer.A[0].matrix)).toBeCloseTo(90, 6);
    expect(api().undoDepth).toBe(1);
  });

  it("multi-selección: el gesto del Transformer escala TODOS los objetos en UN comando", async () => {
    const { canvas, api } = await renderCanvas();
    fireEvent.keyDown(canvas, { key: "a", ctrlKey: true });
    await waitFor(() => expect(transformer().nodes()).toHaveLength(3));
    act(() => {
      (transformer() as unknown as { _movingAnchorName: string })._movingAnchorName = "bottom-right";
      transformer().fire("transformstart");
      for (const node of documentPaths()) node.scaleX(node.scaleX() * 2);
      transformer().fire("transformend");
    });
    expect(api().undoDepth).toBe(1);
    expect(api().undoLabel).toBe("Escalar 3 objetos");
    // Cada nodo escala 2× alrededor de SU origen (x=0): b1 pasa de x:100 a x:200.
    expect(boundsOf(api(), "B", "b1")).toEqual({ x: 200, y: 100, width: 80, height: 40 });
  });

  it("un gesto del Transformer sin cambio neto no genera comando", async () => {
    const { canvas, api } = await renderCanvas();
    click(canvas, 10, 10);
    await waitFor(() => expect(transformer().nodes()).toHaveLength(1));
    simulateTransform(documentPaths()[0], () => {});
    expect(api().undoDepth).toBe(0);
  });

  it("si la edición se rechaza (capa bloqueada en pleno gesto) el nodo vuelve EXACTO a su estado confirmado", async () => {
    const { canvas, api, rerender } = await renderCanvas();
    click(canvas, 10, 10);
    await waitFor(() => expect(transformer().nodes()).toHaveLength(1));
    const node = documentPaths()[0];
    const tr = transformer();
    (tr as unknown as { _movingAnchorName: string })._movingAnchorName = "bottom-right";
    act(() => {
      tr.fire("transformstart");
      node.scaleX(3);
      rerender({ layers: [layer({ locked: true }), LAYER_B] }); // se bloquea la capa mientras se arrastra el handle
    });
    act(() => void tr.fire("transformend"));
    expect(api().undoDepth).toBe(0);
    expect(node.scaleX()).toBe(1);
  });
});
