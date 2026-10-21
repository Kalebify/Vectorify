// E2E HTTP de AUTENTICACIÓN y MULTIUSUARIO de MVP 3.1 (M3.1-S10): los 9 escenarios de la tarjeta contra el `docker compose` REAL (Postgres, motor Python,
// Web API en Auth:Mode=Authenticated, nginx y Mailpit del perfil `mail-sink`). No arranca la pila: la asume corriendo (ver tests/e2e/mvp31_stack.sh).
//
//   1  Registrar User A                                   6  Acceso directo a ids/assets/versiones/exports de A como B (y anónimo) -> denegado
//   2  Crear Project A y editarlo                         6b Cookie manipulada -> 401          6c CSRF negativo -> 403
//   3  Logout / Login y recuperar Project A               7  Caducidad y renovación de la sesión (tiempos cortos de la pila)
//   4  Registrar User B                                   8  Logout efectivo (incl. «cerrar sesión en todos lados»)
//   5  B no ve el Project A (listado, búsqueda, detalle)  9  Recuperación de acceso extremo a extremo (olvidé -> correo -> restablecer ...)
//
// Cada escenario imprime sus comprobaciones y un veredicto; al final hay un resumen y el código de salida es != 0 si CUALQUIER escenario falla.
// Cuentas distintas por ejecución (correo con sufijo aleatorio). Variables (todas con el valor por defecto de tests/e2e/mvp31_stack.sh):
//   API_URL=http://localhost:32080  SPA_ORIGIN=http://localhost:32173  MAILPIT_URL=http://localhost:32025
//   E2E_COOKIE_LIFETIME_SECONDS=20  E2E_REMEMBER_ME_LIFETIME_SECONDS=45  E2E_REVALIDATION_SECONDS=3   (deben coincidir con la configuración de la pila)
//   E2E_ONLY=1,2,6  (ejecuta solo esos escenarios; los dependientes arrastran sus requisitos)

import { AuthClient, DEFAULT_PASSWORD, Mailpit, sleep, uniqueEmail } from "./lib/authClient.mjs";
import { buildEditorPayload, createFullProject, uploadFixture } from "./lib/projectWorld.mjs";

const API = (process.env.API_URL || process.env.BACKEND_URL || "http://localhost:32080").replace(/\/$/, "");
const ORIGIN = (process.env.SPA_ORIGIN || "http://localhost:32173").replace(/\/$/, "");
const MAILPIT = new Mailpit(process.env.MAILPIT_URL || "http://localhost:32025");
const LIFETIME = Number(process.env.E2E_COOKIE_LIFETIME_SECONDS || 20);
const REMEMBER = Number(process.env.E2E_REMEMBER_ME_LIFETIME_SECONDS || 45);
const REVALIDATION = Number(process.env.E2E_REVALIDATION_SECONDS || 3);
const ONLY = (process.env.E2E_ONLY || "").split(",").map((s) => s.trim()).filter(Boolean);

const newClient = (label) => new AuthClient({ api: API, origin: ORIGIN, label });

class CheckFailed extends Error {}
let checks = 0;
let currentLog = [];

function check(condition, message) {
  checks++;
  if (!condition) throw new CheckFailed(message);
}

function note(message) {
  currentLog.push(`      · ${message}`);
}

function expectStatus(response, status, what) {
  check(response.status === status, `${what}: esperaba ${status}, fue ${response.status} (${response.text.slice(0, 200)})`);
}

/** Todo lo observable de una respuesta salvo lo que cambia por petición (fecha, correlation id). */
function signature(response) {
  const headers = [...response.headers.entries()]
    .filter(([name]) => !["date", "x-correlation-id"].includes(name))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
  return `${response.status}\n${headers}\n\n${response.text}`;
}

async function pollUntil(predicate, { timeout, interval = 400 }) {
  const started = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return { value, ms: Date.now() - started };
    if (Date.now() - started > timeout) return { value: null, ms: Date.now() - started };
    await sleep(interval);
  }
}

/** Espera a que `client` (con su jar o su cookie copiada) reciba 401 en una ruta protegida; devuelve cuánto tardó. */
async function waitForRevocation(client, { cookie, timeoutSeconds = REVALIDATION + 6 } = {}) {
  const result = await pollUntil(async () => (await client.get("/api/v2/projects", cookie ? { cookie } : {})).status === 401, { timeout: timeoutSeconds * 1000 });
  return result;
}

const state = {};

// ------------------------------------------------------------------------------------------------------------------------ escenarios

async function scenario1() {
  const A = newClient("userA");
  state.A = A;
  state.emailA = uniqueEmail("userA");
  state.passwordA = DEFAULT_PASSWORD;

  expectStatus(await A.me(), 401, "GET /auth/me sin sesión");
  const weak = await A.register(uniqueEmail("weak"), "corta");
  expectStatus(weak, 400, "registro con contraseña corta");
  check(weak.body?.code === "weak_password", `contraseña corta: code ${weak.body?.code}`);
  const badEmail = await A.register("no-es-un-correo", DEFAULT_PASSWORD);
  expectStatus(badEmail, 400, "registro con correo inválido");

  const registered = await A.register(state.emailA, state.passwordA);
  expectStatus(registered, 202, "registro de A");
  check(registered.body?.status === "accepted", "registro: cuerpo {status:'accepted'}");
  const again = await A.register(state.emailA, "otra-contrasena-larga-2");
  expectStatus(again, 202, "registro repetido del mismo correo");
  check(JSON.stringify(again.body) === JSON.stringify(registered.body), "registro repetido: cuerpo idéntico (no revela que la cuenta existe)");
  note("registro nuevo y repetido: 202 con el mismo cuerpo; contraseña corta y correo inválido: 400");

  const wrong = await A.login(state.emailA, "contrasena-equivocada-1");
  const unknown = await A.login(uniqueEmail("nadie"), "contrasena-equivocada-1");
  expectStatus(wrong, 401, "login con contraseña errónea");
  expectStatus(unknown, 401, "login de cuenta inexistente");
  check(wrong.text === unknown.text, "login: mismo cuerpo 401 para cuenta existente y no existente");

  const login = await A.login(state.emailA, state.passwordA);
  expectStatus(login, 200, "login de A");
  check(login.body.email === state.emailA && login.body.authMode === "Authenticated", `login: usuario ${JSON.stringify(login.body)}`);
  state.userIdA = login.body.id;
  const [cookie] = A.lastSetCookies;
  check(A.lastSetCookies.length === 1 && cookie, "login: una sola cookie de sesión");
  check(cookie.attrs.httponly === true, "cookie HttpOnly");
  check(String(cookie.attrs.samesite).toLowerCase() === "lax", `cookie SameSite=Lax (fue ${cookie.attrs.samesite})`);
  check(cookie.attrs.path === "/" && cookie.attrs.domain === undefined, "cookie Path=/ y sin Domain");
  check(cookie.maxAge === null && cookie.expires === null, "sesión normal: cookie de sesión del navegador (sin Expires ni Max-Age)");
  check(!/^[A-Za-z0-9+/=_-]{0,8}$/.test(cookie.value) && cookie.value.length > 40, "cookie: ticket cifrado opaco, no un id legible");
  const me = await A.me();
  expectStatus(me, 200, "GET /auth/me con sesión");
  check(me.body.id === state.userIdA, "me: mismo usuario");
  note(`cookie «${cookie.name}»: HttpOnly, SameSite=Lax, Path=/, sin Domain, sin Expires/Max-Age; /auth/me 200 con el usuario ${state.userIdA}`);

  const confirmation = await MAILPIT.waitForMessage({ to: state.emailA, contains: "view=confirm-email" });
  state.confirmationMailA = confirmation;
  note(`correo de confirmación recibido en Mailpit («${confirmation.subject}», desde ${confirmation.from})`);
}

