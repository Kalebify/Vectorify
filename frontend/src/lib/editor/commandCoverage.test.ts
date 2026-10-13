import { describe, expect, it } from "vitest";
import editorCommandsDoc from "../../../../docs/EDITOR_COMMANDS.md?raw";
import adrDoc from "../../../../docs/ADR_EDITOR_MVP3.md?raw";
import { COMMAND_REGISTRY, COMMAND_TYPES, isCommandType, type CommandType } from "./commands";
import { EXECUTABLE_TYPES } from "./commandExecutor";

/**
 * Cobertura total de comandos (M3-S12). Estas pruebas FALLAN cuando:
 * - aparece un `applyEdit` / `commitGesture` / `runEdit` sin `CommandDraft` (sin tipo);
 * - un literal de tipo de comando no está en el registro (typo, tipo viejo);
 * - un tipo del registro no tiene NINGÚN emisor en el código de producción;
 * - un tipo del registro no lo afirma ninguna prueba de una ruta real (UI o ejecutor);
 * - la documentación (`docs/EDITOR_COMMANDS.md`) no menciona un tipo o uno de sus parámetros.
 * Leen el código fuente como texto (`import.meta.glob` con `?raw`): son una red de seguridad estática que complementa el chequeo del compilador y el
 * `checkDraft` en ejecución (que lanza ante un borrador sin tipo válido).
 */

// Las claves de `import.meta.glob` son relativas a ESTE archivo (`./commands.ts`, `../../test/commands.ts`): se normalizan a `src/...`.
const RAW = import.meta.glob("../../**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

function fromSrc(key: string): string {
  const parts = ["src", "lib", "editor"];
  for (const part of key.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== ".") parts.push(part);
  }
  return parts.join("/");
}

const FILES = Object.entries(RAW).map(([key, source]) => [fromSrc(key), source] as const);
const isTestFile = (path: string) => /.test.(ts|tsx)$/.test(path) || path.startsWith("src/test/");
const production = FILES.filter(([path]) => !isTestFile(path));
const tests = FILES.filter(([path]) => isTestFile(path));

// Quita los comentarios de línea y de bloque preservando los saltos de línea, para no confundir la documentación con código.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

const TYPE_LITERAL = /"((?:object|path|document|selection|arrange|geometry|layer)\.[A-Za-z]+(?:\.[A-Za-z]+)?)"/g;

