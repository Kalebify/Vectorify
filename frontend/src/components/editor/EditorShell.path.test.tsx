import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pathToModel } from "../../lib/editor/nodes";
import {
  clickAt,
  GEOMETRY_DIRTY,
  installResizeObserver,
  installWorkspaceFetch,
  pathByData,
  pathData,
  redoButton,
  renderWorkspace,
  toScreen,
  tool,
  undoButton,
} from "../../test/workspaceFixture";

/**
 * Integración de la herramienta Path (M3-S05) en el Workspace completo: entrar/salir, rechazos, selección de nodos, arrastre de anchors y
 * handles (UN comando por gesto, Escape cancela sin rastro), flechas fusionadas, agregar / eliminar / alternar / cerrar / abrir, panel numérico
 * en mm, objetos con matriz, líneas abiertas de Draw, y que un objeto no editado conserve su `d` byte a byte. Documento 320 x 240 u con 0,5 mm por
 * unidad; con escala 1 y un contenedor de 800 x 600: pantalla = documento + (240, 180).
 */

const svg = (...paths: string[]) => `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240">${paths.join("")}</svg>`;
const red = (id: string, d: string, extra = "") => `<path data-vid="${id}" d="${d}" fill="#ff0000"${extra}/>`;

const SQ = "M20 20 L120 20 L120 120 L20 120 Z";
const ARCH = "M150 100 C150 180 230 180 230 100";
const WAVE = "M20 200 C40 160 80 160 100 200 C120 240 160 240 180 200";
const ROT_D = "M0 0 L50 0 L50 30 L0 30 Z";
const RING = "M140 20 L220 20 L220 80 L140 80 Z M160 35 L160 65 L200 35 Z";
const POLY = "M240 120 L290 120 L290 160 L240 160";
const LINE = "M200 200 L260 200";

/** Capa A: cuadrado, arcada, onda simétrica y un rectángulo girado 90° (local (x, y) -> documento (300 - y, x + 20)). Capa B: anillo con hueco. Capa C: polilínea abierta y una línea abierta. */
const SVGS = {
  A: svg(red("sq", SQ), red("arch", ARCH), red("wave", WAVE), red("rot", ROT_D, ' transform="matrix(0 1 -1 0 300 20)"')),
  B: svg(`<path data-vid="ring" d="${RING}" fill="#0000ff"/>`),
  C: svg(`<path data-vid="poly" d="${POLY}" fill="none" stroke="#00aa00" stroke-width="0.5"/>`, `<path data-vid="ln" d="${LINE}" fill="none" stroke="#00aa00" stroke-width="0.5"/>`),
};

const canvas = () => screen.getByRole("application");
const surface = () => screen.getByTestId("path-surface");
const panel = () => screen.getByRole("heading", { name: /Path — nodos/ }).closest("section")!;
const inPanel = () => within(panel());
const anchors = () => [...surface().querySelectorAll<SVGRectElement>('[data-testid="path-anchor"]')];
const anchorOf = (key: string) => surface().querySelector<SVGRectElement>(`[data-node="${key}"]`)!;
const selectedKeys = () => anchors().filter((anchor) => anchor.dataset.selected === "true").map((anchor) => anchor.dataset.node);
const handleOf = (key: string) => surface().querySelector<SVGCircleElement>(`[data-handle="${key}"]`);
const press = (key: string, options: { shiftKey?: boolean; ctrlKey?: boolean } = {}) => fireEvent.keyDown(canvas(), { key, ...options });

async function open(options: { svg?: Partial<typeof SVGS>; strict?: boolean; minPaths?: number; lockedA?: boolean } = {}) {
  installWorkspaceFetch({ svg: { ...SVGS, ...options.svg }, lockedA: options.lockedA });
  return renderWorkspace({ strict: options.strict, minPaths: options.minPaths ?? 7 });
}

/** Selecciona el objeto bajo (x, y) con Select y activa la herramienta Path. */
function enterPathOn(x: number, y: number) {
  clickAt(canvas(), x, y);
  fireEvent.click(tool(/^Path/));
}

/** Arrastre completo en la superficie de Path: down, dos movimientos (el primero pasa el umbral) y up. */
function dragOnSurface(from: [number, number], to: [number, number], modifiers: { altKey?: boolean; shiftKey?: boolean } = {}) {
  const middle = { clientX: (from[0] + to[0]) / 2 + 240, clientY: (from[1] + to[1]) / 2 + 180 };
  fireEvent.pointerDown(surface(), { pointerId: 1, button: 0, ...toScreen(...from), ...modifiers });
  fireEvent.pointerMove(surface(), { pointerId: 1, ...middle, ...modifiers });
  fireEvent.pointerMove(surface(), { pointerId: 1, ...toScreen(...to), ...modifiers });
  fireEvent.pointerUp(surface(), { pointerId: 1, ...toScreen(...to) });
}

