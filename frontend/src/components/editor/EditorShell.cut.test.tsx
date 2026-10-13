import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectLastCommand } from "../../test/history";
import {
  clickAt,
  dragAlong,
  GEOMETRY_DIRTY,
  installResizeObserver,
  installWorkspaceFetch,
  jsonResponse,
  LN1,
  pathByData,
  pathData,
  R1,
  R2,
  redoButton,
  renderWorkspace,
  tool,
  toScreen,
  undoButton,
} from "../../test/workspaceFixture";

/**
 * Integración de Cut (M3-S10) en el Workspace completo: herramienta Cut, dos modos (dividir / ranura), «Extender», línea de corte dibujada en el canvas (puntos,
 * Retroceso, Enter, Escape, segmento por arrastre), alcance (selección vs. todos los cruzados), preview del servidor (debounce + AbortSignal, UNA petición viva),
 * un corte que no atraviesa (Apply deshabilitado con la explicación), capas bloqueadas / ocultas, un comando atómico por Apply, undo/redo exactos y StrictMode.
 * Documento 320 x 240 u con 0,5 mm por unidad. Capas de la fixture: Rojo (r1 0..40², r2 0..40 x 100..140), Azul (b1 100..140²) y Líneas (ln1 abierta y = 20 de x 200
 * a 260). El servidor se simula con un motor de CORTES VERTICALES sobre rectángulos y líneas horizontales (x = la del primer punto de la línea de corte); el cálculo
 * real se prueba en services/python-engine/tests.
 */

type Body = Record<string, unknown>;
type Subject = { type: "polygon" | "line"; coordinates: number[][][] | number[][] };

const rectRing = (x0: number, y0: number, x1: number, y1: number) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const polygon = (x0: number, y0: number, x1: number, y1: number) => ({ type: "polygon", coordinates: [rectRing(x0, y0, x1, y1)] });

/**
 * Corte vertical en x = x del primer punto de la línea, entre el menor y el mayor y de sus puntos (todo el eje con `extend`). Un rectángulo (o una línea
 * horizontal) queda partido solo si el corte lo ATRAVIESA de lado a lado; si solo lo toca, `changed: false` con el subject tal cual. En modo ranura quita
 * `slotWidth` de ancho centrado en x. Hace eco del modo, el ancho y la extensión.
 */
function splitPayload(body: Body) {
  const cutter = (body.cutter as { points: number[][] }).points;
  const x = cutter[0][0];
  const extend = body.extend === true;
  const yMin = extend ? -Infinity : Math.min(...cutter.map((point) => point[1]));
  const yMax = extend ? Infinity : Math.max(...cutter.map((point) => point[1]));
  const half = body.mode === "slot" ? (body.slotWidth as number) / 2 : 0;
  const results = (body.subjects as Subject[]).map((subject, index) => {
    if (subject.type === "polygon") {
      const ring = (subject.coordinates as number[][][])[0];
      const xs = ring.map((point) => point[0]);
      const ys = ring.map((point) => point[1]);
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      const touched = x >= x0 - half && x <= x1 + half && yMax >= y0 && yMin <= y1;
      const crosses = touched && x > x0 && x < x1 && yMin <= y0 && yMax >= y1;
      const pieces = crosses ? [polygon(x0, y0, x - half, y1), polygon(x + half, y0, x1, y1)] : [polygon(x0, y0, x1, y1)];
      return { subjectIndex: index, touched, changed: crosses, pieces, pieceCount: pieces.length, discarded: 0 };
    }
    const points = subject.coordinates as number[][];
    const xs = points.map((point) => point[0]);
    const y = points[0][1];
    const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
    const touched = x >= x0 && x <= x1 && y >= yMin && y <= yMax;
    const crosses = touched && x > x0 && x < x1;
    const pieces = crosses
      ? [{ type: "line", coordinates: [[x0, y], [x - half, y]] }, { type: "line", coordinates: [[x + half, y], [x1, y]] }]
      : [{ type: "line", coordinates: points }];
    return { subjectIndex: index, touched, changed: crosses, pieces, pieceCount: pieces.length, discarded: 0 };
  });
  return {
    mode: body.mode,
    slotWidth: body.slotWidth,
    extend: body.extend,
    tolerance: body.tolerance,
    pieceCount: results.reduce((total, item) => total + item.pieceCount, 0),
    results,
  };
}

const fakeSplit = (body: Body): Response => jsonResponse(splitPayload(body));

const R1_LEFT = "M0 0 L20 0 L20 40 L0 40 Z";
const R1_RIGHT = "M20 0 L40 0 L40 40 L20 40 Z";
const R2_LEFT = "M0 100 L20 100 L20 140 L0 140 Z";
const R2_RIGHT = "M20 100 L40 100 L40 140 L20 140 Z";

const panel = () => screen.getByRole("heading", { name: "Cut" }).closest("section")!;
const inPanel = () => within(panel());
const panelOpen = () => screen.queryByRole("heading", { name: "Cut" }) !== null;
const applyButton = () => inPanel().getByRole("button", { name: "Apply" });
const cancelButton = () => inPanel().getByRole("button", { name: "Cancel" });
const press = (key: string) => fireEvent.keyDown(screen.getByRole("application"), { key });
const stateText = () => inPanel().getAllByRole("status")[0].textContent ?? "";
const surface = () => screen.getByTestId("cut-surface");
const toolButton = () => tool(/^Cut/);
const startCut = () => fireEvent.click(toolButton());
const lineText = () => panel().querySelector(".cut-panel__line p")!.textContent ?? "";

