import { IDENTITY_MATRIX } from "../svgTransform";
import type { BooleanRequest, BooleanResponse, GeometryPiece } from "../../types/geometry";
import { simplifyPolyline } from "./draw";
import { MAX_SERVER_SUBJECTS, MAX_SERVER_VERTICES, matrixScale, objectGeometry, pieceToPathData, validateBooleanResponse } from "./geometry";
import { hitTestAll, isUnfilled, objectBounds, objectPolylines } from "./objects";
import { distanceToPolylines, pointInPolylinesNonZero } from "./pathGeometry";
import { removeObjects } from "./selection";
import type { EditableDocument, EditableLayerMeta, EditorObject, EditProduction, Point } from "./types";

/**
 * Erase (M3-S04). Tiene dos modos EXPLÍCITOS (nunca "pintar de blanco"):
 * 1. **Objeto**: elimina los objetos bajo el cursor (hit-test de S01, con tolerancia en px de pantalla). Solo capas visibles y no
 *    bloqueadas; las bloqueadas se informan. Un solo comando por gesto.
 * 2. **Restar geometría**: un pincel circular (radio en mm). Al soltar, el trazo viaja como `bufferedLine` y el servidor calcula
 *    `difference` contra los objetos que lo intersecan; cada objeto puede quedar intacto, reducido, partido en varias piezas
 *    (ids nuevos; el original conserva su id SOLO si queda una pieza) o eliminado. Las polilíneas abiertas se parten. Alcance: solo
 *    la capa activa (default) o todas las capas desbloqueadas.
 *
 * Todo puro: arma la petición y, cuando llega la respuesta, la valida y la convierte en UN comando (producción). Si algo no cuadra
 * (respuesta incoherente, el documento cambió mientras se calculaba) NO se produce nada: el cliente nunca crea geometría inválida.
 */

export type EraseMode = "object" | "geometry";
export type EraseScope = "active-layer" | "unlocked-layers";

/** Radio por defecto del pincel, en mm. */
export const DEFAULT_ERASE_RADIUS_MM = 2;
/** Tope de muestras al recorrer un trazo (si no, se ensancha el paso): acota el costo de un gesto larguísimo. */
const MAX_SAMPLES = 4000;

// ---- Trazo ----

/** Puntos a lo largo del trazo con separación ≤ `step` (los vértices originales se conservan). Con un solo punto, ese punto. */
export function strokeSamples(points: readonly Point[], step: number): Point[] {
  if (points.length <= 1) return [...points];
  let length = 0;
  for (let index = 1; index < points.length; index += 1) length += Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y);
  const spacing = Math.max(step, length / MAX_SAMPLES);
  const samples: Point[] = [points[0]];
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1];
    const to = points[index];
    const parts = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / spacing));
    for (let part = 1; part <= parts; part += 1) {
      samples.push(part === parts ? to : { x: from.x + ((to.x - from.x) * part) / parts, y: from.y + ((to.y - from.y) * part) / parts });
    }
  }
  return samples;
}

function sampleBounds(samples: readonly Point[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const sample of samples) {
    minX = Math.min(minX, sample.x);
    minY = Math.min(minY, sample.y);
    maxX = Math.max(maxX, sample.x);
    maxY = Math.max(maxY, sample.y);
  }
  return { minX, minY, maxX, maxY };
}

// ---- Modo Objeto ----

/**
 * Objetos del `pool` (en su orden de pintado) bajo cualquier punto del trazo. `tolerance` está en unidades de documento (el llamador
 * convierte los px de pantalla con `screenToleranceToDocument`); el trazo se recorre con paso ≤ `tolerance` para no saltarse objetos
 * finos entre dos eventos del mouse.
 */
export function objectsAlongPath(pool: readonly EditorObject[], path: readonly Point[], tolerance: number): EditorObject[] {
  const step = tolerance > 0 ? tolerance : 1;
  const hit = new Set<string>();
  for (const sample of strokeSamples(path, step)) {
    for (const object of hitTestAll(pool, sample, tolerance)) hit.add(object.id);
  }
  return pool.filter((object) => hit.has(object.id));
}

export interface ObjectErasePlan {
  production: EditProduction | null;
  /** Objetos que se eliminan. */
  removed: number;
  /** Objetos bajo el cursor que están en capas bloqueadas: se informan y NO se tocan. */
  skippedLocked: number;
}

