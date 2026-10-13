import type { EditorEdit, EditorObject, LayerMetaChange } from "./types";
import { sameObjectContent } from "./objects";

/**
 * Comandos del editor (MVP3-S12, ADR D2). Lógica pura, sin React.
 *
 * Cada entrada del historial es `{ command, patch }`:
 * - `command` = `EditorCommand` v1: la DESCRIPCIÓN declarativa y serializable (JSON puro) de la operación -- `type` de un registro cerrado, `targets`
 *   (ids de capa y de objeto), `parameters` (números, enums, ids y textos cortos), `origin` y `timestamp`. NUNCA lleva `d` ni SVG crudos: así el
 *   historial se exporta y se revisa sin exponer la geometría, y MVP 4 (IA) podrá emitir y recibir los mismos comandos sin tocar el SVG.
 * - `patch` = el `EditorEdit` interno de S01-S03 (snapshots `before/after` de objetos, marco, estructura de capas o metadata de capa): sigue siendo
 *   la fuente de la reversión EXACTA. El comando describe; el parche revierte.
 *
 * El registro (`COMMAND_REGISTRY`) documenta cada tipo: etiqueta por defecto, parámetros (con esquema validable), si el ejecutor declarativo
 * (`commandExecutor.ts`) puede ejecutarlo y, si no, por qué. `docs/EDITOR_COMMANDS.md` lo explica con ejemplos.
 */

// ---- JSON puro ----

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** ¿Es JSON puro? Números finitos, sin `undefined`, funciones ni ciclos (profundidad acotada). */
export function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 8) return false;
  if (value === null) return true;
  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object":
      if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
      return Object.values(value as Record<string, unknown>).every((item) => isJsonValue(item, depth + 1));
    default:
      return false;
  }
}

// ---- Tipos del comando ----

export const COMMAND_VERSION = 1;

export type CommandOrigin = "user" | "ai" | "system";
export const COMMAND_ORIGINS: readonly CommandOrigin[] = ["user", "ai", "system"];

/** Registro CERRADO de tipos de comando (todas las operaciones mutantes de MVP 3). Un tipo desconocido es un error de programación. */
export const COMMAND_TYPES = [
  "object.move",
  "object.scale",
  "object.rotate",
  "object.nudge",
  "object.setBounds",
  "object.delete",
  "object.cut",
  "object.paste",
  "object.pasteInPlace",
  "object.pasteToLayer",
  "object.duplicate",
  "object.fill",
  "object.recolor",
  "object.merge",
  "object.draw",
  "object.erase.objects",
  "object.erase.subtract",
  "path.moveAnchors",
  "path.moveHandle",
  "path.addNode",
  "path.deleteNodes",
  "path.setNodeKind",
  "path.toggleSegment",
  "path.closeSubpath",
  "path.openSubpath",
  "path.setNodeCoords",
  "document.crop",
  "document.rotate",
  "document.flip",
  "selection.rotate",
  "selection.flip",
  "arrange.align",
  "arrange.distribute",
  "arrange.zorder",
  "geometry.boolean",
  "geometry.offset",
  "geometry.split",
  "geometry.bridge",
  "layer.create",
  "layer.rename",
  "layer.setVisible",
  "layer.setLocked",
  "layer.setOperation",
  "layer.reorder",
] as const;

export type CommandType = (typeof COMMAND_TYPES)[number];

export function isCommandType(value: unknown): value is CommandType {
  return typeof value === "string" && (COMMAND_TYPES as readonly string[]).includes(value);
}

export interface CommandTargets {
  layerIds: string[];
  objectIds: string[];
}

/** El comando serializable (JSON puro). `sequence` crece de a uno dentro de la sesión; `timestamp` = milisegundos desde la época. */
export interface EditorCommand {
  version: typeof COMMAND_VERSION;
  id: string;
  sequence: number;
  type: CommandType;
  label: string;
  targets: CommandTargets;
  parameters: Record<string, JsonValue>;
  origin: CommandOrigin;
  timestamp: number;
}

/**
 * Lo que aporta cada call-site de `applyEdit`/`commitGesture`: el tipo y, si quiere, la `label` (si falta se deriva del registro), los `targets`
 * (si faltan se derivan de lo que REALMENTE cambió el parche), los `parameters` y el `origin` (por defecto `"user"`).
 */
export interface CommandDraft {
  type: CommandType;
  label?: string;
  targets?: { layerIds?: readonly string[]; objectIds?: readonly string[] };
  parameters?: Record<string, JsonValue | undefined>;
  origin?: CommandOrigin;
}

/** Tope de ids de objeto que se guardan en `targets` (el conteo exacto viaja en `parameters.objectCount`): acota la memoria de un historial de 200 entradas. */
export const MAX_TARGET_IDS = 500;

// ---- Esquema de parámetros ----

export type ParamKind = "number" | "integer" | "boolean" | "string" | "enum" | "id" | "hex" | "ids";

export interface ParamSpec {
  kind: ParamKind;
  description: string;
  required?: boolean;
  /** `enum`: valores permitidos. */
  options?: readonly string[];
  /** `number`/`integer`: rango cerrado. */
  min?: number;
  max?: number;
  /** `number`: el valor no puede ser 0. */
  nonZero?: boolean;
}

const MAX_TEXT_LENGTH = 200;
const MAX_ID_LENGTH = 100;
const HEX_PATTERN = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Parámetros que agrega el propio historial a partir del parche; el ejecutor los rechaza como ENTRADA. */
export const RESERVED_PARAMETERS = ["objectCount", "createdLayerIds"] as const;

