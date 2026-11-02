import { useState } from "react";
import type { MouseEvent } from "react";
import type { BackgroundCorrection } from "../../types/colorPalette";

interface BackgroundRegionEditorProps {
  fileName: string;
  originalUrl: string;
  /** Tamaño de la imagen original en píxeles: el sistema de coordenadas de las zonas. */
  widthPx: number;
  heightPx: number;
  corrections: BackgroundCorrection[];
  /** Las zonas ya aplicadas a la paleta que se está mostrando (para avisar de las pendientes). */
  appliedCorrections: BackgroundCorrection[];
  disabled: boolean;
  onAdd: (points: [number, number][]) => void;
  onRemove: (index: number) => void;
  onApply: () => void;
}

const MIN_VERTICES = 3;

function sameCorrections(a: BackgroundCorrection[], b: BackgroundCorrection[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Corrección manual del fondo: la persona dibuja sobre la imagen ORIGINAL el contorno de una zona que NO es fondo
 * (un blanco del dibujo que se funde con el fondo sin borde distinguible). Nada se aplica hasta «Aplicar zonas y
 * detectar de nuevo»: los píxeles de fondo dentro de la zona pasan a su familia por su propio color; el resto de la
 * imagen no cambia. Las coordenadas son píxeles de la imagen original (0..ancho, 0..alto).
 */
export function BackgroundRegionEditor({
  fileName,
  originalUrl,
  widthPx,
  heightPx,
  corrections,
  appliedCorrections,
  disabled,
  onAdd,
  onRemove,
  onApply,
}: BackgroundRegionEditorProps) {
  const [drawing, setDrawing] = useState(false);
  const [draft, setDraft] = useState<[number, number][]>([]);

  const pendingChanges = !sameCorrections(corrections, appliedCorrections);

  function toImagePoint(event: MouseEvent<SVGSVGElement>): [number, number] {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = rect.width > 0 ? ((event.clientX - rect.left) / rect.width) * widthPx : event.clientX;
    const y = rect.height > 0 ? ((event.clientY - rect.top) / rect.height) * heightPx : event.clientY;
    const clamp = (value: number, max: number) => Math.min(max, Math.max(0, Math.round(value * 10) / 10));
    return [clamp(x, widthPx), clamp(y, heightPx)];
  }

  function closeZone() {
    if (draft.length < MIN_VERTICES) {
      return;
    }
    onAdd(draft);
    setDraft([]);
    setDrawing(false);
  }

  function cancel() {
    setDraft([]);
    setDrawing(false);
  }

  const toPolygon = (points: [number, number][]) => points.map(([x, y]) => `${x},${y}`).join(" ");

  return (
    <div className="color-palette-regions">
      <h4>Corregir el fondo</h4>
      <p>
        Si una zona blanca del dibujo se funde con el fondo y no tiene borde, el color solo no puede separarla. Dibujá su
        contorno sobre la imagen original: esa zona deja de ser fondo y pasa a su familia por su color. Nada cambia hasta
        que apliques las zonas.
      </p>

      <figure className="color-palette-regions__canvas">
        <img src={originalUrl} alt={`Imagen original de ${fileName} para marcar zonas que no son fondo`} width={widthPx} height={heightPx} />
        <svg
          className={`color-palette-regions__overlay${drawing ? " color-palette-regions__overlay--drawing" : ""}`}
          viewBox={`0 0 ${widthPx} ${heightPx}`}
          preserveAspectRatio="none"
          role="img"
          aria-label="Zonas marcadas como no fondo"
          onClick={(event) => {
            if (drawing && !disabled) {
              const point = toImagePoint(event);
              setDraft((current) => [...current, point]);
            }
          }}
        >
          {corrections.map((region, index) => (
            <polygon key={index} className="color-palette-regions__zone" points={toPolygon(region.points)} />
          ))}
          {draft.length > 0 && <polyline className="color-palette-regions__draft" points={toPolygon(draft)} fill="none" />}
          {draft.map(([x, y], index) => (
            <circle key={index} className="color-palette-regions__vertex" cx={x} cy={y} r={Math.max(widthPx, heightPx) / 150} />
          ))}
        </svg>
      </figure>

      <div className="color-palette-regions__actions">
        {!drawing ? (
          <button
            type="button"
            className="upload-actions__button"
            disabled={disabled || corrections.length >= 32}
            onClick={() => setDrawing(true)}
          >
            Marcar zona que NO es fondo
          </button>
        ) : (
          <>
            <button type="button" className="upload-actions__button" disabled={draft.length < MIN_VERTICES} onClick={closeZone}>
              Cerrar zona ({draft.length} vértices)
            </button>
            <button
              type="button"
              className="upload-actions__button"
              disabled={draft.length === 0}
              onClick={() => setDraft((current) => current.slice(0, -1))}
            >
              Deshacer vértice
            </button>
            <button type="button" className="upload-actions__button" onClick={cancel}>
              Cancelar
            </button>
          </>
        )}
      </div>
      {drawing && (
        <p className="color-palette-regions__hint" role="status">
          Hacé clic sobre la imagen para ir poniendo los vértices (mínimo {MIN_VERTICES}) y cerrá la zona.
        </p>
      )}

      {corrections.length > 0 && (
        <ul className="color-palette-regions__list" aria-label="Zonas marcadas como no fondo">
          {corrections.map((region, index) => (
            <li key={index}>
              <span>
                Zona {index + 1} · {region.points.length} vértices
              </span>
              <button type="button" className="upload-actions__button" disabled={disabled} onClick={() => onRemove(index)}>
                Quitar zona {index + 1}
              </button>
            </li>
          ))}
        </ul>
      )}

      {pendingChanges && (
        <p role="status" className="color-palette-regions__pending">
          Hay zonas sin aplicar: la paleta de arriba todavía no las refleja.
        </p>
      )}
      <button
        type="button"
        className="upload-actions__button upload-actions__button--primary"
        disabled={disabled || !pendingChanges}
        onClick={onApply}
      >
        Aplicar zonas y detectar de nuevo
      </button>
    </div>
  );
}
