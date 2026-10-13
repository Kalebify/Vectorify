# spec.md — M3-S12 · Undo / Redo + Command History

> Lee primero `docs/ADR_EDITOR_MVP3.md` (D2: comandos con snapshots `before/after`) y los `IMPL.md` de M3-S01..S11
> (`.sprint/<card_id>/IMPL.md`). La base ya existe: `useEditableDocument` mantiene la pila de undo/redo (límite 200, gestos = un comando,
> fusión por `coalesceKey`, `geometryDirty`), y `EditorEdit` lleva `{label, touched, frame?, layers?}`. **Esta tarjeta unifica y formaliza**
> eso: no reescribas el motor de snapshots, extendelo.

## Contexto (cuerpo de la tarjeta)
Objetivo: "Unificar las mutaciones del editor bajo comandos reversibles y ofrecer historial de sesión confiable." Criterio: "Todas las
operaciones mutantes soportadas por MVP 3 generan comandos coherentes; Undo/Redo recupera geometría, layers y propiedades sin corrupción."
- **Arquitectura**: `EditorCommand` **versionado**: `type`, `targets`, `parameters`, metadata `before/after` cuando haga falta, `timestamp`
  y `origin`.
- **Granularidad**: un drag completo = un comando; un gesto de edición de nodo = un comando; **nunca una entrada por frame**.
- **UX**: header Undo/Redo con estado deshabilitado y **descripción opcional de la siguiente acción**.
- **Integración**: preparar el modelo para que **MVP 4 (IA) emita los mismos comandos, sin darle acceso directo al SVG**.
- **Tests**: secuencias mixtas, 50+ acciones, redo invalidado tras nueva rama, "reload según alcance" y errores.
- DoD: "El editor puede experimentar sin miedo a perder trabajo reciente."

## Decisiones (documentalas en IMPL.md, ADR y `docs/EDITOR_COMMANDS.md`)
1. **`EditorCommand` v1** (tipo serializable, JSON puro, en `lib/editor/commands.ts`):
   `{ version: 1, id, sequence, type, label, targets: { layerIds: string[], objectIds: string[] }, parameters: Record<string, JsonValue>,
   origin: "user" | "ai" | "system", timestamp }`. Es la **descripción declarativa** de la operación; el **parche de deshacer** (snapshots
   `before/after` de objetos, `frame`, estructura de capas, metadata de capa) sigue siendo el `EditorEdit` interno de S01–S03 y cuelga del
   registro del historial (`HistoryEntry = { command, patch }`). Nunca se serializan paths/SVG crudos dentro de `parameters`: solo ids,
   números, enums y textos cortos (así el historial es exportable y revisable sin exponer el SVG).
2. **Registro de tipos** (`COMMAND_TYPES`, enum cerrado + `parameters` documentados por tipo) que cubre **todas** las operaciones mutantes
   de MVP 3: `object.move|scale|rotate|nudge|setBounds|delete`, `object.cut|paste|pasteInPlace|pasteToLayer|duplicate`,
   `object.fill|recolor|merge`, `object.draw|erase.objects|erase.subtract`, `path.moveAnchors|moveHandle|addNode|deleteNodes|setNodeKind|
   toggleSegment|closeSubpath|openSubpath|setNodeCoords`, `document.crop|rotate|flip`, `selection.rotate|flip`,
   `arrange.align|distribute|zorder`, `geometry.boolean|offset|split|bridge`, `layer.create` (implícita de Fill/Draw), y las de metadata de
   capa de la decisión 4. Un `type` desconocido es un error de programación (assert en dev; en test falla). Auditar **todos** los call-sites de
   `applyEdit`/`commitGesture` (EditorShell, VectorCanvas, useCutTool, useDrawEraseTools, useFloatingTool, usePathTool y los hooks de
   panel) y hacer que cada uno aporte `type` + `targets` + `parameters` + `origin` (por defecto `"user"`); `label` se deriva del tipo
   (i18n español) salvo override. Test de cobertura: cada tipo del registro es emitido por algún camino real de UI (tests de shell existentes
   o nuevos) y ningún `applyEdit` queda sin tipo.
