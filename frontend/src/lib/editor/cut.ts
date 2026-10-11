import { IDENTITY_MATRIX } from "../svgTransform";
import type { GeometryPiece, GeometrySubject, SplitMode, SplitRequest, SplitResponse } from "../../types/geometry";
import { describeOperand, paintOrderIds, pieceArea, type BooleanShape } from "./boolean";
import { segmentsIntersect } from "./draw";
import {
  DEFAULT_FLATNESS_MM,
  MAX_SERVER_SUBJECTS,
  MAX_SERVER_VERTICES,
  geometryErrorMessage,
  matrixScale,
  objectGeometry,
  pieceToPathData,
  toDocumentUnits,
  unitScale,
  validPiece,
  type UnitScale,
} from "./geometry";
import { isUnfilled, objectBounds, objectPolylines } from "./objects";
import { formatPanelValue, serialOf } from "./offset";
import type { EditableDocument, EditorObject, EditProduction, Point } from "./types";

/**
 * Cut / Split de geometría del editor (M3-S10): parte los objetos con una LÍNEA DE CORTE (polilínea dibujada en el canvas) y produce piezas válidas e
 * independientes. Lógica pura (sin React ni Konva): arma la petición al servicio de geometría (`POST /api/v2/geometry/split`, Shapely/GEOS, misma
 * infraestructura de S04/S08/S09) y convierte su respuesta en UN comando.
 *
 * Decisiones (documentadas también en `docs/ADR_EDITOR_MVP3.md`):
 * 1. **Dos modos explícitos.** *Dividir* (`split`): el objeto se parte a lo largo de la línea y las piezas COMPARTEN el borde del corte. *Separar con hueco*
 *    (`slot`): se resta una ranura de ancho configurable en **mm** (default 0,2 mm) centrada en la línea y las piezas quedan físicamente separadas (láser).
 * 2. **Un corte que no atraviesa NO divide.** Sin «Extender el corte hasta cruzar todo» una línea que termina DENTRO de una forma la deja intacta (en los dos
 *    modos: una ranura que no separa solo haría una muesca) y el panel lo dice con el nombre del objeto. Con «Extender» el primer y el último tramo se
 *    prolongan lo necesario. El servidor es quien decide si el objeto quedó separado (`changed`); el cliente nunca lo adivina.
 * 3. **Alcance explícito.** Con selección, solo los objetos seleccionados. Sin selección, TODOS los objetos visibles y desbloqueados que la línea cruza (se
 *    listan antes de aplicar). Los objetos en capas bloqueadas u ocultas se OMITEN e informan (no se rechaza la operación completa: no son operandos que se consumen).
 * 4. **Resultado.** Cada pieza disjunta es un objeto nuevo (id nuevo, **misma capa** y mismo `fill`/`stroke` del objeto de origen, sin matriz, huecos como
 *    subpaths): no hay decisión de capa. Las piezas ocupan el lugar del original (orden de pintado). Un objeto que el corte no separa conserva su `d`,
 *    su matriz y su id. Piezas despreciables (área < tolerancia², largo <= tolerancia) se descartan y se informan.
 * 5. **Nada en silencio.** Se informa por objeto cuántas piezas salen, los que el corte toca sin atravesar, los que no toca, los omitidos por capa y lo descartado.
 *    Si NINGÚN objeto cambia Apply queda deshabilitado con la explicación. Un error o una respuesta incoherente del servidor no modifica nada.
 * 6. **Precisión.** Los objetos se aplanan con su matriz horneada a la tolerancia (0,01 mm); las piezas son polilíneas (no preservan los Bézier).
 */

export const CUT_MODES: readonly SplitMode[] = ["split", "slot"];

export const CUT_MODE_INFO: Record<SplitMode, { label: string; description: string }> = {
  split: { label: "Dividir", description: "Parte la forma a lo largo de la línea: las piezas comparten el borde del corte." },
  slot: { label: "Separar con hueco", description: "Quita una ranura del ancho indicado centrada en la línea: las piezas quedan físicamente separadas (láser)." },
};

/** Ancho de la ranura del modo «Separar con hueco»: default, mínimo (la tolerancia de aplanado) y máximo del campo, en mm (o u sin escala física). */
export const DEFAULT_SLOT_WIDTH_MM = 0.2;
export const MIN_SLOT_WIDTH_MM = DEFAULT_FLATNESS_MM;
export const MAX_SLOT_WIDTH_MM = 100;
/** Tolerancia de aplanado y de pieza despreciable del corte (mm): la de todo el servicio de geometría. */
export const CUT_TOLERANCE_MM = DEFAULT_FLATNESS_MM;
/** Espejo de `Geometry:MaxCutterPoints` del backend. */
export const MAX_CUTTER_POINTS = 10_000;
/** Espejo de `Geometry:MaxOffsetDistance`, que acota también el ancho de la ranura (unidades de documento). */
const MAX_SERVER_SLOT_UNITS = 1_000_000;

