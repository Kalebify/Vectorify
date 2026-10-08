import { IDENTITY_MATRIX, type AffineMatrix } from "../svgTransform";
import type { BooleanRequest, BooleanResponse, GeometryOperationName, GeometryPiece, GeometryPoint, GeometrySubject } from "../../types/geometry";
import { createColorLayer } from "./colors";
import { DEFAULT_FLATNESS_MM, MAX_SERVER_SUBJECTS, MAX_SERVER_VERTICES, objectGeometry, pieceToPathData, toDocumentUnits, unitScale, validateBooleanResponse } from "./geometry";
import { isUnfilled } from "./objects";
import type { EditableDocument, EditableLayerMeta, EditorObject, EditProduction } from "./types";

/**
 * Operaciones booleanas del editor (M3-S08): Unión, Diferencia, Intersección y XOR sobre 2+ formas RELLENAS. Lógica pura (sin React ni Konva):
 * arma la petición al servicio de geometría de S04 (`POST /api/v2/geometry/boolean`, sin endpoint nuevo) y convierte su respuesta en UN comando.
 *
 * Decisiones (documentadas también en `docs/ADR_EDITOR_MVP3.md`):
 * 1. **Operandos y ORDEN explícitos.** El orden por defecto es el de PINTADO (el de abajo es A, luego B, C...); el usuario puede reordenar e invertir.
 *    *Unión* = A ∪ B ∪ ...; *Diferencia* = A − (B ∪ C ∪ ...) (A es la base: A − B ≠ B − A); *Intersección* = región común a TODOS (operación
 *    `intersection_all` del servidor, NO `intersection`, que es "cada subject ∩ la unión de los operandos"); *XOR* = región cubierta por un número
 *    IMPAR de operandos. Las líneas abiertas (`fill: "none"`) se rechazan: no son formas rellenas.
 * 2. **La capa/color del resultado NUNCA se decide en silencio.** Si todos los operandos están en la misma capa, el resultado va a ella; si no, el plan
 *    queda SIN destino (`target: null`) y `applyBooleanResult` se niega a aplicar hasta que el usuario elija una (entre las capas desbloqueadas y visibles,
 *    o un color nuevo -> capa nueva con la mecánica de S03). El color del resultado es el de la capa destino.
 * 3. **Originales**: por defecto se reemplazan por el resultado; con `keepOriginals` se agregan los resultados y los originales quedan. SIEMPRE un
 *    comando atómico (objetos + capa nueva), así que Undo recupera la versión anterior.
 * 4. **Resultado**: cada PIEZA disjunta es un objeto nuevo (id nuevo, capa y color del destino, sin matriz) con sus huecos como subpaths; salen en el
 *    orden determinista del servidor y se insertan en el lugar del operando MÁS ALTO de la capa destino (con originales conservados, justo encima de
 *    él; si ningún operando está en la capa destino, al tope de ella). Un operando que la operación no toca (`changed: false` en una diferencia) conserva
 *    su `d` con sus curvas. Resultado vacío => no se aplica.
 * 5. **Precisión**: los operandos se aplanan con su matriz horneada a la tolerancia del panel (default 0,01 mm); el resultado son polilíneas.
 */

export type BooleanOp = "union" | "difference" | "intersection" | "xor";

export const BOOLEAN_OPS: readonly BooleanOp[] = ["union", "difference", "intersection", "xor"];

export interface BooleanOpInfo {
  label: string;
  /** Símbolo corto para botones y etiquetas. */
  symbol: string;
  /** Qué significa con operandos A, B, C... (se muestra en el panel). */
  formula: string;
  /** Operación del servidor (`intersection` del editor es `intersection_all` en el cable). */
  wire: GeometryOperationName;
}

