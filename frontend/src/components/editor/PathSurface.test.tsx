import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pathToModel } from "../../lib/editor/nodes";
import type { EditorObject, Point } from "../../lib/editor/types";
import { documentToScreen, type ViewportParams } from "../../lib/editor/viewport";
import { IDENTITY_MATRIX } from "../../lib/svgTransform";
import { PathSurface, type PathSurfaceProps } from "./PathSurface";

/**
 * PathSurface (M3-S05) aislada: convierte el puntero en coordenadas de documento con el zoom vigente, golpea anchors/handles/segmentos con
 * áreas medidas en PÍXELES de pantalla (constantes a cualquier zoom), avisa con callbacks y dibuja el overlay acotado. Contenedor 800 x 600,
 * documento 320 x 240: pantalla = (documento - (160, 120)) * escala + (400, 300).
 */

const SQUARE_D = "M100 100 L140 100 L140 140 L100 140 Z";
const ZOOMS = [0.5, 1, 2, 4];

function viewportAt(scale: number): ViewportParams {
  return { containerWidth: 800, containerHeight: 600, panX: 0, panY: 0, scale, sourceWidth: 320, sourceHeight: 240 };
}

function objectOf(d: string, id = "o1"): EditorObject {
  return { id, layerGroupId: "A", d, fill: "#ff0000", matrix: IDENTITY_MATRIX };
}

function modelOf(d: string) {
  const result = pathToModel(d);
  if (!result.ok) throw new Error(result.error);
  return result.model;
}

function callbacks() {
  return {
    onSelectNodes: vi.fn(),
    onClearSelection: vi.fn(),
    onBeginDrag: vi.fn(() => true),
    onDragBy: vi.fn(),
    onEndDrag: vi.fn(),
    onCancelDrag: vi.fn(),
    onAddNode: vi.fn(),
    onToggleKind: vi.fn(),
    onPickObject: vi.fn(),
  };
}

function setup(overrides: Partial<PathSurfaceProps> = {}, scale = 1) {
  const spies = callbacks();
  const props = {
    viewport: viewportAt(scale),
    suspended: false,
    pool: [],
    object: objectOf(SQUARE_D),
    model: modelOf(SQUARE_D),
    selection: new Set<string>(),
    ...spies,
    ...overrides,
  } as PathSurfaceProps & typeof spies;
  const utils = render(<PathSurface {...props} />);
  const surface = screen.getByTestId("path-surface");
  const viewport = props.viewport;
  /** Punto de documento -> opciones de evento (px de pantalla), con un desplazamiento opcional en PÍXELES de pantalla. */
  const at = (x: number, y: number, dx = 0, dy = 0) => {
    const screenPoint = documentToScreen({ x, y }, viewport);
    return { clientX: screenPoint.x + dx, clientY: screenPoint.y + dy };
  };
  return { ...utils, props, surface, at, viewport };
}

afterEach(() => cleanup());

