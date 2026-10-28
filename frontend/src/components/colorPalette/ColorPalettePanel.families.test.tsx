import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ColorPalettePanel } from "./ColorPalettePanel";

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const IMAGE_ID = "22222222-2222-2222-2222-222222222222";
const PALETTE_ID = "33333333-3333-3333-3333-333333333333";
const BASE = `/api/v1/projects/${PROJECT_ID}/images/${IMAGE_ID}/color-palette/${PALETTE_ID}`;

function group(id: string, name: string, colorHex: string, overrides: Record<string, unknown> = {}) {
  return {
    groupId: id,
    name,
    colorHex,
    rgb: { r: 0, g: 0, b: 0 },
    pixelCount: 100,
    areaPercent: 30,
    hasPartialAlpha: false,
    isExcluded: false,
    maskUrl: `${BASE}/groups/${id}/mask`,
    isMerged: false,
    ...overrides,
  };
}

function familiesPalette(overrides: Record<string, unknown> = {}) {
  return {
    projectId: PROJECT_ID,
    imageId: IMAGE_ID,
    paletteId: PALETTE_ID,
    version: 1,
    tolerance: 12,
    maxColors: null,
    tinyAreaRatio: 0.001,
    sourceWidthPx: 10,
    sourceHeightPx: 10,
    transparentPercent: 0,
    groups: [
      group("g1", "Familia 1", "#c8551f", { pieceCount: 7, sourceGroupCount: 11, areaPercent: 25 }),
      group("g2", "Familia 2", "#bea90e", { pieceCount: 3, sourceGroupCount: 9, areaPercent: 10 }),
      group("g3", "Fondo", "#ffffff", { isBackground: true, isExcluded: true, pieceCount: 1, areaPercent: 65 }),
    ],
    previewUrl: `${BASE}/preview`,
    isConfirmed: false,
    cached: false,
    groupingStyle: "base_colors",
    targetFamilies: null,
    groupingStrength: 0.5,
    algorithmVersion: 1,
    familyCount: 2,
    pieceCount: 10,
    background: { areaPercent: 65, ambiguousPercent: 0.04, contactPercent: 3.4, needsReview: true },
    ...overrides,
  };
}

function respond(body: unknown) {
  return new Response(JSON.stringify(body), { status: 201, headers: { "Content-Type": "application/json" } });
}

function renderPanel() {
  return render(
    <ColorPalettePanel
      projectId={PROJECT_ID}
      imageId={IMAGE_ID}
      fileName="pato.png"
      originalUrl={`/api/v1/projects/${PROJECT_ID}/images/${IMAGE_ID}/original`}
      originalWidth={10}
      originalHeight={10}
    />,
  );
}

function lastBody(fetch: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = fetch.mock.calls[fetch.mock.calls.length - 1] as [RequestInfo | URL, RequestInit];
  return JSON.parse(String(call[1].body)) as Record<string, unknown>;
}

afterEach(() => vi.unstubAllGlobals());

