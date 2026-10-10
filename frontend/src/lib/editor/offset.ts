import { IDENTITY_MATRIX } from "../svgTransform";
import type { GeometrySubject, OffsetCapStyle, OffsetJoinStyle, OffsetRequest, OffsetResponse } from "../../types/geometry";
import { paintOrderIds, pieceArea, type BooleanShape } from "./boolean";
import { createColorLayer } from "./colors";
import {
  DEFAULT_FLATNESS_MM,
  MAX_SERVER_SUBJECTS,
  MAX_SERVER_VERTICES,
  fromDocumentUnits,
  geometryErrorMessage,
  objectGeometry,
  pieceToPathData,
  toDocumentUnits,
  unitScale,
  validPiece,
  type UnitScale,
} from "./geometry";
import { isUnfilled } from "./objects";
import type { EditableDocument, EditableLayerMeta, EditorObject, EditProduction } from "./types";
import { formatDisplayNumber } from "./units";

/**
 * Offset de geometría del editor (M3-S09): desplaza el contorno de los objetos seleccionados una distancia en **mm** hacia afuera (agranda) o hacia
 * adentro (encoge), con joins (esquinas) y caps (extremos de líneas). Lógica pura (sin React ni Konva): arma la petición al servicio de geometría
 * (`POST /api/v2/geometry/offset`, Shapely/GEOS `buffer`, misma infraestructura de S04/S08) y convierte su respuesta en UN comando.
 *
 * Decisiones (documentadas también en `docs/ADR_EDITOR_MVP3.md`):
 * 1. **Signo y dirección.** La UI trabaja con una distancia ≥ 0 y una dirección explícita (*Exterior* agranda, *Interior* encoge); en el cable la
 *    distancia va FIRMADA (+ exterior, − interior). Una línea abierta (`fill: "none"`) no tiene interior: solo se desplaza a ambos lados (el resultado
 *    es un polígono de ancho total 2×offset) y *Interior* se rechaza con el motivo, nunca se reinterpreta. Offset 0 y |offset| > 1000 mm se rechazan.
 * 2. **Unidades reales.** El panel trabaja en mm y convierte con `mmPerUnit` (`lib/editor/units.ts`); sin escala física (`mmPerUnit` nulo) opera en
 *    unidades del documento con un aviso visible: NUNCA inventa mm. La tolerancia de aplanado/arcos (default 0,01 mm) se convierte igual.
 * 3. **Nada falla en silencio.** El servidor informa por objeto si COLAPSÓ (no queda nada), se PARTIÓ en varias piezas, perdió piezas, ganó o perdió
 *    huecos, y hasta qué offset interior se puede llegar. Si TODOS colapsan no hay nada que aplicar; si ALGUNOS colapsan (o pierden piezas) se aplica
 *    solo a los demás y SOLO si el usuario lo confirma de forma explícita; el objeto que colapsa nunca se modifica ni se borra.
 * 4. **Capa.** Por defecto cada resultado va a la capa de SU objeto de origen (se muestra en el panel) con el color de esa capa; se puede elegir
 *    explícitamente otra capa destino o una capa nueva con un color (mecánica de S03). Una capa de origen bloqueada/oculta RECHAZA la operación
 *    completa (como en S08: no se omite en silencio).
 * 5. **Originales.** Por defecto se CONSERVAN (el offset es un contorno nuevo: típicamente la línea de corte exterior); con «Reemplazar» el objeto
 *    de origen se sustituye por sus piezas. Cada pieza disjunta es un objeto nuevo (id nuevo, `fill` = color de la capa destino, sin matriz, huecos como
 *    subpaths) y se inserta justo ENCIMA de su objeto de origen (o, si el destino es otra capa, al tope de ella). SIEMPRE un comando atómico.
 * 6. **Precisión.** Los objetos se aplanan con su matriz horneada a la tolerancia del panel; el resultado son polilíneas (no preserva los Bézier).
 */

export type OffsetDirection = "outside" | "inside";

export const OFFSET_DIRECTIONS: readonly OffsetDirection[] = ["outside", "inside"];

/** Presets de distancia del panel (en mm, o en unidades sin escala física). */
export const OFFSET_PRESETS_MM: readonly number[] = [0.1, 0.25, 0.5, 1, 2, 5];
export const DEFAULT_OFFSET_MM = 1;
/** Tope de |offset| del editor (mm, o u sin escala): por encima se rechaza con un error claro. El servidor tiene su propio tope en unidades de documento. */
export const MAX_OFFSET_MM = 1000;
/** Paso de las flechas ↑/↓ del campo de distancia. */
export const OFFSET_STEP_MM = 0.1;
/** Espejo de `Geometry:MaxOffsetDistance` del backend (unidades de documento). */
export const MAX_SERVER_OFFSET_UNITS = 1_000_000;

/** Inglete: razón máxima largo del inglete / distancia (default 2, como en la spec); pasado el límite el servidor recorta la punta. */
export const DEFAULT_MITRE_LIMIT = 2;
export const MIN_MITRE_LIMIT = 0.1;
export const MAX_MITRE_LIMIT = 100;

/** Tolerancia de aplanado/arcos y de "pieza despreciable" (mm): default, mínimo y máximo del campo avanzado del panel. */
export const DEFAULT_OFFSET_TOLERANCE_MM = DEFAULT_FLATNESS_MM;
export const MIN_OFFSET_TOLERANCE_MM = 0.001;
export const MAX_OFFSET_TOLERANCE_MM = 1;

export const OFFSET_DIRECTION_INFO: Record<OffsetDirection, { label: string; description: string }> = {
  outside: { label: "Exterior", description: "Agranda la forma: el contorno nuevo queda por fuera (línea de corte exterior)." },
  inside: { label: "Interior", description: "Encoge la forma: el contorno nuevo queda por dentro. Una forma muy chica puede colapsar." },
};

export const OFFSET_JOIN_STYLES: readonly OffsetJoinStyle[] = ["round", "mitre", "bevel"];
export const OFFSET_CAP_STYLES: readonly OffsetCapStyle[] = ["round", "flat", "square"];

