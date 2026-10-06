import { useMemo, useState, type ReactNode } from "react";
import { LayerInfoPanel } from "../layers/LayerInfoPanel";
import { ManufacturingOperationSummary } from "../layers/ManufacturingOperationSummary";
import type { UseLaserWarningsState } from "../../hooks/useLaserWarnings";
import type { VectorDocumentLayer } from "../../hooks/useVectorDocument";
import type {
  ManufacturingOperationChoice,
  ManufacturingOperationPayload,
  ManufacturingOperationSummaryPayload,
  ManufacturingOperationValue,
} from "../../types/manufacturingOperations";

interface InspectorPanelProps {
  layers: VectorDocumentLayer[];
  selectedLayer: VectorDocumentLayer | null;
  isVisible: boolean;
  onIsolate: () => void;
  onShowAll: () => void;
  onRefresh: () => void;
  /** Select All in Layer (M2.1-S07): selecciona TODOS los paths de la capa seleccionada en el Canvas. */
  onSelectAllInLayer: () => void;
  /** Cuántos paths quedaron seleccionados por Select All in Layer (0 si ninguno) -- solo informativo. */
  selectedPathCount: number;
  /** Bloqueo de edición (Lock, M2.1-S07) de la capa seleccionada. */
  onToggleLocked: () => void;
  /** Cache de sesión de resultados del Laser Checker (M1-S08) por capa -- ver useLaserWarnings. */
  laserWarnings: UseLaserWarningsState;
  /** Rename inline de la capa seleccionada (fix round M2.1-S07) -- ver useVectorDocument.renameLayer. */
  onRename: (groupId: string, name: string) => void;
  /** groupId -> intención de fabricación vigente (M2-S07/MVP2, ver useManufacturingOperations). */
  operations: Record<string, ManufacturingOperationPayload>;
  onChangeOperation: (groupId: string, operation: ManufacturingOperationChoice) => void;
  /** groupId de la capa cuya operación se está guardando, para deshabilitar su selector mientras la request está en curso. */
  mutatingGroupId: string | null;
  /** Sección de la selección de OBJETOS (M3-S01, `ObjectInspector`): posición/tamaño/rotación. Se muestra arriba del Inspector de capa, que no cambia. */
  objectSection?: ReactNode;
}

function summarize(layers: VectorDocumentLayer[]): ManufacturingOperationSummaryPayload {
  return {
    cutCount: layers.filter((l) => l.manufacturingOperation === "cut").length,
    engraveCount: layers.filter((l) => l.manufacturingOperation === "engrave").length,
    ignoreCount: layers.filter((l) => l.manufacturingOperation === "ignore").length,
    unassignedCount: layers.filter((l) => l.manufacturingOperation === "unassigned").length,
    totalCount: layers.length,
  };
}

/**
 * "INSPECTOR" del wireframe obligatorio (columna derecha: "Color / Paths /
 * Pieces / Operation"): envuelve el `LayerInfoPanel` YA EXISTENTE
 * (M2.1-S03/M2.1-S04, exactamente esos mismos 4 campos + HEX/visibilidad) en
 * vez de reescribir esa lógica, adaptando sus props al `VectorDocument`
 * agregado de esta tarjeta -- ver `useVectorDocument`.
 *
 * M2.1-S07 amplía el Inspector (spec.md, "Inspector de Layer") con: bloqueo
 * de edición (Lock, ya reflejado también en EditorLayersPanel -- togglear
 * acá o ahí es el MISMO estado persistido), Select All in Layer, y warnings
 * láser DISPONIBLES (el último resultado ya corrido del Laser Checker de
 * M1-S08 para esta capa, si existe -- ver useLaserWarnings.NUNCA dispara un
 * análisis nuevo automáticamente, solo a pedido explícito del botón
 * "Ejecutar Laser Checker").
 *
 * Suma el resumen de operaciones de fabricación (`ManufacturingOperationSummary`,
 * M2-S07/MVP2) con un filtro puramente local a este panel (no afecta
 * `visibility` del canvas): el propio spec.md del M2-S07 documenta que este
 * resumen "se renderiza dentro del panel Layers/Inspector ya existente, no
 * un panel paralelo".
 *
 * `onRefresh` dispara un reload COMPLETO del VectorDocument (no un refetch
 * parcial del consolidado): a diferencia de `LayersPanel` clásico (que tiene
 * un `useConsolidatedVectorLayers` propio con `refetch` independiente), acá
 * hay una única fuente de verdad (`useVectorDocument`) y un único mecanismo
 * de refresco -- decisión documentada en IMPL.md.
 *
 * M2.1-S07, ronda de fix 1: el título de `LayerInfoPanel` y su fila
 * "Operación de fabricación" eran de solo lectura -- ahora pasa `onRename`/
 * `onChangeOperation` (ambas props OPCIONALES de `LayerInfoPanel`, ver ese
 * componente) para que también ofrezcan edición inline desde acá, con el
 * mismo criterio de Lock que `EditorLayersPanel` (una capa bloqueada
 * deshabilita ambos controles). Ver IMPL.md, "Ronda de fix 1" para una
 * limitación conocida del backend sobre Rename en este contexto.
 */
