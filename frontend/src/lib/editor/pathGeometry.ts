import type { AffineMatrix } from "../svgTransform";
import { applyMatrixToPoint, isIdentityMatrix } from "./matrix";
import type { Point, Rect } from "./types";

/**
 * Geometría de path data SVG (MVP3-S01): parser completo, bbox exacto de
 * curvas, "hornear" una matriz en `d` y aplanado para hit-testing. Es la BASE
 * de los nodos Bézier (S05), booleanas/offset/corte (S08-S10) y crop (S02):
 * todo normaliza a segmentos ABSOLUTOS de solo cuatro tipos (M, L, C, Z) -- los
 * H/V/S/Q/T/A se convierten de forma exacta (Q a cúbica por elevación de
 * grado, A a cúbicas por el método estándar de la nota F.6 del spec SVG).
 *
 * Nunca lanza: una entrada mal formada se corta en el primer error (mismo
 * criterio que el renderizado de SVG: "dibujar hasta el error") y se informa en
 * `ParsedPath.error`.
 */

export type PathSegment =
  | { type: "M"; x: number; y: number }
  | { type: "L"; x: number; y: number }
  | { type: "C"; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { type: "Z" };

export interface ParsedPath {
  /** Segmentos absolutos normalizados válidos hasta el primer error (todos, si `error` es null). */
  segments: PathSegment[];
  error: string | null;
}

const ARG_COUNT: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };
const NUMBER_RE = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y;

/** Lector posicional de path data: separa números pegados ("1.5.5", "10-5"), exponentes y los flags de arco de un solo carácter. */
class Scanner {
  index = 0;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  get done(): boolean {
    this.skipWhitespace();
    return this.index >= this.text.length;
  }

  peek(): string {
    return this.text[this.index] ?? "";
  }

  skipWhitespace(): void {
    while (this.index < this.text.length && /[\s]/.test(this.text[this.index])) this.index += 1;
  }

  /** Separador entre argumentos: espacios y como mucho UNA coma. */
  skipSeparator(): void {
    this.skipWhitespace();
    if (this.text[this.index] === ",") {
      this.index += 1;
      this.skipWhitespace();
    }
  }

  nextIsNumberStart(): boolean {
    this.skipWhitespace();
    if (this.text[this.index] === ",") return true;
    return /[-+.\d]/.test(this.text[this.index] ?? "");
  }

  readNumber(): number | null {
    this.skipSeparator();
    NUMBER_RE.lastIndex = this.index;
    const match = NUMBER_RE.exec(this.text);
    if (!match) return null;
    this.index = NUMBER_RE.lastIndex;
    const value = Number(match[0]);
    return Number.isFinite(value) ? value : null;
  }

  /** Flag de arco: UN solo carácter '0' o '1' (pueden venir pegados al siguiente número: "a1 1 0 011 1"). */
  readFlag(): 0 | 1 | null {
    this.skipSeparator();
    const ch = this.text[this.index];
    if (ch !== "0" && ch !== "1") return null;
    this.index += 1;
    return ch === "1" ? 1 : 0;
  }
}

/** Cubica con extremos `(x0,y0)` -> `(x,y)`: elevación de grado exacta de una cuadrática. */
function quadToCubic(x0: number, y0: number, qx: number, qy: number, x: number, y: number): PathSegment {
  return {
    type: "C",
    x1: x0 + (2 / 3) * (qx - x0),
    y1: y0 + (2 / 3) * (qy - y0),
    x2: x + (2 / 3) * (qx - x),
    y2: y + (2 / 3) * (qy - y),
    x,
    y,
  };
}

/**
 * Arco elíptico SVG (endpoint parameterization) -> cúbicas, una por cada ≤90°
 * de barrido. Sigue la nota de implementación F.6.5/F.6.6 del spec: radios en
 * valor absoluto, escalado si no alcanzan, y degeneraciones (extremos iguales,
 * radio 0) manejadas por el llamador.
 */
