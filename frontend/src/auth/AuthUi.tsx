import { useId, type ReactNode, type Ref } from "react";
import { BANNERS } from "./authCopy";
import { isPlainLeftClick, navigateAuth, type AuthView } from "./authLocation";
import "./auth.css";

/**
 * Piezas visuales compartidas de las pantallas de autenticación (M3.1-S05, DESIGN.md §5). Reutilizan el lenguaje existente
 * (`status-banner`, `upload-actions__button`) y añaden solo lo imprescindible con prefijo `auth-`.
 */

/** Marco de las pantallas anónimas: header con la marca (párrafo, no enlace) + `<main>` con una tarjeta. */
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="auth-layout">
      <header className="auth-header">
        <p className="auth-brand">VECTORiZE</p>
      </header>
      <main className="auth-main">{children}</main>
    </div>
  );
}

interface AuthCardProps {
  title: string;
  intro?: string;
  headingRef?: Ref<HTMLHeadingElement>;
  children?: ReactNode;
  /** Línea de cambio de pantalla (login <-> registro). */
  footer?: ReactNode;
}

export function AuthCard({ title, intro, headingRef, children, footer }: AuthCardProps) {
  const titleId = useId();
  return (
    <section className="auth-card" aria-labelledby={titleId}>
      <div className="auth-card__head">
        <h1 id={titleId} ref={headingRef} tabIndex={-1}>
          {title}
        </h1>
        {intro && <p className="auth-card__intro">{intro}</p>}
      </div>
      {children}
      {footer && <p className="auth-card__switch">{footer}</p>}
    </section>
  );
}

export type BannerKind = keyof typeof BANNERS;

const BANNER_CLASS: Record<BannerKind, string> = {
  expired: "status-banner--degraded",
  "signed-out": "status-banner--online",
  "signed-out-all": "status-banner--online",
  registered: "status-banner--online",
  "return-info": "auth-banner--info",
};

/** Aviso contextual de la pantalla (máximo uno). Recibe foco por programa (`tabIndex=-1`). */
export function AuthBanner({ kind, bannerRef }: { kind: BannerKind; bannerRef?: Ref<HTMLDivElement> }) {
  return (
    <div ref={bannerRef} className={`status-banner ${BANNER_CLASS[kind]} auth-banner`} role="status" tabIndex={-1}>
      <p>{BANNERS[kind]}</p>
    </div>
  );
}

interface AuthAlertProps {
  children: ReactNode;
  className?: string;
  /** Texto del botón «Cerrar aviso» (variante descartable del menú de usuario). */
  onDismiss?: () => void;
  dismissLabel?: string;
}

/** Error a nivel formulario. Se desmonta al iniciar cada envío y se vuelve a montar si falla, para que se anuncie de nuevo. */
export function AuthAlert({ children, className, onDismiss, dismissLabel }: AuthAlertProps) {
  return (
    <div className={`status-banner status-banner--error auth-alert${className ? ` ${className}` : ""}`} role="alert">
      <p>{children}</p>
      {onDismiss && (
        <AuthButton variant="secondary" onClick={onDismiss}>
          {dismissLabel}
        </AuthButton>
      )}
    </div>
  );
}

interface TextFieldProps {
  name: string;
  label: string;
  type: "email" | "password" | "text";
  autoComplete: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
  hint?: string;
  readOnly?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  minLength?: number;
  maxLength?: number;
  /** Solo `type="text"` (M3.1-S07): por defecto el navegador decide. */
  autoCapitalize?: "none" | "sentences" | "words" | "characters";
  spellCheck?: boolean;
  /** Contador visual (`aria-hidden`) que se pinta a la derecha de la fila inferior, junto al error (M3.1-S07). */
  counter?: ReactNode;
}

