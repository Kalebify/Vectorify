import Konva from "konva";
import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { abortAwareFetch, svgResponse } from "../../test/abortableFetch";
import { readDxf, readZip } from "../../test/exportReaders";
import { fakePng } from "../../test/fakePng";
import { expectLastCommand } from "../../test/history";
import { installResizeObserver, jsonResponse, toScreen } from "../../test/workspaceFixture";
import type { DownloadableFile } from "../../lib/editor/export/browser";
import type { Rasterizer } from "../../lib/editor/export/pngExport";
import { parseEditableLayerStrict } from "../../lib/editor/objects";
import { EditorShell } from "./EditorShell";

/**
 * Recorrido del Workspace de MVP 3 (M3-S16), tramo CLIENTE, en jsdom: abrir un documento del dataset -> seleccionar / editar -> undo / redo -> Laser Check -> autosave ->
 * reapertura con lo guardado -> export SVG / DXF / PNG / layers, comprobando que lo editado, lo autoguardado, lo reabierto y lo exportado son LA MISMA geometría.
 *
 * Qué NO es: no corre en un navegador real (Konva sobre jsdom, sin canvas ni descarga reales) y el servidor es un doble con estado (guarda lo que manda el editor-save y lo
 * devuelve al reabrir); la persistencia real está en tests/e2e/mvp3_release_e2e_test.mjs. Las respuestas del servicio de piezas flotantes son las que devolvió el motor real
 * (Shapely) para esa misma geometría, capturadas en la pila release candidate.
 *
 * Documentos de 320 x 240 u con 0,5 mm por unidad (160 x 120 mm), contenedor de 800 x 600 (pantalla = documento + (240, 180)).
 */

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const IMAGE_ID = "22222222-2222-2222-2222-222222222222";
const PALETTE_ID = "33333333-3333-3333-3333-333333333333";
const LAYER_SET_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const SAVED_PROJECT_ID = "99999999-9999-9999-9999-999999999999";
const MM = 0.5;
const FRAME_HEIGHT_MM = 120;

type Point = [number, number];
interface DatasetPath {
  id: string;
  d: string;
  fill: string;
  transform?: string;
}
interface DatasetLayer {
  groupId: string;
  name: string;
  colorHex: string;
  operation: "cut" | "engrave" | "ignore";
  paths: DatasetPath[];
}
interface Dataset {
  key: string;
  label: string;
  layers: DatasetLayer[];
  /** Punto del documento donde clickear para seleccionar el primer objeto exportable. */
  selectAt: Point;
  /** Ancho esperado del objeto seleccionado en el Inspector. */
  selectedWidthMm: number;
  /** Primer subpath (en unidades, antes de cualquier desplazamiento) del primer objeto de la primera layer exportable: es el primer POLYLINE del DXF. */
  firstRing: Point[];
  /** Componentes que devolvió el motor real para esta geometría (la hoja principal va siempre). */
  floating: unknown[];
  floatingCount: number;
  laserStatus: "Ready" | "Blocking";
  /** Layers que el export incluye por defecto (visibles y no IGNORE). */
  exportableLayers: string[];
}

const pathTag = (path: DatasetPath) => `<path data-vid="${path.id}" d="${path.d}" fill="${path.fill}"${path.transform ? ` transform="${path.transform}"` : ""}/>`;
const layerSvg = (layer: DatasetLayer) => `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240">${layer.paths.map(pathTag).join("")}</svg>`;
const sheet = (bounds: number[]) => ({ id: 0, kind: "principal", depth: 0, parent: null, polygon: null, area: null, bounds, subjects: [] });
const ring = (...points: Point[]) => [...points, points[0]];

