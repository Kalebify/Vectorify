// Comprobación HTTP de la herramienta de reasignación de datos legados (M3.1-S10) contra una pila AISLADA que primero corrió en Development (datos creados sin login) y
// luego se levantó en Authenticated conservando los volúmenes (ver docs/MVP31_RELEASE.md, «Prueba de la herramienta»). Dos fases:
//   node tests/e2e/mvp31_legacy_reassign_check.mjs before   # registra A y B; A y B NO ven nada de lo legado (proyectos v2 y registros clásicos huérfanos)
//   (dry-run y --apply con scripts/reassign-legacy-data.sh)
//   node tests/e2e/mvp31_legacy_reassign_check.mjs after    # A ve TODO (v2 y clásicos), B nada; los eliminados siguen eliminados
// Los registros clásicos se descubren leyendo los sidecars del volumen con `docker compose -p $S10_PROJECT exec backend find` (solo lectura).
// Variables: API_URL, SPA_ORIGIN, S10_PROJECT (por defecto vectorify-s10), EXPECT_V2 (cantidad de proyectos v2 no eliminados esperados).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthClient, uniqueEmail } from "./lib/authClient.mjs";

const API = (process.env.API_URL || "http://localhost:32080").replace(/\/$/, "");
const ORIGIN = (process.env.SPA_ORIGIN || "http://localhost:32173").replace(/\/$/, "");
const PROJECT = process.env.S10_PROJECT || "vectorify-s10";
const STATE = join(tmpdir(), "vectorify-s10-legacy-state.json");
const phase = process.argv[2];

function docker(...args) {
  return execFileSync("docker", ["compose", "-p", PROJECT, ...args], { encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
}

function classicRecords() {
  const files = docker("exec", "-T", "backend", "find", "/app/App_Data/projects", "-name", "*.json").split("\n").map((l) => l.trim()).filter(Boolean);
  return files.map((file) => {
    const json = JSON.parse(docker("exec", "-T", "backend", "cat", file));
    return { projectId: json.ProjectId, imageId: json.ImageId, owner: json.OwnerId ?? null, file };
  });
}

let failures = 0;
function check(condition, message) {
  console.log(`${condition ? "  ok " : "  FALLA"} ${message}`);
  if (!condition) failures++;
}

async function listAll(client) {
  const response = await client.get("/api/v2/projects?pageSize=100");
  return response.body?.items ?? [];
}

if (phase === "before") {
  const A = new AuthClient({ api: API, origin: ORIGIN, label: "A" });
  const B = new AuthClient({ api: API, origin: ORIGIN, label: "B" });
  const a = await A.registerAndLogin(uniqueEmail("legacyA"));
  const b = await B.registerAndLogin(uniqueEmail("legacyB"));
  const records = classicRecords();
  console.log(`Cuentas: A=${a.email} B=${b.email}; registros clásicos en el volumen: ${records.length} (sin dueño: ${records.filter((r) => !r.owner).length}, del usuario de desarrollo: ${records.filter((r) => r.owner === "00000000-0000-0000-0000-000000000001").length})`);
  check((await listAll(A)).length === 0, "A (antes) no ve ningún proyecto v2");
  check((await listAll(B)).length === 0, "B (antes) no ve ningún proyecto v2");
  let hidden = 0;
  for (const r of records) hidden += (await A.get(`/api/v1/projects/${r.projectId}/images/${r.imageId}`)).status === 404 ? 1 : 0;
  check(hidden === records.length, `A (antes) recibe 404 en los ${records.length} registros clásicos (huérfanos)`);
  writeFileSync(STATE, JSON.stringify({ emailA: a.email, passwordA: a.password, emailB: b.email, passwordB: b.password }));
  console.log(`Estado guardado en ${STATE}`);
} else if (phase === "after") {
  if (!existsSync(STATE)) throw new Error(`Falta ${STATE}: ejecute antes la fase «before».`);
  const state = JSON.parse(readFileSync(STATE, "utf8"));
  const A = new AuthClient({ api: API, origin: ORIGIN, label: "A" });
  const B = new AuthClient({ api: API, origin: ORIGIN, label: "B" });
  await A.login(state.emailA, state.passwordA);
  await B.login(state.emailB, state.passwordB);
  const records = classicRecords();
  const mine = await listAll(A);
  const expected = Number(process.env.EXPECT_V2 || 0);
  console.log(`A ve ${mine.length} proyectos v2 (esperados ${expected || "?"}); registros clásicos en el volumen: ${records.length}`);
  check(expected === 0 || mine.length === expected, `A ve los ${expected} proyectos v2 reasignados`);
  check(mine.length > 0, "A ve proyectos v2");
  check((await listAll(B)).length === 0, "B no ve ninguno");
  let aOk = 0;
  let bHidden = 0;
  for (const r of records) {
    aOk += (await A.get(`/api/v1/projects/${r.projectId}/images/${r.imageId}`)).status === 200 ? 1 : 0;
    bHidden += (await B.get(`/api/v1/projects/${r.projectId}/images/${r.imageId}`)).status === 404 ? 1 : 0;
  }
  check(aOk === records.length, `A abre los ${records.length} registros clásicos (200): ${aOk}`);
  check(bHidden === records.length, `B recibe 404 en los ${records.length} registros clásicos: ${bHidden}`);
  let docs = 0;
  for (const p of mine.filter((p) => p.layerCount > 0)) {
    docs += (await A.get(`/api/v2/projects/${p.id}/document`)).status === 200 ? 1 : 0;
    check((await B.get(`/api/v2/projects/${p.id}`)).status === 404, `B: 404 en ${p.name}`) || 0;
  }
  check(docs === mine.filter((p) => p.layerCount > 0).length && docs > 0, `A abre el documento de los ${docs} proyectos guardados con capas`);
  const withTriple = mine.filter((p) => p.classicProjectId);
  let layersOk = 0;
  for (const p of withTriple) {
    const doc = (await A.get(`/api/v2/projects/${p.id}/document`)).body;
    const svg = doc?.layers?.[0]?.svgUrl ? await A.get(doc.layers[0].svgUrl, { raw: true }) : null;
    layersOk += svg?.status === 200 ? 1 : 0;
  }
  check(layersOk === withTriple.length, `A descarga el SVG de capa de los ${withTriple.length} proyectos con flujo clásico asociado`);
} else {
  console.error("Uso: node tests/e2e/mvp31_legacy_reassign_check.mjs before|after");
  process.exit(2);
}

console.log(failures === 0 ? "\nRESULTADO: OK" : `\nRESULTADO: ${failures} comprobación(es) fallida(s)`);
process.exit(failures === 0 ? 0 : 1);
