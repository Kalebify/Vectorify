import { describe, expect, it } from "vitest";
import { sanitizeReturnUrl } from "./returnUrl";
import { buildAuthSearch, readReturnUrl } from "./authLocation";

const ORIGIN = "https://app.vectorify.test";

function sanitize(raw: string | null | undefined): string | null {
  return sanitizeReturnUrl(raw, ORIGIN, "/");
}

describe("sanitizeReturnUrl — anti open redirect (M3.1-S05)", () => {
  it.each([
    ["//evil.com", "esquema relativo al protocolo"],
    ["///evil.com", "tres barras"],
    ["https://evil.com", "URL absoluta https"],
    ["http://evil.com/", "URL absoluta http"],
    ["javascript:alert(1)", "esquema javascript"],
    ["JaVaScRiPt:alert(1)", "esquema javascript con mayúsculas"],
    ["data:text/html,<script>alert(1)</script>", "esquema data"],
    ["/\\evil.com", "barra + barra invertida"],
    ["\\\\evil.com", "dos barras invertidas"],
    ["\\evil.com", "barra invertida inicial"],
    ["/?next=\\evil.com", "barra invertida dentro de la consulta"],
    ["%2f%2fevil.com", "// codificado"],
    ["%2F%2Fevil.com", "// codificado en mayúsculas"],
    ["/%2f%2fevil.com", "ruta con // codificado"],
    ["/\t/evil.com", "tabulación que el parser elimina (queda //evil.com)"],
    ["/\n/evil.com", "salto de línea que el parser elimina"],
    ["/\r/evil.com", "retorno de carro que el parser elimina"],
    [" //evil.com", "espacio inicial"],
    ["", "vacío"],
    ["   ", "solo espacios"],
    ["evil.com", "sin barra inicial"],
    ["/otra-ruta?x=1", "otra ruta de la misma app que no existe"],
    ["/?view=login", "vista de login (bucle)"],
    ["/?view=register&x=1", "vista de registro (bucle)"],
  ])("rechaza %j (%s)", (payload) => {
    expect(sanitize(payload)).toBeNull();
  });

  it("rechaza null, undefined y valores desmesurados", () => {
    expect(sanitize(null)).toBeNull();
    expect(sanitize(undefined)).toBeNull();
    expect(sanitize(`/?x=${"a".repeat(3000)}`)).toBeNull();
  });

  it("acepta la raíz y conserva el deep link del Workspace con todos sus query params", () => {
    expect(sanitize("/")).toBe("/");
    const deepLink = "/?projectId=p1&imageId=i1&paletteId=pal1&savedProjectId=s1";
    expect(sanitize(deepLink)).toBe(deepLink);
    expect(sanitize("/?view=new")).toBe("/?view=new");
  });

  it("descarta el fragmento", () => {
    expect(sanitize("/?view=new#//evil.com")).toBe("/?view=new");
  });

  it("buildAuthSearch solo incluye un returnUrl válido; readReturnUrl lo revalida al leer", () => {
    expect(buildAuthSearch("login", "//evil.com")).toBe("?view=login");
    expect(buildAuthSearch("login", "/?view=new")).toBe("?view=login&returnUrl=%2F%3Fview%3Dnew");
    expect(readReturnUrl("?view=login&returnUrl=%2F%2Fevil.com")).toBeNull();
    expect(readReturnUrl("?view=login&returnUrl=https%3A%2F%2Fevil.com")).toBeNull();
    expect(readReturnUrl("?view=login&returnUrl=")).toBeNull();
    expect(readReturnUrl("?view=login")).toBeNull();
    expect(readReturnUrl("?view=login&returnUrl=%2F%3Fview%3Dnew")).toBe("/?view=new");
  });
});
