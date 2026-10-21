// «Mundo» de datos reales de una cuenta para los E2E de MVP 3.1 (M3.1-S10): recorre, con el AuthClient de esa cuenta, el flujo clásico del dataset
// (upload -> preview -> threshold -> vectorize -> simplify -> check -> dimensions -> export -> paleta -> capas -> operaciones) y lo guarda como proyecto
// v2 (`workspaces/save`), y ofrece la edición del editor (`editor-save`). Es el mismo camino que mvp3_release_e2e_test.mjs, resumido, y devuelve TODOS los
// ids (clásicos y v2) para que los escenarios de aislamiento puedan golpear cada ruta con ids reales de otra cuenta.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function must(response, expected, what) {
  const okStatus = Array.isArray(expected) ? expected.includes(response.status) : response.status === expected;
  if (!okStatus) throw new Error(`${what}: esperaba ${expected}, fue ${response.status} (${response.text.slice(0, 300)})`);
  return response.body;
}

/** Sube un PNG del dataset como la cuenta de `client` (flujo clásico). */
export async function uploadFixture(client, file = "logo.png") {
  const form = new FormData();
  form.append("file", new Blob([readFileSync(join(FIXTURES_DIR, file))], { type: "image/png" }), file);
  const response = await client.request("POST", "/api/v1/projects", { body: form });
  return must(response, 201, "upload");
}

/**
 * Crea un proyecto COMPLETO de la cuenta de `client`: pipeline clásico + guardado v2 + una edición del editor (versión 2). Devuelve:
 * { name, classic: { projectId, imageId, previewId, maskId, vectorId, simplificationId, dimensionId, paletteId, groupId, layerGroupId, exportUrl },
 *   v2: { projectId, layerId, layerAssetId, thumbnailAssetId, versions, svgUrl, editorPayload, document } }
 */
export async function createFullProject(client, { name, file = "logo.png" } = {}) {
  name ??= `Proyecto E2E ${Date.now().toString(36)}`;
  const upload = await uploadFixture(client, file);
  const { projectId, imageId } = upload;
  const root = `/api/v1/projects/${projectId}/images/${imageId}`;

  const preview = must(await client.post(`${root}/preview`, { grayscale: false, contrast: 1.0, brightness: 0, denoise: 0 }), 201, "preview");
  const threshold = must(await client.post(`${root}/threshold`, { previewId: preview.previewId, value: 128, invert: true }), 201, "threshold");
  const vector = must(await client.post(`${root}/vectorize`, { maskId: threshold.maskId }), 201, "vectorize");
  const simplification = must(await client.post(`${root}/simplify/apply`, { vectorId: vector.vectorId, preset: "medium" }), 201, "simplify/apply");
  must(await client.post(`${root}/check`, { sourceKind: "simplification", sourceId: simplification.simplificationId }), 200, "check");
  const dimension = must(
    await client.post(`${root}/dimensions/apply`, { sourceKind: "simplification", sourceId: simplification.simplificationId, widthMm: 100, lockAspectRatio: true }),
    201,
    "dimensions/apply",
  );
  const exportUrl = `${root}/export?sourceKind=dimension&sourceId=${dimension.dimensionId}`;
  must(await client.get(exportUrl, { raw: true }), 200, "export clásico");

  const palette = must(await client.post(`${root}/color-palette/detect`, {}), 201, "palette/detect");
  const confirmed = must(await client.post(`${root}/color-palette/${palette.paletteId}/confirm`), 200, "palette/confirm");
  const layerSet = must(await client.post(`${root}/color-palette/${palette.paletteId}/layers`), 201, "palette/layers");
  for (const layer of layerSet.layers) {
    const group = palette.groups.find((g) => g.groupId === layer.groupId);
    must(
      await client.post(`${root}/color-palette/${palette.paletteId}/layers/${layer.groupId}/operation`, { operation: group.isExcluded ? "ignore" : "cut" }),
      200,
      "operation",
    );
  }

  const saved = must(
    await client.post("/api/v2/workspaces/save", {
      projectId: null,
      name,
      classicProjectId: projectId,
      imageId,
      paletteId: palette.paletteId,
      paletteVersion: confirmed.version,
      dimensionId: dimension.dimensionId,
      idempotencyKey: crypto.randomUUID(),
    }),
    201,
    "workspaces/save",
  );
  const v2ProjectId = saved.projectId;

  const document = must(await client.get(`/api/v2/projects/${v2ProjectId}/document`), 200, "document");
  const project = must(await client.get(`/api/v2/projects/${v2ProjectId}`), 200, "project");
  const materialLayer = document.layers.find((l) => !l.isBackground) ?? document.layers[0];

  // Edición del editor (versión 2): mueve el primer path de cada capa (igual que mvp3_release_e2e_test.mjs).
  const editorPayload = await buildEditorPayload(client, document, { dx: 7, dy: 5 });
  must(await client.post(`/api/v2/projects/${v2ProjectId}/document/editor-save`, editorPayload), 200, "editor-save");

  return {
    name,
    classic: {
      projectId,
      imageId,
      previewId: preview.previewId,
      maskId: threshold.maskId,
      vectorId: vector.vectorId,
      simplificationId: simplification.simplificationId,
      dimensionId: dimension.dimensionId,
      paletteId: palette.paletteId,
      groupId: palette.groups[0].groupId,
      layerGroupId: layerSet.layers[0].groupId,
      exportUrl,
    },
    v2: {
      projectId: v2ProjectId,
      layerId: materialLayer.id,
      layerAssetId: assetIdOf(materialLayer.svgUrl),
      thumbnailAssetId: project.thumbnailAssetId,
      svgUrl: materialLayer.svgUrl,
      versions: 2,
      editorPayload,
      document,
    },
  };
}

