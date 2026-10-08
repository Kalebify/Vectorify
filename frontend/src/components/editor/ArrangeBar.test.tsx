import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ARRANGE_ACTIONS, type ArrangeActionId } from "../../lib/editor/arrange";
import { ArrangeBar } from "./ArrangeBar";
import { ClipboardBar } from "./ClipboardBar";

const ALL_ENABLED = Object.fromEntries(ARRANGE_ACTIONS.map((action) => [action.id, null])) as Record<ArrangeActionId, string | null>;
const ALL_DISABLED = Object.fromEntries(ARRANGE_ACTIONS.map((action) => [action.id, `motivo de ${action.id}`])) as Record<ArrangeActionId, string | null>;

function renderBar(props: Partial<React.ComponentProps<typeof ArrangeBar>> = {}) {
  const onAction = vi.fn<(id: ArrangeActionId) => void>();
  const onReferenceChange = vi.fn();
  const utils = render(<ArrangeBar availability={ALL_ENABLED} reference="selection" onReferenceChange={onReferenceChange} notice={null} onAction={onAction} {...props} />);
  return { ...utils, onAction, onReferenceChange };
}

/** Nombre accesible de cada botón: el de la acción, con su atajo si es de orden. */
const nameOf = (action: (typeof ARRANGE_ACTIONS)[number]) => (action.group === "order" ? `${action.label} (${action.keys})` : action.label);
const button = (name: RegExp | string) => screen.getByRole("button", { name });

