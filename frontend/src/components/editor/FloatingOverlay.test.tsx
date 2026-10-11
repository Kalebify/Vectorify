import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ViewportParams } from "../../lib/editor/viewport";
import { FloatingOverlay, type FloatingOverlayProps } from "./FloatingOverlay";

/** Viewport de prueba: contenedor 800 x 600, documento 320 x 240, escala 1 y pan 0 => pantalla = documento + (240, 180). */
const VIEWPORT: ViewportParams = { containerWidth: 800, containerHeight: 600, panX: 0, panY: 0, scale: 1, sourceWidth: 320, sourceHeight: 240 };

const ISSUES: FloatingOverlayProps["issues"] = [
  { id: 1, position: 1, d: "M10 10 L30 10 L30 30 L10 30 Z", rect: { x: 10, y: 10, width: 20, height: 20 } },
  { id: 3, position: 2, d: "M100 100 L140 100 L140 120 L100 120 Z", rect: { x: 100, y: 100, width: 40, height: 20 } },
];

function renderOverlay(overrides: Partial<Omit<FloatingOverlayProps, "viewport">> = {}) {
  return render(<FloatingOverlay viewport={VIEWPORT} issues={[]} selectedId={null} bridges={[]} {...overrides} />);
}

describe("FloatingOverlay (M3-S11)", () => {
  it("es de solo lectura: un SVG oculto a la tecnología asistiva que no captura el puntero (clase boolean-overlay) y del tamaño del contenedor", () => {
    renderOverlay();

    const svg = screen.getByTestId("floating-overlay");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveClass("boolean-overlay");
    expect(svg).toHaveAttribute("width", "800");
    expect(svg).toHaveAttribute("height", "600");
  });

  it("resalta CADA pieza flotante con su polígono (huecos par-impar) y le pone una insignia con su número, en el centro de su caja", () => {
    renderOverlay({ issues: ISSUES });

    const paths = screen.getAllByTestId("floating-issue");
    expect(paths.map((path) => path.getAttribute("d"))).toEqual(ISSUES.map((issue) => issue.d));
    expect(paths[0]).toHaveAttribute("fill-rule", "evenodd");
    expect(paths.map((path) => path.getAttribute("data-issue"))).toEqual(["1", "3"]);
    const badges = screen.getAllByTestId("floating-badge");
    expect(badges.map((badge) => badge.textContent)).toEqual(["1", "2"]);
    // Centro de la caja 10..30 x 10..30 = (20, 20) -> pantalla (260, 200).
    expect(badges[0].querySelector("circle")).toHaveAttribute("cx", "260");
    expect(badges[0].querySelector("circle")).toHaveAttribute("cy", "200");
    expect(badges[1].querySelector("circle")).toHaveAttribute("cx", "360"); // centro (120, 110) -> (360, 290)
    expect(badges[1].querySelector("circle")).toHaveAttribute("cy", "290");
  });

  it("la pieza SELECCIONADA se distingue de las demás: color, trazo más grueso y una marca en el DOM", () => {
    renderOverlay({ issues: ISSUES, selectedId: 3 });

    const [normal, selected] = screen.getAllByTestId("floating-issue");
    expect(normal).toHaveAttribute("data-selected", "false");
    expect(selected).toHaveAttribute("data-selected", "true");
    expect(Number(selected.getAttribute("stroke-width"))).toBeGreaterThan(Number(normal.getAttribute("stroke-width")));
    expect(selected.getAttribute("fill")).not.toBe(normal.getAttribute("fill"));
    expect(Number(selected.getAttribute("fill-opacity"))).toBeGreaterThan(Number(normal.getAttribute("fill-opacity")));
  });

  it("los trazos no se engrosan con el zoom y el grupo sigue la transformación del canvas (origen del documento y escala)", () => {
    renderOverlay({ issues: ISSUES });

    const group = screen.getByTestId("floating-overlay").querySelector("g")!;
    expect(group).toHaveAttribute("transform", "translate(240 180) scale(1)");
    expect(screen.getAllByTestId("floating-issue")[0]).toHaveAttribute("vector-effect", "non-scaling-stroke");

    const zoomed = render(<FloatingOverlay viewport={{ ...VIEWPORT, scale: 4, panX: 10, panY: -20 }} issues={ISSUES} selectedId={null} bridges={[]} />);
    // Origen del documento a escala 4: 400 - 160·4 + 10 = -230 ; 300 - 120·4 - 20 = -200.
    expect(zoomed.container.querySelector("g")).toHaveAttribute("transform", "translate(-230 -200) scale(4)");
  });

  it("dibuja los bridges: verde sólido los válidos, rojo DISCONTINUO los inválidos, con su ancla; uno sin rectángulo no dibuja ni rompe", () => {
    renderOverlay({
      issues: ISSUES,
      bridges: [
        { index: 0, valid: true, d: "M29.96 19.2 L40.04 19.2 L40.04 20.8 L29.96 20.8 Z", anchor: { x: 30, y: 20 } },
        { index: 1, valid: false, d: "M100 100 L110 100 L110 101 L100 101 Z", anchor: { x: 100, y: 100.5 } },
        { index: 2, valid: false, d: null, anchor: null },
      ],
    });

    const bridges = screen.getAllByTestId("floating-bridge");
    expect(bridges).toHaveLength(2);
    expect(bridges[0]).toHaveAttribute("data-valid", "true");
    expect(bridges[0]).not.toHaveAttribute("stroke-dasharray");
    expect(bridges[1]).toHaveAttribute("data-valid", "false");
    expect(bridges[1]).toHaveAttribute("stroke-dasharray");
    expect(bridges[0].getAttribute("fill")).not.toBe(bridges[1].getAttribute("fill"));
    const anchors = screen.getAllByTestId("floating-anchor");
    expect(anchors).toHaveLength(2);
    expect(anchors[0]).toHaveAttribute("cx", "270"); // (30, 20) -> (270, 200)
    expect(anchors[0]).toHaveAttribute("cy", "200");
  });

  it("sin piezas ni bridges solo queda el SVG vacío", () => {
    renderOverlay();

    expect(screen.queryByTestId("floating-issue")).not.toBeInTheDocument();
    expect(screen.queryByTestId("floating-badge")).not.toBeInTheDocument();
    expect(screen.queryByTestId("floating-bridge")).not.toBeInTheDocument();
  });
});
