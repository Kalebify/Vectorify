import { StrictMode } from "react";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { buildClipboard } from "../lib/editor/clipboard";
import type { EditableDocument, EditorObject } from "../lib/editor/types";
import { useClipboard } from "./useClipboard";

const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
const OBJECT: EditorObject = { id: "a1", layerGroupId: "A", d: "M0 0 H40 V40 H0 Z", fill: "#ff0000", matrix: IDENTITY };
const OTHER: EditorObject = { id: "a2", layerGroupId: "A", d: "M0 0 H10 V10 H0 Z", fill: "#ff0000", matrix: IDENTITY };
const DOCUMENT: EditableDocument = { objectsByLayer: { A: [OBJECT, OTHER] } };
const content = (...objects: EditorObject[]) => buildClipboard(objects, DOCUMENT)!;

describe("useClipboard", () => {
  it("arranca vacío: sin contenido, tamaño 0 y primer offset 1x", () => {
    const { result } = renderHook(() => useClipboard("doc-1"));
    expect(result.current.content).toBeNull();
    expect(result.current.size).toBe(0);
    expect(result.current.nextOffset(0.5)).toEqual({ x: 10, y: 10 });
  });

  it("copiar guarda el contenido; cada pegado con offset adelanta el siguiente (1x, 2x, 3x)", () => {
    const { result } = renderHook(() => useClipboard("doc-1"));
    act(() => result.current.copy(content(OBJECT, OTHER)));
    expect(result.current.size).toBe(2);
    expect(result.current.nextOffset(0.5)).toEqual({ x: 10, y: 10 });
    act(() => result.current.registerPaste());
    expect(result.current.nextOffset(0.5)).toEqual({ x: 20, y: 20 });
    act(() => result.current.registerPaste());
    expect(result.current.nextOffset(0.5)).toEqual({ x: 30, y: 30 });
    // Sin escala física: pasos de 5 unidades.
    expect(result.current.nextOffset(null)).toEqual({ x: 15, y: 15 });
  });

  it("volver a copiar reemplaza el contenido y REINICIA el contador", () => {
    const { result } = renderHook(() => useClipboard("doc-1"));
    act(() => result.current.copy(content(OBJECT)));
    act(() => result.current.registerPaste());
    act(() => result.current.registerPaste());
    act(() => result.current.copy(content(OTHER)));
    expect(result.current.size).toBe(1);
    expect(result.current.content!.items[0].d).toBe("M0 0 H10 V10 H0 Z");
    expect(result.current.nextOffset(0.5)).toEqual({ x: 10, y: 10 });
  });

  it("registrar un pegado sin contenido no adelanta nada", () => {
    const { result } = renderHook(() => useClipboard("doc-1"));
    act(() => result.current.registerPaste());
    expect(result.current.nextOffset(0.5)).toEqual({ x: 10, y: 10 });
  });

  it("dos pegados registrados en el mismo turno suman los dos (actualización funcional)", () => {
    const { result } = renderHook(() => useClipboard("doc-1"));
    act(() => result.current.copy(content(OBJECT)));
    act(() => {
      result.current.registerPaste();
      result.current.registerPaste();
    });
    expect(result.current.nextOffset(0.5)).toEqual({ x: 30, y: 30 });
  });

  it("cambiar de documento VACÍA el portapapeles, y no reaparece al volver al anterior", () => {
    const { result, rerender } = renderHook(({ scope }) => useClipboard(scope), { initialProps: { scope: "doc-1" } });
    act(() => result.current.copy(content(OBJECT)));
    act(() => result.current.registerPaste());
    expect(result.current.size).toBe(1);

    rerender({ scope: "doc-2" });
    expect(result.current.content).toBeNull();
    expect(result.current.size).toBe(0);
    expect(result.current.nextOffset(0.5)).toEqual({ x: 10, y: 10 });

    rerender({ scope: "doc-1" });
    expect(result.current.content).toBeNull();
  });

  it("copiar en el documento nuevo funciona con normalidad", () => {
    const { result, rerender } = renderHook(({ scope }) => useClipboard(scope), { initialProps: { scope: "doc-1" } });
    act(() => result.current.copy(content(OBJECT)));
    rerender({ scope: "doc-2" });
    act(() => result.current.copy(content(OTHER)));
    expect(result.current.size).toBe(1);
    expect(result.current.content!.items[0].d).toBe("M0 0 H10 V10 H0 Z");
  });

  it("React StrictMode (doble render/efectos): el comportamiento es el mismo", () => {
    const { result } = renderHook(() => useClipboard("doc-1"), { wrapper: StrictMode });
    act(() => result.current.copy(content(OBJECT, OTHER)));
    act(() => result.current.registerPaste());
    expect(result.current.size).toBe(2);
    expect(result.current.nextOffset(0.5)).toEqual({ x: 20, y: 20 });
  });
});