type FetchMock = ReturnType<typeof installWorkspaceFetch>;
const splitCalls = (fetchMock: FetchMock) => fetchMock.splitCalls;
const splitSignals = (fetchMock: FetchMock) => fetchMock.urls.flatMap((url, index) => (url.endsWith("/api/v2/geometry/split") ? [fetchMock.signals[index]] : []));
const subjectsOf = (body: Body) => body.subjects as Subject[];

function click(canvas: HTMLElement, x: number, y: number, options: { shiftKey?: boolean } = {}) {
  fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, ...toScreen(x, y), ...options });
  fireEvent.pointerUp(canvas, { pointerId: 1, ...toScreen(x, y), ...options });
}

const R1_AT = [20, 20] as const;

function selectObjects(canvas: HTMLElement, ...points: Array<readonly [number, number]>) {
  points.forEach(([x, y], index) => click(canvas, x, y, { shiftKey: index > 0 }));
}

/** Dibuja la línea de corte vertical x = 20 entre `y0` e `y1` (dos clicks). */
function drawVertical(y0 = -10, y1 = 50, x = 20) {
  clickAt(surface(), x, y0);
  clickAt(surface(), x, y1);
}

/** Abre Cut (con la selección previa dada) y dibuja una línea vertical; espera el primer resultado. */
async function openCutWithLine(canvas: HTMLElement, fetchMock: FetchMock, options: { select?: Array<readonly [number, number]>; y0?: number; y1?: number } = {}) {
  if (options.select) selectObjects(canvas, ...options.select);
  startCut();
  drawVertical(options.y0, options.y1);
  await waitFor(() => expect(splitCalls(fetchMock)).toHaveLength(1));
  await waitFor(() => expect(stateText()).toMatch(/Se cortarán|Ningún objeto cambia/));
}

