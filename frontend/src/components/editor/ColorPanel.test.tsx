import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { VectorDocumentLayer } from "../../hooks/useVectorDocument";
import type { ColorPlan, ColorTarget, RecolorScope, RecolorSummary } from "../../lib/editor/colors";
import { ColorPanel, EyedropperPanel } from "./ColorPanel";

function layer(overrides: Partial<VectorDocumentLayer> = {}): VectorDocumentLayer {
  return {
    groupId: "A",
    name: "Rojo",
    colorHex: "#ff0000",
    fill: "#ff0000",
    vectorId: "vector-a",
    svgUrl: "/svg/A",
    pathCount: 2,
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

const A = layer();
const B = layer({ groupId: "B", name: "Azul", colorHex: "#0000ff", order: 1 });
// Mismo hex que A (otra caja), otra capa.
const C = layer({ groupId: "C", name: "Rojo 2", colorHex: "#FF0000", order: 2 });

function summary(overrides: Partial<RecolorSummary> = {}): RecolorSummary {
  return {
    scope: "selection",
    objectCount: 2,
    layerCount: 1,
    destination: { groupId: "B", name: "Azul", colorHex: "#0000ff", created: false },
    alreadyThere: 0,
    skippedLocked: 0,
    skippedHidden: 0,
    merge: null,
    emptiedLayerIds: [],
    layerRecolor: null,
    ...overrides,
  };
}

function plan(overrides: Partial<ColorPlan> = {}, summaryOverrides: Partial<RecolorSummary> = {}): ColorPlan {
  return { production: { layers: {} }, summary: summary(summaryOverrides), error: null, ...overrides };
}

const ALL_AVAILABLE: Record<RecolorScope, string | null> = { selection: null, layer: null, document: null };

interface Overrides {
  [key: string]: unknown;
}

function renderPanel(overrides: Overrides = {}) {
  const props = {
    mode: "color" as const,
    layers: [A, B, C],
    target: { kind: "layer", groupId: "B" } as ColorTarget | null,
    onPickLayer: vi.fn(),
    onFreeColor: vi.fn(),
    scope: "selection" as RecolorScope,
    onScopeChange: vi.fn(),
    scopeAvailability: ALL_AVAILABLE,
    sourceGroupId: "A" as string | null,
    onSourceChange: vi.fn(),
    mergeIntoGroupId: null as string | null,
    onMergeChange: vi.fn(),
    plan: plan() as ColorPlan | null,
    message: null as string | null,
    confirming: false,
    confirmText: "Se recolorarán 120 objetos en 3 capas. ¿Confirmás?",
    onApply: vi.fn(),
    onConfirm: vi.fn(),
    onBack: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  const utils = render(<ColorPanel {...props} />);
  return { ...utils, props };
}

const hexField = () => screen.getByLabelText("Color hex") as HTMLInputElement;

describe("ColorPanel — color activo y swatches de la paleta", () => {
  it("muestra el color activo con swatch + NOMBRE DE CAPA + hex (la capa es la identidad)", () => {
    renderPanel();
    const readout = screen.getByText("Color activo:").closest("p")!;
    expect(within(readout).getByText("Azul")).toBeInTheDocument();
    expect(within(readout).getByText("#0000ff")).toBeInTheDocument();
  });

  it("sin color activo lo dice y explica cómo elegir uno; con una referencia a una capa inexistente tampoco hay color activo", () => {
    const { rerender, props } = renderPanel({ target: null, plan: null });
    expect(screen.getByText(/ninguno\. Elegilo en la paleta/)).toBeInTheDocument();
    rerender(<ColorPanel {...props} target={{ kind: "layer", groupId: "ZZZ" }} />);
    expect(screen.getByText(/ninguno\./)).toBeInTheDocument();
  });

  it("un swatch por capa con el nombre de la capa en su nombre accesible; clic elige ESA capa por groupId (A y C comparten hex pero son distintas)", () => {
    const { props } = renderPanel();
    const bar = screen.getByRole("group", { name: "Colores de la paleta para aplicar" });
    const red = within(bar).getByRole("button", { name: /^Usar el color de la capa Rojo \(#ff0000\)/ });
    const red2 = within(bar).getByRole("button", { name: /^Usar el color de la capa Rojo 2 \(#FF0000\)/ });
    fireEvent.click(red2);
    expect(props.onPickLayer).toHaveBeenLastCalledWith("C");
    fireEvent.click(red);
    expect(props.onPickLayer).toHaveBeenLastCalledWith("A");
    // El swatch del color activo se marca con aria-pressed.
    expect(within(bar).getByRole("button", { name: /Azul/ })).toHaveAttribute("aria-pressed", "true");
    expect(red).toHaveAttribute("aria-pressed", "false");
    // Sin el "[+]" deshabilitado del wireframe (agregar color a la paleta no es de este panel).
    expect(within(bar).queryByRole("button", { name: /Agregar color/ })).not.toBeInTheDocument();
  });
});

describe("ColorPanel — color libre (hex)", () => {
  it("un hex inválido muestra el error y NO cambia el color; el campo queda marcado aria-invalid", () => {
    const { props } = renderPanel();
    fireEvent.change(hexField(), { target: { value: "#12" } });
    fireEvent.keyDown(hexField(), { key: "Enter" });
    expect(screen.getByRole("alert")).toHaveTextContent(/"#12" no es un color hex válido/);
    expect(props.onFreeColor).not.toHaveBeenCalled();
    expect(hexField()).toHaveAttribute("aria-invalid", "true");
  });

  it("un hex válido (#rgb, mayúsculas/minúsculas) se normaliza a #RRGGBB y se informa como color libre; Enter dentro del campo NO aplica el recoloreo", () => {
    const { props } = renderPanel();
    fireEvent.change(hexField(), { target: { value: "#0f8" } });
    fireEvent.keyDown(hexField(), { key: "Enter" });
    expect(props.onFreeColor).toHaveBeenCalledWith("#00FF88");
    expect(props.onApply).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("confirma el campo también al salir (blur)", () => {
    const { props } = renderPanel();
    fireEvent.change(hexField(), { target: { value: "ABCDEF" } });
    fireEvent.blur(hexField());
    expect(props.onFreeColor).toHaveBeenCalledWith("#ABCDEF");
  });

  it("el selector de color nativo emite el color libre normalizado", () => {
    const { props } = renderPanel();
    fireEvent.change(screen.getByLabelText("Selector de color"), { target: { value: "#123abc" } });
    expect(props.onFreeColor).toHaveBeenCalledWith("#123ABC");
  });

  it("Escape con un borrador en el campo lo descarta y NO se propaga (el shell no cancela el recoloreo)", () => {
    renderPanel();
    const onWindowKey = vi.fn();
    window.addEventListener("keydown", onWindowKey);
    fireEvent.change(hexField(), { target: { value: "#zz" } });
    fireEvent.keyDown(hexField(), { key: "Escape" });
    window.removeEventListener("keydown", onWindowKey);
    expect(onWindowKey).not.toHaveBeenCalled();
    expect(hexField()).toHaveValue("#0000ff");
  });

  it("un color libre cuyo hex coincide con capas existentes OFRECE 'Usar la capa «X»' por cada una (nunca compara en silencio)", () => {
    const { props } = renderPanel({ target: { kind: "new", hex: "#ff0000", groupId: "NEW" }, plan: plan({}, { destination: { groupId: "NEW", name: "Color #FF0000", colorHex: "#FF0000", created: true } }) });
    const matches = screen.getByRole("group", { name: "Capas con el mismo color" });
    const useA = within(matches).getByRole("button", { name: "Usar la capa «Rojo»" });
    const useC = within(matches).getByRole("button", { name: "Usar la capa «Rojo 2»" });
    fireEvent.click(useC);
    expect(props.onPickLayer).toHaveBeenCalledWith("C");
    fireEvent.click(useA);
    expect(props.onPickLayer).toHaveBeenLastCalledWith("A");
    // Y el color activo se identifica como NUEVO.
    expect(screen.getByText(/capa nueva: se crea al aplicar/)).toBeInTheDocument();
  });

  it("sin coincidencias de hex no aparece la oferta", () => {
    renderPanel({ target: { kind: "new", hex: "#123456", groupId: "NEW" } });
    expect(screen.queryByRole("group", { name: "Capas con el mismo color" })).not.toBeInTheDocument();
  });
});

describe("ColorPanel — alcance", () => {
  it("el alcance siempre está visible: tres opciones, la vigente marcada", () => {
    renderPanel({ scope: "layer" });
    const radios = screen.getAllByRole("radio", { name: /Selección|Capa|Documento/ }).filter((radio) => (radio as HTMLInputElement).name.endsWith("-scope"));
    expect(radios).toHaveLength(3);
    expect(screen.getByRole("radio", { name: "Capa" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Selección" })).not.toBeChecked();
  });

  it("sin selección el alcance 'Selección' se deshabilita con su motivo y no se puede elegir", () => {
    const { props } = renderPanel({ scope: "layer", scopeAvailability: { selection: "sin selección", layer: null, document: null } });
    const selection = screen.getByRole("radio", { name: "Selección (sin selección)" });
    expect(selection).toBeDisabled();
    fireEvent.click(selection);
    expect(props.onScopeChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("radio", { name: "Documento" }));
    expect(props.onScopeChange).toHaveBeenCalledWith("document");
  });

  it("sin capa activa 'Capa' se deshabilita", () => {
    renderPanel({ scopeAvailability: { selection: null, layer: "sin capa activa", document: null } });
    expect(screen.getByRole("radio", { name: "Capa (sin capa activa)" })).toBeDisabled();
  });

  it("en Fill el alcance es fijo (selección) y no hay radios", () => {
    renderPanel({ mode: "fill" });
    expect(screen.getByRole("heading", { name: /Fill — aplicar color/ })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Documento" })).not.toBeInTheDocument();
    expect(screen.getByText(/Fill se aplica a los objetos seleccionados/)).toBeInTheDocument();
  });

  it("alcance Documento: elegir la capa de ORIGEN en un selector con todas las capas (nombre + hex)", () => {
    const { props } = renderPanel({ scope: "document", sourceGroupId: null });
    const select = screen.getByLabelText("Color de origen (capa)") as HTMLSelectElement;
    expect(within(select).getAllByRole("option").map((option) => option.textContent)).toEqual(["Elegí una capa", "Rojo (#ff0000)", "Azul (#0000ff)", "Rojo 2 (#FF0000)"]);
    fireEvent.change(select, { target: { value: "C" } });
    expect(props.onSourceChange).toHaveBeenCalledWith("C");
  });

  it("alcance Capa: dice cuál es la capa a recolorear (la activa)", () => {
    renderPanel({ scope: "layer", sourceGroupId: "B" });
    expect(screen.getByText("Capa a recolorear:").closest("p")).toHaveTextContent("Capa a recolorear: Azul");
  });
});

describe("ColorPanel — fusión explícita", () => {
  it("con el color de destino igual al de otras capas se OFRECE fusionar, con 'No fusionar' marcado por defecto", () => {
    const { props } = renderPanel({ scope: "layer", sourceGroupId: "B", target: { kind: "layer", groupId: "A" }, plan: plan({}, { scope: "layer", destination: null }) });
    const merge = screen.getByRole("group", { name: "Capas con el color de destino" });
    expect(within(merge).getByRole("radio", { name: /No fusionar/ })).toBeChecked();
    const intoA = within(merge).getByRole("radio", { name: /Fusionar con «Rojo»/ });
    const intoC = within(merge).getByRole("radio", { name: /Fusionar con «Rojo 2»/ });
    expect(intoA).not.toBeChecked();
    fireEvent.click(intoC);
    expect(props.onMergeChange).toHaveBeenCalledWith("C");
    expect(within(merge).getAllByText(/la capa origen queda vacía/)).toHaveLength(2);
  });

  it("la fusión elegida se refleja en el resumen: la capa origen queda vacía y no se elimina", () => {
    renderPanel({
      scope: "layer",
      sourceGroupId: "B",
      target: { kind: "layer", groupId: "A" },
      mergeIntoGroupId: "A",
      plan: plan({}, { scope: "layer", merge: { fromGroupId: "B", fromName: "Azul", intoGroupId: "A", intoName: "Rojo" }, emptiedLayerIds: ["B"], destination: { groupId: "A", name: "Rojo", colorHex: "#ff0000", created: false } }),
    });
    expect(screen.getByRole("radio", { name: /Fusionar con «Rojo»/ })).toBeChecked();
    expect(screen.getByText("Se fusiona «Azul» con «Rojo»: «Azul» queda vacía (no se elimina).")).toBeInTheDocument();
  });

  it("recolorear una capa con el color de OTRA capa (swatch) ofrece fusionar con esa capa, pero sin fusionar por defecto", () => {
    renderPanel({ scope: "layer", sourceGroupId: "A", target: { kind: "layer", groupId: "B" } });
    const merge = screen.getByRole("group", { name: "Capas con el color de destino" });
    expect(within(merge).getByRole("radio", { name: /No fusionar/ })).toBeChecked();
    expect(within(merge).getByRole("radio", { name: /Fusionar con «Azul»/ })).not.toBeChecked();
  });

  it("sin otras capas con el color de destino (hex libre sin coincidencias) no hay oferta de fusión", () => {
    renderPanel({ scope: "layer", sourceGroupId: "A", target: { kind: "new", hex: "#123456", groupId: "N" } });
    expect(screen.queryByRole("group", { name: "Capas con el color de destino" })).not.toBeInTheDocument();
  });

  it("en el alcance Selección no hay fusión (solo mueve objetos a una capa)", () => {
    renderPanel({ scope: "selection", sourceGroupId: "A", target: { kind: "layer", groupId: "C" } });
    expect(screen.queryByRole("group", { name: "Capas con el color de destino" })).not.toBeInTheDocument();
  });
});

describe("ColorPanel — resumen, Apply/Cancel y confirmación", () => {
  it("el resumen dice qué se va a modificar ANTES de aplicar: cuántos objetos/capas y a dónde van", () => {
    renderPanel({ plan: plan({}, { objectCount: 3, layerCount: 2 }) });
    const region = screen.getByRole("region", { name: "Qué se va a modificar" });
    expect(within(region).getByText("Alcance: Selección. Se recolorarán 3 objetos en 2 capas.")).toBeInTheDocument();
    expect(within(region).getByText("Los objetos se moverán a la capa «Azul» (#0000ff).")).toBeInTheDocument();
  });

  it("un color nuevo anuncia la CREACIÓN de la capa (explícita y sin guardar)", () => {
    renderPanel({ plan: plan({}, { destination: { groupId: "N", name: "Color #00FF00", colorHex: "#00FF00", created: true } }) });
    expect(screen.getByText(/Se creará la capa nueva «Color #00FF00» \(#00FF00\), sin guardar todavía/)).toBeInTheDocument();
  });

  it("recolor de capa: informa el cambio de color conservando la identidad; objetos omitidos por bloqueo/ocultas y ya-en-destino se informan", () => {
    renderPanel({
      scope: "layer",
      plan: plan({}, { scope: "layer", destination: null, layerRecolor: { groupId: "A", name: "Rojo", from: "#ff0000", to: "#00FF00" }, skippedLocked: 2, skippedHidden: 1, alreadyThere: 1 }),
    });
    expect(screen.getByText("La capa «Rojo» cambia de #ff0000 a #00FF00 y conserva su identidad.")).toBeInTheDocument();
    expect(screen.getByText("2 objetos están en capas bloqueadas y no se modificará.")).toBeInTheDocument();
    expect(screen.getByText("1 objeto está en capas ocultas y no se modificará.")).toBeInTheDocument();
    expect(screen.getByText("1 objeto ya está en la capa destino.")).toBeInTheDocument();
  });

  it("sin color elegido: pide elegir uno y Apply está deshabilitado", () => {
    renderPanel({ target: null, plan: null });
    expect(screen.getByText("Elegí un color para ver el resumen.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  });

  it("el motivo de rechazo del plan se muestra (rol alert) y Apply queda deshabilitado", () => {
    renderPanel({ plan: plan({ production: null, error: "La capa destino «Rojo» está bloqueada: desbloqueala en el panel de Capas o elegí otra." }) });
    expect(screen.getByRole("alert")).toHaveTextContent(/está bloqueada/);
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(screen.getByText("Alcance: Selección. No hay cambios para aplicar.")).toBeInTheDocument();
  });

  it("un mensaje de rechazo del shell (apply/fill) se muestra con prioridad", () => {
    renderPanel({ message: "Elegí un color antes de rellenar." });
    expect(screen.getByRole("alert")).toHaveTextContent("Elegí un color antes de rellenar.");
  });

  it("Apply y Cancel llaman a sus callbacks", () => {
    const { props } = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.onApply).toHaveBeenCalledTimes(1);
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it("confirmación: reemplaza Apply/Cancel por 'Confirmar'/'Volver' con el texto del alcance, el foco en 'Confirmar' y rol alertdialog", () => {
    const { props } = renderPanel({ confirming: true });
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("Se recolorarán 120 objetos en 3 capas. ¿Confirmás?");
    expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
    const confirm = within(dialog).getByRole("button", { name: "Confirmar" });
    expect(confirm).toHaveFocus();
    fireEvent.click(confirm);
    expect(props.onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Volver" }));
    expect(props.onBack).toHaveBeenCalledTimes(1);
    expect(props.onApply).not.toHaveBeenCalled();
  });
});

describe("EyedropperPanel", () => {
  it("explica que toma la CAPA del objeto (no un hex), que lee capas bloqueadas pero no ocultas, y muestra swatch + nombre + hex del color tomado", () => {
    render(<EyedropperPanel layers={[A, B, C]} target={{ kind: "layer", groupId: "C" }} />);
    expect(screen.getByRole("heading", { name: /Eyedropper/ })).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent(/color de SU CAPA \(no un hex suelto\)/);
    expect(screen.getByRole("note")).toHaveTextContent(/capas bloqueadas, pero no las ocultas/);
    const readout = screen.getByText("Color activo:").closest("p")!;
    expect(within(readout).getByText("Rojo 2")).toBeInTheDocument();
    expect(within(readout).getByText("#FF0000")).toBeInTheDocument();
  });

  it("sin color tomado lo dice", () => {
    render(<EyedropperPanel layers={[A]} target={null} />);
    expect(screen.getByText(/ninguno\./)).toBeInTheDocument();
  });
});
