import { IDENTITY_MATRIX, multiplyMatrices, parseSvgTransformAttribute, type AffineMatrix } from "../svgTransform";
import { isIdentityMatrix, isFiniteMatrix } from "./matrix";
import {
  distanceToPolylines,
  flattenSegments,
  parsePathDataCached,
  pathBounds,
  pointInPolylinesNonZero,
  transformSegments,
  type Polyline,
} from "./pathGeometry";
import type { EditorObject, Point, Rect } from "./types";

/**
 * Objetos editables (ADR D1): parseo/serialización de una capa SVG <-> lista
 * de `EditorObject`, bbox y consultas espaciales (hit-test, marquee). Todo
 * puro salvo el parseo del SVG, que usa `DOMParser` igual que
 * `lib/svgTransform.ts: parseLayerSvg` (la lógica espacial NO toca el DOM).
 */

export interface LayerSvgMeta {
  /** Ancho/alto del lienzo de la capa en unidades de documento (el `<svg width/height>` de origen). */
  width: number;
  height: number;
  /** Origen del lienzo (M3-S02, marco del documento): por defecto 0 -- el `viewBox` de origen es `0 0 width height`. */
  x?: number;
  y?: number;
}

const VID_ATTRIBUTE = "data-vid";

function defaultCreateId(): string {
  return crypto.randomUUID();
}

/**
 * Parsea el SVG de una capa a objetos editables, uno por `<path>` con `d` no
 * vacío, en orden de documento (= orden de pintado). `id` sale de `data-vid`
 * (preservado por `serializeEditableLayer`) o se genera; `matrix` compone los
 * `transform` de los `<g>` ancestros con el del propio path (mismo orden SVG
 * que `parseLayerSvg`). `null` si el texto no es un XML/SVG válido (la capa
 * "falló" -- distinto de una capa válida sin paths, que devuelve `[]`).
 */
export function parseEditableLayerStrict(
  svgText: string,
  layerGroupId: string,
  fallbackFill: string,
  createId: () => string = defaultCreateId,
): EditorObject[] | null {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  } catch {
    return null;
  }
  if (doc.getElementsByTagName("parsererror").length > 0) return null;

  const root = doc.documentElement;
  const usedIds = new Set<string>();
  const objects: EditorObject[] = [];

  for (const pathElement of Array.from(doc.getElementsByTagName("path"))) {
    const d = pathElement.getAttribute("d") ?? "";
    if (d.trim().length === 0) continue;

    const chain: Element[] = [];
    let node: Element | null = pathElement;
    while (node && node !== root) {
      chain.unshift(node);
      node = node.parentElement;
    }
    let matrix: AffineMatrix = IDENTITY_MATRIX;
    for (const element of chain) {
      matrix = multiplyMatrices(matrix, parseSvgTransformAttribute(element.getAttribute("transform")));
    }

    let id = pathElement.getAttribute(VID_ATTRIBUTE)?.trim() ?? "";
    // Un `data-vid` repetido (SVG editado a mano) no puede compartir id: el segundo recibe uno nuevo.
    if (!id || usedIds.has(id)) id = createId();
    usedIds.add(id);

    objects.push({
      id,
      layerGroupId,
      d,
      fill: pathElement.getAttribute("fill") || ancestorFill(pathElement) || fallbackFill,
      matrix,
    });
  }

  return objects;
}

/** Igual que `parseEditableLayerStrict` pero un SVG inválido da `[]` (fail-safe, como el resto de `lib/`). */
export function parseEditableLayer(
  svgText: string,
  layerGroupId: string,
  fallbackFill: string,
  createId: () => string = defaultCreateId,
): EditorObject[] {
  return parseEditableLayerStrict(svgText, layerGroupId, fallbackFill, createId) ?? [];
}

function ancestorFill(element: Element): string | null {
  let node: Element | null = element.parentElement;
  while (node) {
    const fill = node.getAttribute("fill");
    if (fill) return fill;
    node = node.parentElement;
  }
  return null;
}

function escapeXmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/**
 * Serializa objetos a SVG de capa en el mismo formato de origen (ADR D5):
 * `<path data-vid d fill transform>` planos. `transform` solo si la matriz no
 * es identidad, con los 6 coeficientes en precisión completa (round-trip
 * exacto: `parse(serialize(x))` reproduce id, d, fill y matriz). Una matriz con
 * coeficientes no finitos (no debería existir: `transform.ts` los rechaza) se
 * escribe con 0 en vez de emitir `NaN` en el SVG.
 */
