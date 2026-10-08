import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PaletteBar } from "./PaletteBar";
import type { VectorDocumentLayer } from "../../hooks/useVectorDocument";

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

describe("PaletteBar — estado vacío", () => {
  it("sin capas muestra un mensaje honesto, no swatches inventados", () => {
    render(<PaletteBar layers={[]} selectedGroupId={null} onSelectGroup={vi.fn()} />);
    expect(screen.getByText("Sin paleta confirmada")).toBeInTheDocument();
  });
});

describe("PaletteBar — swatches de la paleta confirmada", () => {
  it("un swatch por capa, con nombre accesible y color real", () => {
    render(
      <PaletteBar
        layers={[layer(), layer({ groupId: "group-b", name: "Azul", colorHex: "#0000ff" })]}
        selectedGroupId={null}
        onSelectGroup={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /Rojo \(#ff0000\)/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Azul \(#0000ff\)/ })).toBeInTheDocument();
  });

  it("clic en un swatch selecciona ese groupId (mismo groupId compartido con el resto)", () => {
    const onSelectGroup = vi.fn();
    render(<PaletteBar layers={[layer()]} selectedGroupId={null} onSelectGroup={onSelectGroup} />);

    fireEvent.click(screen.getByRole("button", { name: /Rojo/ }));
    expect(onSelectGroup).toHaveBeenCalledWith("group-a");
  });

  it("el swatch seleccionado se marca con aria-pressed Y un check visual, no solo color", () => {
    render(<PaletteBar layers={[layer()]} selectedGroupId="group-a" onSelectGroup={vi.fn()} />);

    const button = screen.getByRole("button", { name: /Rojo/ });
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(button.querySelector(".palette-bar__swatch-check")).toBeInTheDocument();
  });

  it('el botón "+" está presente pero deshabilitado (agregar color es MVP3)', () => {
    render(<PaletteBar layers={[layer()]} selectedGroupId={null} onSelectGroup={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Agregar color/ })).toBeDisabled();
  });
});

describe("PaletteBar — capas creadas por el editor y color activo (M3-S03)", () => {
  it("una capa NUEVA (isNew) aparece al instante con el estilo punteado y 'capa nueva' en su nombre accesible; las del servidor no", () => {
    render(
      <PaletteBar
        layers={[layer(), layer({ groupId: "group-n", name: "Color #00FF00", colorHex: "#00FF00", isNew: true, order: 1 })]}
        selectedGroupId={null}
        onSelectGroup={vi.fn()}
      />,
    );
    const created = screen.getByRole("button", { name: /Color #00FF00 \(#00FF00\) \(capa nueva\)/ });
    expect(created).toHaveClass("palette-bar__swatch--new");
    expect(created).toHaveAttribute("title", expect.stringContaining("capa nueva, sin guardar"));
    expect(screen.getByRole("button", { name: /Rojo/ })).not.toHaveClass("palette-bar__swatch--new");
    expect(screen.getByRole("button", { name: /Rojo/ }).getAttribute("aria-label")).not.toMatch(/capa nueva/);
  });

  it("refleja un color cambiado (misma capa, otro hex) en el swatch y su nombre accesible", () => {
    const { rerender } = render(<PaletteBar layers={[layer()]} selectedGroupId={null} onSelectGroup={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Rojo \(#ff0000\)/ })).toHaveStyle({ backgroundColor: "#ff0000" });
    rerender(<PaletteBar layers={[layer({ colorHex: "#00ff00" })]} selectedGroupId={null} onSelectGroup={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Rojo \(#00ff00\)/ })).toHaveStyle({ backgroundColor: "#00ff00" });
  });

  it("marca la capa del color activo (no solo con color: también en el nombre accesible)", () => {
    render(
      <PaletteBar layers={[layer(), layer({ groupId: "group-b", name: "Rojo 2", colorHex: "#ff0000", order: 1 })]} selectedGroupId={null} onSelectGroup={vi.fn()} activeColorGroupId="group-b" />,
    );
    const active = screen.getByRole("button", { name: /Rojo 2 .*\(color activo\)/ });
    expect(active).toHaveClass("palette-bar__swatch--active-color");
    // Mismo hex, otra capa: NO se marca (la identidad es la capa, no el hex).
    expect(screen.getByRole("button", { name: /^Seleccionar el color Rojo \(#ff0000\)$/ })).not.toHaveClass("palette-bar__swatch--active-color");
  });

  it("nombre del grupo, etiqueta de los swatches y '[+]' son configurables (el panel de color reutiliza la barra)", () => {
    render(<PaletteBar layers={[layer()]} selectedGroupId="group-a" onSelectGroup={vi.fn()} ariaLabel="Colores de la paleta para aplicar" swatchLabel={(l) => `Usar ${l.name}`} showAdd={false} />);
    expect(screen.getByRole("group", { name: "Colores de la paleta para aplicar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Usar Rojo" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Agregar color/ })).not.toBeInTheDocument();
  });
});
