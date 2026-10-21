// Recorrido en NAVEGADOR REAL de MVP 3.1 (M3.1-S10) con dos contextos distintos (dos Chrome con perfil propio = dos personas, A y B), por el protocolo DevTools
// (tests/e2e/lib/cdp.mjs, sin dependencias) contra la pila `docker compose` aislada (nginx real + API en Authenticated + motor Python + Mailpit).
//
//   A: registro -> inicio de sesión -> «Mis proyectos» (con su proyecto) -> Editor (canvas) -> «Mi cuenta» -> «Salir» (y «Atrás» no muestra lo privado)
//   B: registro -> inicio de sesión -> «Mis proyectos» NO muestra el proyecto de A -> enlace directo (deep link) al proyecto de A => «ya no existe», no el contenido
//   A: vuelve a entrar; su sesión se invalida en el servidor (logout-all desde otro dispositivo); la SPA, al hacer una petición, vuelve al login con el aviso «Tu sesión terminó»
//
// Todos los pasos recogen violaciones de CSP (evento `securitypolicyviolation`, log del navegador y consola) y errores de consola. Se aceptan SOLO los 401 esperados
// del navegador (sin sesión / sesión invalidada) y, en el paso del enlace directo ajeno, el 404 que el navegador registra por sí mismo. Sale con código != 0 si hay una violación
// de CSP, un error de consola inesperado o un paso fallido. Si no hay Chrome/Edge, sale con código 2 y NO lo da por cubierto.
// Uso: SPA_URL=http://localhost:32173 API_URL=http://localhost:32080 node tests/e2e/mvp31_auth_browser_test.mjs   (opcional CHROME_PATH, HEADED=1)

import { AuthClient, DEFAULT_PASSWORD, sleep, uniqueEmail } from "./lib/authClient.mjs";
import { findChrome, launchActor } from "./lib/browserDriver.mjs";
import { createFullProject } from "./lib/projectWorld.mjs";

const SPA = (process.env.SPA_URL || "http://localhost:32173").replace(/\/$/, "");
const API = (process.env.API_URL || "http://localhost:32080").replace(/\/$/, "");
const REVALIDATION = Number(process.env.E2E_REVALIDATION_SECONDS || 3);

if (!findChrome()) {
  console.error("No se encontró Chrome/Edge: el recorrido en navegador real NO se ejecutó (defina CHROME_PATH). No se da por cubierto.");
  process.exit(2);
}

const emailA = uniqueEmail("browserA");
const emailB = uniqueEmail("browserB");
const A = await launchActor({ name: "A", port: 9341, spa: SPA, api: API });
const B = await launchActor({ name: "B", port: 9342, spa: SPA, api: API });
console.log(`Navegador: ${A.browser.version}\nSPA: ${SPA}  API: ${API}\nA = ${emailA}\nB = ${emailB}\n`);

const state = { deepLink: "" };
let projectName = "";
let world = null;

async function register(actor, email) {
  await actor.navigate(`${SPA}/`);
  await actor.textVisible("Iniciar sesión");
  await actor.click("Creá una");
  await actor.textVisible("Crear cuenta");
  await actor.fill("Correo electrónico", email);
  await actor.fill("Contraseña", DEFAULT_PASSWORD, { nth: 0 });
  await actor.fill("Repetí la contraseña", DEFAULT_PASSWORD);
  await actor.click("Crear cuenta", { role: "button[type=submit],button" });
  await actor.textVisible("Registro recibido");
}

async function login(actor, email) {
  await actor.navigate(`${SPA}/`);
  await actor.textVisible("Iniciar sesión");
  await actor.fill("Correo electrónico", email);
  await actor.fill("Contraseña", DEFAULT_PASSWORD);
  await actor.click("Iniciar sesión", { role: "button[type=submit],button" });
  await actor.textVisible("Mis proyectos");
}

async function openMenuItem(actor, item) {
  await actor.click("Menú de cuenta", { timeout: 10000 });
  await actor.click(item, { role: "[role=menuitem],button,a", timeout: 8000 });
}

// ------------------------------------------------------------------------------------------------ A
await A.step("1. Pantalla de inicio de sesión (anónimo)", async () => {
  await A.navigate(`${SPA}/`);
  await A.textVisible("Iniciar sesión");
});
await A.step("2. Registro de la cuenta A por la interfaz", () => register(A, emailA));

await A.step("(preparación por HTTP) A abre sesión por API y guarda un proyecto real del dataset", async () => {
  const api = new AuthClient({ api: API, origin: SPA, label: "A-api" });
  const login = await api.login(emailA, DEFAULT_PASSWORD);
  if (login.status !== 200) throw new Error(`login por API de A: ${login.status}`);
  world = await createFullProject(api, { name: `Proyecto de A (navegador) ${Date.now().toString(36)}` });
  projectName = world.name;
});

await A.step("3. Inicio de sesión de A -> «Mis proyectos» con su proyecto y miniatura (img-src hacia la API)", async () => {
  await login(A, emailA);
  await A.textVisible(projectName);
  await A.page.waitFor(`[...document.querySelectorAll("img")].some((i) => i.src.startsWith(${JSON.stringify(API)}) && i.complete && i.naturalWidth > 0)`, {
    label: "miniatura del proyecto cargada desde la API",
    timeout: 20000,
  });
});

