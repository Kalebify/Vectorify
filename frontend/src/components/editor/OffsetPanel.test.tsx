import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NEW_LAYER_VALUE } from "./BooleanPanel";
import { OffsetPanel, ORIGIN_LAYER_VALUE } from "./OffsetPanel";

type Props = Parameters<typeof OffsetPanel>[0];

function baseProps(overrides: Partial<Props> = {}): Props {
  return {
    direction: "outside",
    onDirectionChange: vi.fn(),
    insideDisabledReason: null,
    onlyLines: false,
    distance: 1,
    unitLabel: "mm",
    onDistanceChange: vi.fn(),
    scaleNotice: null,
    joinStyle: "round",
    onJoinStyleChange: vi.fn(),
    mitreLimit: 2,
    onMitreLimitChange: vi.fn(),
    hasLines: false,
    capStyle: "round",
    onCapStyleChange: vi.fn(),
    keepOriginals: true,
    onKeepOriginalsChange: vi.fn(),
    targetValue: ORIGIN_LAYER_VALUE,
    onTargetChange: vi.fn(),
    targetCandidates: [
      { groupId: "A", name: "Rojo", colorHex: "#ff0000", isOriginLayer: true },
      { groupId: "C", name: "Verde", colorHex: "#00ff00", isOriginLayer: false },
    ],
    newColorHex: "",
    onNewColorChange: vi.fn(),
    targetIssue: null,
    destinationText: "Cada resultado va a la capa de su objeto de origen, con el color de esa capa: «Rojo» (2 objetos).",
    toleranceMm: 0.01,
    onToleranceChange: vi.fn(),
    preview: { status: "ready", readyText: "Resultado: 2 piezas a partir de 2 objetos.", warnings: [], errorMessage: null },
    rejection: null,
    confirmation: null,
    message: null,
    applying: false,
    applyDisabledReason: null,
    onApply: vi.fn(),
    onCancel: vi.fn(),
    onRetry: vi.fn(),
    ...overrides,
  };
}

const renderPanel = (overrides: Partial<Props> = {}) => {
  const props = baseProps(overrides);
  const utils = render(<OffsetPanel {...props} />);
  return { props, ...utils };
};

