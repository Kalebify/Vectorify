import Konva from "konva";
import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, vi } from "vitest";
import { EditorShell } from "../components/editor/EditorShell";
import { abortAwareFetch, svgResponse } from "./abortableFetch";

/**
 * Fixture compartida de los tests de integración de Draw y Erase (M3-S04) sobre el Workspace completo. Documento 320 x 240 u con
 * `dimensionWidthMm = 160` (0,5 mm por unidad). Con escala 1 y un contenedor de 800 x 600: pantalla = documento + (240, 180).
 *
 * Capas: A «Rojo» (#ff0000: r1 = 0..40 x 0..40, r2 = 0..40 x 100..140), B «Azul» (#0000ff: b1 = 100..140 x 100..140) y C «Líneas»
 * (#00aa00: ln1 = línea abierta y = 20 de x 200 a 260, `fill: none`, trazo de 0,5 u). El `fetch` respeta AbortSignal y cuenta las
 * llamadas al servicio de geometría (`geometryCalls`), que el test responde con `geometry`.
 */

export const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
export const IMAGE_ID = "22222222-2222-2222-2222-222222222222";
export const PALETTE_ID = "33333333-3333-3333-3333-333333333333";
export const GROUP_A_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
export const GROUP_B_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
export const GROUP_C_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const VECTOR_A_ID = "a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1";
const VECTOR_B_ID = "b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b1b1";
const VECTOR_C_ID = "c1c1c1c1-c1c1-c1c1-c1c1-c1c1c1c1c1c1";
const LAYER_SET_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

export const R1 = "M0 0 H40 V40 H0 Z";
export const R2 = "M0 100 H40 V140 H0 Z";
export const B1 = "M100 100 H140 V140 H100 Z";
export const LN1 = "M200 20 L260 20";

