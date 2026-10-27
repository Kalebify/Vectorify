import { describe, expect, it } from "vitest";
import { exportDataset, exportDatasetNoScale, IDS, pathObject } from "../../../test/exportDataset";
import { analyzeLaserLocal, buildReport, type LaserCheckReport } from "../laserCheck";
import { defaultExportSelection, type ExportDocument } from "./exportDocument";
import { buildExportPreflight, DEFAULT_EXPORT_OPTIONS, MAX_PREFLIGHT_ISSUES_SHOWN, type ExportOptions } from "./exportPlan";
import { PNG_MAX_SIDE } from "./pngExport";

const select = (...ids: string[]) => new Set(ids);
const options = (overrides: Partial<ExportOptions> = {}): ExportOptions => ({ ...DEFAULT_EXPORT_OPTIONS, ...overrides });

/** Reporte REAL del Laser Check (checks locales + flotantes resueltos sin islas) sobre el documento del dataset. */
function realReport(document: ExportDocument, floating: "done" | "pending" = "done"): LaserCheckReport {
  const local = analyzeLaserLocal({ objectsByLayer: document.objectsByLayer as never, frame: document.frame, layers: [...document.layers] }, { mmFactor: document.mmFactor });
  return buildReport(local, floating === "done" ? { state: "done", issues: [] } : { state: "pending" });
}

function withOpenPath(): ExportDocument {
  const base = exportDataset();
  return exportDataset({ objectsByLayer: { ...base.objectsByLayer, [IDS.rojo]: [...base.objectsByLayer[IDS.rojo], pathObject("abierto", IDS.rojo, "M0 0 H10 V10", { fill: "#ff0000" })] } });
}

describe("selección por defecto", () => {
  it("visibles y distintas de IGNORE", () => {
    expect([...defaultExportSelection(exportDataset().layers)]).toEqual([IDS.rojo, IDS.grabado, IDS.sinop]);
  });
});

describe("selección por defecto: layers excluidas de la paleta (fondo técnico)", () => {
  function withExcludedRed(): ExportDocument {
    const base = exportDataset();
    return { ...base, layers: base.layers.map((layer) => (layer.groupId === IDS.rojo ? { ...layer, isExcluded: true } : layer)) };
  }

  it("una layer marcada como excluida en la paleta no entra en la selección por defecto", () => {
    expect([...defaultExportSelection(withExcludedRed().layers)]).toEqual([IDS.grabado, IDS.sinop]);
  });

  it("el preflight explica que fue excluida en la paleta y que se puede elegir a mano", () => {
    const document = withExcludedRed();

    const byDefault = buildExportPreflight(document, defaultExportSelection(document.layers), options(), null);
    const red = byDefault.layers.find((layer) => layer.groupId === IDS.rojo)!;
    expect(red.included).toBe(false);
    expect(red.exclusion).toBe("excluded");

    const manual = buildExportPreflight(document, select(IDS.rojo), options(), null);
    expect(manual.layers.find((layer) => layer.groupId === IDS.rojo)!.included).toBe(true);
  });
});