async function scenario2() {
  const A = state.A;
  const world = await createFullProject(A, { name: `Proyecto de A ${Date.now().toString(36)}` });
  state.world = world;
  note(`flujo clásico del dataset (upload -> preview -> threshold -> vectorize -> simplify -> check -> dimensions -> export -> paleta -> capas -> operación) + guardado v2: proyecto ${world.v2.projectId}`);

  const doc2 = await A.get(`/api/v2/projects/${world.v2.projectId}/document`);
  expectStatus(doc2, 200, "document tras editor-save");
  check(doc2.body.versionNumber === 2, `editor-save: versión actual 2 (fue ${doc2.body.versionNumber})`);

  const renamed = await A.request("PATCH", `/api/v2/projects/${world.v2.projectId}`, { json: { name: `${world.name} (editado)` } });
  expectStatus(renamed, 200, "PATCH del proyecto");
  state.projectNameA = renamed.body.name;
  const layer = await A.request("PATCH", `/api/v2/projects/${world.v2.projectId}/layers/${world.v2.layerId}`, { json: { name: "Capa editada por A" } });
  expectStatus(layer, 200, "PATCH de la capa");
  const listed = await A.get("/api/v2/projects");
  expectStatus(listed, 200, "listado de A");
  check(listed.body.items.some((p) => p.id === world.v2.projectId && p.name === state.projectNameA), "el listado de A incluye su proyecto renombrado");
  const asset = await A.get(`/api/v2/projects/${world.v2.projectId}/assets/${world.v2.layerAssetId}`, { raw: true });
  expectStatus(asset, 200, "descarga de la capa por URL directa (A, con su cookie)");
  const versions = await A.get(`/api/v2/projects/${world.v2.projectId}/versions`);
  expectStatus(versions, 200, "versiones");
  note(`editor-save (v2) + PATCH de nombre del proyecto y de la capa: «${state.projectNameA}»; versiones: ${versions.body.map((v) => v.versionNumber).join(",")}`);
  state.snapshotA = await snapshotOf(A, world);
}

/** Todo el estado observable del mundo de A (para comprobar que no cambió tras los intentos de B). */
async function snapshotOf(client, world) {
  const pid = world.v2.projectId;
  const get = async (path) => {
    const r = await client.get(path, { raw: true });
    return `${r.status}:${r.bytes.toString("base64").length}:${r.bytes.toString("base64")}`;
  };
  return {
    project: await get(`/api/v2/projects/${pid}`),
    document: await get(`/api/v2/projects/${pid}/document`),
    versions: await get(`/api/v2/projects/${pid}/versions`),
    layerAsset: await get(`/api/v2/projects/${pid}/assets/${world.v2.layerAssetId}`),
    export: await get(world.classic.exportUrl),
    classicMeta: await get(`/api/v1/projects/${world.classic.projectId}/images/${world.classic.imageId}`),
    list: await get("/api/v2/projects"),
  };
}

async function scenario3() {
  const A = state.A;
  const world = state.world;
  const before = state.snapshotA;
  const oldCookie = A.sessionCookie.value;

  const out = await A.logout();
  expectStatus(out, 204, "logout");
  check(A.sessionCookie === null, "logout: la cookie de sesión se borró del jar");
  expectStatus(await A.get("/api/v2/projects"), 401, "listado sin sesión");
  expectStatus(await A.me(), 401, "me sin sesión");
  note("tras el logout: 204, cookie borrada, proyectos y /auth/me -> 401");

  const wrong = await A.login(state.emailA, "contrasena-equivocada-1");
  expectStatus(wrong, 401, "login con contraseña errónea tras logout");
  const login = await A.login(state.emailA, state.passwordA);
  expectStatus(login, 200, "login de A (segunda sesión)");
  check(A.sessionCookie.value !== oldCookie, "el login emite una cookie NUEVA (no reutiliza la anterior)");
  check(login.body.id === state.userIdA, "mismo usuario interno tras volver a entrar");

  const after = await snapshotOf(A, world);
  for (const key of Object.keys(before)) check(before[key] === after[key], `recuperación: «${key}» idéntico tras logout + login`);
  const metadata = await A.get(`/api/v1/projects/${world.classic.projectId}/images/${world.classic.imageId}`);
  expectStatus(metadata, 200, "metadata clásica recuperada");
  note("tras volver a entrar A recupera, byte a byte: proyecto, documento, versiones, SVG de capa, export clásico, metadata clásica y listado");
}

async function scenario4() {
  const B = newClient("userB");
  state.B = B;
  state.emailB = uniqueEmail("userB");
  const account = await B.registerAndLogin(state.emailB);
  state.userIdB = account.user.id;
  check(state.userIdB && state.userIdB !== state.userIdA, "B es un usuario interno distinto de A");
  const me = await B.me();
  expectStatus(me, 200, "me de B");
  check(me.body.email === state.emailB, "me de B devuelve su correo");
  check(B.sessionCookie.value !== state.A.sessionCookie.value, "B tiene su propia cookie de sesión");
  note(`B registrado (usuario ${state.userIdB}), con cookie distinta de la de A`);
}

