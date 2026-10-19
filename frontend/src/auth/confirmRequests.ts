import { confirmEmail } from "../api/authApi";
import { CONFIRM_EMAIL, rateLimitedMessage } from "./authCopy";
import { classifyFailure } from "./authErrors";

export type Outcome = { kind: "success" } | { kind: "invalid" } | { kind: "error"; message: string };

/**
 * Peticiones de confirmación en curso, por token (marca A NIVEL DE MÓDULO, M3.1-S08): el doble montaje de `StrictMode` (montar, desmontar, montar) ejecuta
 * el efecto dos veces, pero el token se envía UNA sola vez; la segunda ejecución se engancha a la misma promesa. Solo vive en memoria de la pestaña.
 */
const inFlight = new Map<string, Promise<Outcome>>();

/** Solo para tests: olvida las confirmaciones en curso. */
export function resetConfirmRequestsForTests(): void {
  inFlight.clear();
}

export function sendConfirmation(link: { token: string; userId: string | null; email: string | null }): Promise<Outcome> {
  const existing = inFlight.get(link.token);
  if (existing) return existing;

  const request = confirmEmail({
    token: link.token,
    ...(link.userId ? { userId: link.userId } : { email: link.email ?? undefined }),
  }).then(
    (): Outcome => ({ kind: "success" }),
    (error: unknown): Outcome => {
      const failure = classifyFailure(error);
      if (failure.kind === "badRequest" || failure.kind === "unauthorized") return { kind: "invalid" };
      return {
        kind: "error",
        message:
          failure.kind === "network"
            ? CONFIRM_EMAIL.pending.network
            : failure.kind === "forbidden"
              ? CONFIRM_EMAIL.pending.forbidden
              : failure.kind === "rateLimited"
                ? rateLimitedMessage(failure.retryAfterSeconds)
                : CONFIRM_EMAIL.pending.server,
      };
    },
  );
  inFlight.set(link.token, request);
  // Resuelta la petición (con éxito, enlace no válido o fallo recuperable) se olvida: el token no se retiene y «Reintentar» vuelve a enviar.
  void request.then(() => inFlight.delete(link.token));
  return request;
}
