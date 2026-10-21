// E2E de M1-S02 (carga y almacenamiento de imágenes): arranca la Web API real
// (no un WebApplicationFactory en memoria) en un puerto libre, con almacenamiento
// local apuntando a un directorio temporal, y ejercita HTTP real de punta a punta:
// carga válida (PNG) + recuperación del original, y las cargas inválidas del spec
// (formato no soportado, archivo vacío, archivo corrupto). Python no participa en
// este sprint, así que este E2E no lo arranca.
//
// Requiere: `dotnet build backend/Vectorify.sln` ya ejecutado (usa el DLL compilado).
// Uso: node tests/e2e/upload_e2e_test.mjs
//
// Contra una pila YA corriendo (M3.1-S10): con BACKEND_URL (y, si la API está en Auth:Mode=Authenticated, E2E_AUTH=1 + SPA_ORIGIN) NO arranca su propia API: usa esa URL con
// el cookie jar. Sin BACKEND_URL ni E2E_AUTH el comportamiento es el de siempre (API propia en Development sobre un directorio temporal).

import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { enableAuthFromEnv } from "./lib/authClient.mjs";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const API_DLL = join(ROOT, "backend", "Vectorify.Api", "bin", "Debug", "net10.0", "Vectorify.Api.dll");

// PNG 1x1 real y válido (misma firma que usan los tests unitarios de backend).
const VALID_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(url, process, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error(`El proceso de la Web API terminó antes de tiempo (código ${process.exitCode}).`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        const body = await response.json();
        if (body.status === "ok") return;
      }
    } catch {
      // todavía no está arriba: reintentar
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timeout esperando ${url}`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`FALLÓ: ${message}`);
  }
}

async function runChecks(apiUrl) {
  // 1) Carga válida: PNG -> 201 + metadatos + original recuperable sin modificarse.
  const validForm = new FormData();
  validForm.append("file", new Blob([VALID_PNG], { type: "image/png" }), "logo.png");
  const createResponse = await fetch(`${apiUrl}/api/v1/projects`, { method: "POST", body: validForm });
  assert(createResponse.status === 201, `esperaba 201 en carga válida, fue ${createResponse.status}`);
  const created = await createResponse.json();
  assert(created.filename === "logo.png", "filename incorrecto en la respuesta");
  assert(created.mimeType === "image/png", "mimeType incorrecto en la respuesta");
  assert(created.bytes === VALID_PNG.length, "bytes incorrecto en la respuesta");
  assert(created.width === 1 && created.height === 1, "dimensiones incorrectas en la respuesta");
  assert(created.status === "uploaded", "status incorrecto en la respuesta");

  const location = createResponse.headers.get("location");
  assert(!!location, "la respuesta 201 debe incluir Location del original");
  const originalResponse = await fetch(`${apiUrl}${location}`);
  assert(originalResponse.status === 200, "el original debe ser recuperable");
  const originalBytes = Buffer.from(await originalResponse.arrayBuffer());
  assert(originalBytes.equals(VALID_PNG), "el original recuperado no coincide byte a byte (se modificó)");

  // 2) Formato no soportado.
  const unsupportedForm = new FormData();
  unsupportedForm.append("file", new Blob([Buffer.from("no es una imagen")], { type: "image/gif" }), "a.gif");
  const unsupportedResponse = await fetch(`${apiUrl}/api/v1/projects`, { method: "POST", body: unsupportedForm });
  assert(unsupportedResponse.status === 400, "formato no soportado debe devolver 400");
  const unsupportedBody = await unsupportedResponse.json();
  assert(unsupportedBody.code === "unsupported_format", `code incorrecto: ${unsupportedBody.code}`);

  // 3) Archivo vacío.
  const emptyForm = new FormData();
  emptyForm.append("file", new Blob([], { type: "image/png" }), "vacio.png");
  const emptyResponse = await fetch(`${apiUrl}/api/v1/projects`, { method: "POST", body: emptyForm });
  assert(emptyResponse.status === 400, "archivo vacío debe devolver 400");
  const emptyBody = await emptyResponse.json();
  assert(emptyBody.code === "empty_file", `code incorrecto: ${emptyBody.code}`);

  // 4) Archivo corrupto (extensión/Content-Type dicen PNG, bytes no lo son).
  const corruptForm = new FormData();
  corruptForm.append("file", new Blob([Buffer.from("esto no es un PNG real")], { type: "image/png" }), "logo.png");
  const corruptResponse = await fetch(`${apiUrl}/api/v1/projects`, { method: "POST", body: corruptForm });
  assert(corruptResponse.status === 400, "archivo corrupto debe devolver 400");
  const corruptBody = await corruptResponse.json();
  assert(corruptBody.code === "corrupt_file", `code incorrecto: ${corruptBody.code}`);

  console.log("OK: E2E de carga de imágenes (válida e inválida) contra la Web API real.");
}

async function main() {
  const external = process.env.BACKEND_URL ? process.env.BACKEND_URL.replace(/\/$/, "") : null;
  if (process.env.E2E_AUTH === "1" && !external) {
    throw new Error("E2E_AUTH=1 necesita BACKEND_URL (este script solo arranca su propia API en Development, sin Postgres ni Identity).");
  }
  if (external) {
    await enableAuthFromEnv(external);
    await runChecks(external);
    return;
  }

  const apiPort = await freePort();
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const storageRoot = mkdtempSync(join(tmpdir(), "vectorify-upload-e2e-"));

  const env = {
    ...process.env,
    ASPNETCORE_ENVIRONMENT: "Development",
    ASPNETCORE_URLS: apiUrl,
    PythonEngine__BaseUrl: "http://127.0.0.1:1", // no se usa en este E2E; puerto sin listener
    Cors__AllowedOrigins: "http://localhost:5173",
    Storage__RootPath: storageRoot,
  };

  const api = spawn("dotnet", [API_DLL], { cwd: dirname(API_DLL), env });
  let apiOutput = "";
  api.stdout.on("data", (chunk) => (apiOutput += chunk));
  api.stderr.on("data", (chunk) => (apiOutput += chunk));

  try {
    await waitForHealth(`${apiUrl}/health`, api);

    await runChecks(apiUrl);
  } catch (error) {
    console.error(apiOutput);
    throw error;
  } finally {
    api.kill();
    await once(api, "exit").catch(() => {});
    rmSync(storageRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
