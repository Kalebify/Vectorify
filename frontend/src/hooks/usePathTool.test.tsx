import { StrictMode, useState, type ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IDENTITY_MATRIX, type AffineMatrix } from "../lib/svgTransform";
import type { DocumentFrame, EditableDocument, EditableLayerMeta, EditorObject, EditProduction } from "../lib/editor/types";
import type { ApplyEditResult } from "./useEditableDocument";
import { usePathTool, type UsePathToolParams } from "./usePathTool";

/**
 * usePathTool (M3-S05) aislado del Workspace: con un `editable` simulado (estado mínimo + gestos) se verifica que cada acción produce el
 * número exacto de comandos, que el arrastre usa el gesto de S01 (una previsualización por paso, UN commit) y que Escape/desmontaje lo cancelan sin
 * rastro. El flujo completo con la UI está en EditorShell.path.test.tsx.
 */

const SQUARE = "M20 20 L120 20 L120 120 L20 120 Z";
const WAVE = "M20 200 C40 160 80 160 100 200 C120 240 160 240 180 200";
const FRAME: DocumentFrame = { x: 0, y: 0, width: 320, height: 240 };

function layer(groupId: string, overrides: Partial<EditableLayerMeta> = {}): EditableLayerMeta {
  return { groupId, name: `Capa ${groupId}`, colorHex: "#ff0000", order: 0, visible: true, locked: false, manufacturingOperation: "unassigned", isNew: false, ...overrides };
}

function shape(d: string, matrix: AffineMatrix = IDENTITY_MATRIX, id = "o1"): EditorObject {
  return { id, layerGroupId: "A", d, fill: "#ff0000", matrix };
}

interface HarnessOptions {
  d?: string;
  matrix?: AffineMatrix;
  layers?: EditableLayerMeta[];
  activeTool?: string;
  frame?: DocumentFrame;
  mmFactor?: number | null;
  beginGestureResult?: boolean;
}

/** `editable` simulado: un estado mínimo, comandos registrados y un gesto con base/previsualización como el de `useEditableDocument`. */
function harness(options: HarnessOptions = {}) {
  let state: EditableDocument = { objectsByLayer: { A: [shape(options.d ?? SQUARE, options.matrix)] } };
  const commands: Array<{ label: string; coalesceKey?: string }> = [];
  let base: EditableDocument | null = null;
  let preview: EditProduction | null = null;

  // En la app, cambiar el estado editable re-renderiza al consumidor; acá se simula con un contador.
  let bump = () => {};
  const apply = (production: EditProduction) => {
    state = { objectsByLayer: { ...state.objectsByLayer, ...production.layers } };
  };
  const ok: ApplyEditResult = { applied: true, skippedLockedObjects: 0, skippedHiddenObjects: 0 };
  const none: ApplyEditResult = { applied: false, reason: "no_change", skippedLockedObjects: 0, skippedHiddenObjects: 0 };

  const editable = {
    getSnapshot: () => state,
    applyEdit: vi.fn((label: string, producer: (current: EditableDocument) => EditProduction | null, editOptions?: { coalesceKey?: string }): ApplyEditResult => {
      const production = producer(state);
      if (!production) return none;
      apply(production);
      commands.push({ label, coalesceKey: editOptions?.coalesceKey });
      bump();
      return ok;
    }),
    beginGesture: vi.fn((): boolean => {
      if (options.beginGestureResult === false || base) return false;
      base = state;
      return true;
    }),
    previewEdit: vi.fn((producer: (current: EditableDocument) => EditProduction | null): ApplyEditResult => {
      if (!base) return none;
      preview = producer(base);
      if (preview) state = { objectsByLayer: { ...base.objectsByLayer, ...preview.layers } };
      else state = base;
      bump();
      return preview ? ok : none;
    }),
    commitGesture: vi.fn((label: string): ApplyEditResult => {
      const had = preview;
      base = null;
      preview = null;
      if (!had) return none;
      commands.push({ label });
      bump();
      return ok;
    }),
    cancelGesture: vi.fn(() => {
      if (base) state = base;
      base = null;
      preview = null;
      bump();
    }),
  };

  const onNotice = vi.fn();
  const onPickObject = vi.fn();
  const onExit = vi.fn();
  const layers = options.layers ?? [layer("A")];
  const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;

  const hook = renderHook(
    (props: { activeTool: string }) => {
      const [, setTick] = useState(0);
      bump = () => setTick((value) => value + 1);
      const params: UsePathToolParams = {
        activeTool: props.activeTool,
        editable,
        layers,
        selectedObjects: state.objectsByLayer.A,
        frame: options.frame ?? FRAME,
        mmFactor: options.mmFactor === undefined ? 0.5 : options.mmFactor,
        onNotice,
        onPickObject,
        onExit,
      };
      return usePathTool(params);
    },
    { initialProps: { activeTool: options.activeTool ?? "path" }, wrapper },
  );

  const current = () => state.objectsByLayer.A[0];
  const select = (...refs: Array<[number, number]>) => act(() => hook.result.current.surface.onSelectNodes(refs.map(([subpath, node]) => ({ subpath, node })), "replace"));
  const press = (key: string, init: KeyboardEventInit = {}, target: EventTarget = window) => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  };
  return { ...hook, editable, commands, current, select, press, onNotice, onPickObject, onExit, rerenderWith: (activeTool: string) => hook.rerender({ activeTool }) };
}

