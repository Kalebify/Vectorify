import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { clipboardAvailability, CLIPBOARD_SHORTCUTS, type ClipboardAction } from "../../lib/editor/clipboard";
import { ClipboardBar, type ClipboardNotice } from "./ClipboardBar";

const ENABLED = clipboardAvailability({ selected: 2, editable: 2, clipboardSize: 3, hasActiveLayer: true, suspended: false });

function renderBar(props: Partial<React.ComponentProps<typeof ClipboardBar>> = {}) {
  const onAction = vi.fn<(action: ClipboardAction) => void>();
  const utils = render(<ClipboardBar availability={ENABLED} clipboardSize={3} notice={null} onAction={onAction} {...props} />);
  return { ...utils, onAction };
}

const button = (name: RegExp | string) => screen.getByRole("button", { name });

describe("ClipboardBar", () => {
  it("expone un toolbar con un botón por acción; el nombre accesible incluye el atajo y aria-keyshortcuts lo anuncia", () => {
    renderBar();
    const toolbar = screen.getByRole("toolbar", { name: "Copiar, pegar y eliminar" });
    expect(within(toolbar).getAllByRole("button")).toHaveLength(CLIPBOARD_SHORTCUTS.length);
    expect(button("Copiar (Ctrl/Cmd+C)")).toHaveAttribute("aria-keyshortcuts", "Control+C Meta+C");
    expect(button("Cortar (Ctrl/Cmd+X)")).toBeInTheDocument();
    expect(button("Pegar (Ctrl/Cmd+V)")).toBeInTheDocument();
    expect(button("Pegar en el lugar (Ctrl/Cmd+Shift+V)")).toBeInTheDocument();
    expect(button("Pegar en la capa activa (Ctrl/Cmd+Alt+V)")).toBeInTheDocument();
    expect(button("Duplicar (Ctrl/Cmd+D)")).toBeInTheDocument();
    expect(button("Eliminar (Suprimir / Retroceso)")).toHaveAttribute("aria-keyshortcuts", "Delete Backspace");
  });

  it("cada botón dispara SU acción", () => {
    const { onAction } = renderBar();
    for (const { label, keys } of CLIPBOARD_SHORTCUTS) fireEvent.click(button(`${label} (${keys})`));
    expect(onAction.mock.calls.map(([action]) => action)).toEqual(CLIPBOARD_SHORTCUTS.map((shortcut) => shortcut.action));
  });

  it("deshabilitado: el botón no dispara nada y su tooltip dice POR QUÉ", () => {
    const availability = clipboardAvailability({ selected: 0, editable: 0, clipboardSize: 0, hasActiveLayer: false, suspended: false });
    const { onAction } = renderBar({ availability, clipboardSize: 0 });
    for (const { label, keys } of CLIPBOARD_SHORTCUTS) {
      const control = button(`${label} (${keys})`);
      expect(control).toBeDisabled();
      expect(control).toHaveAttribute("title", expect.stringMatching(/\S/));
      fireEvent.click(control);
    }
    expect(onAction).not.toHaveBeenCalled();
    expect(button(/^Copiar/)).toHaveAttribute("title", "Seleccioná objetos para copiar.");
    expect(button(/^Pegar \(/)).toHaveAttribute("title", expect.stringContaining("portapapeles está vacío"));
  });

  it("habilitado: el tooltip es el nombre con su atajo", () => {
    renderBar();
    expect(button(/^Pegar \(/)).toHaveAttribute("title", "Pegar (Ctrl/Cmd+V)");
    expect(button(/^Pegar \(/)).toBeEnabled();
  });

  it("solo algunas acciones deshabilitadas (selección bloqueada): copiar sí, eliminar no", () => {
    renderBar({ availability: clipboardAvailability({ selected: 1, editable: 0, clipboardSize: 0, hasActiveLayer: true, suspended: false }) });
    expect(button(/^Copiar/)).toBeEnabled();
    expect(button(/^Eliminar/)).toBeDisabled();
    expect(button(/^Eliminar/)).toHaveAttribute("title", expect.stringContaining("capas bloqueadas"));
  });

  it("resumen del portapapeles en una región de estado: vacío, 1 objeto, N objetos", () => {
    const { rerender, onAction } = renderBar({ clipboardSize: 0 });
    expect(screen.getByRole("status")).toHaveTextContent("Portapapeles vacío.");
    rerender(<ClipboardBar availability={ENABLED} clipboardSize={1} notice={null} onAction={onAction} />);
    expect(screen.getByRole("status")).toHaveTextContent("Portapapeles: 1 objeto.");
    rerender(<ClipboardBar availability={ENABLED} clipboardSize={4} notice={null} onAction={onAction} />);
    expect(screen.getByRole("status")).toHaveTextContent("Portapapeles: 4 objetos.");
  });

  it("una confirmación reemplaza el resumen en el status (con lo que se omitió); NO es una alerta", () => {
    const notice: ClipboardNotice = { kind: "ok", text: "Se pegaron 2 objetos. 1 objeto no se pegó (capa «Verde» bloqueada)." };
    renderBar({ notice });
    expect(screen.getByRole("status")).toHaveTextContent("Se pegaron 2 objetos. 1 objeto no se pegó (capa «Verde» bloqueada).");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("un rechazo es una alerta visible y el status conserva el resumen", () => {
    renderBar({ notice: { kind: "error", text: "No se pegó nada: 1 objeto no se pegó (capa «Verde» bloqueada)." } });
    expect(screen.getByRole("alert")).toHaveTextContent("No se pegó nada");
    expect(screen.getByRole("status")).toHaveTextContent("Portapapeles: 3 objetos.");
  });

  it("sin aviso no hay alerta", () => {
    renderBar();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("'Atajos' lista todos los atajos documentados y aclara Ctrl/Cmd, el offset y que el portapapeles es interno", () => {
    renderBar();
    const details = screen.getByText("Atajos").closest("details")!;
    for (const { label, keys } of CLIPBOARD_SHORTCUTS) {
      const item = within(details)
        .getAllByRole("listitem")
        .find((candidate) => candidate.textContent === `${keys} ${label}`);
      expect(item, `${label} ${keys}`).toBeDefined();
    }
    expect(details).toHaveTextContent("Ctrl en Windows y Linux, Cmd en macOS");
    expect(details).toHaveTextContent("5 mm");
    expect(details).toHaveTextContent("portapapeles es interno");
  });
});
