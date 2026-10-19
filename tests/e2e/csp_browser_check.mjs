// Verificación en NAVEGADOR REAL de la CSP de la SPA (M3.1-S09). Abre Chrome/Edge con el protocolo DevTools (sin dependencias: ver lib/cdp.mjs) contra la pila ya corriendo
// (SPA servida por nginx con frontend/nginx.conf + Web API en Auth:Mode=Authenticated) y recorre: login, registro, «Mis proyectos», el editor con un proyecto, descargas/exports
// y «Mi cuenta». Cada pantalla se comprueba con las violaciones de CSP recogidas por (a) el evento `securitypolicyviolation` del documento y (b) el log del navegador
// (`Log.entryAdded` / consola). Sale con código 1 si hay UNA sola violación, o si un paso de la interfaz no se pudo completar.
//
// Uso:
//   SPA_URL=http://localhost:5173 API_URL=http://localhost:5080 E2E_EMAIL=... E2E_PASSWORD=... node tests/e2e/csp_browser_check.mjs
//   (opcional) CHROME_PATH=...  HEADED=1  SKIP_OPEN_PROJECT=1  E2E_PROJECT_NAME="Proyecto de prueba CSP"
// Requiere una cuenta ya registrada con al menos un proyecto guardado (ver docs/AUTH_SECURITY_REVIEW.md, «Cómo se verificó la CSP»).

import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchChrome, openTab, sleep } from "./lib/cdp.mjs";

const SPA = (process.env.SPA_URL || "http://localhost:5173").replace(/\/$/, "");
const API = (process.env.API_URL || "http://localhost:5080").replace(/\/$/, "");
const EMAIL = process.env.E2E_EMAIL;
const PASSWORD = process.env.E2E_PASSWORD;
const PROJECT_NAME = process.env.E2E_PROJECT_NAME || "Proyecto de prueba CSP";
const CHROME =
  process.env.CHROME_PATH ||
  ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);

if (!EMAIL || !PASSWORD) {
  console.error("Faltan E2E_EMAIL / E2E_PASSWORD (cuenta con un proyecto guardado).");
  process.exit(2);
}
if (!CHROME) {
  console.error("No se encontró Chrome/Edge: defina CHROME_PATH.");
  process.exit(2);
}

const violations = [];
const consoleErrors = [];
const steps = [];
let currentStep = "inicio";

const log = (message) => console.log(message);

const browser = await launchChrome({ chromePath: CHROME, headless: !process.env.HEADED });
const page = await openTab(browser);
const downloads = mkdtempSync(join(tmpdir(), "vectorify-downloads-"));

await page.send("Page.enable");
await page.send("Runtime.enable");
await page.send("Log.enable");
await page.send("Network.enable");
await page.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: downloads }).catch(() => {});
const downloaded = [];
page.on("Page.downloadWillBegin", ({ suggestedFilename, url }) => downloaded.push({ name: suggestedFilename, url: url.slice(0, 40), done: false }));
page.on("Page.downloadProgress", ({ state }) => {
  if (state === "completed") for (const d of downloaded) d.done = true;
});
await page.send("Emulation.setDeviceMetricsOverride", { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });

// (a) Eventos del documento: se registra ANTES de que corra cualquier script de la página, y sobrevive a las navegaciones completas guardándolos en sessionStorage-free (se recogen por navegación).
await page.send("Page.addScriptToEvaluateOnNewDocument", {
  source: `
    window.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      window.__cspViolations.push({ directive: e.violatedDirective, effective: e.effectiveDirective, blocked: e.blockedURI, source: e.sourceFile, line: e.lineNumber, sample: e.sample, disposition: e.disposition });
    });`,
});

// (b) Log del navegador y consola: las violaciones aparecen como «Refused to ...».
page.on("Log.entryAdded", ({ entry }) => {
  if (/Content Security Policy|Refused to (load|connect|apply|execute|frame|run|create|evaluate)/i.test(entry.text) || entry.source === "security") {
    violations.push({ step: currentStep, via: "Log.entryAdded", text: entry.text, url: entry.url });
  } else if (entry.level === "error") {
    consoleErrors.push({ step: currentStep, text: entry.text, url: entry.url });
  }
});
page.on("Runtime.consoleAPICalled", ({ type, args }) => {
  const text = (args ?? []).map((a) => a.value ?? a.description ?? "").join(" ");
  if (/Content Security Policy|Refused to/i.test(text)) violations.push({ step: currentStep, via: "console", text });
  else if (type === "error") consoleErrors.push({ step: currentStep, text });
});
page.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
  consoleErrors.push({ step: currentStep, text: `excepción: ${exceptionDetails.exception?.description ?? exceptionDetails.text}` });
});

