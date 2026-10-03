# IMPL-fix-round-1.md — M2.2-S05 · Cutover post-Save faltante (frontend)

## Bug reportado por QA

El spec original decía explícitamente: "Después de guardar, mientras el Workspace tiene un
Project.Id v2 activo: toda edición de order/visible/locked/name/operación pasa a leer/escribir
contra la DB (nuevos endpoints), no contra los sidecars." El backend (`PATCH
/api/v2/projects/{projectId}/layers/{layerId}`) existía y funcionaba, pero nada en React lo
llamaba -- `EditorShell`/`useVectorDocument` seguían mandando todo a los sidecars clásicos
(`LayerLayout`/`ManufacturingOperation`) incluso con una sesión ya guardada. La DB no era
realmente la fuente autoritativa tras guardar.

## Fix

`useVectorDocument.ts`: `toggleVisibility`/`toggleLocked`/`renameLayer`/`reorderLayers`
bifurcan ahora según `savedProjectId`:
- **Presente** (sesión guardada): `PATCH /api/v2/projects/{id}/layers/{groupId}` vía
  `updateVectorDocumentLayer` (`vectorDocumentApi.ts`). Nueva función `applySavedLayerResponse`
  (análoga a `applyLayoutEntries` pero para la respuesta de un solo layer) reemplaza el
  optimismo local por la respuesta autoritativa del backend.
- **Ausente** (staging): comportamiento sin cambios, sidecars clásicos.

`reorderLayers` manda un `PATCH {order}` por cada layer cuyo orden cambió (no hay
batch-reorder, decisión ya tomada en el spec original).

`useManufacturingOperations.ts` gana un parámetro opcional `savedProjectId`: con él activo,
omite el fetch inicial clásico (quedaría desincronizado del DB post-Save) y `assign()` llama al
mismo PATCH v2. `EditorShell.tsx` le pasa `savedProjectId`.

## Decisión: dirty-state tras una mutación ya persistida

`markDirty()` sigue marcando "dirty" tras CUALQUIER mutación, sea staging o post-Save, aunque
el PATCH v2 ya persiste de inmediato. Razón: el botón Guardar sigue comunicando "todo lo que
hiciste está confirmado bajo un checkpoint/versión" -- quitar el indicador haría parecer que
editar no tiene efecto. Ver además el hallazgo de la ronda de fix 2 (abajo).

## Hallazgo adicional durante esta ronda (resuelto en fix round 2, ver ese documento)

El agente que implementó este fix notó, sin que fuera parte de su alcance, que
`POST /api/v2/workspaces/save` en saves subsiguientes seguía re-derivando la nueva
`DocumentVersion` leyendo los sidecars clásicos -- que, tras este cutover, quedan CONGELADOS
desde el primer Save. Un segundo Save real podía revertir en silencio cualquier edición hecha
vía PATCH v2. Corregido por el orquestador en una ronda de fix separada (ver
`IMPL-fix-round-2.md`), ya que tocaba `VectorDocumentService.cs` (backend), un archivo que esta
ronda de frontend no necesitaba tocar.

## Test obligatorio agregado

`useVectorDocument.test.ts`: test de round-trip explícito -- con `savedProjectId` activo, editar
visible/locked/order/nombre contra un fetch mock que modela el estado real del servidor (cada
PATCH muta el estado, cada GET lo refleja), desmontar/remontar el hook (simula reabrir), y
confirmar que todo sobrevivió. Más tests unitarios por mutación confirmando que llaman al PATCH
v2 y NUNCA al sidecar clásico cuando `savedProjectId` está presente.

## Verificación (confirmada de forma independiente por el orquestador)

- `npm run build` (tsc -b && vite build) → limpio.
- `npm test` → 331/331 (37 archivos).
- `dotnet build`/`dotnet test`/`pytest` → sin tocar (diff puramente frontend, confirmado por
  `git diff --stat`).