async function scenario5() {
  const { A, B, world } = state;
  const listB = await B.get("/api/v2/projects");
  expectStatus(listB, 200, "listado de B");
  check(listB.body.totalCount === 0 && listB.body.items.length === 0, `B no ve proyectos (totalCount ${listB.body.totalCount})`);
  for (const search of [world.name.slice(0, 8), "Proyecto", "%", "_", "%25", "A"]) {
    const found = await B.get(`/api/v2/projects?search=${encodeURIComponent(search)}&pageSize=100`);
    expectStatus(found, 200, `búsqueda «${search}» de B`);
    check(!found.body.items.some((p) => p.id === world.v2.projectId), `la búsqueda «${search}» de B no devuelve el proyecto de A`);
  }
  const detail = await B.get(`/api/v2/projects/${world.v2.projectId}`);
  const missing = await B.get(`/api/v2/projects/${crypto.randomUUID()}`);
  expectStatus(detail, 404, "GET del proyecto de A como B");
  check(signature(detail).split("\n\n").pop() === signature(missing).split("\n\n").pop(), "mismo cuerpo 404 que un id inexistente");
  const listA = await A.get("/api/v2/projects");
  check(listA.body.items.some((p) => p.id === world.v2.projectId), "A sigue viendo su proyecto");
  note("B: listado vacío, 6 búsquedas (incl. comodines % y _) sin el proyecto de A, detalle 404 idéntico al de un id inexistente");
}

// ---- Escenario 6: la superficie completa (rutas de /api/v1/projects/{p}/images/{i}/... y /api/v2/...) ----

function routeMatrix(ids, bodies) {
  const c = ids.classic;
  const root = `/api/v1/projects/${c.projectId}/images/${c.imageId}`;
  const v2 = `/api/v2/projects/${ids.projectId}`;
  const palette = `${root}/color-palette/${c.paletteId}`;
  return [
    // --- flujo clásico (43 rutas del grupo central) ---
    ["GET", `${root}`],
    ["GET", `${root}/original`],
    ["POST", `${root}/preview`, bodies.empty],
    ["GET", `${root}/previews/${c.previewId}`],
    ["POST", `${root}/threshold`, bodies.empty],
    ["GET", `${root}/masks/${c.maskId}`],
    ["POST", `${root}/vectorize`, bodies.empty],
    ["GET", `${root}/vectors/${c.vectorId}`],
    ["POST", `${root}/simplify/preview`, bodies.empty],
    ["POST", `${root}/simplify/apply`, bodies.empty],
    ["GET", `${root}/simplifications/${c.simplificationId}`],
    ["POST", `${root}/check`, bodies.empty],
    ["POST", `${root}/dimensions/apply`, bodies.empty],
    ["GET", `${root}/dimensions/${c.dimensionId}`],
    ["GET", `${root}/export?sourceKind=dimension&sourceId=${c.dimensionId}`],
    ["POST", `${root}/color-palette/detect`, bodies.empty],
    ["POST", `${palette}/merge`, bodies.empty],
    ["POST", `${palette}/unmerge`, bodies.empty],
    ["POST", `${palette}/rename`, bodies.empty],
    ["POST", `${palette}/exclude`, bodies.empty],
    ["POST", `${palette}/confirm`],
    ["GET", `${palette}`],
    ["GET", `${palette}/preview`],
    ["GET", `${palette}/groups/${c.groupId}/mask`],
    ["POST", `${palette}/layers`],
    ["GET", `${palette}/layers`],
    ["GET", `${palette}/layers/consolidated`],
    ["POST", `${palette}/layers/${c.layerGroupId}/visibility`, bodies.empty],
    ["POST", `${palette}/layers/${c.layerGroupId}/lock`, bodies.empty],
    ["POST", `${palette}/layers/${c.layerGroupId}/rename`, bodies.empty],
    ["POST", `${palette}/layers/reorder`, bodies.empty],
    ["GET", `${palette}/layers/layout`],
    ["POST", `${palette}/layers/${c.layerGroupId}/operation`, { operation: "ignore" }],
    ["GET", `${palette}/layers/operations`],
    ["POST", `${root}/vectors/${c.vectorId}/components`, bodies.empty],
    ["GET", `${root}/vectors/${c.vectorId}/components`],
    ["POST", `${root}/vectors/${c.vectorId}/components/groups`, bodies.empty],
    ["GET", `${root}/vectors/${c.vectorId}/components/groups`],
    ["POST", `${root}/vectors/${c.vectorId}/components/groups/${c.groupId}/ungroup`],
    ["POST", `${root}/vectors/${c.vectorId}/components/groups/${c.groupId}/rename`, bodies.empty],
    ["POST", `${root}/vectors/${c.vectorId}/physical-union/preview`, bodies.empty],
    ["POST", `${root}/vectors/${c.vectorId}/physical-union/confirm`, bodies.empty],
    ["GET", `${root}/vectors/${c.vectorId}/physical-union`],
    // --- /api/v2 con dueño en el repositorio ---
    ["GET", `${v2}`],
    ["PATCH", `${v2}`, { name: "Renombrado por otra cuenta", description: "no debería aplicarse" }],
    ["DELETE", `${v2}`],
    ["POST", `${v2}/duplicate`],
    ["POST", `${v2}/assets`, "asset"],
    ["GET", `${v2}/assets/${ids.layerAssetId}`],
    ["GET", `${v2}/assets/${ids.thumbnailAssetId}`],
    ["DELETE", `${v2}/assets/${ids.layerAssetId}`],
    ["GET", `${v2}/document`],
    ["GET", `${v2}/versions`],
    ["GET", `${v2}/versions/1`],
    ["GET", `${v2}/versions/2`],
    ["POST", `${v2}/versions/1/restore`],
    ["POST", `${v2}/document/editor-save`, bodies.editorSave],
    ["PATCH", `${v2}/layers/${ids.layerId}`, { name: "Capa tomada por otra cuenta", order: 99, visible: false, locked: true, manufacturingOperation: "engrave" }],
    ["POST", "/api/v2/workspaces/save", bodies.workspaceSave],
  ];
}

async function callRoute(client, [method, path, body], assetForm) {
  if (body === "asset") {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: "image/png" }), "x.png");
    form.append("type", "original");
    return client.request(method, path, { body: form });
  }
  return client.request(method, path, body === undefined ? {} : { json: body });
}