3. **Historial de sesión** en `useEditableDocument` (o un hook hermano `useCommandHistory` si queda más limpio): lista inmutable de
   `HistoryEntry`, puntero de posición, `undo`, `redo`, **`jumpTo(entryId)`** (deshace/rehace varios pasos de una vez, atómico para la UI),
   `canUndo`/`canRedo`, `undoLabel`/`redoLabel`/`undoCommand`/`redoCommand`, `entries` (para el panel), `clear()`, `exportHistory()` (JSON de
   los `command`, sin parches), límite configurable (default 200; al desbordar se descarta el más viejo y se **avisa una vez** en el panel).
   Una acción nueva tras un undo **descarta la rama redo** (test). Fusión por `coalesceKey` conservada (nudges): un solo `command` con
   `parameters` acumulados.
4. **Metadata de capa dentro del historial** (pendiente declarado en S03: "no entran al historial hasta M3-S12"): renombrar, bloquear/
   desbloquear, cambiar operación de fabricación, reordenar, mostrar/ocultar. Para capas `isNew` es local. Para capas del **servidor** hoy se
   persiste por `PATCH` inmediato (M2.2): el undo/redo **debe re-persistir el valor anterior/siguiente con el mismo PATCH**. Política ante
   fallo del PATCH inverso: **no se corrompe nada** — el estado local no cambia, el puntero del historial no se mueve, se muestra un error
   recuperable y el usuario puede reintentar; mientras hay un PATCH inverso en vuelo, undo/redo quedan deshabilitados (una operación a la vez).
   `Isolate` y otros estados puramente de vista **no** son comandos.
5. **Ejecutor declarativo para IA (MVP 4)** — `lib/editor/commandExecutor.ts`: `executeCommand(input: { type, targets, parameters, origin })`
   que **valida** (tipo conocido, ids existentes, locks/visibilidad, rangos, esquema de `parameters`) y ejecuta por el MISMO camino que la UI
   (`applyEdit` con los planners puros existentes: translate/scale/rotate/delete/align/distribute/zorder/fill/recolor/setBounds/paste/duplicate…),
   devolviendo un resultado estructurado `{ ok, command?, errors[] }`. Cubrí **al menos** los tipos deterministas y sin servidor; los que
   necesitan servidor (boolean/offset/split/bridge) o gesto (draw/erase/path) se declaran `executable: false` en el registro con el motivo.
   Regla de oro: el ejecutor **nunca recibe ni devuelve SVG/`d` crudos** de la IA; solo ids y parámetros tipados. `docs/EDITOR_COMMANDS.md`
   documenta cada tipo (parámetros, validaciones, ejemplo JSON, si es ejecutable). Test: ejecutar un comando serializado produce **exactamente**
   el mismo estado que la ruta de UI equivalente, y los inválidos devuelven errores sin tocar el documento.
6. **UI**: (a) botones Undo/Redo del header muestran en su `title`/`aria-label` la **siguiente acción** ("Deshacer: Mover 3 objetos") y están
   deshabilitados con motivo; (b) **panel/popover "Historial"** accesible desde el header (lista cronológica con tipo, etiqueta, hora, objetos
   afectados; la posición actual marcada; las entradas "futuras" (redo) atenuadas; clic o Enter en una entrada = `jumpTo`; teclado completo,
   `aria-live`); (c) aviso visible cuando el historial se **reinicia** o se **trunca** (ver 7).
7. **Alcance del "reload" (documentar y probar)**: el historial es **de sesión y vive en memoria**: un reload/cierre lo pierde (la persistencia de
   versiones entre sesiones es M3-S13, "Version History"; no se mezcla). Se reinicia con aviso cuando el documento se regenera por debajo (cambia el
   `svgUrl` de una capa cargada, comportamiento de S03) y al cambiar de documento. `beforeunload`/`geometryDirty` de S01 siguen avisando de ediciones
   sin guardar. Documentalo en la UI del panel ("El historial dura mientras la sesión esté abierta").
