// E2E HTTP del release candidate de MVP 3 (M3-S16). Mismo criterio que
// tests/e2e/full_pipeline_e2e_test.mjs: fetch real contra la Web API real, sin
// mocks y sin arrancar la pila (la asume corriendo). Por cada imagen del
// dataset de tests/e2e/fixtures/ recorre:
//
//   upload -> preview/threshold/vectorize -> paleta (detect/confirm) -> capas ->
//   operaciones + mm -> POST /api/v2/workspaces/save (v1) -> GET document ->
//   piezas flotantes (servicio de S11/S14, motor real) ->
//   POST .../document/editor-save (v2: SVG de capas editados + capa nueva) ->
//   reapertura (GET document + /versions) -> AUTOSAVE (v3: capa quitada y otra
//   renombrada) -> restore de v2 (v4) y de v1 (v5) -> comparación sin pérdida.
//
// "Sin pérdida" significa: mismos colores (colorHex de cada capa y fill de cada
// path), mismas capas (id, nombre, orden, operación, visibilidad, bloqueo,
// coverage, pathCount), misma escala física (widthMm/heightMm/viewBox) y los
// mismos BYTES de SVG por capa. El export de S15 es del cliente: no hay endpoint
// que probar acá, se cubre en el recorrido jsdom (EditorShell.release.test.tsx)
// y en el checklist manual de docs/MVP3_RELEASE.md.
//
// Uso (con la pila ya corriendo):
//   BACKEND_URL=http://localhost:5180 node tests/e2e/mvp3_release_e2e_test.mjs
//   (opcional) E2E_ONLY=holes.png,logo.png para acotar el dataset.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { enableAuthFromEnv } from "./lib/authClient.mjs";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const FIXTURES_DIR = join(ROOT, "tests", "e2e", "fixtures");
const API = (process.env.BACKEND_URL || "http://localhost:5080").replace(/\/$/, "");

// Opt-in (M3.1-S10): con E2E_AUTH=1 abre sesión (cookie jar + cabecera anti-CSRF) para correr contra una API en Auth:Mode=Authenticated. Sin E2E_AUTH no hace nada.
await enableAuthFromEnv(API);
const WIDTH_MM = 150;
const MOVE = { dx: 7, dy: 5 };
const NEW_LAYER_COLOR = "#ff00ff";

// `colors` = grupos NO excluidos esperados de la paleta (el fondo, excluido por
// el detector, también es una capa). `palette` = parámetros que usaría una
// persona para limpiar el antialiasing/ruido en el panel de colores. `svgImport`
// no existe: el producto no importa SVG (ver docs/MVP3_RELEASE.md).
const DATASET = [
  { file: "logo.png", label: "Logo B/N", denoise: 0, colors: 1 },
  { file: "multicolor.png", label: "Logo multicolor (3 colores)", denoise: 0, colors: 3 },
  { file: "illustration.png", label: "Ilustración (5 colores)", denoise: 0, colors: 5 },
  { file: "text.png", label: "Texto", denoise: 0, colors: 1, palette: { tinyAreaRatio: 0.01 } },
  { file: "holes.png", label: "Diseño con holes", denoise: 0, colors: 1, floating: "some" },
  { file: "floating.png", label: "Diseño con piezas flotantes", denoise: 0, colors: 1, floating: "some" },
  { file: "antialias.png", label: "Antialiasing (maxColors=3)", denoise: 0, colors: 2, palette: { maxColors: 3 }, reportDefaultPalette: true },
  { file: "noise.png", label: "Ruido (denoise + maxColors=3)", denoise: 4, colors: 2, palette: { maxColors: 3 } },
  { file: "silhouette.png", label: "Silueta", denoise: 0, colors: 1 },
  { file: "problematic.png", label: "Formas congruentes", denoise: 0, colors: 1, floating: "none" },
];

function assert(condition, message) {
  if (!condition) throw new Error(`FALLÓ: ${message}`);
}

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, `${message} -- esperado ${e}, recibido ${a}`);
}

