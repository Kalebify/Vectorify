import { useEffect, useRef, type ReactNode } from "react";
import { consumeArrivalFocus, navigateAuth } from "./authLocation";
import { useAuth } from "./authContext";
import { SessionErrorPanel, SessionPending } from "./SessionStates";

/**
 * Frontera de las rutas protegidas (M3.1-S05): decide qué se renderiza según el estado de sesión y NUNCA muestra los hijos antes de que
 * la sesión esté resuelta.
 *  - `unknown`  -> `SessionPending` (ni contenido privado ni login).
 *  - `authenticated` -> hijos.
 *  - `unauthenticated` -> redirección (reemplazando la entrada del historial) al login con `returnUrl` y mientras tanto `SessionPending`.
 *  - `error` -> `SessionErrorPanel` (reintento; un fallo de red no es «sesión cerrada»).
 */
export function AuthBoundary({ children }: { children: ReactNode }) {
  const { state } = useAuth();

  useEffect(() => {
    if (state.status === "unauthenticated") {
      navigateAuth("login", state.returnUrl, { replace: true });
    }
  }, [state]);

  switch (state.status) {
    case "authenticated":
      return <>{children}</>;
    case "error":
      return <SessionErrorPanel />;
    case "unknown":
    case "unauthenticated":
      return <SessionPending />;
  }
}

/** Alias semántico: ruta protegida = contenido detrás de `AuthBoundary`. */
export const ProtectedRoute = AuthBoundary;

const HEADING_SELECTOR = "main h1[tabindex='-1'], main h2[tabindex='-1']";
const ARRIVAL_POLL_MS = 100;
const ARRIVAL_MAX_ATTEMPTS = 30;

/**
 * Tras un login correcto (o un reintento correcto de la sesión) mueve el foco al primer encabezado enfocable del `<main>` de destino
 * (en Mis proyectos, el h2 «Mis proyectos»); si el destino aún está cargando espera un momento, y si no tiene encabezado enfocable usa
 * el propio `<main>`. Se renderiza dentro de `AuthBoundary`, junto a la app.
 */
export function ArrivalFocus() {
  const pending = useRef<boolean | null>(null);

  useEffect(() => {
    // Una sola consulta por montaje (StrictMode ejecuta el efecto dos veces con la misma instancia).
    if (pending.current === null) pending.current = consumeArrivalFocus();
    if (!pending.current) return;

    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      const heading = document.querySelector<HTMLElement>(HEADING_SELECTOR);
      const main = document.querySelector<HTMLElement>("main");
      const target = heading ?? (main && attempts >= 3 ? main : null);
      if (target) {
        if (target === main && !main.hasAttribute("tabindex")) main.setAttribute("tabindex", "-1");
        target.focus();
        window.clearInterval(timer);
      } else if (attempts >= ARRIVAL_MAX_ATTEMPTS) {
        window.clearInterval(timer);
      }
    }, ARRIVAL_POLL_MS);

    return () => window.clearInterval(timer);
  }, []);

  return null;
}