export const OFFSET_JOIN_INFO: Record<OffsetJoinStyle, { label: string; description: string }> = {
  round: { label: "Redondo", description: "Las esquinas se redondean con un arco." },
  mitre: { label: "Inglete", description: "Las esquinas quedan en punta; si la punta supera el límite se recorta." },
  bevel: { label: "Bisel", description: "Las esquinas se cortan en diagonal." },
};

export const OFFSET_CAP_INFO: Record<OffsetCapStyle, { label: string; description: string }> = {
  round: { label: "Redondo", description: "El extremo de la línea termina en un semicírculo." },
  flat: { label: "Plano", description: "El contorno termina justo en el extremo de la línea." },
  square: { label: "Cuadrado", description: "El contorno se extiende medio ancho más allá del extremo." },
};

export const NO_SCALE_NOTICE = "Sin escala física: el offset es en unidades del documento (u), no en mm.";

const NOTHING_CHANGED = "No se modificó nada.";

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

// ---- Unidades y signo ----

/** Distancia FIRMADA del cable, en unidades de documento: `magnitude` es el valor del panel (mm, o u sin escala física) y `direction` su signo. */
export function signedDistanceUnits(magnitude: number, direction: OffsetDirection, mmFactor: number | null): number {
  const units = toDocumentUnits(magnitude, unitScale(mmFactor));
  return direction === "inside" ? -units : units;
}

/** Valor del panel (mm o u) para una cantidad en unidades de documento: p. ej. el offset interior máximo que informa el servidor. */
export function panelValue(units: number, mmFactor: number | null): number {
  return fromDocumentUnits(units, unitScale(mmFactor));
}

/** Aviso permanente cuando el documento no tiene escala física, o `null`. */
export function scaleNotice(mmFactor: number | null): string | null {
  return unitScale(mmFactor).label === "mm" ? null : NO_SCALE_NOTICE;
}

/** Texto de una cantidad del panel con su unidad: «1,5 mm» (o «1,5 u» sin escala). */
export function formatPanelValue(value: number, unit: UnitScale): string {
  return `${formatDisplayNumber(value)} ${unit.label}`;
}

/** ¿Hay líneas abiertas entre los objetos? Entonces *Interior* no aplica y los caps sí. */
export function hasOpenLines(objects: readonly EditorObject[]): boolean {
  return objects.some((object) => isUnfilled(object.fill));
}

/** Dirección efectiva: con líneas abiertas solo existe «ambos lados» (que viaja como distancia positiva = `outside`). */
export function effectiveDirection(requested: OffsetDirection, objects: readonly EditorObject[]): OffsetDirection {
  return hasOpenLines(objects) ? "outside" : requested;
}

/** Motivo por el que *Interior* no se puede elegir con estos objetos, o `null`. */
export function insideUnavailableReason(objects: readonly EditorObject[]): string | null {
  return hasOpenLines(objects) ? "Una línea abierta no tiene interior: solo se desplaza a ambos lados (el resultado es un contorno alrededor de la línea)." : null;
}

// ---- Validación de la selección ----

export type OffsetRejection =
  | "none_selected"
  | "locked"
  | "hidden"
  | "missing"
  | "invalid_geometry"
  | "too_many"
  | "invalid_distance"
  | "invalid_tolerance"
  | "invalid_mitre"
  | "interior_lines";

export interface OffsetRejectionInfo {
  ok: false;
  reason: OffsetRejection;
  message: string;
}

function reject(reason: OffsetRejection, message: string): OffsetRejectionInfo {
  return { ok: false, reason, message };
}

/**
 * Motivo por el que `objects` no pueden desplazarse, o `null` si pueden. TODO O NADA: una capa de origen bloqueada u oculta rechaza la operación
 * completa (como las booleanas de S08); omitir objetos en silencio dejaría un resultado distinto del que el usuario cree estar viendo.
 */
export function validateOffsetObjects(objects: readonly EditorObject[], state: EditableDocument): OffsetRejectionInfo | null {
  if (objects.length === 0) return reject("none_selected", "Seleccioná uno o más objetos para desplazar su contorno.");
  const layers = state.layers ?? [];
  const lockedIds = new Set(layers.filter((layer) => layer.locked).map((layer) => layer.groupId));
  const locked = objects.filter((object) => lockedIds.has(object.layerGroupId)).length;
  if (locked > 0) {
    return reject("locked", `${plural(locked, "objeto está en una capa bloqueada", "objetos están en capas bloqueadas")}: no se pueden modificar. Desbloqueá las capas en el panel de Capas. ${NOTHING_CHANGED}`);
  }
  const hiddenIds = new Set(layers.filter((layer) => !layer.visible).map((layer) => layer.groupId));
  const hidden = objects.filter((object) => hiddenIds.has(object.layerGroupId)).length;
  if (hidden > 0) {
    return reject("hidden", `${plural(hidden, "objeto está en una capa oculta", "objetos están en capas ocultas")}: mostrá las capas en el panel de Capas. ${NOTHING_CHANGED}`);
  }
  return null;
}

// ---- Capa destino ----

/** Elección explícita del usuario: una capa existente (por `groupId`) o un color nuevo (capa nueva con la mecánica de S03). `null`/ausente = cada resultado a la capa de su origen. */
export type OffsetTargetChoice = { kind: "layer"; groupId: string } | { kind: "new"; hex: string; groupId: string };

export interface OffsetTarget {
  groupId: string;
  name: string;
  colorHex: string;
  /** La capa todavía no existe: se crea en el MISMO comando. */
  created: boolean;
}

/** Capas que pueden recibir el resultado si se elige otra explícitamente: desbloqueadas y visibles. Las de los objetos de origen primero. */
export function offsetTargetCandidates(objects: readonly EditorObject[], layers: readonly EditableLayerMeta[]): Array<{ layer: EditableLayerMeta; isOriginLayer: boolean }> {
  const originLayers = new Set(objects.map((object) => object.layerGroupId));
  const usable = layers.filter((layer) => !layer.locked && layer.visible);
  return [
    ...usable.filter((layer) => originLayers.has(layer.groupId)).map((layer) => ({ layer, isOriginLayer: true })),
    ...usable.filter((layer) => !originLayers.has(layer.groupId)).map((layer) => ({ layer, isOriginLayer: false })),
  ];
}