/** Elimina `hit` salvo los de capas bloqueadas (UN comando). `lockedLayerIds`: ids de las capas bloqueadas. */
export function planObjectErase(state: EditableDocument, hit: readonly EditorObject[], lockedLayerIds: ReadonlySet<string>): ObjectErasePlan {
  const removable = hit.filter((object) => !lockedLayerIds.has(object.layerGroupId));
  const production = removable.length > 0 ? removeObjects(state, new Set(removable.map((object) => object.id))) : null;
  return { production, removed: production ? removable.length : 0, skippedLocked: hit.length - removable.length };
}

// ---- Modo Restar geometría ----

export interface ErasePlan {
  request: BooleanRequest;
  /** Objetos candidatos tal como estaban al planear (referencias): si al llegar la respuesta cambiaron, no se aplica nada. */
  originals: EditorObject[];
  /** Id del objeto dueño de cada subject de la petición (mismo orden). Un objeto sin relleno aporta un subject por subpath. */
  owners: string[];
  /** Objetos bajo el trazo en capas bloqueadas (no se tocan, se informan). */
  skippedLocked: number;
  /** Objetos cuya geometría no se pudo enviar de forma segura (path ilegible...). */
  skippedInvalid: number;
}

export type ErasePlanResult =
  | { status: "ready"; plan: ErasePlan }
  /** Nada que borrar: el trazo no tocó ningún objeto del alcance. No hay petición. */
  | { status: "empty"; message: string; skippedLocked: number }
  | { status: "error"; message: string };

export interface EraseOptions {
  /** Radio del pincel en UNIDADES DE DOCUMENTO (independiente del zoom: el panel lo guarda en mm). */
  radius: number;
  /** Tolerancia de aplanado en unidades de documento (default del panel: 0,01 mm). */
  flatness: number;
  scope: EraseScope;
  /** Capa activa (selectedGroupId) para el alcance «solo capa activa». */
  activeGroupId: string | null;
}

function touchesStroke(object: EditorObject, samples: readonly Point[], bounds: ReturnType<typeof sampleBounds>, radius: number): boolean {
  const box = objectBounds(object);
  if (!box) return false;
  const reach = radius * 1.25 + (object.strokeWidth && object.stroke ? (object.strokeWidth * matrixScale(object.matrix)) / 2 : 0) + 0.05;
  if (box.x - reach > bounds.maxX || box.x + box.width + reach < bounds.minX || box.y - reach > bounds.maxY || box.y + box.height + reach < bounds.minY) return false;
  const polylines = objectPolylines(object);
  const unfilled = isUnfilled(object.fill);
  // Los puntos del trazo están a ≤ radio/4 de alguna muestra: con el margen de 1,25·radio no se pierde ningún objeto que el pincel toque.
  return samples.some((sample) => (!unfilled && pointInPolylinesNonZero(polylines, sample)) || distanceToPolylines(polylines, sample, unfilled) <= reach);
}

function layerBlockedMessage(layer: EditableLayerMeta): string | null {
  if (layer.locked) return `La capa «${layer.name}» está bloqueada. Desbloqueala o elegí otra capa. No se borró nada.`;
  if (!layer.visible) return `La capa «${layer.name}» está oculta. Mostrala o elegí otra capa. No se borró nada.`;
  return null;
}

/**
 * Arma la petición `difference` de un trazo del pincel. Candidatos = objetos del alcance cuyo contorno o relleno cae a ≤ radio del trazo
 * (bbox + hit: un superconjunto seguro; los que el pincel en realidad no toca vuelven `changed: false` y no se modifican).
 */
