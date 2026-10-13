import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyCutResult,
  cutApplyBlock,
  cutLabel,
  cutOutcome,
  cutReadyText,
  cutWarnings,
  dedupeCutPoints,
  DEFAULT_SLOT_WIDTH_MM,
  NO_SCALE_NOTICE,
  planLineCut,
  type CutApplication,
} from "../lib/editor/cut";
import type { EditableDocument, EditorEdit, EditorObject, Point } from "../lib/editor/types";
import type { SplitMode } from "../types/geometry";
import type { EditableDocumentApi } from "./useEditableDocument";
import { describeEditFailure, isTextEntry } from "./useDrawEraseTools";
import { useCutOperation } from "./useCutOperation";

/**
 * Orquestación de la herramienta Cut (M3-S10) en el Workspace: la sesión (modo, ancho de la ranura, extender, línea de corte), el plan de la petición, el
 * preview del servidor (`useCutOperation`: debounce + `AbortController`, UNA petición viva) y Apply/Cancel. La lógica geométrica vive en `lib/editor/cut.ts`;
 * acá solo se sincroniza con el documento editable y con el servidor:
 *
 * - **Un comando atómico por Apply** (`applyEdit`), con undo/redo exactos (snapshots before/after de S01). El preview y Cancel NO tocan la pila de undo.
 * - **El servidor falla (o contesta algo incoherente) => no se modifica nada**: el error queda en el panel y `Reintentar` lo vuelve a pedir.
 * - **El documento cambió mientras se calculaba**: se re-lee el estado justo antes de aplicar y `applyCutResult` descarta el resultado si los objetos ya no son los mismos.
 * - Teclado (con la herramienta activa y fuera de un campo): Enter termina la línea (y, con la línea terminada, aplica), Retroceso quita el último punto y Escape borra la
 *   línea (con la línea vacía, cierra la herramienta).
 */

interface CutSession {
  mode: SplitMode;
  /** Ancho de la ranura en mm (o u sin escala física). */
  slotWidthMm: number;
  extend: boolean;
  /** Puntos de la línea de corte tal como se dibujaron (documento). */
  points: Point[];
  /** La línea está terminada: ya no acepta puntos (Retroceso la reabre). */
  finished: boolean;
  /** Último intento de aplicar que falló. */
  message: string | null;
}

const INITIAL_SESSION: CutSession = { mode: "split", slotWidthMm: DEFAULT_SLOT_WIDTH_MM, extend: false, points: [], finished: false, message: null };

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export interface UseCutToolParams {
  /** La herramienta Cut está activa. */
  active: boolean;
  editable: Pick<EditableDocumentApi, "applyEdit" | "getSnapshot">;
  /** Estado CONFIRMADO del documento con la estructura efectiva de capas (nunca el vivo de un gesto). */
  state: EditableDocument;
  /** Objetos seleccionados (vacío = «todos los que la línea cruza»). */
  selectedObjects: readonly EditorObject[];
  /** mm por unidad de documento, o `null` sin escala física (el panel opera en unidades y avisa). */
  mmFactor: number | null;
  /** Generador de ids de las piezas (default `crypto.randomUUID`); inyectable en tests. */
  createId?: () => string;
  /** Tras un Apply exitoso: el shell selecciona las piezas, cierra la herramienta y muestra el aviso. */
  onApplied: (applied: Extract<CutApplication, { ok: true }>, edit: EditorEdit | undefined) => void;
  /** Salir de la herramienta sin aplicar (Cancel, Escape con la línea vacía): el shell vuelve a Select. La sesión se descarta sola. */
  onClose: () => void;
}