describe("buildExportPreflight: dimensiones, layers y operaciones", () => {
  const document = exportDataset();
  const preflight = buildExportPreflight(document, defaultExportSelection(document.layers), options(), null);

  it("dimensiones en mm del área de trabajo y en unidades", () => {
    expect(preflight.dimensions).toEqual({ widthMm: 100, heightMm: 50 });
    expect(preflight.units).toEqual({ width: 200, height: 100 });
    expect(preflight.dimensionsText).toBe("100 × 50 mm");
  });

  it("sin escala: lo dice («sin escala», en unidades) y avisa; nunca inventa mm", () => {
    const noScale = exportDatasetNoScale();
    const result = buildExportPreflight(noScale, defaultExportSelection(noScale.layers), options(), null);
    expect(result.dimensions).toBeNull();
    expect(result.dimensionsText).toBe("200 × 100 u (sin escala)");
    expect(result.warnings.find((warning) => warning.code === "no_scale")?.message).toMatch(/Sin escala física.*SVG/);
    expect(buildExportPreflight(noScale, defaultExportSelection(noScale.layers), options({ format: "dxf" }), null).warnings.find((warning) => warning.code === "no_scale")?.message).toMatch(/DXF.*INSUNITS = 0/);
  });

  it("lista TODAS las layers en orden con operación, nº de objetos e incluida/excluida y por qué", () => {
    expect(preflight.layers.map((layer) => [layer.name, layer.operationLabel, layer.objectCount, layer.included, layer.exclusion])).toEqual([
      ["Rojo", "Corte", 2, true, null],
      ["Grabado", "Grabado", 1, true, null],
      ["Ignorada", "Ignorada", 1, false, "ignore"],
      ["Oculta", "Corte", 1, false, "hidden"],
      ["Ñandú Ánimo", "Sin operación", 1, true, null],
    ]);
    expect(preflight.includedCount).toBe(3);
    expect(preflight.objectCount).toBe(4);
  });

  it("una layer visible pero no elegida figura como «no seleccionada»", () => {
    const partial = buildExportPreflight(document, select(IDS.rojo), options(), null);
    expect(partial.layers.map((layer) => layer.exclusion)).toEqual([null, "not_selected", "ignore", "hidden", "not_selected"]);
    expect(partial.includedCount).toBe(1);
    expect(partial.objectCount).toBe(2);
  });

  it("avisa de las capas sin operación incluidas, y de las ocultas o ignoradas incluidas a mano", () => {
    expect(preflight.warnings.map((warning) => warning.code)).toEqual(["unassigned"]);
    expect(preflight.warnings[0].message).toContain("Ñandú Ánimo");
    const everything = buildExportPreflight(document, select(...document.layers.map((layer) => layer.groupId)), options(), null);
    expect(everything.warnings.map((warning) => warning.code)).toEqual(["unassigned", "included_hidden", "included_ignored"]);
    expect(everything.layers.find((layer) => layer.name === "Oculta")?.notes).toEqual(["oculta en el editor"]);
    expect(everything.layers.find((layer) => layer.name === "Ignorada")?.notes).toEqual(["operación IGNORE"]);
  });

  it("ids de selección que no existen se ignoran", () => {
    const result = buildExportPreflight(document, select("fantasma", IDS.rojo), options(), null);
    expect(result.includedCount).toBe(1);
  });

  it("una layer incluida sin objetos se avisa", () => {
    const base = exportDataset();
    const withEmpty = exportDataset({ objectsByLayer: { ...base.objectsByLayer, [IDS.grabado]: [] } });
    const result = buildExportPreflight(withEmpty, select(IDS.rojo, IDS.grabado), options(), null);
    expect(result.warnings.map((warning) => warning.code)).toContain("empty_layers");
    expect(result.layers[1].notes).toContain("sin objetos");
    expect(result.canExport).toBe(true);
  });
});

