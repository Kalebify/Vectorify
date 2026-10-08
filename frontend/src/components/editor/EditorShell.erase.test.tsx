import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  B1,
  clickAt,
  dragAlong,
  eraseSurface,
  GEOMETRY_DIRTY,
  geometryResponse,
  installResizeObserver,
  installWorkspaceFetch,
  jsonResponse,
  LN1,
  pathData,
  R1,
  R2,
  rectPiece,
  redoButton,
  renderWorkspace,
  selectLayerRow,
  tool,
  undoButton,
} from "../../test/workspaceFixture";

/**
 * Integración de Erase (M3-S04) en el Workspace completo. Dos modos EXPLÍCITOS: Objeto (elimina los objetos bajo el cursor) y Restar
 * geometría (pincel -> servidor `difference` -> UN comando). Se prueban el resultado real (piezas, huecos, ids por capa), el alcance,
 * locks/visibilidad, los estados de carga/error del servidor (que NO modifican nada), la cancelación, el documento que cambia mientras
 * se calcula, el tamaño real del pincel y undo/redo exactos. `fetch` respeta AbortSignal y cuenta las llamadas.
 */

const panel = () => screen.getByRole("heading", { name: /Erase — borrar/ }).closest("section")!;
const inPanel = () => within(panel());
const startErase = () => fireEvent.click(tool(/^Erase/));
const press = (key: string) => fireEvent.keyDown(screen.getByRole("application"), { key });
const useObjectMode = () => fireEvent.click(inPanel().getByRole("radio", { name: "Objeto" }));
const GEOMETRY_CALLS = (fetchMock: ReturnType<typeof installWorkspaceFetch>) => fetchMock.geometryCalls;
const notice = () => screen.queryAllByRole("status").map((element) => element.textContent ?? "").join(" | ");

/** Pieza de resultado: la mitad superior (y 0..16) y la inferior (y 24..40) del cuadrado r1 tras pasar un pincel de 4 u de radio por y = 20. */
const TOP = rectPiece(0, 0, 40, 16);
const BOTTOM = rectPiece(0, 24, 40, 40);
const TOP_D = "M0 0 L40 0 L40 16 L0 16 Z";
const BOTTOM_D = "M0 24 L40 24 L40 40 L0 40 Z";
const ACROSS_R1: Array<[number, number]> = [
  [-10, 20],
  [50, 20],
];