function resolveExplicitTarget(layers: readonly EditableLayerMeta[], choice: OffsetTargetChoice): { target: OffsetTarget | null; issue: string | null } {
  const existing = layers.find((layer) => layer.groupId === choice.groupId);
  if (existing) {
    if (existing.locked) return { target: null, issue: `La capa destino «${existing.name}» está bloqueada: desbloqueala en el panel de Capas o elegí otra.` };
    if (!existing.visible) return { target: null, issue: `La capa destino «${existing.name}» está oculta: mostrala en el panel de Capas o elegí otra.` };
    return { target: { groupId: existing.groupId, name: existing.name, colorHex: existing.colorHex, created: false }, issue: null };
  }
  if (choice.kind === "layer") return { target: null, issue: "La capa de destino ya no existe. Elegí otra." };
  const created = createColorLayer(layers, choice.hex, choice.groupId);
  if (!created) return { target: null, issue: `«${choice.hex.trim() || "(vacío)"}» no es un color hex válido (#RGB o #RRGGBB) para la capa nueva.` };
  return { target: { groupId: created.groupId, name: created.name, colorHex: created.colorHex, created: true }, issue: null };
}

// ---- Plan ----

export interface OffsetOptions {
  /** Distancia ≥ 0 del panel, en mm (o en u sin escala física). */
  distance: number;
  direction: OffsetDirection;
  joinStyle: OffsetJoinStyle;
  mitreLimit: number;
  capStyle: OffsetCapStyle;
  /** Tolerancia del panel, en mm (o u). */
  toleranceMm: number;
  /** mm por unidad de documento, o `null` sin escala física (el panel opera en unidades y avisa). */
  mmFactor: number | null;
  /** Por defecto `true` (el offset se agrega como contorno nuevo). */
  keepOriginals?: boolean;
  /** `null`/ausente = cada resultado a la capa de su objeto de origen. */
  targetLayer?: OffsetTargetChoice | null;
}

export interface OffsetPlan {
  /** Objetos en orden de PINTADO. Son las referencias del documento al planear (si cambian, no se aplica nada). */
  objects: EditorObject[];
  /** Por cada subject de la petición, el índice de su objeto en `objects` (un objeto sin relleno aporta un subject por subpath). */
  owners: number[];
  request: OffsetRequest;
  /** Identifica la PETICIÓN (distancia firmada, joins, caps, tolerancia y objetos): igual clave => mismo resultado, no hace falta volver a pedirlo. */
  requestKey: string;
  direction: OffsetDirection;
  /** Distancia del panel (≥ 0) y su unidad (mm, o u sin escala física). */
  magnitude: number;
  unit: UnitScale;
  mmFactor: number | null;
  scaleNotice: string | null;
  hasLines: boolean;
  onlyLines: boolean;
  keepOriginals: boolean;
  /** Destino explícito ya resuelto, o `null` con `mode: "origin"` (cada objeto a su capa) / mientras el elegido no sea válido (ver `targetIssue`). */
  mode: "origin" | "explicit";
  target: OffsetTarget | null;
  targetIssue: string | null;
}

export type OffsetPlanResult = { ok: true; plan: OffsetPlan } | OffsetRejectionInfo;

// Número de serie por objeto (las referencias son inmutables: otra referencia = otro contenido): clave de petición barata, sin serializar la geometría.
const serials = new WeakMap<object, number>();
let nextSerial = 1;
function serialOf(object: object): number {
  let serial = serials.get(object);
  if (serial === undefined) {
    serial = nextSerial;
    nextSerial += 1;
    serials.set(object, serial);
  }
  return serial;
}

/**
 * Arma la petición de un offset. `selection` son los objetos (cualquier orden; se resuelven contra `document` por id); el plan los ordena por pintado.
 * Rechaza (con el motivo) todo lo que no se pueda hacer sin adivinar: sin selección, capas de origen bloqueadas/ocultas, distancia 0 o fuera de rango,
 * *Interior* con líneas, geometría ilegible, demasiados vértices. Nunca decide una capa destino que el usuario no haya visto: el modo por defecto es
 * «cada resultado a la capa de su origen» y una elección explícita inválida deja el plan SIN destino (`target: null`).
 */