describe("buildExportPreflight: archivos y nombres", () => {
  const document = exportDataset();
  const selection = defaultExportSelection(document.layers);

  it("documento único: proyecto_documento.ext, sin ZIP", () => {
    for (const format of ["svg", "dxf", "png"] as const) {
      const result = buildExportPreflight(document, selection, options({ format }), null);
      expect(result.files).toEqual([`mi-diseno_documento.${format}`]);
      expect(result.downloadName).toBe(`mi-diseno_documento.${format}`);
      expect(result.packaged).toBe(false);
    }
  });

  it("un archivo por layer: proyecto_layer_operación.ext en un ZIP proyecto_layers.zip cuando son varios", () => {
    const result = buildExportPreflight(document, selection, options({ mode: "layers", format: "dxf" }), null);
    expect(result.files).toEqual(["mi-diseno_rojo_cut.dxf", "mi-diseno_grabado_engrave.dxf", "mi-diseno_nandu-animo_unassigned.dxf"]);
    expect(result.packaged).toBe(true);
    expect(result.downloadName).toBe("mi-diseno_layers.zip");
    expect(result.layers.filter((layer) => layer.included).map((layer) => layer.fileName)).toEqual(result.files);
    expect(result.layers.filter((layer) => !layer.included).every((layer) => layer.fileName === null)).toBe(true);
  });

  it("con UNA sola layer elegida no se empaqueta: se descarga el archivo directo", () => {
    const result = buildExportPreflight(document, select(IDS.grabado), options({ mode: "layers" }), null);
    expect(result.files).toEqual(["mi-diseno_grabado_engrave.svg"]);
    expect(result.packaged).toBe(false);
    expect(result.downloadName).toBe("mi-diseno_grabado_engrave.svg");
  });

  it("los nombres son deterministas", () => {
    const again = buildExportPreflight(exportDataset(), defaultExportSelection(exportDataset().layers), options({ mode: "layers" }), null);
    expect(again.files).toEqual(buildExportPreflight(document, selection, options({ mode: "layers" }), null).files);
  });
});

describe("buildExportPreflight: errores que impiden exportar", () => {
  const document = exportDataset();

  it("sin layers elegidas no se puede exportar", () => {
    const result = buildExportPreflight(document, select(), options(), null);
    expect(result.canExport).toBe(false);
    expect(result.error).toBe("Elegí al menos una layer para exportar.");
    expect(result.files).toEqual([]);
    expect(result.downloadName).toBeNull();
  });

  it("layers elegidas sin objetos", () => {
    const base = exportDataset();
    const empty = exportDataset({ objectsByLayer: { ...base.objectsByLayer, [IDS.rojo]: [] } });
    expect(buildExportPreflight(empty, select(IDS.rojo), options(), null).error).toMatch(/no tienen objetos/);
  });

  it("PNG: tamaño resuelto con la relación de aspecto; fuera de tope, ancho inválido o color inválido => error", () => {
    const selection = defaultExportSelection(document.layers);
    expect(buildExportPreflight(document, selection, options({ format: "png", pngWidth: 800 }), null).png).toEqual({ width: 800, height: 400 });
    expect(buildExportPreflight(document, selection, options({ format: "png", pngWidth: PNG_MAX_SIDE + 1 }), null).error).toMatch(/supera el máximo/);
    expect(buildExportPreflight(document, selection, options({ format: "png", pngWidth: Number.NaN }), null).error).toMatch(/ancho/i);
    expect(buildExportPreflight(document, selection, options({ format: "png", pngBackground: "rojo" }), null).error).toMatch(/color de fondo/);
    expect(buildExportPreflight(document, selection, options({ format: "png", pngBackground: null }), null).canExport).toBe(true);
    // Los errores del PNG no afectan a SVG/DXF.
    expect(buildExportPreflight(document, selection, options({ format: "svg", pngWidth: Number.NaN }), null).canExport).toBe(true);
  });

  it("PNG avisa que es una vista previa, no un archivo de fabricación", () => {
    expect(buildExportPreflight(document, defaultExportSelection(document.layers), options({ format: "png" }), null).warnings.map((warning) => warning.code)).toContain("png_preview");
  });
});

