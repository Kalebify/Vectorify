import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { DrawMode } from "../../lib/editor/draw";
import { objectsAlongPath, type EraseMode } from "../../lib/editor/erase";
import type { EditorObject, Point } from "../../lib/editor/types";
import { screenToleranceToDocument } from "../../lib/editor/units";
import { documentToScreen, screenToDocument, type ViewportParams } from "../../lib/editor/viewport";

/** Distancia (px de PANTALLA) al primer punto a la que un click CIERRA la polilínea. */
const CLOSE_SNAP_PX = 8;
/** Separación mínima (px de pantalla) entre dos puntos de un trazo a mano alzada o del pincel. */
const MIN_STEP_PX = 2;
/** Radio de click (px de PANTALLA) del modo Objeto: constante a cualquier zoom. */
const HIT_TOLERANCE_PX = 4;
const MAX_OUTLINES = 300;
const DRAFT_COLOR = "#3a5cf5";
const ERASE_COLOR = "#dc2626";
const LOCKED_COLOR = "#7a808a";
const EMPTY_IDS: ReadonlySet<string> = new Set();

export interface ToolSurfaceProps {
  tool: "draw" | "erase";
  viewport: ViewportParams;
  /** El canvas está en pan temporal (Espacio) o con una edición pendiente: la superficie no captura el puntero. */
  suspended: boolean;
  // ---- Draw ----
  drawMode: DrawMode;
  /** Puntos de la polilínea en curso (documento). */
  draft: readonly Point[];
  /** Ancho de línea en unidades de documento (el preview lo dibuja a escala). */
  lineWidthUnits: number;
  onPolylinePoint: (point: Point, nearFirst: boolean) => void;
  onPolylineFinish: () => void;
  onFreehandStroke: (points: Point[]) => void;
  // ---- Erase ----
  eraseMode: EraseMode;
  /** Radio del pincel en unidades de documento: el cursor se dibuja a su tamaño REAL (se agranda con el zoom). */
  radiusUnits: number;
  /** Hay un cálculo del servidor en curso: no se aceptan gestos nuevos. */
  busy: boolean;
  /** Objetos visibles (pool de hit-test del modo Objeto). Incluye los de capas bloqueadas: se resaltan en gris y se informan, no se borran. */
  pool: readonly EditorObject[];
  lockedLayerIds: ReadonlySet<string>;
  onEraseObjects: (ids: string[]) => void;
  onEraseStroke: (points: Point[]) => void;
}

interface Gesture {
  pointerId: number;
  points: Point[];
  hits: Set<string>;
}

/**
 * Superficie de interacción de Draw y Erase (M3-S04): captura el puntero sobre el canvas, convierte a coordenadas de documento y
 * dibuja el preview (SVG en píxeles de pantalla). No posee ningún estado del documento: avisa con callbacks y el shell decide.
 *
 * - Draw/pluma: click agrega un punto; click sobre el primer punto cierra; doble click termina abierta. Preview con segmento elástico.
 * - Draw/mano alzada: arrastre; al soltar entrega el trazo completo (el shell lo simplifica).
 * - Erase/objeto: click o arrastre marca los objetos bajo el cursor (se resaltan en rojo); al soltar los entrega.
 * - Erase/geometría: arrastre con pincel circular; el cursor mide el radio REAL; al soltar entrega el trazo. Solo se previsualiza la
 *   huella del pincel, el resultado real lo calcula el servidor.
 * Escape durante un gesto lo descarta sin entregar nada.
 */