export function serializeEditableLayer(objects: EditorObject[], meta: LayerSvgMeta): string {
  const paths = objects.map((object) => {
    const { a, b, c, d, e, f } = object.matrix;
    const transform = isIdentityMatrix(object.matrix)
      ? ""
      : ` transform="matrix(${[a, b, c, d, e, f].map(finiteOrZero).join(" ")})"`;
    return `<path ${VID_ATTRIBUTE}="${escapeXmlAttribute(object.id)}" d="${escapeXmlAttribute(object.d)}" fill="${escapeXmlAttribute(object.fill)}"${transform}/>`;
  });

  const width = finiteOrZero(meta.width);
  const height = finiteOrZero(meta.height);
  const originX = finiteOrZero(meta.x ?? 0);
  const originY = finiteOrZero(meta.y ?? 0);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${originX} ${originY} ${width} ${height}">${paths.join("")}</svg>`;
}

// ---- Bounds ----

const boundsCache = new WeakMap<EditorObject, Rect | null>();

/** Bbox exacto del objeto en espacio de documento (matriz aplicada). Cacheado por referencia: los objetos son inmutables. `null` si no dibuja nada. */
export function objectBounds(object: EditorObject): Rect | null {
  if (boundsCache.has(object)) return boundsCache.get(object) ?? null;
  const rect = isFiniteMatrix(object.matrix) ? pathBounds(object.d, object.matrix) : null;
  boundsCache.set(object, rect);
  return rect;
}

export function unionRects(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const rect of rects) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Bbox unión de varios objetos (bbox del grupo en multi-selección). `null` si ninguno tiene geometría. */
export function bounds(objects: readonly EditorObject[]): Rect | null {
  const rects: Rect[] = [];
  for (const object of objects) {
    const rect = objectBounds(object);
    if (rect) rects.push(rect);
  }
  return unionRects(rects);
}

export function rectCenter(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

export function rectsIntersect(left: Rect, right: Rect): boolean {
  return (
    left.x <= right.x + right.width &&
    right.x <= left.x + left.width &&
    left.y <= right.y + right.height &&
    right.y <= left.y + left.height
  );
}

/** Normaliza un rectángulo arrastrado en cualquier dirección (ancho/alto negativos) a uno con origen arriba-izquierda. */
export function rectFromPoints(start: Point, end: Point): Rect {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

// ---- Hit-testing ----

const polylineCache = new WeakMap<EditorObject, Polyline[]>();

function objectPolylines(object: EditorObject): Polyline[] {
  const cached = polylineCache.get(object);
  if (cached) return cached;
  const parsed = parsePathDataCached(object.d);
  const polylines = flattenSegments(transformSegments(parsed.segments, object.matrix));
  polylineCache.set(object, polylines);
  return polylines;
}

function isUnfilled(fill: string): boolean {
  const normalized = fill.trim().toLowerCase();
  return normalized === "none" || normalized === "transparent";
}

/** ¿El punto (en documento) cae sobre el objeto? Relleno exacto (regla no-cero) o a ≤ `tolerance` de su contorno. */
function objectContainsPoint(object: EditorObject, point: Point, tolerance: number): boolean {
  const rect = objectBounds(object);
  if (!rect) return false;
  if (
    point.x < rect.x - tolerance ||
    point.x > rect.x + rect.width + tolerance ||
    point.y < rect.y - tolerance ||
    point.y > rect.y + rect.height + tolerance
  ) {
    return false;
  }
  const polylines = objectPolylines(object);
  if (!isUnfilled(object.fill) && pointInPolylinesNonZero(polylines, point)) return true;
  // Fuera del relleno (o sin relleno): solo cuenta si cae a ≤ tolerancia del contorno -- así un
  // trazo fino o un hueco angosto siguen siendo clickeables a zoom bajo.
  return distanceToPolylines(polylines, point) <= tolerance;
}

/**
 * Todos los objetos bajo el punto, el de MÁS ARRIBA primero. `objects` va en
 * orden de pintado (el último queda arriba). `tolerance` está en unidades de
 * DOCUMENTO: el llamador convierte los px de pantalla con
 * `screenToleranceToDocument(px, zoom)` para que el área clickeable sea
 * constante en pantalla a cualquier zoom.
 */
export function hitTestAll(objects: readonly EditorObject[], point: Point, tolerance = 0): EditorObject[] {
  const hits: EditorObject[] = [];
  for (let index = objects.length - 1; index >= 0; index -= 1) {
    if (objectContainsPoint(objects[index], point, tolerance)) hits.push(objects[index]);
  }
  return hits;
}

/** El objeto de más arriba bajo el punto, o `null`. */
export function hitTest(objects: readonly EditorObject[], point: Point, tolerance = 0): EditorObject | null {
  for (let index = objects.length - 1; index >= 0; index -= 1) {
    if (objectContainsPoint(objects[index], point, tolerance)) return objects[index];
  }
  return null;
}

/** Marquee: objetos cuyo bbox intersecta el rectángulo (los que solo lo tocan en el borde cuentan). */
export function objectsInRect(objects: readonly EditorObject[], rect: Rect): EditorObject[] {
  return objects.filter((object) => {
    const box = objectBounds(object);
    return box !== null && rectsIntersect(box, rect);
  });
}
