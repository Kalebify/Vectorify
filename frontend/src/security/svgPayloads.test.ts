import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { highlightSvgPath } from "../lib/highlightSvgPath";
import { parseEditableLayer, serializeEditableLayer } from "../lib/editor/objects";
import { svgToDataUrl } from "../lib/svgToDataUrl";

/**
 * Payloads de SVG hostiles (M3.1-S09, T4): `<script>`, `onload=`, `<foreignObject>`, `<use href>`, `xlink:href`, `javascript:` y ruptura de atributo. La SPA solo toca un SVG de tres maneras:
 * como data URL en un `<img>` (el navegador nunca ejecuta script dentro de un `<img>`), parseado a un documento DESACOPLADO con DOMParser (nunca adjunto al DOM) para resaltar un path,
 * o convertido a objetos `{d, fill, matrix}` que Konva dibuja en un canvas. Estos tests fijan que ningún camino deja pasar el payload a algo ejecutable.
 */

const NS = 'xmlns="http://www.w3.org/2000/svg"';
const XLINK = 'xmlns:xlink="http://www.w3.org/1999/xlink"';

const PAYLOADS: Record<string, string> = {
  script: `<svg ${NS}><script>window.__pwned = "script"</script><path d="M0 0L10 10Z" fill="#ff0000"/></svg>`,
  onload: `<svg ${NS} onload="window.__pwned = 'onload'"><path d="M0 0L10 0L10 10Z" fill="#00ff00" onclick="window.__pwned = 'onclick'"/></svg>`,
  foreignObject:
    `<svg ${NS}><foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="window.__pwned = 'fo'"/>` +
    `<script>window.__pwned = 'fo-script'</script></div></foreignObject><path d="M0 0L5 5Z" fill="#0000ff"/></svg>`,
  useHref: `<svg ${NS} ${XLINK}><use href="https://evil.example/x.svg#a"/><use xlink:href="data:image/svg+xml;base64,PHN2Zy8+#a"/><path d="M0 0L1 1Z" fill="#000000"/></svg>`,
  javascriptHref: `<svg ${NS} ${XLINK}><a xlink:href="javascript:window.__pwned = 'js'"><path d="M0 0L2 2Z" fill="#111111"/></a></svg>`,
  attributeBreakout: `<svg ${NS}><path d="M0 0L3 3Z" fill="red&quot; onload=&quot;window.__pwned = 'break'"/></svg>`,
  styleExfil: `<svg ${NS}><style>path { fill: url(https://evil.example/leak) }</style><path d="M0 0L4 4Z" fill="#222222"/></svg>`,
};

const DANGEROUS = /<script|onload|onclick|onerror|foreignObject|<use|<style|xlink:href|href\s*=|javascript:|<iframe|<img/i;

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__pwned = undefined;
});

afterEach(() => {
  expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined(); // nada se ejecutó en ningún test
});

describe("svgToDataUrl: el SVG viaja codificado, solo como valor de src de un <img>", () => {
  for (const [name, payload] of Object.entries(PAYLOADS)) {
    it(`${name}: la data URL no contiene markup sin codificar y recompone el original`, () => {
      const url = svgToDataUrl(payload);

      expect(url.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
      const encoded = url.slice("data:image/svg+xml;charset=utf-8,".length);
      expect(encoded).not.toMatch(/[<>"\s#]/);
      expect(decodeURIComponent(encoded)).toBe(payload);
    });

    it(`${name}: asignarla a un <img> no añade nodos ni ejecuta nada`, () => {
      const before = document.documentElement.outerHTML;
      const image = document.createElement("img");
      image.src = svgToDataUrl(payload);
      document.body.appendChild(image);

      expect(document.querySelectorAll("script").length).toBe(0);
      expect(document.body.querySelectorAll("foreignObject, use, svg").length).toBe(0);
      image.remove();
      expect(document.documentElement.outerHTML).toBe(before);
    });
  }
});

describe("highlightSvgPath: trabaja sobre un documento desacoplado y devuelve texto", () => {
  for (const [name, payload] of Object.entries(PAYLOADS)) {
    it(`${name}: no adjunta nada al DOM real ni ejecuta el payload`, () => {
      const before = document.documentElement.outerHTML;

      const result = highlightSvgPath(payload, [0]);

      expect(typeof result).toBe("string");
      expect(document.documentElement.outerHTML).toBe(before);
      expect(document.querySelectorAll("script, svg, foreignObject").length).toBe(0);
    });
  }

  it("el texto resaltado sigue yendo solo a un <img> (data URL), nunca a innerHTML", () => {
    const url = svgToDataUrl(highlightSvgPath(PAYLOADS.script, [0]));

    expect(url.startsWith("data:image/svg+xml")).toBe(true);
    expect(url).not.toContain("<");
  });
});

describe("el editor: de un SVG solo salen objetos {d, fill, matrix}, y al serializar solo <path> con atributos escapados", () => {
  for (const [name, payload] of Object.entries(PAYLOADS)) {
    it(`${name}: parsear + serializar no conserva nada ejecutable`, () => {
      const objects = parseEditableLayer(payload, "grupo", "#123456");
      const serialized = serializeEditableLayer(objects, { width: 10, height: 10 });

      expect(objects.every((o) => typeof o.d === "string" && typeof o.fill === "string")).toBe(true);
      // (attributeBreakout conserva el TEXTO «onload=» dentro del valor de fill, escapado: no es un atributo; se comprueba aparte y por estructura.)
      if (name !== "attributeBreakout") expect(serialized).not.toMatch(DANGEROUS);
      // Solo hay <svg> envolvente y <path>.
      const doc = new DOMParser().parseFromString(serialized, "image/svg+xml");
      expect(doc.getElementsByTagName("parsererror").length).toBe(0);
      const tags = new Set(Array.from(doc.getElementsByTagName("*")).map((el) => el.tagName));
      expect([...tags].every((tag) => tag === "svg" || tag === "path")).toBe(true);
      // Los atributos que sobreviven no tienen manejadores de eventos.
      for (const element of Array.from(doc.getElementsByTagName("*"))) {
        for (const attribute of Array.from(element.attributes)) {
          expect(attribute.name.toLowerCase().startsWith("on")).toBe(false);
        }
      }
    });
  }

  it("un fill que intenta romper el atributo queda escapado: no crea un atributo nuevo al volver a parsear", () => {
    const objects = parseEditableLayer(PAYLOADS.attributeBreakout, "grupo", "#123456");
    const serialized = serializeEditableLayer(objects, { width: 10, height: 10 });

    expect(serialized).toContain("&quot;");
    const path = new DOMParser().parseFromString(serialized, "image/svg+xml").getElementsByTagName("path")[0];
    expect(path.hasAttribute("onload")).toBe(false);
    expect(path.getAttribute("fill")).toContain('onload="');
  });
});
