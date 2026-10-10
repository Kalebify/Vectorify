import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GEOMETRY_DIRTY,
  installResizeObserver,
  installWorkspaceFetch,
  jsonResponse,
  layerNames,
  LN1,
  pathByData,
  pathData,
  R1,
  redoButton,
  renderWorkspace,
  tool,
  toScreen,
  undoButton,
} from "../../test/workspaceFixture";

/**
 * Integración del Offset (M3-S09) en el Workspace completo: herramienta Offset, distancia en mm (escala 0,5 mm por unidad), dirección, joins/caps,
 * preview del servidor (debounce + AbortSignal, UNA petición viva), colapso total (Apply deshabilitado con la explicación) y parcial (confirmación
 * explícita), capa de origen o destino explícito, conservar/reemplazar, un comando por Apply, undo/redo exactos y StrictMode. Capas de la fixture:
 * Rojo (r1 0..40², r2 0..40 x 100..140), Azul (b1 100..140²) y Líneas (ln1 abierta y = 20 de x 200 a 260). El servidor se simula con un motor de
 * RECTÁNGULOS que obedece la distancia FIRMADA (crece, o se encoge y colapsa cuando 2d >= el lado menor); el cálculo real se prueba en
 * services/python-engine/tests.
 */

type Body = Record<string, unknown>;
type Subject = { type: "polygon" | "line"; coordinates: number[][][] | number[][] };

const rectRing = (x0: number, y0: number, x1: number, y1: number) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];

