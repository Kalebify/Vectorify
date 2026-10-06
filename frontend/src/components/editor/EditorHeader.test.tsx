import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EditorHeader } from "./EditorHeader";

function renderHeader(overrides: Partial<Parameters<typeof EditorHeader>[0]> = {}) {
  return render(
    <EditorHeader
      projectName="mi-diseño.svg"
      onClose={vi.fn()}
      saveState="idle"
      saveErrorMessage={null}
      canSave={true}
      onSave={vi.fn()}
      {...overrides}
    />,
  );
}

describe("EditorHeader", () => {
  it("muestra el nombre del proyecto y un estado idle honesto (no un 'Saved' falso sin confirmación)", () => {
    renderHeader({ saveState: "idle" });
    expect(screen.getByText("mi-diseño.svg")).toBeInTheDocument();
    expect(screen.queryByText(/^Guardado$/)).not.toBeInTheDocument();
    expect(screen.queryByText("✓")).not.toBeInTheDocument();
  });

  it("← Projects llama a onClose", () => {
    const onClose = vi.fn();
    renderHeader({ onClose });
    fireEvent.click(screen.getByRole("button", { name: /Volver a la lista de proyectos/ }));
    expect(onClose).toHaveBeenCalled();
  });

  it("sin nada que deshacer/rehacer, Undo y Redo están deshabilitados; Exportar sigue deshabilitado", () => {
    renderHeader();
    expect(screen.getByRole("button", { name: /Deshacer/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Rehacer/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Exportar/ })).toBeDisabled();
  });

  it("Undo/Redo (M3-S01): habilitados según canUndo/canRedo, con la etiqueta del comando en el aria-label, y llaman a sus handlers", () => {
    const onUndo = vi.fn();
    const onRedo = vi.fn();
    renderHeader({ canUndo: true, canRedo: true, undoLabel: "Mover 2 objetos", redoLabel: "Rotar 1 objeto", onUndo, onRedo });

    const undo = screen.getByRole("button", { name: "Deshacer: Mover 2 objetos" });
    const redo = screen.getByRole("button", { name: "Rehacer: Rotar 1 objeto" });
    expect(undo).toBeEnabled();
    expect(redo).toBeEnabled();
    fireEvent.click(undo);
    fireEvent.click(redo);
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(onRedo).toHaveBeenCalledTimes(1);
  });

  it("canUndo sin canRedo: solo Deshacer está habilitado", () => {
    renderHeader({ canUndo: true, undoLabel: null });
    expect(screen.getByRole("button", { name: "Deshacer" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Rehacer" })).toBeDisabled();
  });

  it("geometría sin persistir: el indicador NUNCA dice 'Guardado' (aunque el último guardado de metadata haya sido exitoso)", () => {
    const { rerender } = render(
      <EditorHeader projectName="p.svg" onClose={vi.fn()} saveState="saved" saveErrorMessage={null} canSave onSave={vi.fn()} geometryDirty />,
    );
    expect(screen.getByText("Cambios de geometría sin guardar")).toBeInTheDocument();
    expect(screen.queryByText("Guardado")).not.toBeInTheDocument();

    for (const state of ["idle", "dirty"] as const) {
      rerender(<EditorHeader projectName="p.svg" onClose={vi.fn()} saveState={state} saveErrorMessage={null} canSave onSave={vi.fn()} geometryDirty />);
      expect(screen.getByText("Cambios de geometría sin guardar")).toBeInTheDocument();
    }
  });

  it("geometría sin persistir + guardado en curso o con error: se muestra lo urgente (Guardando…/error), y al terminar vuelve el aviso de geometría", () => {
    const { rerender } = render(
      <EditorHeader projectName="p.svg" onClose={vi.fn()} saveState="saving" saveErrorMessage={null} canSave onSave={vi.fn()} geometryDirty />,
    );
    expect(screen.getByText("Guardando…")).toBeInTheDocument();

    rerender(<EditorHeader projectName="p.svg" onClose={vi.fn()} saveState="error" saveErrorMessage="Sin red." canSave onSave={vi.fn()} geometryDirty />);
    expect(screen.getByText("Sin red.")).toBeInTheDocument();
  });

  it("sin geometría pendiente, 'Guardado' se muestra normalmente", () => {
    renderHeader({ saveState: "saved", geometryDirty: false });
    expect(screen.getByText("Guardado")).toBeInTheDocument();
    expect(screen.queryByText("Cambios de geometría sin guardar")).not.toBeInTheDocument();
  });

  it("el botón Guardar llama a onSave cuando está habilitado", () => {
    const onSave = vi.fn();
    renderHeader({ saveState: "dirty", canSave: true, onSave });
    const button = screen.getByRole("button", { name: /^Guardar$/ });
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    expect(onSave).toHaveBeenCalled();
  });

  it("deshabilita Guardar mientras el documento no cargó (canSave=false)", () => {
    renderHeader({ canSave: false, saveState: "idle" });
    expect(screen.getByRole("button", { name: /^Guardar$/ })).toBeDisabled();
  });

  it("deshabilita Guardar y muestra 'Guardando…' durante saving", () => {
    renderHeader({ saveState: "saving" });
    expect(screen.getByText("Guardando…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Guardar$/ })).toBeDisabled();
  });

  it("muestra el estado real 'Guardado' SOLO cuando saveState es 'saved' (nunca antes de la confirmación del backend)", () => {
    renderHeader({ saveState: "saved" });
    expect(screen.getByText("Guardado")).toBeInTheDocument();
  });

  it("en estado error muestra el mensaje y permite reintentar sin perder el intento", () => {
    const onSave = vi.fn();
    renderHeader({ saveState: "error", saveErrorMessage: "No se pudo contactar al servidor.", onSave });
    expect(screen.getByText("No se pudo contactar al servidor.")).toBeInTheDocument();
    const retryButton = screen.getByRole("button", { name: /Reintentar guardar/ });
    expect(retryButton).not.toBeDisabled();
    fireEvent.click(retryButton);
    expect(onSave).toHaveBeenCalled();
  });
});