function arcToCubics(
  x0: number,
  y0: number,
  rxIn: number,
  ryIn: number,
  rotationDeg: number,
  largeArc: 0 | 1,
  sweep: 0 | 1,
  x: number,
  y: number,
): PathSegment[] {
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  const phi = (rotationDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);

  const dx2 = (x0 - x) / 2;
  const dy2 = (y0 - y) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;

  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const scale = Math.sqrt(lambda);
    rx *= scale;
    ry *= scale;
  }

  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const numerator = rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p;
  const denominator = rx2 * y1p * y1p + ry2 * x1p * x1p;
  const sign = largeArc === sweep ? -1 : 1;
  const coefficient = denominator === 0 ? 0 : sign * Math.sqrt(Math.max(0, numerator / denominator));
  const cxp = (coefficient * rx * y1p) / ry;
  const cyp = (-coefficient * ry * x1p) / rx;
  const cx = cosPhi * cxp - sinPhi * cyp + (x0 + x) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y0 + y) / 2;

  const startAngle = Math.atan2((y1p - cyp) / ry, (x1p - cxp) / rx);
  const endAngle = Math.atan2((-y1p - cyp) / ry, (-x1p - cxp) / rx);
  let sweepAngle = endAngle - startAngle;
  if (!sweep && sweepAngle > 0) sweepAngle -= 2 * Math.PI;
  else if (sweep && sweepAngle < 0) sweepAngle += 2 * Math.PI;

  const pieces = Math.max(1, Math.ceil(Math.abs(sweepAngle) / (Math.PI / 2) - 1e-9));
  const delta = sweepAngle / pieces;
  const handle = (4 / 3) * Math.tan(delta / 4);

  const toPoint = (ux: number, uy: number): Point => ({
    x: cx + rx * ux * cosPhi - ry * uy * sinPhi,
    y: cy + rx * ux * sinPhi + ry * uy * cosPhi,
  });

  const cubics: PathSegment[] = [];
  for (let piece = 0; piece < pieces; piece += 1) {
    const a0 = startAngle + piece * delta;
    const a1 = a0 + delta;
    const cos0 = Math.cos(a0);
    const sin0 = Math.sin(a0);
    const cos1 = Math.cos(a1);
    const sin1 = Math.sin(a1);
    const c1 = toPoint(cos0 - handle * sin0, sin0 + handle * cos0);
    const c2 = toPoint(cos1 + handle * sin1, sin1 - handle * cos1);
    const end = piece === pieces - 1 ? { x, y } : toPoint(cos1, sin1);
    cubics.push({ type: "C", x1: c1.x, y1: c1.y, x2: c2.x, y2: c2.y, x: end.x, y: end.y });
  }
  return cubics;
}

/**
 * Parsea path data SVG a segmentos absolutos normalizados (M/L/C/Z).
 * Soporta todos los comandos (M L H V C S Q T A Z, absolutos y relativos),
 * repetición implícita de argumentos (`M` -> `L`), números pegados, notación
 * científica, flags de arco compactos y subpaths que continúan tras un `Z`.
 */
