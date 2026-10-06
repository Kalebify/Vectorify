import { describe, expect, it } from "vitest";
import { documentToScreen, screenToDocument, type ViewportParams } from "./viewport";

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
