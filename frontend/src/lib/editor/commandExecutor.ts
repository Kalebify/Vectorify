import type { ApplyEditResult, EditableDocumentApi } from "../../hooks/useEditableDocument";
import { runArrange, type ArrangeActionId } from "./arrange";
import { planDelete, planDuplicate, pasteOffset } from "./clipboard";
import { colorDraft } from "./commandDrafts";
import { createColorLayer, planRecolor, recolorLabel, type ColorTarget, type RecolorScope } from "./colors";
import {
  COMMAND_ORIGINS,
  COMMAND_REGISTRY,
  findRawGeometry,
  isCommandType,
  isJsonValue,
  validateParameters,
  type CommandDraft,
  type CommandOrigin,
  type CommandSpec,
  type CommandType,
  type EditorCommand,
  type JsonValue,
} from "./commands";
import { cropFrame, cropProduction, isValidFrame, orientDocumentProduction } from "./frame";
import { moveProduction, objectsByIds, rotateProduction, scaleProduction, setBoundsProduction } from "./operations";
import { orientationFromCommand, orientSelectionProduction } from "./orientation";
import { planObjectErase } from "./erase";
import { removeObjects } from "./selection";
import { setBounds } from "./transform";
import type { EditableDocument, EditableLayerMeta, EditorObject, EditProduction } from "./types";

/**
 * Ejecutor declarativo de comandos (MVP3-S12), pensado para que MVP 4 (IA) emita los MISMOS comandos que la UI sin tocar el SVG.
 *
 * `executeCommand(host, input)` recibe una descripción `{ type, targets, parameters, origin }` -- solo ids, números, enums y textos cortos --, la VALIDA
 * (tipo conocido y ejecutable, esquema de parámetros, ids existentes, capas bloqueadas/ocultas, rangos) y la ejecuta por el MISMO camino que la UI: los
 * planificadores puros de `lib/editor/*` (`planDelete`, `runArrange`, `planRecolor`, `cropProduction`, ...) y `applyEdit`, de modo que el resultado es
 * EXACTAMENTE el mismo estado y deja la misma entrada en el historial (con `origin: "ai"` por defecto). Devuelve `{ ok, command?, errors[] }`.
 *
 * Reglas de oro:
 * - **Nunca recibe ni devuelve `d`/SVG crudos**: una entrada con claves o textos que parezcan geometría se rechaza (`raw_geometry`) y el resultado solo trae el
 *   `EditorCommand` (sin geometría) y mensajes.
 * - **Todo o nada**: cualquier problema devuelve errores y NO toca el documento. A diferencia de la UI (que omite y avisa lo que está en capas bloqueadas),
 *   un objeto objetivo en una capa bloqueada u oculta rechaza el comando entero: una IA debe saber exactamente qué se hizo.
 * - Los tipos que necesitan el servidor (booleanas, offset, corte, bridges), un gesto (dibujo, borrador, nodos), el portapapeles de la sesión o un PATCH
 *   (metadata de capa) se declaran `executable: false` en el registro con el motivo, y el ejecutor responde `not_executable`.
 */

export type ExecutorErrorCode =
  | "invalid_input"
  | "unknown_type"
  | "not_executable"
  | "raw_geometry"
  | "invalid_origin"
  | "invalid_targets"
  | "invalid_parameters"
  | "missing_target"
  | "unknown_target"
  | "layer_locked"
  | "layer_hidden"
  | "rejected"
  | "nothing_to_do"
  | "blocked"
  | "busy";

export interface ExecutorError {
  code: ExecutorErrorCode;
  message: string;
  /** Campo de la entrada al que se refiere (`type`, `targets.objectIds`, `parameters.dx`...), si aplica. */
  field?: string;
}

export type ExecutorResult =
  | {
      ok: true;
      /** El comando registrado en el historial (JSON puro, sin geometría). */
      command: EditorCommand;
      /** Objetos que el filtro de capas omitió (siempre 0 salvo operaciones de documento completo con capas ocultas). */
      skippedLockedObjects: number;
      skippedHiddenObjects: number;
    }
  | { ok: false; errors: ExecutorError[] };