export function parsePathData(d: string): ParsedPath {
  const segments: PathSegment[] = [];
  if (typeof d !== "string" || d.trim().length === 0) {
    return { segments, error: null };
  }

  const scanner = new Scanner(d);
  let command = "";
  let currentX = 0;
  let currentY = 0;
  let startX = 0;
  let startY = 0;
  let lastCubicControl: Point | null = null;
  let lastQuadControl: Point | null = null;
  let needsMoveBeforeDrawing = false;
  let sawFirstCommand = false;

  const fail = (message: string): ParsedPath => ({ segments, error: message });

  const startSubpathIfNeeded = () => {
    // Tras un `Z`, un comando de dibujo sin `M` abre un subpath nuevo en el
    // punto inicial del anterior (comportamiento estándar del spec SVG).
    if (needsMoveBeforeDrawing) {
      segments.push({ type: "M", x: startX, y: startY });
      needsMoveBeforeDrawing = false;
    }
  };

  while (!scanner.done) {
    const ch = scanner.peek();

    if (/[A-Za-z]/.test(ch)) {
      if (!(ch.toLowerCase() in ARG_COUNT)) return fail(`Comando desconocido '${ch}'`);
      command = ch;
      scanner.index += 1;
      if (!sawFirstCommand && ch.toLowerCase() !== "m") return fail("El path debe empezar con un moveto (M)");
      sawFirstCommand = true;

      if (ch.toLowerCase() === "z") {
        if (segments.length > 0 && segments[segments.length - 1].type !== "Z") {
          segments.push({ type: "Z" });
        }
        currentX = startX;
        currentY = startY;
        needsMoveBeforeDrawing = true;
        lastCubicControl = null;
        lastQuadControl = null;
        continue;
      }
    } else if (!command) {
      return fail("El path debe empezar con un comando");
    } else if (command.toLowerCase() === "z") {
      return fail("Argumentos inesperados después de Z");
    } else if (!scanner.nextIsNumberStart()) {
      return fail(`Carácter inesperado '${ch}'`);
    }

    const lower = command.toLowerCase();
    const relative = command !== command.toUpperCase();
    const args: number[] = [];
    const needed = ARG_COUNT[lower];

    for (let index = 0; index < needed; index += 1) {
      // Arco: los argumentos 4 y 5 (índices 3 y 4) son flags de un carácter.
      const isFlag = lower === "a" && (index === 3 || index === 4);
      const value = isFlag ? scanner.readFlag() : scanner.readNumber();
      if (value === null) return fail(`Argumentos insuficientes o inválidos para '${command}'`);
      args.push(value);
    }

    const baseX = relative ? currentX : 0;
    const baseY = relative ? currentY : 0;

    switch (lower) {
      case "m": {
        const x = baseX + args[0];
        const y = baseY + args[1];
        segments.push({ type: "M", x, y });
        currentX = startX = x;
        currentY = startY = y;
        needsMoveBeforeDrawing = false;
        // Los pares siguientes de un moveto son lineto implícitos.
        command = relative ? "l" : "L";
        lastCubicControl = null;
        lastQuadControl = null;
        break;
      }
      case "l": {
        startSubpathIfNeeded();
        currentX = baseX + args[0];
        currentY = baseY + args[1];
        segments.push({ type: "L", x: currentX, y: currentY });
        lastCubicControl = null;
        lastQuadControl = null;
        break;
      }
      case "h": {
        startSubpathIfNeeded();
        currentX = baseX + args[0];
        segments.push({ type: "L", x: currentX, y: currentY });
        lastCubicControl = null;
        lastQuadControl = null;
        break;
      }
      case "v": {
        startSubpathIfNeeded();
        currentY = baseY + args[0];
        segments.push({ type: "L", x: currentX, y: currentY });
        lastCubicControl = null;
        lastQuadControl = null;
        break;
      }
      case "c": {
        startSubpathIfNeeded();
        const x1 = baseX + args[0];
        const y1 = baseY + args[1];
        const x2 = baseX + args[2];
        const y2 = baseY + args[3];
        const x = baseX + args[4];
        const y = baseY + args[5];
        segments.push({ type: "C", x1, y1, x2, y2, x, y });
        lastCubicControl = { x: x2, y: y2 };
        lastQuadControl = null;
        currentX = x;
        currentY = y;
        break;
      }
      case "s": {
        startSubpathIfNeeded();
        const x1 = lastCubicControl ? 2 * currentX - lastCubicControl.x : currentX;
        const y1 = lastCubicControl ? 2 * currentY - lastCubicControl.y : currentY;
        const x2 = baseX + args[0];
        const y2 = baseY + args[1];
        const x = baseX + args[2];
        const y = baseY + args[3];
        segments.push({ type: "C", x1, y1, x2, y2, x, y });
        lastCubicControl = { x: x2, y: y2 };
        lastQuadControl = null;
        currentX = x;
        currentY = y;
        break;
      }
      case "q": {
        startSubpathIfNeeded();
        const qx = baseX + args[0];
        const qy = baseY + args[1];
        const x = baseX + args[2];
        const y = baseY + args[3];
        segments.push(quadToCubic(currentX, currentY, qx, qy, x, y));
        lastQuadControl = { x: qx, y: qy };
        lastCubicControl = null;
        currentX = x;
        currentY = y;
        break;
      }
      case "t": {
        startSubpathIfNeeded();
        const qx: number = lastQuadControl ? 2 * currentX - lastQuadControl.x : currentX;
        const qy: number = lastQuadControl ? 2 * currentY - lastQuadControl.y : currentY;
        const x = baseX + args[0];
        const y = baseY + args[1];
        segments.push(quadToCubic(currentX, currentY, qx, qy, x, y));
        lastQuadControl = { x: qx, y: qy };
        lastCubicControl = null;
        currentX = x;
        currentY = y;
        break;
      }
      case "a": {
        startSubpathIfNeeded();
        const x = baseX + args[5];
        const y = baseY + args[6];
        const [rx, ry, rotation, largeArc, sweep] = args;
        if (x === currentX && y === currentY) {
          // Extremos coincidentes: el arco se omite por completo (spec F.6.2).
        } else if (rx === 0 || ry === 0) {
          segments.push({ type: "L", x, y });
        } else {
          segments.push(...arcToCubics(currentX, currentY, rx, ry, rotation, largeArc as 0 | 1, sweep as 0 | 1, x, y));
        }
        currentX = x;
        currentY = y;
        lastCubicControl = null;
        lastQuadControl = null;
        break;
      }
      default:
        return fail(`Comando no soportado '${command}'`);
    }
  }

  return { segments, error: null };
}

