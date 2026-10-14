import { describe, expect, it } from "vitest";
import { exportDataset, exportDatasetNoScale, IDS, MARCO_D, pathObject } from "../../../test/exportDataset";
import { objectBounds, parseEditableLayerStrict } from "../objects";
import type { EditorObject } from "../types";
import { orderedLayers, selectedLayers } from "./exportDocument";
import { buildSvg, formatNumber } from "./svgExport";

function parse(svg: string): Document {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  expect(doc.getElementsByTagName("parsererror")).toHaveLength(0);
  return doc;
}

const attr = (element: Element, name: string) => element.getAttribute(name);
const sameContent = (left: EditorObject, right: EditorObject) =>
  left.id === right.id && left.d === right.d && left.fill === right.fill && left.stroke === right.stroke && left.strokeWidth === right.strokeWidth && JSON.stringify(left.matrix) === JSON.stringify(right.matrix);

describe("buildSvg: escala y estructura", () => {
  it("con escala: width/height en mm, viewBox en unidades de documento y 1 unidad = mmPerUnit mm", () => {
    const document = exportDataset();
    const svg = parse(buildSvg(document, orderedLayers(document.layers))).documentElement;
    expect(attr(svg, "width")).toBe("100mm");
    expect(attr(svg, "height")).toBe("50mm");
    expect(attr(svg, "viewBox")).toBe("0 0 200 100");
    expect(attr(svg, "data-units")).toBe("mm");
    expect(Number(attr(svg, "data-mm-per-unit"))).toBe(0.5);
    // La escala que implican width y viewBox es la del documento.
    expect(parseFloat(attr(svg, "width") ?? "") / 200).toBeCloseTo(document.mmFactor ?? 0, 12);
    expect(parseFloat(attr(svg, "height") ?? "") / 100).toBeCloseTo(document.mmFactor ?? 0, 12);
  });

  it("un área de trabajo recortada (origen distinto de 0) conserva el viewBox y la escala física", () => {
    const document = exportDataset({ frame: { x: 10, y: 20, width: 100, height: 50 }, mmFactor: 0.25 });
    const svg = parse(buildSvg(document, orderedLayers(document.layers))).documentElement;
    expect(attr(svg, "viewBox")).toBe("10 20 100 50");
    expect(attr(svg, "width")).toBe("25mm");
    expect(attr(svg, "height")).toBe("12.5mm");
  });

  it("sin escala física: width/height SIN unidad, marcado como «none» y con un <desc> que lo avisa (nunca inventa mm)", () => {
    const document = exportDatasetNoScale();
    const doc = parse(buildSvg(document, orderedLayers(document.layers)));
    const svg = doc.documentElement;
    expect(attr(svg, "width")).toBe("200");
    expect(attr(svg, "height")).toBe("100");
    expect(attr(svg, "width")).not.toMatch(/mm|px|cm|in/);
    expect(attr(svg, "data-units")).toBe("none");
    expect(attr(svg, "data-mm-per-unit")).toBeNull();
    expect(doc.getElementsByTagName("desc")[0]?.textContent).toMatch(/Sin escala física/);
  });

  it("un <g> por capa, en orden de pintado, con id, nombre, operación y color", () => {
    const document = exportDataset();
    const doc = parse(buildSvg(document, orderedLayers(document.layers)));
    const groups = Array.from(doc.documentElement.children).filter((child) => child.tagName === "g");
    expect(groups.map((group) => attr(group, "data-layer-id"))).toEqual([IDS.rojo, IDS.grabado, IDS.ignorada, IDS.oculta, IDS.sinop]);
    expect(groups.map((group) => attr(group, "data-operation"))).toEqual(["cut", "engrave", "ignore", "cut", "unassigned"]);
    expect(groups.map((group) => attr(group, "data-name"))).toEqual(["Rojo", "Grabado", "Ignorada", "Oculta", "Ñandú Ánimo"]);
    expect(groups.map((group) => attr(group, "id"))).toEqual(["layer-1", "layer-2", "layer-3", "layer-4", "layer-5"]);
    expect(attr(groups[0], "data-color")).toBe("#ff0000");
    expect(groups[0].getElementsByTagName("path")).toHaveLength(2);
    expect(groups[1].getElementsByTagName("path")).toHaveLength(1);
  });

  it("export parcial: solo las capas elegidas, y los ids de capa no cambian con la selección", () => {
    const document = exportDataset();
    const layers = selectedLayers(document, new Set([IDS.grabado, IDS.sinop]));
    const doc = parse(buildSvg(document, layers));
    const groups = Array.from(doc.getElementsByTagName("g"));
    expect(groups.map((group) => attr(group, "data-layer-id"))).toEqual([IDS.grabado, IDS.sinop]);
    expect(groups.map((group) => attr(group, "id"))).toEqual(["layer-2", "layer-5"]);
    expect(doc.getElementsByTagName("path")).toHaveLength(2);
    expect(buildSvg(document, [])).toContain("</svg>");
    expect(parse(buildSvg(document, [])).getElementsByTagName("g")).toHaveLength(0);
  });

  it("escapa XML en nombres de capa y de proyecto", () => {
    const base = exportDataset();
    const document = exportDataset({
      projectName: 'A&B <"x">',
      layers: base.layers.map((layer) => (layer.groupId === IDS.rojo ? { ...layer, name: 'Rojo & "Azul" <1>' } : layer)),
    });
    const doc = parse(buildSvg(document, orderedLayers(document.layers)));
    expect(doc.getElementsByTagName("title")[0].textContent).toBe('A&B <"x">');
    expect(attr(doc.getElementsByTagName("g")[0], "data-name")).toBe('Rojo & "Azul" <1>');
  });

  it("pixelSize: el tamaño de salida pasa a píxeles pero el viewBox y las capas no cambian", () => {
    const document = exportDataset();
    const svg = parse(buildSvg(document, orderedLayers(document.layers), { pixelSize: { width: 800, height: 400 } })).documentElement;
    expect(attr(svg, "width")).toBe("800");
    expect(attr(svg, "height")).toBe("400");
    expect(attr(svg, "viewBox")).toBe("0 0 200 100");
  });

  it("formatNumber: recorta decimales y no escribe -0 ni NaN", () => {
    expect(formatNumber(12.5)).toBe("12.5");
    expect(formatNumber(0.1 + 0.2)).toBe("0.3");
    expect(formatNumber(-0)).toBe("0");
    expect(formatNumber(Number.NaN)).toBe("0");
    expect(formatNumber(1 / 3)).toBe("0.333333");
  });
});

