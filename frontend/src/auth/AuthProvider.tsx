import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getCurrentUser, isUnauthorizedError, login, logout, logoutAll } from "../api/authApi";
import { onSessionExpired } from "../api/sessionBoundary";
import type { CurrentUser, LoginRequest } from "../types/auth";
import { currentReturnUrl, requestArrivalFocus } from "./authLocation";
import {
  AuthContext,
  type AuthContextValue,
  type AuthNotice,
  type AuthState,
  type SessionFailure,
} from "./authContext";
import { classifyFailure } from "./authErrors";

interface Store {
  state: AuthState;
  notice: AuthNotice | null;
  prefillEmail: string | null;
}

const INITIAL_STORE: Store = { state: { status: "unknown" }, notice: null, prefillEmail: null };

/** Un servidor anterior a S05 no envía `authMode`: se interpreta como sesión real. */
function normalizeUser(user: CurrentUser): CurrentUser {
  return { ...user, authMode: user.authMode === "Development" ? "Development" : "Authenticated" };
}

function toSessionFailure(error: unknown, attempt: number): SessionFailure {
  const failure = classifyFailure(error);
  return failure.kind === "network" ? { kind: "network", attempt } : { kind: "server", httpStatus: failure.status, attempt };
}

type SessionOutcome = { kind: "user"; user: CurrentUser } | { kind: "anonymous" } | { kind: "failed"; error: unknown };

/** Consulta `GET /api/v1/auth/me` y devuelve el resultado SIN tocar el estado (nunca lanza). */
async function fetchSession(signal: AbortSignal): Promise<SessionOutcome> {
  try {
    const user = await getCurrentUser(signal);
    return user ? { kind: "user", user } : { kind: "anonymous" };
  } catch (error) {
    return { kind: "failed", error };
  }
}

