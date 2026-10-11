import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clickAt,
  GEOMETRY_DIRTY,
  installResizeObserver,
  installWorkspaceFetch,
  jsonResponse,
  pathData,
  R2,
  redoButton,
  renderWorkspace,
  tool,
  toScreen,
  undoButton,
} from "../../test/workspaceFixture";

/**
 * Integración de piezas flotantes y bridges (M3-S11) en el Workspace completo: herramienta Flotantes, los dos modos, el alcance (capas CUT visibles / selección;
 * bloqueados cuentan pero no se modifican; ocultos no), Analizar, la lista de issues (seleccionar centra la vista y resalta; navegable con el teclado), las
 * sugerencias de bridges, el ancho en mm, colocar / mover / quitar bridges, «N flotantes → M», Apply deshabilitado con bridges inválidos, un comando atómico por Apply
 * con undo/redo exactos, errores del servidor sin cambios, análisis viejo y StrictMode. Documento 320 x 240 u con 0,5 mm por unidad, contenedor de 800 x 600.
 * Capas de la fixture con SVG propio: Rojo (CUT: r1 = 0..40² con hueco 10..30², r2 = 0..40 x 100..140 macizo) y Azul (CUT: b1 = 100..140² con hueco 110..130²).
 * El servidor se simula con un motor de ISLAS = HUECOS RECTANGULARES (cada anillo después del primero) y bridges rectos hacia la derecha hasta el borde exterior; el
 * cálculo real se prueba en services/python-engine/tests.
 */

type Body = Record<string, unknown>;
type Subject = { type: "polygon"; coordinates: number[][][]; locked?: boolean };
type BridgeAsk = { island?: number; anchor?: { x: number; y: number }; direction?: { x: number; y: number }; width: number; length?: number };

const closedRing = (x0: number, y0: number, x1: number, y1: number) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const box = (ring: number[][]) => ({ x0: Math.min(...ring.map((p) => p[0])), x1: Math.max(...ring.map((p) => p[0])), y0: Math.min(...ring.map((p) => p[1])), y1: Math.max(...ring.map((p) => p[1])) });

interface Island {
  id: number;
  subject: number;
  hole: ReturnType<typeof box>;
  outer: ReturnType<typeof box>;
}

/** Una isla por cada hueco (anillo después del primero) de cada forma, en orden de forma. El id 0 es la hoja. */
function islandsOf(subjects: Subject[]): Island[] {
  const islands: Island[] = [];
  subjects.forEach((subject, index) => {
    for (const ring of subject.coordinates.slice(1)) islands.push({ id: islands.length + 1, subject: index, hole: box(ring), outer: box(subject.coordinates[0]) });
  });
  return islands;
}

function floatingPayload(body: Body) {
  const subjects = body.subjects as Subject[];
  const islands = islandsOf(subjects);
  const everything = subjects.map((subject) => box(subject.coordinates[0]));
  const sheet = {
    id: 0,
    kind: "principal",
    depth: 0,
    parent: null,
    polygon: null,
    area: null,
    bounds: [Math.min(...everything.map((b) => b.x0)), Math.min(...everything.map((b) => b.y0)), Math.max(...everything.map((b) => b.x1)), Math.max(...everything.map((b) => b.y1))],
    subjects: [],
  };
  if (body.mode === "parts") {
    // Modo Piezas simplificado: un cuerpo por forma, sin piezas flotantes.
    const bodies = subjects.map((subject, index) => ({ id: index, kind: "principal", depth: 0, parent: null, polygon: { type: "polygon", coordinates: [closedRing(...(Object.values(box(subject.coordinates[0])) as [number, number, number, number]))] }, area: 1, bounds: [0, 0, 1, 1], subjects: [index] }));
    return { mode: "parts", tolerance: body.tolerance, components: bodies, floatingCount: 0, mainCount: bodies.length, discarded: 0 };
  }
  const components = [
    sheet,
    ...islands.map((island) => ({
      id: island.id,
      kind: "floating",
      depth: 1,
      parent: 0,
      polygon: { type: "polygon", coordinates: [closedRing(island.hole.x0, island.hole.y0, island.hole.x1, island.hole.y1)] },
      area: (island.hole.x1 - island.hole.x0) * (island.hole.y1 - island.hole.y0),
      bounds: [island.hole.x0, island.hole.y0, island.hole.x1, island.hole.y1],
      subjects: [island.subject],
    })),
  ];
  return { mode: body.mode, tolerance: body.tolerance, components, floatingCount: islands.length, mainCount: 1, discarded: 0 };
}

const fakeFloating = (body: Body): Response => jsonResponse(floatingPayload(body));

/** C abierta: el anillo exterior con la muesca del bridge a la derecha de la isla (ancho `w`, centrado en `y`). */
function notched(island: Island, y: number, w: number) {
  const { outer, hole } = island;
  const [a, b] = [y - w / 2, y + w / 2];
  return [[outer.x0, outer.y0], [outer.x1, outer.y0], [outer.x1, a], [hole.x1, a], [hole.x1, hole.y0], [hole.x0, hole.y0], [hole.x0, hole.y1], [hole.x1, hole.y1], [hole.x1, b], [outer.x1, b], [outer.x1, outer.y1], [outer.x0, outer.y1], [outer.x0, outer.y0]];
}

/**
 * Bridges rectos hacia la derecha: cruzan el espesor entre el borde del hueco y el exterior de la forma. Un bridge sobre una isla de una forma BLOQUEADA es inválido
 * (`locked_subject`); un ancla que no cae sobre el borde de ninguna isla, `anchor_outside`; el segundo bridge sobre una isla es válido pero no reduce. Con
 * `suggest` completa con una sugerencia (al medio del lado derecho) cada isla sin bridge válido. Hace eco del ancho y reanaliza.
 */
