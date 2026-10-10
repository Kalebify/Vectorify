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
(4) el mismo núcleo sirve a offset (S09, implementado) y servirá a corte y puentes (S10–S11). Contra: el resultado son polilíneas (Clipper2 también); el
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
