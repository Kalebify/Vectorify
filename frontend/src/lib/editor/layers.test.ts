import { describe, expect, it } from "vitest";
import { applyLayerSnapshots, layerIdsAbsentAfter, placeNewLayers, sameLayerMeta, toLayerMetas } from "./layers";
import type { EditableLayerMeta } from "./types";

function meta(overrides: Partial<EditableLayerMeta> & { groupId: string }): EditableLayerMeta {
  return {
    name: overrides.groupId,
    colorHex: "#ff0000",
    order: 0,
    visible: true,
    locked: false,
    manufacturingOperation: "unassigned",
    isNew: false,
    ...overrides,
  };
}

const serverColors: Record<string, string> = { A: "#ff0000", B: "#0000ff" };
const serverColorOf = (groupId: string) => serverColors[groupId];

describe("layers — snapshots de estructura (undo/redo)", () => {
  it("layerIdsAbsentAfter: undo quita las capas que el comando creó; redo quita las que el comando no tenía", () => {
    const created = meta({ groupId: "N", isNew: true });
    const change = { before: [meta({ groupId: "A" })], after: [meta({ groupId: "A" }), created] };
    expect(layerIdsAbsentAfter(change, "undo")).toEqual(["N"]);
    expect(layerIdsAbsentAfter(change, "redo")).toEqual([]);
    // Un comando que solo recolorea (mismas capas en ambos lados) no agrega ni quita nada.
    const recolor = { before: [meta({ groupId: "A" })], after: [meta({ groupId: "A", colorHex: "#00ff00" })] };
    expect(layerIdsAbsentAfter(recolor, "undo")).toEqual([]);
    expect(layerIdsAbsentAfter(recolor, "redo")).toEqual([]);
  });

  it("aplicar el 'después' de una capa creada la registra como override; deshacerla (removeIds) la elimina sin tocar el resto", () => {
    const created = meta({ groupId: "N", isNew: true, colorHex: "#00ff00" });
    const other = meta({ groupId: "M", isNew: true });
    const withBoth = applyLayerSnapshots({ M: other }, [created], [], serverColorOf);
    expect(Object.keys(withBoth).sort()).toEqual(["M", "N"]);
    expect(withBoth.N).toBe(created);

    const undone = applyLayerSnapshots(withBoth, [], ["N"], serverColorOf);
    expect(undone).toEqual({ M: other });
    expect("N" in undone).toBe(false);
  });

  it("un override de capa del servidor con OTRO color se guarda; volver al color del servidor lo elimina (deshacer hasta el origen deja la estructura limpia)", () => {
    const recolored = meta({ groupId: "A", colorHex: "#00ff00" });
    const applied = applyLayerSnapshots({}, [recolored], [], serverColorOf);
    expect(applied).toEqual({ A: recolored });

    const restored = applyLayerSnapshots(applied, [meta({ groupId: "A", colorHex: "#FF0000" })], [], serverColorOf);
    expect(restored).toEqual({}); // #FF0000 == #ff0000 del servidor: ya no hay override
  });

  it("una capa isNew nunca se descarta por coincidir con un color del servidor (su identidad es su groupId)", () => {
    const sameHex = meta({ groupId: "N", isNew: true, colorHex: "#ff0000" });
    expect(applyLayerSnapshots({}, [sameHex], [], serverColorOf)).toEqual({ N: sameHex });
  });

  it("devuelve un objeto nuevo y no muta el original", () => {
    const original = { A: meta({ groupId: "A", colorHex: "#00ff00" }) };
    const frozen = Object.freeze({ ...original });
    const next = applyLayerSnapshots(frozen, [meta({ groupId: "B", colorHex: "#123456" })], [], serverColorOf);
    expect(next).not.toBe(frozen);
    expect(Object.keys(frozen)).toEqual(["A"]);
    expect(Object.keys(next).sort()).toEqual(["A", "B"]);
  });

  it("sameLayerMeta compara todos los campos (incluido isNew y el hex tal cual)", () => {
    const base = meta({ groupId: "A" });
    expect(sameLayerMeta(base, { ...base })).toBe(true);
    for (const patch of [{ name: "x" }, { colorHex: "#FF0000" }, { order: 1 }, { visible: false }, { locked: true }, { manufacturingOperation: "cut" as const }, { isNew: true }]) {
      expect(sameLayerMeta(base, { ...base, ...patch })).toBe(false);
    }
  });

  it("toLayerMetas deriva la meta de las capas efectivas con la visibilidad que se decida", () => {
    const layers = [
      { groupId: "A", name: "Rojo", colorHex: "#ff0000", order: 0, visible: true, locked: false, manufacturingOperation: "cut" as const },
      { groupId: "N", name: "Nueva", colorHex: "#00ff00", order: 1, visible: true, locked: true, manufacturingOperation: "unassigned" as const, isNew: true },
    ];
    expect(toLayerMetas(layers, (layer) => layer.groupId === "N")).toEqual([
      { groupId: "A", name: "Rojo", colorHex: "#ff0000", order: 0, visible: false, locked: false, manufacturingOperation: "cut", isNew: false },
      { groupId: "N", name: "Nueva", colorHex: "#00ff00", order: 1, visible: true, locked: true, manufacturingOperation: "unassigned", isNew: true },
    ]);
  });
});

