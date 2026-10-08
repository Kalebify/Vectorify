import type { ReactNode } from "react";
import { BOOLEAN_OPS, BOOLEAN_OP_INFO, type BooleanOp } from "../../lib/editor/boolean";

/** Resultado del último intento de iniciar una booleana desde la barra (rechazo con el motivo) o confirmación de la última aplicada. */
export interface BooleanNotice {
  kind: "ok" | "error";
  text: string;
}

interface BooleanBarProps {
  /** Por qué NO se puede iniciar una booleana con la selección actual (texto del tooltip de los 4 botones), o `null` si se puede. */
  unavailableReason: string | null;
  /** Operación de la sesión abierta (el botón queda presionado) o `null`. */
  activeOp: BooleanOp | null;
  notice: BooleanNotice | null;
  onStart: (op: BooleanOp) => void;
}

/** Iconos 16×16 (dos formas A y B solapadas; la zona rellena es el resultado). Decorativos: el nombre accesible es el `aria-label` del botón. */
const ICONS: Record<BooleanOp, ReactNode> = {
  union: (
    <>
      <rect x="1.5" y="1.5" width="9" height="9" />
      <rect x="5.5" y="5.5" width="9" height="9" />
    </>
  ),
  difference: (
    <>
      <path d="M1.5 1.5 H10.5 V5.5 H5.5 V10.5 H1.5 Z" />
      <rect x="5.5" y="5.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </>
  ),
  intersection: (
    <>
      <rect x="1.5" y="1.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <rect x="5.5" y="5.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <rect x="5.5" y="5.5" width="5" height="5" />
    </>
  ),
  xor: (
    <>
      <path d="M1.5 1.5 H10.5 V5.5 H5.5 V10.5 H1.5 Z" />
      <path d="M14.5 14.5 H5.5 V10.5 H10.5 V5.5 H14.5 Z" />
    </>
  ),
};

/**
 * Barra contextual «Booleanas» (M3-S08), visible con las herramientas Select y Move junto a Organizar: Unión, Diferencia, Intersección y XOR sobre las
 * formas rellenas seleccionadas. Deshabilitada (el tooltip dice POR QUÉ: menos de 2 objetos, líneas abiertas, capas bloqueadas u ocultas) o
 * habilitada; al elegir una operación se abre el panel con operandos, capa destino, preview y Apply/Cancel -- nunca se aplica directo.
 */
export function BooleanBar({ unavailableReason, activeOp, notice, onStart }: BooleanBarProps) {
  return (
    <div className="boolean-bar" role="toolbar" aria-label="Booleanas: unión, diferencia, intersección y XOR">
      <span className="boolean-bar__title" aria-hidden="true">
        Booleanas
      </span>
      <div className="boolean-bar__buttons" role="group" aria-label="Operaciones booleanas">
        {BOOLEAN_OPS.map((op) => {
          const info = BOOLEAN_OP_INFO[op];
          const active = activeOp === op;
          return (
            <button
              key={op}
              type="button"
              className={`boolean-bar__button${active ? " boolean-bar__button--active" : ""}`}
              disabled={unavailableReason !== null && activeOp === null}
              aria-label={info.label}
              aria-pressed={activeOp !== null ? active : undefined}
              title={unavailableReason !== null && activeOp === null ? unavailableReason : `${info.label}: ${info.formula}`}
              onClick={() => onStart(op)}
            >
              <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true" focusable="false">
                {ICONS[op]}
              </svg>
              <span className="boolean-bar__label">{info.label}</span>
            </button>
          );
        })}
      </div>

      {unavailableReason !== null && activeOp === null && <p className="boolean-bar__hint">{unavailableReason}</p>}

      <p className="boolean-bar__status" role="status">
        {notice?.kind === "ok" ? notice.text : ""}
      </p>
      {notice?.kind === "error" && (
        <p className="boolean-bar__message upload-panel__error" role="alert">
          {notice.text}
        </p>
      )}
    </div>
  );
}
