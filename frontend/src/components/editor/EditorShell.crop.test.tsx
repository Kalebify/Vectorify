import Konva from "konva";
import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { abortAwareFetch, svgResponse } from "../../test/abortableFetch";
import { EditorShell } from "./EditorShell";

/**
 * Integración de M3-S02 en el Workspace completo: Crop del área de trabajo (panel, marco sobre el canvas, resumen, Apply/Cancel,
 * undo atómico, re-centrado, mm) y Rotate 90° / Flip de la selección o del documento completo (previsualización sin tocar la pila de
 * undo, Apply/Cancel, rechazo con capas bloqueadas). Todos los `fetch` respetan AbortSignal (`abortAwareFetch`).
 */

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const IMAGE_ID = "22222222-2222-2222-2222-222222222222";
const PALETTE_ID = "33333333-3333-3333-3333-333333333333";
const GROUP_A_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const GROUP_B_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const VECTOR_A_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const VECTOR_B_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const LAYER_SET_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

// Documento 320×240 u (160×120 mm con dimensionWidthMm=160 -> 0.5 mm por unidad).
// Capa Rojo: r1 (0..40) y r2 (20..60, arriba). Capa Azul: b1 (100..140).
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

function consolidatedResponse(options: { lockedA?: boolean; visibleB?: boolean } = {}) {
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
      { id: GROUP_A_ID, name: "Rojo", colorHex: "#ff0000", fill: "#ff0000", vectorId: VECTOR_A_ID, svgUrl: `/vectors/${VECTOR_A_ID}`, pathCount: 2, componentCount: 1, manufacturingOperation: "cut", visible: true, locked: options.lockedA ?? false, order: 0, rasterValidation: validation },
      { id: GROUP_B_ID, name: "Azul", colorHex: "#0000ff", fill: "#0000ff", vectorId: VECTOR_B_ID, svgUrl: `/vectors/${VECTOR_B_ID}`, pathCount: 1, componentCount: null, manufacturingOperation: "unassigned", visible: options.visibleB ?? true, locked: false, order: 1, rasterValidation: validation },
    ],
  };
}

