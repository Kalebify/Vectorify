import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readRecentWorkspaceRecoveryPointer } from "../lib/workspaceRecovery";
import { AUTOSAVE_DEBOUNCE_MS, useWorkspaceSave } from "./useWorkspaceSave";

const CLASSIC_PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const IMAGE_ID = "22222222-2222-2222-2222-222222222222";
const PALETTE_ID = "33333333-3333-3333-3333-333333333333";
const SAVED_PROJECT_ID = "44444444-4444-4444-4444-444444444444";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function baseParams(overrides: Partial<Parameters<typeof useWorkspaceSave>[0]> = {}) {
  return {
    initialSavedProjectId: null,
    projectName: "Mi diseño",
    classicProjectId: CLASSIC_PROJECT_ID,
    imageId: IMAGE_ID,
    paletteId: PALETTE_ID,
    paletteVersion: 1,
    dimensionId: null,
    ...overrides,
  };
}

describe("useWorkspaceSave — máquina de estados idle/dirty/saving/saved/error", () => {
  it("arranca en 'idle' y markDirty lo pasa a 'dirty'", () => {
    const { result } = renderHook(() => useWorkspaceSave(baseParams()));

    expect(result.current.state).toBe("idle");

    act(() => result.current.markDirty());

    expect(result.current.state).toBe("dirty");
  });

  it("save() pasa por 'saving' y SOLO llega a 'saved' tras la confirmación real del backend (nunca optimista)", async () => {
    let resolveFetch!: (value: Response) => void;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetch);

    const { result } = renderHook(() => useWorkspaceSave(baseParams()));

    act(() => result.current.markDirty());
    expect(result.current.state).toBe("dirty");

    act(() => result.current.save());
    expect(result.current.state).toBe("saving");
    // Todavía no hay confirmación del backend -- JAMÁS debe mostrarse "saved" acá.
    expect(result.current.state).not.toBe("saved");

    resolveFetch(jsonResponse({ projectId: SAVED_PROJECT_ID, versionNumber: 1, savedAt: "2026-01-01T00:00:00Z" }, 201));

    await waitFor(() => expect(result.current.state).toBe("saved"));
    expect(result.current.savedProjectId).toBe(SAVED_PROJECT_ID);
  });

  it("manda projectId=null y name en el primer Save (sin savedProjectId todavía)", async () => {
    const fetch = vi.fn((_input: string, _init?: RequestInit) =>
      Promise.resolve(jsonResponse({ projectId: SAVED_PROJECT_ID, versionNumber: 1, savedAt: "2026-01-01T00:00:00Z" }, 201)),
    );
    vi.stubGlobal("fetch", fetch);

    const { result } = renderHook(() => useWorkspaceSave(baseParams({ projectName: "Proyecto nuevo" })));

    act(() => result.current.save());
    await waitFor(() => expect(result.current.state).toBe("saved"));

    const [, init] = fetch.mock.calls[0];
    const body = JSON.parse(init!.body as string);
    expect(body.projectId).toBeNull();
    expect(body.name).toBe("Proyecto nuevo");
    expect(body.classicProjectId).toBe(CLASSIC_PROJECT_ID);
    expect(body.paletteId).toBe(PALETTE_ID);
  });

  it("en Saves subsiguientes manda el projectId ya conocido y name null (no renombra sin que el usuario lo pida)", async () => {
    const fetch = vi.fn((_input: string, _init?: RequestInit) =>
      Promise.resolve(jsonResponse({ projectId: SAVED_PROJECT_ID, versionNumber: 2, savedAt: "2026-01-01T00:00:00Z" }, 200)),
    );
    vi.stubGlobal("fetch", fetch);

    const { result } = renderHook(() => useWorkspaceSave(baseParams({ initialSavedProjectId: SAVED_PROJECT_ID })));

    act(() => result.current.save());
    await waitFor(() => expect(result.current.state).toBe("saved"));

    const [, init] = fetch.mock.calls[0];
    const body = JSON.parse(init!.body as string);
    expect(body.projectId).toBe(SAVED_PROJECT_ID);
    expect(body.name).toBeNull();
  });

  it("falla (red/409/422/500) -> estado 'error' con mensaje visible, reintentable sin perder el intento", async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(jsonResponse({ code: "palette_not_confirmed", message: "La paleta debe estar confirmada." }, 422)),
    );
    vi.stubGlobal("fetch", fetch);

    const { result } = renderHook(() => useWorkspaceSave(baseParams()));

    act(() => result.current.save());
    await waitFor(() => expect(result.current.state).toBe("error"));
    expect(result.current.errorMessage).toBe("La paleta debe estar confirmada.");

    // Reintentable: un segundo save() vuelve a disparar la llamada sin que el hook quede trabado.
    const secondFetch = vi.fn(() =>
      Promise.resolve(jsonResponse({ projectId: SAVED_PROJECT_ID, versionNumber: 1, savedAt: "2026-01-01T00:00:00Z" }, 201)),
    );
    vi.stubGlobal("fetch", secondFetch);

    act(() => result.current.save());
    await waitFor(() => expect(result.current.state).toBe("saved"));
  });

  it("no dispara ningún fetch si todavía no hay paletteId/paletteVersion resueltos (documento no cargado)", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const { result } = renderHook(() => useWorkspaceSave(baseParams({ paletteId: null, paletteVersion: null })));

    act(() => result.current.save());

    expect(fetch).not.toHaveBeenCalled();
    expect(result.current.state).toBe("idle");
  });
});

