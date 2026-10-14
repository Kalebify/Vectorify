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
- (M3-S04) Campos **opcionales** `stroke?: string` y `strokeWidth?: number` (unidades del espacio del propio
  objeto, como `d`) y `fill` puede ser `"none"`: así existen las **líneas abiertas** de Draw (`fill: "none"`,
  `stroke` = color de la capa). `serialize`/`parse` los conservan (`stroke`, `stroke-width`, `fill="none"`); los
  objetos de S01–S03 no los traen y no cambian. El color de una línea abierta es el de su trazo (Fill/Recolor
  pintan `stroke`, no `fill`).

Coordenadas: **espacio de documento** = unidades del `viewBox` del VectorDocument (px de origen); el
**espacio de pantalla** (viewport Konva: zoom/pan) se convierte con `useCanvasTransform`. **mm** = unidades de
documento × `mmPerUnit`, con `mmPerUnit = widthMm / viewBoxWidth` (helper único `lib/editor/units.ts`; el
Inspector muestra y acepta mm). Ninguna operación guarda coordenadas de pantalla.

### D2. Estado editable y comandos (undo/redo desde S01; historial de comandos en M3-S12)
- `EditableDocument` (en memoria, `lib/editor/`) = `{ objectsByLayer: Record<layerGroupId, EditorObject[]> }`
  derivado de los SVG de las capas. La metadata de capas del servidor sigue en `useVectorDocument` (PATCH, M2.2).
- Toda mutación geométrica pasa por **un único punto**: `applyEdit(draft, producer)` del hook
  `useEditableDocument` (o `commitGesture(draft)` para un gesto). `producer(state)` devuelve `{ layers: { [layerGroupId]: EditorObject[] } }`
  con las capas **tocadas**; el **parche** (`EditorEdit`) guarda `before`/`after` de esas capas (snapshots inmutables). `undo` restaura
  `before`, `redo` restaura `after`. Es determinista y la fuente de la reversión **exacta**.
- **Comandos versionados (M3-S12).** Cada entrada del historial es `HistoryEntry = { command, patch }`. El `patch` es el `EditorEdit` de arriba (el motor de
  snapshots **no se reescribió**). El `command` es un **`EditorCommand` v1** (`lib/editor/commands.ts`), JSON puro:
  `{ version: 1, id, sequence, type, label, targets: { layerIds, objectIds }, parameters, origin: "user" | "ai" | "system", timestamp }`. `type` sale de un
  **registro cerrado** de 44 tipos (`COMMAND_TYPES`/`COMMAND_REGISTRY`: `object.*`, `path.*`, `document.*`, `selection.*`, `arrange.*`, `geometry.*`, `layer.*`) que cubre
  TODAS las operaciones mutantes de MVP 3, incluida la metadata de capa; un tipo desconocido es un error de programación (lanza antes de tocar el documento). Los
  `targets` se derivan de lo que el parche realmente cambió; los `parameters` son números, enums, ids y textos cortos validados contra el esquema del tipo y
  **jamás** `d`, SVG, puntos ni matrices (así el historial se exporta y se revisa sin exponer la geometría y una IA puede emitir los mismos comandos sin tocar el SVG).
  Cada call-site de `applyEdit`/`commitGesture` aporta un `CommandDraft` (`type` + `parameters` + `origin`; `label` opcional): el compilador, `checkDraft` en ejecución y
  `commandCoverage.test.ts` impiden un `applyEdit` sin tipo o un tipo que ninguna ruta emita. Referencia completa, con parámetros por tipo y ejemplos:
  **`docs/EDITOR_COMMANDS.md`**.
- **Historial de sesión** (en `useEditableDocument`): lista lineal con puntero, `undo`/`redo`/`jumpTo(entryId)` (varios pasos de una vez), `canUndo`/`canRedo`,
  `undoCommand`/`redoCommand`, `historyEntries`, `clearHistory()`, `exportHistory()` (solo comandos, sin parches ni SVG) y límite configurable (200 por defecto: al desbordar se
  descarta el más viejo y el panel **avisa una vez**). Una acción nueva tras un undo descarta la rama de rehacer. Gestos continuos (drag/scale/rotate/nodos) generan **un** comando
  al soltar (no uno por frame; durante el gesto la vista usa un estado transitorio) y una ráfaga con la misma `coalesceKey` (flechas) se funde en un comando con los parámetros
  acumulados. **Alcance del reload:** el historial vive **en memoria**, solo en la sesión: recargar o cerrar lo pierde (persistir versiones es M3-S13) y se reinicia, con aviso
  visible, cuando el documento se regenera por debajo (cambia el `svgUrl` de una capa cargada) o se abre otro documento.
- **Metadata de capa dentro del historial (M3-S12).** Renombrar, bloquear, mostrar/ocultar, cambiar la operación de fabricación y reordenar son comandos sin objetos
  (`EditorEdit.meta`). Se registran **solo cuando el servidor confirma**; deshacer/rehacer **re-persisten el valor anterior/siguiente con el mismo PATCH** (PATCH v2 con proyecto
  guardado, sidecars clásicos sin guardar), sin escritura optimista; si el PATCH inverso **falla** no cambia nada (ni el estado local ni el puntero), queda un error visible y
  se puede reintentar; mientras hay una escritura de metadata en vuelo, undo/redo quedan deshabilitados. Las capas `isNew` se editan solo en local (cero red). `Isolate` y otros
  estados puramente de vista no son comandos.
- **Ejecutor declarativo para IA (MVP 4):** `lib/editor/commandExecutor.ts` — `executeCommand(host, { type, targets, parameters, origin })` valida (tipo, esquema, ids, locks,
  rangos), **nunca acepta ni devuelve `d`/SVG crudos** y ejecuta por el MISMO camino que la UI (mismos planificadores puros y `applyEdit`), con el mismo estado resultante
  (test de equivalencia por tipo). Ejecuta los tipos deterministas y sin servidor; los que necesitan servidor (`geometry.*`), un gesto (`object.draw`, `path.*`...), el portapapeles
  o un PATCH se declaran `executable: false` con el motivo. La validación de comandos de IA en el servidor y el historial persistente quedan para MVP 4 / M3-S13.
