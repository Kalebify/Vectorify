// E2E HTTP de la agrupación por familias de color (tarjeta «Agrupar sombras y variantes en colores base»).
// Mismo criterio que mvp3_release_e2e_test.mjs: fetch real contra la Web API real (sin mocks) con la pila
// ya corriendo. Con el PNG ORIGINAL del pato (1152x2048) recorre:
//
//   upload -> detect base_colors (objetivo 5) -> alternar a «detailed» y volver (caché por estilo) ->
//   renombrar -> confirmar -> capas -> operaciones + mm -> save v2 -> reabrir el documento.
//
// y comprueba CA-01/CA-02/CA-05/CA-10/CA-11/CA-12 (parte HTTP): cinco familias + un fondo técnico, una
// capa por grupo, el fondo excluido/ignorado, el tiempo de detección bajo el límite de 20 s, y que el
// estilo/parámetros viajan y se conservan al reabrir. La descarga SVG/DXF es del cliente (React): se
// verifica en el navegador (ver docs/AGRUPACION_FAMILIAS_COLOR.md).
//
// Uso:
//   BACKEND_URL=http://localhost:5080 node tests/e2e/color_families_e2e_test.mjs [ruta/al/png]

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const API = (process.env.BACKEND_URL || "http://localhost:5080").replace(/\/$/, "");
const PNG = process.argv[2] || join(ROOT, "services", "python-engine", "tests", "fixtures", "pato_1152x2048.png");
const WIDTH_MM = 150;
const DETECTION_BUDGET_MS = 20_000;

function assert(condition, message) {
  if (!condition) throw new Error(`FALLÓ: ${message}`);
}

async function json(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed, rawText: text };
}

/** Clase de color por tono (sin conocer el personaje): solo para etiquetar el resultado. */
function colorClass(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (max < 0.15) return "negro";
  if (d < 0.12) return l > 0.6 ? "blanco/gris" : "gris";
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  if (h < 40) return "naranja";
  if (h < 75) return "amarillo";
  if (h < 170) return "verde";
  return `otro(${Math.round(h)}°)`;
}

const report = { steps: {}, groups: [] };