// ---- Caché de parseo (por `d`): un move/scale/rotate no cambia `d`, así que el bbox/hit-test
// de un documento grande no re-parsea 5000 paths en cada gesto. Tope duro: al excederlo se vacía.
const PARSE_CACHE_LIMIT = 20000;
const parseCache = new Map<string, ParsedPath>();

export function parsePathDataCached(d: string): ParsedPath {
  const hit = parseCache.get(d);
  if (hit) return hit;
  const parsed = parsePathData(d);
  if (parseCache.size >= PARSE_CACHE_LIMIT) parseCache.clear();
  parseCache.set(d, parsed);
  return parsed;
}

// ---- Transformación ----

export function transformSegments(segments: PathSegment[], matrix: AffineMatrix): PathSegment[] {
  return segments.map((segment): PathSegment => {
    switch (segment.type) {
      case "M":
      case "L": {
        const p = applyMatrixToPoint(matrix, segment);
        return { type: segment.type, x: p.x, y: p.y };
      }
      case "C": {
        const c1 = applyMatrixToPoint(matrix, { x: segment.x1, y: segment.y1 });
        const c2 = applyMatrixToPoint(matrix, { x: segment.x2, y: segment.y2 });
        const p = applyMatrixToPoint(matrix, segment);
        return { type: "C", x1: c1.x, y1: c1.y, x2: c2.x, y2: c2.y, x: p.x, y: p.y };
      }
      case "Z":
        return segment;
    }
  });
}