- Respeta `locked`: ninguna herramienta modifica objetos de una capa bloqueada (la selección sí puede incluirlos
  para inspeccionar, pero los comandos los filtran y lo informan; el ejecutor, en cambio, rechaza el comando entero). Capas ocultas no se seleccionan.
- Undo/redo restauran snapshots **sin** pasar por el filtro de bloqueo (son la historia del usuario).
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
motor Python (ya en `requirements.txt`) detrás de endpoints **sin estado**; ASP.NET Core los expone
bajo `/api/v2/geometry/*` (misma arquitectura proxy que el resto: Endpoint → Servicio → cliente Python,
`ApiErrorResponse` uniforme; `IUserContext` solo donde haya datos del usuario: una operación que recibe y
devuelve coordenadas no lo necesita). El cliente aplica el resultado como un comando (undoable). Resultados
siempre validados (geometría válida, sin NaN, sin paths vacíos) y tolerancias explícitas (en mm en la UI,
en unidades de documento en el cable).

**Motor de las booleanas (decisión de M3-S08): Shapely/GEOS, no Clipper2.** El criterio de la tarjeta decía "Clipper2 u opción
validada". Se elige **Shapely (GEOS, OverlayNG)** porque (1) ya está en el motor y quedó **validado en M3-S04** con Erase
(difference con huecos, islas, piezas partidas y `make_valid`) y con `normalize`; (2) **no agrega dependencias** al motor ni a .NET
(Clipper2 habría exigido un binding nativo/NuGet nuevo o reescribir el servicio); (3) OverlayNG es **robusto ante bordes que se
tocan y vértices coincidentes** (Shapely 2.1.2 fijado en `requirements.txt`, GEOS 3.13: noding robusto, sin las `TopologyException` del overlay
clásico) y devuelve geometría **válida**, que además se revalida y se ordena de forma determinista antes de salir;
(4) el mismo núcleo sirve a offset (S09), a corte (S10) y a puentes / piezas flotantes (S11), todos implementados. Contra: el resultado son polilíneas (Clipper2 también); el
costo asumido es la latencia de un viaje al servidor, que la UI absorbe con preview, debounce y cancelación. No se reabre salvo
que una tarjeta posterior demuestre un caso que GEOS no resuelva.

**Formato de intercambio (fijado en M3-S04; lo reusan S08–S11).** Los endpoints intercambian **anillos de
polígonos y polilíneas en unidades de documento** (tipo GeoJSON `MultiPolygon` / `MultiLineString`),
**nunca path data**: el cliente aplana sus curvas con su `pathGeometry` (tolerancia explícita, default
0,01 mm convertida a unidades con el factor `mmPerUnit`) y el servidor opera sobre coordenadas puras. El
resultado vuelve como anillos y el cliente lo serializa a `d` (`M … L … Z`, los huecos son subpaths).
Consecuencia: **las booleanas devuelven polilíneas aplanadas a la tolerancia pedida y no preservan los
Bézier originales**; un objeto que el servidor declara intacto (`changed: false`) se conserva tal cual, con
sus curvas.

- Petición `POST /api/v2/geometry/boolean` (Python: `POST /api/v1/geometry/boolean`, cuerpo JSON):
  `{ operation: "union"|"difference"|"intersection"|"intersection_all"|"xor"|"normalize", subjects: [Geometry…],
  operands: [Operand…], tolerance }`.
  - `Geometry` = `{ type: "polygon", coordinates: [[[x,y],…],…] }` — lista de **anillos**, el primero
    exterior; los huecos salen de la **regla par-impar** (un anillo dentro de un número impar de anillos es
    relleno, dentro de uno par es hueco). Un anillo puede venir abierto o cerrado (≥ 3 vértices). — o
    `{ type: "line", coordinates: [[x,y],…] }` (polilínea, ≥ 2 vértices; cerrada si repite el primero).
  - `Operand` = `Geometry` o `{ type: "bufferedLine", points: [[x,y],…], radius }` (pincel de borrador:
    línea con radio, extremos y uniones redondos, resolución de arcos acotada por `tolerance`).
  - Semántica: `difference` = cada subject menos la unión de los operands; `intersection` = cada subject ∩
    la unión de los operands (requiere operandos); `union`/`xor` operan sobre subjects + operands;
    `normalize` = `make_valid` + fusión de cada subject (trazos auto-intersecados: un "moño" son dos triángulos).
  - **Contrato n-ario (M3-S08).** Las booleanas del editor trabajan con 2 o más operandos ordenados A, B, C… y usan
    la misma petición sin endpoint nuevo:
    - `union`: A ∪ B ∪ C… (subjects + operands), resultado `combined`.
    - `difference`: subjects = [A], operands = [B, C…] ⇒ **A − (B ∪ C ∪ …)**. A es la base y el orden importa (A − B ≠ B − A);
      `changed: false` si el resto no toca a A (el cliente conserva entonces su `d` con las curvas).
    - `intersection_all` (**operación nueva**): región **común a TODAS** las formas (subjects + operands, ≥ 2), resultado
      `combined`. `intersection` **no cambia** (sigue siendo "cada subject ∩ la unión de los operands", la usa Erase/S04 y
      A ∩ (B ∪ C) no es la intersección de tres). Un borde o vértice compartido entre polígonos no es un área ⇒ resultado vacío.
      Una forma vacía/degenerada hace vacía la intersección (en union/xor simplemente no aporta).
    - `xor`: región cubierta por un número **impar** de formas (simetría n-aria: la diferencia simétrica es asociativa y
      conmutativa; con 2 es el XOR clásico, con 3 queda A+B+C menos lo cubierto exactamente 2 veces).
    - union / xor / intersection_all no dependen del orden de los operandos (se prueba por permutaciones); difference sí.
    - La regla par-impar hace que el sentido de giro de los anillos (horario/antihorario) no cambie el resultado.
  - `tolerance` > 0 (unidades de documento): resolución de los arcos del pincel y umbral de pieza
    despreciable (polígonos de área < tolerance², polilíneas de largo ≤ tolerance se descartan).
