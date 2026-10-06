# spec.md — M3-S01 · Selección + Move + Transform

> Lee primero `docs/ADR_EDITOR_MVP3.md`: define el modelo (`EditorObject`), los comandos (`applyEdit`), las
> coordenadas (documento vs. pantalla vs. mm) y el mapa de tarjetas. Este sprint **construye esa base** y la
> primera herramienta sobre ella. Todo lo que se decida acá lo reusan S02–S16: priorizá APIs puras, pequeñas y
> testeadas en `frontend/src/lib/editor/`.

## Contexto
Primer sprint funcional del editor tras MVP 2.2. Trabaja con **objetos/paths completos**, no con nodos.
Criterio (Notion): "Single/multi-select, move, scale y rotate funcionan sobre geometría real, respetan locks y
pueden deshacerse sin corromper SVG." DoD: "Editar objetos completos es estable, reversible y persiste
correctamente" (la persistencia a la base llega en M3-S13: acá se exige el **round-trip de serialización**
probado y el aviso de geometría sin guardar — ver ADR D2/D5).

## Alcance

### 1. Base `lib/editor/` (lógica pura, sin React ni DOM; tests unitarios exhaustivos)
- `types.ts`: `EditorObject { id, layerGroupId, d, fill, matrix: AffineMatrix }`, `EditableDocument`,
  `EditorEdit { label, touched: Record<layerGroupId, {before: EditorObject[], after: EditorObject[]}> }`.
- `pathGeometry.ts`: parser de path data SVG completo y robusto (M/L/H/V/C/S/Q/T/A/Z, absolutos y relativos,
  números sin separador, notación científica, comas/espacios) → segmentos absolutos normalizados (arcos →
  cúbicas); `pathBounds(d, matrix?)` (bbox exacto de curvas, no solo de puntos de control);
  `transformPathData(d, matrix)` (hornear: devuelve `d` nuevo con la matriz aplicada, preserva curvas).
  Debe tolerar entrada degenerada sin lanzar (devuelve bbox vacío / `d` original) — será la base de S02/S05/S08.
- `units.ts`: `mmPerUnit(widthMm, viewBoxWidth)`, `toMm`/`fromMm`. Un único lugar para la conversión.
- `objects.ts`: `parseEditableLayer(svgText, layerGroupId, fallbackFill)` → `EditorObject[]` (ids de `data-vid`
  o UUID nuevos; transform propio+ancestros → `matrix`; reusar `parseSvgTransformAttribute`/
  `multiplyMatrices`), `serializeEditableLayer(objects, meta)` → SVG de capa (`<path data-vid d fill
  transform>`), `bounds(objects)`, `hitTest(objects, point)` (punto en documento; exacto sobre el relleno del
  path, con tolerancia en px de pantalla convertida a unidades de documento), `objectsInRect(objects, rect)`
  (marquee: intersección de bbox).
- `transform.ts`: `translate`, `scaleAbout(pivot, sx, sy)`, `rotateAbout(pivot, degrees)` sobre objetos
  (componen `matrix`; no tocan `d`); `setBounds(objects, targetBounds)` para valores numéricos del Inspector;
  proporcional con Shift; `groupBounds` para multi-selección. Aritmética estable (sin acumular error: la matriz
  se recompone desde el estado "antes" + el gesto, no incrementalmente por frame).
- **Round-trip**: `parse(serialize(objects))` ≡ `objects` (ids, `d`, fill, matriz con tolerancia 1e-9). Test
  con SVGs reales de vtracer (ver fixtures existentes en tests del backend/frontend) y casos con `<g transform>`.

### 2. Estado: `hooks/useEditableDocument.ts`
- Carga las capas del `VectorDocument` (fetch del `svgUrl` de cada capa **una vez**, reutilizando la carga que
  hoy hace `VectorCanvas`, que se mueve a este hook) y expone `objectsByLayer`, estado de carga/error por capa.
- `applyEdit(label, producer)` como en el ADR D2; `undo()`, `redo()`, `canUndo`, `canRedo`, límite 200,
  `geometryDirty`. Un edit nuevo descarta la rama redo. Gestos continuos: `beginGesture()`/`previewEdit()`/
  `commitGesture(label)`/`cancelGesture()` (un único comando al soltar).
- Filtra por `locked` (no modifica capas bloqueadas; informa cuántos objetos se omitieron) y por visibilidad.

### 3. Canvas y herramienta Select (`VectorCanvas`, `EditorShell`, `EditorToolbar`)
- Render desde `objectsByLayer` (un `<Path>` Konva por objeto; ya no desde el SVG crudo). Memoizar por objeto:
  documentos grandes no se re-renderizan completos por frame.
