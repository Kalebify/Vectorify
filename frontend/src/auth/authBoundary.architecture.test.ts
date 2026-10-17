import { describe, expect, it } from "vitest";

/**
 * Test de arquitectura (M3.1-S05, DoD de la tarjeta: «las pantallas de producto no implementan autenticación ad hoc»).
 *
 * Lee el código fuente de `src/` (con `import.meta.glob ... ?raw`, el mismo mecanismo que `commandCoverage.test.ts` usa para los docs) y
 * hace cumplir dos reglas sobre TODO lo que no es el módulo de auth ni su composición:
 *  1. Ningún archivo de producto (Mis proyectos, Editor/Workspace, flujo clásico, hooks, lib, resto de la API) importa el cliente de
 *     auth (`authApi`), el módulo `auth/`, la frontera de sesión (`sessionBoundary`) ni los tipos de auth.
 *  2. Ningún archivo de producto gestiona un 401 ad hoc (comparar contra 401, `isUnauthorizedError`, `onSessionExpired`, ...): el 401 lo
 *     centraliza `httpClient` + `sessionBoundary` y lo consume el `AuthProvider`.
 * Las pantallas reciben el menú de cuenta como slot (`ReactNode`) desde `AppRoot`, que es el único lugar de composición.
 */

const SOURCES = import.meta.glob(["/src/**/*.{ts,tsx}", "!/src/**/*.test.{ts,tsx}", "!/src/test/**", "!/src/**/*TestSupport.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Archivos autorizados a conocer la autenticación (todo lo demás es «producto»). */
function isAuthAware(path: string): boolean {
  return (
    path.startsWith("/src/auth/") ||
    path === "/src/AppRoot.tsx" ||
    path === "/src/main.tsx" ||
    path === "/src/api/authApi.ts" ||
    path === "/src/api/sessionBoundary.ts" ||
    path === "/src/api/httpClient.ts" || // única llamada a reportUnauthorized: el 401 se detecta en UN solo sitio
    path === "/src/types/auth.ts"
  );
}

/** Quita comentarios (`//` y `/* *\/`) para no confundir documentación con código. Aproximación suficiente para este chequeo. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

const IMPORT_SPECIFIER = /(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g;

function importedModules(source: string): string[] {
  return [...stripComments(source).matchAll(IMPORT_SPECIFIER)].map((match) => match[1]);
}

const FORBIDDEN_IMPORT = /(^|\/)(auth|authApi|sessionBoundary)(\/|$)|(^|\/)types\/auth$|\/AppRoot$/;

const AD_HOC_AUTH_HANDLING: { pattern: RegExp; description: string }[] = [
  { pattern: /\b401\b/, description: "compara o menciona el código 401" },
  { pattern: /\bisUnauthorizedError\b/, description: "usa isUnauthorizedError" },
  { pattern: /\bonSessionExpired\b/, description: "se suscribe a onSessionExpired" },
  { pattern: /\breportUnauthorized\b/, description: "llama a reportUnauthorized" },
  { pattern: /\brearmSessionBoundary\b/, description: "llama a rearmSessionBoundary" },
  { pattern: /\buseAuth\b/, description: "usa useAuth" },
  { pattern: /[?&]returnUrl=|\bview=login\b|\bview=register\b/, description: "construye URLs de login/registro" },
  { pattern: /\/api\/v1\/auth\//, description: "llama a endpoints de /api/v1/auth/" },
];

export function findAuthViolations(path: string, source: string): string[] {
  if (isAuthAware(path)) return [];
  const violations: string[] = [];

  for (const specifier of importedModules(source)) {
    if (FORBIDDEN_IMPORT.test(specifier)) {
      violations.push(`${path}: importa «${specifier}»`);
    }
  }

  const code = stripComments(source);
  for (const { pattern, description } of AD_HOC_AUTH_HANDLING) {
    if (pattern.test(code)) {
      violations.push(`${path}: ${description}`);
    }
  }

  return violations;
}

const productFiles = Object.entries(SOURCES).filter(([path]) => !isAuthAware(path));

describe("arquitectura de autenticación: las pantallas de producto no la implementan (M3.1-S05)", () => {
  it("el escaneo ve el código de producto relevante (no es un test vacío)", () => {
    const paths = Object.keys(SOURCES);
    expect(productFiles.length).toBeGreaterThan(100);
    expect(paths).toContain("/src/App.tsx");
    expect(paths).toContain("/src/components/projects/ProjectsDashboard.tsx");
    expect(paths).toContain("/src/components/projects/ProjectDialog.tsx");
    expect(paths).toContain("/src/components/editor/EditorShell.tsx");
    expect(paths).toContain("/src/components/upload/UploadPanel.tsx");
    expect(paths).toContain("/src/api/projectsV2Api.ts");
    expect(paths).toContain("/src/api/authApi.ts");
    expect(paths).toContain("/src/auth/AuthProvider.tsx");
  });

  it("Mis proyectos, Editor/Workspace, flujo clásico, hooks, lib y el resto de la API NO importan auth ni gestionan 401 ad hoc", () => {
    const violations = productFiles.flatMap(([path, source]) => findAuthViolations(path, source));
    expect(violations).toEqual([]);
  });

  it("App.tsx, ProjectsDashboard y EditorShell reciben el menú como slot: no conocen el módulo de auth", () => {
    for (const path of [
      "/src/App.tsx",
      "/src/components/projects/ProjectsDashboard.tsx",
      "/src/components/editor/EditorShell.tsx",
      "/src/components/editor/EditorHeader.tsx",
    ]) {
      expect(importedModules(SOURCES[path]).filter((specifier) => /auth/i.test(specifier)), path).toEqual([]);
    }
  });

  it("solo AppRoot (y el propio módulo de auth) importan el cliente de auth y la frontera de sesión", () => {
    const importers = Object.entries(SOURCES)
      .filter(([, source]) => importedModules(source).some((specifier) => /(^|\/)(authApi|sessionBoundary)$/.test(specifier)))
      .map(([path]) => path)
      .sort();

    expect(importers.filter((path) => !isAuthAware(path))).toEqual([]);
    // Y el módulo de auth sí los usa (el chequeo no es vacuo).
    expect(importers).toContain("/src/auth/AuthProvider.tsx");
  });

  describe("el detector detecta de verdad (pruebas del propio chequeo)", () => {
    it("marca un import de authApi, de auth/ o de sessionBoundary desde una pantalla de producto", () => {
      expect(findAuthViolations("/src/components/projects/X.tsx", `import { login } from "../../api/authApi";`)).not.toEqual([]);
      expect(findAuthViolations("/src/components/projects/X.tsx", `import { useAuth } from "../../auth/authContext";`)).not.toEqual([]);
      expect(findAuthViolations("/src/hooks/x.ts", `import { onSessionExpired } from "../api/sessionBoundary";`)).not.toEqual([]);
      expect(findAuthViolations("/src/lib/x.ts", `const m = await import("../types/auth");`)).not.toEqual([]);
    });

    it("marca el manejo ad hoc de 401 en una pantalla de producto", () => {
      expect(findAuthViolations("/src/components/editor/X.tsx", `if (error.status === 401) { window.location.href = "/login"; }`)).not.toEqual([]);
      expect(findAuthViolations("/src/components/editor/X.tsx", `window.location.assign("/?view=login&returnUrl=x")`)).not.toEqual([]);
    });

    it("no marca comentarios que mencionan 401 ni el propio módulo de auth", () => {
      expect(findAuthViolations("/src/components/projects/X.tsx", `// un 401 lo maneja el cliente HTTP\n/* 401 */ const a = 1;`)).toEqual([]);
      expect(findAuthViolations("/src/auth/AuthProvider.tsx", `if (status === 401) {}`)).toEqual([]);
      expect(findAuthViolations("/src/AppRoot.tsx", `import { AuthProvider } from "./auth/AuthProvider";`)).toEqual([]);
    });
  });
});
