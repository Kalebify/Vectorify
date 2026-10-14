# IMPL.md — M3-S13 · Autosave + Version History

## Resumen
La geometría editada ahora se persiste: autosave con debounce, guardado manual, estado Guardando/Guardado/Error real en el header, y un
panel de **Historial de versiones** con restauración. Cerrar y reabrir el editor no pierde el trabajo. Spec: `spec.md`; decisiones en el
ADR (D5, "Implementado en S13").

## Decisiones
- **`geometryDirty` pasa a significar "difiere de lo último confirmado por el servidor".** Se añadió `saveMark`/`markSaved` a
  `useEditableDocument`: la marca se captura **al serializar** (mismo render que los objetos/capas enviados) y se declara guardada al
  confirmarse. Las ediciones hechas con el POST en vuelo siguen sucias; deshacer más allá de lo guardado ensucia y rehacer lo limpia; una
  marca de un documento ya reiniciado (otro `documentKey` / documento regenerado) se ignora (`epoch`). **El historial de undo no se
  reinicia al guardar.** `editedLayerIds` no cambia (lo usan la miniatura y el `pathCount`).
- **El spec decía que `onSaved` limpiaba el baseline; el WIP lo dejaba como no-op** (el indicador habría vuelto a "Cambios sin guardar"
  a los 4 s y el aviso de salida nunca se habría quitado). Es el núcleo de la tarjeta y está cubierto por tests.
- **SAVE con proyecto guardado ⇒ siempre `editor-save` (MANUAL_EDIT)**, aun sin cambios (checkpoint). El spec decía "cuando hay
  `geometryDirty`", pero el save clásico con un proyecto existente regenera las capas desde el pipeline clásico y pisaría la geometría
  autoguardada. El clásico queda para el primer guardado (staging).
- **Autosave**: 3 s tras la última edición (cada edición reinicia la ventana); un POST a la vez; red/5xx ⇒ backoff 1 s → 2 s (3 intentos)
  con la misma `idempotencyKey`, que se descarta si el payload cambió entre medio (si no, el servidor devolvería el resultado viejo);
  4xx/409 ⇒ `error` y el autosave espera a un guardado manual. Una respuesta de un request abortado/reemplazado se ignora (`requestSeq`):
  en el WIP pisaba el flag `isSaving` del request nuevo.
- **Nunca se guarda con una capa sin cargar** (se serializaría vacía y borraría su geometría en el servidor). El manual lo avisa; el
  autosave espera.
- **409**: el hook expone `conflictDetected`; el shell muestra un aviso con **Recargar documento** (confirma que se pierde lo no guardado)
  y **Reintentar** (confirma que puede sobrescribir la otra versión). El contrato no lleva `baseVersion`: solo detecta escrituras
  *simultáneas* (`xmin`), no "pestaña B guarda sobre lo que guardó A". Documentado; añadir `baseVersion` sería un cambio de contrato.
- **Restaurar**: confirma si hay geometría sin guardar, **suspende el autosave antes del POST** (no puede pisar la versión restaurada) y
  recarga la página (el historial de undo se reinicia con ella; el aviso de salida no se repite). La versión "(actual)" es la última que
  guardó esta sesión (el documento cargado no se refresca tras guardar).
- **Resumen de versión = tamaño en mm**, no nº de capas: el listado (`GET /versions`, M2.2-S06) no lo expone y el spec prohíbe modificar
  esos endpoints.
- `ColorHex`/`ColorCoverage`/`ColorIsBackground` viajan en cada capa (el esquema exige una fila `PaletteColor` por capa); el spec no los
  listaba. Un `editor-save` válido siempre responde 200 (no hay 201).

## Entregado
- **ASP.NET**: `EditorSaveRequest`/`EditorSaveLayerRequest`/`EditorSaveResponse`, `VectorDocumentResult.EditorSaved`,
  `VectorDocumentService.EditorSaveAsync` (validación completa, idempotencia, ownership, Assets `layer-svg`, 409), endpoint
  `POST /api/v2/projects/{id}/document/editor-save`, `VersionId` en `VectorDocumentSaveOutcome`.
- **Frontend**: `useGeometrySave`, `useEditableDocument.saveMark/markSaved`, `VersionHistoryPanel`, `editorSave` en la API,
  `EditorHeader` (estados de guardado de geometría + botón *Versiones*), integración y aviso de conflicto en `EditorShell`, estilos.
- **Tests**: frontend +51 (`useGeometrySave` 21, `useEditableDocument.saved` 8, `VersionHistoryPanel` 11, `EditorHeader` +4, `EditorShell`
  +7); backend: 9 métodos / 26 casos E2E en `VectorDocumentEndpointsTests` (feliz, inmutabilidad + origen, replay, claves distintas,
  restore tras editor-save, 18 validaciones 400, ownership 404, fallo de storage 422, conflicto 409 con repositorio simulado).

## Desviaciones / observaciones
- El test `EditorShell.history` "capas isNew … ninguna llamada de red" fallaba de forma **intermitente** en el suite completo: bajo
  carga pasaban los 3 s y el autosave (legítimo) mandaba un POST. El mock del servidor ahora atiende `editor-save` aparte (`editorSaves`)
  y `calls` sigue siendo solo las escrituras de metadata.
- Fuera de alcance (spec): autosave granular por comando, merge de versiones, vista previa de versiones sin restaurar, y esperar a un
  PATCH de metadata en vuelo antes de serializar.

## Verificación
- `npm test`: 122 archivos / 2962 tests verdes (eran 2911). `npm run build` limpio. `npm run lint`: sin warnings nuevos en lo tocado.
- `dotnet build` (API + tests): correcto, 0 advertencias.
- **No ejecutado**: `dotnet test` de los E2E nuevos. Docker Desktop no arranca en esta máquina (Testcontainers necesita Postgres), así que
  los 26 casos del backend compilan pero **no se corrieron**. Pendiente correrlos cuando vuelva Docker.