export function TextField({
  name,
  label,
  type,
  autoComplete,
  value,
  onChange,
  error,
  hint,
  readOnly,
  inputRef,
  minLength,
  maxLength,
  autoCapitalize,
  spellCheck,
  counter,
}: TextFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;

  return (
    <div className="auth-field">
      <label className="auth-field__label" htmlFor={id}>
        {label}
      </label>
      {hint && (
        <p className="auth-field__hint" id={hintId}>
          {hint}
        </p>
      )}
      <input
        id={id}
        ref={inputRef}
        className="auth-field__input"
        name={name}
        type={type}
        autoComplete={autoComplete}
        autoCapitalize={autoCapitalize ?? (type === "email" ? "none" : undefined)}
        spellCheck={spellCheck ?? (type === "email" ? false : undefined)}
        required
        minLength={minLength}
        maxLength={maxLength}
        value={value}
        readOnly={readOnly}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value)}
      />
      {counter === undefined ? (
        error && (
          <p className="auth-field__error" id={errorId}>
            {error}
          </p>
        )
      ) : (
        <div className="profile-field__meta">
          {error && (
            <p className="auth-field__error" id={errorId}>
              {error}
            </p>
          )}
          {counter}
        </div>
      )}
    </div>
  );
}

interface CheckboxFieldProps {
  name: string;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

export function CheckboxField({ name, label, hint, checked, onChange }: CheckboxFieldProps) {
  const hintId = useId();
  return (
    <div className="auth-checkbox">
      <label className="auth-checkbox__label">
        <input
          type="checkbox"
          name={name}
          checked={checked}
          aria-describedby={hintId}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>{label}</span>
      </label>
      <p className="auth-field__hint" id={hintId}>
        {hint}
      </p>
    </div>
  );
}

interface AuthButtonProps {
  variant?: "primary" | "secondary";
  type?: "submit" | "button";
  loading?: boolean;
  loadingLabel?: string;
  /**
   * Inactivo (M3.1-S07): `aria-disabled` SIN `disabled` (sigue enfocable y el foco no se pierde), clic y Enter ignorados, estilo de deshabilitado,
   * sin spinner. Para «Guardar cambios» sin cambios y «Descartar cambios» durante el guardado.
   */
  inactive?: boolean;
  onClick?: () => void;
  buttonRef?: Ref<HTMLButtonElement>;
  children: ReactNode;
}

/** Botón de auth. En carga NO usa `disabled` (un botón enfocado deshabilitado pierde el foco): usa `aria-disabled` e ignora el clic. */
export function AuthButton({
  variant = "primary",
  type = "button",
  loading = false,
  loadingLabel,
  inactive = false,
  onClick,
  buttonRef,
  children,
}: AuthButtonProps) {
  return (
    <button
      ref={buttonRef}
      type={type}
      className={`auth-button auth-button--${variant}${variant === "secondary" ? " upload-actions__button" : ""}${inactive ? " auth-button--inactive" : ""}`}
      aria-disabled={loading || inactive ? true : undefined}
      onClick={(event) => {
        if (loading || inactive) {
          event.preventDefault();
          return;
        }
        onClick?.();
      }}
    >
      {loading && <span className="auth-button__spinner" aria-hidden="true" />}
      <span>{loading && loadingLabel ? loadingLabel : children}</span>
    </button>
  );
}

interface AuthLinkProps {
  view: AuthView;
  returnUrl: string | null;
  /** Se llama justo antes de navegar (p. ej. para recordar en memoria el registro recibido). */
  onBeforeNavigate?: () => void;
  /** `true`: apariencia de botón primario (panel de registro recibido). */
  asButton?: boolean;
  /** Mueve el foco al `h1` de la pantalla de destino (login <-> registro). */
  focusHeading?: boolean;
  href: string;
  children: ReactNode;
}

/** Enlace real (`<a href>`, abrible en otra pestaña) que navega sin recargar entre vistas de auth, conservando el `returnUrl`. */
export function AuthLink({ view, returnUrl, onBeforeNavigate, asButton, focusHeading, href, children }: AuthLinkProps) {
  return (
    <a
      className={asButton ? "auth-button auth-button--primary" : "auth-link"}
      href={href}
      onClick={(event) => {
        if (!isPlainLeftClick(event)) return;
        event.preventDefault();
        onBeforeNavigate?.();
        navigateAuth(view, returnUrl, { focusHeading });
      }}
    >
      {children}
    </a>
  );
}