8. **Errores y consistencia**: undo/redo nunca dejan el documento en un estado intermedio: si falla la parte asíncrona de un comando de metadata,
   se revierte lo local; un `applyEdit` rechazado (locks, vacío) no registra comando; una excepción dentro de un `producer` no corrompe la pila.

## Alcance técnico
Frontend principalmente (`lib/editor/commands.ts`, `commandExecutor.ts`, `useEditableDocument`, `EditorShell`, `EditorHeader`, `HistoryPanel.tsx`,
hooks de herramientas, `useVectorDocument` para el PATCH inverso). **ASP.NET Core / backend: sin cambios** — no hay endpoint de historial en esta
tarjeta (la validación de comandos de IA en el servidor es de MVP 4); decilo explícitamente en IMPL.md.

## Fuera de alcance
Persistir el historial entre sesiones o en el servidor (M3-S13/MVP 4), colaboración, undo selectivo (fuera de orden), historial por objeto, ejecutar
por IA los comandos que requieren servidor/gesto, nueva UI de la IA.

## Tests exigidos
- `commands.ts`: forma versionada, tipos del registro (cada uno con parámetros documentados), serialización JSON ida y vuelta, `exportHistory` sin
  parches ni SVG, asignación de `sequence`/`timestamp` (reloj inyectable), `origin`.
- Hook/historial: **secuencias mixtas** (objetos + frame + estructura de capas + metadata) con undo/redo/`jumpTo` exactos; **50+ acciones** (p. ej. 60)
  recorridas completas hacia atrás y adelante recuperando el estado inicial EXACTO (comparación profunda con el snapshot inicial); redo descartado tras
  nueva rama; límite y aviso de truncado (con límite pequeño inyectado); fusión por `coalesceKey` (nudges) = un comando; un gesto = un comando (la pila
  crece 1); `producer` que lanza no corrompe; rechazo por locks no registra.
- Metadata de capa: renombrar/bloquear/operación/reordenar/visibilidad **entran al historial**; undo/redo disparan el PATCH inverso (mock de `fetch` con
  `AbortSignal` y conteo de llamadas, método y cuerpo); **PATCH inverso que falla** ⇒ estado local intacto, puntero sin moverse, error visible, undo/redo
  deshabilitados mientras está en vuelo; capas `isNew` sin red.
- Cobertura de tipos: un test que recorre el registro y verifica que cada tipo es emitido por una ruta real (y que no hay `applyEdit` sin tipo).
- `commandExecutor`: cada tipo ejecutable produce el mismo estado que la ruta de UI; validaciones (id inexistente, capa bloqueada, parámetros fuera de rango,
  tipo desconocido, tipo no ejecutable) devuelven errores sin tocar el documento; nunca acepta ni devuelve `d`/SVG crudos.
- UI: botones con la siguiente acción, panel de historial (lista, posición actual, entradas futuras atenuadas, `jumpTo` por clic y por teclado, aviso de
  reinicio/truncado), atajos Ctrl/Cmd+Z/Shift+Z/Y siguen funcionando. StrictMode.
- La suite existente (S01–S11) debe seguir verde.
- Verificación: `npm test`, `npm run build`, `npm run lint` (sin errores nuevos), `dotnet build` (backend/Python sin cambios).

## DoD
Todas las operaciones mutantes de MVP 3 (incluida la metadata de capas) generan comandos versionados y tipados; Undo/Redo/`jumpTo` recuperan geometría,
capas y propiedades sin corrupción, también tras 50+ acciones; el historial es visible y navegable; y existe un ejecutor declarativo y documentado que
la IA de MVP 4 podrá usar sin tocar el SVG.
