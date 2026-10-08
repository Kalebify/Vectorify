import { useId, useMemo, useState } from "react";
import type { VectorDocumentLayer } from "../../hooks/useVectorDocument";
import { matrixRotationDegrees } from "../../lib/editor/matrix";
import { normalizeHex } from "../../lib/editor/colors";
import { groupBounds, proportionalBounds } from "../../lib/editor/transform";
import type { EditorObject, Rect } from "../../lib/editor/types";
import { formatDisplayNumber, fromMm, parseNumericInput, toMm } from "../../lib/editor/units";

type FieldName = "x" | "y" | "width" | "height" | "rotation";

/** Tope de sanidad de un valor tecleado (mm o unidades): evita matrices con magnitudes absurdas que rompan el SVG. */
const MAX_ABS_VALUE = 1_000_000;

interface ObjectInspectorProps {
  /** Objetos seleccionados (orden de pintado), ya depurados contra capas visibles. */
  objects: EditorObject[];
  layers: VectorDocumentLayer[];
  /** mm por unidad de documento (`lib/editor/units.ts`), o null si el documento no tiene dimensiones físicas conocidas: entonces se edita en unidades de documento. */
  mmPerUnit: number | null;
  /** Lleva el bbox de la selección a `target` (espacio de documento). Devuelve un mensaje de error, o null si se aplicó. */
  onApplyBounds: (target: Rect) => string | null;
  /** Rota el objeto único seleccionado hasta `degrees` absolutos. Devuelve un mensaje de error, o null si se aplicó. */
  onRotateTo: (degrees: number) => string | null;
}

/**
 * Sección "Objeto" del Inspector (M3-S01): X, Y, ancho, alto (en mm si el
 * documento tiene dimensiones físicas; si no, en unidades de documento y se
 * dice), rotación y capa de la selección. Multi-selección muestra el bbox del
 * grupo ("Varios"). Edición numérica con Enter/blur -> UN comando; un valor
 * inválido se rechaza con mensaje y no cambia nada. Capa bloqueada: campos
 * deshabilitados con explicación.
 *
 * Toda conversión mm <-> documento pasa por `lib/editor/units.ts` (ADR D1): el
 * estado del editor nunca guarda mm.
 */
