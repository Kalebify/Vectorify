import Konva from "konva";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useMemo, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDENTITY_TRANSFORM } from "../../hooks/useCanvasTransform";
import { useEditableDocument, type EditableDocumentApi } from "../../hooks/useEditableDocument";
import type { VectorDocumentLayer } from "../../hooks/useVectorDocument";
import { resolveSelection, selectableObjects as selectableObjectsOf } from "../../lib/editor/selection";
import type { DocumentFrame } from "../../lib/editor/types";
import type { OrientationStep } from "../../lib/editor/orientation";
import { abortAwareFetch, svgResponse } from "../../test/abortableFetch";
import type { EditorTool } from "./EditorToolbar";
import { VectorCanvas } from "./VectorCanvas";

/**
 * M3-S02 en el canvas: área de trabajo (`frame`) como centro y hoja del documento, overlay de Crop (marco arrastrable +
 * exterior atenuado), edición suspendida durante una transformación pendiente y atajos de Rotate/Flip.
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

const SVG_A = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><path data-vid="a1" d="M0 0 H40 V40 H0 Z" fill="#ff0000"/><path data-vid="a2" d="M20 20 H60 V60 H20 Z" fill="#ff0000"/></svg>`;
const SVG_B = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><path data-vid="b1" d="M100 100 H140 V140 H100 Z" fill="#0000ff"/></svg>`;
const LAYERS = [layer(), layer({ groupId: "B", vectorId: "vector-b", svgUrl: "/svg/B", colorHex: "#0000ff", order: 1, name: "Azul" })];

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

interface HarnessProps {
  tool?: EditorTool;
  frame?: DocumentFrame;
  editingSuspended?: boolean;
  cropFrame?: DocumentFrame | null;
  cropKeepRatio?: boolean;
  initialSelection?: string[];
  onApi: (api: EditableDocumentApi) => void;
  onSelection: (ids: string[]) => void;
  onCropFrameChange?: (frame: DocumentFrame) => void;
  onOrientationShortcut?: (step: OrientationStep) => void;
  onPanBy?: (dx: number, dy: number) => void;
}

function Harness({ tool = "select", frame, editingSuspended, cropFrame, cropKeepRatio, initialSelection = [], onApi, onSelection, onCropFrameChange, onOrientationShortcut, onPanBy }: HarnessProps) {
  const editable = useEditableDocument(LAYERS, {});
  const [raw, setRaw] = useState<ReadonlySet<string>>(new Set(initialSelection));
  const pool = useMemo(() => selectableObjectsOf(editable.objectsByLayer, LAYERS, {}), [editable.objectsByLayer]);
  const selected = useMemo(() => new Set(resolveSelection(pool, raw).map((object) => object.id)), [pool, raw]);
  onApi(editable);
  onSelection([...selected]);

  return (
    <VectorCanvas
      layers={LAYERS}
      visibility={{}}
      sourceWidthPx={320}
      sourceHeightPx={240}
      frame={frame}
      selectedGroupId={null}
      editable={editable}
      selectableObjects={pool}
      selectedObjectIds={selected}
      onSelectObjects={(ids) => setRaw(new Set(ids))}
      tool={tool}
      transform={IDENTITY_TRANSFORM}
      onZoomBy={vi.fn()}
      onPanBy={onPanBy ?? vi.fn()}
      onMeasure={vi.fn()}
      editingSuspended={editingSuspended}
      cropFrame={cropFrame}
      cropKeepRatio={cropKeepRatio}
      onCropFrameChange={onCropFrameChange}
      onOrientationShortcut={onOrientationShortcut}
    />
  );
}

async function renderCanvas(props: Partial<HarnessProps> = {}) {
  let latestApi!: EditableDocumentApi;
  let latestSelection: string[] = [];
  const base: HarnessProps = { onApi: (api) => (latestApi = api), onSelection: (ids) => (latestSelection = ids), ...props };
  const utils = render(<Harness {...base} />);
  const canvas = await screen.findByRole("application");
  await waitFor(() => expect(Object.values(latestApi.layerStatus).length > 0 && Object.values(latestApi.layerStatus).every((status) => status === "ready")).toBe(true));
  await waitFor(() => expect(Konva.stages[Konva.stages.length - 1]?.find("Path").length).toBeGreaterThan(0));
  return {
    canvas,
    api: () => latestApi,
    selection: () => latestSelection,
    rerender: (next: Partial<HarnessProps>) => utils.rerender(<Harness {...base} {...next} />),
  };
}

const stage = () => Konva.stages[Konva.stages.length - 1];
const named = (name: string) => stage().find(`.${name}`) as Konva.Node[];

function installFetch() {
  vi.stubGlobal(
    "fetch",
    abortAwareFetch((url) => (url === "/svg/A" ? svgResponse(SVG_A) : url === "/svg/B" ? svgResponse(SVG_B) : svgResponse("", 404))),
  );
}

describe("VectorCanvas — área de trabajo (frame, M3-S02)", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ImmediateResizeObserver);
    installFetch();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sin `frame` (S01) el documento se centra por su viewBox: offset = mitad del tamaño", async () => {
    await renderCanvas();
    const layerNode = stage().getLayers()[0];
    expect(layerNode.offsetX()).toBe(160);
    expect(layerNode.offsetY()).toBe(120);
  });

  it("con `frame` el documento se centra por el CENTRO del marco (origen distinto de 0): offset = x + ancho/2", async () => {
    await renderCanvas({ frame: { x: 50, y: -50, width: 100, height: 200 } });
    const layerNode = stage().getLayers()[0];
    expect(layerNode.offsetX()).toBe(100);
    expect(layerNode.offsetY()).toBe(50);
    expect(layerNode.x()).toBe(400); // centro del contenedor 800×600
    expect(layerNode.y()).toBe(300);
  });

  it("dibuja el borde del área de trabajo (la 'hoja') y lo actualiza cuando cambia el marco", async () => {
    const { rerender } = await renderCanvas({ frame: { x: 0, y: 0, width: 320, height: 240 } });
    const outline = () => named("document-frame")[0] as Konva.Rect;
    expect([outline().x(), outline().y(), outline().width(), outline().height()]).toEqual([0, 0, 320, 240]);
    rerender({ frame: { x: 50, y: -50, width: 100, height: 200 } });
    await waitFor(() => expect([outline().x(), outline().y(), outline().width(), outline().height()]).toEqual([50, -50, 100, 200]));
  });

  it("el hit-testing usa el origen del marco: el click en el centro del contenedor + (10,10) cae en el documento (110,110) y selecciona b1", async () => {
    const { canvas, selection } = await renderCanvas({ frame: { x: 50, y: 50, width: 100, height: 100 } }); // centro (100,100)
    fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, clientX: 410, clientY: 310 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 410, clientY: 310 });
    expect(selection()).toEqual(["b1"]);
  });
});

describe("VectorCanvas — overlay de Crop", () => {
  const CROP: DocumentFrame = { x: 20, y: 30, width: 40, height: 50 };

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ImmediateResizeObserver);
    installFetch();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("con la herramienta Crop dibuja el marco propuesto, el exterior atenuado (4 franjas) y un Transformer enganchado al marco", async () => {
    await renderCanvas({ tool: "crop", cropFrame: CROP, onCropFrameChange: vi.fn() });
    const cropRect = named("crop-frame")[0] as Konva.Rect;
    expect([cropRect.x(), cropRect.y(), cropRect.width(), cropRect.height()]).toEqual([20, 30, 40, 50]);
    expect(cropRect.draggable()).toBe(true);
    expect(named("crop-dim")).toHaveLength(4);
    await waitFor(() => {
      const transformers = stage().find("Transformer") as Konva.Transformer[];
      expect(transformers.some((transformer) => transformer.nodes().includes(cropRect))).toBe(true);
    });
    const cropTransformer = (stage().find("Transformer") as Konva.Transformer[]).find((transformer) => transformer.nodes().includes(cropRect))!;
    expect(cropTransformer.rotateEnabled()).toBe(false);
    expect(cropTransformer.flipEnabled()).toBe(false);
  });

  it("el exterior atenuado cubre todo salvo el hueco del marco (área total de las 4 franjas = área exterior - hueco)", async () => {
    await renderCanvas({ tool: "crop", cropFrame: CROP, onCropFrameChange: vi.fn() });
    const rects = named("crop-dim") as Konva.Rect[];
    const holeArea = CROP.width * CROP.height;
    const union = { x: -320, y: -320, width: 320 + 320 + 320, height: 240 + 640 }; // marco 320×240 + margen = max(ancho, alto) = 320 por lado
    const covered = rects.reduce((sum, rect) => sum + rect.width() * rect.height(), 0);
    expect(covered).toBe(union.width * union.height - holeArea);
    // Ninguna franja pisa el hueco.
    for (const rect of rects) {
      const overlapX = Math.min(rect.x() + rect.width(), CROP.x + CROP.width) - Math.max(rect.x(), CROP.x);
      const overlapY = Math.min(rect.y() + rect.height(), CROP.y + CROP.height) - Math.max(rect.y(), CROP.y);
      expect(overlapX > 0 && overlapY > 0).toBe(false);
    }
  });

  it("sin la herramienta Crop (o sin marco propuesto) no hay overlay ni segundo Transformer", async () => {
    const { rerender } = await renderCanvas({ tool: "select", cropFrame: CROP, onCropFrameChange: vi.fn() });
    expect(named("crop-frame")).toHaveLength(0);
    expect(stage().find("Transformer")).toHaveLength(1);
    rerender({ tool: "crop", cropFrame: null, onCropFrameChange: vi.fn() });
    await waitFor(() => expect(named("crop-frame")).toHaveLength(0));
  });

  it("arrastrar el marco (dragmove) propone el marco nuevo con el mismo tamaño", async () => {
    const onCropFrameChange = vi.fn();
    await renderCanvas({ tool: "crop", cropFrame: CROP, onCropFrameChange });
    const cropRect = named("crop-frame")[0] as Konva.Rect;
    cropRect.x(70);
    cropRect.y(80);
    cropRect.fire("dragmove");
    expect(onCropFrameChange).toHaveBeenLastCalledWith({ x: 70, y: 80, width: 40, height: 50 });
  });

  it("redimensionar con un handle (transform) convierte la ESCALA de Konva en ancho/alto reales y deja el nodo en escala 1", async () => {
    const onCropFrameChange = vi.fn();
    await renderCanvas({ tool: "crop", cropFrame: CROP, onCropFrameChange });
    const cropRect = named("crop-frame")[0] as Konva.Rect;
    cropRect.scaleX(2);
    cropRect.scaleY(1.5);
    cropRect.fire("transform");
    expect(onCropFrameChange).toHaveBeenLastCalledWith({ x: 20, y: 30, width: 80, height: 75 });
    expect(cropRect.scaleX()).toBe(1);
    expect(cropRect.scaleY()).toBe(1);
    expect(cropRect.width()).toBe(80);
    expect(cropRect.height()).toBe(75);
    cropRect.fire("transformend");
    expect(onCropFrameChange).toHaveBeenLastCalledWith({ x: 20, y: 30, width: 80, height: 75 });
  });

  it("el bloqueo de proporción llega al Transformer del marco (keepRatio)", async () => {
    await renderCanvas({ tool: "crop", cropFrame: CROP, onCropFrameChange: vi.fn(), cropKeepRatio: true });
    await waitFor(() => {
      const transformers = stage().find("Transformer") as Konva.Transformer[];
      expect(transformers.some((transformer) => transformer.keepRatio())).toBe(true);
    });
  });

  it("las flechas mueven el marco 1 unidad (Shift: 10) y NO tocan los objetos ni la vista", async () => {
    const onCropFrameChange = vi.fn();
    const onPanBy = vi.fn();
    const { canvas, api } = await renderCanvas({ tool: "crop", cropFrame: CROP, onCropFrameChange, onPanBy });
    fireEvent.keyDown(canvas, { key: "ArrowRight" });
    expect(onCropFrameChange).toHaveBeenLastCalledWith({ x: 21, y: 30, width: 40, height: 50 });
    fireEvent.keyDown(canvas, { key: "ArrowUp", shiftKey: true });
    expect(onCropFrameChange).toHaveBeenLastCalledWith({ x: 20, y: 20, width: 40, height: 50 });
    fireEvent.keyDown(canvas, { key: "ArrowLeft" });
    expect(onCropFrameChange).toHaveBeenLastCalledWith({ x: 19, y: 30, width: 40, height: 50 });
    fireEvent.keyDown(canvas, { key: "ArrowDown" });
    expect(onCropFrameChange).toHaveBeenLastCalledWith({ x: 20, y: 31, width: 40, height: 50 });
    expect(onPanBy).not.toHaveBeenCalled();
    expect(api().undoDepth).toBe(0);
  });

  it("durante Crop las herramientas de edición de objetos quedan suspendidas: click, arrastre, Suprimir, Ctrl+A y Escape no tocan la selección ni los objetos", async () => {
    const { canvas, api, selection } = await renderCanvas({ tool: "crop", cropFrame: CROP, onCropFrameChange: vi.fn(), initialSelection: ["a1"] });
    expect(selection()).toEqual(["a1"]);

    fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, clientX: 240 + 120, clientY: 180 + 120 }); // sobre b1
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 240 + 160, clientY: 180 + 120 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 240 + 160, clientY: 180 + 120 });
    expect(selection()).toEqual(["a1"]);
    fireEvent.keyDown(canvas, { key: "Delete" });
    fireEvent.keyDown(canvas, { key: "a", ctrlKey: true });
    fireEvent.keyDown(canvas, { key: "Escape" }); // Escape = Cancel del recorte: lo resuelve el shell, no limpia la selección
    expect(selection()).toEqual(["a1"]);
    expect(api().undoDepth).toBe(0);
    expect(api().objectsByLayer.A).toHaveLength(2);
  });

  it("el aria-label del canvas nombra la herramienta Crop y documenta los atajos de Rotate/Flip", async () => {
    const { canvas } = await renderCanvas({ tool: "crop", cropFrame: CROP, onCropFrameChange: vi.fn() });
    expect(canvas).toHaveAttribute("aria-label", expect.stringContaining("Herramienta activa: Crop"));
    expect(canvas).toHaveAttribute("aria-label", expect.stringContaining("R y Mayúscula+R giran 90°"));
  });
});

describe("VectorCanvas — transformación pendiente (edición suspendida) y atajos de Rotate/Flip", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ImmediateResizeObserver);
    installFetch();
  });
  afterEach(() => vi.unstubAllGlobals());

  const click = (canvas: HTMLElement, x: number, y: number) => {
    fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, clientX: x + 240, clientY: y + 180 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: x + 240, clientY: y + 180 });
  };

  it("con `editingSuspended` no se selecciona, no se arrastra, no se elimina ni se hace nudge (no se pisa la previsualización)", async () => {
    const onPanBy = vi.fn();
    const { canvas, api, selection } = await renderCanvas({ editingSuspended: true, initialSelection: ["a1"], onPanBy });
    click(canvas, 120, 120); // sobre b1
    expect(selection()).toEqual(["a1"]);

    fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, clientX: 240 + 10, clientY: 180 + 10 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 240 + 50, clientY: 180 + 50 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 240 + 50, clientY: 180 + 50 });
    fireEvent.keyDown(canvas, { key: "Delete" });
    fireEvent.keyDown(canvas, { key: "ArrowRight" });
    fireEvent.keyDown(canvas, { key: "Escape" });
    expect(selection()).toEqual(["a1"]);
    expect(api().undoDepth).toBe(0);
    expect(api().gestureActive).toBe(false); // el canvas NO abrió un gesto que pise el del shell
    expect(api().objectsByLayer.A).toHaveLength(2);
  });

  it("con `editingSuspended` el Transformer de objetos se oculta (sin handles de escala/rotación)", async () => {
    const { rerender } = await renderCanvas({ initialSelection: ["a1"] });
    const transformer = stage().findOne("Transformer") as Konva.Transformer;
    await waitFor(() => expect(transformer.visible()).toBe(true));
    rerender({ initialSelection: ["a1"], editingSuspended: true });
    await waitFor(() => expect(transformer.visible()).toBe(false));
  });

  it("R / Shift+R / F / Shift+F piden girar o reflejar (Select y Move), también con la edición suspendida (componen pasos)", async () => {
    const onOrientationShortcut = vi.fn();
    const { canvas, rerender } = await renderCanvas({ onOrientationShortcut });
    fireEvent.keyDown(canvas, { key: "r" });
    fireEvent.keyDown(canvas, { key: "R", shiftKey: true });
    fireEvent.keyDown(canvas, { key: "f" });
    fireEvent.keyDown(canvas, { key: "F", shiftKey: true });
    expect(onOrientationShortcut.mock.calls.map(([step]) => step)).toEqual(["rotate-cw", "rotate-ccw", "flip-horizontal", "flip-vertical"]);

    rerender({ onOrientationShortcut, tool: "move", editingSuspended: true });
    fireEvent.keyDown(canvas, { key: "r" });
    expect(onOrientationShortcut).toHaveBeenCalledTimes(5);
  });

  it("los atajos NO se disparan con Ctrl/Meta/Alt (Ctrl+R recarga, Ctrl+F busca), ni con Pan o Crop", async () => {
    const onOrientationShortcut = vi.fn();
    const { canvas, rerender } = await renderCanvas({ onOrientationShortcut });
    fireEvent.keyDown(canvas, { key: "r", ctrlKey: true });
    fireEvent.keyDown(canvas, { key: "f", metaKey: true });
    fireEvent.keyDown(canvas, { key: "r", altKey: true });
    rerender({ onOrientationShortcut, tool: "pan" });
    fireEvent.keyDown(canvas, { key: "r" });
    rerender({ onOrientationShortcut, tool: "crop", cropFrame: { x: 0, y: 0, width: 10, height: 10 }, onCropFrameChange: vi.fn() });
    fireEvent.keyDown(canvas, { key: "f" });
    expect(onOrientationShortcut).not.toHaveBeenCalled();
  });

  it("sin callback de atajos, R y F no hacen nada (S01 intacto)", async () => {
    const { canvas, api } = await renderCanvas();
    fireEvent.keyDown(canvas, { key: "r" });
    fireEvent.keyDown(canvas, { key: "f" });
    expect(api().undoDepth).toBe(0);
  });
});