- Selección: click (single), **Shift+click** (toggle), **marquee** (arrastre en fondo vacío, Shift = agregar),
  Ctrl/Cmd+A (todo lo seleccionable), Escape (limpiar), click en fondo limpia. Selección por **ids de objeto**.
  Objetos superpuestos: el click selecciona el de más arriba; click repetido sobre la misma pila cicla hacia
  abajo (Alt+click). Capas ocultas no se seleccionan; capas bloqueadas se pueden seleccionar para inspeccionar
  pero muestran candado y **no se mueven/transforman** (feedback visible al intentarlo).
  La selección de capa existente (`selectedGroupId`/panel de capas) se mantiene y se sincroniza: seleccionar un
  objeto activa su capa; seleccionar una capa en el panel mantiene el comportamiento actual.
- **Move**: drag de la selección; flechas = 1 unidad de documento, Shift+flecha = 10 (o 0,1 mm / 1 mm — elegí
  una convención coherente y documentala; que no dependa del zoom). Snap opcional **no** (fuera de alcance).
- **Scale/Rotate**: `Konva.Transformer` con bounding box y handles (esquinas = proporcional por defecto,
  Shift invierte; rotación con handle; Shift = pasos de 15°); el resultado se expresa como matrices (no mutar
  `d`). Funciona con multi-selección (bbox de grupo, pivote = centro del grupo).
- Teclado: Delete/Backspace elimina la selección (comando simple; el Delete completo de S06 lo extiende),
  Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y undo/redo (con foco en el canvas, sin pelear con inputs de texto), botones
  Undo/Redo visibles en el header/toolbar con estado disabled correcto y `aria-label`.
- Toolbar: `Select` hace todo lo anterior; el botón `Move` queda habilitado como "mover sin handles" (drag-only,
  sin Transformer) — documentalo. El resto de las herramientas siguen deshabilitadas ("llega en MVP3").
- Rendimiento: 5 000 paths no bloquean selección/drag (probar con un test de humo con tiempo razonable, sin
  umbrales frágiles).

### 4. Inspector (`InspectorPanel`)
Selección de objetos: X, Y, ancho, alto (**mm**, bbox en espacio de documento convertido con `mmPerUnit`),
rotación (grados) y capa. Edición numérica con Enter/blur → un comando; valores inválidos se rechazan con
mensaje y no cambian nada; proporcional con candado opcional. Multi-selección muestra bbox del grupo
("Varios"). Capa bloqueada: campos deshabilitados con explicación. El Inspector de capa existente no cambia.

### 5. Guardado honesto
`geometryDirty` → el indicador de guardado del header **no** dice "Guardado" si hay geometría sin persistir
(ADR D2): muestra "Cambios de geometría sin guardar" y `beforeunload` avisa. No se implementa persistencia de
geometría acá (M3-S13). Dejar un `TODO(M3-S13)` único y claro en el punto de integración.

## Fuera de alcance
Nodos Bézier, booleanas, crop/rotate/flip del documento (S02), Draw/Erase (S04), copy/paste/duplicate (S06),
align/distribute (S07), historial como panel (S12), persistencia de geometría (S13), snap/guías, IA.

## Tests exigidos
- `lib/editor/*`: parser de path (casos límite: relativos, arcos, números pegados, científica, mal formado),
  bbox de curvas, hornear, matrices (compose/scale/rotate/pivote), round-trip, hit-test (relleno vs. hueco,
  tolerancia a distintos zooms), marquee, transform numérico, lock.
- `useEditableDocument`: carga, applyEdit/undo/redo/redo-descartado, gestos (un solo comando), límite de pila,
  filtro de bloqueadas, `geometryDirty`.
- Componentes: selección single/multi/marquee/Alt-cycle, move por drag y por teclado, transformer
  (scale/rotate) y Inspector numérico, lock, zoom alto/bajo, undo/redo por teclado y botones, `beforeunload`.
  Los mocks de `fetch` respetan `AbortSignal` (lección de M2.2).
- Los 5 comandos: `dotnet build`, `dotnet test`, `pytest`, `npm test`, `npm run build` (backend/Python no se
  tocan salvo necesidad demostrada; correrlos igual).

## DoD
Seleccionar y mover/escalar/rotar objetos reales (single y multi) funciona, respeta locks, se deshace/rehace sin
corromper el SVG (round-trip probado) y el editor nunca afirma "Guardado" con geometría sin persistir.
