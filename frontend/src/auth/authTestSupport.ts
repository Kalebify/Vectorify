import {
  installProjectsApi,
  jsonResponse,
  makeProject,
  type RecordedCall,
} from "../components/projects/projectsTestSupport";
import type { ProjectSummary } from "../types/projectsV2";
import type { CurrentUser } from "../types/auth";

/**
 * Backend de juguete para los tests de autenticación (M3.1-S05): endpoints `/api/v1/auth/*` con una sesión en memoria + el backend v2 de
 * Mis proyectos de `projectsTestSupport` + los endpoints clásicos que necesita la reapertura de un Workspace. Sin sesión, los endpoints
 * de producto responden 401, igual que el servidor real (`UnauthenticatedUserMiddleware`), de modo que el evento «sesión expirada» de
 * S04 se dispara de verdad desde `httpClient`.
 */

export const ANA: CurrentUser = {
  id: "6f1c2a52-9a52-4fd8-9d9f-0a8c0f6d1c11",
  email: "ana@vectorify.test",
  displayName: "Ana Gómez",
  authMode: "Authenticated",
};

export const DEV_USER: CurrentUser = {
  id: "00000000-0000-0000-0000-000000000001",
  email: "dev@vectorify.local",
  displayName: "Dev User",
  authMode: "Development",
};

export const GOOD_PASSWORD = "una-contrasena-larga-1";

export type MeBehavior = "session" | "network" | number;

export interface AuthBackendOptions {
  /** Usuario con sesión viva al arrancar, o null (sin cookie). */
  user?: CurrentUser | null;
  projects?: ProjectSummary[];
  /** Cómo responde `GET /me`: según la sesión (default), con red caída, o con un código HTTP fijo. */
  me?: MeBehavior;
  /** Respuesta de `POST /register`. */
  register?: (call: RecordedCall) => Response | Promise<Response>;
  /** Respuesta de `POST /logout`. */
  logout?: () => Response | Promise<Response>;
  /** Respuesta de `POST /logout-all`. */
  logoutAll?: () => Response | Promise<Response>;
  /** Respuesta de `POST /login`. */
  login?: (call: RecordedCall) => Response | Promise<Response>;
  /** Recuperación (M3.1-S08). Por defecto: forgot/resend = 202 uniforme; reset/confirm/change-password = 204. */
  forgot?: (call: RecordedCall) => Response | Promise<Response>;
  reset?: (call: RecordedCall) => Response | Promise<Response>;
  confirm?: (call: RecordedCall) => Response | Promise<Response>;
  resend?: (call: RecordedCall) => Response | Promise<Response>;
  changePassword?: (call: RecordedCall) => Response | Promise<Response>;
  /** Estado de `GET /document` de un proyecto guardado. */
  documentStatus?: number;
  /** Código HTTP con el que responde `GET /api/v2/projects` (para probar 403/5xx en pantallas de producto con sesión viva). */
  projectsStatus?: number;
  /** Retiene la respuesta de `/me` o de `/login` hasta que se resuelva la promesa (estado «cargando» / «enviando»). */
  gates?: {
    me?: Promise<void>;
    login?: Promise<void>;
    profile?: Promise<void>;
    profileSave?: Promise<void>;
    forgot?: Promise<void>;
    reset?: Promise<void>;
    confirm?: Promise<void>;
    resend?: Promise<void>;
    changePassword?: Promise<void>;
  };
  /** Perfil (M3.1-S07): `GET /api/v1/me` y `PATCH /api/v1/me`. Por defecto, un perfil en memoria que valida como el servidor. */
  profile?: {
    /** Sobrescribe `GET /api/v1/me` (red caída, 5xx, 403...). Devolver `undefined` usa el perfil en memoria. */
    get?: (call: RecordedCall) => Response | Promise<Response> | undefined;
    /** Sobrescribe `PATCH /api/v1/me`. Devolver `undefined` usa el perfil en memoria. */
    patch?: (call: RecordedCall) => Response | Promise<Response> | undefined;
    email?: string | null;
    createdAt?: string | null;
  };
}

const IMAGE_ID_PATTERN = /\/api\/v1\/projects\/([^/]+)\/images\/([^/]+)$/;

export function networkFailure(): Promise<Response> {
  return Promise.reject(new TypeError("Failed to fetch"));
}