afterEach(() => vi.unstubAllGlobals());

describe("usePathTool — objetivo", () => {
  it("fuera de Path no hay objetivo ni overlay", () => {
    const { result } = harness({ activeTool: "select" });
    expect(result.current.active).toBe(false);
    expect(result.current.target).toBeNull();
    expect(result.current.model).toBeNull();
  });

  it("un objeto editable: modelo de nodos y panel", () => {
    const { result } = harness();
    expect(result.current.target?.status).toBe("ok");
    expect(result.current.model?.subpaths[0].nodes).toHaveLength(4);
    expect(result.current.panel).toMatchObject({ status: "ok", subpathCount: 1, nodeCount: 4, selectedCount: 0, layerName: "Capa A", unitLabel: "mm", canDelete: false, canClose: false });
  });

  it("capa bloqueada: estado `locked` con mensaje, sin modelo; las acciones de selección no hacen nada", () => {
    const { result, select } = harness({ layers: [layer("A", { name: "Rojo", locked: true })] });
    expect(result.current.target?.status).toBe("locked");
    expect(result.current.panel.message).toContain("«Rojo» está bloqueada");
    expect(result.current.model).toBeNull();
    select([0, 1]);
    expect(result.current.keys.size).toBe(0);
  });
});

describe("usePathTool — arrastre = un gesto", () => {
  it("beginDrag -> dragBy xN -> endDrag: una previsualización por paso, UN commit y ningún applyEdit; la selección se conserva", () => {
    const h = harness();
    h.select([0, 1]);
    expect([...h.result.current.keys]).toEqual(["0:1"]);

    let began = false;
    act(() => {
      began = h.result.current.surface.onBeginDrag({ kind: "anchors", refs: [{ subpath: 0, node: 1 }] });
    });
    expect(began).toBe(true);
    expect(h.editable.beginGesture).toHaveBeenCalledTimes(1);
    for (const x of [2, 5, 8, 10]) act(() => h.result.current.surface.onDragBy({ x, y: x / 2 }, { shift: false, alt: false }));
    expect(h.editable.previewEdit).toHaveBeenCalledTimes(4);
    expect(h.current().d).toBe("M20 20 L130 25 L120 120 L20 120 Z");
    expect(h.commands).toHaveLength(0); // nada en la pila durante el gesto

    act(() => h.result.current.surface.onEndDrag());
    expect(h.editable.commitGesture).toHaveBeenCalledTimes(1);
    expect(h.commands).toEqual([{ label: "Mover 1 nodo" }]);
    expect(h.editable.applyEdit).not.toHaveBeenCalled();
    expect([...h.result.current.keys]).toEqual(["0:1"]);
  });

  it("cada paso se recompone desde el estado ANTES: ir a +10 y volver a +4 deja +4 (no 14)", () => {
    const h = harness();
    act(() => {
      h.result.current.surface.onBeginDrag({ kind: "anchors", refs: [{ subpath: 0, node: 1 }] });
    });
    act(() => h.result.current.surface.onDragBy({ x: 10, y: 0 }, { shift: false, alt: false }));
    act(() => h.result.current.surface.onDragBy({ x: 4, y: 0 }, { shift: false, alt: false }));
    expect(h.current().d).toBe("M20 20 L124 20 L120 120 L20 120 Z");
  });

  it("cancelDrag descarta el gesto sin rastro: nada comiteado y el d original intacto; un endDrag posterior no hace nada", () => {
    const h = harness();
    act(() => {
      h.result.current.surface.onBeginDrag({ kind: "anchors", refs: [{ subpath: 0, node: 1 }] });
    });
    act(() => h.result.current.surface.onDragBy({ x: 30, y: 30 }, { shift: false, alt: false }));
    act(() => h.result.current.surface.onCancelDrag());

    expect(h.editable.cancelGesture).toHaveBeenCalledTimes(1);
    expect(h.current().d).toBe(SQUARE);
    act(() => h.result.current.surface.onEndDrag());
    expect(h.commands).toHaveLength(0);
    expect(h.editable.commitGesture).not.toHaveBeenCalled();
  });

  it("Shift restringe el arrastre al eje dominante", () => {
    const h = harness();
    act(() => {
      h.result.current.surface.onBeginDrag({ kind: "anchors", refs: [{ subpath: 0, node: 1 }] });
    });
    act(() => h.result.current.surface.onDragBy({ x: 10, y: 3 }, { shift: true, alt: false }));
    expect(h.current().d).toBe("M20 20 L130 20 L120 120 L20 120 Z");
    act(() => h.result.current.surface.onDragBy({ x: 2, y: 9 }, { shift: true, alt: false }));
    expect(h.current().d).toBe("M20 20 L120 29 L120 120 L20 120 Z");
  });

  it("un handle simétrico arrastra a su opuesto (espejo exacto) y Alt lo rompe a esquina", () => {
    const h = harness({ d: WAVE });
    act(() => {
      h.result.current.surface.onBeginDrag({ kind: "handle", ref: { subpath: 0, node: 1 }, side: "out" });
    });
    act(() => h.result.current.surface.onDragBy({ x: 10, y: 0 }, { shift: false, alt: false }));
    expect(h.current().d).toBe("M20 200 C40 160 70 160 100 200 C130 240 160 240 180 200");
    act(() => h.result.current.surface.onDragBy({ x: 10, y: 0 }, { shift: false, alt: true }));
    expect(h.current().d).toBe("M20 200 C40 160 80 160 100 200 C130 240 160 240 180 200");
    act(() => h.result.current.surface.onEndDrag());
    expect(h.commands).toEqual([{ label: "Mover handle" }]);
  });

  it("un handle que no existe, o una transformación pendiente (beginGesture rechazado), no inician el arrastre y lo informan", () => {
    const h = harness({ beginGestureResult: false });
    let began = true;
    act(() => {
      began = h.result.current.surface.onBeginDrag({ kind: "anchors", refs: [{ subpath: 0, node: 1 }] });
    });
    expect(began).toBe(false);
    expect(h.result.current.panel.error).toContain("transformación pendiente");

    const noHandle = harness();
    act(() => {
      began = noHandle.result.current.surface.onBeginDrag({ kind: "handle", ref: { subpath: 0, node: 1 }, side: "out" });
    });
    expect(began).toBe(false);
    expect(noHandle.editable.beginGesture).not.toHaveBeenCalled();
  });

  it("desmontar con un arrastre en curso lo cancela; salir de la herramienta también", () => {
    const first = harness();
    act(() => {
      first.result.current.surface.onBeginDrag({ kind: "anchors", refs: [{ subpath: 0, node: 1 }] });
    });
    first.unmount();
    expect(first.editable.cancelGesture).toHaveBeenCalled();
    expect(first.current().d).toBe(SQUARE);

    const second = harness();
    act(() => {
      second.result.current.surface.onBeginDrag({ kind: "anchors", refs: [{ subpath: 0, node: 1 }] });
    });
    second.rerenderWith("select");
    expect(second.editable.cancelGesture).toHaveBeenCalled();
    expect(second.current().d).toBe(SQUARE);
    expect(second.commands).toHaveLength(0);
  });
});