describe("ColorPalettePanel — estilo de agrupación (CA-01)", () => {
  it("propone 'Colores base' como opción recomendada y marcada para detecciones nuevas", () => {
    vi.stubGlobal("fetch", vi.fn());

    renderPanel();

    const baseColors = screen.getByRole("radio", { name: /Colores base/ });
    const detailed = screen.getByRole("radio", { name: /Conservar tonos y sombras/ });
    expect(baseColors).toBeChecked();
    expect(detailed).not.toBeChecked();
    expect(screen.getByText(/Recomendado/)).toBeInTheDocument();
    expect(screen.getByText(/una sola capa por familia/i)).toBeInTheDocument();
    expect(screen.getByText(/cada tono detectado como grupo independiente/i)).toBeInTheDocument();
  });

  it("detecta con el estilo base por defecto, objetivo automático e intensidad 0,5", async () => {
    const fetch = vi.fn(() => Promise.resolve(respond(familiesPalette())));
    vi.stubGlobal("fetch", fetch);
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Detectar paleta" }));

    await waitFor(() => expect(screen.getByText("Familias del dibujo")).toBeInTheDocument());
    expect(lastBody(fetch)).toMatchObject({
      groupingStyle: "base_colors",
      targetFamilies: null,
      groupingStrength: 0.5,
      maxColors: null,
    });
  });

  it("permite fijar el objetivo de familias y la intensidad de agrupación antes de detectar", async () => {
    const fetch = vi.fn(() => Promise.resolve(respond(familiesPalette({ targetFamilies: 5, groupingStrength: 0.8 }))));
    vi.stubGlobal("fetch", fetch);
    renderPanel();

    fireEvent.change(screen.getByLabelText(/Objetivo de familias/), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText(/Intensidad de agrupación/), { target: { value: "0.8" } });
    fireEvent.click(screen.getByRole("button", { name: "Detectar paleta" }));

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(lastBody(fetch)).toMatchObject({ groupingStyle: "base_colors", targetFamilies: 5, groupingStrength: 0.8 });
    expect(screen.getByText(/Más alta fusiona sombras más distintas/)).toBeInTheDocument();
  });

  it("'Conservar tonos y sombras' pide el estilo detallado, oculta las familias y muestra el máximo de colores", async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(
        respond(familiesPalette({ groupingStyle: "detailed", background: null, groups: [group("g1", "Color 1", "#ff0000")] })),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    renderPanel();

    expect(screen.queryByLabelText(/Número máximo de colores/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /Conservar tonos y sombras/ }));
    expect(screen.queryByLabelText(/Objetivo de familias/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Número máximo de colores/), { target: { value: "8" } });
    fireEvent.click(screen.getByRole("button", { name: "Detectar paleta" }));

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(lastBody(fetch)).toMatchObject({ groupingStyle: "detailed", maxColors: 8, targetFamilies: null });
    await waitFor(() => expect(screen.getByText("Colores detectados")).toBeInTheDocument());
    expect(screen.queryByText("Familias del dibujo")).not.toBeInTheDocument();
  });

  it("cambiar de estilo después de detectar no re-detecta ni cambia la paleta hasta pulsar 'Detectar de nuevo'", async () => {
    const fetch = vi.fn(() => Promise.resolve(respond(familiesPalette())));
    vi.stubGlobal("fetch", fetch);
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Detectar paleta" }));
    await waitFor(() => expect(screen.getByText("Familias del dibujo")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("radio", { name: /Conservar tonos y sombras/ }));

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Detectar de nuevo" })).toBeEnabled();
  });

  it("una paleta anterior sin campos de familias se presenta como estilo detallado y no se re-detecta sola", async () => {
    const legacy = familiesPalette();
    for (const key of ["groupingStyle", "targetFamilies", "groupingStrength", "algorithmVersion", "familyCount", "pieceCount", "background"]) {
      delete (legacy as Record<string, unknown>)[key];
    }
    legacy.groups = [group("g1", "Color 1", "#ff0000"), group("g2", "Color 2", "#00ff00")];
    const fetch = vi.fn(() => Promise.resolve(respond(legacy)));
    vi.stubGlobal("fetch", fetch);
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Detectar paleta" }));

    await waitFor(() => expect(screen.getByText("Colores detectados")).toBeInTheDocument());
    expect(screen.getByRole("radio", { name: /Conservar tonos y sombras/ })).toBeChecked();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("ColorPalettePanel — familias, piezas y fondo (CA-02, CA-06)", () => {
  async function detected() {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(respond(familiesPalette()))));
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Detectar paleta" }));
    await waitFor(() => expect(screen.getByText("Familias del dibujo")).toBeInTheDocument());
  }

  it("muestra el número de familias y de piezas sin contar el fondo técnico", async () => {
    await detected();

    const summary = screen.getByText("Familias del dibujo").closest("div") as HTMLElement;
    expect(within(summary).getByText("2")).toBeInTheDocument();
    const pieces = screen.getByText("Piezas").closest("div") as HTMLElement;
    expect(within(pieces).getByText("10")).toBeInTheDocument();
  });

  it("identifica el fondo como grupo técnico, excluido por defecto y distinto de las familias", async () => {
    await detected();

    const list = screen.getByRole("list");
    const background = within(list).getByLabelText("Grupo de color Fondo");
    expect(within(background).getByText("Fondo técnico")).toBeInTheDocument();
    expect(within(background).getByLabelText("Excluir Fondo del corte")).toBeChecked();
    const family = within(list).getByLabelText("Grupo de color Familia 1");
    expect(within(family).getByText(/7 piezas/)).toBeInTheDocument();
    expect(within(family).getByText(/11 tonos/)).toBeInTheDocument();
    expect(within(family).queryByText("Fondo técnico")).not.toBeInTheDocument();
  });

  it("muestra qué área se considera fondo y pide revisión sin aprobar la heurística", async () => {
    await detected();

    const review = screen.getByRole("region", { name: "Revisión del fondo" });
    expect(within(review).getByText(/65\.0%/)).toBeInTheDocument();
    expect(within(review).getByRole("alert")).toHaveTextContent(/Revisá el fondo/);
    expect(within(review).getByRole("alert")).toHaveTextContent(/no se puede garantizar/i);
    expect(within(review).getByAltText(/Máscara del fondo/)).toHaveAttribute("src", expect.stringContaining("/groups/g3/mask"));
  });

  it("sin dudas de fondo no muestra la alerta de revisión", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          respond(familiesPalette({ background: { areaPercent: 65, ambiguousPercent: 0, contactPercent: 0, needsReview: false } })),
        ),
      ),
    );
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Detectar paleta" }));
    await waitFor(() => expect(screen.getByText("Familias del dibujo")).toBeInTheDocument());

    const review = screen.getByRole("region", { name: "Revisión del fondo" });
    expect(within(review).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("corregir la decisión de fondo = incluir el grupo técnico con el control existente", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(respond(familiesPalette()))
      .mockResolvedValueOnce(
        respond(
          familiesPalette({
            version: 2,
            groups: [
              group("g1", "Familia 1", "#c8551f", { pieceCount: 7 }),
              group("g2", "Familia 2", "#bea90e", { pieceCount: 3 }),
              group("g3", "Fondo", "#ffffff", { isBackground: true, isExcluded: false, pieceCount: 1 }),
            ],
          }),
        ),
      );
    vi.stubGlobal("fetch", fetch);
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Detectar paleta" }));
    await waitFor(() => expect(screen.getByText("Familias del dibujo")).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText("Excluir Fondo del corte"));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const [url, init] = fetch.mock.calls[1] as [string, RequestInit];
    expect(url).toContain(`${PALETTE_ID}/exclude`);
    expect(JSON.parse(String(init.body))).toEqual({ groupId: "g3", isExcluded: false });
  });
});

