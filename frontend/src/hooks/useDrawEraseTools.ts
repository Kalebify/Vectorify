import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildDrawProduction,
  buildNormalizeRequest,
  createDrawnObject,
  DEFAULT_LINE_WIDTH_MM,
  DEFAULT_SIMPLIFY_MM,
  drawTargetInfo,
  objectsFromPolygonPieces,
  planStroke,
  resolveDrawTarget,
  simplifyPolyline,
  type DrawMode,
  type DrawTarget,
} from "../lib/editor/draw";
import {
  applyEraseResult,
  DEFAULT_ERASE_RADIUS_MM,
  eraseLabel,
  eraseNotice,
  planGeometryErase,
  planObjectErase,
  type EraseMode,
  type EraseScope,
} from "../lib/editor/erase";
import { DEFAULT_FLATNESS_MM, toDocumentUnits, unitScale, validateBooleanResponse, type UnitScale } from "../lib/editor/geometry";
import { removeObjects } from "../lib/editor/selection";
import type { EditableLayerMeta, Point } from "../lib/editor/types";
import type { ApplyEditResult, EditableDocumentApi } from "./useEditableDocument";
import { useGeometryOperation } from "./useGeometryOperation";

/**
 * Orquestación de las herramientas Draw y Erase (M3-S04) en el Workspace: estado de los paneles (modo, ancho de línea, radio...), el borrador
 * de la pluma, y los pipelines "trazo -> (servidor) -> UN comando". La lógica geométrica vive en `lib/editor/{draw,erase,geometry}.ts`; acá solo
 * se sincroniza con el documento editable y con el servidor:
 *
 * - **Comando único por trazo/gesto** (`applyEdit`), con undo/redo exactos (snapshots before/after de S01).
 * - **El servidor falla => no se modifica nada**: el error queda en el panel y el borrador de la pluma se conserva para reintentar.
 * - **El documento cambió mientras se calculaba**: se re-lee el estado justo antes de aplicar y `applyEraseResult` descarta el resultado si los
 *   objetos ya no son los mismos.
 * - Esc cancela el cálculo en curso, o el borrador de la pluma; Enter termina una línea abierta; Retroceso quita el último punto.
 */

export interface DrawTargetStatus {
  /** `existing`: se dibuja en la capa activa; `create`: no hay capa activa, se creará «Dibujo»; `rejected`: la capa activa está bloqueada/oculta. */
  kind: "existing" | "create" | "rejected";
  layerName: string | null;
  message: string | null;
}

