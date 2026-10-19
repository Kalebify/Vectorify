/**
 * Captura del token de los enlaces de correo (M3.1-S08, DESIGN §6.1). Módulo CON EFECTO: se importa como PRIMER import de `main.tsx`, así que se evalúa
 * antes que `AppRoot`, el `AuthProvider` y cualquier `fetch`. Si la ubicación es `?view=reset-password` o `?view=confirm-email` y trae fragmento
 * (`#email=…&token=…` / `#userId=…&token=…`), lo lee, lo guarda SOLO en una variable de este módulo y lo borra de la barra con `history.replaceState`
 * de inmediato (aunque esté mal formado). Lo mismo ocurre en `hashchange`: pegar el enlace en una pestaña que ya está en esa vista es una navegación
 * de fragmento sin recarga.
 *
 * El token NUNCA se escribe en `localStorage`, `sessionStorage`, cookies, `history.state`, la query, atributos del DOM, `document.title` ni la consola.
 * Recargar la página lo pierde a propósito (las pantallas muestran el estado «sin enlace»). El fragmento no forma parte del `Referer` ni llega al servidor.
 */

export type RecoveryView = "reset-password" | "confirm-email";

export interface RecoveryLink {
  view: RecoveryView;
  token: string | null;
  email: string | null;
  userId: string | null;
}

let captured: RecoveryLink | null = null;
let generation = 0;
const listeners = new Set<() => void>();

function isRecoveryView(view: string | null): view is RecoveryView {
  return view === "reset-password" || view === "confirm-email";
}

/** Lee y borra el fragmento si corresponde. Idempotente: sin fragmento no toca nada. */
export function captureRecoveryFragment(): void {
  const view = new URLSearchParams(window.location.search).get("view");
  const hash = window.location.hash;
  if (!isRecoveryView(view) || hash.length <= 1) return;

  const params = new URLSearchParams(hash.slice(1));
  captured = {
    view,
    token: params.get("token") || null,
    email: params.get("email") || null,
    userId: params.get("userId") || null,
  };
  generation += 1;

  // Primero se borra de la barra (conservando history.state), después se avisa a las pantallas montadas.
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
  listeners.forEach((listener) => listener());
}

/** Datos del enlace capturado para esta vista, o `null` (no hubo fragmento, otra vista, ya se borró o se recargó la página). */
export function readRecoveryLink(view: RecoveryView): RecoveryLink | null {
  return captured?.view === view ? captured : null;
}

/** Olvida el enlace capturado (al llegar a `success`/`invalid` y al salir de la vista). */
export function clearRecoveryLink(): void {
  captured = null;
}

/** Contador de enlaces capturados: cambia cuando se pega un enlace nuevo en una pestaña que ya muestra la vista (para `useSyncExternalStore`). */
export function getRecoveryLinkGeneration(): number {
  return generation;
}

export function subscribeRecoveryLink(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

captureRecoveryFragment();
window.addEventListener("hashchange", captureRecoveryFragment);