const DATASET: Dataset[] = [
  {
    key: "holes",
    label: "diseño con holes (dona)",
    layers: [{ groupId: "a0000001-0000-0000-0000-000000000001", name: "Negro", colorHex: "#000000", operation: "cut", paths: [{ id: "dona", d: "M40 40 H200 V200 H40 Z M80 80 V160 H160 V80 Z", fill: "#000000" }] }],
    selectAt: [60, 60],
    selectedWidthMm: 80,
    firstRing: [[40, 40], [200, 40], [200, 200], [40, 200]],
    // En modo plantilla el hueco de la dona es material rodeado de corte: el motor real lo reporta como isla (falso Blocking conocido, docs/MVP3_RELEASE.md).
    floating: [sheet([40, 40, 200, 200]), { id: 1, kind: "floating", depth: 1, parent: 0, polygon: { type: "polygon", coordinates: [ring([80, 80], [160, 80], [160, 160], [80, 160])] }, area: 6400, bounds: [80, 80, 160, 160], subjects: [0] }],
    floatingCount: 1,
    laserStatus: "Blocking",
    exportableLayers: ["Negro"],
  },
  {
    key: "floating",
    label: "diseño con piezas flotantes (marco con isla)",
    layers: [
      {
        groupId: "a0000002-0000-0000-0000-000000000001",
        name: "Negro",
        colorHex: "#000000",
        operation: "cut",
        paths: [
          { id: "marco", d: "M20 20 H140 V120 H20 Z M40 40 V100 H120 V40 Z", fill: "#000000" },
          { id: "isla", d: "M60 55 H100 V85 H60 Z", fill: "#000000" },
        ],
      },
    ],
    selectAt: [30, 30],
    selectedWidthMm: 60,
    firstRing: [[20, 20], [140, 20], [140, 120], [20, 120]],
    floating: [
      sheet([20, 20, 140, 120]),
      { id: 1, kind: "floating", depth: 1, parent: 0, polygon: { type: "polygon", coordinates: [ring([40, 40], [120, 40], [120, 100], [40, 100]), ring([60, 55], [60, 85], [100, 85], [100, 55])] }, area: 3600, bounds: [40, 40, 120, 100], subjects: [0, 1] },
    ],
    floatingCount: 1,
    laserStatus: "Blocking",
    exportableLayers: ["Negro"],
  },
  {
    key: "multicolor",
    label: "logo multicolor (fondo IGNORE + 3 colores, CUT y ENGRAVE)",
    layers: [
      { groupId: "a0000003-0000-0000-0000-000000000001", name: "Fondo", colorHex: "#ffffff", operation: "ignore", paths: [{ id: "bg", d: "M0 0 H320 V240 H0 Z", fill: "#ffffff" }] },
      { groupId: "a0000003-0000-0000-0000-000000000002", name: "Rojo", colorHex: "#dc2828", operation: "cut", paths: [{ id: "hex", d: "M110 40 L140 40 L155 66 L140 92 L110 92 L95 66 Z", fill: "#dc2828" }] },
      { groupId: "a0000003-0000-0000-0000-000000000003", name: "Azul", colorHex: "#1e5ac8", operation: "engrave", paths: [{ id: "cuadro", d: "M200 40 H280 V120 H200 Z", fill: "#1e5ac8" }] },
      { groupId: "a0000003-0000-0000-0000-000000000004", name: "Verde", colorHex: "#28a03c", operation: "cut", paths: [{ id: "tri", d: "M160 140 L100 220 L220 220 Z", fill: "#28a03c" }] },
    ],
    selectAt: [125, 66],
    selectedWidthMm: 30,
    firstRing: [[110, 40], [140, 40], [155, 66], [140, 92], [110, 92], [95, 66]],
    floating: [sheet([95, 40, 220, 220])],
    floatingCount: 0,
    laserStatus: "Ready",
    exportableLayers: ["Rojo", "Azul", "Verde"],
  },
  {
    key: "text",
    label: "texto trazado (glifos con transform, como los deja el vectorizador)",
    layers: [
      {
        groupId: "a0000004-0000-0000-0000-000000000001",
        name: "Negro",
        colorHex: "#000000",
        operation: "cut",
        paths: [
          { id: "g-v", d: "M0 0 L10 0 L20 30 L30 0 L40 0 L25 40 L15 40 Z", fill: "#000000", transform: "translate(20,100)" },
          { id: "g-e", d: "M0 0 H30 V8 H10 V16 H25 V24 H10 V32 H30 V40 H0 Z", fill: "#000000", transform: "translate(70,100)" },
          { id: "g-t", d: "M0 0 H40 V8 H25 V40 H15 V8 H0 Z", fill: "#000000", transform: "translate(110,100)" },
          { id: "g-i", d: "M0 0 H10 V40 H0 Z", fill: "#000000", transform: "translate(160,100)" },
        ],
      },
    ],
    selectAt: [25, 102],
    selectedWidthMm: 20,
    firstRing: [[20, 100], [30, 100], [40, 130], [50, 100], [60, 100], [45, 140], [35, 140]],
    floating: [sheet([20, 100, 170, 140])],
    floatingCount: 0,
    laserStatus: "Ready",
    exportableLayers: ["Negro"],
  },
];

