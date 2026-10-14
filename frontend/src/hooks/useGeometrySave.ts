import { useCallback, useEffect, useRef, useState } from "react";
import { editorSave } from "../api/vectorDocumentApi";
import { ApiClientError } from "../api/httpClient";
import type { EditorSaveLayerRequestBody } from "../types/vectorDocument";
import type { EditableDocumentApi } from "./useEditableDocument";
import type { VectorDocumentLayer } from "./useVectorDocument";
import { serializeEditableLayer } from "../lib/editor/objects";
import { serializeFrame } from "../lib/editor/frame";

/**
 * Estado de guardado de geometría (M3-S13).
 * - `idle`: no hay guardado en curso ni resultado reciente que mostrar.
 * - `saving`: petición en vuelo.
 * - `saved`: último guardado confirmado por el backend. Vuelve a `idle` tras 4 s.
 * - `error`: el intento falló (red tras reintentos, 4xx, conflicto). Persiste hasta el próximo intento exitoso.
 */
export type GeometrySaveState = "idle" | "saving" | "saved" | "error";

/** Debounce tras la ÚLTIMA edición antes de disparar el autosave (ms). */
export const GEOMETRY_AUTOSAVE_DEBOUNCE_MS = 3000;

/** Tiempo que el estado `saved` se muestra antes de volver a `idle` (ms). */
export const GEOMETRY_SAVED_CLEAR_MS = 4000;

/** Intentos máximos ante errores de red / 5xx antes de pasar a `error` (backoff 1 s → 2 s). */
export const GEOMETRY_MAX_ATTEMPTS = 3;

/** Versión de esquema del formato de serialización. Debe coincidir con SCHEMA_VERSION de objects.ts. */
const SCHEMA_VERSION = 1;

const UNLOADED_LAYERS_MESSAGE = "Hay capas que todavía no terminaron de cargar: esperá a que carguen para guardar.";

export interface UseGeometrySaveParams {
  /** Project.Id v2 del proyecto cargado. Null si todavía no hay proyecto guardado (sin autosave). */
  projectId: string | null;
  /** API del documento editable: proporciona la geometría, el frame y el estado dirty. */
  editable: EditableDocumentApi;
  /** Capas EFECTIVAS del editor (servidor + isNew). Proviene de `editable.committedLayers`. */
  layers: VectorDocumentLayer[];
  /** mm por unidad de documento (de `mmPerUnit(...)`). Null si no hay escala física. */
  mmFactor: number | null;
  /** Llamado cuando el backend confirma el guardado (después de `editable.markSaved`). Recibe el número de versión creada. */
  onSaved?: (versionNumber: number) => void;
}

export interface UseGeometrySaveState {
  state: GeometrySaveState;
  errorMessage: string | null;
  /** true si el último error fue un 409 (conflicto de concurrencia). */
  conflictDetected: boolean;
  /** Guardado manual inmediato (cancela el debounce pendiente). Re-habilita el autosave si un error lo había pausado. No-op sin `projectId`. */
  save: () => void;
  /** Cancela el debounce, aborta lo que esté en vuelo y pausa el autosave hasta el próximo `save()` manual (p. ej. antes de restaurar una versión). */
  suspendAutosave: () => void;
}

