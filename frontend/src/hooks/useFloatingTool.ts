import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_BRIDGE_WIDTH_MM,
  MAX_BRIDGE_WIDTH_MM,
  MIN_BRIDGE_WIDTH_MM,
  NO_SCALE_NOTICE,
  SNAP_PIXELS,
  analysisSummary,
  applyBridgeResult,
  bridgeApplyBlock,
  bridgeLabel,
  bridgeOutcome,
  bridgeReadyText,
  bridgeWarnings,
  draftsFromSuggestions,
  floatingAnalysis,
  floatingScope,
  floatingScopeText,
  issueDescription,
  planBridges,
  planFloating,
  reanalysisText,
  snapToIssue,
  type BridgeApplication,
  type BridgeDraft,
  type FloatingPlan,
} from "../lib/editor/floating";
import type { EditableDocument, EditorEdit, EditorObject, Point, Rect } from "../lib/editor/types";
import { unitScale } from "../lib/editor/geometry";
import type { FloatingMode } from "../types/geometry";
import type { EditableDocumentApi } from "./useEditableDocument";
import { describeEditFailure, isTextEntry } from "./useDrawEraseTools";
import { useBridgeOperation } from "./useBridgeOperation";
import { useFloatingAnalysis } from "./useFloatingAnalysis";

/**
 * Orquestación de la herramienta de piezas flotantes y bridges (M3-S11) en el Workspace: la sesión (modo, ancho, análisis congelado, issue seleccionado, lista de
 * bridges), el análisis (`useFloatingAnalysis`) y el preview de los bridges (`useBridgeOperation`) del servidor, y Apply/Cancel. La lógica geométrica vive en
 * `lib/editor/floating.ts`; acá solo se sincroniza con el documento editable y con el servidor:
 *
 * - **El análisis es EXPLÍCITO** (botón Analizar) y queda congelado: cambia el documento (o la selección) y el análisis se marca como viejo (no se aplica nada sobre
 *   objetos que ya no son los analizados). Cambiar el modo lo descarta.
 * - **Seleccionar un issue** centra la vista en la pieza (`onFocusRect`) y la resalta en el overlay.
 * - **Los bridges** arrancan como las SUGERENCIAS del servidor; la primera edición del usuario (quitar, mover, colocar uno nuevo con un click sobre el borde de una pieza)
 *   las adopta como lista explícita. Cambiar el ancho, quitar o mover un bridge vuelve a pedir el resultado (geometría + reanálisis «N flotantes → M»).
 * - **Un comando atómico por Apply** (`applyEdit`), con undo/redo exactos (snapshots before/after de S01). El análisis, el preview y Cancel NO tocan la pila de undo.
 * - **El servidor falla (o contesta algo incoherente) => no se modifica nada**: el error queda en el panel y `Reintentar` lo vuelve a pedir.
 * - Teclado (con la herramienta activa y fuera de un campo): Enter aplica; Escape sale del modo de colocación, después descarta el análisis y, sin análisis, cierra la herramienta.
 */

type Placing = { kind: "add" } | { kind: "move"; key: string } | null;

interface FloatingSession {
  mode: FloatingMode;
  widthMm: number;
  /** Plan del análisis CONGELADO al apretar Analizar (los objetos son referencias del documento de ese momento); `null` = todavía no se analizó. */
  analysisPlan: FloatingPlan | null;
  /** Id del componente seleccionado en la lista de issues. */
  selectedIssue: number | null;
  /** Lista de bridges del usuario; `null` = todavía las sugerencias automáticas del servidor. */
  bridges: BridgeDraft[] | null;
  placing: Placing;
  nextKey: number;
  /** Último intento fallido (rechazo de Analizar, click lejos de un borde, Apply fallido). */
  message: string | null;
}

const INITIAL_SESSION: FloatingSession = {
  mode: "stencil",
  widthMm: DEFAULT_BRIDGE_WIDTH_MM,
  analysisPlan: null,
  selectedIssue: null,
  bridges: null,
  placing: null,
  nextKey: 1,
  message: null,
};

