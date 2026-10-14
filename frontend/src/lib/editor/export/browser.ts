import type { Rasterizer } from "./pngExport";

/**
 * Capa fina con el DOM del export (M3-S15): rasterizado del PNG con `<canvas>` y descarga con `Blob` + `<a download>`. Es lo único del export que toca el navegador y
 * entra por parámetro (`Rasterizer`, `DownloadFile`), así la lógica y los tests no dependen de él. No se puede probar bajo jsdom (no decodifica imágenes SVG): ver
 * `docs/EXPORT_FORMATOS.md`, «Qué NO se validó».
 */

export interface DownloadableFile {
  name: string;
  mime: string;
  data: Uint8Array;
}

/** Entrega el archivo al usuario. Inyectable: los tests lo reemplazan por un espía. */
export type DownloadFile = (file: DownloadableFile) => void;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("el navegador no pudo dibujar el SVG"));
    image.src = url;
  });
}

/** Rasteriza el SVG en un `<canvas>` del tamaño pedido (fondo opcional) y devuelve los bytes del PNG. */
export const rasterizeWithCanvas: Rasterizer = async (svg, width, height, background) => {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const image = await loadImage(url);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("el navegador no ofrece un canvas 2D");
    if (background !== null) {
      context.fillStyle = background;
      context.fillRect(0, 0, width, height);
    }
    context.drawImage(image, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("el canvas no pudo codificar la imagen (¿tamaño demasiado grande para este navegador?)");
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
};

/** Descarga con un enlace temporal `<a download>`. */
export const downloadFile: DownloadFile = (file) => {
  const blob = new Blob([file.data as BlobPart], { type: file.mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revocar de inmediato puede cancelar la descarga en algunos navegadores.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
