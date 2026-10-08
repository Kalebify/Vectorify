import { useState } from "react";
import type { DragEvent } from "react";
import type { VectorDocumentLayer } from "../../hooks/useVectorDocument";
import { OPERATION_LABEL } from "../layers/manufacturingOperationLabels";
import type { ManufacturingOperationChoice, ManufacturingOperationPayload } from "../../types/manufacturingOperations";

interface EditorLayersPanelProps {
  layers: VectorDocumentLayer[];
  visibility: Record<string, boolean>;
  onToggleVisibility: (groupId: string) => void;
  onToggleLocked: (groupId: string) => void;
  /** Nuevo orden visual COMPLETO (Drag & Drop, M2.1-S07) -- ver useVectorDocument.reorderLayers. NUNCA toca geometría. */
  onReorder: (orderedGroupIds: string[]) => void;
  selectedGroupId: string | null;
  onSelectGroup: (groupId: string) => void;
  /** Rename inline (fix round M2.1-S07): cambia el NOMBRE, nunca el GroupId -- ver useVectorDocument.renameLayer. */
  onRename: (groupId: string, name: string) => void;
  /** groupId -> intención de fabricación vigente (M2-S07/MVP2, ver useManufacturingOperations) -- "unassigned" para las capas que nunca recibieron una asignación explícita. */
  operations: Record<string, ManufacturingOperationPayload>;
  onChangeOperation: (groupId: string, operation: ManufacturingOperationChoice) => void;
  /** groupId de la capa cuya operación se está guardando, para deshabilitar su selector mientras la request está en curso. */
  mutatingGroupId: string | null;
}

/**
 * "LayersPanel" del wireframe obligatorio (columna derecha, sección LAYERS:
 * "👁 🔵 Blue 🔒", "+ ADD LAYER"). Spec.md: "ya existe, adaptar al panel
 * derecho" -- pero el `LayersPanel` YA EXISTENTE
 * (`components/layers/LayersPanel.tsx`) es el panel MONOLÍTICO de M2-S02..
 * M2.1-S04 (orquesta exploded view, component groups, physical union, modo
 * de comparación, SU PROPIO canvas de `<img>`...): montarlo tal cual acá
 * duplicaría el Canvas (el suyo, basado en `<img>`, contra el `VectorCanvas`
 * nuevo de Konva) y el Inspector (su `LayerInfoPanel` interno, contra
 * `InspectorPanel`). En vez de eso, este componente es la adaptación al
 * layout nuevo: reusa `LayerList`-como-patrón (mismo swatch/nombre/checkbox
 * de visibilidad) pero data-driven por `VectorDocument` (la fuente de
 * verdad ÚNICA de este sprint), consistente con "el estado de dominio no
 * debe quedar atrapado dentro de componentes visuales" (spec.md,
 * Arquitectura frontend). El componente monolítico anterior sigue existiendo
 * intacto y se sigue usando en el flujo clásico de App.tsx (ver IMPL.md,
 * "Ambigüedades resueltas").
 *
 * M2.1-S07: Lock (concepto NUEVO) deja de ser un ícono estático "llega en
 * MVP3" -- ahora es un toggle real y persistido (ver useVectorDocument.
 * toggleLocked), y cada fila es arrastrable (Drag & Drop nativo de HTML5,
 * sin agregar ninguna librería) para reordenar -- el nuevo orden se persiste
 * vía `onReorder`, NUNCA toca `d`/`transform`/geometría.
 *
 * M2.1-S07, ronda de fix: el nombre y la operación de fabricación eran
 * `<span>` de solo lectura -- spec.md pedía explícitamente "Rename → cambiar
 * nombre, no id" y el selector Corte/Grabado/Ignorar como comportamiento del
 * Workspace, pero nadie los conectó a una UI de edición real (ver IMPL.md,
 * "Ronda de fix 1"). Ahora cada fila reusa EXACTAMENTE el mismo patrón que
 * `ColorSwatchRow` (input de texto con commit a blur/Enter) para el nombre y
 * el mismo `<select>` que `LayerList` para la operación -- ambos
 * DESHABILITADOS si la capa está bloqueada (Lock), mismo criterio que el
 * resto de los controles de edición de esta fila. Rename persiste vía el
 * sidecar `LayerLayout` (no `ColorPaletteService.RenameAsync`, que rechaza
 * con 409 en cuanto la paleta está confirmada) -- ver IMPL-fix-round-1.md,
 * "Ronda de fix 2".
 *
 * M3-S03: la lista es la EFECTIVA del editor (servidor + capas creadas por Fill con un color nuevo + colores recoloreados). Una capa creada
 * en el cliente (`isNew`) lleva la insignia "nueva" (todavía no existe en el servidor: sus cambios de nombre, visibilidad, bloqueo, orden y
 * operación se aplican en local, sin PATCH -- el shell las resuelve; este panel no distingue).
 *
 * "+ ADD LAYER" del wireframe queda deshabilitado: crear una capa nueva
 * desde cero (no derivada de un color detectado) es una herramienta de
 * edición real, fuera de alcance de esta tarjeta (spec.md, "Fuera de
 * alcance").
 */
