import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CropSummary } from "../../lib/editor/frame";
import type { DocumentFrame } from "../../lib/editor/types";
import { CropPanel } from "./CropPanel";

const FRAME: DocumentFrame = { x: 0, y: 0, width: 640, height: 480 };
const DRAFT: DocumentFrame = { x: 20, y: 40, width: 200, height: 100 };
const SUMMARY: CropSummary = { total: 10, inside: 6, crossing: 0, outside: 0, lockedOutside: 0, hiddenOutside: 0, removable: 0 };

function renderPanel(overrides: Partial<React.ComponentProps<typeof CropPanel>> = {}) {
  const props: React.ComponentProps<typeof CropPanel> = {
    frame: FRAME,
    draft: DRAFT,
    mmPerUnit: 0.5,
    keepRatio: false,
    onKeepRatioChange: vi.fn(),
    removeOutside: true,
    onRemoveOutsideChange: vi.fn(),
    summary: SUMMARY,
    error: null,
    onDraftChange: vi.fn(() => null),
    onPreset: vi.fn(() => null),
    onApply: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  return { ...render(<CropPanel {...props} />), props };
}

const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement;
function type(label: string, value: string, key: "Enter" | "blur" = "Enter") {
  fireEvent.change(field(label), { target: { value } });
  if (key === "Enter") fireEvent.keyDown(field(label), { key: "Enter" });
  else fireEvent.blur(field(label));
}

describe("CropPanel — campos en mm", () => {
  it("muestra X/Y/ancho/alto del marco propuesto en mm (0.5 mm por unidad)", () => {
    renderPanel();
    expect(field("X del recorte (mm)")).toHaveValue("10");
    expect(field("Y del recorte (mm)")).toHaveValue("20");
    expect(field("Ancho del recorte (mm)")).toHaveValue("100");
    expect(field("Alto del recorte (mm)")).toHaveValue("50");
  });

  it("sin dimensiones físicas edita en unidades de documento (u), no en mm inventados", () => {
    renderPanel({ mmPerUnit: null });
    expect(field("Ancho del recorte (u)")).toHaveValue("200");
    expect(screen.getByText(/Área de trabajo: 640 × 480 u → 200 × 100 u/)).toBeInTheDocument();
  });

  it("editar el ancho (60 mm = 120 u) con Enter propone un marco nuevo; NO aplica el recorte", () => {
    const { props } = renderPanel();
    type("Ancho del recorte (mm)", "60");
    expect(props.onDraftChange).toHaveBeenCalledWith({ x: 20, y: 40, width: 120, height: 100 });
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it("X/Y también se convierten de mm a unidades; blur confirma igual que Enter; acepta coma decimal", () => {
    const { props } = renderPanel();
    type("X del recorte (mm)", "12,5", "blur"); // 12.5 mm = 25 u
    expect(props.onDraftChange).toHaveBeenLastCalledWith({ x: 25, y: 40, width: 200, height: 100 });
    type("Y del recorte (mm)", "0");
    expect(props.onDraftChange).toHaveBeenLastCalledWith({ x: 20, y: 0, width: 200, height: 100 });
  });

  it("un valor que no cambia lo que se muestra no emite nada", () => {
    const { props } = renderPanel();
    type("Ancho del recorte (mm)", "100");
    expect(props.onDraftChange).not.toHaveBeenCalled();
  });

  it("valores inválidos se rechazan con mensaje y SIN llamar a onDraftChange (vacío, texto, 0, negativo, fuera de rango)", () => {
    const { props } = renderPanel();
    type("Ancho del recorte (mm)", "ancho");
    expect(screen.getByRole("alert")).toHaveTextContent(/no es un número válido para Ancho del recorte/);
    type("Alto del recorte (mm)", "0");
    expect(screen.getByRole("alert")).toHaveTextContent(/El alto del recorte debe ser mayor que 0/);
    type("Ancho del recorte (mm)", "-5");
    expect(screen.getByRole("alert")).toHaveTextContent(/El ancho del recorte debe ser mayor que 0/);
    type("X del recorte (mm)", "9999999");
    expect(screen.getByRole("alert")).toHaveTextContent(/fuera de rango/);
    type("Y del recorte (mm)", "  ");
    expect(screen.getByRole("alert")).toHaveTextContent(/\(vacío\)/);
    expect(props.onDraftChange).not.toHaveBeenCalled();
  });

  it("el rechazo del shell (marco inválido) se muestra y un valor aceptado limpia el mensaje", () => {
    const onDraftChange = vi.fn().mockReturnValueOnce("El área de recorte excede el límite razonable.").mockReturnValue(null);
    renderPanel({ onDraftChange });
    type("Ancho del recorte (mm)", "60");
    expect(screen.getByRole("alert")).toHaveTextContent("El área de recorte excede el límite razonable.");
    type("Ancho del recorte (mm)", "70");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("un error de Apply que llega por props se muestra", () => {
    renderPanel({ error: "No hay cambios para aplicar." });
    expect(screen.getByRole("alert")).toHaveTextContent("No hay cambios para aplicar.");
  });
});

describe("CropPanel — bloqueo de proporción", () => {
  it("con el bloqueo activo, editar el ancho deriva el alto con la proporción del marco propuesto (200×100 -> ancho 60 mm = 120 u -> alto 60 u)", () => {
    const { props } = renderPanel({ keepRatio: true });
    type("Ancho del recorte (mm)", "60");
    expect(props.onDraftChange).toHaveBeenCalledWith({ x: 20, y: 40, width: 120, height: 60 });
  });

  it("con el bloqueo activo, editar el alto deriva el ancho (alto 25 mm = 50 u -> ancho 100 u)", () => {
    const { props } = renderPanel({ keepRatio: true });
    type("Alto del recorte (mm)", "25");
    expect(props.onDraftChange).toHaveBeenCalledWith({ x: 20, y: 40, width: 100, height: 50 });
  });

  it("sin el bloqueo, cada eje es independiente; X/Y no se ven afectados por el bloqueo", () => {
    const free = renderPanel({ keepRatio: false });
    type("Ancho del recorte (mm)", "60");
    expect(free.props.onDraftChange).toHaveBeenCalledWith({ x: 20, y: 40, width: 120, height: 100 });
    free.unmount();

    const locked = renderPanel({ keepRatio: true });
    type("X del recorte (mm)", "0");
    expect(locked.props.onDraftChange).toHaveBeenCalledWith({ x: 0, y: 40, width: 200, height: 100 });
  });

  it("la casilla 'Bloquear proporción' avisa al shell", () => {
    const { props } = renderPanel();
    fireEvent.click(screen.getByRole("checkbox", { name: /Bloquear proporción/ }));
    expect(props.onKeepRatioChange).toHaveBeenCalledWith(true);
  });

  it("con un marco de alto 0 no se puede mantener la proporción (mensaje, sin cambios)", () => {
    const { props } = renderPanel({ keepRatio: true, draft: { x: 0, y: 0, width: 100, height: 0 } });
    type("Ancho del recorte (mm)", "10");
    expect(screen.getByRole("alert")).toHaveTextContent(/No se puede mantener la proporción/);
    expect(props.onDraftChange).not.toHaveBeenCalled();
  });
});

describe("CropPanel — presets", () => {
  it("cada preset llama a onPreset con su id", () => {
    const { props } = renderPanel();
    for (const [name, preset] of [
      ["1:1", "1:1"],
      ["4:3", "4:3"],
      ["16:9", "16:9"],
      ["Ajustar al contenido", "content"],
      ["Restablecer", "reset"],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name }));
      expect(props.onPreset).toHaveBeenLastCalledWith(preset);
    }
    expect(props.onPreset).toHaveBeenCalledTimes(5);
  });

  it("si el preset no se puede (p. ej. sin contenido) el mensaje queda visible", () => {
    renderPanel({ onPreset: vi.fn(() => "No hay contenido visible con tamaño suficiente para ajustar el marco.") });
    fireEvent.click(screen.getByRole("button", { name: "Ajustar al contenido" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/No hay contenido visible/);
  });
});

describe("CropPanel — resumen 'Qué se va a modificar' (en vivo)", () => {
  const summary = () => screen.getByRole("region", { name: "Qué se va a modificar" });

  it("dice el área de trabajo antes -> después en mm (640×480 u = 320×240 mm -> 200×100 u = 100×50 mm)", () => {
    renderPanel();
    expect(within(summary()).getByText("Área de trabajo: 320 × 240 mm → 100 × 50 mm")).toBeInTheDocument();
    expect(within(summary()).getByText("No se eliminará ningún objeto.")).toBeInTheDocument();
  });

  it("cuántos objetos se eliminarán (singular/plural)", () => {
    const { rerender, props } = renderPanel({ summary: { ...SUMMARY, outside: 3, removable: 3 } });
    expect(within(summary()).getByText("3 objetos se eliminarán.")).toBeInTheDocument();
    rerender(<CropPanel {...props} summary={{ ...SUMMARY, outside: 1, removable: 1 }} />);
    expect(within(summary()).getByText("1 objeto se eliminará.")).toBeInTheDocument();
  });

  it("los que cruzan el borde se conservan completos y el texto lo dice con la referencia a Intersect (M3-S08)", () => {
    const { rerender, props } = renderPanel({ summary: { ...SUMMARY, crossing: 4 } });
    expect(within(summary()).getByText("4 objetos cruzan el borde; seguirán completos (recorte exacto: operación Intersect, M3-S08).")).toBeInTheDocument();
    rerender(<CropPanel {...props} summary={{ ...SUMMARY, crossing: 1 }} />);
    expect(within(summary()).getByText("1 objeto cruza el borde; seguirá completo (recorte exacto: operación Intersect, M3-S08).")).toBeInTheDocument();
    rerender(<CropPanel {...props} summary={{ ...SUMMARY, crossing: 0 }} />);
    expect(within(summary()).queryByText(/cruzan? el borde/)).not.toBeInTheDocument();
  });

  it("los objetos fuera en capas bloqueadas u ocultas se informan como NO eliminados", () => {
    renderPanel({ summary: { ...SUMMARY, outside: 5, lockedOutside: 2, hiddenOutside: 1, removable: 2 } });
    expect(within(summary()).getByText("2 objetos están en capas bloqueadas y no se eliminan.")).toBeInTheDocument();
    expect(within(summary()).getByText("1 objeto está en una capa oculta y no se elimina.")).toBeInTheDocument();
  });

  it("con 'Eliminar objetos fuera del área' desmarcada dice que no se elimina nada y cuántos quedan fuera", () => {
    renderPanel({ removeOutside: false, summary: { ...SUMMARY, outside: 3, removable: 0 } });
    expect(within(summary()).getByText("No se eliminará ningún objeto (3 quedan fuera del área).")).toBeInTheDocument();
    expect(within(summary()).queryByText(/bloqueadas/)).not.toBeInTheDocument();
  });

  it("la casilla 'Eliminar objetos fuera del área' refleja el valor y avisa al shell", () => {
    const { props } = renderPanel();
    const checkbox = screen.getByRole("checkbox", { name: /Eliminar objetos fuera del área/ });
    expect(checkbox).toBeChecked();
    fireEvent.click(checkbox);
    expect(props.onRemoveOutsideChange).toHaveBeenCalledWith(false);
  });

  it("documenta la decisión de dominio: recorta el área de trabajo, el original no se toca, la escala se conserva", () => {
    renderPanel();
    expect(screen.getByRole("note")).toHaveTextContent(/área de trabajo/);
    expect(screen.getByRole("note")).toHaveTextContent(/no se modifican/);
    expect(screen.getByRole("note")).toHaveTextContent(/escala física se conserva/);
  });

  it("el resumen es una región en vivo (aria-live) para lectores de pantalla", () => {
    renderPanel();
    expect(summary()).toHaveAttribute("aria-live", "polite");
  });
});

describe("CropPanel — Apply / Cancel y teclado", () => {
  it("Apply y Cancel llaman a sus callbacks", () => {
    const { props } = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(props.onApply).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it("Apply está deshabilitado sin cambios (marco igual al vigente y nada que eliminar) y se habilita al haber algo que eliminar", () => {
    const { rerender, props } = renderPanel({ draft: FRAME });
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    rerender(<CropPanel {...props} draft={FRAME} summary={{ ...SUMMARY, outside: 2, removable: 2 }} />);
    expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled();
    rerender(<CropPanel {...props} draft={DRAFT} />);
    expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled();
  });

  it("Enter DENTRO de un campo confirma el campo y no se propaga (el shell no aplica el recorte con un borrador a medias)", () => {
    const onWindowKey = vi.fn();
    window.addEventListener("keydown", onWindowKey);
    renderPanel();
    type("Ancho del recorte (mm)", "60");
    expect(onWindowKey).not.toHaveBeenCalled();
    window.removeEventListener("keydown", onWindowKey);
  });

  it("Escape con un borrador en el campo lo descarta (y NO cancela el recorte); sin borrador deja pasar el evento (cancela)", () => {
    const onWindowKey = vi.fn();
    window.addEventListener("keydown", onWindowKey);
    renderPanel();

    fireEvent.change(field("Ancho del recorte (mm)"), { target: { value: "77" } });
    expect(field("Ancho del recorte (mm)")).toHaveValue("77");
    fireEvent.keyDown(field("Ancho del recorte (mm)"), { key: "Escape" });
    expect(field("Ancho del recorte (mm)")).toHaveValue("100");
    expect(onWindowKey).not.toHaveBeenCalled();

    fireEvent.keyDown(field("Ancho del recorte (mm)"), { key: "Escape" });
    expect(onWindowKey).toHaveBeenCalledTimes(1);
    window.removeEventListener("keydown", onWindowKey);
  });

  it("los campos tienen etiqueta accesible y el grupo un nombre", () => {
    renderPanel();
    expect(screen.getByRole("group", { name: "Posición y tamaño del recorte" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Presets de recorte" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Crop/ })).toBeInTheDocument();
  });
});
