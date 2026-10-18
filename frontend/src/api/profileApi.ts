import { httpClient } from "./httpClient";
import type { UpdateProfileRequest, UserProfile } from "../types/profile";

/**
 * Cliente del perfil propio (M3.1-S07). El usuario lo decide SIEMPRE el servidor desde la sesión: no hay ids en la ruta ni en el cuerpo.
 * Un 401 lo centraliza `httpClient` + la frontera de sesión (S04/S05); acá no se gestiona.
 */

export const PROFILE_PATH = "/api/v1/me";

export function getProfile(signal?: AbortSignal): Promise<UserProfile> {
  return httpClient.get<UserProfile>(PROFILE_PATH, { signal });
}

/** Actualiza el nombre para mostrar. Devuelve el perfil con el nombre YA recortado por el servidor. */
export function updateProfile(request: UpdateProfileRequest, signal?: AbortSignal): Promise<UserProfile> {
  return httpClient.patchJson<UserProfile>(PROFILE_PATH, { displayName: request.displayName }, { signal });
}
