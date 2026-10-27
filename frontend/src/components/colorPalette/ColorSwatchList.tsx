import { useState } from "react";
import type { ColorGroupPayload } from "../../types/colorPalette";

interface ColorSwatchListProps {
  groups: ColorGroupPayload[];
  selectedGroupIds: string[];
  disabled: boolean;
  onToggleSelection: (groupId: string) => void;
  onRename: (groupId: string, name: string) => void;
  onUnmerge: (groupId: string) => void;
  onSetExclusion: (groupId: string, isExcluded: boolean) => void;
  /**
   * Selección COMPARTIDA con el panel Layers (M2.1-S04) -- explícitamente
   * DISTINTA de `selectedGroupIds` arriba (esa es la selección múltiple para
   * "Fusionar seleccionados"). `selectedLayerGroupId` es la selección
   * ÚNICA de "qué layer estoy inspeccionando ahora mismo", la misma que
   * resalta la fila correspondiente en LayerList y viceversa. Ambos
   * opcionales para que ColorSwatchList siga funcionando sin sincronización
   * cruzada (ej. antes de que exista un LayersPanel para esta paleta).
   */
  selectedLayerGroupId?: string | null;
  onSelectLayerGroup?: (groupId: string) => void;
}

/**
 * Paleta interactiva (spec.md M2-S01, "React"): swatches con color, nombre
 * editable, porcentaje de área aproximada, selección múltiple (checkbox)
 * para fusionar, y acción de deshacer fusión por grupo. Cada swatch es
 * independiente: renombrar uno no afecta la selección de los demás.
 * M2.1-S02: cada swatch suma un toggle incluir/excluir, independiente de la
 * selección para fusionar -- un color puede excluirse sin fusionarlo a otro.
 */
export function ColorSwatchList({
  groups,
  selectedGroupIds,
  disabled,
  onToggleSelection,
  onRename,
  onUnmerge,
  onSetExclusion,
  selectedLayerGroupId,
  onSelectLayerGroup,
}: ColorSwatchListProps) {
  return (
    <ul className="color-swatch-list" aria-label="Colores detectados">
      {groups.map((group) => (
        <ColorSwatchRow
          key={group.groupId}
          group={group}
          selected={selectedGroupIds.includes(group.groupId)}
          disabled={disabled}
          onToggleSelection={onToggleSelection}
          onRename={onRename}
          onUnmerge={onUnmerge}
          onSetExclusion={onSetExclusion}
          isLayerSelected={selectedLayerGroupId === group.groupId}
          onSelectLayerGroup={onSelectLayerGroup}
        />
      ))}
    </ul>
  );
}

interface ColorSwatchRowProps {
  group: ColorGroupPayload;
  selected: boolean;
  disabled: boolean;
  onToggleSelection: (groupId: string) => void;
  onRename: (groupId: string, name: string) => void;
  onUnmerge: (groupId: string) => void;
  onSetExclusion: (groupId: string, isExcluded: boolean) => void;
  isLayerSelected: boolean;
  onSelectLayerGroup?: (groupId: string) => void;
}

function ColorSwatchRow({
  group,
  selected,
  disabled,
  onToggleSelection,
  onRename,
  onUnmerge,
  onSetExclusion,
  isLayerSelected,
  onSelectLayerGroup,
}: ColorSwatchRowProps) {
  const [draftName, setDraftName] = useState(group.name);

  // El nombre del grupo puede cambiar por fuera (otra edición trajo una
  // versión nueva de la paleta con el mismo GroupId, ej. tras confirmar) --
  // se resincroniza durante el render (patrón recomendado de React para
  // "ajustar estado cuando cambia una prop", mismo criterio que CheckPanel
  // al cambiar de fuente), no en un efecto.
  const [lastSyncedName, setLastSyncedName] = useState(group.name);
  if (group.name !== lastSyncedName) {
    setLastSyncedName(group.name);
    setDraftName(group.name);
  }

  const commitRename = () => {
    const trimmed = draftName.trim();
    if (trimmed && trimmed !== group.name) {
      onRename(group.groupId, trimmed);
    } else {
      setDraftName(group.name);
    }
  };

  return (
    <li
      className={`color-swatch${isLayerSelected ? " color-swatch--selected" : ""}`}
      aria-label={`Grupo de color ${group.name}`}
    >
      {onSelectLayerGroup && (
        <button
          type="button"
          className="color-swatch__pick"
          style={{ backgroundColor: group.colorHex }}
          aria-pressed={isLayerSelected}
          aria-label={`Seleccionar la capa de ${group.name} (la resalta en el panel Layers)`}
          onClick={() => onSelectLayerGroup(group.groupId)}
        />
      )}

      <label className="color-swatch__select">
        <input
          type="checkbox"
          checked={selected}
          disabled={disabled}
          onChange={() => onToggleSelection(group.groupId)}
          aria-label={`Seleccionar ${group.name} para fusionar`}
        />
        <span
          className="color-swatch__color"
          style={{ backgroundColor: group.colorHex }}
          aria-hidden="true"
          title={group.colorHex}
        />
      </label>

      <input
        id={`color-swatch-name-${group.groupId}`}
        className="color-swatch__name"
        type="text"
        value={draftName}
        disabled={disabled}
        onChange={(event) => setDraftName(event.target.value)}
        onBlur={commitRename}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur();
          }
        }}
        aria-label={`Nombre del grupo ${group.name}`}
      />

      <span className="color-swatch__area">{group.areaPercent.toFixed(1)}%</span>

      <label className="color-swatch__exclusion">
        <input
          type="checkbox"
          checked={group.isExcluded}
          disabled={disabled}
          onChange={(event) => onSetExclusion(group.groupId, event.target.checked)}
          aria-label={`Excluir ${group.name} del corte`}
        />
        {group.isExcluded ? "Excluido" : "Incluido"}
      </label>

      {group.hasPartialAlpha && (
        <span className="color-swatch__badge" title="Parte de este grupo tiene transparencia parcial">
          semi-transparente
        </span>
      )}

      {group.isBackground && (
        <span className="color-swatch__badge" title="Máscara de fondo independiente del color: no cuenta como familia del dibujo">
          Fondo técnico
        </span>
      )}

      {!group.isBackground && (group.pieceCount ?? 0) > 0 && (group.sourceGroupCount ?? 1) > 1 && (
        <span className="color-swatch__meta" title="Una capa puede tener varias piezas desconectadas sin ser una capa duplicada">
          {group.pieceCount} {group.pieceCount === 1 ? "pieza" : "piezas"} · {group.sourceGroupCount} tonos
        </span>
      )}

      {group.isMerged && (
        <button
          type="button"
          className="upload-actions__button color-swatch__unmerge"
          disabled={disabled}
          onClick={() => onUnmerge(group.groupId)}
        >
          Deshacer fusión
        </button>
      )}
    </li>
  );
}
