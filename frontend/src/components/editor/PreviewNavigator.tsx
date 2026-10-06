import type { CanvasTransform } from "../../hooks/useCanvasTransform";
import type { VectorDocumentLayer } from "../../hooks/useVectorDocument";

interface PreviewNavigatorProps {
  layers: VectorDocumentLayer[];
  visibility: Record<string, boolean>;
  /** Tamaño del ÁREA DE TRABAJO confirmada (M3-S02): tras un crop o un giro del documento ya no es el viewBox original. */
  sourceWidthPx: number;
  sourceHeightPx: number;
  /** Transform vigente del VectorCanvas principal -- para dibujar el rectángulo de viewport (qué porción del documento se ve ahora mismo). */
  transform: CanvasTransform;
  /** Tamaño en pantalla del contenedor del VectorCanvas principal (mismo `onMeasure` que alimenta fitToScreen). */
  viewportSize: { width: number; height: number };
  /**
   * groupId -> data URL del SVG de la capa YA EDITADA (M3-S01): la miniatura sigue mostrando el `svgUrl` original de
   * las capas intactas, pero una capa con ediciones de geometría sin persistir se dibuja desde su estado en memoria
   * (si no, la miniatura mostraría el documento anterior a las ediciones).
   */
  layerImageOverrides?: Record<string, string>;
}

/**
 * "PREVIEW" del wireframe obligatorio (columna derecha, arriba de LAYERS):
 * miniatura del documento completo con un rectángulo indicando qué porción
 * se ve ahora mismo en el VectorCanvas principal. Reusa el MISMO patrón que
 * `components/layers/LayerCanvas.tsx` (M2-S02) -- apilar un `<img>` por capa
 * visible, alineados por compartir el mismo sistema de coordenadas -- en vez
 * de un segundo parser de paths Konva: acá no hace falta interactividad
 * real, así que rasterizar el SVG en un `<img>` chico es más simple y sigue
 * el mismo criterio de "defensa en profundidad" (nunca SVG inline +
 * dangerouslySetInnerHTML) que el resto del visualizador.
 */
export function PreviewNavigator({ layers, visibility, sourceWidthPx, sourceHeightPx, transform, viewportSize, layerImageOverrides }: PreviewNavigatorProps) {
  const visibleLayers = layers.filter((layer) => visibility[layer.groupId] ?? true);
  const hasDocumentSize = sourceWidthPx > 0 && sourceHeightPx > 0;

  // Rectángulo de viewport: inversa de la transform que aplica VectorCanvas
  // (ver docstring de VectorCanvas.tsx) -- convierte las 4 esquinas del
  // contenedor en pantalla a coordenadas del documento, y esas a % del
  // tamaño del documento (para posicionar el rectángulo dentro de esta
  // miniatura sin importar su tamaño real en pantalla).
  const canComputeViewport = hasDocumentSize && viewportSize.width > 0 && viewportSize.height > 0 && transform.scale > 0;

  let viewportStyle: { left: string; top: string; width: string; height: string } | null = null;
  if (canComputeViewport) {
    const docLeft = (-viewportSize.width / 2 - transform.panX) / transform.scale + sourceWidthPx / 2;
    const docRight = (viewportSize.width / 2 - transform.panX) / transform.scale + sourceWidthPx / 2;
    const docTop = (-viewportSize.height / 2 - transform.panY) / transform.scale + sourceHeightPx / 2;
    const docBottom = (viewportSize.height / 2 - transform.panY) / transform.scale + sourceHeightPx / 2;

    viewportStyle = {
      left: `${(docLeft / sourceWidthPx) * 100}%`,
      top: `${(docTop / sourceHeightPx) * 100}%`,
      width: `${((docRight - docLeft) / sourceWidthPx) * 100}%`,
      height: `${((docBottom - docTop) / sourceHeightPx) * 100}%`,
    };
  }

  return (
    <section aria-labelledby="preview-navigator-heading" className="preview-navigator">
      <h3 id="preview-navigator-heading" className="editor-panel__heading">
        Preview
      </h3>

      {!hasDocumentSize || layers.length === 0 ? (
        <p className="editor-panel__empty">Sin documento para previsualizar todavía.</p>
      ) : (
        <div
          className="preview-navigator__frame"
          style={{ aspectRatio: `${sourceWidthPx} / ${sourceHeightPx}` }}
          role="img"
          aria-label={`Miniatura del documento completo, ${visibleLayers.length} de ${layers.length} capas visibles`}
        >
          {visibleLayers.map((layer) => (
            <img
              key={layer.groupId}
              src={layerImageOverrides?.[layer.groupId] ?? layer.svgUrl}
              alt=""
              aria-hidden="true"
              className="preview-navigator__layer"
              width={sourceWidthPx}
              height={sourceHeightPx}
              loading="lazy"
            />
          ))}

          {viewportStyle && (
            <div className="preview-navigator__viewport" style={viewportStyle} aria-hidden="true" />
          )}
        </div>
      )}
    </section>
  );
}
