import { useCallback, useEffect, useRef, useState } from "react";
import {
  confirmColorPalette,
  detectColorPalette,
  mergeColorPaletteGroups,
  renameColorPaletteGroup,
  setColorPaletteGroupExclusion,
  unmergeColorPaletteGroup,
} from "../api/colorPaletteApi";
import { ApiClientError } from "../api/httpClient";
import type { ApiErrorResponse } from "../types/preprocess";
import type { ColorPaletteErrorCode, ColorPaletteResponse, GroupingStyle } from "../types/colorPalette";

/**
 * Estados explícitos pedidos por spec.md M2-S01: "ver paleta detectada,
 * número de colores, fusionar colores parecidos, renombrar grupos y
 * confirmar paleta", con el preview cuantizado actualizado en vivo tras cada
 * cambio (ver `palette.previewUrl` + `version`, que el panel usa para
 * invalidar la caché de la imagen).
 */
export type ColorPaletteStatus = "idle" | "detecting" | "ready" | "mutating" | "confirmed" | "error";

const GENERIC_ERROR_MESSAGE = "No se pudo procesar la paleta de colores. Intentá de nuevo.";

const KNOWN_ERROR_CODES: ColorPaletteErrorCode[] = [
  "invalid_parameters",
  "not_found",
  "group_not_found",
  "palette_confirmed",
  "not_merged",
  "empty_palette",
  "corrupt_image",
  "dimensions_exceeded",
  "timeout",
  "engine_unavailable",
  "invalid_response",
  "processing_error",
  "storage_failure",
  "internal_error",
  "network_error",
];

function isKnownErrorCode(code: string): code is ColorPaletteErrorCode {
  return (KNOWN_ERROR_CODES as string[]).includes(code);
}

export interface UseColorPaletteState {
  status: ColorPaletteStatus;
  palette: ColorPaletteResponse | null;
  tolerance: number;
  maxColors: number | null;
  /**
   * Estilo de agrupación para la PRÓXIMA detección. Valor inicial `base_colors` (recomendado, solo para
   * detecciones nuevas: nunca cambia una paleta ya detectada ni reabre documentos anteriores).
   */
  groupingStyle: GroupingStyle;
  /** Tope de familias (solo `base_colors`); null = automático. */
  targetFamilies: number | null;
  /** Intensidad de agrupación 0-1 (solo `base_colors`). */
  groupingStrength: number;
  /** GroupId de los grupos actualmente seleccionados para fusionar (selección múltiple). */
  selectedGroupIds: string[];
  errorCode: ColorPaletteErrorCode | null;
  errorMessage: string | null;
  setTolerance: (tolerance: number) => void;
  setMaxColors: (maxColors: number | null) => void;
  setGroupingStyle: (style: GroupingStyle) => void;
  setTargetFamilies: (families: number | null) => void;
  setGroupingStrength: (strength: number) => void;
  /** Detecta (o re-detecta, si ya hay una sesión abierta) con la tolerancia/maxColors vigentes. */
  detect: () => void;
  toggleGroupSelection: (groupId: string) => void;
  clearSelection: () => void;
  /** Fusiona los grupos actualmente seleccionados (no-op si hay menos de 2). */
  mergeSelected: (name?: string) => void;
  unmerge: (groupId: string) => void;
  rename: (groupId: string, name: string) => void;
  /** Marca un grupo como incluido/excluido (M2.1-S02), independiente de un merge. */
  setExclusion: (groupId: string, isExcluded: boolean) => void;
  confirm: () => void;
}

