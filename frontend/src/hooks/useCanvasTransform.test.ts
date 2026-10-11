import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { IDENTITY_TRANSFORM, useCanvasTransform } from "./useCanvasTransform";

describe("useCanvasTransform — estado inicial", () => {
  it("arranca en escala 1:1 sin desplazamiento (identidad)", () => {
    const { result } = renderHook(() => useCanvasTransform());
    expect(result.current.transform).toEqual(IDENTITY_TRANSFORM);
  });
});

describe("useCanvasTransform — zoom", () => {
  it("zoomBy sin anchor escala sobre el centro (no cambia panX/panY)", () => {
    const { result } = renderHook(() => useCanvasTransform());

    act(() => result.current.panBy(30, -10));
    act(() => result.current.zoomBy(2));

    expect(result.current.transform.scale).toBe(2);
    expect(result.current.transform.panX).toBe(30);
    expect(result.current.transform.panY).toBe(-10);
  });

  it("zoomBy con anchor mantiene fijo el punto bajo el cursor", () => {
    const { result } = renderHook(() => useCanvasTransform());

    // Con escala 1 y pan 0, el punto de contenido bajo anchor=(100,50) es
    // exactamente (100,50). Tras duplicar la escala, el nuevo pan debe hacer
    // que ese mismo punto de contenido siga cayendo en (100,50).
    act(() => result.current.zoomBy(2, { x: 100, y: 50 }));

    expect(result.current.transform.scale).toBe(2);
    expect(result.current.transform.panX).toBe(100 - (100 - 0) * 2);
    expect(result.current.transform.panY).toBe(50 - (50 - 0) * 2);
  });

  it("respeta minScale y maxScale", () => {
    const { result } = renderHook(() => useCanvasTransform({ minScale: 0.5, maxScale: 3 }));

    act(() => result.current.zoomBy(0.01));
    expect(result.current.transform.scale).toBe(0.5);

    act(() => result.current.zoomBy(100));
    expect(result.current.transform.scale).toBe(3);
  });

  it("ignora un factor inválido (<=0 o no finito) sin romper el estado", () => {
    const { result } = renderHook(() => useCanvasTransform());

    act(() => result.current.zoomBy(0));
    act(() => result.current.zoomBy(-1));
    act(() => result.current.zoomBy(Number.NaN));

    expect(result.current.transform).toEqual(IDENTITY_TRANSFORM);
  });
});

describe("useCanvasTransform — pan", () => {
  it("panBy acumula desplazamientos sin tocar la escala", () => {
    const { result } = renderHook(() => useCanvasTransform());

    act(() => result.current.panBy(10, 5));
    act(() => result.current.panBy(-3, 20));

    expect(result.current.transform).toEqual({ scale: 1, panX: 7, panY: 25 });
  });
});

describe("useCanvasTransform — reset y fitToScreen", () => {
  it("reset vuelve a escala 1:1 sin desplazamiento tras zoom/pan", () => {
    const { result } = renderHook(() => useCanvasTransform());

    act(() => result.current.zoomBy(3));
    act(() => result.current.panBy(50, 50));
    act(() => result.current.reset());

    expect(result.current.transform).toEqual(IDENTITY_TRANSFORM);
  });

  it("fitToScreen usa el factor menor (contain) entre ancho y alto, sin desplazamiento", () => {
    const { result } = renderHook(() => useCanvasTransform());

    act(() => result.current.panBy(20, 20));
    // Contenedor 400x200, recurso 800x400 -> ambos ratios dan 0.5.
    act(() => result.current.fitToScreen({ width: 400, height: 200 }, { width: 800, height: 400 }));

    expect(result.current.transform).toEqual({ scale: 0.5, panX: 0, panY: 0 });
  });

  it("fitToScreen elige el ratio más restrictivo cuando ancho y alto difieren", () => {
    const { result } = renderHook(() => useCanvasTransform());

    // Contenedor 300x300, recurso 600x150 -> ratioW=0.5, ratioH=2 -> min=0.5.
    act(() => result.current.fitToScreen({ width: 300, height: 300 }, { width: 600, height: 150 }));

    expect(result.current.transform.scale).toBe(0.5);
  });

  it("fitToScreen no hace nada si falta alguna dimensión (contenedor o recurso sin medir)", () => {
    const { result } = renderHook(() => useCanvasTransform());

    act(() => result.current.panBy(15, 15));
    act(() => result.current.fitToScreen({ width: 0, height: 200 }, { width: 800, height: 400 }));

    expect(result.current.transform).toEqual({ scale: 1, panX: 15, panY: 15 });
  });

  it("fitToScreen respeta el clamp de maxScale (recurso mucho más chico que el contenedor)", () => {
    const { result } = renderHook(() => useCanvasTransform({ maxScale: 4 }));

    act(() => result.current.fitToScreen({ width: 1000, height: 1000 }, { width: 10, height: 10 }));

    expect(result.current.transform.scale).toBe(4);
  });
});

describe("useCanvasTransform — centerOn (M3-S11)", () => {
  const container = { width: 800, height: 600 };
  const frame = { x: 0, y: 0, width: 320, height: 240 };

  it("centra un rectángulo del documento con un zoom razonable: pan y zoom salen de focusTransform", () => {
    const { result } = renderHook(() => useCanvasTransform());

    act(() => result.current.centerOn({ x: 200, y: 50, width: 40, height: 20 }, container, frame));

    // 40 x 20 u en 800 x 600: 800 · 0,4 / 40 = 8 (techo del canvas y de 8 > 6) -> 6; el centro (220, 60) cae en el del contenedor: pan = -(220 - 160) · 6.
    expect(result.current.transform.scale).toBe(6);
    expect(result.current.transform.panX).toBe(-360);
    expect(result.current.transform.panY).toBe(-(60 - 120) * 6);
  });

  it("respeta los límites de zoom del hook", () => {
    const { result } = renderHook(() => useCanvasTransform({ maxScale: 3 }));

    act(() => result.current.centerOn({ x: 10, y: 10, width: 1, height: 1 }, container, frame));

    expect(result.current.transform.scale).toBe(3);
  });

  it("sin contenedor medido (0 x 0) o con un rectángulo no finito no cambia la vista", () => {
    const { result } = renderHook(() => useCanvasTransform());
    act(() => result.current.panBy(12, 5));
    const before = result.current.transform;

    act(() => result.current.centerOn({ x: 0, y: 0, width: 10, height: 10 }, { width: 0, height: 0 }, frame));
    act(() => result.current.centerOn({ x: NaN, y: 0, width: 10, height: 10 }, container, frame));

    expect(result.current.transform).toBe(before);
  });

  it("centrar dos veces el mismo rectángulo es idempotente", () => {
    const { result } = renderHook(() => useCanvasTransform());

    act(() => result.current.centerOn({ x: 20, y: 20, width: 100, height: 50 }, container, frame));
    const first = result.current.transform;
    act(() => result.current.centerOn({ x: 20, y: 20, width: 100, height: 50 }, container, frame));

    expect(result.current.transform).toEqual(first);
  });
});