/** Lo mínimo del documento editable que necesita el ejecutor. */
export type ExecutorHost = Pick<EditableDocumentApi, "applyEdit" | "getSnapshot">;

export interface ExecutorContext {
  /** mm por unidad de documento (o `null`/ausente sin escala física): solo para el desplazamiento por defecto de `object.duplicate`. */
  mmPerUnit?: number | null;
  /** Generador de ids de objetos y capas nuevos (default `crypto.randomUUID`); inyectable para pruebas deterministas. */
  createId?: () => string;
}

const INPUT_KEYS = ["type", "targets", "parameters", "origin"];
const MAX_TARGET_LIST = 5000;
const MAX_ID_LENGTH = 100;

function fail(code: ExecutorErrorCode, message: string, field?: string): ExecutorResult {
  return { ok: false, errors: [{ code, message, ...(field ? { field } : {}) }] };
}

function failAll(errors: ExecutorError[]): ExecutorResult {
  return { ok: false, errors };
}

// ---- Planificación por tipo ----

interface PlanInput {
  snapshot: EditableDocument;
  layers: readonly EditableLayerMeta[];
  /** Objetivos pedidos, resueltos contra el documento y en su orden de pintado. */
  objects: EditorObject[];
  ids: ReadonlySet<string>;
  parameters: Record<string, JsonValue>;
  context: Required<Pick<ExecutorContext, "createId">> & Pick<ExecutorContext, "mmPerUnit">;
}

type PlanOutput = { ok: true; production: EditProduction | null; label: string; draft?: Partial<CommandDraft> } | { ok: false; errors: ExecutorError[] };

const num = (parameters: Record<string, JsonValue>, name: string): number => parameters[name] as number;
const str = (parameters: Record<string, JsonValue>, name: string): string => parameters[name] as string;
const reject = (message: string, code: ExecutorErrorCode = "rejected"): PlanOutput => ({ ok: false, errors: [{ code, message }] });

function colorTarget(parameters: Record<string, JsonValue>, createId: () => string, fallbackLayerId?: string): ColorTarget {
  if (typeof parameters.targetLayerId === "string") return { kind: "layer", groupId: parameters.targetLayerId };
  if (typeof parameters.newColorHex === "string") return { kind: "new", hex: parameters.newColorHex, groupId: createId() };
  return { kind: "layer", groupId: fallbackLayerId ?? "" };
}

function recolorPlan(scope: RecolorScope, input: PlanInput, extras: { sourceGroupId?: string | null; mergeIntoGroupId?: string | null; fallbackLayerId?: string }, fromFillTool: boolean): PlanOutput {
  const { parameters, context, snapshot, ids } = input;
  if (scope === "selection" && ids.size === 0) return reject("El alcance «selection» necesita al menos un objeto en «targets.objectIds».", "missing_target");
  const request = {
    target: colorTarget(parameters, context.createId, extras.fallbackLayerId),
    objectIds: scope === "selection" ? ids : undefined,
    sourceGroupId: extras.sourceGroupId ?? null,
    mergeIntoGroupId: extras.mergeIntoGroupId ?? null,
  };
  const plan = planRecolor(scope, snapshot, request);
  if (!plan.production) return reject(plan.error ?? "No hay nada que recolorear.", "nothing_to_do");
  const label = recolorLabel(plan.summary);
  // El borrador lo arma la MISMA función que la UI: tipo y parámetros salen idénticos.
  return { ok: true, production: plan.production, label, draft: colorDraft(fromFillTool, scope, request, label) };
}

function arrangePlan(id: ArrangeActionId, input: PlanInput): PlanOutput {
  const reference = input.parameters.reference === "document" ? "document" : "selection";
  const result = runArrange(input.snapshot, input.objects, id, { reference });
  if (!result.production) return reject(result.summary.reason ?? "No hay nada que reorganizar.", "nothing_to_do");
  return { ok: true, production: result.production, label: result.label };
}

