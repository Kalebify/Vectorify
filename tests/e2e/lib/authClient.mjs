// Cliente HTTP de AUTENTICACIÓN para los E2E de Node (M3.1-S10), sin dependencias: `fetch` global (Node >= 22) + un cookie jar propio.
// Lo usan tests/e2e/mvp31_auth_e2e_test.mjs (los 9 escenarios de la tarjeta) y, con E2E_AUTH=1, los E2E anónimos de siempre
// (`enableAuthFromEnv`, ver abajo).
//
// Qué hace por una persona usuaria / navegador:
//  * cookie jar: guarda las cookies de `Set-Cookie` (respeta Max-Age=0 / Expires pasado como borrado) y las reenvía en cada petición;
//  * cabeceras que el frontend real manda en toda petición no segura en modo Authenticated (CsrfGuard): `X-Vectorify-Request: 1` y un `Origin` permitido;
//  * register / login / logout / logout-all / me, y lectura del correo en Mailpit (perfil `mail-sink` del compose).
//
// Un AuthClient = un «navegador»: dos instancias son dos personas (o la misma cuenta en dos dispositivos) sin cookies compartidas.

import { randomBytes } from "node:crypto";

export const DEFAULT_PASSWORD = "una-contrasena-larga-1";

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export { sleepMs as sleep };

/** Correo único por ejecución y por cuenta (sufijo aleatorio): una pila reutilizada nunca choca con cuentas de corridas anteriores. */
export function uniqueEmail(label = "e2e") {
  return `${label}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}@vectorify.test`;
}

/** Interpreta un `Set-Cookie` y devuelve { name, value, deleted, maxAge, expires, attrs }. */
export function parseSetCookie(header) {
  const [pair, ...attributes] = header.split(";").map((part) => part.trim());
  const eq = pair.indexOf("=");
  const name = pair.slice(0, eq);
  const value = pair.slice(eq + 1);
  const attrs = {};
  for (const attribute of attributes) {
    const i = attribute.indexOf("=");
    const key = (i < 0 ? attribute : attribute.slice(0, i)).toLowerCase();
    attrs[key] = i < 0 ? true : attribute.slice(i + 1);
  }
  const maxAge = attrs["max-age"] !== undefined ? Number(attrs["max-age"]) : null;
  const expires = attrs.expires ? new Date(attrs.expires) : null;
  const deleted = value === "" || (maxAge !== null && maxAge <= 0) || (expires !== null && expires.getTime() <= Date.now());
  return { name, value, deleted, maxAge, expires, attrs };
}

export class AuthClient {
  /**
   * @param {object} options
   * @param {string} options.api       origen de la API, p. ej. http://localhost:32080
   * @param {string} options.origin    origen de la SPA permitido por CORS (el `Origin` que mandaría el navegador), p. ej. http://localhost:32173
   * @param {string} [options.label]   nombre para los mensajes
   */
  constructor({ api, origin, label = "cliente" }) {
    this.api = api.replace(/\/$/, "");
    this.origin = origin;
    this.label = label;
    this.jar = new Map();
    /** Todos los `Set-Cookie` recibidos en la última respuesta (ya interpretados). */
    this.lastSetCookies = [];
  }

  /** Valor de la cookie de sesión actual (la única cookie del sitio) o null. */
  get sessionCookie() {
    const [first] = this.jar.entries();
    return first ? { name: first[0], value: first[1] } : null;
  }

