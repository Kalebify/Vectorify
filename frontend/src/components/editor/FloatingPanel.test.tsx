import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FloatingPanel, type FloatingPanelProps } from "./FloatingPanel";

function props(overrides: Partial<FloatingPanelProps> = {}): FloatingPanelProps {
  return {
    mode: "stencil",
    onModeChange: vi.fn(),
    scopeText: "Capas CUT: Rojo (2 objetos).",
    unitLabel: "mm",
    scaleNotice: null,
    widthMm: 0.8,
    widthMin: 0.05,
    widthMax: 20,
    onWidthChange: vi.fn(),
    analysis: { status: "idle", stale: false, summary: null, errorMessage: null, hasAnalysis: false },
    onAnalyze: vi.fn(),
    onRetryAnalysis: vi.fn(),
    issues: [],
    selectedIssue: null,
    onSelectIssue: vi.fn(),
    bridges: {
      visible: false,
      status: "idle",
      rows: [],
      readyText: null,
      reanalysisText: null,
      areaVerb: "quita",
      warnings: [],
      errorMessage: null,
      rejection: null,
      suggestPending: false,
      count: 0,
    },
    placing: null,
    onTogglePlacing: vi.fn(),
    onStartMoving: vi.fn(),
    onRemoveBridge: vi.fn(),
    onSuggest: vi.fn(),
    onRetryBridges: vi.fn(),
    message: null,
    applying: false,
    applyDisabledReason: "Primero analizá las piezas flotantes.",
    onApply: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
}

const ISSUES = [
  { id: 1, label: "Isla 1", description: "Isla 1 · 100 mm² · rodeada por «Rojo · objeto 1»", depth: 1 },
  { id: 4, label: "Isla 2", description: "Isla 2 · 50 mm² · rodeada por «Azul · objeto 1»", depth: 1 },
  { id: 7, label: "Isla 3", description: "Isla 3 · 12,5 mm² · rodeada por «Gris · objeto 1»", depth: 2 },
];

const ROW = { index: 0, key: "s1", label: "Bridge 1", islandLabel: "Isla 1", suggested: true, valid: true, reasonText: null, length: 5, area: 4, reduces: true, moving: false };

function withBridges(overrides: Partial<FloatingPanelProps["bridges"]> = {}, rest: Partial<FloatingPanelProps> = {}): FloatingPanelProps {
  const base = props();
  return props({
    analysis: { status: "ready", stale: false, summary: "Se encontraron 3 islas (se caen al cortar).", errorMessage: null, hasAnalysis: true },
    issues: ISSUES,
    bridges: { ...base.bridges, visible: true, status: "ready", rows: [ROW], readyText: "1 bridge", reanalysisText: "3 flotantes → 2", count: 1, ...overrides },
    applyDisabledReason: null,
    ...rest,
  });
}

describe("FloatingPanel", () => {
  describe("modo y alcance", () => {
    it("muestra los dos modos con su descripción y el activo por escrito; cambiar de modo avisa", () => {
      const onModeChange = vi.fn();
      render(<FloatingPanel {...props({ onModeChange })} />);

      expect(screen.getByRole("radio", { name: /Plantilla \(stencil\)/ })).toBeChecked();
      expect(screen.getByRole("radio", { name: /Piezas/ })).not.toBeChecked();
      expect(screen.getByText(/Modo activo: Plantilla \(stencil\)\./)).toBeInTheDocument();
      expect(screen.getByText(/Las formas son cortes \(vacío\)/)).toBeInTheDocument();

      fireEvent.click(screen.getByRole("radio", { name: /Piezas/ }));
      expect(onModeChange).toHaveBeenCalledWith("parts");
    });

    it("en modo Piezas el texto activo es el de las piezas", () => {
      render(<FloatingPanel {...props({ mode: "parts" })} />);

      expect(screen.getByRole("radio", { name: /Piezas/ })).toBeChecked();
      expect(screen.getByText(/Modo activo: Piezas\./)).toBeInTheDocument();
      expect(screen.getByText(/Las formas son material/)).toBeInTheDocument();
    });

    it("dice qué se analiza y, sin escala física, avisa que mide en unidades", () => {
      render(<FloatingPanel {...props({ scopeText: "Selección: 3 objetos.", scaleNotice: "Sin escala física: los bridges se miden en unidades del documento (u), no en mm." })} />);

      expect(screen.getByText("Selección: 3 objetos.")).toBeInTheDocument();
      expect(screen.getByRole("note")).toHaveTextContent(/Sin escala física/);
    });
  });

  describe("Analizar y estado", () => {
    it("el botón Analizar llama a onAnalyze y pasa a «Volver a analizar» con un análisis hecho", () => {
      const onAnalyze = vi.fn();
      const { rerender } = render(<FloatingPanel {...props({ onAnalyze })} />);

      fireEvent.click(screen.getByRole("button", { name: "Analizar" }));
      expect(onAnalyze).toHaveBeenCalledTimes(1);

      rerender(<FloatingPanel {...withBridges({}, { onAnalyze })} />);
      expect(screen.queryByRole("button", { name: "Analizar" })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Volver a analizar" }));
      expect(onAnalyze).toHaveBeenCalledTimes(2);
    });

    it("el estado se anuncia en una región aria-live: analizando, resumen y calculando los bridges", () => {
      const { rerender } = render(<FloatingPanel {...props({ analysis: { status: "calculating", stale: false, summary: null, errorMessage: null, hasAnalysis: true } })} />);
      const status = screen.getAllByRole("status")[0];
      expect(status).toHaveAttribute("aria-live", "polite");
      expect(status).toHaveTextContent("Analizando en el servidor…");

      rerender(<FloatingPanel {...props({ analysis: { status: "waiting", stale: false, summary: null, errorMessage: null, hasAnalysis: true } })} />);
      expect(status).toHaveTextContent("Esperando para analizar…");

      rerender(<FloatingPanel {...withBridges({ status: "calculating", reanalysisText: null })} />);
      expect(status).toHaveTextContent("Se encontraron 3 islas");
      expect(status).toHaveTextContent("Calculando los bridges en el servidor…");
    });

    it("un análisis viejo se avisa con un alert; un error del análisis trae Reintentar", () => {
      const onRetryAnalysis = vi.fn();
      const { rerender } = render(<FloatingPanel {...props({ analysis: { status: "idle", stale: true, summary: null, errorMessage: null, hasAnalysis: true } })} />);
      expect(screen.getByRole("alert")).toHaveTextContent(/El documento cambió desde el análisis: volvé a analizar\. No se modificó nada\./);

      rerender(<FloatingPanel {...props({ onRetryAnalysis, analysis: { status: "error", stale: false, summary: null, errorMessage: "El servidor no pudo completar el cálculo.", hasAnalysis: true } })} />);
      expect(screen.getByRole("alert")).toHaveTextContent("El servidor no pudo completar el cálculo.");
      fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
      expect(onRetryAnalysis).toHaveBeenCalledTimes(1);
    });
  });

  describe("lista de issues", () => {
    it("es un listbox con opciones; la seleccionada lleva aria-selected y aria-activedescendant", () => {
      render(<FloatingPanel {...withBridges({}, { selectedIssue: 4 })} />);

      const list = screen.getByRole("listbox");
      const options = within(list).getAllByRole("option");
      expect(options.map((option) => option.textContent)).toEqual(ISSUES.map((issue) => issue.description));
      expect(options.map((option) => option.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
      expect(list).toHaveAttribute("aria-activedescendant", options[1].id);
      expect(list).toHaveAccessibleName(/3 piezas/);
      expect(list).toHaveAttribute("tabindex", "0");
    });

    it("hacer click en una opción la selecciona", () => {
      const onSelectIssue = vi.fn();
      render(<FloatingPanel {...withBridges({}, { onSelectIssue })} />);

      fireEvent.click(screen.getAllByRole("option")[2]);

      expect(onSelectIssue).toHaveBeenCalledWith(7);
    });

    it("el teclado recorre la lista: ↓ empieza en la primera y no pasa de la última; ↑ al revés; Inicio/Fin; Enter vuelve a centrar la seleccionada", () => {
      const onSelectIssue = vi.fn();
      const { rerender } = render(<FloatingPanel {...withBridges({}, { onSelectIssue, selectedIssue: null })} />);
      const list = () => screen.getByRole("listbox");

      fireEvent.keyDown(list(), { key: "ArrowDown" });
      expect(onSelectIssue).toHaveBeenLastCalledWith(1);
      fireEvent.keyDown(list(), { key: "ArrowUp" });
      expect(onSelectIssue).toHaveBeenLastCalledWith(7); // sin selección, ↑ empieza por la última
      fireEvent.keyDown(list(), { key: "End" });
      expect(onSelectIssue).toHaveBeenLastCalledWith(7);
      fireEvent.keyDown(list(), { key: "Home" });
      expect(onSelectIssue).toHaveBeenLastCalledWith(1);

      rerender(<FloatingPanel {...withBridges({}, { onSelectIssue, selectedIssue: 4 })} />);
      fireEvent.keyDown(list(), { key: "ArrowDown" });
      expect(onSelectIssue).toHaveBeenLastCalledWith(7);
      fireEvent.keyDown(list(), { key: "ArrowUp" });
      expect(onSelectIssue).toHaveBeenLastCalledWith(1);
      fireEvent.keyDown(list(), { key: "Enter" });
      expect(onSelectIssue).toHaveBeenLastCalledWith(4);

      rerender(<FloatingPanel {...withBridges({}, { onSelectIssue, selectedIssue: 7 })} />);
      onSelectIssue.mockClear();
      fireEvent.keyDown(list(), { key: "ArrowDown" });
      expect(onSelectIssue).toHaveBeenLastCalledWith(7); // ya es la última
      fireEvent.keyDown(list(), { key: "a" });
      expect(onSelectIssue).toHaveBeenCalledTimes(1); // otras teclas no hacen nada
    });

    it("Enter sin selección y una lista vacía no hacen nada", () => {
      const onSelectIssue = vi.fn();
      render(<FloatingPanel {...withBridges({}, { onSelectIssue, selectedIssue: null })} />);

      fireEvent.keyDown(screen.getByRole("listbox"), { key: "Enter" });

      expect(onSelectIssue).not.toHaveBeenCalled();
    });

    it("sin issues no hay lista", () => {
      render(<FloatingPanel {...props()} />);

      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });
  });

  describe("bridges", () => {
    it("sin análisis o sin piezas flotantes la sección de bridges no se muestra", () => {
      render(<FloatingPanel {...props()} />);

      expect(screen.queryByRole("group", { name: "Bridges" })).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/Ancho del bridge/)).not.toBeInTheDocument();
    });

    it("muestra el ancho en mm, las acciones y el reanálisis «N flotantes → M» destacado", () => {
      render(<FloatingPanel {...withBridges()} />);

      expect(screen.getByLabelText(/Ancho del bridge \(mm\)/)).toHaveValue("0.8");
      expect(screen.getByTestId("floating-reanalysis")).toHaveTextContent("3 flotantes → 2");
      expect(screen.getByRole("button", { name: "Sugerir bridges" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Colocar bridge" })).toHaveAttribute("aria-pressed", "false");
    });

    it("el ancho se confirma en mm y fuera de rango se rechaza sin avisar al shell", () => {
      const onWidthChange = vi.fn();
      render(<FloatingPanel {...withBridges({}, { onWidthChange })} />);
      const field = screen.getByLabelText(/Ancho del bridge/);

      fireEvent.change(field, { target: { value: "1,5" } });
      fireEvent.keyDown(field, { key: "Enter" });
      expect(onWidthChange).toHaveBeenCalledWith(1.5);

      fireEvent.change(field, { target: { value: "25" } });
      fireEvent.keyDown(field, { key: "Enter" });
      expect(onWidthChange).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/debe estar entre 0.05 \(inclusive\) y 20 mm/)).toBeInTheDocument();

      fireEvent.change(field, { target: { value: "0.01" } });
      fireEvent.keyDown(field, { key: "Enter" });
      expect(onWidthChange).toHaveBeenCalledTimes(1);

      fireEvent.change(field, { target: { value: "0,05" } });
      fireEvent.keyDown(field, { key: "Enter" });
      expect(onWidthChange).toHaveBeenLastCalledWith(0.05); // el extremo exacto se acepta
    });

    it("las acciones llaman a sus manejadores: sugerir, colocar y, por bridge, mover y quitar", () => {
      const handlers = { onSuggest: vi.fn(), onTogglePlacing: vi.fn(), onStartMoving: vi.fn(), onRemoveBridge: vi.fn() };
      render(<FloatingPanel {...withBridges({}, handlers)} />);

      fireEvent.click(screen.getByRole("button", { name: "Sugerir bridges" }));
      fireEvent.click(screen.getByRole("button", { name: "Colocar bridge" }));
      fireEvent.click(screen.getByRole("button", { name: "Mover Bridge 1" }));
      fireEvent.click(screen.getByRole("button", { name: "Quitar Bridge 1" }));

      expect(handlers.onSuggest).toHaveBeenCalledTimes(1);
      expect(handlers.onTogglePlacing).toHaveBeenCalledTimes(1);
      expect(handlers.onStartMoving).toHaveBeenCalledWith("s1");
      expect(handlers.onRemoveBridge).toHaveBeenCalledWith("s1");
    });

    it("un bridge válido dice su isla, el largo y lo que quita (o agrega en Piezas); uno que no reduce lo dice", () => {
      const rows = [ROW, { ...ROW, index: 1, key: "m1", label: "Bridge 2", suggested: false, reduces: false, area: 7.5, length: 5 }];
      const { rerender } = render(<FloatingPanel {...withBridges({ rows })} />);

      const text = screen.getAllByTestId("floating-bridge-row").map((row) => row.textContent);
      expect(text[0]).toContain("Bridge 1 · Isla 1 · sugerido · largo 5 mm · quita 4 mm²");
      expect(text[0]).not.toContain("no reduce");
      expect(text[1]).toContain("Bridge 2 · Isla 1 · largo 5 mm · quita 7.5 mm² · no reduce nada");

      rerender(<FloatingPanel {...withBridges({ rows: [ROW], areaVerb: "agrega" }, { mode: "parts" })} />);
      expect(screen.getByTestId("floating-bridge-row").textContent).toContain("agrega 4 mm²");
    });

    it("un bridge inválido muestra su motivo y se distingue (clase); uno sugerido no resuelto no tiene Mover/Quitar", () => {
      const invalid = { ...ROW, index: 1, key: "m1", label: "Bridge 2", suggested: false, valid: false, reasonText: "queda corto: no llega al otro lado", length: null, area: null, reduces: false };
      const unresolved = { ...invalid, index: 2, key: null, label: "Bridge 3", suggested: true, reasonText: "no cruza ningún hueco en esa dirección" };
      render(<FloatingPanel {...withBridges({ rows: [ROW, invalid, unresolved] })} />);

      const rows = screen.getAllByTestId("floating-bridge-row");
      expect(rows[1]).toHaveTextContent("inválido: queda corto: no llega al otro lado");
      expect(rows[1]).toHaveClass("floating-panel__bridge--invalid");
      expect(rows[2]).toHaveTextContent("inválido: no cruza ningún hueco en esa dirección");
      expect(within(rows[2]).queryByRole("button")).not.toBeInTheDocument();
      expect(within(rows[1]).getByRole("button", { name: "Quitar Bridge 2" })).toBeInTheDocument();
    });

    it("el modo de colocación se indica (aria-pressed y una nota); mover tiene su propia nota y el bridge que se mueve queda marcado", () => {
      const { rerender } = render(<FloatingPanel {...withBridges({}, { placing: "add" })} />);
      expect(screen.getByRole("button", { name: "Colocar bridge" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByText(/Hacé click sobre el borde de una pieza flotante para colocar un bridge\. Escape sale del modo\./)).toBeInTheDocument();

      rerender(<FloatingPanel {...withBridges({ rows: [{ ...ROW, moving: true }] }, { placing: "move" })} />);
      expect(screen.getByRole("button", { name: "Mover Bridge 1" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByText(/para mover el bridge ahí/)).toBeInTheDocument();
    });

    it("los avisos antes de confirmar se listan; un error de los bridges trae Reintentar; el rechazo informativo no es un alert", () => {
      const onRetryBridges = vi.fn();
      const warnings = [
        { kind: "uncovered" as const, text: "1 isla sin bridge: Isla 2. Queda flotando." },
        { kind: "locked" as const, text: "1 objeto en una capa bloqueada cuenta para el análisis y no se modifica." },
      ];
      const { rerender } = render(<FloatingPanel {...withBridges({ warnings })} />);
      const list = screen.getByRole("list", { name: "Advertencias de los bridges" });
      expect(within(list).getAllByRole("listitem").map((item) => item.textContent)).toEqual(warnings.map((warning) => warning.text));

      rerender(<FloatingPanel {...withBridges({ status: "error", errorMessage: "El cálculo tardó demasiado y se canceló. No se modificó nada.", reanalysisText: null }, { onRetryBridges })} />);
      expect(screen.getByRole("alert")).toHaveTextContent(/El cálculo tardó demasiado/);
      fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
      expect(onRetryBridges).toHaveBeenCalledTimes(1);

      rerender(<FloatingPanel {...withBridges({ rows: [], rejection: { message: "No hay bridges. Usá «Sugerir bridges».", info: true } })} />);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.getByText(/No hay bridges\. Usá «Sugerir bridges»/)).toBeInTheDocument();

      rerender(<FloatingPanel {...withBridges({ rows: [], rejection: { message: "El ancho del bridge tiene que estar entre 0.05 y 20 mm.", info: false } })} />);
      expect(screen.getByRole("alert")).toHaveTextContent(/El ancho del bridge tiene que estar entre/);
    });

    it("mientras se calculan las sugerencias lo dice", () => {
      render(<FloatingPanel {...withBridges({ rows: [], status: "calculating", reanalysisText: null, suggestPending: true })} />);

      expect(screen.getByText("Calculando las sugerencias…")).toBeInTheDocument();
    });
  });

  describe("Apply / Cancel", () => {
    it("Apply está deshabilitado con el motivo en el title y, si el resultado ya está listo, también en un alert visible", () => {
      const reason = "1 bridge es inválido: quitalo o corregilo antes de aplicar.";
      render(<FloatingPanel {...withBridges({}, { applyDisabledReason: reason })} />);

      const apply = screen.getByRole("button", { name: "Apply" });
      expect(apply).toBeDisabled();
      expect(apply).toHaveAttribute("title", reason);
      expect(screen.getByRole("alert")).toHaveTextContent(reason);
    });

    it("sin análisis el motivo está en el title pero no hay alert (no es un error)", () => {
      render(<FloatingPanel {...props()} />);

      expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("habilitado, Apply y Cancel llaman a sus manejadores; mientras aplica queda deshabilitado y lo dice", () => {
      const onApply = vi.fn();
      const onCancel = vi.fn();
      const { rerender } = render(<FloatingPanel {...withBridges({}, { onApply, onCancel })} />);

      fireEvent.click(screen.getByRole("button", { name: "Apply" }));
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(onApply).toHaveBeenCalledTimes(1);
      expect(onCancel).toHaveBeenCalledTimes(1);

      rerender(<FloatingPanel {...withBridges({}, { onApply, onCancel, applying: true })} />);
      expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
      expect(screen.getAllByRole("status")[0]).toHaveTextContent("Aplicando…");
    });

    it("el mensaje del último intento fallido se muestra como alert", () => {
      render(<FloatingPanel {...props({ message: "Hacé click sobre el borde de una pieza flotante marcada." })} />);

      expect(screen.getByRole("alert")).toHaveTextContent("Hacé click sobre el borde de una pieza flotante marcada.");
    });
  });
});
