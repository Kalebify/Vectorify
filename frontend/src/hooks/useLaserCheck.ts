import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { floatingAnalysis, planFloating, type FloatingPlan } from "../lib/editor/floating";
import {
  analyzeLaserLocal,
  buildReport,
  documentFingerprint,
  floatingIssues,
  LASER_CHECK_FLOATING_MODE,
  MAX_OVERLAY_ISSUES,
  reportSummary,
  scopeText,
  thresholdsText,
  type FloatingCheckState,
  type LaserCheckIssue,
  type LaserCheckLocalResult,
  type LaserCheckReport,
} from "../lib/editor/laserCheck";
import type { EditableDocument } from "../lib/editor/types";
import { useFloatingAnalysis } from "./useFloatingAnalysis";

/**
 * Orquestación del Laser Checker (M3-S14) en el Workspace. La lógica vive en `lib/editor/laserCheck.ts` (checks locales, puros y baratos) y en el servicio de S11 (piezas
 * flotantes, Shapely); acá solo se sincroniza con el documento y con el servidor:
 *
 * - **El análisis corre sobre el estado CONFIRMADO** (nunca el vivo de un gesto) y se identifica con la HUELLA del documento (`documentFingerprint`). Si el documento cambió y
 *   todavía no se re-analizó, el resultado está **desactualizado** (`stale`): se sigue mostrando pero marcado, nunca como vigente, y no se puede navegar a sus issues.
 * - **Re-run**: manual (`analyze`) y automático mientras el panel está abierto: al abrir (de inmediato) y tras cambiar la geometría confirmada (con debounce). Cerrar el panel
 *   descarta el resultado y cancela lo que esté en vuelo.
 * - **Flotantes** (`useFloatingAnalysis` = `useGeometryPreview`): UNA petición viva, la anterior se aborta al cambiar la huella de la petición, y misma petición => no se
 *   vuelve a pedir. Mientras no hay respuesta, o si falla, el check queda NO VERIFICADO (el estado global nunca es Ready) sin invalidar los checks locales.
 * - Activar un issue lo recuerda como seleccionado (el shell selecciona los objetos y centra la vista) y lo resalta en el overlay.
 */

export const LASER_CHECK_DEBOUNCE_MS = 400;

interface Run {
  /** Documento analizado (congelado): de ahí salen los nombres de capa de los issues de flotantes aunque el documento ya haya cambiado. */
  document: EditableDocument;
  fingerprint: string;
  local: LaserCheckLocalResult;
  /** Plan de flotantes CONGELADO con el documento analizado, o `null` si no hay nada que analizar / se rechazó. */
  plan: FloatingPlan | null;
  planError: string | null;
}

export interface UseLaserCheckParams {
  /** El panel está abierto. */
  open: boolean;
  /** Estado CONFIRMADO del documento con la estructura efectiva de capas. */
  state: EditableDocument;
  /** mm por unidad de documento, o `null` sin escala física. */
  mmFactor: number | null;
  debounceMs?: number;
  /** Activar un issue: el shell selecciona sus objetos y centra la vista. */
  onActivateIssue: (issue: LaserCheckIssue) => void;
}

