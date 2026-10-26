import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ExportPanel, type ExportSourceOption } from "./ExportPanel";

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const IMAGE_ID = "22222222-2222-2222-2222-222222222222";
const VECTOR_ID = "33333333-3333-3333-3333-333333333333";
const SIMPLIFICATION_ID = "44444444-4444-4444-4444-444444444444";
const DIMENSION_ID = "55555555-5555-5555-5555-555555555555";

const VECTOR_SOURCE: ExportSourceOption = {
  kind: "vector",
  id: VECTOR_ID,
  label: "Vector actual",
  version: 1,
  widthPx: 100,
  heightPx: 200,
  checkSourceKind: "vector",
  checkSourceId: VECTOR_ID,
};

const SIMPLIFICATION_SOURCE: ExportSourceOption = {
  kind: "simplification",
  id: SIMPLIFICATION_ID,
  label: "Última simplificación",
  version: 2,
  widthPx: 100,
  heightPx: 200,
  checkSourceKind: "simplification",
  checkSourceId: SIMPLIFICATION_ID,
};

const DIMENSION_SOURCE: ExportSourceOption = {
  kind: "dimension",
  id: DIMENSION_ID,
  label: "Última versión con dimensiones físicas",
  version: 1,
  widthPx: 100,
  heightPx: 200,
  widthMm: 150,
  heightMm: 300,
  // La fuente REAL de la geometría es el vector del que se derivó -- el Laser
  // Checker no admite "dimension" como sourceKind.
  checkSourceKind: "vector",
  checkSourceId: VECTOR_ID,
};

function checkResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      projectId: PROJECT_ID,
      imageId: IMAGE_ID,
      sourceKind: "vector",
      sourceId: VECTOR_ID,
      summary: { openPathCount: 2, duplicateGroupCount: 1 },
      issues: [],
      skippedPathCount: 0,
      closeGapRatio: 0.005,
      duplicatePointRatio: 0.002,
      ...overrides,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function renderPanel(sources: ExportSourceOption[] = [VECTOR_SOURCE]) {
  return render(<ExportPanel projectId={PROJECT_ID} imageId={IMAGE_ID} sources={sources} />);
}

describe("ExportPanel — estado inicial", () => {
  it("no llama al Laser Checker al montar (disparo manual, mismo criterio que CheckPanel)", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    renderPanel();

    expect(fetch).not.toHaveBeenCalled();
  });

  it("no muestra el selector de fuente si solo hay una versión disponible", () => {
    vi.stubGlobal("fetch", vi.fn());
    renderPanel();

    expect(screen.queryByRole("radiogroup", { name: "Versión a exportar" })).not.toBeInTheDocument();
  });

  it("muestra el selector de fuente cuando hay más de una versión disponible", () => {
    vi.stubGlobal("fetch", vi.fn());
    renderPanel([VECTOR_SOURCE, SIMPLIFICATION_SOURCE, DIMENSION_SOURCE]);

    expect(screen.getByRole("radiogroup", { name: "Versión a exportar" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Vector actual" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Última simplificación" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Última versión con dimensiones físicas" })).toBeInTheDocument();
  });
});

describe("ExportPanel — resumen de tamaño", () => {
  it("muestra el tamaño en px para una fuente vector/simplificación", () => {
    vi.stubGlobal("fetch", vi.fn());
    renderPanel([VECTOR_SOURCE]);

    expect(screen.getByText("100px × 200px")).toBeInTheDocument();
  });

  it("muestra el tamaño físico en mm (además del interno en px) para una fuente dimension", () => {
    vi.stubGlobal("fetch", vi.fn());
    renderPanel([VECTOR_SOURCE, DIMENSION_SOURCE]);

    fireEvent.click(screen.getByRole("radio", { name: "Última versión con dimensiones físicas" }));

    expect(screen.getByText("150mm × 300mm (100px × 200px internos)")).toBeInTheDocument();
  });
});

describe("ExportPanel — Laser Checker (informativo)", () => {
  it("al pedirlo, corre el análisis y muestra el resumen de issues", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(checkResponse())));
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Revisar con Laser Checker" }));

    expect(await screen.findByText("2")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("para una fuente dimension, el análisis corre sobre el vector/simplificación de origen, no sobre el dimensionId", async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => Promise.resolve(checkResponse()));
    vi.stubGlobal("fetch", fetch);
    renderPanel([VECTOR_SOURCE, DIMENSION_SOURCE]);

    fireEvent.click(screen.getByRole("radio", { name: "Última versión con dimensiones físicas" }));
    fireEvent.click(screen.getByRole("button", { name: "Revisar con Laser Checker" }));

    await screen.findByText("2");

    const init = fetch.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string) as { sourceKind: string; sourceId: string };
    expect(body.sourceKind).toBe("vector");
    expect(body.sourceId).toBe(VECTOR_ID);
  });

  it("el botón Descargar sigue habilitado y presente incluso con issues encontrados", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(checkResponse({ summary: { openPathCount: 5, duplicateGroupCount: 3 } }))));
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Revisar con Laser Checker" }));
    await screen.findByText("5");

    const downloadLink = screen.getByRole("link", { name: "Descargar SVG en blanco y negro" });
    expect(downloadLink).not.toHaveAttribute("aria-disabled");
    expect(downloadLink.hasAttribute("download")).toBe(true);
  });
});

describe("ExportPanel — descarga", () => {
  it("el link de descarga apunta al endpoint de export con el sourceKind/sourceId de la fuente elegida", () => {
    vi.stubGlobal("fetch", vi.fn());
    renderPanel([VECTOR_SOURCE, SIMPLIFICATION_SOURCE]);

    fireEvent.click(screen.getByRole("radio", { name: "Última simplificación" }));

    const downloadLink = screen.getByRole("link", { name: "Descargar SVG en blanco y negro" }) as HTMLAnchorElement;
    expect(downloadLink.getAttribute("href")).toContain(
      `/api/v1/projects/${PROJECT_ID}/images/${IMAGE_ID}/export`,
    );
    expect(downloadLink.getAttribute("href")).toContain("sourceKind=simplification");
    expect(downloadLink.getAttribute("href")).toContain(`sourceId=${SIMPLIFICATION_ID}`);
  });

  it("cambiar de fuente actualiza el link de descarga sin llamar a la Web API", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    renderPanel([VECTOR_SOURCE, DIMENSION_SOURCE]);

    fireEvent.click(screen.getByRole("radio", { name: "Última versión con dimensiones físicas" }));

    const downloadLink = screen.getByRole("link", { name: "Descargar SVG en blanco y negro" }) as HTMLAnchorElement;
    expect(downloadLink.getAttribute("href")).toContain("sourceKind=dimension");
    expect(downloadLink.getAttribute("href")).toContain(`sourceId=${DIMENSION_ID}`);
    expect(fetch).not.toHaveBeenCalled();
  });
});