async function scenario6() {
  const { A, B, world } = state;
  const ids = {
    classic: world.classic,
    projectId: world.v2.projectId,
    layerId: world.v2.layerId,
    layerAssetId: world.v2.layerAssetId,
    thumbnailAssetId: world.v2.thumbnailAssetId,
  };
  check(ids.thumbnailAssetId, "el proyecto de A tiene miniatura (asset) para probar la descarga directa");
  const freshDoc = (await A.get(`/api/v2/projects/${ids.projectId}/document`)).body;
  const editorSave = await buildEditorPayload(A, freshDoc, { dx: 1, dy: 1 });
  const bodiesFor = (target) => ({
    empty: {},
    editorSave,
    workspaceSave: {
      projectId: target.projectId,
      name: "x",
      classicProjectId: target.classic.projectId,
      imageId: target.classic.imageId,
      paletteId: target.classic.paletteId,
      paletteVersion: 1,
      dimensionId: target.classic.dimensionId,
      idempotencyKey: crypto.randomUUID(),
    },
  });
  const randomIds = () => {
    const u = () => crypto.randomUUID();
    return {
      classic: {
        projectId: u(), imageId: u(), previewId: u(), maskId: u(), vectorId: u(), simplificationId: u(), dimensionId: u(), paletteId: u(), groupId: u(), layerGroupId: u(),
      },
      projectId: u(), layerId: u(), layerAssetId: u(), thumbnailAssetId: u(),
    };
  };

  const foreignRoutes = routeMatrix(ids, bodiesFor(ids));
  const unknownIds = randomIds();
  const unknownRoutes = routeMatrix(unknownIds, bodiesFor(unknownIds));
  check(foreignRoutes.length === unknownRoutes.length && foreignRoutes.length >= 55, `matriz de ${foreignRoutes.length} rutas`);

  // (a) B con ids reales de A vs ids inexistentes: misma respuesta (estado, cabeceras y cuerpo), siempre 404.
  const differences = [];
  for (let i = 0; i < foreignRoutes.length; i++) {
    const label = `${foreignRoutes[i][0]} ${foreignRoutes[i][1].replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "{id}")}`;
    const foreign = await callRoute(B, foreignRoutes[i]);
    const missing = await callRoute(B, unknownRoutes[i]);
    if (foreign.status !== 404) differences.push(`${label}: ajeno ${foreign.status} (esperaba 404)`);
    else if (missing.status !== 404) differences.push(`${label}: inexistente ${missing.status} (esperaba 404)`);
    else if (signature(foreign) !== signature(missing)) differences.push(`${label}: 404 ajeno distinto del 404 inexistente`);
  }
  check(differences.length === 0, `B recibió respuestas distintas de «404 como si no existiera»:\n          ${differences.join("\n          ")}`);
  note(`${foreignRoutes.length} rutas (flujo clásico: detalle, original, preview, threshold, vectorize, simplify, check, dimensions, export, paleta, capas, operaciones, layout, componentes, grupos, unión física; v2: detalle, PATCH, DELETE, duplicar, assets, documento, versiones, restaurar, editor-save, capa, workspaces/save) como B: todas 404 y byte a byte iguales a las de ids inexistentes`);

  // (a') Control positivo: con los MISMOS ids, el dueño sí obtiene 2xx en las rutas GET (los ids son reales; el 404 de B no se debe a ids mal formados).
  const gets = foreignRoutes.filter(([method]) => method === "GET");
  const ownerOk = [];
  const ownerNotOk = [];
  for (const route of gets) {
    const response = await callRoute(A, route);
    const label = `${route[1].replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "{id}")} -> ${response.status}`;
    (response.status >= 200 && response.status < 300 ? ownerOk : ownerNotOk).push(label);
  }
  check(ownerOk.length >= 20 && ownerOk.length >= gets.length - 4, `control positivo: el dueño solo obtuvo 2xx en ${ownerOk.length} de ${gets.length} rutas GET (${ownerNotOk.join("; ")})`);
  note(`control positivo: el dueño A obtiene 2xx en ${ownerOk.length} de las ${gets.length} rutas GET con esos mismos ids${ownerNotOk.length ? ` (el resto, sin recurso aún: ${ownerNotOk.join("; ")})` : ""}`);

  // (b) Anónimo (sin cookie): 401 uniforme en todas.
  const anonymous = newClient("anónimo");
  const anonymousDiffs = [];
  for (const route of foreignRoutes) {
    const response = await callRoute(anonymous, route);
    if (response.status !== 401 || response.body?.code !== "unauthenticated") anonymousDiffs.push(`${route[0]} ${route[1]}: ${response.status} ${response.text.slice(0, 80)}`);
  }
  check(anonymousDiffs.length === 0, `anónimo debía recibir 401 unauthenticated:\n          ${anonymousDiffs.join("\n          ")}`);
  note(`las mismas ${foreignRoutes.length} rutas sin cookie: 401 {code:'unauthenticated'}`);

  // (c) Descargas por URL directa.
  for (const [what, url] of [
    ["SVG de capa", `/api/v2/projects/${ids.projectId}/assets/${ids.layerAssetId}`],
    ["miniatura", `/api/v2/projects/${ids.projectId}/assets/${ids.thumbnailAssetId}`],
    ["original clásico", `/api/v1/projects/${ids.classic.projectId}/images/${ids.classic.imageId}/original`],
    ["export clásico", ids.classic.exportUrl],
  ]) {
    expectStatus(await A.get(url, { raw: true }), 200, `${what}: dueño`);
    expectStatus(await B.get(url, { raw: true }), 404, `${what}: otra cuenta`);
    expectStatus(await anonymous.get(url, { raw: true }), 401, `${what}: anónimo`);
  }
  // Un asset de A pedido bajo un proyecto PROPIO de B tampoco se entrega (el asset debe ser del proyecto indicado).
  const bProject = await B.post("/api/v2/projects", { name: "Proyecto de B" });
  expectStatus(bProject, 201, "B crea su proyecto");
  expectStatus(await B.get(`/api/v2/projects/${bProject.body.id}/assets/${ids.layerAssetId}`, { raw: true }), 404, "asset de A bajo un proyecto de B");
  note("descargas por URL directa (SVG de capa, miniatura, original, export): dueño 200 / otra cuenta 404 / anónimo 401; el asset de A bajo un proyecto de B también 404");

  // (d) El estado de A no cambió (nada se renombró, borró, duplicó, restauró ni se subió).
  const after = await snapshotOf(A, world);
  const changed = Object.keys(state.snapshotA).filter((k) => state.snapshotA[k] !== after[k]);
  check(changed.length === 0, `el estado de A cambió tras los intentos de B: ${changed.join(", ")}`);
  const copies = (await A.get("/api/v2/projects?pageSize=100")).body.items.filter((p) => /^Copia de/.test(p.name));
  check(copies.length === 0, "B no pudo duplicar el proyecto de A");
  note("estado de A intacto tras los intentos de B (proyecto, documento, versiones, asset, export, metadata y listado idénticos; ningún duplicado)");
}

