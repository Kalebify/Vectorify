import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { IDENTITY_MATRIX } from "../../lib/svgTransform";
import type { EditorObject } from "../../lib/editor/types";
import type { ViewportParams } from "../../lib/editor/viewport";
import { ToolSurface, type ToolSurfaceProps } from "./ToolSurface";

/**
 * ToolSurface (M3-S04): convierte el puntero en coordenadas de documento y dibuja el preview. Viewport de prueba: contenedor 800 x 600,
 * documento 320 x 240, escala 1 y pan 0 => pantalla = documento + (240, 180).
 */

const VIEWPORT: ViewportParams = { containerWidth: 800, containerHeight: 600, panX: 0, panY: 0, scale: 1, sourceWidth: 320, sourceHeight: 240 };
const at = (x: number, y: number) => ({ clientX: x + 240, clientY: y + 180 });

function shape(id: string, layerGroupId: string, d: string): EditorObject {
  return { id, layerGroupId, d, fill: "#ff0000", matrix: IDENTITY_MATRIX };
}

function setup(overrides: Partial<ToolSurfaceProps> = {}) {
  const props = {
    tool: "draw",
    viewport: VIEWPORT,
    suspended: false,
    drawMode: "polyline",
    draft: [],
    lineWidthUnits: 0.2,
    onPolylinePoint: vi.fn(),
    onPolylineFinish: vi.fn(),
    onFreehandStroke: vi.fn(),
    eraseMode: "geometry",
    radiusUnits: 4,
    busy: false,
    pool: [],
    lockedLayerIds: new Set<string>(),
    onEraseObjects: vi.fn(),
    onEraseStroke: vi.fn(),
    ...overrides,
  } satisfies ToolSurfaceProps;
  const utils = render(<ToolSurface {...props} />);
  const surface = screen.getByTestId(`${props.tool}-surface`);
  return { ...utils, props, surface };
}