  cookieHeader() {
    return [...this.jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  /** Copia del jar (para «robar» o «copiar» una cookie a otro cliente/dispositivo). */
  snapshotCookies() {
    return new Map(this.jar);
  }

  /** Sustituye el jar por una copia dada. */
  loadCookies(cookies) {
    this.jar = new Map(cookies);
  }

  clearCookies() {
    this.jar.clear();
  }

  absorb(response) {
    this.lastSetCookies = (response.headers.getSetCookie?.() ?? []).map(parseSetCookie);
    for (const cookie of this.lastSetCookies) {
      if (cookie.deleted) this.jar.delete(cookie.name);
      else this.jar.set(cookie.name, cookie.value);
    }
  }

  /**
   * Petición genérica. `json` ⇒ cuerpo JSON; `body` ⇒ cuerpo tal cual (FormData, string...).
   * Opciones: `csrf` (por defecto true: cabecera anti-CSRF + Origin), `origin` (otro Origin), `csrfHeader` (false para omitir solo la cabecera),
   * `cookies` (false: no enviar el jar), `cookie` (valor crudo de la cabecera Cookie en lugar del jar), `headers` extra, `raw` (devolver los bytes).
   */
  async request(method, path, options = {}) {
    const { json, body, csrf = true, csrfHeader = true, origin = this.origin, cookies = true, cookie, headers = {}, raw = false } = options;
    const requestHeaders = { ...headers };
    if (csrf) {
      if (csrfHeader) requestHeaders["X-Vectorify-Request"] = "1";
      if (origin) requestHeaders.Origin = origin;
    }
    const cookieValue = cookie ?? (cookies ? this.cookieHeader() : "");
    if (cookieValue) requestHeaders.Cookie = cookieValue;
    let payload;
    if (json !== undefined) {
      requestHeaders["Content-Type"] = "application/json";
      payload = JSON.stringify(json);
    } else if (body !== undefined) {
      payload = body;
    }
    const response = await fetch(`${this.api}${path}`, { method, headers: requestHeaders, body: payload, redirect: "manual" });
    if (cookie === undefined && cookies) this.absorb(response);
    else this.lastSetCookies = (response.headers.getSetCookie?.() ?? []).map(parseSetCookie);
    const bytes = Buffer.from(await response.arrayBuffer());
    const text = raw ? "" : bytes.toString("utf8");
    let parsed = null;
    if (!raw && text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    return { status: response.status, headers: response.headers, body: parsed, text, bytes: raw ? bytes : undefined, ok: response.ok };
  }

  get(path, options) {
    return this.request("GET", path, options);
  }

  post(path, json, options = {}) {
    return this.request("POST", path, { ...options, json: json ?? options.json });
  }

  async register(email, password = DEFAULT_PASSWORD) {
    return this.request("POST", "/api/v1/auth/register", { json: { email, password } });
  }

  async login(email, password = DEFAULT_PASSWORD, { rememberMe } = {}) {
    const json = { email, password };
    if (rememberMe !== undefined) json.rememberMe = rememberMe;
    return this.request("POST", "/api/v1/auth/login", { json });
  }

  async logout() {
    return this.request("POST", "/api/v1/auth/logout");
  }

  async logoutAll() {
    return this.request("POST", "/api/v1/auth/logout-all");
  }

  async me(options) {
    return this.request("GET", "/api/v1/auth/me", options);
  }

  /** Registra y abre sesión; lanza si algo no es 202/200. Devuelve el usuario actual (`/auth/me`). */
  async registerAndLogin(email = uniqueEmail(this.label), password = DEFAULT_PASSWORD, options = {}) {
    const registered = await this.register(email, password);
    if (registered.status !== 202) throw new Error(`[${this.label}] registro de ${email}: ${registered.status} ${registered.text}`);
    const login = await this.login(email, password, options);
    if (login.status !== 200) throw new Error(`[${this.label}] login de ${email}: ${login.status} ${login.text}`);
    return { email, password, user: login.body };
  }
}

// ---------------------------------------------------------------------------------------------------------------- Mailpit

/** Cliente mínimo de la API HTTP de Mailpit (sumidero de correo del perfil `mail-sink`). */
export class Mailpit {
  constructor(baseUrl) {
    this.base = baseUrl.replace(/\/$/, "");
  }

  async list() {
    const response = await fetch(`${this.base}/api/v1/messages?limit=200`);
    if (!response.ok) throw new Error(`Mailpit ${this.base}: ${response.status}`);
    return (await response.json()).messages ?? [];
  }

  /**
   * Espera un mensaje PARA `to` (opcionalmente con `subject` regex o cuyo cuerpo de texto contenga `contains`) que no esté en `exclude` (ids ya vistos).
   * Devuelve { id, subject, text, html, from }.
   */
  async waitForMessage({ to, subject, contains, exclude = new Set(), timeout = 20000 }) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const candidates = (await this.list()).filter(
        (m) => !exclude.has(m.ID) && (m.To ?? []).some((a) => a.Address.toLowerCase() === to.toLowerCase()) && (!subject || subject.test(m.Subject ?? "")),
      );
      for (const candidate of candidates) {
        const detail = await (await fetch(`${this.base}/api/v1/message/${candidate.ID}`)).json();
        const text = detail.Text ?? "";
        if (!contains || text.includes(contains)) {
          return { id: candidate.ID, subject: candidate.Subject, text, html: detail.HTML ?? "", from: detail.From?.Address };
        }
      }
      await sleepMs(300);
    }
    throw new Error(`Mailpit: no llegó ningún correo para ${to}${contains ? ` que contenga «${contains}»` : ""} en ${timeout} ms.`);
  }

  /** Cuenta los mensajes para `to` (para demostrar que NO llegó nada). */
  async countFor(to) {
    return (await this.list()).filter((m) => (m.To ?? []).some((a) => a.Address.toLowerCase() === to.toLowerCase())).length;
  }

  /** Primer enlace del texto del mensaje que contenga `needle` (p. ej. `view=reset-password`). */
  static linkIn(message, needle) {
    const links = message.text.match(/https?:\/\/[^\s<>"']+/g) ?? [];
    const link = links.find((l) => l.includes(needle));
    if (!link) throw new Error(`El correo «${message.subject}» no trae un enlace con ${needle}: ${message.text.slice(0, 300)}`);
    return link;
  }

  /** { email, token } del fragmento de un enlace de restablecimiento (`#email=...&token=...`). */
  static resetParams(link) {
    const hash = new URL(link).hash.replace(/^#/, "");
    const params = new URLSearchParams(hash);
    return { email: params.get("email"), token: params.get("token") };
  }

  /** { userId|email, token } del fragmento de un enlace de confirmación. */
  static confirmParams(link) {
    const params = new URLSearchParams(new URL(link).hash.replace(/^#/, ""));
    return { userId: params.get("userId"), email: params.get("email"), token: params.get("token") };
  }
}

// ---------------------------------------------------------------------------------------------------------------- E2E_AUTH=1

/**
 * Modo opt-in de los E2E anónimos de siempre (mvp3_release, full_pipeline, upload): con `E2E_AUTH=1` registran una cuenta nueva, abren sesión y
 * SUSTITUYEN `globalThis.fetch` por una versión que, solo para peticiones al origen de `api`, añade el cookie jar, `X-Vectorify-Request` y `Origin`
 * (y guarda los `Set-Cookie`). Los scripts siguen usando `fetch(...)` sin saber nada de la sesión. Sin `E2E_AUTH=1` NO hace nada (comportamiento
 * intacto en modo Development). Variables: `E2E_AUTH=1`, `SPA_ORIGIN` (Origin permitido por CORS; por defecto http://localhost:5173),
 * `E2E_EMAIL`/`E2E_PASSWORD` (opcional: usar esa cuenta en lugar de registrar una nueva).
 * Devuelve el AuthClient (o null si no está activado).
 */
export async function enableAuthFromEnv(api) {
  if (process.env.E2E_AUTH !== "1") return null;
  const origin = process.env.SPA_ORIGIN || "http://localhost:5173";
  const client = new AuthClient({ api, origin, label: "e2e-auth" });
  if (process.env.E2E_EMAIL && process.env.E2E_PASSWORD) {
    const login = await client.login(process.env.E2E_EMAIL, process.env.E2E_PASSWORD);
    if (login.status !== 200) throw new Error(`E2E_AUTH=1: login de ${process.env.E2E_EMAIL} falló (${login.status}).`);
  } else {
    await client.registerAndLogin();
  }

  const originalFetch = globalThis.fetch.bind(globalThis);
  const apiBase = api.replace(/\/$/, "");
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(apiBase)) return originalFetch(input, init);
    const headers = new Headers(init.headers ?? (typeof input === "object" && "headers" in input ? input.headers : undefined));
    headers.set("X-Vectorify-Request", "1");
    headers.set("Origin", origin);
    const cookie = client.cookieHeader();
    if (cookie) headers.set("Cookie", cookie);
    const response = await originalFetch(input, { ...init, headers });
    client.absorb(response);
    return response;
  };
  console.log(`E2E_AUTH=1: sesión abierta como ${client.label} contra ${apiBase} (Origin ${origin}); las peticiones a la API llevan cookie + cabecera anti-CSRF.`);
  return client;
}