export function InspectorPanel({
  layers,
  selectedLayer,
  isVisible,
  onIsolate,
  onShowAll,
  onRefresh,
  onSelectAllInLayer,
  selectedPathCount,
  onToggleLocked,
  laserWarnings,
  onRename,
  operations,
  onChangeOperation,
  mutatingGroupId,
  objectSection,
}: InspectorPanelProps) {
  const [operationFilter, setOperationFilter] = useState<ManufacturingOperationValue | "all">("all");
  const summary = useMemo(() => summarize(layers), [layers]);

  const laserStatus = selectedLayer ? laserWarnings.statusFor(selectedLayer.groupId) : "idle";
  const laserResult = selectedLayer ? laserWarnings.resultFor(selectedLayer.groupId) : null;
  const laserError = selectedLayer ? laserWarnings.errorFor(selectedLayer.groupId) : null;

  // Operación EFECTIVA de la capa seleccionada: prioriza el estado ya vivo
  // de `useManufacturingOperations` (refleja una asignación recién hecha sin
  // esperar un reload completo del VectorDocument) y cae al valor del
  // consolidado (`selectedLayer.manufacturingOperation`) mientras ese hook
  // todavía no resolvió su fetch inicial -- mismo criterio que
  // EditorLayersPanel.
  const isOperationMutating = selectedLayer ? mutatingGroupId === selectedLayer.groupId : false;

  return (
    <section aria-labelledby="inspector-heading" className="inspector-panel">
      <h3 id="inspector-heading" className="editor-panel__heading">
        Inspector
      </h3>

      {objectSection}

      <LayerInfoPanel
        selectedLayer={
          selectedLayer
            ? {
                groupId: selectedLayer.groupId,
                name: selectedLayer.name,
                colorHex: selectedLayer.colorHex,
                areaPercent: selectedLayer.areaPercent,
                hasPartialAlpha: selectedLayer.hasPartialAlpha,
                vectorId: selectedLayer.vectorId,
                svgUrl: selectedLayer.svgUrl,
              }
            : null
        }
        consolidated={
          selectedLayer
            ? {
                id: selectedLayer.groupId,
                name: selectedLayer.name,
                colorHex: selectedLayer.colorHex,
                fill: selectedLayer.fill,
                vectorId: selectedLayer.vectorId,
                svgUrl: selectedLayer.svgUrl,
                pathCount: selectedLayer.pathCount,
                componentCount: selectedLayer.componentCount,
                manufacturingOperation: operations[selectedLayer.groupId]?.operation ?? selectedLayer.manufacturingOperation,
                visible: isVisible,
                locked: selectedLayer.locked,
                order: selectedLayer.order,
                rasterValidation: {
                  ownMismatchRatio: 0,
                  ownMismatchTolerance: 0,
                  ownMismatchWithinTolerance: true,
                  contaminationRatio: 0,
                  contaminationTolerance: 0,
                  contaminationWithinTolerance: true,
                  warnings: [],
                },
              }
            : null
        }
        consolidatedStatus={layers.length > 0 ? "ready" : "idle"}
        consolidatedErrorMessage={null}
        onRefresh={onRefresh}
        isVisible={isVisible}
        onIsolate={onIsolate}
        onShowAll={onShowAll}
        onRename={onRename}
        renameDisabled={selectedLayer?.locked ?? false}
        onChangeOperation={onChangeOperation}
        operationDisabled={(selectedLayer?.locked ?? false) || isOperationMutating}
      />

      {selectedLayer && (
        <div className="inspector-panel__extra" role="group" aria-label={`Acciones y estado avanzado de la capa ${selectedLayer.name}`}>
          <dl className="service-card__details layer-info-panel__details">
            <div>
              <dt>Bloqueada</dt>
              <dd>{selectedLayer.locked ? "Sí (edición bloqueada)" : "No"}</dd>
            </div>
          </dl>

          <div className="layer-info-panel__actions">
            <button type="button" className="upload-actions__button" onClick={onToggleLocked}>
              {selectedLayer.locked ? "Desbloquear capa" : "Bloquear capa"}
            </button>
            <button type="button" className="upload-actions__button" onClick={onSelectAllInLayer}>
              Seleccionar todo en la capa
            </button>
          </div>
          {selectedPathCount > 0 && (
            <p className="layers-panel__status" role="status">
              {selectedPathCount} {selectedPathCount === 1 ? "elemento seleccionado" : "elementos seleccionados"} en esta capa.
            </p>
          )}

          <div className="inspector-panel__laser-warnings">
            <h4 className="editor-panel__heading">Warnings láser</h4>

            {laserStatus === "idle" && (
              <>
                <p className="editor-panel__empty">Todavía no se ejecutó el Laser Checker para esta capa.</p>
                <button type="button" className="upload-actions__button" onClick={() => laserWarnings.run(selectedLayer.groupId, selectedLayer.vectorId)}>
                  Ejecutar Laser Checker
                </button>
              </>
            )}

            {laserStatus === "running" && (
              <p className="layers-panel__status" role="status">
                Analizando…
              </p>
            )}

            {laserStatus === "error" && (
              <>
                <p className="upload-panel__error" role="alert">
                  {laserError ?? "No se pudo analizar el SVG."}
                </p>
                <button type="button" className="upload-actions__button" onClick={() => laserWarnings.run(selectedLayer.groupId, selectedLayer.vectorId)}>
                  Reintentar
                </button>
              </>
            )}

            {laserStatus === "ready" && laserResult && (
              <>
                <p className="layers-panel__status" role="status">
                  {laserResult.summary.openPathCount} paths abiertos, {laserResult.summary.duplicateGroupCount} grupos de duplicados.
                </p>
                <button type="button" className="upload-actions__button" onClick={() => laserWarnings.run(selectedLayer.groupId, selectedLayer.vectorId)}>
                  Volver a analizar
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {layers.length > 0 && (
        <ManufacturingOperationSummary summary={summary} filter={operationFilter} onChangeFilter={setOperationFilter} />
      )}
    </section>
  );
}