describe("ToolSurface — Draw / polilínea", () => {
  it("cada click entrega el punto en coordenadas de DOCUMENTO", () => {
    const { surface, props } = setup();
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, ...at(100, 30) });

    expect(props.onPolylinePoint).toHaveBeenCalledWith({ x: 100, y: 30 }, false);
  });

  it("convierte con el pan y el zoom vigentes (escala 2 y pan 20 px)", () => {
    const { surface, props } = setup({ viewport: { ...VIEWPORT, scale: 2, panX: 20, panY: -10 } });
    // doc = (screen - (400 + 20)) / 2 + 160  ->  screen 420 = doc 160; y: (300 - 10 = 290) -> doc 120
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, clientX: 520, clientY: 290 });

    expect(props.onPolylinePoint).toHaveBeenCalledWith({ x: 210, y: 120 }, false);
  });

  it("click a ≤ 8 px del primer punto con 3+ puntos avisa `nearFirst` (cerrar); a más distancia o con menos puntos, no", () => {
    const draft = [
      { x: 100, y: 100 },
      { x: 160, y: 100 },
      { x: 160, y: 160 },
    ];
    const { surface, props } = setup({ draft });

    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, ...at(105, 104) }); // a 6,4 px
    expect(props.onPolylinePoint).toHaveBeenLastCalledWith({ x: 105, y: 104 }, true);
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, ...at(110, 110) }); // a 14,1 px
    expect(props.onPolylinePoint).toHaveBeenLastCalledWith({ x: 110, y: 110 }, false);
  });

  it("con solo 2 puntos, un click sobre el primero NO cierra", () => {
    const { surface, props } = setup({ draft: [{ x: 100, y: 100 }, { x: 160, y: 100 }] });
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, ...at(100, 100) });

    expect(props.onPolylinePoint).toHaveBeenCalledWith({ x: 100, y: 100 }, false);
  });

  it("la distancia de cierre es en PX de pantalla: a zoom 4 un punto a 1 unidad está a 4 px y cierra", () => {
    const draft = [{ x: 160, y: 120 }, { x: 200, y: 120 }, { x: 200, y: 160 }];
    const { surface, props } = setup({ draft, viewport: { ...VIEWPORT, scale: 4 } });
    // El centro del documento (160, 120) cae en el centro del contenedor (400, 300).
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, clientX: 404, clientY: 300 });

    expect(props.onPolylinePoint).toHaveBeenCalledWith({ x: 161, y: 120 }, true);
  });

  it("doble click termina la línea; ocupado, suspendido o con otro botón del mouse no hace nada", () => {
    const { surface, props, rerender } = setup();
    fireEvent.doubleClick(surface);
    expect(props.onPolylineFinish).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(surface, { pointerId: 1, pointerType: "mouse", button: 2, ...at(10, 10) });
    expect(props.onPolylinePoint).not.toHaveBeenCalled();

    rerender(<ToolSurface {...props} busy />);
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, ...at(10, 10) });
    fireEvent.doubleClick(surface);
    expect(props.onPolylinePoint).not.toHaveBeenCalled();
    expect(props.onPolylineFinish).toHaveBeenCalledTimes(1);

    rerender(<ToolSurface {...props} suspended />);
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, ...at(10, 10) });
    expect(props.onPolylinePoint).not.toHaveBeenCalled();
    expect(surface).toHaveStyle({ pointerEvents: "none" });
  });

  it("dibuja el preview: la polilínea con un círculo por punto y el segmento elástico hasta el cursor", () => {
    const { surface } = setup({ draft: [{ x: 100, y: 100 }, { x: 160, y: 100 }] });
    expect(screen.getByTestId("draw-preview").querySelectorAll("circle")).toHaveLength(2);
    expect(screen.getByTestId("draw-preview").querySelectorAll("line")).toHaveLength(0);

    fireEvent.pointerMove(surface, { pointerId: 1, ...at(200, 140) });
    const line = screen.getByTestId("draw-preview").querySelector("line")!;
    expect(line.getAttribute("x1")).toBe("400");
    expect(line.getAttribute("x2")).toBe("440");
    // El grosor del preview sigue el ancho de línea a escala (0,2 u a zoom 1 => mínimo 1 px).
    expect(screen.getByTestId("draw-preview").querySelector("polyline")!.getAttribute("stroke-width")).toBe("1");
  });

  it("sin puntos no hay preview", () => {
    setup();
    expect(screen.queryByTestId("draw-preview")).not.toBeInTheDocument();
  });
});

describe("ToolSurface — Draw / mano alzada", () => {
  it("entrega el trazo completo al soltar y descarta los movimientos de menos de 2 px", () => {
    const { surface, props } = setup({ drawMode: "freehand" });
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, ...at(50, 160) });
    fireEvent.pointerMove(surface, { pointerId: 1, ...at(51, 160) }); // 1 px: se ignora
    fireEvent.pointerMove(surface, { pointerId: 1, ...at(80, 160) });
    fireEvent.pointerMove(surface, { pointerId: 1, ...at(110, 161) });
    expect(screen.getByTestId("draw-preview")).toBeInTheDocument();
    fireEvent.pointerUp(surface, { pointerId: 1, ...at(110, 161) });

    expect(props.onFreehandStroke).toHaveBeenCalledTimes(1);
    expect(props.onFreehandStroke).toHaveBeenCalledWith([
      { x: 50, y: 160 },
      { x: 80, y: 160 },
      { x: 110, y: 161 },
    ]);
    expect(props.onPolylinePoint).not.toHaveBeenCalled();
    expect(screen.queryByTestId("draw-preview")).not.toBeInTheDocument();
  });

  it("Escape descarta el trazo en curso sin entregar nada; pointercancel también", () => {
    const { surface, props } = setup({ drawMode: "freehand" });
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, ...at(50, 160) });
    fireEvent.pointerMove(surface, { pointerId: 1, ...at(80, 160) });
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(surface, { pointerId: 1, ...at(80, 160) });
    expect(props.onFreehandStroke).not.toHaveBeenCalled();

    fireEvent.pointerDown(surface, { pointerId: 2, button: 0, ...at(50, 160) });
    fireEvent.pointerMove(surface, { pointerId: 2, ...at(80, 160) });
    fireEvent.pointerCancel(surface, { pointerId: 2 });
    expect(props.onFreehandStroke).not.toHaveBeenCalled();
  });

  it("ignora los eventos de otro puntero mientras hay un gesto", () => {
    const { surface, props } = setup({ drawMode: "freehand" });
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, ...at(50, 160) });
    fireEvent.pointerMove(surface, { pointerId: 9, ...at(80, 160) });
    fireEvent.pointerUp(surface, { pointerId: 9, ...at(80, 160) });
    expect(props.onFreehandStroke).not.toHaveBeenCalled();
    fireEvent.pointerUp(surface, { pointerId: 1, ...at(50, 160) });
    expect(props.onFreehandStroke).toHaveBeenCalledWith([{ x: 50, y: 160 }]);
  });
});