async function scenario6b() {
  const A = state.A;
  const valid = A.sessionCookie;
  expectStatus(await A.get("/api/v2/projects", { cookie: `${valid.name}=${valid.value}` }), 200, "control: la cookie genuina vale");
  const v = valid.value;
  const mid = Math.floor(v.length / 2);
  const flip = (s, i) => s.slice(0, i) + (s[i] === "A" ? "B" : "A") + s.slice(i + 1);
  const variants = {
    "un carácter alterado en el medio": flip(v, mid),
    "un carácter alterado al final": flip(v, v.length - 2),
    "truncada a la mitad": v.slice(0, mid),
    "con basura añadida": `${v}AAAA`,
    "valor vacío": "",
    "texto arbitrario": "esto-no-es-una-sesion",
    "aleatoria de la misma longitud": Array.from({ length: v.length }, () => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[Math.floor(Math.random() * 64)]).join(""),
  };
  for (const [label, value] of Object.entries(variants)) {
    for (const path of ["/api/v1/auth/me", "/api/v2/projects", `/api/v2/projects/${state.world.v2.projectId}/document`]) {
      expectStatus(await A.get(path, { cookie: `${valid.name}=${value}` }), 401, `cookie ${label} en ${path}`);
    }
  }
  expectStatus(await A.get("/api/v2/projects", { cookie: `otra-cookie=${v}` }), 401, "valor válido bajo otro nombre de cookie");
  expectStatus(await A.get("/api/v2/projects", { cookies: false, headers: { Authorization: `Bearer ${v}` } }), 401, "la sesión no se lee de Authorization");
  expectStatus(await A.get(`/api/v2/projects?access_token=${encodeURIComponent(v)}`, { cookies: false }), 401, "la sesión no se lee de la query");
  expectStatus(await A.get("/api/v2/projects", { cookies: false, headers: { "X-Vectorify-User": state.userIdA, "X-Test-Sub": state.userIdA } }), 401, "un id de usuario en cabeceras no autentica");
  note(`${Object.keys(variants).length} alteraciones de la cookie x 3 rutas -> 401; nombre distinto, Authorization: Bearer, query e id en cabeceras -> 401; la cookie genuina sigue valiendo`);
}

async function scenario6c() {
  const A = state.A;
  const before = (await A.get("/api/v2/projects")).body.totalCount;
  const variants = [
    ["sin cabecera X-Vectorify-Request", { csrfHeader: false }],
    ["Origin ajeno", { origin: "https://evil.example" }],
    ["sin Origin", { origin: "" }],
    ["Origin de otro puerto", { origin: "http://localhost:9" }],
  ];
  for (const [label, options] of variants) {
    for (const [method, path, json] of [
      ["POST", "/api/v2/projects", { name: "CSRF" }],
      ["PATCH", `/api/v2/projects/${state.world.v2.projectId}`, { name: "CSRF" }],
      ["DELETE", `/api/v2/projects/${state.world.v2.projectId}`],
      ["POST", "/api/v1/auth/logout-all"],
      ["POST", "/api/v1/auth/logout"],
    ]) {
      const response = await A.request(method, path, { ...options, ...(json ? { json } : {}) });
      check(response.status === 403 && response.body?.code === "csrf_rejected", `${label}: ${method} ${path} -> ${response.status} ${response.text.slice(0, 80)} (esperaba 403 csrf_rejected)`);
    }
  }
  expectStatus(await A.get("/api/v2/projects", { csrf: false }), 200, "GET sin cabecera ni Origin (método seguro)");
  expectStatus(await A.get("/api/v1/auth/me"), 200, "la sesión de A sigue viva tras los intentos CSRF (el logout forzado no se ejecutó)");
  const after = (await A.get("/api/v2/projects")).body.totalCount;
  check(before === after, `ninguna petición CSRF tuvo efecto (proyectos ${before} -> ${after})`);
  note(`${variants.length} variantes x 5 operaciones no seguras (crear, renombrar, borrar, logout-all, logout) -> 403 csrf_rejected sin efecto; GET sigue permitido`);
}