export function ToolSurface(props: ToolSurfaceProps) {
  const { tool, viewport, suspended, drawMode, draft, lineWidthUnits, eraseMode, radiusUnits, busy, pool, lockedLayerIds } = props;
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const [cursor, setCursor] = useState<Point | null>(null);
  const [trail, setTrail] = useState<Point[]>([]);
  const [hitIds, setHitIds] = useState<ReadonlySet<string>>(EMPTY_IDS);

  const toScreen = (event: { clientX: number; clientY: number }): Point => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  };

  const dropGesture = () => {
    gestureRef.current = null;
    setTrail([]);
    setHitIds(EMPTY_IDS);
  };

  // Un gesto a medias no sobrevive al cambio de herramienta/modo ni al desmontaje.
  useEffect(() => dropGesture, [tool, drawMode, eraseMode]);

  const gestureActive = trail.length > 0;
  useEffect(() => {
    if (!gestureActive) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      dropGesture();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [gestureActive]);

  const hitTolerance = screenToleranceToDocument(HIT_TOLERANCE_PX, viewport.scale);

  const beginGesture = (event: ReactPointerEvent<HTMLDivElement>, point: Point, hits: Set<string>) => {
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // noop: continuar sin captura de puntero (ej. entorno de test).
    }
    gestureRef.current = { pointerId: event.pointerId, points: [point], hits };
    setTrail([point]);
    setHitIds(hits);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (suspended || (event.pointerType === "mouse" && event.button !== 0)) return;
    const screen = toScreen(event);
    const point = screenToDocument(screen, viewport);

    if (tool === "draw") {
      if (busy) return;
      if (drawMode === "freehand") {
        beginGesture(event, point, new Set());
        return;
      }
      const first = draft[0];
      const nearFirst = draft.length >= 3 && first !== undefined && Math.hypot(documentToScreen(first, viewport).x - screen.x, documentToScreen(first, viewport).y - screen.y) <= CLOSE_SNAP_PX;
      props.onPolylinePoint(point, nearFirst);
      return;
    }

    if (busy) return;
    const hits = new Set<string>();
    if (eraseMode === "object") for (const object of objectsAlongPath(pool, [point], hitTolerance)) hits.add(object.id);
    beginGesture(event, point, hits);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const screen = toScreen(event);
    setCursor(screen);
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const last = gesture.points[gesture.points.length - 1];
    const lastScreen = documentToScreen(last, viewport);
    if (Math.hypot(screen.x - lastScreen.x, screen.y - lastScreen.y) < MIN_STEP_PX) return;
    const point = screenToDocument(screen, viewport);
    gesture.points.push(point);
    if (tool === "erase" && eraseMode === "object") {
      // El paso entre dos eventos del mouse se recorre entero: un movimiento rápido no se salta objetos finos.
      for (const object of objectsAlongPath(pool, [last, point], hitTolerance)) gesture.hits.add(object.id);
      setHitIds(new Set(gesture.hits));
    }
    setTrail([...gesture.points]);
  };

  const endGesture = (event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    try {
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch {
      // noop.
    }
    dropGesture();
    if (cancelled) return;
    if (tool === "draw") props.onFreehandStroke(gesture.points);
    else if (eraseMode === "object") {
      if (gesture.hits.size > 0) props.onEraseObjects([...gesture.hits]);
    } else props.onEraseStroke(gesture.points);
  };

  const scale = viewport.scale;
  const origin = documentToScreen({ x: 0, y: 0 }, viewport);
  const screenPoints = (points: readonly Point[]) => points.map((point) => documentToScreen(point, viewport));
  const polylineAttr = (points: readonly Point[]) => screenPoints(points).map((point) => `${point.x},${point.y}`).join(" ");
  const strokePx = Math.max(1, lineWidthUnits * scale);

  const draftScreen = screenPoints(draft);
  const lastDraft = draftScreen[draftScreen.length - 1];
  const showRubberBand = tool === "draw" && drawMode === "polyline" && lastDraft !== undefined && cursor !== null && !busy;
  const brushPx = Math.max(1, radiusUnits * scale);
  const outlines = tool === "erase" && eraseMode === "object" ? pool.filter((object) => hitIds.has(object.id)).slice(0, MAX_OUTLINES) : [];

  const label =
    tool === "draw"
      ? drawMode === "polyline"
        ? "Superficie de dibujo, modo Polilínea: click agrega un punto, click en el primer punto cierra, doble click o Enter termina, Retroceso quita el último punto y Escape cancela."
        : "Superficie de dibujo, modo Mano alzada: arrastrá para dibujar; al soltar se simplifica el trazo. Escape cancela."
      : eraseMode === "object"
        ? "Superficie de borrado, modo Objeto: click o arrastre elimina los objetos bajo el cursor. Escape cancela."
        : "Superficie de borrado, modo Restar geometría: arrastrá el pincel; al soltar el servidor calcula el resultado. Escape cancela.";

  return (
    <div
      ref={surfaceRef}
      className={`tool-surface tool-surface--${tool}`}
      data-testid={`${tool}-surface`}
      aria-label={label}
      role="group"
      style={suspended ? { pointerEvents: "none" } : undefined}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(event) => endGesture(event, false)}
      onPointerCancel={(event) => endGesture(event, true)}
      onPointerLeave={() => setCursor(null)}
      onDoubleClick={() => {
        if (tool === "draw" && drawMode === "polyline" && !busy) props.onPolylineFinish();
      }}
    >
      <svg className="tool-surface__overlay" width="100%" height="100%" aria-hidden="true" focusable="false">
        {tool === "draw" && drawMode === "polyline" && draftScreen.length > 0 && (
          <g data-testid="draw-preview">
            <polyline points={polylineAttr(draft)} fill="none" stroke={DRAFT_COLOR} strokeWidth={strokePx} strokeLinecap="round" strokeLinejoin="round" opacity={0.85} />
            {showRubberBand && <line x1={lastDraft.x} y1={lastDraft.y} x2={cursor.x} y2={cursor.y} stroke={DRAFT_COLOR} strokeWidth={1} strokeDasharray="4 3" />}
            {draftScreen.map((point, index) => (
              <circle key={index} cx={point.x} cy={point.y} r={index === 0 && draft.length >= 3 ? CLOSE_SNAP_PX / 2 + 1 : 3} fill="#ffffff" stroke={DRAFT_COLOR} strokeWidth={1.5} />
            ))}
          </g>
        )}

        {tool === "draw" && drawMode === "freehand" && trail.length > 0 && (
          <polyline data-testid="draw-preview" points={polylineAttr(trail)} fill="none" stroke={DRAFT_COLOR} strokeWidth={strokePx} strokeLinecap="round" strokeLinejoin="round" opacity={0.85} />
        )}

        {tool === "erase" && eraseMode === "geometry" && trail.length > 0 && (
          // Solo la HUELLA del pincel (ancho 2·radio, extremos redondos): el resultado real lo calcula el servidor al soltar.
          <polyline
            data-testid="erase-footprint"
            points={polylineAttr(trail)}
            fill="none"
            stroke={ERASE_COLOR}
            strokeOpacity={0.3}
            strokeWidth={2 * brushPx}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}

        {outlines.length > 0 && (
          <g transform={`translate(${origin.x} ${origin.y}) scale(${scale})`} data-testid="erase-hits">
            {outlines.map((object) => (
              <path
                key={object.id}
                d={object.d}
                transform={`matrix(${object.matrix.a} ${object.matrix.b} ${object.matrix.c} ${object.matrix.d} ${object.matrix.e} ${object.matrix.f})`}
                fill="none"
                stroke={lockedLayerIds.has(object.layerGroupId) ? LOCKED_COLOR : ERASE_COLOR}
                strokeDasharray={lockedLayerIds.has(object.layerGroupId) ? `${4 / scale} ${3 / scale}` : undefined}
                strokeWidth={2 / scale}
              />
            ))}
          </g>
        )}

        {tool === "erase" && cursor !== null && !busy && (
          <circle
            data-testid="erase-cursor"
            cx={cursor.x}
            cy={cursor.y}
            r={eraseMode === "geometry" ? brushPx : HIT_TOLERANCE_PX}
            fill="none"
            stroke={ERASE_COLOR}
            strokeWidth={1.5}
            strokeDasharray={eraseMode === "geometry" ? undefined : "3 2"}
          />
        )}
      </svg>
    </div>
  );
}
