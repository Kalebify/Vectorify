import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { flushSync } from "react-dom";
import { resetPassword } from "../api/authApi";
import { WEAK_PASSWORD_CODE } from "../types/auth";
import { clearRecoveryLink, getRecoveryLinkGeneration, readRecoveryLink, subscribeRecoveryLink } from "./authFragment";
import { buildAuthSearch, readReturnUrl } from "./authLocation";
import { RESET, rateLimitedMessage } from "./authCopy";
import { useAuth } from "./authContext";
import { classifyFailure } from "./authErrors";
import { AuthAlert, AuthButton, AuthCard, AuthLayout, AuthLink, HiddenUsernameField, ResetResultPanel, TextField } from "./AuthUi";
import { useDocumentTitle } from "./useDocumentTitle";
import { isValidEmailFormat, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "./validation";

type Phase = "ready" | "success" | "invalid" | "missing";

interface FieldErrors {
  password?: string;
  confirmation?: string;
}

/**
 * Pantalla de restablecimiento (`?view=reset-password`, M3.1-S08). El token llegó en el fragmento del enlace y `authFragment` lo capturó (y borró de la
 * barra) antes de que arrancara React; acá solo vive en una variable del módulo y en el estado de este componente, y se descarta al llegar a `success`
 * o `invalid`. Pegar otro enlace en una pestaña que ya muestra esta vista remonta la pantalla con el enlace nuevo.
 */
export function ResetPasswordScreen({ search }: { search: string }) {
  const generation = useSyncExternalStore(subscribeRecoveryLink, getRecoveryLinkGeneration);
  useEffect(() => clearRecoveryLink, []); // al salir de la vista el enlace se olvida (el estado de las pantallas ya lo tiene en memoria)
  return <ResetPasswordView key={generation} search={search} />;
}

function ResetPasswordView({ search }: { search: string }) {
  const { state, announceNotice, endSessionAfterPasswordReset } = useAuth();
  const returnUrl = readReturnUrl(search);

  // El enlace se lee UNA vez al montar: con token y un correo con formato válido hay formulario; si no, «sin enlace».
  const [link] = useState(() => {
    const captured = readRecoveryLink("reset-password");
    return captured?.token && captured.email && isValidEmailFormat(captured.email) ? { token: captured.token, email: captured.email } : null;
  });
  const [token, setToken] = useState<string | null>(link?.token ?? null);
  const email = link?.email ?? null;
  const [phase, setPhase] = useState<Phase>(link ? "ready" : "missing");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [alert, setAlert] = useState<{ text: string; key: number } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const headingRef = useRef<HTMLHeadingElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmationRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);
  const failuresRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  useDocumentTitle(
    phase === "ready" ? RESET.title : phase === "success" ? RESET.success.title : phase === "invalid" ? RESET.invalid.title : RESET.missing.title,
  );

  useEffect(() => () => controllerRef.current?.abort(), []);

  const finish = (next: "success" | "invalid") => {
    // El token y las contraseñas dejan la memoria en cuanto el enlace ya no sirve para nada.
    clearRecoveryLink();
    flushSync(() => {
      setToken(null);
      setPassword("");
      setConfirmation("");
      setErrors({});
      setAlert(null);
      setSubmitting(false);
      setPhase(next);
    });
    headingRef.current?.focus();
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submittingRef.current || !token || !email) return;

    const nextErrors: FieldErrors = {};
    if (password.length > MAX_PASSWORD_LENGTH) nextErrors.password = RESET.passwordLong;
    else if (password.length < MIN_PASSWORD_LENGTH) nextErrors.password = RESET.passwordShort;
    if (!confirmation) nextErrors.confirmation = RESET.confirmRequired;
    else if (confirmation !== password) nextErrors.confirmation = RESET.confirmMismatch;

    if (nextErrors.password || nextErrors.confirmation) {
      flushSync(() => {
        setErrors(nextErrors);
        setAlert(null);
      });
      (nextErrors.password ? passwordRef : confirmationRef).current?.focus();
      return;
    }

    submittingRef.current = true;
    const controller = new AbortController();
    controllerRef.current = controller;
    setErrors({});
    setAlert(null);
    setSubmitting(true);

    try {
      await resetPassword({ email, token, newPassword: password }, controller.signal);
      if (controller.signal.aborted) return;
      finish("success");
      // Si este navegador tenía una sesión, el servidor ya rotó el SecurityStamp: se cierra también localmente (sin aviso de «sesión terminada»).
      if (state.status === "authenticated") void endSessionAfterPasswordReset();
    } catch (error) {
      if (controller.signal.aborted) return;
      const failure = classifyFailure(error);
      if (failure.kind === "badRequest" && failure.code === WEAK_PASSWORD_CODE) {
        flushSync(() => {
          setErrors({ password: failure.message ?? RESET.passwordShort });
          setSubmitting(false);
        });
        passwordRef.current?.focus();
      } else if (failure.kind === "badRequest" || failure.kind === "unauthorized") {
        // Token caducado, reusado, malformado, de otra cuenta o cuenta inexistente: UN solo mensaje.
        finish("invalid");
      } else {
        failuresRef.current += 1;
        const text =
          failure.kind === "network"
            ? RESET.network
            : failure.kind === "forbidden"
              ? RESET.forbidden
              : failure.kind === "rateLimited"
                ? rateLimitedMessage(failure.retryAfterSeconds)
                : RESET.server;
        // Contraseñas y token se conservan; el foco se queda donde estaba.
        setAlert({ text, key: failuresRef.current });
      }
    } finally {
      submittingRef.current = false;
      if (!controller.signal.aborted) setSubmitting(false);
    }
  };

  const loginHref = buildAuthSearch("login", returnUrl);

  if (phase === "success") {
    return (
      <AuthLayout>
        <AuthCard title={RESET.success.title} headingRef={headingRef} body={RESET.success.body}>
          <ResetResultPanel note={RESET.success.note}>
            <AuthLink
              view="login"
              returnUrl={null}
              href={buildAuthSearch("login")}
              asButton
              onBeforeNavigate={() => announceNotice("password-reset", email)}
            >
              {RESET.success.goToLogin}
            </AuthLink>
          </ResetResultPanel>
        </AuthCard>
      </AuthLayout>
    );
  }

  if (phase === "invalid" || phase === "missing") {
    const copy = phase === "invalid" ? RESET.invalid : RESET.missing;
    return (
      <AuthLayout>
        <AuthCard title={copy.title} headingRef={headingRef} body={copy.body}>
          <ResetResultPanel note={phase === "invalid" ? RESET.invalid.note : undefined}>
            <AuthLink view="forgot-password" returnUrl={null} href={buildAuthSearch("forgot-password")} prefillEmail={email} asButton focusHeading>
              {copy.askNew}
            </AuthLink>
            <AuthLink view="login" returnUrl={returnUrl} href={loginHref} prefillEmail={email} focusHeading>
              {copy.backToLogin}
            </AuthLink>
          </ResetResultPanel>
        </AuthCard>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <AuthCard
        title={RESET.title}
        headingRef={headingRef}
        body={
          <>
            {RESET.introPrefix} <strong className="auth-email">{email}</strong>
            {RESET.introSuffix}
          </>
        }
        footer={
          <AuthLink view="login" returnUrl={returnUrl} href={loginHref} prefillEmail={email} focusHeading>
            {RESET.backToLogin}
          </AuthLink>
        }
      >
        <form className="auth-form" noValidate aria-busy={submitting} onSubmit={(event) => void handleSubmit(event)}>
          <HiddenUsernameField email={email} />
          {alert && <AuthAlert key={alert.key}>{alert.text}</AuthAlert>}

          <TextField
            name="newPassword"
            label={RESET.newLabel}
            type="password"
            autoComplete="new-password"
            hint={RESET.newHint}
            minLength={MIN_PASSWORD_LENGTH}
            maxLength={MAX_PASSWORD_LENGTH}
            value={password}
            onChange={(value) => {
              setPassword(value);
              setErrors((current) => ({ ...current, password: undefined }));
            }}
            error={errors.password}
            readOnly={submitting}
            inputRef={passwordRef}
          />
          <TextField
            name="newPasswordConfirmation"
            label={RESET.confirmLabel}
            type="password"
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LENGTH}
            maxLength={MAX_PASSWORD_LENGTH}
            value={confirmation}
            onChange={(value) => {
              setConfirmation(value);
              setErrors((current) => ({ ...current, confirmation: undefined }));
            }}
            error={errors.confirmation}
            readOnly={submitting}
            inputRef={confirmationRef}
          />

          <AuthButton type="submit" loading={submitting} loadingLabel={RESET.submitting}>
            {RESET.submit}
          </AuthButton>
          <p role="status" className="auth-visually-hidden">
            {submitting ? RESET.submitting : ""}
          </p>
        </form>
      </AuthCard>
    </AuthLayout>
  );
}

