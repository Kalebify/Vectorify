// E2E de integración de M1-S11 (gate de calidad del MVP 1, "no añadir
// features: demostrar que el flujo completo funciona con diseños reales" --
// ver .sprint/3c1d77b2-6398-81f6-b4bd-e74d58fd57a7/spec.md). Encadena TODO
// el pipeline vía HTTP real contra la Web API real (mismo criterio que
// tests/e2e/upload_e2e_test.mjs y tests/e2e/real_stack_test.py: sin mocks,
// sin WebApplicationFactory) para cada fixture de tests/e2e/fixtures/:
//
//   upload -> preprocess/preview -> threshold -> vectorize ->
//   simplify (preview + apply) -> check -> dimensions/apply -> export
//
// A diferencia de upload_e2e_test.mjs, este script NO arranca la pila: la
// asume corriendo (backend en :5080, motor Python en :8001), igual que
// tests/e2e/real_stack_test.py y tests/e2e/smoke_test.py. El orquestador
// (o un desarrollador local) es responsable de levantarla antes de correr
// esto -- ver README.md, sección "Flujo E2E completo".
//
// Uso (con la pila ya corriendo, local o Docker):
//   BACKEND_URL=http://localhost:5080 node tests/e2e/full_pipeline_e2e_test.mjs
//
// En cada paso valida que la salida de una etapa es estructuralmente válida
// como entrada de la siguiente (el vectorId que devuelve vectorize es el
// que se usa para simplify; el sourceId/sourceKind correctos llegan a
// check/dimensions/export -- no solo que cada endpoint responda 200/201
// aislado). Para el fixture "problematic.png" verifica específicamente que
// el Laser Checker (M1-S08, con el fix de `transform` de M1-S11 -- ver
// services/python-engine/app/core/path_checker.py) YA NO reporta un
// duplicate_path para dos formas congruentes en posiciones REALES distintas
// (ver tests/e2e/fixtures/generate_fixtures.py, make_problematic(), para el
// razonamiento geométrico completo -- incluida la nota de por qué un
// duplicado LEGÍTIMO, misma posición real, no es reproducible vía trazado
// raster; ese escenario positivo se cubre a nivel unitario en
// services/python-engine/tests/test_path_checker.py). Para "noise.png"
// compara además el resultado vectorizado CON y SIN denoise, para demostrar
// que el pipeline de reducción de ruido (M1-S03) realmente cambia el
// resultado (no es trivial de threshold-ear).
//
// Mide el tiempo total del pipeline por fixture y de cada corrida completa,
// y lo imprime en un reporte legible al final -- ver IMPL.md de M1-S11 para
// el resultado de una corrida real contra la pila real.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { enableAuthFromEnv } from "./lib/authClient.mjs";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const FIXTURES_DIR = join(ROOT, "tests", "e2e", "fixtures");
const API = (process.env.BACKEND_URL || "http://localhost:5080").replace(/\/$/, "");

// Opt-in (M3.1-S10): con E2E_AUTH=1 abre sesión (cookie jar + cabecera anti-CSRF) para correr contra una API en Auth:Mode=Authenticated. Sin E2E_AUTH no hace nada.
await enableAuthFromEnv(API);

const FIXTURES = [
  { file: "logo.png", label: "Logo (formas simples, alto contraste)", denoise: 0 },
  { file: "silhouette.png", label: "Silueta (contorno cerrado simple)", denoise: 0 },
  { file: "text.png", label: "Texto trazado (múltiples subpaths)", denoise: 0 },
  { file: "holes.png", label: "Diseño con agujeros (topología con hueco)", denoise: 0 },
  { file: "noise.png", label: "Ruido (ejercita denoise real)", denoise: 4, isNoiseCase: true },
  {
    file: "problematic.png",
    label: "Formas congruentes en posiciones distintas (regresión del fix de transform, M1-S11)",
    denoise: 0,
    isProblematicCase: true,
  },
];

