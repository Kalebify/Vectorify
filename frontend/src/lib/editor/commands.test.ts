import { describe, expect, it } from "vitest";
import { IDENTITY_MATRIX } from "../svgTransform";
import {
  buildCommand,
  changedObjectIds,
  checkDraft,
  COMMAND_REGISTRY,
  COMMAND_TYPES,
  COMMAND_VERSION,
  createdLayerIds,
  deriveTargets,
  exportCommands,
  findRawGeometry,
  InvalidCommandError,
  isCommandType,
  isJsonValue,
  layerMetaDraft,
  MAX_TARGET_IDS,
  mergeCoalesced,
  parseCommand,
  parseHistoryExport,
  serializeCommand,
  validateCommandShape,
  validateParameters,
  type CommandType,
  type EditorCommand,
} from "./commands";
import type { EditableLayerMeta, EditorEdit, EditorObject, LayerMetaChange } from "./types";

/**
 * `EditorCommand` v1 y su registro (M3-S12): forma versionada, tipos con parámetros documentados, JSON ida y vuelta, exportación sin parches ni SVG,
 * validación de parámetros (nunca geometría cruda) y derivación de objetivos desde el parche.
 */

const object = (id: string, layerGroupId = "A", e = 0): EditorObject => ({ id, layerGroupId, d: "M0 0 H10 V10 H0 Z", fill: "#ff0000", matrix: { ...IDENTITY_MATRIX, e } });
const meta = (groupId: string, overrides: Partial<EditableLayerMeta> = {}): EditableLayerMeta => ({
  groupId,
  name: groupId,
  colorHex: "#ff0000",
  order: 0,
  visible: true,
  locked: false,
  manufacturingOperation: "unassigned",
  isNew: false,
  ...overrides,
});

const edit = (touched: EditorEdit["touched"], extra: Partial<EditorEdit> = {}): EditorEdit => ({ label: "x", touched, ...extra });
const META = { id: "c-1", sequence: 7, timestamp: 1234 };

