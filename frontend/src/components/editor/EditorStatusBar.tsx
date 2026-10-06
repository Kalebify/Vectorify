import { formatDisplayNumber } from "../../lib/editor/units";

const ZOOM_BUTTON_FACTOR = 1.25;

interface EditorStatusBarProps {
  scale: number;
  onZoomBy: (factor: number) => void;
  onFit: () => void;
  /** Tamaño del ÁREA DE TRABAJO vigente en unidades de documento (M3-S02: cambia con Crop y con Rotate 90° del documento). */
  sourceWidthPx: number;
  sourceHeightPx: number;
  /** Tamaño físico del área de trabajo en mm (`ancho * mmPerUnit`), o ausente si el documento no tiene escala física conocida. */
  widthMm?: number | null;
  heightMm?: number | null;
}

/**
 * Barra inferior del wireframe obligatorio: "− 68% + │ FIT │ ... │ 210 ×
 * 297 mm │ GRID │ SNAP". `PaletteBar` (swatches) se renderiza aparte en el
 * mismo `<footer>` de `EditorShell` -- acá van zoom/fit/dimensiones/grid-snap.
 *
 * Dimensiones: se muestran en PX (tamaño interno real del SVG, siempre
 * disponible desde `VectorDocument`) y, SOLO si el documento tiene escala
 * física conocida (M3-S01: `mmPerUnit`), también en mm -- mostrar "210 × 297 mm"
 * sin que el proyecto tenga dimensiones aplicadas (M1-S09) sería un dato
 * inventado (spec.md, DoD: "no hay datos falsos"). Desde M3-S02 son las del
 * ÁREA DE TRABAJO vigente: un Crop o un giro de 90° del documento las cambia.
 */
export function EditorStatusBar({ scale, onZoomBy, onFit, sourceWidthPx, sourceHeightPx, widthMm = null, heightMm = null }: EditorStatusBarProps) {
  const zoomPercent = Math.round(scale * 100);
  const hasPhysicalSize = widthMm !== null && heightMm !== null;

  return (
    <div className="editor-status-bar" role="group" aria-label="Controles de zoom y documento">
      <div className="editor-status-bar__zoom">
        <button
          type="button"
          className="editor-status-bar__button"
          aria-label="Alejar"
          title="Alejar (-)"
          onClick={() => onZoomBy(1 / ZOOM_BUTTON_FACTOR)}
        >
          −
        </button>
        <span className="editor-status-bar__zoom-value" aria-label={`Zoom actual: ${zoomPercent}%`}>
          {zoomPercent}%
        </span>
        <button
          type="button"
          className="editor-status-bar__button"
          aria-label="Acercar"
          title="Acercar (+)"
          onClick={() => onZoomBy(ZOOM_BUTTON_FACTOR)}
        >
          +
        </button>
      </div>

      <button type="button" className="editor-status-bar__button editor-status-bar__fit" onClick={onFit} title="Ajustar el documento completo a la pantalla">
        FIT
      </button>

      {hasPhysicalSize && (
        <span
          className="editor-status-bar__dimensions"
          aria-label={`Tamaño físico del área de trabajo: ${formatDisplayNumber(widthMm, 2)} por ${formatDisplayNumber(heightMm, 2)} milímetros`}
        >
          {formatDisplayNumber(widthMm, 2)} × {formatDisplayNumber(heightMm, 2)} mm
        </span>
      )}
      <span className="editor-status-bar__dimensions" aria-label={`Tamaño del documento: ${formatDisplayNumber(sourceWidthPx, 2)} por ${formatDisplayNumber(sourceHeightPx, 2)} píxeles`}>
        {formatDisplayNumber(sourceWidthPx, 2)} × {formatDisplayNumber(sourceHeightPx, 2)} px
      </span>

      <button
        type="button"
        className="editor-status-bar__button editor-status-bar__placeholder"
        disabled
        aria-label="Grilla (llega en MVP3)"
        title="Grilla — llega en MVP3"
      >
        GRID
      </button>
      <button
        type="button"
        className="editor-status-bar__button editor-status-bar__placeholder"
        disabled
        aria-label="Ajuste a grilla (llega en MVP3)"
        title="Snap — llega en MVP3"
      >
        SNAP
      </button>
    </div>
  );
}
