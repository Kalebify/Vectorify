import { sanitizeReturnUrl } from "./returnUrl";

/**
 * Ubicación de las vistas de autenticación (M3.1-S05), por query string como el resto de la app (sin react-router; ver
 * `lib/workspaceLocation.ts`): `?view=login`, `?view=register` y, desde M3.1-S08, `?view=forgot-password`, `?view=reset-password` y `?view=confirm-email`, con `returnUrl` opcional ya validado (ver `returnUrl.ts`).
 * Las vistas de producto (`dashboard`, `new`, Workspace) siguen siendo de `lib/workspaceLocation.ts` y no se tocan.
 */

export type AuthView = "login" | "register" | "forgot-password" | "reset-password" | "confirm-email";

const AUTH_VIEWS: readonly AuthView[] = ["login", "register", "forgot-password", "reset-password", "confirm-email"];

const VIEW_PARAM = "view";
const RETURN_URL_PARAM = "returnUrl";
const LOCATION_EVENT = "vectorify:locationchange";
/** Clave de `history.state`: la navegación interna login <-> registro mueve el foco al encabezado de la pantalla nueva. */
const FOCUS_HEADING_KEY = "vectorifyAuthFocusHeading";

/** Vista de auth de una query string, o `null` si es una vista de producto. */
export function readAuthView(search: string = window.location.search): AuthView | null {
  const view = new URLSearchParams(search).get(VIEW_PARAM);
  return AUTH_VIEWS.find((candidate) => candidate === view) ?? null;
}

/** true si es un clic izquierdo sin modificadores (el resto —clic central, Ctrl/Cmd/Mayús+clic— lo resuelve el navegador, p. ej. otra pestaña). */
export function isPlainLeftClick(event: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/** Ruta de la pantalla «Mi cuenta» (M3.1-S07): `?view=account`. Es una vista protegida (detrás de `AuthBoundary`), no una vista pública de auth. */
const ACCOUNT_VIEW = "account";

/** true si la query string es la de «Mi cuenta». */
export function isAccountView(search: string = window.location.search): boolean {
  return new URLSearchParams(search).get(VIEW_PARAM) === ACCOUNT_VIEW;
}

/** `href` real de «Mi cuenta» (abrible en otra pestaña): ruta de la app + `?view=account`. */
export function accountHref(): string {
  return `${window.location.pathname}?${VIEW_PARAM}=${ACCOUNT_VIEW}`;
}

/** `returnUrl` de una query string, ya validado (anti open redirect), o `null`. */
export function readReturnUrl(search: string = window.location.search): string | null {
  return sanitizeReturnUrl(new URLSearchParams(search).get(RETURN_URL_PARAM));
}

/** Query string (con `?`) de una vista de auth. Un `returnUrl` no válido se omite. */
export function buildAuthSearch(view: AuthView, returnUrl?: string | null): string {
  const params = new URLSearchParams();
  params.set(VIEW_PARAM, view);
  const safe = sanitizeReturnUrl(returnUrl);
  if (safe) {
    params.set(RETURN_URL_PARAM, safe);
  }
  return `?${params.toString()}`;
}

/**
 * `returnUrl` que representa la ubicación ACTUAL de la app (ruta + consulta, deep link del Workspace incluido), o `null` si ya estamos
 * en una vista de auth o es «Mis proyectos» sin consulta (destino por defecto), o la ubicación no es un destino válido.
 */
export function currentReturnUrl(): string | null {
  const safe = sanitizeReturnUrl(`${window.location.pathname}${window.location.search}`);
  // «Mis proyectos» sin consulta es el destino por defecto: no hace falta recordarlo (y evita un aviso de «te llevamos a…» innecesario).
  return safe === window.location.pathname ? null : safe;
}

function notifyLocationChange(): void {
  window.dispatchEvent(new Event(LOCATION_EVENT));
}

export interface NavigateOptions {
  /** Reemplaza la entrada del historial en vez de apilar una nueva (redirecciones del sistema). */
  replace?: boolean;
  /** Pide mover el foco al `h1` de la pantalla de destino (navegación interna iniciada por el usuario). */
  focusHeading?: boolean;
}

function writeHistory(url: string, options: NavigateOptions): void {
  const state = options.focusHeading ? { [FOCUS_HEADING_KEY]: true } : {};
  if (options.replace) {
    window.history.replaceState(state, "", url);
  } else {
    window.history.pushState(state, "", url);
  }
  notifyLocationChange();
}

/** Navega (sin recargar) a una vista de auth. */
export function navigateAuth(view: AuthView, returnUrl: string | null, options: NavigateOptions = {}): void {
  writeHistory(`${window.location.pathname}${buildAuthSearch(view, returnUrl)}`, options);
}

/** Navega (sin recargar) a «Mi cuenta», pidiendo foco en su encabezado. */
export function navigateToAccount(): void {
  writeHistory(accountHref(), { focusHeading: true });
}

/** Mueve el foco al `h1` de la pantalla actual (estando ya en «Mi cuenta»). */
export function focusPageHeading(): void {
  document.querySelector<HTMLElement>("main h1[tabindex='-1']")?.focus();
}

/**
 * Antes de una navegación interna que desmonta la app (p. ej. del Editor a «Mi cuenta»): consulta a los avisos de «salir sin guardar» que la
 * propia app ya registra en `beforeunload` (Editor y guardado del Workspace) disparando un evento sintético CANCELABLE; no muestra el diálogo
 * del navegador. Si alguno lo cancela hay trabajo sin guardar y se pide confirmación. Devuelve true si se puede navegar.
 */
export function confirmLeaveIfUnsaved(message: string): boolean {
  const probe = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(probe);
  return !probe.defaultPrevented || window.confirm(message);
}

/** Sale de las vistas de auth hacia `returnUrl` (ya validado) o, si no hay, a «Mis proyectos». */
export function navigateToReturnUrl(returnUrl: string | null, options: NavigateOptions = { replace: true }): void {
  const safe = sanitizeReturnUrl(returnUrl);
  writeHistory(safe ?? window.location.pathname, options);
}

/** true si la entrada actual del historial pidió foco en el encabezado (navegación interna login <-> registro). */
export function wantsHeadingFocus(): boolean {
  const state = window.history.state as Record<string, unknown> | null;
  return state?.[FOCUS_HEADING_KEY] === true;
}

/** Suscripción para `useSyncExternalStore`: cambios de ubicación por popstate o por `navigateAuth`/`navigateToReturnUrl`. */
export function subscribeLocation(callback: () => void): () => void {
  window.addEventListener("popstate", callback);
  window.addEventListener(LOCATION_EVENT, callback);
  return () => {
    window.removeEventListener("popstate", callback);
    window.removeEventListener(LOCATION_EVENT, callback);
  };
}

export function getLocationSearch(): string {
  return window.location.search;
}

// --- Foco al llegar a la app tras autenticarse (§9.3 del diseño) ---

let arrivalFocusPending = false;

/** Marca que el próximo montaje de la app debe mover el foco al primer encabezado del `<main>` (login correcto o reintento correcto). */
export function requestArrivalFocus(): void {
  arrivalFocusPending = true;
}

/** Consume la marca de `requestArrivalFocus`; devuelve true una sola vez. */
export function consumeArrivalFocus(): boolean {
  const pending = arrivalFocusPending;
  arrivalFocusPending = false;
  return pending;
}
