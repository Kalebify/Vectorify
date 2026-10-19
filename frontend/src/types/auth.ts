/**
 * Contratos tipados de la autenticación (M3.1-S02/S03): POST /api/v1/auth/{register,login,logout} y
 * GET /api/v1/auth/me. Deben reflejar exactamente Vectorify.Api.Contracts.{RegisterRequest, LoginRequest,
 * RegisterResponse, CurrentUserResponse}. La sesión es una cookie HttpOnly: el frontend nunca ve ni guarda un token.
 */

export interface RegisterRequest {
  email: string;
  password: string;
}

/** Respuesta UNIFORME del registro (202): idéntica exista o no el correo, no confirma que la cuenta sea nueva. */
export interface RegisterResponse {
  status: "accepted";
}

export interface LoginRequest {
  email: string;
  password: string;
  /**
   * «Recordarme» (M3.1-S04, opcional; ausente = false). true: el servidor emite una cookie persistente con tope absoluto
   * (30 días por defecto). false/ausente: cookie de sesión del navegador, con caducidad deslizante por inactividad (8 h).
   */
  rememberMe?: boolean;
}

/**
 * Valor de `Auth:Mode` del servidor (M3.1-S05). `Development`: usuario de desarrollo fijo, sin login (la UI oculta formularios y «Salir»);
 * `Authenticated`: sesión real por cookie.
 */
export type AuthMode = "Authenticated" | "Development";

/** Usuario actual: `id` es el Users.Id INTERNO que resolvió el servidor desde la cookie verificada. */
export interface CurrentUser {
  id: string;
  email: string | null;
  displayName: string;
  /** Modo de autenticación del servidor (M3.1-S05). Un servidor anterior que no lo envíe se interpreta como `Authenticated`. */
  authMode: AuthMode;
}

// --- Recuperación de acceso y verificación de correo (M3.1-S08) ---

/** Cuerpo de `POST /api/v1/auth/forgot-password` y de `POST /api/v1/auth/resend-confirmation`: respuesta 202 UNIFORME (exista o no la cuenta). */
export interface EmailRequest {
  email: string;
}

/** Cuerpo de `POST /api/v1/auth/reset-password`: el token NATIVO de Identity que llegó por correo (en el fragmento del enlace). Nunca se guarda. */
export interface ResetPasswordRequest {
  email: string;
  token: string;
  newPassword: string;
}

/** Cuerpo de `POST /api/v1/auth/confirm-email`: el enlace trae `userId` o `email`; se reenvía tal cual. */
export interface ConfirmEmailRequest {
  userId?: string;
  email?: string;
  token: string;
}

/** Cuerpo de `POST /api/v1/auth/change-password` (sesión obligatoria). Nunca se guarda. */
export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

/** `code` del 400 de change-password con la contraseña actual incorrecta (nunca un 401, para no sacar al usuario de su sesión). */
export const INVALID_CURRENT_PASSWORD_CODE = "invalid_current_password";
/** `code` del 400 de contraseña corta/larga (registro, restablecer y cambiar). */
export const WEAK_PASSWORD_CODE = "weak_password";
/** `code` del 400 de correo mal formado (forgot-password y resend-confirmation). */
export const INVALID_EMAIL_CODE = "invalid_email";