async function json(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  return { status: response.status, body: parsed, rawText: text };
}

async function upload(bytes, filename) {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "image/png" }), filename);
  const response = await fetch(`${API}/api/v1/projects`, { method: "POST", body: form });
  return { status: response.status, body: await response.json() };
}

async function fetchText(url) {
  const response = await fetch(`${API}${url}`);
  assert(response.status === 200, `GET ${url}: esperaba 200, fue ${response.status}`);
  return response.text();
}

// ---- SVG de capas: mismo formato que serializeEditableLayer del editor ----

const PATH_RE = /<path\b([^>]*?)\/?>/g;

function attr(source, name) {
  const match = source.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
  return match ? match[1] : null;
}

function parsePaths(svg) {
  return [...svg.matchAll(PATH_RE)].map((m) => ({
    id: attr(m[1], "data-vid"),
    d: attr(m[1], "d"),
    fill: attr(m[1], "fill"),
    transform: attr(m[1], "transform"),
  }));
}

/** Traslación (e, f) de un transform `translate(x,y)` o `matrix(a b c d e f)`. */
function translationOf(transform) {
  if (!transform) return { e: 0, f: 0 };
  const translate = transform.match(/translate\(\s*([-\d.eE]+)[,\s]+([-\d.eE]+)\s*\)/);
  if (translate) return { e: Number(translate[1]), f: Number(translate[2]) };
  const matrix = transform.match(/matrix\(\s*([^)]+)\)/);
  if (matrix) {
    const parts = matrix[1].split(/[\s,]+/).map(Number);
    return { e: parts[4], f: parts[5] };
  }
  throw new Error(`transform no reconocido: ${transform}`);
}

/** Anillos [x, y] de un path M/L/Z (la salida del vectorizador) con su translate; null si trae curvas (no es el caso de VTracer en modo polygon). */
function ringsOf(path) {
  const { e, f } = translationOf(path.transform);
  const rings = [];
  for (const [, command, args] of path.d.matchAll(/([MLZ])([^MLZ]*)/g)) {
    if (command === "Z") continue;
    const [x, y] = args.trim().split(/[\s,]+/).map(Number);
    if (command === "M") rings.push([]);
    rings[rings.length - 1].push([x + e, y + f]);
  }
  // Igual que el editor (planFloating): un subpath con menos de 3 vértices no es un área y se descarta.
  return /[^MLZ\d\s,.eE-]/.test(path.d) ? null : rings.filter((ring) => ring.length >= 3).map((ring) => [...ring, ring[0]]);
}

