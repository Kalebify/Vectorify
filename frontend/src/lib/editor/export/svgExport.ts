import { frameToViewBox } from "../frame";
import { serializeEditablePaths } from "../objects";
import type { EditableLayerMeta } from "../types";
import { documentSizeMm, layerObjects, orderedLayers, type ExportDocument } from "./exportDocument";

/**
 * Export SVG (M3-S15). SVG es el formato canónico: lo exportado sale de la misma serialización por objeto que el guardado (`serializeEditablePaths`), así que
 * reabrirlo con `parseEditableLayer` devuelve la misma geometría (d, relleno, trazo y matriz) y el `viewBox` es el del área de trabajo en unidades de documento.
 *
 * - Con escala física: `width`/`height` en `mm` (el `viewBox` sigue en unidades de documento; el navegador y los programas de diseño leen 1 unidad = `mmPerUnit` mm).
 * - Sin escala física: `width`/`height` sin unidad (= unidades del documento), `data-units="none"` y un `<desc>` que lo dice. Nunca se inventan milímetros.
 * - Un `<g>` por capa, con `id`, `data-layer-id`, `data-name`, `data-operation` y `data-color`, en orden de pintado.
 * - Por capa: el mismo documento con UN solo `<g>`, con el mismo `viewBox` y tamaño, para que los archivos se superpongan exactamente.
 */

const NO_SCALE_DESC = "Sin escala física: width y height están en unidades del documento, no en milímetros.";

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Número con hasta 6 decimales (precisión sub-micrométrica en mm) sin ceros sobrantes ni «-0». */
export function formatNumber(value: number, decimals = 6): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Number(value.toFixed(decimals));
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

export interface SvgBuildOptions {
  /** Tamaño en px del SVG para rasterizarlo (PNG): el `width`/`height` pasan a ser ese tamaño; el `viewBox` no cambia. */
  pixelSize?: { width: number; height: number };
}

/** Un documento SVG con las capas dadas (en el orden dado), tamaño y escala del área de trabajo. */
export function buildSvg(document: ExportDocument, layers: readonly EditableLayerMeta[], options: SvgBuildOptions = {}): string {
  const size = documentSizeMm(document);
  const { frame } = document;
  const documentOrder = orderedLayers(document.layers);

  let width: string;
  let height: string;
  let unitsAttributes: string;
  if (options.pixelSize) {
    width = String(options.pixelSize.width);
    height = String(options.pixelSize.height);
    unitsAttributes = "";
  } else if (size && document.mmFactor !== null) {
    width = `${formatNumber(size.widthMm)}mm`;
    height = `${formatNumber(size.heightMm)}mm`;
    unitsAttributes = ` data-units="mm" data-mm-per-unit="${document.mmFactor}"`;
  } else {
    width = formatNumber(frame.width);
    height = formatNumber(frame.height);
    unitsAttributes = ` data-units="none"`;
  }

  const groups = layers.map((layer) => {
    const position = documentOrder.findIndex((candidate) => candidate.groupId === layer.groupId);
    const id = `layer-${position >= 0 ? position + 1 : layer.order + 1}`;
    return (
      `<g id="${id}" data-layer-id="${escapeXml(layer.groupId)}" data-name="${escapeXml(layer.name)}" data-operation="${layer.manufacturingOperation}" data-color="${escapeXml(layer.colorHex)}">` +
      `<title>${escapeXml(layer.name)}</title>${serializeEditablePaths(layerObjects(document, layer.groupId))}</g>`
    );
  });

  const desc = !options.pixelSize && !size ? `\n<desc>${NO_SCALE_DESC}</desc>` : "";
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${frameToViewBox(frame)}"${unitsAttributes}>\n` +
    `<title>${escapeXml(document.projectName.trim() || "proyecto")}</title>${desc}\n` +
    `${groups.join("\n")}${groups.length > 0 ? "\n" : ""}</svg>\n`
  );
}
