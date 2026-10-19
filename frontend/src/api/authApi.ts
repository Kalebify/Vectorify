import { ApiClientError, httpClient } from "./httpClient";
import { rearmSessionBoundary } from "./sessionBoundary";
import type {
  ChangePasswordRequest,
  ConfirmEmailRequest,
  CurrentUser,
  EmailRequest,
  LoginRequest,
  RegisterRequest,
  RegisterResponse,
  ResetPasswordRequest,
} from "../types/auth";

/**
 * Cliente mínimo de autenticación (M3.1-S03). Sin pantallas, sin contexto React y sin rutas protegidas (eso es M3.1-S05).
 * La sesión es la cookie HttpOnly que emite el servidor: `httpClient` ya envía `credentials: "include"` y la cabecera
 * anti-CSRF, y este módulo nunca guarda ni lee credenciales ni tokens en el navegador.
 */

export const AUTH_REGISTER_PATH = "/api/v1/auth/register";
export const AUTH_LOGIN_PATH = "/api/v1/auth/login";
export const AUTH_LOGOUT_PATH = "/api/v1/auth/logout";
export const AUTH_LOGOUT_ALL_PATH = "/api/v1/auth/logout-all";
export const AUTH_ME_PATH = "/api/v1/auth/me";
export const AUTH_FORGOT_PASSWORD_PATH = "/api/v1/auth/forgot-password";
export const AUTH_RESET_PASSWORD_PATH = "/api/v1/auth/reset-password";
export const AUTH_CONFIRM_EMAIL_PATH = "/api/v1/auth/confirm-email";
export const AUTH_RESEND_CONFIRMATION_PATH = "/api/v1/auth/resend-confirmation";
export const AUTH_CHANGE_PASSWORD_PATH = "/api/v1/auth/change-password";

/** true si el error es un 401 de la Web API (sin sesión, sesión caducada/invalidada o credenciales inválidas). */
export function isUnauthorizedError(error: unknown): boolean {
  return error instanceof ApiClientError && error.status === 401;
}

/** Registra una cuenta. Respuesta uniforme (202): no revela si el correo ya existía. */
export function register(request: RegisterRequest, signal?: AbortSignal): Promise<RegisterResponse> {
  return httpClient.postJson<RegisterResponse>(AUTH_REGISTER_PATH, request, { signal });
}

/**
 * Inicia sesión. Credenciales inválidas, cuenta inexistente y cuenta bloqueada responden el MISMO 401, que acá se propaga
 * como `ApiClientError` con `status === 401` (usar `isUnauthorizedError`); la UI debe mostrar un mensaje genérico.
 */
export async function login(request: LoginRequest, signal?: AbortSignal): Promise<CurrentUser> {
  // `rememberMe` viaja tal cual (M3.1-S04): true = cookie persistente con tope absoluto; ausente/false = cookie de sesión del navegador.
  const user = await httpClient.postJson<CurrentUser>(AUTH_LOGIN_PATH, request, { signal });
  // Hay sesión nueva: el próximo 401 de un endpoint no-auth vuelve a notificar «sesión expirada» (ver sessionBoundary).
  rearmSessionBoundary();
  return user;
}

/** Cierra la sesión: el servidor borra la cookie y rota el SecurityStamp. Idempotente (204 también sin sesión). */
export async function logout(signal?: AbortSignal): Promise<void> {
  await httpClient.postJson<void>(AUTH_LOGOUT_PATH, {}, { signal });
}

/**
 * «Cerrar sesión en todos lados» (M3.1-S04): rota el SecurityStamp de la cuenta y borra la cookie de este navegador. Requiere
 * sesión (401 si no; no dispara el evento de sesión expirada porque es un endpoint de auth).
 */
export async function logoutAll(signal?: AbortSignal): Promise<void> {
  await httpClient.postJson<void>(AUTH_LOGOUT_ALL_PATH, {}, { signal });
}

/** Usuario de la sesión actual, o `null` si no hay sesión válida (401). Cualquier otro fallo se propaga. */
export async function getCurrentUser(signal?: AbortSignal): Promise<CurrentUser | null> {
  try {
    const user = await httpClient.get<CurrentUser>(AUTH_ME_PATH, { signal });
    rearmSessionBoundary(); // hay sesión viva
    return user;
  } catch (error) {
    if (isUnauthorizedError(error)) {
      return null;
    }
    throw error;
  }
}

// --- Recuperación de acceso y verificación de correo (M3.1-S08). Ningún token ni contraseña se guarda aquí: viajan en el cuerpo y mueren con la llamada. ---

/** Pide el enlace para elegir una contraseña nueva. 202 UNIFORME exista o no la cuenta; 400 `invalid_email` solo por formato. */
export function forgotPassword(request: EmailRequest, signal?: AbortSignal): Promise<RegisterResponse> {
  return httpClient.postJson<RegisterResponse>(AUTH_FORGOT_PASSWORD_PATH, { email: request.email }, { signal });
}

/** Elige una contraseña nueva con el token del correo. 204; 400 `invalid_token` (único error para token inválido/caducado/reusado) o `weak_password`. */
export async function resetPassword(request: ResetPasswordRequest, signal?: AbortSignal): Promise<void> {
  await httpClient.postJson<void>(
    AUTH_RESET_PASSWORD_PATH,
    { email: request.email, token: request.token, newPassword: request.newPassword },
    { signal },
  );
}

/** Confirma el correo con el token del enlace. 204; 400 `invalid_token` si no sirve. */
export async function confirmEmail(request: ConfirmEmailRequest, signal?: AbortSignal): Promise<void> {
  const body: Record<string, string> = { token: request.token };
  if (request.userId) body.userId = request.userId;
  else if (request.email) body.email = request.email;
  await httpClient.postJson<void>(AUTH_CONFIRM_EMAIL_PATH, body, { signal });
}

/** Pide otro correo de confirmación. 202 UNIFORME exista o no la cuenta. */
export function resendConfirmation(request: EmailRequest, signal?: AbortSignal): Promise<RegisterResponse> {
  return httpClient.postJson<RegisterResponse>(AUTH_RESEND_CONFIRMATION_PATH, { email: request.email }, { signal });
}

/**
 * Cambia la contraseña de la sesión actual (exige la contraseña actual). 204 y la sesión sigue viva (el servidor re-emite la cookie).
 * Contraseña actual incorrecta = 400 `invalid_current_password` (nunca 401); un 401 significa que ya no hay sesión.
 */
export async function changePassword(request: ChangePasswordRequest, signal?: AbortSignal): Promise<void> {
  await httpClient.postJson<void>(
    AUTH_CHANGE_PASSWORD_PATH,
    { currentPassword: request.currentPassword, newPassword: request.newPassword },
    { signal },
  );
}