export function ObjectInspector({ objects, layers, mmPerUnit, onApplyBounds, onRotateTo }: ObjectInspectorProps) {
  const idPrefix = useId();
  const [drafts, setDrafts] = useState<Partial<Record<FieldName, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [keepRatio, setKeepRatio] = useState(false);

  const selectionKey = useMemo(() => objects.map((object) => object.id).join("|"), [objects]);
  // Una selección nueva descarta borradores a medias y errores de la anterior (patrón "ajustar estado durante el render"
  // de React, sin efecto: evita un render intermedio con el borrador viejo sobre la selección nueva).
  const [seenSelectionKey, setSeenSelectionKey] = useState(selectionKey);
  if (seenSelectionKey !== selectionKey) {
    setSeenSelectionKey(selectionKey);
    setDrafts({});
    setError(null);
  }

  const bounds = useMemo(() => groupBounds(objects), [objects]);
  const isMulti = objects.length > 1;
  const unitLabel = mmPerUnit === null ? "u" : "mm";
  const toDisplay = (units: number) => (mmPerUnit === null ? units : toMm(units, mmPerUnit));
  const fromDisplay = (value: number) => (mmPerUnit === null ? value : fromMm(value, mmPerUnit));

  const layerById = new Map(layers.map((layer) => [layer.groupId, layer]));
  const layerIds = [...new Set(objects.map((object) => object.layerGroupId))];
  const lockedLayers = layerIds.filter((id) => layerById.get(id)?.locked);
  const isLocked = lockedLayers.length > 0;
  const layerLabel = layerIds.length === 1 ? (layerById.get(layerIds[0])?.name ?? "—") : `Varias (${layerIds.length})`;
  // Color (M3-S03): el de la CAPA del objeto (la identidad del color), tomado de la lista efectiva -- se actualiza apenas Fill/Recolor lo cambian.
  const singleLayer = layerIds.length === 1 ? layerById.get(layerIds[0]) : undefined;

  const currentRotation = !isMulti && objects[0] ? matrixRotationDegrees(objects[0].matrix) : null;
  const currentValues: Record<FieldName, number | null> = {
    x: bounds ? toDisplay(bounds.x) : null,
    y: bounds ? toDisplay(bounds.y) : null,
    width: bounds ? toDisplay(bounds.width) : null,
    height: bounds ? toDisplay(bounds.height) : null,
    rotation: currentRotation,
  };

  const FIELD_LABELS: Record<FieldName, string> = {
    x: `X (${unitLabel})`,
    y: `Y (${unitLabel})`,
    width: `Ancho (${unitLabel})`,
    height: `Alto (${unitLabel})`,
    rotation: "Rotación (°)",
  };

  const shownValue = (field: FieldName): string => {
    const draft = drafts[field];
    if (draft !== undefined) return draft;
    const value = currentValues[field];
    return value === null ? "" : formatDisplayNumber(value);
  };

  const clearDraft = (field: FieldName) =>
    setDrafts((current) => {
      const next = { ...current };
      delete next[field];
      return next;
    });

  const commit = (field: FieldName) => {
    const text = drafts[field];
    if (text === undefined || !bounds) return;
    clearDraft(field);
    // Defensa en profundidad: un campo deshabilitado (capa bloqueada, rotación en multi-selección) nunca aplica nada.
    if (isLocked || (field === "rotation" && isMulti)) return;

    const value = parseNumericInput(text);
    if (value === null) {
      setError(`"${text.trim() || "(vacío)"}" no es un número válido para ${FIELD_LABELS[field]}. No se aplicó ningún cambio.`);
      return;
    }
    if (Math.abs(value) > MAX_ABS_VALUE) {
      setError(`El valor de ${FIELD_LABELS[field]} está fuera de rango (máximo ±${MAX_ABS_VALUE.toLocaleString("es-AR")}). No se aplicó ningún cambio.`);
      return;
    }
    if ((field === "width" || field === "height") && value <= 0) {
      setError(`${field === "width" ? "El ancho" : "El alto"} debe ser mayor que 0. No se aplicó ningún cambio.`);
      return;
    }

    const current = currentValues[field];
    // Sin cambio real (mismo número que se muestra): no se emite un comando vacío.
    if (current !== null && formatDisplayNumber(value) === formatDisplayNumber(current)) {
      setError(null);
      return;
    }

    let failure: string | null;
    if (field === "rotation") {
      failure = onRotateTo(value);
    } else {
      const units = fromDisplay(value);
      let target: Rect | null = { ...bounds, [field]: units };
      if (keepRatio && (field === "width" || field === "height")) {
        target = proportionalBounds(bounds, field, units);
        if (!target) {
          setError("No se puede mantener la proporción: la selección tiene ancho o alto 0.");
          return;
        }
      }
      failure = onApplyBounds(target);
    }
    setError(failure);
  };

  const heading = isMulti ? `Varios (${objects.length} objetos)` : "Objeto";
  const fieldsDisabled = isLocked || !bounds;

  const renderField = (field: FieldName, extraDisabled = false, title?: string) => {
    const id = `${idPrefix}-${field}`;
    return (
      <div className="object-inspector__field" key={field}>
        <label htmlFor={id}>{FIELD_LABELS[field]}</label>
        <input
          id={id}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={shownValue(field)}
          disabled={fieldsDisabled || extraDisabled}
          title={title}
          aria-invalid={error !== null && drafts[field] !== undefined ? true : undefined}
          onChange={(event) => setDrafts((current) => ({ ...current, [field]: event.target.value }))}
          onBlur={() => commit(field)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit(field);
            } else if (event.key === "Escape") {
              event.stopPropagation();
              clearDraft(field);
            }
          }}
        />
      </div>
    );
  };

  return (
    <section aria-labelledby={`${idPrefix}-heading`} className="object-inspector">
      <h4 id={`${idPrefix}-heading`} className="editor-panel__heading">
        {heading}
      </h4>

      {!bounds ? (
        <p className="editor-panel__empty">La selección no tiene geometría visible.</p>
      ) : (
        <>
          <div className="object-inspector__grid" role="group" aria-label="Posición y tamaño de la selección">
            {renderField("x")}
            {renderField("y")}
            {renderField("width")}
            {renderField("height")}
            {renderField("rotation", isMulti, isMulti ? "La rotación numérica está disponible con un solo objeto seleccionado." : undefined)}
          </div>

          <label className="object-inspector__ratio">
            <input type="checkbox" checked={keepRatio} disabled={fieldsDisabled} onChange={(event) => setKeepRatio(event.target.checked)} /> Mantener proporción
          </label>

          {mmPerUnit === null && (
            <p className="editor-panel__empty" role="note">
              Este documento no tiene dimensiones físicas: los valores están en unidades de documento (u), no en mm.
            </p>
          )}
        </>
      )}

      <dl className="service-card__details layer-info-panel__details">
        <div>
          <dt>Capa</dt>
          <dd>{layerLabel}</dd>
        </div>
        <div>
          <dt>Color</dt>
          <dd>
            {singleLayer ? (
              <>
                <span className="object-inspector__swatch" style={{ backgroundColor: singleLayer.colorHex }} aria-hidden="true" /> {normalizeHex(singleLayer.colorHex) ?? singleLayer.colorHex}
              </>
            ) : layerIds.length > 1 ? (
              "Varios"
            ) : (
              "—"
            )}
          </dd>
        </div>
      </dl>

      {isLocked && (
        <p className="object-inspector__locked" role="note">
          <span aria-hidden="true">🔒</span>{" "}
          {lockedLayers.length === 1
            ? `La capa ${layerById.get(lockedLayers[0])?.name ?? ""} está bloqueada: los valores son de solo lectura. Desbloqueala para editar.`
            : "La selección incluye capas bloqueadas: los valores son de solo lectura. Desbloqueá esas capas para editar."}
        </p>
      )}

      {error && (
        <p className="upload-panel__error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