// ---- Servidor simulado con estado (proyecto YA guardado): reabrir devuelve lo que escribió el editor-save ----

interface ServerLayer {
  groupId: string;
  name: string;
  colorHex: string;
  order: number;
  visible: boolean;
  locked: boolean;
  operation: string;
}

interface EditorSaveBody {
  origin: string;
  viewBox: string;
  widthMm: number;
  heightMm: number;
  layers: Array<{ groupId: string; svgContent: string; name: string; order: number; visible: boolean; locked: boolean; manufacturingOperation: string | null; colorHex: string }>;
}

function createServer(dataset: Dataset) {
  const layers: ServerLayer[] = dataset.layers.map((layer, order) => ({ groupId: layer.groupId, name: layer.name, colorHex: layer.colorHex, order, visible: true, locked: false, operation: layer.operation }));
  const assets = new Map<string, string>(dataset.layers.map((layer) => [layer.groupId, layerSvg(layer)]));
  const editorSaves: EditorSaveBody[] = [];
  const floatingCalls: Array<Record<string, unknown>> = [];
  const validation = { ownMismatchRatio: 0, ownMismatchTolerance: 0.02, ownMismatchWithinTolerance: true, contaminationRatio: 0, contaminationTolerance: 0.02, contaminationWithinTolerance: true, warnings: [] };
  const sorted = () => [...layers].sort((a, b) => a.order - b.order);
  const pathCount = (groupId: string) => (assets.get(groupId)?.match(/<path\b/g) ?? []).length;
  const savedLayer = (layer: ServerLayer) => ({
    id: layer.groupId,
    name: layer.name,
    order: layer.order,
    visible: layer.visible,
    locked: layer.locked,
    manufacturingOperation: layer.operation,
    colorHex: layer.colorHex,
    coverage: 50,
    isBackground: false,
    svgAssetId: null,
    svgUrl: `/assets/${layer.groupId}`,
    pathCount: pathCount(layer.groupId),
  });
  const versions = () => {
    const list = [{ versionNumber: 1, origin: "VECTORIZE", createdAt: "2026-01-01T09:00:00Z", widthMm: 160, heightMm: 120, viewBox: "0 0 320 240", schemaVersion: 1 }];
    editorSaves.forEach((body, index) => list.unshift({ versionNumber: index + 2, origin: body.origin, createdAt: "2026-01-01T10:00:00Z", widthMm: 160, heightMm: 120, viewBox: "0 0 320 240", schemaVersion: 1 }));
    return list;
  };

  const fetchMock = abortAwareFetch(async (url, init) => {
    const method = init?.method ?? "GET";
    if (method === "POST" && url.endsWith("/document/editor-save")) {
      const body = JSON.parse(String(init?.body)) as EditorSaveBody;
      editorSaves.push(body);
      // El servidor persiste lo que manda el editor: SVG y metadata por capa (las capas que no llegan dejan de existir).
      layers.length = 0;
      for (const layer of body.layers) {
        assets.set(layer.groupId, layer.svgContent);
        layers.push({ groupId: layer.groupId, name: layer.name, colorHex: layer.colorHex, order: layer.order, visible: layer.visible, locked: layer.locked, operation: layer.manufacturingOperation ?? "unassigned" });
      }
      return jsonResponse({ projectId: SAVED_PROJECT_ID, versionNumber: 1 + editorSaves.length, versionId: "55555555-5555-5555-5555-555555555555", createdAt: "2026-01-01T10:00:00Z" });
    }
    if (method === "POST" && url.endsWith("/api/v2/geometry/floating")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      floatingCalls.push(body);
      return jsonResponse({ mode: body.mode, tolerance: body.tolerance, components: dataset.floating, floatingCount: dataset.floatingCount, mainCount: 1, discarded: 0 });
    }
    if (method !== "GET") return jsonResponse({ code: "not_found", message: "No existe." }, 404);

    if (url.endsWith(`/api/v2/projects/${SAVED_PROJECT_ID}/versions`)) return jsonResponse(versions());
    if (url.includes(`/api/v2/projects/${SAVED_PROJECT_ID}/document`)) {
      return jsonResponse({ projectId: SAVED_PROJECT_ID, schemaVersion: 1, widthMm: 160, heightMm: 120, viewBox: "0 0 320 240", versionNumber: versions()[0].versionNumber, createdAt: "2026-01-01T00:00:00Z", layers: sorted().map(savedLayer) });
    }
    const asset = /\/assets\/([0-9a-f-]+)$/.exec(url);
    if (asset && assets.has(asset[1])) return svgResponse(assets.get(asset[1])!);
    if (url.includes("/layers/consolidated")) {
      return jsonResponse({
        projectId: PROJECT_ID,
        imageId: IMAGE_ID,
        layerSetId: LAYER_SET_ID,
        version: 1,
        paletteId: PALETTE_ID,
        paletteVersion: 2,
        sourceWidthPx: 320,
        sourceHeightPx: 240,
        layers: sorted().map((layer) => ({ id: layer.groupId, name: layer.name, colorHex: layer.colorHex, fill: layer.colorHex, vectorId: layer.groupId, svgUrl: `/assets/${layer.groupId}`, pathCount: pathCount(layer.groupId), componentCount: null, manufacturingOperation: layer.operation, visible: layer.visible, locked: layer.locked, order: layer.order, rasterValidation: validation })),
      });
    }
    if (url.includes("/layers/operations")) {
      return jsonResponse({ projectId: PROJECT_ID, imageId: IMAGE_ID, paletteId: PALETTE_ID, paletteVersion: 2, layerSetId: LAYER_SET_ID, version: 1, operations: sorted().map((layer) => ({ groupId: layer.groupId, name: layer.name, colorHex: layer.colorHex, operation: layer.operation })), summary: { cutCount: 0, engraveCount: 0, ignoreCount: 0, unassignedCount: 0, totalCount: layers.length } });
    }
    if (/\/layers$/.test(url)) {
      return jsonResponse({ projectId: PROJECT_ID, imageId: IMAGE_ID, layerSetId: LAYER_SET_ID, version: 1, paletteId: PALETTE_ID, paletteVersion: 2, sourceWidthPx: 320, sourceHeightPx: 240, layers: sorted().map((layer) => ({ groupId: layer.groupId, name: layer.name, colorHex: layer.colorHex, areaPercent: 50, hasPartialAlpha: false, vectorId: layer.groupId, svgUrl: `/assets/${layer.groupId}` })), cached: true });
    }
    if (url.endsWith(`/color-palette/${PALETTE_ID}`)) {
      return jsonResponse({ projectId: PROJECT_ID, imageId: IMAGE_ID, paletteId: PALETTE_ID, version: 2, tolerance: 24, maxColors: null, tinyAreaRatio: 0.01, sourceWidthPx: 320, sourceHeightPx: 240, transparentPercent: 0, groups: layers.map((layer) => ({ groupId: layer.groupId, name: layer.name, colorHex: layer.colorHex, rgb: { r: 0, g: 0, b: 0 }, pixelCount: 100, areaPercent: 50, hasPartialAlpha: false, isExcluded: false, maskUrl: "/mask", isMerged: false })), previewUrl: "/preview", isConfirmed: true, cached: false });
    }
    return jsonResponse({ code: "not_found", message: "No existe." }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, editorSaves, floatingCalls };
}

type Server = ReturnType<typeof createServer>;

function exportSeams() {
  const download = vi.fn<(file: DownloadableFile) => void>();
  const rasterize = vi.fn<Rasterizer>(async (_svg, width, height) => fakePng(width, height));
  return { download, rasterize, yieldToEventLoop: async () => {} };
}
type Seams = ReturnType<typeof exportSeams>;

async function openWorkspace(seams: Seams, strict = false) {
  const shell = (
    <EditorShell projectId={PROJECT_ID} imageId={IMAGE_ID} paletteId={PALETTE_ID} projectName="mi-diseño.svg" dimensionWidthMm={160} savedProjectId={SAVED_PROJECT_ID} onClose={vi.fn()} exportSeams={seams} />
  );
  const utils = render(strict ? <StrictMode>{shell}</StrictMode> : shell);
  const canvas = await screen.findByRole("application");
  await waitFor(() => expect(canvasPaths().length).toBeGreaterThan(0));
  return { ...utils, canvas };
}

// ---- Consultas ----

const stage = () => Konva.stages[Konva.stages.length - 1];
const canvasNodes = () => stage().getLayers()[0].find("Path") as Konva.Path[];
/** Lo que ve el usuario en el canvas: d + posición (translate) de cada objeto, en orden de pintado. */
const canvasPaths = () => canvasNodes().map((node) => ({ d: node.data(), x: node.x(), y: node.y() }));
const selectedNodes = () => (stage().findOne("Transformer") as Konva.Transformer).nodes() as Konva.Path[];
const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement;
const undoButton = () => screen.getByRole("button", { name: /^Deshacer/ });
const redoButton = () => screen.getByRole("button", { name: /^Rehacer/ });
const GEOMETRY_DIRTY = "Cambios de geometría sin guardar";
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

function clickAt(canvas: HTMLElement, [x, y]: Point) {
  const point = toScreen(x, y);
  fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, ...point });
  fireEvent.pointerUp(canvas, { pointerId: 1, ...point });
}

