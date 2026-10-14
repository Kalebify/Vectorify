import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildFillProduction } from "../lib/editor/colors";
import { replaceObjects } from "../lib/editor/selection";
import { translate } from "../lib/editor/transform";
import type { EditableDocument, EditorObject } from "../lib/editor/types";
import { abortAwareFetch, svgResponse } from "../test/abortableFetch";
import { cmd } from "../test/commands";
import { useEditableDocument } from "./useEditableDocument";
import { GEOMETRY_AUTOSAVE_DEBOUNCE_MS, GEOMETRY_SAVED_CLEAR_MS, useGeometrySave } from "./useGeometrySave";
import type { VectorDocumentLayer } from "./useVectorDocument";

/**
 * M3-S13: autosave/guardado manual de geometría. Se prueba contra el `useEditableDocument` REAL (la marca de guardado y `geometryDirty` son parte del
 * contrato) con `fetch` simulado y timers falsos para el debounce y el backoff.
 */

const PROJECT_ID = "44444444-4444-4444-4444-444444444444";
const SAVE_URL = `/api/v2/projects/${PROJECT_ID}/document/editor-save`;

function layer(overrides: Partial<VectorDocumentLayer> = {}): VectorDocumentLayer {
  return {
    groupId: "A",
    name: "Rojo",
    colorHex: "#ff0000",
    fill: "#ff0000",
    vectorId: "vector-a",
    svgUrl: "/svg/A",
    pathCount: 2,
    componentCount: 1,
    manufacturingOperation: "cut",
    order: 0,
    visible: true,
    locked: false,
    areaPercent: 60,
    hasPartialAlpha: false,
    isExcluded: false,
    ...overrides,
  };
}

const SVG_A = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><path data-vid="a1" d="M0 0 H10 V10 H0 Z" fill="#ff0000"/><path data-vid="a2" d="M20 0 H30 V10 H20 Z" fill="#ff0000"/></svg>`;
const SVG_B = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><path data-vid="b1" d="M0 20 H10 V30 H0 Z" fill="#0000ff"/></svg>`;
const LAYERS = [layer(), layer({ groupId: "B", name: "Azul", vectorId: "vector-b", svgUrl: "/svg/B", colorHex: "#0000ff", fill: "#0000ff", order: 1, pathCount: 1, manufacturingOperation: "unassigned" })];
const SIZE = { sourceSize: { width: 320, height: 240 } };

type SaveBody = Record<string, unknown> & { idempotencyKey: string; origin: string; layers: Array<Record<string, unknown>> };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

interface Server {
  saves: SaveBody[];
  signals: Array<AbortSignal | undefined>;
  /** Respuesta del PRÓXIMO editor-save (una sola vez); por defecto, éxito con versionNumber creciente. */
  respondNext: Array<(body: SaveBody) => Response | Promise<Response>>;
}

function installServer(layerUrls: Record<string, () => Response> = {}): Server {
  const server: Server = { saves: [], signals: [], respondNext: [] };
  vi.stubGlobal(
    "fetch",
    abortAwareFetch((url, init) => {
      if (url.endsWith(SAVE_URL)) {
        const body = JSON.parse(String(init?.body)) as SaveBody;
        server.saves.push(body);
        server.signals.push(init?.signal ?? undefined);
        const responder = server.respondNext.shift();
        if (responder) return responder(body);
        return jsonResponse({ projectId: PROJECT_ID, versionNumber: 10 + server.saves.length, versionId: "55555555-5555-5555-5555-555555555555", createdAt: "2026-01-01T00:00:00Z" });
      }
      if (layerUrls[url]) return layerUrls[url]();
      if (url === "/svg/A") return svgResponse(SVG_A);
      if (url === "/svg/B") return svgResponse(SVG_B);
      return svgResponse("no existe", 404);
    }),
  );
  return server;
}

function moveIds(ids: string[], dx: number) {
  return (state: { objectsByLayer: Record<string, EditorObject[]> }) => {
    const targets = Object.values(state.objectsByLayer)
      .flat()
      .filter((object) => ids.includes(object.id));
    return replaceObjects(state, targets, (found) => translate(found, dx, 0));
  };
}

