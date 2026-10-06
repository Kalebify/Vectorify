import { describe, expect, it } from "vitest";
import {
  distanceToPolylines,
  flattenSegments,
  parsePathData,
  pathBounds,
  pointInPolylinesNonZero,
  segmentsToPathData,
  transformPathData,
  type PathSegment,
} from "./pathGeometry";
import { rotationAboutMatrix, scaleAboutMatrix, translationMatrix } from "./matrix";

function expectRect(actual: { x: number; y: number; width: number; height: number } | null, expected: { x: number; y: number; width: number; height: number }, digits = 9) {
  expect(actual).not.toBeNull();
  expect(actual!.x).toBeCloseTo(expected.x, digits);
  expect(actual!.y).toBeCloseTo(expected.y, digits);
  expect(actual!.width).toBeCloseTo(expected.width, digits);
  expect(actual!.height).toBeCloseTo(expected.height, digits);
}

describe("parsePathData — comandos y normalización a M/L/C/Z absolutos", () => {
  it("M L Z absolutos", () => {
    const { segments, error } = parsePathData("M0,0 L10,0 L10,5 Z");
    expect(error).toBeNull();
    expect(segments).toEqual([
      { type: "M", x: 0, y: 0 },
      { type: "L", x: 10, y: 0 },
      { type: "L", x: 10, y: 5 },
      { type: "Z" },
    ]);
  });

  it("relativos (m l h v) se resuelven contra el punto actual", () => {
    const { segments } = parsePathData("m10 10 l5 0 h-2 v3 z");
    expect(segments).toEqual([
      { type: "M", x: 10, y: 10 },
      { type: "L", x: 15, y: 10 },
      { type: "L", x: 13, y: 10 },
      { type: "L", x: 13, y: 13 },
      { type: "Z" },
    ]);
  });

  it("H y V absolutos mantienen la otra coordenada", () => {
    const { segments } = parsePathData("M2 3 H9 V8");
    expect(segments.slice(1)).toEqual([
      { type: "L", x: 9, y: 3 },
      { type: "L", x: 9, y: 8 },
    ]);
  });

  it("un moveto con más de un par trata los siguientes como lineto implícito (m -> l relativo)", () => {
    const { segments } = parsePathData("m1 1 2 0 0 2");
    expect(segments).toEqual([
      { type: "M", x: 1, y: 1 },
      { type: "L", x: 3, y: 1 },
      { type: "L", x: 3, y: 3 },
    ]);
  });

  it("repetición implícita de argumentos de curva: C con dos tripletas", () => {
    const { segments, error } = parsePathData("M0 0 C1 1 2 2 3 3 4 4 5 5 6 6");
    expect(error).toBeNull();
    expect(segments).toHaveLength(3);
    expect(segments[2]).toEqual({ type: "C", x1: 4, y1: 4, x2: 5, y2: 5, x: 6, y: 6 });
  });

  it("números pegados: signos y puntos decimales como separadores ('10-5', '1.5.5')", () => {
    const { segments, error } = parsePathData("M10-5L-3.5.5");
    expect(error).toBeNull();
    expect(segments).toEqual([
      { type: "M", x: 10, y: -5 },
      { type: "L", x: -3.5, y: 0.5 },
    ]);
  });

  it("notación científica (e/E, con signo)", () => {
    const { segments, error } = parsePathData("M1e2,2.5E-1 L-1e+1 1e0");
    expect(error).toBeNull();
    expect(segments).toEqual([
      { type: "M", x: 100, y: 0.25 },
      { type: "L", x: -10, y: 1 },
    ]);
  });

  it("separadores mixtos: comas, espacios, saltos de línea y tabs", () => {
    const { segments, error } = parsePathData("M 0 , 0\n\tL\t5,5 ,\n 6 6");
    expect(error).toBeNull();
    expect(segments).toEqual([
      { type: "M", x: 0, y: 0 },
      { type: "L", x: 5, y: 5 },
      { type: "L", x: 6, y: 6 },
    ]);
  });

  it("S refleja el segundo control de la cúbica previa; sin cúbica previa usa el punto actual", () => {
    const { segments } = parsePathData("M0 0 C0 10 10 10 10 0 S20 -10 20 0");
    // Reflejo de (10,10) respecto de (10,0) = (10,-10).
    expect(segments[2]).toEqual({ type: "C", x1: 10, y1: -10, x2: 20, y2: -10, x: 20, y: 0 });

    const noPrev = parsePathData("M5 5 S10 10 20 20").segments[1] as Extract<PathSegment, { type: "C" }>;
    expect([noPrev.x1, noPrev.y1]).toEqual([5, 5]);
  });

  it("Q se convierte a cúbica exacta (elevación de grado) y T refleja el control cuadrático", () => {
    const { segments } = parsePathData("M0 0 Q6 6 12 0 T24 0");
    const q = segments[1] as Extract<PathSegment, { type: "C" }>;
    expect(q.x1).toBeCloseTo(4, 12);
    expect(q.y1).toBeCloseTo(4, 12);
    expect(q.x2).toBeCloseTo(8, 12);
    expect(q.y2).toBeCloseTo(4, 12);
    // T: control reflejado de (6,6) respecto de (12,0) = (18,-6).
    const t = segments[2] as Extract<PathSegment, { type: "C" }>;
    expect(t.x1).toBeCloseTo(12 + (2 / 3) * (18 - 12), 12);
    expect(t.y1).toBeCloseTo((2 / 3) * -6, 12);
    expect([t.x, t.y]).toEqual([24, 0]);
  });

  it("A: semicírculo -> 2 cúbicas que terminan EXACTO en el destino", () => {
    const { segments, error } = parsePathData("M0 5 A5 5 0 0 1 10 5");
    expect(error).toBeNull();
    expect(segments.filter((s) => s.type === "C")).toHaveLength(2);
    const last = segments[segments.length - 1] as Extract<PathSegment, { type: "C" }>;
    expect([last.x, last.y]).toEqual([10, 5]);
  });

  it("A: flags de un solo carácter pegados al siguiente número ('a1 1 0 011 1')", () => {
    const { segments, error } = parsePathData("M0 0 a1 1 0 011 1");
    expect(error).toBeNull();
    const last = segments[segments.length - 1] as Extract<PathSegment, { type: "C" }>;
    expect(last.x).toBeCloseTo(1, 12);
    expect(last.y).toBeCloseTo(1, 12);
  });

  it("A: radio 0 degenera a línea recta; extremos coincidentes se omiten; radios chicos se escalan", () => {
    expect(parsePathData("M0 0 A0 5 0 0 1 10 0").segments[1]).toEqual({ type: "L", x: 10, y: 0 });
    expect(parsePathData("M3 3 A5 5 0 0 1 3 3").segments).toEqual([{ type: "M", x: 3, y: 3 }]);
    // Radio 1 no alcanza para 10 de distancia: se escala a 5; con sweep=1 (horario en pantalla) el
    // semicírculo de radio 5 abulta hacia ARRIBA (y negativo).
    expectRect(pathBounds("M0 0 A1 1 0 0 1 10 0"), { x: 0, y: -5, width: 10, height: 5 }, 6);
  });

  it("un comando de dibujo después de Z abre un subpath nuevo en el punto inicial del anterior", () => {
    const { segments } = parsePathData("M2 2 L8 2 L8 8 Z L2 9");
    expect(segments.slice(-2)).toEqual([
      { type: "M", x: 2, y: 2 },
      { type: "L", x: 2, y: 9 },
    ]);
  });

  it("mal formado: corta en el primer error, conserva lo válido y lo informa (nunca lanza)", () => {
    const noMove = parsePathData("L10 10");
    expect(noMove.error).toMatch(/moveto/);
    expect(noMove.segments).toEqual([]);

    const truncated = parsePathData("M0 0 L10 10 L5");
    expect(truncated.error).not.toBeNull();
    expect(truncated.segments).toHaveLength(2);

    expect(parsePathData("M0 0 X5 5").error).toMatch(/desconocido/);
    expect(parsePathData("M0 0 L1 1 Z 5 5").error).not.toBeNull();
    expect(parsePathData("M0 0 A1 1 0 2 0 5 5").error).not.toBeNull();
    expect(parsePathData("hola mundo").error).not.toBeNull();
  });

  it("vacío / solo espacios / no-string: sin segmentos y sin error", () => {
    expect(parsePathData("")).toEqual({ segments: [], error: null });
    expect(parsePathData("   \n ")).toEqual({ segments: [], error: null });
    expect(parsePathData(undefined as unknown as string).segments).toEqual([]);
  });
});