export const BOOLEAN_OP_INFO: Record<BooleanOp, BooleanOpInfo> = {
  union: { label: "Unión", symbol: "∪", formula: "A ∪ B ∪ C…: todo lo cubierto por algún operando.", wire: "union" },
  difference: { label: "Diferencia", symbol: "−", formula: "A − (B ∪ C…): A es la base y se le resta el resto; el orden importa.", wire: "difference" },
  intersection: { label: "Intersección", symbol: "∩", formula: "A ∩ B ∩ C…: solo la región común a TODOS los operandos.", wire: "intersection_all" },
  xor: { label: "XOR (exclusión)", symbol: "⊕", formula: "A ⊕ B ⊕ C…: lo cubierto por un número IMPAR de operandos.", wire: "xor" },
};

/** Tolerancia de aplanado y de "pieza despreciable" (mm): default, mínimo y máximo del campo avanzado del panel. */
export const DEFAULT_BOOLEAN_TOLERANCE_MM = DEFAULT_FLATNESS_MM;
export const MIN_BOOLEAN_TOLERANCE_MM = 0.001;
export const MAX_BOOLEAN_TOLERANCE_MM = 1;

/** Tolerancia del panel (mm, o unidades `u` sin escala física) -> unidades de documento. */
export function toleranceFromMm(value: number, mmFactor: number | null): number {
  return toDocumentUnits(value, unitScale(mmFactor));
}

/** Insignia de un operando: A, B, ... Z, luego A1, B1, ... (hay hasta 500 operandos). */
export function operandLetter(index: number): string {
  const letter = String.fromCharCode(65 + (index % 26));
  const round = Math.floor(index / 26);
  return round === 0 ? letter : `${letter}${round}`;
}

// ---- Orden de los operandos ----

/** Ids de capa en orden de pintado: primero la estructura vigente, después las capas con objetos que no figuren en ella. */
function paintLayerOrder(state: EditableDocument): string[] {
  const ids = (state.layers ?? []).map((layer) => layer.groupId);
  const known = new Set(ids);
  for (const groupId of Object.keys(state.objectsByLayer)) {
    if (!known.has(groupId)) ids.push(groupId);
  }
  return ids;
}

/** Los `ids` en orden de PINTADO del documento (el de abajo primero): el orden por defecto de los operandos (A = el de abajo). */
export function paintOrderIds(ids: ReadonlySet<string> | readonly string[], state: EditableDocument): string[] {
  const wanted = new Set(ids);
  const ordered: string[] = [];
  for (const groupId of paintLayerOrder(state)) {
    for (const object of state.objectsByLayer[groupId] ?? []) {
      if (wanted.has(object.id)) ordered.push(object.id);
    }
  }
  return ordered;
}

