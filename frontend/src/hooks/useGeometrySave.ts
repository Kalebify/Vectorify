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
 * - `idle`: no hay geometryDirty pendiente ni guardado en curso.
 * - `saving`: petición en vuelo.
 * - `saved`: último save confirmado por el backend. Se limpia a `idle` tras 4 s.
 * - `error`: el intento falló (red, 4xx, ≥3 fallos). Persiste hasta el próximo intento exitoso.
 */
export type GeometrySaveState = "idle" | "saving" | "saved" | "error";

/** Debounce tras `geometryDirty: true` antes de disparar el autosave (ms). */
export const GEOMETRY_AUTOSAVE_DEBOUNCE_MS = 3000;

/** Tiempo que el estado `saved` se muestra antes de volver a `idle` (ms). */
const SAVED_CLEAR_MS = 4000;

/** Reintentos máximos de red antes de pasar a `error` persistente. */
const MAX_RETRIES = 3;

/** Versión de esquema del formato de serialización. Debe coincidir con SCHEMA_VERSION de objects.ts. */
const SCHEMA_VERSION = 1;

export interface UseGeometrySaveParams {
  /** Project.Id v2 del proyecto cargado. Null si todavía no hay proyecto guardado (sin autosave). */
  projectId: string | null;
  /** API del documento editable: proporciona la geometría, el frame y el estado dirty. */
  editable: EditableDocumentApi;
  /** Capas EFECTIVAS del editor (servidor + isNew). Proviene de `editable.committedLayers`. */
  layers: VectorDocumentLayer[];
  /** mm por unidad de documento (de `mmPerUnit(...)`). Null si no hay escala física. */
  mmFactor: number | null;
  /** Callback llamado cuando el save se confirma (200/201). Recibe el número de versión creada. */
  onSaved?: (versionNumber: number) => void;
}

export interface UseGeometrySaveState {
  state: GeometrySaveState;
  errorMessage: string | null;
  /** true si el último error fue un 409 (conflicto de concurrencia). */
  conflictDetected: boolean;
  /**
   * Dispara el guardado manual de geometría inmediatamente (cancela el debounce pendiente).
   * No-op si `projectId` es null.
   */
  save: () => void;
}

