import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { DragModifiers, DragRequest, SelectMode } from "../../hooks/usePathTool";
import { nodeKey, segmentCurve, type HandleSide, type NodeRef, type PathModel } from "../../lib/editor/nodes";
import { hitTest, rectFromPoints } from "../../lib/editor/objects";
import {
  ANCHOR_SIZE_PX,
  collectOverlayNodes,
  DRAG_THRESHOLD_PX,
  HANDLE_RADIUS_PX,
  hitTestPath,
  localToDocument,
  nodesInRect,
  pathHitTolerances,
  viewportRectInDocument,
  visibleHandles,
  type PathHit,
} from "../../lib/editor/pathEdit";
import type { EditorObject, Point, Rect } from "../../lib/editor/types";
import { documentToScreen, screenToDocument, type ViewportParams } from "../../lib/editor/viewport";

const ACCENT = "#3a5cf5";
const HOVER = "#f59e0b";
const HANDLE_LINE = "#6f7787";

export interface PathSurfaceProps {
  viewport: ViewportParams;
  /** El canvas está en pan temporal (Espacio) o con una edición pendiente: la superficie no captura el puntero. */
  suspended: boolean;
  /** Objetos seleccionables (pool de hit-test): un click sobre OTRO objeto lo pasa a editar. */
  pool: readonly EditorObject[];
  /** Objeto editado EN VIVO (incluye la previsualización de un arrastre) y su modelo de nodos. */
  object: EditorObject;
  model: PathModel;
  /** Nodos seleccionados (claves `nodeKey`). */
  selection: ReadonlySet<string>;
  onSelectNodes: (refs: NodeRef[], mode: SelectMode) => void;
  onClearSelection: () => void;
  onBeginDrag: (request: DragRequest) => boolean;
  onDragBy: (delta: Point, modifiers: DragModifiers) => void;
  onEndDrag: () => void;
  onCancelDrag: () => void;
  onAddNode: (subpath: number, segment: number, t: number) => void;
  onToggleKind: (ref: NodeRef) => void;
  onPickObject: (objectId: string) => void;
}

type Interaction =
  | { kind: "anchors"; pointerId: number; startScreen: Point; startDoc: Point; refs: NodeRef[]; started: boolean; reduceTo: NodeRef | null }
  | { kind: "handle"; pointerId: number; startScreen: Point; startDoc: Point; ref: NodeRef; side: HandleSide; started: boolean }
  | { kind: "marquee"; pointerId: number; startScreen: Point; startDoc: Point; additive: boolean; moved: boolean };

function hitKey(hit: PathHit | null): string {
  if (!hit) return "";
  if (hit.kind === "handle") return `h:${nodeKey(hit.ref)}:${hit.side}`;
  if (hit.kind === "anchor") return `a:${nodeKey(hit.ref)}`;
  return `s:${hit.subpath}:${hit.segment}`;
}

/**
 * Superficie de la herramienta Path (M3-S05): captura el puntero sobre el canvas, convierte a coordenadas de documento y dibuja el overlay
 * de nodos (SVG en píxeles de PANTALLA: el tamaño de anchors, handles y áreas de hit es constante a cualquier zoom). No posee ningún estado
 * del documento: avisa con callbacks y la herramienta (`usePathTool`) decide.
 *
 * - Click en un anchor selecciona (Shift alterna); click en un segmento selecciona sus dos extremos; click en vacío limpia; arrastre en vacío
 *   hace marquee; click sobre OTRO objeto lo pasa a editar.
 * - Arrastre de anchors seleccionados / de un handle (Shift restringe a ejes, Alt rompe el nodo a esquina): UN gesto.
 * - Doble click o Ctrl+click sobre un segmento agrega un nodo; Alt+click sobre un anchor alterna esquina/suave.
 * - Escape durante un gesto lo cancela sin entregar nada.
 * - El overlay se acota al viewport y a un máximo de nodos (los seleccionados siempre se dibujan) y avisa cuando recorta.
 */
