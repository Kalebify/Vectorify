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

/** Usuario actual: `id` es el Users.Id INTERNO que resolvió el servidor desde la cookie verificada. */
export interface CurrentUser {
  id: string;
  email: string | null;
  displayName: string;
}
