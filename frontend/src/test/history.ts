import { fireEvent, screen } from "@testing-library/react";
import { expect } from "vitest";

/**
 * Ayudas de pruebas del panel de Historial (M3-S12) para verificar, desde el Workspace completo, QUÉ comando dejó una ruta real de UI: abren el panel (si
 * está cerrado) y leen el atributo `data-command-type` de cada entrada. Así las pruebas de S01-S11 aseguran el tipo del comando sin duplicar la UI.
 */

/** Abre el panel de Historial si está cerrado y lo devuelve. */
export function openHistory(): HTMLElement {
  const toggle = screen.getByRole("button", { name: /^Historial/ });
  if (toggle.getAttribute("aria-expanded") !== "true") fireEvent.click(toggle);
  return screen.getByRole("region", { name: "Historial de acciones" });
}

/** Entradas del historial (sin el «Estado inicial»), en orden cronológico. */
export function historyEntries(): HTMLButtonElement[] {
  const panel = openHistory();
  return Array.from(panel.querySelectorAll<HTMLButtonElement>("button[data-command-type]"));
}

/** Tipos de comando de TODAS las entradas (aplicadas y rehacibles), en orden. */
export function historyTypes(): string[] {
  return historyEntries().map((entry) => entry.dataset.commandType ?? "");
}

/** Tipo del comando en la posición actual del historial (la última acción aplicada), o `null` en el estado inicial. */
export function currentCommandType(): string | null {
  const panel = openHistory();
  return panel.querySelector<HTMLButtonElement>("button[data-command-type][aria-current='step']")?.dataset.commandType ?? null;
}

/** Afirma que la última acción aplicada es del tipo `type` (y deja el panel abierto). */
export function expectLastCommand(type: string): void {
  expect(currentCommandType()).toBe(type);
}
