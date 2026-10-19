/**
 * Validación del `returnUrl` (M3.1-S05, anti open redirect). Solo es válido un destino INTERNO de esta misma app: ruta + consulta del
 * mismo origen y de la misma ruta de la aplicación (la SPA no tiene más rutas que las que viajan en la query string). Todo lo demás se
 * descarta en silencio y quien llama cae a «Mis proyectos».
 *
 * Se rechaza, entre otros: vacío, `//host`, `/\host`, `http(s):`, `javascript:`/`data:`, cualquier barra invertida o carácter de control
 * (el parser de URLs de los navegadores los reescribe a `/` y convertiría `/\evil.com` en `//evil.com`), `%2f%2fevil`, otro origen u otra
 * ruta, y un destino que sea a su vez una vista pública de auth —login, registro, recuperación o confirmación (evita bucles). El fragmento (`#...`) nunca se conserva.
 */

const MAX_RETURN_URL_LENGTH = 2048;
const AUTH_VIEWS = new Set(["login", "register", "forgot-password", "reset-password", "confirm-email"]);

// eslint-disable-next-line no-control-regex
const CONTROL_OR_BACKSLASH = /[\u0000-\u001f\u007f\\]/;

/**
 * Devuelve `ruta + consulta` normalizadas si `raw` es un destino interno válido, o `null` si no lo es.
 * `origin` y `appPath` se inyectan solo para tests; por defecto son los de la página actual.
 */
export function sanitizeReturnUrl(
  raw: string | null | undefined,
  origin: string = window.location.origin,
  appPath: string = window.location.pathname,
): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_RETURN_URL_LENGTH) {
    return null;
  }

  // Debe ser una ruta absoluta de esta app: empieza por UNA sola barra. Esto descarta de entrada `//host`, `https://host`,
  // `javascript:...`, `%2f%2fhost` (no empieza por `/`) y `/\host`.
  if (raw[0] !== "/" || raw[1] === "/" || raw[1] === "\\") {
    return null;
  }

  if (CONTROL_OR_BACKSLASH.test(raw)) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw, origin);
  } catch {
    return null;
  }

  if (parsed.origin !== origin || parsed.pathname !== appPath) {
    return null;
  }

  if (AUTH_VIEWS.has(parsed.searchParams.get("view") ?? "")) {
    return null;
  }

  return `${parsed.pathname}${parsed.search}`;
}