function bridgePayload(body: Body) {
  const subjects = body.subjects as Subject[];
  const islands = islandsOf(subjects);
  const asks = (body.bridges as BridgeAsk[]).map((ask) => ({ ask, suggested: false }));
  const resolved: Array<Record<string, unknown> & { valid: boolean; island: number | null }> = [];
  const covered = new Set<number>();

  const resolve = (ask: BridgeAsk, suggested: boolean) => {
    const index = resolved.length;
    const item: Record<string, unknown> & { valid: boolean; island: number | null } = {
      index, suggested, valid: false, reason: null, island: ask.island ?? null, anchor: null, direction: null, width: ask.width, length: null, area: null, reduces: false, affects: [], polygon: null,
    };
    resolved.push(item);
    const near = (island: Island) =>
      ask.anchor !== undefined &&
      ask.anchor.x >= island.hole.x0 - 0.5 && ask.anchor.x <= island.hole.x1 + 0.5 && ask.anchor.y >= island.hole.y0 - 0.5 && ask.anchor.y <= island.hole.y1 + 0.5;
    const island = islands.find((candidate) => (ask.island !== undefined ? candidate.id === ask.island : near(candidate)));
    if (!island || (ask.island !== undefined && ask.anchor !== undefined && !near(island))) {
      item.reason = ask.island !== undefined && ask.anchor === undefined ? "unknown_island" : "anchor_outside";
      return;
    }
    item.island = island.id;
    const y = ask.anchor?.y ?? (island.hole.y0 + island.hole.y1) / 2;
    item.anchor = { x: island.hole.x1, y };
    item.direction = { x: 1, y: 0 };
    const length = island.outer.x1 - island.hole.x1;
    item.length = length;
    item.area = ask.width * length;
    item.polygon = { type: "polygon", coordinates: [closedRing(island.hole.x1 - 0.04, y - ask.width / 2, island.outer.x1 + 0.04, y + ask.width / 2)] };
    item.affects = [island.subject];
    if (subjects[island.subject].locked) {
      item.reason = "locked_subject";
      return;
    }
    item.valid = true;
    item.reduces = !covered.has(island.id);
    covered.add(island.id);
  };

  asks.forEach(({ ask, suggested }) => resolve(ask, suggested));
  if (body.suggest === true) {
    for (const island of islands) {
      if (!resolved.some((item) => item.valid && item.island === island.id)) resolve({ island: island.id, width: body.suggestWidth as number }, true);
    }
  }

  const changed = new Map<number, number[][]>();
  for (const item of resolved.filter((candidate) => candidate.valid)) {
    const island = islands.find((candidate) => candidate.id === item.island)!;
    if (!changed.has(island.subject)) changed.set(island.subject, notched(island, (item.anchor as { y: number }).y, item.width as number));
  }
  const results = subjects.map((_, index) => ({ subjectIndex: index, changed: changed.has(index), geometries: changed.has(index) ? [{ type: "polygon", coordinates: [changed.get(index)!] }] : [] }));
  const reduced = new Set(resolved.filter((item) => item.valid).map((item) => item.island)).size;
  return {
    mode: body.mode,
    tolerance: body.tolerance,
    bridges: resolved,
    results,
    reanalysis: { floatingBefore: islands.length, floatingAfter: islands.length - reduced, mainAfter: 1 },
    pieceCount: changed.size,
  };
}

const fakeBridge = (body: Body): Response => jsonResponse(bridgePayload(body));

const RING_R1 = "M0 0 H40 V40 H0 Z M10 10 H30 V30 H10 Z";
const RING_B1 = "M100 100 H140 V140 H100 Z M110 110 H130 V130 H110 Z";
const SVG = {
  A: `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><path data-vid="r1" d="${RING_R1}" fill="#ff0000"/><path data-vid="r2" d="${R2}" fill="#ff0000"/></svg>`,
  B: `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><path data-vid="b1" d="${RING_B1}" fill="#0000ff"/></svg>`,
};
const BASE_OPTIONS = { svg: SVG, operations: { A: "cut", B: "cut" } as const, floating: fakeFloating, bridge: fakeBridge };

const panel = () => screen.getByRole("heading", { name: "Piezas flotantes" }).closest("section")!;
const inPanel = () => within(panel());
const panelOpen = () => screen.queryByRole("heading", { name: "Piezas flotantes" }) !== null;
const applyButton = () => inPanel().getByRole("button", { name: "Apply" });
const cancelButton = () => inPanel().getByRole("button", { name: "Cancel" });
const analyzeButton = () => inPanel().getByRole("button", { name: /^(Analizar|Volver a analizar)$/ });
const press = (key: string) => fireEvent.keyDown(screen.getByRole("application"), { key });
const stateText = () => inPanel().getAllByRole("status")[0].textContent ?? "";
const toolButton = () => tool(/^Flotantes/);
const openTool = () => fireEvent.click(toolButton());
const issueRows = () => inPanel().queryAllByRole("option");
const bridgeRows = () => inPanel().queryAllByTestId("floating-bridge-row");
const listbox = () => inPanel().getByRole("listbox");
const badge = (issue: number) => document.querySelector(`[data-testid="floating-badge"][data-issue="${issue}"] circle`) as SVGCircleElement;
const issuePath = (issue: number) => document.querySelector(`[data-testid="floating-issue"][data-issue="${issue}"]`) as SVGPathElement;
const bridgeCalls = (fetchMock: ReturnType<typeof installWorkspaceFetch>) => fetchMock.bridgeCalls;
const lastBridge = (fetchMock: ReturnType<typeof installWorkspaceFetch>) => fetchMock.bridgeCalls[fetchMock.bridgeCalls.length - 1];

function click(canvas: HTMLElement, x: number, y: number) {
  fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, ...toScreen(x, y) });
  fireEvent.pointerUp(canvas, { pointerId: 1, ...toScreen(x, y) });
}

/** Abre la herramienta, analiza y espera el análisis y las sugerencias. */
async function analyze(fetchMock: ReturnType<typeof installWorkspaceFetch>, options: { suggestions?: boolean } = {}) {
  openTool();
  fireEvent.click(analyzeButton());
  await waitFor(() => expect(fetchMock.floatingCalls).toHaveLength(1));
  await waitFor(() => expect(issueRows().length).toBeGreaterThan(0));
  if (options.suggestions !== false) {
    await waitFor(() => expect(bridgeCalls(fetchMock).length).toBeGreaterThan(0));
    await waitFor(() => expect(bridgeRows().length).toBeGreaterThan(0));
  }
}

