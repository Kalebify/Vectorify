import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { clearRecoveryLink, getRecoveryLinkGeneration, readRecoveryLink, subscribeRecoveryLink, type RecoveryLink } from "./authFragment";
import { buildAuthSearch, isPlainLeftClick, navigateToReturnUrl, requestArrivalFocus, wantsHeadingFocus } from "./authLocation";
import { CONFIRM_EMAIL, SESSION_ERROR } from "./authCopy";
import { useAuth } from "./authContext";
import { AuthAlert, AuthButton, AuthCard, AuthLayout, AuthLink, ResetResultPanel } from "./AuthUi";
import { sendConfirmation } from "./confirmRequests";
import { ResendConfirmationForm } from "./ResendConfirmationForm";
import { useDocumentTitle } from "./useDocumentTitle";
import { isValidEmailFormat } from "./validation";

type Phase = { kind: "pending"; alert: { text: string; key: number } | null } | { kind: "success" } | { kind: "invalid" } | { kind: "missing" };

/**
 * Pantalla de confirmación de correo (`?view=confirm-email`, M3.1-S08). Con el token del fragmento (ya capturado y borrado de la barra) confirma
 * automáticamente, una sola vez; sin él ofrece pedir otro correo. Pegar otro enlace en una pestaña que ya muestra esta vista remonta la pantalla.
 */
export function ConfirmEmailScreen() {
  const generation = useSyncExternalStore(subscribeRecoveryLink, getRecoveryLinkGeneration);
  useEffect(() => clearRecoveryLink, []);
  return <ConfirmEmailView key={generation} />;
}

function readLink(): (RecoveryLink & { token: string }) | null {
  const captured = readRecoveryLink("confirm-email");
  if (!captured?.token) return null;
  const hasIdentifier = Boolean(captured.userId) || (captured.email !== null && isValidEmailFormat(captured.email));
  return hasIdentifier ? { ...captured, token: captured.token } : null;
}

function ConfirmEmailView() {
  const { state, announceNotice, prefillEmail } = useAuth();
  // El enlace se lee UNA vez al montar. El token vive en su propio estado y se anula al resolverse; el otro estado conserva únicamente el correo/id.
  const [token, setToken] = useState<string | null>(() => readLink()?.token ?? null);
  const [link] = useState(() => {
    const captured = readLink();
    return captured ? { userId: captured.userId, email: captured.email } : null;
  });
  const [phase, setPhase] = useState<Phase>(link ? { kind: "pending", alert: null } : { kind: "missing" });
  const [retrying, setRetrying] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const headingRef = useRef<HTMLHeadingElement>(null);
  const failuresRef = useRef(0);
  const retryingRef = useRef(false);

  const title =
    phase.kind === "pending"
      ? CONFIRM_EMAIL.pending.title
      : phase.kind === "success"
        ? CONFIRM_EMAIL.success.title
        : phase.kind === "invalid"
          ? CONFIRM_EMAIL.invalid.title
          : CONFIRM_EMAIL.missing.title;
  useDocumentTitle(title);

  // Navegación interna desde el login («¿No te llegó el correo…?»): el foco va al h1. Abrir el enlace del correo (carga de página) no mueve el foco.
  useEffect(() => {
    if (wantsHeadingFocus()) headingRef.current?.focus();
  }, []);

  // Confirmación automática al montar (y cada vez que «Reintentar» incrementa `attempt`). El envío real es único por token (ver `inFlight`).
  useEffect(() => {
    if (!link || !token) return;
    let cancelled = false;

    void sendConfirmation({ token, userId: link.userId, email: link.email }).then((outcome) => {
      if (cancelled) return;
      retryingRef.current = false;
      setRetrying(false);
      if (outcome.kind === "error") {
        failuresRef.current += 1;
        // Se queda en «pendiente» con la alerta (se anuncia) y «Reintentar»; el foco no se mueve.
        setPhase({ kind: "pending", alert: { text: outcome.message, key: failuresRef.current } });
        return;
      }

      // Éxito o enlace no válido: el contenido cambia entero => foco al h1. El token ya no sirve y deja la memoria.
      clearRecoveryLink();
      flushSync(() => {
        setToken(null);
        setPhase({ kind: outcome.kind });
      });
      headingRef.current?.focus();
    });

    return () => {
      cancelled = true;
    };
  }, [link, token, attempt]);

  const retry = () => {
    if (retryingRef.current) return;
    retryingRef.current = true;
    setRetrying(true);
    setPhase({ kind: "pending", alert: null });
    setAttempt((current) => current + 1);
  };

  // Reintento automático UNA vez al volver la conexión (patrón de SessionErrorPanel).
  const hasRecoverableError = phase.kind === "pending" && phase.alert !== null;
  useEffect(() => {
    if (!hasRecoverableError) return;
    const handleOnline = () => retry();
    window.addEventListener("online", handleOnline, { once: true });
    return () => window.removeEventListener("online", handleOnline);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasRecoverableError]);

  const loginFooter = (
    <AuthLink view="login" returnUrl={null} href={buildAuthSearch("login")} prefillEmail={link?.email ?? undefined} focusHeading>
      {CONFIRM_EMAIL.backToLogin}
    </AuthLink>
  );

  if (phase.kind === "pending") {
    return (
      <AuthLayout>
        <AuthCard title={CONFIRM_EMAIL.pending.title} headingRef={headingRef}>
          {phase.alert ? (
            <>
              <AuthAlert key={phase.alert.key}>{phase.alert.text}</AuthAlert>
              <p className="auth-card__intro">{CONFIRM_EMAIL.pending.clarification}</p>
              <AuthButton loading={retrying} loadingLabel={SESSION_ERROR.retrying} onClick={retry}>
                {SESSION_ERROR.retry}
              </AuthButton>
            </>
          ) : (
            <div aria-busy="true">
              <p role="status" className="auth-pending__text">
                {CONFIRM_EMAIL.pending.status}
              </p>
            </div>
          )}
        </AuthCard>
      </AuthLayout>
    );
  }

  if (phase.kind === "success") {
    const hasSession = state.status === "authenticated";
    return (
      <AuthLayout>
        <AuthCard title={CONFIRM_EMAIL.success.title} headingRef={headingRef} body={CONFIRM_EMAIL.success.body}>
          <ResetResultPanel>
            {hasSession ? (
              <a
                className="auth-button auth-button--primary"
                href={window.location.pathname}
                onClick={(event) => {
                  if (!isPlainLeftClick(event)) return;
                  event.preventDefault();
                  requestArrivalFocus();
                  navigateToReturnUrl(null, { replace: false });
                }}
              >
                {CONFIRM_EMAIL.success.goToProjects}
              </a>
            ) : (
              <AuthLink
                view="login"
                returnUrl={null}
                href={buildAuthSearch("login")}
                asButton
                onBeforeNavigate={() => announceNotice("email-confirmed", link?.email ?? null)}
              >
                {CONFIRM_EMAIL.success.goToLogin}
              </AuthLink>
            )}
          </ResetResultPanel>
        </AuthCard>
      </AuthLayout>
    );
  }

  const copy = phase.kind === "invalid" ? CONFIRM_EMAIL.invalid : CONFIRM_EMAIL.missing;
  return (
    <AuthLayout>
      <AuthCard title={copy.title} headingRef={headingRef} body={copy.body} footer={loginFooter}>
        <ResendConfirmationForm initialEmail={link?.email ?? prefillEmail ?? ""} />
      </AuthCard>
    </AuthLayout>
  );
}
