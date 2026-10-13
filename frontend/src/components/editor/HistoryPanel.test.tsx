import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { HistoryEntryView, HistoryNotice } from "../../hooks/useEditableDocument";
import type { EditorCommand } from "../../lib/editor/commands";
import { HistoryPanel } from "./HistoryPanel";

/** El panel de Historial aislado (M3-S12): lista, posición actual, entradas futuras, avisos, error, teclado y `aria-live`. */

function command(sequence: number, overrides: Partial<EditorCommand> = {}): EditorCommand {
  return {
    version: 1,
    id: `c${sequence}`,
    sequence,
    type: "object.move",
    label: `Acción ${sequence}`,
    targets: { layerIds: ["A"], objectIds: ["a1"] },
    parameters: { dx: 1, dy: 0, objectCount: 1 },
    origin: "user",
    timestamp: new Date(2026, 0, 1, 10, 30, sequence).getTime(),
    ...overrides,
  };
}

const entry = (sequence: number, applied: boolean, overrides: Partial<EditorCommand> = {}): HistoryEntryView => ({ command: command(sequence, overrides), applied });

function renderPanel(props: Partial<React.ComponentProps<typeof HistoryPanel>> = {}) {
  const handlers = { onJumpTo: vi.fn(), onDismissError: vi.fn(), onDismissNotice: vi.fn(), onClose: vi.fn() };
  const utils = render(<HistoryPanel entries={[entry(1, true), entry(2, true), entry(3, false)]} position={2} limit={200} busy={false} error={null} notices={[]} {...handlers} {...props} />);
  return { ...utils, ...handlers };
}

const panel = () => screen.getByRole("region", { name: "Historial de acciones" });
const entries = () => Array.from(panel().querySelectorAll<HTMLButtonElement>("button[data-command-type]"));