describe("PathSurface — tamaños y áreas en píxeles de pantalla", () => {
  it.each(ZOOMS)("zoom %s: los anchors miden SIEMPRE 8 px y los handles tienen radio 4 px; solo cambia dónde están", (zoom) => {
    const d = "M100 100 C110 130 130 130 140 100 L140 140";
    const { surface } = setup({ object: objectOf(d), model: modelOf(d), selection: new Set(["0:1"]) }, zoom);

    const anchors = surface.querySelectorAll('[data-testid="path-anchor"]');
    expect(anchors).toHaveLength(3);
    for (const anchor of anchors) {
      expect(anchor.getAttribute("width")).toBe("8");
      expect(anchor.getAttribute("height")).toBe("8");
    }
    const handles = surface.querySelectorAll('[data-testid="path-handle"]');
    expect(handles.length).toBeGreaterThan(0);
    for (const handle of handles) expect(handle.getAttribute("r")).toBe("4");

    // El anchor 0:0 está en el documento (100, 100): su centro en pantalla escala con el zoom.
    const first = surface.querySelector('[data-node="0:0"]')!;
    expect(Number(first.getAttribute("x")) + 4).toBeCloseTo((100 - 160) * zoom + 400, 9);
    expect(Number(first.getAttribute("y")) + 4).toBeCloseTo((100 - 120) * zoom + 300, 9);
  });

  it.each(ZOOMS)("zoom %s: un click a 8,9 px del anchor lo selecciona; a 10 px NO (a cualquier zoom)", (zoom) => {
    const { surface, props, at } = setup({}, zoom);
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, ...at(140, 100, 8.9, 0) });
    expect(props.onSelectNodes).toHaveBeenLastCalledWith([{ subpath: 0, node: 1 }], "replace");
    fireEvent.pointerUp(surface, { pointerId: 1, ...at(140, 100, 8.9, 0) });

    props.onSelectNodes.mockClear();
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, ...at(140, 100, 10, 0) });
    fireEvent.pointerUp(surface, { pointerId: 1, ...at(140, 100, 10, 0) });
    expect(props.onSelectNodes).not.toHaveBeenCalled();
    expect(props.onClearSelection).toHaveBeenCalledTimes(1);
  });

  it.each(ZOOMS)("zoom %s: un click a 5,9 px de un segmento lo selecciona (sus dos extremos); a 7 px no", (zoom) => {
    const { surface, props, at } = setup({}, zoom);
    // El punto medio del lado de arriba: (120, 100). 5,9 px por encima de la línea.
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, ...at(120, 100, 0, -5.9) });
    expect(props.onSelectNodes).toHaveBeenLastCalledWith(
      [
        { subpath: 0, node: 0 },
        { subpath: 0, node: 1 },
      ],
      "replace",
    );
    fireEvent.pointerUp(surface, { pointerId: 1, ...at(120, 100, 0, -5.9) });

    props.onSelectNodes.mockClear();
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, ...at(120, 100, 0, -7) });
    fireEvent.pointerUp(surface, { pointerId: 1, ...at(120, 100, 0, -7) });
    expect(props.onSelectNodes).not.toHaveBeenCalled();
  });

  it.each(ZOOMS)("zoom %s: un arrastre de 2 px NO inicia el gesto y uno de 4 px SÍ; el delta se entrega en unidades de DOCUMENTO (px / zoom)", (zoom) => {
    const { surface, props, at } = setup({}, zoom);
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, ...at(140, 100) });
    fireEvent.pointerMove(surface, { pointerId: 1, ...at(140, 100, 2, 0) });
    expect(props.onBeginDrag).not.toHaveBeenCalled();

    fireEvent.pointerMove(surface, { pointerId: 1, ...at(140, 100, 4, 0) });
    expect(props.onBeginDrag).toHaveBeenCalledWith({ kind: "anchors", refs: [{ subpath: 0, node: 1 }] });
    fireEvent.pointerMove(surface, { pointerId: 1, ...at(140, 100, 20, 10) });
    const [delta] = props.onDragBy.mock.calls[props.onDragBy.mock.calls.length - 1] as unknown as [Point];
    expect(delta.x).toBeCloseTo(20 / zoom, 9);
    expect(delta.y).toBeCloseTo(10 / zoom, 9);
    fireEvent.pointerUp(surface, { pointerId: 1, ...at(140, 100, 20, 10) });
    expect(props.onEndDrag).toHaveBeenCalledTimes(1);
  });
});