export function planOffset(selection: readonly EditorObject[], document: EditableDocument, options: OffsetOptions): OffsetPlanResult {
  const current = new Map<string, EditorObject>();
  for (const objects of Object.values(document.objectsByLayer)) for (const object of objects) current.set(object.id, object);
  const unique = [...new Map(selection.map((object) => [object.id, object])).values()];
  const found: EditorObject[] = [];
  for (const object of unique) {
    const live = current.get(object.id);
    if (live) found.push(live);
  }
  if (found.length < unique.length) return reject("missing", `Algún objeto ya no existe en el documento. ${NOTHING_CHANGED}`);

  const invalid = validateOffsetObjects(found, document);
  if (invalid) return invalid;

  const unit = unitScale(options.mmFactor);
  const magnitude = options.distance;
  if (!(magnitude > 0) || !Number.isFinite(magnitude) || magnitude > MAX_OFFSET_MM) {
    return reject("invalid_distance", `El offset tiene que ser un número mayor que 0 y de hasta ${MAX_OFFSET_MM} ${unit.label}. ${NOTHING_CHANGED}`);
  }
  const distanceUnits = toDocumentUnits(magnitude, unit);
  if (!(distanceUnits <= MAX_SERVER_OFFSET_UNITS)) {
    return reject("invalid_distance", `Con la escala de este documento ese offset supera el máximo que acepta el servidor (${MAX_SERVER_OFFSET_UNITS.toLocaleString("es-AR")} unidades). Usá uno menor. ${NOTHING_CHANGED}`);
  }
  if (!(options.toleranceMm > 0) || !Number.isFinite(options.toleranceMm)) {
    return reject("invalid_tolerance", `La tolerancia tiene que ser un número mayor que 0. ${NOTHING_CHANGED}`);
  }
  if (!(options.mitreLimit > 0) || !Number.isFinite(options.mitreLimit) || options.mitreLimit > MAX_MITRE_LIMIT) {
    return reject("invalid_mitre", `El límite de inglete tiene que ser un número mayor que 0 y de hasta ${MAX_MITRE_LIMIT}. ${NOTHING_CHANGED}`);
  }
  const hasLines = hasOpenLines(found);
  if (hasLines && options.direction === "inside") {
    return reject("interior_lines", `${insideUnavailableReason(found)} Sacá las líneas de la selección o elegí Exterior. ${NOTHING_CHANGED}`);
  }

  const byId = new Map(found.map((object) => [object.id, object]));
  const objects = paintOrderIds(
    found.map((object) => object.id),
    document,
  ).map((id) => byId.get(id)!);

  const tolerance = toDocumentUnits(options.toleranceMm, unit);
  const subjects: GeometrySubject[] = [];
  const owners: number[] = [];
  let vertices = 0;
  for (let index = 0; index < objects.length; index += 1) {
    const geometry = objectGeometry(objects[index], tolerance);
    if (!geometry) {
      return reject("invalid_geometry", `Un objeto seleccionado no tiene una geometría que se pueda procesar (path ilegible o sin área). ${NOTHING_CHANGED}`);
    }
    for (const subject of geometry.subjects) {
      subjects.push(subject);
      owners.push(index);
    }
    vertices += geometry.vertexCount;
  }
  if (subjects.length > MAX_SERVER_SUBJECTS) {
    return reject("too_many", `Son demasiados objetos (${subjects.length} contornos; el máximo es ${MAX_SERVER_SUBJECTS}). ${NOTHING_CHANGED}`);
  }
  if (vertices > MAX_SERVER_VERTICES) {
    return reject(
      "too_many",
      `La geometría seleccionada es demasiado grande (${vertices.toLocaleString("es-AR")} vértices; el máximo es ${MAX_SERVER_VERTICES.toLocaleString("es-AR")}). Probá con una tolerancia mayor o menos objetos. ${NOTHING_CHANGED}`,
    );
  }

  const request: OffsetRequest = {
    subjects,
    distance: options.direction === "inside" ? -distanceUnits : distanceUnits,
    joinStyle: options.joinStyle,
    mitreLimit: options.mitreLimit,
    capStyle: options.capStyle,
    tolerance,
  };

  const choice = options.targetLayer ?? null;
  const explicit = choice === null ? null : resolveExplicitTarget(document.layers ?? [], choice);
  return {
    ok: true,
    plan: {
      objects,
      owners,
      request,
      requestKey: `offset|${request.distance}|${request.joinStyle}|${request.mitreLimit}|${request.capStyle}|${request.tolerance}|${objects.map((object) => `${object.id}#${serialOf(object)}`).join(",")}`,
      direction: options.direction,
      magnitude,
      unit,
      mmFactor: options.mmFactor,
      scaleNotice: scaleNotice(options.mmFactor),
      hasLines,
      onlyLines: objects.every((object) => isUnfilled(object.fill)),
      keepOriginals: options.keepOriginals !== false,
      mode: choice === null ? "origin" : "explicit",
      target: explicit?.target ?? null,
      targetIssue: explicit?.issue ?? null,
    },
  };
}

/** Motivo (para el panel) por el que no se puede abrir un offset con esta selección, o `null`. Es el mismo criterio de `planOffset`, sin armar la petición. */
export function offsetAvailability(selection: readonly EditorObject[], state: EditableDocument): string | null {
  return validateOffsetObjects(selection, state)?.message ?? null;
}

// ---- Validación de la respuesta ----

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Defensa del cliente (el editor NUNCA crea geometría inválida ni muestra datos que no cierran): la respuesta tiene que corresponder a LA petición --
 * mismos parámetros, una entrada por subject en orden, SOLO polígonos con anillos cerrados y coordenadas finitas, y los datos que se le muestran al usuario
 * (colapso, piezas, huecos, offset interior máximo) coherentes entre sí y con la geometría. `null` si es coherente; si no, el motivo.
 */
export function validateOffsetResponse(request: OffsetRequest, response: OffsetResponse): string | null {
  if (!response || !Array.isArray(response.results)) return "la respuesta no trae resultados";
  if (response.distance !== request.distance) return "la respuesta es de otra distancia";
  if (response.joinStyle !== request.joinStyle || response.capStyle !== request.capStyle || response.mitreLimit !== request.mitreLimit) return "la respuesta usa otros joins o caps";
  if (response.results.length !== request.subjects.length) return `trae ${response.results.length} resultados y se esperaban ${request.subjects.length}`;

  for (let index = 0; index < response.results.length; index += 1) {
    const item = response.results[index];
    if (!item || !Array.isArray(item.geometries)) return "un resultado no trae geometrías";
    if (item.subjectIndex !== index) return "un resultado no corresponde a su subject";
    let holes = 0;
    for (const piece of item.geometries) {
      const problem = validPiece(piece, "polygon");
      if (problem) return problem;
      holes += piece.coordinates.length - 1;
    }
    if (item.collapsed !== (item.geometries.length === 0) || item.splitCount !== item.geometries.length) return "el colapso o la cantidad de piezas no coincide con la geometría";
    if (!isCount(item.piecesBefore) || !isCount(item.lostPieces) || !isCount(item.holesBefore) || item.lostPieces > item.piecesBefore) return "los conteos de piezas o huecos son incoherentes";
    if (item.holesAfter !== holes) return "el conteo de huecos no coincide con la geometría";
    const isLine = request.subjects[index].type === "line";
    const maxInward = item.maxInwardOffset;
    if (isLine ? maxInward !== null : typeof maxInward !== "number" || !Number.isFinite(maxInward) || maxInward < 0) return "el offset interior máximo no corresponde al tipo de objeto";
  }
  return null;
}

/** Dónde va a caer el resultado, para mostrarlo SIEMPRE en el panel (la capa nunca se decide en silencio), o `null` si el destino elegido todavía no es válido. */
export function offsetDestinationText(plan: OffsetPlan, layers: readonly EditableLayerMeta[]): string | null {
  if (plan.mode === "explicit") {
    if (!plan.target) return null;
    return `Todos los resultados van a «${plan.target.name}»${plan.target.created ? " (capa nueva)" : ""}, con el color ${plan.target.colorHex}.`;
  }
  const counts = new Map<string, number>();
  for (const object of plan.objects) counts.set(object.layerGroupId, (counts.get(object.layerGroupId) ?? 0) + 1);
  const parts = [...counts].map(([groupId, count]) => `«${layers.find((layer) => layer.groupId === groupId)?.name ?? "Capa"}» (${plural(count, "objeto", "objetos")})`);
  return `Cada resultado va a la capa de su objeto de origen, con el color de esa capa: ${parts.join(", ")}.`;
}