async function setup(options: { projectId?: string | null; layers?: VectorDocumentLayer[]; waitReady?: boolean } = {}) {
  const projectId = options.projectId === undefined ? PROJECT_ID : options.projectId;
  const layers = options.layers ?? LAYERS;
  const onSaved = vi.fn();
  const hook = renderHook(() => {
    const editable = useEditableDocument(layers, { ...SIZE, documentKey: "doc" });
    const save = useGeometrySave({ projectId, editable, layers: editable.committedLayers, mmFactor: 0.5, onSaved });
    return { editable, save };
  });
  if (options.waitReady !== false) {
    await waitFor(() => expect(Object.values(hook.result.current.editable.layerStatus).every((status) => status === "ready")).toBe(true));
  }
  // El debounce/backoff se prueba con timers falsos, instalados DESPUÉS de la carga (que necesita timers reales).
  vi.useFakeTimers();
  const edit = (ids: string[] = ["a1"], dx = 5) => act(() => void hook.result.current.editable.applyEdit(cmd("Mover"), moveIds(ids, dx)));
  const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
  return { hook, onSaved, edit, advance };
}

describe("useGeometrySave", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe("autosave", () => {
    it("no guarda NADA hasta que pasen 3 s desde la edición; entonces manda UN request AUTOSAVE con todas las capas serializadas", async () => {
      const server = installServer();
      const { hook, edit, advance } = await setup();

      edit();
      await advance(GEOMETRY_AUTOSAVE_DEBOUNCE_MS - 1);
      expect(server.saves).toHaveLength(0);
      expect(hook.result.current.save.state).toBe("idle");

      await advance(1);
      expect(server.saves).toHaveLength(1);
      const [body] = server.saves;
      expect(body).toMatchObject({ origin: "AUTOSAVE", viewBox: "0 0 320 240", widthMm: 160, heightMm: 120, schemaVersion: 1, removedLayerGroupIds: [] });
      expect(body.idempotencyKey).toBeTruthy();
      expect(body.layers.map((entry) => entry.groupId)).toEqual(["A", "B"]); // TODAS las capas, tocadas o no
      expect(body.layers[0]).toMatchObject({ name: "Rojo", order: 0, visible: true, locked: false, manufacturingOperation: "cut", isNew: false, colorHex: "#ff0000" });
      expect(body.layers[1]).toMatchObject({ manufacturingOperation: null }); // "unassigned" viaja como null
      expect(String(body.layers[0].svgContent)).toContain("<path"); // la capa A serializada con su geometría
    });

    it("no guarda por 'mousemove': N cambios rápidos = un solo request, 3 s después del ÚLTIMO", async () => {
      const server = installServer();
      const { edit, advance } = await setup();

      edit(["a1"], 1);
      await advance(2000);
      edit(["a1"], 1);
      await advance(2000);
      edit(["a2"], 1);
      await advance(2999);
      expect(server.saves).toHaveLength(0);

      await advance(1);
      expect(server.saves).toHaveLength(1);
    });

    it("al confirmarse: 'saved', la geometría deja de estar sucia, el historial sigue intacto, onSaved recibe la versión, y 'saved' vuelve a 'idle' a los 4 s", async () => {
      installServer();
      const { hook, onSaved, edit, advance } = await setup();

      edit();
      await advance(GEOMETRY_AUTOSAVE_DEBOUNCE_MS);

      expect(hook.result.current.save.state).toBe("saved");
      expect(onSaved).toHaveBeenCalledWith(11);
      expect(hook.result.current.editable.geometryDirty).toBe(false);
      expect(hook.result.current.editable.undoDepth).toBe(1);
      expect(hook.result.current.editable.canUndo).toBe(true);

      await advance(GEOMETRY_SAVED_CLEAR_MS);
      expect(hook.result.current.save.state).toBe("idle");
    });

    it("sin edición no guarda; y tras guardar no vuelve a guardar solo (sin bucle)", async () => {
      const server = installServer();
      const { edit, advance } = await setup();

      await advance(GEOMETRY_AUTOSAVE_DEBOUNCE_MS * 3);
      expect(server.saves).toHaveLength(0);

      edit();
      await advance(GEOMETRY_AUTOSAVE_DEBOUNCE_MS);
      expect(server.saves).toHaveLength(1);
      await advance(GEOMETRY_AUTOSAVE_DEBOUNCE_MS * 5);
      expect(server.saves).toHaveLength(1);
    });

    it("sin projectId (primer guardado pendiente) no hace autosave", async () => {
      const server = installServer();
      const { hook, edit, advance } = await setup({ projectId: null });

      edit();
      await advance(GEOMETRY_AUTOSAVE_DEBOUNCE_MS * 2);

      expect(server.saves).toHaveLength(0);
      expect(hook.result.current.editable.geometryDirty).toBe(true);
    });

    it("una edición durante el guardado en vuelo NO se da por guardada: al confirmarse el primero, se guarda ella con otra idempotencyKey", async () => {
      const server = installServer();
      let release!: () => void;
      server.respondNext.push(
        () =>
          new Promise<Response>((resolve) => {
            release = () => resolve(jsonResponse({ projectId: PROJECT_ID, versionNumber: 11, versionId: "v1", createdAt: "2026-01-01T00:00:00Z" }));
          }),
      );
      const { hook, edit, advance } = await setup();

      edit(["a1"]);
      await advance(GEOMETRY_AUTOSAVE_DEBOUNCE_MS);
      expect(hook.result.current.save.state).toBe("saving");

      edit(["a2"]); // con el guardado todavía en vuelo
      await advance(GEOMETRY_AUTOSAVE_DEBOUNCE_MS * 2);
      expect(server.saves).toHaveLength(1); // nunca dos POST concurrentes

      await act(async () => release());
      await advance(0);
      expect(hook.result.current.editable.geometryDirty).toBe(true); // a2 sigue sin guardar

      await advance(GEOMETRY_AUTOSAVE_DEBOUNCE_MS);
      expect(server.saves).toHaveLength(2);
      expect(server.saves[1].idempotencyKey).not.toBe(server.saves[0].idempotencyKey);
      expect(hook.result.current.editable.geometryDirty).toBe(false);
    });

    it("serializa una capa creada en el cliente (Fill con color nuevo) como isNew con su color", async () => {
      const server = installServer();
      const { hook, advance } = await setup();

      act(() =>
        void hook.result.current.editable.applyEdit(cmd("Rellenar", "object.fill"), (state: EditableDocument) =>
          buildFillProduction(state, new Set(["a1"]), { kind: "new", hex: "#00ff00", groupId: "11111111-1111-1111-1111-111111111111" }),
        ),
      );
      await advance(GEOMETRY_AUTOSAVE_DEBOUNCE_MS);

      const created = server.saves[0].layers.find((entry) => entry.groupId === "11111111-1111-1111-1111-111111111111")!;
      expect(created).toMatchObject({ isNew: true, colorHex: "#00FF00", name: "Color #00FF00" });
      expect(String(created.svgContent)).toContain("<path");
    });
  });

  describe("guardado manual", () => {
    it("save() guarda ya (MANUAL_EDIT) y cancela el autosave pendiente: nunca un segundo POST", async () => {
      const server = installServer();
      const { hook, edit, advance } = await setup();

      edit();
      await advance(1000);
      act(() => hook.result.current.save.save());
      await advance(0);

      expect(server.saves).toHaveLength(1);
      expect(server.saves[0].origin).toBe("MANUAL_EDIT");
      expect(hook.result.current.save.state).toBe("saved");

      await advance(GEOMETRY_AUTOSAVE_DEBOUNCE_MS * 2);
      expect(server.saves).toHaveLength(1);
    });

    it("un click manual con un autosave en vuelo lo ABORTA y usa una idempotencyKey distinta; la respuesta de lo abortado no pisa el estado", async () => {
      const server = installServer();
      server.respondNext.push(() => new Promise<Response>(() => {})); // el autosave nunca responde
      const { hook, edit, advance } = await setup();

      edit();
      await advance(GEOMETRY_AUTOSAVE_DEBOUNCE_MS);
      expect(hook.result.current.save.state).toBe("saving");

      act(() => hook.result.current.save.save());
      await advance(0);

      expect(server.saves).toHaveLength(2);
      expect(server.signals[0]?.aborted).toBe(true);
      expect(server.saves[1].idempotencyKey).not.toBe(server.saves[0].idempotencyKey);
      expect(hook.result.current.save.state).toBe("saved");
    });

    it("sin projectId, save() no hace nada", async () => {
      const server = installServer();
      const { hook, edit, advance } = await setup({ projectId: null });

      edit();
      act(() => hook.result.current.save.save());
      await advance(0);

      expect(server.saves).toHaveLength(0);
      expect(hook.result.current.save.state).toBe("idle");
    });
  });

  describe("fallos", () => {
    it("offline: reintenta con backoff 1 s → 2 s con la MISMA idempotencyKey y, tras 3 intentos, queda en 'error' (sin bucle infinito)", async () => {
      const server = installServer();
      const failing = () => Promise.reject(new TypeError("Failed to fetch"));
      server.respondNext.push(failing, failing, failing);
      const { hook, edit, advance } = await setup();

      edit();
      await advance(GEOMETRY_AUTOSAVE_DEBOUNCE_MS);
      expect(server.saves).toHaveLength(1);
      expect(hook.result.current.save.state).toBe("saving"); // esperando el reintento

      await advance(999);
      expect(server.saves).toHaveLength(1);
      await advance(1);
      expect(server.saves).toHaveLength(2);

      await advance(1999);
      expect(server.saves).toHaveLength(2);
      await advance(1);
      expect(server.saves).toHaveLength(3);

      expect(hook.result.current.save.state).toBe("error");
      expect(hook.result.current.save.errorMessage).toMatch(/varios intentos/);
      expect(hook.result.current.save.conflictDetected).toBe(false);
      expect(new Set(server.saves.map((body) => body.idempotencyKey)).size).toBe(1); // mismo intento lógico
      expect(hook.result.current.editable.geometryDirty).toBe(true); // el trabajo NO se da por guardado

      await advance(60_000);
      expect(server.saves).toHaveLength(3);
    });

    it("tras agotar los reintentos de red, la próxima edición vuelve a intentar con una key nueva y puede guardar", async () => {
      const server = installServer();
      const failing = () => Promise.reject(new TypeError("Failed to fetch"));
      server.respondNext.push(failing, failing, failing);
      const { hook, edit, advance } = await setup();

      edit(["a1"]);
      await advance(GEOMETRY_AUTOSAVE_DEBOUNCE_MS + 3000);
      expect(hook.result.current.save.state).toBe("error");

      edit(["a2"]);
      await advance(GEOMETRY_AUTOSAVE_DEBOUNCE_MS);

      expect(server.saves).toHaveLength(4);
      expect(server.saves[3].idempotencyKey).not.toBe(server.saves[0].idempotencyKey);
      expect(hook.result.current.save.state).toBe("saved");
      expect(hook.result.current.editable.geometryDirty).toBe(false);
    });

    it("una edición nueva durante la espera de un reintento descarta la key vieja (el payload cambió)", async () => {
      const server = installServer();
      server.respondNext.push(() => Promise.reject(new TypeError("Failed to fetch")));
      const { edit, advance } = await setup();

      edit(["a1"]);
      await advance(GEOMETRY_AUTOSAVE_DEBOUNCE_MS);
      expect(server.saves).toHaveLength(1);

      edit(["a2"]); // durante el backoff
      await advance(GEOMETRY_AUTOSAVE_DEBOUNCE_MS);

      expect(server.saves).toHaveLength(2);
      expect(server.saves[1].idempotencyKey).not.toBe(server.saves[0].idempotencyKey);
    });

    it("409: 'error' con conflictDetected, NO reintenta ni re-guarda solo; el guardado manual lo resuelve", async () => {
      const server = installServer();
      server.respondNext.push(() => jsonResponse({ code: "concurrency_conflict", message: "Conflicto." }, 409));
      const { hook, edit, advance } = await setup();

      edit(["a1"]);
      await advance(GEOMETRY_AUTOSAVE_DEBOUNCE_MS);
      expect(hook.result.current.save.state).toBe("error");
      expect(hook.result.current.save.conflictDetected).toBe(true);
      expect(hook.result.current.save.errorMessage).toMatch(/Conflicto/);

      await advance(60_000);
      expect(server.saves).toHaveLength(1);

      edit(["a2"]); // seguir editando tampoco dispara otro autosave contra el mismo conflicto
      await advance(GEOMETRY_AUTOSAVE_DEBOUNCE_MS * 2);
      expect(server.saves).toHaveLength(1);

      act(() => hook.result.current.save.save());
      await advance(0);
      expect(server.saves).toHaveLength(2);
      expect(server.saves[1].origin).toBe("MANUAL_EDIT");
      expect(hook.result.current.save.state).toBe("saved");
      expect(hook.result.current.save.conflictDetected).toBe(false);
      expect(hook.result.current.editable.geometryDirty).toBe(false);
    });

    it("4xx de validación: 'error' con el mensaje del servidor, sin reintentos", async () => {
      const server = installServer();
      server.respondNext.push(() => jsonResponse({ code: "invalid_parameters", message: "viewBox inválido." }, 400));
      const { hook, edit, advance } = await setup();

      edit();
      await advance(GEOMETRY_AUTOSAVE_DEBOUNCE_MS + 10_000);

      expect(hook.result.current.save.state).toBe("error");
      expect(hook.result.current.save.errorMessage).toBe("viewBox inválido.");
      expect(hook.result.current.save.conflictDetected).toBe(false);
      expect(server.saves).toHaveLength(1);
    });

    it("500 del servidor: se trata como transitorio (reintenta)", async () => {
      const server = installServer();
      server.respondNext.push(() => jsonResponse({ code: "internal_error", message: "Falló." }, 500));
      const { hook, edit, advance } = await setup();

      edit();
      await advance(GEOMETRY_AUTOSAVE_DEBOUNCE_MS + 1000);

      expect(server.saves).toHaveLength(2);
      expect(hook.result.current.save.state).toBe("saved");
    });

    it("NUNCA guarda con una capa sin cargar (se serializaría vacía y se perdería su geometría): el manual avisa, el autosave espera", async () => {
      const server = installServer({ "/svg/B": () => svgResponse("roto", 500) });
      const { hook, edit, advance } = await setup({ waitReady: false });
      // La capa A carga; la B falla: queda en error de carga.
      vi.useRealTimers();
      await waitFor(() => expect(hook.result.current.editable.layerStatus).toMatchObject({ A: "ready", B: "error" }));
      vi.useFakeTimers();

      edit(["a1"]);
      await advance(GEOMETRY_AUTOSAVE_DEBOUNCE_MS * 2);
      expect(server.saves).toHaveLength(0);

      act(() => hook.result.current.save.save());
      await advance(0);
      expect(server.saves).toHaveLength(0);
      expect(hook.result.current.save.state).toBe("error");
      expect(hook.result.current.save.errorMessage).toMatch(/todavía no terminaron de cargar/);
    });
  });

  describe("ciclo de vida", () => {
    it("desmontar aborta la petición en vuelo", async () => {
      const server = installServer();
      server.respondNext.push(() => new Promise<Response>(() => {}));
      const { hook, edit, advance } = await setup();

      edit();
      await advance(GEOMETRY_AUTOSAVE_DEBOUNCE_MS);
      expect(server.signals[0]?.aborted).toBe(false);

      hook.unmount();

      expect(server.signals[0]?.aborted).toBe(true);
    });

    it("desmontar cancela el autosave pendiente", async () => {
      const server = installServer();
      const { hook, edit, advance } = await setup();

      edit();
      hook.unmount();
      await advance(GEOMETRY_AUTOSAVE_DEBOUNCE_MS * 2);

      expect(server.saves).toHaveLength(0);
    });

    it("suspendAutosave cancela el debounce pendiente y pausa el autosave hasta un guardado manual (p. ej. mientras se restaura una versión)", async () => {
      const server = installServer();
      const { hook, edit, advance } = await setup();

      edit(["a1"]);
      act(() => hook.result.current.save.suspendAutosave());
      await advance(GEOMETRY_AUTOSAVE_DEBOUNCE_MS * 2);
      expect(server.saves).toHaveLength(0);

      edit(["a2"]);
      await advance(GEOMETRY_AUTOSAVE_DEBOUNCE_MS * 2);
      expect(server.saves).toHaveLength(0); // sigue pausado

      act(() => hook.result.current.save.save());
      await advance(0);
      expect(server.saves).toHaveLength(1);
    });

    it("suspendAutosave aborta lo que esté en vuelo", async () => {
      const server = installServer();
      server.respondNext.push(() => new Promise<Response>(() => {}));
      const { hook, edit, advance } = await setup();

      edit();
      await advance(GEOMETRY_AUTOSAVE_DEBOUNCE_MS);
      act(() => hook.result.current.save.suspendAutosave());

      expect(server.signals[0]?.aborted).toBe(true);
      expect(hook.result.current.save.state).toBe("idle");
    });
  });
});

beforeEach(() => {
  vi.useRealTimers();
});