- Respuesta: `{ operation, scope, tolerance, results: [{ subjectIndex, changed, geometries }], pieceCount }`.
  `scope` = `per_subject` (difference/intersection/normalize: una entrada por subject, en orden) o
  `combined` (union/xor/intersection_all: una entrada con `subjectIndex: null`). `geometries` puede tener 0 piezas (el
  subject desaparece), 1 o varias (partido). Cada pieza es `polygon` (anillos **cerrados**, exterior
  antihorario y huecos horarios en ejes matemáticos, cada anillo empezando en su vértice mínimo (x, y)) o
  `line`. Sin NaN, polígonos válidos (`is_valid` tras `make_valid`) y **orden determinista** (mismas
  entradas → mismas salidas, byte a byte; polígonos antes que polilíneas, ordenados por coordenadas).
  `changed: false` = resultado topológicamente igual al subject (p. ej. operando disjunto).
- Límites (422 en Python, 400 con código claro en ASP.NET Core): 500 subjects, 500 operands, 500 000
  vértices en total, coordenadas finitas con |v| ≤ 1e9, tolerancia finita en (0, 1e6]; cuerpo ≤ 32 MB
  (413); timeout propio (Python 15 s, cliente 20 s). Errores: `invalid_parameters`, `unknown_operation` (union, difference, intersection, intersection_all, xor, normalize),
  `invalid_tolerance`, `invalid_coordinates`, `too_many_subjects|operands|vertices`, `payload_too_large`;
  Python caído → 503 `engine_unavailable`, timeout → 504 `timeout`, respuesta incoherente → 502
  `invalid_response`. El cliente **nunca** crea geometría inválida: si el servidor falla (o la respuesta no
  pasa su propia validación) no modifica nada y lo informa.

**Booleanas en el editor (M3-S08), decisiones de UX/dominio sobre este contrato** (`lib/editor/boolean.ts`):
- Operandos = 2+ objetos **con relleno** seleccionados, en capas desbloqueadas y visibles; las líneas abiertas (`fill: "none"`) y las
  capas bloqueadas/ocultas **rechazan la operación completa** (no se omite un operando en silencio). Orden por defecto = el de pintado
  (el de abajo es A); la UI muestra A/B/C en el canvas y en el panel, y permite subir/bajar e invertir.
- **La capa/color del resultado nunca se decide en silencio:** misma capa ⇒ esa capa; capas distintas ⇒ el panel exige elegirla (selector sin
  valor por defecto, Apply deshabilitado), entre las capas de los operandos, otra desbloqueada y visible, o una capa nueva con un color
  (mecánica de S03). El color del resultado es el de la capa destino.
- Cada pieza disjunta del resultado es un objeto nuevo (ids nuevos, sin matriz, huecos como subpaths); se insertan en el lugar del operando
  más alto de la capa destino (con «Conservar originales», justo encima de él; si ningún operando está en esa capa, al tope). Un operando
  no afectado (`changed: false` en una diferencia) conserva su `d`, su matriz y su id. Resultado vacío ⇒ no se aplica.
- Preview con `AbortController` + debounce sobre `useGeometryOperation` (una petición viva a la vez; un resultado solo vale para su
  petición); Apply usa el resultado ya calculado (o recalcula si cambió algo); un único comando atómico por Apply; Cancel y el preview no
  tocan la pila de undo.

**Offset (decisión de M3-S09): mismo servicio, mismo motor, endpoint propio.** `buffer` de Shapely/GEOS (la misma elección de S08: sin dependencias nuevas;
Clipper2 sigue descartado). Reusa el formato de anillos, los límites, el timeout y las validaciones de S04, y el hook de preview de S08 (generalizado a
`useGeometryPreview`; `useBooleanOperation` y `useOffsetOperation` son envoltorios finos). Contrato:

- Petición `POST /api/v2/geometry/offset` (Python: `POST /api/v1/geometry/offset`): `{ subjects: [polygon|line…], distance, joinStyle: "round"|"mitre"|"bevel",
  mitreLimit, capStyle: "round"|"flat"|"square", tolerance }`. En el cable de Python los nombres van en snake_case (`join_style`, `mitre_limit`, `cap_style`; igual que
  `subject_index`/`piece_count` de S04) y en el de ASP.NET Core/el editor en camelCase. Los `subjects` son los de las booleanas (un pincel `bufferedLine` no es un subject).
  - `distance` es **FIRMADA y en unidades de documento**: > 0 exterior (agranda), < 0 interior (encoge), 0 se rechaza. El panel trabaja con una distancia ≥ 0 y una
    **dirección** explícita; los **mm** se convierten con `mmPerUnit` (`lib/editor/units.ts`). **Sin escala física el panel opera en unidades (u) con un aviso
    visible; nunca inventa mm.** `tolerance` (default 0,01 mm) se convierte igual: gobierna la resolución de los arcos redondos (`quad_segs` acotado, como el pincel
    de S04) y descarta piezas de área < tolerancia².
  - Una **línea** (polilínea abierta, o cerrada si repite el primer vértice) solo se desplaza **a ambos lados**: el resultado es un polígono de ancho total
    2·|distance| con `capStyle` en los extremos (una polilínea cerrada da un anillo con hueco). Una `distance` negativa con alguna línea se rechaza (422/400) en vez
    de reinterpretarse; el editor deshabilita *Interior* con el motivo.
  - `joinStyle`: `round` (default), `mitre` (inglete: `mitreLimit` es la razón máx. largo del inglete / distancia, default 2; pasado el límite GEOS recorta la punta
    a `mitreLimit·distance`) y `bevel`. Hacia adentro el join solo actúa en las esquinas cóncavas.
- Respuesta (`ASP.NET`, camelCase; Python, snake_case): `{ distance, joinStyle, mitreLimit, capStyle, tolerance, results: [{ subjectIndex, geometries, collapsed,
  piecesBefore, splitCount, lostPieces, holesBefore, holesAfter, maxInwardOffset }], pieceCount }`. `results` trae una entrada por subject, en orden. `geometries`
  son **solo polígonos** (anillos cerrados, exterior antihorario, huecos horarios, cada anillo desde su vértice mínimo, orden determinista, `is_valid`).
  **Nada falla en silencio**: `collapsed` = no queda nada; `splitCount` = piezas del resultado (el subject se **partió** si supera `piecesBefore − lostPieces`);
  `lostPieces` = piezas del subject que desaparecen del todo (solo hacia adentro); `holesBefore/After`; `maxInwardOffset` = radio del máximo círculo inscrito
  (`shapely.maximum_inscribed_circle`, exacto salvo `tolerance`): con un offset interior igual o mayor TODO el subject colapsa (`null` para líneas). Hacia adentro
  cada pieza del subject se encoge por separado (el resultado es el mismo y así se sabe cuáles desaparecen). `ASP.NET` y el editor revalidan que la respuesta
  corresponda a LA petición (mismos parámetros, una entrada por subject, solo polígonos, `collapsed`/`splitCount`/`holesAfter` coherentes con la geometría,
  `maxInwardOffset` nulo solo en líneas); si no, 502 `invalid_response` y el editor no toca nada.