async function scenario7() {
  const lifetime = LIFETIME * 1000;
  const remember = REMEMBER * 1000;
  check(lifetime <= 120_000 && remember <= 300_000, `la pila debe usar tiempos cortos (Lifetime=${LIFETIME}s, RememberMe=${REMEMBER}s): arranque con tests/e2e/mvp31_stack.sh up`);

  const idle = async () => {
    const X = newClient("caduca");
    await X.registerAndLogin();
    expectStatus(await X.me(), 200, "sesión recién abierta");
    await sleep(lifetime + 3000);
    const expired = await X.get("/api/v2/projects");
    expectStatus(expired, 401, `sesión sin uso durante ${LIFETIME + 3} s (Lifetime=${LIFETIME} s)`);
    check(expired.body?.code === "unauthenticated", "la sesión caducada responde 401 unauthenticated");
    expectStatus(await X.me(), 401, "me con la sesión caducada");
    return `inactiva ${LIFETIME + 3} s -> 401 (caducó a los ${LIFETIME} s de inactividad)`;
  };

  const sliding = async () => {
    const Y = newClient("renueva");
    await Y.registerAndLogin();
    const first = Y.sessionCookie.value;
    const started = Date.now();
    const reissued = new Set();
    let requests = 0;
    while (Date.now() - started < lifetime * 1.6) {
      await sleep(Math.max(1000, Math.floor(lifetime / 3)));
      const response = await Y.get("/api/v2/projects");
      requests++;
      check(response.status === 200, `uso continuo: a los ${Math.round((Date.now() - started) / 1000)} s la sesión debía seguir viva y dio ${response.status}`);
      if (Y.lastSetCookies.length > 0) reissued.add(Y.sessionCookie.value);
    }
    const total = Math.round((Date.now() - started) / 1000);
    check(total > LIFETIME, `la prueba superó el Lifetime (${total} s > ${LIFETIME} s)`);
    check(reissued.size >= 1 && Y.sessionCookie.value !== first, "el servidor REEMITIÓ la cookie (renovación deslizante): valor distinto del del login");
    return `uso cada ~${Math.round(lifetime / 3000)} s durante ${total} s (> Lifetime ${LIFETIME} s): ${requests} peticiones 200 y ${reissued.size} cookie(s) reemitida(s)`;
  };

  const absolute = async () => {
    const Z = newClient("recordarme");
    await Z.register(uniqueEmail("rememberme"), DEFAULT_PASSWORD).then(() => undefined);
    const email = uniqueEmail("rememberme2");
    await Z.registerAndLogin(email, DEFAULT_PASSWORD, { rememberMe: true });
    const loginCookie = Z.lastSetCookies.find((c) => c.name === Z.sessionCookie.name);
    const t0 = Date.now();
    check(loginCookie?.maxAge !== null && Math.abs(loginCookie.maxAge - REMEMBER) <= 2, `«recordarme»: Max-Age ${loginCookie?.maxAge} ≈ ${REMEMBER} s (¿coincide E2E_REMEMBER_ME_LIFETIME_SECONDS con la pila?)`);
    check(loginCookie.expires instanceof Date && !Number.isNaN(loginCookie.expires.getTime()), "«recordarme»: cookie persistente con Expires");
    // Inactividad: pasado el Lifetime sin uso la sesión persistente SIGUE viva (no caduca por inactividad dentro del tope absoluto).
    await sleep(Math.max(0, lifetime + 3000 - (Date.now() - t0)));
    expectStatus(await Z.get("/api/v2/projects"), 200, `«recordarme» tras ${LIFETIME + 3} s sin uso`);
    // Uso cerca del tope: renueva el ticket, pero el tope ABSOLUTO no se prolonga.
    await sleep(Math.max(0, remember - 5000 - (Date.now() - t0)));
    expectStatus(await Z.get("/api/v2/projects"), 200, "«recordarme» poco antes del tope absoluto");
    for (const c of Z.lastSetCookies) {
      if (c.expires) check(c.expires.getTime() <= t0 + remember + 2500, `la cookie reemitida no supera el tope absoluto (Expires ${c.expires.toISOString()})`);
    }
    await sleep(Math.max(0, remember + 3000 - (Date.now() - t0)));
    const capped = await Z.get("/api/v2/projects");
    expectStatus(capped, 401, `«recordarme» pasado el tope absoluto (${REMEMBER} s) aunque se usó 5 s antes`);
    return `«recordarme»: Max-Age ${loginCookie.maxAge} s; viva tras ${LIFETIME + 3} s inactiva; usada a los ${REMEMBER - 5} s (200) y 401 a los ${REMEMBER + 3} s: tope absoluto no prolongable`;
  };

  const results = await Promise.all([idle(), sliding(), absolute()]);
  for (const line of results) note(line);
  note(`pila de prueba: Lifetime=${LIFETIME} s, RememberMeLifetime=${REMEMBER} s, RevalidationInterval=${REVALIDATION} s`);
}

async function scenario8() {
  // 8a: logout efectivo en dos dispositivos de la misma cuenta.
  const L1 = newClient("L-dispositivo-1");
  const L2 = newClient("L-dispositivo-2");
  const email = uniqueEmail("logout");
  await L1.registerAndLogin(email);
  expectStatus(await L2.login(email, DEFAULT_PASSWORD), 200, "login en el dispositivo 2");
  const bystander = newClient("N");
  await bystander.registerAndLogin();
  await sleep((REVALIDATION + 1) * 1000); // las dos cookies quedan «viejas»: la siguiente petición revalida el SecurityStamp en la base

  // Control de la ventana documentada: una cookie RECIÉN emitida (menos de RevalidationInterval) no se revalida contra la base, así que un logout desde otro dispositivo
  // todavía no la alcanza. Es informativo (no se exige 200): demuestra que el 401 posterior viene de la revalidación y no de otra causa.
  const fresh = newClient("L-reciente");
  expectStatus(await fresh.login(email, DEFAULT_PASSWORD), 200, "login del dispositivo reciente");
  const freshHeader = [...fresh.snapshotCookies().entries()].map(([n, v]) => `${n}=${v}`).join("; ");
  const freshT0 = Date.now();

  const stolen = L1.snapshotCookies();
  const stolenHeader = [...stolen.entries()].map(([n, v]) => `${n}=${v}`).join("; ");
  expectStatus(await L1.get("/api/v2/projects", { cookie: stolenHeader }), 200, "control: la copia de la cookie vale antes del logout");
  const loggedOut = await L1.logout();
  expectStatus(loggedOut, 204, "logout");
  check(L1.sessionCookie === null && L1.lastSetCookies.some((c) => c.deleted), "logout: Set-Cookie que BORRA la cookie y jar vacío");
  expectStatus(await L1.get("/api/v2/projects"), 401, "protegido tras logout (jar vacío)");

  const replay = await waitForRevocation(L1, { cookie: stolenHeader });
  check(replay.value, `la copia de la cookie anterior seguía valiendo ${Math.round(replay.ms / 1000)} s después del logout`);
  check(replay.ms <= (REVALIDATION + 5) * 1000, `revocación demasiado lenta: ${replay.ms} ms (ventana ${REVALIDATION} s)`);
  const windowProbe = await fresh.get("/api/v2/projects", { cookie: freshHeader });
  const windowAge = ((Date.now() - freshT0) / 1000).toFixed(1);
  const windowRevoked = await waitForRevocation(fresh, { cookie: freshHeader });
  check(windowRevoked.value, "la cookie emitida justo antes del logout también termina revocada");
  note(`ventana de revocación (control): una cookie con ${windowAge} s de vida respondió ${windowProbe.status}${windowProbe.status === 200 ? ` (dentro de la ventana de ${REVALIDATION} s, como documenta docs/AUTH_SESSION_LIFECYCLE.md §5)` : ""} y terminó en 401 a los ${Math.round((Date.now() - freshT0) / 1000)} s de emitirse`);
  note(`cookie copiada antes del logout: 401 a los ${replay.ms} ms del logout (ventana de revalidación configurada: ${REVALIDATION} s)`);
  const otherDevice = await waitForRevocation(L2);
  check(otherDevice.value, "el otro dispositivo de la misma cuenta debía quedar cerrado (decisión de S03: logout cierra en todos)");
  note(`el otro dispositivo de la cuenta: 401 a los ${otherDevice.ms} ms`);
  expectStatus(await bystander.get("/api/v2/projects"), 200, "otra cuenta (N) no se ve afectada por el logout de L");

  // Idempotencia y tolerancia.
  expectStatus(await newClient("anónimo").logout(), 204, "logout sin sesión");
  expectStatus(await newClient("basura").request("POST", "/api/v1/auth/logout", { cookie: "vectorify.session=basura" }), 204, "logout con cookie basura");
  expectStatus(await newClient("sin-csrf").request("POST", "/api/v1/auth/logout", { csrfHeader: false }), 403, "logout sin cabecera anti-CSRF");

  // 8b: «cerrar sesión en todos lados».
  const email2 = uniqueEmail("logoutall");
  const M1 = newClient("M-1");
  const M2 = newClient("M-2");
  const M3 = newClient("M-3");
  await M1.registerAndLogin(email2);
  await M2.login(email2, DEFAULT_PASSWORD);
  await M3.login(email2, DEFAULT_PASSWORD);
  await sleep((REVALIDATION + 1) * 1000);
  expectStatus(await newClient("anónimo").request("POST", "/api/v1/auth/logout-all"), 401, "logout-all sin sesión");
  expectStatus(await M1.request("POST", "/api/v1/auth/logout-all", { csrfHeader: false }), 403, "logout-all sin cabecera anti-CSRF");
  expectStatus(await M1.get("/api/v2/projects"), 200, "M1 sigue viva tras el intento sin CSRF");
  const all = await M1.logoutAll();
  expectStatus(all, 204, "logout-all");
  check(M1.sessionCookie === null, "logout-all borra la cookie de este navegador");
  const r2 = await waitForRevocation(M2);
  const r3 = await waitForRevocation(M3);
  check(r2.value && r3.value, "los otros dos dispositivos deben quedar cerrados");
  expectStatus(await bystander.get("/api/v2/projects"), 200, "la otra cuenta (N) sigue viva tras el logout-all de M");
  expectStatus(await M2.login(email2, DEFAULT_PASSWORD), 200, "se puede volver a entrar después");
  note(`logout-all: 204; los otros 2 dispositivos -> 401 a los ${r2.ms}/${r3.ms} ms; la cuenta ajena N sigue viva; sin sesión 401, sin CSRF 403`);
}

