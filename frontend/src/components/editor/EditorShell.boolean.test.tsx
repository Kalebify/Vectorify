import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  B1,
  GEOMETRY_DIRTY,
  geometryResponse,
  installResizeObserver,
  installWorkspaceFetch,
  jsonResponse,
  layerNames,
  pathByData,
  pathData,
  R1,
  R2,
  rectPiece,
  redoButton,
  renderWorkspace,
  tool,
  toScreen,
  undoButton,
} from "../../test/workspaceFixture";

/**
 * Integración de las booleanas (M3-S08) en el Workspace completo: Unión / Diferencia / Intersección / XOR sobre 2+ formas rellenas, con orden explícito
 * (A, B, C...), capa destino que decide el usuario, preview del servidor (debounce + AbortSignal, una petición viva), Apply/Cancel, un comando por
 * Apply, undo/redo exactos y StrictMode. Capas de la fixture: Rojo (r1 0..40², r2 0..40 x 100..140), Azul (b1 100..140²) y Líneas (ln1 abierta).
 * `fetch` respeta AbortSignal y cuenta las llamadas al servicio de geometría (`geometryCalls`); el servidor se simula (el cálculo real se prueba en
 * services/python-engine/tests).
 */

const RESULT = rectPiece(0, 0, 40, 40);
const RESULT_D = "M0 0 L40 0 L40 40 L0 40 Z";
const SECOND = rectPiece(100, 100, 120, 120);
const SECOND_D = "M100 100 L120 100 L120 120 L100 120 Z";

type GeometryHandler = NonNullable<Parameters<typeof installWorkspaceFetch>[0]>["geometry"];

/** Servidor simulado: una pieza por defecto; difference/per_subject y el resto combinado. */
const answer: NonNullable<GeometryHandler> = (body) => {
  const operation = String(body.operation);
  if (operation === "difference") return geometryResponse("difference", [{ changed: true, geometries: [RESULT] }]);
  return geometryResponse(operation, [{ changed: true, geometries: [RESULT] }], "combined");
};

const panel = () => screen.getByRole("heading", { name: /^Booleana —/ }).closest("section")!;
const inPanel = () => within(panel());
const applyButton = () => inPanel().getByRole("button", { name: "Apply" });
const cancelButton = () => inPanel().getByRole("button", { name: "Cancel" });
const bar = () => screen.getByRole("toolbar", { name: /Booleanas/ });
const op = (name: string) => within(bar()).getByRole("button", { name });
const targetSelect = () => inPanel().getByLabelText(/Los operandos están en capas distintas/) as HTMLSelectElement;
const press = (key: string) => fireEvent.keyDown(screen.getByRole("application"), { key });
const operandNames = () => within(inPanel().getByRole("list", { name: "Operandos en orden" })).getAllByRole("listitem").map((item) => item.textContent ?? "");

function click(canvas: HTMLElement, x: number, y: number, options: { shiftKey?: boolean } = {}) {
  fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, ...toScreen(x, y), ...options });
  fireEvent.pointerUp(canvas, { pointerId: 1, ...toScreen(x, y), ...options });
}

// Puntos que caen en UN solo objeto.
const R1_AT = [20, 20] as const;
const R2_AT = [20, 120] as const;
const B1_AT = [120, 120] as const;
const LN1_AT = [230, 21] as const;

function selectObjects(canvas: HTMLElement, ...points: Array<readonly [number, number]>) {
  points.forEach(([x, y], index) => click(canvas, x, y, { shiftKey: index > 0 }));
}

type FetchMock = ReturnType<typeof installWorkspaceFetch>;
const geometryCalls = (fetchMock: FetchMock) => fetchMock.geometryCalls;
const geometrySignals = (fetchMock: FetchMock) => fetchMock.urls.flatMap((url, index) => (url.endsWith("/api/v2/geometry/boolean") ? [fetchMock.signals[index]] : []));
const subjectStart = (body: Record<string, unknown>, index = 0) => ((body.subjects as Array<{ coordinates: number[][][] }>)[index].coordinates[0][0]);
const operandStart = (body: Record<string, unknown>, index = 0) => ((body.operands as Array<{ coordinates: number[][][] }>)[index].coordinates[0][0]);