describe("cobertura de comandos: ningún applyEdit / commitGesture sin tipo", () => {
  it("hay call-sites reales que auditar (si esto da 0 el escáner está roto)", () => {
    const names = new Set<string>();
    for (const [path, source] of production) {
      for (const match of stripComments(source).matchAll(/\b(applyEdit|commitGesture|runEdit|applyClipboardEdit)\(/g)) names.add(`${path.split("/").pop()}:${match[1]}`);
    }
    for (const expected of [
      "VectorCanvas.tsx:applyEdit",
      "VectorCanvas.tsx:commitGesture",
      "EditorShell.tsx:applyEdit",
      "EditorShell.tsx:applyClipboardEdit",
      "useCutTool.ts:applyEdit",
      "useFloatingTool.ts:applyEdit",
      "useDrawEraseTools.ts:applyEdit",
      "usePathTool.ts:runEdit",
      "usePathTool.ts:commitGesture",
      "commandExecutor.ts:applyEdit",
    ]) {
      expect(names, expected).toContain(expected);
    }
  });

  it("el primer argumento de CADA llamada es un CommandDraft con tipo del registro (objeto literal con `type`, o un borrador ya armado)", () => {
    const BUILT_DRAFTS = new Set(["draft", "pasteDraft", "checked", "command"]);
    const problems: string[] = [];
    let inspected = 0;
    for (const [path, source] of production) {
      const code = stripComments(source);
      for (const match of code.matchAll(/\b(applyEdit|commitGesture|runEdit|applyClipboardEdit)\(\s*([\s\S]{0,700})/g)) {
        const where = `${path.split("/").pop()}:${code.slice(0, match.index).split("\n").length}`;
        const rest = match[2];
        inspected += 1;
        if (rest.startsWith("{")) {
          // Objeto literal: hasta el cierre de su llave (balanceando).
          let depth = 0;
          let end = 0;
          for (let index = 0; index < rest.length; index += 1) {
            if (rest[index] === "{") depth += 1;
            if (rest[index] === "}") {
              depth -= 1;
              if (depth === 0) {
                end = index;
                break;
              }
            }
          }
          const literal = rest.slice(0, end + 1);
          if (!/\btype\s*:/.test(literal)) problems.push(`${where}: el borrador no declara «type»`);
          const types = [...literal.matchAll(TYPE_LITERAL)].map((found) => found[1]);
          if (types.length === 0) problems.push(`${where}: el «type» del borrador no es un literal del registro`);
          for (const type of types) if (!isCommandType(type)) problems.push(`${where}: «${type}» no es un tipo del registro`);
        } else {
          const first = /^([A-Za-z_][\w.]*)(\()?/.exec(rest);
          const name = first?.[1] ?? "";
          const builder = first?.[2] ? ["colorDraft", "arrangeDraft", "layerMetaDraft"].includes(name) : BUILT_DRAFTS.has(name);
          if (!builder) problems.push(`${where}: el primer argumento «${rest.slice(0, 40).replace(/\s+/g, " ")}…» no es un CommandDraft conocido`);
        }
      }
    }
    expect(inspected).toBeGreaterThanOrEqual(25);
    expect(problems).toEqual([]);
  });

  it("todo literal «grupo.tipo» del código de producción es un tipo del registro (sin typos ni tipos viejos)", () => {
    const unknown: string[] = [];
    for (const [path, source] of production) {
      for (const match of stripComments(source).matchAll(TYPE_LITERAL)) {
        if (!isCommandType(match[1])) unknown.push(`${path.split("/").pop()}: ${match[1]}`);
      }
    }
    expect(unknown).toEqual([]);
  });
});

describe("cobertura de comandos: cada tipo del registro lo emite alguna ruta real", () => {
  const productionExceptRegistry = production.filter(([path]) => path !== "src/lib/editor/commands.ts");
  // `layerMetaDraft` (dentro de commands.ts) es el emisor de los cinco tipos de metadata de capa: solo ESA función cuenta.
  const registrySource = production.find(([path]) => path === "src/lib/editor/commands.ts")![1];
  const metaDraftSource = registrySource.slice(registrySource.indexOf("export function layerMetaDraft"), registrySource.indexOf("// ---- (De)serialización"));

  it("el código de producción tiene un EMISOR de cada tipo (literal fuera del registro, o dentro de layerMetaDraft)", () => {
    const withoutEmitter = COMMAND_TYPES.filter((type) => {
      const literal = `"${type}"`;
      return !productionExceptRegistry.some(([, source]) => stripComments(source).includes(literal)) && !stripComments(metaDraftSource).includes(literal);
    });
    expect(withoutEmitter).toEqual([]);
  });

  /** Archivos de prueba de RUTAS reales: el Workspace completo, las herramientas, el canvas y el ejecutor. */
  const routeTests = tests.filter(([path]) => /EditorShell\.[a-z]+\.test\.tsx$|VectorCanvas\.test\.tsx$|use(Cut|Floating|DrawErase|Path)Tool\.test\.tsx$|commandExecutor\.test\.tsx$/.test(path));

  it("hay archivos de prueba de rutas (si esto da 0 el filtro está roto)", () => {
    expect(routeTests.length).toBeGreaterThanOrEqual(14);
  });

  it("cada tipo del registro lo afirma al menos una prueba de ruta real", () => {
    const unasserted = COMMAND_TYPES.filter((type) => !routeTests.some(([, source]) => source.includes(`"${type}"`)));
    expect(unasserted).toEqual([]);
  });

  it("los tipos de la UI los afirma una prueba del Workspace/canvas/herramientas (no solo el ejecutor)", () => {
    const uiTests = routeTests.filter(([path]) => !path.endsWith("commandExecutor.test.tsx"));
    // `layer.create` es implícito: la UI no lo emite sola (Fill / Draw lo crean DENTRO de su comando), solo el ejecutor.
    const implicit = COMMAND_TYPES.filter((type) => COMMAND_REGISTRY[type].implicit);
    expect(implicit).toEqual(["layer.create"]);
    const notAssertedByUi = COMMAND_TYPES.filter((type) => !implicit.includes(type) && !uiTests.some(([, source]) => source.includes(`"${type}"`)));
    expect(notAssertedByUi).toEqual([]);
  });

  it("el ejecutor sabe ejecutar exactamente los tipos que el registro declara ejecutables", () => {
    expect([...EXECUTABLE_TYPES].sort()).toEqual(COMMAND_TYPES.filter((type) => COMMAND_REGISTRY[type].executable).sort());
  });

  it("los tipos no ejecutables explican por qué", () => {
    for (const type of COMMAND_TYPES.filter((candidate) => !COMMAND_REGISTRY[candidate].executable)) expect(COMMAND_REGISTRY[type].reason, type).toBeTruthy();
  });
});

describe("documentación: docs/EDITOR_COMMANDS.md y el ADR (D2)", () => {
  const sections = new Map<string, string>();
  for (const part of editorCommandsDoc.split(/\n#### `/).slice(1)) {
    const type = part.slice(0, part.indexOf("`"));
    sections.set(type, part);
  }

  it("documenta los 44 tipos, cada uno con su sección", () => {
    expect(COMMAND_TYPES).toHaveLength(44);
    expect([...sections.keys()].sort()).toEqual([...COMMAND_TYPES].sort());
  });

  it("cada sección lista TODOS los parámetros del tipo y dice si es ejecutable", () => {
    for (const type of COMMAND_TYPES as readonly CommandType[]) {
      const section = sections.get(type)!;
      const spec = COMMAND_REGISTRY[type];
      for (const name of Object.keys(spec.params)) expect(section, `${type}.${name}`).toContain(`| \`${name}\` |`);
      expect(section, type).toContain(`**Ejecutable por el ejecutor declarativo:** ${spec.executable ? "sí" : "no —"}`);
      if (!spec.executable) expect(section, type).toContain(spec.reason!);
    }
  });

  it("explica la forma de EditorCommand v1, el alcance del reload, el PATCH inverso y el ejecutor", () => {
    for (const expected of ["`version`", "`sequence`", "`targets`", "`origin`", "`timestamp`", "HistoryEntry", "jumpTo", "PATCH", "reload", "executeCommand", "raw_geometry", "El historial dura mientras la sesión esté abierta"]) {
      expect(editorCommandsDoc, expected).toContain(expected);
    }
  });

  it("el ADR D2 documenta el EditorCommand v1, el historial y apunta a la referencia", () => {
    const d2 = adrDoc.slice(adrDoc.indexOf("### D2."), adrDoc.indexOf("### D3."));
    for (const expected of ["EditorCommand", "HistoryEntry", "docs/EDITOR_COMMANDS.md", "M3-S12", "jumpTo", "PATCH"]) expect(d2, expected).toContain(expected);
  });
});
