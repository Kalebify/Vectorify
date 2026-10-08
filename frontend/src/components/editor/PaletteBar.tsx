import type { VectorDocumentLayer } from "../../hooks/useVectorDocument";

interface PaletteBarProps {
  layers: VectorDocumentLayer[];
  selectedGroupId: string | null;
  onSelectGroup: (groupId: string) => void;
  /** Capa a la que remite el COLOR ACTIVO de Fill/Recolor/Eyedropper (M3-S03), si la hay: se marca aparte de la capa seleccionada. */
  activeColorGroupId?: string | null;
  /** Nombre accesible del grupo (default: la paleta del documento). El panel de color reutiliza esta barra como selector de color. */
  ariaLabel?: string;
  /** Nombre accesible de cada swatch (default: "Seleccionar el color X (#hex)"). */
  swatchLabel?: (layer: VectorDocumentLayer) => string;
  /** Muestra el "[+]" del wireframe (deshabilitado). Default true. */
  showAdd?: boolean;
}

/**
 * Barra de swatches de la paleta CONFIRMADA, en la barra inferior del
 * wireframe obligatorio ("🔵 🟡 🔴 ⚫ [+]") -- explícitamente DISTINTA de
 * `ColorPalettePanel` (detección/edición de paleta, M2-S01/M2.1-S02): acá
 * solo se puede seleccionar un color (mismo `groupId` COMPARTIDO que el
 * resto del Workspace -- VectorCanvas/EditorLayersPanel/InspectorPanel),
 * nunca fusionar/renombrar/excluir. El "[+]" del wireframe (agregar un color
 * nuevo a la paleta) queda deshabilitado: eso es una operación de
 * detección/edición de paleta, no de este panel (spec.md, "Fuera de
 * alcance" de esta tarjeta -- ni Fill ni Color son reales acá todavía).
 *
 * M3-S03: dibuja la lista EFECTIVA de capas del editor, así que una capa creada por Fill con un color nuevo (`isNew`, borde punteado y
 * "capa nueva" en su nombre accesible) o recoloreada aparece/cambia al instante; marca además la capa del color activo.
 */
export function PaletteBar({ layers, selectedGroupId, onSelectGroup, activeColorGroupId = null, ariaLabel = "Paleta confirmada del documento", swatchLabel, showAdd = true }: PaletteBarProps) {
  return (
    <div className="palette-bar" role="group" aria-label={ariaLabel}>
      {layers.length === 0 ? (
        <span className="palette-bar__empty">Sin paleta confirmada</span>
      ) : (
        <ul className="palette-bar__list">
          {layers.map((layer) => {
            const isSelected = selectedGroupId === layer.groupId;
            const isActiveColor = activeColorGroupId === layer.groupId;
            const label = swatchLabel ? swatchLabel(layer) : `Seleccionar el color ${layer.name} (${layer.colorHex})`;
            return (
              <li key={layer.groupId}>
                <button
                  type="button"
                  className={`palette-bar__swatch${isSelected ? " palette-bar__swatch--selected" : ""}${layer.isNew ? " palette-bar__swatch--new" : ""}${
                    isActiveColor ? " palette-bar__swatch--active-color" : ""
                  }`}
                  style={{ backgroundColor: layer.colorHex }}
                  aria-pressed={isSelected}
                  aria-label={`${label}${layer.isNew ? " (capa nueva)" : ""}${isActiveColor ? " (color activo)" : ""}`}
                  title={`${layer.name} — ${layer.colorHex}${layer.isNew ? " (capa nueva, sin guardar)" : ""}`}
                  onClick={() => onSelectGroup(layer.groupId)}
                >
                  {isSelected && (
                    <span className="palette-bar__swatch-check" aria-hidden="true">
                      ✓
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {showAdd && (
        <button
          type="button"
          className="palette-bar__add"
          disabled
          title="Agregar color a la paleta — llega en MVP3"
          aria-label="Agregar color a la paleta (llega en MVP3)"
        >
          +
        </button>
      )}
    </div>
  );
}
