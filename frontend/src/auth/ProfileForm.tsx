import { useEffect, useRef, useState, type FormEvent } from "react";
import { flushSync } from "react-dom";
import { updateProfile } from "../api/profileApi";
import { INVALID_DISPLAY_NAME_CODE } from "../types/profile";
import { PROFILE, RATE_LIMITED_MESSAGE } from "./authCopy";
import { classifyFailure } from "./authErrors";
import { AuthAlert, AuthButton, TextField } from "./AuthUi";
import { MAX_DISPLAY_NAME_LENGTH, checkDisplayName } from "./validation";

interface ProfileFormProps {
  /** Último nombre confirmado por el servidor. */
  initialName: string;
  /** Se llama con el nombre que el servidor confirmó (ya recortado) tras un guardado correcto. */
  onSaved: (displayName: string) => void;
}

interface FormAlert {
  text: string;
  /** Número de fallo: remonta el aviso para que se anuncie de nuevo aunque el texto se repita. */
  key: number;
}

function validationMessage(trimmed: string): string | null {
  const problem = checkDisplayName(trimmed);
  if (problem === null) return null;
  if (problem.kind === "required") return PROFILE.validation.required;
  if (problem.kind === "tooLong") return PROFILE.validation.tooLong(problem.length);
  return PROFILE.validation.controlCharacters;
}

/**
 * Formulario del nombre para mostrar (M3.1-S07, DESIGN §5.6): envía SOLO `{ displayName }` con `PATCH /api/v1/me`. Valida al enviar (nunca
 * mientras se escribe), conserva lo escrito ante cualquier fallo, y un 401 lo resuelve la frontera global de sesión (aquí no hay UI para él).
 */
export function ProfileForm({ initialName, onSaved }: ProfileFormProps) {
  const [saved, setSaved] = useState(initialName);
  const [draft, setDraft] = useState(initialName);
  const [saving, setSaving] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [alert, setAlert] = useState<FormAlert | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [discarded, setDiscarded] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const discardRef = useRef<HTMLButtonElement>(null);
  const savingRef = useRef(false);
  const failuresRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const trimmed = draft.trim();
  const hasChanges = trimmed !== saved;

  const clearFeedback = () => {
    setFieldError(null);
    setAlert(null);
    setConfirmed(false);
    setDiscarded(false);
  };

  const focusInput = () => inputRef.current?.focus();

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (savingRef.current || !hasChanges) return;

    const message = validationMessage(trimmed);
    if (message) {
      flushSync(() => {
        setFieldError(message);
        setAlert(null);
        setConfirmed(false);
        setDiscarded(false);
      });
      focusInput();
      return;
    }

    savingRef.current = true;
    const controller = new AbortController();
    controllerRef.current = controller;
    // La alerta y la confirmación se desmontan al iniciar el envío para que, si vuelve a fallar con el mismo texto, se anuncie de nuevo.
    clearFeedback();
    setSaving(true);

    try {
      const profile = await updateProfile({ displayName: trimmed }, controller.signal);
      if (controller.signal.aborted) return;
      const wasOnDiscard = document.activeElement === discardRef.current;
      flushSync(() => {
        setSaved(profile.displayName);
        setDraft(profile.displayName);
        setConfirmed(true);
        setSaving(false);
      });
      // «Descartar cambios» desaparece: si tenía el foco, pasa al campo. En cualquier otro caso el foco no se mueve.
      if (wasOnDiscard) focusInput();
      onSaved(profile.displayName);
    } catch (error) {
      if (controller.signal.aborted) return;
      const failure = classifyFailure(error);
      setSaving(false);
      if (failure.kind === "aborted" || failure.kind === "unauthorized") {
        // 401: la frontera global de sesión lleva al login; no hay UI propia.
        return;
      }
      if (failure.kind === "badRequest" && failure.code === INVALID_DISPLAY_NAME_CODE) {
        flushSync(() => setFieldError(failure.message ?? PROFILE.validation.required));
        focusInput();
        return;
      }
      failuresRef.current += 1;
      const text =
        failure.kind === "network"
          ? PROFILE.saveError.network
          : failure.kind === "forbidden"
            ? PROFILE.saveError.forbidden(failure.status ?? 403)
            : failure.kind === "rateLimited"
              ? RATE_LIMITED_MESSAGE
              : failure.kind === "badRequest"
                ? PROFILE.saveError.badRequest
                : PROFILE.saveError.server(failure.status);
      // El foco se queda donde estaba y lo escrito se conserva tal cual.
      setAlert({ text, key: failuresRef.current });
    } finally {
      savingRef.current = false;
    }
  };

  const handleDiscard = () => {
    if (savingRef.current) return;
    flushSync(() => {
      setDraft(saved);
      setFieldError(null);
      setAlert(null);
      setConfirmed(false);
      setDiscarded(true);
    });
    focusInput();
  };

  const count = trimmed.length;
  const overLimit = count > MAX_DISPLAY_NAME_LENGTH;
  const showDiscard = hasChanges || saving;

  return (
    <form className="profile-form" noValidate aria-busy={saving ? "true" : "false"} onSubmit={(event) => void handleSubmit(event)}>
      {alert && <AuthAlert key={alert.key}>{alert.text}</AuthAlert>}

      {/* Región viva persistente: el rol lo tiene el contenedor (siempre en el DOM) y el banner solo aparece tras guardar. */}
      <div className="profile-status" role="status" aria-live="polite">
        {confirmed && (
          <div className="status-banner status-banner--online auth-banner">
            <p>{PROFILE.saved}</p>
          </div>
        )}
      </div>

      <TextField
        name="displayName"
        label={PROFILE.field.label}
        type="text"
        autoComplete="nickname"
        autoCapitalize="words"
        spellCheck={false}
        hint={PROFILE.field.hint}
        value={draft}
        onChange={(value) => {
          setDraft(value);
          clearFeedback();
        }}
        error={fieldError}
        readOnly={saving}
        inputRef={inputRef}
        counter={
          <p className={`profile-field__count${overLimit ? " profile-field__count--over" : ""}`} aria-hidden="true">
            {count}/{MAX_DISPLAY_NAME_LENGTH}
          </p>
        }
      />

      <div className="profile-actions">
        <AuthButton type="submit" loading={saving} loadingLabel={PROFILE.saving} inactive={!saving && !hasChanges}>
          {PROFILE.save}
        </AuthButton>
        {showDiscard && (
          <AuthButton variant="secondary" buttonRef={discardRef} inactive={saving} onClick={handleDiscard}>
            {PROFILE.discard}
          </AuthButton>
        )}
      </div>

      <p role="status" className="auth-visually-hidden">
        {saving ? PROFILE.saving : discarded ? PROFILE.discarded : ""}
      </p>
    </form>
  );
}
