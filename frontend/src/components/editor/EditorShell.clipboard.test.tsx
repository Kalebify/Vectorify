import Konva from "konva";
import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { abortAwareFetch, svgResponse } from "../../test/abortableFetch";
import { EditorShell } from "./EditorShell";

/**
 * Integración de M3-S06 en el Workspace completo: Copiar / Cortar / Pegar (con offset, en el lugar, en la capa activa) / Duplicar /
 * Eliminar por teclado (Ctrl y Cmd) y por botones, un comando por operación, undo/redo con la selección coherente, bloqueos, campos de
 * texto, StrictMode. Todos los `fetch` respetan AbortSignal (`abortAwareFetch`).
 */

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const IMAGE_ID = "22222222-2222-2222-2222-222222222222";
const PALETTE_ID = "33333333-3333-3333-3333-333333333333";
const GROUP_A_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const GROUP_B_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const VECTOR_A_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const VECTOR_B_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const LAYER_SET_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

// Capa Rojo: r1 (0..40) y r2 (20..60, arriba). Capa Azul: b1 (100..140). 160 mm sobre 320 u => 0,5 mm/u => el offset (5 mm) son 10 u.
const SVG_A = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><path data-vid="r1" d="M0 0 H40 V40 H0 Z" fill="#ff0000"/><path data-vid="r2" d="M20 20 H60 V60 H20 Z" fill="#ff0000"/></svg>`;
const SVG_B = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><path data-vid="b1" d="M100 100 H140 V140 H100 Z" fill="#0000ff"/></svg>`;

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
      { id: GROUP_B_ID, name: "Azul", colorHex: "#0000ff", fill: "#0000ff", vectorId: VECTOR_B_ID, svgUrl: `/vectors/${VECTOR_B_ID}`, pathCount: 1, componentCount: null, manufacturingOperation: "unassigned", visible: true, locked: false, order: 1, rasterValidation: validation },
    ],
  };
}