export function PathSurface(props: PathSurfaceProps) {
  const { viewport, suspended, pool, object, model, selection } = props;
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const interactionRef = useRef<Interaction | null>(null);
  const [interacting, setInteracting] = useState(false);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const [hover, setHover] = useState<PathHit | null>(null);

  const { containerWidth, containerHeight, panX, panY, scale, sourceWidth, sourceHeight, originX, originY } = viewport;
  const view = useMemo(
    () => viewportRectInDocument({ containerWidth, containerHeight, panX, panY, scale, sourceWidth, sourceHeight, originX, originY }),
    [containerWidth, containerHeight, panX, panY, scale, sourceWidth, sourceHeight, originX, originY],
  );
  const tolerances = pathHitTolerances(scale);
  const overlay = useMemo(() => collectOverlayNodes(model, object.matrix, view, selection), [model, object.matrix, view, selection]);
  const allowedAnchors = useMemo(() => (overlay.truncated ? new Set(overlay.nodes.map((node) => node.key)) : null), [overlay]);
  const handles = useMemo(() => visibleHandles(model, selection), [model, selection]);

  const toScreen = (event: { clientX: number; clientY: number }): Point => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  };

  const hitAt = (documentPoint: Point): PathHit | null => hitTestPath(model, object.matrix, documentPoint, tolerances, { handles, allowedAnchors });

  const dropInteraction = () => {
    interactionRef.current = null;
    setMarquee(null);
    setInteracting(false);
  };

  // Un gesto a medias no sobrevive al desmontaje de la superficie (salir de la herramienta, cambiar de objeto).
  useEffect(
    () => () => {
      const interaction = interactionRef.current;
      if (interaction && interaction.kind !== "marquee" && interaction.started) props.onCancelDrag();
      interactionRef.current = null;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Escape durante un gesto: en fase de CAPTURA y con preventDefault, así la herramienta (que sale o limpia la selección con Escape) no lo ve.
  const { onCancelDrag } = props;
  useEffect(() => {
    if (!interacting) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      const interaction = interactionRef.current;
      if (interaction && interaction.kind !== "marquee" && interaction.started) onCancelDrag();
      interactionRef.current = null;
      setMarquee(null);
      setInteracting(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [interacting, onCancelDrag]);

  const capture = (event: ReactPointerEvent<HTMLDivElement>) => {
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // noop: continuar sin captura de puntero (ej. entorno de test).
    }
  };

  const release = (event: ReactPointerEvent<HTMLDivElement>) => {
    try {
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch {
      // noop.
    }
  };

  const selectedRefs = (): NodeRef[] => {
    const refs: NodeRef[] = [];
    model.subpaths.forEach((subpath, subpathIndex) => {
      subpath.nodes.forEach((_, nodeIndex) => {
        if (selection.has(nodeKey({ subpath: subpathIndex, node: nodeIndex }))) refs.push({ subpath: subpathIndex, node: nodeIndex });
      });
    });
    return refs;
  };

  const startInteraction = (event: ReactPointerEvent<HTMLDivElement>, interaction: Interaction) => {
    capture(event);
    interactionRef.current = interaction;
    setInteracting(true);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (suspended || (event.pointerType === "mouse" && event.button !== 0)) return;
    const screen = toScreen(event);
    const point = screenToDocument(screen, viewport);
    const hit = hitAt(point);
    const base = { pointerId: event.pointerId, startScreen: screen, startDoc: point };
    setHover(null);

    if (hit?.kind === "handle") {
      startInteraction(event, { kind: "handle", ...base, ref: hit.ref, side: hit.side, started: false });
      return;
    }

    if (hit?.kind === "anchor") {
      if (event.altKey) {
        props.onToggleKind(hit.ref);
        return;
      }
      const selected = selection.has(nodeKey(hit.ref));
      if (event.shiftKey) {
        props.onSelectNodes([hit.ref], "toggle");
        // Shift+click sobre un nodo ya seleccionado lo saca de la selección: no hay arrastre.
        if (selected) return;
        startInteraction(event, { kind: "anchors", ...base, refs: [...selectedRefs(), hit.ref], started: false, reduceTo: null });
        return;
      }
      if (!selected) props.onSelectNodes([hit.ref], "replace");
      const refs = selected ? selectedRefs() : [hit.ref];
      // Click simple (sin arrastre) sobre un nodo de una multi-selección: la selección se reduce a ese nodo.
      startInteraction(event, { kind: "anchors", ...base, refs, started: false, reduceTo: selected && refs.length > 1 ? hit.ref : null });
      return;
    }

    if (hit?.kind === "segment") {
      if (event.ctrlKey || event.metaKey) {
        props.onAddNode(hit.subpath, hit.segment, hit.t);
        return;
      }
      const subpath = model.subpaths[hit.subpath];
      const ends: NodeRef[] = [
        { subpath: hit.subpath, node: hit.segment },
        { subpath: hit.subpath, node: (hit.segment + 1) % subpath.nodes.length },
      ];
      props.onSelectNodes(ends, event.shiftKey ? "add" : "replace");
      startInteraction(event, { kind: "anchors", ...base, refs: ends, started: false, reduceTo: null });
      return;
    }

    // Vacío: un click sobre OTRO objeto lo pasa a editar; si no, es el inicio de un marquee (o un click que limpia la selección).
    const other = hitTest(pool, point, tolerances.segment);
    if (other && other.id !== object.id && !event.shiftKey) {
      props.onPickObject(other.id);
      return;
    }
    startInteraction(event, { kind: "marquee", ...base, additive: event.shiftKey, moved: false });
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const screen = toScreen(event);
    const interaction = interactionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) {
      if (suspended) return;
      const next = hitAt(screenToDocument(screen, viewport));
      setHover((current) => (hitKey(current) === hitKey(next) ? current : next));
      return;
    }
    const point = screenToDocument(screen, viewport);
    const pastThreshold = Math.hypot(screen.x - interaction.startScreen.x, screen.y - interaction.startScreen.y) >= DRAG_THRESHOLD_PX;

    if (interaction.kind === "marquee") {
      if (!interaction.moved && !pastThreshold) return;
      interaction.moved = true;
      setMarquee(rectFromPoints(interaction.startDoc, point));
      return;
    }

    if (!interaction.started) {
      if (!pastThreshold) return;
      const began = props.onBeginDrag(interaction.kind === "anchors" ? { kind: "anchors", refs: interaction.refs } : { kind: "handle", ref: interaction.ref, side: interaction.side });
      if (!began) {
        release(event);
        dropInteraction();
        return;
      }
      interaction.started = true;
    }
    // Cada paso se recompone desde el estado ANTES del gesto + el delta total (sin acumular error).
    props.onDragBy({ x: point.x - interaction.startDoc.x, y: point.y - interaction.startDoc.y }, { shift: event.shiftKey, alt: event.altKey });
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const interaction = interactionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return;
    release(event);
    dropInteraction();

    if (interaction.kind === "marquee") {
      if (!interaction.moved) {
        // Click en vacío: limpia la selección (Shift+click en vacío no la toca).
        if (!interaction.additive) props.onClearSelection();
        return;
      }
      const rect = rectFromPoints(interaction.startDoc, screenToDocument(toScreen(event), viewport));
      props.onSelectNodes(nodesInRect(model, object.matrix, rect, allowedAnchors), interaction.additive ? "add" : "replace");
      return;
    }
    if (interaction.started) {
      props.onEndDrag();
      return;
    }
    if (interaction.kind === "anchors" && interaction.reduceTo) props.onSelectNodes([interaction.reduceTo], "replace");
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    const interaction = interactionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return;
    release(event);
    dropInteraction();
    if (interaction.kind !== "marquee" && interaction.started) props.onCancelDrag();
  };

  const handleDoubleClick = (event: { clientX: number; clientY: number }) => {
    if (suspended) return;
    const hit = hitAt(screenToDocument(toScreen(event), viewport));
    if (hit?.kind === "segment") props.onAddNode(hit.subpath, hit.segment, hit.t);
  };

  // ---- Dibujo ----

  const origin = documentToScreen({ x: 0, y: 0 }, viewport);
  const { a, b, c, d, e, f } = object.matrix;
  const matrixAttr = `matrix(${a} ${b} ${c} ${d} ${e} ${f})`;
  const screenOf = (local: Point) => documentToScreen(localToDocument(object.matrix, local), viewport);

  let hoverPath: string | null = null;
  if (hover?.kind === "segment") {
    const curve = segmentCurve(model.subpaths[hover.subpath], hover.segment);
    if (curve) hoverPath = curve.curved ? `M${curve.p0.x} ${curve.p0.y} C${curve.p1.x} ${curve.p1.y} ${curve.p2.x} ${curve.p2.y} ${curve.p3.x} ${curve.p3.y}` : `M${curve.p0.x} ${curve.p0.y} L${curve.p3.x} ${curve.p3.y}`;
  }

  const marqueeScreen = marquee
    ? (() => {
        const topLeft = documentToScreen({ x: marquee.x, y: marquee.y }, viewport);
        const bottomRight = documentToScreen({ x: marquee.x + marquee.width, y: marquee.y + marquee.height }, viewport);
        return { x: topLeft.x, y: topLeft.y, width: bottomRight.x - topLeft.x, height: bottomRight.y - topLeft.y };
      })()
    : null;

  const label = `Edición de nodos del path: ${overlay.total} ${overlay.total === 1 ? "nodo" : "nodos"}, ${selection.size} ${selection.size === 1 ? "seleccionado" : "seleccionados"}. Click selecciona un nodo o un segmento, Mayúscula agrega o quita, arrastre mueve anchors y handles, arrastre en vacío selecciona con un rectángulo, doble click o Control más click sobre un segmento agrega un nodo, Alt más click alterna esquina y suave, Suprimir elimina, flechas mueven, Escape limpia la selección o sale y Enter sale.`;

  return (
    <div
      ref={surfaceRef}
      className="tool-surface tool-surface--path"
      data-testid="path-surface"
      role="group"
      aria-label={label}
      style={suspended ? { pointerEvents: "none" } : undefined}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onPointerLeave={() => setHover(null)}
      onDoubleClick={handleDoubleClick}
    >
      <svg className="tool-surface__overlay" width="100%" height="100%" aria-hidden="true" focusable="false">
        <g transform={`translate(${origin.x} ${origin.y}) scale(${scale})`}>
          <path data-testid="path-contour" d={object.d} transform={matrixAttr} fill="none" stroke={ACCENT} strokeWidth={1.5 / scale} opacity={0.9} />
          {hoverPath && <path data-testid="path-hover-segment" d={hoverPath} transform={matrixAttr} fill="none" stroke={HOVER} strokeWidth={3 / scale} strokeLinecap="round" />}
        </g>

        {handles.map((handle) => {
          const located = model.subpaths[handle.subpath]?.nodes[handle.node];
          const local = located ? (handle.side === "in" ? located.handleIn : located.handleOut) : null;
          if (!located || !local) return null;
          const from = screenOf(located.anchor);
          const to = screenOf(local);
          const hovered = hover?.kind === "handle" && hover.ref.subpath === handle.subpath && hover.ref.node === handle.node && hover.side === handle.side;
          return (
            <g key={`${nodeKey(handle)}:${handle.side}`}>
              <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={HANDLE_LINE} strokeWidth={1} />
              <circle
                data-testid="path-handle"
                data-handle={`${nodeKey(handle)}:${handle.side}`}
                cx={to.x}
                cy={to.y}
                r={HANDLE_RADIUS_PX}
                fill={hovered ? HOVER : "#ffffff"}
                stroke={ACCENT}
                strokeWidth={1.5}
              />
            </g>
          );
        })}

        {overlay.nodes.map((node) => {
          const screen = documentToScreen(node.doc, viewport);
          const hovered = hover?.kind === "anchor" && nodeKey(hover.ref) === node.key;
          return (
            <rect
              key={node.key}
              data-testid="path-anchor"
              data-node={node.key}
              data-selected={node.selected ? "true" : "false"}
              x={screen.x - ANCHOR_SIZE_PX / 2}
              y={screen.y - ANCHOR_SIZE_PX / 2}
              width={ANCHOR_SIZE_PX}
              height={ANCHOR_SIZE_PX}
              fill={node.selected ? ACCENT : hovered ? HOVER : "#ffffff"}
              stroke={ACCENT}
              strokeWidth={1.5}
            />
          );
        })}

        {marqueeScreen && (
          <rect data-testid="path-marquee" x={marqueeScreen.x} y={marqueeScreen.y} width={marqueeScreen.width} height={marqueeScreen.height} fill="rgba(58, 92, 245, 0.08)" stroke={ACCENT} strokeWidth={1} strokeDasharray="4 3" />
        )}
      </svg>

      {overlay.truncated && (
        <p className="tool-surface__notice" role="status">
          Mostrando {overlay.nodes.length.toLocaleString("es-AR")} de {overlay.inView.toLocaleString("es-AR")} nodos en pantalla ({overlay.total.toLocaleString("es-AR")} en total). Acercá el zoom para ver y editar el resto.
        </p>
      )}
    </div>
  );
}
