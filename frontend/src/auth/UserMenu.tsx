import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { USER_MENU } from "./authCopy";
import { useAuth } from "./authContext";
import { classifyFailure } from "./authErrors";
import { AuthAlert } from "./AuthUi";
import { LogoutAllDialog } from "./LogoutAllDialog";

function displayNameOf(user: { displayName: string; email: string | null }): string {
  return user.displayName.trim() || user.email?.trim() || USER_MENU.fallbackName;
}

/**
 * Menú de cuenta del header (M3.1-S05). Se construye en AppRoot y se pasa a las pantallas de producto como slot: ellas no importan nada
 * de auth. En modo Development (sin login) solo muestra la pastilla «Modo desarrollo» y el nombre, sin «Salir».
 */
export function UserMenu() {
  const { user, isDevelopmentMode } = useAuth();
  if (!user) return null;

  const name = displayNameOf(user);

  if (isDevelopmentMode) {
    return (
      <div className="user-menu user-menu--dev">
        {/* Clases de la pastilla, no el componente StatusPill: este lleva role="status" y se anunciaría al montar. */}
        <span className="status-pill status-pill--neutral">{USER_MENU.developmentPill}</span>
        <span className="user-menu__name">{name}</span>
      </div>
    );
  }

  return <AccountMenu name={name} />;
}

/** Menú WAI-ARIA «menu button», mismo patrón de teclado que `ProjectActionsMenu`. */
function AccountMenu({ name }: { name: string }) {
  const { signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [alertText, setAlertText] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const signingOutRef = useRef(false);

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

  const handleSignOut = async () => {
    if (signingOutRef.current) return;
    signingOutRef.current = true;
    setAlertText(null);
    setSigningOut(true);
    try {
      await signOut();
      // Éxito: el estado de sesión cambia y este menú se desmonta junto con la pantalla de producto.
    } catch (error) {
      // Red o 5xx: la sesión NO se da por cerrada.
      setAlertText(classifyFailure(error).kind === "network" ? USER_MENU.signOutNetwork : USER_MENU.signOutServer);
    } finally {
      signingOutRef.current = false;
      setSigningOut(false);
    }
  };

  const initial = (name.trim().charAt(0) || "?").toUpperCase();
  const busyProps = signingOut ? ({ "aria-busy": true, "aria-disabled": true } as const) : {};

  return (
    <div className="user-menu" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="user-menu__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        {...busyProps}
        onClick={() => {
          if (!signingOut) setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !open && !signingOut) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="user-menu__avatar" aria-hidden="true">
          {initial}
        </span>
        <span className="auth-visually-hidden">{USER_MENU.triggerPrefix}</span>{" "}
        <span className="user-menu__name">{name}</span>
        {signingOut ? (
          <span className="user-menu__spinner" aria-hidden="true" />
        ) : (
          <span className="user-menu__caret" aria-hidden="true">
            ▾
          </span>
        )}
      </button>
      <span role="status" className="auth-visually-hidden">
        {signingOut ? USER_MENU.signingOut : ""}
      </span>

      {open && (
        <div id={menuId} role="menu" aria-label={USER_MENU.listLabel} className="user-menu__list" onKeyDown={handleMenuKeyDown}>
          <button
            ref={(element) => {
              itemRefs.current[0] = element;
            }}
            type="button"
            role="menuitem"
            className="user-menu__item"
            onClick={() => {
              // El foco vuelve al disparador ANTES de actuar (mismo criterio que ProjectActionsMenu).
              closeAndRestoreFocus();
              void handleSignOut();
            }}
          >
            {USER_MENU.signOut}
          </button>
          <button
            ref={(element) => {
              itemRefs.current[1] = element;
            }}
            type="button"
            role="menuitem"
            className="user-menu__item"
            onClick={() => {
              closeAndRestoreFocus();
              setDialogOpen(true);
            }}
          >
            {USER_MENU.signOutAll}
          </button>
        </div>
      )}

      {alertText && (
        <AuthAlert
          className="user-menu__alert"
          dismissLabel={USER_MENU.dismiss}
          onDismiss={() => {
            setAlertText(null);
            triggerRef.current?.focus();
          }}
        >
          {alertText}
        </AuthAlert>
      )}

      {dialogOpen && <LogoutAllDialog onClose={() => setDialogOpen(false)} />}
    </div>
  );
}
