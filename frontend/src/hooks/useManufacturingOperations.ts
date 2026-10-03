import { useCallback, useEffect, useRef, useState } from "react";
import { assignManufacturingOperation, getManufacturingOperations } from "../api/manufacturingOperationsApi";
import { ApiClientError } from "../api/httpClient";
import { updateVectorDocumentLayer } from "../api/vectorDocumentApi";
import type { ApiErrorResponse } from "../types/preprocess";
import type {
  ManufacturingOperationChoice,
  ManufacturingOperationErrorCode,
  ManufacturingOperationPayload,
  ManufacturingOperationSummaryPayload,
  ManufacturingOperationValue,
} from "../types/manufacturingOperations";

const GENERIC_ERROR_MESSAGE = "No se pudo completar la operación de fabricación. Intentá de nuevo.";

const EMPTY_SUMMARY: ManufacturingOperationSummaryPayload = {
  cutCount: 0,
  engraveCount: 0,
  ignoreCount: 0,
  unassignedCount: 0,
  totalCount: 0,
};

const KNOWN_ERROR_CODES: ManufacturingOperationErrorCode[] = [
  "not_found",
  "group_not_found",
  "invalid_parameters",
  "internal_error",
  "network_error",
];

function isKnownErrorCode(code: string): code is ManufacturingOperationErrorCode {
  return (KNOWN_ERROR_CODES as string[]).includes(code);
}

export interface UseManufacturingOperationsState {
  /** groupId -> intención de fabricación vigente ("unassigned" si la capa nunca recibió una asignación explícita, ver spec.md). */
  operations: Record<string, ManufacturingOperationPayload>;
  summary: ManufacturingOperationSummaryPayload;
  errorCode: ManufacturingOperationErrorCode | null;
  errorMessage: string | null;
  /** groupId de la capa cuya operación se está asignando/reasignando, para deshabilitar su selector mientras la request está en curso. */
  mutatingGroupId: string | null;
  assign: (groupId: string, operation: ManufacturingOperationChoice) => void;
}

/**
 * Orquesta la asignación de intención de fabricación por capa (M2-S07): pura
 * metadata sobre el conjunto de capas YA generado por M2-S02 -- nunca
 * dispara ningún cálculo. Recupera automáticamente las asignaciones YA
 * persistidas apenas el conjunto de capas ACTUAL (identificado por
 * `layerSetId`) está disponible -- una sola vez por layerSetId, mismo
 * criterio que useComponentGroups (recuperar apenas hay algo que recuperar,
 * sin que el usuario tenga que pedirlo). Si la paleta se recalcula
 * (`layerSetId` nuevo), las asignaciones anteriores NO se migran
 * automáticamente: se vuelve a pedir el conjunto (vacío / "unassigned" para
 * todas hasta que el usuario asigne de nuevo) -- mismo criterio que el
 * backend (ver ManufacturingOperationService).
 *
 * Cutover post-Save (M2.2-S05, ronda de fix 1): con `savedProjectId` activo (Workspace ya
 * guardado, ver `useVectorDocument`), este hook NUNCA pide el conjunto clásico
 * `GET .../layers/operations` -- ese sidecar quedó congelado en el estado de la sesión de
 * staging que produjo el último Save, no refleja ediciones post-Save (que ahora viven en
 * `Data.Layer`, no en el sidecar). El valor inicial de cada capa ya lo trae `useVectorDocument`
 * (`document.layers[].manufacturingOperation`, resuelto desde `GET .../document`) -- los
 * paneles que consumen este hook ya hacen fallback a ese valor cuando `operations[groupId]` no
 * existe (ver `operations[layer.groupId]?.operation ?? layer.manufacturingOperation` en
 * `EditorLayersPanel.tsx`/`InspectorPanel.tsx`), así que dejar `operations` vacío en este modo
 * sigue mostrando el valor correcto. `assign()` persiste vía
 * `PATCH /api/v2/projects/{savedProjectId}/layers/{groupId}` en vez del sidecar clásico.
 * `summary` (cutCount/engraveCount/...) es una vista agregada propia del sidecar clásico sin
 * equivalente en la DB en esta tarjeta -- queda en su valor inicial en este modo; ningún panel
 * del Workspace guardado lo lee (ver `EditorShell.tsx`).
 */