export function useGeometrySave({
  projectId,
  editable,
  layers,
  mmFactor,
  onSaved,
}: UseGeometrySaveParams): UseGeometrySaveState {
  const [state, setState] = useState<GeometrySaveState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [conflictDetected, setConflictDetected] = useState(false);

  // Ref a los últimos valores para closures estables.
  const latestRef = useRef({ projectId, editable, layers, mmFactor, onSaved });
  useEffect(() => {
    latestRef.current = { projectId, editable, layers, mmFactor, onSaved };
  });

  const abortControllerRef = useRef<AbortController | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSavingRef = useRef(false);
  const retryCountRef = useRef(0);
  const idempotencyKeyRef = useRef<string | null>(null);

  // Limpia el timer de "saved" al desmontar.
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
      if (debounceTimerRef.current !== null) clearTimeout(debounceTimerRef.current);
      if (savedClearTimerRef.current !== null) clearTimeout(savedClearTimerRef.current);
    };
  }, []);

  // Función de perform save (ref para poder invocarla de forma mutuamente recursiva).
  const performSaveRef = useRef<(trigger: "auto" | "manual") => void>(() => {});

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

  /** Serializa el estado editable completo a los layers del request. */
  function buildLayers(
    currentLayers: VectorDocumentLayer[],
    currentEditable: EditableDocumentApi,
    _currentMmFactor: number | null,
  ): EditorSaveLayerRequestBody[] {
    const frame = currentEditable.committedFrame;
    const meta = {
      width: frame.width,
      height: frame.height,
      x: frame.x,
      y: frame.y,
    };

    return currentLayers.map((layer) => {
      const objects = currentEditable.committedObjectsByLayer[layer.groupId] ?? [];
      const svgContent = serializeEditableLayer(objects, meta);

      return {
        groupId: layer.groupId,
        svgContent,
        name: layer.name,
        order: layer.order,
        visible: layer.visible,
        locked: layer.locked,
        manufacturingOperation: layer.manufacturingOperation === "unassigned" ? null : layer.manufacturingOperation,
        isNew: layer.isNew ?? false,
        colorHex: layer.colorHex,
        colorCoverage: layer.areaPercent ?? 0,
        colorIsBackground: layer.isExcluded ?? false,
      };
    });
  }

  const performSave = useCallback(
    (trigger: "auto" | "manual") => {
      const { projectId: pid, editable: ed, layers: ls, mmFactor: mf, onSaved: cb } = latestRef.current;
      if (!pid) return;

      clearDebounce();
      clearSavedTimer();

      if (trigger === "manual") {
        // El click manual aborta el request en vuelo y usa una key nueva.
        if (isSavingRef.current) {
          abortControllerRef.current?.abort();
          idempotencyKeyRef.current = null;
        }
      } else if (isSavingRef.current) {
        // El autosave nunca lanza un segundo POST concurrente.
        return;
      }

      // Generar una idempotency key nueva si no hay una activa.
      if (idempotencyKeyRef.current === null) {
        idempotencyKeyRef.current = crypto.randomUUID();
        retryCountRef.current = 0;
      }

      const idempotencyKey = idempotencyKeyRef.current;
      const controller = new AbortController();
      abortControllerRef.current = controller;
      isSavingRef.current = true;

      setState("saving");
      setErrorMessage(null);
      setConflictDetected(false);

      // Serializar el estado actual del editor.
      const frame = ed.committedFrame;
      const serializedFrame = serializeFrame(frame, mf);

      const requestLayers = buildLayers(ls, ed, mf);
      const widthMm = serializedFrame.widthMm ?? ed.committedFrame.width;
      const heightMm = serializedFrame.heightMm ?? ed.committedFrame.height;

      editorSave(
        pid,
        {
          origin: trigger === "manual" ? "MANUAL_EDIT" : "AUTOSAVE",
          idempotencyKey,
          viewBox: serializedFrame.viewBox,
          widthMm,
          heightMm,
          schemaVersion: SCHEMA_VERSION,
          layers: requestLayers,
          removedLayerGroupIds: [],
        },
        controller.signal,
      )
        .then((response) => {
          isSavingRef.current = false;
          idempotencyKeyRef.current = null;
          retryCountRef.current = 0;

          // Limpiar el geometryDirty: el historial de undo se resetea via onSaved (EditorShell lo maneja).
          // onSaved notifica al EditorShell para que llame a clearHistory si corresponde.
          setState("saved");
          cb?.(response.versionNumber);

          // "saved" se limpia automáticamente a "idle" tras SAVED_CLEAR_MS.
          savedClearTimerRef.current = setTimeout(() => {
            savedClearTimerRef.current = null;
            setState((current) => (current === "saved" ? "idle" : current));
          }, SAVED_CLEAR_MS);
        })
        .catch((error: unknown) => {
          isSavingRef.current = false;

          if (error instanceof ApiClientError && error.isAborted) {
            return;
          }

          // Conflicto 409.
          if (error instanceof ApiClientError && error.status === 409) {
            idempotencyKeyRef.current = null;
            retryCountRef.current = 0;
            setState("error");
            setConflictDetected(true);
            setErrorMessage("Conflicto: el documento fue modificado por otro guardado concurrente. Recargá o intentá de nuevo.");
            return;
          }

          // Error 4xx (no de red, no 409): no reintenta.
          if (error instanceof ApiClientError && !error.isNetworkError && error.status !== undefined && error.status < 500) {
            idempotencyKeyRef.current = null;
            retryCountRef.current = 0;
            setState("error");
            const body = error.body as { message?: string } | undefined;
            setErrorMessage(body?.message ?? "No se pudo guardar la geometría. Intentá de nuevo.");
            return;
          }

          // Error de red o 5xx: reintento con backoff exponencial (1s → 2s → 4s).
          retryCountRef.current += 1;
          if (retryCountRef.current < MAX_RETRIES) {
            const delay = 1000 * Math.pow(2, retryCountRef.current - 1);
            debounceTimerRef.current = setTimeout(() => {
              debounceTimerRef.current = null;
              if (!isSavingRef.current) {
                performSaveRef.current("auto");
              }
            }, delay);
          } else {
            idempotencyKeyRef.current = null;
            retryCountRef.current = 0;
            setState("error");
            setErrorMessage("No se pudo guardar la geometría después de varios intentos. Verificá tu conexión e intentá de nuevo.");
          }
        });
    },
    [clearDebounce, clearSavedTimer],
  );

  useEffect(() => {
    performSaveRef.current = performSave;
  }, [performSave]);

  // Autosave: cuando geometryDirty pasa a true, inicia debounce de 3 s.
  const { geometryDirty } = editable;
  useEffect(() => {
    if (!geometryDirty || !projectId) return;

    // Si ya está guardando, no dispara el debounce (el hook espera a que termine).
    if (isSavingRef.current) return;

    clearDebounce();
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      performSaveRef.current("auto");
    }, GEOMETRY_AUTOSAVE_DEBOUNCE_MS);

    return () => {
      // El efecto se limpia cuando geometryDirty cambia (ej. se hizo undo hasta el origen).
      // No cancela un save en vuelo -- solo el timer de debounce.
    };
  }, [geometryDirty, projectId, clearDebounce]);

  const save = useCallback(() => {
    performSaveRef.current("manual");
  }, []);

  return { state, errorMessage, conflictDetected, save };
}
