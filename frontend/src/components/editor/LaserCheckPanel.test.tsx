import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MAX_LISTED_ISSUES, type LaserCheckIssue } from "../../lib/editor/laserCheck";
import { IDENTITY_MATRIX } from "../../lib/svgTransform";
import { LaserCheckPanel, type LaserCheckPanelProps } from "./LaserCheckPanel";

function issue(id: string, overrides: Partial<LaserCheckIssue> = {}): LaserCheckIssue {
  return {
    id,
    kind: "open_path",
    severity: "error",
    layerGroupId: "A",
    layerName: "Corte",
    operation: "cut",
    unassigned: false,
    objectIds: [id],
    objectLabel: `Corte · objeto ${id}`,
    message: "1 subpath abierto (sin cerrar; el hueco llega a 20 mm).",
    suggestion: "Cerrar el path o asignar la capa a Engrave.",
    rect: { x: 0, y: 0, width: 10, height: 10 },
    highlights: [{ d: "M0 0 H10 V10", matrix: IDENTITY_MATRIX, filled: true }],
    order: 0,
    ...overrides,
  };
}

function props(overrides: Partial<LaserCheckPanelProps> = {}): LaserCheckPanelProps {
  return {
    hasAnalysis: true,
    status: "blocking",
    stale: false,
    analyzing: false,
    summary: "Laser Check: Blocking. 1 bloqueante y 1 aviso.",
    scopeText: "Se analizaron 1 capa (3 objetos).",
    thresholdsText: "Umbrales: detalle mínimo 0.1 mm en Corte y 0.05 mm en Grabado.",
    scaleNotice: null,
    issues: [issue("1"), issue("2", { kind: "tiny_detail", severity: "warning", message: "1 detalle más fino que 0.1 mm.", suggestion: "Agrandar el detalle o quitarlo." })],
    unverified: [],
    floatingError: null,
    selectedIssueId: null,
    onSelectIssue: vi.fn(),
    onAnalyze: vi.fn(),
    onRetryFloating: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

const badge = () => screen.getByTestId("laser-check-status");
const options = () => screen.getAllByRole("option");

describe("LaserCheckPanel — estado global y contenido", () => {
  it.each([
    ["ready", "Ready"],
    ["review", "Review"],
    ["blocking", "Blocking"],
  ] as const)("el estado %s se lee por escrito (%s)", (status, text) => {
    render(<LaserCheckPanel {...props({ status, issues: [] })} />);

    expect(badge()).toHaveTextContent(text);
    expect(badge()).toHaveAttribute("data-status", status);
    expect(badge()).toHaveAttribute("data-stale", "false");
  });

  it("cada issue muestra severidad, tipo, capa con su operación, objeto, qué pasa y la acción sugerida", () => {
    render(<LaserCheckPanel {...props()} />);

    const [first, second] = options();
    expect(within(first).getByText("Bloqueante")).toBeInTheDocument();
    expect(within(first).getByText("Path abierto")).toBeInTheDocument();
    expect(first).toHaveTextContent("Capa «Corte» (Corte) · Corte · objeto 1");
    expect(first).toHaveTextContent("1 subpath abierto (sin cerrar; el hueco llega a 20 mm).");
    expect(first).toHaveTextContent("Acción sugerida: Cerrar el path o asignar la capa a Engrave.");
    expect(within(second).getByText("Revisar")).toBeInTheDocument();
    expect(within(second).getByText("Detalle muy pequeño")).toBeInTheDocument();
    expect(second).toHaveTextContent("Acción sugerida: Agrandar el detalle o quitarlo.");
  });

  it("una capa sin operación se rotula «Sin operación»", () => {
    render(<LaserCheckPanel {...props({ issues: [issue("1", { operation: "unassigned", unassigned: true })] })} />);

    expect(options()[0]).toHaveTextContent("Capa «Corte» (Sin operación)");
  });

  it("el resumen está en una región aria-live; el alcance y los umbrales están a la vista", () => {
    render(<LaserCheckPanel {...props()} />);

    const summary = screen.getByTestId("laser-check-summary");
    expect(summary).toHaveAttribute("role", "status");
    expect(summary).toHaveAttribute("aria-live", "polite");
    expect(summary).toHaveTextContent("Laser Check: Blocking. 1 bloqueante y 1 aviso.");
    expect(screen.getByText("Se analizaron 1 capa (3 objetos).")).toBeInTheDocument();
    expect(screen.getByText(/Umbrales: detalle mínimo 0.1 mm/)).toBeInTheDocument();
  });

  it("sin problemas lo dice; con algo no verificado lo aclara (no es «sin problemas»)", () => {
    const { rerender } = render(<LaserCheckPanel {...props({ status: "ready", issues: [], summary: "Laser Check: Ready. Sin problemas detectados." })} />);
    expect(screen.getByTestId("laser-check-empty")).toHaveTextContent("No se encontraron problemas de fabricación.");

    rerender(<LaserCheckPanel {...props({ status: "review", issues: [], unverified: [{ id: "floating", label: "Piezas flotantes", reason: "analizando en el servidor…" }] })} />);
    expect(screen.getByTestId("laser-check-empty")).toHaveTextContent("No se encontraron problemas en lo que se pudo verificar.");
    expect(screen.getByRole("list", { name: "Checks no verificados" })).toHaveTextContent("No verificado: Piezas flotantes. analizando en el servidor…");
  });

  it("mientras se analizan las flotantes lo anuncia en el resumen", () => {
    render(<LaserCheckPanel {...props({ analyzing: true })} />);

    expect(screen.getByTestId("laser-check-summary")).toHaveTextContent("Analizando las piezas flotantes en el servidor…");
  });

  it("sin análisis todavía muestra «Analizando…» y el botón dice Analizar", () => {
    render(<LaserCheckPanel {...props({ hasAnalysis: false, status: null, issues: [], summary: "Analizando el documento…" })} />);

    expect(badge()).toHaveTextContent("Analizando…");
    expect(screen.getByRole("button", { name: "Analizar" })).toBeInTheDocument();
    expect(screen.queryByTestId("laser-check-empty")).not.toBeInTheDocument();
  });

  it("el aviso de escala física ausente se muestra como nota", () => {
    render(<LaserCheckPanel {...props({ scaleNotice: "Sin escala física: los umbrales se miden en unidades del documento (u), no en mm." })} />);

    expect(screen.getByRole("note")).toHaveTextContent(/Sin escala física/);
  });

  it("si las flotantes fallan muestra el error con Reintentar, sin ocultar los demás issues", () => {
    const onRetryFloating = vi.fn();
    render(<LaserCheckPanel {...props({ floatingError: "El servidor no pudo completar el cálculo.", onRetryFloating })} />);

    expect(screen.getByRole("alert")).toHaveTextContent(/No se pudieron analizar las piezas flotantes\. Los demás checks siguen siendo válidos\./);
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Reintentar" }));
    expect(onRetryFloating).toHaveBeenCalledTimes(1);
    expect(options()).toHaveLength(2);
  });

  it("limita la lista a MAX_LISTED_ISSUES e informa cuántos hay", () => {
    const many = Array.from({ length: MAX_LISTED_ISSUES + 5 }, (_, index) => issue(String(index)));
    render(<LaserCheckPanel {...props({ issues: many })} />);

    expect(options()).toHaveLength(MAX_LISTED_ISSUES);
    expect(screen.getByRole("listbox")).toHaveAccessibleName(new RegExp(`${MAX_LISTED_ISSUES + 5} problemas.*Se muestran los primeros ${MAX_LISTED_ISSUES}`));
  });
});

describe("LaserCheckPanel — resultado desactualizado", () => {
  it("muestra «Desactualizado» en vez del estado, lo anuncia y no deja activar los issues viejos", () => {
    const onSelectIssue = vi.fn();
    render(<LaserCheckPanel {...props({ stale: true, onSelectIssue })} />);

    expect(badge()).toHaveTextContent("Desactualizado");
    expect(badge()).not.toHaveTextContent("Blocking");
    expect(badge()).toHaveAttribute("data-stale", "true");
    expect(screen.getByTestId("laser-check-summary")).toHaveTextContent("Resultado desactualizado (último análisis: Blocking): el documento cambió. Re-analizando…");
    expect(screen.getByRole("region", { name: "Laser Check" })).toHaveAttribute("data-stale", "true");
    expect(options()[0]).toHaveAttribute("aria-disabled", "true");

    fireEvent.click(options()[0]);
    const list = screen.getByRole("listbox");
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "Enter" });
    expect(onSelectIssue).not.toHaveBeenCalled();
  });

  it("un resultado viejo sin issues no dice «no se encontraron problemas»", () => {
    render(<LaserCheckPanel {...props({ stale: true, status: "ready", issues: [] })} />);

    expect(screen.queryByTestId("laser-check-empty")).not.toBeInTheDocument();
    expect(badge()).toHaveTextContent("Desactualizado");
  });
});

