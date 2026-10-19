import { useEffect, useRef, useState, type FormEvent } from "react";
import { flushSync } from "react-dom";
import { changePassword } from "../api/authApi";
import { INVALID_CURRENT_PASSWORD_CODE, WEAK_PASSWORD_CODE } from "../types/auth";
import { CHANGE_PASSWORD, rateLimitedMessage } from "./authCopy";
import { useAuth } from "./authContext";
import { classifyFailure } from "./authErrors";
import { AuthAlert, AuthButton, AuthStatus, HiddenUsernameField, TextField } from "./AuthUi";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "./validation";

interface FieldErrors {
  current?: string;
  password?: string;
  confirmation?: string;
}

/**
 * Cambio de contraseña dentro de «Mi cuenta» (M3.1-S08, DESIGN §5.16). `POST /api/v1/auth/change-password`: el servidor exige la contraseña actual,
 * rota el SecurityStamp (cierra las demás sesiones) y RE-EMITE la cookie de esta, así que la sesión actual sigue viva.
 *
 * Una contraseña actual incorrecta es un 400 `invalid_current_password` (NUNCA un 401: un 401 aquí significa «ya no hay sesión» y lleva al login con
 * el aviso de sesión terminada, igual que en cualquier otra pantalla protegida). Ninguna contraseña sale de este componente salvo en la petición.
 */
export function ChangePasswordForm({ email }: { email: string | null | undefined }) {
  const { expireSession } = useAuth();

  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [alert, setAlert] = useState<{ text: string; key: number } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const currentRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmationRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);
  const failuresRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => controllerRef.current?.abort(), []);

  // Cualquier cambio en un campo quita el banner de éxito y el error de ese campo.
  const edited = (field: keyof FieldErrors) => {
    setConfirmed(false);
    setErrors((existing) => ({ ...existing, [field]: undefined }));
  };

  const focusField = (field: keyof FieldErrors) => {
    (field === "current" ? currentRef : field === "password" ? passwordRef : confirmationRef).current?.focus();
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submittingRef.current) return;

    const nextErrors: FieldErrors = {};
    if (!current) nextErrors.current = CHANGE_PASSWORD.currentRequired;
    if (password.length > MAX_PASSWORD_LENGTH) nextErrors.password = CHANGE_PASSWORD.passwordLong;
    else if (password.length < MIN_PASSWORD_LENGTH) nextErrors.password = CHANGE_PASSWORD.passwordShort;
    if (!confirmation) nextErrors.confirmation = CHANGE_PASSWORD.confirmRequired;
    else if (confirmation !== password) nextErrors.confirmation = CHANGE_PASSWORD.confirmMismatch;

    const firstInvalid = (["current", "password", "confirmation"] as const).find((field) => nextErrors[field]);
    if (firstInvalid) {
      flushSync(() => {
        setErrors(nextErrors);
        setAlert(null);
        setConfirmed(false);
      });
      focusField(firstInvalid);
      return;
    }

    submittingRef.current = true;
    const controller = new AbortController();
    controllerRef.current = controller;
    // La alerta y la confirmación se desmontan al iniciar el envío para que, si vuelve a fallar con el mismo texto, se anuncie de nuevo.
    setErrors({});
    setAlert(null);
    setConfirmed(false);
    setSubmitting(true);

    try {
      await changePassword({ currentPassword: current, newPassword: password }, controller.signal);
      if (controller.signal.aborted) return;
      // Las tres contraseñas se vacían; el foco se queda en el botón (no se desmonta) y el éxito se anuncia por la región viva.
      flushSync(() => {
        setCurrent("");
        setPassword("");
        setConfirmation("");
        setConfirmed(true);
        setSubmitting(false);
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      const failure = classifyFailure(error);
      setSubmitting(false);

      if (failure.kind === "aborted") return;
      if (failure.kind === "unauthorized") {
        // 401 = ya no hay sesión. La frontera automática no cubre /api/v1/auth/, así que se marca explícitamente: login con aviso `expired`.
        expireSession();
        return;
      }
      if (failure.kind === "badRequest" && failure.code === INVALID_CURRENT_PASSWORD_CODE) {
        flushSync(() => setErrors({ current: CHANGE_PASSWORD.currentIncorrect }));
        focusField("current");
        return;
      }
      if (failure.kind === "badRequest" && failure.code === WEAK_PASSWORD_CODE) {
        flushSync(() => setErrors({ password: failure.message ?? CHANGE_PASSWORD.passwordShort }));
        focusField("password");
        return;
      }

      failuresRef.current += 1;
      const text =
        failure.kind === "network"
          ? CHANGE_PASSWORD.network
          : failure.kind === "forbidden"
            ? CHANGE_PASSWORD.forbidden(failure.status ?? 403)
            : failure.kind === "rateLimited"
              ? rateLimitedMessage(failure.retryAfterSeconds)
              : failure.kind === "badRequest"
                ? CHANGE_PASSWORD.rejected
                : CHANGE_PASSWORD.server(failure.status);
      // Los valores se conservan y el foco se queda donde estaba.
      setAlert({ text, key: failuresRef.current });
    } finally {
      submittingRef.current = false;
    }
  };

  return (
    <form className="profile-form" noValidate aria-busy={submitting ? "true" : "false"} onSubmit={(event) => void handleSubmit(event)}>
      <HiddenUsernameField email={email} />
      {alert && <AuthAlert key={alert.key}>{alert.text}</AuthAlert>}
      <AuthStatus className="profile-status" message={confirmed ? CHANGE_PASSWORD.success : null} />

      <TextField
        name="currentPassword"
        label={CHANGE_PASSWORD.currentLabel}
        type="password"
        autoComplete="current-password"
        hint={CHANGE_PASSWORD.currentHint}
        value={current}
        onChange={(value) => {
          setCurrent(value);
          edited("current");
        }}
        error={errors.current}
        readOnly={submitting}
        inputRef={currentRef}
      />
      <TextField
        name="newPassword"
        label={CHANGE_PASSWORD.newLabel}
        type="password"
        autoComplete="new-password"
        hint={CHANGE_PASSWORD.newHint}
        minLength={MIN_PASSWORD_LENGTH}
        maxLength={MAX_PASSWORD_LENGTH}
        value={password}
        onChange={(value) => {
          setPassword(value);
          edited("password");
        }}
        error={errors.password}
        readOnly={submitting}
        inputRef={passwordRef}
      />
      <TextField
        name="newPasswordConfirmation"
        label={CHANGE_PASSWORD.confirmLabel}
        type="password"
        autoComplete="new-password"
        minLength={MIN_PASSWORD_LENGTH}
        maxLength={MAX_PASSWORD_LENGTH}
        value={confirmation}
        onChange={(value) => {
          setConfirmation(value);
          edited("confirmation");
        }}
        error={errors.confirmation}
        readOnly={submitting}
        inputRef={confirmationRef}
      />

      <div className="profile-actions">
        <AuthButton type="submit" loading={submitting} loadingLabel={CHANGE_PASSWORD.submitting}>
          {CHANGE_PASSWORD.submit}
        </AuthButton>
      </div>

      <p role="status" className="auth-visually-hidden">
        {submitting ? CHANGE_PASSWORD.submitting : ""}
      </p>
    </form>
  );
}
