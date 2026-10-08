# spec.md — M3-S04 · Erase + Draw

> Lee primero `docs/ADR_EDITOR_MVP3.md` y los `IMPL.md` de M3-S01, S02 y S03 (`.sprint/3c1d77b2-6398-8167-977a-f44248e874b1/`,
> `.sprint/3e8d77b2-6398-81c5-9257-ea063abbaa7e/`, `.sprint/3e8d77b2-6398-81ac-931c-e83108231222/`). Reusás `lib/editor/*`,
> `useEditableDocument` (`applyEdit`, gestos, undo/redo, locks, capas efectivas con `isNew`, `createColorLayer`), el toolbar y
> el panel de capas. **Esta tarjeta inaugura el servicio de geometría del servidor (ADR D4)**: lo reusan S08–S11.

## Contexto
Criterio (Notion): "Draw crea paths válidos y Erase elimina/modifica geometría de forma reversible, respetando layer activo
y unidades." Draw = correcciones simples (no ilustración); Erase tiene semántica explícita (borrar objetos **o** restar
geometría, nunca "pintar de blanco"). DoD: "Las correcciones manuales producen geometría real y no hacks visuales."

## Decisiones (documentalas en IMPL.md)
1. **Capa activa** = la capa seleccionada en el panel de capas (`selectedGroupId`) o la del objeto seleccionado.
   Toda geometría nueva pertenece a una capa identificada: si hay capa activa **visible y no bloqueada** → ahí. Si no
   hay capa activa → se **crea una capa nueva explícita** "Dibujo" (mismo mecanismo y atomicidad que Fill con color
   nuevo en S03: capa + objeto en UN comando; color por defecto negro `#000000`, editable luego con Fill/Color). Si la
   capa activa está **bloqueada u oculta** → se rechaza con mensaje claro ("Desbloqueá/mostrá la capa «X» o elegí
   otra"); nunca se dibuja en otra capa en silencio.
2. **Objetos abiertos vs. cerrados**: el modelo `EditorObject` gana campos **opcionales** `stroke?: string` y
   `strokeWidth?: number` (unidades de documento) y `fill` puede ser `"none"`. Draw **cerrado** ⇒ relleno con el
   color de la capa (sin stroke); Draw **abierto** ⇒ `fill: "none"`, `stroke` = color de la capa, ancho por defecto
   **0,1 mm** (línea fina de corte/grabado; configurable en el panel). `serializeEditableLayer`/`parseEditableLayer`
   conservan `fill="none"`, `stroke`, `stroke-width` (round-trip con test); objetos de S01–S03 sin esos campos no
   cambian de comportamiento. El hit-test de S01 debe contemplar trazos (línea con tolerancia = max(strokeWidth/2,
   tolerancia en px)) para poder seleccionar/borrar líneas abiertas.
3. **Servicio de geometría (ADR D4 — actualizá el ADR con este formato)**: los endpoints intercambian **anillos de
   polígonos / polilíneas en unidades de documento** (formato tipo GeoJSON `MultiPolygon`/`MultiLineString`), **no**
   path data: el cliente aplana curvas con su `pathGeometry` (tolerancia explícita, default 0,01 mm convertida a
   unidades) y el servidor (Shapely) opera sobre coordenadas puras. El resultado vuelve como anillos y el cliente lo
   serializa a `d` (`M … L … Z`, huecos como subpaths). Consecuencia documentada: **las booleanas devuelven polilíneas
   aplanadas a la tolerancia pedida** (no preservan Bézier originales).

## Alcance

### A. Servicio de geometría (Python + ASP.NET Core)
- **Python** (`services/python-engine`): ruta nueva `POST /geometry/boolean` (módulo `app/api/routes/geometry.py`, núcleo
  puro en `app/core/geometry_ops.py`, servicio en `app/services/`, modelos en `models/schemas.py`; seguí exactamente el
  patrón de `physical_union`/`check`). Request: `{ operation: "union"|"difference"|"intersection"|"xor"|"normalize",
  subjects: [Geometry...], operands: [Operand...], tolerance }`. `Geometry` = `{ type: "polygon"|"line", coordinates }`
  (polígono = lista de anillos, el primero exterior; usa regla par-impar para construir huecos); `Operand` además admite
  `{ type: "bufferedLine", points, radius }` (pincel de borrador: línea con radio, `cap_style=round`, `join_style=round`,
  resolución de arcos acotada). Semántica: `difference` = cada `subject` − unión de `operands`; `union`/`intersection`/`xor`
  operan sobre subjects (+ operands si hay); `normalize` = `make_valid` + fusión (para trazos auto-intersecados).
  Respuesta: lista **por subject** (para difference/intersection) o única (union/xor) de geometrías resultantes
  (`polygon`/`line`, puede haber 0 o varias piezas por subject), sin NaN, sin polígonos de área < ε, validadas
  (`is_valid` tras `make_valid`), con **orden determinista** y anillos orientados de forma consistente. Límites:
  máx. 500 subjects, 500 000 vértices en total, tolerancia > 0; excesos ⇒ 422 con `code` claro. Errores uniformes
  (mismo esquema que las otras rutas).
- **ASP.NET Core**: `POST /api/v2/geometry/boolean` (`GeometryEndpoints` → `IGeometryService` → `IPythonGeometryClient`,
  mismo patrón que `PhysicalUnion`/`Checking`), validación de entrada (null/vacío, NaN/Infinity, límites, operación
  desconocida) ⇒ 400 con `ApiErrorResponse`; Python caído/timeout ⇒ 503 `python_unavailable` (middleware existente);
  `IUserContext` no es necesario (operación sin estado ni datos del usuario). Contrato versionado (DTOs, sin entidades).
- Tests: `pytest` del núcleo (difference con huecos y múltiples piezas, polígono completamente cubierto ⇒ vacío,
  disjunto ⇒ sin cambio, líneas partidas por el pincel, `normalize` de un "moño", orden determinista, límites, entradas
  degeneradas) y de la ruta; `dotnet test` de endpoint (con Python simulado, como los demás) y del servicio/validación.
  Mantené **Testcontainers/sin InMemory** donde toque DB (acá no hay DB).

### B. Frontend — Draw (`lib/editor/draw.ts` + herramienta)
- Herramienta **Draw** habilitada. Modos: **Polilínea/Pluma** (click agrega punto; Enter o doble click termina abierto;
  click sobre el primer punto o botón "Cerrar" cierra; Backspace quita el último punto; Escape cancela) y **Mano alzada**
  (arrastre; al soltar se simplifica con Ramer–Douglas–Peucker a tolerancia en mm y se suaviza opcionalmente a curvas
  Bézier cúbicas — si lo hacés, que sea determinista y testeado). Preview en vivo mientras se dibuja.
- Validación de "path válido" en `lib/editor/draw.ts` (puro): ≥ 2 puntos distintos (abierto) / ≥ 3 (cerrado), área > ε
  para cerrados, sin NaN, coordenadas dentro de límites razonables. Un cerrado que se **auto-intersecta** se normaliza
  con el servidor (`normalize`) y el resultado (posiblemente varias piezas) reemplaza al trazo; si el servidor no está
  disponible el trazo se **rechaza con mensaje** (no se crea geometría inválida).
- Comando único por trazo (`applyEdit`), capa activa según la decisión 1, respeta lock/visibilidad, unidades en mm en el
  panel (ancho de línea, tolerancia de simplificación), `geometryDirty`.

### C. Frontend — Erase (`lib/editor/erase.ts` + herramienta)
- Herramienta **Erase** habilitada con dos modos **explícitos** (selector visible, el modo activo siempre indicado):
  1. **Objeto**: click (o arrastre) elimina los objetos bajo el cursor (hit-test de S01, solo capas visibles y no
     bloqueadas; las bloqueadas se informan). Un solo comando por gesto.
  2. **Restar geometría**: pincel circular con radio configurable en **mm** (cursor visible al tamaño real según zoom);
     al terminar el arrastre se envía el trazo como `bufferedLine` y `difference` contra los objetos **que intersecan** el
     trazo (bbox + hit): alcance configurable "solo capa activa" (default) / "todas las capas desbloqueadas". Cada objeto
     resultante conserva capa/fill/stroke; un objeto puede quedar **intacto, partido en varias piezas (ids nuevos, el
     original conserva su id solo si queda una pieza), reducido o eliminado por completo**. Líneas abiertas se parten.
     Preview durante el arrastre (solo la huella del pincel; el resultado real al soltar) y estados de carga/error del
     servidor (indicador "calculando…", error recuperable que **no** modifica nada).
- Comando único por gesto; undo/redo exactos (snapshots before/after de S01); capas bloqueadas/ocultas se respetan.

### D. Round-trip, IDs y chequeos
`stroke`/`fill:none` sobreviven a `serialize → parse`. Los objetos generados por Draw/Erase tienen ids UUID únicos y
quedan en la capa correcta (test). La geometría generada es apta para operaciones posteriores (booleanas S08, Laser
Checker S14): test de que un path dibujado cerrado pasa un chequeo de validez (`is_valid` vía servicio o equivalente
puro) y que un erase parcial no deja polígonos inválidos ni NaN.

## Fuera de alcance
Pinceles artísticos, presión, bezier editing (S05), booleanas con UI (S08), persistencia (S13), snapping, formas
primitivas (rect/elipse), texto.

## Tests exigidos
- `lib/editor/draw.ts` y `erase.ts`: validez (abierto/cerrado/degenerado), RDP con valores calculados a mano,
  conversión a `d`, huecos, construcción de la petición `bufferedLine`, aplicación del resultado (0/1/N piezas),
  scoping de capas, ids, zoom (el radio en mm es independiente del zoom).
- Hook/shell: capa activa (existente, ninguna ⇒ crea «Dibujo» atómico, bloqueada/oculta ⇒ rechazo), comando único por
  trazo, undo/redo exactos, preview sin llenar la pila, error del servidor ⇒ sin cambios, cancelación (Escape),
  modos de Erase explícitos. Mocks de `fetch` con `AbortSignal` y que cuenten llamadas.
- Backend/Python como en A.
- Verificación: `npm test`, `npm run build`, `npm run lint`, `dotnet build`, `dotnet test` (suite completa, hay
  backend nuevo) y `pytest` (con `services/python-engine/.venv/Scripts/python.exe -m pytest -q`).

## DoD
Draw crea paths válidos en la capa activa (o una capa nueva explícita) y Erase borra objetos o resta geometría real con
el servidor, de forma reversible, respetando locks, capa activa y unidades en mm.