describe("EditorShell — herramienta Path (M3-S05)", () => {
  beforeEach(() => installResizeObserver());
  afterEach(() => vi.unstubAllGlobals());

  describe("entrar, salir y rechazos", () => {
    it("con un objeto seleccionado, Path muestra el overlay (4 anchors) y el panel; Escape sin nodos seleccionados y Enter vuelven a Select", async () => {
      await open();
      expect(screen.queryByTestId("path-surface")).not.toBeInTheDocument();
      enterPathOn(70, 70);

      expect(inPanel().getByText(/4 nodos · 0 seleccionados/)).toBeInTheDocument();
      expect(anchors()).toHaveLength(4);
      expect(tool(/^Path/)).toHaveAttribute("aria-pressed", "true");
      expect(surface()).toHaveAccessibleName(/Edición de nodos del path: 4 nodos, 0 seleccionados/);
      // Entrar no modifica nada: ni historial ni indicador de geometría.
      expect(undoButton()).toBeDisabled();
      expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();

      press("Escape");
      expect(tool(/^Select/)).toHaveAttribute("aria-pressed", "true");
      expect(screen.queryByTestId("path-surface")).not.toBeInTheDocument();

      fireEvent.click(tool(/^Path/));
      expect(anchors()).toHaveLength(4);
      press("Enter");
      expect(tool(/^Select/)).toHaveAttribute("aria-pressed", "true");
      expect(undoButton()).toBeDisabled();
    });

    it("doble click sobre un objeto con Select lo selecciona y pasa a Path", async () => {
      await open();
      fireEvent.doubleClick(canvas(), toScreen(70, 70));

      expect(tool(/^Path/)).toHaveAttribute("aria-pressed", "true");
      expect(anchors()).toHaveLength(4);
      expect(inPanel().getByText("«Rojo»")).toBeInTheDocument();
    });

    it("doble click en vacío con Select no entra a Path", async () => {
      await open();
      fireEvent.doubleClick(canvas(), toScreen(5, 5));
      expect(tool(/^Select/)).toHaveAttribute("aria-pressed", "true");
    });

    it("sin selección: el panel pide elegir un objeto y NO hay overlay; un click sobre un objeto lo selecciona y empieza la edición", async () => {
      await open();
      fireEvent.click(tool(/^Path/));
      expect(inPanel().getByRole("alert")).toHaveTextContent("Seleccioná un objeto para editar sus nodos");
      expect(screen.queryByTestId("path-surface")).not.toBeInTheDocument();

      clickAt(canvas(), 70, 70);
      expect(anchors()).toHaveLength(4);
      expect(inPanel().queryByRole("alert")).not.toBeInTheDocument();
      // Elegir el objeto no es una edición.
      expect(undoButton()).toBeDisabled();
    });

    it("varios objetos seleccionados: «Seleccioná un solo objeto» y sin overlay", async () => {
      await open();
      press("a", { ctrlKey: true });
      fireEvent.click(tool(/^Path/));

      expect(inPanel().getByRole("alert")).toHaveTextContent(/Seleccioná un solo objeto para editar sus nodos \(hay 7 seleccionados\)/);
      expect(screen.queryByTestId("path-surface")).not.toBeInTheDocument();

      // Elegir uno solo resuelve el rechazo sin salir de la herramienta.
      clickAt(canvas(), 70, 70);
      expect(anchors()).toHaveLength(4);
    });

    it("capa BLOQUEADA: rechazo claro con el nombre de la capa, sin overlay y sin que Suprimir toque nada", async () => {
      await open({ lockedA: true });
      enterPathOn(70, 70);

      expect(inPanel().getByRole("alert")).toHaveTextContent("La capa «Rojo» está bloqueada: no se pueden editar sus nodos");
      expect(screen.queryByTestId("path-surface")).not.toBeInTheDocument();
      press("Delete");
      expect(pathByData(SQ)).toBeDefined();
      expect(undoButton()).toBeDisabled();
    });

    it("matriz NO invertible (escala 0): se rechaza el objeto con mensaje", async () => {
      await open({ svg: { A: svg(red("z", "M0 0 L40 0 L40 40 L0 40 Z", ' transform="matrix(0 0 0 0 100 100)"')) }, minPaths: 1 });
      enterPathOn(100, 100);

      expect(inPanel().getByRole("alert")).toHaveTextContent("no es invertible");
      expect(screen.queryByTestId("path-surface")).not.toBeInTheDocument();
    });

    it("un d que el parser no lee completo se rechaza (no se reserializa una cola dañada)", async () => {
      await open({ svg: { A: svg(red("bad", "M20 20 L120 20 L120 120 L foo")) }, minPaths: 1 });
      enterPathOn(70, 20);

      expect(inPanel().getByRole("alert")).toHaveTextContent(/no se puede leer completo/);
      expect(screen.queryByTestId("path-surface")).not.toBeInTheDocument();
    });

    it("cambiar de herramienta desde Path no deja rastro (sin comandos ni geometría sucia)", async () => {
      await open();
      enterPathOn(70, 70);
      clickAt(surface(), 120, 20);
      fireEvent.click(tool(/^Select/));

      expect(screen.queryByTestId("path-surface")).not.toBeInTheDocument();
      expect(undoButton()).toBeDisabled();
    });
  });

  describe("selección de nodos", () => {
    it("click en un anchor lo selecciona; Shift+click agrega y quita; click en vacío limpia", async () => {
      await open();
      enterPathOn(70, 70);

      clickAt(surface(), 120, 20);
      expect(selectedKeys()).toEqual(["0:1"]);
      expect(inPanel().getByText(/1 seleccionado\b/)).toBeInTheDocument();

      fireEvent.pointerDown(surface(), { pointerId: 1, button: 0, shiftKey: true, ...toScreen(120, 120) });
      fireEvent.pointerUp(surface(), { pointerId: 1, shiftKey: true, ...toScreen(120, 120) });
      expect(selectedKeys()).toEqual(["0:1", "0:2"]);

      fireEvent.pointerDown(surface(), { pointerId: 1, button: 0, shiftKey: true, ...toScreen(120, 120) });
      fireEvent.pointerUp(surface(), { pointerId: 1, shiftKey: true, ...toScreen(120, 120) });
      expect(selectedKeys()).toEqual(["0:1"]);

      clickAt(surface(), 5, 5);
      expect(selectedKeys()).toEqual([]);
      expect(undoButton()).toBeDisabled();
    });

    it("click sobre un segmento selecciona sus dos extremos; click simple sobre un nodo de una multi-selección la reduce a ese nodo", async () => {
      await open();
      enterPathOn(70, 70);

      clickAt(surface(), 70, 20);
      expect(selectedKeys()).toEqual(["0:0", "0:1"]);
      clickAt(surface(), 20, 20);
      expect(selectedKeys()).toEqual(["0:0"]);
    });

    it("marquee en vacío selecciona los anchors dentro del rectángulo; con Shift suma a la selección", async () => {
      await open();
      enterPathOn(70, 70);

      fireEvent.pointerDown(surface(), { pointerId: 1, button: 0, ...toScreen(10, 10) });
      fireEvent.pointerMove(surface(), { pointerId: 1, ...toScreen(60, 60) });
      expect(screen.getByTestId("path-marquee")).toBeInTheDocument();
      fireEvent.pointerMove(surface(), { pointerId: 1, ...toScreen(130, 50) });
      fireEvent.pointerUp(surface(), { pointerId: 1, ...toScreen(130, 50) });
      expect(selectedKeys()).toEqual(["0:0", "0:1"]);
      expect(screen.queryByTestId("path-marquee")).not.toBeInTheDocument();
      // Un marquee no es un comando.
      expect(undoButton()).toBeDisabled();

      fireEvent.pointerDown(surface(), { pointerId: 1, button: 0, shiftKey: true, ...toScreen(10, 100) });
      fireEvent.pointerMove(surface(), { pointerId: 1, shiftKey: true, ...toScreen(60, 130) });
      fireEvent.pointerMove(surface(), { pointerId: 1, shiftKey: true, ...toScreen(130, 130) });
      fireEvent.pointerUp(surface(), { pointerId: 1, shiftKey: true, ...toScreen(130, 130) });
      expect(selectedKeys()).toEqual(["0:0", "0:1", "0:2", "0:3"]);
    });

    it("Ctrl+A selecciona todos los nodos del subpath activo; Escape limpia la selección (y NO sale); un segundo Escape sale", async () => {
      await open();
      enterPathOn(70, 70);
      press("a", { ctrlKey: true });
      expect(selectedKeys()).toHaveLength(4);

      press("Escape");
      expect(selectedKeys()).toEqual([]);
      expect(tool(/^Path/)).toHaveAttribute("aria-pressed", "true");
      press("Escape");
      expect(tool(/^Select/)).toHaveAttribute("aria-pressed", "true");
    });

    it("un click sobre OTRO objeto estando en Path lo pasa a editar", async () => {
      await open();
      enterPathOn(70, 70);
      expect(anchors()).toHaveLength(4);

      clickAt(surface(), 190, 130);
      expect(anchors()).toHaveLength(2);
      expect(tool(/^Path/)).toHaveAttribute("aria-pressed", "true");
    });

    it("«Nodo siguiente / anterior» recorre los nodos con el teclado", async () => {
      await open();
      enterPathOn(70, 70);
      fireEvent.click(inPanel().getByRole("button", { name: "Nodo siguiente" }));
      expect(selectedKeys()).toEqual(["0:0"]);
      fireEvent.click(inPanel().getByRole("button", { name: "Nodo anterior" }));
      expect(selectedKeys()).toEqual(["0:3"]);
    });
  });

  describe("arrastre = UN comando", () => {
    it("arrastrar un anchor: la pila de undo crece exactamente 1 AL SOLTAR; undo y redo restauran el d exacto", async () => {
      await open();
      enterPathOn(70, 70);

      fireEvent.pointerDown(surface(), { pointerId: 1, button: 0, ...toScreen(120, 20) });
      fireEvent.pointerMove(surface(), { pointerId: 1, ...toScreen(125, 22) });
      fireEvent.pointerMove(surface(), { pointerId: 1, ...toScreen(130, 25) });
      // Durante el gesto la vista usa la previsualización, pero NADA entró a la pila.
      expect(pathByData("M20 20 L130 25 L120 120 L20 120 Z")).toBeDefined();
      expect(undoButton()).toBeDisabled();
      fireEvent.pointerUp(surface(), { pointerId: 1, ...toScreen(130, 25) });

      expect(pathByData("M20 20 L130 25 L120 120 L20 120 Z")).toBeDefined();
      expect(pathByData(SQ)).toBeUndefined();
      expect(undoButton()).toBeEnabled();
      expect(screen.getByText(GEOMETRY_DIRTY)).toBeInTheDocument();
      expect(selectedKeys()).toEqual(["0:1"]);

      fireEvent.click(undoButton());
      expect(pathByData(SQ)).toBeDefined();
      expect(undoButton()).toBeDisabled(); // UN solo comando
      fireEvent.click(redoButton());
      expect(pathByData("M20 20 L130 25 L120 120 L20 120 Z")).toBeDefined();
      expect(redoButton()).toBeDisabled();
    });

    it("mover varios anchors seleccionados es UN comando y todos se mueven el mismo delta", async () => {
      await open();
      enterPathOn(70, 70);
      press("a", { ctrlKey: true });
      dragOnSurface([20, 20], [30, 40]);

      expect(pathByData("M30 40 L130 40 L130 140 L30 140 Z")).toBeDefined();
      fireEvent.click(undoButton());
      expect(pathByData(SQ)).toBeDefined();
      expect(undoButton()).toBeDisabled();
    });

    it("arrastrar un segmento mueve sus dos extremos", async () => {
      await open();
      enterPathOn(70, 70);
      dragOnSurface([70, 20], [70, 40]);

      expect(pathByData("M20 40 L120 40 L120 120 L20 120 Z")).toBeDefined();
    });

    it("Escape DURANTE el arrastre cancela sin rastro (sigue en Path, nada en la pila) y el soltar posterior no hace nada", async () => {
      await open();
      enterPathOn(70, 70);

      fireEvent.pointerDown(surface(), { pointerId: 1, button: 0, ...toScreen(120, 20) });
      fireEvent.pointerMove(surface(), { pointerId: 1, ...toScreen(125, 22) });
      fireEvent.pointerMove(surface(), { pointerId: 1, ...toScreen(150, 60) });
      expect(pathByData("M20 20 L150 60 L120 120 L20 120 Z")).toBeDefined();

      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(pathByData(SQ)).toBeDefined();
      expect(tool(/^Path/)).toHaveAttribute("aria-pressed", "true");
      fireEvent.pointerMove(surface(), { pointerId: 1, ...toScreen(160, 80) });
      fireEvent.pointerUp(surface(), { pointerId: 1, ...toScreen(160, 80) });

      expect(pathByData(SQ)).toBeDefined();
      expect(undoButton()).toBeDisabled();
      expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();
    });

    it("pointercancel cancela el gesto sin rastro", async () => {
      await open();
      enterPathOn(70, 70);
      fireEvent.pointerDown(surface(), { pointerId: 1, button: 0, ...toScreen(120, 20) });
      fireEvent.pointerMove(surface(), { pointerId: 1, ...toScreen(150, 60) });
      fireEvent.pointerCancel(surface(), { pointerId: 1 });

      expect(pathByData(SQ)).toBeDefined();
      expect(undoButton()).toBeDisabled();
    });

    it("un click sin pasar el umbral NO crea comando; un arrastre de menos de 3 px tampoco", async () => {
      await open();
      enterPathOn(70, 70);
      fireEvent.pointerDown(surface(), { pointerId: 1, button: 0, ...toScreen(120, 20) });
      fireEvent.pointerMove(surface(), { pointerId: 1, ...toScreen(121, 21) });
      fireEvent.pointerUp(surface(), { pointerId: 1, ...toScreen(121, 21) });

      expect(pathByData(SQ)).toBeDefined();
      expect(undoButton()).toBeDisabled();
    });

    it("Shift restringe el arrastre al eje dominante", async () => {
      await open();
      enterPathOn(70, 70);
      dragOnSurface([120, 20], [130, 23], { shiftKey: true });

      expect(pathByData("M20 20 L130 20 L120 120 L20 120 Z")).toBeDefined();
    });

    it("arrastrar un handle suave/simétrico: el opuesto es el espejo exacto (UN comando)", async () => {
      await open();
      enterPathOn(60, 170); // la onda (nodo central simétrico)
      clickAt(surface(), 100, 200);
      expect(selectedKeys()).toEqual(["0:1"]);
      expect(handleOf("0:1:out")).not.toBeNull();
      expect(handleOf("0:1:in")).not.toBeNull();

      dragOnSurface([120, 240], [130, 240]);

      expect(pathByData("M20 200 C40 160 70 160 100 200 C130 240 160 240 180 200")).toBeDefined();
      fireEvent.click(undoButton());
      expect(pathByData(WAVE)).toBeDefined();
      expect(undoButton()).toBeDisabled();
    });

    it("Alt mientras se arrastra un handle rompe el nodo a esquina: el opuesto NO acompaña", async () => {
      await open();
      enterPathOn(60, 170);
      clickAt(surface(), 100, 200);
      dragOnSurface([120, 240], [130, 240], { altKey: true });

      expect(pathByData("M20 200 C40 160 80 160 100 200 C130 240 160 240 180 200")).toBeDefined();
      expect(inPanel().getByRole("radio", { name: "Esquina" })).toBeChecked();
    });

    it("un nodo marcado como esquina (Alt+click sobre uno simétrico: solo cambia la etiqueta, NO es un comando) conserva ese tipo al arrastrar sus handles", async () => {
      await open();
      enterPathOn(60, 170);
      clickAt(surface(), 100, 200);
      expect(inPanel().getByRole("radio", { name: "Simétrico" })).toBeChecked();

      fireEvent.pointerDown(surface(), { pointerId: 1, button: 0, altKey: true, ...toScreen(100, 200) });
      fireEvent.pointerUp(surface(), { pointerId: 1, altKey: true, ...toScreen(100, 200) });
      expect(inPanel().getByRole("radio", { name: "Esquina" })).toBeChecked();
      expect(undoButton()).toBeDisabled();

      dragOnSurface([120, 240], [130, 240]);
      // El handle de entrada se queda donde estaba: el nodo sigue siendo esquina aunque la geometría fuera collineal.
      expect(pathByData("M20 200 C40 160 80 160 100 200 C130 240 160 240 180 200")).toBeDefined();
    });
  });

  describe("teclado", () => {
    it("las flechas empujan los nodos seleccionados (1 u; Shift 10 u) y una ráfaga es UN comando; la vista no se desplaza", async () => {
      await open();
      enterPathOn(70, 70);
      clickAt(surface(), 120, 20);
      const anchorBefore = anchorOf("0:0").getAttribute("x");

      press("ArrowRight");
      press("ArrowRight");
      press("ArrowRight");
      expect(pathByData("M20 20 L123 20 L120 120 L20 120 Z")).toBeDefined();
      press("ArrowDown", { shiftKey: true });
      expect(pathByData("M20 20 L123 30 L120 120 L20 120 Z")).toBeDefined();
      // Las flechas empujan nodos, no desplazan la vista: el anchor que no se movió sigue en el mismo píxel.
      expect(anchorOf("0:0").getAttribute("x")).toBe(anchorBefore);

      fireEvent.click(undoButton());
      expect(pathByData(SQ)).toBeDefined();
      expect(undoButton()).toBeDisabled();
    });

    it("las flechas sin nodos seleccionados no hacen nada (ni comando ni desplazamiento de objetos)", async () => {
      await open();
      enterPathOn(70, 70);
      press("ArrowRight");
      expect(pathByData(SQ)).toBeDefined();
      expect(undoButton()).toBeDisabled();
    });

    it("Suprimir elimina los nodos seleccionados (UN comando, undo exacto); el objeto NO se elimina", async () => {
      await open();
      enterPathOn(70, 70);
      clickAt(surface(), 20, 120);
      press("Delete");

      expect(pathByData("M20 20 L120 20 L120 120 Z")).toBeDefined();
      expect(anchors()).toHaveLength(3);
      expect(selectedKeys()).toEqual([]);
      fireEvent.click(undoButton());
      expect(pathByData(SQ)).toBeDefined();
      expect(undoButton()).toBeDisabled();
    });
  });

  describe("agregar, eliminar y alternar", () => {
    it("doble click sobre un segmento agrega un nodo (De Casteljau) y lo selecciona; undo restaura el d exacto", async () => {
      await open();
      enterPathOn(70, 70);
      fireEvent.doubleClick(surface(), toScreen(70, 20));

      expect(pathByData("M20 20 L70 20 L120 20 L120 120 L20 120 Z")).toBeDefined();
      expect(anchors()).toHaveLength(5);
      expect(selectedKeys()).toEqual(["0:1"]);
      fireEvent.click(undoButton());
      expect(pathByData(SQ)).toBeDefined();
      expect(undoButton()).toBeDisabled();
    });

    it("Ctrl+click sobre un segmento también agrega un nodo; sobre una curva reparte los handles sin cambiar la forma", async () => {
      await open();
      enterPathOn(70, 70);
      fireEvent.pointerDown(surface(), { pointerId: 1, button: 0, ctrlKey: true, ...toScreen(120, 70) });
      fireEvent.pointerUp(surface(), { pointerId: 1, ...toScreen(120, 70) });
      expect(pathByData("M20 20 L120 20 L120 70 L120 120 L20 120 Z")).toBeDefined();

      fireEvent.click(tool(/^Select/));
      enterPathOn(190, 130); // la arcada: su punto medio (t = 0,5) es (190, 160)
      fireEvent.pointerDown(surface(), { pointerId: 1, button: 0, ctrlKey: true, ...toScreen(190, 160) });
      fireEvent.pointerUp(surface(), { pointerId: 1, ...toScreen(190, 160) });
      const changed = pathData().find((d) => d.startsWith("M150 100 C150 140"));
      expect(changed).toBeDefined();
      const model = pathToModel(changed!);
      expect(model.ok && model.model.subpaths[0].nodes).toHaveLength(3);
      if (model.ok) {
        expect(model.model.subpaths[0].nodes[1].anchor.x).toBeCloseTo(190, 3);
        expect(model.model.subpaths[0].nodes[1].anchor.y).toBeCloseTo(160, 3);
        expect(model.model.subpaths[0].nodes[1].handleIn!.x).toBeCloseTo(170, 3);
        expect(model.model.subpaths[0].nodes[1].handleOut!.x).toBeCloseTo(210, 3);
      }
    });

    it("eliminar nodos de un único subpath cuando quedaría degenerado se RECHAZA con mensaje y no cambia nada", async () => {
      await open();
      enterPathOn(70, 70);
      clickAt(surface(), 20, 120);
      press("Delete");
      expect(pathByData("M20 20 L120 20 L120 120 Z")).toBeDefined();

      clickAt(surface(), 120, 120);
      press("Delete");
      expect(inPanel().getByRole("alert")).toHaveTextContent(/sin geometría/);
      expect(pathByData("M20 20 L120 20 L120 120 Z")).toBeDefined();
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      fireEvent.click(undoButton());
      expect(pathByData(SQ)).toBeDefined();
      expect(undoButton()).toBeDisabled(); // solo hubo UN comando
    });

    it("eliminar un nodo que degenera un subpath con otro subpath: pide CONFIRMACIÓN; Escape la descarta; confirmar elimina el subpath entero (UN comando)", async () => {
      await open();
      enterPathOn(150, 50); // el anillo (capa Azul), fuera del hueco
      clickAt(surface(), 160, 35);
      expect(selectedKeys()).toEqual(["1:0"]);

      press("Delete");
      expect(screen.getByRole("alertdialog")).toHaveTextContent(/Se eliminará el subpath 2 completo/);
      expect(pathByData(RING)).toBeDefined();
      expect(undoButton()).toBeDisabled();

      press("Escape");
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(selectedKeys()).toEqual(["1:0"]);
      expect(tool(/^Path/)).toHaveAttribute("aria-pressed", "true");

      press("Delete");
      fireEvent.click(screen.getByRole("button", { name: "Eliminar el subpath" }));
      expect(pathByData("M140 20 L220 20 L220 80 L140 80 Z")).toBeDefined();
      expect(pathByData(RING)).toBeUndefined();
      fireEvent.click(undoButton());
      expect(pathByData(RING)).toBeDefined();
      expect(undoButton()).toBeDisabled();
    });

    it("Alt+click sobre una esquina la vuelve suave: genera la tangente (UN comando) y undo restaura el d exacto", async () => {
      await open();
      enterPathOn(70, 70);
      fireEvent.pointerDown(surface(), { pointerId: 1, button: 0, altKey: true, ...toScreen(120, 20) });
      fireEvent.pointerUp(surface(), { pointerId: 1, altKey: true, ...toScreen(120, 20) });

      expect(pathByData(SQ)).toBeUndefined();
      // La tangente sale de los vecinos (20,20) y (120,120): handles de 1/3 del lado (33,3 u) sobre la diagonal.
      const smoothed = pathData().find((d) => d.startsWith("M20 20 C"))!;
      const parsed = pathToModel(smoothed);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        const node = parsed.model.subpaths[0].nodes[1];
        expect(node.anchor).toEqual({ x: 120, y: 20 });
        expect(node.handleIn!.x).toBeCloseTo(120 - 33.333333 * Math.SQRT1_2, 4);
        expect(node.handleIn!.y).toBeCloseTo(20 - 33.333333 * Math.SQRT1_2, 4);
        expect(node.handleOut!.x).toBeCloseTo(120 + 33.333333 * Math.SQRT1_2, 4);
        expect(node.handleOut!.y).toBeCloseTo(20 + 33.333333 * Math.SQRT1_2, 4);
      }
      expect(inPanel().getByRole("radio", { name: "Suave" })).toBeChecked();
      expect(selectedKeys()).toEqual(["0:1"]);
      fireEvent.click(undoButton());
      expect(pathByData(SQ)).toBeDefined();
      expect(undoButton()).toBeDisabled();
    });

    it("recto <-> curvo desde el panel: handles a 1/3 del segmento (UN comando)", async () => {
      await open();
      enterPathOn(70, 70);
      clickAt(surface(), 120, 20);
      fireEvent.click(inPanel().getByRole("button", { name: /Segmento siguiente: recto → curvo/ }));

      expect(pathByData("M20 20 L120 20 C120 53.333333 120 86.666667 120 120 L20 120 Z")).toBeDefined();
      expect(inPanel().getByRole("button", { name: /Segmento siguiente: curvo → recto/ })).toBeInTheDocument();
      fireEvent.click(inPanel().getByRole("button", { name: /Segmento siguiente: curvo → recto/ }));
      expect(pathByData(SQ)).toBeDefined();
    });

    it("cambiar el tipo de nodo desde el panel a Simétrico alinea los handles (UN comando)", async () => {
      await open();
      enterPathOn(60, 170);
      clickAt(surface(), 100, 200);
      fireEvent.click(inPanel().getByRole("radio", { name: "Esquina" }));
      expect(inPanel().getByRole("radio", { name: "Esquina" })).toBeChecked();
      expect(undoButton()).toBeDisabled(); // solo una etiqueta
      fireEvent.click(inPanel().getByRole("radio", { name: "Suave" }));
      expect(inPanel().getByRole("radio", { name: "Suave" })).toBeChecked();
    });
  });

  describe("cerrar y abrir", () => {
    it("Cerrar solo está habilitado en un subpath abierto válido; abre/cierra como UN comando y conserva el trazo", async () => {
      await open();
      enterPathOn(265, 120);
      expect(inPanel().getByRole("button", { name: "Cerrar subpath" })).toBeEnabled();
      expect(inPanel().getByRole("button", { name: "Abrir en el nodo" })).toBeDisabled();

      fireEvent.click(inPanel().getByRole("button", { name: "Cerrar subpath" }));
      const closed = "M240 120 L290 120 L290 160 L240 160 Z";
      expect(pathByData(closed)).toBeDefined();
      expect(pathByData(closed)!.stroke()).toBe("#00aa00");
      expect(pathByData(closed)!.fill()).toBeUndefined();
      expect(inPanel().getByRole("button", { name: "Cerrar subpath" })).toBeDisabled();

      clickAt(surface(), 290, 160);
      expect(inPanel().getByRole("button", { name: "Abrir en el nodo" })).toBeEnabled();
      fireEvent.click(inPanel().getByRole("button", { name: "Abrir en el nodo" }));
      expect(pathByData("M290 160 L240 160 L240 120 L290 120 L290 160")).toBeDefined();
      expect(selectedKeys()).toEqual(["0:0", "0:4"]);

      fireEvent.click(undoButton());
      expect(pathByData(closed)).toBeDefined();
      fireEvent.click(undoButton());
      expect(pathByData(POLY)).toBeDefined();
      expect(undoButton()).toBeDisabled();
    });

    it("cerrar un abierto con menos de 3 nodos está deshabilitado (resultado inválido)", async () => {
      await open();
      enterPathOn(230, 200); // la línea de 2 nodos
      expect(inPanel().getByRole("button", { name: "Cerrar subpath" })).toBeDisabled();
    });
  });

  describe("panel numérico", () => {
    it("X e Y en mm relativos al área de trabajo (0,5 mm/u): editar es UN comando; un valor inválido se rechaza sin cambiar nada", async () => {
      await open();
      enterPathOn(70, 70);
      clickAt(surface(), 120, 20);
      const x = inPanel().getByLabelText("X (mm)") as HTMLInputElement;
      const y = inPanel().getByLabelText("Y (mm)") as HTMLInputElement;
      expect(x.value).toBe("60");
      expect(y.value).toBe("10");

      fireEvent.change(x, { target: { value: "70" } });
      fireEvent.keyDown(x, { key: "Enter" });
      expect(pathByData("M20 20 L140 20 L120 120 L20 120 Z")).toBeDefined();
      fireEvent.change(y, { target: { value: "20,5" } });
      fireEvent.keyDown(y, { key: "Enter" });
      expect(pathByData("M20 20 L140 41 L120 120 L20 120 Z")).toBeDefined();

      fireEvent.change(x, { target: { value: "abc" } });
      fireEvent.keyDown(x, { key: "Enter" });
      expect(screen.getByText(/no es un número válido para «X \(mm\)»/)).toBeInTheDocument();
      expect(pathByData("M20 20 L140 41 L120 120 L20 120 Z")).toBeDefined();
      fireEvent.change(x, { target: { value: "99999999" } });
      fireEvent.keyDown(x, { key: "Enter" });
      expect(screen.getByText(/fuera de rango/)).toBeInTheDocument();

      fireEvent.click(undoButton());
      expect(pathByData("M20 20 L140 20 L120 120 L20 120 Z")).toBeDefined();
      fireEvent.click(undoButton());
      expect(pathByData(SQ)).toBeDefined();
      expect(undoButton()).toBeDisabled();
    });

    it("multi-selección: los valores comunes se muestran y el valor tecleado alinea todos los nodos (UN comando)", async () => {
      await open();
      enterPathOn(70, 70);
      clickAt(surface(), 120, 20);
      fireEvent.pointerDown(surface(), { pointerId: 1, button: 0, shiftKey: true, ...toScreen(120, 120) });
      fireEvent.pointerUp(surface(), { pointerId: 1, shiftKey: true, ...toScreen(120, 120) });

      const x = inPanel().getByLabelText("X (mm)") as HTMLInputElement;
      const y = inPanel().getByLabelText("Y (mm)") as HTMLInputElement;
      expect(x.value).toBe("60");
      expect(y.value).toBe("");
      expect(y.placeholder).toBe("Varios");
      fireEvent.change(x, { target: { value: "50" } });
      fireEvent.keyDown(x, { key: "Enter" });
      expect(pathByData("M20 20 L100 20 L100 120 L20 120 Z")).toBeDefined();
    });

    it("largo y ángulo de un handle (mm, grados); un nodo sin handle del lado muestra «sin handle»", async () => {
      await open();
      enterPathOn(60, 170);
      clickAt(surface(), 100, 200);
      const length = inPanel().getByLabelText("Handle de salida: largo (mm)") as HTMLInputElement;
      const angle = inPanel().getByLabelText("Handle de salida: ángulo (°)") as HTMLInputElement;
      // El handle de salida es (20, 40) u: 44,721 u = 22,361 mm y atan2(40, 20) = 63,435°.
      expect(length.value).toBe("22.361");
      expect(angle.value).toBe("63.435");

      fireEvent.change(angle, { target: { value: "90" } });
      fireEvent.keyDown(angle, { key: "Enter" });
      const after = pathData().find((d) => d.startsWith("M20 200 C40 160") && d !== WAVE)!;
      const model = pathToModel(after);
      expect(model.ok).toBe(true);
      if (model.ok) {
        const node = model.model.subpaths[0].nodes[1];
        expect(node.handleOut!.x).toBeCloseTo(100, 3);
        expect(node.handleOut!.y).toBeCloseTo(200 + Math.hypot(20, 40), 3);
        // Simétrico: el handle de entrada es el espejo exacto.
        expect(node.handleIn!.x).toBeCloseTo(100, 3);
        expect(node.handleIn!.y).toBeCloseTo(200 - Math.hypot(20, 40), 3);
      }
      fireEvent.click(undoButton());
      expect(pathByData(WAVE)).toBeDefined();
      expect(undoButton()).toBeDisabled();

      clickAt(surface(), 20, 200);
      expect(inPanel().getByText(/Handle de entrada: sin handle/)).toBeInTheDocument();
    });
  });

  describe("objetos con matriz y líneas abiertas", () => {
    it("rectángulo girado 90°: el arrastre en DOCUMENTO se convierte a local con la inversa; la matriz no se toca", async () => {
      await open();
      enterPathOn(285, 45);
      expect(anchors()).toHaveLength(4);
      // Local (50, 0) es el documento (300, 70).
      expect(Number(anchorOf("0:1").getAttribute("x"))).toBe(300 + 240 - 4);
      expect(Number(anchorOf("0:1").getAttribute("y"))).toBe(70 + 180 - 4);

      dragOnSurface([300, 70], [310, 70]);
      expect(pathByData("M0 0 L50 -10 L50 30 L0 30 Z")).toBeDefined();
      expect(pathByData("M0 0 L50 -10 L50 30 L0 30 Z")!.rotation()).toBeCloseTo(90, 9);
      // El anchor está EXACTAMENTE 10 u a la derecha, donde se soltó el puntero.
      expect(Number(anchorOf("0:1").getAttribute("x"))).toBeCloseTo(310 + 240 - 4, 4);
      expect(Number(anchorOf("0:1").getAttribute("y"))).toBeCloseTo(70 + 180 - 4, 4);

      fireEvent.click(undoButton());
      expect(pathByData(ROT_D)).toBeDefined();
      expect(undoButton()).toBeDisabled();
    });

    it("rectángulo girado 90°: X del panel (mm de documento) se convierte a local", async () => {
      await open();
      enterPathOn(285, 45);
      clickAt(surface(), 300, 20); // nodo 0: local (0, 0) = documento (300, 20) = 150 mm
      const x = inPanel().getByLabelText("X (mm)") as HTMLInputElement;
      expect(x.value).toBe("150");

      fireEvent.change(x, { target: { value: "140" } });
      fireEvent.keyDown(x, { key: "Enter" });
      expect(pathByData("M0 20 L50 0 L50 30 L0 30 Z")).toBeDefined();
    });

    it("línea abierta de Draw (fill none + trazo): sus nodos se editan y conserva el trazo", async () => {
      await open();
      enterPathOn(230, 200);
      expect(anchors()).toHaveLength(2);
      dragOnSurface([260, 200], [260, 230]);

      const edited = pathByData("M200 200 L260 230");
      expect(edited).toBeDefined();
      expect(edited!.stroke()).toBe("#00aa00");
      expect(edited!.fill()).toBeUndefined();
      fireEvent.click(undoButton());
      expect(pathByData(LINE)).toBeDefined();
    });
  });

  describe("sin reserialización destructiva", () => {
    const ODD = "M20,20 h100 v100 H20 z";

    it("entrar, mirar, seleccionar y cancelar NO reescriben el d: el original se conserva byte a byte; editar y deshacer lo devuelve idéntico", async () => {
      await open({ svg: { A: svg(red("odd", ODD)) }, minPaths: 1 });
      enterPathOn(70, 70);
      fireEvent.pointerMove(surface(), { pointerId: 1, ...toScreen(120, 20) });
      clickAt(surface(), 120, 20);
      press("a", { ctrlKey: true });
      press("Escape");
      clickAt(surface(), 5, 5);
      fireEvent.pointerDown(surface(), { pointerId: 1, button: 0, ...toScreen(120, 20) });
      fireEvent.pointerMove(surface(), { pointerId: 1, ...toScreen(150, 50) });
      fireEvent.keyDown(document.body, { key: "Escape" });
      fireEvent.pointerUp(surface(), { pointerId: 1, ...toScreen(150, 50) });

      expect(pathByData(ODD)).toBeDefined();
      expect(undoButton()).toBeDisabled();
      expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();

      clickAt(surface(), 120, 20);
      dragOnSurface([120, 20], [130, 30]);
      expect(pathByData(ODD)).toBeUndefined();
      expect(pathByData("M20 20 L130 30 L120 120 L20 120 Z")).toBeDefined();
      fireEvent.click(undoButton());
      expect(pathByData(ODD)).toBeDefined();
    });

    it("una cadena de ediciones se deshace paso a paso hasta el d original EXACTO, y se rehace igual", async () => {
      await open();
      enterPathOn(70, 70);
      const states = [SQ];
      clickAt(surface(), 120, 20);
      dragOnSurface([120, 20], [130, 20]);
      states.push("M20 20 L130 20 L120 120 L20 120 Z");
      fireEvent.doubleClick(surface(), toScreen(75, 20));
      states.push("M20 20 L75 20 L130 20 L120 120 L20 120 Z");
      clickAt(surface(), 20, 120);
      press("Delete");
      states.push("M20 20 L75 20 L130 20 L120 120 Z");
      expect(pathByData(states[states.length - 1])).toBeDefined();

      for (let step = states.length - 2; step >= 0; step -= 1) {
        fireEvent.click(undoButton());
        expect(pathByData(states[step])).toBeDefined();
      }
      expect(undoButton()).toBeDisabled();
      for (let step = 1; step < states.length; step += 1) {
        fireEvent.click(redoButton());
        expect(pathByData(states[step])).toBeDefined();
      }
      expect(redoButton()).toBeDisabled();
    });

    it("compound path: los subpaths conservan su orden y el hueco su sentido de giro tras editar el exterior", async () => {
      await open();
      enterPathOn(150, 50);
      clickAt(surface(), 140, 20);
      dragOnSurface([140, 20], [130, 10]);

      expect(pathByData("M130 10 L220 20 L220 80 L140 80 Z M160 35 L160 65 L200 35 Z")).toBeDefined();
    });
  });

  describe("StrictMode y rendimiento", () => {
    it("StrictMode (efectos dobles): entrar, arrastrar y deshacer sigue siendo UN comando", async () => {
      await open({ strict: true });
      enterPathOn(70, 70);
      dragOnSurface([120, 20], [130, 25]);

      expect(pathByData("M20 20 L130 25 L120 120 L20 120 Z")).toBeDefined();
      fireEvent.click(undoButton());
      expect(pathByData(SQ)).toBeDefined();
      expect(undoButton()).toBeDisabled();
    });

    it("un path de 5 000 nodos: el overlay dibuja un máximo acotado y avisa; mover un nodo visible es UN comando", async () => {
      const points = Array.from({ length: 5000 }, (_, index) => `${index === 0 ? "M" : "L"}${10 + index * 0.05} ${100 + (index % 2) * 10}`);
      const big = `${points.join(" ")} Z`;
      await open({ svg: { A: svg(red("big", big)), B: svg(), C: svg() }, minPaths: 1 });
      enterPathOn(10, 100);

      const rendered = anchors().length;
      expect(rendered).toBeGreaterThan(0);
      expect(rendered).toBeLessThanOrEqual(1500);
      expect(within(surface()).getByRole("status")).toHaveTextContent(/Mostrando\s+1.?500 de 5.?000 nodos en pantalla/);
      expect(inPanel().getByText(/· 5\.?000 nodos/)).toBeInTheDocument();

      dragOnSurface([10, 100], [10, 105]);
      await waitFor(() => expect(undoButton()).toBeEnabled());
      expect(pathData().some((d) => d.startsWith("M10 105 L10.05 110"))).toBe(true);
      fireEvent.click(undoButton());
      expect(pathData().some((d) => d.startsWith("M10 100 L10.05 110"))).toBe(true);
      expect(undoButton()).toBeDisabled();
    });
  });
});