describe("PathSurface — interacción", () => {
  it("Shift+click alterna el nodo; sobre uno ya seleccionado lo saca y no hay arrastre", () => {
    const { surface, props, at } = setup({ selection: new Set(["0:1"]) });
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, shiftKey: true, ...at(140, 100) });
    expect(props.onSelectNodes).toHaveBeenLastCalledWith([{ subpath: 0, node: 1 }], "toggle");
    fireEvent.pointerMove(surface, { pointerId: 1, ...at(140, 100, 30, 0) });
    expect(props.onBeginDrag).not.toHaveBeenCalled();
  });

  it("Shift+click sobre un nodo NO seleccionado lo suma y puede arrastrar toda la selección", () => {
    const { surface, props, at } = setup({ selection: new Set(["0:0"]) });
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, shiftKey: true, ...at(140, 100) });
    fireEvent.pointerMove(surface, { pointerId: 1, ...at(140, 100, 10, 0) });
    expect(props.onBeginDrag).toHaveBeenCalledWith({
      kind: "anchors",
      refs: [
        { subpath: 0, node: 0 },
        { subpath: 0, node: 1 },
      ],
    });
  });

  it("arrastrar un nodo ya seleccionado de una multi-selección mueve TODA la selección; un click simple la reduce a ese nodo", () => {
    const { surface, props, at } = setup({ selection: new Set(["0:0", "0:1"]) });
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, ...at(140, 100) });
    fireEvent.pointerMove(surface, { pointerId: 1, ...at(140, 100, 10, 0) });
    expect(props.onBeginDrag).toHaveBeenCalledWith({
      kind: "anchors",
      refs: [
        { subpath: 0, node: 0 },
        { subpath: 0, node: 1 },
      ],
    });
    fireEvent.pointerUp(surface, { pointerId: 1, ...at(140, 100, 10, 0) });

    props.onSelectNodes.mockClear();
    fireEvent.pointerDown(surface, { pointerId: 2, button: 0, ...at(140, 100) });
    fireEvent.pointerUp(surface, { pointerId: 2, ...at(140, 100) });
    expect(props.onSelectNodes).toHaveBeenLastCalledWith([{ subpath: 0, node: 1 }], "replace");
  });

  it("el handle de un nodo seleccionado se agarra y se arrastra; Shift y Alt viajan como modificadores", () => {
    const d = "M100 100 C100 130 140 130 140 100";
    const { surface, props, at } = setup({ object: objectOf(d), model: modelOf(d), selection: new Set(["0:0"]) });
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, ...at(100, 130) });
    fireEvent.pointerMove(surface, { pointerId: 1, ...at(100, 130, 10, 0), shiftKey: true, altKey: true });
    expect(props.onBeginDrag).toHaveBeenCalledWith({ kind: "handle", ref: { subpath: 0, node: 0 }, side: "out" });
    expect(props.onDragBy).toHaveBeenLastCalledWith({ x: 10, y: 0 }, { shift: true, alt: true });
  });

  it("si la herramienta no puede iniciar el gesto (hay una transformación pendiente) el arrastre se descarta", () => {
    const { surface, props, at } = setup({ onBeginDrag: vi.fn(() => false) });
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, ...at(140, 100) });
    fireEvent.pointerMove(surface, { pointerId: 1, ...at(140, 100, 10, 0) });
    fireEvent.pointerMove(surface, { pointerId: 1, ...at(140, 100, 20, 0) });
    fireEvent.pointerUp(surface, { pointerId: 1, ...at(140, 100, 20, 0) });
    expect(props.onDragBy).not.toHaveBeenCalled();
    expect(props.onEndDrag).not.toHaveBeenCalled();
  });

  it("Alt+click sobre un anchor alterna esquina/suave; Ctrl+click sobre un segmento y el doble click agregan un nodo con su t", () => {
    const { surface, props, at } = setup();
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, altKey: true, ...at(140, 100) });
    expect(props.onToggleKind).toHaveBeenCalledWith({ subpath: 0, node: 1 });
    expect(props.onSelectNodes).not.toHaveBeenCalled();

    // Lado de arriba (100,100) -> (140,100): (110, 100) es t = 0,25.
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, ctrlKey: true, ...at(110, 100) });
    expect(props.onAddNode).toHaveBeenCalledTimes(1);
    const [subpath, segment, t] = props.onAddNode.mock.calls[0] as unknown as [number, number, number];
    expect([subpath, segment]).toEqual([0, 0]);
    expect(t).toBeCloseTo(0.25, 9);

    fireEvent.doubleClick(surface, at(130, 100));
    const last = props.onAddNode.mock.calls[1] as unknown as [number, number, number];
    expect(last[2]).toBeCloseTo(0.75, 9);
    // Doble click en vacío o sobre un anchor no agrega nada.
    fireEvent.doubleClick(surface, at(10, 10));
    fireEvent.doubleClick(surface, at(140, 100));
    expect(props.onAddNode).toHaveBeenCalledTimes(2);
  });

  it("marquee: selecciona los anchors dentro del rectángulo (Shift suma); un click en vacío limpia la selección", () => {
    const { surface, props, at } = setup();
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, ...at(90, 90) });
    fireEvent.pointerMove(surface, { pointerId: 1, ...at(120, 120) });
    expect(screen.getByTestId("path-marquee")).toBeInTheDocument();
    fireEvent.pointerUp(surface, { pointerId: 1, ...at(145, 105) });
    expect(props.onSelectNodes).toHaveBeenLastCalledWith(
      [
        { subpath: 0, node: 0 },
        { subpath: 0, node: 1 },
      ],
      "replace",
    );

    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, shiftKey: true, ...at(90, 130) });
    fireEvent.pointerMove(surface, { pointerId: 1, ...at(120, 135) });
    fireEvent.pointerUp(surface, { pointerId: 1, ...at(145, 145) });
    expect(props.onSelectNodes).toHaveBeenLastCalledWith(
      [
        { subpath: 0, node: 2 },
        { subpath: 0, node: 3 },
      ],
      "add",
    );

    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, ...at(10, 10) });
    fireEvent.pointerUp(surface, { pointerId: 1, ...at(10, 10) });
    expect(props.onClearSelection).toHaveBeenCalledTimes(1);
  });

  it("un click en vacío sobre OTRO objeto lo pasa a editar; sobre el propio objeto (su relleno) no", () => {
    const other = objectOf("M200 100 L240 100 L240 140 L200 140 Z", "o2");
    const { surface, props, at } = setup({ pool: [objectOf(SQUARE_D), other] });
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, ...at(220, 120) });
    expect(props.onPickObject).toHaveBeenCalledWith("o2");

    props.onPickObject.mockClear();
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, ...at(120, 120) });
    fireEvent.pointerUp(surface, { pointerId: 1, ...at(120, 120) });
    expect(props.onPickObject).not.toHaveBeenCalled();
  });

  it("Escape durante el arrastre cancela el gesto (sin entregar nada); soltar después no hace nada", () => {
    const { surface, props, at } = setup();
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, ...at(140, 100) });
    fireEvent.pointerMove(surface, { pointerId: 1, ...at(140, 100, 10, 0) });
    expect(props.onBeginDrag).toHaveBeenCalledTimes(1);

    const notPrevented = fireEvent.keyDown(document.body, { key: "Escape" });
    expect(notPrevented).toBe(false); // preventDefault: la herramienta no ve este Escape (no sale ni limpia la selección)
    expect(props.onCancelDrag).toHaveBeenCalledTimes(1);
    fireEvent.pointerMove(surface, { pointerId: 1, ...at(140, 100, 30, 0) });
    fireEvent.pointerUp(surface, { pointerId: 1, ...at(140, 100, 30, 0) });
    expect(props.onEndDrag).not.toHaveBeenCalled();
    expect(props.onDragBy).toHaveBeenCalledTimes(1);
  });

  it("Escape sin gesto en curso NO se intercepta (lo resuelve la herramienta)", () => {
    setup();
    expect(fireEvent.keyDown(document.body, { key: "Escape" })).toBe(true);
  });

  it("pointercancel cancela el gesto; desmontar la superficie con un gesto en curso lo cancela", () => {
    const first = setup();
    fireEvent.pointerDown(first.surface, { pointerId: 1, button: 0, ...first.at(140, 100) });
    fireEvent.pointerMove(first.surface, { pointerId: 1, ...first.at(140, 100, 10, 0) });
    fireEvent.pointerCancel(first.surface, { pointerId: 1 });
    expect(first.props.onCancelDrag).toHaveBeenCalledTimes(1);
    cleanup();

    const second = setup();
    fireEvent.pointerDown(second.surface, { pointerId: 1, button: 0, ...second.at(140, 100) });
    fireEvent.pointerMove(second.surface, { pointerId: 1, ...second.at(140, 100, 10, 0) });
    second.unmount();
    expect(second.props.onCancelDrag).toHaveBeenCalledTimes(1);
  });

  it("suspendida (Espacio / transformación pendiente): no captura el puntero ni reacciona", () => {
    const { surface, props, at } = setup({ suspended: true });
    expect(surface).toHaveStyle({ pointerEvents: "none" });
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, ...at(140, 100) });
    fireEvent.doubleClick(surface, at(120, 100));
    expect(props.onSelectNodes).not.toHaveBeenCalled();
    expect(props.onAddNode).not.toHaveBeenCalled();
  });

  it("otro botón del mouse no inicia nada", () => {
    const { surface, props, at } = setup();
    fireEvent.pointerDown(surface, { pointerId: 1, pointerType: "mouse", button: 2, ...at(140, 100) });
    expect(props.onSelectNodes).not.toHaveBeenCalled();
  });

  it("el nodo y el segmento bajo el cursor se resaltan", () => {
    const { surface, at } = setup();
    fireEvent.pointerMove(surface, { pointerId: 1, ...at(120, 100, 0, -3) });
    expect(screen.getByTestId("path-hover-segment")).toBeInTheDocument();
    fireEvent.pointerMove(surface, { pointerId: 1, ...at(10, 10) });
    expect(screen.queryByTestId("path-hover-segment")).not.toBeInTheDocument();
    fireEvent.pointerMove(surface, { pointerId: 1, ...at(140, 100) });
    expect(surface.querySelector('[data-node="0:1"]')).toHaveAttribute("fill", "#f59e0b");
  });

  it("nombre accesible: modo y cantidad de nodos y de seleccionados", () => {
    const { surface } = setup({ selection: new Set(["0:0", "0:2"]) });
    expect(surface).toHaveAccessibleName(/Edición de nodos del path: 4 nodos, 2 seleccionados\./);
  });
});

