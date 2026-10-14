import { isFiniteMatrix } from "../matrix";
import { parsePathDataCached, transformSegments, type PathSegment } from "../pathGeometry";
import type { EditableLayerMeta, EditorObject, Point } from "../types";
import { dxfLayerName } from "./fileNames";
import { layerObjects, type ExportDocument } from "./exportDocument";
import { formatNumber } from "./svgExport";

/**
 * Export DXF (M3-S15), ASCII, AutoCAD R12 (`AC1009`) por compatibilidad. Documentado en `docs/EXPORT_FORMATOS.md`; lo esencial:
 *
 * - **Primitivas**: solo `POLYLINE` + `VERTEX` + `SEQEND` (2D, sin bulges). Sin `LWPOLYLINE` (no existe en R12), ni texto, bloques, splines, arcos/círculos nativos ni hatch.
 * - **Unidades**: milímetros (`$INSUNITS = 4`) cuando el documento tiene escala física; sin escala se escriben las unidades del documento y `$INSUNITS = 0` (sin unidades).
 * - **Ejes**: el origen es la esquina INFERIOR-izquierda del área de trabajo y Y crece hacia arriba: `y' = alto - (y - marco.y)` (SVG tiene Y hacia abajo).
 * - **Curvas**: aplanadas a polilíneas con un error máximo de `DXF_FLATNESS_MM`; el `transform` de cada objeto se aplica a los puntos.
 * - **Huecos**: DXF no tiene relleno ni regla de relleno: cada subpath (contorno exterior o hueco) es una polilínea más. Se conserva la geometría, no el relleno.
 * - **Capas**: una capa DXF por capa del editor (nombre saneado, único, ≤ 31 caracteres). Sin color ni relleno: solo geometría.
 */

/** Error máximo de aplanado de las curvas, en mm (10 µm: invisible en corte y grabado láser). */
export const DXF_FLATNESS_MM = 0.01;
/** Tope de segmentos por curva cúbica: protege de una curva enorme con una tolerancia diminuta. */
export const DXF_MAX_CURVE_STEPS = 2048;
/** Decimales de las coordenadas escritas (1 nm en mm). */
const COORDINATE_DECIMALS = 6;
const NEWLINE = "\r\n";

/** Polilínea en el espacio DXF (mm, Y hacia arriba, origen en la esquina inferior-izquierda del marco). */
export interface DxfPolyline {
  points: Point[];
  closed: boolean;
}

function cubicAt(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const mt = 1 - t;
  return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3;
}

/**
 * Aplana segmentos M/L/C/Z a polilíneas. El error de flecha de una cúbica partida en `n` tramos iguales es ≤ 0,75·d/n² con
 * `d = max(|P0-2P1+P2|, |P1-2P2+P3|)`; se elige `n` para que ese tope sea ≤ `flatness` (unidades de los segmentos). Un subpath cerrado por `Z` queda `closed`.
 */
export function flattenForExport(segments: readonly PathSegment[], flatness: number): DxfPolyline[] {
  const polylines: DxfPolyline[] = [];
  let current: DxfPolyline | null = null;
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  const ensure = (): DxfPolyline => {
    if (!current) {
      current = { points: [{ x, y }], closed: false };
      polylines.push(current);
    }
    return current;
  };

  for (const segment of segments) {
    if (segment.type === "M") {
      current = { points: [{ x: segment.x, y: segment.y }], closed: false };
      polylines.push(current);
      x = startX = segment.x;
      y = startY = segment.y;
    } else if (segment.type === "L") {
      ensure().points.push({ x: segment.x, y: segment.y });
      x = segment.x;
      y = segment.y;
    } else if (segment.type === "C") {
      const polyline = ensure();
      const deviation = Math.max(Math.hypot(x - 2 * segment.x1 + segment.x2, y - 2 * segment.y1 + segment.y2), Math.hypot(segment.x1 - 2 * segment.x2 + segment.x, segment.y1 - 2 * segment.y2 + segment.y));
      const steps = Math.min(DXF_MAX_CURVE_STEPS, Math.max(1, Math.ceil(Math.sqrt((0.75 * deviation) / flatness))));
      for (let step = 1; step <= steps; step += 1) {
        const t = step / steps;
        polyline.points.push({ x: cubicAt(x, segment.x1, segment.x2, segment.x, t), y: cubicAt(y, segment.y1, segment.y2, segment.y, t) });
      }
      x = segment.x;
      y = segment.y;
    } else {
      if (current) (current as DxfPolyline).closed = true;
      current = null;
      x = startX;
      y = startY;
    }
  }
  return polylines;
}