describe("usePathTool — ediciones de un paso (un comando cada una)", () => {
  it("agregar un nodo: un comando, el nodo nuevo queda seleccionado", () => {
    const h = harness();
    act(() => h.result.current.surface.onAddNode(0, 0, 0.25));
    expect(h.commands).toEqual([{ label: "Agregar nodo", coalesceKey: undefined }]);
    expect(h.current().d).toBe("M20 20 L45 20 L120 20 L120 120 L20 120 Z");
    expect([...h.result.current.keys]).toEqual(["0:1"]);
  });

  it("una operación inválida no crea comando y explica el motivo", () => {
    const h = harness();
    act(() => h.result.current.surface.onAddNode(0, 0, 0));
    expect(h.commands).toHaveLength(0);
    expect(h.result.current.panel.error).toContain("demasiado cerca");
    expect(h.current().d).toBe(SQUARE);
  });

  it("eliminar: un comando; si degenera el único subpath se rechaza con mensaje; si hay otro, pide confirmación y confirmar lo elimina entero", () => {
    const single = harness();
    single.select([0, 3]);
    act(() => single.result.current.panel.deleteSelected());
    expect(single.current().d).toBe("M20 20 L120 20 L120 120 Z");
    single.select([0, 2]);
    act(() => single.result.current.panel.deleteSelected());
    expect(single.result.current.panel.error).toContain("sin geometría");
    expect(single.commands).toHaveLength(1);

    const compound = harness({ d: "M0 0 L100 0 L100 100 L0 100 Z M20 20 L20 80 L80 20 Z" });
    compound.select([1, 0]);
    act(() => compound.result.current.panel.deleteSelected());
    expect(compound.result.current.panel.confirm?.subpaths).toEqual([1]);
    expect(compound.commands).toHaveLength(0);
    act(() => compound.result.current.panel.cancelConfirm());
    expect(compound.result.current.panel.confirm).toBeNull();
    act(() => compound.result.current.panel.deleteSelected());
    act(() => compound.result.current.panel.confirmDelete());
    expect(compound.current().d).toBe("M0 0 L100 0 L100 100 L0 100 Z");
    expect(compound.commands).toHaveLength(1);
    expect(compound.result.current.panel.confirm).toBeNull();
    expect(compound.result.current.keys.size).toBe(0);
  });

  it("alternar corner/smooth: de esquina a suave cambia la geometría (un comando); de suave a esquina sobre handles collineales solo cambia la etiqueta (sin comando) y se recuerda", () => {
    const h = harness({ d: WAVE });
    h.select([0, 1]);
    expect(h.result.current.panel.kind).toBe("symmetric");
    act(() => h.result.current.surface.onToggleKind({ subpath: 0, node: 1 }));
    expect(h.commands).toHaveLength(0);
    expect(h.editable.applyEdit).not.toHaveBeenCalled();
    expect(h.result.current.panel.kind).toBe("corner");
    expect(h.current().d).toBe(WAVE);

    const square = harness();
    act(() => square.result.current.surface.onToggleKind({ subpath: 0, node: 1 }));
    expect(square.commands).toHaveLength(1);
    expect(square.commands[0].label).toBe("Nodo suave");
    expect(square.current().d).toContain("C");
  });

  it("segmentos: alternar el siguiente de un nodo, y cerrar / abrir", () => {
    const h = harness({ d: "M0 0 L10 0 L10 10 L0 10" });
    h.select([0, 1]);
    expect(h.result.current.panel.segments.after).toEqual({ curved: false });
    act(() => h.result.current.panel.toggleSegment("after"));
    expect(h.current().d).toBe("M0 0 L10 0 C10 3.333333 10 6.666667 10 10 L0 10");
    expect(h.result.current.panel.segments.after).toEqual({ curved: true });

    expect(h.result.current.panel.canClose).toBe(true);
    act(() => h.result.current.panel.closeActive());
    expect(h.current().d).toBe("M0 0 L10 0 C10 3.333333 10 6.666667 10 10 L0 10 Z");
    expect(h.result.current.panel.canClose).toBe(false);
    h.select([0, 2]);
    expect(h.result.current.panel.canOpen).toBe(true);
    act(() => h.result.current.panel.openAtSelected());
    expect(h.current().d.startsWith("M10 10 L0 10 L0 0 L10 0 C")).toBe(true);
    expect(h.commands.map((command) => command.label)).toEqual(["Alternar segmento recto/curvo", "Cerrar subpath", "Abrir subpath"]);
  });

  it("la selección por índices deja de valer si cambia la estructura (agregar/eliminar/deshacer): no apunta a otro nodo", () => {
    const h = harness();
    h.select([0, 3]);
    expect([...h.result.current.keys]).toEqual(["0:3"]);
    // Cambio externo de estructura (como un undo de otro comando): el objeto pasa a tener un nodo más.
    act(() => {
      h.editable.applyEdit("externo", (current) => ({ layers: { A: [{ ...current.objectsByLayer.A[0], d: "M20 20 L70 20 L120 20 L120 120 L20 120 Z" }] } }));
    });
    h.rerender({ activeTool: "path" });
    expect(h.result.current.keys.size).toBe(0);
  });
});

