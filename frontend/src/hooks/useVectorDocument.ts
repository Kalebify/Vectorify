import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getColorPalette } from "../api/colorPaletteApi";
import { getConsolidatedVectorLayers } from "../api/consolidatedVectorLayersApi";
import { API_BASE_URL, ApiClientError } from "../api/httpClient";
import {
  reorderLayers as reorderLayersRequest,
  setLayerLocked as setLayerLockedRequest,
  setLayerName as setLayerNameRequest,
  setLayerVisible as setLayerVisibleRequest,
} from "../api/layerLayoutApi";
import { getVectorDocument, updateVectorDocumentLayer } from "../api/vectorDocumentApi";
import { getVectorLayers } from "../api/vectorLayersApi";
import type { LayerLayoutEntryPayload } from "../types/layerLayout";
import type { ManufacturingOperationValue } from "../types/manufacturingOperations";
import type { VectorDocumentLayerResponse, VectorDocumentResponse } from "../types/vectorDocument";

/**
 * `VectorDocument`: estado de dominio del Workspace (M2.1-S06, extendido en
 * M2.1-S07 con persistencia real de order/visible/locked), agregando en un
 * solo objeto lo que hoy son varias llamadas de solo lectura independientes
 * (paleta confirmada + conjunto de capas + info consolidada -- esta última YA
 * incluye order/visible/locked persistidos por
 * Vectorify.Api.LayerLayout.LayerLayoutService desde M2.1-S07, ver
 * Vectorify.Api.Endpoints.ConsolidatedVectorLayerEndpoints). Ver spec.md,
 * "Ambigüedades detectadas": esto es una agregación del lado del CLIENTE
 * sobre endpoints YA EXISTENTES -- no hay ninguna entidad `VectorDocument`
 * nueva en el backend, ni se persiste acá (esa es M2.1-S08, la tarjeta
 * siguiente, "Persistencia del VectorDocument y reapertura").
 *
 * Todos los paneles del Workspace (VectorCanvas, EditorLayersPanel,
 * PaletteBar, InspectorPanel, PreviewNavigator) consumen ESTE hook como
 * única fuente de verdad -- ninguno vuelve a pedir la paleta/capas por su
 * cuenta ni guarda una copia divergente.
 *
 * Efímero vs. persistente (M2.1-S07, spec.md "Decidir qué estado de
 * selección es efímero" -- ver IMPL.md para el detalle completo):
 * - PERSISTENTE (sobrevive a un reload, backend): `order`/`visible`/`locked`
 *   de cada capa (más `name`/`manufacturingOperation`, ya persistidos por
 *   tarjetas anteriores y solo expuestos acá).
 * - EFÍMERO (solo esta sesión del Workspace, nunca viaja al backend):
 *   `selectedGroupId` (qué capa se inspecciona ahora), `isolatedGroupId`
 *   (overlay de "Isolate" -- ver más abajo) y `selectedPathKeys` (selección
 *   múltiple de "Select All in Layer").
 */
export type VectorDocumentStatus = "idle" | "loading" | "ready" | "empty" | "error";

/** Por qué el documento está "empty" (estado vacío honesto, spec.md: "nunca datos simulados"). */
export type VectorDocumentEmptyReason =
  | "no_palette_selected"
  | "palette_not_found"
  | "palette_not_confirmed"
  | "layers_not_generated";

export interface VectorDocumentLayer {
  groupId: string;
  name: string;
  colorHex: string;
  fill: string;
  vectorId: string;
  svgUrl: string;
  pathCount: number;
  componentCount: number | null;
  manufacturingOperation: ManufacturingOperationValue;
  order: number;
  /** Visibilidad PERSISTIDA (Eye, M2.1-S07) -- ver `visibility` más abajo para el valor EFECTIVO (con Isolate aplicado). */
  visible: boolean;
  /** Bloqueo de edición PERSISTIDO (Lock, M2.1-S07, concepto NUEVO) -- no afecta Eye/Isolate/Select All/Inspector. */
  locked: boolean;
  areaPercent: number;
  hasPartialAlpha: boolean;
  isExcluded: boolean;
}