export function useGeometrySave({ projectId, editable, layers, mmFactor, onSaved }: UseGeometrySaveParams): UseGeometrySaveState {
  const [state, setState] = useState<GeometrySaveState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [conflictDetected, setConflictDetected] = useState(false);
  // Se incrementa al terminar un guardado: re-arma el autosave si hubo ediciones mientras estaba en vuelo.
  const [settledCount, setSettledCount] = useState(0);

  const latestRef = useRef({ projectId, editable, layers, mmFactor, onSaved });
  useEffect(() => {
    latestRef.current = { projectId, editable, layers, mmFactor, onSaved };
  });

  const abortControllerRef = useRef<AbortController | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSavingRef = useRef(false);
  // Identifica la petición vigente: la respuesta de una abortada/reemplazada se ignora (no puede pisar el estado de la nueva).
  const requestSeqRef = useRef(0);
  const attemptsRef = useRef(0);
  const idempotencyKeyRef = useRef<string | null>(null);
  // Hubo ediciones mientras el intento en curso estaba en vuelo: su idempotencyKey ya no describe el payload actual.
  const editsDuringSaveRef = useRef(false);
  // Tras un 4xx/409 o `suspendAutosave` el autosave espera a un guardado manual (si no, cada edición re-golpearía el mismo error).
  const autosaveBlockedRef = useRef(false);

  const clearDebounce = useCallback(() => {
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
  }, []);

  const clearSavedTimer = useCallback(() => {
    if (savedClearTimerRef.current !== null) {
      clearTimeout(savedClearTimerRef.current);
      savedClearTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      requestSeqRef.current += 1;
      abortControllerRef.current?.abort();
      if (debounceTimerRef.current !== null) clearTimeout(debounceTimerRef.current);
      if (savedClearTimerRef.current !== null) clearTimeout(savedClearTimerRef.current);
    };
  }, []);

  const performSaveRef = useRef<(trigger: "auto" | "manual") => void>(() => {});

  const performSave = useCallback(
    (trigger: "auto" | "manual") => {
      const { projectId: pid, editable: ed, layers: ls, mmFactor: mf } = latestRef.current;
      if (!pid) return;

      clearDebounce();

      if (trigger === "manual") {
        autosaveBlockedRef.current = false;
        if (isSavingRef.current) {
          // El click manual reemplaza al intento en vuelo y NUNCA reusa su key: si el servidor ya lo persistió, devolvería ese resultado viejo.
          abortControllerRef.current?.abort();
          idempotencyKeyRef.current = null;
        }
      } else if (isSavingRef.current || autosaveBlockedRef.current) {
        return;
      }

      // Nunca se serializa una capa que no terminó de cargar: se guardaría vacía y se perdería su geometría en el servidor.
      if (ls.some((layer) => ed.layerStatus[layer.groupId] !== "ready")) {
        if (trigger === "manual") {
          setState("error");
          setErrorMessage(UNLOADED_LAYERS_MESSAGE);
          setConflictDetected(false);
        }
        return;
      }

      clearSavedTimer();

      if (idempotencyKeyRef.current === null) {
        idempotencyKeyRef.current = crypto.randomUUID();
        attemptsRef.current = 0;
      }
      const idempotencyKey = idempotencyKeyRef.current;
      editsDuringSaveRef.current = false;

      const controller = new AbortController();
      abortControllerRef.current = controller;
      const requestId = ++requestSeqRef.current;
      isSavingRef.current = true;
      attemptsRef.current += 1;

      setState("saving");
      setErrorMessage(null);
      setConflictDetected(false);

      // Todo sale del MISMO render: la geometría, el marco, las capas y la marca que se declarará guardada.
      const frame = ed.committedFrame;
      const serializedFrame = serializeFrame(frame, mf);
      const mark = ed.saveMark;
      const meta = { width: frame.width, height: frame.height, x: frame.x, y: frame.y };
      const requestLayers: EditorSaveLayerRequestBody[] = ls.map((layer) => ({
        groupId: layer.groupId,
        svgContent: serializeEditableLayer(ed.committedObjectsByLayer[layer.groupId] ?? [], meta),
        name: layer.name,
        order: layer.order,
        visible: layer.visible,
        locked: layer.locked,
        manufacturingOperation: layer.manufacturingOperation === "unassigned" ? null : layer.manufacturingOperation,
        isNew: layer.isNew ?? false,
        colorHex: layer.colorHex,
        colorCoverage: layer.areaPercent ?? 0,
        colorIsBackground: layer.isExcluded ?? false,
      }));

      editorSave(
        pid,
        {
          origin: trigger === "manual" ? "MANUAL_EDIT" : "AUTOSAVE",
          idempotencyKey,
          viewBox: serializedFrame.viewBox,
          widthMm: serializedFrame.widthMm ?? frame.width,
          heightMm: serializedFrame.heightMm ?? frame.height,
          schemaVersion: SCHEMA_VERSION,
          layers: requestLayers,
          removedLayerGroupIds: [],
        },
        controller.signal,
      )
        .then((response) => {
          if (requestId !== requestSeqRef.current) return;
          isSavingRef.current = false;
          idempotencyKeyRef.current = null;
          attemptsRef.current = 0;
          autosaveBlockedRef.current = false;

          // Lo editado entre el envío y esta confirmación NO queda marcado como guardado (la marca es la del envío).
          latestRef.current.editable.markSaved(mark);
          setState("saved");
          latestRef.current.onSaved?.(response.versionNumber);
          setSettledCount((count) => count + 1);

          savedClearTimerRef.current = setTimeout(() => {
            savedClearTimerRef.current = null;
            setState((current) => (current === "saved" ? "idle" : current));
          }, GEOMETRY_SAVED_CLEAR_MS);
        })
        .catch((error: unknown) => {
          if (requestId !== requestSeqRef.current) return;
          isSavingRef.current = false;
          if (error instanceof ApiClientError && error.isAborted) return;

          const fail = (message: string, conflict = false, block = true) => {
            idempotencyKeyRef.current = null;
            attemptsRef.current = 0;
            if (block) autosaveBlockedRef.current = true;
            setState("error");
            setErrorMessage(message);
            setConflictDetected(conflict);
          };

          if (error instanceof ApiClientError && error.status === 409) {
            fail("Conflicto: el documento fue modificado por otro guardado concurrente. Recargá el documento o reintentá (puede sobrescribir esa otra versión).", true);
            return;
          }

          // 4xx (no de red): reintentar no lo arregla.
          if (error instanceof ApiClientError && !error.isNetworkError && error.status !== undefined && error.status < 500) {
            const body = error.body as { message?: string } | undefined;
            fail(body?.message ?? "No se pudo guardar la geometría. Intentá de nuevo.");
            return;
          }

          // Red / 5xx: reintento con backoff exponencial (1 s, 2 s) con la MISMA key, salvo que haya habido ediciones nuevas (payload distinto).
          if (editsDuringSaveRef.current) idempotencyKeyRef.current = null;
          if (attemptsRef.current < GEOMETRY_MAX_ATTEMPTS) {
            const delay = 1000 * 2 ** (attemptsRef.current - 1);
            setState("saving");
            debounceTimerRef.current = setTimeout(() => {
              debounceTimerRef.current = null;
              performSaveRef.current("auto");
            }, delay);
          } else {
            fail("No se pudo guardar la geometría después de varios intentos. Verificá tu conexión e intentá de nuevo.", false, false);
          }
        });
    },
    [clearDebounce, clearSavedTimer],
  );

  useEffect(() => {
    performSaveRef.current = performSave;
  }, [performSave]);

  // Autosave: cada edición (cambia `saveMark`) reinicia la ventana de 3 s; un solo POST tras N cambios rápidos.
  const { geometryDirty, saveMark } = editable;
  useEffect(() => {
    if (!geometryDirty || !projectId || autosaveBlockedRef.current) return;
    if (isSavingRef.current) {
      editsDuringSaveRef.current = true;
      return;
    }
    // Hay una edición nueva: es un intento lógico nuevo (la key del intento anterior describe otro payload).
    idempotencyKeyRef.current = null;
    attemptsRef.current = 0;
    clearDebounce();
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      performSaveRef.current("auto");
    }, GEOMETRY_AUTOSAVE_DEBOUNCE_MS);
  }, [geometryDirty, projectId, saveMark, settledCount, clearDebounce]);

  const save = useCallback(() => performSaveRef.current("manual"), []);

  const suspendAutosave = useCallback(() => {
    clearDebounce();
    requestSeqRef.current += 1;
    abortControllerRef.current?.abort();
    isSavingRef.current = false;
    idempotencyKeyRef.current = null;
    attemptsRef.current = 0;
    autosaveBlockedRef.current = true;
    setState((current) => (current === "saving" ? "idle" : current));
  }, [clearDebounce]);

  return { state, errorMessage, conflictDetected, save, suspendAutosave };
}