/** Geometría de un SVG exportado/guardado en la misma forma que `canvasPaths` (d + translate), ordenada igual que el canvas. */
function svgObjects(svg: string) {
  return (parseEditableLayerStrict(svg, "doc", "#000") ?? []).map((object) => ({ id: object.id, d: object.d, x: object.matrix.e, y: object.matrix.f }));
}
const withoutId = (objects: Array<{ id: string; d: string; x: number; y: number }>) => objects.map(({ d, x, y }) => ({ d, x, y }));
function expectSamePaths(actual: Array<{ d: string; x: number; y: number }>, expected: Array<{ d: string; x: number; y: number }>) {
  expect(actual.map((p) => p.d)).toEqual(expected.map((p) => p.d));
  actual.forEach((p, index) => {
    expect(p.x).toBeCloseTo(expected[index].x, 6);
    expect(p.y).toBeCloseTo(expected[index].y, 6);
  });
}

// ---- Export ----

const exportButton = () => screen.getByRole("button", { name: /^Exportar el documento/ });
const dialog = () => screen.getByRole("dialog", { name: "Exportar" });
const inDialog = () => within(dialog());
const radio = (name: RegExp) => inDialog().getByRole("radio", { name });
const submit = () => inDialog().getByRole("button", { name: /^(Exportar|Exportar de todos modos)$/ });