export function planGeometryErase(state: EditableDocument, stroke: readonly Point[], options: EraseOptions): ErasePlanResult {
  const { radius, flatness, scope, activeGroupId } = options;
  if (stroke.length === 0 || stroke.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
    return { status: "error", message: "El trazo no es válido. No se borró nada." };
  }
  if (!(radius > 0) || !Number.isFinite(radius)) return { status: "error", message: "El radio del pincel debe ser mayor que 0. No se borró nada." };

  const layers = state.layers ?? [];
  let eligible: EditableLayerMeta[];
  let lockedVisible: EditableLayerMeta[] = [];
  if (scope === "active-layer") {
    const active = activeGroupId === null ? undefined : layers.find((layer) => layer.groupId === activeGroupId);
    if (!active) return { status: "error", message: "No hay una capa activa. Elegí una capa en el panel de Capas o cambiá el alcance a «todas las capas desbloqueadas». No se borró nada." };
    const blocked = layerBlockedMessage(active);
    if (blocked) return { status: "error", message: blocked };
    eligible = [active];
  } else {
    eligible = layers.filter((layer) => layer.visible && !layer.locked);
    lockedVisible = layers.filter((layer) => layer.visible && layer.locked);
  }

  const samples = strokeSamples(stroke, Math.max(radius / 2, flatness));
  const bounds = sampleBounds(samples);
  const candidates: EditorObject[] = [];
  for (const layer of eligible) {
    for (const object of state.objectsByLayer[layer.groupId] ?? []) {
      if (touchesStroke(object, samples, bounds, radius)) candidates.push(object);
    }
  }
  let skippedLocked = 0;
  for (const layer of lockedVisible) {
    for (const object of state.objectsByLayer[layer.groupId] ?? []) {
      if (touchesStroke(object, samples, bounds, radius)) skippedLocked += 1;
    }
  }

  if (candidates.length === 0) {
    return {
      status: "empty",
      message: scope === "active-layer" ? "El trazo no tocó ningún objeto de la capa activa. No se borró nada." : "El trazo no tocó ningún objeto de las capas desbloqueadas. No se borró nada.",
      skippedLocked,
    };
  }

  const subjects: BooleanRequest["subjects"] = [];
  const owners: string[] = [];
  const originals: EditorObject[] = [];
  let skippedInvalid = 0;
  let vertices = 0;
  for (const object of candidates) {
    const geometry = objectGeometry(object, flatness);
    if (!geometry) {
      skippedInvalid += 1;
      continue;
    }
    originals.push(object);
    vertices += geometry.vertexCount;
    for (const subject of geometry.subjects) {
      subjects.push(subject);
      owners.push(object.id);
    }
  }
  if (subjects.length === 0) {
    return { status: "error", message: "Los objetos bajo el trazo no tienen una geometría que se pueda procesar. No se borró nada." };
  }

  // El pincel se simplifica con la MISMA tolerancia de aplanado: una polilínea de miles de puntos de mouse no cambia el área borrada más que eso.
  const brush = simplifyPolyline(stroke, flatness).map((point): [number, number] => [point.x, point.y]);
  vertices += brush.length;
  if (subjects.length > MAX_SERVER_SUBJECTS) {
    return { status: "error", message: `Hay demasiados objetos bajo el trazo (${subjects.length}; el máximo es ${MAX_SERVER_SUBJECTS}). Probá con un radio menor o con el modo Objeto. No se borró nada.` };
  }
  if (vertices > MAX_SERVER_VERTICES) {
    return { status: "error", message: `La geometría bajo el trazo es demasiado grande (${vertices.toLocaleString("es-AR")} vértices; el máximo es ${MAX_SERVER_VERTICES.toLocaleString("es-AR")}). Probá con un radio menor. No se borró nada.` };
  }

  return {
    status: "ready",
    plan: {
      request: { operation: "difference", subjects, operands: [{ type: "bufferedLine", points: brush, radius }], tolerance: flatness },
      originals,
      owners,
      skippedLocked,
      skippedInvalid,
    },
  };
}

export interface EraseSummary {
  /** Objetos eliminados por completo. */
  removed: number;
  /** Objetos que quedaron en UNA pieza distinta (reducidos): conservan su id. */
  reduced: number;
  /** Objetos partidos en varias piezas (ids nuevos). */
  split: number;
  /** Objetos de la petición que el pincel no tocó (intactos, con sus curvas originales). */
  untouched: number;
  /** Objetos nuevos creados por los cortes. */
  created: number;
}

export type EraseApplication = { ok: true; production: EditProduction | null; summary: EraseSummary } | { ok: false; error: string };

const NOTHING = "No se modificó nada.";

/**
 * Convierte la respuesta del servidor en UN comando. Todo o nada:
 * - la respuesta debe corresponder a la petición (`validateBooleanResponse`);
 * - los objetos candidatos deben seguir siendo los mismos (por referencia): si el documento cambió mientras se calculaba (undo, otra
 *   edición) el resultado ya no describe el documento y se descarta;
 * - cada pieza debe poder escribirse como `d` válido.
 * Las piezas conservan capa, fill y stroke del objeto original; su `d` queda en unidades de documento con la matriz horneada.
 */