describe("ArrangeBar", () => {
  it("es un toolbar con tres grupos con nombre (Alinear, Distribuir, Orden) y un botón por acción con su nombre accesible", () => {
    renderBar();
    const toolbar = screen.getByRole("toolbar", { name: "Organizar: alinear, distribuir y orden" });
    expect(within(toolbar).getAllByRole("button")).toHaveLength(12);
    for (const [group, count] of [
      ["Alinear", 6],
      ["Distribuir", 2],
      ["Orden (dentro de la capa)", 4],
    ] as const) {
      expect(within(screen.getByRole("group", { name: group })).getAllByRole("button"), group).toHaveLength(count);
    }
    for (const action of ARRANGE_ACTIONS) expect(button(nameOf(action)), action.id).toBeInTheDocument();
  });

  it("cada botón dispara SU acción, en el orden de ARRANGE_ACTIONS", () => {
    const { onAction } = renderBar();
    for (const action of ARRANGE_ACTIONS) fireEvent.click(button(nameOf(action)));
    expect(onAction.mock.calls.map(([id]) => id)).toEqual(ARRANGE_ACTIONS.map((action) => action.id));
  });

  it("deshabilitado: no dispara nada y el tooltip dice POR QUÉ (el motivo de cada acción)", () => {
    const { onAction } = renderBar({ availability: ALL_DISABLED });
    for (const action of ARRANGE_ACTIONS) {
      const control = button(nameOf(action));
      expect(control).toBeDisabled();
      expect(control).toHaveAttribute("title", `motivo de ${action.id}`);
      fireEvent.click(control);
    }
    expect(onAction).not.toHaveBeenCalled();
  });

  it("habilitado: el tooltip es el nombre (con el atajo en las de orden)", () => {
    renderBar();
    expect(button("Alinear a la izquierda")).toHaveAttribute("title", "Alinear a la izquierda");
    expect(button("Traer al frente (Ctrl/Cmd+Shift+])")).toHaveAttribute("title", "Traer al frente (Ctrl/Cmd+Shift+])");
  });

  it("solo algunas deshabilitadas: las demás siguen operativas", () => {
    const availability = { ...ALL_ENABLED, "distribute-horizontal": "Distribuir requiere 3 o más objetos movibles (hay 2).", "z-back": "Ya está al fondo de su capa." };
    renderBar({ availability });
    expect(button("Distribuir horizontalmente")).toBeDisabled();
    expect(button("Distribuir horizontalmente")).toHaveAttribute("title", "Distribuir requiere 3 o más objetos movibles (hay 2).");
    expect(button(/^Enviar al fondo/)).toBeDisabled();
    expect(button("Distribuir verticalmente")).toBeEnabled();
    expect(button("Alinear abajo")).toBeEnabled();
  });

  it("solo las acciones de orden anuncian atajo (aria-keyshortcuts)", () => {
    renderBar();
    expect(button(/^Traer adelante/)).toHaveAttribute("aria-keyshortcuts", "Control+] Meta+]");
    expect(button(/^Enviar atrás/)).toHaveAttribute("aria-keyshortcuts", "Control+[ Meta+[");
    expect(button(/^Traer al frente/)).toHaveAttribute("aria-keyshortcuts", "Control+Shift+] Meta+Shift+]");
    expect(button(/^Enviar al fondo/)).toHaveAttribute("aria-keyshortcuts", "Control+Shift+[ Meta+Shift+[");
    expect(button("Alinear a la izquierda")).not.toHaveAttribute("aria-keyshortcuts");
  });

  it("los iconos son decorativos (aria-hidden): el nombre accesible es el aria-label", () => {
    renderBar();
    const control = button("Alinear a la derecha");
    expect(control.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(control).toHaveAccessibleName("Alinear a la derecha");
  });

  describe("selector de referencia", () => {
    it("muestra 'Selección' o 'Documento' según el valor y está etiquetado", () => {
      const { rerender, onAction, onReferenceChange } = renderBar();
      expect(screen.getByLabelText("Respecto de")).toHaveValue("selection");
      rerender(<ArrangeBar availability={ALL_ENABLED} reference="document" onReferenceChange={onReferenceChange} notice={null} onAction={onAction} />);
      expect(screen.getByLabelText("Respecto de")).toHaveValue("document");
    });

    it("cambiarlo avisa con la referencia elegida y NO ejecuta ninguna acción", () => {
      const { onAction, onReferenceChange } = renderBar();
      fireEvent.change(screen.getByLabelText("Respecto de"), { target: { value: "document" } });
      expect(onReferenceChange).toHaveBeenCalledWith("document");
      fireEvent.change(screen.getByLabelText("Respecto de"), { target: { value: "selection" } });
      expect(onReferenceChange).toHaveBeenLastCalledWith("selection");
      expect(onAction).not.toHaveBeenCalled();
    });

    it("sigue habilitado aunque todas las acciones estén deshabilitadas (se puede elegir la referencia antes de seleccionar)", () => {
      renderBar({ availability: ALL_DISABLED });
      expect(screen.getByLabelText("Respecto de")).toBeEnabled();
    });
  });

  describe("avisos", () => {
    it("sin aviso: la región de estado está vacía y no hay alerta", () => {
      renderBar();
      expect(screen.getByRole("status")).toBeEmptyDOMElement();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("una confirmación (incluido 'Ya está alineado.') va al status; NO es una alerta", () => {
      renderBar({ notice: { kind: "ok", text: "Ya está alineado." } });
      expect(screen.getByRole("status")).toHaveTextContent("Ya está alineado.");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("un rechazo es una alerta visible y el status queda vacío", () => {
      renderBar({ notice: { kind: "error", text: "Distribuir requiere 3 o más objetos movibles (hay 2)." } });
      expect(screen.getByRole("alert")).toHaveTextContent("Distribuir requiere 3 o más objetos movibles (hay 2).");
      expect(screen.getByRole("status")).toBeEmptyDOMElement();
    });
  });
});

describe("ClipboardBar — atajos extra (z-order en el mismo panel 'Atajos')", () => {
  const availability = { copy: null, cut: null, paste: null, "paste-in-place": null, "paste-active": null, duplicate: null, delete: null };

  it("lista los atajos adicionales después de los de portapapeles, en el mismo panel", () => {
    render(
      <ClipboardBar
        availability={availability}
        clipboardSize={0}
        notice={null}
        onAction={vi.fn()}
        extraShortcuts={[
          { label: "Traer adelante", keys: "Ctrl/Cmd+]" },
          { label: "Enviar atrás", keys: "Ctrl/Cmd+[" },
        ]}
      />,
    );
    expect(screen.getAllByText("Atajos")).toHaveLength(1);
    const items = within(screen.getByText("Atajos").closest("details")!)
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(items.slice(-3)).toEqual(["Suprimir / Retroceso Eliminar", "Ctrl/Cmd+] Traer adelante", "Ctrl/Cmd+[ Enviar atrás"]);
  });

  it("sin atajos extra el panel queda como en M3-S06 (7 elementos)", () => {
    render(<ClipboardBar availability={availability} clipboardSize={0} notice={null} onAction={vi.fn()} />);
    expect(within(screen.getByText("Atajos").closest("details")!).getAllByRole("listitem")).toHaveLength(7);
  });
});