await A.step("4. Abrir el proyecto en el Editor (capas por fetch con cookie + canvas)", async () => {
  await A.click(projectName, { role: "a,button,[role=button],[role=link],article,li" });
  await A.page.waitFor(`document.querySelectorAll("canvas").length > 0`, { timeout: 30000, label: "canvas del editor" });
  await sleep(1500);
  const snap = await A.snapshot();
  console.log(`          editor: ${JSON.stringify(snap).slice(0, 400)}`);
  if (!/projectId=/.test(snap.url)) throw new Error("la URL del editor no lleva el proyecto");
  state.deepLink = snap.url;
});

await A.step("5. «Mi cuenta» (perfil, cuenta de acceso y contraseña)", async () => {
  await openMenuItem(A, "Mi cuenta");
  await A.textVisible("Mi cuenta");
  await A.textVisible(emailA);
});

await A.step("6. «Salir» -> pantalla de inicio de sesión con «Cerraste sesión»; «Atrás» no muestra lo privado", async () => {
  await openMenuItem(A, "Salir");
  await A.textVisible("Iniciar sesión");
  await A.textVisible("Cerraste sesión");
  await A.page.evaluate("history.back()").catch(() => {});
  await sleep(1200);
  await A.textAbsent(projectName, 500);
  await A.textAbsent("Mis proyectos", 100);
});


// ------------------------------------------------------------------------------------------------ B
await B.step("7. Registro de la cuenta B por la interfaz", () => register(B, emailB));
await B.step("8. B inicia sesión: «Mis proyectos» NO muestra el proyecto de A", async () => {
  await login(B, emailB);
  await sleep(2000);
  await B.textAbsent(projectName, 500);
  console.log(`          pantalla de B: ${(await B.bodyText()).slice(0, 200)}`);
});

await B.step("9. Enlace directo al proyecto de A como B -> «ya no existe», no el contenido (sin canvas)", async () => {
  const url = `${SPA}/?projectId=${world.classic.projectId}&imageId=${world.classic.imageId}&paletteId=${world.classic.paletteId}&savedProjectId=${world.v2.projectId}`;
  await B.navigate(url);
  await B.textVisible("ya no existe", 20000);
  await B.textAbsent(projectName, 500);
  const snap = await B.snapshot();
  if (snap.canvases > 0) throw new Error("B llegó a un editor con canvas");
  console.log(`          pantalla de B: ${(await B.bodyText()).slice(0, 220)}`);
});

// ------------------------------------------------------------------------------------------------ A: sesión invalidada
await A.step("10. A vuelve a entrar", () => login(A, emailA));
await A.step("11. Sesión invalidada en el servidor (logout-all desde otro dispositivo): la SPA vuelve al login con «Tu sesión terminó»", async () => {
  const other = new AuthClient({ api: API, origin: SPA, label: "A-otro-dispositivo" });
  const login = await other.login(emailA, DEFAULT_PASSWORD);
  if (login.status !== 200) throw new Error(`login del otro dispositivo: ${login.status}`);
  const out = await other.logoutAll();
  if (out.status !== 204) throw new Error(`logout-all: ${out.status}`);
  await sleep((REVALIDATION + 2) * 1000); // pasada la ventana de revalidación el servidor ya rechaza la cookie del navegador
  // Una petición real de la SPA: escribir en el buscador de proyectos dispara GET /api/v2/projects con la cookie vieja -> 401 -> evento «sesión expirada».
  await A.page.waitFor(`!!document.querySelector('input[aria-label="Buscar proyectos"]')`, { label: "buscador de proyectos" });
  await A.click("Buscar proyectos", { role: "input" }).catch(() => {});
  await A.page.evaluate(`(() => { const i = document.querySelector('input[aria-label="Buscar proyectos"]'); i.focus(); return true; })()`);
  await A.page.send("Input.insertText", { text: "zzz" });
  await A.textVisible("Tu sesión terminó", 20000);
  await A.textVisible("Iniciar sesión");
  await A.textAbsent(projectName, 300);
});

// ------------------------------------------------------------------------------------------------ informe
await sleep(500);
for (const actor of [A, B]) await actor.collectDomViolations();
await A.close();
await B.close();

const violations = [...A.violations, ...B.violations];
const consoleErrors = [...A.consoleErrors, ...B.consoleErrors];
const isExpected401 = (e) => /status of 401|401 \(Unauthorized\)/i.test(e.text);
const isExpected404 = (e) => /status of 404|404 \(Not Found\)/i.test(e.text) && /enlace directo/i.test(e.step);
const unexpected = consoleErrors.filter((e) => !isExpected401(e) && !isExpected404(e));
const expected401 = consoleErrors.filter(isExpected401).length;
const expected404 = consoleErrors.filter(isExpected404).length;
const steps = [...A.steps, ...B.steps];
const failedSteps = steps.filter((s) => !s.ok);

console.log("\n=== Pasos ===");
for (const s of steps) console.log(`${s.ok ? "ok   " : "FALLA"} [${s.actor}] ${s.name}${s.ok ? "" : ` -> ${s.error}`}`);
console.log(`\n=== Violaciones de CSP: ${violations.length} ===`);
for (const v of violations) console.log(JSON.stringify(v));
console.log(`\n=== Errores de consola: ${consoleErrors.length} (401 esperados: ${expected401}, 404 esperados del enlace directo ajeno: ${expected404}, inesperados: ${unexpected.length}) ===`);
for (const e of unexpected) console.log(`[${e.step}] ${e.text}${e.url ? ` @ ${e.url}` : ""}`);
console.log(`\nResultado: ${violations.length} violaciones de CSP, ${unexpected.length} errores de consola inesperados, ${failedSteps.length} pasos fallidos de ${steps.length}.`);
process.exit(violations.length === 0 && unexpected.length === 0 && failedSteps.length === 0 ? 0 : 1);