describe("COMMAND_TYPES y COMMAND_REGISTRY", () => {
  it("el registro es CERRADO y 1:1 con los tipos: ninguno sobra ni falta, sin duplicados", () => {
    expect(new Set(COMMAND_TYPES).size).toBe(COMMAND_TYPES.length);
    expect(Object.keys(COMMAND_REGISTRY).sort()).toEqual([...COMMAND_TYPES].sort());
    for (const type of COMMAND_TYPES) expect(COMMAND_REGISTRY[type].type).toBe(type);
  });

  it("cubre todas las operaciones mutantes de MVP 3 que pide la tarjeta", () => {
    const expected: CommandType[] = [
      ...["move", "scale", "rotate", "nudge", "setBounds", "delete"].map((name) => `object.${name}` as CommandType),
      ...["cut", "paste", "pasteInPlace", "pasteToLayer", "duplicate"].map((name) => `object.${name}` as CommandType),
      "object.fill",
      "object.recolor",
      "object.merge",
      "object.draw",
      "object.erase.objects",
      "object.erase.subtract",
      ...["moveAnchors", "moveHandle", "addNode", "deleteNodes", "setNodeKind", "toggleSegment", "closeSubpath", "openSubpath", "setNodeCoords"].map((name) => `path.${name}` as CommandType),
      "document.crop",
      "document.rotate",
      "document.flip",
      "selection.rotate",
      "selection.flip",
      "arrange.align",
      "arrange.distribute",
      "arrange.zorder",
      ...["boolean", "offset", "split", "bridge"].map((name) => `geometry.${name}` as CommandType),
      "layer.create",
      ...["rename", "setVisible", "setLocked", "setOperation", "reorder"].map((name) => `layer.${name}` as CommandType),
    ];
    expect([...COMMAND_TYPES].sort()).toEqual([...expected].sort());
  });

  it("cada tipo documenta su etiqueta (español), un resumen y TODOS sus parámetros (descripción y tipo); los no ejecutables explican por qué", () => {
    for (const type of COMMAND_TYPES) {
      const spec = COMMAND_REGISTRY[type];
      expect(spec.label.length, type).toBeGreaterThan(3);
      expect(spec.summary.length, type).toBeGreaterThan(10);
      for (const [name, param] of Object.entries(spec.params)) {
        expect(param.description.length, `${type}.${name}`).toBeGreaterThan(3);
        if (param.kind === "enum") expect(param.options?.length, `${type}.${name}`).toBeGreaterThan(0);
      }
      if (spec.executable) expect(spec.reason, type).toBeUndefined();
      else expect(spec.reason?.length, type).toBeGreaterThan(10);
    }
  });

  it("los tipos que necesitan servidor, gesto, portapapeles o PATCH NO son ejecutables; los deterministas sin servidor sí", () => {
    const executable = COMMAND_TYPES.filter((type) => COMMAND_REGISTRY[type].executable).sort();
    expect(executable).toEqual(
      [
        "object.move", "object.scale", "object.rotate", "object.nudge", "object.setBounds", "object.delete", "object.duplicate", "object.fill", "object.recolor", "object.merge",
        "object.erase.objects", "document.crop", "document.rotate", "document.flip", "selection.rotate", "selection.flip", "arrange.align", "arrange.distribute", "arrange.zorder", "layer.create",
      ].sort(),
    );
    for (const type of ["geometry.boolean", "geometry.offset", "geometry.split", "geometry.bridge"] as const) expect(COMMAND_REGISTRY[type].reason).toMatch(/servidor/);
    for (const type of ["object.draw", "object.erase.subtract"] as const) expect(COMMAND_REGISTRY[type].reason).toMatch(/gesto/);
    for (const type of COMMAND_TYPES.filter((candidate) => candidate.startsWith("path."))) expect(COMMAND_REGISTRY[type].executable).toBe(false);
    for (const type of ["object.cut", "object.paste", "object.pasteInPlace", "object.pasteToLayer"] as const) expect(COMMAND_REGISTRY[type].reason).toMatch(/portapapeles/);
    for (const type of ["layer.rename", "layer.setVisible", "layer.setLocked", "layer.setOperation", "layer.reorder"] as const) expect(COMMAND_REGISTRY[type].reason).toMatch(/PATCH/);
  });

  it("isCommandType acepta los del registro y nada más", () => {
    expect(isCommandType("object.move")).toBe(true);
    expect(isCommandType("object.teleport")).toBe(false);
    expect(isCommandType(undefined)).toBe(false);
    expect(isCommandType(3)).toBe(false);
  });
});

describe("buildCommand — la forma versionada", () => {
  it("arma un EditorCommand v1 con id/sequence/timestamp del llamador, origin 'user' por defecto, label del registro y targets derivados", () => {
    const before = [object("a1"), object("a2")];
    const after = [object("a1", "A", 5), object("a2")];
    const command = buildCommand({ type: "object.move", parameters: { dx: 5, dy: 0 } }, edit({ A: { before, after } }), META);
    expect(command).toEqual({
      version: COMMAND_VERSION,
      id: "c-1",
      sequence: 7,
      type: "object.move",
      label: COMMAND_REGISTRY["object.move"].label,
      targets: { layerIds: ["A"], objectIds: ["a1"] },
      parameters: { dx: 5, dy: 0, objectCount: 1 },
      origin: "user",
      timestamp: 1234,
    });
    expect(Object.keys(command).sort()).toEqual(["id", "label", "origin", "parameters", "sequence", "targets", "timestamp", "type", "version"]);
  });

  it("respeta label y origin del borrador; ignora parámetros undefined", () => {
    const command = buildCommand({ type: "object.move", label: " Mover 1 objeto ", origin: "ai", parameters: { dx: 1, dy: undefined } }, edit({ A: { before: [object("a1")], after: [object("a1", "A", 1)] } }), META);
    expect(command.label).toBe("Mover 1 objeto");
    expect(command.origin).toBe("ai");
    expect(command.parameters).toEqual({ dx: 1, objectCount: 1 });
  });

  it("serialización JSON ida y vuelta: idéntica, y el lector estricto la acepta", () => {
    const command = buildCommand({ type: "object.fill", parameters: { newColorHex: "#00ff00" } }, edit({ A: { before: [object("a1")], after: [] } }, { layers: { before: [], after: [meta("N", { isNew: true })] } }), META);
    const text = serializeCommand(command);
    expect(JSON.parse(text)).toEqual(command);
    expect(parseCommand(text)).toEqual({ ok: true, command });
    expect(parseCommand(JSON.parse(text))).toEqual({ ok: true, command });
  });

  it("una capa creada por el parche se declara en parameters.createdLayerIds y en targets.layerIds", () => {
    const patch = edit({ A: { before: [object("a1")], after: [] }, N: { before: [], after: [object("a1", "N")] } }, { layers: { before: [], after: [meta("N", { isNew: true })] } });
    expect(createdLayerIds(patch)).toEqual(["N"]);
    const command = buildCommand({ type: "object.fill", parameters: { newColorHex: "#112233" } }, patch, META);
    expect(command.parameters.createdLayerIds).toEqual(["N"]);
    expect(command.targets.layerIds).toEqual(["A", "N"]);
    expect(command.parameters.objectCount).toBe(1);
  });

  it("los ids de objeto se acotan a MAX_TARGET_IDS pero objectCount es EXACTO", () => {
    const count = MAX_TARGET_IDS + 40;
    const before = Array.from({ length: count }, (_, index) => object(`o${index}`));
    const after = before.map((o) => ({ ...o, matrix: { ...o.matrix, e: 1 } }));
    const command = buildCommand({ type: "object.move", parameters: { dx: 1, dy: 0 } }, edit({ A: { before, after } }), META);
    expect(command.targets.objectIds).toHaveLength(MAX_TARGET_IDS);
    expect(command.parameters.objectCount).toBe(count);
  });
});