describe("usePathTool — teclado", () => {
  it("las flechas empujan los nodos seleccionados en unidades de DOCUMENTO (Shift = 10) con una misma clave de fusión", () => {
    const h = harness();
    h.select([0, 1]);
    h.press("ArrowRight");
    h.press("ArrowRight");
    h.press("ArrowDown", { shiftKey: true });
    expect(h.current().d).toBe("M20 20 L122 30 L120 120 L20 120 Z");
    expect(h.commands).toHaveLength(3);
    expect(new Set(h.commands.map((command) => command.coalesceKey)).size).toBe(1);
    expect(h.commands[0].coalesceKey).toBe("path-nudge:o1:0:1");
  });

  it("las flechas con matriz: el empuje es en documento y se convierte a local (giro de 90°: derecha = local -y... )", () => {
    const rotation: AffineMatrix = { a: 0, b: 1, c: -1, d: 0, e: 0, f: 0 };
    const h = harness({ matrix: rotation });
    h.select([0, 1]);
    h.press("ArrowRight", { shiftKey: true });
    // Documento (+10, 0) = local (0, -10).
    expect(h.current().d).toBe("M20 20 L120 10 L120 120 L20 120 Z");
  });

  it("sin nodos seleccionados las flechas y Suprimir no hacen nada; en un campo de texto se ignoran", () => {
    const h = harness();
    h.press("ArrowRight");
    h.press("Delete");
    expect(h.commands).toHaveLength(0);

    h.select([0, 1]);
    const input = document.createElement("input");
    document.body.append(input);
    h.press("Delete", {}, input);
    h.press("ArrowRight", {}, input);
    expect(h.commands).toHaveLength(0);
    input.remove();
  });

  it("Suprimir elimina los nodos seleccionados; Ctrl+A selecciona el subpath activo", () => {
    const h = harness();
    h.press("a", { ctrlKey: true });
    expect([...h.result.current.keys]).toEqual(["0:0", "0:1", "0:2", "0:3"]);
    h.select([0, 3]);
    h.press("Delete");
    expect(h.current().d).toBe("M20 20 L120 20 L120 120 Z");
  });

  it("Escape: descarta la confirmación, luego limpia la selección y recién después sale; Enter sale", () => {
    const h = harness({ d: "M0 0 L100 0 L100 100 L0 100 Z M20 20 L20 80 L80 20 Z" });
    h.select([1, 0]);
    h.press("Delete");
    expect(h.result.current.panel.confirm).not.toBeNull();
    h.press("Escape");
    expect(h.result.current.panel.confirm).toBeNull();
    expect(h.result.current.keys.size).toBe(1);
    expect(h.onExit).not.toHaveBeenCalled();
    h.press("Escape");
    expect(h.result.current.keys.size).toBe(0);
    expect(h.onExit).not.toHaveBeenCalled();
    h.press("Escape");
    expect(h.onExit).toHaveBeenCalledTimes(1);
    h.press("Enter");
    expect(h.onExit).toHaveBeenCalledTimes(2);
  });

  it("un evento ya procesado (defaultPrevented) se ignora, y fuera de la herramienta no hay atajos", () => {
    const h = harness();
    h.select([0, 1]);
    const event = new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true });
    event.preventDefault();
    act(() => {
      window.dispatchEvent(event);
    });
    expect(h.commands).toHaveLength(0);

    const idle = harness({ activeTool: "select" });
    idle.press("Enter");
    expect(idle.onExit).not.toHaveBeenCalled();
  });
});