- Límites y errores: los de S04 (500 subjects, 500 000 vértices, |coordenada| ≤ 1e9, cuerpo ≤ 32 MB, timeout 15 s Python / 20 s cliente) más `|distance|` ≤
  `Geometry:MaxOffsetDistance` (1 000 000 u; el editor además acota a 1000 mm) y `0 < mitreLimit ≤ Geometry:MaxMitreLimit` (100). Códigos 400 de ASP.NET Core:
  `invalid_distance` (0, NaN/Infinity, fuera de tope, interior con líneas), `unknown_join_style`, `unknown_cap_style`, `invalid_mitre_limit`, y los de S04
  (`invalid_tolerance`, `invalid_coordinates`, `invalid_parameters`, `too_many_subjects`, `too_many_vertices`); 413 `payload_too_large`; 503/504/502 uniformes.
  Python responde 422 con `invalid_parameters`/`too_many_geometry_*`, 413, 504 y 500 `geometry_result_invalid`.

**Offset en el editor (M3-S09), decisiones de UX/dominio** (`lib/editor/offset.ts`, herramienta **Offset** del toolbar):
- La herramienta Offset sigue la **selección viva** (en ella el canvas solo selecciona: no arrastra ni transforma); cada cambio de selección o de valores vuelve a
  pedir el resultado (debounce 250 ms, `AbortController`, una petición viva). Presets 0,1 / 0,25 / 0,5 / 1 / 2 / 5 mm, campo libre validado (> 0, ≤ 1000 mm) y flechas ↑/↓.
- **Colapso y división nunca en silencio.** Si **todos** los objetos colapsan, Apply queda deshabilitado con la explicación y el máximo interior ("≈ X mm"); si
  **algunos** colapsan (o pierden piezas) se aplica solo a los demás **y solo con la casilla de confirmación marcada** (se descarta ante cualquier cambio de valores,
  selección u opciones); el objeto que colapsa **nunca se modifica ni se borra**, ni siquiera con «Reemplazar». División, huecos que se pierden o se ganan y piezas
  despreciables descartadas se informan antes de aplicar y en el aviso posterior (la división no pierde nada: no pide confirmación).
- **Capa.** Cada resultado va a la **capa de su objeto de origen** (el panel dice cuál) con el color de esa capa, o a una capa destino elegida a propósito (existente
  desbloqueada y visible, o capa nueva con un color: mecánica de S03, mismo comando). Una capa de origen **bloqueada u oculta rechaza la operación completa** (como S08).
- **Originales.** Por defecto se **conservan** (el offset es un contorno nuevo); «Reemplazar» los sustituye en su lugar. Cada pieza disjunta es un objeto nuevo (ids
  nuevos, `fill` = color de la capa destino, sin matriz, huecos como subpaths) y se inserta **justo encima** de su objeto de origen (con destino en otra capa, al tope
  de ella, en orden de pintado). Un solo comando atómico por Apply; el preview y Cancel no tocan la pila de undo.
- El resultado son **polilíneas** aplanadas a la tolerancia (no preserva los Bézier). Un objeto sin relleno con varios subpaths desplaza cada subpath por separado
  (los contornos resultantes pueden solaparse; la unión de S08 los funde). Sin compensación automática de kerf/material (fuera de alcance).

**Corte / división (decisión de M3-S10): mismo servicio, mismo motor, endpoint propio.** Shapely/GEOS (`unary_union` + `polygonize` para dividir polígonos,
`buffer` para la ranura; la misma elección de S08/S09: sin dependencias nuevas). Reusa el formato de anillos, los límites, el timeout, las validaciones de S04 y el
hook de preview (`useGeometryPreview`; `useCutOperation` es otro envoltorio fino). Contrato:

- Petición `POST /api/v2/geometry/split` (Python: `POST /api/v1/geometry/split`): `{ subjects: [polygon|line…], cutter: { points: [[x,y],…] }, mode: "split"|"slot",
  slotWidth, extend, tolerance }`. En el cable de Python los nombres van en snake_case (`slot_width`, `piece_count`, `subject_index`) y en el de ASP.NET Core/el editor
  en camelCase. Los `subjects` son los de las booleanas (un pincel `bufferedLine` no es un subject).
  - `cutter.points`: polilínea de **>= 2 puntos distintos** (los consecutivos repetidos se unifican; si quedan menos de 2, 400 `invalid_cutter` / 422), en unidades de
    documento, tope `Geometry:MaxCutterPoints` (10 000). Cuentan además en el tope de vértices.
  - `mode`: `split` (**dividir**: las piezas comparten el borde del corte; polígonos con `unary_union(borde, corte)` + `polygonize`, robusto con huecos, islas y varios
    cruces; una polilínea se parte en cada punto donde el corte la cruza o la toca, y un tramo superpuesto (colineal) no cuenta como cruce) o `slot` (**separar con
    hueco**: se resta una ranura de ancho `slotWidth` centrada en el corte, buffer de extremos **planos** y uniones redondas, así que el área quitada de un corte recto
    es exactamente `slotWidth` × el largo atravesado y los extremos no se pasan del trazo dibujado).
  - `slotWidth` es en **unidades de documento**, `> 0` y `<= Geometry:MaxOffsetDistance` en modo `slot` (400 `invalid_slot_width`); en modo `split` se ignora (el
    editor manda 0) pero debe ser finito y no negativo. El panel lo pide en **mm** (default 0,2; rango 0,01–100) y convierte con `mmPerUnit`; **sin escala física opera en
    unidades con un aviso visible, nunca inventa mm**. `tolerance` (default 0,01 mm) gobierna la resolución de los arcos de la ranura y descarta piezas de área < tolerancia²
    (largo <= tolerancia en líneas).
  - `extend`: el primer y el último tramo del corte se prolongan, en su propia dirección, una longitud mayor que la diagonal de todo lo involucrado (subjects + corte);
    los vértices intermedios no se mueven. Sin `extend` el corte es exactamente la polilínea dibujada.
