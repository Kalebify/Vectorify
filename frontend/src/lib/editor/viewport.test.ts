import { describe, expect, it } from "vitest";
import { documentToScreen, FOCUS_MAX_SCALE, focusTransform, screenToDocument, type ViewportParams } from "./viewport";

const BASE: ViewportParams = { containerWidth: 800, containerHeight: 600, panX: 0, panY: 0, scale: 1, sourceWidth: 320, sourceHeight: 240 };

describe("screenToDocument / documentToScreen", () => {
  it("escala 1 sin pan: el centro del contenedor es el centro del documento", () => {
    expect(screenToDocument({ x: 400, y: 300 }, BASE)).toEqual({ x: 160, y: 120 });
    expect(documentToScreen({ x: 160, y: 120 }, BASE)).toEqual({ x: 400, y: 300 });
  });

  it("la esquina (0,0) del documento cae en (400-160, 300-120) a escala 1", () => {
    expect(documentToScreen({ x: 0, y: 0 }, BASE)).toEqual({ x: 240, y: 180 });
  });

  it("zoom alto (8×): 8 px de pantalla = 1 unidad de documento", () => {
    const zoomed = { ...BASE, scale: 8 };
    const origin = screenToDocument({ x: 400, y: 300 }, zoomed);
    const moved = screenToDocument({ x: 408, y: 300 }, zoomed);
    expect(moved.x - origin.x).toBeCloseTo(1, 12);
  });

  it("zoom bajo (0.1×): 1 px de pantalla = 10 unidades de documento", () => {
    const zoomed = { ...BASE, scale: 0.1 };
    const origin = screenToDocument({ x: 400, y: 300 }, zoomed);
    const moved = screenToDocument({ x: 401, y: 300 }, zoomed);
    expect(moved.x - origin.x).toBeCloseTo(10, 12);
  });

  it("pan desplaza el punto del documento bajo el cursor", () => {
    const panned = { ...BASE, panX: 50, panY: -30 };
    // el centro del documento ahora se dibuja en (450, 270)
    expect(documentToScreen({ x: 160, y: 120 }, panned)).toEqual({ x: 450, y: 270 });
    expect(screenToDocument({ x: 450, y: 270 }, panned)).toEqual({ x: 160, y: 120 });
  });

  it("son inversas exactas para zoom/pan arbitrarios", () => {
    const viewport: ViewportParams = { ...BASE, scale: 3.7, panX: -123.4, panY: 55.5 };
    const point = { x: 41.25, y: 199.75 };
    const back = screenToDocument(documentToScreen(point, viewport), viewport);
    expect(back.x).toBeCloseTo(point.x, 9);
    expect(back.y).toBeCloseTo(point.y, 9);
  });

  it("origen del marco (M3-S02): el centro del marco, no el (0,0), cae en el centro del contenedor", () => {
    // Marco 100×200 con origen (50,-50) -> centro (100, 50).
    const framed: ViewportParams = { ...BASE, sourceWidth: 100, sourceHeight: 200, originX: 50, originY: -50 };
    expect(documentToScreen({ x: 100, y: 50 }, framed)).toEqual({ x: 400, y: 300 });
    expect(screenToDocument({ x: 400, y: 300 }, framed)).toEqual({ x: 100, y: 50 });
    // La esquina arriba-izquierda del marco (50,-50) queda a (-50,-100) px del centro a escala 1.
    expect(documentToScreen({ x: 50, y: -50 }, framed)).toEqual({ x: 350, y: 200 });
  });

  it("sin origen (S01) el comportamiento no cambia y con origen son inversas exactas", () => {
    expect(documentToScreen({ x: 0, y: 0 }, BASE)).toEqual(documentToScreen({ x: 0, y: 0 }, { ...BASE, originX: 0, originY: 0 }));
    const viewport: ViewportParams = { ...BASE, scale: 2.5, panX: 17, panY: -9, originX: -30.5, originY: 12.25 };
    const point = { x: 41.25, y: 199.75 };
    const back = screenToDocument(documentToScreen(point, viewport), viewport);
    expect(back.x).toBeCloseTo(point.x, 9);
    expect(back.y).toBeCloseTo(point.y, 9);
  });
});

