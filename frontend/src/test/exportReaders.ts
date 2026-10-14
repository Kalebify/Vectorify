/**
 * Lectores MÍNIMOS e independientes de los escritores del export (M3-S15), solo para tests: si el escritor y el lector compartieran código, un error común pasaría
 * desapercibido. Son estrictos: ante cualquier cosa fuera de formato lanzan en vez de tolerarla.
 */

// ---- ZIP ----

/** CRC-32 bit a bit (sin tabla): implementación de referencia, independiente de la del escritor. */
export function referenceCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ReadZipEntry {
  name: string;
  data: Uint8Array;
  method: number;
  flags: number;
  crcDeclared: number;
  crcActual: number;
  /** Fecha DOS cruda tal como está en el archivo. */
  dosDate: number;
  dosTime: number;
}

/** Lee el ZIP por su central directory (como lo hace un lector real): EOCD -> directorio central -> local header -> datos. Verifica firmas, tamaños y CRC. */
export function readZip(bytes: Uint8Array): ReadZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let index = bytes.length - 22; index >= 0; index -= 1) {
    if (view.getUint32(index, true) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) throw new Error("sin EOCD");
  const count = view.getUint16(eocd + 10, true);
  if (view.getUint16(eocd + 8, true) !== count) throw new Error("conteos del EOCD distintos");
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (centralOffset + centralSize !== eocd) throw new Error("el central directory no termina donde empieza el EOCD");

  const entries: ReadZipEntry[] = [];
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(cursor, true) !== 0x02014b50) throw new Error("firma del central directory inválida");
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const dosTime = view.getUint16(cursor + 12, true);
    const dosDate = view.getUint16(cursor + 14, true);
    const crcDeclared = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;

    if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error(`firma del local header inválida (${name})`);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    if (view.getUint32(localOffset + 14, true) !== crcDeclared) throw new Error(`CRC distinto entre local header y central directory (${name})`);
    if (view.getUint32(localOffset + 18, true) !== compressedSize || view.getUint32(localOffset + 22, true) !== size) throw new Error(`tamaños distintos (${name})`);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const data = bytes.subarray(start, start + compressedSize);
    if (method === 0 && compressedSize !== size) throw new Error(`stored con tamaños distintos (${name})`);
    entries.push({ name, data, method, flags, crcDeclared, crcActual: referenceCrc32(data), dosDate, dosTime });
  }
  if (cursor !== eocd) throw new Error("sobran bytes entre el central directory y el EOCD");
  return entries;
}

// ---- DXF ----

export interface DxfVertex {
  x: number;
  y: number;
  z: number;
}

export interface DxfPolylineRead {
  layer: string;
  closed: boolean;
  vertices: DxfVertex[];
}

export interface DxfRead {
  header: Record<string, string[]>;
  layerTable: string[];
  polylines: DxfPolylineRead[];
  /** Códigos de grupo de cada entidad que NO es POLYLINE/VERTEX/SEQEND (debe quedar vacío). */
  otherEntities: string[];
  sections: string[];
  hasEof: boolean;
}

/** Parser DXF mínimo y estricto: pares (código, valor), secciones balanceadas, POLYLINE -> VERTEX* -> SEQEND. Lanza ante cualquier irregularidad. */
export function readDxf(text: string): DxfRead {
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines.length % 2 !== 0) throw new Error("cantidad impar de líneas: falta un valor");
  const pairs: Array<{ code: number; value: string }> = [];
  for (let index = 0; index < lines.length; index += 2) {
    const codeText = lines[index];
    if (!/^\s*\d+\s*$/.test(codeText)) throw new Error(`código de grupo inválido en la línea ${index + 1}: «${codeText}»`);
    pairs.push({ code: Number(codeText), value: lines[index + 1].trim() });
  }

  const result: DxfRead = { header: {}, layerTable: [], polylines: [], otherEntities: [], sections: [], hasEof: false };
  let index = 0;
  const expect0 = (value: string) => {
    const pair = pairs[index];
    if (!pair || pair.code !== 0 || pair.value !== value) throw new Error(`se esperaba 0/${value} en el par ${index}, hay ${pair ? `${pair.code}/${pair.value}` : "fin"}`);
    index += 1;
  };

  while (index < pairs.length) {
    const pair = pairs[index];
    if (pair.code === 0 && pair.value === "EOF") {
      result.hasEof = true;
      index += 1;
      if (index !== pairs.length) throw new Error("hay contenido después de EOF");
      break;
    }
    expect0("SECTION");
    if (pairs[index].code !== 2) throw new Error("la sección no tiene nombre");
    const name = pairs[index].value;
    index += 1;
    result.sections.push(name);

    if (name === "HEADER") {
      let variable: string | null = null;
      while (!(pairs[index].code === 0 && pairs[index].value === "ENDSEC")) {
        const current = pairs[index];
        if (current.code === 9) {
          variable = current.value;
          result.header[variable] = [];
        } else {
          if (variable === null) throw new Error("valor de cabecera sin variable");
          result.header[variable].push(`${current.code}:${current.value}`);
        }
        index += 1;
      }
    } else if (name === "TABLES") {
      let currentTable = "";
      while (!(pairs[index].code === 0 && pairs[index].value === "ENDSEC")) {
        const current = pairs[index];
        if (current.code === 0 && current.value === "TABLE") currentTable = pairs[index + 1].value;
        if (current.code === 0 && current.value === "LAYER" && currentTable === "LAYER") result.layerTable.push(pairs[index + 1].value);
        index += 1;
      }
    } else if (name === "ENTITIES") {
      let polyline: DxfPolylineRead | null = null;
      while (!(pairs[index].code === 0 && pairs[index].value === "ENDSEC")) {
        const current = pairs[index];
        if (current.code !== 0) throw new Error(`código ${current.code} fuera de una entidad`);
        index += 1;
        const body: Array<{ code: number; value: string }> = [];
        while (pairs[index].code !== 0) {
          body.push(pairs[index]);
          index += 1;
        }
        const field = (code: number) => body.find((item) => item.code === code)?.value;
        if (current.value === "POLYLINE") {
          if (polyline) throw new Error("POLYLINE dentro de otra sin SEQEND");
          if (field(66) === undefined || Number(field(66)) !== 1) throw new Error("POLYLINE sin el flag 66 = 1");
          polyline = { layer: field(8) ?? "", closed: (Number(field(70) ?? "0") & 1) === 1, vertices: [] };
        } else if (current.value === "VERTEX") {
          if (!polyline) throw new Error("VERTEX fuera de una POLYLINE");
          if (field(8) !== polyline.layer) throw new Error("VERTEX en otra capa que su POLYLINE");
          if (field(10) === undefined || field(20) === undefined) throw new Error("VERTEX sin X/Y");
          polyline.vertices.push({ x: Number(field(10)), y: Number(field(20)), z: Number(field(30) ?? "0") });
        } else if (current.value === "SEQEND") {
          if (!polyline) throw new Error("SEQEND sin POLYLINE");
          result.polylines.push(polyline);
          polyline = null;
        } else {
          result.otherEntities.push(current.value);
        }
      }
      if (polyline) throw new Error("POLYLINE sin SEQEND");
    } else {
      while (!(pairs[index].code === 0 && pairs[index].value === "ENDSEC")) index += 1;
    }
    expect0("ENDSEC");
  }
  return result;
}
