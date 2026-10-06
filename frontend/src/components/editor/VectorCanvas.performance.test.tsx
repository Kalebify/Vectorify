import Konva from "konva";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useMemo, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDENTITY_TRANSFORM } from "../../hooks/useCanvasTransform";
import { useEditableDocument, type EditableDocumentApi } from "../../hooks/useEditableDocument";
import type { VectorDocumentLayer } from "../../hooks/useVectorDocument";
import * as matrixModule from "../../lib/editor/matrix";
import { resolveSelection, selectableObjects as selectableObjectsOf } from "../../lib/editor/selection";
import { abortAwareFetch, svgResponse } from "../../test/abortableFetch";
import { VectorCanvas } from "./VectorCanvas";

// Cuenta cuántas veces se calculan los props de Konva de un objeto: es lo que hace CADA <Path> al renderizar,
// así que equivale a "cuántos objetos se re-renderizaron".
vi.mock("../../lib/editor/matrix", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/editor/matrix")>();
  return { ...actual, matrixToKonvaProps: vi.fn(actual.matrixToKonvaProps) };
});

const COUNT = 5000;
const COLUMNS = 100;

const LAYER: VectorDocumentLayer = {
  groupId: "A",
  name: "Gris",
  colorHex: "#888888",
  fill: "#888888",
  vectorId: "vector-a",
  svgUrl: "/svg/A",
  pathCount: COUNT,
  componentCount: null,
  manufacturingOperation: "cut",
  order: 0,
  visible: true,
  locked: false,
  areaPercent: 100,
  hasPartialAlpha: false,
  isExcluded: false,
};

function bigSvg(): string {
  const paths: string[] = [];
  for (let index = 0; index < COUNT; index += 1) {
    paths.push(`<path data-vid="p${index}" d="M0 0 H8 V8 H0 Z" fill="#888888" transform="translate(${(index % COLUMNS) * 12},${Math.floor(index / COLUMNS) * 12})"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600">${paths.join("")}</svg>`;
}

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

function Harness({ onApi }: { onApi: (api: EditableDocumentApi) => void }) {
  const layers = useMemo(() => [LAYER], []);
  const editable = useEditableDocument(layers);
  const [raw, setRaw] = useState<ReadonlySet<string>>(new Set());
  const pool = useMemo(() => selectableObjectsOf(editable.objectsByLayer, layers, {}), [editable.objectsByLayer, layers]);
  const selected = useMemo(() => new Set(resolveSelection(pool, raw).map((object) => object.id)), [pool, raw]);
  onApi(editable);
  return (
    <VectorCanvas
      layers={layers}
      visibility={{}}
      sourceWidthPx={1200}
      sourceHeightPx={600}
      selectedGroupId={null}
      editable={editable}
      selectableObjects={pool}
      selectedObjectIds={selected}
      onSelectObjects={(ids) => setRaw(new Set(ids))}
      tool="select"
      transform={IDENTITY_TRANSFORM}
      onZoomBy={vi.fn()}
      onPanBy={vi.fn()}
      onMeasure={vi.fn()}
    />
  );
}

describe("VectorCanvas — documento de 5 000 paths (humo de rendimiento)", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ImmediateResizeObserver);
    vi.stubGlobal("fetch", abortAwareFetch(() => svgResponse(bigSvg())));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("seleccionar y arrastrar un objeto NO re-renderiza el resto del documento (memoización por objeto) y termina en tiempo razonable", async () => {
    let api!: EditableDocumentApi;
    render(<Harness onApi={(next) => (api = next)} />);
    const canvas = await screen.findByRole("application");
    await waitFor(() => expect(api.layerStatus.A).toBe("ready"), { timeout: 20000 });
    await waitFor(() => expect(Konva.stages[Konva.stages.length - 1].getLayers()[0].find("Path")).toHaveLength(COUNT), { timeout: 20000 });

    const spy = vi.mocked(matrixModule.matrixToKonvaProps);
    const callsAfterLoad = spy.mock.calls.length;
    expect(callsAfterLoad).toBeGreaterThanOrEqual(COUNT);

    // Pantalla = documento + (400-600, 300-300) = documento + (-200, 0) con contenedor 800×600 y documento 1200×600.
    const screenOf = (x: number, y: number) => ({ clientX: x - 600 + 400, clientY: y });
    const startedAt = performance.now();

    // Click en el objeto 2525 (columna 25, fila 25 -> origen (300, 300)): selecciona SOLO ese.
    fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, ...screenOf(304, 304) });
    fireEvent.pointerUp(canvas, { pointerId: 1, ...screenOf(304, 304) });
    // Drag de 6 frames.
    fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, ...screenOf(304, 304) });
    for (let frame = 1; frame <= 6; frame += 1) fireEvent.pointerMove(canvas, { pointerId: 1, ...screenOf(304 + frame * 5, 304) });
    fireEvent.pointerUp(canvas, { pointerId: 1, ...screenOf(334, 304) });

    const elapsed = performance.now() - startedAt;
    const recomputed = spy.mock.calls.length - callsAfterLoad;

    expect(api.undoDepth).toBe(1);
    const moved = api.objectsByLayer.A.find((object) => object.id === "p2525")!;
    expect(moved.matrix.e).toBe(300 + 30);
    // Un click + un drag de 6 frames re-renderizan unas pocas decenas de nodos como mucho (el objeto y su contorno por
    // frame), JAMÁS los 5 000: ese es el contrato de "sin re-renderizar todas las capas por frame".
    expect(recomputed).toBeLessThan(150);
    // Tope holgado (sin umbral frágil): detecta bloqueos de la UI, no micro-variaciones.
    expect(elapsed).toBeLessThan(15000);
  }, 60000);
});