export function useColorPalette(projectId: string, imageId: string): UseColorPaletteState {
  const [status, setStatus] = useState<ColorPaletteStatus>("idle");
  const [palette, setPalette] = useState<ColorPaletteResponse | null>(null);
  const [tolerance, setTolerance] = useState(12);
  const [maxColors, setMaxColors] = useState<number | null>(null);
  const [groupingStyle, setGroupingStyle] = useState<GroupingStyle>("base_colors");
  const [targetFamilies, setTargetFamilies] = useState<number | null>(null);
  const [groupingStrength, setGroupingStrength] = useState(0.5);
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
  const [errorCode, setErrorCode] = useState<ColorPaletteErrorCode | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => abortControllerRef.current?.abort();
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
      setErrorMessage("No se pudo contactar a la Web API para procesar la paleta de colores.");
    } else {
      setErrorCode("internal_error");
      setErrorMessage(GENERIC_ERROR_MESSAGE);
    }
    setStatus("error");
  }, []);

  const applyPalette = useCallback((response: ColorPaletteResponse) => {
    setPalette(response);
    // Los controles reflejan lo que REALMENTE produjo la paleta: una respuesta sin estilo (API anterior)
    // es una paleta detallada, nunca se presenta como "Colores base".
    setGroupingStyle(response.groupingStyle ?? "detailed");
    setTargetFamilies(response.targetFamilies ?? null);
    if (typeof response.groupingStrength === "number") {
      setGroupingStrength(response.groupingStrength);
    }
    setSelectedGroupIds([]);
    setStatus(response.isConfirmed ? "confirmed" : "ready");
    setErrorCode(null);
    setErrorMessage(null);
  }, []);

  const runRequest = useCallback(
    (nextStatus: ColorPaletteStatus, request: (signal: AbortSignal) => Promise<ColorPaletteResponse>) => {
      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;

      setStatus(nextStatus);
      setErrorCode(null);
      setErrorMessage(null);

      request(controller.signal)
        .then((response) => {
          abortControllerRef.current = null;
          applyPalette(response);
        })
        .catch((error: unknown) => {
          abortControllerRef.current = null;
          handleError(error);
        });
    },
    [applyPalette, handleError],
  );

  const detect = useCallback(() => {
    runRequest("detecting", (signal) =>
      detectColorPalette(
        projectId,
        imageId,
        {
          paletteId: palette && !palette.isConfirmed ? palette.paletteId : null,
          tolerance,
          maxColors: groupingStyle === "detailed" ? maxColors : null,
          groupingStyle,
          targetFamilies: groupingStyle === "base_colors" ? targetFamilies : null,
          groupingStrength: groupingStyle === "base_colors" ? groupingStrength : null,
        },
        signal,
      ),
    );
  }, [runRequest, projectId, imageId, palette, tolerance, maxColors, groupingStyle, targetFamilies, groupingStrength]);

  const toggleGroupSelection = useCallback((groupId: string) => {
    setSelectedGroupIds((current) =>
      current.includes(groupId) ? current.filter((id) => id !== groupId) : [...current, groupId],
    );
  }, []);

  const clearSelection = useCallback(() => setSelectedGroupIds([]), []);

  const mergeSelected = useCallback(
    (name?: string) => {
      if (!palette || selectedGroupIds.length < 2) {
        return;
      }

      runRequest("mutating", (signal) =>
        mergeColorPaletteGroups(projectId, imageId, palette.paletteId, selectedGroupIds, name ?? null, signal),
      );
    },
    [runRequest, projectId, imageId, palette, selectedGroupIds],
  );

  const unmerge = useCallback(
    (groupId: string) => {
      if (!palette) {
        return;
      }

      runRequest("mutating", (signal) => unmergeColorPaletteGroup(projectId, imageId, palette.paletteId, groupId, signal));
    },
    [runRequest, projectId, imageId, palette],
  );

  const rename = useCallback(
    (groupId: string, name: string) => {
      if (!palette) {
        return;
      }

      runRequest("mutating", (signal) =>
        renameColorPaletteGroup(projectId, imageId, palette.paletteId, groupId, name, signal),
      );
    },
    [runRequest, projectId, imageId, palette],
  );

  const setExclusion = useCallback(
    (groupId: string, isExcluded: boolean) => {
      if (!palette) {
        return;
      }

      runRequest("mutating", (signal) =>
        setColorPaletteGroupExclusion(projectId, imageId, palette.paletteId, groupId, isExcluded, signal),
      );
    },
    [runRequest, projectId, imageId, palette],
  );

  const confirm = useCallback(() => {
    if (!palette) {
      return;
    }

    runRequest("mutating", (signal) => confirmColorPalette(projectId, imageId, palette.paletteId, signal));
  }, [runRequest, projectId, imageId, palette]);

  return {
    status,
    palette,
    tolerance,
    maxColors,
    groupingStyle,
    targetFamilies,
    groupingStrength,
    selectedGroupIds,
    errorCode,
    errorMessage,
    setTolerance,
    setMaxColors,
    setGroupingStyle,
    setTargetFamilies,
    setGroupingStrength,
    detect,
    toggleGroupSelection,
    clearSelection,
    mergeSelected,
    unmerge,
    rename,
    setExclusion,
    confirm,
  };
}