describe("pathBounds — bbox EXACTO (valores calculados a mano)", () => {
  it("cúbica con control fuera de la curva: el bbox NO es el de los puntos de control", () => {
    // B_y(0.5) = 3·0.25·0.5·10 + 3·0.5·0.25·10 = 7.5 (los puntos de control llegan a 10).
    expectRect(pathBounds("M0 0 C0 10 10 10 10 0"), { x: 0, y: 0, width: 10, height: 7.5 });
  });

  it("cúbica con extremo en x interior: B_x(t) = 60·t·(1-t) -> máximo 15 en t=0.5", () => {
    expectRect(pathBounds("M0 0 C20 0 20 10 0 10"), { x: 0, y: 0, width: 15, height: 10 });
  });

  it("cuadrática: el ápice es la mitad de la altura del control (Q 5,10 -> y=5)", () => {
    expectRect(pathBounds("M0 0 Q5 10 10 0"), { x: 0, y: 0, width: 10, height: 5 });
  });

  it("círculo por dos arcos: bbox = diámetro exacto", () => {
    expectRect(pathBounds("M0 5 A5 5 0 1 1 10 5 A5 5 0 1 1 0 5 Z"), { x: 0, y: 0, width: 10, height: 10 }, 9);
  });

  it("elipse rotada 90° con arco: swap de radios en el bbox", () => {
    // Semi-elipse rx=10 ry=5 rotada 90°: sus extremos son (0,0) y (0,20)-> bbox ancho 10 (ry... eje largo vertical).
    expectRect(pathBounds("M0 0 A10 5 90 0 1 0 20"), { x: 0, y: 0, width: 5, height: 20 }, 6);
  });

  it("rectángulo con matriz de rotación de 90°: (x,y)->(-y,x)", () => {
    // rect 10×5 en el origen, rotado 90° horario alrededor del origen: x' = -y, y' = x.
    expectRect(pathBounds("M0 0 H10 V5 H0 Z", rotationAboutMatrix({ x: 0, y: 0 }, 90)), { x: -5, y: 0, width: 5, height: 10 });
  });

  it("cuadrado rotado 45° alrededor de su centro: ancho = diagonal 10·√2", () => {
    const rect = pathBounds("M0 0 H10 V10 H0 Z", rotationAboutMatrix({ x: 5, y: 5 }, 45));
    const half = (10 * Math.SQRT2) / 2;
    expectRect(rect, { x: 5 - half, y: 5 - half, width: 2 * half, height: 2 * half });
  });

  it("curva rotada: el bbox es el de la curva rotada, no el bbox de su bbox", () => {
    // Cuarto de círculo de radio 10 centrado en el origen (de (10,0) a (0,10), pasa por (7.07,7.07)),
    // rotado -45°: los extremos pasan a (7.07,-7.07) y (7.07,7.07) y el punto medio a (10,0). El
    // extremo x=10 es INTERIOR a la curva (un bbox de extremos daría 7.07). Tolerancia 1e-2 en x:
    // una cúbica aproxima el círculo con ~3e-4 de error relativo (radio 10 -> 3e-3).
    const rect = pathBounds("M10 0 A10 10 0 0 1 0 10", rotationAboutMatrix({ x: 0, y: 0 }, -45))!;
    expect(rect.x + rect.width).toBeCloseTo(10, 2);
    expect(rect.x).toBeCloseTo(10 * Math.SQRT1_2, 6);
    expect(rect.y).toBeCloseTo(-10 * Math.SQRT1_2, 6);
    expect(rect.height).toBeCloseTo(20 * Math.SQRT1_2, 6);
  });

  it("escala negativa (reflejo): bbox normalizado con width/height positivos", () => {
    expectRect(pathBounds("M0 0 L10 4", scaleAboutMatrix({ x: 0, y: 0 }, -1, 1)), { x: -10, y: 0, width: 10, height: 4 });
  });

  it("subpaths múltiples: unión; un moveto suelto no cuenta", () => {
    expectRect(pathBounds("M0 0 L2 2 M10 10 L12 14 M50 50"), { x: 0, y: 0, width: 12, height: 14 });
  });

  it("degenerado: vacío, solo moveto, basura o path mal formado sin nada válido -> null (no lanza)", () => {
    expect(pathBounds("")).toBeNull();
    expect(pathBounds("M5 5")).toBeNull();
    expect(pathBounds("M5 5 Z")).toBeNull();
    expect(pathBounds("¿qué?")).toBeNull();
    expect(pathBounds("L1 1 L2 2")).toBeNull();
  });

  it("path mal formado a mitad: usa lo válido antes del error", () => {
    expectRect(pathBounds("M0 0 L10 10 L"), { x: 0, y: 0, width: 10, height: 10 });
  });

  it("línea horizontal: alto 0 (bbox no nulo)", () => {
    expectRect(pathBounds("M0 3 L9 3"), { x: 0, y: 3, width: 9, height: 0 });
  });
});