const PLANNERS: Partial<Record<CommandType, (input: PlanInput) => PlanOutput>> = {
  "object.move": (input) => ({ ok: true, production: moveProduction(input.snapshot, input.ids, num(input.parameters, "dx"), num(input.parameters, "dy")), label: "Mover objetos" }),
  "object.nudge": (input) => ({ ok: true, production: moveProduction(input.snapshot, input.ids, num(input.parameters, "dx"), num(input.parameters, "dy")), label: "Mover objetos con las flechas" }),
  "object.scale": (input) => {
    const { parameters } = input;
    const pivot = "pivotX" in parameters ? { x: num(parameters, "pivotX"), y: num(parameters, "pivotY") } : undefined;
    return { ok: true, production: scaleProduction(input.snapshot, input.ids, num(parameters, "sx"), num(parameters, "sy"), pivot), label: "Escalar objetos" };
  },
  "object.rotate": (input) => ({ ok: true, production: rotateProduction(input.snapshot, input.ids, num(input.parameters, "degrees")), label: "Rotar objetos" }),
  "object.setBounds": (input) => {
    const target = { x: num(input.parameters, "x"), y: num(input.parameters, "y"), width: num(input.parameters, "width"), height: num(input.parameters, "height") };
    if (setBounds(input.objects, target) === null) return reject("No se pudo aplicar ese tamaño o posición.");
    return { ok: true, production: setBoundsProduction(input.snapshot, input.ids, target), label: "Posicionar y dimensionar objetos" };
  },
  "object.delete": (input) => {
    const plan = planDelete(input.snapshot, input.ids);
    return plan.production ? { ok: true, production: plan.production, label: plan.label } : reject(plan.error ?? "No hay nada que eliminar.", "nothing_to_do");
  },
  "object.erase.objects": (input) => {
    const locked = new Set(input.layers.filter((layer) => layer.locked).map((layer) => layer.groupId));
    const plan = planObjectErase(input.snapshot, input.objects, locked);
    if (!plan.production) return reject("No hay nada que borrar.", "nothing_to_do");
    return { ok: true, production: removeObjects(input.snapshot, input.ids), label: `Borrar ${plan.removed} ${plan.removed === 1 ? "objeto" : "objetos"}` };
  },
  "object.duplicate": (input) => {
    const offset = "offsetX" in input.parameters ? { x: num(input.parameters, "offsetX"), y: num(input.parameters, "offsetY") } : pasteOffset(1, input.context.mmPerUnit ?? null);
    const plan = planDuplicate(input.objects, input.snapshot, { offset, createId: input.context.createId });
    // Se registra el desplazamiento EFECTIVO (el de la UI cuando la entrada no lo pidió), igual que el comando que deja la UI.
    return plan.production ? { ok: true, production: plan.production, label: plan.label, draft: { parameters: { offsetX: offset.x, offsetY: offset.y } } } : reject(plan.error ?? "No hay nada que duplicar.", "nothing_to_do");
  },
  "object.fill": (input) => recolorPlan("selection", input, {}, true),
  "object.recolor": (input) => recolorPlan(str(input.parameters, "scope") as RecolorScope, input, { sourceGroupId: typeof input.parameters.sourceLayerId === "string" ? input.parameters.sourceLayerId : null }, false),
  "object.merge": (input) =>
    recolorPlan(
      str(input.parameters, "scope") as RecolorScope,
      input,
      { sourceGroupId: str(input.parameters, "sourceLayerId"), mergeIntoGroupId: str(input.parameters, "mergeIntoLayerId"), fallbackLayerId: str(input.parameters, "mergeIntoLayerId") },
      false,
    ),
  "document.crop": (input) => {
    const { snapshot, parameters } = input;
    if (!snapshot.frame || !isValidFrame(snapshot.frame)) return reject("El documento todavía no tiene un área de trabajo medida.");
    const checked = cropFrame(snapshot.frame, { x: num(parameters, "x"), y: num(parameters, "y"), width: num(parameters, "width"), height: num(parameters, "height") });
    if (!checked.ok) return reject(checked.error);
    const removeOutside = parameters.removeOutside !== false;
    const effective = { x: checked.frame.x, y: checked.frame.y, width: checked.frame.width, height: checked.frame.height, removeOutside };
    return { ok: true, production: cropProduction(snapshot, checked.frame, removeOutside), label: "Recortar el área de trabajo", draft: { parameters: effective } };
  },
  "document.rotate": (input) => {
    if (!input.snapshot.frame || !isValidFrame(input.snapshot.frame)) return reject("El documento todavía no tiene un área de trabajo medida.");
    return { ok: true, production: orientDocumentProduction(input.snapshot, orientationFromCommand({ kind: "rotate", quarterTurns: num(input.parameters, "quarterTurns") })), label: "Rotar el documento" };
  },
  "document.flip": (input) => {
    if (!input.snapshot.frame || !isValidFrame(input.snapshot.frame)) return reject("El documento todavía no tiene un área de trabajo medida.");
    const orientation = orientationFromCommand({ kind: "flip", axis: str(input.parameters, "axis") as "horizontal" | "vertical", quarterTurns: (input.parameters.quarterTurns as number | undefined) ?? 0 });
    return {
      ok: true,
      production: orientDocumentProduction(input.snapshot, orientation),
      label: "Reflejar el documento",
      draft: { parameters: { axis: str(input.parameters, "axis"), quarterTurns: (input.parameters.quarterTurns as number | undefined) ?? 0 } },
    };
  },
  "selection.rotate": (input) => ({
    ok: true,
    production: orientSelectionProduction(input.snapshot, input.ids, orientationFromCommand({ kind: "rotate", quarterTurns: num(input.parameters, "quarterTurns") })),
    label: "Rotar la selección",
  }),
  "selection.flip": (input) => ({
    ok: true,
    production: orientSelectionProduction(
      input.snapshot,
      input.ids,
      orientationFromCommand({ kind: "flip", axis: str(input.parameters, "axis") as "horizontal" | "vertical", quarterTurns: (input.parameters.quarterTurns as number | undefined) ?? 0 }),
    ),
    label: "Reflejar la selección",
    draft: { parameters: { axis: str(input.parameters, "axis"), quarterTurns: (input.parameters.quarterTurns as number | undefined) ?? 0 } },
  }),
  "arrange.align": (input) => arrangePlan(`align-${str(input.parameters, "mode")}` as ArrangeActionId, input),
  "arrange.distribute": (input) => arrangePlan(`distribute-${str(input.parameters, "axis")}` as ArrangeActionId, input),
  "arrange.zorder": (input) => arrangePlan(`z-${str(input.parameters, "action")}` as ArrangeActionId, input),
  "layer.create": (input) => {
    const created = createColorLayer(input.layers, str(input.parameters, "colorHex"), input.context.createId());
    if (!created) return reject("El color no es un hex válido (#RGB o #RRGGBB).");
    const name = typeof input.parameters.name === "string" ? input.parameters.name.trim() : "";
    const layer = name ? { ...created, name } : created;
    return { ok: true, production: { layers: {}, layerMetas: [layer] }, label: `Crear la capa «${layer.name}»` };
  },
};

