import { memo, useCallback } from "react";
import { Group, Path } from "react-konva";
import type Konva from "konva";
import { matrixToKonvaProps } from "../../lib/editor/matrix";
import { isUnfilled } from "../../lib/editor/objects";
import type { EditorObject } from "../../lib/editor/types";

const LAYER_HIGHLIGHT_STROKE = "#3a5cf5";
const LAYER_HIGHLIGHT_WIDTH_PX = 2;

interface EditorPathNodeProps {
  object: EditorObject;
  highlighted: boolean;
  onRegister: (id: string, node: Konva.Path | null) => void;
}

/**
 * Un `<Path>` de Konva por objeto (ADR D3), memoizado POR OBJETO: los objetos
 * son inmutables y las operaciones conservan la referencia de los que no
 * cambian, así que un drag solo re-renderiza los objetos arrastrados -- el
 * resto del documento (miles de paths) no se toca por frame.
 *
 * `listening={false}`: todo el hit-testing del editor es geométrico
 * (`lib/editor/objects.ts: hitTest`, exacto y con tolerancia en px de
 * pantalla), no el del hit-canvas de Konva -- así Konva no dibuja un hit-canvas
 * de miles de paths y Alt+click puede recorrer toda la pila de superpuestos.
 */
const EditorPathNode = memo(function EditorPathNode({ object, highlighted, onRegister }: EditorPathNodeProps) {
  const register = useCallback((node: Konva.Path | null) => onRegister(object.id, node), [object.id, onRegister]);
  const props = matrixToKonvaProps(object.matrix);
  // `fill: "none"` (líneas abiertas de Draw, M3-S04) NO es un color de canvas: asignarlo a fillStyle se ignora y dejaría el negro por defecto.
  const filled = !isUnfilled(object.fill);
  const hasOwnStroke = !highlighted && object.stroke !== undefined && (object.strokeWidth ?? 0) > 0;

  return (
    <Path
      ref={register}
      data={object.d}
      fill={filled ? object.fill : undefined}
      x={props.x}
      y={props.y}
      rotation={props.rotation}
      scaleX={props.scaleX}
      scaleY={props.scaleY}
      skewX={props.skewX}
      stroke={highlighted ? LAYER_HIGHLIGHT_STROKE : hasOwnStroke ? object.stroke : undefined}
      strokeWidth={highlighted ? LAYER_HIGHLIGHT_WIDTH_PX : hasOwnStroke ? object.strokeWidth : 0}
      // El trazo propio vive en unidades de documento (escala con el zoom y con la matriz); solo el resaltado de capa mide px de pantalla.
      strokeScaleEnabled={hasOwnStroke}
      lineCap={hasOwnStroke ? "round" : undefined}
      lineJoin={hasOwnStroke ? "round" : undefined}
      listening={false}
      perfectDrawEnabled={false}
    />
  );
});

interface EditorLayerNodesProps {
  groupId: string;
  locked: boolean;
  objects: readonly EditorObject[];
  /** Capa seleccionada desde el panel de capas (M2.1): contorno azul en todos sus paths. */
  highlighted: boolean;
  onRegister: (id: string, node: Konva.Path | null) => void;
}

/** Grupo Konva de una capa. Memoizado por (array de objetos, highlighted, locked): cambiar la selección u otra capa no lo re-renderiza. */
export const EditorLayerNodes = memo(function EditorLayerNodes({ groupId, locked, objects, highlighted, onRegister }: EditorLayerNodesProps) {
  return (
    // Lock (M2.1-S07/M3-S01): una capa bloqueada sigue siendo visible y seleccionable (para inspeccionar),
    // pero ninguna herramienta la modifica -- eso lo aplican `useEditableDocument.applyEdit` y el canvas
    // (que además informa al usuario); acá solo queda la marca de clase.
    <Group name={`vector-canvas-layer-group${locked ? " vector-canvas-layer-group--locked" : ""}`} id={`layer-${groupId}`} listening={false}>
      {objects.map((object) => (
        <EditorPathNode key={object.id} object={object} highlighted={highlighted} onRegister={onRegister} />
      ))}
    </Group>
  );
});