const num = (description: string, extra: Partial<ParamSpec> = {}): ParamSpec => ({ kind: "number", description, ...extra });
const int = (description: string, extra: Partial<ParamSpec> = {}): ParamSpec => ({ kind: "integer", description, ...extra });
const bool = (description: string, extra: Partial<ParamSpec> = {}): ParamSpec => ({ kind: "boolean", description, ...extra });
const text = (description: string, extra: Partial<ParamSpec> = {}): ParamSpec => ({ kind: "string", description, ...extra });
const id = (description: string, extra: Partial<ParamSpec> = {}): ParamSpec => ({ kind: "id", description, ...extra });
const hex = (description: string, extra: Partial<ParamSpec> = {}): ParamSpec => ({ kind: "hex", description, ...extra });
const ids = (description: string, extra: Partial<ParamSpec> = {}): ParamSpec => ({ kind: "ids", description, ...extra });
const oneOf = (description: string, options: readonly string[], extra: Partial<ParamSpec> = {}): ParamSpec => ({ kind: "enum", description, options, ...extra });
const required = { required: true } as const;

export type CommandGroup = "object" | "path" | "document" | "selection" | "arrange" | "geometry" | "layer";

export interface CommandSpec {
  type: CommandType;
  group: CommandGroup;
  /** Etiqueta por defecto (español) cuando el call-site no aporta la suya. */
  label: string;
  /** Qué hace, en una frase. */
  summary: string;
  /** Parámetros documentados (los que emite la UI y los que acepta el ejecutor). */
  params: Record<string, ParamSpec>;
  /** ¿Puede ejecutarlo el ejecutor declarativo (`commandExecutor.ts`)? */
  executable: boolean;
  /** Si `executable` es false: por qué (se devuelve tal cual en el error del ejecutor). */
  reason?: string;
  /** El ejecutor exige `targets.objectIds` (≥ 1). */
  needsObjects?: boolean;
  /** Nunca la emite la UI sola: viaja dentro del comando que la provoca (o la emite el ejecutor). */
  implicit?: boolean;
  /** Reglas cruzadas entre parámetros (exclusiones mutuas, pares obligatorios); devuelve mensajes de error. */
  refine?: (parameters: Record<string, JsonValue>) => string[];
}

const GESTURE_REASON = "Nace de un gesto sobre el canvas (puntos del puntero): la IA no recibe ni emite geometría cruda.";
const SERVER_REASON = "Necesita el servicio de geometría del servidor (asíncrono): el ejecutor declarativo opera solo sobre el documento en memoria.";
const NODES_REASON = "Edita nodos de un path por índice y con puntos crudos: la IA no recibe ni emite geometría cruda (MVP 4 usará operaciones de más alto nivel).";
const CLIPBOARD_REASON = "Depende del portapapeles interno de la sesión de la UI, que el ejecutor no controla.";
const PATCH_REASON = "Persiste por PATCH inmediato al servidor (asíncrono) y entra al historial con su PATCH inverso: lo orquesta el cliente de la API, no el ejecutor síncrono.";

const COLOR_TARGET = {
  targetLayerId: id("Capa cuyo color se usa (identidad por groupId, nunca por hex)."),
  newColorHex: hex("Color libre nuevo: crea una capa nueva con ese color (#RGB o #RRGGBB)."),
} satisfies Record<string, ParamSpec>;

const exactlyOneColor = (parameters: Record<string, JsonValue>): string[] =>
  ("targetLayerId" in parameters) === ("newColorHex" in parameters) ? ["Indicá exactamente uno de «targetLayerId» o «newColorHex»."] : [];

const bothOrNone = (a: string, b: string) => (parameters: Record<string, JsonValue>): string[] =>
  (a in parameters) === (b in parameters) ? [] : [`«${a}» y «${b}» van juntos o ninguno.`];

const NODE_COUNT = int("Cantidad de nodos afectados.", { min: 0 });

