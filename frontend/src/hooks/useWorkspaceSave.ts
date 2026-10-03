import { useCallback, useEffect, useRef, useState } from "react";
import { saveWorkspace } from "../api/vectorDocumentApi";
import { ApiClientError } from "../api/httpClient";
import { clearWorkspaceRecoveryPointer, saveWorkspaceRecoveryPointer } from "../lib/workspaceRecovery";

/**
 * Máquina de estados real del indicador de guardado (M2.2-S05: botón manual; M2.2-S07: autosave).
 * Dos fuentes distintas escriben el MISMO indicador (ver `markDirty`/`trackPatch` más abajo,
 * spec.md M2.2-S07 "Estado Dirty/Saving/Saved/Error (dos fuentes, un solo indicador)"):
 *
 * - `idle`: todavía no hubo ninguna mutación en esta sesión del Workspace (o se acaba de cargar
 *   el documento).
 * - `dirty`: hubo al menos una mutación (rename/toggle/reorder/operación) desde el último Save
 *   exitoso. SOLO aplica a una sesión en STAGING (sin `savedProjectId` todavía): dispara el
 *   debounce de 2000 ms (ver `scheduleAutoSave`) que termina llamando a `save()` automáticamente
 *   -- el botón manual de `EditorHeader` sigue funcionando igual, para forzar el Save antes de
 *   que venza el debounce. En una sesión YA GUARDADA, `EditorShell` deja de llamar a
 *   `markDirty()` (ver spec.md M2.2-S07): cada PATCH-por-edición pasa directo por `trackPatch`.
 * - `saving`: un Save (staging, automático o manual) o un PATCH (ya guardado, vía `trackPatch`)
 *   en curso.
 * - `saved`: confirmado por el backend (200/201/respuesta real del PATCH) -- NUNCA optimista.
 * - `error`: el intento falló (red/409/422/500) -- mensaje visible, reintentable. En staging, el
 *   intento fallido NUNCA se pierde (la `idempotencyKey` del intento se conserva, ver más abajo)
 *   así que un reintento -- automático por una mutación nueva, o manual por el botón -- nunca
 *   duplica una versión en el backend si el intento anterior en realidad sí había llegado a
 *   persistirse (red lenta con timeout del lado del cliente).
 */
export type WorkspaceSaveState = "idle" | "dirty" | "saving" | "saved" | "error";

const GENERIC_ERROR_MESSAGE = "No se pudo guardar el documento. Intentá de nuevo.";
const PATCH_ERROR_MESSAGE = "No se pudo guardar el último cambio. Intentá de nuevo.";

/** M2.2-S07: ventana de inactividad desde la última mutación antes de disparar el primer Save automático en staging (spec.md: "Valor elegido por esta tarjeta ... ajustable sin romper nada más"). */
export const AUTOSAVE_DEBOUNCE_MS = 2000;

export interface UseWorkspaceSaveParams {
  /** Project.Id v2 ya conocido (sesión reabierta, o ya guardado antes en esta misma sesión) -- null si todavía no existe. */
  initialSavedProjectId: string | null;
  /** Nombre a usar SOLO en el primer Save (creación del Project v2) -- ignorado en Saves subsiguientes. */
  projectName: string;
  classicProjectId: string;
  imageId: string;
  paletteId: string | null;
  paletteVersion: number | null;
  /** Último DimensionResponse.DimensionId aplicado en esta sesión del Workspace, o null si nunca se aplicaron dimensiones físicas. */
  dimensionId: string | null;
}

