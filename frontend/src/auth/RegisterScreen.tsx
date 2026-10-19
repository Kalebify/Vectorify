import { useEffect, useRef, useState, type FormEvent } from "react";
import { flushSync } from "react-dom";
import { register } from "../api/authApi";
import { buildAuthSearch, readReturnUrl, wantsHeadingFocus } from "./authLocation";
import { FORBIDDEN_MESSAGE, NETWORK_MESSAGE, RATE_LIMITED_MESSAGE, REGISTER, REGISTER_RECEIVED, TITLES } from "./authCopy";
import { useAuth } from "./authContext";
import { classifyFailure } from "./authErrors";
import { AuthAlert, AuthButton, AuthCard, AuthLayout, AuthLink, TextField } from "./AuthUi";
import { useDocumentTitle } from "./useDocumentTitle";
import { isValidEmailFormat, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "./validation";

type RegisterAlert = "network" | "server" | "forbidden" | "rate-limited" | "rejected";

const ALERT_TEXT: Record<RegisterAlert, string> = {
  network: NETWORK_MESSAGE,
  server: REGISTER.server,
  forbidden: FORBIDDEN_MESSAGE,
  "rate-limited": RATE_LIMITED_MESSAGE,
  rejected: REGISTER.rejected,
};

interface FieldErrors {
  email?: string;
  password?: string;
  confirmation?: string;
}

/**
 * Pantalla de registro (`?view=register`). El 202 es UNIFORME (exista o no el correo): el panel «Registro recibido» no afirma que la
 * cuenta sea nueva ni que el correo de confirmación llegó (M3.1-S08): habla en condicional («si el correo es nuevo para nosotros…»).
 */
export function RegisterScreen({ search }: { search: string }) {
  const { announceRegistered } = useAuth();
  const returnUrl = readReturnUrl(search);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [alert, setAlert] = useState<RegisterAlert | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [receivedEmail, setReceivedEmail] = useState<string | null>(null);

  const headingRef = useRef<HTMLHeadingElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmationRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);

  const received = receivedEmail !== null;
  useDocumentTitle(received ? TITLES.registerReceived : TITLES.register);

  useEffect(() => {
    if (wantsHeadingFocus()) headingRef.current?.focus();
  }, []);

  // Al aparecer «Registro recibido» el foco va a su h1.
  useEffect(() => {
    if (received) headingRef.current?.focus();
  }, [received]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const focusField = (field: keyof FieldErrors) => {
    const ref = field === "email" ? emailRef : field === "password" ? passwordRef : confirmationRef;
    ref.current?.focus();
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submittingRef.current) return;

    const trimmedEmail = email.trim();
    const nextErrors: FieldErrors = {};
    if (!trimmedEmail) nextErrors.email = REGISTER.emailRequired;
    else if (!isValidEmailFormat(trimmedEmail)) nextErrors.email = REGISTER.emailInvalid;
    if (password.length > MAX_PASSWORD_LENGTH) nextErrors.password = REGISTER.passwordLong;
    else if (password.length < MIN_PASSWORD_LENGTH) nextErrors.password = REGISTER.passwordShort;
    if (!confirmation) nextErrors.confirmation = REGISTER.confirmRequired;
    else if (confirmation !== password) nextErrors.confirmation = REGISTER.confirmMismatch;

    const firstInvalid = (["email", "password", "confirmation"] as const).find((field) => nextErrors[field]);
    if (firstInvalid) {
      flushSync(() => {
        setErrors(nextErrors);
        setAlert(null);
      });
      focusField(firstInvalid);
      return;
    }

    submittingRef.current = true;
    const controller = new AbortController();
    controllerRef.current = controller;
    setErrors({});
    setAlert(null);
    setSubmitting(true);

    try {
      await register({ email: trimmedEmail, password }, controller.signal);
      if (controller.signal.aborted) return;
      setReceivedEmail(trimmedEmail);
      // La contraseña no se conserva en memoria una vez aceptado el registro.
      setPassword("");
      setConfirmation("");
    } catch (error) {
      if (controller.signal.aborted) return;
      const failure = classifyFailure(error);

      if (failure.kind === "badRequest" && failure.code === "invalid_email") {
        const message = failure.message ?? REGISTER.emailInvalid;
        flushSync(() => setErrors({ email: message }));
        focusField("email");
      } else if (failure.kind === "badRequest" && failure.code === "weak_password") {
        const message = failure.message ?? REGISTER.passwordShort;
        flushSync(() => setErrors({ password: message }));
        focusField("password");
      } else {
        // La contraseña NO se borra y el foco se queda donde estaba.
        setAlert(
          failure.kind === "network"
            ? "network"
            : failure.kind === "forbidden"
              ? "forbidden"
              : failure.kind === "rateLimited"
                ? "rate-limited"
                : failure.kind === "badRequest"
                  ? "rejected"
                  : "server",
        );
      }
    } finally {
      submittingRef.current = false;
      if (!controller.signal.aborted) setSubmitting(false);
    }
  };

  if (received) {
    return (
      <AuthLayout>
        <AuthCard title={TITLES.registerReceived} headingRef={headingRef}>
          <p className="auth-card__body">{REGISTER_RECEIVED.body}</p>
          <p className="auth-card__intro">{REGISTER_RECEIVED.note}</p>
          <AuthLink
            view="login"
            returnUrl={returnUrl}
            href={buildAuthSearch("login", returnUrl)}
            asButton
            onBeforeNavigate={() => announceRegistered(receivedEmail)}
          >
            {REGISTER_RECEIVED.goToLogin}
          </AuthLink>
        </AuthCard>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <AuthCard
        title={TITLES.register}
        intro={REGISTER.intro}
        headingRef={headingRef}
        footer={
          <>
            {REGISTER.switchPrompt}{" "}
            <AuthLink view="login" returnUrl={returnUrl} href={buildAuthSearch("login", returnUrl)} focusHeading>
              {REGISTER.switchLink}
            </AuthLink>
          </>
        }
      >
        <form className="auth-form" noValidate aria-busy={submitting} onSubmit={handleSubmit}>
          {alert && <AuthAlert>{ALERT_TEXT[alert]}</AuthAlert>}

          <TextField
            name="email"
            label={REGISTER.emailLabel}
            type="email"
            autoComplete="email"
            value={email}
            onChange={(value) => {
              setEmail(value);
              setErrors((current) => ({ ...current, email: undefined }));
            }}
            error={errors.email}
            readOnly={submitting}
            inputRef={emailRef}
          />
          <TextField
            name="password"
            label={REGISTER.passwordLabel}
            type="password"
            autoComplete="new-password"
            hint={REGISTER.passwordHint}
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
            name="passwordConfirmation"
            label={REGISTER.confirmLabel}
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

          <AuthButton type="submit" loading={submitting} loadingLabel={REGISTER.submitting}>
            {REGISTER.submit}
          </AuthButton>
          <p role="status" className="auth-visually-hidden">
            {submitting ? REGISTER.submitting : ""}
          </p>
        </form>
      </AuthCard>
    </AuthLayout>
  );
}