async function main() {
  const bytes = readFileSync(PNG);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "image/png" }), "pato.png");
  const up = await fetch(`${API}/api/v1/projects`, { method: "POST", body: form });
  assert(up.status === 201, `upload: esperaba 201, fue ${up.status}`);
  const uploaded = await up.json();
  const { projectId: classicProjectId, imageId, width, height } = uploaded;
  assert(width === 1152 && height === 2048, `el PNG original debe ser 1152x2048 (fue ${width}x${height})`);
  const root = `/api/v1/projects/${classicProjectId}/images/${imageId}/color-palette`;

  // 1) Colores base, objetivo 5 (CA-01, CA-02, CA-05, CA-11)
  let t0 = Date.now();
  const families = await json("POST", `${root}/detect`, { groupingStyle: "base_colors", targetFamilies: 5, groupingStrength: 0.5 });
  report.steps.detectBaseColorsMs = Date.now() - t0;
  assert(families.status === 201, `detect base_colors: esperaba 201, fue ${families.status} (${families.rawText})`);
  const palette = families.body;
  assert(report.steps.detectBaseColorsMs < DETECTION_BUDGET_MS, `detección ${report.steps.detectBaseColorsMs} ms >= ${DETECTION_BUDGET_MS} ms`);
  assert(palette.groupingStyle === "base_colors" && palette.targetFamilies === 5 && palette.groupingStrength === 0.5, "parámetros efectivos no devueltos");
  assert(palette.algorithmVersion >= 1, `algorithmVersion esperado >= 1, fue ${palette.algorithmVersion}`);
  assert(palette.familyCount === 5, `familias esperadas 5, hay ${palette.familyCount} (${palette.groups.map((g) => g.colorHex).join(", ")})`);
  assert(palette.groups.length === 6, `grupos esperados 6 (5 familias + fondo técnico), hay ${palette.groups.length}`);
  const background = palette.groups.filter((g) => g.isBackground);
  assert(background.length === 1 && background[0].isExcluded && palette.groups.at(-1).isBackground, "el fondo técnico debe ser único, excluido y último");
  const drawing = palette.groups.filter((g) => !g.isBackground);
  assert(drawing.every((g) => !g.isExcluded), "las familias del dibujo no deben venir excluidas (los blancos interiores se conservan)");
  const classes = drawing.map((g) => colorClass(g.colorHex)).sort();
  assert(JSON.stringify(classes) === JSON.stringify(["amarillo", "blanco/gris", "naranja", "negro", "verde"].sort()), `familias inesperadas: ${classes.join(", ")}`);
  assert(palette.pieceCount >= drawing.length, "pieceCount debe sumar al menos una pieza por familia");
  assert(palette.background && palette.background.needsReview === true, "el pato debe pedir revisión del fondo (ojo claro junto al fondo)");
  const coverage = palette.groups.reduce((total, g) => total + g.pixelCount, 0);
  assert(coverage === width * height, `cobertura exacta: ${coverage} px asignados de ${width * height}`);
  report.groups = palette.groups.map((g) => ({ name: g.name, hex: g.colorHex, clase: g.isBackground ? "fondo técnico" : colorClass(g.colorHex), areaPercent: +g.areaPercent.toFixed(2), piezas: g.pieceCount, tonosOrigen: g.sourceGroupCount }));

  // 2) Alternar estilos sobre la misma sesión (CA-10): detallado -> 36 tonos; volver a base_colors -> caché
  t0 = Date.now();
  const detailed = await json("POST", `${root}/detect`, { paletteId: palette.paletteId, groupingStyle: "detailed" });
  report.steps.detectDetailedMs = Date.now() - t0;
  assert(detailed.status === 200 || detailed.status === 201, `detect detailed: ${detailed.status} (${detailed.rawText})`);
  assert(detailed.body.groupingStyle === "detailed" && detailed.body.groups.length === 36, `detallado: esperaba 36 tonos, hay ${detailed.body.groups.length}`);
  assert(!detailed.body.groups.some((g) => g.isBackground), "el estilo detallado no tiene grupo técnico de fondo");
  t0 = Date.now();
  const again = await json("POST", `${root}/detect`, { paletteId: palette.paletteId, groupingStyle: "base_colors", targetFamilies: 5, groupingStrength: 0.5 });
  report.steps.detectCachedMs = Date.now() - t0;
  assert(again.body.cached === true && again.body.groupingStyle === "base_colors", "volver a base_colors con los mismos parámetros debe salir de caché");
  assert(again.body.groups.map((g) => g.groupId).join() === palette.groups.map((g) => g.groupId).join(), "caché: mismos grupos/ids");
  const retargeted = await json("POST", `${root}/detect`, { paletteId: palette.paletteId, groupingStyle: "base_colors", targetFamilies: 3, groupingStrength: 0.5 });
  assert(retargeted.body.cached === false && retargeted.body.familyCount === 3, `objetivo 3 no puede reutilizar la caché de 5 (cached=${retargeted.body.cached}, familias=${retargeted.body.familyCount})`);
  const back = await json("POST", `${root}/detect`, { paletteId: palette.paletteId, groupingStyle: "base_colors", targetFamilies: 5, groupingStrength: 0.5 });
  assert(back.body.cached === true && back.body.familyCount === 5, "volver a objetivo 5 debe salir de caché con 5 familias");

  // 3) Reabrir (GET) conserva estilo/parámetros; renombrar; confirmar
  const reopened = await json("GET", `${root}/${palette.paletteId}`);
  assert(reopened.body.groupingStyle === "base_colors" && reopened.body.targetFamilies === 5 && reopened.body.familyCount === 5, "reabrir debe conservar la configuración");
  const renamed = await json("POST", `${root}/${palette.paletteId}/rename`, { groupId: drawing[0].groupId, name: "Naranja pico y pies" });
  assert(renamed.status === 200, `rename: ${renamed.status}`);
  const confirm = await json("POST", `${root}/${palette.paletteId}/confirm`);
  assert(confirm.status === 200 && confirm.body.isConfirmed, `confirm: ${confirm.status}`);
  const locked = await json("POST", `${root}/detect`, { paletteId: palette.paletteId, groupingStyle: "detailed" });
  assert(locked.status === 409, `una paleta confirmada no admite otra detección (esperaba 409, fue ${locked.status})`);

  // 4) Capas: una por grupo (5 familias + fondo técnico) con validación raster-vector
  t0 = Date.now();
  const layerSet = await json("POST", `${root}/${palette.paletteId}/layers`);
  report.steps.layersMs = Date.now() - t0;
  assert(layerSet.status === 201, `layers: esperaba 201, fue ${layerSet.status} (${layerSet.rawText})`);
  assert(layerSet.body.layers.length === 6, `capas esperadas 6, hay ${layerSet.body.layers.length}`);
  const consolidated = await json("GET", `${root}/${palette.paletteId}/layers/consolidated`);
  assert(consolidated.status === 200, `consolidated: ${consolidated.status}`);
  report.layers = consolidated.body.layers.map((l) => ({ nombre: l.name, hex: l.colorHex, paths: l.pathCount, desajusteVector: +l.rasterValidation.ownMismatchRatio.toFixed(5), contaminacion: +l.rasterValidation.contaminationRatio.toFixed(5), dentroDeTolerancia: l.rasterValidation.ownMismatchWithinTolerance && l.rasterValidation.contaminationWithinTolerance }));

  // 5) Operaciones + mm + save + reabrir el documento
  for (const layer of layerSet.body.layers) {
    const group = confirm.body.groups.find((g) => g.groupId === layer.groupId);
    const operation = group.isExcluded ? "ignore" : "cut";
    const result = await json("POST", `${root}/${palette.paletteId}/layers/${layer.groupId}/operation`, { operation });
    assert(result.status === 200, `operation ${operation}: ${result.status}`);
  }
  const dimension = await json("POST", `/api/v1/projects/${classicProjectId}/images/${imageId}/dimensions/apply`, { sourceKind: "vector", sourceId: layerSet.body.layers[0].vectorId, widthMm: WIDTH_MM, lockAspectRatio: true });
  assert(dimension.status === 201, `dimensions: ${dimension.status} (${dimension.rawText})`);
  const save = await json("POST", "/api/v2/workspaces/save", { projectId: null, name: "E2E familias pato", classicProjectId, imageId, paletteId: palette.paletteId, paletteVersion: confirm.body.version, dimensionId: dimension.body.dimensionId, idempotencyKey: crypto.randomUUID() });
  assert(save.status === 201, `save: ${save.status} (${save.rawText})`);
  const doc = await json("GET", `/api/v2/projects/${save.body.projectId}/document`);
  assert(doc.status === 200 && doc.body.layers.length === 6, `documento reabierto: 6 capas esperadas (hay ${doc.body.layers?.length})`);
  assert(doc.body.layers.filter((l) => l.isBackground).length === 1, "el documento debe conservar el fondo técnico como capa excluida (isBackground)");
  assert(doc.body.layers.some((l) => l.name === "Naranja pico y pies"), "el nombre editado se conserva al reabrir");
  assert(doc.body.widthMm === WIDTH_MM && doc.body.viewBox === `0 0 ${width} ${height}`, "escala física y viewBox conservados");
  report.document = { projectId: save.body.projectId, layers: doc.body.layers.map((l) => ({ nombre: l.name, hex: l.colorHex, operacion: l.manufacturingOperation, fondo: l.isBackground })) };

  console.log(JSON.stringify({ ok: true, ...report }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