export function useManufacturingOperations(
  projectId: string,
  imageId: string,
  paletteId: string | null,
  layerSetId: string | null,
  /** Project.Id v2 ya guardado -- ver docstring de arriba. Null/undefined = comportamiento existente sin cambios (staging). */
  savedProjectId?: string | null,
): UseManufacturingOperationsState {
  const [operations, setOperations] = useState<Record<string, ManufacturingOperationPayload>>({});
  const [summary, setSummary] = useState<ManufacturingOperationSummaryPayload>(EMPTY_SUMMARY);
  const [errorCode, setErrorCode] = useState<ManufacturingOperationErrorCode | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [mutatingGroupId, setMutatingGroupId] = useState<string | null>(null);

  const fetchedLayerSetIdRef = useRef<string | null>(null);
  const abortControllersRef = useRef<Set<AbortController>>(new Set());

  useEffect(() => {
    const controllers = abortControllersRef.current;
    return () => {
      for (const controller of controllers) {
        controller.abort();
      }
    };
  }, []);

  const applyResponse = useCallback((response: {
    operations?: ManufacturingOperationPayload[];
    summary?: ManufacturingOperationSummaryPayload;
  }) => {
    const nextOperations = Array.isArray(response.operations) ? response.operations : [];
    setOperations(Object.fromEntries(nextOperations.map((entry) => [entry.groupId, entry])));
    setSummary(response.summary ?? EMPTY_SUMMARY);
  }, []);

  const handleError = useCallback((error: unknown) => {
    if (error instanceof ApiClientError && error.isAborted) {
      return;
    }

    if (error instanceof ApiClientError && error.body) {
      const body = error.body as Partial<ApiErrorResponse>;
      const code = typeof body.code === "string" && isKnownErrorCode(body.code) ? body.code : "internal_error";
      setErrorCode(code);
      setErrorMessage(body.message ?? GENERIC_ERROR_MESSAGE);
    } else if (error instanceof ApiClientError && error.isNetworkError) {
      setErrorCode("network_error");
      setErrorMessage("No se pudo contactar a la Web API para operar sobre la operación de fabricación.");
    } else {
      setErrorCode("internal_error");
      setErrorMessage(GENERIC_ERROR_MESSAGE);
    }
  }, []);

  // Recupera -- una sola vez por layerSetId -- las asignaciones YA
  // persistidas del conjunto de capas actual, si las hubiera.
  useEffect(() => {
    if (!paletteId || !layerSetId || savedProjectId) {
      return;
    }
    if (fetchedLayerSetIdRef.current === layerSetId) {
      return;
    }
    fetchedLayerSetIdRef.current = layerSetId;

    // Un layerSetId nuevo (paleta recalculada) invalida cualquier estado
    // local anterior: las asignaciones viejas no migran automáticamente.
    setOperations({});
    setSummary(EMPTY_SUMMARY);
    setErrorCode(null);
    setErrorMessage(null);

    const controller = new AbortController();
    abortControllersRef.current.add(controller);

    getManufacturingOperations(projectId, imageId, paletteId, controller.signal)
      .then((response) => {
        abortControllersRef.current.delete(controller);
        applyResponse(response);
      })
      .catch((error: unknown) => {
        abortControllersRef.current.delete(controller);
        if (error instanceof ApiClientError && error.isAborted) {
          return;
        }
        // No bloquea el panel de capas ni reintenta automáticamente (evita un
        // segundo fetch fuera de una acción explícita del usuario): las capas
        // simplemente quedan en su estado local por default ("unassigned"
        // para todas) hasta que el usuario asigne algo -- que si persiste, sí
        // confirma que la Web API está disponible.
      });
  }, [projectId, imageId, paletteId, layerSetId, savedProjectId, applyResponse]);

  const assign = useCallback(
    (groupId: string, operation: ManufacturingOperationChoice) => {
      if (!paletteId) {
        return;
      }

      setErrorCode(null);
      setErrorMessage(null);
      setMutatingGroupId(groupId);

      if (savedProjectId) {
        updateVectorDocumentLayer(savedProjectId, groupId, { manufacturingOperation: operation })
          .then((response) => {
            setMutatingGroupId(null);
            setOperations((current) => ({
              ...current,
              [response.id]: {
                groupId: response.id,
                name: response.name,
                colorHex: response.colorHex,
                operation: response.manufacturingOperation as ManufacturingOperationValue,
              },
            }));
          })
          .catch((error: unknown) => {
            setMutatingGroupId(null);
            handleError(error);
          });
        return;
      }

      assignManufacturingOperation(projectId, imageId, paletteId, groupId, operation)
        .then((response) => {
          setMutatingGroupId(null);
          applyResponse(response);
        })
        .catch((error: unknown) => {
          setMutatingGroupId(null);
          handleError(error);
        });
    },
    [projectId, imageId, paletteId, savedProjectId, applyResponse, handleError],
  );

  return { operations, summary, errorCode, errorMessage, mutatingGroupId, assign };
}
