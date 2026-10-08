import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BooleanBar } from "./BooleanBar";
import { BooleanPanel, NEW_LAYER_VALUE } from "./BooleanPanel";

type PanelProps = Parameters<typeof BooleanPanel>[0];

const OPERANDS: PanelProps["operands"] = [
  { id: "r1", letter: "A", name: "Rojo · objeto 1", colorHex: "#ff0000" },
  { id: "b1", letter: "B", name: "Azul · objeto 1", colorHex: "#0000ff" },
  { id: "b2", letter: "C", name: "Azul · objeto 2", colorHex: "#0000ff" },
];

function props(overrides: Partial<PanelProps> = {}): PanelProps {
  return {
    op: "difference",
    onOpChange: vi.fn(),
    operands: OPERANDS,
    onMoveOperand: vi.fn(),
    onReverse: vi.fn(),
    layersDiffer: true,
    resolvedTarget: null,
    targetCandidates: [
      { groupId: "A", name: "Rojo", colorHex: "#ff0000", isOperandLayer: true },
      { groupId: "B", name: "Azul", colorHex: "#0000ff", isOperandLayer: true },
      { groupId: "C", name: "Verde", colorHex: "#00ff00", isOperandLayer: false },
    ],
    targetValue: "",
    onTargetChange: vi.fn(),
    newColorHex: "",
    onNewColorChange: vi.fn(),
    targetIssue: null,
    keepOriginals: false,
    onKeepOriginalsChange: vi.fn(),
    toleranceMm: 0.01,
    unitLabel: "mm",
    onToleranceChange: vi.fn(),
    preview: { status: "ready", readyText: "Resultado: 2 piezas.", empty: false, errorMessage: null },
    rejection: null,
    message: null,
    applying: false,
    applyDisabledReason: null,
    onApply: vi.fn(),
    onCancel: vi.fn(),
    onRetry: vi.fn(),
    ...overrides,
  };
}

const applyButton = () => screen.getByRole("button", { name: "Apply" });