async function scenario9() {
  const R1 = newClient("R-1");
  const email = uniqueEmail("recovery");
  await R1.registerAndLogin(email);

  // Confirmación de correo (verificación) con el enlace recibido.
  const confirmationMail = await MAILPIT.waitForMessage({ to: email, contains: "view=confirm-email" });
  const confirmLink = Mailpit.linkIn(confirmationMail, "view=confirm-email");
  const confirmParams = Mailpit.confirmParams(confirmLink);
  check(confirmLink.startsWith(ORIGIN) && confirmLink.includes("#"), "el enlace sale de PublicBaseUrl y lleva el token en el FRAGMENTO");
  const anon = newClient("anónimo");
  expectStatus(await anon.post("/api/v1/auth/confirm-email", { userId: confirmParams.userId, email: confirmParams.email, token: confirmParams.token }), 204, "confirm-email con el enlace");
  const reusedConfirm = await anon.post("/api/v1/auth/confirm-email", { userId: confirmParams.userId, email: confirmParams.email, token: confirmParams.token });
  expectStatus(reusedConfirm, 400, "confirm-email con el enlace ya usado");
  check(reusedConfirm.body?.code === "invalid_token", "confirmación reusada: invalid_token");
  note("confirmación de correo: enlace del correo -> 204; reuso -> 400 invalid_token");

  // Bloqueo por intentos fallidos, para comprobar que el restablecimiento lo limpia.
  for (let i = 0; i < 6; i++) await anon.login(email, "contrasena-equivocada-1");
  expectStatus(await anon.login(email, DEFAULT_PASSWORD), 401, "cuenta bloqueada: ni la contraseña correcta entra");

  // forgot-password: respuesta idéntica exista o no la cuenta.
  const unknown = uniqueEmail("fantasma");
  const known = await anon.post("/api/v1/auth/forgot-password", { email });
  const ghost = await anon.post("/api/v1/auth/forgot-password", { email: unknown });
  expectStatus(known, 202, "forgot-password (cuenta existente)");
  expectStatus(ghost, 202, "forgot-password (cuenta inexistente)");
  check(JSON.stringify(known.body) === JSON.stringify(ghost.body) && known.body.status === "accepted", "forgot-password: mismo cuerpo exista o no la cuenta");
  const resetMail = await MAILPIT.waitForMessage({ to: email, contains: "view=reset-password" });
  const resetLink = Mailpit.linkIn(resetMail, "view=reset-password");
  const { email: linkEmail, token } = Mailpit.resetParams(resetLink);
  check(linkEmail === email && token && !new URL(resetLink).search.includes("token"), "el enlace trae correo y token SOLO en el fragmento (no en la query)");
  await sleep(1500);
  check((await MAILPIT.countFor(unknown)) === 0, "a la cuenta inexistente NO le llegó ningún correo");
  note("forgot-password: 202 idéntico para cuenta existente e inexistente; solo la existente recibe el correo (enlace con el token en el fragmento)");

  // Sesiones abiertas antes del restablecimiento.
  const old1 = newClient("R-vieja");
  // la cuenta está bloqueada: se abre una sesión con la cookie de R1 (emitida antes del bloqueo) — sigue viva porque el bloqueo no revoca sesiones.
  expectStatus(await R1.get("/api/v2/projects"), 200, "la sesión previa de R1 sigue viva antes del restablecimiento");
  old1.loadCookies(R1.snapshotCookies());

  const newPassword = "nueva-contrasena-larga-9";
  const badToken = await anon.post("/api/v1/auth/reset-password", { email, token: "token-invalido", newPassword });
  expectStatus(badToken, 400, "reset con token inválido");
  check(badToken.body?.code === "invalid_token", "token inválido: invalid_token genérico");
  const weak = await anon.post("/api/v1/auth/reset-password", { email, token, newPassword: "corta" });
  expectStatus(weak, 400, "reset con contraseña débil");
  check(weak.body?.code === "weak_password", `contraseña débil: ${weak.body?.code}`);
  const otherAccount = await anon.post("/api/v1/auth/reset-password", { email: uniqueEmail("otro"), token, newPassword });
  check(otherAccount.status === 400 && otherAccount.body?.code === "invalid_token", "el token de una cuenta no sirve para otra/inexistente (mismo invalid_token)");
  const done = await anon.post("/api/v1/auth/reset-password", { email, token, newPassword });
  expectStatus(done, 204, "reset con el enlace del correo");
  const reused = await anon.post("/api/v1/auth/reset-password", { email, token, newPassword: "otra-contrasena-larga-10" });
  expectStatus(reused, 400, "reset con el enlace ya usado");
  check(reused.body?.code === "invalid_token", "enlace reusado: invalid_token");

  expectStatus(await anon.login(email, DEFAULT_PASSWORD), 401, "la contraseña vieja ya no entra");
  const fresh = newClient("R-nueva");
  expectStatus(await fresh.login(email, newPassword), 200, "la contraseña nueva entra (y el bloqueo se limpió)");
  const revoked = await waitForRevocation(old1);
  check(revoked.value, "la sesión abierta antes del restablecimiento debía quedar invalidada");
  expectStatus(await fresh.get("/api/v2/projects"), 200, "la sesión nueva funciona");
  note(`restablecimiento: token inválido 400 (genérico), contraseña débil 400, OK 204, enlace reusado 400; vieja contraseña 401, nueva 200, bloqueo limpiado; sesión previa -> 401 a los ${revoked.ms} ms`);

  // Cambio de contraseña estando dentro (change-password).
  const S2 = newClient("R-otro-dispositivo");
  expectStatus(await S2.login(email, newPassword), 200, "segundo dispositivo");
  await sleep((REVALIDATION + 1) * 1000);
  const wrong = await fresh.post("/api/v1/auth/change-password", { currentPassword: "no-es-la-actual-1", newPassword: "tercera-contrasena-larga-11" });
  expectStatus(wrong, 400, "change-password con la actual incorrecta");
  check(wrong.body?.code === "invalid_current_password", "contraseña actual incorrecta: 400 invalid_current_password (nunca 401)");
  expectStatus(await fresh.get("/api/v2/projects"), 200, "un error de tecleo no cierra la sesión");
  const before = fresh.sessionCookie.value;
  const changed = await fresh.post("/api/v1/auth/change-password", { currentPassword: newPassword, newPassword: "tercera-contrasena-larga-11" });
  expectStatus(changed, 204, "change-password correcto");
  check(fresh.lastSetCookies.length > 0 && fresh.sessionCookie.value !== before, "change-password re-emite la cookie de la sesión actual");
  expectStatus(await fresh.get("/api/v2/projects"), 200, "la sesión actual sigue viva tras cambiar la contraseña");
  const dropped = await waitForRevocation(S2);
  check(dropped.value, "las demás sesiones deben caer al cambiar la contraseña");
  note(`change-password: actual incorrecta 400 invalid_current_password (sesión intacta), correcta 204 con cookie re-emitida; el otro dispositivo -> 401 a los ${dropped.ms} ms`);
}

