import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

export type ProjectAction = "open" | "rename" | "duplicate" | "delete";

interface ProjectActionsMenuProps {
  projectName: string;
  /** Acciones deshabilitadas (p. ej. Duplicar mientras hay una duplicación en vuelo). */
  disabledActions?: ReadonlySet<ProjectAction>;
  onSelect: (action: ProjectAction) => void;
}

const ITEMS: { action: ProjectAction; label: string; danger?: boolean }[] = [
  { action: "open", label: "Abrir" },
  { action: "rename", label: "Renombrar" },
  { action: "duplicate", label: "Duplicar" },
  { action: "delete", label: "Eliminar", danger: true },
];

/**
 * Menú contextual de un proyecto (M2.2-S08), patrón WAI-ARIA "menu button": el disparador lleva
 * `aria-haspopup="menu"`/`aria-expanded`/`aria-controls`; al abrir el foco va al primer ítem;
 * flechas/Home/End navegan, Escape cierra devolviendo el foco al disparador, Tab y click fuera
 * cierran. Es un `<button>` real (nunca un `<div onClick>`).
 */
export function ProjectActionsMenu({ projectName, disabledActions, onSelect }: ProjectActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    if (!open) return;

    itemRefs.current.find((item) => item && !item.disabled)?.focus();

    const handlePointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

  const enabledItems = () => itemRefs.current.filter((item): item is HTMLButtonElement => !!item && !item.disabled);

  const closeAndRestoreFocus = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = enabledItems();
    const index = items.findIndex((item) => item === document.activeElement);

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        items[(index + 1) % items.length]?.focus();
        break;
      case "ArrowUp":
        event.preventDefault();
        items[(index - 1 + items.length) % items.length]?.focus();
        break;
      case "Home":
        event.preventDefault();
        items[0]?.focus();
        break;
      case "End":
        event.preventDefault();
        items[items.length - 1]?.focus();
        break;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        closeAndRestoreFocus();
        break;
      case "Tab":
        setOpen(false);
        break;
    }
  };

  return (
    <div className="project-menu" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="project-menu__trigger"
        aria-label={`Acciones de ${projectName}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span aria-hidden="true">⋯</span>
      </button>

      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={`Acciones de ${projectName}`}
          className="project-menu__list"
          onKeyDown={handleMenuKeyDown}
        >
          {ITEMS.map(({ action, label, danger }, index) => (
            <button
              key={action}
              ref={(element) => {
                itemRefs.current[index] = element;
              }}
              type="button"
              role="menuitem"
              className={`project-menu__item${danger ? " project-menu__item--danger" : ""}`}
              disabled={disabledActions?.has(action) ?? false}
              onClick={() => {
                // El foco vuelve al disparador ANTES de actuar: así un diálogo que se abra a
                // continuación captura el disparador como "elemento que lo abrió" y le devuelve el
                // foco al cerrarse (en vez de perderlo con el ítem del menú desmontado).
                closeAndRestoreFocus();
                onSelect(action);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