/** Los tipos que el ejecutor sabe ejecutar: exactamente los `executable: true` del registro (un test lo verifica). */
export const EXECUTABLE_TYPES = Object.keys(PLANNERS) as CommandType[];

// ---- Validación de la entrada ----

function parseTargets(value: unknown): { ok: true; layerIds: string[]; objectIds: string[] } | { ok: false; error: ExecutorError } {
  if (value === undefined) return { ok: true, layerIds: [], objectIds: [] };
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: { code: "invalid_targets", message: "«targets» debe ser un objeto con «layerIds» y/o «objectIds».", field: "targets" } };
  const record = value as Record<string, unknown>;
  const extra = Object.keys(record).filter((key) => key !== "layerIds" && key !== "objectIds");
  if (extra.length > 0) return { ok: false, error: { code: "invalid_targets", message: `«targets» solo admite «layerIds» y «objectIds» (sobra: ${extra.join(", ")}).`, field: "targets" } };
  const lists: Record<"layerIds" | "objectIds", string[]> = { layerIds: [], objectIds: [] };
  for (const key of ["layerIds", "objectIds"] as const) {
    const list = record[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length > MAX_TARGET_LIST || !list.every((item) => typeof item === "string" && item.length > 0 && item.length <= MAX_ID_LENGTH)) {
      return { ok: false, error: { code: "invalid_targets", message: `«targets.${key}» debe ser una lista de ids de texto (máximo ${MAX_TARGET_LIST}).`, field: `targets.${key}` } };
    }
    lists[key] = [...new Set(list as string[])];
  }
  return { ok: true, ...lists };
}