export function applyEraseResult(state: EditableDocument, plan: ErasePlan, response: BooleanResponse, createId: () => string): EraseApplication {
  const invalid = validateBooleanResponse(plan.request, response);
  if (invalid) return { ok: false, error: `El servidor devolvió una respuesta incoherente (${invalid}). ${NOTHING}` };

  for (const original of plan.originals) {
    if (!(state.objectsByLayer[original.layerGroupId] ?? []).includes(original)) {
      return { ok: false, error: `El documento cambió mientras se calculaba el borrado. ${NOTHING} Volvé a pasar el pincel.` };
    }
  }

  const outcomes = new Map<string, { changed: boolean; pieces: GeometryPiece[] }>();
  plan.owners.forEach((ownerId, index) => {
    const item = response.results[index];
    const entry = outcomes.get(ownerId) ?? { changed: false, pieces: [] };
    entry.changed = entry.changed || item.changed;
    entry.pieces.push(...item.geometries);
    outcomes.set(ownerId, entry);
  });

  const summary: EraseSummary = { removed: 0, reduced: 0, split: 0, untouched: 0, created: 0 };
  const replacements = new Map<string, EditorObject[]>();
  for (const original of plan.originals) {
    const outcome = outcomes.get(original.id);
    if (!outcome || !outcome.changed) {
      summary.untouched += 1;
      continue;
    }
    const paths: string[] = [];
    for (const piece of outcome.pieces) {
      const d = pieceToPathData(piece);
      if (d === null) return { ok: false, error: `El servidor devolvió una pieza que no se puede dibujar. ${NOTHING}` };
      paths.push(d);
    }
    const scale = matrixScale(original.matrix);
    const baked = (id: string, d: string): EditorObject => ({
      ...original,
      id,
      d,
      matrix: IDENTITY_MATRIX,
      ...(original.stroke !== undefined && original.strokeWidth !== undefined ? { strokeWidth: original.strokeWidth * scale } : {}),
    });
    if (paths.length === 0) {
      summary.removed += 1;
      replacements.set(original.id, []);
    } else if (paths.length === 1) {
      summary.reduced += 1;
      replacements.set(original.id, [baked(original.id, paths[0])]);
    } else {
      summary.split += 1;
      summary.created += paths.length;
      replacements.set(original.id, paths.map((d) => baked(createId(), d)));
    }
  }

  if (replacements.size === 0) return { ok: true, production: null, summary };

  const layers: Record<string, EditorObject[]> = {};
  for (const original of plan.originals) {
    const replacement = replacements.get(original.id);
    if (!replacement) continue;
    const current = layers[original.layerGroupId] ?? state.objectsByLayer[original.layerGroupId] ?? [];
    // El reemplazo ocupa el LUGAR del original (mismo orden de pintado).
    layers[original.layerGroupId] = current.flatMap((object) => (object.id === original.id ? replacement : [object]));
  }
  return { ok: true, production: { layers, atomic: true }, summary };
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Etiqueta del comando (historial/tooltips de Deshacer). */
export function eraseLabel(summary: EraseSummary): string {
  const touched = summary.removed + summary.reduced + summary.split;
  return `Borrar con pincel (${plural(touched, "objeto", "objetos")})`;
}

/** Resumen para el usuario tras aplicar el borrado con pincel. */
export function eraseNotice(summary: EraseSummary, plan: Pick<ErasePlan, "skippedLocked" | "skippedInvalid">): string {
  const parts: string[] = [];
  if (summary.removed > 0) parts.push(`${plural(summary.removed, "objeto eliminado", "objetos eliminados")}`);
  if (summary.reduced > 0) parts.push(`${plural(summary.reduced, "objeto reducido", "objetos reducidos")}`);
  if (summary.split > 0) parts.push(`${plural(summary.split, "objeto partido", "objetos partidos")} en ${plural(summary.created, "pieza", "piezas")}`);
  const head = parts.length > 0 ? `Borrado aplicado: ${parts.join(", ")}.` : "El pincel no modificó ningún objeto.";
  const extra: string[] = [];
  if (plan.skippedLocked > 0) extra.push(`${plural(plan.skippedLocked, "objeto está", "objetos están")} en capas bloqueadas y no se modificó.`);
  if (plan.skippedInvalid > 0) extra.push(`${plural(plan.skippedInvalid, "objeto no se pudo procesar", "objetos no se pudieron procesar")} y se dejó igual.`);
  return [head, ...extra].join(" ");
}