/**
 * Única fuente de verdad del estado de sesión en React (M3.1-S05). Consulta `GET /api/v1/auth/me` UNA vez al montarse, se suscribe al
 * evento «sesión expirada» del cliente HTTP (S04) y expone las acciones de entrada/salida. Las pantallas de producto nunca lo
 * usan: reciben el menú de cuenta como slot y quedan detrás de `AuthBoundary`.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [store, setStore] = useState<Store>(INITIAL_STORE);
  const [isRetrying, setIsRetrying] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const retryingRef = useRef(false);
  const failuresRef = useRef(0);

  // Aplica el resultado de una consulta a `/me` (ver `fetchSession`).
  const applySession = useCallback((outcome: SessionOutcome, focusOnSuccess: boolean) => {
    if (outcome.kind === "user") {
      if (focusOnSuccess) requestArrivalFocus();
      setStore((current) => ({ ...current, state: { status: "authenticated", user: normalizeUser(outcome.user) } }));
    } else if (outcome.kind === "anonymous") {
      setStore((current) => ({ ...current, state: { status: "unauthenticated", returnUrl: currentReturnUrl() } }));
    } else {
      // Red caída o 5xx: NO es «sesión cerrada». Se queda en `error` y se reintenta a mano (o al volver la conexión).
      failuresRef.current += 1;
      const failure = toSessionFailure(outcome.error, failuresRef.current);
      setStore((current) => ({ ...current, state: { status: "error", failure } }));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    void fetchSession(controller.signal).then((outcome) => {
      if (!controller.signal.aborted) applySession(outcome, false);
    });
    return () => controller.abort();
  }, [applySession]);

  const retry = useCallback(() => {
    if (retryingRef.current) return;
    retryingRef.current = true;
    setIsRetrying(true);

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    void fetchSession(controller.signal).then((outcome) => {
      if (!controller.signal.aborted) applySession(outcome, true);
      retryingRef.current = false;
      setIsRetrying(false);
    });
  }, [applySession]);

  // 401 en un endpoint que no es de auth con sesión activa (S04): la sesión caducó o fue revocada. Redirección inmediata al login
  // con el returnUrl de la ubicación actual. En modo Development no hay sesión que pueda caducar.
  useEffect(() => {
    return onSessionExpired(() => {
      setStore((current) => {
        if (current.state.status !== "authenticated" || current.state.user.authMode === "Development") return current;
        return { ...current, state: { status: "unauthenticated", returnUrl: currentReturnUrl() }, notice: "expired" };
      });
    });
  }, []);

  // Al volver la conexión se reintenta una vez la consulta de sesión fallida (si no hay ya un reintento en curso).
  const status = store.state.status;
  useEffect(() => {
    if (status !== "error") return;
    const handleOnline = () => retry();
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [status, retry]);

  const signIn = useCallback(async (request: LoginRequest, signal?: AbortSignal) => {
    const user = await login(request, signal);
    requestArrivalFocus();
    setStore({ state: { status: "authenticated", user: normalizeUser(user) }, notice: null, prefillEmail: null });
  }, []);

  const signOut = useCallback(async () => {
    try {
      await logout();
    } catch (error) {
      // 401: ya no había sesión, el resultado deseado se cumple. Red/5xx: la sesión NO se da por cerrada (propaga).
      if (!isUnauthorizedError(error)) throw error;
    }
    setStore((current) => ({ ...current, state: { status: "unauthenticated", returnUrl: null }, notice: "signed-out" }));
  }, []);

  const signOutAll = useCallback(async () => {
    try {
      await logoutAll();
    } catch (error) {
      if (!isUnauthorizedError(error)) throw error;
      // 401 en logout-all: la sesión ya había terminado => mismo trato que una sesión expirada.
      setStore((current) => ({
        ...current,
        state: { status: "unauthenticated", returnUrl: currentReturnUrl() },
        notice: "expired",
      }));
      return;
    }
    setStore((current) => ({ ...current, state: { status: "unauthenticated", returnUrl: null }, notice: "signed-out-all" }));
  }, []);

  const updateDisplayName = useCallback((displayName: string) => {
    setStore((current) =>
      current.state.status === "authenticated"
        ? { ...current, state: { status: "authenticated", user: { ...current.state.user, displayName } } }
        : current,
    );
  }, []);

  const announceRegistered = useCallback((email: string) => {
    setStore((current) => ({ ...current, notice: "registered", prefillEmail: email }));
  }, []);

  const setPrefillEmail = useCallback((email: string | null) => {
    setStore((current) => (current.prefillEmail === email ? current : { ...current, prefillEmail: email }));
  }, []);

  const announceNotice = useCallback((notice: "password-reset" | "email-confirmed", email: string | null) => {
    setStore((current) => ({ ...current, notice, prefillEmail: email }));
  }, []);

  // Tras restablecer la contraseña el servidor ya rotó el SecurityStamp (la cookie de este navegador deja de valer sola); igualmente se pide cerrar la sesión
  // para que borre la cookie, y se pasa a «no autenticado» sin el aviso «Tu sesión terminó» (el usuario acaba de cambiar su contraseña a propósito).
  const endSessionAfterPasswordReset = useCallback(async () => {
    try {
      await logout();
    } catch {
      // mejor esfuerzo: la sesión ya no es válida en el servidor
    }
    setStore((current) =>
      current.state.status === "authenticated" && current.state.user.authMode !== "Development"
        ? { ...current, state: { status: "unauthenticated", returnUrl: null }, notice: null }
        : current,
    );
  }, []);

  const expireSession = useCallback(() => {
    setStore((current) => {
      if (current.state.status !== "authenticated" || current.state.user.authMode === "Development") return current;
      return { ...current, state: { status: "unauthenticated", returnUrl: currentReturnUrl() }, notice: "expired" };
    });
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      state: store.state,
      user: store.state.status === "authenticated" ? store.state.user : null,
      isDevelopmentMode: store.state.status === "authenticated" && store.state.user.authMode === "Development",
      notice: store.notice,
      prefillEmail: store.prefillEmail,
      isRetrying,
      retry,
      signIn,
      signOut,
      signOutAll,
      updateDisplayName,
      announceRegistered,
      setPrefillEmail,
      announceNotice,
      endSessionAfterPasswordReset,
      expireSession,
    }),
    [
      store,
      isRetrying,
      retry,
      signIn,
      signOut,
      signOutAll,
      updateDisplayName,
      announceRegistered,
      setPrefillEmail,
      announceNotice,
      endSessionAfterPasswordReset,
      expireSession,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
