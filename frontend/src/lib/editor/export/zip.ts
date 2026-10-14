/**
 * Escritor ZIP mínimo (M3-S15), sin dependencias: método 0 («stored», sin compresión) + CRC-32. Los archivos del export son SVG/DXF/PNG pequeños y un PNG ya viene
 * comprimido: no justifica una librería. Formato (PKWARE APPNOTE): cada archivo lleva su local header + datos; al final el central directory y el EOCD.
 *
 * Límites (sin ZIP64): hasta 65 535 entradas y 4 GiB - 1 por archivo y en total; fuera de eso se lanza un error en vez de escribir un ZIP corrupto.
 * Los nombres van en UTF-8 (flag de bit 11). La fecha es fija (1980-01-01 00:00, el origen de MS-DOS) salvo que se pase `modified`: así el mismo contenido da
 * exactamente los mismos bytes (determinista).
 */

export interface ZipEntry {
  /** Ruta dentro del ZIP (con «/», sin «/» inicial). */
  name: string;
  data: Uint8Array;
  /** Fecha de modificación; por defecto la fecha DOS mínima, para que el resultado sea reproducible. */
  modified?: Date;
}

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const VERSION_NEEDED = 20;
const FLAG_UTF8 = 0x0800;
const METHOD_STORED = 0;
const DOS_EPOCH_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
const MAX_ENTRIES = 0xffff;
const MAX_SIZE = 0xffffffff;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE 802.3, el de ZIP/PNG/gzip) sin signo. `crc32("123456789")` = `0xCBF43926`. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Fecha/hora al formato DOS (2 segundos de resolución, años 1980-2107). Fuera de rango => el origen DOS. */
function dosDateTime(date: Date | undefined): { time: number; date: number } {
  if (!date || Number.isNaN(date.getTime())) return { time: 0, date: DOS_EPOCH_DATE };
  const year = date.getFullYear();
  if (year < 1980 || year > 2107) return { time: 0, date: DOS_EPOCH_DATE };
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** Un nombre de entrada válido: no vacío, relativo, sin «\», sin «..» y sin caracteres de control. */
export function isValidZipEntryName(name: string): boolean {
  if (name.length === 0 || name.startsWith("/") || name.includes("\\")) return false;
  for (let index = 0; index < name.length; index += 1) {
    const unit = name.charCodeAt(index);
    if (unit < 0x20 || unit === 0x7f) return false;
  }
  return !name.split("/").some((segment) => segment === ".." || segment === "." || segment === "");
}

/** Arma el ZIP. Lanza `Error` si un nombre es inválido o repetido, o si se exceden los límites de ZIP sin ZIP64. */
export function createZip(entries: readonly ZipEntry[]): Uint8Array {
  if (entries.length > MAX_ENTRIES) throw new Error(`El ZIP admite hasta ${MAX_ENTRIES} archivos (se pidieron ${entries.length}).`);
  const seen = new Set<string>();
  const prepared = entries.map((entry) => {
    if (!isValidZipEntryName(entry.name)) throw new Error(`Nombre de archivo inválido para el ZIP: «${entry.name}».`);
    if (seen.has(entry.name)) throw new Error(`Nombre de archivo repetido en el ZIP: «${entry.name}».`);
    seen.add(entry.name);
    if (entry.data.length > MAX_SIZE) throw new Error(`«${entry.name}» es demasiado grande para un ZIP sin ZIP64.`);
    return { name: utf8(entry.name), data: entry.data, crc: crc32(entry.data), stamp: dosDateTime(entry.modified) };
  });

  let localSize = 0;
  let centralSize = 0;
  for (const entry of prepared) {
    localSize += 30 + entry.name.length + entry.data.length;
    centralSize += 46 + entry.name.length;
  }
  const total = localSize + centralSize + 22;
  if (total > MAX_SIZE) throw new Error("El ZIP resultante supera los 4 GiB que admite el formato sin ZIP64.");

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  const offsets: number[] = [];

  for (const entry of prepared) {
    offsets.push(offset);
    view.setUint32(offset, LOCAL_HEADER_SIGNATURE, true);
    view.setUint16(offset + 4, VERSION_NEEDED, true);
    view.setUint16(offset + 6, FLAG_UTF8, true);
    view.setUint16(offset + 8, METHOD_STORED, true);
    view.setUint16(offset + 10, entry.stamp.time, true);
    view.setUint16(offset + 12, entry.stamp.date, true);
    view.setUint32(offset + 14, entry.crc, true);
    view.setUint32(offset + 18, entry.data.length, true);
    view.setUint32(offset + 22, entry.data.length, true);
    view.setUint16(offset + 26, entry.name.length, true);
    view.setUint16(offset + 28, 0, true);
    out.set(entry.name, offset + 30);
    out.set(entry.data, offset + 30 + entry.name.length);
    offset += 30 + entry.name.length + entry.data.length;
  }

  const centralStart = offset;
  prepared.forEach((entry, index) => {
    view.setUint32(offset, CENTRAL_HEADER_SIGNATURE, true);
    view.setUint16(offset + 4, VERSION_NEEDED, true); // versión con la que se hizo
    view.setUint16(offset + 6, VERSION_NEEDED, true); // versión necesaria
    view.setUint16(offset + 8, FLAG_UTF8, true);
    view.setUint16(offset + 10, METHOD_STORED, true);
    view.setUint16(offset + 12, entry.stamp.time, true);
    view.setUint16(offset + 14, entry.stamp.date, true);
    view.setUint32(offset + 16, entry.crc, true);
    view.setUint32(offset + 20, entry.data.length, true);
    view.setUint32(offset + 24, entry.data.length, true);
    view.setUint16(offset + 28, entry.name.length, true);
    view.setUint16(offset + 30, 0, true); // extra
    view.setUint16(offset + 32, 0, true); // comentario
    view.setUint16(offset + 34, 0, true); // disco de inicio
    view.setUint16(offset + 36, 0, true); // atributos internos
    view.setUint32(offset + 38, 0, true); // atributos externos
    view.setUint32(offset + 42, offsets[index], true);
    out.set(entry.name, offset + 46);
    offset += 46 + entry.name.length;
  });

  view.setUint32(offset, END_OF_CENTRAL_DIRECTORY_SIGNATURE, true);
  view.setUint16(offset + 4, 0, true); // este disco
  view.setUint16(offset + 6, 0, true); // disco del central directory
  view.setUint16(offset + 8, prepared.length, true);
  view.setUint16(offset + 10, prepared.length, true);
  view.setUint32(offset + 12, offset - centralStart, true);
  view.setUint32(offset + 16, centralStart, true);
  view.setUint16(offset + 20, 0, true); // comentario
  return out;
}