function describeIds(ids: readonly string[]): string {
  return ids.length <= 5 ? ids.join(", ") : `${ids.slice(0, 5).join(", ")} y ${ids.length - 5} más`;
}

function resultFromApply(result: ApplyEditResult): ExecutorResult {
  if (result.applied && result.command) {
    return { ok: true, command: result.command, skippedLockedObjects: result.skippedLockedObjects, skippedHiddenObjects: result.skippedHiddenObjects };
  }
  switch (result.reason) {
    case "blocked":
      return fail("blocked", "Las capas afectadas están bloqueadas u ocultas: no se modificó nada.");
    case "gesture_active":
    case "history_busy":
      return fail("busy", "Hay una transformación pendiente o un cambio de capa guardándose: esperá a que termine. No se modificó nada.");
    default:
      return fail("nothing_to_do", "El comando no cambia nada en el documento.");
  }
}

/**
 * Valida y ejecuta un comando declarativo. Devuelve `{ ok: true, command }` (el comando registrado, sin geometría) o `{ ok: false, errors }` sin haber tocado
 * el documento. Ver el comentario del módulo para las reglas.
 */
export function executeCommand(host: ExecutorHost, input: unknown, context: ExecutorContext = {}): ExecutorResult {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return fail("invalid_input", "El comando debe ser un objeto { type, targets, parameters, origin }.");
  const raw = findRawGeometry(input, "input");
  if (raw) return fail("raw_geometry", `«${raw}» parece geometría o SVG crudos: el ejecutor solo acepta ids, números, enums y textos cortos.`, raw);
  const record = input as Record<string, unknown>;
  const extra = Object.keys(record).filter((key) => !INPUT_KEYS.includes(key));
  if (extra.length > 0) return fail("invalid_input", `Claves no admitidas en el comando: ${extra.join(", ")}.`);

  if (!isCommandType(record.type)) return fail("unknown_type", `«${String(record.type)}» no es un tipo de comando conocido.`, "type");
  const type: CommandType = record.type;
  const spec: CommandSpec = COMMAND_REGISTRY[type];
  const planner = PLANNERS[type];
  if (!spec.executable || !planner) return fail("not_executable", `«${type}» no se puede ejecutar de forma declarativa: ${spec.reason ?? "no está soportado."}`, "type");

  const origin: CommandOrigin = record.origin === undefined ? "ai" : (record.origin as CommandOrigin);
  if (!COMMAND_ORIGINS.includes(origin)) return fail("invalid_origin", "«origin» debe ser user, ai o system.", "origin");

  const targets = parseTargets(record.targets);
  if (!targets.ok) return failAll([targets.error]);

  const rawParameters = record.parameters ?? {};
  if (rawParameters === null || typeof rawParameters !== "object" || Array.isArray(rawParameters) || !isJsonValue(rawParameters)) {
    return fail("invalid_parameters", "«parameters» debe ser un objeto JSON con valores simples.", "parameters");
  }
  const parameters = Object.fromEntries(Object.entries(rawParameters as Record<string, JsonValue>).filter(([, value]) => value !== undefined)) as Record<string, JsonValue>;
  const problems = validateParameters(type, parameters, { requireAll: true, ranges: true });
  if (problems.length > 0) return failAll(problems.map((message) => ({ code: "invalid_parameters" as const, message })));

  // Contra el documento: ids existentes, capas existentes, y nada de objetos en capas bloqueadas u ocultas (todo o nada).
  const snapshot = host.getSnapshot();
  const layers = snapshot.layers ?? [];
  const layerById = new Map(layers.map((layer) => [layer.groupId, layer]));
  const unknownLayers = targets.layerIds.filter((id) => !layerById.has(id));
  if (unknownLayers.length > 0) return fail("unknown_target", `No existen las capas: ${describeIds(unknownLayers)}.`, "targets.layerIds");
  const found = objectsByIds(snapshot, new Set(targets.objectIds));
  const foundIds = new Set(found.map((object) => object.id));
  const unknownObjects = targets.objectIds.filter((id) => !foundIds.has(id));
  if (unknownObjects.length > 0) return fail("unknown_target", `No existen los objetos: ${describeIds(unknownObjects)}.`, "targets.objectIds");
  if (spec.needsObjects && found.length === 0) return fail("missing_target", `«${type}» necesita al menos un objeto en «targets.objectIds».`, "targets.objectIds");
  const lockedNames = [...new Set(found.filter((object) => layerById.get(object.layerGroupId)?.locked).map((object) => layerById.get(object.layerGroupId)!.name))];
  if (lockedNames.length > 0) return fail("layer_locked", `Hay objetos en capas bloqueadas (${lockedNames.join(", ")}): desbloqueá las capas primero. No se modificó nada.`, "targets.objectIds");
  const hiddenNames = [...new Set(found.filter((object) => layerById.get(object.layerGroupId)?.visible === false).map((object) => layerById.get(object.layerGroupId)!.name))];
  if (hiddenNames.length > 0) return fail("layer_hidden", `Hay objetos en capas ocultas (${hiddenNames.join(", ")}): mostrá las capas primero. No se modificó nada.`, "targets.objectIds");

  const createId = context.createId ?? (() => crypto.randomUUID());
  let planned: PlanOutput;
  try {
    planned = planner({ snapshot, layers, objects: found, ids: foundIds, parameters, context: { createId, mmPerUnit: context.mmPerUnit } });
  } catch {
    return fail("rejected", "No se pudo planificar el comando con esos parámetros. No se modificó nada.");
  }
  if (!planned.ok) return failAll(planned.errors);
  const production = planned.production;
  if (!production) return fail("nothing_to_do", "El comando no cambia nada en el documento.");

  // El borrador sale del planificador cuando éste lo arma (Fill/Recolor/Fusionar comparten `colorDraft` con la UI); si no, es la propia entrada validada.
  const draft: CommandDraft = {
    type: planned.draft?.type ?? type,
    label: planned.draft?.label ?? planned.label,
    parameters: planned.draft?.parameters ?? parameters,
    origin,
  };
  // Se re-evalúa contra el estado vigente al aplicar (por si cambió entre planificar y aplicar): si cambió, no se aplica.
  const planBase = snapshot.objectsByLayer;
  return resultFromApply(host.applyEdit(draft, (current) => (current.objectsByLayer === planBase ? production : null)));
}

