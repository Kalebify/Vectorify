import { useEffect } from "react";
import { getColorPalettePreviewUrl } from "../../api/colorPaletteApi";
import { API_BASE_URL } from "../../api/httpClient";
import { useColorPalette } from "../../hooks/useColorPalette";
import type { ColorPaletteResponse } from "../../types/colorPalette";
import { BackgroundRegionEditor } from "./BackgroundRegionEditor";
import { ColorSwatchList } from "./ColorSwatchList";

interface ColorPalettePanelProps {
  projectId: string;
  imageId: string;
  fileName: string;
  originalUrl: string;
  originalWidth: number;
  originalHeight: number;
  /**
   * Notifica a quien orquesta (App) cada vez que la última versión vigente
   * de la paleta está confirmada -- M2-S02 (Layers) consume la paleta
   * CONFIRMADA, así que el panel de capas solo puede activarse a partir de
   * este evento. Se llama de nuevo (con la misma paleta) si el componente
   * vuelve a renderizar en estado confirmado -- idempotente del lado de
   * quien escuche, no solo la primera vez.
   */
  onConfirmed?: (palette: ColorPaletteResponse) => void;
  /**
   * Sincronización paleta<->Layers (M2.1-S04): selección COMPARTIDA de
   * "qué layer/color se está inspeccionando ahora", la misma que vive en
   * LayersPanel. Opcionales: sin ellos, la paleta funciona exactamente
   * igual que antes de esta tarjeta (sin resaltado cruzado).
   */
  selectedLayerGroupId?: string | null;
  onSelectLayerGroup?: (groupId: string) => void;
}

const STATUS_LABEL: Record<string, string> = {
  idle: "",
  detecting: "Detectando paleta de colores…",
  ready: "Paleta detectada. Fusioná, renombrá o confirmá los grupos.",
  mutating: "Aplicando cambios…",
  confirmed: "Paleta confirmada: lista como entrada para generar las capas por color.",
  error: "",
};

/**
 * Orquesta el flujo de "Usuario podrá" de spec.md M2-S01: subir/usar una
 * imagen en color, ver la paleta detectada y el número de colores, fusionar
 * colores parecidos, renombrar grupos y confirmar la paleta. Arranca el
 * flujo multicapa operando directamente sobre la imagen original YA subida
 * (M1-S02) -- no depende de ninguna otra etapa del pipeline de MVP1.
 *
 * Agrupación por familias (tarjeta "Agrupar sombras y variantes en colores base"): el usuario elige
 * entre "Colores base" (una capa por familia de color, recomendado para detecciones NUEVAS) y
 * "Conservar tonos y sombras" (cada tono detectado). Cambiar el estilo o sus parámetros no toca la
 * paleta ya detectada: solo se aplica al pulsar "Detectar de nuevo".
 */