describe("EditorShell — Erase (M3-S04)", () => {
  beforeEach(() => installResizeObserver());
  afterEach(() => vi.unstubAllGlobals());

  describe("modos explícitos", () => {
    it("el selector muestra los dos modos y el activo siempre está indicado; el radio y el alcance solo existen al restar geometría", async () => {
      installWorkspaceFetch();
      await renderWorkspace();
      startErase();

      expect(inPanel().getByRole("radio", { name: "Restar geometría" })).toBeChecked();
      expect(inPanel().getByText("Restar geometría", { selector: "strong" })).toBeInTheDocument();
      expect(screen.getByLabelText("Radio del pincel (mm)")).toHaveValue("2");
      expect(inPanel().getByRole("radio", { name: /Solo capa activa/ })).toBeChecked();

      useObjectMode();
      expect(inPanel().getByRole("radio", { name: "Objeto" })).toBeChecked();
      expect(inPanel().getByText("Objeto", { selector: "strong" })).toBeInTheDocument();
      expect(screen.queryByLabelText("Radio del pincel (mm)")).not.toBeInTheDocument();
      expect(inPanel().queryByRole("radio", { name: /Solo capa activa/ })).not.toBeInTheDocument();
    });
  });

  describe("modo Objeto", () => {
    it("click elimina el objeto bajo el cursor en UN comando; undo lo devuelve exacto y redo lo vuelve a quitar", async () => {
      installWorkspaceFetch();
      await renderWorkspace();
      startErase();
      useObjectMode();
      const before = pathData();

      clickAt(eraseSurface(), 20, 20);

      expect(pathData()).not.toContain(R1);
      expect(pathData()).toHaveLength(before.length - 1);
      expect(screen.getByText(GEOMETRY_DIRTY)).toBeInTheDocument();
      fireEvent.click(undoButton());
      expect(pathData()).toEqual(before);
      expect(undoButton()).toBeDisabled();
      fireEvent.click(redoButton());
      expect(pathData()).not.toContain(R1);
    });

    it("un arrastre que cruza varios objetos de varias capas los elimina a TODOS en un solo comando", async () => {
      installWorkspaceFetch();
      await renderWorkspace();
      startErase();
      useObjectMode();
      const before = pathData();

      dragAlong(eraseSurface(), [
        [20, 20],
        [20, 120],
        [120, 120],
      ]);

      expect(pathData()).not.toContain(R1);
      expect(pathData()).not.toContain(R2);
      expect(pathData()).not.toContain(B1);
      expect(pathData()).toContain(LN1);
      fireEvent.click(undoButton());
      expect(pathData()).toEqual(before);
      expect(undoButton()).toBeDisabled(); // un único comando para todo el gesto
    });

    it("durante el arrastre resalta lo que se va a borrar y no toca el documento hasta soltar", async () => {
      installWorkspaceFetch();
      await renderWorkspace();
      startErase();
      useObjectMode();
      const surface = eraseSurface();

      fireEvent.pointerDown(surface, { pointerId: 1, button: 0, clientX: 260, clientY: 200 });
      expect(screen.getByTestId("erase-hits").querySelectorAll("path")).toHaveLength(1);
      expect(pathData()).toContain(R1);
      expect(undoButton()).toBeDisabled();
      fireEvent.pointerUp(surface, { pointerId: 1, clientX: 260, clientY: 200 });
      expect(screen.queryByTestId("erase-hits")).not.toBeInTheDocument();
    });

    it("una línea abierta fina se borra clickeando cerca de ella (tolerancia en px de pantalla)", async () => {
      installWorkspaceFetch();
      await renderWorkspace();
      startErase();
      useObjectMode();

      clickAt(eraseSurface(), 230, 22); // a 2 u de una línea de 0,5 u de ancho

      expect(pathData()).not.toContain(LN1);
    });

    it("click en el fondo vacío no hace nada: ni comando ni geometría sin guardar", async () => {
      installWorkspaceFetch();
      await renderWorkspace();
      startErase();
      useObjectMode();

      clickAt(eraseSurface(), 300, 200);

      expect(undoButton()).toBeDisabled();
      expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();
    });

    it("una capa BLOQUEADA no se borra: rechazo claro y nada cambia; mezclado con una desbloqueada borra solo esta y lo informa", async () => {
      installWorkspaceFetch({ lockedA: true });
      await renderWorkspace();
      startErase();
      useObjectMode();

      clickAt(eraseSurface(), 20, 20);
      expect(pathData()).toContain(R1);
      expect(inPanel().getByRole("alert")).toHaveTextContent(/capas bloqueadas.*No se borró nada/);
      expect(undoButton()).toBeDisabled();

      dragAlong(eraseSurface(), [
        [20, 20],
        [20, 120],
        [120, 120],
      ]);
      expect(pathData()).toContain(R1);
      expect(pathData()).toContain(R2);
      expect(pathData()).not.toContain(B1);
      expect(notice()).toMatch(/1 objeto eliminado\..*2 objetos están en capas bloqueadas y no se borró/);
    });

    it("las capas OCULTAS no se tocan", async () => {
      installWorkspaceFetch({ hiddenB: true });
      await renderWorkspace({ minPaths: 3 });
      startErase();
      useObjectMode();

      clickAt(eraseSurface(), 120, 120);

      expect(undoButton()).toBeDisabled();
    });

    it("Escape durante el gesto lo cancela sin borrar nada", async () => {
      installWorkspaceFetch();
      await renderWorkspace();
      startErase();
      useObjectMode();
      const surface = eraseSurface();

      fireEvent.pointerDown(surface, { pointerId: 1, button: 0, clientX: 260, clientY: 200 });
      press("Escape");
      fireEvent.pointerUp(surface, { pointerId: 1, clientX: 260, clientY: 200 });

      expect(pathData()).toContain(R1);
      expect(undoButton()).toBeDisabled();
    });
  });

  describe("modo Restar geometría: resultado real", () => {
    it("un objeto PARTIDO por el pincel se reemplaza por sus piezas en el mismo lugar; la petición lleva el pincel como bufferedLine con el radio en unidades de documento", async () => {
      const fetchMock = installWorkspaceFetch({ geometry: () => geometryResponse("difference", [{ changed: true, geometries: [TOP, BOTTOM] }]) });
      await renderWorkspace();
      selectLayerRow("Rojo");
      startErase();
      const before = pathData();

      dragAlong(eraseSurface(), ACROSS_R1);

      await waitFor(() => expect(pathData()).toContain(TOP_D));
      expect(pathData()).toContain(BOTTOM_D);
      expect(pathData()).not.toContain(R1);
      expect(pathData()).toContain(R2); // el otro objeto de la capa no se toca
      expect(GEOMETRY_CALLS(fetchMock)).toHaveLength(1);
      expect(GEOMETRY_CALLS(fetchMock)[0]).toEqual({
        operation: "difference",
        subjects: [{ type: "polygon", coordinates: [[[0, 0], [40, 0], [40, 40], [0, 40]]] }],
        // 2 mm / 0,5 mm por unidad = 4 u de radio; tolerancia de aplanado 0,01 mm = 0,02 u.
        operands: [{ type: "bufferedLine", points: [[-10, 20], [50, 20]], radius: 4 }],
        tolerance: 0.02,
      });
      expect(screen.getByText(GEOMETRY_DIRTY)).toBeInTheDocument();
      expect(notice()).toMatch(/1 objeto partido en 2 piezas/);

      // Undo exacto y redo exacto; un solo comando por gesto.
      fireEvent.click(undoButton());
      expect(pathData()).toEqual(before);
      expect(undoButton()).toBeDisabled();
      fireEvent.click(redoButton());
      expect(pathData()).toContain(TOP_D);
      expect(pathData()).toContain(BOTTOM_D);
    });

    it("un objeto REDUCIDO a una pieza y uno ELIMINADO por completo se aplican en el mismo comando", async () => {
      installWorkspaceFetch({ geometry: () => geometryResponse("difference", [{ changed: true, geometries: [TOP] }, { changed: true, geometries: [] }]) });
      await renderWorkspace();
      selectLayerRow("Rojo");
      startErase();
      fireEvent.click(inPanel().getByRole("radio", { name: "Todas las capas desbloqueadas" }));
      const before = pathData();

      dragAlong(eraseSurface(), [
        [20, 20],
        [120, 120],
      ]);

      await waitFor(() => expect(pathData()).toContain(TOP_D));
      expect(pathData()).not.toContain(R1);
      expect(pathData()).not.toContain(B1); // eliminado por completo
      fireEvent.click(undoButton());
      expect(pathData()).toEqual(before);
      expect(undoButton()).toBeDisabled();
    });

    it("alcance «solo capa activa» (default): el trazo que pasa por objetos de dos capas manda UN solo subject", async () => {
      const fetchMock = installWorkspaceFetch({ geometry: () => geometryResponse("difference", [{ changed: false, geometries: [TOP] }]) });
      await renderWorkspace();
      selectLayerRow("Rojo");
      startErase();

      dragAlong(eraseSurface(), [
        [20, 20],
        [120, 120],
      ]);
      await waitFor(() => expect(GEOMETRY_CALLS(fetchMock)).toHaveLength(1));
      expect((GEOMETRY_CALLS(fetchMock)[0].subjects as unknown[]).length).toBe(1);
    });

    it("con «todas las capas desbloqueadas» el trazo incluye también los de otras capas", async () => {
      const fetchMock = installWorkspaceFetch({ geometry: () => geometryResponse("difference", [{ changed: false, geometries: [TOP] }, { changed: false, geometries: [TOP] }]) });
      await renderWorkspace();
      selectLayerRow("Rojo");
      startErase();
      fireEvent.click(inPanel().getByRole("radio", { name: "Todas las capas desbloqueadas" }));

      dragAlong(eraseSurface(), [
        [20, 20],
        [120, 120],
      ]);
      await waitFor(() => expect(GEOMETRY_CALLS(fetchMock)).toHaveLength(1));
      expect((GEOMETRY_CALLS(fetchMock)[0].subjects as unknown[]).length).toBe(2);
    });

    it("una línea abierta se PARTE: las piezas conservan stroke, fill none y capa", async () => {
      const left = { type: "line", coordinates: [[200, 20], [226, 20]] };
      const right = { type: "line", coordinates: [[234, 20], [260, 20]] };
      const fetchMock = installWorkspaceFetch({ geometry: () => geometryResponse("difference", [{ changed: true, geometries: [left, right] }]) });
      await renderWorkspace();
      selectLayerRow("Líneas");
      startErase();

      dragAlong(eraseSurface(), [
        [230, 0],
        [230, 40],
      ]);

      await waitFor(() => expect(pathData()).toContain("M200 20 L226 20"));
      expect(GEOMETRY_CALLS(fetchMock)[0].subjects).toEqual([{ type: "line", coordinates: [[200, 20], [260, 20]] }]);
      expect(pathData()).toContain("M234 20 L260 20");
      expect(pathData()).not.toContain(LN1);
    });

    it("un objeto que el pincel no toca (changed: false) queda INTACTO: no hay comando", async () => {
      installWorkspaceFetch({ geometry: () => geometryResponse("difference", [{ changed: false, geometries: [TOP] }]) });
      await renderWorkspace();
      selectLayerRow("Rojo");
      startErase();
      const before = pathData();

      dragAlong(eraseSurface(), [
        [44, 20],
        [50, 20],
      ]);

      await waitFor(() => expect(notice()).toMatch(/El pincel no modificó ningún objeto/));
      expect(pathData()).toEqual(before);
      expect(undoButton()).toBeDisabled();
      expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();
    });
  });

  describe("alcance y bloqueos (sin llamar al servidor)", () => {
    it("sin capa activa: mensaje claro y NINGUNA petición", async () => {
      const fetchMock = installWorkspaceFetch({ geometry: () => geometryResponse("difference", []) });
      await renderWorkspace();
      startErase();

      dragAlong(eraseSurface(), ACROSS_R1);

      expect(await inPanel().findByRole("alert")).toHaveTextContent(/No hay una capa activa/);
      expect(GEOMETRY_CALLS(fetchMock)).toHaveLength(0);
      expect(undoButton()).toBeDisabled();
    });

    it("capa activa bloqueada u oculta: rechazo claro con el nombre de la capa y sin petición", async () => {
      const fetchMock = installWorkspaceFetch({ lockedA: true, hiddenB: true });
      await renderWorkspace({ minPaths: 3 });
      startErase();

      selectLayerRow("Rojo");
      dragAlong(eraseSurface(), ACROSS_R1);
      expect(await inPanel().findByRole("alert")).toHaveTextContent(/«Rojo» está bloqueada/);

      selectLayerRow("Azul");
      dragAlong(eraseSurface(), [
        [90, 120],
        [150, 120],
      ]);
      await waitFor(() => expect(inPanel().getByRole("alert")).toHaveTextContent(/«Azul» está oculta/));
      expect(GEOMETRY_CALLS(fetchMock)).toHaveLength(0);
      expect(undoButton()).toBeDisabled();
    });

    it("«todas las capas desbloqueadas» con el único objeto bajo el trazo en una capa bloqueada: no borra, informa y no llama al servidor", async () => {
      const fetchMock = installWorkspaceFetch({ lockedA: true });
      await renderWorkspace();
      selectLayerRow("Azul");
      startErase();
      fireEvent.click(inPanel().getByRole("radio", { name: "Todas las capas desbloqueadas" }));

      dragAlong(eraseSurface(), ACROSS_R1);

      await waitFor(() => expect(notice()).toMatch(/no tocó ningún objeto de las capas desbloqueadas.*1 objeto está en capas bloqueadas/));
      expect(GEOMETRY_CALLS(fetchMock)).toHaveLength(0);
      expect(pathData()).toContain(R1);
    });

    it("un trazo que no toca nada lo dice y no llama al servidor", async () => {
      const fetchMock = installWorkspaceFetch();
      await renderWorkspace();
      selectLayerRow("Rojo");
      startErase();

      dragAlong(eraseSurface(), [
        [200, 200],
        [260, 200],
      ]);

      await waitFor(() => expect(notice()).toMatch(/no tocó ningún objeto de la capa activa/));
      expect(GEOMETRY_CALLS(fetchMock)).toHaveLength(0);
    });
  });

  describe("servidor: carga, error y cancelación (nunca modifican nada)", () => {
    async function setupPending() {
      let resolve: (response: Response) => void = () => {};
      const fetchMock = installWorkspaceFetch({ geometry: () => new Promise<Response>((done) => (resolve = done)) });
      await renderWorkspace();
      selectLayerRow("Rojo");
      startErase();
      return { fetchMock, resolve: (response: Response) => resolve(response) };
    }

    it("mientras calcula muestra «Calculando…», el documento NO cambia y no acepta otro gesto; al llegar la respuesta se aplica", async () => {
      const { fetchMock, resolve } = await setupPending();
      const before = pathData();

      dragAlong(eraseSurface(), ACROSS_R1);

      expect(await inPanel().findByText("Calculando en el servidor…")).toBeInTheDocument();
      expect(pathData()).toEqual(before);
      expect(undoButton()).toBeDisabled();
      // Otro gesto durante el cálculo se ignora.
      dragAlong(eraseSurface(), ACROSS_R1);
      expect(GEOMETRY_CALLS(fetchMock)).toHaveLength(1);

      resolve(geometryResponse("difference", [{ changed: true, geometries: [TOP, BOTTOM] }]));
      await waitFor(() => expect(pathData()).toContain(TOP_D));
      expect(screen.queryByText("Calculando en el servidor…")).not.toBeInTheDocument();
    });

    it("Escape aborta el fetch (AbortSignal): no se modifica nada y se informa", async () => {
      const { fetchMock } = await setupPending();
      const before = pathData();

      dragAlong(eraseSurface(), ACROSS_R1);
      await inPanel().findByText("Calculando en el servidor…");
      press("Escape");

      await waitFor(() => expect(screen.queryByText("Calculando en el servidor…")).not.toBeInTheDocument());
      const index = fetchMock.urls.findIndex((url) => url.endsWith("/api/v2/geometry/boolean"));
      expect(fetchMock.signals[index]?.aborted).toBe(true);
      expect(notice()).toMatch(/Cálculo cancelado.*No se modificó nada/);
      expect(pathData()).toEqual(before);
      expect(undoButton()).toBeDisabled();
    });

    it("cambiar de herramienta mientras calcula también aborta y nunca aplica el resultado tardío", async () => {
      const { fetchMock, resolve } = await setupPending();
      const before = pathData();

      dragAlong(eraseSurface(), ACROSS_R1);
      await inPanel().findByText("Calculando en el servidor…");
      fireEvent.click(tool(/^Select/));
      resolve(geometryResponse("difference", [{ changed: true, geometries: [TOP, BOTTOM] }]));

      await waitFor(() => {
        const index = fetchMock.urls.findIndex((url) => url.endsWith("/api/v2/geometry/boolean"));
        expect(fetchMock.signals[index]?.aborted).toBe(true);
      });
      expect(pathData()).toEqual(before);
      expect(undoButton()).toBeDisabled();
    });

    it.each([
      [jsonResponse({ code: "engine_unavailable", message: "caído" }, 503), /motor de geometría no está disponible.*No se modificó nada/],
      [jsonResponse({ code: "timeout", message: "lento" }, 504), /tardó demasiado.*No se modificó nada/],
      [jsonResponse({ code: "too_many_subjects", message: "muchos" }, 400), /demasiados objetos/],
      [jsonResponse({ code: "processing_error", message: "boom" }, 500), /no pudo completar el cálculo/],
    ])("un error del servidor (%#) es recuperable: mensaje claro, el documento queda IGUAL y se puede reintentar", async (failure, message) => {
      let calls = 0;
      installWorkspaceFetch({
        geometry: () => {
          calls += 1;
          return calls === 1 ? failure : geometryResponse("difference", [{ changed: true, geometries: [TOP, BOTTOM] }]);
        },
      });
      await renderWorkspace();
      selectLayerRow("Rojo");
      startErase();
      const before = pathData();

      dragAlong(eraseSurface(), ACROSS_R1);
      await waitFor(() => expect(inPanel().getByRole("alert")).toHaveTextContent(message));
      expect(pathData()).toEqual(before);
      expect(undoButton()).toBeDisabled();
      expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();

      dragAlong(eraseSurface(), ACROSS_R1);
      await waitFor(() => expect(pathData()).toContain(TOP_D));
      expect(inPanel().queryByRole("alert")).not.toBeInTheDocument();
    });

    it("un fallo de red (fetch rechaza) tampoco modifica nada", async () => {
      installWorkspaceFetch({ geometry: () => Promise.reject(new TypeError("Failed to fetch")) });
      await renderWorkspace();
      selectLayerRow("Rojo");
      startErase();
      const before = pathData();

      dragAlong(eraseSurface(), ACROSS_R1);

      await waitFor(() => expect(inPanel().getByRole("alert")).toHaveTextContent(/No se pudo contactar con el servidor.*No se modificó nada/));
      expect(pathData()).toEqual(before);
      expect(undoButton()).toBeDisabled();
    });

    it("una respuesta incoherente (tipo de pieza equivocado, NaN, resultados de menos) se rechaza entera: nada cambia", async () => {
      const bad = [
        geometryResponse("difference", [{ changed: true, geometries: [{ type: "line", coordinates: [[0, 0], [1, 1]] }] }]),
        geometryResponse("difference", [{ changed: true, geometries: [{ type: "polygon", coordinates: [[[0, 0], [40, 0], [40, null], [0, 0]]] }] }]),
        geometryResponse("difference", []),
      ];
      let call = 0;
      const fetchMock = installWorkspaceFetch({ geometry: () => bad[call++] });
      await renderWorkspace();
      selectLayerRow("Rojo");
      startErase();
      const before = pathData();

      for (let attempt = 0; attempt < bad.length; attempt += 1) {
        dragAlong(eraseSurface(), ACROSS_R1);
        await waitFor(() => expect(inPanel().getByRole("alert")).toHaveTextContent(/incoherente.*No se modificó nada/));
        await waitFor(() => expect(screen.queryByText("Calculando en el servidor…")).not.toBeInTheDocument());
        expect(pathData()).toEqual(before);
      }
      expect(GEOMETRY_CALLS(fetchMock)).toHaveLength(3);
      expect(undoButton()).toBeDisabled();
    });

    it("si el documento CAMBIÓ mientras se calculaba (se deshizo el borrado anterior) el resultado viejo NO se aplica", async () => {
      let resolveSecond: (response: Response) => void = () => {};
      let call = 0;
      installWorkspaceFetch({
        geometry: () => {
          call += 1;
          return call === 1 ? geometryResponse("difference", [{ changed: true, geometries: [TOP] }]) : new Promise<Response>((done) => (resolveSecond = done));
        },
      });
      await renderWorkspace();
      selectLayerRow("Rojo");
      startErase();

      // Primer borrado: r1 se reduce a TOP (objeto nuevo en su lugar).
      dragAlong(eraseSurface(), ACROSS_R1);
      await waitFor(() => expect(pathData()).toContain(TOP_D));

      // Segundo borrado sobre lo que queda; mientras calcula, el usuario deshace el primero.
      dragAlong(eraseSurface(), [
        [-10, 8],
        [50, 8],
      ]);
      await inPanel().findByText("Calculando en el servidor…");
      fireEvent.click(undoButton());
      expect(pathData()).toContain(R1);
      resolveSecond(geometryResponse("difference", [{ changed: true, geometries: [rectPiece(0, 0, 40, 4)] }]));

      await waitFor(() => expect(inPanel().getByRole("alert")).toHaveTextContent(/El documento cambió mientras se calculaba.*No se modificó nada/));
      expect(pathData()).toContain(R1);
      expect(pathData()).not.toContain("M0 0 L40 0 L40 4 L0 4 Z");
      expect(undoButton()).toBeDisabled();
    });
  });

  describe("pincel: tamaño real y unidades", () => {
    it("el cursor mide el radio REAL del pincel (2 mm = 4 u = 4 px a zoom 1) y crece con el zoom, pero la petición manda siempre el mismo radio en unidades de documento", async () => {
      const fetchMock = installWorkspaceFetch({ geometry: () => geometryResponse("difference", [{ changed: false, geometries: [TOP] }]) });
      await renderWorkspace();
      selectLayerRow("Rojo");
      startErase();
      const surface = eraseSurface();

      fireEvent.pointerMove(surface, { pointerId: 1, clientX: 400, clientY: 300 });
      expect(screen.getByTestId("erase-cursor").getAttribute("r")).toBe("4");

      fireEvent.keyDown(screen.getByRole("application"), { key: "+" }); // zoom x1,25
      fireEvent.pointerMove(surface, { pointerId: 1, clientX: 401, clientY: 300 });
      expect(Number(screen.getByTestId("erase-cursor").getAttribute("r"))).toBeCloseTo(5, 9);

      // Mismo trazo en documento (-10,20) -> (50,20), ahora con zoom 1,25: pantalla = 400 + (doc - 160) * 1,25.
      const screenX = (x: number) => 400 + (x - 160) * 1.25;
      const screenY = (y: number) => 300 + (y - 120) * 1.25;
      fireEvent.pointerDown(surface, { pointerId: 2, button: 0, clientX: screenX(-10), clientY: screenY(20) });
      fireEvent.pointerMove(surface, { pointerId: 2, clientX: screenX(20), clientY: screenY(20) });
      fireEvent.pointerUp(surface, { pointerId: 2, clientX: screenX(50), clientY: screenY(20) });

      await waitFor(() => expect(GEOMETRY_CALLS(fetchMock)).toHaveLength(1));
      const operand = (GEOMETRY_CALLS(fetchMock)[0].operands as Array<{ radius: number }>)[0];
      expect(operand.radius).toBe(4);
    });

    it("cambiar el radio (mm) cambia el radio de la petición: 5 mm = 10 u", async () => {
      const fetchMock = installWorkspaceFetch({ geometry: () => geometryResponse("difference", [{ changed: false, geometries: [TOP] }]) });
      await renderWorkspace();
      selectLayerRow("Rojo");
      startErase();
      const radius = screen.getByLabelText("Radio del pincel (mm)") as HTMLInputElement;
      fireEvent.change(radius, { target: { value: "5" } });
      fireEvent.keyDown(radius, { key: "Enter" });

      dragAlong(eraseSurface(), ACROSS_R1);

      await waitFor(() => expect(GEOMETRY_CALLS(fetchMock)).toHaveLength(1));
      expect((GEOMETRY_CALLS(fetchMock)[0].operands as Array<{ radius: number }>)[0].radius).toBe(10);
    });

    it("durante el arrastre solo se previsualiza la HUELLA del pincel (ancho 2 x radio); el resultado real llega después", async () => {
      installWorkspaceFetch({ geometry: () => new Promise<Response>(() => {}) });
      await renderWorkspace();
      selectLayerRow("Rojo");
      startErase();
      const surface = eraseSurface();

      fireEvent.pointerDown(surface, { pointerId: 1, button: 0, clientX: 230, clientY: 200 });
      fireEvent.pointerMove(surface, { pointerId: 1, clientX: 290, clientY: 200 });

      const footprint = screen.getByTestId("erase-footprint");
      expect(footprint.getAttribute("stroke-width")).toBe("8");
      expect(pathData()).toContain(R1);
      expect(undoButton()).toBeDisabled();
      fireEvent.pointerUp(surface, { pointerId: 1, clientX: 290, clientY: 200 });
    });
  });

  describe("StrictMode", () => {
    it("partir un objeto con el doble efecto de StrictMode: una sola petición, resultado correcto y undo exacto", async () => {
      const fetchMock = installWorkspaceFetch({ geometry: () => geometryResponse("difference", [{ changed: true, geometries: [TOP, BOTTOM] }]) });
      await renderWorkspace({ strict: true });
      selectLayerRow("Rojo");
      startErase();
      const before = pathData();

      dragAlong(eraseSurface(), ACROSS_R1);

      await waitFor(() => expect(pathData()).toContain(TOP_D));
      expect(GEOMETRY_CALLS(fetchMock)).toHaveLength(1);
      fireEvent.click(undoButton());
      expect(pathData()).toEqual(before);
    });
  });
});