describe("ColorPalettePanel — corrección manual del fondo (nota de QA del 28/10)", () => {
  async function detected(overrides: Record<string, unknown> = {}) {
    const fetch = vi.fn(() => Promise.resolve(respond(familiesPalette(overrides))));
    vi.stubGlobal("fetch", fetch);
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Detectar paleta" }));
    await waitFor(() => expect(screen.getByText("Familias del dibujo")).toBeInTheDocument());
    return fetch;
  }

  function overlay(): SVGSVGElement {
    return screen.getByRole("img", { name: "Zonas marcadas como no fondo" }) as unknown as SVGSVGElement;
  }

  function drawZone(points: [number, number][]) {
    fireEvent.click(screen.getByRole("button", { name: "Marcar zona que NO es fondo" }));
    const svg = overlay();
    // jsdom no calcula el layout: el recuadro de la superposición es de 100x100 px sobre una imagen de 10x10.
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
    for (const [x, y] of points) {
      fireEvent.click(svg, { clientX: x * 10, clientY: y * 10 });
    }
  }

  it("ofrece corregir el fondo sobre la imagen original sin cambiar nada hasta aplicar", async () => {
    const fetch = await detected();

    const review = screen.getByRole("region", { name: "Revisión del fondo" });
    expect(within(review).getByRole("heading", { name: "Corregir el fondo" })).toBeInTheDocument();
    expect(within(review).getByText(/Nada cambia hasta que apliques las zonas/)).toBeInTheDocument();
    expect(within(review).getByRole("button", { name: "Aplicar zonas y detectar de nuevo" })).toBeDisabled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("dibuja una zona con clic, la cierra con tres vértices o más y la deja como pendiente", async () => {
    await detected();

    drawZone([[1, 1], [8, 1]]);
    const close = screen.getByRole("button", { name: /Cerrar zona/ });
    expect(close).toBeDisabled();
    fireEvent.click(overlay(), { clientX: 80, clientY: 80 });
    expect(close).toBeEnabled();
    fireEvent.click(close);

    const list = screen.getByRole("list", { name: "Zonas marcadas como no fondo" });
    expect(within(list).getByText(/Zona 1 · 3 vértices/)).toBeInTheDocument();
    expect(screen.getByText(/Hay zonas sin aplicar/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Aplicar zonas y detectar de nuevo" })).toBeEnabled();
  });

  it("aplicar envía las zonas en píxeles de la imagen y pide re-detectar la misma sesión", async () => {
    const fetch = await detected();
    drawZone([[1, 1], [8, 1], [8, 8]]);
    fireEvent.click(screen.getByRole("button", { name: /Cerrar zona/ }));
    fetch.mockResolvedValueOnce(
      respond(familiesPalette({ version: 2, backgroundCorrections: [{ points: [[1, 1], [8, 1], [8, 8]] }] })),
    );

    fireEvent.click(screen.getByRole("button", { name: "Aplicar zonas y detectar de nuevo" }));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(lastBody(fetch)).toMatchObject({
      paletteId: PALETTE_ID,
      groupingStyle: "base_colors",
      backgroundCorrections: [{ points: [[1, 1], [8, 1], [8, 8]] }],
    });
    await waitFor(() => expect(screen.queryByText(/Hay zonas sin aplicar/)).not.toBeInTheDocument());
    expect(screen.getByText(/Zona 1 · 3 vértices/)).toBeInTheDocument();
  });

  it("quitar una zona la saca de la próxima detección y puede deshacerse un vértice o cancelar el dibujo", async () => {
    const fetch = await detected({ backgroundCorrections: [{ points: [[1, 1], [8, 1], [8, 8]] }] });
    expect(screen.getByText(/Zona 1 · 3 vértices/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Marcar zona que NO es fondo" }));
    fireEvent.click(overlay(), { clientX: 10, clientY: 10 });
    expect(screen.getByRole("button", { name: /Cerrar zona \(1 vértices\)/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Deshacer vértice" }));
    expect(screen.getByRole("button", { name: /Cerrar zona \(0 vértices\)/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.getByRole("button", { name: "Marcar zona que NO es fondo" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Quitar zona 1" }));
    expect(screen.queryByRole("list", { name: "Zonas marcadas como no fondo" })).not.toBeInTheDocument();
    fetch.mockResolvedValueOnce(respond(familiesPalette({ version: 2 })));
    fireEvent.click(screen.getByRole("button", { name: "Aplicar zonas y detectar de nuevo" }));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(lastBody(fetch).backgroundCorrections).toBeUndefined();
  });

  it("la detección normal sin zonas no envía correcciones y en estilo detallado nunca se envían", async () => {
    const fetch = await detected();
    fetch.mockResolvedValueOnce(respond(familiesPalette({ version: 2 })));

    fireEvent.click(screen.getByRole("button", { name: "Detectar de nuevo" }));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(lastBody(fetch).backgroundCorrections).toBeUndefined();
  });

  it("con la paleta confirmada no se puede dibujar ni aplicar nada", async () => {
    await detected({ isConfirmed: true, backgroundCorrections: [{ points: [[1, 1], [8, 1], [8, 8]] }] });

    expect(screen.getByRole("button", { name: "Marcar zona que NO es fondo" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Quitar zona 1" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Aplicar zonas y detectar de nuevo" })).toBeDisabled();
  });
});