describe("useWorkspaceSave — autosave de staging (debounce, M2.2-S07)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
  });

  it("markDirty() dispara un Save automático solo tras 2000ms de inactividad -- no antes", async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(jsonResponse({ projectId: SAVED_PROJECT_ID, versionNumber: 1, savedAt: "2026-01-01T00:00:00Z" }, 201)),
    );
    vi.stubGlobal("fetch", fetch);

    const { result } = renderHook(() => useWorkspaceSave(baseParams()));

    act(() => result.current.markDirty());
    expect(result.current.state).toBe("dirty");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS - 1);
    });
    expect(fetch).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe("saved");
    expect(result.current.savedProjectId).toBe(SAVED_PROJECT_ID);
  });

  it("cada mutación nueva reinicia la ventana de 2000ms -- 'no guardar por mousemove', se consolidan en un solo Save", async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(jsonResponse({ projectId: SAVED_PROJECT_ID, versionNumber: 1, savedAt: "2026-01-01T00:00:00Z" }, 201)),
    );
    vi.stubGlobal("fetch", fetch);

    const { result } = renderHook(() => useWorkspaceSave(baseParams()));

    act(() => result.current.markDirty());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(fetch).not.toHaveBeenCalled();

    // Nueva mutación ANTES de que venza el debounce -- reinicia la ventana completa.
    act(() => result.current.markDirty());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(fetch).not.toHaveBeenCalled(); // 1500ms desde el último markDirty, todavía no 2000

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(fetch).toHaveBeenCalledTimes(1); // recién ahora, 2000ms desde el ÚLTIMO markDirty
  });

  it("el click manual del botón Guardar dispara el Save antes de que venza el debounce, y cancela el disparo automático pendiente", async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(jsonResponse({ projectId: SAVED_PROJECT_ID, versionNumber: 1, savedAt: "2026-01-01T00:00:00Z" }, 201)),
    );
    vi.stubGlobal("fetch", fetch);

    const { result } = renderHook(() => useWorkspaceSave(baseParams()));

    act(() => result.current.markDirty());
    await act(async () => {
      result.current.save();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe("saved");

    // El debounce que `markDirty()` había arrancado NUNCA debe disparar un segundo Save.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 100);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("red lenta: el autosave muestra 'saving' todo el tiempo que tarda, sin disparar un segundo intento en paralelo", async () => {
    let resolveFetch!: (value: Response) => void;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetch);

    const { result } = renderHook(() => useWorkspaceSave(baseParams()));

    act(() => result.current.markDirty());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe("saving");

    // Nueva mutación mientras la red lenta todavía no respondió: NO dispara un segundo POST.
    act(() => result.current.markDirty());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 2);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe("saving");

    await act(async () => {
      resolveFetch(jsonResponse({ projectId: SAVED_PROJECT_ID, versionNumber: 1, savedAt: "2026-01-01T00:00:00Z" }, 201));
      await vi.advanceTimersByTimeAsync(0);
    });

    // La mutación pendiente reprograma el debounce recién ahora que el Save en vuelo resolvió.
    expect(result.current.state).toBe("dirty");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    });
    expect(fetch).toHaveBeenCalledTimes(2); // nunca dos POST concurrentes, pero sí uno nuevo después
  });

  it("offline: el autosave falla con un error de red -- estado 'error', mensaje honesto, reintentable", async () => {
    const fetch = vi.fn(() => Promise.reject(new TypeError("Failed to fetch")));
    vi.stubGlobal("fetch", fetch);

    const { result } = renderHook(() => useWorkspaceSave(baseParams()));

    act(() => result.current.markDirty());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    });

    expect(result.current.state).toBe("error");
    expect(result.current.errorMessage).toBeTruthy();

    // Reintentable manualmente sin perder el intento.
    const secondFetch = vi.fn(() =>
      Promise.resolve(jsonResponse({ projectId: SAVED_PROJECT_ID, versionNumber: 1, savedAt: "2026-01-01T00:00:00Z" }, 201)),
    );
    vi.stubGlobal("fetch", secondFetch);
    await act(async () => {
      result.current.save();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.state).toBe("saved");
  });

  it("conflicto (409) durante un autosave se expone como error, nunca se reintenta en loop infinito automáticamente", async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(jsonResponse({ code: "concurrency_conflict", message: "Conflicto de concurrencia." }, 409)),
    );
    vi.stubGlobal("fetch", fetch);

    const { result } = renderHook(() => useWorkspaceSave(baseParams()));

    act(() => result.current.markDirty());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    });
    expect(result.current.state).toBe("error");
    expect(result.current.errorMessage).toBe("Conflicto de concurrencia.");
    expect(fetch).toHaveBeenCalledTimes(1);

    // Sin ninguna mutación nueva, el tiempo pasa y NUNCA se reintenta solo.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 5);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reenvía la MISMA idempotencyKey en un reintento manual tras un error (mismo intento lógico)", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ code: "concurrency_conflict", message: "Conflicto." }, 409))
      .mockResolvedValueOnce(jsonResponse({ projectId: SAVED_PROJECT_ID, versionNumber: 1, savedAt: "2026-01-01T00:00:00Z" }, 201));
    vi.stubGlobal("fetch", fetch);

    const { result } = renderHook(() => useWorkspaceSave(baseParams()));

    act(() => result.current.markDirty());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    });
    expect(result.current.state).toBe("error");

    await act(async () => {
      result.current.save();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.state).toBe("saved");

    const firstKey = JSON.parse((fetch.mock.calls[0][1] as RequestInit).body as string).idempotencyKey;
    const secondKey = JSON.parse((fetch.mock.calls[1][1] as RequestInit).body as string).idempotencyKey;
    expect(firstKey).toBeTruthy();
    expect(secondKey).toBe(firstKey); // mismo intento lógico -- reintento, nunca una key nueva
  });

  it("el click manual descarta la idempotencyKey del autosave que está interrumpiendo -- nunca reusa la de un intento abortado", async () => {
    // Bug real encontrado en revisión del orquestador: si el autosave abortado en realidad ya
    // había llegado a persistirse del lado del servidor (la cancelación del cliente no llegó a
    // tiempo), reusar su key en el click manual haría que el backend devuelva ESE resultado
    // viejo como si fuera la confirmación del guardado actual -- perdiendo en silencio
    // cualquier edición hecha entre medio. El fetch nunca resuelve (simula el autosave
    // realmente en vuelo); el click manual debe armar una key DISTINTA para su propio intento.
    const fetch = vi.fn().mockImplementation(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetch);

    const { result } = renderHook(() => useWorkspaceSave(baseParams()));

    act(() => result.current.markDirty());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe("saving");

    act(() => result.current.save());

    expect(fetch).toHaveBeenCalledTimes(2);
    const firstKey = JSON.parse((fetch.mock.calls[0][1] as RequestInit).body as string).idempotencyKey;
    const secondKey = JSON.parse((fetch.mock.calls[1][1] as RequestInit).body as string).idempotencyKey;
    expect(secondKey).toBeTruthy();
    expect(secondKey).not.toBe(firstKey);
  });

  it("descarta la idempotencyKey vieja si una mutación nueva llega mientras el intento fallido todavía estaba en vuelo", async () => {
    // Regresión dirigida: si el intento ORIGINAL (key K) en realidad sí hubiera llegado a
    // persistirse del lado del servidor (timeout solo del cliente), reusar K para el intento
    // reprogramado -- que ya incluye la mutación nueva -- haría que el backend devuelva el
    // resultado VIEJO del cache de idempotencia, perdiendo en silencio la mutación nueva.
    let rejectFirst!: (reason: unknown) => void;
    const fetch = vi.fn().mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectFirst = reject;
        }),
    );
    vi.stubGlobal("fetch", fetch);

    const { result } = renderHook(() => useWorkspaceSave(baseParams()));

    act(() => result.current.markDirty());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const firstKey = JSON.parse((fetch.mock.calls[0][1] as RequestInit).body as string).idempotencyKey;

    // Mutación nueva mientras el primer intento sigue en vuelo.
    act(() => result.current.markDirty());

    const secondFetch = vi.fn((_input: string, _init?: RequestInit) =>
      Promise.resolve(jsonResponse({ projectId: SAVED_PROJECT_ID, versionNumber: 1, savedAt: "2026-01-01T00:00:00Z" }, 201)),
    );
    await act(async () => {
      vi.stubGlobal("fetch", secondFetch);
      rejectFirst(new TypeError("Failed to fetch")); // el primer intento termina fallando
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.state).toBe("dirty"); // reprogramado, nunca se muestra el error obsoleto
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    });

    expect(secondFetch).toHaveBeenCalledTimes(1);
    const secondKey = JSON.parse((secondFetch.mock.calls[0][1] as RequestInit).body as string).idempotencyKey;
    expect(secondKey).toBeTruthy();
    expect(secondKey).not.toBe(firstKey);
  });

  it("recovery: guarda un puntero liviano en localStorage mientras está dirty, y lo borra apenas se confirma el Save", async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(jsonResponse({ projectId: SAVED_PROJECT_ID, versionNumber: 1, savedAt: "2026-01-01T00:00:00Z" }, 201)),
    );
    vi.stubGlobal("fetch", fetch);

    const { result } = renderHook(() => useWorkspaceSave(baseParams()));

    expect(readRecentWorkspaceRecoveryPointer()).toBeNull();

    act(() => result.current.markDirty());
    const pointer = readRecentWorkspaceRecoveryPointer();
    expect(pointer).not.toBeNull();
    expect(pointer!.classicProjectId).toBe(CLASSIC_PROJECT_ID);
    expect(pointer!.imageId).toBe(IMAGE_ID);
    expect(pointer!.paletteId).toBe(PALETTE_ID);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    });
    expect(result.current.state).toBe("saved");
    expect(readRecentWorkspaceRecoveryPointer()).toBeNull(); // el contenido NUNCA se guarda acá -- solo el puntero, y se borra al confirmar
  });

  it("beforeunload: avisa (preventDefault) mientras el estado es 'dirty' o 'saving', nunca en 'saved'/'idle'", async () => {
    let resolveFetch!: (value: Response) => void;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetch);

    const { result } = renderHook(() => useWorkspaceSave(baseParams()));

    const dispatchBeforeUnload = () => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event;
    };

    expect(dispatchBeforeUnload().defaultPrevented).toBe(false); // idle

    act(() => result.current.markDirty());
    expect(dispatchBeforeUnload().defaultPrevented).toBe(true); // dirty

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    });
    expect(result.current.state).toBe("saving");
    expect(dispatchBeforeUnload().defaultPrevented).toBe(true); // saving

    await act(async () => {
      resolveFetch(jsonResponse({ projectId: SAVED_PROJECT_ID, versionNumber: 1, savedAt: "2026-01-01T00:00:00Z" }, 201));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.state).toBe("saved");
    expect(dispatchBeforeUnload().defaultPrevented).toBe(false); // saved
  });
});

