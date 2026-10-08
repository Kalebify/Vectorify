import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { VectorDocumentLayer } from "../../hooks/useVectorDocument";
import { rotationAboutMatrix, translationMatrix } from "../../lib/editor/matrix";
import type { EditorObject } from "../../lib/editor/types";
import { ObjectInspector } from "./ObjectInspector";

function layer(overrides: Partial<VectorDocumentLayer> = {}): VectorDocumentLayer {
  return {
    groupId: "A",
    name: "Rojo",
    colorHex: "#ff0000",
    fill: "#ff0000",
    vectorId: "vector-a",
    svgUrl: "/svg/A",
    pathCount: 1,
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

const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

function obj(id: string, layerGroupId: string, d: string, matrix = IDENTITY): EditorObject {
  return { id, layerGroupId, d, fill: "#ff0000", matrix };
}

// 40×20 unidades en (10, 30). Con mmPerUnit = 0.5: X 5 mm, Y 15 mm, 20 × 10 mm.
const RECT = obj("o1", "A", "M10 30 H50 V50 H10 Z");

function setup(overrides: Partial<React.ComponentProps<typeof ObjectInspector>> = {}) {
  const onApplyBounds = vi.fn<(target: { x: number; y: number; width: number; height: number }) => string | null>(() => null);
  const onRotateTo = vi.fn<(degrees: number) => string | null>(() => null);
  const props = { objects: [RECT], layers: [layer(), layer({ groupId: "B", name: "Azul", locked: true })], mmPerUnit: 0.5, onApplyBounds, onRotateTo, ...overrides };
  const utils = render(<ObjectInspector {...props} />);
  return { ...utils, onApplyBounds, onRotateTo, props };
}

const field = (name: RegExp | string) => screen.getByLabelText(name) as HTMLInputElement;

function type(input: HTMLInputElement, value: string, commit: "enter" | "blur" = "enter") {
  fireEvent.change(input, { target: { value } });
  if (commit === "enter") fireEvent.keyDown(input, { key: "Enter" });
  else fireEvent.blur(input);
}

describe("ObjectInspector — lectura", () => {
  it("un objeto: X, Y, ancho y alto en MM (bbox del documento × mmPerUnit), rotación y capa", () => {
    setup();
    expect(screen.getByRole("heading", { name: "Objeto" })).toBeInTheDocument();
    expect(field("X (mm)")).toHaveValue("5");
    expect(field("Y (mm)")).toHaveValue("15");
    expect(field("Ancho (mm)")).toHaveValue("20");
    expect(field("Alto (mm)")).toHaveValue("10");
    expect(field("Rotación (°)")).toHaveValue("0");
    expect(screen.getByText("Rojo")).toBeInTheDocument();
  });

  it("el bbox incluye la matriz del objeto (traslación + rotación 90° -> ancho y alto intercambiados)", () => {
    const rotated = obj("o2", "A", "M0 0 H40 V20 H0 Z", rotationAboutMatrix({ x: 0, y: 0 }, 90));
    setup({ objects: [rotated] });
    expect(field("Ancho (mm)")).toHaveValue("10");
    expect(field("Alto (mm)")).toHaveValue("20");
    expect(field("Rotación (°)")).toHaveValue("90");
  });

  it("multi-selección: 'Varios', bbox del GRUPO, capa 'Varias' y rotación deshabilitada", () => {
    const other = obj("o2", "B", "M100 0 H120 V10 H100 Z");
    setup({ objects: [RECT, other] });
    expect(screen.getByRole("heading", { name: "Varios (2 objetos)" })).toBeInTheDocument();
    // grupo: x 10..120, y 0..50 -> 110 × 50 unidades = 55 × 25 mm
    expect(field("Ancho (mm)")).toHaveValue("55");
    expect(field("Alto (mm)")).toHaveValue("25");
    expect(screen.getByText("Varias (2)")).toBeInTheDocument();
    expect(field("Rotación (°)")).toBeDisabled();
  });

  it("documento sin dimensiones físicas (mmPerUnit null): edita en unidades de documento y lo dice (nunca inventa mm)", () => {
    setup({ mmPerUnit: null });
    expect(field("Ancho (u)")).toHaveValue("40");
    expect(screen.queryByLabelText("Ancho (mm)")).not.toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent(/unidades de documento/);
  });

  it("objeto sin geometría: lo informa y no ofrece campos", () => {
    setup({ objects: [obj("e", "A", "")] });
    expect(screen.getByText("La selección no tiene geometría visible.")).toBeInTheDocument();
    expect(screen.queryByLabelText("X (mm)")).not.toBeInTheDocument();
  });
});

describe("ObjectInspector — edición numérica", () => {
  it("Enter en Ancho confirma UN comando con el rectángulo destino convertido de mm a unidades de documento", () => {
    const { onApplyBounds } = setup();
    type(field("Ancho (mm)"), "30");
    expect(onApplyBounds).toHaveBeenCalledTimes(1);
    // 30 mm / 0.5 = 60 unidades; el resto del rectángulo no cambia.
    expect(onApplyBounds).toHaveBeenCalledWith({ x: 10, y: 30, width: 60, height: 20 });
  });

  it("blur también confirma, y Enter + blur no confirma dos veces", () => {
    const { onApplyBounds } = setup();
    type(field("Alto (mm)"), "20", "blur");
    expect(onApplyBounds).toHaveBeenLastCalledWith({ x: 10, y: 30, width: 40, height: 40 });

    const x = field("X (mm)");
    type(x, "0");
    fireEvent.blur(x);
    expect(onApplyBounds).toHaveBeenCalledTimes(2);
    expect(onApplyBounds).toHaveBeenLastCalledWith({ x: 0, y: 30, width: 40, height: 20 });
  });

  it("X e Y mueven (mm -> unidades), acepta coma decimal", () => {
    const { onApplyBounds } = setup();
    type(field("X (mm)"), "7,5");
    expect(onApplyBounds).toHaveBeenLastCalledWith({ x: 15, y: 30, width: 40, height: 20 });
    type(field("Y (mm)"), "-2");
    expect(onApplyBounds).toHaveBeenLastCalledWith({ x: 10, y: -4, width: 40, height: 20 });
  });

  it("en unidades de documento (sin mm) no hay conversión", () => {
    const { onApplyBounds } = setup({ mmPerUnit: null });
    type(field("Ancho (u)"), "100");
    expect(onApplyBounds).toHaveBeenCalledWith({ x: 10, y: 30, width: 100, height: 20 });
  });

  it("el mismo valor que ya se muestra no emite comando", () => {
    const { onApplyBounds } = setup();
    type(field("Ancho (mm)"), "20");
    type(field("X (mm)"), "5.0000");
    expect(onApplyBounds).not.toHaveBeenCalled();
  });

  it("proporción bloqueada: editar el ancho deriva el alto; editar el alto deriva el ancho", () => {
    const { onApplyBounds } = setup();
    fireEvent.click(screen.getByLabelText("Mantener proporción"));
    type(field("Ancho (mm)"), "40"); // 2× -> alto 20 mm
    expect(onApplyBounds).toHaveBeenLastCalledWith({ x: 10, y: 30, width: 80, height: 40 });
    type(field("Alto (mm)"), "5"); // 0.5× -> ancho 10 mm
    expect(onApplyBounds).toHaveBeenLastCalledWith({ x: 10, y: 30, width: 20, height: 10 });
  });

  it("proporción bloqueada sobre una línea (alto 0): no se puede mantener -> mensaje, sin cambio", () => {
    const { onApplyBounds } = setup({ objects: [obj("l", "A", "M0 0 H40")] });
    fireEvent.click(screen.getByLabelText("Mantener proporción"));
    type(field("Ancho (mm)"), "30");
    expect(onApplyBounds).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/proporción/);
  });

  it("rotación (un solo objeto): confirma el ángulo absoluto", () => {
    const { onRotateTo, onApplyBounds } = setup();
    type(field("Rotación (°)"), "45");
    expect(onRotateTo).toHaveBeenCalledWith(45);
    expect(onApplyBounds).not.toHaveBeenCalled();
  });

  it("valores inválidos se rechazan con mensaje, no llaman a nada y el campo vuelve al valor real", () => {
    const { onApplyBounds, onRotateTo } = setup();
    for (const bad of ["abc", "", "12abc", "1,2,3"]) {
      type(field("Ancho (mm)"), bad);
      expect(screen.getByRole("alert")).toHaveTextContent(/no es un número válido/);
      expect(field("Ancho (mm)")).toHaveValue("20");
    }
    type(field("Rotación (°)"), "girar");
    expect(onApplyBounds).not.toHaveBeenCalled();
    expect(onRotateTo).not.toHaveBeenCalled();
  });

  it("ancho/alto ≤ 0 y valores fuera de rango se rechazan", () => {
    const { onApplyBounds } = setup();
    type(field("Ancho (mm)"), "0");
    expect(screen.getByRole("alert")).toHaveTextContent(/mayor que 0/);
    type(field("Alto (mm)"), "-5");
    expect(screen.getByRole("alert")).toHaveTextContent(/El alto debe ser mayor que 0/);
    type(field("X (mm)"), "99999999");
    expect(screen.getByRole("alert")).toHaveTextContent(/fuera de rango/);
    expect(onApplyBounds).not.toHaveBeenCalled();
  });

  it("un rechazo del editor (callback devuelve mensaje) se muestra; una edición posterior válida lo limpia", () => {
    const onApplyBounds = vi.fn<(target: { x: number; y: number; width: number; height: number }) => string | null>().mockReturnValueOnce("La capa está bloqueada.").mockReturnValue(null);
    setup({ onApplyBounds });
    type(field("Ancho (mm)"), "30");
    expect(screen.getByRole("alert")).toHaveTextContent("La capa está bloqueada.");
    type(field("Ancho (mm)"), "31");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("Escape descarta el borrador sin aplicar nada", () => {
    const { onApplyBounds } = setup();
    const width = field("Ancho (mm)");
    fireEvent.change(width, { target: { value: "99" } });
    expect(width).toHaveValue("99");
    fireEvent.keyDown(width, { key: "Escape" });
    expect(width).toHaveValue("20");
    fireEvent.blur(width);
    expect(onApplyBounds).not.toHaveBeenCalled();
  });

  it("una selección distinta descarta el error y los borradores de la anterior", () => {
    const { rerender, props } = setup();
    type(field("Ancho (mm)"), "xx");
    expect(screen.getByRole("alert")).toBeInTheDocument();
    rerender(<ObjectInspector {...props} objects={[obj("o9", "A", "M0 0 H10 V10 H0 Z", translationMatrix(0, 0))]} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("ObjectInspector — capa bloqueada", () => {
  it("campos deshabilitados, valores visibles (inspección) y explicación con el nombre de la capa", () => {
    const { onApplyBounds } = setup({ objects: [obj("o3", "B", "M0 0 H40 V20 H0 Z")] });
    for (const label of ["X (mm)", "Y (mm)", "Ancho (mm)", "Alto (mm)", "Rotación (°)"]) {
      expect(field(label)).toBeDisabled();
    }
    expect(field("Ancho (mm)")).toHaveValue("20");
    expect(screen.getByLabelText("Mantener proporción")).toBeDisabled();
    expect(screen.getByText(/La capa Azul está bloqueada/)).toBeInTheDocument();

    fireEvent.change(field("Ancho (mm)"), { target: { value: "30" } });
    fireEvent.keyDown(field("Ancho (mm)"), { key: "Enter" });
    expect(onApplyBounds).not.toHaveBeenCalled();
  });

  it("multi-selección con UN objeto bloqueado: todo de solo lectura", () => {
    setup({ objects: [RECT, obj("o3", "B", "M0 0 H40 V20 H0 Z")] });
    expect(field("Ancho (mm)")).toBeDisabled();
    expect(screen.getByText(/La capa Azul está bloqueada/)).toBeInTheDocument();
  });
});

describe("ObjectInspector — color de la capa (M3-S03)", () => {
  it("muestra el color de la CAPA del objeto (swatch + hex normalizado) y se actualiza cuando el objeto cambia de capa", () => {
    const { rerender, props } = setup();
    const row = screen.getByText("Color").closest("div")!;
    expect(row).toHaveTextContent("#FF0000");
    expect(row.querySelector(".object-inspector__swatch")).toHaveStyle({ backgroundColor: "#ff0000" });

    // Fill/Recolor mueven el objeto a otra capa: el Inspector lo refleja de inmediato.
    const moved: EditorObject = { ...RECT, layerGroupId: "N" };
    const layers = [...props.layers, layer({ groupId: "N", name: "Color #00FF00", colorHex: "#00FF00", isNew: true })];
    rerender(<ObjectInspector {...props} objects={[moved]} layers={layers} />);
    expect(screen.getByText("Color").closest("div")).toHaveTextContent("#00FF00");
    expect(screen.getByText("Capa").closest("div")).toHaveTextContent("Color #00FF00");
  });

  it("con objetos de varias capas dice 'Varios' (no inventa un color)", () => {
    setup({ objects: [RECT, obj("o2", "B", "M0 0 H5 V5 H0 Z")] });
    expect(screen.getByText("Color").closest("div")).toHaveTextContent("Varios");
  });
});