describe("EditorShell — Cut (M3-S10)", () => {
  beforeEach(() => installResizeObserver());
  afterEach(() => vi.unstubAllGlobals());

  describe("acceso y línea de corte", () => {
    it("la herramienta Cut está habilitada; sin línea el panel explica cómo dibujarla, no llama al servidor y Apply está deshabilitado", async () => {
      const fetchMock = installWorkspaceFetch({ split: fakeSplit });
      await renderWorkspace();
      expect(toolButton()).toBeEnabled();

      startCut();

      expect(panelOpen()).toBe(true);
      expect(toolButton()).toHaveAttribute("aria-pressed", "true");
      expect(surface()).toBeInTheDocument();
      expect(stateText()).toMatch(/Dibujá la línea de corte: click por cada punto/);
      expect(applyButton()).toBeDisabled();
      expect(screen.queryByTestId("cut-overlay")).not.toBeInTheDocument();
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(splitCalls(fetchMock)).toHaveLength(0);
    });

    it("un solo punto todavía no es una línea: no hay petición; el segundo la completa y pide UNA vez, en unidades (tolerancia 0,01 mm = 0,02 u)", async () => {
      const fetchMock = installWorkspaceFetch({ split: fakeSplit });
      await renderWorkspace();
      startCut();

      clickAt(surface(), 20, -10);
      expect(lineText()).toBe("Línea de corte: 1 punto.");
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(splitCalls(fetchMock)).toHaveLength(0);

      clickAt(surface(), 20, 50);
      await waitFor(() => expect(splitCalls(fetchMock)).toHaveLength(1));

      const body = splitCalls(fetchMock)[0];
      expect(body.cutter).toEqual({ points: [[20, -10], [20, 50]] });
      expect(body.mode).toBe("split");
      expect(body.slotWidth).toBe(0);
      expect(body.extend).toBe(false);
      expect(body.tolerance).toBeCloseTo(0.02, 12);
      expect(fetchMock.urls.filter((url) => url.endsWith("/api/v2/geometry/split"))).toHaveLength(1);
      expect(fetchMock.geometryCalls).toHaveLength(0);
      expect(fetchMock.offsetCalls).toHaveLength(0);
    });

    it("doble click termina la línea (el segundo clic del doble click no suma un punto repetido) y una línea terminada no acepta más puntos", async () => {
      const fetchMock = installWorkspaceFetch({ split: fakeSplit });
      await renderWorkspace();
      startCut();
      clickAt(surface(), 20, -10);
      clickAt(surface(), 20, 50);
      clickAt(surface(), 20, 50); // el segundo click de un doble click: mismo punto
      fireEvent.doubleClick(surface());

      expect(lineText()).toBe("Línea de corte: 2 puntos (terminada).");
      clickAt(surface(), 60, 60);
      expect(lineText()).toBe("Línea de corte: 2 puntos (terminada).");
      await waitFor(() => expect(splitCalls(fetchMock)).toHaveLength(1));
    });

    it("Enter termina la línea en curso; un segundo Enter aplica", async () => {
      const fetchMock = installWorkspaceFetch({ split: fakeSplit });
      const { canvas } = await renderWorkspace();
      await openCutWithLine(canvas, fetchMock);
      expect(lineText()).toBe("Línea de corte: 2 puntos (en curso).");

      press("Enter");
      expect(lineText()).toBe("Línea de corte: 2 puntos (terminada).");
      expect(pathData()).toContain(R1); // terminar no aplica nada

      press("Enter");
      await waitFor(() => expect(pathData()).toContain(R1_LEFT));
    });

    it("Retroceso quita el último punto (y reabre una línea terminada); con menos de 2 puntos se cancela lo que estaba en vuelo", async () => {
      const fetchMock = installWorkspaceFetch({ split: () => new Promise<Response>(() => {}) });
      await renderWorkspace();
      startCut();
      drawVertical();
      await waitFor(() => expect(splitCalls(fetchMock)).toHaveLength(1));
      press("Enter");
      expect(lineText()).toBe("Línea de corte: 2 puntos (terminada).");

      press("Backspace");

      expect(lineText()).toBe("Línea de corte: 1 punto.");
      expect(splitSignals(fetchMock)[0]?.aborted).toBe(true);
      expect(stateText()).toMatch(/Dibujá la línea de corte/);
      press("Backspace");
      expect(lineText()).toBe("Todavía no hay línea de corte.");
      press("Backspace"); // sin puntos no hace nada
      expect(panelOpen()).toBe(true);
    });

    it("Escape borra la línea (la herramienta sigue abierta); con la línea vacía, el siguiente Escape cierra Cut sin rastro", async () => {
      const fetchMock = installWorkspaceFetch({ split: fakeSplit });
      const { canvas } = await renderWorkspace();
      await openCutWithLine(canvas, fetchMock);

      press("Escape");

      expect(panelOpen()).toBe(true);
      expect(lineText()).toBe("Todavía no hay línea de corte.");
      expect(screen.queryByTestId("cut-preview")).not.toBeInTheDocument();
      press("Escape");
      expect(panelOpen()).toBe(false);
      expect(tool(/^Select/)).toHaveAttribute("aria-pressed", "true");
      expect(undoButton()).toBeDisabled();
      expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();
    });

    it("Escape en Cut no limpia la selección del canvas: al cerrar la herramienta los objetos siguen seleccionados", async () => {
      const fetchMock = installWorkspaceFetch({ split: fakeSplit });
      const { canvas } = await renderWorkspace();
      await openCutWithLine(canvas, fetchMock, { select: [R1_AT] });

      press("Escape");
      press("Escape");
      expect(panelOpen()).toBe(false);
      fireEvent.keyDown(canvas, { key: "Delete" });

      await waitFor(() => expect(pathData()).not.toContain(R1)); // Suprimir actuó sobre la selección que quedó
      expect(pathData()).toContain(R2);
    });

    it("un ARRASTRE traza un segmento recto: la línea completa (2 puntos), ya terminada, y pide el resultado", async () => {
      const fetchMock = installWorkspaceFetch({ split: fakeSplit });
      await renderWorkspace();
      startCut();

      dragAlong(surface(), [[20, -10], [25, 20], [20, 50]]);

      expect(lineText()).toBe("Línea de corte: 2 puntos (terminada).");
      await waitFor(() => expect(splitCalls(fetchMock)).toHaveLength(1));
      expect(splitCalls(fetchMock)[0].cutter).toEqual({ points: [[20, -10], [20, 50]] }); // solo los extremos: el trazo del mouse zigzagueó
    });

    it("los botones del panel equivalen al teclado: Terminar línea, Quitar último punto y Borrar línea", async () => {
      const fetchMock = installWorkspaceFetch({ split: fakeSplit });
      const { canvas } = await renderWorkspace();
      await openCutWithLine(canvas, fetchMock);

      fireEvent.click(inPanel().getByRole("button", { name: "Terminar línea" }));
      expect(lineText()).toMatch(/terminada/);
      fireEvent.click(inPanel().getByRole("button", { name: "Quitar último punto" }));
      expect(lineText()).toBe("Línea de corte: 1 punto.");
      fireEvent.click(inPanel().getByRole("button", { name: "Borrar línea" }));
      expect(lineText()).toBe("Todavía no hay línea de corte.");
    });

    it("cambiar a otra herramienta cancela sin rastro, aborta lo que estaba en vuelo, cierra el panel y la superficie", async () => {
      const fetchMock = installWorkspaceFetch({ split: () => new Promise<Response>(() => {}) });
      await renderWorkspace();
      startCut();
      drawVertical();
      await waitFor(() => expect(splitCalls(fetchMock)).toHaveLength(1));

      fireEvent.click(tool(/^Select/));

      expect(panelOpen()).toBe(false);
      expect(splitSignals(fetchMock)[0]?.aborted).toBe(true);
      expect(screen.queryByTestId("cut-surface")).not.toBeInTheDocument();
      expect(screen.queryByTestId("cut-overlay")).not.toBeInTheDocument();
      expect(undoButton()).toBeDisabled();
      // Volver a abrir Cut empieza de cero.
      startCut();
      expect(lineText()).toBe("Todavía no hay línea de corte.");
    });

    it("en la herramienta Cut el canvas no mueve ni borra la selección: las flechas y Suprimir no hacen nada", async () => {
      const fetchMock = installWorkspaceFetch({ split: fakeSplit });
      const { canvas } = await renderWorkspace();
      selectObjects(canvas, R1_AT);
      startCut();

      fireEvent.keyDown(canvas, { key: "ArrowRight" });
      fireEvent.keyDown(canvas, { key: "Delete" });

      expect(undoButton()).toBeDisabled();
      expect(pathData()).toContain(R1);
      expect(splitCalls(fetchMock)).toHaveLength(0);
    });
  });

  describe("alcance", () => {
    it("con selección corta SOLO los seleccionados aunque la línea cruce otros: un solo subject en la petición", async () => {
      const fetchMock = installWorkspaceFetch({ split: fakeSplit });
      const { canvas } = await renderWorkspace();

      await openCutWithLine(canvas, fetchMock, { select: [R1_AT], y1: 150 });

      expect(subjectsOf(splitCalls(fetchMock)[0])).toEqual([{ type: "polygon", coordinates: [[[0, 0], [40, 0], [40, 40], [0, 40]]] }]);
      expect(inPanel().getByText("Alcance: la selección (1 objeto).")).toBeInTheDocument();
      expect(stateText()).toBe("Se cortarán 1 objeto: Rojo · objeto 1. Resultado: 2 piezas.");
    });

    it("sin selección corta TODOS los objetos que la línea cruza y los LISTA antes de aplicar", async () => {
      const fetchMock = installWorkspaceFetch({ split: fakeSplit });
      const { canvas } = await renderWorkspace();

      await openCutWithLine(canvas, fetchMock, { y1: 150 });

      expect(subjectsOf(splitCalls(fetchMock)[0])).toHaveLength(2); // r1 y r2: ni b1 ni la línea ln1
      expect(inPanel().getByText(/Alcance: sin selección, se cortan todos los objetos visibles y desbloqueados que la línea cruza\./)).toBeInTheDocument();
      expect(stateText()).toBe("Se cortarán 2 objetos: Rojo · objeto 1, Rojo · objeto 2. Resultado: 4 piezas.");
      expect(pathData()).toEqual(expect.arrayContaining([R1, R2])); // listados, todavía sin aplicar
    });

    it("una línea que no cruza ningún objeto lo dice (sin selección) y no llama al servidor", async () => {
      const fetchMock = installWorkspaceFetch({ split: fakeSplit });
      await renderWorkspace();
      startCut();

      clickAt(surface(), 280, 10);
      clickAt(surface(), 280, 60);

      await waitFor(() => expect(inPanel().getByRole("alert")).toHaveTextContent(/La línea de corte no cruza ningún objeto visible y desbloqueado/));
      expect(applyButton()).toBeDisabled();
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(splitCalls(fetchMock)).toHaveLength(0);
    });

    it("objetos de una capa BLOQUEADA se omiten e informan; los libres se cortan", async () => {
      const fetchMock = installWorkspaceFetch({ lockedA: true, split: fakeSplit });
      await renderWorkspace();
      startCut();

      // Cruza el borde de r2 (capa Rojo, bloqueada) y el de b1 (capa Azul): solo b1 viaja.
      clickAt(surface(), 20, 110);
      clickAt(surface(), 120, 120);

      await waitFor(() => expect(splitCalls(fetchMock)).toHaveLength(1));
      expect(subjectsOf(splitCalls(fetchMock)[0])).toEqual([{ type: "polygon", coordinates: [[[100, 100], [140, 100], [140, 140], [100, 140]]] }]);
      await waitFor(() => expect(inPanel().getByRole("list", { name: "Advertencias del corte" })).toHaveTextContent("1 objeto en una capa bloqueada se omite: no se modifica."));
    });

    it("objetos de una capa OCULTA se omiten e informan", async () => {
      const fetchMock = installWorkspaceFetch({ hiddenB: true, split: fakeSplit });
      await renderWorkspace({ minPaths: 3 });
      startCut();

      clickAt(surface(), 20, 110);
      clickAt(surface(), 120, 120);

      await waitFor(() => expect(splitCalls(fetchMock)).toHaveLength(1));
      expect(subjectsOf(splitCalls(fetchMock)[0])).toHaveLength(1); // solo r2
      await waitFor(() => expect(inPanel().getByRole("list", { name: "Advertencias del corte" })).toHaveTextContent("1 objeto en una capa oculta se omite: no se modifica."));
    });

    it("si todo lo que la línea cruza está en capas bloqueadas, se explica y no hay petición", async () => {
      const fetchMock = installWorkspaceFetch({ lockedA: true, split: fakeSplit });
      await renderWorkspace();
      startCut();

      drawVertical(-10, 150);

      await waitFor(() => expect(inPanel().getByRole("alert")).toHaveTextContent(/solo cruza objetos de capas bloqueadas u ocultas \(2\)/));
      expect(applyButton()).toBeDisabled();
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(splitCalls(fetchMock)).toHaveLength(0);
    });
  });

  describe("modos y opciones", () => {
    it("Separar con hueco manda el modo y el ancho de la ranura en unidades (0,2 mm = 0,4 u); cambiar el ancho vuelve a pedir (0,5 mm = 1 u)", async () => {
      const fetchMock = installWorkspaceFetch({ split: fakeSplit });
      const { canvas } = await renderWorkspace();
      selectObjects(canvas, R1_AT);
      startCut();
      expect(inPanel().queryByLabelText(/Ancho de la ranura/)).not.toBeInTheDocument();
      fireEvent.click(inPanel().getByRole("radio", { name: "Separar con hueco" }));
      expect(inPanel().getByText(/Modo activo: Separar con hueco\./)).toBeInTheDocument();
      drawVertical();
      await waitFor(() => expect(splitCalls(fetchMock)).toHaveLength(1));

      expect(splitCalls(fetchMock)[0].mode).toBe("slot");
      expect(splitCalls(fetchMock)[0].slotWidth).toBeCloseTo(0.4, 12);

      const field = inPanel().getByLabelText("Ancho de la ranura (mm)");
      fireEvent.change(field, { target: { value: "0,5" } });
      fireEvent.keyDown(field, { key: "Enter" });
      await waitFor(() => expect(splitCalls(fetchMock)).toHaveLength(2));
      expect(splitCalls(fetchMock)[1].slotWidth).toBeCloseTo(1, 12);
    });

    it("un ancho inválido (0, texto, más de 100 mm) se rechaza con mensaje y NO llama al servidor", async () => {
      const fetchMock = installWorkspaceFetch({ split: fakeSplit });
      const { canvas } = await renderWorkspace();
      selectObjects(canvas, R1_AT);
      startCut();
      fireEvent.click(inPanel().getByRole("radio", { name: "Separar con hueco" }));
      const field = inPanel().getByLabelText("Ancho de la ranura (mm)");

      for (const value of ["0", "abc", "101", "0,001"]) {
        fireEvent.change(field, { target: { value } });
        fireEvent.keyDown(field, { key: "Enter" });
        expect(inPanel().getByRole("alert")).toHaveTextContent(/Ancho de la ranura/);
      }
      drawVertical(); // el valor vigente sigue siendo 0,2 mm
      await waitFor(() => expect(splitCalls(fetchMock)).toHaveLength(1));
      expect(splitCalls(fetchMock)[0].slotWidth).toBeCloseTo(0.4, 12);
    });

    it("el modo se puede cambiar con la línea ya dibujada: vuelve a pedir con el modo nuevo (y volver a Dividir manda ancho 0)", async () => {
      const fetchMock = installWorkspaceFetch({ split: fakeSplit });
      const { canvas } = await renderWorkspace();
      await openCutWithLine(canvas, fetchMock, { select: [R1_AT] });

      fireEvent.click(inPanel().getByRole("radio", { name: "Separar con hueco" }));
      await waitFor(() => expect(splitCalls(fetchMock)).toHaveLength(2));
      fireEvent.click(inPanel().getByRole("radio", { name: "Dividir" }));
      await waitFor(() => expect(splitCalls(fetchMock)).toHaveLength(3));

      expect(splitCalls(fetchMock).map((body) => body.mode)).toEqual(["split", "slot", "split"]);
      expect(splitCalls(fetchMock)[2].slotWidth).toBe(0);
    });

    it("SIN escala física trabaja en unidades (no inventa mm): aviso visible, campo en u y el ancho viaja tal cual", async () => {
      const fetchMock = installWorkspaceFetch({ split: fakeSplit });
      const { canvas } = await renderWorkspace({ dimensionWidthMm: null });
      selectObjects(canvas, R1_AT);
      startCut();
      fireEvent.click(inPanel().getByRole("radio", { name: "Separar con hueco" }));
      drawVertical();
      await waitFor(() => expect(splitCalls(fetchMock)).toHaveLength(1));

      expect(inPanel().getByRole("note")).toHaveTextContent(/Sin escala física: el corte es en unidades del documento/);
      expect(inPanel().getByLabelText("Ancho de la ranura (u)")).toBeInTheDocument();
      expect(splitCalls(fetchMock)[0].slotWidth).toBe(0.2);
      expect(splitCalls(fetchMock)[0].tolerance).toBe(0.01);
    });

    it("CON escala física no hay aviso de escala", async () => {
      installWorkspaceFetch({ split: fakeSplit });
      await renderWorkspace();
      startCut();

      expect(inPanel().queryByRole("note")).not.toBeInTheDocument();
    });
  });

  describe("un corte que no atraviesa no divide, salvo «Extender»", () => {
    async function openShortCut() {
      const fetchMock = installWorkspaceFetch({ split: fakeSplit });
      const { canvas } = await renderWorkspace();
      selectObjects(canvas, R1_AT);
      startCut();
      clickAt(surface(), 20, -10);
      clickAt(surface(), 20, 20); // termina DENTRO de r1 (0..40)
      await waitFor(() => expect(splitCalls(fetchMock)).toHaveLength(1));
      await waitFor(() => expect(stateText()).toMatch(/Ningún objeto cambia/));
      return { fetchMock, canvas };
    }

    it("el panel nombra el objeto, dice que queda intacto y qué hacer; Apply y Enter no aplican nada", async () => {
      await openShortCut();
      const before = pathData();

      const warnings = inPanel().getByRole("list", { name: "Advertencias del corte" });
      expect(warnings).toHaveTextContent("El corte no atraviesa completamente «Rojo · objeto 1»: queda intacto. Prolongá la línea o activá «Extender el corte hasta cruzar todo».");
      expect(applyButton()).toBeDisabled();
      expect(applyButton().getAttribute("title")).toMatch(/no atraviesa completamente «Rojo · objeto 1»: ningún objeto cambia/);
      expect(screen.getAllByTestId("cut-intact")).toHaveLength(1); // se marca en el canvas
      press("Enter"); // termina la línea
      press("Enter"); // Apply deshabilitado: no-op
      fireEvent.click(applyButton());
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(pathData()).toEqual(before);
      expect(undoButton()).toBeDisabled();
      expect(panelOpen()).toBe(true);
    });

    it("«Extender el corte hasta cruzar todo» hace que sí atraviese: pide con extend:true, se ve la prolongación y Apply se habilita", async () => {
      const { fetchMock } = await openShortCut();

      fireEvent.click(inPanel().getByRole("checkbox", { name: "Extender el corte hasta cruzar todo" }));
      await waitFor(() => expect(splitCalls(fetchMock)).toHaveLength(2));

      expect(splitCalls(fetchMock)[1].extend).toBe(true);
      expect(splitCalls(fetchMock)[1].cutter).toEqual({ points: [[20, -10], [20, 20]] }); // el servidor prolonga: el cliente manda la línea dibujada
      await waitFor(() => expect(stateText()).toBe("Se cortarán 1 objeto: Rojo · objeto 1. Resultado: 2 piezas."));
      expect(screen.getAllByTestId("cut-extension")).toHaveLength(2);
      expect(screen.queryByTestId("cut-intact")).not.toBeInTheDocument();
      expect(applyButton()).toBeEnabled();
    });
  });

  describe("preview", () => {
    it("dibuja las piezas de colores distintos y atenúa el original, sin tocar el documento ni la pila de undo", async () => {
      const fetchMock = installWorkspaceFetch({ split: fakeSplit });
      const { canvas } = await renderWorkspace();
      const before = pathData();

      await openCutWithLine(canvas, fetchMock, { select: [R1_AT] });

      const pieces = screen.getByTestId("cut-pieces").querySelectorAll("path");
      expect(pieces).toHaveLength(2);
      expect([...pieces].map((piece) => piece.getAttribute("d"))).toEqual([R1_LEFT, R1_RIGHT]);
      expect(pieces[0].getAttribute("fill")).not.toBe(pieces[1].getAttribute("fill"));
      expect(screen.getAllByTestId("cut-veil")).toHaveLength(1);
      expect(pathData()).toEqual(before);
      expect(undoButton()).toBeDisabled();
      expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();
      expect(screen.getByTestId("cut-preview")).toBeInTheDocument(); // la línea dibujada sigue a la vista
    });

    it("varios cambios seguidos piden UNA vez con la última línea (debounce) y cada cambio aborta lo que estaba en vuelo", async () => {
      const releases: Array<() => void> = [];
      const fetchMock = installWorkspaceFetch({
        split: (body) =>
          new Promise<Response>((resolve) => {
            releases.push(() => resolve(fakeSplit(body)));
          }),
      });
      const { canvas } = await renderWorkspace();
      selectObjects(canvas, R1_AT);
      startCut();
      drawVertical();
      await waitFor(() => expect(splitCalls(fetchMock)).toHaveLength(1));

      clickAt(surface(), 30, 50);
      clickAt(surface(), 35, 50);
      clickAt(surface(), 38, 50);

      expect(splitSignals(fetchMock)[0]?.aborted).toBe(true); // la primera se abortó al primer cambio
      await waitFor(() => expect(splitCalls(fetchMock)).toHaveLength(2));
      expect((splitCalls(fetchMock)[1].cutter as { points: number[][] }).points).toHaveLength(5); // solo la última salió, con los 5 puntos
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(splitCalls(fetchMock)).toHaveLength(2);
      releases[1]();
      await waitFor(() => expect(stateText()).toMatch(/Se cortarán/));
    });

    it("una respuesta tardía de una petición abortada jamás se muestra", async () => {
      const releases: Array<() => void> = [];
      const fetchMock = installWorkspaceFetch({
        split: (body) =>
          new Promise<Response>((resolve) => {
            releases.push(() => resolve(fakeSplit(body)));
          }),
      });
      const { canvas } = await renderWorkspace();
      selectObjects(canvas, R1_AT);
      startCut();
      drawVertical();
      await waitFor(() => expect(splitCalls(fetchMock)).toHaveLength(1));

      clickAt(surface(), 30, 50); // aborta la 1ª
      releases[0](); // llega tarde
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(stateText()).not.toMatch(/Se cortarán/);
      expect(screen.queryByTestId("cut-pieces")?.children.length ?? 0).toBe(0);
      expect(applyButton()).toBeDisabled();
    });

    it("StrictMode: UNA sola llamada al servidor al dibujar la línea", async () => {
      const fetchMock = installWorkspaceFetch({ split: fakeSplit });
      const { canvas } = await renderWorkspace({ strict: true });

      await openCutWithLine(canvas, fetchMock, { select: [R1_AT] });
      await new Promise((resolve) => setTimeout(resolve, 400));

      expect(splitCalls(fetchMock)).toHaveLength(1);
      expect(splitSignals(fetchMock)[0]?.aborted).toBe(false);
    });

    it("Apply no se habilita hasta que llega el resultado (ni con el botón ni con Enter); recién ahí aplica, con una sola llamada", async () => {
      let release: () => void = () => {};
      const fetchMock = installWorkspaceFetch({
        split: (body) =>
          new Promise<Response>((resolve) => {
            release = () => resolve(fakeSplit(body));
          }),
      });
      const { canvas } = await renderWorkspace();
      selectObjects(canvas, R1_AT);
      startCut();
      drawVertical();
      await waitFor(() => expect(splitCalls(fetchMock)).toHaveLength(1));
      expect(applyButton()).toBeDisabled(); // sin resultado todavía
      expect(applyButton().getAttribute("title")).toBe("Esperando el resultado del servidor…");

      press("Enter"); // termina
      press("Enter"); // Apply bloqueado: Esperando el resultado
      expect(pathData()).toContain(R1);
      expect(undoButton()).toBeDisabled();

      release();
      await waitFor(() => expect(stateText()).toMatch(/Se cortarán/));
      fireEvent.click(applyButton());
      await waitFor(() => expect(pathData()).toContain(R1_LEFT));
      expect(splitCalls(fetchMock)).toHaveLength(1);
    });
  });

  describe("aplicar: un comando atómico undoable", () => {
    it("dividir: el objeto se reemplaza por sus piezas EN SU LUGAR, en su capa y con su color; un solo Deshacer devuelve el documento exacto", async () => {
      const fetchMock = installWorkspaceFetch({ split: fakeSplit });
      const { canvas } = await renderWorkspace();
      const before = pathData();
      await openCutWithLine(canvas, fetchMock, { select: [R1_AT] });

      fireEvent.click(applyButton());

      await waitFor(() => expect(pathData()).toContain(R1_LEFT));
      expect(pathData()).toEqual([R1_LEFT, R1_RIGHT, ...before.filter((d) => d !== R1)]); // las piezas ocupan el lugar de r1
      expect(pathData()).not.toContain(R1);
      expect(pathByData(R1_LEFT)!.fill()).toBe("#ff0000");
      expect(pathByData(R1_RIGHT)!.fill()).toBe("#ff0000");
      expect(panelOpen()).toBe(false); // vuelve a Select
      expect(tool(/^Select/)).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByText(GEOMETRY_DIRTY)).toBeInTheDocument();
      expect(screen.getByText(/Corte aplicado dividiendo: 1 objeto → 2 piezas, en la capa de cada original\./)).toBeInTheDocument();
      expect(splitCalls(fetchMock)).toHaveLength(1); // Apply usó el resultado ya calculado

      fireEvent.click(undoButton());
      expect(pathData()).toEqual(before); // un único comando: un solo Deshacer devuelve todo, en el mismo orden
      expect(undoButton()).toBeDisabled();
      fireEvent.click(redoButton());
      expect(pathData()).toEqual([R1_LEFT, R1_RIGHT, ...before.filter((d) => d !== R1)]);
    });

    it("las piezas son objetos con ids nuevos: Deshacer restaura el original y el recuento de paths de la capa sigue al total", async () => {
      const fetchMock = installWorkspaceFetch({ split: fakeSplit });
      const { canvas } = await renderWorkspace();
      await openCutWithLine(canvas, fetchMock, { select: [R1_AT] });
      fireEvent.click(applyButton());
      await waitFor(() => expect(pathData()).toContain(R1_LEFT));

      // La capa Rojo tenía 2 paths (r1, r2) y ahora tiene 3 (dos piezas + r2).
      const pathsOf = () => screen.getByText("Paths").nextElementSibling!.textContent;
      fireEvent.click(screen.getByRole("button", { name: "Seleccionar la capa Rojo" }));
      expect(pathsOf()).toBe("3");

      fireEvent.click(undoButton());
      expect(pathsOf()).toBe("2");
    });

    it("la etiqueta del comando describe el corte en el botón Deshacer", async () => {
      const fetchMock = installWorkspaceFetch({ split: fakeSplit });
      const { canvas } = await renderWorkspace();
      await openCutWithLine(canvas, fetchMock, { select: [R1_AT] });

      fireEvent.click(applyButton());

      await waitFor(() => expect(undoButton()).toBeEnabled());
      expect(undoButton().getAttribute("title") ?? undoButton().getAttribute("aria-label")).toMatch(/Cortar: dividir \(1 objeto → 2 piezas\)/);
      expectLastCommand("geometry.split"); // M3-S12
    });

    it("Separar con hueco: las piezas quedan separadas por la ranura (0,5 mm = 1 u) y la etiqueta lo dice", async () => {
      installWorkspaceFetch({ split: fakeSplit });
      const { canvas } = await renderWorkspace();
      selectObjects(canvas, R1_AT);
      startCut();
      fireEvent.click(inPanel().getByRole("radio", { name: "Separar con hueco" }));
      const field = inPanel().getByLabelText("Ancho de la ranura (mm)");
      fireEvent.change(field, { target: { value: "0,5" } });
      fireEvent.keyDown(field, { key: "Enter" });
      drawVertical();
      await waitFor(() => expect(stateText()).toMatch(/Se cortarán/));

      fireEvent.click(applyButton());

      await waitFor(() => expect(pathData()).toContain("M0 0 L19.5 0 L19.5 40 L0 40 Z"));
      expect(pathData()).toContain("M20.5 0 L40 0 L40 40 L20.5 40 Z");
      expect(undoButton().getAttribute("title") ?? undoButton().getAttribute("aria-label")).toMatch(/Cortar: ranura de 0\.5 mm/);
      expect(screen.getByText(/Corte aplicado con una ranura de 0\.5 mm/)).toBeInTheDocument();
    });

    it("sin selección corta todos los cruzados en UN comando; Deshacer los devuelve a todos", async () => {
      const fetchMock = installWorkspaceFetch({ split: fakeSplit });
      const { canvas } = await renderWorkspace();
      const before = pathData();
      await openCutWithLine(canvas, fetchMock, { y1: 150 });

      fireEvent.click(applyButton());

      await waitFor(() => expect(pathData()).toContain(R2_LEFT));
      expect(pathData()).toEqual(expect.arrayContaining([R1_LEFT, R1_RIGHT, R2_LEFT, R2_RIGHT]));
      expect(pathData()).toHaveLength(before.length + 2);
      fireEvent.click(undoButton());
      expect(pathData()).toEqual(before);
      expect(undoButton()).toBeDisabled();
    });

    it("un trazo (línea abierta) se parte en dos tramos que conservan su color y su capa; los demás objetos no se tocan", async () => {
      const fetchMock = installWorkspaceFetch({ split: fakeSplit });
      await renderWorkspace();
      startCut();
      clickAt(surface(), 230, 0);
      clickAt(surface(), 230, 40);
      await waitFor(() => expect(stateText()).toMatch(/Se cortarán 1 objeto: Líneas · objeto 1/));

      fireEvent.click(applyButton());

      await waitFor(() => expect(pathData()).not.toContain(LN1));
      expect(pathData()).toEqual(expect.arrayContaining(["M200 20 L230 20", "M230 20 L260 20", R1, R2]));
      expect(pathByData("M200 20 L230 20")!.stroke()).toBe("#00aa00");
      expect(pathByData("M230 20 L260 20")!.fill()).toBeFalsy();
      expect(splitCalls(fetchMock)[0].subjects).toEqual([{ type: "line", coordinates: [[200, 20], [260, 20]] }]);
    });

    it("Cancel cierra sin rastro (ni comando ni geometría sin guardar) y el botón aborta lo que estaba en vuelo", async () => {
      const fetchMock = installWorkspaceFetch({ split: () => new Promise<Response>(() => {}) });
      const { canvas } = await renderWorkspace();
      selectObjects(canvas, R1_AT);
      startCut();
      drawVertical();
      await waitFor(() => expect(splitCalls(fetchMock)).toHaveLength(1));

      fireEvent.click(cancelButton());

      expect(panelOpen()).toBe(false);
      expect(splitSignals(fetchMock)[0]?.aborted).toBe(true);
      expect(undoButton()).toBeDisabled();
      expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();
      expect(pathData()).toContain(R1);
    });

    it("tras aplicar, la selección queda en las piezas nuevas (Suprimir elimina esas dos y solo esas)", async () => {
      const fetchMock = installWorkspaceFetch({ split: fakeSplit });
      const { canvas } = await renderWorkspace();
      await openCutWithLine(canvas, fetchMock, { select: [R1_AT] });

      fireEvent.click(applyButton());
      await waitFor(() => expect(pathData()).toContain(R1_LEFT));
      fireEvent.keyDown(canvas, { key: "Delete" });

      await waitFor(() => expect(pathData()).not.toContain(R1_LEFT));
      expect(pathData()).not.toContain(R1_RIGHT);
      expect(pathData()).toContain(R2);
    });

    it("Deshacer tras el corte vuelve a seleccionar el objeto original", async () => {
      const fetchMock = installWorkspaceFetch({ split: fakeSplit });
      const { canvas } = await renderWorkspace();
      await openCutWithLine(canvas, fetchMock, { select: [R1_AT] });
      fireEvent.click(applyButton());
      await waitFor(() => expect(pathData()).toContain(R1_LEFT));

      fireEvent.click(undoButton());
      fireEvent.keyDown(canvas, { key: "Delete" });

      await waitFor(() => expect(pathData()).not.toContain(R1));
      expect(pathData()).toContain(R2);
    });
  });

  describe("errores del servidor: nada cambia", () => {
    it("un error del servidor es recuperable: mensaje claro, Apply deshabilitado, el documento intacto; Reintentar se recupera", async () => {
      let fail = true;
      const fetchMock = installWorkspaceFetch({ split: (body) => (fail ? jsonResponse({ code: "processing_error", message: "boom" }, 500) : fakeSplit(body)) });
      const { canvas } = await renderWorkspace();
      const before = pathData();
      selectObjects(canvas, R1_AT);
      startCut();
      drawVertical();

      await waitFor(() => expect(inPanel().getByRole("alert")).toHaveTextContent(/El servidor no pudo completar el cálculo\. No se modificó nada\./));
      expect(applyButton()).toBeDisabled();
      expect(pathData()).toEqual(before);
      expect(undoButton()).toBeDisabled();
      expect(splitCalls(fetchMock)).toHaveLength(1);

      fail = false;
      fireEvent.click(inPanel().getByRole("button", { name: "Reintentar" }));
      await waitFor(() => expect(stateText()).toMatch(/Se cortarán 1 objeto/));
      expect(applyButton()).toBeEnabled();
      expect(splitCalls(fetchMock)).toHaveLength(2);
    });

    it("un código propio del corte (línea rechazada) se explica con el texto del corte", async () => {
      installWorkspaceFetch({ split: () => jsonResponse({ code: "invalid_cutter", message: "x" }, 400) });
      const { canvas } = await renderWorkspace();
      selectObjects(canvas, R1_AT);
      startCut();
      drawVertical();

      await waitFor(() => expect(inPanel().getByRole("alert")).toHaveTextContent(/rechazó la línea de corte.*No se modificó nada/));
    });

    it("una respuesta incoherente (otro modo del pedido) NO se aplica ni se muestra como válida", async () => {
      installWorkspaceFetch({ split: (body) => jsonResponse({ ...splitPayload(body), mode: "slot" }) });
      const { canvas } = await renderWorkspace();
      const before = pathData();
      selectObjects(canvas, R1_AT);
      startCut();
      drawVertical();

      await waitFor(() => expect(inPanel().getByRole("alert")).toHaveTextContent(/respuesta incoherente.*No se modificó nada/));
      expect(applyButton()).toBeDisabled();
      expect(pathData()).toEqual(before);
      expect(undoButton()).toBeDisabled();
    });

    it("un fallo de red no modifica nada", async () => {
      installWorkspaceFetch({ split: () => Promise.reject(new TypeError("Failed to fetch")) });
      const { canvas } = await renderWorkspace();
      const before = pathData();
      selectObjects(canvas, R1_AT);
      startCut();
      drawVertical();

      await waitFor(() => expect(inPanel().getByRole("alert")).toHaveTextContent(/No se pudo contactar con el servidor\. No se modificó nada\./));
      expect(pathData()).toEqual(before);
    });
  });
});