describe("deriveTargets / changedObjectIds", () => {
  it("cuenta agregados, quitados y modificados por contenido (una copia idéntica NO cambia); solo reordenar marca los que cambiaron de lugar", () => {
    const a = object("a");
    const b = object("b");
    expect(changedObjectIds([a, b], [a, b])).toEqual([]);
    expect(changedObjectIds([a, b], [{ ...a }, b])).toEqual([]);
    expect(changedObjectIds([a, b], [object("a", "A", 3), b])).toEqual(["a"]);
    expect(changedObjectIds([a, b], [a])).toEqual(["b"]);
    expect(changedObjectIds([a], [a, object("c")])).toEqual(["c"]);
    expect(changedObjectIds([a, b], [b, a])).toEqual(["b", "a"]);
  });

  it("un objeto que cambia de capa cuenta una sola vez, y las capas tocadas, las de estructura y las de metadata se unen sin repetir", () => {
    const moved = object("m", "A");
    const patch = edit({ A: { before: [moved], after: [] }, B: { before: [], after: [{ ...moved, layerGroupId: "B" }] } }, { layers: { before: [meta("B")], after: [meta("B", { colorHex: "#00ff00" })] } });
    expect(deriveTargets(patch)).toEqual({ layerIds: ["A", "B"], objectIds: ["m"] });
    expect(deriveTargets(edit({}, { meta: { kind: "order", before: ["x", "y"], after: ["y", "x"] } }))).toEqual({ layerIds: ["y", "x"], objectIds: [] });
  });
});

describe("mergeCoalesced", () => {
  const base = (dx: number, dy: number, timestamp: number): EditorCommand => ({
    version: 1,
    id: `id-${timestamp}`,
    sequence: timestamp,
    type: "object.nudge",
    label: `m${timestamp}`,
    targets: { layerIds: ["A"], objectIds: ["a1"] },
    parameters: { dx, dy, objectCount: 1 },
    origin: "user",
    timestamp,
  });

  it("conserva id/sequence del primero, label y timestamp del último y suma dx/dy", () => {
    const merged = mergeCoalesced(base(1, 2, 10), base(3, -1, 20));
    expect(merged).toMatchObject({ id: "id-10", sequence: 10, label: "m20", timestamp: 20, parameters: { dx: 4, dy: 1, objectCount: 1 } });
    expect(merged.targets).toEqual({ layerIds: ["A"], objectIds: ["a1"] });
  });
});

