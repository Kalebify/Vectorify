import { useEffect, useRef, useState, type FormEvent } from "react";
import { flushSync } from "react-dom";
import { buildAuthSearch, readReturnUrl, wantsHeadingFocus } from "./authLocation";
import { FORBIDDEN_MESSAGE, LOGIN, NETWORK_MESSAGE, RATE_LIMITED_MESSAGE, TITLES } from "./authCopy";
import { useAuth } from "./authContext";
import { classifyFailure } from "./authErrors";
import {
  AuthAlert,
  AuthBanner,
  AuthButton,
  AuthCard,
  AuthHelpLinks,
  AuthLayout,
  AuthLink,
  CheckboxField,
  TextField,
  type BannerKind,
} from "./AuthUi";
import { useDocumentTitle } from "./useDocumentTitle";
import { isValidEmailFormat } from "./validation";

type LoginAlert = "credentials" | "network" | "server" | "forbidden" | "rate-limited";

const ALERT_TEXT: Record<LoginAlert, string> = {
  credentials: LOGIN.credentials,
  network: NETWORK_MESSAGE,
  server: LOGIN.server,
  forbidden: FORBIDDEN_MESSAGE,
  "rate-limited": RATE_LIMITED_MESSAGE,
};

interface FieldErrors {
  email?: string;
  password?: string;
}

/** Pantalla de inicio de sesión (`?view=login`). Solo se monta con la sesión resuelta como «no autenticado». */
export function LoginScreen({ search }: { search: string }) {
  const { notice, prefillEmail, signIn } = useAuth();
  const returnUrl = readReturnUrl(search);
  const bannerKind: BannerKind | null = notice ?? (returnUrl ? "return-info" : null);

  const [email, setEmail] = useState(prefillEmail ?? "");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [alert, setAlert] = useState<LoginAlert | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const headingRef = useRef<HTMLHeadingElement>(null);
  const bannerRef = useRef<HTMLDivElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);

  useDocumentTitle(TITLES.login);

  // Foco al llegar (DESIGN §9.3): con un aviso en memoria, el aviso; si no, al encabezado solo tras una navegación interna.
  useEffect(() => {
    if (notice) {
      bannerRef.current?.focus();
    } else if (wantsHeadingFocus()) {
      headingRef.current?.focus();
    }
    // Solo al montar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submittingRef.current) return;

    const trimmedEmail = email.trim();
    const nextErrors: FieldErrors = {};
    if (!trimmedEmail) nextErrors.email = LOGIN.emailRequired;
    else if (!isValidEmailFormat(trimmedEmail)) nextErrors.email = LOGIN.emailInvalid;
    if (!password) nextErrors.password = LOGIN.passwordRequired;

    if (nextErrors.email || nextErrors.password) {
      flushSync(() => {
        setErrors(nextErrors);
        setAlert(null);
      });
      (nextErrors.email ? emailRef : passwordRef).current?.focus();
      return;
    }

    submittingRef.current = true;
    const controller = new AbortController();
    controllerRef.current = controller;
    // La alerta se desmonta al iniciar el envío para que, si vuelve a fallar con el mismo texto, se anuncie de nuevo.
    setErrors({});
    setAlert(null);
    setSubmitting(true);

    try {
      await signIn({ email: trimmedEmail, password, rememberMe }, controller.signal);
      // Éxito: el estado de sesión cambió y AppRoot lleva al returnUrl validado (o a Mis proyectos); esta pantalla se desmonta.
    } catch (error) {
      if (controller.signal.aborted) return;
      const failure = classifyFailure(error);
      // La contraseña NO se borra y el foco se queda donde estaba.
      setAlert(
        failure.kind === "network"
          ? "network"
          : failure.kind === "unauthorized" || failure.kind === "badRequest"
            ? "credentials"
            : failure.kind === "forbidden"
              ? "forbidden"
              : failure.kind === "rateLimited"
                ? "rate-limited"
                : "server",
      );
    } finally {
      submittingRef.current = false;
      if (!controller.signal.aborted) setSubmitting(false);
    }
  };

  return (
    <AuthLayout>
      <AuthCard
        title={TITLES.login}
        intro={LOGIN.intro}
        headingRef={headingRef}
        footer={
          <>
            {LOGIN.switchPrompt}{" "}
            <AuthLink
              view="register"
              returnUrl={returnUrl}
              href={buildAuthSearch("register", returnUrl)}
              focusHeading
            >
              {LOGIN.switchLink}
            </AuthLink>
          </>
        }
      >
        {bannerKind && <AuthBanner kind={bannerKind} bannerRef={bannerRef} />}

        <form className="auth-form" noValidate aria-busy={submitting} onSubmit={handleSubmit}>
          {alert && <AuthAlert>{ALERT_TEXT[alert]}</AuthAlert>}

          <TextField
            name="email"
            label={LOGIN.emailLabel}
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
            label={LOGIN.passwordLabel}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(value) => {
              setPassword(value);
              setErrors((current) => ({ ...current, password: undefined }));
            }}
            error={errors.password}
            readOnly={submitting}
            inputRef={passwordRef}
          />
          <CheckboxField
            name="rememberMe"
            label={LOGIN.rememberLabel}
            hint={LOGIN.rememberHint}
            checked={rememberMe}
            onChange={setRememberMe}
          />

          <AuthButton type="submit" loading={submitting} loadingLabel={LOGIN.submitting}>
            {LOGIN.submit}
          </AuthButton>
          <p role="status" className="auth-visually-hidden">
            {submitting ? LOGIN.submitting : ""}
          </p>
        </form>

        {/* Las salidas para quien no puede entrar van DESPUÉS del formulario (M3.1-S08): Enter en la contraseña sigue enviando y el orden de Tab no se interrumpe. */}
        <AuthHelpLinks returnUrl={returnUrl} email={email} />
      </AuthCard>
    </AuthLayout>
  );
}
