import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ViewportParams } from "../../lib/editor/viewport";
import { IDENTITY_MATRIX } from "../../lib/svgTransform";
import { LaserCheckOverlay, type LaserCheckOverlayIssue } from "./LaserCheckOverlay";

const VIEWPORT: ViewportParams = { containerWidth: 800, containerHeight: 600, panX: 0, panY: 0, scale: 2, sourceWidth: 320, sourceHeight: 240 };

const error: LaserCheckOverlayIssue = {
  id: "open_path:a",
  severity: "error",
  highlights: [{ d: "M0 0 H10 V10", matrix: IDENTITY_MATRIX, filled: true }],
  rect: { x: 0, y: 0, width: 10, height: 10 },
};
const warning: LaserCheckOverlayIssue = {
  id: "tiny_detail:b",
  severity: "warning",
  highlights: [{ d: "M20 0 H30 V10", matrix: { a: 1, b: 0, c: 0, d: 1, e: 5, f: 7 }, filled: false }],
  rect: { x: 25, y: 7, width: 10, height: 10 },
};
const layerLevel: LaserCheckOverlayIssue = { id: "complexity:layer-A", severity: "warning", highlights: [], rect: { x: 100, y: 100, width: 50, height: 50 } };

const groups = () => screen.getAllByTestId("laser-check-issue");

describe("LaserCheckOverlay", () => {
  it("es un SVG decorativo de solo lectura (no captura el puntero) con la transformación del canvas", () => {
    const { container } = render(<LaserCheckOverlay viewport={VIEWPORT} issues={[error]} selectedId={null} />);

    const svg = screen.getByTestId("laser-check-overlay");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveClass("boolean-overlay");
    expect(svg).toHaveAttribute("width", "800");
    // El origen del documento cae en (400 - 160 * 2, 300 - 120 * 2) = (80, 60).
    expect(container.querySelector("svg > g")?.getAttribute("transform")).toBe("translate(80 60) scale(2)");
  });

  it("dibuja la geometría de cada issue: rojo para bloqueantes, naranja para avisos; relleno solo si el objeto lo tiene", () => {
    render(<LaserCheckOverlay viewport={VIEWPORT} issues={[error, warning]} selectedId={null} />);

    const [first, second] = screen.getAllByTestId("laser-check-highlight");
    expect(first).toHaveAttribute("stroke", "#dc2626");
    expect(first).toHaveAttribute("fill", "#dc2626");
    expect(second).toHaveAttribute("stroke", "#d97706");
    expect(second).toHaveAttribute("fill", "none");
    expect(groups().map((group) => group.getAttribute("data-severity"))).toEqual(["error", "warning"]);
  });

  it("aplica la matriz del objeto al resaltado (la identidad no agrega transform)", () => {
    render(<LaserCheckOverlay viewport={VIEWPORT} issues={[error, warning]} selectedId={null} />);

    const [first, second] = screen.getAllByTestId("laser-check-highlight");
    expect(first).not.toHaveAttribute("transform");
    expect(second).toHaveAttribute("transform", "matrix(1 0 0 1 5 7)");
  });

  it("el issue activado se resalta más fuerte, con su rectángulo, y se dibuja el último (encima)", () => {
    render(<LaserCheckOverlay viewport={VIEWPORT} issues={[error, warning]} selectedId="open_path:a" />);

    expect(groups().map((group) => group.getAttribute("data-issue"))).toEqual(["tiny_detail:b", "open_path:a"]);
    const selected = groups()[1];
    expect(selected).toHaveAttribute("data-selected", "true");
    expect(groups()[0]).toHaveAttribute("data-selected", "false");
    expect(selected.querySelector("path")).toHaveAttribute("stroke-width", "3");
    expect(groups()[0].querySelector("path")).toHaveAttribute("stroke-width", "1.5");
    expect(selected.querySelector("rect")).toHaveAttribute("width", "10");
    expect(groups()[0].querySelector("rect")).toBeNull(); // los no activados con geometría no dibujan rectángulo
  });

  it("un issue de capa completa (sin geometría propia) dibuja solo su rectángulo", () => {
    render(<LaserCheckOverlay viewport={VIEWPORT} issues={[layerLevel]} selectedId={null} />);

    expect(screen.queryAllByTestId("laser-check-highlight")).toHaveLength(0);
    expect(screen.getByTestId("laser-check-rect")).toHaveAttribute("x", "100");
  });

  it("sin issues solo deja el SVG vacío", () => {
    render(<LaserCheckOverlay viewport={VIEWPORT} issues={[]} selectedId={null} />);

    expect(screen.queryAllByTestId("laser-check-issue")).toHaveLength(0);
  });
});
