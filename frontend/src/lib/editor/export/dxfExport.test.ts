import { describe, expect, it } from "vitest";
import { exportDataset, exportDatasetNoScale, IDS, layer, pathObject } from "../../../test/exportDataset";
import { readDxf, type DxfVertex } from "../../../test/exportReaders";
import { parsePathData } from "../pathGeometry";
import type { Point } from "../types";
import { assembleDxf, buildDxf, DXF_FLATNESS_MM, dxfLayerBody, flattenForExport, objectToDxfPolylines, planDxfLayers } from "./dxfExport";
import { orderedLayers, selectedLayers, type ExportDocument } from "./exportDocument";

const xy = (vertices: DxfVertex[]) => vertices.map((vertex) => [vertex.x, vertex.y]);

function distanceToPolyline(point: Point, vertices: readonly DxfVertex[]): number {
  let best = Infinity;
  for (let index = 0; index < vertices.length - 1; index += 1) {
    const a = vertices[index];
    const b = vertices[index + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = dx * dx + dy * dy;
    const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length));
    best = Math.min(best, Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy)));
  }
  return best;
}

/** Documento de una sola capa en mm 1:1 (1 unidad = 1 mm) con el marco 0 0 w h. */
function singleLayerDocument(d: string, matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, size = { width: 20, height: 20 }): ExportDocument {
  return {
    projectName: "p",
    frame: { x: 0, y: 0, ...size },
    mmFactor: 1,
    layers: [layer("l", { name: "L" })],
    objectsByLayer: { l: [pathObject("o", "l", d, { matrix })] },
  };
}

describe("buildDxf: estructura (R12, ASCII)", () => {
  const document = exportDataset();
  const build = buildDxf(document, orderedLayers(document.layers));
  const dxf = readDxf(build.text);

  it("secciones HEADER / TABLES / ENTITIES balanceadas, terminadas en EOF, y el parser mínimo lo lee entero", () => {
    expect(dxf.sections).toEqual(["HEADER", "TABLES", "ENTITIES"]);
    expect(dxf.hasEof).toBe(true);
    expect(build.text.endsWith("  0\r\nEOF\r\n")).toBe(true);
  });

  it("versión AC1009 y $INSUNITS = 4 (milímetros) cuando el documento tiene escala", () => {
    expect(dxf.header["$ACADVER"]).toEqual(["1:AC1009"]);
    expect(dxf.header["$INSUNITS"]).toEqual(["70:4"]);
  });

  it("sin escala: $INSUNITS = 0 (sin unidades), nunca 4", () => {
    const noScale = readDxf(buildDxf(exportDatasetNoScale(), orderedLayers(exportDatasetNoScale().layers)).text);
    expect(noScale.header["$INSUNITS"]).toEqual(["70:0"]);
  });

  it("solo usa POLYLINE / VERTEX / SEQEND (ninguna otra entidad)", () => {
    expect(dxf.otherEntities).toEqual([]);
    expect(build.text).not.toMatch(/LWPOLYLINE|SPLINE|ARC|CIRCLE|HATCH|TEXT|INSERT/);
  });

  it("es ASCII puro con saltos CRLF y cada par código/valor en su línea", () => {
    expect(Array.from(build.text).every((character) => character.charCodeAt(0) < 128)).toBe(true);
    const lines = build.text.split("\r\n");
    expect(lines.pop()).toBe("");
    expect(lines.length % 2).toBe(0);
  });

  it("una capa DXF por capa del editor (más la «0»), con nombres saneados y únicos", () => {
    expect(dxf.layerTable).toEqual(["0", "ROJO", "GRABADO", "IGNORADA", "OCULTA", "NANDU-ANIMO"]);
    expect(build.layerNames).toEqual({ [IDS.rojo]: "ROJO", [IDS.grabado]: "GRABADO", [IDS.ignorada]: "IGNORADA", [IDS.oculta]: "OCULTA", [IDS.sinop]: "NANDU-ANIMO" });
    expect(new Set(dxf.polylines.map((polyline) => polyline.layer))).toEqual(new Set(["ROJO", "GRABADO", "IGNORADA", "OCULTA", "NANDU-ANIMO"]));
    for (const name of dxf.layerTable) expect(name).toMatch(/^[A-Z0-9_$-]{1,31}$/);
  });

  it("es determinista: el mismo documento da exactamente el mismo texto", () => {
    expect(buildDxf(document, orderedLayers(document.layers)).text).toBe(build.text);
  });

  it("los extremos de la cabecera ($EXTMIN/$EXTMAX) son los de las coordenadas escritas", () => {
    const vertices = dxf.polylines.flatMap((polyline) => polyline.vertices);
    const min = dxf.header["$EXTMIN"].map((item) => Number(item.split(":")[1]));
    const max = dxf.header["$EXTMAX"].map((item) => Number(item.split(":")[1]));
    expect(min.slice(0, 2)).toEqual([Math.min(...vertices.map((v) => v.x)), Math.min(...vertices.map((v) => v.y))]);
    expect(max.slice(0, 2)).toEqual([Math.max(...vertices.map((v) => v.x)), Math.max(...vertices.map((v) => v.y))]);
  });

  it("sin capas: DXF válido y vacío", () => {
    const empty = readDxf(buildDxf(document, []).text);
    expect(empty.polylines).toEqual([]);
    expect(empty.layerTable).toEqual(["0"]);
    expect(empty.hasEof).toBe(true);
  });
});