- **Un corte que no atraviesa NO divide** (en los dos modos). Un objeto solo `changed` si el corte lo **separa en más piezas** (con área/largo útil) que las que ya tenía;
  una línea que termina dentro de la forma, que corre por un borde, que solo la roza en un vértice, o una ranura que solo le hace una muesca, la dejan **idéntica**:
  `changed: false` y `pieces` = el subject tal cual (el cliente conserva su `d` con las curvas). Una polilínea **cerrada** cortada una sola vez queda en una pieza abierta:
  tampoco se considera separada. Si tras descartar astillas queda una sola pieza útil, tampoco.
- Respuesta (Python snake_case, ASP.NET camelCase): `{ mode, slotWidth, extend, tolerance, results: [{ subjectIndex, touched, changed, pieces, pieceCount, discarded }],
  pieceCount }`, una entrada por subject en orden. `touched` = el corte (o su ranura) alcanza al subject (permite decir «no lo toca» y «lo toca pero no lo atraviesa» por
  separado); `pieces` son polígonos (anillos cerrados, exterior antihorario, huecos horarios, cada anillo desde su vértice mínimo, `is_valid`) para un subject poligonal y
  polilíneas para uno lineal, en **orden determinista** (mismas entradas -> mismas salidas, byte a byte; el sentido de giro de los anillos y el del corte no importan);
  `discarded` = piezas despreciables descartadas de un resultado que cambió (0 si no cambió). `ASP.NET` y el editor revalidan que la respuesta corresponda a LA petición
  (mismos parámetros, una entrada por subject, piezas del tipo del subject, anillos cerrados y finitos, `pieceCount` por objeto y total, `changed` solo con `touched` y >= 2
  piezas, `discarded` coherente); si no, 502 `invalid_response` y el editor no toca nada.
- Límites y errores: los de S04 (500 subjects, 500 000 vértices, |coordenada| <= 1e9, cuerpo <= 32 MB, timeout 15 s Python / 20 s cliente) más `Geometry:MaxCutterPoints` y el ancho
  de ranura. Códigos 400 de ASP.NET Core: `unknown_split_mode`, `invalid_slot_width`, `invalid_cutter` (ausente, < 2 puntos o todos iguales), `too_many_cutter_points`, y los de
  S04 (`invalid_tolerance`, `invalid_coordinates` -- NaN/Infinity/null en subjects o corte --, `invalid_parameters`, `too_many_subjects`, `too_many_vertices`); 413 `payload_too_large`;
  503/504/502 uniformes. Python responde 422 `invalid_parameters`/`too_many_geometry_*`, 413, 504 y 500 `geometry_result_invalid`.

**Cut en el editor (M3-S10), decisiones de UX/dominio** (`lib/editor/cut.ts`, herramienta **Cut** del toolbar):
- **Línea de corte**: polilínea dibujada en la superficie propia de la herramienta (`ToolSurface`, la misma de Draw/Erase): click por punto, doble click o Enter la termina,
  Retroceso quita el último punto, Escape borra la línea (con la línea vacía, cierra la herramienta) y **arrastrar** traza un segmento recto (la línea completa). Una línea
  terminada no acepta más puntos (Retroceso la reabre). Con la línea de 2+ puntos el preview sale solo (debounce 250 ms, `AbortController`, una petición viva); Enter con la
  línea terminada aplica. Los puntos van en unidades de documento; el panel guía en mm.
- **Dos modos visibles** (*Dividir* / *Separar con hueco*; el activo se indica siempre por escrito), ancho de ranura en mm y la opción **«Extender el corte hasta cruzar todo»**.
- **Alcance explícito**: con selección, solo los objetos seleccionados; sin selección, **todos los objetos visibles y desbloqueados que la línea (ya extendida) cruza**,
  listados antes de aplicar («Se cortarán N objetos: …»). Los objetos de capas bloqueadas u ocultas se **omiten e informan** (a diferencia de S08/S09 no se rechaza la
  operación completa: no son operandos que se consuman) y un objeto de geometría ilegible se omite e informa. Cambiar la selección exige salir de Cut (la superficie captura el puntero).
- **Resultado**: cada pieza disjunta es un objeto nuevo (ids nuevos, **misma capa** que el original —no hay decisión de capa—, mismo `fill`/`stroke`, sin matriz, huecos como
  subpaths; `strokeWidth` escalado por la matriz horneada), y ocupa el lugar del original en el orden de pintado. Un objeto que el corte no separa conserva `d`, matriz e id. Un
  comando atómico por Apply (`atomic`), undo/redo exactos, la selección pasa a las piezas (y Deshacer vuelve a seleccionar el original); el preview y Cancel no tocan la pila de undo.
- **Nada en silencio**: el panel dice cuántos objetos y piezas salen, nombra («Rojo · objeto 2») los que el corte **toca sin atravesar** (con la sugerencia de prolongar o activar
  «Extender»), los seleccionados que no toca, lo omitido por capa, lo no procesable y las piezas despreciables descartadas. **Si ningún objeto cambia, Apply queda
  deshabilitado con la explicación.** Un error del servidor o una respuesta incoherente no modifica nada (Reintentar vuelve a pedir).
- Las piezas son **polilíneas** aplanadas a la tolerancia (no preservan los Bézier). Fuera de alcance: cortes con curvas, varios cortes a la vez, snapping, reunir piezas (Unión de S08),
  puentes (S11) y persistencia (S13).

**Piezas flotantes y bridges (decisión de M3-S11): mismo servicio, mismo motor, dos endpoints propios.** Shapely/GEOS (`unary_union`, `difference`/`union`, `STRtree`; la misma
elección de S08–S10: sin dependencias nuevas) sobre el formato de anillos de S04. Reusa los límites, el timeout, las validaciones y el hook de preview (`useGeometryPreview`;
`useFloatingAnalysis` y `useBridgeOperation` son otros envoltorios finos). Referencia de conceptos (no se modifica): `component_analysis` (contención/profundidad) y
`physical_union._build_bridge` (puente rectangular con solape) del flujo clásico de MVP 1. Contrato:

