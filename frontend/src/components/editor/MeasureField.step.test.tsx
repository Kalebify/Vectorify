import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MeasureField } from "./MeasureField";

/** Flechas ↑/↓ del campo numérico (M3-S09, offset): confirman `valor ± paso` con la misma validación que el texto. */
describe("MeasureField — paso con flechas", () => {
  function setup(value = 1, props: { step?: number; max?: number; min?: number; unitLabel?: string } = {}) {
    const onCommit = vi.fn();
    render(<MeasureField label="Offset" value={value} unitLabel={props.unitLabel ?? "mm"} max={props.max ?? 1000} min={props.min} step={props.step} onCommit={onCommit} />);
    return { onCommit, input: screen.getByLabelText(`Offset (${props.unitLabel ?? "mm"})`) as HTMLInputElement };
  }

  it("ArrowUp suma el paso y ArrowDown lo resta, sin arrastrar ruido de coma flotante (0,1 + 0,2 = 0,3)", () => {
    const { onCommit, input } = setup(0.1, { step: 0.2 });

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(onCommit).toHaveBeenLastCalledWith(0.3);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(onCommit).toHaveBeenCalledTimes(1); // 0,1 - 0,2 < 0: rechazado
    expect(screen.getByRole("alert")).toHaveTextContent(/debe estar entre 0/);
  });

  it("ArrowDown baja el paso mientras el resultado siga siendo válido", () => {
    const { onCommit, input } = setup(1, { step: 0.1 });

    fireEvent.keyDown(input, { key: "ArrowDown" });

    expect(onCommit).toHaveBeenLastCalledWith(0.9);
  });

  it("no pasa del máximo: el paso que lo excede se rechaza con el mensaje y conserva el valor", () => {
    const { onCommit, input } = setup(1000, { step: 0.1, max: 1000 });

    fireEvent.keyDown(input, { key: "ArrowUp" });

    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/debe estar entre 0.*1\.?000 mm/);
    expect(input.value).toBe("1000");
  });

  it("respeta el mínimo del campo", () => {
    const { onCommit, input } = setup(0.002, { step: 0.001, min: 0.001, max: 1 });

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(onCommit).toHaveBeenLastCalledWith(0.001);

    fireEvent.keyDown(input, { key: "ArrowDown" }); // sigue mostrando 0,002 (el valor es controlado): 0,002 - 0,001 = 0,001 de nuevo
    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  it("parte del borrador si es un número válido (el usuario escribió 2 y apretó ↑ => 2,1)", () => {
    const { onCommit, input } = setup(1, { step: 0.1 });

    fireEvent.change(input, { target: { value: "2" } });
    fireEvent.keyDown(input, { key: "ArrowUp" });

    expect(onCommit).toHaveBeenLastCalledWith(2.1);
  });

  it("si el borrador no es un número válido, parte del valor vigente", () => {
    const { onCommit, input } = setup(1, { step: 0.1 });

    fireEvent.change(input, { target: { value: "abc" } });
    fireEvent.keyDown(input, { key: "ArrowUp" });

    expect(onCommit).toHaveBeenLastCalledWith(1.1);
  });

  it("sin `step` las flechas no hacen nada (los campos de Draw/Erase no cambian)", () => {
    const { onCommit, input } = setup(1);

    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "ArrowDown" });

    expect(onCommit).not.toHaveBeenCalled();
  });

  it("la unidad puede ser cualquier texto (p. ej. «×» para el límite de inglete)", () => {
    const { input } = setup(2, { step: 1, unitLabel: "×", max: 100 });

    expect(input.labels?.[0]).toHaveTextContent("Offset (×)");
  });
});