/** Colores con los que el preview distingue las piezas de UN mismo objeto (la pieza n de cada objeto lleva el color n, módulo la paleta). */
export const CUT_PIECE_COLORS: readonly string[] = ["#2563eb", "#16a34a", "#d97706", "#9333ea", "#0891b2", "#db2777", "#65a30d", "#dc2626"];

export const NO_SCALE_NOTICE = "Sin escala física: el corte es en unidades del documento (u), no en mm.";

export const LINE_HELP =
  "Dibujá la línea de corte: click por cada punto, doble click o Enter termina, Retroceso quita el último punto y Escape cancela. Arrastrá para trazar un segmento recto.";

const NOTHING_CHANGED = "No se modificó nada.";

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

// ---- La línea de corte ----

function samePoint(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y;
}

/** La línea sin puntos consecutivos repetidos (un doble click suma el mismo punto dos veces). */
export function dedupeCutPoints(points: readonly Point[]): Point[] {
  const cleaned: Point[] = [];
  for (const point of points) {
    if (cleaned.length === 0 || !samePoint(cleaned[cleaned.length - 1], point)) cleaned.push(point);
  }
  return cleaned;
}

/** Largo total de una polilínea (unidades de documento). */
export function polylineLength(points: readonly Point[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) total += Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y);
  return total;
}

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function pointsBox(points: readonly Point[]): Box {
  return {
    minX: Math.min(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxX: Math.max(...points.map((point) => point.x)),
    maxY: Math.max(...points.map((point) => point.y)),
  };
}

/** Cuánto hay que prolongar los extremos para cruzar todo: la diagonal de lo involucrado (línea + objetos) más 1. Igual criterio que el servidor. */
export function cutReach(line: readonly Point[], objects: readonly EditorObject[]): number {
  const box = pointsBox(line);
  for (const object of objects) {
    const rect = objectBounds(object);
    if (!rect) continue;
    box.minX = Math.min(box.minX, rect.x);
    box.minY = Math.min(box.minY, rect.y);
    box.maxX = Math.max(box.maxX, rect.x + rect.width);
    box.maxY = Math.max(box.maxY, rect.y + rect.height);
  }
  return Math.hypot(box.maxX - box.minX, box.maxY - box.minY) + 1;
}

/** El primer y el último tramo de la línea prolongados `reach` en su propia dirección. Los vértices intermedios no se mueven. Necesita >= 2 puntos distintos. */
export function extendCutLine(points: readonly Point[], reach: number): Point[] {
  const line = dedupeCutPoints(points);
  if (line.length < 2) return line;
  const push = (from: Point, to: Point): Point => {
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    return { x: to.x + ((to.x - from.x) / length) * reach, y: to.y + ((to.y - from.y) / length) * reach };
  };
  const first = push(line[1], line[0]);
  const last = push(line[line.length - 2], line[line.length - 1]);
  return [first, ...line.slice(1, -1), last];
}

/** ¿La línea cruza o toca el contorno del objeto? (bbox primero; un relleno se cierra implícitamente). No cuenta una línea que queda toda dentro sin tocar el borde. */
function lineTouchesOutline(object: EditorObject, line: readonly Point[], lineBox: Box): boolean {
  const box = objectBounds(object);
  if (!box) return false;
  if (box.x > lineBox.maxX || box.x + box.width < lineBox.minX || box.y > lineBox.maxY || box.y + box.height < lineBox.minY) return false;
  const unfilled = isUnfilled(object.fill);
  for (const polyline of objectPolylines(object)) {
    const points = polyline.points;
    if (points.length < 2) continue;
    const edges = !unfilled || polyline.closed ? points.length : points.length - 1;
    for (let edge = 0; edge < edges; edge += 1) {
      const a = points[edge];
      const b = points[(edge + 1) % points.length];
      for (let index = 0; index < line.length - 1; index += 1) if (segmentsIntersect(a, b, line[index], line[index + 1])) return true;
    }
  }
  return false;
}

// ---- Alcance ----

export interface CutScope {
  /** `selection` = solo la selección; `crossed` = sin selección, todos los objetos visibles y desbloqueados que la línea cruza. */
  kind: "selection" | "crossed";
  /** Objetos que se cortan, en orden de PINTADO. */
  objects: EditorObject[];
  /** Objetos en capas bloqueadas / ocultas que el corte alcanzaría: se omiten e informan. */
  omittedLocked: EditorObject[];
  omittedHidden: EditorObject[];
}

/**
 * Alcance del corte. Con selección: solo esos objetos (los de capas bloqueadas u ocultas se omiten e informan). Sin selección: todos los objetos cuyo contorno
 * cruza la línea (`line` ya extendida si corresponde), repartidos igual. `selection` se resuelve contra `document` por id.
 */
export function cutScope(selection: readonly EditorObject[], document: EditableDocument, line: readonly Point[]): CutScope {
  const layers = document.layers ?? [];
  const lockedIds = new Set(layers.filter((layer) => layer.locked).map((layer) => layer.groupId));
  const hiddenIds = new Set(layers.filter((layer) => !layer.visible).map((layer) => layer.groupId));

  const current = new Map<string, EditorObject>();
  for (const objects of Object.values(document.objectsByLayer)) for (const object of objects) current.set(object.id, object);
  const live = [...new Map(selection.map((object) => [object.id, object])).values()].flatMap((object) => {
    const found = current.get(object.id);
    return found ? [found] : [];
  });

  const kind: CutScope["kind"] = live.length > 0 ? "selection" : "crossed";
  let pool: EditorObject[];
  if (kind === "selection") {
    pool = live;
  } else {
    const lineBox = pointsBox(line);
    pool = Object.values(document.objectsByLayer)
      .flat()
      .filter((object) => lineTouchesOutline(object, line, lineBox));
  }

  const objects: EditorObject[] = [];
  const omittedLocked: EditorObject[] = [];
  const omittedHidden: EditorObject[] = [];
  for (const object of pool) {
    if (hiddenIds.has(object.layerGroupId)) omittedHidden.push(object);
    else if (lockedIds.has(object.layerGroupId)) omittedLocked.push(object);
    else objects.push(object);
  }
  const byId = new Map(objects.map((object) => [object.id, object]));
  return { kind, objects: paintOrderIds([...byId.keys()], document).map((id) => byId.get(id)!), omittedLocked, omittedHidden };
}

// ---- Plan ----

export type CutRejection = "line_missing" | "line_invalid" | "too_many_points" | "invalid_slot_width" | "no_targets" | "invalid_geometry" | "too_many";

export interface CutRejectionInfo {
  ok: false;
  reason: CutRejection;
  message: string;
}

function reject(reason: CutRejection, message: string): CutRejectionInfo {
  return { ok: false, reason, message };
}

export interface CutOptions {
  /** Puntos de la línea de corte tal como se dibujaron (unidades de documento). */
  line: readonly Point[];
  mode: SplitMode;
  /** Ancho de la ranura en mm (o u sin escala física); solo cuenta en el modo `slot`. */
  slotWidthMm: number;
  extend: boolean;
  /** mm por unidad de documento, o `null` sin escala física (el panel opera en unidades y avisa). */
  mmFactor: number | null;
}

export interface LineCutPlan {
  /** Objetos que se mandan al servidor, en orden de pintado (referencias del documento al planear: si cambian, no se aplica nada). */
  objects: EditorObject[];
  /** Por cada subject de la petición, el índice de su objeto en `objects` (un objeto sin relleno aporta un subject por subpath). */
  owners: number[];
  request: SplitRequest;
  /** Identifica la PETICIÓN (línea, modo, ancho, extensión, tolerancia y objetos): igual clave => mismo resultado, no hace falta volver a pedirlo. */
  requestKey: string;
  scope: CutScope["kind"];
  mode: SplitMode;
  extend: boolean;
  /** Ancho de la ranura en el panel (mm o u) y su unidad. */
  slotWidthMm: number;
  unit: UnitScale;
  mmFactor: number | null;
  scaleNotice: string | null;
  /** La línea efectiva (con los extremos prolongados si se pidió «Extender»), para dibujarla. */
  effectiveLine: Point[];
  /** Nombre legible de cada objeto («Rojo · objeto 2»), por id. */
  names: Record<string, string>;
  omittedLocked: number;
  omittedHidden: number;
  /** Objetos cuya geometría no se pudo enviar (path ilegible): se omiten e informan. */
  skippedInvalid: number;
}

export type LineCutPlanResult = { ok: true; plan: LineCutPlan } | CutRejectionInfo;

/**
 * Arma la petición de un corte. `selection` son los objetos seleccionados (cualquier orden; vacío = «todos los que la línea cruza»). Rechaza, con el motivo, lo
 * que no se pueda hacer sin adivinar: línea sin 2 puntos distintos o con coordenadas no finitas, ranura fuera de rango, nada que cortar, demasiada geometría.
 */
export function planLineCut(selection: readonly EditorObject[], document: EditableDocument, options: CutOptions): LineCutPlanResult {
  const line = dedupeCutPoints(options.line);
  if (line.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
    return reject("line_invalid", `La línea de corte tiene coordenadas no válidas. ${NOTHING_CHANGED}`);
  }
  if (line.length < 2) return reject("line_missing", LINE_HELP);
  if (line.length > MAX_CUTTER_POINTS) {
    return reject("too_many_points", `La línea de corte tiene demasiados puntos (${line.length}; el máximo es ${MAX_CUTTER_POINTS.toLocaleString("es-AR")}). ${NOTHING_CHANGED}`);
  }

  const unit = unitScale(options.mmFactor);
  const slotWidthUnits = toDocumentUnits(options.slotWidthMm, unit);
  if (options.mode === "slot") {
    if (!Number.isFinite(options.slotWidthMm) || options.slotWidthMm < MIN_SLOT_WIDTH_MM || options.slotWidthMm > MAX_SLOT_WIDTH_MM) {
      return reject(
        "invalid_slot_width",
        `El ancho de la ranura tiene que estar entre ${MIN_SLOT_WIDTH_MM.toLocaleString("es-AR")} y ${MAX_SLOT_WIDTH_MM.toLocaleString("es-AR")} ${unit.label}. ${NOTHING_CHANGED}`,
      );
    }
    if (!(slotWidthUnits <= MAX_SERVER_SLOT_UNITS)) {
      return reject("invalid_slot_width", `Con la escala de este documento esa ranura supera el máximo que acepta el servidor. Usá una menor. ${NOTHING_CHANGED}`);
    }
  }

  // Sin selección el alcance depende de dónde cae la línea; con «Extender» se evalúa la línea ya prolongada sobre todo el documento.
  const effectiveLine = options.extend ? extendCutLine(line, cutReach(line, Object.values(document.objectsByLayer).flat())) : line;
  const scope = cutScope(selection, document, effectiveLine);

  if (scope.objects.length === 0) {
    const omitted = scope.omittedLocked.length + scope.omittedHidden.length;
    const why =
      scope.kind === "selection"
        ? `Los objetos seleccionados están en capas bloqueadas u ocultas: no se pueden cortar. Desbloqueá o mostrá las capas en el panel de Capas.`
        : omitted > 0
          ? `La línea solo cruza objetos de capas bloqueadas u ocultas (${omitted}): se omiten y no se modifican. Desbloqueá o mostrá las capas en el panel de Capas.`
          : "La línea de corte no cruza ningún objeto visible y desbloqueado. Dibujala sobre las formas que querés cortar o seleccionalas antes de abrir Cut.";
    return reject("no_targets", `${why} ${NOTHING_CHANGED}`);
  }

  const tolerance = toDocumentUnits(CUT_TOLERANCE_MM, unit);
  const subjects: GeometrySubject[] = [];
  const owners: number[] = [];
  const objects: EditorObject[] = [];
  let vertices = line.length;
  let skippedInvalid = 0;
  for (const object of scope.objects) {
    const geometry = objectGeometry(object, tolerance);
    if (!geometry) {
      skippedInvalid += 1;
      continue;
    }
    const index = objects.push(object) - 1;
    for (const subject of geometry.subjects) {
      subjects.push(subject);
      owners.push(index);
    }
    vertices += geometry.vertexCount;
  }
  if (objects.length === 0) {
    return reject("invalid_geometry", `Los objetos a cortar no tienen una geometría que se pueda procesar (path ilegible o sin área). ${NOTHING_CHANGED}`);
  }
  if (subjects.length > MAX_SERVER_SUBJECTS) {
    return reject("too_many", `Son demasiados objetos (${subjects.length} contornos; el máximo es ${MAX_SERVER_SUBJECTS}). Seleccioná menos objetos. ${NOTHING_CHANGED}`);
  }
  if (vertices > MAX_SERVER_VERTICES) {
    return reject(
      "too_many",
      `La geometría a cortar es demasiado grande (${vertices.toLocaleString("es-AR")} vértices; el máximo es ${MAX_SERVER_VERTICES.toLocaleString("es-AR")}). Seleccioná menos objetos. ${NOTHING_CHANGED}`,
    );
  }

  const request: SplitRequest = {
    subjects,
    cutter: { points: line.map((point): [number, number] => [point.x, point.y]) },
    mode: options.mode,
    slotWidth: options.mode === "slot" ? slotWidthUnits : 0,
    extend: options.extend,
    tolerance,
  };
  const names: Record<string, string> = {};
  for (const object of objects) names[object.id] = describeOperand(object, 0, document).name;

  return {
    ok: true,
    plan: {
      objects,
      owners,
      request,
      requestKey: `cut|${request.mode}|${request.slotWidth}|${request.extend}|${request.tolerance}|${line.map((point) => `${point.x},${point.y}`).join(";")}|${objects
        .map((object) => `${object.id}#${serialOf(object)}`)
        .join(",")}`,
      scope: scope.kind,
      mode: options.mode,
      extend: options.extend,
      slotWidthMm: options.slotWidthMm,
      unit,
      mmFactor: options.mmFactor,
      scaleNotice: unit.label === "mm" ? null : NO_SCALE_NOTICE,
      effectiveLine,
      names,
      omittedLocked: scope.omittedLocked.length,
      omittedHidden: scope.omittedHidden.length,
      skippedInvalid,
    },
  };
}

// ---- Validación de la respuesta ----

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Defensa del cliente (el editor NUNCA crea geometría inválida): la respuesta tiene que corresponder a LA petición -- mismos parámetros, una entrada por
 * subject en orden, piezas del tipo del subject (un polígono da polígonos, una línea da líneas) con anillos cerrados y coordenadas finitas, y los datos que se
 * le muestran al usuario (tocado, separado, piezas, descartadas) coherentes entre sí. `null` si es coherente; si no, el motivo.
 */
export function validateCutResponse(request: SplitRequest, response: SplitResponse): string | null {
  if (!response || !Array.isArray(response.results)) return "la respuesta no trae resultados";
  if (response.mode !== request.mode || response.slotWidth !== request.slotWidth || response.extend !== request.extend) return "la respuesta usa otro modo, ancho de ranura o extensión";
  if (response.results.length !== request.subjects.length) return `trae ${response.results.length} resultados y se esperaban ${request.subjects.length}`;

  let pieces = 0;
  for (let index = 0; index < response.results.length; index += 1) {
    const item = response.results[index];
    if (!item || !Array.isArray(item.pieces)) return "un resultado no trae piezas";
    if (item.subjectIndex !== index) return "un resultado no corresponde a su subject";
    for (const piece of item.pieces) {
      const problem = validPiece(piece, request.subjects[index].type);
      if (problem) return problem;
    }
    if (item.pieceCount !== item.pieces.length) return "la cantidad de piezas no coincide con la geometría";
    if (typeof item.changed !== "boolean" || typeof item.touched !== "boolean") return "un resultado no dice si el corte lo toca o lo separa";
    if (item.changed && (!item.touched || item.pieces.length < 2)) return "un objeto figura como separado sin tocarlo o con menos de 2 piezas";
    if (!isCount(item.discarded) || (!item.changed && item.discarded !== 0)) return "el conteo de piezas descartadas es incoherente";
    pieces += item.pieces.length;
  }
  if (response.pieceCount !== pieces) return "la cantidad total de piezas no coincide con la geometría";
  return null;
}

// ---- Resultado ----

/** `cut`: el corte lo separa en piezas; `intact`: lo toca pero no lo atraviesa; `untouched`: ni lo toca. */
export type CutObjectStatus = "cut" | "intact" | "untouched";

export interface CutPiece extends BooleanShape {
  /** Es una polilínea abierta (objeto sin relleno) y no un polígono. */
  line: boolean;
}

export interface CutObjectOutcome {
  object: EditorObject;
  status: CutObjectStatus;
  /** Piezas nuevas (polilíneas aplanadas), en el orden determinista del servidor. Vacío si el objeto no se corta. */
  shapes: CutPiece[];
  /** Piezas despreciables que se descartaron de un objeto que sí se corta. */
  discarded: number;
}

export interface CutOutcome {
  objects: CutObjectOutcome[];
  cutCount: number;
  intactCount: number;
  untouchedCount: number;
  /** Piezas nuevas en total. */
  pieceCount: number;
  discarded: number;
  /** Ningún objeto cambia: no hay nada que aplicar. */
  nothingToApply: boolean;
}

function lineLength(piece: GeometryPiece): number {
  if (piece.type !== "line") return 0;
  let total = 0;
  for (let index = 1; index < piece.coordinates.length; index += 1) {
    total += Math.hypot(piece.coordinates[index][0] - piece.coordinates[index - 1][0], piece.coordinates[index][1] - piece.coordinates[index - 1][1]);
  }
  return total;
}

/**
 * Lo que dice la respuesta del servidor para este plan: sirve igual para la previsualización y para aplicar (así lo que se ve es lo que se aplica). Una pieza
 * con área < tolerancia² (largo <= tolerancia en una línea) se descarta e informa; si de un objeto «cortado» quedan menos de 2 piezas útiles, el corte no lo
 * separa de verdad y el objeto queda intacto. Una pieza que no se pueda escribir como `d` válido invalida TODO el resultado.
 */
export function cutOutcome(plan: LineCutPlan, response: SplitResponse): { ok: true; outcome: CutOutcome } | { ok: false; error: string } {
  const invalid = validateCutResponse(plan.request, response);
  if (invalid) return { ok: false, error: `El servidor devolvió una respuesta incoherente (${invalid}). ${NOTHING_CHANGED}` };

  const minArea = plan.request.tolerance * plan.request.tolerance;
  const objects: CutObjectOutcome[] = [];
  for (let index = 0; index < plan.objects.length; index += 1) {
    const items = response.results.filter((_, subject) => plan.owners[subject] === index);
    const touched = items.some((item) => item.touched);
    if (!items.some((item) => item.changed)) {
      objects.push({ object: plan.objects[index], status: touched ? "intact" : "untouched", shapes: [], discarded: 0 });
      continue;
    }
    const shapes: CutPiece[] = [];
    let discarded = 0;
    for (const item of items) {
      discarded += item.changed ? item.discarded : 0;
      for (const piece of item.pieces) {
        const d = pieceToPathData(piece);
        if (d === null) return { ok: false, error: `El servidor devolvió una pieza que no se puede dibujar. ${NOTHING_CHANGED}` };
        if (piece.type === "polygon" ? !(pieceArea(piece) >= minArea) : !(lineLength(piece) > plan.request.tolerance)) {
          discarded += 1;
          continue;
        }
        shapes.push({ d, matrix: IDENTITY_MATRIX, line: piece.type === "line" });
      }
    }
    if (shapes.length < 2) {
      objects.push({ object: plan.objects[index], status: "intact", shapes: [], discarded: 0 });
      continue;
    }
    objects.push({ object: plan.objects[index], status: "cut", shapes, discarded });
  }

  const cutCount = objects.filter((entry) => entry.status === "cut").length;
  return {
    ok: true,
    outcome: {
      objects,
      cutCount,
      intactCount: objects.filter((entry) => entry.status === "intact").length,
      untouchedCount: objects.filter((entry) => entry.status === "untouched").length,
      pieceCount: objects.reduce((total, entry) => total + entry.shapes.length, 0),
      discarded: objects.reduce((total, entry) => total + entry.discarded, 0),
      nothingToApply: cutCount === 0,
    },
  };
}

// ---- Textos del panel ----

const MAX_LISTED = 6;

function listNames(names: readonly string[], quote: boolean): string {
  const shown = names.slice(0, MAX_LISTED).map((name) => (quote ? `«${name}»` : name));
  return `${shown.join(", ")}${names.length > MAX_LISTED ? ` y ${names.length - MAX_LISTED} más` : ""}`;
}

function namesOf(plan: LineCutPlan, outcome: CutOutcome, status: CutObjectStatus): string[] {
  return outcome.objects.filter((entry) => entry.status === status).map((entry) => plan.names[entry.object.id] ?? "Objeto");
}

export interface CutWarning {
  kind: "intact" | "untouched" | "locked" | "hidden" | "invalid" | "discarded";
  text: string;
}

/** Avisos que se muestran ANTES de confirmar: nada se omite en silencio. */
export function cutWarnings(plan: LineCutPlan, outcome: CutOutcome): CutWarning[] {
  const warnings: CutWarning[] = [];
  if (outcome.intactCount > 0) {
    const names = namesOf(plan, outcome, "intact");
    warnings.push({
      kind: "intact",
      text: `El corte no atraviesa completamente ${listNames(names, true)}: ${names.length === 1 ? "queda intacto" : "quedan intactos"}.${plan.extend ? "" : " Prolongá la línea o activá «Extender el corte hasta cruzar todo»."}`,
    });
  }
  if (outcome.untouchedCount > 0 && plan.scope === "selection") {
    const names = namesOf(plan, outcome, "untouched");
    warnings.push({ kind: "untouched", text: `${listNames(names, true)} ${names.length === 1 ? "no toca" : "no tocan"} la línea de corte: ${names.length === 1 ? "queda intacto" : "quedan intactos"}.` });
  }
  if (plan.omittedLocked > 0) {
    warnings.push({ kind: "locked", text: `${plural(plan.omittedLocked, "objeto en una capa bloqueada se omite", "objetos en capas bloqueadas se omiten")}: no se modifica.` });
  }
  if (plan.omittedHidden > 0) {
    warnings.push({ kind: "hidden", text: `${plural(plan.omittedHidden, "objeto en una capa oculta se omite", "objetos en capas ocultas se omiten")}: no se modifica.` });
  }
  if (plan.skippedInvalid > 0) {
    warnings.push({ kind: "invalid", text: `${plural(plan.skippedInvalid, "objeto no se pudo procesar", "objetos no se pudieron procesar")} y se omite.` });
  }
  if (outcome.discarded > 0) {
    warnings.push({ kind: "discarded", text: `${plural(outcome.discarded, "pieza despreciable descartada", "piezas despreciables descartadas")}.` });
  }
  return warnings;
}

/** Texto de estado de una previsualización lista: «Se cortarán 2 objetos: …» o por qué no hay nada que cortar. */
export function cutReadyText(plan: LineCutPlan, outcome: CutOutcome): string {
  if (outcome.nothingToApply) return "Ningún objeto cambia con este corte.";
  const names = namesOf(plan, outcome, "cut");
  return `Se cortarán ${plural(outcome.cutCount, "objeto", "objetos")}: ${listNames(names, false)}. Resultado: ${plural(outcome.pieceCount, "pieza", "piezas")}.`;
}

/**
 * Por qué NO se puede aplicar todavía (texto para el botón y el panel), o `null` si Apply está habilitado. Si ningún objeto cambia se explica por qué
 * (el corte no atraviesa, o no cruza nada) y qué hacer.
 */
export function cutApplyBlock(plan: LineCutPlan, outcome: CutOutcome | null): string | null {
  if (!outcome) return "Esperando el resultado del servidor…";
  if (!outcome.nothingToApply) return null;
  if (outcome.intactCount > 0) {
    return `El corte no atraviesa completamente ${listNames(namesOf(plan, outcome, "intact"), true)}: ningún objeto cambia. ${
      plan.extend ? "Prolongá la línea hasta salir de la forma." : "Prolongá la línea o activá «Extender el corte hasta cruzar todo»."
    }`;
  }
  return `La línea de corte no toca ${plan.scope === "selection" ? "ningún objeto de la selección" : "ningún objeto"}: no hay nada que cortar.`;
}

// ---- Aplicar ----

export interface CutSummary {
  mode: SplitMode;
  slotWidthMm: number;
  unit: UnitScale;
  /** Objetos cortados / piezas nuevas. */
  cutCount: number;
  pieceCount: number;
  intactCount: number;
  untouchedCount: number;
  omittedLocked: number;
  omittedHidden: number;
  skippedInvalid: number;
  discarded: number;
}

export type CutApplicationCode = "nothing_to_cut" | "stale" | "blocked" | "invalid_response";

export type CutApplication =
  | { ok: true; production: EditProduction; summary: CutSummary; resultIds: string[]; activeGroupId: string }
  | { ok: false; code: CutApplicationCode; error: string };

function defaultCreateId(): string {
  return crypto.randomUUID();
}

/**
 * Convierte la respuesta del servidor en UN comando (`EditProduction` atómica). Todo o nada:
 * - la respuesta debe corresponder a la petición (`cutOutcome`) y los objetos deben seguir siendo los mismos (por referencia): si el documento cambió mientras
 *   se calculaba, el resultado ya no lo describe y se descarta;
 * - si ningún objeto se corta no hay nada que aplicar;
 * - si una capa de un objeto que se corta se bloqueó u ocultó mientras tanto, se rechaza.
 * Cada pieza es un objeto nuevo (id nuevo, sin matriz, mismo `fill`/`stroke` y MISMA capa que su original) y ocupa el lugar del original en el orden de pintado.
 * Un objeto que no se corta no se toca: conserva su `d`, su matriz y su id.
 */
export function applyCutResult(plan: LineCutPlan, state: EditableDocument, response: SplitResponse, options: { createId?: () => string } = {}): CutApplication {
  const createId = options.createId ?? defaultCreateId;
  const outcomeResult = cutOutcome(plan, response);
  if (!outcomeResult.ok) return { ok: false, code: "invalid_response", error: outcomeResult.error };
  const { outcome } = outcomeResult;
  if (outcome.nothingToApply) {
    return { ok: false, code: "nothing_to_cut", error: `${cutApplyBlock(plan, outcome)} ${NOTHING_CHANGED}` };
  }

  for (const object of plan.objects) {
    if (!(state.objectsByLayer[object.layerGroupId] ?? []).includes(object)) {
      return { ok: false, code: "stale", error: `El documento cambió mientras se calculaba. ${NOTHING_CHANGED} Revisá el resultado y volvé a aplicar.` };
    }
  }
  const layers = state.layers ?? [];
  const cutting = outcome.objects.filter((entry) => entry.status === "cut");
  for (const entry of cutting) {
    const layer = layers.find((candidate) => candidate.groupId === entry.object.layerGroupId);
    if (layer && (layer.locked || !layer.visible)) {
      return { ok: false, code: "blocked", error: `La capa «${layer.name}» está ${layer.locked ? "bloqueada" : "oculta"}: no se puede modificar. Corregilo en el panel de Capas. ${NOTHING_CHANGED}` };
    }
  }

  const replacements = new Map<string, EditorObject[]>();
  const resultIds: string[] = [];
  for (const entry of cutting) {
    const original = entry.object;
    const scale = matrixScale(original.matrix);
    const pieces = entry.shapes.map((shape): EditorObject => {
      const id = createId();
      resultIds.push(id);
      return {
        ...original,
        id,
        d: shape.d,
        matrix: shape.matrix,
        ...(original.stroke !== undefined && original.strokeWidth !== undefined ? { strokeWidth: original.strokeWidth * scale } : {}),
      };
    });
    replacements.set(original.id, pieces);
  }

  const touched = new Set(cutting.map((entry) => entry.object.layerGroupId));
  const layersOut: Record<string, EditorObject[]> = {};
  for (const groupId of touched) {
    // Las piezas ocupan el LUGAR del original (mismo orden de pintado).
    layersOut[groupId] = (state.objectsByLayer[groupId] ?? []).flatMap((object) => replacements.get(object.id) ?? [object]);
  }

  return {
    ok: true,
    production: { layers: layersOut, atomic: true },
    resultIds,
    activeGroupId: cutting[0].object.layerGroupId,
    summary: {
      mode: plan.mode,
      slotWidthMm: plan.slotWidthMm,
      unit: plan.unit,
      cutCount: outcome.cutCount,
      pieceCount: outcome.pieceCount,
      intactCount: outcome.intactCount,
      untouchedCount: outcome.untouchedCount,
      omittedLocked: plan.omittedLocked,
      omittedHidden: plan.omittedHidden,
      skippedInvalid: plan.skippedInvalid,
      discarded: outcome.discarded,
    },
  };
}

// ---- Textos ----

/** Etiqueta del comando (Deshacer/Rehacer). */
export function cutLabel(summary: CutSummary): string {
  const mode = summary.mode === "slot" ? `ranura de ${formatPanelValue(summary.slotWidthMm, summary.unit)}` : "dividir";
  return `Cortar: ${mode} (${plural(summary.cutCount, "objeto", "objetos")} → ${plural(summary.pieceCount, "pieza", "piezas")})`;
}

/** Confirmación para el usuario tras aplicar: dice qué se hizo y qué NO se pudo hacer. */
export function cutNotice(summary: CutSummary): string {
  const how = summary.mode === "slot" ? `con una ranura de ${formatPanelValue(summary.slotWidthMm, summary.unit)}` : "dividiendo";
  const parts = [`Corte aplicado ${how}: ${plural(summary.cutCount, "objeto", "objetos")} → ${plural(summary.pieceCount, "pieza", "piezas")}, en la capa de cada original.`];
  if (summary.intactCount > 0) parts.push(`${plural(summary.intactCount, "objeto no fue atravesado y quedó intacto", "objetos no fueron atravesados y quedaron intactos")}.`);
  if (summary.omittedLocked > 0) parts.push(`${plural(summary.omittedLocked, "objeto en una capa bloqueada se omitió", "objetos en capas bloqueadas se omitieron")}.`);
  if (summary.omittedHidden > 0) parts.push(`${plural(summary.omittedHidden, "objeto en una capa oculta se omitió", "objetos en capas ocultas se omitieron")}.`);
  if (summary.skippedInvalid > 0) parts.push(`${plural(summary.skippedInvalid, "objeto no se pudo procesar y se omitió", "objetos no se pudieron procesar y se omitieron")}.`);
  if (summary.discarded > 0) parts.push(`${plural(summary.discarded, "pieza despreciable descartada", "piezas despreciables descartadas")}.`);
  return parts.join(" ");
}

// ---- Errores del servidor, en lenguaje de usuario ----

const CUT_ERROR_MESSAGES: Record<string, string> = {
  invalid_cutter: `El servidor rechazó la línea de corte (necesita al menos dos puntos distintos). ${NOTHING_CHANGED}`,
  unknown_split_mode: `El servidor no reconoce ese modo de corte. ${NOTHING_CHANGED}`,
  invalid_slot_width: `El servidor rechazó el ancho de la ranura. ${NOTHING_CHANGED}`,
  too_many_cutter_points: `La línea de corte tiene demasiados puntos. ${NOTHING_CHANGED} Dibujala con menos puntos.`,
  timeout: `El cálculo tardó demasiado y se canceló. ${NOTHING_CHANGED} Probá con menos objetos o una línea más simple.`,
  too_many_subjects: `Hay demasiados objetos para cortarlos juntos. ${NOTHING_CHANGED} Seleccioná menos objetos.`,
  too_many_vertices: `La geometría a cortar es demasiado grande para calcularla. ${NOTHING_CHANGED} Probá con menos objetos.`,
  payload_too_large: `La geometría a cortar es demasiado grande para calcularla. ${NOTHING_CHANGED} Probá con menos objetos.`,
};

/** Mensaje para el usuario ante un fallo del servicio de geometría durante un corte: siempre dice que NO se modificó nada y, si se puede, qué hacer. */
export function cutErrorMessage(error: unknown): string {
  const candidate = (typeof error === "object" && error !== null ? error : {}) as { isAborted?: boolean; isNetworkError?: boolean; status?: number; body?: unknown };
  const code = (candidate.body as { code?: unknown } | undefined)?.code;
  if (!candidate.isAborted && !candidate.isNetworkError && typeof code === "string" && code in CUT_ERROR_MESSAGES) return CUT_ERROR_MESSAGES[code];
  if (!candidate.isAborted && !candidate.isNetworkError && !code) {
    if (candidate.status === 413) return CUT_ERROR_MESSAGES.payload_too_large;
    if (candidate.status === 504) return CUT_ERROR_MESSAGES.timeout;
  }
  return geometryErrorMessage(error);
}
