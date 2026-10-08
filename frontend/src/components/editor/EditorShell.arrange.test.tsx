import Konva from "konva";
import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { abortAwareFetch, svgResponse } from "../../test/abortableFetch";
import { EditorShell } from "./EditorShell";

/**
 * Integración de M3-S07 en el Workspace completo: Alinear (6 modos, referencia Selección / Documento), Distribuir y Z-order (adelante, atrás,
 * al frente, al fondo, SIEMPRE dentro de la capa) por botones y por teclado (Ctrl y Cmd), un comando por operación, undo/redo con la selección
 * conservada, bloqueos, campos de texto, StrictMode. Todos los `fetch` respetan AbortSignal (`abortAwareFetch`).
 */

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const IMAGE_ID = "22222222-2222-2222-2222-222222222222";
const PALETTE_ID = "33333333-3333-3333-3333-333333333333";
const GROUP_A_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const GROUP_B_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const VECTOR_A_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const VECTOR_B_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const LAYER_SET_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

// 160 mm sobre 320 u => 0,5 mm/u. Capa Rojo: r1 (0..40) y r2 (20..60, arriba de r1). Capa Azul: b1 (100..140) y b2 (120..160, arriba de b1).
const R1 = "M0 0 H40 V40 H0 Z";
const R2 = "M20 20 H60 V60 H20 Z";
const B1 = "M100 100 H140 V140 H100 Z";
const B2 = "M120 120 H160 V160 H120 Z";
const SVG_A = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><path data-vid="r1" d="${R1}" fill="#ff0000"/><path data-vid="r2" d="${R2}" fill="#ff0000"/></svg>`;
const SVG_B = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><path data-vid="b1" d="${B1}" fill="#0000ff"/><path data-vid="b2" d="${B2}" fill="#0000ff"/></svg>`;
const NAME_OF: Record<string, string> = { [R1]: "r1", [R2]: "r2", [B1]: "b1", [B2]: "b2" };

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function paletteResponse() {
  return {
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
    groups: [
      { groupId: GROUP_A_ID, name: "Rojo", colorHex: "#ff0000", rgb: { r: 255, g: 0, b: 0 }, pixelCount: 100, areaPercent: 60, hasPartialAlpha: false, isExcluded: false, maskUrl: "/mask/a", isMerged: false },
      { groupId: GROUP_B_ID, name: "Azul", colorHex: "#0000ff", rgb: { r: 0, g: 0, b: 255 }, pixelCount: 60, areaPercent: 40, hasPartialAlpha: false, isExcluded: false, maskUrl: "/mask/b", isMerged: false },
    ],
    previewUrl: "/preview",
    isConfirmed: true,
    cached: false,
  };
}

function layerSetResponse() {
  return {
    projectId: PROJECT_ID,
    imageId: IMAGE_ID,
    layerSetId: LAYER_SET_ID,
    version: 1,
    paletteId: PALETTE_ID,
    paletteVersion: 2,
    sourceWidthPx: 320,
    sourceHeightPx: 240,
    layers: [
      { groupId: GROUP_A_ID, name: "Rojo", colorHex: "#ff0000", areaPercent: 60, hasPartialAlpha: false, vectorId: VECTOR_A_ID, svgUrl: `/vectors/${VECTOR_A_ID}` },
      { groupId: GROUP_B_ID, name: "Azul", colorHex: "#0000ff", areaPercent: 40, hasPartialAlpha: false, vectorId: VECTOR_B_ID, svgUrl: `/vectors/${VECTOR_B_ID}` },
    ],
    cached: true,
  };
}

function consolidatedResponse(options: { lockedA?: boolean } = {}) {
  const validation = { ownMismatchRatio: 0, ownMismatchTolerance: 0.02, ownMismatchWithinTolerance: true, contaminationRatio: 0, contaminationTolerance: 0.02, contaminationWithinTolerance: true, warnings: [] };
  return {
    projectId: PROJECT_ID,
    imageId: IMAGE_ID,
    layerSetId: LAYER_SET_ID,
    version: 1,
    paletteId: PALETTE_ID,
    paletteVersion: 2,
    sourceWidthPx: 320,
    sourceHeightPx: 240,
    layers: [
      { id: GROUP_A_ID, name: "Rojo", colorHex: "#ff0000", fill: "#ff0000", vectorId: VECTOR_A_ID, svgUrl: `/vectors/${VECTOR_A_ID}`, pathCount: 2, componentCount: 1, manufacturingOperation: "cut", visible: true, locked: options.lockedA === true, order: 0, rasterValidation: validation },
      { id: GROUP_B_ID, name: "Azul", colorHex: "#0000ff", fill: "#0000ff", vectorId: VECTOR_B_ID, svgUrl: `/vectors/${VECTOR_B_ID}`, pathCount: 2, componentCount: null, manufacturingOperation: "unassigned", visible: true, locked: false, order: 1, rasterValidation: validation },
    ],
  };
}

