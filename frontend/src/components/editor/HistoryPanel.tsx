import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { HistoryEntryView, HistoryNotice } from "../../hooks/useEditableDocument";
import type { EditorCommand } from "../../lib/editor/commands";

interface HistoryPanelProps {
  /** Comandos aplicados y rehacibles, en orden cronológico (los rehacibles van al final). */
  entries: HistoryEntryView[];
  /** Cuántos están aplicados: la posición actual del historial (0 = estado inicial). */
  position: number;
  limit: number;
  /** Hay un cambio de metadata de capa en vuelo: no se puede navegar hasta que termine. */
  busy: boolean;
  /** Último fallo de un cambio de metadata de capa (el estado local NO cambió). */
  error: string | null;
  notices: HistoryNotice[];
  /** `null` = ir al estado inicial (antes de la primera acción). */
  onJumpTo: (entryId: string | null) => void;
  onDismissError: () => void;
  onDismissNotice: (kind: HistoryNotice["kind"]) => void;
  onClose: () => void;
}

const ORIGIN_LABEL: Record<EditorCommand["origin"], string> = { user: "", ai: "IA", system: "sistema" };

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function timeOf(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("es-AR", { hour12: false });
}

/** «3 objetos · 1 capa», o vacío si el comando no tocó ni objetos ni capas. */
function affectedText(command: EditorCommand): string {
  const objects = typeof command.parameters.objectCount === "number" ? command.parameters.objectCount : command.targets.objectIds.length;
  const parts: string[] = [];
  if (objects > 0) parts.push(plural(objects, "objeto", "objetos"));
  if (command.targets.layerIds.length > 0) parts.push(plural(command.targets.layerIds.length, "capa", "capas"));
  return parts.join(" · ");
}

/**
 * Panel de Historial (M3-S12): la lista cronológica de las acciones de la sesión con su tipo, etiqueta, hora y objetos afectados. La posición actual está
 * marcada (`aria-current="step"`), las acciones «futuras» (las que se pueden rehacer) se muestran atenuadas y un clic o Enter sobre una entrada va a ese
 * punto (deshace o rehace varios pasos de una vez). Teclado completo: Tab entra a la lista, ↑/↓/Inicio/Fin mueven el foco entre entradas, Enter o Espacio
 * van a esa posición y Escape cierra el panel (devolviendo el foco al botón que lo abrió). Los cambios de posición se anuncian en una región `aria-live`.
 *
 * El historial es de SESIÓN y vive en memoria: un reload o cerrar la pestaña lo pierde (guardar versiones es otra tarjeta) y se reinicia, con aviso,
 * cuando el documento se regenera o se abre otro.
 */
export function HistoryPanel({ entries, position, limit, busy, error, notices, onJumpTo, onDismissError, onDismissNotice, onClose }: HistoryPanelProps) {
  const listRef = useRef<HTMLOListElement>(null);

  // Al abrir, el foco va a la entrada actual (o al estado inicial): se puede navegar sin tocar el mouse.
  useEffect(() => {
    listRef.current?.querySelector<HTMLButtonElement>('button[aria-current="step"]')?.focus();
  }, []);

  const moveFocus = (current: HTMLElement, target: "previous" | "next" | "first" | "last") => {
    const buttons = [...(listRef.current?.querySelectorAll<HTMLButtonElement>("button[data-history-entry]") ?? [])];
    const index = buttons.indexOf(current as HTMLButtonElement);
    const next = target === "first" ? 0 : target === "last" ? buttons.length - 1 : target === "next" ? Math.min(buttons.length - 1, index + 1) : Math.max(0, index - 1);
    buttons[next]?.focus();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    const target = event.target as HTMLElement;
    if (!target.hasAttribute("data-history-entry")) return;
    const keys: Record<string, "previous" | "next" | "first" | "last"> = { ArrowUp: "previous", ArrowDown: "next", Home: "first", End: "last" };
    const move = keys[event.key];
    if (!move) return;
    event.preventDefault();
    moveFocus(target, move);
  };

  const current = position === 0 ? null : entries[position - 1];
  const announcement = current ? `Posición ${position} de ${entries.length}: ${current.command.label}.` : `Estado inicial: ${plural(entries.length, "acción rehacible", "acciones rehacibles")}.`;

  return (
    <section id="editor-history-panel" className="history-panel" role="region" aria-label="Historial de acciones" onKeyDown={handleKeyDown}>
      <header className="history-panel__header">
        <h2 className="history-panel__title">Historial</h2>
        <button type="button" className="history-panel__close" onClick={onClose} aria-label="Cerrar el historial">
          ✕
        </button>
      </header>

      <p className="history-panel__scope">
        El historial dura mientras la sesión esté abierta: al recargar o cerrar la página se pierde (guarda las versiones del proyecto desde el botón SAVE). Guarda las últimas {limit} acciones.
      </p>

      {notices.map((notice) => (
        <p key={notice.kind} className={`history-panel__notice history-panel__notice--${notice.kind}`} role="status">
          {notice.message}{" "}
          <button type="button" className="history-panel__link" onClick={() => onDismissNotice(notice.kind)}>
            Entendido
          </button>
        </p>
      ))}
      {error && (
        <p className="history-panel__notice history-panel__notice--error" role="alert">
          {error}{" "}
          <button type="button" className="history-panel__link" onClick={onDismissError}>
            Cerrar
          </button>
        </p>
      )}
      {busy && (
        <p className="history-panel__notice" role="status">
          Guardando un cambio de capa en el servidor… no se puede navegar hasta que termine.
        </p>
      )}
      <p className="editor-sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      <ol ref={listRef} className="history-panel__list" aria-label="Acciones, de la más antigua a la más reciente">
        <li className="history-panel__item">
          <button
            type="button"
            data-history-entry="initial"
            className={`history-panel__entry${position === 0 ? " history-panel__entry--current" : ""}`}
            aria-current={position === 0 ? "step" : undefined}
            disabled={busy}
            onClick={() => onJumpTo(null)}
          >
            <span className="history-panel__label">Estado inicial</span>
            {position === 0 && <span className="history-panel__badge">actual</span>}
          </button>
        </li>
        {entries.map((entry, index) => {
          const { command } = entry;
          const isCurrent = index + 1 === position;
          const future = !entry.applied;
          const affected = affectedText(command);
          const origin = ORIGIN_LABEL[command.origin];
          return (
            <li key={command.id} className={`history-panel__item${future ? " history-panel__item--future" : ""}`}>
              <button
                type="button"
                data-history-entry={command.id}
                data-command-type={command.type}
                data-future={future ? "true" : undefined}
                className={`history-panel__entry${isCurrent ? " history-panel__entry--current" : ""}${future ? " history-panel__entry--future" : ""}`}
                aria-current={isCurrent ? "step" : undefined}
                disabled={busy}
                onClick={() => onJumpTo(command.id)}
              >
                <span className="history-panel__time">{timeOf(command.timestamp)}</span>
                <span className="history-panel__type">{command.type}</span>
                <span className="history-panel__label">{command.label}</span>
                {affected && <span className="history-panel__affected">{affected}</span>}
                {origin && <span className="history-panel__origin">{origin}</span>}
                {isCurrent && <span className="history-panel__badge">actual</span>}
                {future && <span className="history-panel__badge history-panel__badge--future">rehacer</span>}
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
