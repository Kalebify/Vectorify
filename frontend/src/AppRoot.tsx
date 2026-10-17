import { useEffect, useSyncExternalStore } from "react";
import App from "./App";
import { AuthProvider } from "./auth/AuthProvider";
import { ArrivalFocus, AuthBoundary } from "./auth/AuthBoundary";
import {
  getLocationSearch,
  navigateToReturnUrl,
  readAuthView,
  readReturnUrl,
  requestArrivalFocus,
  subscribeLocation,
  type AuthView,
} from "./auth/authLocation";
import { useAuth } from "./auth/authContext";
import { LoginScreen } from "./auth/LoginScreen";
import { RegisterScreen } from "./auth/RegisterScreen";
import { SessionErrorPanel, SessionPending } from "./auth/SessionStates";
import { UserMenu } from "./auth/UserMenu";

/**
 * Raíz de composición (M3.1-S05): une el módulo de autenticación con la app de producto SIN que `App` ni sus pantallas importen nada de
 * auth. Las rutas privadas (Mis proyectos, `?view=new`, Workspace) quedan detrás de `AuthBoundary`; `?view=login|register` son las únicas
 * vistas públicas. El menú de cuenta se inyecta en `App` como slot.
 */
export function AppRoot() {
  return (
    <AuthProvider>
      <Routes />
    </AuthProvider>
  );
}

function Routes() {
  const search = useSyncExternalStore(subscribeLocation, getLocationSearch);
  const authView = readAuthView(search);

  if (authView === null) {
    return (
      <AuthBoundary>
        <App userMenu={<UserMenu />} />
        <ArrivalFocus />
      </AuthBoundary>
    );
  }

  return <PublicRoutes view={authView} search={search} />;
}

/** Vistas públicas de auth. Con sesión ya válida (o modo Development) no hay nada que hacer acá: se redirige al destino. */
function PublicRoutes({ view, search }: { view: AuthView; search: string }) {
  const { state } = useAuth();

  useEffect(() => {
    if (state.status === "authenticated") {
      // Login correcto (o usuario ya autenticado que abre /login): al returnUrl validado o a Mis proyectos, reemplazando la entrada.
      requestArrivalFocus();
      navigateToReturnUrl(readReturnUrl(search), { replace: true });
    }
  }, [state.status, search]);

  switch (state.status) {
    case "unauthenticated":
      return view === "login" ? <LoginScreen search={search} /> : <RegisterScreen search={search} />;
    case "error":
      return <SessionErrorPanel />;
    case "unknown":
    case "authenticated":
      return <SessionPending />;
  }
}
