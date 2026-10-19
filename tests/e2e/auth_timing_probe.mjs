// Sonda de TIEMPOS de las rutas anónimas de autenticación (M3.1-S09, T5: enumeración de cuentas por temporización). Mide la mediana de N peticiones de cada par «cuenta existente /
// cuenta inexistente» contra una API en marcha y muestra la relación. No es una prueba pass/fail estricta (el ruido de red lo impide): es la medición que documenta
// docs/AUTH_SECURITY_REVIEW.md. El test automatizado equivalente (con umbral holgado) es AuthThreatReviewTests.Enumeration_LoginTimings_*.
//
// Uso: API_URL=http://localhost:5080 SPA_ORIGIN=http://localhost:5173 node tests/e2e/auth_timing_probe.mjs
// (la API debe estar en Auth:Mode=Authenticated; sube los límites con Auth__RateLimit__LoginIpPermitLimit=100000 etc. para no chocar con el 429 de S09)

const API = (process.env.API_URL || "http://localhost:5080").replace(/\/$/, "");
const ORIGIN = process.env.SPA_ORIGIN || "http://localhost:5173";
const N = Number(process.env.N || 25);
const PASSWORD = "una-contrasena-larga-1";
const WRONG = "una-contrasena-erronea-9";

const headers = { "Content-Type": "application/json", Origin: ORIGIN, "X-Vectorify-Request": "1" };

async function timed(path, body) {
  const start = performance.now();
  const response = await fetch(`${API}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  await response.arrayBuffer();
  return { ms: performance.now() - start, status: response.status };
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const email = (tag) => `probe-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@vectorify.test`;

async function sample(label, call) {
  const times = [];
  const statuses = new Set();
  for (let i = 0; i < N; i++) {
    const { ms, status } = await call(i);
    times.push(ms);
    statuses.add(status);
  }
  return { label, median: median(times), min: Math.min(...times), statuses: [...statuses].join(",") };
}

const known = email("known");
const locked = email("locked");
// Una cuenta DISTINTA por muestra para «contraseña errónea»: con una sola cuenta, a los 5 fallos queda bloqueada y se mediría la rama «bloqueada».
const pool = Array.from({ length: N }, (_, i) => email("pool" + i));
for (const address of [known, locked, ...pool]) {
  const response = await timed("/api/v1/auth/register", { email: address, password: PASSWORD });
  if (response.status !== 202) throw new Error(`registro de ${address}: ${response.status}`);
}
// Bloqueo de la cuenta «locked» (5 fallos por defecto).
for (let i = 0; i < 6; i++) await timed("/api/v1/auth/login", { email: locked, password: WRONG });

const results = [];
results.push(await sample("login · cuenta inexistente", () => timed("/api/v1/auth/login", { email: email("none"), password: WRONG })));
results.push(await sample("login · contraseña errónea (cuenta existente, 1 intento por cuenta)", (i) => timed("/api/v1/auth/login", { email: pool[i], password: WRONG })));
results.push(await sample("login · cuenta BLOQUEADA", () => timed("/api/v1/auth/login", { email: locked, password: WRONG })));
results.push(await sample("register · correo nuevo", () => timed("/api/v1/auth/register", { email: email("new"), password: PASSWORD })));
results.push(await sample("register · correo ya registrado", () => timed("/api/v1/auth/register", { email: known, password: PASSWORD })));
results.push(await sample("forgot-password · cuenta existente", () => timed("/api/v1/auth/forgot-password", { email: known })));
results.push(await sample("forgot-password · cuenta inexistente", () => timed("/api/v1/auth/forgot-password", { email: email("ghost") })));
results.push(await sample("resend-confirmation · cuenta existente", () => timed("/api/v1/auth/resend-confirmation", { email: known })));
results.push(await sample("resend-confirmation · cuenta inexistente", () => timed("/api/v1/auth/resend-confirmation", { email: email("ghost") })));

console.log(`N=${N} muestras por fila (mediana / mínimo, ms)\n`);
for (const r of results) console.log(`${r.label.padEnd(50)} mediana ${r.median.toFixed(1).padStart(7)}  mín ${r.min.toFixed(1).padStart(7)}  estados ${r.statuses}`);

const ratio = (a, b) => (results[a].median / results[b].median).toFixed(2);
console.log("\nRelaciones (≈1 = indistinguibles):");
console.log(`  login inexistente / errónea:       ${ratio(0, 1)}`);
console.log(`  login bloqueada / errónea:         ${ratio(2, 1)}`);
console.log(`  register nuevo / existente:        ${ratio(3, 4)}`);
console.log(`  forgot existente / inexistente:    ${ratio(5, 6)}`);
console.log(`  resend existente / inexistente:    ${ratio(7, 8)}`);