/** Offset de rectángulos: el bbox de cada subject, agrandado (d > 0) o encogido (d < 0; vacío si 2|d| >= el lado menor). Hace eco de los parámetros. */
function fakeOffset(body: Body): Response {
  const distance = body.distance as number;
  const results = (body.subjects as Subject[]).map((subject, index) => {
    const points = (subject.type === "polygon" ? (subject.coordinates as number[][][])[0] : (subject.coordinates as number[][])) as number[][];
    const xs = points.map((point) => point[0]);
    const ys = points.map((point) => point[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const isLine = subject.type === "line";
    const amount = Math.abs(distance);
    const maxInward = isLine ? null : Math.min(x1 - x0, y1 - y0) / 2;
    const collapsed = distance < 0 && 2 * amount >= Math.min(x1 - x0, y1 - y0);
    const geometries = collapsed
      ? []
      : [{ type: "polygon", coordinates: [rectRing(x0 - Math.sign(distance) * amount, y0 - Math.sign(distance) * amount, x1 + Math.sign(distance) * amount, y1 + Math.sign(distance) * amount)] }];
    return { subjectIndex: index, geometries, collapsed, piecesBefore: 1, splitCount: geometries.length, lostPieces: collapsed ? 1 : 0, holesBefore: 0, holesAfter: 0, maxInwardOffset: maxInward };
  });
  return jsonResponse({
    distance,
    joinStyle: body.joinStyle,
    mitreLimit: body.mitreLimit,
    capStyle: body.capStyle,
    tolerance: body.tolerance,
    pieceCount: results.reduce((total, item) => total + item.geometries.length, 0),
    results,
  });
}

/** r1 grande (0..80) y r2 chica (0..20 x 100..120): con un offset interior de 10 mm (20 u) r1 sobrevive (40 x 40) y r2 colapsa. */
const BIG_R1 = "M0 0 H80 V80 H0 Z";
const SMALL_R2 = "M0 100 H20 V120 H0 Z";
const MIXED_SIZES = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><path data-vid="r1" d="${BIG_R1}" fill="#ff0000"/><path data-vid="r2" d="${SMALL_R2}" fill="#ff0000"/></svg>`;

const R1_GROWN_1MM = "M-2 -2 L42 -2 L42 42 L-2 42 Z"; // r1 (0..40) + 2 u por lado
const panel = () => screen.getByRole("heading", { name: "Offset" }).closest("section")!;
const inPanel = () => within(panel());
const panelOpen = () => screen.queryByRole("heading", { name: "Offset" }) !== null;
const applyButton = () => inPanel().getByRole("button", { name: "Apply" });
const cancelButton = () => inPanel().getByRole("button", { name: "Cancel" });
const press = (key: string) => fireEvent.keyDown(screen.getByRole("application"), { key });
const distanceField = () => inPanel().getByLabelText("Offset (mm)") as HTMLInputElement;
const confirmBox = () => inPanel().queryByRole("checkbox", { name: /Entiendo que/ }) as HTMLInputElement | null;
const stateText = () => inPanel().getAllByRole("status")[0].textContent ?? "";

function click(canvas: HTMLElement, x: number, y: number, options: { shiftKey?: boolean } = {}) {
  fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, ...toScreen(x, y), ...options });
  fireEvent.pointerUp(canvas, { pointerId: 1, ...toScreen(x, y), ...options });
}

const R1_AT = [20, 20] as const;
const B1_AT = [120, 120] as const;
const LN1_AT = [230, 21] as const;
const BIG_R1_AT = [40, 40] as const;
const SMALL_R2_AT = [10, 110] as const;

function selectObjects(canvas: HTMLElement, ...points: Array<readonly [number, number]>) {
  points.forEach(([x, y], index) => click(canvas, x, y, { shiftKey: index > 0 }));
}

type FetchMock = ReturnType<typeof installWorkspaceFetch>;
const offsetCalls = (fetchMock: FetchMock) => fetchMock.offsetCalls;
const offsetSignals = (fetchMock: FetchMock) => fetchMock.urls.flatMap((url, index) => (url.endsWith("/api/v2/geometry/offset") ? [fetchMock.signals[index]] : []));
const toolButton = () => tool(/^Offset/);
const startOffset = () => fireEvent.click(toolButton());

async function openOffset(canvas: HTMLElement, fetchMock: FetchMock, points: Array<readonly [number, number]> = [R1_AT], expectedCalls = 1) {
  selectObjects(canvas, ...points);
  startOffset();
  await waitFor(() => expect(offsetCalls(fetchMock)).toHaveLength(expectedCalls));
  await waitFor(() => expect(inPanel().getByRole("status")).toHaveTextContent(/Resultado: |colapsa/));
}

describe("EditorShell — Offset (M3-S09)", () => {
  beforeEach(() => installResizeObserver());
  afterEach(() => vi.unstubAllGlobals());

  describe("acceso", () => {
    it("la herramienta Offset está habilitada; sin selección el panel lo dice, no llama al servidor y Apply está deshabilitado", async () => {
      const fetchMock = installWorkspaceFetch({ offset: fakeOffset });
      await renderWorkspace();
      expect(toolButton()).toBeEnabled();

      startOffset();

      expect(panelOpen()).toBe(true);
      expect(toolButton()).toHaveAttribute("aria-pressed", "true");
      expect(stateText()).toMatch(/Seleccioná uno o más objetos/);
      expect(applyButton()).toBeDisabled();
      expect(screen.queryByTestId("offset-overlay")).not.toBeInTheDocument();
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(offsetCalls(fetchMock)).toHaveLength(0);
    });

    it("con una selección previa, abrir pide el resultado UNA vez en mm convertidos a unidades (1 mm = 2 u; 0,01 mm = 0,02 u)", async () => {
      const fetchMock = installWorkspaceFetch({ offset: fakeOffset });
      const { canvas } = await renderWorkspace();

      await openOffset(canvas, fetchMock);

      const body = offsetCalls(fetchMock)[0];
      expect(body.distance).toBeCloseTo(2, 12);
      expect(body.tolerance).toBeCloseTo(0.02, 12);
      expect(body.joinStyle).toBe("round");
      expect(body.mitreLimit).toBe(2);
      expect(body.capStyle).toBe("round");
      expect(body.subjects).toEqual([{ type: "polygon", coordinates: [[[0, 0], [40, 0], [40, 40], [0, 40]]] }]);
      expect(fetchMock.urls.filter((url) => url.endsWith("/api/v2/geometry/offset"))).toHaveLength(1);
      expect(fetchMock.geometryCalls).toHaveLength(0); // no usa el endpoint de booleanas
    });

    it("el preview dibuja el resultado y atenúa el original sin tocar el documento ni la pila de undo", async () => {
      const fetchMock = installWorkspaceFetch({ offset: fakeOffset });
      const { canvas } = await renderWorkspace();
      const before = pathData();

      await openOffset(canvas, fetchMock);

      expect(screen.getByTestId("offset-preview").querySelectorAll("path")).toHaveLength(1);
      expect(screen.getByTestId("offset-preview").querySelector("path")!.getAttribute("d")).toBe(R1_GROWN_1MM);
      expect(screen.getByTestId("offset-preview").querySelector("path")!.getAttribute("fill")).toBe("#ff0000"); // el color de la capa del objeto de origen
      expect(screen.getAllByTestId("offset-veil")).toHaveLength(1);
      expect(pathData()).toEqual(before);
      expect(undoButton()).toBeDisabled();
      expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();
    });

    it("cambiar a otra herramienta cancela sin rastro, aborta lo que estaba en vuelo y cierra el panel", async () => {
      const fetchMock = installWorkspaceFetch({ offset: () => new Promise<Response>(() => {}) });
      const { canvas } = await renderWorkspace();
      selectObjects(canvas, R1_AT);
      startOffset();
      await waitFor(() => expect(offsetCalls(fetchMock)).toHaveLength(1));

      fireEvent.click(tool(/^Select/));

      expect(panelOpen()).toBe(false);
      expect(offsetSignals(fetchMock)[0]?.aborted).toBe(true);
      expect(undoButton()).toBeDisabled();
      expect(screen.queryByTestId("offset-overlay")).not.toBeInTheDocument();
    });

    it("en la herramienta Offset el canvas solo selecciona: las flechas y Suprimir no mueven ni borran nada", async () => {
      const fetchMock = installWorkspaceFetch({ offset: fakeOffset });
      const { canvas } = await renderWorkspace();
      await openOffset(canvas, fetchMock);

      fireEvent.keyDown(canvas, { key: "ArrowRight" });
      fireEvent.keyDown(canvas, { key: "Delete" });

      expect(undoButton()).toBeDisabled();
      expect(pathData()).toContain(R1);
    });

    it("cambiar la selección con el panel abierto vuelve a calcular con los objetos nuevos", async () => {
      const fetchMock = installWorkspaceFetch({ offset: fakeOffset });
      const { canvas } = await renderWorkspace();
      await openOffset(canvas, fetchMock);

      click(canvas, ...B1_AT);
      await waitFor(() => expect(offsetCalls(fetchMock)).toHaveLength(2));

      expect((offsetCalls(fetchMock)[1].subjects as Subject[])[0].coordinates).toEqual([[[100, 100], [140, 100], [140, 140], [100, 140]]]);
      await waitFor(() => expect(screen.getByTestId("offset-preview").querySelector("path")!.getAttribute("fill")).toBe("#0000ff"));
    });
  });

  describe("distancia, dirección, joins y caps", () => {
    it("los presets y el campo cambian la distancia y piden de nuevo en unidades (2 mm = 4 u; 0,25 mm = 0,5 u)", async () => {
      const fetchMock = installWorkspaceFetch({ offset: fakeOffset });
      const { canvas } = await renderWorkspace();
      await openOffset(canvas, fetchMock);

      fireEvent.click(inPanel().getByRole("button", { name: "2 mm" }));
      await waitFor(() => expect(offsetCalls(fetchMock)).toHaveLength(2));
      expect(offsetCalls(fetchMock)[1].distance).toBeCloseTo(4, 12);
      expect(inPanel().getByRole("button", { name: "2 mm" })).toHaveAttribute("aria-pressed", "true");

      fireEvent.change(distanceField(), { target: { value: "0,25" } });
      fireEvent.keyDown(distanceField(), { key: "Enter" });
      await waitFor(() => expect(offsetCalls(fetchMock)).toHaveLength(3));
      expect(offsetCalls(fetchMock)[2].distance).toBeCloseTo(0.5, 12);

      fireEvent.keyDown(distanceField(), { key: "ArrowUp" });
      await waitFor(() => expect(offsetCalls(fetchMock)).toHaveLength(4));
      expect(offsetCalls(fetchMock)[3].distance).toBeCloseTo(0.7, 12); // 0,35 mm
    });

    it("un valor inválido (0, negativo, texto, más de 1000 mm) se rechaza con mensaje y NO llama al servidor", async () => {
      const fetchMock = installWorkspaceFetch({ offset: fakeOffset });
      const { canvas } = await renderWorkspace();
      await openOffset(canvas, fetchMock);

      for (const text of ["0", "-3", "abc", "1001"]) {
        fireEvent.change(distanceField(), { target: { value: text } });
        fireEvent.keyDown(distanceField(), { key: "Enter" });
        expect(inPanel().getAllByRole("alert").at(-1)).toBeInTheDocument();
        expect(distanceField().value).toBe("1");
      }
      await new Promise((resolve) => setTimeout(resolve, 350));

      expect(offsetCalls(fetchMock)).toHaveLength(1);
      expect(applyButton()).toBeEnabled();
    });

    it("Interior manda la distancia NEGATIVA (misma magnitud) y Exterior la positiva", async () => {
      const fetchMock = installWorkspaceFetch({ offset: fakeOffset });
      const { canvas } = await renderWorkspace();
      await openOffset(canvas, fetchMock);

      fireEvent.click(inPanel().getByRole("radio", { name: "Interior" }));
      await waitFor(() => expect(offsetCalls(fetchMock)).toHaveLength(2));
      expect(offsetCalls(fetchMock)[1].distance).toBeCloseTo(-2, 12);

      fireEvent.click(inPanel().getByRole("radio", { name: "Exterior" }));
      await waitFor(() => expect(offsetCalls(fetchMock)).toHaveLength(3));
      expect(offsetCalls(fetchMock)[2].distance).toBeCloseTo(2, 12);
    });

    it("Inglete muestra el límite (default 2) y lo manda; cambiarlo vuelve a pedir; Bisel manda bevel", async () => {
      const fetchMock = installWorkspaceFetch({ offset: fakeOffset });
      const { canvas } = await renderWorkspace();
      await openOffset(canvas, fetchMock);

      fireEvent.click(inPanel().getByRole("radio", { name: "Inglete" }));
      await waitFor(() => expect(offsetCalls(fetchMock)).toHaveLength(2));
      expect(offsetCalls(fetchMock)[1]).toMatchObject({ joinStyle: "mitre", mitreLimit: 2 });
      const limit = inPanel().getByLabelText("Límite de inglete (×)");
      expect((limit as HTMLInputElement).value).toBe("2");

      fireEvent.change(limit, { target: { value: "5" } });
      fireEvent.keyDown(limit, { key: "Enter" });
      await waitFor(() => expect(offsetCalls(fetchMock)).toHaveLength(3));
      expect(offsetCalls(fetchMock)[2]).toMatchObject({ joinStyle: "mitre", mitreLimit: 5 });

      fireEvent.click(inPanel().getByRole("radio", { name: "Bisel" }));
      await waitFor(() => expect(offsetCalls(fetchMock)).toHaveLength(4));
      expect(offsetCalls(fetchMock)[3].joinStyle).toBe("bevel");
    });

    it("una línea abierta: «Ambos lados», Interior deshabilitado con el motivo, los caps aparecen y viajan; el resultado es un polígono con el color de SU capa", async () => {
      const fetchMock = installWorkspaceFetch({ offset: fakeOffset });
      const { canvas } = await renderWorkspace();
      await openOffset(canvas, fetchMock, [LN1_AT]);

      expect(inPanel().getByRole("radio", { name: "Ambos lados" })).toBeChecked();
      expect(inPanel().getByRole("radio", { name: "Interior" })).toBeDisabled();
      expect(inPanel().getByText(/Interior deshabilitado: Una línea abierta no tiene interior/)).toBeInTheDocument();
      const first = offsetCalls(fetchMock)[0];
      expect((first.subjects as Subject[])[0].type).toBe("line");
      expect(first.distance as number).toBeGreaterThan(0);

      fireEvent.click(inPanel().getByRole("radio", { name: "Cuadrado" }));
      await waitFor(() => expect(offsetCalls(fetchMock)).toHaveLength(2));
      expect(offsetCalls(fetchMock)[1].capStyle).toBe("square");
      await waitFor(() => expect(inPanel().getByRole("status")).toHaveTextContent(/Resultado: 1 pieza/));

      fireEvent.click(applyButton());
      await waitFor(() => expect(panelOpen()).toBe(false));

      expect(pathData()).toContain(LN1); // conserva la línea original
      const band = pathData().find((d) => d !== LN1 && d.startsWith("M198 18"));
      expect(band).toBeDefined();
      expect(pathByData(band!)!.fill()).toBe("#00aa00");
    });

    it("las formas y las líneas mezcladas: Interior queda deshabilitado y el panel dice que las líneas van a ambos lados", async () => {
      const fetchMock = installWorkspaceFetch({ offset: fakeOffset });
      const { canvas } = await renderWorkspace();

      await openOffset(canvas, fetchMock, [R1_AT, LN1_AT]);

      expect(inPanel().getByRole("radio", { name: "Exterior" })).toBeChecked();
      expect(inPanel().getByRole("radio", { name: "Interior" })).toBeDisabled();
      expect(inPanel().getByText(/las líneas se desplazan a ambos lados/)).toBeInTheDocument();
      expect((offsetCalls(fetchMock)[0].subjects as Subject[]).map((subject) => subject.type)).toEqual(["polygon", "line"]);
    });
  });

  describe("escala real", () => {
    it("SIN escala física trabaja en unidades (no inventa mm): aviso visible, campo en u y la distancia viaja tal cual", async () => {
      const fetchMock = installWorkspaceFetch({ offset: fakeOffset });
      const { canvas } = await renderWorkspace({ dimensionWidthMm: null });

      await openOffset(canvas, fetchMock);

      expect(inPanel().getByRole("note")).toHaveTextContent(/Sin escala física: el offset es en unidades/);
      expect(inPanel().getByLabelText("Offset (u)")).toBeInTheDocument();
      expect(inPanel().queryByLabelText("Offset (mm)")).not.toBeInTheDocument();
      expect(offsetCalls(fetchMock)[0].distance).toBe(1);
      expect(offsetCalls(fetchMock)[0].tolerance).toBe(0.01);
    });

    it("CON escala física no hay aviso de escala", async () => {
      const fetchMock = installWorkspaceFetch({ offset: fakeOffset });
      const { canvas } = await renderWorkspace();

      await openOffset(canvas, fetchMock);

      expect(inPanel().queryByRole("note")).not.toBeInTheDocument();
    });
  });

  describe("aplicar: un comando atómico undoable", () => {
    it("por defecto CONSERVA el original: agrega el contorno en la capa y con el color del objeto de origen; un solo Deshacer lo quita", async () => {
      const fetchMock = installWorkspaceFetch({ offset: fakeOffset });
      const { canvas } = await renderWorkspace();
      await openOffset(canvas, fetchMock);
      const before = pathData();
      expect(inPanel().getByRole("checkbox", { name: "Conservar original" })).toBeChecked();

      fireEvent.click(applyButton());

      await waitFor(() => expect(pathData()).toContain(R1_GROWN_1MM));
      expect(pathData()).toContain(R1);
      expect(pathData()).toHaveLength(before.length + 1);
      expect(pathByData(R1_GROWN_1MM)!.fill()).toBe("#ff0000");
      expect(panelOpen()).toBe(false); // vuelve a Select
      expect(tool(/^Select/)).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByText(GEOMETRY_DIRTY)).toBeInTheDocument();
      expect(screen.getByText(/Offset exterior de 1 mm aplicado: 1 objeto → 1 pieza en «Rojo»\. Los originales se conservaron\./)).toBeInTheDocument();
      expect(offsetCalls(fetchMock)).toHaveLength(1); // Apply usó el resultado ya calculado

      fireEvent.click(undoButton());
      expect(pathData()).toEqual(before); // un único comando: un solo Deshacer devuelve todo, en el mismo orden
      expect(undoButton()).toBeDisabled();
      fireEvent.click(redoButton());
      expect(pathData()).toContain(R1_GROWN_1MM);
      expect(pathData()).toContain(R1);
    });

    it("la etiqueta del comando describe el offset en el botón Deshacer", async () => {
      const fetchMock = installWorkspaceFetch({ offset: fakeOffset });
      const { canvas } = await renderWorkspace();
      await openOffset(canvas, fetchMock);

      fireEvent.click(applyButton());

      await waitFor(() => expect(undoButton()).toBeEnabled());
      expect(undoButton().getAttribute("title") ?? undoButton().getAttribute("aria-label")).toMatch(/Offset exterior 1 mm \(1 objeto → 1 pieza\)/);
    });

    it("«Reemplazar» saca el original y el contorno ocupa su lugar; Deshacer devuelve el orden exacto", async () => {
      const fetchMock = installWorkspaceFetch({ offset: fakeOffset });
      const { canvas } = await renderWorkspace();
      await openOffset(canvas, fetchMock);
      const before = pathData();

      fireEvent.click(inPanel().getByRole("checkbox", { name: "Conservar original" }));
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(offsetCalls(fetchMock)).toHaveLength(1); // conservar/reemplazar no cambia la geometría: no vuelve a pedir
      fireEvent.click(applyButton());

      await waitFor(() => expect(pathData()).toContain(R1_GROWN_1MM));
      expect(pathData()).not.toContain(R1);
      expect(pathData()).toHaveLength(before.length);
      fireEvent.click(undoButton());
      expect(pathData()).toEqual(before);
    });

    it("Enter aplica; Escape cancela sin rastro (ni comando, ni geometría sin guardar)", async () => {
      const fetchMock = installWorkspaceFetch({ offset: fakeOffset });
      const { canvas } = await renderWorkspace();
      await openOffset(canvas, fetchMock);
      const before = pathData();

      press("Escape");

      expect(panelOpen()).toBe(false);
      expect(pathData()).toEqual(before);
      expect(undoButton()).toBeDisabled();
      expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();
      expect(screen.queryByTestId("offset-overlay")).not.toBeInTheDocument();

      startOffset();
      await waitFor(() => expect(inPanel().getByRole("status")).toHaveTextContent(/Resultado: 1 pieza/));
      press("Enter");
      await waitFor(() => expect(pathData()).toContain(R1_GROWN_1MM));
    });

    it("el botón Cancel también cierra sin rastro", async () => {
      const fetchMock = installWorkspaceFetch({ offset: fakeOffset });
      const { canvas } = await renderWorkspace();
      await openOffset(canvas, fetchMock);
      const before = pathData();

      fireEvent.click(cancelButton());

      expect(panelOpen()).toBe(false);
      expect(pathData()).toEqual(before);
      expect(undoButton()).toBeDisabled();
      expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();
    });

    it("varios objetos: cada resultado va a la capa de SU origen con el color de esa capa, en un solo comando", async () => {
      const fetchMock = installWorkspaceFetch({ offset: fakeOffset });
      const { canvas } = await renderWorkspace();
      await openOffset(canvas, fetchMock, [R1_AT, B1_AT]);
      expect(inPanel().getByText(/«Rojo» \(1 objeto\), «Azul» \(1 objeto\)/)).toBeInTheDocument();
      const before = pathData();

      fireEvent.click(applyButton());

      await waitFor(() => expect(pathData()).toHaveLength(before.length + 2));
      expect(pathByData(R1_GROWN_1MM)!.fill()).toBe("#ff0000");
      expect(pathByData("M98 98 L142 98 L142 142 L98 142 Z")!.fill()).toBe("#0000ff");
      fireEvent.click(undoButton());
      expect(pathData()).toEqual(before);
      expect(undoButton()).toBeDisabled();
    });

    it("una capa destino explícita manda el resultado a ESA capa con SU color; el panel lo dice", async () => {
      const fetchMock = installWorkspaceFetch({ offset: fakeOffset });
      const { canvas } = await renderWorkspace();
      await openOffset(canvas, fetchMock);
      const select = inPanel().getByLabelText("Dónde va el resultado") as HTMLSelectElement;
      expect(select.value).toBe("origin");

      fireEvent.change(select, { target: { value: within(select).getByRole("option", { name: "Azul (#0000ff)" }).getAttribute("value") } });
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(inPanel().getByText(/Todos los resultados van a «Azul», con el color #0000ff/)).toBeInTheDocument();
      expect(offsetCalls(fetchMock)).toHaveLength(1); // la capa no cambia la geometría
      expect(screen.getByTestId("offset-preview").querySelector("path")!.getAttribute("fill")).toBe("#0000ff");
      fireEvent.click(applyButton());

      await waitFor(() => expect(pathData()).toContain(R1_GROWN_1MM));
      expect(pathByData(R1_GROWN_1MM)!.fill()).toBe("#0000ff");
      expect(pathData()).toContain(R1);
    });

    it("capa nueva con un color: Apply se bloquea sin color válido, se crea en el MISMO comando y Deshacer la elimina", async () => {
      const fetchMock = installWorkspaceFetch({ offset: fakeOffset });
      const { canvas } = await renderWorkspace();
      await openOffset(canvas, fetchMock);

      fireEvent.change(inPanel().getByLabelText("Dónde va el resultado"), { target: { value: "__new__" } });
      expect(applyButton()).toBeDisabled(); // sin color todavía
      expect(applyButton().getAttribute("title")).toMatch(/no es un color hex válido/);
      fireEvent.change(inPanel().getByLabelText("Color de la capa nueva (#RRGGBB)"), { target: { value: "#123456" } });
      expect(applyButton()).toBeEnabled();
      fireEvent.click(applyButton());

      await waitFor(() => expect(pathData()).toContain(R1_GROWN_1MM));
      expect(pathByData(R1_GROWN_1MM)!.fill()).toBe("#123456");
      expect(layerNames()).toContain("Color #123456");
      fireEvent.click(undoButton());
      expect(layerNames()).not.toContain("Color #123456");
      expect(pathData()).not.toContain(R1_GROWN_1MM);
      expect(undoButton()).toBeDisabled();
    });
  });

  describe("capas bloqueadas u ocultas: rechazo explícito", () => {
    it("un objeto de una capa bloqueada rechaza la operación: motivo visible, ninguna llamada y Apply deshabilitado", async () => {
      const fetchMock = installWorkspaceFetch({ offset: fakeOffset, lockedA: true });
      const { canvas } = await renderWorkspace();
      selectObjects(canvas, R1_AT);

      startOffset();

      expect(inPanel().getByRole("alert")).toHaveTextContent(/capa bloqueada/);
      expect(applyButton()).toBeDisabled();
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(offsetCalls(fetchMock)).toHaveLength(0);
    });

    it("una selección con un objeto bloqueado y otro libre se rechaza ENTERA (no se omite el bloqueado en silencio)", async () => {
      const fetchMock = installWorkspaceFetch({ offset: fakeOffset, lockedB: true });
      const { canvas } = await renderWorkspace();
      selectObjects(canvas, R1_AT, B1_AT);

      startOffset();

      expect(inPanel().getByRole("alert")).toHaveTextContent(/1 objeto está en una capa bloqueada/);
      expect(applyButton()).toBeDisabled();
      press("Enter");
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(offsetCalls(fetchMock)).toHaveLength(0);
      expect(pathData()).toContain(R1);
      expect(undoButton()).toBeDisabled();
    });
  });

  describe("colapso: nada en silencio", () => {
    it("TODOS colapsan: Apply y Enter no hacen nada, la explicación con el máximo interior (≈ 10 mm) está a la vista y el original se marca en el canvas", async () => {
      const fetchMock = installWorkspaceFetch({ offset: fakeOffset });
      const { canvas } = await renderWorkspace();
      await openOffset(canvas, fetchMock);
      const before = pathData();

      fireEvent.click(inPanel().getByRole("radio", { name: "Interior" }));
      fireEvent.change(distanceField(), { target: { value: "10" } });
      fireEvent.keyDown(distanceField(), { key: "Enter" });
      await waitFor(() => expect(stateText()).toMatch(/El objeto colapsa con este offset \(máximo interior ≈ 10 mm\)/));

      expect(applyButton()).toBeDisabled();
      expect(applyButton().getAttribute("title")).toMatch(/Reducí el offset o elegí Exterior/);
      expect(inPanel().getAllByRole("alert").some((alert) => /El objeto colapsa/.test(alert.textContent ?? ""))).toBe(true);
      expect(confirmBox()).toBeNull(); // confirmar no tiene sentido: no hay nada que aplicar
      expect(screen.getAllByTestId("offset-collapsed")).toHaveLength(1);
      expect(screen.queryByTestId("offset-veil")).not.toBeInTheDocument();
      fireEvent.click(applyButton());
      press("Enter");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(pathData()).toEqual(before);
      expect(undoButton()).toBeDisabled();
      expect(panelOpen()).toBe(true);
    });

    it("justo por debajo del colapso (9,9 mm de 10) todavía se puede aplicar", async () => {
      const fetchMock = installWorkspaceFetch({ offset: fakeOffset });
      const { canvas } = await renderWorkspace();
      await openOffset(canvas, fetchMock);

      fireEvent.click(inPanel().getByRole("radio", { name: "Interior" }));
      fireEvent.change(distanceField(), { target: { value: "9,9" } });
      fireEvent.keyDown(distanceField(), { key: "Enter" });
      await waitFor(() => expect(stateText()).toMatch(/Resultado: 1 pieza/));

      expect(applyButton()).toBeEnabled();
      expect(screen.queryByTestId("offset-collapsed")).not.toBeInTheDocument();
    });

    describe("ALGUNOS colapsan (r1 grande y r2 chica, interior de 10 mm)", () => {
      async function openPartial() {
        const fetchMock = installWorkspaceFetch({ offset: fakeOffset, svg: { A: MIXED_SIZES } });
        const { canvas } = await renderWorkspace();
        selectObjects(canvas, BIG_R1_AT, SMALL_R2_AT);
        startOffset();
        await waitFor(() => expect(offsetCalls(fetchMock)).toHaveLength(1));
        fireEvent.click(inPanel().getByRole("radio", { name: "Interior" }));
        fireEvent.change(distanceField(), { target: { value: "10" } });
        fireEvent.keyDown(distanceField(), { key: "Enter" });
        // Interior + 10 mm seguidos: el debounce junta los dos cambios en UNA petición (la 2ª), con la distancia final.
        await waitFor(() => expect(offsetCalls(fetchMock)).toHaveLength(2));
        expect(offsetCalls(fetchMock)[1].distance).toBeCloseTo(-20, 12);
        await waitFor(() => expect(stateText()).toMatch(/Resultado: 1 pieza a partir de 1 objeto/));
        return { fetchMock, canvas };
      }

      it("avisa cuántos colapsan (con el máximo interior), marca el objeto y deja Apply deshabilitado hasta confirmar", async () => {
        await openPartial();

        const warnings = inPanel().getByRole("list", { name: "Advertencias del offset" });
        expect(warnings).toHaveTextContent("1 objeto colapsa con este offset (máximo interior ≈ 5 mm): desaparece y no se modifica.");
        expect(screen.getAllByTestId("offset-collapsed")).toHaveLength(1);
        expect(confirmBox()).not.toBeNull();
        expect(confirmBox()).not.toBeChecked();
        expect(applyButton()).toBeDisabled();
        expect(applyButton().getAttribute("title")).toMatch(/confirmá que se aplica solo a los demás/);
      });

      it("sin confirmar NO se aplica: ni con Apply, ni con Enter; el documento y la pila de undo no cambian", async () => {
        await openPartial();
        const before = pathData();

        fireEvent.click(applyButton());
        press("Enter");
        await new Promise((resolve) => setTimeout(resolve, 150));

        expect(pathData()).toEqual(before);
        expect(undoButton()).toBeDisabled();
        expect(panelOpen()).toBe(true);
        // Enter con Apply bloqueado es un no-op silencioso: ni siquiera intenta aplicar (no hay un mensaje de "intento fallido").
        expect(inPanel().queryByText(/No se modificó nada/)).not.toBeInTheDocument();
      });

      it("confirmada la casilla, se aplica SOLO a los demás y el que colapsa queda intacto, aun con «Reemplazar»", async () => {
        await openPartial();
        fireEvent.click(inPanel().getByRole("checkbox", { name: "Conservar original" })); // Reemplazar
        fireEvent.click(confirmBox()!);
        expect(applyButton()).toBeEnabled();
        fireEvent.click(applyButton());

        await waitFor(() => expect(panelOpen()).toBe(false));
        expect(pathData()).toContain("M20 20 L60 20 L60 60 L20 60 Z"); // r1 (0..80) encogido 20 u por lado
        expect(pathData()).not.toContain(BIG_R1);
        expect(pathData()).toContain(SMALL_R2); // el chico colapsó: ni se reemplazó ni se borró
        expect(screen.getByText(/1 objeto colapsó y no se modificó\./)).toBeInTheDocument();
        fireEvent.click(undoButton());
        expect(pathData()).toContain(BIG_R1);
        expect(pathData()).toContain(SMALL_R2);
        expect(undoButton()).toBeDisabled();
      });

      it("cambiar el valor después de confirmar DESCARTA la confirmación: hay que volver a confirmar", async () => {
        const { fetchMock } = await openPartial();
        fireEvent.click(confirmBox()!);
        expect(applyButton()).toBeEnabled();

        fireEvent.change(distanceField(), { target: { value: "11" } });
        fireEvent.keyDown(distanceField(), { key: "Enter" });
        await waitFor(() => expect(offsetCalls(fetchMock)).toHaveLength(3));
        await waitFor(() => expect(stateText()).toMatch(/Resultado: 1 pieza a partir de 1 objeto/));

        expect(confirmBox()).not.toBeNull();
        expect(confirmBox()).not.toBeChecked();
        expect(applyButton()).toBeDisabled();
      });

      it("volver al valor anterior tampoco recupera la confirmación", async () => {
        const { fetchMock } = await openPartial();
        fireEvent.click(confirmBox()!);

        fireEvent.change(distanceField(), { target: { value: "11" } });
        fireEvent.keyDown(distanceField(), { key: "Enter" });
        await waitFor(() => expect(offsetCalls(fetchMock)).toHaveLength(3));
        fireEvent.change(distanceField(), { target: { value: "10" } });
        fireEvent.keyDown(distanceField(), { key: "Enter" });
        await waitFor(() => expect(offsetCalls(fetchMock)).toHaveLength(4));
        await waitFor(() => expect(stateText()).toMatch(/Resultado: 1 pieza a partir de 1 objeto/));

        expect(confirmBox()).not.toBeChecked();
        expect(applyButton()).toBeDisabled();
      });

      it("cambiar de selección o de «conservar original» también descarta la confirmación", async () => {
        await openPartial();
        fireEvent.click(confirmBox()!);
        expect(confirmBox()).toBeChecked();

        fireEvent.click(inPanel().getByRole("checkbox", { name: "Conservar original" }));

        expect(confirmBox()).not.toBeChecked();
        expect(applyButton()).toBeDisabled();
      });
    });
  });

  describe("preview con debounce y cancelación", () => {
    it("varios cambios seguidos piden UNA vez con el último valor (debounce) y cada cambio aborta lo que estaba en vuelo", async () => {
      const releases: Array<() => void> = [];
      const fetchMock = installWorkspaceFetch({
        offset: (body) =>
          new Promise<Response>((resolve) => {
            releases.push(() => resolve(fakeOffset(body)));
          }),
      });
      const { canvas } = await renderWorkspace();
      selectObjects(canvas, R1_AT);
      startOffset();
      await waitFor(() => expect(offsetCalls(fetchMock)).toHaveLength(1));

      fireEvent.click(inPanel().getByRole("button", { name: "2 mm" }));
      fireEvent.click(inPanel().getByRole("button", { name: "5 mm" }));
      fireEvent.click(inPanel().getByRole("button", { name: "0,5 mm" }));

      expect(offsetSignals(fetchMock)[0]?.aborted).toBe(true); // la primera se abortó al primer cambio
      await waitFor(() => expect(offsetCalls(fetchMock)).toHaveLength(2));
      expect(offsetCalls(fetchMock)[1].distance).toBeCloseTo(1, 12); // 0,5 mm = 1 u: solo la última salió
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(offsetCalls(fetchMock)).toHaveLength(2);
      releases[1]();
      await waitFor(() => expect(inPanel().getByRole("status")).toHaveTextContent(/Resultado: 1 pieza/));
    });

    it("una respuesta tardía de una petición abortada jamás se muestra", async () => {
      const releases: Array<() => void> = [];
      const fetchMock = installWorkspaceFetch({
        offset: (body) =>
          new Promise<Response>((resolve) => {
            releases.push(() => resolve(fakeOffset(body)));
          }),
      });
      const { canvas } = await renderWorkspace();
      selectObjects(canvas, R1_AT);
      startOffset();
      await waitFor(() => expect(offsetCalls(fetchMock)).toHaveLength(1));

      fireEvent.click(inPanel().getByRole("button", { name: "5 mm" }));
      releases[0](); // llega la primera, ya abortada
      await waitFor(() => expect(offsetCalls(fetchMock)).toHaveLength(2));

      expect(screen.queryByTestId("offset-preview")?.querySelectorAll("path") ?? []).toHaveLength(0);
      expect(stateText()).not.toMatch(/Resultado/);
      releases[1]();
      await waitFor(() => expect(screen.getByTestId("offset-preview").querySelectorAll("path")).toHaveLength(1));
      expect(screen.getByTestId("offset-preview").querySelector("path")!.getAttribute("d")).toBe("M-10 -10 L50 -10 L50 50 L-10 50 Z"); // 5 mm = 10 u
    });

    it("StrictMode: UNA sola llamada al servidor al abrir", async () => {
      const fetchMock = installWorkspaceFetch({ offset: fakeOffset });
      const { canvas } = await renderWorkspace({ strict: true });
      selectObjects(canvas, R1_AT);

      startOffset();
      await waitFor(() => expect(inPanel().getByRole("status")).toHaveTextContent(/Resultado: 1 pieza/));
      await new Promise((resolve) => setTimeout(resolve, 400));

      expect(offsetCalls(fetchMock)).toHaveLength(1);
      expect(offsetSignals(fetchMock)[0]?.aborted).toBe(false);
    });

    it("Apply mientras todavía se calcula espera la respuesta y recién ahí aplica (una sola llamada)", async () => {
      let release: () => void = () => {};
      const fetchMock = installWorkspaceFetch({
        offset: (body) =>
          new Promise<Response>((resolve) => {
            release = () => resolve(fakeOffset(body));
          }),
      });
      const { canvas } = await renderWorkspace();
      selectObjects(canvas, R1_AT);
      startOffset();
      await waitFor(() => expect(offsetCalls(fetchMock)).toHaveLength(1));

      expect(applyButton()).toBeDisabled(); // sin resultado todavía no se puede decidir (colapso / confirmación)
      expect(applyButton().getAttribute("title")).toMatch(/Esperando el resultado del servidor/);
      release();
      await waitFor(() => expect(applyButton()).toBeEnabled());
      fireEvent.click(applyButton());

      await waitFor(() => expect(pathData()).toContain(R1_GROWN_1MM));
      expect(offsetCalls(fetchMock)).toHaveLength(1);
    });
  });

  describe("errores del servidor: nada cambia", () => {
    it("un error del servidor es recuperable: mensaje claro, Apply deshabilitado, el documento intacto; Reintentar se recupera", async () => {
      let failing = true;
      const fetchMock = installWorkspaceFetch({ offset: (body) => (failing ? jsonResponse({ code: "engine_unavailable", message: "caído" }, 503) : fakeOffset(body)) });
      const { canvas } = await renderWorkspace();
      selectObjects(canvas, R1_AT);
      const before = pathData();

      startOffset();
      await waitFor(() => expect(inPanel().getAllByRole("alert").length).toBeGreaterThan(0));

      expect(inPanel().getAllByRole("alert")[0]).toHaveTextContent(/motor de geometría no está disponible.*No se modificó nada/);
      expect(applyButton()).toBeDisabled();
      expect(pathData()).toEqual(before);
      expect(undoButton()).toBeDisabled();
      expect(screen.queryByTestId("offset-preview")?.querySelectorAll("path") ?? []).toHaveLength(0);

      failing = false;
      fireEvent.click(inPanel().getByRole("button", { name: "Reintentar" }));
      await waitFor(() => expect(inPanel().getByRole("status")).toHaveTextContent(/Resultado: 1 pieza/));
      expect(offsetCalls(fetchMock)).toHaveLength(2);
      expect(applyButton()).toBeEnabled();
    });

    it("un código propio del offset (distancia rechazada) se explica con el texto del offset", async () => {
      installWorkspaceFetch({ offset: () => jsonResponse({ code: "invalid_distance", message: "cero" }, 400) });
      const { canvas } = await renderWorkspace();
      selectObjects(canvas, R1_AT);

      startOffset();

      await waitFor(() => expect(inPanel().getAllByRole("alert")[0]).toHaveTextContent(/rechazó la distancia del offset/));
    });

    it("una respuesta incoherente del servidor (otra distancia) NO se aplica ni se muestra como válida", async () => {
      installWorkspaceFetch({
        offset: (body) => {
          const response = fakeOffset(body);
          return response.json().then((payload: Record<string, unknown>) => jsonResponse({ ...payload, distance: 99 }));
        },
      });
      const { canvas } = await renderWorkspace();
      selectObjects(canvas, R1_AT);
      const before = pathData();

      startOffset();

      await waitFor(() => expect(inPanel().getAllByRole("alert")[0]).toHaveTextContent(/respuesta incoherente/));
      expect(applyButton()).toBeDisabled();
      expect(pathData()).toEqual(before);
    });
  });
});