export interface UseWorkspaceSaveState {
  state: WorkspaceSaveState;
  errorMessage: string | null;
  /** Project.Id v2 vigente -- null hasta que el primer Save exitoso lo resuelva. */
  savedProjectId: string | null;
  /**
   * Marca el documento como "dirty" (M2.2-S07): en STAGING, además arranca/resetea el debounce
   * de `AUTOSAVE_DEBOUNCE_MS` que dispara `save()` automáticamente -- no-op visible si ya está
   * guardando (la mutación se recuerda igual, ver "Cambio mientras un save está en vuelo" en
   * spec.md: el debounce se reprograma para después de que el actual resuelva, nunca aborta el
   * request en vuelo). Dejar de llamar este método desde una sesión YA GUARDADA es responsabilidad
   * de `EditorShell` (ver docstring del estado más arriba) -- este hook igual no agenda ningún
   * debounce si `savedProjectId` ya está resuelto, por si acaso.
   */
  markDirty: () => void;
  /**
   * Dispara el Save explícito (botón manual) -- no-op si no hay paleta/versión resuelta todavía
   * (documento no cargado). Único disparador que ABORTA un request en vuelo (spec.md M2.2-S07,
   * punto 4): el disparo automático del debounce nunca aborta nada.
   */
  save: () => void;
  /**
   * M2.2-S07: conecta el indicador compartido al ciclo de vida de UN PATCH individual
   * (`toggleVisibility`/`toggleLocked`/`renameLayer`/`reorderLayers`/operación de fabricación) en
   * una sesión YA GUARDADA -- llamado por `useVectorDocument`/`useManufacturingOperations` con la
   * promesa del PATCH ya en vuelo. Pone `state` en `"saving"` de inmediato, `"saved"`/`"error"`
   * según el resultado -- SIN tocar la lógica de rollback optimista que esos hooks ya manejan por
   * su cuenta (este método solo observa la promesa, nunca la crea ni la intercepta).
   */
  trackPatch: (promise: Promise<unknown>) => void;
}