describe("ToolSurface — Erase / restar geometría", () => {
  it("un arrastre entrega el trazo; un click solo, un único punto (toque del pincel)", () => {
    const { surface, props } = setup({ tool: "erase" });
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, ...at(-10, 20) });
    fireEvent.pointerMove(surface, { pointerId: 1, ...at(20, 20) });
    fireEvent.pointerUp(surface, { pointerId: 1, ...at(50, 20) });
    expect(props.onEraseStroke).toHaveBeenLastCalledWith([
      { x: -10, y: 20 },
      { x: 20, y: 20 },
    ]);

    fireEvent.pointerDown(surface, { pointerId: 2, button: 0, ...at(30, 30) });
    fireEvent.pointerUp(surface, { pointerId: 2, ...at(30, 30) });
    expect(props.onEraseStroke).toHaveBeenLastCalledWith([{ x: 30, y: 30 }]);
    expect(props.onEraseObjects).not.toHaveBeenCalled();
  });

  it("el cursor mide el radio real (4 u = 4 px a zoom 1; 8 px a zoom 2) y la huella del trazo es 2 x radio", () => {
    const { surface, rerender, props } = setup({ tool: "erase" });
    fireEvent.pointerMove(surface, { pointerId: 1, ...at(10, 10) });
    expect(screen.getByTestId("erase-cursor").getAttribute("r")).toBe("4");

    rerender(<ToolSurface {...props} viewport={{ ...VIEWPORT, scale: 2 }} />);
    expect(screen.getByTestId("erase-cursor").getAttribute("r")).toBe("8");

    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, clientX: 400, clientY: 300 });
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 450, clientY: 300 });
    expect(screen.getByTestId("erase-footprint").getAttribute("stroke-width")).toBe("16");
  });

  it("ocupado: no hay cursor ni acepta gestos nuevos", () => {
    const { surface, props, rerender } = setup({ tool: "erase" });
    fireEvent.pointerMove(surface, { pointerId: 1, ...at(10, 10) });
    rerender(<ToolSurface {...props} busy />);
    expect(screen.queryByTestId("erase-cursor")).not.toBeInTheDocument();

    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, ...at(10, 10) });
    fireEvent.pointerUp(surface, { pointerId: 1, ...at(10, 10) });
    expect(props.onEraseStroke).not.toHaveBeenCalled();
  });

  it("Escape durante el arrastre no entrega nada y limpia la huella", () => {
    const { surface, props } = setup({ tool: "erase" });
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, ...at(10, 10) });
    fireEvent.pointerMove(surface, { pointerId: 1, ...at(60, 10) });
    expect(screen.getByTestId("erase-footprint")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("erase-footprint")).not.toBeInTheDocument();
    fireEvent.pointerUp(surface, { pointerId: 1, ...at(60, 10) });
    expect(props.onEraseStroke).not.toHaveBeenCalled();
  });
});

