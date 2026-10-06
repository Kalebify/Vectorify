import { describe, expect, it } from "vitest";
import { bounds, hitTest, hitTestAll, objectsInRect, parseEditableLayer, serializeEditableLayer } from "./objects";
import { replaceObjects } from "./selection";
import { translate } from "./transform";
import type { EditableDocument, EditorObject } from "./types";

/**
 * Prueba de humo de rendimiento (ADR D6: documentos de ≥ 5 000 paths no deben bloquear selección/drag). SIN
 * umbrales frágiles: el tope es muy holgado (segundos para operaciones que tardan milisegundos) y solo
 * detecta una regresión algorítmica (p. ej. O(n²) o re-parseo de `d` en cada consulta).
 */

const COLUMNS = 100;
const COUNT = 5000;
const GENEROUS_LIMIT_MS = 5000;

/** 5000 cuadraditos con una curva (como un trazado real), en una grilla de 100 columnas, con un `translate` propio cada uno. */
function buildSvg(): string {
  const paths: string[] = [];
  for (let index = 0; index < COUNT; index += 1) {
    const x = (index % COLUMNS) * 12;
    const y = Math.floor(index / COLUMNS) * 12;
    paths.push(`<path data-vid="p${index}" d="M0 0 L8 0 C10 2 10 6 8 8 L0 8 Z" fill="#336699" transform="translate(${x},${y})"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600">${paths.join("")}</svg>`;
}

function timed<T>(action: () => T): { result: T; ms: number } {
  const start = performance.now();
  const result = action();
  return { result, ms: performance.now() - start };
}

describe("rendimiento con 5 000 objetos (humo)", () => {
  const svg = buildSvg();
  const { result: objects, ms: parseMs } = timed(() => parseEditableLayer(svg, "g", "#000000"));

  it("parsea 5 000 paths y los serializa de vuelta sin perder ninguno (round-trip a escala)", () => {
    expect(objects).toHaveLength(COUNT);
    expect(parseMs).toBeLessThan(GENEROUS_LIMIT_MS);

    const { result: roundTrip, ms } = timed(() => parseEditableLayer(serializeEditableLayer(objects, { width: 1200, height: 600 }), "g", "#000000"));
    expect(roundTrip).toHaveLength(COUNT);
    expect(roundTrip[4999].id).toBe("p4999");
    expect(roundTrip[4999].matrix).toEqual(objects[4999].matrix);
    expect(ms).toBeLessThan(GENEROUS_LIMIT_MS);
  });

  it("bbox del documento, hit-test y marquee sobre 5 000 objetos", () => {
    const { result: box, ms: boundsMs } = timed(() => bounds(objects));
    // La curva C abulta hasta x=9.5 (B_x(0.5) = (8 + 30 + 30 + 8) / 8), no hasta el punto de control x=10.
    expect(box).toEqual({ x: 0, y: 0, width: 99 * 12 + 9.5, height: 49 * 12 + 8 });
    expect(boundsMs).toBeLessThan(GENEROUS_LIMIT_MS);

    // Click en el centro de un cuadradito concreto (índice 2525 = columna 25, fila 25 -> origen (300, 300)).
    const { result: hit, ms: hitMs } = timed(() => hitTest(objects, { x: 304, y: 304 }, 0.5));
    expect(hit?.id).toBe("p2525");
    expect(hitTestAll(objects, { x: 304, y: 304 }, 0.5)).toHaveLength(1);
    expect(hitMs).toBeLessThan(GENEROUS_LIMIT_MS);

    // Marquee que cubre 10 columnas × 10 filas.
    const { result: inside, ms: marqueeMs } = timed(() => objectsInRect(objects, { x: 0, y: 0, width: 119, height: 119 }));
    expect(inside).toHaveLength(100);
    expect(marqueeMs).toBeLessThan(GENEROUS_LIMIT_MS);
  });

  it("mover una selección grande: el resultado conserva la referencia de los objetos NO tocados (memoización por objeto)", () => {
    const state: EditableDocument = { objectsByLayer: { g: objects } };
    const targets = objects.slice(0, 500);
    const { result: production, ms } = timed(() => replaceObjects(state, targets, (found) => translate(found, 3, 4)));
    expect(ms).toBeLessThan(GENEROUS_LIMIT_MS);

    const next = production!.layers.g;
    expect(next).toHaveLength(COUNT);
    expect(next[0]).not.toBe(objects[0]);
    // Los 4 500 restantes son EXACTAMENTE los mismos objetos: React.memo de cada <Path> no los re-renderiza.
    let untouched = 0;
    next.forEach((object: EditorObject, index) => {
      if (index >= 500 && object === objects[index]) untouched += 1;
    });
    expect(untouched).toBe(COUNT - 500);
  });
});
