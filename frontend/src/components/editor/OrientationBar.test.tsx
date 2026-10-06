import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OrientationBar } from "./OrientationBar";

function renderBar(overrides: Partial<React.ComponentProps<typeof OrientationBar>> = {}) {
  const props: React.ComponentProps<typeof OrientationBar> = {
    scopeText: "Sin selección: rotar y reflejar afectan a TODO el documento.",
    pending: false,
    pendingText: null,
    pendingIsIdentity: false,
    message: null,
    onStep: vi.fn(),
    onApply: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  return { ...render(<OrientationBar {...props} />), props };
}

describe("OrientationBar — Rotate 90° / Flip", () => {
  it("expone los 4 botones con nombre accesible y atajo documentado en el title", () => {
    renderBar();
    expect(screen.getByRole("toolbar", { name: "Rotar y reflejar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rotar 90° antihorario" })).toHaveAttribute("title", "Rotar 90° antihorario (Shift+R)");
    expect(screen.getByRole("button", { name: "Rotar 90° horario" })).toHaveAttribute("title", "Rotar 90° horario (R)");
    expect(screen.getByRole("button", { name: "Reflejar horizontalmente" })).toHaveAttribute("title", "Reflejar horizontalmente (F)");
    expect(screen.getByRole("button", { name: "Reflejar verticalmente" })).toHaveAttribute("title", "Reflejar verticalmente (Shift+F)");
  });

  it("cada botón pide su paso", () => {
    const { props } = renderBar();
    fireEvent.click(screen.getByRole("button", { name: "Rotar 90° antihorario" }));
    fireEvent.click(screen.getByRole("button", { name: "Rotar 90° horario" }));
    fireEvent.click(screen.getByRole("button", { name: "Reflejar horizontalmente" }));
    fireEvent.click(screen.getByRole("button", { name: "Reflejar verticalmente" }));
    expect((props.onStep as ReturnType<typeof vi.fn>).mock.calls.map(([step]) => step)).toEqual(["rotate-ccw", "rotate-cw", "flip-horizontal", "flip-vertical"]);
  });

  it("sin transformación pendiente muestra el ALCANCE (documento o selección) y no hay Apply/Cancel", () => {
    const { rerender, props } = renderBar();
    expect(screen.getByRole("status")).toHaveTextContent("TODO el documento");
    expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();

    rerender(<OrientationBar {...props} scopeText="Rotar y reflejar afectan a la selección (2 objetos)." />);
    expect(screen.getByRole("status")).toHaveTextContent("la selección (2 objetos)");
  });

  it("con una transformación pendiente dice QUÉ se va a modificar y pide Apply / Cancel", () => {
    const { props } = renderBar({ pending: true, pendingText: "Se rotará TODO el documento: Rotar 90° horario." });
    expect(screen.getByRole("status")).toHaveTextContent("Se rotará TODO el documento: Rotar 90° horario.");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(props.onApply).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Apply" })).toHaveAttribute("title", expect.stringContaining("Enter"));
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveAttribute("title", expect.stringContaining("Escape"));
  });

  it("si la orientación acumulada vuelve a la identidad lo dice y deshabilita Apply (Cancel sigue disponible)", () => {
    renderBar({ pending: true, pendingText: "Se rotará TODO el documento: Sin cambios.", pendingIsIdentity: true });
    expect(screen.getByRole("status")).toHaveTextContent("Sin cambios respecto del estado actual.");
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("un rechazo (capas bloqueadas) se muestra como alerta visible", () => {
    renderBar({ message: "Desbloqueá las capas para transformar el documento completo, o seleccioná objetos." });
    expect(screen.getByRole("alert")).toHaveTextContent("Desbloqueá las capas para transformar el documento completo, o seleccioná objetos.");
  });

  it("sin mensaje no hay alerta", () => {
    renderBar();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