/** Color de la capa en la que va a caer el resultado de `object` (para el preview), o `null` si todavía no se sabe. */
export function offsetResultColor(plan: OffsetPlan, object: EditorObject, layers: readonly EditableLayerMeta[]): string | null {
  if (plan.mode === "explicit") return plan.target?.colorHex ?? null;
  return layers.find((layer) => layer.groupId === object.layerGroupId)?.colorHex ?? null;
}

// ---- Resultado ----

/** Lo que dice la respuesta para UN objeto (agregando los subpaths de una línea), ya validado. */
export interface OffsetObjectOutcome {
  object: EditorObject;
  /** Piezas nuevas (polilíneas aplanadas), en el orden determinista del servidor. Vacío si el objeto colapsó. */
  shapes: BooleanShape[];
  /** Piezas con área < tolerancia² que el cliente descartó. */
  discarded: number;
  /** No queda nada: el objeto NO se toca (ni se reemplaza ni se borra). */
  collapsed: boolean;
  /** Se pierden piezas del objeto pero no todas: ese resultado necesita confirmación. */
  partial: boolean;
  lostPieces: number;
  /** El objeto se partió: el resultado tiene más piezas de las que sobreviven del objeto. */
  divided: boolean;
  piecesBefore: number;
  holesBefore: number;
  holesAfter: number;
  /** Offset interior máximo (unidades de documento) antes de que colapse el objeto; `null` para líneas. */
  maxInwardUnits: number | null;
}

export interface OffsetOutcome {
  objects: OffsetObjectOutcome[];
  collapsedCount: number;
  partialCount: number;
  dividedCount: number;
  /** Piezas totales de los objetos que se parten. */
  dividedPieces: number;
  /** Objetos que pierden / ganan huecos. */
  holesLostCount: number;
  holesGainedCount: number;
  discarded: number;
  /** Piezas nuevas en total. */
  shapeCount: number;
  /** Todos los objetos colapsan: no hay nada que aplicar. */
  allCollapsed: boolean;
  /** Algunos (no todos) colapsan o pierden piezas: se aplica solo a los demás SI el usuario lo confirma explícitamente. */
  needsConfirmation: boolean;
  /** El menor offset interior máximo entre los objetos con interior (unidades de documento): por debajo de él no colapsa ninguno. `null` si no hay. */
  maxInwardUnits: number | null;
}

/**
 * Lo que dice la respuesta del servidor para este plan: sirve igual para la previsualización y para aplicar (así lo que se ve es lo que se aplica). Piezas
 * con área < tolerancia² se descartan (se informa cuántas); una pieza que no se pueda escribir como `d` válido invalida TODO el resultado.
 */
export function offsetOutcome(plan: OffsetPlan, response: OffsetResponse): { ok: true; outcome: OffsetOutcome } | { ok: false; error: string } {
  const invalid = validateOffsetResponse(plan.request, response);
  if (invalid) return { ok: false, error: `El servidor devolvió una respuesta incoherente (${invalid}). ${NOTHING_CHANGED}` };

  const minArea = plan.request.tolerance * plan.request.tolerance;
  const objects: OffsetObjectOutcome[] = [];
  for (let index = 0; index < plan.objects.length; index += 1) {
    const items = response.results.filter((_, subject) => plan.owners[subject] === index);
    const shapes: BooleanShape[] = [];
    let discarded = 0;
    for (const item of items) {
      for (const piece of item.geometries) {
        const d = pieceToPathData(piece);
        if (d === null) return { ok: false, error: `El servidor devolvió una pieza que no se puede dibujar. ${NOTHING_CHANGED}` };
        if (!(pieceArea(piece) >= minArea)) {
          discarded += 1;
          continue;
        }
        shapes.push({ d, matrix: IDENTITY_MATRIX });
      }
    }
    const piecesBefore = items.reduce((total, item) => total + item.piecesBefore, 0);
    const lostPieces = items.reduce((total, item) => total + item.lostPieces, 0);
    const maxInwards = items.flatMap((item) => (item.maxInwardOffset === null ? [] : [item.maxInwardOffset]));
    const collapsed = shapes.length === 0;
    objects.push({
      object: plan.objects[index],
      shapes,
      discarded,
      collapsed,
      partial: !collapsed && lostPieces > 0,
      lostPieces,
      divided: !collapsed && shapes.length > Math.max(1, piecesBefore - lostPieces),
      piecesBefore,
      holesBefore: items.reduce((total, item) => total + item.holesBefore, 0),
      holesAfter: items.reduce((total, item) => total + item.holesAfter, 0),
      maxInwardUnits: maxInwards.length === 0 ? null : Math.max(...maxInwards),
    });
  }

  const collapsedCount = objects.filter((entry) => entry.collapsed).length;
  const partialCount = objects.filter((entry) => entry.partial).length;
  const divided = objects.filter((entry) => entry.divided);
  const withInterior = objects.flatMap((entry) => (entry.maxInwardUnits !== null && entry.maxInwardUnits > 0 ? [entry.maxInwardUnits] : []));
  const allCollapsed = collapsedCount === objects.length;
  return {
    ok: true,
    outcome: {
      objects,
      collapsedCount,
      partialCount,
      dividedCount: divided.length,
      dividedPieces: divided.reduce((total, entry) => total + entry.shapes.length, 0),
      holesLostCount: objects.filter((entry) => !entry.collapsed && entry.holesAfter < entry.holesBefore).length,
      holesGainedCount: objects.filter((entry) => !entry.collapsed && entry.holesAfter > entry.holesBefore).length,
      discarded: objects.reduce((total, entry) => total + entry.discarded, 0),
      shapeCount: objects.reduce((total, entry) => total + entry.shapes.length, 0),
      allCollapsed,
      needsConfirmation: !allCollapsed && (collapsedCount > 0 || partialCount > 0),
      maxInwardUnits: withInterior.length === 0 ? null : Math.min(...withInterior),
    },
  };
}

