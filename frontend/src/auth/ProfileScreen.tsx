import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { getProfile } from "../api/profileApi";
import type { UserProfile } from "../types/profile";
import { CHANGE_PASSWORD, PROFILE, SESSION_ERROR } from "./authCopy";
import { useAuth } from "./authContext";
import { classifyFailure, type Failure } from "./authErrors";
import { focusPageHeading, wantsHeadingFocus } from "./authLocation";
import { AccountLayout } from "./AccountLayout";
import { AuthAlert, AuthButton } from "./AuthUi";
import { ChangePasswordForm } from "./ChangePasswordForm";
import { ProfileForm } from "./ProfileForm";
import { useDocumentTitle } from "./useDocumentTitle";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; profile: UserProfile }
  | { status: "error"; failure: Failure; attempt: number };

function loadErrorText(failure: Failure): string {
  switch (failure.kind) {
    case "network":
      return PROFILE.loadError.network;
    case "forbidden":
      return PROFILE.loadError.forbidden(failure.status ?? 403);
    case "server":
      return PROFILE.loadError.server(failure.status);
    default:
      return PROFILE.loadError.other;
  }
}

/**
 * Pantalla «Mi cuenta» (M3.1-S07, DESIGN §5.4): carga `GET /api/v1/me` y muestra el perfil editable (datos de VECTORiZE) separado de los datos de
 * la cuenta de acceso (solo lectura). Siempre se monta dentro de `AuthBoundary`. Un 401 lo resuelve la frontera global (login con `returnUrl`).
 */
export function ProfileScreen() {
  const { isDevelopmentMode, updateDisplayName } = useAuth();
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [retrying, setRetrying] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const attemptRef = useRef(0);
  const retryingRef = useRef(false);

  useDocumentTitle(PROFILE.documentTitle);

  const fetchProfile = useCallback((isRetry: boolean) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    getProfile(controller.signal).then(
      (profile) => {
        if (controller.signal.aborted) return;
        flushSync(() => {
          setLoad({ status: "ready", profile });
          setRetrying(false);
        });
        retryingRef.current = false;
        // Un reintento correcto reemplaza el botón «Reintentar» (que tenía el foco): el foco pasa al h1, nunca al body.
        if (isRetry) focusPageHeading();
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        retryingRef.current = false;
        setRetrying(false);
        const failure = classifyFailure(error);
        // 401: la frontera global lleva al login; mientras tanto no se pinta ningún error. Abortado: no hay nada que mostrar.
        if (failure.kind === "unauthorized" || failure.kind === "aborted") return;
        attemptRef.current += 1;
        setLoad({ status: "error", failure, attempt: attemptRef.current });
      },
    );
  }, []);

  const retry = useCallback(() => {
    if (retryingRef.current) return;
    retryingRef.current = true;
    setRetrying(true);
    fetchProfile(true);
  }, [fetchProfile]);

  useEffect(() => {
    fetchProfile(false);
    return () => controllerRef.current?.abort();
  }, [fetchProfile]);

  // Navegación interna a «Mi cuenta»: el foco va al h1. Una carga directa o una recarga no mueve el foco.
  useEffect(() => {
    if (wantsHeadingFocus()) {
      focusPageHeading();
      window.history.replaceState({}, "", window.location.href);
    }
  }, []);

  // Al volver la conexión se reintenta una vez la carga fallida.
  const status = load.status;
  useEffect(() => {
    if (status !== "error") return;
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [status, retry]);

  return (
    <AccountLayout title={PROFILE.title} intro={PROFILE.intro}>
      {load.status === "loading" && <ProfileLoading />}
      {load.status === "error" && (
        <ProfileLoadError failure={load.failure} attempt={load.attempt} retrying={retrying} onRetry={retry} />
      )}
      {load.status === "ready" && (
        <>
          {isDevelopmentMode && (
            <div className="status-banner auth-banner auth-banner--info">
              <p>{PROFILE.developmentNotice}</p>
            </div>
          )}
          <ProfileSection title={PROFILE.profileSection.title} intro={PROFILE.profileSection.intro}>
            <ProfileForm initialName={load.profile.displayName} onSaved={updateDisplayName} />
          </ProfileSection>
          <ProfileSection
            title={PROFILE.accessSection.title}
            intro={isDevelopmentMode ? PROFILE.accessSection.introDevelopment : PROFILE.accessSection.intro}
          >
            <AccountFacts profile={load.profile} development={isDevelopmentMode} />
          </ProfileSection>
          {/* Solo con sesión real (M3.1-S08): en modo Development no hay contraseña que cambiar. */}
          {!isDevelopmentMode && (
            <ProfileSection title={CHANGE_PASSWORD.title} intro={CHANGE_PASSWORD.intro}>
              <ChangePasswordForm email={load.profile.email} />
            </ProfileSection>
          )}
        </>
      )}
    </AccountLayout>
  );
}

function ProfileSection({ title, intro, children }: { title: string; intro: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <section className="profile-section" aria-labelledby={headingId}>
      <div className="profile-section__head">
        <h2 id={headingId}>{title}</h2>
        <p className="auth-card__intro">{intro}</p>
      </div>
      {children}
    </section>
  );
}

function ProfileLoading() {
  return (
    <div className="profile-loading" aria-busy="true">
      <p role="status" className="auth-pending__text">
        {PROFILE.loading}
      </p>
    </div>
  );
}

function ProfileLoadError({
  failure,
  attempt,
  retrying,
  onRetry,
}: {
  failure: Failure;
  attempt: number;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="profile-load-error">
      {/* La causa se remonta en cada fallo (key) para que el lector de pantalla la anuncie de nuevo aunque el texto sea idéntico. */}
      {!retrying && <AuthAlert key={attempt}>{loadErrorText(failure)}</AuthAlert>}
      <p className="auth-card__intro">{SESSION_ERROR.clarification}</p>
      <AuthButton loading={retrying} loadingLabel={SESSION_ERROR.retrying} onClick={onRetry}>
        {SESSION_ERROR.retry}
      </AuthButton>
    </div>
  );
}

const DATE_FORMAT = new Intl.DateTimeFormat("es", { dateStyle: "long" });

/** Fecha de alta legible, o `null` si no llega o no es una fecha válida (el par entero no se renderiza). */
function formatCreatedAt(value: string | undefined): { iso: string; text: string } | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : { iso: value, text: DATE_FORMAT.format(date) };
}

/** Datos de la cuenta de acceso como información (lista de definición), nunca como controles: el correo no se edita. */
function AccountFacts({ profile, development }: { profile: UserProfile; development: boolean }) {
  const created = formatCreatedAt(profile.createdAt);
  const emailManaged = profile.managedFields?.includes("email") ?? true;
  const email = profile.email?.trim();

  return (
    <dl className="profile-facts">
      <dt>{PROFILE.accessSection.emailLabel}</dt>
      <dd>
        <span className="profile-facts__value">{email || PROFILE.accessSection.noEmail}</span>
        {emailManaged && (
          <p className="auth-field__hint profile-facts__note">
            {development ? PROFILE.accessSection.emailNoteDevelopment : PROFILE.accessSection.emailNote}
          </p>
        )}
      </dd>
      {created && (
        <>
          <dt>{PROFILE.accessSection.createdLabel}</dt>
          <dd>
            <time dateTime={created.iso}>{created.text}</time>
          </dd>
        </>
      )}
    </dl>
  );
}
