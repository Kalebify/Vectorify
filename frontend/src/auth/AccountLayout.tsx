import type { ReactNode } from "react";
import { ACCOUNT } from "./authCopy";
import { navigateToReturnUrl } from "./authLocation";
import { UserMenu } from "./UserMenu";
import "./auth.css";

interface AccountLayoutProps {
  /** Título de la página (el `h1`). */
  title: string;
  children?: ReactNode;
}

/**
 * Contenedor protegido para futuras páginas de cuenta (perfil llega en S07). Siempre se usa dentro de `AuthBoundary`: este componente
 * asume sesión resuelta. En S05 no hay ninguna entrada visible que lleve acá; solo se ejercita en tests.
 */
export function AccountLayout({ title, children }: AccountLayoutProps) {
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
            event.preventDefault();
            navigateToReturnUrl(null, { replace: false });
          }}
        >
          <span aria-hidden="true">← </span>
          {ACCOUNT.back}
        </a>
        <h1 tabIndex={-1}>{title}</h1>
        {children}
      </main>
    </div>
  );
}