describe("buildExportPreflight: Laser Check", () => {
  it("sin reporte (todavía no corrió o desactualizado): NO VERIFICADO, nunca Ready, y no exige confirmación", () => {
    const document = exportDataset();
    const result = buildExportPreflight(document, defaultExportSelection(document.layers), options(), null);
    expect(result.laser.state).toBe("unverified");
    expect(result.laser.label).toBe("No verificado");
    expect(result.laser.unverified).toHaveLength(1);
    expect(result.requiresConfirmation).toBe(false);
    expect(result.canExport).toBe(true);
  });

  it("reporte con checks pendientes (flotantes sin responder): NO VERIFICADO con su motivo, aunque no haya issues", () => {
    const document = exportDataset();
    const report = realReport(document, "pending");
    expect(report.status).not.toBe("ready");
    const result = buildExportPreflight(document, defaultExportSelection(document.layers), options(), report);
    expect(result.laser.state).toBe("unverified");
    expect(result.laser.unverified.join(" ")).toMatch(/Piezas flotantes/);
    expect(result.laser.summary).toMatch(/no verificado: Piezas flotantes/);
  });

  it("solo avisos y todo verificado: Review, sin confirmación", () => {
    const document = exportDataset();
    const report = realReport(document);
    expect(report.status).toBe("review"); // la capa sin operación genera un aviso
    const result = buildExportPreflight(document, defaultExportSelection(document.layers), options(), report);
    expect(result.laser.state).toBe("review");
    expect(result.laser.reviewCount).toBeGreaterThan(0);
    expect(result.laser.blocking).toEqual([]);
    expect(result.requiresConfirmation).toBe(false);
  });

  it("un reporte sin issues y verificado es Ready", () => {
    const document = exportDataset();
    const ready: LaserCheckReport = { status: "ready", issues: [], unverified: [], counts: { errors: 0, warnings: 0 } };
    const result = buildExportPreflight(document, defaultExportSelection(document.layers), options(), ready);
    expect(result.laser.state).toBe("ready");
    expect(result.laser.summary).toBe("Laser Check: Ready. Sin problemas detectados.");
  });

  it("bloqueante en una layer que se exporta: Blocking, lista los issues y exige confirmación (pero no impide exportar)", () => {
    const document = withOpenPath();
    const report = realReport(document);
    expect(report.status).toBe("blocking");
    const result = buildExportPreflight(document, defaultExportSelection(document.layers), options(), report);
    expect(result.laser.state).toBe("blocking");
    expect(result.laser.label).toBe("Blocking");
    expect(result.laser.blocking).toHaveLength(report.counts.errors);
    expect(result.laser.blocking[0]).toMatchObject({ kindLabel: "Path abierto", layerName: "Rojo" });
    expect(result.requiresConfirmation).toBe(true);
    expect(result.canExport).toBe(true);
  });

  it("el bloqueante de una layer que NO se exporta no cuenta (se informa aparte)", () => {
    const document = withOpenPath();
    const report = realReport(document);
    const result = buildExportPreflight(document, select(IDS.grabado), options(), report);
    expect(result.laser.state).not.toBe("blocking");
    expect(result.laser.blockingOutside).toBe(report.counts.errors);
    expect(result.laser.summary).toMatch(/en layers que no se exportan/);
    expect(result.requiresConfirmation).toBe(false);
  });

  it("bloqueante + no verificado: el estado es Blocking y además lista lo no verificado", () => {
    const document = withOpenPath();
    const report = realReport(document, "pending");
    const result = buildExportPreflight(document, defaultExportSelection(document.layers), options(), report);
    expect(result.laser.state).toBe("blocking");
    expect(result.laser.unverified.length).toBeGreaterThan(0);
  });

  it("MAX_PREFLIGHT_ISSUES_SHOWN es un tope de presentación: el preflight conserva todos los issues", () => {
    expect(MAX_PREFLIGHT_ISSUES_SHOWN).toBeGreaterThan(0);
    const document = exportDataset();
    const issues = Array.from({ length: MAX_PREFLIGHT_ISSUES_SHOWN + 5 }, (_, index) => ({
      id: `i${index}`,
      kind: "open_path" as const,
      severity: "error" as const,
      layerGroupId: IDS.rojo,
      layerName: "Rojo",
      operation: "cut" as const,
      unassigned: false,
      objectIds: [],
      objectLabel: `Rojo · objeto ${index}`,
      message: "m",
      suggestion: "s",
      rect: null,
      highlights: [],
      order: index,
    }));
    const report: LaserCheckReport = { status: "blocking", issues, unverified: [], counts: { errors: issues.length, warnings: 0 } };
    expect(buildExportPreflight(document, select(IDS.rojo), options(), report).laser.blocking).toHaveLength(issues.length);
  });
});