function assert(condition, message) {
  if (!condition) {
    throw new Error(`FALLÓ: ${message}`);
  }
}

async function json(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let parsed = null;
  const text = await response.text();
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  return { status: response.status, headers: response.headers, body: parsed, rawText: text };
}

async function upload(bytes, filename) {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "image/png" }), filename);
  const response = await fetch(`${API}/api/v1/projects`, { method: "POST", body: form });
  const body = await response.json();
  return { status: response.status, body };
}

/** Validador mínimo de buena formación XML: balancea tags abriendo/cerrando
 * (ignorando declaración XML, comentarios y tags autocontenidos) y confirma
 * que el tag raíz es <svg>. No reemplaza un parser XML completo, pero
 * alcanza para el criterio de aceptación "SVG resultante válido (parseable
 * como XML/SVG)" sin agregar una dependencia nueva solo para este script.
 */
function assertWellFormedSvg(svgText, context) {
  assert(svgText && svgText.trim().length > 0, `${context}: SVG vacío`);
  const withoutDeclarationOrComments = svgText
    .replace(/<\?xml[^>]*\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "");

  const tagRe = /<\/?([a-zA-Z_][\w:-]*)((?:"[^"]*"|'[^']*'|[^"'>])*?)(\/?)>/g;
  const stack = [];
  let firstTag = null;
  let match;
  while ((match = tagRe.exec(withoutDeclarationOrComments)) !== null) {
    const [full, name, , selfClosing] = match;
    const isClosing = full.startsWith("</");
    if (firstTag === null && !isClosing) firstTag = name;
    if (isClosing) {
      const top = stack.pop();
      assert(top === name, `${context}: tag de cierre </${name}> no coincide con <${top}> (XML mal formado)`);
    } else if (!selfClosing) {
      stack.push(name);
    }
  }
  assert(stack.length === 0, `${context}: quedaron ${stack.length} tags sin cerrar (XML mal formado)`);
  assert(firstTag && firstTag.split(":").pop().toLowerCase() === "svg", `${context}: la raíz no es <svg>, fue <${firstTag}>`);
}

function extractMm(svgText, attr) {
  const match = svgText.match(new RegExp(`${attr}="([\\d.]+)mm"`));
  return match ? Number(match[1]) : null;
}

async function runPipeline(fixture, report) {
  const start = Date.now();
  const stepTimes = {};
  const time = async (name, fn) => {
    const stepStart = Date.now();
    const result = await fn();
    stepTimes[name] = Date.now() - stepStart;
    return result;
  };

  const bytes = readFileSync(join(FIXTURES_DIR, fixture.file));

  // 1) Upload
  const uploaded = await time("upload", () => upload(bytes, fixture.file));
  assert(uploaded.status === 201, `upload: esperaba 201, fue ${uploaded.status}`);
  const { projectId, imageId } = uploaded.body;
  assert(projectId && imageId, "upload: falta projectId/imageId en la respuesta");

  // 2) Preprocess / preview
  const preview = await time("preview", () =>
    json("POST", `/api/v1/projects/${projectId}/images/${imageId}/preview`, {
      grayscale: false,
      contrast: 1.0,
      brightness: 0,
      denoise: fixture.denoise,
    }),
  );
  assert(preview.status === 201, `preview: esperaba 201, fue ${preview.status} (${preview.rawText})`);
  const previewId = preview.body.previewId;
  assert(previewId, "preview: falta previewId");

  // 3) Threshold (invert=true: los fixtures son forma OSCURA sobre fondo
  // CLARO -- ver tests/e2e/fixtures/generate_fixtures.py -- y el threshold
  // por defecto trata los píxeles claros como foreground, así que se invierte
  // para que la forma, no el fondo, quede como foreground de la máscara).
  const threshold = await time("threshold", () =>
    json("POST", `/api/v1/projects/${projectId}/images/${imageId}/threshold`, {
      previewId,
      value: 128,
      invert: true,
    }),
  );
  assert(threshold.status === 201, `threshold: esperaba 201, fue ${threshold.status} (${threshold.rawText})`);
  const maskId = threshold.body.maskId;
  assert(maskId, "threshold: falta maskId");
  assert(!threshold.body.metrics.isNearEmpty, "threshold: la máscara quedó casi vacía (fixture mal diseñado)");
  assert(!threshold.body.metrics.isNearFull, "threshold: la máscara quedó casi llena (fixture mal diseñado)");

  // 4) Vectorize (consume el maskId de threshold)
  const vectorize = await time("vectorize", () =>
    json("POST", `/api/v1/projects/${projectId}/images/${imageId}/vectorize`, { maskId }),
  );
  assert(vectorize.status === 201, `vectorize: esperaba 201, fue ${vectorize.status} (${vectorize.rawText})`);
  assert(vectorize.body.sourceMaskId === maskId, "vectorize: sourceMaskId no coincide con el maskId enviado");
  const vectorId = vectorize.body.vectorId;
  assert(vectorId, "vectorize: falta vectorId");
  assert(vectorize.body.metrics.pathCount > 0, "vectorize: pathCount debería ser > 0 para un fixture no vacío");

  let noiseComparison = null;
  if (fixture.isNoiseCase) {
    // Caso especial: repite preview+threshold+vectorize CON denoise=0 para
    // demostrar, con números reales, que el pipeline de denoise realmente
    // limpia la imagen (no es trivial de threshold-ear) -- ver
    // tests/e2e/fixtures/generate_fixtures.py, make_noise().
    const noisyPreview = await json("POST", `/api/v1/projects/${projectId}/images/${imageId}/preview`, {
      grayscale: false,
      contrast: 1.0,
      brightness: 0,
      denoise: 0,
    });
    assert(noisyPreview.status === 201, "noise: preview sin denoise falló");
    const noisyThreshold = await json("POST", `/api/v1/projects/${projectId}/images/${imageId}/threshold`, {
      previewId: noisyPreview.body.previewId,
      value: 128,
      invert: true,
    });
    assert(noisyThreshold.status === 201, "noise: threshold sin denoise falló");
    const noisyVectorize = await json("POST", `/api/v1/projects/${projectId}/images/${imageId}/vectorize`, {
      maskId: noisyThreshold.body.maskId,
    });
    assert(noisyVectorize.status === 201, "noise: vectorize sin denoise falló");
    noiseComparison = {
      nodesWithoutDenoise: noisyVectorize.body.metrics.approxNodeCount,
      nodesWithDenoise: vectorize.body.metrics.approxNodeCount,
    };
    assert(
      noiseComparison.nodesWithDenoise < noiseComparison.nodesWithoutDenoise,
      `noise: denoise debería reducir approxNodeCount (sin denoise=${noiseComparison.nodesWithoutDenoise}, ` +
        `con denoise=${noiseComparison.nodesWithDenoise}) -- el pipeline de denoise no está ejercitando nada real`,
    );
  }

  // 5) Simplify preview (reversible, sin persistir)
  const simplifyPreview = await time("simplifyPreview", () =>
    json("POST", `/api/v1/projects/${projectId}/images/${imageId}/simplify/preview`, {
      vectorId,
      preset: "medium",
    }),
  );
  assert(simplifyPreview.status === 200, `simplifyPreview: esperaba 200, fue ${simplifyPreview.status} (${simplifyPreview.rawText})`);
  assert(typeof simplifyPreview.body.svg === "string" && simplifyPreview.body.svg.length > 0, "simplifyPreview: falta svg");
  assert(
    simplifyPreview.body.metrics.after.approxNodeCount <= simplifyPreview.body.metrics.before.approxNodeCount,
    "simplifyPreview: nodeCount después debería ser <= antes",
  );

  // 6) Simplify apply (persiste una nueva SimplificationVersion)
  const simplifyApply = await time("simplifyApply", () =>
    json("POST", `/api/v1/projects/${projectId}/images/${imageId}/simplify/apply`, {
      vectorId,
      preset: "medium",
    }),
  );
  assert(simplifyApply.status === 201, `simplifyApply: esperaba 201, fue ${simplifyApply.status} (${simplifyApply.rawText})`);
  assert(simplifyApply.body.sourceVectorId === vectorId, "simplifyApply: sourceVectorId no coincide con el vectorId de origen");
  const simplificationId = simplifyApply.body.simplificationId;
  assert(simplificationId, "simplifyApply: falta simplificationId");

  // 7) Check (Laser Checker, solo lectura) sobre la simplificación aplicada
  const check = await time("check", () =>
    json("POST", `/api/v1/projects/${projectId}/images/${imageId}/check`, {
      sourceKind: "simplification",
      sourceId: simplificationId,
    }),
  );
  assert(check.status === 200, `check: esperaba 200, fue ${check.status} (${check.rawText})`);
  assert(check.body.sourceId === simplificationId, "check: sourceId no coincide con la simplificación analizada");
  assert(check.body.sourceKind === "simplification", "check: sourceKind incorrecto");
  if (fixture.isProblematicCase) {
    // Regresión del fix de M1-S11 (ver services/python-engine/app/core/
    // path_checker.py): dos círculos congruentes en posiciones REALES
    // distintas del lienzo -- antes del fix, el checker ignoraba el
    // `transform` de cada <path> y reportaba esto como un duplicate_path
    // (falso positivo); con el fix, se resuelve el transform antes de
    // comparar, así que NO debe reportarse ningún issue.
    const { openPathCount, duplicateGroupCount } = check.body.summary;
    assert(
      duplicateGroupCount === 0,
      `check: "problematic.png" NO debería reportar duplicados (falso positivo del fix de M1-S11 ` +
        `si esto falla) -- duplicateGroupCount=${duplicateGroupCount}`,
    );
    assert(
      openPathCount === 0,
      `check: "problematic.png" no debería reportar paths abiertos -- openPathCount=${openPathCount}`,
    );
    assert(check.body.issues.length === 0, "check: no se esperaban issues para \"problematic.png\" post-fix");
    assert(
      vectorize.body.metrics.pathCount >= 2,
      `vectorize: "problematic.png" debería producir al menos 2 <path> (las dos formas congruentes) -- ` +
        `pathCount=${vectorize.body.metrics.pathCount}`,
    );
  }

  // 8) Dimensions/apply sobre la MISMA simplificación (sourceKind/sourceId encadenados)
  const dimensions = await time("dimensions", () =>
    json("POST", `/api/v1/projects/${projectId}/images/${imageId}/dimensions/apply`, {
      sourceKind: "simplification",
      sourceId: simplificationId,
      widthMm: 100,
      lockAspectRatio: true,
    }),
  );
  assert(dimensions.status === 201, `dimensions: esperaba 201, fue ${dimensions.status} (${dimensions.rawText})`);
  assert(dimensions.body.sourceId === simplificationId, "dimensions: sourceId no coincide con la simplificación de origen");
  assert(Math.abs(dimensions.body.widthMm - 100) < 1e-6, "dimensions: widthMm no coincide con lo solicitado");
  assert(dimensions.body.heightMm > 0, "dimensions: heightMm calculado debería ser > 0 (proporción bloqueada)");
  const dimensionId = dimensions.body.dimensionId;
  assert(dimensionId, "dimensions: falta dimensionId");

  // 9) Export del SVG final (sourceKind=dimension, la última etapa del pipeline)
  const exportStart = Date.now();
  const exportResponse = await fetch(
    `${API}/api/v1/projects/${projectId}/images/${imageId}/export?sourceKind=dimension&sourceId=${dimensionId}`,
  );
  stepTimes.export = Date.now() - exportStart;
  assert(exportResponse.status === 200, `export: esperaba 200, fue ${exportResponse.status}`);
  assert(
    (exportResponse.headers.get("content-type") || "").includes("image/svg+xml"),
    "export: Content-Type debería ser image/svg+xml",
  );
  assert(
    (exportResponse.headers.get("content-disposition") || "").includes("attachment"),
    "export: Content-Disposition debería forzar la descarga (attachment)",
  );
  const exportedSvg = await exportResponse.text();
  assertWellFormedSvg(exportedSvg, "export");

  const exportedWidthMm = extractMm(exportedSvg, "width");
  const exportedHeightMm = extractMm(exportedSvg, "height");
  assert(exportedWidthMm !== null && exportedWidthMm > 0, "export: width en mm ausente o no positivo en el SVG final");
  assert(exportedHeightMm !== null && exportedHeightMm > 0, "export: height en mm ausente o no positivo en el SVG final");
  assert(Math.abs(exportedWidthMm - 100) < 1e-6, "export: width del SVG exportado no coincide con las dimensiones aplicadas");
  assert(/viewBox="[^"]+"/.test(exportedSvg), "export: falta viewBox en el SVG final");

  const totalMs = Date.now() - start;
  report.push({
    fixture: fixture.file,
    label: fixture.label,
    totalMs,
    stepTimes,
    pathCount: vectorize.body.metrics.pathCount,
    approxNodeCount: vectorize.body.metrics.approxNodeCount,
    reductionPercent: simplifyApply.body.metrics.reductionPercent,
    openPathCount: check.body.summary.openPathCount,
    duplicateGroupCount: check.body.summary.duplicateGroupCount,
    exportedWidthMm,
    exportedHeightMm,
    noiseComparison,
  });
}

function printReport(report) {
  console.log("\n=== Reporte E2E completo (M1-S11) ===\n");
  for (const r of report) {
    console.log(`- ${r.fixture} (${r.label})`);
    console.log(`  tiempo total: ${r.totalMs} ms`);
    console.log(
      `  pasos (ms): ${Object.entries(r.stepTimes)
        .map(([step, ms]) => `${step}=${ms}`)
        .join(", ")}`,
    );
    console.log(`  vectorize: pathCount=${r.pathCount}, approxNodeCount=${r.approxNodeCount}`);
    console.log(`  simplify: reductionPercent=${r.reductionPercent.toFixed(1)}%`);
    console.log(`  check: openPathCount=${r.openPathCount}, duplicateGroupCount=${r.duplicateGroupCount}`);
    console.log(`  export: ${r.exportedWidthMm}mm x ${r.exportedHeightMm.toFixed(3)}mm`);
    if (r.noiseComparison) {
      console.log(
        `  denoise: approxNodeCount sin denoise=${r.noiseComparison.nodesWithoutDenoise}, ` +
          `con denoise=${r.noiseComparison.nodesWithDenoise}`,
      );
    }
    console.log("");
  }
  const totalMs = report.reduce((sum, r) => sum + r.totalMs, 0);
  console.log(`Tiempo total de la corrida completa (${report.length} fixtures): ${totalMs} ms`);
}

async function main() {
  console.log(`E2E completo M1-S11 contra ${API} -- ${FIXTURES.length} fixtures.`);
  const report = [];
  const failures = [];

  for (const fixture of FIXTURES) {
    try {
      await runPipeline(fixture, report);
      console.log(`OK: ${fixture.file} completó el pipeline entero sin pasos manuales.`);
    } catch (error) {
      failures.push({ fixture: fixture.file, error });
      console.error(`FALLO en ${fixture.file}: ${error.message}`);
    }
  }

  printReport(report);

  if (failures.length > 0) {
    console.error(`\n${failures.length}/${FIXTURES.length} fixtures fallaron:`);
    for (const failure of failures) {
      console.error(`- ${failure.fixture}: ${failure.error.message}`);
    }
    process.exit(1);
  }

  console.log(`\nOK: ${FIXTURES.length}/${FIXTURES.length} fixtures completaron el pipeline E2E completo.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