describe("PathSurface — overlay acotado", () => {
  const big = `M0 115 ${Array.from({ length: 4999 }, (_, index) => `L${(index + 1) * 0.06} ${115 + ((index + 1) % 2) * 5}`).join(" ")}`;

  it("un path de 5 000 nodos dibuja un máximo acotado de anchors y avisa", () => {
    const { surface } = setup({ object: objectOf(big), model: modelOf(big) });
    const anchors = surface.querySelectorAll('[data-testid="path-anchor"]');
    expect(anchors.length).toBe(1500);
    expect(screen.getByRole("status")).toHaveTextContent(/Mostrando\s+1.?500 de 5.?000 nodos en pantalla \(5.?000 en total\)/);
  });

  it("acercando el zoom entran menos nodos al viewport: ya no se recorta ni se avisa", () => {
    const { surface } = setup({ object: objectOf(big), model: modelOf(big) }, 40);
    const count = surface.querySelectorAll('[data-testid="path-anchor"]').length;
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(1500);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("lo que no se dibuja no se golpea: con el overlay recortado un click sobre un nodo no dibujado no lo selecciona", () => {
    const { surface, props, at } = setup({ object: objectOf(big), model: modelOf(big) });
    // El nodo 4000 (x = 240) cae fuera de los primeros 1500: no está dibujado.
    expect(surface.querySelector('[data-node="0:4000"]')).toBeNull();
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, ...at(4000 * 0.06, 115) });
    fireEvent.pointerMove(surface, { pointerId: 1, ...at(4000 * 0.06, 115, 10, 0) });
    fireEvent.pointerUp(surface, { pointerId: 1, ...at(4000 * 0.06, 115, 10, 0) });
    expect(props.onSelectNodes).toHaveBeenLastCalledWith(expect.not.arrayContaining([{ subpath: 0, node: 4000 }]), "replace");
    expect(props.onBeginDrag).not.toHaveBeenCalled();
  });

  it("los nodos seleccionados se dibujan siempre, aunque estén más allá del tope", () => {
    const { surface } = setup({ object: objectOf(big), model: modelOf(big), selection: new Set(["0:4000"]) });
    const selected = surface.querySelector('[data-node="0:4000"]');
    expect(selected).not.toBeNull();
    expect(selected).toHaveAttribute("data-selected", "true");
    expect(surface.querySelectorAll('[data-testid="path-anchor"]')).toHaveLength(1500);
  });
});