export function useCutTool({ active, editable, state, selectedObjects, mmFactor, createId, onApplied, onClose }: UseCutToolParams) {
  const [session, setSession] = useState<CutSession>(INITIAL_SESSION);
  const [applying, setApplying] = useState(false);
  // Salir de la herramienta (por cualquier camino: otro botón, un atajo, Cancel) descarta la sesión sin rastro; entrar abre una nueva con los valores por defecto.
  // Se ajusta durante el render (patrón recomendado por React) y no en un efecto: así la primera pintura con la herramienta cerrada ya no trae la línea vieja.
  const [wasActive, setWasActive] = useState(active);
  if (wasActive !== active) {
    setWasActive(active);
    if (!active) setSession(INITIAL_SESSION);
  }
  const applyingRef = useRef(false);
  const { applyEdit, getSnapshot } = editable;

  const update = useCallback((patch: Partial<CutSession>) => setSession((current) => ({ ...current, message: null, ...patch })), []);

  const planResult = useMemo(
    () =>
      active
        ? planLineCut(selectedObjects, state, { line: session.points, mode: session.mode, slotWidthMm: session.slotWidthMm, extend: session.extend, mmFactor })
        : null,
    [active, selectedObjects, state, session.points, session.mode, session.slotWidthMm, session.extend, mmFactor],
  );
  const plan = planResult?.ok ? planResult.plan : null;
  const rejection = planResult && !planResult.ok ? planResult : null;

  const preview = useCutOperation({ request: plan?.request ?? null, requestKey: plan?.requestKey ?? null });
  const outcomeResult = useMemo(() => (plan && preview.response ? cutOutcome(plan, preview.response) : null), [plan, preview.response]);
  const outcome = outcomeResult?.ok ? outcomeResult.outcome : null;
  const previewError = preview.errorMessage ?? (outcomeResult && !outcomeResult.ok ? outcomeResult.error : null);

  const applyDisabledReason = (() => {
    if (!active) return "No hay un corte abierto.";
    if (rejection) return rejection.message;
    if (!plan) return "No hay un corte para aplicar.";
    if (previewError) return "El cálculo falló: reintentalo o cambiá la línea.";
    return cutApplyBlock(plan, outcome);
  })();

  // Lo último, para el Apply asíncrono (tras esperar al servidor el estado puede ser otro).
  const latest = useRef({ active, plan });
  useEffect(() => {
    latest.current = { active, plan };
  });

  const close = useCallback(() => {
    setSession(INITIAL_SESSION);
    onClose();
  }, [onClose]);

  const handleApply = useCallback(async () => {
    const started = latest.current;
    if (!started.active || !started.plan || applyingRef.current) return;
    applyingRef.current = true;
    setApplying(true);
    try {
      // Si cambió algo desde el último preview, se recalcula primero; si ya está calculado, se usa tal cual.
      const ensured = await preview.ensure();
      const current = latest.current;
      if (!current.active || !current.plan) return;
      if (!ensured.ok) {
        if (!ensured.aborted) update({ message: ensured.message });
        return;
      }
      if (current.plan.requestKey !== started.plan.requestKey) {
        update({ message: "El corte cambió mientras se calculaba: revisá el resultado y volvé a aplicar." });
        return;
      }
      const plan = current.plan;
      const fresh = getSnapshot();
      const applied = applyCutResult(plan, fresh, ensured.response, { createId });
      if (!applied.ok) {
        update({ message: applied.error });
        return;
      }
      const production = applied.production;
      const summary = applied.summary;
      const result = applyEdit(
        {
          type: "geometry.split",
          label: cutLabel(summary),
          // Solo CUÁNTOS puntos tenía la línea de corte, nunca los puntos.
          parameters: { mode: summary.mode, slotWidth: summary.mode === "slot" ? summary.slotWidthMm : undefined, unit: summary.unit.label, extend: plan.request.extend, cutPointCount: plan.request.cutter.points.length, pieceCount: summary.pieceCount },
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
  }, [preview, getSnapshot, applyEdit, createId, update, onApplied]);

  // ---- La línea de corte ----

  const addPoint = useCallback((point: Point) => {
    setSession((current) => {
      if (current.finished) return current;
      const last = current.points[current.points.length - 1];
      // Un doble click suma dos veces el mismo punto: el segundo no cuenta.
      if (last && last.x === point.x && last.y === point.y) return current;
      return { ...current, points: [...current.points, point], message: null };
    });
  }, []);

  const finishLine = useCallback(() => {
    setSession((current) => (!current.finished && dedupeCutPoints(current.points).length >= 2 ? { ...current, points: dedupeCutPoints(current.points), finished: true, message: null } : current));
  }, []);

  const setSegment = useCallback((from: Point, to: Point) => {
    // El atajo del segmento recto es la línea COMPLETA (reemplaza lo que hubiera).
    if (from.x === to.x && from.y === to.y) return;
    setSession((current) => ({ ...current, points: [from, to], finished: true, message: null }));
  }, []);

  const undoPoint = useCallback(() => {
    setSession((current) => (current.points.length === 0 ? current : { ...current, points: current.points.slice(0, -1), finished: false, message: null }));
  }, []);

  const clearLine = useCallback(() => {
    setSession((current) => (current.points.length === 0 && !current.finished ? current : { ...current, points: [], finished: false, message: null }));
  }, []);

  // ---- Teclado: Enter termina / aplica, Retroceso quita el último punto, Escape borra la línea (o cierra la herramienta) ----

  const pointCount = session.points.length;
  const finished = session.finished;
  const canApply = applyDisabledReason === null;
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "Escape") {
        event.preventDefault();
        if (pointCount > 0) clearLine();
        else close();
        return;
      }
      if (isTextEntry(event.target)) return;
      if (event.key === "Enter") {
        event.preventDefault();
        if (!finished && dedupeCutPoints(session.points).length >= 2) finishLine();
        else if (canApply) void handleApply();
      } else if (event.key === "Backspace" && pointCount > 0) {
        event.preventDefault();
        undoPoint();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  // ---- Lo que consumen el canvas y el panel ----

  const line = dedupeCutPoints(session.points);
  const extension: Array<readonly [Point, Point]> =
    plan && plan.extend && line.length >= 2 ? [[plan.effectiveLine[0], line[0]], [line[line.length - 1], plan.effectiveLine[plan.effectiveLine.length - 1]]] : [];

  const surface = active
    ? { tool: "cut" as const, cutLine: session.points, cutFinished: session.finished, onCutPoint: addPoint, onCutFinish: finishLine, onCutSegment: setSegment }
    : undefined;

  const overlay =
    active && plan
      ? {
          objects: plan.objects.map((object, index) => ({ object, status: outcome?.objects[index]?.status ?? ("pending" as const) })),
          shapes: (outcome?.objects ?? []).flatMap((entry) => entry.shapes.map((shape, index) => ({ ...shape, index }))),
          extension,
        }
      : undefined;

  const scopeText =
    (plan?.scope ?? (selectedObjects.length > 0 ? "selection" : "crossed")) === "selection"
      ? `Alcance: la selección (${plural(plan?.objects.length ?? selectedObjects.length, "objeto", "objetos")}).`
      : "Alcance: sin selección, se cortan todos los objetos visibles y desbloqueados que la línea cruza.";

  const panel = {
    mode: session.mode,
    onModeChange: (mode: SplitMode) => update({ mode }),
    slotWidth: session.slotWidthMm,
    unitLabel: (plan?.unit.label ?? (mmFactor === null ? "u" : "mm")) as "mm" | "u",
    onSlotWidthChange: (slotWidthMm: number) => update({ slotWidthMm }),
    scaleNotice: plan?.scaleNotice ?? (mmFactor === null ? NO_SCALE_NOTICE : null),
    extend: session.extend,
    onExtendChange: (extend: boolean) => update({ extend }),
    scopeText,
    linePoints: session.points.length,
    lineFinished: session.finished,
    onFinishLine: finishLine,
    onUndoPoint: undoPoint,
    onClearLine: clearLine,
    preview: {
      status: (previewError ? "error" : preview.status) as "idle" | "waiting" | "calculating" | "ready" | "error",
      readyText: plan && outcome ? cutReadyText(plan, outcome) : null,
      warnings: plan && outcome ? cutWarnings(plan, outcome) : [],
      errorMessage: previewError,
    },
    rejection: rejection ? { message: rejection.message, info: rejection.reason === "line_missing" } : null,
    message: session.message,
    applying,
    applyDisabledReason,
    onApply: () => void handleApply(),
    onCancel: close,
    onRetry: preview.retry,
  };

  return { session, surface, overlay, panel };
}

export type CutTool = ReturnType<typeof useCutTool>;
