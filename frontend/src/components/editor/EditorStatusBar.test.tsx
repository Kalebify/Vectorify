import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EditorStatusBar } from "./EditorStatusBar";

describe("EditorStatusBar — zoom/fit/dimensiones", () => {
  it("muestra el zoom actual redondeado a %", () => {
    render(<EditorStatusBar scale={0.683} onZoomBy={vi.fn()} onFit={vi.fn()} sourceWidthPx={320} sourceHeightPx={240} />);
    expect(screen.getByText("68%")).toBeInTheDocument();
  });

  it("+ / - llaman a onZoomBy con un factor >1 / <1 respectivamente", () => {
    const onZoomBy = vi.fn();
    render(<EditorStatusBar scale={1} onZoomBy={onZoomBy} onFit={vi.fn()} sourceWidthPx={320} sourceHeightPx={240} />);

    fireEvent.click(screen.getByRole("button", { name: "Acercar" }));
    expect(onZoomBy).toHaveBeenLastCalledWith(expect.any(Number));
    expect(onZoomBy.mock.calls[0][0]).toBeGreaterThan(1);

    fireEvent.click(screen.getByRole("button", { name: "Alejar" }));
    expect(onZoomBy.mock.calls[1][0]).toBeLessThan(1);
  });

  it("FIT llama a onFit", () => {
    const onFit = vi.fn();
    render(<EditorStatusBar scale={1} onZoomBy={vi.fn()} onFit={onFit} sourceWidthPx={320} sourceHeightPx={240} />);
    fireEvent.click(screen.getByRole("button", { name: "FIT" }));
    expect(onFit).toHaveBeenCalled();
  });

  it("muestra las dimensiones reales del documento en px (nunca mm inventados)", () => {
    render(<EditorStatusBar scale={1} onZoomBy={vi.fn()} onFit={vi.fn()} sourceWidthPx={320} sourceHeightPx={240} />);
    expect(screen.getByText("320 × 240 px")).toBeInTheDocument();
  });

  it("GRID y SNAP están presentes pero deshabilitados", () => {
    render(<EditorStatusBar scale={1} onZoomBy={vi.fn()} onFit={vi.fn()} sourceWidthPx={320} sourceHeightPx={240} />);
    expect(screen.getByRole("button", { name: /Grilla/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Ajuste a grilla/ })).toBeDisabled();
  });

  it("con escala física conocida (M3-S02) muestra también los mm del área de trabajo, además de los px", () => {
    render(<EditorStatusBar scale={1} onZoomBy={vi.fn()} onFit={vi.fn()} sourceWidthPx={200} sourceHeightPx={100} widthMm={100} heightMm={50} />);
    expect(screen.getByText("100 × 50 mm")).toBeInTheDocument();
    expect(screen.getByLabelText("Tamaño físico del área de trabajo: 100 por 50 milímetros")).toBeInTheDocument();
    expect(screen.getByText("200 × 100 px")).toBeInTheDocument();
  });

  it("sin escala física NO muestra mm (nunca datos inventados) y redondea los decimales de un recorte", () => {
    render(<EditorStatusBar scale={1} onZoomBy={vi.fn()} onFit={vi.fn()} sourceWidthPx={123.456789} sourceHeightPx={99.5} />);
    expect(screen.queryByText(/mm/)).not.toBeInTheDocument();
    expect(screen.getByText("123.46 × 99.5 px")).toBeInTheDocument();
  });

  it("los mm acompañan los cambios del área de trabajo (rerender tras un crop)", () => {
    const { rerender } = render(<EditorStatusBar scale={1} onZoomBy={vi.fn()} onFit={vi.fn()} sourceWidthPx={400} sourceHeightPx={200} widthMm={200} heightMm={100} />);
    expect(screen.getByText("200 × 100 mm")).toBeInTheDocument();
    rerender(<EditorStatusBar scale={1} onZoomBy={vi.fn()} onFit={vi.fn()} sourceWidthPx={200} sourceHeightPx={200} widthMm={100} heightMm={100} />);
    expect(screen.getByText("100 × 100 mm")).toBeInTheDocument();
    expect(screen.queryByText("200 × 100 mm")).not.toBeInTheDocument();
  });
});