export interface VectorDocument {
  projectId: string;
  imageId: string;
  paletteId: string;
  paletteVersion: number;
  layerSetId: string;
  version: number;
  sourceWidthPx: number;
  sourceHeightPx: number;
  /** Siempre ordenadas por `order` ascendente -- el ÚNICO lugar donde se aplica ese orden, ningún panel necesita volver a ordenar. */
  layers: VectorDocumentLayer[];
}

export interface UseVectorDocumentState {
  status: VectorDocumentStatus;
  document: VectorDocument | null;
  emptyReason: VectorDocumentEmptyReason | null;
  errorMessage: string | null;
  /** Vuelve a pedir todo desde cero (ej. después de generar capas desde otro panel, o el botón "Reintentar" del estado de error). */
  reload: () => void;

  /**
   * groupId -> visible EFECTIVO (lo que debe mostrar el Canvas/paneles ahora
   * mismo): la visibilidad PERSISTIDA (`document.layers[].visible`, Eye) si
   * no hay ningún Isolate activo, o -- si lo hay -- únicamente `true` para
   * `isolatedGroupId` y `false` para el resto. Isolate NUNCA escribe sobre la
   * visibilidad persistida (spec.md: "mostrar solo selección SIN BORRAR
   * ESTADOS") -- togglear Show All simplemente descarta el overlay y revela
   * el Eye real de cada capa, tal como estaba antes de aislar.
   */
  visibility: Record<string, boolean>;
  /**
   * Persiste (Eye) la visibilidad de una capa -- optimista, con rollback si falla la Web API.
   * Cutover post-Save (M2.2-S05, ronda de fix 1): con `savedProjectId` activo, persiste vía
   * `PATCH /api/v2/projects/{savedProjectId}/layers/{groupId}` (`applySavedLayerResponse`), no
   * contra el sidecar `LayerLayout` clásico -- ver docstring de `fromSavedDocument` más arriba.
   */
  toggleVisibility: (groupId: string) => void;
  /** Overlay de VISTA, solo de sesión -- ver `visibility`. */
  isolate: (groupId: string) => void;
  /** Descarta el overlay de Isolate (si había uno) -- NUNCA fuerza `visible=true` en el backend. */
  showAll: () => void;

  /**
   * Persiste (Lock, M2.1-S07) el bloqueo de edición de una capa -- optimista, con rollback si
   * falla la Web API. NUNCA afecta `visible`. Bifurca al PATCH v2 con `savedProjectId` activo,
   * mismo criterio que `toggleVisibility`.
   */
  toggleLocked: (groupId: string) => void;

  /**
   * Rename inline (M2.1-S07, ronda de fix 1 -- persistencia real sumada en
   * la ronda de fix 2): cambia el NOMBRE, nunca el GroupId -- ver spec.md,
   * "Rename → cambiar nombre, no id". Optimista, con rollback si falla la
   * Web API, mismo patrón que `toggleLocked`/`toggleVisibility` (sin mensaje
   * de error expuesto, igual que esos dos: la fila simplemente vuelve a
   * mostrar el nombre anterior).
   *
   * Sin `savedProjectId` (staging): persiste vía `setLayerName` (sidecar
   * `LayerLayout`, ver `Vectorify.Api.LayerLayout.LayerLayoutService.SetNameAsync`) -- NO vía
   * `renameColorPaletteGroup` (`ColorPaletteService.RenameAsync`, M2-S01),
   * que rechaza con 409 "palette_confirmed" en cuanto la paleta está
   * confirmada, que es SIEMPRE el caso en el Workspace (ver
   * IMPL-fix-round-1.md, "Ronda de fix 2" para el detalle completo de por
   * qué se descartó tocar esa gate). El flujo clásico pre-confirmación
   * (`ColorSwatchList.tsx`) sigue usando `renameColorPaletteGroup` tal cual,
   * sin cambios. Con `savedProjectId` activo (cutover post-Save, M2.2-S05 ronda de fix 1):
   * persiste vía PATCH v2, mismo criterio que `toggleVisibility`/`toggleLocked`.
   */
  renameLayer: (groupId: string, name: string) => void;

