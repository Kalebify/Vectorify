import { describe, expect, it, vi } from "vitest";
import { exportDataset } from "../../../test/exportDataset";
import { fakePng } from "../../../test/fakePng";
import { orderedLayers } from "./exportDocument";
import { isPng, maxPngWidth, normalizeBackground, PNG_MAX_PIXELS, PNG_MAX_SIDE, PNG_MIN_SIDE, pngDimensions, renderPng, resolvePngSize } from "./pngExport";

describe("resolvePngSize", () => {
  it("el alto sale de la relación de aspecto del área de trabajo", () => {
    expect(resolvePngSize({ width: 200, height: 100 }, 800)).toEqual({ ok: true, width: 800, height: 400 });
    expect(resolvePngSize({ width: 100, height: 200 }, 300)).toEqual({ ok: true, width: 300, height: 600 });
    expect(resolvePngSize({ width: 320, height: 240 }, 1000)).toEqual({ ok: true, width: 1000, height: 750 });
  });

  it("redondea el ancho pedido y el alto resultante", () => {
    expect(resolvePngSize({ width: 3, height: 2 }, 100.4)).toEqual({ ok: true, width: 100, height: 67 });
  });

  it("rechaza anchos inválidos o por debajo del mínimo", () => {
    expect(resolvePngSize({ width: 200, height: 100 }, Number.NaN).ok).toBe(false);
    expect(resolvePngSize({ width: 200, height: 100 }, Number.POSITIVE_INFINITY).ok).toBe(false);
    const tiny = resolvePngSize({ width: 200, height: 100 }, PNG_MIN_SIDE - 1);
    expect(tiny).toMatchObject({ ok: false });
    expect(resolvePngSize({ width: 200, height: 100 }, PNG_MIN_SIDE).ok).toBe(true);
  });

  it("un documento muy apaisado a un ancho chico deja un alto de 1 px como mínimo (nunca 0)", () => {
    expect(resolvePngSize({ width: 1000, height: 1 }, 100)).toEqual({ ok: true, width: 100, height: 1 });
  });

  it("tope por lado: el mensaje dice el máximo y ese máximo SÍ se acepta (y uno más no)", () => {
    const frame = { width: 200, height: 100 };
    const result = resolvePngSize(frame, PNG_MAX_SIDE + 1);
    expect(result.ok).toBe(false);
    const max = maxPngWidth(frame);
    expect(result.ok === false && result.error).toContain(`${max} px`);
    expect(resolvePngSize(frame, max).ok).toBe(true);
    expect(resolvePngSize(frame, max + 1).ok).toBe(false);
  });

  it("tope por megapíxeles: 8192 x 8192 (67 MP) se rechaza; el máximo sugerido respeta los dos topes", () => {
    const square = { width: 100, height: 100 };
    expect(resolvePngSize(square, PNG_MAX_SIDE)).toMatchObject({ ok: false });
    const max = maxPngWidth(square);
    expect(max * max).toBeLessThanOrEqual(PNG_MAX_PIXELS);
    expect(resolvePngSize(square, max).ok).toBe(true);
    const tall = { width: 100, height: 400 };
    const maxTall = maxPngWidth(tall);
    const sized = resolvePngSize(tall, maxTall);
    expect(sized.ok).toBe(true);
    if (sized.ok) {
      expect(sized.height).toBeLessThanOrEqual(PNG_MAX_SIDE);
      expect(sized.width * sized.height).toBeLessThanOrEqual(PNG_MAX_PIXELS);
    }
  });

  it("un marco inválido da un error en vez de NaN", () => {
    expect(resolvePngSize({ width: 0, height: 10 }, 100).ok).toBe(false);
    expect(resolvePngSize({ width: Number.NaN, height: 10 }, 100).ok).toBe(false);
  });
});

describe("fondo y validación de PNG", () => {
  it("normalizeBackground acepta #rgb y #rrggbb (y normaliza a minúsculas); rechaza el resto", () => {
    expect(normalizeBackground("#FFF")).toBe("#fff");
    expect(normalizeBackground(" #A1B2C3 ")).toBe("#a1b2c3");
    for (const bad of ["", "red", "#ff", "#ffff", "#gggggg", "rgb(0,0,0)", "#ff0000; x"]) expect(normalizeBackground(bad), bad).toBeNull();
  });

  it("isPng / pngDimensions leen la firma y el IHDR", () => {
    expect(isPng(fakePng(10, 20))).toBe(true);
    expect(pngDimensions(fakePng(640, 480))).toEqual({ width: 640, height: 480 });
    expect(isPng(new Uint8Array([1, 2, 3]))).toBe(false);
    expect(pngDimensions(new TextEncoder().encode("<svg/>"))).toBeNull();
  });
});

describe("renderPng con rasterizador inyectado", () => {
  const document = exportDataset();
  const layers = orderedLayers(document.layers).slice(0, 2);

  it("pide al rasterizador el SVG con el tamaño en píxeles, el mismo viewBox y las capas dadas", async () => {
    const rasterize = vi.fn(async (_svg: string, width: number, height: number, _background: string | null) => fakePng(width, height));
    const bytes = await renderPng({ document, layers, width: 800, height: 400, background: "#ffffff" }, rasterize);
    expect(rasterize).toHaveBeenCalledTimes(1);
    const [svg, width, height, background] = rasterize.mock.calls[0];
    expect(width).toBe(800);
    expect(height).toBe(400);
    expect(background).toBe("#ffffff");
    expect(svg).toContain('width="800" height="400" viewBox="0 0 200 100"');
    expect(svg.match(/<g /g)).toHaveLength(2);
    expect(pngDimensions(bytes)).toEqual({ width: 800, height: 400 });
  });

  it("fondo transparente: el rasterizador recibe null (no un color)", async () => {
    const rasterize = vi.fn(async (_svg: string, width: number, height: number, _background: string | null) => fakePng(width, height));
    await renderPng({ document, layers, width: 400, height: 200, background: null }, rasterize);
    expect(rasterize.mock.calls[0][3]).toBeNull();
  });

  it("rechaza lo que el rasterizador devuelva si no es un PNG", async () => {
    await expect(renderPng({ document, layers, width: 400, height: 200, background: null }, async () => new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(/PNG válida/);
  });

  it("propaga el error del rasterizador", async () => {
    await expect(renderPng({ document, layers, width: 400, height: 200, background: null }, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
  });
});
