import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EditorLayersPanel } from "./EditorLayersPanel";
import type { VectorDocumentLayer } from "../../hooks/useVectorDocument";
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

/** Props obligatorias mínimas -- cada test override lo que necesite (mismo criterio que InspectorPanel.test.tsx). */
function baseProps(overrides: Partial<Parameters<typeof EditorLayersPanel>[0]> = {}) {
  return {
    layers: [layer()],
    visibility: { "group-a": true },
    onToggleVisibility: vi.fn(),
    onToggleLocked: vi.fn(),
    onReorder: vi.fn(),
    selectedGroupId: null,
    onSelectGroup: vi.fn(),
    onRename: vi.fn(),
    operations: {} as Record<string, ManufacturingOperationPayload>,
    onChangeOperation: vi.fn(),
    mutatingGroupId: null,
    ...overrides,
  };
}

function dataTransferStub(payload: Record<string, string> = {}) {
  const store = new Map(Object.entries(payload));
  return {
    effectAllowed: "",
    dropEffect: "",
    setData: (format: string, value: string) => store.set(format, value),
    getData: (format: string) => store.get(format) ?? "",
  };
}

describe("EditorLayersPanel — proyecto sin layers", () => {
  it("muestra un estado vacío honesto (sin filas inventadas)", () => {
    render(<EditorLayersPanel {...baseProps({ layers: [], visibility: {} })} />);
    expect(screen.getByText(/todavía no tiene capas generadas/)).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Capas del documento" })).not.toBeInTheDocument();
  });
});

describe("EditorLayersPanel — proyecto multicolor", () => {
  it("una fila por capa, con swatch, nombre y operación", () => {
    render(
      <EditorLayersPanel
        {...baseProps({
          layers: [layer(), layer({ groupId: "group-b", name: "Azul", colorHex: "#0000ff", manufacturingOperation: "engrave" })],
          visibility: { "group-a": true, "group-b": true },
        })}
      />,
    );

    expect(screen.getByDisplayValue("Rojo")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Azul")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Operación de fabricación de la capa Rojo" })).toHaveValue("cut");
    expect(screen.getByRole("combobox", { name: "Operación de fabricación de la capa Azul" })).toHaveValue("engrave");
  });

  it("togglear el ojo llama a onToggleVisibility con el groupId correcto", () => {
    const onToggleVisibility = vi.fn();
    render(<EditorLayersPanel {...baseProps({ onToggleVisibility })} />);

    fireEvent.click(screen.getByRole("button", { name: "Ocultar la capa Rojo" }));
    expect(onToggleVisibility).toHaveBeenCalledWith("group-a");
  });

  it("seleccionar una capa llama a onSelectGroup y la resalta (no solo por color)", () => {
    const onSelectGroup = vi.fn();
    render(<EditorLayersPanel {...baseProps({ onSelectGroup })} />);

    fireEvent.click(screen.getByRole("button", { name: "Seleccionar la capa Rojo" }));
    expect(onSelectGroup).toHaveBeenCalledWith("group-a");
  });

  it("la capa seleccionada muestra un check además del resaltado", () => {
    render(<EditorLayersPanel {...baseProps({ selectedGroupId: "group-a" })} />);
    expect(screen.getByRole("button", { name: "Seleccionar la capa Rojo" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("✓")).toBeInTheDocument();
  });

  it('"+ ADD LAYER" está presente pero deshabilitado', () => {
    render(<EditorLayersPanel {...baseProps()} />);
    expect(screen.getByRole("button", { name: "+ ADD LAYER" })).toBeDisabled();
  });
});