describe("buildDxf: coordenadas en mm con Y invertido", () => {
  const document = exportDataset();
  const dxf = readDxf(buildDxf(document, orderedLayers(document.layers)).text);
  const of = (layerName: string) => dxf.polylines.filter((polyline) => polyline.layer === layerName);

  it("x' = x · mm/u y y' = alto − y (alto = 100 u = 50 mm): el cuadrado 10..90 x 10..60 queda en 5..45 x 20..45", () => {
    const [outer] = of("ROJO");
    expect(xy(outer.vertices)).toEqual([
      [5, 45],
      [45, 45],
      [45, 20],
      [5, 20],
    ]);
    expect(outer.vertices.every((vertex) => vertex.z === 0)).toBe(true);
  });

  it("la capa inferior del SVG (y grande) queda ARRIBA en Y del DXF respecto de la superior", () => {
    const [outer] = of("ROJO");
    const topInSvg = outer.vertices.find((vertex) => vertex.x === 5 && vertex.y === 45);
    const bottomInSvg = outer.vertices.find((vertex) => vertex.x === 5 && vertex.y === 20);
    expect(topInSvg).toBeDefined();
    expect(bottomInSvg).toBeDefined();
    expect((topInSvg as DxfVertex).y).toBeGreaterThan((bottomInSvg as DxfVertex).y); // y=10 del SVG (arriba) => mayor Y en DXF
  });

  it("cerrado vs. abierto: los contornos con Z llevan el flag 1; la línea sin Z queda abierta con sus 2 vértices", () => {
    expect(of("ROJO").map((polyline) => polyline.closed)).toEqual([true, true, true]);
    const [line] = of("GRABADO");
    expect(line.closed).toBe(false);
    expect(xy(line.vertices)).toEqual([
      [10, 10],
      [90, 10],
    ]);
  });

  it("los huecos son polilíneas adicionales con su geometría: «marco» = contorno exterior + hueco", () => {
    const [outer, hole, disc] = of("ROJO");
    expect(xy(hole.vertices)).toEqual([
      [15, 40],
      [15, 25],
      [35, 25],
      [35, 40],
    ]);
    expect(outer.vertices).toHaveLength(4);
    // El disco es el tercer contorno (otro objeto).
    expect(disc.vertices.length).toBeGreaterThan(8);
    // El hueco está dentro del exterior.
    expect(hole.vertices.every((v) => v.x > 5 && v.x < 45 && v.y > 20 && v.y < 45)).toBe(true);
  });

  it("el transform del objeto se aplica: el disco con translate(5 5) está centrado en (175, 35) u = (87.5, 32.5) mm y su radio es 10 mm", () => {
    const disc = of("ROJO")[2];
    for (const vertex of disc.vertices) {
      expect(Math.hypot(vertex.x - 87.5, vertex.y - 32.5)).toBeGreaterThan(10 - 0.003);
      expect(Math.hypot(vertex.x - 87.5, vertex.y - 32.5)).toBeLessThan(10 + 0.003);
    }
  });

  it("curvas aplanadas DENTRO de la tolerancia: ningún punto del círculo real queda a más de DXF_FLATNESS_MM de la polilínea", () => {
    const disc = of("ROJO")[2];
    const closedRing = [...disc.vertices, disc.vertices[0]];
    let worst = 0;
    for (let step = 0; step < 720; step += 1) {
      const angle = (step / 720) * 2 * Math.PI;
      worst = Math.max(worst, distanceToPolyline({ x: 87.5 + 10 * Math.cos(angle), y: 32.5 + 10 * Math.sin(angle) }, closedRing));
    }
    // Tolerancia de aplanado + error de aproximar el círculo con cúbicas (≈ 0,03 % del radio).
    expect(worst).toBeLessThanOrEqual(DXF_FLATNESS_MM + 0.003);
    expect(disc.vertices.length).toBeGreaterThan(24); // sí hubo subdivisión: no es un octógono
  });

  it("el contorno cerrado por Z no repite el primer vértice al final (el flag ya lo cierra)", () => {
    for (const polyline of of("ROJO")) {
      const first = polyline.vertices[0];
      const last = polyline.vertices[polyline.vertices.length - 1];
      expect(first.x === last.x && first.y === last.y).toBe(false);
    }
  });
});