describe("ToolSurface — Erase / modo Objeto", () => {
  const pool = [shape("r1", "A", "M0 0 H40 V40 H0 Z"), shape("b1", "B", "M100 100 H140 V140 H100 Z"), shape("l1", "L", "M200 0 H240 V40 H200 Z")];

  it("entrega los ids de los objetos tocados por el gesto (también los de capas bloqueadas: el shell decide), una sola vez al soltar", () => {
    const { surface, props } = setup({ tool: "erase", eraseMode: "object", pool, lockedLayerIds: new Set(["L"]) });
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, ...at(20, 20) });
    expect(screen.getByTestId("erase-hits").querySelectorAll("path")).toHaveLength(1);
    fireEvent.pointerMove(surface, { pointerId: 1, ...at(120, 120) });
    fireEvent.pointerMove(surface, { pointerId: 1, ...at(220, 20) });
    expect(props.onEraseObjects).not.toHaveBeenCalled();
    fireEvent.pointerUp(surface, { pointerId: 1, ...at(220, 20) });

    expect(props.onEraseObjects).toHaveBeenCalledTimes(1);
    expect([...(props.onEraseObjects as ReturnType<typeof vi.fn>).mock.calls[0][0]].sort()).toEqual(["b1", "l1", "r1"]);
    expect(props.onEraseStroke).not.toHaveBeenCalled();
  });

  it("un movimiento largo entre dos eventos no se salta objetos finos", () => {
    const { surface, props } = setup({ tool: "erase", eraseMode: "object", pool });
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, ...at(-50, 120) });
    fireEvent.pointerMove(surface, { pointerId: 1, ...at(180, 120) }); // cruza b1 (100..140) sin que haya un evento adentro
    fireEvent.pointerUp(surface, { pointerId: 1, ...at(180, 120) });

    expect(props.onEraseObjects).toHaveBeenCalledWith(["b1"]);
  });

  it("click sobre el fondo no entrega nada", () => {
    const { surface, props } = setup({ tool: "erase", eraseMode: "object", pool });
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, ...at(300, 200) });
    fireEvent.pointerUp(surface, { pointerId: 1, ...at(300, 200) });

    expect(props.onEraseObjects).not.toHaveBeenCalled();
  });

  it("resalta en gris punteado lo que está en una capa bloqueada y en rojo lo borrable", () => {
    const { surface } = setup({ tool: "erase", eraseMode: "object", pool, lockedLayerIds: new Set(["L"]) });
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, ...at(20, 20) });
    fireEvent.pointerMove(surface, { pointerId: 1, ...at(220, 20) });

    const paths = [...screen.getByTestId("erase-hits").querySelectorAll("path")];
    expect(paths.map((path) => path.getAttribute("stroke"))).toEqual(["#dc2626", "#7a808a"]);
    expect(paths[1].getAttribute("stroke-dasharray")).not.toBeNull();
  });

  it("la tolerancia del click es constante en pantalla: a zoom 8 hay que apuntar más cerca (4 px = 0,5 u)", () => {
    const line = shape("line", "A", "M0 0 L100 0");
    line.fill = "none";
    line.stroke = "#000";
    line.strokeWidth = 0.1;
    const { surface, props } = setup({ tool: "erase", eraseMode: "object", pool: [line], viewport: { ...VIEWPORT, scale: 8 } });
    // Centro del documento (160,120) = (400,300). El punto (50, 3) en pantalla: 400 + (50 - 160) * 8, 300 + (3 - 120) * 8.
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, clientX: 400 + (50 - 160) * 8, clientY: 300 + (3 - 120) * 8 });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 400 + (50 - 160) * 8, clientY: 300 + (3 - 120) * 8 });
    expect(props.onEraseObjects).not.toHaveBeenCalled();
  });
});

describe("ToolSurface — accesibilidad", () => {
  it("la superficie tiene un nombre accesible que describe el modo activo", () => {
    const { rerender, props } = setup();
    expect(screen.getByRole("group", { name: /modo Polilínea/ })).toBeInTheDocument();
    rerender(<ToolSurface {...props} drawMode="freehand" />);
    expect(screen.getByRole("group", { name: /modo Mano alzada/ })).toBeInTheDocument();
    rerender(<ToolSurface {...props} tool="erase" />);
    expect(screen.getByRole("group", { name: /modo Restar geometría/ })).toBeInTheDocument();
    rerender(<ToolSurface {...props} tool="erase" eraseMode="object" />);
    expect(screen.getByRole("group", { name: /modo Objeto/ })).toBeInTheDocument();
  });

  it("el overlay SVG no es parte del árbol accesible", () => {
    const { container } = setup();
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });
});
