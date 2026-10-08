import { describe, expect, it } from "vitest";
import { buildFillProduction, buildRecolorProduction, type ColorTarget } from "./colors";
import type { EditableDocument, EditableLayerMeta, EditorObject } from "./types";

/**
 * Fill / Recolor sobre las líneas abiertas de Draw (M3-S04): su color es el de su TRAZO (`fill` es "none"); pintarlas con `fill` las
 * convertiría en formas rellenas. Los objetos de S03 siguen pintándose con `fill`.
 */

const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

function layer(groupId: string, name: string, colorHex: string, order: number): EditableLayerMeta {
  return { groupId, name, colorHex, order, visible: true, locked: false, manufacturingOperation: "unassigned", isNew: false };
}

const A = layer("A", "Rojo", "#ff0000", 0);
const B = layer("B", "Azul", "#0000ff", 1);

const shape = (id: string, layerGroupId: string, fill: string): EditorObject => ({ id, layerGroupId, d: "M0 0 H10 V10 H0 Z", fill, matrix: IDENTITY });
const line = (id: string, layerGroupId: string, stroke: string): EditorObject => ({ id, layerGroupId, d: "M0 0 L10 0", fill: "none", stroke, strokeWidth: 0.1, matrix: IDENTITY });

function state(): EditableDocument {
  return {
    layers: [A, B],
    objectsByLayer: { A: [line("ln1", "A", "#ff0000"), shape("a1", "A", "#ff0000")], B: [shape("b1", "B", "#0000ff")] },
  };
}

const layerTarget = (groupId: string): ColorTarget => ({ kind: "layer", groupId });
const newTarget = (hex: string): ColorTarget => ({ kind: "new", hex, groupId: "NEW" });

describe("colors — líneas abiertas de Draw (M3-S04)", () => {
  it("Fill mueve una línea a otra capa y pinta su TRAZO con el color de la capa destino; fill sigue siendo none", () => {
    const production = buildFillProduction(state(), new Set(["ln1"]), layerTarget("B"))!;

    expect(production.layers.B[1]).toStrictEqual({ id: "ln1", layerGroupId: "B", d: "M0 0 L10 0", fill: "none", stroke: "#0000ff", strokeWidth: 0.1, matrix: IDENTITY });
  });

  it("Fill de una forma rellena sigue pintando fill y no agrega trazo", () => {
    const production = buildFillProduction(state(), new Set(["a1"]), layerTarget("B"))!;

    expect(production.layers.B[1]).toStrictEqual({ id: "a1", layerGroupId: "B", d: "M0 0 H10 V10 H0 Z", fill: "#0000ff", matrix: IDENTITY });
  });

  it("Recolor de capa cambia el trazo de las líneas y el fill de las formas de la capa", () => {
    const production = buildRecolorProduction("layer", state(), { target: newTarget("#00ff00"), sourceGroupId: "A" })!;
    const [recoloredLine, recoloredShape] = production.layers.A;

    expect(recoloredLine).toMatchObject({ fill: "none", stroke: "#00FF00" });
    expect(recoloredShape.fill).toBe("#00FF00");
    expect("stroke" in recoloredShape).toBe(false);
  });
});
