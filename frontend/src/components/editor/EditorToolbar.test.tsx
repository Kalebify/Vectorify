import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EditorToolbar } from "./EditorToolbar";

describe("EditorToolbar — shell completo del wireframe", () => {
  it("muestra los 11 íconos del wireframe + el Eyedropper (M3-S03), todos con nombre accesible", () => {
    render(<EditorToolbar activeTool="select" onSelectTool={vi.fn()} />);

    for (const label of ["Select", "Pan", "Crop", "Move", "Fill", "Color", "Eyedropper", "Draw", "Erase", "Offset", "Cut", "Path"]) {
      expect(screen.getByRole("button", { name: new RegExp(`^${label}`) })).toBeInTheDocument();
    }
  });

  it("Select, Pan, Move (M3-S01), Crop (M3-S02), Fill, Color, Eyedropper (M3-S03) y Draw, Erase (M3-S04) están habilitados; el resto está deshabilitado pero VISIBLE, con tooltip de MVP3", () => {
    render(<EditorToolbar activeTool="select" onSelectTool={vi.fn()} />);

    expect(screen.getByRole("button", { name: /^Select/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^Pan/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^Move/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^Crop/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^Fill/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^Color/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^Eyedropper/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^Draw/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^Erase/ })).toBeEnabled();

    for (const label of ["Offset", "Cut", "Path"]) {
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

  it("Fill, Color y Eyedropper (M3-S03) llaman a onSelectTool, se marcan con aria-pressed y el Eyedropper anuncia su atajo I", () => {
    const onSelectTool = vi.fn();
    const { rerender } = render(<EditorToolbar activeTool="select" onSelectTool={onSelectTool} />);

    expect(screen.getByRole("button", { name: /^Eyedropper/ })).toHaveAttribute("title", expect.stringContaining("I --"));
    for (const [label, tool] of [
      ["Fill", "fill"],
      ["Color", "color"],
      ["Eyedropper", "eyedropper"],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${label}`) }));
      expect(onSelectTool).toHaveBeenLastCalledWith(tool);
      rerender(<EditorToolbar activeTool={tool} onSelectTool={onSelectTool} />);
      expect(screen.getByRole("button", { name: new RegExp(`^${label}`) })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("button", { name: /^Select/ })).toHaveAttribute("aria-pressed", "false");
    }
  });

  it("Draw y Erase (M3-S04) llaman a onSelectTool, se marcan con aria-pressed y su título dice qué hacen", () => {
    const onSelectTool = vi.fn();
    const { rerender } = render(<EditorToolbar activeTool="select" onSelectTool={onSelectTool} />);

    expect(screen.getByRole("button", { name: /^Draw/ })).toHaveAttribute("title", expect.stringContaining("capa activa"));
    expect(screen.getByRole("button", { name: /^Erase/ })).toHaveAttribute("title", expect.stringContaining("restar geometría"));
    for (const [label, tool] of [
      ["Draw", "draw"],
      ["Erase", "erase"],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${label}`) }));
      expect(onSelectTool).toHaveBeenLastCalledWith(tool);
      rerender(<EditorToolbar activeTool={tool} onSelectTool={onSelectTool} />);
      expect(screen.getByRole("button", { name: new RegExp(`^${label}`) })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("button", { name: /^Select/ })).toHaveAttribute("aria-pressed", "false");
    }
  });

  it("clickear una herramienta deshabilitada no llama a onSelectTool", () => {
    const onSelectTool = vi.fn();
    render(<EditorToolbar activeTool="select" onSelectTool={onSelectTool} />);

    fireEvent.click(screen.getByRole("button", { name: /^Offset/ }));
    expect(onSelectTool).not.toHaveBeenCalled();
  });
});