  /**
   * Persiste (Drag & Drop, M2.1-S07) el nuevo orden visual completo -- optimista, con rollback
   * si falla. NUNCA toca geometría (`d`/`transform`/VectorId). Con `savedProjectId` activo
   * (cutover post-Save, M2.2-S05 ronda de fix 1): el PATCH v2 es por-layer, sin endpoint de
   * batch-reorder -- manda un PATCH `order` por cada layer cuyo orden efectivamente cambió.
   */
  reorderLayers: (orderedGroupIds: string[]) => void;

  /** Selección COMPARTIDA de "qué capa se está inspeccionando" (Canvas/LayersPanel/PaletteBar/Inspector). Efímera. Seleccionar una capa distinta limpia `selectedPathKeys`. */
  selectedGroupId: string | null;
  selectGroup: (groupId: string | null) => void;

  /**
   * Selección múltiple de geometría ACOTADA a un solo Layer (M2.1-S07,
   * "Select All in Layer" -- primera selección múltiple real de la app).
   * Claves con forma `${groupId}:${pathIndex}`, 0..pathCount-1 de esa capa.
   * Efímera (nunca persistida).
   */
  selectedPathKeys: ReadonlySet<string>;
  selectAllInLayer: (groupId: string) => void;
  clearPathSelection: () => void;
}

const GENERIC_ERROR_MESSAGE = "No se pudo cargar el documento del proyecto. Intentá de nuevo.";

function toDocument(
  projectId: string,
  imageId: string,
  paletteVersion: number,
  layerSetResponse: Awaited<ReturnType<typeof getVectorLayers>>,
  consolidated: Awaited<ReturnType<typeof getConsolidatedVectorLayers>>,
  paletteGroupsById: Map<string, { areaPercent: number; hasPartialAlpha: boolean; isExcluded: boolean }>,
): VectorDocument {
  const consolidatedById = new Map(consolidated.layers.map((layer) => [layer.id, layer]));

  const layers: VectorDocumentLayer[] = layerSetResponse.layers.map((layer, index) => {
    const info = consolidatedById.get(layer.groupId);
    const paletteInfo = paletteGroupsById.get(layer.groupId);
    return {
      groupId: layer.groupId,
      // Nombre EFECTIVO: el override del sidecar LayerLayout (rename, ronda
      // de fix 2) si existe, o el snapshot crudo de VectorLayer.Name --
      // mismo criterio que visible/locked/order.
      name: info?.name ?? layer.name,
      colorHex: layer.colorHex,
      fill: info?.fill ?? layer.colorHex,
      vectorId: layer.vectorId,
      // La API entrega rutas /api/v1/...; resolverlas contra la Web API,
      // porque el frontend se sirve desde otro origen (Docker: :5173).
      svgUrl: new URL(info?.svgUrl ?? layer.svgUrl, `${API_BASE_URL}/`).toString(),
      pathCount: info?.pathCount ?? 0,
      componentCount: info?.componentCount ?? null,
      manufacturingOperation: (info?.manufacturingOperation as ManufacturingOperationValue | undefined) ?? "unassigned",
      order: info?.order ?? index,
      visible: info?.visible ?? true,
      locked: info?.locked ?? false,
      areaPercent: paletteInfo?.areaPercent ?? layer.areaPercent,
      hasPartialAlpha: paletteInfo?.hasPartialAlpha ?? layer.hasPartialAlpha,
      isExcluded: paletteInfo?.isExcluded ?? false,
    };
  });

  layers.sort((a, b) => a.order - b.order);

  return {
    projectId,
    imageId,
    paletteId: layerSetResponse.paletteId,
    paletteVersion,
    layerSetId: layerSetResponse.layerSetId,
    version: layerSetResponse.version,
    sourceWidthPx: layerSetResponse.sourceWidthPx,
    sourceHeightPx: layerSetResponse.sourceHeightPx,
    layers,
  };
}