// Respuestas HTTP del documento principal de la SPA: cabeceras de seguridad reales.
let documentHeaders = null;
page.on("Network.responseReceived", ({ type, response }) => {
  if (type === "Document" && response.url.startsWith(SPA) && !documentHeaders) documentHeaders = response.headers;
});

const q = (value) => JSON.stringify(value);

async function collectDomViolations() {
  const found = await page.evaluate("window.__cspViolations ? window.__cspViolations.splice(0) : []").catch(() => []);
  for (const v of found) violations.push({ step: currentStep, via: "securitypolicyviolation", ...v });
}

async function navigate(url) {
  await page.send("Page.navigate", { url });
  await sleep(400);
  await page.waitFor("document.readyState === 'complete'", { label: "document.readyState" });
}

const visible = `(el) => !!(el.offsetParent || el.getClientRects().length)`;

async function click(text, { role = "button,a,[role=button],[role=menuitem],[role=tab],summary,label", timeout = 15000 } = {}) {
  const expression = `(() => {
    const t = ${q(text.toLowerCase())};
    const isVisible = ${visible};
    const els = [...document.querySelectorAll(${q(role)})].filter(isVisible);
    const name = (e) => ((e.getAttribute("aria-label") || e.textContent || e.title || "").replace(/\\s+/g, " ").trim().toLowerCase());
    const el = els.find((e) => name(e) === t) || els.find((e) => name(e).includes(t));
    if (!el) return false;
    el.scrollIntoView({ block: "center" });
    el.click();
    return true;
  })()`;
  await page.waitFor(expression, { timeout, label: `clic en «${text}»` });
}

async function fill(labelText, value, { nth = 0 } = {}) {
  const focused = await page.evaluate(`(() => {
    const t = ${q(labelText.toLowerCase())};
    const isVisible = ${visible};
    const inputs = [...document.querySelectorAll("input,textarea")].filter(isVisible);
    const labelOf = (i) => {
      const byFor = i.id ? document.querySelector('label[for="' + CSS.escape(i.id) + '"]') : null;
      return ((byFor?.textContent) || i.closest("label")?.textContent || i.getAttribute("aria-label") || i.name || "").replace(/\\s+/g, " ").trim().toLowerCase();
    };
    const matches = inputs.filter((i) => labelOf(i).includes(t) || (i.name || "").toLowerCase() === t);
    const el = matches[${nth}];
    if (!el) return false;
    el.focus();
    el.select?.();
    return true;
  })()`);
  if (!focused) throw new Error(`No se encontró el campo «${labelText}».`);
  await page.send("Input.insertText", { text: value });
}

async function textVisible(text, timeout = 20000) {
  await page.waitFor(`document.body.innerText.toLowerCase().includes(${q(text.toLowerCase())})`, { timeout, label: `texto «${text}»` });
}

async function snapshot() {
  return page.evaluate(`(() => {
    const isVisible = ${visible};
    const txt = (e) => (e.getAttribute("aria-label") || e.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 60);
    return {
      url: location.pathname + location.search,
      title: document.title,
      h1: [...document.querySelectorAll("h1,h2")].filter(isVisible).map(txt).slice(0, 6),
      buttons: [...document.querySelectorAll("button,a,[role=tab],[role=menuitem]")].filter(isVisible).map(txt).filter(Boolean).slice(0, 40),
      inputs: [...document.querySelectorAll("input,textarea,select")].filter(isVisible).map((i) => i.type + ":" + (i.name || i.id || i.getAttribute("aria-label") || "")).slice(0, 15),
      canvases: document.querySelectorAll("canvas").length,
      imgs: [...document.querySelectorAll("img")].map((i) => ({ src: i.src.slice(0, 70), ok: i.complete && i.naturalWidth > 0 })),
    };
  })()`);
}