describe("EditorLayersPanel — Rename inline (M2.1-S07, ronda de fix)", () => {
  it("editar el nombre y salir del campo (blur) llama a onRename con el groupId y el nombre nuevo", () => {
    const onRename = vi.fn();
    render(<EditorLayersPanel {...baseProps({ onRename })} />);

    const nameInput = screen.getByDisplayValue("Rojo");
    fireEvent.change(nameInput, { target: { value: "Rojo oscuro" } });
    fireEvent.blur(nameInput);

    expect(onRename).toHaveBeenCalledWith("group-a", "Rojo oscuro");
  });

  it("editar el nombre y confirmar con Enter llama a onRename (Enter dispara blur)", () => {
    const onRename = vi.fn();
    render(<EditorLayersPanel {...baseProps({ onRename })} />);

    const nameInput = screen.getByDisplayValue("Rojo");
    // El commit de Enter delega en el propio blur() del input (ver
    // EditorLayersPanel) -- blur() solo dispara el evento si el elemento
    // está efectivamente enfocado, por eso el focus() explícito acá (a
    // diferencia del test de blur directo de arriba, que no lo necesita).
    nameInput.focus();
    fireEvent.change(nameInput, { target: { value: "Rojo intenso" } });
    fireEvent.keyDown(nameInput, { key: "Enter" });

    expect(onRename).toHaveBeenCalledWith("group-a", "Rojo intenso");
  });

  it("dejar el campo vacío (o sin cambios) NO llama a onRename", () => {
    const onRename = vi.fn();
    render(<EditorLayersPanel {...baseProps({ onRename })} />);

    const nameInput = screen.getByDisplayValue("Rojo");
    fireEvent.change(nameInput, { target: { value: "   " } });
    fireEvent.blur(nameInput);

    expect(onRename).not.toHaveBeenCalled();
  });
});

describe("EditorLayersPanel — cambio de operación CUT/ENGRAVE/IGNORE (M2.1-S07, ronda de fix)", () => {
  it("elegir una operación distinta en el <select> llama a onChangeOperation con el groupId y la operación elegidos", () => {
    const onChangeOperation = vi.fn();
    render(<EditorLayersPanel {...baseProps({ onChangeOperation })} />);

    const select = screen.getByRole("combobox", { name: "Operación de fabricación de la capa Rojo" });
    fireEvent.change(select, { target: { value: "engrave" } });

    expect(onChangeOperation).toHaveBeenCalledWith("group-a", "engrave");
  });

  it("mientras se está guardando (mutatingGroupId) el <select> de esa fila queda deshabilitado", () => {
    render(<EditorLayersPanel {...baseProps({ mutatingGroupId: "group-a" })} />);
    expect(screen.getByRole("combobox", { name: "Operación de fabricación de la capa Rojo" })).toBeDisabled();
  });
});

describe("EditorLayersPanel — Lock deshabilita rename y operación (M2.1-S07, ronda de fix)", () => {
  it("una capa bloqueada deshabilita el input de rename y el <select> de operación", () => {
    render(<EditorLayersPanel {...baseProps({ layers: [layer({ locked: true })] })} />);

    expect(screen.getByDisplayValue("Rojo")).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Operación de fabricación de la capa Rojo" })).toBeDisabled();
  });

  it("una capa desbloqueada deja el input de rename y el <select> de operación habilitados", () => {
    render(<EditorLayersPanel {...baseProps({ layers: [layer({ locked: false })] })} />);

    expect(screen.getByDisplayValue("Rojo")).toBeEnabled();
    expect(screen.getByRole("combobox", { name: "Operación de fabricación de la capa Rojo" })).toBeEnabled();
  });
});

describe("EditorLayersPanel — Lock (M2.1-S07, concepto nuevo)", () => {
  it("una capa desbloqueada muestra el candado abierto y togglearlo llama a onToggleLocked", () => {
    const onToggleLocked = vi.fn();
    render(<EditorLayersPanel {...baseProps({ layers: [layer({ locked: false })], onToggleLocked })} />);

    const lockButton = screen.getByRole("button", { name: "Bloquear la capa Rojo" });
    expect(lockButton).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(lockButton);
    expect(onToggleLocked).toHaveBeenCalledWith("group-a");
  });

  it("una capa bloqueada muestra el candado cerrado, pero Eye y Select siguen habilitados (Lock no bloquea visibilidad/inspección)", () => {
    render(<EditorLayersPanel {...baseProps({ layers: [layer({ locked: true })] })} />);

    expect(screen.getByRole("button", { name: "Desbloquear la capa Rojo" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Ocultar la capa Rojo" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Seleccionar la capa Rojo" })).toBeEnabled();
  });
});