function installStagingFetch(options: { lockedA?: boolean } = {}) {
  const fetchMock = abortAwareFetch((url) => {
    if (url.endsWith(`/vectors/${VECTOR_A_ID}`)) return svgResponse(SVG_A);
    if (url.endsWith(`/vectors/${VECTOR_B_ID}`)) return svgResponse(SVG_B);
    if (url.includes("/layers/consolidated")) return jsonResponse(consolidatedResponse(options));
    if (/\/layers$/.test(url)) return jsonResponse(layerSetResponse());
    if (url.endsWith(`/color-palette/${PALETTE_ID}`)) return jsonResponse(paletteResponse());
    return new Response(JSON.stringify({ code: "not_found", message: "No existe." }), { status: 404, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function renderLoadedShell(strict = false) {
  const element = <EditorShell projectId={PROJECT_ID} imageId={IMAGE_ID} paletteId={PALETTE_ID} projectName="mi-diseño.svg" dimensionWidthMm={160} onClose={vi.fn()} />;
  const utils = render(strict ? <StrictMode>{element}</StrictMode> : element);
  const canvas = await screen.findByRole("application");
  await waitFor(() => expect(Konva.stages[Konva.stages.length - 1]?.find("Path").length).toBeGreaterThanOrEqual(4));
  return { ...utils, canvas };
}

// Con transform identidad y contenedor 800×600 sobre un documento 320×240: pantalla = documento + (240, 180).
const toScreen = (x: number, y: number) => ({ clientX: x + 240, clientY: y + 180 });
function click(canvas: HTMLElement, x: number, y: number, options: { shiftKey?: boolean } = {}) {
  fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, ...toScreen(x, y), ...options });
  fireEvent.pointerUp(canvas, { pointerId: 1, ...toScreen(x, y), ...options });
}

// Puntos que caen en UN solo objeto: r1 (10,10), r2 (50,50), b1 (110,110), b2 (150,150). (30,30) cae en r1 y r2; (130,130) en b1 y b2.
const R1_AT = [10, 10] as const;
const R2_AT = [50, 50] as const;
const B1_AT = [110, 110] as const;
const B2_AT = [150, 150] as const;

const documentPaths = () => Konva.stages[Konva.stages.length - 1].getLayers()[0].find("Path") as Konva.Path[];
/** Orden de pintado actual de los Path de Konva, por id lógico. */
const paintOrder = () => documentPaths().map((path) => NAME_OF[path.data()]);
const pathOf = (data: string) => documentPaths().find((path) => path.data() === data) as Konva.Path;
const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement;
const bar = () => within(screen.getByRole("toolbar", { name: "Organizar: alinear, distribuir y orden" }));
const barButton = (name: RegExp | string) => bar().getByRole("button", { name });
const referenceSelect = () => bar().getByLabelText("Respecto de") as HTMLSelectElement;
const GEOMETRY_DIRTY = "Cambios de geometría sin guardar";
const undoButton = () => screen.getByRole("button", { name: /^Deshacer/ });
const redoButton = () => screen.getByRole("button", { name: /^Rehacer/ });

interface KeyOptions {
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
  code?: string;
}

/** Atajo de teclado: devuelve `false` si algún manejador llamó a preventDefault (el atajo se consumió). */
function press(target: Element | Window | Document, key: string, options: KeyOptions = {}) {
  return fireEvent.keyDown(target, { key, ...options });
}

/** Cuántos comandos hay en la pila de undo: se deshace hasta agotar y se vuelve a rehacer todo. */
function undoDepth(): number {
  let depth = 0;
  while (!(undoButton() as HTMLButtonElement).disabled && depth < 50) {
    fireEvent.click(undoButton());
    depth += 1;
  }
  for (let step = 0; step < depth; step += 1) fireEvent.click(redoButton());
  return depth;
}

/** Ids (data-vid) de las capas EDITADAS, leídos de la miniatura, que las serializa desde memoria con el mismo formato de origen. */
function editedIds(): string[] {
  return Array.from(document.querySelectorAll(".preview-navigator__layer")).flatMap((image) => {
    const src = image.getAttribute("src") ?? "";
    return src.startsWith("data:image/svg+xml") ? Array.from(decodeURIComponent(src).matchAll(/data-vid="([^"]+)"/g), (match) => match[1]) : [];
  });
}

/** Selecciona r1, r2 y b1 (tres objetos de tamaños y posiciones distintos). */
function selectThree(canvas: HTMLElement) {
  click(canvas, ...R1_AT);
  click(canvas, ...R2_AT, { shiftKey: true });
  click(canvas, ...B1_AT, { shiftKey: true });
}

describe("EditorShell — Organizar: alinear / distribuir / z-order (M3-S07)", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ImmediateResizeObserver);
    installStagingFetch();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("barra y estados iniciales", () => {
    it("expone la barra con 12 botones con nombre accesible (6 alinear, 2 distribuir, 4 orden) y el selector de referencia en 'Selección'", async () => {
      await renderLoadedShell();
      expect(bar().getAllByRole("button")).toHaveLength(12);
      for (const name of [
        "Alinear a la izquierda",
        "Centrar horizontalmente",
        "Alinear a la derecha",
        "Alinear arriba",
        "Centrar verticalmente",
        "Alinear abajo",
        "Distribuir horizontalmente",
        "Distribuir verticalmente",
        "Traer adelante (Ctrl/Cmd+])",
        "Enviar atrás (Ctrl/Cmd+[)",
        "Traer al frente (Ctrl/Cmd+Shift+])",
        "Enviar al fondo (Ctrl/Cmd+Shift+[)",
      ]) {
        expect(barButton(name), name).toBeInTheDocument();
      }
      expect(referenceSelect()).toHaveValue("selection");
      expect(within(referenceSelect()).getAllByRole("option").map((option) => option.textContent)).toEqual(["Selección", "Documento"]);
      expect(barButton(/^Traer al frente/)).toHaveAttribute("aria-keyshortcuts", "Control+Shift+] Meta+Shift+]");
    });

    it("sin selección todo está deshabilitado y cada tooltip dice POR QUÉ", async () => {
      await renderLoadedShell();
      for (const button of bar().getAllByRole("button")) expect(button).toBeDisabled();
      expect(barButton("Alinear a la izquierda")).toHaveAttribute("title", "Seleccioná objetos para alinear.");
      expect(barButton("Distribuir horizontalmente")).toHaveAttribute("title", "Seleccioná objetos para distribuir.");
      expect(barButton(/^Traer al frente/)).toHaveAttribute("title", "Seleccioná objetos para reordenar.");
    });

    it("1 objeto: alinear exige referencia 'Documento'; distribuir exige 3; el z-order depende del límite", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, ...R1_AT); // r1: abajo de su capa
      expect(barButton("Alinear a la izquierda")).toBeDisabled();
      expect(barButton("Alinear a la izquierda")).toHaveAttribute("title", expect.stringContaining("2 o más objetos movibles"));
      expect(barButton("Distribuir horizontalmente")).toHaveAttribute("title", expect.stringContaining("3 o más"));
      expect(barButton(/^Traer adelante/)).toBeEnabled();
      expect(barButton(/^Enviar atrás/)).toBeDisabled();
      expect(barButton(/^Enviar atrás/)).toHaveAttribute("title", "Ya está al fondo de su capa.");

      fireEvent.change(referenceSelect(), { target: { value: "document" } });
      expect(barButton("Alinear a la izquierda")).toBeEnabled();
      expect(barButton("Distribuir horizontalmente")).toBeDisabled();

      click(canvas, ...R2_AT); // r2: arriba de su capa
      expect(barButton(/^Traer adelante/)).toBeDisabled();
      expect(barButton(/^Traer adelante/)).toHaveAttribute("title", "Ya está al frente de su capa.");
      expect(barButton(/^Enviar atrás/)).toBeEnabled();
    });

    it("con 3 objetos se habilita distribuir; con 2 no", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, ...R1_AT);
      click(canvas, ...B1_AT, { shiftKey: true });
      expect(barButton("Distribuir verticalmente")).toBeDisabled();
      click(canvas, ...R2_AT, { shiftKey: true });
      expect(barButton("Distribuir verticalmente")).toBeEnabled();
      expect(barButton("Distribuir horizontalmente")).toBeEnabled();
    });

    it("el panel 'Atajos' (único) lista los atajos de z-order junto a los de portapapeles", async () => {
      await renderLoadedShell();
      expect(screen.getAllByText("Atajos")).toHaveLength(1);
      const details = screen.getByText("Atajos").closest("details")!;
      for (const [keys, label] of [
        ["Ctrl/Cmd+]", "Traer adelante"],
        ["Ctrl/Cmd+[", "Enviar atrás"],
        ["Ctrl/Cmd+Shift+]", "Traer al frente"],
        ["Ctrl/Cmd+Shift+[", "Enviar al fondo"],
        ["Ctrl/Cmd+C", "Copiar"],
      ]) {
        expect(within(details).getAllByRole("listitem").some((item) => item.textContent === `${keys} ${label}`), `${keys} ${label}`).toBe(true);
      }
    });

    it("el canvas documenta el atajo de z-order en su aria-label", async () => {
      const { canvas } = await renderLoadedShell();
      expect(canvas).toHaveAttribute("aria-label", expect.stringContaining("corchete derecho o izquierdo"));
    });

    it("con Draw la barra no se muestra y los atajos no tocan nada", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, ...R1_AT);
      fireEvent.click(screen.getByRole("button", { name: /^Draw/ }));
      expect(screen.queryByRole("toolbar", { name: "Organizar: alinear, distribuir y orden" })).not.toBeInTheDocument();
      expect(press(window, "]", { ctrlKey: true })).toBe(true);
      expect(paintOrder()).toEqual(["r1", "r2", "b1", "b2"]);
      expect(undoButton()).toBeDisabled();
    });

    it("la herramienta Move también tiene la barra", async () => {
      await renderLoadedShell();
      fireEvent.click(screen.getByRole("button", { name: /^Move/ }));
      expect(screen.getByRole("toolbar", { name: "Organizar: alinear, distribuir y orden" })).toBeInTheDocument();
    });
  });

  describe("Alinear", () => {
    it("izquierda con 2 objetos: b1 se mueve a x=0 (matriz, no `d`), UN comando con etiqueta legible, geometría sin guardar, selección conservada", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, ...R1_AT);
      click(canvas, ...B1_AT, { shiftKey: true });
      fireEvent.click(barButton("Alinear a la izquierda"));

      expect(pathOf(B1).x()).toBe(-100);
      expect(pathOf(B1).y()).toBe(0);
      expect(pathOf(B1).data()).toBe(B1); // `d` intacto
      expect(pathOf(R1).x()).toBe(0);
      expect(screen.getByRole("button", { name: "Deshacer: Alinear a la izquierda" })).toBeEnabled();
      expect(screen.getByText(GEOMETRY_DIRTY)).toBeInTheDocument();
      expect(bar().getByRole("status")).toHaveTextContent("Alinear a la izquierda: 1 objeto movido (referencia: selección).");
      expect(screen.getByRole("heading", { name: /Varios \(2 objetos\)/ })).toBeInTheDocument();
      expect(undoDepth()).toBe(1);
    });

    it("undo y redo exactos con la selección conservada", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, ...R1_AT);
      click(canvas, ...B1_AT, { shiftKey: true });
      fireEvent.click(barButton("Alinear a la izquierda"));
      expect(field("X (mm)")).toHaveValue("0");

      fireEvent.click(undoButton());
      expect(pathOf(B1).x()).toBe(0);
      expect(screen.getByRole("heading", { name: /Varios \(2 objetos\)/ })).toBeInTheDocument(); // misma selección
      expect(field("X (mm)")).toHaveValue("0");
      expect(field("Ancho (mm)")).toHaveValue("70"); // 0..140 u
      expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();
      expect(undoButton()).toBeDisabled();

      fireEvent.click(redoButton());
      expect(pathOf(B1).x()).toBe(-100);
      expect(field("Ancho (mm)")).toHaveValue("20"); // 0..40 u
      expect(screen.getByRole("heading", { name: /Varios \(2 objetos\)/ })).toBeInTheDocument();
    });

    it("Ctrl+Z / Ctrl+Shift+Z también deshacen y rehacen la alineación", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, ...R1_AT);
      click(canvas, ...B1_AT, { shiftKey: true });
      fireEvent.click(barButton("Alinear arriba"));
      expect(pathOf(B1).y()).toBe(-100);
      press(canvas, "z", { ctrlKey: true });
      expect(pathOf(B1).y()).toBe(0);
      press(canvas, "z", { ctrlKey: true, shiftKey: true });
      expect(pathOf(B1).y()).toBe(-100);
    });

    it("segunda vez: 'Ya está alineado.', sin comando nuevo y sin alerta", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, ...R1_AT);
      click(canvas, ...B1_AT, { shiftKey: true });
      fireEvent.click(barButton("Alinear a la izquierda"));
      fireEvent.click(barButton("Alinear a la izquierda"));
      expect(bar().getByRole("status")).toHaveTextContent("Ya está alineado.");
      expect(bar().queryByRole("alert")).not.toBeInTheDocument();
      expect(undoDepth()).toBe(1);
    });

    it.each([
      // Unión de r1 (0..40), r2 (20..60) y b1 (100..140): 0..140 en x e y (centro 70). Desplazamientos calculados a mano.
      ["Alinear a la izquierda", "x", { r1: 0, r2: -20, b1: -100 }],
      ["Centrar horizontalmente", "x", { r1: 50, r2: 30, b1: -50 }],
      ["Alinear a la derecha", "x", { r1: 100, r2: 80, b1: 0 }],
      ["Alinear arriba", "y", { r1: 0, r2: -20, b1: -100 }],
      ["Centrar verticalmente", "y", { r1: 50, r2: 30, b1: -50 }],
      ["Alinear abajo", "y", { r1: 100, r2: 80, b1: 0 }],
    ] as Array<[string, "x" | "y", Record<"r1" | "r2" | "b1", number>]>)("%s (3 objetos): cada uno se traslada lo calculado a mano", async (name, axis, expected) => {
      const { canvas } = await renderLoadedShell();
      selectThree(canvas);
      fireEvent.click(barButton(name));
      const read = (data: string) => (axis === "x" ? pathOf(data).x() : pathOf(data).y());
      expect(read(R1)).toBe(expected.r1);
      expect(read(R2)).toBe(expected.r2);
      expect(read(B1)).toBe(expected.b1);
      // b2 no estaba seleccionado: no se toca.
      expect(pathOf(B2).x()).toBe(0);
      expect(pathOf(B2).y()).toBe(0);
      expect(undoDepth()).toBe(1);
    });

    it("referencia Documento con UN objeto: r2 a la derecha del lienzo (320 u): x = 320 - 60 = 260; abajo (240 u): y = 240 - 60 = 180", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, ...R2_AT);
      fireEvent.change(referenceSelect(), { target: { value: "document" } });
      fireEvent.click(barButton("Alinear a la derecha"));
      expect(pathOf(R2).x()).toBe(260);
      expect(bar().getByRole("status")).toHaveTextContent("(referencia: documento)");
      fireEvent.click(barButton("Alinear abajo"));
      expect(pathOf(R2).y()).toBe(180);
      expect(undoDepth()).toBe(2);
    });

    it("referencia Documento usa el marco VIGENTE: tras recortar a 140×140 u, 'derecha' lleva b2 (borde 160) a x=140", async () => {
      const { canvas } = await renderLoadedShell();
      fireEvent.click(screen.getByRole("button", { name: /^Crop/ }));
      for (const label of ["Ancho del recorte (mm)", "Alto del recorte (mm)"]) {
        fireEvent.change(screen.getByLabelText(label), { target: { value: "70" } });
        fireEvent.keyDown(screen.getByLabelText(label), { key: "Enter" });
      }
      fireEvent.click(screen.getByRole("button", { name: "Apply" }));
      await screen.findByText("70 × 70 mm");

      press(canvas, "a", { ctrlKey: true });
      fireEvent.change(referenceSelect(), { target: { value: "document" } });
      fireEvent.click(barButton("Alinear a la derecha"));
      // Marco 0..140 (el lienzo original llegaba a 320): r1 (borde 40) +100, r2 (60) +80, b1 (140) 0, b2 (160) -20.
      expect(pathOf(R1).x()).toBe(100);
      expect(pathOf(R2).x()).toBe(80);
      expect(pathOf(B1).x()).toBe(0);
      expect(pathOf(B2).x()).toBe(-20);
      expect(screen.getByRole("button", { name: "Deshacer: Alinear a la derecha" })).toBeEnabled();
    });

    it("referencia Documento usa el marco VIGENTE también tras girar el documento 90° (origen del marco en x=40 u = 20 mm)", async () => {
      const { canvas } = await renderLoadedShell();
      fireEvent.click(screen.getByRole("button", { name: "Rotar 90° horario" }));
      fireEvent.click(screen.getByRole("button", { name: "Apply" }));
      press(canvas, "a", { ctrlKey: true });
      fireEvent.change(referenceSelect(), { target: { value: "document" } });
      fireEvent.click(barButton("Alinear a la izquierda"));
      // Marco girado: 240×320 con origen (40, -40) => todos los objetos quedan con su borde izquierdo en x = 40 u = 20 mm.
      expect(field("X (mm)")).toHaveValue("20");
    });

    it("cambiar la referencia no crea comandos y se conserva entre acciones", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, ...R2_AT);
      fireEvent.change(referenceSelect(), { target: { value: "document" } });
      expect(undoButton()).toBeDisabled();
      click(canvas, ...R1_AT);
      expect(referenceSelect()).toHaveValue("document");
    });

    it("el mensaje se limpia al deshacer", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, ...R1_AT);
      click(canvas, ...B1_AT, { shiftKey: true });
      fireEvent.click(barButton("Alinear a la izquierda"));
      expect(bar().getByRole("status")).not.toBeEmptyDOMElement();
      fireEvent.click(undoButton());
      expect(bar().getByRole("status")).toBeEmptyDOMElement();
    });
  });

  describe("Distribuir", () => {
    it("horizontal con 3 objetos: huecos iguales de 10 u (5 mm) => r2 pasa de 20 a 50 (x = 30); UN comando", async () => {
      const { canvas } = await renderLoadedShell();
      selectThree(canvas);
      fireEvent.click(barButton("Distribuir horizontalmente"));
      // r1 0..40, r2 20..60, b1 100..140: suma de anchos 120, tramo 140, hueco 10; r2 = 0 + 40 + 10 = 50.
      expect(pathOf(R2).x()).toBe(30);
      expect(pathOf(R2).y()).toBe(0);
      expect(pathOf(R1).x()).toBe(0);
      expect(pathOf(B1).x()).toBe(0);
      expect(screen.getByRole("button", { name: "Deshacer: Distribuir horizontalmente" })).toBeEnabled();
      expect(bar().getByRole("status")).toHaveTextContent("Distribuir horizontalmente: 1 objeto movido; hueco igual de 5 mm entre objetos.");
      expect(undoDepth()).toBe(1);
    });

    it("vertical: r2 pasa a y = 30 y undo/redo son exactos con la selección conservada", async () => {
      const { canvas } = await renderLoadedShell();
      selectThree(canvas);
      fireEvent.click(barButton("Distribuir verticalmente"));
      expect(pathOf(R2).y()).toBe(30);
      expect(pathOf(R2).x()).toBe(0);
      fireEvent.click(undoButton());
      expect(pathOf(R2).y()).toBe(0);
      expect(screen.getByRole("heading", { name: /Varios \(3 objetos\)/ })).toBeInTheDocument();
      fireEvent.click(redoButton());
      expect(pathOf(R2).y()).toBe(30);
    });

    it("ya distribuido: 'Ya está distribuido con huecos iguales.' y sin comando nuevo", async () => {
      const { canvas } = await renderLoadedShell();
      selectThree(canvas);
      fireEvent.click(barButton("Distribuir horizontalmente"));
      fireEvent.click(barButton("Distribuir horizontalmente"));
      expect(bar().getByRole("status")).toHaveTextContent("Ya está distribuido con huecos iguales.");
      expect(undoDepth()).toBe(1);
    });
  });

  describe("Z-order", () => {
    it("al frente: r1 pasa arriba de r2 DENTRO de su capa; sigue en 'Rojo', Azul sigue encima; UN comando con etiqueta legible", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, ...R1_AT);
      expect(paintOrder()).toEqual(["r1", "r2", "b1", "b2"]);
      fireEvent.click(barButton(/^Traer al frente/));
      expect(paintOrder()).toEqual(["r2", "r1", "b1", "b2"]);
      expect(screen.getByRole("button", { name: "Deshacer: Traer al frente" })).toBeEnabled();
      expect(screen.getByText(GEOMETRY_DIRTY)).toBeInTheDocument();
      expect(screen.getByText("Rojo", { selector: "dd" })).toBeInTheDocument(); // sigue en su capa
      expect(bar().getByRole("status")).toHaveTextContent("Traer al frente: 1 objeto reordenado dentro de su capa.");
      expect(undoDepth()).toBe(1);
    });

    it("las cuatro acciones por botón: adelante, atrás, al fondo y al frente reordenan la capa como se espera", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, ...B1_AT);
      fireEvent.click(barButton(/^Traer adelante/));
      expect(paintOrder()).toEqual(["r1", "r2", "b2", "b1"]);
      fireEvent.click(barButton(/^Enviar atrás/));
      expect(paintOrder()).toEqual(["r1", "r2", "b1", "b2"]);
      fireEvent.click(barButton(/^Traer al frente/));
      expect(paintOrder()).toEqual(["r1", "r2", "b2", "b1"]);
      fireEvent.click(barButton(/^Enviar al fondo/));
      expect(paintOrder()).toEqual(["r1", "r2", "b1", "b2"]);
      expect(undoDepth()).toBe(4);
    });

    it("HIT-TEST: donde se solapan, gana el de más arriba; tras reordenar gana el nuevo", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, 30, 30); // r1 y r2 se solapan: gana r2 (arriba), que empieza en x = 10 mm
      expect(field("X (mm)")).toHaveValue("10");
      click(canvas, ...R1_AT);
      fireEvent.click(barButton(/^Traer al frente/));
      click(canvas, ...B1_AT); // cambia la selección
      click(canvas, 30, 30); // ahora r1 está arriba: x = 0 mm
      expect(field("X (mm)")).toHaveValue("0");
      // Deshacer devuelve el hit-test original.
      fireEvent.click(undoButton());
      click(canvas, ...B1_AT);
      click(canvas, 30, 30);
      expect(field("X (mm)")).toHaveValue("10");
    });

    it("MINIATURA: la capa reordenada se serializa en el nuevo orden de pintado; al deshacer vuelve a la original", async () => {
      const { canvas } = await renderLoadedShell();
      expect(editedIds()).toEqual([]);
      click(canvas, ...R1_AT);
      fireEvent.click(barButton(/^Traer al frente/));
      expect(editedIds()).toEqual(["r2", "r1"]); // solo Rojo está editada; Azul sigue con su svgUrl original
      fireEvent.click(undoButton());
      expect(editedIds()).toEqual([]);
      fireEvent.click(redoButton());
      expect(editedIds()).toEqual(["r2", "r1"]);
    });

    it("SELECCIÓN: 'seleccionar todo' y la selección múltiple siguen el nuevo orden de pintado (el Inspector no cambia)", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, ...R1_AT);
      fireEvent.click(barButton(/^Traer al frente/));
      press(canvas, "a", { ctrlKey: true });
      expect(screen.getByRole("heading", { name: /Varios \(4 objetos\)/ })).toBeInTheDocument();
      expect(paintOrder()).toEqual(["r2", "r1", "b1", "b2"]);
    });

    it("undo y redo exactos conservando la selección (el objeto reordenado sigue seleccionado)", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, ...R1_AT);
      fireEvent.click(barButton(/^Traer al frente/));
      fireEvent.click(undoButton());
      expect(paintOrder()).toEqual(["r1", "r2", "b1", "b2"]);
      expect(screen.getByRole("heading", { name: "Objeto" })).toBeInTheDocument();
      expect(field("X (mm)")).toHaveValue("0"); // r1 sigue seleccionado
      expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();
      fireEvent.click(redoButton());
      expect(paintOrder()).toEqual(["r2", "r1", "b1", "b2"]);
      expect(field("X (mm)")).toHaveValue("0");
    });

    it("el límite no crea comando: b2 (arriba de Azul) 'Traer al frente' está deshabilitado y el atajo solo informa", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, ...B2_AT);
      expect(barButton(/^Traer al frente/)).toBeDisabled();
      expect(barButton(/^Traer al frente/)).toHaveAttribute("title", "Ya está al frente de su capa.");
      press(canvas, "]", { ctrlKey: true, shiftKey: true });
      expect(bar().getByRole("status")).toHaveTextContent("Ya está al frente de su capa.");
      expect(bar().queryByRole("alert")).not.toBeInTheDocument();
      expect(undoButton()).toBeDisabled();
      expect(paintOrder()).toEqual(["r1", "r2", "b1", "b2"]);
    });

    it("varias capas en UN comando: r1 y b1 al frente => Rojo [r2, r1] y Azul [b2, b1]; ningún objeto cambia de capa", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, ...R1_AT);
      click(canvas, ...B1_AT, { shiftKey: true });
      fireEvent.click(barButton(/^Traer al frente/));
      expect(paintOrder()).toEqual(["r2", "r1", "b2", "b1"]);
      expect(undoDepth()).toBe(1);
      expect(editedIds()).toEqual(["r2", "r1", "b2", "b1"]);
      // Las capas siguen siendo las mismas: r* en Rojo (#ff0000), b* en Azul (#0000ff).
      expect(documentPaths().map((path) => path.fill())).toEqual(["#ff0000", "#ff0000", "#0000ff", "#0000ff"]);
      expect(screen.getByText("Varias (2)", { selector: "dd" })).toBeInTheDocument();
    });

    it("una capa en el límite no se toca: adelante con r1 (sube) y b2 (ya arriba) => solo Rojo cambia y se informa", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, ...R1_AT);
      click(canvas, ...B2_AT, { shiftKey: true });
      fireEvent.click(barButton(/^Traer adelante/));
      expect(paintOrder()).toEqual(["r2", "r1", "b1", "b2"]);
      expect(bar().getByRole("status")).toHaveTextContent("Traer adelante: 1 objeto reordenado dentro de su capa. 1 objeto ya estaba en el límite de su capa.");
      expect(undoDepth()).toBe(1);
    });

    it("todas las capas en el límite: el botón está deshabilitado (r2 y b2 arriba)", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, ...R2_AT);
      click(canvas, ...B2_AT, { shiftKey: true });
      expect(barButton(/^Traer al frente/)).toBeDisabled();
      expect(barButton(/^Traer al frente/)).toHaveAttribute("title", "Ya están al frente de sus capas.");
    });
  });

  describe("atajos de teclado", () => {
    it("Ctrl+] / Ctrl+[ / Ctrl+Shift+] / Ctrl+Shift+[ ejecutan adelante, atrás, al frente y al fondo y consumen la tecla", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, ...R1_AT);
      expect(press(canvas, "]", { ctrlKey: true })).toBe(false);
      expect(paintOrder()).toEqual(["r2", "r1", "b1", "b2"]);
      expect(screen.getByRole("button", { name: "Deshacer: Traer adelante" })).toBeEnabled();
      expect(press(canvas, "[", { ctrlKey: true })).toBe(false);
      expect(paintOrder()).toEqual(["r1", "r2", "b1", "b2"]);
      expect(press(canvas, "}", { ctrlKey: true, shiftKey: true })).toBe(false);
      expect(paintOrder()).toEqual(["r2", "r1", "b1", "b2"]);
      expect(press(canvas, "{", { ctrlKey: true, shiftKey: true })).toBe(false);
      expect(paintOrder()).toEqual(["r1", "r2", "b1", "b2"]);
      expect(undoDepth()).toBe(4);
    });

    it("Cmd (macOS) hace lo mismo que Ctrl", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, ...R1_AT);
      press(canvas, "]", { metaKey: true });
      expect(paintOrder()).toEqual(["r2", "r1", "b1", "b2"]);
      press(canvas, "{", { metaKey: true, shiftKey: true });
      expect(paintOrder()).toEqual(["r1", "r2", "b1", "b2"]);
      press(canvas, "}", { metaKey: true, shiftKey: true });
      expect(paintOrder()).toEqual(["r2", "r1", "b1", "b2"]);
      press(canvas, "[", { metaKey: true });
      expect(paintOrder()).toEqual(["r1", "r2", "b1", "b2"]);
    });

    it("teclados no-US: se reconoce por la tecla física (`code`) aunque `key` sea '+' o 'Dead'", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, ...R1_AT);
      // es-ES: la tecla BracketRight escribe "+" (que el canvas usa para el zoom): con una selección el atajo gana, con el foco en el canvas.
      expect(press(canvas, "+", { ctrlKey: true, code: "BracketRight" })).toBe(false);
      expect(paintOrder()).toEqual(["r2", "r1", "b1", "b2"]);
      expect(screen.getByLabelText("Zoom actual: 100%")).toBeInTheDocument(); // y no hizo zoom
      expect(press(canvas, "Dead", { ctrlKey: true, code: "BracketLeft" })).toBe(false);
      expect(paintOrder()).toEqual(["r1", "r2", "b1", "b2"]);
      press(canvas, "*", { metaKey: true, shiftKey: true, code: "BracketRight" });
      expect(paintOrder()).toEqual(["r2", "r1", "b1", "b2"]);
      press(window, "Dead", { metaKey: true, shiftKey: true, code: "BracketLeft" });
      expect(paintOrder()).toEqual(["r1", "r2", "b1", "b2"]);
      expect(undoDepth()).toBe(4);
    });

    it("sin selección Ctrl+'+' sigue haciendo zoom en el canvas (el atajo de z-order no le quita nada)", async () => {
      const { canvas } = await renderLoadedShell();
      expect(screen.getByLabelText("Zoom actual: 100%")).toBeInTheDocument();
      press(canvas, "+", { ctrlKey: true, code: "BracketRight" });
      expect(screen.queryByLabelText("Zoom actual: 100%")).not.toBeInTheDocument();
      expect(undoButton()).toBeDisabled();
    });

    it("con el foco fuera del canvas (cuerpo de la página) el atajo también funciona", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, ...R1_AT);
      press(document.body, "]", { ctrlKey: true });
      expect(paintOrder()).toEqual(["r2", "r1", "b1", "b2"]);
    });

    it("dentro de un campo de texto NO se dispara (ni preventDefault): el campo se queda con la tecla", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, ...R1_AT);
      const input = field("X (mm)");
      input.focus();
      for (const [key, options] of [
        ["]", { ctrlKey: true }],
        ["[", { metaKey: true }],
        ["}", { ctrlKey: true, shiftKey: true }],
        ["+", { ctrlKey: true, code: "BracketRight" }],
      ] as Array<[string, KeyOptions]>) {
        expect(press(input, key, options)).toBe(true);
      }
      // Tampoco en el selector de referencia (SELECT).
      expect(press(referenceSelect(), "]", { ctrlKey: true })).toBe(true);
      expect(paintOrder()).toEqual(["r1", "r2", "b1", "b2"]);
      expect(undoButton()).toBeDisabled();
    });

    it("sin selección no se intercepta (Cmd+[ es 'atrás' del navegador): ni preventDefault, ni aviso, ni comando", async () => {
      await renderLoadedShell();
      expect(press(document.body, "[", { metaKey: true })).toBe(true);
      expect(bar().queryByRole("alert")).not.toBeInTheDocument();
      expect(undoButton()).toBeDisabled();
    });

    it("la auto-repetición de la tecla no repite la acción: un comando por pulsación", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, ...B1_AT);
      fireEvent.keyDown(canvas, { key: "]", ctrlKey: true });
      expect(paintOrder()).toEqual(["r1", "r2", "b2", "b1"]);
      const status = bar().getByRole("status").textContent;
      fireEvent.keyDown(canvas, { key: "]", ctrlKey: true, repeat: true });
      fireEvent.keyDown(canvas, { key: "]", ctrlKey: true, repeat: true });
      expect(bar().getByRole("status").textContent).toBe(status); // si se hubiera procesado diría 'Ya está al frente'
      expect(undoDepth()).toBe(1);
    });

    it("con AltGr (Ctrl+Alt) no se dispara: esa pulsación escribe un carácter", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, ...R1_AT);
      expect(press(canvas, "]", { ctrlKey: true, altKey: true })).toBe(true);
      expect(paintOrder()).toEqual(["r1", "r2", "b1", "b2"]);
    });

    it("con una rotación pendiente (Apply/Cancel) los botones se deshabilitan con el motivo y el atajo avisa sin crear comando", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, ...R1_AT);
      fireEvent.click(screen.getByRole("button", { name: "Rotar 90° horario" }));
      expect(barButton("Alinear a la izquierda")).toBeDisabled();
      expect(barButton("Alinear a la izquierda")).toHaveAttribute("title", expect.stringContaining("transformación pendiente"));
      expect(barButton(/^Traer al frente/)).toBeDisabled();
      press(canvas, "]", { ctrlKey: true });
      expect(bar().getByRole("alert")).toHaveTextContent(/Hay una transformación pendiente/);
      expect(paintOrder()).toEqual(["r1", "r2", "b1", "b2"]);
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(undoButton()).toBeDisabled();
    });
  });

  describe("capas bloqueadas", () => {
    beforeEach(() => {
      installStagingFetch({ lockedA: true });
    });

    it("alinear con referencia Documento: lo bloqueado NO se mueve, lo libre sí, y se informa '1 objeto bloqueado omitido'", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, ...R1_AT); // r1 (Rojo bloqueada)
      click(canvas, ...B1_AT, { shiftKey: true }); // b1 (Azul libre)
      fireEvent.change(referenceSelect(), { target: { value: "document" } });
      fireEvent.click(barButton("Alinear a la izquierda"));
      expect(pathOf(B1).x()).toBe(-100);
      expect(pathOf(R1).x()).toBe(0);
      expect(bar().getByRole("status")).toHaveTextContent("Alinear a la izquierda: 1 objeto movido (referencia: documento). 1 objeto bloqueado omitido.");
      expect(undoDepth()).toBe(1);
    });

    it("referencia Selección: el bloqueado NO cuenta, así que con 1 libre + 1 bloqueado no hay con qué alinear (deshabilitado con motivo)", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, ...R1_AT);
      click(canvas, ...B1_AT, { shiftKey: true });
      expect(barButton("Alinear a la derecha")).toBeDisabled();
      expect(barButton("Alinear a la derecha")).toHaveAttribute("title", expect.stringContaining("2 o más objetos movibles"));
    });

    it("distribuir: los bloqueados no cuentan para el mínimo de 3 (r1, r2 bloqueados + b1, b2 libres = 2 movibles)", async () => {
      const { canvas } = await renderLoadedShell();
      press(canvas, "a", { ctrlKey: true });
      expect(barButton("Distribuir horizontalmente")).toBeDisabled();
      expect(barButton("Distribuir horizontalmente")).toHaveAttribute("title", "Distribuir requiere 3 o más objetos movibles (hay 2).");
    });

    it("solo bloqueados: todo deshabilitado con el motivo del bloqueo, y el atajo de z-order se rechaza con aviso visible y SIN comando", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, ...R1_AT);
      fireEvent.change(referenceSelect(), { target: { value: "document" } });
      for (const button of bar().getAllByRole("button")) {
        expect(button).toBeDisabled();
        expect(button).toHaveAttribute("title", expect.stringContaining("capas bloqueadas"));
      }
      press(canvas, "]", { ctrlKey: true });
      expect(bar().getByRole("alert")).toHaveTextContent(/capas bloqueadas/);
      expect(paintOrder()).toEqual(["r1", "r2", "b1", "b2"]);
      expect(undoButton()).toBeDisabled();
    });

    it("z-order con selección mixta: solo cambia la capa libre, se informa lo omitido y es UN comando", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, ...R1_AT); // bloqueado
      click(canvas, ...B1_AT, { shiftKey: true }); // libre
      fireEvent.click(barButton(/^Traer al frente/));
      expect(paintOrder()).toEqual(["r1", "r2", "b2", "b1"]); // Rojo intacta
      expect(bar().getByRole("status")).toHaveTextContent("Traer al frente: 1 objeto reordenado dentro de su capa. 1 objeto bloqueado omitido.");
      expect(undoDepth()).toBe(1);
    });
  });

  describe("StrictMode", () => {
    it("alinear, reordenar, deshacer y rehacer funcionan igual con los efectos doble-invocados (un comando por operación)", async () => {
      const { canvas } = await renderLoadedShell(true);
      click(canvas, ...R1_AT);
      click(canvas, ...B1_AT, { shiftKey: true });
      fireEvent.click(barButton("Alinear a la derecha"));
      expect(pathOf(R1).x()).toBe(100);
      fireEvent.click(barButton(/^Traer al frente/));
      expect(paintOrder()).toEqual(["r2", "r1", "b2", "b1"]);
      expect(undoDepth()).toBe(2);
      press(canvas, "z", { ctrlKey: true });
      expect(paintOrder()).toEqual(["r1", "r2", "b1", "b2"]);
      press(canvas, "z", { ctrlKey: true });
      expect(pathOf(R1).x()).toBe(0);
      expect(undoButton()).toBeDisabled();
      press(canvas, "z", { ctrlKey: true, shiftKey: true });
      press(canvas, "z", { ctrlKey: true, shiftKey: true });
      expect(paintOrder()).toEqual(["r2", "r1", "b2", "b1"]);
    });

    it("el atajo se registra UNA vez (un solo comando por pulsación) aunque StrictMode doble-invoque los efectos", async () => {
      const { canvas } = await renderLoadedShell(true);
      click(canvas, ...B1_AT);
      press(canvas, "]", { ctrlKey: true });
      expect(undoDepth()).toBe(1);
    });
  });
});
