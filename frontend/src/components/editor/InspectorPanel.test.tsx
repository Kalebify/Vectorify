import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { InspectorPanel } from "./InspectorPanel";
import type { UseLaserWarningsState } from "../../hooks/useLaserWarnings";
import type { VectorDocumentLayer } from "../../hooks/useVectorDocument";
import type { CheckResponse } from "../../types/check";
import type { ManufacturingOperationPayload } from "../../types/manufacturingOperations";

function layer(overrides: Partial<VectorDocumentLayer> = {}): VectorDocumentLayer {
  return {
    groupId: "group-a",
    name: "Rojo",
    colorHex: "#ff0000",
    fill: "#ff0000",
    vectorId: "vector-a",
    svgUrl: "/vectors/a",
    pathCount: 3,
    componentCount: 1,
    manufacturingOperation: "cut",
    order: 0,
    visible: true,
    locked: false,
    areaPercent: 60,
    hasPartialAlpha: false,
    isExcluded: false,
    ...overrides,
  };
}

function fakeLaserWarnings(overrides: Partial<UseLaserWarningsState> = {}): UseLaserWarningsState {
  return {
    statusFor: () => "idle",
    resultFor: () => null,
    errorFor: () => null,
    run: vi.fn(),
    ...overrides,
  };
}

function defaultProps() {
  return {
    layers: [layer()],
    selectedLayer: layer(),
    isVisible: true,
    onIsolate: vi.fn(),
    onShowAll: vi.fn(),
    onRefresh: vi.fn(),
    onSelectAllInLayer: vi.fn(),
    selectedPathCount: 0,
    onToggleLocked: vi.fn(),
    laserWarnings: fakeLaserWarnings(),
    onRename: vi.fn(),
    operations: {} as Record<string, ManufacturingOperationPayload>,
    onChangeOperation: vi.fn(),
    mutatingGroupId: null as string | null,
  };
}

