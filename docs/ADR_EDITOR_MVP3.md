# ADR — Arquitectura del editor de MVP 3 (M3-S01 … M3-S16)

Estado: **aceptado** (M3-S01). Decide una vez las bases que todas las tarjetas de MVP 3 comparten, para que
no se rediseñen en cada sprint. Si una tarjeta necesita desviarse, lo deja escrito en su `spec.md`/`IMPL.md`.

## Contexto

Al cerrar MVP 2.2 el documento persistente es un `VectorDocument` con **capas** (una por color); cada capa
guarda un SVG (Asset) con N `<path>`. El editor (`EditorShell` + `VectorCanvas`, Konva) hoy *solo muestra* ese
SVG: parsea cada capa (`lib/svgTransform.ts: parseLayerSvg`) a `{d, fill, transform}` y la dibuja. Las únicas
mutaciones son metadata de capa (nombre, orden, visible, locked, operación), que se persisten por `PATCH`.
MVP 3 convierte esto en un editor: seleccionar/mover/transformar objetos, dibujar/borrar, nodos Bézier,
booleanas/offset/cortes, puentes, undo/redo, autosave de **geometría**, checker integrado y export.

## Decisiones

### D1. Objeto editable = un `<path>` de una capa
`EditorObject = { id, layerGroupId, d, fill, matrix }`:
- `id`: estable y único en el documento (UUID). Se preserva en `data-vid` del `<path>` al serializar; si el SVG
  de origen no lo trae se genera al cargar (y se persiste en el primer guardado de geometría, M3-S13).
- `d`: path data original (**fuente de verdad geométrica**, nunca se re-escribe para un simple move/scale/rotate).
- `matrix`: `AffineMatrix` (`lib/svgTransform.ts`) con el transform acumulado del objeto. Las transformaciones
  de S01–S02 componen la matriz (no destructivo, exacto). Las operaciones que necesitan geometría real
  (booleanas, offset, corte, nodos) **hornean** la matriz en `d` (`bakeMatrix`) antes de operar.
- Un objeto nunca cambia de capa salvo comando explícito (Move to layer, S06/S07).

Coordenadas: **espacio de documento** = unidades del `viewBox` del VectorDocument (px de origen); el
**espacio de pantalla** (viewport Konva: zoom/pan) se convierte con `useCanvasTransform`. **mm** = unidades de
documento × `mmPerUnit`, con `mmPerUnit = widthMm / viewBoxWidth` (helper único `lib/editor/units.ts`; el
Inspector muestra y acepta mm). Ninguna operación guarda coordenadas de pantalla.

### D2. Estado editable y comandos (undo/redo desde S01)
- `EditableDocument` (en memoria, `lib/editor/`) = `{ objectsByLayer: Record<layerGroupId, EditorObject[]> }`
  derivado de los SVG de las capas. La metadata de capas sigue en `useVectorDocument` (PATCH, M2.2).
- Toda mutación geométrica pasa por **un único punto**: `applyEdit(label, producer)` del hook
  `useEditableDocument`. `producer(state)` devuelve `{ layers: { [layerGroupId]: EditorObject[] } }` con las
  capas **tocadas**; el comando guarda `before`/`after` de esas capas (snapshots inmutables). `undo` restaura
  `before`, `redo` restaura `after`. Es determinista y serializable (`{label, touched layers, before, after}`),
  apto para historial de sesión (S12) y para IA futura.
- Gestos continuos (drag/scale/rotate) generan **un** comando al soltar (no uno por frame); durante el gesto la
  vista usa un estado transitorio.
- Respeta `locked`: ninguna herramienta modifica objetos de una capa bloqueada (la selección sí puede incluirlos
  para inspeccionar, pero los comandos los filtran y lo informan). Capas ocultas no se seleccionan.
- Pila de undo en memoria, límite razonable (p. ej. 200 comandos) con descarte del más viejo.
- `geometryDirty`: indica ediciones de geometría sin persistir. **Limitación intermedia**: hasta M3-S13 las
  ediciones viven solo en memoria; mientras `geometryDirty`, el editor avisa (`beforeunload`) y el indicador
  de guardado lo refleja con honestidad (nunca "Guardado" si hay geometría sin persistir).

### D3. Render y selección
`VectorCanvas` renderiza **desde el EditableDocument** (no desde el SVG crudo): un `<Path>` Konva por objeto,
`matrix` → props Konva (`decomposeMatrix`). Selección por objeto (ids), Shift = multi, marquee, hit-testing de
Konva. La selección por capa (`selectedGroupId`, M2.1) se conserva y coexiste (seleccionar un objeto selecciona
su capa activa). Transformer de Konva para bounding box y handles.

### D4. Geometría pesada en el servidor, sin estado
Booleanas, offset, corte, puentes y análisis de piezas flotantes (S08–S11, S14) usan **Shapely** en el
motor Python (ya en `requirements.txt`) detrás de endpoints **sin estado** que reciben la geometría (paths
horneados en unidades de documento + factor mm) y devuelven la geometría resultante; ASP.NET Core los expone
bajo `/api/v2/geometry/*` (misma arquitectura proxy que el resto: Endpoint → Servicio → cliente Python,
`ApiErrorResponse` uniforme, ownership vía `IUserContext` donde corresponda). El cliente aplica el resultado
como un comando (undoable). Resultados siempre validados (geometría válida, sin NaN, sin paths vacíos) y
tolerancias explícitas (en mm).

### D5. Persistencia de geometría (M3-S13)
Serialización `EditableDocument → SVG por capa` (mismo formato de origen, `<path data-vid d fill transform>`)
y un endpoint que recibe las capas modificadas y crea **una `DocumentVersion` nueva** (Origin `MANUAL_EDIT` o
`AUTOSAVE`, SVG nuevo por capa tocada; versiones inmutables, idempotencia, ownership, como en M2.2). Invariante
de round-trip: `parse(serialize(doc))` ≡ `doc` (ids, d, fill, matriz) — se prueba desde S01.

### D6. Reglas transversales
- Sin dependencias nuevas salvo necesidad demostrada y documentada (Shapely ya existe).
- Cada tarjeta: tests de lógica pura en `lib/editor/*` (sin DOM) + tests de componentes + (si hay backend)
  tests de integración; `npm run build` además de `npm test`.
- Accesibilidad: toda herramienta operable por teclado donde sea razonable; foco gestionado; `aria-*`.
- Rendimiento: documentos de ≥ 5 000 paths no deben bloquear la UI en selección/drag (memoización por objeto,
  sin re-renderizar todas las capas por frame).

## Consecuencias
- Un solo mecanismo de comandos hace S06/S12 (copy/paste, undo/redo, historial) una extensión, no una reescritura.
- Hornear matrices solo cuando hace falta evita degradar geometría con transforms triviales.
- El riesgo asumido: edición en memoria hasta S13 (mitigado con `geometryDirty` + aviso).

## Mapa de tarjetas
S01 base (modelo, comandos, selección, move/scale/rotate) · S02 crop/rotate/flip · S03 fill/recolor/eyedropper ·
S04 draw/erase · S05 nodos/Bézier · S06 copy/paste/duplicate/delete · S07 align/distribute/z-order ·
S08 booleanas (servidor) · S09 offset (servidor) · S10 corte (servidor) · S11 puentes/piezas flotantes (servidor) ·
S12 historial unificado (incluye metadata de capas) · S13 autosave de geometría + historial de versiones ·
S14 Laser Checker integrado · S15 export avanzado · S16 E2E + release candidate.
