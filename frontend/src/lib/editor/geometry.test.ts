import { describe, expect, it } from "vitest";
import type { BooleanRequest, BooleanResponse, GeometryPiece } from "../../types/geometry";
import { IDENTITY_MATRIX } from "../svgTransform";
import {
  DEFAULT_FLATNESS_MM,
  fromDocumentUnits,
  geometryErrorMessage,
  matrixScale,
  objectGeometry,
  pieceToPathData,
  toDocumentUnits,
  unitScale,
  validateBooleanResponse,
} from "./geometry";
import type { EditorObject } from "./types";

function object(d: string, overrides: Partial<EditorObject> = {}): EditorObject {
  return { id: "o1", layerGroupId: "A", d, fill: "#ff0000", matrix: IDENTITY_MATRIX, ...overrides };
}

describe("unidades", () => {
  it("sin escala física se trabaja en unidades (u) sin convertir; con escala, en mm", () => {
    expect(unitScale(null)).toEqual({ factor: 1, label: "u" });
    expect(unitScale(Number.NaN)).toEqual({ factor: 1, label: "u" });
    expect(unitScale(0)).toEqual({ factor: 1, label: "u" });
    expect(unitScale(-2)).toEqual({ factor: 1, label: "u" });
    expect(unitScale(0.5)).toEqual({ factor: 0.5, label: "mm" });
  });

  it("mm <-> unidades de documento con el factor del documento (0,5 mm por unidad: 0,01 mm = 0,02 u)", () => {
    const scale = unitScale(0.5);
    expect(toDocumentUnits(DEFAULT_FLATNESS_MM, scale)).toBeCloseTo(0.02, 12);
    expect(fromDocumentUnits(2, scale)).toBe(1);
    expect(toDocumentUnits(1, unitScale(null))).toBe(1);
  });

  it("matrixScale: identidad 1, escala uniforme 2, rotación 1, no uniforme 2x8 = 4, reflejo conserva el módulo", () => {
    expect(matrixScale(IDENTITY_MATRIX)).toBe(1);
    expect(matrixScale({ a: 2, b: 0, c: 0, d: 2, e: 9, f: 9 })).toBe(2);
    expect(matrixScale({ a: 0, b: 1, c: -1, d: 0, e: 0, f: 0 })).toBe(1);
    expect(matrixScale({ a: 2, b: 0, c: 0, d: 8, e: 0, f: 0 })).toBe(4);
    expect(matrixScale({ a: -3, b: 0, c: 0, d: 3, e: 0, f: 0 })).toBe(3);
  });
});