// ---- Advertencias y bloqueo de Apply ----

export interface OffsetWarning {
  kind: "collapse" | "partial" | "split" | "holes_lost" | "holes_gained" | "discarded";
  text: string;
}

function maxInwardHint(outcome: OffsetOutcome, plan: OffsetPlan): string {
  if (outcome.maxInwardUnits === null) return "";
  return ` (máximo interior ≈ ${formatPanelValue(panelValue(outcome.maxInwardUnits, plan.mmFactor), plan.unit)})`;
}

/** Avisos que se muestran ANTES de confirmar (colapso, pérdida de piezas, división, huecos, descartes): ninguno se omite. */
export function offsetWarnings(plan: OffsetPlan, outcome: OffsetOutcome): OffsetWarning[] {
  const warnings: OffsetWarning[] = [];
  if (outcome.collapsedCount > 0) {
    const hint = maxInwardHint(outcome, plan);
    warnings.push({
      kind: "collapse",
      text:
        outcome.collapsedCount === 1
          ? `1 objeto colapsa con este offset${hint}: desaparece y no se modifica.`
          : `${outcome.collapsedCount} objetos colapsan con este offset${hint}: desaparecen y no se modifican.`,
    });
  }
  if (outcome.partialCount > 0) {
    warnings.push({
      kind: "partial",
      text: `${plural(outcome.partialCount, "objeto pierde", "objetos pierden")} piezas pequeñas que desaparecen con este offset.`,
    });
  }
  if (outcome.dividedCount > 0) {
    warnings.push({
      kind: "split",
      text: `${plural(outcome.dividedCount, "objeto se divide", "objetos se dividen")} en ${plural(outcome.dividedPieces, "pieza", "piezas")}.`,
    });
  }
  if (outcome.holesLostCount > 0) {
    warnings.push({ kind: "holes_lost", text: `${plural(outcome.holesLostCount, "objeto pierde", "objetos pierden")} huecos (se cierran o se funden).` });
  }
  if (outcome.holesGainedCount > 0) {
    warnings.push({ kind: "holes_gained", text: `${plural(outcome.holesGainedCount, "objeto gana", "objetos ganan")} huecos (una abertura estrecha se cierra).` });
  }
  if (outcome.discarded > 0) {
    warnings.push({ kind: "discarded", text: `${plural(outcome.discarded, "pieza despreciable descartada", "piezas despreciables descartadas")}.` });
  }
  return warnings;
}

/** Texto de estado de una previsualización lista: «Resultado: 3 piezas en 2 objetos.» o por qué no hay nada que aplicar. */
export function offsetReadyText(plan: OffsetPlan, outcome: OffsetOutcome): string {
  if (outcome.allCollapsed) {
    return `${outcome.objects.length === 1 ? "El objeto colapsa" : "Todos los objetos colapsan"} con este offset${maxInwardHint(outcome, plan)}: no hay nada que aplicar.`;
  }
  const processed = outcome.objects.length - outcome.collapsedCount;
  return `Resultado: ${plural(outcome.shapeCount, "pieza", "piezas")} a partir de ${plural(processed, "objeto", "objetos")}.`;
}

/**
 * Por qué NO se puede aplicar todavía (texto para el botón y el panel), o `null` si Apply está habilitado. Cubre los dos casos de colapso: si TODOS
 * colapsan no hay nada que aplicar (se explica y se sugiere un valor); si ALGUNOS colapsan o pierden piezas hace falta la confirmación explícita.
 */
export function offsetApplyBlock(plan: OffsetPlan, outcome: OffsetOutcome | null, confirmed: boolean): string | null {
  if (plan.mode === "explicit" && plan.target === null) return plan.targetIssue ?? "Elegí la capa de destino. No se decide en silencio.";
  if (!outcome) return "Esperando el resultado del servidor…";
  if (outcome.allCollapsed) {
    return `${outcome.objects.length === 1 ? "El objeto colapsa" : "Todos los objetos colapsan"} con este offset${maxInwardHint(outcome, plan)}. Reducí el offset${plan.direction === "inside" ? " o elegí Exterior" : ""}.`;
  }
  if (outcome.needsConfirmation && !confirmed) {
    const lost = outcome.collapsedCount + outcome.partialCount;
    return `${plural(lost, "objeto colapsa o pierde piezas", "objetos colapsan o pierden piezas")}: confirmá que se aplica solo a los demás, o ajustá el valor.`;
  }
  return null;
}

/** Texto de la casilla de confirmación explícita (solo cuando `needsConfirmation`). */
export function offsetConfirmText(outcome: OffsetOutcome): string {
  const parts: string[] = [];
  if (outcome.collapsedCount > 0) parts.push(`${plural(outcome.collapsedCount, "objeto colapsa y no se modifica", "objetos colapsan y no se modifican")}`);
  if (outcome.partialCount > 0) parts.push(`${plural(outcome.partialCount, "objeto pierde", "objetos pierden")} piezas pequeñas`);
  return `Entiendo que ${parts.join(" y ")}: aplicar solo a los demás.`;
}

// ---- Aplicar ----

export interface OffsetSummary {
  direction: OffsetDirection;
  magnitude: number;
  unit: UnitScale;
  objectCount: number;
  /** Objetos que sí producen piezas. */
  processedCount: number;
  collapsedCount: number;
  partialCount: number;
  dividedCount: number;
  dividedPieces: number;
  resultCount: number;
  /** Originales que se reemplazaron (0 con «Conservar original»). */
  removed: number;
  keepOriginals: boolean;
  discarded: number;
  /** Capas que reciben el resultado, con la cantidad de objetos nuevos de cada una. */
  targets: Array<{ groupId: string; name: string; colorHex: string; count: number; created: boolean }>;
  holesLostCount: number;
  holesGainedCount: number;
  onlyLines: boolean;
}

export type OffsetApplicationCode = "target_required" | "all_collapsed" | "confirmation_required" | "stale" | "blocked" | "invalid_response";

export type OffsetApplication =
  | { ok: true; production: EditProduction; summary: OffsetSummary; resultIds: string[]; activeGroupId: string }
  | { ok: false; code: OffsetApplicationCode; error: string };