describe("EditorShell — piezas flotantes y bridges (M3-S11)", () => {
  beforeEach(() => installResizeObserver());
  afterEach(() => vi.unstubAllGlobals());

  describe("acceso, modo y alcance", () => {
    it("el botón Flotantes está en la barra; abre el panel con el modo Plantilla por defecto y el alcance por escrito; no pide nada hasta Analizar", async () => {
      const fetchMock = installWorkspaceFetch(BASE_OPTIONS);
      await renderWorkspace();
      expect(toolButton()).toBeEnabled();

      openTool();

      expect(panelOpen()).toBe(true);
      expect(toolButton()).toHaveAttribute("aria-pressed", "true");
      expect(inPanel().getByRole("radio", { name: /Plantilla/ })).toBeChecked();
      expect(inPanel().getByRole("radio", { name: /Piezas/ })).not.toBeChecked();
      expect(panel().textContent).toMatch(/Modo activo: Plantilla \(stencil\)\./);
      expect(panel().textContent).toMatch(/Capas CUT: Rojo, Azul \(3 objetos\)\./);
      expect(applyButton()).toBeDisabled();
      expect(applyButton()).toHaveAttribute("title", "Primero analizá las piezas flotantes.");
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(fetchMock.floatingCalls).toHaveLength(0);
      expect(bridgeCalls(fetchMock)).toHaveLength(0);
      expect(screen.queryByTestId("floating-overlay")).not.toBeInTheDocument();
    });

    it("con la herramienta abierta el canvas solo SELECCIONA (no arrastra): el alcance pasa a la selección viva y arrastrar con el mouse no mueve nada", async () => {
      installWorkspaceFetch(BASE_OPTIONS);
      const { canvas } = await renderWorkspace();
      openTool();
      expect(panel().textContent).toMatch(/Capas CUT: Rojo, Azul \(3 objetos\)/);

      click(canvas, 20, 5); // r1
      expect(panel().textContent).toMatch(/Selección: 1 objeto\./);
      const before = pathData();
      fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, ...toScreen(20, 5) });
      fireEvent.pointerMove(canvas, { pointerId: 1, ...toScreen(80, 60) });
      fireEvent.pointerUp(canvas, { pointerId: 1, ...toScreen(80, 60) });

      expect(pathData()).toEqual(before);
      expect(undoButton()).toBeDisabled();
    });

    it("Analizar manda UNA petición con las formas en unidades (anillos), el bloqueo de cada una, el modo y la tolerancia (0,01 mm = 0,02 u)", async () => {
      const fetchMock = installWorkspaceFetch({ ...BASE_OPTIONS, lockedB: true });
      await renderWorkspace();
      openTool();

      fireEvent.click(analyzeButton());
      await waitFor(() => expect(fetchMock.floatingCalls).toHaveLength(1));

      const body = fetchMock.floatingCalls[0];
      expect(body.mode).toBe("stencil");
      expect(body.tolerance).toBeCloseTo(0.02, 12);
      const subjects = body.subjects as Subject[];
      expect(subjects).toHaveLength(3); // r1, r2 y b1 (la línea no tiene relleno)
      expect(subjects.map((subject) => subject.coordinates.length)).toEqual([2, 1, 2]);
      expect(subjects.map((subject) => subject.locked)).toEqual([false, false, true]); // b1 está en la capa bloqueada: cuenta, pero se marca
      expect(fetchMock.urls.filter((url) => url.endsWith("/api/v2/geometry/floating"))).toHaveLength(1);
      expect(fetchMock.geometryCalls).toHaveLength(0);
      expect(fetchMock.splitCalls).toHaveLength(0);
    });

    it("las capas ocultas no cuentan (el texto lo dice y no viajan) y las que no son CUT no entran", async () => {
      const fetchMock = installWorkspaceFetch({ ...BASE_OPTIONS, hiddenB: true });
      await renderWorkspace({ minPaths: 3 }); // la capa oculta no se dibuja
      openTool();

      expect(panel().textContent).toMatch(/Capas CUT: Rojo \(2 objetos\)\./);
      expect(panel().textContent).toMatch(/1 capa CUT oculta no cuenta \(Azul\)/);
      fireEvent.click(analyzeButton());
      await waitFor(() => expect(fetchMock.floatingCalls).toHaveLength(1));

      expect((fetchMock.floatingCalls[0].subjects as Subject[]).length).toBe(2);
    });

    it("sin ninguna capa CUT el análisis se rechaza con el motivo y no llama al servidor", async () => {
      const fetchMock = installWorkspaceFetch({ ...BASE_OPTIONS, operations: {} });
      await renderWorkspace();
      openTool();

      fireEvent.click(analyzeButton());

      expect(await screen.findByText(/No hay capas con operación CUT visibles/)).toBeInTheDocument();
      expect(fetchMock.floatingCalls).toHaveLength(0);
      expect(applyButton()).toBeDisabled();
    });

    it("con selección el alcance es la selección (aunque su capa no sea CUT): Selección: 1 objeto y viaja una sola forma", async () => {
      const fetchMock = installWorkspaceFetch({ ...BASE_OPTIONS, operations: {} });
      const { canvas } = await renderWorkspace();
      click(canvas, 20, 5); // r1: sobre el borde exterior, dentro del objeto
      openTool();

      expect(panel().textContent).toMatch(/Selección: 1 objeto\./);
      fireEvent.click(analyzeButton());
      await waitFor(() => expect(fetchMock.floatingCalls).toHaveLength(1));

      expect((fetchMock.floatingCalls[0].subjects as Subject[]).length).toBe(1);
    });

    it("sin escala física opera en UNIDADES y lo avisa: tolerancia 0,01 u, ancho 0,8 u, campo en u", async () => {
      const fetchMock = installWorkspaceFetch(BASE_OPTIONS);
      await renderWorkspace({ dimensionWidthMm: null });
      openTool();
      expect(inPanel().getByRole("note")).toHaveTextContent(/Sin escala física: los bridges se miden en unidades del documento \(u\), no en mm\./);

      fireEvent.click(analyzeButton());
      await waitFor(() => expect(bridgeCalls(fetchMock).length).toBeGreaterThan(0));

      expect(fetchMock.floatingCalls[0].tolerance).toBeCloseTo(0.01, 12);
      expect(lastBridge(fetchMock).suggestWidth).toBeCloseTo(0.8, 12);
      expect(inPanel().getByLabelText(/Ancho del bridge \(u\)/)).toHaveValue("0.8");
      await waitFor(() => expect(issueRows()[0].textContent).toContain("400 u²")); // 20 x 20 u, sin convertir
    });

    it("cambiar el modo descarta el análisis y el siguiente Analizar manda el otro modo", async () => {
      const fetchMock = installWorkspaceFetch(BASE_OPTIONS);
      await renderWorkspace();
      await analyze(fetchMock);

      fireEvent.click(inPanel().getByRole("radio", { name: /Piezas/ }));

      expect(issueRows()).toHaveLength(0);
      expect(screen.queryByTestId("floating-overlay")).not.toBeInTheDocument();
      expect(panel().textContent).toMatch(/Modo activo: Piezas\./);
      fireEvent.click(analyzeButton());
      await waitFor(() => expect(fetchMock.floatingCalls).toHaveLength(2));
      expect(fetchMock.floatingCalls[1].mode).toBe("parts");
      expect(await screen.findByText(/No se encontraron piezas flotantes: todo está conectado al cuerpo principal/)).toBeInTheDocument();
    });
  });

  describe("issues: lista, resaltado y navegación", () => {
    it("lista las islas con su número, su área en mm² y lo que las rodea; el overlay las resalta con insignias", async () => {
      const fetchMock = installWorkspaceFetch(BASE_OPTIONS);
      await renderWorkspace();

      await analyze(fetchMock);

      expect(stateText()).toMatch(/Se encontraron 2 islas \(se caen al cortar\)\./);
      expect(issueRows().map((row) => row.textContent)).toEqual([
        "Isla 1 · 100 mm² · rodeada por «Rojo · objeto 1»",
        "Isla 2 · 100 mm² · rodeada por «Azul · objeto 1»",
      ]);
      expect(screen.getByTestId("floating-overlay")).toBeInTheDocument();
      expect(document.querySelectorAll('[data-testid="floating-issue"]')).toHaveLength(2);
      expect(document.querySelectorAll('[data-testid="floating-badge"]')).toHaveLength(2);
      expect(document.querySelector('[data-testid="floating-badge"] text')?.textContent).toBe("1");
    });

    it("seleccionar un issue CENTRA la vista en la pieza (zoom 6: el centro de la isla cae en el centro del canvas) y la RESALTA", async () => {
      const fetchMock = installWorkspaceFetch(BASE_OPTIONS);
      await renderWorkspace();
      await analyze(fetchMock);
      // Antes de seleccionar la vista está en el origen: la isla 2 (centro 120, 120) no está en el centro del contenedor (400, 300).
      expect(Number(badge(2).getAttribute("cx"))).not.toBeCloseTo(400, 3);

      fireEvent.click(issueRows()[1]);

      expect(issueRows()[1]).toHaveAttribute("aria-selected", "true");
      expect(issueRows()[0]).toHaveAttribute("aria-selected", "false");
      await waitFor(() => expect(Number(badge(2).getAttribute("cx"))).toBeCloseTo(400, 6));
      expect(Number(badge(2).getAttribute("cy"))).toBeCloseTo(300, 6);
      expect(issuePath(2)).toHaveAttribute("data-selected", "true");
      expect(issuePath(1)).toHaveAttribute("data-selected", "false");
      // Zoom razonable: 20 u de lado en 800 x 600 llevaría a 12 (40 % del lado menor); el tope es 6, así que el origen del documento ya no está donde estaba.
      const group = document.querySelector('[data-testid="floating-overlay"] g')!;
      expect(group.getAttribute("transform")).toMatch(/scale\(6\)/);
    });

    it("las flechas recorren la lista (↑/↓/Inicio/Fin): cada una selecciona, centra y resalta; aria-activedescendant sigue a la seleccionada", async () => {
      const fetchMock = installWorkspaceFetch(BASE_OPTIONS);
      await renderWorkspace();
      await analyze(fetchMock);
      listbox().focus();

      fireEvent.keyDown(listbox(), { key: "ArrowDown" });
      expect(issueRows()[0]).toHaveAttribute("aria-selected", "true");
      await waitFor(() => expect(Number(badge(1).getAttribute("cx"))).toBeCloseTo(400, 6));
      expect(listbox()).toHaveAttribute("aria-activedescendant", issueRows()[0].id);

      fireEvent.keyDown(listbox(), { key: "ArrowDown" });
      expect(issueRows()[1]).toHaveAttribute("aria-selected", "true");
      await waitFor(() => expect(Number(badge(2).getAttribute("cx"))).toBeCloseTo(400, 6));

      fireEvent.keyDown(listbox(), { key: "ArrowDown" }); // ya es la última
      expect(issueRows()[1]).toHaveAttribute("aria-selected", "true");
      fireEvent.keyDown(listbox(), { key: "Home" });
      expect(issueRows()[0]).toHaveAttribute("aria-selected", "true");
      fireEvent.keyDown(listbox(), { key: "End" });
      expect(issueRows()[1]).toHaveAttribute("aria-selected", "true");
      fireEvent.keyDown(listbox(), { key: "ArrowUp" });
      expect(issueRows()[0]).toHaveAttribute("aria-selected", "true");
    });

    it("el listbox tiene nombre accesible y el estado de lo que se encontró se anuncia en una región aria-live", async () => {
      const fetchMock = installWorkspaceFetch(BASE_OPTIONS);
      await renderWorkspace();
      await analyze(fetchMock);

      expect(listbox()).toHaveAccessibleName(/2 piezas/);
      expect(inPanel().getAllByRole("status")[0]).toHaveAttribute("aria-live", "polite");
    });

    it("Volver a analizar sobre el mismo documento repite el análisis desde cero (sin issue seleccionado)", async () => {
      const fetchMock = installWorkspaceFetch(BASE_OPTIONS);
      await renderWorkspace();
      await analyze(fetchMock);
      fireEvent.click(issueRows()[0]);

      fireEvent.click(analyzeButton());

      await waitFor(() => expect(issueRows().every((row) => row.getAttribute("aria-selected") === "false")).toBe(true));
    });
  });

  describe("bridges: sugerencias, ancho, colocar, mover y quitar", () => {
    it("tras el análisis pide las SUGERENCIAS (suggest, ancho 0,8 mm = 1,6 u) y muestra un bridge por isla con «2 flotantes → 0»; Apply se habilita", async () => {
      const fetchMock = installWorkspaceFetch(BASE_OPTIONS);
      await renderWorkspace();

      await analyze(fetchMock);
      await waitFor(() => expect(screen.getByTestId("floating-reanalysis")).toHaveTextContent("2 flotantes → 0"));

      expect(bridgeCalls(fetchMock)).toHaveLength(1);
      expect(lastBridge(fetchMock)).toMatchObject({ mode: "stencil", suggest: true, bridges: [] });
      expect(lastBridge(fetchMock).suggestWidth).toBeCloseTo(1.6, 12);
      expect(bridgeRows().map((row) => row.textContent)).toEqual([
        expect.stringMatching(/^Bridge 1 · Isla 1 · sugerido · largo 5 mm · quita 4 mm²/),
        expect.stringMatching(/^Bridge 2 · Isla 2 · sugerido · largo 5 mm · quita 4 mm²/),
      ]);
      expect(document.querySelectorAll('[data-testid="floating-bridge"][data-valid="true"]')).toHaveLength(2);
      expect(applyButton()).toBeEnabled();
      expect(undoButton()).toBeDisabled(); // el preview no llenó la pila de undo
    });

    it("cambiar el ancho mientras son sugerencias vuelve a pedirlas con el ancho nuevo en unidades (1,5 mm = 3 u)", async () => {
      const fetchMock = installWorkspaceFetch(BASE_OPTIONS);
      await renderWorkspace();
      await analyze(fetchMock);
      await waitFor(() => expect(screen.getByTestId("floating-reanalysis")).toBeInTheDocument());

      const field = inPanel().getByLabelText(/Ancho del bridge/);
      fireEvent.change(field, { target: { value: "1,5" } });
      fireEvent.keyDown(field, { key: "Enter" });

      await waitFor(() => expect(bridgeCalls(fetchMock)).toHaveLength(2));
      expect(lastBridge(fetchMock)).toMatchObject({ suggest: true, suggestWidth: 3, bridges: [] });
      await waitFor(() => expect(bridgeRows()[0].textContent).toMatch(/quita 7\.5 mm²/)); // 1,5 mm x 5 mm
      expect(screen.getByTestId("floating-reanalysis")).toHaveTextContent("2 flotantes → 0");
    });

    it("con la lista ya adoptada, cambiar el ancho manda los bridges EXPLÍCITOS (isla, ancla y dirección del servidor) con el ancho nuevo; el servidor nunca tiene dos peticiones vivas", async () => {
      const fetchMock = installWorkspaceFetch(BASE_OPTIONS);
      await renderWorkspace();
      await analyze(fetchMock);
      await waitFor(() => expect(screen.getByTestId("floating-reanalysis")).toBeInTheDocument());
      fireEvent.click(inPanel().getByRole("button", { name: "Quitar Bridge 2" })); // adopta la lista
      await waitFor(() => expect(bridgeCalls(fetchMock)).toHaveLength(2));

      const field = inPanel().getByLabelText(/Ancho del bridge/);
      fireEvent.change(field, { target: { value: "2" } });
      fireEvent.keyDown(field, { key: "Enter" });

      await waitFor(() => expect(bridgeCalls(fetchMock)).toHaveLength(3));
      expect(lastBridge(fetchMock)).toMatchObject({ suggest: false, bridges: [{ island: 1, anchor: { x: 30, y: 20 }, direction: { x: 1, y: 0 }, width: 4 }] });
      await waitFor(() => expect(bridgeRows()[0].textContent).toMatch(/quita 10 mm²/));
      const live = fetchMock.signals.filter((signal, index) => fetchMock.urls[index].endsWith("/api/v2/geometry/bridge") && !signal?.aborted);
      expect(live.length).toBeLessThanOrEqual(3); // las anteriores terminaron o se abortaron; ninguna quedó colgada compitiendo
    });

    it("un ancho fuera de rango se rechaza en el campo y NO pide nada", async () => {
      const fetchMock = installWorkspaceFetch(BASE_OPTIONS);
      await renderWorkspace();
      await analyze(fetchMock);
      await waitFor(() => expect(screen.getByTestId("floating-reanalysis")).toBeInTheDocument());
      const calls = bridgeCalls(fetchMock).length;

      const field = inPanel().getByLabelText(/Ancho del bridge/);
      fireEvent.change(field, { target: { value: "50" } });
      fireEvent.keyDown(field, { key: "Enter" });

      expect(await screen.findByText(/debe estar entre 0.05 \(inclusive\) y 20 mm/)).toBeInTheDocument();
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(bridgeCalls(fetchMock)).toHaveLength(calls);
    });

    it("Quitar un bridge adopta la lista y vuelve a pedir con uno solo: «2 flotantes → 1» y el aviso de la isla que queda sin bridge", async () => {
      const fetchMock = installWorkspaceFetch(BASE_OPTIONS);
      await renderWorkspace();
      await analyze(fetchMock);
      await waitFor(() => expect(screen.getByTestId("floating-reanalysis")).toBeInTheDocument());

      fireEvent.click(inPanel().getByRole("button", { name: "Quitar Bridge 2" }));

      await waitFor(() => expect(screen.getByTestId("floating-reanalysis")).toHaveTextContent("2 flotantes → 1"));
      expect(lastBridge(fetchMock).bridges).toEqual([{ island: 1, anchor: { x: 30, y: 20 }, direction: { x: 1, y: 0 }, width: 1.6 }]);
      expect(bridgeRows()).toHaveLength(1);
      expect(inPanel().getByRole("list", { name: "Advertencias de los bridges" }).textContent).toMatch(/1 isla sin bridge: Isla 2\. Queda flotando\./);
      expect(applyButton()).toBeEnabled(); // quedan flotantes sin puente: se avisa, no se bloquea
    });

    it("sin bridges no hay nada que pedir ni aplicar: lo dice, no llama al servidor y «Sugerir bridges» los vuelve a pedir", async () => {
      const fetchMock = installWorkspaceFetch(BASE_OPTIONS);
      await renderWorkspace();
      await analyze(fetchMock);
      await waitFor(() => expect(screen.getByTestId("floating-reanalysis")).toBeInTheDocument());
      fireEvent.click(inPanel().getByRole("button", { name: "Quitar Bridge 2" }));
      await waitFor(() => expect(bridgeRows()).toHaveLength(1));
      fireEvent.click(inPanel().getByRole("button", { name: "Quitar Bridge 1" }));

      await waitFor(() => expect(bridgeRows()).toHaveLength(0));
      expect(await screen.findByText(/No hay bridges\. Usá «Sugerir bridges»/)).toBeInTheDocument();
      expect(applyButton()).toBeDisabled();
      const calls = bridgeCalls(fetchMock).length;

      fireEvent.click(inPanel().getByRole("button", { name: "Sugerir bridges" }));

      await waitFor(() => expect(bridgeCalls(fetchMock)).toHaveLength(calls + 1));
      expect(lastBridge(fetchMock).suggest).toBe(true);
      await waitFor(() => expect(bridgeRows()).toHaveLength(2));
    });

    it("Colocar bridge: un click cerca del borde de una isla lo AJUSTA al borde y agrega un bridge con esa ancla (sin dirección: el servidor la elige)", async () => {
      const fetchMock = installWorkspaceFetch(BASE_OPTIONS);
      await renderWorkspace();
      await analyze(fetchMock);
      await waitFor(() => expect(screen.getByTestId("floating-reanalysis")).toBeInTheDocument());
      fireEvent.click(inPanel().getByRole("button", { name: "Quitar Bridge 2" })); // queda la isla 2 sin bridge
      await waitFor(() => expect(bridgeRows()).toHaveLength(1));

      fireEvent.click(inPanel().getByRole("button", { name: "Colocar bridge" }));
      expect(inPanel().getByRole("button", { name: "Colocar bridge" })).toHaveAttribute("aria-pressed", "true");
      const surface = screen.getByTestId("floating-surface");
      clickAt(surface, 131, 118); // a 1 u del borde derecho de la isla 2 (110..130)

      await waitFor(() => expect(bridgeRows()).toHaveLength(2));
      const body = lastBridge(fetchMock);
      expect(body.bridges).toEqual([
        { island: 1, anchor: { x: 30, y: 20 }, direction: { x: 1, y: 0 }, width: 1.6 },
        { island: 2, anchor: { x: 130, y: 118 }, width: 1.6 },
      ]);
      await waitFor(() => expect(screen.getByTestId("floating-reanalysis")).toHaveTextContent("2 flotantes → 0"));
    });

    it("un click lejos del borde de toda isla NO coloca nada y lo explica; Escape sale del modo de colocación sin cerrar la herramienta", async () => {
      const fetchMock = installWorkspaceFetch(BASE_OPTIONS);
      await renderWorkspace();
      await analyze(fetchMock);
      await waitFor(() => expect(screen.getByTestId("floating-reanalysis")).toBeInTheDocument());
      const calls = bridgeCalls(fetchMock).length;

      fireEvent.click(inPanel().getByRole("button", { name: "Colocar bridge" }));
      clickAt(screen.getByTestId("floating-surface"), 200, 200);

      expect(await screen.findByText(/Hacé click sobre el borde de una pieza flotante marcada/)).toBeInTheDocument();
      expect(bridgeRows()).toHaveLength(2);
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(bridgeCalls(fetchMock)).toHaveLength(calls);

      press("Escape");
      expect(screen.queryByTestId("floating-surface")).not.toBeInTheDocument();
      expect(panelOpen()).toBe(true);
      expect(issueRows()).toHaveLength(2);
    });

    it("Mover: el siguiente click sobre un borde reubica ESE bridge (misma lista, nueva ancla)", async () => {
      const fetchMock = installWorkspaceFetch(BASE_OPTIONS);
      await renderWorkspace();
      await analyze(fetchMock);
      await waitFor(() => expect(screen.getByTestId("floating-reanalysis")).toBeInTheDocument());

      fireEvent.click(inPanel().getByRole("button", { name: "Mover Bridge 1" }));
      expect(inPanel().getByRole("button", { name: "Mover Bridge 1" })).toHaveAttribute("aria-pressed", "true");
      clickAt(screen.getByTestId("floating-surface"), 29, 14); // borde derecho de la isla 1, más arriba

      await waitFor(() => expect(bridgeCalls(fetchMock)).toHaveLength(2));
      expect(lastBridge(fetchMock).bridges).toEqual([
        { island: 1, anchor: { x: 30, y: 14 }, width: 1.6 },
        { island: 2, anchor: { x: 130, y: 120 }, direction: { x: 1, y: 0 }, width: 1.6 },
      ]);
      expect(screen.queryByTestId("floating-surface")).not.toBeInTheDocument(); // moverlo termina el modo
    });
  });

  describe("Apply: un comando atómico, reversible y sin destruir el diseño", () => {
    it("Apply reemplaza SOLO los objetos modificados (misma capa, sus piezas) como UN comando; los demás conservan su d; undo/redo exactos; selecciona el resultado", async () => {
      const fetchMock = installWorkspaceFetch(BASE_OPTIONS);
      await renderWorkspace();
      await analyze(fetchMock);
      await waitFor(() => expect(screen.getByTestId("floating-reanalysis")).toHaveTextContent("2 flotantes → 0"));
      const before = pathData();
      expect(before).toContain(RING_R1);

      fireEvent.click(applyButton());

      await waitFor(() => expect(panelOpen()).toBe(false));
      const after = pathData();
      expect(after).not.toContain(RING_R1);
      expect(after).not.toContain(RING_B1);
      expect(after).toContain(R2); // r2 no cambia
      expect(after).toHaveLength(before.length); // un objeto por cada original (una pieza cada uno)
      expect(after.filter((d) => d.startsWith("M0 0 L40 0 L40 19.2"))).toHaveLength(1);
      expect(screen.getByText(GEOMETRY_DIRTY)).toBeInTheDocument();
      expect(screen.getByText(/Se aplicaron 2 bridges de 0.8 mm: 2 flotantes → 0\./)).toBeInTheDocument();
      expect(toolButton()).toHaveAttribute("aria-pressed", "false");

      fireEvent.click(undoButton());
      expect(pathData()).toEqual(before); // UN solo undo vuelve todo
      expect(undoButton()).toBeDisabled();
      fireEvent.click(redoButton());
      expect(pathData()).toEqual(after);
      expect(redoButton()).toBeDisabled();
    });

    it("tras aplicar, la selección queda en las piezas nuevas: Suprimir elimina esas y solo esas", async () => {
      const fetchMock = installWorkspaceFetch(BASE_OPTIONS);
      const { canvas } = await renderWorkspace();
      await analyze(fetchMock);
      await waitFor(() => expect(screen.getByTestId("floating-reanalysis")).toBeInTheDocument());
      const before = pathData();
      fireEvent.click(applyButton());
      await waitFor(() => expect(panelOpen()).toBe(false));
      expect(pathData().filter((d) => d.startsWith("M0 0 L40 0 L40 19.2") || d.startsWith("M100 100 L140 100 L140 119.2"))).toHaveLength(2);

      fireEvent.keyDown(canvas, { key: "Delete" });

      await waitFor(() => expect(pathData()).toHaveLength(before.length - 2));
      expect(pathData()).toContain(R2); // el objeto que no se tocó sigue ahí
    });

    it("Cancel no deja rastro: nada cambia, la pila de undo sigue vacía y la herramienta se cierra", async () => {
      const fetchMock = installWorkspaceFetch(BASE_OPTIONS);
      await renderWorkspace();
      await analyze(fetchMock);
      await waitFor(() => expect(screen.getByTestId("floating-reanalysis")).toBeInTheDocument());
      const before = pathData();

      fireEvent.click(cancelButton());

      expect(panelOpen()).toBe(false);
      expect(pathData()).toEqual(before);
      expect(undoButton()).toBeDisabled();
      expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();
      expect(screen.queryByTestId("floating-overlay")).not.toBeInTheDocument();
    });

    it("Escape en cascada: sale de la colocación, después descarta el análisis y, sin análisis, cierra la herramienta; Enter aplica", async () => {
      const fetchMock = installWorkspaceFetch(BASE_OPTIONS);
      await renderWorkspace();
      await analyze(fetchMock);
      await waitFor(() => expect(screen.getByTestId("floating-reanalysis")).toBeInTheDocument());
      fireEvent.click(inPanel().getByRole("button", { name: "Colocar bridge" }));

      press("Escape");
      expect(screen.queryByTestId("floating-surface")).not.toBeInTheDocument();
      expect(issueRows()).toHaveLength(2);

      press("Escape");
      expect(issueRows()).toHaveLength(0);
      expect(panelOpen()).toBe(true);
      expect(applyButton()).toBeDisabled();

      press("Escape");
      expect(panelOpen()).toBe(false);
      expect(undoButton()).toBeDisabled();

      openTool();
      fireEvent.click(analyzeButton());
      await waitFor(() => expect(issueRows().length).toBeGreaterThan(0));
      await waitFor(() => expect(screen.getByTestId("floating-reanalysis")).toBeInTheDocument());
      press("Enter");
      await waitFor(() => expect(panelOpen()).toBe(false));
      expect(screen.getByText(GEOMETRY_DIRTY)).toBeInTheDocument();
    });

    it("cambiar de herramienta con el análisis abierto lo descarta sin rastro", async () => {
      const fetchMock = installWorkspaceFetch(BASE_OPTIONS);
      await renderWorkspace();
      await analyze(fetchMock);
      const before = pathData();

      fireEvent.click(tool(/^Select/));

      expect(panelOpen()).toBe(false);
      expect(screen.queryByTestId("floating-overlay")).not.toBeInTheDocument();
      expect(pathData()).toEqual(before);
      expect(undoButton()).toBeDisabled();
      openTool();
      expect(issueRows()).toHaveLength(0); // sesión nueva
    });
  });

  describe("bloqueados, inválidos y fallos", () => {
    it("un objeto de una capa BLOQUEADA cuenta para el análisis pero NO se modifica: su bridge sugerido no se puede resolver, se informa y Apply conserva el resto", async () => {
      const fetchMock = installWorkspaceFetch({ ...BASE_OPTIONS, lockedB: true });
      await renderWorkspace();
      await analyze(fetchMock);
      await waitFor(() => expect(screen.getByTestId("floating-reanalysis")).toHaveTextContent("2 flotantes → 1"));

      expect(issueRows()).toHaveLength(2); // la isla del bloqueado SÍ se detecta
      const warnings = inPanel().getByRole("list", { name: "Advertencias de los bridges" }).textContent ?? "";
      expect(warnings).toMatch(/No se pudo sugerir un bridge para Isla 2 \(necesitaría modificar un objeto en una capa bloqueada/);
      expect(warnings).toMatch(/1 objeto en una capa bloqueada cuenta para el análisis y no se modifica\./);
      expect(applyButton()).toBeEnabled();
      const before = pathData();

      fireEvent.click(applyButton());

      await waitFor(() => expect(panelOpen()).toBe(false));
      expect(pathData()).toContain(RING_B1); // el bloqueado intacto
      expect(pathData()).not.toContain(RING_R1);
      expect(before).toContain(RING_B1);
    });

    it("un bridge colocado a mano sobre un objeto bloqueado es INVÁLIDO: se ve con su motivo, Apply se deshabilita (con CUALQUIER inválido) y quitarlo lo vuelve a habilitar", async () => {
      const fetchMock = installWorkspaceFetch({ ...BASE_OPTIONS, lockedB: true });
      await renderWorkspace();
      await analyze(fetchMock);
      await waitFor(() => expect(screen.getByTestId("floating-reanalysis")).toBeInTheDocument());

      fireEvent.click(inPanel().getByRole("button", { name: "Colocar bridge" }));
      clickAt(screen.getByTestId("floating-surface"), 131, 118); // borde de la isla 2 (objeto bloqueado)

      await waitFor(() => expect(bridgeRows()).toHaveLength(2));
      await waitFor(() => expect(applyButton()).toBeDisabled());
      expect(bridgeRows()[1].textContent).toMatch(/inválido: necesitaría modificar un objeto en una capa bloqueada/);
      expect(applyButton()).toHaveAttribute("title", "1 bridge es inválido: quitalo o corregilo antes de aplicar.");
      expect(inPanel().getByRole("alert")).toHaveTextContent(/1 bridge es inválido/);
      expect(document.querySelectorAll('[data-testid="floating-bridge"][data-valid="false"]')).toHaveLength(1);

      fireEvent.click(inPanel().getByRole("button", { name: "Quitar Bridge 2" }));
      await waitFor(() => expect(applyButton()).toBeEnabled());
    });

    it("un error del servidor en el análisis no cambia nada: mensaje con Reintentar, que se recupera", async () => {
      let fail = true;
      const fetchMock = installWorkspaceFetch({ ...BASE_OPTIONS, floating: (body) => (fail ? jsonResponse({ code: "processing_error", message: "boom" }, 500) : fakeFloating(body)) });
      await renderWorkspace();
      const before = pathData();
      openTool();

      fireEvent.click(analyzeButton());

      expect(await screen.findByText(/El servidor no pudo completar el cálculo\. No se modificó nada\./)).toBeInTheDocument();
      expect(pathData()).toEqual(before);
      expect(applyButton()).toBeDisabled();
      fail = false;
      fireEvent.click(inPanel().getByRole("button", { name: "Reintentar" }));
      await waitFor(() => expect(issueRows()).toHaveLength(2));
      expect(fetchMock.floatingCalls).toHaveLength(2);
    });

    it("un error del servidor en los bridges deja Apply deshabilitado, no cambia nada y Reintentar se recupera", async () => {
      let fail = true;
      const fetchMock = installWorkspaceFetch({ ...BASE_OPTIONS, bridge: (body) => (fail ? jsonResponse({ code: "timeout", message: "lento" }, 504) : fakeBridge(body)) });
      await renderWorkspace();
      const before = pathData();
      openTool();
      fireEvent.click(analyzeButton());
      await waitFor(() => expect(issueRows()).toHaveLength(2));

      expect(await screen.findByText(/El cálculo tardó demasiado y se canceló\. No se modificó nada\./)).toBeInTheDocument();
      expect(applyButton()).toBeDisabled();
      expect(applyButton()).toHaveAttribute("title", "El cálculo falló: reintentalo o cambiá los bridges.");
      expect(pathData()).toEqual(before);
      expect(undoButton()).toBeDisabled();

      fail = false;
      fireEvent.click(inPanel().getByRole("button", { name: "Reintentar" }));
      await waitFor(() => expect(applyButton()).toBeEnabled());
      expect(bridgeCalls(fetchMock)).toHaveLength(2);
    });

    it("una respuesta incoherente del servidor (más flotantes después que antes) se rechaza: no se muestra ni se aplica", async () => {
      installWorkspaceFetch({
        ...BASE_OPTIONS,
        bridge: (body) => {
          const payload = bridgePayload(body);
          return jsonResponse({ ...payload, reanalysis: { floatingBefore: 2, floatingAfter: 5, mainAfter: 1 } });
        },
      });
      await renderWorkspace();
      const before = pathData();
      openTool();

      fireEvent.click(analyzeButton());

      expect(await screen.findByText(/El servidor devolvió una respuesta incoherente.*No se modificó nada\./)).toBeInTheDocument();
      expect(applyButton()).toBeDisabled();
      expect(pathData()).toEqual(before);
    });

    it("si el documento cambia después de analizar (undo de una edición) el análisis queda VIEJO: se avisa, se oculta el overlay y no se puede aplicar", async () => {
      const fetchMock = installWorkspaceFetch(BASE_OPTIONS);
      const { canvas } = await renderWorkspace();
      click(canvas, 20, 5); // r1
      fireEvent.keyDown(canvas, { key: "ArrowRight" }); // un empujón = un comando
      expect(undoButton()).toBeEnabled();
      press("Escape"); // sin selección el alcance son las capas CUT
      openTool();
      fireEvent.click(analyzeButton());
      await waitFor(() => expect(issueRows()).toHaveLength(2));
      await waitFor(() => expect(screen.getByTestId("floating-reanalysis")).toBeInTheDocument());

      fireEvent.click(undoButton());

      expect(await screen.findByText(/El documento cambió desde el análisis: volvé a analizar\. No se modificó nada\./)).toBeInTheDocument();
      expect(screen.queryByTestId("floating-overlay")).not.toBeInTheDocument();
      expect(issueRows()).toHaveLength(0);
      expect(applyButton()).toBeDisabled();
      expect(applyButton()).toHaveAttribute("title", "El documento cambió desde el análisis: volvé a analizar.");
      fireEvent.click(analyzeButton());
      await waitFor(() => expect(issueRows()).toHaveLength(2));
      expect(fetchMock.floatingCalls).toHaveLength(2);
    });
  });

  describe("StrictMode", () => {
    it("el análisis y las sugerencias salen UNA sola vez (efecto -> cleanup -> efecto) y el flujo completo funciona", async () => {
      const fetchMock = installWorkspaceFetch(BASE_OPTIONS);
      await renderWorkspace({ strict: true });

      await analyze(fetchMock);
      await waitFor(() => expect(screen.getByTestId("floating-reanalysis")).toHaveTextContent("2 flotantes → 0"));
      await new Promise((resolve) => setTimeout(resolve, 350));

      expect(fetchMock.floatingCalls).toHaveLength(1);
      expect(bridgeCalls(fetchMock)).toHaveLength(1);
      fireEvent.click(applyButton());
      await waitFor(() => expect(panelOpen()).toBe(false));
      expect(pathData()).not.toContain(RING_R1);
      fireEvent.click(undoButton());
      expect(pathData()).toContain(RING_R1);
    });
  });
});