function formatCoordinate(value: number): string {
  if (!Number.isFinite(value)) return "0";
  // 6 decimales: ruido de punto flotante (0.30000000000000004) fuera, precisión sub-micrométrica dentro.
  const rounded = Math.round(value * 1e6) / 1e6;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

export function segmentsToPathData(segments: PathSegment[]): string {
  return segments
    .map((segment) => {
      switch (segment.type) {
        case "M":
        case "L":
          return `${segment.type}${formatCoordinate(segment.x)} ${formatCoordinate(segment.y)}`;
        case "C":
          return `C${formatCoordinate(segment.x1)} ${formatCoordinate(segment.y1)} ${formatCoordinate(segment.x2)} ${formatCoordinate(segment.y2)} ${formatCoordinate(segment.x)} ${formatCoordinate(segment.y)}`;
        case "Z":
          return "Z";
      }
    })
    .join(" ");
}

/**
 * "Hornear" una matriz en la path data: devuelve un `d` nuevo (absoluto,
 * M/L/C/Z) con la matriz aplicada a cada punto -- las curvas siguen siendo
 * curvas (una afín mapea cúbicas a cúbicas, exacto). Identidad -> devuelve `d`
 * tal cual (no degrada geometría con un bake trivial). Entrada mal formada o
 * vacía -> `d` original, sin lanzar (un path que no se pudo leer no se destruye).
 */
export function transformPathData(d: string, matrix: AffineMatrix): string {
  if (isIdentityMatrix(matrix)) return d;
  const parsed = parsePathDataCached(d);
  if (parsed.error !== null || parsed.segments.length === 0) return d;
  return segmentsToPathData(transformSegments(parsed.segments, matrix));
}

// ---- Bounding box ----

/** Raíces en (0,1) de la derivada de una cúbica 1D (a·t² + b·t + c = 0 con los coeficientes de la derivada/3). */
function cubicExtremaParameters(p0: number, p1: number, p2: number, p3: number): number[] {
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const roots: number[] = [];

  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) roots.push(-c / b);
  } else {
    const discriminant = b * b - 4 * a * c;
    if (discriminant >= 0) {
      const sqrt = Math.sqrt(discriminant);
      roots.push((-b + sqrt) / (2 * a), (-b - sqrt) / (2 * a));
    }
  }
  return roots.filter((t) => t > 0 && t < 1);
}

function cubicAt(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const mt = 1 - t;
  return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3;
}