describe("aplanado de cúbicas", () => {
  it("el error máximo respecto de la curva exacta es ≤ la tolerancia pedida, para varias tolerancias y curvas", () => {
    const curves = ["M0 0 C0 50 100 50 100 0", "M0 0 C100 0 0 100 100 100", "M10 10 C200 -100 -100 200 150 10"];
    for (const flatness of [0.5, 0.05, DXF_FLATNESS_MM, 0.002]) {
      for (const d of curves) {
        const segment = parsePathData(d).segments;
        const [polyline] = flattenForExport(segment, flatness);
        const start = segment[0] as { x: number; y: number };
        const cubic = segment[1] as { x1: number; y1: number; x2: number; y2: number; x: number; y: number };
        const vertices = polyline.points.map((point) => ({ x: point.x, y: point.y, z: 0 }));
        let worst = 0;
        for (let step = 0; step <= 2000; step += 1) {
          const t = step / 2000;
          const mt = 1 - t;
          const x = mt ** 3 * start.x + 3 * mt * mt * t * cubic.x1 + 3 * mt * t * t * cubic.x2 + t ** 3 * cubic.x;
          const y = mt ** 3 * start.y + 3 * mt * mt * t * cubic.y1 + 3 * mt * t * t * cubic.y2 + t ** 3 * cubic.y;
          worst = Math.max(worst, distanceToPolyline({ x, y }, vertices));
        }
        expect(worst, `${d} @ ${flatness}`).toBeLessThanOrEqual(flatness);
      }
    }
  });

  it("segmentos rectos no se subdividen, Z cierra y un M nuevo abre otro subpath", () => {
    const result = flattenForExport(parsePathData("M0 0 L10 0 L10 10 Z M20 20 L30 20").segments, 0.01);
    expect(result.map((polyline) => [polyline.points.length, polyline.closed])).toEqual([
      [3, true],
      [2, false],
    ]);
  });
});

