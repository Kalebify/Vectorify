import Konva from "konva";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectLastCommand } from "../../test/history";
import { installResizeObserver, installWorkspaceFetch, jsonResponse, R2, renderWorkspace, tool, toScreen, undoButton } from "../../test/workspaceFixture";

/**
 * Integración del Laser Checker (M3-S14) en el Workspace completo: botón del header, análisis del documento editado en memoria, estado Ready / Review / Blocking, lista de
 * issues, click => selección + vista centrada + overlay, teclado (↑/↓, Enter, Escape y foco), re-análisis tras mutaciones (resultado desactualizado mientras tanto),
 * relevancia por operación, piezas flotantes del servidor de S11 (resultado, fallo, StrictMode) y que el panel NO es una herramienta.
 *
 * Documento 320 x 240 u con 0,5 mm por unidad, contenedor de 800 x 600. Capas: Rojo (CUT: o1 = path ABIERTO 0..40², r2 = cuadrado 0..40 x 100..140 y dup = copia exacta de r2),
 * Azul (CUT: b1 = cuadrado 100..140²) y Líneas (ENGRAVE: una línea abierta). Problemas esperados: path abierto (o1) y duplicado exacto (dup).
 */

const OPEN1 = "M0 0 H40 V40 H0";
const RING = "M200 0 H240 V40 H200 Z M210 10 H230 V30 H210 Z";
const SVG = {
  A: `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><path data-vid="o1" d="${OPEN1}" fill="#ff0000"/><path data-vid="r2" d="${R2}" fill="#ff0000"/><path data-vid="dup" d="${R2}" fill="#ff0000"/></svg>`,
};
const OPERATIONS = { A: "cut", B: "cut", C: "engrave" } as const;

type Body = Record<string, unknown>;

/** Hoja sin islas (el servidor de flotantes no encuentra nada), o con las islas que se pidan. */
function floatingReply(body: Body, islands: Array<{ subject: number; bounds: [number, number, number, number] }> = []): Response {
  const sheet = { id: 0, kind: "principal", depth: 0, parent: null, polygon: null, area: null, bounds: [0, 0, 320, 240], subjects: [] };
  const floating = islands.map((island, index) => {
    const [x0, y0, x1, y1] = island.bounds;
    return { id: index + 1, kind: "floating", depth: 1, parent: 0, polygon: { type: "polygon", coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] }, area: (x1 - x0) * (y1 - y0), bounds: island.bounds, subjects: [island.subject] };
  });
  return jsonResponse({ mode: body.mode, tolerance: body.tolerance, components: [sheet, ...floating], floatingCount: floating.length, mainCount: 1, discarded: 0 });
}

const BASE = { svg: SVG, operations: OPERATIONS, floating: (body: Body) => floatingReply(body) };

const toggle = () => screen.getByRole("button", { name: "Laser Check" });
const panel = () => screen.getByRole("region", { name: "Laser Check" });
const panelOpen = () => screen.queryByRole("region", { name: "Laser Check" }) !== null;
const inPanel = () => within(panel());
const options = () => inPanel().queryAllByRole("option");
const badge = () => screen.getByTestId("laser-check-status");
const summary = () => screen.getByTestId("laser-check-summary").textContent ?? "";
const kindOf = (row: HTMLElement) => row.getAttribute("data-kind");
const rowFor = (text: RegExp) => options().find((row) => text.test(row.textContent ?? ""))!;
const selectedPaths = () => (Konva.stages[Konva.stages.length - 1].findOne("Transformer") as Konva.Transformer).nodes().map((node) => (node as Konva.Path).data());
const press = (key: string) => fireEvent.keyDown(screen.getByRole("application"), { key });

async function openPanel(fetchMock: ReturnType<typeof installWorkspaceFetch>) {
  fireEvent.click(toggle());
  await waitFor(() => expect(options().length).toBeGreaterThan(0));
  await waitFor(() => expect(fetchMock.floatingCalls).toHaveLength(1));
  await waitFor(() => expect(badge()).toHaveTextContent("Blocking"));
}