async function step(name, action) {
  currentStep = name;
  const started = Date.now();
  try {
    await action();
    await sleep(600); // margen para que lleguen eventos de violación tardíos (carga de imágenes, fetch)
    await collectDomViolations();
    steps.push({ name, ok: true, ms: Date.now() - started });
    log(`  ok   ${name}`);
  } catch (error) {
    await collectDomViolations().catch(() => {});
    let snap = null;
    try {
      snap = await snapshot();
    } catch {
      // la página puede estar rota
    }
    steps.push({ name, ok: false, ms: Date.now() - started, error: error.message, snap });
    log(`  FALLA ${name}: ${error.message}`);
    if (snap) log(`        pantalla: ${JSON.stringify(snap).slice(0, 900)}`);
  }
}

log(`Navegador: ${browser.version}\nSPA: ${SPA}  API: ${API}\n`);

// ------------------------------------------------------------------------------------------------ recorrido
await step("1. Pantalla de inicio de sesión (anónimo)", async () => {
  await navigate(`${SPA}/`);
  await textVisible("Iniciar sesión");
});

await step("2. Registro de una cuenta nueva", async () => {
  await click("Creá una");
  await textVisible("Crear cuenta");
  const fresh = `csp-reg-${Date.now()}@vectorify.test`;
  await fill("Correo electrónico", fresh);
  await fill("Contraseña", "otra-contrasena-larga-77", { nth: 0 });
  await fill("Repetí la contraseña", "otra-contrasena-larga-77");
  await click("Crear cuenta", { role: "button[type=submit],button" });
  await textVisible("Registro recibido");
});

await step("3. Inicio de sesión con la cuenta del proyecto", async () => {
  await navigate(`${SPA}/`);
  await textVisible("Iniciar sesión");
  await fill("Correo electrónico", EMAIL);
  await fill("Contraseña", PASSWORD);
  await click("Iniciar sesión", { role: "button[type=submit],button" });
  await textVisible("Mis proyectos");
});

await step("4. «Mis proyectos»: tarjeta con miniatura (img-src hacia la API)", async () => {
  await textVisible(PROJECT_NAME);
  await page.waitFor(`[...document.querySelectorAll("img")].some((i) => i.src.startsWith(${q(API)}) && i.complete && i.naturalWidth > 0)`, {
    label: "miniatura del proyecto cargada desde la API",
    timeout: 20000,
  });
});

if (!process.env.SKIP_OPEN_PROJECT) {
  await step("5. Abrir el proyecto en el editor (fetch de capas con la cookie + canvas)", async () => {
    await click(PROJECT_NAME, { role: "a,button,[role=button],[role=link],article,li" });
    await page.waitFor(`document.querySelectorAll("canvas").length > 0`, { timeout: 30000, label: "canvas del editor" });
    await sleep(1500);
    const snap = await snapshot();
    log(`        editor: ${JSON.stringify(snap).slice(0, 700)}`);
  });

  await step("6. Control: fetch de una capa SIN credentials no recibe la cookie, CON credentials sí", async () => {
    const result = await page.evaluate(`(async () => {
      const layerImg = [...document.querySelectorAll("img")].map((i) => i.src).find((s) => s.startsWith(${q(API)}));
      const assetUrl = layerImg;
      const without = assetUrl ? (await fetch(assetUrl, { credentials: "omit" })).status : null;
      const withCreds = assetUrl ? (await fetch(assetUrl, { credentials: "include" })).status : null;
      return { assetUrl, without, withCreds };
    })()`);
    log(`        ${JSON.stringify(result)}`);
    if (result.assetUrl && !(result.without === 401 && result.withCreds === 200)) {
      throw new Error(`se esperaba 401 sin credentials y 200 con ellas: ${JSON.stringify(result)}`);
    }
  });

  await step("7. Editor: exportación SVG, DXF y PNG desde el diálogo (Blob + <a download>; el PNG rasteriza por blob:)", async () => {
    const dialogText = () => page.evaluate(`(document.querySelector("[role=dialog]")?.innerText || "").replace(/\\s+/g, " ").slice(0, 700)`);
    for (const format of ["SVG", "DXF", "PNG"]) {
      await click("Exportar el documento");
      await page.waitFor(`!!document.querySelector("[role=dialog]")`, { label: "diálogo de exportación" });
      await click(format, { role: "label" });
      await click("Todas");
      await sleep(800);
      log(`        diálogo (${format}): ${await dialogText()}`);
      // Si el pre-vuelo pide confirmar avisos, se marca la casilla de confirmación.
      await page.evaluate(`(() => { const c = document.querySelector(".export-dialog__confirm input[type=checkbox]"); if (c && !c.checked) c.click(); return true; })()`);
      const before = downloaded.length;
      await click("Exportar", { role: "[role=dialog] button" });
      const deadline = Date.now() + 15000;
      while (downloaded.length === before && Date.now() < deadline) await sleep(250);
      if (downloaded.length === before) throw new Error(`el export ${format} no produjo ninguna descarga`);
      await sleep(500);
      await page.evaluate(`document.querySelector("[role=dialog]") ? (document.querySelector("[role=dialog] button[aria-label^=Cerrar]")?.click(), true) : true`);
      await sleep(300);
    }
    log(`        descargas: ${downloaded.map((d) => d.name).join(", ")} (carpeta: ${readdirSync(downloads).join(", ")})`);
  });
}