function defaultCreateId(): string {
  return crypto.randomUUID();
}

/**
 * Convierte la respuesta del servidor en UN comando (`EditProduction` atómica). Todo o nada:
 * - destino explícito inválido => rechazo (la capa/color nunca se decide en silencio);
 * - la respuesta debe corresponder a la petición (`offsetOutcome`) y los objetos deben seguir siendo los mismos (por referencia): si el documento cambió
 *   mientras se calculaba, el resultado ya no lo describe y se descarta;
 * - TODOS colapsan => nada que aplicar; ALGUNOS colapsan o pierden piezas => solo con `confirmed` (la confirmación explícita del usuario);
 * - capas de origen o destino bloqueadas/ocultas => rechazo de la operación completa.
 * Un objeto que colapsa NO se toca (ni se reemplaza ni se borra), aun con «Reemplazar». Con `plan.keepOriginals` los resultados se agregan y los originales
 * quedan; si no, cada objeto con resultado se sustituye por sus piezas en el mismo lugar. Cada pieza es un objeto nuevo (id nuevo, sin matriz) en la capa
 * de su objeto de origen o en la destino explícita, con el color de esa capa, justo encima de su origen (o al tope de la destino si es otra capa).
 */
export function applyOffsetResult(
  plan: OffsetPlan,
  state: EditableDocument,
  response: OffsetResponse,
  options: { confirmed: boolean; createId?: () => string },
): OffsetApplication {
  const createId = options.createId ?? defaultCreateId;
  if (plan.mode === "explicit" && plan.target === null) {
    return { ok: false, code: "target_required", error: plan.targetIssue ?? "Elegí la capa de destino. No se decide en silencio." };
  }

  const outcomeResult = offsetOutcome(plan, response);
  if (!outcomeResult.ok) return { ok: false, code: "invalid_response", error: outcomeResult.error };
  const { outcome } = outcomeResult;
  if (outcome.allCollapsed) {
    return {
      ok: false,
      code: "all_collapsed",
      error: `${outcome.objects.length === 1 ? "El objeto colapsa" : "Todos los objetos colapsan"} con este offset${maxInwardHint(outcome, plan)}: no hay nada que aplicar. ${NOTHING_CHANGED}`,
    };
  }
  if (outcome.needsConfirmation && !options.confirmed) {
    return { ok: false, code: "confirmation_required", error: `${offsetApplyBlock(plan, outcome, false)} ${NOTHING_CHANGED}` };
  }

  for (const object of plan.objects) {
    if (!(state.objectsByLayer[object.layerGroupId] ?? []).includes(object)) {
      return { ok: false, code: "stale", error: `El documento cambió mientras se calculaba. ${NOTHING_CHANGED} Volvé a abrir el offset.` };
    }
  }
  const invalid = validateOffsetObjects(plan.objects, state);
  if (invalid) return { ok: false, code: "blocked", error: invalid.message };

  const layers = state.layers ?? [];
  // Capa destino de cada objeto: la suya (origen) o la elegida de forma explícita.
  let explicit: { groupId: string; name: string; colorHex: string; created: boolean } | null = null;
  if (plan.mode === "explicit") {
    const target = plan.target!;
    const existing = layers.find((layer) => layer.groupId === target.groupId);
    if (existing) {
      if (existing.locked || !existing.visible) {
        return { ok: false, code: "blocked", error: `La capa destino «${existing.name}» está ${existing.locked ? "bloqueada" : "oculta"}: elegí otra o corregilo en el panel de Capas. ${NOTHING_CHANGED}` };
      }
      explicit = { groupId: existing.groupId, name: existing.name, colorHex: existing.colorHex, created: false };
    } else {
      const created = createColorLayer(layers, target.colorHex, target.groupId);
      if (!created) return { ok: false, code: "target_required", error: plan.targetIssue ?? "Elegí la capa de destino. No se decide en silencio." };
      explicit = { groupId: created.groupId, name: created.name, colorHex: created.colorHex, created: true };
    }
  }
  const destinationOf = (object: EditorObject): { groupId: string; name: string; colorHex: string; created: boolean } | null => {
    if (explicit) return explicit;
    const own = layers.find((layer) => layer.groupId === object.layerGroupId);
    return own ? { groupId: own.groupId, name: own.name, colorHex: own.colorHex, created: false } : null;
  };

  const resultsByObject = new Map<string, EditorObject[]>();
  const destinationByObject = new Map<string, string>();
  const removed = new Set<string>();
  const counts = new Map<string, { groupId: string; name: string; colorHex: string; count: number; created: boolean }>();
  const resultIds: string[] = [];
  for (const entry of outcome.objects) {
    // Un objeto que colapsa no se toca: ni se agrega nada ni se quita el original (aunque se haya pedido «Reemplazar»).
    if (entry.collapsed) continue;
    const destination = destinationOf(entry.object);
    if (!destination) return { ok: false, code: "blocked", error: `No se conoce la capa de origen de un objeto seleccionado. ${NOTHING_CHANGED}` };
    const created = entry.shapes.map(
      (shape): EditorObject => ({ id: createId(), layerGroupId: destination.groupId, d: shape.d, fill: destination.colorHex, matrix: shape.matrix }),
    );
    resultsByObject.set(entry.object.id, created);
    destinationByObject.set(entry.object.id, destination.groupId);
    resultIds.push(...created.map((object) => object.id));
    const tally = counts.get(destination.groupId) ?? { ...destination, count: 0 };
    tally.count += created.length;
    counts.set(destination.groupId, tally);
    if (!plan.keepOriginals) removed.add(entry.object.id);
  }

  const touched = new Set<string>(counts.keys());
  for (const object of plan.objects) if (removed.has(object.id)) touched.add(object.layerGroupId);

  const layersOut: Record<string, EditorObject[]> = {};
  for (const groupId of touched) {
    const list = state.objectsByLayer[groupId] ?? [];
    const next: EditorObject[] = [];
    for (const object of list) {
      if (!removed.has(object.id)) next.push(object);
      // Justo ENCIMA del objeto de origen (con «Reemplazar», en el lugar que ocupaba).
      const own = resultsByObject.get(object.id);
      if (own && destinationByObject.get(object.id) === groupId) next.push(...own);
    }
    // Resultados de objetos que viven en OTRA capa (destino explícito): al tope de esta capa, en orden de pintado.
    for (const entry of outcome.objects) {
      if (entry.object.layerGroupId !== groupId && destinationByObject.get(entry.object.id) === groupId) next.push(...(resultsByObject.get(entry.object.id) ?? []));
    }
    layersOut[groupId] = next;
  }

  const production: EditProduction = { layers: layersOut, atomic: true };
  if (explicit?.created) {
    const meta = createColorLayer(layers, explicit.colorHex, explicit.groupId);
    if (meta) production.layerMetas = [meta];
  }

  const firstResultObject = outcome.objects.find((entry) => !entry.collapsed)!;
  return {
    ok: true,
    production,
    resultIds,
    activeGroupId: destinationByObject.get(firstResultObject.object.id)!,
    summary: {
      direction: plan.direction,
      magnitude: plan.magnitude,
      unit: plan.unit,
      objectCount: outcome.objects.length,
      processedCount: outcome.objects.length - outcome.collapsedCount,
      collapsedCount: outcome.collapsedCount,
      partialCount: outcome.partialCount,
      dividedCount: outcome.dividedCount,
      dividedPieces: outcome.dividedPieces,
      resultCount: resultIds.length,
      removed: removed.size,
      keepOriginals: plan.keepOriginals,
      discarded: outcome.discarded,
      targets: [...counts.values()],
      holesLostCount: outcome.holesLostCount,
      holesGainedCount: outcome.holesGainedCount,
      onlyLines: plan.onlyLines,
    },
  };
}

