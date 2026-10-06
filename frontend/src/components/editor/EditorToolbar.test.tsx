import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EditorToolbar } from "./EditorToolbar";

describe("EditorToolbar — shell completo del wireframe", () => {
  it("muestra los 11 íconos del wireframe, todos con nombre accesible", () => {
    render(<EditorToolbar activeTool="select" onSelectTool={vi.fn()} />);

    for (const label of ["Select", "Pan", "Crop", "Move", "Fill", "Color", "Draw", "Erase", "Offset", "Cut", "Path"]) {
      expect(screen.getByRole("button", { name: new RegExp(`^${label}`) })).toBeInTheDocument();
    }
  });

  it("Select, Pan, Move (M3-S01) y Crop (M3-S02) están habilitados; el resto está deshabilitado pero VISIBLE, con tooltip de MVP3", () => {
    render(<EditorToolbar activeTool="select" onSelectTool={vi.fn()} />);

    expect(screen.getByRole("button", { name: /^Select/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^Pan/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^Move/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^Crop/ })).toBeEnabled();

    for (const label of ["Fill", "Color", "Draw", "Erase", "Offset", "Cut", "Path"]) {
      const button = screen.getByRole("button", { name: new RegExp(`^${label}`) });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("title", expect.stringContaining("MVP3"));
    }
  });

  it("marca la herramienta activa con aria-pressed (no depende solo del color)", () => {
    const { rerender } = render(<EditorToolbar activeTool="select" onSelectTool={vi.fn()} />);
    expect(screen.getByRole("button", { name: /^Select/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Pan/ })).toHaveAttribute("aria-pressed", "false");

    rerender(<EditorToolbar activeTool="pan" onSelectTool={vi.fn()} />);
    expect(screen.getByRole("button", { name: /^Pan/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("clickear Pan llama a onSelectTool('pan')", () => {
    const onSelectTool = vi.fn();
    render(<EditorToolbar activeTool="select" onSelectTool={onSelectTool} />);

    fireEvent.click(screen.getByRole("button", { name: /^Pan/ }));
    expect(onSelectTool).toHaveBeenCalledWith("pan");
  });

  it("Move (mover sin handles) se activa con aria-pressed y llama a onSelectTool('move')", () => {
    const onSelectTool = vi.fn();
    const { rerender } = render(<EditorToolbar activeTool="select" onSelectTool={onSelectTool} />);

    fireEvent.click(screen.getByRole("button", { name: /^Move/ }));
    expect(onSelectTool).toHaveBeenCalledWith("move");

    rerender(<EditorToolbar activeTool="move" onSelectTool={onSelectTool} />);
    expect(screen.getByRole("button", { name: /^Move/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Select/ })).toHaveAttribute("aria-pressed", "false");
  });

  it("Crop (M3-S02) se activa con aria-pressed, avisa que el original no se toca y llama a onSelectTool('crop')", () => {
    const onSelectTool = vi.fn();
    const { rerender } = render(<EditorToolbar activeTool="select" onSelectTool={onSelectTool} />);
    const crop = screen.getByRole("button", { name: /^Crop/ });
    expect(crop).toHaveAttribute("title", expect.stringContaining("el original no se toca"));

    fireEvent.click(crop);
    expect(onSelectTool).toHaveBeenCalledWith("crop");

    rerender(<EditorToolbar activeTool="crop" onSelectTool={onSelectTool} />);
    expect(screen.getByRole("button", { name: /^Crop/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Select/ })).toHaveAttribute("aria-pressed", "false");
  });

  it("clickear una herramienta deshabilitada no llama a onSelectTool", () => {
    const onSelectTool = vi.fn();
    render(<EditorToolbar activeTool="select" onSelectTool={onSelectTool} />);

    fireEvent.click(screen.getByRole("button", { name: /^Draw/ }));
    expect(onSelectTool).not.toHaveBeenCalled();
  });
});
