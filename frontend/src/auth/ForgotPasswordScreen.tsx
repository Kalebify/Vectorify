import { useEffect, useRef, useState, type FormEvent } from "react";
import { flushSync } from "react-dom";
import { forgotPassword } from "../api/authApi";
import { INVALID_EMAIL_CODE } from "../types/auth";
import { buildAuthSearch, readReturnUrl, wantsHeadingFocus } from "./authLocation";
import { FORBIDDEN_MESSAGE, FORGOT, NETWORK_MESSAGE, rateLimitedMessage } from "./authCopy";
import { useAuth } from "./authContext";
import { classifyFailure } from "./authErrors";
import { AuthAlert, AuthButton, AuthCard, AuthLayout, AuthLink, ResetResultPanel, TextField } from "./AuthUi";
import { useDocumentTitle } from "./useDocumentTitle";
import { isValidEmailFormat } from "./validation";

/**
 * Pantalla de solicitud de recuperación (`?view=forgot-password`, M3.1-S08). El servidor responde SIEMPRE 202 (exista o no la cuenta, también si el
 * límite por dirección frenó el envío): el panel «Pedido recibido» usa condicionales («Si existe una cuenta…») y es idéntico en todos los casos.
 */
export function ForgotPasswordScreen({ search }: { search: string }) {
  const { prefillEmail } = useAuth();
  const returnUrl = readReturnUrl(search);

  const [email, setEmail] = useState(prefillEmail ?? "");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [alert, setAlert] = useState<{ text: string; key: number } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sentEmail, setSentEmail] = useState<string | null>(null);

  const headingRef = useRef<HTMLHeadingElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);
  const failuresRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  const sent = sentEmail !== null;
  useDocumentTitle(sent ? FORGOT.sent.title : FORGOT.title);

  // Navegación interna desde el login: el foco va al h1. Una carga directa no mueve el foco.
  useEffect(() => {
    if (wantsHeadingFocus()) headingRef.current?.focus();
  }, []);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const typedEmail = email.trim();
  const prefillForLogin = isValidEmailFormat(typedEmail) ? typedEmail : null;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submittingRef.current) return;

    if (!typedEmail || !isValidEmailFormat(typedEmail)) {
      flushSync(() => {
        setFieldError(typedEmail ? FORGOT.emailInvalid : FORGOT.emailRequired);
        setAlert(null);
      });
      emailRef.current?.focus();
      return;
    }

    submittingRef.current = true;
    const controller = new AbortController();
    controllerRef.current = controller;
    setFieldError(null);
    setAlert(null);
    setSubmitting(true);

    try {
      await forgotPassword({ email: typedEmail }, controller.signal);
      if (controller.signal.aborted) return;
      // El formulario se reemplaza por el panel: el foco va al h1 (flushSync para que el destino exista antes de enfocar).
      flushSync(() => {
        setSentEmail(typedEmail);
        setSubmitting(false);
      });
      headingRef.current?.focus();
    } catch (error) {
      if (controller.signal.aborted) return;
      const failure = classifyFailure(error);
      if (failure.kind === "badRequest" && failure.code === INVALID_EMAIL_CODE) {
        flushSync(() => setFieldError(failure.message ?? FORGOT.emailInvalid));
        emailRef.current?.focus();
      } else {
        failuresRef.current += 1;
        const text =
          failure.kind === "network"
            ? NETWORK_MESSAGE
            : failure.kind === "forbidden"
              ? FORBIDDEN_MESSAGE
              : failure.kind === "rateLimited"
                ? rateLimitedMessage(failure.retryAfterSeconds)
                : failure.kind === "badRequest" || failure.kind === "unauthorized"
                  ? FORGOT.rejected
                  : FORGOT.server;
        // Lo escrito se conserva y el foco se queda donde estaba.
        setAlert({ text, key: failuresRef.current });
      }
    } finally {
      submittingRef.current = false;
      if (!controller.signal.aborted) setSubmitting(false);
    }
  };

  const askAgain = () => {
    flushSync(() => {
      setSentEmail(null);
      setAlert(null);
      setFieldError(null);
    });
    emailRef.current?.focus();
  };

  if (sent) {
    return (
      <AuthLayout>
        <AuthCard
          title={FORGOT.sent.title}
          headingRef={headingRef}
          body={
            <>
              {FORGOT.sent.bodyPrefix} <strong className="auth-email">{sentEmail}</strong>
              {FORGOT.sent.bodySuffix}
            </>
          }
        >
          <ResetResultPanel note={FORGOT.sent.note}>
            <AuthLink
              view="login"
              returnUrl={returnUrl}
              href={buildAuthSearch("login", returnUrl)}
              prefillEmail={sentEmail}
              asButton
              focusHeading
            >
              {FORGOT.sent.goToLogin}
            </AuthLink>
            <AuthButton variant="secondary" onClick={askAgain}>
              {FORGOT.sent.again}
            </AuthButton>
          </ResetResultPanel>
        </AuthCard>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <AuthCard
        title={FORGOT.title}
        intro={FORGOT.intro}
        headingRef={headingRef}
        footer={
          <>
            {FORGOT.switchPrompt}{" "}
            <AuthLink
              view="login"
              returnUrl={returnUrl}
              href={buildAuthSearch("login", returnUrl)}
              prefillEmail={prefillForLogin}
              focusHeading
            >
              {FORGOT.switchLink}
            </AuthLink>
          </>
        }
      >
        <form className="auth-form" noValidate aria-busy={submitting} onSubmit={(event) => void handleSubmit(event)}>
          {alert && <AuthAlert key={alert.key}>{alert.text}</AuthAlert>}

          <TextField
            name="email"
            label={FORGOT.emailLabel}
            type="email"
            autoComplete="email"
            value={email}
            onChange={(value) => {
              setEmail(value);
              setFieldError(null);
            }}
            error={fieldError}
            readOnly={submitting}
            inputRef={emailRef}
          />

          <AuthButton type="submit" loading={submitting} loadingLabel={FORGOT.submitting}>
            {FORGOT.submit}
          </AuthButton>
          <p role="status" className="auth-visually-hidden">
            {submitting ? FORGOT.submitting : ""}
          </p>
        </form>
      </AuthCard>
    </AuthLayout>
  );
}
