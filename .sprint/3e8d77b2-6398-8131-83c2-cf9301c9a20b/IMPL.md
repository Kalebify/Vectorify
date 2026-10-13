# IMPL.md — M3-S12 · Undo / Redo + Command History

## Resumen
Unificación de todas las mutaciones del editor bajo **EditorCommand v1** — un tipo serializable, JSON puro, versionado y sin SVG —, historial de sesión
completo con `jumpTo` y **HistoryPanel**, metadata de capa dentro del historial con PATCH inverso robusto, y un ejecutor declarativo listo para que la IA de
MVP 4 emita los mismos comandos sin tocar la geometría. Solo frontend; ASP.NET Core y Python sin cambios.
(La sesión del implementador se cortó por el límite semanal de la API; el árbol estaba completo con 2911 tests verdes al retomarla.)

## Decisiones
- **EditorCommand v1** (`lib/editor/commands.ts`): `{ version: 1, id, sequence, type, label, targets: { layerIds, objectIds }, parameters: Record<string, JsonValue>, origin: "user"|"ai"|"system", timestamp }`. NUNCA lleva `d` ni SVG crudos — así el historial es exportable y la IA nunca ve geometría. Un `COMMAND_REGISTRY` cierra el registro de tipos con `label` por defecto, esquema de `parameters`, si es ejecutable y, si no, el motivo. `COMMAND_TYPES` cubre los 40+ tipos de MVP 3 (object.*, path.*, document.*, selection.*, arrange.*, geometry.*, layer.*).
- **`HistoryEntry = { command, patch }`**: la descripción declarativa cuelga de cada entrada; el `EditorEdit` (snapshots `before/after` de S01–S03) sigue siendo el mecanismo de reversión exacta. El comando describe; el parche revierte.
- **Historial en `useEditableDocument`**: lista de `HistoryEntry` con puntero de posición (past/future), `undo`/`redo`/`jumpTo(entryId)` (deshace/rehace varios pasos atómico), `canUndo`/`canRedo`, `undoLabel`/`redoLabel`/`undoCommand`/`redoCommand`, `historyEntries` para el panel, `exportHistory()` sin parches ni SVG, límite configurable (default 200) con aviso de truncado en el panel. Una nueva acción descarta la rama redo.
- **Fusión por `coalesceKey`** conservada: nudges consecutivos producen un solo comando con `parameters` acumulados. Un gesto completo = un comando (la pila crece 1 por gesto).
- **Metadata de capa en el historial** (pendiente de S03): renombrar, bloquear/desbloquear, operación de fabricación, reordenar, visibilidad entran como comandos `layer.*`. Para capas del servidor el undo/redo re-persiste el valor anterior/siguiente con el mismo PATCH (`persistLayerMeta`); un fallo del PATCH inverso no corrompe nada — estado local intacto, puntero sin moverse, error visible con `HistoryNotice`. Mientras hay un PATCH en vuelo, undo/redo quedan deshabilitados.
- **`commandExecutor.ts`**: `executeCommand(host, input)` valida (tipo conocido y ejecutable, esquema, ids existentes, capas bloqueadas/ocultas, rangos, sin SVG crudo) y ejecuta por el mismo camino de UI (`applyEdit` con planificadores puros: move/scale/rotate/delete/align/distribute/zorder/fill/recolor/setBounds/paste/duplicate/crop/flip). Devuelve `{ ok, command?, errors[] }`. Los tipos que necesitan servidor (boolean/offset/split/bridge), gesto (draw/erase/path) o PATCH (layer metadata) se marcan `executable: false` en el registro. Regla de oro: nunca recibe ni devuelve SVG.
- **UI**: botones Undo/Redo del header con `title` mostrando la siguiente acción ("Deshacer: Mover 3 objetos") y estado deshabilitado; panel/popover **HistoryPanel** accesible desde el header (lista cronológica, posición marcada, entradas futuras atenuadas, clic/Enter = `jumpTo`, `aria-live`, navegable por teclado). Aviso visible en el panel cuando el historial se reinicia (cambio de documento) o trunca (límite).
- **Auditoría de call-sites**: todos los `applyEdit`/`commitGesture` en EditorShell, VectorCanvas, useCutTool, useDrawEraseTools, useFloatingTool, usePathTool y hooks de panel actualizados para aportar `type` + `targets` + `parameters` + `origin: "user"`.

