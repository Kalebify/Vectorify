import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { defaultExportSelection, type ExportDocument } from "../lib/editor/export/exportDocument";
import { buildExportPreflight, DEFAULT_EXPORT_OPTIONS, type ExportOptions } from "../lib/editor/export/exportPlan";
import { ExportError, generateExport, isAbortError } from "../lib/editor/export/exportRunner";
import type { DownloadFile } from "../lib/editor/export/browser";
import type { Rasterizer } from "../lib/editor/export/pngExport";
import type { LaserCheckReport } from "../lib/editor/laserCheck";

/**
 * Estado y acciones del diálogo de export (M3-S15). La lógica vive en `lib/editor/export/*` (pura); acá solo se sincroniza con el formulario del diálogo:
 *
 * - **Selección de layers**: por defecto las visibles y distintas de IGNORE; mientras el usuario no la toca se DERIVA del documento (no se copia), así no queda vieja.
 * - **Preflight** en vivo (`buildExportPreflight`) con el reporte vigente del Laser Check (`null` = no verificado).
 * - **Confirmación**: con un Laser Check Blocking exportar exige tildarla; queda ligada a ESE conjunto de issues bloqueantes: si cambia (otra selección u otro análisis), se pide de nuevo.
 * - **Generación**: una sola a la vez, todo o nada (un error NO descarga nada) y cancelable (cerrar el diálogo la aborta y no descarga). La descarga entra por el *seam* `download`.
 */

export type ExportStatus = { state: "idle" } | { state: "generating" } | { state: "done"; message: string } | { state: "error"; message: string };

export interface UseExportParams {
  document: ExportDocument;
  /** Reporte VIGENTE del Laser Check, o `null` si todavía no hay uno / está desactualizado (el preflight lo muestra como no verificado). */
  laserReport: LaserCheckReport | null;
  /** Rasterizador del PNG (la implementación del navegador o un doble). */
  rasterize?: Rasterizer;
  /** Entrega el archivo generado al usuario. */
  download: DownloadFile;
  yieldToEventLoop?: () => Promise<void>;
}

function describeError(error: unknown): string {
  if (error instanceof ExportError) return error.message;
  return error instanceof Error && error.message ? `No se pudo generar el export: ${error.message}` : "No se pudo generar el export.";
}

export function useExport({ document, laserReport, rasterize, download, yieldToEventLoop }: UseExportParams) {
  const [options, setOptions] = useState<ExportOptions>(DEFAULT_EXPORT_OPTIONS);
  const [override, setOverride] = useState<ReadonlySet<string> | null>(null);
  const [confirmedKey, setConfirmedKey] = useState<string | null>(null);
  const [status, setStatus] = useState<ExportStatus>({ state: "idle" });
  const controllerRef = useRef<AbortController | null>(null);

  const selection = useMemo<ReadonlySet<string>>(() => {
    const known = new Set(document.layers.map((layer) => layer.groupId));
    const chosen = override ?? defaultExportSelection(document.layers);
    return new Set([...chosen].filter((groupId) => known.has(groupId)));
  }, [document.layers, override]);

  const preflight = useMemo(() => buildExportPreflight(document, selection, options, laserReport), [document, selection, options, laserReport]);

  const blockingKey = preflight.laser.blocking.map((issue) => issue.id).join("|");
  // La confirmación vale para ESE conjunto de bloqueantes: si cambia (otra selección u otro análisis) se descarta y no revive si el conjunto vuelve a ser el de antes.
  if (confirmedKey !== null && confirmedKey !== blockingKey) setConfirmedKey(null);
  const confirmed = preflight.requiresConfirmation && confirmedKey === blockingKey;
  const generating = status.state === "generating";

  // Cerrar el diálogo (desmontar) cancela lo que esté generándose: no se descarga nada.
  useEffect(() => () => controllerRef.current?.abort(), []);

  const touch = useCallback(() => setStatus((current) => (current.state === "generating" ? current : { state: "idle" })), []);

  const updateOptions = useCallback(
    (patch: Partial<ExportOptions>) => {
      setOptions((current) => ({ ...current, ...patch }));
      touch();
    },
    [touch],
  );

  const setLayerSelected = useCallback(
    (groupId: string, selected: boolean) => {
      setOverride((current) => {
        const next = new Set(current ?? selection);
        if (selected) next.add(groupId);
        else next.delete(groupId);
        return next;
      });
      touch();
    },
    [selection, touch],
  );

  const selectLayers = useCallback(
    (which: "default" | "all" | "none") => {
      setOverride(which === "default" ? null : which === "all" ? new Set(document.layers.map((layer) => layer.groupId)) : new Set());
      touch();
    },
    [document.layers, touch],
  );

  const setConfirmed = useCallback((value: boolean) => setConfirmedKey(value ? blockingKey : null), [blockingKey]);

  const canSubmit = preflight.canExport && !generating && (!preflight.requiresConfirmation || confirmed);

  const submit = useCallback(async () => {
    if (!canSubmit) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setStatus({ state: "generating" });
    try {
      const result = await generateExport(document, selection, options, { rasterize, yieldToEventLoop, signal: controller.signal });
      if (controller.signal.aborted) return;
      download({ name: result.name, mime: result.mime, data: result.data });
      const count = result.files.length > 1 ? ` (${result.files.length} archivos en un ZIP)` : "";
      const notes = result.warnings.length > 0 ? ` Avisos: ${result.warnings.join(" ")}` : "";
      setStatus({ state: "done", message: `Listo: se descargó «${result.name}»${count}.${notes}` });
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted) return;
      setStatus({ state: "error", message: describeError(error) });
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, [canSubmit, document, selection, options, rasterize, yieldToEventLoop, download]);

  const announcement =
    status.state === "generating"
      ? "Generando el archivo…"
      : status.state === "done"
        ? status.message
        : status.state === "error"
          ? `Error: ${status.message}`
          : "";

  return { options, updateOptions, selection, setLayerSelected, selectLayers, preflight, confirmed, setConfirmed, status, announcement, generating, canSubmit, submit };
}

export type ExportController = ReturnType<typeof useExport>;