/** Dónde cae el punto (x, y) del documento en la pantalla según la transformación del overlay (translate + scale). */
function overlayPoint(x: number, y: number) {
  const transform = document.querySelector('[data-testid="laser-check-overlay"] > g')!.getAttribute("transform")!;
  const [, ox, oy, scale] = /translate\(([-\d.e]+) ([-\d.e]+)\) scale\(([-\d.e]+)\)/.exec(transform)!.map(Number);
  return { x: ox + scale * x, y: oy + scale * y, scale };
}

describe("EditorShell — Laser Checker (M3-S14)", () => {
  beforeEach(() => installResizeObserver());
  afterEach(() => vi.unstubAllGlobals());

  describe("apertura y análisis", () => {
    it("el botón del header abre el panel, que analiza el documento editado y muestra el estado global, cada issue con su capa, objeto y acción sugerida", async () => {
      const fetchMock = installWorkspaceFetch(BASE);
      await renderWorkspace();
      expect(toggle()).toHaveAttribute("aria-expanded", "false");
      expect(panelOpen()).toBe(false);

      await openPanel(fetchMock);

      expect(toggle()).toHaveAttribute("aria-expanded", "true");
      expect(panel()).toHaveFocus();
      expect(badge()).toHaveTextContent("Blocking");
      expect(summary()).toBe("Laser Check: Blocking. 2 bloqueantes y 0 avisos.");
      expect(options().map(kindOf)).toEqual(["open_path", "duplicate_exact"]);
      const open = options()[0];
      expect(open).toHaveTextContent("Bloqueante");
      expect(open).toHaveTextContent("Path abierto");
      expect(open).toHaveTextContent("Capa «Rojo» (Corte) · Rojo · objeto 1");
      expect(open).toHaveTextContent("Acción sugerida: Cerrar el path o asignar la capa a Engrave.");
      expect(options()[1]).toHaveTextContent("Duplicado exacto");
      expect(options()[1]).toHaveTextContent("Rojo · objeto 3 coincide exactamente con Rojo · objeto 2");
      expect(inPanel().getByText(/Se analizaron 3 capas \(5 objetos\)\./)).toBeInTheDocument();
    });

    it("no es una herramienta: la herramienta activa no cambia y la barra no tiene un botón nuevo", async () => {
      const fetchMock = installWorkspaceFetch(BASE);
      await renderWorkspace();

      await openPanel(fetchMock);

      expect(tool(/^Select/)).toHaveAttribute("aria-pressed", "true");
      expect(screen.queryByRole("button", { name: /^Laser Check/, pressed: true })).not.toBeInTheDocument();
      const toolbar = screen.getByRole("navigation", { name: "Herramientas del editor" });
      expect(within(toolbar).queryByRole("button", { name: /Laser/ })).not.toBeInTheDocument();
      expect(undoButton()).toBeDisabled(); // analizar no toca la pila de undo
    });

    it("las flotantes viajan al servicio de S11: UNA petición con las formas con relleno de las capas CUT, en stencil y con la tolerancia en unidades", async () => {
      const fetchMock = installWorkspaceFetch(BASE);
      await renderWorkspace();

      await openPanel(fetchMock);

      expect(fetchMock.floatingCalls).toHaveLength(1);
      const body = fetchMock.floatingCalls[0] as { mode: string; tolerance: number; subjects: unknown[] };
      expect(body.mode).toBe("stencil");
      expect(body.tolerance).toBeCloseTo(0.02, 12);
      expect(body.subjects).toHaveLength(4); // o1, r2, dup y b1 (la línea de la capa ENGRAVE no entra)
    });

    it("StrictMode: el análisis de flotantes sale UNA sola vez", async () => {
      const fetchMock = installWorkspaceFetch(BASE);
      await renderWorkspace({ strict: true });

      await openPanel(fetchMock);
      await new Promise((resolve) => setTimeout(resolve, 450));

      expect(fetchMock.floatingCalls).toHaveLength(1);
    });

    it("sin escala física avisa que los umbrales se miden en unidades", async () => {
      const fetchMock = installWorkspaceFetch(BASE);
      await renderWorkspace({ dimensionWidthMm: null });

      await openPanel(fetchMock);

      expect(inPanel().getByRole("note")).toHaveTextContent(/Sin escala física: los umbrales/);
    });

    it("una capa ENGRAVE no genera «path abierto»: con la capa Rojo en Grabado queda solo el duplicado", async () => {
      const fetchMock = installWorkspaceFetch({ ...BASE, operations: { A: "engrave", B: "cut", C: "engrave" } });
      await renderWorkspace();

      fireEvent.click(toggle());
      await waitFor(() => expect(options().length).toBeGreaterThan(0));
      await waitFor(() => expect(fetchMock.floatingCalls).toHaveLength(1));

      expect(options().map(kindOf)).toEqual(["duplicate_exact"]);
    });

    it("una capa ignorada no se analiza y las sin operación se analizan como Corte diciéndolo", async () => {
      installWorkspaceFetch({ ...BASE, operations: { B: "cut", C: "engrave", A: "ignore" } });
      const { unmount } = await renderWorkspace();
      fireEvent.click(toggle());
      await waitFor(() => expect(badge()).toHaveAttribute("data-status", "review"));
      expect(options()).toHaveLength(0);
      expect(inPanel().getByText(/Ignoradas por su operación: Rojo\./)).toBeInTheDocument();
      unmount();

      installWorkspaceFetch({ ...BASE, operations: { B: "cut", C: "engrave" } }); // Rojo sin operación
      await renderWorkspace();
      fireEvent.click(toggle());
      await waitFor(() => expect(options().length).toBeGreaterThan(0));
      expect(options().map(kindOf)).toEqual(["open_path", "duplicate_exact", "unassigned_layer"]);
      expect(options()[0]).toHaveTextContent("Capa «Rojo» (Sin operación)");
      expect(options()[0]).toHaveTextContent("La capa no tiene operación asignada: se analizó como Corte.");
    });
  });

  describe("click en un issue: seleccionar, centrar y resaltar", () => {
    it("click en el path abierto SELECCIONA el objeto, CENTRA la vista en él (zoom 6) y lo RESALTA en el overlay", async () => {
      const fetchMock = installWorkspaceFetch(BASE);
      await renderWorkspace();
      await openPanel(fetchMock);
      expect(selectedPaths()).toEqual([]);
      // La vista parte sin centrar: el centro del objeto (20, 20) no está en el centro del canvas (400, 300).
      expect(overlayPoint(20, 20).x).not.toBeCloseTo(400, 3);

      fireEvent.click(options()[0]);

      await waitFor(() => expect(selectedPaths()).toEqual([OPEN1]));
      await waitFor(() => expect(overlayPoint(20, 20).x).toBeCloseTo(400, 6));
      expect(overlayPoint(20, 20).y).toBeCloseTo(300, 6);
      expect(overlayPoint(20, 20).scale).toBe(6);
      expect(options()[0]).toHaveAttribute("aria-selected", "true");
      const groups = screen.getAllByTestId("laser-check-issue");
      expect(groups).toHaveLength(2);
      expect(screen.getAllByTestId("laser-check-issue").filter((group) => group.getAttribute("data-selected") === "true")).toHaveLength(1);
      expect(screen.getAllByTestId("laser-check-issue").find((group) => group.getAttribute("data-selected") === "true")!.getAttribute("data-issue")).toMatch(/^open_path:o1$/);
    });

    it("un duplicado selecciona AMBOS objetos (el redundante y el original)", async () => {
      const fetchMock = installWorkspaceFetch(BASE);
      await renderWorkspace();
      await openPanel(fetchMock);

      fireEvent.click(options()[1]);

      await waitFor(() => expect(selectedPaths()).toEqual([R2, R2]));
      // El rectángulo del issue es el del duplicado (0..40 x 100..140): su centro (20, 120) queda en el centro del canvas.
      await waitFor(() => expect(overlayPoint(20, 120).x).toBeCloseTo(400, 6));
      expect(overlayPoint(20, 120).y).toBeCloseTo(300, 6);
    });

    it("un issue de CAPA (sin objetos propios) selecciona la capa y centra la vista en ella", async () => {
      installWorkspaceFetch({ ...BASE, operations: { B: "cut", C: "engrave" } });
      await renderWorkspace();
      fireEvent.click(toggle());
      await waitFor(() => expect(options().length).toBe(3));

      fireEvent.click(rowFor(/Capa sin operación/));

      await waitFor(() => expect(options().find((row) => kindOf(row) === "unassigned_layer")).toHaveAttribute("aria-selected", "true"));
      // Rojo ocupa 0..40 x 0..140: centro (20, 70).
      await waitFor(() => expect(overlayPoint(20, 70).x).toBeCloseTo(400, 6));
      expect(selectedPaths()).toEqual([]); // ningún objeto: se activó la capa
    });

    it("teclado: ↓ mueve el cursor sin tocar la selección, Enter activa (selecciona y centra); Escape cierra el panel y devuelve el foco al botón del header", async () => {
      const fetchMock = installWorkspaceFetch(BASE);
      await renderWorkspace();
      await openPanel(fetchMock);
      const list = inPanel().getByRole("listbox");
      list.focus();

      fireEvent.keyDown(list, { key: "ArrowDown" });
      fireEvent.keyDown(list, { key: "ArrowDown" });
      expect(list).toHaveAttribute("aria-activedescendant", options()[1].id);
      expect(selectedPaths()).toEqual([]);

      fireEvent.keyDown(list, { key: "Enter" });
      await waitFor(() => expect(selectedPaths()).toEqual([R2, R2]));
      expect(options()[1]).toHaveAttribute("aria-selected", "true");

      fireEvent.keyDown(list, { key: "Escape" });

      expect(panelOpen()).toBe(false);
      expect(toggle()).toHaveFocus();
      expect(screen.queryByTestId("laser-check-overlay")).not.toBeInTheDocument();
    });

    it("el botón del header y ✕ cierran el panel; reabrir analiza de cero (sin issue seleccionado)", async () => {
      const fetchMock = installWorkspaceFetch(BASE);
      await renderWorkspace();
      await openPanel(fetchMock);
      fireEvent.click(options()[0]);
      await waitFor(() => expect(options()[0]).toHaveAttribute("aria-selected", "true"));

      fireEvent.click(inPanel().getByRole("button", { name: "Cerrar el Laser Check" }));
      expect(panelOpen()).toBe(false);
      expect(toggle()).toHaveFocus();

      fireEvent.click(toggle());
      await waitFor(() => expect(options().length).toBe(2));
      expect(options().every((row) => row.getAttribute("aria-selected") === "false")).toBe(true);
      fireEvent.click(toggle());
      expect(panelOpen()).toBe(false);
    });

    it("el overlay resalta TODOS los issues (rojo = bloqueante) y desaparece al cerrar", async () => {
      const fetchMock = installWorkspaceFetch(BASE);
      await renderWorkspace();
      await openPanel(fetchMock);

      expect(screen.getByTestId("laser-check-overlay")).toBeInTheDocument();
      expect(screen.getAllByTestId("laser-check-issue").map((group) => group.getAttribute("data-severity"))).toEqual(["error", "error"]);
      expect(screen.getAllByTestId("laser-check-highlight").length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("re-análisis tras mutaciones", () => {
    it("tras borrar el objeto con el path abierto el resultado queda DESACTUALIZADO al instante y se re-analiza solo: el issue desaparece", async () => {
      const fetchMock = installWorkspaceFetch(BASE);
      await renderWorkspace();
      await openPanel(fetchMock);
      fireEvent.click(options()[0]);
      await waitFor(() => expect(selectedPaths()).toEqual([OPEN1]));
      const rowsBefore = options().length;

      press("Delete");

      await waitFor(() => expect(badge()).toHaveAttribute("data-stale", "true"));
      expect(badge()).toHaveTextContent("Desactualizado");
      expect(summary()).toMatch(/Resultado desactualizado \(último análisis: Blocking\)/);
      expect(screen.queryByTestId("laser-check-overlay")).not.toBeInTheDocument(); // no se resalta geometría vieja
      expect(options().length).toBe(rowsBefore); // la lista vieja sigue, pero marcada y sin poder activarse
      expect(options()[0]).toHaveAttribute("aria-disabled", "true");

      await waitFor(() => expect(badge()).toHaveAttribute("data-stale", "false"));
      expect(options().map(kindOf)).toEqual(["duplicate_exact"]);
      expect(badge()).toHaveTextContent("Blocking");
      expect(screen.getByTestId("laser-check-overlay")).toBeInTheDocument();
      expectLastCommand("object.delete");
    });

    it("deshacer también dispara el re-análisis: el issue vuelve", async () => {
      const fetchMock = installWorkspaceFetch(BASE);
      await renderWorkspace();
      await openPanel(fetchMock);
      fireEvent.click(options()[0]);
      await waitFor(() => expect(selectedPaths()).toEqual([OPEN1]));
      press("Delete");
      await waitFor(() => expect(options().map(kindOf)).toEqual(["duplicate_exact"]));

      fireEvent.click(undoButton());

      await waitFor(() => expect(options().map(kindOf)).toEqual(["open_path", "duplicate_exact"]));
      expect(badge()).toHaveAttribute("data-stale", "false");
    });

    it("corregir el único problema lleva el estado de Blocking a Ready (con las flotantes verificadas)", async () => {
      const fetchMock = installWorkspaceFetch({
        ...BASE,
        svg: { A: `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><path data-vid="o1" d="${OPEN1}" fill="#ff0000"/><path data-vid="r2" d="${R2}" fill="#ff0000"/></svg>` },
      });
      await renderWorkspace();
      fireEvent.click(toggle());
      await waitFor(() => expect(fetchMock.floatingCalls).toHaveLength(1));
      await waitFor(() => expect(badge()).toHaveTextContent("Blocking"));
      expect(options().map(kindOf)).toEqual(["open_path"]);

      fireEvent.click(options()[0]);
      await waitFor(() => expect(selectedPaths()).toEqual([OPEN1]));
      press("Delete");

      await waitFor(() => expect(badge()).toHaveTextContent("Ready"));
      expect(options()).toHaveLength(0);
      expect(screen.getByTestId("laser-check-empty")).toHaveTextContent("No se encontraron problemas de fabricación.");
      expect(summary()).toBe("Laser Check: Ready. Sin problemas detectados.");
      expect(fetchMock.floatingCalls).toHaveLength(2); // el documento cambió: se volvió a pedir con 3 formas
    });

    it("«Volver a analizar» corre los checks otra vez sin cambios en el documento y sin repetir la petición de flotantes", async () => {
      const fetchMock = installWorkspaceFetch(BASE);
      await renderWorkspace();
      await openPanel(fetchMock);

      fireEvent.click(inPanel().getByRole("button", { name: "Volver a analizar" }));
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(options().map(kindOf)).toEqual(["open_path", "duplicate_exact"]);
      expect(fetchMock.floatingCalls).toHaveLength(1);
    });
  });

  describe("piezas flotantes (servicio de S11)", () => {
    const WITH_ISLAND = {
      svg: { A: `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><path data-vid="ring" d="${RING}" fill="#ff0000"/></svg>` },
      operations: OPERATIONS,
      floating: (body: Body) => floatingReply(body, [{ subject: 0, bounds: [210, 10, 230, 30] }]),
    };

    it("una isla es un issue bloqueante: click selecciona el objeto que la rodea y centra la vista en la isla", async () => {
      const fetchMock = installWorkspaceFetch(WITH_ISLAND);
      await renderWorkspace({ minPaths: 2 });

      fireEvent.click(toggle());
      await waitFor(() => expect(options().map(kindOf)).toContain("floating"));
      await waitFor(() => expect(fetchMock.floatingCalls).toHaveLength(1));
      const row = options().find((candidate) => kindOf(candidate) === "floating")!;
      expect(row).toHaveTextContent("Pieza flotante");
      expect(row).toHaveTextContent("Isla 1 · 100 mm² · rodeada por «Rojo · objeto 1». Se cae al cortar.");
      expect(row).toHaveTextContent("Acción sugerida: Agregar un bridge");

      fireEvent.click(row);

      await waitFor(() => expect(selectedPaths()).toEqual([RING]));
      await waitFor(() => expect(overlayPoint(220, 20).x).toBeCloseTo(400, 6)); // el centro de la isla (210..230 x 10..30)
      expect(overlayPoint(220, 20).y).toBeCloseTo(300, 6);
      expect(badge()).toHaveTextContent("Blocking");
    });

    it("mientras el servidor no contesta lo dice y el estado NO es Ready; si falla informa sin invalidar lo local, y Reintentar se recupera", async () => {
      let fail = true;
      const fetchMock = installWorkspaceFetch({ ...BASE, floating: (body: Body) => (fail ? jsonResponse({ code: "processing_error", message: "boom" }, 500) : floatingReply(body)) });
      await renderWorkspace();

      fireEvent.click(toggle());

      expect(await screen.findByText(/No se pudieron analizar las piezas flotantes\. Los demás checks siguen siendo válidos\./)).toBeInTheDocument();
      expect(options().map(kindOf)).toEqual(["open_path", "duplicate_exact"]); // lo local sigue ahí
      expect(inPanel().getByRole("list", { name: "Checks no verificados" })).toHaveTextContent("No verificado: Piezas flotantes.");
      fail = false;
      fireEvent.click(inPanel().getByRole("button", { name: "Reintentar" }));
      await waitFor(() => expect(fetchMock.floatingCalls).toHaveLength(2));
      await waitFor(() => expect(inPanel().queryByRole("list", { name: "Checks no verificados" })).not.toBeInTheDocument());
    });

    it("un documento limpio con el servidor caído NUNCA es Ready: queda en Review", async () => {
      installWorkspaceFetch({
        svg: { A: `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><path data-vid="r2" d="${R2}" fill="#ff0000"/></svg>` },
        operations: OPERATIONS,
        floating: () => jsonResponse({ code: "engine_unavailable", message: "x" }, 503),
      });
      await renderWorkspace({ minPaths: 3 });

      fireEvent.click(toggle());

      await waitFor(() => expect(badge()).toHaveAttribute("data-status", "review"));
      expect(options()).toHaveLength(0);
      expect(badge()).not.toHaveTextContent("Ready");
    });
  });

  describe("convivencia con el resto del editor", () => {
    it("seguir editando con el panel abierto lo re-analiza (y la edición entra al historial como siempre)", async () => {
      const fetchMock = installWorkspaceFetch(BASE);
      const { canvas } = await renderWorkspace();
      await openPanel(fetchMock);

      const point = toScreen(20, 5);
      fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, clientX: point.clientX, clientY: point.clientY });
      fireEvent.pointerUp(canvas, { pointerId: 1, clientX: point.clientX, clientY: point.clientY });
      await waitFor(() => expect(selectedPaths()).toHaveLength(1));
      fireEvent.keyDown(canvas, { key: "ArrowRight" });
      await act(async () => undefined);

      await waitFor(() => expect(badge()).toHaveAttribute("data-stale", "false"));
      expect(options().map(kindOf)).toEqual(["open_path", "duplicate_exact"]);
      expectLastCommand("object.nudge");
    });
  });
});
