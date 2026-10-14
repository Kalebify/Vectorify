# spec.md — M3-S13 · Autosave + Version History

> Lee primero `docs/ADR_EDITOR_MVP3.md` (D5: persistencia de geometría) y los IMPL.md de M3-S01–S12 (`.sprint/<card_id>/IMPL.md`).
> Lee también los IMPL.md de M2.2-S06 (versionado persistente) y M2.2-S07 (autosave + recuperación segura):
> `.sprint/3e8d77b2-6398-81e5-9b41-e4bdd94a9d67/IMPL.md` y `.sprint/3e8d77b2-6398-813c-9dcb-e537ad6ad9f9/IMPL.md`.
> Antes de escribir una línea de código, lee el contenido actual de:
> - `backend/Vectorify.Api/Endpoints/VectorDocumentEndpoints.cs`
> - `backend/Vectorify.Api/VectorDocuments/VectorDocumentService.cs`
> - `backend/Vectorify.Api/Contracts/VectorDocumentRequests.cs` y `VectorDocumentResponse.cs`
> - `backend/Vectorify.Api/Data/DocumentVersion.cs` y `DocumentVersionOrigin.cs`
> - `frontend/src/hooks/useWorkspaceSave.ts` y `useVectorDocument.ts`
> - `frontend/src/components/editor/EditorShell.tsx` (busca TODO(M3-S13))
> - `frontend/src/lib/editor/objects.ts` (`serializeEditableLayer`) y `frame.ts` (`serializeFrame`)

## Contexto (tarjeta Notion)
Objetivo: "Guardar trabajo automáticamente y permitir recuperar checkpoints/versiones importantes del proyecto."
Criterio: "Autosave refleja estados Saving/Saved/Error reales y Version History permite restaurar una versión sin perder la actual."
- Undo/Redo = historial fino de edición. **Version History = snapshots/checkpoints persistentes.**
- Autosave: debounce razonable, no guardar por mousemove; estado visible; retry seguro; manejo de conflicto/version id.
- Versiones: listar fecha, origen manual/autosave, resumen básico y restore. Restaurar crea nueva versión, no borra historia.
- Tests: offline/fallo, cambios rápidos, restore, conflicto y reload.
- DoD: "Cerrar/reabrir no implica pérdida de trabajo y el usuario puede volver a un checkpoint anterior."

## Decisiones (documentalas en IMPL.md, ADR y UI)

### 1. Endpoint `POST /api/v2/projects/{projectId}/document/editor-save` (nuevo, backend)
Acepta JSON:
```
{
  origin: "MANUAL_EDIT" | "AUTOSAVE",
  idempotencyKey: string,          // GUID generado por el cliente; mismo valor en reintentos del mismo intento
  viewBox: string,                 // ej. "0 0 800 600"
  widthMm: number,
  heightMm: number,
  schemaVersion: number,           // siempre 1 por ahora (SCHEMA_VERSION de objects.ts)
  layers: EditorSaveLayer[],       // TODAS las capas del documento (touched y no-touched por igual)
  removedLayerGroupIds?: string[]  // groupIds de capas que el usuario eliminó (vacío si ninguna)
}

EditorSaveLayer {
  groupId: string,          // UUID de capa del servidor (para capas isNew: un nuevo UUID generado por el cliente)
  svgContent: string,       // resultado de serializeEditableLayer(objects, meta)
  name: string,
  order: number,
  visible: boolean,
  locked: boolean,
  manufacturingOperation: string | null,  // "cut" | "engrave" | "ignore" | null (unassigned)
  isNew: boolean            // true → crear capa nueva en el servidor; false → actualizar existente
}
```
Devuelve `{ projectId, versionNumber, versionId, createdAt }` (200 OK; 201 en el primer save de un proyecto que no tenía geometría editada).
Validaciones (400): `origin` desconocido, `viewBox` inválido, `widthMm`/`heightMm` ≤ 0, SVG vacío o demasiado grande (>2 MB por capa, configurable), demasiadas capas, `groupId` duplicado.
Idempotencia: si `idempotencyKey` existe para este proyecto, devuelve el resultado original (200, nunca 201 de un replay).
409 Conflict: usa el `xmin` / `ETag` de PostgreSQL o el número de versión actual para detectar escrituras concurrentes.
Ownership: solo el owner del proyecto puede llamarlo (misma lógica de autorización que `PATCH /api/v2/projects/{id}/layers/{layerId}`).
El servidor almacena el SVG de cada capa como un `Asset` de tipo "vector" y lo referencia en la `Layer.SvgAssetId`. Las capas `isNew` se crean como nuevas filas de `Layer`. Versiones inmutables: nunca se modifica una `DocumentVersion` existente.

### 2. Frontend: `useGeometrySave` hook (`hooks/useGeometrySave.ts`)
Recibe `{ projectId, document, geometryDirty, layers }` (el `EditableDocumentApi` + `VectorDocumentLayer[]`).
- **Autosave**: cuando `geometryDirty` pasa a `true`, inicia un debounce de **3 segundos** (no guardar por frame/mousemove; solo tras `commitGesture`). Al vencerse, serializa y llama al endpoint.
- **Guardado manual**: expone `save()` para que el botón SAVE del header lo llame inmediatamente (cancela el debounce pendiente).
- **Estado**: `"idle" | "saving" | "saved" | "error"`. `"saved"` se limpia automáticamente a `"idle"` tras 4 segundos. `"error"` persiste hasta el próximo intento exitoso.
- **Retry**: en error de red, hasta 3 reintentos con backoff exponencial (1s → 2s → 4s). Error persistente (servidor 4xx o ≥3 fallos de red) → estado `"error"`, muestra mensaje.
- **Conflicto (409)**: estado `"error"` con `conflictDetected: true`; ofrece en la UI "Recargar documento" (pierde cambios no guardados) o "Reintentar" (puede sobrescribir — con aviso).
- **Serialización**: `serializeEditableLayer(objects, meta)` por capa + `serializeFrame(frame, mmPerUnit)` para el viewBox/mm. El resultado es el `svgContent` de cada `EditorSaveLayer`. Capas `isNew` usan el `groupId` local (string) tal cual; el servidor los registrará como nuevas filas de `Layer`.
- **Confirmación de guardado**: al recibir 200/201 llama a `onSaved(versionNumber)` → EditorShell limpia `geometryDirty` (reseteando el baseline). Si el servidor devuelve un groupId diferente para una capa isNew (raro: el servidor acepta el groupId del cliente), reconciliar es opcional en S13 (documentarlo).
- **AbortController**: cancela la petición en vuelo al desmontar el componente o al iniciar otro guardado.