export function EditorLayersPanel({
  layers,
  visibility,
  onToggleVisibility,
  onToggleLocked,
  onReorder,
  selectedGroupId,
  onSelectGroup,
  onRename,
  operations,
  onChangeOperation,
  mutatingGroupId,
}: EditorLayersPanelProps) {
  const [draggedGroupId, setDraggedGroupId] = useState<string | null>(null);
  const [dragOverGroupId, setDragOverGroupId] = useState<string | null>(null);

  const handleDragStart = (groupId: string) => (event: DragEvent<HTMLLIElement>) => {
    setDraggedGroupId(groupId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", groupId);
  };

  const handleDragOver = (groupId: string) => (event: DragEvent<HTMLLIElement>) => {
    if (!draggedGroupId || draggedGroupId === groupId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDragOverGroupId(groupId);
  };

  const handleDrop = (targetGroupId: string) => (event: DragEvent<HTMLLIElement>) => {
    event.preventDefault();
    const sourceGroupId = draggedGroupId ?? event.dataTransfer.getData("text/plain");
    setDraggedGroupId(null);
    setDragOverGroupId(null);
    if (!sourceGroupId || sourceGroupId === targetGroupId) return;

    const currentOrder = layers.map((layer) => layer.groupId);
    const withoutSource = currentOrder.filter((groupId) => groupId !== sourceGroupId);
    const targetIndex = withoutSource.indexOf(targetGroupId);
    if (targetIndex === -1) return;

    const nextOrder = [...withoutSource.slice(0, targetIndex), sourceGroupId, ...withoutSource.slice(targetIndex)];
    onReorder(nextOrder);
  };

  const handleDragEnd = () => {
    setDraggedGroupId(null);
    setDragOverGroupId(null);
  };

  return (
    <section aria-labelledby="editor-layers-heading" className="editor-layers-panel">
      <h3 id="editor-layers-heading" className="editor-panel__heading">
        Layers
      </h3>

      {layers.length === 0 ? (
        <p className="editor-panel__empty">Este proyecto todavía no tiene capas generadas.</p>
      ) : (
        <ul className="editor-layers-panel__list" aria-label="Capas del documento (arrastrá para reordenar)">
          {layers.map((layer) => (
            <EditorLayerRow
              key={layer.groupId}
              layer={layer}
              isVisible={visibility[layer.groupId] ?? true}
              isSelected={selectedGroupId === layer.groupId}
              isDragOver={dragOverGroupId === layer.groupId}
              operation={operations[layer.groupId]?.operation ?? layer.manufacturingOperation}
              isMutatingOperation={mutatingGroupId === layer.groupId}
              onToggleVisibility={onToggleVisibility}
              onToggleLocked={onToggleLocked}
              onSelectGroup={onSelectGroup}
              onRename={onRename}
              onChangeOperation={onChangeOperation}
              onDragStart={handleDragStart(layer.groupId)}
              onDragOver={handleDragOver(layer.groupId)}
              onDrop={handleDrop(layer.groupId)}
              onDragEnd={handleDragEnd}
            />
          ))}
        </ul>
      )}

      <button type="button" className="editor-layers-panel__add" disabled title="Agregar capa nueva — llega en MVP3">
        + ADD LAYER
      </button>
    </section>
  );
}

interface EditorLayerRowProps {
  layer: VectorDocumentLayer;
  isVisible: boolean;
  isSelected: boolean;
  isDragOver: boolean;
  operation: ManufacturingOperationPayload["operation"];
  isMutatingOperation: boolean;
  onToggleVisibility: (groupId: string) => void;
  onToggleLocked: (groupId: string) => void;
  onSelectGroup: (groupId: string) => void;
  onRename: (groupId: string, name: string) => void;
  onChangeOperation: (groupId: string, operation: ManufacturingOperationChoice) => void;
  onDragStart: (event: DragEvent<HTMLLIElement>) => void;
  onDragOver: (event: DragEvent<HTMLLIElement>) => void;
  onDrop: (event: DragEvent<HTMLLIElement>) => void;
  onDragEnd: () => void;
}

function EditorLayerRow({
  layer,
  isVisible,
  isSelected,
  isDragOver,
  operation,
  isMutatingOperation,
  onToggleVisibility,
  onToggleLocked,
  onSelectGroup,
  onRename,
  onChangeOperation,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: EditorLayerRowProps) {
  const isLocked = layer.locked;

  // Mismo patrón que ColorSwatchRow (ColorSwatchList.tsx): edición local del
  // nombre en borrador, resincronizada durante el render si el nombre "real"
  // cambió por fuera (ej. tras un reload), commit a blur/Enter.
  const [draftName, setDraftName] = useState(layer.name);
  const [lastSyncedName, setLastSyncedName] = useState(layer.name);
  if (layer.name !== lastSyncedName) {
    setLastSyncedName(layer.name);
    setDraftName(layer.name);
  }

  const commitRename = () => {
    const trimmed = draftName.trim();
    if (trimmed && trimmed !== layer.name) {
      onRename(layer.groupId, trimmed);
    } else {
      setDraftName(layer.name);
    }
  };

  return (
    <li
      className={`editor-layers-panel__row${isSelected ? " editor-layers-panel__row--selected" : ""}${
        isDragOver ? " editor-layers-panel__row--drag-over" : ""
      }`}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
    >
      <button
        type="button"
        className="editor-layers-panel__visibility"
        aria-pressed={isVisible}
        aria-label={`${isVisible ? "Ocultar" : "Mostrar"} la capa ${layer.name}`}
        title={isVisible ? "Ocultar capa" : "Mostrar capa"}
        onClick={() => onToggleVisibility(layer.groupId)}
      >
        <span aria-hidden="true">{isVisible ? "\u{1F441}" : "\u{1F576}"}</span>
      </button>

      <button
        type="button"
        className="editor-layers-panel__select"
        aria-pressed={isSelected}
        aria-label={`Seleccionar la capa ${layer.name}`}
        onClick={() => onSelectGroup(layer.groupId)}
      >
        <span
          className="editor-layers-panel__swatch"
          style={{ backgroundColor: layer.colorHex }}
          aria-hidden="true"
          title={layer.colorHex}
        />
        {isSelected && (
          <span className="editor-layers-panel__selected-badge" aria-hidden="true">
            ✓
          </span>
        )}
      </button>

      {layer.isNew && (
        <span className="editor-layers-panel__new-badge" title="Capa nueva: todavía no está guardada en el servidor (se guarda con la persistencia de geometría)">
          nueva
        </span>
      )}

      <input
        type="text"
        className="editor-layers-panel__name-input"
        value={draftName}
        disabled={isLocked}
        title={isLocked ? "Capa bloqueada: desbloqueala para renombrarla" : undefined}
        onChange={(event) => setDraftName(event.target.value)}
        onBlur={commitRename}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur();
          }
        }}
        aria-label={`Nombre de la capa ${layer.name}`}
      />

      <label className="editor-layers-panel__operation-field">
        <select
          className={`editor-layers-panel__operation editor-layers-panel__operation--${operation}`}
          aria-label={`Operación de fabricación de la capa ${layer.name}`}
          value={operation}
          disabled={isLocked || isMutatingOperation}
          title={isLocked ? "Capa bloqueada: desbloqueala para cambiar su operación" : `Operación de fabricación: ${OPERATION_LABEL[operation]}`}
          onChange={(event) => onChangeOperation(layer.groupId, event.target.value as ManufacturingOperationChoice)}
        >
          <option value="unassigned" disabled hidden>
            Sin asignar
          </option>
          <option value="cut">Corte</option>
          <option value="engrave">Grabado</option>
          <option value="ignore">Ignorar</option>
        </select>
      </label>

      <button
        type="button"
        className="editor-layers-panel__lock"
        aria-pressed={isLocked}
        aria-label={`${isLocked ? "Desbloquear" : "Bloquear"} la capa ${layer.name}`}
        title={isLocked ? "Capa bloqueada: click para desbloquear" : "Bloquear capa (impide editar su geometría)"}
        onClick={() => onToggleLocked(layer.groupId)}
      >
        <span aria-hidden="true">{isLocked ? "\u{1F512}" : "\u{1F513}"}</span>
      </button>
    </li>
  );
}