export function ColorPalettePanel({
  projectId,
  imageId,
  fileName,
  originalUrl,
  originalWidth,
  originalHeight,
  onConfirmed,
  selectedLayerGroupId,
  onSelectLayerGroup,
}: ColorPalettePanelProps) {
  const {
    status,
    palette,
    tolerance,
    maxColors,
    groupingStyle,
    targetFamilies,
    groupingStrength,
    backgroundCorrections,
    selectedGroupIds,
    errorMessage,
    setTolerance,
    setMaxColors,
    setGroupingStyle,
    setTargetFamilies,
    setGroupingStrength,
    addBackgroundCorrection,
    removeBackgroundCorrection,
    detect,
    toggleGroupSelection,
    clearSelection,
    mergeSelected,
    unmerge,
    rename,
    setExclusion,
    confirm,
  } = useColorPalette(projectId, imageId);

  useEffect(() => {
    if (palette?.isConfirmed) {
      onConfirmed?.(palette);
    }
    // Notificar de nuevo con la MISMA `palette` si `onConfirmed` cambia de
    // identidad (ej. el padre re-renderiza con una arrow function inline)
    // es inofensivo: App.tsx solo hace `setConfirmedPalette(palette)`, y
    // asignar el mismo objeto de referencia no dispara un re-render extra.
  }, [palette, onConfirmed]);

  const isBusy = status === "detecting" || status === "mutating";
  const isConfirmed = status === "confirmed";
  const canEdit = palette !== null && !isConfirmed && !isBusy;
  const canMerge = canEdit && selectedGroupIds.length >= 2;
  const canConfirm = canEdit && palette !== null && palette.groups.length > 0;
  const isFamilyStyle = groupingStyle === "base_colors";
  const paletteIsFamilies = palette?.groupingStyle === "base_colors";
  const backgroundGroup = palette?.groups.find((group) => group.isBackground) ?? null;
  const background = palette?.background ?? null;

  const previewUrl = palette ? `${getColorPalettePreviewUrl(projectId, imageId, palette.paletteId)}?v=${palette.version}` : null;
  const backgroundMaskUrl = backgroundGroup ? new URL(backgroundGroup.maskUrl, `${API_BASE_URL}/`).toString() : null;

  return (
    <div className="color-palette-panel">
      <div className="color-palette-controls">
        <fieldset className="color-palette-controls__row color-palette-style" disabled={isBusy || isConfirmed}>
          <legend>Estilo de agrupación</legend>
          <label className="color-palette-style__option">
            <input
              type="radio"
              name={`color-palette-style-${projectId}-${imageId}`}
              checked={isFamilyStyle}
              onChange={() => setGroupingStyle("base_colors")}
            />
            <span>
              <strong>Colores base</strong> <span className="color-palette-style__badge">Recomendado</span>
              <small>Reúne luces y sombras de un mismo color en una sola capa por familia, antes de vectorizar.</small>
            </span>
          </label>
          <label className="color-palette-style__option">
            <input
              type="radio"
              name={`color-palette-style-${projectId}-${imageId}`}
              checked={!isFamilyStyle}
              onChange={() => setGroupingStyle("detailed")}
            />
            <span>
              <strong>Conservar tonos y sombras</strong>
              <small>Mantiene cada tono detectado como grupo independiente (útil si las gradaciones importan).</small>
            </span>
          </label>
        </fieldset>

        <div className="color-palette-controls__row">
          <div className="color-palette-controls__label-row">
            <label htmlFor="color-palette-tolerance">Tolerancia</label>
            <span className="color-palette-controls__value">{tolerance}</span>
          </div>
          <input
            id="color-palette-tolerance"
            type="range"
            min={0}
            max={100}
            step={1}
            value={tolerance}
            disabled={isBusy}
            onChange={(event) => setTolerance(Number(event.target.value))}
          />
        </div>

        {isFamilyStyle ? (
          <>
            <div className="color-palette-controls__row">
              <label htmlFor="color-palette-target-families">Objetivo de familias (opcional)</label>
              <input
                id="color-palette-target-families"
                type="number"
                min={1}
                max={16}
                value={targetFamilies ?? ""}
                disabled={isBusy}
                placeholder="Automático"
                onChange={(event) => {
                  const raw = event.target.value;
                  setTargetFamilies(raw === "" ? null : Number(raw));
                }}
              />
              <small>Es un tope, no una cuota: nunca se inventan familias que la imagen no tiene.</small>
            </div>

            <div className="color-palette-controls__row">
              <div className="color-palette-controls__label-row">
                <label htmlFor="color-palette-grouping-strength">Intensidad de agrupación</label>
                <span className="color-palette-controls__value">{Math.round(groupingStrength * 100)}%</span>
              </div>
              <input
                id="color-palette-grouping-strength"
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={groupingStrength}
                disabled={isBusy}
                onChange={(event) => setGroupingStrength(Number(event.target.value))}
              />
              <small>
                Más alta fusiona sombras más distintas en la misma familia; más baja conserva diferencias intencionales
                (pasteles, tonos cercanos).
              </small>
            </div>
          </>
        ) : (
          <div className="color-palette-controls__row">
            <label htmlFor="color-palette-max-colors">Número máximo de colores (opcional)</label>
            <input
              id="color-palette-max-colors"
              type="number"
              min={1}
              max={64}
              value={maxColors ?? ""}
              disabled={isBusy}
              placeholder="Sin límite"
              onChange={(event) => {
                const raw = event.target.value;
                setMaxColors(raw === "" ? null : Number(raw));
              }}
            />
          </div>
        )}

        <div className="color-palette-controls__footer">
          <button
            type="button"
            className="upload-actions__button upload-actions__button--primary"
            onClick={detect}
            disabled={isBusy || isConfirmed}
          >
            {palette ? "Detectar de nuevo" : "Detectar paleta"}
          </button>
          <span className="color-palette-controls__status" role="status">
            {STATUS_LABEL[status]}
          </span>
        </div>
      </div>

      {status === "error" && errorMessage && (
        <p className="upload-panel__error" role="alert">
          {errorMessage}
        </p>
      )}

      {palette && (
        <>
          <dl className="service-card__details color-palette-panel__summary">
            {paletteIsFamilies ? (
              <>
                <div>
                  <dt>Familias del dibujo</dt>
                  <dd>{palette.familyCount ?? palette.groups.filter((group) => !group.isBackground).length}</dd>
                </div>
                <div>
                  <dt>Piezas</dt>
                  <dd>{palette.pieceCount ?? 0}</dd>
                </div>
              </>
            ) : (
              <div>
                <dt>Colores detectados</dt>
                <dd>{palette.groups.length}</dd>
              </div>
            )}
            <div>
              <dt>Transparencia</dt>
              <dd>{palette.transparentPercent.toFixed(1)}%</dd>
            </div>
            <div>
              <dt>Estado</dt>
              <dd>{palette.isConfirmed ? "Confirmada" : "Editable"}</dd>
            </div>
          </dl>

          <div className="color-palette-comparison">
            <figure className="color-palette-comparison__item">
              <img src={originalUrl} alt={`Imagen original de ${fileName}`} width={originalWidth} height={originalHeight} loading="lazy" />
              <figcaption>Original</figcaption>
            </figure>
            <figure className="color-palette-comparison__item">
              {previewUrl && (
                <img
                  src={previewUrl}
                  alt={`Preview cuantizado de ${fileName} con los colores agrupados`}
                  width={palette.sourceWidthPx}
                  height={palette.sourceHeightPx}
                  loading="lazy"
                />
              )}
              <figcaption>{paletteIsFamilies ? "Resultado agrupado por familias" : "Preview cuantizado"}</figcaption>
            </figure>
          </div>

          {paletteIsFamilies && background && (
            <section className="color-palette-background" aria-label="Revisión del fondo">
              <h3>Fondo</h3>
              <p>
                Se considera fondo el {background.areaPercent.toFixed(1)}% del lienzo (grupo técnico: no cuenta como
                familia del dibujo). Los blancos interiores, como los ojos, se conservan en su familia. Podés incluir el
                fondo como capa con el control «Excluido/Incluido» de su fila.
              </p>
              {background.needsReview && (
                <p role="alert" className="color-palette-background__warning">
                  Revisá el fondo: hay zonas claras ({background.contactPercent.toFixed(1)}% del lienzo) en contacto con
                  el fondo
                  {background.ambiguousPercent > 0
                    ? ` y ${background.ambiguousPercent.toFixed(2)}% conectado solo por un cuello estrecho`
                    : ""}
                  . Si no existe un borde distinguible en la imagen original, no se puede garantizar la separación exacta
                  solo por color; las zonas dudosas se conservaron en su familia en vez de borrarse.
                </p>
              )}
              {backgroundMaskUrl && (
                <figure className="color-palette-comparison__item color-palette-background__mask">
                  <img src={backgroundMaskUrl} alt={`Máscara del fondo de ${fileName} (blanco = fondo)`} loading="lazy" />
                  <figcaption>Máscara del fondo</figcaption>
                </figure>
              )}
              <BackgroundRegionEditor
                fileName={fileName}
                originalUrl={originalUrl}
                widthPx={palette.sourceWidthPx}
                heightPx={palette.sourceHeightPx}
                corrections={backgroundCorrections}
                appliedCorrections={palette.backgroundCorrections ?? []}
                disabled={isBusy || isConfirmed}
                onAdd={addBackgroundCorrection}
                onRemove={removeBackgroundCorrection}
                onApply={detect}
              />
            </section>
          )}

          <ColorSwatchList
            groups={palette.groups}
            selectedGroupIds={selectedGroupIds}
            disabled={!canEdit}
            onToggleSelection={toggleGroupSelection}
            onRename={rename}
            onUnmerge={unmerge}
            onSetExclusion={setExclusion}
            selectedLayerGroupId={selectedLayerGroupId}
            onSelectLayerGroup={onSelectLayerGroup}
          />

          <div className="color-palette-panel__actions">
            <button
              type="button"
              className="upload-actions__button"
              onClick={() => mergeSelected()}
              disabled={!canMerge}
            >
              Fusionar seleccionados ({selectedGroupIds.length})
            </button>
            <button
              type="button"
              className="upload-actions__button"
              onClick={clearSelection}
              disabled={!canEdit || selectedGroupIds.length === 0}
            >
              Limpiar selección
            </button>
            <button
              type="button"
              className="upload-actions__button upload-actions__button--primary"
              onClick={confirm}
              disabled={!canConfirm}
            >
              Confirmar paleta
            </button>
          </div>
        </>
      )}

      {status === "idle" && (
        <p className="color-palette-panel__hint">
          Pulsá &quot;Detectar paleta&quot; para agrupar los colores de la imagen original. Elegí el estilo de
          agrupación, ajustá la tolerancia y, en Colores base, el objetivo de familias y la intensidad antes de
          detectar; después podés fusionar/renombrar grupos.
        </p>
      )}
    </div>
  );
}
