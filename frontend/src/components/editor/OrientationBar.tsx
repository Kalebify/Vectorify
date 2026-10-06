import type { OrientationStep } from "../../lib/editor/orientation";

interface OrientationBarProps {
  /** Alcance de las acciones ANTES de pedir una: "Las acciones afectan a la selección (N objetos)" / "...a TODO el documento". */
  scopeText: string;
  /** Hay una transformación en previsualización esperando Apply/Cancel. */
  pending: boolean;
  /** Qué se va a modificar si se confirma ("Se rotará TODO el documento: Rotar 90° horario"), solo con `pending`. */
  pendingText: string | null;
  /** La orientación acumulada volvió a la identidad: no hay nada que aplicar. */
  pendingIsIdentity: boolean;
  /** Mensaje de rechazo (capas bloqueadas, etc.) -- visible, nunca silencioso. */
  message: string | null;
  onStep: (step: OrientationStep) => void;
  onApply: () => void;
  onCancel: () => void;
}

interface StepButton {
  step: OrientationStep;
  icon: string;
  label: string;
  shortcut: string;
}

const STEP_BUTTONS: StepButton[] = [
  { step: "rotate-ccw", icon: "⟲", label: "Rotar 90° antihorario", shortcut: "Shift+R" },
  { step: "rotate-cw", icon: "⟳", label: "Rotar 90° horario", shortcut: "R" },
  { step: "flip-horizontal", icon: "⇋", label: "Reflejar horizontalmente", shortcut: "F" },
  { step: "flip-vertical", icon: "⇅", label: "Reflejar verticalmente", shortcut: "Shift+F" },
];

/**
 * Barra contextual de Rotate 90° / Flip (M3-S02), visible con las herramientas Select y Move. Cada botón MUESTRA el
 * resultado como previsualización (el gesto de S01: nada entra en la pila de undo) y pide Apply/Cancel: el usuario siempre
 * sabe qué se va a modificar ANTES de confirmar, porque el texto dice el alcance (selección vs documento completo).
 * Repetir botones antes de Apply compone sobre el estado original, sin acumular error (ver `lib/editor/orientation.ts`).
 *
 * Atajos (con el foco en el canvas): R / Shift+R giran, F / Shift+F reflejan; Enter = Apply, Escape = Cancel.
 */
export function OrientationBar({ scopeText, pending, pendingText, pendingIsIdentity, message, onStep, onApply, onCancel }: OrientationBarProps) {
  return (
    <div className="orientation-bar" role="toolbar" aria-label="Rotar y reflejar">
      <div className="orientation-bar__buttons">
        {STEP_BUTTONS.map(({ step, icon, label, shortcut }) => (
          <button
            key={step}
            type="button"
            className="orientation-bar__button"
            aria-label={label}
            title={`${label} (${shortcut})`}
            onClick={() => onStep(step)}
          >
            <span aria-hidden="true">{icon}</span>
          </button>
        ))}
      </div>

      <p className="orientation-bar__scope" role="status">
        {pending ? (pendingIsIdentity ? "Sin cambios respecto del estado actual." : pendingText) : scopeText}
      </p>

      {pending && (
        <div className="orientation-bar__confirm">
          <button type="button" className="orientation-bar__apply" onClick={onApply} disabled={pendingIsIdentity} title="Aplicar la transformación (Enter)">
            Apply
          </button>
          <button type="button" className="orientation-bar__cancel" onClick={onCancel} title="Descartar la previsualización (Escape)">
            Cancel
          </button>
        </div>
      )}

      {message && (
        <p className="orientation-bar__message upload-panel__error" role="alert">
          {message}
        </p>
      )}
    </div>
  );
}