const SVG_A = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><path data-vid="r1" d="${R1}" fill="#ff0000"/><path data-vid="r2" d="${R2}" fill="#ff0000"/></svg>`;
const SVG_B = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><path data-vid="b1" d="${B1}" fill="#0000ff"/></svg>`;
const SVG_C = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><path data-vid="ln1" d="${LN1}" fill="none" stroke="#00aa00" stroke-width="0.5"/></svg>`;

const GROUPS = [
  { groupId: GROUP_A_ID, vectorId: VECTOR_A_ID, name: "Rojo", colorHex: "#ff0000", areaPercent: 40, paths: 2, svg: SVG_A },
  { groupId: GROUP_B_ID, vectorId: VECTOR_B_ID, name: "Azul", colorHex: "#0000ff", areaPercent: 30, paths: 1, svg: SVG_B },
  { groupId: GROUP_C_ID, vectorId: VECTOR_C_ID, name: "Líneas", colorHex: "#00aa00", areaPercent: 30, paths: 1, svg: SVG_C },
];

class ImmediateResizeObserver {
  callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe() {
    this.callback([{ contentRect: { width: 800, height: 600 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve() {}
  disconnect() {}
}

export function installResizeObserver() {
  vi.stubGlobal("ResizeObserver", ImmediateResizeObserver);
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export interface WorkspaceOptions {
  lockedA?: boolean;
  hiddenB?: boolean;
  lockedB?: boolean;
  /** Responde al servicio de geometría; el cuerpo ya viene parseado. Puede devolver una promesa que el test resuelve a mano. */
  geometry?: (body: Record<string, unknown>) => Response | Promise<Response>;
}

function layerState(groupId: string, options: WorkspaceOptions) {
  return {
    visible: groupId === GROUP_B_ID ? !options.hiddenB : true,
    locked: groupId === GROUP_A_ID ? Boolean(options.lockedA) : groupId === GROUP_B_ID ? Boolean(options.lockedB) : false,
  };
}

export function installWorkspaceFetch(options: WorkspaceOptions = {}) {
  const validation = { ownMismatchRatio: 0, ownMismatchTolerance: 0.02, ownMismatchWithinTolerance: true, contaminationRatio: 0, contaminationTolerance: 0.02, contaminationWithinTolerance: true, warnings: [] };
  const geometryCalls: Array<Record<string, unknown>> = [];

  const fetchMock = abortAwareFetch((url, init) => {
    const method = init?.method ?? "GET";
    if (method === "POST" && url.endsWith("/api/v2/geometry/boolean")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      geometryCalls.push(body);
      return options.geometry ? options.geometry(body) : jsonResponse({ code: "processing_error", message: "sin handler" }, 500);
    }
    if (method !== "GET") return jsonResponse({ entries: GROUPS.map((group, index) => ({ groupId: group.groupId, order: index, visible: true, locked: false, name: null })) });
    for (const group of GROUPS) {
      if (url.endsWith(`/vectors/${group.vectorId}`)) return svgResponse(group.svg);
    }
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
        layers: GROUPS.map((group, index) => ({
          id: group.groupId,
          name: group.name,
          colorHex: group.colorHex,
          fill: group.colorHex,
          vectorId: group.vectorId,
          svgUrl: `/vectors/${group.vectorId}`,
          pathCount: group.paths,
          componentCount: null,
          manufacturingOperation: "unassigned",
          ...layerState(group.groupId, options),
          order: index,
          rasterValidation: validation,
        })),
      });
    }
    if (url.includes("/layers/operations")) {
      return jsonResponse({ projectId: PROJECT_ID, imageId: IMAGE_ID, paletteId: PALETTE_ID, paletteVersion: 2, layerSetId: LAYER_SET_ID, version: 1, operations: [], summary: { cutCount: 0, engraveCount: 0, ignoreCount: 0, unassignedCount: 3, totalCount: 3 } });
    }
    if (/\/layers$/.test(url)) {
      return jsonResponse({
        projectId: PROJECT_ID,
        imageId: IMAGE_ID,
        layerSetId: LAYER_SET_ID,
        version: 1,
        paletteId: PALETTE_ID,
        paletteVersion: 2,
        sourceWidthPx: 320,
        sourceHeightPx: 240,
        layers: GROUPS.map((group) => ({ groupId: group.groupId, name: group.name, colorHex: group.colorHex, areaPercent: group.areaPercent, hasPartialAlpha: false, vectorId: group.vectorId, svgUrl: `/vectors/${group.vectorId}` })),
        cached: true,
      });
    }
    if (url.endsWith(`/color-palette/${PALETTE_ID}`)) {
      return jsonResponse({
        projectId: PROJECT_ID,
        imageId: IMAGE_ID,
        paletteId: PALETTE_ID,
        version: 2,
        tolerance: 24,
        maxColors: null,
        tinyAreaRatio: 0.01,
        sourceWidthPx: 320,
        sourceHeightPx: 240,
        transparentPercent: 0,
        groups: GROUPS.map((group) => ({ groupId: group.groupId, name: group.name, colorHex: group.colorHex, rgb: { r: 0, g: 0, b: 0 }, pixelCount: 100, areaPercent: group.areaPercent, hasPartialAlpha: false, isExcluded: false, maskUrl: "/mask", isMerged: false })),
        previewUrl: "/preview",
        isConfirmed: true,
        cached: false,
      });
    }
    return jsonResponse({ code: "not_found", message: "No existe." }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return Object.assign(fetchMock, { geometryCalls });
}

export async function renderWorkspace({ strict = false, minPaths = 4 }: { strict?: boolean; minPaths?: number } = {}) {
  const shell = <EditorShell projectId={PROJECT_ID} imageId={IMAGE_ID} paletteId={PALETTE_ID} projectName="mi-diseño.svg" dimensionWidthMm={160} savedProjectId={null} onClose={vi.fn()} />;
  const utils = render(strict ? <StrictMode>{shell}</StrictMode> : shell);
  const canvas = await screen.findByRole("application");
  await waitFor(() => expect(Konva.stages[Konva.stages.length - 1]?.find("Path").length).toBeGreaterThanOrEqual(minPaths));
  return { ...utils, canvas };
}

// ---- Consultas comunes ----

export const stage = () => Konva.stages[Konva.stages.length - 1];
export const documentPaths = () => stage().getLayers()[0].find("Path") as Konva.Path[];
export const pathByData = (d: string) => documentPaths().find((node) => node.data() === d);
export const pathData = () => documentPaths().map((node) => node.data());
export const tool = (name: RegExp) => screen.getByRole("button", { name });
export const undoButton = () => screen.getByRole("button", { name: /^Deshacer/ });
export const redoButton = () => screen.getByRole("button", { name: /^Rehacer/ });
export const layersList = () => screen.getByRole("list", { name: /Capas del documento/ });
export const layerRows = () => within(layersList()).getAllByRole("listitem");
export const layerNames = () => within(layersList()).getAllByLabelText(/^Nombre de la capa/).map((input) => (input as HTMLInputElement).value);
export const selectLayerRow = (name: string) => fireEvent.click(screen.getByRole("button", { name: `Seleccionar la capa ${name}` }));
export const GEOMETRY_DIRTY = "Cambios de geometría sin guardar";

/** Convierte coordenadas de documento a las de pantalla del contenedor de 800 x 600 con escala 1 (documento 320 x 240). */
export const toScreen = (x: number, y: number) => ({ clientX: x + 240, clientY: y + 180 });

export const drawSurface = () => screen.getByTestId("draw-surface");
export const eraseSurface = () => screen.getByTestId("erase-surface");

export function pointerDown(target: HTMLElement, x: number, y: number, pointerId = 1) {
  fireEvent.pointerDown(target, { pointerId, button: 0, ...toScreen(x, y) });
}
export function pointerMove(target: HTMLElement, x: number, y: number, pointerId = 1) {
  fireEvent.pointerMove(target, { pointerId, ...toScreen(x, y) });
}
export function pointerUp(target: HTMLElement, x: number, y: number, pointerId = 1) {
  fireEvent.pointerUp(target, { pointerId, ...toScreen(x, y) });
}

/** Un click (down + up) en el punto de documento (x, y). */
export function clickAt(target: HTMLElement, x: number, y: number) {
  pointerDown(target, x, y);
  pointerUp(target, x, y);
}

/** Arrastre completo por los puntos de documento dados. */
export function dragAlong(target: HTMLElement, points: Array<[number, number]>) {
  const [[x0, y0], ...rest] = points;
  pointerDown(target, x0, y0);
  for (const [x, y] of rest) pointerMove(target, x, y);
  const [lastX, lastY] = points[points.length - 1];
  pointerUp(target, lastX, lastY);
}

/** Respuesta del servicio de geometría con el contrato camelCase de la Web API. */
export function geometryResponse(operation: string, results: Array<{ changed: boolean; geometries: unknown[] }>, scope: "per_subject" | "combined" = "per_subject"): Response {
  return jsonResponse({
    operation,
    scope,
    tolerance: 0.02,
    pieceCount: results.reduce((total, item) => total + item.geometries.length, 0),
    results: results.map((item, index) => ({ subjectIndex: scope === "per_subject" ? index : null, ...item })),
  });
}

/** Pieza poligonal de un rectángulo [x0, x1] x [y0, y1] (anillo cerrado). */
export function rectPiece(x0: number, y0: number, x1: number, y1: number) {
  return { type: "polygon", coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] };
}