/**
 * Reconstruye el `VectorDocument` directo desde `GET /api/v2/projects/{projectId}/document`
 * (M2.2-S05, "Reapertura") -- SIN pasar por la agregación de 3 endpoints clásicos de
 * `toDocument`. `classicProjectId`/`imageId`/`paletteId` se preservan igual (vienen de la URL,
 * ver `App.tsx`): mientras este `savedProjectId` esté presente, las mutaciones del documento
 * (toggle/rename/reorder/operación) pasan a resolverse contra `PATCH
 * /api/v2/projects/{projectId}/layers/{layerId}` (M2.2-S05, ronda de fix 1 -- cutover post-Save,
 * ver `applySavedLayerResponse` y las 4 funciones de mutación más abajo), nunca contra los
 * sidecars clásicos -- esos solo se siguen usando mientras `savedProjectId` es null (staging).
 * `paletteVersion`/`layerSetId`/`version` no tienen
 * equivalente real en la respuesta v2 (es un documento ya desacoplado del triple clásico) --
 * se completan con valores de relleno inertes (0/el propio projectId/versionNumber) que ningún
 * panel usa para mostrar datos falsos: ninguno de los paneles existentes LEE esos tres campos
 * para texto visible al usuario.
 */
/**
 * Aplica la respuesta AUTORITATIVA de `PATCH /api/v2/projects/{projectId}/layers/{layerId}`
 * (M2.2-S05, ronda de fix 1 -- cutover post-Save) sobre UNA sola capa del documento en memoria
 * -- mismo criterio que `applyLayoutEntries`, pero para la respuesta de un solo layer (`id` en
 * vez de `groupId`, sin `entries[]`) en vez del set completo del sidecar clásico.
 */
function applySavedLayerResponse(document: VectorDocument, response: VectorDocumentLayerResponse): VectorDocument {
  const layers = document.layers.map((layer) =>
    layer.groupId === response.id
      ? {
          ...layer,
          name: response.name,
          order: response.order,
          visible: response.visible,
          locked: response.locked,
          manufacturingOperation: response.manufacturingOperation as ManufacturingOperationValue,
        }
      : layer,
  );
  layers.sort((a, b) => a.order - b.order);
  return { ...document, layers };
}

function fromSavedDocument(classicProjectId: string, imageId: string, paletteId: string, response: VectorDocumentResponse): VectorDocument {
  const [, , viewBoxWidth, viewBoxHeight] = response.viewBox.split(" ").map(Number);

  const layers: VectorDocumentLayer[] = response.layers
    .map((layer) => ({
      groupId: layer.id,
      name: layer.name,
      colorHex: layer.colorHex,
      fill: layer.colorHex,
      vectorId: layer.id,
      svgUrl: layer.svgUrl ? new URL(layer.svgUrl, `${API_BASE_URL}/`).toString() : "",
      pathCount: layer.pathCount,
      componentCount: null,
      manufacturingOperation: layer.manufacturingOperation as ManufacturingOperationValue,
      order: layer.order,
      visible: layer.visible,
      locked: layer.locked,
      areaPercent: layer.coverage,
      hasPartialAlpha: false,
      isExcluded: layer.isBackground,
    }))
    .sort((a, b) => a.order - b.order);

  return {
    projectId: classicProjectId,
    imageId,
    paletteId,
    paletteVersion: 0,
    layerSetId: response.projectId,
    version: response.versionNumber,
    sourceWidthPx: Number.isFinite(viewBoxWidth) ? viewBoxWidth : 0,
    sourceHeightPx: Number.isFinite(viewBoxHeight) ? viewBoxHeight : 0,
    layers,
  };
}

