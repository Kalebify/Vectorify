import type { ReactNode } from "react";
import { ACCOUNT } from "./authCopy";
import { isPlainLeftClick, navigateToReturnUrl, requestArrivalFocus } from "./authLocation";
import { UserMenu } from "./UserMenu";
import "./auth.css";

interface AccountLayoutProps {
  /** Título de la página (el `h1`). */
  title: string;
  /** Texto de apoyo bajo el `h1` (M3.1-S07). */
  intro?: string;
  children?: ReactNode;
}

/**
 * Contenedor protegido de las páginas de cuenta («Mi cuenta», M3.1-S07). Siempre se usa dentro de `AuthBoundary`: este componente asume
 * sesión resuelta. El enlace de vuelta es un `<a href>` real: solo el clic izquierdo sin modificadores navega sin recargar (y pide foco de
 * llegada para que Mis proyectos reciba el foco en su encabezado); el clic central o Ctrl/Cmd+clic abren otra pestaña.
 */
export function AccountLayout({ title, intro, children }: AccountLayoutProps) {
  return (
    <div className="auth-account">
      <header className="auth-account__header">
        <p className="auth-account__brand">VECTORiZE</p>
        <UserMenu />
      </header>

      <main className="auth-account__main">
        <a
          className="auth-link"
          href={window.location.pathname}
          onClick={(event) => {
            if (!isPlainLeftClick(event)) return;
            event.preventDefault();
            requestArrivalFocus();
            navigateToReturnUrl(null, { replace: false });
          }}
        >
          <span aria-hidden="true">← </span>
          {ACCOUNT.back}
        </a>
        <div className="auth-account__head">
          <h1 tabIndex={-1}>{title}</h1>
          {intro && <p className="auth-card__intro">{intro}</p>}
        </div>
        {children}
      </main>
    </div>
  );
}