describe("EditorLayersPanel — Drag & Drop para reordenar (M2.1-S07)", () => {
  it("arrastrar una fila y soltarla sobre otra llama a onReorder con el nuevo orden completo de groupId", () => {
    const onReorder = vi.fn();
    const layers = [
      layer({ groupId: "group-a", name: "Rojo", order: 0 }),
      layer({ groupId: "group-b", name: "Azul", colorHex: "#0000ff", order: 1 }),
      layer({ groupId: "group-c", name: "Verde", colorHex: "#00ff00", order: 2 }),
    ];

    render(
      <EditorLayersPanel
        {...baseProps({
          layers,
          visibility: { "group-a": true, "group-b": true, "group-c": true },
          onReorder,
        })}
      />,
    );

    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(3);

    const dataTransfer = dataTransferStub();
    fireEvent.dragStart(rows[0], { dataTransfer });
    fireEvent.dragOver(rows[2], { dataTransfer });
    fireEvent.drop(rows[2], { dataTransfer });

    expect(onReorder).toHaveBeenCalledTimes(1);
    // Soltar "Rojo" (group-a) sobre "Verde" (group-c) lo inserta inmediatamente
    // antes de "Verde": el nuevo orden completo es [Azul, Rojo, Verde].
    expect(onReorder).toHaveBeenCalledWith(["group-b", "group-a", "group-c"]);
  });

  it("soltar una fila sobre sí misma NO llama a onReorder", () => {
    const onReorder = vi.fn();
    render(
      <EditorLayersPanel
        {...baseProps({
          layers: [layer({ groupId: "group-a", order: 0 }), layer({ groupId: "group-b", name: "Azul", order: 1 })],
          visibility: { "group-a": true, "group-b": true },
          onReorder,
        })}
      />,
    );

    const rows = screen.getAllByRole("listitem");
    const dataTransfer = dataTransferStub();
    fireEvent.dragStart(rows[0], { dataTransfer });
    fireEvent.drop(rows[0], { dataTransfer });

    expect(onReorder).not.toHaveBeenCalled();
  });
});

describe("EditorLayersPanel — capas creadas por el editor (M3-S03)", () => {
  it("una capa NUEVA se lista al instante con la insignia 'nueva'; las del servidor no la llevan", () => {
    render(
      <EditorLayersPanel
        {...baseProps({
          layers: [layer(), layer({ groupId: "group-n", name: "Color #00FF00", colorHex: "#00FF00", isNew: true, order: 1, manufacturingOperation: "unassigned" })],
          visibility: { "group-a": true, "group-n": true },
        })}
      />,
    );
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[1]).toHaveTextContent("nueva");
    expect(rows[0]).not.toHaveTextContent("nueva");
    expect(screen.getByLabelText("Nombre de la capa Color #00FF00")).toHaveValue("Color #00FF00");
    expect(screen.getByLabelText("Operación de fabricación de la capa Color #00FF00")).toHaveValue("unassigned");
  });

  it("los controles de una capa nueva usan los MISMOS callbacks (el shell decide que son locales, sin PATCH)", () => {
    const props = baseProps({
      layers: [layer({ groupId: "group-n", name: "Color #00FF00", colorHex: "#00FF00", isNew: true, manufacturingOperation: "unassigned" })],
      visibility: { "group-n": true },
    });
    render(<EditorLayersPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Ocultar la capa Color #00FF00" }));
    expect(props.onToggleVisibility).toHaveBeenCalledWith("group-n");
    fireEvent.click(screen.getByRole("button", { name: "Bloquear la capa Color #00FF00" }));
    expect(props.onToggleLocked).toHaveBeenCalledWith("group-n");
    fireEvent.change(screen.getByLabelText("Operación de fabricación de la capa Color #00FF00"), { target: { value: "engrave" } });
    expect(props.onChangeOperation).toHaveBeenCalledWith("group-n", "engrave");
    const name = screen.getByLabelText("Nombre de la capa Color #00FF00");
    fireEvent.change(name, { target: { value: "Verde" } });
    fireEvent.blur(name);
    expect(props.onRename).toHaveBeenCalledWith("group-n", "Verde");
  });

  it("refleja el color cambiado de una capa (mismo groupId, otro swatch)", () => {
    const { rerender } = render(<EditorLayersPanel {...baseProps()} />);
    expect(screen.getByTitle("#ff0000")).toBeInTheDocument();
    rerender(<EditorLayersPanel {...baseProps({ layers: [layer({ colorHex: "#00ff00" })] })} />);
    expect(screen.getByTitle("#00ff00")).toHaveStyle({ backgroundColor: "#00ff00" });
    expect(screen.queryByTitle("#ff0000")).not.toBeInTheDocument();
  });
});