export function useLaserCheck({ open, state, mmFactor, debounceMs = LASER_CHECK_DEBOUNCE_MS, onActivateIssue }: UseLaserCheckParams) {
  const [run, setRun] = useState<Run | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Cerrar el panel descarta el resultado y la selección; abrir uno nuevo analiza de cero (se ajusta durante el render, como `useFloatingTool`).
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) {
      setRun(null);
      setSelectedId(null);
    }
  }

  // Solo se calcula con el panel abierto: con un documento grande no se paga por cada edición mientras nadie mira el resultado.
  const fingerprint = useMemo(() => (open ? documentFingerprint(state, mmFactor) : ""), [open, state, mmFactor]);
  const latest = useRef({ state, mmFactor, onActivateIssue });
  useEffect(() => {
    latest.current = { state, mmFactor, onActivateIssue };
  });

  const analyze = useCallback(() => {
    const { state: current, mmFactor: factor } = latest.current;
    const local = analyzeLaserLocal(current, { mmFactor: factor });
    let plan: FloatingPlan | null = null;
    let planError: string | null = null;
    if (local.floatingTargets.length > 0) {
      const planned = planFloating(local.floatingTargets, current, { mode: LASER_CHECK_FLOATING_MODE, mmFactor: factor });
      if (planned.ok) plan = planned.plan;
      else planError = planned.message;
    }
    setRun({ document: current, fingerprint: local.fingerprint, local, plan, planError });
  }, []);

  const stale = run !== null && run.fingerprint !== fingerprint;
  const hasRun = run !== null;
  useEffect(() => {
    if (!open) return;
    if (hasRun && !stale) return;
    // La primera vez, ya; tras un cambio del documento, con debounce (varias ediciones seguidas = un solo análisis).
    const timer = setTimeout(analyze, hasRun ? debounceMs : 0);
    return () => clearTimeout(timer);
  }, [open, hasRun, stale, fingerprint, debounceMs, analyze]);

  // ---- Piezas flotantes (S11): la petición queda ligada al análisis; cerrar el panel (sin `run`) cancela lo que esté en vuelo ----
  const plan = run?.plan ?? null;
  const floatingPreview = useFloatingAnalysis({ request: plan?.request ?? null, requestKey: plan?.requestKey ?? null, debounceMs: 0 });

  const floating = useMemo<FloatingCheckState>(() => {
    if (!run || run.local.floatingTargets.length === 0) return { state: "not_applicable" };
    if (run.planError !== null) return { state: "unavailable", message: run.planError };
    if (floatingPreview.errorMessage !== null) return { state: "unavailable", message: floatingPreview.errorMessage };
    if (run.plan && floatingPreview.response) {
      const analysis = floatingAnalysis(run.plan, floatingPreview.response);
      return analysis.ok ? { state: "done", issues: floatingIssues(run.plan, analysis.analysis, run.document) } : { state: "unavailable", message: analysis.error };
    }
    return { state: "pending" };
  }, [run, floatingPreview.errorMessage, floatingPreview.response]);

  const report = useMemo<LaserCheckReport | null>(() => (run ? buildReport(run.local, floating) : null), [run, floating]);
  const selectedIssueId = report && selectedId !== null && report.issues.some((issue) => issue.id === selectedId) ? selectedId : null;

  const selectIssue = useCallback(
    (id: string) => {
      const issue = report?.issues.find((candidate) => candidate.id === id);
      if (!issue || stale) return;
      setSelectedId(id);
      latest.current.onActivateIssue(issue);
    },
    [report, stale],
  );

  const analyzing = floating.state === "pending";
  const floatingError = floating.state === "unavailable" ? floating.message : null;

  const overlay = useMemo(() => {
    if (!open || !report || stale) return undefined;
    const shown = report.issues.slice(0, MAX_OVERLAY_ISSUES);
    const selected = selectedIssueId !== null ? report.issues.find((issue) => issue.id === selectedIssueId) : undefined;
    const issues = selected && !shown.includes(selected) ? [...shown, selected] : shown;
    return {
      issues: issues.map((issue) => ({ id: issue.id, severity: issue.severity, highlights: issue.highlights, rect: issue.rect })),
      selectedId: selectedIssueId,
    };
  }, [open, report, stale, selectedIssueId]);

  const panel = {
    hasAnalysis: report !== null,
    status: report?.status ?? null,
    stale,
    analyzing,
    summary: report ? reportSummary(report) : "Analizando el documento…",
    scopeText: run ? scopeText(run.local.scope) : "",
    thresholdsText: thresholdsText(mmFactor),
    scaleNotice: run?.local.scaleNotice ?? null,
    issues: report?.issues ?? [],
    unverified: report?.unverified ?? [],
    floatingError,
    selectedIssueId,
    onSelectIssue: selectIssue,
    onAnalyze: analyze,
    onRetryFloating: floatingPreview.retry,
  };

  return { report, stale, panel, overlay };
}

export type LaserCheck = ReturnType<typeof useLaserCheck>;