describe("objectGeometry: objeto -> subjects en unidades de documento", () => {
  it("un objeto con relleno es UN polígono con todos sus subpaths como anillos (huecos incluidos)", () => {
    const geometry = objectGeometry(object("M0 0 H40 V40 H0 Z M10 10 H20 V20 H10 Z"), 0.01);
    expect(geometry).toEqual({
      kind: "polygon",
      subjects: [
        {
          type: "polygon",
          coordinates: [
            [[0, 0], [40, 0], [40, 40], [0, 40]],
            [[10, 10], [20, 10], [20, 20], [10, 20]],
          ],
        },
      ],
      vertexCount: 8,
    });
  });

  it("hornea la matriz: el subject está en espacio de DOCUMENTO", () => {
    const geometry = objectGeometry(object("M0 0 H10 V10 H0 Z", { matrix: { a: 2, b: 0, c: 0, d: 2, e: 100, f: 50 } }), 0.01);
    expect(geometry?.subjects[0]).toEqual({ type: "polygon", coordinates: [[[100, 50], [120, 50], [120, 70], [100, 70]]] });
  });

  it("un objeto SIN relleno es una polilínea por subpath; un contorno cerrado repite su primer vértice", () => {
    const open = objectGeometry(object("M0 0 L10 0 L10 10", { fill: "none", stroke: "#000000", strokeWidth: 0.1 }), 0.01);
    expect(open).toEqual({ kind: "line", subjects: [{ type: "line", coordinates: [[0, 0], [10, 0], [10, 10]] }], vertexCount: 3 });

    const closed = objectGeometry(object("M0 0 H10 V10 Z", { fill: "none" }), 0.01);
    expect(closed?.subjects).toEqual([{ type: "line", coordinates: [[0, 0], [10, 0], [10, 10], [0, 0]] }]);

    const two = objectGeometry(object("M0 0 L5 0 M20 0 L25 0", { fill: "none" }), 0.01);
    expect(two?.subjects).toHaveLength(2);
    expect(two?.vertexCount).toBe(4);
  });

  it("`transparent` también cuenta como sin relleno", () => {
    expect(objectGeometry(object("M0 0 L10 0", { fill: "transparent" }), 0.01)?.kind).toBe("line");
  });

  it("aplana las curvas con la tolerancia pedida: más fina = más vértices, y todos sobre el arco (radio 10 ± 0,01)", () => {
    const quarter = object("M10 0 C10 5.5228475 5.5228475 10 0 10 L0 0 Z");
    const coarse = objectGeometry(quarter, 1);
    const fine = objectGeometry(quarter, 0.01);
    expect(fine!.vertexCount).toBeGreaterThan(coarse!.vertexCount);
    const arc = (fine!.subjects[0] as { coordinates: Array<Array<[number, number]>> }).coordinates[0].filter(([x, y]) => x > 0 && y > 0);
    expect(arc.length).toBeGreaterThan(5);
    for (const [x, y] of arc) expect(Math.hypot(x, y)).toBeGreaterThan(9.99);
    for (const [x, y] of arc) expect(Math.hypot(x, y)).toBeLessThan(10.01);
  });

  it("devuelve null si no se puede enviar de forma segura (path ilegible, vacío, degenerado, matriz o tolerancia inválidas)", () => {
    expect(objectGeometry(object("M0 0 L"), 0.01)).toBeNull();
    expect(objectGeometry(object(""), 0.01)).toBeNull();
    expect(objectGeometry(object("M0 0 L10 0"), 0.01)).toBeNull(); // relleno de solo 2 puntos: no es un anillo
    expect(objectGeometry(object("M0 0 H10 V10 Z", { matrix: { a: Number.NaN, b: 0, c: 0, d: 1, e: 0, f: 0 } }), 0.01)).toBeNull();
    expect(objectGeometry(object("M0 0 H10 V10 Z"), 0)).toBeNull();
    expect(objectGeometry(object("M0 0 H10 V10 Z"), Number.NaN)).toBeNull();
  });
});

describe("pieceToPathData: pieza del servidor -> d", () => {
  it("un polígono con hueco escribe cada anillo como subpath cerrado (sin repetir el vértice de cierre)", () => {
    const piece: GeometryPiece = { type: "polygon", coordinates: [[[0, 0], [40, 0], [40, 40], [0, 40], [0, 0]], [[10, 10], [10, 20], [20, 20], [20, 10], [10, 10]]] };
    expect(pieceToPathData(piece)).toBe("M0 0 L40 0 L40 40 L0 40 Z M10 10 L10 20 L20 20 L20 10 Z");
  });

  it("acepta un anillo sin el vértice de cierre y una polilínea abierta (sin Z)", () => {
    expect(pieceToPathData({ type: "polygon", coordinates: [[[0, 0], [10, 0], [0, 10]]] })).toBe("M0 0 L10 0 L0 10 Z");
    expect(pieceToPathData({ type: "line", coordinates: [[0, 0], [10, 5], [20, 0]] })).toBe("M0 0 L10 5 L20 0");
  });

  it("rechaza anillos de menos de 3 vértices, polilíneas de 1 punto, sin anillos y coordenadas no finitas (NUNCA las escribe como 0)", () => {
    expect(pieceToPathData({ type: "polygon", coordinates: [[[0, 0], [1, 1], [0, 0]]] })).toBeNull();
    expect(pieceToPathData({ type: "polygon", coordinates: [] })).toBeNull();
    expect(pieceToPathData({ type: "line", coordinates: [[0, 0]] })).toBeNull();
    expect(pieceToPathData({ type: "line", coordinates: [[0, 0], [Number.NaN, 5]] })).toBeNull();
    expect(pieceToPathData({ type: "polygon", coordinates: [[[0, 0], [Number.POSITIVE_INFINITY, 0], [0, 10], [0, 0]]] })).toBeNull();
  });
});