describe("LaserCheckPanel — teclado y foco", () => {
  it("al abrir el foco entra al panel", () => {
    render(<LaserCheckPanel {...props()} />);

    expect(screen.getByRole("region", { name: "Laser Check" })).toHaveFocus();
  });

  it("click en un issue lo activa", () => {
    const onSelectIssue = vi.fn();
    render(<LaserCheckPanel {...props({ onSelectIssue })} />);

    fireEvent.click(options()[1]);

    expect(onSelectIssue).toHaveBeenCalledWith("2");
  });

  it("la lista es un listbox con nombre accesible que dice cuántos problemas hay", () => {
    render(<LaserCheckPanel {...props()} />);

    const list = screen.getByRole("listbox");
    expect(list).toHaveAccessibleName(/2 problemas/);
    expect(list).toHaveAttribute("tabindex", "0");
  });

  it("↑/↓/Inicio/Fin mueven el cursor SIN activar; Enter y Espacio activan el del cursor", () => {
    const onSelectIssue = vi.fn();
    render(<LaserCheckPanel {...props({ onSelectIssue })} />);
    const list = screen.getByRole("listbox");
    list.focus();

    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(list).toHaveAttribute("aria-activedescendant", options()[0].id);
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(list).toHaveAttribute("aria-activedescendant", options()[1].id);
    fireEvent.keyDown(list, { key: "ArrowDown" }); // ya es el último
    expect(list).toHaveAttribute("aria-activedescendant", options()[1].id);
    fireEvent.keyDown(list, { key: "Home" });
    expect(list).toHaveAttribute("aria-activedescendant", options()[0].id);
    fireEvent.keyDown(list, { key: "End" });
    expect(list).toHaveAttribute("aria-activedescendant", options()[1].id);
    fireEvent.keyDown(list, { key: "ArrowUp" });
    expect(list).toHaveAttribute("aria-activedescendant", options()[0].id);
    expect(onSelectIssue).not.toHaveBeenCalled();

    fireEvent.keyDown(list, { key: "Enter" });
    expect(onSelectIssue).toHaveBeenLastCalledWith("1");
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: " " });
    expect(onSelectIssue).toHaveBeenLastCalledWith("2");
    expect(onSelectIssue).toHaveBeenCalledTimes(2);
  });

  it("Enter sin cursor no activa nada; el issue activado queda marcado aria-selected", () => {
    const onSelectIssue = vi.fn();
    render(<LaserCheckPanel {...props({ onSelectIssue, selectedIssueId: "2" })} />);
    const list = screen.getByRole("listbox");

    expect(options()[1]).toHaveAttribute("aria-selected", "true");
    expect(options()[0]).toHaveAttribute("aria-selected", "false");
    // Con un issue activado el cursor arranca ahí.
    expect(list).toHaveAttribute("aria-activedescendant", options()[1].id);

    const none = render(<LaserCheckPanel {...props({ onSelectIssue })} />);
    const emptyCursor = within(none.container).getByRole("listbox");
    fireEvent.keyDown(emptyCursor, { key: "Enter" });
    expect(onSelectIssue).not.toHaveBeenCalled();
  });

  it("Escape cierra el panel (también desde dentro de la lista) y no se propaga", () => {
    const onClose = vi.fn();
    const outer = vi.fn();
    render(
      <div onKeyDown={outer}>
        <LaserCheckPanel {...props({ onClose })} />
      </div>,
    );

    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });

  it("el botón ✕ cierra y Volver a analizar dispara el re-run", () => {
    const onClose = vi.fn();
    const onAnalyze = vi.fn();
    render(<LaserCheckPanel {...props({ onClose, onAnalyze })} />);

    fireEvent.click(screen.getByRole("button", { name: "Volver a analizar" }));
    fireEvent.click(screen.getByRole("button", { name: "Cerrar el Laser Check" }));

    expect(onAnalyze).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