/** Aplica la respuesta AUTORITATIVA de la Web API (POST visibility/lock/rename/reorder) sobre el documento en memoria -- reemplaza el optimismo local por lo que realmente quedó persistido, re-ordenando por el `order` vigente. */
function applyLayoutEntries(document: VectorDocument, entries: LayerLayoutEntryPayload[]): VectorDocument {
  const byGroupId = new Map(entries.map((entry) => [entry.groupId, entry]));
  const layers = document.layers.map((layer) => {
    const entry = byGroupId.get(layer.groupId);
    if (!entry) return layer;
    // entry.name es null si esa capa nunca recibió un rename explícito --
    // en ese caso se conserva el nombre en memoria (ya resuelto por
    // toDocument al cargar), nunca se pisa con un valor inventado.
    return { ...layer, order: entry.order, visible: entry.visible, locked: entry.locked, name: entry.name ?? layer.name };
  });
  layers.sort((a, b) => a.order - b.order);
  return { ...document, layers };
}

export function useVectorDocument(
  projectId: string,
  imageId: string,
  paletteId: string | null,
  /**
   * Project.Id v2 ya guardado (M2.2-S05, "Reapertura") -- si está presente, `load()` reconstruye
   * el documento directo desde `GET /api/v2/projects/{savedProjectId}/document`
   * (`fromSavedDocument`), SIN pasar por la agregación clásica de 3 endpoints. Null/undefined =
   * comportamiento existente sin cambios (flujo clásico de staging).
   */
  savedProjectId?: string | null,
  /**
   * `useWorkspaceSave().trackPatch` (M2.2-S07) -- conecta el indicador Dirty/Saving/Saved/Error
   * compartido al PATCH real de cada mutación cuando `savedProjectId` ya está presente (el PATCH
   * YA ES el autosave de una sesión guardada, ver spec.md M2.2-S07). Nunca se invoca en staging
   * (sin `savedProjectId`, esas mutaciones siguen pasando por los sidecars clásicos, ajenos al
   * indicador de Save). No toca la lógica de rollback optimista de acá, que sigue sin cambios.
   */
  trackPatch?: (promise: Promise<unknown>) => void,
): UseVectorDocumentState {
  const [status, setStatus] = useState<VectorDocumentStatus>("idle");
  const [document, setDocument] = useState<VectorDocument | null>(null);
  const [emptyReason, setEmptyReason] = useState<VectorDocumentEmptyReason | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isolatedGroupId, setIsolatedGroupId] = useState<string | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [selectedPathKeys, setSelectedPathKeys] = useState<ReadonlySet<string>>(new Set());

  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => abortControllerRef.current?.abort();
  }, []);

  const load = useCallback(() => {
    if (!paletteId) {
      setStatus("empty");
      setEmptyReason("no_palette_selected");
      setDocument(null);
      return;
    }

    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setStatus("loading");
    setEmptyReason(null);
    setErrorMessage(null);
    setIsolatedGroupId(null);
    setSelectedPathKeys(new Set());

    if (savedProjectId) {
      getVectorDocument(savedProjectId, controller.signal)
        .then((response) => {
          setDocument(fromSavedDocument(projectId, imageId, paletteId, response));
          setStatus("ready");
        })
        .catch((error: unknown) => {
          if (error instanceof ApiClientError && error.isAborted) {
            return;
          }
          if (error instanceof ApiClientError && !error.isNetworkError && error.body) {
            const body = error.body as { code?: string; message?: string };
            if (body.code === "not_found") {
              setStatus("empty");
              setEmptyReason("palette_not_found");
              return;
            }
            setErrorMessage(body.message ?? GENERIC_ERROR_MESSAGE);
            setStatus("error");
            return;
          }
          setErrorMessage(GENERIC_ERROR_MESSAGE);
          setStatus("error");
        });
      return;
    }

    (async () => {
      const palette = await getColorPalette(projectId, imageId, paletteId, controller.signal);

      if (!palette.isConfirmed) {
        setStatus("empty");
        setEmptyReason("palette_not_confirmed");
        return;
      }

      let layerSetResponse;
      try {
        layerSetResponse = await getVectorLayers(projectId, imageId, paletteId, controller.signal);
      } catch (error) {
        if (error instanceof ApiClientError && !error.isAborted && !error.isNetworkError) {
          const body = error.body as { code?: string } | undefined;
          if (body?.code === "not_found") {
            setStatus("empty");
            setEmptyReason("layers_not_generated");
            return;
          }
        }
        throw error;
      }

      const consolidated = await getConsolidatedVectorLayers(projectId, imageId, paletteId, controller.signal);

      const paletteGroupsById = new Map(
        palette.groups.map((group) => [
          group.groupId,
          { areaPercent: group.areaPercent, hasPartialAlpha: group.hasPartialAlpha, isExcluded: group.isExcluded },
        ]),
      );

      const doc = toDocument(projectId, imageId, palette.version, layerSetResponse, consolidated, paletteGroupsById);

      if (doc.layers.length === 0) {
        setStatus("empty");
        setEmptyReason("layers_not_generated");
        return;
      }

      setDocument(doc);
      setStatus("ready");
    })().catch((error: unknown) => {
      abortControllerRef.current = null;
      if (error instanceof ApiClientError) {
        if (error.isAborted) {
          return;
        }
        if (!error.isNetworkError && error.body) {
          const body = error.body as { code?: string; message?: string };
          if (body.code === "not_found") {
            setStatus("empty");
            setEmptyReason("palette_not_found");
            return;
          }
          setErrorMessage(body.message ?? GENERIC_ERROR_MESSAGE);
          setStatus("error");
          return;
        }
      }
      setErrorMessage(GENERIC_ERROR_MESSAGE);
      setStatus("error");
    });
  }, [projectId, imageId, paletteId, savedProjectId]);

  // Bug real encontrado por QA (M2.1-S07, fix round 2): este efecto tenía un guard por
  // "key" (`requestedForRef`) pensado para no disparar `load()` dos veces -- pero bajo React
  // 18 StrictMode (SOLO dev) ese guard rompe la carga por completo. StrictMode invoca este
  // efecto dos veces de forma sincrónica (mount → cleanup → mount) en el mismo commit: la
  // primera invocación llama a `load()` (arranca el fetch, status pasa a "loading"), el
  // cleanup del efecto de arriba (`abortControllerRef.current?.abort()`) aborta ESE fetch
  // antes de que resuelva, y la segunda invocación encontraba el guard ya "consumido" (la key
  // no cambió) y nunca reintentaba `load()` -- el Workspace quedaba en "Cargando..." para
  // siempre. En producción (sin StrictMode) nunca se manifestaba. `load()` ya es seguro de
  // llamar más de una vez (cancela su propio fetch anterior vía `abortControllerRef` antes de
  // arrancar uno nuevo), así que el guard era puramente defensivo y nunca necesario: sin él,
  // la segunda invocación de StrictMode simplemente vuelve a lanzar `load()` con un
  // AbortController fresco, que esta vez sí completa.
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, imageId, paletteId, savedProjectId]);

  const reload = useCallback(() => {
    load();
  }, [load]);

  // ---- Visibilidad (Eye, PERSISTIDA) + Isolate/Show All (overlay EFÍMERO) ----

  const toggleVisibility = useCallback(
    (groupId: string) => {
      if (!document) return;
      const layer = document.layers.find((l) => l.groupId === groupId);
      if (!layer) return;

      const nextVisible = !layer.visible;
      const paletteIdForRequest = document.paletteId;

      // Updaters de setState PUROS (sin llamar a la Web API adentro, StrictMode
      // los invoca 2 veces en desarrollo): el efecto (fetch) se dispara acá
      // afuera, una sola vez, leyendo el valor "previo" ya calculado arriba.
      setDocument((current) => current && { ...current, layers: current.layers.map((l) => (l.groupId === groupId ? { ...l, visible: nextVisible } : l)) });

      if (savedProjectId) {
        const patchPromise = updateVectorDocumentLayer(savedProjectId, groupId, { visible: nextVisible });
        // M2.2-S07: el PATCH YA ES el autosave real de una sesión guardada -- conecta el
        // indicador compartido a ESTA promesa, sin alterar el rollback optimista de abajo.
        trackPatch?.(patchPromise);
        patchPromise
          .then((response) => setDocument((current) => current && applySavedLayerResponse(current, response)))
          .catch(() =>
            setDocument(
              (current) => current && { ...current, layers: current.layers.map((l) => (l.groupId === groupId ? { ...l, visible: !nextVisible } : l)) },
            ),
          );
        return;
      }

      setLayerVisibleRequest(projectId, imageId, paletteIdForRequest, groupId, nextVisible)
        .then((response) => setDocument((current) => current && applyLayoutEntries(current, response.entries)))
        .catch(() =>
          setDocument(
            (current) => current && { ...current, layers: current.layers.map((l) => (l.groupId === groupId ? { ...l, visible: !nextVisible } : l)) },
          ),
        );
    },
    [document, projectId, imageId, savedProjectId, trackPatch],
  );

  const isolate = useCallback((groupId: string) => {
    setIsolatedGroupId(groupId);
  }, []);

  const showAll = useCallback(() => {
    setIsolatedGroupId(null);
  }, []);

  const visibility = useMemo(() => {
    if (!document) return {};
    const base = Object.fromEntries(document.layers.map((layer) => [layer.groupId, layer.visible]));
    if (!isolatedGroupId) return base;
    return Object.fromEntries(Object.keys(base).map((groupId) => [groupId, groupId === isolatedGroupId]));
  }, [document, isolatedGroupId]);

  // ---- Lock (PERSISTIDO, concepto NUEVO M2.1-S07) ----

  const toggleLocked = useCallback(
    (groupId: string) => {
      if (!document) return;
      const layer = document.layers.find((l) => l.groupId === groupId);
      if (!layer) return;

      const nextLocked = !layer.locked;
      const paletteIdForRequest = document.paletteId;

      setDocument((current) => current && { ...current, layers: current.layers.map((l) => (l.groupId === groupId ? { ...l, locked: nextLocked } : l)) });

      if (savedProjectId) {
        const patchPromise = updateVectorDocumentLayer(savedProjectId, groupId, { locked: nextLocked });
        trackPatch?.(patchPromise);
        patchPromise
          .then((response) => setDocument((current) => current && applySavedLayerResponse(current, response)))
          .catch(() =>
            setDocument(
              (current) => current && { ...current, layers: current.layers.map((l) => (l.groupId === groupId ? { ...l, locked: !nextLocked } : l)) },
            ),
          );
        return;
      }

      setLayerLockedRequest(projectId, imageId, paletteIdForRequest, groupId, nextLocked)
        .then((response) => setDocument((current) => current && applyLayoutEntries(current, response.entries)))
        .catch(() =>
          setDocument(
            (current) => current && { ...current, layers: current.layers.map((l) => (l.groupId === groupId ? { ...l, locked: !nextLocked } : l)) },
          ),
        );
    },
    [document, projectId, imageId, savedProjectId, trackPatch],
  );

  // ---- Rename (M2.1-S07, ronda de fix 1 -- ver docstring de renameLayer arriba) ----

  const renameLayer = useCallback(
    (groupId: string, name: string) => {
      if (!document) return;
      const layer = document.layers.find((l) => l.groupId === groupId);
      if (!layer) return;

      const trimmed = name.trim();
      if (!trimmed || trimmed === layer.name) return;

      const previousName = layer.name;
      const paletteIdForRequest = document.paletteId;

      setDocument((current) => current && { ...current, layers: current.layers.map((l) => (l.groupId === groupId ? { ...l, name: trimmed } : l)) });

      if (savedProjectId) {
        const patchPromise = updateVectorDocumentLayer(savedProjectId, groupId, { name: trimmed });
        trackPatch?.(patchPromise);
        patchPromise
          .then((response) => setDocument((current) => current && applySavedLayerResponse(current, response)))
          .catch(() =>
            setDocument(
              (current) => current && { ...current, layers: current.layers.map((l) => (l.groupId === groupId ? { ...l, name: previousName } : l)) },
            ),
          );
        return;
      }

      setLayerNameRequest(projectId, imageId, paletteIdForRequest, groupId, trimmed)
        .then((response) => setDocument((current) => current && applyLayoutEntries(current, response.entries)))
        .catch(() =>
          setDocument(
            (current) => current && { ...current, layers: current.layers.map((l) => (l.groupId === groupId ? { ...l, name: previousName } : l)) },
          ),
        );
    },
    [document, projectId, imageId, savedProjectId, trackPatch],
  );

  // ---- Reorder (Drag & Drop, PERSISTIDO -- NUNCA toca geometría) ----

  const reorderLayers = useCallback(
    (orderedGroupIds: string[]) => {
      if (!document) return;
      const byGroupId = new Map(document.layers.map((l) => [l.groupId, l]));
      if (orderedGroupIds.length !== document.layers.length || orderedGroupIds.some((id) => !byGroupId.has(id))) {
        return;
      }

      const previousLayers = document.layers;
      const paletteIdForRequest = document.paletteId;
      const optimisticLayers = orderedGroupIds.map((groupId, index) => ({ ...byGroupId.get(groupId)!, order: index }));

      setDocument((current) => current && { ...current, layers: optimisticLayers });

      if (savedProjectId) {
        // PATCH v2 es por-layer, sin endpoint de batch-reorder (decisión ya tomada en spec.md
        // de M2.2-S05, "Mutaciones post-Save": el patrón PATCH individual alcanza para el caso
        // de uso del drag-and-drop) -- un PATCH por cada layer cuyo `order` efectivamente
        // cambió respecto al valor previo, nunca uno por cada layer del documento.
        const changedLayers = optimisticLayers.filter((layer) => byGroupId.get(layer.groupId)!.order !== layer.order);

        const patchPromise = Promise.all(
          changedLayers.map((layer) => updateVectorDocumentLayer(savedProjectId, layer.groupId, { order: layer.order })),
        );
        trackPatch?.(patchPromise);
        patchPromise
          .then((responses) =>
            setDocument((current) => {
              if (!current) return current;
              return responses.reduce((doc, response) => applySavedLayerResponse(doc, response), current);
            }),
          )
          .catch(() => setDocument((current) => current && { ...current, layers: previousLayers }));
        return;
      }

      reorderLayersRequest(projectId, imageId, paletteIdForRequest, orderedGroupIds)
        .then((response) => setDocument((current) => current && applyLayoutEntries(current, response.entries)))
        .catch(() => setDocument((current) => current && { ...current, layers: previousLayers }));
    },
    [document, projectId, imageId, savedProjectId, trackPatch],
  );

  // ---- Selección (EFÍMERA) ----

  const selectGroup = useCallback((groupId: string | null) => {
    setSelectedGroupId(groupId);
    setSelectedPathKeys(new Set());
  }, []);

  const selectAllInLayer = useCallback(
    (groupId: string) => {
      const layer = document?.layers.find((l) => l.groupId === groupId);
      if (!layer) return;

      const keys = new Set<string>();
      for (let index = 0; index < layer.pathCount; index += 1) {
        keys.add(`${groupId}:${index}`);
      }
      setSelectedPathKeys(keys);
      setSelectedGroupId(groupId);
    },
    [document],
  );

  const clearPathSelection = useCallback(() => {
    setSelectedPathKeys(new Set());
  }, []);

  return {
    status,
    document,
    emptyReason,
    errorMessage,
    reload,
    visibility,
    toggleVisibility,
    isolate,
    showAll,
    toggleLocked,
    renameLayer,
    reorderLayers,
    selectedGroupId,
    selectGroup,
    selectedPathKeys,
    selectAllInLayer,
    clearPathSelection,
  };
}
