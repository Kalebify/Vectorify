import { describe, expect, it } from "vitest";
import { exportDataset } from "../../../test/exportDataset";
import { orderedLayers } from "./exportDocument";
import { archiveFileName, documentFileName, dxfLayerName, layerFileNames, MAX_NAME_PART_LENGTH, operationSlug, projectNamePart, sanitizeNamePart } from "./fileNames";

const SAFE = /^[a-z0-9._-]+$/;

describe("sanitizeNamePart", () => {
  it("quita tildes y eñes, pasa a minúsculas y reemplaza lo que no es [a-z0-9.-] por «-»", () => {
    expect(sanitizeNamePart("Ñandú Ánimo", "x")).toBe("nandu-animo");
    expect(sanitizeNamePart("Ça va? ¡Sí! (ñoño)", "x")).toBe("ca-va-si-nono");
    expect(sanitizeNamePart("Straße œuvre Łódź", "x")).toBe("strasse-oeuvre-lodz");
  });

  it("colapsa rachas, recorta los bordes y no deja «_» (es el separador de partes)", () => {
    expect(sanitizeNamePart("  --Capa___ 1 //  ", "x")).toBe("capa-1");
    expect(sanitizeNamePart("a..b", "x")).toBe("a.b");
    expect(sanitizeNamePart("...", "x")).toBe("x");
  });

  it("devuelve el fallback si no queda nada (solo símbolos, emoji, vacío)", () => {
    expect(sanitizeNamePart("", "capa")).toBe("capa");
    expect(sanitizeNamePart("★★★", "capa")).toBe("capa");
    expect(sanitizeNamePart("日本語", "capa")).toBe("capa");
  });

  it("acota el largo y no deja un separador colgando al truncar", () => {
    const long = sanitizeNamePart(`${"a".repeat(39)} bbbbbb`, "x");
    expect(long.length).toBeLessThanOrEqual(MAX_NAME_PART_LENGTH);
    expect(long).toBe("a".repeat(39));
    expect(sanitizeNamePart("z".repeat(500), "x")).toHaveLength(MAX_NAME_PART_LENGTH);
  });

  it("neutraliza los nombres reservados de Windows (con cualquier mayúscula y con extensión)", () => {
    for (const reserved of ["CON", "prn", "Aux", "NUL", "COM1", "lpt9", "con.txt"]) {
      const result = sanitizeNamePart(reserved, "x");
      expect(result.split(".")[0]).not.toMatch(/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/);
      expect(result).toMatch(SAFE);
    }
    expect(sanitizeNamePart("console", "x")).toBe("console"); // no es reservado
  });

  it("nunca produce path traversal ni separadores de ruta", () => {
    const result = sanitizeNamePart("../../etc/passwd\\x", "x");
    expect(result).toBe("etc-passwd-x");
    expect(result).not.toMatch(/[\\/]/);
  });

  it("es determinista", () => {
    expect(sanitizeNamePart("Ñandú Ánimo", "x")).toBe(sanitizeNamePart("Ñandú Ánimo", "x"));
  });
});

describe("nombres del documento", () => {
  it("proyecto: sin la extensión conocida con la que suele terminar, y con fallback", () => {
    expect(projectNamePart("Project.svg")).toBe("project");
    expect(projectNamePart("mi-diseño.SVG")).toBe("mi-diseno");
    expect(projectNamePart("v1.2")).toBe("v1.2");
    expect(projectNamePart("   ")).toBe("proyecto");
  });

  it("archivo único y ZIP: proyecto_documento.ext y proyecto_layers.zip", () => {
    expect(documentFileName("Mi Diseño", "svg")).toBe("mi-diseno_documento.svg");
    expect(documentFileName("Mi Diseño", "dxf")).toBe("mi-diseno_documento.dxf");
    expect(documentFileName("Mi Diseño", "png")).toBe("mi-diseno_documento.png");
    expect(archiveFileName("Mi Diseño")).toBe("mi-diseno_layers.zip");
  });

  it("operationSlug cubre las cuatro operaciones", () => {
    expect(["cut", "engrave", "ignore", "unassigned"].map((op) => operationSlug(op as "cut"))).toEqual(["cut", "engrave", "ignore", "unassigned"]);
  });
});

