import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CutPanel } from "./CutPanel";

type Props = Parameters<typeof CutPanel>[0];

function baseProps(overrides: Partial<Props> = {}): Props {
  return {
    mode: "split",
    onModeChange: vi.fn(),
    slotWidth: 0.2,
    unitLabel: "mm",
    onSlotWidthChange: vi.fn(),
    scaleNotice: null,
    extend: false,
    onExtendChange: vi.fn(),
    scopeText: "Alcance: la selección (2 objetos).",
    linePoints: 2,
    lineFinished: true,
    onFinishLine: vi.fn(),
    onUndoPoint: vi.fn(),
    onClearLine: vi.fn(),
    preview: { status: "ready", readyText: "Se cortarán 2 objetos: Rojo · objeto 1, Rojo · objeto 2. Resultado: 4 piezas.", warnings: [], errorMessage: null },
    rejection: null,
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
  const utils = render(<CutPanel {...props} />);
  return { props, ...utils };
};

describe("CutPanel (M3-S10)", () => {
  it("es una región con nombre (Cut) y su estado se anuncia en una región aria-live", () => {
    renderPanel();

    expect(screen.getByRole("heading", { name: "Cut" })).toBeInTheDocument();
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("Se cortarán 2 objetos");
  });

  describe("modo", () => {
    it("Dividir y Separar con hueco son radios con nombre; el activo está marcado y se indica por escrito", () => {
      const { props } = renderPanel();

      expect(screen.getByRole("radio", { name: "Dividir" })).toBeChecked();
      expect(screen.getByRole("radio", { name: "Separar con hueco" })).not.toBeChecked();
      expect(screen.getByText(/Modo activo: Dividir\./)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("radio", { name: "Separar con hueco" }));
      expect(props.onModeChange).toHaveBeenCalledWith("slot");
    });

    it("el campo del ancho de la ranura solo existe en el modo Separar con hueco, con su unidad y rango", () => {
      const { rerender, props } = renderPanel();
      expect(screen.queryByLabelText(/Ancho de la ranura/)).not.toBeInTheDocument();

      rerender(<CutPanel {...props} mode="slot" />);

      expect(screen.getByText(/Modo activo: Separar con hueco\./)).toBeInTheDocument();
      expect(screen.getByLabelText("Ancho de la ranura (mm)")).toHaveValue("0.2");
      expect(screen.getByText(/Entre 0,01 y 100 mm/)).toBeInTheDocument();
    });

    it("el ancho de la ranura se confirma con Enter, se rechaza fuera de rango y conserva el anterior", () => {
      const { props } = renderPanel({ mode: "slot" });
      const field = screen.getByLabelText("Ancho de la ranura (mm)");

      fireEvent.change(field, { target: { value: "0,5" } });
      fireEvent.keyDown(field, { key: "Enter" });
      expect(props.onSlotWidthChange).toHaveBeenLastCalledWith(0.5);

      fireEvent.change(field, { target: { value: "0,001" } });
      fireEvent.keyDown(field, { key: "Enter" });
      expect(props.onSlotWidthChange).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("alert")).toHaveTextContent(/debe estar entre 0,01/);
    });

    it("sin escala física el ancho va en unidades y se muestra el aviso", () => {
      renderPanel({ mode: "slot", unitLabel: "u", scaleNotice: "Sin escala física: el corte es en unidades del documento (u), no en mm." });

      expect(screen.getByLabelText("Ancho de la ranura (u)")).toBeInTheDocument();
      expect(screen.getByRole("note")).toHaveTextContent(/Sin escala física/);
    });
  });

  describe("extender", () => {
    it("la casilla «Extender el corte hasta cruzar todo» avisa y explica qué pasa sin ella", () => {
      const { props, rerender } = renderPanel();

      const box = screen.getByRole("checkbox", { name: "Extender el corte hasta cruzar todo" });
      expect(box).not.toBeChecked();
      expect(screen.getByText(/NO la divide: queda intacta/)).toBeInTheDocument();
      fireEvent.click(box);
      expect(props.onExtendChange).toHaveBeenCalledWith(true);

      rerender(<CutPanel {...props} extend />);
      expect(screen.getByRole("checkbox", { name: "Extender el corte hasta cruzar todo" })).toBeChecked();
      expect(screen.getByText(/se prolongan lo necesario/)).toBeInTheDocument();
    });
  });

  describe("línea de corte", () => {
    it("cuenta los puntos y dice si está terminada o en curso", () => {
      const { rerender, props } = renderPanel({ linePoints: 0, lineFinished: false });
      expect(screen.getByText("Todavía no hay línea de corte.")).toBeInTheDocument();

      rerender(<CutPanel {...props} linePoints={1} lineFinished={false} />);
      expect(screen.getByText("Línea de corte: 1 punto.")).toBeInTheDocument();
      rerender(<CutPanel {...props} linePoints={3} lineFinished={false} />);
      expect(screen.getByText("Línea de corte: 3 puntos (en curso).")).toBeInTheDocument();
      rerender(<CutPanel {...props} linePoints={3} lineFinished />);
      expect(screen.getByText("Línea de corte: 3 puntos (terminada).")).toBeInTheDocument();
    });

    it("los botones equivalentes al teclado: terminar (solo con >= 2 puntos y sin terminar), quitar el último punto y borrar", () => {
      const { props, rerender } = renderPanel({ linePoints: 3, lineFinished: false });

      fireEvent.click(screen.getByRole("button", { name: "Terminar línea" }));
      fireEvent.click(screen.getByRole("button", { name: "Quitar último punto" }));
      fireEvent.click(screen.getByRole("button", { name: "Borrar línea" }));
      expect(props.onFinishLine).toHaveBeenCalledTimes(1);
      expect(props.onUndoPoint).toHaveBeenCalledTimes(1);
      expect(props.onClearLine).toHaveBeenCalledTimes(1);

      rerender(<CutPanel {...props} linePoints={1} lineFinished={false} />);
      expect(screen.getByRole("button", { name: "Terminar línea" })).toBeDisabled();
      rerender(<CutPanel {...props} linePoints={3} lineFinished />);
      expect(screen.getByRole("button", { name: "Terminar línea" })).toBeDisabled();
      rerender(<CutPanel {...props} linePoints={0} lineFinished={false} />);
      expect(screen.getByRole("button", { name: "Quitar último punto" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Borrar línea" })).toBeDisabled();
    });
  });

  it("muestra el alcance (selección o «todos los que la línea cruza»)", () => {
    renderPanel({ scopeText: "Alcance: sin selección, se cortan todos los objetos visibles y desbloqueados que la línea cruza." });

    expect(screen.getByText(/sin selección, se cortan todos los objetos visibles y desbloqueados/)).toBeInTheDocument();
  });

  describe("estado del cálculo", () => {
    it("calculando y esperando se anuncian; sin resultado no hay advertencias", () => {
      const { rerender, props } = renderPanel({ preview: { status: "calculating", readyText: null, warnings: [], errorMessage: null } });
      expect(screen.getByRole("status")).toHaveTextContent("Calculando en el servidor…");

      rerender(<CutPanel {...props} preview={{ status: "waiting", readyText: null, warnings: [], errorMessage: null }} />);
      expect(screen.getByRole("status")).toHaveTextContent("Esperando para calcular…");
    });

    it("las advertencias (no atraviesa, omitidos, descartes) se listan con su tipo y solo cuando el resultado está listo", () => {
      const warnings = [
        { kind: "intact" as const, text: "El corte no atraviesa completamente «Rojo · objeto 2»: queda intacto." },
        { kind: "locked" as const, text: "1 objeto en una capa bloqueada se omite: no se modifica." },
      ];
      const { rerender, props } = renderPanel({ preview: { status: "ready", readyText: "Se cortarán 1 objeto", warnings, errorMessage: null } });

      const list = screen.getByRole("list", { name: "Advertencias del corte" });
      expect(list).toHaveTextContent("no atraviesa completamente «Rojo · objeto 2»");
      expect(list).toHaveTextContent("capa bloqueada se omite");
      expect(list.querySelector(".cut-panel__warning--intact")).not.toBeNull();

      rerender(<CutPanel {...props} preview={{ status: "calculating", readyText: null, warnings, errorMessage: null }} />);
      expect(screen.queryByRole("list", { name: "Advertencias del corte" })).not.toBeInTheDocument();
    });

    it("sin línea todavía, la ayuda se muestra como información (no como error) y no hay estado de cálculo", () => {
      renderPanel({
        linePoints: 0,
        lineFinished: false,
        rejection: { message: "Dibujá la línea de corte: click por cada punto.", info: true },
        preview: { status: "idle", readyText: null, warnings: [], errorMessage: null },
        applyDisabledReason: "Dibujá la línea de corte: click por cada punto.",
      });

      expect(screen.getByRole("status")).toHaveTextContent("Dibujá la línea de corte: click por cada punto.");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("un rechazo real (ranura inválida, nada que cortar...) es una alerta y no hay resultado", () => {
      renderPanel({ rejection: { message: "La línea de corte no cruza ningún objeto visible y desbloqueado. No se modificó nada.", info: false }, applyDisabledReason: "x" });

      expect(screen.getByRole("alert")).toHaveTextContent("La línea de corte no cruza ningún objeto");
      expect(screen.getByRole("status")).not.toHaveTextContent("Se cortarán");
    });

    it("un error del servidor es una alerta recuperable con Reintentar", () => {
      const { props } = renderPanel({
        preview: { status: "error", readyText: null, warnings: [], errorMessage: "El motor de geometría no está disponible. No se modificó nada." },
        applyDisabledReason: "El cálculo falló: reintentalo o cambiá la línea.",
      });

      expect(screen.getByRole("alert")).toHaveTextContent("El motor de geometría no está disponible");
      fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
      expect(props.onRetry).toHaveBeenCalledTimes(1);
    });

    it("«Aplicando…» se anuncia durante Apply", () => {
      renderPanel({ applying: true });

      expect(screen.getByRole("status")).toHaveTextContent("Aplicando…");
    });
  });

  describe("Apply / Cancel", () => {
    it("Apply habilitado aplica; Cancel cancela", () => {
      const { props } = renderPanel();

      fireEvent.click(screen.getByRole("button", { name: "Apply" }));
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(props.onApply).toHaveBeenCalledTimes(1);
      expect(props.onCancel).toHaveBeenCalledTimes(1);
    });

    it("si ningún objeto cambia Apply queda deshabilitado y el motivo se ve (en el panel y en el tooltip)", () => {
      const reason = "El corte no atraviesa completamente «Rojo · objeto 1»: ningún objeto cambia. Prolongá la línea.";
      const { props } = renderPanel({
        applyDisabledReason: reason,
        preview: { status: "ready", readyText: "Ningún objeto cambia con este corte.", warnings: [], errorMessage: null },
      });

      const apply = screen.getByRole("button", { name: "Apply" });
      expect(apply).toBeDisabled();
      expect(apply).toHaveAttribute("title", reason);
      expect(screen.getByRole("alert")).toHaveTextContent(reason);
      fireEvent.click(apply);
      expect(props.onApply).not.toHaveBeenCalled();
    });

    it("Apply se deshabilita mientras se aplica, y un mensaje de fallo del último intento se muestra", () => {
      const { rerender, props } = renderPanel({ applying: true });
      expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();

      rerender(<CutPanel {...props} applying={false} message="El documento cambió mientras se calculaba. No se modificó nada." />);
      expect(screen.getByRole("alert")).toHaveTextContent("El documento cambió mientras se calculaba");
    });
  });
});
