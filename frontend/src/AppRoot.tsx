import { useEffect, useSyncExternalStore } from "react";
import App from "./App";
import { AuthProvider } from "./auth/AuthProvider";
import { ArrivalFocus, AuthBoundary } from "./auth/AuthBoundary";
import {
  getLocationSearch,
  isAccountView,
  navigateToReturnUrl,
  readAuthView,
  readReturnUrl,
  requestArrivalFocus,
  subscribeLocation,
  type AuthView,
} from "./auth/authLocation";
import { useAuth } from "./auth/authContext";
import { ConfirmEmailScreen } from "./auth/ConfirmEmailScreen";
import { ForgotPasswordScreen } from "./auth/ForgotPasswordScreen";
import { LoginScreen } from "./auth/LoginScreen";
import { ProfileScreen } from "./auth/ProfileScreen";
import { RegisterScreen } from "./auth/RegisterScreen";
import { ResetPasswordScreen } from "./auth/ResetPasswordScreen";
import { SessionErrorPanel, SessionPending } from "./auth/SessionStates";
import { UserMenu } from "./auth/UserMenu";

/**
 * Raíz de composición (M3.1-S05): une el módulo de autenticación con la app de producto SIN que `App` ni sus pantallas importen nada de
 * auth. Las rutas privadas (Mis proyectos, `?view=new`, Workspace) quedan detrás de `AuthBoundary`; `?view=login|register` son las únicas
 * vistas públicas. `?view=account` («Mi cuenta», M3.1-S07) también va detrás de `AuthBoundary` y se resuelve ANTES que las vistas de producto: `App`
 * no se entera de esa ruta. El menú de cuenta se inyecta en `App` como slot.
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

  if (isAccountView(search)) {
    return (
      <AuthBoundary>
        <ProfileScreen />
        <ArrivalFocus key="account" />
      </AuthBoundary>
    );
  }

  if (authView === null) {
    return (
      <AuthBoundary>
        <App userMenu={<UserMenu />} />
        <ArrivalFocus key="app" />
      </AuthBoundary>
    );
  }

  return <PublicRoutes view={authView} search={search} />;
}

/**
 * Vistas públicas de auth. Con sesión ya válida (o modo Development) no hay nada que hacer en login, registro ni solicitud de recuperación: se redirige al
 * destino. Las pantallas a las que llega el enlace de un CORREO (`reset-password`, `confirm-email`, M3.1-S08) se muestran también con sesión real (puede ser
 * otra persona, o la misma): no se redirige; y con error al consultar `/me` se muestran igual (su propio envío informará el error). En modo Development no hay
 * recuperación: redirigen.
 */
function PublicRoutes({ view, search }: { view: AuthView; search: string }) {
  const { state } = useAuth();
  const isEmailLanding = view === "reset-password" || view === "confirm-email";
  const redirects = state.status === "authenticated" && (!isEmailLanding || state.user.authMode === "Development");

  useEffect(() => {
    if (redirects) {
      // Login correcto (o usuario ya autenticado que abre /login): al returnUrl validado o a Mis proyectos, reemplazando la entrada.
      requestArrivalFocus();
      navigateToReturnUrl(readReturnUrl(search), { replace: true });
    }
  }, [redirects, search]);

  const screen = () => {
    switch (view) {
      case "login":
        return <LoginScreen search={search} />;
      case "register":
        return <RegisterScreen search={search} />;
      case "forgot-password":
        return <ForgotPasswordScreen search={search} />;
      case "reset-password":
        return <ResetPasswordScreen search={search} />;
      case "confirm-email":
        return <ConfirmEmailScreen />;
    }
  };

  switch (state.status) {
    case "unauthenticated":
      return screen();
    case "error":
      return isEmailLanding ? screen() : <SessionErrorPanel />;
    case "authenticated":
      return isEmailLanding && !redirects ? screen() : <SessionPending />;
    case "unknown":
      return <SessionPending />;
  }
}