async function openUnion(canvas: HTMLElement, fetchMock: FetchMock, points: Array<readonly [number, number]> = [R1_AT, R2_AT]) {
  selectObjects(canvas, ...points);
  fireEvent.click(op("Unión"));
  await waitFor(() => expect(geometryCalls(fetchMock)).toHaveLength(1));
  await waitFor(() => expect(inPanel().getByRole("status")).toHaveTextContent(/Resultado: 1 pieza\./));
}

describe("EditorShell — Booleanas (M3-S08)", () => {
  beforeEach(() => installResizeObserver());
  afterEach(() => vi.unstubAllGlobals());

  describe("acceso: acciones habilitadas según la selección", () => {
    it("sin selección o con 1 objeto los botones están deshabilitados y dicen por qué; con 2 formas rellenas se habilitan", async () => {
      installWorkspaceFetch({ geometry: answer });
      const { canvas } = await renderWorkspace();

      for (const name of ["Unión", "Diferencia", "Intersección", "XOR (exclusión)"]) {
        expect(op(name)).toBeDisabled();
        expect(op(name)).toHaveAttribute("title", expect.stringContaining("al menos 2 formas rellenas"));
      }
      selectObjects(canvas, R1_AT);
      expect(op("Unión")).toBeDisabled();
      selectObjects(canvas, R1_AT, R2_AT);
      for (const name of ["Unión", "Diferencia", "Intersección", "XOR (exclusión)"]) expect(op(name)).toBeEnabled();
    });

    it("una línea abierta en la selección: «Las booleanas operan sobre formas rellenas»", async () => {
      installWorkspaceFetch({ geometry: answer });
      const { canvas } = await renderWorkspace();

      selectObjects(canvas, R1_AT, LN1_AT);

      expect(op("Unión")).toBeDisabled();
      expect(within(bar()).getByText(/Las booleanas operan sobre formas rellenas/)).toBeInTheDocument();
    });

    it("operandos en una capa bloqueada: deshabilitado con el motivo, y no hay llamadas al servidor", async () => {
      const fetchMock = installWorkspaceFetch({ geometry: answer, lockedA: true });
      const { canvas } = await renderWorkspace();

      selectObjects(canvas, R1_AT, R2_AT);

      expect(op("Unión")).toBeDisabled();
      expect(within(bar()).getByText(/capas? bloqueadas?/)).toBeInTheDocument();
      expect(geometryCalls(fetchMock)).toHaveLength(0);
    });

    it("con un giro/reflejo pendiente de Apply las booleanas se deshabilitan con el motivo", async () => {
      const fetchMock = installWorkspaceFetch({ geometry: answer });
      const { canvas } = await renderWorkspace();
      selectObjects(canvas, R1_AT, R2_AT);
      expect(op("Unión")).toBeEnabled();

      fireEvent.click(screen.getByRole("button", { name: "Rotar 90° horario" }));

      expect(op("Unión")).toBeDisabled();
      expect(op("Unión")).toHaveAttribute("title", expect.stringContaining("giro o reflejo pendiente"));
      expect(geometryCalls(fetchMock)).toHaveLength(0);
    });

    it("solo aparece con Select y Move", async () => {
      installWorkspaceFetch({ geometry: answer });
      await renderWorkspace();
      expect(screen.getByRole("toolbar", { name: /Booleanas/ })).toBeInTheDocument();

      fireEvent.click(tool(/^Move/));
      expect(screen.getByRole("toolbar", { name: /Booleanas/ })).toBeInTheDocument();
      fireEvent.click(tool(/^Draw/));
      expect(screen.queryByRole("toolbar", { name: /Booleanas/ })).not.toBeInTheDocument();
    });
  });

  describe("misma capa: preview, Apply y un comando atómico", () => {
    it("abrir pide el resultado UNA vez, muestra operandos A/B, insignias en el canvas y el preview; no toca la pila de undo", async () => {
      const fetchMock = installWorkspaceFetch({ geometry: answer });
      const { canvas } = await renderWorkspace();

      await openUnion(canvas, fetchMock);

      const body = geometryCalls(fetchMock)[0];
      expect(body.operation).toBe("union");
      expect(body.subjects).toHaveLength(2);
      expect(body.operands).toEqual([]);
      expect(body.tolerance).toBeCloseTo(0.02, 12); // 0,01 mm a 0,5 mm por unidad
      expect(subjectStart(body, 0)).toEqual([0, 0]); // A = r1 (el de más abajo)
      expect(subjectStart(body, 1)).toEqual([0, 100]); // B = r2
      expect(operandNames()).toEqual([expect.stringContaining("Operando A: Rojo · objeto 1"), expect.stringContaining("Operando B: Rojo · objeto 2")]);
      expect(inPanel().getByText(/Todos los operandos están en «Rojo»/)).toBeInTheDocument();
      expect(screen.getByTestId("boolean-badge-A")).toBeInTheDocument();
      expect(screen.getByTestId("boolean-badge-B")).toBeInTheDocument();
      expect(screen.getByTestId("boolean-preview").querySelectorAll("path")).toHaveLength(1);
      expect(screen.getByTestId("boolean-veil-A")).toBeInTheDocument(); // los operandos se atenúan mientras hay preview
      // El preview NO cambia el documento ni llena la pila de undo.
      expect(pathData()).toContain(R1);
      expect(pathData()).toContain(R2);
      expect(undoButton()).toBeDisabled();
      expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();
    });

    it("Apply (botón) reemplaza los operandos por la pieza en UN comando: capa y color de la capa, undo exacto y redo", async () => {
      const fetchMock = installWorkspaceFetch({ geometry: answer });
      const { canvas } = await renderWorkspace();
      await openUnion(canvas, fetchMock);
      const before = pathData();

      fireEvent.click(applyButton());

      await waitFor(() => expect(pathData()).toContain(RESULT_D));
      expect(pathData()).not.toContain(R1);
      expect(pathData()).not.toContain(R2);
      expect(pathData()).toContain(B1);
      expect(pathByData(RESULT_D)!.fill()).toBe("#ff0000"); // el color de la capa Rojo
      expect(screen.queryByRole("heading", { name: /^Booleana —/ })).not.toBeInTheDocument(); // se cierra
      expect(screen.getByText(GEOMETRY_DIRTY)).toBeInTheDocument();
      expect(within(bar()).getByRole("status")).toHaveTextContent(/Unión aplicada: 2 objetos → 1 objeto en la capa «Rojo»\. 2 originales reemplazados\./);
      expect(geometryCalls(fetchMock)).toHaveLength(1); // Apply usó el resultado ya calculado

      fireEvent.click(undoButton());
      expect(pathData()).toEqual(before); // un único comando: un solo Deshacer devuelve todo, en el mismo orden
      expect(undoButton()).toBeDisabled();
      fireEvent.click(redoButton());
      expect(pathData()).toContain(RESULT_D);
      expect(pathData()).not.toContain(R1);
    });

    it("Enter aplica y Escape cancela; Cancelar no deja rastro (ni comando, ni geometría sin guardar)", async () => {
      const fetchMock = installWorkspaceFetch({ geometry: answer });
      const { canvas } = await renderWorkspace();
      await openUnion(canvas, fetchMock);
      const before = pathData();

      press("Escape");
      expect(screen.queryByRole("heading", { name: /^Booleana —/ })).not.toBeInTheDocument();
      expect(screen.getAllByText("2 objetos seleccionados.").length).toBeGreaterThan(0); // la selección se conserva
      expect(pathData()).toEqual(before);
      expect(undoButton()).toBeDisabled();
      expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();
      expect(screen.queryByTestId("boolean-overlay")).not.toBeInTheDocument();

      fireEvent.click(op("Unión"));
      await waitFor(() => expect(inPanel().getByRole("status")).toHaveTextContent(/Resultado: 1 pieza\./));
      press("Enter");
      await waitFor(() => expect(pathData()).toContain(RESULT_D));
      expect(pathData()).not.toContain(R1);
    });

    it("el botón Cancel también cierra sin rastro", async () => {
      const fetchMock = installWorkspaceFetch({ geometry: answer });
      const { canvas } = await renderWorkspace();
      await openUnion(canvas, fetchMock);
      const before = pathData();

      fireEvent.click(cancelButton());

      expect(pathData()).toEqual(before);
      expect(undoButton()).toBeDisabled();
      expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();
    });

    it("«Conservar originales»: los operandos quedan y se agrega el resultado; cambiar la casilla NO vuelve a pedir al servidor", async () => {
      const fetchMock = installWorkspaceFetch({ geometry: answer });
      const { canvas } = await renderWorkspace();
      await openUnion(canvas, fetchMock);

      fireEvent.click(inPanel().getByRole("checkbox", { name: "Conservar originales" }));
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(geometryCalls(fetchMock)).toHaveLength(1);
      fireEvent.click(applyButton());

      await waitFor(() => expect(pathData()).toContain(RESULT_D));
      expect(pathData()).toContain(R1);
      expect(pathData()).toContain(R2);
      expect(pathData()).toHaveLength(5); // 4 originales + 1 resultado
      fireEvent.click(undoButton());
      expect(pathData()).toHaveLength(4);
      expect(undoButton()).toBeDisabled();
    });

    it("varias piezas = varios objetos nuevos, todos en la capa destino; undo los quita juntos", async () => {
      const fetchMock = installWorkspaceFetch({
        geometry: (body) => geometryResponse(String(body.operation), [{ changed: true, geometries: [RESULT, SECOND] }], "combined"),
      });
      const { canvas } = await renderWorkspace();
      selectObjects(canvas, R1_AT, R2_AT);
      fireEvent.click(op("XOR (exclusión)"));
      await waitFor(() => expect(inPanel().getByRole("status")).toHaveTextContent(/Resultado: 2 piezas\./));

      fireEvent.click(applyButton());

      await waitFor(() => expect(pathData()).toContain(RESULT_D));
      expect(pathData()).toContain(SECOND_D);
      expect(geometryCalls(fetchMock)[0].operation).toBe("xor");
      expect(within(bar()).getByRole("status")).toHaveTextContent(/2 objetos → 2 objetos/);
      fireEvent.click(undoButton());
      expect(pathData()).not.toContain(RESULT_D);
      expect(pathData()).not.toContain(SECOND_D);
      expect(undoButton()).toBeDisabled();
    });

    it("mientras la booleana está abierta el canvas no edita: no se puede mover con el teclado y no hay comandos", async () => {
      const fetchMock = installWorkspaceFetch({ geometry: answer });
      const { canvas } = await renderWorkspace();
      await openUnion(canvas, fetchMock);

      fireEvent.keyDown(canvas, { key: "ArrowRight" });
      fireEvent.keyDown(canvas, { key: "Delete" });

      expect(undoButton()).toBeDisabled();
      expect(pathData()).toContain(R1);
    });
  });

  describe("capas distintas: la capa/color del resultado es SIEMPRE una decisión del usuario", () => {
    it("el selector no tiene valor por defecto; Apply y Enter no hacen nada hasta elegir; el preview sí se calcula", async () => {
      const fetchMock = installWorkspaceFetch({ geometry: answer });
      const { canvas } = await renderWorkspace();
      selectObjects(canvas, R1_AT, B1_AT);

      fireEvent.click(op("Unión"));
      await waitFor(() => expect(inPanel().getByRole("status")).toHaveTextContent(/Resultado: 1 pieza\./));

      expect(geometryCalls(fetchMock)).toHaveLength(1);
      expect(targetSelect()).toHaveValue("");
      expect(applyButton()).toBeDisabled();
      expect(applyButton()).toHaveAttribute("title", expect.stringMatching(/elegí la capa de destino/));
      press("Enter");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(pathData()).toContain(R1);
      expect(pathData()).toContain(B1);
      expect(undoButton()).toBeDisabled();
      expect(screen.getByTestId("boolean-preview").querySelectorAll("path")).toHaveLength(1);
    });

    it("el orden por defecto de pintado no decide la capa: elegir Azul pinta de azul, elegir Rojo, de rojo", async () => {
      for (const [name, color] of [
        ["Azul (#0000ff)", "#0000ff"],
        ["Rojo (#ff0000)", "#ff0000"],
      ] as const) {
        installWorkspaceFetch({ geometry: answer });
        const { canvas, unmount } = await renderWorkspace();
        selectObjects(canvas, R1_AT, B1_AT);
        fireEvent.click(op("Unión"));
        await waitFor(() => expect(inPanel().getByRole("status")).toHaveTextContent(/Resultado: 1 pieza\./));

        fireEvent.change(targetSelect(), { target: { value: within(targetSelect()).getByRole("option", { name }).getAttribute("value") } });
        expect(inPanel().getByText(/El resultado va a «/)).toBeInTheDocument();
        expect(applyButton()).toBeEnabled();
        fireEvent.click(applyButton());

        await waitFor(() => expect(pathData()).toContain(RESULT_D));
        expect(pathByData(RESULT_D)!.fill()).toBe(color);
        expect(pathData()).not.toContain(R1);
        expect(pathData()).not.toContain(B1);
        unmount();
        vi.unstubAllGlobals();
        installResizeObserver();
      }
    });

    it("el resultado va a la capa elegida aunque no sea la de ningún operando (otra desbloqueada y visible)", async () => {
      installWorkspaceFetch({ geometry: answer });
      const { canvas } = await renderWorkspace();
      selectObjects(canvas, R1_AT, B1_AT);
      fireEvent.click(op("Intersección"));
      await waitFor(() => expect(inPanel().getByRole("status")).toHaveTextContent(/Resultado: 1 pieza\./));

      fireEvent.change(targetSelect(), { target: { value: within(targetSelect()).getByRole("option", { name: "Líneas (#00aa00)" }).getAttribute("value") } });
      fireEvent.click(applyButton());

      await waitFor(() => expect(pathData()).toContain(RESULT_D));
      expect(pathByData(RESULT_D)!.fill()).toBe("#00aa00");
    });

    it("capa nueva con un color: se crea en el MISMO comando y undo la elimina", async () => {
      installWorkspaceFetch({ geometry: answer });
      const { canvas } = await renderWorkspace();
      selectObjects(canvas, R1_AT, B1_AT);
      fireEvent.click(op("Unión"));
      await waitFor(() => expect(inPanel().getByRole("status")).toHaveTextContent(/Resultado: 1 pieza\./));

      fireEvent.change(targetSelect(), { target: { value: "__new__" } });
      expect(applyButton()).toBeDisabled(); // sin color todavía
      fireEvent.change(inPanel().getByLabelText("Color de la capa nueva (#RRGGBB)"), { target: { value: "#123456" } });
      expect(applyButton()).toBeEnabled();
      fireEvent.click(applyButton());

      await waitFor(() => expect(pathData()).toContain(RESULT_D));
      expect(pathByData(RESULT_D)!.fill()).toBe("#123456");
      expect(layerNames()).toContain("Color #123456");
      fireEvent.click(undoButton());
      expect(layerNames()).not.toContain("Color #123456");
      expect(pathData()).not.toContain(RESULT_D);
      expect(undoButton()).toBeDisabled();
    });
  });

  describe("orden de los operandos", () => {
    it("el orden por defecto es el de pintado; subir/bajar e invertir cambian la petición (A − B ≠ B − A)", async () => {
      const fetchMock = installWorkspaceFetch({ geometry: answer });
      const { canvas } = await renderWorkspace();
      selectObjects(canvas, B1_AT, R1_AT); // seleccionados al revés: manda el pintado

      fireEvent.click(op("Diferencia"));
      await waitFor(() => expect(geometryCalls(fetchMock)).toHaveLength(1));

      expect(operandNames()[0]).toContain("Operando A: Rojo · objeto 1");
      expect(operandNames()[1]).toContain("Operando B: Azul · objeto 1");
      const first = geometryCalls(fetchMock)[0];
      expect(first.operation).toBe("difference");
      expect(first.subjects).toHaveLength(1);
      expect(subjectStart(first)).toEqual([0, 0]);
      expect(operandStart(first)).toEqual([100, 100]);

      fireEvent.click(inPanel().getByRole("button", { name: "Invertir orden" }));
      await waitFor(() => expect(geometryCalls(fetchMock)).toHaveLength(2));
      const second = geometryCalls(fetchMock)[1];
      expect(subjectStart(second)).toEqual([100, 100]); // ahora la base es B
      expect(operandStart(second)).toEqual([0, 0]);
      expect(operandNames()[0]).toContain("Operando A: Azul · objeto 1");

      fireEvent.click(inPanel().getByRole("button", { name: "Bajar A (Azul · objeto 1)" }));
      await waitFor(() => expect(geometryCalls(fetchMock)).toHaveLength(3));
      expect(subjectStart(geometryCalls(fetchMock)[2])).toEqual([0, 0]);
    });

    it("la intersección pide la región común a TODOS (intersection_all) y no la unión de los demás", async () => {
      const fetchMock = installWorkspaceFetch({ geometry: answer });
      const { canvas } = await renderWorkspace();
      selectObjects(canvas, R1_AT, R2_AT, B1_AT);

      fireEvent.click(op("Intersección"));
      await waitFor(() => expect(geometryCalls(fetchMock)).toHaveLength(1));

      const body = geometryCalls(fetchMock)[0];
      expect(body.operation).toBe("intersection_all");
      expect(body.subjects).toHaveLength(3);
      expect(body.operands).toEqual([]);
    });

    it("cambiar de operación desde la barra conserva los operandos y su orden, y pide la nueva", async () => {
      const fetchMock = installWorkspaceFetch({ geometry: answer });
      const { canvas } = await renderWorkspace();
      await openUnion(canvas, fetchMock);
      fireEvent.click(inPanel().getByRole("button", { name: "Invertir orden" }));
      await waitFor(() => expect(geometryCalls(fetchMock)).toHaveLength(2));

      fireEvent.click(op("XOR (exclusión)"));
      await waitFor(() => expect(geometryCalls(fetchMock)).toHaveLength(3));

      const body = geometryCalls(fetchMock)[2];
      expect(body.operation).toBe("xor");
      expect(subjectStart(body, 0)).toEqual([0, 100]); // sigue invertido: A = r2
      expect(screen.getByRole("heading", { name: "Booleana — XOR (exclusión)" })).toBeInTheDocument();
    });
  });

  describe("preview: debounce, abort y una petición viva", () => {
    it("varios cambios seguidos => UNA petición; la anterior en vuelo se aborta y nunca hay dos vivas", async () => {
      const releases: Array<(response: Response) => void> = [];
      const fetchMock = installWorkspaceFetch({ geometry: () => new Promise<Response>((resolve) => releases.push(resolve)) });
      const { canvas } = await renderWorkspace();
      selectObjects(canvas, R1_AT, R2_AT, B1_AT);
      fireEvent.click(op("Unión"));
      await waitFor(() => expect(geometryCalls(fetchMock)).toHaveLength(1));
      expect(inPanel().getByRole("status")).toHaveTextContent("Calculando en el servidor…");

      // Tres cambios seguidos mientras la primera sigue en vuelo.
      fireEvent.click(inPanel().getByRole("button", { name: /^Bajar A/ }));
      fireEvent.click(inPanel().getByRole("button", { name: /^Bajar B/ }));
      fireEvent.click(inPanel().getByRole("button", { name: "Invertir orden" }));
      expect(geometrySignals(fetchMock)[0]?.aborted).toBe(true); // la primera se abortó YA, sin esperar al debounce

      await waitFor(() => expect(geometryCalls(fetchMock)).toHaveLength(2));
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(geometryCalls(fetchMock)).toHaveLength(2); // los 3 cambios se fundieron en UNA petición
      const alive = geometrySignals(fetchMock).filter((signal) => !signal?.aborted);
      expect(alive).toHaveLength(1);

      await vi.waitFor(() => expect(releases).toHaveLength(2));
      releases[1](geometryResponse("union", [{ changed: true, geometries: [RESULT] }], "combined"));
      await waitFor(() => expect(inPanel().getByRole("status")).toHaveTextContent(/Resultado: 1 pieza\./));
    });

    it("Apply con un preview VIEJO recalcula primero (sin esperar el debounce) y aplica el resultado de la petición actual", async () => {
      const fetchMock = installWorkspaceFetch({
        geometry: (body) => {
          const first = ((body.subjects as Array<{ coordinates: number[][][] }>)[0].coordinates[0][0]) as number[];
          // Si A es r1 devuelve el cuadrado de 40; si el orden está invertido (A = r2) devuelve otra pieza.
          return geometryResponse(String(body.operation), [{ changed: true, geometries: [first[1] === 0 ? RESULT : SECOND] }], "combined");
        },
      });
      const { canvas } = await renderWorkspace();
      await openUnion(canvas, fetchMock);

      fireEvent.click(inPanel().getByRole("button", { name: "Invertir orden" }));
      fireEvent.click(applyButton()); // sin esperar: el preview que se ve es el viejo

      await waitFor(() => expect(pathData()).toContain(SECOND_D));
      expect(pathData()).not.toContain(RESULT_D); // se aplicó el resultado NUEVO, no el viejo
      expect(geometryCalls(fetchMock)).toHaveLength(2);
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(geometryCalls(fetchMock)).toHaveLength(2); // el debounce pendiente no pidió una tercera
      fireEvent.click(undoButton());
      expect(undoButton()).toBeDisabled(); // un comando por Apply
    });

    it("StrictMode: abrir la booleana pide el resultado UNA sola vez y no queda abortado", async () => {
      const fetchMock = installWorkspaceFetch({ geometry: answer });
      const { canvas } = await renderWorkspace({ strict: true });

      await openUnion(canvas, fetchMock);
      await new Promise((resolve) => setTimeout(resolve, 400));

      expect(geometryCalls(fetchMock)).toHaveLength(1);
      expect(geometrySignals(fetchMock)[0]?.aborted).toBe(false);
      fireEvent.click(applyButton());
      await waitFor(() => expect(pathData()).toContain(RESULT_D));
      expect(geometryCalls(fetchMock)).toHaveLength(1);
    });
  });

  describe("errores: nada cambia", () => {
    it("error del servidor: mensaje recuperable, Apply deshabilitado, el documento intacto; Reintentar se recupera", async () => {
      let fail = true;
      const fetchMock = installWorkspaceFetch({ geometry: (body) => (fail ? jsonResponse({ code: "engine_unavailable", message: "caído" }, 503) : answer(body)) });
      const { canvas } = await renderWorkspace();
      selectObjects(canvas, R1_AT, R2_AT);
      const before = pathData();

      fireEvent.click(op("Unión"));

      await waitFor(() => expect(inPanel().getByRole("alert")).toHaveTextContent(/motor de geometría no está disponible.*No se modificó nada/));
      expect(applyButton()).toBeDisabled();
      press("Enter");
      expect(pathData()).toEqual(before);
      expect(undoButton()).toBeDisabled();
      expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();

      fail = false;
      fireEvent.click(inPanel().getByRole("button", { name: "Reintentar" }));
      await waitFor(() => expect(inPanel().getByRole("status")).toHaveTextContent(/Resultado: 1 pieza\./));
      expect(applyButton()).toBeEnabled();
      expect(geometryCalls(fetchMock)).toHaveLength(2);
    });

    it("una respuesta incoherente del servidor se rechaza y no se crea geometría", async () => {
      installWorkspaceFetch({
        geometry: () => geometryResponse("union", [{ changed: true, geometries: [{ type: "polygon", coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10]]] }] }], "combined"), // anillo abierto
      });
      const { canvas } = await renderWorkspace();
      const before = pathData();
      selectObjects(canvas, R1_AT, R2_AT);

      fireEvent.click(op("Unión"));

      await waitFor(() => expect(inPanel().getByRole("alert")).toHaveTextContent(/respuesta incoherente.*No se modificó nada/));
      expect(applyButton()).toBeDisabled();
      expect(pathData()).toEqual(before);
    });

    it("resultado VACÍO: se explica, Apply queda deshabilitado y no cambia nada", async () => {
      installWorkspaceFetch({ geometry: (body) => geometryResponse(String(body.operation), [{ changed: true, geometries: [] }], "combined") });
      const { canvas } = await renderWorkspace();
      const before = pathData();
      selectObjects(canvas, R1_AT, B1_AT);

      fireEvent.click(op("Intersección"));

      await waitFor(() => expect(inPanel().getByRole("status")).toHaveTextContent(/El resultado está vacío/));
      expect(applyButton()).toBeDisabled();
      press("Enter");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(pathData()).toEqual(before);
      expect(undoButton()).toBeDisabled();
      expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();
    });

    it("`changed: false` en una diferencia: A conserva su d original (sin aplanar) y B desaparece", async () => {
      installWorkspaceFetch({ geometry: () => geometryResponse("difference", [{ changed: false, geometries: [rectPiece(0, 0, 1, 1)] }]) });
      const { canvas } = await renderWorkspace();
      selectObjects(canvas, R1_AT, R2_AT);
      fireEvent.click(op("Diferencia"));
      await waitFor(() => expect(inPanel().getByRole("status")).toHaveTextContent(/A se conserva intacto/));

      fireEvent.click(applyButton());

      await waitFor(() => expect(pathData()).not.toContain(R2));
      expect(pathData()).toContain(R1); // el mismo `d` (la curva/segmentos originales), no un polígono recalculado
      expect(pathData()).toHaveLength(3);
      fireEvent.click(undoButton());
      expect(pathData()).toContain(R2);
    });
  });

  describe("cancelar sin rastro", () => {
    it("cambiar de herramienta con la booleana abierta la cancela, aborta lo que esté en vuelo y no deja nada en la pila", async () => {
      const fetchMock = installWorkspaceFetch({ geometry: () => new Promise<Response>(() => {}) });
      const { canvas } = await renderWorkspace();
      selectObjects(canvas, R1_AT, R2_AT);
      fireEvent.click(op("Unión"));
      await waitFor(() => expect(geometryCalls(fetchMock)).toHaveLength(1));

      fireEvent.click(tool(/^Draw/));

      expect(screen.queryByRole("heading", { name: /^Booleana —/ })).not.toBeInTheDocument();
      expect(geometrySignals(fetchMock)[0]?.aborted).toBe(true);
      expect(undoButton()).toBeDisabled();
      expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();
    });

    it("Deshacer con la booleana abierta (tras otra edición) la cierra", async () => {
      const fetchMock = installWorkspaceFetch({ geometry: answer });
      const { canvas } = await renderWorkspace();
      await openUnion(canvas, fetchMock);
      fireEvent.click(applyButton());
      await waitFor(() => expect(pathData()).toContain(RESULT_D));
      selectObjects(canvas, [20, 20], B1_AT);
      fireEvent.click(op("Unión"));
      await waitFor(() => expect(screen.getByRole("heading", { name: /^Booleana —/ })).toBeInTheDocument());

      fireEvent.click(undoButton());

      expect(screen.queryByRole("heading", { name: /^Booleana —/ })).not.toBeInTheDocument();
    });
  });

  it("tras aplicar, los objetos nuevos quedan seleccionados y Deshacer vuelve a seleccionar los operandos", async () => {
    const fetchMock = installWorkspaceFetch({ geometry: answer });
    const { canvas } = await renderWorkspace();
    await openUnion(canvas, fetchMock);

    fireEvent.click(applyButton());
    await waitFor(() => expect(pathData()).toContain(RESULT_D));
    expect(screen.getAllByText("1 objeto seleccionado.").length).toBeGreaterThan(0);

    fireEvent.click(undoButton());
    expect(screen.getAllByText("2 objetos seleccionados.").length).toBeGreaterThan(0);
    expect(op("Unión")).toBeEnabled();
  });
});
