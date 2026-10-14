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

  describe("guardado de geometría (M3-S13)", () => {
    it("muestra el estado REAL del guardado de geometría: Guardando… (con el botón deshabilitado), error con su mensaje y Geometría guardada", () => {
      const { rerender } = render(
        <EditorHeader projectName="p.svg" onClose={vi.fn()} saveState="idle" saveErrorMessage={null} canSave onSave={vi.fn()} geometryDirty geometrySaveState="saving" />,
      );
      expect(screen.getByText("Guardando geometría…")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^Guardar$/ })).toBeDisabled();

      rerender(
        <EditorHeader projectName="p.svg" onClose={vi.fn()} saveState="idle" saveErrorMessage={null} canSave onSave={vi.fn()} geometryDirty geometrySaveState="error" geometrySaveErrorMessage="Sin conexión." />,
      );
      expect(screen.getByText("Sin conexión.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Reintentar guardar/ })).toBeEnabled();

      rerender(<EditorHeader projectName="p.svg" onClose={vi.fn()} saveState="idle" saveErrorMessage={null} canSave onSave={vi.fn()} geometryDirty={false} geometrySaveState="saved" />);
      expect(screen.getByText("Geometría guardada")).toBeInTheDocument();
    });

    it("nunca dice 'guardada' si quedaron ediciones posteriores al envío (geometryDirty sigue true)", () => {
      render(
        <EditorHeader projectName="p.svg" onClose={vi.fn()} saveState="idle" saveErrorMessage={null} canSave onSave={vi.fn()} geometryDirty geometrySaveState="saved" />,
      );
      expect(screen.queryByText("Geometría guardada")).not.toBeInTheDocument();
      expect(screen.getByText("Cambios de geometría sin guardar")).toBeInTheDocument();
    });

    it("con el guardado de geometría en 'idle' manda el indicador clásico", () => {
      renderHeader({ saveState: "saved", geometryDirty: false, geometrySaveState: "idle" });
      expect(screen.getByText("Guardado")).toBeInTheDocument();
    });

    it("el botón Versiones solo existe con onToggleVersionHistory, expone aria-expanded/aria-controls y lo dispara", () => {
      const { rerender } = render(<EditorHeader projectName="p.svg" onClose={vi.fn()} saveState="idle" saveErrorMessage={null} canSave onSave={vi.fn()} />);
      expect(screen.queryByRole("button", { name: /Versiones/ })).not.toBeInTheDocument();

      const onToggleVersionHistory = vi.fn();
      rerender(<EditorHeader projectName="p.svg" onClose={vi.fn()} saveState="idle" saveErrorMessage={null} canSave onSave={vi.fn()} onToggleVersionHistory={onToggleVersionHistory} versionHistoryOpen />);
      const button = screen.getByRole("button", { name: /Versiones/ });
      expect(button).toHaveAttribute("aria-expanded", "true");
      expect(button).toHaveAttribute("aria-controls", "editor-version-history-panel");
      fireEvent.click(button);
      expect(onToggleVersionHistory).toHaveBeenCalledTimes(1);
    });
  });

  describe("historial (M3-S12)", () => {
    it("sin onToggleHistory no hay botón de Historial", () => {
      renderHeader();
      expect(screen.queryByRole("button", { name: /^Historial/ })).not.toBeInTheDocument();
    });

    it("el botón Historial muestra cuántas acciones hay, expone aria-expanded/aria-controls y avisa (⚠) cuando hay algo sin leer", () => {
      const onToggleHistory = vi.fn();
      const { rerender } = render(
        <EditorHeader projectName="p.svg" onClose={vi.fn()} saveState="idle" saveErrorMessage={null} canSave onSave={vi.fn()} onToggleHistory={onToggleHistory} historyCount={3} historyOpen={false} />,
      );
      const button = screen.getByRole("button", { name: "Historial (3)" });
      expect(button).toHaveAttribute("aria-expanded", "false");
      expect(button).toHaveAttribute("aria-controls", "editor-history-panel");
      expect(button).toHaveAttribute("id", "editor-history-toggle");
      expect(button.className).not.toContain("attention");
      fireEvent.click(button);
      expect(onToggleHistory).toHaveBeenCalledTimes(1);

      rerender(
        <EditorHeader projectName="p.svg" onClose={vi.fn()} saveState="idle" saveErrorMessage={null} canSave onSave={vi.fn()} onToggleHistory={onToggleHistory} historyCount={3} historyOpen historyAttention />,
      );
      const open = screen.getByRole("button", { name: /^Historial/ });
      expect(open).toHaveAttribute("aria-expanded", "true");
      expect(open).toHaveTextContent("⚠");
      expect(open).toHaveAttribute("title", "Historial de acciones de esta sesión (hay un aviso)");
      expect(open.className).toContain("editor-header__button--attention");
    });

    it("Deshacer / Rehacer deshabilitados explican POR QUÉ (title y descripción accesible) sin cambiar su nombre accesible", () => {
      renderHeader({ undoDisabledReason: "no hay nada que deshacer", redoDisabledReason: "hay un cambio de capa guardándose" });
      const undo = screen.getByRole("button", { name: "Deshacer" });
      const redo = screen.getByRole("button", { name: "Rehacer" });
      expect(undo).toBeDisabled();
      expect(undo).toHaveAttribute("title", "Deshacer no disponible: no hay nada que deshacer");
      expect(undo).toHaveAccessibleDescription("Deshacer no disponible: no hay nada que deshacer");
      expect(redo).toHaveAttribute("title", "Rehacer no disponible: hay un cambio de capa guardándose");
      expect(redo).toHaveAccessibleDescription("Rehacer no disponible: hay un cambio de capa guardándose");
    });

    it("habilitados NO muestran el motivo aunque se lo pasen (solo la siguiente acción)", () => {
      renderHeader({ canUndo: true, canRedo: true, undoLabel: "Mover 2 objetos", redoLabel: "Rotar 1 objeto", undoDisabledReason: "x", redoDisabledReason: "y" });
      expect(screen.getByRole("button", { name: "Deshacer: Mover 2 objetos" })).toHaveAttribute("title", "Deshacer: Mover 2 objetos (Ctrl+Z)");
      expect(screen.getByRole("button", { name: "Rehacer: Rotar 1 objeto" })).toHaveAttribute("title", "Rehacer: Rotar 1 objeto (Ctrl+Shift+Z)");
      expect(screen.getByRole("button", { name: "Deshacer: Mover 2 objetos" })).not.toHaveAttribute("aria-describedby");
    });
  });

  describe("Laser Check (M3-S14)", () => {
    it("sin onToggleLaserCheck no hay botón", () => {
      renderHeader();
      expect(screen.queryByRole("button", { name: /^Laser Check/ })).not.toBeInTheDocument();
    });

    it("el botón expone aria-expanded/aria-controls y llama a onToggleLaserCheck", () => {
      const onToggleLaserCheck = vi.fn();
      const { rerender } = renderHeader({ onToggleLaserCheck, laserCheckOpen: false });

      const button = screen.getByRole("button", { name: "Laser Check" });
      expect(button).toHaveAttribute("id", "editor-laser-check-toggle");
      expect(button).toHaveAttribute("aria-expanded", "false");
      expect(button).toHaveAttribute("aria-controls", "editor-laser-check-panel");
      fireEvent.click(button);
      expect(onToggleLaserCheck).toHaveBeenCalledTimes(1);

      rerender(<EditorHeader projectName="mi-diseño.svg" onClose={vi.fn()} saveState="idle" saveErrorMessage={null} canSave={true} onSave={vi.fn()} onToggleLaserCheck={onToggleLaserCheck} laserCheckOpen />);
      expect(screen.getByRole("button", { name: "Laser Check" })).toHaveAttribute("aria-expanded", "true");
    });
  });
});