## Entregado
- **`lib/editor/commands.ts`** (1018 líneas): `EditorCommand` v1, `COMMAND_TYPES`, `COMMAND_REGISTRY` (40+ tipos), `HistoryEntry`, `buildCommand`, `isCommandType`, `validateParameters`, `findRawGeometry`, `exportCommands`.
- **`lib/editor/commandExecutor.ts`** (397 líneas): `executeCommand`, tipos de error, validaciones, ruta por los planificadores puros.
- **`lib/editor/commandDrafts.ts`** (37 líneas): helpers para construir drafts de comandos de color.
- **`lib/editor/operations.ts`** (41 líneas): `moveProduction`, `scaleProduction`, `rotateProduction`, `setBoundsProduction`, `objectsByIds` — planificadores puros usados por el ejecutor.
- **`hooks/useEditableDocument.ts`** (actualizado): `HistoryEntry`, `HistoryEntryView`, `HistoryNotice`, `JumpResult`, `jumpTo`, `historyEntries`, `exportHistory`, `historyNotice`, límite configurable con aviso, reinicio al cambiar documento.
- **`hooks/useVectorDocument.ts`** (actualizado): `persistLayerMeta` expuesto, lógica de PATCH inverso con abort y conteo.
- **`components/editor/HistoryPanel.tsx`** (169 líneas): panel/popover con lista cronológica, posición actual marcada, entradas futuras atenuadas, `jumpTo` por clic/Enter, teclado completo, aviso de truncado/reinicio.
- **`components/editor/EditorHeader.tsx`** (actualizado): botones Undo/Redo con label dinámico en `title`, estado deshabilitado con motivo.
- **`components/editor/EditorShell.tsx`** + VectorCanvas + hooks de herramientas: call-sites auditados con `CommandDraft`.
- **`docs/EDITOR_COMMANDS.md`** (768 líneas): referencia completa de cada tipo (parámetros, validaciones, ejemplo JSON, ejecutable o no).
- ADR actualizado con sección M3-S12.
- **Tests**: 50 archivos de test, 2911 tests en verde.

## Desviaciones / hallazgos
- `operations.ts` separado de `clipboard.ts` para evitar dependencias circulares: el ejecutor importa planificadores puros sin arrastrar la lógica de clipboard de React.
- `findRawGeometry` en `commands.ts` rechaza parámetros con claves o valores que parezcan SVG/d-path crudos antes de que lleguen al registro — defensa en profundidad contra una IA que intente colar geometría.
- `layer.metadata` y `layer.create` marcados `executable: false` en el registro (requieren PATCH o flujo de servidor); el resto de los `layer.*` son ejecutables.
- `beforeunload`/`geometryDirty` de S01 no se tocan; el aviso al usuario de ediciones sin guardar sigue funcionando independientemente del historial.

## Verificación (orquestador, independiente del implementador)
- `npm test`: **2911/2911** en verde (119 archivos).
- `npm run build`: limpio (un warning de chunk size pre-existente, sin errores TS ni Vite).
- `npm run lint`: solo warnings pre-existentes en `spike-editor-engine/` y `App.tsx` (sin errores nuevos de S12).
- `dotnet build`: falla por lock de OneDrive/MSBuild en el target `CoreGenerateAssemblyInfo` — problema de sistema pre-existente, no de código. S12 no toca el backend (cero cambios en `backend/`). Misma situación que S09 con Docker.
- Python: sin cambios.