/** Sube (-1) o baja (+1) un operando una posición en la lista (A es el primero). Fuera de rango o sin cambio devuelve la MISMA lista. */
export function moveOperand(order: readonly string[], index: number, delta: -1 | 1): string[] {
  const target = index + delta;
  if (index < 0 || index >= order.length || target < 0 || target >= order.length) return [...order];
  const next = [...order];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** Invierte el orden de los operandos (el último pasa a ser A). */
export function reverseOperands(order: readonly string[]): string[] {
  return [...order].reverse();
}

/** Orden efectivo: el pedido (si es una permutación de los operandos) o, si no coincide, el de pintado. Ids desconocidos o repetidos se ignoran; los que faltan se agregan al final en orden de pintado. */
function resolveOrder(ids: readonly string[], requested: readonly string[] | undefined, state: EditableDocument): string[] {
  const base = paintOrderIds(ids, state);
  if (!requested) return base;
  const wanted = new Set(base);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of requested) {
    if (wanted.has(id) && !seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  for (const id of base) if (!seen.has(id)) result.push(id);
  return result;
}

// ---- Nombres legibles de los operandos ----

export interface OperandDescription {
  letter: string;
  layerName: string;
  /** Posición (1-based) del objeto dentro de su capa, en orden de pintado. */
  indexInLayer: number;
  /** «Rojo · objeto 2» -- nombre de capa + índice, además de la insignia (accesibilidad). */
  name: string;
}

export function describeOperand(object: EditorObject, index: number, state: EditableDocument): OperandDescription {
  const layerName = (state.layers ?? []).find((layer) => layer.groupId === object.layerGroupId)?.name ?? "Capa";
  const indexInLayer = Math.max(1, (state.objectsByLayer[object.layerGroupId] ?? []).findIndex((candidate) => candidate.id === object.id) + 1);
  return { letter: operandLetter(index), layerName, indexInLayer, name: `${layerName} · objeto ${indexInLayer}` };
}

// ---- Validación de los operandos ----

export type BooleanRejection = "too_few" | "unfilled" | "locked" | "hidden" | "missing" | "invalid_geometry" | "too_many" | "invalid_tolerance";

export interface BooleanRejectionInfo {
  ok: false;
  reason: BooleanRejection;
  message: string;
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

const NOTHING_CHANGED = "No se modificó nada.";

function reject(reason: BooleanRejection, message: string): BooleanRejectionInfo {
  return { ok: false, reason, message };
}

/**
 * Motivo por el que `operands` no pueden entrar a una booleana, o `null` si pueden. Es TODO O NADA: un operando rechazado no se omite en silencio
 * (omitir un B cambiaría el resultado de A − B), se rechaza la operación y se explica. Orden de comprobación: cantidad, formas rellenas, capas
 * bloqueadas, capas ocultas.
 */
export function validateBooleanOperands(operands: readonly EditorObject[], state: EditableDocument): BooleanRejectionInfo | null {
  if (operands.length < 2) return reject("too_few", "Seleccioná al menos 2 formas rellenas para una operación booleana.");
  const open = operands.filter((object) => isUnfilled(object.fill)).length;
  if (open > 0) {
    return reject(
      "unfilled",
      `Las booleanas operan sobre formas rellenas. ${plural(open, "objeto seleccionado es una línea abierta (sin relleno)", "objetos seleccionados son líneas abiertas (sin relleno)")}: sacalos de la selección. ${NOTHING_CHANGED}`,
    );
  }
  const layers = state.layers ?? [];
  const lockedIds = new Set(layers.filter((layer) => layer.locked).map((layer) => layer.groupId));
  const locked = operands.filter((object) => lockedIds.has(object.layerGroupId)).length;
  if (locked > 0) {
    return reject("locked", `${plural(locked, "objeto está en una capa bloqueada", "objetos están en capas bloqueadas")}: no se pueden modificar. Desbloqueá las capas en el panel de Capas. ${NOTHING_CHANGED}`);
  }
  const hiddenIds = new Set(layers.filter((layer) => !layer.visible).map((layer) => layer.groupId));
  const hidden = operands.filter((object) => hiddenIds.has(object.layerGroupId)).length;
  if (hidden > 0) {
    return reject("hidden", `${plural(hidden, "objeto está en una capa oculta", "objetos están en capas ocultas")}: mostrá las capas en el panel de Capas. ${NOTHING_CHANGED}`);
  }
  return null;
}

/** Motivo (para el tooltip de los botones) por el que NO se puede iniciar una booleana con esta selección, o `null`. */
export function booleanAvailability(selection: readonly EditorObject[], state: EditableDocument, options: { suspended?: boolean } = {}): string | null {
  if (options.suspended) return "Primero aplicá o cancelá el giro o reflejo pendiente: después podés usar una booleana.";
  return validateBooleanOperands(selection, state)?.message ?? null;
}

// ---- Capa destino ----

/** Elección explícita del usuario: una capa existente (por `groupId`) o un color nuevo (capa nueva con la mecánica de S03; `groupId` es el de la capa que se creará). */
export type BooleanTargetChoice = { kind: "layer"; groupId: string } | { kind: "new"; hex: string; groupId: string };

export interface BooleanTarget {
  groupId: string;
  name: string;
  colorHex: string;
  /** La capa todavía no existe: se crea en el MISMO comando. */
  created: boolean;
}

/** Capas que pueden recibir el resultado: desbloqueadas y visibles. Las de los operandos primero (en el orden de los operandos), después el resto. */
export function booleanTargetCandidates(operands: readonly EditorObject[], layers: readonly EditableLayerMeta[]): Array<{ layer: EditableLayerMeta; isOperandLayer: boolean }> {
  const operandLayers = new Set(operands.map((object) => object.layerGroupId));
  const usable = layers.filter((layer) => !layer.locked && layer.visible);
  const mine = usable.filter((layer) => operandLayers.has(layer.groupId));
  const others = usable.filter((layer) => !operandLayers.has(layer.groupId));
  return [...mine.map((layer) => ({ layer, isOperandLayer: true })), ...others.map((layer) => ({ layer, isOperandLayer: false }))];
}

const TARGET_REQUIRED = "Las formas están en capas distintas: elegí la capa de destino (el resultado toma su color). No se decide en silencio.";

function resolveTarget(
  operands: readonly EditorObject[],
  layers: readonly EditableLayerMeta[],
  choice: BooleanTargetChoice | null | undefined,
): { target: BooleanTarget | null; issue: string | null } {
  const operandLayerIds = [...new Set(operands.map((object) => object.layerGroupId))];
  const chosen: BooleanTargetChoice | null = choice ?? (operandLayerIds.length === 1 ? { kind: "layer", groupId: operandLayerIds[0] } : null);
  if (!chosen) return { target: null, issue: TARGET_REQUIRED };

  const existing = layers.find((layer) => layer.groupId === chosen.groupId);
  if (existing) {
    if (existing.locked) return { target: null, issue: `La capa destino «${existing.name}» está bloqueada: desbloqueala en el panel de Capas o elegí otra.` };
    if (!existing.visible) return { target: null, issue: `La capa destino «${existing.name}» está oculta: mostrala en el panel de Capas o elegí otra.` };
    return { target: { groupId: existing.groupId, name: existing.name, colorHex: existing.colorHex, created: false }, issue: null };
  }
  if (chosen.kind === "layer") return { target: null, issue: "La capa de destino ya no existe. Elegí otra." };
  const created = createColorLayer(layers, chosen.hex, chosen.groupId);
  if (!created) return { target: null, issue: `«${chosen.hex.trim() || "(vacío)"}» no es un color hex válido (#RGB o #RRGGBB) para la capa nueva.` };
  return { target: { groupId: created.groupId, name: created.name, colorHex: created.colorHex, created: true }, issue: null };
}

// ---- Plan ----

export interface BooleanOptions {
  op: BooleanOp;
  /** Orden de los operandos (ids): A, B, C... Por defecto, el de pintado. */
  order?: readonly string[];
  /** Capa destino elegida por el usuario. Con operandos en capas distintas es OBLIGATORIA (sin ella el plan queda sin destino). */
  targetLayer?: BooleanTargetChoice | null;
  keepOriginals?: boolean;
  /** Tolerancia en UNIDADES DE DOCUMENTO (el panel la guarda en mm: `toleranceFromMm`). */
  tolerance: number;
}

export interface BooleanPlan {
  op: BooleanOp;
  /** Operandos en el orden efectivo: A = `operands[0]`. Son las referencias del documento al planear (si cambian, no se aplica nada). */
  operands: EditorObject[];
  request: BooleanRequest;
  /** Identifica la PETICIÓN (operación + orden + tolerancia + geometría de los operandos): igual clave => mismo resultado, no hace falta volver a pedirlo. */
  requestKey: string;
  tolerance: number;
  keepOriginals: boolean;
  /** Capa destino ya resuelta, o `null` mientras el usuario no la elija (ver `targetIssue`). */
  target: BooleanTarget | null;
  targetIssue: string | null;
  /** Los operandos pertenecen a más de una capa (el destino lo decide el usuario). */
  layersDiffer: boolean;
  /** Ids de las capas de los operandos, en orden de aparición. */
  operandLayerIds: string[];
}

export type BooleanPlanResult = { ok: true; plan: BooleanPlan } | BooleanRejectionInfo;

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
 * Arma la petición de una booleana. `selection` son los operandos (cualquier orden; se resuelven contra `document` por id); `options.order` fija
 * A, B, C...; sin él rige el orden de pintado. Nunca decide la capa destino por el usuario: con operandos en capas distintas y sin
 * `options.targetLayer` el plan queda con `target: null` y `applyBooleanResult` lo rechaza.
 */
export function planBoolean(selection: readonly EditorObject[], document: EditableDocument, options: BooleanOptions): BooleanPlanResult {
  const current = new Map<string, EditorObject>();
  for (const objects of Object.values(document.objectsByLayer)) for (const object of objects) current.set(object.id, object);
  const found: EditorObject[] = [];
  const unique = [...new Map(selection.map((object) => [object.id, object])).values()];
  for (const object of unique) {
    const live = current.get(object.id);
    if (live) found.push(live);
  }
  if (found.length < unique.length) return reject("missing", `Algún operando ya no existe en el documento. ${NOTHING_CHANGED}`);

  const invalid = validateBooleanOperands(found, document);
  if (invalid) return invalid;
  if (!(options.tolerance > 0) || !Number.isFinite(options.tolerance)) return reject("invalid_tolerance", `La tolerancia debe ser un número mayor que 0. ${NOTHING_CHANGED}`);

  const byId = new Map(found.map((object) => [object.id, object]));
  const order = resolveOrder(found.map((object) => object.id), options.order, document);
  const operands = order.map((id) => byId.get(id)!);

  if (operands.length > MAX_SERVER_SUBJECTS) {
    return reject("too_many", `Son demasiados operandos (${operands.length}; el máximo es ${MAX_SERVER_SUBJECTS}). ${NOTHING_CHANGED}`);
  }
  const subjects: GeometrySubject[] = [];
  let vertices = 0;
  for (let index = 0; index < operands.length; index += 1) {
    const geometry = objectGeometry(operands[index], options.tolerance);
    if (!geometry || geometry.kind !== "polygon") {
      return reject("invalid_geometry", `El operando ${operandLetter(index)} no tiene una geometría que se pueda procesar (path ilegible o sin área). ${NOTHING_CHANGED}`);
    }
    subjects.push(...geometry.subjects);
    vertices += geometry.vertexCount;
  }
  if (vertices > MAX_SERVER_VERTICES) {
    return reject(
      "too_many",
      `La geometría de los operandos es demasiado grande (${vertices.toLocaleString("es-AR")} vértices; el máximo es ${MAX_SERVER_VERTICES.toLocaleString("es-AR")}). Probá con una tolerancia mayor. ${NOTHING_CHANGED}`,
    );
  }

  // A es la base de la diferencia: subjects = [A], operands = [B, C...]; el resto de las operaciones usan todas las formas como subjects.
  const wire = BOOLEAN_OP_INFO[options.op].wire;
  const request: BooleanRequest =
    options.op === "difference"
      ? { operation: wire, subjects: [subjects[0]], operands: subjects.slice(1), tolerance: options.tolerance }
      : { operation: wire, subjects, operands: [], tolerance: options.tolerance };

  const { target, issue } = resolveTarget(operands, document.layers ?? [], options.targetLayer);
  const operandLayerIds = [...new Set(operands.map((object) => object.layerGroupId))];
  return {
    ok: true,
    plan: {
      op: options.op,
      operands,
      request,
      requestKey: `${options.op}|${options.tolerance}|${operands.map((object) => `${object.id}#${serialOf(object)}`).join(",")}`,
      tolerance: options.tolerance,
      keepOriginals: options.keepOriginals === true,
      target,
      targetIssue: issue,
      layersDiffer: operandLayerIds.length > 1,
      operandLayerIds,
    },
  };
}

// ---- Resultado ----

/** Área de una pieza poligonal: |exterior| − Σ|huecos| (los anillos vienen válidos del servidor). */
export function pieceArea(piece: GeometryPiece): number {
  if (piece.type !== "polygon") return 0;
  const ringArea = (ring: GeometryPoint[]) => {
    let sum = 0;
    for (let index = 0; index < ring.length - 1; index += 1) sum += ring[index][0] * ring[index + 1][1] - ring[index + 1][0] * ring[index][1];
    return Math.abs(sum) / 2;
  };
  const [outer, ...holes] = piece.coordinates;
  return outer ? ringArea(outer) - holes.reduce((total, hole) => total + ringArea(hole), 0) : 0;
}

export interface BooleanShape {
  d: string;
  matrix: AffineMatrix;
}

export type BooleanOutcome =
  /** El servidor devolvió piezas nuevas (polilíneas aplanadas). */
  | { kind: "pieces"; shapes: BooleanShape[]; discarded: number }
  /** Diferencia donde el resto no toca a A (`changed: false`): el resultado ES A, con su `d` y su matriz originales. */
  | { kind: "unchanged"; shapes: BooleanShape[]; discarded: 0 }
  /** No queda nada (intersección de disjuntos, A totalmente cubierto, XOR de iguales...). */
  | { kind: "empty"; shapes: []; discarded: number };

/**
 * Lo que dice la respuesta del servidor para este plan, ya validado: sirve igual para la previsualización y para aplicar (así lo que se ve es
 * lo que se aplica). Piezas con área < tolerancia² se descartan (se informa cuántas); una pieza que no se pueda escribir como `d` válido o que
 * no sea un polígono invalida TODO el resultado.
 */
export function booleanOutcome(plan: BooleanPlan, response: BooleanResponse): { ok: true; outcome: BooleanOutcome } | { ok: false; error: string } {
  const invalid = validateBooleanResponse(plan.request, response);
  if (invalid) return { ok: false, error: `El servidor devolvió una respuesta incoherente (${invalid}). ${NOTHING_CHANGED}` };
  const item = response.results[0];

  if (plan.op === "difference" && !item.changed) {
    const base = plan.operands[0];
    return { ok: true, outcome: { kind: "unchanged", shapes: [{ d: base.d, matrix: base.matrix }], discarded: 0 } };
  }

  const minArea = plan.tolerance * plan.tolerance;
  const shapes: BooleanShape[] = [];
  let discarded = 0;
  for (const piece of item.geometries) {
    if (piece.type !== "polygon") return { ok: false, error: `El servidor devolvió una polilínea para formas rellenas. ${NOTHING_CHANGED}` };
    const d = pieceToPathData(piece);
    if (d === null) return { ok: false, error: `El servidor devolvió una pieza que no se puede dibujar. ${NOTHING_CHANGED}` };
    if (!(pieceArea(piece) >= minArea)) {
      discarded += 1;
      continue;
    }
    shapes.push({ d, matrix: IDENTITY_MATRIX });
  }
  if (shapes.length === 0) return { ok: true, outcome: { kind: "empty", shapes: [], discarded } };
  return { ok: true, outcome: { kind: "pieces", shapes, discarded } };
}

export interface BooleanSummary {
  op: BooleanOp;
  operandCount: number;
  /** Objetos que quedan como resultado (piezas nuevas, o 1 si el operando A se conservó intacto). */
  resultCount: number;
  /** El resultado es A sin cambios (conserva su `d`). */
  unchanged: boolean;
  /** Operandos que desaparecen (0 con «Conservar originales»). */
  removed: number;
  keepOriginals: boolean;
  discarded: number;
  target: BooleanTarget;
  /** Objetos del resultado que cambiaron de capa (A conservado en otra capa). */
  moved: number;
}

export type BooleanApplicationCode = "target_required" | "empty" | "nothing_to_do" | "stale" | "blocked" | "invalid_response";

export type BooleanApplication =
  | { ok: true; production: EditProduction; summary: BooleanSummary; resultIds: string[]; targetGroupId: string }
  | { ok: false; code: BooleanApplicationCode; error: string };

function defaultCreateId(): string {
  return crypto.randomUUID();
}

/**
 * Convierte la respuesta del servidor en UN comando (`EditProduction` atómica). Todo o nada:
 * - sin capa destino elegida => rechazo (la capa/color nunca se decide en silencio);
 * - la respuesta debe corresponder a la petición (`booleanOutcome`) y los operandos deben seguir siendo los mismos (por referencia): si el documento
 *   cambió mientras se calculaba, el resultado ya no lo describe y se descarta;
 * - resultado vacío => NO se aplica (nada cambia);
 * - capas de los operandos o destino bloqueadas/ocultas => rechazo.
 * Con `plan.keepOriginals` los resultados se agregan y los originales quedan; si no, los operandos desaparecen (salvo A intacto en una diferencia, que
 * conserva su id y su `d`). Una capa destino nueva viaja en el mismo comando (`layerMetas`).
 */
export function applyBooleanResult(plan: BooleanPlan, state: EditableDocument, response: BooleanResponse, createId: () => string = defaultCreateId): BooleanApplication {
  if (plan.target === null) return { ok: false, code: "target_required", error: plan.targetIssue ?? TARGET_REQUIRED };

  const outcomeResult = booleanOutcome(plan, response);
  if (!outcomeResult.ok) return { ok: false, code: "invalid_response", error: outcomeResult.error };
  const { outcome } = outcomeResult;
  if (outcome.kind === "empty") {
    return {
      ok: false,
      code: "empty",
      error: `El resultado está vacío: la operación no deja ninguna forma.${outcome.discarded > 0 ? ` (${plural(outcome.discarded, "pieza despreciable descartada", "piezas despreciables descartadas")}.)` : ""} ${NOTHING_CHANGED}`,
    };
  }

  for (const operand of plan.operands) {
    if (!(state.objectsByLayer[operand.layerGroupId] ?? []).includes(operand)) {
      return { ok: false, code: "stale", error: `El documento cambió mientras se calculaba. ${NOTHING_CHANGED} Volvé a abrir la operación.` };
    }
  }
  const invalid = validateBooleanOperands(plan.operands, state);
  if (invalid) return { ok: false, code: "blocked", error: invalid.message };

  const layers = state.layers ?? [];
  let targetMeta = layers.find((layer) => layer.groupId === plan.target!.groupId);
  const created = targetMeta === undefined;
  if (!targetMeta) {
    // Capa nueva elegida por el usuario: el mismo `groupId` que mostró el panel. El color y el nombre se recalculan sobre el estado vigente.
    const hex = plan.target.colorHex;
    targetMeta = createColorLayer(layers, hex, plan.target.groupId) ?? undefined;
    if (!targetMeta) return { ok: false, code: "target_required", error: plan.targetIssue ?? TARGET_REQUIRED };
  } else if (targetMeta.locked || !targetMeta.visible) {
    return { ok: false, code: "blocked", error: `La capa destino «${targetMeta.name}» está ${targetMeta.locked ? "bloqueada" : "oculta"}: elegí otra o corregilo en el panel de Capas. ${NOTHING_CHANGED}` };
  }
  const targetId = targetMeta.groupId;

  const operandIds = new Set(plan.operands.map((operand) => operand.id));
  const unchanged = outcome.kind === "unchanged";
  const base = plan.operands[0];

  // Objetos del resultado.
  let inserted: EditorObject[];
  let retainedInPlace: string | null = null;
  let moved = 0;
  if (unchanged) {
    // A intacto: conserva id, `d` y matriz. Si ya está en la capa destino no se mueve; si no, pasa a ella con su color.
    if (base.layerGroupId === targetId) {
      inserted = [];
      retainedInPlace = base.id;
    } else {
      inserted = [{ ...base, layerGroupId: targetId, ...(isUnfilled(base.fill) ? {} : { fill: targetMeta.colorHex }) }];
      moved = 1;
    }
  } else {
    inserted = outcome.shapes.map((shape) => ({ id: createId(), layerGroupId: targetId, d: shape.d, fill: targetMeta!.colorHex, matrix: shape.matrix }));
  }

  if (unchanged && plan.keepOriginals) {
    return { ok: false, code: "nothing_to_do", error: `El resultado es idéntico al operando A: no hay nada que agregar. ${NOTHING_CHANGED}` };
  }

  const removeIds = plan.keepOriginals ? new Set<string>() : new Set([...operandIds].filter((id) => id !== retainedInPlace));
  // En el caso A intacto en otra capa, A se quita de su capa de origen y reaparece (movido) en la destino: no se duplica.
  const layersOut: Record<string, EditorObject[]> = {};
  for (const groupId of plan.operandLayerIds) {
    if (groupId === targetId || removeIds.size === 0) continue;
    layersOut[groupId] = (state.objectsByLayer[groupId] ?? []).filter((object) => !removeIds.has(object.id));
  }

  const targetList = state.objectsByLayer[targetId] ?? [];
  let anchor = -1;
  targetList.forEach((object, index) => {
    if (operandIds.has(object.id)) anchor = index;
  });
  const targetOut: EditorObject[] = [];
  targetList.forEach((object, index) => {
    if (!removeIds.has(object.id)) targetOut.push(object);
    if (index === anchor) targetOut.push(...inserted);
  });
  if (anchor === -1) targetOut.push(...inserted);
  layersOut[targetId] = targetOut;

  const production: EditProduction = { layers: layersOut, atomic: true };
  if (created) production.layerMetas = [targetMeta];

  const resultIds = unchanged ? [base.id] : inserted.map((object) => object.id);
  return {
    ok: true,
    production,
    resultIds,
    targetGroupId: targetId,
    summary: {
      op: plan.op,
      operandCount: plan.operands.length,
      resultCount: resultIds.length,
      unchanged,
      removed: removeIds.size,
      keepOriginals: plan.keepOriginals,
      discarded: outcome.discarded,
      target: { groupId: targetId, name: targetMeta.name, colorHex: targetMeta.colorHex, created },
      moved,
    },
  };
}

// ---- Textos ----

/** Etiqueta del comando (Deshacer/Rehacer). */
export function booleanLabel(summary: BooleanSummary): string {
  const info = BOOLEAN_OP_INFO[summary.op];
  return `${info.label} (${plural(summary.operandCount, "objeto", "objetos")} → ${plural(summary.resultCount, "pieza", "piezas")})`;
}

/** Confirmación para el usuario tras aplicar. */
export function booleanNotice(summary: BooleanSummary): string {
  const info = BOOLEAN_OP_INFO[summary.op];
  const parts = [`${info.label} aplicada: ${plural(summary.operandCount, "objeto", "objetos")} → ${plural(summary.resultCount, "objeto", "objetos")} en la capa «${summary.target.name}».`];
  if (summary.target.created) parts.push("La capa es nueva (sin guardar todavía).");
  if (summary.unchanged) parts.push("El resto de los operandos no tocaba a A: se conservó intacto, con sus curvas.");
  parts.push(summary.keepOriginals ? "Los originales se conservaron." : `${plural(summary.removed, "original reemplazado", "originales reemplazados")}.`);
  if (summary.discarded > 0) parts.push(`${plural(summary.discarded, "pieza despreciable descartada", "piezas despreciables descartadas")}.`);
  return parts.join(" ");
}