// ------------------------------------------------------------------------------------------------------------------------ ejecución

const SCENARIOS = [
  { id: "1", title: "Registrar User A", run: scenario1, needs: [] },
  { id: "2", title: "Crear Project A y editarlo", run: scenario2, needs: ["1"] },
  { id: "3", title: "Logout/Login y recuperar Project A", run: scenario3, needs: ["2"] },
  { id: "4", title: "Registrar User B", run: scenario4, needs: ["1"] },
  { id: "5", title: "User B no ve Project A", run: scenario5, needs: ["2", "4"] },
  { id: "6", title: "Acceso directo a IDs/assets/versiones/exports de A como B y como anónimo -> denegado (404 idéntico al de un id inexistente / 401)", run: scenario6, needs: ["2", "4"] },
  { id: "6b", title: "Cookie manipulada -> 401", run: scenario6b, needs: ["2"] },
  { id: "6c", title: "CSRF negativo (sin cabecera / Origin ajeno) -> 403", run: scenario6c, needs: ["2"] },
  { id: "7", title: "Caducidad y renovación de la sesión", run: scenario7, needs: [] },
  { id: "8", title: "Logout efectivo (incl. cerrar sesión en todos lados)", run: scenario8, needs: [] },
  { id: "9", title: "Recuperación de acceso extremo a extremo", run: scenario9, needs: [] },
];

function closure(ids) {
  const wanted = new Set(ids);
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of SCENARIOS) if (wanted.has(s.id)) for (const n of s.needs) if (!wanted.has(n)) (wanted.add(n), (grew = true));
  }
  return SCENARIOS.filter((s) => wanted.has(s.id));
}

async function main() {
  const selected = ONLY.length > 0 ? closure(ONLY) : SCENARIOS;
  console.log(`E2E MVP 3.1 (M3.1-S10) contra ${API} (SPA/Origin ${ORIGIN}, Mailpit ${process.env.MAILPIT_URL || "http://localhost:32025"})`);
  console.log(`Sesión de la pila: Lifetime=${LIFETIME}s RememberMe=${REMEMBER}s RevalidationInterval=${REVALIDATION}s\n`);
  const health = await fetch(`${API}/api/v1/auth/me`).then((r) => r.status).catch(() => null);
  if (health !== 401) {
    console.error(`La API no responde 401 en /api/v1/auth/me sin sesión (fue ${health}): ¿está corriendo en AUTH_MODE=Authenticated en ${API}?`);
    process.exit(2);
  }

  const summary = [];
  const failedIds = new Set();
  for (const s of selected) {
    if (s.needs.some((n) => failedIds.has(n))) {
      summary.push({ ...s, status: "OMITIDO", ms: 0, detail: `depende del escenario ${s.needs.find((n) => failedIds.has(n))}, que falló` });
      failedIds.add(s.id);
      continue;
    }
    currentLog = [];
    const before = checks;
    const started = Date.now();
    let status = "OK";
    let detail = "";
    try {
      await s.run();
    } catch (error) {
      status = "FALLA";
      detail = error instanceof CheckFailed ? error.message : `${error.stack ?? error}`;
      failedIds.add(s.id);
    }
    const ms = Date.now() - started;
    console.log(`[${status === "OK" ? "OK   " : "FALLA"}] Escenario ${s.id} · ${s.title}  (${checks - before} comprobaciones, ${(ms / 1000).toFixed(1)} s)`);
    for (const line of currentLog) console.log(line);
    if (detail) console.log(`      ✗ ${detail}`);
    summary.push({ ...s, status, ms, detail });
  }

  console.log("\n=== Resumen ===");
  for (const r of summary) console.log(`${r.status.padEnd(7)} ${r.id.padEnd(3)} ${r.title}${r.status === "OK" ? "" : r.detail ? ` -> ${r.detail.split("\n")[0]}` : ""}`);
  const bad = summary.filter((r) => r.status !== "OK");
  console.log(`\n${summary.length - bad.length}/${summary.length} escenarios OK, ${checks} comprobaciones.`);
  process.exit(bad.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