describe("objectToDxfPolylines y casos límite", () => {
  it("rotación 90° de la matriz: (x,y) -> (−y, x), con Y invertido y 1 u = 1 mm", () => {
    const rotated = singleLayerDocument("M0 0 H10 V5 H0 Z", { a: 0, b: 1, c: -1, d: 0, e: 0, f: 0 });
    const dxf = readDxf(buildDxf(rotated, rotated.layers).text);
    expect(xy(dxf.polylines[0].vertices)).toEqual([
      [0, 20],
      [0, 10],
      [-5, 10],
      [-5, 20],
    ]);
  });

  it("el origen es la esquina inferior-izquierda del MARCO: un marco recortado con origen (10, 20) y alto 50 coloca (10, 70) en (0, 0)", () => {
    const base = singleLayerDocument("M10 70 L30 70", undefined, { width: 100, height: 50 });
    const document: ExportDocument = { ...base, frame: { x: 10, y: 20, width: 100, height: 50 } };
    const dxf = readDxf(buildDxf(document, document.layers).text);
    expect(xy(dxf.polylines[0].vertices)).toEqual([
      [0, 0],
      [20, 0],
    ]);
  });

  it("con otra escala (0,25 mm/u) los números salen en mm", () => {
    const base = singleLayerDocument("M0 0 L40 0");
    const document: ExportDocument = { ...base, mmFactor: 0.25 };
    expect(xy(readDxf(buildDxf(document, document.layers).text).polylines[0].vertices)).toEqual([
      [0, 5],
      [10, 5],
    ]);
  });

  it("sin escala los números salen en unidades de documento (factor 1)", () => {
    const base = singleLayerDocument("M0 0 L40 0");
    const document: ExportDocument = { ...base, mmFactor: null };
    expect(xy(readDxf(buildDxf(document, document.layers).text).polylines[0].vertices)).toEqual([
      [0, 20],
      [40, 20],
    ]);
  });

  it("descarta vértices repetidos, un «cerrado» de 2 vértices queda abierto y un M suelto no genera nada", () => {
    const document = singleLayerDocument("M0 0 L10 0 L10 0 L10 10 Z M0 5 L10 5 Z M3 3");
    const dxf = readDxf(buildDxf(document, document.layers).text);
    expect(dxf.polylines).toHaveLength(2);
    expect(dxf.polylines[0].closed).toBe(true);
    expect(dxf.polylines[0].vertices).toHaveLength(3);
    expect(dxf.polylines[1].closed).toBe(false);
    expect(dxf.polylines[1].vertices).toHaveLength(2);
  });

  it("un path con error de sintaxis exporta lo legible y lo avisa; una matriz no finita se omite y se avisa", () => {
    const base = singleLayerDocument("M0 0 L10 0 X");
    const partialBuild = buildDxf(base, base.layers);
    expect(readDxf(partialBuild.text).polylines).toHaveLength(1);
    expect(partialBuild.warnings).toEqual(["1 objeto con un path ilegible se exportó solo hasta donde se pudo leer."]);

    const broken = singleLayerDocument("M0 0 L10 0", { a: Number.NaN, b: 0, c: 0, d: 1, e: 0, f: 0 });
    const brokenBuild = buildDxf(broken, broken.layers);
    expect(readDxf(brokenBuild.text).polylines).toEqual([]);
    expect(brokenBuild.warnings).toEqual(["1 objeto con una transformación inválida se omitió del DXF."]);
    expect(objectToDxfPolylines(broken.objectsByLayer.l[0], broken)).toBeNull();
  });

  it("nombres de capa DXF que colisionan reciben sufijo y siguen siendo ≤ 31 caracteres", () => {
    const plans = planDxfLayers([layer("1", { name: "Rojo" }), layer("2", { name: "ROJO" }), layer("3", { name: "r".repeat(80) }), layer("4", { name: "r".repeat(80) })]);
    expect(plans.map((plan) => plan.dxfName)).toEqual(["ROJO", "ROJO-2", "R".repeat(31), `${"R".repeat(29)}-2`]);
  });
});

describe("export parcial y por layer", () => {
  const document = exportDataset();

  it("solo las capas elegidas entran al DXF (cabecera y entidades)", () => {
    const layers = selectedLayers(document, new Set([IDS.grabado]));
    const dxf = readDxf(buildDxf(document, layers).text);
    expect(dxf.layerTable).toEqual(["0", "GRABADO"]);
    expect(dxf.polylines.map((polyline) => polyline.layer)).toEqual(["GRABADO"]);
  });

  it("un DXF por layer usa el MISMO sistema de coordenadas que el documento completo (se superponen)", () => {
    const whole = readDxf(buildDxf(document, orderedLayers(document.layers)).text);
    for (const item of orderedLayers(document.layers)) {
      const single = readDxf(buildDxf(document, [item]).text);
      const name = single.polylines[0].layer;
      const expected = whole.polylines.filter((polyline) => polyline.layer === name);
      expect(single.polylines.map((polyline) => xy(polyline.vertices))).toEqual(expected.map((polyline) => xy(polyline.vertices)));
    }
  });

  it("dxfLayerBody y assembleDxf (la ruta por layer del orquestador) producen lo mismo que buildDxf", () => {
    const layers = orderedLayers(document.layers);
    const plans = planDxfLayers(layers);
    const bodies = plans.map((plan) => dxfLayerBody(document, plan));
    expect(assembleDxf(plans, bodies, true)).toBe(buildDxf(document, layers).text);
    expect(bodies[0].polylines).toBe(3);
    expect(bodies[0].vertices).toBeGreaterThan(8);
  });
});
