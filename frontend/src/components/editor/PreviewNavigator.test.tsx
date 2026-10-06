import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PreviewNavigator } from "./PreviewNavigator";
import type { VectorDocumentLayer } from "../../hooks/useVectorDocument";
import { IDENTITY_TRANSFORM } from "../../hooks/useCanvasTransform";

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

describe("PreviewNavigator — sin documento", () => {
  it("muestra un estado vacío honesto", () => {
    render(
      <PreviewNavigator layers={[]} visibility={{}} sourceWidthPx={0} sourceHeightPx={0} transform={IDENTITY_TRANSFORM} viewportSize={{ width: 0, height: 0 }} />,
    );
    expect(screen.getByText(/Sin documento para previsualizar/)).toBeInTheDocument();
  });
});

describe("PreviewNavigator — documento multicolor", () => {
  it("dibuja una miniatura con una imagen por capa VISIBLE", () => {
    render(
      <PreviewNavigator
        layers={[layer(), layer({ groupId: "group-b", name: "Azul" })]}
        visibility={{ "group-a": true, "group-b": false }}
        sourceWidthPx={320}
        sourceHeightPx={240}
        transform={IDENTITY_TRANSFORM}
        viewportSize={{ width: 800, height: 600 }}
      />,
    );

    const frame = screen.getByRole("img", { name: /1 de 2 capas visibles/ });
    expect(frame.querySelectorAll("img")).toHaveLength(1);
  });

  it("una capa con ediciones de geometría (M3-S01) se dibuja desde su override en memoria; las intactas conservan su svgUrl", () => {
    render(
      <PreviewNavigator
        layers={[layer(), layer({ groupId: "group-b", name: "Azul", svgUrl: "/vectors/b" })]}
        visibility={{ "group-a": true, "group-b": true }}
        sourceWidthPx={320}
        sourceHeightPx={240}
        transform={IDENTITY_TRANSFORM}
        viewportSize={{ width: 800, height: 600 }}
        layerImageOverrides={{ "group-a": "data:image/svg+xml;charset=utf-8,editada" }}
      />,
    );

    const images = screen.getByRole("img", { name: /2 de 2 capas visibles/ }).querySelectorAll("img");
    expect(images[0]).toHaveAttribute("src", "data:image/svg+xml;charset=utf-8,editada");
    expect(images[1]).toHaveAttribute("src", "/vectors/b");
  });

  it("dibuja el rectángulo de viewport cuando hay medidas suficientes", () => {
    const { container } = render(
      <PreviewNavigator
        layers={[layer()]}
        visibility={{ "group-a": true }}
        sourceWidthPx={320}
        sourceHeightPx={240}
        transform={{ scale: 1, panX: 0, panY: 0 }}
        viewportSize={{ width: 320, height: 240 }}
      />,
    );

    expect(container.querySelector(".preview-navigator__viewport")).toBeInTheDocument();
  });
});