- **Qué es «flotante» — dos modos explícitos (`mode`), siempre visibles en el panel, default `stencil`.** La unión de TODAS las formas (los bloqueados cuentan) con la regla par-impar por forma:
  - `stencil` (**Plantilla**): las formas son **cortes** (vacío); el material es la hoja menos esas formas. Una **isla** es material rodeado por completo de corte: cada **hueco** (anillo
    interior) de la unión, a cualquier profundidad (un corte dentro de una isla no la conecta: la isla sigue flotando y sus huecos son islas más profundas). La hoja (lo que rodea todo) es
    el único principal: id 0, sin polígono. Ejemplos: la contra-forma de una A, O o R; los centros de un stencil.
  - `parts` (**Piezas**): las formas son **material**; flotante = componente de la unión que está dentro de un hueco de otro (contención). Dos componentes disjuntos sin contención no flotan.
- **Análisis** `POST /api/v2/geometry/floating` (Python: `/api/v1/geometry/floating`): `{ subjects: [{ type: "polygon", coordinates, locked? }], mode, tolerance }` → `{ mode, tolerance,
  components: [{ id, kind: "principal"|"floating", depth, parent, polygon, area, bounds, subjects }], floatingCount, mainCount, discarded }`. Solo **polígonos** (las líneas abiertas no tienen
  relleno). `id` = posición en un orden **determinista** (profundidad, coordenadas canónicas): mismas entradas → mismas salidas, byte a byte; el sentido de giro no cambia nada. `depth` = ancestros
  en el árbol de contención; `parent` = id del componente que lo rodea (siempre anterior); `subjects` = formas que lo forman (parts: las que lo solapan; stencil: las que bordean la isla).
  Componentes de área < tolerancia² se descartan y se cuentan en `discarded`.
- **Bridge** `POST /api/v2/geometry/bridge` (Python: `/api/v1/geometry/bridge`): `{ subjects, mode, bridges: [{ island?, anchor?: {x,y}, direction?: {x,y}, width, length? }], suggest, suggestWidth?,
  tolerance }`. Cada bridge necesita `island` (id del análisis: el servidor sugiere ancla y dirección) y/o `anchor` (punto sobre el borde de una pieza flotante, a lo sumo a `tolerance`);
  `direction` por defecto es la **normal exterior** del borde; `length` por defecto es lo justo para cruzar el hueco. Un bridge es un **rectángulo real** de ancho `width` que arranca
  `2·tolerance` dentro de la pieza y termina `2·tolerance` dentro del material vecino (solape real, no una tangencia), así el área realmente quitada (stencil: se **resta** de los cortes) o
  agregada (parts: se **suma** a la forma dueña de la pieza, o a la del cuerpo al que llega si la dueña está bloqueada) es **exactamente `width × largo del hueco`** (`area`, `length`).
  La **sugerencia automática** (heurística simple y determinista, no «IA»): el tramo del borde de la pieza más cercano al borde de su padre, en su punto medio y perpendicular. Con
  `suggest: true` el servidor completa, con una sugerencia de ancho `suggestWidth`, cada pieza flotante que ningún bridge válido cubre (`suggested: true` en el resultado).
- **Validez por bridge** (`valid`, `reason`): cada uno se valida por separado contra la geometría original y es inválido si `unknown_island`, `anchor_outside`, `width_below_tolerance`
  (ancho < tolerancia), `invalid_direction`, `no_crossing` (no cruza ningún hueco en esa dirección), `too_short` (`length` explícito < hueco), `locked_subject` (necesitaría modificar una forma
  con `locked: true`) o `no_connection` (aplicado solo no reduce los flotantes; p. ej. un rectángulo que cae todo dentro del corte crearía una isla nueva). Un inválido **no se aplica**.
  `reduces` = sumado a los bridges válidos anteriores deja menos flotantes (dos bridges sobre la misma isla: ambos válidos, solo el primero reduce). `affects` = formas que modifica.
- **Resultado y reanálisis.** Los válidos se aplican **juntos**: por forma `{ subjectIndex, changed, geometries }` (polígonos con anillos cerrados, orden determinista; `changed: false` = igual,
  **sin** `geometries`: el cliente conserva su objeto con sus curvas; una forma `locked` jamás cambia) y `reanalysis: { floatingBefore, floatingAfter, mainAfter }` calculado sobre la geometría
  resultante ya finalizada (la misma que recibe el cliente): un análisis independiente del resultado da el mismo `floatingAfter`.
- **Límites y errores** (los de S04 + `Geometry:MaxBridges` = 200; el ancho y el largo de un bridge se acotan con `Geometry:MaxOffsetDistance`): 400 de ASP.NET Core `unknown_floating_mode`,
  `invalid_bridge` (sin isla ni ancla, isla negativa, dirección nula), `invalid_bridge_width` (ancho o largo ausente/NaN/≤ 0/fuera de tope; también `suggestWidth`), `too_many_bridges` y los de S04
  (`invalid_tolerance`, `invalid_coordinates` — NaN/Infinity/null en formas, ancla o dirección —, `invalid_parameters`, `too_many_subjects`, `too_many_vertices`); 413 `payload_too_large`;
  503/504/502 uniformes. Python responde 422 `invalid_parameters`/`too_many_geometry_*`, 413, 504 y 500 `geometry_result_invalid`. `ASP.NET` y el editor **revalidan** que la respuesta corresponda
  a LA petición (modo, ids = posiciones, árbol de contención coherente, polígonos cerrados y finitos, recuentos reales; un resultado por bridge pedido con el ancho pedido, motivos conocidos, un
  válido con isla/ancla/dirección unitaria/rectángulo/largo/área y sin tocar una forma bloqueada, `changed` solo si algún válido modifica la forma, reanálisis sin más flotantes que antes); si no,
  502 `invalid_response` y el editor no toca nada.

