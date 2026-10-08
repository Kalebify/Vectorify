import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clickAt,
  dragAlong,
  drawSurface,
  GEOMETRY_DIRTY,
  geometryResponse,
  installResizeObserver,
  installWorkspaceFetch,
  jsonResponse,
  layerNames,
  layerRows,
  pathByData,
  pathData,
  redoButton,
  renderWorkspace,
  selectLayerRow,
  tool,
  undoButton,
} from "../../test/workspaceFixture";

/**
 * Integración de Draw (M3-S04) en el Workspace completo: capa activa (existente / ninguna => «Dibujo» atómica / bloqueada u oculta =>
 * rechazo), pluma y mano alzada, objetos abiertos (fill none + trazo) vs. cerrados (relleno), normalización de un cerrado que se cruza
 * con el servidor, comando único por trazo, undo/redo exactos y cancelación. `fetch` respeta AbortSignal y cuenta las llamadas.
 */

const panel = () => screen.getByRole("heading", { name: /Draw — dibujar/ }).closest("section")!;
const inPanel = () => within(panel());
const startDraw = () => fireEvent.click(tool(/^Draw/));
const press = (key: string, target: Element = screen.getByRole("application")) => fireEvent.keyDown(target, { key });

describe("EditorShell — Draw (M3-S04)", () => {
  beforeEach(() => installResizeObserver());
  afterEach(() => vi.unstubAllGlobals());

  describe("capa de destino", () => {
    it("SIN capa activa crea la capa «Dibujo» en el MISMO comando: la línea es fill none + trazo negro de 0,1 mm (0,2 u), y un solo undo deshace capa y trazo", async () => {
      installWorkspaceFetch();
      await renderWorkspace();
      startDraw();
      expect(inPanel().getByText(/No hay capa activa: al dibujar se creará la capa/)).toBeInTheDocument();

      const surface = drawSurface();
      clickAt(surface, 100, 30);
      clickAt(surface, 160, 30);
      clickAt(surface, 160, 80);
      expect(inPanel().getByText("3 puntos colocados.")).toBeInTheDocument();
      // La polilínea en curso es un borrador: no entra a la pila de undo ni ensucia el documento.
      expect(undoButton()).toBeDisabled();
      expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();

      fireEvent.click(inPanel().getByRole("button", { name: "Terminar" }));

      const created = pathByData("M100 30 L160 30 L160 80")!;
      expect(created).toBeDefined();
      expect(created.fill()).toBeUndefined();
      expect(created.stroke()).toBe("#000000");
      expect(created.strokeWidth()).toBeCloseTo(0.2, 12);
      expect(layerNames()).toEqual(["Rojo", "Azul", "Líneas", "Dibujo"]);
      expect(within(layerRows()[3]).getByText("nueva")).toBeInTheDocument();
      expect(screen.getByText(GEOMETRY_DIRTY)).toBeInTheDocument();
      // La capa «Dibujo» queda como capa activa: el panel lo dice.
      expect(inPanel().getByText("«Dibujo»")).toBeInTheDocument();

      fireEvent.click(undoButton());
      expect(pathByData("M100 30 L160 30 L160 80")).toBeUndefined();
      expect(layerNames()).toEqual(["Rojo", "Azul", "Líneas"]);
      expect(undoButton()).toBeDisabled();

      fireEvent.click(redoButton());
      expect(pathByData("M100 30 L160 30 L160 80")).toBeDefined();
      expect(layerNames()).toEqual(["Rojo", "Azul", "Líneas", "Dibujo"]);
    });

    it("con una capa activa visible y desbloqueada dibuja ahí: un cerrado es un RELLENO con el color de la capa (sin trazo) y no se crea ninguna capa", async () => {
      installWorkspaceFetch();
      await renderWorkspace();
      selectLayerRow("Rojo");
      startDraw();
      expect(inPanel().getByText("«Rojo»")).toBeInTheDocument();

      const surface = drawSurface();
      clickAt(surface, 60, 10);
      clickAt(surface, 100, 10);
      clickAt(surface, 100, 50);
      clickAt(surface, 60, 10); // click sobre el primer punto: cierra

      const created = pathByData("M60 10 L100 10 L100 50 Z")!;
      expect(created.fill()).toBe("#ff0000");
      expect(created.stroke()).toBeUndefined();
      expect(layerNames()).toEqual(["Rojo", "Azul", "Líneas"]);
      expect(undoButton()).toBeEnabled();

      fireEvent.click(undoButton());
      expect(pathByData("M60 10 L100 10 L100 50 Z")).toBeUndefined();
      expect(undoButton()).toBeDisabled(); // UN solo comando por trazo
    });

    it("el siguiente trazo va a la MISMA capa «Dibujo» (no crea otra) y cada trazo es su propio comando", async () => {
      installWorkspaceFetch();
      await renderWorkspace();
      startDraw();
      const surface = drawSurface();
      clickAt(surface, 100, 30);
      clickAt(surface, 160, 30);
      press("Enter");
      clickAt(surface, 100, 60);
      clickAt(surface, 160, 60);
      press("Enter");

      expect(layerNames().filter((name) => name === "Dibujo")).toHaveLength(1);
      expect(pathData()).toEqual(expect.arrayContaining(["M100 30 L160 30", "M100 60 L160 60"]));
      fireEvent.click(undoButton());
      expect(pathByData("M100 60 L160 60")).toBeUndefined();
      expect(pathByData("M100 30 L160 30")).toBeDefined();
      expect(layerNames()).toContain("Dibujo");
      fireEvent.click(undoButton());
      expect(layerNames()).not.toContain("Dibujo");
    });

    it("capa activa BLOQUEADA: rechazo claro con el nombre de la capa, no se crea nada ni se dibuja en otra capa", async () => {
      installWorkspaceFetch({ lockedA: true });
      await renderWorkspace();
      selectLayerRow("Rojo");
      startDraw();
      expect(inPanel().getByText("No se puede dibujar en «Rojo».")).toBeInTheDocument();

      const before = pathData();
      const surface = drawSurface();
      clickAt(surface, 100, 30);
      clickAt(surface, 160, 30);
      press("Enter");

      expect(inPanel().getAllByRole("alert").some((alert) => /La capa «Rojo» está bloqueada\. Desbloqueá la capa «Rojo» o elegí otra\./.test(alert.textContent ?? ""))).toBe(true);
      expect(pathData()).toEqual(before);
      expect(layerNames()).toEqual(["Rojo", "Azul", "Líneas"]);
      expect(undoButton()).toBeDisabled();
      expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();
    });

    it("capa activa OCULTA: rechazo claro (mostrala o elegí otra) y nada se crea", async () => {
      installWorkspaceFetch({ hiddenB: true });
      await renderWorkspace({ minPaths: 3 });
      selectLayerRow("Azul");
      startDraw();

      const surface = drawSurface();
      clickAt(surface, 100, 30);
      clickAt(surface, 160, 30);
      press("Enter");

      expect(inPanel().getAllByRole("alert").some((alert) => /La capa «Azul» está oculta\. Mostrá la capa «Azul» o elegí otra\./.test(alert.textContent ?? ""))).toBe(true);
      expect(undoButton()).toBeDisabled();
      expect(layerNames()).toEqual(["Rojo", "Azul", "Líneas"]);
    });

    it("con otra capa bloqueada pero NO activa, dibuja sin problema en la activa", async () => {
      installWorkspaceFetch({ lockedA: true });
      await renderWorkspace();
      selectLayerRow("Azul");
      startDraw();
      const surface = drawSurface();
      clickAt(surface, 100, 30);
      clickAt(surface, 160, 30);
      press("Enter");

      expect(pathByData("M100 30 L160 30")!.stroke()).toBe("#0000ff");
    });
  });

  describe("pluma (polilínea)", () => {
    it("Enter termina una línea abierta; Retroceso quita el último punto; Escape cancela el borrador sin dejar rastro", async () => {
      installWorkspaceFetch();
      await renderWorkspace();
      startDraw();
      const surface = drawSurface();

      clickAt(surface, 100, 30);
      clickAt(surface, 160, 30);
      clickAt(surface, 160, 80);
      press("Backspace");
      expect(inPanel().getByText("2 puntos colocados.")).toBeInTheDocument();
      press("Escape");
      expect(inPanel().getByText("Hacé click en el canvas para empezar la polilínea.")).toBeInTheDocument();
      expect(undoButton()).toBeDisabled();
      expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();

      clickAt(surface, 100, 30);
      clickAt(surface, 160, 30);
      press("Enter");
      expect(pathByData("M100 30 L160 30")).toBeDefined();
    });

    it("doble click termina la línea abierta aunque el segundo click repita el punto", async () => {
      installWorkspaceFetch();
      await renderWorkspace();
      selectLayerRow("Azul");
      startDraw();
      const surface = drawSurface();

      clickAt(surface, 100, 200);
      clickAt(surface, 150, 200);
      clickAt(surface, 150, 200);
      fireEvent.doubleClick(surface);

      expect(pathByData("M100 200 L150 200")).toBeDefined();
      expect(undoButton()).toBeEnabled();
    });

    it("el botón Cerrar cierra la forma (relleno); con menos de 3 puntos y Terminar con menos de 2 están deshabilitados", async () => {
      installWorkspaceFetch();
      await renderWorkspace();
      selectLayerRow("Azul");
      startDraw();
      const surface = drawSurface();
      expect(inPanel().getByRole("button", { name: "Terminar" })).toBeDisabled();
      clickAt(surface, 200, 100);
      expect(inPanel().getByRole("button", { name: "Terminar" })).toBeDisabled();
      clickAt(surface, 260, 100);
      expect(inPanel().getByRole("button", { name: "Terminar" })).toBeEnabled();
      expect(inPanel().getByRole("button", { name: "Cerrar" })).toBeDisabled();
      clickAt(surface, 260, 160);
      fireEvent.click(inPanel().getByRole("button", { name: "Cerrar" }));

      const created = pathByData("M200 100 L260 100 L260 160 Z")!;
      expect(created.fill()).toBe("#0000ff");
    });

    it("un cerrado sin área (puntos alineados) se rechaza con mensaje y no crea nada; el borrador se conserva", async () => {
      installWorkspaceFetch();
      await renderWorkspace();
      selectLayerRow("Azul");
      startDraw();
      const surface = drawSurface();
      clickAt(surface, 200, 100);
      clickAt(surface, 230, 100);
      clickAt(surface, 260, 100);
      fireEvent.click(inPanel().getByRole("button", { name: "Cerrar" }));

      expect(inPanel().getByRole("alert")).toHaveTextContent(/no encierra área.*No se creó nada/);
      expect(undoButton()).toBeDisabled();
      expect(inPanel().getByText("3 puntos colocados.")).toBeInTheDocument();
    });

    it("cambiar el ancho de línea (mm) cambia el trazo de las líneas siguientes: 0,5 mm = 1 u", async () => {
      installWorkspaceFetch();
      await renderWorkspace();
      selectLayerRow("Azul");
      startDraw();
      const width = screen.getByLabelText("Ancho de línea (mm)") as HTMLInputElement;
      expect(width.value).toBe("0.1");
      fireEvent.change(width, { target: { value: "0,5" } });
      fireEvent.keyDown(width, { key: "Enter" });
      expect(width.value).toBe("0.5");

      const surface = drawSurface();
      clickAt(surface, 100, 30);
      clickAt(surface, 160, 30);
      press("Enter");

      expect(pathByData("M100 30 L160 30")!.strokeWidth()).toBe(1);
    });

    it("un ancho inválido se rechaza con mensaje y conserva el anterior", async () => {
      installWorkspaceFetch();
      await renderWorkspace();
      startDraw();
      const width = screen.getByLabelText("Ancho de línea (mm)") as HTMLInputElement;
      fireEvent.change(width, { target: { value: "abc" } });
      fireEvent.keyDown(width, { key: "Enter" });
      expect(inPanel().getByRole("alert")).toHaveTextContent(/no es un número válido/);
      expect(width.value).toBe("0.1");
      fireEvent.change(width, { target: { value: "-2" } });
      fireEvent.keyDown(width, { key: "Enter" });
      expect(inPanel().getByRole("alert")).toHaveTextContent(/debe estar entre 0/);
      expect(width.value).toBe("0.1");
    });

    it("cambiar de herramienta con un borrador a medias lo descarta: al volver a Draw está vacío", async () => {
      installWorkspaceFetch();
      await renderWorkspace();
      startDraw();
      clickAt(drawSurface(), 100, 30);
      clickAt(drawSurface(), 160, 30);
      expect(inPanel().getByText("2 puntos colocados.")).toBeInTheDocument();

      fireEvent.click(tool(/^Select/));
      expect(screen.queryByTestId("draw-surface")).not.toBeInTheDocument();
      startDraw();
      expect(inPanel().getByText("Hacé click en el canvas para empezar la polilínea.")).toBeInTheDocument();
      expect(undoButton()).toBeDisabled();
    });
  });

  describe("mano alzada", () => {
    it("el trazo se simplifica con Ramer–Douglas–Peucker (0,2 mm = 0,4 u): un ruido de 0,1 u se aplana a una recta de 2 puntos, en un solo comando", async () => {
      installWorkspaceFetch();
      await renderWorkspace();
      selectLayerRow("Azul");
      startDraw();
      fireEvent.click(inPanel().getByRole("radio", { name: "Mano alzada" }));
      expect(inPanel().getByText("Mano alzada", { selector: "strong" })).toBeInTheDocument();
      expect(screen.getByLabelText("Simplificación (mm)")).toBeInTheDocument();

      dragAlong(drawSurface(), [
        [50, 160],
        [80, 160.1],
        [110, 159.9],
        [140, 160],
      ]);

      const created = pathByData("M50 160 L140 160")!;
      expect(created.fill()).toBeUndefined();
      expect(created.stroke()).toBe("#0000ff");
      fireEvent.click(undoButton());
      expect(pathByData("M50 160 L140 160")).toBeUndefined();
      expect(undoButton()).toBeDisabled();
    });

    it("una esquina marcada sobrevive a la simplificación; con «Cerrar el trazo al soltar» el resultado es un relleno", async () => {
      installWorkspaceFetch();
      await renderWorkspace();
      selectLayerRow("Azul");
      startDraw();
      fireEvent.click(inPanel().getByRole("radio", { name: "Mano alzada" }));
      fireEvent.click(inPanel().getByRole("checkbox", { name: "Cerrar el trazo al soltar" }));

      dragAlong(drawSurface(), [
        [200, 100],
        [230, 100],
        [260, 100],
        [260, 130],
        [260, 160],
      ]);

      expect(pathByData("M200 100 L260 100 L260 160 Z")!.fill()).toBe("#0000ff");
    });

    it("el preview del trazo en curso se ve mientras se arrastra y desaparece al soltar", async () => {
      installWorkspaceFetch();
      await renderWorkspace();
      selectLayerRow("Azul");
      startDraw();
      fireEvent.click(inPanel().getByRole("radio", { name: "Mano alzada" }));
      const surface = drawSurface();
      fireEvent.pointerDown(surface, { pointerId: 1, button: 0, clientX: 300, clientY: 400 });
      fireEvent.pointerMove(surface, { pointerId: 1, clientX: 340, clientY: 400 });
      expect(screen.getByTestId("draw-preview")).toBeInTheDocument();
      expect(undoButton()).toBeDisabled();
      fireEvent.pointerUp(surface, { pointerId: 1, clientX: 380, clientY: 400 });
      expect(screen.queryByTestId("draw-preview")).not.toBeInTheDocument();
    });

    it("Escape durante el arrastre descarta el trazo sin crear nada", async () => {
      installWorkspaceFetch();
      await renderWorkspace();
      selectLayerRow("Azul");
      startDraw();
      fireEvent.click(inPanel().getByRole("radio", { name: "Mano alzada" }));
      const surface = drawSurface();
      pointerDownMove(surface);
      press("Escape");
      fireEvent.pointerUp(surface, { pointerId: 1, clientX: 380, clientY: 400 });

      expect(undoButton()).toBeDisabled();
      expect(screen.queryByTestId("draw-preview")).not.toBeInTheDocument();
    });
  });

  describe("cerrado que se auto-intersecta: normalización con el servidor", () => {
    const BOWTIE: Array<[number, number]> = [
      [100, 20],
      [140, 60],
      [140, 20],
      [100, 60],
    ];
    const triangles = () => [
      { type: "polygon", coordinates: [[[100, 20], [120, 40], [100, 60], [100, 20]]] },
      { type: "polygon", coordinates: [[[120, 40], [140, 20], [140, 60], [120, 40]]] },
    ];

    async function drawBowtie() {
      for (const [x, y] of BOWTIE) clickAt(drawSurface(), x, y);
      fireEvent.click(inPanel().getByRole("button", { name: "Cerrar" }));
    }

    it("manda `normalize` al servidor y el resultado (2 piezas) reemplaza al trazo: dos objetos, UN comando, un solo undo", async () => {
      const fetchMock = installWorkspaceFetch({ geometry: () => geometryResponse("normalize", [{ changed: true, geometries: triangles() }]) });
      await renderWorkspace();
      selectLayerRow("Rojo");
      startDraw();
      await drawBowtie();

      await waitFor(() => expect(pathByData("M100 20 L120 40 L100 60 Z")).toBeDefined());
      expect(pathByData("M120 40 L140 20 L140 60 Z")!.fill()).toBe("#ff0000");
      expect(fetchMock.geometryCalls).toHaveLength(1);
      expect(fetchMock.geometryCalls[0]).toEqual({
        operation: "normalize",
        subjects: [{ type: "polygon", coordinates: [[[100, 20], [140, 60], [140, 20], [100, 60]]] }],
        operands: [],
        tolerance: 0.02,
      });
      // El trazo NO se creó tal cual: no existe el moño autointersecado.
      expect(pathByData("M100 20 L140 60 L140 20 L100 60 Z")).toBeUndefined();

      fireEvent.click(undoButton());
      expect(pathByData("M100 20 L120 40 L100 60 Z")).toBeUndefined();
      expect(pathByData("M120 40 L140 20 L140 60 Z")).toBeUndefined();
      expect(undoButton()).toBeDisabled();
    });

    it("si el servidor NO está disponible el trazo se rechaza con mensaje: no se crea nada (ni el moño) y el borrador se conserva para reintentar", async () => {
      let attempt = 0;
      const fetchMock = installWorkspaceFetch({
        geometry: () => {
          attempt += 1;
          return attempt === 1 ? jsonResponse({ code: "engine_unavailable", message: "caído" }, 503) : geometryResponse("normalize", [{ changed: true, geometries: triangles() }]);
        },
      });
      await renderWorkspace();
      selectLayerRow("Rojo");
      startDraw();
      await drawBowtie();

      await waitFor(() => expect(inPanel().getByRole("alert")).toHaveTextContent(/motor de geometría no está disponible/));
      expect(inPanel().getByRole("alert")).toHaveTextContent(/El trazo no se creó/);
      expect(pathByData("M100 20 L140 60 L140 20 L100 60 Z")).toBeUndefined();
      expect(undoButton()).toBeDisabled();
      expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();
      expect(inPanel().getByText("4 puntos colocados.")).toBeInTheDocument();

      // Error recuperable: se reintenta con el mismo borrador.
      fireEvent.click(inPanel().getByRole("button", { name: "Cerrar" }));
      await waitFor(() => expect(pathByData("M100 20 L120 40 L100 60 Z")).toBeDefined());
      expect(fetchMock.geometryCalls).toHaveLength(2);
    });

    it("una respuesta incoherente del servidor (tipo equivocado) no crea nada", async () => {
      installWorkspaceFetch({ geometry: () => geometryResponse("normalize", [{ changed: true, geometries: [{ type: "line", coordinates: [[0, 0], [1, 1]] }] }]) });
      await renderWorkspace();
      selectLayerRow("Rojo");
      startDraw();
      await drawBowtie();

      await waitFor(() => expect(inPanel().getByRole("alert")).toHaveTextContent(/no se puede usar/));
      expect(undoButton()).toBeDisabled();
    });

    it("si la normalización no deja piezas (anillo sin área) tampoco se crea nada", async () => {
      installWorkspaceFetch({ geometry: () => geometryResponse("normalize", [{ changed: true, geometries: [] }]) });
      await renderWorkspace();
      selectLayerRow("Rojo");
      startDraw();
      await drawBowtie();

      await waitFor(() => expect(inPanel().getByRole("alert")).toHaveTextContent(/no encierra área/));
      expect(undoButton()).toBeDisabled();
    });

    it("Escape cancela el cálculo en curso (aborta el fetch): no se crea nada y se informa", async () => {
      const fetchMock = installWorkspaceFetch({ geometry: () => new Promise<Response>(() => {}) });
      await renderWorkspace();
      selectLayerRow("Rojo");
      startDraw();
      await drawBowtie();

      await waitFor(() => expect(inPanel().getByText("Calculando en el servidor…")).toBeInTheDocument());
      // Mientras calcula no se aceptan más puntos.
      clickAt(drawSurface(), 10, 10);
      expect(inPanel().getByText("4 puntos colocados.")).toBeInTheDocument();

      press("Escape");
      await waitFor(() => expect(screen.queryByText("Calculando en el servidor…")).not.toBeInTheDocument());
      const geometrySignal = fetchMock.signals[fetchMock.urls.findIndex((url) => url.endsWith("/api/v2/geometry/boolean"))];
      expect(geometrySignal?.aborted).toBe(true);
      expect(inPanel().getByRole("alert")).toHaveTextContent(/Cálculo cancelado/);
      expect(undoButton()).toBeDisabled();
      expect(pathData()).not.toContain("M100 20 L120 40 L100 60 Z");
    });

    it("el botón «Cancelar cálculo» también aborta", async () => {
      const fetchMock = installWorkspaceFetch({ geometry: () => new Promise<Response>(() => {}) });
      await renderWorkspace();
      selectLayerRow("Rojo");
      startDraw();
      await drawBowtie();

      fireEvent.click(await screen.findByRole("button", { name: "Cancelar cálculo" }));
      await waitFor(() => expect(screen.queryByText("Calculando en el servidor…")).not.toBeInTheDocument());
      expect(fetchMock.signals.some((signal, index) => fetchMock.urls[index].endsWith("/geometry/boolean") && signal?.aborted)).toBe(true);
    });

    it("un cerrado SIMPLE no llama al servidor", async () => {
      const fetchMock = installWorkspaceFetch();
      await renderWorkspace();
      selectLayerRow("Rojo");
      startDraw();
      clickAt(drawSurface(), 100, 20);
      clickAt(drawSurface(), 140, 20);
      clickAt(drawSurface(), 140, 60);
      fireEvent.click(inPanel().getByRole("button", { name: "Cerrar" }));

      expect(pathByData("M100 20 L140 20 L140 60 Z")).toBeDefined();
      expect(fetchMock.geometryCalls).toHaveLength(0);
    });
  });

  describe("StrictMode", () => {
    it("el flujo completo (capa nueva + trazo + undo/redo) funciona con el doble efecto de StrictMode", async () => {
      installWorkspaceFetch();
      await renderWorkspace({ strict: true });
      startDraw();
      clickAt(drawSurface(), 100, 30);
      clickAt(drawSurface(), 160, 30);
      press("Enter");

      expect(pathByData("M100 30 L160 30")).toBeDefined();
      expect(layerNames()).toEqual(["Rojo", "Azul", "Líneas", "Dibujo"]);
      fireEvent.click(undoButton());
      expect(layerNames()).toEqual(["Rojo", "Azul", "Líneas"]);
      fireEvent.click(redoButton());
      expect(pathByData("M100 30 L160 30")).toBeDefined();
    });
  });
});

function pointerDownMove(surface: HTMLElement) {
  fireEvent.pointerDown(surface, { pointerId: 1, button: 0, clientX: 300, clientY: 400 });
  fireEvent.pointerMove(surface, { pointerId: 1, clientX: 340, clientY: 400 });
}
