// «Actor» de navegador real para los E2E de MVP 3.1 (M3.1-S10): un Chrome/Edge propio (perfil temporal = cookies propias) dirigido por lib/cdp.mjs, con
// los colectores de violaciones de CSP y de errores de consola de tests/e2e/csp_browser_check.mjs y las acciones de UI que usan los recorridos
// (clic por texto, rellenar por etiqueta, esperar texto). Dos actores = dos personas con sesiones completamente separadas.

import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchChrome, openTab, sleep } from "./cdp.mjs";

export const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

export function findChrome() {
  return process.env.CHROME_PATH || CHROME_CANDIDATES.find(existsSync);
}

const q = (value) => JSON.stringify(value);
const VISIBLE = `(el) => !!(el.offsetParent || el.getClientRects().length)`;

export async function launchActor({ name, port, spa, api, headless = !process.env.HEADED }) {
  const chromePath = findChrome();
  if (!chromePath) throw new Error("No se encontró Chrome/Edge: defina CHROME_PATH.");
  const browser = await launchChrome({ chromePath, port, headless });
  const page = await openTab(browser);
  const violations = [];
  const consoleErrors = [];
  let currentStep = "inicio";

  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Log.enable");
  await page.send("Network.enable");
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      window.__cspViolations = [];
      document.addEventListener("securitypolicyviolation", (e) => {
        window.__cspViolations.push({ directive: e.violatedDirective, blocked: e.blockedURI, source: e.sourceFile, sample: e.sample });
      });`,
  });

  page.on("Log.entryAdded", ({ entry }) => {
    if (/Content Security Policy|Refused to (load|connect|apply|execute|frame|run|create|evaluate)/i.test(entry.text) || entry.source === "security") {
      violations.push({ actor: name, step: currentStep, via: "Log.entryAdded", text: entry.text, url: entry.url });
    } else if (entry.level === "error") {
      consoleErrors.push({ actor: name, step: currentStep, text: entry.text, url: entry.url });
    }
  });
  page.on("Runtime.consoleAPICalled", ({ type, args }) => {
    const text = (args ?? []).map((a) => a.value ?? a.description ?? "").join(" ");
    if (/Content Security Policy|Refused to/i.test(text)) violations.push({ actor: name, step: currentStep, via: "console", text });
    else if (type === "error") consoleErrors.push({ actor: name, step: currentStep, text });
  });
  page.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
    consoleErrors.push({ actor: name, step: currentStep, text: `excepción: ${exceptionDetails.exception?.description ?? exceptionDetails.text}` });
  });

  const actor = {
    name,
    page,
    browser,
    violations,
    consoleErrors,
    steps: [],
    get currentStep() {
      return currentStep;
    },

    async collectDomViolations() {
      const found = await page.evaluate("window.__cspViolations ? window.__cspViolations.splice(0) : []").catch(() => []);
      for (const v of found) violations.push({ actor: name, step: currentStep, via: "securitypolicyviolation", ...v });
    },

    async navigate(url) {
      await page.send("Page.navigate", { url });
      await sleep(400);
      await page.waitFor("document.readyState === 'complete'", { label: "document.readyState" });
    },

    async click(text, { role = "button,a,[role=button],[role=menuitem],[role=tab],summary,label", timeout = 15000 } = {}) {
      const expression = `(() => {
        const t = ${q(text.toLowerCase())};
        const isVisible = ${VISIBLE};
        const els = [...document.querySelectorAll(${q(role)})].filter(isVisible);
        const name = (e) => ((e.getAttribute("aria-label") || e.textContent || e.title || "").replace(/\\s+/g, " ").trim().toLowerCase());
        const el = els.find((e) => name(e) === t) || els.find((e) => name(e).includes(t));
        if (!el) return false;
        el.scrollIntoView({ block: "center" });
        el.click();
        return true;
      })()`;
      await page.waitFor(expression, { timeout, label: `clic en «${text}»` });
    },

    async fill(labelText, value, { nth = 0 } = {}) {
      const focused = await page.evaluate(`(() => {
        const t = ${q(labelText.toLowerCase())};
        const isVisible = ${VISIBLE};
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
    },

    async textVisible(text, timeout = 20000) {
      await page.waitFor(`document.body.innerText.toLowerCase().includes(${q(text.toLowerCase())})`, { timeout, label: `texto «${text}»` });
    },

    async textAbsent(text, settleMs = 1500) {
      await sleep(settleMs);
      const present = await page.evaluate(`document.body.innerText.toLowerCase().includes(${q(text.toLowerCase())})`);
      if (present) throw new Error(`El texto «${text}» NO debía verse en la pantalla.`);
    },

    async bodyText() {
      return page.evaluate(`document.body.innerText.replace(/\\s+/g, " ").slice(0, 600)`);
    },

    async snapshot() {
      return page.evaluate(`(() => {
        const isVisible = ${VISIBLE};
        const txt = (e) => (e.getAttribute("aria-label") || e.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 60);
        return {
          url: location.pathname + location.search.slice(0, 120),
          h1: [...document.querySelectorAll("h1,h2")].filter(isVisible).map(txt).slice(0, 6),
          buttons: [...document.querySelectorAll("button,a")].filter(isVisible).map(txt).filter(Boolean).slice(0, 25),
          canvases: document.querySelectorAll("canvas").length,
        };
      })()`);
    },

    /** Ejecuta un paso con nombre: recoge violaciones tardías, marca ok/falla y no aborta el recorrido. */
    async step(label, action) {
      currentStep = `${name}: ${label}`;
      const started = Date.now();
      try {
        await action();
        await sleep(500);
        await actor.collectDomViolations();
        actor.steps.push({ actor: name, name: label, ok: true, ms: Date.now() - started });
        console.log(`  ok    [${name}] ${label}`);
        return true;
      } catch (error) {
        await actor.collectDomViolations().catch(() => {});
        const snap = await actor.snapshot().catch(() => null);
        actor.steps.push({ actor: name, name: label, ok: false, ms: Date.now() - started, error: error.message, snap });
        console.log(`  FALLA [${name}] ${label}: ${error.message}`);
        if (snap) console.log(`          pantalla: ${JSON.stringify(snap).slice(0, 700)}`);
        return false;
      }
    },

    async close() {
      await page.close().catch(() => {});
      await browser.close();
    },
  };
  return actor;
}

export { sleep };
