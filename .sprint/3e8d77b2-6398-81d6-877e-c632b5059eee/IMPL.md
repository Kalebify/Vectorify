# IMPL.md — M3-S07 · Align / Distribute / Z-order

## Resumen
Alinear (6 modos), distribuir (≥ 3) y reordenar (4 acciones) objetos, con precisión, locks respetados y un comando undoable por
operación. Solo frontend. Spec: `spec.md`.

## Decisiones
- **Referencia**: *Selección* (bounds de la unión de los objetos movibles, ≥ 2) o *Documento* (marco vigente de S02, también con 1
  objeto). Se usan los **bounds geométricos exactos** (curvas y `matrix`; el ancho de trazo no cuenta).
- **Distribuir**: huecos iguales entre bounds consecutivos (horizontal/vertical), extremos fijos, orden por posición con desempate
  estable por orden de pintado; solapados ⇒ huecos negativos iguales, informado; < 3 ⇒ deshabilitado con motivo.
- **Bloqueados (y ocultos)**: excluidos por completo — ni se mueven ni cuentan para la referencia o los huecos; se informa.
- **Z-order solo dentro de la capa** de cada objeto (permutación del array de la capa con las mismas referencias ⇒ `layerGroupId`
  e ids no pueden cambiar); "un paso" = salto sobre el vecino **no seleccionado** más cercano; frente/fondo = partición estable;
  varias capas en UN comando; límite ⇒ sin comando.
- Alinear/distribuir = **traslaciones** (se compone la `matrix`, `d` intacto); umbral de "ya alineado" 1e-9 ⇒ sin comando.

## Entregado
`lib/editor/arrange.ts` (puro: `alignProduction`, `distributeProduction`, `zOrderProduction`, `runArrange`,
`arrangeAvailability`, `matchArrangeShortcut`), `ArrangeBar.tsx` (referencia + 6 alinear + 2 distribuir + 4 orden, iconos SVG,
`aria-label`, motivo en tooltips), integración en `EditorShell` (un `applyEdit` por operación, atajo global Ctrl/Cmd+`]`/`[` con
`Shift`, reconocido por `code` además de `key`, ignora Alt/AltGr), `extraShortcuts` en `ClipboardBar` (un solo panel "Atajos").

## Hallazgos / efectos laterales
- El canvas hacía zoom con "+"/"=" ignorando modificadores y con `preventDefault`; en teclados es-ES/de-DE la tecla física
  `BracketRight` escribe "+", así que se llevaba el atajo. Guardia en `VectorCanvas` (solo con selección editable): efecto lateral —
  con algo seleccionado y el canvas enfocado, Ctrl++ ya no hace zoom en esos teclados ("+" a secas y la rueda siguen funcionando).
- Render, hit-test (gana el de más arriba), miniatura y selección respetan el nuevo orden sin cambios (cada uno con test);
  `countChangedObjects` ya contaba reordenamientos ⇒ `geometryDirty` funciona.

## Verificación (orquestador)
`npm test` 1928/1928 · `npm run build` limpio · `npm run lint` 0 errores · `dotnet build` 0/0. 33 mutaciones del implementador,
todas detectadas. No se ejercitó con la UI real en un navegador (jsdom).