describe("layers — posición de capas nuevas al reordenar", () => {
  const isNew = (groupId: string) => groupId.startsWith("N");
  const serverOrders: Record<string, number> = { S1: 0, S2: 1, S3: 2 };
  const serverOrderOf = (groupId: string) => serverOrders[groupId];

  /** Orden resultante: ordenar por `order` (servidor + fraccionarios) debe reproducir exactamente el pedido. */
  function resolved(ordered: string[]): string[] {
    const placed = placeNewLayers(ordered, isNew, serverOrderOf);
    return [...ordered].sort((a, b) => (isNew(a) ? placed[a] : serverOrderOf(a)) - (isNew(b) ? placed[b] : serverOrderOf(b)));
  }

  it("una capa nueva entre dos del servidor recibe un order fraccionario entre ambas", () => {
    const placed = placeNewLayers(["S1", "N1", "S2", "S3"], isNew, serverOrderOf);
    expect(placed.N1).toBeGreaterThan(0);
    expect(placed.N1).toBeLessThan(1);
  });

  it("reproduce el orden pedido en el principio, el medio y el final", () => {
    for (const ordered of [
      ["N1", "S1", "S2", "S3"],
      ["S1", "N1", "S2", "S3"],
      ["S1", "S2", "N1", "S3"],
      ["S1", "S2", "S3", "N1"],
    ]) {
      expect(resolved(ordered)).toEqual(ordered);
    }
  });

  it("varias capas nuevas consecutivas conservan su orden relativo y quedan entre las mismas vecinas", () => {
    const ordered = ["S1", "N1", "N2", "N3", "S2", "S3"];
    const placed = placeNewLayers(ordered, isNew, serverOrderOf);
    expect(placed.N1).toBeLessThan(placed.N2);
    expect(placed.N2).toBeLessThan(placed.N3);
    expect(placed.N1).toBeGreaterThan(0);
    expect(placed.N3).toBeLessThan(1);
    expect(resolved(ordered)).toEqual(ordered);
    expect(resolved(["N1", "N2", "S1", "S2", "S3", "N3"])).toEqual(["N1", "N2", "S1", "S2", "S3", "N3"]);
  });

  it("tramos separados se resuelven por separado", () => {
    expect(resolved(["N1", "S1", "N2", "S2", "N3", "S3"])).toEqual(["N1", "S1", "N2", "S2", "N3", "S3"]);
  });

  it("sin capas del servidor, el orden es el índice", () => {
    expect(placeNewLayers(["N1", "N2", "N3"], isNew, serverOrderOf)).toEqual({ N1: 0, N2: 1, N3: 2 });
  });

  it("sin capas nuevas no hay nada que ubicar", () => {
    expect(placeNewLayers(["S1", "S2"], isNew, serverOrderOf)).toEqual({});
  });

  it("respeta un order del servidor NO contiguo (orders 10, 20, 30)", () => {
    const orders: Record<string, number> = { S1: 10, S2: 20, S3: 30 };
    const placed = placeNewLayers(["S1", "S2", "N1", "S3"], isNew, (groupId) => orders[groupId]);
    expect(placed.N1).toBeGreaterThan(20);
    expect(placed.N1).toBeLessThan(30);
    const atStart = placeNewLayers(["N1", "S1", "S2", "S3"], isNew, (groupId) => orders[groupId]);
    expect(atStart.N1).toBeLessThan(10);
  });
});
