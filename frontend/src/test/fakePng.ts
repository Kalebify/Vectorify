/** Un «PNG» mínimo para los dobles de rasterizado de los tests: firma + chunk IHDR con el tamaño pedido (no es una imagen decodificable). */
export function fakePng(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13, false);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // «IHDR»
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  bytes[24] = 8; // profundidad
  bytes[25] = 6; // RGBA
  return bytes;
}