export interface UseFloatingToolParams {
  /** La herramienta está activa. */
  active: boolean;
  editable: Pick<EditableDocumentApi, "applyEdit" | "getSnapshot">;
  /** Estado CONFIRMADO del documento con la estructura efectiva de capas (nunca el vivo de un gesto). */
  state: EditableDocument;
  /** Objetos seleccionados (vacío = capas CUT visibles). */
  selectedObjects: readonly EditorObject[];
  /** mm por unidad de documento, o `null` sin escala física (el panel opera en unidades y avisa). */
  mmFactor: number | null;
  /** Zoom vigente del canvas (px por unidad de documento): convierte los px de pantalla del ajuste de un click al borde. */
  viewScale: number;
  /** Generador de ids de las piezas (default `crypto.randomUUID`); inyectable en tests. */
  createId?: () => string;
  /** Seleccionar un issue: el shell centra la vista en este rectángulo del documento. */
  onFocusRect: (rect: Rect) => void;
  /** Tras un Apply exitoso: el shell selecciona las piezas, cierra la herramienta y muestra el aviso. */
  onApplied: (applied: Extract<BridgeApplication, { ok: true }>, edit: EditorEdit | undefined) => void;
  /** Salir de la herramienta sin aplicar (Cancel, Escape sin análisis): el shell vuelve a Select. La sesión se descarta sola. */
  onClose: () => void;
}