describe("BooleanPanel", () => {
  it("lista los operandos con insignia A/B/C Y nombre legible «capa · objeto n» (no depende del color)", () => {
    render(<BooleanPanel {...props()} />);

    const list = screen.getByRole("list", { name: "Operandos en orden" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("A");
    expect(items[0]).toHaveTextContent("Operando A: Rojo · objeto 1");
    expect(items[2]).toHaveTextContent("Operando C: Azul · objeto 2");
    expect(screen.getByRole("heading", { name: "Booleana — Diferencia" })).toBeInTheDocument();
    expect(screen.getByText(/A es la base y se le resta el resto/)).toBeInTheDocument();
  });

  it("subir/bajar por operando (el primero no sube, el último no baja) e invertir el orden", () => {
    const panel = props();
    render(<BooleanPanel {...panel} />);

    expect(screen.getByRole("button", { name: "Subir A (Rojo · objeto 1)" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Bajar C (Azul · objeto 2)" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Subir B (Azul · objeto 1)" }));
    fireEvent.click(screen.getByRole("button", { name: "Bajar B (Azul · objeto 1)" }));
    fireEvent.click(screen.getByRole("button", { name: "Invertir orden" }));

    expect(panel.onMoveOperand).toHaveBeenNthCalledWith(1, 1, -1);
    expect(panel.onMoveOperand).toHaveBeenNthCalledWith(2, 1, 1);
    expect(panel.onReverse).toHaveBeenCalledTimes(1);
  });

  it("elegir otra operación llama a onOpChange y marca la activa", () => {
    const panel = props({ op: "union" });
    render(<BooleanPanel {...panel} />);

    expect(screen.getByRole("radio", { name: "Unión" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "Intersección" }));

    expect(panel.onOpChange).toHaveBeenCalledWith("intersection");
  });

  describe("capa destino", () => {
    it("con capas distintas el selector NO tiene valor por defecto (queda «Elegí una capa…») y Apply está a cargo del shell: deshabilitado", () => {
      render(<BooleanPanel {...props({ applyDisabledReason: "Las formas están en capas distintas: elegí la capa de destino." })} />);

      const select = screen.getByLabelText(/Los operandos están en capas distintas/);
      expect(select).toHaveValue("");
      expect(within(select as HTMLElement).getByRole("option", { name: "Elegí una capa…" })).toBeInTheDocument();
      expect(screen.getByText(/Todavía no elegiste la capa destino/)).toBeInTheDocument();
      expect(applyButton()).toBeDisabled();
      expect(applyButton()).toHaveAttribute("title", expect.stringContaining("elegí la capa de destino"));
    });

    it("ofrece las capas de los operandos primero, luego las otras desbloqueadas/visibles y «Capa nueva con un color…»", () => {
      render(<BooleanPanel {...props()} />);

      const operandGroup = screen.getByRole("group", { name: "Capas de los operandos" });
      const otherGroup = screen.getByRole("group", { name: "Otras capas desbloqueadas y visibles" });
      expect(within(operandGroup).getAllByRole("option").map((option) => option.textContent)).toEqual(["Rojo (#ff0000)", "Azul (#0000ff)"]);
      expect(within(otherGroup).getAllByRole("option").map((option) => option.textContent)).toEqual(["Verde (#00ff00)"]);
      expect(screen.getByRole("option", { name: "Capa nueva con un color…" })).toHaveValue(NEW_LAYER_VALUE);
    });

    it("elegir una capa avisa al shell; con una capa elegida se ve dónde va el resultado y con qué color", () => {
      const panel = props();
      const { rerender } = render(<BooleanPanel {...panel} />);

      fireEvent.change(screen.getByLabelText(/Los operandos están en capas distintas/), { target: { value: "B" } });
      expect(panel.onTargetChange).toHaveBeenCalledWith("B");

      rerender(<BooleanPanel {...props({ targetValue: "B", resolvedTarget: { name: "Azul", colorHex: "#0000ff", created: false } })} />);
      expect(screen.getByText(/El resultado va a «Azul» con el color/)).toBeInTheDocument();
      expect(screen.getByText(/#0000ff\./)).toBeInTheDocument();
    });

    it("«capa nueva» pide un color hex; un destino inválido se explica", () => {
      const panel = props({ targetValue: NEW_LAYER_VALUE, newColorHex: "rojo", targetIssue: "«rojo» no es un color hex válido (#RGB o #RRGGBB) para la capa nueva." });
      render(<BooleanPanel {...panel} />);

      const hex = screen.getByLabelText("Color de la capa nueva (#RRGGBB)");
      fireEvent.change(hex, { target: { value: "#abc" } });

      expect(panel.onNewColorChange).toHaveBeenCalledWith("#abc");
      expect(hex).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByRole("alert")).toHaveTextContent(/no es un color hex válido/);
    });

    it("misma capa: no hay selector; se dice a qué capa va y con qué color", () => {
      render(<BooleanPanel {...props({ layersDiffer: false, resolvedTarget: { name: "Rojo", colorHex: "#ff0000", created: false } })} />);

      expect(screen.queryByLabelText(/Los operandos están en capas distintas/)).not.toBeInTheDocument();
      expect(screen.getByText(/Todos los operandos están en «Rojo»: el resultado va a esa capa/)).toBeInTheDocument();
    });
  });

  it("«Conservar originales» arranca desactivado y explica qué pasa con los operandos en cada caso", () => {
    const panel = props();
    const { rerender } = render(<BooleanPanel {...panel} />);

    expect(screen.getByRole("checkbox", { name: "Conservar originales" })).not.toBeChecked();
    expect(screen.getByText(/Los operandos se reemplazan por el resultado/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Conservar originales" }));
    expect(panel.onKeepOriginalsChange).toHaveBeenCalledWith(true);

    rerender(<BooleanPanel {...props({ keepOriginals: true })} />);
    expect(screen.getByText(/Los resultados se agregan y los operandos quedan/)).toBeInTheDocument();
  });

  it("la tolerancia es un campo avanzado en mm con mínimo y máximo: un valor fuera de rango se rechaza y conserva el anterior", () => {
    const panel = props();
    render(<BooleanPanel {...panel} />);

    const field = screen.getByLabelText("Tolerancia (mm)");
    expect(field).toHaveValue("0.01");
    fireEvent.change(field, { target: { value: "0,0001" } });
    fireEvent.blur(field);
    expect(panel.onToleranceChange).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/debe estar entre 0,001 \(inclusive\) y 1 mm/);

    fireEvent.change(field, { target: { value: "5" } });
    fireEvent.blur(field);
    expect(panel.onToleranceChange).not.toHaveBeenCalled();

    fireEvent.change(field, { target: { value: "0,05" } });
    fireEvent.blur(field);
    expect(panel.onToleranceChange).toHaveBeenCalledWith(0.05);
  });

  describe("estados del cálculo (región aria-live)", () => {
    const state = () => screen.getByRole("status");

    it("calculando…, esperando y listo se anuncian en una región de estado", () => {
      const { rerender } = render(<BooleanPanel {...props({ preview: { status: "calculating", readyText: null, empty: false, errorMessage: null } })} />);
      expect(state()).toHaveTextContent("Calculando en el servidor…");
      expect(state().closest("[aria-live]")).toHaveAttribute("aria-live", "polite");

      rerender(<BooleanPanel {...props({ preview: { status: "waiting", readyText: null, empty: false, errorMessage: null } })} />);
      expect(state()).toHaveTextContent("Esperando para calcular…");

      rerender(<BooleanPanel {...props()} />);
      expect(state()).toHaveTextContent("Resultado: 2 piezas.");
    });

    it("resultado vacío: lo dice y Apply queda deshabilitado con el motivo", () => {
      render(
        <BooleanPanel
          {...props({
            preview: { status: "ready", readyText: "El resultado está vacío: la operación no deja ninguna forma. No se puede aplicar.", empty: true, errorMessage: null },
            applyDisabledReason: "El resultado está vacío: no hay nada que aplicar.",
          })}
        />,
      );

      expect(screen.getByRole("status")).toHaveTextContent(/El resultado está vacío/);
      expect(applyButton()).toBeDisabled();
    });

    it("error recuperable: alerta con el mensaje y «Reintentar»; Apply deshabilitado", () => {
      const panel = props({
        preview: { status: "error", readyText: null, empty: false, errorMessage: "El motor de geometría no está disponible. No se modificó nada." },
        applyDisabledReason: "El cálculo falló: reintentalo o cambiá la operación.",
      });
      render(<BooleanPanel {...panel} />);

      expect(screen.getByRole("alert")).toHaveTextContent(/No se modificó nada/);
      fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
      expect(panel.onRetry).toHaveBeenCalledTimes(1);
      expect(applyButton()).toBeDisabled();
    });

    it("selección rechazada: alerta con el motivo y sin estado de cálculo", () => {
      render(<BooleanPanel {...props({ rejection: "Las booleanas operan sobre formas rellenas.", preview: { status: "idle", readyText: null, empty: false, errorMessage: null } })} />);

      expect(screen.getByRole("alert")).toHaveTextContent("Las booleanas operan sobre formas rellenas.");
      expect(screen.queryByText(/Calculando/)).not.toBeInTheDocument();
    });

    it("el mensaje del último intento de aplicar (resultado vacío, documento cambió...) se muestra como alerta", () => {
      render(<BooleanPanel {...props({ message: "El documento cambió mientras se calculaba. No se modificó nada." })} />);

      expect(screen.getByRole("alert")).toHaveTextContent(/El documento cambió/);
    });
  });

  it("Apply habilitado => llama a onApply; Cancel llama a onCancel; aplicando deshabilita Apply", () => {
    const panel = props({ layersDiffer: false, resolvedTarget: { name: "Rojo", colorHex: "#ff0000", created: false } });
    const { rerender } = render(<BooleanPanel {...panel} />);

    expect(applyButton()).toBeEnabled();
    expect(applyButton()).toHaveAttribute("title", "Aplicar la operación (Enter)");
    fireEvent.click(applyButton());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(panel.onApply).toHaveBeenCalledTimes(1);
    expect(panel.onCancel).toHaveBeenCalledTimes(1);

    rerender(<BooleanPanel {...panel} applying />);
    expect(applyButton()).toBeDisabled();
  });
});

describe("BooleanBar", () => {
  it("deshabilitada: los 4 botones explican por qué (tooltip y texto visible)", () => {
    const onStart = vi.fn();
    render(<BooleanBar unavailableReason="Seleccioná al menos 2 formas rellenas para una operación booleana." activeOp={null} notice={null} onStart={onStart} />);

    for (const name of ["Unión", "Diferencia", "Intersección", "XOR (exclusión)"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("title", expect.stringContaining("al menos 2 formas rellenas"));
    }
    expect(screen.getByText(/Seleccioná al menos 2 formas rellenas/, { selector: ".boolean-bar__hint" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Unión" }));
    expect(onStart).not.toHaveBeenCalled();
  });

  it("habilitada: cada botón inicia SU operación", () => {
    const onStart = vi.fn();
    render(<BooleanBar unavailableReason={null} activeOp={null} notice={null} onStart={onStart} />);

    fireEvent.click(screen.getByRole("button", { name: "Unión" }));
    fireEvent.click(screen.getByRole("button", { name: "Diferencia" }));
    fireEvent.click(screen.getByRole("button", { name: "Intersección" }));
    fireEvent.click(screen.getByRole("button", { name: "XOR (exclusión)" }));

    expect(onStart.mock.calls.map(([op]) => op)).toEqual(["union", "difference", "intersection", "xor"]);
    expect(screen.queryByText(/Seleccioná/)).not.toBeInTheDocument();
  });

  it("con una sesión abierta los botones siguen activos (cambian la operación) y el activo queda presionado", () => {
    render(<BooleanBar unavailableReason="no importa" activeOp="xor" notice={null} onStart={vi.fn()} />);

    expect(screen.getByRole("button", { name: "XOR (exclusión)" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Unión" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Unión" })).toBeEnabled();
  });

  it("el rechazo es una alerta y la confirmación va a la región de estado", () => {
    const { rerender } = render(<BooleanBar unavailableReason={null} activeOp={null} notice={{ kind: "error", text: "Las booleanas operan sobre formas rellenas." }} onStart={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Las booleanas operan sobre formas rellenas.");

    rerender(<BooleanBar unavailableReason={null} activeOp={null} notice={{ kind: "ok", text: "Unión aplicada." }} onStart={vi.fn()} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Unión aplicada.");
  });
});
