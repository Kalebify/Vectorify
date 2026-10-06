# IMPL.md — M3-S01 · Selección + Move + Transform

## Resumen
Base del editor de MVP 3 (ver `docs/ADR_EDITOR_MVP3.md`) + primera herramienta: selección single/multi/marquee,
move/scale/rotate de objetos reales, Inspector en mm, undo/redo. Solo frontend.

## Entregado
- **`frontend/src/lib/editor/`** (lógica pura, reusable por S02–S16): `types`, `units` (`mmPerUnit`),
  `viewport` (pantalla↔documento), `matrix` (rotación exacta en múltiplos de 90°, `matrixToKonvaProps`
  verificada contra `Konva.getTransform()`), `pathGeometry` (parser M/L/H/V/C/S/Q/T/A/Z, bbox exacto de curvas,
  hornear matrices, aplanado), `objects` (parse/serialize round-trip, hit-test con tolerancia en px de pantalla,
  marquee), `transform` (translate/scale/rotate recompuestos desde el estado "antes"), `selection`.
- **`hooks/useEditableDocument.ts`**: carga cada capa una vez (AbortController, reintento), `applyEdit` con
  snapshots before/after, undo/redo (límite 200), gestos (`beginGesture/previewEdit/commitGesture`: un solo
  comando al soltar), filtro de capas bloqueadas/ocultas que informa cuántos objetos omitió, `geometryDirty`
  calculado contra lo cargado (no contando comandos).
- **Canvas**: render desde el modelo editable (un `<Path>` memoizado por objeto), Transformer en un Layer sin
  escala (handles de tamaño constante), selección por ids, Shift/marquee/Alt-cycle, nudge por teclado
  (1 u, Shift 10 u; ráfagas de 1 s = un comando), Delete, Ctrl+Z/Shift+Z/Y.
- **Inspector de objetos** (mm, rotación, capa; edición numérica = un comando), botones Undo/Redo, botón Move
  ("mover sin handles").
- **Guardado honesto**: con `geometryDirty` el indicador muestra "Cambios de geometría sin guardar" y hay
  `beforeunload` + `window.confirm` en "← Projects". `TODO(M3-S13)` único en `EditorShell`.
- La miniatura (`PreviewNavigator`) dibuja las capas editadas desde memoria.

## Decisiones menores / desviaciones del ADR
Hit-test geométrico propio (no el de Konva) por Alt-cycle, tolerancia en px y rendimiento con 5 000 paths;
undo/redo ignoran el lock (para no trabar el historial); `decomposeMatrix` del visor M2.1 no se usa en el
editor (tiene bugs de skew/reflejo que no afectaban al visor, ver abajo); "Seleccionar todo en la capa" ahora
selecciona objetos.

## Hallazgos en código previo
- `svgTransform.decomposeMatrix`: `skewX` en grados (Konva espera tangente) y `scaleY` siempre ≥ 0 (pierde
  reflejos). No afecta al visor (vtracer solo emite `translate`); el editor usa `matrixToKonvaProps`.
- El `VectorCanvas` anterior cargaba SVG sin `AbortController`.
- `PreviewNavigator` dibujaba siempre el `svgUrl` original (corregido con overrides).

## Limitaciones conocidas
- Persistencia de geometría: M3-S13 (hasta entonces las ediciones viven en memoria y el editor lo dice).
- Konva no arrastra handles en jsdom: los tests del Transformer disparan `transformstart/end` sobre el nodo
  (prueban la composición de matrices, undo y lock; no la matemática interna de los anchors de Konva).

## Verificación (orquestador)
`npm test` 722/722, `npm run build` limpio, `npm run lint` sin errores (5 warnings preexistentes), `dotnet
build` 0/0. Backend y Python sin cambios: `dotnet test`/`pytest` no se re-ejecutan en tarjetas solo-frontend
(se corren en tarjetas con backend y en el release candidate S16).
