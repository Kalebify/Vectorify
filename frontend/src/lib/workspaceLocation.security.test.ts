import { describe, expect, it } from "vitest";
import { readAppView, readWorkspaceLocation } from "./workspaceLocation";

/**
 * Client-side path traversal (M3.1-S09): los ids de la URL se interpolan en rutas de la API. Un enlace fabricado con `projectId=../auth/logout-all?x=` haría que el navegador de la
 * víctima, con su cookie y la cabecera anti-CSRF, pidiera OTRA ruta de la API. `readWorkspaceLocation` solo acepta ids opacos (letras, dígitos, «-» y «_»).
 */
const GOOD = "11111111-1111-1111-1111-111111111111";

function search(overrides: Record<string, string>): string {
  const params = new URLSearchParams({ projectId: GOOD, imageId: GOOD, paletteId: GOOD, ...overrides });
  return `?${params.toString()}`;
}

describe("readWorkspaceLocation rechaza ids que no son opacos", () => {
  it("acepta GUID y ids alfanuméricos", () => {
    expect(readWorkspaceLocation(search({}))).toEqual({ projectId: GOOD, imageId: GOOD, paletteId: GOOD });
    expect(readWorkspaceLocation(search({ projectId: "abc_DEF-123" }))?.projectId).toBe("abc_DEF-123");
    expect(readWorkspaceLocation(search({ savedProjectId: GOOD }))?.savedProjectId).toBe(GOOD);
  });

  for (const hostile of [
    "../auth/logout-all?x=",
    "..",
    "a/b",
    "a\b",
    "a?b=c",
    "a#b",
    "%2e%2e%2fauth",
    "a b",
    "a.b",
    "javascript:alert(1)",
    "<script>",
    "a".repeat(65),
  ]) {
    it(`rechaza «${hostile.length > 20 ? hostile.slice(0, 20) + "…" : hostile}» en cada uno de los ids`, () => {
      for (const key of ["projectId", "imageId", "paletteId", "savedProjectId"]) {
        expect(readWorkspaceLocation(search({ [key]: hostile }))).toBeNull();
      }
    });
  }

  it("un deep-link con un id hostil no abre el Workspace: la vista cae al dashboard", () => {
    expect(readAppView(search({ projectId: "../auth/logout-all?x=" }))).toBe("dashboard");
  });
});