// ---- Textos ----

function directionWord(summary: Pick<OffsetSummary, "direction" | "onlyLines">): string {
  return summary.onlyLines ? "a ambos lados" : summary.direction === "inside" ? "interior" : "exterior";
}

/** Etiqueta del comando (Deshacer/Rehacer). */
export function offsetLabel(summary: OffsetSummary): string {
  return `Offset ${directionWord(summary)} ${formatPanelValue(summary.magnitude, summary.unit)} (${plural(summary.processedCount, "objeto", "objetos")} → ${plural(summary.resultCount, "pieza", "piezas")})`;
}

/** Confirmación para el usuario tras aplicar: dice qué se hizo, dónde cayó y qué NO se pudo hacer. */
export function offsetNotice(summary: OffsetSummary): string {
  const where = summary.targets.map((target) => `«${target.name}»${target.created ? " (capa nueva, sin guardar todavía)" : ""}`).join(", ");
  const parts = [
    `Offset ${directionWord(summary)} de ${formatPanelValue(summary.magnitude, summary.unit)} aplicado: ${plural(summary.processedCount, "objeto", "objetos")} → ${plural(summary.resultCount, "pieza", "piezas")} en ${where}.`,
  ];
  parts.push(summary.keepOriginals ? "Los originales se conservaron." : `${plural(summary.removed, "original reemplazado", "originales reemplazados")}.`);
  if (summary.collapsedCount > 0) parts.push(`${plural(summary.collapsedCount, "objeto colapsó y no se modificó", "objetos colapsaron y no se modificaron")}.`);
  if (summary.partialCount > 0) parts.push(`${plural(summary.partialCount, "objeto perdió", "objetos perdieron")} piezas pequeñas.`);
  if (summary.dividedCount > 0) parts.push(`${plural(summary.dividedCount, "objeto se dividió", "objetos se dividieron")} en ${plural(summary.dividedPieces, "pieza", "piezas")}.`);
  if (summary.holesLostCount > 0) parts.push(`${plural(summary.holesLostCount, "objeto perdió", "objetos perdieron")} huecos.`);
  if (summary.holesGainedCount > 0) parts.push(`${plural(summary.holesGainedCount, "objeto ganó", "objetos ganaron")} huecos.`);
  if (summary.discarded > 0) parts.push(`${plural(summary.discarded, "pieza despreciable descartada", "piezas despreciables descartadas")}.`);
  return parts.join(" ");
}

// ---- Errores del servidor, en lenguaje de usuario ----

const OFFSET_ERROR_MESSAGES: Record<string, string> = {
  invalid_distance: `El servidor rechazó la distancia del offset (0, fuera de rango o interior con líneas). ${NOTHING_CHANGED}`,
  unknown_join_style: `El servidor no reconoce ese tipo de esquina. ${NOTHING_CHANGED}`,
  unknown_cap_style: `El servidor no reconoce ese tipo de extremo. ${NOTHING_CHANGED}`,
  invalid_mitre_limit: `El servidor rechazó el límite de inglete. ${NOTHING_CHANGED}`,
  timeout: `El cálculo tardó demasiado y se canceló. ${NOTHING_CHANGED} Probá con menos objetos, un offset menor o una tolerancia mayor.`,
  too_many_subjects: `Hay demasiados objetos para desplazarlos juntos. ${NOTHING_CHANGED} Seleccioná menos objetos.`,
  too_many_vertices: `La geometría seleccionada es demasiado grande para calcularla. ${NOTHING_CHANGED} Probá con menos objetos o una tolerancia mayor.`,
  payload_too_large: `La geometría seleccionada es demasiado grande para calcularla. ${NOTHING_CHANGED} Probá con menos objetos o una tolerancia mayor.`,
};

/** Mensaje para el usuario ante un fallo del servicio de geometría durante un offset: siempre dice que NO se modificó nada y, si se puede, qué hacer. */
export function offsetErrorMessage(error: unknown): string {
  const candidate = (typeof error === "object" && error !== null ? error : {}) as { isAborted?: boolean; isNetworkError?: boolean; status?: number; body?: unknown };
  const code = (candidate.body as { code?: unknown } | undefined)?.code;
  if (!candidate.isAborted && !candidate.isNetworkError && typeof code === "string" && code in OFFSET_ERROR_MESSAGES) return OFFSET_ERROR_MESSAGES[code];
  if (!candidate.isAborted && !candidate.isNetworkError && !code) {
    if (candidate.status === 413) return OFFSET_ERROR_MESSAGES.payload_too_large;
    if (candidate.status === 504) return OFFSET_ERROR_MESSAGES.timeout;
  }
  return geometryErrorMessage(error);
}