describe("layerFileNames: proyecto_layer_operación.ext", () => {
  it("usa el nombre de la capa y su operación, en el orden de las capas", () => {
    const names = layerFileNames("Mi Diseño", orderedLayers(exportDataset().layers), "svg");
    expect(Object.values(names)).toEqual([
      "mi-diseno_rojo_cut.svg",
      "mi-diseno_grabado_engrave.svg",
      "mi-diseno_ignorada_ignore.svg",
      "mi-diseno_oculta_cut.svg",
      "mi-diseno_nandu-animo_unassigned.svg",
    ]);
    for (const name of Object.values(names)) expect(name).toMatch(SAFE);
  });

  it("es determinista: el orden en que llegan las capas no cambia los nombres", () => {
    const layers = exportDataset().layers;
    const forward = layerFileNames("p", layers, "dxf");
    const reversed = layerFileNames("p", [...layers].reverse(), "dxf");
    expect(reversed).toEqual(forward);
    expect(layerFileNames("p", layers, "dxf")).toEqual(forward);
  });

  it("colisiones: la primera conserva el nombre y las siguientes reciben -2, -3 en orden de capa", () => {
    const base = { manufacturingOperation: "cut" as const };
    const names = layerFileNames(
      "p",
      [
        { groupId: "c", name: "Rojo", order: 2, ...base },
        { groupId: "a", name: "ROJO", order: 0, ...base },
        { groupId: "b", name: "rojo!", order: 1, ...base },
      ],
      "svg",
    );
    expect(names).toEqual({ a: "p_rojo_cut.svg", b: "p_rojo_cut-2.svg", c: "p_rojo_cut-3.svg" });
  });

  it("una colisión con un nombre que ya lleva sufijo también se resuelve", () => {
    const base = { manufacturingOperation: "cut" as const };
    const names = layerFileNames(
      "p",
      [
        { groupId: "a", name: "Rojo", order: 0, ...base },
        { groupId: "b", name: "Rojo", order: 1, ...base },
        { groupId: "c", name: "Rojo", order: 2, ...base },
      ],
      "svg",
    );
    expect(new Set(Object.values(names)).size).toBe(3);
    expect(layerFileNames("p", [{ groupId: "x", name: "Rojo cut 2", order: 0, ...base }], "svg")).toEqual({ x: "p_rojo-cut-2_cut.svg" });
  });

  it("desempata por groupId cuando dos capas comparten order", () => {
    const base = { manufacturingOperation: "cut" as const, name: "Igual", order: 0 };
    const names = layerFileNames("p", [{ groupId: "z", ...base }, { groupId: "a", ...base }], "svg");
    expect(names).toEqual({ a: "p_igual_cut.svg", z: "p_igual_cut-2.svg" });
  });

  it("nombres de capa extremos: vacío, reservado, larguísimo y con ruta", () => {
    const base = { manufacturingOperation: "engrave" as const, order: 0 };
    const names = layerFileNames(
      "CON",
      [
        { groupId: "1", name: "", ...base, order: 0 },
        { groupId: "2", name: "NUL", ...base, order: 1 },
        { groupId: "3", name: "x".repeat(300), ...base, order: 2 },
        { groupId: "4", name: "../../a/b", ...base, order: 3 },
      ],
      "png",
    );
    for (const name of Object.values(names)) {
      expect(name).toMatch(SAFE);
      expect(name.length).toBeLessThanOrEqual(2 * MAX_NAME_PART_LENGTH + 40);
    }
    expect(names["1"]).toBe("con-x_capa_engrave.png");
  });
});

describe("dxfLayerName", () => {
  it("mayúsculas, sin caracteres raros, ≤ 31 y únicos (la «0» está reservada)", () => {
    const taken = new Set<string>(["0"]);
    expect(dxfLayerName("Ñandú Ánimo", taken)).toBe("NANDU-ANIMO");
    expect(dxfLayerName("nandu animo", taken)).toBe("NANDU-ANIMO-2");
    expect(dxfLayerName("0", taken)).toBe("0-2");
    expect(dxfLayerName("x".repeat(100), taken)).toHaveLength(31);
    const again = dxfLayerName("x".repeat(100), taken);
    expect(again).toHaveLength(31);
    expect(again.endsWith("-2")).toBe(true);
    expect(dxfLayerName("★", taken)).toBe("CAPA");
    expect(dxfLayerName("a.b", taken)).toBe("A_B");
  });
});