### 3. EditorHeader y EditorShell — integración del save de geometría
El `workspaceSave` existente (clásico, `POST /api/v2/workspaces/save`) **se conserva sin cambios**; se usa en el flujo de primer guardado desde la ventanilla de vectorización. Para el editor de geometría **el botón SAVE** llama ahora a `geometrySave.save()` cuando `geometryDirty` es true y la sesión ya tiene un `projectId`. `saveState` del header refleja el estado de `geometrySave` (no del workspaceSave) cuando hay `geometryDirty`.
El aviso `geometryDirty` de `beforeunload` sigue activo hasta que el guardado confirme.

### 4. Version History — `VersionHistoryPanel.tsx`
Panel (modal/popover) accesible desde el header vía botón "Historial de versiones" (distinto al HistoryPanel de S12 que es undo/redo).
- Llama a `GET /api/v2/projects/{projectId}/versions` al abrirse.
- Lista versiones: número, fecha, origen (Guardado automático / Guardado manual / Restauración / Vectorización), resumen básico (número de capas).
- La versión actual marcada.
- **Restaurar**: `POST /api/v2/projects/{projectId}/versions/{versionNumber}/restore` → crea nueva versión → recarga el documento (`window.location.reload()` o re-fetch del documento). Antes de restaurar: confirmar con el usuario si hay `geometryDirty` (advertencia: "Se perderán los cambios no guardados").
- Restaurar **nunca borra** el historial de versiones — solo agrega una nueva versión con `Origin.Restore`.
- El panel avisa con `aria-live` durante la carga y la restauración.

### 5. Alcance del "historial de sesión" vs "version history"
- Undo/Redo de S12 = historial FINO en memoria (se pierde al recargar). NO persiste.
- Version History = checkpoints persistentes en el servidor (DocumentVersion). Al restaurar: el historial de undo/redo de S12 se **reinicia** (con aviso, mismo mecanismo que el `reset` de S12).

### 6. Fuera de alcance
Autosave granular por comando, merge de ramas de versiones, preview de versiones antiguas sin restaurar, autosave con Git-like diff, autosave mientras hay un PATCH de metadata en vuelo (esperar a que termine el PATCH antes de serializar).

## Alcance técnico
- **ASP.NET Core**: nuevo endpoint `POST /api/v2/projects/{projectId}/document/editor-save` (en `VectorDocumentEndpoints.cs`), contrato request/response (`VectorDocumentRequests.cs` y `VectorDocumentResponse.cs`), lógica en `VectorDocumentService.cs`, almacenamiento de SVG via `IAssetService`. Nuevo resultado discriminado `EditorSaved`. Los endpoints `GET /api/v2/projects/{projectId}/versions` y `POST .../restore` ya existen (M2.2-S06) y NO se modifican.
- **Frontend**: `hooks/useGeometrySave.ts` (nueva), `api/vectorDocumentApi.ts` (nueva función `editorSave`), `components/editor/VersionHistoryPanel.tsx` (nueva), `components/editor/VersionHistoryPanel.test.tsx`, `hooks/useGeometrySave.test.ts`, actualización de `EditorShell.tsx` (reemplaza el TODO(M3-S13)) y `EditorHeader.tsx` (botón de version history).
- **Python**: sin cambios.

## Tests exigidos
- **Backend**: validador del request (cada regla de 400), idempotencia real (replay de misma key devuelve mismo resultado), conflicto 409, ownership 403/404, límite de tamaño de SVG, capas isNew creadas correctamente, versión inmutable (la versión anterior no se modifica), servicio (mock de IAssetService + IFileStorage), endpoints de punta a punta con Docker (Testcontainers).
- **Frontend `useGeometrySave`**: debounce → un solo request tras N cambios rápidos; save manual cancela debounce; retry con backoff (mock de fetch con AbortSignal y conteo de llamadas); conflicto → estado error + conflictDetected; `geometryDirty` limpiado tras 200; AbortController al desmontar; serialización correcta (serializeEditableLayer llamado por capa).
- **`VersionHistoryPanel`**: lista de versiones renderizada, versión actual marcada, restaurar dispara POST + reload/re-fetch, confirmación ante geometryDirty, carga/error/vacío (StrictMode).
- **EditorShell**: botón SAVE llama a geometrySave.save() cuando hay geometryDirty; workspaceSave clásico sin cambios en su ruta.
- **Suite existente S01–S12**: debe seguir verde.
- Verificación: `npm test`, `npm run build`, `npm run lint`, `dotnet build`, `dotnet test` (Docker).

## DoD
Cerrar y reabrir el editor no pierde el trabajo editado. El usuario ve el estado Guardando.../Guardado/Error en tiempo real. Existe una lista navegable de versiones persistidas con opción de restaurar.