export function useFloatingTool({ active, editable, state, selectedObjects, mmFactor, viewScale, createId, onFocusRect, onApplied, onClose }: UseFloatingToolParams) {
  const [session, setSession] = useState<FloatingSession>(INITIAL_SESSION);
  const [applying, setApplying] = useState(false);
  // Salir de la herramienta (por cualquier camino) descarta la sesión sin rastro; entrar abre una nueva con los valores por defecto. Se ajusta durante el render
  // (patrón recomendado por React) y no en un efecto: así la primera pintura con la herramienta cerrada ya no trae el análisis viejo.
  const [wasActive, setWasActive] = useState(active);
  if (wasActive !== active) {
    setWasActive(active);
    if (!active) setSession(INITIAL_SESSION);
  }
  const applyingRef = useRef(false);
  const { applyEdit, getSnapshot } = editable;

  const update = useCallback((patch: Partial<FloatingSession>) => setSession((current) => ({ ...current, message: null, ...patch })), []);

  const unit = useMemo(() => unitScale(mmFactor), [mmFactor]);
  const analysisPlan = session.analysisPlan;

  // El análisis queda viejo si alguno de los objetos analizados ya no es el mismo del documento (se movió, se editó, se borró, undo...).
  const stale = analysisPlan ? analysisPlan.objects.some((object) => !(state.objectsByLayer[object.layerGroupId] ?? []).includes(object)) : false;
  const livePlan = active && analysisPlan !== null && !stale ? analysisPlan : null;

  // ---- Análisis ----
  const analysisPreview = useFloatingAnalysis({ request: livePlan?.request ?? null, requestKey: livePlan?.requestKey ?? null });
  const analysisResult = useMemo(
    () => (livePlan && analysisPreview.response ? floatingAnalysis(livePlan, analysisPreview.response) : null),
    [livePlan, analysisPreview.response],
  );
  const analysis = analysisResult?.ok ? analysisResult.analysis : null;
  const analysisError = analysisPreview.errorMessage ?? (analysisResult && !analysisResult.ok ? analysisResult.error : null);

  // ---- Bridges ----
  const bridgePlanResult = useMemo(
    () => (livePlan && analysis ? planBridges(livePlan, analysis, session.bridges, session.widthMm) : null),
    [livePlan, analysis, session.bridges, session.widthMm],
  );
  const bridgePlan = bridgePlanResult?.ok ? bridgePlanResult.plan : null;
  const bridgeRejection = bridgePlanResult && !bridgePlanResult.ok ? bridgePlanResult : null;
  const bridgePreview = useBridgeOperation({ request: bridgePlan?.request ?? null, requestKey: bridgePlan?.requestKey ?? null });
  const outcomeResult = useMemo(() => (bridgePlan && bridgePreview.response ? bridgeOutcome(bridgePlan, bridgePreview.response) : null), [bridgePlan, bridgePreview.response]);
  const outcome = outcomeResult?.ok ? outcomeResult.outcome : null;
  const bridgeError = bridgePreview.errorMessage ?? (outcomeResult && !outcomeResult.ok ? outcomeResult.error : null);

  // La lista efectiva: la del usuario o, mientras no tocó nada, las sugerencias del servidor ya resueltas.
  const effectiveDrafts: BridgeDraft[] = session.bridges ?? draftsFromSuggestions(bridgePlan && bridgePlan.drafts === null ? bridgePreview.response : null);

  const applyDisabledReason = (() => {
    if (!active) return "No hay una herramienta abierta.";
    if (!analysisPlan) return "Primero analizá las piezas flotantes.";
    if (stale) return "El documento cambió desde el análisis: volvé a analizar.";
    if (analysisError) return "El análisis falló: reintentalo.";
    if (!analysis) return "Esperando el análisis…";
    if (analysis.issues.length === 0) return "No hay piezas flotantes: no hay nada que conectar.";
    if (bridgeRejection) return bridgeRejection.message;
    if (!bridgePlan) return "No hay bridges para aplicar.";
    if (bridgeError) return "El cálculo falló: reintentalo o cambiá los bridges.";
    return bridgeApplyBlock(outcome);
  })();

  // Lo último, para los manejadores asíncronos (tras esperar al servidor el estado puede ser otro).
  const latest = useRef({ active, bridgePlan, drafts: effectiveDrafts, analysis, session });
  useEffect(() => {
    latest.current = { active, bridgePlan, drafts: effectiveDrafts, analysis, session };
  });

  const close = useCallback(() => {
    setSession(INITIAL_SESSION);
    onClose();
  }, [onClose]);

  // ---- Acciones del panel ----

  const setMode = useCallback((mode: FloatingMode) => setSession((current) => (current.mode === mode ? current : { ...INITIAL_SESSION, mode, widthMm: current.widthMm })), []);

  const setWidth = useCallback((widthMm: number) => update({ widthMm }), [update]);

  const analyze = useCallback(() => {
    const planned = planFloating(selectedObjects, state, { mode: latest.current.session.mode, mmFactor });
    if (!planned.ok) {
      setSession((current) => ({ ...current, analysisPlan: null, selectedIssue: null, bridges: null, placing: null, message: planned.message }));
      return;
    }
    setSession((current) => ({ ...current, analysisPlan: planned.plan, selectedIssue: null, bridges: null, placing: null, message: null }));
  }, [selectedObjects, state, mmFactor]);

  const selectIssue = useCallback(
    (id: number) => {
      const issue = latest.current.analysis?.issues.find((candidate) => candidate.id === id);
      if (!issue) return;
      update({ selectedIssue: id });
      onFocusRect(issue.rect);
    },
    [update, onFocusRect],
  );

  const suggestAgain = useCallback(() => update({ bridges: null, placing: null }), [update]);

  const removeBridge = useCallback(
    (key: string) => update({ bridges: latest.current.drafts.filter((draft) => draft.key !== key), placing: null }),
    [update],
  );

  const togglePlacing = useCallback(() => {
    setSession((current) => ({ ...current, message: null, placing: current.placing?.kind === "add" ? null : { kind: "add" } }));
  }, []);

  const startMoving = useCallback((key: string) => {
    setSession((current) => ({ ...current, message: null, placing: current.placing?.kind === "move" && current.placing.key === key ? null : { kind: "move", key } }));
  }, []);

  /** Click sobre el canvas en modo de colocación: se ajusta al borde de la pieza flotante más cercana; si no hay ninguna cerca, se dice y no pasa nada. */
  const placeAt = useCallback(
    (point: Point) => {
      const { analysis: current, session: currentSession, drafts } = latest.current;
      if (!current) return;
      const snapped = snapToIssue(point, current.issues, SNAP_PIXELS / (viewScale > 0 ? viewScale : 1));
      if (!snapped) {
        update({ message: "Hacé click sobre el borde de una pieza flotante marcada para colocar el bridge." });
        return;
      }
      const placing = currentSession.placing;
      if (placing?.kind === "move") {
        update({
          bridges: drafts.map((draft) => (draft.key === placing.key ? { ...draft, island: snapped.issueId, anchor: snapped.point, direction: null } : draft)),
          selectedIssue: snapped.issueId,
          placing: null,
        });
        return;
      }
      update({
        bridges: [...drafts, { key: `m${currentSession.nextKey}`, island: snapped.issueId, anchor: snapped.point, direction: null }],
        nextKey: currentSession.nextKey + 1,
        selectedIssue: snapped.issueId,
      });
    },
    [update, viewScale],
  );

  const resetAnalysis = useCallback(() => update({ analysisPlan: null, selectedIssue: null, bridges: null, placing: null }), [update]);

  const handleApply = useCallback(async () => {
    const started = latest.current;
    if (!started.active || !started.bridgePlan || applyingRef.current) return;
    applyingRef.current = true;
    setApplying(true);
    try {
      // Si cambió algo desde el último preview, se recalcula primero; si ya está calculado, se usa tal cual.
      const ensured = await bridgePreview.ensure();
      const current = latest.current;
      if (!current.active || !current.bridgePlan) return;
      if (!ensured.ok) {
        if (!ensured.aborted) update({ message: ensured.message });
        return;
      }
      if (current.bridgePlan.requestKey !== started.bridgePlan.requestKey) {
        update({ message: "Los bridges cambiaron mientras se calculaba: revisá el resultado y volvé a aplicar." });
        return;
      }
      const plan = current.bridgePlan;
      const fresh = getSnapshot();
      const applied = applyBridgeResult(plan, fresh, ensured.response, { createId });
      if (!applied.ok) {
        update({ message: applied.error });
        return;
      }
      const production = applied.production;
      const summary = applied.summary;
      const result = applyEdit(
        {
          type: "geometry.bridge",
          label: bridgeLabel(summary),
          parameters: { mode: summary.mode, bridgeCount: summary.bridgeCount, widthMm: summary.widthMm, unit: summary.unit.label, floatingBefore: summary.floatingBefore, floatingAfter: summary.floatingAfter },
        },
        (snapshot) => (snapshot.objectsByLayer === fresh.objectsByLayer ? production : null),
      );
      if (!result.applied) {
        update({ message: result.reason === "blocked" ? "Alguna capa está bloqueada u oculta: no se puede modificar. No se hizo ningún cambio." : describeEditFailure(result) });
        return;
      }
      setSession(INITIAL_SESSION);
      onApplied(applied, result.edit);
    } finally {
      applyingRef.current = false;
      setApplying(false);
    }
  }, [bridgePreview, getSnapshot, applyEdit, createId, update, onApplied]);

  // ---- Teclado: Enter aplica; Escape sale de la colocación, descarta el análisis o cierra la herramienta ----

  const canApply = applyDisabledReason === null;
  const placingNow = session.placing !== null;
  const hasAnalysis = analysisPlan !== null;
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "Escape") {
        event.preventDefault();
        if (placingNow) update({ placing: null });
        else if (hasAnalysis) resetAnalysis();
        else close();
        return;
      }
      if (isTextEntry(event.target)) return;
      if (event.key === "Enter" && canApply) {
        event.preventDefault();
        void handleApply();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  // ---- Lo que consumen el canvas y el panel ----

  const scope = useMemo(() => floatingScope(selectedObjects, state), [selectedObjects, state]);
  const issues = analysis?.issues ?? [];
  const bridgeViews = outcome?.bridges ?? [];

  const surface = active && analysis && issues.length > 0 && !stale && session.placing !== null ? { tool: "floating" as const, onFloatingPoint: placeAt } : undefined;

  const overlay =
    active && analysis && !stale
      ? {
          issues: issues.map((issue) => ({ id: issue.id, position: issue.position, d: issue.d, rect: issue.rect })),
          selectedId: session.selectedIssue,
          bridges: bridgeViews.map((bridge) => ({ index: bridge.index, valid: bridge.valid, d: bridge.d, anchor: bridge.anchor })),
        }
      : undefined;

  const bridgeRows = bridgeViews.map((bridge) => {
    const key = bridge.key ?? (bridge.valid && bridge.suggested && bridge.island !== null ? `s${bridge.island}` : null);
    return {
      index: bridge.index,
      key,
      label: `Bridge ${bridge.index + 1}`,
      islandLabel: bridge.islandLabel,
      suggested: bridge.suggested,
      valid: bridge.valid,
      reasonText: bridge.reasonText,
      length: bridge.length,
      area: bridge.area,
      reduces: bridge.reduces,
      moving: session.placing?.kind === "move" && session.placing.key === key,
    };
  });

  const panelAnalysisStatus: "idle" | "waiting" | "calculating" | "ready" | "error" = !analysisPlan ? "idle" : analysisError ? "error" : analysisPreview.status;
  const bridgeStatus: "idle" | "waiting" | "calculating" | "ready" | "error" = bridgeError ? "error" : bridgePreview.status;

  const panel = {
    mode: session.mode,
    onModeChange: setMode,
    scopeText: floatingScopeText(scope),
    unitLabel: unit.label,
    scaleNotice: analysisPlan?.scaleNotice ?? (mmFactor === null ? NO_SCALE_NOTICE : null),
    widthMm: session.widthMm,
    widthMin: MIN_BRIDGE_WIDTH_MM,
    widthMax: MAX_BRIDGE_WIDTH_MM,
    onWidthChange: setWidth,
    analysis: {
      status: panelAnalysisStatus,
      stale,
      summary: analysis ? analysisSummary(analysis) : null,
      errorMessage: stale ? null : analysisError,
      hasAnalysis: analysisPlan !== null,
    },
    onAnalyze: analyze,
    onRetryAnalysis: analysisPreview.retry,
    issues: issues.map((issue) => ({ id: issue.id, label: issue.label, description: issueDescription(issue, unit, session.mode), depth: issue.depth })),
    selectedIssue: session.selectedIssue,
    onSelectIssue: selectIssue,
    bridges: {
      visible: analysis !== null && issues.length > 0 && !stale,
      status: bridgeStatus,
      rows: bridgeRows,
      readyText: bridgePlan && outcome ? bridgeReadyText(outcome) : null,
      reanalysisText: outcome ? reanalysisText(outcome) : null,
      areaVerb: session.mode === "stencil" ? "quita" : "agrega",
      warnings: bridgePlan && outcome ? bridgeWarnings(bridgePlan, outcome) : [],
      errorMessage: bridgeError,
      rejection: bridgeRejection ? { message: bridgeRejection.message, info: bridgeRejection.reason === "no_bridges" } : null,
      suggestPending: bridgePlan !== null && bridgePlan.drafts === null,
      count: effectiveDrafts.length,
    },
    placing: session.placing === null ? null : session.placing.kind,
    onTogglePlacing: togglePlacing,
    onStartMoving: startMoving,
    onRemoveBridge: removeBridge,
    onSuggest: suggestAgain,
    onRetryBridges: bridgePreview.retry,
    message: session.message,
    applying,
    applyDisabledReason,
    onApply: () => void handleApply(),
    onCancel: close,
  };

  return { session, surface, overlay, panel, stale };
}

export type FloatingTool = ReturnType<typeof useFloatingTool>;
