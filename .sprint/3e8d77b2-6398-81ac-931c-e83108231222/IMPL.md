# IMPL.md — M3-S03 · Fill + Recolor + Eyedropper

## Resumen
Fill, Recolor (con alcance explícito) y Eyedropper, sin usar el hex como identidad. Solo frontend. Spec:
`spec.md`; arquitectura: `docs/ADR_EDITOR_MVP3.md`.

## Decisión de dominio
Una **capa = un color de paleta** (1:1). La identidad de un color es el `groupId` de la capa, nunca su hex:
dos capas con el mismo hex siguen siendo capas distintas en Fill, Recolor, Eyedropper y fusión (test dedicado
en lib, hook y shell). Fill = mover los objetos a la capa del color elegido; un color libre **nuevo** crea una
**capa nueva explícita** (`isNew`, nombre "Color #RRGGBB", orden al final) en el **mismo comando** (undo la
elimina). Recolor: *selección* (como Fill), *capa* (cambia el color de la propia capa; mismo `groupId`) y
*documento* (capa origen elegida; misma operación que *capa*). La **fusión** con otra capa de igual hex es
siempre explícita y confirmada: la capa origen queda vacía (no se borra) y se informa. Eyedropper toma la
**capa** del objeto visible más arriba (lee de capas bloqueadas, no de ocultas); no muestrea píxeles.

## Entregado
- `lib/editor/colors.ts` (hex, `findLayersByHex` solo para ofrecer coincidencias, `buildFillProduction`,
  `planRecolor`/`buildRecolorProduction`, `summarizeRecolor`, `needsConfirmation`, `eyedrop`) y
  `lib/editor/layers.ts` (snapshots de estructura, orden fraccional para capas nuevas).
- `EditorEdit` gana `layers?: {before, after}` (como `frame` en S02): un comando cambia **objetos + estructura
  de capas** de forma atómica; `EditProduction.atomic` hace que un movimiento entre capas sea todo-o-nada.
  `useEditableDocument` expone las capas **efectivas** (servidor + overrides + `isNew`) y `geometryDirty`
  cuenta la estructura.
- UI: `ColorPanel` (selector + hex validado + swatches + scope visible + preview con gesto + resumen +
  confirmación a partir de 50 objetos o alcance documento/fusión + Apply/Cancel por teclado), `EyedropperPanel`
  (atajo `I`), Fill/Color/Eyedropper habilitados en el toolbar, `PaletteBar`/`EditorLayersPanel` con insignia
  "nueva" y color activo, Inspector con fila de color.
- Metadata de capas `isNew` se edita **localmente** (sin PATCH/POST: no existen en el servidor); las capas del
  servidor siguen con PATCH. El `TODO(M3-S13)` ahora cubre capas nuevas y colores cambiados.

## Decisiones menores / desviaciones
- Capas ocultas no se recolorean ni son destino de Fill; capas bloqueadas se rechazan con el motivo.
- Mover objetos a una capa nueva cambia su orden de pintado (la capa va al final).
- **Cambio de comportamiento de S01**: cuando cambia el `svgUrl` de una capa cargada (documento regenerado) se
  descartan **todas** las ediciones sin guardar, no solo las de esa capa (mantener las demás dejaría ids
  duplicados al haber objetos movidos entre capas).
- Los cambios de metadata de capas `isNew` no entran al historial hasta M3-S12.

## Hallazgos
- El Transformer no se re-enganchaba cuando Konva recreaba nodos con el mismo id (deshacer un movimiento entre
  capas): corregido con una clave de pertenencia.
- `useVectorDocument.reorderLayers` exige la lista completa (el shell manda solo ids del servidor);
  `selectAllInLayer` ignora capas desconocidas (el shell usa `selectGroup` para las nuevas).
- Preexistente: `V`/`H` figuran en títulos del toolbar pero no están implementadas.

## Verificación (orquestador)
`npm test` 1103/1103 · `npm run build` limpio · `npm run lint` 0 errores · `dotnet build` 0/0. 18 mutaciones del
implementador, cada una rompe exactamente un test (hex como identidad, undo sin quitar la capa, fusión
implícita, eyedropper en ocultas, PATCH para capa nueva, sin filtro atómico, umbral, preview llenando la pila…).
