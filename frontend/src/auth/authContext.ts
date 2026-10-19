import { createContext, useContext } from "react";
import type { CurrentUser, LoginRequest } from "../types/auth";

/**
 * Estado de la sesión en el cliente (M3.1-S05):
 *  - `unknown`: todavía no se sabe (primera consulta a `GET /api/v1/auth/me` en curso). Nunca se muestra contenido privado.
 *  - `authenticated`: hay usuario (en modo Development, el usuario de desarrollo; ver `isDevelopmentMode`).
 *  - `unauthenticated`: el servidor dijo 401. `returnUrl` = a dónde volver tras el login (null = Mis proyectos).
 *  - `error`: no se pudo comprobar (red o 5xx). NO equivale a «sesión cerrada».
 */
export type AuthState =
  | { status: "unknown" }
  | { status: "authenticated"; user: CurrentUser }
  | { status: "unauthenticated"; returnUrl: string | null }
  | { status: "error"; failure: SessionFailure };

export interface SessionFailure {
  kind: "network" | "server";
  /** Código HTTP si el servidor respondió (5xx u otro inesperado). */
  httpStatus?: number;
  /** Número del fallo (1, 2, ...): permite remontar el aviso para que se anuncie de nuevo aunque el texto sea idéntico. */
  attempt: number;
}

/** Motivo de llegada al login que viaja EN MEMORIA (nunca en la URL: un enlace no puede fabricar un «Tu sesión terminó»). */
export type AuthNotice = "expired" | "signed-out" | "signed-out-all" | "password-reset" | "email-confirmed" | "registered";

export interface AuthContextValue {
  state: AuthState;
  /** Usuario actual, o null si no hay sesión resuelta. */
  user: CurrentUser | null;
  /** true si el servidor está en `Auth:Mode=Development`: sin login, sin «Salir». */
  isDevelopmentMode: boolean;
  notice: AuthNotice | null;
  /**
   * Correo que pasa EN MEMORIA entre pantallas de auth (registro recibido, login, solicitud de recuperación, restablecimiento, confirmación) para precargar
   * el campo de correo (M3.1-S08; generaliza el `registeredEmail` de S05). Nunca va en la URL; la contraseña nunca se conserva.
   */
  prefillEmail: string | null;
  /** true mientras un reintento de `/me` está en curso. */
  isRetrying: boolean;
  /** Vuelve a consultar la sesión (desde el estado `error`). */
  retry: () => void;
  /** Inicia sesión. Propaga el `ApiClientError` para que el formulario muestre el mensaje; no guarda credenciales. */
  signIn: (request: LoginRequest, signal?: AbortSignal) => Promise<void>;
  /** «Salir». Falla (propaga) ante red/5xx: la sesión NO se da por cerrada. Un 401 sí (ya no había sesión). */
  signOut: () => Promise<void>;
  /** «Cerrar sesión en todos lados». Un 401 equivale a sesión expirada. */
  signOutAll: () => Promise<void>;
  /**
   * Actualiza el nombre para mostrar del usuario en memoria (M3.1-S07) con el valor que confirmó el servidor al guardar el perfil, para que el
   * menú lo refleje sin volver a pedir `GET /api/v1/auth/me`. No hace nada sin sesión resuelta.
   */
  updateDisplayName: (displayName: string) => void;
  /** Recuerda en memoria que el registro fue recibido (aviso + correo precargado en el login). */
  announceRegistered: (email: string) => void;
  /** Guarda en memoria el correo con el que se precargará la pantalla de auth a la que se navega (`null` lo olvida). */
  setPrefillEmail: (email: string | null) => void;
  /** Aviso de la próxima pantalla de login que llega EN MEMORIA tras restablecer la contraseña o confirmar el correo (+ correo precargado). */
  announceNotice: (notice: "password-reset" | "email-confirmed", email: string | null) => void;
  /**
   * Cierra la sesión LOCAL tras restablecer la contraseña (M3.1-S08): intenta `POST /logout` (errores ignorados) y pasa a «no autenticado» SIN el aviso
   * de sesión terminada. No hace nada si no hay una sesión real.
   */
  endSessionAfterPasswordReset: () => Promise<void>;
  /** Marca la sesión como terminada (aviso `expired`, vuelta a la ubicación actual): para un 401 en una ruta de auth, que la frontera automática no cubre. */
  expireSession: () => void;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuth debe usarse dentro de <AuthProvider>.");
  }
  return value;
}