export function assetIdOf(svgUrl) {
  return svgUrl?.split("/").pop() ?? null;
}

const PATH_RE = /<path\b([^>]*?)\/?>/g;
const attr = (source, name) => source.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))?.[1] ?? null;

function parsePaths(svg) {
  return [...svg.matchAll(PATH_RE)].map((m) => ({ id: attr(m[1], "data-vid"), d: attr(m[1], "d"), fill: attr(m[1], "fill"), transform: attr(m[1], "transform") }));
}

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

/** Cuerpo válido de `editor-save` (MANUAL_EDIT) que desplaza el primer path de cada capa del documento; sirve también para golpear la ruta como otra cuenta. */
export async function buildEditorPayload(client, document, move = { dx: 7, dy: 5 }, origin = "MANUAL_EDIT") {
  const [, , width, height] = document.viewBox.split(/\s+/).map(Number);
  const layers = [];
  for (const layer of document.layers) {
    const svgResponse = await client.get(layer.svgUrl);
    if (svgResponse.status !== 200) throw new Error(`capa ${layer.name}: GET ${layer.svgUrl} -> ${svgResponse.status}`);
    const paths = parsePaths(svgResponse.text).map((p, i) => {
      const t = translationOf(p.transform);
      const moved = i === 0 ? move : { dx: 0, dy: 0 };
      return `<path data-vid="${p.id ?? crypto.randomUUID()}" d="${p.d}" fill="${p.fill}" transform="matrix(1 0 0 1 ${t.e + moved.dx} ${t.f + moved.dy})"/>`;
    });
    layers.push({
      groupId: layer.id,
      svgContent: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${paths.join("")}</svg>`,
      name: layer.name,
      order: layer.order,
      visible: layer.visible,
      locked: layer.locked,
      manufacturingOperation: layer.manufacturingOperation === "unassigned" ? null : layer.manufacturingOperation,
      isNew: false,
      colorHex: layer.colorHex,
      colorCoverage: layer.coverage,
      colorIsBackground: layer.isBackground,
    });
  }
  return {
    origin,
    idempotencyKey: crypto.randomUUID(),
    viewBox: document.viewBox,
    widthMm: document.widthMm,
    heightMm: document.heightMm,
    schemaVersion: document.schemaVersion,
    layers,
  };
}
