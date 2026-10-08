import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DrawTargetStatus } from "../../hooks/useDrawEraseTools";
import { DrawPanel } from "./DrawPanel";
import { ErasePanel } from "./ErasePanel";
import { MeasureField } from "./MeasureField";

const EXISTING: DrawTargetStatus = { kind: "existing", layerName: "Rojo", message: null };

function renderDraw(overrides: Partial<Parameters<typeof DrawPanel>[0]> = {}) {
  const props = {
    mode: "polyline" as const,
    onModeChange: vi.fn(),
    unitLabel: "mm" as const,
    lineWidth: 0.1,
    onLineWidthChange: vi.fn(),
    simplify: 0.2,
    onSimplifyChange: vi.fn(),
    closeFreehand: false,
    onCloseFreehandChange: vi.fn(),
    pointCount: 0,
    target: EXISTING,
    message: null,
    serverError: null,
    busy: false,
    onFinish: vi.fn(),
    onUndoPoint: vi.fn(),
    onCancel: vi.fn(),
    onCancelCalculation: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<DrawPanel {...props} />) };
}

describe("DrawPanel", () => {
  it("indica el modo activo y la capa de destino; en polilínea no muestra la simplificación", () => {
    renderDraw();

    expect(screen.getByText("Polilínea", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText("«Rojo»")).toBeInTheDocument();
    expect(screen.getByLabelText("Ancho de línea (mm)")).toHaveValue("0.1");
    expect(screen.queryByLabelText("Simplificación (mm)")).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Polilínea" })).toBeChecked();
  });

  it("el cambio de modo notifica; en mano alzada aparecen la simplificación y «cerrar al soltar»", () => {
    const { props, rerender } = renderDraw();
    fireEvent.click(screen.getByRole("radio", { name: "Mano alzada" }));
    expect(props.onModeChange).toHaveBeenCalledWith("freehand");

    rerender(<DrawPanel {...props} mode="freehand" />);
    expect(screen.getByLabelText("Simplificación (mm)")).toHaveValue("0.2");
    fireEvent.click(screen.getByRole("checkbox", { name: "Cerrar el trazo al soltar" }));
    expect(props.onCloseFreehandChange).toHaveBeenCalledWith(true);
    expect(screen.queryByRole("button", { name: "Terminar" })).not.toBeInTheDocument();
  });

  it("sin capa activa avisa que se creará «Dibujo»; con capa bloqueada u oculta avisa y muestra el motivo como alerta", () => {
    const { props, rerender } = renderDraw({ target: { kind: "create", layerName: null, message: null } });
    expect(screen.getByText(/No hay capa activa: al dibujar se creará la capa/)).toBeInTheDocument();

    rerender(<DrawPanel {...props} target={{ kind: "rejected", layerName: "Candado", message: "La capa «Candado» está bloqueada. Desbloqueá la capa «Candado» o elegí otra. No se creó nada." }} />);
    expect(screen.getByText("No se puede dibujar en «Candado».")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Desbloqueá la capa «Candado» o elegí otra");
  });

  it("los botones de la polilínea se habilitan según los puntos colocados y llaman a sus acciones", () => {
    const { props, rerender } = renderDraw({ pointCount: 1 });
    expect(screen.getByRole("button", { name: "Terminar" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cerrar" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Quitar último punto" })).toBeEnabled();

    rerender(<DrawPanel {...props} pointCount={2} />);
    expect(screen.getByRole("button", { name: "Terminar" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cerrar" })).toBeDisabled();

    rerender(<DrawPanel {...props} pointCount={3} />);
    fireEvent.click(screen.getByRole("button", { name: "Terminar" }));
    expect(props.onFinish).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
    expect(props.onFinish).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Quitar último punto" }));
    expect(props.onUndoPoint).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(props.onCancel).toHaveBeenCalled();
    expect(screen.getByText("3 puntos colocados.")).toBeInTheDocument();
  });

  it("calculando: muestra el estado, deshabilita terminar/cerrar y ofrece cancelar el cálculo", () => {
    const { props } = renderDraw({ pointCount: 4, busy: true });

    expect(screen.getByRole("status")).toHaveTextContent("Calculando en el servidor…");
    expect(screen.getByRole("button", { name: "Terminar" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cerrar" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar cálculo" }));
    expect(props.onCancelCalculation).toHaveBeenCalled();
  });

  it("muestra el mensaje de rechazo y, si no hay, el error del servidor", () => {
    const { props, rerender } = renderDraw({ message: "El trazo cerrado no encierra área." });
    expect(screen.getByRole("alert")).toHaveTextContent("El trazo cerrado no encierra área.");

    rerender(<DrawPanel {...props} message={null} serverError="El motor de geometría no está disponible." />);
    expect(screen.getByRole("alert")).toHaveTextContent("El motor de geometría no está disponible.");
  });

  it("sin escala física el panel trabaja en unidades (u)", () => {
    renderDraw({ unitLabel: "u" });
    expect(screen.getByLabelText("Ancho de línea (u)")).toBeInTheDocument();
  });
});

function renderErase(overrides: Partial<Parameters<typeof ErasePanel>[0]> = {}) {
  const props = {
    mode: "geometry" as const,
    onModeChange: vi.fn(),
    unitLabel: "mm" as const,
    radius: 2,
    onRadiusChange: vi.fn(),
    scope: "active-layer" as const,
    onScopeChange: vi.fn(),
    activeLayerName: "Rojo",
    busy: false,
    message: null,
    serverError: null,
    onCancelCalculation: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<ErasePanel {...props} />) };
}

describe("ErasePanel", () => {
  it("restar geometría: modo indicado, radio en mm y alcance con el nombre de la capa activa", () => {
    renderErase();

    expect(screen.getByText("Restar geometría", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByLabelText("Radio del pincel (mm)")).toHaveValue("2");
    expect(screen.getByRole("radio", { name: /Solo capa activa \(«Rojo»\)/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Todas las capas desbloqueadas" })).not.toBeChecked();
  });

  it("sin capa activa el alcance por defecto lo dice", () => {
    renderErase({ activeLayerName: null });
    expect(screen.getByRole("radio", { name: /Solo capa activa \(ninguna elegida\)/ })).toBeInTheDocument();
  });

  it("modo Objeto: indicado, sin radio ni alcance", () => {
    renderErase({ mode: "object" });

    expect(screen.getByText("Objeto", { selector: "strong" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Radio del pincel (mm)")).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /capa activa/ })).not.toBeInTheDocument();
  });

  it("notifica el cambio de modo y de alcance", () => {
    const { props } = renderErase();
    fireEvent.click(screen.getByRole("radio", { name: "Objeto" }));
    expect(props.onModeChange).toHaveBeenCalledWith("object");
    fireEvent.click(screen.getByRole("radio", { name: "Todas las capas desbloqueadas" }));
    expect(props.onScopeChange).toHaveBeenCalledWith("unlocked-layers");
  });

  it("calculando muestra el estado con cancelar; los errores del servidor son alertas", () => {
    const { props, rerender } = renderErase({ busy: true });
    expect(screen.getByRole("status")).toHaveTextContent("Calculando en el servidor…");
    fireEvent.click(screen.getByRole("button", { name: "Cancelar cálculo" }));
    expect(props.onCancelCalculation).toHaveBeenCalled();

    rerender(<ErasePanel {...props} busy={false} serverError="El cálculo tardó demasiado. No se modificó nada." />);
    expect(screen.getByRole("alert")).toHaveTextContent("No se modificó nada");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("MeasureField", () => {
  function setup(value = 2, max = 100) {
    const onCommit = vi.fn();
    render(<MeasureField label="Radio" value={value} unitLabel="mm" max={max} onCommit={onCommit} />);
    const input = screen.getByLabelText("Radio (mm)") as HTMLInputElement;
    return { onCommit, input };
  }

  it("confirma con Enter (acepta coma decimal) y con blur", () => {
    const { onCommit, input } = setup();
    fireEvent.change(input, { target: { value: "2,5" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenLastCalledWith(2.5);

    fireEvent.change(input, { target: { value: "7" } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenLastCalledWith(7);
  });

  it("rechaza texto, cero, negativos y valores sobre el máximo con mensaje, sin llamar a onCommit y conservando el valor", () => {
    const { onCommit, input } = setup();
    for (const [text, message] of [
      ["abc", /no es un número válido/],
      ["", /no es un número válido/],
      ["0", /debe estar entre 0/],
      ["-1", /debe estar entre 0/],
      ["101", /debe estar entre 0.*100/],
    ] as const) {
      fireEvent.change(input, { target: { value: text } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(screen.getByRole("alert")).toHaveTextContent(message);
      expect(input.value).toBe("2");
    }
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("el valor máximo exacto es válido; un valor sin cambios no dispara onCommit; un valor bueno limpia el error", () => {
    const { onCommit, input } = setup(2, 100);
    fireEvent.change(input, { target: { value: "100" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenLastCalledWith(100);

    fireEvent.change(input, { target: { value: "2" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledTimes(1);

    fireEvent.change(input, { target: { value: "x" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "5" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("Escape descarta el borrador del campo", () => {
    const { onCommit, input } = setup();
    fireEvent.change(input, { target: { value: "9" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(input.value).toBe("2");
    expect(onCommit).not.toHaveBeenCalled();
  });
});