describe("buildSvg: huecos y reapertura con el parser del editor", () => {
  it("los huecos se conservan: el path de «marco» sale con sus dos subpaths tal cual", () => {
    const document = exportDataset();
    const doc = parse(buildSvg(document, orderedLayers(document.layers)));
    const marco = Array.from(doc.getElementsByTagName("path")).find((path) => attr(path, "data-vid") === "marco");
    expect(attr(marco as Element, "d")).toBe(MARCO_D);
    expect((attr(marco as Element, "d") ?? "").match(/M/g)).toHaveLength(2);
  });

  it("reabrir el SVG exportado con parseEditableLayer da la MISMA geometría (d, relleno, trazo, matriz y bbox) en todas las capas", () => {
    const document = exportDataset();
    const layers = orderedLayers(document.layers);
    const reopened = parseEditableLayerStrict(buildSvg(document, layers), "doc", "#000000");
    const original = layers.flatMap((layer) => document.objectsByLayer[layer.groupId]);
    expect(reopened).not.toBeNull();
    expect(reopened).toHaveLength(original.length);
    reopened?.forEach((object, index) => {
      expect(sameContent(object, original[index]), object.id).toBe(true);
      expect(objectBounds(object)).toEqual(objectBounds(original[index]));
    });
    // El transform del disco sobrevivió y la línea conserva su trazo.
    expect(reopened?.find((object) => object.id === "disco")?.matrix.e).toBe(5);
    expect(reopened?.find((object) => object.id === "linea")).toMatchObject({ fill: "none", stroke: "#00aa00", strokeWidth: 0.5 });
  });

  it("reabrir un SVG por layer devuelve solo los objetos de esa layer", () => {
    const document = exportDataset();
    for (const layer of orderedLayers(document.layers)) {
      const reopened = parseEditableLayerStrict(buildSvg(document, [layer]), layer.groupId, "#000000") ?? [];
      const original = document.objectsByLayer[layer.groupId];
      expect(reopened.map((object) => object.id)).toEqual(original.map((object) => object.id));
      reopened.forEach((object, index) => expect(sameContent(object, original[index])).toBe(true));
    }
  });

  it("los SVG por layer comparten viewBox, tamaño y escala con el del documento (se superponen exactamente)", () => {
    const document = exportDataset();
    const whole = parse(buildSvg(document, orderedLayers(document.layers))).documentElement;
    for (const layer of document.layers) {
      const single = parse(buildSvg(document, [layer])).documentElement;
      for (const name of ["viewBox", "width", "height", "data-units", "data-mm-per-unit"]) expect(attr(single, name), name).toBe(attr(whole, name));
      expect(single.getElementsByTagName("g")).toHaveLength(1);
    }
  });

  it("coordenadas con decimales y matrices con rotación hacen round-trip exacto", () => {
    const base = exportDataset();
    const rotated = pathObject("rot", IDS.rojo, "M0.1 0.2 C 10.123456789 5 20 5 30.5 0.25 Z", {
      matrix: { a: 0.7071067811865476, b: 0.7071067811865475, c: -0.7071067811865475, d: 0.7071067811865476, e: 12.3456789012, f: -4.5 },
    });
    const document = exportDataset({ objectsByLayer: { ...base.objectsByLayer, [IDS.rojo]: [rotated] } });
    const reopened = parseEditableLayerStrict(buildSvg(document, [document.layers[0]]), "x", "#000") ?? [];
    expect(reopened).toHaveLength(1);
    expect(sameContent(reopened[0], rotated)).toBe(true);
  });

  it("una capa sin objetos exporta su <g> vacío y el documento sigue siendo válido", () => {
    const base = exportDataset();
    const document = exportDataset({ objectsByLayer: { ...base.objectsByLayer, [IDS.rojo]: [] } });
    const doc = parse(buildSvg(document, [document.layers[0]]));
    expect(doc.getElementsByTagName("g")).toHaveLength(1);
    expect(doc.getElementsByTagName("path")).toHaveLength(0);
  });
});