/** Bbox de segmentos ya en el espacio deseado: incluye los extremos de las curvas, no solo los puntos de control. `null` si no dibujan nada. */
export function segmentsBounds(segments: PathSegment[]): Rect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let currentX = 0;
  let currentY = 0;
  let startX = 0;
  let startY = 0;

  const include = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };

  for (const segment of segments) {
    switch (segment.type) {
      case "M":
        currentX = startX = segment.x;
        currentY = startY = segment.y;
        break;
      case "L":
        include(currentX, currentY);
        include(segment.x, segment.y);
        currentX = segment.x;
        currentY = segment.y;
        break;
      case "C": {
        include(currentX, currentY);
        include(segment.x, segment.y);
        const ts = [
          ...cubicExtremaParameters(currentX, segment.x1, segment.x2, segment.x),
          ...cubicExtremaParameters(currentY, segment.y1, segment.y2, segment.y),
        ];
        for (const t of ts) {
          include(
            cubicAt(currentX, segment.x1, segment.x2, segment.x, t),
            cubicAt(currentY, segment.y1, segment.y2, segment.y, t),
          );
        }
        currentX = segment.x;
        currentY = segment.y;
        break;
      }
      case "Z":
        if (currentX !== startX || currentY !== startY) {
          include(currentX, currentY);
          include(startX, startY);
        }
        currentX = startX;
        currentY = startY;
        break;
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Bbox EXACTO de un path (con la matriz opcional ya aplicada): primero se
 * transforman los puntos de control (una afín mapea cúbicas a cúbicas) y
 * después se buscan los extremos de cada curva -- así el bbox de una curva
 * rotada también es exacto, no el bbox de su bbox. `null` si el path está
 * vacío, no dibuja nada o no se pudo leer ni un segmento.
 */
export function pathBounds(d: string, matrix?: AffineMatrix): Rect | null {
  const parsed = parsePathDataCached(d);
  if (parsed.segments.length === 0) return null;
  const segments = matrix && !isIdentityMatrix(matrix) ? transformSegments(parsed.segments, matrix) : parsed.segments;
  return segmentsBounds(segments);
}

// ---- Aplanado (hit-testing) ----

/** Subpath como polilínea; `closed` es true si terminó con Z (el relleno siempre lo cierra implícitamente). */
export interface Polyline {
  points: Point[];
  closed: boolean;
}

const MAX_CUBIC_STEPS = 64;

/** Aplana segmentos a polilíneas con error de flecha ≤ `flatness` (unidades del espacio de los segmentos). */
export function flattenSegments(segments: PathSegment[], flatness = 0.05): Polyline[] {
  const polylines: Polyline[] = [];
  let current: Polyline | null = null;
  let currentX = 0;
  let currentY = 0;
  let startX = 0;
  let startY = 0;

  const ensurePolyline = () => {
    if (!current) {
      current = { points: [{ x: currentX, y: currentY }], closed: false };
      polylines.push(current);
    }
    return current;
  };

  for (const segment of segments) {
    switch (segment.type) {
      case "M":
        current = { points: [{ x: segment.x, y: segment.y }], closed: false };
        polylines.push(current);
        currentX = startX = segment.x;
        currentY = startY = segment.y;
        break;
      case "L":
        ensurePolyline().points.push({ x: segment.x, y: segment.y });
        currentX = segment.x;
        currentY = segment.y;
        break;
      case "C": {
        const polyline = ensurePolyline();
        const deviation = Math.max(
          Math.hypot(currentX - 2 * segment.x1 + segment.x2, currentY - 2 * segment.y1 + segment.y2),
          Math.hypot(segment.x1 - 2 * segment.x2 + segment.x, segment.y1 - 2 * segment.y2 + segment.y),
        );
        const steps = Math.min(MAX_CUBIC_STEPS, Math.max(1, Math.ceil(Math.sqrt((0.75 * deviation) / flatness))));
        for (let step = 1; step <= steps; step += 1) {
          const t = step / steps;
          polyline.points.push({
            x: cubicAt(currentX, segment.x1, segment.x2, segment.x, t),
            y: cubicAt(currentY, segment.y1, segment.y2, segment.y, t),
          });
        }
        currentX = segment.x;
        currentY = segment.y;
        break;
      }
      case "Z":
        if (current) (current as Polyline).closed = true;
        current = null;
        currentX = startX;
        currentY = startY;
        break;
    }
  }

  return polylines;
}

/** Regla de relleno no-cero (default de SVG) sobre polilíneas (cada una cerrada implícitamente). */
export function pointInPolylinesNonZero(polylines: Polyline[], point: Point): boolean {
  let winding = 0;
  for (const { points } of polylines) {
    const count = points.length;
    if (count < 3) continue;
    for (let index = 0; index < count; index += 1) {
      const p1 = points[index];
      const p2 = points[(index + 1) % count];
      if (p1.y <= point.y) {
        if (p2.y > point.y && cross(p1, p2, point) > 0) winding += 1;
      } else if (p2.y <= point.y && cross(p1, p2, point) < 0) {
        winding -= 1;
      }
    }
  }
  return winding !== 0;
}

function cross(p1: Point, p2: Point, point: Point): number {
  return (p2.x - p1.x) * (point.y - p1.y) - (point.x - p1.x) * (p2.y - p1.y);
}

/**
 * Distancia mínima del punto al contorno de las polilíneas. Por defecto incluye el lado de cierre implícito de cada subpath (el relleno
 * siempre cierra); con `respectOpen` (objetos SIN relleno, M3-S04) un subpath que no terminó en Z queda abierto: no existe el lado que
 * une su último punto con el primero.
 */
export function distanceToPolylines(polylines: Polyline[], point: Point, respectOpen = false): number {
  let best = Infinity;
  for (const { points, closed } of polylines) {
    const count = points.length;
    if (count === 1) {
      best = Math.min(best, Math.hypot(point.x - points[0].x, point.y - points[0].y));
      continue;
    }
    const segmentCount = respectOpen ? (closed ? count : count - 1) : closed || count > 2 ? count : count - 1;
    for (let index = 0; index < segmentCount; index += 1) {
      best = Math.min(best, distanceToSegment(points[index], points[(index + 1) % count], point));
    }
  }
  return best;
}

function distanceToSegment(p1: Point, p2: Point, point: Point): number {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - p1.x, point.y - p1.y);
  const t = Math.max(0, Math.min(1, ((point.x - p1.x) * dx + (point.y - p1.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (p1.x + t * dx), point.y - (p1.y + t * dy));
}
