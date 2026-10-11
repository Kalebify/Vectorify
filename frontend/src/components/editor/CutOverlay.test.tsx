import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CUT_PIECE_COLORS } from "../../lib/editor/cut";
import { IDENTITY_MATRIX } from "../../lib/svgTransform";
import type { EditorObject } from "../../lib/editor/types";
import type { ViewportParams } from "../../lib/editor/viewport";
import { CutOverlay, type CutOverlayProps } from "./CutOverlay";

/** Viewport de prueba: contenedor 800 x 600, documento 320 x 240, escala 1 y pan 0 => pantalla = documento + (240, 180). */
const VIEWPORT: ViewportParams = { containerWidth: 800, containerHeight: 600, panX: 0, panY: 0, scale: 1, sourceWidth: 320, sourceHeight: 240 };

function object(id: string, d = "M0 0 H40 V40 H0 Z"): EditorObject {
  return { id, layerGroupId: "A", d, fill: "#ff0000", matrix: IDENTITY_MATRIX };
}

function renderOverlay(overrides: Partial<Omit<CutOverlayProps, "viewport">> = {}) {
  return render(<CutOverlay viewport={VIEWPORT} objects={[]} shapes={[]} extension={[]} {...overrides} />);
}

describe("CutOverlay (M3-S10)", () => {
  it("es de solo lectura: un SVG oculto a la tecnología asistiva que no captura el puntero (clase boolean-overlay)", () => {
    renderOverlay();

    const svg = screen.getByTestId("cut-overlay");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveClass("boolean-overlay");
  });

  it("atenúa SOLO los objetos que se cortan (velo) y marca con ámbar los que el corte toca sin atravesar; los pendientes y no tocados no se tocan", () => {
    renderOverlay({
      objects: [
        { object: object("a"), status: "cut" },
        { object: object("b"), status: "intact" },
        { object: object("c"), status: "untouched" },
        { object: object("d"), status: "pending" },
      ],
    });

    expect(screen.getAllByTestId("cut-veil")).toHaveLength(1);
    expect(screen.getAllByTestId("cut-intact")).toHaveLength(1);
    expect(screen.getByTestId("cut-intact")).toHaveAttribute("stroke-dasharray");
  });

  it("dibuja cada pieza con un color distinto dentro de su objeto (el color depende del índice de la pieza)", () => {
    renderOverlay({
      shapes: [
        { d: "M0 0 L20 0 L20 40 L0 40 Z", matrix: IDENTITY_MATRIX, line: false, index: 0 },
        { d: "M20 0 L40 0 L40 40 L20 40 Z", matrix: IDENTITY_MATRIX, line: false, index: 1 },
      ],
    });

    const pieces = screen.getByTestId("cut-pieces").querySelectorAll("path");
    expect(pieces).toHaveLength(2);
    expect(pieces[0].getAttribute("fill")).toBe(CUT_PIECE_COLORS[0]);
    expect(pieces[1].getAttribute("fill")).toBe(CUT_PIECE_COLORS[1]);
    expect(pieces[0].getAttribute("fill")).not.toBe(pieces[1].getAttribute("fill"));
    expect(pieces[1].getAttribute("d")).toBe("M20 0 L40 0 L40 40 L20 40 Z");
    expect(pieces[0].getAttribute("fill-rule")).toBe("evenodd"); // los huecos son subpaths
  });

  it("los colores se reciclan pasada la paleta", () => {
    renderOverlay({ shapes: [{ d: "M0 0 L1 0 L1 1 Z", matrix: IDENTITY_MATRIX, line: false, index: CUT_PIECE_COLORS.length }] });

    expect(screen.getByTestId("cut-pieces").querySelector("path")!.getAttribute("fill")).toBe(CUT_PIECE_COLORS[0]);
  });

  it("las piezas de una línea abierta se dibujan como trazo sin relleno", () => {
    renderOverlay({ shapes: [{ d: "M0 0 L20 0", matrix: IDENTITY_MATRIX, line: true, index: 0 }] });

    const piece = screen.getByTestId("cut-pieces").querySelector("path")!;
    expect(piece.getAttribute("fill")).toBe("none");
    expect(piece.getAttribute("stroke")).toBe(CUT_PIECE_COLORS[0]);
  });

  it("la prolongación de «Extender» se dibuja punteada, un tramo por extremo", () => {
    renderOverlay({ extension: [[{ x: 0, y: -50 }, { x: 0, y: 0 }], [{ x: 0, y: 40 }, { x: 0, y: 90 }]] });

    const lines = screen.getAllByTestId("cut-extension");
    expect(lines).toHaveLength(2);
    expect(lines[0].getAttribute("y1")).toBe("-50");
    expect(lines[1].getAttribute("y2")).toBe("90");
    expect(lines[0]).toHaveAttribute("stroke-dasharray");
  });

  it("sin nada que mostrar no dibuja velo, piezas ni prolongación", () => {
    renderOverlay();

    expect(screen.queryByTestId("cut-veil")).not.toBeInTheDocument();
    expect(screen.queryByTestId("cut-intact")).not.toBeInTheDocument();
    expect(screen.queryByTestId("cut-extension")).not.toBeInTheDocument();
    expect(screen.getByTestId("cut-pieces").children).toHaveLength(0);
  });

  it("usa la misma transformación que el canvas (origen del documento y escala)", () => {
    const { container } = renderOverlay({ objects: [{ object: object("a"), status: "cut" }] });

    expect(container.querySelector("g")!.getAttribute("transform")).toBe("translate(240 180) scale(1)");
  });
});