describe("transformPathData — hornear una matriz en d", () => {
  it("traslación sobre líneas: valores exactos", () => {
    expect(transformPathData("M0 0 L5 5 Z", translationMatrix(10, 20))).toBe("M10 20 L15 25 Z");
  });

  it("identidad devuelve el MISMO string (no degrada ni reformatea)", () => {
    const d = "M0.000,0.000 L8.000,1.000 Z";
    expect(transformPathData(d, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })).toBe(d);
  });

  it("rotación de 90° de un rectángulo: coordenadas enteras exactas", () => {
    // (x,y) -> (-y, x)
    expect(transformPathData("M0 0 H10 V5 H0 Z", rotationAboutMatrix({ x: 0, y: 0 }, 90))).toBe("M0 0 L0 10 L-5 10 L-5 0 Z");
  });

  it("las curvas siguen siendo curvas (C), con los puntos de control transformados", () => {
    const baked = transformPathData("M0 0 C0 10 10 10 10 0", scaleAboutMatrix({ x: 0, y: 0 }, 2, 3));
    expect(baked).toBe("M0 0 C0 30 20 30 20 0");
  });

  it("relativos y arcos se hornean a absolutos: el bbox del bake == bbox con matriz", () => {
    const matrix = { a: 0.8, b: 0.6, c: -0.6, d: 0.8, e: 7, f: -3 };
    for (const d of ["m1 1 l4 0 c2 0 4 2 4 4 z", "M0 5 A5 5 0 1 1 10 5 A5 5 0 1 1 0 5Z", "M0 0 Q5 10 10 0 T20 0", "M2 2 h6 v6 h-6 z m1 1 h1 v1 h-1 z"]) {
      const viaMatrix = pathBounds(d, matrix)!;
      const viaBake = pathBounds(transformPathData(d, matrix))!;
      expect(viaBake.x).toBeCloseTo(viaMatrix.x, 5);
      expect(viaBake.y).toBeCloseTo(viaMatrix.y, 5);
      expect(viaBake.width).toBeCloseTo(viaMatrix.width, 5);
      expect(viaBake.height).toBeCloseTo(viaMatrix.height, 5);
    }
  });

  it("hornear dos veces equivale a hornear la matriz compuesta (sin deriva apreciable)", () => {
    const d = "M0 0 C3 9 8 9 11 1 L11 11 Z";
    const rotate = rotationAboutMatrix({ x: 5, y: 5 }, 37);
    const move = translationMatrix(100, -50);
    const twice = transformPathData(transformPathData(d, rotate), move);
    const bounds = pathBounds(twice)!;
    const expected = pathBounds(d, { a: rotate.a, b: rotate.b, c: rotate.c, d: rotate.d, e: rotate.e + 100, f: rotate.f - 50 })!;
    expect(bounds.x).toBeCloseTo(expected.x, 4);
    expect(bounds.width).toBeCloseTo(expected.width, 4);
  });

  it("entrada degenerada: devuelve el d original sin lanzar", () => {
    const matrix = translationMatrix(5, 5);
    expect(transformPathData("", matrix)).toBe("");
    expect(transformPathData("basura", matrix)).toBe("basura");
    expect(transformPathData("M0 0 L10 10 L", matrix)).toBe("M0 0 L10 10 L");
  });

  it("redondea el ruido de punto flotante (0.1+0.2) a 6 decimales", () => {
    expect(transformPathData("M0.1 0 L0 0", translationMatrix(0.2, 0))).toBe("M0.3 0 L0.2 0");
  });
});

