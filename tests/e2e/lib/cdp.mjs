// Cliente mínimo del protocolo Chrome DevTools (CDP) sin dependencias: solo `child_process`, `fetch` y el `WebSocket` global de Node >= 22.
// Lo usa tests/e2e/csp_browser_check.mjs (M3.1-S09) para recorrer la SPA en un navegador REAL y recoger las violaciones de CSP.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function launchChrome({ chromePath, port = 9333, headless = true } = {}) {
  const profile = mkdtempSync(join(tmpdir(), "vectorify-chrome-"));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--window-size=1366,900",
    ...(headless ? ["--headless=new"] : []),
    "about:blank",
  ];
  const child = spawn(chromePath, args, { stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(`${base}/json/version`);
      if (response.ok) {
        const version = await response.json();
        return {
          base,
          version: version.Browser,
          async close() {
            child.kill();
            await sleep(500);
            try {
              rmSync(profile, { recursive: true, force: true });
            } catch {
              // el perfil temporal puede seguir bloqueado un instante en Windows: no importa
            }
          },
        };
      }
    } catch {
      // aún arrancando
    }
    await sleep(200);
  }
  child.kill();
  throw new Error("Chrome no abrió el puerto de depuración remota.");
}

/** Abre una pestaña nueva y devuelve una sesión CDP sobre ella. */
export async function openTab(browser, url = "about:blank") {
  const response = await fetch(`${browser.base}/json/new?${encodeURI(url)}`, { method: "PUT" });
  const target = await response.json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry?.reject(new Error(`${message.error.message} (${JSON.stringify(message.error.data ?? "")})`));
      else entry?.resolve(message.result);
    } else {
      for (const handler of listeners.get(message.method) ?? []) handler(message.params);
    }
  });

  const session = {
    id: target.id,
    send(method, params = {}) {
      const id = nextId++;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    on(method, handler) {
      listeners.set(method, [...(listeners.get(method) ?? []), handler]);
    },
    async evaluate(expression) {
      const result = await session.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) {
        throw new Error(`evaluate falló: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
      }
      return result.result.value;
    },
    async waitFor(expression, { timeout = 20000, label = expression } = {}) {
      const deadline = Date.now() + timeout;
      let last;
      while (Date.now() < deadline) {
        try {
          last = await session.evaluate(expression);
          if (last) return last;
        } catch (error) {
          last = error.message;
        }
        await sleep(150);
      }
      throw new Error(`Tiempo agotado esperando: ${label} (último valor: ${JSON.stringify(last)})`);
    },
    async close() {
      socket.close();
      await fetch(`${browser.base}/json/close/${target.id}`).catch(() => {});
    },
  };
  return session;
}

export { sleep };