describe("useWorkspaceSave — trackPatch (sesión ya guardada, M2.2-S07)", () => {
  it("pone 'saving' de inmediato y resuelve a 'saved' cuando el PATCH observado resuelve", async () => {
    const { result } = renderHook(() => useWorkspaceSave(baseParams({ initialSavedProjectId: SAVED_PROJECT_ID })));

    let resolvePatch!: (value: unknown) => void;
    const patchPromise = new Promise((resolve) => {
      resolvePatch = resolve;
    });

    act(() => result.current.trackPatch(patchPromise));
    expect(result.current.state).toBe("saving");

    await act(async () => {
      resolvePatch({ id: "layer-1" });
      await patchPromise;
    });
    expect(result.current.state).toBe("saved");
  });

  it("resuelve a 'error' cuando el PATCH observado rechaza -- sin tocar el rollback del llamador", async () => {
    const { result } = renderHook(() => useWorkspaceSave(baseParams({ initialSavedProjectId: SAVED_PROJECT_ID })));

    const patchPromise = Promise.reject(new Error("fallo simulado de PATCH"));
    // El llamador real (useVectorDocument) ya adjunta su propio .catch para el rollback -- acá
    // se adjunta uno extra SOLO para que Node no reporte una unhandled rejection en el test.
    patchPromise.catch(() => {});

    act(() => result.current.trackPatch(patchPromise));
    expect(result.current.state).toBe("saving");

    await act(async () => {
      await patchPromise.catch(() => {});
    });
    expect(result.current.state).toBe("error");
    expect(result.current.errorMessage).toBeTruthy();
  });

  it("no agenda ningún debounce de staging -- trackPatch es independiente del timer de markDirty", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);

      const { result } = renderHook(() => useWorkspaceSave(baseParams({ initialSavedProjectId: SAVED_PROJECT_ID })));

      act(() => result.current.trackPatch(Promise.resolve({})));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 2);
      });

      expect(fetch).not.toHaveBeenCalled(); // nunca dispara POST /workspaces/save
    } finally {
      vi.useRealTimers();
    }
  });
});