describe("usePathTool — panel numérico", () => {
  it("X/Y en mm relativos al origen del área de trabajo (0,5 mm/u, marco en (10, 5)); editar es UN comando", () => {
    const h = harness({ frame: { x: 10, y: 5, width: 300, height: 200 } });
    h.select([0, 1]);
    expect(h.result.current.panel.x).toBe(55); // (120 - 10) * 0.5
    expect(h.result.current.panel.y).toBe(7.5); // (20 - 5) * 0.5
    let error: string | null = "x";
    act(() => {
      error = h.result.current.panel.commitCoordinate("x", 60);
    });
    expect(error).toBeNull();
    expect(h.current().d).toBe("M20 20 L130 20 L120 120 L20 120 Z"); // 60 mm = 120 u + 10 de origen
    expect(h.commands).toHaveLength(1);
    act(() => {
      error = h.result.current.panel.commitCoordinate("y", 20);
    });
    expect(h.current().d).toBe("M20 20 L130 45 L120 120 L20 120 Z");
  });

  it("sin escala física trabaja en unidades `u`", () => {
    const h = harness({ mmFactor: null });
    h.select([0, 1]);
    expect(h.result.current.panel.unitLabel).toBe("u");
    expect(h.result.current.panel.x).toBe(120);
    act(() => {
      h.result.current.panel.commitCoordinate("x", 150);
    });
    expect(h.current().d).toBe("M20 20 L150 20 L120 120 L20 120 Z");
  });

  it("valores fuera de rango, sin selección o un nodo sin handle devuelven un mensaje y no crean comandos", () => {
    const h = harness();
    let error: string | null = null;
    act(() => {
      error = h.result.current.panel.commitCoordinate("x", 5);
    });
    expect(error).toContain("No hay nodos seleccionados");
    h.select([0, 1]);
    act(() => {
      error = h.result.current.panel.commitCoordinate("x", 1e9);
    });
    expect(error).toContain("fuera de rango");
    act(() => {
      error = h.result.current.panel.commitCoordinate("x", Number.NaN);
    });
    expect(error).toContain("fuera de rango");
    act(() => {
      error = h.result.current.panel.commitHandle("out", "length", 5);
    });
    expect(error).toContain("no tiene handle");
    expect(h.commands).toHaveLength(0);
  });

  it("handles: largo en mm y ángulo en grados medidos en documento; un largo negativo se rechaza", () => {
    const h = harness({ d: WAVE });
    h.select([0, 1]);
    const info = h.result.current.panel.handles!;
    expect(info.out!.length).toBeCloseTo(Math.hypot(20, 40) * 0.5, 9);
    expect(info.out!.angle).toBeCloseTo((Math.atan2(40, 20) * 180) / Math.PI, 9);
    expect(info.in!.angle).toBeCloseTo(((Math.atan2(40, 20) * 180) / Math.PI) - 180, 9);

    let error: string | null = null;
    act(() => {
      error = h.result.current.panel.commitHandle("out", "length", -1);
    });
    expect(error).toContain("negativo");
    act(() => {
      error = h.result.current.panel.commitHandle("out", "length", 10);
    });
    expect(error).toBeNull();
    const after = h.result.current.panel.handles!;
    expect(after.out!.length).toBeCloseTo(10, 6);
    // Simétrico: el handle de entrada acompaña con el mismo largo.
    expect(after.in!.length).toBeCloseTo(10, 6);
    expect(h.commands).toHaveLength(1);
  });

  it("multi-selección: valores comunes (o `null` si difieren) y el valor tecleado alinea todos", () => {
    const h = harness();
    h.select([0, 1], [0, 2]);
    expect(h.result.current.panel.x).toBe(60);
    expect(h.result.current.panel.y).toBeNull();
    act(() => {
      h.result.current.panel.commitCoordinate("x", 50);
    });
    expect(h.current().d).toBe("M20 20 L100 20 L100 120 L20 120 Z");
    expect(h.result.current.panel.kind).toBe("corner");
  });
});

describe("usePathTool — StrictMode", () => {
  it("el harness corre bajo StrictMode (efectos dobles): un arrastre sigue siendo UN comando", () => {
    const h = harness();
    act(() => {
      h.result.current.surface.onBeginDrag({ kind: "anchors", refs: [{ subpath: 0, node: 2 }] });
    });
    act(() => h.result.current.surface.onDragBy({ x: 5, y: 5 }, { shift: false, alt: false }));
    act(() => h.result.current.surface.onEndDrag());
    expect(h.commands).toHaveLength(1);
    expect(h.current().d).toBe("M20 20 L120 20 L125 125 L20 120 Z");
  });
});