describe("segmentsToPathData", () => {
  it("serializa M/L/C/Z en forma compacta", () => {
    const segments = parsePathData("M1 2 L3 4 C5 6 7 8 9 10 Z").segments;
    expect(segmentsToPathData(segments)).toBe("M1 2 L3 4 C5 6 7 8 9 10 Z");
  });
});

describe("aplanado + punto en relleno", () => {
  const square = flattenSegments(parsePathData("M0 0 H10 V10 H0 Z").segments);

  it("adentro/afuera de un cuadrado", () => {
    expect(pointInPolylinesNonZero(square, { x: 5, y: 5 })).toBe(true);
    expect(pointInPolylinesNonZero(square, { x: 11, y: 5 })).toBe(false);
    expect(pointInPolylinesNonZero(square, { x: -0.1, y: 5 })).toBe(false);
  });

  it("un hueco con devanado opuesto (como emite vtracer) NO es relleno", () => {
    const ring = flattenSegments(parsePathData("M0 0 H10 V10 H0 Z M3 3 V7 H7 V3 Z").segments);
    expect(pointInPolylinesNonZero(ring, { x: 1, y: 1 })).toBe(true);
    expect(pointInPolylinesNonZero(ring, { x: 5, y: 5 })).toBe(false);
  });

  it("curvas: el centro de un círculo (2 arcos) está adentro, un punto fuera del círculo pero dentro de su bbox no", () => {
    const circle = flattenSegments(parsePathData("M0 5 A5 5 0 1 1 10 5 A5 5 0 1 1 0 5Z").segments);
    expect(pointInPolylinesNonZero(circle, { x: 5, y: 5 })).toBe(true);
    expect(pointInPolylinesNonZero(circle, { x: 0.5, y: 0.5 })).toBe(false);
    expect(pointInPolylinesNonZero(circle, { x: 5 + 4.9 * Math.SQRT1_2, y: 5 + 4.9 * Math.SQRT1_2 })).toBe(true);
  });

  it("distancia al contorno (incluye el lado de cierre implícito)", () => {
    expect(distanceToPolylines(square, { x: 13, y: 5 })).toBeCloseTo(3, 9);
    expect(distanceToPolylines(square, { x: 5, y: 5 })).toBeCloseTo(5, 9);
    const open = flattenSegments(parsePathData("M0 0 H10 V10").segments);
    // Subpath abierto de 3 puntos: se trata como cerrado para el contorno de relleno (lado diagonal).
    expect(distanceToPolylines(open, { x: 0, y: 10 })).toBeCloseTo(Math.SQRT1_2 * 10, 9);
  });
});