export function installAuthBackend(options: AuthBackendOptions = {}) {
  const session = { user: options.user === undefined ? ANA : options.user, me: options.me ?? ("session" as MeBehavior) };
  const authCalls: RecordedCall[] = [];
  const profileCalls: RecordedCall[] = [];
  let storedName: string | null = null;

  const override = (call: RecordedCall): Response | Promise<Response> | undefined => {
    if (call.path.startsWith("/api/v1/auth/")) {
      authCalls.push(call);

      if (call.method === "GET" && call.path === "/api/v1/auth/me") {
        const respond = (): Response | Promise<Response> => {
          if (session.me === "network") return networkFailure();
          if (typeof session.me === "number") return jsonResponse({ code: "server_error", message: "x" }, session.me);
          return session.user ? jsonResponse(session.user) : jsonResponse({}, 401);
        };
        return options.gates?.me ? options.gates.me.then(respond) : respond();
      }

      if (call.path === "/api/v1/auth/login") {
        const respond = (): Response | Promise<Response> => {
          if (options.login) return options.login(call);
          const body = call.body as { email?: string; password?: string };
          if (body.email === ANA.email && body.password === GOOD_PASSWORD) {
            session.user = ANA;
            return jsonResponse(ANA);
          }
          return jsonResponse({ code: "invalid_credentials", message: "Correo o contraseña incorrectos." }, 401);
        };
        return options.gates?.login ? options.gates.login.then(respond) : respond();
      }

      if (call.path === "/api/v1/auth/register") {
        return options.register ? options.register(call) : jsonResponse({ status: "accepted" }, 202);
      }

      const recovery: Record<string, [keyof NonNullable<AuthBackendOptions["gates"]>, ((call: RecordedCall) => Response | Promise<Response>) | undefined, () => Response]> = {
        "/api/v1/auth/forgot-password": ["forgot", options.forgot, () => jsonResponse({ status: "accepted" }, 202)],
        "/api/v1/auth/reset-password": ["reset", options.reset, () => new Response(null, { status: 204 })],
        "/api/v1/auth/confirm-email": ["confirm", options.confirm, () => new Response(null, { status: 204 })],
        "/api/v1/auth/resend-confirmation": ["resend", options.resend, () => jsonResponse({ status: "accepted" }, 202)],
        "/api/v1/auth/change-password": ["changePassword", options.changePassword, () => new Response(null, { status: 204 })],
      };
      const recoveryRoute = recovery[call.path];
      if (recoveryRoute && call.method === "POST") {
        const [gate, custom, fallback] = recoveryRoute;
        const respond = (): Response | Promise<Response> => (custom ? custom(call) : fallback());
        return options.gates?.[gate] ? options.gates[gate].then(respond) : respond();
      }

      if (call.path === "/api/v1/auth/logout") {
        if (options.logout) return options.logout();
        session.user = null;
        return new Response(null, { status: 204 });
      }

      if (call.path === "/api/v1/auth/logout-all") {
        if (options.logoutAll) return options.logoutAll();
        if (!session.user) return jsonResponse({}, 401);
        session.user = null;
        return new Response(null, { status: 204 });
      }

      return jsonResponse({ code: "not_found", message: "x" }, 404);
    }

    // Endpoints de producto: sin sesión (modo Authenticated) = 401, como el servidor real.
    if (!session.user) {
      return jsonResponse({ code: "unauthenticated", message: "Necesitás iniciar sesión para usar este recurso." }, 401);
    }

    if (call.path === "/api/v1/me") {
      profileCalls.push(call);
      const user = session.user;
      const profileOf = (): Response => {
        const profile = options.profile;
        const body: Record<string, unknown> = {
          id: user.id,
          email: profile?.email === undefined ? user.email : profile.email,
          displayName: storedName ?? user.displayName,
          managedFields: ["email"],
        };
        if (profile?.createdAt !== null) body.createdAt = profile?.createdAt ?? "2026-10-15T14:32:00Z";
        return jsonResponse(body);
      };
      if (call.method === "GET") {
        const overridden = options.profile?.get?.(call);
        if (overridden) return overridden;
        return options.gates?.profile ? options.gates.profile.then(profileOf) : profileOf();
      }
      if (call.method === "PATCH") {
        const overridden = options.profile?.patch?.(call);
        if (overridden) return overridden;
        const respond = (): Response => {
          const requested = (call.body as { displayName?: unknown } | undefined)?.displayName;
          const name = typeof requested === "string" ? requested.trim() : "";
          if (name.length < 1 || name.length > 80) {
            return jsonResponse({ code: "invalid_display_name", message: "El nombre para mostrar debe tener entre 1 y 80 caracteres." }, 400);
          }
          storedName = name;
          return profileOf();
        };
        return options.gates?.profileSave ? options.gates.profileSave.then(respond) : respond();
      }
    }

    if (options.projectsStatus && call.method === "GET" && call.path === "/api/v2/projects") {
      return jsonResponse({ code: "x", message: "x" }, options.projectsStatus);
    }

    if (/\/system\/health$/.test(call.path)) {
      return jsonResponse({
        status: "online",
        timestamp: new Date().toISOString(),
        api: { status: "online" },
        python: { status: "online", service: "vectorify-python-engine", version: "0.1.0", message: null },
      });
    }

    const imageMatch = IMAGE_ID_PATTERN.exec(call.path);
    if (imageMatch) {
      return jsonResponse({
        projectId: imageMatch[1],
        imageId: imageMatch[2],
        filename: "logo.png",
        mimeType: "image/png",
        bytes: 4096,
        width: 320,
        height: 240,
        status: "uploaded",
      });
    }

    if (/^\/api\/v2\/projects\/[^/]+\/document$/.test(call.path)) {
      return options.documentStatus && options.documentStatus !== 200
        ? jsonResponse({ code: "not_found", message: "No existe." }, options.documentStatus)
        : jsonResponse({ layers: [] });
    }

    if (/\/color-palette\/[^/]+$/.test(call.path)) {
      return jsonResponse({
        projectId: "p",
        imageId: "i",
        paletteId: "pal",
        version: 1,
        tolerance: 24,
        maxColors: null,
        tinyAreaRatio: 0.01,
        sourceWidthPx: 320,
        sourceHeightPx: 240,
        transparentPercent: 0,
        groups: [],
        previewUrl: "/preview",
        isConfirmed: true,
        cached: false,
      });
    }

    return undefined;
  };

  const api = installProjectsApi(options.projects ?? [makeProject(1, { name: "Llavero" })], override);

  return {
    ...api,
    session,
    authCalls,
    profileCalls,
    profileCallsTo: (method: string) => profileCalls.filter((call) => call.method === method),
    authCallsTo: (method: string, path: string) =>
      authCalls.filter((call) => call.method === method && call.path === path),
  };
}

/** Deja la URL y el almacenamiento como los espera un test de la app. */
export function resetBrowserState(url = "/") {
  window.history.pushState({}, "", url);
  window.localStorage.clear();
}

/** Promesa que se resuelve a mano: sirve para retener una respuesta de red y observar el estado intermedio. */
export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