**Piezas flotantes y bridges en el editor (M3-S11), decisiones de UX/dominio** (`lib/editor/floating.ts`, herramienta **Flotantes** del toolbar — el wireframe obligatorio no traía un botón dedicado):
- **Alcance explícito** (el panel lo dice por escrito): la **selección**, si la hay; si no, los objetos **con relleno** de las capas **visibles** con operación **CUT** («Capas CUT: A, B (12
  objetos)»). Los objetos de capas **bloqueadas cuentan** para el análisis (solo lectura) pero **no se modifican** (un bridge que necesite modificarlos se rechaza con el motivo `locked_subject`); las
  capas **ocultas no cuentan** (se informan); las líneas abiertas se omiten contadas. Nada se omite en silencio.
- **Analizar es explícito** (botón) y el análisis queda **congelado**: si alguno de los objetos analizados cambia (move, undo…) el panel avisa «el documento cambió desde el análisis», oculta el
  overlay y no deja aplicar; cambiar el modo lo descarta. Cambiar la selección no lo invalida.
- **Issues**: lista (`role="listbox"`, ↑/↓/Inicio/Fin/Enter) con «Isla 1 · 12,5 mm² · rodeada por «Rojo · objeto 2»». **Seleccionar un issue centra la vista** (`useCanvasTransform.centerOn` →
  `viewport.focusTransform`: el centro de la caja de la pieza cae en el centro del contenedor; la pieza ocupa el 40 % del lado menor, con zoom entre el mínimo del canvas y 6) y la **resalta** en el
  overlay (rojo, trazo grueso); todas llevan una insignia numerada.
- **Bridges**: arrancan como las **sugerencias** del servidor (una por pieza); la primera edición del usuario (quitar, mover, colocar) las adopta como lista explícita (isla, ancla y dirección ya
  resueltas). **Ancho en mm** (default 0,8; rango validado 0,05–20; sin escala física opera en unidades y avisa). **Colocar**: click sobre el borde de una pieza (se ajusta al punto más cercano del
  borde a ≤ 10 px de pantalla; lejos no coloca nada y lo explica); **Mover** reubica ese bridge. Varios por isla permitidos. Cambiar el ancho, quitar o mover vuelve a pedir el resultado (debounce 250 ms,
  `AbortController`, una petición viva); el panel muestra **«N flotantes → M»** y avisa si algún bridge no redujo nada, qué piezas quedan sin bridge, lo bloqueado y lo descartado.
- **Apply se deshabilita con CUALQUIER bridge pedido inválido** (con el motivo; se quita o se corrige). Una sugerencia que el servidor no pudo resolver no bloquea: se informa («No se pudo sugerir un
  bridge para Isla 3 (…). Colocalo a mano»). Sin bridges válidos que reduzcan no hay nada que aplicar.
- **Resultado**: cada objeto modificado se reemplaza por sus piezas (ids nuevos, **misma capa**, mismo `fill`/`stroke`, sin matriz, huecos como subpaths; `strokeWidth` escalado por la matriz horneada) en
  el lugar del original; el que el servidor declara intacto conserva `d`, matriz e id. **Un comando atómico** por Apply (`atomic`), undo/redo exactos, la selección pasa a las piezas; el análisis, el
  preview y Cancel no tocan la pila de undo. Un error del servidor o una respuesta incoherente no modifica nada. Un objeto modificado que se queda sin piezas útiles invalida el resultado (nunca se
  borra un diseño).
- Fuera de alcance: colocación automática óptima, bridges curvos, optimización global del número de bridges, el Laser Checker integrado (S14 reusa estos issues), persistencia (S13) y capas ENGRAVE.

### D5. Persistencia de geometría (M3-S13)
Serialización `EditableDocument → SVG por capa` (mismo formato de origen, `<path data-vid d fill transform>`)
y un endpoint que recibe las capas modificadas y crea **una `DocumentVersion` nueva** (Origin `MANUAL_EDIT` o
`AUTOSAVE`, SVG nuevo por capa tocada; versiones inmutables, idempotencia, ownership, como en M2.2). Invariante
de round-trip: `parse(serialize(doc))` ≡ `doc` (ids, d, fill, matriz) — se prueba desde S01.

**Implementado en S13**
- `POST /api/v2/projects/{id}/document/editor-save`: el cliente manda el SVG serializado de **todas** las capas (más nombre, orden,
  visibilidad, bloqueo, operación, color y el marco `viewBox`/mm). El servidor sube cada SVG como Asset `layer-svg` y crea una
  `DocumentVersion` (Origin `MANUAL_EDIT`/`AUTOSAVE`; `RESTORE`/`VECTORIZE`/`AI_EDIT` los decide solo el servidor). `Layer.GroupId` se
  conserva entre versiones, así que una capa creada en el cliente (`isNew`) simplemente pasa a existir con su groupId. Idempotencia por
  `idempotencyKey` (replay = 200 con el resultado original), ownership (404) y concurrencia optimista por `xmin` (409). No hay `baseVersion`:
  dos pestañas guardando una tras otra no chocan, solo dos escrituras realmente simultáneas.
- **`geometryDirty` = "difiere de lo último que el servidor confirmó"** (antes: "difiere de lo cargado"). `useEditableDocument` guarda una
  *marca de guardado* (`saveMark`: objetos por capa, marco y huella de la estructura de capas) que el guardado captura **al serializar** y
  declara persistida con `markSaved(marca)` al confirmarse. Lo editado mientras el POST estaba en vuelo sigue contando como sin guardar;
  deshacer más allá del punto guardado vuelve a ensuciar y rehacer hasta él lo limpia. **El historial de undo NO se reinicia al guardar**
  (solo al restaurar una versión, que recarga el documento). `editedLayerIds` conserva su significado ("difiere de lo cargado") porque la
  miniatura y el `pathCount` dependen de él.
- Autosave (`useGeometrySave`): 3 s después de la **última** edición (cada edición reinicia la ventana); un solo POST en vuelo; red/5xx ⇒
  reintentos con backoff 1 s → 2 s (3 intentos) con la misma key, que se descarta si el payload cambió; 4xx/409 ⇒ `error` y el autosave
  espera a un guardado manual (no re-golpea el mismo error). **Nunca guarda con una capa sin cargar** (se serializaría vacía y se perdería
  su geometría). Con un proyecto ya guardado, SAVE es siempre un checkpoint del editor: el save clásico regeneraría las capas desde el
  pipeline y pisaría lo editado; el clásico queda para el primer guardado (staging).