describe("focusTransform (M3-S11: centrar un rectángulo del documento)", () => {
  const container = { width: 800, height: 600 };
  const frame = { x: 0, y: 0, width: 320, height: 240 };
  const params = { container, frame, minScale: 0.1, maxScale: 8 };

  it("el centro del rectángulo cae EXACTO en el centro del contenedor (con el álgebra inversa de documentToScreen)", () => {
    const target = { x: 200, y: 50, width: 40, height: 20 };

    const focus = focusTransform(target, params)!;
    const viewport: ViewportParams = { ...BASE, panX: focus.panX, panY: focus.panY, scale: focus.scale };

    expect(documentToScreen({ x: 220, y: 60 }, viewport).x).toBeCloseTo(400, 9);
    expect(documentToScreen({ x: 220, y: 60 }, viewport).y).toBeCloseTo(300, 9);
  });

  it("el zoom hace que el rectángulo ocupe el 40 % del lado limitante del contenedor: 40 x 20 u -> 800 x 0,4 / 40 = 8 (techo del canvas), pero 200 x 100 u -> 1,6", () => {
    // Ancho: 800 · 0,4 / 200 = 1,6; alto: 600 · 0,4 / 100 = 2,4 -> manda el ancho.
    expect(focusTransform({ x: 0, y: 0, width: 200, height: 100 }, params)!.scale).toBeCloseTo(1.6, 12);
    // Alto: 600 · 0,4 / 200 = 1,2 manda sobre el ancho 800 · 0,4 / 50 = 6,4.
    expect(focusTransform({ x: 0, y: 0, width: 50, height: 200 }, params)!.scale).toBeCloseTo(1.2, 12);
  });

  it("una isla diminuta no lleva el zoom a un extremo inútil: tope de 6 (y nunca más que el máximo del canvas)", () => {
    expect(focusTransform({ x: 10, y: 10, width: 1, height: 1 }, params)!.scale).toBe(FOCUS_MAX_SCALE);
    expect(focusTransform({ x: 10, y: 10, width: 1, height: 1 }, { ...params, maxScale: 4 })!.scale).toBe(4);
    expect(focusTransform({ x: 10, y: 10, width: 0, height: 0 }, params)!.scale).toBe(FOCUS_MAX_SCALE); // un punto
  });

  it("un rectángulo enorme aleja la vista hasta que entre (y respeta el mínimo)", () => {
    expect(focusTransform({ x: 0, y: 0, width: 4000, height: 3000 }, params)!.scale).toBeCloseTo(0.1, 12); // 800 · 0,4 / 4000 = 0,08 -> sube al mínimo 0,1
    expect(focusTransform({ x: 0, y: 0, width: 1600, height: 100 }, params)!.scale).toBeCloseTo(0.2, 12);
  });

  it("tiene en cuenta el origen del marco (tras un crop o una rotación) al centrar", () => {
    const shifted = { x: 100, y: 50, width: 320, height: 240 };
    const target = { x: 100, y: 50, width: 20, height: 20 }; // esquina del marco

    const focus = focusTransform(target, { ...params, frame: shifted })!;
    const viewport: ViewportParams = { ...BASE, originX: 100, originY: 50, panX: focus.panX, panY: focus.panY, scale: focus.scale };

    expect(documentToScreen({ x: 110, y: 60 }, viewport)).toEqual({ x: 400, y: 300 });
  });

  it("sin contenedor medido, o con datos no finitos o negativos, no inventa una vista (null)", () => {
    const target = { x: 0, y: 0, width: 10, height: 10 };

    expect(focusTransform(target, { ...params, container: { width: 0, height: 600 } })).toBeNull();
    expect(focusTransform(target, { ...params, container: { width: 800, height: 0 } })).toBeNull();
    expect(focusTransform({ ...target, x: NaN }, params)).toBeNull();
    expect(focusTransform({ ...target, width: Infinity }, params)).toBeNull();
    expect(focusTransform({ ...target, width: -5 }, params)).toBeNull();
    expect(focusTransform(target, { ...params, frame: { ...frame, width: NaN } })).toBeNull();
  });

  it("acepta otro porcentaje de relleno y otro techo de zoom", () => {
    const target = { x: 0, y: 0, width: 100, height: 100 };

    expect(focusTransform(target, { ...params, fill: 0.5 })!.scale).toBeCloseTo(3, 12); // 600 · 0,5 / 100
    expect(focusTransform(target, { ...params, fill: 0.5, maxFocusScale: 2 })!.scale).toBe(2);
  });
});