function installStagingFetch(options: { lockedA?: boolean; visibleB?: boolean } = {}) {
  const fetchMock = abortAwareFetch((url, init) => {
    // Desbloquear la capa Rojo / mostrar la capa Azul: la Web API devuelve el layout vigente tras el POST.
    if (init?.method === "POST" && (url.endsWith("/lock") || url.endsWith("/visibility"))) {
      return jsonResponse({
        entries: [
          { groupId: GROUP_A_ID, order: 0, visible: true, locked: false, name: null },
          { groupId: GROUP_B_ID, order: 1, visible: true, locked: false, name: null },
        ],
      });
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

async function renderLoadedShell(minPaths = 3) {
  const utils = render(<EditorShell projectId={PROJECT_ID} imageId={IMAGE_ID} paletteId={PALETTE_ID} projectName="mi-diseño.svg" dimensionWidthMm={160} onClose={vi.fn()} />);
  const canvas = await screen.findByRole("application");
  await waitFor(() => expect(Konva.stages[Konva.stages.length - 1]?.find("Path").length).toBeGreaterThanOrEqual(minPaths));
  return { ...utils, canvas };
}

const stage = () => Konva.stages[Konva.stages.length - 1];
const documentPaths = () => stage().getLayers()[0].find("Path") as Konva.Path[];
const cropRect = () => (stage().find(".crop-frame") as Konva.Rect[])[0];
const GEOMETRY_DIRTY = "Cambios de geometría sin guardar";

const toolButton = (name: RegExp) => screen.getByRole("button", { name });
const startCrop = () => fireEvent.click(toolButton(/^Crop/));
const cropField = (name: string) => screen.getByLabelText(name) as HTMLInputElement;
function typeCrop(label: string, value: string) {
  fireEvent.change(cropField(label), { target: { value } });
  fireEvent.keyDown(cropField(label), { key: "Enter" });
}
const summary = () => screen.getByRole("region", { name: "Qué se va a modificar" });
const zoomLabel = (percent: number) => screen.getByLabelText(`Zoom actual: ${percent}%`);

// Con escala 1 y contenedor 800×600 sobre un documento 320×240: pantalla = documento + (240, 180).
const toScreen = (x: number, y: number) => ({ clientX: x + 240, clientY: y + 180 });
function click(canvas: HTMLElement, x: number, y: number, options: { shiftKey?: boolean } = {}) {
  fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, ...toScreen(x, y), ...options });
  fireEvent.pointerUp(canvas, { pointerId: 1, ...toScreen(x, y), ...options });
}

describe("EditorShell — Crop del área de trabajo (M3-S02)", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ImmediateResizeObserver);
    installStagingFetch();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("Crop está habilitado: muestra el marco sobre el canvas (todo el área) y el panel con el resumen y Apply deshabilitado (sin cambios)", async () => {
    await renderLoadedShell();
    expect(toolButton(/^Crop/)).toBeEnabled();
    expect(screen.queryByRole("heading", { name: /Crop — área de trabajo/ })).not.toBeInTheDocument();

    startCrop();
    expect(await screen.findByRole("heading", { name: /Crop — área de trabajo/ })).toBeInTheDocument();
    expect(toolButton(/^Crop/)).toHaveAttribute("aria-pressed", "true");
    expect([cropRect().x(), cropRect().y(), cropRect().width(), cropRect().height()]).toEqual([0, 0, 320, 240]);
    expect(within(summary()).getByText("Área de trabajo: 160 × 120 mm → 160 × 120 mm")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(cropField("Ancho del recorte (mm)")).toHaveValue("160");
  });

  it("el resumen en vivo cambia con el marco: 'N objetos cruzan el borde; seguirán completos (Intersect, M3-S08)'", async () => {
    await renderLoadedShell();
    startCrop();
    typeCrop("Ancho del recorte (mm)", "60"); // 120 u: b1 (100..140) cruza el borde
    typeCrop("Alto del recorte (mm)", "60");
    expect(within(summary()).getByText("Área de trabajo: 160 × 120 mm → 60 × 60 mm")).toBeInTheDocument();
    expect(within(summary()).getByText("1 objeto cruza el borde; seguirá completo (recorte exacto: operación Intersect, M3-S08).")).toBeInTheDocument();
    expect(within(summary()).getByText("No se eliminará ningún objeto.")).toBeInTheDocument();
    // El marco del canvas sigue al panel (la misma fuente de verdad).
    expect([cropRect().width(), cropRect().height()]).toEqual([120, 120]);
  });

  it("Apply: UN comando; las dimensiones mm cambian, el documento se re-centra, los objetos que cruzan el borde se conservan COMPLETOS y mantienen su tamaño real en mm", async () => {
    const { canvas } = await renderLoadedShell();
    click(canvas, 120, 120); // b1: 20×20 mm
    expect(await screen.findByLabelText("Ancho (mm)")).toHaveValue("20");
    expect(screen.getByText("160 × 120 mm")).toBeInTheDocument();
    expect(zoomLabel(100)).toBeInTheDocument();

    startCrop();
    typeCrop("Ancho del recorte (mm)", "60");
    typeCrop("Alto del recorte (mm)", "60");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    // Marco nuevo: 60×60 mm = 120×120 u. Vuelve a Select, sin panel de Crop.
    expect(await screen.findByText("60 × 60 mm")).toBeInTheDocument();
    expect(screen.getByText("120 × 120 px")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Crop — área de trabajo/ })).not.toBeInTheDocument();
    expect(toolButton(/^Select/)).toHaveAttribute("aria-pressed", "true");
    // Re-centrado: se ajusta el nuevo área (min(800/120, 600/120) = 5 -> 500%) y se centra en su centro (60, 60).
    expect(zoomLabel(500)).toBeInTheDocument();
    expect(stage().getLayers()[0].offsetX()).toBe(60);
    expect(stage().getLayers()[0].offsetY()).toBe(60);
    // El cambio es UN comando con etiqueta clara, y el header dice la verdad.
    expect(screen.getByRole("button", { name: "Deshacer: Recortar el área de trabajo a 60 × 60 mm" })).toBeEnabled();
    expect(screen.getByText(GEOMETRY_DIRTY)).toBeInTheDocument();
    expect(screen.getByText(/Área de trabajo recortada a 60 × 60 mm\. 1 objeto cruza el borde y sigue completo\./)).toBeInTheDocument();
    // Nada se recortó en silencio: los 3 objetos siguen, con la misma geometría.
    expect(documentPaths().map((node) => node.data())).toEqual(["M0 0 H40 V40 H0 Z", "M20 20 H60 V60 H20 Z", "M100 100 H140 V140 H100 Z"]);
    // La escala física se conservó: b1 sigue midiendo 20 mm de ancho (el objeto que cruza el borde, completo).
    fireEvent.keyDown(canvas, { key: "Escape" }); // limpia la selección para comprobar el hit-testing sobre el marco nuevo
    expect(screen.queryByRole("heading", { name: "Objeto" })).not.toBeInTheDocument();
    fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, clientX: 650, clientY: 550 }); // doc (110,110) a escala 5 centrada en (60,60)
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 650, clientY: 550 });
    await waitFor(() => expect(screen.getByLabelText("Ancho (mm)")).toHaveValue("20"));
  });

  it("Undo restaura marco, dimensiones, objetos y re-centrado exactos; Redo los reaplica (un solo comando)", async () => {
    await renderLoadedShell();
    startCrop();
    typeCrop("Ancho del recorte (mm)", "30"); // 60 u
    typeCrop("Alto del recorte (mm)", "30");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await screen.findByText("30 × 30 mm");
    expect(documentPaths()).toHaveLength(2); // b1 (fuera) se eliminó junto con el cambio de marco

    fireEvent.click(screen.getByRole("button", { name: /^Deshacer: Recortar/ }));
    await screen.findByText("160 × 120 mm");
    expect(screen.getByText("320 × 240 px")).toBeInTheDocument();
    expect(documentPaths()).toHaveLength(3); // el objeto vuelve CON el marco, en el mismo undo
    expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deshacer" })).toBeDisabled();
    expect(zoomLabel(250)).toBeInTheDocument(); // min(800/320, 600/240) = 2.5
    expect(stage().getLayers()[0].offsetX()).toBe(160);

    fireEvent.click(screen.getByRole("button", { name: /^Rehacer: Recortar/ }));
    await screen.findByText("30 × 30 mm");
    expect(documentPaths()).toHaveLength(2);
    expect(screen.getByText(GEOMETRY_DIRTY)).toBeInTheDocument();
  });

  it("'Eliminar objetos fuera del área' (marcada por defecto): se eliminan SOLO los totalmente fuera; desmarcada, se conservan", async () => {
    await renderLoadedShell();
    startCrop();
    typeCrop("Ancho del recorte (mm)", "30"); // 60 u: r1 y r2 adentro, b1 afuera
    typeCrop("Alto del recorte (mm)", "30");
    expect(screen.getByRole("checkbox", { name: /Eliminar objetos fuera del área/ })).toBeChecked();
    expect(within(summary()).getByText("1 objeto se eliminará.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: /Eliminar objetos fuera del área/ }));
    expect(within(summary()).getByText("No se eliminará ningún objeto (1 queda fuera del área).")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await screen.findByText("30 × 30 mm");
    expect(documentPaths()).toHaveLength(3); // nada se eliminó

    // Y marcada: elimina (con la verificación del aviso).
    fireEvent.click(screen.getByRole("button", { name: /^Deshacer: Recortar/ }));
    await screen.findByText("160 × 120 mm");
    startCrop();
    // La opción es del usuario y se recuerda entre recortes: sigue desmarcada hasta que la vuelva a marcar.
    expect(screen.getByRole("checkbox", { name: /Eliminar objetos fuera del área/ })).not.toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: /Eliminar objetos fuera del área/ }));
    typeCrop("Ancho del recorte (mm)", "30");
    typeCrop("Alto del recorte (mm)", "30");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await screen.findByText("30 × 30 mm");
    expect(documentPaths()).toHaveLength(2);
    expect(screen.getByText(/1 objeto eliminado\./)).toBeInTheDocument();
  });

  it("capa BLOQUEADA: sus objetos fuera del área NO se eliminan (el resumen lo dice y el aviso informa cuántos se conservaron)", async () => {
    installStagingFetch({ lockedA: true });
    await renderLoadedShell();
    startCrop();
    typeCrop("X del recorte (mm)", "50"); // x = 100 u
    typeCrop("Y del recorte (mm)", "50");
    typeCrop("Ancho del recorte (mm)", "40"); // 80 u -> b1 (100..140) adentro; r1 y r2 (bloqueados) afuera
    typeCrop("Alto del recorte (mm)", "40");
    expect(within(summary()).getByText("2 objetos están en capas bloqueadas y no se eliminan.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await screen.findByText("40 × 40 mm");
    expect(documentPaths()).toHaveLength(3);
    expect(screen.getByText(/2 objetos en capas bloqueadas se conservaron/)).toBeInTheDocument();
  });

  it("Cancel (botón) y Escape descartan el recorte sin dejar rastro: ni comando, ni geometría sin guardar, ni cambio de marco", async () => {
    const { canvas } = await renderLoadedShell();
    startCrop();
    typeCrop("Ancho del recorte (mm)", "30");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("heading", { name: /Crop — área de trabajo/ })).not.toBeInTheDocument();
    expect(toolButton(/^Select/)).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Deshacer" })).toBeDisabled();
    expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();
    expect(screen.getByText("160 × 120 mm")).toBeInTheDocument();

    startCrop();
    expect(cropField("Ancho del recorte (mm)")).toHaveValue("160"); // vuelve a empezar desde el área vigente, no desde el borrador viejo
    typeCrop("Ancho del recorte (mm)", "30");
    fireEvent.keyDown(canvas, { key: "Escape" });
    expect(screen.queryByRole("heading", { name: /Crop — área de trabajo/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deshacer" })).toBeDisabled();
    expect(screen.getByText("160 × 120 mm")).toBeInTheDocument();
  });

  it("Enter aplica el recorte (con el foco en el canvas); Enter DENTRO de un campo solo confirma el campo", async () => {
    const { canvas } = await renderLoadedShell();
    startCrop();
    typeCrop("Ancho del recorte (mm)", "100"); // Enter en el campo
    expect(screen.getByRole("heading", { name: /Crop — área de trabajo/ })).toBeInTheDocument(); // no aplicó
    expect(screen.getByRole("button", { name: "Deshacer" })).toBeDisabled();

    fireEvent.keyDown(canvas, { key: "Enter" });
    await screen.findByText("100 × 120 mm");
    expect(screen.queryByRole("heading", { name: /Crop — área de trabajo/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Deshacer: Recortar/ })).toBeEnabled();
  });

  it("valores inválidos se rechazan con mensaje y no cambian el marco; Apply no se habilita con un marco sin cambios", async () => {
    await renderLoadedShell();
    startCrop();
    typeCrop("Ancho del recorte (mm)", "0");
    expect(screen.getByRole("alert")).toHaveTextContent(/mayor que 0/);
    typeCrop("Alto del recorte (mm)", "abc");
    expect(screen.getByRole("alert")).toHaveTextContent(/no es un número válido/);
    typeCrop("X del recorte (mm)", "999999999");
    expect(screen.getByRole("alert")).toHaveTextContent(/fuera de rango/);
    expect([cropRect().width(), cropRect().height()]).toEqual([320, 240]);
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  });

  it("marco fuera de límites razonables (pasa el campo pero no la validación del marco): mensaje y el marco anterior se conserva", async () => {
    await renderLoadedShell();
    startCrop();
    typeCrop("Ancho del recorte (mm)", "900000"); // 1 800 000 u > 1 000 000
    expect(screen.getByRole("alert")).toHaveTextContent(/límite razonable/);
    expect(cropRect().width()).toBe(320);
  });

  it("presets: 1:1, 'Ajustar al contenido' y 'Restablecer' (valores calculados a mano)", async () => {
    await renderLoadedShell();
    startCrop();
    fireEvent.click(screen.getByRole("button", { name: "1:1" })); // el cuadrado más grande centrado en 320×240: 240×240 en x = 40
    expect(cropField("X del recorte (mm)")).toHaveValue("20");
    expect(cropField("Y del recorte (mm)")).toHaveValue("0");
    expect(cropField("Ancho del recorte (mm)")).toHaveValue("120");
    expect(cropField("Alto del recorte (mm)")).toHaveValue("120");

    fireEvent.click(screen.getByRole("button", { name: "Ajustar al contenido" })); // bbox del contenido: 0..140 × 0..140
    expect(cropField("X del recorte (mm)")).toHaveValue("0");
    expect(cropField("Ancho del recorte (mm)")).toHaveValue("70");
    expect(cropField("Alto del recorte (mm)")).toHaveValue("70");

    fireEvent.click(screen.getByRole("button", { name: "16:9" }));
    expect(cropField("Ancho del recorte (mm)")).toHaveValue("160"); // el ancho completo: 160 mm x 90 mm
    expect(cropField("Alto del recorte (mm)")).toHaveValue("90");

    fireEvent.click(screen.getByRole("button", { name: "Restablecer" }));
    expect(cropField("Ancho del recorte (mm)")).toHaveValue("160");
    expect(cropField("Alto del recorte (mm)")).toHaveValue("120");
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  });

  it("bloqueo de proporción: editar el ancho deriva el alto (160 mm x 120 mm -> ancho 80 mm = alto 60 mm)", async () => {
    await renderLoadedShell();
    startCrop();
    fireEvent.click(screen.getByRole("checkbox", { name: /Bloquear proporción/ }));
    typeCrop("Ancho del recorte (mm)", "80");
    expect(cropField("Alto del recorte (mm)")).toHaveValue("60");
    // Y el Transformer del canvas respeta el bloqueo.
    await waitFor(() => expect((stage().find("Transformer") as Konva.Transformer[]).some((transformer) => transformer.keepRatio())).toBe(true));
  });

  it("arrastrar/redimensionar el marco sobre el canvas actualiza el panel y el resumen (misma fuente de verdad)", async () => {
    await renderLoadedShell();
    startCrop();
    const rect = cropRect();
    rect.x(40);
    rect.y(20);
    rect.scaleX(0.5);
    rect.scaleY(0.5);
    rect.fire("transform");
    await waitFor(() => expect(cropField("Ancho del recorte (mm)")).toHaveValue("80"));
    expect(cropField("Alto del recorte (mm)")).toHaveValue("60");
    expect(cropField("X del recorte (mm)")).toHaveValue("20");
    expect(within(summary()).getByText("Área de trabajo: 160 × 120 mm → 80 × 60 mm")).toBeInTheDocument();
    // Marco (40,20)-(200,140): r1 (0..40) queda afuera (solo toca el borde), r2 cruza, b1 (100..140) queda adentro.
    expect(within(summary()).getByText("1 objeto se eliminará.")).toBeInTheDocument();
    expect(within(summary()).getByText(/1 objeto cruza el borde/)).toBeInTheDocument();
  });

  it("las flechas con el foco en el canvas mueven el marco de recorte (1 unidad = 0.5 mm; Shift 10 unidades)", async () => {
    const { canvas } = await renderLoadedShell();
    startCrop();
    fireEvent.keyDown(canvas, { key: "ArrowRight" });
    fireEvent.keyDown(canvas, { key: "ArrowDown", shiftKey: true });
    await waitFor(() => expect(cropField("X del recorte (mm)")).toHaveValue("0.5"));
    expect(cropField("Y del recorte (mm)")).toHaveValue("5");
    expect(screen.getByRole("button", { name: "Deshacer" })).toBeDisabled();
  });

  it("durante Crop el Inspector de objetos y la edición de objetos quedan suspendidos; al volver a Select regresan", async () => {
    const { canvas } = await renderLoadedShell();
    click(canvas, 120, 120);
    expect(await screen.findByRole("heading", { name: "Objeto" })).toBeInTheDocument();

    startCrop();
    expect(screen.queryByRole("heading", { name: "Objeto" })).not.toBeInTheDocument();
    fireEvent.keyDown(canvas, { key: "Delete" });
    expect(documentPaths()).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Deshacer" })).toBeDisabled();

    fireEvent.click(toolButton(/^Select/));
    expect(screen.queryByRole("heading", { name: /Crop — área de trabajo/ })).not.toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Objeto" })).toBeInTheDocument();
  });

  it("cambiar de herramienta durante Crop lo cancela sin rastro", async () => {
    await renderLoadedShell();
    startCrop();
    typeCrop("Ancho del recorte (mm)", "30");
    fireEvent.click(toolButton(/^Pan/));
    expect(screen.queryByRole("heading", { name: /Crop — área de trabajo/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deshacer" })).toBeDisabled();
    expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();
    expect(stage().find(".crop-frame")).toHaveLength(0);
  });

  it("la miniatura (Preview) muestra el área recortada: TODAS las capas se dibujan desde memoria con el viewBox del marco y vuelven al original al deshacer", async () => {
    const { container } = await renderLoadedShell();
    const previewSources = () => Array.from(container.querySelectorAll(".preview-navigator__layer")).map((image) => image.getAttribute("src") ?? "");
    expect(previewSources().every((src) => src.includes("/vectors/"))).toBe(true);

    startCrop();
    typeCrop("Ancho del recorte (mm)", "60");
    typeCrop("Alto del recorte (mm)", "60");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(previewSources().every((src) => src.startsWith("data:image/svg+xml"))).toBe(true));
    for (const src of previewSources()) expect(decodeURIComponent(src)).toContain('viewBox="0 0 120 120"');
    expect(screen.getByRole("img", { name: /Miniatura/ })).toHaveStyle({ aspectRatio: "120 / 120" });

    fireEvent.click(screen.getByRole("button", { name: /^Deshacer: Recortar/ }));
    await waitFor(() => expect(previewSources().every((src) => src.includes("/vectors/"))).toBe(true));
  });

  it("beforeunload avisa mientras el recorte esté sin persistir (honestidad de guardado: hasta M3-S13 vive en memoria)", async () => {
    await renderLoadedShell();
    const unload = () => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(unload()).toBe(false);
    startCrop();
    typeCrop("Ancho del recorte (mm)", "100");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await screen.findByText(GEOMETRY_DIRTY);
    expect(unload()).toBe(true);
    expect(screen.queryByText("Guardado")).not.toBeInTheDocument();
  });

  it("React StrictMode (efectos dobles + cargas abortadas): Crop, Apply y Undo funcionan igual", async () => {
    const fetchMock = installStagingFetch();
    render(
      <StrictMode>
        <EditorShell projectId={PROJECT_ID} imageId={IMAGE_ID} paletteId={PALETTE_ID} projectName="x.svg" dimensionWidthMm={160} onClose={vi.fn()} />
      </StrictMode>,
    );
    await screen.findByRole("application");
    await waitFor(() => expect(Konva.stages[Konva.stages.length - 1]?.find("Path").length).toBeGreaterThanOrEqual(3));
    expect(fetchMock.signals.some((signal) => signal?.aborted)).toBe(true);

    startCrop();
    typeCrop("Ancho del recorte (mm)", "30");
    typeCrop("Alto del recorte (mm)", "30");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await screen.findByText("30 × 30 mm");
    fireEvent.click(screen.getByRole("button", { name: /^Deshacer: Recortar/ }));
    await screen.findByText("160 × 120 mm");
    expect(documentPaths()).toHaveLength(3);
  });
});

describe("EditorShell — Rotate 90° / Flip (M3-S02)", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ImmediateResizeObserver);
    installStagingFetch();
  });
  afterEach(() => vi.unstubAllGlobals());

  const rotateCw = () => fireEvent.click(screen.getByRole("button", { name: "Rotar 90° horario" }));
  const flipH = () => fireEvent.click(screen.getByRole("button", { name: "Reflejar horizontalmente" }));
  const barStatus = () => within(screen.getByRole("toolbar", { name: "Rotar y reflejar" })).getByRole("status");

  it("la barra contextual es visible con Select y Move y dice el ALCANCE antes de actuar (sin selección = TODO el documento)", async () => {
    const { canvas } = await renderLoadedShell();
    expect(screen.getByRole("toolbar", { name: "Rotar y reflejar" })).toBeInTheDocument();
    expect(barStatus()).toHaveTextContent("Sin selección: rotar y reflejar afectan a TODO el documento.");

    click(canvas, 10, 10);
    await waitFor(() => expect(barStatus()).toHaveTextContent("Rotar y reflejar afectan a la selección (1 objeto)."));

    fireEvent.click(toolButton(/^Move/));
    expect(screen.getByRole("toolbar", { name: "Rotar y reflejar" })).toBeInTheDocument();
    fireEvent.click(toolButton(/^Pan/));
    expect(screen.queryByRole("toolbar", { name: "Rotar y reflejar" })).not.toBeInTheDocument();
  });

  it("DOCUMENTO: rotar muestra la previsualización SIN llenar la pila de undo y pide Apply/Cancel; el texto dice 'Se rotará TODO el documento'", async () => {
    await renderLoadedShell();
    rotateCw();

    expect(barStatus()).toHaveTextContent("Se rotará TODO el documento: Rotar 90° horario.");
    expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    // Previsualización: la pila de undo sigue vacía y no hay geometría sin guardar (nada está confirmado).
    expect(screen.getByRole("button", { name: "Deshacer" })).toBeDisabled();
    expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();
    // La vista SÍ muestra el resultado: 160×120 mm -> 120×160 mm.
    expect(screen.getByText("120 × 160 mm")).toBeInTheDocument();
    const outline = (stage().find(".document-frame") as Konva.Rect[])[0];
    expect([outline.x(), outline.y(), outline.width(), outline.height()]).toEqual([40, -40, 240, 320]); // la hoja ya se ve rotada
  });

  it("DOCUMENTO: Cancel no deja rastro (marco, objetos, pila, indicador de guardado, miniatura)", async () => {
    const { container } = await renderLoadedShell();
    const before = documentPaths().map((node) => [node.x(), node.y(), node.rotation()]);
    rotateCw();
    flipH();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
    expect(barStatus()).toHaveTextContent("TODO el documento");
    expect(screen.getByText("160 × 120 mm")).toBeInTheDocument();
    expect(documentPaths().map((node) => [node.x(), node.y(), node.rotation()])).toEqual(before);
    expect(screen.getByRole("button", { name: "Deshacer" })).toBeDisabled();
    expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();
    expect(Array.from(container.querySelectorAll(".preview-navigator__layer")).every((image) => (image.getAttribute("src") ?? "").includes("/vectors/"))).toBe(true);
  });

  it("DOCUMENTO: Apply = UN comando (objetos + marco); Undo/Redo lo revierten/reaplican juntos y la vista se re-centra", async () => {
    const { canvas } = await renderLoadedShell();
    rotateCw();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(await screen.findByRole("button", { name: "Deshacer: Rotar 90° horario (documento completo)" })).toBeEnabled();
    expect(screen.getByText("120 × 160 mm")).toBeInTheDocument();
    expect(screen.getByText("240 × 320 px")).toBeInTheDocument();
    expect(screen.getByText(GEOMETRY_DIRTY)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
    expect(zoomLabel(188)).toBeInTheDocument(); // min(800/240, 600/320) = 1.875
    expect(screen.getByText(/Rotar 90° horario \(documento completo\) aplicado\./)).toBeInTheDocument();

    // El hit-testing sigue al marco rotado: b1 pasó a (140..180, 60..100) -> centro (160, 80), y el centro del documento es (160,120).
    // A escala 1.875: pantalla = (400, 300 + (80 - 120) * 1.875) = (400, 225).
    fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, clientX: 400, clientY: 225 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 400, clientY: 225 });
    expect(await screen.findByLabelText("X (mm)")).toHaveValue("70"); // 140 u * 0.5
    expect(screen.getByLabelText("Y (mm)")).toHaveValue("30"); // 60 u * 0.5
    expect(screen.getByLabelText("Ancho (mm)")).toHaveValue("20");

    fireEvent.click(screen.getByRole("button", { name: "Deshacer: Rotar 90° horario (documento completo)" }));
    await screen.findByText("160 × 120 mm");
    expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();
    expect(screen.getByLabelText("X (mm)")).toHaveValue("50"); // b1 vuelve a su lugar (100 u * 0.5)
    expect(zoomLabel(250)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Rehacer: Rotar 90° horario/ }));
    await screen.findByText("120 × 160 mm");
    expect(screen.getByLabelText("X (mm)")).toHaveValue("70");
  });

  it("repetir pasos antes de Apply compone sobre el original: 4 giros = 'Sin cambios' y Apply deshabilitado (sin error acumulado)", async () => {
    await renderLoadedShell();
    for (let turn = 0; turn < 4; turn += 1) rotateCw();
    expect(barStatus()).toHaveTextContent("Sin cambios respecto del estado actual.");
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(screen.getByText("160 × 120 mm")).toBeInTheDocument();
    // Un giro más y vuelve a haber algo que aplicar.
    rotateCw();
    expect(barStatus()).toHaveTextContent("Se rotará TODO el documento: Rotar 90° horario.");
    expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled();
  });

  it("dos reflejos = 'Sin cambios'; girar + reflejar describe la combinación en el resumen", async () => {
    await renderLoadedShell();
    flipH();
    expect(barStatus()).toHaveTextContent("Se reflejará TODO el documento: Reflejar horizontalmente.");
    flipH();
    expect(barStatus()).toHaveTextContent("Sin cambios respecto del estado actual.");
    rotateCw();
    flipH();
    expect(barStatus()).toHaveTextContent("Se transformará TODO el documento: Reflejar horizontalmente y rotar 90° antihorario.");
  });

  it("APPLY cierra el ciclo de repetición: tras confirmar, un nuevo giro es OTRO comando y 4 giros aplicados de a uno vuelven al marco original", async () => {
    await renderLoadedShell();
    for (let turn = 0; turn < 4; turn += 1) {
      rotateCw();
      fireEvent.click(screen.getByRole("button", { name: "Apply" }));
      await waitFor(() => expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument());
    }
    expect(screen.getByText("160 × 120 mm")).toBeInTheDocument();
    expect(screen.getByText("320 × 240 px")).toBeInTheDocument();
    // 4 comandos, cada uno deshacible: 4 undos y el documento vuelve a estar "sin cambios".
    for (let step = 0; step < 4; step += 1) {
      fireEvent.click(screen.getByRole("button", { name: /^Deshacer: Rotar 90° horario/ }));
    }
    expect(screen.getByRole("button", { name: "Deshacer" })).toBeDisabled();
    expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();
  });

  it("SELECCIÓN: se rota/refleja el GRUPO alrededor del centro de su bbox; el marco no cambia y el texto dice 'la selección (N objetos)'", async () => {
    const { canvas } = await renderLoadedShell();
    click(canvas, 10, 10); // r1 (Rojo, 0..40)
    click(canvas, 120, 120, { shiftKey: true }); // + b1 (Azul, 100..140)
    await screen.findByRole("heading", { name: "Varios (2 objetos)" });

    flipH(); // el bbox del grupo es 0..140: x' = 140 - x
    expect(barStatus()).toHaveTextContent("Se reflejará la selección (2 objetos): Reflejar horizontalmente.");
    expect(screen.getByRole("button", { name: "Deshacer" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(await screen.findByRole("button", { name: "Deshacer: Reflejar horizontalmente (2 objetos)" })).toBeEnabled();
    expect(screen.getByText("160 × 120 mm")).toBeInTheDocument(); // el marco NO cambió
    expect(zoomLabel(100)).toBeInTheDocument(); // y la vista no se re-centró
    // El grupo se espejó: r1 (0..40) pasó a 100..140 -> X = 50 mm; b1 (100..140) pasó a 0..40 -> X = 0 mm.
    click(canvas, 120, 20); // r1 ahora está en x 100..140, y 0..40
    await waitFor(() => expect(screen.getByLabelText("X (mm)")).toHaveValue("50"));
  });

  it("SELECCIÓN: Cancel descarta y la selección sigue ahí; Enter aplica con el foco en el canvas; los atajos R/F componen pasos", async () => {
    const { canvas } = await renderLoadedShell();
    click(canvas, 120, 120); // b1
    await screen.findByRole("heading", { name: "Objeto" });

    fireEvent.keyDown(canvas, { key: "r" });
    expect(barStatus()).toHaveTextContent("Se rotará la selección (1 objeto): Rotar 90° horario.");
    fireEvent.keyDown(canvas, { key: "R", shiftKey: true });
    expect(barStatus()).toHaveTextContent("Sin cambios respecto del estado actual.");
    fireEvent.keyDown(canvas, { key: "F", shiftKey: true });
    expect(barStatus()).toHaveTextContent("Se reflejará la selección (1 objeto): Reflejar verticalmente.");
    fireEvent.keyDown(canvas, { key: "Escape" });
    expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Objeto" })).toBeInTheDocument(); // Escape cancela la transformación, NO limpia la selección
    expect(screen.getByRole("button", { name: "Deshacer" })).toBeDisabled();

    fireEvent.keyDown(canvas, { key: "r" });
    fireEvent.keyDown(canvas, { key: "Enter" });
    expect(await screen.findByRole("button", { name: "Deshacer: Rotar 90° horario (1 objeto)" })).toBeEnabled();
  });

  it("mientras hay una transformación pendiente el canvas NO edita (click, arrastre) y el Inspector avisa en vez de aplicar a ciegas", async () => {
    const { canvas } = await renderLoadedShell();
    click(canvas, 120, 120); // b1
    await screen.findByRole("heading", { name: "Objeto" });
    rotateCw();

    click(canvas, 10, 10); // sobre r1: la selección NO cambia durante la previsualización
    expect(screen.getByLabelText("Ancho (mm)")).toBeInTheDocument();
    expect(barStatus()).toHaveTextContent("la selección (1 objeto)");

    fireEvent.change(screen.getByLabelText("Ancho (mm)"), { target: { value: "30" } });
    fireEvent.keyDown(screen.getByLabelText("Ancho (mm)"), { key: "Enter" });
    expect(await screen.findByText(/Hay una transformación pendiente/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deshacer" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Deshacer" })).toBeDisabled();
  });

  it("cambiar de herramienta con una transformación pendiente la cancela sin rastro", async () => {
    await renderLoadedShell();
    rotateCw();
    expect(screen.getByRole("button", { name: "Apply" })).toBeInTheDocument();
    fireEvent.click(toolButton(/^Pan/));
    expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
    expect(screen.getByText("160 × 120 mm")).toBeInTheDocument();
    expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deshacer" })).toBeDisabled();
  });

  it("DOCUMENTO con una capa BLOQUEADA: rechazo claro, no hay previsualización y nada se transforma a medias", async () => {
    installStagingFetch({ lockedA: true });
    await renderLoadedShell();
    const before = documentPaths().map((node) => [node.x(), node.y(), node.rotation()]);

    rotateCw();
    expect(screen.getByRole("alert")).toHaveTextContent("Desbloqueá las capas para transformar el documento completo, o seleccioná objetos.");
    expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
    expect(screen.getByText("160 × 120 mm")).toBeInTheDocument();
    expect(documentPaths().map((node) => [node.x(), node.y(), node.rotation()])).toEqual(before);
    expect(screen.getByRole("button", { name: "Deshacer" })).toBeDisabled();
    expect(screen.queryByText(GEOMETRY_DIRTY)).not.toBeInTheDocument();

    // Reflejar también se rechaza; y al desbloquear la capa funciona.
    flipH();
    expect(screen.getByRole("alert")).toHaveTextContent("Desbloqueá las capas");
    fireEvent.click(screen.getByRole("button", { name: "Desbloquear la capa Rojo" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Bloquear la capa Rojo" })).toBeInTheDocument());
    rotateCw();
    expect(barStatus()).toHaveTextContent("Se rotará TODO el documento");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("SELECCIÓN solo en capas bloqueadas: rechazo claro y sin previsualización", async () => {
    installStagingFetch({ lockedA: true });
    const { canvas } = await renderLoadedShell();
    click(canvas, 10, 10); // r1 (bloqueado)
    await screen.findByRole("heading", { name: "Objeto" });
    rotateCw();
    expect(screen.getByRole("alert")).toHaveTextContent("La selección está en capas bloqueadas");
    expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deshacer" })).toBeDisabled();
  });

  it("SELECCIÓN mixta (bloqueado + libre): solo se transforma lo libre y el resumen lo informa", async () => {
    installStagingFetch({ lockedA: true });
    const { canvas } = await renderLoadedShell();
    click(canvas, 10, 10); // r1 (Rojo, bloqueado)
    click(canvas, 120, 120, { shiftKey: true }); // b1 (Azul, libre)
    await screen.findByRole("heading", { name: "Varios (2 objetos)" });

    rotateCw();
    expect(barStatus()).toHaveTextContent("Se rotará la selección (1 objeto): Rotar 90° horario. 1 objeto está en capas bloqueadas y no se modificará.");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByRole("button", { name: "Deshacer: Rotar 90° horario (1 objeto)" })).toBeEnabled();
  });

  it("DOCUMENTO con una capa OCULTA: se transforma igual (no queda descolocada respecto del marco)", async () => {
    installStagingFetch({ visibleB: false });
    await renderLoadedShell(2);
    rotateCw();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await screen.findByText("120 × 160 mm");

    // Al mostrar la capa Azul, b1 ya está rotado junto con el resto del documento (x 140..180, y 60..100).
    fireEvent.click(screen.getByRole("button", { name: "Mostrar la capa Azul" }));
    await waitFor(() => expect(documentPaths()).toHaveLength(3));
    const blue = documentPaths().find((node) => node.data() === "M100 100 H140 V140 H100 Z")!;
    expect(blue.rotation()).toBeCloseTo(90, 9);
  });

  it("el marco rotado se refleja en la miniatura (todas las capas con el viewBox del marco)", async () => {
    const { container } = await renderLoadedShell();
    rotateCw();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => {
      const sources = Array.from(container.querySelectorAll(".preview-navigator__layer")).map((image) => image.getAttribute("src") ?? "");
      expect(sources.every((src) => src.startsWith("data:image/svg+xml"))).toBe(true);
      for (const src of sources) expect(decodeURIComponent(src)).toContain('viewBox="40 -40 240 320"');
    });
  });

  it("React StrictMode: previsualizar, cancelar y aplicar funcionan con la doble ejecución de efectos", async () => {
    installStagingFetch();
    render(
      <StrictMode>
        <EditorShell projectId={PROJECT_ID} imageId={IMAGE_ID} paletteId={PALETTE_ID} projectName="x.svg" dimensionWidthMm={160} onClose={vi.fn()} />
      </StrictMode>,
    );
    await screen.findByRole("application");
    await waitFor(() => expect(Konva.stages[Konva.stages.length - 1]?.find("Path").length).toBeGreaterThanOrEqual(3));

    rotateCw();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Deshacer" })).toBeDisabled();
    rotateCw();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByRole("button", { name: "Deshacer: Rotar 90° horario (documento completo)" })).toBeEnabled();
  });
});