describe("InspectorPanel — sección de objetos (M3-S01)", () => {
  it("renderiza la sección de objetos arriba del Inspector de capa, sin alterar este último", () => {
    render(<InspectorPanel {...defaultProps()} objectSection={<div data-testid="object-section">Objeto</div>} />);

    const section = screen.getByTestId("object-section");
    const layerHex = screen.getByText("#ff0000");
    expect(section.compareDocumentPosition(layerHex) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Operación de fabricación de la capa Rojo" })).toHaveValue("cut");
  });

  it("sin objectSection no agrega nada", () => {
    render(<InspectorPanel {...defaultProps()} />);
    expect(screen.queryByTestId("object-section")).not.toBeInTheDocument();
  });
});

describe("InspectorPanel — sin selección", () => {
  it("muestra el hint de LayerInfoPanel sin inventar datos de ninguna capa", () => {
    render(<InspectorPanel {...defaultProps()} layers={[]} selectedLayer={null} isVisible={false} />);
    expect(screen.getByText(/Seleccioná un color en la paleta/)).toBeInTheDocument();
  });

  it("sin capa seleccionada, no muestra ninguna sección de acciones/warnings láser (no hay sobre qué capa operar)", () => {
    render(<InspectorPanel {...defaultProps()} layers={[]} selectedLayer={null} isVisible={false} />);
    expect(screen.queryByText("Warnings láser")).not.toBeInTheDocument();
  });
});

describe("InspectorPanel — capa seleccionada (Color / Paths / Pieces / Operation del wireframe)", () => {
  it("muestra HEX, paths, componentes y operación de la capa seleccionada", () => {
    render(<InspectorPanel {...defaultProps()} />);

    expect(screen.getByText("#ff0000")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getAllByText("1").length).toBeGreaterThan(0);
    expect(screen.getByRole("combobox", { name: "Operación de fabricación de la capa Rojo" })).toHaveValue("cut");
  });

  it("Aislar llama a onIsolate", () => {
    const onIsolate = vi.fn();
    render(<InspectorPanel {...defaultProps()} onIsolate={onIsolate} />);
    fireEvent.click(screen.getByRole("button", { name: "Aislar" }));
    expect(onIsolate).toHaveBeenCalled();
  });

  it("suma el resumen de operaciones de fabricación (M2-S07) calculado a partir de las capas del documento", () => {
    render(
      <InspectorPanel
        {...defaultProps()}
        layers={[layer(), layer({ groupId: "group-b", manufacturingOperation: "engrave" })]}
      />,
    );

    expect(screen.getByText(/1 en Corte, 1 en Grabado/)).toBeInTheDocument();
  });
});

describe("InspectorPanel — Rename inline (M2.1-S07, ronda de fix)", () => {
  it("editar el nombre y salir del campo (blur) llama a onRename con el groupId y el nombre nuevo", () => {
    const onRename = vi.fn();
    render(<InspectorPanel {...defaultProps()} onRename={onRename} />);

    const nameInput = screen.getByDisplayValue("Rojo");
    fireEvent.change(nameInput, { target: { value: "Rojo oscuro" } });
    fireEvent.blur(nameInput);

    expect(onRename).toHaveBeenCalledWith("group-a", "Rojo oscuro");
  });

  it("editar el nombre y confirmar con Enter llama a onRename (Enter dispara blur)", () => {
    const onRename = vi.fn();
    render(<InspectorPanel {...defaultProps()} onRename={onRename} />);

    const nameInput = screen.getByDisplayValue("Rojo");
    // El commit de Enter delega en el propio blur() del input (ver
    // LayerInfoPanel) -- blur() solo dispara el evento si el elemento está
    // efectivamente enfocado, por eso el focus() explícito acá.
    nameInput.focus();
    fireEvent.change(nameInput, { target: { value: "Rojo intenso" } });
    fireEvent.keyDown(nameInput, { key: "Enter" });

    expect(onRename).toHaveBeenCalledWith("group-a", "Rojo intenso");
  });
});

describe("InspectorPanel — cambio de operación CUT/ENGRAVE/IGNORE (M2.1-S07, ronda de fix)", () => {
  it("elegir una operación distinta en el <select> llama a onChangeOperation con el groupId y la operación elegidos", () => {
    const onChangeOperation = vi.fn();
    render(<InspectorPanel {...defaultProps()} onChangeOperation={onChangeOperation} />);

    const select = screen.getByRole("combobox", { name: "Operación de fabricación de la capa Rojo" });
    fireEvent.change(select, { target: { value: "engrave" } });

    expect(onChangeOperation).toHaveBeenCalledWith("group-a", "engrave");
  });

  it("mientras se está guardando (mutatingGroupId coincide con la capa seleccionada) el <select> queda deshabilitado", () => {
    render(<InspectorPanel {...defaultProps()} mutatingGroupId="group-a" />);
    expect(screen.getByRole("combobox", { name: "Operación de fabricación de la capa Rojo" })).toBeDisabled();
  });
});

describe("InspectorPanel — Lock deshabilita rename y operación (M2.1-S07, ronda de fix)", () => {
  it("capa bloqueada: el input de rename y el <select> de operación quedan deshabilitados", () => {
    render(<InspectorPanel {...defaultProps()} selectedLayer={layer({ locked: true })} />);

    expect(screen.getByDisplayValue("Rojo")).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Operación de fabricación de la capa Rojo" })).toBeDisabled();
  });

  it("capa desbloqueada: el input de rename y el <select> de operación quedan habilitados", () => {
    render(<InspectorPanel {...defaultProps()} selectedLayer={layer({ locked: false })} />);

    expect(screen.getByDisplayValue("Rojo")).toBeEnabled();
    expect(screen.getByRole("combobox", { name: "Operación de fabricación de la capa Rojo" })).toBeEnabled();
  });
});

describe("InspectorPanel — Select All in Layer (M2.1-S07)", () => {
  it('el botón "Seleccionar todo en la capa" llama a onSelectAllInLayer', () => {
    const onSelectAllInLayer = vi.fn();
    render(<InspectorPanel {...defaultProps()} onSelectAllInLayer={onSelectAllInLayer} />);

    fireEvent.click(screen.getByRole("button", { name: "Seleccionar todo en la capa" }));
    expect(onSelectAllInLayer).toHaveBeenCalled();
  });

  it("muestra cuántos elementos quedaron seleccionados cuando selectedPathCount > 0", () => {
    render(<InspectorPanel {...defaultProps()} selectedPathCount={3} />);
    expect(screen.getByText(/3 elementos seleccionados/)).toBeInTheDocument();
  });
});

describe("InspectorPanel — Lock (M2.1-S07)", () => {
  it("capa desbloqueada: el botón ofrece 'Bloquear capa' y togglearlo llama a onToggleLocked", () => {
    const onToggleLocked = vi.fn();
    render(<InspectorPanel {...defaultProps()} selectedLayer={layer({ locked: false })} onToggleLocked={onToggleLocked} />);

    const button = screen.getByRole("button", { name: "Bloquear capa" });
    fireEvent.click(button);
    expect(onToggleLocked).toHaveBeenCalled();
  });

  it("capa bloqueada: muestra 'Sí' y ofrece 'Desbloquear capa' -- pero Aislar sigue disponible (Lock no bloquea Isolate)", () => {
    render(<InspectorPanel {...defaultProps()} selectedLayer={layer({ locked: true })} />);

    expect(screen.getByText("Sí (edición bloqueada)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Desbloquear capa" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Aislar" })).toBeEnabled();
  });
});

describe("InspectorPanel — warnings láser (M2.1-S07)", () => {
  it("sin chequeo corrido todavía: estado vacío honesto + botón para ejecutarlo (nunca automático)", () => {
    const run = vi.fn();
    render(<InspectorPanel {...defaultProps()} laserWarnings={fakeLaserWarnings({ run })} />);

    expect(screen.getByText(/Todavía no se ejecutó el Laser Checker/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ejecutar Laser Checker" }));
    expect(run).toHaveBeenCalledWith("group-a", "vector-a");
  });

  it("mientras corre, muestra 'Analizando…'", () => {
    render(<InspectorPanel {...defaultProps()} laserWarnings={fakeLaserWarnings({ statusFor: () => "running" })} />);
    expect(screen.getByText("Analizando…")).toBeInTheDocument();
  });

  it("con resultado ya disponible (de esta sesión), muestra el resumen sin volver a llamar automáticamente", () => {
    const run = vi.fn();
    const result: CheckResponse = {
      projectId: "p",
      imageId: "i",
      sourceKind: "vector",
      sourceId: "vector-a",
      summary: { openPathCount: 2, duplicateGroupCount: 1 },
      issues: [],
      skippedPathCount: 0,
      closeGapRatio: 0.01,
      duplicatePointRatio: 0.01,
    };
    render(
      <InspectorPanel
        {...defaultProps()}
        laserWarnings={fakeLaserWarnings({ statusFor: () => "ready", resultFor: () => result, run })}
      />,
    );

    expect(screen.getByText(/2 paths abiertos, 1 grupos de duplicados/)).toBeInTheDocument();
    expect(run).not.toHaveBeenCalled();
  });

  it("si falló, muestra el mensaje de error y permite reintentar", () => {
    render(
      <InspectorPanel
        {...defaultProps()}
        laserWarnings={fakeLaserWarnings({ statusFor: () => "error", errorFor: () => "No se pudo analizar el SVG." })}
      />,
    );
    expect(screen.getByText("No se pudo analizar el SVG.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reintentar" })).toBeInTheDocument();
  });
});

describe("InspectorPanel — capa creada por el editor (M3-S03)", () => {
  it("una capa NUEVA no ofrece el Laser Checker (no existe en el servidor) y lo explica; una del servidor sí", () => {
    const created = layer({ groupId: "group-n", name: "Color #00FF00", colorHex: "#00FF00", isNew: true, vectorId: "", svgUrl: "", manufacturingOperation: "unassigned" });
    const props = { ...defaultProps(), layers: [layer(), created], selectedLayer: created };
    const { rerender } = render(<InspectorPanel {...props} />);
    expect(screen.queryByRole("button", { name: "Ejecutar Laser Checker" })).not.toBeInTheDocument();
    expect(screen.getByText(/Capa nueva, todavía sin guardar/)).toBeInTheDocument();
    expect(props.laserWarnings.run).not.toHaveBeenCalled();

    rerender(<InspectorPanel {...props} selectedLayer={layer()} />);
    expect(screen.getByRole("button", { name: "Ejecutar Laser Checker" })).toBeInTheDocument();
    expect(screen.queryByText(/Capa nueva, todavía sin guardar/)).not.toBeInTheDocument();
  });

  it("refleja el color y los paths de la capa efectiva (recoloreada / con objetos movidos)", () => {
    render(<InspectorPanel {...defaultProps()} selectedLayer={layer({ colorHex: "#00ff00", pathCount: 7 })} layers={[layer({ colorHex: "#00ff00", pathCount: 7 })]} />);
    expect(screen.getByText("#00ff00")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
  });
});