- Historial de versiones (`VersionHistoryPanel`): lista las `DocumentVersion` (origen, fecha, tamaño mm) y restaura creando una versión
  nueva (`RESTORE`); el historial no se borra. Antes de restaurar se suspende el autosave para que no pise la versión restaurada.

### D6. Reglas transversales
- Sin dependencias nuevas salvo necesidad demostrada y documentada (Shapely ya existe).
- Cada tarjeta: tests de lógica pura en `lib/editor/*` (sin DOM) + tests de componentes + (si hay backend)
  tests de integración; `npm run build` además de `npm test`.
- Accesibilidad: toda herramienta operable por teclado donde sea razonable; foco gestionado; `aria-*`.
- Rendimiento: documentos de ≥ 5 000 paths no deben bloquear la UI en selección/drag (memoización por objeto,
  sin re-renderizar todas las capas por frame).

### D7. Laser Checker integrado en el editor (M3-S14)
- **Corre en el cliente sobre la geometría editada en memoria** (`EditableDocument`: capas efectivas + objetos confirmados), como módulo puro `lib/editor/laserCheck.ts`.
  El checker de M1-S08 (`/api/v1/.../check`) analiza versiones *guardadas* y solo M/L/Z: no ve ediciones sin guardar ni las curvas del editor, así que no sirve acá y no se toca.
- **Piezas flotantes: se reusa S11** (`planFloating` + `useFloatingAnalysis`, servidor Shapely; modo `stencil`, el default de S11). Es asíncrono: una sola petición viva con
  aborto, y mientras no hay respuesta —o si falla— el check queda **NO VERIFICADO** (nunca «OK») sin invalidar los checks locales. Sin cambios de backend.
- **Relevancia por operación**: capas `ignore` y ocultas no se analizan; las bloqueadas sí (solo lectura). Paths abiertos y flotantes solo importan en CUT (en ENGRAVE un
  contorno abierto es una línea grabada válida). Una capa `unassigned` se analiza como CUT, cada issue lo indica y la capa suma un aviso propio: nunca se asume Corte en silencio.
  Un objeto con `stroke` y sin `fill` (una línea) NO es «path abierto»: solo es problema donde se espera un área (relleno en CUT).
- **Umbrales en mm, constantes exportadas** (`laserCheck.ts`; sin escala física se leen como unidades del documento y el panel avisa): detalle mínimo CUT 0,1 mm (kerf) y
  ENGRAVE 0,05 mm; path cerrado si el hueco es ≤ 0,01 mm; duplicado exacto ≤ 0,001 mm y casi duplicado ≤ 0,05 mm; subforma degenerada < 0,0001 mm; complejidad > 5 000 nodos por
  objeto o > 50 000 por capa; la autointersección tiene un presupuesto de comparaciones (2 M por objeto, 20 M en total) y, si se agota, queda no verificada.
- **Checks**: geometría inválida (path ilegible, matriz/coordenadas no finitas, sin área/largo, subformas degeneradas, autointersección), path abierto, duplicado exacto y casi
  (geometría horneada, desviación simétrica sobre puntos muestreados por longitud de arco, dentro de la misma clase de operación), pieza flotante, detalle pequeño (ancho del casco
  convexo de cada subforma; un estrechamiento cóncavo dentro de una forma grande no se detecta) y complejidad.
- **Severidad → estado global**: `Blocking` si hay algún issue `error` (inválida, path abierto en CUT, duplicado exacto, flotante); `Review` si solo hay avisos (casi duplicado,
  detalle pequeño, complejidad, capa sin operación) **o** si algún check no se pudo verificar; `Ready` solo con cero issues y todos los checks verificados (también si no hay nada que analizar: `Review`).
- **Re-run**: manual (*Volver a analizar*) y automático mientras el panel está abierto: al abrir (de inmediato) y 400 ms después de cambiar el documento confirmado. Cada resultado
  lleva la **huella** del documento analizado (`documentFingerprint`: capas + referencias de objetos + escala); si cambió y todavía no se re-analizó, se muestra **«Desactualizado»**
  (nunca como vigente), sin resaltado en el canvas y sin poder activar sus issues. Cerrar el panel descarta el resultado y cancela lo que esté en vuelo.
- **UI**: no es una herramienta (`activeTool` no cambia; `VectorCanvas` solo suma el prop `laserCheckOverlay`: no hay nada que sumar a `selectOnly`, a Escape ni a `TOOL_LABELS`).
  Botón *Laser Check* en el header y panel en el rail derecho. Activar un issue selecciona sus objetos (un issue de capa selecciona la capa), centra la vista con `centerOn`/`focusTransform`
  y lo resalta en el overlay. Teclado: la lista es un `listbox` (↑/↓/Inicio/Fin mueven el cursor, Enter/Espacio activan, Escape cierra y devuelve el foco al botón del header) y el resumen va en una región `aria-live`.
- Fuera de alcance: correcciones automáticas, exportar el reporte, checks de MVP 4.

## Consecuencias
- Un solo mecanismo de comandos hace S06/S12 (copy/paste, undo/redo, historial) una extensión, no una reescritura.
- Hornear matrices solo cuando hace falta evita degradar geometría con transforms triviales.
- El riesgo asumido: edición en memoria hasta S13 (mitigado con `geometryDirty` + aviso). Desde S13 la geometría se persiste (autosave +
  checkpoints); el undo/redo sigue siendo de sesión.

## Mapa de tarjetas
S01 base (modelo, comandos, selección, move/scale/rotate) · S02 crop/rotate/flip · S03 fill/recolor/eyedropper ·
S04 draw/erase · S05 nodos/Bézier · S06 copy/paste/duplicate/delete · S07 align/distribute/z-order ·
S08 booleanas (servidor) · S09 offset (servidor) · S10 corte (servidor) · S11 puentes/piezas flotantes (servidor) ·
S12 historial de comandos unificado (incluye metadata de capas; `docs/EDITOR_COMMANDS.md`) · S13 autosave de geometría + historial de versiones ·
S14 Laser Checker integrado (D7) · S15 export avanzado · S16 E2E + release candidate.