export interface UseDrawEraseParams {
  activeTool: string;
  editable: Pick<EditableDocumentApi, "applyEdit" | "getSnapshot">;
  /** Estructura EFECTIVA y CONFIRMADA de las capas (visibilidad efectiva con Isolate): para mostrar la capa de destino en el panel. */
  layers: readonly EditableLayerMeta[];
  /** Capa activa = capa seleccionada en el panel de capas (seleccionar un objeto activa su capa). */
  activeGroupId: string | null;
  selectGroup: (groupId: string | null) => void;
  /** mm por unidad de documento, o `null` sin escala física (entonces el panel trabaja en unidades `u`). */
  mmFactor: number | null;
  /** Mensaje de confirmación de la última acción (barra de estado del canvas). */
  onNotice: (text: string | null) => void;
  /** Generador de ids de objetos y capas nuevos (default `crypto.randomUUID`); inyectable en tests. */
  createId?: () => string;
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function defaultCreateId(): string {
  return crypto.randomUUID();
}

function isTextEntry(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return Boolean(element && (element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.tagName === "SELECT" || element.tagName === "BUTTON" || element.isContentEditable));
}

function describeEditFailure(result: ApplyEditResult): string {
  if (result.reason === "blocked") return "La capa está bloqueada u oculta: no se puede modificar. Desbloqueala o mostrala en el panel de Capas. No se hizo ningún cambio.";
  if (result.reason === "gesture_active") return "Hay una transformación pendiente: aplicala (Apply) o cancelala (Cancel) antes de editar.";
  return "No hubo cambios para aplicar.";
}

export function useDrawEraseTools({ activeTool, editable, layers, activeGroupId, selectGroup, mmFactor, onNotice, createId = defaultCreateId }: UseDrawEraseParams) {
  const unit: UnitScale = useMemo(() => unitScale(mmFactor), [mmFactor]);
  const flatness = toDocumentUnits(DEFAULT_FLATNESS_MM, unit);
  const { status: geometryStatus, errorMessage: serverError, run: geometryRun, cancel: cancelGeometry, clearError: clearGeometryError } = useGeometryOperation();
  const { applyEdit, getSnapshot } = editable;

  // ---- Draw ----
  const [drawMode, setDrawMode] = useState<DrawMode>("polyline");
  const [lineWidthMm, setLineWidthMm] = useState(DEFAULT_LINE_WIDTH_MM);
  const [simplifyMm, setSimplifyMm] = useState(DEFAULT_SIMPLIFY_MM);
  const [closeFreehand, setCloseFreehand] = useState(false);
  const [draft, setDraft] = useState<Point[]>([]);
  const [drawMessage, setDrawMessage] = useState<string | null>(null);

  // ---- Erase ----
  const [eraseMode, setEraseMode] = useState<EraseMode>("geometry");
  const [radiusMm, setRadiusMm] = useState(DEFAULT_ERASE_RADIUS_MM);
  const [scope, setScope] = useState<EraseScope>("active-layer");
  const [eraseMessage, setEraseMessage] = useState<string | null>(null);

  // Último estado en refs: los handlers de abajo son estables pero siempre leen lo vigente al momento del gesto.
  const latest = useRef({ activeGroupId, drawMode, lineWidthMm, simplifyMm, closeFreehand, radiusMm, scope, unit, flatness, draft, createId, geometryRun });
  useEffect(() => {
    latest.current = { activeGroupId, drawMode, lineWidthMm, simplifyMm, closeFreehand, radiusMm, scope, unit, flatness, draft, createId, geometryRun };
  });

  const targetStatus = useMemo<DrawTargetStatus>(() => {
    const resolved = resolveDrawTarget(layers, activeGroupId, "preview");
    if (!resolved.ok) {
      const active = layers.find((layer) => layer.groupId === activeGroupId);
      return { kind: "rejected", layerName: active?.name ?? null, message: resolved.message };
    }
    return resolved.target.kind === "existing"
      ? { kind: "existing", layerName: resolved.target.layer.name, message: null }
      : { kind: "create", layerName: null, message: null };
  }, [layers, activeGroupId]);

  const resetMessages = useCallback(() => {
    setDrawMessage(null);
    setEraseMessage(null);
    clearGeometryError();
  }, [clearGeometryError]);

  /** Crea el/los objetos de un trazo ya validado y los aplica como UN comando. `closed` + `needsNormalize` pasan antes por el servidor. */
  const commitStroke = useCallback(
    async (points: Point[], closed: boolean): Promise<boolean> => {
      const state = latest.current;
      const plan = planStroke(points, closed, state.flatness);
      if (!plan.ok) {
        setDrawMessage(plan.error);
        return false;
      }
      const snapshot = getSnapshot();
      const resolved = resolveDrawTarget(snapshot.layers ?? [], state.activeGroupId, state.createId());
      if (!resolved.ok) {
        setDrawMessage(resolved.message);
        return false;
      }
      const target: DrawTarget = resolved.target;
      const info = drawTargetInfo(target);
      const lineWidth = toDocumentUnits(state.lineWidthMm, state.unit);

      let objects;
      let label: string;
      if (plan.needsNormalize) {
        // Un cerrado que se cruza a sí mismo NO es geometría válida: lo normaliza el servidor. Sin servidor, se rechaza (nunca se crea inválido).
        const request = buildNormalizeRequest(plan.points, state.flatness);
        const outcome = await state.geometryRun(request);
        if (!outcome.ok) {
          setDrawMessage(outcome.aborted ? "Cálculo cancelado. No se creó nada." : `${outcome.message} El trazo no se creó: ajustalo o reintentá con Enter.`);
          return false;
        }
        const invalid = validateBooleanResponse(request, outcome.response);
        const pieces = invalid ? null : outcome.response.results[0].geometries;
        if (pieces && pieces.length === 0) {
          setDrawMessage("El trazo cerrado no encierra área una vez corregidos sus cruces. No se creó nada.");
          return false;
        }
        objects = pieces ? objectsFromPolygonPieces(pieces, { layerGroupId: info.groupId, colorHex: info.colorHex, createId: latest.current.createId }) : null;
        if (!objects) {
          setDrawMessage(`El servidor devolvió un resultado que no se puede usar${invalid ? ` (${invalid})` : ""}. El trazo no se creó.`);
          return false;
        }
        label = objects.length > 1 ? `Dibujar forma cerrada (${objects.length} piezas)` : "Dibujar forma cerrada";
      } else {
        objects = [createDrawnObject({ id: latest.current.createId(), layerGroupId: info.groupId, colorHex: info.colorHex, points: plan.points, closed: plan.closed, lineWidth })];
        label = plan.closed ? "Dibujar forma cerrada" : "Dibujar línea";
      }

      const finalObjects = objects;
      const result = applyEdit(label, (current) => buildDrawProduction(current, finalObjects, target));
      if (!result.applied) {
        setDrawMessage(describeEditFailure(result));
        return false;
      }
      setDrawMessage(null);
      setDraft([]);
      // La capa donde se dibujó (existente o la «Dibujo» recién creada) queda como capa activa: el siguiente trazo va a la misma.
      selectGroup(info.groupId);
      const where = target.kind === "create" ? `la capa nueva «${getSnapshot().layers?.find((layer) => layer.groupId === info.groupId)?.name ?? "Dibujo"}» (sin guardar todavía)` : `«${target.layer.name}»`;
      onNotice(`${label} en ${where}${finalObjects.length > 1 ? `: ${plural(finalObjects.length, "objeto", "objetos")}` : ""}.`);
      return true;
    },
    [applyEdit, getSnapshot, selectGroup, onNotice],
  );

  const addPoint = useCallback(
    (point: Point, nearFirst: boolean) => {
      if (geometryStatus === "running") return;
      setDrawMessage(null);
      onNotice(null);
      const current = latest.current.draft;
      if (nearFirst && current.length >= 3) {
        void commitStroke(current, true);
        return;
      }
      setDraft((points) => [...points, point]);
    },
    [commitStroke, geometryStatus, onNotice],
  );

  /** Termina la polilínea: abierta (Enter, doble click) o cerrada (botón «Cerrar»). */
  const finishDraft = useCallback(
    (closed: boolean) => {
      if (geometryStatus === "running") return;
      onNotice(null);
      void commitStroke(latest.current.draft, closed);
    },
    [commitStroke, geometryStatus, onNotice],
  );

  const undoPoint = useCallback(() => {
    setDrawMessage(null);
    setDraft((points) => points.slice(0, -1));
  }, []);

  const cancelDraft = useCallback(() => {
    setDrawMessage(null);
    setDraft([]);
  }, []);

  /** Mano alzada: el trazo se simplifica (Ramer–Douglas–Peucker, tolerancia en mm) y se crea al soltar. */
  const commitFreehand = useCallback(
    (points: Point[]) => {
      if (geometryStatus === "running") return;
      onNotice(null);
      const state = latest.current;
      const simplified = simplifyPolyline(points, toDocumentUnits(state.simplifyMm, state.unit));
      void commitStroke(simplified, state.closeFreehand);
    },
    [commitStroke, geometryStatus, onNotice],
  );

  // ---- Erase ----

  const radiusUnits = toDocumentUnits(radiusMm, unit);

  /** Modo Objeto: elimina los objetos `ids` (bajo el cursor) salvo los de capas bloqueadas; UN comando por gesto. */
  const eraseObjects = useCallback(
    (ids: readonly string[]) => {
      onNotice(null);
      setEraseMessage(null);
      const snapshot = getSnapshot();
      const wanted = new Set(ids);
      const hit = Object.values(snapshot.objectsByLayer)
        .flat()
        .filter((object) => wanted.has(object.id));
      if (hit.length === 0) return;
      const locked = new Set((snapshot.layers ?? []).filter((layer) => layer.locked).map((layer) => layer.groupId));
      const plan = planObjectErase(snapshot, hit, locked);
      if (!plan.production) {
        setEraseMessage(plan.skippedLocked > 0 ? "Los objetos bajo el cursor están en capas bloqueadas: no se pueden borrar. Desbloqueá la capa en el panel de Capas. No se borró nada." : "No hay nada que borrar bajo el cursor.");
        return;
      }
      const removableIds = new Set(hit.filter((object) => !locked.has(object.layerGroupId)).map((object) => object.id));
      const result = applyEdit(`Borrar ${plural(plan.removed, "objeto", "objetos")}`, (state) => removeObjects(state, removableIds));
      if (!result.applied) {
        setEraseMessage(describeEditFailure(result));
        return;
      }
      onNotice(
        `${plural(plan.removed, "objeto eliminado", "objetos eliminados")}.${plan.skippedLocked > 0 ? ` ${plural(plan.skippedLocked, "objeto está", "objetos están")} en capas bloqueadas y no se borró.` : ""}`,
      );
    },
    [applyEdit, getSnapshot, onNotice],
  );

  /** Modo Restar geometría: el trazo del pincel viaja al servidor como `bufferedLine` (difference) y el resultado se aplica como UN comando. */
  const eraseStroke = useCallback(
    async (points: Point[]) => {
      if (geometryStatus === "running") return;
      onNotice(null);
      setEraseMessage(null);
      const state = latest.current;
      const planned = planGeometryErase(getSnapshot(), points, {
        radius: toDocumentUnits(state.radiusMm, state.unit),
        flatness: state.flatness,
        scope: state.scope,
        activeGroupId: state.activeGroupId,
      });
      if (planned.status === "error") {
        setEraseMessage(planned.message);
        return;
      }
      if (planned.status === "empty") {
        onNotice(`${planned.message}${planned.skippedLocked > 0 ? ` ${plural(planned.skippedLocked, "objeto está", "objetos están")} en capas bloqueadas.` : ""}`);
        return;
      }
      const { plan } = planned;
      const outcome = await state.geometryRun(plan.request);
      if (!outcome.ok) {
        // Error del servidor: recuperable y SIN tocar nada (el mensaje ya quedó en `geometry.errorMessage`).
        if (outcome.aborted) onNotice("Cálculo cancelado. No se modificó nada.");
        return;
      }
      // Se vuelve a leer el documento JUSTO antes de aplicar: si cambió mientras se calculaba, `applyEraseResult` descarta el resultado.
      const fresh = getSnapshot();
      const applied = applyEraseResult(fresh, plan, outcome.response, latest.current.createId);
      if (!applied.ok) {
        setEraseMessage(applied.error);
        return;
      }
      const production = applied.production;
      if (!production) {
        onNotice(eraseNotice(applied.summary, plan));
        return;
      }
      const result = applyEdit(eraseLabel(applied.summary), (current) => (current.objectsByLayer === fresh.objectsByLayer ? production : null));
      if (!result.applied) {
        setEraseMessage(describeEditFailure(result));
        return;
      }
      onNotice(eraseNotice(applied.summary, plan));
    },
    [applyEdit, getSnapshot, geometryStatus, onNotice],
  );

  // ---- Cancelar / salir de la herramienta ----

  const cancelAll = useCallback(() => {
    cancelGeometry();
    setDraft([]);
    resetMessages();
  }, [cancelGeometry, resetMessages]);

  // Salir de Draw/Erase descarta el borrador y aborta lo que esté en vuelo (sin dejar rastro en el documento).
  const isDrawEraseTool = activeTool === "draw" || activeTool === "erase";
  const wasActive = useRef(false);
  useEffect(() => {
    if (wasActive.current && !isDrawEraseTool) {
      cancelGeometry();
      setDraft([]);
      setDrawMessage(null);
      setEraseMessage(null);
      clearGeometryError();
    }
    wasActive.current = isDrawEraseTool;
  }, [isDrawEraseTool, cancelGeometry, clearGeometryError]);

  // Teclado: Esc cancela el cálculo o el borrador; Enter termina la línea abierta; Retroceso quita el último punto.
  const geometryRunning = geometryStatus === "running";
  const draftLength = draft.length;
  useEffect(() => {
    if (!isDrawEraseTool) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "Escape") {
        if (geometryRunning) {
          event.preventDefault();
          cancelGeometry();
        } else if (activeTool === "draw" && draftLength > 0) {
          event.preventDefault();
          cancelDraft();
        }
        return;
      }
      if (activeTool !== "draw" || isTextEntry(event.target)) return;
      if (event.key === "Enter" && draftLength >= 2 && !geometryRunning) {
        event.preventDefault();
        finishDraft(false);
      } else if (event.key === "Backspace" && draftLength > 0) {
        event.preventDefault();
        undoPoint();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isDrawEraseTool, activeTool, geometryRunning, draftLength, cancelGeometry, cancelDraft, finishDraft, undoPoint]);

  return {
    unit,
    flatness,
    busy: geometryRunning,
    serverError,
    cancelAll,
    cancelCalculation: cancelGeometry,
    draw: {
      mode: drawMode,
      setMode: (mode: DrawMode) => {
        setDraft([]);
        setDrawMessage(null);
        setDrawMode(mode);
      },
      lineWidthMm,
      setLineWidthMm,
      simplifyMm,
      setSimplifyMm,
      closeFreehand,
      setCloseFreehand,
      draft,
      target: targetStatus,
      message: drawMessage,
      addPoint,
      finish: finishDraft,
      undoPoint,
      cancelDraft,
      commitFreehand,
    },
    erase: {
      mode: eraseMode,
      setMode: (mode: EraseMode) => {
        setEraseMessage(null);
        setEraseMode(mode);
      },
      radiusMm,
      setRadiusMm,
      radiusUnits,
      scope,
      setScope,
      message: eraseMessage,
      eraseObjects,
      eraseStroke,
    },
  };
}

export type DrawEraseTools = ReturnType<typeof useDrawEraseTools>;