describe("validateParameters y findRawGeometry — nunca geometría cruda", () => {
  it("rechaza claves d/svg/points/matrix/transform, marcado y path data en cualquier profundidad", () => {
    expect(findRawGeometry({ d: "M0 0 L1 1" })).toBe("parameters.d");
    expect(findRawGeometry({ nested: { svg: "x" } })).toBe("parameters.nested.svg");
    expect(findRawGeometry({ points: [[0, 0]] })).toBe("parameters.points");
    expect(findRawGeometry({ matrix: {} })).toBe("parameters.matrix");
    expect(findRawGeometry({ list: [{ ok: 1 }, { transform: "x" }] })).toBe("parameters.list[1].transform");
    expect(findRawGeometry({ text: "<svg xmlns='x'><path d='M0 0'/></svg>" })).toBe("parameters.text");
    expect(findRawGeometry({ text: "M 10 20 L 30 40 Z" })).toBe("parameters.text");
    expect(findRawGeometry({ text: "x".repeat(1001) })).toBe("parameters.text");
  });

  it("deja pasar números, ids y nombres de capa que solo PARECEN comandos de path (A1, L2, Capa M3)", () => {
    expect(findRawGeometry({ from: "A1", to: "L2 azul", name: "Capa M3", dx: 10, ids: ["a-1", "b-2"] })).toBeNull();
  });

  it("valida claves, tipos, rangos, enums, ids, hex y obligatorios (con ranges/requireAll)", () => {
    const strict = { ranges: true, requireAll: true } as const;
    expect(validateParameters("object.move", { dx: 1, dy: 2 }, strict)).toEqual([]);
    expect(validateParameters("object.move", { dx: 1 }, strict)).toEqual(["Falta el parámetro obligatorio «dy»."]);
    expect(validateParameters("object.move", { dx: "1", dy: 2 }, strict)).toEqual(["«dx» debe ser un número finito."]);
    expect(validateParameters("object.move", { dx: Number.NaN, dy: 2 }, strict)).toHaveLength(1);
    expect(validateParameters("object.move", { dx: 1, dy: 2, extra: 1 }, strict)).toEqual(["«extra» no es un parámetro de «object.move»."]);
    expect(validateParameters("object.rotate", { degrees: 99999 }, strict)).toEqual(["«degrees» debe ser ≤ 3600."]);
    expect(validateParameters("object.scale", { sx: 0, sy: 1 }, strict)).toEqual(["«sx» no puede ser (casi) 0."]);
    expect(validateParameters("object.scale", { sx: 2, sy: 1, pivotX: 1 }, strict)).toEqual(["«pivotX» y «pivotY» van juntos o ninguno."]);
    expect(validateParameters("document.rotate", { quarterTurns: 4 }, strict)).toEqual(["«quarterTurns» debe ser ≤ 3."]);
    expect(validateParameters("document.rotate", { quarterTurns: 1.5 }, strict)).toEqual(["«quarterTurns» debe ser un entero."]);
    expect(validateParameters("arrange.align", { mode: "diagonal", reference: "selection" }, strict)[0]).toMatch(/uno de: left, center/);
    expect(validateParameters("object.fill", {}, strict)).toEqual(["Indicá exactamente uno de «targetLayerId» o «newColorHex»."]);
    expect(validateParameters("object.fill", { targetLayerId: "A", newColorHex: "#fff" }, strict)).toHaveLength(1);
    expect(validateParameters("object.fill", { newColorHex: "rojo" }, strict)).toEqual(["«newColorHex» debe ser un color hex válido (#RGB o #RRGGBB)."]);
    expect(validateParameters("object.fill", { newColorHex: "#abc" }, strict)).toEqual([]);
    expect(validateParameters("object.recolor", { scope: "layer", newColorHex: "#abc" }, strict)).toEqual(["Los alcances «layer» y «document» exigen «sourceLayerId»."]);
    expect(validateParameters("layer.reorder", { order: ["a", 3] }, { allowReserved: true })).toEqual(["«order» debe ser una lista de ids."]);
  });

  it("sin ranges (lo que EMITE la UI) un gesto extremo NO falla: solo tipos y claves", () => {
    expect(validateParameters("object.scale", { sx: 0.0001, sy: -3 })).toEqual([]);
    expect(validateParameters("object.rotate", { degrees: 99999 })).toEqual([]);
    expect(validateParameters("object.scale", { sx: "no" })).toHaveLength(1);
  });

  it("los parámetros reservados (objectCount, createdLayerIds) solo valen en un comando YA registrado", () => {
    expect(validateParameters("object.move", { dx: 1, dy: 0, objectCount: 3 }, { ranges: true })).toEqual(["«objectCount» lo calcula el historial: no es un parámetro de entrada."]);
    expect(validateParameters("object.move", { dx: 1, dy: 0, objectCount: 3 }, { allowReserved: true })).toEqual([]);
  });

  it("checkDraft: tipo desconocido y parámetros inválidos lanzan InvalidCommandError (en desarrollo); un borrador válido pasa tal cual", () => {
    const valid = { type: "object.move" as const, parameters: { dx: 1, dy: 2 } };
    expect(checkDraft(valid)).toBe(valid);
    expect(() => checkDraft({ type: "nope" as never })).toThrow(InvalidCommandError);
    expect(() => checkDraft(undefined as never)).toThrow(InvalidCommandError);
    expect(() => checkDraft({ type: "object.move", parameters: { dx: 1, dy: 2, d: "M0 0" } })).toThrow(/crudos/);
    expect(() => checkDraft({ type: "object.move", parameters: { dx: new Date() as never } })).toThrow(/JSON/);
    try {
      checkDraft({ type: "object.move", parameters: { bogus: 1 } });
    } catch (error) {
      expect((error as InvalidCommandError).problems).toEqual(["«bogus» no es un parámetro de «object.move»."]);
    }
  });
});