export const COMMAND_REGISTRY: Record<CommandType, CommandSpec> = {
  "object.move": {
    type: "object.move",
    group: "object",
    label: "Mover objetos",
    summary: "Traslada los objetos (arrastre del canvas o ejecutor): compone la matriz, `d` queda intacto.",
    params: { dx: num("Desplazamiento horizontal en unidades de documento.", required), dy: num("Desplazamiento vertical en unidades de documento.", required) },
    executable: true,
    needsObjects: true,
  },
  "object.scale": {
    type: "object.scale",
    group: "object",
    label: "Escalar objetos",
    summary: "Escala los objetos como grupo (handles del Transformer o ejecutor) alrededor de un pivote.",
    params: {
      sx: num("Factor horizontal (negativo = reflejo).", { ...required, nonZero: true, min: -1000, max: 1000 }),
      sy: num("Factor vertical (negativo = reflejo).", { ...required, nonZero: true, min: -1000, max: 1000 }),
      pivotX: num("X del pivote en documento; sin pivote se usa el centro del grupo."),
      pivotY: num("Y del pivote en documento."),
    },
    executable: true,
    needsObjects: true,
    refine: bothOrNone("pivotX", "pivotY"),
  },
  "object.rotate": {
    type: "object.rotate",
    group: "object",
    label: "Rotar objetos",
    summary: "Rota los objetos como grupo alrededor del centro de su caja (handle del Transformer, Inspector o ejecutor).",
    params: { degrees: num("Giro relativo en grados (horario en pantalla).", { ...required, min: -3600, max: 3600 }) },
    executable: true,
    needsObjects: true,
  },
  "object.nudge": {
    type: "object.nudge",
    group: "object",
    label: "Mover objetos con las flechas",
    summary: "Empuja la selección con el teclado; una ráfaga de flechas se funde en un comando con el desplazamiento acumulado.",
    params: { dx: num("Desplazamiento horizontal acumulado en unidades de documento.", required), dy: num("Desplazamiento vertical acumulado en unidades de documento.", required) },
    executable: true,
    needsObjects: true,
  },
  "object.setBounds": {
    type: "object.setBounds",
    group: "object",
    label: "Posicionar y dimensionar objetos",
    summary: "Fija posición y tamaño del grupo (Inspector numérico o ejecutor), en unidades de documento.",
    params: {
      x: num("X del grupo.", required),
      y: num("Y del grupo.", required),
      width: num("Ancho del grupo (> 0).", { ...required, min: 1e-6 }),
      height: num("Alto del grupo (> 0).", { ...required, min: 1e-6 }),
    },
    executable: true,
    needsObjects: true,
  },
  "object.delete": {
    type: "object.delete",
    group: "object",
    label: "Eliminar objetos",
    summary: "Elimina los objetos (Suprimir, botón o ejecutor); lo que está en capas bloqueadas se omite.",
    params: {},
    executable: true,
    needsObjects: true,
  },
  "object.cut": {
    type: "object.cut",
    group: "object",
    label: "Cortar objetos",
    summary: "Copia al portapapeles interno y elimina.",
    params: {},
    executable: false,
    reason: CLIPBOARD_REASON,
  },
  "object.paste": {
    type: "object.paste",
    group: "object",
    label: "Pegar objetos",
    summary: "Pega el portapapeles interno con desplazamiento acumulativo, cada objeto en su capa de origen.",
    params: { offsetX: num("Desplazamiento horizontal aplicado."), offsetY: num("Desplazamiento vertical aplicado.") },
    executable: false,
    reason: CLIPBOARD_REASON,
  },
  "object.pasteInPlace": {
    type: "object.pasteInPlace",
    group: "object",
    label: "Pegar en el lugar",
    summary: "Pega el portapapeles interno sin desplazamiento.",
    params: {},
    executable: false,
    reason: CLIPBOARD_REASON,
  },
  "object.pasteToLayer": {
    type: "object.pasteToLayer",
    group: "object",
    label: "Pegar en la capa activa",
    summary: "Pega el portapapeles interno reasignando los objetos a la capa activa (toman su color).",
    params: { layerId: id("Capa activa que recibe los objetos.") },
    executable: false,
    reason: CLIPBOARD_REASON,
  },
  "object.duplicate": {
    type: "object.duplicate",
    group: "object",
    label: "Duplicar objetos",
    summary: "Duplica los objetos con ids nuevos, desplazados; sin tocar el portapapeles.",
    params: { offsetX: num("Desplazamiento horizontal; por defecto el de pegado (5 mm, o 5 u sin escala física)."), offsetY: num("Desplazamiento vertical.") },
    executable: true,
    needsObjects: true,
    refine: bothOrNone("offsetX", "offsetY"),
  },
  "object.fill": {
    type: "object.fill",
    group: "object",
    label: "Rellenar objetos",
    summary: "Mueve la selección a la capa del color elegido (Fill); un color libre nuevo crea una capa en el mismo comando.",
    params: COLOR_TARGET,
    executable: true,
    needsObjects: true,
    refine: exactlyOneColor,
  },
  "object.recolor": {
    type: "object.recolor",
    group: "object",
    label: "Recolorear",
    summary: "Recolorea la selección, una capa o todo un color del documento (alcance explícito), sin fusionar capas.",
    params: {
      scope: oneOf("Alcance: selección, capa (cambia el color de la capa) o documento (capa origen elegida).", ["selection", "layer", "document"], required),
      sourceLayerId: id("Capa cuyo color cambia (alcances capa y documento)."),
      ...COLOR_TARGET,
    },
    executable: true,
    refine: (parameters) => [
      ...exactlyOneColor(parameters),
      ...(parameters.scope !== "selection" && !("sourceLayerId" in parameters) ? ["Los alcances «layer» y «document» exigen «sourceLayerId»."] : []),
    ],
  },
  "object.merge": {
    type: "object.merge",
    group: "object",
    label: "Fusionar capas",
    summary: "Recolorea una capa y la fusiona con otra de ese color: la capa origen queda vacía (no se elimina).",
    params: {
      scope: oneOf("Alcance: capa o documento.", ["layer", "document"], required),
      sourceLayerId: id("Capa origen, que queda vacía.", required),
      mergeIntoLayerId: id("Capa destino de la fusión (define el color).", required),
      targetLayerId: id("Capa cuyo color se usa; por defecto la de destino."),
      newColorHex: COLOR_TARGET.newColorHex,
    },
    executable: true,
    refine: (parameters) => ("targetLayerId" in parameters && "newColorHex" in parameters ? ["Indicá como máximo uno de «targetLayerId» o «newColorHex»."] : []),
  },
  "object.draw": {
    type: "object.draw",
    group: "object",
    label: "Dibujar",
    summary: "Crea una forma cerrada o una línea abierta con la pluma o la mano alzada (en la capa activa o una «Dibujo» nueva).",
    params: {
      closed: bool("Forma cerrada (relleno) o línea abierta (trazo)."),
      pointCount: int("Cantidad de puntos del trazo (los puntos no se guardan).", { min: 0 }),
      lineWidthMm: num("Ancho del trazo de una línea abierta, en la unidad del panel."),
      normalized: bool("El servidor corrigió un trazo auto-intersecado."),
      pieceCount: int("Objetos creados.", { min: 0 }),
    },
    executable: false,
    reason: GESTURE_REASON,
  },
  "object.erase.objects": {
    type: "object.erase.objects",
    group: "object",
    label: "Borrar objetos",
    summary: "Borra los objetos bajo el cursor (modo Objeto del borrador).",
    params: {},
    executable: true,
    needsObjects: true,
  },
  "object.erase.subtract": {
    type: "object.erase.subtract",
    group: "object",
    label: "Restar geometría",
    summary: "Resta geometría con el pincel del borrador (difference en el servidor); las piezas son objetos nuevos.",
    params: {
      radiusMm: num("Radio del pincel en la unidad del panel."),
      scope: oneOf("Alcance: capa activa o todas las desbloqueadas.", ["active-layer", "unlocked-layers"]),
      strokePointCount: int("Puntos del trazo del pincel (no se guardan).", { min: 0 }),
      pieceCount: int("Piezas resultantes.", { min: 0 }),
    },
    executable: false,
    reason: `${GESTURE_REASON} Además usa el servicio de geometría del servidor.`,
  },
  "path.moveAnchors": {
    type: "path.moveAnchors",
    group: "path",
    label: "Mover nodos",
    summary: "Mueve nodos (con sus handles) de un path: arrastre o flechas (fundidas en una ráfaga).",
    params: { nodeCount: NODE_COUNT, dx: num("Desplazamiento X en el espacio local del objeto."), dy: num("Desplazamiento Y en el espacio local del objeto."), source: oneOf("Origen del movimiento.", ["drag", "keyboard"]) },
    executable: false,
    reason: NODES_REASON,
  },
  "path.moveHandle": {
    type: "path.moveHandle",
    group: "path",
    label: "Editar handle",
    summary: "Mueve un handle de Bézier (arrastre) o fija su largo/ángulo (Inspector).",
    params: { side: oneOf("Lado del handle.", ["in", "out"]), source: oneOf("Origen del cambio.", ["drag", "inspector"]), field: oneOf("Campo editado en el Inspector.", ["length", "angle"]), value: num("Valor del campo editado.") },
    executable: false,
    reason: NODES_REASON,
  },
  "path.addNode": {
    type: "path.addNode",
    group: "path",
    label: "Agregar nodo",
    summary: "Agrega un nodo sobre un segmento (De Casteljau exacto: la forma no cambia).",
    params: { subpath: int("Índice del subpath.", { min: 0 }), segment: int("Índice del segmento.", { min: 0 }), t: num("Posición paramétrica en el segmento (0..1).", { min: 0, max: 1 }) },
    executable: false,
    reason: NODES_REASON,
  },
  "path.deleteNodes": {
    type: "path.deleteNodes",
    group: "path",
    label: "Eliminar nodos",
    summary: "Elimina nodos (eliminación mínima) o el subpath entero.",
    params: { nodeCount: NODE_COUNT, removeSubpaths: bool("Eliminó subpaths enteros (tras la confirmación).") },
    executable: false,
    reason: NODES_REASON,
  },
  "path.setNodeKind": {
    type: "path.setNodeKind",
    group: "path",
    label: "Cambiar tipo de nodo",
    summary: "Cambia el tipo de nodo (esquina, suave, simétrico).",
    params: { kind: oneOf("Tipo de nodo resultante.", ["corner", "smooth", "symmetric"]), nodeCount: NODE_COUNT },
    executable: false,
    reason: NODES_REASON,
  },
  "path.toggleSegment": {
    type: "path.toggleSegment",
    group: "path",
    label: "Alternar segmento recto/curvo",
    summary: "Convierte segmentos rectos en curvos y viceversa.",
    params: { scope: oneOf("Qué segmentos.", ["before", "after", "selected"]) },
    executable: false,
    reason: NODES_REASON,
  },
  "path.closeSubpath": {
    type: "path.closeSubpath",
    group: "path",
    label: "Cerrar subpath",
    summary: "Cierra un subpath abierto.",
    params: { subpath: int("Índice del subpath.", { min: 0 }) },
    executable: false,
    reason: NODES_REASON,
  },
  "path.openSubpath": {
    type: "path.openSubpath",
    group: "path",
    label: "Abrir subpath",
    summary: "Abre un subpath cerrado en el nodo seleccionado.",
    params: { subpath: int("Índice del subpath.", { min: 0 }), node: int("Índice del nodo.", { min: 0 }) },
    executable: false,
    reason: NODES_REASON,
  },
  "path.setNodeCoords": {
    type: "path.setNodeCoords",
    group: "path",
    label: "Fijar coordenada de nodo",
    summary: "Fija una coordenada (X o Y) de los nodos seleccionados desde el Inspector.",
    params: { axis: oneOf("Eje editado.", ["x", "y"]), value: num("Valor en la unidad del panel."), nodeCount: NODE_COUNT },
    executable: false,
    reason: NODES_REASON,
  },
  "document.crop": {
    type: "document.crop",
    group: "document",
    label: "Recortar el área de trabajo",
    summary: "Recorta el marco (área de trabajo) y, opcionalmente, elimina los objetos totalmente fuera.",
    params: {
      x: num("Origen X del nuevo marco.", required),
      y: num("Origen Y del nuevo marco.", required),
      width: num("Ancho del nuevo marco (> 0).", { ...required, min: 1e-6 }),
      height: num("Alto del nuevo marco (> 0).", { ...required, min: 1e-6 }),
      removeOutside: bool("Eliminar los objetos totalmente fuera del marco (por defecto sí)."),
    },
    executable: true,
  },
  "document.rotate": {
    type: "document.rotate",
    group: "document",
    label: "Rotar el documento",
    summary: "Gira TODO el documento (también las capas ocultas) alrededor del centro del marco; rechaza si hay capas bloqueadas.",
    params: { quarterTurns: int("Cuartos de vuelta horarios (1..3).", { ...required, min: 1, max: 3 }) },
    executable: true,
  },
  "document.flip": {
    type: "document.flip",
    group: "document",
    label: "Reflejar el documento",
    summary: "Refleja TODO el documento y después lo gira `quarterTurns` cuartos de vuelta horarios.",
    params: { axis: oneOf("Eje del reflejo.", ["horizontal", "vertical"], required), quarterTurns: int("Cuartos de vuelta horarios posteriores (0..3).", { min: 0, max: 3 }) },
    executable: true,
  },
  "selection.rotate": {
    type: "selection.rotate",
    group: "selection",
    label: "Rotar la selección",
    summary: "Gira la selección en múltiplos de 90° alrededor del centro de su caja (identidad exacta).",
    params: { quarterTurns: int("Cuartos de vuelta horarios (1..3).", { ...required, min: 1, max: 3 }) },
    executable: true,
    needsObjects: true,
  },
  "selection.flip": {
    type: "selection.flip",
    group: "selection",
    label: "Reflejar la selección",
    summary: "Refleja la selección y después la gira `quarterTurns` cuartos de vuelta horarios.",
    params: { axis: oneOf("Eje del reflejo.", ["horizontal", "vertical"], required), quarterTurns: int("Cuartos de vuelta horarios posteriores (0..3).", { min: 0, max: 3 }) },
    executable: true,
    needsObjects: true,
  },
  "arrange.align": {
    type: "arrange.align",
    group: "arrange",
    label: "Alinear objetos",
    summary: "Alinea los objetos movibles (traslaciones) con la selección o con el marco del documento.",
    params: {
      mode: oneOf("Borde o centro de alineación.", ["left", "center", "right", "top", "middle", "bottom"], required),
      reference: oneOf("Referencia: la propia selección (≥ 2 objetos) o el marco del documento.", ["selection", "document"], required),
    },
    executable: true,
    needsObjects: true,
  },
  "arrange.distribute": {
    type: "arrange.distribute",
    group: "arrange",
    label: "Distribuir objetos",
    summary: "Reparte huecos iguales entre ≥ 3 objetos, con los extremos fijos.",
    params: { axis: oneOf("Eje de distribución.", ["horizontal", "vertical"], required) },
    executable: true,
    needsObjects: true,
  },
  "arrange.zorder": {
    type: "arrange.zorder",
    group: "arrange",
    label: "Cambiar el orden de pintado",
    summary: "Reordena los objetos dentro de su capa (nunca los cambia de capa).",
    params: { action: oneOf("Movimiento en el orden de pintado.", ["forward", "backward", "front", "back"], required) },
    executable: true,
    needsObjects: true,
  },
  "geometry.boolean": {
    type: "geometry.boolean",
    group: "geometry",
    label: "Operación booleana",
    summary: "Unión, diferencia, intersección o XOR n-aria de formas rellenas (servidor); un comando atómico.",
    params: {
      operation: oneOf("Operación.", ["union", "difference", "intersection", "xor"]),
      operandCount: int("Cantidad de operandos.", { min: 0 }),
      keepOriginals: bool("Se conservaron los originales."),
      resultCount: int("Objetos resultantes.", { min: 0 }),
      toleranceMm: num("Tolerancia en la unidad del panel."),
      ...COLOR_TARGET,
    },
    executable: false,
    reason: SERVER_REASON,
  },
  "geometry.offset": {
    type: "geometry.offset",
    group: "geometry",
    label: "Offset",
    summary: "Desplaza el contorno hacia afuera o adentro (servidor); un comando atómico.",
    params: {
      direction: oneOf("Dirección.", ["outside", "inside"]),
      distance: num("Distancia en la unidad `unit`."),
      unit: oneOf("Unidad de la distancia.", ["mm", "u"]),
      joinStyle: oneOf("Unión de esquinas.", ["round", "mitre", "bevel"]),
      capStyle: oneOf("Extremos de una línea abierta.", ["round", "flat", "square"]),
      mitreLimit: num("Límite del inglete."),
      keepOriginals: bool("Se conservaron los originales."),
      resultCount: int("Objetos resultantes.", { min: 0 }),
      toleranceMm: num("Tolerancia en la unidad del panel."),
      ...COLOR_TARGET,
    },
    executable: false,
    reason: SERVER_REASON,
  },
  "geometry.split": {
    type: "geometry.split",
    group: "geometry",
    label: "Cortar con una línea",
    summary: "Divide (o separa con ranura) los objetos con una línea de corte (servidor); un comando atómico.",
    params: {
      mode: oneOf("Modo.", ["split", "slot"]),
      slotWidth: num("Ancho de la ranura en la unidad `unit` (solo modo slot)."),
      unit: oneOf("Unidad del ancho.", ["mm", "u"]),
      extend: bool("El corte se prolongó para cruzar todo."),
      cutPointCount: int("Puntos de la línea de corte (no se guardan).", { min: 0 }),
      pieceCount: int("Piezas resultantes.", { min: 0 }),
    },
    executable: false,
    reason: `${SERVER_REASON} Además la línea de corte son puntos crudos.`,
  },
  "geometry.bridge": {
    type: "geometry.bridge",
    group: "geometry",
    label: "Aplicar bridges",
    summary: "Conecta piezas flotantes con bridges rectangulares (servidor); un comando atómico.",
    params: {
      mode: oneOf("Definición de pieza flotante.", ["stencil", "parts"]),
      bridgeCount: int("Bridges aplicados.", { min: 0 }),
      widthMm: num("Ancho de los bridges en la unidad `unit`."),
      unit: oneOf("Unidad del ancho.", ["mm", "u"]),
      floatingBefore: int("Piezas flotantes antes.", { min: 0 }),
      floatingAfter: int("Piezas flotantes después.", { min: 0 }),
    },
    executable: false,
    reason: SERVER_REASON,
  },
  "layer.create": {
    type: "layer.create",
    group: "layer",
    label: "Crear capa",
    summary: "Crea una capa vacía con un color (capa nueva `isNew`, todavía sin guardar). Fill, Draw, booleanas y offset la crean implícitamente dentro de su propio comando.",
    params: { colorHex: hex("Color de la capa (#RGB o #RRGGBB).", required), name: text("Nombre de la capa; por defecto «Color #RRGGBB».") },
    executable: true,
    implicit: true,
  },
  "layer.rename": {
    type: "layer.rename",
    group: "layer",
    label: "Renombrar capa",
    summary: "Cambia el nombre de una capa (nunca su groupId); deshacer/rehacer re-persisten el nombre con el mismo PATCH.",
    params: { from: text("Nombre anterior."), to: text("Nombre nuevo.") },
    executable: false,
    reason: PATCH_REASON,
  },
  "layer.setVisible": {
    type: "layer.setVisible",
    group: "layer",
    label: "Mostrar u ocultar capa",
    summary: "Muestra u oculta una capa (ojo del panel de capas). Isolate no es un comando.",
    params: { visible: bool("Visibilidad resultante.") },
    executable: false,
    reason: PATCH_REASON,
  },
  "layer.setLocked": {
    type: "layer.setLocked",
    group: "layer",
    label: "Bloquear o desbloquear capa",
    summary: "Bloquea o desbloquea una capa para edición.",
    params: { locked: bool("Bloqueo resultante.") },
    executable: false,
    reason: PATCH_REASON,
  },
  "layer.setOperation": {
    type: "layer.setOperation",
    group: "layer",
    label: "Cambiar la operación de fabricación",
    summary: "Asigna Corte / Grabado / Ignorar a una capa.",
    params: {
      operation: oneOf("Operación resultante.", ["cut", "engrave", "ignore", "unassigned"]),
      previous: oneOf("Operación anterior.", ["cut", "engrave", "ignore", "unassigned"]),
    },
    executable: false,
    reason: PATCH_REASON,
  },
  "layer.reorder": {
    type: "layer.reorder",
    group: "layer",
    label: "Reordenar capas",
    summary: "Cambia el orden de las capas en el panel (arrastrar y soltar).",
    params: { order: ids("Ids de TODAS las capas en el orden resultante.") },
    executable: false,
    reason: PATCH_REASON,
  },
};