await step("8. «Mi cuenta» (perfil y contraseña)", async () => {
  await navigate(`${SPA}/?view=account`).catch(() => {});
  let opened = false;
  try {
    await click("Mi cuenta", { timeout: 4000 });
    opened = true;
  } catch {
    // el enlace puede vivir dentro del menú de usuario
  }
  if (!opened) {
    await navigate(`${SPA}/`);
    await textVisible("Mis proyectos");
    await click(EMAIL.split("@")[0].slice(0, 8), { timeout: 5000 }).catch(() => {});
    await click("Mi cuenta", { timeout: 8000 });
  }
  await textVisible("Mi cuenta");
  const snap = await snapshot();
  log(`        cuenta: ${JSON.stringify(snap).slice(0, 500)}`);
});

await step("9. Flujo clásico: elegir un archivo muestra la vista previa por blob: (img-src blob:)", async () => {
  await navigate(`${SPA}/?view=new`);
  await page.waitFor(`!!document.querySelector('input[type=file]')`, { label: "input de archivo" });
  const { root } = await page.send("DOM.getDocument");
  const { nodeId } = await page.send("DOM.querySelector", { nodeId: root.nodeId, selector: "input[type=file]" });
  const fixture = new URL("./fixtures/logo.png", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  await page.send("DOM.setFileInputFiles", { files: [decodeURIComponent(fixture)], nodeId });
  await page.waitFor(`[...document.querySelectorAll("img")].some((i) => i.src.startsWith("blob:") && i.complete && i.naturalWidth > 0)`, {
    label: "vista previa blob:",
    timeout: 15000,
  });
});

// ------------------------------------------------------------------------------------------------ informe
await sleep(500);
await collectDomViolations();
await page.close();
await browser.close();

console.log("\n=== Cabeceras del documento de la SPA ===");
for (const name of ["content-security-policy", "x-content-type-options", "x-frame-options", "referrer-policy", "permissions-policy", "cross-origin-opener-policy"]) {
  console.log(`${name}: ${documentHeaders?.[name] ?? documentHeaders?.[Object.keys(documentHeaders ?? {}).find((k) => k.toLowerCase() === name)] ?? "(ausente)"}`);
}

console.log("\n=== Pasos ===");
for (const s of steps) console.log(`${s.ok ? "ok  " : "FALLA"} ${s.name}${s.ok ? "" : ` -> ${s.error}`}`);

console.log(`\n=== Violaciones de CSP: ${violations.length} ===`);
for (const v of violations) console.log(JSON.stringify(v));

console.log(`\n=== Errores de consola (no CSP): ${consoleErrors.length} ===`);
for (const e of consoleErrors.slice(0, 25)) console.log(`[${e.step}] ${e.text}${e.url ? " @ " + e.url : ""}`);

const failedSteps = steps.filter((s) => !s.ok);
console.log(`\nResultado: ${violations.length} violaciones de CSP, ${failedSteps.length} pasos fallidos de ${steps.length}.`);
process.exit(violations.length === 0 && failedSteps.length === 0 ? 0 : 1);