describe("isJsonValue", () => {
  it("acepta JSON puro y rechaza NaN, Infinity, undefined, funciones, fechas, instancias y profundidad excesiva", () => {
    expect(isJsonValue({ a: [1, "x", null, true, { b: 2 }] })).toBe(true);
    expect(isJsonValue(Number.NaN)).toBe(false);
    expect(isJsonValue(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isJsonValue(undefined)).toBe(false);
    expect(isJsonValue(() => 1)).toBe(false);
    expect(isJsonValue(new Date())).toBe(false);
    expect(isJsonValue(new Map())).toBe(false);
    let deep: unknown = 1;
    for (let level = 0; level < 12; level += 1) deep = { deep };
    expect(isJsonValue(deep)).toBe(false);
  });
});

describe("layerMetaDraft — metadata de capa como comandos", () => {
  const cases: Array<[LayerMetaChange, CommandType, Record<string, unknown>, RegExp]> = [
    [{ kind: "rename", groupId: "B", layerName: "Azul", before: "Azul", after: "Cielo" }, "layer.rename", { from: "Azul", to: "Cielo" }, /Renombrar la capa «Azul» a «Cielo»/],
    [{ kind: "visible", groupId: "B", layerName: "Azul", before: true, after: false }, "layer.setVisible", { visible: false }, /^Ocultar la capa «Azul»/],
    [{ kind: "visible", groupId: "B", layerName: "Azul", before: false, after: true }, "layer.setVisible", { visible: true }, /^Mostrar la capa/],
    [{ kind: "locked", groupId: "B", layerName: "Azul", before: false, after: true }, "layer.setLocked", { locked: true }, /^Bloquear la capa/],
    [{ kind: "locked", groupId: "B", layerName: "Azul", before: true, after: false }, "layer.setLocked", { locked: false }, /^Desbloquear la capa/],
    [{ kind: "operation", groupId: "B", layerName: "Azul", before: "unassigned", after: "cut" }, "layer.setOperation", { operation: "cut", previous: "unassigned" }, /Asignar «Corte»/],
    [{ kind: "order", before: ["A", "B"], after: ["B", "A"] }, "layer.reorder", { order: ["B", "A"] }, /Reordenar/],
  ];

  it.each(cases)("%j -> %s", (change, type, parameters, label) => {
    const draft = layerMetaDraft(change);
    expect(draft.type).toBe(type);
    expect(draft.parameters).toEqual(parameters);
    expect(draft.label).toMatch(label);
    expect(draft.origin).toBe("user");
    expect(checkDraft(draft)).toBe(draft);
    // Sin objetos: un comando de metadata solo apunta a capas.
    const command = buildCommand(draft, edit({}, { meta: change }), META);
    expect(command.targets.objectIds).toEqual([]);
    expect(command.targets.layerIds.length).toBeGreaterThan(0);
    expect(command.parameters.objectCount).toBeUndefined();
  });

  it("un nombre de capa muy largo se recorta en el parámetro (la etiqueta lo lleva entero) y nunca rompe la validación", () => {
    const long = "N".repeat(400);
    const draft = layerMetaDraft({ kind: "rename", groupId: "B", layerName: "Azul", before: "Azul", after: long });
    expect((draft.parameters!.to as string).length).toBeLessThanOrEqual(200);
    expect(draft.label).toContain(long);
    expect(() => checkDraft(draft)).not.toThrow();
  });

  it("un nombre que parece path data de una letra (A1, L2) pasa; uno con 'M 10 20' se trata como geometría cruda", () => {
    expect(() => checkDraft(layerMetaDraft({ kind: "rename", groupId: "B", layerName: "A1", before: "A1", after: "L2" }))).not.toThrow();
    expect(() => checkDraft(layerMetaDraft({ kind: "rename", groupId: "B", layerName: "A1", before: "A1", after: "M 10 20 L 30 40" }))).toThrow(/crudos/);
  });
});

describe("validateCommandShape / parseCommand / parseHistoryExport", () => {
  const good: EditorCommand = {
    version: 1,
    id: "x",
    sequence: 1,
    type: "object.move",
    label: "Mover",
    targets: { layerIds: ["A"], objectIds: ["a1"] },
    parameters: { dx: 1, dy: 2, objectCount: 1 },
    origin: "user",
    timestamp: 5,
  };

  it("un comando válido no tiene errores", () => {
    expect(validateCommandShape(good)).toEqual([]);
  });

  it.each([
    ["version", { ...good, version: 2 }, /version/],
    ["id vacío", { ...good, id: "" }, /id/],
    ["sequence negativa", { ...good, sequence: -1 }, /sequence/],
    ["type desconocido", { ...good, type: "x.y" }, /type/],
    ["origin", { ...good, origin: "robot" }, /origin/],
    ["timestamp", { ...good, timestamp: "hoy" }, /timestamp/],
    ["targets sin lista", { ...good, targets: { layerIds: [] } }, /targets/],
    ["targets con números", { ...good, targets: { layerIds: [1], objectIds: [] } }, /ids de texto/],
    ["parameters array", { ...good, parameters: [] }, /parameters/],
    ["parameters con geometría", { ...good, parameters: { dx: 1, dy: 0, d: "M0 0" } }, /crudos/],
    ["parameters con clave ajena", { ...good, parameters: { zzz: 1 } }, /no es un parámetro/],
  ])("rechaza %s", (_name, value, pattern) => {
    expect(validateCommandShape(value).join(" ")).toMatch(pattern);
    expect(parseCommand(value).ok).toBe(false);
  });

  it("parseCommand: texto que no es JSON y valores que no son objetos", () => {
    expect(parseCommand("{no")).toEqual({ ok: false, errors: ["El texto no es JSON válido."] });
    expect(parseCommand(null).ok).toBe(false);
    expect(parseCommand([good]).ok).toBe(false);
  });

  it("exportCommands copia los comandos (sin referencias compartidas) y parseHistoryExport los valida uno por uno", () => {
    const exported = exportCommands([good, { ...good, id: "y", sequence: 2 }], 1);
    expect(exported).toEqual({ version: 1, position: 1, commands: [good, { ...good, id: "y", sequence: 2 }] });
    exported.commands[0].targets.objectIds.push("zz");
    expect(good.targets.objectIds).toEqual(["a1"]);
    const parsed = parseHistoryExport(JSON.stringify(exportCommands([good], 1)));
    expect(parsed).toEqual({ ok: true, history: { version: 1, position: 1, commands: [good] } });
    expect(parseHistoryExport({ version: 1, position: 5, commands: [good] })).toEqual({ ok: false, errors: ["«position» está fuera de rango."] });
    expect(parseHistoryExport({ version: 1, position: 0, commands: [{ ...good, type: "nope" }] }).ok).toBe(false);
    expect(parseHistoryExport("no json").ok).toBe(false);
    expect(parseHistoryExport({ commands: [] }).ok).toBe(false);
  });
});