// ---- Validación ----

const RAW_GEOMETRY_KEYS = new Set(["d", "svg", "path", "paths", "pathdata", "pathd", "points", "coordinates", "polygon", "polygons", "polyline", "ring", "rings", "geometry", "matrix", "transform"]);
// «M x y» al principio es path data inconfundible; un nombre de capa como «A1» o «L2» no lo es.
const PATH_DATA_PATTERN = /^\s*[Mm]\s*-?\d*\.?\d+[\s,]+-?\d*\.?\d+/;

/** Ruta del primer valor que parezca geometría/SVG crudos (clave `d`/`svg`/`points`..., marcado `<svg>`/`<path>`, path data o texto largo), o `null`. */
export function findRawGeometry(value: unknown, path = "parameters", depth = 0): string | null {
  if (depth > 8) return path;
  if (typeof value === "string") {
    if (value.length > 1000 || /<\s*(svg|path|g)\b/i.test(value) || PATH_DATA_PATTERN.test(value)) return path;
    return null;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findRawGeometry(value[index], `${path}[${index}]`, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (RAW_GEOMETRY_KEYS.has(key.toLowerCase())) return `${path}.${key}`;
      const found = findRawGeometry(item, `${path}.${key}`, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function checkParam(name: string, spec: ParamSpec, value: unknown, ranges: boolean): string | null {
  switch (spec.kind) {
    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value)) return `«${name}» debe ser un número finito.`;
      if (spec.kind === "integer" && !Number.isInteger(value)) return `«${name}» debe ser un entero.`;
      if (!ranges) return null;
      if (spec.nonZero && Math.abs(value) < 1e-3) return `«${name}» no puede ser (casi) 0.`;
      if (spec.min !== undefined && value < spec.min) return `«${name}» debe ser ≥ ${spec.min}.`;
      if (spec.max !== undefined && value > spec.max) return `«${name}» debe ser ≤ ${spec.max}.`;
      return null;
    }
    case "boolean":
      return typeof value === "boolean" ? null : `«${name}» debe ser verdadero o falso.`;
    case "string":
      return typeof value === "string" && value.length <= MAX_TEXT_LENGTH ? null : `«${name}» debe ser un texto de hasta ${MAX_TEXT_LENGTH} caracteres.`;
    case "enum":
      return typeof value === "string" && (spec.options ?? []).includes(value) ? null : `«${name}» debe ser uno de: ${(spec.options ?? []).join(", ")}.`;
    case "id":
      return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH ? null : `«${name}» debe ser un id no vacío.`;
    case "hex":
      return typeof value === "string" && HEX_PATTERN.test(value) ? null : `«${name}» debe ser un color hex válido (#RGB o #RRGGBB).`;
    case "ids":
      return Array.isArray(value) && value.length <= 500 && value.every((item) => typeof item === "string" && item.length > 0 && item.length <= MAX_ID_LENGTH) ? null : `«${name}» debe ser una lista de ids.`;
  }
}

export interface ParameterValidationOptions {
  /** Acepta los parámetros que agrega el historial (`objectCount`, `createdLayerIds`): true al validar un comando YA registrado, false al validar una ENTRADA. */
  allowReserved?: boolean;
  /** Exige los parámetros marcados `required` (al ejecutar una entrada). Un comando que emite la UI puede omitir los que no tiene sentido registrar. */
  requireAll?: boolean;
  /**
   * Valida también los rangos (`min`/`max`/`nonZero`) y las reglas cruzadas (`refine`): true para una ENTRADA del ejecutor; false (default) para lo que EMITE la UI,
   * que DESCRIBE un gesto (un factor de escala casi 0 arrastrado con el mouse es un gesto válido) y nunca debe romper la edición del usuario.
   */
  ranges?: boolean;
}

/** Valida `parameters` contra el esquema del tipo (claves desconocidas, tipos, rangos, obligatorios, reglas cruzadas) y que no lleven geometría cruda. Devuelve los errores en español. */
export function validateParameters(type: CommandType, parameters: Record<string, unknown>, options: ParameterValidationOptions = {}): string[] {
  const spec = COMMAND_REGISTRY[type];
  const errors: string[] = [];
  const raw = findRawGeometry(parameters);
  if (raw) errors.push(`«${raw}» parece geometría o SVG crudos: los comandos solo llevan ids, números, enums y textos cortos.`);
  for (const [name, value] of Object.entries(parameters)) {
    if (value === undefined) continue;
    if ((RESERVED_PARAMETERS as readonly string[]).includes(name)) {
      if (!options.allowReserved) errors.push(`«${name}» lo calcula el historial: no es un parámetro de entrada.`);
      continue;
    }
    const param = spec.params[name];
    if (!param) {
      errors.push(`«${name}» no es un parámetro de «${type}».`);
      continue;
    }
    const problem = checkParam(name, param, value, options.ranges === true);
    if (problem) errors.push(problem);
  }
  if (options.requireAll) {
    for (const [name, param] of Object.entries(spec.params)) {
      if (param.required && parameters[name] === undefined) errors.push(`Falta el parámetro obligatorio «${name}».`);
    }
  }
  if (errors.length === 0 && options.ranges === true && spec.refine) {
    errors.push(...spec.refine(Object.fromEntries(Object.entries(parameters).filter(([, value]) => value !== undefined)) as Record<string, JsonValue>));
  }
  return errors;
}

// ---- Derivación de objetivos desde el parche ----

/** Ids de los objetos que difieren entre dos versiones de una capa: agregados, quitados, modificados (por contenido) y, si solo cambió el orden, los que cambiaron de posición. */
export function changedObjectIds(before: readonly EditorObject[], after: readonly EditorObject[]): string[] {
  const previous = new Map(before.map((object) => [object.id, object]));
  const changed: string[] = [];
  for (const object of after) {
    const old = previous.get(object.id);
    if (!old || (old !== object && !sameObjectContent(old, object))) changed.push(object.id);
    previous.delete(object.id);
  }
  for (const id of previous.keys()) changed.push(id);
  if (changed.length === 0 && before.length === after.length) {
    after.forEach((object, index) => {
      if (before[index].id !== object.id) changed.push(object.id);
    });
  }
  return changed;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** Capas y objetos que REALMENTE cambió un parche (la verdad de lo afectado, sin depender de lo que el call-site pidió). */
export function deriveTargets(edit: EditorEdit): { layerIds: string[]; objectIds: string[] } {
  const layerIds: string[] = Object.keys(edit.touched);
  const objectIds: string[] = [];
  for (const change of Object.values(edit.touched)) objectIds.push(...changedObjectIds(change.before, change.after));
  if (edit.layers) layerIds.push(...edit.layers.before.map((layer) => layer.groupId), ...edit.layers.after.map((layer) => layer.groupId));
  if (edit.meta) layerIds.push(...metaLayerIds(edit.meta));
  return { layerIds: unique(layerIds), objectIds: unique(objectIds) };
}

function metaLayerIds(change: LayerMetaChange): string[] {
  return change.kind === "order" ? [...change.after] : [change.groupId];
}

/** Ids de las capas que el parche CREA (están en `after` y no en `before` de la estructura). */
export function createdLayerIds(edit: EditorEdit): string[] {
  if (!edit.layers) return [];
  const before = new Set(edit.layers.before.map((layer) => layer.groupId));
  return edit.layers.after.filter((layer) => !before.has(layer.groupId)).map((layer) => layer.groupId);
}

// ---- Construcción ----

export interface CommandMeta {
  id: string;
  sequence: number;
  timestamp: number;
}

export class InvalidCommandError extends Error {
  readonly problems: string[];
  constructor(type: string, problems: string[]) {
    super(`Comando «${type}» inválido: ${problems.join(" ")}`);
    this.name = "InvalidCommandError";
    this.problems = problems;
  }
}

function cleanParameters(parameters: Record<string, JsonValue | undefined> | undefined): Record<string, JsonValue> {
  const clean: Record<string, JsonValue> = {};
  for (const [name, value] of Object.entries(parameters ?? {})) if (value !== undefined) clean[name] = value;
  return clean;
}

/**
 * Valida el borrador de un call-site ANTES de tocar el documento: tipo conocido (un tipo desconocido es un error de programación y lanza), parámetros
 * del esquema y sin geometría cruda. En desarrollo y tests un problema lanza `InvalidCommandError`; en producción se descartan los parámetros
 * inválidos (el comando se registra igual: perder la edición del usuario por un parámetro descriptivo sería peor).
 */
export function checkDraft(draft: CommandDraft): CommandDraft {
  if (!draft || !isCommandType(draft.type)) throw new InvalidCommandError(String((draft as { type?: unknown } | undefined)?.type), ["tipo de comando desconocido"]);
  const parameters = cleanParameters(draft.parameters);
  if (!isJsonValue(parameters)) throw new InvalidCommandError(draft.type, ["los parámetros no son JSON puro"]);
  const problems = validateParameters(draft.type, parameters);
  if (problems.length === 0) return draft;
  if (!import.meta.env.PROD) throw new InvalidCommandError(draft.type, problems);
  return { ...draft, parameters: {} };
}

/** Arma el `EditorCommand` v1 de un borrador ya validado y del parche que produjo: `targets` y conteos salen de lo que realmente cambió. */
export function buildCommand(draft: CommandDraft, edit: EditorEdit, meta: CommandMeta): EditorCommand {
  const derived = deriveTargets(edit);
  const layerIds = draft.targets?.layerIds && draft.targets.layerIds.length > 0 ? unique(draft.targets.layerIds) : derived.layerIds;
  const requestedObjects = draft.targets?.objectIds && draft.targets.objectIds.length > 0 ? unique(draft.targets.objectIds) : derived.objectIds;
  const parameters = cleanParameters(draft.parameters);
  if (derived.objectIds.length > 0) parameters.objectCount = derived.objectIds.length;
  const created = createdLayerIds(edit);
  if (created.length > 0) parameters.createdLayerIds = created;
  return {
    version: COMMAND_VERSION,
    id: meta.id,
    sequence: meta.sequence,
    type: draft.type,
    label: draft.label?.trim() || COMMAND_REGISTRY[draft.type].label,
    targets: { layerIds, objectIds: requestedObjects.slice(0, MAX_TARGET_IDS) },
    parameters,
    origin: draft.origin ?? "user",
    timestamp: meta.timestamp,
  };
}

/**
 * Funde dos comandos consecutivos del mismo tipo (ráfaga de flechas): conserva `id`/`sequence` del primero, la `label` y el `timestamp` del último y
 * ACUMULA `dx`/`dy`. El resto de los parámetros son los del último.
 */
export function mergeCoalesced(previous: EditorCommand, next: EditorCommand): EditorCommand {
  const parameters: Record<string, JsonValue> = { ...next.parameters };
  for (const axis of ["dx", "dy"] as const) {
    const before = previous.parameters[axis];
    const after = next.parameters[axis];
    if (typeof before === "number" && typeof after === "number") parameters[axis] = before + after;
  }
  return {
    ...next,
    id: previous.id,
    sequence: previous.sequence,
    parameters,
    targets: { layerIds: unique([...previous.targets.layerIds, ...next.targets.layerIds]), objectIds: unique([...previous.targets.objectIds, ...next.targets.objectIds]).slice(0, MAX_TARGET_IDS) },
  };
}

// ---- Metadata de capa -> comando ----

/** Los nombres de capa son texto del usuario: se acotan al largo máximo de un parámetro de texto (la etiqueta sí los lleva enteros). */
function clip(textValue: string): string {
  return textValue.length > MAX_TEXT_LENGTH ? `${textValue.slice(0, MAX_TEXT_LENGTH - 1)}…` : textValue;
}

const OPERATION_NAME: Record<string, string> = { cut: "Corte", engrave: "Grabado", ignore: "Ignorar", unassigned: "Sin asignar" };

/** Borrador del comando de un cambio de metadata de capa (el parche es el propio `LayerMetaChange`). */
export function layerMetaDraft(change: LayerMetaChange, origin: CommandOrigin = "user"): CommandDraft {
  switch (change.kind) {
    case "rename":
      return { type: "layer.rename", label: `Renombrar la capa «${change.before}» a «${change.after}»`, targets: { layerIds: [change.groupId] }, parameters: { from: clip(change.before), to: clip(change.after) }, origin };
    case "visible":
      return { type: "layer.setVisible", label: `${change.after ? "Mostrar" : "Ocultar"} la capa «${change.layerName}»`, targets: { layerIds: [change.groupId] }, parameters: { visible: change.after }, origin };
    case "locked":
      return { type: "layer.setLocked", label: `${change.after ? "Bloquear" : "Desbloquear"} la capa «${change.layerName}»`, targets: { layerIds: [change.groupId] }, parameters: { locked: change.after }, origin };
    case "operation":
      return {
        type: "layer.setOperation",
        label: `Asignar «${OPERATION_NAME[change.after] ?? change.after}» a la capa «${change.layerName}»`,
        targets: { layerIds: [change.groupId] },
        parameters: { operation: change.after, previous: change.before },
        origin,
      };
    case "order":
      return { type: "layer.reorder", label: "Reordenar las capas", targets: { layerIds: [...change.after] }, parameters: { order: [...change.after] }, origin };
  }
}

// ---- (De)serialización y exportación ----

/** Errores de forma de un valor que dice ser un `EditorCommand` v1 (vacío = válido). */
export function validateCommandShape(value: unknown): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return ["El comando debe ser un objeto."];
  const command = value as Record<string, unknown>;
  const errors: string[] = [];
  if (command.version !== COMMAND_VERSION) errors.push(`«version» debe ser ${COMMAND_VERSION}.`);
  if (typeof command.id !== "string" || command.id.length === 0) errors.push("«id» debe ser un texto no vacío.");
  if (!Number.isInteger(command.sequence) || (command.sequence as number) < 0) errors.push("«sequence» debe ser un entero ≥ 0.");
  if (!isCommandType(command.type)) errors.push("«type» no es un tipo conocido.");
  if (typeof command.label !== "string") errors.push("«label» debe ser un texto.");
  if (!COMMAND_ORIGINS.includes(command.origin as CommandOrigin)) errors.push("«origin» debe ser user, ai o system.");
  if (typeof command.timestamp !== "number" || !Number.isFinite(command.timestamp)) errors.push("«timestamp» debe ser un número.");
  const targets = command.targets as Record<string, unknown> | null | undefined;
  if (targets === null || typeof targets !== "object" || !Array.isArray(targets.layerIds) || !Array.isArray(targets.objectIds)) {
    errors.push("«targets» debe tener «layerIds» y «objectIds».");
  } else if (![...targets.layerIds, ...targets.objectIds].every((item) => typeof item === "string")) {
    errors.push("«targets» solo puede contener ids de texto.");
  }
  if (command.parameters === null || typeof command.parameters !== "object" || Array.isArray(command.parameters)) errors.push("«parameters» debe ser un objeto.");
  else if (!isJsonValue(command.parameters)) errors.push("«parameters» no es JSON puro.");
  else if (isCommandType(command.type)) errors.push(...validateParameters(command.type, command.parameters as Record<string, unknown>, { allowReserved: true }));
  return errors;
}

export type ParseCommandResult = { ok: true; command: EditorCommand } | { ok: false; errors: string[] };

/** Lee un comando desde JSON (texto u objeto ya parseado) validando su forma y sus parámetros. */
export function parseCommand(input: unknown): ParseCommandResult {
  let value = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch {
      return { ok: false, errors: ["El texto no es JSON válido."] };
    }
  }
  const errors = validateCommandShape(value);
  return errors.length > 0 ? { ok: false, errors } : { ok: true, command: value as EditorCommand };
}

