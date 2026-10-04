import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";

interface ProjectDialogProps {
  /** `alertdialog` para confirmaciones destructivas (Eliminar), `dialog` para el resto (Renombrar). */
  role?: "dialog" | "alertdialog";
  title: string;
  /** Descripción corta enlazada con `aria-describedby` (el cuerpo que nombra el proyecto, por ejemplo). */
  description?: ReactNode;
  /** Elemento que recibe el foco inicial; por defecto, el primer elemento enfocable del diálogo. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Escape y click en el fondo llaman acá. Se ignora mientras `busy` es true. */
  onClose: () => void;
  busy?: boolean;
  children: ReactNode;
}

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "a[href]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/**
 * Diálogo modal accesible mínimo (M2.2-S08), propio en vez de `window.confirm`/una librería:
 * `role=dialog|alertdialog` + `aria-modal`, foco inicial gestionado, Tab atrapado dentro del
 * diálogo, Escape cierra y el foco vuelve al elemento que lo abrió al desmontarse.
 */
export function ProjectDialog({
  role = "dialog",
  title,
  description,
  initialFocusRef,
  onClose,
  busy = false,
  children,
}: ProjectDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const target =
      initialFocusRef?.current ?? dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ?? dialogRef.current;
    target?.focus();

    return () => {
      // El elemento que abrió el diálogo puede haber desaparecido (p. ej. la card de un proyecto
      // recién eliminado): en ese caso el llamador es responsable de reubicar el foco.
      if (previouslyFocused?.isConnected) {
        previouslyFocused.focus();
      }
    };
    // Solo al montar: el foco inicial no debe volver a robarse en cada re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      if (!busy) onClose();
      return;
    }

    if (event.key !== "Tab") return;

    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? []);
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="projects-dialog__backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="projects-dialog"
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <h2 id={titleId} className="projects-dialog__title">
          {title}
        </h2>
        {description && (
          <div id={descriptionId} className="projects-dialog__description">
            {description}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
