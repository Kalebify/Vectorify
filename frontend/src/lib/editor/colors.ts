import { hitTest, isUnfilled } from "./objects";
import { selectableObjects, type SelectableLayer } from "./selection";
import type { EditableDocument, EditableLayerMeta, EditorObject, EditProduction, Point } from "./types";

/**
 * Fill / Recolor / Eyedropper (MVP3-S03). Lógica pura, sin React ni Konva.
 *
 * DECISIÓN DE DOMINIO (la tarjeta pide documentarla): en este documento UNA CAPA = UN COLOR de paleta (relación 1:1) y el color de
 * un objeto es el de SU CAPA (el `fill` del `<path>` es redundante: se mantiene sincronizado, no manda). Por eso:
 *
 * 1. La identidad de un color es la CAPA (`groupId`), nunca su hex. Dos capas pueden tener el mismo hex visual sin ser el mismo
 *    color: NADA de este archivo usa un hex como clave (ni `Map<hex, ...>` ni agrupaciones por hex). `findLayersByHex` existe
 *    SOLO para ofrecerle al usuario coincidencias ("¿usar la capa «X»?"); jamás decide nada por sí sola.
 * 2. Fill sobre objetos = mover esos objetos a la capa del color elegido. El destino es una capa existente (por `groupId`) o un color
 *    libre NUEVO, que crea una capa nueva (con su color de paleta) dentro del MISMO comando: undo la elimina.
 * 3. Recolor tiene un alcance explícito (selección | capa | documento). Capa/documento CAMBIAN EL COLOR DE LA PROPIA CAPA (mismo
 *    `groupId`); si el hex destino coincide con otra capa solo se FUSIONA si el usuario lo pide, y la capa origen queda vacía (no
 *    se borra en silencio).
 * 4. Eyedropper devuelve la CAPA del objeto visible bajo el cursor (no un hex suelto); lee de capas bloqueadas, no de ocultas.
 */

/** Umbral por defecto de la confirmación de alcances grandes (objetos afectados). Configurable por el shell. */
export const DEFAULT_CONFIRM_THRESHOLD = 50;

export type RecolorScope = "selection" | "layer" | "document";

/**
 * Destino de un color: una capa existente (por `groupId`, la identidad) o un color libre NUEVO. En `new`, `groupId` es el id que tendrá
 * la capa creada: lo fija quien arma la petición UNA vez (así la previsualización y el Apply producen la MISMA capa, sin dejar capas
 * huérfanas) y, si esa capa ya existe, se usa tal cual en vez de crearla otra vez.
 */
export type ColorTarget = { kind: "layer"; groupId: string } | { kind: "new"; hex: string; groupId: string };

// ---- Hex ----

const HEX_PATTERN = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** `#rgb`, `#rrggbb` (con o sin `#`, cualquier caja) -> `#RRGGBB`; `null` si no es un color hex válido (no se aceptan alfa ni nombres). */
export function normalizeHex(input: string): string | null {
  const match = HEX_PATTERN.exec(input.trim());
  if (!match) return null;
  let digits = match[1];
  if (digits.length === 3) {
    digits = digits
      .split("")
      .map((digit) => digit + digit)
      .join("");
  }
  return `#${digits.toUpperCase()}`;
}

export function parseHex(input: string): Rgb | null {
  const normalized = normalizeHex(input);
  if (!normalized) return null;
  return { r: parseInt(normalized.slice(1, 3), 16), g: parseInt(normalized.slice(3, 5), 16), b: parseInt(normalized.slice(5, 7), 16) };
}

function channel(value: number): string {
  const clamped = Math.min(255, Math.max(0, Math.round(Number.isFinite(value) ? value : 0)));
  return clamped.toString(16).padStart(2, "0");
}

export function formatHex(rgb: Rgb): string {
  return `#${channel(rgb.r)}${channel(rgb.g)}${channel(rgb.b)}`.toUpperCase();
}