describe("HistoryPanel", () => {
  it("lista «Estado inicial» y cada acción en orden con tipo, etiqueta, hora y objetos/capas afectados", () => {
    renderPanel();
    expect(within(panel()).getAllByRole("listitem")).toHaveLength(4);
    expect(within(panel()).getAllByRole("listitem")[0]).toHaveTextContent("Estado inicial");
    const [first] = entries();
    expect(first).toHaveAttribute("data-command-type", "object.move");
    expect(first).toHaveTextContent("Acción 1");
    expect(first).toHaveTextContent("object.move");
    expect(first).toHaveTextContent("1 objeto · 1 capa");
    expect(first).toHaveTextContent(/10:30:01/);
  });

  it("marca la posición actual con aria-current y atenúa las entradas futuras (rama de rehacer)", () => {
    renderPanel();
    const [one, two, three] = entries();
    expect(two).toHaveAttribute("aria-current", "step");
    expect(two).toHaveTextContent("actual");
    expect(one).not.toHaveAttribute("aria-current");
    expect(three).toHaveAttribute("data-future", "true");
    expect(three.className).toContain("history-panel__entry--future");
    expect(three).toHaveTextContent("rehacer");
    expect(one).not.toHaveAttribute("data-future");
  });

  it("en el estado inicial (posición 0) la marca la fila «Estado inicial» y todo lo demás es futuro", () => {
    renderPanel({ position: 0, entries: [entry(1, false), entry(2, false)] });
    expect(screen.getByRole("button", { name: /Estado inicial/ })).toHaveAttribute("aria-current", "step");
    expect(entries().every((candidate) => candidate.dataset.future === "true")).toBe(true);
    expect(screen.getByText("Estado inicial: 2 acciones rehacibles.")).toBeInTheDocument();
  });

  it("anuncia la posición para lectores de pantalla (aria-live polite)", () => {
    const { rerender, ...rest } = renderPanel();
    const live = screen.getByText("Posición 2 de 3: Acción 2.");
    expect(live).toHaveAttribute("aria-live", "polite");
    rerender(<HistoryPanel entries={[entry(1, true), entry(2, false), entry(3, false)]} position={1} limit={200} busy={false} error={null} notices={[]} {...rest} />);
    expect(screen.getByText("Posición 1 de 3: Acción 1.")).toBeInTheDocument();
  });

  it("clic en una entrada llama a onJumpTo con su id; «Estado inicial» con null", () => {
    const { onJumpTo } = renderPanel();
    fireEvent.click(entries()[0]);
    expect(onJumpTo).toHaveBeenLastCalledWith("c1");
    fireEvent.click(entries()[2]);
    expect(onJumpTo).toHaveBeenLastCalledWith("c3");
    fireEvent.click(screen.getByRole("button", { name: /Estado inicial/ }));
    expect(onJumpTo).toHaveBeenLastCalledWith(null);
  });

  it("cada entrada es un <button type=button>: Enter y Espacio la activan de forma nativa", () => {
    renderPanel();
    for (const candidate of entries()) {
      expect(candidate.tagName).toBe("BUTTON");
      expect(candidate).toHaveAttribute("type", "button");
    }
  });

  it("el foco entra a la acción actual; ↑/↓/Inicio/Fin lo mueven entre «Estado inicial» y las acciones sin salirse de los extremos", () => {
    renderPanel();
    const initial = screen.getByRole("button", { name: /Estado inicial/ });
    const [one, two, three] = entries();
    expect(two).toHaveFocus();
    fireEvent.keyDown(two, { key: "ArrowDown" });
    expect(three).toHaveFocus();
    fireEvent.keyDown(three, { key: "ArrowDown" });
    expect(three).toHaveFocus();
    fireEvent.keyDown(three, { key: "Home" });
    expect(initial).toHaveFocus();
    fireEvent.keyDown(initial, { key: "ArrowUp" });
    expect(initial).toHaveFocus();
    fireEvent.keyDown(initial, { key: "ArrowDown" });
    expect(one).toHaveFocus();
    fireEvent.keyDown(one, { key: "End" });
    expect(three).toHaveFocus();
  });

  it("Escape y el botón ✕ cierran el panel", () => {
    const { onClose } = renderPanel();
    const [one] = entries();
    fireEvent.keyDown(one, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Cerrar el historial" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("el alcance del historial se dice en la propia UI (sesión, memoria, límite)", () => {
    renderPanel({ limit: 50 });
    expect(screen.getByText(/El historial dura mientras la sesión esté abierta/)).toBeInTheDocument();
    expect(screen.getByText(/Guarda las últimas 50 acciones/)).toBeInTheDocument();
  });

  it("muestra los avisos de truncado y de reinicio, y «Entendido» descarta cada uno", () => {
    const notices: HistoryNotice[] = [
      { kind: "truncated", message: "El historial guarda las últimas 3 acciones: se descartaron las 2 más antiguas." },
      { kind: "reset", message: "El documento se regeneró: el historial se reinició." },
    ];
    const { onDismissNotice } = renderPanel({ notices });
    const [truncated, reset] = screen.getAllByRole("status").filter((node) => node.className.includes("history-panel__notice"));
    expect(truncated).toHaveTextContent("se descartaron las 2 más antiguas");
    expect(reset).toHaveTextContent("el historial se reinició");
    fireEvent.click(within(truncated).getByRole("button", { name: "Entendido" }));
    expect(onDismissNotice).toHaveBeenLastCalledWith("truncated");
    fireEvent.click(within(reset).getByRole("button", { name: "Entendido" }));
    expect(onDismissNotice).toHaveBeenLastCalledWith("reset");
  });

  it("un error de metadata se anuncia como alerta y se puede cerrar", () => {
    const { onDismissError } = renderPanel({ error: "No se pudo deshacer el cambio de la capa «Rojo»." });
    expect(screen.getByRole("alert")).toHaveTextContent("No se pudo deshacer el cambio de la capa «Rojo».");
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Cerrar" }));
    expect(onDismissError).toHaveBeenCalledTimes(1);
  });

  it("mientras guarda un cambio de capa (busy) lo dice y deshabilita todas las entradas", () => {
    renderPanel({ busy: true });
    expect(screen.getByText(/Guardando un cambio de capa en el servidor/)).toBeInTheDocument();
    for (const candidate of [...entries(), screen.getByRole("button", { name: /Estado inicial/ })]) expect(candidate).toBeDisabled();
  });

  it("muestra el origen cuando no es el usuario (IA / sistema) y el conteo de objetos con parámetros o con targets", () => {
    renderPanel({
      entries: [
        entry(1, true, { origin: "ai" }),
        entry(2, true, { origin: "system", parameters: {}, targets: { layerIds: [], objectIds: ["x", "y", "z"] } }),
        entry(3, true, { type: "layer.rename", parameters: { from: "A", to: "B" }, targets: { layerIds: ["A"], objectIds: [] } }),
      ],
      position: 3,
    });
    const [ai, system, rename] = entries();
    expect(ai).toHaveTextContent("IA");
    expect(system).toHaveTextContent("sistema");
    expect(system).toHaveTextContent("3 objetos");
    expect(rename).toHaveTextContent("1 capa");
    expect(rename).not.toHaveTextContent("objeto");
    expect(rename).toHaveAttribute("data-command-type", "layer.rename");
  });

  it("sin acciones solo hay «Estado inicial»", () => {
    renderPanel({ entries: [], position: 0 });
    expect(within(panel()).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("Estado inicial: 0 acciones rehacibles.")).toBeInTheDocument();
  });
});
