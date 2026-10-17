import { NETWORK_MESSAGE, PENDING_TEXT, SESSION_ERROR, TITLES } from "./authCopy";
import { useAuth } from "./authContext";
import { AuthButton, AuthCard, AuthLayout } from "./AuthUi";
import { useDocumentTitle } from "./useDocumentTitle";

/**
 * Estado `unknown` de la sesión: espera a `GET /api/v1/auth/me` sin mostrar contenido privado NI el login. El texto aparece con 300 ms de
 * retraso (CSS) para que una respuesta rápida no produzca parpadeo.
 */
export function SessionPending() {
  return (
    <main className="auth-pending" aria-busy="true">
      <p role="status" className="auth-pending__text">
        {PENDING_TEXT}
      </p>
    </main>
  );
}

/**
 * Estado `error` de la sesión (red caída o 5xx al consultar `/me`). NO es «sesión cerrada»: no redirige al login ni borra nada, y
 * ofrece reintentar (a mano, o solo al volver la conexión).
 */
export function SessionErrorPanel() {
  const { state, retry, isRetrying } = useAuth();
  const failure = state.status === "error" ? state.failure : { kind: "network" as const, attempt: 0 };
  const cause = failure.kind === "network" ? NETWORK_MESSAGE : SESSION_ERROR.server("httpStatus" in failure ? failure.httpStatus : undefined);

  useDocumentTitle(TITLES.sessionError);

  return (
    <AuthLayout>
      <AuthCard title={TITLES.sessionError}>
        {/* La causa se remonta en cada fallo (key) para que el lector de pantalla la anuncie de nuevo aunque el texto sea idéntico. */}
        <p role="alert" key={failure.attempt}>
          {cause}
        </p>
        <p className="auth-card__intro">{SESSION_ERROR.clarification}</p>
        <AuthButton loading={isRetrying} loadingLabel={SESSION_ERROR.retrying} onClick={retry}>
          {SESSION_ERROR.retry}
        </AuthButton>
      </AuthCard>
    </AuthLayout>
  );
}