/** ¿Dos textos son el mismo color hex? SOLO para comparar valores visuales (p. ej. ofrecer una coincidencia), nunca para identificar capas. */
export function hexEquals(left: string, right: string): boolean {
  const a = normalizeHex(left);
  return a !== null && a === normalizeHex(right);
}

/**
 * Capas cuyo hex visual coincide con `hex`. SOLO para OFRECER una coincidencia al usuario ("Usar la capa «X»" / "Fusionar con «X»"):
 * dos capas con el mismo hex siguen siendo capas distintas y esta función las devuelve a ambas, en orden, sin agruparlas.
 */
export function findLayersByHex<T extends { groupId: string; colorHex: string }>(layers: readonly T[], hex: string, excludeGroupId?: string | null): T[] {
  const wanted = normalizeHex(hex);
  if (!wanted) return [];
  return layers.filter((layer) => layer.groupId !== excludeGroupId && normalizeHex(layer.colorHex) === wanted);
}

// ---- Capa nueva ----

/** Nombre por defecto de una capa creada por color; si ya hay una capa con ese nombre se desambigua ("Color #FF0000 (2)"). */
export function colorLayerName(hex: string, existingNames: readonly string[] = []): string {
  const base = `Color ${normalizeHex(hex) ?? hex}`;
  if (!existingNames.includes(base)) return base;
  let suffix = 2;
  while (existingNames.includes(`${base} (${suffix})`)) suffix += 1;
  return `${base} (${suffix})`;
}

/**
 * Capa nueva para un color libre (campos por defecto de la tarjeta): nombre "Color #RRGGBB" editable, `groupId` dado, orden al
 * final, visible, no bloqueada, operación de fabricación por defecto ("unassigned", como toda capa sin asignación explícita) y
 * `isNew` (aún no existe en el servidor). `null` si `hex` no es un color válido.
 */
export function createColorLayer(layers: readonly EditableLayerMeta[], hex: string, groupId: string): EditableLayerMeta | null {
  const colorHex = normalizeHex(hex);
  if (!colorHex) return null;
  return {
    groupId,
    name: colorLayerName(
      colorHex,
      layers.map((layer) => layer.name),
    ),
    colorHex,
    order: layers.reduce((highest, layer) => Math.max(highest, layer.order), -1) + 1,
    visible: true,
    locked: false,
    manufacturingOperation: "unassigned",
    isNew: true,
  };
}

// ---- Resumen y planes ----

export interface RecolorRequest {
  target: ColorTarget;
  /** Alcance "selección": ids de los objetos a recolorear. */
  objectIds?: ReadonlySet<string>;
  /** Alcances "capa" y "documento": capa cuyo color se cambia (origen). */
  sourceGroupId?: string | null;
  /** Alcances "capa" y "documento": fusionar explícitamente la capa origen con esta capa (debe tener el hex destino). */
  mergeIntoGroupId?: string | null;
}

export interface RecolorSummary {
  scope: RecolorScope;
  /** Objetos que cambian de color. */
  objectCount: number;
  /** Capas de ORIGEN afectadas (cuyos objetos cambian de color o de capa). */
  layerCount: number;
  /** Capa que recibe los objetos (selección / fusión), existente o creada por este comando. */
  destination: { groupId: string; name: string; colorHex: string; created: boolean } | null;
  /** Objetos de la selección que ya estaban en la capa destino (no cambian). */
  alreadyThere: number;
  /** Objetos omitidos por estar en capas bloqueadas / ocultas. */
  skippedLocked: number;
  skippedHidden: number;
  /** Fusión explícita pedida: la capa origen queda VACÍA (no se elimina). */
  merge: { fromGroupId: string; fromName: string; intoGroupId: string; intoName: string } | null;
  emptiedLayerIds: string[];
  /** La capa cambia de color conservando su `groupId` (alcances capa/documento sin fusión). */
  layerRecolor: { groupId: string; name: string; from: string; to: string } | null;
}

