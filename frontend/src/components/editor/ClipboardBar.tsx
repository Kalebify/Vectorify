import { CLIPBOARD_SHORTCUTS, type ClipboardAction } from "../../lib/editor/clipboard";

/** Resultado de la última acción de portapapeles: confirmación (con lo que se omitió) o rechazo. */
export interface ClipboardNotice {
  kind: "ok" | "error";
  text: string;
}

interface ClipboardBarProps {
  /** Por qué cada acción está deshabilitada (texto del tooltip), o `null` si se puede ejecutar (`clipboardAvailability`). */
  availability: Record<ClipboardAction, string | null>;
  /** Objetos en el portapapeles interno del editor. */
  clipboardSize: number;
  notice: ClipboardNotice | null;
  onAction: (action: ClipboardAction) => void;
}

/** Texto visible de cada botón (el nombre accesible completo, con el atajo, sale de `CLIPBOARD_SHORTCUTS`). */
const BUTTON_TEXT: Record<ClipboardAction, string> = {
  copy: "Copiar",
  cut: "Cortar",
  paste: "Pegar",
  "paste-in-place": "Pegar en el lugar",
  "paste-active": "Pegar en la capa activa",
  duplicate: "Duplicar",
  delete: "Eliminar",
};

/**
 * Barra contextual de Copiar / Cortar / Pegar / Duplicar / Eliminar (M3-S06), visible con las herramientas Select y Move. Cada botón
 * anuncia su atajo (`aria-label` + `aria-keyshortcuts`) y, deshabilitado, dice POR QUÉ en su tooltip (sin selección, portapapeles vacío,
 * solo objetos bloqueados...). Los rechazos son visibles (`role="alert"`) y las confirmaciones informan también lo que se omitió
 * (`role="status"`). La lista de atajos queda a un click ("Atajos").
 *
 * El portapapeles es interno a la sesión del editor: no usa el del sistema operativo.
 */
export function ClipboardBar({ availability, clipboardSize, notice, onAction }: ClipboardBarProps) {
  const summary = notice?.kind === "ok" ? notice.text : clipboardSize === 0 ? "Portapapeles vacío." : `Portapapeles: ${clipboardSize === 1 ? "1 objeto" : `${clipboardSize} objetos`}.`;

  return (
    <div className="clipboard-bar" role="toolbar" aria-label="Copiar, pegar y eliminar">
      <div className="clipboard-bar__buttons">
        {CLIPBOARD_SHORTCUTS.map(({ action, label, keys, ariaKeys }) => {
          const reason = availability[action];
          return (
            <button
              key={action}
              type="button"
              className={`clipboard-bar__button${action === "delete" ? " clipboard-bar__button--danger" : ""}`}
              disabled={reason !== null}
              aria-label={`${label} (${keys})`}
              aria-keyshortcuts={ariaKeys}
              title={reason ?? `${label} (${keys})`}
              onClick={() => onAction(action)}
            >
              {BUTTON_TEXT[action]}
            </button>
          );
        })}
      </div>

      <p className="clipboard-bar__status" role="status">
        {summary}
      </p>

      <details className="clipboard-bar__shortcuts">
        <summary>Atajos</summary>
        <ul>
          {CLIPBOARD_SHORTCUTS.map(({ action, label, keys }) => (
            <li key={action}>
              <kbd>{keys}</kbd> {label}
            </li>
          ))}
        </ul>
        <p>Ctrl en Windows y Linux, Cmd en macOS. El portapapeles es interno al editor y se vacía al cambiar de documento. Pegar desplaza 5 mm cada vez (5 unidades si el documento no tiene escala física); Duplicar repite ese desplazamiento.</p>
      </details>

      {notice?.kind === "error" && (
        <p className="clipboard-bar__message upload-panel__error" role="alert">
          {notice.text}
        </p>
      )}
    </div>
  );
}