function installStagingFetch(options: { lockedA?: boolean } = {}) {
  const fetchMock = abortAwareFetch((url, init) => {
    if (/\/visibility$/.test(url) && init?.method === "POST") {
      // Ojo (Eye) de la capa Azul: el servidor confirma el valor pedido (si no, el toggle optimista haría rollback).
      const { visible } = JSON.parse(String(init.body)) as { visible: boolean };
      return jsonResponse({ entries: [{ groupId: GROUP_A_ID, order: 0, visible: true, locked: options.lockedA === true, name: null }, { groupId: GROUP_B_ID, order: 1, visible, locked: false, name: null }] });
    }
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

async function renderLoadedShell(props: Partial<React.ComponentProps<typeof EditorShell>> = {}, strict = false) {
  const element = <EditorShell projectId={PROJECT_ID} imageId={IMAGE_ID} paletteId={PALETTE_ID} projectName="mi-diseño.svg" dimensionWidthMm={160} onClose={vi.fn()} {...props} />;
  const utils = render(strict ? <StrictMode>{element}</StrictMode> : element);
  const canvas = await screen.findByRole("application");
  await waitFor(() => expect(Konva.stages[Konva.stages.length - 1]?.find("Path").length).toBeGreaterThanOrEqual(3));
  return { ...utils, canvas };
}

// Con transform identidad y contenedor 800×600 sobre un documento 320×240: pantalla = documento + (240, 180).
const toScreen = (x: number, y: number) => ({ clientX: x + 240, clientY: y + 180 });
function click(canvas: HTMLElement, x: number, y: number, options: { shiftKey?: boolean } = {}) {
  fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, ...toScreen(x, y), ...options });
  fireEvent.pointerUp(canvas, { pointerId: 1, ...toScreen(x, y), ...options });
}

/** Ids (data-vid) de los objetos de las capas EDITADAS, leídos de la miniatura, que las serializa desde memoria con el mismo formato de origen. */
function editedIds(): string[] {
  return Array.from(document.querySelectorAll(".preview-navigator__layer")).flatMap((image) => {
    const src = image.getAttribute("src") ?? "";
    return src.startsWith("data:image/svg+xml") ? Array.from(decodeURIComponent(src).matchAll(/data-vid="([^"]+)"/g), (match) => match[1]) : [];
  });
}

const documentPaths = () => Konva.stages[Konva.stages.length - 1].getLayers()[0].find("Path") as Konva.Path[];
const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement;
const bar = () => within(screen.getByRole("toolbar", { name: "Copiar, pegar y eliminar" }));
const barButton = (name: RegExp | string) => bar().getByRole("button", { name });
const GEOMETRY_DIRTY = "Cambios de geometría sin guardar";
const undoButton = () => screen.getByRole("button", { name: /^Deshacer/ });

interface KeyOptions {
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
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
  for (let step = 0; step < depth; step += 1) fireEvent.click(screen.getByRole("button", { name: /^Rehacer/ }));
  return depth;
}

describe("EditorShell — Copiar / Pegar / Duplicar / Eliminar (M3-S06)", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ImmediateResizeObserver);
    installStagingFetch();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("estado inicial y botones", () => {
    it("sin selección ni portapapeles: Copiar/Cortar/Duplicar/Eliminar y las tres variantes de Pegar están deshabilitados, cada uno con su motivo", async () => {
      await renderLoadedShell();
      for (const name of [/^Copiar \(/, /^Cortar \(/, /^Duplicar \(/, /^Eliminar \(/, /^Pegar \(/, /^Pegar en el lugar/, /^Pegar en la capa activa/]) {
        expect(barButton(name)).toBeDisabled();
      }
      expect(barButton(/^Copiar \(/)).toHaveAttribute("title", "Seleccioná objetos para copiar.");
      expect(barButton(/^Pegar \(/)).toHaveAttribute("title", expect.stringContaining("portapapeles está vacío"));
      expect(bar().getByRole("status")).toHaveTextContent("Portapapeles vacío.");
    });

    it("al seleccionar se habilitan Copiar/Cortar/Duplicar/Eliminar; Pegar sigue deshabilitado hasta copiar", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, 10, 10);
      for (const name of [/^Copiar \(/, /^Cortar \(/, /^Duplicar \(/, /^Eliminar \(/]) expect(barButton(name)).toBeEnabled();
      expect(barButton(/^Pegar \(/)).toBeDisabled();
      fireEvent.click(barButton(/^Copiar \(/));
      expect(barButton(/^Pegar \(/)).toBeEnabled();
      expect(barButton(/^Pegar en el lugar/)).toBeEnabled();
      expect(bar().getByRole("status")).toHaveTextContent("Se copió 1 objeto al portapapeles del editor.");
    });

    it("la lista de atajos está en la UI ('Atajos') y los botones anuncian el suyo", async () => {
      await renderLoadedShell();
      expect(screen.getByText("Atajos")).toBeInTheDocument();
      expect(bar().getByText("Ctrl/Cmd+Alt+V")).toBeInTheDocument();
      expect(barButton(/^Duplicar \(/)).toHaveAttribute("aria-keyshortcuts", "Control+D Meta+D");
    });

    it("el canvas documenta los atajos en su aria-label", async () => {
      const { canvas } = await renderLoadedShell();
      expect(canvas).toHaveAttribute("aria-label", expect.stringContaining("Control o Comando más C, X, V y D"));
    });
  });

  describe("Copiar", () => {
    it("Ctrl+C copia SIN crear comando, sin ensuciar la geometría y sin tocar el documento", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, 10, 10);
      expect(press(canvas, "c", { ctrlKey: true })).toBe(false); // preventDefault: el atajo se consumió
      expect(bar().getByRole("status")).toHaveTextContent("Se copió 1 objeto al portapapeles del editor.");
      expect(undoButton()).toBeDisabled();
      expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();
      expect(documentPaths()).toHaveLength(3);
    });

    it("Cmd+C (macOS) hace lo mismo que Ctrl+C", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, 10, 10);
      press(canvas, "c", { metaKey: true });
      expect(barButton(/^Pegar \(/)).toBeEnabled();
    });

    it("copia una selección múltiple: 'Se copiaron 2 objetos'", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, 10, 10);
      click(canvas, 120, 120, { shiftKey: true });
      press(canvas, "c", { ctrlKey: true });
      expect(bar().getByRole("status")).toHaveTextContent("Se copiaron 2 objetos al portapapeles del editor.");
    });

    it("con el foco fuera del canvas (cuerpo de la página) el atajo también funciona", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, 10, 10);
      press(document.body, "c", { ctrlKey: true });
      expect(barButton(/^Pegar \(/)).toBeEnabled();
    });
  });

  describe("Pegar", () => {
    it("Ctrl+V pega desplazado 5 mm (10 u): UN comando con etiqueta legible, selección en lo pegado, geometría sin guardar", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, 10, 10); // r1: x = 0 mm
      press(canvas, "c", { ctrlKey: true });
      press(canvas, "v", { ctrlKey: true });

      expect(documentPaths()).toHaveLength(4);
      expect(screen.getByRole("button", { name: "Deshacer: Pegar 1 objeto" })).toBeEnabled();
      expect(screen.getByText(GEOMETRY_DIRTY)).toBeInTheDocument();
      // La selección pasó a ser la copia: 5 mm a la derecha y 5 mm abajo del original.
      expect(await screen.findByRole("heading", { name: "Objeto" })).toBeInTheDocument();
      expect(field("X (mm)")).toHaveValue("5");
      expect(field("Y (mm)")).toHaveValue("5");
      expect(field("Ancho (mm)")).toHaveValue("20");
      expect(bar().getByRole("status")).toHaveTextContent("Se pegó 1 objeto.");
      // Un solo comando.
      expect(undoDepth()).toBe(1);
    });

    it("pegados consecutivos ACUMULAN el offset: 5, 10, 15 mm; copiar de nuevo lo reinicia", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, 10, 10);
      press(canvas, "c", { ctrlKey: true });
      for (const x of ["5", "10", "15"]) {
        press(canvas, "v", { ctrlKey: true });
        expect(field("X (mm)")).toHaveValue(x);
      }
      expect(documentPaths()).toHaveLength(6);

      press(canvas, "c", { ctrlKey: true }); // copia lo pegado (en 15 mm): contador a cero
      press(canvas, "v", { ctrlKey: true });
      expect(field("X (mm)")).toHaveValue("20"); // 15 mm + 1x (5 mm)
    });

    it("Ctrl+Shift+V pega EN EL LUGAR (0 mm de diferencia) y no adelanta el contador de offset", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, 10, 10);
      press(canvas, "c", { ctrlKey: true });
      press(canvas, "V", { ctrlKey: true, shiftKey: true });
      expect(screen.getByRole("button", { name: "Deshacer: Pegar 1 objeto en el lugar" })).toBeEnabled();
      expect(field("X (mm)")).toHaveValue("0");
      expect(field("Y (mm)")).toHaveValue("0");
      expect(documentPaths()).toHaveLength(4);

      press(canvas, "v", { ctrlKey: true });
      expect(field("X (mm)")).toHaveValue("5"); // sigue siendo el primer pegado con offset
    });

    it("Cmd+V, Cmd+Shift+V y Cmd+Alt+V (macOS) funcionan igual que con Ctrl", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, 10, 10);
      press(canvas, "c", { metaKey: true });
      press(canvas, "v", { metaKey: true });
      expect(field("X (mm)")).toHaveValue("5");
      press(canvas, "V", { metaKey: true, shiftKey: true });
      expect(field("X (mm)")).toHaveValue("0");
      // En macOS Option+V produce '√' como `key`: se reconoce por la tecla física.
      press(canvas, "√", { metaKey: true, altKey: true, code: "KeyV" });
      expect(documentPaths()).toHaveLength(6);
    });

    it("pega una selección múltiple en SUS capas de origen; ids nuevos y únicos", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, 10, 10);
      click(canvas, 120, 120, { shiftKey: true });
      press(canvas, "c", { ctrlKey: true });
      press(canvas, "v", { ctrlKey: true });
      press(canvas, "v", { ctrlKey: true });
      expect(documentPaths()).toHaveLength(7);
      expect(screen.getByRole("heading", { name: /Varios \(2 objetos\)/ })).toBeInTheDocument();
      // Capa Rojo: r1, r2 + 2 pegados; capa Azul: b1 + 2 pegados. Todos los ids distintos.
      const ids = editedIds();
      expect(ids).toHaveLength(7);
      expect(new Set(ids).size).toBe(7);
      expect(ids).toEqual(expect.arrayContaining(["r1", "r2", "b1"]));
    });

    it("Undo tras pegar: desaparece lo pegado y la selección vuelve a los ORIGINALES; Redo vuelve a pegarlo y a seleccionarlo", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, 10, 10);
      press(canvas, "c", { ctrlKey: true });
      press(canvas, "v", { ctrlKey: true });
      expect(field("X (mm)")).toHaveValue("5");

      press(canvas, "z", { ctrlKey: true });
      expect(documentPaths()).toHaveLength(3);
      expect(field("X (mm)")).toHaveValue("0"); // r1 seleccionado de nuevo
      expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();

      press(canvas, "z", { ctrlKey: true, shiftKey: true });
      expect(documentPaths()).toHaveLength(4);
      expect(field("X (mm)")).toHaveValue("5"); // los pegados seleccionados de nuevo
      expect(screen.getByText(GEOMETRY_DIRTY)).toBeInTheDocument();
    });

    it("con el portapapeles vacío Ctrl+V avisa y no crea comando", async () => {
      const { canvas } = await renderLoadedShell();
      press(canvas, "v", { ctrlKey: true });
      expect(await screen.findByRole("alert")).toHaveTextContent(/portapapeles está vacío/);
      expect(undoButton()).toBeDisabled();
      expect(documentPaths()).toHaveLength(3);
    });

    it("los botones Pegar / Pegar en el lugar hacen lo mismo que los atajos", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, 10, 10);
      fireEvent.click(barButton(/^Copiar \(/));
      fireEvent.click(barButton(/^Pegar \(/));
      expect(field("X (mm)")).toHaveValue("5");
      fireEvent.click(barButton(/^Pegar en el lugar/));
      expect(field("X (mm)")).toHaveValue("0");
      expect(documentPaths()).toHaveLength(5);
      expect(undoDepth()).toBe(2);
    });
  });

  describe("Pegar en la capa activa", () => {
    it("copia entre capas: los objetos toman el color de la capa destino y quedan seleccionados", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, 10, 10); // r1 (Rojo)
      press(canvas, "c", { ctrlKey: true });
      fireEvent.click(screen.getByRole("button", { name: /Seleccionar el color Azul/ })); // capa activa: Azul
      press(canvas, "v", { ctrlKey: true, altKey: true });

      expect(documentPaths()).toHaveLength(4);
      expect(screen.getByRole("button", { name: "Deshacer: Pegar 1 objeto en la capa «Azul»" })).toBeEnabled();
      expect(await screen.findByRole("heading", { name: "Objeto" })).toBeInTheDocument();
      expect(screen.getByText("Azul", { selector: "dd" })).toBeInTheDocument();
      expect(screen.getByText("#0000ff", { selector: "dd" })).toBeInTheDocument();
      expect(field("X (mm)")).toHaveValue("5");
      expect(documentPaths().filter((path) => path.fill() === "#0000ff")).toHaveLength(2); // b1 + la copia
    });

    it("el botón 'Pegar en la capa activa' hace lo mismo y undo la retira", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, 10, 10);
      fireEvent.click(barButton(/^Copiar \(/));
      fireEvent.click(screen.getByRole("button", { name: /Seleccionar el color Azul/ }));
      fireEvent.click(barButton(/^Pegar en la capa activa/));
      expect(documentPaths()).toHaveLength(4);
      fireEvent.click(undoButton());
      expect(documentPaths()).toHaveLength(3);
    });
  });

  describe("Duplicar", () => {
    it("Ctrl+D duplica desplazado 5 mm, selecciona lo duplicado y NO toca el portapapeles", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, 10, 10);
      press(canvas, "d", { ctrlKey: true });
      expect(documentPaths()).toHaveLength(4);
      expect(screen.getByRole("button", { name: "Deshacer: Duplicar 1 objeto" })).toBeEnabled();
      expect(field("X (mm)")).toHaveValue("5");
      expect(barButton(/^Pegar \(/)).toBeDisabled(); // el portapapeles sigue vacío
      expect(bar().getByRole("status")).toHaveTextContent("Se duplicó 1 objeto.");
      expect(undoDepth()).toBe(1);
    });

    it("duplicar repetido repite el mismo delta sobre la selección resultante: 5, 10, 15 mm", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, 10, 10);
      for (const x of ["5", "10", "15"]) {
        press(canvas, "d", { ctrlKey: true });
        expect(field("X (mm)")).toHaveValue(x);
      }
      expect(documentPaths()).toHaveLength(6);
      expect(undoDepth()).toBe(3);
    });

    it("duplicar no pisa lo copiado ni su contador de offset", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, 120, 120); // b1
      press(canvas, "c", { ctrlKey: true });
      click(canvas, 10, 10); // r1
      press(canvas, "d", { ctrlKey: true });
      click(canvas, 120, 120);
      press(canvas, "v", { ctrlKey: true });
      // Pegó b1 (100 u = 50 mm) con el primer offset (5 mm): 55 mm.
      expect(field("X (mm)")).toHaveValue("55");
    });

    it("Cmd+D (macOS) duplica y bloquea el atajo del navegador", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, 10, 10);
      expect(press(canvas, "d", { metaKey: true })).toBe(false);
      expect(documentPaths()).toHaveLength(4);
    });

    it("duplicar una selección múltiple duplica cada objeto en su capa", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, 10, 10);
      click(canvas, 120, 120, { shiftKey: true });
      fireEvent.click(barButton(/^Duplicar \(/));
      expect(documentPaths()).toHaveLength(5);
      expect(screen.getByRole("button", { name: "Deshacer: Duplicar 2 objetos" })).toBeEnabled();
    });
  });

  describe("Cortar y Eliminar", () => {
    it("Ctrl+X quita el objeto, lo deja en el portapapeles y limpia la selección; Pegar en el lugar lo restituye en su sitio con id nuevo", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, 120, 120); // b1
      press(canvas, "x", { ctrlKey: true });
      expect(documentPaths()).toHaveLength(2);
      expect(screen.getByRole("button", { name: "Deshacer: Cortar 1 objeto" })).toBeEnabled();
      expect(screen.queryByRole("heading", { name: "Objeto" })).not.toBeInTheDocument();
      expect(barButton(/^Pegar \(/)).toBeEnabled();
      expect(bar().getByRole("status")).toHaveTextContent("Se cortó 1 objeto.");

      press(canvas, "V", { ctrlKey: true, shiftKey: true });
      expect(documentPaths()).toHaveLength(3);
      expect(field("X (mm)")).toHaveValue("50");
      const pastedIds = editedIds();
      expect(pastedIds).toHaveLength(1);
      expect(pastedIds).not.toContain("b1");
    });

    it("Suprimir en el canvas elimina con UN solo comando (no se duplica con el atajo global); deshacer lo restaura y lo vuelve a seleccionar", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, 10, 10);
      expect(press(canvas, "Delete")).toBe(false);
      expect(documentPaths()).toHaveLength(2);
      expect(screen.getByRole("button", { name: "Deshacer: Eliminar 1 objeto" })).toBeEnabled();
      expect(screen.queryByRole("heading", { name: "Objeto" })).not.toBeInTheDocument();
      expect(undoDepth()).toBe(1);

      press(canvas, "z", { ctrlKey: true });
      expect(documentPaths()).toHaveLength(3);
      expect(await screen.findByRole("heading", { name: "Objeto" })).toBeInTheDocument();
      expect(field("X (mm)")).toHaveValue("0");

      press(canvas, "z", { ctrlKey: true, shiftKey: true });
      expect(documentPaths()).toHaveLength(2);
      expect(screen.queryByRole("heading", { name: "Objeto" })).not.toBeInTheDocument();
    });

    it("Retroceso también elimina, y también sin el foco en el canvas", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, 10, 10);
      press(document.body, "Backspace");
      expect(documentPaths()).toHaveLength(2);
      expect(undoDepth()).toBe(1);
    });

    it("eliminar una selección múltiple es un solo comando: 'Eliminar 2 objetos'", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, 10, 10);
      click(canvas, 120, 120, { shiftKey: true });
      fireEvent.click(barButton(/^Eliminar \(/));
      expect(documentPaths()).toHaveLength(1);
      expect(screen.getByRole("button", { name: "Deshacer: Eliminar 2 objetos" })).toBeEnabled();
      expect(bar().getByRole("status")).toHaveTextContent("Se eliminaron 2 objetos.");
      expect(undoDepth()).toBe(1);
    });

    it("sin selección Suprimir no hace nada (ni avisa)", async () => {
      const { canvas } = await renderLoadedShell();
      press(canvas, "Delete");
      expect(documentPaths()).toHaveLength(3);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });

  describe("campos de texto y herramientas", () => {
    it("dentro de un campo de texto (Inspector) NINGÚN atajo se dispara: ni copiar, ni pegar, ni duplicar, ni eliminar", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, 10, 10);
      press(canvas, "c", { ctrlKey: true });
      const input = field("X (mm)");
      input.focus();
      const attempts: Array<[string, KeyOptions]> = [
        ["v", { ctrlKey: true }],
        ["V", { ctrlKey: true, shiftKey: true }],
        ["v", { metaKey: true, altKey: true }],
        ["d", { ctrlKey: true }],
        ["d", { metaKey: true }],
        ["x", { ctrlKey: true }],
        ["Delete", {}],
        ["Backspace", {}],
      ];
      for (const [key, options] of attempts) expect(press(input, key, options)).toBe(true); // sin preventDefault: el campo se queda con la tecla
      expect(documentPaths()).toHaveLength(3);
      expect(undoButton()).toBeDisabled();
    });

    it("Ctrl+C dentro de un campo de texto NO copia los objetos", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, 10, 10);
      press(field("X (mm)"), "c", { ctrlKey: true });
      expect(barButton(/^Pegar \(/)).toBeDisabled();
    });

    it("con texto de la página seleccionado fuera del canvas, Ctrl+C se deja al navegador (no copia objetos)", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, 10, 10);
      vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => "#0000ff" } as Selection);
      expect(press(document.body, "c", { ctrlKey: true })).toBe(true);
      expect(barButton(/^Pegar \(/)).toBeDisabled();
      // Con el foco en el canvas el atajo sigue siendo del editor.
      expect(press(canvas, "c", { ctrlKey: true })).toBe(false);
      expect(barButton(/^Pegar \(/)).toBeEnabled();
    });

    it("mantener la tecla apretada (auto-repetición) no repite la acción: un comando por pulsación", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, 10, 10);
      fireEvent.keyDown(canvas, { key: "d", ctrlKey: true });
      fireEvent.keyDown(canvas, { key: "d", ctrlKey: true, repeat: true });
      fireEvent.keyDown(canvas, { key: "d", ctrlKey: true, repeat: true });
      expect(documentPaths()).toHaveLength(4);
    });

    it("con otras herramientas (Draw) Suprimir/Retroceso y los atajos no tocan los objetos, y la barra no se muestra", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, 10, 10);
      fireEvent.click(screen.getByRole("button", { name: /^Draw/ }));
      expect(screen.queryByRole("toolbar", { name: "Copiar, pegar y eliminar" })).not.toBeInTheDocument();
      press(window, "Backspace");
      press(window, "Delete");
      press(window, "d", { ctrlKey: true });
      press(window, "x", { ctrlKey: true });
      expect(documentPaths()).toHaveLength(3);
      expect(undoButton()).toBeDisabled();
    });

    it("la herramienta Move también tiene la barra y los atajos", async () => {
      const { canvas } = await renderLoadedShell();
      fireEvent.click(screen.getByRole("button", { name: /^Move/ }));
      click(canvas, 10, 10);
      press(canvas, "d", { ctrlKey: true });
      expect(documentPaths()).toHaveLength(4);
    });

    it("con una rotación/reflejo pendiente de Apply/Cancel no se edita: botones deshabilitados y el atajo avisa", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, 10, 10);
      fireEvent.click(screen.getByRole("button", { name: "Rotar 90° horario" }));
      expect(barButton(/^Eliminar \(/)).toBeDisabled();
      expect(barButton(/^Eliminar \(/)).toHaveAttribute("title", expect.stringContaining("transformación pendiente"));
      press(canvas, "d", { ctrlKey: true });
      expect(bar().getByRole("alert")).toHaveTextContent(/Hay una transformación pendiente/);
      expect(documentPaths()).toHaveLength(3);
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(undoButton()).toBeDisabled();
    });
  });

  describe("capas bloqueadas", () => {
    beforeEach(() => {
      installStagingFetch({ lockedA: true });
    });

    it("copiar SÍ funciona con un objeto bloqueado; cortar, duplicar y eliminar están deshabilitados con el motivo", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, 10, 10); // r1 (capa Rojo bloqueada)
      expect(barButton(/^Copiar \(/)).toBeEnabled();
      for (const name of [/^Cortar \(/, /^Duplicar \(/, /^Eliminar \(/]) {
        expect(barButton(name)).toBeDisabled();
        expect(barButton(name)).toHaveAttribute("title", expect.stringContaining("capas bloqueadas"));
      }
      press(canvas, "c", { ctrlKey: true });
      expect(barButton(/^Pegar \(/)).toBeEnabled();
    });

    it("los atajos Ctrl+X / Ctrl+D / Suprimir sobre un objeto bloqueado se rechazan con aviso visible y SIN comando", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, 10, 10);
      const attempts: Array<[string, KeyOptions]> = [
        ["x", { ctrlKey: true }],
        ["d", { ctrlKey: true }],
        ["Delete", {}],
      ];
      for (const [key, options] of attempts) {
        press(canvas, key, options);
        expect(await screen.findByRole("alert")).toHaveTextContent(/capa «Rojo» bloqueada/);
      }
      expect(documentPaths()).toHaveLength(3);
      expect(undoButton()).toBeDisabled();
      expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();
    });

    it("pegar donde la capa de origen está bloqueada: rechazo explícito (no se pega en otra capa) y sin comando; la capa activa es la salida", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, 10, 10);
      press(canvas, "c", { ctrlKey: true });
      press(canvas, "v", { ctrlKey: true });
      expect(await screen.findByRole("alert")).toHaveTextContent(/No se pegó nada: 1 objeto no se pegó \(capa «Rojo» bloqueada\)\..*Pegar en la capa activa/);
      expect(documentPaths()).toHaveLength(3);
      expect(undoButton()).toBeDisabled();

      // La salida que ofrece el mensaje: pegarlo en la capa activa (Azul), que SÍ admite objetos.
      fireEvent.click(screen.getByRole("button", { name: /Seleccionar el color Azul/ }));
      press(canvas, "v", { ctrlKey: true, altKey: true });
      expect(documentPaths()).toHaveLength(4);
      expect(documentPaths().filter((path) => path.fill() === "#0000ff")).toHaveLength(2);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("selección mixta (bloqueado + libre): Eliminar quita solo el libre, informa lo omitido y es UN comando", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, 10, 10); // r1 bloqueado
      click(canvas, 120, 120, { shiftKey: true }); // b1 libre
      press(canvas, "Delete");
      expect(documentPaths()).toHaveLength(2);
      expect(documentPaths().filter((path) => path.fill() === "#0000ff")).toHaveLength(0); // b1 se fue; r1 (bloqueado) se quedó
      expect(bar().getByRole("status")).toHaveTextContent("Se eliminó 1 objeto. 1 objeto no se eliminó (capa «Rojo» bloqueada).");
      // Eliminar limpia la selección entera (también el objeto bloqueado que se omitió).
      expect(screen.queryByRole("heading", { name: /Objeto|Varios/ })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Deshacer: Eliminar 1 objeto" })).toBeEnabled();
      expect(undoDepth()).toBe(1);
    });

    it("selección mixta: Cortar corta solo lo libre y SOLO eso queda en el portapapeles", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, 10, 10);
      click(canvas, 120, 120, { shiftKey: true });
      press(canvas, "x", { ctrlKey: true });
      expect(bar().getByRole("status")).toHaveTextContent("Se cortó 1 objeto. 1 objeto no se cortó (capa «Rojo» bloqueada).");
      expect(screen.queryByRole("heading", { name: /Objeto|Varios/ })).not.toBeInTheDocument();
      press(canvas, "V", { ctrlKey: true, shiftKey: true });
      expect(documentPaths()).toHaveLength(3); // r1, r2 y b1 restituido: el portapapeles tenía UN objeto
    });

    it("selección mixta: Duplicar duplica solo lo libre e informa", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, 10, 10);
      click(canvas, 120, 120, { shiftKey: true });
      press(canvas, "d", { ctrlKey: true });
      expect(documentPaths()).toHaveLength(4);
      expect(bar().getByRole("status")).toHaveTextContent("Se duplicó 1 objeto. 1 objeto no se duplicó (capa «Rojo» bloqueada).");
    });

    it("pegar parcialmente: lo pegable se pega, lo bloqueado se informa, un solo comando", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, 10, 10);
      click(canvas, 120, 120, { shiftKey: true });
      press(canvas, "c", { ctrlKey: true });
      expect(bar().getByRole("status")).toHaveTextContent("Se copiaron 2 objetos");
      press(canvas, "v", { ctrlKey: true });
      expect(documentPaths()).toHaveLength(4);
      expect(bar().getByRole("status")).toHaveTextContent("Se pegó 1 objeto. 1 objeto no se pegó (capa «Rojo» bloqueada).");
      expect(undoDepth()).toBe(1);
    });
  });

  describe("capa de origen oculta y cambio de documento", () => {
    it("lo copiado de una capa que luego se oculta se omite con motivo 'oculta' (no se pega en otra capa); al mostrarla vuelve a poder pegarse", async () => {
      const { canvas } = await renderLoadedShell();
      click(canvas, 120, 120); // b1 (Azul)
      press(canvas, "c", { ctrlKey: true });
      fireEvent.click(screen.getByRole("button", { name: "Ocultar la capa Azul" }));
      press(document.body, "v", { ctrlKey: true });
      expect(await screen.findByRole("alert")).toHaveTextContent(/No se pegó nada: 1 objeto no se pegó \(capa «Azul» oculta\)/);
      expect(undoButton()).toBeDisabled();

      fireEvent.click(screen.getByRole("button", { name: "Mostrar la capa Azul" }));
      press(document.body, "v", { ctrlKey: true });
      expect(screen.getByRole("button", { name: "Deshacer: Pegar 1 objeto" })).toBeEnabled();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("cambiar de documento (otro proyecto/imagen) vacía el portapapeles", async () => {
      const { canvas, rerender } = await renderLoadedShell();
      click(canvas, 10, 10);
      press(canvas, "c", { ctrlKey: true });
      expect(barButton(/^Pegar \(/)).toBeEnabled();

      rerender(<EditorShell projectId={PROJECT_ID} imageId="99999999-9999-9999-9999-999999999999" paletteId={PALETTE_ID} projectName="otro.svg" dimensionWidthMm={160} onClose={vi.fn()} />);
      await waitFor(() => expect(bar().getByRole("status")).toHaveTextContent("Portapapeles vacío."));
      expect(barButton(/^Pegar \(/)).toBeDisabled();
    });
  });

  describe("StrictMode, red y ids", () => {
    it("en StrictMode (doble efecto/render) copiar, pegar, deshacer y rehacer se comportan igual: un comando por operación", async () => {
      const fetchMock = installStagingFetch();
      const { canvas } = await renderLoadedShell({}, true);
      // Hubo cargas abortadas por el cleanup del efecto y se reintentaron: el estado final es completo.
      expect(fetchMock.signals.some((signal) => signal?.aborted)).toBe(true);
      click(canvas, 10, 10);
      press(canvas, "c", { ctrlKey: true });
      press(canvas, "v", { ctrlKey: true });
      expect(documentPaths()).toHaveLength(4);
      expect(undoDepth()).toBe(1);
      press(canvas, "z", { ctrlKey: true });
      expect(documentPaths()).toHaveLength(3);
      press(canvas, "y", { ctrlKey: true });
      expect(documentPaths()).toHaveLength(4);
    });

    it("el atajo global se desregistra al desmontar (sin listeners colgados)", async () => {
      const { canvas, unmount } = await renderLoadedShell();
      click(canvas, 10, 10);
      expect(press(window, "d", { ctrlKey: true })).toBe(false); // vivo: consume el atajo
      unmount();
      expect(press(window, "d", { ctrlKey: true })).toBe(true); // desmontado: nadie lo consume
    });

    it("el `createId` del shell genera los ids de lo pegado y duplicado (y nunca repite uno existente)", async () => {
      let next = 0;
      const createId = () => `pegado-${(next += 1)}`;
      const { canvas } = await renderLoadedShell({ createId });
      click(canvas, 10, 10);
      press(canvas, "c", { ctrlKey: true });
      press(canvas, "v", { ctrlKey: true });
      press(canvas, "d", { ctrlKey: true });
      expect(editedIds().sort()).toEqual(["pegado-1", "pegado-2", "r1", "r2"]);
    });
  });
});