/** Redondea a los decimales que se escriben: dos puntos que se escribirían igual son el mismo vértice. */
function roundCoordinate(value: number): number {
  const rounded = Number(value.toFixed(COORDINATE_DECIMALS));
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** Quita vértices consecutivos repetidos y, en un contorno cerrado, el último si repite al primero (el flag de cierre ya lo cierra). `null` si no queda una línea. */
function cleanPolyline(points: readonly Point[], closed: boolean): DxfPolyline | null {
  const cleaned: Point[] = [];
  for (const point of points) {
    const previous = cleaned[cleaned.length - 1];
    if (!previous || previous.x !== point.x || previous.y !== point.y) cleaned.push(point);
  }
  if (closed && cleaned.length > 1) {
    const first = cleaned[0];
    const last = cleaned[cleaned.length - 1];
    if (first.x === last.x && first.y === last.y) cleaned.pop();
  }
  if (cleaned.length < 2) return null;
  // Un «cerrado» de 2 vértices no tiene área: se escribe como la línea abierta que es.
  return { points: cleaned, closed: closed && cleaned.length >= 3 };
}

export interface DxfObjectGeometry {
  polylines: DxfPolyline[];
  /** El path tenía un error de sintaxis: se exportó solo lo legible (igual que lo dibuja el editor). */
  partial: boolean;
}

/** Un objeto del editor -> polilíneas en el espacio DXF, o `null` si su matriz no es finita (no se puede ubicar). */
export function objectToDxfPolylines(object: EditorObject, document: Pick<ExportDocument, "frame" | "mmFactor">): DxfObjectGeometry | null {
  if (!isFiniteMatrix(object.matrix)) return null;
  const parsed = parsePathDataCached(object.d);
  const factor = document.mmFactor ?? 1;
  const documentFlatness = DXF_FLATNESS_MM / factor;
  const flattened = flattenForExport(transformSegments(parsed.segments, object.matrix), documentFlatness);
  const { frame } = document;
  const polylines: DxfPolyline[] = [];
  for (const polyline of flattened) {
    const points = polyline.points.map((point) => ({
      x: roundCoordinate((point.x - frame.x) * factor),
      y: roundCoordinate((frame.y + frame.height - point.y) * factor),
    }));
    const cleaned = cleanPolyline(points, polyline.closed);
    if (cleaned) polylines.push(cleaned);
  }
  return { polylines, partial: parsed.error !== null };
}

// ---- Escritura ----

function code(groupCode: number, value: string | number): string {
  return `${String(groupCode).padStart(3, " ")}${NEWLINE}${value}`;
}

function integer(groupCode: number, value: number): string {
  return code(groupCode, String(value).padStart(6, " "));
}

function real(groupCode: number, value: number): string {
  const text = formatNumber(value, COORDINATE_DECIMALS);
  return code(groupCode, text.includes(".") ? text : `${text}.0`);
}

export interface DxfLayerPlan {
  layer: EditableLayerMeta;
  /** Nombre de la capa en el DXF. */
  dxfName: string;
}

/** Nombres DXF únicos para las capas, en el orden dado (el DXF reserva la capa «0»). */
export function planDxfLayers(layers: readonly EditableLayerMeta[]): DxfLayerPlan[] {
  const taken = new Set<string>(["0"]);
  return layers.map((layer) => ({ layer, dxfName: dxfLayerName(layer.name, taken) }));
}

export interface DxfBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface DxfLayerBody {
  /** Entidades (POLYLINE/VERTEX/SEQEND) de la capa, ya con el salto de línea. */
  text: string;
  polylines: number;
  vertices: number;
  bounds: DxfBounds | null;
  /** Objetos cuya matriz no es finita (omitidos). */
  skippedObjects: number;
  /** Objetos con un error de sintaxis en el path (se exportó lo legible). */
  partialObjects: number;
}

/** Las entidades de UNA capa. Separado de `buildDxf` para que el orquestador pueda ceder al event loop entre capas. */
export function dxfLayerBody(document: ExportDocument, plan: DxfLayerPlan): DxfLayerBody {
  const lines: string[] = [];
  let polylines = 0;
  let vertices = 0;
  let skippedObjects = 0;
  let partialObjects = 0;
  let bounds: DxfBounds | null = null;

  for (const object of layerObjects(document, plan.layer.groupId)) {
    const geometry = objectToDxfPolylines(object, document);
    if (!geometry) {
      skippedObjects += 1;
      continue;
    }
    if (geometry.partial) partialObjects += 1;
    for (const polyline of geometry.polylines) {
      polylines += 1;
      lines.push(code(0, "POLYLINE"), code(8, plan.dxfName), integer(66, 1), real(10, 0), real(20, 0), real(30, 0), integer(70, polyline.closed ? 1 : 0));
      for (const point of polyline.points) {
        vertices += 1;
        lines.push(code(0, "VERTEX"), code(8, plan.dxfName), real(10, point.x), real(20, point.y), real(30, 0));
        bounds = bounds
          ? { minX: Math.min(bounds.minX, point.x), minY: Math.min(bounds.minY, point.y), maxX: Math.max(bounds.maxX, point.x), maxY: Math.max(bounds.maxY, point.y) }
          : { minX: point.x, minY: point.y, maxX: point.x, maxY: point.y };
      }
      lines.push(code(0, "SEQEND"), code(8, plan.dxfName));
    }
  }
  return { text: lines.length > 0 ? lines.join(NEWLINE) + NEWLINE : "", polylines, vertices, bounds, skippedObjects, partialObjects };
}

export interface DxfBuild {
  text: string;
  polylines: number;
  vertices: number;
  /** Nombre de la capa DXF de cada capa del editor, por `groupId`. */
  layerNames: Record<string, string>;
  /** Avisos para mostrar al usuario (objetos omitidos o parciales). */
  warnings: string[];
}

function unionBounds(bodies: readonly DxfLayerBody[]): DxfBounds | null {
  let result: DxfBounds | null = null;
  for (const body of bodies) {
    if (!body.bounds) continue;
    result = result
      ? { minX: Math.min(result.minX, body.bounds.minX), minY: Math.min(result.minY, body.bounds.minY), maxX: Math.max(result.maxX, body.bounds.maxX), maxY: Math.max(result.maxY, body.bounds.maxY) }
      : body.bounds;
  }
  return result;
}

export function dxfWarnings(bodies: readonly DxfLayerBody[]): string[] {
  const skipped = bodies.reduce((total, body) => total + body.skippedObjects, 0);
  const partial = bodies.reduce((total, body) => total + body.partialObjects, 0);
  const warnings: string[] = [];
  if (skipped > 0) warnings.push(`${skipped} ${skipped === 1 ? "objeto con una transformación inválida se omitió" : "objetos con una transformación inválida se omitieron"} del DXF.`);
  if (partial > 0) warnings.push(`${partial} ${partial === 1 ? "objeto con un path ilegible se exportó" : "objetos con un path ilegible se exportaron"} solo hasta donde se pudo leer.`);
  return warnings;
}

/** Une cabecera, tablas y entidades. `scaled`: el documento tiene escala física (unidades = mm). */
export function assembleDxf(plans: readonly DxfLayerPlan[], bodies: readonly DxfLayerBody[], scaled: boolean): string {
  const extents = unionBounds(bodies) ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const parts: string[] = [
    code(0, "SECTION"),
    code(2, "HEADER"),
    code(9, "$ACADVER"),
    code(1, "AC1009"),
    code(9, "$INSUNITS"),
    integer(70, scaled ? 4 : 0),
    code(9, "$EXTMIN"),
    real(10, extents.minX),
    real(20, extents.minY),
    real(30, 0),
    code(9, "$EXTMAX"),
    real(10, extents.maxX),
    real(20, extents.maxY),
    real(30, 0),
    code(0, "ENDSEC"),
    code(0, "SECTION"),
    code(2, "TABLES"),
    code(0, "TABLE"),
    code(2, "LTYPE"),
    integer(70, 1),
    code(0, "LTYPE"),
    code(2, "CONTINUOUS"),
    integer(70, 0),
    code(3, "Solid line"),
    integer(72, 65),
    integer(73, 0),
    real(40, 0),
    code(0, "ENDTAB"),
    code(0, "TABLE"),
    code(2, "LAYER"),
    integer(70, plans.length + 1),
    // La capa «0» existe siempre en AutoCAD; se declara para los lectores R12 estrictos.
    code(0, "LAYER"),
    code(2, "0"),
    integer(70, 0),
    integer(62, 7),
    code(6, "CONTINUOUS"),
  ];
  for (const plan of plans) parts.push(code(0, "LAYER"), code(2, plan.dxfName), integer(70, 0), integer(62, 7), code(6, "CONTINUOUS"));
  parts.push(code(0, "ENDTAB"), code(0, "ENDSEC"), code(0, "SECTION"), code(2, "ENTITIES"));
  return `${parts.join(NEWLINE)}${NEWLINE}${bodies.map((body) => body.text).join("")}${code(0, "ENDSEC")}${NEWLINE}${code(0, "EOF")}${NEWLINE}`;
}

/** DXF completo de las capas dadas (en ese orden), de una vez. */
export function buildDxf(document: ExportDocument, layers: readonly EditableLayerMeta[]): DxfBuild {
  const plans = planDxfLayers(layers);
  const bodies = plans.map((plan) => dxfLayerBody(document, plan));
  const layerNames: Record<string, string> = {};
  for (const plan of plans) layerNames[plan.layer.groupId] = plan.dxfName;
  return {
    text: assembleDxf(plans, bodies, document.mmFactor !== null),
    polylines: bodies.reduce((total, body) => total + body.polylines, 0),
    vertices: bodies.reduce((total, body) => total + body.vertices, 0),
    layerNames,
    warnings: dxfWarnings(bodies),
  };
}