export interface ColorPlan {
  /** `null` si no hay nada que aplicar (ver `error`). */
  production: EditProduction | null;
  summary: RecolorSummary;
  /** Por qué no se puede aplicar (destino bloqueado, hex inválido, nada que cambiar...), en lenguaje de usuario. */
  error: string | null;
}

function emptySummary(scope: RecolorScope): RecolorSummary {
  return {
    scope,
    objectCount: 0,
    layerCount: 0,
    destination: null,
    alreadyThere: 0,
    skippedLocked: 0,
    skippedHidden: 0,
    merge: null,
    emptiedLayerIds: [],
    layerRecolor: null,
  };
}

function failure(summary: RecolorSummary, error: string): ColorPlan {
  return { production: null, summary, error };
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Ids de capa en orden de pintado: primero la estructura vigente (`state.layers`), después las capas con objetos que no estén en ella. */
function paintOrder(state: EditableDocument): string[] {
  const ids = (state.layers ?? []).map((layer) => layer.groupId);
  const known = new Set(ids);
  for (const groupId of Object.keys(state.objectsByLayer)) {
    if (!known.has(groupId)) ids.push(groupId);
  }
  return ids;
}

/** Verifica que una capa EXISTENTE pueda recibir/cambiar objetos: ni bloqueada ni oculta. */
function layerBlockedReason(layer: EditableLayerMeta, role: "destino" | "origen"): string | null {
  if (layer.locked) return `La capa ${role} «${layer.name}» está bloqueada: desbloqueala en el panel de Capas o elegí otra.`;
  if (!layer.visible) return `La capa ${role} «${layer.name}» está oculta: mostrala en el panel de Capas o elegí otra.`;
  return null;
}

/**
 * Pinta un objeto con `hex`: su relleno, o su TRAZO si es una línea abierta (`fill: "none"` con `stroke`, M3-S04: su color es el del trazo y
 * un `fill` nuevo la convertiría en una forma rellena). Devuelve el mismo objeto si ya tenía ese color.
 */
function paint(object: EditorObject, hex: string): EditorObject {
  if (isUnfilled(object.fill) && object.stroke !== undefined) return object.stroke === hex ? object : { ...object, stroke: hex };
  return object.fill === hex ? object : { ...object, fill: hex };
}

/** Objeto movido a `layer`: toma su `groupId` y su color (relleno, o trazo en las líneas abiertas). Lo reusan Fill/Recolor y "Pegar en la capa activa" (M3-S06). */
export function recolored(object: EditorObject, layer: { groupId: string; colorHex: string }): EditorObject {
  const painted = paint(object, layer.colorHex);
  return object.layerGroupId === layer.groupId ? painted : { ...painted, layerGroupId: layer.groupId };
}

function planSelection(state: EditableDocument, request: RecolorRequest): ColorPlan {
  const summary = emptySummary("selection");
  const layers = state.layers ?? [];
  const ids = request.objectIds ?? new Set<string>();
  if (ids.size === 0) return failure(summary, "No hay objetos seleccionados.");

  // Destino: capa existente por groupId, o capa nueva para un color libre (nunca una búsqueda por hex).
  let destination: EditableLayerMeta | undefined;
  let created = false;
  if (request.target.kind === "layer") {
    destination = layers.find((layer) => layer.groupId === request.target.groupId);
    if (!destination) return failure(summary, "La capa de destino ya no existe.");
  } else {
    destination = layers.find((layer) => layer.groupId === request.target.groupId);
    if (!destination) {
      destination = createColorLayer(layers, request.target.hex, request.target.groupId) ?? undefined;
      if (!destination) return failure(summary, `«${request.target.hex}» no es un color hex válido (#RGB o #RRGGBB).`);
      created = true;
    }
  }
  if (!created) {
    const blocked = layerBlockedReason(destination, "destino");
    if (blocked) return failure(summary, blocked);
  }
  summary.destination = { groupId: destination.groupId, name: destination.name, colorHex: destination.colorHex, created };

  const lockedIds = new Set(layers.filter((layer) => layer.locked).map((layer) => layer.groupId));
  const hiddenIds = new Set(layers.filter((layer) => !layer.visible).map((layer) => layer.groupId));
  const moves: EditorObject[] = [];
  const sourceIds: string[] = [];
  for (const groupId of paintOrder(state)) {
    for (const object of state.objectsByLayer[groupId] ?? []) {
      if (!ids.has(object.id)) continue;
      if (lockedIds.has(groupId)) summary.skippedLocked += 1;
      else if (hiddenIds.has(groupId)) summary.skippedHidden += 1;
      else if (groupId === destination.groupId) summary.alreadyThere += 1;
      else {
        moves.push(object);
        if (!sourceIds.includes(groupId)) sourceIds.push(groupId);
      }
    }
  }
  summary.objectCount = moves.length;
  summary.layerCount = sourceIds.length;

  if (moves.length === 0) {
    if (summary.skippedLocked > 0 || summary.skippedHidden > 0) {
      return failure(summary, "Los objetos seleccionados están en capas bloqueadas u ocultas: no se pueden modificar. Desbloquealas o mostralas en el panel de Capas.");
    }
    return failure(summary, `Los objetos seleccionados ya están en la capa «${destination.name}».`);
  }

  const movedIds = new Set(moves.map((object) => object.id));
  const layersOut: Record<string, EditorObject[]> = {};
  for (const groupId of sourceIds) layersOut[groupId] = (state.objectsByLayer[groupId] ?? []).filter((object) => !movedIds.has(object.id));
  layersOut[destination.groupId] = [...(state.objectsByLayer[destination.groupId] ?? []), ...moves.map((object) => recolored(object, destination))];

  const production: EditProduction = { layers: layersOut, atomic: true };
  if (created) production.layerMetas = [destination];
  return { production, summary, error: null };
}

/** Capa / documento: cambia el color de la propia capa origen (mismo `groupId`), o la fusiona con otra solo si el usuario lo pidió. */
function planLayerColor(scope: "layer" | "document", state: EditableDocument, request: RecolorRequest): ColorPlan {
  const summary = emptySummary(scope);
  const layers = state.layers ?? [];
  const source = layers.find((layer) => layer.groupId === request.sourceGroupId);
  if (!source) return failure(summary, scope === "document" ? "Elegí la capa de origen cuyo color se sustituye." : "Elegí la capa que se va a recolorear.");

  let hex: string | null;
  if (request.target.kind === "layer") {
    const targetLayer = layers.find((layer) => layer.groupId === request.target.groupId);
    if (!targetLayer) return failure(summary, "La capa de destino ya no existe.");
    hex = normalizeHex(targetLayer.colorHex);
  } else {
    hex = normalizeHex(request.target.hex);
  }
  if (!hex) return failure(summary, "El color de destino no es un color hex válido (#RGB o #RRGGBB).");

  const blocked = layerBlockedReason(source, "origen");
  if (blocked) {
    if (source.locked) summary.skippedLocked = (state.objectsByLayer[source.groupId] ?? []).length;
    else summary.skippedHidden = (state.objectsByLayer[source.groupId] ?? []).length;
    return failure(summary, blocked);
  }

  const objects = state.objectsByLayer[source.groupId] ?? [];
  summary.objectCount = objects.length;
  summary.layerCount = 1;

  if (request.mergeIntoGroupId) {
    const into = layers.find((layer) => layer.groupId === request.mergeIntoGroupId);
    if (!into) return failure(summary, "La capa con la que se fusionaría ya no existe.");
    if (into.groupId === source.groupId) return failure(summary, "No se puede fusionar una capa consigo misma.");
    const intoBlocked = layerBlockedReason(into, "destino");
    if (intoBlocked) return failure(summary, intoBlocked);
    if (!hexEquals(into.colorHex, hex)) return failure(summary, `La capa «${into.name}» no tiene el color ${hex}: solo se puede fusionar con una capa de ese color.`);
    summary.destination = { groupId: into.groupId, name: into.name, colorHex: into.colorHex, created: false };
    summary.merge = { fromGroupId: source.groupId, fromName: source.name, intoGroupId: into.groupId, intoName: into.name };
    if (objects.length === 0) return failure(summary, `La capa «${source.name}» no tiene objetos para fusionar.`);
    summary.emptiedLayerIds = [source.groupId];
    const production: EditProduction = {
      layers: {
        [source.groupId]: [],
        [into.groupId]: [...(state.objectsByLayer[into.groupId] ?? []), ...objects.map((object) => recolored(object, into))],
      },
      atomic: true,
    };
    return { production, summary, error: null };
  }

  if (hexEquals(source.colorHex, hex)) return failure(summary, `La capa «${source.name}» ya tiene el color ${hex}.`);
  summary.layerRecolor = { groupId: source.groupId, name: source.name, from: source.colorHex, to: hex };
  const production: EditProduction = {
    layers: objects.length > 0 ? { [source.groupId]: objects.map((object) => paint(object, hex)) } : {},
    layerMetas: [{ ...source, colorHex: hex }],
    atomic: true,
  };
  return { production, summary, error: null };
}

/** Plan completo (producción + resumen + motivo de rechazo) de un recoloreo con el alcance dado. Es lo que muestra el panel antes de aplicar. */
export function planRecolor(scope: RecolorScope, state: EditableDocument, request: RecolorRequest): ColorPlan {
  return scope === "selection" ? planSelection(state, request) : planLayerColor(scope, state, request);
}

/** Producción del comando de un recoloreo (`null` si no hay nada que aplicar). Un solo comando: objetos + estructura de capas. */
export function buildRecolorProduction(scope: RecolorScope, state: EditableDocument, request: RecolorRequest): EditProduction | null {
  return planRecolor(scope, state, request).production;
}

/** Fill = recolor del alcance "selección": mueve los objetos a la capa del color elegido (creándola si el color es nuevo). */
export function buildFillProduction(state: EditableDocument, objectIds: ReadonlySet<string>, target: ColorTarget): EditProduction | null {
  return planRecolor("selection", state, { target, objectIds }).production;
}

/** Resumen de lo que haría un recoloreo (el mismo que muestra el panel), sin construir el comando. */
export function summarizeRecolor(scope: RecolorScope, state: EditableDocument, request: RecolorRequest): RecolorSummary {
  return planRecolor(scope, state, request).summary;
}

/** "Se recolorarán N objetos en M capas." */
export function recolorHeadline(summary: RecolorSummary): string {
  if (summary.objectCount === 0 && summary.layerRecolor === null) return "No hay objetos para recolorear.";
  const verb = summary.objectCount === 1 ? "Se recolorará" : "Se recolorarán";
  return `${verb} ${plural(summary.objectCount, "objeto", "objetos")} en ${plural(Math.max(summary.layerCount, 1), "capa", "capas")}.`;
}

/**
 * ¿Hay que pedir confirmación antes de aplicar? Sí cuando el alcance es el DOCUMENTO, cuando se fusionan capas, o cuando los objetos
 * afectados llegan al umbral (`>= threshold`, default 50). Con umbral inválido (<= 0 o NaN) se usa el default.
 */
export function needsConfirmation(summary: RecolorSummary, threshold: number = DEFAULT_CONFIRM_THRESHOLD): boolean {
  const limit = Number.isFinite(threshold) && threshold > 0 ? threshold : DEFAULT_CONFIRM_THRESHOLD;
  return summary.scope === "document" || summary.merge !== null || summary.objectCount >= limit;
}

/** Etiqueta del comando (historial / botón Deshacer): "Rellenar 3 objetos con «Rojo»", "Recolorear la capa «Azul» a #00FF00", "Fusionar «A» con «B»". */
export function recolorLabel(summary: RecolorSummary): string {
  if (summary.merge) return `Fusionar «${summary.merge.fromName}» con «${summary.merge.intoName}»`;
  if (summary.layerRecolor) {
    const { name, from, to } = summary.layerRecolor;
    return summary.scope === "document" ? `Recolorear en el documento «${name}»: ${normalizeHex(from) ?? from} → ${to}` : `Recolorear la capa «${name}» a ${to}`;
  }
  const objects = plural(summary.objectCount, "objeto", "objetos");
  const destination = summary.destination;
  if (!destination) return `Recolorear ${objects}`;
  return destination.created ? `Rellenar ${objects} con el color nuevo ${destination.colorHex}` : `Rellenar ${objects} con «${destination.name}»`;
}

// ---- Color activo y fusiones ofrecidas ----

export interface ActiveColor {
  /** Nombre de la CAPA a la que remite el color (la identidad), no solo el hex. */
  name: string;
  hex: string;
  /** Color libre que todavía no es una capa (se crea al aplicar). */
  isNewColor: boolean;
}

/** Color activo resuelto contra las capas vigentes: una referencia a una capa que ya no existe (p. ej. se deshizo su creación) no es un color activo. */
export function resolveActiveColor(layers: readonly { groupId: string; name: string; colorHex: string }[], target: ColorTarget | null): ActiveColor | null {
  if (!target) return null;
  const existing = layers.find((layer) => layer.groupId === target.groupId);
  if (existing) return { name: existing.name, hex: existing.colorHex, isNewColor: false };
  if (target.kind === "layer") return null;
  const hex = normalizeHex(target.hex);
  return hex ? { name: `Color nuevo ${hex}`, hex, isNewColor: true } : null;
}

/** Capas con las que se PODRÍA fusionar la capa origen: las que tienen el color de destino (se OFRECEN; nunca se elige una en silencio). */
export function mergeCandidates<T extends { groupId: string; colorHex: string }>(layers: readonly T[], sourceGroupId: string | null, target: ColorTarget | null): T[] {
  if (!target || !sourceGroupId) return [];
  const hex = target.kind === "layer" ? layers.find((layer) => layer.groupId === target.groupId)?.colorHex : target.hex;
  return hex ? findLayersByHex(layers, hex, sourceGroupId) : [];
}

// ---- Eyedropper ----

export interface EyedropperHit {
  /** La CAPA del objeto (la identidad del color), no un hex suelto. */
  groupId: string;
  object: EditorObject;
}

/**
 * Objeto de más arriba bajo `point` entre los `pool` (objetos seleccionables: capas VISIBLES, en orden de pintado) -> su capa.
 * Hit-test geométrico de S01 (no muestrea píxeles: la fuente de verdad es el modelo). `null` en vacío.
 */
export function pickLayerAt(pool: readonly EditorObject[], point: Point, tolerance = 0): EyedropperHit | null {
  const hit = hitTest(pool, point, tolerance);
  return hit ? { groupId: hit.layerGroupId, object: hit } : null;
}

/**
 * Eyedropper sobre el documento: toma la capa del objeto visible más arriba bajo el cursor. Lee de capas BLOQUEADAS (solo lee,
 * no modifica) pero NO de las ocultas (no se ven, no se pueden "tomar").
 */
export function eyedrop(
  objectsByLayer: Record<string, EditorObject[]>,
  layers: readonly SelectableLayer[],
  visibility: Record<string, boolean>,
  point: Point,
  tolerance = 0,
): EyedropperHit | null {
  return pickLayerAt(selectableObjects(objectsByLayer, layers, visibility), point, tolerance);
}