describe("validateBooleanResponse", () => {
  const square = (x: number): GeometryPiece => ({ type: "polygon", coordinates: [[[x, 0], [x + 1, 0], [x + 1, 1], [x, 1], [x, 0]]] });
  const request: BooleanRequest = {
    operation: "difference",
    subjects: [
      { type: "polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] },
      { type: "line", coordinates: [[0, 0], [5, 0]] },
    ],
    operands: [{ type: "bufferedLine", points: [[0, 0]], radius: 1 }],
    tolerance: 0.01,
  };
  const valid = (): BooleanResponse => ({
    operation: "difference",
    scope: "per_subject",
    tolerance: 0.01,
    pieceCount: 2,
    results: [
      { subjectIndex: 0, changed: true, geometries: [square(0)] },
      { subjectIndex: 1, changed: true, geometries: [{ type: "line", coordinates: [[0, 0], [1, 0]] }] },
    ],
  });

  it("acepta una respuesta coherente con la petición", () => {
    expect(validateBooleanResponse(request, valid())).toBeNull();
  });

  it("intersection_all (M3-S08) es COMBINADA: una sola entrada con subjectIndex null, aunque haya varios subjects", () => {
    const common: BooleanRequest = { operation: "intersection_all", subjects: request.subjects.slice(0, 1).concat(request.subjects.slice(0, 1)), operands: [], tolerance: 0.01 };
    const combined: BooleanResponse = { operation: "intersection_all", scope: "combined", tolerance: 0.01, pieceCount: 1, results: [{ subjectIndex: null, changed: true, geometries: [square(0)] }] };

    expect(validateBooleanResponse(common, combined)).toBeNull();
    // Si el servidor contestara por subject (como "intersection"), el cliente lo rechaza.
    const perSubject: BooleanResponse = { ...combined, results: [{ subjectIndex: 0, changed: true, geometries: [] }, { subjectIndex: 1, changed: true, geometries: [] }] };
    expect(validateBooleanResponse(common, perSubject)).toMatch(/2 resultados y se esperaban 1/);
    // Y "intersection" de S04 sigue siendo por subject.
    const legacy: BooleanRequest = { ...common, operation: "intersection", operands: [{ type: "polygon", coordinates: [[[0, 0], [1, 0], [1, 1]]] }] };
    expect(validateBooleanResponse(legacy, { ...perSubject, operation: "intersection", scope: "per_subject" })).toBeNull();
  });

  it("acepta resultados vacíos (el subject desaparece)", () => {
    const response = valid();
    response.results[0].geometries = [];
    expect(validateBooleanResponse(request, response)).toBeNull();
  });

  it("rechaza una respuesta de otra operación, con otra cantidad de resultados o con un subjectIndex que no corresponde", () => {
    expect(validateBooleanResponse(request, { ...valid(), operation: "union" })).toMatch(/otra operación/);
    expect(validateBooleanResponse(request, { ...valid(), results: valid().results.slice(0, 1) })).toMatch(/1 resultados y se esperaban 2/);
    const wrongIndex = valid();
    wrongIndex.results[1].subjectIndex = 0;
    expect(validateBooleanResponse(request, wrongIndex)).toMatch(/no corresponde a su subject/);
  });

  it("rechaza piezas del tipo equivocado: un polígono para una línea y una línea para un polígono", () => {
    const polygonForLine = valid();
    polygonForLine.results[1].geometries = [square(0)];
    expect(validateBooleanResponse(request, polygonForLine)).toMatch(/solo admite «line»/);
    const lineForPolygon = valid();
    lineForPolygon.results[0].geometries = [{ type: "line", coordinates: [[0, 0], [1, 1]] }];
    expect(validateBooleanResponse(request, lineForPolygon)).toMatch(/solo admite «polygon»/);
  });

  it("rechaza anillos abiertos, anillos de menos de 3 vértices, polilíneas cortas y coordenadas no finitas", () => {
    const open = valid();
    open.results[0].geometries = [{ type: "polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] }];
    expect(validateBooleanResponse(request, open)).toMatch(/no está cerrado/);

    const tiny = valid();
    tiny.results[0].geometries = [{ type: "polygon", coordinates: [[[0, 0], [1, 0], [0, 0]]] }];
    expect(validateBooleanResponse(request, tiny)).toMatch(/menos de 3 vértices/);

    const short = valid();
    short.results[1].geometries = [{ type: "line", coordinates: [[0, 0]] }];
    expect(validateBooleanResponse(request, short)).toMatch(/menos de 2 vértices/);

    const nan = valid();
    nan.results[1].geometries = [{ type: "line", coordinates: [[0, 0], [Number.NaN, 1]] }];
    expect(validateBooleanResponse(request, nan)).toMatch(/no finitas/);
  });

  it("rechaza una respuesta sin resultados o con formas inesperadas", () => {
    expect(validateBooleanResponse(request, undefined as unknown as BooleanResponse)).toMatch(/no trae resultados/);
    expect(validateBooleanResponse(request, { ...valid(), results: undefined } as unknown as BooleanResponse)).toMatch(/no trae resultados/);
    const noGeometries = valid();
    (noGeometries.results[0] as unknown as { geometries: unknown }).geometries = null;
    expect(validateBooleanResponse(request, noGeometries)).toMatch(/no trae geometrías/);
    const weird = valid();
    (weird.results[0].geometries as unknown[]) = [{ type: "circle", coordinates: [] }];
    expect(validateBooleanResponse(request, weird)).toMatch(/tipo desconocido/);
  });

  it("union/xor devuelven UN resultado combinado con subjectIndex null", () => {
    const union: BooleanRequest = { ...request, operation: "union" };
    const combined: BooleanResponse = { operation: "union", scope: "combined", tolerance: 0.01, pieceCount: 1, results: [{ subjectIndex: null, changed: true, geometries: [square(0)] }] };
    expect(validateBooleanResponse(union, combined)).toBeNull();
    expect(validateBooleanResponse(union, { ...combined, results: [{ ...combined.results[0], subjectIndex: 0 }] })).toMatch(/no corresponde a su subject/);
    expect(validateBooleanResponse(union, { ...combined, results: [...combined.results, ...combined.results] })).toMatch(/se esperaban 1/);
  });
});

describe("geometryErrorMessage", () => {
  it("siempre aclara que NO se modificó nada y distingue cancelación, red y códigos del servidor", () => {
    expect(geometryErrorMessage({ isAborted: true })).toMatch(/cancelada.*No se modificó nada/);
    expect(geometryErrorMessage({ isNetworkError: true })).toMatch(/No se pudo contactar.*No se modificó nada/);
    expect(geometryErrorMessage({ status: 503, body: { code: "engine_unavailable" } })).toMatch(/no está disponible.*No se modificó nada/);
    expect(geometryErrorMessage({ status: 504, body: { code: "timeout" } })).toMatch(/tardó demasiado.*No se modificó nada/);
    expect(geometryErrorMessage({ status: 400, body: { code: "too_many_subjects" } })).toMatch(/demasiados objetos.*modo Objeto/);
    expect(geometryErrorMessage({ status: 400, body: { code: "too_many_vertices" } })).toMatch(/demasiado grande/);
    expect(geometryErrorMessage({ status: 502, body: { code: "invalid_response" } })).toMatch(/no se puede usar/);
  });

  it("sin código conocido usa el estado HTTP, y sin nada un mensaje genérico (nunca vacío ni undefined)", () => {
    expect(geometryErrorMessage({ status: 413 })).toMatch(/demasiado grande/);
    expect(geometryErrorMessage({ status: 503 })).toMatch(/no está disponible/);
    expect(geometryErrorMessage({ status: 504 })).toMatch(/tardó demasiado/);
    expect(geometryErrorMessage({ status: 418, body: { code: "algo_nuevo" } })).toMatch(/No se modificó nada/);
    expect(geometryErrorMessage(new Error("boom"))).toMatch(/No se modificó nada/);
    expect(geometryErrorMessage(null)).toMatch(/No se modificó nada/);
    expect(geometryErrorMessage("texto")).toMatch(/No se modificó nada/);
  });
});