export function serializeCommand(command: EditorCommand): string {
  return JSON.stringify(command);
}

/** Exportación del historial (M3-S12): SOLO los comandos, en orden cronológico, sin parches ni SVG. `position` = cuántos están aplicados (el resto es la rama de rehacer). */
export interface HistoryExport {
  version: typeof COMMAND_VERSION;
  position: number;
  commands: EditorCommand[];
}

export function exportCommands(commands: readonly EditorCommand[], position: number): HistoryExport {
  return { version: COMMAND_VERSION, position, commands: commands.map((command) => ({ ...command, targets: { layerIds: [...command.targets.layerIds], objectIds: [...command.targets.objectIds] }, parameters: { ...command.parameters } })) };
}

export function parseHistoryExport(input: unknown): { ok: true; history: HistoryExport } | { ok: false; errors: string[] } {
  let value = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch {
      return { ok: false, errors: ["El texto no es JSON válido."] };
    }
  }
  const history = value as Partial<HistoryExport> | null;
  if (history === null || typeof history !== "object" || history.version !== COMMAND_VERSION || !Array.isArray(history.commands) || !Number.isInteger(history.position)) {
    return { ok: false, errors: ["La exportación del historial debe tener «version» 1, «position» y «commands»."] };
  }
  const errors = history.commands.flatMap((command, index) => validateCommandShape(command).map((error) => `commands[${index}]: ${error}`));
  if (errors.length > 0) return { ok: false, errors };
  if ((history.position as number) < 0 || (history.position as number) > history.commands.length) return { ok: false, errors: ["«position» está fuera de rango."] };
  return { ok: true, history: history as HistoryExport };
}