export function useWorkspaceSave(params: UseWorkspaceSaveParams): UseWorkspaceSaveState {
  const [state, setState] = useState<WorkspaceSaveState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [savedProjectId, setSavedProjectId] = useState<string | null>(params.initialSavedProjectId);

  // Último valor de cada parámetro en una ref: `save()` es estable (no se recrea en cada
  // render) pero siempre debe mandar los valores VIGENTES al momento del click, no los
  // capturados en la clausura de cuando se creó el callback. Sincronizada vía `useEffect` (nunca
  // durante el render mismo) -- todos los lugares que leen `.current` lo hacen desde un callback
  // async/event handler, nunca desde el cuerpo del render, así que el efecto ya corrió para
  // cuando importa.
  const latestParamsRef = useRef(params);
  useEffect(() => {
    latestParamsRef.current = params;
  });

  const savedProjectIdRef = useRef(savedProjectId);
  useEffect(() => {
    savedProjectIdRef.current = savedProjectId;
  });

  const abortControllerRef = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => abortControllerRef.current?.abort();
  }, []);

  // M2.2-S07: tracking síncrono (vía ref, no `state` de React -- evita cualquier desfasaje de
  // un render pendiente) de si hay un Save de STAGING realmente en vuelo ahora mismo.
  const isSavingRef = useRef(false);
  // Una mutación llegó mientras ESE Save ya estaba en vuelo -- spec.md M2.2-S07, "Cambio mientras
  // un save está en vuelo": no se aborta nada, se recuerda acá y se reprograma el debounce recién
  // cuando el actual resuelva (éxito o error).
  const pendingDirtyWhileSavingRef = useRef(false);
  // GUID del intento lógico de guardar VIGENTE (null = no hay ningún intento sin confirmar) --
  // generado UNA vez por intento, reenviado tal cual en cada reintento de ESE mismo intento (ver
  // spec.md M2.2-S07, "Backend: idempotencia real"). Se limpia recién cuando ese intento se
  // confirma con éxito; sobrevive a un `error` (el reintento, automático o manual, reusa la MISMA
  // key) y se reemplaza por una nueva recién cuando una mutación nueva arranca un intento distinto.
  const idempotencyKeyRef = useRef<string | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearDebounceTimer = useCallback(() => {
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearDebounceTimer, [clearDebounceTimer]);

  // Referencias de función mutables (patrón "latest ref", mismo criterio que `latestParamsRef`
  // de arriba): `scheduleAutoSave`/`performSave`/`markDirty` se necesitan entre sí de forma
  // mutuamente recursiva (el timer del debounce dispara `performSave`, y `performSave` -- al
  // resolver con una mutación pendiente -- vuelve a llamar la lógica de `markDirty`) sin crear un
  // ciclo de dependencias de `useCallback`.
  const performSaveRef = useRef<(trigger: "auto" | "manual") => void>(() => {});
  const markDirtyRef = useRef<() => void>(() => {});

  const scheduleAutoSave = useCallback(() => {
    clearDebounceTimer();
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      if (isSavingRef.current) {
        // Defensivo (no debería dispararse: ver el guard de arriba en `markDirty`/`performSave`)
        // -- jamás se lanza un segundo POST concurrente para el mismo proyecto.
        pendingDirtyWhileSavingRef.current = true;
        return;
      }
      performSaveRef.current("auto");
    }, AUTOSAVE_DEBOUNCE_MS);
  }, [clearDebounceTimer]);

  const markDirty = useCallback(() => {
    if (isSavingRef.current) {
      pendingDirtyWhileSavingRef.current = true;
      return;
    }

    if (idempotencyKeyRef.current === null) {
      // Primera mutación de un intento lógico NUEVO -- key nueva. Si ya había una key vigente
      // (un intento previo todavía `dirty`/`error` sin confirmar), esta mutación se suma a ESE
      // mismo intento: nunca se reemplaza la key de un intento todavía no resuelto.
      idempotencyKeyRef.current = crypto.randomUUID();
    }

    setState("dirty");

    // El debounce de staging no aplica una vez que la sesión ya se guardó (M2.2-S05 cutover) --
    // `EditorShell` ya no llama a `markDirty` en ese modo, este guard es solo defensivo.
    if (!savedProjectIdRef.current) {
      scheduleAutoSave();
    }
  }, [scheduleAutoSave]);

  useEffect(() => {
    markDirtyRef.current = markDirty;
  }, [markDirty]);

  const performSave = useCallback(
    (trigger: "auto" | "manual") => {
      const current = latestParamsRef.current;
      if (!current.paletteId || current.paletteVersion === null) {
        return;
      }

      clearDebounceTimer();

      if (trigger === "manual") {
        // Único caso que aborta un request en vuelo (spec.md M2.2-S07, punto 4): el usuario
        // fuerza un Save nuevo a propósito. El disparo automático del debounce NUNCA llega acá
        // mientras `isSavingRef.current` es true (ver `scheduleAutoSave`), así que esta rama es
        // exclusiva del botón manual.
        if (isSavingRef.current) {
          // Bug real encontrado en revisión: si había un Save (automático) realmente en vuelo,
          // su idempotencyKey NUNCA se reusa para este intento manual nuevo -- si ese intento
          // abortado en realidad ya había llegado a persistirse del lado del servidor (la
          // cancelación del cliente no llegó a tiempo), reusar su key haría que este click
          // manual reciba ESE resultado viejo como si fuera la confirmación del guardado actual,
          // perdiendo en silencio cualquier edición hecha entre que ese intento arrancó y ahora.
          // Mejor un intento nuevo de punta a punta -- en el peor caso dos versiones en vez de
          // una, nunca contenido perdido mostrado como "guardado".
          idempotencyKeyRef.current = null;
        }
        abortControllerRef.current?.abort();
      } else if (isSavingRef.current) {
        pendingDirtyWhileSavingRef.current = true;
        return;
      }

      if (idempotencyKeyRef.current === null) {
        idempotencyKeyRef.current = crypto.randomUUID();
      }
      const idempotencyKey = idempotencyKeyRef.current;

      const controller = new AbortController();
      abortControllerRef.current = controller;
      isSavingRef.current = true;

      setState("saving");
      setErrorMessage(null);

      saveWorkspace(
        {
          projectId: savedProjectIdRef.current,
          name: savedProjectIdRef.current ? null : current.projectName,
          classicProjectId: current.classicProjectId,
          imageId: current.imageId,
          paletteId: current.paletteId,
          paletteVersion: current.paletteVersion,
          dimensionId: current.dimensionId,
          idempotencyKey,
        },
        controller.signal,
      )
        .then((response) => {
          isSavingRef.current = false;
          // "saved" solo tras esta confirmación real del backend -- nunca antes (requisito
          // explícito de la tarjeta).
          setSavedProjectId(response.projectId);
          // Intento cerrado con éxito: el próximo `markDirty` arranca un intento (y una key)
          // completamente nuevos.
          idempotencyKeyRef.current = null;

          if (pendingDirtyWhileSavingRef.current) {
            // Una mutación nueva llegó mientras ESTE Save estaba en vuelo -- spec.md M2.2-S07,
            // punto 4: se reprograma el debounce recién ahora, nunca mientras el anterior corría.
            pendingDirtyWhileSavingRef.current = false;
            markDirtyRef.current();
            return;
          }

          setState("saved");
        })
        .catch((error: unknown) => {
          isSavingRef.current = false;
          if (error instanceof ApiClientError && error.isAborted) {
            return;
          }

          if (pendingDirtyWhileSavingRef.current) {
            // Mismo criterio que la rama de éxito: una mutación nueva ya hace que este intento
            // fallido quede superado -- se reprograma un intento nuevo en vez de mostrar un error
            // ya obsoleto. Crítico: la key del intento fallido se DESCARTA acá (a diferencia del
            // retry manual de más abajo, que sí la conserva) -- si el intento fallido en realidad
            // sí había llegado a persistirse del lado del servidor (timeout solo del cliente),
            // reusar esa key para ESTE intento (que incluye la mutación nueva) haría que el
            // backend devuelva el resultado VIEJO del cache de idempotencia, perdiendo en
            // silencio la mutación nueva -- `markDirty()` arma una key fresca porque
            // `idempotencyKeyRef.current` queda null acá.
            idempotencyKeyRef.current = null;
            pendingDirtyWhileSavingRef.current = false;
            markDirtyRef.current();
            return;
          }

          // El intento NO se pierde: la idempotencyKey se conserva (ver arriba) para que un
          // reintento -- manual (botón "REINTENTAR") -- nunca duplique una versión si el intento
          // anterior en realidad sí había llegado a persistirse del lado del servidor.
          setState("error");
          if (error instanceof ApiClientError && !error.isNetworkError && error.body) {
            const body = error.body as { message?: string };
            setErrorMessage(body.message ?? GENERIC_ERROR_MESSAGE);
          } else {
            setErrorMessage(GENERIC_ERROR_MESSAGE);
          }
        });
    },
    [clearDebounceTimer],
  );

  useEffect(() => {
    performSaveRef.current = performSave;
  }, [performSave]);

  const save = useCallback(() => {
    performSaveRef.current("manual");
  }, []);

  const trackPatch = useCallback((promise: Promise<unknown>) => {
    setState("saving");
    setErrorMessage(null);
    promise.then(
      () => setState("saved"),
      () => {
        setState("error");
        setErrorMessage(PATCH_ERROR_MESSAGE);
      },
    );
  }, []);

  // M2.2-S07: recovery local SOLO como puntero (nunca el documento) -- ver lib/workspaceRecovery.ts.
  // Se actualiza mientras la sesión sigue en staging (`savedProjectId` null) y no confirmada
  // (`dirty`/`saving`/`error`); se borra apenas se confirma (`saved`) o la sesión ya tiene
  // `savedProjectId` (ya no es staging, la recuperación de una sesión guardada es vía deep-link
  // normal, no vía este puntero).
  useEffect(() => {
    if (savedProjectId) {
      clearWorkspaceRecoveryPointer();
      return;
    }

    if (state === "saved" || state === "idle") {
      clearWorkspaceRecoveryPointer();
      return;
    }

    const current = latestParamsRef.current;
    if (!current.paletteId) {
      return;
    }

    saveWorkspaceRecoveryPointer({
      classicProjectId: current.classicProjectId,
      imageId: current.imageId,
      paletteId: current.paletteId,
      updatedAt: new Date().toISOString(),
    });
  }, [state, savedProjectId]);

  // M2.2-S07: avisa al cerrar/recargar la pestaña si hay trabajo sin confirmar -- confirmación
  // NATIVA del navegador (spec.md: "¿Salir sin guardar?"), nunca un modal propio (no hay forma de
  // interceptar beforeunload con UI custom).
  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (state === "dirty" || state === "saving") {
        event.preventDefault();
        event.returnValue = "";
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [state]);

  return { state, errorMessage, savedProjectId, markDirty, save, trackPatch };
}