// ---- Catálogo para quien emite comandos ----

export interface CatalogParameter {
  kind: string;
  description: string;
  required: boolean;
  options?: readonly string[];
  min?: number;
  max?: number;
}

export interface CatalogEntry {
  type: CommandType;
  group: string;
  label: string;
  summary: string;
  executable: boolean;
  reason?: string;
  needsObjects: boolean;
  parameters: Record<string, CatalogParameter>;
}

/** Descripción JSON-pura de todos los tipos (qué parámetros acepta cada uno y si se puede ejecutar): lo que MVP 4 le muestra a la IA. */
export function commandCatalog(): CatalogEntry[] {
  return (Object.values(COMMAND_REGISTRY) as CommandSpec[]).map((spec) => ({
    type: spec.type,
    group: spec.group,
    label: spec.label,
    summary: spec.summary,
    executable: spec.executable,
    ...(spec.reason ? { reason: spec.reason } : {}),
    needsObjects: spec.needsObjects === true,
    parameters: Object.fromEntries(
      Object.entries(spec.params).map(([name, param]) => [
        name,
        {
          kind: param.kind,
          description: param.description,
          required: param.required === true,
          ...(param.options ? { options: param.options } : {}),
          ...(param.min !== undefined ? { min: param.min } : {}),
          ...(param.max !== undefined ? { max: param.max } : {}),
        },
      ]),
    ),
  }));
}
