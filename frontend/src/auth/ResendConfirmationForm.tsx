import { useEffect, useRef, useState, type FormEvent } from "react";
import { flushSync } from "react-dom";
import { resendConfirmation } from "../api/authApi";
import { INVALID_EMAIL_CODE } from "../types/auth";
import { FORBIDDEN_MESSAGE, NETWORK_MESSAGE, RESEND, rateLimitedMessage } from "./authCopy";
import { classifyFailure } from "./authErrors";
import { AuthAlert, AuthButton, AuthStatus, TextField } from "./AuthUi";
import { isValidEmailFormat } from "./validation";

/**
 * Pedir otro correo de confirmación (M3.1-S08, DESIGN §5.15). `POST /api/v1/auth/resend-confirmation` responde 202 UNIFORME (exista o no la cuenta,
 * esté o no confirmada): el banner de éxito usa condicionales y el foco NO se mueve (anuncio por la región `aria-live`). El formulario queda disponible.
 */
export function ResendConfirmationForm({ initialEmail }: { initialEmail: string }) {
  const [email, setEmail] = useState(initialEmail);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [alert, setAlert] = useState<{ text: string; key: number } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const emailRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);
  const failuresRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submittingRef.current) return;

    const typed = email.trim();
    if (!typed || !isValidEmailFormat(typed)) {
      flushSync(() => {
        setFieldError(typed ? RESEND.emailInvalid : RESEND.emailRequired);
        setAlert(null);
        setConfirmed(false);
      });
      emailRef.current?.focus();
      return;
    }

    submittingRef.current = true;
    const controller = new AbortController();
    controllerRef.current = controller;
    setFieldError(null);
    setAlert(null);
    setConfirmed(false);
    setSubmitting(true);

    try {
      await resendConfirmation({ email: typed }, controller.signal);
      if (controller.signal.aborted) return;
      setConfirmed(true);
    } catch (error) {
      if (controller.signal.aborted) return;
      const failure = classifyFailure(error);
      if (failure.kind === "badRequest" && failure.code === INVALID_EMAIL_CODE) {
        flushSync(() => setFieldError(failure.message ?? RESEND.emailInvalid));
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
                  ? RESEND.rejected
                  : RESEND.server;
        setAlert({ text, key: failuresRef.current });
      }
    } finally {
      submittingRef.current = false;
      if (!controller.signal.aborted) setSubmitting(false);
    }
  };

  return (
    <form className="auth-form" noValidate aria-busy={submitting} onSubmit={(event) => void handleSubmit(event)}>
      {alert && <AuthAlert key={alert.key}>{alert.text}</AuthAlert>}
      <AuthStatus message={confirmed ? RESEND.success : null} />

      <TextField
        name="email"
        label={RESEND.emailLabel}
        type="email"
        autoComplete="email"
        value={email}
        onChange={(value) => {
          setEmail(value);
          setFieldError(null);
          setConfirmed(false); // el banner de éxito se quita al modificar el correo
        }}
        error={fieldError}
        readOnly={submitting}
        inputRef={emailRef}
      />

      <AuthButton type="submit" loading={submitting} loadingLabel={RESEND.submitting}>
        {RESEND.submit}
      </AuthButton>
      <p role="status" className="auth-visually-hidden">
        {submitting ? RESEND.submitting : ""}
      </p>
    </form>
  );
}