describe("OffsetPanel (M3-S09)", () => {
  it("es una región con nombre (Offset) y su estado se anuncia en una región aria-live", () => {
    renderPanel();

    expect(screen.getByRole("heading", { name: "Offset" })).toBeInTheDocument();
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("Resultado: 2 piezas a partir de 2 objetos.");
  });

  describe("dirección", () => {
    it("Exterior e Interior son radios con nombre; elegir uno avisa", () => {
      const { props } = renderPanel();

      expect(screen.getByRole("radio", { name: "Exterior" })).toBeChecked();
      expect(screen.getByRole("radio", { name: "Interior" })).not.toBeChecked();
      fireEvent.click(screen.getByRole("radio", { name: "Interior" }));
      expect(props.onDirectionChange).toHaveBeenCalledWith("inside");
    });

    it("con líneas abiertas, Interior se deshabilita CON el motivo visible y el primer radio pasa a «Ambos lados»", () => {
      const reason = "Una línea abierta no tiene interior: solo se desplaza a ambos lados.";
      renderPanel({ insideDisabledReason: reason, onlyLines: true, hasLines: true });

      expect(screen.getByRole("radio", { name: "Interior" })).toBeDisabled();
      expect(screen.getByRole("radio", { name: "Ambos lados" })).toBeChecked();
      expect(screen.getByText(`Interior deshabilitado: ${reason}`)).toBeInTheDocument();
      expect(screen.getByText(/ancho total 2 × el offset/)).toBeInTheDocument();
    });

    it("con una mezcla de formas y líneas dice que las líneas se desplazan a ambos lados", () => {
      renderPanel({ insideDisabledReason: "x", hasLines: true });

      expect(screen.getByRole("radio", { name: "Exterior" })).toBeInTheDocument();
      expect(screen.getByText(/las líneas se desplazan a ambos lados/)).toBeInTheDocument();
    });
  });

  describe("distancia", () => {
    it("los presets 0,1 / 0,25 / 0,5 / 1 / 2 / 5 aplican su valor y el vigente figura como presionado", () => {
      const { props } = renderPanel({ distance: 0.5 });
      const presets = within(screen.getByRole("group", { name: /Distancias frecuentes/ }));

      expect(presets.getAllByRole("button").map((button) => button.textContent)).toEqual(["0,1", "0,25", "0,5", "1", "2", "5"]);
      expect(presets.getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["0,1 mm", "0,25 mm", "0,5 mm", "1 mm", "2 mm", "5 mm"]);
      expect(presets.getByRole("button", { name: "0,5 mm" })).toHaveAttribute("aria-pressed", "true");
      expect(presets.getByRole("button", { name: "2 mm" })).toHaveAttribute("aria-pressed", "false");
      fireEvent.click(presets.getByRole("button", { name: "0,25 mm" }));
      expect(props.onDistanceChange).toHaveBeenLastCalledWith(0.25);
      fireEvent.click(presets.getByRole("button", { name: "5 mm" }));
      expect(props.onDistanceChange).toHaveBeenLastCalledWith(5);
    });

    it("el campo libre acepta coma decimal, y rechaza 0, negativos, texto y más de 1000 mm con mensaje y sin cambiar nada", () => {
      const { props } = renderPanel();
      const input = screen.getByLabelText("Offset (mm)") as HTMLInputElement;

      fireEvent.change(input, { target: { value: "1,5" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(props.onDistanceChange).toHaveBeenLastCalledWith(1.5);

      for (const [text, message] of [
        ["0", /debe estar entre 0/],
        ["-2", /debe estar entre 0/],
        ["abc", /no es un número válido/],
        ["1001", /debe estar entre 0.*1\.?000 mm/],
      ] as const) {
        fireEvent.change(input, { target: { value: text } });
        fireEvent.keyDown(input, { key: "Enter" });
        expect(screen.getAllByRole("alert").at(-1)).toHaveTextContent(message);
      }
      expect(props.onDistanceChange).toHaveBeenCalledTimes(1);
      fireEvent.change(input, { target: { value: "1000" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(props.onDistanceChange).toHaveBeenLastCalledWith(1000);
    });

    it("las flechas ↑/↓ del campo cambian la distancia de a 0,1", () => {
      const { props } = renderPanel({ distance: 1 });
      const input = screen.getByLabelText("Offset (mm)");

      fireEvent.keyDown(input, { key: "ArrowUp" });
      expect(props.onDistanceChange).toHaveBeenLastCalledWith(1.1);
      fireEvent.keyDown(input, { key: "ArrowDown" });
      expect(props.onDistanceChange).toHaveBeenLastCalledWith(0.9);
    });

    it("sin escala física el campo y los presets hablan de unidades (u) y se muestra el aviso", () => {
      renderPanel({ unitLabel: "u", scaleNotice: "Sin escala física: el offset es en unidades del documento (u), no en mm." });

      expect(screen.getByLabelText("Offset (u)")).toBeInTheDocument();
      expect(screen.queryByLabelText("Offset (mm)")).not.toBeInTheDocument();
      expect(screen.getByRole("note")).toHaveTextContent(/Sin escala física/);
      expect(screen.getByRole("group", { name: /Distancias frecuentes \(u\)/ })).toBeInTheDocument();
    });

    it("con escala física no hay aviso de escala", () => {
      renderPanel();

      expect(screen.queryByRole("note")).not.toBeInTheDocument();
    });
  });

  describe("esquinas y extremos", () => {
    it("Redondo / Inglete / Bisel con su descripción corta; elegir uno avisa", () => {
      const { props } = renderPanel();

      expect(screen.getByRole("radio", { name: "Redondo" })).toBeChecked();
      expect(screen.getByText("Las esquinas se redondean con un arco.")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("radio", { name: "Inglete" }));
      expect(props.onJoinStyleChange).toHaveBeenCalledWith("mitre");
      fireEvent.click(screen.getByRole("radio", { name: "Bisel" }));
      expect(props.onJoinStyleChange).toHaveBeenCalledWith("bevel");
    });

    it("el límite de inglete solo aparece con Inglete y se valida (> 0, hasta 100)", () => {
      const { props, rerender } = renderPanel();
      expect(screen.queryByLabelText(/Límite de inglete/)).not.toBeInTheDocument();

      rerender(<OffsetPanel {...props} joinStyle="mitre" />);
      const input = screen.getByLabelText("Límite de inglete (×)");
      fireEvent.change(input, { target: { value: "5" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(props.onMitreLimitChange).toHaveBeenLastCalledWith(5);
      fireEvent.change(input, { target: { value: "101" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(screen.getAllByRole("alert").at(-1)).toHaveTextContent(/debe estar entre/);
      expect(props.onMitreLimitChange).toHaveBeenCalledTimes(1);
    });

    it("los extremos de línea (Redondo / Plano / Cuadrado) solo aparecen si hay líneas", () => {
      const { props, rerender } = renderPanel();
      expect(screen.queryByRole("group", { name: "Extremos de las líneas" })).not.toBeInTheDocument();

      rerender(<OffsetPanel {...props} hasLines />);
      const caps = within(screen.getByRole("group", { name: "Extremos de las líneas" }));
      expect(caps.getAllByRole("radio").map((radio) => radio.parentElement?.textContent?.trim())).toEqual(["Redondo", "Plano", "Cuadrado"]);
      fireEvent.click(caps.getByRole("radio", { name: "Cuadrado" }));
      expect(props.onCapStyleChange).toHaveBeenCalledWith("square");
    });
  });

  describe("originales y capa del resultado", () => {
    it("«Conservar original» viene marcado y se puede cambiar; el texto dice qué pasa en cada caso", () => {
      const { props, rerender } = renderPanel();
      const checkbox = screen.getByRole("checkbox", { name: "Conservar original" });

      expect(checkbox).toBeChecked();
      expect(screen.getByText(/se agrega como un contorno nuevo y el original queda/)).toBeInTheDocument();
      fireEvent.click(checkbox);
      expect(props.onKeepOriginalsChange).toHaveBeenCalledWith(false);

      rerender(<OffsetPanel {...props} keepOriginals={false} />);
      expect(screen.getByText(/El original se reemplaza.*Lo que colapsa no se toca/)).toBeInTheDocument();
    });

    it("la capa del resultado por defecto es «la capa de cada objeto de origen» y el panel dice dónde cae", () => {
      renderPanel();
      const select = screen.getByLabelText("Dónde va el resultado") as HTMLSelectElement;

      expect(select.value).toBe(ORIGIN_LAYER_VALUE);
      expect(within(select).getByRole("option", { name: "La capa de cada objeto de origen" })).toBeInTheDocument();
      expect(screen.getByText(/Cada resultado va a la capa de su objeto de origen.*«Rojo» \(2 objetos\)/)).toBeInTheDocument();
    });

    it("ofrece las capas de los objetos, las demás desbloqueadas y una capa nueva; elegir avisa", () => {
      const { props } = renderPanel();
      const select = screen.getByLabelText("Dónde va el resultado") as HTMLSelectElement;

      expect(within(select).getByRole("group", { name: "Capas de los objetos" })).toHaveTextContent("Rojo (#ff0000)");
      expect(within(select).getByRole("group", { name: /Otras capas/ })).toHaveTextContent("Verde (#00ff00)");
      fireEvent.change(select, { target: { value: "C" } });
      expect(props.onTargetChange).toHaveBeenLastCalledWith("C");
      fireEvent.change(select, { target: { value: NEW_LAYER_VALUE } });
      expect(props.onTargetChange).toHaveBeenLastCalledWith(NEW_LAYER_VALUE);
    });

    it("con «capa nueva» aparece el campo del color y un destino inválido muestra el motivo como alerta", () => {
      const { props } = renderPanel({ targetValue: NEW_LAYER_VALUE, newColorHex: "rojo", targetIssue: "«rojo» no es un color hex válido (#RGB o #RRGGBB) para la capa nueva." });

      const hex = screen.getByLabelText(/Color de la capa nueva/);
      expect(hex).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByRole("alert")).toHaveTextContent(/no es un color hex válido/);
      fireEvent.change(hex, { target: { value: "#112233" } });
      expect(props.onNewColorChange).toHaveBeenCalledWith("#112233");
    });
  });

  describe("estado del cálculo y advertencias", () => {
    it("calculando / esperando / sin cálculo: lo anuncia", () => {
      const { props, rerender } = renderPanel({ preview: { status: "calculating", readyText: null, warnings: [], errorMessage: null } });
      expect(screen.getByRole("status")).toHaveTextContent("Calculando en el servidor…");

      rerender(<OffsetPanel {...props} preview={{ status: "waiting", readyText: null, warnings: [], errorMessage: null }} />);
      expect(screen.getByRole("status")).toHaveTextContent("Esperando para calcular…");
    });

    it("lista TODAS las advertencias (colapso, división, huecos) antes de confirmar", () => {
      renderPanel({
        preview: {
          status: "ready",
          readyText: "Resultado: 3 piezas a partir de 2 objetos.",
          warnings: [
            { kind: "collapse", text: "1 objeto colapsa con este offset (máximo interior ≈ 5 mm): desaparece y no se modifica." },
            { kind: "split", text: "1 objeto se divide en 2 piezas." },
            { kind: "holes_lost", text: "1 objeto pierde huecos (se cierran o se funden)." },
          ],
          errorMessage: null,
        },
      });

      const list = screen.getByRole("list", { name: "Advertencias del offset" });
      expect(within(list).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
        "1 objeto colapsa con este offset (máximo interior ≈ 5 mm): desaparece y no se modifica.",
        "1 objeto se divide en 2 piezas.",
        "1 objeto pierde huecos (se cierran o se funden).",
      ]);
    });

    it("sin advertencias no hay lista", () => {
      renderPanel();

      expect(screen.queryByRole("list", { name: "Advertencias del offset" })).not.toBeInTheDocument();
    });

    it("error recuperable del servidor: alerta con Reintentar", () => {
      const { props } = renderPanel({
        preview: { status: "error", readyText: null, warnings: [], errorMessage: "El motor de geometría no está disponible. No se modificó nada." },
        applyDisabledReason: "El cálculo falló: reintentalo o cambiá los valores.",
      });

      expect(screen.getByRole("alert")).toHaveTextContent("El motor de geometría no está disponible. No se modificó nada.");
      fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
      expect(props.onRetry).toHaveBeenCalled();
    });

    it("sin selección es una nota informativa (no una alerta); un rechazo real sí es alerta y no hay estado de cálculo", () => {
      const info = renderPanel({ rejection: { message: "Seleccioná uno o más objetos para desplazar su contorno.", info: true }, preview: { status: "idle", readyText: null, warnings: [], errorMessage: null } });
      expect(screen.getByRole("status")).toHaveTextContent("Seleccioná uno o más objetos");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      info.unmount();

      renderPanel({ rejection: { message: "1 objeto está en una capa bloqueada: no se pueden modificar.", info: false }, preview: { status: "idle", readyText: null, warnings: [], errorMessage: null } });
      expect(screen.getByRole("alert")).toHaveTextContent(/capa bloqueada/);
    });

    it("el mensaje del último intento de aplicar que falló se muestra como alerta", () => {
      renderPanel({ message: "El documento cambió mientras se calculaba. No se modificó nada." });

      expect(screen.getByRole("alert")).toHaveTextContent("El documento cambió mientras se calculaba");
    });
  });

  describe("colapso: confirmación explícita y Apply", () => {
    it("Apply/Cancel llaman a sus acciones; Apply muestra Enter y Cancel Escape en el título", () => {
      const { props } = renderPanel();

      const apply = screen.getByRole("button", { name: "Apply" });
      expect(apply).toBeEnabled();
      expect(apply).toHaveAttribute("title", expect.stringContaining("Enter"));
      expect(screen.getByRole("button", { name: "Cancel" })).toHaveAttribute("title", expect.stringContaining("Escape"));
      fireEvent.click(apply);
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(props.onApply).toHaveBeenCalledTimes(1);
      expect(props.onCancel).toHaveBeenCalledTimes(1);
    });

    it("TODOS colapsan: Apply deshabilitado y la explicación (con el máximo interior) visible como alerta", () => {
      const reason = "Todos los objetos colapsan con este offset (máximo interior ≈ 5 mm). Reducí el offset o elegí Exterior.";
      renderPanel({ applyDisabledReason: reason, preview: { status: "ready", readyText: "Todos los objetos colapsan…", warnings: [], errorMessage: null } });

      expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Apply" })).toHaveAttribute("title", reason);
      expect(screen.getByRole("alert")).toHaveTextContent(reason);
    });

    it("ALGUNOS colapsan: la casilla de confirmación explícita aparece desmarcada, Apply sigue deshabilitado y marcarla avisa", () => {
      const onChange = vi.fn();
      const reason = "1 objeto colapsa o pierde piezas: confirmá que se aplica solo a los demás, o ajustá el valor.";
      renderPanel({ applyDisabledReason: reason, confirmation: { text: "Entiendo que 1 objeto colapsa y no se modifica: aplicar solo a los demás.", confirmed: false, onChange } });

      expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
      const confirm = screen.getByRole("checkbox", { name: /Entiendo que 1 objeto colapsa/ });
      expect(confirm).not.toBeChecked();
      fireEvent.click(confirm);
      expect(onChange).toHaveBeenCalledWith(true);
    });

    it("confirmada la casilla y sin otro bloqueo, Apply se habilita", () => {
      renderPanel({ applyDisabledReason: null, confirmation: { text: "Entiendo que 1 objeto colapsa y no se modifica: aplicar solo a los demás.", confirmed: true, onChange: vi.fn() } });

      expect(screen.getByRole("checkbox", { name: /Entiendo que/ })).toBeChecked();
      expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled();
    });

    it("mientras se aplica, Apply queda deshabilitado y se anuncia", () => {
      renderPanel({ applying: true });

      expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
      expect(screen.getByRole("status")).toHaveTextContent("Aplicando…");
    });

    it("la tolerancia está en «Avanzado» y se valida (0,001 a 1 mm)", () => {
      const { props } = renderPanel();
      const input = screen.getByLabelText("Tolerancia (mm)");

      fireEvent.change(input, { target: { value: "0,05" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(props.onToleranceChange).toHaveBeenLastCalledWith(0.05);
      fireEvent.change(input, { target: { value: "0,0001" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(screen.getAllByRole("alert").at(-1)).toHaveTextContent(/debe estar entre 0,001/);
      expect(props.onToleranceChange).toHaveBeenCalledTimes(1);
    });
  });
});