async function openExportDialog(server: Server, dataset: Dataset) {
  const callsBefore = server.floatingCalls.length;
  fireEvent.click(exportButton());
  await screen.findByRole("dialog", { name: "Exportar" });
  await waitFor(() => expect(screen.getByTestId("export-laser-status")).not.toHaveAttribute("data-state", "unverified"));
  expect(screen.getByTestId("export-laser-status")).toHaveTextContent(dataset.laserStatus);
  return callsBefore;
}

/** Exporta con lo que esté elegido; con Laser Check Blocking exige (y da) la confirmación explícita, como lo haría una persona. */
function runExport(dataset: Dataset) {
  if (dataset.laserStatus === "Blocking") {
    expect(submit()).toHaveTextContent("Exportar de todos modos");
    expect(submit()).toBeDisabled();
    fireEvent.click(inDialog().getByRole("checkbox", { name: /Entiendo que el Laser Check/ }));
  }
  fireEvent.click(submit());
}

async function nextDownload(seams: Seams, count: number): Promise<DownloadableFile> {
  await waitFor(() => expect(seams.download).toHaveBeenCalledTimes(count));
  return seams.download.mock.calls[count - 1][0];
}

describe.each(DATASET)("Recorrido del Workspace — $label", (dataset) => {
  beforeEach(() => installResizeObserver());
  afterEach(() => vi.unstubAllGlobals());

  it(
    "abrir -> seleccionar/editar -> undo/redo -> Laser Check -> autosave -> reabrir -> export SVG / DXF / PNG / layers, con la misma geometría en todos los pasos",
    { timeout: 40_000 },
    async () => {
      const server = createServer(dataset);
      const first = exportSeams();

      // 1) Abrir el documento del dataset: todas las capas y objetos, con el color y el nombre que tenían.
      const opened = await openWorkspace(first);
      const flat = dataset.layers.flatMap((layer) => layer.paths.map((path) => ({ layer: layer.name, id: path.id })));
      const original = canvasPaths();
      expect(original.map((p) => p.d)).toEqual(dataset.layers.flatMap((layer) => layer.paths.map((p) => p.d)));
      const layerNames = within(screen.getByRole("list", { name: /Capas del documento/ })).getAllByLabelText(/^Nombre de la capa/).map((input) => (input as HTMLInputElement).value);
      expect(layerNames).toEqual(dataset.layers.map((layer) => layer.name));
      expect(undoButton()).toBeDisabled();
      expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();

      // 2) Seleccionar: el Inspector muestra la medida real en mm (unidades x 0,5).
      clickAt(opened.canvas, dataset.selectAt);
      await screen.findByRole("heading", { name: "Objeto" });
      expect(selectedNodes()).toHaveLength(1);
      expect(field("Ancho (mm)")).toHaveValue(String(dataset.selectedWidthMm));
      const selectedIndex = canvasNodes().indexOf(selectedNodes()[0]);
      expect(flat[selectedIndex].layer).toBe(dataset.exportableLayers[0]);
      expect(flat[selectedIndex].id).toBe(dataset.layers.find((layer) => layer.name === dataset.exportableLayers[0])!.paths[0].id);

      // 3) Editar (empujar 3 veces = UN comando) -> undo -> redo, exactos.
      for (let i = 0; i < 3; i += 1) fireEvent.keyDown(opened.canvas, { key: "ArrowRight" });
      await waitFor(() => expect(canvasPaths()[selectedIndex].x).toBeGreaterThan(original[selectedIndex].x));
      expectLastCommand("object.nudge");
      const edited = canvasPaths();
      const shiftX = edited[selectedIndex].x - original[selectedIndex].x;
      const shiftY = edited[selectedIndex].y - original[selectedIndex].y;
      expect(shiftX).toBeGreaterThan(0);
      expect(edited.filter((_, index) => index !== selectedIndex)).toEqual(original.filter((_, index) => index !== selectedIndex)); // solo se movió el seleccionado
      expect(screen.getByText(GEOMETRY_DIRTY)).toBeInTheDocument();

      fireEvent.click(undoButton());
      await waitFor(() => expect(canvasPaths()).toEqual(original));
      fireEvent.click(redoButton());
      await waitFor(() => expect(canvasPaths()).toEqual(edited));

      // 4) Laser Check sobre lo EDITADO (no sobre lo guardado): el servicio de flotantes recibe la geometría movida.
      fireEvent.click(screen.getByRole("button", { name: "Laser Check" }));
      await waitFor(() => expect(server.floatingCalls).toHaveLength(1));
      await waitFor(() => expect(screen.getByTestId("laser-check-status")).toHaveTextContent(dataset.laserStatus));
      const subjects = server.floatingCalls[0].subjects as Array<{ coordinates: number[][][] }>;
      expect(subjects[0].coordinates[0][0][0]).toBeCloseTo(dataset.firstRing[0][0] + shiftX, 6);
      expect(subjects[0].coordinates[0][0][1]).toBeCloseTo(dataset.firstRing[0][1] + shiftY, 6);
      fireEvent.keyDown(screen.getByRole("region", { name: "Laser Check" }), { key: "Escape" });
      expect(screen.queryByRole("region", { name: "Laser Check" })).not.toBeInTheDocument();
      expect(canvasPaths()).toEqual(edited); // analizar no modifica nada

      // 5) Autosave: 3 s después de la última edición, sin tocar el botón; lo que viaja es la geometría editada.
      await waitFor(() => expect(server.editorSaves).toHaveLength(1), { timeout: 10_000 });
      const [saved] = server.editorSaves;
      expect(saved.origin).toBe("AUTOSAVE");
      expect(saved).toMatchObject({ viewBox: "0 0 320 240", widthMm: 160, heightMm: 120 });
      expect(saved.layers.map((layer) => layer.name)).toEqual(dataset.layers.map((layer) => layer.name));
      expect(saved.layers.map((layer) => layer.colorHex)).toEqual(dataset.layers.map((layer) => layer.colorHex));
      expect(saved.layers.map((layer) => layer.manufacturingOperation)).toEqual(dataset.layers.map((layer) => layer.operation));
      expectSamePaths(saved.layers.flatMap((layer) => withoutId(svgObjects(layer.svgContent))), edited);
      await waitFor(() => expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument());
      expect(await screen.findByText("Geometría guardada")).toBeInTheDocument();
      expect(undoButton()).toBeEnabled(); // el historial sigue después de guardar

      // 6) Reabrir con lo guardado (shell NUEVO sobre el mismo servidor): misma geometría, mismos nombres, versión 2 como actual.
      opened.unmount();
      const second = exportSeams();
      const reopened = await openWorkspace(second);
      expectSamePaths(canvasPaths(), edited);
      expect(within(screen.getByRole("list", { name: /Capas del documento/ })).getAllByLabelText(/^Nombre de la capa/).map((input) => (input as HTMLInputElement).value)).toEqual(dataset.layers.map((layer) => layer.name));
      expect(undoButton()).toBeDisabled(); // el historial de sesión no se persiste (limitación documentada)
      expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /Versiones/ }));
      const versionItems = within(await screen.findByRole("list", { name: "Lista de versiones" })).getAllByRole("listitem");
      expect(versionItems).toHaveLength(2);
      expect(versionItems[0]).toHaveTextContent("v2");
      expect(versionItems[0]).toHaveTextContent("(actual)");
      expect(versionItems[0]).toHaveTextContent("Guardado automático");
      expect(within(versionItems[1]).getByRole("button", { name: /Restaurar versión 1/ })).toBeEnabled();
      expect(reopened.canvas).toBeInTheDocument();

      // 7) Export desde lo reabierto: SVG (mm, viewBox y la geometría editada, reabrible con el parser del editor).
      await openExportDialog(server, dataset);
      expect(screen.getByTestId("export-dimensions")).toHaveTextContent("Dimensiones: 160 × 120 mm.");
      const rows = within(inDialog().getByRole("list", { name: "Layers del documento" })).getAllByRole("listitem");
      expect(rows).toHaveLength(dataset.layers.length);
      for (const layer of dataset.layers) {
        const included = dataset.exportableLayers.includes(layer.name);
        const row = rows.find((candidate) => candidate.textContent?.includes(layer.name));
        expect(row, `fila de la layer ${layer.name}`).toBeDefined();
        if (!included) expect(row).toHaveTextContent(/no se exporta/);
      }
      const exportedObjects = canvasPaths().filter((_, index) => dataset.exportableLayers.includes(flat[index].layer));

      runExport(dataset);
      const svgFile = await nextDownload(second, 1);
      expect(svgFile.name).toBe("mi-diseno_documento.svg");
      expect(svgFile.mime).toBe("image/svg+xml");
      const svg = text(svgFile.data);
      expect(svg).toContain('width="160mm" height="120mm" viewBox="0 0 320 240"');
      expectSamePaths(svgObjects(svg), exportedObjects);
      const exportedFills = [...svg.matchAll(/fill="([^"]+)"/g)].map((m) => m[1]);
      const expectedFills = dataset.layers.filter((layer) => dataset.exportableLayers.includes(layer.name)).flatMap((layer) => layer.paths.map((p) => p.fill));
      expect(exportedFills).toEqual(expectedFills); // ningún color se pierde ni cambia al exportar

      // DXF: ASCII R12 en mm, Y invertido; el primer POLYLINE es el primer subpath del primer objeto exportable CON el desplazamiento editado.
      fireEvent.click(radio(/DXF/));
      fireEvent.click(submit());
      const dxfFile = await nextDownload(second, 2);
      expect(dxfFile.name).toBe("mi-diseno_documento.dxf");
      const dxf = readDxf(text(dxfFile.data));
      expect(dxf.header["$INSUNITS"]).toEqual(["70:4"]);
      expect(dxf.otherEntities).toEqual([]);
      expect(dxf.polylines[0].vertices).toHaveLength(dataset.firstRing.length);
      dxf.polylines[0].vertices.forEach((vertex, index) => {
        expect(vertex.x).toBeCloseTo((dataset.firstRing[index][0] + shiftX) * MM, 6);
        expect(vertex.y).toBeCloseTo(FRAME_HEIGHT_MM - (dataset.firstRing[index][1] + shiftY) * MM, 6);
      });
      const subpathCount = exportedObjects.reduce((total, object) => total + (object.d.match(/M/g) ?? []).length, 0);
      expect(dxf.polylines).toHaveLength(subpathCount);

      // PNG: el rasterizador recibe el SVG con la geometría editada; ancho por defecto 1 024 px y alto por relación de aspecto.
      fireEvent.click(radio(/PNG/));
      fireEvent.click(submit());
      const pngFile = await nextDownload(second, 3);
      expect(pngFile.name).toBe("mi-diseno_documento.png");
      expect(second.rasterize).toHaveBeenCalledTimes(1);
      const [rasterSvg, rasterWidth, rasterHeight] = second.rasterize.mock.calls[0];
      expect([rasterWidth, rasterHeight]).toEqual([1024, 768]);
      expectSamePaths(svgObjects(rasterSvg), exportedObjects);

      // Layers: un SVG por layer exportable en un ZIP, mismo marco, y entre todos la misma geometría que el SVG único.
      fireEvent.click(radio(/SVG/));
      fireEvent.click(radio(/Un archivo por layer/));
      fireEvent.click(submit());
      const zipFile = await nextDownload(second, 4);
      let layerSvgs: string[];
      if (dataset.exportableLayers.length === 1) {
        // Con una sola layer incluida no hay nada que empaquetar: sale el SVG de esa layer, con nombre proyecto_layer_operación.
        expect(zipFile.name).toBe("mi-diseno_negro_cut.svg");
        layerSvgs = [text(zipFile.data)];
      } else {
        expect(zipFile.name).toBe("mi-diseno_layers.zip");
        const entries = readZip(zipFile.data);
        expect(entries.map((entry) => entry.name)).toEqual(dataset.exportableLayers.map((name) => `mi-diseno_${name.toLowerCase()}_${dataset.layers.find((layer) => layer.name === name)!.operation}.svg`));
        expect(entries.every((entry) => entry.crcActual === entry.crcDeclared)).toBe(true);
        layerSvgs = entries.map((entry) => text(entry.data));
      }
      layerSvgs.forEach((layerFile) => expect(layerFile).toContain('width="160mm" height="120mm" viewBox="0 0 320 240"'));
      expectSamePaths(layerSvgs.flatMap(svgObjects), exportedObjects);

      // Exportar nunca es un comando ni ensucia el documento.
      expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();
      expect(server.editorSaves).toHaveLength(1);
    },
  );
});

