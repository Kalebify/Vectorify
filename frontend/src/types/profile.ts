/**
 * Contratos tipados del perfil (M3.1-S07): GET/PATCH /api/v1/me. Deben reflejar Vectorify.Api.Contracts.{ProfileResponse, UpdateProfileRequest}.
 * La UI solo usa `displayName`, `email`, `createdAt` y `managedFields`: el `id` interno no se muestra nunca.
 */

export interface UserProfile {
  id: string;
  /** SOLO LECTURA: lo gestiona la cuenta de acceso. */
  email: string | null;
  displayName: string;
  /** Fecha de alta (ISO 8601). */
  createdAt?: string;
  /** Campos que gestiona la cuenta/identidad y no se editan en el perfil (hoy `["email"]`). */
  managedFields?: string[];
}

/** Cuerpo de `PATCH /api/v1/me`: lleva SOLO `displayName`; la UI nunca envía otros campos. */
export interface UpdateProfileRequest {
  displayName: string;
}

/** Código del 400 de validación del nombre para mostrar. */
export const INVALID_DISPLAY_NAME_CODE = "invalid_display_name";
