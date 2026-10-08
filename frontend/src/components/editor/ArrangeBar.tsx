import { useId, type ReactNode } from "react";
import { ARRANGE_ACTIONS, type AlignReference, type ArrangeActionId, type ArrangeDescriptor } from "../../lib/editor/arrange";

/** Resultado de la última acción de "Organizar": confirmación (incluye "Ya está alineado" y lo omitido por bloqueo) o rechazo. */
export interface ArrangeNotice {
  kind: "ok" | "error";
  text: string;
}

interface ArrangeBarProps {
  /** Por qué cada acción está deshabilitada (texto del tooltip), o `null` si se puede ejecutar (`arrangeAvailability`). */
  availability: Record<ArrangeActionId, string | null>;
  reference: AlignReference;
  onReferenceChange: (reference: AlignReference) => void;
  notice: ArrangeNotice | null;
  onAction: (id: ArrangeActionId) => void;
}

/** Iconos 16×16 (barras = objetos, línea = referencia). Decorativos: el nombre accesible es el `aria-label` del botón. */
const ICONS: Record<ArrangeActionId, ReactNode> = {
  "align-left": (
    <>
      <rect x="1" y="1" width="1.5" height="14" />
      <rect x="4" y="3" width="10" height="3.5" />
      <rect x="4" y="9.5" width="6" height="3.5" />
    </>
  ),
  "align-center": (
    <>
      <rect x="7.25" y="1" width="1.5" height="14" />
      <rect x="2" y="3" width="12" height="3.5" />
      <rect x="4" y="9.5" width="8" height="3.5" />
    </>
  ),
  "align-right": (
    <>
      <rect x="13.5" y="1" width="1.5" height="14" />
      <rect x="2" y="3" width="10" height="3.5" />
      <rect x="6" y="9.5" width="6" height="3.5" />
    </>
  ),
  "align-top": (
    <>
      <rect x="1" y="1" width="14" height="1.5" />
      <rect x="3" y="4" width="3.5" height="10" />
      <rect x="9.5" y="4" width="3.5" height="6" />
    </>
  ),
  "align-middle": (
    <>
      <rect x="1" y="7.25" width="14" height="1.5" />
      <rect x="3" y="2" width="3.5" height="12" />
      <rect x="9.5" y="4" width="3.5" height="8" />
    </>
  ),
  "align-bottom": (
    <>
      <rect x="1" y="13.5" width="14" height="1.5" />
      <rect x="3" y="2" width="3.5" height="10" />
      <rect x="9.5" y="6" width="3.5" height="6" />
    </>
  ),
  "distribute-horizontal": (
    <>
      <rect x="1" y="1" width="1.5" height="14" />
      <rect x="13.5" y="1" width="1.5" height="14" />
      <rect x="5.25" y="4" width="5.5" height="8" />
    </>
  ),
  "distribute-vertical": (
    <>
      <rect x="1" y="1" width="14" height="1.5" />
      <rect x="1" y="13.5" width="14" height="1.5" />
      <rect x="4" y="5.25" width="8" height="5.5" />
    </>
  ),
  "z-forward": (
    <>
      <rect x="1.5" y="6.5" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <rect x="6" y="4" width="8" height="8" />
      <path d="M10 0.5 L12.5 3 H7.5 Z" />
    </>
  ),
  "z-backward": (
    <>
      <rect x="6" y="4" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <rect x="1.5" y="1.5" width="8" height="8" />
      <path d="M12 15.5 L14.5 13 H9.5 Z" />
    </>
  ),
  "z-front": (
    <>
      <rect x="1.5" y="1.5" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <rect x="6" y="6" width="8.5" height="8.5" />
    </>
  ),
  "z-back": (
    <>
      <rect x="6" y="6" width="8.5" height="8.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <rect x="1.5" y="1.5" width="8" height="8" />
    </>
  ),
};

const GROUP_TITLES: Record<ArrangeDescriptor["group"], string> = {
  align: "Alinear",
  distribute: "Distribuir",
  order: "Orden (dentro de la capa)",
};

/**
 * Barra contextual "Organizar" (M3-S07), visible con las herramientas Select y Move: Alinear (6 modos, con selector de referencia
 * Selección / Documento), Distribuir (horizontal / vertical, 3 o más objetos) y Orden (adelante, atrás, al frente, al fondo, SIEMPRE dentro
 * de la capa de cada objeto). Cada botón es un icono con `aria-label`; deshabilitado, su tooltip dice POR QUÉ (sin selección, menos de 3
 * objetos, todo bloqueado, ya en el límite...). Los rechazos son visibles (`role="alert"`) y las confirmaciones (también "Ya está
 * alineado") van a la región de estado (`role="status"`). Los atajos de z-order se listan en el panel "Atajos" de `ClipboardBar`.
 */
export function ArrangeBar({ availability, reference, onReferenceChange, notice, onAction }: ArrangeBarProps) {
  const groups: ArrangeDescriptor["group"][] = ["align", "distribute", "order"];
  const referenceId = useId();

  return (
    <div className="arrange-bar" role="toolbar" aria-label="Organizar: alinear, distribuir y orden">
      {groups.map((group) => (
        <div key={group} className="arrange-bar__group" role="group" aria-label={GROUP_TITLES[group]}>
          <span className="arrange-bar__title" aria-hidden="true">
            {GROUP_TITLES[group]}
          </span>
          {group === "align" && (
            <div className="arrange-bar__reference">
              <label htmlFor={referenceId}>Respecto de</label>
              <select id={referenceId} value={reference} onChange={(event) => onReferenceChange(event.target.value === "document" ? "document" : "selection")}>
                <option value="selection">Selección</option>
                <option value="document">Documento</option>
              </select>
            </div>
          )}
          <div className="arrange-bar__buttons">
            {ARRANGE_ACTIONS.filter((descriptor) => descriptor.group === group).map((descriptor) => {
              const reason = availability[descriptor.id];
              const name = descriptor.group === "order" ? `${descriptor.label} (${descriptor.keys})` : descriptor.label;
              return (
                <button
                  key={descriptor.id}
                  type="button"
                  className="arrange-bar__button"
                  disabled={reason !== null}
                  aria-label={name}
                  aria-keyshortcuts={descriptor.group === "order" ? descriptor.ariaKeys : undefined}
                  title={reason ?? name}
                  onClick={() => onAction(descriptor.id)}
                >
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true" focusable="false">
                    {ICONS[descriptor.id]}
                  </svg>
                </button>
              );
            })}
          </div>
        </div>
      ))}

      <p className="arrange-bar__status" role="status">
        {notice?.kind === "ok" ? notice.text : ""}
      </p>

      {notice?.kind === "error" && (
        <p className="arrange-bar__message upload-panel__error" role="alert">
          {notice.text}
        </p>
      )}
    </div>
  );
}