function serializeLayer(paths, width, height) {
  const body = paths
    .map((p) => {
      const transform = p.matrix ? ` transform="matrix(${p.matrix.join(" ")})"` : "";
      return `<path data-vid="${p.id}" d="${p.d}" fill="${p.fill}"${transform}/>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
}

// ---- Captura de un documento (para comparar versiones sin pérdida) ----

async function captureDocument(url, projectId) {
  const response = await json("GET", url);
  assert(response.status === 200, `GET ${url}: esperaba 200, fue ${response.status} (${response.rawText})`);
  const doc = response.body;
  const layers = [];
  for (const layer of doc.layers) {
    assert(layer.svgUrl, `capa ${layer.name}: sin svgUrl`);
    assert(layer.svgUrl.startsWith(`/api/v2/projects/${projectId}/assets/`), `capa ${layer.name}: svgUrl inesperada ${layer.svgUrl}`);
    layers.push({ ...layer, svg: await fetchText(layer.svgUrl) });
  }
  return { ...doc, layers };
}

/** Lo que tiene que ser idéntico entre dos capturas (se ignora número de versión, fecha y ids de asset). */
function comparable(capture) {
  return {
    widthMm: capture.widthMm,
    heightMm: capture.heightMm,
    viewBox: capture.viewBox,
    layers: capture.layers.map((l) => ({
      id: l.id,
      name: l.name,
      order: l.order,
      visible: l.visible,
      locked: l.locked,
      op: l.manufacturingOperation,
      colorHex: l.colorHex.toLowerCase(),
      coverage: l.coverage,
      isBackground: l.isBackground,
      pathCount: l.pathCount,
      svg: l.svg,
    })),
  };
}

function assertSameDocument(context, actual, expected) {
  const a = comparable(actual);
  const e = comparable(expected);
  assertEqual({ w: a.widthMm, h: a.heightMm, vb: a.viewBox }, { w: e.widthMm, h: e.heightMm, vb: e.viewBox }, `${context}: escala física (mm/viewBox)`);
  assertEqual(
    a.layers.map((l) => l.colorHex),
    e.layers.map((l) => l.colorHex),
    `${context}: colores de las capas`,
  );
  assertEqual(
    a.layers.map((l) => l.id),
    e.layers.map((l) => l.id),
    `${context}: ids/orden de capas`,
  );
  for (let i = 0; i < e.layers.length; i++) {
    const { svg: aSvg, ...aRest } = a.layers[i];
    const { svg: eSvg, ...eRest } = e.layers[i];
    assertEqual(aRest, eRest, `${context}: metadata de la capa ${e.layers[i].name}`);
    assert(aSvg === eSvg, `${context}: el SVG de la capa ${e.layers[i].name} cambió (${aSvg.length} vs ${eSvg.length} bytes)`);
  }
}

async function runImage(fixture, report) {
  const start = Date.now();
  const steps = {};
  const time = async (name, fn) => {
    const t0 = Date.now();
    const result = await fn();
    steps[name] = Date.now() - t0;
    return result;
  };
  const info = {};

  // 1) Upload
  const bytes = readFileSync(join(FIXTURES_DIR, fixture.file));
  const uploaded = await time("upload", () => upload(bytes, fixture.file));
  assert(uploaded.status === 201, `upload: esperaba 201, fue ${uploaded.status}`);
  const { projectId: classicProjectId, imageId, width: imageWidth, height: imageHeight } = uploaded.body;
  const root = `/api/v1/projects/${classicProjectId}/images/${imageId}`;

  // 2) Preprocess + threshold + vectorize (etapa raster de MVP 1)
  const preview = await time("preview", () =>
    json("POST", `${root}/preview`, { grayscale: false, contrast: 1.0, brightness: 0, denoise: fixture.denoise }),
  );
  assert(preview.status === 201, `preview: esperaba 201, fue ${preview.status} (${preview.rawText})`);
  const threshold = await time("threshold", () =>
    json("POST", `${root}/threshold`, { previewId: preview.body.previewId, value: 128, invert: true }),
  );
  assert(threshold.status === 201, `threshold: esperaba 201, fue ${threshold.status} (${threshold.rawText})`);
  assert(!threshold.body.metrics.isNearEmpty, "threshold: la máscara quedó casi vacía");
  const vectorize = await time("vectorize", () => json("POST", `${root}/vectorize`, { maskId: threshold.body.maskId }));
  assert(vectorize.status === 201, `vectorize: esperaba 201, fue ${vectorize.status} (${vectorize.rawText})`);
  assert(vectorize.body.metrics.pathCount > 0, "vectorize: pathCount debería ser > 0");

  // 3) Paleta: detect + confirm (+ conteo con parámetros por defecto, si el caso lo pide)
  if (fixture.reportDefaultPalette) {
    const byDefault = await json("POST", `${root}/color-palette/detect`, {});
    assert(byDefault.status === 201, `detect (default): esperaba 201, fue ${byDefault.status}`);
    info.defaultPaletteGroups = byDefault.body.groups.length;
  }
  const detect = await time("paletteDetect", () => json("POST", `${root}/color-palette/detect`, fixture.palette ?? {}));
  assert(detect.status === 201, `detect: esperaba 201, fue ${detect.status} (${detect.rawText})`);
  const palette = detect.body;
  const kept = palette.groups.filter((g) => !g.isExcluded);
  assert(
    kept.length === fixture.colors,
    `paleta: esperaba ${fixture.colors} colores no excluidos, hay ${kept.length} (${palette.groups.map((g) => g.colorHex).join(", ")})`,
  );
  const confirm = await time("paletteConfirm", () => json("POST", `${root}/color-palette/${palette.paletteId}/confirm`));
  assert(confirm.status === 200 && confirm.body.isConfirmed, `confirm: esperaba 200 confirmado, fue ${confirm.status}`);

  // 4) Capas (una por color de la paleta)
  const layerSet = await time("layers", () => json("POST", `${root}/color-palette/${palette.paletteId}/layers`));
  assert(layerSet.status === 201, `layers: esperaba 201, fue ${layerSet.status} (${layerSet.rawText})`);
  const paletteHexes = palette.groups.map((g) => g.colorHex.toLowerCase());
  assertEqual(layerSet.body.layers.map((l) => l.colorHex.toLowerCase()), paletteHexes, "layers: una capa por color de la paleta, en su orden");

  // 5) Operaciones de fabricación (cut para el material, ignore para el fondo) + dimensiones físicas
  await time("operations", async () => {
    for (const layer of layerSet.body.layers) {
      const group = palette.groups.find((g) => g.groupId === layer.groupId);
      const operation = group.isExcluded ? "ignore" : "cut";
      const result = await json("POST", `${root}/color-palette/${palette.paletteId}/layers/${layer.groupId}/operation`, { operation });
      assert(result.status === 200, `operation ${operation}: esperaba 200, fue ${result.status} (${result.rawText})`);
    }
  });
  const dimension = await time("dimensions", () =>
    json("POST", `${root}/dimensions/apply`, {
      sourceKind: "vector",
      sourceId: layerSet.body.layers[0].vectorId,
      widthMm: WIDTH_MM,
      lockAspectRatio: true,
    }),
  );
  assert(dimension.status === 201, `dimensions: esperaba 201, fue ${dimension.status} (${dimension.rawText})`);
  const expectedHeightMm = (WIDTH_MM * imageHeight) / imageWidth;

  // 6) Save v2 (primer guardado -> crea el proyecto, versión 1)
  const save = await time("save", () =>
    json("POST", "/api/v2/workspaces/save", {
      projectId: null,
      name: `E2E MVP3 ${fixture.file}`,
      classicProjectId,
      imageId,
      paletteId: palette.paletteId,
      paletteVersion: confirm.body.version,
      dimensionId: dimension.body.dimensionId,
      idempotencyKey: crypto.randomUUID(),
    }),
  );
  assert(save.status === 201, `save: esperaba 201, fue ${save.status} (${save.rawText})`);
  assert(save.body.versionNumber === 1, `save: la primera versión debe ser 1, fue ${save.body.versionNumber}`);
  const projectId = save.body.projectId;

  // 7) Abrir lo guardado (v1): colores/capas/mm contra lo que tenía el pipeline
  const v1 = await time("openV1", () => captureDocument(`/api/v2/projects/${projectId}/document`, projectId));
  assert(v1.versionNumber === 1, `document: versión actual esperada 1, fue ${v1.versionNumber}`);
  assertEqual(v1.layers.map((l) => l.colorHex.toLowerCase()), paletteHexes, "document v1: colores de las capas");
  assert(v1.widthMm === WIDTH_MM, `document v1: widthMm esperado ${WIDTH_MM}, fue ${v1.widthMm}`);
  assert(Math.abs(v1.heightMm - expectedHeightMm) < 1e-6, `document v1: heightMm esperado ${expectedHeightMm}, fue ${v1.heightMm}`);
  assertEqual(v1.viewBox, `0 0 ${imageWidth} ${imageHeight}`, "document v1: viewBox");
  for (const layer of v1.layers) {
    const paths = parsePaths(layer.svg);
    assert(paths.length > 0, `document v1: la capa ${layer.name} no tiene paths`);
    assert(layer.pathCount === paths.length, `document v1: pathCount de ${layer.name} (${layer.pathCount}) != paths del SVG (${paths.length})`);
    const expectedOp = layer.isBackground ? "ignore" : "cut";
    assert(layer.manufacturingOperation === expectedOp, `document v1: operación de ${layer.name} esperada ${expectedOp}, fue ${layer.manufacturingOperation}`);
  }

  // 7b) Laser Check de S14 contra el motor real: piezas flotantes (modo plantilla) de las capas CUT guardadas
  const cutSubjects = v1.layers
    .filter((l) => l.manufacturingOperation === "cut")
    .flatMap((l) => parsePaths(l.svg).map(ringsOf))
    .map((rings) => (rings === null ? null : { type: "polygon", coordinates: rings }))
    .filter((subject) => subject === null || subject.coordinates.length > 0);
  assert(!cutSubjects.includes(null), "floating: un path de las capas CUT trae curvas (no se puede aplanar en este script)");
  const floating = await time("floating", () => json("POST", "/api/v2/geometry/floating", { subjects: cutSubjects, mode: "stencil", tolerance: 0.02 }));
  assert(floating.status === 200, `floating: esperaba 200, fue ${floating.status} (${floating.rawText})`);
  assert(floating.body.components.length === floating.body.floatingCount + floating.body.mainCount, "floating: componentes incoherentes con floatingCount/mainCount");
  info.floatingCount = floating.body.floatingCount;
  if (fixture.floating === "some") assert(floating.body.floatingCount >= 1, "floating: este diseño tiene piezas que quedan flotantes y el motor no encontró ninguna");
  if (fixture.floating === "none") assert(floating.body.floatingCount === 0, `floating: no debería haber flotantes (hay ${floating.body.floatingCount})`);

  // 8) editor-save (v2, MANUAL_EDIT): mueve el primer path de cada capa, agrega un path a la primera capa de
  // material y una capa nueva entera -- lo que hace una persona en el editor.
  const mmPerUnit = v1.widthMm / imageWidth;
  const sent = []; // lo que mandamos por capa: { groupId, svg, paths }
  const materialIndex = v1.layers.findIndex((l) => !l.isBackground);
  const editedLayers = v1.layers.map((layer, index) => {
    const original = parsePaths(layer.svg);
    const paths = original.map((p, i) => {
      const t = translationOf(p.transform);
      const moved = i === 0 ? { dx: MOVE.dx, dy: MOVE.dy } : { dx: 0, dy: 0 };
      return {
        id: crypto.randomUUID(),
        d: p.d,
        fill: p.fill,
        matrix: [1, 0, 0, 1, t.e + moved.dx, t.f + moved.dy],
        originalTranslation: t,
      };
    });
    if (index === materialIndex) {
      paths.push({ id: crypto.randomUUID(), d: "M10,10 L30,10 L30,30 L10,30 Z", fill: layer.colorHex, matrix: null, originalTranslation: null });
    }
    const svg = serializeLayer(paths, imageWidth, imageHeight);
    sent.push({ groupId: layer.id, svg, paths });
    return {
      groupId: layer.id,
      svgContent: svg,
      name: layer.name,
      order: layer.order,
      visible: layer.visible,
      locked: layer.locked,
      manufacturingOperation: layer.manufacturingOperation === "unassigned" ? null : layer.manufacturingOperation,
      isNew: false,
      colorHex: layer.colorHex,
      colorCoverage: layer.coverage,
      colorIsBackground: layer.isBackground,
    };
  });
  const newLayerId = crypto.randomUUID();
  const newLayerPath = { id: crypto.randomUUID(), d: "M40,40 L90,40 L90,70 L40,70 Z", fill: NEW_LAYER_COLOR, matrix: null };
  const newLayerSvg = serializeLayer([newLayerPath], imageWidth, imageHeight);
  editedLayers.push({
    groupId: newLayerId,
    svgContent: newLayerSvg,
    name: "Capa nueva E2E",
    order: v1.layers.length,
    visible: true,
    locked: false,
    manufacturingOperation: "engrave",
    isNew: true,
    colorHex: NEW_LAYER_COLOR,
    colorCoverage: 0,
    colorIsBackground: false,
  });
  const editorPayload = (origin, layers, extra = {}) => ({
    origin,
    idempotencyKey: crypto.randomUUID(),
    viewBox: v1.viewBox,
    widthMm: v1.widthMm,
    heightMm: v1.heightMm,
    schemaVersion: v1.schemaVersion,
    layers,
    ...extra,
  });
  const manualPayload = editorPayload("MANUAL_EDIT", editedLayers);
  const editorSave = await time("editorSave", () => json("POST", `/api/v2/projects/${projectId}/document/editor-save`, manualPayload));
  assert(editorSave.status === 200, `editor-save: esperaba 200, fue ${editorSave.status} (${editorSave.rawText})`);
  assert(editorSave.body.versionNumber === 2, `editor-save: versión esperada 2, fue ${editorSave.body.versionNumber}`);
  assert(editorSave.body.versionId, "editor-save: falta versionId");

  // Replay con la misma idempotencyKey: 200 con la misma versión, sin crear otra
  const replay = await json("POST", `/api/v2/projects/${projectId}/document/editor-save`, manualPayload);
  assert(replay.status === 200 && replay.body.versionNumber === 2, `editor-save replay: esperaba 200 v2, fue ${replay.status} v${replay.body?.versionNumber}`);

  // 9) Reapertura (v2): lo guardado es exactamente lo enviado
  const v2 = await time("reopenV2", () => captureDocument(`/api/v2/projects/${projectId}/document`, projectId));
  assert(v2.versionNumber === 2, `reapertura: versión actual esperada 2, fue ${v2.versionNumber}`);
  assertEqual(
    v2.layers.map((l) => l.colorHex.toLowerCase()),
    [...paletteHexes, NEW_LAYER_COLOR],
    "reapertura: colores (los de la paleta + la capa nueva)",
  );
  assertEqual({ w: v2.widthMm, h: v2.heightMm, vb: v2.viewBox }, { w: v1.widthMm, h: v1.heightMm, vb: v1.viewBox }, "reapertura: escala física (mm/viewBox)");
  for (let i = 0; i < sent.length; i++) {
    const reopened = v2.layers[i];
    assert(reopened.svg === sent[i].svg, `reapertura: el SVG de la capa ${reopened.name} no es el enviado`);
    assertEqual(reopened.manufacturingOperation, v1.layers[i].manufacturingOperation, `reapertura: operación de ${reopened.name}`);
    const paths = parsePaths(reopened.svg);
    assertEqual(paths.map((p) => p.id), sent[i].paths.map((p) => p.id), `reapertura: ids de objeto (data-vid) de ${reopened.name}`);
    assert(
      paths.every((p) => p.fill.toLowerCase() === reopened.colorHex.toLowerCase()),
      `reapertura: algún path de ${reopened.name} perdió su color (${reopened.colorHex})`,
    );
    assert(reopened.pathCount === paths.length, `reapertura: pathCount de ${reopened.name} (${reopened.pathCount}) != paths (${paths.length})`);
    const expectedPaths = parsePaths(v1.layers[i].svg).length + (i === materialIndex ? 1 : 0);
    assert(paths.length === expectedPaths, `reapertura: ${reopened.name} tiene ${paths.length} paths, esperaba ${expectedPaths} (se perdió/duplicó geometría)`);
    // el movimiento de 7x5 unidades equivale a 7*mmPerUnit x 5*mmPerUnit mm
    const before = translationOf(parsePaths(v1.layers[i].svg)[0].transform);
    const after = translationOf(paths[0].transform);
    assert(
      Math.abs((after.e - before.e) * mmPerUnit - MOVE.dx * mmPerUnit) < 1e-9 && Math.abs((after.f - before.f) * mmPerUnit - MOVE.dy * mmPerUnit) < 1e-9,
      `reapertura: el desplazamiento del primer path de ${reopened.name} no es ${MOVE.dx * mmPerUnit} x ${MOVE.dy * mmPerUnit} mm`,
    );
  }
  const reopenedNew = v2.layers[v2.layers.length - 1];
  assert(reopenedNew.id === newLayerId, "reapertura: la capa nueva no conserva su groupId");
  assert(reopenedNew.name === "Capa nueva E2E" && reopenedNew.manufacturingOperation === "engrave", "reapertura: la capa nueva perdió nombre/operación");
  assert(reopenedNew.svg === newLayerSvg && reopenedNew.pathCount === 1, "reapertura: la capa nueva perdió su geometría");

  const versionsV2 = await json("GET", `/api/v2/projects/${projectId}/versions`);
  assert(versionsV2.status === 200, `versions: esperaba 200, fue ${versionsV2.status}`);
  assertEqual(versionsV2.body.map((v) => [v.versionNumber, v.origin]), [[2, "MANUAL_EDIT"], [1, "MANUAL_EDIT"]], "versions tras editor-save");
  assert(versionsV2.body.every((v) => v.widthMm === v1.widthMm && v.heightMm === v1.heightMm), "versions: mm distintos entre versiones");

  // La v1 histórica sigue siendo la original (las versiones son inmutables)
  const v1Again = await time("openV1Again", () => captureDocument(`/api/v2/projects/${projectId}/versions/1`, projectId));
  assertSameDocument("versión 1 tras editar", v1Again, v1);

  // 10) Errores recuperables: payload inválido -> 400 con mensaje, sin crear versión
  const bad = await json("POST", `/api/v2/projects/${projectId}/document/editor-save`, { ...editorPayload("AUTOSAVE", editedLayers), viewBox: "no-valido" });
  assert(bad.status === 400, `editor-save inválido: esperaba 400, fue ${bad.status}`);
  assert(bad.body?.code === "invalid_parameters" && typeof bad.body.message === "string" && bad.body.message.length > 10, `editor-save inválido: error sin código/mensaje comprensible (${bad.rawText})`);
  const missing = await json("POST", `/api/v2/projects/${crypto.randomUUID()}/document/editor-save`, editorPayload("AUTOSAVE", editedLayers));
  assert(missing.status === 404 && missing.body?.message, `editor-save a un proyecto inexistente: esperaba 404 con mensaje, fue ${missing.status}`);
  const stillTwo = await json("GET", `/api/v2/projects/${projectId}/versions`);
  assert(stillTwo.body.length === 2, `un error de validación creó una versión (hay ${stillTwo.body.length})`);

  // 11) AUTOSAVE (v3): se quita la capa nueva y se renombra la primera capa de material
  const keep = editedLayers.filter((l) => l.groupId !== newLayerId).map((l, i) => (i === materialIndex ? { ...l, name: "Renombrada E2E" } : l));
  const autosave = await time("autosave", () =>
    json("POST", `/api/v2/projects/${projectId}/document/editor-save`, editorPayload("AUTOSAVE", keep, { removedLayerGroupIds: [newLayerId] })),
  );
  assert(autosave.status === 200 && autosave.body.versionNumber === 3, `autosave: esperaba 200 v3, fue ${autosave.status} v${autosave.body?.versionNumber} (${autosave.rawText})`);
  const v3 = await captureDocument(`/api/v2/projects/${projectId}/document`, projectId);
  assert(v3.layers.length === v1.layers.length, `autosave: esperaba ${v1.layers.length} capas, hay ${v3.layers.length}`);
  assert(v3.layers[materialIndex].name === "Renombrada E2E", "autosave: el renombrado no persistió");
  assert(!v3.layers.some((l) => l.id === newLayerId), "autosave: la capa quitada sigue en el documento");

  // 12) Restore de v2 (v4): vuelve la capa nueva y los SVG editados; la historia no se borra
  const restoreV2 = await time("restoreV2", () => json("POST", `/api/v2/projects/${projectId}/versions/2/restore`));
  assert(restoreV2.status === 200 && restoreV2.body.versionNumber === 4, `restore v2: esperaba 200 v4, fue ${restoreV2.status} v${restoreV2.body?.versionNumber} (${restoreV2.rawText})`);
  const afterRestoreV2 = await captureDocument(`/api/v2/projects/${projectId}/document`, projectId);
  assertSameDocument("restore de v2", afterRestoreV2, v2);

  // 13) Restore de v1 (v5): el documento vuelve a ser el original, sin pérdida de colores/capas/mm
  const restoreV1 = await time("restoreV1", () => json("POST", `/api/v2/projects/${projectId}/versions/1/restore`));
  assert(restoreV1.status === 200 && restoreV1.body.versionNumber === 5, `restore v1: esperaba 200 v5, fue ${restoreV1.status} v${restoreV1.body?.versionNumber}`);
  const afterRestoreV1 = await captureDocument(`/api/v2/projects/${projectId}/document`, projectId);
  assertSameDocument("restore de v1", afterRestoreV1, v1);

  const finalVersions = await json("GET", `/api/v2/projects/${projectId}/versions`);
  assertEqual(
    finalVersions.body.map((v) => [v.versionNumber, v.origin]),
    [[5, "RESTORE"], [4, "RESTORE"], [3, "AUTOSAVE"], [2, "MANUAL_EDIT"], [1, "MANUAL_EDIT"]],
    "versions al final",
  );
  // La historia sigue abriéndose tal cual: v2 (con la capa nueva) no cambió con los restores
  assertSameDocument("versión 2 tras los restores", await captureDocument(`/api/v2/projects/${projectId}/versions/2`, projectId), v2);

  report.push({
    fixture: fixture.file,
    label: fixture.label,
    totalMs: Date.now() - start,
    steps,
    layers: v1.layers.length,
    colors: kept.length,
    paths: v1.layers.reduce((sum, l) => sum + l.pathCount, 0),
    mm: `${v1.widthMm} x ${v1.heightMm.toFixed(3)}`,
    versions: finalVersions.body.length,
    defaultPaletteGroups: info.defaultPaletteGroups,
    floatingCount: info.floatingCount,
  });
}

function printReport(report) {
  console.log("\n=== Reporte E2E MVP 3 (M3-S16) ===\n");
  for (const r of report) {
    console.log(`- ${r.fixture} (${r.label})`);
    console.log(`  tiempo total: ${r.totalMs} ms`);
    console.log(`  pasos (ms): ${Object.entries(r.steps).map(([step, ms]) => `${step}=${ms}`).join(", ")}`);
    console.log(`  capas=${r.layers} (colores no excluidos=${r.colors}), paths=${r.paths}, escala=${r.mm} mm, versiones finales=${r.versions}`);
    console.log(`  laser check (stencil, motor real): piezas flotantes=${r.floatingCount}`);
    if (r.defaultPaletteGroups !== undefined) {
      console.log(`  hallazgo: con los parámetros de paleta por defecto salen ${r.defaultPaletteGroups} grupos (con maxColors=3: ${r.colors + 1})`);
    }
    console.log("");
  }
  console.log(`Tiempo total de la corrida (${report.length} imágenes): ${report.reduce((sum, r) => sum + r.totalMs, 0)} ms`);
}

async function main() {
  const only = (process.env.E2E_ONLY || "").split(",").map((s) => s.trim()).filter(Boolean);
  const dataset = only.length > 0 ? DATASET.filter((f) => only.includes(f.file)) : DATASET;
  console.log(`E2E MVP 3 (M3-S16) contra ${API} -- ${dataset.length} imágenes.`);
  const report = [];
  const failures = [];
  for (const fixture of dataset) {
    try {
      await runImage(fixture, report);
      console.log(`OK: ${fixture.file} (${fixture.label})`);
    } catch (error) {
      failures.push({ fixture: fixture.file, error });
      console.error(`FALLO en ${fixture.file}: ${error.message}`);
    }
  }
  printReport(report);
  if (failures.length > 0) {
    console.error(`\n${failures.length}/${dataset.length} imágenes fallaron:`);
    for (const failure of failures) console.error(`- ${failure.fixture}: ${failure.error.message}`);
    process.exit(1);
  }
  console.log(`\nOK: ${dataset.length}/${dataset.length} imágenes completaron el E2E de MVP 3.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
