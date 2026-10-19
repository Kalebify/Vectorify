import { describe, expect, it } from "vitest";

/**
 * Auditoría XSS de M3.1-S09 (T4 del ADR), vigilada: el código de producción de la SPA NO tiene ninguna vía para inyectar HTML/SVG/JS desde datos del servidor o del usuario.
 * React escapa por defecto; estas son las salidas de emergencia que lo desactivan. Si una tarjeta futura necesita una de ellas, este test obliga a justificarlo (añadiéndola a
 * `ALLOWED` con el motivo y, para HTML no confiable, sanitizando) en vez de colarla sin revisión. Lee el código fuente como texto (`import.meta.glob ... ?raw`, como
 * `authBoundary.architecture.test.ts`).
 */

const SOURCES = import.meta.glob(
  ["/src/**/*.{ts,tsx}", "!/src/**/*.test.{ts,tsx}", "!/src/test/**", "!/src/security/**", "!/src/**/*TestSupport.ts"],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

const FORBIDDEN: { name: string; pattern: RegExp }[] = [
  { name: "dangerouslySetInnerHTML (prop)", pattern: /dangerouslySetInnerHTML\s*=/ },
  { name: ".innerHTML = / .outerHTML =", pattern: /\.(inner|outer)HTML\s*[+]?=/ },
  { name: "insertAdjacentHTML", pattern: /\.insertAdjacentHTML\s*\(/ },
  { name: "document.write", pattern: /document\.write(ln)?\s*\(/ },
  { name: "eval / new Function", pattern: /(^|[^.\w])eval\s*\(|new\s+Function\s*\(/ },
  { name: "setTimeout/setInterval con cadena", pattern: /set(Timeout|Interval)\s*\(\s*["'`]/ },
  { name: "createContextualFragment", pattern: /createContextualFragment\s*\(/ },
  { name: "srcdoc", pattern: /\bsrcDoc\s*=|\.srcdoc\s*=/ },
  { name: "window.open / location asignado", pattern: /window\.open\s*\(|location\.(href|assign|replace)\s*[=(]/ },
  { name: "<iframe>/<embed>/<object> en JSX", pattern: /(^|[\s(>{])<(iframe|embed|object)[\s/>]/m },
  { name: "javascript: URL", pattern: /["'`]javascript:/ },
];

/** Excepciones revisadas a mano (ruta → motivo). Hoy ninguna. */
const ALLOWED: Record<string, string> = {};

/** Quita comentarios para no marcar la documentación que NOMBRA estas APIs (varios archivos explican por qué NO las usan). */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

describe("la SPA no tiene vías de inyección de HTML/SVG/JS", () => {
  const files = Object.entries(SOURCES);

  it("recorre el código de producción (no vacío)", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  for (const { name, pattern } of FORBIDDEN) {
    it(`ningún archivo de producción usa ${name}`, () => {
      const offenders = files
        .filter(([path, source]) => !(path in ALLOWED) && pattern.test(withoutComments(source)))
        .map(([path]) => path);
      expect(offenders).toEqual([]);
    });
  }

  it("los lectores de SVG como texto (fetch .text()) están en una lista cerrada y revisada", () => {
    const readers = files
      .filter(([, source]) => /fetchSvgText|\.text\(\)/.test(source))
      .map(([path]) => path)
      .sort();
    // Cada uno termina en DOMParser (documento desacoplado) o en un <img> con data URL; añadir otro exige revisarlo.
    expect(readers.every((path) => /\/api\/|\/hooks\/|\/components\/(check|simplify|editor)\//.test(path))).toBe(true);
  });
});
