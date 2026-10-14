import { describe, expect, it } from "vitest";
import { readZip, referenceCrc32 } from "../../../test/exportReaders";
import { crc32, createZip, isValidZipEntryName, utf8 } from "./zip";

describe("crc32", () => {
  it("coincide con los vectores conocidos", () => {
    expect(crc32(utf8(""))).toBe(0);
    expect(crc32(utf8("a"))).toBe(0xe8b7be43);
    expect(crc32(utf8("abc"))).toBe(0x352441c2);
    expect(crc32(utf8("123456789"))).toBe(0xcbf43926);
    expect(crc32(utf8("The quick brown fox jumps over the lazy dog"))).toBe(0x414fa339);
    expect(crc32(new Uint8Array([0, 0, 0, 0]))).toBe(0x2144df1c);
    expect(crc32(new Uint8Array(32))).toBe(0x190a55ad);
  });

  it("devuelve siempre un entero sin signo y coincide con la implementación bit a bit para datos binarios", () => {
    const data = new Uint8Array(1000).map((_, index) => (index * 37 + 11) & 0xff);
    const value = crc32(data);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(0xffffffff);
    expect(value).toBe(referenceCrc32(data));
  });
});

describe("createZip", () => {
  it("un archivo: estructura local header / central directory / EOCD válida y datos intactos", () => {
    const zip = createZip([{ name: "hola.txt", data: utf8("hola mundo") }]);
    const [entry, ...rest] = readZip(zip);
    expect(rest).toHaveLength(0);
    expect(entry.name).toBe("hola.txt");
    expect(entry.method).toBe(0); // stored
    expect(new TextDecoder().decode(entry.data)).toBe("hola mundo");
    expect(entry.crcDeclared).toBe(crc32(utf8("hola mundo")));
    expect(entry.crcActual).toBe(entry.crcDeclared);
    // Tamaño exacto: local (30 + nombre + datos) + central (46 + nombre) + EOCD (22).
    expect(zip.length).toBe(30 + 8 + 10 + 46 + 8 + 22);
  });

  it("varios archivos en el orden dado, cada uno con su CRC, incluidos binarios y vacíos", () => {
    const binary = new Uint8Array(70000).map((_, index) => (index * 31) & 0xff);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
    const entries = readZip(
      createZip([
        { name: "a.svg", data: utf8("<svg/>") },
        { name: "b.dxf", data: utf8("0\nEOF\n") },
        { name: "c.png", data: png },
        { name: "vacio.txt", data: new Uint8Array(0) },
        { name: "grande.bin", data: binary },
      ]),
    );
    expect(entries.map((entry) => entry.name)).toEqual(["a.svg", "b.dxf", "c.png", "vacio.txt", "grande.bin"]);
    expect(entries.every((entry) => entry.crcActual === entry.crcDeclared)).toBe(true);
    expect(Array.from(entries[2].data)).toEqual(Array.from(png));
    expect(entries[3].data).toHaveLength(0);
    expect(entries[3].crcDeclared).toBe(0);
    expect(Array.from(entries[4].data.subarray(0, 8))).toEqual(Array.from(binary.subarray(0, 8)));
    expect(entries[4].data).toHaveLength(70000);
  });

  it("los nombres van en UTF-8 con el flag de bit 11", () => {
    const [entry] = readZip(createZip([{ name: "ñandú-日本.svg", data: utf8("x") }]));
    expect(entry.name).toBe("ñandú-日本.svg");
    expect(entry.flags & 0x0800).toBe(0x0800);
  });

  it("subcarpetas con «/» son válidas", () => {
    expect(readZip(createZip([{ name: "capas/rojo.svg", data: utf8("x") }]))[0].name).toBe("capas/rojo.svg");
  });

  it("sin archivos produce un ZIP vacío válido (solo el EOCD)", () => {
    const zip = createZip([]);
    expect(zip).toHaveLength(22);
    expect(readZip(zip)).toEqual([]);
  });

  it("es determinista: mismo contenido => mismos bytes (fecha DOS fija 1980-01-01)", () => {
    const entries = [
      { name: "a.svg", data: utf8("a") },
      { name: "b.svg", data: utf8("b") },
    ];
    const first = createZip(entries);
    const second = createZip(entries);
    expect(Array.from(first)).toEqual(Array.from(second));
    const [entry] = readZip(first);
    expect(entry.dosDate).toBe(0x0021);
    expect(entry.dosTime).toBe(0);
  });

  it("acepta una fecha explícita en formato DOS", () => {
    const [entry] = readZip(createZip([{ name: "a", data: utf8("a"), modified: new Date(2026, 9, 14, 13, 45, 30) }]));
    expect(entry.dosDate).toBe(((2026 - 1980) << 9) | (10 << 5) | 14);
    expect(entry.dosTime).toBe((13 << 11) | (45 << 5) | 15);
  });

  it("rechaza nombres inválidos o repetidos en vez de escribir un ZIP corrupto", () => {
    for (const name of ["", "/abs.svg", "a\\b.svg", "../fuera.svg", "a/../b", "a//b", "con\u0000nul"]) {
      expect(() => createZip([{ name, data: utf8("x") }]), name).toThrow(/inválido/);
    }
    expect(() =>
      createZip([
        { name: "a.svg", data: utf8("x") },
        { name: "a.svg", data: utf8("y") },
      ]),
    ).toThrow(/repetido/);
  });

  it("isValidZipEntryName", () => {
    expect(isValidZipEntryName("proyecto_rojo_cut.svg")).toBe(true);
    expect(isValidZipEntryName("../x")).toBe(false);
  });
});
